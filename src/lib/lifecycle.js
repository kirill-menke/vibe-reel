/* webOS app lifecycle — why relaunching used to do nothing.
 *
 * The TV does not kill a "closed" app: it parks the webview in the background
 * and, when you pick the app again, raises a `webOSRelaunch` event instead of
 * loading the page afresh. appinfo.json declared `handlesRelaunch: true`, which
 * per LG's lifecycle guide means *the app* is responsible for coming forward —
 * the platform keeps it in the background until it calls `PalmSystem.activate()`.
 * Nothing here ever did, so picking VibeReel from the launcher appeared to
 * no-op, and the only way back in was force-closing the card (which forces a
 * cold launch → `webOSLaunch`).
 *
 * appinfo.json now says `handlesRelaunch: false`, so the platform brings us to
 * the foreground itself. This module is the belt to those braces: it still
 * activates explicitly (a no-op when the platform already did), and repairs the
 * two states a parked webview can come back in —
 *   · nothing focused (the D-pad scores its next move from
 *     `document.activeElement`, so a blank one makes the remote feel dead), and
 *   · a boot that never finished because its fetch was in flight when the app
 *     was frozen — nothing will ever complete it, so reload.
 * On the way *down* (hidden), a video in progress is stopped and reported to
 * Jellyfin — see suspendPlayback() in player.svelte.js (also on pagehide, i.e. a kill).
 *
 * The reload is deliberately hard to trigger: webOS can hand a *cold* launch a
 * hidden→visible transition while the first fetch is still in the air, and an
 * unguarded "boot didn't finish → reload" would be an infinite loop. It fires
 * only if the page has been alive well past any plausible boot, and at most once
 * a minute.
 *
 * NOTE: none of this is observable off-TV — `PalmSystem` does not exist in a
 * desktop browser, hence every access is guarded. */

import { S } from './nav.svelte.js';
import { focusFirst } from './focus.js';
import { suspendPlayback } from './player.svelte.js';
import { resetRefreshRate } from './refresh60.js';

const BOOT_STALL_MS = 15000;
const RELOAD_GAP_MS = 60000;
const RELOAD_KEY = 'reel.autoReloadAt';

function activate() {
  try {
    window.PalmSystem?.activate?.();
  } catch {
    /* not on webOS, or an older PalmSystem without activate() */
  }
}

function safeReload() {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0;
  } catch {
    /* storage disabled — fall through, the timestamp is only a loop guard */
  }
  if (Date.now() - last < RELOAD_GAP_MS) return;
  try {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
  location.reload();
}

function resume() {
  // performance.now() is age-since-load: a cold launch is nowhere near this.
  if (S.screen === 'boot' && performance.now() > BOOT_STALL_MS) {
    safeReload();
    return;
  }
  const a = document.activeElement;
  if (!a || a === document.body || a === document.documentElement) focusFirst();
}

export function initLifecycle() {
  resetRefreshRate(5000);   // after the splash: the last app's video may have left 50/48 Hz behind
  /* A poster/backdrop that fails (server unreachable, stale tag) would show the
   * engine's broken-image glyph in the corner of an empty tile. Hide it and let
   * the tile's placeholder background show; a later successful load (Retry, a
   * new src) brings it back. error/load don't bubble, so listen in capture. */
  document.addEventListener('error', (e) => { if (e.target instanceof HTMLImageElement) e.target.classList.add('imgfail'); }, true);
  document.addEventListener('load', (e) => { if (e.target instanceof HTMLImageElement) e.target.classList.remove('imgfail'); }, true);
  document.addEventListener(
    'webOSRelaunch',
    () => {
      activate();
      resume();
    },
    true
  );
  document.addEventListener('webOSLaunch', activate, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      resume();
      resetRefreshRate(1500);   // another app may have left the TV at 50/48 Hz
    } else suspendPlayback();
  });
  // Closing the card (or deploy.sh's closeByAppId) kills the page outright —
  // no visibilitychange, and Jellyfin would keep showing the session as
  // playing. The Stopped report is keepalive, so it survives the unload.
  window.addEventListener('pagehide', suspendPlayback);
}
