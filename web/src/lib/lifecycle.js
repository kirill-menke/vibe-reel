/* Web replacement for src/lib/lifecycle.js (swapped in by web/vite.config.js;
 * main.js calls initLifecycle() before mounting).
 *
 * A desktop tab is not an app that gets frozen: going to another tab or window
 * leaves a playing video alone (you may be listening, or watching on a second
 * screen). Only `pagehide` — the tab closed, reloaded or navigated away — ends
 * playback properly (suspendPlayback() → exitPlayer(): Stopped goes out with
 * keepalive, so the resume point is saved).
 *
 * Back after a real absence: check the server (offline banner) and the token
 * (a 401 goes through api.js's onAuthLost → App.svelte). The screens' own
 * retry-on-resume is reconnect.js's 'visible' event. */
import { S } from '$lib/nav.svelte.js';
import { suspendPlayback } from '$lib/player.svelte.js';
import { api } from '$lib/api.js';
import { cfg } from '$lib/config.js';
import { checkServer } from '$p/lib/conn.svelte.js';

const REVALIDATE_AFTER = 60000;
let hiddenAt = 0;

export function initLifecycle() {
  /* a poster that fails shows the tile's placeholder, not the broken-image glyph */
  document.addEventListener('error', (e) => { if (e.target instanceof HTMLImageElement) e.target.classList.add('imgfail'); }, true);
  document.addEventListener('load', (e) => { if (e.target instanceof HTMLImageElement) e.target.classList.remove('imgfail'); }, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    if (away < REVALIDATE_AFTER || S.screen === 'boot' || S.screen === 'login') return;
    checkServer();
    if (cfg.token && cfg.userId) api('/Users/' + cfg.userId).catch(() => {});
  });
  window.addEventListener('pagehide', () => {
    if (S.screen === 'player') suspendPlayback();
  });
}
