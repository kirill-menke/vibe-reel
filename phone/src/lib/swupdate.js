/* Service-worker updates, applied where nobody sees them (PWA-06).
 *
 * sw.js skips waiting and claims open pages, so a new build takes over on its
 * own: `controllerchange`. The page that was already open still runs the old
 * bundle — safe (one hashed bundle, already in memory; fonts and icons keep
 * their paths across builds) — so there is no hurry to reload, and reloading
 * at once did it seconds after the user came back and started tapping: the
 * page blanked and fell back to Home under their finger. Instead:
 *
 *   - the update is only *noted* (`pending`);
 *   - it is applied on the next trip to the background (visibilitychange →
 *     hidden): the app switcher's snapshot covers the reload and the user
 *     comes back to the new build;
 *   - fallback for someone who never leaves the app: at a tab root, no sheet,
 *     no modal, nothing focused, no offline download running, and ≥ 60 s
 *     without a touch/key/scroll;
 *   - never under the player or Login (either path waits for them to close).
 *
 * No "new version" prompt: native apps update silently. The very first
 * install claiming an uncontrolled page is not an update (`hadController`).
 * Updates are looked for on every return to the foreground, since iOS rarely
 * restarts a home-screen app.
 *
 * PWA-05 (state restore, wave 2) hooks in through onBeforeUpdateReload(): it
 * saves the route before the reload, and `updateReloading()` tells its
 * pagehide handler to keep that snapshot. */
import { S, R, stack } from './router.svelte.js';
import { OFF } from './offline.svelte.js';

const IDLE_MS = 60000;
const RECHECK_MS = 10000;

let pending = false;
let reloading = false;
let lastInput = Date.now();
let idleTimer = 0;
const hooks = [];

/* PWA-05: run right before an update reload (keep them quick and sync). */
export function onBeforeUpdateReload(fn) {
  hooks.push(fn);
}

export function updateReloading() {
  return reloading;
}

/* Not under the player or Login — both hold state a reload would throw away
 * (the film's position is saved, but the user is watching; typed credentials). */
function blocked() {
  return S.screen === 'player' || S.screen === 'login' || R.modal != null;
}

/* The idle fallback asks more: the user must be somewhere a reload costs
 * nothing — a tab root, nothing open, nothing typed, no download in flight. */
function idleSafe() {
  if (blocked() || R.sheet) return false;
  if (document.visibilityState !== 'visible') return false;
  if ((stack() || []).length > 1) return false;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return false;
  if (OFF.list.some((e) => e.state === 'downloading')) return false;
  return Date.now() - lastInput >= IDLE_MS;
}

function reload(why) {
  if (reloading) return;
  reloading = true;
  clearTimeout(idleTimer);
  for (const fn of hooks) {
    try {
      fn(why);
    } catch {
      /* a failed save must not keep the old build running */
    }
  }
  location.reload();
}

function scheduleIdle() {
  clearTimeout(idleTimer);
  if (!pending || reloading) return;
  const wait = Math.max(RECHECK_MS, IDLE_MS - (Date.now() - lastInput));
  idleTimer = setTimeout(() => {
    if (idleSafe()) reload('idle');
    else scheduleIdle();
  }, wait);
}

function onHidden() {
  if (pending && !blocked()) reload('hidden');
}

export function initUpdates() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || pending) return;
    pending = true;
    // installed while we were already away (the check runs on the way back
    // up, and the user may have left again before it finished): apply now
    if (document.visibilityState === 'hidden') onHidden();
    else scheduleIdle();
  });
  // any input resets the idle clock; passive + capture so nothing is delayed
  // (the listeners exist from the start but only store a timestamp)
  const touch = () => {
    lastInput = Date.now();
  };
  for (const t of ['pointerdown', 'keydown', 'wheel', 'scroll']) addEventListener(t, touch, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onHidden();
    else {
      lastInput = Date.now(); // coming back counts as activity
      scheduleIdle();
    }
  });
  addEventListener('load', () =>
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible' && !pending) reg.update().catch(() => {});
        });
      })
      .catch(() => {})
  );
}
