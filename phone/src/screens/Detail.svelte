<script>
  /* Route `detail` {id, type}: loads the Jellyfin item and dispatches like the
   * TV's Detail.svelte — Series → SeriesDetail, anything else (Movie,
   * Episode, …) → MovieDetail. Loading skeleton, LoadError with Retry.
   *
   * Every route stays mounted under the ones pushed over it, so play state is
   * refreshed from here: after the player modal closes (R.playerClosed) the
   * item is re-read — at once if this page is the one showing, else the next
   * time it becomes the visible page. A failed refresh keeps the page as is. */
  import { onDestroy, untrack } from 'svelte';
  import MovieDetail from './MovieDetail.svelte';
  import SeriesDetail from './SeriesDetail.svelte';
  import DetailSkeleton from '../components/detail/DetailSkeleton.svelte';
  import LoadError from '../components/LoadError.svelte';
  import NavBar from '../components/NavBar.svelte';
  import { api, prefetch, seasonsPath, nextUpPath, itemPath } from '$lib/api.js';
  import { R } from '../lib/router.svelte.js';

  let { params = {}, active = false } = $props();

  let item = $state(/** @type {Jf.BaseItemDto | null} */ (null));
  let error = $state(null);
  /* bumped on every (re)load that should also refresh the child's own lists */
  let refresh = $state(0);
  /* DET-03: an item that lands after the skeleton has been up a while
   * dissolves in instead of popping (lateIn in detail.js) */
  const mountedAt = performance.now();
  let late = $state(false);
  let dead = false;
  let gen = 0;
  onDestroy(() => {
    dead = true;
    gen++;
  });

  /* Returns its promise for LoadError; `error` is cleared only on success. */
  function load() {
    const id = params.id;
    const g = ++gen;
    /* a series' page also needs its seasons and its next-up episode (the
     * Play button): asked for alongside the item instead of after it */
    if (params.type === 'Series') {
      prefetch(seasonsPath(id)).catch(() => {});
      prefetch(nextUpPath(id)).catch(() => {});
    }
    return /** @type {Promise<Jf.BaseItemDto>} */ (api(itemPath(id)))
      .then((i) => {
        if (dead || g !== gen) return;
        if (!item && performance.now() - mountedAt > 250) late = true;
        item = i;
        error = null;
      })
      .catch((e) => {
        if (dead || g !== gen) return;
        if (!item) error = e;
      });
  }
  untrack(load);

  /* play state after the player closes */
  let stale = false;
  let seenClosed = untrack(() => R.playerClosed);
  $effect(() => {
    const n = R.playerClosed;
    if (n === seenClosed) return;
    seenClosed = n;
    stale = true;
    untrack(() => active && revalidate());
  });
  $effect(() => {
    if (active && stale) untrack(revalidate);
  });
  function revalidate() {
    stale = false;
    if (!item) return;
    load().then(() => refresh++);
  }
</script>

{#if error && !item}
  <main class="screen"><LoadError {error} retry={load} /></main>
  <NavBar />
{:else if !item}
  <DetailSkeleton />
  <NavBar />
{:else if item.Type === 'Series'}
  <SeriesDetail series={item} {refresh} {active} {late} />
{:else}
  <MovieDetail {item} {late} />
{/if}
