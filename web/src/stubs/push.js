/* Web stand-in for phone/src/lib/push.js (swapped in by web/vite.config.js).
 * Web push needs a service worker, which the web MVP doesn't ship: no
 * subscription is made, and sign-out has nothing to unregister. Same exports. */

/** @returns {VR.PushSupport} */
export const pushSupport = () => 'unsupported';
/** @returns {NotificationPermission} */
export const permission = () => 'default';
/** @returns {VR.PushPrefs} */
export const pushPrefs = () => /** @type {VR.PushPrefs} */ ({ ready: false, seasons: false });
/** @returns {Promise<null>} */
export async function pushServerState() {
  return null;
}
/** @returns {Promise<VR.PushPrefs>} */
export async function setPush() {
  throw new Error('Notifications aren’t available in the browser version.');
}
export async function sendTestPush() {}
export function syncPush() {}
export async function pushSignOut() {}
export function initPushLinks() {}
