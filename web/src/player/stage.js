/* WebPlayer's small pure pieces: the picture's click / double-click, the
 * "full screen didn't take" check, and the track chips' accessible names. */

/* A click on the picture pauses — a moment later (`dblMs`), so the two clicks
 * of a double click (full screen) don't pause and resume the film on the way
 * (YouTube does the same). A double click slower than that has already paused
 * once: its dblclick puts that back, within `undoMs` of the pause. Only a
 * pause fired by the first click of the *same* click sequence counts: a
 * deliberate click, then a double click a moment later, keeps the deliberate
 * pause (each new sequence — event.detail 1 — forgets the last one).
 *
 *   const st = stageClicks({ pause, full, can });
 *   el.onclick = (e) => st.click(e.detail);  el.ondblclick = () => st.dbl();
 * `can()` false (no player, a card up) drops a pending pause; `cancel()` drops
 * it too (a panel closed by the click instead). */
/** @param {{ pause: () => void, full: () => void, can: () => boolean, dblMs?: number, undoMs?: number, now?: () => number }} o */
export function stageClicks({ pause, full, can, dblMs = 250, undoMs = 600, now = Date.now }) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let pausedAt = 0;
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    cancel,
    /** @param {number} detail the click's event.detail (1 = a new sequence) */
    click(detail) {
      cancel();
      if (detail > 1) return; // the second click of a double click
      pausedAt = 0;
      timer = setTimeout(() => {
        timer = undefined;
        if (!can()) return;
        pause();
        pausedAt = now();
      }, dblMs);
    },
    dbl() {
      cancel();
      if (pausedAt && now() - pausedAt < undoMs && can()) pause();
      pausedAt = 0;
      full();
    }
  };
}

/* After an accepted requestFullscreen(): did the window stay as it was? Stuck =
 * it neither grew nor covers the screen. Page zoom is why both: Chrome scales
 * innerWidth with it but not screen.* (at 150 % a real full screen on a
 * 2560×1600 monitor reads 1707×1067 inner), Firefox scales both; the outer
 * size is in screen.*'s units in either, and a window that was already
 * screen-sized (kiosk, F11) doesn't grow. */
/**
 * @param {{ w: number, h: number }} before inner size before the request
 * @param {{ innerWidth: number, innerHeight: number, outerWidth: number, outerHeight: number }} win
 * @param {{ width: number, height: number }} scr
 */
export function fullScreenStuck(before, win, scr) {
  const grew = win.innerWidth > before.w + 1 || win.innerHeight > before.h + 1;
  const covers = win.outerWidth >= scr.width * 0.85 || win.outerHeight >= scr.height * 0.85;
  return !grew && !covers;
}

/* A track chip's accessible name: what it is + the words it shows. Below
 * 900 px a chip shows only its icon, and a CC icon announced as "English" said
 * nothing about subtitles. The visible words stay one run, in order, inside
 * the name: "Subtitles: English Forced", "Audio: English DD+ 5.1",
 * "Subtitles: Off" (the chip that reads "Subtitles Off"). */
/** @param {string} what @param {{ main: string, dim: string }} chip */
export function chipName(what, chip) {
  const words = chip.main === what ? chip.dim : [chip.main, chip.dim].filter(Boolean).join(' ');
  return words ? what + ': ' + words : what;
}
