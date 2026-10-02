<script>
  /* Search's own on-screen keyboard. The webOS system keyboard pops up the
   * moment a text field takes focus — which made walking past the search bar
   * to the IMDb categories impossible without it — so Search has no text field
   * any more: the bar is a plain focusable, OK on it opens this panel under
   * it, and every key is an ordinary D-pad target (`.focus` + `data-focus`).
   * ▼ from the last row walks on into the results; Back closes the panel
   * (Keys.svelte, S.searchKb). A plugged-in USB keyboard types too. */
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { S } from '../lib/nav.svelte.js';

  let { ontype, ondelete, onclear, ondone } = $props();

  const ROWS = ['abcdefghijklm', 'nopqrstuvwxyz', "1234567890'-&"];

  /* A USB keyboard, while Search is up: printable keys type, Backspace
   * deletes. The remote never sends these keyCodes. */
  onMount(() => {
    const onKey = (e) => {
      if (!S.search || S.screen === 'player' || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.keyCode === 8) {
        e.preventDefault();
        ondelete();
      } else if (e.key && e.key.length === 1 && e.keyCode !== 13 && (e.keyCode === 32 || e.keyCode >= 48)) {
        e.preventDefault();
        ontype(e.key.toLowerCase());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
</script>

<div class="skb">
  {#each ROWS as row, r (r)}
    <div class="skrow">
      {#each row.split('') as ch (ch)}
        <button class="skey focus" data-focus="kb-{ch}" onclick={() => ontype(ch)}>{ch}</button>
      {/each}
    </div>
  {/each}
  <div class="skrow">
    <button class="skey wide focus" data-focus="kb-space" onclick={() => ontype(' ')}>Space</button>
    <button class="skey mid focus" data-focus="kb-del" aria-label="Delete" onclick={ondelete}><Icon name="backspace" /></button>
    <button class="skey mid focus" data-focus="kb-clear" onclick={onclear}>Clear</button>
    <button class="skey mid done focus" data-focus="kb-done" onclick={ondone}>Done</button>
  </div>
</div>
