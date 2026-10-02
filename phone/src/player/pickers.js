/* The player's pickers (Audio · Subtitles · Quality, Chapters) as real iOS
 * sheets and panels (PLY-07). Svelte transitions for TrackPanel/ChapterPanel,
 * used `|global`: the panels unmount from Player's `{#if P.panel}` and a local
 * transition inside their own `{#if portrait}` would never run.
 *
 * Portrait = `.vr-picker` (fixed, full screen) holding the `.scrim` and a
 * `.vr-sheethost` with a <Sheet> — the same structure as App's sheet host, so
 * Sheet.svelte finds the scrim for its drag. The sheet and scrim move with
 * WAAPI on the elements themselves, exactly like App's host (SHT-01): present
 * = the sheet travels its own height on the smooth spring, the scrim fades in;
 * dismiss = from wherever the sheet is (mid-present) accelerating away. A
 * grabber drag-dismiss has already animated the sheet out (Sheet.svelte pins
 * it off screen) — then there is nothing left to move.
 * Landscape = the glass `.panel` slides in from the right and fades.
 * Reduced motion: a DUR.rm cross-fade for both. */
import { DUR, EASE, SPRING, easeSheet, easeIn, reducedMotion } from '$p/lib/safe.js';

const parts = (node) => ({ s: node.querySelector('.sheet'), sc: node.querySelector('.scrim') });

export function pickerIn(node) {
  const { s, sc } = parts(node);
  if (reducedMotion() || !s) {
    node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR.rm, easing: 'linear' });
    return { duration: DUR.rm };
  }
  // % of its own height, not a measured px: this runs before Svelte has
  // rendered the sheet's lists (it measured 216 of 356 px and started the
  // sheet 140 px up)
  s.animate([{ transform: 'translate3d(0,100%,0)' }, { transform: 'translate3d(0,0,0)' }], {
    duration: DUR.spring,
    easing: SPRING.smooth
  });
  sc?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR.sheetOut, easing: 'linear' });
  return { duration: DUR.spring };
}

export function pickerOut(node) {
  const { s, sc } = parts(node);
  if (reducedMotion() || !s) {
    const o = Number(getComputedStyle(node).opacity);
    node.animate([{ opacity: o }, { opacity: 0 }], { duration: DUR.rm, easing: 'linear', fill: 'forwards' });
    return { duration: DUR.rm };
  }
  const h = s.offsetHeight || 1;
  const y0 = new DOMMatrixReadOnly(getComputedStyle(s).transform).m42 || 0;
  const o0 = sc ? Number(getComputedStyle(sc).opacity) : 0;
  for (const a of s.getAnimations()) a.cancel();
  if (sc) for (const a of sc.getAnimations()) a.cancel();
  if (y0 >= h - 1) return { duration: 1 }; // dragged out already
  const o = { duration: DUR.sheetOut, easing: EASE.dismiss, fill: 'forwards' };
  s.animate([{ transform: `translate3d(0,${y0}px,0)` }, { transform: `translate3d(0,${h}px,0)` }], o);
  sc?.animate([{ opacity: o0 }, { opacity: 0 }], { ...o, easing: 'linear' });
  return { duration: DUR.sheetOut };
}

export function panelIn() {
  if (reducedMotion()) return { duration: DUR.rm, css: (t) => `opacity:${t}` };
  return { duration: DUR.base, easing: easeSheet, css: (t, u) => `transform:translate3d(${24 * u}px,0,0);opacity:${t}` };
}

export function panelOut() {
  if (reducedMotion()) return { duration: DUR.rm, css: (t) => `opacity:${t}` };
  return { duration: DUR.fast, easing: easeIn, css: (t, u) => `transform:translate3d(${24 * u}px,0,0);opacity:${t}` };
}
