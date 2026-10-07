/* Web stand-in for phone/src/lib/homesnap.svelte.js (swapped in by
 * web/vite.config.js). The phone paints Home from last session's answers
 * before its first frame; a desktop browser on the home network or behind the
 * tunnel just loads — no snapshot is read or written. Same exports. */

export const homeSnap = $state({ shown: false });
/** @returns {{ trend: VR.HomeTrend } | null} */
export const seedHome = () => null;
export function saveHome() {}
