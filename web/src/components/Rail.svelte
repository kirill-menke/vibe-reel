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

  const smooth = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth');

  /** @param {-1 | 1} dir */
  function page(dir) {
    const t = track;
    if (!t) return;
    const step = Math.max(200, t.clientWidth * 0.85);
    t.scrollBy({ left: dir * step, behavior: smooth() });
  }

  /* Glide the track so `tile` sits inside the gutter (the track's
   * scroll-padding). Measured here, because Firefox's scrollIntoView({ inline:
   * 'nearest' }) left a tile that stuck out past the padding where it was —
   * and the browsers don't scroll a focused tile that is already partly
   * visible at all (Tab onto a half-cut tile left 67–90 px of it hidden). */
  /** @param {HTMLElement} tile */
  function reveal(tile) {
    const t = track;
    if (!t) return;
    const tr = t.getBoundingClientRect();
    const r = tile.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(t).scrollPaddingInlineStart) || 0;
    const dx = r.left < tr.left + pad ? r.left - tr.left - pad : r.right > tr.right - pad ? r.right - tr.right + pad : 0;
    if (Math.abs(dx) >= 1) t.scrollBy({ left: dx, behavior: smooth() });
  }

  /* A cell's own stop: the track's child itself when it takes focus (a cast
   * member's button), else the first focusable inside it (Home and Search wrap
   * a tile in a .home__cell). A nested control — the quick-add "+", the ⋯ —
   * comes after its tile in the cell and is never the cell's stop. */
  const STOP = 'a[href], button:not(:disabled), [tabindex]:not([tabindex="-1"])';
  /** @param {Element | undefined} cell @returns {HTMLElement | null} */
  const stopOf = (cell) => /** @type {HTMLElement | null} */ (!cell ? null : cell.matches(STOP) ? cell : cell.querySelector(STOP));
  /** the target's cell when the target is that cell's stop @param {EventTarget | null} t */
  function cellOf(t) {
    const tr = track;
    if (!tr || !(t instanceof HTMLElement)) return -1;
    const cells = tr.children;
    for (let i = 0; i < cells.length; i++) if (cells[i].contains(t)) return stopOf(cells[i]) === t ? i : -1;
    return -1;
  }

  /* Keyboard: with a tile (or a cast member) focused, ← / → step to the
   * neighbouring cell (Tab still walks everything; ↑ / ↓ keep scrolling the
   * page). The track glides to it — a bare focus() would jump, and land it
   * flush against the edge instead of inside the gutter. */
  let stepping = false;
  /** @param {KeyboardEvent} e */
  function onKey(e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const t = track;
    const i = cellOf(e.target);
    if (!t || i < 0) return;
    const to = stopOf(t.children[i + (e.key === 'ArrowLeft' ? -1 : 1)]);
    e.preventDefault();
    if (!to) return;
    stepping = true;
    to.focus({ preventScroll: true, focusVisible: true }); // a key moved it: the ring shows
    stepping = false;
    reveal(to);
  }

  /* Tab (or Shift+Tab) onto a cell: the same glide as ← / →. Keyboard focus
   * only — a click focuses the tile too, and the track mustn't move under the
   * pointer (a right-click opens the context menu on it). */
  /** @param {FocusEvent} e */
  function onFocusIn(e) {
    const tile = e.target instanceof HTMLElement ? e.target : null;
    if (stepping || !tile || cellOf(tile) < 0 || !tile.matches(':focus-visible')) return;
    // after the browser's own focus scroll (which only acts on a tile that
    // is wholly out of view)
    requestAnimationFrame(() => document.activeElement === tile && reveal(tile));
  }

  const name = $derived(label || (title && sub ? title + ' ' + sub : title));
  const leftName = $derived(name ? 'Scroll ' + name + ' left' : 'Scroll left');
  const rightName = $derived(name ? 'Scroll ' + name + ' right' : 'Scroll right');
</script>

<section class="rail wrail {cls}" class:wrail--scrolls={!(atStart && atEnd)} aria-label={name || undefined}>
  <div class="rail__head">
    {#if head}{@render head()}{:else if title}
      <h2 class="rail__title">{title}{#if sub}<span class="rail__title-sub">{sub}</span>{/if}</h2>
    {:else}<span></span>{/if}
    <div class="wrail__arrows" hidden={atStart && atEnd}>
      <!-- mouse affordances: not Tab stops (← / → on a tile page the track
           from the keyboard, and paging left focus on the button while the
           tiles moved away); named after the rail for a screen reader -->
      <button type="button" class="wrail__btn" tabindex="-1" aria-label={leftName} disabled={atStart} onclick={() => page(-1)}><Icon name="chevron-left" /></button>
      <button type="button" class="wrail__btn" tabindex="-1" aria-label={rightName} disabled={atEnd} onclick={() => page(1)}><Icon name="chevron-right" /></button>
    </div>
  </div>
  <div class="wrail__wrap">
    <!-- tabindex -1: Firefox makes a scrolling track a Tab stop of its own (an
         empty one between the ◀ ▶ and the first tile); the tiles are the stops -->
    <div class="rail__track" bind:this={track} onkeydown={onKey} onfocusin={onFocusIn} role="presentation" tabindex="-1">{@render children?.()}</div>
    <!-- hover paddles: out of the Tab order and the accessibility tree (the
         head's buttons say the same); a mouse gets the head's words as a tooltip -->
    <button type="button" class="wrail__edge wrail__edge--l" tabindex="-1" aria-hidden="true" title={leftName} hidden={atStart} onclick={() => page(-1)}><Icon name="chevron-left" /></button>
    <button type="button" class="wrail__edge wrail__edge--r" tabindex="-1" aria-hidden="true" title={rightName} hidden={atEnd} onclick={() => page(1)}><Icon name="chevron-right" /></button>
  </div>
</section>
