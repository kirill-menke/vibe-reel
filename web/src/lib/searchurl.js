/* The Search query in the address bar: /search?q=dune.
 *
 * The phone's Search screen keeps its query in its own state (the field is
 * `bind:value`), so this works at the DOM edge, without touching it:
 *
 *   typing     every `input` on the Search field (and a click on its Clear /
 *              Cancel, which empty it in code) rewrites ?q= with
 *              history.replaceState — one entry for the whole search, not
 *              one per keystroke
 *   restore    a deep link or reload with ?q= (and Back/Forward onto such an
 *              entry) puts the query into the field and fires the same
 *              `input` event typing does, so Search runs it as usual
 *   tab links  urlsync.svelte.js asks for the current query whenever it
 *              writes the Search root's URL (setSearchQuery) */
import { setSearchQuery } from './urlsync.svelte.js';

const FIELD = '.route[data-route="search"] .search__input';

const field = () => /** @type {HTMLInputElement | null} */ (document.querySelector(FIELD));
const onSearchRoot = () => location.pathname === '/search';

function current() {
  const q = (field()?.value || '').trim();
  return q ? '?q=' + encodeURIComponent(q) : '';
}

function write() {
  if (!onSearchRoot()) return;
  const want = '/search' + current();
  if (location.pathname + location.search !== want) history.replaceState(history.state, '', want);
}

/** @param {string} q */
function fill(q) {
  const f = field();
  if (!f) return false;
  if (f.value.trim() !== q) {
    f.value = q;
    f.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return true;
}

/* the query a URL asks for, put in once the Search screen has mounted */
let pending = '';
/** @type {MutationObserver | null} */
let waiting = null;
function restoreFromUrl() {
  if (!onSearchRoot()) return;
  pending = new URLSearchParams(location.search).get('q')?.trim() || '';
  if (!pending && !field()?.value) return;
  if (fill(pending)) return;
  if (!pending || waiting) return;
  waiting = new MutationObserver(() => {
    if (fill(pending)) {
      waiting?.disconnect();
      waiting = null;
    }
  });
  waiting.observe(document.body, { childList: true, subtree: true });
}

export function initSearchUrl() {
  setSearchQuery(current);
  document.addEventListener('input', (e) => {
    if (/** @type {Element} */ (e.target).matches?.(FIELD)) write();
  });
  document.addEventListener('click', (e) => {
    if (/** @type {Element} */ (e.target).closest?.('.route[data-route="search"] .search__clear, .route[data-route="search"] .search__cancel')) setTimeout(write, 0);
  });
  window.addEventListener('popstate', () => setTimeout(restoreFromUrl, 0));
  restoreFromUrl();
}
