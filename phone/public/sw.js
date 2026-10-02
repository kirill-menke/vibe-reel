/* VibeReel Phone service worker.
 *
 * App shell = cache-first from a versioned cache: the build (phone/vite.config.js,
 * `sw-precache` plugin) rewrites VERSION and PRECACHE below with a hash and the
 * list of every file in dist (hashed JS/CSS, index.html, fonts, icons, manifest).
 * A new build ⇒ a new sw.js ⇒ install precaches the new shell, activate drops
 * the old cache. Jellyfin (/jf) and reel-api (/ml) are network-only: never
 * cached, never intercepted beyond passing through. */
const VERSION = 'dev';
const PRECACHE = [];
const CACHE = 'vibereel-shell-' + VERSION;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('vibereel-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (/^\/(jf|ml)(\/|$)/.test(url.pathname)) return; // network-only
  if (url.pathname === '/sw.js') return;
  // navigations get the cached shell (a SPA: every path is index.html)
  const key = req.mode === 'navigate' ? '/index.html' : url.pathname;
  e.respondWith(
    caches.open(CACHE).then((c) =>
      c.match(key).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok && res.type === 'basic' && req.mode !== 'navigate') c.put(key, res.clone());
            return res;
          })
      )
    )
  );
});

/* Web Push (reel-api push.py; subscribing: src/lib/push.js). The payload is
 * JSON { title, body, tag, open } — `open` says what a tap shows: an item
 * ({type:'item', id, itemType}), the bell ({type:'bell'}) or Home. iOS only
 * delivers pushes to the Home Screen app and requires every push to show a
 * notification (userVisibleOnly), so a malformed payload still shows one. */
self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { body: e.data ? e.data.text() : '' };
  }
  e.waitUntil(
    Promise.all([
      self.registration.showNotification(d.title || 'VibeReel', {
        body: d.body || '',
        tag: d.tag || undefined,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        data: { open: d.open || { type: 'home' } }
      }),
      // icon badge +1 first, then an open app refreshes its rails
      // (lib/freshness.svelte.js) and re-sets the true badge count (badge.svelte.js)
      bumpBadge().then(() =>
        self.clients
          .matchAll({ type: 'window' })
          .then((list) => list.forEach((c) => c.postMessage({ type: 'vr-changed' })))
          .catch(() => {})
      )
    ])
  );
});

/* App icon badge (PWA-08): the page stores the count it last set in Cache
 * Storage (`vr-badge`, src/lib/badge.svelte.js); a push while it sleeps adds
 * one. Never throws: a failed badge must not lose the notification. */
function bumpBadge() {
  if (!self.navigator || !self.navigator.setAppBadge) return Promise.resolve();
  return caches
    .open('vr-badge')
    .then((c) =>
      c
        .match('/__badge')
        .then((r) => (r ? r.text() : '0'))
        .then((t) => {
          const n = (parseInt(t, 10) || 0) + 1;
          return Promise.all([self.navigator.setAppBadge(n), c.put('/__badge', new Response(String(n)))]);
        })
    )
    .catch(() => {});
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const open = (e.notification.data && e.notification.data.open) || { type: 'home' };
  const q = open.type === 'item' && open.id ? (open.itemType || 'Movie') + ':' + open.id : open.type === 'bell' ? 'bell' : 'home';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const c = list.find((w) => new URL(w.url).origin === self.location.origin);
      if (c) {
        c.postMessage({ type: 'vr-open', open });
        return c.focus ? c.focus().catch(() => {}) : undefined;
      }
      return self.clients.openWindow('/?open=' + encodeURIComponent(q));
    })
  );
});
