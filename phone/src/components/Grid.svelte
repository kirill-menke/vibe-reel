<script>
  /* Grid — `.grid` poster grid (3 columns, gaps 10 × 18, gutter padding).
   *   children tiles;  el (bindable) the element;  class / style extra */
  /** @type {{ class?: string, style?: string, el?: HTMLElement | null, children?: VR.Snip }} */
  let { class: cls = '', style = '', el = $bindable(null), children } = $props();
</script>

<div class="grid {cls}" {style} bind:this={el}>{@render children?.()}</div>
