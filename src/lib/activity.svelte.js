/* Live download/import activity, merged into the browse UI.
 *
 * The old Activity tab was a standalone list; now the same /api/activity poll
 * feeds the screens where the titles actually live: the Movies/Shows grids grow
 * a synthetic tile for a title Jellyfin doesn't know yet (PendingTile), an
 * existing tile/series gets a subtle badge while new episodes come in, and
 * PendingDetail is the detail view for a not-yet-imported title.
 *
 * One module-level poll, gated by App.svelte on the browse screens ($effect on
 * S.screen), so the player never pays for it. Errors keep the
 * last-known list — a transient blip must not blank every indicator at once.
 *
 * Items are normalised on arrival: the extended backend sends structured
 * media_id / season / episode / episode_title / poster / year fields; against
 * an older backend those are parsed out of `subtitle` ("S03E07 · Episode Title" / the
 * year), leaving poster/media_id null — everything downstream treats them as
 * optional. */
import { mlActivity } from './medialib.js';

/* stale: the poll has been failing for longer than STALE_AFTER. The last list
 * is still kept (tiles and rows must not vanish on a blip), but its numbers are
 * no longer true — badges drop the % and the pulse, PendingDetail says the
 * status is unavailable. The next good poll clears it. */
export const act = $state({ items: [], loaded: false, stale: false });

const PERIOD = 4000;
const STALE_AFTER = 20000;
let timer = null;
let inflight = false;
let lastOk = 0;
let lastSig = '';   // JSON of the last applied items (poll() skips identical answers)
/* Called with every changed answer (landed.svelte.js diffs it for "Ready to watch"). */
let feedHook = null;
export function onFeed(fn) {
  feedHook = fn;
}

/* Input-idle back-off. With the TV's picture turned off ("screen off", the set
 * still on) webOS keeps the page 'visible' with focus and fires no event
 * (measured on the C4, round 7), so the visibility gate in App.svelte never
 * trips and a browse screen left up polled every 4 s indefinitely. There is no
 * web-visible screen-off signal, so go by the remote instead: after IDLE_AFTER
 * without a key/wheel/pointer event the 4 s ticks only poll every IDLE_PERIOD
 * (LONG_PERIOD after an hour), and the first input polls at once and restores
 * the 4 s cadence. The idle threshold is long so someone watching a download's
 * % on PendingDetail without touching the remote isn't cut to once a minute
 * too early. */
const IDLE_AFTER = 10 * 60 * 1000;
const IDLE_PERIOD = 60 * 1000;
const LONG_IDLE = 60 * 60 * 1000;
const LONG_PERIOD = 5 * 60 * 1000;
let lastInput = Date.now();
let lastTry = 0;
let inputBound = false;

function onInput() {
  const now = Date.now();
  const wasIdle = now - lastInput > IDLE_AFTER;
  lastInput = now;
  if (wasIdle && timer) {
    if (lastOk) lastOk = now; // the skipped ticks were not failures
    poll();
  }
}

/* Phone: the 4 s cadence only while something is moving. Polling every 4 s
 * whenever the app was on screen was ~900 requests an hour with nothing in
 * flight, and each one wakes the cellular radio. "Moving" is:
 *  - a grab `downloading` with a live speed — the backend reports qBittorrent's
 *    stalledDL/metaDL and the arr's importBlocked as `downloading` too, at
 *    speed 0, and those can sit for days;
 *  - any change in the feed within the last HOLD (progress, a status word, a
 *    grab appearing or leaving). That covers the end of a download: 100 %,
 *    then the arr notices on its own ~1 min refresh, `importing`, gone — so a
 *    landing is still seen within a poll or two. A stuck `importing` row stops
 *    changing and drops to the slow rate like any other;
 *  - BOOST_FOR after the user started or cancelled something (boostActivity():
 *    an Add, a season Get, a cancel, their undos) — a new grab sits `queued`
 *    or in metadata at speed 0 before it moves.
 * `queued`/`paused`/`warning` alone are not moving. Otherwise every
 * SLOW_PERIOD; the input-idle back-off above still applies on top, and a
 * return to the foreground still polls at once (startActivity). */
const SLOW_PERIOD = 30 * 1000;
const HOLD = 2 * 60 * 1000;
const BOOST_FOR = 2 * 60 * 1000;
let lastChange = 0;
let boostUntil = 0;

export function boostActivity() {
  if (!__PHONE__) return;
  boostUntil = Date.now() + BOOST_FOR;
}

function moving() {
  const now = Date.now();
  if (now < boostUntil || now - lastChange < HOLD) return true;
  return act.items.some((i) => i.status === 'downloading' && i.download_speed > 0);
}

function tick() {
  const idle = Date.now() - lastInput;
  if (idle > IDLE_AFTER) {
    const every = idle > LONG_IDLE ? LONG_PERIOD : IDLE_PERIOD;
    if (Date.now() - lastTry < every - 500) return;
  } else if (__PHONE__ && !moving()) {
    if (Date.now() - lastTry < SLOW_PERIOD - 500) return;
  }
  poll();
}

export function startActivity() {
  if (timer) return;
  if (!inputBound) {
    inputBound = true;
    const o = { capture: true, passive: true };
    for (const t of ['keydown', 'wheel', 'mousemove', 'pointerdown']) window.addEventListener(t, onInput, o);
  }
  // A stop/start (a stretch of playback) is not a failure; judge freshness from now.
  if (lastOk) lastOk = Date.now();
  // Reaching a browse screen (resume, the end of a film) counts as activity.
  lastInput = Date.now();
  poll();
  timer = setInterval(tick, PERIOD);
}

export function stopActivity() {
  clearInterval(timer);
  timer = null;
}

async function poll() {
  if (inflight) return;
  inflight = true;
  lastTry = Date.now();
  try {
    const r = await mlActivity();
    /* An unchanged answer (an idle or all-queued feed, which is most polls)
     * must not replace act.items: that re-runs pendingGroups() in every
     * $derived that reads it, the library grid's per-item matchGroup() pass,
     * and a `pend` prop diff on every tile — every 4 s, while the user is
     * pressing the D-pad. The payload is a few KB, so the compare is cheap. */
    const raw = (r && r.items) || [];
    const sig = JSON.stringify(raw);
    if (sig !== lastSig) {
      // the session's first answer is a baseline, not a change
      if (__PHONE__ && lastSig) lastChange = Date.now();
      lastSig = sig;
      act.items = raw.map(norm);
      try { feedHook?.(act.items); } catch {}
    }
    act.loaded = true;
    lastOk = Date.now();
    if (act.stale) act.stale = false;
  } catch {
    /* keep the last-known list; the next tick retries */
    if (!lastOk) lastOk = Date.now(); // never succeeded: count from the first try
    if (__PHONE__) {
      // at the slow rate the last success is already 30 s old: one blip
      // must not mark the feed stale, two in a row do
      if (!act.stale && Date.now() - lastOk > STALE_AFTER + (moving() ? 0 : SLOW_PERIOD)) act.stale = true;
    } else if (!act.stale && Date.now() - lastOk > STALE_AFTER) act.stale = true;
  } finally {
    inflight = false;
  }
}

const EP_RE = /^S(\d+)\s*E(\d+)(?:\s*·\s*(.*))?$/;

function norm(raw) {
  const it = { ...raw };
  if (it.type === 'tv' && (it.season == null || it.episode == null)) {
    const m = EP_RE.exec(it.subtitle || '');
    if (m) {
      it.season = +m[1];
      it.episode = +m[2];
      if (!it.episode_title && m[3]) it.episode_title = m[3];
    }
  }
  if (it.type !== 'tv' && it.year == null && /^\d{4}$/.test(it.subtitle || '')) {
    it.year = +it.subtitle;
  }
  return it;
}

/* completed = imported; it belongs to the Jellyfin library now, not here */
const ACTIVE = new Set(['queued', 'downloading', 'importing', 'paused', 'warning']);
const RANK = { downloading: 0, importing: 1, queued: 2, warning: 3, paused: 4 };

export const STATUS_LABEL = {
  queued: 'Queued',
  downloading: 'Downloading',
  importing: 'Importing',
  paused: 'Paused',
  warning: 'Problem'
};

/* Release quality ("WEBDL-2160p", "Bluray-1080p", "HDTV-720p") → the same short
 * resolution word a downloaded tile's .techbadge shows, so a queued title wears
 * the identical top-left badge. Sonarr/Radarr always spell the tier with a
 * trailing `p`; the 4K/UHD test is only a guard against an odd profile name. */
export function qualityRes(q) {
  const m = /(\d{3,4})\s*p\b/i.exec(q || '');
  if (!m) return /\b(4k|uhd)\b/i.test(q || '') ? '4K' : '';
  const n = +m[1];
  return n >= 1800 ? '4K' : n + 'p';
}

function qualityRank(q) {
  const m = /(\d{3,4})\s*p\b/i.exec(q || '');
  return m ? +m[1] : /\b(4k|uhd)\b/i.test(q || '') ? 2160 : 0;
}

/* Activity grouped by title: one group per show/movie, its episode grabs under
 * `items` (sorted by season/episode). status is the most-active status of any
 * grab; progress is size-weighted across grabs (plain mean when sizes are
 * missing); res is the best resolution in flight. Reactive — reads act.items,
 * so use from $derived. */
/* Memoised per act.items array (poll() replaces it wholesale, never mutates it):
 * every Search/Trending LookupTile derives its own lookupGroup(), so one poll
 * used to regroup and re-sort the whole feed once per tile. Reading act.items
 * here keeps each caller's $derived subscribed exactly as before. Callers treat
 * the result as read-only. */
let memoSrc = null;
const memo = new Map();   // type -> groups for memoSrc

export function pendingGroups(type) {
  const src = act.items;
  if (src !== memoSrc) {
    memoSrc = src;
    memo.clear();
  }
  let out = memo.get(type);
  if (!out) {
    out = groupsOf(src, type);
    memo.set(type, out);
  }
  return out;
}

function groupsOf(items, type) {
  const map = new Map();
  for (const it of items) {
    if (it.type !== type || !ACTIVE.has(it.status)) continue;
    const key = it.type + ':' + (it.media_id || 't:' + it.title.toLowerCase());
    let g = map.get(key);
    if (!g) {
      g = {
        key, type, title: it.title, mediaId: it.media_id || null, poster: null, year: null, res: '', items: []
      };
      map.set(key, g);
    }
    g.items.push(it);
    if (!g.poster && it.poster) g.poster = it.poster;
    if (!g.year && it.year) g.year = it.year;
  }
  const out = [...map.values()];
  for (const g of out) {
    g.items.sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
    g.status = g.items.reduce((s, i) => ((RANK[i.status] ?? 9) < (RANK[s] ?? 9) ? i.status : s), g.items[0].status);
    let rank = 0;
    for (const i of g.items) {
      const r = qualityRank(i.quality);
      if (r > rank) {
        rank = r;
        g.res = qualityRes(i.quality);
      }
    }
    /* Speed, size, progress and ETA are per *torrent*, not per item: a season
     * pack is one grab that Sonarr's queue lists once per episode, each entry
     * repeating the whole torrent's numbers. Summing items counted a 20-episode
     * pack's speed and size 20×. */
    const grabs = new Map();
    for (const i of g.items) grabs.set(i.download_id || 'i:' + i.id, i);
    let wsum = 0, psum = 0, mean = 0, speed = 0, size = 0, eta = 0, etaStr = null;
    for (const i of grabs.values()) {
      mean += i.progress || 0;
      speed += i.download_speed || 0;
      if (i.size_bytes) {
        size += i.size_bytes;
        wsum += i.size_bytes;
        psum += (i.progress || 0) * i.size_bytes;
      }
      // Grabs run in parallel, so the title is done when the slowest one is.
      const s = etaSec(i.timeleft);
      if (s > eta) {
        eta = s;
        etaStr = i.timeleft;
      }
    }
    g.progress = wsum ? psum / wsum : mean / grabs.size;
    g.speed = speed;
    g.size = size;
    g.timeleft = etaStr;
  }
  out.sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || a.title.localeCompare(b.title));
  return out;
}

/* "1:15:38" / "15:38" / "1.02:03:04" (a day count, as Sonarr writes it) → seconds */
function etaSec(t) {
  if (!t) return 0;
  const [d, rest] = t.includes('.') ? t.split('.') : ['0', t];
  return rest.split(':').reduce((n, x) => n * 60 + (parseInt(x, 10) || 0), 0) + (parseInt(d, 10) || 0) * 86400;
}

export function groupByKey(key) {
  if (!key) return null;
  const type = key.startsWith('movie:') ? 'movie' : 'tv';
  return pendingGroups(type).find((g) => g.key === key) || null;
}

/* Jellyfin stores provider ids under mixed-case keys ('Tvdb' vs 'tvdb'). */
export function providerId(item, name) {
  const ids = item.ProviderIds || {};
  for (const k in ids) if (k.toLowerCase() === name) return String(ids[k]);
  return null;
}

/* The group (if any) that belongs to a Jellyfin library item — provider id
 * match when both sides carry one (exact, and a mismatch is a *different*
 * title even if the names collide), case-insensitive title match otherwise. */
export function matchGroup(groups, item) {
  const type = item.Type === 'Series' ? 'tv' : 'movie';
  const pid = providerId(item, type === 'tv' ? 'tvdb' : 'tmdb');
  const name = (item.Name || '').toLowerCase();
  for (const g of groups) {
    if (g.type !== type) continue;
    if (pid && g.mediaId) {
      if (g.mediaId === pid) return g;
      continue;
    }
    if (g.title.toLowerCase() === name) return g;
  }
  return null;
}

/* A tile in flight is marked by the pulsing gold ring on its poster
 * (`.dlring`), but colour and pulse alone don't say *which* state it is in, so
 * the caption line spells it out too: "Queued", "Downloading 43%",
 * "Importing", "Problem: …". The exact numbers (speed, ETA) live on
 * PendingDetail / SeriesDetail, which have room for them. `ringClass()` is the
 * .dlring modifier: 'stale' once the feed has stopped answering (no pulse). */
export function tileStatus(x) {
  if (act.stale) return 'Status unavailable';
  if (x.status === 'downloading') return 'Downloading ' + Math.round((x.progress || 0) * 100) + '%';
  if (x.status === 'warning') {
    const why = x.message || (x.items || []).map((i) => i.message).find(Boolean);
    return why ? 'Problem: ' + why : 'Problem';
  }
  return STATUS_LABEL[x.status] || x.status || '';
}

export function ringClass(x) {
  return act.stale ? 'stale' : x.status;
}

export function humanBytes(bytes) {
  if (!bytes) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return n.toFixed(n >= 10 || i === 0 ? 0 : 1) + ' ' + u[i];
}

/* The inline download bar on an episode row (SeriesDetail / PendingDetail): a
 * small track in the row's header line, between the release quality and the
 * speed figure. It is the *only* download indicator on the row — the bar under
 * the thumbnail means "how far you watched" everywhere else in the app and must
 * not be borrowed for this.
 *
 * `fill` is the gold width in percent; `active` is false for a grab with nothing
 * on the wire yet, which renders as an empty grey track. Importing shows full:
 * every byte is here, the file is only being moved into place. */
export function dlBar(x) {
  if (act.stale) return { active: false, fill: 0 };
  if (x.status === 'downloading') return { active: true, fill: Math.round((x.progress || 0) * 100) };
  if (x.status === 'importing') return { active: true, fill: 100 };
  return { active: false, fill: 0 };
}

/* What is written after that bar: the live speed while downloading (the
 * percentage when the backend reports no speed), plus the ETA; otherwise the
 * status word — "Queued" for a grab that hasn't started. */
export function dlTail(x) {
  if (act.stale) return 'Status unavailable';
  if (x.status !== 'downloading') return STATUS_LABEL[x.status] || x.status;
  const parts = [x.download_speed ? humanBytes(x.download_speed) + '/s' : Math.round((x.progress || 0) * 100) + '%'];
  if (x.timeleft) parts.push(x.timeleft + ' left');
  return parts.join(' · ');
}

/* Label for the greyed-out stand-in of a Play button: "43% · 7.4 MB/s ·
 * 1:11:24 left" while downloading, the status word otherwise. `x` needs
 * { status, progress, speed?, timeleft? } — pass an item's download_speed as
 * speed when labelling a single grab. */
export function statLabel(x) {
  if (act.stale) return 'Download status unavailable';
  if (x.status !== 'downloading') return STATUS_LABEL[x.status] || x.status;
  const parts = [Math.round((x.progress || 0) * 100) + '%'];
  if (x.speed) parts.push(humanBytes(x.speed) + '/s');
  if (x.timeleft) parts.push(x.timeleft + ' left');
  return parts.join(' · ');
}
