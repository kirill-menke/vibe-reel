/* Type test: VR.NavState describes S in src/lib/nav.svelte.js exactly — same keys
 * both ways, and S is assignable to it. If a field is added to S, add it to
 * VR.NavState (types/app.d.ts) too. The real guard is the `@satisfies {VR.NavState}` on the
 * $state literal in nav.svelte.js (`typeof S` is the declared VR.NavState, so SameKeys is a
 * tripwire for the annotation itself). */
import { S } from '../../../src/lib/nav.svelte.js';

/** @type {TypeTest.Assert<TypeTest.SameKeys<VR.NavState, typeof S>>} */
export const navStateKeys = true;

/** @type {VR.NavState} */
export const navStateAssignable = S;

/** @type {TypeTest.Assert<TypeTest.Not<TypeTest.IsAny<VR.Screen>>>} */
export const screenNotAny = true;

// @ts-expect-error 'nope' is not a screen: proves VR.Screen is a closed union, not string/any.
/** @type {VR.Screen} */ export const badScreen = 'nope';
