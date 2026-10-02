<script>
  /* NavBar — pushed-page header: glass back button · title · trailing slot.
   * Render it as a SIBLING of the page's .screen scroller.
   *   title     shown once solid; then also a button: tap = scroll the page to
   *             the top (the status-bar tap a web app can't get, NAV-08)
   *   solid     .navbar--solid (e.g. once the backdrop has scrolled under it — use:scrollPast)
   *   onback    default: pop()
   *   trailing  snippet for the right slot (an icon button)
   * The back button is labelled with the page underneath ("Back to Movies"),
   * as VoiceOver reads UIKit's (NAV-09). */
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { R, pop, scrollToTop } from '../lib/router.svelte.js';
  let { title = '', solid = false, onback = null, class: cls = '', trailing } = $props();

  const ROOTS = { home: 'Home', movies: 'Movies', shows: 'Shows', search: 'Search' };
  let navEl = $state(null);
  let backTo = $state('');

  /* the title of the route under ours: a tab root by name, else its heading */
  function beneathTitle() {
    const key = navEl?.closest('.route')?.dataset.key;
    if (!key) return '';
    for (const list of Object.values(R.stacks)) {
      const i = list.findIndex((r) => r.key === key);
      if (i < 1) continue;
      const prev = list[i - 1];
      if (ROOTS[prev.name]) return ROOTS[prev.name];
      const r = document.querySelector(`.route[data-key="${prev.key}"]`);
      const h = r?.querySelector('.screen h1') || r?.querySelector('h1, .navbar__title');
      return h?.textContent.trim() || '';
    }
    return '';
  }
  $effect(() => {
    void R.stacks, solid;
    tick().then(() => (backTo = beneathTitle()));
  });

  function toTop(e) {
    scrollToTop(e.currentTarget.closest('.route')?.querySelector('.screen'));
  }
</script>

<nav class="navbar {solid ? 'navbar--solid' : ''} {cls}" bind:this={navEl}>
  <button type="button" class="iconbtn" aria-label={backTo ? `Back to ${backTo}` : 'Back'} onclick={() => (onback ? onback() : pop())}
    ><Icon name="chevron-left" /></button
  >
  {#if title}
    <button type="button" class="navbar__title" tabindex={solid ? undefined : -1} aria-label={solid ? `${title}, scroll to top` : undefined} onclick={toTop}
      >{title}</button
    >
  {:else}<span></span>{/if}
  {#if trailing}{@render trailing()}{:else}<span></span>{/if}
</nav>
