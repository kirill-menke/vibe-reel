import { mount } from 'svelte';
import './styles/tokens.css';
import './styles/components.css';
import './styles/app.css';
import './styles/home.css';
import './styles/library.css';
import './styles/detail.css';
import './styles/player.css';
import './styles/offline.css';
import './styles/zoom.css';
import App from './App.svelte';
import { initLifecycle } from './lib/lifecycle.js';
import { initPushLinks, syncPush } from './lib/push.js';
import { initUpdates } from './lib/swupdate.js';
import { initBadge } from './lib/badge.svelte.js';
import { initOffline } from './lib/offline.svelte.js';
import { initViewport } from './lib/viewport.js';
import { initPress } from './lib/press.js';
import { restoreRoute } from './lib/restore.svelte.js';
import './lib/playclose.svelte.js'; // for its effect: a trailer's close doesn't bump R.playerClosed

/* Dev only: /?devlogin signs in with the TV account served by the dev
 * server's /__devcreds (phone/vite.config.js) and reloads. Tree-shaken from
 * builds. */
if (import.meta.env.DEV && new URLSearchParams(location.search).has('devlogin')) {
  const { devLogin } = await import('./lib/devlogin.js');
  await devLogin();
}

initLifecycle();
restoreRoute();    // back where the user was after an eviction / update reload (PWA-05) — before the
                   // first mount, and before initPushLinks() strips a ?open= deep link (which wins)
initPushLinks();   // notification taps: /?open=… and messages from sw.js
initOffline();     // offline downloads: resume them, sync positions watched offline
initViewport();    // pan back to 0,0 when the keyboard leaves the viewport shifted

initPress();       // press feedback: delayed, scroll-safe `.pressing` (replaces :active)

/* No pinch / double-tap zoom of the shell (PWA-04). app.css's
 * `touch-action: pan-x pan-y` on the root does the work; WebKit's own gesture
 * events are the belt-and-braces. The player's pinch (fit ↔ fill) reads touch
 * events, which cancelling these doesn't touch. */
for (const t of ['gesturestart', 'gesturechange']) document.addEventListener(t, (e) => e.preventDefault(), { passive: false });

/* Service worker: register, look for a new build on every return to the
 * foreground, and apply it only where nobody sees the reload — on the next
 * trip to the background, or after a minute idle at a tab root (PWA-06,
 * lib/swupdate.js). */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  initUpdates();
  // notifications: keep this device's push subscription current (push.js)
  navigator.serviceWorker.ready.then(() => setTimeout(syncPush, 3000));
}
initBadge();       // the bell's count on the app icon (PWA-08; no-op without notification permission)

export default mount(App, { target: document.getElementById('app') });
