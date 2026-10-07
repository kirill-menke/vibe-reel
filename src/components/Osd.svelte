<script>
  import { tick, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { fmtTime } from '../lib/format.js';
  import { focusEl } from '../lib/focus.js';
  import { S } from '../lib/nav.svelte.js';
  import {
    P, seekBy, seekTo, togglePause, showOsd, closePanel,
    osdTechSummary, endsAt, loadPictureModes, probePictureService, trickAt, playNext, SEEK_BACK, SEEK_FWD
  } from '../lib/player.svelte.js';

  /* The Picture button only exists where the companion service runs (a rooted TV). */
  $effect(() => {
    if (S.screen === 'player') untrack(probePictureService);
  });

  let dragging = $state(false);
  let dragFrac = $state(0);
  let scrubEl = $state(/** @type {HTMLButtonElement | null} */ (null));

  /** @type {Partial<VR.PlayerItem>} */
  const item = $derived(P.detailItem || P.item || {});
  /* An episode reads "Show" + "S1:E3 · Episode name" (the second part
   * ellipsised when the row runs out of room); a movie is just its name. */
  const title = $derived(item.Type === 'Episode' ? item.SeriesName || item.Name || '' : item.Name || '');
  const epLine = $derived(
    item._sub
      ? item._sub
      : item.Type === 'Episode'
      ? ['S' + (item.ParentIndexNumber ?? 0) + ':E' + (item.IndexNumber ?? 0), item.SeriesName ? item.Name : '']
          .filter(Boolean)
          .join(' · ')
      : ''
  );
  /* The chapter the bar's position sits in — named on the trickplay preview. */
  const curChapter = $derived.by(() => {
    let c = null;
    for (const ch of P.chapters) if (ch.at <= shownPos + 0.5) c = ch;
    return c;
  });
  /* The position the bar shows: a mouse drag, a pending D-pad scrub (see
   * scrubBy in player.svelte.js), or the playhead. */
  const shownPos = $derived(dragging ? dragFrac * P.dur : P.scrub != null ? P.scrub : P.pos);
  const pct = $derived(P.dur ? Math.min(100, (shownPos / P.dur) * 100) : 0);
  const curText = $derived(fmtTime(shownPos));
  /* How far a pending scrub/drag target is from the playhead ("+2:30") — shown
     on the trickplay preview so each ◀▶ step (and its acceleration) reads as a
     jump of known size, not just a new clock time. */
  const jumpText = $derived.by(() => {
    const d = Math.round(shownPos - P.pos);
    return Math.abs(d) < 1 ? '' : (d > 0 ? '+' : '–') + fmtTime(Math.abs(d));
  });

  /* Trickplay preview over the scrubber head while scrubbing. The sheet tiles
   * are small (320px wide), drawn at PREVIEW_SCALE for a 10-foot screen; the box
   * follows the head but is clamped so it never leaves the bar's span. */
  const PREVIEW_SCALE = 1.35;
  const tp = $derived(P.trick && (dragging || P.scrub != null) ? trickAt(shownPos) : null);
  const pw = $derived(P.trick ? Math.round(P.trick.w * PREVIEW_SCALE) : 0);
  const ph = $derived(P.trick ? Math.round(P.trick.h * PREVIEW_SCALE) : 0);
  const previewLeft = $derived.by(() => {
    const bar = scrubEl ? scrubEl.offsetWidth : 1792;
    const x = (pct / 100) * bar - pw / 2;
    return Math.max(0, Math.min(bar - pw, x));
  });

  /** @param {number} cx clientX @returns {number} 0…1 along the bar */
  function fracFromX(cx) {
    if (!scrubEl) return 0;
    const r = scrubEl.getBoundingClientRect();
    return Math.max(0, Math.min(1, (cx - r.left) / r.width));
  }

  /* Only a real pointer click seeks. A keyboard-triggered click has clientX = 0
   * (outside the bar) — ignore it so OK on the scrubber never jumps to 0. */
  /** @param {MouseEvent} e */
  function onScrubClick(e) {
    const r = /** @type {HTMLButtonElement} */ (scrubEl).getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && P.dur) seekTo(((e.clientX - r.left) / r.width) * P.dur);
  }

  /** @param {MouseEvent} e */
  function onScrubDown(e) {
    dragging = true;
    dragFrac = fracFromX(e.clientX);
    showOsd();
    e.preventDefault();
    /** @param {MouseEvent} ev */
    const move = (ev) => {
      dragFrac = fracFromX(ev.clientX);
      showOsd();
    };
    const up = () => {
      dragging = false;
      if (P.dur) seekTo(dragFrac * P.dur);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  /* Each OSD button owns its own dropdown (Audio / Subtitles / Picture) — one
   * panel element, `P.panel` says which list it holds. The panel is anchored to
   * the button that opened it so it reads as that button's dropdown: right edges
   * flush, bottom edge sitting PANEL_GAP directly above the button. Both axes are
   * clamped to the screen so a panel near an edge can't run off 1920×1080 — the
   * width against the 64px margin, the height by capping max-height to the space
   * over the button (the list scrolls rather than growing past the top). The CSS
   * `right` / `bottom` / `max-height` are the static fallback for the same layout.
   * Runs after tick(): it measures rects, so the panel must already be rendered. */
  const PANEL_GAP = 18; // px of air over the button — its focus ring is 8px of that
  const PANEL_EDGE = 64; // screen margin, same as .transport
  const PANEL_TOP = 24; // headroom a long list has to leave at the top of the screen

  /** @param {string} pill the opening button's data-focus @param {string} [menuId] */
  function anchorPanel(pill, menuId = 'player-menu') {
    const btn = document.querySelector(`[data-focus="${pill}"]`);
    const menu = document.getElementById(menuId);
    if (!btn || !menu) return;
    // Horizontally every dropdown hangs from the pill ROW's right edge, not its
    // own button: three buttons meant three different x positions (1121 / 1210 /
    // 1297 px) for panels of one width. Vertically the button still decides.
    const row = btn.closest('.pillrow') || btn;
    const rr = row.getBoundingClientRect();
    const r = { top: btn.getBoundingClientRect().top, right: rr.right, width: rr.width };
    if (!r.width) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = menu.offsetWidth || 0;
    const right = Math.min(Math.max(vw - r.right, PANEL_EDGE), Math.max(PANEL_EDGE, vw - PANEL_EDGE - w));
    menu.style.right = right + 'px';
    menu.style.bottom = Math.max(0, vh - r.top + PANEL_GAP) + 'px';
    menu.style.maxHeight = Math.max(200, r.top - PANEL_GAP - PANEL_TOP) + 'px';
  }

  /** @param {VR.PlayerPanel} kind @param {string} pill */
  async function openPanel(kind, pill) {
    if (P.panel === kind) {
      closePanel();
      return;
    }
    S.lastPill = pill;
    P.panel = kind;
    showOsd();
    if (kind === 'picture') loadPictureModes();
    await tick();
    // The chapter list is its own element (VideoLayer.svelte), same anchoring.
    const menuId = kind === 'chapters' ? 'chapter-menu' : 'player-menu';
    anchorPanel(pill, menuId);
    const menu = document.getElementById(menuId);
    // land on the current selection, not always the first row
    focusEl(menu?.querySelector('.opt.sel, .opt.sub-sel') || menu?.querySelector('.opt'));
  }
</script>

<div id="osd" class:show={P.osdShown}>
  <div class="scrim"></div>
  <div class="transport">
    <div class="head">
      <div class="ttitle">{title}</div>
      {#if epLine}<div class="tep">{epLine}</div>{/if}
      <div class="tsum">{osdTechSummary()}</div>
      <div class="ttime">
        <span class="cur">{curText}</span> <span class="sep">/ <span>{fmtTime(P.dur)}</span></span> <span class="ends">· ends {endsAt()}</span>
      </div>
    </div>

    <button
      class="scrubber focus"
      data-focus="c-scrub"
      aria-label="Seek"
      bind:this={scrubEl}
      onclick={onScrubClick}
      onmousedown={onScrubDown}
    >
      <div class="track">
        <div class="fill" style="width:{pct}%"></div>
        <!-- chapter boundaries: thin gaps cut into the bar (the first chapter
             starts at 0:00 and needs no mark) -->
        {#if P.dur}
          {#each P.chapters as c, i (i)}
            {#if c.at > 1 && c.at < P.dur - 1}<div class="tick" style="left:{(c.at / P.dur) * 100}%"></div>{/if}
          {/each}
        {/if}
        <div class="thumb" style="left:{pct}%"></div>
      </div>
      {#if tp}
        <div
          class="trick"
          style="left:{previewLeft}px; width:{pw}px; height:{ph}px; background-image:url('{tp.url}');
            background-size:{/** @type {VR.TrickLayout} */ (P.trick).cols * pw}px auto;
            background-position:-{tp.x * PREVIEW_SCALE}px -{tp.y * PREVIEW_SCALE}px"
        >
          <span>{curText}{#if jumpText}<small>{jumpText}</small>{/if}</span>
          {#if curChapter}<em class="tchap">{curChapter.name}</em>{/if}
        </div>
      {/if}
    </button>

    <div class="controls">
      <button
        class="cbtn sm focus"
        data-focus="c-rew"
        aria-label="Back {SEEK_BACK} seconds"
        onclick={() => seekBy(-SEEK_BACK)}><Icon name="back10" /></button
      >
      <button class="cbtn play focus" data-focus="c-play" onclick={togglePause}>
        <Icon name={P.paused ? 'play' : 'pause'} />
      </button>
      <button
        class="cbtn sm focus"
        data-focus="c-ff"
        aria-label="Forward {SEEK_FWD} seconds"
        onclick={() => seekBy(SEEK_FWD)}><Icon name="fwd30" /></button
      >
      <!-- Next episode: rolls on exactly like the Up Next card (playNext), but
           reports the real position unless the credits have been reached. -->
      {#if P.next && !P.pending}
        <button class="cbtn wide focus" data-focus="c-nextep" onclick={() => playNext(true)}>
          <Icon name="skip" /><span>Next episode</span>
        </button>
      {/if}
      <div class="pillrow">
        {#if P.chapters.length}
          <button
            class="pillbtn focus"
            class:on={P.panel === 'chapters'}
            data-focus="c-chap"
            aria-label="Chapters"
            title="Chapters"
            onclick={() => openPanel('chapters', 'c-chap')}><Icon name="chapters" /></button
          >
        {/if}
        {#if !P.trailer}
        <button
          class="pillbtn focus"
          class:on={P.panel === 'audio'}
          data-focus="c-audio"
          aria-label="Audio track"
          title="Audio"
          onclick={() => openPanel('audio', 'c-audio')}><Icon name="audio" /></button
        >
        {/if}
        {#if !P.trailer || P.source?.MediaStreams?.some((m) => m.Type === 'Subtitle')}
        <button
          class="pillbtn focus"
          class:on={P.panel === 'subs'}
          data-focus="c-subs"
          aria-label="Subtitles"
          title="Subtitles"
          onclick={() => openPanel('subs', 'c-subs')}><Icon name="subs" /></button
        >
        {/if}
        {#if P.picSvc}
        <button
          class="pillbtn focus"
          class:on={P.panel === 'picture'}
          data-focus="c-pic"
          aria-label="Picture mode"
          title="Picture"
          onclick={() => openPanel('picture', 'c-pic')}><Icon name="picture" /></button
        >
        {/if}
      </div>
    </div>
  </div>
</div>
