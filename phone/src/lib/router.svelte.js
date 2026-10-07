/* Phone router: one push stack per tab, sheets, and the two full-screen modals
 * (player, login). See docs/ios/ARCHITECTURE.md → "router.svelte.js".
 *
 *   R.tab            'home' | 'movies' | 'shows' | 'search'
 *   R.stacks[tab]    Route[] (root first). Route = { name, params, key }.
 *   R.sheet          null | { name, params, key }
 *   R.modal          null | 'player' | 'login'
 *   R.playerClosed   counter, bumped after a player-modal close that may have
 *                    moved play state — detail screens, Home, the grids watch
 *                    it to refetch. Not after a trailer (R.playerQuiet).
 *   R.toTop          counter, bumped when the active tab is tapped at its root
 *                    (App scrolls the root's scrollers to the top by itself).
 *   R.anim           the running push/pop transition (App animates it), or null;
 *                    `replace: true` when replace() swapped the top route.
 *   R.peek           key of the route an edge swipe is revealing, or null.
 *   R.booted         true once the session is known good (polls, freshness and
 *                    notification taps wait for it; App mounts the stacks and
 *                    tab bar before, while the check runs — PWA-02).
 *   R.visited[tab]   the tab has been shown once (its pages are mounted from then on).
 *
 * Every route of every stack stays mounted; App shows only the active top.
 *
 * The TV's navigation state `S` lives here too (nav.svelte.js re-exports it),
 * because the router keeps it in sync: S.screen is 'player' while the player
 * modal is up, 'login' while Login is, else the top route's name; S.base is the
 * top route in TV vocabulary ('library' for the movies/shows roots); S.detailId
 * etc. mirror the top route's params. The engine writes S.screen = 'player' to
 * raise the player and S.screen = S.base to lower it — both land in the setter
 * below and open/close the modal. */

import { takeOrigin, rememberOrigin, originOf, forgetOrigin } from './zoom.js';
import { reducedMotion } from './safe.js';

/** @type {VR.TabName[]} */
export const TABS = ['home', 'movies', 'shows', 'search'];
const STACK_MAX = 10;

let keySeq = 0;
/**
 * @param {VR.RouteName} name
 * @param {VR.RouteParams} [params]
 * @returns {VR.Route}
 */
function mk(name, params = {}) {
  return { name, params, key: name + '-' + ++keySeq };
}

/** @returns {Record<VR.TabName, VR.Route[]>} */
function roots() {
  return {
    home: [mk('home')],
    movies: [mk('movies', { type: 'movies' })],
    shows: [mk('shows', { type: 'shows' })],
    search: [mk('search')]
  };
}

/** @implements {VR.RouterState} */
class Router {
  /** @type {VR.TabName} */
  tab = $state('home');
  /* raw: routes carry caller objects (a lookup item) whose identity matters */
  stacks = $state.raw(roots());
  /** @type {VR.SheetRoute | null} */
  sheet = $state.raw(null);
  /** @type {VR.Modal | null} */
  modal = $state(null);
  playerClosed = $state(0);
  /* the player shows something that reports no play state (a trailer), so
   * closing it doesn't bump playerClosed — Home, a Detail page and every grid
   * re-read their items after each one otherwise. Kept by playclose.svelte.js,
   * which can read the engine's P (this module can't import it: engine → nav
   * shim → here would evaluate the whole engine before R exists). */
  playerQuiet = false;
  toTop = $state(0);
  /** @type {VR.RouteAnim | null} */
  anim = $state.raw(null);
  /** @type {string | null} */
  peek = $state(null);
  booted = $state(false);
  /* tabs whose stack has been shown at least once — App mounts a tab's pages
   * only from its first visit on (no Movies/Shows/Search fetches at boot) */
  /** @type {Record<VR.TabName, boolean>} */
  visited = $state({ home: true, movies: false, shows: false, search: false });
}
export const R = new Router();

/* ------------------------------------------------------------------ S ---- */

let syncing = false;

/** @implements {VR.PhoneNavState} */
class NavState {
  /** @type {VR.PhoneScreen} */
  _screen = $state('boot');
  get screen() {
    return this._screen;
  }
  /** @param {VR.PhoneScreen} v */
  set screen(v) {
    const was = this._screen;
    this._screen = v;
    if (syncing) return;
    if (v === 'player' && R.modal !== 'player') {
      R.sheet = null;
      R.modal = 'player';
    } else if (was === 'player' && v !== 'player' && R.modal === 'player') {
      closePlayer();
    }
  }
  /** @type {VR.PhoneBase} */
  base = $state('home');
  /** @type {string} */
  tab = $state('home');
  /** @type {string | null} */
  focusKey = $state(null);
  /** @type {string | null} */
  lastPill = $state(null);
  /** @type {string | null} */
  detailId = $state(null);
  /** @type {string | null} */
  detailType = $state(null);
  /** @type {string | null} */
  personId = $state(null);
  personName = $state('');
  /** @type {string | null} */
  pendingKey = $state(null);
  search = $state(false);
  /** @type {string | null} */
  searchFocus = $state(null);
  /** @type {string | null} */
  searchChart = $state(null);
  searchKb = $state(false);
  /** @type {Reel.LookupResult | Reel.LookupRef | null} */
  lookup = $state.raw(null);
  addingAccount = $state(false);
  ready = $state(false);
  splashActive = $state(false);
  epoch = $state(0);
}
export const S = new NavState();

/** @type {Partial<Record<VR.RouteName, VR.PhoneBase>>} */
const TV_NAME = { movies: 'library', shows: 'library' };

/** Mirror the visible route into S (after every navigation).
 * @param {boolean} [bump] */
function sync(bump = true) {
  const t = top();
  syncing = true;
  try {
    if (R.modal === 'player') S.screen = 'player';
    else if (R.modal === 'login') S.screen = 'login';
    else if (S.screen !== 'boot' || R.booted) S.screen = t.name;
  } finally {
    syncing = false;
  }
  // movies/shows always map to 'library', so the fallback is never one of them
  S.base = /** @type {VR.PhoneBase} */ (TV_NAME[t.name] || t.name);
  S.tab = R.tab;
  const p = t.params || {};
  if (t.name === 'detail') {
    S.detailId = /** @type {string} */ (p.id);
    S.detailType = p.type || null;
  } else if (t.name === 'person') {
    S.personId = /** @type {string} */ (p.id);
    S.personName = p.name || '';
  } else if (t.name === 'pending') {
    S.pendingKey = /** @type {string} */ (p.key);
  } else if (t.name === 'lookup') {
    S.lookup = /** @type {Reel.LookupResult | Reel.LookupRef} */ (p.item);
  } else if (t.name === 'chart') {
    S.searchChart = p.key ?? null;
  }
  if (bump) S.epoch++;
}

/* ------------------------------------------------------------ queries ---- */

/** @param {VR.TabName} [tab] @returns {VR.Route[]} */
export function stack(tab = R.tab) {
  return R.stacks[tab];
}

/** @param {VR.TabName} [tab] @returns {VR.Route} */
export function top(tab = R.tab) {
  const s = R.stacks[tab];
  return s[s.length - 1];
}

/* The route under the top one (what a pop / edge swipe reveals), or null. */
/** @param {VR.TabName} [tab] @returns {VR.Route | null} */
export function beneath(tab = R.tab) {
  const s = R.stacks[tab];
  return s.length > 1 ? s[s.length - 2] : null;
}

const reduced = reducedMotion;

/* --------------------------------------------------------- navigation ---- */

/** @param {VR.TabName} tab @param {VR.Route[]} list */
function setStack(tab, list) {
  R.stacks = { ...R.stacks, [tab]: list };
}

/* push(name, params, { animate = true }) → the new Route */
/**
 * @param {VR.RouteName} name
 * @param {VR.RouteParams} [params]
 * @param {{ animate?: boolean }} [opts]
 * @returns {VR.Route}
 */
export function push(name, params = {}, { animate = true } = {}) {
  const from = top();
  rememberFocus(from.key);
  const r = mk(name, params);
  let list = [...stack(), r];
  // cap: drop the deepest-but-root routes first (they are the oldest pages)
  while (list.length > STACK_MAX) list = [list[0], ...list.slice(2)];
  R.sheet = null;
  /* opened by a tap on a tile (zoom.js remembers it): the page grows out of
   * the tile, and a pop shrinks it back in */
  const origin = takeOrigin(name, from.key);
  const zoom = animate && !reduced() && origin && !R.modal;
  if (zoom) rememberOrigin(r.key, origin);
  R.anim = zoom
    ? { dir: 'zoom', from: from.key, to: r.key }
    : animate && !reduced()
      ? { dir: 'push', from: from.key, to: r.key }
      : animate
        ? { dir: 'fade', from: from.key, to: r.key }
        : null;
  setStack(R.tab, list);
  sync();
  return r;
}

/* pop({ animate = true }) — no-op at a root. Returns the popped Route. */
/** @param {{ animate?: boolean }} [opts] @returns {VR.Route | null} */
export function pop({ animate = true } = {}) {
  const s = stack();
  if (s.length < 2) return null;
  const gone = s[s.length - 1];
  const to = s[s.length - 2];
  const dir = reduced() ? 'fade' : originOf(gone.key) && !R.modal ? 'unzoom' : 'pop';
  // back: a Reduce Motion pop dissolves only the leaving page (NAV-14)
  R.anim = animate ? { dir, from: gone.key, to: to.key, gone, back: true } : null;
  if (dir !== 'unzoom' || !animate) forgetOrigin(gone.key);
  setStack(R.tab, s.slice(0, -1));
  sync();
  return gone;
}

/** @param {{ animate?: boolean }} [opts] */
export function popToRoot({ animate = true } = {}) {
  const s = stack();
  if (s.length < 2) return;
  const gone = s[s.length - 1];
  R.anim = animate ? { dir: reduced() ? 'fade' : 'pop', from: gone.key, to: s[0].key, gone, back: true } : null;
  setStack(R.tab, [s[0]]);
  sync();
}

/* Swap the top route for a new one (PendingDetail's "Open": the landed title's
 * detail page replaces the download page, so Back doesn't return to a page
 * that no longer means anything). Animated as a push over the old page, which
 * App's leave() keeps covered until the new one has slid in (`replace` on
 * R.anim). Never a tile zoom — the old page is on its way out. At a root it's
 * an ordinary push (a root isn't replaced). */
/**
 * @param {VR.RouteName} name
 * @param {VR.RouteParams} [params]
 * @param {{ animate?: boolean }} [opts]
 * @returns {VR.Route}
 */
export function replace(name, params = {}, { animate = true } = {}) {
  const s = stack();
  if (s.length < 2) return push(name, params, { animate });
  const from = s[s.length - 1];
  const r = mk(name, params);
  takeOrigin(name, from.key); // clears a tile tap that led elsewhere
  forgetOrigin(from.key);
  R.sheet = null;
  R.anim = animate ? { dir: reduced() ? 'fade' : 'push', from: from.key, to: r.key, replace: true } : null;
  setStack(R.tab, [...s.slice(0, -1), r]);
  sync();
  return r;
}

/* Tab bar tap: another tab → switch (its stack as left); the active tab →
 * pop to root; the active tab at its root → scroll to top (R.toTop). */
/** @param {VR.TabName} tab  (still checked: a non-tab is ignored) */
export function switchTab(tab) {
  if (!TABS.includes(tab)) return;
  R.sheet = null;
  if (tab !== R.tab) {
    R.anim = null;
    R.visited[tab] = true;
    R.tab = tab;
    sync();
  } else if (stack().length > 1) popToRoot();
  else R.toTop++;
}

/* Replace the whole stack of `tab` with its root + an optional route, and
 * show it (used by nav-shim open*() calls that name a tab). */
/** @param {VR.TabName} tab */
export function resetTab(tab) {
  R.anim = null;
  R.visited[tab] = true;
  R.tab = tab;
  setStack(tab, [stack(tab)[0]]);
  sync();
}

/* ------------------------------------------------------ shell helpers ---- */

/* VoiceOver focus across a push (NAV-09): what had focus on the page being
 * covered — taken now, because the page turns inert (and drops focus) as soon
 * as it is covered. App gives it back when a pop lands on that page. */
/** @type {Map<string, HTMLElement>} */
const focusMem = new Map(); // route key → Element
/** @param {string} key */
function rememberFocus(key) {
  // HTMLElement: App gives it back with f.focus() (an SVG target would have focus() too)
  const f = /** @type {HTMLElement | null} */ (typeof document !== 'undefined' ? document.activeElement : null);
  if (f && f !== document.body && f.closest?.('.route')) focusMem.set(key, f);
  else focusMem.delete(key);
}
/** @param {string} key @returns {HTMLElement | null} */
export function takeFocus(key) {
  const f = focusMem.get(key) || null;
  focusMem.delete(key);
  return f;
}
/* App: forget routes that are gone (their elements would stay reachable). */
/** @param {Set<string>} live  keys of the routes still mounted */
export function pruneFocus(live) {
  for (const k of focusMem.keys()) if (!live.has(k)) focusMem.delete(k);
}

/* Scroll a page's scroller to the top, as the status-bar tap does (tab re-tap,
 * NAV-08's bar tap): smooth, instant under Reduce Motion. A fling still
 * coasting is stopped first (overflow off for one frame) — WebKit ignores a
 * programmatic scroll on an overflow scroller while its momentum runs. */
/** @param {HTMLElement | null | undefined} s */
export function scrollToTop(s) {
  if (!s || s.scrollTop <= 0) return;
  s.style.overflowY = 'hidden';
  requestAnimationFrame(() => {
    s.style.overflowY = '';
    s.scrollTo({ top: 0, behavior: reduced() ? 'instant' : 'smooth' });
  });
}

/* ------------------------------------------------------------- sheets ---- */

/** @param {VR.SheetName} name @param {VR.RouteParams} [params] */
export function openSheet(name, params = {}) {
  R.sheet = { name, params, key: 'sheet-' + ++keySeq };
}

export function closeSheet() {
  R.sheet = null;
}

/* ------------------------------------------------------------- modals ---- */

/** @type {Set<() => void>} */
const closeHooks = new Set();

/* Run `fn` after every player-modal close — trailers included, unlike
 * R.playerClosed. It runs in a task of its own, so whatever navigation the
 * close is part of (the engine's exit pushes the page it returns to right
 * after closing) has landed first. Returns the unsubscribe. */
/** @param {() => void} fn @returns {() => void} */
export function onPlayerClose(fn) {
  closeHooks.add(fn);
  return () => closeHooks.delete(fn);
}

export function closePlayer() {
  if (R.modal !== 'player') return;
  R.modal = null;
  if (!R.playerQuiet) R.playerClosed++;
  sync(false);
  if (closeHooks.size)
    setTimeout(() => {
      for (const fn of [...closeHooks]) {
        try {
          fn();
        } catch {}
      }
    }, 0);
}

/** @param {boolean} [adding] */
export function openLoginModal(adding = false) {
  S.addingAccount = adding;
  R.sheet = null;
  R.modal = 'login';
  sync();
}

export function closeLoginModal() {
  if (R.modal !== 'login') return;
  R.modal = null;
  S.addingAccount = false;
  sync();
}

/* --------------------------------------------------- state restore ---- */
/* PWA-05 (lib/restore.js decides what and when; these only rebuild).
 *
 * restoreStacks({ tab, stacks: { tab: [{name, params}] } }) — before the first
 * mount: every tab's stack becomes its root + the given routes (no animation,
 * nothing is shown yet); only the active tab counts as visited, so the other
 * tabs' restored pages mount on their first visit, as they would have. Returns
 * the new routes per tab (restore.js maps its scroll offsets onto their keys). */
/**
 * @param {{ tab: VR.TabName, stacks: Partial<Record<VR.TabName, { name: VR.RouteName, params?: VR.RouteParams }[]>> }} saved
 * @returns {Record<VR.TabName, VR.Route[]>}
 */
export function restoreStacks({ tab, stacks }) {
  const next = roots();
  const made = /** @type {Record<VR.TabName, VR.Route[]>} */ ({});
  for (const t of TABS) {
    made[t] = (stacks?.[t] || []).map((x) => mk(x.name, x.params || {}));
    next[t] = [next[t][0], ...made[t]].slice(0, STACK_MAX);
  }
  R.anim = null;
  R.peek = null;
  R.stacks = next;
  if (TABS.includes(tab)) {
    R.tab = tab;
    R.visited[tab] = true;
  }
  sync();
  return made;
}

/* A restored page turned out stale (its item is gone from the server): drop it
 * and everything pushed over it. On the visible tab it pops away like Back;
 * elsewhere it's cut silently. */
/** @param {VR.TabName} tab @param {string} key */
export function cutRoute(tab, key) {
  const s = R.stacks[tab];
  const i = s.findIndex((r) => r.key === key);
  if (i < 1) return;
  const gone = s[s.length - 1];
  const shownNow = tab === R.tab && !R.modal;
  R.anim = shownNow ? { dir: reduced() ? 'fade' : 'pop', from: gone.key, to: s[i - 1].key, gone, back: true } : R.tab === tab ? null : R.anim;
  for (const r of s.slice(i)) forgetOrigin(r.key);
  setStack(tab, s.slice(0, i));
  sync();
}

/* Back to the four roots on Home (a boot that ends in Login: whoever signs in
 * starts clean, not on the previous session's restored pages). */
export function resetStacks() {
  R.anim = null;
  R.peek = null;
  R.sheet = null;
  R.stacks = roots();
  R.tab = 'home';
  R.visited = { home: true, movies: false, shows: false, search: false };
  sync();
}

/* Boot finished with a good session: mount the stacks, leave 'boot'. */
export function markBooted() {
  R.booted = true;
  if (R.modal === 'login') R.modal = null;
  syncing = true;
  S._screen = top().name;
  syncing = false;
  sync();
}

/* Test/debug handle: the router from the console / CDP. */
if (typeof window !== 'undefined') window.__router = { R, S, push, pop, replace, switchTab, openSheet, closeSheet };
