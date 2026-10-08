/* Desktop context menus. The phone's ContextMenu (phone/src/components/
 * ContextMenu.svelte: a long-press menu with a lifted preview, portalled into
 * #app as `.ctx`) is reused as it is; this layer, started from main.js,
 * makes it a desktop menu without touching the shared component:
 *
 *  - where: at the pointer for a right-click / mouse hold, against the ⋯
 *    button for a click on it or a keyboard open (Shift+F10, the Menu key),
 *    flipped and clamped into the viewport with an 8-px margin. The lifted
 *    preview and the blurred scrim are the phone's look; on the desktop the
 *    menu stands alone (ctx.css hides the preview, so it is neither focusable
 *    nor in the accessibility tree).
 *  - modality: the menu holds MODAL key 'ctx' (.wapp inert) while it is up.
 *  - keys (WAI-ARIA menu pattern): focus starts on the first enabled item;
 *    ↑/↓ (wrapping), Home/End and a typed first letter move it; Enter/Space
 *    activate; Esc closes; Tab closes too (focus goes back to the source,
 *    the next Tab continues from there). A pointer over an item focuses it,
 *    so the keys continue from where the mouse is.
 *  - focus return: to the element the menu was opened from (the focused
 *    control inside the pressed node, else the node, else its ⋯) — at once
 *    when the close starts (Esc, Tab, a click outside, an item: so a confirm
 *    an item opens hands focus back there, not to a removed menu item), and
 *    again once the menu has gone if focus fell to <body> (an item that
 *    removed the source: then its neighbour in the same rail/grid/list).
 *
 * Also here, because it is the same keyboard capture: Enter/Space on a
 * button nested in a role=button/link host (the quick-add "+" on a tile, the
 * bell's "Get" on a news row, the ⋯ on an episode row) stays with that button
 * — the host's own key handler used to run as well (B-03). And Space on such
 * a host no longer scrolls the page under it.
 *
 * gestures.js (the web `longpress` wrapper) calls noteOpen() right before it
 * runs a node's onlongpress, so the menu that mounts next knows its source
 * and anchor. */
import { flushSync } from 'svelte';
import { holdInert, releaseInert } from './modal.svelte.js';
import { initMore } from './ctxmore.js';

export const MARGIN = 8;

/** @typedef {{ left: number, top: number, right: number, bottom: number }} Box */
/** @typedef {{ source: HTMLElement, returnTo?: HTMLElement | null, x?: number, y?: number, anchor?: HTMLElement | null, via: 'pointer' | 'key' | 'button' }} CtxOpen */

/** @type {(CtxOpen & { at: number }) | null} */
let pending = null;
/** @type {{ el: HTMLElement, o: CtxOpen, closing: boolean, peers: { list: Element | null, sel: string, idx: number }, off: () => void } | null} */
let cur = null;
let keyAt = -1e9; // the last Shift+F10 / ContextMenu keydown

/** The next menu to mount was opened like this (gestures.js). @param {CtxOpen} o */
export function noteOpen(o) {
  pending = { ...o, at: performance.now() };
}

/** Was the contextmenu event that is being handled raised from the keyboard? */
export const viaKeyboard = () => performance.now() - keyAt < 1000;

/** Is a context menu open (and not on its way out)? */
export const ctxOpen = () => !!cur && !cur.closing;

const clamp = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => Math.max(lo, Math.min(v, hi));

/** Where a w×h menu goes against an anchor box (a point has left = right,
 * top = bottom): below it and left-aligned, flipped to its right edge / above
 * it where that side runs out, then clamped into the viewport with margin m.
 * ox/oy: the corner the menu grows from (its transform-origin).
 * @param {Box} a @param {number} w @param {number} h @param {number} vw @param {number} vh
 * @returns {{ x: number, y: number, ox: 'left' | 'right', oy: 'top' | 'bottom' }} */
export function placeMenu(a, w, h, vw, vh, m = MARGIN) {
  /** @type {'left' | 'right'} */
  let ox = 'left';
  let x = a.left;
  if (x + w > vw - m && a.right - w >= m) {
    x = a.right - w;
    ox = 'right';
  }
  /** @type {'top' | 'bottom'} */
  let oy = 'top';
  let y = a.bottom;
  if (y + h > vh - m && a.top - h >= m) {
    y = a.top - h;
    oy = 'bottom';
  } else if (y + h > vh - m && a.top - m > vh - m - a.bottom) {
    // fits neither way: the roomier side, clamped (the menu scrolls if taller)
    y = a.top - h;
    oy = 'bottom';
  }
  return { x: Math.round(clamp(x, m, Math.max(m, vw - m - w))), y: Math.round(clamp(y, m, Math.max(m, vh - m - h))), ox, oy };
}

/** The index a menu key moves to among n items from i (-1: none focused).
 * @param {string} key @param {number} i @param {number} n @returns {number | null} */
export function moveIndex(key, i, n) {
  if (!n) return null;
  if (key === 'ArrowDown') return i < 0 ? 0 : (i + 1) % n;
  if (key === 'ArrowUp') return i < 0 ? n - 1 : (i - 1 + n) % n;
  if (key === 'Home' || key === 'PageUp') return 0;
  if (key === 'End' || key === 'PageDown') return n - 1;
  return null;
}

/** Type-ahead: the next label after i that starts with ch (wrapping), else null.
 * @param {string[]} labels @param {number} i @param {string} ch */
export function typeahead(labels, i, ch) {
  const c = ch.toLowerCase();
  for (let k = 1; k <= labels.length; k++) {
    const j = (i + k + labels.length) % labels.length;
    if (labels[j].trim().toLowerCase().startsWith(c)) return j;
  }
  return null;
}

/** @param {Element | null} el */
const usable = (el) =>
  el instanceof HTMLElement && el.isConnected && !el.closest('[inert], [hidden]') && (!el.checkVisibility || el.checkVisibility());

/** @param {HTMLElement} el */
const items = (el) => /** @type {HTMLButtonElement[]} */ ([...el.querySelectorAll('.ctx__item:not(:disabled)')]);

/** @param {HTMLElement | null | undefined} el */
function focusEl(el) {
  try {
    el?.focus({ preventScroll: true });
  } catch {
    /* detached */
  }
}

/** the ⋯ of a source node, if it has one */
/** @param {HTMLElement} n @returns {HTMLElement | null} */
const moreOf = (n) => /** @type {HTMLElement | null} */ (n.querySelector(':scope .ctxmore')) || /** @type {HTMLElement | null} */ (n.closest('.detail__pills')?.querySelector('.ctxmore') || null);

/** Where focus goes back to: the noted return target, else the source if it
 * takes focus, else its ⋯. @param {CtxOpen} o */
function returnTarget(o) {
  for (const el of [o.returnTo, o.source, moreOf(o.source)]) {
    if (el && usable(el) && el.tabIndex >= 0) return el;
  }
  return null;
}

/** The source's list and place in it, for a neighbour when an item removes it. @param {HTMLElement} src */
function peersOf(src) {
  const list = src.parentElement?.closest('.rail__track, .grid, .episodes, .pills, .notifs') || null;
  const sel = src.classList.contains('ctxmore') ? '.ctxmore' : src.classList[0] ? '.' + src.classList[0] : src.tagName;
  const idx = list ? [...list.querySelectorAll(sel)].indexOf(src) : -1;
  return { list, sel, idx };
}

/** the box the menu is placed against */
/** @param {CtxOpen} o @returns {Box} */
function anchorBox(o) {
  if (o.via === 'pointer' && o.x != null && o.y != null) return { left: o.x, top: o.y, right: o.x, bottom: o.y };
  const more = o.anchor || moreOf(o.source);
  const r = (more && more.isConnected && more.getBoundingClientRect().width ? more : o.source).getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

function position() {
  if (!cur) return;
  const menu = /** @type {HTMLElement | null} */ (cur.el.querySelector('.ctx__menu'));
  if (!menu) return;
  const p = placeMenu(anchorBox(cur.o), menu.offsetWidth, menu.offsetHeight, window.innerWidth, window.innerHeight);
  const s = cur.el.style;
  s.setProperty('--wctx-x', p.x + 'px');
  s.setProperty('--wctx-y', p.y + 'px');
  s.setProperty('--wctx-origin', `${p.ox} ${p.oy}`);
}

/** @param {boolean} on @param {CtxOpen} o */
function expanded(on, o) {
  for (const b of new Set([o.anchor, moreOf(o.source)])) {
    if (b && b.classList.contains('ctxmore')) b.setAttribute('aria-expanded', String(on));
  }
}

/** A noted open, or (a menu nobody noted — e.g. a hold on a node gestures.js
 * didn't wrap) one made up from the focused element. @returns {CtxOpen} */
function takeOpen() {
  const p = pending && performance.now() - pending.at < 2000 ? pending : null;
  pending = null;
  if (p && p.source.isConnected) return p;
  const a = /** @type {HTMLElement} */ (document.activeElement instanceof HTMLElement ? document.activeElement : document.body);
  return { source: a, returnTo: a, via: 'key' };
}

/** @param {HTMLElement} el the `.ctx` just portalled into #app */
function mounted(el) {
  if (cur) unmounted(cur.el, true);
  const o = takeOpen();
  /* the menu is the widget: no dialog around it (focus lands on an item,
   * and .wapp is inert), its name moves to the menu */
  const menu = /** @type {HTMLElement | null} */ (el.querySelector('.ctx__menu'));
  const label = el.getAttribute('aria-label');
  el.setAttribute('role', 'none');
  el.removeAttribute('aria-modal');
  el.removeAttribute('aria-label');
  if (menu && label) menu.setAttribute('aria-label', label);
  const prev = el.querySelector('.ctx__preview');
  if (prev) {
    prev.setAttribute('inert', '');
    prev.setAttribute('aria-hidden', 'true');
  }

  const back = /** @type {HTMLElement | null} */ (el.querySelector('.ctx__backdrop'));
  /** @param {Event} e */
  const onCtx = (e) => {
    // no browser menu over ours; a right-click outside closes it
    e.preventDefault();
    if (e.target === back) {
      begin();
      back?.click();
    }
  };
  /** @param {MouseEvent} e */
  const onClick = (e) => {
    const t = /** @type {Element} */ (e.target);
    if (t === back || t.closest('.ctx__item:not(:disabled)')) begin();
  };
  /** @param {PointerEvent} e */
  const onMove = (e) => {
    if (e.pointerType !== 'mouse') return;
    const it = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('.ctx__item:not(:disabled)'));
    if (it && document.activeElement !== it) focusEl(it);
  };
  el.addEventListener('contextmenu', onCtx);
  el.addEventListener('click', onClick, true);
  el.addEventListener('pointermove', onMove);
  addEventListener('resize', position);
  cur = {
    el,
    o,
    closing: false,
    peers: peersOf(o.source),
    off: () => {
      el.removeEventListener('contextmenu', onCtx);
      el.removeEventListener('click', onClick, true);
      el.removeEventListener('pointermove', onMove);
      removeEventListener('resize', position);
    }
  };
  holdInert('ctx');
  expanded(true, o);
  position();
  focusEl(items(el)[0]);
}

/** The close has started (Esc, Tab, a click outside or on an item): the page
 * is live again and focus goes back to the source now. */
function begin() {
  if (!cur || cur.closing) return;
  cur.closing = true;
  releaseInert('ctx');
  flushSync();
  const t = returnTarget(cur.o);
  if (t) focusEl(t);
}

/** @param {HTMLElement} el @param {boolean} [replaced] */
function unmounted(el, replaced = false) {
  if (!cur || cur.el !== el) return;
  const { o, peers } = cur;
  cur.off();
  cur = null;
  expanded(false, o);
  releaseInert('ctx');
  if (replaced) return;
  /* once the item's action has run (it may have navigated, opened a sheet or
   * a confirm, or removed the source): only a focus that fell to <body> is
   * put back — on the source, else its neighbour */
  keepFocus(() => {
    if (cur) return null;
    const t = returnTarget(o);
    if (t || !peers.list || !usable(peers.list)) return t;
    const all = /** @type {HTMLElement[]} */ ([...peers.list.querySelectorAll(peers.sel)]).filter((x) => x !== o.source && usable(x) && x.tabIndex >= 0);
    return all[Math.min(Math.max(peers.idx, 0), all.length - 1)] || null;
  });
}

/** @param {KeyboardEvent} e */
function menuKey(e) {
  if (!cur) return;
  const list = items(cur.el);
  const i = list.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
  const stop = () => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  if (e.key === 'Escape' || e.key === 'Tab') {
    /* close as a click outside does (ContextMenu's own Esc handler does the
     * same); nothing else on the page sees this Esc */
    stop();
    const back = /** @type {HTMLElement | null} */ (cur.el.querySelector('.ctx__backdrop'));
    begin();
    back?.click();
    return;
  }
  if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') return stop();
  const to = moveIndex(e.key, i, list.length);
  if (to != null) {
    stop();
    return focusEl(list[to]);
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') return stop();
  if (e.key === 'Enter' || e.key === ' ') {
    if (i < 0) {
      stop();
      focusEl(list[0]);
    }
    return; // the focused item's own activation
  }
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    stop();
    const j = typeahead(list.map((b) => b.textContent || ''), i, e.key);
    if (j != null) focusEl(list[j]);
  }
}

/** @param {Event} e */
const stopHere = (e) => e.stopPropagation();

/* Focus that falls to <body> under an action — for a few seconds after it:
 *  - a context-menu item that removed or re-rendered its source (Remove from
 *    Continue Watching, Mark as watched taking a tile out of the rail when
 *    the rail reloads) → the source, else its neighbour (see unmounted());
 *  - a nested button pressed from the keyboard that goes away under the
 *    focus (the quick-add "+" turns into a spinner, a ✓, then nothing; "Get"
 *    turns into a disabled "Found") → its host (the tile, the news row).
 * Only a focus on <body>, only onto a target that isn't inert (behind a
 * sheet or a confirm), and not once the pointer has been used since. */
let keepGen = 0;
/** @param {() => HTMLElement | null} pick */
function keepFocus(pick, ms = 3000) {
  const gen = ++keepGen;
  const until = performance.now() + ms;
  const stopOnPointer = () => {
    if (gen === keepGen) keepGen++;
  };
  addEventListener('pointerdown', stopOnPointer, { once: true, capture: true });
  const done = () => removeEventListener('pointerdown', stopOnPointer, true);
  const check = () => {
    if (gen !== keepGen) return done();
    const a = document.activeElement;
    // (behind an open sheet or confirm the page is inert: no target is usable)
    if (!a || a === document.body) {
      const t = pick();
      if (t && usable(t)) focusEl(t); // and keep watching: the target may go next
    }
    if (performance.now() < until) setTimeout(check, 120);
    else done();
  };
  requestAnimationFrame(check);
}

/** Enter/Space on a native control nested in a role=button/link host: the
 * control's own activation only (B-03). Space on the host itself: no page
 * scroll under it. @param {KeyboardEvent} e */
function nestedKey(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.matches('button, a[href], input, select, textarea, summary')) {
    const host = /** @type {HTMLElement | null} */ (t.parentElement?.closest('[role="button"], [role="link"]') || null);
    if (host) {
      t.addEventListener('keydown', stopHere, { once: true });
      keepFocus(() => host);
    }
  } else if (e.key === ' ' && t.matches('[role="button"], [role="link"]')) e.preventDefault();
}

/** @param {KeyboardEvent} e */
function onKey(e) {
  if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') keyAt = performance.now();
  if (cur && !cur.closing) menuKey(e);
  else nestedKey(e);
}

let started = false;
export function initCtxMenu() {
  if (started) return;
  started = true;
  initMore();
  addEventListener('keydown', onKey, true);
  const app = document.getElementById('app') || document.body;
  new MutationObserver((recs) => {
    for (const r of recs) {
      for (const n of r.removedNodes) if (n instanceof HTMLElement && n.classList.contains('ctx')) unmounted(n);
      for (const n of r.addedNodes) if (n instanceof HTMLElement && n.classList.contains('ctx')) mounted(n);
    }
  }).observe(app, { childList: true });
}
