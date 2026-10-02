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
const sources = new WeakMap(); // detail.rect → the node that was held
export function pressSource(rect) {
  return (rect && sources.get(rect)) || null;
}
const HOLD_AFTER = 150; // ms of stillness before the build-up starts

export function longpress(node, opts) {
  let o = norm(opts, 'onlongpress');
  let timer = 0;
  let holdTimer = 0;
  let sx = 0;
  let sy = 0;
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
      const detail = { x: sx, y: sy, rect: node.getBoundingClientRect(), node };
      sources.set(detail.rect, node);
      node.dispatchEvent(new CustomEvent('longpress', { detail }));
      o.onlongpress?.(detail);
    }, o.duration ?? 500);
  }

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

  const ctx = (e) => e.preventDefault();

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
const edgeOp = (p) => Math.max(0, Math.min(1, (1 - p) / 0.2)); // fades over the last 20 %

export function edgeSwipeBack(node, opts) {
  let o = opts || {};
  let tr = null; // { x0, y0, started, off, samples, topEl, underEl, shadow, ctl, dx }

  function start(e) {
    if (e.touches.length !== 1 || !o.enabled?.()) return;
    const t = e.touches[0];
    if (t.clientX > (o.edge ?? 20)) return;
    tr = { x0: t.clientX, y0: t.clientY, started: false, off: 0, samples: [] };
  }

  /* the slide's look at top-page offset x */
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

  function paint(dx) {
    const l = look(Math.max(0, dx), window.innerWidth);
    tr.topEl.style.transform = l.top;
    tr.underEl.style.transform = l.under;
    tr.underEl.style.opacity = String(l.uo);
    if (tr.shadow) {
      tr.shadow.style.transform = l.edge;
      tr.shadow.style.opacity = String(l.eo);
    }
  }

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

  function clear(els) {
    for (const el of els) {
      if (!el) continue;
      el.style.transform = '';
      el.style.opacity = '';
      el.style.willChange = '';
    }
  }

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
      s.samples.push({ t: e.timeStamp, x: lift.clientX });
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
    const kf = (fn) => sp.frames.map(({ offset, p }) => ({ offset, ...fn(look(dx + (x1 - dx) * p, w)) }));
    const opt = { duration: sp.duration, easing: 'linear', fill: 'forwards' };
    const a1 = s.topEl.animate(kf((l) => ({ transform: l.top })), opt);
    s.underEl.animate(kf((l) => ({ transform: l.under, opacity: l.uo })), opt);
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
export function doubleTap(node, opts) {
  let o = opts || {};
  let last = null; // { x, y, t, count }
  let timer = 0;
  let down = null;

  function detail(x, y, count) {
    const r = node.getBoundingClientRect();
    return { x, y, count, side: x - r.left < r.width / 2 ? 'left' : 'right' };
  }

  function pd(e) {
    down = { x: e.clientX, y: e.clientY, t: e.timeStamp };
  }

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
      timer = setTimeout(() => (last = null), delay);
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
export function scrollPast(node, opts) {
  let o = opts || {};
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
export function pullStretch(node, sel) {
  const sc = node.closest('.screen');
  if (!sc) return;
  let H = node.offsetHeight || 1;
  let stretched = false;
  function write() {
    const y = sc.scrollTop;
    if (y >= 0 && !stretched) return;
    stretched = y < 0;
    const t = stretched ? `scale(${((H - y) / H).toFixed(4)})` : '';
    for (const el of node.querySelectorAll(sel)) el.style.transform = t;
  }
  sc.addEventListener('scroll', write, { passive: true });
  const ro = new ResizeObserver(() => (H = node.offsetHeight || H));
  ro.observe(node);
  return {
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
export function portal(node, target = '#app') {
  const t = typeof target === 'string' ? document.querySelector(target) : target;
  (t || document.body).appendChild(node);
  return {
    destroy() {
      node.remove();
    }
  };
}
