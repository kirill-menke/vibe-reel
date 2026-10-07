/* livefeed.js liveOpener(): the iPhone's watch-while-downloading source.
 *
 * CLAUDE.md (iPhone app): "watch-while-downloading (reel-api `livehls.py` remuxes
 * the growing file into an fMP4 *event* playlist, one job per download + audio
 * track; `livefeed.js` pings it and restarts a dropped job)". The module comment:
 * the job is started with POST `…/hls?audio=N`, polled while it probes, files are
 * under `…/hls/N/`; "the server drops a job nobody asked about for 10 minutes, so
 * this pings its status while the stream is open, and re-starts a job that has
 * gone (a 404)".
 *
 * Phone project only (pendingplay calls it inside `if (__PHONE__)`).
 * player.svelte.js is stubbed (vi.doMock) — only videoEl() is used, for the
 * feeder's 'seeking'/'waiting' wake-ups. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { freshImport, TEST_MEDIALIB, TEST_TOKEN } from '../helpers/modules.js';
import { mockFetch } from '../helpers/fetch.js';
import { installMSE } from '../helpers/mse.js';
import { useClock } from '../helpers/time.js';
import { m3u8, uniform } from '../helpers/trailer.js';

const PLAYER = path.resolve(import.meta.dirname, '../../src/lib/player.svelte.js');
const DL = 'abcdef0123456789abcdef0123456789abcdef01';
const HLS = TEST_MEDIALIB + '/api/downloads/' + DL + '/hls';
const CODECS = 'hvc1.2.4.L153.B0,ec-3';
const READY = { state: 'running', codecs: CODECS, duration: 3125.5 };

let lf, net, mse, clock, media, onFail, feed, srv, pos;

beforeEach(async () => {
  media = new EventTarget();
  vi.doMock(PLAYER, () => ({ videoEl: () => media }));
  ({ lf } = await freshImport({ modules: { lf: 'src/lib/livefeed.js' } }));
  mse = installMSE({ managed: 'only' });
  net = mockFetch();
  clock = useClock();
  onFail = vi.fn();
  feed = null;
  pos = 0;
});

afterEach(() => {
  feed?.stop();
  vi.doUnmock(PLAYER);
});

/* the reel-api livehls job for one audio track.
 *   status  [answers…] (POST = first, each GET the next, last repeats) or fn(n, t)
 *   segs / complete — the playlist; `srv.playlist404`, `srv.init404` (count), `srv.seg404` (Set) */
function server(audio, o = {}) {
  const s = { status: [], posts: 0, gets: 0, segs: o.segs || uniform(30), complete: o.complete ?? true, playlist404: false, init404: o.init404 || 0, seg404: new Set(), fetched: [] };
  const t0 = Date.now();
  const files = HLS + '/' + audio + '/';
  let n = 0;
  net.on(null, HLS + '?audio=' + audio, (req) => {
    req.method === 'POST' ? s.posts++ : s.gets++;
    s.status.push({ method: req.method, t: Date.now() - t0 });
    const st = typeof o.status === 'function' ? o.status(n++, Date.now() - t0) : (o.status || [READY])[Math.min(n++, (o.status || [READY]).length - 1)];
    return st && st.httpStatus ? net.status(st.httpStatus, st.body) : st;
  });
  net.on('GET', files + 'index.m3u8', () => (s.playlist404 ? net.status(404) : net.text(m3u8(s.segs, s.complete))));
  net.on('GET', files + 'init.mp4', () => {
    s.fetched.push('init.mp4');
    if (s.init404 > 0) {
      s.init404--;
      return net.status(404);
    }
    return mse.initSegment(500);
  });
  net.on('GET', (req) => req.url.startsWith(files + 's') && req.url.endsWith('.m4s'), (req) => {
    const name = req.url.slice(files.length);
    s.fetched.push(name);
    if (s.seg404.has(name)) return net.status(404);
    const g = s.segs.find((x) => x.name === name);
    return mse.segment(g.start, g.end, 4000);
  });
  return s;
}

function open(audioIndex) {
  feed = lf.liveOpener(DL)({ audioIndex, position: () => pos, jump: (t) => (pos = t), onFail });
  return feed;
}

const sb = () => mse.last.sb;
const segs = () => srv.fetched.filter((n) => n.endsWith('.m4s'));

describe('the job', () => {
  it('POSTs …/hls?audio=N and reads files from …/hls/N/', async () => {
    srv = server(2);
    open(2);
    await clock.tick(100);
    expect(net.calls[0]).toMatchObject({ method: 'POST', url: HLS + '?audio=2' });
    expect(net.calls[0].init.cache).toBe('no-store');
    expect(net.calls.slice(1).every((c) => c.url.startsWith(HLS + '/2/'))).toBe(true);
    expect(segs().length).toBeGreaterThan(0);
    expect(onFail).not.toHaveBeenCalled();
  });

  it.each([[undefined], [-1], [-5]])('audioIndex %s → the default track, audio=-1', async (a) => {
    srv = server(-1);
    open(a);
    await clock.tick(100);
    expect(net.calls[0].url).toBe(HLS + '?audio=-1');
    expect(segs().length).toBeGreaterThan(0);
  });

  it('audioIndex 0 is a real track (not the default)', async () => {
    srv = server(0);
    open(0);
    await clock.tick(100);
    expect(net.calls[0].url).toBe(HLS + '?audio=0');
  });

  it('returns the feeder’s object URL and managed flag', () => {
    srv = server(1);
    open(1);
    expect(feed.url).toBe(mse.last.url);
    expect(feed.managed).toBe(true);
  });
});

describe('the reel-api token (backend security.py)', () => {
  const AUTH = 'MediaBrowser Token="' + TEST_TOKEN + '"';

  it('every request — job, status pings, restarts, playlist, init, segments — carries the token', async () => {
    srv = server(1, { init404: 1 });
    srv.seg404.add('s003.m4s');   // a restart: POST again
    open(1);
    await clock.tick(1500);
    srv.seg404.clear();
    await clock.tick(61000);      // a status ping
    const kinds = new Set(net.calls.map((c) => c.method + ' ' + c.url.slice(HLS.length).replace(/s\d+\.m4s$/, 'seg')));
    expect([...kinds]).toEqual(expect.arrayContaining(['POST ?audio=1', 'GET ?audio=1', 'GET /1/index.m3u8', 'GET /1/init.mp4', 'GET /1/seg']));
    expect(srv.posts).toBeGreaterThan(1);
    expect(net.calls.filter((c) => c.headers.Authorization !== AUTH)).toEqual([]);
  });

  it('signed out: no Authorization header', async () => {
    ({ lf } = await freshImport({ storage: { 'reel.token': '' }, modules: { lf: 'src/lib/livefeed.js' } }));
    net = mockFetch();
    srv = server(1);
    open(1);
    await clock.tick(100);
    expect(net.calls.length).toBeGreaterThan(2);
    expect(net.calls.every((c) => !('Authorization' in c.headers))).toBe(true);
  });
});

describe('prepare: waiting for the probe', () => {
  it('polls GET every second while probing / without codecs, then plays with the codecs and duration', async () => {
    srv = server(1, { status: (n, t) => (t >= 3000 ? READY : n === 0 ? { state: 'probing' } : { state: 'running' }) });
    open(1);
    await clock.tick(2500);
    expect(mse.last.sourceBuffers).toEqual([]);
    await clock.tick(1000);
    expect(srv.status.map((c) => c.method + '@' + c.t)).toEqual(['POST@0', 'GET@1000', 'GET@2000', 'GET@3000']);
    expect(sb().mime).toBe('video/mp4; codecs="' + CODECS + '"');
    expect(mse.last.duration).toBe(3125.5);
  });

  it('an error state fails with the server’s reason, or a generic one', async () => {
    srv = server(1, { status: [{ state: 'probing' }, { state: 'error', error: 'ffmpeg exited 1' }] });
    open(1);
    await clock.tick(1100);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0][0].message).toBe('ffmpeg exited 1');
  });

  it('an error state that carries codecs still fails', async () => {
    srv = server(1, { status: [{ state: 'error', codecs: CODECS }] });
    open(1);
    await clock.tick(100);
    expect(onFail.mock.calls[0][0].message).toBe('the download can’t be streamed');
  });

  it('5 minutes of probing: "the download didn’t start in time"', async () => {
    srv = server(1, { status: [{ state: 'probing' }] });
    open(1);
    await clock.tick(299000);
    expect(onFail).not.toHaveBeenCalled();
    await clock.tick(2100);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0][0].message).toBe('the download didn’t start in time');
  });

  it('an HTTP error carries the detail', async () => {
    srv = server(1, { status: [{ httpStatus: 404, body: { detail: 'no such download' } }] });
    open(1);
    await clock.tick(100);
    expect(onFail.mock.calls[0][0].message).toBe('no such download');
  });
});

describe('keeping the job alive', () => {
  it('pings the status every 60 s while open; stop() ends the pings', async () => {
    srv = server(1);
    open(1);
    await clock.tick(100);
    expect(srv.gets).toBe(0);
    await clock.tick(60000);
    expect(srv.gets).toBe(1);
    await clock.tick(60000);
    expect(srv.gets).toBe(2);
    feed.stop();
    await clock.tick(180000);
    expect(srv.gets).toBe(2);
  });

  it('a ping that finds the job gone (404) restarts it with a POST; other errors do not', async () => {
    srv = server(1, { status: (n) => (n === 0 ? READY : n === 1 ? { httpStatus: 500, body: '' } : n === 2 ? { httpStatus: 404, body: { detail: 'gone' } } : READY) });
    open(1);
    await clock.tick(60100);   // ping 1: 500
    expect(srv.posts).toBe(1);
    await clock.tick(60000);   // ping 2: 404 → restart
    expect(srv.posts).toBe(2);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('a playlist 404 restarts the job and keeps waiting for segments', async () => {
    srv = server(1);
    srv.playlist404 = true;
    open(1);
    await clock.tick(1500);
    expect(srv.posts).toBeGreaterThanOrEqual(2);
    expect(segs()).toEqual([]);
    srv.playlist404 = false;
    await clock.tick(2000);
    expect(segs().length).toBeGreaterThan(0);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('a segment 404 restarts the job (once while it is in flight) and the segment is fetched again', async () => {
    srv = server(1);
    srv.seg404.add('s003.m4s');
    open(1);
    await clock.tick(200);
    const postsAfter404 = srv.posts;
    expect(postsAfter404).toBe(2);
    srv.seg404.clear();
    await clock.tick(2000);
    expect(segs().filter((n) => n === 's003.m4s').length).toBeGreaterThanOrEqual(2);
    expect(sb().ranges()[0][0]).toBe(0);
    expect(sb().ranges()[0][1]).toBeGreaterThan(16);
  });

  it('restarts in flight at the same time collapse into one POST', async () => {
    let answer;
    srv = server(1, { status: (n) => (n === 0 ? READY : new Promise((r) => (answer = () => r(READY)))) });
    srv.playlist404 = true;
    open(1);
    await clock.tick(5000);   // the playlist is re-read every second, each a 404
    expect(srv.posts).toBe(2);   // the first restart is still unanswered
    answer();
    await clock.tick(1100);
    expect(srv.posts).toBe(3);
  });
});

describe('init segment', () => {
  it('a missing init.mp4 is retried every second', async () => {
    srv = server(1, { init404: 3 });
    open(1);
    await clock.tick(2500);
    expect(srv.fetched.filter((n) => n === 'init.mp4')).toHaveLength(3);
    expect(segs()).toEqual([]);
    await clock.tick(1000);
    expect(sb().appends[0]).toEqual({ init: true, bytes: 500 });
    expect(segs().length).toBeGreaterThan(0);
  });

  it('30 misses: "the stream has no header"', async () => {
    srv = server(1, { init404: 1000 });
    open(1);
    await clock.tick(31000);
    expect(srv.fetched.filter((n) => n === 'init.mp4')).toHaveLength(30);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0][0].message).toBe('the stream has no header');
  });

  it('onFail also stops the pings', async () => {
    srv = server(1, { init404: 1000 });
    open(1);
    await clock.tick(31000);
    const g = srv.gets;
    await clock.tick(180000);
    expect(srv.gets).toBe(g);
  });
});

describe('stop()', () => {
  it('aborts the requests in flight and revokes the URL', async () => {
    srv = server(1);
    net.on('GET', HLS + '/1/init.mp4', net.hang());
    open(1);
    await clock.tick(100);
    const pending = net.callsTo(HLS + '/1/init.mp4')[0];
    expect(pending.signal.aborted).toBe(false);
    feed.stop();
    expect(pending.signal.aborted).toBe(true);
    expect(mse.revoked).toEqual([feed.url]);
    await clock.tick(10000);
    expect(onFail).not.toHaveBeenCalled();
    expect(net.calls.length).toBe(net.calls.indexOf(pending) + 1);
  });
});
