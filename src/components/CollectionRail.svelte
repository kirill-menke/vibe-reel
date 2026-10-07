<script>
  /* "Part of the <Franchise> Collection": the other films of a movie's TMDB
   * collection, in release order, as lookup tiles — so a sequel you don't have
   * yet opens LookupDetail with Add to library, one that is downloading opens
   * its PendingDetail, and one already in Jellyfin its real detail page
   * (lookupOpener, exactly like Search and Home's trending rails). The list
   * comes from reel-api /api/collection (Radarr's metadata service), which
   * knows the whole franchise whatever the library holds. Jellyfin's own
   * BoxSets aren't used: none exist on this server, and they only ever group
   * titles already in the library.
   *
   * `id` is the TMDB collection id (ProviderIds.TmdbCollection on a Jellyfin
   * movie, metadata's `collection.id` on a lookup), `self` the tmdb id of the
   * film whose page this is — left out, the page already is that film — and
   * `owned` whether that film is in the library (it still counts in the rail's
   * "N in your library").
   * `onready` fires once the answer is in (or failed), so a Back onto one of
   * these tiles can wait for them. Nothing renders for a collection that is
   * just this film, or when the service is down. */
  import LookupTile from './LookupTile.svelte';
  import { mlCollection } from '../lib/medialib.js';
  import { seedAdds, lookupOpener, inLibrary } from '../lib/lookup.svelte.js';

  /** @type {{ id: string, self?: string, owned?: boolean, onready?: (() => void) | null }} */
  let { id, self = '', owned = false, onready = null } = $props();

  /** @type {Reel.CollectionResponse | null} */
  let coll = $state(/** @type {Reel.CollectionResponse | null} */ (null));
  const movies = $derived(coll ? coll.movies.filter((m) => m.id !== String(self)) : []);
  /* "4 films · 2 in your library", counting this one */
  const sub = $derived.by(() => {
    if (!coll) return '';
    const n = coll.movies.length;
    const have = coll.movies.filter((m) => (m.id === String(self) ? owned : inLibrary(m))).length;
    return n + ' films' + (have ? ' · ' + have + ' in your library' : '');
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
      .catch(() => {})
      .finally(() => !gone && onready && onready());
    return () => (gone = true);
  });

  let opening = false;
  /** @param {Reel.LookupResult} item */
  async function open(item) {
    if (opening) return;
    opening = true;
    try {
      (await lookupOpener(item))();
    } finally {
      opening = false;
    }
  }
</script>

{#if movies.length}
  <div class="rail coll">
    <h2>{/** @type {Reel.CollectionResponse} */ (coll).title}<span class="railsub">{sub}</span></h2>
    <div class="strip">
      {#each movies as item (item.id)}
        <LookupTile {item} onopen={open} />
      {/each}
    </div>
  </div>
{/if}
