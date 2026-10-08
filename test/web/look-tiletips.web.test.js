/* web/src/lib/tiletips.js: tooltips for cut-off tile captions and icon-only
 * buttons, and the scroll hint (html.wscrolling) that pauses both. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { onOver, onScroll, ICON_BUTTONS } from '../../web/src/lib/tiletips.js';

/** @param {Element} target @param {Partial<PointerEventInit> & { relatedTarget?: Node | null }} [o] */
const over = (target, o = {}) => onOver(/** @type {PointerEvent} */ (/** @type {unknown} */ ({ pointerType: 'mouse', target, relatedTarget: null, ...o })));

/** @param {HTMLElement} el @param {number} scroll @param {number} client */
function widths(el, scroll, client) {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, get: () => scroll });
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => client });
}

/** @param {string} title @param {string} sub */
function tile(title, sub) {
  const t = document.createElement('div');
  t.className = 'tile';
  t.innerHTML = `<div class="tile__frame"></div><span class="tile__title">${title}</span><span class="tile__sub">${sub}</span>`;
  document.body.append(t);
  return t;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.className = '';
});
afterEach(() => vi.useRealTimers());

describe('icon-only buttons', () => {
  it('show their aria-label as the tooltip, refreshed on every entry', () => {
    document.body.innerHTML = '<button class="iconbtn" aria-label="Notifications, 2 new"><svg></svg></button>';
    const b = /** @type {HTMLElement} */ (document.querySelector('button'));
    over(/** @type {Element} */ (b.querySelector('svg')));
    expect(b.title).toBe('Notifications, 2 new');
    b.setAttribute('aria-label', 'Notifications');
    over(b);
    expect(b.title).toBe('Notifications');
  });

  it('cover the paddles, the avatar, the quick-add and the ⋯', () => {
    for (const cls of ['wrail__btn', 'whero__btn', 'wrail__edge', 'avatarbtn', 'closebtn', 'tile__add', 'ctxmore']) expect(ICON_BUTTONS).toContain('.' + cls);
  });

  it('leave a title the markup set alone (no second tooltip)', () => {
    document.body.innerHTML = '<button class="iconbtn" aria-label="Back" title="Back to Movies"></button>';
    const b = /** @type {HTMLElement} */ (document.querySelector('button'));
    over(b);
    expect(b.title).toBe('Back to Movies');
  });

  it('skip the player, whose buttons have their own data-tip bubbles', () => {
    document.body.innerHTML = '<div class="wplayer"><button class="iconbtn" aria-label="Close player" data-tip="Close (Esc)"></button></div>';
    const b = /** @type {HTMLElement} */ (document.querySelector('button'));
    over(b);
    expect(b.hasAttribute('title')).toBe(false);
  });

  it('drop their tooltip once the label is gone', () => {
    document.body.innerHTML = '<button class="wrail__edge" aria-label="Scroll right"></button>';
    const b = /** @type {HTMLElement} */ (document.querySelector('button'));
    over(b);
    expect(b.title).toBe('Scroll right');
    b.setAttribute('aria-label', '');
    over(b);
    expect(b.hasAttribute('title')).toBe(false);
  });

  it('ignore touch and pen', () => {
    document.body.innerHTML = '<button class="iconbtn" aria-label="Back"></button>';
    const b = /** @type {HTMLElement} */ (document.querySelector('button'));
    over(b, { pointerType: 'touch' });
    expect(b.hasAttribute('title')).toBe(false);
  });
});

describe('cut-off tile captions', () => {
  it('get the whole caption as a tooltip, a caption that fits none', () => {
    const t = tile('The Lord of the Rings: The Two Towers', '2002');
    widths(/** @type {HTMLElement} */ (t.querySelector('.tile__title')), 300, 140);
    over(t);
    expect(t.title).toBe('The Lord of the Rings: The Two Towers · 2002');
    widths(/** @type {HTMLElement} */ (t.querySelector('.tile__title')), 140, 140);
    over(t);
    expect(t.hasAttribute('title')).toBe(false);
  });

  it('count a two-line clamp cut on its second line as clipped', () => {
    const t = tile('The Lord of the Rings: The Return of the King', '2003');
    const title = /** @type {HTMLElement} */ (t.querySelector('.tile__title'));
    widths(title, 140, 140); // wraps instead of overflowing sideways
    Object.defineProperty(title, 'scrollHeight', { configurable: true, get: () => 54 });
    Object.defineProperty(title, 'clientHeight', { configurable: true, get: () => 36 });
    over(t);
    expect(t.title).toBe('The Lord of the Rings: The Return of the King · 2003');
  });

  it('are not re-measured for a move inside the tile', () => {
    const t = tile('Long title', '2002');
    const title = /** @type {HTMLElement} */ (t.querySelector('.tile__title'));
    let reads = 0;
    Object.defineProperty(title, 'scrollWidth', { configurable: true, get: () => (reads++, 10) });
    over(title, { relatedTarget: t.querySelector('.tile__frame') });
    expect(reads).toBe(0);
  });
});

describe('while a scroller moves', () => {
  it('marks the document from the first scroll event until 150 ms after the last', () => {
    vi.useFakeTimers();
    onScroll();
    expect(document.documentElement.classList.contains('wscrolling')).toBe(true);
    vi.advanceTimersByTime(100);
    onScroll();
    vi.advanceTimersByTime(100);
    expect(document.documentElement.classList.contains('wscrolling')).toBe(true);
    vi.advanceTimersByTime(60);
    expect(document.documentElement.classList.contains('wscrolling')).toBe(false);
  });

  it('measures no tile it slides under the pointer, then the one the pointer rests on', () => {
    vi.useFakeTimers();
    const a = tile('Passing by', '2001');
    const b = tile('Resting on this long title', '2003');
    for (const t of [a, b]) widths(/** @type {HTMLElement} */ (t.querySelector('.tile__title')), 300, 100);
    const hovered = b.matches.bind(b);
    b.matches = (/** @type {string} */ s) => s === ':hover' || hovered(s);
    onScroll();
    over(a);
    over(b);
    expect(a.hasAttribute('title')).toBe(false);
    expect(b.hasAttribute('title')).toBe(false);
    vi.advanceTimersByTime(200);
    expect(a.hasAttribute('title')).toBe(false);
    expect(b.title).toBe('Resting on this long title · 2003');
  });

  it('still labels icon buttons (no layout read)', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<button class="wrail__btn" aria-label="Scroll right"></button>';
    onScroll();
    const btn = /** @type {HTMLElement} */ (document.querySelector('button'));
    over(btn);
    expect(btn.title).toBe('Scroll right');
    vi.advanceTimersByTime(200);
  });
});
