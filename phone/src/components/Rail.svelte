<script>
  /* Rail — `.rail`: head (title, grey qualifier) + horizontal snap track.
   * No "See all": the user didn't want the reference (round 3) — the tabs
   * already lead to the whole library.
   *   title      rail title;  sub  grey qualifier after it ("Movies")
   *   head       snippet replacing the whole head content
   *   track      element binding for the scroller (bind:track)
   *   children   the tiles (each snaps to the start)
   *   label      aria-label of the section (defaults to title) */
  /** @type {{ title?: string, sub?: string, head?: VR.Snip, label?: string, class?: string, track?: HTMLElement | null, children?: VR.Snip }} */
  let { title = '', sub = '', head, label = '', class: cls = '', track = $bindable(null), children } = $props();
</script>

<section class="rail {cls}" aria-label={label || title || undefined}>
  {#if head || title}
    <div class="rail__head">
      {#if head}{@render head()}{:else}
        <h2 class="rail__title">{title}{#if sub}<span class="rail__title-sub">{sub}</span>{/if}</h2>
      {/if}
    </div>
  {/if}
  <div class="rail__track" bind:this={track}>{@render children?.()}</div>
</section>
