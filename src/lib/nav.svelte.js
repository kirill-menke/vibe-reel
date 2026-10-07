/* All navigation state, as in the original: one object, no history stack —
 * onBack() derives the parent screen from where you are.
 *
 * `screen` keeps the exact same vocabulary as the vanilla app because it drives
 * key dispatch (playerKey) and focus scoping. `base` is new: the player is an
 * overlay drawn *over* a browse screen that stays mounted underneath, which the
 * vanilla app got for free by leaving #app's innerHTML alone. base is that
 * still-mounted screen. (Music lives in its own app now, VibeSpin.) */
/** @type {VR.NavState} */
export const S = $state(/** @satisfies {VR.NavState} */ ({
  screen: 'boot',   // boot | login | home | library | detail | person | player | pending | lookup
  base: 'home',     // the browse screen mounted in #app behind any overlay
  tab: 'home',
  focusKey: null,
  lastPill: null,
  detailId: null,
  detailType: null,
  personId: null,   // Person.svelte: the cast member whose titles are listed
  personName: '',
  pendingKey: null, // activity group key shown by PendingDetail
  search: false,    // the Search overlay is up over S.base (see openSearch)
  searchFocus: null, // one-shot: the result card to focus when Search comes back up
  searchChart: null, // the browse category open under the Search bar (Browse.svelte)
  searchKb: false,   // Search's own keyboard is open under the bar (Keyboard.svelte)
  lookup: null,     // the /api/lookup result LookupDetail shows
  addingAccount: false, // Login is up over a signed-in session (openLogin(true))
  ready: false,
  splashActive: true,
  // bumped to force a browse screen to refetch (e.g. after exiting the player
  // or toggling watched, which the vanilla app did by calling openItem again)
  epoch: 0
}));

/* ---- where the library grid was left ----
 * Backing out of a detail page remounts the grid ({#key S.epoch} in App.svelte),
 * which destroys the tile the user came from, so it has to be re-focused by key.
 * `gridFocus` is the per-tab memory; `restoreFocus` is the one-shot handoff that
 * says *this* mount is a return rather than a fresh visit — clicking the tab
 * deliberately leaves focus on the pill and must not drag the D-pad down into
 * the grid. Plain module state: only Library.svelte reads it, imperatively, and
 * nothing renders from it. */
/** Library tab → the tile key to restore. @type {Map<string, string>} */
const gridFocus = new Map();
/** @type {string | null} */
let restoreFocus = null;

/* Consumed by Library.svelte on mount; null on any mount that isn't a return. */
/** @returns {string | null} */
export function takeGridFocus() {
  const k = restoreFocus;
  restoreFocus = null;
  return k;
}

/* The same for Home, whose rails are browsed the way the grid is: the element
 * a detail screen was opened from (a rail tile, or the hero's More info), and
 * the one-shot handoff that tells Home's next mount it is a return. */
/** @type {string | null} */
let homeFocus = null;
/** @type {string | null} */
let restoreHome = null;

function rememberHome() {
  if (S.screen === 'home' && !searchReturn) homeFocus = S.focusKey;
}

/* Home reads it (without consuming) while its script runs, to restore the
 * hero pick before the first paint. */
/** @returns {string | null} */
export function peekHomeFocus() {
  return restoreHome;
}

/* Consumed by Home.svelte on mount; null on any mount that isn't a return. */
/** @returns {string | null} */
export function takeHomeFocus() {
  const k = restoreHome;
  restoreHome = null;
  return k;
}

/* `adding`: raised from the avatar menu with a session still signed in —
 * Back returns to Home as that account, and Login.svelte reloads into the new
 * one once it signs in (account.svelte.js). */
/** @param {boolean} [adding] */
export function openLogin(adding = false) {
  S.addingAccount = adding;
  S.screen = 'login';
  S.base = 'login';
  S.epoch++;
}

/* ---- detail → detail back stack ----
 * onBack() derives the parent of a screen, which is right for tab → detail but
 * wrong once one detail opens another (More Like This, a cast member's page,
 * an episode's "Seasons ›"): the page in between used to be skipped. `trail`
 * remembers those pages, newest last, with the element focus was on when the
 * next one opened, so Back re-opens it (remounted, refetched) on that element.
 * A tab switch (openHome/openLibrary) starts afresh. Plain module state —
 * nothing renders from it. */
const TRAIL_MAX = 10;
/** @type {VR.TrailEntry[]} */
let trail = [];
/** @type {string | null} */
let restoreDetail = null;

function pushTrail() {
  /** @type {VR.TrailEntry | null} */
  let e = null;
  if (S.screen === 'detail') e = { screen: 'detail', id: S.detailId, type: S.detailType, focus: S.focusKey };
  else if (S.screen === 'person') e = { screen: 'person', id: S.personId, name: S.personName, focus: S.focusKey };
  else if (S.screen === 'lookup') e = { screen: 'lookup', item: S.lookup, focus: S.focusKey };
  if (!e) return;
  trail.push(e);
  if (trail.length > TRAIL_MAX) trail.shift();
}

/* Consumed by a detail/person screen on mount: the focus key to land on when
 * this mount is a Back along the trail, else null. */
/** @returns {string | null} */
export function takeDetailFocus() {
  const k = restoreDetail;
  restoreDetail = null;
  return k;
}

export function openHome() {
  restoreHome = null;
  searchReturn = null;
  trail = [];
  restoreDetail = null;
  S.screen = 'home';
  S.base = 'home';
  S.tab = 'home';
  S.epoch++;
}

/* Back out of a video that was started on Home (the hero's Resume): Home again,
 * on `focus` — rather than the item's detail page, a screen the user never saw. */
/** @param {string} [focus]  data-focus key to land on */
export function returnHome(focus) {
  openHome();
  restoreHome = focus || null;
}

/** @param {string} type the library tab, 'movies' | 'shows' */
export function openLibrary(type) {
  // A plain tab click keeps focus on the pill; only onBack() re-arms a restore,
  // and it does so *after* this call.
  restoreFocus = null;
  searchReturn = null;
  trail = [];
  restoreDetail = null;
  S.screen = 'library';
  S.base = 'library';
  S.tab = type;
  S.epoch++;
}

/** @param {string} id  Jellyfin item id @param {string | null} [type]  its Type ('Movie', 'Series', …) */
export function openItem(id, type) {
  // The key is derivable from the id (Tile.svelte's data-focus), so remembering
  // it here doesn't depend on S.focusKey having caught the right focusin.
  if (S.screen === 'library' && !searchReturn) gridFocus.set(S.tab, 'tile-' + id);
  rememberHome();
  // detail → detail (More Like This, "Seasons ›", a title on a person page):
  // remember the page being left. Not from the player — exitPlayer() re-opens
  // the page playback started from, which is not a step forward.
  if (!(S.screen === 'detail' && S.detailId === id)) pushTrail();
  restoreDetail = null;
  S.detailId = id;
  S.detailType = type;
  S.screen = 'detail';
  S.base = 'detail';
  S.epoch++;
}

/* A cast member's filmography in this library (Person.svelte), opened from a
 * detail page's Cast rail. Back returns to that page, on the cast member. */
/** @param {string} id @param {string | null} [name] */
export function openPerson(id, name) {
  pushTrail();
  restoreDetail = null;
  S.personId = id;
  S.personName = name || '';
  S.screen = 'person';
  S.base = 'person';
  S.epoch++;
}

/* Back along the trail: re-open the previous detail/person page and hand it
 * the focus key it was left on. */
function popTrail() {
  const e = /** @type {VR.TrailEntry} the caller checks trail.length */ (trail.pop());
  if (e.screen === 'person') {
    S.personId = e.id;
    S.personName = e.name;
  } else if (e.screen === 'lookup') {
    S.lookup = e.item;
  } else {
    S.detailId = e.id;
    S.detailType = e.type;
  }
  S.screen = e.screen;
  S.base = e.screen;
  restoreDetail = e.focus || null;
  S.epoch++;
}

/* Search is not a tab or a screen: ▲ past the top of the tab bar raises it over
 * whatever tab is mounted (S.screen/S.base stay put — Back just lowers it again,
 * and focus returns to where it was raised from). Search.svelte owns the
 * focus handoff in both directions. */
/** @type {string | null} */
let searchFrom = null;

export function openSearch() {
  if (S.search) return;
  searchFrom = S.focusKey;
  S.search = true;
}

/* Returns the focus key to restore — the tab the search was raised from. */
/** @returns {string | null} */
export function closeSearch() {
  S.search = false;
  S.searchChart = null; // raised again, Search starts on the categories
  S.searchKb = false;
  const k = searchFrom;
  searchFrom = null;
  return k;
}

/* Back from an open browse category: back to the categories, on its card.
 * Returns that card's focus key. */
/** @returns {string} */
export function closeSearchChart() {
  const k = 'cat-' + S.searchChart;
  S.searchChart = null;
  return k;
}

/* Leave Search for a result's detail screen (`open` is the open*() call).
 * Back from there lands in Search again, on the same card — see onBack(). */
/** @type {string | null} */
let searchReturn = null;

/** @param {string} cardKey @param {() => void} open the open*() call */
export function openFromSearch(cardKey, open) {
  // before open(): openItem()/openPending() read it to skip the grid-focus memory
  searchReturn = cardKey;
  open();
  S.search = false;
}

/* Rebuild the tab Search was raised over and put Search back up on `card`. */
function returnToSearch() {
  const k = searchReturn;
  searchReturn = null;
  openTab(S.tab);
  S.searchFocus = k;
  S.search = true;
}

/* A search result that isn't a Jellyfin item: previewed from Sonarr/Radarr
 * metadata by LookupDetail, with Add to library where Play would be. */
/** @param {Reel.LookupResult | Reel.LookupRef} item */
export function openLookup(item) {
  rememberHome();
  // From a detail page (a film of its collection): Back returns there.
  pushTrail();
  restoreDetail = null;
  S.lookup = item;
  S.screen = 'lookup';
  S.base = 'lookup';
  S.epoch++;
}

/** @param {string} tab */
function openTab(tab) {
  if (tab === 'movies' || tab === 'shows') openLibrary(tab);
  else openHome();
}

/* Detail view for a title that is still downloading — it has no Jellyfin item
 * yet, so it is addressed by its activity group key (see activity.svelte.js).
 * S.tab stays on the library tab it was opened from, which is what onBack()
 * returns to. */
/** @param {string} key  activity group key */
export function openPending(key) {
  if (S.screen === 'library' && !searchReturn) gridFocus.set(S.tab, 'pend-' + key);
  rememberHome();
  pushTrail();   // a no-op unless opened from a detail page (a collection film)
  restoreDetail = null;
  S.pendingKey = key;
  S.screen = 'pending';
  S.base = 'pending';
  S.epoch++;
}

export function onBack() {
  if (S.screen === 'login' && S.addingAccount) {
    openHome();
    return;
  }
  // detail → detail first: the page this one was opened from, however that
  // page itself was reached (tab, Home, Search) — its own Back handles that.
  if (trail.length && ['detail', 'person', 'pending', 'lookup'].includes(S.screen)) {
    popTrail();
    return;
  }
  if (S.screen === 'person') {
    // no trail entry (can't normally happen): fall back to the tab
    trail = [];
    S.screen = 'detail';
  }
  if (searchReturn && (S.screen === 'detail' || S.screen === 'pending' || S.screen === 'lookup')) {
    returnToSearch();
    return;
  }
  if (S.screen === 'detail' || S.screen === 'pending' || S.screen === 'lookup') {
    if (S.tab === 'movies' || S.tab === 'shows') {
      const tab = S.tab;
      openLibrary(tab);
      // after openLibrary(), which clears any stale restore
      restoreFocus = gridFocus.get(tab) || null;
    } else {
      openHome();
      restoreHome = homeFocus; // after openHome(), which clears any stale restore
    }
    return;
  }
  if (S.screen === 'library') {
    openHome();
    return;
  }
}
