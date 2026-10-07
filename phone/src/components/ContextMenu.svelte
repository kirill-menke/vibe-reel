<script>
  /* ContextMenu — long-press menu with a lifted preview (`.ctx`). Rendered
   * into #app (portal), so it can live anywhere in a page.
   *   open      show it
   *   rect      DOMRect of the pressed element (longpress detail.rect) — the
   *             preview is placed there and the menu under it (above when
   *             there's no room)
   *   items     [{ label, icon, danger, action, disabled } | { sep: true }
   *             | { title: true, label }]
   *             A `sep` draws the design's thick section break only in front
   *             of a destructive (danger) item — "Remove from …", "Cancel
   *             download…"; anywhere else it is dropped and the items keep
   *             the plain hairline (a thick bar between "Open" and "Mark as
   *             watched" split one list in two for no reason). Leading,
   *             trailing and doubled seps are dropped too. A `title` item is
   *             a centred caption heading the menu (.ctx__title) — a question
   *             that needs an answer belongs in confirm() (ActionSheet) instead.
   *   onclose   called once the menu has gone (tap outside, an item, or the
   *             app navigating under it); the item's action runs right after
   *   preview   snippet — the lifted preview (usually the same Tile)
   *   fit       'card' (default: full-width surface card around the preview, as
   *             for landscape tiles) | 'rect' (preview keeps the pressed
   *             element's size and x — posters)
   *   source    optional: the pressed element. Default: the node the
   *             `longpress` action registered for `rect` (pressSource), so a
   *             caller that passes `d.rect` needs nothing else.
   *   label     aria-label of the dialog
   * Motion (CTX-01, MOT-04, HOME-06): the preview grows out of the pressed
   * element (FLIP from its held size, spring) while the source is hidden, so
   * there is one copy; the menu scales in from its anchor a beat later. A tap
   * outside drops the preview back into the source; an item (it may navigate
   * or remove the source) fades the stack. Reduced motion: fades only. The
   * menu closes by itself when the app navigates (tab, push/pop, a sheet or
   * modal) while it is up. */
  import { tick, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { portal, pressSource } from '../lib/gestures.js';
  import { safeInsets, reducedMotion, DUR, EASE, SPRING } from '../lib/safe.js';
  import { R } from '../lib/router.svelte.js';

  /** @type {{ open?: boolean, rect?: DOMRect | null, items?: VR.CtxItem[], onclose?: () => unknown, preview?: VR.Snip, fit?: 'card' | 'rect', source?: HTMLElement | null, label?: string | null }} */
  let { open = false, rect = null, items = [], onclose, preview, fit = 'card', source = null, label = '' } = $props();

  let stackEl = $state(/** @type {HTMLDivElement | null} */ (null));
  let backEl = $state(/** @type {HTMLDivElement | null} */ (null));
  let menuEl = $state(/** @type {HTMLDivElement | null} */ (null));
  let prevEl = $state(/** @type {HTMLDivElement | null} */ (null));
  let top = $state(0);
  let closing = false;
  /** @type {HTMLElement | null} */
  let src = null; // the hidden source element while open
  /** @type {unknown[] | null} */
  let navKey = null; // the router state the menu opened on

  const W = () => window.innerWidth;
  const right = $derived(rect ? rect.left + rect.width / 2 > W() * 0.6 : false);

  $effect(() => {
    if (open && stackEl) untrack(place);
  });

  /* navigating under the menu closes it (a push tap, auth loss, a tab switch
   * by code): it is a portal in #app and used to stay up over the next page */
  $effect(() => {
    const k = [R.tab, R.stacks, R.modal, R.sheet];
    if (!open) return;
    untrack(() => {
      if (navKey && k.some((v, i) => v !== /** @type {NonNullable<typeof navKey>} */ (navKey)[i])) close(null, true);
    });
  });

  /* the artwork box inside an element (a tile's frame, a cast photo) —
   * what the eye follows from the source to the preview */
  const artOf = (/** @type {Element} */ el) => el?.querySelector('.tile__frame, .cast__photo, .episode__still') || el;

  async function place() {
    closing = false;
    navKey = [R.tab, R.stacks, R.modal, R.sheet];
    await tick();
    if (!stackEl) return;
    const ins = safeInsets();
    const h = stackEl.offsetHeight;
    const pad = fit === 'card' ? 12 : 0;
    const want = rect ? rect.top - pad : (window.innerHeight - h) / 2;
    top = Math.max(ins.top + 8, Math.min(want, window.innerHeight - ins.bottom - 16 - h));
    await tick(); // `top` applied: the preview's final box is measurable

    // no preview snippet: nothing is lifted, so the source stays where it is
    const s = preview ? source || pressSource(rect) : null;
    const from = s && s.isConnected ? artOf(s).getBoundingClientRect() : null;
    if (s) {
      src = s;
      s.style.visibility = 'hidden';
      // out of the build-up with no spring back (it's hidden; the drop-back
      // must find it at its resting size)
      s.classList.add('press-cut');
      s.classList.remove('holding');
      requestAnimationFrame(() => requestAnimationFrame(() => s.classList.remove('press-cut')));
    }
    if (reducedMotion()) {
      const f = { duration: DUR.rm, easing: 'linear' };
      backEl?.animate([{ opacity: 0 }, { opacity: 1 }], f);
      stackEl.animate([{ opacity: 0 }, { opacity: 1 }], f);
      return;
    }
    backEl?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR.base, easing: 'linear' });
    if (prevEl) prevEl.animate(lift(from, true), { duration: DUR.springQuick, easing: SPRING.bouncy });
    menuEl?.animate([{ opacity: 0, transform: 'scale(.9)' }, { opacity: 1, transform: 'scale(1)' }], {
      duration: DUR.springQuick,
      delay: 60,
      easing: SPRING.bouncy,
      fill: 'backwards'
    });
  }

  /* Keyframes between the source's art box and the preview's resting pose
   * (CSS: scale(1.03) about the bottom centre), with the origin at the
   * preview's top-left so one translate + scale maps box onto box. */
  /** @param {DOMRect | null} from @param {boolean} up */
  function lift(from, up) {
    const f = /** @type {NonNullable<typeof prevEl>} */ (prevEl).getBoundingClientRect(); // includes the resting 1.03
    const w = /** @type {NonNullable<typeof prevEl>} */ (prevEl).offsetWidth;
    const hh = /** @type {NonNullable<typeof prevEl>} */ (prevEl).offsetHeight;
    const rest = `translate(${-0.015 * w}px, ${-0.03 * hh}px) scale(1.03)`; // = scale(1.03) at 50% 100%
    let start = 'scale(.92)';
    let origin = '50% 50%';
    if (from && from.width) {
      const art = artOf(/** @type {HTMLDivElement} */ (prevEl));
      // the art's box inside the untransformed preview
      const a = art === prevEl ? { x: 0, y: 0, w } : (() => {
        const r = art.getBoundingClientRect();
        const k = f.width / w; // 1.03
        return { x: (r.left - f.left) / k, y: (r.top - f.top) / k, w: r.width / k };
      })();
      const k = from.width / a.w;
      const x0 = f.left + 0.015 * w * 1; // untransformed preview's left (undo the rest pose)
      const y0 = f.top + 0.03 * hh;
      start = `translate(${from.left - x0 - k * a.x}px, ${from.top - y0 - k * a.y}px) scale(${k})`;
      origin = '0 0';
    }
    const kf = [
      { transform: start, transformOrigin: origin },
      { transform: origin === '0 0' ? rest : 'scale(1.03)', transformOrigin: origin === '0 0' ? '0 0' : '50% 100%' }
    ];
    return up ? kf : kf.reverse();
  }

  function unhide() {
    if (src) src.style.visibility = '';
    src = null;
  }

  /* then: the item's action (after onclose). dropBack: a tap outside — the
   * preview settles back into the source instead of fading */
  /** @param {(() => unknown) | null} then */
  function close(then, quiet = false, dropBack = false) {
    if (closing) return;
    closing = true;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      unhide();
      onclose?.();
      then?.();
    };
    if (!stackEl || quiet) return done();
    if (reducedMotion()) {
      const o = /** @type {KeyframeAnimationOptions} */ ({ duration: DUR.rm, easing: 'linear', fill: 'forwards' });
      stackEl.animate([{ opacity: 1 }, { opacity: 0 }], o);
      /** @type {NonNullable<typeof backEl>} */ (backEl).animate([{ opacity: 1 }, { opacity: 0 }], o).onfinish = done;
      setTimeout(done, DUR.rm + 150);
      return;
    }
    const to = dropBack && src && src.isConnected ? artOf(src).getBoundingClientRect() : null;
    if (to && prevEl) for (const a of prevEl.getAnimations()) a.finish(); // measure the resting pose
    const back = /** @type {NonNullable<typeof backEl>} */ (backEl).animate([{ opacity: 1 }, { opacity: 0 }], { duration: DUR.base, easing: 'linear', fill: 'forwards' });
    if (to && prevEl && to.bottom > 0 && to.top < window.innerHeight) {
      menuEl?.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.92)' }], {
        duration: DUR.fast,
        easing: EASE.in,
        fill: 'forwards'
      });
      const p = prevEl.animate(lift(to, false), { duration: DUR.base, easing: EASE.sheet, fill: 'forwards' });
      p.onfinish = done; // the source reappears in the frame the preview lands
    } else {
      stackEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DUR.fast, easing: EASE.in, fill: 'forwards' });
      back.onfinish = done;
    }
    /* an animation in a hidden/throttled document may never finish: the
     * faded-out .ctx then stayed over the app and swallowed every tap */
    setTimeout(done, DUR.base + 150);
  }

  /** @param {KeyboardEvent} e */
  function key(e) {
    if (e.key === 'Escape') close(null, false, true);
  }

  const shown = $derived(
    (items || []).filter((it, i, a) => {
      if (!it) return false;
      if (!it.sep) return true;
      const next = a.slice(i + 1).find((x) => x && !x.sep);
      const prev = a.slice(0, i).some((x) => x && !x.sep && !x.title);
      return prev && next && next.danger && !(a[i + 1] && a[i + 1].sep);
    })
  );

  const prevStyle = $derived(
    fit === 'rect' && rect
      ? `width:${rect.width}px; margin-left:${Math.max(0, Math.min(rect.left, W() - rect.width - 20) - 20)}px`
      : ''
  );
</script>

<svelte:window onkeydown={open ? key : undefined} />

{#if open}
  <div class="ctx" use:portal role="dialog" aria-modal="true" aria-label={label || undefined}>
    <div class="ctx__backdrop" bind:this={backEl} onclick={() => close(null, false, true)} role="presentation"></div>
    <div class="ctx__stack" bind:this={stackEl} style="top: {top}px">
      {#if preview}
        <div class="ctx__preview {fit === 'card' ? 'ctx__preview--card' : ''}" style={prevStyle} bind:this={prevEl}>{@render preview()}</div>
      {/if}
      <div
        class="ctx__menu"
        role="menu"
        bind:this={menuEl}
        style="align-self: {right ? 'flex-end' : 'flex-start'}; transform-origin: {right ? '100%' : '0'} 0"
      >
        {#each shown as it, i (i)}
          {#if it.sep}
            <div class="ctx__sep" role="separator"></div>
          {:else if it.title}
            <p class="ctx__title">{it.label}</p>
          {:else}
            <button
              type="button"
              class="ctx__item {it.danger ? 'ctx__item--danger' : ''}"
              role="menuitem"
              disabled={it.disabled || undefined}
              onclick={() => close(() => it.action?.())}
            >
              <span>{it.label}</span>
              {#if it.icon}<Icon name={it.icon} />{/if}
            </button>
          {/if}
        {/each}
      </div>
    </div>
  </div>
{/if}
