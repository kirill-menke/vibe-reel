/* App tooltips (the player keeps its own data-tip bubbles) and the scroll hint
 * the hover looks read.
 *
 * Full titles for cut-off tiles. A tile's caption is one line that ends in an
 * ellipsis ("The Lord of the Rings: Th…", "Chainsaw Man - The Movi…"); the
 * phone has nowhere to show the rest, a mouse has the browser's tooltip. When
 * the pointer enters a tile whose title (or sub) is actually clipped, the tile
 * gets a `title` with the whole caption; one that fits gets none, so a short
 * title never shows a redundant tooltip. Measured on entry only (two layout
 * reads, already clean by then), never on scroll. The quick-add "+" gets its
 * label as a tooltip too ("Add Dune to library", "Adding Dune") — a bare "+"
 * on a poster doesn't say what it does.
 *
 * Icon-only buttons (back, bell, avatar, rail and hero paddles, close) say
 * what they do the same way: their aria-label becomes the native tooltip,
 * refreshed on every entry (the bell's count changes). A `title` the markup
 * set itself is left alone, so nothing shows two tooltips.
 *
 * While a scroller moves (a wheel through a grid), tiles slide under a still
 * pointer and each one it crosses was a pointerover — two layout reads in a
 * frame the scroll had just dirtied, and a hover lift starting on every
 * poster. So: `html.wscrolling` from the first scroll event until 150 ms
 * after the last (look.css drops the hover lift under it), no measuring
 * meanwhile, and the tile the pointer rests on when it stops is measured
 * then. */

/** the icon-only buttons whose aria-label is their tooltip (outside the player) */
export const ICON_BUTTONS = '.iconbtn, .avatarbtn, .closebtn, .wrail__btn, .whero__btn, .wrail__edge, .tile__add';
const SCROLL_IDLE_MS = 150;

/** @param {Element | null} el */
const clipped = (el) => !!el && el.scrollWidth > el.clientWidth + 1;

let scrolling = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let idle;
/** @type {HTMLElement | null} the tile entered while scrolling, measured once it stops */
let pending = null;

/** @param {HTMLElement} tile */
function measureTile(tile) {
  const title = tile.querySelector('.tile__title');
  const sub = tile.querySelector('.tile__sub');
  if (clipped(title) || clipped(sub)) {
    const text = [title?.textContent?.trim(), sub?.textContent?.trim()].filter(Boolean).join(' · ');
    if (tile.title !== text) tile.title = text;
  } else if (tile.title) tile.removeAttribute('title');
}

/** @param {HTMLElement} btn */
function labelTip(btn) {
  if (btn.closest('.wplayer')) return; // the player's buttons have their data-tip bubbles
  const own = btn.hasAttribute('title') && btn.dataset.wtip === undefined;
  if (own) return;
  const label = btn.getAttribute('aria-label')?.trim() || '';
  if (!label) {
    if (btn.dataset.wtip !== undefined) { btn.removeAttribute('title'); delete btn.dataset.wtip; }
    return;
  }
  if (btn.title !== label) btn.title = label;
  btn.dataset.wtip = '';
}

/** @param {PointerEvent} e */
export function onOver(e) {
  if (e.pointerType && e.pointerType !== 'mouse') return;
  const t = e.target instanceof Element ? e.target : null;
  const btn = /** @type {HTMLElement | null | undefined} */ (t?.closest(ICON_BUTTONS));
  if (btn) labelTip(btn);
  const tile = /** @type {HTMLElement | null | undefined} */ (t?.closest('.tile'));
  if (!tile || tile.contains(/** @type {Node | null} */ (e.relatedTarget))) return;
  if (scrolling) { pending = tile; return; }
  measureTile(tile);
}

export function onScroll() {
  if (!scrolling) {
    scrolling = true;
    document.documentElement.classList.add('wscrolling');
  }
  clearTimeout(idle);
  idle = setTimeout(scrollEnded, SCROLL_IDLE_MS);
}

function scrollEnded() {
  scrolling = false;
  document.documentElement.classList.remove('wscrolling');
  const tile = pending;
  pending = null;
  if (tile?.isConnected && tile.matches(':hover')) measureTile(tile);
}

export function initTileTips() {
  document.addEventListener('pointerover', onOver, { passive: true });
  // scroll doesn't bubble: a capturing listener on the document hears every scroller
  document.addEventListener('scroll', onScroll, { passive: true, capture: true });
}
