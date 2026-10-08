/* Focus never rests on <body> in the browse UI. When the focused element goes
 * away under the keyboard — a Retry whose card unmounts on success, the
 * toast's Undo removing itself, Esc leaving the Search field, a confirm
 * answered No by a browser Back — <body> is left with focus: PageDown, Space
 * and End then scroll nothing and a screen reader starts over at the top.
 * This puts focus on the shown page's scroller (or what `target()` names)
 * instead — but only after everyone with a hand-off of their own has had
 * their turn, and never against one:
 *
 *   - it waits a frame and REST ms after the loss (the player's hand-back is
 *     tick + a frame, a sheet's a task after it unmounts);
 *   - `blocked()` (App: a sheet, a modal, a confirm, a context menu) skips it
 *     — those own focus while they're up, and give it back when they close;
 *   - `holdGuard()` holds it off while a keeper of its own is watching for a
 *     focus on <body> (ctxmenu.js's keepFocus: a removed tile's neighbour);
 *     released, the guard looks once more.
 *
 * What counts as the loss: a focusout with nowhere to go (Chrome also fires
 * one when the focused element is removed or hidden), and — for Firefox,
 * which fires nothing when the focused element is removed — the focused
 * element's removal, seen by a MutationObserver on its ancestors' child
 * lists only (not the whole document, which grids churn). */

const REST = 100;

/** @type {Set<symbol>} */
const holds = new Set();
/** @type {(() => void) | null} */
let recheck = null;

/** Hold the guard off until the returned release() is called (or `ms` pass).
 * @param {number} [ms] @returns {() => void} */
export function holdGuard(ms = 5000) {
  const k = Symbol('hold');
  holds.add(k);
  const t = setTimeout(() => release(), ms);
  const release = () => {
    clearTimeout(t);
    if (holds.delete(k) && !holds.size) recheck?.();
  };
  return release;
}

export const guardHeld = () => holds.size > 0;

/** @param {Element | null} a */
const lost = (a) => !a || a === document.body || a === document.documentElement;

/**
 * @param {{ blocked: () => boolean, target: () => HTMLElement | null | undefined, rest?: number }} o
 * @returns {() => void} stop
 */
export function initFocusGuard({ blocked, target, rest = REST }) {
  /** @type {Element | null} */
  let watched = null;
  let raf = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;

  const mo = new MutationObserver(() => {
    if (watched && !watched.isConnected) {
      watched = null;
      mo.disconnect();
      schedule();
    }
  });

  /** @param {Element} el */
  function watch(el) {
    mo.disconnect();
    watched = el;
    for (let n = el.parentNode; n && n !== document; n = n.parentNode) mo.observe(n, { childList: true });
  }

  function check() {
    // (a Tab out to the browser's own UI also leaves <body>: not ours to take back)
    if (!lost(document.activeElement) || document.hidden || !document.hasFocus()) return;
    if (holds.size || blocked()) return;
    const t = target();
    if (t && t.isConnected) t.focus({ preventScroll: true });
  }

  function schedule() {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    raf = requestAnimationFrame(() => {
      raf = 0;
      timer = setTimeout(check, rest);
    });
  }

  /** @param {FocusEvent} e */
  const onIn = (e) => {
    if (e.target instanceof Element) watch(e.target);
  };
  /** @param {FocusEvent} e */
  const onOut = (e) => {
    if (!e.relatedTarget) schedule();
  };
  document.addEventListener('focusin', onIn);
  document.addEventListener('focusout', onOut);
  recheck = schedule;
  if (document.activeElement && !lost(document.activeElement)) watch(document.activeElement);

  return () => {
    document.removeEventListener('focusin', onIn);
    document.removeEventListener('focusout', onOut);
    mo.disconnect();
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    if (recheck === schedule) recheck = null;
  };
}
