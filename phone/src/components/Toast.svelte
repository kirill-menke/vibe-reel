<script module>
  /* What reads as a failure (TST-01): the shared toast() has no kind, so the
   * phone tells errors by their wording — the shared messages that start this
   * way are all failures ("Couldn’t update …", "Can’t cancel this one from
   * here", "Add failed", "Test failed: …", "Download stopped — …", "This
   * download is damaged …", "Too late to undo …", "Not enough downloaded yet",
   * "Library busy …", "Download service unavailable …", "… needs iOS 17.1 or
   * later"). A heuristic: keep it next to the messages it covers. */
  const BAD =
    /^(Couldn[’']t|Can[’']t|Add failed|Test failed|Download stopped|This download is damaged|Too late|Not enough|Library busy|Download service unavailable|Picture in Picture isn[’']t)|needs iOS/;
  export const isBadToast = (/** @type {unknown} */ msg) => BAD.test(String(msg || ''));
</script>

<script>
  /* Toast — the app's one toast (src/lib/toast.svelte.js: toast(msg, undo)).
   * Undo runs takeUndo(). Mounted once by App.svelte.
   *   noTabbar     sits lower (player / login up, or a pushed page: no tab bar)
   *   aboveBanner  lifted over the offline banner (App passes conn.offline)
   * Kind by wording (isBadToast): a failure gets the red alert glyph, an undo
   * the check, anything else the info glyph. It springs in, a new message
   * while shown cross-fades with a small bump of the pill (TST-02), a thumb
   * resting on it keeps it (pauseToast; 2 s more after the lift), and a drag
   * down past 24 px or a flick dismisses it. Reduced motion: fades only. */
  import Icon from './Icon.svelte';
  import { toastState, takeUndo, pauseToast, resumeToast } from '$lib/toast.svelte.js';
  import { reducedMotion, DUR, SPRING } from '../lib/safe.js';
  import { fade } from 'svelte/transition';
  /** @type {{ noTabbar?: boolean, aboveBanner?: boolean }} */
  let { noTabbar = false, aboveBanner = false } = $props();

  const bad = $derived(isBadToast(toastState.msg));
  const icon = $derived(bad ? 'alert' : toastState.undo ? 'check' : 'info');

  let el = $state(/** @type {HTMLDivElement | null} */ (null));

  /* one bump when the text changes while the pill is already up */
  let lastMsg = '';
  let wasShown = false;
  $effect(() => {
    const m = toastState.msg;
    const on = toastState.show;
    if (on && wasShown && m !== lastMsg && el && !reducedMotion()) {
      el.animate([{ scale: '0.97' }, { scale: '1' }], { duration: DUR.springQuick, easing: SPRING.bouncy });
    }
    lastMsg = m;
    wasShown = on;
  });

  /* hold to keep, drag down to dismiss */
  /** @type {{ id: number, y0: number, dy: number, v: number, lastY: number, lastT: number } | null} */
  let drag = null; // { id, y0, dy, v, lastY, lastT }
  /** @param {PointerEvent} e */
  function down(e) {
    if (!toastState.show || /** @type {Element} */ (e.target).closest('.toast__action')) {
      if (toastState.show) pauseToast();
      return;
    }
    pauseToast();
    drag = { id: e.pointerId, y0: e.clientY, dy: 0, v: 0, lastY: e.clientY, lastT: e.timeStamp };
    /** @type {NonNullable<typeof el>} */ (el).setPointerCapture?.(e.pointerId);
  }
  /** @param {PointerEvent} e */
  function move(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dt = e.timeStamp - drag.lastT;
    if (dt > 0) drag.v = 0.7 * ((e.clientY - drag.lastY) / dt) + 0.3 * drag.v;
    drag.lastY = e.clientY;
    drag.lastT = e.timeStamp;
    const dy = e.clientY - drag.y0;
    drag.dy = dy > 0 ? dy : dy / 6; // resist upward
    /** @type {NonNullable<typeof el>} */ (el).style.translate = `0 ${drag.dy}px`;
    /** @type {NonNullable<typeof el>} */ (el).style.transition = 'none';
  }
  /** @param {PointerEvent} e */
  function up(e) {
    const d = drag;
    drag = null;
    if (!d) return resumeToast();
    /** @type {NonNullable<typeof el>} */ (el).style.transition = '';
    /** @type {NonNullable<typeof el>} */ (el).style.translate = '';
    if (d.dy > 24 || (d.v > 0.3 && d.dy > 6)) {
      // leave from where the finger let go: .toast--off's transition takes it on
      /** @type {NonNullable<typeof el>} */ (el).style.translate = `0 ${d.dy}px`;
      requestAnimationFrame(() => (/** @type {NonNullable<typeof el>} */ (el).style.translate = ''));
      toastState.show = false;
      toastState.undo = null;
      return;
    }
    resumeToast();
  }
</script>

<!-- a pointer target for the drag/hold; the Undo button inside stays the real control -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="toast {noTabbar ? 'toast--no-tabbar' : ''} {aboveBanner ? 'toast--above-banner' : ''} {bad ? 'toast--bad' : ''}"
  class:toast--off={!toastState.show}
  role="status"
  aria-live="polite"
  aria-hidden={!toastState.show}
  bind:this={el}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
>
  <span class="toast__icon"><Icon name={icon} size="sm" /></span>
  {#key toastState.msg}
    <span class="toast__text" in:fade={{ duration: DUR.fast }}>{toastState.msg}</span>
  {/key}
  {#if toastState.undo}<button type="button" class="toast__action" onclick={() => takeUndo()}>Undo</button>{/if}
</div>
