/* livefeed.js liveOpener(): the edges the main file leaves open — what a
 * non-404 HTTP error does on each file request, a restart POST that itself
 * fails, a status without a duration, the request options every call carries
 * and the download id in the URL. Mutation-backed (lane r3-tv-unit: Stryker on
 * src/lib/livefeed.js).
 *
 * CLAUDE.md (iPhone app): "`livefeed.js` pings it and restarts a dropped job";
 * module comment: "re-starts a job that has gone (a 404)". Only a 404 is "the
 * job is gone" — any other failure of the playlist or a segment is a broken
 * stream (onFail), not a reason to start a new job.
 *
 * Phone project only; player.svelte.js is stubbed (only videoEl() is used). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { freshImport, TEST_MEDIALIB } from '../helpers/modules.js';
import { mockFetch } from '../helpers/fetch.js';
import { installMSE } from '../helpers/mse.js';
import { useClock } from '../helpers/time.js';
import { m3u8, uniform } from '../helpers/trailer.js';

const PLAYER = path.resolve(import.meta.dirname, '../../src/lib/player.svelte.js');
const DL = 'abcdef0123456789abcdef0123456789abcdef01';
const HLS = TEST_MEDIALIB + '/api/downloads/' + DL + '/hls';
const CODECS = 'hvc1.2.4.L153.B0,ec-3';
const READY = { state: 'running', codecs: CODECS, duration: 3125.5 };

let lf, net, mse, clock, media, onFail, feed;

beforeEach(async () => {
  media = new EventTarget();
  vi.doMock(PLAYER, () => ({ videoEl: () => media }));
  ({ lf } = await freshImport({ modules: { lf: 'src/lib/livefeed.js' } }));
  mse = installMSE({ managed: 'only' });
  net = mockFetch();
  clock = useClock();
  onFail = vi.fn();
  feed = null;
});

afterEach(() => {
  feed?.stop();
  vi.doUnmock(PLAYER);
});

/** the job for audio track 1, every file answered unless a test overrides a route */
function job({ status = () => READY, hls = HLS, segs = uniform(30) } = {}) {
  const s = { posts: 0, gets: 0 };
  let n = 0;
  net.on(null, hls + '?audio=1', (req) => {
    req.method === 'POST' ? s.posts++ : s.gets++;
    return status(n++, req.method);
  });
  net.on('GET', hls + '/1/index.m3u8', () => net.text(m3u8(segs, true)));
  net.on('GET', hls + '/1/init.mp4', () => mse.initSegment(500));
  net.on('GET', (req) => req.url.startsWith(hls + '/1/s') && req.url.endsWith('.m4s'), (req) => {
    const g = segs.find((x) => req.url.endsWith('/' + x.name));
    return mse.segment(g.start, g.end, 4000);
  });
  return s;
}

const open = (id = DL) => (feed = lf.liveOpener(id)({ audioIndex: 1, position: () => 0, jump: () => {}, onFail }));
const m4s = () => net.calls.filter((c) => c.url.endsWith('.m4s'));

describe('a file request that fails with something other than 404', () => {
  it('a playlist 500 fails the stream with its status, and starts no new job', async () => {
    const s = job();
    net.on('GET', HLS + '/1/index.m3u8', net.status(500));
    open();
    await clock.tick(3000);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0][0].message).toBe('playlist: HTTP 500');
    expect(s.posts).toBe(1);
    expect(m4s()).toEqual([]);
  });

  it('a segment 503 fails the stream naming the segment, and starts no new job', async () => {
    const s = job();
    net.on('GET', HLS + '/1/s000.m4s', net.status(503));
    open();
    await clock.tick(3000);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0][0].message).toBe('s000.m4s: HTTP 503');
    expect(s.posts).toBe(1);
  });

  it('a 404 on the same segment is the job gone: a restart, no failure', async () => {
    const s = job();
    let first = true;
    net.on('GET', HLS + '/1/s000.m4s', () => {
      if (first) {
        first = false;
        return net.status(404);
      }
      return mse.segment(0, 4, 4000);
    });
    open();
    await clock.tick(3000);
    expect(onFail).not.toHaveBeenCalled();
    expect(s.posts).toBe(2);
    expect(mse.last.sb.ranges()[0][0]).toBe(0);
  });
});

describe('restarting a dropped job', () => {
  it('a restart POST that fails is swallowed, and the next 404 restarts again', async () => {
    // POST 1 starts the job; the restarts (POST 2, 3) answer 500, then 200
    const s = job({ status: (n, method) => (method === 'POST' && n > 0 && n < 3 ? net.status(500, { detail: 'busy' }) : READY) });
    let missing = 3;
    net.on('GET', HLS + '/1/index.m3u8', () => (missing-- > 0 ? net.status(404) : net.text(m3u8(uniform(30), true))));
    open();
    await clock.tick(5000);
    expect(onFail).not.toHaveBeenCalled();
    // one restart per 404, each one after the previous settled (a failed one clears the latch too)
    expect(s.posts).toBe(4);
    expect(m4s().length).toBeGreaterThan(0);
  });

  it('a ping that fails with a network error (no status) does not restart', async () => {
    const s = job({ status: (n) => (n === 0 ? READY : net.networkError()) });
    open();
    await clock.tick(60100);
    expect(s.gets).toBe(1);
    expect(s.posts).toBe(1);
    expect(onFail).not.toHaveBeenCalled();
  });
});

describe('prepare', () => {
  it('a status without a duration leaves the MediaSource duration alone', async () => {
    job({ status: () => ({ state: 'running', codecs: CODECS }) });
    open();
    await clock.tick(500);
    expect(mse.last.sb.mime).toBe('video/mp4; codecs="' + CODECS + '"');
    expect(mse.last.calls.filter((c) => c[0] === 'duration')).toEqual([]);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('an error while probing without a reason: the generic wording', async () => {
    job({ status: (n) => (n === 0 ? { state: 'probing' } : { state: 'error' }) });
    open();
    await clock.tick(1100);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0][0].message).toBe('the download can’t be streamed');
  });

  it('a probing job that reports codecs keeps polling until it leaves "probing"', async () => {
    const s = job({ status: (n) => (n < 2 ? { state: 'probing', codecs: CODECS } : READY) });
    open();
    await clock.tick(1100);
    expect(mse.last.sourceBuffers).toEqual([]);
    await clock.tick(1000);
    expect(s.gets).toBe(2);
    expect(mse.last.sb.mime).toBe('video/mp4; codecs="' + CODECS + '"');
  });

  it('an HTTP error whose body is not JSON: "HTTP <status>", with the status on the error', async () => {
    job({ status: () => net.status(504, 'upstream timeout') });
    open();
    await clock.tick(100);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0][0].message).toBe('HTTP 504');
    expect(onFail.mock.calls[0][0].status).toBe(504);
  });

  it('a 200 whose body is not JSON fails too (no status to restart on)', async () => {
    job({ status: () => net.text('not json', 'text/plain') });
    open();
    await clock.tick(100);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0][0].message).toBe('HTTP 200');
  });
});

describe('every request', () => {
  it('bypasses the HTTP cache and carries the stream’s abort signal', async () => {
    job();
    open();
    await clock.tick(60100);   // through the files and one ping
    const kinds = new Set();
    for (const c of net.calls) {
      expect(c.init.cache).toBe('no-store');
      expect(c.signal).toBeTruthy();
      kinds.add(c.method + ' ' + (c.url.endsWith('.m4s') ? 'seg' : c.url.split('/').pop()));
    }
    expect([...kinds].sort()).toEqual(['GET hls?audio=1', 'GET index.m3u8', 'GET init.mp4', 'GET seg', 'POST hls?audio=1']);
    const signals = new Set(net.calls.map((c) => c.signal));
    expect(signals.size).toBe(1);
    feed.stop();
    expect([...signals][0].aborted).toBe(true);
  });

  it('the download id is URL-encoded into the path', async () => {
    const id = 'a b/c';
    const s = job({ hls: TEST_MEDIALIB + '/api/downloads/a%20b%2Fc/hls' });
    open(id);
    await clock.tick(500);
    expect(s.posts).toBe(1);
    expect(net.unmatched).toEqual([]);
    expect(m4s().length).toBeGreaterThan(0);
  });
});

describe('timing', () => {
  it('the probe wait gives up only after more than 5 minutes (exactly 5 is still waiting)', async () => {
    job({ status: () => ({ state: 'probing' }) });
    open();
    await clock.tick(300500);   // the poll at exactly 300 s has run
    expect(onFail).not.toHaveBeenCalled();
    await clock.tick(1000);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0][0].message).toBe('the download didn’t start in time');
  });

  it('a playlist 404 while streaming is re-read a second later, not after the idle interval', async () => {
    const segs = uniform(3);   // 12 s known, still growing: the window wants more → 1 s polls
    job({ segs });
    let gone = false;
    const reads = [];
    net.on('GET', HLS + '/1/index.m3u8', () => {
      reads.push(clock.now());
      return gone ? net.status(404) : net.text(m3u8(segs, false));
    });
    open();
    await clock.tick(3000);
    expect(m4s().length).toBe(3);
    gone = true;
    const n = reads.length;
    await clock.tick(1100);   // one read → 404 (restart)
    gone = false;
    await clock.tick(3000);
    expect(reads.length - n).toBeGreaterThanOrEqual(3);
  });

  it('after stop() nothing is requested any more — not even a ping', async () => {
    job();
    open();
    await clock.tick(500);
    feed.stop();
    const n = net.calls.length;
    await clock.tick(200000);
    expect(net.calls.length).toBe(n);
  });
});

