/* Sheet name → component for the web build: the phone's sheets (they render
 * the web Sheet variant — popover or dialog, App.svelte decides), minus the
 * offline-download sheet. */
import Accounts from '$p/sheets/Accounts.svelte';
import Notifications from '$p/sheets/Notifications.svelte';
import SortFilter from '$p/sheets/SortFilter.svelte';

/** @type {Partial<Record<VR.SheetName, import('svelte').Component<any>>>} */
export const sheets = {
  accounts: Accounts,
  notifications: Notifications,
  sortfilter: SortFilter
};
