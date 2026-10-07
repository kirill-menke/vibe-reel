/* Resolved safe-area insets in px ({ top, right, bottom, left }) — env() only
 * resolves inside a property, so measure a probe. Cheap; call when needed. */
/** @type {HTMLDivElement | null} */
let probe = null;
/** @returns {VR.Insets} */
export function safeInsets() {
  if (!probe) {
    probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;visibility:hidden;pointer-events:none;padding:var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left)';
    document.body.appendChild(probe);
  }
  const s = getComputedStyle(probe);
  return {
    top: parseFloat(s.paddingTop) || 0,
    right: parseFloat(s.paddingRight) || 0,
    bottom: parseFloat(s.paddingBottom) || 0,
    left: parseFloat(s.paddingLeft) || 0
  };
}

/* ------------------------------------------------------------- motion ----
 * The JS mirror of tokens.css's Motion block — the one source for WAAPI and
 * Svelte transitions (docs/ios/polish/motion-system.md, MOT-01). Keep the
 * numbers in step with the CSS tokens. */

/** @returns {boolean} */
export function reducedMotion() {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/* Reduce Motion for Svelte transition / WAAPI params: the duration, or 0.
 * Outros (out:, and anything in a keyed-each outro group — see App.svelte)
 * must never be 0: use rmOut(), which floors at 1 ms. */
/** @type {(ms: number) => number} */
export const rm = (ms) => (reducedMotion() ? 0 : ms);
/** @type {(ms: number) => number} */
export const rmOut = (ms) => Math.max(1, rm(ms));

/* A duration token from tokens.css in ms ('380ms' / '.38s'), or the fallback. */
/** @param {string} name @param {number} fallback @returns {number} */
function cssMs(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? (v.endsWith('ms') ? n : v.endsWith('s') ? n * 1000 : n) : fallback;
  } catch {
    return fallback;
  }
}
let pushMs = 0;

/* Durations in ms (--dur-*). `rm` is the cross-fade that stands in for a
 * movement under Reduce Motion. */
export const DUR = {
  press: 110, // --dur-press
  fast: 180, // --dur-fast
  base: 260, // --dur-base
  /* push / pop: read from --dur-push itself (NAV-04), so tokens.css is the one
   * place to change it (380 today; 500 is the UIKit-weight candidate) */
  get push() {
    return (pushMs ||= cssMs('--dur-push', 380));
  },
  sheet: 440, // --dur-sheet
  sheetOut: 260, // sheet / action sheet / login dismiss (with EASE.dismiss); scrim fades
  hold: 350, // --dur-hold: long-press build-up (150 ms still → menu at 500 ms)
  springQuick: 420, // --dur-spring-quick
  spring: 700, // --dur-spring
  release: 420, // --dur-release
  img: 220, // --dur-img
  rm: 180,
  /* the tile → page zoom (zoom.js; App's unzoom outro): its own choreography,
   * a touch longer than a push because the art travels further */
  zoom: 460,
  zoomOut: 420,
  hero: 6000 // --dur-hero: Home hero auto-advance interval (a timer, not a motion)
};

/* The design's curves as WAAPI easing strings (tokens.css). */
export const EASE = {
  out: 'cubic-bezier(0.22, 0.9, 0.3, 1)',
  in: 'cubic-bezier(0.4, 0, 1, 1)',
  inout: 'cubic-bezier(0.65, 0, 0.35, 1)',
  sheet: 'cubic-bezier(0.32, 0.72, 0, 1)',
  standard: 'cubic-bezier(0.42, 0, 0.58, 1)', // --ease-standard: cross-fades ≥ 200 ms
  dismiss: 'cubic-bezier(0.3, 0, 0.8, 0.15)' // a modal leaving on its own (no finger): accelerates away
};

/* Springs (--spring-*) as WAAPI easing strings. linear() needs Safari 17.2+,
 * and WAAPI throws a TypeError on an easing it can't parse, so the cubic
 * fallbacks are picked here the way tokens.css's @supports picks them. Use
 * with DUR.springQuick / DUR.spring (settle times). */
const LIN = (() => {
  try {
    return CSS.supports('transition-timing-function', 'linear(0, 1)');
  } catch {
    return false;
  }
})();
export const SPRING = {
  smooth: LIN
    ? 'linear(0, 0.005 1.3%, 0.02 2.5%, 0.081 5.5%, 0.158 8.3%, 0.462 18.3%, 0.554 21.8%, 0.63 25%, 0.695 28.2%, 0.754 31.8%, 0.806 35.5%, 0.848 39.3%, 0.887 43.8%, 0.92 48.8%, 0.945 54.3%, 0.965 60.5%, 0.988 75.3%, 1)'
    : 'cubic-bezier(0.22, 0.9, 0.3, 1)',
  snappy: LIN
    ? 'linear(0, 0.005 1.3%, 0.022 2.8%, 0.055 4.5%, 0.098 6.3%, 0.186 9.3%, 0.51 19.3%, 0.609 22.8%, 0.689 26%, 0.758 29.3%, 0.816 32.5%, 0.863 35.8%, 0.903 39.3%, 0.937 43.3%, 0.965 47.8%, 0.985 52.8%, 0.997 58.3%, 1.006 71.8%, 1)'
    : 'cubic-bezier(0.2, 0.9, 0.25, 1.02)',
  bouncy: LIN
    ? 'linear(0, 0.006 1.3%, 0.028 2.8%, 0.063 4.3%, 0.108 5.8%, 0.218 8.8%, 0.585 17.8%, 0.692 20.8%, 0.776 23.5%, 0.848 26.3%, 0.911 29.3%, 0.959 32.3%, 0.995 35.3%, 1.017 38%, 1.034 41%, 1.046 47.8%, 1.004 76.8%, 1)'
    : 'cubic-bezier(0.34, 1.3, 0.64, 1)'
};

/* The same three springs as JS easings t → x (0…1 in time, x overshoots for
 * snappy/bouncy), for Svelte transitions/animate:, which take functions:
 *   animate:flip={{ duration: rm(DUR.base), easing: springEase.snappy }} */
/** @param {number} z damping ratio @returns {VR.Easing} */
function springFn(z) {
  const w = 2 * Math.PI; // response 1: the shape is independent of the response
  /** @type {VR.Easing} */
  const x =
    z >= 1
      ? (t) => 1 - Math.exp(-w * t) * (1 + w * t)
      : ((/** @type {number} */ wd) => (/** @type {number} */ t) => 1 + Math.exp(-z * w * t) * (-Math.cos(wd * t) - ((z * w) / wd) * Math.sin(wd * t)))(w * Math.sqrt(1 - z * z));
  let T = 0; // settle: last t with |1 − x| ≥ 0.2 %
  for (let t = 0; t < 3; t += 0.002) if (Math.abs(1 - x(t)) >= 0.002) T = t;
  return (p) => (p <= 0 ? 0 : p >= 1 ? 1 : x(p * T));
}
export const springEase = { smooth: springFn(1), snappy: springFn(0.85), bouncy: springFn(0.7) };

/* A critically damped spring that starts at a given velocity — the settle
 * after a finger lets go (edge-swipe back, zoom drag, sheet drag), so the
 * motion leaves at the finger's speed instead of restarting a fixed curve.
 *   v0        initial velocity TOWARD the target, in "distances per ms":
 *             finger px/ms ÷ the remaining px (negative = moving away)
 *   response  seconds (SwiftUI's response; 0.35 ≈ a UIKit push)
 * Returns { duration (ms), frames: [{ offset, p }] }: p = progress 0 → 1,
 * clamped (a flick faster than the spring would overshoot; the clamp holds it
 * at the target). Map p onto your own keyframes and run them with
 * easing: 'linear' — 21 samples, no per-frame JS:
 *   const s = spring(v / remaining);
 *   el.animate(s.frames.map(({ offset, p }) => ({ offset, transform: `translateX(${x0 + (x1 - x0) * p}px)` })),
 *              { duration: s.duration, easing: 'linear', fill: 'forwards' });
 * Finger-driven motion keeps it under Reduce Motion (direct manipulation).
 * A flick fast enough to overshoot ends where it first reaches the target
 * (the clamp would only hold it there, delaying the caller's finish).
 * `at(t)` is the same curve as a function of 0…1 time (for code that samples
 * its own keyframes, zoom.js). */
/** @param {number} [v0] @param {number} [response] seconds @returns {Required<VR.SpringCurve>} */
export function spring(v0 = 0, response = 0.35) {
  const w = (2 * Math.PI) / (response * 1000);
  const x = (/** @type {number} */ t) => 1 + (-1 + (v0 - w) * t) * Math.exp(-w * t);
  let T = 16;
  while (T < 900 && Math.abs(1 - x(T)) > 0.002 && x(T) < 1) T += 16;
  const frames = Array.from({ length: 21 }, (_, i) => ({
    offset: i / 20,
    p: Math.min(1, Math.max(0, x((T * i) / 20)))
  }));
  frames[20].p = 1;
  const at = (/** @type {number} */ t) => {
    const f = Math.min(20, Math.max(0, t * 20));
    const i = Math.min(19, Math.floor(f));
    return frames[i].p + (frames[i + 1].p - frames[i].p) * (f - i);
  };
  return { duration: T, frames, at };
}

/* A throw off screen: the finger's speed plus a constant pull — for a modal
 * a flick dismisses (sheet exits), where spring() is the wrong model: a
 * spring aimed at a target a whole sheet away pulls at ω²·distance (a 777 px
 * sheet flicked 200 px: ~0.25 px/ms², ten times what the finger did), so the
 * exit ran at ~70 px/frame right after a 25 px/frame drag. Here the pull is
 * the one that would carry `full` px from rest in DUR.sheetOut (the no-flick
 * exit's length), so the first frame moves as far as the finger's last one
 * and every later frame a few px more; a faster flick simply ends sooner.
 *   v     finger speed toward the exit, px/ms (≤ 0: from rest)
 *   dist  px left to travel · full: the whole travel (the sheet's height)
 * Returns { duration, frames: [{ offset, p }] } like spring(): p = 0 → 1 of
 * `dist`, run with easing: 'linear'. */
/** @param {number} v @param {number} dist @param {number} [full] @returns {VR.SpringCurve} */
export function fling(v, dist, full = dist) {
  const u = Math.max(0, v);
  const L = Math.max(1, dist);
  const g = (2 * Math.max(L, full)) / (DUR.sheetOut * DUR.sheetOut);
  const T = Math.max(16, (Math.sqrt(u * u + 2 * g * L) - u) / g);
  const frames = Array.from({ length: 21 }, (_, i) => {
    const t = (T * i) / 20;
    return { offset: i / 20, p: Math.min(1, (u * t + 0.5 * g * t * t) / L) };
  });
  frames[20].p = 1;
  return { duration: T, frames };
}

/* cubic-bezier(x1, y1, x2, y2) as a JS easing t → eased t (for Svelte
 * transitions, which take functions, not CSS strings). */
/** @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2 @returns {VR.Easing} */
export function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  /** @type {VR.Easing} */
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  /** @type {VR.Easing} */
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  /** @type {VR.Easing} */
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (/** @type {number} */ x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-5) break;
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    // fall back to bisection if Newton wandered off
    if (t < 0 || t > 1 || Math.abs(sx(t) - x) > 1e-3) {
      let lo = 0, hi = 1;
      t = x;
      for (let i = 0; i < 30; i++) {
        const v = sx(t);
        if (Math.abs(v - x) < 1e-5) break;
        if (v < x) lo = t;
        else hi = t;
        t = (lo + hi) / 2;
      }
    }
    return sy(t);
  };
}
export const easeSheet = bezier(0.32, 0.72, 0, 1); // --ease-sheet
export const easeInout = bezier(0.65, 0, 0.35, 1); // --ease-inout
export const easeOut = bezier(0.22, 0.9, 0.3, 1); // --ease-out
export const easeIn = bezier(0.4, 0, 1, 1); // --ease-in
export const easeDismiss = bezier(0.3, 0, 0.8, 0.15); // EASE.dismiss

/* use:fadeIn={on} — the first real content that replaces a skeleton dissolves
 * in (--dur-fast, linear: the short-fade token pair). WAAPI, not the `.fade-in`
 * CSS animation: routes and tabs toggle [hidden], and un-hiding restarts CSS
 * animations — a page returned to (a pop, a tab switch) replayed its fade every
 * time. Skipped when `on` is false (content painted at once from a cache, no
 * skeleton seen), under Reduce Motion, and during the tile → page zoom (which
 * fades swapped-in content on its own clock, like detail.js's lateIn). */
/** @param {Element} node @param {boolean} [on] */
export function fadeIn(node, on = true) {
  if (!on || reducedMotion() || node.closest('.route')?.classList.contains('zoom-card')) return;
  node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR.fast, easing: 'linear' });
}
/* use:fadeInRest={on} — the same for this node and every later sibling: put it
 * on the first element of a content branch that has no wrapper (Chart). */
/** @param {Element} node @param {boolean} [on] */
export function fadeInRest(node, on = true) {
  for (let el = /** @type {Element | null} */ (node); el; el = el.nextElementSibling) fadeIn(el, on);
}
