/* Phone replacement for src/lib/focus.js (swapped in by phone/vite.config.js).
 * The TV's geometric D-pad engine has no job on a touch screen: every export
 * is a harmless no-op, and the few that return something return the "nothing
 * here" value. The scroll helpers still scroll (smoothly), since shared code
 * may drive a scroller through them. */

export function focusables() {
  return [];
}

export function byKey(key) {
  return key ? document.querySelector('[data-focus="' + CSS.escape(key) + '"]') : null;
}

export function focusEl() {}
export async function focusKey() {}
export async function focusKeyInstant() {}
export function focusNow() {}
export async function focusFirst() {}

export function scrollElTo(el, top) {
  el?.scrollTo?.({ top, behavior: 'smooth' });
}

export function scrollElBy(el, dy) {
  el?.scrollBy?.({ top: dy, behavior: 'smooth' });
}

export function ensureVisible() {}
export function spatialMove() {}
export function focusLost() {
  return false;
}
export async function recoverFocus() {}
export function clearMarquee() {}
export function marqueeFocus() {}
export function playerButtons() {
  return [];
}
