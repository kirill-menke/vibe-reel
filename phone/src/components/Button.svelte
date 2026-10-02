<script>
  /* Button — `.btn`.
   *   variant  'primary' | 'glass' | 'surface' | 'text' | 'danger' | 'status'
   *   sm, block, grow   size / layout modifiers
   *   icon     icon name before the label (iconFill for filled glyphs; play is automatic)
   *   label / children  content
   *   disabled, busy (busy = disabled + a spinner in place of the icon)
   *   p        'status' only: 0–1 progress fill behind the text (.btn__fill)
   *   onclick, type ('button'), class, …rest (aria-*, data-*)
   * variant 'status' renders the live download state (non-interactive):
   *   <Button variant="status" p={.43}><span class="btn__pct">43%</span> · 7.4 MB/s</Button> */
  import Icon from './Icon.svelte';
  let {
    variant = 'surface',
    sm = false,
    block = false,
    grow = false,
    icon = '',
    iconFill = false,
    label = '',
    disabled = false,
    busy = false,
    p = null,
    type = 'button',
    class: cls = '',
    onclick,
    children,
    ...rest
  } = $props();
</script>

<button
  {type}
  class="btn btn--{variant} {sm ? 'btn--sm' : ''} {block ? 'btn--block' : ''} {grow ? 'btn--grow' : ''} {cls}"
  disabled={disabled || busy || variant === 'status' || undefined}
  aria-busy={busy || undefined}
  style={p != null ? `--p: ${p}` : undefined}
  {onclick}
  {...rest}
>
  {#if variant === 'status'}<span class="btn__fill"></span>{/if}
  {#if busy}<span class="spinner" style="--spinner: 18px"></span>{:else if icon}<Icon name={icon} size="sm" fill={iconFill} />{/if}
  {#if children}<span>{@render children()}</span>{:else if label}<span>{label}</span>{/if}
</button>
