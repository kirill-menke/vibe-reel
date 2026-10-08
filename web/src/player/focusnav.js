/* Keyboard focus inside the desktop player, kept free of Svelte so
 * test/web/player-focusnav.web.test.js can pin it (WebPlayer.svelte calls it).
 *
 *   choiceIn(panel, group)   where focus goes when a popover opens: its selected
 *                            option (a checked radio, the current chapter), else
 *                            its first option — in the column it was opened for
 *   panelStep(panel, from, key)  ↑ ↓ Home End move through the options of the
 *                            column `from` is in; ← → go to the next column's
 *                            selected option (Audio · Quality · Subtitles) —
 *                            null when the key has nothing to do there
 *   trapTab(box, from, back) Tab inside a modal card: the next / previous
 *                            focusable in it, wrapping round
 *   canRefocus(el)           an element focus can go back to: still in the
 *                            document, rendered, and not inside [inert] / [hidden]
 *   routeAction(doc)         the visible page's main action — where focus lands
 *                            when the control that opened the player is gone */

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** @param {Element} el */
function shown(el) {
  return el.getClientRects().length > 0; // none for display: none, [hidden], a detached node
}

/** @param {Element | null} el @returns {el is HTMLElement} */
export function canRefocus(el) {
  if (!el || !el.isConnected || !(/** @type {HTMLElement} */ (el).focus)) return false;
  if (el.closest('[inert], [hidden]')) return false;
  return el === document.body ? false : shown(el);
}

/** @param {Element} panel @returns {HTMLElement[]} the options, in order */
function options(panel) {
  return /** @type {HTMLElement[]} */ ([...panel.querySelectorAll('.option, .vr-adjust button')]).filter((x) => !x.matches(':disabled'));
}

/** @param {Element | null} panel @param {string} [group] prefer the radiogroup with this aria-label
 * (the column the popover was opened for: 'Subtitles' from the subtitles chip) @returns {HTMLElement | null} */
export function choiceIn(panel, group) {
  if (!panel) return null;
  const col = group ? panel.querySelector('[role="radiogroup"][aria-label="' + group + '"]') : null;
  if (col) return choiceIn(col);
  const sel = panel.querySelector('.option[aria-checked="true"], .option[aria-current="true"], .option--selected');
  return /** @type {HTMLElement | null} */ (sel) || options(panel)[0] || /** @type {HTMLElement | null} */ (panel.querySelector(FOCUSABLE));
}

/** @param {Element} panel @param {Element} from @param {string} key @returns {HTMLElement | null} */
export function panelStep(panel, from, key) {
  const cols = [...panel.querySelectorAll('[role="radiogroup"]')];
  const col = from.closest('[role="radiogroup"]');
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    if (cols.length < 2) return null;
    const i = col ? cols.indexOf(col) : -1;
    const next = cols[i < 0 ? 0 : i + (key === 'ArrowRight' ? 1 : -1)];
    return next ? choiceIn(next) : null;
  }
  const list = options(col || panel);
  if (!list.length) return null;
  if (key === 'Home') return list[0];
  if (key === 'End') return list[list.length - 1];
  const i = list.indexOf(/** @type {HTMLElement} */ (from));
  if (key === 'ArrowDown') return i < 0 ? list[0] : list[Math.min(list.length - 1, i + 1)];
  if (key === 'ArrowUp') return i < 0 ? list[list.length - 1] : list[Math.max(0, i - 1)];
  return null;
}

/** @param {Element} box @param {Element | null} from @param {boolean} back Shift+Tab @returns {HTMLElement | null} */
export function trapTab(box, from, back) {
  const list = /** @type {HTMLElement[]} */ ([...box.querySelectorAll(FOCUSABLE)]).filter(shown);
  if (!list.length) return null;
  const i = from ? list.indexOf(/** @type {HTMLElement} */ (from)) : -1;
  if (i < 0) return back ? list[list.length - 1] : list[0];
  return list[(i + (back ? -1 : 1) + list.length) % list.length];
}

/** @param {Document} doc @returns {HTMLElement | null} */
export function routeAction(doc) {
  const route = doc.querySelector('.route:not([hidden]):not([inert])');
  if (!route) return null;
  for (const sel of ['.btn--primary', '.action', '.screen']) {
    const el = /** @type {HTMLElement | null} */ ([...route.querySelectorAll(sel)].find((x) => canRefocus(x)) || null);
    if (el) {
      if (sel === '.screen' && !el.hasAttribute('tabindex')) el.tabIndex = -1;
      return el;
    }
  }
  return null;
}
