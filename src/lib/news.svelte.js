/* New seasons of shows in the library — the bell in the tab row (TopNav.svelte).
 *
 * Only Sonarr knows a season exists before it is on disk, so the feed is
 * reel-api's /api/news: seasons with no file yet that have either aired within
 * the last year ('aired') or are listed on TheTVDB without having aired
 * ('upcoming'). A season that is downloading is still in the feed — the menu
 * reads the live activity for it (seasonActivity) instead of the backend
 * guessing.
 *
 * "Seen" is per Jellyfin user and remembered by item id, which includes the
 * kind: when an upcoming season premieres it comes back as a fresh 'aired'
 * notification. Opening the menu marks everything in it seen; the rows that
 * were new at that moment keep their dot until the menu closes. */
import { mlNews, mlSeasonSearch, mlSeasonSearchUndo } from './medialib.js';
import { act, boostActivity } from './activity.svelte.js';
import { cfg } from './config.js';
import { toast } from './toast.svelte.js';

const KEY = 'reel.newsSeen';
const PERIOD = 10 * 60 * 1000;

export const news = $state({
  items: [],
  loaded: false,
  seen: loadSeen(),
  fresh: [],        // ids that were unseen when the menu was opened
  searching: {},    // id -> Date.now() of the last "Get season" this session
  found: {},        // id -> true once a searched season showed up in the activity feed
  clock: Date.now() // ticks while a search waits for a grab (searchState)
});

/* How long a season search may run before the menu admits nothing turned up.
 * Sonarr's SeasonSearch asks every indexer and grabs within ~10–60 s when a
 * release exists; the activity poll (4 s) then shows it. */
const SEARCH_GIVE_UP = 2 * 60 * 1000;
let clockTimer = null;

function tickClock() {
  news.clock = Date.now();
  // "found" sticks: a grab that finishes importing leaves the activity feed
  // before the season leaves the news feed, and must not read "Nothing found".
  for (const it of news.items) if (news.searching[it.id] && !news.found[it.id] && seasonActivity(it)) news.found[it.id] = true;
  const waiting = Object.entries(news.searching).some(([id, t]) => !news.found[id] && news.clock - t < SEARCH_GIVE_UP);
  if (!waiting) {
    clearInterval(clockTimer);
    clockTimer = null;
  }
}

/* The Get button's life after a press, derived from the activity poll:
 *   null        never pressed (or it failed) → "Get"
 *   'searching' pressed < 2 min ago, nothing grabbed yet
 *   'found'     a grab for the season is in the activity feed
 *   'none'      2 min without a grab → "Nothing found yet", Retry */
export function searchState(item) {
  const t = news.searching[item.id];
  if (!t) return null;
  if (news.found[item.id] || seasonActivity(item)) return 'found';
  return news.clock - t < SEARCH_GIVE_UP ? 'searching' : 'none';
}

function loadSeen() {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || '{}');
    const v = all && all[cfg.userId];
    return Array.isArray(v) ? v : [];   // anything else would throw in every poll's .filter
  } catch {
    return [];
  }
}

function saveSeen() {
  try {
    let all = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (!all || typeof all !== 'object' || Array.isArray(all)) all = {};
    all[cfg.userId] = news.seen;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {}
}

let timer = null;
let lastAt = 0;

/* Polled on the browse screens (App.svelte). The feed changes on the scale of
 * hours, so a restart of the poll — every screen change — only refetches when
 * the last answer is older than the period. */
export function startNews() {
  if (timer) return;
  if (Date.now() - lastAt > PERIOD) poll();
  timer = setInterval(poll, PERIOD);
}

export function stopNews() {
  clearInterval(timer);
  timer = null;
}

async function poll() {
  try {
    const r = await mlNews();
    news.items = (r && r.items) || [];
    news.loaded = true;
    lastAt = Date.now();
    // forget seen ids that have left the feed, so the list can't grow forever
    const live = new Set(news.items.map((i) => i.id));
    const kept = news.seen.filter((id) => live.has(id));
    if (kept.length !== news.seen.length) {
      news.seen = kept;
      saveSeen();
    }
  } catch {
    /* keep the last-known list; the next tick retries */
  }
}

export function unreadCount() {
  const seen = new Set(news.seen);
  return news.items.filter((i) => !seen.has(i.id)).length;
}

export function markAllSeen() {
  const seen = new Set(news.seen);
  news.fresh = news.items.filter((i) => !seen.has(i.id)).map((i) => i.id);
  if (!news.fresh.length) return;
  news.seen = [...news.seen, ...news.fresh];
  saveSeen();
}

/* Live download state of a news item's season, from the activity poll:
 * { status, progress } of its most active grab, or null. */
export function seasonActivity(item) {
  const grabs = act.items.filter(
    (i) => i.type === 'tv' && i.media_id === item.media_id && i.season === item.season && i.status !== 'completed'
  );
  if (!grabs.length) return null;
  const dl = grabs.filter((g) => g.status === 'downloading');
  const pick = dl[0] || grabs[0];
  const progress = dl.length ? dl.reduce((n, g) => n + (g.progress || 0), 0) / dl.length : pick.progress || 0;
  return { status: pick.status, progress };
}

export async function getSeason(item) {
  const st = searchState(item);
  if (st === 'searching' || st === 'found') return;
  news.searching[item.id] = Date.now(); // a Retry restarts the window
  news.clock = Date.now();
  clockTimer ||= setInterval(tickClock, 5000);
  try {
    const r = await mlSeasonSearch({ id: item.media_id, season: item.season });
    const msg = 'Looking for ' + item.title + ' season ' + item.season + '…';
    // phone: its grabs show up queued within seconds — watch at the fast rate
    if (__PHONE__) boostActivity();
    // phone: Undo in the toast (the TV has none here)
    if (__PHONE__ && r && r.undo) toast(msg, () => undoGetSeason(item, r.undo));
    else toast(msg);
  } catch (e) {
    delete news.searching[item.id];
    toast(e.code === 'not_aired' ? 'Nothing has aired yet' : e.retriable ? 'Library busy — try again in a moment' : 'Couldn’t start the search: ' + e.message);
  }
}

/* Phone: the Get toast's Undo — the season's monitoring goes back to what it
 * was and whatever the search grabbed is cancelled (server-side, including a
 * grab that lands after the undo). The row returns to "Get". */
export async function undoGetSeason(item, token) {
  try {
    await mlSeasonSearchUndo(token);
    boostActivity(); // its grabs leave the feed
    delete news.searching[item.id];
    delete news.found[item.id];
    toast('Stopped — ' + item.title + ' season ' + item.season + ' won’t download');
  } catch (e) {
    toast(e.status === 410 ? 'Too late to undo that search' : 'Couldn’t undo: ' + e.message);
  }
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* "Jul 9" this year, "Jul 9, 2027" otherwise. */
function day(iso) {
  const d = new Date(iso);
  const s = MON[d.getMonth()] + ' ' + d.getDate();
  return d.getFullYear() === new Date().getFullYear() ? s : s + ', ' + d.getFullYear();
}

/* The one-line "what happened" under a news row's title. */
export function newsLine(item) {
  if (item.kind === 'upcoming') {
    if (!item.premiere) return 'Announced · no date yet';
    const days = Math.ceil((new Date(item.premiere) - Date.now()) / 86400000);
    if (days <= 1) return 'Premieres tomorrow';
    if (days < 7) return 'Premieres in ' + days + ' days';
    return 'Premieres ' + day(item.premiere);
  }
  const n = item.episodes_aired;
  const of = item.episodes_total > n ? n + ' of ' + item.episodes_total : n;
  return 'Out since ' + day(item.premiere) + ' · ' + of + (n === 1 && item.episodes_total <= 1 ? ' episode' : ' episodes');
}
