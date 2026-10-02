/* Automatic freshness for the browse screens (replaces pull-to-refresh).
 *
 * While the app is on screen, every CHECK_EVERY (and on every return to the
 * foreground) it asks Jellyfin three tiny questions whose answers change when
 * the library does — each a Limit=1 /Items query with no fields and no images,
 * ~0.5–0.9 KB (measured against the live server, 2026-09-30):
 *
 *   movie   newest Movie by DateCreated + the Movie count      → added / deleted
 *   tv      newest Episode by DateCreated + the Episode count  → added / deleted
 *   played  the most recently played Movie/Episode + its UserData
 *           (position, Played, PlayCount, LastPlayedDate)       → watched anywhere
 *
 * and tells subscribers what moved (onLibraryChange):
 *   { movie, tv, played, progress, type }
 *     movie / tv   something of that kind was added or removed
 *     played       an item's watched state changed, or another item was played
 *                  last (type: 'movie' | 'tv', the kind of that item)
 *     progress     only the position of the last played item moved — someone is
 *                  watching on another device; Continue Watching wants it, a
 *                  poster grid doesn't
 * Subscribers revalidate only what that touches, apply it once the finger is
 * off the screen (whenSettled) and keep what's under it in place (keepScroll).
 *
 * Also checks at once when an import lands ("Ready to watch", landed.svelte.js
 * — the moment something new was added) and when a push arrives while the app
 * is open (sw.js posts `vr-changed`).
 *
 * Never while hidden, under the player or Login, before boot, or offline. After
 * the player closes, the next answer only becomes the new baseline: the
 * screens reload on R.playerClosed themselves. Idle back-off as on the TV's
 * activity poll: after 10 min without a touch every 5 min, after 1 h every
 * 15 min; the first touch after that checks at once. */
import { api, itemsPath } from '$lib/api.js';
import { cfg } from '$lib/config.js';
import { landed } from '$lib/landed.svelte.js';
import { R } from './router.svelte.js';
import { conn } from './conn.svelte.js';

const CHECK_EVERY = 90 * 1000;
const IDLE_AFTER = 10 * 60 * 1000;
const IDLE_EVERY = 5 * 60 * 1000;
const LONG_IDLE = 60 * 60 * 1000;
const LONG_EVERY = 15 * 60 * 1000;

const Q = {
  movie: () => marker('Movie', 'DateCreated', false),
  tv: () => marker('Episode', 'DateCreated', false),
  played: () => marker('Movie,Episode', 'DatePlayed', true)
};
function marker(types, sort, userData) {
  return itemsPath({
    Recursive: true,
    IncludeItemTypes: types,
    SortBy: sort,
    SortOrder: 'Descending',
    Limit: 1,
    EnableImages: false,
    EnableUserData: userData
  });
}

const subs = new Set();
let sig = null;        // { movie, tv, played, pos } of the last answer; null: no baseline
let rebaseNext = false;
let timer = 0;
let inflight = null;
let lastCheck = 0;
let lastInput = Date.now();
let started = false;

/* fn(change) → unsubscribe. The first subscriber starts the checks. */
export function onLibraryChange(fn) {
  subs.add(fn);
  start();
  return () => subs.delete(fn);
}

/* The next answer is only the new baseline — call after a change this app
 * made itself and already repainted for (marked watched, the player closed). */
export function rebase() {
  rebaseNext = true;
}

function gateOpen() {
  return (
    document.visibilityState !== 'hidden' &&
    R.booted &&
    !R.modal &&
    !conn.offline &&
    navigator.onLine !== false &&
    !!cfg.token &&
    !!cfg.userId
  );
}

function period() {
  const idle = Date.now() - lastInput;
  return idle > LONG_IDLE ? LONG_EVERY : idle > IDLE_AFTER ? IDLE_EVERY : CHECK_EVERY;
}

function schedule(ms = period()) {
  clearTimeout(timer);
  timer = 0;
  if (!gateOpen()) return;
  timer = setTimeout(check, Math.max(0, ms));
}

/* A check now (debounced a little: a landing, a push and a resume can come together). */
export function checkSoon(ms = 400) {
  if (!started) return;
  schedule(ms);
}

async function check() {
  timer = 0;
  if (!gateOpen()) return;
  if (inflight) return inflight;
  inflight = run().finally(() => {
    inflight = null;
    lastCheck = Date.now();
    schedule();
  });
  return inflight;
}

async function run() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  let r;
  try {
    const [m, e, p] = await Promise.all(['movie', 'tv', 'played'].map((k) => api(Q[k](), { signal: ctl.signal })));
    r = { m, e, p };
  } catch {
    return; // network trouble: conn / reconnect own the banner; try again next period
  } finally {
    clearTimeout(t);
  }
  const top = (d) => (d && d.Items && d.Items[0]) || null;
  const pi = top(r.p);
  const ud = (pi && pi.UserData) || {};
  const next = {
    movie: (r.m.TotalRecordCount ?? '') + ':' + (top(r.m)?.Id || ''),
    tv: (r.e.TotalRecordCount ?? '') + ':' + (top(r.e)?.Id || ''),
    played: pi ? pi.Id + ':' + !!ud.Played + ':' + (ud.PlayCount || 0) : '',
    pos: pi ? pi.Id + ':' + (ud.PlaybackPositionTicks || 0) + ':' + (ud.LastPlayedDate || '') : ''
  };
  const prev = sig;
  sig = next;
  if (!prev || rebaseNext || R.modal) {
    rebaseNext = false;
    return;
  }
  const ch = {
    movie: next.movie !== prev.movie,
    tv: next.tv !== prev.tv,
    played: next.played !== prev.played,
    progress: next.played === prev.played && next.pos !== prev.pos,
    type: pi ? (pi.Type === 'Episode' ? 'tv' : 'movie') : null
  };
  if (!ch.movie && !ch.tv && !ch.played && !ch.progress) return;
  for (const fn of [...subs]) {
    try {
      fn(ch);
    } catch {
      /* one subscriber must not stop the others */
    }
  }
}

function start() {
  if (started) return;
  started = true;
  const o = { capture: true, passive: true };
  const onInput = () => {
    const wasIdle = Date.now() - lastInput > IDLE_AFTER;
    lastInput = Date.now();
    if (wasIdle) checkSoon(0);
  };
  for (const t of ['touchstart', 'pointerdown', 'keydown', 'wheel']) addEventListener(t, onInput, o);
  // hidden: stop; back in front: check (the resume itself is not "input")
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      clearTimeout(timer);
      timer = 0;
    } else checkSoon(800);
  });
  addEventListener('online', () => checkSoon(2000));
  // push while open (sw.js): something was added / became ready
  navigator.serviceWorker?.addEventListener?.('message', (e) => {
    if (e.data && e.data.type === 'vr-changed') checkSoon(1500);
  });
  $effect.root(() => {
    // the gate: boot, modals, the offline banner
    $effect(() => {
      const open = R.booted && !R.modal && !conn.offline;
      if (!open) {
        clearTimeout(timer);
        timer = 0;
        return;
      }
      // the first time: the baseline now; after a pause: at once if it's due
      const due = lastCheck ? lastCheck + period() - Date.now() : 0;
      schedule(Math.max(300, due));
    });
    // the player closed: the screens reload by themselves — its answer is the baseline
    let closed = R.playerClosed;
    $effect(() => {
      const n = R.playerClosed;
      if (n === closed) return;
      closed = n;
      rebase();
      checkSoon(4000); // after the Stopped report has been stored
    });
    // an import landed (confirmed in Jellyfin): check now, not in 90 s
    let landSig = null;
    $effect(() => {
      const s = landed.items.map((x) => x.key + ':' + x.eps.length + ':' + x.at).join('|');
      if (landSig !== null && s !== landSig) checkSoon(300);
      landSig = s;
    });
  });
}

/* dev: `__freshness.check()` runs one now; `.state()` the last answer */
if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__freshness = { check: () => (clearTimeout(timer), check()), state: () => ({ sig, lastCheck, period: period() }) };
}

/* ------------------------------------------------ applying it gently ---- */

/* The finger is on the screen, or a scroll (momentum included) ran in the
 * last 700 ms: a list that reorders now moves under the user. */
let touches = 0;
let lastScroll = 0;
let tracking = false;
function track() {
  if (tracking) return;
  tracking = true;
  const o = { capture: true, passive: true };
  addEventListener('touchstart', (e) => (touches = e.touches.length), o);
  addEventListener('touchend', (e) => (touches = e.touches.length), o);
  addEventListener('touchcancel', (e) => (touches = e.touches.length), o);
  // iOS sends touchend only to the touched node; if a re-render detached it,
  // window never hears it — pointerup still arrives
  addEventListener('pointerup', (e) => { if (e.pointerType === 'touch' && e.isPrimary) touches = 0; }, o);
  addEventListener('pointercancel', (e) => { if (e.pointerType === 'touch' && e.isPrimary) touches = 0; }, o);
  addEventListener('scroll', () => (lastScroll = Date.now()), o);
}
track();

/* Resolves once nothing is touching or scrolling. */
export function whenSettled() {
  const quiet = () => touches === 0 && Date.now() - lastScroll > 700;
  if (quiet()) return Promise.resolve();
  return new Promise((res) => {
    const t = setInterval(() => {
      if (quiet()) {
        clearInterval(t);
        res();
      }
    }, 250);
  });
}

/* Keep what's on screen where it is across a re-render of `root`'s content:
 * call before the data changes, then call the returned restore() after
 * Svelte has flushed (await tick()). Vertically the first `rows` element
 * reaching below the top edge is the anchor (only when scrolled — at the top,
 * new things may appear there); in every scrolled horizontal rail, its first
 * visible tile. Tiles are measured by layout (offsetLeft against the first
 * tile), so a running flip animation doesn't skew them. */
export function keepScroll(root, rows = ':scope > *') {
  if (!root) return () => {};
  let v = null;
  if (root.scrollTop > 0) {
    const top = root.getBoundingClientRect().top;
    for (const el of root.querySelectorAll(rows)) {
      const b = el.getBoundingClientRect();
      if (b.height && b.bottom > top + 1) {
        v = { el, off: b.top - top };
        break;
      }
    }
  }
  const h = [];
  for (const tr of root.querySelectorAll('.rail__track')) {
    if (tr.scrollLeft <= 0) continue;
    const kids = [...tr.children];
    const first = kids[0];
    if (!first) continue;
    const at = (el) => el.offsetLeft - first.offsetLeft;
    const el = kids.find((k) => at(k) + k.offsetWidth > tr.scrollLeft + 1);
    if (el) h.push({ tr, el, off: at(el) - tr.scrollLeft });
  }
  return () => {
    if (v && v.el.isConnected) {
      const d = v.el.getBoundingClientRect().top - root.getBoundingClientRect().top - v.off;
      if (Math.abs(d) >= 1) root.scrollTop += d;
    }
    for (const { tr, el, off } of h) {
      const first = tr.firstElementChild;
      if (!el.isConnected || el.parentElement !== tr || !first) continue;
      const want = el.offsetLeft - first.offsetLeft - off;
      if (Math.abs(want - tr.scrollLeft) >= 1) tr.scrollLeft = want;
    }
  };
}
