<script>
  /* Art — the design's `.art` image slot with an <img> inside.
   *   src      image URL (imgUrl() from $lib/api.js); null/'' → placeholder only
   *   alt      ''
   *   eager    false → loading="lazy"
   *   decode   true → set src only after a detached decode (use:decoded) — use
   *            for big backdrops, so the decode doesn't stall a frame
   *   fill     true → .art--fill (absolute, inset 0)
   *   class / style   passed to the .art element
   *   label    title lettered in serif on the placeholder (.art__label) when
   *            there is no image or it fails to load — a poster never ends up
   *            an empty frame; labelSm: the smaller lettering (thumbs)
   *   children rendered inside .art after the image (overlays)
   * While loading, the slot is flat --surface-2 (like the skeleton before it),
   * or its --a2 tint (Tile's `tint`); the image fades in over it once loaded
   * (--dur-img) — unless it was already there (memory cache: no fade, no
   * blink on a remount). A missing or failed image gets the tonal gradient
   * (.art--empty) + label. Backdrops (`decode`) don't fade: zoom.js swaps its
   * overlay for the real hero on the assumption that it shows at once. */
  import { decoded } from '$lib/decoded.js';

  let { src = null, alt = '', eager = false, decode = false, fill = false, label = '', labelSm = false, class: cls = '', style = '', children } = $props();
  let broken = $state('');
  const missing = $derived(!src || broken === src);

  /* is-in once loaded; at once (no transition) if it already is */
  function fadeIn(img) {
    const on = () => img.classList.add('is-in');
    if (img.complete && img.naturalWidth) {
      img.classList.add('no-fade');
      on();
      return;
    }
    img.addEventListener('load', on);
    return { destroy: () => img.removeEventListener('load', on) };
  }
</script>

<div class="art {fill ? 'art--fill' : ''} {missing ? 'art--empty' : ''} {cls}" {style}>
  {#if !missing}
    {#if decode}
      <img use:decoded={src} {alt} onerror={() => (broken = src)} />
    {:else}
      <img class="art__fade" {src} {alt} loading={eager ? 'eager' : 'lazy'} decoding="async" onerror={() => (broken = src)} use:fadeIn />
    {/if}
  {/if}
  {#if missing && label}<span class="art__label {labelSm ? 'art__label--sm' : ''}" aria-hidden="true">{label}</span>{/if}
  {@render children?.()}
</div>
