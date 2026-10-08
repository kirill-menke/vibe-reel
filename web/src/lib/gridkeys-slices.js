/* Long poster grids on the web (the Library and the charts): their loaded
 * tiles mount in idle time, and in frames only when the viewport is about to
 * reach the end of what is mounted. The phone keeps its per-frame slices.
 *
 * The phone mounts a grid a slice per animation frame until every loaded
 * tile is in, sized by the script time of the last slice. On the desktop
 * those slices — up to 48 tiles, each flushSync + style + layout + paint —
 * landed in the frames of whatever else was going on: a wheel scroll through
 * a Library page that had just arrived, the chart's push (Chrome at 4× CPU:
 * the Top 250's slices were 50–120 ms tasks). Here:
 *
 *   idle     requestIdleCallback mounts slices that fit the idle period
 *            (≤ 8 ms of script, sized by the measured cost per tile), so
 *            the rest of a page goes in between frames, never in one;
 *   urgent   an IntersectionObserver watches the last mounted tile with a
 *            1.5-screen margin below the viewport: when a scroll or a key
 *            gets that close and idle time hasn't kept up, a slice goes in
 *            on the next frame (≤ 8 ms of script; smaller after a long frame).
 *
 *   sliceAhead(scroller, gridSel, more)
 *     scroller  the page's scrolling element (also the key: one slicer each)
 *     gridSel   selector of the grid(s); the last one's last tile is watched
 *     more(n)   mount n more tiles synchronously, or at least before the
 *               next microtask (flushSync, or a Svelte state change);
 *               return true while there are more to come, false to stop */

const BUDGET = 8; // ms of script per slice
const FRAME = 1000 / 60;
const MAX = 48;
const AHEAD = '0px 0px 150% 0px';

/** @typedef {{ io: IntersectionObserver, last: Element | null, near: boolean, raf: number, idle: number, prev: number, perTile: number, more: (n: number) => boolean, sel: string, pending: boolean }} Slicer */
/** @type {WeakMap<Element, Slicer>} */
const running = new WeakMap();

/* looked up at call time, not at import: a top-level read of a global is a
 * side effect to the bundler, which then kept this module in the phone build */
/** @param {IdleRequestCallback} cb @returns {number} */
const ric = (cb) =>
  typeof requestIdleCallback === 'function'
    ? requestIdleCallback(cb)
    : /** @type {number} */ (/** @type {unknown} */ (setTimeout(() => cb({ didTimeout: true, timeRemaining: () => BUDGET }), 16)));
/** @param {number} h */
const cic = (h) => (typeof cancelIdleCallback === 'function' ? cancelIdleCallback(h) : clearTimeout(h));

/* the last grid's last tile — a few grids to look through, not every tile
 * (a querySelectorAll of 400 tiles per slice showed up in the profile) */
/** @param {Element} scroller @param {string} gridSel */
const lastTile = (scroller, gridSel) => {
  const grids = scroller.querySelectorAll(gridSel);
  for (let i = grids.length - 1; i >= 0; i--) {
    for (let t = grids[i].lastElementChild; t; t = t.previousElementSibling) if (t.classList.contains('tile')) return t;
  }
  return null;
};

/** @param {Element} scroller @param {Slicer} s */
function watchLast(scroller, s) {
  const t = lastTile(scroller, s.sel);
  if (t === s.last) return;
  if (s.last) s.io.unobserve(s.last);
  s.last = t;
  s.near = false;
  if (t) s.io.observe(t); // reports its current state once
}

/* The caller may just have changed what it renders (the first tiles go in
 * with the effect that starts this): look for the last tile once that is in
 * the DOM — after the microtask Svelte flushes in. */
/** @param {Element} scroller @param {Slicer} s */
function soon(scroller, s) {
  if (s.pending) return;
  s.pending = true;
  queueMicrotask(() => {
    s.pending = false;
    if (running.get(scroller) === s) watchLast(scroller, s);
  });
}

/** @param {Element} scroller @param {Slicer} s */
function stop(scroller, s) {
  s.io.disconnect();
  cancelAnimationFrame(s.raf);
  cic(s.idle);
  running.delete(scroller);
}

/** mount what `ms` of script buys; false once the list is done
 * @param {Element} scroller @param {Slicer} s @param {number} ms */
function slice(scroller, s, ms) {
  const n = Math.max(1, Math.min(MAX, Math.floor(ms / s.perTile)));
  const t0 = performance.now();
  const go = s.more(n);
  const dt = performance.now() - t0;
  if (dt > 0) s.perTile = s.perTile * 0.5 + (dt / n) * 0.5;
  if (!go) {
    stop(scroller, s);
    return false;
  }
  soon(scroller, s); // the new tiles are in the DOM by the next microtask
  return true;
}

/** @param {Element} scroller @param {Slicer} s */
function idleLater(scroller, s) {
  s.idle = ric((d) => {
    s.idle = 0;
    if (running.get(scroller) !== s) return;
    const ms = Math.min(BUDGET, d.timeRemaining() - 1);
    if (ms < s.perTile && !d.didTimeout) return idleLater(scroller, s);
    if (slice(scroller, s, Math.max(ms, s.perTile))) idleLater(scroller, s);
  });
}

/** @param {Element} scroller @param {Slicer} s */
function urgentLater(scroller, s) {
  if (s.raf) return;
  s.raf = requestAnimationFrame((now) => {
    s.raf = 0;
    if (running.get(scroller) !== s || !s.near) return;
    // the previous urgent slice's whole frame (style, layout, paint) ran long:
    // a smaller one this time
    const frame = s.prev ? now - s.prev : 0;
    const ms = frame > FRAME * 1.5 && frame < 1000 ? (BUDGET * FRAME) / frame : BUDGET;
    s.prev = now;
    slice(scroller, s, ms);
  });
}

/** @param {Element} scroller @param {string} gridSel @param {(n: number) => boolean} more */
export function sliceAhead(scroller, gridSel, more) {
  const had = running.get(scroller);
  if (had) {
    had.more = more; // the latest closure (same list, maybe longer)
    soon(scroller, had);
    return;
  }
  /** @type {Slicer} */
  const s = {
    io: new IntersectionObserver(
      (es) => {
        for (const e of es) if (e.target === s.last) s.near = e.isIntersecting;
        if (s.near) urgentLater(scroller, s);
        else s.prev = 0; // resting: the next urgent slice starts a fresh frame count
      },
      { root: scroller, rootMargin: AHEAD }
    ),
    last: null,
    near: false,
    raf: 0,
    idle: 0,
    prev: 0,
    perTile: 0.5,
    more,
    sel: gridSel,
    pending: false
  };
  running.set(scroller, s);
  soon(scroller, s);
  idleLater(scroller, s);
}

/** whether a slicer runs for this scroller (tests) @param {Element} scroller */
export const slicing = (scroller) => running.has(scroller);
