/* Sheet name → component; openSheet(name, params) raises it (router.svelte.js).
 * Every sheet receives { params } and renders a <Sheet> (components/Sheet.svelte);
 * the host in App.svelte supplies scrim + present/dismiss animation.
 * Placeholders to overwrite: Accounts.svelte, Notifications.svelte — B;
 * SortFilter.svelte — C. Player pickers are the player's own, not sheets here.
 * Adding a sheet: append one line (allowed for every workstream). */
import Accounts from './Accounts.svelte';
import Notifications from './Notifications.svelte';
import SortFilter from './SortFilter.svelte';
import OfflineSheet from './OfflineSheet.svelte';

export const sheets = {
  accounts: Accounts,
  notifications: Notifications,
  sortfilter: SortFilter,
  offline: OfflineSheet
};
