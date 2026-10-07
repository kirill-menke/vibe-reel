<script>
  /* ActionBar — `.actions`: secondary actions under the primary button.
   *   actions  [{ id, icon, label, on, onclick, busy, p }] (falsy entries skipped)
   *     id     stable key (DET-11): the label may change (a download's state)
   *            without the button being recreated under the finger
   *     busy   spinner in the circle + disabled
   *     p      0–1: a download in progress — an App-Store-style ring around a
   *            small arrow in the circle. Give it as a getter when it ticks
   *            often (MovieDetail): only the ring then follows it
   * An action whose `on` turns true after the bar is up (Watched confirmed,
   * a download finished) pops its circle once; nothing on mount, nothing when
   * it turns off, nothing under Reduce Motion. A leaving action (From start
   * after Watched) lets its neighbours slide instead of jump. */
  import { flip } from 'svelte/animate';
  import Icon from '../Icon.svelte';
  import ProgressRing from '../ProgressRing.svelte';
  import { reducedMotion, rm, DUR, EASE, springEase } from '../../lib/safe.js';
  /** Falsy entries are dropped (`cond && {…}` yields '' for an empty-string cond).
   * @type {{ actions?: (VR.BarAction | null | false | '' | undefined)[] }} */
  let { actions = [] } = $props();
  const list = $derived(/** @type {VR.BarAction[]} */ ((actions || []).filter(Boolean)));
  /* The {#each} walks the keys, not the action objects: with animate:flip,
   * every change of the each's array measures every button (a forced layout)
   * whether anything moved or not. A screen rebuilds `actions` on any change
   * of a label or a tick, so the keyed array only changes when the set or
   * order of actions does (a string compares by value), and each button
   * reads its action through `byKey`. */
  const keyOf = (/** @type {VR.BarAction} */ a) => a.id || a.label;
  const sig = $derived(list.map(keyOf).join('\n'));
  const keys = $derived(sig ? sig.split('\n') : []);
  const byKey = $derived(new Map(list.map((a) => [keyOf(a), a])));

  /** @param {HTMLElement} node @param {boolean | undefined} on */
  function popOn(node, on) {
    let was = !!on;
    return {
      update(/** @type {boolean | undefined} */ now) {
        now = !!now;
        if (now && !was && !reducedMotion())
          node.querySelector('.action__icon')?.animate(
            [
              { transform: 'scale(.85)', easing: EASE.out },
              { transform: 'scale(1.08)', offset: 0.45, easing: EASE.inout },
              { transform: 'none' }
            ],
            { duration: DUR.springQuick }
          );
        was = now;
      }
    };
  }
</script>

{#if keys.length}
  <div class="actions">
    {#each keys as k (k)}
      {@const a = /** @type {VR.BarAction} */ (byKey.get(k) || {})}
      <button
        type="button"
        class="action {a.on ? 'action--on' : ''}"
        aria-pressed={a.on === undefined ? undefined : !!a.on}
        disabled={a.busy || undefined}
        onclick={a.onclick}
        use:popOn={a.on}
        animate:flip={{ duration: rm(DUR.base), easing: springEase.smooth }}
      >
        <span class="action__icon">
          {#if a.busy}<span class="spinner" style="--spinner: 18px"></span>
          {:else if a.p != null}<ProgressRing p={a.p} label="" class="action__ring"><Icon name={a.icon} size="xs" /></ProgressRing>
          {:else}<Icon name={a.icon} />{/if}
        </span>{a.label}
      </button>
    {/each}
  </div>
{/if}
