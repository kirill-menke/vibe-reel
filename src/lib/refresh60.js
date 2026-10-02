import { S } from './nav.svelte.js';

/* The TV matches its output refresh rate to the video it plays (25p → 50 Hz,
 * a 24p trailer → 48 Hz) and does not always switch back when the video is
 * unloaded: after such a title the whole UI kept running at 48–50 frames/s
 * against Chromium's 60 Hz frame clock, i.e. ~17–20% of frames dropped and
 * every D-pad glide stuttering, for as long as the app stayed open (measured
 * over CDP 2026-09-29 — even an empty page ran at 50 fps then, with the GPU
 * thread blocked ~16 ms per frame waiting on the display). Playing a 1 s 60p
 * clip puts it back: 60 fps, 0% dropped, ~2.5 ms of GPU per frame.
 *
 * Mechanism (found while experimenting with a 120 Hz UI for the whole TV):
 * the panel really goes to 100 Hz for 25p (96 Hz for 24p) and stays there;
 * stock webOS flips the UI on every 2nd panel vsync, hence the 50/48 fps. With
 * 120 Hz installed the UI flips at 100/96 fps instead, and this same clip
 * brings the panel back to 120 — so it is needed either way (verified
 * 2026-09-29 with a 25p and a 23.976p file).
 *
 * The clip has to be *shown* to count — 1×1 px or opacity 0 didn't switch
 * anything — but being covered by page content is fine, so it plays beneath
 * everything (z-index −1, black like the canvas). Its own <video>, never
 * #video (libpgs holds that one), and nothing reads the rate back — the page
 * can't observe it (rAF keeps ticking at 60) — so it simply runs after every
 * playback and whenever the app comes back to the foreground. */

const CLIP = 'refresh60.mp4';
const DEADLINE_MS = 4000;

let el = null;
let timer = 0;
let pending = 0;

function cleanup() {
  clearTimeout(timer);
  timer = 0;
  if (!el) return;
  el.onended = el.onerror = null;
  try {
    el.pause();
    el.removeAttribute('src');
    el.load();
  } catch {
    /* ignore */
  }
  el.remove();
  el = null;
}

/* Playback is about to start: a real stream wins over the reset clip. */
export function cancelRefreshReset() {
  clearTimeout(pending);
  pending = 0;
  cleanup();
}

export function resetRefreshRate(delay = 800) {
  if (!window.PalmSystem) return; // only the TV switches rates
  clearTimeout(pending);
  pending = setTimeout(() => {
    pending = 0;
    if (el || S.screen === 'player' || document.visibilityState !== 'visible') return;
    el = document.createElement('video');
    el.className = 'rate60';
    el.muted = true;
    el.setAttribute('aria-hidden', 'true');
    el.onended = el.onerror = cleanup;
    document.body.prepend(el);
    timer = setTimeout(cleanup, DEADLINE_MS);
    el.src = CLIP;
    el.play().catch(cleanup);
  }, delay);
}
