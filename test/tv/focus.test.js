/* focus.js (TV only — the phone build swaps it for focus-shim.js): the D-pad
 * engine. Geometry is stubbed per element (happy-dom does no layout), so every
 * test spells out the rects it measures.
 *
 * CLAUDE.md, "Input":
 * - "focusables() returns visible .focus/.opt elements — scoped to the active
 *   overlay (info > panel > video-layer during playback; #search while Search is
 *   up; an open .lvmenu; else the mounted .screen)".
 * - "spatialMove(keyCode) scores candidates by distance with a 3× orthogonal
 *   penalty (coalesced to one move per animation frame …), and horizontal moves
 *   additionally require ≥40% vertical overlap so ◀▶ stays on its row."
 * - "all focusing goes through focusEl(), which calls focus({ preventScroll:
 *   true })"; "Use focusKey(key) (which awaits tick()) when focusing right after
 *   a state change; focusNow(key) is the synchronous variant".
 * - "Focus must never end on <body>: focusFirst() only honours S.focusKey if
 *   that element is in focusables() (after playback it names a hidden OSD button)".
 * - "ensureVisible() scrolls … animated, via one shared rAF loop with an
 *   exponential ease-out, and a new target arriving mid-glide just bends the
 *   motion"; "jumpScroll(el, top) is the instant variant — it drops the
 *   element's glide in flight; a bare scrollTop = on a gliding scroller is
 *   overwritten by the glide's next frame".
 * - Marquee: "It runs 3 loops, then settles (MQ_LOOPS) into the ellipsis look";
 *   constant px/s linear travel, a hold at each end.
 *
 * happy-dom's checkVisibility() answers true even inside a [hidden] parent; the
 * engine relies on the `:not([hidden])` selector plus checkVisibility(), so an
 * element "without a box" is modelled by stubbing its checkVisibility. */
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
});

afterEach(() => {
  document.body.innerHTML = '';
});

/** stub an element's layout box */
function box(el, left, top, width, height) {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
  return el;
}

/** <tag class=cls data-focus=key> appended to parent, with a box when given */
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
const active = () => document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.focus : undefined;

/** a mounted browse screen */
function screen() {
  return mk(document.body, { cls: 'screen' });
}

/** the session-long overlays App.svelte keeps mounted */
function overlays() {
  const search = mk(document.body, { cls: '', id: 'search' });
  mk(search, { key: 'q2' });
  const layer = mk(document.body, { cls: '', id: 'video-layer', hidden: true });
  mk(layer, { key: 'c-play' });
  return { search, layer };
}

/* ------------------------------------------------------------------------ */

describe('focusables(): scoped to what is on top', () => {
  it('browse: only the mounted .screen — never the Search overlay or the video layer', () => {
    const scr = screen();
    mk(scr, { key: 'a' });
    mk(scr, { key: 'b' });
    overlays();
    mk(document.body, { key: 'outside' });
    expect(keys(F.focusables())).toEqual(['a', 'b']);
  });

  it('.focus and .opt count; [hidden], disabled and box-less elements do not', () => {
    const scr = screen();
    mk(scr, { key: 'a' });
    mk(scr, { cls: 'opt', key: 'o' });
    mk(scr, { key: 'hid', hidden: true });
    mk(scr, { tag: 'button', key: 'dis' }).disabled = true;
    mk(scr, { key: 'nobox' }).checkVisibility = () => false;
    mk(scr, { cls: 'plain', key: 'not-focusable' });
    expect(keys(F.focusables())).toEqual(['a', 'o']);
  });

  it('an open .lvmenu (library-bar / bell / avatar dropdown) is modal: only its rows', () => {
    const scr = screen();
    mk(scr, { key: 'tab-home' });
    mk(scr, { key: 'tile-1' });
    const menu = mk(scr, { cls: 'lvmenu' });
    mk(menu, { key: 'lv-sort-1' });
    mk(menu, { key: 'lv-sort-2' });
    expect(keys(F.focusables())).toEqual(['lv-sort-1', 'lv-sort-2']);
  });

  it('Search up: only #search (the faded screen behind it is out of reach)', () => {
    const scr = screen();
    mk(scr, { key: 'tile-1' });
    overlays();
    S.search = true;
    expect(keys(F.focusables())).toEqual(['q2']);
  });

  it('during playback: the video layer, even with Search flagged — the player wins', () => {
    const scr = screen();
    mk(scr, { key: 'd-play' });
    const { layer } = overlays();
    layer.hidden = false;
    S.search = true;
    S.screen = 'player';
    expect(keys(F.focusables())).toEqual(['c-play']);
  });

  it('during playback the error card, then the chapter list, then the audio/subtitle panel are modal, in that order', () => {
    screen();
    const { layer } = overlays();
    layer.hidden = false;
    const panel = mk(layer, { cls: '', id: 'player-menu' });
    mk(panel, { cls: 'opt', key: 'pm-a1' });
    S.screen = 'player';
    expect(keys(F.focusables())).toEqual(['pm-a1']);
    const chapters = mk(layer, { cls: '', id: 'chapter-menu' });
    mk(chapters, { cls: 'opt', key: 'ch-1' });
    expect(keys(F.focusables())).toEqual(['ch-1']);
    const err = mk(layer, { cls: '', id: 'play-error' });
    mk(err, { key: 'err-retry' });
    expect(keys(F.focusables())).toEqual(['err-retry']);
  });

  it('a [hidden] panel does not capture focus: the video layer again', () => {
    screen();
    const { layer } = overlays();
    layer.hidden = false;
    const panel = mk(layer, { cls: '', id: 'player-menu', hidden: true });
    // inside a display:none panel a row has no box (happy-dom can't tell: modelled)
    mk(panel, { cls: 'opt', key: 'pm-a1' }).checkVisibility = () => false;
    S.screen = 'player';
    expect(keys(F.focusables())).toEqual(['c-play']);
  });

  /* R-1: Home's hero .info in its outro stays in the DOM, inert, in front of the
   * incoming copy with the same buttons; Chromium won't focus anything in it. */
  it('an [inert] subtree (a Svelte block in its outro) is not a candidate (R-1)', () => {
    const scr = screen();
    const old = document.createElement('div');
    old.setAttribute('inert', '');
    scr.append(old);
    mk(old, { key: 'hero-resume' });
    mk(old, { cls: 'opt', key: 'old-opt' });
    mk(scr, { key: 'hero-resume' });
    mk(scr, { key: 'tile' });
    const all = F.focusables();
    expect(keys(all)).toEqual(['hero-resume', 'tile']);
    expect(all.every((e) => !e.closest('[inert]'))).toBe(true);
  });

  it('no screen mounted (boot): the whole document', () => {
    mk(document.body, { key: 'x' });
    expect(keys(F.focusables())).toEqual(['x']);
  });
});

/* ------------------------------------------------------------------------ */

describe('focusEl / focusNow / focusKey / focusFirst', () => {
  it('focusEl focuses with preventScroll: true (the glide, not the engine, scrolls)', () => {
    const scr = screen();
    const a = mk(scr, { key: 'a', at: [0, 0, 100, 100] });
    const spy = vi.spyOn(a, 'focus');
    expect(F.focusEl(a)).toBe(true);
    expect(spy).toHaveBeenCalledWith({ preventScroll: true });
    expect(active()).toBe('a');
  });

  it('focusEl(null) is false; while Search is up an element outside #search is refused', () => {
    const scr = screen();
    const a = mk(scr, { key: 'a', at: [0, 0, 100, 100] });
    const { search } = overlays();
    expect(F.focusEl(null)).toBe(false);
    S.search = true;
    expect(F.focusEl(a)).toBe(false);
    expect(document.activeElement).not.toBe(a);
    const q = search.querySelector('[data-focus="q2"]');
    box(q, 0, 0, 10, 10);
    expect(F.focusEl(q)).toBe(true);
  });

  it('focusNow is synchronous; an unknown key is false', () => {
    const scr = screen();
    mk(scr, { key: 'a', at: [0, 0, 100, 100] });
    expect(F.focusNow('a')).toBe(true);
    expect(active()).toBe('a');
    expect(F.focusNow('nope')).toBe(false);
  });

  it('focusKey awaits tick(): an element rendered by the state change it follows is found', async () => {
    const scr = screen();
    const p = F.focusKey('late');
    mk(scr, { key: 'late', at: [0, 0, 100, 100] });   // Svelte flushes after the caller's synchronous code
    expect(await p).toBe(true);
    expect(active()).toBe('late');
  });

  /* F-009: Search's result cards and Home's Trending rails are both LookupTiles
   * keyed lk-<type>-<id>, and Home stays mounted (faded) behind Search, earlier
   * in the DOM. A key must resolve inside the active scope first. */
  it('byKey/focusKey: Search up, a key that also exists on the faded screen behind it resolves inside #search (F-009)', async () => {
    const scr = screen();
    const home = mk(scr, { key: 'lk-movie-1', at: [0, 600, 100, 100] });   // Home's Trending tile, first in the DOM
    const { search } = overlays();
    const res = mk(search, { key: 'lk-movie-1', at: [0, 300, 100, 100] });  // the Search result
    S.search = true;
    expect(F.byKey('lk-movie-1')).toBe(res);
    expect(await F.focusKey('lk-movie-1')).toBe(true);   // Done → the first result, not the bar
    expect(document.activeElement).toBe(res);
    document.body.focus();
    expect(F.focusNow('lk-movie-1')).toBe(true);
    expect(document.activeElement).toBe(res);
    // the browse screen is the scope again once Search is down: Home's tile wins
    S.search = false;
    expect(F.byKey('lk-movie-1')).toBe(home);
  });

  it('focusFirst honours an S.focusKey that collides with a key outside the scope (F-009)', async () => {
    const scr = screen();
    mk(scr, { key: 'a', at: [0, 0, 100, 100] });
    const { search } = overlays();
    mk(search, { key: 'lk-tv-2', at: [0, 300, 100, 100] });
    const mine = mk(scr, { key: 'lk-tv-2', at: [0, 600, 100, 100] });
    // the Search copy comes first in the DOM here; the screen's is the one in scope
    scr.before(search);
    S.focusKey = 'lk-tv-2';
    await F.focusFirst();
    expect(document.activeElement).toBe(mine);
  });

  it('byKey falls back to the whole document for a key outside the scope (no collision: unchanged)', () => {
    const scr = screen();
    mk(scr, { key: 'a', at: [0, 0, 100, 100] });
    const { layer } = overlays();
    const play = layer.querySelector('[data-focus="c-play"]');
    expect(F.byKey('c-play')).toBe(play);              // browse scope, element in the video layer
    S.search = true;
    expect(F.byKey('a')).toBe(scr.querySelector('[data-focus="a"]'));   // Search up, element on the screen
    expect(F.byKey('nope')).toBe(null);
  });

  /* R-2: "does this key exist here?" must not borrow byKey()'s document fallback —
   * Search's Back-from-detail effect and Keys' hideSearch() pick their fallback
   * key ('q2', the tab) from it, and a copy outside the scope passed the check
   * and was then refused by focusEl(), leaving focus on <body>. */
  it('hasKey: only a live element inside the active scope counts — no document fallback (R-2)', () => {
    const scr = screen();
    const { search } = overlays();
    mk(scr, { key: 'lk-movie-1' });                     // Home's Trending tile behind Search
    S.search = true;
    expect(F.byKey('lk-movie-1')).toBe(scr.querySelector('[data-focus="lk-movie-1"]')); // byKey still falls back
    expect(F.hasKey('lk-movie-1')).toBe(false);           // …but it is not "here"
    expect(F.hasKey('q2')).toBe(true);
    mk(search, { key: 'lk-movie-2' });
    expect(F.hasKey('lk-movie-2')).toBe(true);
    // Search closing: the browse scope again; a key only in #search is not there
    S.search = false;
    expect(F.hasKey('lk-movie-2')).toBe(false);
    expect(F.hasKey('lk-movie-1')).toBe(true);
    // an inert copy (a block in its outro) doesn't count either
    const old = document.createElement('div');
    old.setAttribute('inert', '');
    scr.append(old);
    mk(old, { key: 'hero-resume' });
    expect(F.hasKey('hero-resume')).toBe(false);
    expect(F.hasKey('')).toBe(false);
  });

  /* F-006: a Svelte block in its outro (Home's hero .info, transition:fade) stays
   * in the DOM, inert, before the incoming copy — same keys. focus() on the inert
   * copy is a no-op, so a key must resolve to the live one. */
  it('byKey/focusKey skip a copy inside an [inert] outro and find the live one (F-006)', async () => {
    const scr = screen();
    const old = document.createElement('div');
    old.inert = true;
    old.setAttribute('inert', '');
    scr.append(old);
    mk(old, { key: 'hero-resume', at: [0, 0, 100, 100] });
    const live = mk(scr, { key: 'hero-resume', at: [0, 0, 100, 100] });
    expect(F.byKey('hero-resume')).toBe(live);
    expect(await F.focusKey('hero-resume')).toBe(true);
    expect(document.activeElement).toBe(live);
    // only the inert copy left: nothing to focus, so callers fall through to their next key
    live.remove();
    expect(F.byKey('hero-resume')).toBe(null);
    expect(await F.focusKey('hero-resume')).toBe(false);
  });

  it('focusFirst honours S.focusKey when it is focusable', async () => {
    const scr = screen();
    mk(scr, { key: 'a', at: [0, 0, 100, 100] });
    mk(scr, { key: 'b', at: [200, 0, 100, 100] });
    S.focusKey = 'b';
    await F.focusFirst();
    expect(active()).toBe('b');
  });

  it('focusFirst ignores an S.focusKey that names a hidden OSD button (after playback) → the first focusable', async () => {
    const scr = screen();
    mk(scr, { key: 'a', at: [0, 0, 100, 100] });
    overlays();   // #video-layer [hidden] holds c-play
    S.focusKey = 'c-play';
    await F.focusFirst();
    expect(active()).toBe('a');
  });

  it('focusFirst with nothing focusable falls back to <body> rather than throwing', async () => {
    screen();
    await F.focusFirst();
    expect(document.activeElement).toBe(document.body);
  });

  it('focusLost: <body>, or a detached element', () => {
    const scr = screen();
    const a = mk(scr, { key: 'a', at: [0, 0, 100, 100] });
    document.body.focus();
    expect(F.focusLost()).toBe(true);
    a.focus();
    expect(F.focusLost()).toBe(false);
    a.remove();
    // happy-dom moves focus off a removed element; either way it counts as lost
    expect(F.focusLost()).toBe(true);
  });

  it('recoverFocus puts a lost focus on the focusable nearest to where it was', async () => {
    useClock();
    const scr = screen();
    mk(scr, { key: 'far', at: [0, 0, 100, 100] });
    const gone = mk(scr, { key: 'gone', at: [600, 400, 100, 100] });
    mk(scr, { key: 'near', at: [760, 400, 100, 100] });
    gone.focus();   // focusin remembers its rect
    gone.remove();
    expect(await F.recoverFocus()).toBe(true);
    expect(active()).toBe('near');
    expect(await F.recoverFocus()).toBe(false);   // not lost: no-op
  });
});

/* ------------------------------------------------------------------------ */

describe('spatialMove: geometric D-pad', () => {
  const L = 37, U = 38, R = 39, D = 40;
  let clock;
  beforeEach(() => {
    clock = useClock();
  });
  async function press(key) {
    F.spatialMove(key);
    await clock.tick(60);
  }

  /** a 3×3 grid of 100×100 tiles, 20 px gaps; tile r,c is key `t<r><c>` */
  function grid() {
    const scr = screen();
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) mk(scr, { key: 't' + r + c, at: [c * 120, r * 120, 100, 100] });
    return scr;
  }

  it('◀▶▲▼ move to the neighbour in that direction', async () => {
    grid();
    F.focusNow('t11');
    await press(R);
    expect(active()).toBe('t12');
    await press(D);
    expect(active()).toBe('t22');
    await press(L);
    expect(active()).toBe('t21');
    await press(U);
    expect(active()).toBe('t11');
  });

  it('▶ at the end of a row stays put — the next row has no vertical overlap', async () => {
    grid();
    F.focusNow('t02');
    await press(R);
    expect(active()).toBe('t02');
  });

  it('▼ on the last row is a no-op (nothing clears the current rect vertically)', async () => {
    grid();
    F.focusNow('t21');
    await press(D);
    expect(active()).toBe('t21');
  });

  it('◀▶ need ≥ 40 % vertical overlap: 40 px of a 100 px tile qualifies, 39 px does not', async () => {
    const scr = screen();
    mk(scr, { key: 'cur', at: [0, 0, 100, 100] });
    const o = mk(scr, { key: 'o', at: [200, 61, 100, 100] });   // overlap 39
    F.focusNow('cur');
    await press(R);
    expect(active()).toBe('cur');
    box(o, 200, 60, 100, 100);   // overlap 40
    await press(R);
    expect(active()).toBe('o');
  });

  it('a centre less than 5 px to the side is not "to the side"', async () => {
    const scr = screen();
    mk(scr, { key: 'cur', at: [0, 0, 100, 100] });
    const o = mk(scr, { key: 'o', at: [4, 0, 100, 100] });
    F.focusNow('cur');
    await press(R);
    expect(active()).toBe('cur');
    box(o, 5, 0, 100, 100);
    await press(R);
    expect(active()).toBe('o');
  });

  it('the orthogonal offset costs 3× the distance (both sides of the 3× line)', async () => {
    // B: 200 px right, 50 px lower → 200 + 3·50 = 350 beats A straight right at 370 (would lose at 4×)
    let scr = screen();
    mk(scr, { key: 'cur', at: [0, 0, 100, 100] });
    mk(scr, { key: 'A', at: [370, 0, 100, 100] });
    mk(scr, { key: 'B', at: [200, 50, 100, 100] });
    F.focusNow('cur');
    await press(R);
    expect(active()).toBe('B');
    // B 60 px lower → 200 + 180 = 380 loses to A at 370 (would win at 2×)
    document.body.innerHTML = '';
    scr = screen();
    mk(scr, { key: 'cur', at: [0, 0, 100, 100] });
    mk(scr, { key: 'A', at: [370, 0, 100, 100] });
    mk(scr, { key: 'B', at: [200, 60, 100, 100] });
    F.focusNow('cur');
    await press(R);
    expect(active()).toBe('A');
  });

  it('▼ to a wide tile overlapping below beats a tile two rails down straight under (x-gap, not centre distance)', async () => {
    const scr = screen();
    mk(scr, { key: 'poster', at: [0, 0, 100, 100] });
    mk(scr, { key: 'still', at: [0, 200, 420, 100] });    // Next Up's wide still, centre 160 px off
    mk(scr, { key: 'two-down', at: [0, 400, 100, 100] });
    F.focusNow('poster');
    await press(D);
    expect(active()).toBe('still');
  });

  it('▼ never lands on a sibling of the same row, even one scaled a few px lower (> 50 % overlap)', async () => {
    const scr = screen();
    mk(scr, { key: 'cur', at: [0, 0, 100, 100] });
    mk(scr, { key: 'sib', at: [120, 10, 100, 100] });
    F.focusNow('cur');
    await press(D);
    expect(active()).toBe('cur');
  });

  it('▲ onto the hero during its crossfade lands on the live button, not the inert outro copy at the same spot (R-1)', async () => {
    const scr = screen();
    const old = document.createElement('div');
    old.setAttribute('inert', '');
    scr.append(old);                                                   // earlier in the DOM, as Svelte leaves it
    mk(old, { key: 'hero-resume', at: [0, 0, 200, 60] });
    const live = mk(scr, { key: 'hero-resume', at: [0, 0, 200, 60] });
    mk(scr, { key: 'tile', at: [0, 200, 200, 100] });
    F.focusNow('tile');
    await press(U);
    expect(document.activeElement).toBe(live);
  });

  it('auto-repeat is coalesced: two ▶ in one frame move once', async () => {
    grid();
    F.focusNow('t00');
    F.spatialMove(R);
    F.spatialMove(R);
    await clock.tick(60);
    expect(active()).toBe('t01');
  });

  it('the latest direction of a frame wins', async () => {
    grid();
    F.focusNow('t11');
    F.spatialMove(R);
    F.spatialMove(D);
    await clock.tick(60);
    expect(active()).toBe('t21');
  });

  it('a starved rAF (video plane up) still moves via the 50 ms backstop', async () => {
    grid();
    F.focusNow('t00');
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    F.spatialMove(R);
    await clock.tick(49);
    expect(active()).toBe('t00');
    await clock.tick(1);
    expect(active()).toBe('t01');
    F.spatialMove(R);   // and the queue is not wedged
    await clock.tick(50);
    expect(active()).toBe('t02');
  });

  it('with focus lost, a press recovers to the tile nearest where focus was instead of moving from <body>', async () => {
    grid();
    const t = document.querySelector('[data-focus="t22"]');
    F.focusNow('t21');
    F.focusNow('t22');
    t.remove();
    await press(L);
    expect(active()).toBe('t12');   // nearest to t22's spot (t21 and t12 tie; t12 comes first in DOM order)
  });

  it('with focus lost and no remembered spot (fresh boot), the first focusable', async () => {
    grid();
    document.body.focus();
    await press(D);
    expect(active()).toBe('t00');
  });
});

/* ------------------------------------------------------------------------ */

describe('scrolling: the shared glide, jumpScroll, scrollElTo', () => {
  let clock;
  beforeEach(() => {
    clock = useClock();
  });

  /** a vertical .page scroller (viewport 0..1000) holding `el` at `top` */
  function page(contentH = 5000) {
    const scr = screen();
    const p = mk(scr, { cls: 'page', at: [0, 0, 1920, 1000] });
    Object.defineProperty(p, 'scrollHeight', { value: contentH, configurable: true });
    Object.defineProperty(p, 'clientHeight', { value: 1000, configurable: true });
    return p;
  }

  it('ensureVisible glides a .page toward the target (ease-out), and lands exactly', async () => {
    const p = page();
    const el = mk(p, { key: 'row9', at: [0, 1300, 200, 300] });   // bottom 1600 > 1000 − 150
    F.focusNow('row9');
    expect(p.scrollTop).toBe(0);   // nothing instant
    await clock.tick(16);
    const first = p.scrollTop;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(300);
    await clock.tick(16);
    expect(p.scrollTop - first).toBeLessThan(first);   // decelerating
    await clock.tick(1000);
    expect(p.scrollTop).toBe(750);   // 1600 − (1000 − 150)
    expect(el.isConnected).toBe(true);
  });

  // CLAUDE.md / focus.js: restoring focus after a remount (Back to Home or a grid)
  // jumps the scrollers instead of gliding from 0 — the glide painted and fetched
  // posters for every row it passed. Armed for the rest of the current task only.
  it('focusKeyInstant jumps the scroller to the target; the next task glides again', async () => {
    const p = page();
    mk(p, { key: 'row9', at: [0, 1300, 200, 300] });
    const focused = F.focusKeyInstant('row9');
    await clock.flush();
    expect(await focused).toBe(true);
    expect(document.activeElement.dataset.focus).toBe('row9');
    expect(p.scrollTop).toBe(750);   // at once: 1600 − (1000 − 150)
    await clock.tick(1);   // the arming ends with the task
    const el = mk(p, { key: 'row20', at: [0, 2300 - 750, 200, 300] });
    F.focusNow('row20');
    expect(p.scrollTop).toBe(750);   // gliding again: nothing instant
    await clock.tick(1000);
    expect(p.scrollTop).toBeGreaterThan(750);
    expect(el.isConnected).toBe(true);
  });

  it('a .strip scrolls sideways with a 90 px margin', async () => {
    const scr = screen();
    const s = mk(scr, { cls: 'strip', at: [0, 0, 1000, 300] });
    Object.defineProperty(s, 'scrollWidth', { value: 4000, configurable: true });
    Object.defineProperty(s, 'clientWidth', { value: 1000, configurable: true });
    mk(s, { key: 'tile', at: [1000, 0, 200, 300] });
    F.focusNow('tile');
    await clock.tick(1000);
    expect(s.scrollLeft).toBe(290);   // 1200 − (1000 − 90)
  });

  it('a new target mid-glide bends the motion instead of restarting it from the old start', async () => {
    const p = page();
    mk(p, { key: 'a', at: [0, 1300, 200, 300] });
    F.focusNow('a');
    await clock.tick(48);
    const mid = p.scrollTop;
    expect(mid).toBeGreaterThan(0);
    // the next row, measured against the live offset
    mk(p, { key: 'b', at: [0, 1600 - mid, 200, 300] });
    F.focusNow('b');
    await clock.tick(16);
    expect(p.scrollTop).toBeGreaterThan(mid);   // continues from where it was
    await clock.tick(1000);
    expect(p.scrollTop).toBeCloseTo(1050, 5);   // b's own target (content y 1600 + 300 − 850), not a's
  });

  it('a .qrows list (the player dropdown) keeps a 70 px margin, both directions', async () => {
    const scr = screen();
    const q = mk(scr, { cls: 'qrows', at: [0, 100, 600, 500] });
    Object.defineProperty(q, 'scrollHeight', { value: 3000, configurable: true });
    Object.defineProperty(q, 'clientHeight', { value: 500, configurable: true });
    const below = mk(q, { key: 'below', at: [0, 600, 600, 60] });   // bottom 660 > 600 − 70
    F.focusNow('below');
    await clock.tick(1000);
    expect(q.scrollTop).toBe(130);
    box(below, 0, 120, 600, 60);   // now above 100 + 70
    F.focusNow('below');
    await clock.tick(1000);
    expect(q.scrollTop).toBe(80);
  });

  it('the glide never scrolls past the content', async () => {
    const p = page(1200);   // max 200
    mk(p, { key: 'a', at: [0, 1300, 200, 300] });
    F.focusNow('a');
    await clock.tick(1000);
    expect(p.scrollTop).toBe(200);
  });

  it('jumpScroll drops the glide in flight; a bare scrollTop write is overwritten by it', async () => {
    const p = page();
    mk(p, { key: 'a', at: [0, 1300, 200, 300] });
    F.focusNow('a');
    await clock.tick(32);
    p.scrollTop = 0;   // the bug openChart() had
    await clock.tick(16);
    expect(p.scrollTop).toBeGreaterThan(0);

    F.jumpScroll(p, 0);
    expect(p.scrollTop).toBe(0);
    await clock.tick(1000);
    expect(p.scrollTop).toBe(0);
  });

  it("jumpScroll on the x axis leaves the y glide running", async () => {
    const p = page();
    mk(p, { key: 'a', at: [0, 1300, 200, 300] });
    F.focusNow('a');
    F.jumpScroll(p, 10, 'x');
    expect(p.scrollLeft).toBe(10);
    await clock.tick(1000);
    expect(p.scrollTop).toBe(750);
  });

  it('scrollElTo the position the scroller already sits at still cancels a glide of the same turn', async () => {
    const p = page();
    mk(p, { key: 'a', at: [0, 1300, 200, 300] });
    F.focusNow('a');
    F.scrollElTo(p, 0);
    await clock.tick(1000);
    expect(p.scrollTop).toBe(0);
  });

  it('scrollElTo / scrollElBy glide (clamped to the content)', async () => {
    const p = page();
    F.scrollElTo(p, 400);
    await clock.tick(1000);
    expect(p.scrollTop).toBe(400);
    F.scrollElBy(p, -100);
    await clock.tick(1000);
    expect(p.scrollTop).toBe(300);
    F.scrollElTo(p, 99999);
    await clock.tick(1000);
    expect(p.scrollTop).toBe(4000);
  });

  it('a glide also advances with rAF starved (the 32 ms timer backstop)', async () => {
    const p = page();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    F.scrollElTo(p, 400);
    await clock.tick(2000);
    expect(p.scrollTop).toBe(400);
  });

  it('focusKeyInstant: a return to a remembered spot jumps the scroller, no glide', async () => {
    const p = page();
    mk(p, { key: 'a', at: [0, 1300, 200, 300] });
    await F.focusKeyInstant('a');
    expect(p.scrollTop).toBe(750);
  });

  it('a scroller removed mid-glide is dropped (no writes to a detached node)', async () => {
    const p = page();
    mk(p, { key: 'a', at: [0, 1300, 200, 300] });
    F.focusNow('a');
    await clock.tick(16);
    const at = p.scrollTop;
    p.remove();
    await clock.tick(1000);
    expect(p.scrollTop).toBe(at);
  });
});

/* ------------------------------------------------------------------------ */

describe('marqueeFocus: clipped titles scroll 3 loops, then settle', () => {
  /** a tile whose caption .t is `clip` px wide and its .ti text `text` px */
  function tile(text, clip = 200, capCls = 'cap') {
    const scr = screen();
    const t = mk(scr, { key: 'tile', at: [0, 0, 200, 300] });
    const cap = mk(t, { cls: capCls });
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

  it('a title 70 px too long: hold 0.5 s, travel at 70 px/s, hold 1.4 s, 3 iterations, linear', () => {
    const { t, tt, ti } = tile(270);
    F.marqueeFocus(t);
    expect(ti.animate).toHaveBeenCalledTimes(1);
    const [frames, opts] = ti.animate.mock.calls[0];
    const travel = (70 + 12) / 70;
    const total = 0.5 + travel + 1.4;
    expect(opts).toEqual({ duration: total * 1000, iterations: 3, easing: 'linear' });
    expect(frames.map((f) => f.offset)).toEqual([0, 0.5 / total, (0.5 + travel) / total, 1]);
    expect(frames.map((f) => f.transform)).toEqual(['translateX(0)', 'translateX(0)', 'translateX(-82px)', 'translateX(-82px)']);
    expect(tt.classList.contains('mq')).toBe(true);
  });

  it('settles into the ellipsis look when the loops finish, and a re-fired focusin does not restart it', () => {
    const { t, tt, ti, anim } = tile(400);
    F.marqueeFocus(t);
    anim.onfinish();
    expect(tt.classList.contains('mq')).toBe(false);
    F.marqueeFocus(t);
    expect(ti.animate).toHaveBeenCalledTimes(1);
  });

  it('a library-grid caption (.cap-on .t) gets the same treatment', () => {
    const { t, ti } = tile(400, 200, 'cap-on');
    F.marqueeFocus(t);
    expect(ti.animate).toHaveBeenCalledTimes(1);
  });

  it('4 px over or less: no marquee', () => {
    const { t, tt, ti } = tile(204);
    F.marqueeFocus(t);
    expect(ti.animate).not.toHaveBeenCalled();
    expect(tt.classList.contains('mq')).toBe(false);
  });

  it('moving to another tile cancels the running one; clearMarquee stops it', () => {
    const a = tile(400);
    F.marqueeFocus(a.t);
    const other = document.createElement('div');
    F.marqueeFocus(other);   // no caption
    expect(a.anim.cancel).toHaveBeenCalled();
    expect(a.tt.classList.contains('mq')).toBe(false);
    F.marqueeFocus(a.t);
    F.clearMarquee();
    expect(a.anim.cancel).toHaveBeenCalledTimes(2);
  });

  it('a caption without the .ti span cannot scroll (the span is required)', () => {
    const scr = screen();
    const t = mk(scr, { key: 'x' });
    const cap = mk(t, { cls: 'cap' });
    mk(cap, { cls: 't' });
    expect(() => F.marqueeFocus(t)).not.toThrow();
  });
});

describe('playerButtons: the OSD transport row', () => {
  it('left to right, with a visible Skip chip and Up Next card appended', () => {
    const c = mk(document.body, { cls: 'controls' });
    mk(c, { cls: 'cbtn', key: 'c-back' });
    mk(c, { cls: 'cbtn', key: 'c-play' });
    mk(c, { cls: 'pillbtn', key: 'c-audio' });
    const skip = mk(document.body, { cls: 'focus', id: 'skip-intro', key: 'skip' });
    mk(document.body, { cls: 'focus', id: 'up-next', key: 'next', hidden: true });
    expect(keys(F.playerButtons())).toEqual(['c-back', 'c-play', 'c-audio', 'skip']);
    skip.hidden = true;
    expect(keys(F.playerButtons())).toEqual(['c-back', 'c-play', 'c-audio']);
  });
});
