import { tick } from 'svelte';
import { S } from './nav.svelte.js';

/* D-pad focus is geometric, not a tab order. Everything here reads the live DOM
 * and measures with getBoundingClientRect(), so any caller that focuses right
 * after a state change must await tick() first — otherwise it measures the DOM
 * as it was before Svelte applied the update. focusKey() does that for you. */

/* Candidates for a D-pad move. Measured on the TV (Top 250 chart, 272 matches,
 * 85 shown): `offsetParent !== null` cost ~3 ms per press — each read forces
 * layout and walks the ancestors — while `checkVisibility()` gives the same set
 * (no box ⇒ false; none of these elements is position:fixed, the one case where
 * offsetParent differs) in ~1 ms. `:not([hidden])` drops the chart's windowed-out
 * tiles (and every other `[hidden]`, which style.css forces to display:none)
 * inside the selector engine, before any per-element call. */
const FOCUSABLE = '.focus:not([hidden]), .opt:not([hidden])';
const shown = (e) => !e.disabled && e.checkVisibility();

export function focusables() {
  // During playback only the OSD / audio-subtitle panel is navigable — the
  // detail page is still mounted behind the video layer, so without this the
  // D-pad would wander onto those hidden-behind controls (which is why the
  // subtitle button used to be reachable only with the pointer).
  let root = document;
  if (S.search && S.screen !== 'player') {
    // The Search overlay covers the (faded-out) browse screen — only its bar
    // and result cards are reachable.
    root = document.getElementById('search') || document;
  } else if (S.screen === 'player') {
    // The playback error card and the chapter list (VideoLayer/Osd) are modal
    // the same way the audio/subtitle panel is.
    const menu =
      document.getElementById('play-error') ||
      document.getElementById('chapter-menu') ||
      document.getElementById('player-menu');
    if (menu && !menu.hidden) root = menu;                       // panel open → only its rows
    else root = document.getElementById('video-layer') || document;
  } else {
    // Browse screens: scope to the mounted screen, so the scan never walks the
    // session-long overlays (video layer, Search).
    const scr = document.querySelector('.screen');
    // An open library-bar dropdown is modal: only its rows until OK or Back.
    const menu = scr && scr.querySelector('.lvmenu');
    if (menu) return Array.from(menu.querySelectorAll(FOCUSABLE)).filter((e) => e.checkVisibility());
    if (scr) return Array.from(scr.querySelectorAll(FOCUSABLE)).filter(shown);
  }
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter(shown);
}

export function byKey(key) {
  return document.querySelector(`[data-focus="${key}"]`);
}

/* focus() *without* the engine's own scroll-into-view: that one is instant and
 * would fire before ensureVisible() gets a say, so every focus move would jump
 * first and only then glide. All D-pad focusing goes through here. */
export function focusEl(el) {
  if (!el) return false;
  // While Search is up, the faded screen behind it can't take focus back — a
  // tab that finishes loading under it would otherwise grab it from Search.
  if (S.search && !el.closest('#search')) return false;
  el.focus({ preventScroll: true });
  ensureVisible(el);
  return true;
}

/* Focus a key after Svelte has flushed — the common case for "render this
 * screen, then put focus on its primary action". */
export async function focusKey(key) {
  await tick();
  return focusEl(byKey(key));
}

/* focusKey() for a return to a remembered spot: scrollers jump, no glide. */
export async function focusKeyInstant(key) {
  await tick();
  instant = true;
  setTimeout(() => (instant = false), 0);
  return focusEl(byKey(key));
}

/* Synchronous variant for handlers that run against DOM already on screen. */
export function focusNow(key) {
  return focusEl(byKey(key));
}

export async function focusFirst() {
  await tick();
  const all = focusables();
  const pref = S.focusKey && byKey(S.focusKey);
  // S.focusKey can name a control that is no longer reachable — after playback
  // it is an OSD key (c-play…) inside the now-[hidden] video layer, and focusing
  // that left Login (a 401 on the way out of the player) with focus on <body>.
  const el = (pref && all.includes(pref) ? pref : null) || all[0];
  if (el) focusEl(el);
  else document.body.focus();
}

/* ---------------- smooth scrolling ----------------
 * Every scroll a focus move needs is an *animated* one: fast off the mark, then
 * settling — the Apple TV feel. The curve is an exponential ease-out (distance
 * decays by 1/e every TAU ms), chosen because it retargets for free: remote
 * auto-repeat fires a new ensureVisible() every few frames, and moving `to`
 * mid-flight just bends the same motion instead of restarting it.
 *
 * Cost discipline for this TV: ONE rAF loop for every scroller, and the only
 * layout read is `el[prop]` at retarget time — the caller has just measured
 * rects, so that read is free and the frames afterwards are pure writes. */
const SCROLL_TAU = 75;    // ms; ~330ms to land, the tail is a few px
const SCROLL_EPS = 0.5;   // px; below this, snap and stop
const AXES = ['y', 'x'];

const scrollAnims = new Map();   // scroller element -> { y, x } axis states
let scrollRaf = 0;
let scrollTimer = 0;
let scrollPrev = 0;

/* Same reason spatialMove() carries a setTimeout backstop: webOS can starve rAF
 * while the hardware video plane is up, and a glide that never gets another
 * frame would leave a scroller stuck mid-glide. Whichever fires first
 * drives the frame and cancels the other. */
function scheduleScroll() {
  if (!scrollRaf) scrollRaf = requestAnimationFrame(scrollTick);
  if (!scrollTimer) scrollTimer = setTimeout(scrollTick, 32);
}

function scrollTick() {
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
  if (scrollTimer) clearTimeout(scrollTimer);
  scrollRaf = 0;
  scrollTimer = 0;
  scrollFrame(performance.now());
}

/* Restoring focus after a remount (Back to Home or a grid) jumps the scrollers
 * straight to the target instead of gliding there from 0: the glide painted —
 * and fetched posters for — every row it passed, ~330 ms of motion that only
 * showed the page rebuilding. Armed by focusKeyInstant() for the rest of the
 * current task, so the follow-up scrolls a focus handler queues in microtasks
 * (Home's snap of the rail under the hero) jump as well. */
let instant = false;

function scrollBy(el, axis, delta) {
  if (!delta) return;
  const prop = axis === 'y' ? 'scrollTop' : 'scrollLeft';
  if (instant) {
    const st0 = scrollAnims.get(el);
    if (st0) st0[axis] = null;
    el[prop] += delta;
    return;
  }
  // Measure once per retarget: `delta` came from rects taken against the live
  // offset, so cur + delta is the absolute target no matter where the running
  // animation currently is.
  const cur = el[prop];
  const max = axis === 'y' ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
  const to = Math.max(0, Math.min(Math.max(0, max), cur + delta));
  if (Math.abs(to - cur) < SCROLL_EPS) return;
  let st = scrollAnims.get(el);
  if (!st) {
    st = { y: null, x: null };
    scrollAnims.set(el, st);
  }
  st[axis] = { prop, cur, to };
  if (!scrollRaf && !scrollTimer) {
    scrollPrev = 0;
    scheduleScroll();
  }
}

function scrollFrame(now) {
  const dt = scrollPrev ? Math.min(64, now - scrollPrev) : 16;
  scrollPrev = now;
  const f = 1 - Math.exp(-dt / SCROLL_TAU);
  let live = false;
  for (const [el, st] of scrollAnims) {
    if (!el.isConnected) {
      scrollAnims.delete(el);   // screen remounted mid-glide
      continue;
    }
    for (const axis of AXES) {
      const a = st[axis];
      if (!a) continue;
      const d = a.to - a.cur;
      if (Math.abs(d) < SCROLL_EPS) {
        el[a.prop] = a.to;
        st[axis] = null;
        continue;
      }
      a.cur += d * f;
      el[a.prop] = a.cur;
      live = true;
    }
    if (!st.y && !st.x) scrollAnims.delete(el);
  }
  if (live) scheduleScroll();
  else scrollPrev = 0;
}

/* Animated absolute / relative scrolls for the places that drive a scroller
 * directly (the detail pages snapping their hero back to the top, the player's
 * dropdown keeping a focused row in view). Going through the same animator is what keeps those
 * from fighting an ensureVisible() glide that is still in flight. */
export function scrollElTo(el, top) {
  if (!el) return;
  /* An absolute target the scroller already sits at must still win over a
   * glide that an earlier ensureVisible() of the same focus turn started —
   * scrollBy() alone would treat it as a no-op and let that glide run on. */
  const max = Math.max(0, el.scrollHeight - el.clientHeight);
  const to = Math.max(0, Math.min(max, top));
  const st = scrollAnims.get(el);
  if (Math.abs(to - el.scrollTop) < SCROLL_EPS) {
    if (st) st.y = null;
    return;
  }
  scrollBy(el, 'y', to - el.scrollTop);
}

/* Instant absolute scroll that also drops any glide in flight on `el`. A bare
 * `el.scrollTop = …` loses to a running glide: its next frame writes the glide's
 * own position back (Browse's openChart() reset to the top was undone that way). */
export function jumpScroll(el, top, axis = 'y') {
  if (!el) return;
  const st = scrollAnims.get(el);
  if (st) {
    st[axis] = null;
    if (!st.y && !st.x) scrollAnims.delete(el);
  }
  el[axis === 'y' ? 'scrollTop' : 'scrollLeft'] = top;
}

export function scrollElBy(el, dy) {
  if (el) scrollBy(el, 'y', dy);
}

export function ensureVisible(elm) {
  if (!elm || !elm.closest) return;
  const strip = elm.closest('.strip, .cast-strip');
  if (strip) {
    const er = elm.getBoundingClientRect();
    const sr = strip.getBoundingClientRect();
    const pad = 90;
    if (er.left < sr.left + pad) scrollBy(strip, 'x', er.left - (sr.left + pad));
    else if (er.right > sr.right - pad) scrollBy(strip, 'x', er.right - (sr.right - pad));
  }
  const page = elm.closest('.page');
  if (page) {
    const e2 = elm.getBoundingClientRect();
    const pr = page.getBoundingClientRect();
    const vp = 150;
    if (e2.top < pr.top + vp) scrollBy(page, 'y', e2.top - (pr.top + vp));
    else if (e2.bottom > pr.bottom - vp) scrollBy(page, 'y', e2.bottom - (pr.bottom - vp));
  }
  const qrows = elm.closest('.qrows');
  if (qrows) {
    const e3 = elm.getBoundingClientRect();
    const qr = qrows.getBoundingClientRect();
    const qp = 70;
    if (e3.top < qr.top + qp) scrollBy(qrows, 'y', e3.top - (qr.top + qp));
    else if (e3.bottom > qr.bottom - qp) scrollBy(qrows, 'y', e3.bottom - (qr.bottom - qp));
  }
}

/* Score candidates by distance with a 3× orthogonal penalty; horizontal moves
 * additionally require ≥40% vertical overlap so ◀▶ stays on its row, and
 * vertical moves require the opposite — the candidate must clear the current
 * rect vertically, so ▲▼ can never land on a sibling in the same row.
 *
 * Remote auto-repeat outpaces layout on the TV: each move scans + measures every
 * candidate and then scrolls (a layout write), so back-to-back repeats each force
 * a fresh full relayout. Coalesce to one move per frame, keeping the latest
 * direction. The setTimeout backstop matters: webOS can starve rAF while the
 * hardware video plane is active, and without it a queued move would wedge
 * `moveKey` and kill the D-pad. */
let moveKey = null;

function flushMove() {
  const k = moveKey;
  moveKey = null;
  if (k != null) doSpatialMove(k);
}

export function spatialMove(key) {
  const queued = moveKey != null;
  moveKey = key;
  if (!queued) {
    requestAnimationFrame(flushMove);
    setTimeout(flushMove, 50);
  }
}

/* ---- lost focus ----
 * When the focused element is removed from the DOM (a pending tile whose title
 * finished importing, an episode row, a closed dropdown) the engine leaves
 * document.activeElement on <body> — or, on this Chromium, sometimes still on
 * the detached node. Measuring from either is useless: <body>'s box is the
 * whole screen, so ▲▼ find nothing that "clears" it and ◀▶ jump to its middle.
 * So every focusin remembers where the focus sat (re-measured once the
 * ensureVisible() glide has settled), and a lost focus is recovered to the
 * focusable nearest that spot instead. */
let lastRect = null;
let lastEl = null;
let lastTimer = 0;

function rectOf(el) {
  const r = el.getBoundingClientRect();
  return r.width || r.height ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
}

if (typeof document !== 'undefined') {
  document.addEventListener(
    'focusin',
    (e) => {
      const t = e.target;
      if (!t || t === document.body || !t.getBoundingClientRect) return;
      lastEl = t;
      lastRect = rectOf(t) || lastRect;
      clearTimeout(lastTimer);
      lastTimer = setTimeout(() => {
        if (lastEl === t && t.isConnected) lastRect = rectOf(t) || lastRect;
      }, 450);
    },
    true
  );
}

/* true when there is no real current element to move from */
export function focusLost() {
  const a = document.activeElement;
  return !a || a === document.body || a === document.documentElement || !a.isConnected;
}

/* The focusable (in the current scope) closest to where focus last was, or the
 * first one when there is no remembered spot. */
function nearestToLast(all) {
  if (!all.length) return null;
  if (!lastRect) return all[0];
  const cx = lastRect.left + lastRect.width / 2;
  const cy = lastRect.top + lastRect.height / 2;
  let best = all[0];
  let bs = Infinity;
  for (const e of all) {
    const r = e.getBoundingClientRect();
    const d = Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy);
    if (d < bs) {
      bs = d;
      best = e;
    }
  }
  return best;
}

/* For screens that just removed something that may have held focus: if focus
 * is lost, put it back on the nearest focusable. No-op otherwise. Awaits
 * tick() — the removal has to be flushed before anything can be measured. */
export async function recoverFocus() {
  await tick();
  if (!focusLost()) return false;
  const el = nearestToLast(focusables());
  return el ? focusEl(el) : false;
}

function doSpatialMove(key) {
  let cur = document.activeElement;
  if (focusLost()) cur = null;
  const all = focusables().filter((e) => e !== cur);
  if (!cur || !cur.getBoundingClientRect) {
    // Recover rather than move: the press lands focus where the user was.
    const el = nearestToLast(all);
    if (el) focusEl(el);
    return;
  }
  const c = cur.getBoundingClientRect();
  lastRect = rectOf(cur) || lastRect;
  const cx = c.left + c.width / 2;
  const cy = c.top + c.height / 2;
  let best = null;
  let bs = Infinity;
  for (const e of all) {
    const r = e.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    let primary;
    let ortho;
    if (key === 37 || key === 39) {
      const vov = Math.min(c.bottom, r.bottom) - Math.max(c.top, r.top);
      if (vov < Math.min(c.height, r.height) * 0.4) continue;
      if (key === 37) {
        if (dx >= -4) continue;
        primary = -dx;
        ortho = Math.abs(dy);
      } else {
        if (dx <= 4) continue;
        primary = dx;
        ortho = Math.abs(dy);
      }
    } else {
      // ▲▼ must leave the row: the candidate has to clear the current rect
      // vertically, not merely have a centre a few px above/below it. A centre
      // test alone let ▼ slide sideways along the last rail, because the
      // focused tile is scaled up (`transform-origin: center bottom`) so its
      // measured centre sits ~10px above its same-row neighbours'. This is the
      // mirror of the ≥40%-overlap rule that keeps ◀▶ on its row; when nothing
      // qualifies the move is a no-op, which is what "already at the bottom"
      // should do.
      const vov = Math.min(c.bottom, r.bottom) - Math.max(c.top, r.top);
      if (vov > Math.min(c.height, r.height) * 0.5) continue;
      if (key === 38) {
        if (dy >= -4) continue;
        primary = -dy;
      } else {
        if (dy <= 4) continue;
        primary = dy;
      }
      // Sideways cost is the gap between the two rects' x-ranges, not between
      // centres: a wide tile that sits over the focused one (Next Up's 420px
      // stills under a 236px poster) has its centre far off to the side, and a
      // centre penalty let ▼ skip that whole rail for a tile two rails down.
      // The small centre term only breaks ties between overlapping candidates.
      const gap = Math.max(0, r.left - c.right, c.left - r.right);
      ortho = gap + Math.abs(dx) / 12;
    }
    const sc = primary + ortho * 3;
    if (sc < bs) {
      bs = sc;
      best = e;
    }
  }
  if (best) focusEl(best);
}

/* A tile title longer than the tile stays clipped; on focus it scrolls so the
 * full name is readable, then resets on blur. The moving element is the inner
 * .ti span: its inline-block width is the real text width on any engine (the
 * webOS webview gives flex-stretched blocks a min-content floor, which made
 * `.t` itself unmeasurable — scrollWidth == clientWidth — so the marquee never
 * fired and the title bled over the neighbouring tile), and it animates with
 * transform, which stays on the compositor — text-indent reflowed every frame.
 *
 * The motion is deliberately dumb and identical everywhere in the app: a beat
 * of stillness, then *linear* travel at a fixed px/s (a long title takes longer,
 * it does not move faster), a longer hold parked at the end, then an instant
 * snap back to the start — never a reverse scroll. The loop boundary is what
 * produces the snap, so the last keyframe sits at the end position.
 *
 * Why Web Animations rather than a CSS @keyframes rule: keyframe offsets are
 * percentages of the duration, so a fixed CSS rule cannot hold "0.5s at the
 * start" while the travel time varies with the overrun — the holds would
 * stretch with the title length and short titles would flick past. Computing
 * the offsets here keeps both the speed and the two holds constant. It is still
 * a declarative transform-only timeline: composited, zero per-frame JS. */
const MQ_SPEED = 70;       // px/s of travel — the one speed used app-wide
const MQ_HOLD_HEAD = 0.5;  // s of stillness before it starts moving
const MQ_HOLD_TAIL = 1.4;  // s parked at the end, so the tail can be read
/* Loops before the title settles back to its idle ellipsis. A running marquee
 * keeps the compositor drawing every vsync, holds included — measured on the C4:
 * ~57 draws/s and ~16% of one core (WebAppMgr browser + renderer) for as long as
 * a long title sits focused, vs ~0 once it stops. Three passes is plenty to read. */
const MQ_LOOPS = 3;

let mqEl = null;
let mqAnim = null;

export function clearMarquee() {
  if (mqAnim) {
    mqAnim.cancel();
    mqAnim = null;
  }
  if (mqEl) {
    mqEl.classList.remove('mq');
    mqEl = null;
  }
}

export function marqueeFocus(el) {
  /* `.cap .t` is the caption under a rail tile, `.cap-on .t` the one painted on
   * a library-grid poster — the same span, the same treatment. A tile has one
   * or the other, never both. */
  const t = el && el.querySelector ? el.querySelector('.cap .t, .cap-on .t') : null;
  /* Already scrolling this exact title (focusin re-fires, the pointer moves
   * between a tile's children) — let it keep running instead of restarting. */
  if (t && t === mqEl) return;
  clearMarquee();
  if (!t) return;
  const ti = t.querySelector('.ti');
  if (!ti) return;
  const over = ti.scrollWidth - t.clientWidth;
  if (over <= 4) return;
  const dist = over + 12;                  // +12 so the last glyph clears the edge
  const travel = dist / MQ_SPEED;
  const total = MQ_HOLD_HEAD + travel + MQ_HOLD_TAIL;
  t.classList.add('mq');
  mqEl = t;
  const home = 'translateX(0)';
  const away = `translateX(${-dist}px)`;
  mqAnim = ti.animate(
    [
      { offset: 0, transform: home },
      { offset: MQ_HOLD_HEAD / total, transform: home },
      { offset: (MQ_HOLD_HEAD + travel) / total, transform: away },
      { offset: 1, transform: away }
    ],
    { duration: total * 1000, iterations: MQ_LOOPS, easing: 'linear' }
  );
  /* Settle into the idle look (start position, ellipsis). mqEl stays set, so a
   * re-fired focusin on the same tile doesn't start it over. */
  mqAnim.onfinish = () => t.classList.remove('mq');
}

/* transport button row (left→right) for explicit ◀▶ navigation in the OSD */
export function playerButtons() {
  const btns = Array.from(document.querySelectorAll('.controls .cbtn, .controls .pillbtn'));
  // The Skip Intro chip and the Up Next card aren't part of the transport, but
  // they sit above its right end and are only up for a minute at a time —
  // append them so ▶ off the end of the row reaches them and ◀ walks back into
  // the controls.
  for (const id of ['skip-intro', 'up-next']) {
    const chip = document.getElementById(id);
    if (chip && !chip.hidden) btns.push(chip);
  }
  return btns;
}
