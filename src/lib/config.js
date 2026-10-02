/* Persisted client config. Kept as a plain mutable object (not $state) — it is
 * read by non-component code and written rarely, always followed by saveCfg(). */

/* Every storage access is guarded. This module is evaluated before anything
 * renders, so a throwing localStorage (storage disabled, a corrupted profile,
 * quota exhausted) used to take the whole bundle down at import time — a splash
 * over nothing, with no way on. Now a read failure boots with defaults (→ the
 * login screen) and a write failure keeps the in-memory config for the session,
 * so a sign-in still works until the app is closed. */
function get(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

function set(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* in-memory cfg still carries it for this session */
  }
}

/* The iPhone PWA (phone/, `__PHONE__` defined true by phone/vite.config.js) is
 * served from the same origin as Jellyfin (/jf) and reel-api (/ml) — see
 * docs/ios/ARCHITECTURE.md. The typeof guard keeps a build without the define
 * working (it then behaves as the TV). */
const PHONE = typeof __PHONE__ !== 'undefined' && __PHONE__;

/* TV defaults come from the build: VITE_JELLYFIN_URL / VITE_MEDIALIB_URL in a
 * gitignored .env.local (see .env.example). Without them the login screen asks
 * for the server, and reel-api is assumed on the Jellyfin host at :8790. */
const ENV_SERVER = import.meta.env.VITE_JELLYFIN_URL || '';
const ENV_MEDIALIB = import.meta.env.VITE_MEDIALIB_URL || '';

function medialibFor(server) {
  try {
    const u = new URL(server);
    return u.protocol + '//' + u.hostname + ':8790';
  } catch {
    return '';
  }
}

let medialib = get('reel.medialib') || (PHONE ? location.origin + '/ml' : ENV_MEDIALIB);

export const cfg = {
  server: get('reel.server') || (PHONE ? location.origin + '/jf' : ENV_SERVER),
  token: get('reel.token') || '',
  userId: get('reel.userId') || '',
  userName: get('reel.userName') || '',
  deviceId: get('reel.deviceId') || '',
  /* Base URL of reel-api — lookup/add, the download activity feed, metadata
   * and the rest (see src/lib/medialib.js). Follows the Jellyfin host unless
   * configured explicitly. */
  get medialib() {
    return medialib || medialibFor(this.server);
  },
  set medialib(v) {
    medialib = v;
  }
};

if (!cfg.deviceId) {
  cfg.deviceId = (PHONE ? 'reelphone-' : 'reel-') + Math.random().toString(36).slice(2) + Date.now().toString(36);
  set('reel.deviceId', cfg.deviceId);
}

export function saveCfg() {
  set('reel.server', cfg.server);
  set('reel.token', cfg.token);
  set('reel.userId', cfg.userId);
  set('reel.userName', cfg.userName);
  if (medialib) set('reel.medialib', medialib);
}
