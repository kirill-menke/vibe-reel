/* Small pure helpers of the desktop shell (App.svelte), kept apart so the
 * tests can pin them: what counts as typing, the Undo shortcut, and how the
 * fixed navigation keeps clear of the page's scrollbar. */

/** @param {EventTarget | null} t @returns {boolean} focus is in a text field (keys belong to it) */
export function isTyping(t) {
  const el = /** @type {HTMLElement | null} */ (t && /** @type {any} */ (t).nodeType === 1 ? t : null);
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (/** @type {HTMLInputElement} */ (el).type || 'text').toLowerCase();
  return !/^(button|checkbox|radio|range|color|file|submit|reset|image)$/.test(type);
}

/** @param {{ key: string, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean, altKey?: boolean }} e
 *  @param {boolean} [mac] @returns {boolean} the platform's Undo chord (Ctrl+Z, ⌘Z on a Mac) */
export function isUndoKey(e, mac = false) {
  if ((e.key || '').toLowerCase() !== 'z' || e.shiftKey || e.altKey) return false;
  return mac ? !!e.metaKey && !e.ctrlKey : !!e.ctrlKey && !e.metaKey;
}

/** @returns {boolean} */
export function isMac() {
  const p = /** @type {any} */ (navigator).userAgentData?.platform || navigator.platform || '';
  return /mac|iphone|ipad/i.test(p);
}

/* An overlay scrollbar (GTK, macOS) takes no room, so nothing can be
 * measured; the thumb still needs this strip at the window's right edge. */
export const OVERLAY_SCROLLBAR = 12;

/** @param {number} sbw  the page scroller's offsetWidth − clientWidth (a
 *  `scrollbar-gutter: stable` scroller reports its gutter even when it
 *  doesn't scroll)
 *  @returns {{ right: number, pad: number }} the nav's inset from the right
 *  edge, and how much of it comes out of its own end padding (an overlay
 *  thumb lies over the content, so the nav's avatar still ends where the
 *  content does) */
export function navInset(sbw) {
  const w = Math.max(0, Math.round(sbw || 0));
  return w > 0 ? { right: w, pad: 0 } : { right: OVERLAY_SCROLLBAR, pad: OVERLAY_SCROLLBAR };
}
