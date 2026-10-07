/* The phone's offline copies (phone/src/lib/offline.svelte.js): a fresh module
 * graph on an iPhone-like page, and a fake Jellyfin that serves the HLS remux.
 *
 *   const h = await bootOffline({ index: [entry…], quota, usage });
 *   const h2 = await bootOffline({ index: h.index(), reuseCaches: h.cs });   // "the app was relaunched"
 *   h.off        the module (OFF, queueDownload, syncPositions, playOffline, …)
 *   h.cfg        config.js's cfg (same graph);  h.S / h.R  the phone router's state
 *   h.toast      toast.svelte.js (h.toast.toastState.msg)
 *   h.player     the player.svelte.js stub: playFeedStream (vi.fn), videoEl, QUALITY_CAPS
 *   h.feeders    with { stubFeeder: true }: every createSegFeeder(opts) call as { opts, stop, url }
 *   h.net / h.cs / h.st / h.mse / h.clock   fetch, Cache Storage, navigator.storage, MSE, fake clock
 *   h.files(dir) cached paths under /offline/<dir>/ ('init', 's0', 'poster', …), sorted
 *   h.index()    the persisted index (localStorage reel.offline), parsed
 *   await h.settle()   let the download loop run until nothing moves (real macrotask turns)
 *
 *   const srv = jellyfinHls(h, item, { segs: 6, subs: [...], codecs, supp, entry: 'hvc1' });
 *   srv.segFetches   [[index, session], …] in order;  srv.stops  DELETE ActiveEncodings queries
 *   srv.seg = (i, req) => undefined | net.status(…) | net.networkError() | net.hang()  per-segment override
 *   srv.item = …     what GET /Items/{id} answers (the full item);  srv.infoCalls  PlaybackInfo bodies
 *
 * player.svelte.js is a stub (vi.doMock): offline.svelte.js only needs
 * playFeedStream / videoEl / QUALITY_CAPS from it, and what it hands
 * playFeedStream (checkpoint / exit / open) is what the tests drive. */
import { vi, onTestFinished } from 'vitest';
import path from 'node:path';
import { freshImport } from './modules.js';
import { mockFetch } from './fetch.js';
import { installMSE } from './mse.js';
import { installCaches, installStorage } from './caches.js';
import { useClock } from './time.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
export const PLAYER_PATH = path.join(ROOT, 'src/lib/player.svelte.js');
export const OFFLINE_CACHE = 'vibereel-offline-v1';
export const MB = 1024 * 1024;

export const SEGFEED_PATH = path.join(ROOT, 'src/lib/segfeed.js');

export async function bootOffline({ index, storage = {}, signedIn = true, quota = 50e9, usage = 0, supported, managed = 'only', caches = true, reuseCaches = null, stubFeeder = false } = {}) {
  const video = { getAttribute: vi.fn(() => null), load: vi.fn() };
  const player = {
    playFeedStream: vi.fn(),
    videoEl: vi.fn(() => video),
    QUALITY_CAPS: ['original', 8000000, 4000000]
  };
  vi.doMock(PLAYER_PATH, () => player);
  onTestFinished(() => vi.doUnmock(PLAYER_PATH));
  // stubFeeder: segfeed.js as it is, except createSegFeeder only records its options
  const feeders = [];
  if (stubFeeder) {
    vi.doMock(SEGFEED_PATH, async (importOriginal) => ({
      ...(await importOriginal()),
      createSegFeeder: vi.fn((opts) => {
        const f = { opts, stop: vi.fn(), url: 'blob:feeder-' + feeders.length };
        feeders.push(f);
        return f;
      })
    }));
    onTestFinished(() => vi.doUnmock(SEGFEED_PATH));
  }
  const clock = useClock();
  const mse = managed ? installMSE({ managed, ...(supported ? { supported } : {}) }) : null;
  if (!managed) {
    vi.stubGlobal('MediaSource', undefined);
    vi.stubGlobal('ManagedMediaSource', undefined);
  }
  // reuseCaches: an earlier graph's Cache Storage (an app relaunch keeps it)
  let cs = null;
  if (reuseCaches) {
    cs = reuseCaches;
    vi.stubGlobal('caches', cs.api);
  } else if (caches) cs = installCaches();
  if (!caches) vi.stubGlobal('caches', undefined);
  const st = installStorage({ quota, usage });
  const net = mockFetch();
  const m = await freshImport({
    signedIn,
    storage: { ...(index ? { 'reel.offline': index } : {}), ...storage },
    modules: {
      off: 'phone/src/lib/offline.svelte.js',
      config: 'src/lib/config.js',
      router: 'phone/src/lib/router.svelte.js',
      toast: 'src/lib/toast.svelte.js'
    }
  });
  // A test that fails half-way must not leave its download loop running into
  // the next test (its fetches would hit that test's network guard): park it.
  onTestFinished(async () => {
    for (const e of m.off.OFF.list) if (e.user === m.config.cfg.userId && (e.state === 'downloading' || e.state === 'queued')) m.off.pauseDownload(e.id);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  });
  const h = {
    off: m.off,
    cfg: m.config.cfg,
    S: m.router.S,
    R: m.router.R,
    toast: m.toast,
    player,
    video,
    feeders,
    net,
    cs,
    st,
    mse,
    clock,
    files(dir) {
      const pre = '/offline/' + dir + '/';
      return cs.urls(OFFLINE_CACHE).filter((u) => u.startsWith(pre)).map((u) => u.slice(pre.length)).sort();
    },
    allFiles: () => cs.urls(OFFLINE_CACHE),
    index() {
      const raw = localStorage.getItem('reel.offline');
      return raw == null ? null : JSON.parse(raw);
    },
    entry: (id, user = m.config.cfg.userId) => m.off.OFF.list.find((e) => e.id === id && e.user === user) || null,
    async settle(turns = 60) {
      for (let i = 0; i < turns; i++) {
        await vi.advanceTimersByTimeAsync(0);
        await new Promise((r) => setImmediate(r));
      }
    }
  };
  return h;
}

/* An fMP4 init segment as far as sampleEntries() looks: an 'stsd' box whose
 * first sample entry fourcc sits 16 bytes after the box type. */
export function initWith(...fourccs) {
  const parts = [];
  for (const cc of fourccs) {
    const b = new Uint8Array(32);
    b.set([0x73, 0x74, 0x73, 0x64], 4);   // 'stsd' at 4
    for (let i = 0; i < 4; i++) b[20 + i] = cc.charCodeAt(i);   // entry at 4 + 16
    parts.push(b);
  }
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0) + 8);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out.buffer;
}

export function jellyfinHls(h, item, o = {}) {
  const { net } = h;
  const id = item.Id;
  const src = item.MediaSources[0];
  const srv = {
    item,
    segs: o.segs ?? 6,
    segLen: o.segLen ?? 6,
    segSize: o.segSize ?? 0,      // > 0: answer with a Content-Length of this many bytes
    codecs: o.codecs ?? 'hvc1.2.4.L150.B0,ec-3',
    supp: o.supp ?? '',
    entry: o.entry ?? 'hvc1',
    subs: o.subs ?? [],           // [{ Index, Language, … }] external VTT tracks Jellyfin offers
    sessionN: 0,
    segFetches: [],
    stops: [],
    infoCalls: [],
    itemCalls: 0,
    seg: null,
    init: null,                   // (req) => override for the init segment
    playlist: null,               // (req) => override for main.m3u8
    images: [],
    image: null,                  // (req) => override for an image
    subFetches: []
  };
  const sessionOf = (url) => (url.match(/PlaySessionId=([^&]+)/) || [])[1];
  net.on('GET', (r) => r.path === '/Items/' + id, () => {
    srv.itemCalls++;
    return typeof srv.item === 'function' ? srv.item() : srv.item;
  });
  net.on('POST', '/Items/' + id + '/PlaybackInfo', (req) => {
    srv.infoCalls.push(req.body);
    const ps = 'ps' + ++srv.sessionN;
    const streams = [
      ...src.MediaStreams,
      ...srv.subs.map((s) => ({ Type: 'Subtitle', Codec: 'subrip', DeliveryMethod: 'External', DeliveryUrl: '/Videos/' + id + '/' + src.Id + '/Subtitles/' + s.Index + '/0/Stream.vtt?api_key=tok', IsExternal: false, ...s }))
    ];
    return {
      PlaySessionId: ps,
      MediaSources: [
        {
          ...src,
          MediaStreams: streams,
          TranscodingUrl: '/videos/' + id + '/master.m3u8?DeviceId=dev-test&MediaSourceId=' + src.Id + '&PlaySessionId=' + ps + '&api_key=tok-u1'
        }
      ]
    };
  });
  net.on('GET', (r) => r.path === '/videos/' + id + '/master.m3u8', () =>
    net.text('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=9000000,CODECS="' + srv.codecs + '"' + (srv.supp ? ',SUPPLEMENTAL-CODECS="' + srv.supp + '"' : '') + ',RESOLUTION=1920x1080\nmain.m3u8?x=1\n', 'application/vnd.apple.mpegurl')
  );
  net.on('GET', (r) => r.path === '/videos/' + id + '/main.m3u8', (req) => {
    if (srv.playlist) {
      const out = srv.playlist(req);
      if (out !== undefined) return out;
    }
    const ps = sessionOf(req.url);
    let s = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:' + srv.segLen + '\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI="hls1/main/-1.mp4?PlaySessionId=' + ps + '"\n';
    for (let i = 0; i < srv.segs; i++) s += '#EXTINF:' + srv.segLen.toFixed(6) + ', nodesc\nhls1/main/' + i + '.mp4?PlaySessionId=' + ps + '\n';
    s += '#EXT-X-ENDLIST\n';
    return net.text(s, 'application/vnd.apple.mpegurl');
  });
  net.on('GET', (r) => r.path === '/videos/' + id + '/hls1/main/-1.mp4', (req) => {
    if (srv.init) {
      const out = srv.init(req);
      if (out !== undefined) return out;
    }
    return new Response(initWith(srv.entry, 'ec-3'), { status: 200, headers: { 'Content-Type': 'video/mp4' } });
  });
  net.on('GET', (r) => /^\/videos\/[^/]+\/hls1\/main\/\d+\.mp4$/.test(r.path) && r.path.startsWith('/videos/' + id + '/'), (req) => {
    const i = Number(req.path.match(/(\d+)\.mp4$/)[1]);
    srv.segFetches.push([i, sessionOf(req.url)]);
    if (srv.seg) {
      const out = srv.seg(i, req);
      if (out !== undefined) return out;
    }
    const body = new Uint8Array([0x6d, 0x6f, 0x6f, 0x66, i & 0xff]);
    const headers = { 'Content-Type': 'video/mp4' };
    if (srv.segSize > 0) headers['Content-Length'] = String(srv.segSize);
    return new Response(body, { status: 200, headers });
  });
  net.on('GET', (r) => r.path.startsWith('/Videos/' + id + '/') && r.path.endsWith('/Stream.vtt'), (req) => {
    srv.subFetches.push(req.path);
    return net.text('WEBVTT\n\n00:00.000 --> 00:01.000\nsub ' + req.path + '\n', 'text/vtt');
  });
  net.on('GET', (r) => /\/Items\/[^/]+\/Images\//.test(r.path), (req) => {
    srv.images.push(req.url);
    if (srv.image) {
      const out = srv.image(req);
      if (out !== undefined) return out;
    }
    return new Response(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], { type: 'image/jpeg' }), { status: 200 });
  });
  net.on('DELETE', (r) => r.path === '/Videos/ActiveEncodings', (req) => {
    srv.stops.push(Object.fromEntries(new URLSearchParams(req.query)));
    return null;
  });
  return srv;
}
