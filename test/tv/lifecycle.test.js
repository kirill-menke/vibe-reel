/* lifecycle.js + refresh60.js — the TV build's app lifecycle.
 *
 * CLAUDE.md, "App lifecycle": webOS parks a "closed" app and raises
 * `webOSRelaunch` when it is picked again; lifecycle.js activates explicitly
 * (PalmSystem.activate()), restores focus after a resume (a parked webview
 * comes back with document.activeElement on <body>), and reloads if boot never
 * finished — "guarded by an age + rate limit, because a cold launch can also
 * see hidden→visible while the first fetch is still in flight". On the way
 * down, "When the app is sent to the background mid-video (visibilitychange →
 * hidden …) or killed (pagehide …), lifecycle.js calls suspendPlayback(), which
 * exits the player properly (Stopped goes out with keepalive)".
 *
 * CLAUDE.md, "Engine costs": "src/lib/refresh60.js plays public/refresh60.mp4
 * after every playback, 5 s after launch and on every return to the
 * foreground. The clip must be on screen to count … it plays under the page
 * (video.rate60, z-index −1)." A real stream wins over the clip
 * (cancelRefreshReset() when a src is set).
 *
 * Three parts: refresh60.js on its own (real nav S), lifecycle.js with the
 * player / focus / refresh60 modules stubbed (exact arguments), and both real
 * modules against the real playback engine.
 *
 * initLifecycle() adds document/window listeners; they are collected and
 * removed after each test so a later test's events never reach an old graph. */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { freshImport } from '../helpers/modules.js';
import { useClock } from '../helpers/time.js';
import { startPlayer, warmPlayer } from '../helpers/player.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const abs = (rel) => path.resolve(ROOT, rel);

let added = [];
let hidden = false;
let palm = null;

function installPalm(extra = {}) {
  palm = { activate: vi.fn(), ...extra };
  window.PalmSystem = palm;
  return palm;
}

function trackListeners() {
  const spies = [document, window].map((target) => {
    const orig = target.addEventListener.bind(target);
    return vi.spyOn(target, 'addEventListener').mockImplementation((type, fn, o) => {
      added.push([target, type, fn, o]);
      return orig(type, fn, o);
    });
  });
  return () => spies.forEach((s) => s.mockRestore());
}

function visibility() {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
}
function goHidden() {
  hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
}
function goVisible() {
  hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
}

const clips = () => document.querySelectorAll('video.rate60');

beforeEach(() => {
  hidden = false;
  visibility();
  try {
    sessionStorage.clear();
  } catch {}
});

afterEach(() => {
  for (const [t, type, fn, o] of added) t.removeEventListener(type, fn, o);
  added = [];
  vi.doUnmock(abs('src/lib/player.svelte.js'));
  vi.doUnmock(abs('src/lib/focus.js'));
  vi.doUnmock(abs('src/lib/refresh60.js'));
  delete window.PalmSystem;
  palm = null;
  delete document.hidden;
  delete document.visibilityState;
  document.body.innerHTML = '';
});

/* ------------------------------------------------------------------ */
describe('refresh60.js: the 60p clip that puts the panel back to 60 Hz', () => {
  let R;
  let S;
  let clock;
  let play;

  async function load({ palmSystem = true, playResult } = {}) {
    if (palmSystem) installPalm();
    const m = await freshImport({ modules: { refresh: 'src/lib/refresh60.js', nav: 'src/lib/nav.svelte.js' } });
    R = m.refresh;
    S = m.nav.S;
    S.screen = 'home';
    play = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(playResult || (() => Promise.resolve()));
    clock = useClock();
  }

  it('only the TV switches rates: without PalmSystem nothing is scheduled or created', async () => {
    await load({ palmSystem: false });
    R.resetRefreshRate(0);
    expect(clock.pending()).toBe(0);
    await clock.tick(10000);
    expect(clips()).toHaveLength(0);
    expect(play).not.toHaveBeenCalled();
  });

  it('default delay 800 ms; the clip is a muted, aria-hidden video.rate60 prepended to <body>, playing refresh60.mp4', async () => {
    await load();
    const first = document.createElement('div');
    document.body.append(first);
    R.resetRefreshRate();
    await clock.tick(799);
    expect(clips()).toHaveLength(0);
    await clock.tick(1);
    const [el] = clips();
    expect(el).toBeTruthy();
    expect(document.body.firstElementChild).toBe(el);   // beneath the page (z-index −1 in style.css)
    expect(el.muted).toBe(true);
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.getAttribute('src')).toBe('refresh60.mp4');
    expect(play).toHaveBeenCalledTimes(1);
    expect(play.mock.contexts[0]).toBe(el);
  });

  it('its own <video>, never #video (libpgs holds that one)', async () => {
    await load();
    const main = document.createElement('video');
    main.id = 'video';
    document.body.append(main);
    R.resetRefreshRate(0);
    await clock.tick(0);
    expect(clips()).toHaveLength(1);
    expect(clips()[0]).not.toBe(main);
    expect(main.hasAttribute('src')).toBe(false);
    expect(main.className).toBe('');
  });

  it('a later call replaces the pending one (one clip, at the later deadline)', async () => {
    await load();
    R.resetRefreshRate(800);
    await clock.tick(500);
    R.resetRefreshRate(800);
    await clock.tick(799);
    expect(clips()).toHaveLength(0);
    await clock.tick(1);
    expect(clips()).toHaveLength(1);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('cleans up when the clip ends: paused, src removed + load(), element gone', async () => {
    await load();
    const pause = vi.spyOn(window.HTMLMediaElement.prototype, 'pause');
    const loadSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'load');
    R.resetRefreshRate(0);
    await clock.tick(0);
    const [el] = clips();
    el.dispatchEvent(new Event('ended'));
    expect(clips()).toHaveLength(0);
    expect(el.isConnected).toBe(false);
    expect(el.hasAttribute('src')).toBe(false);
    expect(pause).toHaveBeenCalled();
    expect(loadSpy).toHaveBeenCalled();
    expect(el.onended).toBe(null);
    expect(el.onerror).toBe(null);
    // the 4 s deadline was cleared with it
    expect(clock.pending()).toBe(0);
  });

  it('cleans up on a media error', async () => {
    await load();
    R.resetRefreshRate(0);
    await clock.tick(0);
    clips()[0].dispatchEvent(new Event('error'));
    expect(clips()).toHaveLength(0);
  });

  it('cleans up when play() is refused', async () => {
    await load({ playResult: () => Promise.reject(new DOMException('no', 'NotAllowedError')) });
    R.resetRefreshRate(0);
    await clock.tick(0);
    expect(clips()).toHaveLength(0);
    expect(clock.pending()).toBe(0);
  });

  it('a clip that never ends is removed at the 4 s deadline', async () => {
    await load();
    R.resetRefreshRate(0);
    await clock.tick(0);
    await clock.tick(3999);
    expect(clips()).toHaveLength(1);
    await clock.tick(1);
    expect(clips()).toHaveLength(0);
  });

  it('a throwing pause()/load() during cleanup still removes the element', async () => {
    await load();
    vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {
      throw new Error('gone');
    });
    R.resetRefreshRate(0);
    await clock.tick(0);
    clips()[0].dispatchEvent(new Event('ended'));
    expect(clips()).toHaveLength(0);
  });

  it('never during playback: S.screen === player when the delay runs out → nothing', async () => {
    await load();
    R.resetRefreshRate(800);
    S.screen = 'player';
    await clock.tick(800);
    expect(clips()).toHaveLength(0);
    expect(play).not.toHaveBeenCalled();
  });

  it('never while hidden (the clip has to be shown to count)', async () => {
    await load();
    R.resetRefreshRate(800);
    hidden = true;
    await clock.tick(800);
    expect(clips()).toHaveLength(0);
    hidden = false;
    R.resetRefreshRate(0);
    await clock.tick(0);
    expect(clips()).toHaveLength(1);
  });

  it('one clip at a time: a reset while one plays does not start a second', async () => {
    await load();
    R.resetRefreshRate(0);
    await clock.tick(0);
    const [el] = clips();
    R.resetRefreshRate(0);
    await clock.tick(0);
    expect(clips()).toHaveLength(1);
    expect(clips()[0]).toBe(el);
    expect(play).toHaveBeenCalledTimes(1);
    // once it has ended, the next reset plays again
    el.dispatchEvent(new Event('ended'));
    R.resetRefreshRate(0);
    await clock.tick(0);
    expect(clips()).toHaveLength(1);
    expect(clips()[0]).not.toBe(el);
  });

  it('cancelRefreshReset(): a pending reset never fires', async () => {
    await load();
    R.resetRefreshRate(800);
    await clock.tick(400);
    R.cancelRefreshReset();
    expect(clock.pending()).toBe(0);
    await clock.tick(5000);
    expect(clips()).toHaveLength(0);
  });

  it('cancelRefreshReset(): a clip already playing is removed and its deadline cleared', async () => {
    await load();
    R.resetRefreshRate(0);
    await clock.tick(0);
    const [el] = clips();
    R.cancelRefreshReset();
    expect(clips()).toHaveLength(0);
    expect(el.hasAttribute('src')).toBe(false);
    expect(clock.pending()).toBe(0);
    // idempotent with nothing to cancel
    expect(() => R.cancelRefreshReset()).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
describe('lifecycle.js: relaunch, focus repair, guarded reload, suspend', () => {
  let L;
  let S;
  let clock;
  let suspend;
  let focusFirst;
  let reset;
  let reload;

  async function init({ palmSystem = {} } = {}) {
    suspend = vi.fn();
    focusFirst = vi.fn();
    reset = vi.fn();
    vi.doMock(abs('src/lib/player.svelte.js'), () => ({ suspendPlayback: suspend }));
    vi.doMock(abs('src/lib/focus.js'), () => ({ focusFirst }));
    vi.doMock(abs('src/lib/refresh60.js'), () => ({ resetRefreshRate: reset, cancelRefreshReset: vi.fn() }));
    if (palmSystem) installPalm(palmSystem);
    const m = await freshImport({ modules: { life: 'src/lib/lifecycle.js', nav: 'src/lib/nav.svelte.js' } });
    L = m.life;
    S = m.nav.S;
    clock = useClock();
    reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    const untrack = trackListeners();
    L.initLifecycle();
    untrack();
  }

  const relaunch = () => document.dispatchEvent(new Event('webOSRelaunch'));

  it('schedules the refresh-rate reset 5 s after launch (after the splash)', async () => {
    await init();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledWith(5000);
  });

  it('webOSRelaunch → PalmSystem.activate()', async () => {
    await init();
    S.screen = 'home';
    relaunch();
    expect(palm.activate).toHaveBeenCalledTimes(1);
  });

  it('webOSRelaunch is listened for in the capture phase', async () => {
    await init();
    const entry = added.find(([t, type]) => t === document && type === 'webOSRelaunch');
    expect(entry && entry[3]).toBe(true);
  });

  it('webOSLaunch → activate() only (no focus repair, no reload)', async () => {
    await init();
    S.screen = 'boot';
    await clock.tick(20000);
    document.dispatchEvent(new Event('webOSLaunch'));
    expect(palm.activate).toHaveBeenCalledTimes(1);
    expect(focusFirst).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('off webOS (no PalmSystem) or without activate(), or a throwing one: no crash, resume still runs', async () => {
    await init({ palmSystem: null });
    S.screen = 'home';
    expect(() => relaunch()).not.toThrow();
    expect(focusFirst).toHaveBeenCalledTimes(1);

    window.PalmSystem = {};
    expect(() => relaunch()).not.toThrow();
    window.PalmSystem = {
      activate() {
        throw new Error('old PalmSystem');
      }
    };
    expect(() => relaunch()).not.toThrow();
    expect(focusFirst).toHaveBeenCalledTimes(3);
  });

  it('focus repair: activeElement on <body> → focusFirst()', async () => {
    await init();
    S.screen = 'home';
    expect(document.activeElement).toBe(document.body);
    relaunch();
    expect(focusFirst).toHaveBeenCalledTimes(1);
  });

  it('focus repair leaves a real focus alone', async () => {
    await init();
    S.screen = 'home';
    const b = document.createElement('button');
    b.className = 'focus';
    document.body.append(b);
    b.focus();
    expect(document.activeElement).toBe(b);
    relaunch();
    expect(focusFirst).not.toHaveBeenCalled();
  });

  it('a boot stuck past 15 s of page age reloads, stamping sessionStorage', async () => {
    await init();
    S.screen = 'boot';
    await clock.tick(15001);
    relaunch();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(Number(sessionStorage.getItem('reel.autoReloadAt'))).toBe(Date.now());
    expect(focusFirst).not.toHaveBeenCalled();
  });

  it('a cold launch (page age ≤ 15 s) never reloads, even on screen boot — it repairs focus instead', async () => {
    await init();
    S.screen = 'boot';
    await clock.tick(15000);
    relaunch();
    expect(reload).not.toHaveBeenCalled();
    expect(focusFirst).toHaveBeenCalledTimes(1);
  });

  it('a finished boot never reloads, however old the page', async () => {
    await init();
    S.screen = 'home';
    await clock.tick(3600000);
    relaunch();
    goVisible();
    expect(reload).not.toHaveBeenCalled();
  });

  it('rate limit: at most one reload a minute (60 s exactly is allowed again)', async () => {
    await init();
    S.screen = 'boot';
    await clock.tick(20000);
    relaunch();
    expect(reload).toHaveBeenCalledTimes(1);
    await clock.tick(59999);
    relaunch();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(focusFirst).not.toHaveBeenCalled();   // a stalled boot never falls through to focus repair
    await clock.tick(1);
    relaunch();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('the rate limit survives the reload (sessionStorage): a stamp from just now blocks it', async () => {
    sessionStorage.setItem('reel.autoReloadAt', String(Date.now() + 20000 - 1000));
    await init();
    S.screen = 'boot';
    await clock.tick(20000);
    relaunch();
    expect(reload).not.toHaveBeenCalled();
  });

  it('storage disabled: the guard is only a loop guard, the reload still happens', async () => {
    await init();
    S.screen = 'boot';
    await clock.tick(20000);
    vi.spyOn(window.Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(window.Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => relaunch()).not.toThrow();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('hidden → suspendPlayback(); visible → resume + resetRefreshRate(1500), no suspend', async () => {
    await init();
    S.screen = 'home';
    reset.mockClear();
    goHidden();
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
    goVisible();
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledWith(1500);
    expect(focusFirst).toHaveBeenCalledTimes(1);
  });

  it('hidden→visible with a stalled boot reloads too (the same guarded path)', async () => {
    await init();
    S.screen = 'boot';
    await clock.tick(16000);
    goHidden();
    goVisible();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('pagehide (the card closed, deploy.sh closeByAppId) → suspendPlayback()', async () => {
    await init();
    window.dispatchEvent(new Event('pagehide'));
    expect(suspend).toHaveBeenCalledTimes(1);
  });

  it('a failed <img> gets .imgfail (capture phase), a later load removes it; other elements are ignored', async () => {
    await init();
    const img = document.createElement('img');
    const div = document.createElement('div');
    document.body.append(img, div);
    img.dispatchEvent(new Event('error'));   // error/load don't bubble
    expect(img.classList.contains('imgfail')).toBe(true);
    img.dispatchEvent(new Event('load'));
    expect(img.classList.contains('imgfail')).toBe(false);
    div.dispatchEvent(new Event('error'));
    expect(div.classList.contains('imgfail')).toBe(false);
    div.classList.add('imgfail');   // only an <img>'s load clears it
    div.dispatchEvent(new Event('load'));
    expect(div.classList.contains('imgfail')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
describe('lifecycle.js + refresh60.js against the real playback engine (TV)', () => {
  beforeAll(warmPlayer, 120000);

  async function withLifecycle(opts) {
    installPalm();
    const h = await startPlayer(opts);
    document.body.append(h.video);
    const life = await import(/* @vite-ignore */ abs('src/lib/lifecycle.js'));
    const refresh = await import(/* @vite-ignore */ abs('src/lib/refresh60.js'));
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    const untrack = trackListeners();
    life.initLifecycle();
    untrack();
    return { ...h, life, refresh };
  }

  const stopped = (h) => h.net.callsTo('/Sessions/Playing/Stopped', 'POST');

  it('runs the TV module (no redirect in this project)', async () => {
    const h = await withLifecycle();
    expect(__PHONE__).toBe(false);
    expect(added.some(([t, type]) => t === document && type === 'webOSRelaunch')).toBe(true);
    expect(h.life.initLifecycle).toBeTypeOf('function');
  });

  it('hidden mid-video: the player exits at once with a keepalive Stopped, then the clip plays 800 ms later', async () => {
    const h = await withLifecycle();
    h.video.advance(300);
    goHidden();
    expect(h.S.screen).toBe('detail');
    await h.settle();
    expect(stopped(h)).toHaveLength(1);
    expect(stopped(h)[0].keepalive).toBe(true);
    // the exit's reset is scheduled, but a hidden page plays no clip
    await h.clock.tick(800);
    expect(clips()).toHaveLength(0);
    // back in front: resetRefreshRate(1500)
    goVisible();
    await h.clock.tick(1499);
    expect(clips()).toHaveLength(0);
    await h.clock.tick(1);
    expect(clips()).toHaveLength(1);
  });

  it('pagehide mid-video: Stopped with keepalive, exit to the detail page', async () => {
    const h = await withLifecycle();
    window.dispatchEvent(new Event('pagehide'));
    await h.settle();
    expect(h.S.screen).toBe('detail');
    expect(stopped(h)).toHaveLength(1);
    expect(stopped(h)[0].keepalive).toBe(true);
  });

  it('hidden off the player stops nothing', async () => {
    const h = await withLifecycle();
    h.player.exitPlayer();
    await h.settle();
    expect(stopped(h)).toHaveLength(1);
    goHidden();
    window.dispatchEvent(new Event('pagehide'));
    await h.settle();
    expect(stopped(h)).toHaveLength(1);
  });

  it('after every playback: exit → the clip 800 ms later, under the page', async () => {
    const h = await withLifecycle();
    h.player.exitPlayer();
    await h.clock.tick(799);
    expect(clips()).toHaveLength(0);
    await h.clock.tick(1);
    expect(clips()).toHaveLength(1);
    expect(document.body.firstElementChild).toBe(clips()[0]);
  });

  it('a real stream wins: a start inside the 800 ms cancels the pending clip', async () => {
    const h = await withLifecycle();
    h.player.exitPlayer();
    await h.clock.tick(100);
    h.player.playItem(h.item, 0);
    await h.settle();
    expect(h.S.screen).toBe('player');
    await h.clock.tick(5000);
    expect(clips()).toHaveLength(0);
  });

  it('a real stream wins: a clip already playing is removed when the new src is set', async () => {
    const h = await withLifecycle();
    h.player.exitPlayer();
    await h.clock.tick(800);
    expect(clips()).toHaveLength(1);
    h.player.playItem(h.item, 0);
    await h.settle();
    expect(h.S.screen).toBe('player');
    expect(clips()).toHaveLength(0);
  });

  it('the 5 s launch reset never plays over a video already running', async () => {
    const h = await withLifecycle();
    expect(h.S.screen).toBe('player');
    await h.clock.tick(6000);
    expect(clips()).toHaveLength(0);
  });
});
