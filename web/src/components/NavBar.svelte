<script>
  /* Web variant of phone/src/components/NavBar.svelte (swapped in by
   * web/vite.config.js; same props). The desktop has one fixed bar, WebNav:
   * this draws nothing in the page — it publishes the page's header (title,
   * solid, onback, trailing) for its route (lib/pagebar.svelte.js), and
   * WebNav shows it as the breadcrumb after the sections: "‹ Movies" (Back,
   * labelled "Back to Movies"), and once the page has scrolled past its own
   * title (`solid`) "‹ Movies › Pulp Fiction", the title scrolling the page
   * back to the top. Its place in WebNav makes Back the first Tab stop after
   * the sections, as it is the first thing on the page to the eye. */
  import { setBar, dropBar, barOwner } from '../lib/pagebar.svelte.js';

  /** @type {{ title?: string, solid?: boolean, onback?: (() => unknown) | null, class?: string, trailing?: VR.Snip }} */
  let { title = '', solid = false, onback = null, trailing } = $props();

  const owner = barOwner();
  let mark = $state(/** @type {HTMLElement | null} */ (null));
  const key = $derived(mark?.closest?.('.route')?.getAttribute('data-key') || '');

  $effect(() => {
    const k = key;
    if (!k) return;
    setBar(k, { title: title || '', solid: !!solid, onback, trailing, owner });
  });
  $effect(() => {
    const k = key;
    if (k) return () => dropBar(k, owner);
  });
</script>

<span class="wpagebar" hidden bind:this={mark}></span>
