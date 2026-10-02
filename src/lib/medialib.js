/* Client for the personal media-library service (contract at cfg.medialib).
 *
 * reel-api (backend/): Sonarr/Radarr lookup and add, the download activity
 * feed, watch-while-downloading streams, metadata, trending, charts, trailers
 * and news. Framework-free (this is a src/lib/*.js module) — the screens own
 * all reactive state.
 *
 * Errors are normalised to an Error with:
 *   .status     HTTP status
 *   .code       the service's `error` code ('not_found', 'bad_id', …) when present
 *   .retriable  true only for 503 (a node was momentarily unreachable)
 *   .retryAfter seconds from Retry-After on a 503 (falls back to 60)
 * so the screen can branch on kind without re-reading the response. */
import { qs } from './api.js';
import { cfg } from './config.js';

const ML_TIMEOUT = 30000;

async function mlFetch(path, { retryOn503 = false, method = 'GET', body, signal } = {}) {
  let r;
  /* A deadline, because a hung answer is worse than a failed one: the activity
   * and news polls skip a tick while their request is in flight, so a request
   * that never settles would freeze the badges on their last % for the rest of
   * the session (never flipping to stale), and a search would spin forever. */
  /* `signal` (optional): the caller's own cancel, combined with the deadline —
   * Search aborts a lookup the next keystroke has superseded. */
  const deadline = AbortSignal.timeout(ML_TIMEOUT);
  const opts = { method, signal: signal ? AbortSignal.any([signal, deadline]) : deadline };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  try {
    r = await fetch(cfg.medialib + path, opts);
  } catch (netErr) {
    // DNS/connection failure or timeout — the service or the node is unreachable.
    // (the TV's Chromium 120 rejects a timed-out fetch as AbortError, not TimeoutError)
    const e = new Error(opts.signal.aborted ? 'media library timed out' : 'media library unreachable');
    e.status = 0;
    e.retriable = true;
    throw e;
  }

  if (r.status === 503) {
    const retryAfter = Number(r.headers.get('Retry-After')) || 60;
    if (retryOn503) {
      await new Promise((res) => setTimeout(res, Math.min(retryAfter, 60) * 1000));
      return mlFetch(path, { retryOn503: false, method, body, signal });
    }
    /* reel-api 503s carry { error, detail }. Two are NOT a blip: 'not_available'
     * (that media type has no Sonarr/Radarr configured — no Retry-After,
     * retrying never helps) and the probe's 'probing unavailable' (no ffprobe).
     * Keep code/detail so callers can tell them from a busy backend. */
    let b503 = null;
    try {
      b503 = await r.json();
    } catch {}
    const e = new Error((b503 && b503.detail) || 'temporarily unavailable');
    e.status = 503;
    e.code = (b503 && b503.error) || 'temporarily_unavailable';
    e.detail = b503 && b503.detail;
    e.retriable = e.code !== 'not_available';
    e.retryAfter = retryAfter;
    throw e;
  }

  if (!r.ok) {
    let body = null;
    try {
      body = await r.json();
    } catch {
      /* non-JSON error body — fall through to a status-only message */
    }
    const e = new Error((body && (body.detail || body.error)) || 'HTTP ' + r.status);
    e.status = r.status;
    e.code = body && body.error;
    throw e;
  }

  return r.json();
}

/* GET /api/lookup — { q, type: 'tv'|'movie' } → { query, type, results[] }.
 * Each result is { id, type, title, year, overview, poster, added, votes,
 * original_title }: `id` is
 * opaque (hand it back to mlLibraryAdd verbatim), `poster` is a remote https
 * image URL usable straight in an <img> (or null), and `added` is true when the
 * title is already in the library. `votes` is an IMDb-scale vote count used to
 * rank results (searchrank.js); 0/absent from an older backend. `original_title`
 * is Radarr's original-language title when it differs (null otherwise, and
 * always for shows). `q` must be
 * non-empty; the caller guards it. */
export function mlLookup({ q, type }, signal) {
  return mlFetch('/api/lookup' + qs({ q, type }), { signal });
}

/* GET /api/trending — { type: 'tv'|'movie' } → { type, results[] }: new titles
 * that are popular on IMDb right now and rated well there (4 weeks to 6 months
 * out, ★ ≥ 7.5 from ≥ 10k votes, top 1000 by popularity), most popular first.
 * Each result is an /api/lookup result plus imdb_id, rating, rating_votes,
 * rank, released (ISO date; a show's first episode) and, for movies,
 * digital_release (ISO date or null) — still in cinemas when that is ahead. */
export function mlTrending(type) {
  return mlFetch('/api/trending' + qs({ type })).then((r) => (r && (r.results = uniqResults(r.results)), r));
}

/* Trending and chart results are IMDb titles resolved to tvdb/tmdb ids
 * server-side, and two IMDb entries can resolve to the same series (IMDb
 * splits some anime/mini-series that TheTVDB keeps as one). The server does not
 * de-duplicate; the rails and grids key their {#each} and data-focus by
 * type:id, so a repeat would break the keyed list and the D-pad. First wins. */
function uniqResults(list) {
  const seen = new Set();
  return (list || []).filter((it) => {
    const k = it.type + ':' + it.id;
    return !seen.has(k) && seen.add(k);
  });
}

/* GET /api/charts — { categories[] }: the browse categories under the Search
 * bar, IMDb's own rankings. Each is { key, title, types, count, posters[] }:
 * `top-movie` / `top-tv` (the Top 250 charts) and `genre-<Genre>` (the 20
 * best-rated movies and shows of a genre); `posters` are a few IMDb thumbnail
 * URLs for the category card. */
export function mlCharts() {
  return mlFetch('/api/charts');
}

/* GET /api/charts/{key} — { key, title, sections[] }, one section per kind
 * ({ type, title, results[] }). Results are /api/lookup results plus imdb_id,
 * rating, rating_votes and rank (1-based chart position), in chart order. */
export function mlChart(key) {
  return mlFetch('/api/charts/' + encodeURIComponent(key)).then((c) => {
    for (const s of (c && c.sections) || []) s.results = uniqResults(s.results);
    return c;
  });
}

/* POST /api/library — add a looked-up title to the library. { id, type } in,
 * 202 { id, type, title, status: 'added', undo } out (`undo`: the token for
 * mlLibraryUndo, null from an older backend). A 409 with error
 * 'already_added' means it is already present; the Fetch screen treats that as
 * success rather than an error. */
export function mlLibraryAdd({ id, type }) {
  return mlFetch('/api/library', { method: 'POST', body: { id, type } });
}

/* DELETE /api/library/{type}/{id}?undo= — undo one add. `undo` is the token
 * the add's 202 carried (`undo`, valid ~10 min, lost on a service restart).
 * 200 { id, type, title, status: 'removed' | 'removing' | 'already_removed',
 * downloads_removed }: the title leaves Sonarr/Radarr and its grabs are
 * cancelled with their partial data ('removing' = the arr's search is still
 * running; the server finishes the removal right after it). Errors: 410
 * 'undo_expired'; 409 'has_files' / 'importing' / 'not_ours' — something of it
 * is (becoming) a library file, which an undo never deletes. */
export function mlLibraryUndo({ id, type, undo }) {
  return mlFetch('/api/library/' + type + '/' + encodeURIComponent(id) + qs({ undo }), { method: 'DELETE' });
}

/* DELETE /api/activity/{type}/{id}[?season=&episode=&blocklist=] — cancel a
 * title's downloads in flight (id = the activity item's media_id), or one
 * season's / episode's. The grabs leave the Sonarr/Radarr queue and
 * qBittorrent with their partial data, and what they were for is unmonitored
 * so it isn't grabbed again. A torrent goes as a whole: one episode of a season
 * pack cancels the pack. `blocklist` (default off) also marks the release as
 * bad. 200 { id, type, status: 'cancelled', downloads_removed,
 * episodes[{season, episode}], unmonitored, kept }; 404 'not_in_queue' when
 * nothing matches (already gone — treat as done); 409 'importing'. */
export function mlCancelDownload({ type, id, season, episode, blocklist }) {
  return mlFetch('/api/activity/' + type + '/' + encodeURIComponent(id) + qs({ season, episode, blocklist }), {
    method: 'DELETE'
  });
}

/* GET /api/activity — live progress of everything the library is pulling in
 * after a title was added. Read-only; activity.svelte.js polls it and merges
 * the items into the browse screens. Returns { items[] } where each item is
 *   { id, type: 'tv'|'movie', title, subtitle, status, progress, size_bytes,
 *     timeleft, quality, media_id, season, episode, episode_title, poster,
 *     year }:
 * `subtitle` is "S03E07 · Episode Title" for a show or the year for a movie; `status`
 * is one of queued | downloading | importing | completed | paused | warning;
 * `progress` is 0..1; `size_bytes`, `timeleft` ("HH:MM:SS") and `quality` may
 * each be null. The structured fields are the identity/metadata the browse
 * merge needs — `media_id` is the same tvdb/tmdb id /api/lookup hands out,
 * `poster` a remote https image URL, `download_id` the grab's handle for
 * mlStreamUrl/mlProbe (watch-while-downloading) — and are null/absent from a
 * backend older than this contract (activity.svelte.js falls back to parsing
 * `subtitle`). */
export function mlActivity() {
  return mlFetch('/api/activity');
}

/* GET /api/news — new seasons of the shows already in Sonarr that have no file
 * yet: { items[] }, each { id, kind: 'aired'|'upcoming', media_id, title,
 * year, poster, fanart, season, premiere, last_aired, episodes_aired,
 * episodes_total, monitored }. `id` ("{tvdb}:{season}:{kind}") is stable, so
 * it is what "seen" is remembered by; `premiere`/`last_aired` are ISO UTC
 * (premiere null = announced without a date). Aired come first, newest first;
 * then upcoming, soonest first. Cached ~10 min server-side. */
export function mlNews() {
  return mlFetch('/api/news');
}

/* POST /api/news/search — { id (tvdb), season } → 202 { id, season, title,
 * status: 'searching', undo }: monitors the season and starts a Sonarr season
 * search (`undo`: the token for mlSeasonSearchUndo). 409 'not_aired' for a
 * season with nothing out yet. */
export function mlSeasonSearch({ id, season }) {
  return mlFetch('/api/news/search', { method: 'POST', body: { id, season } });
}

/* DELETE /api/news/search/{undo} — undo one season search (`undo` from its
 * 202): the season's monitoring flags go back to what they were and the grabs
 * the search made are cancelled with their partial data (a search still
 * running is watched until it ends). 200 { id, season, title, status:
 * 'reverted', downloads_removed, kept } (kept = already importing, left
 * alone); 410 'undo_expired'. */
export function mlSeasonSearchUndo(undo) {
  return mlFetch('/api/news/search/' + encodeURIComponent(undo), { method: 'DELETE' });
}

/* GET /api/metadata/{type}/{id} — everything Sonarr/Radarr know about one
 * title (id = the same opaque lookup id): { id, type, title, year, overview,
 * poster, fanart, runtime_min, genres[], rating, certification, status,
 * episodes[] } where each episode is { season, episode, title, overview,
 * air_date, still, has_file } (tv only; `still` is a remote TVDB screencap or
 * null). This is what lets the pending screens render a queued title exactly
 * like a downloaded one. Cached for the session — the metadata of a title
 * changes on the scale of weeks, and one tv answer can be several hundred
 * episodes. The cache holds the promise, so concurrent callers share one
 * request; a rejection evicts itself so the next caller retries. */
const metaCache = new Map();
/* Phone: the session cache is LRU-capped. One tv answer is several hundred
 * episodes with overviews, and a phone session browses Search, Trending and
 * collections for hours inside a much smaller memory budget than the TV's.
 * Map order is the recency order (a hit re-inserts); dropping an entry that is
 * still in flight only means the next caller fetches again — whoever already
 * holds the promise still gets its answer. */
const META_KEEP = 30;
function metaLru(type, id) {
  const k = type + ':' + id;
  let p = metaCache.get(k);
  if (p) {
    metaCache.delete(k);
    metaCache.set(k, p);
    return p;
  }
  p = mlFetch('/api/metadata/' + type + '/' + encodeURIComponent(id));
  // a rejection evicts only itself, not a newer request under the same key
  p.catch(() => metaCache.get(k) === p && metaCache.delete(k));
  metaCache.set(k, p);
  while (metaCache.size > META_KEEP) metaCache.delete(metaCache.keys().next().value);
  return p;
}
export function mlMetadata(type, id) {
  if (__PHONE__) return metaLru(type, id);
  const k = type + ':' + id;
  let p = metaCache.get(k);
  if (!p) {
    p = mlFetch('/api/metadata/' + type + '/' + encodeURIComponent(id));
    p.catch(() => metaCache.delete(k));
    metaCache.set(k, p);
  }
  return p;
}
/* Forget one answer — a series added this session gains its episode list. */
mlMetadata.evict = (type, id) => metaCache.delete(type + ':' + id);

/* GET /api/segments/{imdb}/{season}/{episode} — IntroDB's crowdsourced skip
 * windows for one episode (reel-api proxies and caches it): { intro, recap,
 * outro }, each { start, end, submissions } in seconds, or null. Keyed by the
 * *series'* IMDb id. Session-cached; see segments.js for why recaps come from
 * here rather than from Jellyfin. */
const segCache = new Map();
export function mlSegments(imdb, season, episode) {
  const k = imdb + ':' + season + ':' + episode;
  let p = segCache.get(k);
  if (!p) {
    p = mlFetch('/api/segments/' + encodeURIComponent(imdb) + '/' + season + '/' + episode);
    p.catch(() => segCache.delete(k));
    segCache.set(k, p);
  }
  return p;
}

/* GET /api/collection/{id} — a TMDB movie collection (Jellyfin's
 * ProviderIds.TmdbCollection, or metadata's `collection.id`): { id, title,
 * overview, poster, fanart, movies[] }, the films in release order, each
 * lookup-shaped (id = tmdb id, `added` from Radarr) plus `rating`/`released`.
 * Session-cached like mlMetadata; the `added` flags are re-seeded from
 * adds (lookup.svelte.js), which tracks adds made since. */
const collCache = new Map();
export function mlCollection(id) {
  let p = collCache.get(id);
  if (!p) {
    p = mlFetch('/api/collection/' + encodeURIComponent(id));
    p.catch(() => collCache.delete(id));
    collCache.set(id, p);
  }
  return p;
}

/* Watch-while-downloading (see src/lib/pendingplay.js).
 *
 * mlStreamUrl — the direct playback URL for a grab's main video file. The
 * service serves it with Range support while the torrent is still coming in,
 * waiting at the download frontier instead of 404ing; a finished download
 * behaves like a plain file server. `id` is the activity item's download_id.
 *
 * mlProbe — GET /api/downloads/{id}/probe: ffprobe of the (partial) file once
 * its header is on disk. { container, duration_s, bitrate, size_bytes,
 * video: { codec, width, height, hdr: 'DV'|'HDR10'|'HLG'|null, fps },
 * audio[]: { index, codec, channels, layout, lang, title, atmos, default },
 * subtitles[]: {...} }. A 409 error with code 'not_ready' means not enough of
 * the file has arrived yet — retry in a few seconds. Cached per id: the track
 * layout of a file never changes. */
export function mlStreamUrl(id) {
  return cfg.medialib + '/api/downloads/' + encodeURIComponent(id) + '/stream';
}

const probeCache = new Map();
export function mlProbe(id) {
  let p = probeCache.get(id);
  if (!p) {
    p = mlFetch('/api/downloads/' + encodeURIComponent(id) + '/probe');
    p.catch(() => probeCache.delete(id));
    probeCache.set(id, p);
  }
  return p;
}

/* Sonarr/Radarr hand out the artwork CDN's FULL-SIZE poster: TMDB's
 * `/t/p/original` is ~900 KB at 2000×3000, TVDB's v4 posters are 680×1000. A
 * library grid tile paints that into a 239×358 box, and on this TV the decode —
 * plus the re-raster the 1.05 focus scale forces on top of it — is a visible
 * stall the moment the D-pad lands on the tile. Both CDNs publish a ~340-wide
 * variant that is exactly the tile size (TMDB by path segment, TVDB by an `_t`
 * suffix), so ask for that wherever the image is rendered small. Anything else
 * (an unknown host, an already-thumbnailed TVDB URL) is returned untouched. */
export function posterThumb(url) {
  if (!url) return url;
  const tmdb = /^(https?:\/\/image\.tmdb\.org\/t\/p\/)[^/]+(\/.+)$/.exec(url);
  if (tmdb) return tmdb[1] + 'w342' + tmdb[2];
  const tvdb = /^(https?:\/\/artworks\.thetvdb\.com\/\S+?)(\.[a-z]{3,4})$/i.exec(url);
  if (tvdb && !tvdb[1].endsWith('_t')) return tvdb[1] + '_t' + tvdb[2];
  return url;
}
