import { cfg } from './config.js';

/* ---- "Remove from Continue Watching / Next Up" (hold OK on a Home tile) ----
 * Jellyfin 12.1 has no non-destructive way to drop an item from either list:
 * UserData carries no HideFromResume flag, and the only server-side routes out
 * are resetting the resume position (Continue Watching) or marking episodes
 * played / backdating LastPlayedDate (Next Up) — all of which rewrite watch
 * history. So the hide list is local, per account (localStorage keyed by user
 * id), and conditional, so the tile comes back when there is something new:
 *
 *   cw: itemId → the UserData stamp at hide time (LastPlayedDate, else the
 *       position). Playing the item again (here or on another client) moves
 *       the stamp, and it reappears.
 *   nu: seriesId → the episode id hidden. Once the series' next episode is a
 *       different one (you watched on, or a new episode aired), it reappears.
 */
const KEY = 'reel.homeHidden.';
const MAX = 300;   // per list; oldest dropped first (insertion order)

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY + cfg.userId) || 'null');
    if (v && typeof v === 'object') return { cw: v.cw || {}, nu: v.nu || {} };
  } catch {}
  return { cw: {}, nu: {} };
}

function save(h) {
  for (const k of ['cw', 'nu']) {
    const ks = Object.keys(h[k]);
    for (let i = 0; i < ks.length - MAX; i++) delete h[k][ks[i]];
  }
  try {
    localStorage.setItem(KEY + cfg.userId, JSON.stringify(h));
  } catch {}
}

function cwStamp(it) {
  const ud = it.UserData || {};
  return String(ud.LastPlayedDate || ud.PlaybackPositionTicks || 0);
}

const nuKey = (it) => it.SeriesId || it.Id;

/* A filter for one paint: reads storage once. */
export function hiddenFilter() {
  const h = load();
  return {
    cw: (it) => h.cw[it.Id] === cwStamp(it),
    nu: (it) => h.nu[nuKey(it)] === it.Id
  };
}

/* kind: 'cw' | 'nextup'. Returns the undo. */
export function hideFromHome(kind, it) {
  const h = load();
  if (kind === 'cw') h.cw[it.Id] = cwStamp(it);
  else h.nu[nuKey(it)] = it.Id;
  save(h);
  return () => {
    const u = load();
    if (kind === 'cw') delete u.cw[it.Id];
    else delete u.nu[nuKey(it)];
    save(u);
  };
}
