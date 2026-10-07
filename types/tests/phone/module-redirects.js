/* Type test: the phone build swaps three TV modules for phone ones
 * (phone/vite.config.js moduleRedirects). src/lib imports them relatively, so the
 * shim must export every name the TV module exports — CLAUDE.md: the router shim
 * "exports every TV name". (The bundler only catches names src/lib imports today;
 * this catches the drift before a new import trips the phone build.)
 * Also proves phone/jsconfig.json maps `$lib/nav.svelte.js` to the phone shim. */
import * as tvNav from '../../../src/lib/nav.svelte.js';
import * as phoneNav from '../../../phone/src/lib/nav.svelte.js';
import * as viaAlias from '$lib/nav.svelte.js';
import * as tvFocus from '../../../src/lib/focus.js';
import * as phoneFocus from '../../../phone/src/lib/focus-shim.js';
import * as focusViaAlias from '$lib/focus.js';
import * as tvLife from '../../../src/lib/lifecycle.js';
import * as phoneLife from '../../../phone/src/lib/lifecycle.js';
import * as lifeViaAlias from '$lib/lifecycle.js';

/** @type {TypeTest.Assert<TypeTest.KeysSubset<typeof tvNav, typeof phoneNav>>} */
export const navShimHasEveryTvName = true;

/** @type {TypeTest.Assert<TypeTest.SameKeys<typeof viaAlias, typeof phoneNav>>} */
export const navAliasIsPhoneShim = true;
/** @type {TypeTest.Assert<TypeTest.SameKeys<typeof focusViaAlias, typeof phoneFocus>>} */
export const focusAliasIsPhoneShim = true;
/** @type {TypeTest.Assert<TypeTest.SameKeys<typeof lifeViaAlias, typeof phoneLife>>} */
export const lifecycleAliasIsPhoneShim = true;

/* focus.js / lifecycle.js shims cover only what shared code imports (checked by the phone
 * build). The exact lists of TV exports the shims leave out — if one of these is ever imported
 * by src/lib, the phone build breaks, so a change here must be deliberate: */
/** @type {TypeTest.Assert<TypeTest.Equal<Exclude<keyof typeof tvFocus, keyof typeof phoneFocus>, 'jumpScroll' | 'hasKey'>>} */
export const focusOnlyOnTv = true;
/** @type {TypeTest.Assert<TypeTest.KeysSubset<typeof tvLife, typeof phoneLife>>} */
export const lifecycleShimHasEveryTvName = true;
/** @type {TypeTest.Assert<TypeTest.KeysSubset<typeof phoneFocus, typeof tvFocus>>} */
export const focusShimAddsNothing = true;

/* Signature level: each shim export can stand in for the TV export of the same name — it takes
 * every argument list the TV function takes, and returns the same or nothing (VR.ShimOf).
 * focus.js: every export the shim has. */
/** @type {VR.ShimOf<typeof tvFocus.focusables>} */ export const s_focusables = phoneFocus.focusables;
/** @type {VR.ShimOf<typeof tvFocus.byKey>} */ export const s_byKey = phoneFocus.byKey;
/** @type {VR.ShimOf<typeof tvFocus.focusEl>} */ export const s_focusEl = phoneFocus.focusEl;
/** @type {VR.ShimOf<typeof tvFocus.focusKey>} */ export const s_focusKey = phoneFocus.focusKey;
/** @type {VR.ShimOf<typeof tvFocus.focusKeyInstant>} */ export const s_focusKeyInstant = phoneFocus.focusKeyInstant;
/** @type {VR.ShimOf<typeof tvFocus.focusNow>} */ export const s_focusNow = phoneFocus.focusNow;
/** @type {VR.ShimOf<typeof tvFocus.focusFirst>} */ export const s_focusFirst = phoneFocus.focusFirst;
/** @type {VR.ShimOf<typeof tvFocus.scrollElTo>} */ export const s_scrollElTo = phoneFocus.scrollElTo;
/** @type {VR.ShimOf<typeof tvFocus.scrollElBy>} */ export const s_scrollElBy = phoneFocus.scrollElBy;
/** @type {VR.ShimOf<typeof tvFocus.ensureVisible>} */ export const s_ensureVisible = phoneFocus.ensureVisible;
/** @type {VR.ShimOf<typeof tvFocus.spatialMove>} */ export const s_spatialMove = phoneFocus.spatialMove;
/** @type {VR.ShimOf<typeof tvFocus.focusLost>} */ export const s_focusLost = phoneFocus.focusLost;
/** @type {VR.ShimOf<typeof tvFocus.recoverFocus>} */ export const s_recoverFocus = phoneFocus.recoverFocus;
/** @type {VR.ShimOf<typeof tvFocus.clearMarquee>} */ export const s_clearMarquee = phoneFocus.clearMarquee;
/** @type {VR.ShimOf<typeof tvFocus.marqueeFocus>} */ export const s_marqueeFocus = phoneFocus.marqueeFocus;
/** @type {VR.ShimOf<typeof tvFocus.playerButtons>} */ export const s_playerButtons = phoneFocus.playerButtons;
/* The shim's no-ops really take the TV arguments (they used to be declared with none). */
/** @type {TypeTest.Assert<TypeTest.Equal<Parameters<typeof phoneFocus.focusKey>, [key: string]>>} */
export const focusKeyTakesAKey = true;

/* nav.svelte.js: every function src/lib imports (player, lookup: openHome, openItem,
 * openPending, openLookup, returnHome). S is covered by router-state.js. */
/** @type {VR.ShimOf<typeof tvNav.openHome>} */ export const s_openHome = phoneNav.openHome;
/** @type {VR.ShimOf<typeof tvNav.openItem>} */ export const s_openItem = phoneNav.openItem;
/** @type {VR.ShimOf<typeof tvNav.openPending>} */ export const s_openPending = phoneNav.openPending;
/** @type {VR.ShimOf<typeof tvNav.openLookup>} */ export const s_openLookup = phoneNav.openLookup;
/** @type {VR.ShimOf<typeof tvNav.returnHome>} */ export const s_returnHome = phoneNav.returnHome;

/* lifecycle.js: its only export. */
/** @type {VR.ShimOf<typeof tvLife.initLifecycle>} */ export const s_initLifecycle = phoneLife.initLifecycle;

/* A shim that demanded more than the TV signature gives would not stand in: */
// @ts-expect-error a shim needing a 2nd required argument can't take a 1-argument TV call.
/** @type {VR.ShimOf<typeof tvFocus.focusKey>} */ export const tooStrict = /** @type {(k: string, x: number) => Promise<void>} */ (null);

/* T29 — the names src/lib actually imports from the three redirected modules (grep of
 * `from './nav.svelte.js' | './focus.js' | './lifecycle.js'` over src/lib, 2026-10-03):
 *   nav.svelte.js  S, openHome, openItem, openPending, openLookup, returnHome
 *   focus.js       focusFirst, focusKey
 *   lifecycle.js   (none: only main.js / App boot it)
 * For nav the phone export is assignable to the TV export's own type — not just ShimOf: */
/** @type {typeof tvNav.openHome} */ export const a_openHome = phoneNav.openHome;
/** @type {typeof tvNav.openItem} */ export const a_openItem = phoneNav.openItem;
/** @type {typeof tvNav.openPending} */ export const a_openPending = phoneNav.openPending;
/** @type {typeof tvNav.openLookup} */ export const a_openLookup = phoneNav.openLookup;
/** @type {typeof tvNav.returnHome} */ export const a_returnHome = phoneNav.returnHome;
/* …and so is every other TV nav function the shim re-implements (phone code reaches them through
 * `$lib/nav.svelte.js`, the TV screens' call shapes must keep working): */
/** @type {typeof tvNav.takeGridFocus} */ export const a_takeGridFocus = phoneNav.takeGridFocus;
/** @type {typeof tvNav.peekHomeFocus} */ export const a_peekHomeFocus = phoneNav.peekHomeFocus;
/** @type {typeof tvNav.takeHomeFocus} */ export const a_takeHomeFocus = phoneNav.takeHomeFocus;
/** @type {typeof tvNav.takeDetailFocus} */ export const a_takeDetailFocus = phoneNav.takeDetailFocus;
/** @type {typeof tvNav.openLogin} */ export const a_openLogin = phoneNav.openLogin;
/** @type {typeof tvNav.openLibrary} */ export const a_openLibrary = phoneNav.openLibrary;
/** @type {typeof tvNav.openPerson} */ export const a_openPerson = phoneNav.openPerson;
/** @type {typeof tvNav.openSearch} */ export const a_openSearch = phoneNav.openSearch;
/** @type {typeof tvNav.closeSearch} */ export const a_closeSearch = phoneNav.closeSearch;
/* closeSearchChart: the TV's returns the card key (string), the phone's null — see the pin below.
 * Under strictNullChecks a null return is not a string, so it is checked as "the TV's arguments,
 * the TV's return or null" (the return itself is pinned exactly by closeSearchChartIsNullOnPhone): */
/** @type {(...a: Parameters<typeof tvNav.closeSearchChart>) => ReturnType<typeof tvNav.closeSearchChart> | null} */ export const a_closeSearchChart = phoneNav.closeSearchChart;
/** @type {typeof tvNav.openFromSearch} */ export const a_openFromSearch = phoneNav.openFromSearch;
/** @type {typeof tvNav.onBack} */ export const a_onBack = phoneNav.onBack;
/* Under this lane's strict:false (no strictNullChecks) a `null` return passes for any type:
 * closeSearch()/closeSearchChart() return null on the phone where the TV returns the key to
 * refocus (string | null / string). Only TV code reads it (Keys.svelte), never src/lib or phone
 * code, so it is no incompatibility in practice — pinned here so it stays visible: */
/** @type {TypeTest.Assert<TypeTest.Equal<ReturnType<typeof phoneNav.closeSearchChart>, null>>} */
export const closeSearchChartIsNullOnPhone = true;
/** The nav shim's S is the TV S's shape except the wider screen/base (router-state.js). */
/** @type {Omit<VR.NavState, 'screen' | 'base'>} */ export const a_S = phoneNav.S;

/* focus.js: src/lib calls focusFirst() and focusKey(key) as statements — their results are never
 * read (lifecycle.js:72, player.svelte.js ×5), so the shim's "returns nothing" (ShimOf above) is
 * all the TV call sites need. Pinned, so a src/lib use of the result is a deliberate change: */
/** @type {TypeTest.Assert<TypeTest.Equal<ReturnType<typeof phoneFocus.focusKey>, Promise<boolean | void>>>} */
export const focusKeyResultMayBeVoid = true;
/* focusFirst() resolves to nothing on both sides, so there the shim is the TV type outright: */
/** @type {typeof tvFocus.focusFirst} */ export const a_focusFirst = phoneFocus.focusFirst;
