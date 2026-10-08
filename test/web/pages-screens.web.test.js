/* The title pages' web-only behaviour in shared phone components, mounted in
 * the web build (lane pages):
 *  - Login (C-04): fields named by their labels only, the hint an alert tied
 *    to the field it is about, the wordmark the page's h1;
 *  - Overview (C-12): "more" is the control, the paragraph is text, and focus
 *    lands on the paragraph after expanding (not on <body>);
 *  - weberror.svelte.js (A-07 / A-09): the full-page LoadError over a page;
 *  - DetailHero's sharpenHero (E-02): TMDB w1280 → original after decode on a
 *    hero wider than 1440 device px. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';
import { mockFetch } from '../helpers/fetch.js';
import Login from '../../phone/src/screens/Login.svelte';
import Overview from '../../phone/src/components/detail/Overview.svelte';
import { pageError, visibleScreen } from '../../phone/src/components/detail/weberror.svelte.js';
import { sharpenHero } from '../../phone/src/components/detail/DetailHero.svelte';

/** @type {any[]} */
let comps = [];
let realRects;
beforeEach(() => {
  realRects = Element.prototype.getClientRects;
  Element.prototype.getClientRects = function () {
    return /** @type {any} */ (this.closest('[hidden]') ? [] : [{}]);
  };
});
afterEach(() => {
  for (const c of comps) unmount(c);
  comps = [];
  Element.prototype.getClientRects = realRects;
  document.body.innerHTML = '';
});
const settle = async () => {
  flushSync();
  await tick();
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
};

describe('Login (C-04)', () => {
  async function open() {
    const target = document.createElement('div');
    document.body.append(target);
    comps.push(mount(Login, { target }));
    await settle();
    return {
      user: /** @type {HTMLInputElement} */ (document.querySelector('input[autocomplete=username]')),
      pw: /** @type {HTMLInputElement} */ (document.querySelector('input[autocomplete=current-password]')),
      submit: /** @type {HTMLButtonElement} */ (document.querySelector('button[type=submit]'))
    };
  }
  const labelOf = (/** @type {Element} */ el) => document.getElementById(/** @type {string} */ (el.getAttribute('aria-labelledby')))?.textContent;

  it('names each field by its label alone and makes the wordmark the h1', async () => {
    const { user, pw } = await open();
    expect(labelOf(user)).toBe('Username');
    expect(labelOf(pw)).toBe('Password'); // not "Password Show password …"
    const h = document.querySelector('.login__brand .wordmark');
    expect(h?.getAttribute('role')).toBe('heading');
    expect(h?.getAttribute('aria-level')).toBe('1');
    expect(pw.hasAttribute('aria-invalid')).toBe(false);
  });

  it('an empty submit marks the username (the hint shows under the password)', async () => {
    const { user, pw, submit } = await open();
    submit.click();
    await settle();
    const hint = document.querySelector('.field__hint');
    expect(hint?.textContent).toBe('Enter your username');
    expect(hint?.getAttribute('role')).toBe('alert');
    expect(user.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(/** @type {string} */ (user.getAttribute('aria-describedby')))).toBe(hint);
    expect(pw.hasAttribute('aria-invalid')).toBe(false);
  });

  it('a wrong password marks the password and describes it by the alert; typing again clears nothing until the next try', async () => {
    const net = mockFetch();
    net.on('POST', /\/Users\/AuthenticateByName$/, net.status(401));
    const { user, pw, submit } = await open();
    user.value = 'alice';
    user.dispatchEvent(new Event('input', { bubbles: true }));
    pw.value = 'nope';
    pw.dispatchEvent(new Event('input', { bubbles: true }));
    submit.click();
    await vi.waitFor(() => expect(document.querySelector('.field__hint')?.textContent).toBe('Wrong username or password'));
    await settle();
    expect(pw.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(/** @type {string} */ (pw.getAttribute('aria-describedby')))?.getAttribute('role')).toBe('alert');
    expect(user.hasAttribute('aria-invalid')).toBe(false);
  });
});

describe('Overview (C-12)', () => {
  it('makes "more" the control and focuses the paragraph after expanding', async () => {
    const target = document.createElement('div');
    document.body.append(target);
    // happy-dom has no layout: report the paragraph as clipped
    const sh = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return this.classList?.contains('overview--clamp') ? 200 : 60; } });
    try {
      comps.push(mount(Overview, { target, props: { text: 'A long biography. '.repeat(100) } }));
      await settle();
      await settle();
      const p = /** @type {HTMLElement} */ (document.querySelector('.overview'));
      const more = /** @type {HTMLButtonElement} */ (document.querySelector('.overview__more'));
      expect(more).toBeTruthy();
      expect(p.hasAttribute('role')).toBe(false);
      expect(p.hasAttribute('tabindex')).toBe(false);
      expect(more.hasAttribute('aria-hidden')).toBe(false);
      expect(more.hasAttribute('tabindex')).toBe(false);
      expect(more.getAttribute('aria-expanded')).toBe('false');
      expect(more.getAttribute('aria-controls')).toBe(p.id);
      more.focus();
      more.click();
      await settle();
      expect(document.querySelector('.overview__more')).toBeNull();
      expect(document.activeElement).toBe(p);
      expect(p.tabIndex).toBe(-1);
    } finally {
      if (sh) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', sh);
    }
  });
});

describe('pageError (A-07 / A-09)', () => {
  it('finds the shown screen holding a selector', () => {
    document.body.innerHTML = '<div hidden><main class="screen" id="a"><i class="x"></i></main></div><main class="screen" id="b"><i class="x"></i></main><main class="screen" id="c"></main>';
    expect(visibleScreen('.x')?.id).toBe('b');
    expect(visibleScreen('.nope')).toBeNull();
  });

  it('puts the LoadError over the page, updates its error and gives the page back on close', async () => {
    document.body.innerHTML = '<main class="screen"><div class="detail__body">page</div></main>';
    const screen = /** @type {HTMLElement} */ (document.querySelector('.screen'));
    const retry = vi.fn(() => Promise.reject(new Error('still down')));
    const card = await pageError(screen, { title: 'Couldn’t load this person', error: Object.assign(new Error('x'), { userMessage: 'The server had a problem (HTTP 500)' }), retry });
    await settle();
    expect(screen.classList.contains('wpage--error')).toBe(true);
    expect(screen.querySelector('.wpage__err')?.textContent).toContain('Couldn’t load this person');
    card.update(Object.assign(new Error('y'), { userMessage: 'Still nothing' }));
    await settle();
    expect(screen.querySelector('.wpage__err')?.textContent).toContain('Still nothing');
    /** @type {HTMLButtonElement} */ (screen.querySelector('.wpage__err button')).click();
    await settle();
    expect(retry).toHaveBeenCalledTimes(1);
    card.close();
    card.close(); // twice is harmless
    expect(screen.querySelector('.wpage__err')).toBeNull();
    expect(screen.classList.contains('wpage--error')).toBe(false);
  });
});

describe('sharpenHero (E-02)', () => {
  const W1280 = 'https://image.tmdb.org/t/p/w1280/abc.jpg';
  const ORIG = 'https://image.tmdb.org/t/p/original/abc.jpg';
  /** @type {(() => void)[]} */
  let decodes = [];
  beforeEach(() => {
    decodes = [];
    vi.stubGlobal(
      'Image',
      class {
        src = '';
        decode() {
          return new Promise((r) => decodes.push(r));
        }
      }
    );
  });
  const hero = (src) => {
    const img = document.createElement('img');
    img.setAttribute('src', src);
    document.body.append(img);
    return img;
  };

  it('swaps a w1280 for the original once it decoded, on a hero over 1440 device px', async () => {
    vi.stubGlobal('innerWidth', 1920);
    const img = hero(W1280);
    expect(sharpenHero(img)).toBe(false); // the w1280 fades in as usual
    expect(img.getAttribute('src')).toBe(W1280);
    decodes[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(img.getAttribute('src')).toBe(ORIG);
    expect(sharpenHero(img)).toBe(true); // our own swap: no fade
  });

  it('keeps w1280 at 1440 device px or less, and other hosts alone', () => {
    vi.stubGlobal('innerWidth', 1280);
    expect(sharpenHero(hero(W1280))).toBe(false);
    vi.stubGlobal('innerWidth', 1920);
    expect(sharpenHero(hero('https://artworks.thetvdb.com/banners/x.jpg'))).toBe(false);
    expect(decodes.length).toBe(0);
  });

  it('does not swap when the hero moved on meanwhile', async () => {
    vi.stubGlobal('innerWidth', 2560);
    const img = hero(W1280);
    sharpenHero(img);
    img.setAttribute('src', 'https://image.tmdb.org/t/p/w1280/other.jpg');
    decodes[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(img.getAttribute('src')).toBe('https://image.tmdb.org/t/p/w1280/other.jpg');
  });
});

describe('pages that failed without a card of their own (A-07 / A-09), mounted', () => {
  it('Person: the record and the filmography failed → "Couldn’t load this person", Retry brings the page', async () => {
    const { cfg } = await import('../../src/lib/config.js');
    cfg.server = 'http://jf.test';
    cfg.token = 'tok-u1';
    cfg.userId = 'u1';
    let up = false;
    const net = mockFetch();
    net.on('GET', /\/Items\/p1\?/, () => (up ? { Id: 'p1', Name: 'Ava Archer', Type: 'Person' } : net.status(500)));
    net.on('GET', /\/Items\?/, () => (up ? { Items: [], TotalRecordCount: 0 } : net.status(500)));
    const { default: Person } = await import('../../phone/src/screens/Person.svelte');
    const target = document.createElement('div');
    document.body.append(target);
    comps.push(mount(Person, { target, props: { params: { id: 'p1', name: '' }, active: true } }));
    await vi.waitFor(() => expect(document.querySelector('.wpage__err')?.textContent).toContain('Couldn’t load this person'));
    const screen = document.querySelector('.screen');
    expect(screen?.classList.contains('wpage--error')).toBe(true);
    up = true;
    /** @type {HTMLButtonElement} */ (document.querySelector('.wpage__err button')).click();
    await vi.waitFor(() => expect(document.querySelector('.wpage__err')).toBeNull());
    await vi.waitFor(() => expect(document.querySelector('.person__name')?.textContent).toBe('Ava Archer'));
    expect(screen?.classList.contains('wpage--error')).toBe(false);
  });

  it('LookupDetail from a URL (no title) whose metadata fails → the LoadError card, Retry brings the title', async () => {
    const { cfg } = await import('../../src/lib/config.js');
    cfg.token = 'tok-u1';
    cfg.medialib = 'http://ml.test';
    let up = false;
    const net = mockFetch();
    net.on('GET', /\/api\/metadata\/movie\/900002$/, () => (up ? { title: 'Iron Tide', year: 2023, genres: [], episodes: [] } : net.status(500)));
    net.on('GET', /\/api\/me$/, net.status(404));
    const { default: LookupDetail } = await import('../../phone/src/screens/LookupDetail.svelte');
    const target = document.createElement('div');
    document.body.append(target);
    comps.push(mount(LookupDetail, { target, props: { params: { item: { id: '900002', type: 'movie', title: '' } }, active: true } }));
    await vi.waitFor(() => expect(document.querySelector('.wpage__err')?.textContent).toContain('Couldn’t load this title'));
    up = true;
    /** @type {HTMLButtonElement} */ (document.querySelector('.wpage__err button')).click();
    await vi.waitFor(() => expect(document.querySelector('.wpage__err')).toBeNull());
    await vi.waitFor(() => expect(document.querySelector('h1.detail__title')?.textContent).toBe('Iron Tide'));
  });

  it('LookupDetail with a title (opened from a tile) keeps the page when the metadata fails', async () => {
    const { cfg } = await import('../../src/lib/config.js');
    cfg.token = 'tok-u1';
    cfg.medialib = 'http://ml.test';
    const net = mockFetch();
    net.on('GET', /\/api\/metadata\/movie\/900003$/, net.status(500));
    net.on('GET', /\/api\/me$/, net.status(404));
    const { default: LookupDetail } = await import('../../phone/src/screens/LookupDetail.svelte');
    const target = document.createElement('div');
    document.body.append(target);
    comps.push(mount(LookupDetail, { target, props: { params: { item: { id: '900003', type: 'movie', title: 'Glass Harbor' } }, active: true } }));
    await vi.waitFor(() => expect(net.calls.some((c) => c.path === '/api/metadata/movie/900003')).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector('.wpage__err')).toBeNull();
    expect(document.querySelector('h1.detail__title')?.textContent).toBe('Glass Harbor');
  });
});
