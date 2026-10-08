/* player.svelte.js in the desktop web build — the UX round's player lane:
 *
 *   - a trailer that can't be fetched keeps the player up with the error card
 *     (Retry, Close and an "Open on YouTube" link in WebPlayer, which reads
 *     trailerId()); no tab is opened and the page is not navigated away; the
 *     raw yt-dlp message goes to the console, not into the card;
 *   - PGS: libpgs is its own chunk in the web build (web/vite.config.js
 *     lazy-libpgs: loadPgs() resolves to the class), so the attach waits for it
 *     and gives up when another attach (or none) came in between.
 * jfhls.js and trailerstream.js are stubs recording what the player hands them. */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { startPlayer, warmPlayer } from '../helpers/player.js';
import { freshImport } from '../helpers/modules.js';
import { useClock } from '../helpers/time.js';
import { mockFetch } from '../helpers/fetch.js';
import { fakeVideo } from '../helpers/video.js';
import { movie, source, video as vstream, audio, tracks } from '../helpers/media.js';

const H = vi.hoisted(() => {
  const H = { feeds: [] };
  H.stub = () => ({
    createJfFeed: (opts) => {
      const f = { url: 'blob:jf-' + (H.feeds.length + 1), managed: false, stop: vi.fn(), opts };
      H.feeds.push(f);
      return f;
    }
  });
  return H;
});
vi.mock('../../src/lib/jfhls.js', () => H.stub());

const ROOT = path.resolve(import.meta.dirname, '../..');
const TRAILERSTREAM = path.resolve(ROOT, 'src/lib/trailerstream.js');
const LIBPGS = path.resolve(ROOT, 'src/vendor/libpgs.js');

beforeEach(() => {
  H.feeds = [];
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
});

/* ------------------------------------------------------------------------ */

describe('a trailer that fails on the desktop', () => {
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
    const m = await freshImport({ modules: { player: 'src/lib/player.svelte.js', nav: 'src/lib/nav.svelte.js', toast: 'src/lib/toast.svelte.js' } });
    const clock = useClock();
    mockFetch();
    const video = fakeVideo();
    m.player.setVideoEl(video);
    return { ...m, P: m.player.P, S: m.nav.S, clock, video };
  }

  it('keeps the player up with the error card — Retry, and the id for the YouTube link — and never calls onFail', async () => {
    const h = await boot();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const onFail = vi.fn();
    expect(h.player.trailerId()).toBe(null);
    h.player.playTrailerStream({ id: 'tGpTpVyI_OQ', title: 'Mad Men', onFail });
    expect(h.player.trailerId()).toBe('tGpTpVyI_OQ');
    const err = new Error("yt-dlp: ERROR: [youtube] tGpTpVyI_OQ: Sign in to confirm you're not a bot. Use --cookies-from-browser …");
    runs[0].cb.onFail(err);
    expect(h.S.screen).toBe('player');
    expect(h.P.trailer).toBe(true);
    expect(h.P.loading).toBe(false);
    expect(h.P.error).toMatchObject({
      title: 'This trailer can’t play here',
      detail: 'YouTube is refusing the server’s download right now. You can watch it on YouTube instead.'
    });
    expect(h.P.error.detail).not.toMatch(/yt-dlp|cookies|https?:/);
    expect(warn).toHaveBeenCalledWith('Trailer failed:', err);
    expect(onFail).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(h.toast.toastState.show).toBe(false);
    // Retry opens a fresh feeder for the same trailer
    h.player.retryPlayback();
    expect(runs).toHaveLength(2);
    expect(runs[1].id).toBe('tGpTpVyI_OQ');
    expect(h.P.error).toBe(null);
    // Close lowers it like any trailer exit, and the id goes with it
    h.player.exitPlayer();
    expect(h.player.trailerId()).toBe(null);
    expect(h.P.trailer).toBe(false);
  });

  it('any other failure: the server couldn’t get it', async () => {
    const h = await boot();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.player.playTrailerStream({ id: 'n9xhJrPXop4', title: 'Dune' });
    runs[0].cb.onFail(new Error('the trailer took too long to start'));
    expect(h.P.error.detail).toBe('The server couldn’t get it from YouTube. You can watch it on YouTube instead.');
    h.player.exitPlayer();
    // a failure without a message reads the same
    h.player.playTrailerStream({ id: 'n9xhJrPXop4', title: 'Dune' });
    runs[1].cb.onFail(null);
    expect(h.P.error.title).toBe('This trailer can’t play here');
  });
});

/* ------------------------------------------------------------------------ */

describe('PGS on the desktop: libpgs arrives as a chunk of its own', () => {
  beforeAll(warmPlayer, 120000);

  afterEach(() => vi.doUnmock(LIBPGS));

  /** loadPgs() → a promise the test settles (as web/vite.config.js makes it) */
  function libpgs({ ctor } = {}) {
    const made = [];
    class R {
      constructor(o) {
        if (ctor) ctor(o);
        this.o = o;
        made.push(this);
      }
      dispose() {}
    }
    const gate = {};
    gate.p = new Promise((res, rej) => Object.assign(gate, { res: () => res(R), rej }));
    vi.doMock(LIBPGS, () => ({ loadPgs: () => gate.p }));
    return { made, gate };
  }

  const film = () => movie({ MediaSources: [source([vstream(), audio(), tracks.pgs()])] });

  async function start() {
    const h = await startPlayer({ item: film(), reach: 'request' });
    h.release();
    await vi.waitFor(() => expect(h.video.src).toBeTruthy(), { timeout: 5000, interval: 5 });
    return h;
  }

  it('waits for the chunk, then draws on the canvas in main-thread mode', async () => {
    const { made, gate } = libpgs();
    const h = await start();
    const canvas = document.createElement('canvas');
    h.player.setPgsCanvas(canvas);
    canvas.style.display = 'none';
    h.player.pmSetSub(2);
    await h.settle();
    expect(made).toHaveLength(0); // not there yet
    gate.res();
    await h.settle();
    expect(made).toHaveLength(1);
    expect(made[0].o).toMatchObject({ mode: 'mainThread', video: h.video, canvas, timeOffset: -0 });
    expect(made[0].o.subUrl).toMatch(/\/Subtitles\/2\/0\/Stream\.pgssub\?ApiKey=/);
    expect(canvas.style.display).toBe('block');
  });

  it('a track switched off (or to another) before the chunk arrives is not drawn', async () => {
    const { made, gate } = libpgs();
    const h = await start();
    h.player.setPgsCanvas(document.createElement('canvas'));
    h.player.pmSetSub(2);
    h.player.pmSetSub(-1);
    gate.res();
    await h.settle();
    expect(made).toHaveLength(0);
  });

  it('no canvas: nothing is constructed', async () => {
    const { made, gate } = libpgs();
    const h = await start();
    h.player.setPgsCanvas(null);
    h.player.pmSetSub(2);
    gate.res();
    await h.settle();
    expect(made).toHaveLength(0);
  });

  it('a chunk that fails to load toasts (once, for the attach still wanted) and warns', async () => {
    const { made, gate } = libpgs();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = await start();
    h.player.setPgsCanvas(document.createElement('canvas'));
    h.player.pmSetSub(2);
    gate.rej(new Error('Failed to fetch dynamically imported module'));
    await h.settle();
    expect(made).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith('libpgs load failed', expect.any(Error));
    const toast = (await import(path.resolve(ROOT, 'src/lib/toast.svelte.js'))).toastState;
    expect(toast.msg).toBe('Couldn’t show these subtitles');
  });

  it('a stale load failure says nothing', async () => {
    const { gate } = libpgs();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = await start();
    h.player.setPgsCanvas(document.createElement('canvas'));
    const toast = (await import(path.resolve(ROOT, 'src/lib/toast.svelte.js'))).toastState;
    toast.msg = '';
    h.player.pmSetSub(2);
    h.player.pmSetSub(-1);
    gate.rej(new Error('offline'));
    await h.settle();
    expect(toast.msg).toBe('');
  });

  it('a renderer that throws on construction toasts instead of breaking playback', async () => {
    const { gate } = libpgs({ ctor: () => { throw new Error('bad sup'); } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = await start();
    h.player.setPgsCanvas(document.createElement('canvas'));
    h.player.pmSetSub(2);
    gate.res();
    await h.settle();
    const toast = (await import(path.resolve(ROOT, 'src/lib/toast.svelte.js'))).toastState;
    expect(toast.msg).toBe('Couldn’t show these subtitles');
    expect(h.P.error).toBe(null);
  });
});
