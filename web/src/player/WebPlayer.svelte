<script>
  /* The desktop player: a full-window layer over the page, mounted for the
   * whole session (the <video> must survive across playbacks — libpgs holds
   * it), shown while the engine has the player up (S.screen === 'player',
   * mirrored into R.modal). Like the phone's Player.svelte it owns the video
   * and the PGS canvas and hands both to the engine (setVideoEl /
   * setPgsCanvas); everything playback-related is src/lib/player.svelte.js —
   * this file maps a mouse and a keyboard onto it.
   *
   *   mouse     moving shows the controls (the engine hides them after its
   *             idle timeout while playing; the cursor goes with them); a
   *             click on the picture toggles pause; a double click toggles
   *             full screen (on this layer, so the controls come along)
   *   keyboard  Space / K play-pause · ← → / J L ∓10 s · ↑ ↓ volume ·
   *             M mute · C subtitles on/off · F full screen · Esc closes a
   *             panel, else leaves full screen, else the player
   *   pieces    the phone's Scrubber (trickplay while dragging, plus a hover
   *             preview here), UpNextCard, ChapterPanel, TrackPanel (as the
   *             right-hand panels), the skip chip, loading / buffering /
   *             error cards; volume slider, Picture in Picture (where the
   *             browser has it) and full screen in the bottom row. */
  import { onMount, untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import Icon from '$p/components/Icon.svelte';
  import Scrubber from '$p/player/Scrubber.svelte';
  import TrackPanel from '$p/player/TrackPanel.svelte';
  import ChapterPanel from '$p/player/ChapterPanel.svelte';
  import UpNextCard from '$p/player/UpNextCard.svelte';
  import { imgUrl } from '$lib/api.js';
  import { fmtTime } from '$lib/format.js';
  import { decoded } from '$lib/decoded.js';
  import { SET } from '$lib/settings.svelte.js';
  import { toast } from '$lib/toast.svelte.js';
  import { describeTracks, streamByIndex } from '$lib/tracks.js';
  import { mlActivity } from '$lib/medialib.js';
  import { S } from '$lib/nav.svelte.js';
  import {
    P, setVideoEl, setPgsCanvas, showOsd, hideOsd, togglePause, seekTo, seekBy, effectivePos, trickAt,
    skipVisible, skipSegment, upNextVisible, playNext, retryPlayback, exitPlayer, closePanel, pmSetSub, pmSetQuality, QUALITY_CAPS
  } from '$lib/player.svelte.js';
  import { markQualityChosen } from '../lib/net.js';

  const SEEK_STEP = 10;
  const VOL_STEP = 0.05;
  const SPIN_DELAY = 450;
  const VOL_KEY = 'reel.web.volume';

  /** @type {{ open?: boolean }} */
  let { open: openProp = false } = $props();
  const open = $derived(openProp || S.screen === 'player');

  let rootEl = $state(/** @type {HTMLDivElement | null} */ (null));
  let video = $state(/** @type {HTMLVideoElement | null} */ (null));
  let canvas = $state(/** @type {HTMLCanvasElement | null} */ (null));
  $effect(() => setVideoEl(video));
  $effect(() => setPgsCanvas(canvas));

  /* PGS: hide the canvas while libpgs has nothing on it (the phone's trick —
   * a clear with no draw after it in the same task = empty). */
  $effect(() => {
    if (!canvas) return;
    const ctx = /** @type {(CanvasRenderingContext2D & { _vrWrapped?: boolean }) | null} */ (canvas.getContext('2d'));
    if (!ctx || ctx._vrWrapped) return;
    ctx._vrWrapped = true;
    const put = ctx.putImageData;
    const clear = ctx.clearRect;
    let drawn = 0;
    const c = canvas;
    ctx.putImageData = function (/** @type {any[]} */ ...a) {
      drawn++;
      c.style.visibility = '';
      return put.apply(this, /** @type {Parameters<typeof put>} */ (a));
    };
    ctx.clearRect = function (/** @type {any[]} */ ...a) {
      const at = drawn;
      queueMicrotask(() => {
        if (drawn === at) c.style.visibility = 'hidden';
      });
      return clear.apply(this, /** @type {Parameters<typeof clear>} */ (a));
    };
  });

  /* ---------------- state ---------------- */
  let scrubbing = $state(false);
  let overControls = $state(false); // the pointer rests on the control bar: keep it up
  const busy = $derived(P.loading || !!P.error);
  const ctl = $derived(open && !busy && (P.osdShown || P.paused || scrubbing || overControls || !!P.panel));
  const skip = $derived(open && !busy && !scrubbing ? skipVisible() : null);
  const upNext = $derived(open && !busy && upNextVisible());

  $effect(() => {
    if (!open) {
      scrubbing = false;
      overControls = false;
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }
  });

  /* ---------------- titles ---------------- */
  /** @type {Partial<VR.PlayerItem>} */
  const item = $derived(P.loadingItem || P.detailItem || P.item || {});
  const isEp = $derived(item.Type === 'Episode');
  const epCode = $derived(isEp ? 'S' + (item.ParentIndexNumber ?? 0) + ' · E' + (item.IndexNumber ?? 0) : '');
  const showLine = $derived(P.trailer ? 'Trailer' : isEp ? item.SeriesName || '' : item.ProductionYear ? String(item.ProductionYear) : '');
  const epLine = $derived(P.trailer ? item.Name || '' : isEp ? [epCode, item.Name].filter(Boolean).join(' · ') : item.Name || '');

  /* ---------------- tracks ---------------- */
  const tracks = $derived(describeTracks(P.source, P.detailItem));
  /** @param {string | null | undefined} label */
  function split(label) {
    const [a, ...rest] = String(label || '').split(' · ');
    return { main: a, dim: rest.join(' ') };
  }
  const audioChip = $derived(split(tracks.audio.find((a) => a.index === P.audioIndex)?.label || 'Audio'));
  const subChip = $derived.by(() => {
    if (P.subIndex < 0) return { main: 'Subtitles', dim: 'Off' };
    const s = tracks.subs.find((x) => x.index === P.subIndex);
    return split(s ? s.label.replace(/ · (PGS|(DVD|DVB|VOBSUB|XSUB) · burn-in)$/i, '') : 'Subtitles');
  });
  const hasSubs = $derived(tracks.subs.length > 1);
  const hasAudioChoice = $derived(!P.trailer && tracks.audio.length > 0);
  const pgsActive = $derived.by(() => {
    const s = streamByIndex(P.source, P.subIndex);
    const c = ((s && s.Codec) || '').toLowerCase();
    return c === 'pgssub' || c === 'pgs';
  });
  const quality = $derived(!P.pending && !P.trailer && P.quality ? P.quality : null);

  /** @param {VR.TrackTab} tab */
  let trackTab = $state(/** @type {VR.TrackTab} */ ('audio'));
  /** @param {VR.TrackTab} tab */
  function openTracks(tab) {
    trackTab = tab;
    P.panel = P.panel === 'tracks' && trackTab === tab ? null : 'tracks';
    showOsd();
  }
  function openChapters() {
    P.panel = P.panel === 'chapters' ? null : 'chapters';
    showOsd();
  }

  /* C: subtitles off, or back on — the last track this session, else the
   * file's default, else the first. */
  /** @type {number | null} */
  let lastSub = null;
  function toggleSubs() {
    if (!hasSubs) return;
    if (P.subIndex >= 0) {
      lastSub = P.subIndex;
      pmSetSub(-1);
      toast('Subtitles off');
      return;
    }
    const real = tracks.subs.filter((s) => s.index >= 0);
    const pick = real.find((s) => s.index === lastSub) || real.find((s) => s.index === tracks.defaultSub) || real[0];
    if (!pick) return;
    pmSetSub(pick.index);
    toast('Subtitles: ' + split(pick.label).main);
  }

  /* ---------------- loading / buffering ---------------- */
  const loadImg = $derived.by(() => {
    const it = item;
    if (it && it._art) return it._art;
    if (!it || !it.Id) return null;
    return imgUrl(it, 'Backdrop', { w: 1920 }) || imgUrl(it, 'Thumb', { w: 1920 }) || (isEp ? imgUrl(it, 'Primary', { w: 1280 }) : null);
  });
  const loadSub = $derived([P.trailer ? '' : epCode, P.loadingFrom > 30 ? 'resuming at ' + fmtTime(P.loadingFrom) : ''].filter(Boolean).join(' · '));

  let bufLong = $state(false);
  $effect(() => {
    bufLong = false;
    if (!P.spinner || P.loading || P.error) return;
    const t = setTimeout(() => (bufLong = true), 3000);
    return () => clearTimeout(t);
  });
  let spinShown = $state(false);
  $effect(() => {
    spinShown = false;
    if (!P.spinner || P.loading || P.error) return;
    const t = setTimeout(() => (spinShown = true), SPIN_DELAY);
    return () => clearTimeout(t);
  });
  /* a download watched while it comes in waits at the download frontier */
  let waitPct = $state(/** @type {number | null} */ (null));
  let waitGone = $state(/** @type {string | null} */ (null));
  $effect(() => {
    const id = P.downloadId;
    if (!P.pending || !id || !(P.spinner || P.loading)) return;
    let alive = true;
    const poll = () =>
      mlActivity()
        .then((r) => {
          if (!alive) return;
          const it = ((r && r.items) || []).find((x) => x.download_id === id);
          if (it) {
            waitGone = it.status === 'importing' ? 'Download complete — importing into your library…' : null;
            waitPct = it.progress != null ? Math.floor(it.progress * 100) : null;
          } else if (waitPct != null) {
            waitGone = waitPct >= 99 ? 'Download complete — it is now in your library' : 'This download has left the queue — the stream may end here';
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
  $effect(() => {
    P.downloadId;
    waitPct = null;
    waitGone = null;
  });
  const waitText = $derived(!P.pending || !P.downloadId ? '' : waitGone || (waitPct != null ? 'Waiting for download — ' + waitPct + '%' : ''));
  const fitCap = $derived.by(() => {
    const sn = P.slowNet;
    if (!sn || P.pending || P.trailer) return 0;
    return /** @type {Exclude<VR.QualityCap, 'original'> | 0} */ (QUALITY_CAPS.find((c) => c !== 'original' && c / 1e6 < sn.need && c / 1e6 <= sn.got) || 0);
  });
  const slowHint = $derived.by(() => {
    const sn = P.slowNet;
    if (!sn) return '';
    return (P.quality && P.quality.reduced ? 'This stream needs about ' : 'This file needs about ') + sn.need + ' Mbit/s; this connection gets about ' + sn.got + '.' +
      (fitCap ? '' : sn.got < 4 && !P.pending && !P.trailer ? ' That’s too slow even for 4 Mbit/s.' : '');
  });

  /* ---------------- volume ---------------- */
  let volume = $state(1);
  let muted = $state(false);
  onMount(() => {
    try {
      const v = Number(localStorage.getItem(VOL_KEY));
      if (Number.isFinite(v) && v >= 0 && v <= 1 && localStorage.getItem(VOL_KEY) != null) volume = v;
    } catch {}
  });
  /* the engine unmutes at every start (a DevTools mute once silenced every
   * later film on the TV); our own mute and volume are put back on top */
  $effect(() => {
    const v = video;
    if (!v) return;
    const sync = () => {
      if (Math.abs(v.volume - volume) > 0.001) v.volume = volume;
      if (v.muted !== muted) v.muted = muted;
    };
    sync();
    v.addEventListener('playing', sync);
    v.addEventListener('loadedmetadata', sync);
    return () => {
      v.removeEventListener('playing', sync);
      v.removeEventListener('loadedmetadata', sync);
    };
  });
  /** @param {number} v */
  function setVolume(v) {
    volume = Math.max(0, Math.min(1, Math.round(v * 100) / 100));
    if (volume > 0) muted = false;
    try {
      localStorage.setItem(VOL_KEY, String(volume));
    } catch {}
  }
  function toggleMute() {
    muted = !muted;
    if (!muted && volume === 0) setVolume(0.5);
  }
  const volIcon = $derived(muted || volume === 0 ? 'mute' : volume < 0.5 ? 'low' : 'high');

  /* ---------------- full screen, Picture in Picture ---------------- */
  let full = $state(false);
  onMount(() => {
    const on = () => (full = !!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  });
  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else rootEl?.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => toast('Full screen isn’t available here'));
  }

  let pip = $state(false);
  /* Chrome has the Picture-in-Picture API; Firefox has only its own built-in
   * PiP toggle (no API), so the button shows only where the API is real */
  const pipOk = typeof document !== 'undefined' && !!document.pictureInPictureEnabled && typeof HTMLVideoElement.prototype.requestPictureInPicture === 'function';
  async function togglePip() {
    if (!video) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else {
        if (pgsActive) toast('Image subtitles (PGS) aren’t shown in Picture in Picture');
        await video.requestPictureInPicture();
      }
    } catch (e) {
      console.warn('PiP failed:', e);
      toast('Picture in Picture isn’t available right now');
    }
  }

  /* ---------------- text subtitles, drawn by us (as the phone / TV) ---------------- */
  let subsEl = $state(/** @type {HTMLDivElement | null} */ (null));
  let subsTopEl = $state(/** @type {HTMLDivElement | null} */ (null));
  /** @type {TextTrack | null} */
  let cueTrack = null;

  function renderCues() {
    if (!subsEl || !subsTopEl) return;
    /** @type {HTMLElement[]} */
    const bottom = [];
    /** @type {HTMLElement[]} */
    const top = [];
    const cues = cueTrack && cueTrack.mode !== 'disabled' && !pip ? cueTrack.activeCues : null;
    if (cues) {
      for (let i = 0; i < cues.length; i++) {
        const c = /** @type {VTTCue} */ (cues[i]);
        const d = document.createElement('div');
        d.className = 'vr-cue';
        try {
          d.appendChild(c.getCueAsHTML());
        } catch {
          d.textContent = c.text || '';
        }
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
        if (!pip) t.mode = 'hidden';
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
  /* in Picture in Picture our DOM isn't drawn: the browser renders the track */
  $effect(() => {
    const v = video;
    if (!v) return;
    const onPip = () => {
      pip = document.pictureInPictureElement === v;
      if (cueTrack) {
        try {
          cueTrack.mode = pip ? 'showing' : 'hidden';
        } catch {}
      }
      renderCues();
    };
    v.addEventListener('enterpictureinpicture', onPip);
    v.addEventListener('leavepictureinpicture', onPip);
    return () => {
      v.removeEventListener('enterpictureinpicture', onPip);
      v.removeEventListener('leavepictureinpicture', onPip);
    };
  });

  /* ---------------- Media Session (media keys, the browser's media hub) ---------------- */
  $effect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    if (!open) {
      try {
        ms.metadata = null;
        ms.playbackState = 'none';
      } catch {}
      return;
    }
    /** @type {Partial<VR.PlayerItem>} */
    const it = P.detailItem || {};
    const art = it._art || (it.Id ? imgUrl(it, 'Primary', { h: 512 }) || imgUrl(it, 'Thumb', { w: 512 }) : null);
    try {
      ms.metadata = new MediaMetadata({
        title: P.trailer ? (it.Name || 'Trailer') + ' — Trailer' : isEp ? [epCode, it.Name].filter(Boolean).join(' · ') : it.Name || '',
        artist: isEp ? it.SeriesName || '' : it.ProductionYear ? String(it.ProductionYear) : '',
        album: 'VibeReel',
        artwork: art ? [{ src: art, sizes: '512x512', type: 'image/jpeg' }] : []
      });
    } catch {}
  });
  $effect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    /** @param {MediaSessionAction} a @param {MediaSessionActionHandler | null} f */
    const set = (a, f) => {
      try {
        ms.setActionHandler(a, f);
      } catch {}
    };
    set('play', () => video?.play().catch(() => {}));
    set('pause', () => video?.pause());
    set('seekbackward', (d) => seekBy(-(d?.seekOffset || SEEK_STEP)));
    set('seekforward', (d) => seekBy(d?.seekOffset || SEEK_STEP));
    set('seekto', (d) => d && d.seekTime != null && seekTo(d.seekTime, true));
    set('nexttrack', P.next && !P.trailer ? () => playNext(true) : null);
  });

  /* ---------------- mouse ---------------- */
  function onMove() {
    if (!open) return;
    showOsd();
  }
  /** @param {Element | null} el */
  const isControl = (el) => !!el?.closest?.('button, a, input, select, .scrubber, .upnext, .skipchip, .panel, .pcard, .wplayer__bar, .wplayer__top');
  /** @param {MouseEvent} e */
  function onStageClick(e) {
    if (!open || isControl(/** @type {Element} */ (e.target))) return;
    if (P.panel) {
      closePanel();
      return;
    }
    if (busy) return;
    togglePause();
    showOsd();
  }
  /** @param {MouseEvent} e */
  function onStageDbl(e) {
    if (!open || isControl(/** @type {Element} */ (e.target))) return;
    toggleFull();
  }

  /* hover preview over the scrubber (the phone's shows only while dragging) */
  let hover = $state(/** @type {{ x: number, w: number, at: number } | null} */ (null));
  /** @param {PointerEvent} e */
  function onBarMove(e) {
    const hit = /** @type {Element} */ (e.target).closest?.('.vr-scrub__hit');
    const track = hit?.querySelector('.scrubber__track');
    if (!track || !P.dur || scrubbing) {
      hover = null;
      return;
    }
    const r = track.getBoundingClientRect();
    const host = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1)));
    hover = { x: r.left - host.left + f * r.width, w: host.width, at: f * P.dur };
  }
  const hoverTp = $derived(hover && P.trick ? trickAt(hover.at) : null);
  const HW = 240;
  const hoverScale = $derived(P.trick ? HW / P.trick.w : 1);
  const hoverH = $derived(P.trick ? Math.round(P.trick.h * hoverScale) : 135);
  const hoverChapter = $derived.by(() => {
    if (!hover) return null;
    let c = null;
    for (const ch of P.chapters) if (ch.at <= hover.at + 0.5) c = ch;
    return c;
  });

  /* ---------------- keyboard ---------------- */
  /** @param {KeyboardEvent} e */
  function onKey(e) {
    if (!open || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = /** @type {HTMLElement} */ (e.target);
    if (t && (t.tagName === 'INPUT' && /** @type {HTMLInputElement} */ (t).type !== 'range')) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const live = !P.error && !P.loading;
    /** @type {(() => void) | null} */
    let act = null;
    if (k === 'Escape') {
      act = () => {
        if (P.panel) closePanel();
        else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else exitPlayer();
      };
    } else if ((k === ' ' || k === 'k') && live) {
      // a focused button would also click on Space: the key is ours
      act = () => {
        togglePause();
        showOsd();
      };
    } else if ((k === 'ArrowLeft' || k === 'j') && live) act = () => (seekBy(-SEEK_STEP), showOsd());
    else if ((k === 'ArrowRight' || k === 'l') && live) act = () => (seekBy(SEEK_STEP), showOsd());
    else if (k === 'ArrowUp') act = () => (setVolume(volume + VOL_STEP), showOsd());
    else if (k === 'ArrowDown') act = () => (setVolume(volume - VOL_STEP), showOsd());
    else if (k === 'm') act = () => (toggleMute(), showOsd());
    else if (k === 'c' && live) act = toggleSubs;
    else if (k === 'f') act = toggleFull;
    else if (k === 'n' && e.shiftKey && P.next && !P.trailer) act = () => playNext(true);
    if (!act) return;
    // arrows inside an open panel's list move through it instead
    if (P.panel && (k === 'ArrowUp' || k === 'ArrowDown') && t?.closest?.('.panel')) return;
    e.preventDefault();
    e.stopPropagation();
    act();
  }

  /* the layer takes keyboard focus when it opens (Space must not click
   * whatever button on the page had it) */
  $effect(() => {
    if (open && rootEl) untrack(() => rootEl?.focus({ preventScroll: true }));
  });
</script>

<svelte:window onkeydowncapture={onKey} />

<div
  class="wplayer"
  class:wplayer--ctl={ctl}
  class:wplayer--full={full}
  class:wplayer--trailer={P.trailer}
  hidden={!open}
  bind:this={rootEl}
  tabindex="-1"
  role="application"
  aria-label="Video player"
  style:--sub-scale={(SET.subSize || 100) / 100}
  onpointermove={onMove}
  data-component="WebPlayer"
>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="wplayer__stage" onclick={onStageClick} ondblclick={onStageDbl}>
    <!-- svelte-ignore a11y_media_has_caption -->
    <video class="wplayer__video" class:wplayer__video--dim={!!P.panel} playsinline preload="auto" bind:this={video}></video>
    <canvas class="vr-pgs" bind:this={canvas}></canvas>
    <div class="vr-subs-top" bind:this={subsTopEl}></div>
    <div class="vr-subs" class:vr-subs--raised={ctl} bind:this={subsEl}></div>
  </div>

  <!-- ============ controls ============ -->
  <div class="wplayer__chrome" class:wplayer__chrome--hidden={!ctl} aria-hidden={!ctl}>
    <div class="player__scrim player__scrim--top"></div>
    <div class="player__scrim player__scrim--bottom"></div>
    <div class="wplayer__top" onpointerenter={() => (overControls = true)} onpointerleave={() => (overControls = false)} role="toolbar" tabindex="-1">
      <button class="iconbtn" type="button" aria-label={P.trailer ? 'Close trailer' : 'Close player'} title="Close (Esc)" onclick={() => exitPlayer()}><Icon name="chevron-left" /></button>
      <div class="player__titles">
        {#if showLine}<p class="player__show">{showLine}</p>{/if}
        <p class="player__ep">{epLine}</p>
      </div>
    </div>

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="wplayer__bar"
      onpointerenter={() => (overControls = true)}
      onpointerleave={() => {
        overControls = false;
        hover = null;
      }}
      onpointermove={onBarMove}
    >
      {#if hover && !scrubbing}
        <div class="trick wtrick" style="left: {Math.max(HW / 2 + 8, Math.min(hover.w - HW / 2 - 8, hover.x))}px">
          {#if hoverChapter}<p class="trick__chapter">{hoverChapter.name}</p>{/if}
          {#if hoverTp && P.trick}
            <div
              class="trick__frame"
              style="width: {HW}px; height: {hoverH}px; background-image: url('{hoverTp.url}');
                background-size: {P.trick.cols * P.trick.w * hoverScale}px auto;
                background-position: -{hoverTp.x * hoverScale}px -{hoverTp.y * hoverScale}px"
            ></div>
          {/if}
          <p class="trick__time">{fmtTime(hover.at)}</p>
        </div>
      {/if}
      <Scrubber onscrubbing={(/** @type {boolean} */ v) => (scrubbing = v)} />
      <div class="wplayer__row">
        <button class="wpbtn" type="button" aria-label={P.paused ? 'Play' : 'Pause'} title={P.paused ? 'Play (k)' : 'Pause (k)'} onclick={() => togglePause()}><Icon name={P.paused ? 'play' : 'pause'} /></button>
        <button class="wpbtn" type="button" aria-label="Back {SEEK_STEP} seconds" title="Back {SEEK_STEP} s (←)" onclick={() => seekBy(-SEEK_STEP)}><Icon name="back-10" /></button>
        <button class="wpbtn" type="button" aria-label="Forward {SEEK_STEP} seconds" title="Forward {SEEK_STEP} s (→)" onclick={() => seekBy(SEEK_STEP)}><Icon name="fwd-10" /></button>
        <div class="wvol">
          <button class="wpbtn" type="button" aria-label={muted ? 'Unmute' : 'Mute'} title="{muted ? 'Unmute' : 'Mute'} (m)" onclick={toggleMute}>
            <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" />
              {#if volIcon === 'mute'}<path d="M16 9.5l5 5M21 9.5l-5 5" />
              {:else if volIcon === 'low'}<path d="M15.5 9.5a3.5 3.5 0 0 1 0 5" />
              {:else}<path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10" />{/if}
            </svg>
          </button>
          <input
            class="wvol__range"
            type="range"
            min="0"
            max="1"
            step="0.01"
            aria-label="Volume"
            value={muted ? 0 : volume}
            style="--v: {muted ? 0 : volume}"
            oninput={(e) => setVolume(Number(e.currentTarget.value))}
          />
        </div>
        <span class="wplayer__time">{fmtTime(P.scrub ?? P.pos)} <span class="wplayer__dur">/ {fmtTime(P.dur)}</span></span>
        <span class="player__spacer"></span>
        {#if P.chapters.length && !P.trailer}
          <button class="pchip" class:pchip--on={P.panel === 'chapters'} type="button" onclick={openChapters}><Icon name="chapters" />Chapters</button>
        {/if}
        {#if hasAudioChoice}
          <button class="pchip" type="button" onclick={() => openTracks('audio')}><Icon name="audio" />{audioChip.main} {#if audioChip.dim}<span class="pchip__dim">{audioChip.dim}</span>{/if}</button>
        {/if}
        {#if hasSubs}
          <button class="pchip" type="button" title="Subtitles (c)" onclick={() => openTracks('subs')}><Icon name="subtitles" />{subChip.main} {#if subChip.dim}<span class="pchip__dim">{subChip.dim}</span>{/if}</button>
        {/if}
        {#if quality}
          <button class="pchip" type="button" aria-label="Streaming quality: {quality.label}" onclick={() => openTracks('quality')}><Icon name="settings" />{quality.reduced ? quality.res || 'Reduced' : 'Original'} <span class="pchip__dim">{quality.reduced ? quality.mbit + ' Mbit/s' : 'fits ' + quality.mbit + ' Mbit/s'}</span></button>
        {/if}
        {#if P.next && !P.trailer}
          <button class="wpbtn" type="button" aria-label="Next episode" title="Next episode (Shift+N)" onclick={() => playNext(true)}><Icon name="skip" /></button>
        {/if}
        {#if pipOk}<button class="wpbtn" class:wpbtn--on={pip} type="button" aria-label="Picture in Picture" title="Picture in Picture" onclick={togglePip}><Icon name="pip" /></button>{/if}
        <button class="wpbtn" type="button" aria-label={full ? 'Exit full screen' : 'Full screen'} title="{full ? 'Exit full screen' : 'Full screen'} (f)" onclick={toggleFull}>
          <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
            {#if full}<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />{:else}<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />{/if}
          </svg>
        </button>
      </div>
    </div>
  </div>

  <!-- ============ always on top ============ -->
  <div class="vr-skipwrap wskipwrap" class:vr-skipwrap--low={!ctl}>
    {#if skip}
      <button class="skipchip" type="button" onclick={skipSegment} transition:fade={{ duration: 160 }} data-component="SkipChip">
        <Icon name="skip" /><span>Skip {skip.kind === 'intro' ? 'Intro' : skip.kind === 'recap' ? 'Recap' : skip.kind === 'preview' ? 'Preview' : skip.kind}</span>
      </button>
    {/if}
  </div>

  {#if upNext && !P.panel}<div class="wupnext"><UpNextCard /></div>{/if}

  {#if P.spinner && !P.loading && !P.error}
    {#if bufLong}
      <div class="pcard" role="status" data-component="PlayerStatusCard">
        <div class="pcard__row"><span class="spinner"></span><span>{waitText || 'Buffering…'}</span></div>
        {#if slowHint}<p class="pcard__hint">{slowHint}</p>{/if}
        {#if fitCap}
          <div class="pcard__actions">
            <button class="btn btn--glass btn--sm" type="button" onclick={() => (markQualityChosen(), pmSetQuality(fitCap))}><span>Switch to {fitCap / 1e6} Mbit/s</span></button>
          </div>
        {/if}
      </div>
    {:else if spinShown}
      <div class="pcard pcard--bare" role="status" aria-label="Loading"><span class="spinner spinner--lg"></span></div>
    {/if}
  {/if}

  <!-- loading card: backdrop + title + spinner until the first frame -->
  <div class="pload vr-pload" class:vr-pload--show={P.loading && !P.error} aria-hidden={!P.loading} role="status" data-component="PlayerLoading">
    <div class="pload__art art">{#if loadImg && open}<img use:decoded={loadImg} alt="" />{/if}</div>
    <div class="pload__body">
      {#if showLine}<p class="player__show">{showLine}</p>{/if}
      <h1 class="pload__title">{item.Name || ''}</h1>
      {#if loadSub}<p class="pload__sub">{loadSub}</p>{/if}
      {#if waitText}<p class="pload__sub">{waitText}</p>{/if}
      <span class="spinner spinner--lg" class:vr-still={!P.loading}></span>
    </div>
  </div>

  {#if P.error}
    <div class="pcard" role="alert" data-component="PlayerStatusCard">
      <span class="pcard__icon"><Icon name="alert" /></span>
      <p class="pcard__title">{P.error.title}</p>
      {#if P.error.detail}<p class="pcard__text">{P.error.detail}</p>{/if}
      {#if P.error.tech}<p class="pcard__hint">{P.error.tech}</p>{/if}
      <div class="pcard__actions">
        <button class="btn btn--primary btn--sm" type="button" onclick={retryPlayback}><Icon name="refresh" size="xs" /><span>Retry</span></button>
        <button class="btn btn--glass btn--sm" type="button" onclick={() => exitPlayer()}><span>Close</span></button>
      </div>
    </div>
  {/if}

  {#if busy}
    <div class="wplayer__top wplayer__top--busy">
      <button class="iconbtn" type="button" aria-label="Cancel and close" onclick={() => exitPlayer()}><Icon name="x" /></button>
    </div>
  {/if}

  {#if P.panel === 'tracks'}
    <TrackPanel initial={trackTab} onclose={closePanel} />
  {:else if P.panel === 'chapters'}
    <ChapterPanel onclose={closePanel} />
  {/if}
</div>
