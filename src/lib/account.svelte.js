/* Signed-in Jellyfin accounts — the avatar at the right end of the tab row.
 *
 * cfg holds the *current* session; `reel.accounts` remembers every account
 * signed in on this TV ({ server, userId, userName, token }), so switching is
 * one press instead of a fresh Quick Connect. A switch reloads the app: every
 * cache, the Home SWR store and the news "seen" list are the
 * previous user's, and a clean boot is the only way to be sure none of it
 * leaks into the next one. */
import { cfg, saveCfg } from './config.js';
import { api } from './api.js';

const KEY = 'reel.accounts';

/** @returns {VR.Account[]} */
function load() {
  try {
    // A corrupted entry ("null", an object) used to make rememberCurrent()
    // throw right after a successful Login; a malformed account would collide
    // on TopNav's keyed {#each}. Keep only well-formed ones.
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter((a) => a && typeof a === 'object' && a.server && a.userId && a.token) : [];
  } catch {
    return [];
  }
}

/** @type {VR.AccountsState} */
export const accounts = $state({ list: load() });

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(accounts.list));
  } catch {}
}

const same = (/** @type {VR.Account} */ a, /** @type {VR.Account} */ b) => a.userId === b.userId && a.server === b.server;

/* Called after every successful sign-in, and at boot so a session that
 * predates this list is in it too. */
export function rememberCurrent() {
  if (!cfg.token || !cfg.userId) return;
  const me = { server: cfg.server, userId: cfg.userId, userName: cfg.userName, token: cfg.token };
  const i = accounts.list.findIndex((a) => same(a, me));
  if (i >= 0) accounts.list[i] = me;
  else accounts.list.push(me);
  save();
}

/** @param {VR.Account} a @returns {boolean} */
export function isCurrent(a) {
  return a.userId === cfg.userId && a.server === cfg.server;
}

/* The user's Jellyfin profile picture (the /Users/{id}/Images route went away
 * with 10.9). Served without auth; a user without one gets a 404, which the
 * avatar answers with their initial. */
/** @param {Pick<VR.Account, 'server' | 'userId'>} a @param {number} [size] px @returns {string} */
export function avatarUrl(a, size = 96) {
  return a.server + '/UserImage?userId=' + encodeURIComponent(a.userId) + '&maxHeight=' + size + '&quality=90';
}

/** @param {Partial<Pick<VR.Account, 'userName'>>} a @returns {string} */
export function initial(a) {
  return (a.userName || '?').trim().charAt(0).toUpperCase();
}

/** @param {VR.Account} a */
function become(a) {
  cfg.server = a.server;
  cfg.userId = a.userId;
  cfg.userName = a.userName;
  cfg.token = a.token;
  saveCfg();
  location.reload();
}

/** @param {VR.Account} a */
export function switchTo(a) {
  if (!isCurrent(a)) become(a);
}

/* Revoke the current token server-side, forget the account, and carry on as
 * the next remembered one — or at the login screen if there is none. */
export async function signOut() {
  try {
    await api('/Sessions/Logout', { method: 'POST' });
  } catch {
    /* a dead token is exactly as signed out */
  }
  accounts.list = accounts.list.filter((a) => !isCurrent(a));
  save();
  const next = accounts.list[0];
  if (next) {
    become(next);
    return;
  }
  cfg.token = '';
  cfg.userId = '';
  cfg.userName = '';
  saveCfg();
  location.reload();
}
