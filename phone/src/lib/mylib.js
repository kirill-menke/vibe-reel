/* My library on the phone (run/design.md §7): the glue between the shared
 * me.svelte.js (GET /api/me, deleteTitle) and the phone's UI.
 *
 *   askDelete(t)   the iOS action sheet (confirm.svelte.js, ACT-01) asks
 *                  "Delete “Dune”?" — red Delete, Keep — and only then runs
 *                  deleteTitle (DELETE /api/library/{type}/{id}?delete_files=true:
 *                  the title and its files leave the server for everyone).
 *                  → true once deleted. A row whose delete runs asks nothing.
 *   meAtBoot()     one /api/me a moment after boot (App.svelte, once R.booted),
 *                  so the tiles' quick "+" knows the quota before anyone opens
 *                  My library. Off the boot path; never twice. */
import { tick } from 'svelte';
import { confirm } from './confirm.svelte.js';
import { deleteTitle, deleteMessage, deleting, titleKey, refreshMe } from '$lib/me.svelte.js';

/** @param {Reel.OwnedTitle} t @returns {Promise<boolean>} */
export async function askDelete(t) {
  if (deleting[titleKey(t)]) return false;
  if (__PHONE__ && __WEB__) beforeDelete = [...document.querySelectorAll('.mylib__item')].filter((r) => r.getClientRects().length).map((r) => r.getAttribute('data-key') || '');
  const ok = await confirm({
    title: 'Delete “' + t.title + '”?',
    message: deleteMessage(t.type),
    action: 'Delete',
    danger: true,
    cancel: 'Keep'
  });
  return ok ? (__PHONE__ && __WEB__ ? deleteAndRefocus(t) : deleteTitle(t)) : false;
}

/* Web (B-15): the deleted row takes its focused Delete button with it, and
 * focus fell to <body>. It goes to the next row's Delete, else the previous
 * one's, else the page heading; a delete that failed leaves the row, and focus
 * goes back to its button. Rows are looked up in the shown page only (the
 * desktop keeps every route mounted). */
/** @param {Reel.OwnedTitle} t @returns {Promise<boolean>} */
async function deleteAndRefocus(t) {
  const key = titleKey(t);
  const done = await deleteTitle(t);
  await tick();
  const rows = [...document.querySelectorAll('.mylib__item')].filter((r) => r.getClientRects().length);
  const own = rows.find((r) => r.getAttribute('data-key') === key);
  if (!done) {
    if (own) focusLater(own.querySelector('.mylib__del'));
    return false;
  }
  /* the row is gone now (or still on its way out): its neighbours in the order
   * they were, from the list as it was when the confirm closed */
  const at = beforeDelete.indexOf(key);
  const keys = rows.map((r) => r.getAttribute('data-key'));
  const next = beforeDelete.slice(at + 1).find((k) => keys.includes(k)) || beforeDelete.slice(0, Math.max(0, at)).reverse().find((k) => keys.includes(k));
  const row = next ? rows[keys.indexOf(next)] : null;
  const head = /** @type {HTMLElement | null} */ (rows[0]?.closest('.screen')?.querySelector('.pagehead__title') || visibleHeading());
  if (row) focusLater(row.querySelector('.mylib__del'));
  else if (head) {
    head.tabIndex = -1;
    focusLater(head);
  }
  return true;
}
/** @type {string[]} the shown rows' keys when the last Delete was confirmed */
let beforeDelete = [];
function visibleHeading() {
  for (const s of document.querySelectorAll('.screen.mylib')) if (s.getClientRects().length) return s.querySelector('.pagehead__title');
  return null;
}
/* focus once the page is focusable again (the confirm's inert hold on the
 * shell is released when it closes; a few frames at most) */
/** @param {Element | null | undefined} el */
function focusLater(el, tries = 10) {
  if (!el || !el.isConnected) return;
  const h = /** @type {HTMLElement} */ (el);
  h.focus({ preventScroll: false });
  if (document.activeElement !== h && tries > 0) requestAnimationFrame(() => focusLater(el, tries - 1));
}

let asked = false;
export function meAtBoot(delay = 2000) {
  if (asked) return;
  asked = true;
  /* web (E-11): a deep link to My library or a lookup page asked at mount;
   * an answer that fresh is the one this would fetch again */
  setTimeout(() => (__PHONE__ && __WEB__ ? refreshMe({ maxAge: 10000 }) : refreshMe()), delay);
}
