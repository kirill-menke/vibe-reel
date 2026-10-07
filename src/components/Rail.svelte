<script>
  import Tile from './Tile.svelte';

  /** @type {{ title: string, items: Jf.BaseItemDto[], kind?: VR.TileKind, onplay?: ((item: Jf.BaseItemDto) => void) | null, onremove?: ((item: Jf.BaseItemDto) => void) | null }} */
  let { title, items, kind = 'added', onplay = null, onremove = null } = $props();
</script>

<div class="rail">
  <h2>{title}</h2>
  <div class="strip">
    {#each items as item (item.Id)}
      <Tile {item} {kind} {onplay} {onremove} />
    {/each}
  </div>
</div>
