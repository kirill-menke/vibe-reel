/* Shared-element "zoom" between a tile and the title page it opens (the App
 * Store card expansion), and back.
 *
 * The CARD is the real pushed route: it is scaled uniformly and clipped
 * (transform + clip-path, both keyframed) from the tapped tile's frame to the
 * full screen, so the page inside grows with it. The SHARED ELEMENT is an
 * overlay inside that route, under the page's content: a copy of the tile's
 * art that morphs (clip-path + a cover-fit transform) from the whole card
 * into the page's hero rect (`.detail__hero`, or `.person__photo`), with the
 * page's real backdrop crossfaded in over it once decoded. While it runs the
 * route carries `.zoom-card` (its .screen is transparent, so the overlay
 * shows through) and `.zoom-hide` (the real hero is hidden — the overlay
 * stands in for it pixel for pixel). Content fades/slides up in the second
 * half, the NavBar comes in at the end, the page underneath dims.
 *
 * Nothing needs wiring in tiles: a capture-phase click listener remembers
 * the last tapped `.tile` / `.cast`, and router.push() asks takeOrigin()
 * whether the page it is pushing was opened by that tap (same route, < 3 s —
 * lookupOpener() may search Jellyfin first). The origin is kept per pushed
 * route, so pop() / the edge swipe can shrink the page back into the tile —
 * re-measured then (the list may have scrolled or re-rendered; found again by
 * its image), or, when it is off screen, a quick fade + scale-down.
 *
 * Geometry is sampled: N keyframes of the eased progress, linear in between,
 * because the cover-fit scale of the art isn't linear in the rect. */
import { easeSheet as ease, EASE, DUR, spring } from './safe.js'; // ease = --ease-sheet

const ROUTES = new Set(['detail', 'lookup', 'pending', 'person']);
const TARGET = '.detail__hero, .person__photo';
const OPEN_MS = DUR.zoom; // 460
const CLOSE_MS = DUR.zoomOut; // 420
const N = 24;
const SLIDE = 28; // px the content rises while it fades in
const DIM = 0.6; // opacity of the page under a full card
const LINGER_MS = 2500; // longest wait for the backdrop after the morph
export const ZOOM_CLOSE_MS = CLOSE_MS;

/** @type {(x: number) => number} */
const cl = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** @type {(a: number, b: number, e: number) => number} */
const lerp = (a, b, e) => a + (b - a) * e;
/** @type {(v: number) => string} */
const px = (v) => Math.round(v * 100) / 100 + 'px';

/* ------------------------------------------------------------ the tap ---- */

/** @type {{ el: Element, t: number, routeKey: string | undefined } | null} */
let tap = null; // { el, t, routeKey }

if (typeof document !== 'undefined') {
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target instanceof Element ? e.target : null;
      const el = t?.closest('.tile, .cast');
      const route = /** @type {HTMLElement | null | undefined} */ (el?.closest('.route'));
      tap = el && route && !/** @type {Element} */ (t).closest('.tile__add') && frameOf(el) ? { el, t: performance.now(), routeKey: route.dataset.key } : null;
    },
    true
  );
}

/** @param {Element} el @returns {HTMLElement | null} */
function frameOf(el) {
  return el.querySelector(':scope > .tile__frame, :scope > .cast__photo');
}

/** @param {Element | null | undefined} frame @returns {string} */
function imgOf(frame) {
  /** @type {HTMLImageElement | null | undefined} */
  const i = frame?.querySelector('.art > img');
  return (i && i.getAttribute('src') && (i.currentSrc || i.src)) || '';
}

/* Per pushed route key: where it was opened from. */
/** @type {Map<string, VR.ZoomOrigin>} */
const origins = new Map();
/** @type {Map<string, VR.ZoomRun>} */
const running = new Map(); // route key → { now(), stop() }

/* router.push(): the origin of this navigation, or null (always clears the
 * remembered tap, so a stale one can't animate a later push). */
/** @param {VR.RouteName} name the route being pushed @param {string} fromKey the route it is pushed from
 * @returns {VR.ZoomOrigin | null} */
export function takeOrigin(name, fromKey) {
  const t = tap;
  tap = null;
  if (!t || !ROUTES.has(name) || t.routeKey !== fromKey || performance.now() - t.t > 3000 || !t.el.isConnected) return null;
  const frame = frameOf(t.el);
  const r = frame?.getBoundingClientRect();
  if (!r || r.width < 8 || r.height < 8) return null;
  return { el: t.el, src: imgOf(frame), cast: t.el.matches('.cast') };
}

/** @param {string} key @param {VR.ZoomOrigin | null} o */
export function rememberOrigin(key, o) {
  if (o) origins.set(key, o);
}
/** @param {string} key @returns {VR.ZoomOrigin | null} */
export function originOf(key) {
  return origins.get(key) || null;
}
/** @param {string} key */
export function forgetOrigin(key) {
  origins.delete(key);
}
/* App: drop origins of routes that are gone (popToRoot, the stack cap). */
/** @param {Set<string>} live the route keys still on a stack */
export function keepOrigins(live) {
  for (const k of origins.keys()) if (!live.has(k)) origins.delete(k);
}

/* ------------------------------------------------------------ geometry ---- */

/** @param {HTMLElement} route @returns {VR.ZoomBox} */
function boxOf(route) {
  const b = (route.parentElement || route).getBoundingClientRect();
  return { left: b.left, top: b.top, W: b.width, H: b.height };
}

/** @param {Element} el @param {number} w @param {number} h @returns {number} */
function radiusOf(el, w, h) {
  const v = getComputedStyle(el).borderTopLeftRadius || '0';
  const n = parseFloat(v) || 0;
  return Math.min(v.endsWith('%') ? (n / 100) * w : n, Math.min(w, h) / 2);
}

/* The tile's frame, unscaled (a pressed tile is mid-way through its press
 * transition), relative to the stage box. */
/** @param {Element} el @param {VR.ZoomBox} box @returns {VR.ZoomFrame | null} */
function frameRect(el, box) {
  const f = frameOf(el);
  if (!f) return null;
  let x, y, w, h;
  if (f.offsetParent === el) {
    const t = el.getBoundingClientRect();
    x = t.left + f.offsetLeft;
    y = t.top + f.offsetTop;
    w = f.offsetWidth;
    h = f.offsetHeight;
  } else {
    const b = f.getBoundingClientRect();
    ({ left: x, top: y, width: w, height: h } = b);
  }
  if (w < 8 || h < 8) return null;
  return { x: x - box.left, y: y - box.top, w, h, r: radiusOf(f, w, h), f };
}

/* Is a rect (stage coords) mostly on screen, and not under another page? */
/** @param {VR.ZoomRect} r @param {VR.ZoomBox} box @returns {boolean} */
function onScreen(r, box) {
  const vx = Math.max(0, Math.min(r.x + r.w, box.W) - Math.max(r.x, 0));
  const vy = Math.max(0, Math.min(r.y + r.h, box.H) - Math.max(r.y, 0));
  return (vx * vy) / (r.w * r.h) > 0.4;
}

/* The tile to shrink back into: the one it opened from if it is still there,
 * else a tile in that page showing the same image (the rail re-rendered). */
/** @param {VR.ZoomOrigin} o @param {HTMLElement} under @param {VR.ZoomBox} box @returns {VR.ZoomTile | null} */
function findTile(o, under, box) {
  /** @type {Array<Element | null>} */
  const cands = [];
  if (o.el.isConnected && under.contains(o.el)) cands.push(o.el);
  if (o.src)
    for (const img of /** @type {NodeListOf<HTMLImageElement>} */ (under.querySelectorAll('.tile__frame > .art > img, .cast__photo > .art > img')))
      if ((img.currentSrc || img.src) === o.src) cands.push(img.closest('.tile, .cast'));
  for (const el of cands) {
    const r = el && frameRect(el, box);
    if (r && onScreen(r, box)) return { el, ...r };
  }
  return null;
}

/* The page's hero (the art's destination), in the route's own coordinates.
 * The route must be untransformed when this runs. */
/** @param {HTMLElement} route @param {VR.ZoomBox} box @returns {VR.ZoomTarget | null} */
function targetOf(route, box) {
  const t = route.querySelector(TARGET);
  if (!t) return null;
  const b = t.getBoundingClientRect();
  if (b.width < 1 || b.height < 1) return null;
  return {
    el: t,
    x: b.left - box.left,
    y: b.top - box.top,
    w: b.width,
    h: b.height,
    r: radiusOf(t, b.width, b.height),
    hero: t.matches('.detail__hero'),
    empty: t.matches('.detail__hero--empty')
  };
}

/** @param {HTMLElement} route @returns {HTMLImageElement | null} the page's decoded backdrop */
function targetImg(route) {
  /** @type {HTMLImageElement | null} */
  const i = route.querySelector('.detail__hero > .art > img, .person__photo > .art > img');
  return i && i.getAttribute('src') && i.complete && i.naturalWidth > 0 ? i : null;
}

/* A state: C = card rect on screen (stage coords), r = its corner radius;
 * A = the page's hero rect (the art's destination, page coordinates), ar =
 * its radius; k = how much the art is "the whole card" instead (1 = the tile:
 * the art fills what the card shows); dim = the page underneath. The card
 * shows the page scaled uniformly (cover) with its top edge at the card's
 * top, centred across. */
/** @param {VR.ZoomRect} C @param {VR.ZoomBox} box */
function view(C, box) {
  const s = Math.max(C.w / box.W, C.h / box.H);
  const Lw = C.w / s;
  const Lh = C.h / s;
  return { s, Lw, Lh, lx: (box.W - Lw) / 2 };
}

/** @param {VR.ZoomFrame} T @param {VR.ZoomBox} box @param {number} dim @returns {VR.ZoomState} */
function tileState(T, box, dim) {
  return { C: { x: T.x, y: T.y, w: T.w, h: T.h }, r: T.r, A: null, ar: 0, k: 1, dim };
}

/** @param {VR.ZoomTarget | null | undefined} tg @param {VR.ZoomBox} box @param {number} dim @returns {VR.ZoomState} */
function fullState(tg, box, dim) {
  const A = tg ? { x: tg.x, y: tg.y, w: tg.w, h: tg.h } : { x: 0, y: 0, w: box.W, h: Math.min(440, box.H * 0.66) };
  return { C: { x: 0, y: 0, w: box.W, h: box.H }, r: 0, A, ar: tg ? tg.r : 0, k: 0, dim };
}

/** @type {(a: VR.ZoomRect, b: VR.ZoomRect, e: number) => VR.ZoomRect} */
const mixR = (a, b, e) => ({ x: lerp(a.x, b.x, e), y: lerp(a.y, b.y, e), w: lerp(a.w, b.w, e), h: lerp(a.h, b.h, e) });
/** @param {VR.ZoomState} a @param {VR.ZoomState} b @param {number} e @returns {VR.ZoomState} */
function mix(a, b, e) {
  const A = a.A && b.A ? mixR(a.A, b.A, e) : a.A || b.A;
  const ar = a.A && b.A ? lerp(a.ar, b.ar, e) : a.A ? a.ar : b.ar;
  return { C: mixR(a.C, b.C, e), r: lerp(a.r, b.r, e), A, ar, k: lerp(a.k, b.k, e), dim: lerp(a.dim, b.dim, e) };
}

/* The art rect/radius a state shows: the hero, pulled towards what the card
 * shows by k (so it fills the card exactly at the tile end, whatever the
 * card's aspect on the way). */
/** @param {VR.ZoomState} g @param {VR.ZoomBox} box @returns {{ A: VR.ZoomRect, ar: number }} */
function artOf(g, box) {
  const v = view(g.C, box);
  // sample() always mixes a tileState (A null) with a fullState, whose A is always set
  return { A: mixR(/** @type {VR.ZoomRect} */ (g.A), { x: v.lx, y: 0, w: v.Lw, h: v.Lh }, g.k), ar: lerp(g.ar, g.r / v.s, g.k) };
}

/** @param {VR.ZoomState} g @param {VR.ZoomBox} box */
function routeCss(g, box) {
  const { s, Lw, Lh, lx } = view(g.C, box);
  return {
    transformOrigin: '0 0',
    transform: `translate(${px(g.C.x - lx * s)},${px(g.C.y)}) scale(${Math.round(s * 1e4) / 1e4})`,
    clipPath: `inset(0px ${px(Math.max(0, box.W - lx - Lw))} ${px(Math.max(0, box.H - Lh))} ${px(Math.max(0, lx))} round ${px(g.r / s)})`
  };
}

/** @param {VR.ZoomRect} A @param {number} ar @param {VR.ZoomBox} box @returns {string} */
function artClip(A, ar, box) {
  const t = Math.max(0, A.y);
  const l = Math.max(0, A.x);
  const b = Math.max(0, box.H - A.y - A.h);
  const r = Math.max(0, box.W - A.x - A.w);
  return `inset(${px(t)} ${px(r)} ${px(b)} ${px(l)} round ${px(ar)})`;
}

/* cover-fit of a bw×bh box into A (transform-origin 0 0) */
/** @param {VR.ZoomRect} A @param {number} bw @param {number} bh @returns {string} */
function cover(A, bw, bh) {
  const k = Math.max(A.w / bw, A.h / bh);
  return `translate(${px(A.x + (A.w - bw * k) / 2)},${px(A.y + (A.h - bh * k) / 2)}) scale(${Math.round(k * 1e4) / 1e4})`;
}

/* ------------------------------------------------------------- overlay ---- */

/** @param {HTMLElement} route @param {VR.ZoomBox} box @param {Element | null} tileEl @param {VR.ZoomFrame | null} T
 * @returns {VR.ZoomOverlay} */
function makeOverlay(route, box, tileEl, T) {
  const ov = document.createElement('div');
  ov.className = 'zoom-art';
  ov.setAttribute('aria-hidden', 'true');
  ov.style.width = px(box.W);
  ov.style.height = px(box.H);
  const clip = document.createElement('div');
  clip.className = 'zoom-art__clip';
  ov.append(clip);
  /** @type {HTMLDivElement | null} */
  let poster = null;
  const f = tileEl && frameOf(tileEl);
  if (f && T) {
    poster = document.createElement('div');
    poster.className = 'zoom-art__poster';
    poster.style.width = px(T.w);
    poster.style.height = px(T.h);
    for (const c of f.querySelectorAll(':scope > .art, :scope > .cast__initials')) {
      const k = /** @type {Element} */ (c.cloneNode(true));
      k.querySelector('img')?.setAttribute('loading', 'eager');
      poster.append(k);
    }
    clip.append(poster);
  }
  route.prepend(ov);
  return { ov, clip, poster, pw: T?.w || 1, ph: T?.h || 1 };
}

/** @param {Element | null} tileEl @returns {number} */
function artOpacity(tileEl) {
  const a = tileEl && frameOf(tileEl)?.querySelector(':scope > .art');
  return a ? parseFloat(getComputedStyle(a).opacity) || 1 : 1;
}

/** @param {VR.ZoomOverlay} o @param {VR.ZoomTarget | null | undefined} tg @returns {HTMLDivElement | null} */
function addScrim(o, tg) {
  if (!tg?.hero) return null;
  const s = document.createElement('div');
  s.className = 'zoom-art__scrim';
  s.style.width = px(tg.w);
  s.style.height = px(tg.h);
  o.clip.append(s);
  return s;
}

/** @type {(A: VR.ZoomRect, tg: VR.ZoomTarget) => string} */
const scrimT = (A, tg) => `translate(${px(A.x)},${px(A.y)}) scale(${Math.round((A.w / tg.w) * 1e4) / 1e4},${Math.round((A.h / tg.h) * 1e4) / 1e4})`;

/** @param {VR.ZoomOverlay} o @param {HTMLImageElement} img @param {VR.ZoomBox} box @returns {VR.ZoomBackdrop} */
function addBackdrop(o, img, box) {
  const b = document.createElement('img');
  b.className = 'zoom-art__bd';
  b.alt = '';
  b.src = img.currentSrc || img.src;
  const bw = box.W;
  const bh = (box.W * img.naturalHeight) / img.naturalWidth;
  b.style.width = px(bw);
  b.style.height = px(bh);
  const sc = o.clip.querySelector('.zoom-art__scrim');
  o.clip.insertBefore(b, sc);
  return { el: b, bw, bh };
}

/* Content: every child of the route except the overlay (the .screen and the
 * NavBar). */
/** @param {HTMLElement} route @returns {Element[]} */
function kids(route) {
  return [...route.children].filter((c) => !c.classList.contains('zoom-art'));
}

/* ------------------------------------------------------------ samples ---- */

/** @param {VR.ZoomState} a @param {VR.ZoomState} b @param {(t: number) => Partial<VR.ZoomChannels>} chan @param {VR.ZoomBox} box
 * @param {number} [n] @param {VR.Easing} [e] @returns {VR.ZoomSample[]} */
function sample(a, b, chan, box, n = N, e = ease) {
  /** @type {VR.ZoomSample[]} */
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const g = mix(a, b, e(t));
    out.push({ t, g, art: artOf(g, box), c: chan(t) });
  }
  return out;
}

/** @param {VR.ZoomSample[]} fr @param {VR.ZoomBox} box @param {VR.ZoomParts} parts @param {number} dur @param {FillMode} [fill]
 * @returns {Animation[]} the route's first */
function animateAll(fr, box, parts, dur, fill = 'forwards') {
  /** @type {KeyframeAnimationOptions} */
  const opt = { duration: dur, easing: 'linear', fill };
  /** @type {Animation[]} */
  const list = [];
  /** @type {(fn: (f: VR.ZoomSample) => Keyframe) => Keyframe[]} */
  const kf = (fn) => fr.map((f) => ({ offset: f.t, ...fn(f) }));
  list.push(parts.route.animate(kf((f) => routeCss(f.g, box)), opt));
  if (parts.under) list.push(parts.under.animate(kf((f) => ({ opacity: f.g.dim })), opt));
  if (parts.o) {
    list.push(parts.o.clip.animate(kf((f) => ({ clipPath: artClip(f.art.A, f.art.ar, box) })), opt));
    if (parts.o.poster) list.push(parts.o.poster.animate(kf((f) => ({ transform: cover(f.art.A, /** @type {VR.ZoomOverlay} */ (parts.o).pw, /** @type {VR.ZoomOverlay} */ (parts.o).ph), opacity: f.c.po })), opt));
    if (parts.scrim) list.push(parts.scrim.animate(kf((f) => ({ transform: scrimT(f.art.A, /** @type {VR.ZoomTarget} */ (parts.tg)), opacity: f.c.scrim })), opt));
    if (parts.bd) list.push(parts.bd.el.animate(kf((f) => ({ transform: cover(f.art.A, /** @type {VR.ZoomBackdrop} */ (parts.bd).bw, /** @type {VR.ZoomBackdrop} */ (parts.bd).bh), ...(f.c.bd != null ? { opacity: f.c.bd } : {}) })), opt));
  }
  for (const k of kids(parts.route)) list.push(animateKid(k, fr, opt));
  return list;
}

/** @param {Element} k @param {VR.ZoomSample[]} fr @param {KeyframeAnimationOptions} opt @returns {Animation} */
function animateKid(k, fr, opt) {
  const nav = k.classList.contains('navbar');
  return k.animate(
    fr.map((f) =>
      nav
        ? { offset: f.t, opacity: f.c.nav }
        : { offset: f.t, opacity: f.c.content, transform: `translate3d(0,${px((1 - /** @type {number} */ (f.c.content)) * SLIDE)},0)` }
    ),
    opt
  );
}

/** @param {Element | null} el @returns {() => void} show it again */
function hideFrame(el) {
  const f = el && frameOf(el);
  if (f) f.style.visibility = 'hidden';
  return () => f && (f.style.visibility = '');
}

/* ------------------------------------------------------------ zoom in ---- */

/* Push: grow the new route `route` out of the origin tile over `under`.
 * Synchronous up to the first frame (call it before the browser paints the
 * newly shown route). Returns false when it can't (tile gone) — then the
 * caller runs the plain push; `done` is called when the geometry has landed. */
/** @param {VR.ZoomArgs} args @returns {boolean} */
export function zoomIn({ route, under, key, done }) {
  const o0 = origins.get(key);
  if (!o0 || !route || !route.isConnected) return false;
  const box = boxOf(route);
  const T = o0.el.isConnected ? frameRect(o0.el, box) : null;
  if (!T) return false;
  const tg = targetOf(route, box);
  const po0 = artOpacity(o0.el);
  const a = tileState(T, box, 1);
  const b = fullState(tg, box, DIM);
  /** @type {(t: number) => VR.ZoomChannels} */
  const chan = (t) => ({
    content: ease(cl((t - 0.38) / 0.5)),
    nav: cl((t - 0.72) / 0.28),
    scrim: cl((t - 0.2) / 0.6),
    po: lerp(po0, 1, cl(t / 0.3))
  });
  const fr = sample(a, b, chan, box);
  const o = makeOverlay(route, box, o0.el, T);
  const scrim = addScrim(o, tg);
  route.classList.add('zoom-card', 'zoom-hide');
  const showFrame = hideFrame(o0.el);
  const parts = { route, under, o, scrim, tg };
  const anims = animateAll(fr, box, parts, OPEN_MS);
  const master = anims[0];
  /** @type {(VR.ZoomBackdrop & { src: string, fade?: Animation }) | null} */
  let bd = null; // { el, bw, bh, fade, src }
  let bdIn = false;
  let stopped = false;
  let landed = false;
  /** @type {ReturnType<typeof setTimeout> | 0} */
  let lingerT = 0;
  /** @type {Element | null} */
  let scroller = null;

  /* the page swapped its content mid-way (Detail: skeleton → the real page):
   * give the new nodes the same fade, on the same clock */
  const mo = new MutationObserver((recs) => {
    for (const r of recs)
      for (const n of r.addedNodes)
        if (n instanceof Element && n.parentElement === route && !n.classList.contains('zoom-art') && !landed) {
          const k = animateKid(n, fr, { duration: OPEN_MS, easing: 'linear', fill: 'forwards' });
          k.startTime = master.startTime;
          anims.push(k);
        }
  });
  mo.observe(route, { childList: true });

  function tryBackdrop() {
    if (bd || stopped) return;
    const img = targetImg(/** @type {HTMLElement} */ (route));
    if (!img) return;
    const src = img.currentSrc || img.src;
    const b2 = addBackdrop(o, img, box);
    bd = { ...b2, src };
    const geo = b2.el.animate(
      fr.map((f) => ({ offset: f.t, transform: cover(f.art.A, b2.bw, b2.bh) })),
      { duration: OPEN_MS, easing: 'linear', fill: 'forwards' }
    );
    geo.startTime = master.startTime ?? geo.startTime;
    if (landed) geo.finish();
    anims.push(geo);
    const go = () => {
      if (stopped) return;
      /** @type {NonNullable<typeof bd>} */ (bd).fade = b2.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR.img, easing: 'linear', fill: 'forwards' });
      /** @type {Animation} */ (/** @type {NonNullable<typeof bd>} */ (bd).fade).onfinish = () => {
        bdIn = true;
        if (landed) finish(true);
      };
    };
    // decoded already (the page only sets src after decode); decode() here
    // just makes sure the copy paints on its first frame
    b2.el.decode ? b2.el.decode().then(go, go) : go();
  }
  const poll = setInterval(tryBackdrop, 50);
  tryBackdrop();

  /** @param {Event} e */
  function onScroll(e) {
    if (e.target === scroller) o.ov.style.transform = `translate3d(0,${px(-/** @type {Element} */ (scroller).scrollTop)},0)`;
  }

  // cancelled mid-open (clearAnims from a quick Back further up the stack);
  // after landing the finish path cancels its own animations on purpose
  master.oncancel = () => { if (!landed) stop('cut'); };
  master.onfinish = () => {
    if (stopped) return;
    landed = true;
    mo.disconnect();
    // the page is at rest: drop the route/content animations (their end
    // state is the identity), keep the overlay's until the swap
    for (const x of anims) if (/** @type {KeyframeEffect | null} */ (x.effect)?.target && !o.ov.contains(/** @type {KeyframeEffect} */ (x.effect).target)) x.cancel();
    showFrame();
    done?.();
    const t = targetOf(route, box);
    if (bdIn) return finish(true);
    if (!t || t.empty || !t.hero) {
      // no backdrop coming (or a person photo, which loads by itself)
      if (!bd) return finish(false);
    }
    // wait for the backdrop a little longer; follow the page's scroll meanwhile
    scroller = route.querySelector(TARGET)?.closest('.screen') || route.querySelector('.screen');
    route.addEventListener('scroll', onScroll, true);
    lingerT = setTimeout(() => finish(false), LINGER_MS);
  };

  /* The overlay goes: at once if the real hero now shows the same image,
   * else the real hero fades in over it. */
  /** @param {boolean} match */
  function finish(match) {
    if (stopped) return;
    stop(match ? 'swap' : 'fade');
  }

  /** @param {VR.ZoomStop} [how] */
  function stop(how = 'cut') {
    if (stopped) return;
    stopped = true;
    clearInterval(poll);
    clearTimeout(lingerT);
    mo.disconnect();
    /** @type {HTMLElement} */ (route).removeEventListener('scroll', onScroll, true);
    running.delete(key);
    const clear = () => {
      /** @type {HTMLElement} */ (route).classList.remove('zoom-card', 'zoom-hide');
      o.ov.remove();
    };
    for (const x of anims) if (!o.ov.contains(/** @type {Element | null} */ (/** @type {KeyframeEffect | null} */ (x.effect)?.target))) x.cancel();
    showFrame();
    if (how === 'fade') {
      /** @type {HTMLElement} */ (route).classList.remove('zoom-hide');
      const t = /** @type {HTMLElement} */ (route).querySelector(TARGET);
      const f = t?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR.fast, easing: 'linear' });
      if (f) f.onfinish = f.oncancel = clear;
      else clear();
    } else clear();
    if (!landed) done?.();
  }

  running.set(key, {
    /* where the card is right now (for a pop that interrupts it) */
    now() {
      const t = landed ? 1 : cl((/** @type {number | null} */ (master.currentTime) || 0) / OPEN_MS);
      const g = mix(a, b, ease(t));
      const c = chan(t);
      return { g, c: { ...c, bd: bd ? (bdIn ? 1 : cl((/** @type {number | null | undefined} */ (bd.fade?.currentTime) || 0) / 200)) : 0 }, bdSrc: bd?.src || '', scroll: scroller?.scrollTop || 0, landed };
    },
    stop
  });
  return true;
}

/* ----------------------------------------------------------- zoom out ---- */

/* Pop: shrink `route` back into its origin tile in `under`. `start` (a state
 * from the edge swipe) defaults to where the card is now (full screen, or
 * mid-open). `easing` (t → progress) replaces the sheet curve — the edge
 * swipe's release spring. Resolves when done; the caller removes the route. */
/** @param {VR.ZoomOutArgs} args @returns {Promise<void>} */
export function zoomOut({ route, under, key, start = null, dur = CLOSE_MS, easing = ease }) {
  return new Promise((/** @type {(v?: void) => void} */ resolve) => {
    const o0 = origins.get(key);
    origins.delete(key);
    if (!route || !route.isConnected || !under) return resolve();
    const box = boxOf(route);
    /** @type {ReturnType<VR.ZoomRun['now']> | null} */
    let cur = null;
    const run = running.get(key);
    if (run) {
      cur = run.now(); // mid-open: start from where the card is
      run.stop('cut');
      if (cur.landed) cur = null; // only waiting for the backdrop: measure afresh
    }
    // the route is untransformed now (unless a drag holds it: then `start` says where it is)
    const tg = start?.tg !== undefined ? start.tg : targetOf(route, box);
    const img = targetImg(route);
    const T = o0 ? findTile(o0, under, box) : null;
    const from = start?.g || cur?.g || fullState(tg, box, DIM);
    const c0 = start?.c || cur?.c || { content: 1, nav: 1, scrim: 1, po: 0, bd: img ? 1 : 0 };

    if (!T) {
      // the tile is off screen (or gone): shrink a little and fade out
      /** @type {VR.ZoomState} */
      const to = { ...from, C: { x: box.W * 0.07, y: box.H * 0.07, w: box.W * 0.86, h: box.H * 0.86 }, r: 28, dim: 1 };
      const fr = sample(from, to, () => ({ content: 1, nav: 1, scrim: 1, po: 1 }), box, 8);
      const d = Math.min(dur, 280);
      const rt = route.animate(
        fr.map((f) => ({ offset: f.t, ...routeCss(f.g, box), opacity: 1 - f.t })),
        { duration: d, easing: 'linear', fill: 'forwards' }
      );
      under.animate([{ opacity: from.dim }, { opacity: 1 }], { duration: d, easing: EASE.out, fill: 'forwards' });
      rt.onfinish = rt.oncancel = () => {
        clearAnims(under);
        resolve();
      };
      return;
    }

    const to = tileState(T, box, 1);
    const poEnd = artOpacity(T.el);
    const o = makeOverlay(route, box, T.el, T);
    const scrim = addScrim(o, tg);
    /* With the backdrop decoded, the overlay takes over the hero (hidden) and
     * crossfades it back to the poster. Without one the hero (placeholder,
     * skeleton) fades out with the rest of the content, over the poster. */
    const bd = img && /** @type {number} */ (c0.bd) > 0 ? addBackdrop(o, img, box) : null;
    /** @type {(t: number) => VR.ZoomChannels} */
    const chan = (t) => ({
      content: c0.content * (1 - cl(t / 0.3)),
      nav: c0.nav * (1 - cl(t / 0.15)),
      scrim: c0.scrim * (1 - cl((t - 0.1) / 0.4)),
      bd: bd ? /** @type {number} */ (c0.bd) * (1 - cl((t - 0.12) / 0.4)) : null,
      po: bd || !cur ? poEnd : lerp(c0.po * poEnd, poEnd, cl(t / 0.3))
    });
    // (the page may have scrolled since it opened: the hero rect says so)
    const fr = sample(from, to, chan, box, N, easing);
    route.classList.add('zoom-card');
    if (bd || cur) route.classList.add('zoom-hide');
    const showFrame = hideFrame(T.el);
    const anims = animateAll(fr, box, { route, under, o, scrim, tg, bd }, dur);
    anims[0].onfinish = anims[0].oncancel = () => {
      showFrame();
      clearAnims(under);
      resolve();
    };
  });
}

/** @param {HTMLElement | null | undefined} el */
function clearAnims(el) {
  if (!el) return;
  for (const a of el.getAnimations()) a.cancel();
  el.style.opacity = '';
}

/* --------------------------------------------------------- edge swipe ---- */

/* For gestures.edgeSwipeBack: a controller that makes the swipe shrink the
 * card with the finger (iOS card dismissal) instead of sliding the page — or
 * null when the page wasn't opened from a tile (plain slide then). */
/** @param {VR.ZoomArgs} args @returns {VR.SwipeDragController | null} */
export function zoomDrag({ route, under, key }) {
  if (!origins.has(key) || !route || !under) return null;
  const run = running.get(key);
  if (run) run.stop('cut');
  const box = boxOf(route);
  const tg = targetOf(route, box);
  const img = targetImg(route);
  let g = fullState(tg, box, DIM);
  let lastDx = 0;
  /** @param {number} dx @param {number} dy @returns {VR.ZoomState} */
  function state(dx, dy) {
    const p = cl(dx / box.W);
    const s = 1 - 0.3 * p;
    const w = box.W * s;
    const h = box.H * s;
    return {
      ...g,
      C: { x: (box.W - w) / 2 + dx * 0.35, y: (box.H - h) / 2 + dy * 0.3, w, h },
      r: 36 * cl(p * 6),
      dim: DIM + (1 - DIM) * p * 0.6
    };
  }
  return {
    /* the projected release point must pass 30 % (the slide's: 50 %) — the
     * card is already small by then */
    threshold: 0.3,
    /** @param {number} dx @param {number} dy */
    paint(dx, dy) {
      lastDx = Math.max(0, dx);
      g = state(lastDx, dy);
      const css = routeCss(g, box);
      route.style.transformOrigin = css.transformOrigin;
      route.style.transform = css.transform;
      route.style.clipPath = css.clipPath;
      under.style.opacity = String(g.dim);
    },
    /* settle on a spring that starts at the finger's speed (v, px/ms): the
     * card's travel is read along the drag — to the full width on a commit,
     * back to 0 on a cancel */
    /** @param {boolean} done @param {() => void} then @param {number} [v] */
    end(done, then, v = 0) {
      const from = g;
      const clearInline = () => {
        route.style.transform = route.style.clipPath = route.style.transformOrigin = '';
        under.style.opacity = '';
      };
      if (done) {
        const sp = spring(v / Math.max(40, box.W - lastDx));
        const p = zoomOut({
          route,
          under,
          key,
          start: { g: from, tg, c: { content: 1, nav: 1, scrim: 1, po: 0, bd: img ? 1 : 0 } },
          dur: Math.max(200, sp.duration),
          easing: sp.at
        });
        clearInline(); // the animation (fill: forwards) holds the same state now
        p.then(then);
        return;
      }
      const to = fullState(tg, box, DIM);
      const sp = spring(lastDx > 1 ? -v / lastDx : 0);
      const fr = sample(from, to, () => ({}), box, 12, sp.at);
      const d = sp.duration;
      const a = route.animate(fr.map((f) => ({ offset: f.t, ...routeCss(f.g, box) })), { duration: d, easing: 'linear' });
      under.animate([{ opacity: from.dim }, { opacity: DIM }], { duration: d, easing: 'linear', fill: 'forwards' });
      clearInline(); // the animation holds the same state now
      a.onfinish = a.oncancel = () => {
        clearAnims(under);
        then();
      };
    }
  };
}
