<script>
  /* Segmented — `.seg` control (UISegmentedControl).
   *   options  [{ value, label }] (or plain strings)
   *   value (bindable)   onchange(value)   label (aria)
   * One thumb (`.seg__thumb`) sits under the equal-width options and slides to
   * the picked one on a spring (MOT-07); the pressed option's label shrinks, and
   * pressing the picked one squeezes the thumb (`.pressing`, lib/press.js). The
   * thumb is placed by `--i`/`--n` alone, so a fresh mount or an un-hidden route
   * paints it in place — a CSS transition never runs on a first style. */
  let { options = [], value = $bindable(), onchange, label = '' } = $props();
  const opts = $derived(options.map((o) => (typeof o === 'object' ? o : { value: o, label: String(o) })));
  const idx = $derived(opts.findIndex((o) => o.value === value));
  function pick(v) {
    if (v === value) return;
    value = v;
    onchange?.(v);
  }
</script>

<div class="seg {idx < 0 ? 'seg--none' : ''}" role="radiogroup" aria-label={label || undefined} style="--n: {opts.length || 1}; --i: {Math.max(0, idx)}">
  <span class="seg__thumb" aria-hidden="true"></span>
  {#each opts as o (o.value)}
    <button type="button" class="seg__opt {o.value === value ? 'seg__opt--active' : ''}" role="radio" aria-checked={o.value === value} onclick={() => pick(o.value)}>{o.label}</button>
  {/each}
</div>
