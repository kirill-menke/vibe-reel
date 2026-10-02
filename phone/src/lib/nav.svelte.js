/* Phone replacement for src/lib/nav.svelte.js (swapped in by the resolveId
 * plugin in phone/vite.config.js — every import of the TV module, relative or
 * via $lib, lands here). Exports every name the TV module exports, mapped onto
 * the phone router (router.svelte.js). See docs/ios/ARCHITECTURE.md.
 *
 * The one rule that matters for the engine: while the player modal is up
 * (S.screen === 'player'), an open*() whose target is the route already under
 * the modal only closes the modal — the page is still mounted, it just
 * refetches play state off R.playerClosed. Any other target closes the modal
 * and pushes. */
import {
  R,
  S,
  top,
  push,
  pop,
  switchTab,
  closeSheet,
  closePlayer,
  openLoginModal,
  closeLoginModal,
  resetTab
} from './router.svelte.js';

export { S };

/* Focus memory is the TV's D-pad concern; mounted routes keep their own. */
export const takeGridFocus = () => null;
export const takeHomeFocus = () => null;
export const peekHomeFocus = () => null;
export const takeDetailFocus = () => null;

function underModal(match) {
  if (R.modal !== 'player') return false;
  const t = top();
  if (match(t)) {
    closePlayer();
    return true;
  }
  closePlayer();
  return false;
}

function leaveLogin() {
  if (R.modal === 'login') closeLoginModal();
}

function lookupKey(it) {
  if (!it) return '';
  return [it.tvdbId || it.tvdb_id || '', it.tmdbId || it.tmdb_id || '', it.imdbId || it.imdb_id || '', it.title || it.name || '', it.year || ''].join('|');
}

export function openLogin(adding = false) {
  closeSheet();
  if (R.modal === 'player') closePlayer();
  openLoginModal(adding);
}

/* Home tab (as left). From the player: close it; a pushed Home page stays. */
export function openHome() {
  leaveLogin();
  if (R.modal === 'player') {
    closePlayer();
    if (R.tab !== 'home') switchTab('home');
    return;
  }
  if (R.tab !== 'home') switchTab('home');
}

export function returnHome() {
  openHome();
}

export function openLibrary(type) {
  leaveLogin();
  if (R.modal === 'player') closePlayer();
  const tab = type === 'shows' ? 'shows' : 'movies';
  if (R.tab !== tab) switchTab(tab);
}

export function openSearch() {
  if (R.modal === 'player') closePlayer();
  if (R.tab !== 'search') switchTab('search');
}

/* Search is a tab on the phone: nothing to lower. */
export function closeSearch() {
  return null;
}

export function closeSearchChart() {
  if (top().name === 'chart') pop();
  S.searchChart = null;
  return null;
}

export function openFromSearch(_cardKey, open) {
  open();
}

export function openItem(id, type) {
  if (underModal((t) => t.name === 'detail' && t.params.id === id)) return;
  push('detail', { id, type });
}

export function openPerson(id, name) {
  if (underModal((t) => t.name === 'person' && t.params.id === id)) return;
  push('person', { id, name: name || '' });
}

export function openLookup(item) {
  if (underModal((t) => t.name === 'lookup' && (t.params.item === item || lookupKey(t.params.item) === lookupKey(item)))) return;
  push('lookup', { item });
}

export function openPending(key) {
  if (underModal((t) => t.name === 'pending' && t.params.key === key)) return;
  push('pending', { key });
}

/* Back: Login (adding an account) → cancel; a sheet → close; else pop. */
export function onBack() {
  if (R.modal === 'login') {
    if (S.addingAccount) closeLoginModal();
    return;
  }
  if (R.sheet) {
    closeSheet();
    return;
  }
  pop();
}

/* not in the TV module, but handy for phone callers */
export { resetTab };
