/* The desktop player's keyboard and wheel helpers (UX round, player lane):
 *
 *   shortcutRows()  the "?" list names only keys that do something now — no
 *                   "S Skip intro" or "Shift+N Next episode" over a trailer
 *   wheelSteps()    the volume follows the distance scrolled: one step per
 *                   mouse notch, one per WHEEL_PX of trackpad travel (counting
 *                   events, a short swipe went 0.85 → 0.35)
 *   focusnav.js     where focus goes in popovers, the "?" list, and back on the
 *                   page when the player closes */
import { describe, it, expect, afterEach } from 'vitest';
import { SHORTCUTS, shortcutRows, wheelSteps, WHEEL_PX } from '../../web/src/player/shortcuts.js';
import { choiceIn, panelStep, trapTab, canRefocus, routeAction } from '../../web/src/player/focusnav.js';

const keysOf = (rows) => rows.map(([k]) => k[0]);

describe('shortcutRows', () => {
  it('everything by default, in the list’s order', () => {
    expect(shortcutRows()).toEqual(SHORTCUTS);
  });

  it('drops S without a skip, Shift+N without a next episode, C without subtitles, P without PiP', () => {
    const k = keysOf(shortcutRows({ skip: false, next: false, subs: false, pip: false }));
    expect(k).not.toContain('S');
    expect(k).not.toContain('Shift+N');
    expect(k).not.toContain('C');
    expect(k).not.toContain('P');
    expect(k).toEqual(['Space', '←', '→', '0–9', '↑', 'M', 'F', '?', 'Esc']);
  });

  it('Esc says what it closes, in order', () => {
    expect(SHORTCUTS.at(-1)).toEqual([['Esc'], 'Close a panel or Up Next, then the player']);
  });
});

describe('wheelSteps', () => {
  /** feed a series of deltas, return the total steps */
  const run = (deltas, mode = 0) => {
    let acc = 0;
    let steps = 0;
    for (const d of deltas) {
      const r = wheelSteps(acc, d, mode);
      acc = r.acc;
      steps += r.steps;
    }
    return { steps, acc };
  };

  it('a mouse notch is one step: Chrome’s 100 px, Firefox’s ~48 px or 3 lines; down is quieter', () => {
    expect(run([100]).steps).toBe(-1);
    expect(run([-100]).steps).toBe(1);
    expect(run([100, 100, 100, 100]).steps).toBe(-4);
    expect(run([48, 48, 48]).steps).toBe(-3);
    expect(run([3], 1).steps).toBe(-1);
    expect(run([1], 2).steps).toBe(-1);
  });

  it('a trackpad’s small deltas add up: one step per WHEEL_PX, not per event', () => {
    expect(WHEEL_PX).toBe(40);
    expect(run(Array(10).fill(4)).steps).toBe(-1); // a short 40 px swipe: 5 %, not 50 %
    expect(run(Array(9).fill(4))).toEqual({ steps: 0, acc: 36 });
    expect(run(Array(100).fill(-4)).steps).toBe(10);
  });

  it('turning round starts over (no carried distance the other way)', () => {
    expect(run([30, -30]).acc).toBe(-30);
    expect(run([30, -30, -10]).steps).toBe(1);
  });

  it('nothing to do for no movement or garbage', () => {
    expect(wheelSteps(12, 0)).toEqual({ steps: 0, acc: 12 });
    expect(wheelSteps(12, NaN)).toEqual({ steps: 0, acc: 12 });
  });
});

/* ------------------------------------------------------------------------ */

/* happy-dom lays nothing out: "rendered" (boxes to draw) is stubbed per element */
function shown(...els) {
  for (const el of els) el.getClientRects = () => /** @type {any} */ ([{}]);
}

function trackPanel() {
  document.body.innerHTML = `
    <div class="panel" role="dialog">
      <div class="panel__head"><button class="closebtn" id="x">×</button></div>
      <div class="panel__cols">
        <div class="vr-colstack">
          <div class="panel__col" role="radiogroup" aria-label="Audio">
            <button class="option" role="radio" aria-checked="false" id="a1">English</button>
            <button class="option option--selected" role="radio" aria-checked="true" id="a2">German</button>
          </div>
          <div class="panel__col vr-quality" role="radiogroup" aria-label="Streaming quality">
            <button class="option option--selected" role="radio" aria-checked="true" id="q1">Original</button>
            <button class="option" role="radio" aria-checked="false" id="q2">8 Mbit/s</button>
          </div>
        </div>
        <div class="panel__col" role="radiogroup" aria-label="Subtitles">
          <button class="option" role="radio" aria-checked="false" id="s0">Off</button>
          <button class="option option--selected" role="radio" aria-checked="true" id="s1">English</button>
          <button class="option" role="radio" aria-checked="false" id="s2">French</button>
          <div class="vr-adjust"><button class="closebtn" id="smaller">−</button><button class="closebtn" id="bigger">+</button></div>
        </div>
      </div>
    </div>`;
  return document.querySelector('.panel');
}
const $ = (id) => document.getElementById(id);

afterEach(() => {
  document.body.innerHTML = '';
});

describe('choiceIn', () => {
  it('the checked option of the column asked for, else of the first column', () => {
    const p = trackPanel();
    expect(choiceIn(p, 'Subtitles')).toBe($('s1'));
    expect(choiceIn(p, 'Streaming quality')).toBe($('q1'));
    expect(choiceIn(p)).toBe($('a2'));
    expect(choiceIn(p, 'Nope')).toBe($('a2'));
  });

  it('the current chapter, else the first option, else anything focusable; no panel: null', () => {
    document.body.innerHTML = '<div class="panel"><button class="option" id="c1"></button><button class="option" aria-current="true" id="c2"></button></div>';
    expect(choiceIn(document.querySelector('.panel'))).toBe($('c2'));
    document.body.innerHTML = '<div class="panel"><button class="option" id="c1"></button></div>';
    expect(choiceIn(document.querySelector('.panel'))).toBe($('c1'));
    document.body.innerHTML = '<div class="panel"><button class="closebtn" id="x"></button></div>';
    expect(choiceIn(document.querySelector('.panel'))).toBe($('x'));
    expect(choiceIn(null)).toBe(null);
  });
});

describe('panelStep', () => {
  it('↑ ↓ within the column, stopping at its ends; the size buttons are part of the subtitles column', () => {
    const p = trackPanel();
    expect(panelStep(p, $('s1'), 'ArrowDown')).toBe($('s2'));
    expect(panelStep(p, $('s2'), 'ArrowDown')).toBe($('smaller'));
    expect(panelStep(p, $('bigger'), 'ArrowDown')).toBe($('bigger'));
    expect(panelStep(p, $('s0'), 'ArrowUp')).toBe($('s0'));
    expect(panelStep(p, $('a1'), 'ArrowDown')).toBe($('a2'));
    expect(panelStep(p, $('a2'), 'ArrowDown')).toBe($('a2'));
  });

  it('Home / End: the column’s first and last', () => {
    const p = trackPanel();
    expect(panelStep(p, $('s2'), 'Home')).toBe($('s0'));
    expect(panelStep(p, $('s0'), 'End')).toBe($('bigger'));
  });

  it('← → go to the neighbouring column’s selection (Audio · Quality · Subtitles); none past the ends', () => {
    const p = trackPanel();
    expect(panelStep(p, $('a1'), 'ArrowRight')).toBe($('q1'));
    expect(panelStep(p, $('q2'), 'ArrowRight')).toBe($('s1'));
    expect(panelStep(p, $('s0'), 'ArrowLeft')).toBe($('q1'));
    expect(panelStep(p, $('s0'), 'ArrowRight')).toBe(null);
    expect(panelStep(p, $('a1'), 'ArrowLeft')).toBe(null);
    // from the head's Close (in no column): into the first column
    expect(panelStep(p, $('x'), 'ArrowRight')).toBe($('a2'));
  });

  it('from outside the options: ↓ to the first, ↑ to the last of the panel', () => {
    const p = trackPanel();
    expect(panelStep(p, $('x'), 'ArrowDown')).toBe($('a1'));
    expect(panelStep(p, $('x'), 'ArrowUp')).toBe($('bigger'));
  });

  it('a one-column panel (chapters) has nothing for ← →, and an unknown key is null', () => {
    document.body.innerHTML = '<div class="panel"><div class="panel__body"><button class="option" id="c1"></button><button class="option" id="c2"></button></div></div>';
    const p = document.querySelector('.panel');
    expect(panelStep(p, $('c1'), 'ArrowRight')).toBe(null);
    expect(panelStep(p, $('c1'), 'ArrowDown')).toBe($('c2'));
    expect(panelStep(p, $('c1'), 'PageDown')).toBe(null);
    document.body.innerHTML = '<div class="panel"></div>';
    expect(panelStep(document.querySelector('.panel'), document.body, 'ArrowDown')).toBe(null);
  });
});

describe('trapTab', () => {
  it('wraps round inside the card, both ways; from outside it starts at an end', () => {
    document.body.innerHTML = '<div id="card"><button id="b1"></button><a href="#" id="b2"></a><button id="b3" disabled></button><button id="b4" style=""></button></div><button id="out"></button>';
    const card = $('card');
    shown($('b1'), $('b2'), $('b4'));
    expect(trapTab(card, $('b1'), false)).toBe($('b2'));
    expect(trapTab(card, $('b4'), false)).toBe($('b1'));
    expect(trapTab(card, $('b1'), true)).toBe($('b4'));
    expect(trapTab(card, $('out'), false)).toBe($('b1'));
    expect(trapTab(card, null, true)).toBe($('b4'));
  });

  it('a card with nothing focusable: null', () => {
    document.body.innerHTML = '<div id="card"><p>text</p></div>';
    expect(trapTab($('card'), null, false)).toBe(null);
  });
});

describe('canRefocus / routeAction', () => {
  it('only a rendered element still in the page, outside [inert] and [hidden]', () => {
    document.body.innerHTML = '<section class="route"><button id="ok"></button></section><section class="route" inert><button id="inert"></button></section><section hidden><button id="hidden"></button></section>';
    shown($('ok'), $('inert'), $('hidden'));
    expect(canRefocus($('ok'))).toBe(true);
    expect(canRefocus($('inert'))).toBe(false);
    expect(canRefocus($('hidden'))).toBe(false);
    const gone = $('ok');
    gone.remove();
    expect(canRefocus(gone)).toBe(false);
    expect(canRefocus(null)).toBe(false);
    expect(canRefocus(document.body)).toBe(false);
    document.body.innerHTML = '<button id="b"></button>';
    $('b').getClientRects = () => /** @type {any} */ ([]);
    expect(canRefocus($('b'))).toBe(false); // not rendered (display: none: no boxes)
  });

  it('the visible route’s primary button, else an action, else its screen (made focusable)', () => {
    document.body.innerHTML = `
      <section class="route" hidden><button class="btn btn--primary" id="p0"></button></section>
      <section class="route"><div class="screen" id="scr"><button class="action" id="act"></button><button class="btn btn--primary" id="play"></button></div></section>`;
    shown($('p0'), $('act'), $('play'), $('scr'));
    expect(routeAction(document)).toBe($('play'));
    $('play').remove();
    expect(routeAction(document)).toBe($('act'));
    $('act').remove();
    expect(routeAction(document)).toBe($('scr'));
    expect($('scr').tabIndex).toBe(-1);
  });

  it('no visible route, or nothing in it: null', () => {
    document.body.innerHTML = '<section class="route" hidden></section>';
    expect(routeAction(document)).toBe(null);
    document.body.innerHTML = '<section class="route"><p>x</p></section>';
    expect(routeAction(document)).toBe(null);
  });

  it('a screen that already has a tabindex keeps it', () => {
    document.body.innerHTML = '<section class="route"><div class="screen" tabindex="0" id="scr"></div></section>';
    shown($('scr'));
    expect(routeAction(document)).toBe($('scr'));
    expect($('scr').tabIndex).toBe(0);
  });
});
