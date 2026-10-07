/** @type {VR.ToastState} */
export const toastState = $state(/** @satisfies {VR.ToastState} */ ({ msg: '', show: false, undo: null }));

/** @type {ReturnType<typeof setTimeout> | null} */
let timer = null;

/* How long a message stays: a short one the usual 3.5 s, a long one long enough
 * to actually read from the couch (~55 ms per character on top of a base),
 * capped so a stray essay can't park itself on screen. */
/** @param {string} msg @returns {number} ms */
function holdFor(msg) {
  return Math.max(3500, Math.min(9000, 1800 + msg.length * 55));
}

/* `undo`: an action the remote's Play key (415) runs while this toast is up
 * on a browse screen (Keys.svelte) — the toast then says "▶ Undo". */
/** @param {string} msg @param {(() => void) | null} [undo] */
export function toast(msg, undo = null) {
  toastState.msg = String(msg);
  toastState.undo = undo;
  toastState.show = true;
  clearTimeout(timer);
  let hold = holdFor(toastState.msg);
  // phone: an Undo needs time to reach with a thumb (design: 5 s)
  if (undo && typeof __PHONE__ !== 'undefined' && __PHONE__) hold = Math.max(5000, hold);
  timer = setTimeout(() => {
    toastState.show = false;
    toastState.undo = null;
  }, hold);
}

/* Phone only (the TV never calls these; tree-shaken there): a thumb resting
 * on the toast keeps it — pause drops the hide timer, resume hides it `ms`
 * after the finger lifts (Toast.svelte, TST-02). */
export function pauseToast() {
  if (!(typeof __PHONE__ !== 'undefined' && __PHONE__)) return;
  clearTimeout(timer);
}
/** @param {number} [ms] */
export function resumeToast(ms = 2000) {
  if (!(typeof __PHONE__ !== 'undefined' && __PHONE__) || !toastState.show) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    toastState.show = false;
    toastState.undo = null;
  }, ms);
}

/* Play key while an undoable toast is up: run it once and drop the toast. */
/** @returns {boolean} */
export function takeUndo() {
  const f = toastState.undo;
  if (!f) return false;
  toastState.undo = null;
  toastState.show = false;
  clearTimeout(timer);
  f();
  return true;
}
