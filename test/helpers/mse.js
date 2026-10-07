/* A fake MediaSource / SourceBuffer for the MSE feeders (segfeed.js,
 * trailerstream.js, livefeed.js through segfeed). Nothing is decoded: a
 * "segment" is an ArrayBuffer that carries the media-time range it covers, and
 * the SourceBuffer's `buffered` is the union of what was appended minus what
 * was removed.
 *
 *   const mse = installMSE();                     // window.MediaSource (TV, desktop)
 *   const mse = installMSE({ managed: 'only' });  // iPhone: only window.ManagedMediaSource
 *   const mse = installMSE({ managed: true });    // both classes exist
 *
 *   mse.segment(0, 6, 4096)       // ArrayBuffer of 4096 bytes covering 0–6 s
 *   mse.initSegment(800)          // ArrayBuffer that adds no range (the fMP4 header)
 *   mse.last                      // the newest FakeMediaSource (mse.instances: all)
 *   ms.sb                         // its first SourceBuffer (ms.sourceBuffers: all)
 *   sb.appends                    // [{ start, end, bytes } | { init: true, bytes }]
 *   sb.removes                    // [[start, end], …]
 *   sb.ranges()                   // [[start, end], …] — the buffered ranges as an array
 *   sb.bytes                      // bytes currently held
 *   sb.failNext()                 // the next append fires 'error' (+ 'updateend')
 *   sb.quotaNext()                // the next append throws QuotaExceededError
 *   ms.setStreaming(false|true)   // ManagedMediaSource: endstreaming / startstreaming
 *   sb.evict(a, b)                // ManagedMediaSource-style eviction by the UA (no event)
 *   mse.revoked                   // blob URLs passed to URL.revokeObjectURL
 *
 * Options of installMSE():
 *   managed      false (default) | true | 'only'
 *   supported    (mime) => bool for isTypeSupported (default: every video/mp4 and audio/mp4)
 *   quotaBytes   per-SourceBuffer byte budget; an append past it throws
 *                QuotaExceededError synchronously, as Chromium/WebKit do (default Infinity)
 *   autoOpen     true (default): the MediaSource opens ('sourceopen', readyState
 *                'open') in a microtask after URL.createObjectURL(ms) — standing in
 *                for "the <video> was given that URL". false: call ms.open() yourself.
 *   appendMs     0 (default): an append completes in a microtask; > 0: after that
 *                many ms on setTimeout (so a fake clock controls it)
 *   map          (buf) => [start, end] | null — decode a segment's range yourself
 *                (default: the encoding segment()/initSegment() write)
 *   keyframes    (start, end) => [t, …] — the random access points (video
 *                keyframes) inside an appended segment, read at append time
 *                (default: one, at the segment's start — what ffmpeg's HLS muxer
 *                writes when the source GOP is at least a segment long). Use
 *                keyframesEvery(s) for a denser GOP. Can be changed later through
 *                mse.options.keyframes.
 *
 * remove() and evict() follow the MSE "coded frame removal" algorithm: the frames
 * in [start, end) go, and so does everything after them up to the next random
 * access point, because it can no longer be decoded. A cut in the middle of a
 * segment with one keyframe therefore drops the rest of that segment.
 *
 * Events follow the spec order: appendBuffer/remove set `updating`, then
 * 'updatestart' → 'update' → 'updateend' asynchronously; a failed append fires
 * 'error' → 'updateend'. appendBuffer/remove while updating, addSourceBuffer or
 * endOfStream or a duration change while not 'open' throw InvalidStateError. An
 * append on an 'ended' source re-opens it (readyState 'open' + 'sourceopen').
 *
 * Everything goes through vi.stubGlobal / vi.spyOn, so the config's
 * unstubGlobals + restoreMocks undo it after every test. */
import { vi } from 'vitest';
import { timeRanges } from './video.js';

const MAGIC = 0x5e6f;   // marks a fake segment's header
const EPS = 1e-6;

/** An ArrayBuffer of `bytes` length that covers [start, end] of media time. */
export function segment(start, end, bytes = 1024) {
  const buf = new ArrayBuffer(Math.max(24, bytes));
  const dv = new DataView(buf);
  dv.setUint16(0, MAGIC);
  dv.setFloat64(8, start);
  dv.setFloat64(16, end);
  return buf;
}

/** An fMP4 header stand-in: appended fine, adds no buffered range. */
export function initSegment(bytes = 512) {
  const buf = new ArrayBuffer(Math.max(24, bytes));
  const dv = new DataView(buf);
  dv.setUint16(0, MAGIC);
  dv.setFloat64(8, NaN);
  dv.setFloat64(16, NaN);
  return buf;
}

/** The [start, end] a segment()-made buffer covers, null for an init segment. */
export function decodeSegment(buf) {
  const ab = buf instanceof ArrayBuffer ? buf : buf.buffer;
  if (!ab || ab.byteLength < 24) throw new Error('fake MSE: not a segment()/initSegment() buffer — pass `map` to installMSE');
  const dv = new DataView(ab, buf.byteOffset || 0);
  if (dv.getUint16(0) !== MAGIC) throw new Error('fake MSE: not a segment()/initSegment() buffer — pass `map` to installMSE');
  const s = dv.getFloat64(8);
  const e = dv.getFloat64(16);
  return Number.isNaN(s) ? null : [s, e];
}

/** keyframes option: a random access point every `step` s from each segment's start */
export const keyframesEvery = (step) => (start, end) => {
  const out = [];
  for (let k = start; k < end - EPS; k += step) out.push(k);
  return out;
};

const domErr = (name, msg) => new DOMException(msg || name, name);

/* the union of [start, end] pieces as sorted, merged ranges */
function merge(pieces) {
  const list = pieces.map((p) => [p.start, p.end]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of list) {
    const top = out[out.length - 1];
    if (top && s <= top[1] + EPS) top[1] = Math.max(top[1], e);
    else out.push([s, e]);
  }
  return out;
}

export function installMSE(opts = {}) {
  const o = {
    managed: false,
    supported: (mime) => /^(video|audio)\/mp4/.test(String(mime)),
    quotaBytes: Infinity,
    autoOpen: true,
    appendMs: 0,
    map: decodeSegment,
    keyframes: (start) => [start],
    ...opts
  };
  const state = { instances: [], urls: new Map(), revoked: [], created: [] };
  let urlN = 0;

  const later = (fn) => (o.appendMs > 0 ? setTimeout(fn, o.appendMs) : queueMicrotask(fn));

  class FakeSourceBuffer extends EventTarget {
    constructor(ms, mime) {
      super();
      this.ms = ms;
      this.mime = mime;
      this.updating = false;
      this.mode = 'segments';
      this.timestampOffset = 0;
      this.pieces = [];   // [{ start, end, bytes }]
      this.appends = [];
      this.removes = [];
      this.calls = [];
      this._fail = false;
      this._quota = false;
    }
    get buffered() {
      return timeRanges(this.ranges());
    }
    ranges() {
      return merge(this.pieces);
    }
    get bytes() {
      return this.pieces.reduce((a, p) => a + p.bytes, 0);
    }
    failNext() {
      this._fail = true;
    }
    quotaNext() {
      this._quota = true;
    }
    _fire(type) {
      this.dispatchEvent(new Event(type));
    }
    appendBuffer(buf) {
      if (this.updating) throw domErr('InvalidStateError', 'appendBuffer while updating');
      if (!this.ms.sourceBuffers.includes(this)) throw domErr('InvalidStateError', 'SourceBuffer was removed');
      const bytes = buf.byteLength;
      if (this._quota || this.bytes + bytes > o.quotaBytes) {
        this._quota = false;
        this.calls.push(['quota', bytes]);
        throw domErr('QuotaExceededError', 'The SourceBuffer is full');
      }
      if (this.ms.readyState === 'ended') this.ms._setOpen();
      const range = o.map(buf);
      const rec = range ? { start: range[0], end: range[1], bytes } : { init: true, bytes };
      this.appends.push(rec);
      this.calls.push(['append', rec]);
      this.updating = true;
      const fail = this._fail;
      this._fail = false;
      queueMicrotask(() => this._fire('updatestart'));
      later(() => {
        this.updating = false;
        if (fail) {
          this.calls.push(['error', rec]);
          this._fire('error');
        } else {
          if (range) {
            const keys = (o.keyframes(range[0], range[1]) || []).filter((k) => k >= range[0] - EPS && k < range[1] - EPS);
            this.pieces.push({ start: range[0], end: range[1], bytes, keys: keys.length ? keys : [range[0]] });
          }
          this._fire('update');
        }
        this._fire('updateend');
      });
    }
    remove(start, end) {
      if (this.updating) throw domErr('InvalidStateError', 'remove while updating');
      if (this.ms.readyState === 'ended') this.ms._setOpen();
      this.removes.push([start, end]);
      this.calls.push(['remove', start, end]);
      this.updating = true;
      queueMicrotask(() => this._fire('updatestart'));
      later(() => {
        this._cut(start, end);
        this.updating = false;
        this._fire('update');
        this._fire('updateend');
      });
    }
    /** the UA dropping [a, b] by itself (ManagedMediaSource) — synchronous, no event */
    evict(start, end) {
      this.calls.push(['evict', start, end]);
      this._cut(start, end);
    }
    /* Coded frame removal: [a, b) goes, plus everything after b up to the next
     * random access point. A piece starts on a keyframe (every appended
     * segment does), so the next piece is never affected. */
    _cut(a, b) {
      const out = [];
      for (const p of this.pieces) {
        if (p.end <= a + EPS || p.start >= b - EPS) {
          out.push(p);
          continue;
        }
        const len = p.end - p.start || 1;
        const share = (s, e) => Math.round((p.bytes * (e - s)) / len);
        if (p.start < a - EPS) out.push({ start: p.start, end: a, bytes: share(p.start, a), keys: p.keys.filter((k) => k < a - EPS) });
        if (p.end > b + EPS) {
          const rap = p.keys.find((k) => k >= b - EPS);
          if (rap != null) out.push({ start: rap, end: p.end, bytes: share(rap, p.end), keys: p.keys.filter((k) => k >= rap) });
        }
      }
      this.pieces = out;
    }
    abort() {
      this.calls.push(['abort']);
      this.updating = false;
    }
  }

  class FakeMediaSource extends EventTarget {
    constructor() {
      super();
      this.readyState = 'closed';
      this.sourceBuffers = [];
      this.calls = [];
      this._duration = NaN;
      this.url = null;
      this.ended = 0;
      state.instances.push(this);
    }
    static isTypeSupported(mime) {
      state.created.push(['isTypeSupported', mime]);
      return !!o.supported(mime);
    }
    get sb() {
      return this.sourceBuffers[0];
    }
    get duration() {
      return this._duration;
    }
    set duration(d) {
      if (this.readyState !== 'open') throw domErr('InvalidStateError', 'duration set while ' + this.readyState);
      if (this.sourceBuffers.some((b) => b.updating)) throw domErr('InvalidStateError', 'duration set while updating');
      this._duration = d;
      this.calls.push(['duration', d]);
    }
    get activeSourceBuffers() {
      return this.sourceBuffers;
    }
    addSourceBuffer(mime) {
      if (this.readyState !== 'open') throw domErr('InvalidStateError', 'addSourceBuffer while ' + this.readyState);
      if (!o.supported(mime)) throw domErr('NotSupportedError', mime);
      const sb = new FakeSourceBuffer(this, mime);
      this.sourceBuffers.push(sb);
      this.calls.push(['addSourceBuffer', mime]);
      return sb;
    }
    removeSourceBuffer(sb) {
      this.sourceBuffers = this.sourceBuffers.filter((x) => x !== sb);
      this.calls.push(['removeSourceBuffer']);
    }
    endOfStream(err) {
      if (this.readyState !== 'open') throw domErr('InvalidStateError', 'endOfStream while ' + this.readyState);
      if (this.sourceBuffers.some((b) => b.updating)) throw domErr('InvalidStateError', 'endOfStream while updating');
      this.readyState = 'ended';
      this.ended++;
      this.calls.push(['endOfStream', err]);
      this.dispatchEvent(new Event('sourceended'));
    }
    /** what attaching to a <video> does: readyState 'open' + 'sourceopen' */
    open() {
      if (this.readyState !== 'closed') return;
      this._setOpen();
    }
    _setOpen() {
      this.readyState = 'open';
      this.calls.push(['open']);
      this.dispatchEvent(new Event('sourceopen'));
    }
    /** detaching from the <video>: readyState 'closed' + 'sourceclose' */
    close() {
      this.readyState = 'closed';
      this.calls.push(['close']);
      this.dispatchEvent(new Event('sourceclose'));
    }
  }

  class FakeManagedMediaSource extends FakeMediaSource {
    constructor() {
      super();
      this.streaming = true;
    }
    static isTypeSupported(mime) {
      return FakeMediaSource.isTypeSupported(mime);
    }
    /** the UA wants data (true → 'startstreaming') or has enough (false → 'endstreaming') */
    setStreaming(on) {
      this.streaming = !!on;
      this.calls.push(['streaming', this.streaming]);
      this.dispatchEvent(new Event(on ? 'startstreaming' : 'endstreaming'));
    }
  }

  if (o.managed === 'only') {
    vi.stubGlobal('MediaSource', undefined);
    vi.stubGlobal('ManagedMediaSource', FakeManagedMediaSource);
  } else {
    vi.stubGlobal('MediaSource', FakeMediaSource);
    vi.stubGlobal('ManagedMediaSource', o.managed ? FakeManagedMediaSource : undefined);
  }

  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(function (obj) {
    if (obj instanceof FakeMediaSource) {
      const url = 'blob:fake-mse/' + ++urlN;
      obj.url = url;
      state.urls.set(url, obj);
      if (o.autoOpen) queueMicrotask(() => obj.open());
      return url;
    }
    return realCreate.call(URL, obj);
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(function (url) {
    if (state.urls.has(url)) {
      state.revoked.push(url);
      return;
    }
    return realRevoke.call(URL, url);
  });

  return {
    MediaSource: FakeMediaSource,
    ManagedMediaSource: FakeManagedMediaSource,
    SourceBuffer: FakeSourceBuffer,
    segment,
    initSegment,
    get instances() {
      return state.instances;
    },
    get last() {
      return state.instances[state.instances.length - 1];
    },
    get revoked() {
      return state.revoked;
    },
    /** isTypeSupported() queries so far: [['isTypeSupported', mime], …] */
    get typeQueries() {
      return state.created.filter((c) => c[0] === 'isTypeSupported').map((c) => c[1]);
    },
    byUrl: (url) => state.urls.get(url),
    options: o
  };
}
