/* trailerstream.js, iPhone build only.
 *
 * CLAUDE.md (iPhone app): "phone trailers are 1080p (`/api/trailers/<id>@1080`,
 * needs the backend deployed)"; "Streams Safari's HLS player can't take go
 * through MSE — ManagedMediaSource on iOS 17.1+ (the element's remote playback
 * must be off): trailers (`trailerstream.js`) …". The module comment adds: a
 * backend from before `@<height>` answers 400 "not a YouTube video id" — then
 * the plain key is played; and with a ManagedMediaSource the UA says when it
 * wants data, so the feeder stops fetching ahead while `streaming` is off, but
 * never while the playhead itself sits outside the buffer. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTrailerSource } from '../../src/lib/trailerstream.js';
import { cfg } from '../../src/lib/config.js';
import { installMSE } from '../helpers/mse.js';
import { mockFetch } from '../helpers/fetch.js';
import { useClock } from '../helpers/time.js';
import { TEST_MEDIALIB } from '../helpers/modules.js';
import { trailerServer, READY } from '../helpers/trailer.js';

const ID = 'dQw4w9WgXcQ';
const PLAIN = TEST_MEDIALIB + '/api/trailers/' + ID;
const P1080 = PLAIN + '@1080';

let clock, net, mse, pos, onFail, src, srv;

beforeEach(() => {
  cfg.medialib = TEST_MEDIALIB;
  clock = useClock();
  net = mockFetch();
  pos = 0;
  onFail = vi.fn();
  src = null;
});

afterEach(() => {
  src?.stop();
});

function start({ managed = 'only', base = P1080, ...o } = {}) {
  mse = installMSE({ managed });
  srv = trailerServer({ ...o, net, mse: () => mse, base });
  src = createTrailerSource(ID, { onFail, position: () => pos, jump: (t) => (pos = t) });
  return src;
}

const sb = () => mse.last.sb;
const segFetches = () => srv.fetched.filter((n) => n.endsWith('.m4s'));

describe('which MediaSource', () => {
  it('only ManagedMediaSource exists (iPhone): uses it and says managed', async () => {
    start({ managed: 'only' });
    expect(mse.last).toBeInstanceOf(mse.ManagedMediaSource);
    expect(src.managed).toBe(true);
    await clock.tick(500);
    expect(sb().appends.length).toBeGreaterThan(1);
  });

  it('a plain MediaSource is preferred when it exists (iPad, desktop): not managed', () => {
    start({ managed: true });
    expect(mse.last).not.toBeInstanceOf(mse.ManagedMediaSource);
    expect(src.managed).toBe(false);
  });

  it('no ManagedMediaSource at all: plain MediaSource, not managed', () => {
    start({ managed: false });
    expect(src.managed).toBe(false);
  });
});

describe('the 1080p key', () => {
  it('asks for <id>@1080', async () => {
    start();
    await clock.tick(500);
    expect(net.calls[0]).toMatchObject({ method: 'POST', url: P1080 });
    expect(net.calls.every((c) => c.url.startsWith(P1080))).toBe(true);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('an old backend refuses @1080 ("not a YouTube video id"): the plain key is played instead', async () => {
    mse = installMSE({ managed: 'only' });
    net.on('POST', P1080, net.status(400, { detail: 'not a YouTube video id' }));
    srv = trailerServer({ net, mse: () => mse, base: PLAIN });
    src = createTrailerSource(ID, { onFail, position: () => pos });
    await clock.tick(500);
    expect(net.calls.map((c) => c.method + ' ' + c.url).slice(0, 2)).toEqual(['POST ' + P1080, 'POST ' + PLAIN]);
    expect(net.calls.slice(1).every((c) => c.url.startsWith(PLAIN + '/') || c.url === PLAIN)).toBe(true);
    expect(segFetches().length).toBeGreaterThan(0);
    expect(onFail).not.toHaveBeenCalled();
  });

  it('any other refusal of the POST is a failure, without a second try', async () => {
    mse = installMSE({ managed: 'only' });
    net.on('POST', P1080, net.status(400, { detail: 'video is private' }));
    src = createTrailerSource(ID, { onFail, position: () => pos });
    await clock.tick(500);
    expect(net.calls).toHaveLength(1);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0][0].message).toBe('video is private');
  });
});

describe('ManagedMediaSource streaming', () => {
  it('streaming off: no fetching ahead while the playhead has >= 6 s buffered; startstreaming resumes at once', async () => {
    start();
    await clock.tick(500);
    expect(sb().ranges()).toEqual([[0, 32]]);   // 30 s ahead on the phone
    mse.last.setStreaming(false);
    pos = 10;   // wants up to 40, has 22 s ahead
    const n = segFetches().length;
    await clock.tick(3000);
    expect(segFetches().length).toBe(n);
    mse.last.setStreaming(true);
    await clock.tick(10);
    expect(segFetches().length).toBeGreaterThan(n);
    expect(sb().ranges()[0][1]).toBeGreaterThanOrEqual(40);
  });

  it('streaming off but under 6 s ahead of the playhead: keeps fetching', async () => {
    start();
    await clock.tick(500);
    mse.last.setStreaming(false);
    pos = 27;   // 5 s ahead
    const n = segFetches().length;
    await clock.tick(1000);
    expect(segFetches().length).toBeGreaterThan(n);
  });

  it('streaming off and the playhead outside the buffer (a seek): keeps fetching', async () => {
    start();
    await clock.tick(500);
    mse.last.setStreaming(false);
    pos = 70;
    await clock.tick(1000);
    expect(segFetches()).toContain('s017.m4s');
    expect(sb().ranges().some(([a, b]) => a <= 70 && b > 70)).toBe(true);
  });

  it('a stretch the UA evicted is fetched again once streaming resumes', async () => {
    start();
    await clock.tick(500);
    mse.last.setStreaming(false);
    sb().evict(16, 32);
    pos = 2;   // 14 s still buffered ahead
    await clock.tick(2000);
    expect(segFetches().filter((n) => n === 's004.m4s')).toHaveLength(1);
    mse.last.setStreaming(true);
    await clock.tick(500);
    expect(segFetches().filter((n) => n === 's004.m4s')).toHaveLength(2);
    expect(sb().ranges()).toHaveLength(1);
  });

  it('a plain MediaSource has no streaming signal: fetching never pauses', async () => {
    start({ managed: true });
    await clock.tick(500);
    pos = 10;
    await clock.tick(1000);
    expect(sb().ranges()[0][1]).toBeGreaterThanOrEqual(40);
  });

  it('stop() during the streaming wait leaves no timers', async () => {
    start({ status: [READY] });
    await clock.tick(500);
    mse.last.setStreaming(false);
    pos = 10;
    await clock.tick(400);
    src.stop();
    await clock.tick(1000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
