<script>
  /* LoadError — the one "this didn't load" card (same contract as the TV's
   * src/components/LoadError.svelte):
   *   title    'Couldn’t load this title'
   *   error    the caught error (text via errText()); reason overrides the line
   *   retry    () => Promise — re-run the load. It must RETURN its promise and
   *            clear the parent's error only on success, so a failed retry
   *            keeps this card mounted (Retry reads "Retrying…" meanwhile).
   *   busy     the parent's own retry-in-flight flag
   *   auto     true: retry by itself on reconnect/resume and every 60 s
   *            (reconnect.js); false when the parent runs its own onReconnect
   *   fill     centred in the page (default) — card: inline card instead
   *   children extra buttons after Retry (e.g. "Switch server")
   * A network-level failure also raises the app's offline banner (conn.noteError). */
  import { onMount } from 'svelte';
  import { errText } from '$lib/api.js';
  import { onReconnect } from '$lib/reconnect.js';
  import { noteError, conn } from '../lib/conn.svelte.js';
  import StateMessage from './StateMessage.svelte';
  import Button from './Button.svelte';

  let {
    title = 'Couldn’t load this title',
    error = null,
    reason = '',
    retry,
    busy = false,
    auto = true,
    fill = true,
    card = false,
    class: cls = '',
    children
  } = $props();

  const why = $derived(reason || (error ? errText(error) : ''));
  const net = $derived(!!(error && (error.network || error.status >= 502)));

  let running = $state(false);
  async function run() {
    if (running || busy) return;
    running = true;
    try {
      await retry?.();
    } catch {
      /* a failed retry keeps the card; the parent holds the new error */
    } finally {
      running = false;
    }
  }

  $effect(() => {
    if (error) noteError(error);
  });

  /* The offline banner's check (its Retry, the 20 s timer) found the server
   * again: a network failure retries at once instead of waiting for the next
   * onReconnect tick — also for auto={false} cards (their retry is the
   * parent's own). */
  let wasOffline = conn.offline;
  $effect(() => {
    const off = conn.offline;
    if (wasOffline && !off && net) run();
    wasOffline = off;
  });

  onMount(() => {
    if (auto) return onReconnect(() => run(), { every: 60000 });
  });
</script>

<StateMessage icon={net ? 'cloud-off' : 'alert'} {title} text={why} error fill={fill && !card} {card} class={cls}>
  {#snippet actions()}
    <Button variant="primary" icon="refresh" busy={busy || running} onclick={run}>{busy || running ? 'Retrying…' : 'Retry'}</Button>
    {@render children?.()}
  {/snippet}
</StateMessage>
