<script>
  /* StateMessage — `.state`: icon disc, heading, text, actions.
   *   icon    icon name ('cloud-off', 'search', 'alert', …)
   *   title, text
   *   error   danger disc (.state--error)
   *   fill    centred in the page (.state--fill);  card  inline card (.state--card)
   *   actions snippet (buttons); children appended after the text
   *   role    defaults to 'alert' for errors */
  import Icon from './Icon.svelte';
  let { icon = '', title = '', text = '', error = false, fill = false, card = false, class: cls = '', actions, children } = $props();
</script>

<div class="state {error ? 'state--error' : ''} {fill ? 'state--fill' : ''} {card ? 'state--card' : ''} {cls}" role={error ? 'alert' : undefined}>
  {#if icon}<span class="state__icon"><Icon name={icon} /></span>{/if}
  {#if title}<h2 class="state__title">{title}</h2>{/if}
  {#if text}<p class="state__text">{text}</p>{/if}
  {@render children?.()}
  {#if actions}<div class="state__actions">{@render actions()}</div>{/if}
</div>
