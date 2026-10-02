<script>
  /* The opening beat of the startup animation (five gold bars breathing),
   * reused as the app-wide "waiting on data" indicator — same geometry and
   * rhythm as Splash.svelte's first 1.1s, but driven by a CSS animation on
   * transform/opacity so it stays on the compositor (Splash can afford a rAF
   * loop because nothing else is on screen; a browse screen can't).
   *
   * Default is fixed + centred on the 1920×1080 frame. `inline` drops it into
   * the flow for sub-sections (e.g. the episode list while a season loads),
   * where a screen-centred overlay would float over visible content. */

  import { onMount } from 'svelte';

  /* `delay` suppresses the flash. A browse-screen fetch against this Jellyfin
   * takes ~80-300 ms, and an indicator that appears and vanishes inside a
   * couple of hundred milliseconds reads as a stutter, not as progress — worse
   * than showing nothing. Wait out the short cases and only announce a wait
   * that is actually going to be one. Pass delay={0} to show immediately. */
  let { inline = false, delay = 180 } = $props();

  let show = $state(false);

  onMount(() => {
    if (delay <= 0) {
      show = true;
      return;
    }
    const t = setTimeout(() => (show = true), delay);
    return () => clearTimeout(t);
  });

  // Splash: period 1/1.15s, bars offset by 1.7rad → 0.235s apart; heights
  // sweep 48…108px, i.e. scaleY 0.444…1 (see .vload in style.css).
  const STAGGER = 0.2353;
</script>

{#if show}
  <div class="vload" class:inline aria-label="Loading">
    <div class="vload-bars">
      {#each [0, 1, 2, 3, 4] as i (i)}
        <i style="animation-delay:{(-STAGGER * i).toFixed(3)}s"></i>
      {/each}
    </div>
  </div>
{/if}
