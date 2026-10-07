/* PWA shell fakes: navigator.serviceWorker, document visibility, and the
 * listeners a module's init*() hangs on window/document.
 *
 *   const sw = installServiceWorker({ controlled: true });  // navigator.serviceWorker
 *   sw.takeOver()          // a new worker claims the page: fires 'controllerchange'
 *   sw.updates             // how often reg.update() was called (reg = what register('/sw.js') resolves to)
 *   sw.updateFails = true  // the next reg.update() rejects — a plain promise, not a vi.fn()'s:
 *                          // vitest marks a spy's returned promise handled, which would hide
 *                          // an unhandled rejection from a test that looks for one
 *   sw.register            // vi.fn(); sw.registerFails = true rejects it
 *
 *   const vis = visibility();     // document.visibilityState / .hidden, 'visible' to start
 *   vis.hide(); vis.show();       // set + dispatch 'visibilitychange' on document
 *
 *   const live = captureListeners();   // from now on, window/document listeners are recorded
 *   initUpdates();
 *   live.stop();                        // stop recording (the listeners stay)
 *   live.types(window)                  // ['pointerdown', 'keydown', …]
 *
 * Everything is undone when the test finishes (onTestFinished): the recorded
 * listeners are removed, so an old module graph's handlers never see a later
 * test's events; navigator.serviceWorker and the visibility getters go away. */
import { vi, onTestFinished } from 'vitest';

export function installServiceWorker({ controlled = true } = {}) {
  const target = new EventTarget();
  const sw = {
    registerFails: false,
    updateFails: false,
    updates: 0,
    reg: {
      update() {
        sw.updates++;
        if (!sw.updateFails) return Promise.resolve();
        sw.updateFails = false;
        return Promise.reject(new TypeError('update check failed'));
      }
    },
    register: null,
    controller: controlled ? { state: 'activated', scriptURL: '/sw.js' } : null,
    takeOver() {
      sw.controller = { state: 'activated', scriptURL: '/sw.js?new' };
      target.dispatchEvent(new Event('controllerchange'));
    }
  };
  sw.register = vi.fn(async () => {
    if (sw.registerFails) throw new TypeError('register failed');
    return sw.reg;
  });
  const api = {
    get controller() {
      return sw.controller;
    },
    register: (...a) => sw.register(...a),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target)
  };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: api });
  onTestFinished(() => {
    delete navigator.serviceWorker;
  });
  return sw;
}

export function visibility(start = 'visible') {
  let state = start;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
  onTestFinished(() => {
    delete document.visibilityState;
    delete document.hidden;
  });
  const set = (s) => {
    state = s;
    document.dispatchEvent(new Event('visibilitychange'));
  };
  return {
    get state() {
      return state;
    },
    hide: () => set('hidden'),
    show: () => set('visible'),
    /** change the state without an event */
    quiet: (s) => {
      state = s;
    }
  };
}

export function captureListeners(targets = [window, document]) {
  const added = [];
  const spies = targets.map((t) => {
    const orig = t.addEventListener.bind(t);
    const spy = vi.spyOn(t, 'addEventListener').mockImplementation((type, fn, o) => {
      added.push([t, type, fn, o]);
      return orig(type, fn, o);
    });
    return spy;
  });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const s of spies) s.mockRestore();
  };
  onTestFinished(() => {
    stop();
    for (const [t, type, fn, o] of added) t.removeEventListener(type, fn, o);
    added.length = 0;
  });
  return {
    added,
    stop,
    types: (t) => added.filter(([x]) => x === t).map(([, type]) => type)
  };
}
