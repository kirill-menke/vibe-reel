/* Phone replacement for src/lib/lifecycle.js (swapped in by
 * phone/vite.config.js; main.js calls initLifecycle() before mounting).
 *
 * Going to the background does NOT end playback on the phone (a glance at a
 * message must not throw you out of the film): the video is paused — the
 * engine's onpause sends the paused Progress report, so the resume point is
 * saved even if iOS later kills the frozen app without another event — and the
 * player stays up; coming back shows it paused with the controls visible.
 * An offline copy (no Progress reports) checkpoints its position into the
 * download index instead (checkpointFeed).
 * Only `pagehide` (the app being closed) ends playback properly
 * (suspendPlayback() → exitPlayer(): Stopped goes out with keepalive).
 * Picture in Picture and AirPlay keep playing: there the page is hidden
 * *because* the user is still watching.
 *
 * On the way back up after a real absence, check the server (offline banner)
 * and the token (a 401 goes through api.js's onAuthLost → App.svelte). The
 * screens' own retry-on-resume is reconnect.js's 'visible' event. */
import { S } from './nav.svelte.js';
import { suspendPlayback, showOsd, checkpointFeed } from '$lib/player.svelte.js';
import { api } from '$lib/api.js';
import { cfg } from '$lib/config.js';
import { checkServer } from './conn.svelte.js';
import { saveRoute, closeRoute, routeResumed } from './restore.svelte.js';

const REVALIDATE_AFTER = 60000;
let hiddenAt = 0;

function stillWatching() {
  const v = document.querySelector('video');
  if (!v) return false;
  try {
    if (document.pictureInPictureElement === v) return true;
    if (v.webkitPresentationMode === 'picture-in-picture') return true;
    if (v.webkitCurrentPlaybackTargetIsWireless) return true;
  } catch {
    /* older WebKit: no such property */
  }
  return false;
}

/* Going to the home screen with a video playing hands it to automatic Picture
 * in Picture (`autopictureinpicture` on the element), and WebKit may switch the
 * presentation mode only after visibilitychange — so look again a moment later
 * before pausing. Locking the phone never enters PiP: that still pauses (and the
 * engine's onpause reports the position). */
let pauseTimer = 0;

function onHidden() {
  hiddenAt = Date.now();
  clearTimeout(pauseTimer);
  // where we are, in case iOS evicts the frozen app (PWA-05, restore.svelte.js)
  saveRoute();
  // An offline copy reports nothing to Jellyfin, so its position lives only in
  // offline.svelte.js's index: write it now — iOS may kill the frozen app
  // (even out of PiP) without another event. The pause below saves it again.
  if (S.screen === 'player') checkpointFeed();
  if (S.screen !== 'player' || stillWatching()) return;
  pauseTimer = setTimeout(() => {
    if (!document.hidden || S.screen !== 'player' || stillWatching()) return;
    const v = document.querySelector('video');
    if (v && !v.paused) {
      try {
        v.pause(); // → the engine's onpause → reportProgress(true)
      } catch {
        /* nothing to pause */
      }
    }
  }, 700);
}

function onVisible() {
  clearTimeout(pauseTimer);
  routeResumed();
  const away = hiddenAt ? Date.now() - hiddenAt : 0;
  hiddenAt = 0;
  if (S.screen === 'player') showOsd(); // paused on the way down: controls up
  if (away < REVALIDATE_AFTER || S.screen === 'boot' || S.screen === 'login') return;
  checkServer();
  if (cfg.token && cfg.userId) api('/Users/' + cfg.userId).catch(() => {});
}

export function initLifecycle() {
  /* A poster that fails shows the tile's placeholder instead of the engine's
   * broken-image glyph (same as the TV); Art.svelte also handles its own. */
  document.addEventListener('error', (e) => { if (e.target instanceof HTMLImageElement) e.target.classList.add('imgfail'); }, true);
  document.addEventListener('load', (e) => { if (e.target instanceof HTMLImageElement) e.target.classList.remove('imgfail'); }, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onHidden();
    else onVisible();
  });
  /* The app is closed (swiped away): a native app starts fresh after that, so
   * the saved route is marked closed — except for an update reload, which
   * must come back to the same page (closeRoute checks updateReloading()). */
  window.addEventListener('pagehide', (e) => {
    closeRoute(e);
    if (S.screen === 'player') suspendPlayback();
  });
  // back from the bfcache (the trailer fallback's trip to YouTube): a resume
  window.addEventListener('pageshow', (e) => e.persisted && routeResumed());
}
