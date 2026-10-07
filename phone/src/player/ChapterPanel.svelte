<script module>
  /* Chapter thumbnails, cut out of the trickplay sheets once per film as small
   * JPEGs. Used as CSS background crops, every sheet a chapter touched stayed
   * decoded whole while the panel was up — 3200 × 1800, ~23 MB each, and a
   * film's chapters reach up to ~8 of them. Now one sheet is decoded at a
   * time and let go once its chapters are cut. Kept until another film's. */
  let cutFor = '';             // the trickplay set (item / width) these belong to
  let cut = new Map();         // chapter start (s) → object URL
  let cutFailed = false;       // canvas refused (a cross-origin server): old crops
  let cutting = false;         // one pass at a time
</script>

<script>
  /* Chapters (P.panel === 'chapters'): the narrow right panel in landscape, a
   * bottom sheet in portrait. Thumbnails are Jellyfin's chapter images where
   * the server made them (`c.img`), else trickplay crops at each chapter's
   * start (none without trickplay); the current chapter is selected and shows
   * its progress. A tap seeks and closes. */
  import { onDestroy } from 'svelte';
  import Icon from '$p/components/Icon.svelte';
  import Sheet from '$p/components/Sheet.svelte';
  import { pickerIn, pickerOut, panelIn, panelOut } from './pickers.js';
  import { fmtTime } from '$lib/format.js';
  import { P, trickAt, seekTo } from '$lib/player.svelte.js';

  /** @type {{ portrait?: boolean, onclose?: (() => void) | null }} */
  let { portrait = false, onclose } = $props();

  const cur = $derived.by(() => {
    let k = -1;
    P.chapters.forEach((c, i) => {
      if (c.at <= P.pos + 0.5) k = i;
    });
    return k;
  });
  /** @param {number} i */
  function progressOf(i) {
    const c = P.chapters[i];
    const end = P.chapters[i + 1]?.at ?? P.dur;
    return end > c.at ? Math.max(0, Math.min(1, (P.pos - c.at) / (end - c.at))) : 0;
  }
  /* The 96 × 54 box (.option__thumb) is 16:9, the trickplay tile often isn't
   * (a scope film's is 320 × 132): scale the tile to *cover* the box and crop
   * its middle — scaling by width alone left a strip of the next row's tile
   * under every scope thumbnail. */
  const W = 96;
  const H = 54;
  let ver = $state(0);   // bumped as cut thumbnails land
  let gone = false;
  onDestroy(() => (gone = true));
  /** @param {VR.PlayerChapter} c */
  function thumb(c) {
    if (c.img) return `background-image:url('${c.img}');background-size:cover;background-position:center`;
    void ver;
    const u = cut.get(c.at);
    if (u) return `background-image:url('${u}');background-size:100% 100%`;
    if (!cutFailed) return '';
    const tp = P.trick ? trickAt(c.at + 1) : null;
    if (!tp) return '';
    const t = /** @type {VR.TrickLayout} */ (P.trick);
    const s = Math.max(W / t.w, H / t.h);
    const x = tp.x * s + (t.w * s - W) / 2;
    const y = tp.y * s + (t.h * s - H) / 2;
    return `background-image:url('${tp.url}');background-size:${t.cols * t.w * s}px auto;background-position:-${x}px -${y}px`;
  }
  /* Cut the missing thumbnails, sheet by sheet: decode one sheet, draw each
   * of its chapters' tiles (the cover crop above) into a W × H canvas at the
   * screen's density, keep the JPEG, drop the sheet. */
  async function cutThumbs() {
    if (cutting) return;
    cutting = true;
    try {
      await cutPass();
    } finally {
      cutting = false;
    }
  }
  async function cutPass() {
    const t = P.trick;
    if (!t || cutFailed) return;
    const set = t.id + '/' + t.res + '/' + t.sourceId;
    if (cutFor !== set) {
      for (const u of cut.values()) URL.revokeObjectURL(u);
      cut = new Map();
      cutFor = set;
    }
    const bySheet = new Map();
    for (const c of P.chapters) {
      if (c.img || cut.has(c.at)) continue;
      const tp = trickAt(c.at + 1);
      if (!tp) continue;
      if (!bySheet.has(tp.url)) bySheet.set(tp.url, []);
      bySheet.get(tp.url).push({ at: c.at, tp });
    }
    if (!bySheet.size) return;
    const dpr = Math.min(3, window.devicePixelRatio || 2);
    const cv = document.createElement('canvas');
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    const ctx = cv.getContext('2d');
    const s = Math.max(W / t.w, H / t.h);
    const sw = W / s;
    const sh = H / s;
    try {
      for (const [url, list] of bySheet) {
        if (gone || cutFor !== set) return;
        const img = new Image();
        img.src = url;
        try {
          await img.decode();
        } catch {
          continue;   // this sheet didn't load: its chapters stay blank
        }
        for (const { at, tp } of list) {
          if (cutFor !== set) return;
          /** @type {CanvasRenderingContext2D} */ (ctx).drawImage(img, tp.x + (t.w - sw) / 2, tp.y + (t.h - sh) / 2, sw, sh, 0, 0, cv.width, cv.height);
          const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.8));
          if (blob && cutFor === set) cut.set(at, URL.createObjectURL(blob));
        }
        img.src = '';
        if (!gone) ver++;
      }
    } catch {
      // a tainted canvas (sheets from another origin) can't be read back
      cutFailed = true;
      if (!gone) ver++;
    } finally {
      cv.width = cv.height = 0;
    }
  }
  $effect(() => {
    if (P.trick && P.chapters.length) cutThumbs();
  });
  /** @param {VR.PlayerChapter} c */
  function pick(c) {
    seekTo(c.at);
    onclose?.();
  }
  let bodyEl = $state(/** @type {HTMLDivElement | null} */ (null));
  let placed = false;
  $effect(() => {
    // open on the current chapter (once — not on every position update)
    if (placed || !bodyEl || cur < 0) return;
    placed = true;
    const el = bodyEl.querySelectorAll('.option')[cur];
    if (el) el.scrollIntoView({ block: 'center' });
  });
</script>

{#snippet list()}
  {#each P.chapters as c, i (i)}
    <button class="option {i === cur ? 'option--selected' : ''}" type="button" aria-current={i === cur ? 'true' : undefined} onclick={() => pick(c)} data-component="ChapterOption">
      <span class="option__thumb"><span class="art vr-chthumb" style={thumb(c)}></span>
        {#if i === cur}<span class="progress tile__progress" style="--p: {progressOf(i)}; left: 4px; right: 4px; bottom: 4px"><span class="progress__fill"></span></span>{/if}
      </span>
      <span class="option__main">
        <span class="option__title">{c.name}</span>
        {#if i === cur}<span class="option__sub">Now playing</span>{/if}
      </span>
      <span class="option__time">{fmtTime(c.at)}</span>
    </button>
  {/each}
{/snippet}

{#if portrait}
  <!-- a real sheet (PLY-07), see pickers.js -->
  <div class="vr-picker" data-component="ChapterPicker" in:pickerIn|global out:pickerOut|global>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="scrim vr-sheetscrim" onclick={onclose}></div>
    <div class="vr-sheethost">
      <Sheet class="vr-sheet" title="Chapters" {onclose} bind:bodyEl>{@render list()}</Sheet>
    </div>
  </div>
{:else}
  <div class="panel panel--narrow" role="dialog" aria-label="Chapters" data-component="ChapterPicker" in:panelIn|global out:panelOut|global>
    <div class="panel__head">
      <h2 class="panel__title">Chapters</h2>
      <button class="closebtn" type="button" aria-label="Close" onclick={onclose}><Icon name="x" /></button>
    </div>
    <div class="panel__body" bind:this={bodyEl}>{@render list()}</div>
  </div>
{/if}
