<script>
  /* DetailHero — `.detail__hero`: the 440-high backdrop (decoded off the main
   * thread before it is shown) under the hero scrim.
   *   src       backdrop URL (null → tonal placeholder)
   *   skeleton  loading state (static block instead of the image)
   *   pending   the URL isn't known yet (metadata in flight): keep the full
   *             height and the tonal placeholder instead of collapsing to the
   *             short no-artwork band (DET-02)
   *   late      the page itself replaced a skeleton that was up a while: its
   *             backdrop dissolves in even when it lands at once
   *   height    bindable: the header's rendered height (NavBar solidify point)
   *
   * Scroll (DET-01): pulling the page down past its top (iOS rubber band)
   * stretches the backdrop and scrim upward from their bottom edge, so no
   * black band opens above the photo; scrolling up drifts the backdrop at 0.3×
   * (parallax — not under Reduce Motion, and not while the tile → page zoom's
   * overlay stands in for the hero). One transform write per scroll event,
   * no layout reads besides scrollTop.
   *
   * Late image (DET-03): a backdrop that arrives more than 150 ms after the
   * hero went up dissolves in (opacity on the <img>; the transform stays on
   * the .art) — never under `.zoom-hide`, where the zoom swaps its overlay out
   * expecting the real hero fully opaque. */
  import Art from '../Art.svelte';
  import Skeleton from '../Skeleton.svelte';
  import { DUR } from '../../lib/safe.js';
  let { src = null, skeleton = false, pending = false, late = false, height = $bindable(0) } = $props();

  const PARALLAX = 0.3;

  function heroScroll(node, lateOn) {
    const sc = node.closest('.screen');
    if (!sc) return;
    const route = node.closest('.route');
    const born = performance.now();
    const rmq = matchMedia('(prefers-reduced-motion: reduce)');
    let H = node.offsetHeight || 440;
    let art = null;
    let scrim = null;
    let resting = true; // transforms cleared
    const parts = () => {
      if (!art || !art.isConnected) art = node.querySelector(':scope > .art, :scope > .skel');
      if (!scrim || !scrim.isConnected) scrim = node.querySelector(':scope > .detail__scrim');
    };
    function write() {
      const y = sc.scrollTop;
      if (y >= H) {
        if (resting) return;
        resting = true;
        parts();
        if (art) art.style.transform = '';
        if (scrim) scrim.style.transform = '';
        return;
      }
      parts();
      if (y < 0) {
        const t = `scale(${(H - y) / H})`;
        if (art) art.style.transform = t;
        if (scrim) scrim.style.transform = t;
        resting = false;
      } else {
        const drift = y > 0 && !rmq.matches && !route?.classList.contains('zoom-hide');
        if (art) art.style.transform = drift ? `translate3d(0, ${Math.round(y * PARALLAX * 10) / 10}px, 0)` : '';
        if (scrim) scrim.style.transform = '';
        resting = !drift;
      }
    }
    sc.addEventListener('scroll', write, { passive: true });
    const ro = new ResizeObserver(() => {
      H = node.offsetHeight || H;
    });
    ro.observe(node);

    /* DET-03: fade a backdrop in that lands late. A MutationObserver runs
     * before the frame that would paint the new src, so the image never
     * flashes at full opacity first. */
    const mo = new MutationObserver((recs) => {
      for (const r of recs) {
        const img = r.target;
        if (!(img instanceof HTMLImageElement) || !img.getAttribute('src')) continue;
        if ((!lateOn && performance.now() - born < 150) || route?.classList.contains('zoom-hide')) continue;
        img.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR.img, easing: 'linear' });
      }
    });
    mo.observe(node, { subtree: true, attributes: true, attributeFilter: ['src'] });
    return {
      destroy() {
        sc.removeEventListener('scroll', write);
        ro.disconnect();
        mo.disconnect();
      }
    };
  }
</script>

<header class="detail__hero {!src && !skeleton && !pending ? 'detail__hero--empty' : ''}" bind:clientHeight={height} use:heroScroll={late}>
  {#if skeleton}<Skeleton kind="hero" />{:else}<Art {src} decode />{/if}
  <div class="detail__scrim"></div>
</header>
