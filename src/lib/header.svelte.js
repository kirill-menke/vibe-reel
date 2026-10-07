/* Which tab-row dropdown is down: 'news' (the bell) | 'account' (the avatar) |
 * 'settings' (the avatar menu's Settings, SettingsMenu.svelte) | 'mylib' (its
 * My library, MyLibraryMenu.svelte) | 'mylib-del' (My library's delete
 * confirmation, in the same spot) | null. Like the library bar's LV.open, it makes the menu modal — focusables()
 * finds its `.lvmenu` — and Back closes it onto its button (Keys.svelte). */
/** @type {VR.HeaderMenuState} */
export const HM = $state(/** @satisfies {VR.HeaderMenuState} */ ({ open: null }));

/* the button Back closes each onto (Keys.svelte; 'mylib-del' is handled before: Back returns to the list) */
export const HM_BUTTON = { news: 'nav-news', account: 'nav-account', settings: 'nav-account', mylib: 'nav-account', 'mylib-del': 'nav-account' };
