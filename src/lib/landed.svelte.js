/* "Ready to watch" — downloads that finished importing, listed in the bell
 * (TopNav.svelte) with a count on it until the menu is opened. No toasts.
 *
 * Detection is a diff of the /api/activity feed (activity.svelte.js calls
 * onFeed() with every changed answer): a grab that was active in the previous
 * snapshot and is now gone (or reports 'completed') becomes a candidate, and a
 * candidate only counts once Jellyfin has it — the title found by the same
 * search + matchGroup() PendingDetail's findLanded() uses, and for a show the
 * exact SxxEyy among the series' episodes (a deleted/failed grab also leaves
 * the feed). Episodes of one title merge into one entry ("8 new episodes")
 * until the menu has been opened.
 *
 * The previous snapshot and the unconfirmed candidates are persisted, so a
 * landing while the poll was paused (playback, parked webview, even a cold
 * restart) is caught by the first poll afterwards. Everything is per Jellyfin
 * user (cfg.userId only changes across a reload). The entry time is the
 * item's DateCreated, so a late reconcile doesn't claim "just now". */
import { onFeed, matchGroup } from './activity.svelte.js';
import { api, itemsPath, imgUrl, qs } from './api.js';
import { cfg } from './config.js';
import { S } from './nav.svelte.js';
import { posterThumb } from './medialib.js';

const KEY = 'reel.landed';        // { [userId]: entries }
const FEED_KEY = 'reel.landedFeed'; // { [userId]: { snap, awaiting } }
const KEEP = 10;
const MAX_AGE = 7 * 86400000;
const ACTIVE = new Set(['queued', 'downloading', 'importing', 'paused', 'warning']);
/* Waits between Jellyfin checks of a candidate: the library scan after an
 * import takes seconds to a minute. Past the last one it is dropped. */
const DELAYS = [4000, 12000, 30000, 90000, 300000];

/** @param {string} k localStorage key @returns {Record<string, any>} per-user map (unvalidated JSON) */
function readAll(k) {
  try {
    const all = JSON.parse(localStorage.getItem(k) || '{}');
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
  } catch {
    return {};
  }
}

/** @param {string} k @param {unknown} v */
function writeMine(k, v) {
  try {
    const all = readAll(k);
    all[cfg.userId] = v;
    localStorage.setItem(k, JSON.stringify(all));
  } catch {}
}

/** @returns {VR.LandedEntry[]} */
function loadEntries() {
  const v = readAll(KEY)[cfg.userId];
  return Array.isArray(v) ? prune(v.filter((e) => e && e.id && e.key && Array.isArray(e.eps))) : [];
}

/** @param {VR.LandedEntry[]} list @returns {VR.LandedEntry[]} */
function prune(list) {
  const cut = Date.now() - MAX_AGE;
  return list.filter((e) => e.at > cut).sort((a, b) => b.at - a.at).slice(0, KEEP);
}

/** @type {VR.LandedState} */
export const landed = $state(/** @satisfies {VR.LandedState} */ ({ items: loadEntries(), fresh: [] }));

/* ---- feed diff ---- */

const feed0 = readAll(FEED_KEY)[cfg.userId] || {};
/** @type {Map<string, VR.LandedGrab> | null} */
let prev = feed0.snap && typeof feed0.snap === 'object' ? new Map(Object.entries(feed0.snap)) : null; // null: no baseline yet
/** @type {VR.LandedCandidate[]} */
let awaiting = Array.isArray(feed0.awaiting) ? feed0.awaiting : [];   // candidates: { id, k, type, title, mediaId, poster, year, s, e, tries }
/** @type {ReturnType<typeof setTimeout> | 0} */
let timer = 0;

function saveFeed() {
  writeMine(FEED_KEY, { snap: prev ? Object.fromEntries(prev) : null, awaiting });
}

/** @param {Reel.ActivityItem} it @returns {string} the activity group key */
function gkey(it) {
  return it.type + ':' + (it.media_id || 't:' + (it.title || '').toLowerCase());
}

onFeed((items) => {
  /** @type {Map<string, VR.LandedGrab>} */
  const cur = new Map();
  for (const it of items) {
    if (!ACTIVE.has(it.status) || (it.type !== 'tv' && it.type !== 'movie')) continue;
    const k = gkey(it);
    const id = it.type === 'tv' ? k + '#' + it.season + 'x' + it.episode : k;
    if (it.type === 'tv' && (it.season == null || it.episode == null)) continue;
    cur.set(id, { k, type: it.type, title: it.title, mediaId: it.media_id || null, poster: it.poster || null, year: it.year || null, s: it.season ?? null, e: it.episode ?? null });
  }
  // a downloading feed changes every poll (progress); only its set of grabs matters here
  const same = prev && prev.size === cur.size && [...cur.keys()].every((id) => /** @type {NonNullable<typeof prev>} checked just before */ (prev).has(id));
  if (same) {
    // candidates persisted by an earlier session (cold restart, parked
    // webview) still need their check even when the feed hasn't moved
    if (awaiting.length && !timer) schedule();
    return;
  }
  if (prev) {
    const have = new Set(awaiting.map((a) => a.id));
    for (const [id, v] of prev) if (!cur.has(id) && !have.has(id)) awaiting.push({ id, ...v, tries: 0 });
  }
  prev = cur;
  saveFeed();
  if (awaiting.length && !timer) schedule();
});

let waitVis = false; // phone: a check is waiting for the app to be visible again
function onVisible() {
  if (document.hidden) return;
  document.removeEventListener('visibilitychange', onVisible);
  waitVis = false;
  if (awaiting.length && !timer) schedule();
}

function schedule() {
  clearTimeout(timer);
  const t = Math.min(...awaiting.map((a) => a.tries));
  timer = setTimeout(check, DELAYS[Math.min(t, DELAYS.length - 1)]);
}

async function check() {
  timer = 0;
  if (!awaiting.length) return;
  // never touch the network for this while a video plays; the next poll after
  // playback (or this timer) picks it up
  if (S.screen === 'player') {
    timer = setTimeout(check, 30000);
    return;
  }
  // phone: nothing to show it on while the app is in the background (and iOS
  // may freeze the request half-way) — check again once it is back on screen
  if (__PHONE__ && document.hidden) {
    if (!waitVis) {
      waitVis = true;
      document.addEventListener('visibilitychange', onVisible);
    }
    return;
  }
  /** @type {Map<string, VR.LandedCandidate[]>} */
  const groups = new Map();
  for (const a of awaiting) {
    if (!groups.has(a.k)) groups.set(a.k, []);
    /** @type {VR.LandedCandidate[]} */ (groups.get(a.k)).push(a);
  }
  const done = new Set();
  for (const list of groups.values()) {
    const g = list[0];
    try {
      /** @type {Jf.QueryResult} */
      const r = await api(
        itemsPath({
          SearchTerm: g.title,
          IncludeItemTypes: g.type === 'tv' ? 'Series' : 'Movie',
          Recursive: true,
          Fields: 'ProviderIds,DateCreated',
          Limit: 20
        })
      );
      const jf = (r.Items || []).find((i) => matchGroup([{ type: g.type, mediaId: g.mediaId, title: g.title }], i));
      if (!jf) continue;
      if (g.type === 'movie') {
        record(g, jf, [], Date.parse(/** @type {string} missing → NaN → record() uses now */ (jf.DateCreated)));
        for (const a of list) done.add(a.id);
        continue;
      }
      /** @type {Jf.QueryResult} */
      const er = await api('/Shows/' + jf.Id + '/Episodes' + qs({ UserId: cfg.userId, Fields: 'DateCreated', IsMissing: false }));
      const eps = [];
      let at = 0;
      for (const a of list) {
        const ep = (er.Items || []).find(
          (x) => x.ParentIndexNumber === a.s && (x.IndexNumber === a.e || (/** @type {number} */ (x.IndexNumber) < /** @type {number} tv candidates always have e */ (a.e) && /** @type {number} */ (x.IndexNumberEnd) >= /** @type {number} */ (a.e)))
        );
        if (!ep) continue;
        eps.push(a.s + 'x' + a.e);
        at = Math.max(at, Date.parse(/** @type {string} */ (ep.DateCreated)) || 0);
        done.add(a.id);
      }
      if (eps.length) record(g, jf, eps, at);
    } catch {
      /* retried below */
    }
  }
  awaiting = awaiting.filter((a) => !done.has(a.id) && ++a.tries < DELAYS.length);
  saveFeed();
  if (awaiting.length) schedule();
}

/** @param {VR.LandedCandidate} g @param {Jf.BaseItemDto} jf @param {string[]} eps 'SxE' @param {number} at ms */
function record(g, jf, eps, at) {
  const now = Date.now();
  if (!(at > 0) || at > now) at = now;
  if (at < now - MAX_AGE) return;
  const poster = imgUrl(jf, 'Primary', { h: 180 }) || posterThumb(g.poster) || null;
  let list = landed.items.filter((e) => e.key !== g.k || !e.seen);
  const old = list.find((e) => e.key === g.k);
  if (old) {
    old.eps = [...new Set([...old.eps, ...eps])].sort(epCmp);
    old.at = Math.max(old.at, at);
    old.poster = poster || old.poster;
  } else {
    list.push({ key: g.k, id: jf.Id, jfType: /** @type {Jf.ItemKind} */ (jf.Type), type: g.type, title: jf.Name || g.title, year: jf.ProductionYear || g.year, poster, eps: eps.sort(epCmp), at, seen: false });
  }
  landed.items = prune(list);
  writeMine(KEY, $state.snapshot(landed.items));
}

/** @param {string} a @param {string} b 'SxE' @returns {number} */
function epCmp(a, b) {
  const [s1, e1] = a.split('x').map(Number);
  const [s2, e2] = b.split('x').map(Number);
  return s1 - s2 || e1 - e2;
}

/* ---- the bell ---- */

/** @returns {number} */
export function unseenLanded() {
  return landed.items.filter((e) => !e.seen).length;
}

/* Opening the menu: the rows that were new keep their dot until it closes. */
export function markLandedSeen() {
  landed.items = prune(landed.items);
  landed.fresh = landed.items.filter((e) => !e.seen).map((e) => e.key);
  if (!landed.fresh.length) return;
  for (const e of landed.items) e.seen = true;
  writeMine(KEY, $state.snapshot(landed.items));
}

/* "S2E3", "8 new episodes" (one season: "Season 2 · 8 new episodes"), or the year. */
/** @param {VR.LandedEntry} e @returns {string} */
export function landedLine(e) {
  if (e.type !== 'tv') return e.year ? 'Movie · ' + e.year : 'Movie';
  if (e.eps.length === 1) {
    const [s, ep] = e.eps[0].split('x');
    return 'S' + s + 'E' + ep;
  }
  const seasons = new Set(e.eps.map((x) => x.split('x')[0]));
  const n = e.eps.length + ' new episodes';
  return seasons.size === 1 ? 'Season ' + [...seasons][0] + ' · ' + n : n;
}

/** @param {number} at ms @returns {string} */
export function landedAgo(at) {
  const m = Math.round((Date.now() - at) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' h ago';
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : d + ' days ago';
}
