<script>
  /* The desktop's one fixed bar, in place of the phone's tab bar and of every
   * pushed page's own bar: the wordmark, the four sections, the page trail,
   * then the bell (new seasons + "Ready to watch", the Notifications popover)
   * and the avatar (the Accounts popover).
   *
   * - Sections are real <a href>s: a middle click or Ctrl+click opens one in
   *   a new tab; a plain click switches tabs in place (router.switchTab: the
   *   active one again pops to its root, then scrolls to the top). Below
   *   ~640 px they fold into a menu button.
   * - The trail (pushed pages; their NavBar publishes title / solid / onback
   *   through lib/pagebar.svelte.js): "‹ Movies" is Back ("Back to Movies"),
   *   earlier pages pop to their level, a long trail collapses in the middle,
   *   and once the page has scrolled past its own title the title joins it
   *   ("‹ Movies › Pulp Fiction") as a button back to the top. It comes right
   *   after the sections, so Back is the first Tab stop after them.
   * - Over a page's hero the bar is transparent; once the page scrolls it
   *   turns to glass (`solid`, from App). */
  import Icon from '$p/components/Icon.svelte';
  import Avatar from '$p/components/Avatar.svelte';
  import { R, switchTab, openSheet, closeSheet, pop, popToRoot, scrollToTop } from '$p/lib/router.svelte.js';
  import { unreadCount } from '$lib/news.svelte.js';
  import { unseenLanded } from '$lib/landed.svelte.js';
  import { cfg } from '$lib/config.js';
  import { BARS, crumbsFor, collapse } from '../lib/pagebar.svelte.js';

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
  /* Settings and My library are pushed onto whichever tab opened them, but
   * they belong to the account, not to that section: while one shows, no
   * section reads as current and the avatar carries the state instead. */
  const ACCOUNT_PAGES = new Set(['settings', 'mylibrary']);
  const onAccountPage = $derived(ACCOUNT_PAGES.has(R.stacks[R.tab].at(-1)?.name ?? ''));
  const current = $derived(onAccountPage ? null : R.tab);
  const me = { server: cfg.server, userId: cfg.userId, userName: cfg.userName };

  /* the trail of the active tab's stack */
  const trail = $derived(crumbsFor(R.stacks[R.tab]));
  const here = $derived(trail.length > 1 ? trail[trail.length - 1] : null);
  const parent = $derived(trail.length > 1 ? trail[trail.length - 2] : null);
  const earlier = $derived(collapse(trail.slice(0, -2), 1));
  const bar = $derived(here ? BARS.byKey[here.key] : undefined);
  const showTitle = $derived(!!(bar?.solid && bar.title));

  /* sections menu (narrow windows) */
  let menuOpen = $state(false);
  let menuBtn = $state(/** @type {HTMLButtonElement | null} */ (null));
  $effect(() => {
    void R.tab, R.stacks;
    menuOpen = false;
  });

  /** @param {MouseEvent} e @param {VR.TabName} tab */
  function go(e, tab) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    menuOpen = false;
    switchTab(tab);
  }
  /** @param {KeyboardEvent} e */
  function menuKey(e) {
    if (e.key === 'Escape' && menuOpen) {
      e.preventDefault();
      e.stopPropagation();
      menuOpen = false;
      menuBtn?.focus();
    }
  }
  /** @param {FocusEvent} e */
  function menuBlur(e) {
    const to = /** @type {Node | null} */ (e.relatedTarget);
    const tabs = /** @type {HTMLElement} */ (e.currentTarget).closest('.wnav')?.querySelector('.wnav__tabs');
    if (menuOpen && to && !tabs?.contains(to) && to !== menuBtn) menuOpen = false;
  }
  /** @param {MouseEvent} e  a click anywhere else folds the sections menu */
  function outside(e) {
    const t = /** @type {Element | null} */ (e.target instanceof Element ? e.target : null);
    if (menuOpen && !t?.closest('.wnav__menu, .wnav__tabs')) menuOpen = false;
  }
  /* "Skip to content": the first Tab stop (shown only then), past this bar,
   * to the first control of the page on screen. */
  /** @param {MouseEvent} e */
  function skip(e) {
    e.preventDefault();
    const page = document.querySelector('.route:not([hidden])');
    const first = /** @type {HTMLElement | null | undefined} */ (
      page?.querySelector('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])')
    );
    first?.focus();
  }
  /** @param {VR.SheetName} name */
  function toggle(name) {
    if (R.sheet?.name === name) closeSheet();
    else openSheet(name);
  }
  function back() {
    if (bar?.onback) bar.onback();
    else pop();
  }
  /** @param {number} depth  pop to that level of the stack */
  function popTo(depth) {
    if (depth === 0) return popToRoot();
    const n = R.stacks[R.tab].length - 1 - depth;
    for (let i = 0; i < n; i++) pop({ animate: i === n - 1 });
  }
  function toTop() {
    const key = here?.key;
    scrollToTop(/** @type {HTMLElement | null} */ (document.querySelector(`.route[data-key="${key}"] .screen`)));
  }
</script>

<svelte:window onclick={outside} onkeydown={menuKey} />

<header class="wnav" class:wnav--solid={solid} class:wnav--deep={!!parent} class:wnav--menu={menuOpen}>
  <a class="wnav__skip" href="#content" onclick={skip}>Skip to content</a>
  <a class="wnav__mark" href="/" aria-label="VibeReel — Home" onclick={(e) => go(e, 'home')}>
    <span class="wordmark wnav__word" aria-hidden="true">Vibe<span class="wordmark__accent">Reel</span></span>
    <span class="wordmark wordmark--short wnav__mono" aria-hidden="true">V<span class="wordmark__accent">R</span></span>
  </a>
  <button
    type="button"
    class="wnav__menu"
    bind:this={menuBtn}
    aria-label="Sections"
    aria-expanded={menuOpen}
    aria-controls="wnav-sections"
    onclick={() => (menuOpen = !menuOpen)}
  >
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none" /></svg>
  </button>
  <nav class="wnav__tabs" id="wnav-sections" aria-label="Sections" onfocusout={menuBlur}>
    {#each ITEMS as it (it.tab)}
      <a class="wnav__tab" class:wnav__tab--on={current === it.tab} href={it.href} aria-current={current === it.tab ? 'page' : undefined} onclick={(e) => go(e, it.tab)}>
        {#if it.tab === 'search'}<Icon name="search" size="sm" />{/if}{it.label}
      </a>
    {/each}
  </nav>
  {#if parent}
    <nav class="wnav__trail" aria-label="Breadcrumb">
      <ol class="wnav__crumbs">
        {#each earlier as c, i (c ? c.key : 'gap-' + i)}
          <li class="wnav__crumbitem wnav__crumbitem--earlier">
            {#if c}
              <button type="button" class="wnav__crumb" onclick={() => popTo(c.depth)}>{c.label || 'Back'}</button>
            {:else}
              <span class="wnav__gap" aria-hidden="true">…</span>
            {/if}
            <span class="wnav__sep" aria-hidden="true">›</span>
          </li>
        {/each}
        <li class="wnav__crumbitem">
          <button type="button" class="wnav__back" aria-label={parent.label ? `Back to ${parent.label}` : 'Back'} onclick={back}
            ><Icon name="chevron-left" size="sm" /><span class="wnav__backto">{parent.label || 'Back'}</span><span class="wnav__backword">Back</span></button
          >
        </li>
        {#if bar?.title}
          <li class="wnav__crumbitem wnav__crumbitem--here" class:wnav__crumbitem--on={showTitle}>
            <span class="wnav__sep" aria-hidden="true">›</span>
            <button type="button" class="wnav__crumb wnav__crumb--here" aria-current="page" aria-label="{bar.title}, scroll to top" tabindex={showTitle ? undefined : -1} onclick={toTop}
              >{bar.title}</button
            >
          </li>
        {/if}
      </ol>
      {#if bar?.trailing}<div class="wnav__trailing">{@render bar.trailing()}</div>{/if}
    </nav>
  {/if}
  <div class="wnav__end">
    <button
      type="button"
      class="iconbtn wnav__btn"
      class:wnav__btn--on={R.sheet?.name === 'notifications'}
      aria-label={unread ? `Notifications, ${unread} new` : 'Notifications'}
      aria-haspopup="dialog"
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
      class:wnav__btn--here={onAccountPage}
      aria-label="Account: {cfg.userName || 'signed out'}"
      aria-haspopup="dialog"
      aria-expanded={R.sheet?.name === 'accounts'}
      onclick={() => toggle('accounts')}
    >
      <Avatar account={me} size="sm" />
    </button>
  </div>
</header>
