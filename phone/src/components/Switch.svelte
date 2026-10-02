<script module>
  /* iOS 17.4+ has a native switch control (<input type=checkbox switch>):
   * UISwitch's geometry, thumb drag and spring — and a real tap on it plays
   * the system haptic, the one haptic a web app still gets (iOS 26.5 patched
   * every programmatic trick; MOT-08 / PWA-09). Its track takes our gold via
   * accent-color. ⚠️ Device check pending (docs/ios/polish/motion-system.md
   * MOT-08): if the gold doesn't take on the iPhone, set NATIVE to false —
   * the drawn switch below is then the look everywhere (haptic lost). */
  const NATIVE = true;
  const native = NATIVE && typeof HTMLInputElement !== 'undefined' && 'switch' in HTMLInputElement.prototype;
</script>

<script>
  /* Switch — gold when on, 51 × 31, 44 pt hit area.
   *   on (bindable)   onchange(next)   label (aria-label)   disabled
   * Native `<input type=checkbox switch>` where the engine has it (iOS
   * Safari 17.4+); elsewhere (desktop dev Chrome, older iOS) a drawn
   * `.switch` button tuned to UISwitch (SW-01): translucent grey off track,
   * 27 pt thumb on a spring, the thumb stretching toward the middle while
   * pressed. Same API either way. */
  let { on = $bindable(false), onchange, label = '', disabled = false } = $props();
  function toggle() {
    if (disabled) return;
    on = !on;
    onchange?.(on);
  }
  function changed(e) {
    on = e.currentTarget.checked;
    onchange?.(on);
  }
</script>

{#if native}
  <label class="switch-hit">
    <input type="checkbox" switch class="switch-native" checked={on} {disabled} aria-label={label || undefined} onchange={changed} />
  </label>
{:else}
  <button type="button" class="switch {on ? 'switch--on' : ''}" role="switch" aria-checked={on} aria-label={label || undefined} {disabled} onclick={toggle}></button>
{/if}
