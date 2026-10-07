/* URL routing for the web build: the phone router's stacks ↔ the address bar
 * and the browser's history, so Back/Forward, reloads and deep links work.
 *
 * The phone router (phone/src/lib/router.svelte.js) stays the source of truth
 * — every screen and the engine navigate through it. This module mirrors it:
 *
 *   router → history   a push (or a tab switch) adds a history entry, a pop
 *                      goes back to the entry it came from (history.go(-k)),
 *                      replace() and anything sideways replaces the entry.
 *                      The player modal gets an entry of its own (same URL),
 *                      so the browser's Back closes the player.
 *   history → router   popstate brings the router to the entry's state: tab,
 *                      then pop to the common prefix, then push the rest.
 *   load               history.state (a reload keeps it, lookup items and all)
 *                      or else the path (a deep link: root entry + the page, so
 *                      Back lands in the app, not on the previous site).
 *
 * Every entry's state: { vr: 1, n, tab, stack: [{name, params}], player }.
 * `n` counts our entries; sessionStorage keeps n → entry so a pop after a
 * reload still knows what lies behind.
 *
 * URLs:  /  /movies  /shows  /search[?q=]  /movie/<id>  /show/<id>  /item/<id>
 *        /person/<id>  /lookup/<movie|tv>/<id>  /search/chart/<key>?t=<title>
 *        /pending/<key>  /settings  /my-library */
import { untrack } from 'svelte';
import { R, TABS, push, pop, switchTab, restoreStacks } from '$p/lib/router.svelte.js';
import { exitPlayer } from '$lib/player.svelte.js';

const SITE = 'VibeReel';

/* The Search root's `?q=…` (lib/searchurl.js registers the getter). */
let searchQuery = () => '';
/** @param {() => string} fn */
export function setSearchQuery(fn) {
  searchQuery = fn;
}
const HIST_KEY = 'reel.web.history';

/** @typedef {{ name: VR.RouteName, params?: VR.RouteParams }} PlainRoute */
/** @typedef {{ vr: 1, n: number, tab: VR.TabName, stack: PlainRoute[], player?: boolean }} HistState */
/** @typedef {{ tab: VR.TabName, sigs: string[], player: boolean }} Rec */

const enc = encodeURIComponent;

/* ------------------------------------------------------------ route ↔ URL */

/** @param {VR.TabName} tab @param {PlainRoute | undefined} r @returns {string} */
export function urlOf(tab, r) {
  if (!r) return tab === 'home' ? '/' : '/' + tab;
  const p = /** @type {Record<string, any>} */ (r.params || {});
  switch (r.name) {
    case 'detail':
      return (p.type === 'Movie' ? '/movie/' : p.type === 'Series' ? '/show/' : '/item/') + enc(p.id);
    case 'person':
      return '/person/' + enc(p.id);
    case 'lookup': {
      const it = p.item || {};
      return it.id && it.type ? '/lookup/' + enc(it.type) + '/' + enc(it.id) : '/lookup';
    }
    case 'chart':
      return '/search/chart/' + enc(p.key || 'top') + (p.title ? '?t=' + enc(p.title) : '');
    case 'pending':
      return '/pending/' + enc(p.key);
    case 'settings':
      return '/settings';
    case 'mylibrary':
      return '/my-library';
    default:
      return '/';
  }
}

/** @param {string} pathname @param {string} search @returns {{ tab: VR.TabName, stack: PlainRoute[] }} */
export function parseUrl(pathname, search = '') {
  const seg = pathname.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const q = new URLSearchParams(search);
  const [a, b, c] = seg;
  /** @param {VR.TabName} tab @param {PlainRoute[]} [stack] */
  const at = (tab, stack = []) => ({ tab, stack });
  if (!a) return at('home');
  if (seg.length === 1 && (a === 'movies' || a === 'shows' || a === 'search')) return at(a);
  if (a === 'movie' && b) return at('movies', [{ name: 'detail', params: { id: b, type: 'Movie' } }]);
  if (a === 'show' && b) return at('shows', [{ name: 'detail', params: { id: b, type: 'Series' } }]);
  if (a === 'item' && b) return at('home', [{ name: 'detail', params: { id: b, type: null } }]);
  if (a === 'person' && b) return at('home', [{ name: 'person', params: { id: b, name: '' } }]);
  if (a === 'lookup' && (b === 'movie' || b === 'tv') && c)
    return at('search', [{ name: 'lookup', params: { item: /** @type {Reel.LookupRef} */ ({ id: c, type: b, title: '' }) } }]);
  if (a === 'search' && b === 'chart' && c) return at('search', [{ name: 'chart', params: { key: c, title: q.get('t') || '' } }]);
  if (a === 'pending' && b) return at('home', [{ name: 'pending', params: { key: b } }]);
  if (a === 'settings') return at('home', [{ name: 'settings', params: {} }]);
  if (a === 'my-library') return at('home', [{ name: 'mylibrary', params: {} }]);
  return at('home');
}

/* What tells two routes apart — never the whole params (a lookup item is
 * mutated in place when it gets added, say). */
/** @param {PlainRoute} r @returns {string} */
function rsig(r) {
  const p = /** @type {Record<string, any>} */ (r.params || {});
  const id = p.id ?? p.key ?? (p.item ? (p.item.type || '') + ':' + (p.item.id ?? p.item.title ?? '') : '');
  return r.name + ':' + id;
}

/** @param {VR.Route[]} stack @returns {PlainRoute[]} routes above the root, as plain JSON */
function plain(stack) {
  return stack.slice(1).map((r) => {
    let params = {};
    try {
      params = JSON.parse(JSON.stringify(r.params || {}));
    } catch {}
    return { name: r.name, params };
  });
}

/** @param {Rec} a @param {Rec} b */
const same = (a, b) => a.tab === b.tab && a.player === b.player && a.sigs.length === b.sigs.length && a.sigs.every((s, i) => s === b.sigs[i]);
/** @param {string[]} a @param {string[]} b  a is a prefix of b */
const prefix = (a, b) => a.length <= b.length && a.every((s, i) => s === b[i]);

/* --------------------------------------------------------- history book */

/** @type {Map<number, Rec>} */
let book = new Map();
function loadBook() {
  try {
    const o = JSON.parse(sessionStorage.getItem(HIST_KEY) || '{}');
    book = new Map(Object.entries(o).map(([k, v]) => [Number(k), /** @type {Rec} */ (v)]));
  } catch {
    book = new Map();
  }
}
function saveBook() {
  try {
    sessionStorage.setItem(HIST_KEY, JSON.stringify(Object.fromEntries(book)));
  } catch {}
}

/** @type {Rec & { n: number }} what the current history entry shows */
let cur = { n: 0, tab: 'home', sigs: [], player: false };
/** @type {number | null} the entry our own history.go() is heading to */
let expect = null;

/** @param {VR.TabName} tab @param {VR.Route[]} stack @param {boolean} player @param {number} n @returns {HistState} */
function stateFor(tab, stack, player, n) {
  return { vr: 1, n, tab, stack: plain(stack), player };
}

/** @param {'push' | 'replace'} how @param {VR.TabName} tab @param {VR.Route[]} stack @param {boolean} player */
function write(how, tab, stack, player) {
  const n = how === 'push' ? cur.n + 1 : cur.n;
  const st = stateFor(tab, stack, player, n);
  const url = urlOf(tab, st.stack[st.stack.length - 1]);
  // the Search root carries its query (?q=, lib/searchurl.js); other pages keep
  // a query only when they replace themselves
  const keepQuery = tab === 'search' && !st.stack.length ? searchQuery() : url === location.pathname ? location.search : '';
  if (how === 'push') {
    for (const k of book.keys()) if (k > cur.n) book.delete(k);
    history.pushState(st, '', url + keepQuery);
  } else history.replaceState(st, '', url + keepQuery);
  cur = { n, tab, sigs: st.stack.map(rsig), player };
  book.set(n, { tab: cur.tab, sigs: cur.sigs, player });
  saveBook();
}

/* ------------------------------------------------------ router → history */

/** @param {VR.TabName} tab @param {VR.Route[]} stack @param {boolean} player */
function reconcile(tab, stack, player) {
  /** @type {Rec} */
  const next = { tab, sigs: plain(stack).map(rsig), player };
  if (same(cur, next)) return;
  /* back to an entry right behind us (a pop, a player close, a tab re-tap
   * popping to the root): go there instead of piling up entries */
  for (let k = 1; k <= cur.n; k++) {
    const r = book.get(cur.n - k);
    if (!r) break;
    if (same(r, next)) {
      expect = cur.n - k;
      cur = { n: cur.n - k, ...next };
      history.go(-k);
      return;
    }
    // only walk back through this tab's own pages (and its player entry)
    if (r.tab !== tab || !prefix(r.sigs, cur.sigs)) break;
  }
  const grew = tab !== cur.tab || (prefix(cur.sigs, next.sigs) && (next.sigs.length > cur.sigs.length || (player && !cur.player)));
  write(grew ? 'push' : 'replace', tab, stack, player);
}

/* ------------------------------------------------------ history → router */

/** @param {HistState} st */
function apply(st) {
  const tab = TABS.includes(st.tab) ? st.tab : 'home';
  const want = Array.isArray(st.stack) ? st.stack : [];
  cur = { n: st.n, tab, sigs: want.map(rsig), player: !!st.player };
  // the player is up and this entry isn't the player's: Back closes it
  if (R.modal === 'player' && !st.player) exitPlayer();
  if (R.tab !== tab) switchTab(tab);
  const have = plain(R.stacks[tab]);
  let c = 0;
  while (c < have.length && c < want.length && rsig(have[c]) === rsig(want[c])) c++;
  const pops = have.length - c;
  const adds = want.slice(c);
  for (let i = 0; i < pops; i++) pop({ animate: !adds.length && i === pops - 1 });
  adds.forEach((r, i) => push(r.name, r.params || {}, { animate: i === adds.length - 1 }));
}

/** @param {PopStateEvent} e */
function onPop(e) {
  const st = /** @type {HistState | null} */ (e.state);
  if (expect != null && st?.vr && st.n === expect) {
    expect = null;
    return;
  }
  expect = null;
  if (st?.vr) return apply(st);
  // an entry that isn't ours (a #hash, a hand-edited URL): read the path
  const p = parseUrl(location.pathname, location.search);
  apply({ vr: 1, n: cur.n, tab: p.tab, stack: p.stack, player: false });
  history.replaceState({ vr: 1, n: cur.n, tab: p.tab, stack: p.stack, player: false }, '');
}

/* ------------------------------------------------------------ the title */

let titleT = 0;
function retitle() {
  clearTimeout(titleT);
  const set = () => {
    const tab = R.tab;
    const s = R.stacks[tab];
    if (s.length < 2) {
      document.title = tab === 'home' ? SITE : { movies: 'Movies', shows: 'Shows', search: 'Search' }[tab] + ' · ' + SITE;
      return;
    }
    const page = document.querySelector(`.route[data-key="${s[s.length - 1].key}"]`);
    const h = page?.querySelector('.screen h1, h1, .navbar__title');
    const t = h?.textContent?.trim();
    document.title = t ? t + ' · ' + SITE : SITE;
  };
  set();
  titleT = setTimeout(() => {
    set();
    titleT = setTimeout(set, 1500);
  }, 400);
}

/* ---------------------------------------------------------------- start */

/* Before the first mount: build the stacks from history.state or the URL. */
export function initUrl() {
  loadBook();
  const st = /** @type {HistState | null} */ (history.state);
  if (st?.vr && TABS.includes(st.tab)) {
    restoreStacks({ tab: st.tab, stacks: { [st.tab]: st.stack || [] } });
    cur = { n: st.n, tab: st.tab, sigs: (st.stack || []).map(rsig), player: false };
    // a reload during playback: the player isn't up any more
    if (st.player) history.replaceState({ ...st, player: false }, '');
    book.set(cur.n, { tab: cur.tab, sigs: cur.sigs, player: false });
    saveBook();
  } else {
    const p = parseUrl(location.pathname, location.search);
    restoreStacks({ tab: p.tab, stacks: { [p.tab]: p.stack } });
    book = new Map();
    cur = { n: 0, tab: p.tab, sigs: [], player: false };
    /** @type {HistState} */
    const root = { vr: 1, n: 0, tab: p.tab, stack: [], player: false };
    history.replaceState(root, '', urlOf(p.tab, undefined) + (p.tab === 'search' && !p.stack.length ? location.search : ''));
    book.set(0, { tab: p.tab, sigs: [], player: false });
    if (p.stack.length) {
      // deep link: the tab's root behind it, so Back stays in the app
      const top = { vr: 1, n: 1, tab: p.tab, stack: p.stack, player: false };
      history.pushState(top, '', urlOf(p.tab, p.stack[p.stack.length - 1]));
      cur = { n: 1, tab: p.tab, sigs: p.stack.map(rsig), player: false };
      book.set(1, { tab: cur.tab, sigs: cur.sigs, player: false });
    }
    saveBook();
  }
  window.addEventListener('popstate', onPop);
  $effect.root(() => {
    $effect(() => {
      const tab = R.tab;
      const stack = R.stacks[tab];
      const player = R.modal === 'player';
      untrack(() => {
        reconcile(tab, stack, player);
        retitle();
      });
    });
  });
}
