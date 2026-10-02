/* Recovering a browse screen after the network comes back.
 *
 * A Wi-Fi drop while browsing (or a NAS reboot) leaves error cards —
 * LoadError, Home's and Library's failcards — that used to sit there until
 * someone pressed Retry, even long after the server was reachable again.
 * onReconnect(fn) calls fn when it is worth trying again:
 *   'online'  — the browser saw the network return (settle delay: DHCP/DNS),
 *   'visible' — the app came back from being parked (fn gets the hidden ms),
 *   'tick'    — optional slow timer (`every` ms), for a server that was down
 *               while the network itself never went away.
 * Never while the page is hidden, and never during playback: a screen parked
 * under the video must not refetch or move focus behind it.
 * Returns the unsubscribe (hand it straight to onMount / $effect). */
import { S } from './nav.svelte.js';

const subs = new Set();
let bound = false;
let hiddenAt = 0;

function quiet() {
  return document.visibilityState === 'hidden' || S.screen === 'player';
}

function fire(why, arg) {
  if (quiet()) return;
  for (const s of [...subs]) {
    if (!subs.has(s)) continue;
    try {
      const r = s.fn(why, arg);
      r?.catch?.(() => {});
    } catch {
      /* one subscriber must not stop the others */
    }
  }
}

function bind() {
  bound = true;
  window.addEventListener('online', () => setTimeout(() => fire('online'), 1500));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else {
      const away = hiddenAt ? Date.now() - hiddenAt : 0;
      // after lifecycle.js's own resume handling (focus repair)
      setTimeout(() => fire('visible', away), 1000);
    }
  });
}

export function onReconnect(fn, { every = 0 } = {}) {
  if (!bound) bind();
  const s = { fn };
  subs.add(s);
  const t = every ? setInterval(() => !quiet() && fire1(s), every) : 0;
  return () => {
    subs.delete(s);
    if (t) clearInterval(t);
  };
}

function fire1(s) {
  try {
    s.fn('tick')?.catch?.(() => {});
  } catch {
    /* ignore */
  }
}
