<script>
  /* MetaLine — `.meta`: "2024 · 1 h 59 min · ★ 7.1 [FSK 16]".
   *   parts   strings joined by dots (year, runtime / "2 seasons", …)
   *   rating  community rating (number) → gold star
   *   cert    certification box (OfficialRating) */
  import Icon from '../Icon.svelte';
  /** @type {{ parts?: (string | number | null | false | undefined)[], rating?: number | null, cert?: string | null }} */
  let { parts = [], rating = null, cert = '' } = $props();
  const list = $derived((parts || []).filter(Boolean));
</script>

{#if list.length || rating || cert}
  <div class="meta">
    {#each list as p, i (i)}{#if i}<i class="meta__dot"></i>{/if}<span>{p}</span>{/each}
    {#if rating}{#if list.length}<i class="meta__dot"></i>{/if}<span class="meta__rating"><Icon name="star" fill />{Number(rating).toFixed(1)}</span>{/if}
    {#if cert}<span class="meta__cert">{cert}</span>{/if}
  </div>
{/if}
