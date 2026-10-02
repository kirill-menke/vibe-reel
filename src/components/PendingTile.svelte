<script>
  /* A grid tile for a title that is still downloading/importing and therefore
   * has no Jellyfin item yet. Same .tile.v shell as Tile.svelte so it sits in
   * the grid indistinguishably: the poster comes from Sonarr/Radarr via the
   * activity payload (or a placeholder against an older backend), the release
   * resolution wears the same top-left .techbadge a downloaded tile does, the
   * in-flight state is carried entirely by the pulsing .dlring, and OK opens
   * PendingDetail. */
  import { openPending } from '../lib/nav.svelte.js';
  import { posterThumb } from '../lib/medialib.js';
  import { tileStatus, ringClass } from '../lib/activity.svelte.js';

  /* eager: mirrors Tile.svelte — pending tiles lead the grid, so the first
   * rows' posters are fetched immediately instead of one observer tick late. */
  let { group, eager = false } = $props();

  /* Never the raw CDN original: a 2000×3000 JPEG decoded into a 239px box is
   * what used to stall the D-pad the moment it reached a queued tile. */
  const poster = $derived(posterThumb(group.poster));

  /* The status word leads the caption (the ring's pulse/colour alone doesn't
   * say which state it is), then what is coming: "Downloading 43% · 3
   * episodes", "Queued · 2024". Status first, so an ellipsis only ever eats
   * the count. */
  const sub = $derived(
    [
      tileStatus(group),
      group.type === 'tv' ? group.items.length + (group.items.length === 1 ? ' episode' : ' episodes') : group.year || ''
    ]
      .filter(Boolean)
      .join(' · ')
  );

  /* a poster that failed to load (404, server gone) shows the placeholder,
   * not an empty box; keyed by URL so a new one gets its own chance */
  let broken = $state('');
</script>

<button class="tile focus v" data-focus="pend-{group.key}" onclick={() => openPending(group.key)}>
  <div class="poster">
    {#if poster && broken !== poster}
      <img loading={eager ? 'eager' : 'lazy'} decoding="async" src={poster} alt="" onerror={() => (broken = poster)} />
    {:else}<div class="ph">{group.type === 'tv' ? 'show' : 'movie'}</div>{/if}

    {#if group.res}<div class="techbadge">{group.res}</div>{/if}
    <i class="dlring {ringClass(group)}"></i>
  </div>

  <div class="cap">
    <div class="t"><span class="ti">{group.title}</span></div>
    <div class="s dlstat {ringClass(group)}">{sub}</div>
  </div>
</button>
