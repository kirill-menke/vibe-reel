/* What makes the desktop shell (.wapp: the navigation and the pages) inert
 * besides an open sheet: a confirm, a context menu, the add-account Login —
 * anything modal that lives outside .wapp. Each holder takes and releases its
 * own key; App.svelte makes .wapp inert while any key is held, so Tab, the
 * pointer and screen readers stay in the modal. Release before focusing
 * something inside .wapp again (an inert element can't take focus). */

export const MODAL = $state({ holds: /** @type {string[]} */ ([]) });

/** @param {string} key */
export function holdInert(key) {
  if (!MODAL.holds.includes(key)) MODAL.holds.push(key);
}

/** @param {string} key */
export function releaseInert(key) {
  const i = MODAL.holds.indexOf(key);
  if (i >= 0) MODAL.holds.splice(i, 1);
}
