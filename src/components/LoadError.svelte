<script>
  /* The one "this didn't load" card (Detail, Person, SeriesDetail, and the
   * Home / Library failcards): say so, say why, and offer the ways on — Retry
   * (focused, so one OK tries again; reads "Retrying…" while it runs) and Back
   * (the same as the remote's Back key, for a remote-less pointer user and so
   * the D-pad always has somewhere to be). `retry` is re-run in place; the
   * parent decides whether that remounts anything.
   *
   *   reason  — a ready-made why-line (else errText(error))
   *   back    — false: no Back button (Home, where Back is a no-op; Library)
   *   under   — the card sits under a TopNav: top-aligned, not full height
   *   busy    — the parent's own "retry in flight" flag (its auto-retry too)
   *   auto    — false: the parent runs its own onReconnect (Home, Library)
   *   children — extra buttons after Retry (Home's "Change server")
   * `fkey` prefixes Back (`{fkey}-back`); Retry is `{fkey}-retry` unless
   * `retryKey` pins it (Home's `home-retry`, Library's `lib-retry`). */
  import { onMount } from 'svelte';
  import { onBack } from '../lib/nav.svelte.js';
  import { focusKey } from '../lib/focus.js';
  import { errText } from '../lib/api.js';
  import { onReconnect } from '../lib/reconnect.js';

  let {
    title = 'Couldn’t load this title',
    error = null,
    reason = '',
    retry,
    fkey = 'err',
    retryKey = '',
    inline = false,
    under = false,
    back = true,
    busy = false,
    auto = true,
    children
  } = $props();

  const rkey = $derived(retryKey || fkey + '-retry');
  const why = $derived(reason || (error ? errText(error) : ''));

  let running = $state(false);
  async function run() {
    if (running || busy) return;
    running = true;
    try {
      await retry?.();
    } finally {
      running = false;
    }
  }

  onMount(() => {
    const a = document.activeElement;
    // don't pull focus off a live control (a season pill above an inline error)
    if (!a || a === document.body) focusKey(rkey);
    /* Wi-Fi back / app resumed / every minute: retry by itself, so a card left
     * up during a network drop doesn't outlive the drop (reconnect.js). */
    if (auto) return onReconnect(() => run(), { every: 60000 });
  });
</script>

<div class="loaderr" class:inline class:under>
  <div class="t">{title}</div>
  {#if why}<div class="why">{why}</div>{/if}
  <div class="actions">
    <button class="btn primary big focus" class:busy={busy || running} data-focus={rkey} onclick={run}
      >{busy || running ? 'Retrying…' : 'Retry'}</button
    >
    {@render children?.()}
    {#if back && !inline}<button class="btn ghost big focus" data-focus="{fkey}-back" onclick={onBack}>Back</button>{/if}
  </div>
</div>
