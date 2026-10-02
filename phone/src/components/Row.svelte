<script>
  /* Row — `.row` inside a List.
   *   title, sub           main text
   *   icon                 icon name in a 30 pt tile (.row__icon); iconStyle for its colours
   *   lead                 snippet instead of the icon (e.g. an avatar)
   *   value                grey value on the right (.row__value)
   *   chevron              trailing chevron-right;  check  trailing gold check
   *   trail                snippet for the trailing slot (a Switch, a Get button…)
   *   selected, danger, action, column, insetSep   modifiers (.row--…)
   *   wrap                 title/sub wrap instead of ellipsis (settings, long
   *                        labels at large text sizes)
   *   onclick              makes it a <button>; without it the row is a <div>
   *   children             rendered under the main text (column rows: the control)
   *   …rest                aria-*, role, data-* on the row element */
  import Icon from './Icon.svelte';
  let {
    title = '',
    sub = '',
    icon = '',
    iconStyle = '',
    lead,
    value = '',
    chevron = false,
    check = false,
    trail,
    selected = false,
    danger = false,
    action = false,
    column = false,
    insetSep = false,
    wrap = false,
    onclick,
    class: cls = '',
    children,
    ...rest
  } = $props();
  const klass = $derived(
    [
      'row',
      selected && 'row--selected',
      danger && 'row--danger',
      action && 'row--action',
      column && 'row--column',
      insetSep && 'row--inset-sep',
      wrap && 'row--wrap',
      cls
    ]
      .filter(Boolean)
      .join(' ')
  );
</script>

{#snippet body()}
  {#if lead}{@render lead()}{:else if icon}<span class="row__icon" style={iconStyle}><Icon name={icon} /></span>{/if}
  {#if column}
    {#if title}<span class="row__title">{title}</span>{/if}
    {@render children?.()}
  {:else}
    <span class="row__main">
      {#if title}<span class="row__title">{title}</span>{/if}
      {#if sub}<span class="row__sub">{sub}</span>{/if}
      {@render children?.()}
    </span>
    {#if value}<span class="row__value">{value}</span>{/if}
    {#if check}<Icon name="check" size="sm" class="row__check" />{/if}
    {#if trail || chevron}
      <span class="row__trail">{@render trail?.()}{#if chevron}<Icon name="chevron-right" size="sm" />{/if}</span>
    {/if}
  {/if}
{/snippet}

{#if onclick}
  <button type="button" class={klass} {onclick} {...rest}>{@render body()}</button>
{:else}
  <div class={klass} {...rest}>{@render body()}</div>
{/if}
