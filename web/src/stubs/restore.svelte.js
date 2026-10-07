/* Web stand-in for phone/src/lib/restore.svelte.js (swapped in by
 * web/vite.config.js). iOS evicts a backgrounded app and the phone rebuilds its
 * stacks from a snapshot; in a browser the URL and history.state do that job
 * (web/src/lib/urlsync.svelte.js). Same exports, all inert. */

export function saveRoute() {}
export function closeRoute() {}
export function routeResumed() {}
export function forgetRoute() {}
export function restoreRoute() {}
