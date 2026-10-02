/* How the Movies / Shows grid is sorted and filtered — per tab, remembered
 * across sessions (a per-viewer convenience, so plain localStorage like the rest
 * of the client config), plus which of the bar's dropdowns is open.
 *
 * Everything is applied server-side: the grid is paged (Library.svelte), so a
 * client-side sort would only ever order the pages that happen to be loaded. */

/* `by`/`order` go straight into Jellyfin's SortBy/SortOrder (comma lists, one
 * order per key). SortName is the tie-breaker everywhere, so equal dates or
 * ratings still come out in a stable, readable order.
 *
 * Shows sort "Recently added" by DateLastContentAdded, not DateCreated: a series
 * is created once, but what the user means by "new" is the show that just got
 * an episode.
 *
 * "Recently watched" is DatePlayed (the user's LastPlayedDate; never-played
 * titles sort after every played one). "Runtime" runs shortest first — the
 * couch question is "what fits in the time I have". */
export const SORTS = {
  movies: [
    { id: 'added', label: 'Recently added', by: 'DateCreated,SortName', order: 'Descending,Ascending' },
    { id: 'title', label: 'Title', by: 'SortName', order: 'Ascending' },
    { id: 'year', label: 'Release date', by: 'PremiereDate,ProductionYear,SortName', order: 'Descending,Descending,Ascending' },
    { id: 'rating', label: 'Rating', by: 'CommunityRating,SortName', order: 'Descending,Ascending' },
    { id: 'played', label: 'Recently watched', by: 'DatePlayed,SortName', order: 'Descending,Ascending' },
    { id: 'runtime', label: 'Runtime', by: 'Runtime,SortName', order: 'Ascending,Ascending' }
  ],
  shows: [
    { id: 'added', label: 'New episodes', by: 'DateLastContentAdded,SortName', order: 'Descending,Ascending' },
    { id: 'title', label: 'Title', by: 'SortName', order: 'Ascending' },
    { id: 'year', label: 'First aired', by: 'PremiereDate,ProductionYear,SortName', order: 'Descending,Descending,Ascending' },
    { id: 'rating', label: 'Rating', by: 'CommunityRating,SortName', order: 'Descending,Ascending' },
    { id: 'played', label: 'Recently watched', by: 'DatePlayed,SortName', order: 'Descending,Ascending' }
  ]
};

const KEY = 'reel.libview';
const DEFAULT = { sort: 'added', genre: '', unwatched: false };

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

const saved = load();

/* view.movies / view.shows: { sort, genre ('' = all), unwatched }.
 * open: 'sort' | 'genre' | null — the dropdown currently down, if any. */
export const LV = $state({
  movies: { ...DEFAULT, ...(saved.movies || {}) },
  shows: { ...DEFAULT, ...(saved.shows || {}) },
  open: null
});

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ movies: LV.movies, shows: LV.shows }));
  } catch {}
}

export function viewOf(tab) {
  return LV[tab] || DEFAULT;
}

export function sortOf(tab) {
  const list = SORTS[tab] || SORTS.movies;
  return list.find((s) => s.id === viewOf(tab).sort) || list[0];
}

export function setView(tab, patch) {
  if (!LV[tab]) return;
  Object.assign(LV[tab], patch);
  persist();
}

/* True when the grid shows less than the whole library. */
export function isFiltered(tab) {
  const v = viewOf(tab);
  return !!v.genre || v.unwatched;
}

export function clearFilters(tab) {
  setView(tab, { genre: '', unwatched: false });
}

export function openMenu(which) {
  LV.open = which;
}

export function closeMenu() {
  LV.open = null;
}
