/* Press feedback: one delegated, scroll-safe controller instead of `:active`
 * (docs/ios/polish/motion-system.md, MOT-02).
 *
 * WebKit sets :active on touchstart and leaves it on while the touch turns
 * into a scroll, so every tile, row and button a thumb lands on lit up under
 * a scrolling list. UIKit instead highlights only once a touch is clearly a
 * tap (UIScrollView delays content touches) and drops the highlight without
 * an animation when a scroll takes over. This does the same:
 *
 *   pointerdown on a pressable  → `.pressing` after --press-delay (70 ms)
 *   moved > 8 px, pointercancel (iOS fires it when the scroll takes over),
 *   a scroll of an ancestor     → cancelled; if `.pressing` was already on it
 *                                 is cut with no transition (`.press-cut`)
 *   pointerup before the delay  → `.pressing` now, dropped 90 ms later (a
 *                                 quick tap still flashes)
 *   pointerup after it          → dropped: the release spring plays (CSS)
 *
 * Pressables are the SEL classes below; the innermost wins (`.tile__add`, not
 * its `.tile`). Styling lives in components.css: `X.pressing` is the press-in
 * (--dur-press, --ease-out), X's base rule the release (--dur-release,
 * --spring-snappy). To make a new control pressable, add its class to SEL —
 * never write an `:active` rule. `.is-pressed` stays the static "held" state
 * a screen sets itself (Home holds a tile pressed while it resolves); this
 * controller never touches it. The long-press action (gestures.js) listens on
 * its node and is unaffected. */

const SEL = [
  '.btn', '.iconbtn', '.avatarbtn', '.closebtn', '.tabbar__item',
  '.action', '.tile', '.tile__add', '.cast', '.catcard', '.pill', '.chip',
  '.episode', 'button.row', 'a.row', '.notif', '.option', '.ctx__item',
  '.seg__opt', '.switch', '.pbtn', '.pchip', '.skipchip', '.toast__action', '.actsheet__btn',
  '.detail__series', '.overview__more', '.search__clear', '.search__cancel',
  '.lib__bartitle'
].join(',');
const SKIP = '[disabled], [aria-disabled="true"], .tile--self, .tile[aria-hidden="true"], .episode--preview';
const SLOP = 8; // px of travel before a touch stops being a tap
const FLASH = 90; // ms a quick tap stays pressed after the finger lifts

let delay = -1; // --press-delay, read once
let cur = null; // { el, id, x, y, timer, on }
const flashes = new WeakMap(); // el → pending drop of a quick tap's flash

function pressDelay() {
  if (delay < 0) {
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--press-delay'));
    delay = Number.isFinite(v) ? v : 70;
  }
  return delay;
}

function on(el) {
  clearTimeout(flashes.get(el));
  flashes.delete(el);
  el.classList.add('pressing');
}

/* Release: the base rule's spring takes it back. */
function drop(el) {
  el.classList.remove('pressing');
}

/* Cancel: no release animation — the highlight just goes, as UIKit's does
 * when a scroll takes the touch. `.press-cut` zeroes the transitions for the
 * style recalc that removes `.pressing`; two frames later it can go. */
function cut(el) {
  if (!el.classList.contains('pressing')) return;
  el.classList.add('press-cut');
  el.classList.remove('pressing');
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('press-cut')));
}

function cancel() {
  if (!cur) return;
  clearTimeout(cur.timer);
  cut(cur.el);
  cur = null;
}

function down(e) {
  cancel(); // a second finger, or a press that never saw its pointerup
  if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const el = e.target instanceof Element ? e.target.closest(SEL) : null;
  if (!el || el.matches(SKIP)) return;
  const st = { el, id: e.pointerId, x: e.clientX, y: e.clientY, timer: 0, on: false };
  st.timer = setTimeout(() => {
    st.timer = 0;
    st.on = true;
    on(el);
  }, pressDelay());
  cur = st;
}

function move(e) {
  if (cur && e.pointerId === cur.id && Math.hypot(e.clientX - cur.x, e.clientY - cur.y) > SLOP) cancel();
}

function up(e) {
  if (!cur || e.pointerId !== cur.id) return;
  const { el, timer } = cur;
  cur = null;
  if (timer) {
    // lifted before the delay: a tap — flash it
    clearTimeout(timer);
    on(el);
    flashes.set(
      el,
      setTimeout(() => {
        flashes.delete(el);
        drop(el);
      }, FLASH)
    );
  } else drop(el);
}

function scrolled(e) {
  const t = e.target;
  if (cur && (t === document || (t instanceof Node && t.contains(cur.el)))) cancel();
}

let wired = false;
export function initPress() {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  const o = { capture: true, passive: true };
  document.addEventListener('pointerdown', down, o);
  document.addEventListener('pointermove', move, o);
  document.addEventListener('pointerup', up, o);
  document.addEventListener('pointercancel', cancel, o);
  document.addEventListener('scroll', scrolled, o);
  window.addEventListener('blur', cancel);
}
