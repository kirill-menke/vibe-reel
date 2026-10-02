/* Which tab-row dropdown is down: 'news' (the bell) | 'account' (the avatar) |
 * 'settings' (the avatar menu's Settings, SettingsMenu.svelte) | null. Like the library bar's LV.open, it makes the menu modal — focusables()
 * finds its `.lvmenu` — and Back closes it onto its button (Keys.svelte). */
export const HM = $state({ open: null });

export const HM_BUTTON = { news: 'nav-news', account: 'nav-account', settings: 'nav-account' };
