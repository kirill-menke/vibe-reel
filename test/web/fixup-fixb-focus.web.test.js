/* Fix-up round, agent fixb — focus and keyboard where the lanes met:
 *  - focusguard.js: focus that falls to <body> (a removed Retry / Undo, a
 *    blur) lands on the page, after everyone's own hand-off, never under a
 *    modal, and not while a keeper holds it off;
 *  - searchurl.js: Esc on Search's empty field leaves it for the page;
 *  - Rail.svelte (web): ←/→ step between any rail cells (a cast member's
 *    button, a tile wrapped in a cell), never from a nested control; the
 *    hover edge paddles carry the head buttons' words as a tooltip;
 *  - roving-live.js: Home's stable h1, the slide titles one level down;
 *  - gridkeys-slices.js settleFirst(): a cold grid's wait for the feed. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';
import { initFocusGuard, holdGuard, guardHeld } from '../../web/src/lib/focusguard.js';
import { syncLive } from '../../web/src/lib/roving-live.js';
import { settleFirst } from '../../web/src/lib/gridkeys-slices.js';
import Rail from '../../web/src/components/Rail.svelte';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));
/* a frame + the guard's rest (100 ms) + slack */
const settle = async () => {
  await frame();
  await wait(140);
};

/** a page: a scroller (tabindex -1) holding a focusable button in a card */
function page() {
  document.body.innerHTML = '<section class="route"><main class="screen" tabindex="-1"><div class="card"><button class="retry">Retry</button></div><button class="other">Other</button></main></section>';
  return {
    screen: /** @type {HTMLElement} */ (document.querySelector('.screen')),
    card: /** @type {HTMLElement} */ (document.querySelector('.card')),
    retry: /** @type {HTMLButtonElement} */ (document.querySelector('.retry')),
    other: /** @type {HTMLButtonElement} */ (document.querySelector('.other'))
  };
}

describe('focusguard: focus never rests on <body>', () => {
  /** @type {(() => void) | null} */
  let stop = null;
  let blocked = false;
  afterEach(() => {
    stop?.();
    stop = null;
    blocked = false;
    document.body.innerHTML = '';
  });
  const start = (/** @type {() => HTMLElement | null} */ target) => {
    stop = initFocusGuard({ blocked: () => blocked, target });
  };

  it('puts focus on the page when the focused element is removed (no focusout: Firefox)', async () => {
    const { screen, card, retry } = page();
    start(() => screen);
    retry.focus();
    expect(document.activeElement).toBe(retry);
    card.remove(); // a Retry's card unmounting on success
    expect(document.activeElement === document.body || !retry.isConnected).toBe(true);
    await settle();
    expect(document.activeElement).toBe(screen);
  });

  it('puts focus on the page after a blur with nowhere to go (Esc out of a field)', async () => {
    const { screen, other } = page();
    start(() => screen);
    other.focus();
    other.blur();
    expect(document.activeElement).toBe(document.body);
    await settle();
    expect(document.activeElement).toBe(screen);
  });

  it('leaves focus alone once a hand-off of its own placed it', async () => {
    const { screen, card, retry, other } = page();
    start(() => screen);
    retry.focus();
    card.remove();
    other.focus(); // e.g. the player handing focus back to its opener
    await settle();
    expect(document.activeElement).toBe(other);
  });

  it('never acts while blocked (a sheet, a modal, a confirm, a context menu)', async () => {
    const { screen, other } = page();
    start(() => screen);
    blocked = true;
    other.focus();
    other.blur();
    await settle();
    expect(document.activeElement).toBe(document.body);
  });

  it('waits while a keeper holds it off, and looks again on release', async () => {
    const { screen, other } = page();
    start(() => screen);
    const release = holdGuard(5000);
    expect(guardHeld()).toBe(true);
    other.focus();
    other.blur();
    await settle();
    expect(document.activeElement).toBe(document.body); // the keeper's turn
    release();
    expect(guardHeld()).toBe(false);
    await settle();
    expect(document.activeElement).toBe(screen);
  });

  it('a hold also ends by itself', async () => {
    const release = holdGuard(30);
    expect(guardHeld()).toBe(true);
    await wait(60);
    expect(guardHeld()).toBe(false);
    release(); // a late release is harmless
    expect(guardHeld()).toBe(false);
  });

  it('a target that is gone or missing changes nothing', async () => {
    const { other } = page();
    start(() => null);
    other.focus();
    other.blur();
    await settle();
    expect(document.activeElement).toBe(document.body);
  });

  it('stops listening once stopped', async () => {
    const { screen, other } = page();
    start(() => screen);
    stop?.();
    stop = null;
    other.focus();
    other.blur();
    await settle();
    expect(document.activeElement).toBe(document.body);
  });
});

describe('searchurl: Esc on the empty Search field', () => {
  it('hands focus to the page scroller, not <body>; with a query it clears it first', async () => {
    vi.resetModules();
    const { initSearchUrl } = await import('../../web/src/lib/searchurl.js');
    initSearchUrl();
    document.body.innerHTML = '<section class="route" data-route="search"><main class="screen srch" tabindex="-1"><form class="search"><input class="search__input" type="search"></form></main></section>';
    const f = /** @type {HTMLInputElement} */ (document.querySelector('.search__input'));
    const screen = document.querySelector('.screen');
    f.value = 'harbor';
    f.focus();
    f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(f.value).toBe('');
    expect(document.activeElement).toBe(f);
    f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(screen);
    document.body.innerHTML = '';
  });
});

describe('Rail (web): ←/→ between any cells; titled edge paddles', () => {
  /** @type {any} */
  let comp = null;
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
  });
  afterEach(() => {
    if (comp) unmount(comp);
    comp = null;
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  /** @param {string} cells */
  async function rail(cells, props = {}) {
    const target = document.createElement('div');
    document.body.append(target);
    comp = mount(Rail, { target, props: { title: 'Cast & Crew', ...props } });
    flushSync();
    await tick();
    const track = /** @type {HTMLElement} */ (document.querySelector('.rail__track'));
    track.innerHTML = cells;
    track.scrollBy = () => {};
    return track;
  }
  /** @param {Element} el @param {string} key */
  const press = (el, key, opts = {}) => {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
    el.dispatchEvent(e);
    return e;
  };

  it('steps between cast members (buttons that are the cells themselves)', async () => {
    const track = await rail('<button class="cast">A</button><button class="cast">B</button><button class="cast">C</button>');
    const [a, b, c] = /** @type {HTMLElement[]} */ ([...track.children]);
    a.focus();
    expect(press(a, 'ArrowRight').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(b);
    press(b, 'ArrowRight');
    expect(document.activeElement).toBe(c);
    // the end: the key is still the rail's (no page scroll), focus stays
    expect(press(c, 'ArrowRight').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(c);
    press(c, 'ArrowLeft');
    expect(document.activeElement).toBe(b);
  });

  it('steps between tiles wrapped in cells, never from a nested control', async () => {
    const track = await rail(
      '<div class="home__cell"><div class="tile" tabindex="0">One<button class="tile__add">+</button></div></div>' +
        '<div class="home__cell"><div class="tile" tabindex="0">Two</div></div>'
    );
    const [one, two] = /** @type {HTMLElement[]} */ ([...track.querySelectorAll('.tile')]);
    const add = /** @type {HTMLElement} */ (track.querySelector('.tile__add'));
    one.focus();
    press(one, 'ArrowRight');
    expect(document.activeElement).toBe(two);
    add.focus();
    expect(press(add, 'ArrowRight').defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(add);
    // modifiers are the browser's
    two.focus();
    expect(press(two, 'ArrowLeft', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(two);
  });

  it('gives the hover edge paddles the head buttons’ words as a tooltip', async () => {
    await rail('');
    const head = [...document.querySelectorAll('.wrail__btn')].map((b) => b.getAttribute('aria-label'));
    const edges = [...document.querySelectorAll('.wrail__edge')].map((b) => b.getAttribute('title'));
    expect(head).toEqual(['Scroll Cast & Crew left', 'Scroll Cast & Crew right']);
    expect(edges).toEqual(head);
    for (const e of document.querySelectorAll('.wrail__edge')) {
      expect(e.getAttribute('aria-hidden')).toBe('true');
      expect(e.getAttribute('tabindex')).toBe('-1');
    }
  });

  it('an unnamed rail still says which way', async () => {
    await rail('', { title: '' });
    expect([...document.querySelectorAll('.wrail__edge')].map((b) => b.getAttribute('title'))).toEqual(['Scroll left', 'Scroll right']);
  });
});

describe('roving-live: Home names itself', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });
  it('a hidden h1 "Home" first in the page, the slide titles as level-2 headings — once', () => {
    document.body.innerHTML =
      '<section class="route" data-route="home"><main class="screen home"><section class="hero"><div class="hero__body"><h1 class="hero__title">Northern Line</h1></div><div class="hero__body"><h1 class="hero__title">Paper Kingdom</h1></div></section></main></section>';
    syncLive();
    syncLive();
    const home = /** @type {HTMLElement} */ (document.querySelector('.screen.home'));
    const h1s = [...home.querySelectorAll('h1')].filter((h) => !h.classList.contains('hero__title'));
    expect(h1s.length).toBe(1);
    expect(home.firstElementChild).toBe(h1s[0]);
    expect(h1s[0].textContent).toBe('Home');
    expect(h1s[0].className).toBe('sr-only');
    for (const t of home.querySelectorAll('.hero__title')) {
      expect(t.getAttribute('role')).toBe('heading');
      expect(t.getAttribute('aria-level')).toBe('2');
    }
    // a new Home page (remount): its own h1
    document.body.innerHTML = '<section class="route" data-route="home"><main class="screen home"></main></section>';
    syncLive();
    expect(document.querySelector('.screen.home > h1')?.textContent).toBe('Home');
  });
});

describe('gridkeys-slices settleFirst()', () => {
  it('resolves as soon as ready() says so', async () => {
    let ok = false;
    let done = false;
    const p = settleFirst(() => ok, 2000).then(() => (done = true));
    await wait(60);
    expect(done).toBe(false);
    ok = true;
    await wait(60);
    expect(done).toBe(true);
    await p;
  });
  it('gives up after ms', async () => {
    const t0 = performance.now();
    await settleFirst(() => false, 100);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(90);
  });
  it('resolves at once when already ready', async () => {
    const t0 = performance.now();
    await settleFirst(() => true);
    expect(performance.now() - t0).toBeLessThan(40);
  });
});
