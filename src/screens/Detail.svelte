<script>
  import { onMount } from 'svelte';
  import MovieDetail from './MovieDetail.svelte';
  import SeriesDetail from './SeriesDetail.svelte';
  import Loading from '../components/Loading.svelte';
  import LoadError from '../components/LoadError.svelte';
  import { api, prefetch, seasonsPath, itemPath } from '../lib/api.js';
  import { S } from '../lib/nav.svelte.js';

  let item = $state(null);
  /* A failed fetch used to leave the spinner up for good, with nothing to
     focus. Now it says why and offers Retry / Back. */
  let error = $state(null);

  /* Returns the promise so LoadError's Retry reads "Retrying…" while it runs;
     `error` is only cleared on success, so a retry keeps the card (and focus on
     detail-err-retry) up instead of swapping it for the full-screen spinner. */
  function load() {
    // a series' seasons in parallel with the item (SeriesDetail consumes it)
    if (S.detailType === 'Series') prefetch(seasonsPath(S.detailId)).catch(() => {});
    return api(itemPath(S.detailId))
      .then((i) => {
        item = i;
        error = null;
      })
      .catch((e) => (error = e));
  }

  onMount(load);
</script>

{#if error}
  <div class="screen"><div class="page"><LoadError {error} retry={load} fkey="detail-err" /></div></div>
{:else if !item}
  <div class="screen"><div class="page"><Loading /></div></div>
{:else if item.Type === 'Series'}
  <SeriesDetail series={item} />
{:else}
  <MovieDetail {item} />
{/if}
