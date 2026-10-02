<script>
  import { decoded } from '../lib/decoded.js';
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import Osd from './Osd.svelte';
  import PlayerMenu from './PlayerMenu.svelte';
  import { S } from '../lib/nav.svelte.js';
  import { focusKey, scrollElBy } from '../lib/focus.js';
  import { imgUrl } from '../lib/api.js';
  import { fmtTime } from '../lib/format.js';
  import { SET } from '../lib/settings.svelte.js';
  import { mlActivity } from '../lib/medialib.js';
  import {
    P, setVideoEl, setPgsCanvas, sizePgs, showOsd, skipVisible, skipSegment,
    upNextVisible, upNextLeft, playNext, retryPlayback, exitPlayer, seekTo, closePanel
  } from '../lib/player.svelte.js';

  /* This layer stays mounted for the whole session and is toggled with [hidden],
   * exactly as the vanilla app's static sibling did — the <video> element must
   * survive across playbacks, and libpgs holds a reference to it. */

  let video = $state(null);
  let canvas = $state(null);

  $effect(() => setVideoEl(video));
  $effect(() => setPgsCanvas(canvas));

  const skip = $derived(skipVisible());
  const upNext = $derived(upNextVisible());
  const left = $derived(upNext ? upNextLeft() : 0);
  const nextImg = $derived(P.next ? imgUrl(P.next, 'Primary', { h: 200 }) || imgUrl(P.next, 'Thumb', { h: 200 }) : null);
  const nextNum = $derived(
    P.next && (P.next.ParentIndexNumber != null || P.next.IndexNumber != null)
      ? 'S' + (P.next.ParentIndexNumber ?? 0) + ':E' + (P.next.IndexNumber ?? 0)
      : ''
  );

  /* A chip takes focus the moment it appears, which is what makes a single OK
   * skip (or roll on to the next episode) — the OSD is usually down at that
   * point, and every key would otherwise go to "wake the transport". Two
   * exceptions: if focus is on the scrubber the user is mid-seek and yanking it
   * away mid-scrub would be hostile, and if it has already been handed somewhere
   * else we leave it alone. `back` is a plain closure variable, not $state, so
   * each effect depends on its chip's visibility and nothing more. */
  function chipFocus(key) {
    let back = null;
    return (shown) => {
      const here = document.activeElement?.dataset?.focus;
      if (shown) {
        if (here === 'c-scrub' || here === key) return;
        // Only remember a player control. A chip that appears at 0:00 comes up
        // before playback has focused anything, while focus still sits on the
        // detail page behind the player — handing it back there would park the
        // D-pad on a hidden element.
        back = here && document.activeElement.closest('#video-layer') ? here : null;
        focusKey(key);
      } else if (back) {
        const to = back;
        back = null;
        // Only reclaim focus if the chip still has it — the D-pad may have moved
        // on, and dropping focus on nothing leaves it with no anchor to move from.
        // A dropdown opening also hides the chip; that path focuses its own
        // contents on the next tick, so stay out of its way.
        if (!P.panel && (here === key || !here)) focusKey(to);
      }
    };
  }
  const introChip = chipFocus('c-skip');
  const nextChip = chipFocus('c-next');
  $effect(() => introChip(!!skip));
  $effect(() => nextChip(upNext));

  /* ---------------- text subtitles, drawn by us ----------------
   * The engine paints text cues *inside* <video>, i.e. under the OSD's scrim,
   * pinned to the bottom edge — between the transport buttons and half cut
   * off while the OSD is up. So the showing text track is flipped to
   * 'hidden' (cues still load and `cuechange` still fires, the engine just
   * stops painting) and its active cues are rendered into #subs, which sits
   * above the scrim and glides up over the transport while the OSD is shown.
   * player.svelte.js keeps setting tracks to 'showing' exactly as before; the
   * TextTrackList `change` event is where we take one over. getCueAsHTML()
   * keeps the cue's own <i>/<b> markup and never parses it as page HTML. */
  let subsEl = $state(null);
  let subsTopEl = $state(null);
  let cueTrack = null;

  function renderCues() {
    if (!subsEl || !subsTopEl) return;
    const bottom = [];
    const top = [];
    const cues = cueTrack && cueTrack.mode !== 'disabled' ? cueTrack.activeCues : null;
    if (cues) {
      for (let i = 0; i < cues.length; i++) {
        const c = cues[i];
        const d = document.createElement('div');
        d.className = 'cue';
        try {
          d.appendChild(c.getCueAsHTML());
        } catch {
          d.textContent = c.text || '';
        }
        // A cue explicitly placed near the top (signs, \an8 lines) stays up there.
        const high = typeof c.line === 'number' && c.line >= 0 && (c.snapToLines ? c.line < 4 : c.line < 30);
        (high ? top : bottom).push(d);
      }
    }
    subsEl.replaceChildren(...bottom);
    subsTopEl.replaceChildren(...top);
  }

  function adoptTrack() {
    const tl = video && video.textTracks;
    if (!tl) return;
    let next = null;
    for (let i = 0; i < tl.length; i++) {
      const t = tl[i];
      if (t.mode === 'showing') {
        t.mode = 'hidden';
        next = t;
      } else if (t === cueTrack && t.mode === 'hidden' && !next) next = t;
    }
    if (next !== cueTrack) {
      if (cueTrack) cueTrack.removeEventListener('cuechange', renderCues);
      cueTrack = next;
      if (cueTrack) cueTrack.addEventListener('cuechange', renderCues);
    }
    renderCues();
  }

  $effect(() => {
    const tl = video && video.textTracks;
    if (!tl) return;
    tl.addEventListener('change', adoptTrack);
    tl.addEventListener('addtrack', adoptTrack);
    tl.addEventListener('removetrack', adoptTrack);
    return () => {
      tl.removeEventListener('change', adoptTrack);
      tl.removeEventListener('addtrack', adoptTrack);
      tl.removeEventListener('removetrack', adoptTrack);
    };
  });

  /* ---------------- loading card ----------------
   * From startPlayback() to the first frame: the item's backdrop (dimmed), its
   * title and the spinner, instead of ~10 s of a bare ring on black. */
  const loadItem = $derived(P.loadingItem || P.detailItem || null);
  const loadImg = $derived.by(() => {
    const it = loadItem;
    if (it && it._art) return it._art;   // a trailer: the page's own backdrop
    if (!it || !it.Id) return null;
    return (
      imgUrl(it, 'Backdrop', { w: 1920 }) ||
      imgUrl(it, 'Thumb', { w: 1920 }) ||
      (it.Type === 'Episode' ? imgUrl(it, 'Primary', { w: 1920 }) : null)
    );
  });
  const loadTitle = $derived(loadItem ? (loadItem.Type === 'Episode' ? loadItem.SeriesName || loadItem.Name : loadItem.Name) || '' : '');
  const loadSub = $derived(
    loadItem && loadItem._sub
      ? loadItem._sub
      : loadItem && loadItem.Type === 'Episode'
      ? ['S' + (loadItem.ParentIndexNumber ?? 0) + ':E' + (loadItem.IndexNumber ?? 0), loadItem.SeriesName ? loadItem.Name : '']
          .filter(Boolean)
          .join(' · ')
      : loadItem && loadItem.ProductionYear
        ? String(loadItem.ProductionYear)
        : ''
  );

  /* Watch-while-downloading: while the stream waits at the download frontier
   * (the initial load, or a stall mid-film), say so with the live percentage.
   * The app-wide activity poll is off during playback, so this polls the one
   * endpoint itself, only while something is actually waiting. */
  let waitPct = $state(null);
  /* waitGone: the grab was in the feed during this stream and has since left
   * it — normally because Sonarr/Radarr imported it (the feed drops a title
   * once it's in the library). Before, the line just vanished into a bare
   * "Buffering…", which read as the stream dying. waitSeen is per download. */
  let waitGone = $state(null);
  let waitSeen = null;
  $effect(() => {
    const id = P.downloadId;
    if (!P.pending || !id || !(P.spinner || P.loading)) return;
    /* waitPct is only ever the percentage of waitSeen: a new download's
     * loading card must not open on the previous one's number */
    if (waitSeen !== id) waitPct = null;
    let alive = true;
    const poll = () =>
      mlActivity()
        .then((r) => {
          if (!alive) return;
          const it = ((r && r.items) || []).find((x) => x.download_id === id);
          if (it) {
            waitSeen = id;
            waitGone = null;
            waitPct = it.progress != null ? Math.floor(it.progress * 100) : null;
            if (it.status === 'importing') waitGone = 'Download complete — importing into your library…';
          } else if (waitSeen === id) {
            waitGone =
              waitPct != null && waitPct >= 99
                ? 'Download complete — it is now in your library'
                : 'This download has left the queue — the stream may end here';
          }
        })
        .catch(() => {});
    poll();
    const t = setInterval(poll, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  });
  const waitText = $derived(
    !P.pending
      ? ''
      : waitGone && waitSeen === P.downloadId
        ? waitGone
        : waitPct != null
          ? 'Waiting for download — ' + waitPct + '%'
          : ''
  );

  /* A mid-video stall (not the loading card) that outlasts 3 s gets a word
   * under the ring, so a long wait reads as "the network is slow" rather than
   * "the app froze". Short seek hiccups stay a bare ring. */
  let stallLong = $state(false);
  $effect(() => {
    stallLong = false;
    if (!P.spinner || P.loading || P.error) return;
    const t = setTimeout(() => (stallLong = true), 3000);
    return () => clearTimeout(t);
  });

  /* ---------------- chapter list ----------------
   * P.panel === 'chapters' (opened from the OSD's Chapters button, anchored by
   * Osd.svelte like the other dropdowns). OK seeks and closes. */
  let chapEl = $state(null);
  const chapIdx = $derived.by(() => {
    let k = -1;
    P.chapters.forEach((c, i) => {
      if (c.at <= P.pos + 0.5) k = i;
    });
    return k;
  });
  function pickChapter(c) {
    seekTo(c.at);
    closePanel();
  }
  function keepChapInView(e) {
    if (!chapEl || chapEl.scrollHeight <= chapEl.clientHeight) return;
    const er = e.target.getBoundingClientRect();
    const mr = chapEl.getBoundingClientRect();
    const pad = 10;
    if (er.top < mr.top + pad) scrollElBy(chapEl, er.top - (mr.top + pad));
    else if (er.bottom > mr.bottom - pad) scrollElBy(chapEl, er.bottom - (mr.bottom - pad));
  }

  onMount(() => {
    const onResize = () => sizePgs();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });
</script>

<div
  id="video-layer"
  class:osd-up={P.osdShown && !P.loading && !P.error}
  class:chip-intro={!!skip}
  class:chip-next={upNext}
  class:pm-chapters={P.panel === 'chapters'}
  class:pm-open={!!P.panel}
  style:--sub-scale={(SET.subSize || 100) / 100}
  role="application"
  aria-label="Video player"
  hidden={S.screen !== 'player'}
  onmousemove={() => {
    if (S.screen === 'player') showOsd();
  }}
>
  <!-- svelte-ignore a11y_media_has_caption -->
  <video id="video" playsinline bind:this={video}></video>
  <canvas id="pgs" bind:this={canvas}></canvas>
  <!-- Text subtitles (see adoptTrack): above the OSD scrim, lifted over the
       transport while it is up. #subs-top holds cues placed at the top. -->
  <div id="subs-top" bind:this={subsTopEl}></div>
  <div id="subs" bind:this={subsEl}></div>
  <Osd />
  <PlayerMenu />
  {#if P.panel === 'chapters'}
    <div id="chapter-menu" bind:this={chapEl} onfocusin={keepChapInView}>
      <div class="sec">
        <div class="eyebrow sm">CHAPTERS</div>
        {#each P.chapters as c, i (i)}
          <div
            class="opt focus"
            class:sub-sel={i === chapIdx}
            tabindex="0"
            role="button"
            data-focus="ch-{i}"
            onclick={() => pickChapter(c)}
            onkeydown={null}
          >
            <span class="chname">{c.name}</span><span class="chat">{fmtTime(c.at)}</span>
          </div>
        {/each}
      </div>
    </div>
  {/if}
  <!-- Outside <Osd> on purpose: the chip has to be visible (and clickable) while
       the OSD is faded out, and it rides up out of the transport's way when the
       OSD comes back. -->
  <button id="skip-intro" class="focus" data-focus="c-skip" hidden={!skip} onclick={skipSegment}>
    <Icon name="skip" inline />Skip {skip ? skip.kind : 'intro'}
  </button>
  <!-- Up Next: offered from the start of the credits (or the last seconds of the
       file), rolls on by itself when the countdown runs out. OK plays now, Back
       dismisses it for this pass. Same out-of-OSD placement as Skip Intro. -->
  <button id="up-next" class="focus" data-focus="c-next" hidden={!upNext} onclick={playNext}>
    <div class="unthumb">{#if nextImg}<img src={nextImg} alt="" />{/if}</div>
    <div class="untext">
      <div class="unlabel">
        <Icon name="skip" inline />Next episode{#if SET.autoplayNext && left > 0 && !P.paused}<span class="uncount">in {left}</span>{/if}
      </div>
      <div class="untitle">{[nextNum, P.next?.Name].filter(Boolean).join(' · ')}</div>
    </div>
  </button>
  <div id="spinner" hidden={!P.spinner || P.loading || !!P.error}>
    <div class="ring"></div>
    {#if waitText}<div class="waitmsg">{waitText}</div>{:else if stallLong}<div class="waitmsg">Buffering…</div>
      <!-- The stall watchdog's measurement (player.svelte.js): only while buffering,
           so it explains the wait without nagging during playback. -->
      {#if P.slowNet}<div class="slownet">This file needs about {P.slowNet.need} Mbit/s; the TV is getting about {P.slowNet.got}.<br>Put the TV on 5 GHz Wi-Fi or Ethernet.</div>{/if}{/if}
  </div>
  <!-- Paused with the OSD dismissed (Back hides it to look at the frame): a
       quiet corner tag so a still picture never reads as a frozen app. Not
       focusable — any key still wakes the OSD as before. -->
  <div id="paused-tag" class:show={P.paused && !P.osdShown && !P.loading && !P.error && !P.panel && !P.spinner}>
    <Icon name="pause" inline />
    <span class="ptw">Paused</span>
    {#if loadTitle}<span class="ptt">{[loadTitle, loadSub].filter(Boolean).join(' · ')}</span>{/if}
    <span class="ptpos">{fmtTime(P.pos)}{#if P.dur} / {fmtTime(P.dur)}{/if}</span>
  </div>
  <!-- Loading card: backdrop + title + spinner until the first frame; fades out
       (opacity) rather than vanishing, so the picture appears through it. -->
  <div id="play-loading" class:show={P.loading && !P.error} aria-hidden={!P.loading}>
    {#if loadImg}<img class="plbg" use:decoded={loadImg} alt="" />{/if}
    <div class="plshade"></div>
    <div class="plbody">
      <div class="ring"></div>
      <div class="pltitle">{loadTitle}</div>
      {#if loadSub}<div class="plsub">{loadSub}</div>{/if}
      {#if P.loadingFrom > 30}<div class="plfrom">Resuming from {fmtTime(P.loadingFrom)}</div>{/if}
      {#if waitText}<div class="waitmsg">{waitText}</div>{/if}
    </div>
  </div>
  {#if P.error}
    <div id="play-error" role="alertdialog" aria-label={P.error.title}>
      <div class="pecard">
        <div class="petitle">{P.error.title}</div>
        {#if loadTitle}<div class="peitem">{[loadTitle, loadSub].filter(Boolean).join(' · ')}</div>{/if}
        {#if P.error.detail}<div class="pedetail">{P.error.detail}</div>{/if}
        {#if P.error.tech}<div class="petech">{P.error.tech}</div>{/if}
        <div class="perow">
          <button class="btn big primary focus" data-focus="err-retry" onclick={retryPlayback}>Retry</button>
          <button class="btn big ghost focus" data-focus="err-back" onclick={exitPlayer}>Back</button>
        </div>
      </div>
    </div>
  {/if}
</div>
