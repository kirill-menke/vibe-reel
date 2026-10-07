/* Type test: VR.RouterState / VR.PhoneNavState describe the phone router's R and S
 * (phone/src/lib/router.svelte.js). Both classes carry `@implements`, so every field must have a
 * conforming type; SameKeys here adds "and nothing undeclared" (typeof R is the class, not the
 * interface). If a field is added to Router / NavState, add it to types/app.d.ts too. */
import { R, S, TABS, push, openSheet } from '../../../phone/src/lib/router.svelte.js';
import * as navShim from '$lib/nav.svelte.js';

/** @type {TypeTest.Assert<TypeTest.SameKeys<VR.RouterState, typeof R>>} */
export const routerKeys = true;
/** @type {VR.RouterState} */
export const routerAssignable = R;

/** @type {TypeTest.Assert<TypeTest.SameKeys<VR.PhoneNavState, typeof S>>} */
export const phoneNavKeys = true;
/** @type {VR.PhoneNavState} */
export const phoneNavAssignable = S;

/* The phone S has every key the TV VR.NavState has — src/lib reads S through the nav shim,
 * which re-exports this S. Nothing is missing; the only difference is that `screen`/`base`
 * are wider (phone route names, see VR.PhoneScreen) and S.splashActive starts false (no splash). */
/** @type {TypeTest.Assert<TypeTest.KeysSubset<VR.NavState, typeof S>>} */
export const phoneSHasEveryNavKey = true;
/** @type {Omit<VR.NavState, 'screen' | 'base'>} */
export const phoneSSameValueTypes = S;
/** Every TV screen is a phone screen (src/lib's `S.screen === 'detail'` etc. stay meaningful). */
/** @type {TypeTest.Assert<[VR.Screen] extends [VR.PhoneScreen] ? true : false>} */
export const tvScreensArePhoneScreens = true;
/** The nav shim's S is this S. */
/** @type {TypeTest.Assert<typeof navShim.S extends typeof S ? true : false>} */
export const shimReexportsS = true;

/** @type {TypeTest.Assert<TypeTest.Not<TypeTest.IsAny<typeof R.stacks>>>} */
export const stacksNotAny = true;
/** @type {TypeTest.Assert<TypeTest.Not<TypeTest.IsAny<typeof R.anim>>>} */
export const animNotAny = true;
/** @type {TypeTest.Assert<TypeTest.Not<TypeTest.IsAny<typeof TABS>>>} */
export const tabsNotAny = true;

// @ts-expect-error 'album' is not a phone route: music lives in VibeSpin.
/** @type {VR.RouteName} */ export const badRoute = 'album';
// @ts-expect-error 'library' is TV vocabulary: the phone's routes are the movies/shows tabs.
/** @type {VR.TabName} */ export const badTab = 'library';
// @ts-expect-error 'player' is a modal, not a sheet.
/** @type {VR.SheetName} */ export const badSheet = 'player';

/** Signature checks (type-only: never called). */
export function _signatures() {
  /** @type {VR.Route} */
  const r = push('detail', { id: 'x', type: 'Movie' });
  openSheet('offline', { item: { Id: 'x' } });
  // @ts-expect-error push() takes a route name, not a sheet name.
  push('accounts');
  return r;
}
