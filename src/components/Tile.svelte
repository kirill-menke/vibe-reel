<script>
  import { onDestroy } from 'svelte';
  import { imgUrl, prefetch, seasonsPath, itemPath } from '../lib/api.js';
  import { fmtRuntime, timeLeft, yearOf } from '../lib/format.js';
  import { tileTechBadge } from '../lib/tracks.js';
  import { openItem } from '../lib/nav.svelte.js';
  import { tileStatus, ringClass } from '../lib/activity.svelte.js';
  import Icon from './Icon.svelte';

  /* kind: 'cw' (continue watching) | 'nextup' | 'added' (also used for grids)
   * eager: this tile is above the fold, so don't defer its poster. Chrome 120
   *   on this TV applies an effectively ZERO lazy-load margin (measured: in a
   *   1920-wide .strip exactly the 8 tiles intersecting the viewport load, the
   *   9th does not), so `loading="lazy"` never over-fetches here — it only
   *   risks starting the visible posters one observer tick late. */
  /* pend: the activity group for this title when new episodes (or a better
   *   file) are still downloading — pulses the poster's gold ring. Only the
   *   library grids pass it; rails leave it null. */
  /* onplay / onremove: Home's Continue Watching and Next Up — OK plays the item
   *   instead of opening its page, and hold OK (data-hold → okhold) removes it
   *   from the rail. Everywhere else OK opens the detail page. */
  let { item, kind = 'added', eager = false, pend = null, onplay = null, onremove = null } = $props();

  /* Opening a tile costs a fresh /Items/{id}?userId= (measured ~85 ms) plus
   * a 1920-wide backdrop (~275 KB, ~110 ms cold) before the detail page paints.
   * Both are derivable from the tile itself, so warm them once the D-pad has
   * settled here — the dwell timer is what stops remote auto-repeat from firing
   * a request per tile as the user sweeps along a row. */
  const DWELL = 350;
  let dwell = null;

  function warm() {
    prefetch(itemPath(item.Id));
    if (item.Type === 'Series') prefetch(seasonsPath(item.Id)); // SeriesDetail's next hop
    const bg = imgUrl(item, 'Backdrop', { w: 1920 }) || imgUrl(item, 'Primary', { h: 1080 });
    if (bg) new Image().src = bg; // straight into the HTTP cache (max-age=1y)
  }

  function onFocus() {
    clearTimeout(dwell);
    dwell = setTimeout(warm, DWELL);
  }

  function onBlur() {
    clearTimeout(dwell);
    dwell = null;
  }

  /* Pressing OK destroys this screen; a dwell that fires afterwards would just
   * duplicate the fetch Detail is already making. */
  onDestroy(() => clearTimeout(dwell));

  const isEp = $derived(item.Type === 'Episode');
  const ud = $derived(item.UserData || {});
  const pct = $derived(ud.PlayedPercentage ? Math.min(100, ud.PlayedPercentage) : 0);
  /* Next Up is a wide rail: an episode's still says which episode it is, and
   * cropping it into a portrait poster used to cut it to a sliver. Continue
   * Watching stays portrait, so an episode there wears its *series* poster —
   * the episode is named in the caption instead. */
  const landscape = kind === 'nextup';
  const img = $derived(
    kind === 'nextup'
      ? imgUrl(item, 'Primary', { w: 440 }) || imgUrl(item, 'Thumb', { w: 440 }) || imgUrl(item, 'Backdrop', { w: 440 })
      : kind === 'cw' && isEp && item.SeriesPrimaryImageTag
      ? imgUrl({ SeriesId: item.SeriesId, SeriesPrimaryImageTag: item.SeriesPrimaryImageTag }, 'Primary', { h: 420 })
      : imgUrl(item, 'Primary', { h: 420 }) || imgUrl(item, 'Backdrop', { h: 420 })
  );
  /* Library tiles: a resume bar on a half-watched movie, the unwatched-episode
   * count on a series, a tick on anything fully watched. */
  const unplayed = $derived(item.Type === 'Series' ? ud.UnplayedItemCount || 0 : 0);
  const watched = $derived(!!ud.Played && !unplayed);
  /* "S2:E5" — only when the item actually carries the numbers, so a stray
   * episode without them doesn't caption itself "S0:E0". */
  const epNum = $derived(
    isEp && (item.ParentIndexNumber != null || item.IndexNumber != null)
      ? 'S' + (item.ParentIndexNumber ?? 0) + ':E' + (item.IndexNumber ?? 0)
      : ''
  );
  const techBadge = $derived(kind === 'added' ? tileTechBadge(item) : '');

  function seriesSub(it) {
    const n = it.ChildCount || it.SeasonCount;
    return n ? n + (n === 1 ? ' season' : ' seasons') : yearOf(it) || '';
  }

  /* a poster that failed to load (404, server gone) shows the placeholder,
   * not an empty box; keyed by URL so a new one gets its own chance */
  let broken = $state('');
</script>

<button
  class="tile focus {landscape ? 'w' : 'v'}"
  data-focus="tile-{item.Id}"
  onfocus={onFocus}
  onblur={onBlur}
  onclick={() => (onplay ? onplay(item) : openItem(item.Id, item.Type))}
  data-hold={onremove ? '' : undefined}
  onokhold={onremove ? () => onremove(item) : undefined}
>
  <div class="poster">
    {#if img && broken !== img}
      <img loading={eager ? 'eager' : 'lazy'} decoding="async" src={img} alt="" onerror={() => (broken = img)} />
    {:else}<div class="ph">poster</div>{/if}

    {#if kind === 'cw'}
      {#if pct}<div class="progress"><i style="width:{pct}%"></i></div>{/if}
    {:else if kind === 'nextup'}
      {#if fmtRuntime(item.RunTimeTicks)}<div class="runbadge">{fmtRuntime(item.RunTimeTicks)}</div>{/if}
    {:else}
      {#if techBadge}<div class="techbadge">{techBadge}</div>{/if}
      {#if unplayed}
        <div class="cntbadge">{unplayed > 99 ? '99+' : unplayed}</div>
      {:else if watched}
        <div class="watched-dot"><Icon name="check" inline /></div>
      {/if}
      {#if pct && !watched}<div class="progress"><i style="width:{pct}%"></i></div>{/if}
      {#if pend}<i class="dlring {ringClass(pend)}"></i>{/if}
    {/if}
  </div>

  <!-- The caption sits under the artwork on every tile: painted on the poster
       it fought the poster's own title art. -->
  <div class="cap">
    {#if kind === 'cw'}
      <div class="t"><span class="ti">{isEp ? item.SeriesName || item.Name : item.Name}</span></div>
      <div class="s">{(isEp ? [epNum, item.Name] : [timeLeft(item)]).filter(Boolean).join(' · ')}</div>
    {:else if kind === 'nextup'}
      <div class="t"><span class="ti">{item.SeriesName || item.Name}</span></div>
      <div class="s">{[epNum, item.Name].filter(Boolean).join(' · ')}</div>
    {:else}
      <div class="t"><span class="ti">{item.Name}</span></div>
      <!-- with a download in flight the status word leads the line — the ring's
           pulse/colour alone doesn't say which state it is -->
      <div class="s {pend ? 'dlstat ' + ringClass(pend) : ''}">{[pend ? tileStatus(pend) : '', item.Type === 'Series' ? seriesSub(item) : yearOf(item)].filter(Boolean).join(' · ')}</div>
    {/if}
  </div>
</button>
