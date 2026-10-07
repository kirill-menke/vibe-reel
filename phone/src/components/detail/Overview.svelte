<script>
  /* Overview — `.overview` clamped to 3 lines. When the text is actually
   * clipped, a "more" sits at the end of the third line over a soft fade, and
   * a tap on the text itself expands it too (App Store / Apple TV, DET-12).
   * The page reflows once; only the new lines unveil (a clip-path reveal,
   * none under Reduce Motion). No collapse, as on iOS.
   *   text   the overview;  class  extra on the paragraph
   * Selectable (PWA-03): Look Up / Translate are useful on plot text — a tap
   * never selects, so tap-to-expand doesn't fight it. */
  import { tick } from 'svelte';
  import { reducedMotion, DUR, EASE } from '../../lib/safe.js';
  /** @type {{ text?: string, class?: string }} */
  let { text = '', class: cls = '' } = $props();
  let el = $state(/** @type {HTMLParagraphElement | null} */ (null));
  let open = $state(false);
  let clipped = $state(false);

  $effect(() => {
    void text;
    open = false;
    tick().then(measure);
  });
  function measure() {
    if (el && !open) clipped = el.scrollHeight > el.clientHeight + 2;
  }
  /* a page mounted while hidden measures 0 — re-check once it has a size */
  $effect(() => {
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });

  async function expand() {
    if (open || !clipped || !el) return;
    if (getSelection()?.toString()) return; // a selection gesture, not a tap
    const h0 = el.clientHeight;
    open = true;
    await tick();
    if (!el) return;
    const d = el.clientHeight - h0;
    if (d > 0 && !reducedMotion())
      el.animate([{ clipPath: `inset(0 0 ${d}px 0)` }, { clipPath: 'inset(0 0 0 0)' }], { duration: DUR.img, easing: EASE.out });
  }
</script>

{#if text}
  {@const tap = clipped && !open}
  <div class="overview-wrap">
    <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role, a11y_no_noninteractive_tabindex -->
    <p
      class="overview selectable {open ? '' : 'overview--clamp'} {cls}"
      bind:this={el}
      role={tap ? 'button' : undefined}
      tabindex={tap ? 0 : undefined}
      aria-expanded={tap ? 'false' : undefined}
      onclick={expand}
      onkeydown={(e) => tap && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), expand())}
    >{text}</p>
    {#if tap}<button class="overview__more overview__more--inline" type="button" tabindex="-1" aria-hidden="true" onclick={expand}>more</button>{/if}
  </div>
{/if}
