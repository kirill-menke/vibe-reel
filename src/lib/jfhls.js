/* Web build: Jellyfin's HLS fMP4 stream, appended to a MediaSource by segfeed.js.
 *
 * The desktop browsers get what the phone gets from Jellyfin — the HLS fMP4
 * remux (video copied, audio copied or converted; tracks.js webProfile()) — but
 * Firefox has no HLS player at all and Chrome's is not one to build on, so the
 * segments go through segfeed.js like a trailer: the playlist is Jellyfin's VOD
 * `main.m3u8` (the whole runtime, complete from the start), the init segment
 * and the segments are fetched one at a time around the playhead.
 *
 * What Jellyfin does (measured on 12.1, 2026-10-07, and docs/ios/MEDIA-TEST.md):
 *   - the fragments carry ABSOLUTE timestamps (-copyts): a request for segment
 *     N far from the running job restarts ffmpeg at N, and its tfdt is that
 *     segment's playlist start (1801.8 s for segment 300 of a 6 s grid) — so a
 *     far seek needs no timestampOffset, it just asks for the segment there;
 *   - the first segment's AAC track starts at -1024 samples (a negative tfdt
 *     written as a huge unsigned one): Chrome 154 and Firefox 156 both read it
 *     as signed and buffer from 0;
 *   - a Dolby Vision copy may be tagged dvh1 (with dvvC) — Firefox rejects such
 *     an init segment ("Failed to open media") and desktop Chrome has no DV, so
 *     unless the browser takes the DV codec string the sample entry is renamed
 *     hvc1 (dvhe → hev1): profile 8 then plays as its HDR10/HLG/SDR base layer
 *     (decoders skip the RPU NAL units). Profile 5 never gets here without DV
 *     support: webProfile() only declares DOVI where dvh1.05 is playable.
 *   - after such a restart the playlist and the fragments can disagree: the
 *     playlist cuts on a global grid of keyframes (k × 6 s), ffmpeg cuts 6 s
 *     after wherever the job started. Restarted at a 4.004 s playlist segment
 *     (a long-GOP 4K DV file), every later fragment sat 2.0 s after its
 *     playlist slot. So each fetched segment's real start (its video tfdt) is
 *     written back into the playlist, shifting the segments after it the same
 *     way — segfeed.js decides what is buffered and what to fetch next from
 *     those times. And a seek onto a restarted job's first segment lands
 *     ~0.5 s before its first audio frame; segfeed.js steps over that (web only);
 *   - a segment request is held until ffmpeg has written it (seconds after a
 *     restart, longer for a 4K transcode), hence the long per-try deadline.
 *
 * Failures: a segment that fails on the network, times out, or answers 5xx /
 * 404 / 429 is retried after SEG_RETRY_MS; then the feed fails (onFail → the
 * player's error card, whose Retry starts a fresh PlaybackInfo). A far seek
 * aborts a segment still in flight for the old position. stop() ends the feed
 * and stops the server job (DELETE /Videos/ActiveEncodings), as the phone's
 * offline copies do — the player's Stopped report ends it too, this is the belt.
 *
 * Web-only: player.svelte.js imports it inside `__PHONE__ && __WEB__`. */
import { api, qs } from './api.js';
import { createSegFeeder, parsePlaylist, feedCanPlay } from './segfeed.js';

const SEG_RETRY_MS = [1000, 3000, 8000];
const SEG_TIMEOUT_MS = 20000;   // a try; under the player's 60 s "never started" card
const INIT_TIMEOUT_MS = 30000;

/* Sample entry fourccs in an init segment, in track order: 'hvc1', 'dvh1', 'avc1', 'mp4a'… */
/** @param {ArrayBuffer} buf @returns {string[]} */
export function sampleEntries(buf) {
  const b = new Uint8Array(buf);
  const out = [];
  for (let i = 4; i + 20 <= b.length; i++) {
    if (b[i] === 0x73 && b[i + 1] === 0x74 && b[i + 2] === 0x73 && b[i + 3] === 0x64) {   // 'stsd'
      out.push(String.fromCharCode(b[i + 16], b[i + 17], b[i + 18], b[i + 19]));
    }
  }
  return out;
}

/* A copy of the init segment with every Dolby Vision HEVC sample entry renamed
 * to its plain HEVC twin (dvh1 → hvc1, dvhe → hev1). */
/** @param {ArrayBuffer} buf @returns {ArrayBuffer} */
export function retagDv(buf) {
  const out = buf.slice(0);
  const b = new Uint8Array(out);
  for (let i = 4; i + 20 <= b.length; i++) {
    if (b[i] !== 0x73 || b[i + 1] !== 0x74 || b[i + 2] !== 0x73 || b[i + 3] !== 0x64) continue;
    const e = String.fromCharCode(b[i + 16], b[i + 17], b[i + 18], b[i + 19]);
    const to = e === 'dvh1' ? 'hvc1' : e === 'dvhe' ? 'hev1' : null;
    if (to) for (let k = 0; k < 4; k++) b[i + 16 + k] = to.charCodeAt(k);
  }
  return out;
}

/* The child boxes of [start, end): [type, body start, box end]. A malformed size ends the walk. */
/** @param {DataView} dv @param {number} start @param {number} end @returns {Array<[string, number, number]>} */
function kids(dv, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
    let body = p + 8;
    if (size === 1 && p + 16 <= end) {
      size = Number(dv.getBigUint64(p + 8));
      body = p + 16;
    } else if (size === 0) size = end - p;
    if (size < 8 || p + size > end) break;
    out.push(/** @type {[string, number, number]} */ ([type, body, p + size]));
    p += size;
  }
  return out;
}

/** @param {DataView} dv @param {number} start @param {number} end @param {string} type */
const child = (dv, start, end, type) => kids(dv, start, end).find((k) => k[0] === type);

/* The tracks of an init segment: track_ID, timescale and whether it is video
 * (moov/trak: tkhd, mdia/mdhd, mdia/hdlr). */
/** @param {ArrayBuffer} buf @returns {Array<{ id: number, timescale: number, video: boolean }>} */
export function initTracks(buf) {
  const dv = new DataView(buf);
  const moov = child(dv, 0, dv.byteLength, 'moov');
  if (!moov) return [];
  const out = [];
  for (const [type, s, e] of kids(dv, moov[1], moov[2])) {
    if (type !== 'trak') continue;
    const tkhd = child(dv, s, e, 'tkhd');
    const mdia = child(dv, s, e, 'mdia');
    const mdhd = mdia && child(dv, mdia[1], mdia[2], 'mdhd');
    const hdlr = mdia && child(dv, mdia[1], mdia[2], 'hdlr');
    if (!tkhd || !mdhd) continue;
    const v1 = (/** @type {number} */ b) => (dv.getUint8(b) === 1 ? 16 : 8);
    out.push({
      id: dv.getUint32(tkhd[1] + 4 + v1(tkhd[1])),
      timescale: dv.getUint32(mdhd[1] + 4 + v1(mdhd[1])),
      video: !!hdlr && String.fromCharCode(dv.getUint8(hdlr[1] + 8), dv.getUint8(hdlr[1] + 9), dv.getUint8(hdlr[1] + 10), dv.getUint8(hdlr[1] + 11)) === 'vide'
    });
  }
  return out;
}

/* Where a media segment really starts, in seconds: the video track's tfdt
 * (moof/traf), read as signed (Jellyfin's first AAC fragment is negative).
 * null when it can't be read. */
/** @param {ArrayBuffer} buf @param {Array<{ id: number, timescale: number, video: boolean }>} tracks @returns {number | null} */
export function fragStart(buf, tracks) {
  try {
    const dv = new DataView(buf);
    const moof = child(dv, 0, dv.byteLength, 'moof');
    if (!moof) return null;
    for (const [type, s, e] of kids(dv, moof[1], moof[2])) {
      if (type !== 'traf') continue;
      const tfhd = child(dv, s, e, 'tfhd');
      const tfdt = child(dv, s, e, 'tfdt');
      if (!tfhd || !tfdt) continue;
      const tr = tracks.find((t) => t.id === dv.getUint32(tfhd[1] + 4));
      if (!tr || !tr.video || !tr.timescale) continue;
      const at = dv.getUint8(tfdt[1]) === 1 ? Number(dv.getBigInt64(tfdt[1] + 4)) : dv.getUint32(tfdt[1] + 4);
      return at / tr.timescale;
    }
  } catch {}
  return null;
}

/* Codec strings for a sample entry when the master playlist names none. */
/** @type {Record<string, string>} */
const ENTRY_CODEC = {
  avc1: 'avc1.640028', avc3: 'avc1.640028', hvc1: 'hvc1.2.4.L153.B0', hev1: 'hvc1.2.4.L153.B0',
  dvh1: 'hvc1.2.4.L153.B0', dvhe: 'hvc1.2.4.L153.B0', av01: 'av01.0.08M.10', vp09: 'vp09.00.10.08',
  mp4a: 'mp4a.40.2', 'ac-3': 'ac-3', 'ec-3': 'ec-3', Opus: 'opus', fLaC: 'flac'
};

/* The variants of a master playlist: each #EXT-X-STREAM-INF line and its URI. */
/** @param {string} master @returns {Array<{ inf: string, uri: string }>} */
export function variants(master) {
  const lines = master.split('\n').map((l) => l.trim());
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    if (uri) out.push({ inf: lines[i], uri });
  }
  return out;
}

/* Which variant to play. Jellyfin 12.1 lists the stream copy first — for an
 * HDR source even when the profile claimed no HDR (VIDEO-RANGE=PQ, reason
 * VideoRangeTypeNotSupported) — followed by tone-mapped SDR re-encodes (HEVC,
 * H.264). The copy, unless it is HDR on an SDR display: then the SDR H.264
 * one (h264_qsv is the NAS's cheapest encode), else any SDR one this browser
 * plays. */
/** @param {Array<{ inf: string, uri: string }>} vars @param {boolean} hdr the display is HDR @returns {number} */
export function chooseVariant(vars, hdr) {
  const range = (/** @type {number} */ i) => (vars[i].inf.match(/VIDEO-RANGE=([A-Z0-9]+)/) || [])[1] || 'SDR';
  if (hdr || !vars.length || range(0) === 'SDR') return 0;
  const sdr = vars.map((v, i) => i).filter((i) => range(i) === 'SDR' && feedCanPlay((vars[i].inf.match(/CODECS="([^"]+)"/) || [])[1] || ''));
  return sdr.find((i) => /CODECS="avc1/.test(vars[i].inf)) ?? sdr[0] ?? 0;
}

/* A variant (its STREAM-INF line) → what the SourceBuffer is opened with, and
 * whether the init segment must be retagged. A DV copy is offered as DV only
 * where the browser takes the SUPPLEMENTAL-CODECS one. */
/** @param {string} inf @param {string[]} entries @returns {{ codecs: string, retag: boolean }} */
export function pickCodecs(inf, entries) {
  const named = (inf.match(/CODECS="([^"]+)"/) || [])[1] || entries.map((e) => ENTRY_CODEC[e]).filter(Boolean).join(',');
  const supp = ((inf.match(/SUPPLEMENTAL-CODECS="([^"]+)"/) || [])[1] || '').split('/')[0];
  const [v = '', ...rest] = named.split(',');
  const audio = rest.length ? ',' + rest.join(',') : '';
  if (entries[0] !== 'dvh1' && entries[0] !== 'dvhe') return { codecs: named, retag: false };
  const dv = (/^dv/.test(v) ? v : supp || 'dvh1.08.06').replace(/^dvhe/, 'dvh1') + audio;
  if (feedCanPlay(dv)) return { codecs: dv, retag: false };
  return { codecs: (/^dv/.test(v) ? 'hvc1.2.4.L153.B0' : v) + audio, retag: true };
}

/* `opts.url`: Jellyfin's main.m3u8, absolute (cfg.server + TranscodingUrl with
 * master → main). Returns { url, managed, stop } like the other feeds. */
/** @param {VR.JfFeedOptions} opts @returns {VR.Feed} */
export function createJfFeed(opts) {
  const { url, position, jump, onFail, media } = opts;
  const retryMs = opts.retryMs || SEG_RETRY_MS;
  const q = new URL(url).searchParams;
  const deviceId = q.get('DeviceId') || q.get('deviceId') || '';
  const playSessionId = q.get('PlaySessionId') || '';
  let dead = false;
  /** @type {VR.HlsPlaylist} */
  let pl = { segs: [], complete: true };
  /** @type {ArrayBuffer | null} */
  let init = null;
  /** @type {Array<{ id: number, timescale: number, video: boolean }>} */
  let tracks = [];
  /** @type {AbortController | null} */
  let segAc = null;
  /** @type {VR.HlsSegment | null} */
  let segNow = null;
  let left = false;   // segAc was aborted because the playhead left that segment
  /** @type {(() => void) | null} */
  let wake = null;
  const sleep = (/** @type {number} */ ms) =>
    /** @type {Promise<void>} */ (new Promise((res) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        wake = null;
        res();
      }
      wake = done;
    }));

  /** @param {string} msg @param {number} [status] @returns {VR.ApiError} */
  const fail = (msg, status) => {
    const e = /** @type {VR.ApiError} */ (new Error(msg));
    if (status) e.status = status;
    return e;
  };

  /* One GET with a deadline; the body as text or bytes. */
  /** @param {string} href @param {number} ms @param {AbortController} ac @param {boolean} [asText] */
  const get = async (href, ms, ac, asText) => {
    const t = setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch(href, { signal: ac.signal, cache: 'no-store' });
      if (!r.ok) throw fail('HTTP ' + r.status, r.status);
      return asText ? r.text() : r.arrayBuffer();
    } finally {
      clearTimeout(t);
    }
  };

  /* With retries: network trouble, a deadline, 5xx, 404 (the job went away —
   * asking again restarts it) and 429 are worth another try; 401/403 are not. */
  /** @param {string} href @param {string} what @param {number} ms @param {VR.HlsSegment | null} seg */
  const fetchBytes = async (href, what, ms, seg) => {
    for (let i = 0; ; i++) {
      if (dead) return null;
      const ac = new AbortController();
      segAc = ac;
      segNow = seg;
      left = false;
      try {
        return /** @type {ArrayBuffer} */ (await get(href, ms, ac));
      } catch (e) {
        if (dead || (left && ac === segAc)) return null;   // stopped, or a seek made it moot
        const st = /** @type {VR.ApiError} */ (e).status || 0;
        const again = !st || st >= 500 || st === 404 || st === 429;
        if (!again || i >= retryMs.length) {
          throw fail('Jellyfin stopped sending the video (' + what + ': ' + (st ? 'HTTP ' + st : 'no answer') + ')', st);
        }
      } finally {
        segAc = null;
        segNow = null;
      }
      await sleep(retryMs[i]);
    }
  };

  /* A far seek: drop the segment still on its way for the old position —
   * Jellyfin restarts its job wherever the next request points anyway. */
  const onSeeking = () => {
    if (!segAc || !segNow) return;
    const t = position();
    if (t < segNow.start - 30 || t > segNow.end + 30) {
      left = true;
      segAc.abort();
    }
  };
  if (media) media.addEventListener('seeking', onSeeking);

  const feeder = createSegFeeder({
    position,
    jump,
    media,
    bitrate: opts.bitrate,
    pollMs: 200,
    onFail,   // segfeed.js reports nothing once stopped
    async prepare() {
      const ac = new AbortController();
      segAc = ac;
      const masterUrl = url.replace('/main.m3u8', '/master.m3u8');
      const [master, first] = await Promise.all([get(masterUrl, INIT_TIMEOUT_MS, ac, true).catch(() => ''), get(url, INIT_TIMEOUT_MS, ac, true)]);
      const vars = variants(/** @type {string} */ (master));
      const v = chooseVariant(vars, !!opts.hdr);
      const main = v ? new URL(vars[v].uri, masterUrl).href : url;
      const text = v ? await get(main, INIT_TIMEOUT_MS, ac, true) : first;
      const p = parsePlaylist(/** @type {string} */ (text));
      if (!p.segs.length || !p.init) throw fail('Jellyfin’s playlist is empty');
      const abs = (/** @type {string} */ n) => new URL(n, main).href;
      pl = { segs: p.segs.map((s) => ({ ...s, name: abs(s.name) })), complete: true };
      const buf = await fetchBytes(abs(p.init), 'header', INIT_TIMEOUT_MS, null);
      if (!buf) return { codecs: '', duration: 0 };   // stopped meanwhile: the feeder is dead too
      const pick = pickCodecs(vars.length ? vars[v].inf : '', sampleEntries(buf));
      init = pick.retag ? retagDv(buf) : buf;
      tracks = initTracks(buf);
      return { codecs: pick.codecs, duration: pl.segs[pl.segs.length - 1].end };
    },
    playlist: async () => pl,
    fetchInit: async () => init,
    async fetchSeg(seg) {
      const buf = await fetchBytes(seg.name, 'segment ' + pl.segs.indexOf(seg), SEG_TIMEOUT_MS, seg);
      if (buf) realign(seg, fragStart(buf, tracks));
      return buf;
    }
  });

  /* The segment really starts at `at`: move it there, and every segment after
   * it by as much (the job goes on cutting on its own grid); the one before
   * now ends where it starts. Each later fetch corrects itself again. */
  /** @param {VR.HlsSegment} seg @param {number | null} at */
  function realign(seg, at) {
    if (at == null || Math.abs(at - seg.start) < 0.1) return;
    const d = at - seg.start;
    const i = pl.segs.indexOf(seg);
    for (let j = i; j < pl.segs.length; j++) {
      pl.segs[j].start += d;
      pl.segs[j].end += d;
    }
    if (i > 0 && pl.segs[i - 1].start < seg.start) pl.segs[i - 1].end = seg.start;
  }

  return {
    url: feeder.url,
    managed: feeder.managed,
    stop() {
      if (dead) return;
      dead = true;
      if (media) media.removeEventListener('seeking', onSeeking);
      if (segAc) segAc.abort();
      if (wake) wake();
      feeder.stop();
      if (playSessionId) {
        api('/Videos/ActiveEncodings' + qs({ deviceId, playSessionId }), { method: 'DELETE' }).catch(() => {});
      }
    }
  };
}
