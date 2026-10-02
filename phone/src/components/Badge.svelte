<script>
  /* Badge — `.badge`, 20 high, glass by default.
   *   kind   '' | 'gold' | 'outline'      pill  rounded ends
   *   rank   number → serif rank badge (gold for 1–3 unless kind given)
   *   icon   icon name before the text
   *   text / children   content
   *   class  extra (e.g. 'tile__badge', 'tile__corner') */
  import Icon from './Icon.svelte';
  let { kind = '', pill = false, rank = null, icon = '', text = '', class: cls = '', label = '', children } = $props();
  const k = $derived(kind || (rank != null && rank <= 3 ? 'gold' : ''));
</script>

<span
  class="badge {k ? 'badge--' + k : ''} {pill ? 'badge--pill' : ''} {rank != null ? 'badge--rank' : ''} {cls}"
  role={label ? 'img' : undefined}
  aria-label={label || undefined}
>
  {#if icon}<Icon name={icon} />{/if}{#if rank != null}{rank}{:else if children}{@render children()}{:else}{text}{/if}
</span>
