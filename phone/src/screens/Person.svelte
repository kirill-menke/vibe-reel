<script>
  /* Route `person` {id, name}: a cast member — photo, serif name, facts
   * (born / died / where), bio (clamp + More) and their titles in this
   * library as a poster grid with filter chips (All / Movies / Shows); a tile's
   * sub line is the role. Like the TV's Person screen the filmography is the
   * library's (Jellyfin PersonIds) — there is no backend for a person's
   * titles outside it. The person record only dresses the header; its failure
   * is harmless. */
  import { onDestroy, untrack } from 'svelte';
  import NavBar from '../components/NavBar.svelte';
  import Tile from '../components/Tile.svelte';
  import Grid from '../components/Grid.svelte';
  import Art from '../components/Art.svelte';
  import LoadError from '../components/LoadError.svelte';
  import Overview from '../components/detail/Overview.svelte';
  import { initials } from '../components/detail/detail.js';
  import { api, imgUrl, itemPath, itemsPath } from '$lib/api.js';
  import { fmtDate } from '$lib/format.js';
  import { openItem } from '$lib/nav.svelte.js';
  import { scrollPast } from '../lib/gestures.js';
  import { fadeIn } from '../lib/safe.js';

  let { params = {}, active = false } = $props();
  const id = untrack(() => params.id);

  let person = $state(/** @type {Jf.BaseItemDto | null} */ (null));
  /* the filmography, each title as the poster Tile needs it plus `role` (this
   * person's part in it) — never mutated in place, only replaced */
  /** @type {(Jf.BaseItemDto & { role?: string })[] | null} */
  let items = $state.raw(/** @type {(Jf.BaseItemDto & { role?: string })[] | null} */ (null));
  let kind = $state('');
  let error = $state(null);
  let filter = $state('all');
  let dead = false;
  onDestroy(() => (dead = true));
  /* the filmography replaces six skeleton tiles: it dissolves in (Grid is a
     component, so no use: — the bound element instead; it mounts once) */
  let gridEl = $state(/** @type {HTMLElement | null} */ (null));
  $effect(() => {
    if (gridEl) untrack(() => fadeIn(/** @type {HTMLElement} */ (gridEl)));
  });

  const name = $derived(person?.Name || untrack(() => params.name) || '');
  const photo = $derived(person ? imgUrl(person, 'Primary', { h: 280 }) : null);

  const facts = $derived.by(() => {
    const out = [];
    if (kind) out.push(kind);
    if (person?.PremiereDate) {
      const where = person.ProductionLocations?.[0];
      out.push('Born ' + fmtDate(person.PremiereDate) + (where ? ' in ' + where.split(',')[0] : ''));
    }
    if (person?.EndDate) out.push('Died ' + fmtDate(person.EndDate));
    return out.join(' · ');
  });

  /* Jellyfin has no "this person's role" query: every title comes with its
   * whole People list (often 20–60 names) just to find this one person in
   * it. Read once when the answer lands — the role per title and the
   * person's most frequent credit type (the header's "Actor") — and the lists
   * are dropped instead of sitting in the page's state. */
  /** @param {Jf.BaseItemDto[]} list */
  function digest(list) {
    /** @type {Record<string, number>} */
    const n = {};
    const out = list.map((/** @type {Jf.BaseItemDto & { role?: string }} */ { People, ...it }) => {
      const ps = (People || []).filter((p) => p.Id === id);
      for (const p of ps) n[/** @type {string} */ (p.Type)] = (n[/** @type {string} */ (p.Type)] || 0) + 1;
      it.role = ps.find((p) => p.Role)?.Role || (ps[0] && ps[0].Type !== 'Actor' ? ps[0].Type : '') || '';
      return it;
    });
    const top = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
    return { out, kind: top ? (top[0] === 'GuestStar' ? 'Actor' : top[0]) : '' };
  }

  const nMovies = $derived(items ? items.filter((i) => i.Type === 'Movie').length : 0);
  const nShows = $derived(items ? items.filter((i) => i.Type === 'Series').length : 0);
  const shown = $derived(
    !items ? [] : filter === 'movies' ? items.filter((i) => i.Type === 'Movie') : filter === 'shows' ? items.filter((i) => i.Type === 'Series') : items
  );

  function load() {
    /** @type {Promise<Jf.BaseItemDto>} */ (api(itemPath(id)))
      .then((p) => !dead && (person = p))
      .catch(() => {});
    return /** @type {Promise<Jf.QueryResult>} */ (api(
      itemsPath({
        PersonIds: id,
        Recursive: true,
        IncludeItemTypes: 'Movie,Series',
        SortBy: 'ProductionYear,PremiereDate,SortName',
        SortOrder: 'Descending',
        /* People for the role (digest); the Tile's Name/ImageTags/UserData/
         * ProductionYear come without asking. GRID_FIELDS' MediaSources
         * (~5 KB a title) fed a badge the phone's Tile doesn't draw. */
        Fields: 'People',
        Limit: 200
      })
    ))
      .then((r) => {
        if (dead) return;
        const d = digest(r.Items || []);
        kind = d.kind;
        items = d.out;
        error = null;
      })
      .catch((e) => !dead && (error = e));
  }
  load();

  let solid = $state(false);
</script>

<main class="screen" use:scrollPast={{ y: 200, onchange: (s) => (solid = s) }}>
  <div class="person__head">
    <div class="person__photo"><span class="cast__initials">{initials(name)}</span><Art src={photo} eager /></div>
    <h1 class="person__name">{name}</h1>
    {#if facts}<p class="person__facts">{facts}</p>{/if}
  </div>
  {#if person?.Overview}
    <div class="person__bio"><Overview text={person.Overview} /></div>
  {/if}

  {#if error && !items}
    <LoadError card title="Couldn’t load {name ? name + '’s' : 'these'} titles" {error} retry={load} class="person__err" />
  {:else}
    <section class="section">
      <div class="section__head">
        <div>
          <h2 class="section__title">Filmography</h2>
          {#if items}<p class="section__sub">{items.length}{items.length === 1 ? ' title' : ' titles'} in your library</p>{/if}
        </div>
      </div>
      {#if items && nMovies && nShows}
        <div class="chips person__chips" role="tablist" aria-label="Filter">
          {#each [['all', 'All'], ['movies', 'Movies'], ['shows', 'Shows']] as [k, l] (k)}
            <button type="button" class="chip {filter === k ? 'chip--on' : ''}" role="tab" aria-selected={filter === k} onclick={() => (filter = k)}>{l}</button>
          {/each}
        </div>
      {/if}
      {#if !items}
        <Grid>{#each [0, 1, 2, 3, 4, 5] as i (i)}<Tile skeleton />{/each}</Grid>
      {:else if !items.length}
        <p class="person__empty">Nothing else with {name} in your library.</p>
      {:else}
        <Grid bind:el={gridEl}>
          {#each shown as it (it.Id)}
            <Tile item={it} sub={it.role || undefined} onclick={() => openItem(it.Id, it.Type)} />
          {/each}
        </Grid>
      {/if}
    </section>
  {/if}
</main>
<NavBar title={name} {solid} />
