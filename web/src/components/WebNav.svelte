<script>
  /* The desktop's top navigation, in place of the phone's tab bar: the mark,
   * the four sections, then the bell (new seasons + "Ready to watch", the
   * Notifications popover) and the avatar (the Accounts popover). The links
   * are real <a href>s — a middle click or Ctrl+click opens the section in a
   * new tab; a plain click switches tabs in place (router.switchTab: the
   * active one again pops to its root, then scrolls to the top). Over a
   * page's hero the bar is transparent; once the page scrolls it turns to
   * glass (`solid`, from App). */
  import Icon from '$p/components/Icon.svelte';
  import Avatar from '$p/components/Avatar.svelte';
  import { R, switchTab, openSheet, closeSheet } from '$p/lib/router.svelte.js';
  import { unreadCount } from '$lib/news.svelte.js';
  import { unseenLanded } from '$lib/landed.svelte.js';
  import { cfg } from '$lib/config.js';

  /** @type {{ solid?: boolean }} */
  let { solid = false } = $props();

  /** @type {{ tab: VR.TabName, label: string, href: string }[]} */
  const ITEMS = [
    { tab: 'home', label: 'Home', href: '/' },
    { tab: 'movies', label: 'Movies', href: '/movies' },
    { tab: 'shows', label: 'Shows', href: '/shows' },
    { tab: 'search', label: 'Search', href: '/search' }
  ];

  const unread = $derived(unreadCount() + unseenLanded());
  const me = { server: cfg.server, userId: cfg.userId, userName: cfg.userName };

  /** @param {MouseEvent} e @param {VR.TabName} tab */
  function go(e, tab) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    switchTab(tab);
  }
  /** @param {VR.SheetName} name */
  function toggle(name) {
    if (R.sheet?.name === name) closeSheet();
    else openSheet(name);
  }
</script>

<header class="wnav" class:wnav--solid={solid}>
  <a class="wnav__mark" href="/" aria-label="VibeReel — Home" onclick={(e) => go(e, 'home')}>
    <span class="wordmark wordmark--short">V<span class="wordmark__accent">R</span></span>
    <span class="wnav__name">VibeReel</span>
  </a>
  <nav class="wnav__tabs" aria-label="Sections">
    {#each ITEMS as it (it.tab)}
      <a class="wnav__tab" class:wnav__tab--on={R.tab === it.tab} href={it.href} aria-current={R.tab === it.tab ? 'page' : undefined} onclick={(e) => go(e, it.tab)}>
        {#if it.tab === 'search'}<Icon name="search" size="sm" />{/if}{it.label}
      </a>
    {/each}
  </nav>
  <div class="wnav__end">
    <button
      type="button"
      class="iconbtn wnav__btn"
      class:wnav__btn--on={R.sheet?.name === 'notifications'}
      aria-label={unread ? `Notifications, ${unread} new` : 'Notifications'}
      aria-expanded={R.sheet?.name === 'notifications'}
      onclick={() => toggle('notifications')}
    >
      <Icon name="bell" />
      {#if unread}<span class="iconbtn__badge">{unread > 9 ? '9+' : unread}</span>{/if}
    </button>
    <button
      type="button"
      class="avatarbtn wnav__btn"
      class:wnav__btn--on={R.sheet?.name === 'accounts'}
      aria-label="Account: {cfg.userName || 'signed out'}"
      aria-expanded={R.sheet?.name === 'accounts'}
      onclick={() => toggle('accounts')}
    >
      <Avatar account={me} size="sm" />
    </button>
  </div>
</header>
