import { cfg } from './config.js';

export const TICKS = 10000000; // per second

/* For *lists* that render more than a poster — the Home rails (their hero shows
 * overview, genres, ratings, tech badges and plays the item as-is) and a
 * season's episode rows. Detail pages fetch the full single item instead, which
 * is where People/Studios/Taglines/DateCreated are read, so those are not asked
 * for here; nor is the top-level MediaStreams — every reader goes through
 * MediaSources[n].MediaStreams, which Fields=MediaSources already carries, so it
 * was a second copy of every stream (~1 KB each; a remux with 30 subtitle
 * tracks doubled per episode). */
export const ITEM_FIELDS =
  'Overview,Genres,MediaSources,UserData,PremiereDate,ProductionYear,RunTimeTicks,' +
  'CommunityRating,OfficialRating,SeriesName,IndexNumber,ParentIndexNumber';

/* The library grid renders far less than a detail page does: a poster, the
 * title, the year and the resolution/HDR badge. The old ITEM_FIELDS dragged Overview,
 * People, Studios, Taglines and a duplicate MediaStreams along for the ride —
 * measured against the live server that is 79 KB vs 32 KB for the same query,
 * and the gap scales linearly with the library (Fields=MediaSources alone is
 * ~12 KB per movie). MediaSources has to stay: tileTechBadge() reads
 * MediaSources[0].MediaStreams. ImageTags/BackdropImageTags/Name/Type come
 * back whether you ask for them or not. */
export const GRID_FIELDS = 'UserData,ProductionYear,PremiereDate,MediaSources';


/** @returns {string} */
function authHeader() {
  const dev = typeof __PHONE__ !== 'undefined' && __PHONE__ ? 'iPhone' : 'LG webOS TV';
  let h = `MediaBrowser Client="Reel", Device="${dev}", DeviceId="${cfg.deviceId}", Version="0.1.0"`;
  if (cfg.token) h += `, Token="${cfg.token}"`;
  return h;
}

/* ===================== opt-in prefetch / SWR =====================
 * Jellyfin sends NO cache headers on /Items at all (verified against 10.11.11:
 * no Cache-Control, no ETag, no Last-Modified), so every browse-screen fetch is
 * an unconditional network round trip — ~80-300 ms on this LAN. Images are the
 * opposite: `Cache-Control: public, max-age=31536000`, so the HTTP cache already
 * handles them and there is nothing to add there.
 *
 * Nothing below changes api()'s default behaviour. Everything is opt-in and
 * keyed by the exact request path:
 *
 *   prefetch(path)     start the request now and park the promise. The next
 *                      api(path) consumes it once, instead of re-requesting.
 *   cached(path) +     stale-while-revalidate: paint the previous answer, then
 *   revalidate(path)   swap in the fresh one when it lands.
 *   invalidate(prefix) forget what we know about these paths.
 *
 * FRESHNESS IS THE CALLER'S PROBLEM, and there are exactly three ways to make
 * it not a lie:
 *
 *   1. the query renders nothing the user can change — the poster grid has no
 *      watched tick and no progress bar, so last session's answer is as good as
 *      today's;
 *   2. whatever mutates it calls invalidate() on the way out — the video stop
 *      path does this for the Home rails (see reportStop() in
 *      player.svelte.js), so a resume position is never painted from a cache
 *      this app itself invalidated;
 *   3. the caller passes a maxAge to cached() and accepts a cold read when the
 *      entry is older than that — for a rail whose staleness is cosmetic and
 *      whose mutator is out of reach (VibeSpin uses this for its "Recently Played").
 *
 * A query that fits none of the three does not belong in here. */
const PREFETCH_TTL = 30000;
const API_TIMEOUT = 30000; // default deadline for a request without its own signal
/** @type {Map<string, { at: number, p: Promise<unknown> }>} */
const parked = new Map(); // path -> { at, p }
/** @type {Map<string, VR.StoreEntry>} */
const store = new Map(); // path -> { at, data } of the last successful response
const STORE_MAX = 24; // Home's rails + a few grids per tab; oldest revalidation evicted first
const STORE_ITEMS = 800; // total Items[] across the store (~9 MB of grid JSON at worst)

/* Warm a GET that is about to be needed (e.g. the detail item behind the tile
 * the D-pad is resting on). Cheap to call repeatedly: an in-flight or recent
 * request for the same path is reused rather than duplicated. */
/** @param {string} path @returns {Promise<unknown>} */
export function prefetch(path) {
  const now = Date.now();
  const hit = parked.get(path);
  if (hit && now - hit.at < PREFETCH_TTL) return hit.p;
  /* A warm nobody consumed (the D-pad dwelt on a tile, then moved on) used to
   * stay parked for the whole session — a full item JSON per tile ever rested
   * on. Expired ones can never be served, so drop them here. */
  for (const [k, e] of parked) if (now - e.at >= PREFETCH_TTL) parked.delete(k);
  const p = api(path);
  parked.set(path, { at: Date.now(), p });
  // a rejection must not be served to the real caller later
  p.catch(() => {
    if (parked.get(path)?.p === p) parked.delete(path);
  });
  return p;
}

/* The previous successful response for this path, or null. With maxAge (ms),
 * an entry older than that reads as a miss — for callers that would rather show
 * nothing than something the user may have changed since. */
/** @template [T=unknown] @param {string} path @param {number} [maxAge] ms @returns {T | null} the stored answer, or null */
export function cached(path, maxAge) {
  const e = store.get(path);
  if (!e) return null;
  if (maxAge && Date.now() - e.at > maxAge) return null;
  return e.data;
}

/* Fetch and remember, for a later cached() hit. */
/** @template [T=unknown] @param {string} path @param {VR.ApiOptions} [opts] @returns {Promise<T>} */
export function revalidate(path, opts) {
  return /** @type {Promise<T>} */ (api(path, opts)).then((d) => {
    /* LRU-bounded: the library grid keys by its exact query (tab, sort, genre,
     * unwatched and the loaded count), so every paging depth and filter combo
     * left a whole grid answer — MediaSources included, ~12 KB per movie —
     * in memory for the session. Re-inserting moves a path to the young end. */
    store.delete(path);
    store.set(path, { at: Date.now(), data: d });
    while (store.size > STORE_MAX) store.delete(/** @type {string} */ (store.keys().next().value));
    /* ...and item-bounded: 24 entries is harmless for Home's ~20-item rails but
     * not for a deep grid. Back from a detail page re-reads the grid at its
     * loaded depth, so every depth scrolled to (126, 252, 378, …) is its own
     * key, each superseding the last — measured ~11 KB of JSON per movie with
     * GRID_FIELDS, so a 500-title library scrolled through once is ~5.5 MB per
     * entry. Oldest go first; the newest entry always stays. */
    let items = 0;
    const n = (/** @type {any} */ d) => (Array.isArray(d) ? d.length : d?.Items?.length || 0);
    for (const e of store.values()) items += n(e.data);
    while (items > STORE_ITEMS && store.size > 1) {
      const k = store.keys().next().value;
      items -= n(/** @type {VR.StoreEntry} */ (store.get(/** @type {string} */ (k))).data); // size > 1: k is a live key
      store.delete(/** @type {string} */ (k));
    }
    return d;
  });
}

/* Phone only (the TV build never calls them; they tree-shake away): the Home
 * snapshot (phone/src/lib/homesnap.svelte.js) persists Home's rail answers
 * across launches. storeEntries(paths) reads the store's entries for those
 * paths ([path, { at, data }]); seedStore(entries) puts saved ones back at
 * boot, with their old `at`, so cached() paints them and a failed revalidate
 * (offline) falls back to them. A path already answered this session wins. */
/** @param {Array<[string, VR.StoreEntry]> | null | undefined} entries (from localStorage: shape-checked here) */
export function seedStore(entries) {
  if (!(typeof __PHONE__ !== 'undefined' && __PHONE__)) return;
  for (const [path, e] of entries || []) {
    if (typeof path === 'string' && e && e.data && !store.has(path)) store.set(path, { at: +e.at || 0, data: e.data });
  }
}
/** @param {string[]} paths @returns {Array<[string, VR.StoreEntry]>} */
export function storeEntries(paths) {
  if (!(typeof __PHONE__ !== 'undefined' && __PHONE__)) return [];
  /** @type {Array<[string, VR.StoreEntry]>} */
  const out = [];
  for (const p of paths) {
    const e = store.get(p);
    if (e) out.push([p, e]);
  }
  return out;
}

/* Forget every cached (and parked) path starting with `prefix` — a string or an
 * array of them. Called by whatever changed the data on the server, so the next
 * screen that would have painted from cache pays for a fresh read instead. The
 * prefix is matched against the full request path, query string included, so
 * '/UserItems/Resume' hits the Home rail and '/Items/{id}?' one item's detail
 * without touching the library grid at '/Items?...'. */
/** @param {string | string[]} prefix */
export function invalidate(prefix) {
  const list = Array.isArray(prefix) ? prefix : [prefix];
  for (const m of [store, parked]) {
    for (const k of m.keys()) if (list.some((p) => k.startsWith(p))) m.delete(k);
  }
}

/* Read-after-write barrier. exitPlayer() posts Sessions/Playing/Stopped and
 * immediately navigates to a screen (detail page, Home) that GETs the same
 * item's UserData; on separate connections Jellyfin could answer the GET
 * before the Stopped handler saved the new resume point, painting the old one.
 * holdReads(p) makes user-data reads (/Items…, /UserItems/…, /Shows/…) wait for
 * p — capped,
 * so a hung write never stalls browsing. */
/** @type {Promise<unknown> | null} */
let readBarrier = null;
/** @template T @param {Promise<T>} p the write @param {number} [cap] ms @returns {Promise<T>} `p` itself */
export function holdReads(p, cap = 1500) {
  const b = Promise.race([p.then(() => {}, () => {}), new Promise((r) => setTimeout(r, cap))]);
  readBarrier = b;
  b.then(() => {
    if (readBarrier === b) readBarrier = null;
  });
  return p;
}

/** A Jellyfin request: auth header, JSON body, 30 s deadline, prefetch/read-barrier aware.
 * Resolves to the parsed JSON (text for a non-JSON answer, null for a 204); rejects with a
 * VR.ApiError carrying `userMessage`.
 * @template [T=unknown] @param {string} path @param {VR.ApiOptions} [opts] @returns {Promise<T>} */
export function api(path, opts = {}) {
  /* A parked prefetch only stands in for a plain GET — a body, a custom method
   * or an abort signal all mean the caller wants this exact request made. */
  if (parked.size && !opts.body && !opts.signal && (opts.method || 'GET') === 'GET') {
    const hit = parked.get(path);
    if (hit) {
      parked.delete(path); // one-shot: the next navigation gets fresh data
      if (Date.now() - hit.at < PREFETCH_TTL) return /** @type {Promise<T>} */ (hit.p);
    }
  }
  // after the parked check: a warm the write didn't invalidate is still good
  if (readBarrier && !opts.body && (opts.method || 'GET') === 'GET' && /^\/(Users\/|Shows\/|UserItems\/|Items[/?])/.test(path))
    return readBarrier.then(() => api(path, opts));
  // The standard header. Jellyfin 12 dropped the legacy X-Emby-Authorization:
  // sent that way the client identity never parses and every request -- login
  // included -- fails with 400 "Value cannot be null (Parameter 'request.App')".
  // The token rides inside it, so no separate X-Emby-Token is needed.
  /** @type {Record<string, string>} */
  const headers = { Authorization: authHeader() };
  /** @type {any} JSON-encoded below */
  let body = opts.body;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  // keepalive: a request that must outlive the page being frozen (see
  // suspendPlayback() in player.svelte.js).
  /* fetch() has no timeout of its own: a request sent while the TV's Wi-Fi is
   * still re-associating after standby (or to a half-up server) can stay
   * pending forever, leaving a screen on its spinner with no LoadError/Retry.
   * Callers with their own signal (boot) keep their own deadline. */
  const signal = opts.signal || (opts.keepalive ? undefined : AbortSignal.timeout(API_TIMEOUT));
  const init = { method: opts.method || 'GET', headers, body, signal, keepalive: !!opts.keepalive };
  const server = cfg.server;
  const token = cfg.token;
  return fetch(server + path, init).then((r) => {
    if (!r.ok) {
      const e = /** @type {VR.ApiError} */ (new Error('HTTP ' + r.status + ' ' + path));
      e.status = r.status;
      e.userMessage = httpMessage(r.status);
      // the token this request carried was refused — see onAuthLost()
      if (r.status === 401 && token && token === cfg.token && authLost) {
        try {
          authLost(path);
        } catch {
          /* never turn the caller's error into a different one */
        }
      }
      throw e;
    }
    if (r.status === 204) return null;
    const ct = r.headers.get('content-type') || '';
    /* The deadline and the network also cover the body: a connection dropped
     * (or timed out) mid-download, or a truncated/non-JSON body, rejects here
     * with a raw DOMException/SyntaxError that LoadError would print verbatim. */
    return (ct.includes('json') ? r.json() : r.text()).catch((err) => {
      const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
      const e = /** @type {VR.ApiError} */ (new Error((aborted ? 'body aborted: ' : 'bad body: ') + path));
      if (aborted) e.name = 'AbortError';   // as below: callers that drop their own aborts still can
      e.status = 0;
      e.network = aborted || err?.name === 'TypeError';
      e.cause = err;
      e.userMessage = aborted
        ? 'The server at ' + server + ' took too long to answer'
        : e.network
          ? 'The connection to ' + server + ' dropped'
          : 'The server sent an answer this app couldn’t read';
      throw e;
    });
  }, (err) => {
    /* fetch() itself rejected: no HTTP answer at all. The raw TypeError reads
     * "Failed to fetch", which says nothing on a TV; keep the original as
     * `cause` and give the UI a sentence it can show as-is. */
    const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
    const e = /** @type {VR.ApiError} */ (new Error(aborted ? 'request aborted: ' + path : 'network error: ' + path));
    e.name = aborted ? 'AbortError' : 'NetworkError';
    e.status = 0;
    e.network = true;
    e.cause = err;
    e.userMessage = aborted
      ? 'The server at ' + server + ' took too long to answer'
      : 'Can’t reach the server at ' + server;
    throw e;
  });
}

/* A token revoked mid-session (signed out from the Jellyfin dashboard, device
 * deleted, password changed) used to surface as an error card on whatever
 * screen asked next, and on every screen after that. api() reports each 401
 * on the current token here; App.svelte confirms it and routes to Login. */
/** @type {((path: string) => void) | null} */
let authLost = null;
/** @param {(path: string) => void} fn called with the request path of each 401 on the current token */
export function onAuthLost(fn) {
  authLost = fn;
}

/** @param {number} status @returns {string} */
function httpMessage(status) {
  if (status === 401 || status === 403) return 'The server refused this sign-in (HTTP ' + status + ')';
  if (status === 404) return 'Not found on the server (HTTP 404)';
  if (status >= 500) return 'The server had a problem (HTTP ' + status + ')';
  return 'The server answered HTTP ' + status;
}

/* One readable line for any error thrown by api() (or anything else): the
 * userMessage set above when there is one, else the error's own message. */
/** The sentence to show for a failure: api()'s userMessage, else the message.
 * @param {VR.ApiError | null | undefined} e
 * @returns {string} */
export function errText(e) {
  if (!e) return 'Unknown error';
  return e.userMessage || e.message || String(e);
}

/** `?a=1&b=x` from an object; undefined/null/'' values are left out.
 * @param {Record<string, any>} o @returns {string} '' when nothing is left */
export function qs(o) {
  const p = [];
  for (const k in o) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== '') p.push(k + '=' + encodeURIComponent(v));
  }
  return p.length ? '?' + p.join('&') : '';
}

/* SeriesDetail's season list. One builder, because prefetch() matches by the
 * exact path: Detail/Tile warm it so a series opens with Items ∥ Seasons
 * instead of Items → Seasons → Episodes (~45 ms per hop on the TV). */
/** @param {string} seriesId @returns {string} */
export function seasonsPath(seriesId) {
  return '/Shows/' + seriesId + '/Seasons' + qs({ UserId: cfg.userId, Fields: 'UserData,ChildCount' });
}

/* A season's episode rows (no MediaSources — see SeriesDetail.fetchEps) and the
 * first episode with its MediaSources (the hero badges). */
/** @param {string} seriesId @param {string | null | undefined} seasonId none: qs() leaves SeasonId out
 * @returns {string[]} [rows, first episode] */
export function episodesPaths(seriesId, seasonId) {
  const base = '/Shows/' + seriesId + '/Episodes';
  return [
    base + qs({ SeasonId: seasonId, UserId: cfg.userId, Fields: 'Overview', EnableImageTypes: 'Primary,Thumb' }),
    base + qs({ SeasonId: seasonId, UserId: cfg.userId, Fields: 'MediaSources', Limit: 1 })
  ];
}

/* Phone only (the TV's SeriesDetail doesn't ask NextUp; tree-shaken from
 * app.js): the episode SeriesDetail's Resume/Play starts. A builder for the
 * same reason as seasonsPath — Detail warms it next to the seasons, so the
 * button no longer waits for Items → SeriesDetail mounts → NextUp. */
/** @param {string} seriesId @returns {string} */
export function nextUpPath(seriesId) {
  return (
    '/Shows/NextUp' +
    qs({ SeriesId: seriesId, UserId: cfg.userId, Limit: 1, EnableResumable: true, EnableRewatching: false, DisableFirstEpisode: false })
  );
}

/* The season SeriesDetail opens on: the first one not fully watched. */
/** @param {Jf.BaseItemDto[]} seasons @returns {number} index into `seasons` */
export function startSeason(seasons) {
  const i = seasons.findIndex((s) => !(s.UserData && s.UserData.Played));
  return i < 0 ? 0 : i;
}


/* The user-scoped item routes. The legacy /Users/{uid}/Items[/{id}|/Resume]
 * and /Users/{uid}/Views are [Obsolete] since 10.9 and absent from 12.1's
 * OpenAPI spec (still answered, byte-identical — measured 2026-09-28); these
 * are their replacements. One builder for the single item, because prefetch()
 * (Tile, episode rows, Up Next) and the screen that reads it must produce the
 * exact same path, and played.js invalidates it by that path. */
/** @param {string} id @returns {string} */
export function itemPath(id) {
  return '/Items/' + id + qs({ userId: cfg.userId });
}
/** @param {Record<string, any>} q query parameters (userId is added) @returns {string} */
export function itemsPath(q) {
  return '/Items' + qs({ userId: cfg.userId, ...q });
}

/* an empty Jellyfin list result — used as a .catch() fallback so one failed
 * rail never takes down a whole screen */
/** @returns {{ Items: Jf.BaseItemDto[] }} */
export function empty() {
  return { Items: [] };
}

/** @param {VR.ImageSource} item @param {keyof Jf.ImageTags} type @param {VR.ImgOptions} [opts]
 * @returns {string | null} null when the item (and its fallbacks) has no such image */
export function imgUrl(item, type, opts = {}) {
  /** @type {string | null | undefined} */
  let id = opts.id || item.Id;
  const tagObj = item.ImageTags || {};
  let tag = type === 'Backdrop' ? item.BackdropImageTags && item.BackdropImageTags[0] : tagObj[type];
  if (type === 'Backdrop' && !tag && item.ParentBackdropImageTags && item.ParentBackdropItemId) {
    id = item.ParentBackdropItemId;
    tag = item.ParentBackdropImageTags[0];
  }
  if (type === 'Thumb' && !tag && item.ParentThumbImageTag && item.ParentThumbItemId) {
    id = item.ParentThumbItemId;
    tag = item.ParentThumbImageTag;
  }
  if (!tag && type === 'Primary' && item.SeriesPrimaryImageTag) {
    id = item.SeriesId;
    tag = item.SeriesPrimaryImageTag;
  }
  if (!tag) return null;
  /* Quality by size, measured over the TV's Wi-Fi on this library: a 1920
   * backdrop at 80 instead of 90 is 31% fewer bytes (~107 KB each) and sits
   * under the hero scrims anyway; posters at 85 are 19% smaller. */
  const big = (opts.w || 0) >= 1280 || (opts.h || 0) >= 1080;
  /** @type {Record<string, string | number>} */
  const p = { tag, quality: big ? 80 : 85 };
  if (opts.w) p.maxWidth = opts.w;
  else p.maxHeight = opts.h || 480;
  return cfg.server + '/Items/' + id + '/Images/' + type + qs(p);
}

/** @param {Jf.BaseItemPerson} p @returns {string | null} */
export function personImg(p) {
  if (!p.PrimaryImageTag) return null;
  return (
    cfg.server +
    '/Items/' +
    p.Id +
    '/Images/Primary' +
    // same parameter order and quality as imgUrl(), so the Person screen's
    // header photo is the cast strip's cached image, not a second download
    qs({ tag: p.PrimaryImageTag, quality: 85, maxHeight: 280 })
  );
}
