<script>
  /* CollectionRail — "<Franchise> Collection · 5 films · 2 in your library": the
   * whole TMDB franchise from reel-api /api/collection (the TV's
   * CollectionRail logic). Films you can add carry only the quick-add "+"
   * (mlLibraryAdd via addToLibrary — toast with Undo), no "Not in library"
   * badge; one in flight shows its download ring; the current film gets a gold "This film"
   * badge and isn't tappable. A tap opens the richest page there is
   * (lookupOpener: Jellyfin detail / pending / lookup).
   *   id     TMDB collection id
   *   self   tmdb id of the film whose page this is
   *   owned  whether that film is in the library */
  import Rail from '../Rail.svelte';
  import Tile from '../Tile.svelte';
  import { mlCollection, posterThumb } from '$lib/medialib.js';
  import { seedAdds, lookupOpener, inLibrary, addState, addToLibrary, lookupGroup } from '$lib/lookup.svelte.js';

  /** @type {{ id: string, self?: string | number, owned?: boolean }} */
  let { id, self = '', owned = false } = $props();

  /** @type {Reel.CollectionResponse | null} */
  let coll = $state(/** @type {Reel.CollectionResponse | null} */ (null));
  const movies = $derived(coll ? coll.movies || [] : []);
  const isSelf = (/** @type {Reel.CollectionMovie} */ m) => self && m.id === String(self);
  const sub = $derived.by(() => {
    if (!coll) return '';
    const n = movies.length;
    const have = movies.filter((m) => (isSelf(m) ? owned : inLibrary(m))).length;
    return n + (n === 1 ? ' film' : ' films') + (have ? ' · ' + have + ' in your library' : '');
  });

  $effect(() => {
    const cid = id;
    let gone = false;
    mlCollection(cid)
      .then((c) => {
        if (gone) return;
        seedAdds(c.movies || []);
        coll = c;
      })
      .catch(() => {});
    return () => (gone = true);
  });

  let opening = false;
  /** @param {Reel.CollectionMovie} m */
  async function open(m) {
    if (opening || isSelf(m)) return;
    opening = true;
    try {
      (await lookupOpener(m))();
    } finally {
      opening = false;
    }
  }

  /** @param {Reel.CollectionMovie} m */
  function dl(m) {
    const g = lookupGroup(m);
    if (!g) return null;
    return { status: g.status === 'downloading' ? 'downloading' : 'queued', p: g.progress || 0 };
  }
</script>

{#if movies.length > 1}
  <Rail label={(/** @type {Reel.CollectionResponse} */ (coll)).title} class="rail--coll">
    {#snippet head()}
      <div><h2 class="rail__title">{/** @type {Reel.CollectionResponse} */ (coll).title}</h2><p class="section__sub">{sub}</p></div>
    {/snippet}
    {#each movies as m (m.id)}
      {@const st = addState(m)}
      {@const d = isSelf(m) ? null : dl(m)}
      <Tile
        title={m.title}
        sub={m.year ? String(m.year) : ''}
        img={posterThumb(m.poster)}
        badge={isSelf(m) ? { text: 'This film', kind: 'gold' } : null}
        download={d}
        addState={isSelf(m) || d ? null : st}
        onadd={!isSelf(m) && !d && (st === 'idle' || st === 'error') ? () => addToLibrary(m) : null}
        onclick={() => open(m)}
        class={isSelf(m) ? 'tile--self' : ''}
      />
    {/each}
  </Rail>
{/if}
