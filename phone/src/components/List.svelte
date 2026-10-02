<script>
  /* List — `.list` grouped rows (surface-1; surface-2 inside a sheet).
   *   label  group label above (.group__label);  foot  note below (.group__foot)
   *   group  wrap in `.group` (top padding between groups)
   *   flush  .list--flush (no card)
   *   role / class   children: Row components */
  let { label = '', foot = '', group = false, flush = false, role = undefined, class: cls = '', style = '', children } = $props();
</script>

{#if group || label || foot}
  <div class={group ? 'group' : ''}>
    {#if label}<p class="group__label">{label}</p>{/if}
    <div class="list {flush ? 'list--flush' : ''} {cls}" {role} {style}>{@render children?.()}</div>
    {#if foot}<p class="group__foot">{foot}</p>{/if}
  </div>
{:else}
  <div class="list {flush ? 'list--flush' : ''} {cls}" {role} {style}>{@render children?.()}</div>
{/if}
