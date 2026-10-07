<script>
  /* EpisodeRow — `.episode`: 16:9 still + "E4 · 50 min" + title + status, the
   * overview (2 lines) spanning the row below.
   *   img, num, title, overview
   *   progress   0–1 watch progress (bar on the still) → status "31 min left"
   *   status     status line text (gold)
   *   watched    tick in the still's corner
   *   dl         { status: 'downloading'|'queued', p } — dimmed, ring / clock,
   *              not tappable (aria-disabled)
   *   onclick, onlongpress(detail)
   *   class      extra classes on .episode (e.g. is-cancelling) */
  import Art from '../Art.svelte';
  import Icon from '../Icon.svelte';
  import ProgressBar from '../ProgressBar.svelte';
  import ProgressRing from '../ProgressRing.svelte';
  import { longpress } from '../../lib/gestures.js';

  /** @type {{ img?: string | null, num?: string, title?: string, overview?: string, progress?: number, status?: string, watched?: boolean, dl?: VR.TileDownload | null, onclick?: (() => unknown) | null, onlongpress?: ((d: VR.LongPressDetail) => unknown) | null, preview?: boolean, class?: string }} */
  let {
    img = null,
    num = '',
    title = '',
    overview = '',
    progress = 0,
    status = '',
    watched = false,
    dl = null,
    onclick = null,
    onlongpress = null,
    preview = false,
    class: cls = ''
  } = $props();

  const state = $derived(dl ? (dl.status === 'downloading' ? 'downloading' : 'queued') : watched ? 'watched' : '');
  const inert = $derived(!!dl || !onclick);
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="episode {state ? 'episode--' + state : ''} {preview ? 'episode--preview' : ''} {cls}"
  role={preview ? undefined : 'button'}
  tabindex={preview || inert ? undefined : 0}
  aria-disabled={dl ? 'true' : undefined}
  onclick={() => !inert && onclick?.()}
  onkeydown={(e) => !inert && (e.key === 'Enter' || e.key === ' ') && onclick?.()}
  use:longpress={{ onlongpress, disabled: !onlongpress }}
>
  <div class="episode__still">
    <Art src={img} />
    {#if dl}
      <div class="episode__ringwrap">
        {#if dl.status === 'downloading'}<ProgressRing p={dl.p || 0} glass />{:else}<span class="tile__queued"><Icon name="clock" size="sm" /></span>{/if}
      </div>
    {:else if watched}
      <span class="tile__corner tick" aria-label="Watched"><Icon name="check" /></span>
    {:else if progress > 0}
      <ProgressBar p={progress} class="tile__progress" />
    {/if}
  </div>
  <div class="episode__head">
    {#if num}<p class="episode__num">{num}</p>{/if}
    <p class="episode__title">{title}</p>
    {#if status}<p class="episode__status">{status}</p>{/if}
  </div>
  {#if overview && !preview}<p class="episode__overview">{overview}</p>{/if}
</div>
