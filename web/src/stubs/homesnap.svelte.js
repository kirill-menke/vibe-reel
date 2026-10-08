/* Web stand-in for phone/src/lib/homesnap.svelte.js (swapped in by
 * web/vite.config.js). The phone paints Home from last session's answers
 * before its first frame; a desktop browser on the home network or behind the
 * tunnel just loads — no snapshot is read or written. Same exports.
 *
 * `homeSnap.shown` is what the offline banner's "Showing what was loaded
 * last." rests on. Home sets it once it has painted; here it reads true only
 * while that Home is the page on screen — over a grid that failed to load
 * ("Couldn’t load movies") the line contradicted the page (A-13). */
import { R } from '$p/lib/router.svelte.js';

const painted = $state({ v: false });
export const homeSnap = {
  get shown() {
    return painted.v && R.tab === 'home' && R.stacks.home.length === 1 && !R.modal;
  },
  set shown(v) {
    painted.v = !!v;
  }
};
/** @returns {{ trend: VR.HomeTrend } | null} */
export const seedHome = () => null;
export function saveHome() {}
