/* Tab inside the confirm dialog, in the order its answers are drawn (S2-5).
 *
 * The confirm is the phone's ActionSheet (shared markup: the action first, then
 * Cancel in a group of its own). On the web it is a desktop dialog whose
 * answers share one row, the safe one first — web.css puts them there with
 * CSS `order` (`.actsheet__btn--cancel { order: 1 }`, the action `order: 2`).
 * Focus opens on Cancel ("Keep"), and Tab followed the DOM: from Keep straight
 * out of the dialog (to <body>, or to the browser's toolbar in Firefox), and
 * Shift+Tab went right, to Delete. Here Tab and Shift+Tab walk the answers as
 * they are drawn and wrap at either end, which also keeps the keyboard inside
 * the alertdialog (aria-modal) while it is up. */

const BOX = '.actsheet:not([inert]) .actsheet__box';

/** The dialog's answers as drawn: Cancel first, then the rest in DOM order.
 * @param {ParentNode} box @returns {HTMLButtonElement[]} */
export function drawnOrder(box) {
  const btns = /** @type {NodeListOf<HTMLButtonElement>} */ (box.querySelectorAll('button.actsheet__btn'));
  const all = [...btns].filter((b) => !b.disabled);
  return [...all.filter((b) => b.classList.contains('actsheet__btn--cancel')), ...all.filter((b) => !b.classList.contains('actsheet__btn--cancel'))];
}

/** @param {KeyboardEvent} e */
export function onKey(e) {
  if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
  const box = document.querySelector(BOX);
  if (!box) return;
  const order = drawnOrder(box);
  if (!order.length) return;
  e.preventDefault();
  const i = order.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
  const n = order.length;
  const next = i < 0 ? order[e.shiftKey ? n - 1 : 0] : order[(i + (e.shiftKey ? -1 : 1) + n) % n];
  next.focus();
}

export function initConfirmTab() {
  window.addEventListener('keydown', onKey, true);
}
