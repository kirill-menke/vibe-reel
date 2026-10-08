/* The visible way into a context menu, and what a tile says to a screen
 * reader. Both are DOM work on the nodes the web `longpress` wrapper
 * (gestures.js) already runs for — every Tile, EpisodeRow and season pill —
 * because the shared phone markup can't grow elements or attributes without
 * moving the phone bundle.
 *
 * ⋯ ("More actions for <title>", aria-haspopup=menu, aria-expanded while its
 * menu is up), only where the node has a menu:
 *   - tile: a round glass button at the art's top-right, shown on hover and
 *     :focus-within; tabindex -1, so a rail or grid gets no second Tab stop
 *     per tile — the keyboard has Shift+F10 / the Menu key on the tile itself,
 *     which says so (aria-keyshortcuts + its description).
 *   - episode row: a permanent trailing button, a Tab stop of its own — the
 *     only keyboard way into a pending (not playable, not focusable) row's
 *     "Cancel download…".
 *   - season pills: one button after the pills, for the selected season
 *     ("More actions for Season 2"), hidden when that season has no menu.
 *
 * Tile semantics (C-06), on every tile:
 *   - a tile that opens a page is a link (role=link); Continue Watching / Next
 *     Up tiles, which play, stay buttons. A link may hold the quick-add "+"
 *     (a button's children are presentational: Chart exposed 493 "buttons" for
 *     250 titles, the "+" not reachable as its own control).
 *   - aria-describedby: what the name (aria-label = the title, or "Play X")
 *     leaves out — the sub line (year, "S2 · E1 · 55m left", "43% · 1 h left"),
 *     badges, Watched — plus the Shift+F10 hint where there is a menu.
 *     Refreshed when the tile is focused or hovered (Svelte re-creates a sub
 *     line that comes and goes). */

const DOTS = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 12h.01M12 12h.01M18.5 12h.01" stroke-width="3"></path></svg>';
export const HINT_ID = 'wctx-hint';
export const SHORTCUTS = 'Shift+F10 ContextMenu';

/** @typedef {(btn: HTMLElement) => void} Opener */
/** node → how to open its menu from a ⋯, and whether it has one now */
/** @type {WeakMap<HTMLElement, { open: Opener, on: () => boolean }>} */
const reg = new WeakMap();
let seq = 0;

/** @param {HTMLElement} node @returns {'tile' | 'episode' | 'pill' | null} */
export function kindOf(node) {
  const c = node.classList;
  return c.contains('tile') ? 'tile' : c.contains('episode') ? 'episode' : c.contains('pill') ? 'pill' : null;
}

const text = (/** @type {Element | null | undefined} */ el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

/** The name a ⋯ says it acts on. @param {HTMLElement} node */
export function titleOf(node) {
  const k = kindOf(node);
  if (k === 'tile') return text(node.querySelector('.tile__title')) || (node.getAttribute('aria-label') || '').replace(/^Play /, '');
  if (k === 'episode') return text(node.querySelector('.episode__title'));
  if (k === 'pill') {
    const c = /** @type {HTMLElement} */ (node.cloneNode(true));
    c.querySelector('.pill__pct')?.remove();
    return text(c);
  }
  return text(node);
}

/** @param {HTMLElement} el */
const idOf = (el) => el.id || (el.id = 'wct' + ++seq);

function hint() {
  if (document.getElementById(HINT_ID)) return;
  const h = document.createElement('span');
  h.id = HINT_ID;
  h.hidden = true;
  h.textContent = 'More actions: Shift+F10';
  document.body.append(h);
}

/** Role + description of a tile (see the header). @param {HTMLElement} node */
export function describeTile(node) {
  if (kindOf(node) !== 'tile' || node.closest('.ctx')) return;
  if (node.getAttribute('role') === 'button' && !node.closest('[data-cell^="cw-"], [data-cell^="nextup-"]')) node.setAttribute('role', 'link');
  const ids = [];
  // the caption's sub line first, then what the art says
  for (const sel of ['.tile__sub', '.tile__badge', '.tile__rank', '.tile__queued', '.tile__corner']) {
    for (const el of /** @type {NodeListOf<HTMLElement>} */ (node.querySelectorAll(sel))) {
      if (el.classList.contains('tick') && !el.getAttribute('role')) el.setAttribute('role', 'img'); // "Watched"
      if (text(el) || el.getAttribute('aria-label')) ids.push(idOf(el));
    }
  }
  if (reg.get(node)?.on()) {
    hint();
    ids.push(HINT_ID);
  }
  const v = ids.join(' ');
  if (v) node.setAttribute('aria-describedby', v);
  else node.removeAttribute('aria-describedby');
}

/** @param {'tile' | 'episode' | 'season'} kind @param {boolean} tabbable */
function makeButton(kind, tabbable) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ctxmore ctxmore--' + kind;
  b.tabIndex = tabbable ? 0 : -1;
  b.setAttribute('aria-haspopup', 'menu');
  b.setAttribute('aria-expanded', 'false');
  b.innerHTML = DOTS;
  // not a press on the tile/row under it: no hold, no row/tile click
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  if (!tabbable) b.addEventListener('mousedown', (e) => e.preventDefault()); // focus stays where it was
  return b;
}

/* -------------------------------------------------------------- season ⋯ */
/** @param {Element} bar `.detail__pills` */
function syncBar(bar) {
  const active = /** @type {HTMLElement | null} */ (bar.querySelector('.pill[aria-selected="true"]'));
  const r = active ? reg.get(active) : null;
  let b = /** @type {HTMLElement | null} */ (bar.querySelector(':scope > .ctxmore'));
  if (!active || !r || !r.on()) {
    b?.remove();
    return;
  }
  if (!b) {
    b = makeButton('season', true);
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const a = /** @type {HTMLElement | null} */ (bar.querySelector('.pill[aria-selected="true"]'));
      const rr = a && reg.get(a);
      if (rr && rr.on()) rr.open(/** @type {HTMLElement} */ (e.currentTarget));
    });
    bar.append(b);
  }
  b.setAttribute('aria-label', 'More actions for ' + titleOf(active));
}

/** @type {WeakSet<Element>} */
const watched = new WeakSet();
/** @param {HTMLElement} pill */
function barOf(pill) {
  const bar = pill.closest('.detail__pills');
  if (bar && !watched.has(bar)) {
    watched.add(bar);
    // a new selection (aria-selected) moves the season ⋯ to it
    new MutationObserver(() => syncBar(bar)).observe(bar, { subtree: true, attributes: true, attributeFilter: ['aria-selected'] });
  }
  return bar;
}

/** Give a longpress node its ⋯ (see the header). `on()`: it has a menu now;
 * `open(btn)`: open it from that button.
 * @param {HTMLElement} node @param {() => boolean} on @param {Opener} open */
export function moreFor(node, on, open) {
  const kind = kindOf(node);
  if (!kind || node.closest('.ctx, .episode--preview')) return { update() {}, destroy() {} };
  reg.set(node, { open, on });
  /** @type {HTMLElement | null} */
  let btn = null;
  function sync() {
    const has = on();
    if (has) node.setAttribute('aria-keyshortcuts', SHORTCUTS);
    else node.removeAttribute('aria-keyshortcuts');
    if (kind === 'pill') {
      const bar = barOf(node);
      if (bar) syncBar(bar);
      return;
    }
    if (has && !btn) {
      const b = (btn = makeButton(kind === 'tile' ? 'tile' : 'episode', kind === 'episode'));
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (on()) open(b);
      });
      (kind === 'tile' ? node.querySelector('.tile__frame') || node : node).append(b);
    } else if (!has && btn) {
      btn.remove();
      btn = null;
    }
    if (btn) btn.setAttribute('aria-label', 'More actions for ' + titleOf(node));
    if (kind === 'tile') describeTile(node);
  }
  sync();
  return {
    update: sync,
    destroy() {
      reg.delete(node);
      btn?.remove();
      btn = null;
      if (kind === 'pill') {
        const bar = node.closest('.detail__pills');
        if (bar) queueMicrotask(() => syncBar(bar));
      }
    }
  };
}

/** a tile's description and its ⋯'s name, again (focus / hover) @param {Event} e */
function refresh(e) {
  const t = e.target instanceof Element ? /** @type {HTMLElement | null} */ (e.target.closest('.tile')) : null;
  if (!t || t.contains(/** @type {Node | null} */ (/** @type {FocusEvent} */ (e).relatedTarget))) return;
  describeTile(t);
  const b = t.querySelector('.ctxmore');
  if (b) b.setAttribute('aria-label', 'More actions for ' + titleOf(t));
}

let started = false;
export function initMore() {
  if (started) return;
  started = true;
  document.addEventListener('focusin', refresh);
  document.addEventListener('pointerover', refresh, { passive: true });
}
