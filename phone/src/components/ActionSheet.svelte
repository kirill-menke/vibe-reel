<script>
  /* ActionSheet — UIAlertController(.actionSheet) for confirm()
   * (lib/confirm.svelte.js). Mounted once by App.svelte, above sheets and
   * context menus. Bottom-anchored inside the gutter: a group with the
   * centred title/message and the action, then a separate Cancel. It slides
   * up its own height on the sheet curve and leaves accelerating away; the
   * scrim, Cancel and Escape answer false. Focus goes to Cancel (the safe
   * default) and back to where it was after. Reduced motion: fades. */
  import { tick } from 'svelte';
  import { CONFIRM, answer } from '../lib/confirm.svelte.js';
  import { reducedMotion, DUR, EASE, SPRING } from '../lib/safe.js';

  let shown = $state.raw(null); // the request on screen (kept through the exit)
  let root = $state(null);
  let box = $state(null);
  let scrim = $state(null);
  let cancelBtn = $state(null);
  let before = null;
  let exitTimer = 0; // the running dismiss's fallback end()

  $effect(() => {
    const r = CONFIRM.req;
    if (r && r !== shown) present(r);
    else if (!r && shown) dismiss(shown);
  });

  async function present(r) {
    const again = !!shown;
    clearTimeout(exitTimer); // an exit still running is superseded
    shown = r;
    before = again ? before : document.activeElement;
    await tick();
    cancelBtn?.focus({ preventScroll: true });
    // replacing one still on screen (or on its way out): just stay up
    if (again) for (const el of [root, box, scrim]) el?.getAnimations().forEach((a) => a.cancel());
    if (again || !box) return;
    if (reducedMotion()) {
      root?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR.rm, easing: 'linear' });
      return;
    }
    scrim?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR.sheetOut, easing: 'linear' });
    box.animate([{ transform: `translate3d(0,${box.offsetHeight + 16}px,0)` }, { transform: 'translate3d(0,0,0)' }], {
      duration: DUR.spring,
      easing: SPRING.smooth
    });
  }

  function dismiss(r) {
    const end = () => {
      clearTimeout(exitTimer);
      // a newer confirm() took the sheet over mid-exit (present, `again`): it
      // owns the focus hand-back now — don't pull focus behind it (REV-03)
      if (shown !== r) return;
      if (!CONFIRM.req) shown = null;
      try {
        before?.focus?.({ preventScroll: true });
      } catch {}
      before = null;
    };
    if (!box || !root) return end();
    let a;
    if (reducedMotion()) a = root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DUR.rm, easing: 'linear', fill: 'forwards' });
    else {
      scrim?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DUR.sheetOut, easing: 'linear', fill: 'forwards' });
      a = box.animate([{ transform: 'translate3d(0,0,0)' }, { transform: `translate3d(0,${box.offsetHeight + 16}px,0)` }], {
        duration: DUR.sheetOut,
        easing: EASE.dismiss,
        fill: 'forwards'
      });
    }
    a.onfinish = end;
    exitTimer = setTimeout(end, DUR.sheetOut + 150); // a throttled document may never finish it
  }

  function key(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      answer(false);
    }
  }
</script>

<svelte:window onkeydown={shown && CONFIRM.req ? key : undefined} />

{#if shown}
  <div class="actsheet" bind:this={root} inert={!CONFIRM.req || undefined}>
    <div class="actsheet__scrim" bind:this={scrim} onclick={() => answer(false)} role="presentation"></div>
    <div class="actsheet__box" bind:this={box} role="alertdialog" aria-modal="true" aria-labelledby="actsheet-q">
      <div class="actsheet__group">
        {#if shown.title || shown.message}
          <div class="actsheet__head" id="actsheet-q">
            {#if shown.title}<p class="actsheet__title">{shown.title}</p>{/if}
            {#if shown.message}<p class="actsheet__msg">{shown.message}</p>{/if}
          </div>
        {/if}
        <button type="button" class="actsheet__btn {shown.danger ? 'actsheet__btn--danger' : ''}" onclick={() => answer(true)}>{shown.action}</button>
      </div>
      <div class="actsheet__group">
        <button type="button" class="actsheet__btn actsheet__btn--cancel" bind:this={cancelBtn} onclick={() => answer(false)}>{shown.cancel}</button>
      </div>
    </div>
  </div>
{/if}
