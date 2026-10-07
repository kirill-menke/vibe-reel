/* swupdate.js — a new service worker build is applied where nobody sees it.
 *
 * CLAUDE.md (iPhone app): "A new build never reloads under the user
 * (phone/src/lib/swupdate.js): `controllerchange` only marks it pending; it
 * applies on the next trip to the background, or after 60 s idle at a tab root
 * with nothing open — never under the player or Login, and there is no 'new
 * version' prompt." docs/ios/ARCHITECTURE.md adds the idle fallback's other
 * conditions: no sheet/modal/focused field/running offline download.
 *
 * The router is the real one (S / R / stack() as the app drives them);
 * offline.svelte.js is replaced by a stub whose OFF.list the tests fill, so a
 * "running download" is just an entry in state 'downloading'. location.reload
 * is a spy: a reload is the observable "the update was applied". */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { freshImport } from '../helpers/modules.js';
import { useClock } from '../helpers/time.js';
import { installServiceWorker, visibility, captureListeners } from '../helpers/pwa.js';

const OFFLINE = path.resolve(import.meta.dirname, '../../phone/src/lib/offline.svelte.js');
const IDLE = 60000;
const RECHECK = 10000;

let up, router, toast, sw, vis, live, reload, clock, OFF;

async function boot({ controlled = true, init = true } = {}) {
  ({ up, router, toast } = await freshImport({
    modules: {
      up: 'phone/src/lib/swupdate.js',
      router: 'phone/src/lib/router.svelte.js',
      toast: 'src/lib/toast.svelte.js'
    }
  }));
  sw = installServiceWorker({ controlled });
  live = captureListeners();
  if (init) up.initUpdates();
}

beforeEach(() => {
  OFF = { list: [] };
  vi.doMock(OFFLINE, () => ({ OFF }));
  clock = useClock();
  vis = visibility('visible');
  reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
});

afterEach(() => {
  vi.doUnmock(OFFLINE);
  document.body.innerHTML = '';
});

const deeper = () => {
  const R = router.R;
  R.stacks = { ...R.stacks, [R.tab]: [...R.stacks[R.tab], { name: 'detail', params: { id: 'x' }, key: 'detail-x' }] };
};

describe('controllerchange only marks the update pending', () => {
  it('a new build taking over a visible page does not reload it, and asks nothing', async () => {
    await boot();
    const confirm = vi.fn(() => true);
    const alert = vi.fn();
    vi.stubGlobal('confirm', confirm);
    vi.stubGlobal('alert', alert);
    const before = document.body.innerHTML;
    sw.takeOver();
    await clock.tick(IDLE - 1);
    expect(reload).not.toHaveBeenCalled();
    expect(up.updateReloading()).toBe(false);
    // no "new version" prompt of any kind: no dialog, no toast, nothing added to the page
    expect(confirm).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    expect(toast.toastState.show).toBe(false);
    expect(document.body.innerHTML).toBe(before);
  });

  it('the first install claiming an uncontrolled page is not an update', async () => {
    await boot({ controlled: false });
    sw.takeOver();
    vis.hide();
    await clock.tick(IDLE * 3);
    expect(reload).not.toHaveBeenCalled();
  });

  it('a second controllerchange while pending changes nothing (one reload, one idle timer)', async () => {
    await boot();
    sw.takeOver();
    await clock.tick(30000);
    sw.takeOver();   // must not restart the 60 s wait
    await clock.tick(30000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('without service workers initUpdates() does nothing at all', async () => {
    await boot({ init: false });
    delete navigator.serviceWorker;
    up.initUpdates();
    expect(live.added).toEqual([]);
  });
});

describe('applied on the next trip to the background', () => {
  it('pending + hidden → reload, with the PWA-05 hooks run first ("hidden")', async () => {
    await boot();
    const seen = [];
    up.onBeforeUpdateReload((why) => seen.push([why, up.updateReloading(), reload.mock.calls.length]));
    vis.hide();
    expect(reload).not.toHaveBeenCalled();   // nothing pending yet: going away is just going away
    vis.show();
    sw.takeOver();
    expect(reload).not.toHaveBeenCalled();
    vis.hide();
    expect(reload).toHaveBeenCalledTimes(1);
    // the hook ran before the reload, and already saw updateReloading() (restore keeps its snapshot)
    expect(seen).toEqual([['hidden', true, 0]]);
  });

  it('installed while already away: applied at once', async () => {
    await boot();
    vis.quiet('hidden');
    sw.takeOver();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a hook that throws does not keep the old build running; later hooks still run', async () => {
    await boot();
    const second = vi.fn();
    up.onBeforeUpdateReload(() => {
      throw new Error('save failed');
    });
    up.onBeforeUpdateReload(second);
    sw.takeOver();
    vis.hide();
    expect(second).toHaveBeenCalledWith('hidden');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads only once, however often the page is hidden after', async () => {
    await boot();
    sw.takeOver();
    vis.hide();
    vis.show();
    vis.hide();
    await clock.tick(IDLE * 2);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the player', () => (router.S.screen = 'player')],
    ['Login (screen)', () => (router.S.screen = 'login')],
    ['the login modal', () => router.openLoginModal()],
    ['any modal', () => (router.R.modal = 'player')]
  ])('never under %s: waits for the next trip after it closed', async (_, open) => {
    await boot();
    sw.takeOver();
    open();
    vis.hide();
    expect(reload).not.toHaveBeenCalled();
    vis.show();
    router.R.modal = null;
    router.S.screen = 'home';
    vis.hide();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('an open sheet does not block the background path (only the idle one)', async () => {
    await boot();
    router.openSheet('offline');
    sw.takeOver();
    vis.hide();
    expect(reload).toHaveBeenCalledWith();
  });
});

describe('idle fallback: 60 s without input at a tab root with nothing open', () => {
  it('reloads ("idle") once 60 s have passed since the last input, not before', async () => {
    await boot();
    const why = vi.fn();
    up.onBeforeUpdateReload(why);
    sw.takeOver();
    await clock.tick(IDLE - 1);
    expect(reload).not.toHaveBeenCalled();
    await clock.tick(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(why).toHaveBeenCalledWith('idle');
  });

  it.each(['pointerdown', 'keydown', 'wheel', 'scroll'])('a %s restarts the 60 s', async (type) => {
    await boot();
    await clock.tick(50000);   // idle before the update arrived counts too…
    sw.takeOver();
    await clock.tick(5000);
    window.dispatchEvent(new Event(type));   // …until any input
    await clock.tick(IDLE - 1);
    expect(reload).not.toHaveBeenCalled();
    await clock.tick(RECHECK);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('input before the update counts: an idle user gets it ≥ 10 s after it arrived', async () => {
    await boot();
    await clock.tick(IDLE * 5);
    sw.takeOver();
    await clock.tick(RECHECK - 1);
    expect(reload).not.toHaveBeenCalled();
    await clock.tick(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('coming back to the foreground counts as activity', async () => {
    await boot();
    sw.takeOver();
    router.S.screen = 'player';   // keeps the hidden path from applying it
    await clock.tick(40000);
    vis.hide();
    vis.show();
    router.S.screen = 'home';
    router.R.modal = null;
    await clock.tick(IDLE - 1);
    expect(reload).not.toHaveBeenCalled();
    await clock.tick(RECHECK);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  const blockers = [
    ['the player', () => (router.S.screen = 'player'), () => ((router.R.modal = null), (router.S.screen = 'home'))],
    ['Login', () => (router.S.screen = 'login'), () => (router.S.screen = 'home')],
    ['a modal', () => (router.R.modal = 'login'), () => (router.R.modal = null)],
    ['an open sheet', () => router.openSheet('sortfilter'), () => router.closeSheet()],
    ['a pushed route (not a tab root)', () => deeper(), () => (router.R.stacks = { ...router.R.stacks, home: router.R.stacks.home.slice(0, 1) })],
    ['a focused <input>', () => focus('input'), () => document.activeElement.blur()],
    ['a focused <textarea>', () => focus('textarea'), () => document.activeElement.blur()],
    ['a focused contenteditable', () => focus('div', true), () => document.activeElement.blur()],
    ['a running offline download', () => (OFF.list = [{ id: 'a', state: 'done' }, { id: 'b', state: 'downloading' }]), () => (OFF.list[1].state = 'paused')],
    ['a hidden page', () => vis.quiet('hidden'), () => vis.quiet('visible')]
  ];
  function focus(tag, editable) {
    const el = document.createElement(tag);
    if (editable) {
      el.contentEditable = 'true';
      el.tabIndex = 0;
      // happy-dom has no isContentEditable getter
      if (!('isContentEditable' in el) || !el.isContentEditable) Object.defineProperty(el, 'isContentEditable', { get: () => true });
    }
    document.body.append(el);
    el.focus();
    expect(document.activeElement).toBe(el);
  }

  it.each(blockers)('not with %s: rechecked every 10 s, applied once it is gone', async (_, block, unblock) => {
    await boot();
    sw.takeOver();
    block();
    await clock.tick(IDLE * 3);
    expect(reload).not.toHaveBeenCalled();
    unblock();
    await clock.tick(RECHECK);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a focused button is fine (only text entry blocks)', async () => {
    await boot();
    const b = document.createElement('button');
    document.body.append(b);
    b.focus();
    sw.takeOver();
    await clock.tick(IDLE);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('done / queued / paused downloads do not block it', async () => {
    await boot();
    OFF.list = [{ id: 'a', state: 'done' }, { id: 'b', state: 'queued' }, { id: 'c', state: 'paused' }, { id: 'd', state: 'error' }];
    sw.takeOver();
    await clock.tick(IDLE);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('looking for updates', () => {
  it('registers /sw.js on load, then asks for an update on every return to the foreground while nothing is pending', async () => {
    await boot();
    expect(sw.register).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('load'));
    await clock.flush();
    expect(sw.register).toHaveBeenCalledWith('/sw.js');
    expect(sw.updates).toBe(0);
    router.S.screen = 'player';   // so hiding doesn't apply anything below
    vis.hide();
    expect(sw.updates).toBe(0);   // not on the way down
    vis.show();
    expect(sw.updates).toBe(1);
    // a failed check (offline) is swallowed, not left as an unhandled rejection
    const unhandled = [];
    const onUnhandled = (r) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      sw.updateFails = true;
      vis.hide();
      vis.show();
      expect(sw.updates).toBe(2);
      for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    sw.takeOver();
    vis.hide();
    vis.show();
    expect(sw.updates).toBe(2);   // already have one waiting
  });

  it('a failed registration is swallowed', async () => {
    await boot();
    sw.registerFails = true;
    window.dispatchEvent(new Event('load'));
    await clock.flush();
    expect(sw.register).toHaveBeenCalledTimes(1);
  });
});
