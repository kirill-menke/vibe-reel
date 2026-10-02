<script module>
  // fine-scrubbing tip: the first two drags of a session
  let tipsLeft = 2;
</script>

<script>
  /* The player's scrubber (.scrubber): times either side of the track, buffer,
   * gold fill, chapter ticks, intro/recap/credits marks, and — while a finger
   * drags it — the trickplay preview above the thumb.
   *
   * A drag moves the engine's pending target (P.scrub) — the same field the TV's
   * D-pad scrub uses, so the engine keeps the controls up while it is set and
   * the video isn't seeked until the finger lifts (one real seek per drag;
   * seeking an HLS remux restarts it on the server). Release commits it.
   *   compact  portrait overlay: smaller times, no preview chapter line */
  import { fmtTime } from '$lib/format.js';
  import { P, trickAt, commitScrub, cancelScrub, showOsd, videoEl } from '$lib/player.svelte.js';

  let { compact = false, onscrubbing } = $props();

  let trackEl = $state(null);
  let dragging = $state(false);

  const shownPos = $derived(P.scrub != null ? P.scrub : P.pos);
  const frac = $derived(P.dur ? Math.max(0, Math.min(1, shownPos / P.dur)) : 0);

  /* Buffered fraction ahead of the playhead — read on each position update
   * (P.pos changes ~4×/s while the controls are up). */
  const buf = $derived.by(() => {
    void P.pos;
    const v = videoEl();
    if (!v || !P.dur) return 0;
    try {
      const b = v.buffered;
      const t = P.pos;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) >= t) return Math.min(1, b.end(i) / P.dur);
    } catch {}
    return 0;
  });

  const marks = $derived.by(() => {
    if (!P.dur) return [];
    const out = P.skips.map((s) => ({ from: s.start / P.dur, to: Math.min(s.end, P.dur) / P.dur }));
    if (P.credits) out.push({ from: P.credits.start / P.dur, to: Math.min(P.credits.end || P.dur, P.dur) / P.dur });
    return out.filter((m) => m.to > m.from);
  });

  const ticks = $derived(P.dur ? P.chapters.filter((c) => c.at > 1 && c.at < P.dur - 1).map((c) => c.at / P.dur) : []);

  const chapter = $derived.by(() => {
    let c = null;
    for (const ch of P.chapters) if (ch.at <= shownPos + 0.5) c = ch;
    return c;
  });

  /* Trickplay crop: a 320×180 tile drawn at the design's 224×126. */
  const TW = $derived(compact ? 144 : 224);
  const tp = $derived(dragging && P.trick ? trickAt(shownPos) : null);
  const scale = $derived(P.trick ? TW / P.trick.w : 1);
  const th = $derived(P.trick ? Math.round(P.trick.h * scale) : 126);
  /* keep the preview inside the track's span */
  const previewX = $derived.by(() => {
    const w = trackEl ? trackEl.offsetWidth : 0;
    if (!w) return frac * 100 + '%';
    const x = frac * w;
    const half = TW / 2;
    return Math.max(half - 40, Math.min(w - half + 40, x)) + 'px';
  });

  function posAt(clientX) {
    const r = trackEl.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / (r.width || 1)));
    return f * (P.dur || 0);
  }

  /* Fine scrubbing (as iOS's own player): the further the finger moves away
   * from the bar, the slower the thumb follows — full, half, quarter, then a
   * tenth of the speed. On a 2 h film across ~600 px one pixel is 12 s at full
   * speed and ~1 s at the finest. Each change of speed re-anchors at the
   * current target, so the thumb never jumps. The first two drags of a session
   * show how to get there. */
  const RATES = [
    [48, 1, ''],
    [96, 0.5, 'Half-speed scrubbing'],
    [144, 0.25, 'Quarter-speed scrubbing'],
    [Infinity, 0.1, 'Fine scrubbing']
  ];
  let pid = null;
  let y0 = 0;
  let ax = 0;
  let apos = 0;
  let rate = $state(1);
  let rateLabel = $state('');
  let showTip = $state(false);
  function clampPos(t) {
    return Math.max(0, Math.min(P.dur - 1, t));
  }
  function down(e) {
    if (!P.dur || !trackEl || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    e.stopPropagation();
    pid = e.pointerId;
    try {
      e.currentTarget.setPointerCapture(pid);
    } catch {}
    dragging = true;
    onscrubbing?.(true);
    P.scrub = clampPos(posAt(e.clientX));
    y0 = e.clientY;
    ax = e.clientX;
    apos = P.scrub;
    rate = 1;
    rateLabel = '';
    showTip = tipsLeft-- > 0;
    showOsd();
  }
  function move(e) {
    if (!dragging || e.pointerId !== pid) return;
    e.preventDefault();
    const [, r, label] = RATES.find(([d]) => Math.abs(e.clientY - y0) < d);
    if (r !== rate) {
      // re-anchor at the current target: a change of speed never jumps the thumb
      apos = P.scrub != null ? P.scrub : apos;
      ax = e.clientX;
      rate = r;
      rateLabel = label;
      showTip = false;
    }
    const w = trackEl ? trackEl.getBoundingClientRect().width || 1 : 1;
    P.scrub = clampPos(apos + ((e.clientX - ax) / w) * P.dur * rate);
    showOsd();
  }
  function up(e) {
    if (!dragging || e.pointerId !== pid) return;
    dragging = false;
    pid = null;
    onscrubbing?.(false);
    commitScrub();
  }
  function cancel() {
    if (!dragging) return;
    dragging = false;
    pid = null;
    onscrubbing?.(false);
    cancelScrub();
  }
  /* Warm the neighbouring sheets while dragging, so the preview keeps up —
   * once per sheet the thumb enters, not on every pointer move (two new
   * Image()s per move, ~60 a second). */
  let warmSheet = -1;
  let warmTrick = null;
  $effect(() => {
    if (!tp || !P.trick) return;
    const t = P.trick;
    const per = t.cols * t.rows;
    const n = Math.floor(shownPos / t.interval);
    const sheet = Math.floor(n / per);
    if (sheet === warmSheet && t === warmTrick) return;
    warmSheet = sheet;
    warmTrick = t;
    for (const k of [sheet - 1, sheet + 1]) {
      if (k >= 0 && k * per < t.count) {
        const u = tp.url.replace(/\/\d+\.jpg/, '/' + k + '.jpg');
        new Image().src = u;
      }
    }
  });
</script>

<div class="scrubber {dragging ? 'scrubber--active' : ''} {compact ? 'vr-scrub--compact' : ''}" data-component="Scrubber">
  <span class="scrubber__time">{fmtTime(shownPos)}</span>
  <div
    class="vr-scrub__hit"
    role="slider"
    tabindex="-1"
    aria-label="Position"
    aria-valuemin="0"
    aria-valuemax={Math.round(P.dur || 0)}
    aria-valuenow={Math.round(shownPos)}
    aria-valuetext={fmtTime(shownPos) + ' of ' + fmtTime(P.dur)}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={cancel}
    onlostpointercapture={up}
  >
    <div class="scrubber__track" bind:this={trackEl} style="--p: {frac}; --b: {buf}">
      <div class="scrubber__buffer"></div>
      {#each marks as m, i (i)}<i class="scrubber__mark" style="--from: {m.from}; --to: {m.to}"></i>{/each}
      <div class="scrubber__fillclip"><div class="scrubber__fill"></div></div>
      {#each ticks as at, i (i)}<i class="scrubber__tick" style="--at: {at}"></i>{/each}
      <span class="scrubber__thumbpos"><span class="scrubber__thumb"></span></span>
      {#if dragging}
        <div class="trick vr-trick {compact ? 'vr-trick--compact' : ''}" style="left: {previewX}" data-component="TrickplayPreview">
          {#if chapter && !compact}<p class="trick__chapter">{chapter.name}</p>{/if}
          {#if tp}
            <div
              class="trick__frame"
              style="width: {TW}px; height: {th}px; background-image: url('{tp.url}');
                background-size: {P.trick.cols * P.trick.w * scale}px auto;
                background-position: -{tp.x * scale}px -{tp.y * scale}px"
            ></div>
          {/if}
          <p class="trick__time">{fmtTime(shownPos)}</p>
          {#if rateLabel}<p class="trick__chapter vr-trick__rate">{rateLabel}</p>
          {:else if showTip}<p class="trick__chapter vr-trick__rate">{compact ? 'Slide down' : 'Slide up'} to scrub finer</p>{/if}
        </div>
      {/if}
    </div>
  </div>
  <span class="scrubber__time scrubber__time--end">−{fmtTime(Math.max(0, (P.dur || 0) - shownPos))}</span>
</div>
