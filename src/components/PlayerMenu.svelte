<script>
  import { tick, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { describeTracks, groupSubs, streamByIndex } from '../lib/tracks.js';
  import { scrollElBy, focusEl, focusKey } from '../lib/focus.js';
  import {
    P, pmSetAudio, pmSetSub, setPictureMode, loadPictureModes, prettyMode, rangeLabel, nudgeSubOffset
  } from '../lib/player.svelte.js';
  import { SET, setSetting, SUB_SIZE_MIN, SUB_SIZE_MAX, SUB_SIZE_STEP } from '../lib/settings.svelte.js';

  let menuEl = $state(/** @type {HTMLDivElement | null} */ (null));

  const tracks = $derived(describeTracks(P.source, P.detailItem));
  const picHead = $derived(
    'PICTURE MODE' + (P.pictureModes.length ? ' · ' + rangeLabel(P.pictureMode || P.pictureModes[0]) : '')
  );

  /* Subtitles: None, the Settings language, the audio's language — the rest is
   * folded under a "More languages" row that expands in place (OK), so a file
   * with 37 subtitle streams doesn't open on a wall of Czech and Hungarian. */
  const groups = $derived(groupSubs(tracks.subs, streamByIndex(P.source, P.audioIndex)?.Language));
  let moreOpen = $state(false);
  $effect(() => {
    // Every opening starts folded, unless the current track lives in the fold.
    if (P.panel === 'subs') moreOpen = untrack(() => groups.more.some((s) => s.index === P.subIndex));
  });
  async function toggleMore() {
    moreOpen = !moreOpen;
    if (moreOpen && groups.more.length) await focusKey('pm-s-' + groups.more[0].index);
  }

  // Timing applies to subtitles the TV renders itself; burned-in ones are video.
  const showTiming = $derived(P.subIndex >= 0 && P.playMethod !== 'Transcode');
  // Size is a per-TV preference (reel.settings), not per item like timing.
  /** @param {number} dir +1 / −1 */
  function nudgeSubSize(dir) {
    const v = (SET.subSize || 100) + dir * SUB_SIZE_STEP;
    setSetting('subSize', Math.max(SUB_SIZE_MIN, Math.min(SUB_SIZE_MAX, v)));
  }
  const offsetText = $derived(
    (P.subOffset > 0 ? '+' : P.subOffset < 0 ? '−' : '') + Math.abs(P.subOffset).toFixed(2) + ' s'
  );

  /* The picture list arrives after the panel opened (the service is asked on
   * every open), so Osd's openPanel() found nothing to focus — move focus into
   * the list once the modes land, onto the current one, like Audio/Subtitles. */
  $effect(() => {
    if (P.panel !== 'picture' || P.picLoading) return;
    void P.pictureModes.length;
    tick().then(() => {
      if (P.panel !== 'picture' || !menuEl || menuEl.contains(document.activeElement)) return;
      const el = menuEl.querySelector('.opt.sub-sel') || menuEl.querySelector('.opt.focus');
      if (el) focusEl(el);
    });
  });

  /* The panel is capped to the space above its OSD button (anchorPanel() in
   * Osd.svelte) and scrolls when a track list is longer than that. Nothing else
   * would bring an off-panel row into view: focus.js's ensureVisible() only knows
   * the browse scrollers, and focusEl() focuses with preventScroll — so scroll it
   * here, on the same shared animator. No-ops while the list fits. */
  /** @param {FocusEvent} e */
  function keepInView(e) {
    if (!menuEl || menuEl.scrollHeight <= menuEl.clientHeight) return;
    const er = /** @type {Element} */ (e.target).getBoundingClientRect();
    const mr = menuEl.getBoundingClientRect();
    const pad = 10;
    if (er.top < mr.top + pad) scrollElBy(menuEl, er.top - (mr.top + pad));
    else if (er.bottom > mr.bottom - pad) scrollElBy(menuEl, er.bottom - (mr.bottom - pad));
  }
</script>

<div id="player-menu" bind:this={menuEl} hidden={!P.panel} onfocusin={keepInView}>
  {#if P.panel === 'audio'}
    <div class="sec">
      <div class="eyebrow sm">AUDIO</div>
      {#each tracks.audio as a (a.index)}
        <div
          class="opt focus"
          class:sub-sel={a.index === P.audioIndex}
          tabindex="0"
          role="button"
          data-focus="pm-a-{a.index}"
          onclick={() => pmSetAudio(a.index)}
          onkeydown={null}
        >
          <span>{a.label}</span>{#if a.codec === 'truehd'}<span class="mini">→ DD+ Atmos</span>{/if}{#if a.index === P.audioIndex}<span class="rdot">●</span>{/if}
        </div>
      {/each}
    </div>
  {:else if P.panel === 'subs'}
    {#snippet subRow(/** @type {VR.SubTrack} */ s)}
      <div
        class="opt focus"
        class:sub-sel={s.index === P.subIndex}
        tabindex="0"
        role="button"
        data-focus="pm-s-{s.index}"
        onclick={() => pmSetSub(s.index)}
        onkeydown={null}
      >
        <span>{s.label}</span>{#if s.index === P.subIndex}<span class="rdot">●</span>{/if}
      </div>
    {/snippet}
    <div class="sec">
      <div class="eyebrow sm">SUBTITLES</div>
      {#if showTiming}
        <div class="pmtiming pmsize">
          <span class="pmt-l">Size</span>
          <div
            class="opt focus pmt-b"
            tabindex="0"
            role="button"
            aria-label="Smaller subtitles"
            data-focus="pm-z-minus"
            onclick={() => nudgeSubSize(-1)}
            onkeydown={null}
          ><Icon name="minus" /></div>
          <span class="pmt-v" class:on={SET.subSize !== 100}>{SET.subSize} %</span>
          <div
            class="opt focus pmt-b"
            tabindex="0"
            role="button"
            aria-label="Bigger subtitles"
            data-focus="pm-z-plus"
            onclick={() => nudgeSubSize(1)}
            onkeydown={null}
          ><Icon name="plus" /></div>
        </div>
        <div class="pmtiming">
          <span class="pmt-l">Timing</span>
          <div
            class="opt focus pmt-b"
            tabindex="0"
            role="button"
            aria-label="Subtitles earlier"
            data-focus="pm-t-minus"
            onclick={() => nudgeSubOffset(-1)}
            onkeydown={null}
          ><Icon name="minus" /></div>
          <span class="pmt-v" class:on={P.subOffset !== 0}>{offsetText}</span>
          <div
            class="opt focus pmt-b"
            tabindex="0"
            role="button"
            aria-label="Subtitles later"
            data-focus="pm-t-plus"
            onclick={() => nudgeSubOffset(1)}
            onkeydown={null}
          ><Icon name="plus" /></div>
        </div>
      {/if}
      {#each groups.top as s (s.index)}
        {@render subRow(s)}
      {/each}
      {#if groups.more.length}
        <div
          class="opt focus pmmore"
          class:open={moreOpen}
          tabindex="0"
          role="button"
          aria-expanded={moreOpen}
          data-focus="pm-s-more"
          onclick={toggleMore}
          onkeydown={null}
        >
          <span>More languages</span><span class="pmm-n">{groups.more.length}</span><Icon name="chev" />
        </div>
        {#if moreOpen}
          {#each groups.more as s (s.index)}
            {@render subRow(s)}
          {/each}
        {/if}
      {/if}
    </div>
  {:else if P.panel === 'picture'}
    <div class="sec">
      <div class="eyebrow sm">{picHead}</div>
      {#if P.pictureModes.length}
        {#each P.pictureModes as v (v)}
          <div
            class="opt focus"
            class:sub-sel={v === P.pictureMode}
            class:pend={v === P.picPending}
            tabindex="0"
            role="button"
            data-focus="pm-pic-{v}"
            onclick={() => setPictureMode(v)}
            onkeydown={null}
          >
            <span>{prettyMode(v)}</span>{#if v === P.picPending}<span class="pmwait">Applying…</span>{:else if v === P.pictureMode}<span class="rdot">●</span>{/if}
          </div>
        {/each}
      {:else if P.picErr}
        <!-- The companion service didn't answer (not running, or restarting).
             A focusable Retry row, so the panel isn't a dead end with nothing
             to press — before, only closing and reopening it asked again. -->
        <div
          class="opt focus"
          tabindex="0"
          role="button"
          data-focus="pm-pic-retry"
          onclick={() => !P.picLoading && loadPictureModes()}
          onkeydown={null}
        >
          <span>Picture control unavailable — companion service not running</span><span class="pmwait">{P.picLoading ? 'Retrying…' : 'Retry'}</span>
        </div>
      {:else}
        <div class="opt muted">
          {P.picLoading ? 'Loading…' : 'No picture modes offered for this signal'}
        </div>
      {/if}
    </div>
  {/if}
</div>
