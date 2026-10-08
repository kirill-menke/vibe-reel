/* Accessibility of the title pages' shared phone markup, fixed on the live DOM
 * (a phone component can't grow attributes without moving the phone bundle).
 * Started once from main.js: one MutationObserver, one pass per mutation burst.
 *
 *  - A download's live state (`.btn--status`: "43% · 7.1 MB/s · 1 h 11 min
 *    left", "Queued · waiting for a slot") was a disabled button: announced
 *    "dimmed", skipped by Tab, no progress semantics (C-15). It is a
 *    progressbar named "Download", its value the % (none = indeterminate) and
 *    its text the visible line; not disabled, so a page can focus it (after
 *    Add, B-15), but out of the Tab order (tabindex −1).
 *  - The pending page's "Cancel" pill names its object: "Cancel download"
 *    (the visible word stays short — the action row fits one line at 1440).
 *  - Initials drawn under a photo (cast circles, the person page) and the
 *    avatar initial in a row that names the account joined the accessible
 *    names: "JT John Travolta Vincent Vega", "K kirill Signed in" (C-12). */

/** @param {HTMLElement} el */
export function statusAsProgress(el) {
  if (el.hasAttribute('disabled')) el.removeAttribute('disabled');
  if (el.getAttribute('role') !== 'progressbar') {
    el.setAttribute('role', 'progressbar');
    el.setAttribute('tabindex', '-1');
    el.setAttribute('aria-label', 'Download');
    el.setAttribute('aria-valuemin', '0');
    el.setAttribute('aria-valuemax', '100');
  }
  const pct = el.querySelector('.btn__pct');
  const n = pct ? parseInt(pct.textContent || '', 10) : NaN;
  if (Number.isFinite(n)) {
    if (el.getAttribute('aria-valuenow') !== String(n)) el.setAttribute('aria-valuenow', String(n));
  } else el.removeAttribute('aria-valuenow');
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  if (text && el.getAttribute('aria-valuetext') !== text) el.setAttribute('aria-valuetext', text);
}

/** @param {ParentNode} root */
export function fixPages(root) {
  for (const el of root.querySelectorAll('.btn--status')) statusAsProgress(/** @type {HTMLElement} */ (el));
  for (const el of root.querySelectorAll('.cast__initials:not([aria-hidden]), .row .avatar:not([aria-hidden])')) el.setAttribute('aria-hidden', 'true');
  for (const el of root.querySelectorAll('.detail__body .action:not([aria-label])')) if (el.textContent?.trim() === 'Cancel') el.setAttribute('aria-label', 'Cancel download');
}

/** @param {MutationRecord[]} recs */
function relevant(recs) {
  for (const r of recs) {
    const t = r.target.nodeType === 1 ? /** @type {Element} */ (r.target) : r.target.parentElement;
    // the player's clock and scrubber tick several times a second: not ours
    if (t && !t.closest('.wplayer')) return true;
  }
  return false;
}

let started = false;
export function initPagesA11y(root = document.body) {
  if (started || typeof MutationObserver === 'undefined') return;
  started = true;
  let queued = false;
  const run = () => {
    queued = false;
    fixPages(root);
  };
  new MutationObserver((recs) => {
    if (queued || !relevant(recs)) return;
    queued = true;
    // before the next paint and the accessibility tree's next update
    queueMicrotask(run);
  }).observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['disabled'] });
  run();
}
