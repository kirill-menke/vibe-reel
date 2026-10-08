/* web/src/lib/ctxmenu.js, ctxmore.js and the web longpress wrapper
 * (gestures.js): desktop context menus — placement, keys, modality, focus
 * return, the ⋯ buttons, tile semantics, nested-button keys (lane ctx). */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { placeMenu, moveIndex, typeahead, initCtxMenu, noteOpen, ctxOpen } from '../../web/src/lib/ctxmenu.js';
import { moreFor, describeTile, titleOf, HINT_ID } from '../../web/src/lib/ctxmore.js';
import { longpress } from '../../web/src/lib/gestures.js';
import { MODAL } from '../../web/src/lib/modal.svelte.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const frames = (n = 3) => new Promise((r) => setTimeout(r, 40 * n));

describe('placeMenu', () => {
  const VW = 1440;
  const VH = 900;
  const pt = (x, y) => ({ left: x, top: y, right: x, bottom: y });

  it('puts the menu at the pointer, growing from its top-left', () => {
    expect(placeMenu(pt(100, 200), 312, 120, VW, VH)).toEqual({ x: 100, y: 200, ox: 'left', oy: 'top' });
  });

  it('flips left at the right edge and up at the bottom edge', () => {
    expect(placeMenu(pt(1400, 850), 312, 120, VW, VH)).toEqual({ x: 1088, y: 730, ox: 'right', oy: 'bottom' });
  });

  it('hangs under a button, right-aligned to it when the left alignment runs out', () => {
    const btn = { left: 1380, top: 10, right: 1412, bottom: 42 };
    expect(placeMenu(btn, 312, 80, VW, VH)).toEqual({ x: 1100, y: 42, ox: 'right', oy: 'top' });
  });

  it('never leaves the viewport (720×450, a pointer at the bottom-left corner)', () => {
    const p = placeMenu(pt(2, 448), 312, 160, 720, 450);
    expect(p.x).toBeGreaterThanOrEqual(8);
    expect(p.y).toBeGreaterThanOrEqual(8);
    expect(p.x + 312).toBeLessThanOrEqual(712);
    expect(p.y + 160).toBeLessThanOrEqual(442);
  });

  it('takes the roomier side when it fits neither, clamped to the margin', () => {
    const p = placeMenu({ left: 10, top: 300, right: 40, bottom: 340 }, 300, 400, 720, 450);
    expect(p).toEqual({ x: 10, y: 8, ox: 'left', oy: 'bottom' });
  });
});

describe('moveIndex / typeahead', () => {
  it('wraps ↑/↓ and jumps Home/End', () => {
    expect(moveIndex('ArrowDown', -1, 4)).toBe(0);
    expect(moveIndex('ArrowDown', 3, 4)).toBe(0);
    expect(moveIndex('ArrowUp', 0, 4)).toBe(3);
    expect(moveIndex('ArrowUp', -1, 4)).toBe(3);
    expect(moveIndex('Home', 2, 4)).toBe(0);
    expect(moveIndex('End', 0, 4)).toBe(3);
    expect(moveIndex('x', 0, 4)).toBe(null);
    expect(moveIndex('ArrowDown', 0, 0)).toBe(null);
  });

  it('finds the next item by its first letter, wrapping', () => {
    const l = ['Play', 'Go to show', 'Mark as watched', 'Mark season'];
    expect(typeahead(l, 0, 'm')).toBe(2);
    expect(typeahead(l, 2, 'M')).toBe(3);
    expect(typeahead(l, 3, 'm')).toBe(2);
    expect(typeahead(l, 0, 'z')).toBe(null);
  });
});

/* --------------------------------------------------------------- DOM */
let app;
beforeAll(() => {
  app = document.createElement('div');
  app.id = 'app';
  document.body.append(app);
  initCtxMenu();
});
beforeEach(() => {
  MODAL.holds.splice(0);
  app.replaceChildren();
});
afterEach(() => vi.restoreAllMocks());

function wapp() {
  const w = document.createElement('div');
  w.className = 'wapp';
  app.append(w);
  return w;
}

function tile(parent, { title = 'Dune', sub = '2021', cls = '', role = 'button', label = '' } = {}) {
  const t = document.createElement('div');
  t.className = 'tile ' + cls;
  t.setAttribute('role', role);
  t.tabIndex = 0;
  t.setAttribute('aria-label', label || title);
  t.innerHTML = `<div class="tile__frame"><span class="tile__corner tick" aria-label="Watched"></span></div><p class="tile__title">${title}</p>${sub ? `<p class="tile__sub">${sub}</p>` : ''}`;
  parent.append(t);
  return t;
}

/** a `.ctx` as ContextMenu renders it (portalled into #app); a click on the backdrop removes it */
function menu(labels = ['Open', 'Mark as watched', 'Remove']) {
  const c = document.createElement('div');
  c.className = 'ctx';
  c.setAttribute('role', 'dialog');
  c.setAttribute('aria-modal', 'true');
  c.setAttribute('aria-label', 'Dune');
  c.innerHTML = `<div class="ctx__backdrop"></div><div class="ctx__stack"><div class="ctx__preview"><div class="tile" role="button" tabindex="0"></div></div><div class="ctx__menu" role="menu">${labels
    .map((l) => `<button type="button" class="ctx__item" role="menuitem">${l}</button>`)
    .join('')}</div></div>`;
  c.querySelector('.ctx__backdrop').addEventListener('click', () => c.remove());
  for (const b of c.querySelectorAll('.ctx__item')) b.addEventListener('click', () => c.remove());
  app.append(c);
  return c;
}

const key = (k, opts = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts });
  (document.activeElement || document.body).dispatchEvent(e);
  return e;
};

describe('the menu layer', () => {
  it('focuses the first item, holds ctx, moves the name to the menu and hides the preview', async () => {
    const t = tile(wapp());
    t.focus();
    noteOpen({ source: t, returnTo: t, via: 'key' });
    const c = menu();
    await tick();
    expect(document.activeElement?.textContent).toBe('Open');
    expect(MODAL.holds).toEqual(['ctx']);
    expect(ctxOpen()).toBe(true);
    expect(c.getAttribute('role')).toBe('none');
    expect(c.hasAttribute('aria-modal')).toBe(false);
    expect(c.querySelector('.ctx__menu').getAttribute('aria-label')).toBe('Dune');
    expect(c.querySelector('.ctx__preview').hasAttribute('inert')).toBe(true);
    expect(c.style.getPropertyValue('--wctx-x')).toMatch(/px$/);
    c.remove();
    await tick();
  });

  it('↑/↓/End/letters move inside the menu and never reach the page', async () => {
    const t = tile(wapp());
    noteOpen({ source: t, via: 'key' });
    menu(['Open', 'Mark as watched', 'Remove']);
    await tick();
    const page = vi.fn();
    window.addEventListener('keydown', page);
    key('ArrowDown');
    expect(document.activeElement?.textContent).toBe('Mark as watched');
    key('End');
    expect(document.activeElement?.textContent).toBe('Remove');
    key('ArrowDown');
    expect(document.activeElement?.textContent).toBe('Open');
    key('m');
    expect(document.activeElement?.textContent).toBe('Mark as watched');
    expect(page).not.toHaveBeenCalled();
    window.removeEventListener('keydown', page);
    key('Escape');
    await tick();
  });

  it('Esc closes and gives focus back to the source; the hold is released', async () => {
    const t = tile(wapp());
    t.focus();
    noteOpen({ source: t, returnTo: t, via: 'key' });
    const c = menu();
    await tick();
    const e = key('Escape');
    expect(e.defaultPrevented).toBe(true);
    expect(c.isConnected).toBe(false); // closed through the backdrop, as a click outside
    expect(document.activeElement).toBe(t);
    await tick();
    expect(MODAL.holds).toEqual([]);
    expect(ctxOpen()).toBe(false);
  });

  it('Tab closes it too (WAI-ARIA menu), focus on the source', async () => {
    const t = tile(wapp());
    noteOpen({ source: t, via: 'pointer', x: 10, y: 10 });
    const c = menu();
    await tick();
    key('Tab');
    expect(c.isConnected).toBe(false);
    expect(document.activeElement).toBe(t);
  });

  it('an item that removes its source hands focus to the neighbour', async () => {
    const w = wapp();
    const track = document.createElement('div');
    track.className = 'rail__track';
    w.append(track);
    const a = tile(track, { title: 'A' });
    const b = tile(track, { title: 'B' });
    a.focus();
    noteOpen({ source: a, returnTo: a, via: 'key' });
    const c = menu(['Remove']);
    await tick();
    const item = /** @type {HTMLElement} */ (c.querySelector('.ctx__item'));
    item.addEventListener('click', () => a.remove()); // the action, after the menu went
    item.click();
    await frames();
    expect(document.activeElement).toBe(b);
  });

  it('the ⋯ says its menu is open (aria-expanded) and the right-click on the backdrop gets no browser menu', async () => {
    const t = tile(wapp());
    const btn = document.createElement('button');
    btn.className = 'ctxmore';
    btn.setAttribute('aria-expanded', 'false');
    t.querySelector('.tile__frame').append(btn);
    noteOpen({ source: t, anchor: btn, via: 'button' });
    const c = menu();
    await tick();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    c.querySelector('.ctx__backdrop').dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await tick();
    expect(c.isConnected).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('nested buttons (B-03)', () => {
  it('Enter/Space on a button inside a role=button host stay with the button', () => {
    const host = document.createElement('div');
    host.setAttribute('role', 'button');
    host.tabIndex = 0;
    const get = document.createElement('button');
    get.textContent = 'Get';
    host.append(get);
    app.append(host);
    const row = vi.fn();
    host.addEventListener('keydown', row);
    const own = vi.fn();
    get.addEventListener('keydown', own);
    get.focus();
    key('Enter');
    key(' ');
    expect(own).toHaveBeenCalledTimes(2);
    expect(row).not.toHaveBeenCalled();
    host.focus();
    const e = key(' ');
    expect(row).toHaveBeenCalledTimes(1); // the host's own keys still work
    expect(e.defaultPrevented).toBe(true); // and Space doesn't scroll the page
  });
});

describe('ctxmore', () => {
  it('a tile with a menu gets a ⋯ (not a Tab stop), the shortcut and its description', () => {
    const t = tile(wapp(), { title: 'Dune', sub: '2021' });
    let on = true;
    const open = vi.fn();
    const m = moreFor(t, () => on, open);
    const b = /** @type {HTMLButtonElement} */ (t.querySelector('.tile__frame > .ctxmore'));
    expect(b).toBeTruthy();
    expect(b.tabIndex).toBe(-1);
    expect(b.getAttribute('aria-label')).toBe('More actions for Dune');
    expect(b.getAttribute('aria-haspopup')).toBe('menu');
    expect(t.getAttribute('aria-keyshortcuts')).toBe('Shift+F10 ContextMenu');
    expect(t.getAttribute('role')).toBe('link');
    const ids = (t.getAttribute('aria-describedby') || '').split(' ');
    expect(ids.map((i) => document.getElementById(i)?.textContent || document.getElementById(i)?.getAttribute('aria-label'))).toEqual([
      '2021',
      'Watched',
      'More actions: Shift+F10'
    ]);
    expect(ids).toContain(HINT_ID);
    b.click();
    expect(open).toHaveBeenCalledWith(b);
    on = false;
    m.update();
    expect(t.querySelector('.ctxmore')).toBe(null);
    expect(t.hasAttribute('aria-keyshortcuts')).toBe(false);
    m.destroy();
  });

  it('Continue Watching tiles stay buttons ("Play X"), the ⋯ names the title', () => {
    const cell = document.createElement('div');
    cell.dataset.cell = 'cw-1';
    wapp().append(cell);
    const t = tile(cell, { title: 'Severance', label: 'Play Severance', sub: 'S1 · E2 · 20m left' });
    moreFor(t, () => true, () => {});
    expect(t.getAttribute('role')).toBe('button');
    expect(titleOf(t)).toBe('Severance');
    describeTile(t);
    expect(document.getElementById((t.getAttribute('aria-describedby') || '').split(' ')[0])?.textContent).toBe('S1 · E2 · 20m left');
  });

  it('an episode row gets a trailing ⋯ that is a Tab stop', () => {
    const r = document.createElement('div');
    r.className = 'episode episode--downloading';
    r.innerHTML = '<div class="episode__head"><p class="episode__title">Pilot</p></div>';
    wapp().append(r);
    moreFor(r, () => true, () => {});
    const b = /** @type {HTMLButtonElement} */ (r.querySelector(':scope > .ctxmore'));
    expect(b.tabIndex).toBe(0);
    expect(b.getAttribute('aria-label')).toBe('More actions for Pilot');
  });

  it('season pills share one ⋯ for the selected season, following the selection', async () => {
    const bar = document.createElement('div');
    bar.className = 'detail__pills';
    bar.innerHTML = '<div class="pills" role="tablist"><button class="pill" role="tab" aria-selected="true">Season 1<span class="pill__pct">40%</span></button><button class="pill" role="tab" aria-selected="false">Season 2</button></div>';
    wapp().append(bar);
    const [p1, p2] = /** @type {HTMLElement[]} */ ([...bar.querySelectorAll('.pill')]);
    const o1 = vi.fn();
    const o2 = vi.fn();
    moreFor(p1, () => true, o1);
    moreFor(p2, () => true, o2);
    const b = /** @type {HTMLButtonElement} */ (bar.querySelector(':scope > .ctxmore'));
    expect(b.getAttribute('aria-label')).toBe('More actions for Season 1');
    p1.setAttribute('aria-selected', 'false');
    p2.setAttribute('aria-selected', 'true');
    await tick();
    expect(b.getAttribute('aria-label')).toBe('More actions for Season 2');
    b.click();
    expect(o2).toHaveBeenCalledTimes(1);
    expect(o1).not.toHaveBeenCalled();
  });
});

describe('the web longpress wrapper', () => {
  it('a right-click notes the pointer and hands the menu a fresh rect; the ⋯ opens it too', async () => {
    const t = tile(wapp());
    const got = [];
    const act = longpress(t, { onlongpress: (d) => got.push(d) });
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 });
    t.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ x: 40, y: 50, node: t });
    const c = menu();
    await tick();
    expect(c.style.getPropertyValue('--wctx-x')).toBe('40px'); // at the pointer (happy-dom lays out 0×0)
    c.remove();
    await tick();
    const more = /** @type {HTMLButtonElement} */ (t.querySelector('.ctxmore'));
    more.click();
    expect(got).toHaveLength(2);
    act.update({ disabled: true, onlongpress: null });
    expect(t.querySelector('.ctxmore')).toBe(null);
    const ev2 = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    t.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(true); // the phone's own handler still blocks the browser menu
    expect(got).toHaveLength(2);
    act.destroy();
  });
});
