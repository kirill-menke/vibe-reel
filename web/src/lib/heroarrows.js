/* ◀ ▶ and ⏸ for Home's hero carousel — a mouse can't swipe it. The phone's
 * Home renders the hero and drives it with lib/carousel.js (HeroCarousel,
 * which hangs itself on the hero element as `__carousel`); this adds, from
 * outside:
 *
 *   controls Pause · Previous · Next, one group at the right end of the
 *            pager row (home.css) — the rails carry their ◀ ▶ at the right
 *            too. Pause is a toggle (aria-pressed): the auto-advance moves the
 *            page for ~65 s, and WCAG 2.2.2 wants a way to stop it. Paused
 *            holds for the session (every Home hero).
 *   hold     auto-advance also waits while the pointer rests on the hero or
 *            keyboard focus is inside it (carousel.js asks `__held()` when its
 *            timer fires and parks the step; leaving resumes it a full
 *            interval later). A mouse click on a paddle leaves focus there
 *            without :focus-visible — that doesn't hold it once the pointer
 *            has left.
 *   focus    a step with focus on a slide's button (←/→, or anything else
 *            that changes the slide) makes the old slide inert: focus moves to
 *            the same button of the new slide instead of dropping to <body>.
 *   keys     ← / → while the pointer rests on the hero or focus is inside it.
 *            Never with the player or Login up, a sheet / menu open, or focus
 *            in a field; the rails have no arrow keys of their own.
 *
 * The controls are plain DOM put in *front* of Svelte's nodes (tab order:
 * Pause, Previous, Next, then the slide — the APG carousel's order) once the
 * hero exists, and again whenever Home re-creates it. Svelte only inserts
 * relative to its own anchors, so foreign leading nodes don't disturb it.
 *
 * A step is the swipe's own transition (carousel.animate on --ease-sheet),
 * from wherever a running one is heading, so quick presses queue up. */
import { R } from '$p/lib/router.svelte.js';
import { ICONS } from '$p/lib/icons.js';
import { DUR, easeSheet, easeInout, reducedMotion } from '$p/lib/safe.js';

const HERO = '.route[data-route="home"]:not([hidden]) .homehero';
const BODY = '.homehero__body';
/** the controls of a slide's text block, in order (Resume/Play, Details) */
const CTRL = 'button, a[href]';

/** @typedef {HTMLElement & { __carousel?: any, __held?: () => boolean, __wired?: boolean }} Hero */

let paused = false; // the Pause button (session-wide)

/** @param {Element | null} hero @param {-1 | 1} dir */
function step(hero, dir) {
  const c = /** @type {Hero | null} */ (hero)?.__carousel;
  if (!c || c.n < 2 || c.busy) return;
  const from = c.anim ? c.anim.to : Math.round(c.p);
  if (reducedMotion()) c.animate(from + dir, DUR.rm, easeInout);
  else c.animate(from + dir, 520, easeSheet);
}

/** Auto-advance waits: paused, pointer over the hero, or keyboard focus in it.
 * @param {Element} hero @returns {boolean} */
export function heroHeld(hero) {
  if (paused) return true;
  if (hero.matches(':hover')) return true;
  const a = document.activeElement;
  return !!a && hero.contains(a) && matches(a, ':focus-visible');
}

/** @param {Element} el @param {string} sel */
function matches(el, sel) {
  try {
    return el.matches(sel);
  } catch {
    return true; // an engine without the selector: any focus inside holds
  }
}

/** A step was parked while held: run it a full interval after the hold ends.
 * @param {Hero} hero */
function resume(hero) {
  const c = hero.__carousel;
  if (!c?.parked || heroHeld(hero)) return;
  c.parked = false;
  clearTimeout(c.retry);
  c.retry = setTimeout(() => c.advance(), DUR.hero);
}

/** The control of `body` at position `idx` (or the nearest one that can take
 * focus — a "new" slide's Play is disabled until its item resolves).
 * @param {Element | null} body @param {number} idx @returns {HTMLElement | null} */
export function controlAt(body, idx) {
  if (!body) return null;
  const all = /** @type {HTMLElement[]} */ ([...body.querySelectorAll(CTRL)]);
  const ok = (/** @type {HTMLElement} */ b) => !b.hasAttribute('disabled');
  const at = all[Math.min(idx, all.length - 1)];
  if (at && ok(at)) return at;
  return all.slice(idx + 1).find(ok) || all.slice(0, idx).reverse().find(ok) || null;
}

/** Focus sat on control `idx` of a slide that just went inert: put it on the
 * same control of the live slide.
 * @param {Element} hero @param {number} idx @returns {boolean} moved */
export function refocus(hero, idx) {
  const live = hero.querySelector(`:scope > ${BODY}:not([inert])`);
  const to = controlAt(live, idx);
  if (!to) return false;
  to.focus({ preventScroll: true });
  return document.activeElement === to;
}

/** refocus() as soon as it can land: the live slide's text block is still
 * visibility: hidden for the first frames after the swap (it fades in over
 * the second half of the transition), and a hidden button takes no focus.
 * Gives up once focus is somewhere else on purpose, or after ~1 s.
 * @param {Element} hero @param {number} idx */
function refocusSoon(hero, idx) {
  let n = 0;
  const lost = () => {
    const a = document.activeElement;
    return !a || a === document.body || !!a.closest(`${BODY}[inert]`);
  };
  const tryIt = () => {
    if (!hero.isConnected || !lost() || refocus(hero, idx) || ++n > 60) return;
    requestAnimationFrame(tryIt);
  };
  tryIt();
}

/** @param {Element} el @returns {number} */
const indexIn = (el) => {
  const body = el.closest(BODY);
  return body ? [...body.querySelectorAll(CTRL)].indexOf(/** @type {HTMLElement} */ (el.closest(CTRL))) : -1;
};

/** @param {'left' | 'right'} side */
function paddle(side) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'whero__btn whero__btn--' + (side === 'left' ? 'prev' : 'next');
  b.setAttribute('aria-label', side === 'left' ? 'Previous' : 'Next');
  b.innerHTML = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[side === 'left' ? 'chevron-left' : 'chevron-right'].svg}</svg>`;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    step(b.closest('.homehero'), side === 'left' ? -1 : 1);
  });
  // the carousel's own drag must not start on the paddle
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  return b;
}

const icon = (/** @type {'pause' | 'play'} */ n) => `<svg class="i i--fill" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n].svg}</svg>`;

/** @param {HTMLButtonElement} b */
function paintPause(b) {
  b.setAttribute('aria-pressed', String(paused));
  b.innerHTML = icon(paused ? 'play' : 'pause');
}

function pauseButton() {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'whero__btn whero__pause';
  b.setAttribute('aria-label', 'Pause slideshow');
  paintPause(b);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    paused = !paused;
    for (const x of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('.whero__pause'))) paintPause(x);
    const hero = /** @type {Hero | null} */ (b.closest('.homehero'));
    const c = hero?.__carousel;
    if (paused || !c) return;
    // Play: start over as a touch does — it re-arms the rounds the
    // auto-advance gives up after (Home's onbusy) and restarts its timer
    c.parked = false;
    c.cb?.onbusy?.(true);
    c.cb?.onbusy?.(false);
  });
  b.addEventListener('pointerdown', (e) => e.stopPropagation());
  return b;
}

/** @param {Hero} hero */
function wire(hero) {
  if (hero.__wired) return;
  hero.__wired = true;
  hero.__held = () => heroHeld(hero);
  const later = () => setTimeout(() => resume(hero), 0);
  hero.addEventListener('pointerleave', later);
  hero.addEventListener('focusout', (e) => {
    later();
    // focus left a slide that went away under it — inert, or hidden by the
    // crossfade a frame before Home flips `inert` (carousel.js hides a text
    // block once it is fully faded): bring it back onto the live slide. Not
    // for a click elsewhere (that slide is still shown).
    const t = /** @type {Element} */ (e.target);
    const fe = /** @type {FocusEvent} */ (e);
    const b = /** @type {HTMLElement | null} */ (t.closest(BODY));
    if (!fe.relatedTarget && b && (b.inert || b.style.visibility === 'hidden')) {
      const i = indexIn(t);
      if (i >= 0) queueMicrotask(() => refocusSoon(hero, i));
    }
  });
  // the slide changed under focus: Home flips `inert` on the text blocks
  new MutationObserver(() => {
    const a = document.activeElement;
    if (!a || !hero.contains(a) || !a.closest(`${BODY}[inert]`)) return;
    const i = indexIn(a);
    if (i >= 0) refocusSoon(hero, i);
  }).observe(hero, { attributes: true, attributeFilter: ['inert'], subtree: true });
}

function equip() {
  for (const hero of /** @type {NodeListOf<Hero>} */ (document.querySelectorAll('.homehero'))) {
    if (!hero.querySelector(':scope > .whero__ctl')) {
      const g = document.createElement('div');
      g.className = 'whero__ctl';
      g.setAttribute('role', 'group');
      g.setAttribute('aria-label', 'Slideshow');
      g.append(pauseButton(), paddle('left'), paddle('right'));
      hero.prepend(g);
    }
    wire(hero);
  }
}

export function initHeroArrows() {
  new MutationObserver(equip).observe(document.body, { childList: true, subtree: true });
  equip();
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (R.modal || R.sheet || document.querySelector('.ctx, .actsheet:not([inert])')) return;
    const t = /** @type {Element | null} */ (e.target);
    if (t?.closest?.('input, textarea, select, [contenteditable]')) return;
    const hero = document.querySelector(HERO);
    if (!hero || !(hero.matches(':hover') || hero.contains(document.activeElement))) return;
    e.preventDefault();
    step(hero, e.key === 'ArrowLeft' ? -1 : 1);
  });
}

/** tests: back to the session's start */
export function _resetHeroArrows() {
  paused = false;
}
