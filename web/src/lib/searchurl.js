/* The Search query in the address bar (/search?q=dune), and Search's
 * keyboard (/ to search from anywhere, Esc to clear — see onKey).
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
import { R, switchTab } from '$p/lib/router.svelte.js';

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

/* ---- the keyboard ----
 *   /        is App.svelte's (onSlash): Search, with the cursor in the field.
 *   Esc      in the field: clears the query (Chrome does that natively for
 *            type=search, Firefox doesn't — now both do, and both update
 *            ?q=); on an empty field it leaves it for the page's scroller
 *            (not <body>), which ends search mode.
 *   the nav  a click on the Search link from another section puts the cursor
 *            in the field too, so typing can start at once. */

/* the field once the Search root is the visible route (a few frames after a
 * tab switch: Svelte mounts / un-hides it first) */
function focusField(tries = 10) {
  const f = field();
  if (f && f.closest('.route:not([hidden])')) {
    f.focus({ preventScroll: true });
    return;
  }
  if (tries > 0) requestAnimationFrame(() => focusField(tries - 1));
}

/** @param {KeyboardEvent} e */
function onKey(e) {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === 'Escape' && /** @type {Element} */ (e.target).matches?.(FIELD)) {
    const f = /** @type {HTMLInputElement} */ (e.target);
    e.preventDefault();
    if (f.value) {
      f.value = '';
      f.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // leave it for the page (search mode ends with the blur), not for
      // <body>: PageDown and Space go on working from the keyboard
      const sc = /** @type {HTMLElement | null} */ (f.closest('.screen'));
      if (sc) sc.focus({ preventScroll: true });
      else f.blur();
    }
    return;
  }
  // `/` itself is App.svelte's onSlash (it also knows Login and the confirm)
}

export function initSearchUrl() {
  setSearchQuery(current);
  document.addEventListener('keydown', onKey);
  // capture: WebNav's own click handler switches the tab before a bubbling
  // listener would see which tab it came from
  document.addEventListener(
    'click',
    (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (/** @type {Element} */ (e.target).closest?.('.wnav__tab[href="/search"]') && R.tab !== 'search') setTimeout(() => focusField(), 0);
    },
    true
  );
  document.addEventListener('input', (e) => {
    if (/** @type {Element} */ (e.target).matches?.(FIELD)) write();
  });
  document.addEventListener('click', (e) => {
    if (/** @type {Element} */ (e.target).closest?.('.route[data-route="search"] .search__clear, .route[data-route="search"] .search__cancel')) setTimeout(write, 0);
  });
  window.addEventListener('popstate', () => setTimeout(restoreFromUrl, 0));
  restoreFromUrl();
}
