/* Arrow keys in the poster grids (Library, Search results, charts, a
 * person's filmography): on the phone a grid is for thumbs, and on the desktop
 * ← → ↑ ↓ on a tile did nothing (↓ only nudged the page 40 px). Every tile
 * stays a Tab stop — this adds the 2-D moves on top, the WAI-ARIA grid keys:
 *
 *   ← →             the neighbour in the row (no wrap to the next row)
 *   ↑ ↓             the tile above / below, by the grid's measured columns;
 *                   ↓ into a shorter last row lands on its last tile; past
 *                   the first / last row, into the grid before / after on the
 *                   same page (a chart's Movies → Shows), else the key is
 *                   left to the page (it scrolls — and the Library slices in
 *                   its next tiles)
 *   Home / End      the first / last tile of the row
 *   Ctrl+Home / End the first / last tile of the grid
 *
 * The tile glides into view clear of the navigation (scroll-margin in
 * browse.css). Rails have their own ← → (web/src/components/Rail.svelte). */

const TILE = '.tile[tabindex]';

/** @param {Element} grid @returns {HTMLElement[]} */
const tilesOf = (grid) => /** @type {HTMLElement[]} */ ([...grid.children].filter((c) => c.matches(TILE)));

/** the number of columns the grid lays out @param {Element} grid */
export function columns(grid) {
  const n = getComputedStyle(grid).gridTemplateColumns.split(' ').filter((s) => s && s !== 'none').length;
  return Math.max(1, n);
}

/** the other poster grids of the same page, in order @param {Element} grid @param {1 | -1} dir */
function nextGrid(grid, dir) {
  const page = grid.closest('.screen');
  if (!page) return null;
  const all = [...page.querySelectorAll('.grid')].filter((g) => tilesOf(g).length);
  return all[all.indexOf(grid) + dir] || null;
}

/** Where a key moves from tile `i` of `n` in a grid of `cols` columns: an
 * index, `null` (handled, nowhere to go) or `undefined` (not ours / leave the
 * grid in `dir`).
 * @param {string} key @param {boolean} ctrl @param {number} i @param {number} n @param {number} cols
 * @returns {number | null | undefined | { leave: 1 | -1, col: number }} */
export function target(key, ctrl, i, n, cols) {
  const col = i % cols;
  const rowStart = i - col;
  switch (key) {
    case 'ArrowLeft':
      return ctrl ? undefined : col > 0 ? i - 1 : null;
    case 'ArrowRight':
      return ctrl ? undefined : col < cols - 1 && i + 1 < n ? i + 1 : null;
    case 'ArrowUp':
      if (ctrl) return undefined;
      return i - cols >= 0 ? i - cols : { leave: -1, col };
    case 'ArrowDown':
      if (ctrl) return undefined;
      if (i + cols < n) return i + cols;
      if (rowStart + cols < n) return n - 1; // a shorter last row below
      return { leave: 1, col };
    case 'Home':
      return ctrl ? 0 : rowStart;
    case 'End':
      return ctrl ? n - 1 : Math.min(n - 1, rowStart + cols - 1);
  }
  return undefined;
}

/** @param {HTMLElement} el */
function go(el) {
  el.focus({ preventScroll: true, focusVisible: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
}

/** @param {KeyboardEvent} e */
function onKey(e) {
  if (e.defaultPrevented || e.altKey || e.metaKey || e.shiftKey) return;
  const tile = e.target instanceof HTMLElement ? e.target : null;
  const grid = tile?.parentElement;
  if (!tile || !grid || !tile.matches(TILE) || !grid.classList.contains('grid')) return;
  const tiles = tilesOf(grid);
  const cols = columns(grid);
  const to = target(e.key, e.ctrlKey, tiles.indexOf(tile), tiles.length, cols);
  if (to === undefined) return;
  if (to === null) return e.preventDefault();
  if (typeof to === 'number') {
    e.preventDefault();
    if (tiles[to] && tiles[to] !== tile) go(tiles[to]);
    return;
  }
  // past the first / last row: the grid before / after on this page
  const other = nextGrid(grid, to.leave);
  if (!other) return; // the page scrolls
  const ot = tilesOf(other);
  const oc = columns(other);
  const lastRow = ot.length - 1 - ((ot.length - 1) % oc);
  const j = to.leave > 0 ? Math.min(to.col, ot.length - 1) : Math.min(lastRow + to.col, ot.length - 1);
  e.preventDefault();
  go(ot[j]);
}

export function initGridKeys() {
  document.addEventListener('keydown', onKey);
}
