<script>
  /* Icon — one of the design's icons (lib/icons.js), drawn with the .i class.
   *   name   icon name (file name in docs/ios/vibereel-iphone/icons, e.g. 'chevron-right')
   *   size   '' (24) | 'sm' (20) | 'xs' (16) | 'lg' (32)
   *   fill   force .i--fill (play/pause get it automatically)
   *   gold   .i--gold
   *   class  extra classes; label → role="img" + aria-label, else aria-hidden */
  import { ICONS } from '../lib/icons.js';

  /** @type {{ name: string, size?: '' | 'sm' | 'xs' | 'lg', fill?: boolean, gold?: boolean, class?: string, label?: string } & VR.RestAttrs} */
  let { name, size = '', fill = false, gold = false, class: cls = '', label = '', ...rest } = $props();
  const ic = $derived(ICONS[/** @type {keyof typeof ICONS} */ (name)]);
</script>

{#if ic}
  <svg
    class="i {size ? 'i--' + size : ''} {fill || ic.fill ? 'i--fill' : ''} {gold ? 'i--gold' : ''} {cls}"
    viewBox="0 0 24 24"
    role={label ? 'img' : undefined}
    aria-label={label || undefined}
    aria-hidden={label ? undefined : 'true'}
    {...rest}>{@html ic.svg}</svg
  >
{/if}
