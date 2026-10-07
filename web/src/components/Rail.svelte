<script>
  /* Web variant of phone/src/components/Rail.svelte (swapped in by
   * web/vite.config.js; same props). A mouse can't swipe: the head gets
   * ◀ ▶ buttons that page the track by most of its width (smoothly), each one
   * dimmed at its end. The track still scrolls by trackpad / Shift+wheel. */
  import Icon from '$p/components/Icon.svelte';

  /** @type {{ title?: string, sub?: string, head?: VR.Snip, label?: string, class?: string, track?: HTMLElement | null, children?: VR.Snip }} */
  let { title = '', sub = '', head, label = '', class: cls = '', track = $bindable(null), children } = $props();

  let atStart = $state(true);
  let atEnd = $state(true);

  function measure() {
    const t = track;
    if (!t) return;
    atStart = t.scrollLeft <= 2;
    atEnd = t.scrollLeft + t.clientWidth >= t.scrollWidth - 2;
  }

  /* re-measure on scroll, on resize, and when tiles come and go */
  $effect(() => {
    const t = track;
    if (!t) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(t);
    const mo = new MutationObserver(() => requestAnimationFrame(measure));
    mo.observe(t, { childList: true });
    t.addEventListener('scroll', measure, { passive: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
      t.removeEventListener('scroll', measure);
    };
  });

  /** @param {-1 | 1} dir */
  function page(dir) {
    const t = track;
    if (!t) return;
    const step = Math.max(200, t.clientWidth * 0.85);
    t.scrollBy({ left: dir * step, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
</script>

<section class="rail wrail {cls}" class:wrail--scrolls={!(atStart && atEnd)} aria-label={label || title || undefined}>
  <div class="rail__head">
    {#if head}{@render head()}{:else if title}
      <h2 class="rail__title">{title}{#if sub}<span class="rail__title-sub">{sub}</span>{/if}</h2>
    {:else}<span></span>{/if}
    <div class="wrail__arrows" hidden={atStart && atEnd}>
      <button type="button" class="wrail__btn" aria-label="Scroll left" disabled={atStart} onclick={() => page(-1)}><Icon name="chevron-left" /></button>
      <button type="button" class="wrail__btn" aria-label="Scroll right" disabled={atEnd} onclick={() => page(1)}><Icon name="chevron-right" /></button>
    </div>
  </div>
  <div class="wrail__wrap">
    <div class="rail__track" bind:this={track}>{@render children?.()}</div>
    <button type="button" class="wrail__edge wrail__edge--l" tabindex="-1" aria-hidden="true" hidden={atStart} onclick={() => page(-1)}><Icon name="chevron-left" /></button>
    <button type="button" class="wrail__edge wrail__edge--r" tabindex="-1" aria-hidden="true" hidden={atEnd} onclick={() => page(1)}><Icon name="chevron-right" /></button>
  </div>
</section>
