/* Who the signed-in user is to reel-api, what they own and how much room is
 * left — GET /api/me — and "My library"'s Delete (run/design.md §6).
 *
 * Admin = Jellyfin's own Policy.IsAdministrator (reel-api asks Jellyfin): no
 * limit, may delete/cancel/undo anything. A normal user owns at most N movies
 * and N series at once (server config, 10/10 by default), may delete only
 * what they added, and owns nothing added before ownership existed.
 *
 * Fetched on demand only (the TV's avatar menu, LookupDetail; the phone also
 * once after boot) — never at the TV's boot: every fetch() costs 3–9 ms of main
 * thread there. A 404 means a reel-api from before ownership: `unsupported`,
 * never asked again this session, and every helper here then answers as if
 * there were no quota (no My library, no client-side check — the server would
 * enforce one anyway). Account switches reload the app, so `ME` is simply the
 * session's user. */
import { mlMe, mlLibraryDelete, mlMetadata } from './medialib.js';
import { cfg } from './config.js';
import { errText, invalidate } from './api.js';
import { toast } from './toast.svelte.js';
import { adds } from './lookup.svelte.js';
import { boostActivity } from './activity.svelte.js';
import { invalidatePlayState } from './played.js';

/** @type {VR.MeState} */
export const ME = $state(/** @satisfies {VR.MeState} */ ({ state: 'idle', me: null, at: 0 }));

/* title key ("movie:603") → true while its delete runs: the row dims, its
 * Delete is a no-op */
/** @type {Record<string, boolean>} */
export const deleting = $state({});

/* The TV's My library panel: the title whose Delete is being confirmed
 * (MyLibraryMenu.svelte; Keys.svelte's Back returns from it onto its row). */
/** @type {VR.MyLibState} */
export const MY = $state(/** @satisfies {VR.MyLibState} */ ({ confirm: null }));

const NOUN = /** @type {const} */ ({ movie: ['movie', 'movies'], tv: ['show', 'shows'] });

/* Bumped by every local change to ME.me (an add counted, a delete applied, a
 * 409's numbers): an answer to a request sent before it is older than what we
 * know and is dropped, and a refresh asked for after it doesn't share that
 * request. */
let ver = 0;
/** @type {{ v: number, p: Promise<Reel.Me | null> } | null} */
let inflight = null;

/* Ask reel-api again. `maxAge` (ms): keep an answer that recent. Resolves to
 * the fresh answer, or null when it failed, the backend has no /api/me, or
 * nobody is signed in (then nothing is sent). Concurrent callers share one
 * request. */
/** @param {{ maxAge?: number }} [opts] @returns {Promise<Reel.Me | null>} */
export function refreshMe({ maxAge = 0 } = {}) {
  if (!cfg.token || ME.state === 'unsupported') return Promise.resolve(null);
  if (inflight && inflight.v === ver) return inflight.p;
  if (!inflight && maxAge && ME.me && ME.state === 'ok' && Date.now() - ME.at < maxAge) return Promise.resolve(ME.me);
  const v = ver;
  const p = mlMe().then(
    (me) => {
      if (v === ver) {
        ME.me = me;
        ME.state = 'ok';
        ME.at = Date.now();
      }
      return me;
    },
    /** @param {VR.ApiError} e @returns {null} */ (e) => {
      if (e.status === 404) {
        ME.state = 'unsupported';
        ME.me = null;
      } else if (v === ver) ME.state = 'error';
      return null;
    }
  );
  const entry = { v, p };
  inflight = entry;
  p.finally(() => {
    if (inflight === entry) inflight = null;
  });
  return p;
}

/** @param {Reel.MediaType} type @returns {Reel.QuotaUse | null} */
function use(type) {
  return (ME.me && ME.me.quota && ME.me.quota[type]) || null;
}

/* A normal user at (or over) the limit, as the server last said. False for an
 * admin, before the first answer and against an old backend. Reactive. */
/** @param {Reel.MediaType} type @returns {boolean} */
export function quotaFull(type) {
  const q = use(type);
  return !!ME.me && !ME.me.admin && !!q && q.limit != null && q.used >= q.limit;
}

/** @param {Reel.MediaType} type @param {number} n @returns {string} */
function noun(type, n) {
  return NOUN[type][n === 1 ? 0 : 1];
}

/* "10/10 movies", "3/10 shows" ("1/1 movie"); an admin just the count. */
/** @param {Reel.MediaType} type @returns {string} */
export function quotaLine(type) {
  const q = use(type);
  if (!q) return '';
  if (q.limit == null) return q.used + ' ' + noun(type, q.used);
  return q.used + '/' + q.limit + ' ' + noun(type, q.limit);
}

/* "3 of 10 movies" ("1 of 1 show"); an admin "3 movies"; '' without an answer. */
/** @param {Reel.MediaType} type @returns {string} */
export function quotaWords(type) {
  const q = use(type);
  if (!q) return '';
  if (q.limit == null) return q.used + ' ' + noun(type, q.used);
  return q.used + ' of ' + q.limit + ' ' + noun(type, q.limit);
}

/* The avatar menu's / Accounts sheet's sub line: "3 of 10 movies · 2 of 10
 * shows", "Admin · no limit"; '' without an answer. */
/** @returns {string} */
export function quotaSummary() {
  const m = ME.me;
  if (!m) return '';
  if (m.admin) return 'Admin · no limit';
  return quotaWords('movie') + ' · ' + quotaWords('tv');
}

/* The toast for an add the client refused itself (quotaFull). */
/** @param {Reel.MediaType} type @returns {string} */
export function quotaToast(type) {
  return 'Quota full (' + quotaLine(type) + ') — delete one in My library to add another';
}

/* POST /api/library answered 409 quota_exceeded: the server knows better than
 * our last /api/me — take its numbers. Returns the toast text. */
/** @param {VR.ApiError} e @returns {string} */
export function quotaFromError(e) {
  const b = e.body;
  if (!b || (b.type !== 'movie' && b.type !== 'tv') || typeof b.used !== 'number' || typeof b.limit !== 'number' || b.limit === 0) return errText(e);
  /** @type {Reel.MediaType} */
  const type = b.type;
  const q = { used: b.used, limit: b.limit };
  if (ME.me && !ME.me.admin) {
    ver++;
    ME.me.quota[type] = q;
  }
  return 'Quota full (' + q.used + '/' + q.limit + ' ' + noun(type, q.limit) + ') — delete one in My library to add another';
}

/* An add went through: it counts at once (the caller then asks again). */
/** @param {Reel.MediaType} type */
export function noteAdded(type) {
  const q = use(type);
  if (!q) return;
  ver++;
  q.used += 1;
}

/** @param {Pick<Reel.OwnedTitle, 'type' | 'id'>} t @returns {string} */
export function titleKey(t) {
  return t.type + ':' + t.id;
}

/** @type {Record<string, string>} */
const STATUS = {
  downloading: 'Downloading',
  queued: 'Queued',
  importing: 'Importing',
  paused: 'Paused',
  warning: 'Needs attention',
  waiting: 'Waiting for a release',
  in_library: 'In your library'
};

/* A My library row's status line: "Downloading · 43%", "In your library",
 * "Deleting…" while its delete runs. `live` (the phone: the title's activity
 * group, which moves with every poll) wins over the server's snapshot. */
/** @param {Reel.OwnedTitle} t @param {Pick<VR.ActivityGroup, 'status' | 'progress'> | null} [live] @returns {string} */
export function titleStatus(t, live = null) {
  if (deleting[titleKey(t)]) return 'Deleting…';
  const status = live ? live.status : t.status;
  const progress = live ? live.progress : t.progress;
  if (status === 'downloading' && progress != null) return 'Downloading · ' + Math.round(progress * 100) + '%';
  return STATUS[status] || status;
}

/* What the Delete confirmation says (both apps). */
/** @param {Reel.MediaType} type @returns {string} */
export function deleteMessage(type) {
  return type === 'tv'
    ? 'The show, every season and all its files are deleted from the server — for everyone. This can’t be undone.'
    : 'The film and its files are deleted from the server — for everyone. This can’t be undone.';
}

/* My library's Delete, after the confirmation: the title leaves Sonarr/Radarr
 * with its files (reel-api checks it is the caller's, or the caller is an
 * admin). On success (a 404 too — it is gone either way) the row and its
 * quota slot go at once, then /api/me is asked again. A failure leaves the row
 * and says why: the server's sentence for 403 not_owner / 409 importing. The
 * caller moves focus. */
/** @param {Reel.OwnedTitle} t @returns {Promise<boolean>} */
export async function deleteTitle(t) {
  const k = titleKey(t);
  if (deleting[k]) return false;
  deleting[k] = true;
  try {
    await mlLibraryDelete({ type: t.type, id: t.id });
    toast('Deleted “' + t.title + '”');
  } catch (err) {
    const e = /** @type {VR.ApiError} */ (err);
    if (e.status !== 404) {
      delete deleting[k];
      toast(
        e.status === 403 || e.code === 'importing'
          ? errText(e)
          : e.retriable
            ? 'Library busy — try again in a moment'
            : 'Couldn’t delete: ' + errText(e)
      );
      return false;
    }
    toast('Already gone — “' + t.title + '”');
  }
  ver++;
  if (ME.me) {
    const i = ME.me.titles.findIndex((x) => x.type === t.type && x.id === t.id);
    if (i >= 0) {
      ME.me.titles.splice(i, 1);
      const q = ME.me.quota[t.type];
      if (q && q.used > 0) q.used -= 1;
    }
  }
  delete deleting[k];
  adds[k] = 'idle'; // Search / LookupDetail offer Add again
  mlMetadata.evict(t.type, t.id);
  invalidatePlayState(); // Home's rails
  invalidate('/Items?'); // the library grids (Jellyfin drops the item on its next scan)
  boostActivity(); // its grabs leave the feed
  refreshMe();
  return true;
}
