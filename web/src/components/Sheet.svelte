<script module>
  /* The phone's Sheet exports these for its App's drag hand-off; the web App
   * has no sheet drag, but a phone module importing them still links. */
  export function takeSheetExitV() {
    return 0;
  }
  /** @param {VR.SheetFollower} _f */
  export function followSheet(_f) {
    return () => {};
  }
</script>

<script>
  /* Web variant of phone/src/components/Sheet.svelte (swapped in by
   * web/vite.config.js; same props). A desktop has no bottom sheets: the same
   * body renders as a popover (Accounts, Notifications — hung under their
   * buttons in the top navigation) or a dialog (Sort & filter) — App.svelte's
   * host decides where, from the sheet's name. Escape and a click outside
   * close it (the host); no drag. `large` only makes it taller. */
  import { untrack } from 'svelte';
  import Icon from '$p/components/Icon.svelte';
  import { R, top, closeSheet } from '$p/lib/router.svelte.js';

  /** @type {{ title?: string, large?: boolean, onclose?: (() => unknown) | null, headAction?: VR.Snip, head?: VR.Snip, foot?: VR.Snip, bodyEl?: HTMLElement | null, class?: string, children?: VR.Snip }} */
  let { title = '', large = false, onclose = null, headAction, head, foot, bodyEl = $bindable(null), class: cls = '', children } = $props();

  const close = () => (onclose ? onclose() : closeSheet());
  /** @type {HTMLElement | null} */
  let el = $state(null);

  /* keyboard users land in the popover, and go back to what opened it. The
   * page under a sheet is `inert` (App) until the same update that removes
   * the sheet, so the hand-back waits a task — and leaves focus alone if
   * something (a pushed page, a confirm) has taken it meanwhile, or if the
   * sheet closed because one of its rows navigated (a notification → the
   * show): then the new page takes focus (App), not the bell. */
  $effect(() => {
    const n = el;
    if (!n) return;
    const prev = /** @type {HTMLElement | null} */ (document.activeElement);
    const at = untrack(() => R.tab + ' ' + top().key);
    requestAnimationFrame(() => {
      if (!n.contains(document.activeElement)) n.focus({ preventScroll: true });
    });
    return () => {
      setTimeout(() => {
        const a = document.activeElement;
        if (R.tab + ' ' + top().key !== at) return;
        if (prev && prev.isConnected && !n.isConnected && (!a || a === document.body)) prev.focus?.({ preventScroll: true });
      });
    };
  });
</script>

<div class="sheet wsheet {large ? 'sheet--large wsheet--large' : ''} {cls}" role="dialog" aria-modal="true" aria-label={title || undefined} tabindex="-1" bind:this={el}>
  {#if head}{@render head()}{:else if title || headAction}
    <div class="sheet__head">
      <h2 class="sheet__title">{title}</h2>
      {#if headAction}{@render headAction()}{:else}
        <button type="button" class="closebtn" aria-label="Close" onclick={close}><Icon name="x" /></button>
      {/if}
    </div>
  {/if}
  <div class="sheet__body" bind:this={bodyEl}>{@render children?.()}</div>
  {#if foot}<div class="sheet__foot">{@render foot()}</div>{/if}
</div>
