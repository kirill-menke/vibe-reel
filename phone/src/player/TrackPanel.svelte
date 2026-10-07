<script>
  /* Audio & Subtitles picker (P.panel === 'tracks'). Landscape: the right-hand
   * glass .panel with both columns, so both can be changed in one visit.
   * Portrait: a bottom .sheet with a segmented Audio | Subtitles switch.
   * Picks go through the engine's pmSetAudio / pmSetSub — the only writers of
   * the per-series track memory. On the phone an audio switch restarts the HLS
   * remux at the same position (the stream carries one audio track); so does a
   * switch into or out of a VobSub/DVB burn-in. Text and PGS switch in place.
   * Quality (the Settings cap, pmSetQuality) sits under the audio column in
   * landscape and is the sheet's third tab in portrait: a pick restarts the
   * stream at the same position, and holds for later videos too. Not offered
   * for pending streams (they never go through Jellyfin's PlaybackInfo). */
  import Icon from '$p/components/Icon.svelte';
  import Segmented from '$p/components/Segmented.svelte';
  import Sheet from '$p/components/Sheet.svelte';
  import { pickerIn, pickerOut, panelIn, panelOut } from './pickers.js';
  import { describeTracks, groupSubs, streamByIndex, subFmt, videoStream, hdrLabel, PHONE_CAP_BOX } from '$lib/tracks.js';
  import { P, pmSetAudio, pmSetSub, nudgeSubOffset, pmSetQuality, getQualityCap, QUALITY_CAPS } from '$lib/player.svelte.js';
  import { SET, setSetting, SUB_SIZE_MIN, SUB_SIZE_MAX, SUB_SIZE_STEP } from '$lib/settings.svelte.js';

  /** @type {{ portrait?: boolean, onclose?: (() => void) | null, initial?: VR.TrackTab }} */
  let { portrait = false, onclose, initial = 'audio' } = $props();

  /** @type {VR.TrackTab} */
  let tab = $state('audio');
  $effect(() => {
    if (P.panel === 'tracks') tab = initial;
  });

  const tracks = $derived(describeTracks(P.source, P.detailItem));
  const groups = $derived(groupSubs(tracks.subs, streamByIndex(P.source, P.audioIndex)?.Language));
  /* "More languages" opens by itself when the playing subtitle is in it (the
   * panel mounts per visit), and still folds on a tap — folded, its row names
   * the selection instead of the count, so the choice never hides. */
  const selMore = $derived(groups.more.find((s) => s.index === P.subIndex) || null);
  let moreOpen = $state(false);
  let moreInit = false;
  $effect(() => {
    if (moreInit) return;
    moreInit = true;
    if (selMore) moreOpen = true;
  });

  /* Open on what's selected: a column (or the portrait sheet) scrolls so the
   * checked row is in view — a subtitle picked from "More languages" sat below
   * the fold. Only the panel's own scrollers move (scrollIntoView could also
   * shift the overflow-hidden player). */
  let rootEl = $state(/** @type {HTMLDivElement | null} */ (null));
  /** @param {Element | null} el @param {'nearest' | 'start'} [block] */
  function reveal(el, block = 'nearest') {
    let sc = el && el.parentElement;
    while (sc && sc !== rootEl && !(sc.scrollHeight > sc.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
    if (!sc || sc === rootEl) return;
    const r = /** @type {NonNullable<typeof el>} */ (el).getBoundingClientRect();
    const b = sc.getBoundingClientRect();
    if (block === 'start') sc.scrollTop += r.top - b.top - 8;
    else if (r.bottom > b.bottom) sc.scrollTop += r.bottom - b.bottom + 8;
    else if (r.top < b.top) sc.scrollTop -= b.top - r.top + 8;
  }
  $effect(() => {
    void tab;
    const root = rootEl;
    if (!root) return;
    requestAnimationFrame(() => {
      if (!portrait && initial === 'quality') reveal(root.querySelector('.vr-quality'), 'start');
      else for (const col of root.querySelectorAll('[role=radiogroup]')) reveal(col.querySelector('.option--selected'));
    });
  });

  // server-converted audio: Safari can't take TrueHD/DTS, Jellyfin re-encodes those
  const CONVERTED = new Set(['truehd', 'dts', 'dca', 'mlp', 'pcm_s16le', 'pcm_s24le', 'pcm_bluray', 'mp2', 'vorbis', 'wmav2']);
  /* "English · DD+ 5.1 · Atmos · Commentary by …": the title keeps language,
   * codec and Atmos (the design's "English · DD+ 5.1 Atmos"); a stream title
   * such as a commentary's goes to the sub line, or two commentaries both
   * ellipsize to the same "English · DD 2.0 · Comme…" and can't be told apart. */
  /** @param {VR.AudioTrack} a */
  function audioSplit(a) {
    const p = String(a.label || '').split(' · ');
    const head = p.slice(0, 2).join(' · ') + (p[2] === 'Atmos' ? ' Atmos' : '');
    return { title: head, rest: p.slice(p[2] === 'Atmos' ? 3 : 2).join(' · ') };
  }
  /** @param {VR.AudioTrack} a @param {number} i */
  function audioSub(a, i) {
    const bits = [];
    const rest = audioSplit(a).rest;
    if (rest) bits.push(rest);
    if (a.index === tracks.defaultAudio) bits.push('Default');
    if (CONVERTED.has(a.codec)) bits.push('converted by the server');
    return bits.join(' · ');
  }
  // "Default" marks what the app would pick by itself, as on the audio side
  /** @param {VR.SubTrack} s */
  function subSub(s) {
    if (s.index < 0) return '';
    let t;
    if (s.burn) t = subFmt(s.codec) + ' · burned in, restarts the video';
    else if (s.codec === 'pgssub' || s.codec === 'pgs') t = 'PGS · image-based';
    else t = s.forced ? 'Foreign dialogue only' : subFmt(s.codec);
    return s.index === tracks.defaultSub ? 'Default · ' + t : t;
  }
  // the label minus the trailing format word describeTracks() already appended
  /** @param {VR.SubTrack} s */
  function subTitle(s) {
    if (s.index < 0) return 'Off';
    return s.label.replace(/ · (PGS|(DVD|DVB|VOBSUB|XSUB) · burn-in)$/i, '');
  }

  const showTiming = $derived(P.subIndex >= 0 && P.playMethod !== 'Transcode');
  const offsetText = $derived((P.subOffset > 0 ? '+' : P.subOffset < 0 ? '−' : '') + Math.abs(P.subOffset).toFixed(2) + ' s');
  /** @param {number} dir +1 / −1 */
  function nudgeSize(dir) {
    const v = (SET.subSize || 100) + dir * SUB_SIZE_STEP;
    setSetting('subSize', Math.max(SUB_SIZE_MIN, Math.min(SUB_SIZE_MAX, v)));
  }

  /** @param {number} i stream index */
  function pickAudio(i) {
    if (i === P.audioIndex) return;
    pmSetAudio(i);
    // a restart is coming (HLS carries one track): close so the loading card is seen
    if (P.playMethod === 'DirectStream' || P.playMethod === 'Transcode' || P.loading) onclose?.();
  }
  /** @param {number} i stream index, −1 = off */
  function pickSub(i) {
    if (i === P.subIndex) return;
    pmSetSub(i);
    if (P.loading) onclose?.();
  }

  /* ---- quality ---- */
  const showQuality = $derived(!P.pending && !P.trailer);
  let cap = $state(getQualityCap());
  /** @param {number} b bit/s */
  const mbitOf = (b) => Math.round(b / 1e6);
  /** @param {number | 'original'} v */
  function qualityTitle(v) {
    return v === 'original' ? 'Original' : mbitOf(v) + ' Mbit/s';
  }
  // what each choice does to *this* file (tracks.js PHONE_CAP_BOX)
  /** @param {number | 'original'} v */
  function qualitySub(v) {
    const br = (P.source && P.source.Bitrate) || 0;
    if (v === 'original') return ['The file as it is', br ? mbitOf(br) + ' Mbit/s' : ''].filter(Boolean).join(' · ');
    const stereo = v <= 4000000 ? 'stereo' : '';
    if (br && br <= v) return ['Fits — plays as it is', stereo].filter(Boolean).join(' · ');
    const vs = videoStream(P.source);
    const box = PHONE_CAP_BOX[v];
    return [box ? box[1] + 'p' : '', vs && hdrLabel(vs) ? 'SDR' : '', stereo, 'converted'].filter(Boolean).join(' · ');
  }
  // landscape: opened from the quality chip — reveal() above brings the section into view
  let qualityEl = $state(/** @type {HTMLDivElement | null} */ (null));
  /** @param {number | 'original'} v */
  function pickQuality(v) {
    if (v === cap) return;
    cap = v;
    pmSetQuality(v);
    if (P.loading) onclose?.();   // restarting: let the loading card be seen
  }
</script>

{#snippet audioCol()}
  <div class="panel__col" role="radiogroup" aria-label="Audio">
    {#if !portrait}<p class="panel__label"><Icon name="audio" size="xs" />Audio</p>{/if}
    {#each tracks.audio as a, i (a.index)}
      <button class="option {a.index === P.audioIndex ? 'option--selected' : ''}" type="button" role="radio" aria-checked={a.index === P.audioIndex} onclick={() => pickAudio(a.index)}>
        <Icon name="check" class="option__check {a.index === P.audioIndex ? '' : 'option__check--off'}" />
        <span class="option__main">
          <span class="option__title">{audioSplit(a).title}</span>
          {#if audioSub(a, i)}<span class="option__sub">{audioSub(a, i)}</span>{/if}
        </span>
      </button>
    {:else}
      <p class="vr-empty">No audio tracks listed</p>
    {/each}
  </div>
{/snippet}

{#snippet qualityCol()}
  <div class="panel__col vr-quality" role="radiogroup" aria-label="Streaming quality" bind:this={qualityEl}>
    {#if !portrait}<p class="panel__label"><Icon name="settings" size="xs" />Quality</p>{/if}
    {#each QUALITY_CAPS as v (v)}
      <button class="option {v === cap ? 'option--selected' : ''}" type="button" role="radio" aria-checked={v === cap} onclick={() => pickQuality(v)}>
        <Icon name="check" class="option__check {v === cap ? '' : 'option__check--off'}" />
        <span class="option__main">
          <span class="option__title">{qualityTitle(v)}</span>
          <span class="option__sub">{qualitySub(v)}</span>
        </span>
      </button>
    {/each}
    <p class="vr-empty">Above the cap the server converts the video, and it starts a little slower. This is the Streaming quality setting: it stays until you change it, on every network.</p>
  </div>
{/snippet}

{#snippet subRow(/** @type {VR.SubTrack} */ s)}
  <button class="option {s.index === P.subIndex ? 'option--selected' : ''}" type="button" role="radio" aria-checked={s.index === P.subIndex} onclick={() => pickSub(s.index)}>
    <Icon name="check" class="option__check {s.index === P.subIndex ? '' : 'option__check--off'}" />
    <span class="option__main">
      <span class="option__title">{subTitle(s)}</span>
      {#if subSub(s)}<span class="option__sub">{subSub(s)}</span>{/if}
    </span>
  </button>
{/snippet}

{#snippet subsCol()}
  <div class="panel__col" role="radiogroup" aria-label="Subtitles">
    {#if !portrait}<p class="panel__label"><Icon name="subtitles" size="xs" />Subtitles</p>{/if}
    {#each groups.top as s (s.index)}{@render subRow(s)}{/each}
    {#if groups.more.length}
      <button class="option vr-more" type="button" aria-expanded={moreOpen} onclick={() => (moreOpen = !moreOpen)}>
        <Icon name="check" class="option__check option__check--off" />
        <span class="option__main"><span class="option__title">More languages</span></span>
        {#if selMore && !moreOpen}<span class="option__time vr-more__sel">{subTitle(selMore)}</span>{:else}<span class="option__time">{groups.more.length}</span>{/if}
        <Icon name={moreOpen ? 'chevron-down' : 'chevron-right'} size="sm" />
      </button>
      {#if moreOpen}
        {#each groups.more as s (s.index)}{@render subRow(s)}{/each}
      {/if}
    {/if}
    {#if showTiming}
      <div class="vr-adjust">
        <span class="vr-adjust__l">Size</span>
        <button class="closebtn" type="button" aria-label="Smaller subtitles" onclick={() => nudgeSize(-1)}><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"></path></svg></button>
        <span class="vr-adjust__v" class:vr-adjust__v--on={SET.subSize !== 100}>{SET.subSize} %</span>
        <button class="closebtn" type="button" aria-label="Bigger subtitles" onclick={() => nudgeSize(1)}><Icon name="plus" /></button>
      </div>
      <div class="vr-adjust">
        <span class="vr-adjust__l">Timing</span>
        <button class="closebtn" type="button" aria-label="Subtitles earlier" onclick={() => nudgeSubOffset(-1)}><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"></path></svg></button>
        <span class="vr-adjust__v" class:vr-adjust__v--on={P.subOffset !== 0}>{offsetText}</span>
        <button class="closebtn" type="button" aria-label="Subtitles later" onclick={() => nudgeSubOffset(1)}><Icon name="plus" /></button>
      </div>
    {/if}
  </div>
{/snippet}

{#if portrait}
  <!-- a real sheet (PLY-07): slides up, the grabber / head / body-at-top drag
       it down (Sheet.svelte), the scrim follows the drag -->
  <div class="vr-picker" bind:this={rootEl} data-component="TrackPicker" in:pickerIn|global out:pickerOut|global>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="scrim vr-sheetscrim" onclick={onclose}></div>
    <div class="vr-sheethost">
      <Sheet class="vr-sheet vr-sheet--fixed" title={tab === 'quality' ? 'Streaming quality' : 'Audio & Subtitles'} {onclose}>
        {#snippet head()}
          <div class="sheet__head">
            <h2 class="sheet__title">{tab === 'quality' ? 'Streaming quality' : 'Audio & Subtitles'}</h2>
            <button class="closebtn" type="button" aria-label="Close" onclick={onclose}><Icon name="x" /></button>
          </div>
          <div class="vr-sheet__seg">
            <Segmented options={showQuality ? [{ value: 'audio', label: 'Audio' }, { value: 'subs', label: 'Subtitles' }, { value: 'quality', label: 'Quality' }] : [{ value: 'audio', label: 'Audio' }, { value: 'subs', label: 'Subtitles' }]} bind:value={tab} label="Track type" />
          </div>
        {/snippet}
        {#if tab === 'quality' && showQuality}{@render qualityCol()}{:else if tab === 'subs'}{@render subsCol()}{:else}{@render audioCol()}{/if}
      </Sheet>
    </div>
  </div>
{:else}
  <div class="panel" role="dialog" aria-label="Audio and subtitles" bind:this={rootEl} data-component="TrackPicker" in:panelIn|global out:panelOut|global>
    <div class="panel__head">
      <h2 class="panel__title">Audio &amp; Subtitles</h2>
      <button class="closebtn" type="button" aria-label="Close" onclick={onclose}><Icon name="x" /></button>
    </div>
    <div class="panel__cols">
      {#if showQuality}
        <div class="vr-colstack">{@render audioCol()}{@render qualityCol()}</div>
      {:else}
        {@render audioCol()}
      {/if}
      {@render subsCol()}
    </div>
  </div>
{/if}
