/* Composite widgets under the keyboard (WAI-ARIA APG), from outside the
 * shared phone markup — the phone's components already carry the roles
 * (Segmented: radiogroup/radio; SeasonPills and Person's filter chips:
 * tablist/tab; Sort & filter's rows: radiogroup/radio) but not the keys:
 * every option was its own Tab stop and the arrows did nothing.
 *
 *   one Tab stop   per group: the selected option (the first one when none
 *                  is), every other option tabindex -1. None of these
 *                  components sets tabindex itself, so Svelte never writes
 *                  over it; a re-render or a new group is caught by a
 *                  MutationObserver (scan, at most once a frame).
 *   arrows         radios: ← → ↑ ↓; tabs: ← → (↑ ↓ for a vertical list).
 *                  They move focus and select, wrapping at the ends — the
 *                  options are cheap to pick (a sort, a filter, a season,
 *                  a setting). Home / End: the first / last option.
 *   follow-focus   except where a pick is an action: the Accounts sheet's
 *                  radios switch account and reload the app, so there the
 *                  arrows only move focus (Enter / Space picks).
 *   tab panels     a tab list gets aria-controls → its panel (the season's
 *                  episode list, the person's grid), the panel role=tabpanel
 *                  labelled by the selected tab.
 *   menu buttons   the Library's sort and genre chips open the Sort & filter
 *                  dialog: aria-haspopup=dialog, aria-expanded while it is up.
 *
 * Left alone: the player's track panels (the player lane's keys) and the
 * context menu (the ctx lane's). The grids' 2-D arrows are gridkeys.js; the
 * live regions are roving-live.js — both started from here. */
import { R } from '$p/lib/router.svelte.js';
import { initGridKeys } from './gridkeys.js';
import { syncLive } from './roving-live.js';

const GROUP = '[role="radiogroup"], [role="tablist"]';
const SKIP = '.wplayer, .player, .ctx';
/* groups whose pick is an action, not a selection: arrows move focus only */
const NO_FOLLOW = '[role="dialog"][aria-label="Accounts"]';

/** @param {Element} g */
const itemSel = (g) => (g.getAttribute('role') === 'tablist' ? '[role="tab"]' : '[role="radio"]');

/** the group's options, in order, that can take focus @param {Element} g @returns {HTMLElement[]} */
export function options(g) {
  return /** @type {HTMLElement[]} */ ([...g.querySelectorAll(itemSel(g))]).filter(
    (el) => el.closest(GROUP) === g && !(/** @type {HTMLButtonElement} */ (el).disabled) && el.getAttribute('aria-disabled') !== 'true'
  );
}

/** @param {Element} el */
const isSelected = (el) => el.getAttribute(el.getAttribute('role') === 'tab' ? 'aria-selected' : 'aria-checked') === 'true';

/** One Tab stop: the option focus is on (an Accounts radio moved to but not
 * picked), else the selected one, else the first.
 * @param {Element} g */
export function syncGroup(g) {
  const list = options(g);
  if (!list.length) return;
  const a = document.activeElement;
  const stop = (a && list.includes(/** @type {HTMLElement} */ (a)) ? a : null) || list.find(isSelected) || list[0];
  for (const el of list) {
    const want = el === stop ? 0 : -1;
    if (el.tabIndex !== want) el.tabIndex = want;
  }
  if (g.getAttribute('role') === 'tablist') linkPanel(g, list);
}

let ids = 0;
/** @param {Element} el @param {string} prefix */
const idOf = (el, prefix) => el.id || (el.id = prefix + ++ids);

/* the element a tab list switches: the season's episode list (SeasonPills'
 * bar is followed by it), the person's grid (follows the chips) */
/** @param {Element} g @returns {Element | null} */
function panelOf(g) {
  const from = g.closest('.detail__pills') || g;
  for (let n = from.nextElementSibling; n; n = n.nextElementSibling) {
    if (n.matches('.episodes, .grid')) return n;
    if (n.matches(GROUP)) break;
  }
  return null;
}

/** @param {Element} g @param {HTMLElement[]} tabs */
function linkPanel(g, tabs) {
  const panel = panelOf(g);
  if (!panel) return;
  const pid = idOf(panel, 'wtabpanel-');
  if (panel.getAttribute('role') !== 'tabpanel') panel.setAttribute('role', 'tabpanel');
  for (const t of tabs) {
    idOf(t, 'wtab-');
    if (t.getAttribute('aria-controls') !== pid) t.setAttribute('aria-controls', pid);
  }
  const sel = tabs.find(isSelected);
  if (sel && panel.getAttribute('aria-labelledby') !== sel.id) panel.setAttribute('aria-labelledby', sel.id);
}

/* The Library's sort chip and genre chip open the Sort & filter dialog; the
 * Unwatched chip (aria-pressed) is a toggle. */
function syncChips() {
  const sf = R.sheet && R.sheet.name === 'sortfilter' ? R.sheet : null;
  for (const chip of document.querySelectorAll('.lib .chips > .chip:not([aria-pressed])')) {
    if (chip.getAttribute('aria-haspopup') !== 'dialog') chip.setAttribute('aria-haspopup', 'dialog');
    const genre = !chip.classList.contains('chip--strong');
    const open = !!sf && !!chip.closest('.route:not([hidden])') && (sf.params?.focus === 'genre') === genre;
    if (chip.getAttribute('aria-expanded') !== String(open)) chip.setAttribute('aria-expanded', String(open));
  }
}

function scan() {
  queued = 0;
  for (const g of document.querySelectorAll(GROUP)) if (!g.closest(SKIP)) syncGroup(g);
  syncChips();
  syncLive();
}

let queued = 0;
const schedule = () => {
  if (!queued) queued = requestAnimationFrame(scan);
};

/* A mutation inside a poster grid or a rail (tiles slicing in, a % ticking on
 * a download badge) can't add a group: those don't cost a scan. */
const BUSY = '.grid, .rail__track';
/** @param {MutationRecord[]} recs */
function onMutations(recs) {
  if (queued) return;
  for (const r of recs) {
    const t = r.target.nodeType === 1 ? /** @type {Element} */ (r.target) : r.target.parentElement;
    if (!t || !t.closest(BUSY)) return schedule();
  }
}

/** @param {KeyboardEvent} e */
function onKey(e) {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const el = e.target instanceof HTMLElement ? e.target : null;
  const g = el?.closest(GROUP);
  if (!el || !g || g.closest(SKIP)) return;
  const list = options(g);
  const i = list.indexOf(el);
  if (i < 0) return;
  const tabs = g.getAttribute('role') === 'tablist';
  const vertical = g.getAttribute('aria-orientation') === 'vertical';
  const n = list.length;
  let j;
  switch (e.key) {
    case 'ArrowRight':
      if (tabs && vertical) return;
      j = i + 1;
      break;
    case 'ArrowLeft':
      if (tabs && vertical) return;
      j = i - 1;
      break;
    case 'ArrowDown':
      if (tabs && !vertical) return;
      j = i + 1;
      break;
    case 'ArrowUp':
      if (tabs && !vertical) return;
      j = i - 1;
      break;
    case 'Home':
      j = 0;
      break;
    case 'End':
      j = n - 1;
      break;
    default:
      return;
  }
  e.preventDefault();
  const to = list[(j + n) % n];
  if (to === el) return;
  for (const o of list) o.tabIndex = o === to ? 0 : -1;
  to.focus({ focusVisible: true });
  if (!g.closest(NO_FOLLOW) && !isSelected(to)) to.click();
}

export function initRoving() {
  new MutationObserver(onMutations).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-checked', 'aria-selected', 'role', 'disabled']
  });
  document.addEventListener('keydown', onKey);
  // a group that changed while nothing re-rendered (a focus that left an
  // Accounts radio it had moved to): settle its stop as focus moves
  document.addEventListener('focusout', (e) => {
    const g = e.target instanceof Element ? e.target.closest(GROUP) : null;
    if (g) requestAnimationFrame(() => syncGroup(g));
  });
  initGridKeys();
  schedule();
}
