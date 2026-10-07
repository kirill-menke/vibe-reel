/* Touch gestures as Svelte actions. Transform/opacity only; every animation is
 * WAAPI with the design's curves. See the API notes on each export.
 *
 *   use:longpress={fn | { onlongpress, duration = 500, tolerance = 10, disabled }}
 *   use:edgeSwipeBack={{ enabled, top, beneath, shadow, reveal, grab, commit, drag, edge = 20 }}
 *   use:doubleTap={{ onsingle, ondouble, delay = 300, slop = 30 }}
 *   use:scrollPast={{ y = 40, onchange }}
 *   use:pullStretch={selector}
 */

import { spring } from './safe.js';

/** A bare callback becomes `{ [key]: fn }`; options are copied.
 * @param {VR.LongPressOptions | ((d: VR.LongPressDetail) => void) | null | undefined} o @param {'onlongpress'} key @returns {VR.LongPressOptions} */
function norm(o, key) {
  return typeof o === 'function' ? { [key]: o } : { ...(o || {}) };
}

/* ---------------------------------------------------------------- longpress
 * Hold 500 ms without moving more than 10 px → dispatches a `longpress`
 * CustomEvent on the node (detail: { x, y, rect, node }) — handle it with
 * `onlongpress={…}` — and/or calls opts.onlongpress(detail). The click that
 * follows the release is swallowed, so a tile's tap action doesn't also run.
 * The native context menu / callout is suppressed on the node.
 * Build-up (MOT-04 / CTX-01): after 150 ms of stillness the node gets
 * `.holding` (components.css sinks a tile's artwork, lights a row) until the
 * finger lifts or moves off; a ContextMenu opened from `detail.rect` finds
 * the node through pressSource(rect), lifts its preview out of it and takes
 * `.holding` off itself. */
/** @type {WeakMap<DOMRect, HTMLElement>} */
const sources = new WeakMap(); // detail.rect → the node that was held
/** @param {DOMRect | null | undefined} rect a longpress detail's rect @returns {HTMLElement | null} */
export function pressSource(rect) {
  return (rect && sources.get(rect)) || null;
}
const HOLD_AFTER = 150; // ms of stillness before the build-up starts

/** @param {HTMLElement} node @param {VR.LongPressOptions | ((d: VR.LongPressDetail) => void) | null} [opts]
 * @returns {import('svelte/action').ActionReturn<VR.LongPressOptions | ((d: VR.LongPressDetail) => void) | null>} */
export function longpress(node, opts) {
  /** @type {VR.LongPressOptions} */
  let o = norm(opts, 'onlongpress');
  /** @type {ReturnType<typeof setTimeout> | 0} */
  let timer = 0;
  /** @type {ReturnType<typeof setTimeout> | 0} */
  let holdTimer = 0;
  let sx = 0;
  let sy = 0;
  /** @type {number | null} */
  let pid = null;
  let suppress = false;

  function unhold() {
    clearTimeout(holdTimer);
    holdTimer = 0;
    node.classList.remove('holding');
  }

  function cancel() {
    clearTimeout(timer);
    timer = 0;
    unhold();
  }

  /** @param {PointerEvent} e */
  function down(e) {
    if (o.disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    suppress = false;
    sx = e.clientX;
    sy = e.clientY;
    pid = e.pointerId;
    cancel();
    holdTimer = setTimeout(() => {
      holdTimer = 0;
      node.classList.add('holding');
    }, HOLD_AFTER);
    timer = setTimeout(() => {
      timer = 0;
      suppress = true;
      window.addEventListener('click', click, true);
      /** @type {VR.LongPressDetail} */
      const detail = { x: sx, y: sy, rect: node.getBoundingClientRect(), node };
      sources.set(detail.rect, node);
      node.dispatchEvent(new CustomEvent('longpress', { detail }));
      o.onlongpress?.(detail);
    }, o.duration ?? 500);
  }

  /** @param {PointerEvent} e */
  function move(e) {
    if (!timer || e.pointerId !== pid) return;
    if (Math.hypot(e.clientX - sx, e.clientY - sy) > (o.tolerance ?? 10)) cancel();
  }

  function up() {
    cancel();
    // the click (if any) arrives right after pointerup
    if (suppress) setTimeout(release, 450);
  }

  /* Swallowed window-wide, not just on the node: a context menu opened by the
   * long-press can put an item right under the finger, and the release would
   * otherwise click it (that marked a whole season watched once). */
  /** @param {MouseEvent} e */
  function click(e) {
    if (!suppress) return;
    release();
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function release() {
    suppress = false;
    window.removeEventListener('click', click, true);
  }

  const ctx = (/** @type {Event} */ e) => e.preventDefault();

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', up);
  node.addEventListener('contextmenu', ctx);
  return {
    update(n) {
      o = norm(n, 'onlongpress');
    },
    destroy() {
      cancel();
      release();
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
      node.removeEventListener('contextmenu', ctx);
    }
  };
}

/* ------------------------------------------------------------ edgeSwipeBack
 * Interactive pop from the left edge. Put it on the element that contains the
 * routes (App does); callbacks:
 *   enabled()  → bool   may a swipe start now (stack depth > 1, no modal/sheet)
 *   top()      → Element  the page being dragged
 *   beneath()  → Element  the page revealed underneath
 *   shadow()   → Element  optional: the page-edge shadow strip (App's
 *                        .stage__edge), kept on the dragged page's left edge
 *   reveal(on)           show / hide the page underneath (App: R.peek)
 *   grab(top, beneath) → px  optional, at the drag's start: stop a transition
 *                        still running and return where the top page is, so
 *                        the drag carries on from there (a swipe mid-push)
 *   commit()             finish: pop without an animation of its own
 *   drag(top, beneath) → optional controller that replaces the slide (the
 *                        zoom card, lib/zoom.js): { paint(dx, dy),
 *                        end(done, then, v), threshold? } — `then` must be
 *                        called once its own settle animation is over; `v` is
 *                        the finger's release speed (px/ms, + = rightwards)
 * The top page follows the finger; the one beneath slides from −30 % to 0 and
 * brightens from .6.
 *
 * Release (NAV-02), as UIKit decides it: the speed is measured over the last
 * 100 ms of movement only (a finger that rested ≥ 60 ms before lifting has
 * none), and the page's position is projected forward by that speed (UIKit's
 * normal deceleration: 0.998/ms → ≈ 0.5 s × v). Past half the width (the zoom
 * card: its `threshold`) → pop, else back — so a hesitation or a flick back
 * cancels and a short fast flick pops. Both pages then settle on a critically
 * damped spring that starts at the finger's speed (safe.js spring()). */
const EDGE_W = 24; // px, the shadow strip (App's .stage__edge)
/** @type {(p: number) => number} */
const edgeOp = (p) => Math.max(0, Math.min(1, (1 - p) / 0.2)); // fades over the last 20 %

/** A swipe in progress: start point, whether it has taken over, the grab offset, the last
 * 100 ms of x samples, the two pages (+ shadow strip), the zoom controller and the painted dx.
 * @typedef {{ x0: number, y0: number, started: boolean, off: number, samples: Array<{ t: number, x: number }>,
 *   topEl?: HTMLElement | null, underEl?: HTMLElement | null, shadow?: HTMLElement | null,
 *   ctl?: VR.SwipeDragController | null, dx?: number }} Swipe */
/** A swipe that has taken over (`started`): both pages are found by then (start() bails otherwise).
 * @typedef {Swipe & { topEl: HTMLElement, underEl: HTMLElement }} Started */
/** @param {HTMLElement} node @param {VR.EdgeSwipeOptions | null} [opts] @returns {import('svelte/action').ActionReturn<VR.EdgeSwipeOptions | null>} */
export function edgeSwipeBack(node, opts) {
  let o = opts || {};
  /** @type {Swipe | null} */
  let tr = null; // { x0, y0, started, off, samples, topEl, underEl, shadow, ctl, dx }

  /** @param {TouchEvent} e */
  function start(e) {
    if (e.touches.length !== 1 || !o.enabled?.()) return;
    const t = e.touches[0];
    if (t.clientX > (o.edge ?? 20)) return;
    tr = { x0: t.clientX, y0: t.clientY, started: false, off: 0, samples: [] };
  }

  /* the slide's look at top-page offset x */
  /** @param {number} x @param {number} w */
  function look(x, w) {
    const p = Math.max(0, Math.min(1, x / w));
    return {
      top: `translate3d(${x}px,0,0)`,
      under: `translate3d(${-30 * (1 - p)}%,0,0)`,
      uo: 0.6 + 0.4 * p,
      edge: `translate3d(${x - EDGE_W}px,0,0)`,
      eo: edgeOp(p)
    };
  }

  /** @param {number} dx */
  function paint(dx) {
    const l = look(Math.max(0, dx), window.innerWidth);
    /** @type {Started} */ (tr).topEl.style.transform = l.top;
    /** @type {Started} */ (tr).underEl.style.transform = l.under;
    /** @type {Started} */ (tr).underEl.style.opacity = String(l.uo);
    if (/** @type {Started} */ (tr).shadow) {
      /** @type {HTMLElement} */ (/** @type {Started} */ (tr).shadow).style.transform = l.edge;
      /** @type {HTMLElement} */ (/** @type {Started} */ (tr).shadow).style.opacity = String(l.eo);
    }
  }

  /** @param {TouchEvent} e */
  function move(e) {
    if (!tr) return;
    const t = e.touches[0];
    const dx = t.clientX - tr.x0;
    const dy = t.clientY - tr.y0;
    if (!tr.started) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        tr = null;
        return;
      }
      if (dx < 8) return;
      tr.topEl = o.top?.();
      tr.underEl = o.beneath?.();
      if (!tr.topEl || !tr.underEl) {
        tr = null;
        return;
      }
      tr.started = true;
      o.reveal?.(true);
      tr.underEl.hidden = false;
      tr.off = o.grab?.(tr.topEl, tr.underEl) || 0;
      tr.ctl = o.drag?.(tr.topEl, tr.underEl) || null;
      if (!tr.ctl) {
        tr.shadow = o.shadow?.() || null;
        tr.topEl.style.willChange = tr.underEl.style.willChange = 'transform';
      }
    }
    e.preventDefault();
    const S = tr.samples;
    S.push({ t: e.timeStamp, x: t.clientX });
    while (S.length > 2 && e.timeStamp - S[0].t > 100) S.shift();
    tr.dx = dx + tr.off;
    if (tr.ctl) tr.ctl.paint(tr.dx, dy);
    else paint(tr.dx);
  }

  /* px/ms over the last 100 ms of movement, cut at the last change of
   * direction (a drag right then a flick back is the flick's speed, not the
   * net of both); 0 if the finger rested first — with no final touchmove the
   * last sample is stale, and the lift sample repeats the resting position */
  /** @param {Array<{ t: number, x: number }>} S @param {number} now @returns {number} px/ms */
  function velocity(S, now) {
    let m = S.length - 1; // the last sample that moved
    while (m > 0 && S[m].x === S[m - 1].x) m--;
    if (m < 1) return 0;
    const b = S[m];
    if (now - b.t > 60) return 0;
    let i = m;
    let dir = 0;
    while (i > 0 && b.t - S[i - 1].t <= 100) {
      const d = Math.sign(S[i].x - S[i - 1].x);
      if (d && dir && d !== dir) break;
      dir ||= d;
      i--;
    }
    const dt = b.t - S[i].t;
    return dt > 0 ? (b.x - S[i].x) / dt : 0;
  }

  /** @param {Array<HTMLElement | null | undefined>} els */
  function clear(els) {
    for (const el of els) {
      if (!el) continue;
      el.style.transform = '';
      el.style.opacity = '';
      el.style.willChange = '';
    }
  }

  /** @param {TouchEvent} [e] */
  function end(e) {
    if (!tr) return;
    const s = tr;
    tr = null;
    if (!s.started) return;
    const w = window.innerWidth;
    const dx = Math.max(0, s.dx || 0); // where the page is painted
    // the lift point is the last sample (a final touchmove may not have come)
    const lift = e?.type === 'touchend' ? e.changedTouches?.[0] : null;
    let at = dx;
    if (lift) {
      s.samples.push({ t: /** @type {TouchEvent} */ (e).timeStamp, x: lift.clientX });
      at = Math.max(0, lift.clientX - s.x0 + s.off);
    }
    const v = velocity(s.samples, e?.timeStamp ?? performance.now());
    const done = at + 499 * v > w * (s.ctl?.threshold ?? 0.5);
    if (s.ctl) {
      s.ctl.end(
        done,
        () => {
          if (done) o.commit?.();
          else o.reveal?.(false);
        },
        v
      );
      return;
    }
    const x1 = done ? w : 0;
    const rem = Math.abs(x1 - dx);
    const sp = spring(rem > 1 ? (done ? v : -v) / rem : 0);
    /** @type {(fn: (l: ReturnType<typeof look>) => Keyframe) => Keyframe[]} */
    const kf = (fn) => sp.frames.map(({ offset, p }) => ({ offset, ...fn(look(dx + (x1 - dx) * p, w)) }));
    /** @type {KeyframeAnimationOptions} */
    const opt = { duration: sp.duration, easing: 'linear', fill: 'forwards' };
    const a1 = /** @type {Started} */ (s).topEl.animate(kf((l) => ({ transform: l.top })), opt);
    /** @type {Started} */ (s).underEl.animate(kf((l) => ({ transform: l.under, opacity: l.uo })), opt);
    s.shadow?.animate(kf((l) => ({ transform: l.edge, opacity: l.eo })), opt);
    a1.onfinish = () => {
      for (const el of [s.topEl, s.underEl, s.shadow]) el?.getAnimations().forEach((a) => a.cancel());
      if (done) o.commit?.();
      else o.reveal?.(false);
      // the popped page is gone now; clear the revealed one's styles
      clear([s.topEl, s.underEl, s.shadow]);
    };
  }

  node.addEventListener('touchstart', start, { passive: true });
  node.addEventListener('touchmove', move, { passive: false });
  node.addEventListener('touchend', end);
  node.addEventListener('touchcancel', end);
  return {
    /** @param {VR.EdgeSwipeOptions | null} n */
    update(n) {
      o = n || {};
    },
    destroy() {
      node.removeEventListener('touchstart', start);
      node.removeEventListener('touchmove', move);
      node.removeEventListener('touchend', end);
      node.removeEventListener('touchcancel', end);
    }
  };
}

/* ---------------------------------------------------------------- doubleTap
 * Tells single taps from double taps (and runs of taps).
 *   ondouble({ x, y, count, side })  second tap within `delay` ms and `slop` px
 *                                    of the previous one; count 2, 3, … while
 *                                    the run continues (side: 'left'|'right'
 *                                    half of the node)
 *   onsingle({ x, y, side })         a lone tap, after `delay` ms of quiet
 * Also dispatches `singletap` / `doubletap` CustomEvents with the same detail. */
/** @param {HTMLElement} node @param {VR.DoubleTapOptions | null} [opts] @returns {import('svelte/action').ActionReturn<VR.DoubleTapOptions | null>} */
export function doubleTap(node, opts) {
  let o = opts || {};
  /** @type {{ x: number, y: number, t: number, count: number } | null} */
  let last = null; // { x, y, t, count }
  /** @type {ReturnType<typeof setTimeout> | 0} */
  let timer = 0;
  /** @type {{ x: number, y: number, t: number } | null} */
  let down = null;

  /** @param {number} x @param {number} y @param {number} count @returns {VR.TapDetail} */
  function detail(x, y, count) {
    const r = node.getBoundingClientRect();
    return { x, y, count, side: x - r.left < r.width / 2 ? 'left' : 'right' };
  }

  /** @param {PointerEvent} e */
  function pd(e) {
    down = { x: e.clientX, y: e.clientY, t: e.timeStamp };
  }

  /** @param {PointerEvent} e */
  function pu(e) {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 12;
    down = null;
    if (moved) return;
    const delay = o.delay ?? 300;
    const now = e.timeStamp;
    const x = e.clientX;
    const y = e.clientY;
    if (last && now - last.t < delay && Math.hypot(x - last.x, y - last.y) < (o.slop ?? 30) * (last.count > 1 ? 4 : 1)) {
      clearTimeout(timer);
      last = { x, y, t: now, count: last.count + 1 };
      const d = detail(x, y, last.count);
      node.dispatchEvent(new CustomEvent('doubletap', { detail: d }));
      o.ondouble?.(d);
      timer = setTimeout(/** @returns {null} */ () => (last = null), delay);
      return;
    }
    last = { x, y, t: now, count: 1 };
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (last && last.count === 1) {
        const d = detail(x, y, 1);
        node.dispatchEvent(new CustomEvent('singletap', { detail: d }));
        o.onsingle?.(d);
      }
      last = null;
    }, delay);
  }

  function pc() {
    down = null;
  }

  node.addEventListener('pointerdown', pd);
  node.addEventListener('pointerup', pu);
  node.addEventListener('pointercancel', pc);
  return {
    /** @param {VR.DoubleTapOptions | null} n */
    update(n) {
      o = n || {};
    },
    destroy() {
      clearTimeout(timer);
      node.removeEventListener('pointerdown', pd);
      node.removeEventListener('pointerup', pu);
      node.removeEventListener('pointercancel', pc);
    }
  };
}

/* --------------------------------------------------------------- scrollPast
 * On a scroller: onchange(true) once scrollTop passes `y`, onchange(false)
 * when it comes back above. For TopBar/NavBar `solid`. */
/** @param {Element} node @param {VR.ScrollPastOptions | null} [opts] @returns {import('svelte/action').ActionReturn<VR.ScrollPastOptions | null>} */
export function scrollPast(node, opts) {
  let o = opts || {};
  /** @type {boolean | null} */
  let state = null;
  function check() {
    const s = node.scrollTop > (o.y ?? 40);
    if (s !== state) {
      state = s;
      o.onchange?.(s);
    }
  }
  node.addEventListener('scroll', check, { passive: true });
  queueMicrotask(check);
  return {
    /** @param {VR.ScrollPastOptions | null} n */
    update(n) {
      o = n || {};
      state = null;
      check();
    },
    destroy() {
      node.removeEventListener('scroll', check);
    }
  };
}

/* -------------------------------------------------------------- pullStretch
 * On a page-top header (Home's hero): pulling the page down past its top (iOS
 * rubber band) stretches the parts matching `sel` upward from their bottom
 * edge (CSS gives them transform-origin 50% 100% and lets the header overflow
 * upward), so the art fills the gap instead of a hard edge against the black
 * background — DetailHero's DET-01 without the parallax. One transform write
 * per part per scroll event while above the top, one reset after. */
/** @param {HTMLElement} node @param {string} sel the parts to stretch @returns {import('svelte/action').ActionReturn<string> | undefined} */
export function pullStretch(node, sel) {
  const sc = node.closest('.screen');
  if (!sc) return;
  let H = node.offsetHeight || 1;
  let stretched = false;
  function write() {
    const y = /** @type {Element} */ (sc).scrollTop;
    if (y >= 0 && !stretched) return;
    stretched = y < 0;
    const t = stretched ? `scale(${((H - y) / H).toFixed(4)})` : '';
    for (const el of node.querySelectorAll(/** @type {string} */ (sel))) /** @type {HTMLElement} */ (el).style.transform = t;
  }
  sc.addEventListener('scroll', write, { passive: true });
  const ro = new ResizeObserver(() => (H = node.offsetHeight || H));
  ro.observe(node);
  return {
    /** @param {string} n */
    update(n) {
      sel = n;
    },
    destroy() {
      sc.removeEventListener('scroll', write);
      ro.disconnect();
    }
  };
}

/* ------------------------------------------------------------------- portal
 * Move the node to #app (above every route) — for overlays rendered from
 * inside a scrolled page (ContextMenu uses it). */
/** @param {Element} node @param {string | Element} [target] @returns {import('svelte/action').ActionReturn} */
export function portal(node, target = '#app') {
  const t = typeof target === 'string' ? document.querySelector(target) : target;
  (t || document.body).appendChild(node);
  return {
    destroy() {
      node.remove();
    }
  };
}
