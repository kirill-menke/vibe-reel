/* confirm() — the iOS action sheet for destructive confirmations (ACT-01).
 * On iOS a menu *chooses* and an action sheet *confirms*: use this, not a
 * second context menu with a disabled caption row. One at a time; App mounts
 * the one ActionSheet (components/ActionSheet.svelte).
 *
 *   const ok = await confirm({
 *     title,              optional bold-ish caption line
 *     message,            the question / consequence (13 pt, faint)
 *     action,             the confirming button's label ("Delete Download")
 *     danger = true,      red action (a destructive confirmation)
 *     cancel = 'Cancel'   the separate Cancel button
 *   });                   → true (action) | false (Cancel, scrim, Escape,
 *                           or replaced by a newer confirm)
 *
 *   confirmMenu(items)    the shared cancel.svelte.js confirmItems() shape
 *                         ([caption (disabled), action (danger), sep, keep])
 *                         as an action sheet: runs the action's own
 *                         `action()` on confirm. For adopters that build
 *                         those items today: `confirmMenu(confirmItems(…))`
 *                         instead of opening a second ContextMenu.
 */

/** @type {VR.ConfirmState} */
export const CONFIRM = $state({ req: null }); // { id, title, message, action, danger, cancel, resolve }

let seq = 0;

/** @param {VR.ConfirmOptions} [opts] @returns {Promise<boolean>} */
export function confirm({ title = '', message = '', action = 'OK', danger = true, cancel = 'Cancel' } = {}) {
  CONFIRM.req?.resolve(false); // a newer question replaces an unanswered one
  return new Promise((resolve) => {
    const id = ++seq;
    CONFIRM.req = {
      id,
      title,
      message,
      action,
      danger,
      cancel,
      resolve: (/** @type {unknown} */ v) => {
        if (CONFIRM.req?.id === id) CONFIRM.req = null;
        resolve(!!v);
      }
    };
  });
}

/* Answer the open one (ActionSheet calls this). */
/** @param {unknown} v truthy = confirmed */
export function answer(v) {
  CONFIRM.req?.resolve(v);
}

/** A ContextMenu's items as a confirm(): the caption is the message, the danger (else first)
 * action the button.
 * @param {VR.CtxItem[] | null | undefined} items @returns {Promise<boolean>} */
export async function confirmMenu(items) {
  const list = (items || []).filter((x) => x && !x.sep);
  const caption = list.find((x) => x.disabled || x.title);
  const act = list.find((x) => x.danger) || list.find((x) => x !== caption && x.action);
  const keep = list.find((x) => x !== caption && x !== act);
  if (!act) return false;
  const ok = await confirm({
    message: caption?.label || '',
    action: act.label,
    danger: !!act.danger,
    cancel: keep?.label || 'Cancel'
  });
  if (ok) act.action?.();
  return ok;
}
