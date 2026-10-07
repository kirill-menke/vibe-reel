/* focus.js — the edges test/tv/focus.test.js leaves open, mutation-backed
 * (lane r3-tv-unit: Stryker on src/lib/focus.js). Same idioms as focus.test.js:
 * happy-dom does no layout, so every rect is stubbed per element.
 *
 * CLAUDE.md, "Input":
 * - focusables() is scoped "info > panel > video-layer during playback;
 *   #search while Search is up; an open .lvmenu; else the mounted .screen".
 * - spatialMove() "scores candidates by distance with a 3× orthogonal penalty
 *   (coalesced to one move per animation frame …), and horizontal moves
 *   additionally require ≥40% vertical overlap".
 * - ensureVisible() glides "via one shared rAF loop with an exponential
 *   ease-out, and a new target arriving mid-glide just bends the motion";
 *   "jumpScroll(el, top) is the instant variant — it drops the element's glide
 *   in flight".
 * - "focusFirst() only honours S.focusKey if that element is in focusables()". */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { freshImport } from '../helpers/modules.js';
import { useClock } from '../helpers/time.js';

let F, S;

beforeEach(async () => {
  const m = await freshImport({ modules: { focus: 'src/lib/focus.js', nav: 'src/lib/nav.svelte.js' } });
  F = m.focus;
  S = m.nav.S;
  S.screen = 'home';
  S.search = false;
  S.focusKey = null;
});

afterEach(() => {
  document.body.innerHTML = '';
  delete document.body.getBoundingClientRect;   // one test gives <body> a box
});

function box(el, left, top, width, height) {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
  return el;
}

function mk(parent, { tag = 'div', cls = 'focus', key, id, at, hidden } = {}) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (key) e.dataset.focus = key;
  if (id) e.id = id;
  if (hidden) e.hidden = true;
  if (tag === 'div') e.tabIndex = 0;
  if (at) box(e, ...at);
  parent.append(e);
  return e;
}

const keys = (list) => list.map((e) => e.dataset.focus);
const active = () => (document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.focus : undefined);
const screen = () => mk(document.body, { cls: 'screen' });

/** a vertical .page scroller (viewport 0..1000) */
function page(parent, contentH = 5000) {
  const p = mk(parent, { cls: 'page', at: [0, 0, 1920, 1000] });
  Object.defineProperty(p, 'scrollHeight', { value: contentH, configurable: true });
  Object.defineProperty(p, 'clientHeight', { value: 1000, configurable: true });
  return p;
}

/* ------------------------------------------------------------------------ */

describe('focusables(): the scope order, element by element', () => {
  it('Search flagged but its overlay not mounted: the whole document, not the screen', () => {
    const scr = screen();
    mk(scr, { key: 'tile' });
    mk(document.body, { key: 'loose' });
    S.search = true;
    expect(keys(F.focusables())).toEqual(['tile', 'loose']);
  });

  it('the player without a video layer mounted: the whole document', () => {
    const scr = screen();
    mk(scr, { key: 'd-play' });
    S.screen = 'player';
    expect(keys(F.focusables())).toEqual(['d-play']);
  });

  it('the error card wins over an open audio panel and the chapter list (all three open)', () => {
    screen();
    const layer = mk(document.body, { cls: '', id: 'video-layer' });
    mk(layer, { key: 'c-play' });
    const panel = mk(layer, { cls: '', id: 'player-menu' });
    mk(panel, { cls: 'opt', key: 'pm-a1' });
    const chapters = mk(layer, { cls: '', id: 'chapter-menu' });
    mk(chapters, { cls: 'opt', key: 'ch-1' });
    const err = mk(layer, { cls: '', id: 'play-error' });
    mk(err, { key: 'err-retry' });
    S.screen = 'player';
    expect(keys(F.focusables())).toEqual(['err-retry']);
    err.remove();
    expect(keys(F.focusables())).toEqual(['ch-1']);
    chapters.remove();
    expect(keys(F.focusables())).toEqual(['pm-a1']);
  });

  it('a [hidden] error card does not capture focus: the video layer (the first menu found decides)', () => {
    screen();
    const layer = mk(document.body, { cls: '', id: 'video-layer' });
    mk(layer, { key: 'c-play' });
    const err = mk(layer, { cls: '', id: 'play-error', hidden: true });
    mk(err, { key: 'err-retry' }).checkVisibility = () => false;
    const panel = mk(layer, { cls: '', id: 'player-menu' });
    mk(panel, { cls: 'opt', key: 'pm-a1' });
    S.screen = 'player';
    // getElementById('play-error') is found first and is hidden → the layer, rows of the panel included
    expect(keys(F.focusables())).toEqual(['c-play', 'pm-a1']);
  });

  it('an .lvmenu outside the mounted screen is not modal', () => {
    const scr = screen();
    mk(scr, { key: 'tab' });
    const menu = mk(document.body, { cls: 'lvmenu' });
    mk(menu, { key: 'lv-1' });
    expect(keys(F.focusables())).toEqual(['tab']);
  });

  it('inside an open .lvmenu a disabled row still counts (only the box decides there)', () => {
    const scr = screen();
    const menu = mk(scr, { cls: 'lvmenu' });
    mk(menu, { tag: 'button', key: 'lv-off' }).disabled = true;
    mk(menu, { key: 'lv-nobox' }).checkVisibility = () => false;
    mk(menu, { key: 'lv-on' });
    expect(keys(F.focusables())).toEqual(['lv-off', 'lv-on']);
  });

  it('an [inert] subtree inside an .lvmenu is dropped too', () => {
    const scr = screen();
    const menu = mk(scr, { cls: 'lvmenu' });
    const old = document.createElement('div');
    old.setAttribute('inert', '');
    menu.append(old);
    mk(old, { key: 'lv-old' });
    mk(menu, { key: 'lv-new' });
    expect(keys(F.focusables())).toEqual(['lv-new']);
  });

  it('no .screen mounted: a disabled element in the document is still filtered', () => {
    mk(document.body, { tag: 'button', key: 'off' }).disabled = true;
    mk(document.body, { key: 'on' });
    expect(keys(F.focusables())).toEqual(['on']);
  });
});

describe('byKey: the scope first, then the document', () => {
  it('a key in the scope and also earlier in the document resolves inside the scope', () => {
    const outside = mk(document.body, { key: 'k' });
    const scr = screen();
    const inside = mk(scr, { key: 'k' });
    expect(F.byKey('k')).toBe(inside);
    scr.remove();
    expect(F.byKey('k')).toBe(outside);
  });

  it('with the document itself as the scope (boot), a key outside any screen is found', () => {
    const el = mk(document.body, { key: 'boot-x' });
    expect(F.byKey('boot-x')).toBe(el);
  });
});

describe('focusFirst: S.focusKey only when it is a candidate', () => {
  it('a S.focusKey on an element inside the scope but without a box → the first focusable', async () => {
    const scr = screen();
    mk(scr, { key: 'a', at: [0, 0, 100, 100] });
    mk(scr, { key: 'b', at: [200, 0, 100, 100] }).checkVisibility = () => false;
    S.focusKey = 'b';
    await F.focusFirst();
    expect(active()).toBe('a');
  });

  it('a S.focusKey that names nothing → the first focusable', async () => {
    const scr = screen();
    mk(scr, { key: 'a', at: [0, 0, 100, 100] });
    mk(scr, { key: 'b', at: [200, 0, 100, 100] });
    S.focusKey = 'gone';
    await F.focusFirst();
    expect(active()).toBe('a');
  });

  it('focusFirst goes through focusEl (preventScroll), and the glide brings the element into view', async () => {
    const clock = useClock();
    const scr = screen();
    const p = page(scr);
    const el = mk(p, { key: 'far', at: [0, 1300, 200, 300] });
    const spy = vi.spyOn(el, 'focus');
    S.focusKey = 'far';
    const done = F.focusFirst();
    await clock.flush();
    await done;
    expect(spy).toHaveBeenCalledWith({ preventScroll: true });
    await clock.tick(1000);
    expect(p.scrollTop).toBe(750);
  });

  it('focusFirst awaits tick(): an element rendered right after the call is the one focused', async () => {
    const scr = screen();
    S.focusKey = 'late';
    const p = F.focusFirst();
    mk(scr, { key: 'first', at: [0, 0, 100, 100] });
    mk(scr, { key: 'late', at: [0, 200, 100, 100] });
    await p;
    expect(active()).toBe('late');
  });
});

describe('focusFirst with nothing to focus', () => {
  it('moves focus off an element that is no longer in scope, onto <body>', async () => {
    screen();
    const layer = mk(document.body, { cls: '', id: 'video-layer', hidden: true });
    const play = mk(layer, { key: 'c-play', at: [0, 0, 100, 100] });
    play.focus();   // the OSD button focus sat on during playback
    expect(document.activeElement).toBe(play);
    await F.focusFirst();
    expect(document.activeElement).toBe(document.body);
  });
});

describe('the glide frame: rAF and its timer backstop cancel each other', () => {
  let clock;
  beforeEach(() => {
    clock = useClock();
  });

  it('a frame from rAF clears the pending 32 ms timer', async () => {
    const scr = screen();
    const p = page(scr);
    const ct = vi.spyOn(globalThis, 'clearTimeout');
    const st = vi.spyOn(globalThis, 'setTimeout');
    F.scrollElTo(p, 400);
    const timer = st.mock.results.find((r, i) => st.mock.calls[i][1] === 32).value;
    await clock.tick(16);   // the rAF frame
    expect(p.scrollTop).toBeGreaterThan(0);
    expect(ct).toHaveBeenCalledWith(timer);
  });

  it('a frame from the timer (rAF starved) cancels the pending rAF', async () => {
    const scr = screen();
    const p = page(scr);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 77);   // asked for, never delivered
    const caf = vi.spyOn(window, 'cancelAnimationFrame');
    F.scrollElTo(p, 400);
    await clock.tick(32);
    expect(p.scrollTop).toBeGreaterThan(0);
    expect(caf).toHaveBeenCalledWith(77);
  });
});

describe('focusKeyInstant and the glide', () => {
  let clock;
  beforeEach(() => {
    clock = useClock();
  });

  it('a jump while a glide is in flight on the same scroller drops that glide', async () => {
    const scr = screen();
    const p = page(scr);
    mk(p, { key: 'a', at: [0, 1300, 200, 300] });   // glide target 750
    F.focusNow('a');
    await clock.tick(16);
    const mid = p.scrollTop;
    expect(mid).toBeGreaterThan(0);
    // a remembered row further down, measured against the live offset: jump +1000
    mk(p, { key: 'b', at: [0, 1850, 200, 300] });
    const done = F.focusKeyInstant('b');
    await clock.flush();
    expect(await done).toBe(true);
    const jumped = p.scrollTop;
    expect(jumped).toBeCloseTo(mid + 1300, 5);   // 2150 − 850 = +1300
    await clock.tick(1000);
    expect(p.scrollTop).toBeCloseTo(jumped, 5);   // the old glide (to 750) never pulls it back
  });

  it('a zero scroll inside the instant window leaves a running glide alone', async () => {
    const scr = screen();
    const p = page(scr);
    mk(p, { key: 'a', at: [0, 1300, 200, 300] });
    mk(p, { key: 'vis', at: [0, 400, 200, 100] });   // already in view: no scroll
    F.focusNow('a');
    await clock.tick(16);
    const done = F.focusKeyInstant('vis');
    await clock.flush();
    await done;
    F.scrollElBy(p, 0);   // still the instant task
    await clock.tick(1000);
    expect(p.scrollTop).toBe(750);
  });

  it('the instant jump does not clamp: it writes the scroller directly', async () => {
    const scr = screen();
    const p = page(scr, 1200);   // max 200
    mk(p, { key: 'a', at: [0, 1300, 200, 300] });
    const done = F.focusKeyInstant('a');
    await clock.flush();
    await done;
    // happy-dom keeps the written value; a real engine clamps it — the glide path clamps itself
    expect(p.scrollTop).toBe(750);
  });
});

describe('the shared glide loop', () => {
  let clock;
  beforeEach(() => {
    clock = useClock();
  });

  it('one rAF loop drives every scroller: two glides start, both land, with one frame request at a time', async () => {
    const scr = screen();
    const p = page(scr);
    const s = mk(scr, { cls: 'strip', at: [0, 0, 1000, 300] });
    Object.defineProperty(s, 'scrollWidth', { value: 4000, configurable: true });
    Object.defineProperty(s, 'clientWidth', { value: 1000, configurable: true });
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    F.scrollElTo(p, 400);
    F.scrollElTo(p, 300);   // retarget mid-flight: no second loop
    mk(s, { key: 'tile', at: [1000, 0, 200, 300] });
    F.focusNow('tile');
    expect(raf).toHaveBeenCalledTimes(1);
    await clock.tick(1000);
    expect(p.scrollTop).toBe(300);
    expect(s.scrollLeft).toBe(290);
    const frames = raf.mock.calls.length;
    await clock.tick(1000);
    expect(raf.mock.calls.length).toBe(frames);   // landed: the loop stopped
  });

  it('the first frame of a new glide advances a 16 ms step, not a stale gap since the last glide', async () => {
    const scr = screen();
    const p = page(scr);
    F.scrollElTo(p, 400);
    await clock.tick(1000);
    expect(p.scrollTop).toBe(400);
    await clock.tick(5000);   // idle
    F.scrollElTo(p, 1400);
    await clock.tick(16);
    const step = p.scrollTop - 400;
    // 1 − e^(−16/75) of 1000 px ≈ 192; a stale dt (capped 64 ms) would be ≈ 573
    expect(step).toBeGreaterThan(150);
    expect(step).toBeLessThan(250);
  });

  it('a frame after a long stall moves at most a 64 ms step', async () => {
    const scr = screen();
    const p = page(scr);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);   // timer-driven frames only
    F.scrollElTo(p, 1000);
    await clock.tick(32);   // first frame: dt 16
    const a = p.scrollTop;
    expect(a).toBeCloseTo(1000 * (1 - Math.exp(-16 / 75)), 5);
    // the next frame is the 32 ms timer; make it late
    const now = performance.now.bind(performance);
    vi.spyOn(performance, 'now').mockImplementation(() => now() + 500);
    await clock.tick(32);
    const f = 1 - Math.exp(-64 / 75);
    expect(p.scrollTop).toBeCloseTo(a + (1000 - a) * f, 5);
  });

  it('decays by 1/e every 75 ms (frames 16 ms apart)', async () => {
    const scr = screen();
    const p = page(scr);
    F.scrollElTo(p, 1000);
    await clock.tick(16);
    const f = 1 - Math.exp(-16 / 75);
    expect(p.scrollTop).toBeCloseTo(1000 * f, 5);
    await clock.tick(16);
    expect(p.scrollTop).toBeCloseTo(1000 * f + (1000 - 1000 * f) * f, 5);
  });

  it('snaps onto the target once within half a pixel, and stops', async () => {
    const scr = screen();
    const p = page(scr);
    F.scrollElTo(p, 100);
    for (let i = 0; i < 200 && p.scrollTop !== 100; i++) await clock.tick(16);
    expect(p.scrollTop).toBe(100);
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    await clock.tick(200);
    expect(raf).not.toHaveBeenCalled();
  });

  it('a scroll smaller than half a pixel starts nothing', () => {
    const scr = screen();
    const p = page(scr);
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    F.scrollElBy(p, 0.4);
    F.scrollElBy(p, -0.4);   // at 0: clamped to nothing
    expect(raf).not.toHaveBeenCalled();
    expect(p.scrollTop).toBe(0);
  });

  it('a target at the edge the scroller already sits at starts nothing (clamped)', () => {
    const scr = screen();
    const p = page(scr);
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    F.scrollElBy(p, -300);
    expect(raf).not.toHaveBeenCalled();
  });

  it('a scroller with less content than its viewport never scrolls', async () => {
    const scr = screen();
    const p = page(scr, 600);   // max < 0
    F.scrollElBy(p, 300);
    await clock.tick(1000);
    expect(p.scrollTop).toBe(0);
  });

  it('a glide on both axes of one scroller runs both; jumpScroll of one keeps the other', async () => {
    const scr = screen();
    const s = mk(scr, { cls: 'strip page', at: [0, 0, 1000, 1000] });
    for (const [k, v] of Object.entries({ scrollWidth: 4000, clientWidth: 1000, scrollHeight: 4000, clientHeight: 1000 }))
      Object.defineProperty(s, k, { value: v, configurable: true });
    mk(s, { key: 't', at: [1100, 1100, 200, 200] });
    F.focusNow('t');
    await clock.tick(16);
    expect(s.scrollLeft).toBeGreaterThan(0);
    expect(s.scrollTop).toBeGreaterThan(0);
    F.jumpScroll(s, 0, 'x');
    await clock.tick(1000);
    expect(s.scrollLeft).toBe(0);
    expect(s.scrollTop).toBe(450);   // 1300 − (1000 − 150)
  });

  it('jumpScroll of the only running axis ends the scroller’s glide; another glide later starts clean', async () => {
    const scr = screen();
    const p = page(scr);
    F.scrollElTo(p, 800);
    await clock.tick(16);
    F.jumpScroll(p, 50);
    await clock.tick(1000);
    expect(p.scrollTop).toBe(50);
    F.scrollElTo(p, 450);
    await clock.tick(1000);
    expect(p.scrollTop).toBe(450);
  });

  it('a scroll of exactly half a pixel is a glide (only less is nothing)', async () => {
    const scr = screen();
    const p = page(scr);
    F.scrollElBy(p, 0.5);
    await clock.tick(1000);
    expect(p.scrollTop).toBe(0.5);
    F.scrollElTo(p, 1);
    await clock.tick(1000);
    expect(p.scrollTop).toBe(1);
  });

  it('from a scrolled position: less than half a pixel is nothing, a target is absolute', async () => {
    const scr = screen();
    const p = page(scr);
    p.scrollTop = 100;
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    F.scrollElBy(p, 0.4);
    F.scrollElTo(p, 100.25);
    expect(raf).not.toHaveBeenCalled();
    F.scrollElTo(p, 400);
    await clock.tick(1000);
    expect(p.scrollTop).toBe(400);
  });

  it('scrollElTo where the scroller already sits cancels a glide from a scrolled position too', async () => {
    const scr = screen();
    const p = page(scr);
    p.scrollTop = 100;
    F.scrollElBy(p, 500);
    F.scrollElTo(p, 100);
    await clock.tick(1000);
    expect(p.scrollTop).toBe(100);
  });

  it('scrollElTo past the end, sitting at the end, cancels a glide away from it', async () => {
    const scr = screen();
    const p = page(scr);   // max 4000
    p.scrollTop = 4000;
    F.scrollElTo(p, 3000);
    F.scrollElTo(p, 99999);   // "stay at the bottom"
    await clock.tick(1000);
    expect(p.scrollTop).toBe(4000);
  });

  it('scrollElTo / jumpScroll on a scroller with no glide state at all', async () => {
    const scr = screen();
    const p = page(scr);
    expect(() => F.scrollElTo(p, 0)).not.toThrow();
    expect(() => F.jumpScroll(p, 30)).not.toThrow();
    expect(p.scrollTop).toBe(30);
    expect(() => F.jumpScroll(p, 40, 'x')).not.toThrow();
    expect(p.scrollLeft).toBe(40);
  });

  it('jumpScroll of y keeps an x glide of the same scroller running', async () => {
    const scr = screen();
    const s = mk(scr, { cls: 'strip page', at: [0, 0, 1000, 1000] });
    for (const [k, v] of Object.entries({ scrollWidth: 4000, clientWidth: 1000, scrollHeight: 4000, clientHeight: 1000 }))
      Object.defineProperty(s, k, { value: v, configurable: true });
    mk(s, { key: 't', at: [1100, 1100, 200, 200] });
    F.focusNow('t');
    await clock.tick(16);
    F.jumpScroll(s, 0);
    await clock.tick(1000);
    expect(s.scrollTop).toBe(0);
    expect(s.scrollLeft).toBe(390);   // 1300 − (1000 − 90)
  });

  it('a retarget mid-glide keeps the frame clock (timer-driven frames stay 32 ms steps)', async () => {
    const scr = screen();
    const p = page(scr);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);   // starved: the 32 ms timer drives
    F.scrollElTo(p, 1000);
    await clock.tick(32);   // first frame: 16 ms step
    await clock.tick(32);   // second: 32 ms step
    const a = p.scrollTop;
    F.scrollElTo(p, 2000);   // retarget between frames
    await clock.tick(32);
    expect(p.scrollTop).toBeCloseTo(a + (2000 - a) * (1 - Math.exp(-32 / 75)), 5);
  });

  it('a scroller detached mid-glide forgets it: attached again, it does not resume', async () => {
    const scr = screen();
    const p = page(scr);
    F.scrollElTo(p, 1000);
    await clock.tick(16);
    const at = p.scrollTop;
    p.remove();
    await clock.tick(16);   // the frame that drops it
    scr.append(p);
    const q = page(scr);
    F.scrollElTo(q, 500);   // another glide runs the loop again
    await clock.tick(1000);
    expect(q.scrollTop).toBe(500);
    expect(p.scrollTop).toBe(at);
  });

  it('jumpScroll/scrollElTo/scrollElBy/ensureVisible with no element do nothing', () => {
    expect(() => {
      F.jumpScroll(null, 10);
      F.scrollElTo(null, 10);
      F.scrollElBy(undefined, 10);
      F.ensureVisible(null);
      F.ensureVisible({});
    }).not.toThrow();
  });
});

describe('ensureVisible: each scroller, both directions, and in view', () => {
  let clock;
  beforeEach(() => {
    clock = useClock();
  });

  function strip() {
    const scr = screen();
    const s = mk(scr, { cls: 'strip', at: [0, 0, 1000, 300] });
    Object.defineProperty(s, 'scrollWidth', { value: 4000, configurable: true });
    Object.defineProperty(s, 'clientWidth', { value: 1000, configurable: true });
    return s;
  }

  it('a .strip tile left of the 90 px margin scrolls left by exactly the shortfall', async () => {
    const s = strip();
    s.scrollLeft = 500;
    const t = mk(s, { key: 't', at: [40, 0, 200, 300] });
    F.ensureVisible(t);
    await clock.tick(1000);
    expect(s.scrollLeft).toBe(450);   // 500 − (90 − 40)
  });

  it('a .strip tile exactly on either margin, or inside, does not scroll', async () => {
    const s = strip();
    s.scrollLeft = 500;
    const t = mk(s, { key: 't', at: [90, 0, 200, 300] });
    F.ensureVisible(t);
    box(t, 710, 0, 200, 300);   // right edge 910 = 1000 − 90
    F.ensureVisible(t);
    box(t, 400, 0, 200, 300);
    F.ensureVisible(t);
    await clock.tick(1000);
    expect(s.scrollLeft).toBe(500);
  });

  it('a .strip glide stops at the end of its content (scrollWidth − clientWidth)', async () => {
    const s = strip();   // 4000 wide, 1000 visible: max 3000
    s.scrollLeft = 2900;
    const t = mk(s, { key: 't', at: [1500, 0, 200, 300] });   // would need +790
    F.ensureVisible(t);
    await clock.tick(1000);
    expect(s.scrollLeft).toBe(3000);
  });

  it('a .strip tile inside the right margin scrolls by exactly the overlap', async () => {
    const s = strip();
    const t = mk(s, { key: 't', at: [750, 0, 200, 300] });   // right edge 950 > 1000 − 90
    F.ensureVisible(t);
    await clock.tick(1000);
    expect(s.scrollLeft).toBe(40);
  });

  it('a .cast-strip is a strip too', async () => {
    const scr = screen();
    const s = mk(scr, { cls: 'cast-strip', at: [0, 0, 1000, 300] });
    Object.defineProperty(s, 'scrollWidth', { value: 4000, configurable: true });
    Object.defineProperty(s, 'clientWidth', { value: 1000, configurable: true });
    const t = mk(s, { key: 't', at: [1000, 0, 200, 300] });
    F.ensureVisible(t);
    await clock.tick(1000);
    expect(s.scrollLeft).toBe(290);
  });

  it('a .page row above the 150 px margin scrolls up by exactly the shortfall', async () => {
    const scr = screen();
    const p = page(scr);
    p.scrollTop = 1000;
    const r = mk(p, { key: 'r', at: [0, 100, 200, 300] });
    F.ensureVisible(r);
    await clock.tick(1000);
    expect(p.scrollTop).toBe(950);
  });

  it('a .page row exactly on either margin does not scroll', async () => {
    const scr = screen();
    const p = page(scr);
    p.scrollTop = 1000;
    const r = mk(p, { key: 'r', at: [0, 150, 200, 300] });
    F.ensureVisible(r);
    box(r, 0, 550, 200, 300);   // bottom 850 = 1000 − 150
    F.ensureVisible(r);
    await clock.tick(1000);
    expect(p.scrollTop).toBe(1000);
  });

  it('a .page whose own box is offset measures against that box', async () => {
    const scr = screen();
    const p = mk(scr, { cls: 'page', at: [0, 200, 1920, 800] });
    Object.defineProperty(p, 'scrollHeight', { value: 5000, configurable: true });
    Object.defineProperty(p, 'clientHeight', { value: 800, configurable: true });
    const r = mk(p, { key: 'r', at: [0, 900, 200, 100] });   // bottom 1000 > 1000 − 150
    F.ensureVisible(r);
    await clock.tick(1000);
    expect(p.scrollTop).toBe(150);
  });

  it('a .qrows row exactly on either margin does not scroll', async () => {
    const scr = screen();
    const q = mk(scr, { cls: 'qrows', at: [0, 100, 600, 500] });
    Object.defineProperty(q, 'scrollHeight', { value: 3000, configurable: true });
    Object.defineProperty(q, 'clientHeight', { value: 500, configurable: true });
    q.scrollTop = 300;
    const r = mk(q, { key: 'r', at: [0, 170, 600, 60] });
    F.ensureVisible(r);
    box(r, 0, 470, 600, 60);   // bottom 530 = 600 − 70
    F.ensureVisible(r);
    await clock.tick(1000);
    expect(q.scrollTop).toBe(300);
  });

  it('a tile in a strip on a page scrolls both', async () => {
    const scr = screen();
    const p = page(scr);
    const s = mk(p, { cls: 'strip', at: [0, 900, 1000, 300] });
    Object.defineProperty(s, 'scrollWidth', { value: 4000, configurable: true });
    Object.defineProperty(s, 'clientWidth', { value: 1000, configurable: true });
    const t = mk(s, { key: 't', at: [1000, 900, 200, 300] });
    F.ensureVisible(t);
    await clock.tick(1000);
    expect(s.scrollLeft).toBe(290);
    expect(p.scrollTop).toBe(350);
  });
});

/* ------------------------------------------------------------------------ */

describe('spatialMove: scoring, both directions of each rule', () => {
  const L = 37, U = 38, R = 39, D = 40;
  let clock;
  beforeEach(() => {
    clock = useClock();
  });
  async function press(key) {
    F.spatialMove(key);
    await clock.tick(60);
  }

  it('◀ skips a candidate less than 5 px to the left; 5 px qualifies', async () => {
    const scr = screen();
    mk(scr, { key: 'cur', at: [100, 0, 100, 100] });
    const o = mk(scr, { key: 'o', at: [96, 0, 100, 100] });
    F.focusNow('cur');
    await press(L);
    expect(active()).toBe('cur');
    box(o, 95, 0, 100, 100);
    await press(L);
    expect(active()).toBe('o');
  });

  it('▲ skips a candidate centred less than 5 px above; it must also clear the row', async () => {
    const scr = screen();
    mk(scr, { key: 'cur', at: [0, 200, 100, 100] });
    const o = mk(scr, { key: 'o', at: [0, 196, 100, 40] });   // centre 216 < 250, 34 px above: but overlaps 36 of 40 (> 50 %)
    F.focusNow('cur');
    await press(U);
    expect(active()).toBe('cur');
    box(o, 0, 100, 100, 100);   // fully above
    await press(U);
    expect(active()).toBe('o');
  });

  it('▲▼ allow up to 50 % overlap with the current row: 50 px of 100 qualifies, 51 does not', async () => {
    const scr = screen();
    mk(scr, { key: 'cur', at: [0, 0, 100, 100] });
    const o = mk(scr, { key: 'o', at: [200, 49, 100, 100] });   // overlap 51
    F.focusNow('cur');
    await press(D);
    expect(active()).toBe('cur');
    box(o, 200, 50, 100, 100);   // overlap 50
    await press(D);
    expect(active()).toBe('o');
  });

  it('the ≥ 40 % overlap is of the smaller of the two heights', async () => {
    const scr = screen();
    mk(scr, { key: 'cur', at: [0, 0, 100, 300] });
    const o = mk(scr, { key: 'o', at: [200, 261, 100, 100] });   // overlap 39 of the 100 px candidate
    F.focusNow('cur');
    await press(R);
    expect(active()).toBe('cur');
    box(o, 200, 260, 100, 100);   // overlap 40
    await press(R);
    expect(active()).toBe('o');
  });

  it('▶ prefers the nearer of two candidates in line', async () => {
    const scr = screen();
    mk(scr, { key: 'cur', at: [0, 0, 100, 100] });
    mk(scr, { key: 'far', at: [400, 0, 100, 100] });
    mk(scr, { key: 'near', at: [200, 0, 100, 100] });
    F.focusNow('cur');
    await press(R);
    expect(active()).toBe('near');
  });

  it('◀ measures the orthogonal offset as |dy| on both sides (above and below are the same)', async () => {
    const scr = screen();
    mk(scr, { key: 'cur', at: [600, 100, 100, 100] });
    mk(scr, { key: 'up', at: [400, 70, 100, 100] });     // 200 + 3·30 = 290
    mk(scr, { key: 'down', at: [390, 130, 100, 100] });  // 210 + 3·30 = 300
    F.focusNow('cur');
    await press(L);
    expect(active()).toBe('up');
  });

  it('◀ the 3× penalty: 200 px left + 50 px down (350) beats 370 straight left, 60 px down (380) does not', async () => {
    let scr = screen();
    mk(scr, { key: 'cur', at: [500, 0, 100, 100] });
    mk(scr, { key: 'A', at: [130, 0, 100, 100] });
    mk(scr, { key: 'B', at: [300, 50, 100, 100] });
    F.focusNow('cur');
    await press(L);
    expect(active()).toBe('B');
    document.body.innerHTML = '';
    scr = screen();
    mk(scr, { key: 'cur', at: [500, 0, 100, 100] });
    mk(scr, { key: 'A', at: [130, 0, 100, 100] });
    mk(scr, { key: 'B', at: [300, 60, 100, 100] });
    F.focusNow('cur');
    await press(L);
    expect(active()).toBe('A');
  });

  it('▼ the sideways cost is 3× the x-gap: a gap of 30 px (90) loses to 80 px further straight down', async () => {
    const scr = screen();
    mk(scr, { key: 'cur', at: [0, 0, 100, 100] });
    mk(scr, { key: 'side', at: [130, 120, 100, 100] });    // dy 120, gap 30, |dx| 130/12 → 120 + 3·(30 + 10.83) = 242.5
    mk(scr, { key: 'below', at: [0, 230, 100, 100] });     // dy 230, gap 0 → 230
    F.focusNow('cur');
    await press(D);
    expect(active()).toBe('below');
  });

  it('▼ the x-gap is measured on both sides (left of the current rect too)', async () => {
    const scr = screen();
    mk(scr, { key: 'cur', at: [300, 0, 100, 100] });
    mk(scr, { key: 'left', at: [170, 120, 100, 100] });    // gap 30 → 120 + 3·(30 + 10.83)
    mk(scr, { key: 'below', at: [300, 230, 100, 100] });
    F.focusNow('cur');
    await press(D);
    expect(active()).toBe('below');
  });

  it('▼ between two overlapping candidates the centre term breaks the tie', async () => {
    const scr = screen();
    mk(scr, { key: 'cur', at: [100, 0, 100, 100] });
    mk(scr, { key: 'offset', at: [40, 200, 100, 100] });   // gap 0, |dx| 60 → 200 + 3·5 = 215
    mk(scr, { key: 'under', at: [100, 200, 100, 100] });   // gap 0, |dx| 0 → 200
    F.focusNow('cur');
    await press(D);
    expect(active()).toBe('under');
  });

  it('▲ picks the nearest row above', async () => {
    const scr = screen();
    mk(scr, { key: 'top', at: [0, 0, 100, 100] });
    mk(scr, { key: 'mid', at: [0, 120, 100, 100] });
    mk(scr, { key: 'cur', at: [0, 240, 100, 100] });
    F.focusNow('cur');
    await press(U);
    expect(active()).toBe('mid');
  });

  it('a candidate scoring exactly the same as the first one found does not replace it', async () => {
    const scr = screen();
    mk(scr, { key: 'cur', at: [200, 100, 100, 100] });
    mk(scr, { key: 'first', at: [400, 80, 100, 100] });    // 200 + 3·20
    mk(scr, { key: 'second', at: [400, 120, 100, 100] });  // 200 + 3·20
    F.focusNow('cur');
    await press(R);
    expect(active()).toBe('first');
  });

  it('▼ needs a centre more than 4 px lower (a thin row just under a thin one)', async () => {
    const scr = screen();
    mk(scr, { key: 'cur', at: [0, 0, 100, 2] });        // centre 1
    const o = mk(scr, { key: 'o', at: [200, 1, 100, 8] });   // centre 5: dy 4, overlap 1 of 2 (≤ 50 %)
    F.focusNow('cur');
    await press(D);
    expect(active()).toBe('cur');
    box(o, 200, 2, 100, 8);   // centre 6
    await press(D);
    expect(active()).toBe('o');
  });

  it('▲ needs a centre more than 4 px higher', async () => {
    const scr = screen();
    mk(scr, { key: 'cur', at: [0, 10, 100, 2] });        // centre 11
    const o = mk(scr, { key: 'o', at: [200, 3, 100, 8] });   // centre 7: dy −4, overlap 1
    F.focusNow('cur');
    await press(U);
    expect(active()).toBe('cur');
    box(o, 200, 2, 100, 8);   // centre 6
    await press(U);
    expect(active()).toBe('o');
  });

  it('▼ measures from the current element’s centre: a tall element never goes ▼ to a row above it', async () => {
    const scr = screen();
    mk(scr, { key: 'cur', at: [0, 300, 100, 300] });   // centre 450
    mk(scr, { key: 'above', at: [0, 200, 100, 90] });  // clears it, centre 245
    F.focusNow('cur');
    await press(D);
    expect(active()).toBe('cur');
    await press(U);
    expect(active()).toBe('above');
  });

  it('▲▼ allow 50 % overlap of the smaller height (a tall neighbour overlapping 60 px of 100 is the same row)', async () => {
    const scr = screen();
    mk(scr, { key: 'cur', at: [0, 0, 100, 100] });
    mk(scr, { key: 'tall', at: [200, 40, 100, 300] });   // overlap 60 > 50
    F.focusNow('cur');
    await press(D);
    expect(active()).toBe('cur');
  });

  it('the move scrolls the target into view (it goes through focusEl)', async () => {
    const scr = screen();
    const p = page(scr);
    mk(p, { key: 'cur', at: [0, 500, 100, 100] });
    mk(p, { key: 'next', at: [0, 1300, 100, 100] });
    F.focusNow('cur');
    await press(D);
    expect(active()).toBe('next');
    await clock.tick(1000);
    expect(p.scrollTop).toBe(550);
  });

  it('one move per frame: the rAF flush moves once and the 50 ms backstop then finds nothing queued', async () => {
    const scr = screen();
    for (let c = 0; c < 4; c++) mk(scr, { key: 't' + c, at: [c * 120, 0, 100, 100] });
    F.focusNow('t0');
    F.spatialMove(R);
    await clock.tick(16);   // the frame
    expect(active()).toBe('t1');
    await clock.tick(50);   // the backstop of the same press
    expect(active()).toBe('t1');
  });

  it('a press queued after the frame flush schedules its own frame', async () => {
    const scr = screen();
    for (let c = 0; c < 4; c++) mk(scr, { key: 't' + c, at: [c * 120, 0, 100, 100] });
    F.focusNow('t0');
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    F.spatialMove(R);
    F.spatialMove(R);   // same frame: no second request
    expect(raf).toHaveBeenCalledTimes(1);
    await clock.tick(16);
    F.spatialMove(R);
    expect(raf).toHaveBeenCalledTimes(2);
    await clock.tick(16);
    expect(active()).toBe('t2');
  });

  it('with focus lost and nothing focusable, a press does nothing (no throw)', async () => {
    screen();
    document.body.focus();
    await press(D);
    expect(document.activeElement).toBe(document.body);
  });
});

/* ------------------------------------------------------------------------ */

describe('lost focus: the remembered spot', () => {
  let clock;
  beforeEach(() => {
    clock = useClock();
  });

  it('a focusin on an element without a box keeps the previous spot', async () => {
    const scr = screen();
    mk(scr, { key: 'left', at: [0, 0, 100, 100] });
    const a = mk(scr, { key: 'a', at: [800, 0, 100, 100] });
    mk(scr, { key: 'right', at: [960, 0, 100, 100] });
    const z = mk(scr, { key: 'z', at: [0, 0, 0, 0] });
    a.focus();
    z.focus();   // no box: the spot stays a's
    z.remove();
    document.body.focus();
    expect(await F.recoverFocus()).toBe(true);
    expect(active()).toBe('a');
  });

  it('the spot is re-measured 450 ms after the focusin (the glide has moved the element)', async () => {
    const scr = screen();
    mk(scr, { key: 'top', at: [0, 0, 100, 100] });
    mk(scr, { key: 'bottom', at: [0, 800, 100, 100] });
    const a = mk(scr, { key: 'a', at: [0, 900, 100, 100] });   // focused low on the page…
    a.focus();
    box(a, 0, 100, 100, 100);   // …then the page glides it up
    await clock.tick(449);
    a.remove();
    expect(await F.recoverFocus()).toBe(true);
    expect(active()).toBe('bottom');   // not re-measured yet: still near 900
  });

  it('after 450 ms the re-measured spot is the one recovered to', async () => {
    const scr = screen();
    mk(scr, { key: 'top', at: [0, 0, 100, 100] });
    mk(scr, { key: 'bottom', at: [0, 800, 100, 100] });
    const a = mk(scr, { key: 'a', at: [0, 900, 100, 100] });
    a.focus();
    box(a, 0, 100, 100, 100);
    await clock.tick(450);
    a.remove();
    expect(await F.recoverFocus()).toBe(true);
    expect(active()).toBe('top');
  });

  it('the re-measure is dropped when focus moved on in the meantime', async () => {
    const scr = screen();
    mk(scr, { key: 'top', at: [0, 0, 100, 100] });
    const a = mk(scr, { key: 'a', at: [0, 900, 100, 100] });
    const b = mk(scr, { key: 'b', at: [0, 1000, 100, 100] });
    mk(scr, { key: 'bottom', at: [0, 1100, 100, 100] });
    a.focus();
    box(a, 0, 0, 100, 100);   // a would now measure at the top
    b.focus();                // but focus moved on: b's spot (1000) stands
    await clock.tick(500);
    b.remove();
    a.remove();
    expect(await F.recoverFocus()).toBe(true);
    expect(active()).toBe('bottom');
  });

  it('the re-measure is dropped for an element removed before it runs', async () => {
    const scr = screen();
    mk(scr, { key: 'top', at: [0, 0, 100, 100] });
    mk(scr, { key: 'bottom', at: [0, 800, 100, 100] });
    const a = mk(scr, { key: 'a', at: [0, 900, 100, 100] });
    a.focus();
    box(a, 0, 0, 100, 100);
    a.remove();
    await clock.tick(500);
    expect(await F.recoverFocus()).toBe(true);
    expect(active()).toBe('bottom');
  });

  it('a re-measure that finds no box keeps the spot', async () => {
    const scr = screen();
    mk(scr, { key: 'top', at: [0, 0, 100, 100] });
    mk(scr, { key: 'bottom', at: [0, 800, 100, 100] });
    const a = mk(scr, { key: 'a', at: [0, 900, 100, 100] });
    a.focus();
    box(a, 0, 0, 0, 0);
    await clock.tick(500);
    a.remove();
    expect(await F.recoverFocus()).toBe(true);
    expect(active()).toBe('bottom');
  });

  it('a press refreshes the spot from the live box, even when it finds nowhere to go', async () => {
    const scr = screen();
    mk(scr, { key: 'lower', at: [0, 800, 100, 100] });   // first in the DOM: the no-spot fallback
    const a = mk(scr, { key: 'a', at: [0, 900, 100, 100] });
    mk(scr, { key: 'upper', at: [0, 300, 100, 100] });
    a.focus();                    // spot: 900
    box(a, 0, 150, 100, 100);     // the page glided it up (before the 450 ms re-measure)
    F.spatialMove(37);            // ◀: nothing to the left — no move, no focusin
    await clock.tick(20);
    expect(active()).toBe('a');
    a.remove();
    expect(await F.recoverFocus()).toBe(true);
    expect(active()).toBe('upper');   // nearest to 150, not to the stale 900
  });

  it('a focusin on <body> is not a spot', async () => {
    const scr = screen();
    mk(scr, { key: 'left', at: [0, 0, 100, 100] });
    const a = mk(scr, { key: 'a', at: [800, 0, 100, 100] });
    mk(scr, { key: 'right', at: [900, 0, 100, 100] });
    a.focus();   // spot: a, at the right
    box(document.body, 0, 0, 200, 200);   // <body> has the whole screen as its box (here: the top-left)
    document.body.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    a.remove();
    expect(await F.recoverFocus()).toBe(true);
    expect(active()).toBe('right');   // still a's spot, not <body>'s centre
  });

  it('recoverFocus with nothing focusable is false and leaves <body>', async () => {
    const scr = screen();
    const a = mk(scr, { key: 'a', at: [0, 0, 100, 100] });
    a.focus();
    a.remove();
    expect(await F.recoverFocus()).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it('recoverFocus awaits tick(): an element that appears right after the call is a candidate', async () => {
    const scr = screen();
    document.body.focus();
    const p = F.recoverFocus();
    mk(scr, { key: 'new', at: [0, 0, 100, 100] });
    expect(await p).toBe(true);
    expect(active()).toBe('new');
  });

  it('nearest is by centre distance in both axes (a closer diagonal beats a farther straight one)', async () => {
    const scr = screen();
    const a = mk(scr, { key: 'a', at: [500, 500, 100, 100] });
    mk(scr, { key: 'straight', at: [500, 700, 100, 100] });   // 200
    mk(scr, { key: 'diag', at: [620, 620, 100, 100] });       // ≈ 170
    a.focus();
    a.remove();
    expect(await F.recoverFocus()).toBe(true);
    expect(active()).toBe('diag');
  });

  it('nearest compares centres: a big tile close by its edge loses to a small one close by its centre', async () => {
    const scr = screen();
    const a = mk(scr, { key: 'a', at: [100, 100, 100, 100] });   // centre 150,150
    mk(scr, { key: 'small', at: [0, 100, 100, 100] });          // centre 50,150: 100
    mk(scr, { key: 'wide', at: [160, 100, 300, 100] });         // edge 10 px off, centre 310,150: 160
    a.focus();
    a.remove();
    expect(await F.recoverFocus()).toBe(true);
    expect(active()).toBe('small');
  });

  it('nearest compares centres vertically too (heights differ)', async () => {
    const scr = screen();
    const a = mk(scr, { key: 'a', at: [100, 100, 100, 100] });   // centre 150,150
    mk(scr, { key: 'up', at: [100, -60, 100, 100] });           // centre y −10: 160
    mk(scr, { key: 'down', at: [100, 240, 100, 100] });         // centre y 290: 140
    mk(scr, { key: 'tall', at: [400, 0, 100, 300] });           // centre 450,150: 300
    a.focus();
    a.remove();
    expect(await F.recoverFocus()).toBe(true);
    expect(active()).toBe('down');
  });

  it('an element with a width but no height still has a spot', async () => {
    const scr = screen();
    mk(scr, { key: 'left', at: [0, 0, 100, 100] });
    mk(scr, { key: 'right', at: [900, 0, 100, 100] });
    const line = mk(scr, { key: 'line', at: [880, 50, 100, 0] });
    line.focus();
    line.remove();
    expect(await F.recoverFocus()).toBe(true);
    expect(active()).toBe('right');
  });

  it('focusLost: the <html> element counts as lost', () => {
    const scr = screen();
    const a = mk(scr, { key: 'a', at: [0, 0, 10, 10] });
    a.focus();
    expect(F.focusLost()).toBe(false);
    const spy = vi.spyOn(document, 'activeElement', 'get');
    spy.mockReturnValue(document.documentElement);
    expect(F.focusLost()).toBe(true);
    spy.mockReturnValue(null);
    expect(F.focusLost()).toBe(true);
    spy.mockReturnValue(document.createElement('div'));   // detached
    expect(F.focusLost()).toBe(true);
  });
});

describe('marqueeFocus: edges', () => {
  function tile(text, clip = 200) {
    const scr = screen();
    const t = mk(scr, { key: 'tile', at: [0, 0, 200, 300] });
    const cap = mk(t, { cls: 'cap' });
    const tt = mk(cap, { cls: 't' });
    const ti = document.createElement('span');
    ti.className = 'ti';
    tt.append(ti);
    Object.defineProperty(ti, 'scrollWidth', { value: text, configurable: true });
    Object.defineProperty(tt, 'clientWidth', { value: clip, configurable: true });
    const anim = { cancel: vi.fn(), onfinish: null };
    ti.animate = vi.fn(() => anim);
    return { t, tt, ti, anim };
  }

  it('5 px over scrolls (the cut-off is "4 or less")', () => {
    const { t, ti } = tile(205);
    F.marqueeFocus(t);
    expect(ti.animate).toHaveBeenCalledTimes(1);
    expect(ti.animate.mock.calls[0][0][2].transform).toBe('translateX(-17px)');
  });

  it('null, or something that is not an element, is a no-op that still stops the running one', () => {
    const a = tile(400);
    F.marqueeFocus(a.t);
    expect(() => F.marqueeFocus(null)).not.toThrow();
    expect(a.anim.cancel).toHaveBeenCalledTimes(1);
    F.marqueeFocus(a.t);
    expect(() => F.marqueeFocus({})).not.toThrow();
    expect(a.anim.cancel).toHaveBeenCalledTimes(2);
  });

  it('a too-short title on a new tile still stops the previous marquee', () => {
    const a = tile(400);
    F.marqueeFocus(a.t);
    const b = tile(150);
    F.marqueeFocus(b.t);
    expect(a.anim.cancel).toHaveBeenCalledTimes(1);
    expect(a.tt.classList.contains('mq')).toBe(false);
    expect(b.ti.animate).not.toHaveBeenCalled();
  });

  it('after clearMarquee, focusing the same tile again starts it over', () => {
    const a = tile(400);
    F.marqueeFocus(a.t);
    F.clearMarquee();
    F.clearMarquee();   // idempotent
    expect(a.anim.cancel).toHaveBeenCalledTimes(1);
    F.marqueeFocus(a.t);
    expect(a.ti.animate).toHaveBeenCalledTimes(2);
    expect(a.tt.classList.contains('mq')).toBe(true);
  });

  it('a finished marquee keeps the tile current: clearMarquee then has no animation left to cancel twice', () => {
    const a = tile(400);
    F.marqueeFocus(a.t);
    a.anim.onfinish();
    F.clearMarquee();
    expect(a.anim.cancel).toHaveBeenCalledTimes(1);
    expect(a.tt.classList.contains('mq')).toBe(false);
  });
});

describe('playerButtons', () => {
  it('a Skip chip / Up Next card that does not exist is simply not appended; their order is skip, then next', () => {
    const c = mk(document.body, { cls: 'controls' });
    mk(c, { cls: 'cbtn', key: 'c-play' });
    expect(keys(F.playerButtons())).toEqual(['c-play']);
    mk(document.body, { cls: 'focus', id: 'up-next', key: 'next' });
    mk(document.body, { cls: 'focus', id: 'skip-intro', key: 'skip' });
    expect(keys(F.playerButtons())).toEqual(['c-play', 'skip', 'next']);
  });

  it('only buttons inside .controls count', () => {
    mk(document.body, { cls: 'cbtn', key: 'stray' });
    const c = mk(document.body, { cls: 'controls' });
    mk(c, { cls: 'pillbtn', key: 'c-subs' });
    mk(c, { cls: 'other', key: 'x' });
    expect(keys(F.playerButtons())).toEqual(['c-subs']);
  });
});
