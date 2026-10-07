/* Web stand-in for phone/src/lib/offline.svelte.js (swapped in by
 * web/vite.config.js). Offline copies are an installed-iPhone feature: the
 * desktop has none, so the screens' Download actions hide themselves
 * (offlineSupported() false) and nothing is ever queued. Same exports. */

/** @type {VR.OfflineState} */
export const OFF = $state({ list: [], usage: null, quota: null, persisted: null });
export const OFFLINE_QUALITIES = /** @type {Array<number | 'original'>} */ (['original']);

/** @returns {boolean} */
export const offlineSupported = () => false;
/** @returns {VR.OfflineEntry | null} */
export const entryOf = () => null;
export async function refreshStorage() {}
/** @returns {number | null} */
export const freeBytes = () => null;
/** @returns {number} */
export const estimateBytes = () => 0;
export function queueDownload() {}
export function pump() {}
export function pauseDownload() {}
export function resumeDownload() {}
export async function deleteDownload() {}
/** @returns {Promise<string | null>} */
export async function artUrl() {
  return null;
}
export async function playOffline() {}
export async function syncPositions() {}
export function initOffline() {}
