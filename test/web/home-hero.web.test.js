/* Home's hero on the web: web/src/lib/heroarrows.js (controls, hold, focus
 * hand-over) and the __WEB__ branches of phone/src/lib/carousel.js (the
 * auto-advance hold, what loads when). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initHeroArrows, heroHeld, controlAt, refocus, _resetHeroArrows } from '../../web/src/lib/heroarrows.js';
import { HeroCarousel, heroArt } from '../../phone/src/lib/carousel.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** a Home-shaped hero: n text blocks, slide `live` not inert */
function hero(n = 3, live = 0) {
  const h = document.createElement('section');
  h.className = 'hero homehero';
  for (let i = 0; i < n; i++) {
    const b = document.createElement('div');
    b.className = 'hero__body homehero__body';
    b.dataset.i = String(i);
    if (i !== live) b.setAttribute('inert', '');
    b.innerHTML = `<button class="btn">Resume ${i}</button><button class="btn">Details ${i}</button>`;
    h.append(b);
  }
  const dots = document.createElement('div');
  dots.className = 'dots hero__dots homehero__dots';
  h.append(dots);
  return h;
}

let started = false;
beforeEach(() => {
  document.body.innerHTML = '';
  _resetHeroArrows();
  if (!started) {
    initHeroArrows();
    started = true;
  }
});
afterEach(() => vi.useRealTimers());

describe('controls', () => {
  it('puts Pause · Previous · Next in front of the slides, once', async () => {
    const h = hero();
    document.body.append(h);
    await tick();
    await tick();
    const g = h.firstElementChild;
    expect(g?.className).toBe('whero__ctl');
    expect(g?.getAttribute('role')).toBe('group');
    expect([...(g?.children || [])].map((b) => b.getAttribute('aria-label'))).toEqual(['Pause slideshow', 'Previous', 'Next']);
    expect(g?.firstElementChild?.getAttribute('aria-pressed')).toBe('false');
    h.append(document.createElement('span')); // another mutation: not equipped twice
    await tick();
    expect(h.querySelectorAll('.whero__ctl')).toHaveLength(1);
  });

  it('Pause holds the hero and Play re-arms the auto-advance', async () => {
    const h = hero();
    document.body.append(h);
    await tick();
    const busy = vi.fn();
    /** @type {any} */ (h).__carousel = { n: 3, p: 0, parked: true, cb: { onbusy: busy }, advance() {} };
    const pause = /** @type {HTMLButtonElement} */ (h.querySelector('.whero__pause'));
    expect(heroHeld(h)).toBe(false);
    pause.click();
    expect(pause.getAttribute('aria-pressed')).toBe('true');
    expect(pause.getAttribute('aria-label')).toBe('Pause slideshow'); // the label never changes
    expect(heroHeld(h)).toBe(true);
    expect(/** @type {any} */ (h).__held()).toBe(true);
    pause.click();
    expect(pause.getAttribute('aria-pressed')).toBe('false');
    expect(heroHeld(h)).toBe(false);
    expect(busy.mock.calls).toEqual([[true], [false]]);
    expect(/** @type {any} */ (h).__carousel.parked).toBe(false);
  });

  it('Previous / Next step the carousel; not while it is held by a finger', async () => {
    const h = hero();
    document.body.append(h);
    await tick();
    const animate = vi.fn();
    const c = { n: 3, p: 1, busy: false, anim: null, animate };
    /** @type {any} */ (h).__carousel = c;
    /** @type {HTMLButtonElement} */ (h.querySelector('.whero__btn--next')).click();
    /** @type {HTMLButtonElement} */ (h.querySelector('.whero__btn--prev')).click();
    expect(animate.mock.calls.map((x) => x[0])).toEqual([2, 0]);
    c.busy = true;
    /** @type {HTMLButtonElement} */ (h.querySelector('.whero__btn--next')).click();
    expect(animate).toHaveBeenCalledTimes(2);
  });
});

describe('focus hand-over', () => {
  it('controlAt picks the same control, or the nearest enabled one', () => {
    const h = hero(1);
    const body = /** @type {Element} */ (h.querySelector('.homehero__body'));
    const [play, details] = body.querySelectorAll('button');
    expect(controlAt(body, 0)).toBe(play);
    expect(controlAt(body, 1)).toBe(details);
    expect(controlAt(body, 5)).toBe(details);
    play.setAttribute('disabled', '');
    expect(controlAt(body, 0)).toBe(details);
    details.setAttribute('disabled', '');
    expect(controlAt(body, 1)).toBe(null);
    expect(controlAt(null, 0)).toBe(null);
  });

  it('refocus moves focus to the live slide', () => {
    const h = hero(3, 2);
    document.body.append(h);
    expect(refocus(h, 1)).toBe(true);
    expect(document.activeElement?.textContent).toBe('Details 2');
  });

  it('a slide going inert under focus hands it to the new slide', async () => {
    const h = hero(3, 0);
    document.body.append(h);
    await tick();
    const [b0, b1] = h.querySelectorAll('.homehero__body');
    /** @type {HTMLElement} */ (b0.querySelector('button')).focus();
    // Home flips inert when the dominant slide changes
    b0.setAttribute('inert', '');
    b1.removeAttribute('inert');
    await tick();
    await new Promise((r) => requestAnimationFrame(r));
    expect(document.activeElement?.textContent).toBe('Resume 1');
  });

  it('a click elsewhere (focus to <body>) is left alone', async () => {
    const h = hero(3, 0);
    document.body.append(h);
    await tick();
    const btn = /** @type {HTMLElement} */ (h.querySelector('.homehero__body button'));
    btn.focus();
    btn.blur();
    await tick();
    expect(document.activeElement).toBe(document.body);
  });
});

describe('carousel.js on the web', () => {
  it('advance() parks while the hero is held', () => {
    const c = new HeroCarousel();
    const node = /** @type {any} */ (document.createElement('section'));
    c.node = node;
    c.n = 3;
    node.__held = () => true;
    c.advance();
    expect(/** @type {any} */ (c).parked).toBe(true);
    expect(c.anim).toBe(null);
    node.__held = () => false;
    c.advance();
    expect(/** @type {any} */ (c).parked).toBe(false);
    expect(c.anim?.to).toBe(1);
    c.stop();
  });

  it('heroArt loads nothing under a hidden route until it shows', async () => {
    const route = document.createElement('div');
    route.hidden = true;
    const h = document.createElement('section');
    const m = /** @type {any} */ (document.createElement('div'));
    m.className = 'homehero__media';
    m.dataset.i = '0';
    m.innerHTML = '<canvas class="homehero__hash"></canvas><img>';
    h.append(m);
    route.append(h);
    document.body.append(route);
    const made = vi.spyOn(globalThis, 'Image');
    const a = heroArt(m, { url: 'http://web.test/b.jpg', blur: null, hash: null });
    expect(made).not.toHaveBeenCalled();
    route.hidden = false;
    await tick();
    expect(made).toHaveBeenCalled();
    a.destroy?.();
    made.mockRestore();
  });

  it('heroArt: the shown slide first (high), the others after it (low)', async () => {
    const h = /** @type {any} */ (document.createElement('section'));
    const media = [0, 1].map((i) => {
      const m = /** @type {any} */ (document.createElement('div'));
      m.className = 'homehero__media';
      m.dataset.i = String(i);
      m.innerHTML = '<canvas class="homehero__hash"></canvas><img>';
      h.append(m);
      return m;
    });
    document.body.append(h);
    /** @type {HTMLImageElement[]} */
    const imgs = [];
    /** @type {Array<() => void>} */
    const decodes = [];
    const Real = globalThis.Image;
    globalThis.Image = /** @type {any} */ (
      class extends Real {
        constructor() {
          super();
          imgs.push(this);
        }
        decode() {
          return new Promise((r) => decodes.push(() => r(undefined)));
        }
      }
    );
    try {
      const a1 = heroArt(media[1], { url: 'http://web.test/1.jpg', blur: null, hash: null });
      const a0 = heroArt(media[0], { url: 'http://web.test/0.jpg', blur: null, hash: null });
      expect(imgs.map((x) => [x.src, x.fetchPriority])).toEqual([['http://web.test/0.jpg', 'high']]);
      decodes[0]();
      await tick();
      expect(imgs.map((x) => [x.src, x.fetchPriority])).toEqual([
        ['http://web.test/0.jpg', 'high'],
        ['http://web.test/1.jpg', 'low']
      ]);
      a0.destroy?.();
      a1.destroy?.();
    } finally {
      globalThis.Image = Real;
    }
  });
});
