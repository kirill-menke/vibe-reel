/* Full titles for cut-off tiles. A tile's caption is one line that ends in an
 * ellipsis ("The Lord of the Rings: Th…", "Chainsaw Man - The Movi…"); the
 * phone has nowhere to show the rest, a mouse has the browser's tooltip. When
 * the pointer enters a tile whose title (or sub) is actually clipped, the tile
 * gets a `title` with the whole caption; one that fits gets none, so a short
 * title never shows a redundant tooltip. Measured on entry only (two layout
 * reads, already clean by then), never on scroll. The quick-add "+" gets its
 * label as a tooltip too ("Add Dune to library", "Adding Dune") — a bare "+"
 * on a poster doesn't say what it does. */

/** @param {Element | null} el */
const clipped = (el) => !!el && el.scrollWidth > el.clientWidth + 1;

/** @param {PointerEvent} e */
function onOver(e) {
  if (e.pointerType && e.pointerType !== 'mouse') return;
  const t = e.target instanceof Element ? e.target : null;
  // the quick-add "+" says what it does ("Add Dune to library")
  const add = /** @type {HTMLElement | null | undefined} */ (t?.closest('.tile__add'));
  if (add) add.title = add.getAttribute('aria-label') || '';
  const tile = /** @type {HTMLElement | null | undefined} */ (t?.closest('.tile'));
  if (!tile || tile.contains(/** @type {Node | null} */ (e.relatedTarget))) return;
  const title = tile.querySelector('.tile__title');
  const sub = tile.querySelector('.tile__sub');
  if (clipped(title) || clipped(sub)) {
    const text = [title?.textContent?.trim(), sub?.textContent?.trim()].filter(Boolean).join(' · ');
    if (tile.title !== text) tile.title = text;
  } else if (tile.title) tile.removeAttribute('title');
}

export function initTileTips() {
  document.addEventListener('pointerover', onOver, { passive: true });
}
