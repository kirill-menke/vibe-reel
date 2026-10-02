<script>
  /* DetailSkeleton — the title page while its item loads (04-movie-detail--loading).
   * The hero block shows at once (static); the text/action placeholders only
   * fade in after ~250 ms (.detail__skel-late), so a fast load never flashes
   * grey bars (DET-03). */
  import DetailHero from './DetailHero.svelte';
  import Skeleton from '../Skeleton.svelte';
</script>

<main class="screen" aria-busy="true">
  <DetailHero skeleton />
  <div class="detail__body detail__skel-late">
    <div class="detail__head">
      <Skeleton kind="line-lg" w="240px" h="34px" />
      <Skeleton kind="line" w="200px" />
      <Skeleton kind="line" w="140px" />
    </div>
    <Skeleton kind="pill" />
    <div class="actions">
      {#each [0, 1, 2] as i (i)}
        <div class="detail__skelaction"><Skeleton kind="circle" w="44px" h="44px" /><Skeleton kind="line" w="44px" h="8px" /></div>
      {/each}
    </div>
    <div class="skel-stack">
      <Skeleton kind="line" w="100%" />
      <Skeleton kind="line" w="94%" />
      <Skeleton kind="line" w="62%" />
    </div>
  </div>
</main>
