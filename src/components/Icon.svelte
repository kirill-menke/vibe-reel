<script>
  import { ICONS } from '../lib/icons.js';

  /* inline=true wraps the glyph in .gi so it sits inside a text label */
  let { name, inline = false } = $props();
</script>

{#if inline}<span class="gi"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">{@html ICONS[name] ?? ''}</svg></span>{:else}<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">{@html ICONS[name] ?? ''}</svg>{/if}
