<script>
  /* StatusButton — the greyed live download state in place of the primary
   * button ("43% · 7.4 MB/s · 1 h 12 min left" / "Queued · waiting for a slot").
   *   s       statusParts() result { pct, rate, eta, rest, p }
   *   prefix  text before it ("Downloading · " for a show)
   * Not a live region: VoiceOver would re-read the numbers every 4 s poll. The
   * pages announce state *changes* instead (a polite sr-only line with the
   * eyebrow word — DET-10). The % and the speed sit in fixed-width boxes so the
   * centred line doesn't jitter; the fill glides (components.css). */
  import Button from '../Button.svelte';
  let { s, prefix = '', noIcon = false } = $props();
</script>

<Button variant="status" block p={s.p} icon={s.pct || noIcon ? '' : 'clock'}>
  {prefix}{#if s.pct}<span class="btn__pct">{s.pct}</span>{#if s.rate}{' · '}<span class="btn__rate">{s.rate}</span>{/if}{#if s.eta}{' · '}{s.eta}{/if}{:else}{s.rest}{/if}
</Button>
