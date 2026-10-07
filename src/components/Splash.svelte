<script>
  import { onMount } from 'svelte';
  import { S } from '../lib/nav.svelte.js';

  /* VibeReel entry: pulse → mark → wordmark → hold → fade, ~4.9s. The app boots
   * behind the opaque overlay; the scene fades out (revealing Home) once both
   * the timeline has finished AND the data is ready — otherwise it holds on the
   * finished lockup as a loading state. Any key/click skips to the fade.
   *
   * This is a per-frame rAF animation writing inline styles directly: there is
   * nothing for fine-grained reactivity to do here, so the elements are grabbed
   * with bind:this and driven imperatively, exactly as before. */

  /** @type {{ ondone?: () => void }} */
  let { ondone } = $props();

  let scene = $state(/** @type {VR.NumStyled | null} */ (null));
  /* ring/arrow/word are bound inside the same {#if visible} as scene, and draw()
   * returns while scene is null — so wherever they're read, they are set. */
  let ring = $state(/** @type {VR.NumStyled} */ (/** @type {unknown} */ (null)));
  let arrow = $state(/** @type {VR.NumStyled} */ (/** @type {unknown} */ (null)));
  let word = $state(/** @type {VR.NumStyled} */ (/** @type {unknown} */ (null)));
  let bars = $state(/** @type {HTMLDivElement[]} */ ([]));
  let visible = $state(true);

  /* CUE.Hold is the "settled lockup" beat; nothing renders on it any more (it
   * used to raise the glow). The wordmark wipe still runs CUE.Word → +0.85 and
   * the scene is simply still from there until the fade. */
  const CUE = { Mark: 1.1, Word: 2.2, Hold: 3.4 };
  const TOTAL = 4.9;
  const fadeStart = TOTAL - 0.7;
  const fadeEnd = TOTAL - 0.05;
  /* The earliest the fade may begin: the wordmark wipe has landed (CUE.Word +
   * 0.85). The scene is still from there, so holding it to fadeStart only made
   * the user wait — Home is normally ready behind the splash at ~0.8 s
   * (measured on the TV), and the fixed hold put the first usable frame at
   * ~5.1 s on every cold start. */
  const FADE_EARLIEST = CUE.Word + 0.85;
  /* Hard stop on the "hold for data" state: if S.ready never arrives (a boot
   * fetch that hangs, a server that is off), get out of the way anyway rather
   * than sitting on the lockup forever — the screen underneath shows its own
   * loading/error state. */
  const HOLD_MAX = fadeStart + 6;
  /* Input is swallowed but ignored for the first second. Relaunching from the TV
   * launcher means the user presses OK at the moment the app comes up, and that
   * press lands in the fresh webview — which skipped the splash before the
   * wordmark had even started. By 1s the bars are visibly running, so a
   * genuinely impatient press still cuts straight to the fade. */
  const SKIP_GRACE = 1;
  const FINAL = [
    { dx: -57.75, h: 57 },
    { dx: -30.75, h: 93 },
    { dx: -3.75, h: 69 }
  ];

  /** @type {(p: number) => number} */
  const eoc = (p) => 1 - Math.pow(1 - p, 3);
  /** @type {(p: number) => number} */
  const eioc = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  /** @type {(p: number) => number} */
  const eob = (p) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
  };
  /** @type {(T: number, s: number, e: number, ease: (p: number) => number, from?: number, to?: number) => number} */
  const seg = (T, s, e, ease, from = 0, to = 1) => {
    const p = Math.max(0, Math.min(1, (T - s) / (e - s)));
    return from + (to - from) * ease(p);
  };
  /** @type {(a: number, b: number, p: number) => number} */
  const lerp = (a, b, p) => a + (b - a) * p;

  let skipped = false;
  let done = false;

  /* Bar i at time T: left/top of the pill, its height, its opacity. */
  /** @param {number} T @param {number} i */
  function barAt(T, i) {
    const barsIn = seg(T, 0.05, 0.55, eoc);
    const tp = Math.min(T, CUE.Mark);
    const conv = seg(T, CUE.Mark, CUE.Mark + 0.6, eioc);
    const gx = 960 - 250 * seg(T, CUE.Word, CUE.Word + 0.85, eioc);
    const ph = 48 + 60 * (0.5 + 0.5 * Math.sin(6.283 * (tp * 1.15) + i * 1.7));
    const px = (i - 2) * 36;
    let x, hgt, op;
    if (i >= 1 && i <= 3) {
      const f = FINAL[i - 1];
      x = lerp(px, f.dx, conv);
      hgt = lerp(ph, f.h, conv);
      op = barsIn;
    } else {
      x = lerp(px, i === 0 ? -57.75 : -3.75, conv);
      hgt = ph * (1 - conv);
      op = barsIn * (1 - conv);
    }
    const h = Math.max(2, hgt);
    return { left: gx + x - 8, top: 540 - h / 2, h, op };
  }

  /* The bars run on the compositor, not in the rAF loop below. Home mounts and
   * decodes its hero behind the splash in the same ~0.1–0.5 s the bars fade in
   * and breathe, and those 70–120 ms main-thread tasks froze a rAF-driven bar
   * animation for up to ~190 ms (measured: ~40 fps over the first 1.8 s, 4
   * gaps over 50 ms per launch). So the same curves are sampled into
   * Web Animations on transform/opacity only. A pill whose height animates
   * can't be a scaled rounded box (the ends would squash), so each bar is two
   * round caps and a 1 px middle strip stretched between them; below the cap
   * diameter the caps flatten into the tiny pill the old CSS drew. */
  const BAR_W = 16.5;
  /* Keyframes are expensive to hand to animate() here (~50 µs each on the TV:
   * 3660 of them — every bar part at 60 Hz — added ~160 ms to the first boot
   * task), so only the breathing (a sine) is sampled, at 20 Hz linear (< 0.5 px
   * off). Every other phase is one keyframe with the phase's own easing — the
   * values are linear in the eased parameter, so that is exact:
   *   converge (CUE.Mark → +0.6, ease-in-out cubic): position and height of the
   *     three kept bars; the two outer ones shrink below the cap size, so they
   *     stay sampled through it;
   *   wordmark shift (CUE.Word → +0.85, ease-in-out cubic): the wrapper's x;
   *   fade-in (0.05 → 0.55, ease-out cubic) / outer bars fading while they
   *     converge: a separate opacity animation. */
  const EOC = 'cubic-bezier(0.33, 1, 0.68, 1)';
  const EIOC = 'cubic-bezier(0.65, 0, 0.35, 1)';
  /** @param {CSSNumberish | null} startMs document.timeline.currentTime */
  function animateBars(startMs) {
    const STEP = 1 / 20;
    const CONV_END = CUE.Mark + 0.6;
    const END = CUE.Word + 0.85;
    /** @type {(node: Element, kf: Keyframe[], dur: number) => void} */
    const run = (node, kf, dur) => {
      const a = node.animate(kf, { duration: dur * 1000, fill: 'forwards' });
      a.startTime = startMs;
    };
    for (let i = 0; i < 5; i++) {
      const outer = i === 0 || i === 4;
      const wrap = /** @type {Keyframe[]} */ ([]), top = /** @type {Keyframe[]} */ ([]), mid = /** @type {Keyframe[]} */ ([]), bot = /** @type {Keyframe[]} */ ([]);
      /** @type {(t: number, easing: string, dur: number, withWrap?: boolean) => void} */
      const push = (t, easing, dur, withWrap = true) => {
        const b = barAt(t, i);
        const cap = Math.min(1, b.h / BAR_W);
        const o = t / dur;
        if (withWrap) wrap.push({ offset: t / END, easing, transform: `translate(${b.left}px, ${b.top}px)` });
        if (outer) top.push({ offset: o, easing, transform: `scaleY(${cap})` });
        mid.push({ offset: o, easing, transform: `translateY(${BAR_W / 2}px) scaleY(${Math.max(0, b.h - BAR_W)})` });
        bot.push({ offset: o, easing, transform: `translateY(${b.h - BAR_W * cap}px) scaleY(${cap})` });
      };
      for (let t = 0; t < CUE.Mark - 1e-6; t += STEP) push(t, 'linear', CONV_END);
      if (outer) for (let t = CUE.Mark; t < CONV_END - 1e-6; t += STEP) push(t, 'linear', CONV_END);
      else push(CUE.Mark, EIOC, CONV_END);
      push(CONV_END, 'linear', CONV_END);
      const b = barAt(CUE.Word, i);
      wrap.push({ offset: CUE.Word / END, easing: EIOC, transform: `translate(${b.left}px, ${b.top}px)` });
      const e = barAt(END, i);
      wrap.push({ offset: 1, transform: `translate(${e.left}px, ${e.top}px)` });
      const el = bars[i];
      run(el, wrap, END);
      if (outer) run(el.children[0], top, CONV_END);
      run(el.children[1], mid, CONV_END);
      run(el.children[2], bot, CONV_END);
      run(el, [
        { offset: 0, opacity: 0 },
        { offset: 0.05 / CONV_END, opacity: 0, easing: EOC },
        { offset: 0.55 / CONV_END, opacity: 1 },
        { offset: CUE.Mark / CONV_END, opacity: 1, easing: EIOC },
        { offset: 1, opacity: outer ? 0 : 1 }
      ], CONV_END);
    }
  }

  /** @param {number} T @param {number} fade */
  function renderAt(T, fade) {
    if (!scene) return;
    const triPop = seg(T, CUE.Mark + 0.3, CUE.Mark + 0.9, eob);
    const ringP = seg(T, CUE.Mark + 0.4, CUE.Mark + 1.05, eoc);
    const wordP = seg(T, CUE.Word, CUE.Word + 0.85, eioc);
    const gx = 960 - 250 * wordP;
    scene.style.opacity = fade;
    arrow.style.left = gx + 18 + 'px';
    arrow.style.top = 540 - 37.5 + 'px';
    arrow.style.transform = 'scale(' + Math.max(0, triPop) + ')';
    arrow.style.opacity = Math.min(1, triPop * 2);
    if (ringP > 0 && ringP < 1) {
      const rr = 90 + ringP * 170;
      ring.style.display = 'block';
      ring.style.left = gx + 5 - rr + 'px';
      ring.style.top = 540 - rr + 'px';
      ring.style.width = ring.style.height = 2 * rr + 'px';
      ring.style.opacity = (1 - ringP) * 0.55;
    } else {
      ring.style.display = 'none';
    }
    word.style.opacity = wordP;
    word.style.transform = 'translateX(' + (1 - wordP) * 44 + 'px)';
    word.style.clipPath = 'inset(0 ' + (1 - wordP) * 100 + '% 0 0)';
  }

  export function skip() {
    skipped = true;
  }

  function finish() {
    if (done) return;
    done = true;
    visible = false;
    S.splashActive = false;
    if (ondone) ondone();
  }

  onMount(() => {
    S.splashActive = true;
    const start = performance.now();
    animateBars(document.timeline.currentTime);
    /** @type {number | null} */
    let fadeBeganAt = null;

    /** @param {DOMHighResTimeStamp} now */
    function frame(now) {
      if (done) return;
      const T = (now - start) / 1000;
      if (fadeBeganAt == null && (skipped || (T >= FADE_EARLIEST && S.ready) || T >= HOLD_MAX)) fadeBeganAt = now;
      let fade = 1;
      if (fadeBeganAt != null) {
        const fp = Math.max(0, Math.min(1, (now - fadeBeganAt) / ((fadeEnd - fadeStart) * 1000)));
        fade = 1 - eioc(fp);
        if (fp >= 1) {
          renderAt(fadeStart, 0);
          finish();
          return;
        }
      }
      /* Past fadeStart the scene is frozen on the finished lockup (renderAt is
       * clamped), waiting for S.ready — nothing left to animate. */
      renderAt(Math.min(T, fadeStart), fade);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    /* Any key or click skips to the fade. The key listener is capture-phase on
     * window so it runs before the global handler and can swallow the press —
     * the same "splash first" position it had in the vanilla dispatch order. */
    const armed = () => (performance.now() - start) / 1000 >= SKIP_GRACE;
    const onClick = () => {
      if (armed()) skip();
    };
    /** @param {KeyboardEvent} e */
    const onKey = (e) => {
      if (done) return;
      /* Swallowed even inside the grace window: the screen behind the splash
       * must not act on the press either. */
      e.preventDefault();
      e.stopPropagation();
      if (armed()) skip();
    };
    document.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey, true);
    };
  });
</script>

{#if visible}
  <div id="splash">
    <div class="splash-scene" bind:this={scene}>
      <div class="sring" bind:this={ring}></div>
      {#each [0, 1, 2, 3, 4] as i (i)}
        <div class="sbar" bind:this={bars[i]}><i class="cap"></i><i class="mid"></i><i class="cap"></i></div>
      {/each}
      <div class="sarrow" bind:this={arrow}>
        <svg viewBox="0 0 34 50" width="51" height="75"><polygon points="0,0 0,50 34,25" fill="#e6b450" /></svg>
      </div>
      <div class="sword" bind:this={word}><span class="v">Vibe</span><span class="r">Reel</span></div>
    </div>
  </div>
{/if}
