<script module>
  /* Drag → host hand-off (SHT-02). A drag that ends in a dismissal leaves the
   * sheet where the finger let go (its inline transform) and parks the
   * finger's speed here; App's sheet host picks both up so the exit starts at
   * that offset and at that speed instead of restarting a fixed curve. */
  let exitV = 0;
  export function takeSheetExitV() {
    const v = exitV;
    exitV = 0;
    return v;
  }

  /* Progress follower (SHT-03). App registers the presenting page's card
   * here; a *hosted* sheet's drag drives it with the sheet's progress
   * p = 1 − dy / height (1 = at rest, 0 = gone; an upward pull stays 1):
   *   grab()                     a drag goes live: stop whatever animates it
   *   paint(p)                   one drag frame
   *   settle(frames, opts, skip) a release that springs back: frames
   *                              [{offset, p}], WAAPI opts, currentTime skip
   * A release that dismisses hands over to App's exit instead (it reads the
   * card where the drag left it). Unhosted sheets never touch it. */
  /** @type {VR.SheetFollower | null} */
  let follower = null;
  /** @param {VR.SheetFollower} f */
  export function followSheet(f) {
    follower = f;
    return () => {
      if (follower === f) follower = null;
    };
  }
</script>

<script>
  /* Sheet — bottom sheet body (`.sheet`). Registered sheet components render
   * one of these; the host in App.svelte supplies the scrim and the present /
   * dismiss animation (both move the `.sheet` by its own height, SHT-01).
   *   title       sheet title (.sheet__title)
   *   large       near full height (.sheet--large); else content height
   *   onclose     default closeSheet() — called by the close button, a drag
   *               down on the grabber/head (or on the body at its top) past
   *               min(110 px, a third of the sheet) or flicked, and the scrim
   *   headAction  snippet replacing the close button (e.g. a "Done" text button)
   *   head        snippet replacing the whole head
   *   foot        snippet for the sticky foot (.sheet__foot) — "Show 412"
   *   bodyEl      (bindable) the scrolling body
   *   children    body content
   * The drag is fully interactive (SHT-02): the scrim behind follows it
   * (1 − dy / height), an upward pull rubber-bands (≤ ~12 % of the height),
   * a release that doesn't dismiss springs back from the finger's speed.
   * Outside App's `.sheethost` (a Sheet mounted by a screen or the player)
   * a drag-dismiss animates the sheet out itself, leaves it pinned off screen
   * and then calls onclose; the scrim, if any, is the `.scrim` right before
   * the sheet's parent. Hosted in App, a drag also drives the page card behind
   * a large sheet (followSheet, SHT-03). */
  import Icon from './Icon.svelte';
  import { closeSheet } from '../lib/router.svelte.js';
  import { spring, fling } from '../lib/safe.js';

  /** @type {{ title?: string, large?: boolean, onclose?: (() => unknown) | null, headAction?: VR.Snip, head?: VR.Snip, foot?: VR.Snip, bodyEl?: HTMLElement | null, class?: string, children?: VR.Snip }} */
  let { title = '', large = false, onclose = null, headAction, head, foot, bodyEl = $bindable(null), class: cls = '', children } = $props();

  /** @type {HTMLElement | null} */
  let el = $state(null);
  const close = () => (onclose ? onclose() : closeSheet());

  const hosted = () => !!el?.parentElement?.classList.contains('sheethost');
  function scrimOf() {
    const s = /** @type {HTMLElement | null | undefined} */ (el?.parentElement?.previousElementSibling);
    return s && s.classList.contains('scrim') ? s : null;
  }
  const clamp = (/** @type {number} */ x, /** @type {number} */ a, /** @type {number} */ b) => Math.max(a, Math.min(b, x));

  /* drag to dismiss */
  /** @type {VR.SheetDrag | null} */
  let d = null; // { y0, dy, v, lastY, lastT, fromBody, live, h, scrim, follow }
  /** @param {number} y @param {number} t @param {boolean} fromBody */
  function dStart(y, t, fromBody) {
    d = { y0: y, dy: 0, v: 0, lastY: y, lastT: t, fromBody, live: !fromBody, h: 0, scrim: null, follow: null };
  }
  function goLive() {
    /** @type {NonNullable<typeof d>} */ (d).h = /** @type {NonNullable<typeof el>} */ (el).offsetHeight || 1;
    /** @type {NonNullable<typeof d>} */ (d).scrim = scrimOf();
    /** @type {NonNullable<typeof d>} */ (d).follow = hosted() ? follower : null;
    // a present animation still running would override the finger
    for (const a of /** @type {NonNullable<typeof el>} */ (el).getAnimations()) a.cancel();
    if (/** @type {NonNullable<typeof d>} */ (d).scrim) for (const a of /** @type {NonNullable<typeof d>} */ (d).scrim.getAnimations()) a.cancel();
    /** @type {NonNullable<typeof d>} */ (d).follow?.grab();
  }
  /** @param {number} dy */
  function paint(dy) {
    /** @type {NonNullable<typeof el>} */ (el).style.transform = `translate3d(0,${dy}px,0)`;
    const p = clamp(1 - dy / /** @type {NonNullable<typeof d>} */ (d).h, 0, 1);
    if (/** @type {NonNullable<typeof d>} */ (d).scrim) /** @type {NonNullable<typeof d>} */ (d).scrim.style.opacity = String(p);
    /** @type {NonNullable<typeof d>} */ (d).follow?.paint(p);
  }
  /** @param {number} y @param {number} t @param {Event} [e] */
  function dMove(y, t, e) {
    if (!d) return;
    const dy = y - d.y0;
    if (d.fromBody && !d.live) {
      if (dy > 6 && bodyEl && bodyEl.scrollTop <= 0) d.live = true;
      else if (dy < 0 || (bodyEl && bodyEl.scrollTop > 0)) {
        d = null;
        return;
      } else return;
    }
    if (!d.h) goLive();
    e?.cancelable && e.preventDefault();
    const dt = t - d.lastT;
    if (dt > 0) d.v = 0.7 * ((y - d.lastY) / dt) + 0.3 * d.v;
    d.lastY = y;
    d.lastT = t;
    /* iOS rubber band upward: asymptotic, never past ~12 % of the height */
    d.dy = dy >= 0 ? dy : -(1 - 1 / ((-dy * 0.55) / d.h + 1)) * d.h * 0.12;
    paint(d.dy);
  }
  /** @param {Event} [e] */
  function dEnd(e) {
    if (!d) return;
    const s = d;
    d = null;
    if (!s.live || !s.h) return;
    // the speed only updates on moves: a finger that rested before lifting
    // (60 ms, like the edge swipe) is not a flick, however fast it came in
    if (e && e.timeStamp - s.lastT > 60) s.v = 0;
    const out = s.dy > Math.min(110, s.h * 0.33) || (s.v > 0.5 && s.dy > 20);
    if (out) {
      exitV = Math.max(0, s.v);
      if (hosted()) {
        close(); // App's host runs the exit from here (takeSheetExitV)
        return;
      }
      settle(s, s.h, () => close());
      return;
    }
    settle(s, 0, () => {
      /** @type {NonNullable<typeof el>} */ (el).style.transform = '';
      if (s.scrim) s.scrim.style.opacity = '';
    });
  }

  /* From the release point to `to` (0 = rest, h = gone) at the finger's
   * speed: back to rest on a critically damped spring, out on a fling (a
   * spring aimed a whole sheet away jumps ahead of the finger — safe.js). */
  /** @param {VR.SheetDrag} s @param {number} to @param {() => void} done */
  function settle(s, to, done) {
    const from = s.dy;
    const dist = to - from;
    const v0 = Math.abs(dist) > 1 ? s.v / dist : 0;
    const sp = to > 0 ? fling(s.v, dist, s.h) : spring(clamp(v0, -0.05, 0.05), 0.3);
    const o0 = s.scrim ? clamp(1 - from / s.h, 0, 1) : 1;
    const o1 = to > 0 ? 0 : 1;
    const a = /** @type {NonNullable<typeof el>} */ (el).animate(
      sp.frames.map(({ offset, p }) => ({ offset, transform: `translate3d(0,${from + dist * p}px,0)` })),
      { duration: sp.duration, easing: 'linear', fill: 'forwards' }
    );
    const f = s.scrim?.animate(
      sp.frames.map(({ offset, p }) => ({ offset, opacity: o0 + (o1 - o0) * p })),
      { duration: sp.duration, easing: 'linear', fill: 'forwards' }
    );
    // the finger moved in the frame before: don't repeat it at the hand-off
    a.currentTime = 16;
    if (f) f.currentTime = 16;
    s.follow?.settle(
      sp.frames.map(({ offset, p }) => ({ offset, p: clamp(1 - (from + dist * p) / s.h, 0, 1) })),
      { duration: sp.duration, easing: 'linear' },
      16
    );
    a.onfinish = () => {
      /* Gone: pin the end state inline before the fills go — the owner
       * unmounts us a microtask later, and a cancelled fill would first put
       * the sheet back where the finger let go (and the scrim at its drag
       * opacity) for the owner's outro to start from. */
      if (to > 0) {
        /** @type {NonNullable<typeof el>} */ (el).style.transform = `translate3d(0,${to}px,0)`;
        if (s.scrim) s.scrim.style.opacity = '0';
      }
      done();
      a.cancel();
      if (s.scrim) for (const x of s.scrim.getAnimations()) x.cancel();
    };
  }

  /** @param {HTMLElement} node */
  function grab(node) {
    const down = (/** @type {PointerEvent} */ e) => {
      if (/** @type {Element} */ (e.target).closest('button, a, input')) return;
      node.setPointerCapture?.(e.pointerId);
      dStart(e.clientY, e.timeStamp, false);
    };
    const move = (/** @type {PointerEvent} */ e) => dMove(e.clientY, e.timeStamp, e);
    node.addEventListener('pointerdown', down);
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', dEnd);
    node.addEventListener('pointercancel', dEnd);
    return {
      destroy() {
        node.removeEventListener('pointerdown', down);
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', dEnd);
        node.removeEventListener('pointercancel', dEnd);
      }
    };
  }

  /** @param {HTMLElement} node */
  function bodyDrag(node) {
    const ts = (/** @type {TouchEvent} */ e) => e.touches.length === 1 && dStart(e.touches[0].clientY, e.timeStamp, true);
    const tm = (/** @type {TouchEvent} */ e) => dMove(e.touches[0].clientY, e.timeStamp, e);
    node.addEventListener('touchstart', ts, { passive: true });
    node.addEventListener('touchmove', tm, { passive: false });
    node.addEventListener('touchend', dEnd);
    node.addEventListener('touchcancel', dEnd);
    return {
      destroy() {
        node.removeEventListener('touchstart', ts);
        node.removeEventListener('touchmove', tm);
        node.removeEventListener('touchend', dEnd);
        node.removeEventListener('touchcancel', dEnd);
      }
    };
  }
</script>

<div class="sheet {large ? 'sheet--large' : ''} {cls}" role="dialog" aria-modal="true" aria-label={title || undefined} bind:this={el}>
  <div class="sheet__grab" use:grab>
    <div class="sheet__grabber"></div>
    {#if head}{@render head()}{:else if title || headAction}
      <div class="sheet__head">
        <h2 class="sheet__title">{title}</h2>
        {#if headAction}{@render headAction()}{:else}
          <button type="button" class="closebtn" aria-label="Close" onclick={close}><Icon name="x" /></button>
        {/if}
      </div>
    {/if}
  </div>
  <div class="sheet__body" bind:this={bodyEl} use:bodyDrag>{@render children?.()}</div>
  {#if foot}<div class="sheet__foot">{@render foot()}</div>{/if}
</div>
