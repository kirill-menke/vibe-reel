<script>
  /* A Search result as a library tile: the same .tile.v shell as Tile.svelte /
   * PendingTile.svelte — poster, caption under it, top-left badge — so the
   * results grid reads exactly like the Movies/Shows grids. The badge slot that
   * holds the tech badge there says where the title stands here (In library /
   * Added / Failed); a title with downloads in flight wears the same pulsing
   * .dlring a library tile does. OK opens the title's detail screen (see
   * openResult in Search.svelte); adding happens from there. */
  import Icon from './Icon.svelte';
  import { posterThumb } from '../lib/medialib.js';
  import { MON } from '../lib/format.js';
  import { addState, lookupGroup } from '../lib/lookup.svelte.js';
  import { act, tileStatus, ringClass } from '../lib/activity.svelte.js';

  /* `rank`: a chart position (Search's browse categories), shown top-right.
   * `hidden`: laid out of the way by Browse's windowing, still mounted. */
  let { item, eager = false, rank = 0, hidden = false, onopen } = $props();

  const art = $derived(posterThumb(item.poster));

  const state = $derived(addState(item));
  const pend = $derived(lookupGroup(item));
  /* A grab in flight says so in the badge slot, live, instead of "In library":
   * "43%" while downloading, the status word otherwise. */
  const dl = $derived(
    !pend ? '' : act.stale ? '' : pend.status === 'downloading' ? Math.round((pend.progress || 0) * 100) + '%' : pend.status === 'warning' ? 'Problem' : tileStatus(pend)
  );
  /* Library grids are one kind per tab; search mixes both, so the caption names
   * it. A trending result (Home) sits on a one-kind rail of this year's titles,
   * so it shows its IMDb rating and vote count instead — and, for a movie still
   * in cinemas, when it comes out digitally (a line of its own: with the votes
   * it no longer fits beside them). Until then there is nothing to download. */
  const star = $derived(item.rating ? '★ ' + item.rating.toFixed(1) : '');
  const sub = $derived(
    item.rating_votes
      ? star + ' (' + fmtVotes(item.rating_votes) + ')'
      : [item.year, item.type === 'movie' ? 'Movie' : 'Show', star].filter(Boolean).join(' · ')
  );
  const digital = $derived.by(() => {
    const d = item.rating && item.digital_release && new Date(item.digital_release + 'T00:00');
    return d && d > new Date() ? 'Digital ' + d.getDate() + ' ' + MON[d.getMonth()] : '';
  });

  /* 42742 → 42k, 1090000 → 1.1M */
  function fmtVotes(n) {
    if (n >= 999500) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'k';
    return String(n);
  }

  /* a poster that failed to load (404, server gone) shows the placeholder,
   * not an empty box; keyed by URL so a new one gets its own chance */
  let broken = $state('');
</script>

<button class="tile focus v" data-focus="lk-{item.type}-{item.id}" {hidden} onclick={() => onopen(item)}>
  <div class="poster">
    {#if art && broken !== art}
      <!-- posterThumb(): the lookup hands out the CDN's full-size artwork (TMDB
           /original is ~900 KB at 2000×3000); decoding that into a 236px box is
           the stall the D-pad hits. -->
      <img loading={eager ? 'eager' : 'lazy'} decoding="async" src={art} alt="" onerror={() => (broken = art)} />
    {:else}<div class="ph">{item.type === 'tv' ? 'show' : 'movie'}</div>{/if}

    {#if dl}
      <div class="techbadge lk dl"><Icon name="download" inline /> {dl}</div>
    {:else if state === 'added'}
      <div class="techbadge lk"><Icon name="check" inline /> In library</div>
    {:else if state === 'done'}
      <div class="techbadge lk ok"><Icon name="check" inline /> Added</div>
    {:else if state === 'error'}
      <div class="techbadge lk err">Add failed</div>
    {/if}
    {#if rank}<div class="runbadge rank">#{rank}</div>{/if}
    {#if pend}<i class="dlring {ringClass(pend)}"></i>{/if}
    {#if state === 'adding'}
      <div class="mlover"><span class="mlbars"><i></i><i></i><i></i></span>Adding…</div>
    {/if}
  </div>

  <div class="cap">
    <div class="t"><span class="ti">{item.title}</span></div>
    <div class="s">{sub}</div>
    {#if digital}<div class="s">{digital}</div>{/if}
  </div>
</button>
