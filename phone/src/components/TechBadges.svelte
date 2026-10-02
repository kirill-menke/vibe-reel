<script>
  /* TechBadges — `.techbadges` row of `.tech` chips.
   *   badges  [string | { label, strong }] — strong (filled) for resolution /
   *           HDR format, e.g. ['4K'→strong, 'Dolby Vision'→strong, 'DD+ 5.1', 'Atmos', 'EN · DE subs'] */
  let { badges = [], class: cls = '' } = $props();
  const list = $derived((badges || []).filter(Boolean).map((b) => (typeof b === 'string' ? { label: b } : b)));
</script>

{#if list.length}
  <div class="techbadges {cls}">
    {#each list as b, i (i)}<span class="tech {b.strong ? 'tech--strong' : ''}">{b.label}</span>{/each}
  </div>
{/if}
