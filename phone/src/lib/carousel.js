/* Home hero carousel — a finger-tracked blur/crossfade between backdrops.
 *
 * The position is one float `p` (slide index; p = 2.4 is 40 % of the way from
 * slide 2 to slide 3). Every visual is a pure function of p, so a drag, the
 * snap after it, auto-advance and a touch that catches a running transition
 * all share one path and nothing can jump: whatever moves p, `paint()` draws.
 *
 * For i0 = floor(p), f = p − i0, slide i0 is the *base* (below) and i0 + 1 the
 * *incoming* one (above). The base goes sharp → blurred and drifts; the
 * incoming one fades in blurred and sharpens. A drag back just runs f the
 * other way; at f = 1 the incoming slide is exactly what it looks like as the
 * next base, so the role swap at an integer is invisible.
 *
 * Blur is never animated. Each slide has three static layers: the sharp
 * <img> and two pre-blurred copies — a 480 px rendition of the image drawn
 * into small canvases (240 and 96 px wide), box-blurred there once and scaled
 * up by CSS (the upscale itself is most of the blur). A blur level is two
 * dissolves, sharp → soft → heavy, each a small visual step, so the midpoints
 * read as "half blurred" rather than a sharp ghost over mush. The copies are
 * built off the critical path ("the blurred copies" below): one canvas per
 * task, in idle time, never while a finger is down or a transition runs, not
 * in the first boot seconds unless a focus-in waits for them. A slide without
 * them yet crosses over as a plain (sharp) crossfade; auto-advance waits.
 * A transition only moves the opacity and transform of these layers, which
 * the compositor does without repainting; an animated `filter: blur()` on a
 * full-width image re-runs the blur every frame.
 *
 * Before its backdrop has decoded, a slide shows the item's blurhash (a 32×18
 * canvas under the stack, scaled up by the compositor): colours at once, no
 * text on flat black. When the image arrives the slide *comes into focus* —
 * a readiness r (0 → 1, `focusIn`) fades the real stack in heavily blurred
 * over the hash and sharpens it through the same two-dissolve ladder a swipe
 * uses. A cache hit (placeholder up < 100 ms) or an off-screen slide skips it.
 *
 * DOM contract (children of the node `attach` is used on):
 *   .homehero__media[data-i]  > canvas (blurhash) + canvas (heavy) + canvas (soft)
 *                               + img (sharp), bottom → top
 *   .homehero__body[data-i]   the text block of slide i
 *   .homehero__dots .dots__dot[data-i]   (--k = how active, 0…1)
 * It sets data-role = base | in | off on each media (z-index, visibility) and
 * --hot on the media/body of the settled slide and its two neighbours
 * (will-change: promoted while idle, so a drag starts on ready layers
 * instead of promoting — and re-rastering — under the finger).
 */
import { easeSheet, easeInout, easeOut, reducedMotion, DUR } from './safe.js';
import { drawBlurhash } from './blurhash.js';

// easeSheet (--ease-sheet): release / snap · easeInout (--ease-inout): auto-advance
const LOCK = 8; // px before the gesture picks an axis
const FLICK = 350; // px/s: a release faster than this goes where it was thrown
const AUTO_MS = DUR.spring; // 700: the auto-advance glide (on --ease-inout)
const QUICK_HIT = 100; // ms: a placeholder up for less than this was a cache hit — no focus-in
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x) => ((x = clamp01(x)), x * x * (3 - 2 * x));
const mod = (a, n) => ((a % n) + n) % n;

export class HeroCarousel {
  /** @param {{ onsettle?: (i:number)=>void, ondominant?: (i:number)=>void, onbusy?: (b:boolean)=>void }} cb */
  constructor(cb = {}) {
    this.cb = cb;
    this.n = 0;
    this.p = 0;
    this.node = null;
    this.raf = 0;
    this.anim = null; // { from, to, t0, dur, ease }
    this.dom = -1;
    this.busy = false;
    this.hot = -1;
    this.focusing = new Set(); // media elements coming into focus (r animating)
    this.attach = this.attach.bind(this);
  }

  /* ------------------------------------------------------------ public ---- */
  /** Slide count / current index changed from outside (refetch, first paint). */
  set(n, index) {
    const nChanged = n !== this.n;
    this.n = n;
    if (!n) return;
    if (nChanged) this.stop();
    else if (this.busy) return;
    if (nChanged || mod(Math.round(this.p), n) !== index) this.p = index;
    this.hot = -1;
    this.paint();
  }

  /** Auto-advance: the same transition as a swipe, over ~700 ms. */
  advance() {
    if (this.busy || this.anim || this.n < 2 || !this.node) return;
    const from = Math.round(this.p), to = from + 1;
    const media = (i) => this.node.querySelector(`:scope > .homehero__media[data-i="${mod(i, this.n)}"]`);
    // never auto-advance onto a backdrop that isn't decoded yet (a slow
    // network): wait for it rather than fade into the placeholder
    const m = media(to);
    const img = m?.querySelector('img');
    // …nor onto one still coming into focus (its readiness r < 1)
    let wait = (img && !img.complete) || (m && !m.__failed && (m.__r ?? 1) < 1 && img?.getAttribute('src'));
    // …nor before both ends have their blurred copies (asked for now)
    if (!reducedMotion()) for (const x of [media(from), m]) if (x && needBlur(x)) wait = true;
    if (wait) {
      // loaded or failed (no width → placeholder) both count
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.advance(), 500);
      return;
    }
    this.animate(to, reducedMotion() ? DUR.rm : AUTO_MS, easeInout, true);
  }

  /** Drop a pending auto-advance retry (the page paused auto-advance). */
  hold() {
    clearTimeout(this.retry);
  }

  attach(node) {
    this.node = node;
    node.__carousel = this; // for scripted checks (DEV-CHROME.md)
    let pid = null, x0 = 0, y0 = 0, axis = null, p0 = 0, origin = 0, lx = 0;
    let samples = [];
    let swallow = 0;
    const W = () => node.clientWidth || 1;

    const down = (e) => {
      if (pid !== null || this.n < 2 || (e.pointerType === 'mouse' && e.button !== 0)) return;
      pid = e.pointerId;
      x0 = lx = e.clientX;
      y0 = e.clientY;
      axis = null;
      /* A touch that catches the hero in motion (auto-advance, a snap) only
       * stops it, as a UIScrollView does: the click that follows would land on
       * whichever slide's buttons happen to be live — mid-transition that is
       * a slide still nearly invisible (measured: 420 ms into an auto-advance
       * the tap started slide 1's Resume at 28 % opacity). */
      if (this.anim || Math.abs(this.p - Math.round(this.p)) > 1e-3) swallow = performance.now() + 600;
      this.cancelAnim(); // catch a running transition where it is
      this.setBusy(true);
    };
    const move = (e) => {
      if (e.pointerId !== pid) return;
      const dx = e.clientX - x0, dy = e.clientY - y0;
      if (axis === null) {
        if (Math.abs(dx) < LOCK && Math.abs(dy) < LOCK) return;
        axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (axis === 'y') return end(false); // the page scrolls; we let go
        // start from here: the lock slop doesn't turn into a jump
        x0 = e.clientX;
        p0 = this.p;
        origin = Math.round(p0);
        samples = [];
      }
      if (axis !== 'x') return;
      lx = e.clientX;
      const now = e.timeStamp || performance.now();
      samples.push([now, lx]);
      while (samples.length > 2 && now - samples[0][0] > 100) samples.shift();
      const p = p0 - (lx - x0) / W();
      this.p = Math.min(origin + 1, Math.max(origin - 1, p));
      this.frame();
    };
    const end = (release) => {
      pid = null;
      const dragged = axis === 'x';
      axis = null;
      if (dragged && release) {
        swallow = Math.max(swallow, performance.now() + 400); // the click after a drag isn't a tap
        let vx = 0; // px/s, finger
        if (samples.length > 1) {
          const [ta, xa] = samples[0], [tb, xb] = samples[samples.length - 1];
          if (tb - ta > 8) vx = ((xb - xa) / (tb - ta)) * 1000;
        }
        this.release(vx, origin, W());
      } else {
        this.release(0, Math.round(this.p), W());
      }
      this.setBusy(false);
    };
    const up = (e) => e.pointerId === pid && end(true);
    const cancel = (e) => e.pointerId === pid && end(false);
    const click = (e) => {
      if (performance.now() < swallow) {
        e.preventDefault();
        e.stopPropagation();
        swallow = 0;
      }
    };
    node.addEventListener('pointerdown', down);
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', cancel);
    node.addEventListener('click', click, true);
    this.paint();
    return {
      destroy: () => {
        this.stop();
        node.removeEventListener('pointerdown', down);
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', up);
        node.removeEventListener('pointercancel', cancel);
        node.removeEventListener('click', click, true);
        this.node = null;
      }
    };
  }

  /* ----------------------------------------------------------- motion ---- */
  release(vx, origin, w) {
    const p = this.p;
    let to = Math.round(p);
    if (Math.abs(vx) > FLICK) to = vx < 0 ? Math.floor(p) + 1 : Math.ceil(p) - 1; // finger left = forward
    to = Math.min(origin + 1, Math.max(origin - 1, to));
    const dist = Math.abs(to - p);
    if (dist < 1e-3) return this.settle(to);
    if (reducedMotion()) return this.animate(to, DUR.rm, easeInout);
    // match the curve's opening speed to the finger's: --ease-sheet starts at
    // 0.72/0.32 = 2.25× its average speed, so dur = 2.25 · dist / v
    const v = Math.abs(vx) / w; // slides/s
    const dur = v > 0.05 ? (2.25 * dist) / v : 0.2 + 0.4 * dist;
    this.animate(to, Math.min(560, Math.max(220, dur * 1000)), easeSheet);
  }

  animate(to, dur, ease, auto = false) {
    this.anim = { from: this.p, to, t0: performance.now(), dur, ease, auto };
    this.frame();
  }

  cancelAnim() {
    this.anim = null;
  }

  /** The backdrop of this .homehero__media has decoded: bring it into focus
   *  (r 0 → 1), or at once when `instant`. */
  focusIn(m, instant) {
    if (instant || !this.node) {
      m.__r = 1;
      this.focusing.delete(m);
    } else {
      m.__fi = { t0: performance.now(), dur: reducedMotion() ? DUR.rm : DUR.spring };
      // copies that land mid-way would pop in: this focus-in uses them or not
      m.__fiBlur = !!m.__blurred;
      this.focusing.add(m);
    }
    this.frame();
  }

  stepFocus(now) {
    for (const m of this.focusing) {
      const t = Math.min(1, Math.max(0, (now - m.__fi.t0) / m.__fi.dur));
      m.__r = reducedMotion() ? t : easeOut(t);
      if (t >= 1 || !m.isConnected) {
        m.__r = 1;
        this.focusing.delete(m);
      }
    }
    return this.focusing.size > 0;
  }

  stop() {
    this.anim = null;
    for (const m of this.focusing) m.__r = 1;
    this.focusing.clear();
    clearTimeout(this.retry);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  frame() {
    if (this.raf) return;
    this.raf = requestAnimationFrame((now) => {
      this.raf = 0;
      const more = this.stepFocus(now); // runs only while a slide comes into focus
      const a = this.anim;
      if (a) {
        const t = Math.min(1, (now - a.t0) / a.dur);
        this.p = a.from + (a.to - a.from) * a.ease(Math.max(0, t));
        if (t >= 1) {
          this.settle(a.to, a.auto);
          if (more) this.frame();
          return;
        }
      }
      if (a || more) this.frame();
      this.paint();
    });
  }

  /** `auto`: the settle ends an auto-advance (Home counts them). */
  settle(to, auto = false) {
    this.anim = null;
    const i = mod(to, this.n || 1);
    this.p = i;
    this.paint();
    this.cb.onsettle?.(i, auto);
    kickBlurs(); // copies held back by the transition
  }

  setBusy(b) {
    if (this.busy === b) return;
    this.busy = b;
    this.cb.onbusy?.(b);
    if (!b) kickBlurs();
  }

  /* ------------------------------------------------------------ paint ---- */
  paint() {
    const node = this.node, n = this.n;
    if (!node || !n) return;
    const rm = reducedMotion();
    const w = node.clientWidth || 393;
    const i0 = Math.floor(this.p + 1e-6);
    const f = Math.max(0, this.p - i0);
    const A = mod(i0, n), B = f > 1e-4 ? mod(i0 + 1, n) : -1;
    const cur = mod(Math.round(this.p), n);

    // --hot (will-change) follows the settled slide, not every frame
    const hot = this.anim || this.busy ? this.hot : cur;
    const heat = hot !== this.hot;
    this.hot = hot;
    const near = (i) => n < 2 || i === hot || i === mod(hot + 1, n) || i === mod(hot - 1, n);

    // media parallax: 6 % of the finger's travel, plus a zoom that always
    // covers the drift (1 + 2·drift/w), so no edge ever shows through
    const PX = 0.06 * w, Z = 0.12;
    const TX = 32; // text slide

    for (const m of node.querySelectorAll(':scope > .homehero__media')) {
      const i = +m.dataset.i;
      if (heat) m.classList.toggle('homehero__media--hot', near(i));
      const role = i === A ? 'base' : i === B ? 'in' : 'off';
      if (m.dataset.role !== role) {
        m.dataset.role = role;
        m.style.zIndex = role === 'in' ? '2' : role === 'base' ? '1' : '0';
        m.style.visibility = role === 'off' ? 'hidden' : '';
      }
      if (role === 'off') continue;
      // children: blurhash, heavy blur, soft blur, sharp (bottom → top)
      const [hash, heavy, soft, sharp] = m.children;
      let c = 1, bl = 0, tf = ''; // coverage, blur level 0 (sharp) … 1 (heavy)
      if (rm) {
        c = role === 'base' ? 1 : f; // reduced motion: a plain crossfade
      } else if (role === 'base') {
        bl = smooth(f / 0.6); // blurs out over the first 60 %
        tf = `translate3d(${(-f * PX).toFixed(2)}px,0,0) scale(${(1 + Z * f).toFixed(4)})`;
      } else {
        c = smooth((f - 0.08) / 0.84); // fades in blurred …
        bl = 1 - smooth((f - 0.4) / 0.6); // … and sharpens over the last 60 %
        tf = `translate3d(${((1 - f) * PX).toFixed(2)}px,0,0) scale(${(1 + Z * (1 - f)).toFixed(4)})`;
      }
      // not decoded yet / coming into focus: the real stack covers only part
      // of the slide (fades in over the first 40 % of r) and is at least as
      // blurred as r says (heavy → sharp over the last 80 %)
      const r = m.__r ?? 0;
      // no blurred copies yet (built in idle time): a plain crossfade of the
      // sharp layer, as with reduced motion — the transform still drifts
      const flat = rm || !m.__blurred || (r < 1 && !m.__fiBlur);
      let cr = c;
      if (r < 1) {
        if (flat) cr = c * r;
        else {
          cr = c * smooth(r / 0.4);
          bl = Math.max(bl, 1 - smooth((r - 0.2) / 0.8));
        }
      }
      // blur level as two dissolves: sharp over soft (0 → .5), soft over heavy
      // (.5 → 1) — each step is a small change, so no sharp ghost over mush
      const so = cr * (1 - clamp01(bl * 2));
      const mo = cr * (1 - clamp01(bl * 2 - 1));
      const ho = cr;
      // anything under a fully opaque layer is pure overdraw: hide it
      const op = flat ? [0, 0, cr] : [so > 0.999 || mo > 0.999 ? 0 : ho, so > 0.999 ? 0 : mo, so];
      // the blurhash fills what the real stack leaves of the slide's coverage
      // c (exactly: stacked it composes back to c), gone once that is opaque
      const q = 1 - (1 - op[0]) * (1 - op[1]) * (1 - op[2]);
      const hq = !hash?.__drawn || q > 0.999 ? 0 : clamp01((c - q) / (1 - q));
      [hash, heavy, soft, sharp].forEach((el, k) => {
        if (!el) return;
        const o = k ? op[k - 1] : hq;
        el.style.opacity = o.toFixed(4);
        el.style.transform = tf;
        if (!k) el.style.visibility = o > 0.001 ? '' : 'hidden';
      });
    }

    for (const b of node.querySelectorAll(':scope > .homehero__body')) {
      const i = +b.dataset.i;
      if (heat) b.classList.toggle('homehero__body--hot', near(i));
      let o = 0, x = 0;
      if (i === A) {
        o = 1 - smooth(f / 0.45);
        x = -f * TX;
      } else if (i === B) {
        o = smooth((f - 0.55) / 0.45);
        x = (1 - f) * TX;
      }
      b.style.visibility = o > 0.001 ? '' : 'hidden';
      b.style.opacity = o.toFixed(4);
      b.style.transform = rm || !x ? '' : `translate3d(${x.toFixed(2)}px,0,0)`;
    }

    // pager: each dot's "activeness" is 1 − its (circular) distance from p
    const pp = mod(this.p, n);
    for (const d of node.querySelectorAll('.homehero__dots .dots__dot')) {
      const j = +d.dataset.i;
      let dist = Math.abs(pp - j);
      dist = Math.min(dist, n - dist);
      d.style.setProperty('--k', Math.max(0, 1 - dist).toFixed(3));
    }

    if (cur !== this.dom) {
      this.dom = cur;
      this.cb.ondominant?.(cur);
    }
  }
}

/* use:heroArt={{ url, blur, hash }} on a .homehero__media: draw the blurhash
 * into the bottom canvas at once; decode the backdrop detached (see
 * src/lib/decoded.js — an undecoded 1920 image blocks the commit), then give
 * the sharp <img> its src and let the carousel bring the slide into focus.
 * `blur` is a 480 px rendition of the same image, the source of the blurred
 * copies (see below). Only the newest url wins; url null releases the
 * backdrop (Home keeps the current slide and its neighbours only — a decoded
 * 1920 backdrop is ~8 MB). The copies stay (~150 KB a slide): a slide that
 * comes back needs only its backdrop decoded again, not its copies rebuilt. */
export function heroArt(node, arg) {
  let want = null, drawn = null, start = 0;
  const car = () => node.parentElement?.__carousel;
  function set({ url: u = null, blur: bu = null, hash = null } = {}) {
    const hc = node.querySelector('.homehero__hash');
    if (hc && hash !== drawn) {
      drawn = hash;
      hc.__drawn = !!hash && drawBlurhash(hc, hash);
      car()?.frame();
    }
    want = u;
    node.__blurUrl = bu;
    const img = node.querySelector('img');
    if (!u) {
      img?.removeAttribute('src');
      jobs.delete(node); // copies not built yet: built when it comes back
      node.__r = 0;
      car()?.frame();
      return;
    }
    if (img?.getAttribute('src') === u) {
      if (!node.__blurred && img.complete) blurJob(node, bu, img);
      return;
    }
    // a first image starts out of focus; a changed one swaps in when decoded
    if (!img?.getAttribute('src')) node.__r = 0;
    node.__failed = false;
    start = performance.now();
    const pre = new Image();
    pre.src = u;
    // the small rendition loads alongside: it is usually there first
    blurJob(node, bu, null);
    const apply = (ok) => {
      if (want !== u) return;
      if (img) img.src = u;
      const c = car();
      if (!ok) {
        // a broken backdrop: the blurhash (or flat surface) stays
        node.__failed = true;
        return c?.frame();
      }
      // the fallback source, should the small rendition fail
      const j = jobs.get(node);
      if (j && j.url === bu) blurJob(node, bu, pre);
      // a changed image under a slide in focus swaps in (its new copies were
      // queued with it)
      if ((node.__r ?? 0) >= 1) return c?.frame();
      const instant = !c || node.dataset.role === 'off' || node.dataset.role === undefined || performance.now() - start < QUICK_HIT;
      if (!c) node.__r = 1;
      // the focus-in sharpens through the copies: give them a moment (they
      // are the first job now), else come into focus as a plain fade
      else if (instant || node.__blurred) c.focusIn(node, instant);
      else
        whenBlurred(node, BLUR_WAIT).then(() => {
          if (want === u && (node.__r ?? 0) < 1) car()?.focusIn(node, false);
        });
    };
    pre.decode().then(() => apply(true), () => apply(false));
  }
  set(arg);
  return { update: set, destroy: () => ((want = null), dropBlurs(node)) };
}

/* ------------------------------------------------- the blurred copies ---- */
/* Building them used to run inside heroArt's decode callback for every slide
 * at once: ~450 ms of main thread in the boot profile (4× CPU throttle,
 * headless Chrome), 122–170 ms per slide in one task. Chrome re-decodes an
 * <img> for a canvas on the main thread whatever decode() did (~110 ms for a
 * 1920 backdrop at 4×, measured) and read the 480 px step back from the GPU
 * canvas. So: the source is a 480 px rendition from Jellyfin (~16× fewer
 * pixels to decode; the copies are 96 / 240 px — the look is the same), every
 * canvas is CPU-side (willReadFrequently: no GPU readback), one canvas per
 * task, scheduled in idle time:
 *   urgent     a focus-in or an auto-advance waits for it   → next idle slot
 *   current    the settled slide                            → after BOOT_QUIET
 *   neighbour  the rest                                     → after BOOT_QUIET
 * never while a finger is down or a transition runs (the carousel kicks the
 * queue when it settles). Safari has no requestIdleCallback: a timeout right
 * after a frame stands in. */
const BOOT_QUIET = 3000; // ms since navigation start
const BLUR_WAIT = 400; // ms a focus-in waits for its copies
const BLUR_W = [96, 240]; // heavy (σ ≈ 15 CSS px on screen), soft (σ ≈ 6)
const jobs = new Map(); // .homehero__media → { src, big, fail, step, urgent, waiters }
let pumping = false;
const idle =
  typeof requestIdleCallback === 'function'
    ? (fn) => requestIdleCallback(fn, { timeout: 300 })
    : (fn) => requestAnimationFrame(() => setTimeout(fn, 0));

/* queue (or refresh) the copies for this media; `bu` the small rendition */
function blurJob(m, bu, big) {
  let j = jobs.get(m);
  if (!j && m.__blurred && m.__blurOf === bu) return null; // kept from an earlier visit
  if (j && j.url === bu) {
    if (big && !j.big) {
      j.big = big;
      if (j.fail) (j.src = big), kickBlurs();
    }
    return j;
  }
  const waiters = j?.waiters || [];
  j = { url: bu, src: null, big, fail: false, step: 0, urgent: j?.urgent || false, waiters };
  jobs.set(m, j);
  m.__blurred = false;
  if (!bu) j.fail = true; // nothing small to load: the full image is the source
  else {
    const s = new Image();
    s.src = bu;
    s.decode().then(
      () => jobs.get(m) === j && ((j.src = s), kickBlurs()),
      () => jobs.get(m) === j && ((j.fail = true), j.big && ((j.src = j.big), kickBlurs()))
    );
  }
  return j;
}

/* the copies are missing: ask for them now (auto-advance) → true */
function needBlur(m) {
  const img = m.querySelector('img');
  if (m.__blurred || m.__failed || !img?.getAttribute('src')) return false;
  const j = jobs.get(m) || blurJob(m, m.__blurUrl, img.complete ? img : null);
  if (!j) return false;
  j.urgent = true;
  kickBlurs();
  return true;
}

/* resolves once the copies are drawn, or after `ms` */
function whenBlurred(m, ms) {
  if (m.__blurred) return Promise.resolve();
  const j = jobs.get(m);
  if (!j) return Promise.resolve();
  j.urgent = true;
  kickBlurs();
  return new Promise((res) => {
    j.waiters.push(res);
    setTimeout(res, ms);
  });
}

function dropBlurs(m) {
  const j = jobs.get(m);
  jobs.delete(m);
  for (const res of j?.waiters || []) res();
  m.__blurred = false;
  // a 0×0 canvas gives its backing store back
  for (const cv of m.querySelectorAll('canvas.homehero__blur')) cv.width = cv.height = 0;
}

function kickBlurs(ms = 0) {
  if (pumping || !jobs.size) return;
  pumping = true;
  setTimeout(() => idle(() => ((pumping = false), runBlur())), ms);
}

function runBlur() {
  if (document.hidden) return kickBlurs(1000);
  const now = performance.now();
  let best = null, bestRank = 9, held = false;
  for (const [m, j] of jobs) {
    if (!m.isConnected) {
      jobs.delete(m);
      continue;
    }
    if (!j.src) continue; // still loading: its decode kicks the queue
    const c = m.parentElement?.__carousel;
    if (c && (c.busy || c.anim)) {
      held = true;
      continue;
    }
    const rank = j.urgent ? 0 : m.dataset.role === 'base' ? 1 : 2;
    if (rank && now < BOOT_QUIET) {
      held = true;
      continue;
    }
    if (rank < bestRank) (best = m), (bestRank = rank);
  }
  if (!best) return held && kickBlurs(now < BOOT_QUIET ? BOOT_QUIET - now : 250);
  const j = jobs.get(best);
  const cv = best.querySelectorAll('canvas.homehero__blur')[j.step];
  if (cv) drawBlur(cv, j.src, BLUR_W[j.step] || BLUR_W[0]);
  if (++j.step >= BLUR_W.length || !cv) {
    jobs.delete(best);
    best.__blurred = true;
    best.__blurOf = j.url;
    for (const res of j.waiters) res();
    best.parentElement?.__carousel?.frame();
  }
  // one canvas per task; the background ones leave a gap for input and frames
  kickBlurs(bestRank ? 50 : 0);
}

/* One blurred copy, sized so the CSS upscale does most of the blurring and a
 * 3-pass box blur (≈ gaussian σ 1.4 canvas px) smooths the rest. A source
 * wider than 480 (the full backdrop, when the small one failed) is stepped
 * down to 480 first so the copy averages, not samples — what the small
 * rendition is. */
function drawBlur(cv, img, w) {
  let src = img, iw = img.naturalWidth, ih = img.naturalHeight;
  if (!iw || !ih) return;
  if (iw > 480) {
    const mid = document.createElement('canvas');
    mid.width = 480;
    mid.height = Math.max(1, Math.round((480 * ih) / iw));
    const mc = mid.getContext('2d', { willReadFrequently: true });
    if (!mc) return;
    mc.imageSmoothingQuality = 'high';
    mc.drawImage(img, 0, 0, mid.width, mid.height);
    (src = mid), (iw = mid.width), (ih = mid.height);
  }
  const h = Math.max(1, Math.round((w * ih) / iw));
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  try {
    const d = ctx.getImageData(0, 0, w, h);
    for (let p = 0; p < 3; p++) boxBlur(d.data, w, h, 1);
    ctx.putImageData(d, 0, 0);
  } catch {
    /* a tainted canvas (cross-origin art): the downscale alone still blurs */
  }
}

function boxBlur(px, w, h, r) {
  const tmp = new Uint8ClampedArray(px.length);
  const pass = (src, dst, len, lines, step, stride) => {
    for (let l = 0; l < lines; l++) {
      const base = l * stride;
      for (let i = 0; i < len; i++) {
        let s0 = 0, s1 = 0, s2 = 0, c = 0;
        for (let k = -r; k <= r; k++) {
          const j = i + k < 0 ? 0 : i + k >= len ? len - 1 : i + k;
          const o = base + j * step;
          s0 += src[o];
          s1 += src[o + 1];
          s2 += src[o + 2];
          c++;
        }
        const o = base + i * step;
        dst[o] = s0 / c;
        dst[o + 1] = s1 / c;
        dst[o + 2] = s2 / c;
        dst[o + 3] = 255;
      }
    }
  };
  pass(px, tmp, w, h, 4, w * 4); // rows
  pass(tmp, px, h, w, w * 4, 4); // columns
}

