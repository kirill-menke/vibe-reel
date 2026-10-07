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
import { confirm } from './confirm.svelte.js';
import { deleteTitle, deleteMessage, deleting, titleKey, refreshMe } from '$lib/me.svelte.js';

/** @param {Reel.OwnedTitle} t @returns {Promise<boolean>} */
export async function askDelete(t) {
  if (deleting[titleKey(t)]) return false;
  const ok = await confirm({
    title: 'Delete “' + t.title + '”?',
    message: deleteMessage(t.type),
    action: 'Delete',
    danger: true,
    cancel: 'Keep'
  });
  return ok ? deleteTitle(t) : false;
}

let asked = false;
export function meAtBoot(delay = 2000) {
  if (asked) return;
  asked = true;
  setTimeout(() => refreshMe(), delay);
}
