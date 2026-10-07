/* App icon badge (PWA-08): the bell's count on the Home Screen icon — "Ready to
 * watch" titles not yet seen, plus unseen new seasons only when this device
 * asked for season pushes (else the badge would just echo a list nobody is
 * notified about). Opening the bell marks both seen → the badge clears.
 *
 * iOS (16.4+) shows a badge only for a Home Screen web app with notification
 * permission granted; without it setAppBadge is a no-op, so this is guarded by
 * that and costs nothing for everyone else.
 *
 * sw.js bumps the badge by one on every push while the app sleeps; it reads the
 * count last set here from Cache Storage (`vr-badge`, same key there). The next
 * foreground sets the true count again. A push that arrives while the app is
 * open posts `vr-changed`, and the count is re-applied at once — the SW's
 * optimistic +1 would otherwise stay until the landed feed catches up.
 *
 * Driven from main.js (initBadge), so App.svelte needs no call site. */
import { unseenLanded } from '$lib/landed.svelte.js';
import { unreadCount } from '$lib/news.svelte.js';
import { pushPrefs } from './push.js';

const CACHE = 'vr-badge';
const KEY = '/__badge';

let last = -1;

function allowed() {
  return 'setAppBadge' in navigator && 'Notification' in window && Notification.permission === 'granted';
}

function count() {
  return unseenLanded() + (pushPrefs().seasons ? unreadCount() : 0);
}

/** @param {number} n @param {boolean} [force] */
function apply(n, force = false) {
  if (!allowed() || (n === last && !force)) return;
  last = n;
  const p = n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge();
  Promise.resolve(p).catch(() => {});
  if ('caches' in window) store(String(n));
}

/* Every return to the foreground re-applies the count, and it almost never
 * changed: read the stored value and write only on a difference (a put is a
 * disk write). Compared against the cache, not `last` — sw.js bumps the stored
 * count itself on a push while the app sleeps. */
/** @param {string} v */
function store(v) {
  caches
    .open(CACHE)
    .then(async (c) => {
      const r = await c.match(KEY);
      if (r && (await r.text()) === v) return;
      await c.put(KEY, new Response(v));
    })
    .catch(() => {});
}

export function initBadge() {
  $effect.root(() => {
    $effect(() => {
      apply(count());
    });
  });
  // the SW may have bumped it while we were away (or while open): set the truth
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') apply(count(), true);
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'vr-changed') apply(count(), true);
    });
  }
}
