<script>
  /* TopBar — tab-root header: wordmark (no title) or large serif title, then
   * bell (unseen count) + avatar. Bell → sheet 'notifications', avatar →
   * sheet 'accounts'.
   *   title     '' → the short mark "VR" (Home); 'Movies' etc. → .topbar--large.
   *             The full "VibeReel" wordmark is Login's alone (the brand moment);
   *             inside the app the monogram mirrors it: upright V, italic gold R.
   *   overlay   absolute over a hero (.topbar--overlay) — render it as a SIBLING
   *             of the page's .screen scroller, not inside it
   *   solid     glass state (.topbar--solid) — e.g. bind with use:scrollPast;
   *             then a tap on the bar's empty space scrolls the page up (NAV-08)
   *   actions   snippet before the bell (extra icon buttons) */
  import { untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import Avatar from './Avatar.svelte';
  import { openSheet, scrollToTop } from '../lib/router.svelte.js';
  import { unreadCount } from '$lib/news.svelte.js';
  import { unseenLanded } from '$lib/landed.svelte.js';
  import { cfg } from '$lib/config.js';
  import { DUR, SPRING, reducedMotion } from '../lib/safe.js';

  /** @type {{ title?: string, overlay?: boolean, solid?: boolean, class?: string, actions?: VR.Snip }} */
  let { title = '', overlay = false, solid = false, class: cls = '', actions } = $props();

  /* new seasons + unseen "Ready to watch" landings share the bell's count (as on the TV) */
  const unread = $derived(unreadCount() + unseenLanded());
  const badgeText = $derived(unread > 9 ? '9+' : String(unread));
  const me = { server: cfg.server, userId: cfg.userId, userName: cfg.userName };

  /* MOT-10 / NAV-13: the badge springs in when it appears and bumps when the count
     goes up — never on mount (a tab root mounting with 3 unseen stays still), never
     on a decrease, not on a hidden tab. WAAPI without fill, so nothing is left in
     getAnimations() and un-hiding the route doesn't replay it (a CSS animation would). */
  let badge = $state(/** @type {HTMLSpanElement | null} */ (null));
  let prevN = untrack(() => unread), prevText = untrack(() => badgeText);
  $effect(() => {
    const n = unread, text = badgeText, el = badge;
    const up = n > prevN && text !== prevText;
    const appeared = prevN === 0;
    prevN = n; prevText = text;
    if (!up || !el || reducedMotion() || el.checkVisibility?.() === false) return;
    el.animate(
      appeared
        ? [{ transform: 'scale(0.4)', opacity: 0 }, { transform: 'none', opacity: 1 }]
        : [{ transform: 'scale(0.75)' }, { transform: 'none' }],
      { duration: DUR.springQuick, easing: SPRING.bouncy }
    );
  });

  const toTop = (/** @type {MouseEvent & { currentTarget: HTMLElement }} */ e) => scrollToTop(/** @type {HTMLElement | null | undefined} */ (e.currentTarget.closest('.route')?.querySelector('.screen')));
</script>

<header class="topbar {overlay ? 'topbar--overlay' : ''} {solid ? 'topbar--solid' : ''} {title ? 'topbar--large' : ''} {cls}">
  <!-- NAV-08: the solid bar's empty space (and the mark) scrolls the page up;
       tappable only while solid (CSS), always rendered: the toggle stays paint-only -->
  <button type="button" class="topbar__totop" tabindex="-1" aria-hidden="true" onclick={toTop}></button>
  {#if title}
    <h1 class="topbar__title">{title}</h1>
  {:else}
    <p class="wordmark wordmark--short" role="img" aria-label="VibeReel">V<span class="wordmark__accent">R</span></p>
  {/if}
  <div class="topbar__actions">
    {@render actions?.()}
    <button
      type="button"
      class="iconbtn"
      aria-label={unread ? `Notifications, ${unread} new` : 'Notifications'}
      onclick={() => openSheet('notifications')}
    >
      <Icon name="bell" />
      {#if unread}<span class="iconbtn__badge" bind:this={badge}>{badgeText}</span>{/if}
    </button>
    <button type="button" class="avatarbtn" aria-label="Account: {cfg.userName || 'signed out'}" onclick={() => openSheet('accounts')}>
      <Avatar account={me} />
    </button>
  </div>
</header>
