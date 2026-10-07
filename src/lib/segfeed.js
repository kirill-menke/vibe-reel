/* iPhone: fMP4 segments fed into a (Managed)MediaSource by our own code — the
 * trailer approach (trailerstream.js) made generic, for the two phone streams
 * Safari's HLS player can't be handed:
 *
 *   - a download that is still coming in (livefeed.js): reel-api remuxes the
 *     growing file into an HLS *event* playlist, which Safari would treat as
 *     live (start near the end, no duration); here the duration comes from
 *     ffprobe, playback starts where asked, and a seek past what exists simply
 *     waits for it;
 *   - an offline copy (offline.js): the segments live in Cache Storage, and
 *     nothing on the network is involved at all.
 *
 * The source hands over three async hooks — prepare() → { codecs, duration },
 * playlist() → { segs: [{ start, end, name }], complete }, fetchInit() and
 * fetchSeg(seg) → ArrayBuffer, or null when that segment isn't there (yet) —
 * and this keeps a window appended ahead of the playhead wherever it goes
 * (sized by bytes, see BUDGET_BYTES), drops what is more than BEHIND_S behind
 * it, steps over sub-second holes
 * (the pipeline stalls at any gap), and ends the stream once the playlist is
 * complete and everything to the end is in. On iOS 17.1+ there is only
 * ManagedMediaSource (the page must turn remote playback off — startPlayback
 * does, from `managed`); it says when it wants data and may evict on its own,
 * which the "fetch whatever isn't buffered" loop already covers.
 *
 * Phone-only: nothing on the TV imports this. */


function mediaSourceClass() {
  if (!window.MediaSource && window.ManagedMediaSource) return window.ManagedMediaSource;
  return window.MediaSource || window.ManagedMediaSource;
}

export function feedSupported() {
  return typeof window !== 'undefined' && !!(window.MediaSource || window.ManagedMediaSource);
}

/* Is this codec string playable here? (ManagedMediaSource on the iPhone.) */
/** @param {string} codecs RFC 6381 @returns {boolean} */
export function feedCanPlay(codecs) {
  const MS = mediaSourceClass();
  return !!MS && MS.isTypeSupported('video/mp4; codecs="' + codecs + '"');
}

/* The window ahead of the playhead is a byte budget, not a fixed number of
 * seconds: 45 s of a 4K remux (60–80 Mbit/s) is 340–450 MB, past what WebKit
 * lets a SourceBuffer hold — every append then hit QuotaExceededError and the
 * feeder retried twice a second while holding a 30–60 MB segment in JS. The
 * stream's rate is measured from the segments appended (bytes per media
 * second, decaying), seeded by the source's own `bitrate` when it knows it. */
const BUDGET_BYTES = 96 * 1024 * 1024;
const MIN_AHEAD_S = 10;
const REFILL_AT = 2 / 3;          // refill once less than this share of the window is left
const MAX_NAP_MS = 5000;
const PLAYLIST_IDLE_MS = 10000;   // a growing playlist, polled while the playhead is far from its end
const CUT_MARGIN_S = 0.25;        // the behind-trim cut stays this far below a segment's playlist start

/* opts: { prepare, playlist, fetchInit, fetchSeg, position, jump, onFail, media,
 *         bitrate, preloadS = 6, aheadS = 45, behindS = 5, pollMs = 1000 }
 * `media`: the <video>, for waking up on 'seeking'/'waiting' instead of polling.
 * `bitrate` (bit/s): what the window is sized by until segments have been measured.
 * Returns { url, managed, stop }. */
/** @param {VR.SegFeederOptions} opts @returns {VR.Feed} */
export function createSegFeeder(opts) {
  const { prepare, playlist, fetchInit, fetchSeg, position, jump, onFail, media } = opts;
  const PRELOAD_S = opts.preloadS ?? 6;
  const MAX_AHEAD_S = opts.aheadS ?? 45;
  const BEHIND_S = opts.behindS ?? 5;
  const POLL_MS = opts.pollMs ?? 1000;
  const MS = mediaSourceClass();
  const ms = new MS();
  const managed = typeof window.ManagedMediaSource === 'function' && ms instanceof window.ManagedMediaSource;
  const url = URL.createObjectURL(ms);
  let dead = false;
  const here = () => (position ? position() : 0);

  /* The loop sleeps until the buffer needs more; a seek, a stall, or MMS's
   * 'startstreaming' cut the sleep short. (It used to wake every 100–330 ms
   * for a whole film to find there was nothing to do.) */
  /** @type {(() => void) | null} */
  let wake = null;
  const poke = () => wake && wake();
  const nap = (/** @type {number} */ d) =>
    /** @type {Promise<void>} */ (new Promise((res) => {
      const t = setTimeout(done, d);
      function done() {
        clearTimeout(t);
        if (wake === done) wake = null;
        res();
      }
      wake = done;
    }));
  if (media) {
    media.addEventListener('seeking', poke);
    media.addEventListener('waiting', poke);
  }
  ms.addEventListener('startstreaming', poke);

  /* bytes and media seconds appended, both decaying (~the last 5 segments) */
  let rateBytes = 0;
  let rateSecs = 0;
  let quotaCap = Infinity;   // seconds ahead that fit, learnt from a QuotaExceededError
  const bps = () => (rateSecs > 0 ? (rateBytes * 8) / rateSecs : opts.bitrate || 0);
  const aheadS = () => {
    const b = bps();
    const fit = b ? (BUDGET_BYTES * 8) / b : MAX_AHEAD_S;
    return Math.min(MAX_AHEAD_S, quotaCap, Math.max(Math.min(MIN_AHEAD_S, MAX_AHEAD_S), fit));
  };

  async function run() {
    const { codecs, duration } = await prepare();
    if (dead) return;
    const mime = 'video/mp4; codecs="' + codecs + '"';
    if (!MS.isTypeSupported(mime)) {
      const e = /** @type {VR.ApiError} */ (new Error('this iPhone can’t play ' + codecs));
      e.code = 'unsupported';
      throw e;
    }
    if (duration > 0) ms.duration = duration;
    const sb = ms.addSourceBuffer(mime);

    const op = (/** @type {() => void} */ fn) =>
      /** @type {Promise<void>} */ (new Promise((res, rej) => {
        const done = () => {
          sb.removeEventListener('error', fail);
          res();
        };
        const fail = () => {
          sb.removeEventListener('updateend', done);
          rej(new Error('the media pipeline rejected a segment'));
        };
        sb.addEventListener('updateend', done, { once: true });
        sb.addEventListener('error', fail, { once: true });
        fn();
      }));
    const bufferedEnd = (/** @type {number} */ t) => {
      const b = sb.buffered;
      for (let i = 0; i < b.length; i++) if (t >= b.start(i) - 0.05 && t <= b.end(i) + 0.05) return b.end(i);
      return null;
    };
    /** @type {Set<string>} */
    const inBuf = new Set();
    /* Drops what lies more than `behind` s behind the playhead and, with
     * `far`, whatever is buffered past the window ahead (left there by a seek
     * back). True when something was removed. */
    /** @param {number} behind @param {boolean} far @returns {Promise<boolean>} */
    const evict = async (behind, far) => {
      const b = sb.buffered;
      if (!b.length) return false;
      const t = here();
      let freed = false;
      // Cut on the start of the segment the cut falls in: a cut inside one
      // drops only up to its next keyframe, and with a keyframe before the
      // segment's midpoint the kept tail counts as "in" (covered()) while the
      // [segment start, keyframe) hole is never refetched — a dead end after a
      // seek back (V-F12). Segments start on keyframes (ffmpeg -c copy), so a
      // segment now either stays whole or goes whole. A playlist start is a sum
      // of rounded #EXTINF values, and the real keyframe can sit a little before
      // it: a cut right on it would remove that keyframe and its GOP, so it stays
      // CUT_MARGIN_S below. Removing more of the previous segment is harmless as
      // long as its leftover can't count as in: ≤ ¼ of it keeps the leftover clear
      // of its midpoint (covered()'s test, ±0.05 s) for segments ≥ 0.2 s.
      const raw = t - behind;
      const i = pl.segs.findIndex((s) => s.start <= raw && raw < s.end);
      const seg = pl.segs[i];
      const prev = pl.segs[i - 1];
      const cut = !seg ? raw : prev ? seg.start - Math.min(CUT_MARGIN_S, (seg.start - prev.start) / 4) : seg.start;
      if (cut > 1 && b.start(0) < cut) {
        await op(() => sb.remove(0, cut));
        freed = true;
      }
      if (far) {
        const keep = Math.max(bufferedEnd(t) ?? t, t + aheadS());
        const last = sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : 0;
        if (last > keep + 1) {
          await op(() => sb.remove(keep, last));
          freed = true;
        }
      }
      return freed;
    };
    /* Full: free what has been watched (up to the start of the segment
     * holding the last second, so the playing one stays whole — V-F13) and
     * what a seek left far ahead, and retry at once. When that frees nothing, the
     * window itself is too big for this stream — shrink it to what is
     * buffered now and retry once the playhead has eaten into it (not on a
     * 500 ms timer: the old loop, measured at 4K, retried indefinitely). */
    const append = async (/** @type {ArrayBuffer} */ buf) => {
      for (;;) {
        try {
          await op(() => sb.appendBuffer(buf));
          return;
        } catch (e) {
          if (/** @type {DOMException} */ (e).name !== 'QuotaExceededError' || dead) throw e;
          if (await evict(1, true)) continue;
          const t = here();
          const have = (bufferedEnd(t) ?? t) - t;
          quotaCap = Math.max(PRELOAD_S, have * 0.8);
          await nap(Math.min(MAX_NAP_MS, Math.max(1000, (have - quotaCap * REFILL_AT) * 1000)));
          if (dead) return;
        }
      }
    };

    // 1. the init segment, then PRELOAD_S seconds from where playback starts
    let pl = await playlist();
    for (;;) {
      if (dead) return;
      const t = here();
      const have = pl.segs.filter((s) => s.end > t).reduce((a, s) => a + (s.end - Math.max(s.start, t)), 0);
      if (pl.complete || (pl.segs.length && have >= PRELOAD_S)) break;
      await nap(POLL_MS);
      if (dead) return;   // stop() wakes the nap: no request after the player closed
      pl = await playlist();
    }
    const init = await fetchInit();
    if (dead) return;
    if (!init) throw new Error('the stream has no header');
    await append(init);

    // 2. keep the window ahead of the playhead filled, wherever it goes
    let lastPoll = Date.now();
    let filling = true;
    for (;;) {
      if (dead) return;
      const ahead = aheadS();
      // A growing playlist is only re-read when the playhead nears its known
      // end (the window wants segments it doesn't list yet), else every ~10 s.
      if (!pl.complete) {
        const t = here();
        const known = pl.segs.length ? pl.segs[pl.segs.length - 1].end : 0;
        const near = known < (bufferedEnd(t) ?? t) + ahead;
        if (Date.now() - lastPoll >= (near ? POLL_MS : PLAYLIST_IDLE_MS)) {
          pl = await playlist();
          lastPoll = Date.now();
          if (dead) return;
        }
      }
      const t = here();
      if (jump && sb.buffered.length) {
        const b = sb.buffered;
        for (let i = 0; i < b.length - 1; i++) {
          if (t >= b.end(i) - 0.25 && t < b.start(i + 1) && b.start(i + 1) - b.end(i) < 1) jump(b.start(i + 1) + 0.05);
        }
      }
      const inside = bufferedEnd(t);
      const have = (inside ?? t) - t;
      // fill up to the window, then let it drain to REFILL_AT before the next
      // round: fetches come in bursts instead of one segment per few seconds
      if (inside == null || have < ahead * REFILL_AT) filling = true;
      else if (have >= ahead) filling = false;
      const covered = (/** @type {VR.HlsSegment} */ seg) => bufferedEnd((seg.start + seg.end) / 2) != null && inBuf.has(seg.name);
      const next = filling ? pl.segs.find((seg) => seg.end > t && !covered(seg)) : null;
      if (managed && next && !/** @type {ManagedMediaSource} */ (ms).streaming && inside != null && have >= PRELOAD_S) {
        await nap(MAX_NAP_MS);   // 'startstreaming' (or a seek) wakes it
        continue;
      }
      if (next) {
        const b = await fetchSeg(next);
        if (dead) return;
        if (!b) {
          await nap(POLL_MS);   // not there (any more): the source is on it
          continue;
        }
        await evict(BEHIND_S, false);
        await append(b);
        if (dead) return;
        inBuf.add(next.name);
        rateBytes = rateBytes * 0.8 + b.byteLength;
        rateSecs = rateSecs * 0.8 + Math.max(0.1, next.end - next.start);
        continue;
      }
      const last = pl.segs[pl.segs.length - 1];
      const allIn = last && covered(last) && !pl.segs.some((seg) => seg.end > t && !covered(seg));
      if (pl.complete && allIn && ms.readyState === 'open' && !sb.updating) ms.endOfStream();
      // Sleep until the buffer drains to the refill mark (media time ≈ wall
      // time while playing; paused, the 5 s cap just re-checks), or — a
      // growing playlist with nothing new yet — until the next poll.
      const until = filling ? (pl.complete ? MAX_NAP_MS : POLL_MS) : (have - ahead * REFILL_AT) * 1000;
      await nap(Math.max(250, Math.min(MAX_NAP_MS, until)));
    }
  }

  ms.addEventListener(
    'sourceopen',
    () => {
      run().catch((e) => {
        if (!dead && e.name !== 'AbortError') onFail && onFail(e);
      });
    },
    { once: true }
  );

  return {
    url,
    managed,
    stop() {
      dead = true;
      if (media) {
        media.removeEventListener('seeking', poke);
        media.removeEventListener('waiting', poke);
      }
      ms.removeEventListener('startstreaming', poke);
      poke();
      URL.revokeObjectURL(url);
    }
  };
}

/* An HLS media playlist → segments on the media timeline (cumulative #EXTINF),
 * plus the init segment's URI and whether it is complete. */
/** @param {string} text @returns {VR.HlsPlaylist} */
export function parsePlaylist(text) {
  /** @type {VR.HlsSegment[]} */
  const segs = [];
  let t = 0;
  /** @type {string | null} */
  let init = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    const m = l.match(/^#EXT-X-MAP:URI="([^"]+)"/);
    if (m) init = m[1];
    const x = l.match(/^#EXTINF:([\d.]+)/);
    if (x) {
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].startsWith('#'))) j++;
      if (j < lines.length) {
        const d = parseFloat(x[1]);
        segs.push({ start: t, end: t + d, name: lines[j].trim() });
        t += d;
        i = j;
      }
    }
  }
  return { segs, init, complete: text.includes('#EXT-X-ENDLIST') };
}
