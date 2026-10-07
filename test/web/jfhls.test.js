/* jfhls.js — the web build's Jellyfin HLS → MediaSource feed.
 *
 * What it relies on, measured against Jellyfin 12.1 (2026-10-07, module comment):
 * fragments carry absolute timestamps; a segment far from the running job
 * restarts it there; the playlist and a restarted job's cuts can disagree by
 * seconds (each fetched fragment's tfdt is written back into the playlist);
 * the master lists the HDR copy first even for an SDR-only profile (the SDR
 * H.264 re-encode is picked on an SDR display); Firefox refuses a dvh1 sample
 * entry (retagged hvc1 unless the browser takes DV). A segment that fails on
 * the network, times out, or answers 5xx/404/429 is retried, 401/403 is not; a
 * far seek drops the segment in flight; stop() stops the server job
 * (DELETE /Videos/ActiveEncodings). Web project only. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { freshImport } from '../helpers/modules.js';
import { installMSE } from '../helpers/mse.js';
import { mockFetch } from '../helpers/fetch.js';
import { useClock } from '../helpers/time.js';

/* ---------- MP4 boxes ---------- */
const cat = (...parts) => {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const u32 = (v) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0);
  return b;
};
const i64 = (v) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(v));
  return b;
};
const f64 = (v) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v);
  return b;
};
const ascii = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const box = (type, ...parts) => {
  const body = cat(...parts);
  return cat(u32(8 + body.length), ascii(type), body);
};
const zeros = (n) => new Uint8Array(n);
const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

/* tkhd/mdhd: version 0 (32-bit times) or 1 (64-bit) */
const tkhd = (id, v1) => box('tkhd', new Uint8Array([v1 ? 1 : 0, 0, 0, 3]), zeros(v1 ? 16 : 8), u32(id), zeros(60));
const mdhd = (ts, v1) => box('mdhd', new Uint8Array([v1 ? 1 : 0, 0, 0, 0]), zeros(v1 ? 16 : 8), u32(ts), zeros(8));
const hdlr = (h) => box('hdlr', zeros(4), zeros(4), ascii(h), zeros(12));
const stsd = (entry) => box('stsd', zeros(4), u32(1), box(entry, zeros(16)));
const trak = ({ id, ts, handler, entry, v1 = false }) => box('trak', tkhd(id, v1), box('mdia', mdhd(ts, v1), hdlr(handler)), stsd(entry));
function initBuf({ video = 'avc1', audio = 'mp4a', v1 = false } = {}) {
  return ab(cat(box('ftyp', ascii('iso5')), box('moov', trak({ id: 1, ts: 1000, handler: 'vide', entry: video, v1 }), trak({ id: 2, ts: 48000, handler: 'soun', entry: audio, v1 }))));
}
/* a media segment: moof/traf per track (video tfdt = start), then 'xrng' = the
 * range the fake SourceBuffer buffers (default [start, start + dur]) */
function frag(start, dur, { buffered, audioFirst = false, v0 = false } = {}) {
  const tfdt = (t, ts) => (v0 ? box('tfdt', zeros(4), u32(Math.round(t * ts))) : box('tfdt', new Uint8Array([1, 0, 0, 0]), i64(Math.round(t * ts))));
  const traf = (id, t, ts) => box('traf', box('tfhd', zeros(4), u32(id)), tfdt(t, ts));
  const trafs = [traf(1, start, 1000), traf(2, start - 0.021, 48000)];
  if (audioFirst) trafs.reverse();
  const [a, b] = buffered || [start, start + dur];
  return ab(cat(box('moof', ...trafs), box('xrng', f64(a), f64(b)), box('mdat', zeros(16))));
}
function rangeOf(buf) {
  const u8 = new Uint8Array(buf);
  for (let i = 0; i + 20 <= u8.length; i++) {
    if (u8[i] === 0x78 && u8[i + 1] === 0x72 && u8[i + 2] === 0x6e && u8[i + 3] === 0x67) {
      const dv = new DataView(buf, i + 4, 16);
      return [dv.getFloat64(0), dv.getFloat64(8)];
    }
  }
  return null;
}

/* ---------- playlists ---------- */
const Q = '?DeviceId=dev-web&MediaSourceId=m1&PlaySessionId=ps-1&ApiKey=k';
const BASE = 'http://jf.test/videos/abc/';
const MAIN = BASE + 'main.m3u8' + Q;
const COPY_SDR = '#EXT-X-STREAM-INF:BANDWIDTH=9000000,VIDEO-RANGE=SDR,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080\nmain.m3u8' + Q + '\n';
function mediaPlaylist(n, len = 6, durs) {
  let out = '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-TARGETDURATION:7\n#EXT-X-MAP:URI="hls1/main/-1.mp4' + Q + '"\n';
  for (let i = 0; i < n; i++) out += '#EXTINF:' + (durs ? durs[i] : len).toFixed(3) + ', nodesc\nhls1/main/' + i + '.mp4' + Q + '\n';
  return out + '#EXT-X-ENDLIST\n';
}

let jf, mse, net, clock, pos, media, onFail, jump, feed, segFetched, segHandler;

async function setup(o = {}) {
  ({ jf } = await freshImport({ modules: { jf: 'src/lib/jfhls.js' } }));
  clock = useClock();
  mse = installMSE({ map: rangeOf, supported: o.supported || ((m) => /avc1|mp4a|hvc1/.test(m)) });
  net = mockFetch();
  pos = o.pos ?? 0;
  media = new EventTarget();
  onFail = vi.fn();
  jump = vi.fn();
  segFetched = [];
  const n = o.segs ?? 20;
  const len = o.len ?? 6;
  const starts = [];
  for (let i = 0, t = 0; i < n; i++) {
    starts.push(t);
    t += o.durs ? o.durs[i] : len;
  }
  net.on('GET', (r) => r.path === '/videos/abc/master.m3u8', o.master !== undefined ? o.master : () => net.text('#EXTM3U\n' + COPY_SDR));
  net.on('GET', (r) => r.path === '/videos/abc/main.m3u8', o.main !== undefined ? o.main : () => net.text(mediaPlaylist(n, len, o.durs)));
  net.on('GET', (r) => r.path === '/videos/abc/hls1/main/-1.mp4', o.init !== undefined ? o.init : () => initBuf(o.initOpts));
  segHandler = o.seg || ((i) => frag(starts[i], (o.durs ? o.durs[i] : len)));
  net.on('GET', (r) => /^\/videos\/abc\/hls1\/main\/\d+\.mp4$/.test(r.path), (r) => {
    const i = Number(r.path.match(/(\d+)\.mp4$/)[1]);
    segFetched.push(i);
    return segHandler(i, r);
  });
  net.on('DELETE', '/Videos/ActiveEncodings', null);
  feed = jf.createJfFeed({ url: o.url || MAIN, position: () => pos, jump, onFail, media, hdr: !!o.hdr, ...(o.retryMs === null ? {} : { retryMs: o.retryMs || [100, 200, 300] }), ...(o.noMedia ? { media: null } : {}) });
  return feed;
}

async function run(ms = 0) {
  await clock.tick(ms);
  for (let i = 0; i < 8; i++) await clock.tick(0);
}
const sb = () => mse.last.sb;
const mediaStarts = () => sb().appends.filter((a) => !a.init).map((a) => Math.round(a.start * 1000) / 1000);
const deletes = () => net.callsTo('/Videos/ActiveEncodings', 'DELETE');

afterEach(() => {
  feed?.stop();
  feed = null;
});

describe('MP4 helpers', () => {
  beforeEach(async () => {
    ({ jf } = await freshImport({ modules: { jf: 'src/lib/jfhls.js' } }));
  });

  it('sampleEntries: the stsd entry fourccs in track order', () => {
    expect(jf.sampleEntries(initBuf({ video: 'dvh1', audio: 'ec-3' }))).toEqual(['dvh1', 'ec-3']);
    expect(jf.sampleEntries(new ArrayBuffer(10))).toEqual([]);
  });

  it('retagDv: dvh1 → hvc1, dvhe → hev1, in a copy; nothing else changes', () => {
    const src = initBuf({ video: 'dvh1', audio: 'mp4a' });
    const out = jf.retagDv(src);
    expect(jf.sampleEntries(out)).toEqual(['hvc1', 'mp4a']);
    expect(jf.sampleEntries(src)).toEqual(['dvh1', 'mp4a']);
    expect(jf.sampleEntries(jf.retagDv(initBuf({ video: 'dvhe' })))).toEqual(['hev1', 'mp4a']);
    expect(jf.sampleEntries(jf.retagDv(initBuf({ video: 'avc1' })))).toEqual(['avc1', 'mp4a']);
    expect(out.byteLength).toBe(src.byteLength);
  });

  it('initTracks: id, timescale and kind of every trak (version 0 and 1 headers)', () => {
    const want = [{ id: 1, timescale: 1000, video: true }, { id: 2, timescale: 48000, video: false }];
    expect(jf.initTracks(initBuf())).toEqual(want);
    expect(jf.initTracks(initBuf({ v1: true }))).toEqual(want);
    expect(jf.initTracks(ab(box('ftyp', zeros(4))))).toEqual([]);
    // a trak without mdhd is skipped, one without hdlr is not video
    const odd = ab(box('moov', box('trak', tkhd(7)), box('trak', tkhd(8), box('mdia', mdhd(90000))), box('udta', zeros(4))));
    expect(jf.initTracks(odd)).toEqual([{ id: 8, timescale: 90000, video: false }]);
  });

  it('fragStart: the video traf’s tfdt in seconds — signed (64-bit), or 32-bit', () => {
    const tracks = jf.initTracks(initBuf());
    expect(jf.fragStart(frag(1801.8, 6), tracks)).toBeCloseTo(1801.8, 6);
    expect(jf.fragStart(frag(42, 6, { v0: true }), tracks)).toBeCloseTo(42, 6);
    expect(jf.fragStart(frag(30, 6, { audioFirst: true }), tracks)).toBeCloseTo(30, 6);
    // Jellyfin's first AAC fragment: -1024 samples, written as a huge unsigned value
    const neg = ab(box('moof', box('traf', box('tfhd', zeros(4), u32(1)), box('tfdt', new Uint8Array([1, 0, 0, 0]), i64(-16)))));
    expect(jf.fragStart(neg, tracks)).toBeCloseTo(-0.016, 6);
  });

  it('fragStart: null without a moof, a readable video traf, or a known track; never throws', () => {
    const tracks = jf.initTracks(initBuf());
    expect(jf.fragStart(initBuf(), tracks)).toBeNull();
    expect(jf.fragStart(frag(5, 6), [])).toBeNull();
    expect(jf.fragStart(frag(5, 6), [{ id: 1, timescale: 0, video: true }])).toBeNull();
    const noTfdt = ab(box('moof', box('mfhd', zeros(8)), box('traf', box('tfhd', zeros(4), u32(1)))));
    expect(jf.fragStart(noTfdt, tracks)).toBeNull();
    // a tfdt cut short: the read throws inside, the answer is null
    const cut = ab(box('moof', box('traf', box('tfhd', zeros(4), u32(1)), box('tfdt', new Uint8Array([1, 0, 0, 0]), zeros(2)))));
    expect(jf.fragStart(cut, tracks)).toBeNull();
  });

  it('box walking: a 64-bit size, a size of 0 (to the end) and a malformed size', () => {
    const tracks = jf.initTracks(initBuf());
    const inner = box('traf', box('tfhd', zeros(4), u32(1)), box('tfdt', zeros(4), u32(7000)));
    const big = cat(u32(1), ascii('moof'), i64(16 + inner.length), inner);
    expect(jf.fragStart(ab(big), tracks)).toBeCloseTo(7, 6);
    const toEnd = cat(u32(0), ascii('moof'), inner);
    expect(jf.fragStart(ab(toEnd), tracks)).toBeCloseTo(7, 6);
    const bad = cat(u32(4), ascii('moof'), inner);
    expect(jf.fragStart(ab(bad), tracks)).toBeNull();
    const over = cat(u32(9999), ascii('moof'), inner);
    expect(jf.fragStart(ab(over), tracks)).toBeNull();
  });
});

describe('master playlist: variants, choice, codecs', () => {
  beforeEach(async () => {
    ({ jf } = await freshImport({ modules: { jf: 'src/lib/jfhls.js' } }));
  });
  const PQ = '#EXT-X-STREAM-INF:BANDWIDTH=26225310,VIDEO-RANGE=PQ,CODECS="hvc1.2.4.L150.B0,mp4a.40.2",SUPPLEMENTAL-CODECS="dvh1.08.06/db1p"\nmain.m3u8?v=copy';
  const SDR_HEVC = '#EXT-X-STREAM-INF:BANDWIDTH=26225310,VIDEO-RANGE=SDR,CODECS="hvc1.2.4.L150.B0,mp4a.40.2"\nmain.m3u8?v=hevc';
  const SDR_AVC = '#EXT-X-STREAM-INF:BANDWIDTH=26225310,VIDEO-RANGE=SDR,CODECS="avc1.640033,mp4a.40.2"\n\n# a comment\nmain.m3u8?v=avc';
  const TRICK = '#EXT-X-IMAGE-STREAM-INF:BANDWIDTH=6489,RESOLUTION=320x180,CODECS="jpeg",URI="Trickplay/320/tiles.m3u8"';

  it('variants(): every STREAM-INF with its URI; image streams and URI-less entries are not variants', () => {
    const v = jf.variants(['#EXTM3U', PQ, SDR_HEVC, SDR_AVC, TRICK, '#EXT-X-STREAM-INF:BANDWIDTH=1'].join('\n'));
    expect(v.map((x) => x.uri)).toEqual(['main.m3u8?v=copy', 'main.m3u8?v=hevc', 'main.m3u8?v=avc']);
    expect(v[0].inf).toMatch(/^#EXT-X-STREAM-INF:BANDWIDTH=26225310,VIDEO-RANGE=PQ/);
    expect(jf.variants('')).toEqual([]);
  });

  it('chooseVariant(): the copy — unless it is HDR on an SDR display: then SDR H.264, else any playable SDR one', () => {
    installMSE({ supported: (m) => /avc1|hvc1/.test(m) });
    const v = jf.variants([PQ, SDR_HEVC, SDR_AVC].join('\n'));
    expect(jf.chooseVariant(v, true)).toBe(0);
    expect(jf.chooseVariant(v, false)).toBe(2);
    expect(jf.chooseVariant(jf.variants([PQ, SDR_HEVC].join('\n')), false)).toBe(1);
    expect(jf.chooseVariant(jf.variants([SDR_HEVC, SDR_AVC].join('\n')), false)).toBe(0);
    expect(jf.chooseVariant([], false)).toBe(0);
    // no VIDEO-RANGE: SDR
    expect(jf.chooseVariant(jf.variants('#EXT-X-STREAM-INF:CODECS="avc1.640028"\nmain.m3u8'), false)).toBe(0);
  });

  it('chooseVariant(): no SDR variant this browser plays → the copy after all', () => {
    installMSE({ supported: (m) => /hvc1/.test(m) && !/avc1/.test(m) && false });
    expect(jf.chooseVariant(jf.variants([PQ, SDR_HEVC, SDR_AVC].join('\n')), false)).toBe(0);
    installMSE({ supported: () => true });
    expect(jf.chooseVariant(jf.variants([PQ, '#EXT-X-STREAM-INF:VIDEO-RANGE=SDR\nmain.m3u8?v=nocodecs'].join('\n')), false)).toBe(1);
  });

  it('pickCodecs(): the variant’s CODECS; without one, from the sample entries', () => {
    installMSE();
    expect(jf.pickCodecs(SDR_AVC.split('\n')[0], ['avc1', 'mp4a'])).toEqual({ codecs: 'avc1.640033,mp4a.40.2', retag: false });
    expect(jf.pickCodecs('', ['hvc1', 'Opus', 'wxyz'])).toEqual({ codecs: 'hvc1.2.4.L153.B0,opus', retag: false });
    expect(jf.pickCodecs('#EXT-X-STREAM-INF:BANDWIDTH=1', ['av01', 'fLaC'])).toEqual({ codecs: 'av01.0.08M.10,flac', retag: false });
  });

  it('pickCodecs(): a dvh1 copy plays as DV where the browser takes it, else retagged with the HDR10 base codec', () => {
    const inf = PQ.split('\n')[0];
    installMSE({ supported: (m) => /dvh1\.08\.06,mp4a/.test(m) });
    expect(jf.pickCodecs(inf, ['dvh1', 'mp4a'])).toEqual({ codecs: 'dvh1.08.06,mp4a.40.2', retag: false });
    installMSE({ supported: (m) => !/dvh1/.test(m) });
    expect(jf.pickCodecs(inf, ['dvh1', 'mp4a'])).toEqual({ codecs: 'hvc1.2.4.L150.B0,mp4a.40.2', retag: true });
    expect(jf.pickCodecs(inf, ['dvhe', 'mp4a'])).toEqual({ codecs: 'hvc1.2.4.L150.B0,mp4a.40.2', retag: true });
    // DV named in CODECS itself (a DV 5-style variant), and no SUPPLEMENTAL-CODECS
    expect(jf.pickCodecs('#EXT-X-STREAM-INF:CODECS="dvhe.05.06,ec-3"', ['dvh1', 'ec-3'])).toEqual({ codecs: 'hvc1.2.4.L153.B0,ec-3', retag: true });
    installMSE({ supported: (m) => /dvh1\.05\.06/.test(m) });
    expect(jf.pickCodecs('#EXT-X-STREAM-INF:CODECS="dvhe.05.06"', ['dvh1'])).toEqual({ codecs: 'dvh1.05.06', retag: false });
    installMSE({ supported: (m) => /dvh1\.08\.06"/.test(m) });
    expect(jf.pickCodecs('#EXT-X-STREAM-INF:CODECS="hvc1.2.4.L150.B0"', ['dvh1'])).toEqual({ codecs: 'dvh1.08.06', retag: false });
  });
});

describe('createJfFeed: start', () => {
  it('master + main, the init segment, then segments from where playback starts — absolute URLs, no-store', async () => {
    await setup({ pos: 0 });
    expect(feed.url).toBe(mse.last.url);
    expect(feed.managed).toBe(false);
    await run(10);
    expect(onFail).not.toHaveBeenCalled();
    expect(sb().mime).toBe('video/mp4; codecs="avc1.640028,mp4a.40.2"');
    expect(mse.last.duration).toBe(120);
    expect(sb().appends[0].init).toBe(true);
    expect(mediaStarts().slice(0, 3)).toEqual([0, 6, 12]);
    const seg = net.calls.find((c) => c.path.endsWith('/0.mp4'));
    expect(seg.url).toBe(BASE + 'hls1/main/0.mp4' + Q);
    expect(seg.init.cache).toBe('no-store');
    expect(net.unmatched).toEqual([]);
  });

  it('a resume point: the first segment fetched is the one holding it (Jellyfin starts its job there)', async () => {
    await setup({ pos: 100 });
    await run(10);
    expect(segFetched[0]).toBe(16);
  });

  it('an HDR copy on an SDR display: the SDR H.264 variant’s playlist instead', async () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:VIDEO-RANGE=PQ,CODECS="hvc1.2.4.L150.B0,mp4a.40.2"\nmain.m3u8' + Q + '\n' +
      '#EXT-X-STREAM-INF:VIDEO-RANGE=SDR,CODECS="avc1.640033,mp4a.40.2"\nmain.m3u8?VideoCodec=h264&DeviceId=dev-web&PlaySessionId=ps-1\n';
    await setup({ master: () => net.text(master) });
    await run(10);
    const mains = net.calls.filter((c) => c.path === '/videos/abc/main.m3u8').map((c) => c.query);
    expect(mains).toEqual([Q, '?VideoCodec=h264&DeviceId=dev-web&PlaySessionId=ps-1']);
    expect(sb().mime).toBe('video/mp4; codecs="avc1.640033,mp4a.40.2"');
    expect(onFail).not.toHaveBeenCalled();
  });

  it('…but an HDR display keeps the copy', async () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:VIDEO-RANGE=PQ,CODECS="hvc1.2.4.L150.B0,mp4a.40.2"\nmain.m3u8' + Q + '\n' +
      '#EXT-X-STREAM-INF:VIDEO-RANGE=SDR,CODECS="avc1.640033,mp4a.40.2"\nmain.m3u8?VideoCodec=h264\n';
    await setup({ master: () => net.text(master), hdr: true });
    await run(10);
    expect(net.callsTo('/videos/abc/main.m3u8')).toHaveLength(1);
    expect(sb().mime).toBe('video/mp4; codecs="hvc1.2.4.L150.B0,mp4a.40.2"');
  });

  it('a dvh1 init segment is retagged hvc1 when the browser has no Dolby Vision', async () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:VIDEO-RANGE=PQ,CODECS="hvc1.2.4.L150.B0,mp4a.40.2",SUPPLEMENTAL-CODECS="dvh1.08.06/db1p"\nmain.m3u8' + Q + '\n';
    const seen = [];
    await setup({ master: () => net.text(master), hdr: true, initOpts: { video: 'dvh1' }, supported: (m) => !/dvh1/.test(m) && /hvc1|mp4a/.test(m) });
    const map = mse.options.map;
    mse.options.map = (buf) => {
      seen.push(...(rangeOf(buf) ? [] : [new Uint8Array(buf)]));
      return map(buf);
    };
    await run(10);
    expect(sb().mime).toBe('video/mp4; codecs="hvc1.2.4.L150.B0,mp4a.40.2"');
    expect(jf.sampleEntries(seen[0].buffer)).toEqual(['hvc1', 'mp4a']);
  });

  it('no master playlist: codecs from the init segment’s entries', async () => {
    await setup({ master: () => net.status(404) });
    await run(10);
    expect(sb().mime).toBe('video/mp4; codecs="avc1.640028,mp4a.40.2"');
    expect(onFail).not.toHaveBeenCalled();
  });

  it('a playlist that fails or is empty fails the feed', async () => {
    await setup({ main: () => net.status(500) });
    await run(10);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0][0].message).toBe('HTTP 500');
    feed.stop();
    await setup({ main: () => net.text('#EXTM3U\n#EXT-X-ENDLIST\n') });
    await run(10);
    expect(onFail.mock.calls[0][0].message).toBe('Jellyfin’s playlist is empty');
  });

  it('a codec this browser can’t play: onFail with code unsupported, worded for a browser', async () => {
    await setup({ supported: () => false });
    await run(10);
    const e = onFail.mock.calls[0][0];
    expect(e.code).toBe('unsupported');
    expect(e.message).toBe('this browser can’t play avc1.640028,mp4a.40.2');
  });

  it('stopped while the header is on its way: nothing more is fetched, no failure', async () => {
    await setup({ init: () => net.hang() });
    await run(10);
    feed.stop();
    await run(1000);
    expect(segFetched).toEqual([]);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('stopped while the playlists load: no failure', async () => {
    await setup({ main: () => net.hang() });
    await run(10);
    feed.stop();
    await run(100);
    expect(onFail).not.toHaveBeenCalled();
  });
});

describe('createJfFeed: retries', () => {
  it('5xx, a network error, 404 and 429 are retried after retryMs; the segment then lands', async () => {
    const fails = { 1: [503], 2: ['net'], 3: [404, 429] };
    await setup({
      seg: (i) => {
        const f = fails[i] && fails[i].shift();
        if (f === 'net') return net.networkError();
        if (f) return net.status(f);
        return frag(i * 6, 6);
      }
    });
    await run(10);
    await run(100);
    await run(200);
    await run(300);
    expect(onFail).not.toHaveBeenCalled();
    expect(segFetched.slice(0, 7)).toEqual([0, 1, 1, 2, 2, 3, 3]);
    expect(mediaStarts().slice(0, 5)).toEqual([0, 6, 12, 18, 24]);
  });

  it('by default the retries wait 1 s, 3 s, 8 s', async () => {
    let n = 0;
    await setup({ retryMs: null, seg: (i) => (i === 1 && n++ < 3 ? net.status(500) : frag(i * 6, 6)) });
    await run(10);
    expect(segFetched.filter((i) => i === 1)).toHaveLength(1);
    await run(1000);
    expect(segFetched.filter((i) => i === 1)).toHaveLength(2);
    await run(2900);
    expect(segFetched.filter((i) => i === 1)).toHaveLength(2);
    await run(200);
    expect(segFetched.filter((i) => i === 1)).toHaveLength(3);
    await run(8000);
    expect(segFetched.filter((i) => i === 1)).toHaveLength(4);
    expect(onFail).not.toHaveBeenCalled();
    expect(mediaStarts()).toContain(6);
  });

  it('401/403 are final: the feed fails at once, naming the segment', async () => {
    await setup({ seg: (i) => (i === 2 ? net.status(401) : frag(i * 6, 6)) });
    await run(10);
    const e = onFail.mock.calls[0][0];
    expect(e.message).toBe('Jellyfin stopped sending the video (segment 2: HTTP 401)');
    expect(e.status).toBe(401);
    expect(segFetched.filter((i) => i === 2)).toHaveLength(1);
  });

  it('after the last retry the feed fails', async () => {
    await setup({ seg: (i) => (i === 1 ? net.status(500) : frag(i * 6, 6)) });
    await run(10);
    await run(700);
    expect(segFetched.filter((i) => i === 1)).toHaveLength(4);
    expect(onFail.mock.calls[0][0].message).toBe('Jellyfin stopped sending the video (segment 1: HTTP 500)');
  });

  it('a segment that never answers times out after 20 s a try ("no answer")', async () => {
    await setup({ seg: (i) => (i === 0 ? net.hang() : frag(i * 6, 6)), retryMs: [100] });
    await run(10);
    await run(19990);
    expect(segFetched).toEqual([0]);
    await run(20);
    await run(100);
    expect(segFetched).toEqual([0, 0]);
    await run(20000);
    expect(onFail.mock.calls[0][0].message).toBe('Jellyfin stopped sending the video (segment 0: no answer)');
  });

  it('a header that keeps failing fails the feed as "header"', async () => {
    await setup({ init: () => net.status(502) });
    await run(10);
    await run(700);
    expect(onFail.mock.calls[0][0].message).toBe('Jellyfin stopped sending the video (header: HTTP 502)');
  });

  it('stop() during a retry wait: no further request', async () => {
    await setup({ seg: (i) => (i === 1 ? net.status(500) : frag(i * 6, 6)) });
    await run(10);
    const n = segFetched.length;
    feed.stop();
    await run(1000);
    expect(segFetched.length).toBe(n);
    expect(onFail).not.toHaveBeenCalled();
  });
});

describe('createJfFeed: seeking', () => {
  it('a far seek drops the segment in flight and asks for the one at the new position', async () => {
    let hold = true;
    await setup({ seg: (i) => (i === 3 && hold ? net.hang() : frag(i * 6, 6)) });
    await run(10);
    expect(segFetched).toEqual([0, 1, 2, 3]);
    hold = false;
    pos = 70;
    media.dispatchEvent(new Event('seeking'));
    await run(300);
    expect(onFail).not.toHaveBeenCalled();
    expect(segFetched[4]).toBe(11);
    expect(mediaStarts()).toContain(66);
  });

  it('a near seek lets it finish', async () => {
    await setup({ seg: (i) => (i === 3 ? new Promise((res) => setTimeout(() => res(frag(18, 6)), 500)) : frag(i * 6, 6)) });
    await run(10);
    pos = 10;
    media.dispatchEvent(new Event('seeking'));
    await run(600);
    expect(segFetched.filter((i) => i === 3)).toHaveLength(1);
    expect(mediaStarts()).toContain(18);
  });

  it('a seeking event with nothing in flight changes nothing', async () => {
    await setup({ segs: 2 });
    await run(10);
    media.dispatchEvent(new Event('seeking'));
    await run(10);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('a restarted job cutting off the playlist grid: later segments move to where they really are', async () => {
    // the playlist says 4 s for segment 3 (a long-GOP file's keyframe grid);
    // the job, restarted there, cuts 6 s: segment 4 starts 2 s after its slot
    const durs = [6, 6, 6, 4, 6, 6, 6, 6, 6, 6];
    const real = (i) => (i <= 3 ? [0, 6, 12, 18][i] : 24 + (i - 4) * 6);
    await setup({ segs: 10, durs, pos: 18, seg: (i) => frag(real(i), 6) });
    await run(10);
    expect(onFail).not.toHaveBeenCalled();
    expect(mediaStarts().slice(0, 3)).toEqual([18, 24, 30]);
    // nothing is fetched twice: the corrected playlist matches what is buffered
    await run(2000);
    expect(new Set(segFetched).size).toBe(segFetched.length);
  });

  it('…and a far seek into the shifted part asks for the segment that really holds it', async () => {
    const durs = Array.from({ length: 40 }, (_, i) => (i === 3 ? 4 : 6));
    const real = (i) => (i <= 3 ? i * 6 : 24 + (i - 4) * 6);
    let gate = true;
    await setup({ segs: 40, durs, pos: 18, seg: (i) => (i >= 5 && gate ? net.hang() : frag(real(i), 6)) });
    await run(10);
    expect(segFetched).toEqual([3, 4, 5]);
    gate = false;
    segFetched.length = 0;
    // 197 s: the playlist slot is segment 33 (196–202), but after the +2 s shift
    // segment 32 really holds it (192–198)
    pos = 197;
    media.dispatchEvent(new Event('seeking'));
    await run(300);
    expect(segFetched[0]).toBe(32);
    expect(mediaStarts()).toContain(192);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('the first segment can move too (nothing before it to stretch)', async () => {
    await setup({ segs: 3, seg: (i) => frag(i * 6 + 0.5, 6) });
    await run(10);
    expect(mediaStarts()).toEqual([0.5, 6.5, 12.5]);
    expect(new Set(segFetched).size).toBe(segFetched.length);
  });

  it('a fragment whose start can’t be read leaves the playlist as it is', async () => {
    await setup({ segs: 3, seg: (i) => ab(cat(box('xrng', f64(i * 6), f64(i * 6 + 6)))) });
    await run(10);
    expect(mediaStarts()).toEqual([0, 6, 12]);
  });
});

describe('createJfFeed: stop()', () => {
  it('stops the server job once (DELETE /Videos/ActiveEncodings, deviceId + playSessionId from the URL)', async () => {
    await setup();
    await run(10);
    feed.stop();
    feed.stop();
    await run(10);
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0].query).toBe('?deviceId=dev-web&playSessionId=ps-1');
    expect(deletes()[0].headers.Authorization).toMatch(/Token="tok-u1"/);
    expect(mse.revoked).toContain(feed.url);
  });

  it('a failing DELETE is shrugged off', async () => {
    await setup();
    net.on('DELETE', '/Videos/ActiveEncodings', net.status(500));
    feed.stop();
    await run(10);
    expect(deletes()).toHaveLength(1);
  });

  it('a lower-case deviceId works; no PlaySessionId → nothing to stop', async () => {
    await setup({ url: BASE + 'main.m3u8?deviceId=dev-lc&PlaySessionId=ps-9' });
    feed.stop();
    await run(10);
    expect(deletes()[0].query).toBe('?deviceId=dev-lc&playSessionId=ps-9');
    await setup({ url: BASE + 'main.m3u8?MediaSourceId=m1' });
    feed.stop();
    await run(10);
    expect(deletes()).toHaveLength(0);
  });

  it('no media element: no seek listener, the feed still works', async () => {
    await setup({ noMedia: true, segs: 2 });
    await run(10);
    expect(mediaStarts()).toEqual([0, 6]);
  });

  it('a failure after stop() is not reported', async () => {
    await setup({ seg: () => net.status(401) });
    feed.stop();
    await run(10);
    expect(onFail).not.toHaveBeenCalled();
  });
});
