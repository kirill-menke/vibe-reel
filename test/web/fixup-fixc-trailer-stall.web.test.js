/* A trailer that stops arriving gives up on the desktop (S3-8):
 *   - player.svelte.js: 30 s with neither the playhead nor the buffered end
 *     moving brings the error card "This trailer stopped loading" (Retry from
 *     the position, and WebPlayer's Open on YouTube) — a download stream can
 *     wait, a trailer can't; a buffer that still grows keeps the ring;
 *   - trailerstream.js: every request to reel-api has a deadline (60 s,
 *     headers and body) — a hung one fails the run as 'TrailerStall', which the
 *     player shows as the same card; a hung subtitle fetch only drops the
 *     subtitles; stop() during a request stays quiet. */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { warmPlayer } from '../helpers/player.js';
import { freshImport, TEST_MEDIALIB } from '../helpers/modules.js';
import { useClock } from '../helpers/time.js';
import { mockFetch } from '../helpers/fetch.js';
import { fakeVideo } from '../helpers/video.js';
import { installMSE } from '../helpers/mse.js';
import { trailerServer, READY } from '../helpers/trailer.js';
import { createTrailerSource } from '../../src/lib/trailerstream.js';
import { cfg } from '../../src/lib/config.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TRAILERSTREAM = path.resolve(ROOT, 'src/lib/trailerstream.js');

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
});

/* ------------------------------------------------------------------------ */

describe('the player: a stalled trailer brings its error card', () => {
  beforeAll(warmPlayer, 120000);

  let runs;
  afterEach(() => {
    vi.doUnmock(TRAILERSTREAM);
    document.body.innerHTML = '';
  });

  async function boot() {
    runs = [];
    vi.doMock(TRAILERSTREAM, () => ({
      createTrailerSource: (id, cb) => {
        const r = { id, cb, url: 'blob:trailer-' + (runs.length + 1), managed: false, stop: vi.fn() };
        runs.push(r);
        return r;
      }
    }));
    const m = await freshImport({ modules: { player: 'src/lib/player.svelte.js', nav: 'src/lib/nav.svelte.js' } });
    const clock = useClock();
    mockFetch();
    const video = fakeVideo();
    m.player.setVideoEl(video);
    return { ...m, P: m.player.P, S: m.nav.S, clock, video };
  }

  /** the trailer up and playing at `t` s with `buf` s buffered, then frozen */
  async function playingTo(h, t, buf) {
    h.player.playTrailerStream({ id: 'n9xhJrPXop4', title: 'Dune: Part Two' });
    h.video.setReadyState(4);
    h.video.emit('loadedmetadata');
    await h.clock.tick(10);
    expect(h.P.loading).toBe(false);
    h.video.setBuffered([[0, buf]]);
    for (let s = 0; s < t; s += 0.5) {
      h.video.advance(0.5);
      await h.clock.tick(500);
    }
    h.video.freeze();
  }

  it('30 s of nothing: the card, the video paused, Retry from where it stopped', async () => {
    const h = await boot();
    await playingTo(h, 10, 10);
    await h.clock.tick(20000);
    expect(h.P.spinner).toBe(true); // the ring ("Buffering…") first
    expect(h.P.error).toBe(null);
    await h.clock.tick(11000);
    expect(h.P.error).toMatchObject({ title: 'This trailer stopped loading' });
    expect(h.P.error.detail).toMatch(/^Nothing has arrived from the server for 3\d s\. Retry from 0:\d\d, or watch it on YouTube\.$/);
    expect(h.video.paused).toBe(true);
    expect(h.S.screen).toBe('player');
    expect(h.player.trailerId()).toBe('n9xhJrPXop4'); // WebPlayer's YouTube link reads it
    // Retry: a fresh feeder from the position
    h.player.retryPlayback();
    expect(runs).toHaveLength(2);
    expect(h.P.error).toBe(null);
    expect(h.P.loadingFrom).toBeGreaterThanOrEqual(9);
    h.player.exitPlayer();
  });

  it('a buffer still growing keeps the ring, no card', async () => {
    const h = await boot();
    await playingTo(h, 10, 10);
    for (let i = 0; i < 80; i++) {
      h.video.setBuffered([[0, 10 + i * 0.1]]);
      await h.clock.tick(500);
    }
    expect(h.P.error).toBe(null);
    expect(h.P.spinner).toBe(true);
    h.player.exitPlayer();
  });

  it('a request that hung (trailerstream’s TrailerStall): the same card', async () => {
    const h = await boot();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.player.playTrailerStream({ id: 'n9xhJrPXop4', title: 'Dune: Part Two' });
    const e = new Error('no answer from the server for 60 s (s000.m4s)');
    e.name = 'TrailerStall';
    runs[0].cb.onFail(e);
    expect(h.P.error).toMatchObject({ title: 'This trailer stopped loading', detail: 'Nothing has arrived from the server for 60 s. Retry from 0:00, or watch it on YouTube.' });
    expect(h.P.loading).toBe(false);
    h.player.exitPlayer();
  });
});

/* ------------------------------------------------------------------------ */

describe('trailerstream: a deadline on every request', () => {
  const ID = 'n9xhJrPXop4';
  const BASE = TEST_MEDIALIB + '/api/trailers/' + ID + '@1080';
  let clock, net, mse, srv, src, onFail, onSubs;

  beforeEach(() => {
    cfg.medialib = TEST_MEDIALIB;
    clock = useClock();
    net = mockFetch();
    onFail = vi.fn();
    onSubs = vi.fn();
    src = null;
  });
  afterEach(() => src?.stop());

  function start(o = {}, hooks = {}) {
    mse = installMSE({});
    srv = trailerServer({ ...o, net, mse: () => mse, base: BASE });
    src = createTrailerSource(ID, { onFail, onSubs, position: () => 0, jump: () => {}, ...hooks });
    return src;
  }

  it('a segment that never answers: TrailerStall after 60 s, not before', async () => {
    start();
    net.on('GET', BASE + '/s000.m4s', net.hang());
    await clock.tick(59000);
    expect(onFail).not.toHaveBeenCalled();
    await clock.tick(1500);
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(onFail.mock.calls[0][0]).toMatchObject({ name: 'TrailerStall', message: 'no answer from the server for 60 s (s000.m4s)' });
  });

  it('a status request that hangs', async () => {
    start();
    net.on(null, BASE, net.hang());
    await clock.tick(60500);
    expect(onFail.mock.calls[0][0]).toMatchObject({ name: 'TrailerStall' });
  });

  it('a playlist request that hangs', async () => {
    start();
    net.on('GET', BASE + '/index.m3u8', net.hang());
    await clock.tick(60500);
    expect(onFail.mock.calls[0][0]).toMatchObject({ name: 'TrailerStall', message: 'no answer from the server for 60 s (index.m3u8)' });
  });

  it('status answers still read as before: the error field, or HTTP <status> for a body that isn’t JSON', async () => {
    start({ status: [{ httpStatus: 500, body: { error: 'yt-dlp exploded' } }] });
    await clock.tick(50);
    expect(onFail.mock.calls[0][0].message).toBe('yt-dlp exploded');
    src.stop();
    onFail.mockClear();
    start();
    net.on(null, BASE, net.status(502, 'Bad Gateway'));
    await clock.tick(50);
    expect(onFail.mock.calls[0][0].message).toBe('HTTP 502');
    src.stop();
    onFail.mockClear();
    start(); // an empty answer (no body to hand on)
    net.on(null, BASE, net.status(204));
    await clock.tick(50);
    expect(onFail.mock.calls[0][0].message).toBe('HTTP 204');
  });

  it('a playlist error still reads "playlist: HTTP <status>"', async () => {
    start();
    net.on('GET', BASE + '/index.m3u8', net.status(503));
    await clock.tick(100);
    expect(onFail.mock.calls[0][0].message).toBe('playlist: HTTP 503');
  });

  it('a segment error still reads "<name>: HTTP <status>"', async () => {
    start();
    net.on('GET', BASE + '/s000.m4s', net.status(404));
    await clock.tick(100);
    expect(onFail.mock.calls[0][0].message).toBe('s000.m4s: HTTP 404');
  });

  it('a subtitle fetch that hangs only drops the subtitles: the trailer starts', async () => {
    start({ status: [{ ...READY, subs: { lang: 'en', kind: 'manual' } }] });
    net.on('GET', BASE + '/subs.vtt', net.hang());
    await clock.tick(1000);
    expect(srv.fetched).not.toContain('init.mp4'); // waiting on the subtitles
    await clock.tick(60000);
    expect(onFail).not.toHaveBeenCalled();
    expect(onSubs).not.toHaveBeenCalled();
    expect(srv.fetched).toContain('init.mp4');
  });

  it('subtitles that answer are handed over; a refused subtitle fetch is no subtitles', async () => {
    start({ status: [{ ...READY, subs: { lang: 'en', kind: 'manual' } }] });
    await clock.tick(200);
    expect(onSubs).toHaveBeenCalledTimes(1);
    expect(onSubs.mock.calls[0][0]).toMatch(/^WEBVTT/);
    src.stop();
    onSubs.mockClear();
    start({ status: [{ ...READY, subs: { lang: 'en', kind: 'manual' } }] });
    net.on('GET', BASE + '/subs.vtt', net.status(404));
    await clock.tick(200);
    expect(onSubs).not.toHaveBeenCalled();
    expect(srv.fetched).toContain('init.mp4');
  });

  it('stop() during a hung request is quiet, and nothing is fetched on an aborted run', async () => {
    start();
    net.on('GET', BASE + '/s001.m4s', net.hang());
    await clock.tick(50);
    expect(net.calls.at(-1).url).toBe(BASE + '/s001.m4s');
    src.stop();
    await clock.tick(70000);
    expect(onFail).not.toHaveBeenCalled();
    // stopped from onInfo: the subtitle request goes out already aborted
    start({ status: [{ ...READY, subs: { lang: 'en', kind: 'manual' } }] }, { onInfo: () => src.stop() });
    await clock.tick(500);
    expect(srv.fetched).not.toContain('subs.vtt');
    expect(onFail).not.toHaveBeenCalled();
  });
});
