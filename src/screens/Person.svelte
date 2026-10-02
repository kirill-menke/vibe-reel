<script>
  /* A cast member's titles in this library — opened with OK on a Cast rail
   * entry (MovieDetail). An ordinary 7-across .grid of library tiles; OK on
   * one opens its detail, and Back (the nav.svelte.js trail) returns here on
   * that tile, then to the detail page on the cast member. */
  import { onMount } from 'svelte';
  import Tile from '../components/Tile.svelte';
  import Loading from '../components/Loading.svelte';
  import LoadError from '../components/LoadError.svelte';
  import { api, imgUrl, GRID_FIELDS, itemPath, itemsPath } from '../lib/api.js';
  import { S, takeDetailFocus, onBack } from '../lib/nav.svelte.js';
  import { focusKey, focusFirst } from '../lib/focus.js';

  let items = $state(null);
  let person = $state(null);
  let error = $state(null);
  const back = takeDetailFocus();

  const name = $derived(person?.Name || S.personName || '');
  const photo = $derived(person ? imgUrl(person, 'Primary', { h: 280 }) : null);
  const sub = $derived(
    items
      ? [items.length + (items.length === 1 ? ' title' : ' titles') + ' in your library', person?.ProductionLocations?.[0] || '']
          .filter(Boolean)
          .join(' · ')
      : ''
  );

  async function load() {
    // a retry keeps the LoadError card up ("Retrying…", focus on
    // person-err-retry) until it succeeds — no flash to the spinner
    // the person's own record is only for the photo — its failure is harmless
    api(itemPath(S.personId))
      .then((p) => (person = p))
      .catch(() => {});
    try {
      const r = await api(
        itemsPath({
          PersonIds: S.personId,
          Recursive: true,
          IncludeItemTypes: 'Movie,Series',
          SortBy: 'ProductionYear,PremiereDate,SortName',
          SortOrder: 'Descending',
          Fields: GRID_FIELDS,
          Limit: 200
        })
      );
      items = r.Items || [];
      error = null;
    } catch (e) {
      error = e;
      return;
    }
    if (!(back && (await focusKey(back)))) await focusFirst();
  }

  onMount(load);
</script>

<div class="screen">
  <div class="page">
    <div class="personhead">
      <div class="head">{#if photo}<img src={photo} alt="" />{/if}</div>
      <div>
        <div class="title">{name}</div>
        {#if sub}<div class="sub">{sub}</div>{/if}
      </div>
    </div>
    {#if error}
      <LoadError title="Couldn’t load {name ? name + '’s' : 'these'} titles" {error} retry={load} fkey="person-err" />
    {:else if !items}
      <Loading />
    {:else if !items.length}
      <!-- a guest star has no film or series of their own here: say so, and give
           focus somewhere to be (focusFirst lands on Back) instead of nowhere -->
      <div class="loading" style="padding:40px 64px 28px">Nothing else with {name} in your library.</div>
      <div style="padding:0 64px">
        <button class="btn ghost big focus" data-focus="person-back" onclick={onBack}>Back</button>
      </div>
    {:else}
      <div class="grid-wrap person">
        <div class="grid">
          {#each items as it (it.Id)}
            <Tile item={it} kind="added" />
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>
