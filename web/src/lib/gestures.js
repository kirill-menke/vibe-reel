/* Web variant of phone/src/lib/gestures.js (swapped in by web/vite.config.js;
 * this file imports the original under its real path, which the redirect
 * leaves alone for it). Everything is the phone's, except that a long-press
 * target also opens on a right-click — the desktop's "more actions" — and a
 * mouse hold still works as on the phone. */
import { longpress as holdPress } from '../../../phone/src/lib/gestures.js';

export * from '../../../phone/src/lib/gestures.js';

/** @param {HTMLElement} node @param {VR.LongPressOptions | ((d: VR.LongPressDetail) => void) | null} [opts] */
export function longpress(node, opts) {
  /** @type {VR.LongPressOptions} */
  let o = typeof opts === 'function' ? { onlongpress: opts } : { ...(opts || {}) };
  const inner = holdPress(node, opts);
  /** @param {MouseEvent} e */
  const ctx = (e) => {
    if (o.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    /** @type {VR.LongPressDetail} */
    const detail = { x: e.clientX, y: e.clientY, rect: node.getBoundingClientRect(), node };
    node.dispatchEvent(new CustomEvent('longpress', { detail }));
    o.onlongpress?.(detail);
  };
  node.addEventListener('contextmenu', ctx);
  return {
    /** @param {VR.LongPressOptions | ((d: VR.LongPressDetail) => void) | null} n */
    update(n) {
      o = typeof n === 'function' ? { onlongpress: n } : { ...(n || {}) };
      inner.update?.(n);
    },
    destroy() {
      node.removeEventListener('contextmenu', ctx);
      inner.destroy?.();
    }
  };
}
