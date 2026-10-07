/* Phone replacement for src/lib/focus.js (swapped in by phone/vite.config.js).
 * The TV's geometric D-pad engine has no job on a touch screen: every export
 * is a harmless no-op, and the few that return something return the "nothing
 * here" value. The scroll helpers still scroll (smoothly), since shared code
 * may drive a scroller through them.
 *
 * Each no-op carries `@type {VR.ShimOf<…TV export…>}` (AsyncShimOf for the async ones): it takes the TV function's arguments
 * (shared code calls them with the TV signature) and returns nothing. */

/** @returns {Element[]} */
export function focusables() {
  return [];
}

/** @param {string} key @returns {Element | null} */
export function byKey(key) {
  return key ? document.querySelector('[data-focus="' + CSS.escape(key) + '"]') : null;
}

/** @type {VR.ShimOf<typeof import('../../../src/lib/focus.js')['focusEl']>} */
export function focusEl() {}
/** @type {VR.AsyncShimOf<typeof import('../../../src/lib/focus.js')['focusKey']>} */
export async function focusKey() {}
/** @type {VR.AsyncShimOf<typeof import('../../../src/lib/focus.js')['focusKeyInstant']>} */
export async function focusKeyInstant() {}
/** @type {VR.ShimOf<typeof import('../../../src/lib/focus.js')['focusNow']>} */
export function focusNow() {}
/** @type {VR.AsyncShimOf<typeof import('../../../src/lib/focus.js')['focusFirst']>} */
export async function focusFirst() {}

/** @param {Element | null | undefined} el @param {number} top */
export function scrollElTo(el, top) {
  el?.scrollTo?.({ top, behavior: 'smooth' });
}

/** @param {Element | null | undefined} el @param {number} dy */
export function scrollElBy(el, dy) {
  el?.scrollBy?.({ top: dy, behavior: 'smooth' });
}

/** @type {VR.ShimOf<typeof import('../../../src/lib/focus.js')['ensureVisible']>} */
export function ensureVisible() {}
/** @type {VR.ShimOf<typeof import('../../../src/lib/focus.js')['spatialMove']>} */
export function spatialMove() {}
/** @returns {boolean} */
export function focusLost() {
  return false;
}
/** @type {VR.AsyncShimOf<typeof import('../../../src/lib/focus.js')['recoverFocus']>} */
export async function recoverFocus() {}
/** @type {VR.ShimOf<typeof import('../../../src/lib/focus.js')['clearMarquee']>} */
export function clearMarquee() {}
/** @type {VR.ShimOf<typeof import('../../../src/lib/focus.js')['marqueeFocus']>} */
export function marqueeFocus() {}
/** @returns {Element[]} */
export function playerButtons() {
  return [];
}
