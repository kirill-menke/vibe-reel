/* State shared by the Search overlay's result tiles and LookupDetail — the
 * screen a result opens when it isn't a Jellyfin item yet. Both show (and
 * change) the same "is this in the library" state, so it lives here rather than
 * in either component. */
import { api, itemsPath, errText } from './api.js';
import { mlLibraryAdd, mlLibraryUndo, mlMetadata, mlTrending } from './medialib.js';
import { providerId, pendingGroups, boostActivity } from './activity.svelte.js';
import { toast } from './toast.svelte.js';
import { openItem, openPending, openLookup } from './nav.svelte.js';

/* Per-result add state, keyed by lookupKey():
 *   'idle' | 'added' (already in library) | 'adding' | 'done' | 'error' */
export const adds = $state({});

/* Lookup ids are tvdb ids for shows and tmdb ids for movies — two id spaces,
 * so the same number can name one of each. */
export function lookupKey(item) {
  return item.type + ':' + item.id;
}

/* Seed from a fresh lookup's `added` flags. An add this session has in flight
 * (or just finished) wins over the flag, which may predate it. */
export function seedAdds(results) {
  for (const it of results) {
    const k = lookupKey(it);
    const cur = adds[k];
    if (cur === 'adding' || cur === 'done') continue;
    adds[k] = it.added ? 'added' : 'idle';
  }
}

export function addState(item) {
  return adds[lookupKey(item)] || (item.added ? 'added' : 'idle');
}

export function inLibrary(item) {
  const s = addState(item);
  return s === 'added' || s === 'done';
}

export async function addToLibrary(item) {
  const s = addState(item);
  if (s === 'adding' || s === 'added' || s === 'done') return; // no-op / already there
  adds[lookupKey(item)] = 'adding';
  try {
    const r = await mlLibraryAdd({ id: item.id, type: item.type });
    adds[lookupKey(item)] = 'done';
    // phone: the grab shows up queued within seconds — watch it at the fast rate
    if (__PHONE__) boostActivity();
    const msg = 'Added — “' + item.title + '” is downloading';
    // phone: the toast's Undo takes the add back (the TV has no undo here)
    if (__PHONE__ && r && r.undo) toast(msg, () => undoAdd(item, r.undo));
    else toast(msg);
  } catch (e) {
    if (e.status === 409 || e.code === 'already_added') {
      // Already present — treat as success, not an error.
      adds[lookupKey(item)] = 'added';
      toast('Already in your library — “' + item.title + '”');
    } else {
      adds[lookupKey(item)] = 'error';
      toast(e.retriable ? 'Library busy — try again in a moment' : 'Add failed: ' + errText(e));
      return;
    }
  }
  // Sonarr only lists a series' episodes once it is added — the cached
  // pre-add metadata has none, so drop it.
  mlMetadata.evict(item.type, item.id);
}

/* Phone: the add toast's Undo. The server takes the add back only while
 * nothing of the title is a library file yet (it never deletes one) and only
 * with the add's own token; it also cancels whatever the add's search grabbed.
 * The + button stays "done" while the request runs. */
export async function undoAdd(item, token) {
  const k = lookupKey(item);
  if (adds[k] !== 'done') return;
  try {
    await mlLibraryUndo({ id: item.id, type: item.type, undo: token });
    adds[k] = 'idle';
    mlMetadata.evict(item.type, item.id);
    boostActivity(); // its grabs leave the feed
    toast('Removed “' + item.title + '” again');
  } catch (e) {
    if (e.code === 'has_files' || e.code === 'importing') toast('“' + item.title + '” is already arriving — it stays in your library');
    else if (e.status === 410) toast('Too late to undo — “' + item.title + '” stays in your library');
    else toast('Couldn’t undo: ' + errText(e));
  }
}

/* The activity group (downloads in flight) for a lookup result, if any.
 * Reactive — call from $derived. */
export function lookupGroup(item) {
  return pendingGroups(item.type).find((g) => g.mediaId === item.id) || null;
}

/* The Jellyfin item for a lookup result that is already in the library, so OK
 * on it opens the real MovieDetail/SeriesDetail. The lookup id is the tvdb
 * (show) / tmdb (movie) id, which Jellyfin keeps in ProviderIds; a same-title,
 * same-year match stands in only when Jellyfin has no id of that kind. */
export async function findJellyfin(item) {
  const tv = item.type === 'tv';
  const r = await api(
    itemsPath({
      searchTerm: item.title,
      IncludeItemTypes: tv ? 'Series' : 'Movie',
      Recursive: true,
      Fields: 'ProviderIds,ProductionYear',
      Limit: 20
    })
  );
  const items = r.Items || [];
  const key = tv ? 'tvdb' : 'tmdb';
  const byId = items.find((it) => providerId(it, key) === String(item.id));
  if (byId) return byId;
  const name = item.title.toLowerCase();
  return (
    items.find(
      (it) =>
        !providerId(it, key) &&
        (it.Name || '').toLowerCase() === name &&
        (!item.year || !it.ProductionYear || it.ProductionYear === item.year)
    ) || null
  );
}

/* The open*() call for a lookup result, resolved to the most complete screen
 * that exists for it: the real MovieDetail/SeriesDetail once Jellyfin has the
 * title, PendingDetail while its first download is still in flight, and
 * otherwise LookupDetail — the same layout built from Sonarr/Radarr metadata,
 * with Add to library where Play would be. Shared by Search and Home's
 * trending rails, which wrap the call in their own way back. */
export async function lookupOpener(item) {
  if (inLibrary(item)) {
    const jf = await findJellyfin(item).catch(() => null);
    if (jf) return () => openItem(jf.Id, jf.Type);
    const g = lookupGroup(item);
    if (g) return () => openPending(g.key);
  }
  return () => openLookup(item);
}

/* Trending (Home's rails, and Search's empty state under the recent
 * queries): one list per type, kept for the session so neither screen pops
 * its rails in late on a remount. refreshTrending() revalidates — the server
 * caches for hours, so Home doing it once per mount is cheap — and a failure
 * keeps the last list. */
export const trending = $state({ tv: null, movie: null });
const trendReq = {};
const trendAt = {};

/* `maxAge` (ms): keep a list fetched that recently. Home used to refetch both
 * lists on every mount — two fetch() calls inside the Back-to-Home mount task,
 * and each fetch() call alone costs 3–9 ms of main thread on the TV (measured);
 * the server only recomputes them every 6 h anyway. */
export function refreshTrending(type, maxAge = 0) {
  if (trendReq[type]) return trendReq[type];
  if (maxAge && trending[type] && Date.now() - trendAt[type] < maxAge) return Promise.resolve(trending[type]);
  const p = mlTrending(type)
    .then((r) => {
      const results = r.results || [];
      seedAdds(results);
      trending[type] = results;
      trendAt[type] = Date.now();
      return results;
    })
    .finally(() => delete trendReq[type]);
  trendReq[type] = p;
  return p;
}

/* A Sonarr/Radarr fanart URL at a TV-sized rendition. TMDB serves `original`
 * (often 4K, several MB to fetch and decode) — w1280 is plenty under the hero
 * scrims. TVDB has no size between its original and a 640-wide `_t`, so its
 * originals stay. Every backdrop of a lookup title goes through here, so Home's
 * hero, LookupDetail and PendingDetail share one cached image. */
export function fanartUrl(url) {
  const tmdb = url && /^(https?:\/\/image\.tmdb\.org\/t\/p\/)original(\/.+)$/.exec(url);
  return tmdb ? tmdb[1] + 'w1280' + tmdb[2] : url || null;
}

/* A lookup/trending result's backdrop for the Home hero: the Sonarr/Radarr
 * fanart (session-cached by mlMetadata), at a TV-sized rendition rather than
 * TMDB's multi-megabyte /original. Resolves to { bg, meta } — meta may be
 * null when the metadata call fails or is slow. */
export async function lookupBackdrop(item, timeout = 1500) {
  const meta = await Promise.race([
    mlMetadata(item.type, item.id).catch(() => null),
    new Promise((r) => setTimeout(() => r(null), timeout))
  ]);
  return { bg: fanartUrl(meta?.fanart || meta?.poster || item.poster), meta };
}
