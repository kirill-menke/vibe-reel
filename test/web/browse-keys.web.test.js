/* web/src/lib/roving.js + gridkeys.js (lane browse): the WAI-ARIA keys of the
 * composite widgets the phone markup declares (radio groups, tab lists) and
 * 2-D arrows in the poster grids. */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { target, columns } from '../../web/src/lib/gridkeys.js';
import { initRoving, syncGroup, options } from '../../web/src/lib/roving.js';

const key = (el, k, o = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }));
const frame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  initRoving();
});
beforeEach(() => {
  document.body.innerHTML = '';
});

describe('gridkeys target()', () => {
  // 10 tiles in 4 columns: rows 0–3, 4–7, 8–9
  it('← → stay in the row', () => {
    expect(target('ArrowRight', false, 0, 10, 4)).toBe(1);
    expect(target('ArrowRight', false, 3, 10, 4)).toBe(null);
    expect(target('ArrowRight', false, 9, 10, 4)).toBe(null);
    expect(target('ArrowLeft', false, 4, 10, 4)).toBe(null);
    expect(target('ArrowLeft', false, 5, 10, 4)).toBe(4);
  });
  it('↑ ↓ by columns; ↓ into a shorter last row lands on its last tile', () => {
    expect(target('ArrowDown', false, 1, 10, 4)).toBe(5);
    expect(target('ArrowDown', false, 6, 10, 4)).toBe(9);
    expect(target('ArrowDown', false, 9, 10, 4)).toEqual({ leave: 1, col: 1 });
    expect(target('ArrowUp', false, 5, 10, 4)).toBe(1);
    expect(target('ArrowUp', false, 2, 10, 4)).toEqual({ leave: -1, col: 2 });
  });
  it('Home / End: the row; with Ctrl: the grid', () => {
    expect(target('Home', false, 6, 10, 4)).toBe(4);
    expect(target('End', false, 5, 10, 4)).toBe(7);
    expect(target('End', false, 8, 10, 4)).toBe(9);
    expect(target('Home', true, 6, 10, 4)).toBe(0);
    expect(target('End', true, 1, 10, 4)).toBe(9);
  });
  it('leaves other keys and Ctrl+arrows to the browser', () => {
    expect(target('ArrowDown', true, 1, 10, 4)).toBe(undefined);
    expect(target('ArrowLeft', true, 1, 10, 4)).toBe(undefined);
    expect(target('Enter', false, 1, 10, 4)).toBe(undefined);
  });
});

/** a .screen with grids of n tiles in `cols` columns */
function grids(...ns) {
  const page = document.createElement('main');
  page.className = 'screen';
  for (const n of ns) {
    const g = document.createElement('div');
    g.className = 'grid';
    g.style.gridTemplateColumns = '100px 100px 100px';
    for (let i = 0; i < n; i++) {
      const t = document.createElement('div');
      t.className = 'tile';
      t.tabIndex = 0;
      t.id = 'g' + page.children.length + '-' + i;
      g.append(t);
    }
    page.append(g);
  }
  document.body.append(page);
  return page;
}

describe('grid arrows in the DOM', () => {
  it('measures the columns and moves focus', () => {
    const page = grids(7);
    const g = page.querySelector('.grid');
    expect(columns(g)).toBe(3);
    const t = /** @type {HTMLElement} */ (g.children[1]);
    t.focus();
    expect(key(t, 'ArrowDown')).toBe(false); // handled: default prevented
    expect(document.activeElement.id).toBe('g0-4');
    key(document.activeElement, 'ArrowDown');
    expect(document.activeElement.id).toBe('g0-6'); // the shorter last row
    key(document.activeElement, 'ArrowRight');
    expect(document.activeElement.id).toBe('g0-6');
    key(document.activeElement, 'Home', { ctrlKey: true });
    expect(document.activeElement.id).toBe('g0-0');
  });

  it('↓ past the last row enters the next grid on the page; ↑ comes back', () => {
    const page = grids(5, 4);
    const t = /** @type {HTMLElement} */ (page.querySelector('#g0-4'));
    t.focus();
    key(t, 'ArrowDown');
    expect(document.activeElement.id).toBe('g1-1');
    key(document.activeElement, 'ArrowUp');
    expect(document.activeElement.id).toBe('g0-4');
  });

  it('past the last grid the key is the page’s (it scrolls)', () => {
    const page = grids(3);
    const t = /** @type {HTMLElement} */ (page.querySelector('#g0-1'));
    t.focus();
    expect(key(t, 'ArrowDown')).toBe(true);
    expect(key(t, 'ArrowUp')).toBe(true);
    expect(document.activeElement.id).toBe('g0-1');
  });

  it('ignores keys from inside a tile (its quick-add button) and outside grids', () => {
    const page = grids(4);
    const b = document.createElement('button');
    page.querySelector('#g0-0').append(b);
    b.focus();
    expect(key(b, 'ArrowRight')).toBe(true);
    expect(document.activeElement).toBe(b);
  });
});

/** @param {string} role @param {string[]} labels @param {number} sel @param {string} [wrap] */
function group(role, labels, sel, wrap) {
  const g = document.createElement('div');
  g.setAttribute('role', role);
  const item = role === 'tablist' ? 'tab' : 'radio';
  const attr = item === 'tab' ? 'aria-selected' : 'aria-checked';
  const picks = [];
  for (const [i, l] of labels.entries()) {
    const b = document.createElement('button');
    b.textContent = l;
    b.setAttribute('role', item);
    b.setAttribute(attr, String(i === sel));
    b.addEventListener('click', () => {
      picks.push(l);
      for (const o of g.children) o.setAttribute(attr, String(o === b));
    });
    g.append(b);
  }
  let host = g;
  if (wrap) {
    host = document.createElement('div');
    host.innerHTML = wrap;
    host.querySelector('slot').replaceWith(g);
  }
  document.body.append(host);
  return { g, picks, items: /** @type {HTMLElement[]} */ ([...g.children]) };
}

describe('radio groups and tab lists', () => {
  it('one Tab stop: the selected option (else the first)', () => {
    const { g, items } = group('radiogroup', ['a', 'b', 'c'], 1);
    syncGroup(g);
    expect(items.map((i) => i.tabIndex)).toEqual([-1, 0, -1]);
    const none = group('radiogroup', ['x', 'y'], -1);
    syncGroup(none.g);
    expect(none.items.map((i) => i.tabIndex)).toEqual([0, -1]);
  });

  it('radios: every arrow moves and selects, wrapping; Home / End', () => {
    const { g, items, picks } = group('radiogroup', ['a', 'b', 'c'], 0);
    syncGroup(g);
    items[0].focus();
    key(items[0], 'ArrowRight');
    expect(document.activeElement).toBe(items[1]);
    key(items[1], 'ArrowDown');
    key(items[2], 'ArrowDown');
    expect(document.activeElement).toBe(items[0]); // wrapped
    key(items[0], 'ArrowUp');
    key(items[2], 'Home');
    key(items[0], 'End');
    expect(picks).toEqual(['b', 'c', 'a', 'c', 'a', 'c']);
    expect(items.map((i) => i.tabIndex)).toEqual([-1, -1, 0]);
  });

  it('tabs: ← → only (↑ ↓ are the page’s), and the panel is linked', () => {
    const { g, items, picks } = group('tablist', ['S1', 'S2'], 0, '<div class="detail__pills"><slot></slot></div><div class="episodes"></div>');
    syncGroup(g);
    const panel = document.querySelector('.episodes');
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(items[0].getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(items[0].id);
    items[0].focus();
    expect(key(items[0], 'ArrowDown')).toBe(true);
    key(items[0], 'ArrowRight');
    expect(picks).toEqual(['S2']);
    syncGroup(g);
    expect(panel.getAttribute('aria-labelledby')).toBe(items[1].id);
  });

  it('a vertical tab list takes ↑ ↓ instead', () => {
    const { g, items, picks } = group('tablist', ['A', 'B'], 0);
    g.setAttribute('aria-orientation', 'vertical');
    items[0].focus();
    expect(key(items[0], 'ArrowRight')).toBe(true);
    key(items[0], 'ArrowDown');
    expect(picks).toEqual(['B']);
  });

  it('the Accounts sheet: arrows move focus but never switch the account', () => {
    const { g, items, picks } = group('radiogroup', ['me', 'other'], 0, '<div role="dialog" aria-label="Accounts"><slot></slot></div>');
    syncGroup(g);
    items[0].focus();
    key(items[0], 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
    expect(picks).toEqual([]);
    syncGroup(g); // focus holds the stop while it is there
    expect(items.map((i) => i.tabIndex)).toEqual([-1, 0]);
  });

  it('skips disabled options, and the player’s / context menu’s groups', () => {
    const { g, items } = group('radiogroup', ['a', 'b', 'c'], 0);
    items[1].setAttribute('disabled', '');
    expect(options(g)).toEqual([items[0], items[2]]);
    items[0].focus();
    key(items[0], 'ArrowRight');
    expect(document.activeElement).toBe(items[2]);
    const p = group('radiogroup', ['x', 'y'], 0, '<div class="wplayer"><slot></slot></div>');
    p.items[0].focus();
    expect(key(p.items[0], 'ArrowRight')).toBe(true);
    expect(document.activeElement).toBe(p.items[0]);
  });

  it('a new group is synced by the observer', async () => {
    const { items } = group('radiogroup', ['a', 'b'], 1);
    await frame();
    await frame();
    expect(items.map((i) => i.tabIndex)).toEqual([-1, 0]);
  });
});

describe('live regions (roving-live.js)', () => {
  it('an error card loses role=alert and is said once in our own region', async () => {
    const card = document.createElement('div');
    card.className = 'state state--error';
    card.setAttribute('role', 'alert');
    card.innerHTML = '<h2 class="state__title">Couldn’t load movies</h2><p class="state__text">The server had a problem (HTTP 500)</p><button>Retry</button>';
    document.body.append(card);
    await frame();
    await frame();
    await frame();
    expect(card.hasAttribute('role')).toBe(false);
    const alert = document.querySelector('.wlive[aria-live="assertive"]');
    expect(alert.textContent).toBe('Couldn’t load movies. The server had a problem (HTTP 500)');
    card.querySelector('button').textContent = 'Retrying…';
    await frame();
    await frame();
    expect(alert.textContent).toBe('Couldn’t load movies. The server had a problem (HTTP 500)');
  });

  it('Search: a stand-in h1, the count as the results heading, said politely', async () => {
    document.body.innerHTML =
      '<div class="route" data-route="search"><main class="screen srch"><form class="search"></form><p class="search__count" aria-live="polite">3 results</p><div class="grid srch__grid"></div></main></div>';
    await frame();
    await frame();
    await frame();
    const main = document.querySelector('.srch');
    const h1 = main.firstElementChild;
    expect(h1.tagName).toBe('H1');
    expect(h1.textContent).toBe('Search');
    expect(h1.hidden).toBe(false);
    const count = main.querySelector('.search__count');
    expect(count.hasAttribute('aria-live')).toBe(false);
    expect(count.getAttribute('role')).toBe('heading');
    expect(count.getAttribute('aria-level')).toBe('2');
    const polite = document.querySelector('.wlive[aria-live="polite"]');
    expect(polite.textContent).toBe('3 results');
    // the real title back: the stand-in hides
    const real = document.createElement('h1');
    real.textContent = 'Search';
    main.querySelector('form').before(real);
    await frame();
    await frame();
    expect(h1.hidden).toBe(true);
  });
});
