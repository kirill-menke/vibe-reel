<script module>
  /* Web build only (heroScroll's `__PHONE__ && __WEB__` branch; dropped from the
   * phone bundle): sharpen a lookup page's TMDB backdrop on a wide or HiDPI
   * window (E-02). fanartUrl() asks TMDB for w1280 — TMDB has nothing between
   * that and `original` (often 3840 px, ~6× the bytes) — which reads soft on a
   * hero more than 1440 device px wide. Called for every src the hero's <img>
   * gets: a w1280 src starts a detached load + decode of the original and swaps
   * it in once decoded (the w1280 stays up meanwhile); the swap itself answers
   * true, so the hero doesn't fade it in like a late image. */
  /** @type {WeakMap<HTMLImageElement, string> | undefined} */
  let sharpened;
  /** @param {HTMLImageElement} img @returns {boolean} true: this src is our own swap */
  function sharpenHero(img) {
    sharpened ||= new WeakMap();
    const src = img.getAttribute('src') || '';
    if (sharpened.get(img) === src) return true;
    const m = /^(https:\/\/image\.tmdb\.org\/t\/p\/)w1280(\/.+)$/.exec(src);
    if (!m || innerWidth * (devicePixelRatio || 1) <= 1440) return false;
    const big = m[1] + 'original' + m[2];
    const pre = new Image();
    pre.src = big;
    pre.decode().then(
      () => {
        if (!img.isConnected || img.getAttribute('src') !== src) return;
        /** @type {WeakMap<HTMLImageElement, string>} */ (sharpened).set(img, big);
        img.src = big;
      },
      () => {} // the w1280 stays
    );
    return false;
  }
</script>

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
  /** @type {{ src?: string | null, skeleton?: boolean, pending?: boolean, late?: boolean, height?: number }} */
  let { src = null, skeleton = false, pending = false, late = false, height = $bindable(0) } = $props();

  const PARALLAX = 0.3;

  /** @param {HTMLElement} node @param {boolean} lateOn */
  function heroScroll(node, lateOn) {
    const sc = node.closest('.screen');
    if (!sc) return;
    const route = node.closest('.route');
    const born = performance.now();
    const rmq = matchMedia('(prefers-reduced-motion: reduce)');
    let H = node.offsetHeight || 440;
    /** @type {HTMLElement | null} */
    let art = null;
    /** @type {HTMLElement | null} */
    let scrim = null;
    let resting = true; // transforms cleared
    const parts = () => {
      if (!art || !art.isConnected) art = /** @type {HTMLElement | null} */ (node.querySelector(':scope > .art, :scope > .skel'));
      if (!scrim || !scrim.isConnected) scrim = /** @type {HTMLElement | null} */ (node.querySelector(':scope > .detail__scrim'));
    };
    function write() {
      const y = /** @type {Element} */ (sc).scrollTop;
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
        if (__PHONE__ && __WEB__ && sharpenHero(img)) continue;
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
