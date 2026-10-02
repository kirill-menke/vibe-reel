/* DEV SERVER ONLY — injected into index.html by phone/dev/plugin.js (serve
 * mode), never part of a build. Makes the phone app drivable by a mouse in
 * desktop Chrome and lets the /__frame page (or a CDP/Claude-in-Chrome script)
 * set the environment. See phone/DEV-CHROME.md.
 *
 *   mouse → touch     a left-button mouse drag also dispatches touchstart /
 *                     touchmove / touchend (edge-swipe back and the sheet
 *                     body drag listen to touch only); a drag
 *                     that moved swallows the click after it, as a touch would
 *   right-click       = long-press (a synthetic 600 ms touch hold)
 *   + / −  keys       pinch out / in (player fit ↔ fill)
 *   ?safe=t,r,b,l     emulated safe-area insets in px (`off` = env()); kept
 *                     in sessionStorage across the devlogin reload
 *   ?rm=1             reduced motion (JS matchMedia + the CSS @media rules)
 *   ?offline=1        /jf + /ml fetches fail, navigator.onLine = false
 *   ?mouse=0          no mouse → touch translation
 *   ?allowplay=1      let real Jellyfin playback through (blocked by default:
 *                     PlaybackInfo / Sessions/Playing answer 403)
 *
 * window.__reelDev: setSafe([t,r,b,l]|null), setReducedMotion(bool|null),
 * setOffline(bool), setAllowPlay(bool), swipeBack(), pinch('in'|'out'), longpress(el|sel),
 * state(). Touch translation switches itself off on the first real touch or
 * under touch emulation (navigator.maxTouchPoints > 0). */

const qs = new URLSearchParams(location.search);
const ss = {
  get(k) {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      if (v == null) sessionStorage.removeItem(k);
      else sessionStorage.setItem(k, v);
    } catch {}
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------- safe areas */
const SIDES = ['top', 'right', 'bottom', 'left'];
let safe = null;

function parseSafe(v) {
  if (v == null) return undefined;
  if (v === '' || v === 'off' || v === 'none') return null;
  const a = String(v).split(',').map(Number);
  if (a.length === 1 && Number.isFinite(a[0])) return [a[0], a[0], a[0], a[0]];
  return a.length === 4 && a.every(Number.isFinite) ? a : undefined;
}

function setSafe(a) {
  safe = Array.isArray(a) && a.length === 4 ? a.map(Number) : null;
  const st = document.documentElement.style;
  SIDES.forEach((s, i) => (safe ? st.setProperty('--safe-' + s, safe[i] + 'px') : st.removeProperty('--safe-' + s)));
  ss.set('reel.dev.safe', safe ? safe.join(',') : null);
  dispatchEvent(new Event('resize')); // anything measuring insets re-measures
}

{
  const q = parseSafe(qs.get('safe'));
  const s = q !== undefined ? q : parseSafe(ss.get('reel.dev.safe'));
  if (s) setSafe(s);
  else if (q === null) setSafe(null);
}

/* --------------------------------------------------------- reduced motion */
let rm = null; // null = system; true/false forced
const realMM = window.matchMedia.bind(window);
const RM_RE = /\(\s*prefers-reduced-motion\s*(?::\s*(reduce|no-preference)\s*)?\)/g;

function fakeMql(media, matches) {
  const noop = () => {};
  return { media, matches, onchange: null, addListener: noop, removeListener: noop, addEventListener: noop, removeEventListener: noop, dispatchEvent: () => false };
}
window.matchMedia = function (q) {
  if (rm !== null && /prefers-reduced-motion/.test(q)) {
    const want = /no-preference/.test(q) ? !rm : rm;
    return fakeMql(q, /^\s*not\s/.test(q) ? !want : want);
  }
  return realMM(q);
};

const origMedia = new WeakMap();
function patchRules(rules) {
  for (const r of rules) {
    if (r instanceof CSSMediaRule) {
      if (!origMedia.has(r)) {
        if (!/prefers-reduced-motion/.test(r.media.mediaText)) {
          patchRules(r.cssRules);
          continue;
        }
        origMedia.set(r, r.media.mediaText);
      }
      const orig = origMedia.get(r);
      const txt =
        rm === null
          ? orig
          : orig.replace(RM_RE, (_, kind) => ((kind === 'no-preference' ? !rm : rm) ? '(min-width: 0px)' : '(max-width: 0.001px)'));
      if (r.media.mediaText !== txt) r.media.mediaText = txt;
      patchRules(r.cssRules);
    } else if (r.cssRules) {
      patchRules(r.cssRules); // @supports, @layer, …
    }
  }
}
function patchSheets() {
  for (const sh of document.styleSheets) {
    try {
      patchRules(sh.cssRules);
    } catch {} // cross-origin sheet
  }
}
let patchQueued = false;
new MutationObserver(() => {
  if (rm === null || patchQueued) return;
  patchQueued = true;
  queueMicrotask(() => {
    patchQueued = false;
    patchSheets();
  });
}).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

function setReducedMotion(on) {
  rm = on == null ? null : !!on;
  patchSheets();
  ss.set('reel.dev.rm', rm === null ? null : rm ? '1' : '0');
}
{
  const q = qs.get('rm') ?? ss.get('reel.dev.rm');
  if (q === '1' || q === '0') setReducedMotion(q === '1');
}

/* ------------------------------------------------ offline + playback guard
 * Real Jellyfin playback is blocked unless allowed (?allowplay=1 or
 * setAllowPlay(true)): a PlaybackInfo / Sessions/Playing call records a play
 * session and moves resume points and Continue Watching on the real server —
 * and desktop Chrome can't decode the iPhone's HEVC/HLS stream anyway.
 * Trailers (reel-api /ml) are not affected. */
let offline = false;
let allowPlay = (qs.get('allowplay') ?? ss.get('reel.dev.allowplay')) === '1';
const PLAY_RE = /^\/jf\/(Items\/[^/]+\/PlaybackInfo|Sessions\/Playing)(\/|$)/i;
const realFetch = window.fetch.bind(window);
const onlineDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
window.fetch = function (input, init) {
  let u = null;
  try {
    u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  } catch {}
  if (u && offline && (u.origin !== location.origin || /^\/(jf|ml)(\/|$)/.test(u.pathname))) {
    return Promise.reject(new TypeError('Failed to fetch (dev offline simulation)'));
  }
  if (u && !allowPlay && u.origin === location.origin && PLAY_RE.test(u.pathname)) {
    console.warn('[reeldev] blocked real Jellyfin playback call ' + u.pathname + ' — allow with ?allowplay=1 or the frame\'s dev panel');
    return Promise.resolve(new Response('dev server: real playback is blocked (phone/DEV-CHROME.md)', { status: 403, statusText: 'Blocked by dev guard' }));
  }
  return realFetch(input, init);
};
function setAllowPlay(on) {
  allowPlay = !!on;
  ss.set('reel.dev.allowplay', allowPlay ? '1' : null);
}
Object.defineProperty(navigator, 'onLine', {
  configurable: true,
  get: () => !offline && (onlineDesc ? onlineDesc.get.call(navigator) : true)
});
function setOffline(on) {
  on = !!on;
  if (on === offline) return;
  offline = on;
  ss.set('reel.dev.offline', on ? '1' : null);
  dispatchEvent(new Event(on ? 'offline' : 'online'));
}
if ((qs.get('offline') ?? ss.get('reel.dev.offline')) === '1') setOffline(true);

/* ----------------------------------------------------------- mouse → touch */
let mouseTouch = qs.get('mouse') !== '0' && !(navigator.maxTouchPoints > 0);
addEventListener('touchstart', (e) => e.isTrusted && (mouseTouch = false), { capture: true, passive: true });

const style = document.createElement('style');
style.textContent =
  'html.reeldev-nosel, html.reeldev-nosel * { -webkit-user-select: none !important; user-select: none !important; }';
document.head.appendChild(style);

let tid = 100;
let tr = null; // { id, target, x0, y0, moved }

function mkTouch(id, target, x, y) {
  return new Touch({
    identifier: id, target, clientX: x, clientY: y, pageX: x + scrollX, pageY: y + scrollY,
    screenX: x, screenY: y, radiusX: 11, radiusY: 11, force: 1
  });
}
function fireTouch(type, target, touches, changed) {
  const ev = new TouchEvent(type, {
    bubbles: true, cancelable: true, composed: true, view: window,
    touches, targetTouches: touches.filter((t) => t.target === target), changedTouches: changed
  });
  target.dispatchEvent(ev);
  return ev;
}
const editable = (el) => !!el.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]');

function swallowNextClick() {
  const sw = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    removeEventListener('click', sw, true);
  };
  addEventListener('click', sw, true);
  setTimeout(() => removeEventListener('click', sw, true), 400);
}

// bubble phase: runs after the element's own pointerdown handlers, as on iOS
addEventListener('pointerdown', (e) => {
  if (!mouseTouch || e.pointerType !== 'mouse' || e.button !== 0 || !(e.target instanceof Element)) return;
  tr = { id: ++tid, target: e.target, x0: e.clientX, y0: e.clientY, moved: false };
  if (!editable(e.target)) document.documentElement.classList.add('reeldev-nosel');
  const t = mkTouch(tr.id, tr.target, e.clientX, e.clientY);
  fireTouch('touchstart', tr.target, [t], [t]);
});
addEventListener(
  'pointermove',
  (e) => {
    if (!tr || e.pointerType !== 'mouse') return;
    if (!(e.buttons & 1)) return endMouse(e, 'touchend');
    if (Math.hypot(e.clientX - tr.x0, e.clientY - tr.y0) > 10) tr.moved = true;
    const t = mkTouch(tr.id, tr.target, e.clientX, e.clientY);
    fireTouch('touchmove', tr.target, [t], [t]);
  },
  true
);
function endMouse(e, type) {
  const s = tr;
  tr = null;
  document.documentElement.classList.remove('reeldev-nosel');
  const t = mkTouch(s.id, s.target, e.clientX, e.clientY);
  fireTouch(type, s.target, [], [t]);
  if (s.moved && type === 'touchend') swallowNextClick();
}
addEventListener('pointerup', (e) => tr && e.pointerType === 'mouse' && endMouse(e, 'touchend'), true);
addEventListener('pointercancel', (e) => tr && e.pointerType === 'mouse' && endMouse(e, 'touchcancel'), true);
// an <img>/<a> drag would start native drag-and-drop and cancel the pointer
addEventListener('dragstart', (e) => mouseTouch && e.preventDefault(), true);

/* ------------------------------------------------ right-click = long-press */
function hold(target, x, y, ms = 600) {
  const init = {
    bubbles: true, cancelable: true, composed: true, pointerId: 4242, pointerType: 'touch',
    isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y, width: 22, height: 22, pressure: 0.5
  };
  target.dispatchEvent(new PointerEvent('pointerdown', init));
  return sleep(ms).then(() => {
    target.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, pressure: 0 }));
  });
}
// The right button's own pointerdown/up would reach the long-press action too
// (its pointerup cancels the hold timer): keep them away from the app.
for (const type of ['pointerdown', 'pointerup']) {
  addEventListener(type, (e) => mouseTouch && e.pointerType === 'mouse' && e.button === 2 && e.stopImmediatePropagation(), true);
}
addEventListener(
  'contextmenu',
  (e) => {
    e.preventDefault();
    if (mouseTouch && e.target instanceof Element) hold(e.target, e.clientX, e.clientY);
  },
  true
);

/* ------------------------------------------------ programmatic gestures */
async function drag(from, to, { steps = 14, stepMs = 16, target } = {}) {
  const el = target || document.elementFromPoint(from[0], from[1]);
  if (!el) return false;
  const id = ++tid;
  let t = mkTouch(id, el, from[0], from[1]);
  fireTouch('touchstart', el, [t], [t]);
  for (let i = 1; i <= steps; i++) {
    await sleep(stepMs);
    const x = from[0] + ((to[0] - from[0]) * i) / steps;
    const y = from[1] + ((to[1] - from[1]) * i) / steps;
    t = mkTouch(id, el, x, y);
    fireTouch('touchmove', el, [t], [t]);
  }
  await sleep(stepMs);
  fireTouch('touchend', el, [], [t]);
  return true;
}

/** Edge swipe from the left edge to 75 % of the width (commits a pop). */
const swipeBack = () => drag([4, innerHeight / 2], [innerWidth * 0.75, innerHeight / 2 + 6]);

/** Two-finger pinch on the player stage (or the centre of the page). */
async function pinch(dir = 'out') {
  const el = document.querySelector('.vr-stage') || document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const [d0, d1] = dir === 'in' ? [140, 50] : [50, 140];
  const a = ++tid;
  const b = ++tid;
  const pair = (d) => [mkTouch(a, el, cx - d, cy), mkTouch(b, el, cx + d, cy)];
  let [p, q] = pair(d0);
  fireTouch('touchstart', el, [p, q], [p, q]);
  for (let i = 1; i <= 8; i++) {
    await sleep(16);
    [p, q] = pair(d0 + ((d1 - d0) * i) / 8);
    fireTouch('touchmove', el, [p, q], [p, q]);
  }
  await sleep(16);
  fireTouch('touchend', el, [p], [q]);
  await sleep(16);
  fireTouch('touchend', el, [], [p]);
  return true;
}

function longpress(target, ms = 600) {
  const el = typeof target === 'string' ? document.querySelector(target) : target;
  if (!el) return Promise.resolve(false);
  const r = el.getBoundingClientRect();
  return hold(el, r.left + r.width / 2, r.top + r.height / 2, ms).then(() => true);
}

addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || (e.target instanceof Element && editable(e.target))) return;
  if (e.key === '+' || e.key === '=') pinch('out');
  else if (e.key === '-') pinch('in');
});

window.__reelDev = {
  setSafe,
  setReducedMotion,
  setOffline,
  setAllowPlay,
  setMouseTouch: (on) => (mouseTouch = !!on),
  swipeBack,
  pinch,
  longpress,
  drag,
  state: () => ({ safe, reducedMotion: rm, offline, allowPlay, mouseTouch })
};
