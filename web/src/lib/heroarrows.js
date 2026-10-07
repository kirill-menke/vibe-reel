/* ◀ ▶ for Home's hero carousel — a mouse can't swipe it. The phone's Home
 * renders the hero and drives it with lib/carousel.js (HeroCarousel, which
 * hangs itself on the hero element as `__carousel`); this adds, from outside:
 *
 *   paddles  two buttons at the hero's edges, shown while the pointer is over
 *            it (web.css), as the rails' paddles are. Plain DOM appended to
 *            the hero element — Svelte keeps its own nodes in front of them —
 *            and put back whenever Home re-creates the hero.
 *   keys     ← / → while the pointer rests on the hero or focus is inside it.
 *            Never with the player or Login up, a sheet / menu open, or focus
 *            in a field; the rails have no arrow keys of their own.
 *
 * A step is the swipe's own transition (carousel.animate on --ease-sheet),
 * from wherever a running one is heading, so quick presses queue up. */
import { R } from '$p/lib/router.svelte.js';
import { ICONS } from '$p/lib/icons.js';
import { DUR, easeSheet, easeInout, reducedMotion } from '$p/lib/safe.js';

const HERO = '.route[data-route="home"]:not([hidden]) .homehero';

/** @param {Element | null} hero @param {-1 | 1} dir */
function step(hero, dir) {
  const c = /** @type {(Element & { __carousel?: any }) | null} */ (hero)?.__carousel;
  if (!c || c.n < 2 || c.busy) return;
  const from = c.anim ? c.anim.to : Math.round(c.p);
  if (reducedMotion()) c.animate(from + dir, DUR.rm, easeInout);
  else c.animate(from + dir, 520, easeSheet);
}

/** @param {'left' | 'right'} side */
function paddle(side) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'whero__btn whero__btn--' + (side === 'left' ? 'l' : 'r');
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

function equip() {
  for (const hero of document.querySelectorAll('.homehero')) {
    if (hero.querySelector(':scope > .whero__btn')) continue;
    hero.append(paddle('left'), paddle('right'));
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
