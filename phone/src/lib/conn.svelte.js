/* Server reachability, for the offline banner (OfflineBanner.svelte).
 *
 *   conn.offline    true while the last check (or the browser) says the
 *                   Jellyfin server can't be reached
 *   conn.checking   a check is in flight (the banner's Retry shows it)
 *   checkServer()   ping /System/Info/Public (no auth, 6 s deadline) → Promise<bool reachable>
 *   noteError(e)    hand any failed api() error here: a network-level failure
 *                   (or a 5xx from the proxy) triggers a check, so one failed
 *                   screen fetch raises the banner for the whole app.
 *
 * App.svelte re-checks every 20 s while offline and on reconnect.js events. */
import { cfg } from '$lib/config.js';

export const conn = $state({ offline: false, checking: false });

let inflight = null;

export function checkServer() {
  if (inflight) return inflight;
  conn.checking = true;
  inflight = fetch(cfg.server + '/System/Info/Public', { signal: AbortSignal.timeout(6000), cache: 'no-store' })
    .then((r) => r.ok || r.status < 500)
    .catch(() => false)
    .then((ok) => {
      conn.offline = !ok;
      return ok;
    })
    .finally(() => {
      conn.checking = false;
      inflight = null;
    });
  return inflight;
}

export function noteError(e) {
  if (e && (e.network || e.status >= 502)) checkServer();
}

if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => (conn.offline = true));
  window.addEventListener('online', () => setTimeout(checkServer, 1500));
}
