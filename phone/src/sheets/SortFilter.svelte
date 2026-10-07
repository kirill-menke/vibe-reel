<script>
  /* Sort & filter for the Movies / Shows grid (design 03-library--sort.html).
   * Edits a draft; only "Show N" applies it (setView → Library re-queries in
   * place). Swiping the sheet down, the scrim or Close apply nothing.
   * params: { tab: 'movies'|'shows', focus?: 'genre' (scroll the genre group
   * into view — the Genre chip opened it) }. */
  import { onDestroy, tick, untrack } from 'svelte';
  import Sheet from '../components/Sheet.svelte';
  import Switch from '../components/Switch.svelte';
  import Segmented from '../components/Segmented.svelte';
  import Icon from '../components/Icon.svelte';
  import Skeleton from '../components/Skeleton.svelte';
  import { api, cached, revalidate } from '$lib/api.js';
  import { SORTS, viewOf, setView } from '$lib/libview.svelte.js';
  import { closeSheet } from '../lib/router.svelte.js';
  import { fadeIn } from '../lib/safe.js';
  import { countPath, genresPath, genreList, orderLabels } from '../screens/Library.svelte';

  let { params = {} } = $props();

  const tab = untrack(() => (params.tab === 'shows' ? 'shows' : 'movies'));
  const noun = tab === 'shows' ? ['show', 'shows'] : ['movie', 'movies'];
  const sorts = SORTS[tab] || SORTS.movies;
  const cur = untrack(() => viewOf(tab));

  let sort = $state(cur.sort || 'added');
  let rev = $state(!!cur.rev);
  let unwatched = $state(!!cur.unwatched);
  let picked = $state(genreList(cur));

  /* ---- genres (the Library screen warmed this path) ---- */
  const gp = genresPath(tab);
  /** @type {Jf.QueryResult | null} */
  const gh = cached(gp);
  // a genre's Name is always set (Jf types it nullable)
  let allGenres = $state(gh ? /** @type {string[]} */ ((gh.Items || []).map((/** @type {Jf.BaseItemDto} */ x) => x.Name)) : null);
  const genreSkel = !gh; // skeleton pills first: the real chips dissolve in over them
  let dead = false;
  /** @type {Promise<Jf.QueryResult>} */ (revalidate(gp))
    .then((r) => !dead && (allGenres = /** @type {string[]} */ ((r.Items || []).map((/** @type {Jf.BaseItemDto} */ x) => x.Name))))
    .catch(/** @returns {unknown} */ () => !dead && !allGenres && (allGenres = []));

  /* a genre that's selected but no longer listed stays visible (and removable) */
  const genreChips = $derived([...new Set([...(allGenres || []), ...picked])]);

  /** @param {string} g */
  function toggleGenre(g) {
    picked = picked.includes(g) ? picked.filter((/** @type {string} */ x) => x !== g) : [...picked, g];
  }

  const labels = $derived(orderLabels(sort));
  const orderValue = $derived(rev ? 'rev' : 'fwd');

  /* ---- "Show N": a Limit=0 count of the draft, debounced, newest wins ---- */
  const draft = $derived({ sort, rev, unwatched, genre: picked.join('|') });
  let count = $state(/** @type {number | null} */ (null));
  let counting = $state(false);
  let seq = 0;
  let timer = 0;
  $effect(() => {
    const d = { unwatched: draft.unwatched, genre: draft.genre }; // sort doesn't change N
    clearTimeout(timer);
    const mine = ++seq;
    counting = true;
    timer = setTimeout(async () => {
      try {
        /** @type {Jf.QueryResult} */
        const r = await api(countPath(tab, d));
        if (mine !== seq || dead) return;
        count = r.TotalRecordCount ?? 0;
      } catch {
        if (mine === seq && !dead) count = null;
      } finally {
        if (mine === seq && !dead) counting = false;
      }
    }, count === null ? 0 : 200);
  });

  const showLabel = $derived(
    count === null ? 'Show ' + noun[1] : 'Show ' + count + ' ' + noun[count === 1 ? 0 : 1]
  );

  function apply() {
    setView(tab, { sort, rev, unwatched, genre: picked.join('|') });
    closeSheet();
  }

  function reset() {
    sort = sorts[0].id;
    rev = false;
    unwatched = false;
    picked = [];
  }

  const isDefault = $derived(sort === sorts[0].id && !rev && !unwatched && !picked.length);

  let bodyEl = $state(/** @type {HTMLElement | null} */ (null));
  let genreEl = $state(/** @type {HTMLDivElement | null} */ (null));
  if (untrack(() => params.focus) === 'genre') {
    tick().then(() => {
      if (bodyEl && genreEl) bodyEl.scrollTop = Math.max(0, genreEl.offsetTop - 12);
    });
  }

  onDestroy(() => {
    dead = true;
    clearTimeout(timer);
  });
</script>

<Sheet title="Sort & filter" large bind:bodyEl>
  {#snippet headAction()}
    <button class="btn btn--text" type="button" disabled={isDefault} onclick={reset}><span>Reset</span></button>
  {/snippet}

  <p class="group__label">Sort by</p>
  <div class="list" role="radiogroup" aria-label="Sort by">
    {#each sorts as s (s.id)}
      <button
        class="row {sort === s.id ? 'row--selected' : ''}"
        type="button"
        role="radio"
        aria-checked={sort === s.id}
        onclick={() => {
          if (sort !== s.id) rev = false;
          sort = s.id;
        }}
      >
        <span class="row__main"><span class="row__title">{s.label}</span></span>
        {#if sort === s.id}<Icon name="check" size="sm" class="row__check" />{/if}
      </button>
    {/each}
  </div>

  <div class="group">
    <p class="group__label">Order</p>
    <div class="sf__seg">
      <Segmented
        label="Order"
        options={[{ value: 'fwd', label: labels[0] }, { value: 'rev', label: labels[1] }]}
        value={orderValue}
        onchange={(v) => (rev = v === 'rev')}
      />
    </div>
  </div>

  <div class="group">
    <p class="group__label">Filter</p>
    <div class="list">
      <div class="row">
        <span class="row__main"><span class="row__title">Unwatched only</span></span>
        <Switch bind:on={unwatched} label="Unwatched only" />
      </div>
    </div>
  </div>

  <div class="group" bind:this={genreEl}>
    <p class="group__label">Genre</p>
    {#if allGenres === null}
      <div class="chips chips--wrap" aria-hidden="true">
        {#each [64, 80, 56, 72, 90, 60] as w, i (i)}<Skeleton kind="pill" w="{w}px" />{/each}
      </div>
    {:else if !genreChips.length}
      <p class="group__foot">No genres in this library yet.</p>
    {:else}
      <div class="chips chips--wrap" use:fadeIn={genreSkel}>
        <button type="button" class="chip {picked.length ? '' : 'chip--on'}" aria-pressed={!picked.length} onclick={() => (picked = [])}>All</button>
        {#each genreChips as g (g)}
          <button type="button" class="chip {picked.includes(g) ? 'chip--on' : ''}" aria-pressed={picked.includes(g)} onclick={() => toggleGenre(g)}>{g}</button>
        {/each}
      </div>
      {#if picked.length > 1}<p class="group__foot">Titles in any of the picked genres.</p>{/if}
    {/if}
  </div>

  {#snippet foot()}
    <button class="btn btn--primary btn--block" type="button" onclick={apply} aria-busy={counting}>
      <span>{showLabel}</span>
    </button>
  {/snippet}
</Sheet>
