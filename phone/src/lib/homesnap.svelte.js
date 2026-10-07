/* Home snapshot — Home opens on what it showed last, online or off (polish
 * HOME-03 + PWA-07).
 *
 * After a live load (and after a background change is applied) Home saves its
 * Jellyfin rail answers — the api.js SWR store entries for its four paths,
 * trimmed to what the tiles and the hero read — plus the two Trending lists to
 * localStorage['reel.homeSnap.<userId>']. At the next start Home seeds the store
 * from it (api.js seedStore) and paints synchronously, before the first frame;
 * the live answers then replace it in place. Offline the snapshot stays up
 * under the banner ("Showing what was loaded last").
 *
 *   seedHome(paths)        → { trend } | null: seeds the store for these paths
 *                            from the snapshot (≤ 14 days old)
 *   saveHome(paths, trend) debounced (1.5 s) write
 *   homeSnap.shown         Home has painted content this session (live or from
 *                          the snapshot) — the offline banner's copy
 *
 * A snapshot item has no MediaSources: nothing may play from it. Home waits
 * for the live answer before a Continue Watching / Next Up start.
 * Snapshots of accounts no longer in `reel.accounts` are dropped when this
 * module loads — at boot, since screens/index.js imports Home — so a sign-out
 * (which forgets the account and reloads the app) leaves none behind. */
import { cfg } from '$lib/config.js';
import { seedStore, storeEntries } from '$lib/api.js';
import { accounts } from '$lib/account.svelte.js';

const PREFIX = 'reel.homeSnap.';
const V = 1;
const MAX_AGE = 14 * 24 * 3600 * 1000;
const CAP = 300 * 1024; // chars; a normal Home is ~25–40 KB trimmed
const DEBOUNCE = 1500; // iOS Safari has no requestIdleCallback

/** @type {VR.HomeSnapState} */
export const homeSnap = $state({ shown: false });

/** @type {Array<keyof Jf.BaseItemDto>} */
const KEEP = [
  'Id', 'Name', 'Type', 'SeriesId', 'SeriesName', 'IndexNumber', 'ParentIndexNumber', 'RunTimeTicks',
  'ProductionYear', 'PremiereDate', 'Genres', 'ProviderIds', 'ImageTags', 'BackdropImageTags',
  'ParentBackdropItemId', 'ParentBackdropImageTags', 'ParentThumbItemId', 'ParentThumbImageTag',
  'SeriesPrimaryImageTag'
];
/** @type {Array<keyof Jf.UserItemData>} */
const UD = ['PlaybackPositionTicks', 'PlayedPercentage', 'Played', 'UnplayedItemCount', 'LastPlayedDate'];
/** @type {Array<keyof Jf.ImageBlurHashes>} */
const HASH_TYPES = ['Primary', 'Backdrop', 'Thumb'];

/** @param {Jf.BaseItemDto} it @returns {Partial<Jf.BaseItemDto>} */
function trimItem(it) {
  /** @type {Record<string, any>} */
  const o = {};
  for (const k of KEEP) if (it[k] != null) o[k] = it[k];
  if (it.UserData) {
    o.UserData = {};
    for (const k of UD) if (it.UserData[k] != null) o.UserData[k] = it.UserData[k];
  }
  if (it.ImageBlurHashes) {
    o.ImageBlurHashes = {};
    for (const k of HASH_TYPES) if (it.ImageBlurHashes[k]) o.ImageBlurHashes[k] = it.ImageBlurHashes[k];
  }
  return o;
}
/** @type {(d: any) => any} a store entry's data: an item array, a QueryResult, or anything else as-is */
const trimData = (d) => (Array.isArray(d) ? d.map(trimItem) : d && Array.isArray(d.Items) ? { Items: d.Items.map(trimItem) } : d);

/** @type {(k: string) => string | null} */
const get = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
/** @type {(k: string) => void} */
const del = (k) => {
  try {
    localStorage.removeItem(k);
  } catch {}
};

/* signed-out accounts leave no snapshot behind */
try {
  const keep = new Set(accounts.list.map((a) => a.userId));
  if (cfg.userId) keep.add(cfg.userId);
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith(PREFIX) && !keep.has(k.slice(PREFIX.length))) del(k);
  }
} catch {}

/** @param {string[]} paths @returns {{ trend: VR.HomeTrend } | null} */
export function seedHome(paths) {
  if (!cfg.userId) return null;
  /** @type {VR.HomeSnapshot | null} */
  let s = null;
  try {
    s = JSON.parse(get(PREFIX + cfg.userId) || 'null');
  } catch {}
  if (!s || s.v !== V || !Array.isArray(s.entries) || Date.now() - s.at > MAX_AGE) return null;
  const want = new Set(paths);
  const entries = s.entries.filter((e) => Array.isArray(e) && want.has(e[0]));
  if (!entries.length) return null;
  seedStore(entries);
  return { trend: s.trend || {} };
}

/** @type {ReturnType<typeof setTimeout> | 0} */
let timer = 0;
/** @param {string[]} paths @param {Partial<Record<Reel.MediaType, Reel.TrendingItem[] | null | undefined>> | null} [trend]
 * (a rail not loaded yet is null/undefined: only arrays are kept) */
export function saveHome(paths, trend) {
  const uid = cfg.userId;
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (!uid || uid !== cfg.userId) return;
    const entries = storeEntries(paths).map(/** @returns {[string, VR.StoreEntry]} */ ([p, e]) => [p, { at: e.at, data: trimData(e.data) }]);
    if (!entries.length) return;
    /** @type {VR.HomeTrend} */
    const t = {};
    for (const k of /** @type {Reel.MediaType[]} */ (['tv', 'movie'])) if (Array.isArray(trend?.[k])) t[k] = /** @type {Reel.TrendingItem[]} */ (trend[k]);
    let json = JSON.stringify({ v: V, at: Date.now(), entries, trend: t });
    if (json.length > CAP) json = JSON.stringify({ v: V, at: Date.now(), entries }); // trending goes first
    if (json.length > CAP) return;
    try {
      localStorage.setItem(PREFIX + uid, json);
    } catch {
      /* quota: the next launch paints from the network, as before */
    }
  }, DEBOUNCE);
}
