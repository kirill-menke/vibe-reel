<script>
  /* Web variant of phone/src/components/Rail.svelte (swapped in by
   * web/vite.config.js; same props). A mouse can't swipe: the head gets
   * ◀ ▶ buttons that page the track by most of its width (smoothly), each one
   * dimmed at its end. The track still scrolls by trackpad / Shift+wheel, and
   * ← / → step between its tiles from the keyboard. */
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

  /* Keyboard: with a tile focused, ← / → step to the neighbouring tile (Tab
   * still walks everything; ↑ / ↓ keep scrolling the page). The track glides
   * to it — a bare focus() would jump, and land it flush against the edge
   * instead of inside the gutter. Home and Search wrap a
   * tile in a cell (.home__cell); the cells are the track's children. */
  /** @param {KeyboardEvent} e */
  function onKey(e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const t = track;
    const tile = /** @type {HTMLElement | null} */ (e.target instanceof Element ? e.target : null);
    if (!t || !tile?.matches('.tile')) return;
    const cells = [...t.children];
    const i = cells.findIndex((c) => c.contains(tile));
    const next = cells[i + (e.key === 'ArrowLeft' ? -1 : 1)];
    const to = /** @type {HTMLElement | null | undefined} */ (next?.matches('.tile') ? next : next?.querySelector('.tile'));
    e.preventDefault();
    if (i < 0 || !to) return;
    to.focus({ preventScroll: true, focusVisible: true }); // a key moved it: the ring shows
    // inside the gutter (the track's scroll-padding): measured here, because
    // Firefox's scrollIntoView({ inline: 'nearest' }) left a tile that stuck
    // out past the padding where it was
    const tr = t.getBoundingClientRect();
    const r = to.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(t).scrollPaddingInlineStart) || 0;
    const dx = r.left < tr.left + pad ? r.left - tr.left - pad : r.right > tr.right - pad ? r.right - tr.right + pad : 0;
    if (dx) t.scrollBy({ left: dx, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
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
    <!-- tabindex -1: Firefox makes a scrolling track a Tab stop of its own (an
         empty one between the ◀ ▶ and the first tile); the tiles are the stops -->
    <div class="rail__track" bind:this={track} onkeydown={onKey} role="presentation" tabindex="-1">{@render children?.()}</div>
    <button type="button" class="wrail__edge wrail__edge--l" tabindex="-1" aria-hidden="true" hidden={atStart} onclick={() => page(-1)}><Icon name="chevron-left" /></button>
    <button type="button" class="wrail__edge wrail__edge--r" tabindex="-1" aria-hidden="true" hidden={atEnd} onclick={() => page(1)}><Icon name="chevron-right" /></button>
  </div>
</section>
