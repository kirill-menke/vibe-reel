/* State restore (polish PWA-05): come back where the user was after iOS
 * evicted the suspended app, and after an update reload (PWA-06) — as a
 * native app does — instead of a cold start on Home.
 *
 *   saveRoute()        lifecycle.js, on every trip to the background, and
 *                      swupdate.js right before an update reload: writes
 *                      localStorage['reel.route'] = { v, user, at, tab,
 *                      stacks: { tab: [{ name, params, y }] } } — every tab's
 *                      stack above its root (last DEPTH routes), y = the
 *                      page's `.screen` scrollTop.
 *   closeRoute(e)      lifecycle.js, on `pagehide`: the user swiped the app
 *                      away (a memory kill of the frozen app fires nothing) —
 *                      marks the snapshot `closed` unless this is an update
 *                      reload (updateReloading()) or a bfcache hide.
 *   routeResumed()     lifecycle.js, on the way back up: a `pagehide` that the
 *                      page survived means this WebKit also fires it on a
 *                      plain trip to the background — remembered
 *                      (reel.route.hidePagehide), and from then on a `closed`
 *                      snapshot is still restored if it is < 30 min old.
 *   restoreRoute()     main.js, before the first mount (and before
 *                      initPushLinks() strips a ?open= deep link, which wins):
 *                      same account, < 12 h old, not closed → the stacks are
 *                      rebuilt without animation (router.restoreStacks), the
 *                      tab re-selected, and each page's scroll put back the
 *                      first time it shows, once its content is tall enough.
 *   forgetRoute()      App, when the boot's session check ends in Login.
 *
 * Why 12 h: long enough for "put the phone down in the evening, pick it up in
 * the morning" (eviction can come at any point of that gap, and the context is
 * still wanted then); beyond half a day a restored series page is somewhere
 * the user no longer remembers being, and Home is the better start.
 *
 * Never restored: the player (the page it was opened from is — it's the top
 * of the stack under the modal), Login, sheets, and `pending` pages (they live
 * on the activity feed, which isn't polled until the session check is done —
 * the page would say "Nothing in progress" first; the Library grid leads with
 * the same title). A route whose params serialize past 50 KB is left out.
 * Stale pages: all restored Jellyfin ids (detail, person) are checked in one
 * /Items?Ids= request at boot; a page whose item is gone is cut from its
 * stack with everything above it (a Back animation if it is showing, and a
 * toast). A network error keeps the pages — they show their own Retry. */
import { tick } from 'svelte';
import { cfg } from '$lib/config.js';
import { api, itemsPath } from '$lib/api.js';
import { toast } from '$lib/toast.svelte.js';
import { R, TABS, restoreStacks, cutRoute } from './router.svelte.js';
import { onBeforeUpdateReload, updateReloading } from './swupdate.js';

const KEY = 'reel.route';
const LEARNED = 'reel.route.hidePagehide';
const V = 1;
const MAX_AGE = 12 * 3600 * 1000;
const CLOSED_GRACE = 30 * 60 * 1000; // only where pagehide can't tell a quit from a hide
const DEPTH = 3; // routes above the root, per tab
const PARAM_CAP = 50 * 1024;
const SCROLL_WAIT = 2500; // ms a restored page may take to grow tall enough
const HEX = /^[0-9a-f]{32}$/i;

const RESTORABLE = {
  detail: (p) => HEX.test(p.id),
  person: (p) => HEX.test(p.id),
  lookup: (p) => !!p.item && typeof p.item === 'object',
  chart: (p) => typeof p.key === 'string',
  settings: () => true,
  downloads: () => true
};

const get = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const set = (k, v) => {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* quota / private mode: the next cold start lands on Home, as before */
  }
};
function read() {
  try {
    const s = JSON.parse(get(KEY) || 'null');
    return s && s.v === V && s.stacks && typeof s.stacks === 'object' ? s : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ scroll ---- */
/* The last scrollTop of each route's page scroller while it was showing (a
 * hidden page reads 0), by route key. A scroll event only notes the scroller;
 * scrollTop is read once scrolling has rested (or by a save), because reading
 * it inside the event forced a layout in frames where a grid then mounted
 * more tiles — two layouts a frame, ~0.9 s of forced layout over a 600-title
 * Library pass at 4× throttle (measured, headless Chrome). */
const scrolls = new Map();
const moved = new Map(); // route key → scroller, scrolled since the last read
let lastScroll = 0;
let readTimer = 0;
const REST = 150; // ms without a scroll event before the positions are read
function onScroll(e) {
  const t = e.target;
  if (!(t instanceof Element) || !t.classList.contains('screen')) return;
  const r = t.closest('.route');
  if (!r || r.hidden) return;
  moved.set(r.dataset.key, t);
  lastScroll = performance.now();
  if (!readTimer) readTimer = setTimeout(readMoved, REST);
}
function readMoved() {
  readTimer = 0;
  const wait = REST - (performance.now() - lastScroll);
  if (wait > 0) {
    readTimer = setTimeout(readMoved, wait);
    return;
  }
  flushScrolls();
}
function flushScrolls() {
  clearTimeout(readTimer);
  readTimer = 0;
  // a page hidden since (tab switch, push) keeps the last position read
  for (const [k, t] of moved) if (!t.closest('.route')?.hidden) scrolls.set(k, Math.round(t.scrollTop));
  moved.clear();
}

/* ------------------------------------------------------------- save ---- */
export function saveRoute() {
  // a signed-out Login (the whole app) has nothing to come back to
  if (!cfg.token || !cfg.userId || (R.modal === 'login' && !R.booted)) return;
  flushScrolls();
  const stacks = {};
  const live = new Set();
  for (const t of TABS) {
    const out = [];
    for (const r of R.stacks[t].slice(1)) {
      live.add(r.key);
      const ok = RESTORABLE[r.name];
      const p = r.params || {};
      let json;
      try {
        json = JSON.stringify(p);
      } catch {
        continue;
      }
      if (!ok || !ok(p) || json.length > PARAM_CAP) continue;
      out.push({ name: r.name, params: JSON.parse(json), y: scrolls.get(r.key) || 0 });
    }
    const y0 = scrolls.get(R.stacks[t][0].key) || 0;
    live.add(R.stacks[t][0].key);
    if (out.length || y0) stacks[t] = { y0, routes: out.slice(-DEPTH) };
  }
  for (const k of scrolls.keys()) if (!live.has(k)) scrolls.delete(k);
  const snap = { v: V, user: cfg.userId, at: Date.now(), tab: R.tab, stacks };
  // an unloading document fires visibilitychange → hidden *after* pagehide
  // (HTML "unload a document"; Chrome does, measured): that save must keep
  // the quit mark, or a swipe-away from the foreground would still restore
  if (closedAt) snap.closed = closedAt;
  set(KEY, JSON.stringify(snap));
}

let closedAt = 0; // this page saw a pagehide (and hasn't come back since)
export function closeRoute(e) {
  if (e?.persisted || updateReloading()) return;
  closedAt = Date.now();
  const s = read();
  if (!s) return;
  s.closed = closedAt;
  set(KEY, JSON.stringify(s));
}

export function routeResumed() {
  if (!closedAt) return;
  // pagehide fired, yet here we are: it can't tell a quit from a hide here
  set(LEARNED, '1');
  closedAt = 0;
  saveRoute();
}

export function forgetRoute() {
  set(KEY, null);
}

/* ---------------------------------------------------------- restore ---- */
const want = new Map(); // route key → scrollTop still to put back when it shows

export function restoreRoute() {
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  onBeforeUpdateReload(saveRoute);
  if (!cfg.token || !cfg.userId) return;
  if (new URLSearchParams(location.search).has('open')) return; // a notification tap decides
  const s = read();
  if (!s || s.user !== cfg.userId) return;
  const age = Date.now() - s.at;
  if (!(age >= 0 && age < MAX_AGE)) return;
  if (s.closed && !(get(LEARNED) && age < CLOSED_GRACE)) return;

  const stacks = {};
  for (const t of TABS) {
    const list = Array.isArray(s.stacks[t]?.routes) ? s.stacks[t].routes : [];
    stacks[t] = list.filter((x) => x && RESTORABLE[x.name] && x.params && RESTORABLE[x.name](x.params)).slice(-DEPTH);
  }
  const made = restoreStacks({ tab: s.tab, stacks });
  for (const t of TABS) {
    const y0 = +s.stacks[t]?.y0 || 0;
    if (y0 > 0) want.set(R.stacks[t][0].key, y0);
    made[t].forEach((r, i) => {
      const y = +stacks[t][i].y || 0;
      if (y > 0) want.set(r.key, y);
    });
  }
  // until it is applied (or the user scrolls), a re-save keeps the target
  for (const [k, y] of want) scrolls.set(k, y);
  if (want.size)
    $effect.root(() => {
      $effect(() => {
        void R.tab, R.stacks, R.anim, R.modal;
        if (want.size) tick().then(applyShown);
      });
    });
  validate(made);
}

/* Put a page's scroll back the first time it shows: in the same frame if its
 * content is already there (Home paints from its snapshot), else as soon as
 * it's tall enough — at most SCROLL_WAIT, then as far as it goes. A touch or
 * wheel on it ends the wait: never fight the finger. */
function applyShown() {
  const keys = new Set(TABS.flatMap((t) => R.stacks[t].map((r) => r.key)));
  for (const [key, y] of want) {
    if (!keys.has(key)) {
      want.delete(key);
      continue;
    }
    const el = document.querySelector(`.route[data-key="${key}"]`);
    if (!el || el.hidden) continue;
    want.delete(key);
    follow(el, key, y);
  }
}

function follow(el, key, y) {
  const t0 = performance.now();
  let stop = false;
  const quit = () => (stop = true);
  const evs = ['touchstart', 'wheel', 'pointerdown'];
  for (const e of evs) el.addEventListener(e, quit, { passive: true, once: true });
  const done = () => {
    for (const e of evs) el.removeEventListener(e, quit);
  };
  const step = () => {
    if (stop || !el.isConnected) return done();
    if (el.hidden) {
      want.set(key, y); // switched away first: again on its next showing
      return done();
    }
    const s = el.querySelector('.screen:not([aria-busy="true"])');
    const late = performance.now() - t0 > SCROLL_WAIT;
    if (s) {
      const max = s.scrollHeight - s.clientHeight;
      if (max >= y - 1 || late) {
        if (max > 0) jump(el, s, Math.min(y, max));
        return done();
      }
    } else if (late) return done();
    requestAnimationFrame(step);
  };
  step();
}

/* The jump itself, with the bars' solid/clear fades off until the scroll
 * event (next frame) and Svelte's class flip after it have gone by. */
function jump(route, s, y) {
  route.classList.add('vr-restoring');
  s.scrollTop = y;
  let n = 0;
  const off = () => (++n < 3 ? requestAnimationFrame(off) : route.classList.remove('vr-restoring'));
  requestAnimationFrame(off);
}

/* Items deleted since (or ids this account can't see): one request for all of
 * them; /Items?Ids= answers only the ones that exist. */
async function validate(made) {
  const ids = new Set();
  for (const t of TABS) for (const r of made[t]) if (r.name === 'detail' || r.name === 'person') ids.add(r.params.id.toLowerCase());
  if (!ids.size) return;
  let found;
  try {
    const res = await api(itemsPath({ Ids: [...ids].join(','), EnableImages: false, EnableUserData: false }));
    found = new Set((res?.Items || []).map((i) => String(i.Id).toLowerCase()));
  } catch {
    return; // offline / server trouble: the pages show their own error + Retry
  }
  for (const t of TABS) {
    const bad = made[t].find((r) => (r.name === 'detail' || r.name === 'person') && !found.has(r.params.id.toLowerCase()));
    if (!bad || !R.stacks[t].some((r) => r.key === bad.key)) continue;
    const seen = t === R.tab && !R.modal;
    cutRoute(t, bad.key);
    if (seen) toast(bad.name === 'person' ? 'That page isn’t available any more' : 'That title isn’t in your library any more');
  }
}
