/* What a screen reader hears when a result or a failure appears (run by
 * roving.js's scan, at most once a frame, after a DOM change outside the
 * grids). Two regions of our own, made once and never re-created, so a
 * message is always a CHANGE to a region the reader already knows — a live
 * region inserted together with its text is often not read at all.
 *
 *   errors   the phone's StateMessage puts role=alert on the whole error
 *            card, Retry button included: every "Retry" → "Retrying…" →
 *            "Retry" (by hand or on LoadError's 30 / 60 s timer) changed an
 *            assertive region. Here the card loses the role and its title +
 *            reason are said once, when it appears.
 *   search   "22 results" / "Searching…" / "No results for “x”" were a
 *            polite region rendered together with its first text; they go
 *            through the polite region instead, which exists from the start.
 *            While searching, the Search page has lost its "Search" title
 *            (the phone's search mode slides it away): a visually hidden h1
 *            stands in, and the result count is the results' heading (h2).
 *   Home     the phone's hero has an h1 per slide — the page's only h1, and
 *            a different one every few seconds. A visually hidden h1 "Home"
 *            names the page for good, and the slide titles count as h2s. */

/** @type {HTMLElement | null} */ let polite = null;
/** @type {HTMLElement | null} */ let assertive = null;

/** @param {'polite' | 'assertive'} kind */
function region(kind) {
  const el = document.createElement('div');
  el.className = 'sr-only wlive';
  el.setAttribute('aria-live', kind);
  el.setAttribute('aria-atomic', 'true');
  if (kind === 'assertive') el.setAttribute('role', 'alert');
  document.body.append(el);
  return el;
}

/** @param {HTMLElement} el @param {string} text */
function say(el, text) {
  // the same words again (a second "No results" for the same query) only
  // count as a change once the region was emptied first
  if (el.textContent === text) el.textContent = '';
  requestAnimationFrame(() => (el.textContent = text));
}

/** what the page has to say, as one line @param {Element} card */
const cardText = (card) =>
  [card.querySelector('.state__title')?.textContent, card.querySelector('.state__text')?.textContent]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join('. ');

/** @type {WeakSet<Element>} */
const announced = new WeakSet();
let lastSearch = '';
/** @type {HTMLElement | null} */ let searchH1 = null;

export function syncLive() {
  if (!polite?.isConnected) polite = region('polite');
  if (!assertive?.isConnected) assertive = region('assertive');

  // error cards: said once, then plain content
  for (const card of document.querySelectorAll('.state[role="alert"]')) {
    card.removeAttribute('role');
    if (announced.has(card)) continue;
    announced.add(card);
    if (card.closest('.route[hidden], [inert]')) continue; // a hidden tab's card isn't news
    say(assertive, cardText(card));
  }

  syncHomeHeading();

  // Search
  const main = document.querySelector('.route[data-route="search"]:not([hidden]) > .srch, .route[data-route="search"]:not([hidden]) .screen.srch');
  if (!main) return;
  for (const c of main.querySelectorAll('.search__count[aria-live]')) c.removeAttribute('aria-live');
  const count = main.querySelector('.search__count + .srch__grid')?.previousElementSibling;
  if (count && count.getAttribute('role') !== 'heading') {
    count.setAttribute('role', 'heading');
    count.setAttribute('aria-level', '2');
  }
  // the stand-in title, first in the page, while the real one is away
  if (!searchH1 || searchH1.parentElement !== main) {
    searchH1 = document.createElement('h1');
    searchH1.className = 'sr-only';
    searchH1.textContent = 'Search';
    main.prepend(searchH1);
  }
  const hasTitle = [...main.querySelectorAll('h1')].some((h) => h !== searchH1);
  if (searchH1.hidden !== hasTitle) searchH1.hidden = hasTitle;

  const state = main.querySelector(':scope > .state');
  const msg = count?.textContent?.trim() || (state && !state.classList.contains('state--error') ? cardText(state) : '');
  if (msg !== lastSearch) {
    lastSearch = msg;
    if (msg) say(polite, msg);
  }
}

/** @type {HTMLElement | null} */ let homeH1 = null;
function syncHomeHeading() {
  const home = document.querySelector('.route[data-route="home"] > .screen.home');
  if (!home) return;
  if (!homeH1 || homeH1.parentElement !== home) {
    homeH1 = document.createElement('h1');
    homeH1.className = 'sr-only';
    homeH1.textContent = 'Home';
    home.prepend(homeH1);
  }
  for (const t of home.querySelectorAll('h1.hero__title:not([aria-level])')) {
    t.setAttribute('role', 'heading');
    t.setAttribute('aria-level', '2');
  }
}
