<script>
  /* Up Next (upNextVisible()): from the credits marker, or the last 20 s of the
   * file, with the engine's countdown ring (10 s, or 20 s without a marker).
   * Play now rolls on at once; Watch credits dismisses the card for this pass
   * (seeking back before the credits re-arms it — engine rules). With Settings'
   * autoplay off there is no countdown: the card waits for a choice.
   *   inline  portrait: sits in the info column instead of over the video */
  import { fade, fly } from 'svelte/transition';
  import Icon from '$p/components/Icon.svelte';
  import { DUR, easeSheet, rmOut, reducedMotion } from '$p/lib/safe.js';
  import ProgressRing from '$p/components/ProgressRing.svelte';
  import { imgUrl } from '$lib/api.js';
  import { fmtRuntime } from '$lib/format.js';
  import { SET } from '$lib/settings.svelte.js';
  import { P, upNextLeft, playNext, dismissUpNext } from '$lib/player.svelte.js';

  /** @type {{ inline?: boolean }} */
  let { inline = false } = $props();

  const n = $derived(P.next);
  const left = $derived(upNextLeft());
  const total = $derived(P.credits && P.credits.start < P.dur - 2 ? 10 : 20);
  const img = $derived(n ? imgUrl(n, 'Primary', { w: 320 }) || imgUrl(n, 'Thumb', { w: 320 }) : null);
  const counting = $derived(SET.autoplayNext && !P.paused && left > 0);
  /* The ring follows the playhead, not `counting`: a pause freezes it where it
   * is instead of unwinding it (player.css sweeps it linearly over each 1 s
   * tick, PLY-11). */
  const ringP = $derived(SET.autoplayNext ? Math.min(1, Math.max(0, 1 - left / total)) : 0);
  /* Landscape: slides in from the right edge it sits on; portrait (inline in
   * the info column): a fade in, and out at once (its {:else} episode row
   * takes the same slot). |global — the card is mounted by Player's {#if}. */
  /** @param {Element} node */
  function cardIn(node) {
    if (reducedMotion()) return fade(node, { duration: DUR.rm });
    return inline ? fade(node, { duration: DUR.base }) : fly(node, { x: 24, duration: DUR.push, easing: easeSheet });
  }
  const title = $derived(n ? [n.IndexNumber != null ? 'E' + n.IndexNumber : '', n.Name].filter(Boolean).join(' · ') : '');
  const sub = $derived(
    n
      ? [n.SeriesName, n.ParentIndexNumber != null && P.detailItem && P.detailItem.ParentIndexNumber !== n.ParentIndexNumber ? 'Season ' + n.ParentIndexNumber : '', n.RunTimeTicks ? fmtRuntime(n.RunTimeTicks) : '']
          .filter(Boolean)
          .join(' · ')
      : ''
  );
</script>

{#if n}
  <div class="upnext {inline ? 'vr-upnext--inline' : ''}" role="dialog" aria-label="Up next" data-component="UpNextCard" in:cardIn|global out:fade|global={{ duration: inline ? 1 : rmOut(DUR.fast) }}>
    <button class="upnext__thumb" type="button" aria-label="Play {title} now" onclick={() => playNext()}>
      <span class="art">{#if img}<img src={img} alt="" />{/if}</span>
      <span class="upnext__ring">
        <ProgressRing p={ringP} label="">
          <Icon name="play" size="sm" fill style="position: relative; margin-left: 2px" />
        </ProgressRing>
      </span>
    </button>
    <div class="upnext__main">
      <p class="upnext__eyebrow">{counting ? 'Up next in ' + left + ' s' : 'Up next'}</p>
      <p class="upnext__title">{title}</p>
      {#if sub}<p class="upnext__sub">{sub}</p>{/if}
    </div>
    <div class="upnext__actions">
      <button class="btn btn--primary btn--sm btn--grow" type="button" onclick={() => playNext()}><Icon name="play" size="xs" fill /><span>Play now</span></button>
      <button class="btn btn--glass btn--sm" type="button" onclick={dismissUpNext}><span>Watch credits</span></button>
    </div>
  </div>
{/if}
