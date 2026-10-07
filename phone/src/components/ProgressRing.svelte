<script>
  /* ProgressRing — `.ring` (downloads, Up Next countdown).
   *   p      0–1
   *   label  text in the middle; default "43%"; pass '' for none
   *   lg     64 instead of 44;  glass  backed by a glass disc
   *   class / style   extra */
  /** @type {{ p?: number, label?: string, lg?: boolean, glass?: boolean, class?: string, style?: string, children?: VR.Snip }} */
  let { p = 0, label = undefined, lg = false, glass = false, class: cls = '', style = '', children } = $props();
  const v = $derived(Math.max(0, Math.min(1, Number(p) || 0)));
  const text = $derived(label === undefined ? Math.round(v * 100) + '%' : label);
</script>

<span class="ring {lg ? 'ring--lg' : ''} {glass ? 'ring--glass' : ''} {cls}" style="--p: {v}; {style}">
  <svg class="ring__svg" viewBox="0 0 36 36" aria-hidden="true">
    <circle class="ring__track" cx="18" cy="18" r="16" pathLength="100"></circle>
    <circle class="ring__value" cx="18" cy="18" r="16" pathLength="100"></circle>
  </svg>
  {#if children}{@render children()}{:else if text}<span class="ring__label">{text}</span>{/if}
</span>
