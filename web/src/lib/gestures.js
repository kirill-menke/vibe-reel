/* Web variant of phone/src/lib/gestures.js (swapped in by web/vite.config.js;
 * this file imports the original under its real path, which the redirect
 * leaves alone for it). Everything is the phone's, except `longpress` — the
 * hook for every node that can have a context menu (Tile, EpisodeRow, the
 * season pills):
 *   - a right-click opens it too (the desktop's "more actions"), and so do
 *     Shift+F10 and the Menu key, which raise the same contextmenu event on
 *     the focused element; a mouse hold still works as on the phone;
 *   - the node gets a visible ⋯ button that opens it (ctxmore.js), and a tile
 *     its link/button role and description;
 *   - each open tells ctxmenu.js where it came from (pointer, key or ⋯), so
 *     the menu is placed there, takes focus and gives it back.
 * The detail's rect is a fresh copy, never the one the phone's pressSource()
 * knows: the desktop menu has no lifted preview, so ContextMenu must not hide
 * the pressed node for one. */
import { longpress as holdPress } from '../../../phone/src/lib/gestures.js';
import { noteOpen, viaKeyboard } from './ctxmenu.js';
import { moreFor } from './ctxmore.js';

export * from '../../../phone/src/lib/gestures.js';

/** @param {VR.LongPressOptions | ((d: VR.LongPressDetail) => void) | null | undefined} n @returns {VR.LongPressOptions} */
const norm = (n) => (typeof n === 'function' ? { onlongpress: n } : { ...(n || {}) });

/** the focused element, if it is inside node (a row's ⋯, a tile's "+") @param {HTMLElement} node */
const focusIn = (node) => {
  const a = document.activeElement;
  return a instanceof HTMLElement && node.contains(a) ? a : null;
};

/** @param {HTMLElement} node @param {VR.LongPressOptions | ((d: VR.LongPressDetail) => void) | null} [opts] */
export function longpress(node, opts) {
  /** @type {VR.LongPressOptions} */
  let o = norm(opts);

  /** the phone's hold, noting the open and handing on a fresh rect
   * @param {VR.LongPressOptions | ((d: VR.LongPressDetail) => void) | null | undefined} n @returns {VR.LongPressOptions} */
  const hold = (n) => {
    const x = norm(n);
    const f = x.onlongpress;
    if (!f) return x;
    return {
      ...x,
      onlongpress: (d) => {
        noteOpen({ source: node, returnTo: focusIn(node), x: d.x, y: d.y, via: 'pointer' });
        f({ ...d, rect: DOMRect.fromRect(d.rect) });
      }
    };
  };
  const inner = holdPress(node, hold(opts));

  /** @param {VR.LongPressDetail} detail */
  const fire = (detail) => {
    node.dispatchEvent(new CustomEvent('longpress', { detail }));
    o.onlongpress?.(detail);
  };

  /** @param {MouseEvent} e */
  const ctx = (e) => {
    if (o.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    noteOpen({ source: node, returnTo: focusIn(node), x: e.clientX, y: e.clientY, via: viaKeyboard() ? 'key' : 'pointer' });
    fire({ x: e.clientX, y: e.clientY, rect: node.getBoundingClientRect(), node });
  };
  node.addEventListener('contextmenu', ctx);

  const more = moreFor(
    node,
    () => !o.disabled && !!o.onlongpress,
    (btn) => {
      const r = btn.getBoundingClientRect();
      noteOpen({ source: node, returnTo: btn.tabIndex >= 0 ? btn : null, anchor: btn, via: 'button' });
      fire({ x: r.left + r.width / 2, y: r.bottom, rect: node.getBoundingClientRect(), node });
    }
  );

  return {
    /** @param {VR.LongPressOptions | ((d: VR.LongPressDetail) => void) | null} n */
    update(n) {
      o = norm(n);
      inner.update?.(hold(n));
      more.update();
    },
    destroy() {
      node.removeEventListener('contextmenu', ctx);
      inner.destroy?.();
      more.destroy();
    }
  };
}
