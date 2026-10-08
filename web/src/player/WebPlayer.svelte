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
 *             idle timeout while playing, and we hide them when the pointer
 *             leaves the window; the cursor goes with them, but stays over a
 *             loading / error card); a click on the picture toggles pause; a
 *             double click toggles full screen (on this layer, so the
 *             controls come along); a click outside an open panel closes it
 *             (on the picture: without pausing); the wheel over the speaker
 *             sets the volume
 *   keyboard  shortcuts.js maps keys to actions (Space / K, ← → / J L, 0–9,
 *             ↑ ↓, M, C, S, Shift+N, F, P, ?, Esc); "?" lists them. Each
 *             action that changes nothing visible in the bar answers with a
 *             flash on the picture (play/pause, ∓10 s that adds up while the
 *             key repeats, volume %, the time a digit jumped to). Esc closes
 *             the shortcut list, else a panel, else leaves full screen, else
 *             the player
 *   pieces    the phone's Scrubber (trickplay while dragging, plus a hover
   *             preview here), UpNextCard, ChapterPanel, TrackPanel (as the
   *             right-hand panels), the skip chip, loading / buffering /
   *             error cards; volume slider, Picture in Picture (where the
   *             browser has it) and full screen in the bottom row. */
  import { onMount, untrack, tick, flushSync } from 'svelte';
  import { fade } from 'svelte/transition';
  import Icon from '$p/components/Icon.svelte';
  import Scrubber from '$p/player/Scrubber.svelte';
  import TrackPanel from '$p/player/TrackPanel.svelte';
  import ChapterPanel from '$p/player/ChapterPanel.svelte';
  import UpNextCard from '$p/player/UpNextCard.svelte';
  import { imgUrl, pickSize } from '$lib/api.js';
  import { fmtTime } from '$lib/format.js';
  import { decoded } from '$lib/decoded.js';
  import { SET } from '$lib/settings.svelte.js';
  import { toast } from '$lib/toast.svelte.js';
  import { describeTracks, streamByIndex } from '$lib/tracks.js';
  import { mlActivity } from '$lib/medialib.js';
  import { S } from '$lib/nav.svelte.js';
  import {
    P, setVideoEl, setPgsCanvas, showOsd, hideOsd, togglePause, seekTo, seekBy, effectivePos, trickAt,
    skipVisible, skipSegment, upNextVisible, playNext, dismissUpNext, retryPlayback, exitPlayer, closePanel, pmSetSub, pmSetQuality, QUALITY_CAPS,
    trailerId
  } from '$lib/player.svelte.js';
  import { markQualityChosen } from '../lib/net.js';
  import { holdInert, releaseInert } from '../lib/modal.svelte.js';
  import { SEEK_STEP, VOL_STEP, keyAction, shortcutRows, wheelSteps, clampVolume, loadVolume, saveVolume } from './shortcuts.js';
  import { choiceIn, panelStep, trapTab, canRefocus, routeAction } from './focusnav.js';
  import { stageClicks, fullScreenStuck, chipName } from './stage.js';

  const SPIN_DELAY = 450;

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
  /* keyboard focus (:focus-visible) rests on a control: keep the bar up too —
   * Tab never walks through invisible buttons (a mouse click's focus doesn't
   * count, or a clicked Pause would hold the bar for good) */
  let kbdIn = $state(false);
  const busy = $derived(P.loading || !!P.error);
  const ctl = $derived(open && !busy && (P.osdShown || P.paused || scrubbing || overControls || kbdIn || !!P.panel));
  const skip = $derived(open && !busy && !scrubbing ? skipVisible() : null);
  const upNext = $derived(open && !busy && upNextVisible());

  let help = $state(false); // the "?" keyboard-shortcut list
  /* The controls are `inert` while hidden, behind a loading / error card and
   * under the "?" list: Tab then reaches only what is on screen (the card's
   * Retry / Close, the list's Close). Tab itself brings hidden controls up
   * first (onTab). Never aria-hidden: that hid a focused button from screen
   * readers (Chrome: "Blocked aria-hidden on an element because its
   * descendant retained focus"). */
  const chromeOff = $derived(!ctl || help);
  let chromeEl = $state(/** @type {HTMLDivElement | null} */ (null));
  /* focus inside the controls when they go: onto the layer, before `inert`
   * would drop it on <body> */
  $effect.pre(() => {
    if (!chromeOff) return;
    untrack(() => {
      const a = document.activeElement;
      if (chromeEl && a && chromeEl.contains(a) && !help) rootEl?.focus({ preventScroll: true });
    });
  });
  /** @param {FocusEvent} e */
  function onChromeFocusIn(e) {
    const t = /** @type {HTMLElement} */ (e.target);
    kbdIn = !!t?.matches?.(':focus-visible');
    if (kbdIn) showOsd();
  }
  /** @param {FocusEvent} e */
  function onChromeFocusOut(e) {
    if (!chromeEl || !chromeEl.contains(/** @type {Node | null} */ (e.relatedTarget))) kbdIn = false;
  }

  /* Who opened the player — the Trailer or Play button, an episode row, a
   * Continue Watching tile: focus goes back there when it closes (Esc, ✕, the
   * browser's Back), else to the page's main action. The last element focused
   * or pressed outside the layer, noted as it happens: by the time `open`
   * flips, the page under the player is already inert and has lost focus. */
  /** @type {HTMLElement | null} */
  let lastOutside = null;
  onMount(() => {
    /** @param {Event} e */
    const note = (e) => {
      const t = /** @type {Element | null} */ (e.target);
      const f = t && t.closest ? /** @type {HTMLElement | null} */ (t.closest('button, a[href], input, select, [tabindex]')) : null;
      if (f && f !== document.body && !rootEl?.contains(f)) lastOutside = f;
    };
    // (keydown too: the key that opens it may come before any focusin is seen)
    const evs = ['focusin', 'pointerdown', 'keydown'];
    for (const ev of evs) document.addEventListener(ev, note, true);
    return () => {
      for (const ev of evs) document.removeEventListener(ev, note, true);
    };
  });
  /** @type {HTMLElement | null} */
  let opener = null;
  let wasOpen = false;
  $effect(() => {
    const o = open;
    untrack(() => {
      if (o && !wasOpen) {
        wasOpen = true;
        opener = lastOutside;
        // the shell (nav + pages) is inert under the player: Tab stays in it
        holdInert('player');
        // the layer takes keyboard focus (Space must not click whatever button
        // on the page had it)
        rootEl?.focus({ preventScroll: true });
      } else if (!o && wasOpen) {
        wasOpen = false;
        scrubbing = false;
        overControls = false;
        kbdIn = false;
        help = false;
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        releaseInert('player');
        const back = opener;
        opener = null;
        tick().then(() =>
          requestAnimationFrame(() => {
            if (open) return;
            const a = document.activeElement;
            if (a && a !== document.body && !rootEl?.contains(a)) return; // already placed (a new page)
            const to = canRefocus(back) ? back : routeAction(document);
            to?.focus({ preventScroll: true });
          })
        );
      }
    });
  });

  /* Focus never falls out of an open player onto <body> (a card or popover
   * unmounting under it, Retry, the controls going inert): back onto the layer. */
  function keepFocus() {
    tick().then(() => {
      const a = document.activeElement;
      if (open && rootEl && (!a || a === document.body)) rootEl.focus({ preventScroll: true });
    });
  }
  $effect(() => {
    void P.error, P.loading, P.panel, help, ctl;
    if (open) untrack(keepFocus);
  });
  /** @param {FocusEvent} e */
  function onRootFocusOut(e) {
    if (!open || (e.relatedTarget && rootEl?.contains(/** @type {Node} */ (e.relatedTarget)))) return;
    setTimeout(keepFocus, 0);
  }

  /* An error / stall card takes focus on its Retry, so Enter retries. */
  $effect(() => {
    const err = open ? P.error : null;
    if (!err) return;
    untrack(() =>
      tick().then(() => {
        if (P.error === err) /** @type {HTMLElement | null} */ (rootEl?.querySelector('.pcard [data-retry]'))?.focus({ preventScroll: true });
      })
    );
  });

  /** the TrackPanel column the open popover was asked for (its radiogroup's label) */
  const panelGroup = () => (P.panel !== 'tracks' ? undefined : trackTab === 'subs' ? 'Subtitles' : trackTab === 'quality' ? 'Streaming quality' : 'Audio');
  /* The popovers (tracks, chapters) take focus on their selected option, and
   * give it back to the chip that opened them (or the layer) when they close. */
  /** @type {HTMLElement | null} */
  let panelFrom = null;
  let panelWas = false;
  $effect(() => {
    const p = P.panel;
    untrack(() => {
      if (p && open) {
        const a = /** @type {HTMLElement | null} */ (document.activeElement);
        if (a && a.matches?.('[data-ptoggle]')) panelFrom = a;
        else if (!panelWas) panelFrom = a && rootEl?.contains(a) && !a.closest('.panel') ? a : null;
        panelWas = true;
        tick().then(() => {
          const panel = rootEl?.querySelector('.panel');
          if (P.panel === p && panel && !panel.contains(document.activeElement)) choiceIn(panel, panelGroup())?.focus();
        });
      } else if (panelWas) {
        panelWas = false;
        const back = panelFrom;
        panelFrom = null;
        tick().then(() => {
          if (!open || P.panel) return;
          const a = document.activeElement;
          if (a && a !== document.body && a !== rootEl && !a.closest('.panel')) return;
          (canRefocus(back) ? back : rootEl)?.focus({ preventScroll: true });
        });
      }
    });
  });

  /* The "?" list: focus on its Close, back where it was when it closes. */
  /** @type {HTMLElement | null} */
  let helpFrom = null;
  function openHelp() {
    const a = /** @type {HTMLElement | null} */ (document.activeElement);
    helpFrom = a && rootEl?.contains(a) && !a.closest('.wkeys') ? a : null;
    help = true;
    tick().then(() => /** @type {HTMLElement | null} */ (rootEl?.querySelector('.wkeys .closebtn'))?.focus({ preventScroll: true }));
  }
  function closeHelp() {
    help = false;
    const back = helpFrom;
    helpFrom = null;
    if (back && chromeEl?.contains(back)) showOsd(); // back onto a control: bring the bar up with it
    tick().then(() => (canRefocus(back) ? back : rootEl)?.focus({ preventScroll: true }));
  }

  /* ---------------- feedback flashes on the picture ----------------
   *   seek  ∓N s on the side it went, adding up while the key repeats
   *   icon  play / pause, as the picture was clicked or Space pressed
   *   vol   the speaker, a level bar and the % (or Muted)
   *   text  e.g. the time a digit key jumped to */
  /** @typedef {{ kind: 'seek' | 'icon' | 'vol' | 'text', side?: 'left' | 'right', total?: number, icon?: string, text?: string, n: number }} Flash */
  let flash = $state(/** @type {Flash | null} */ (null));
  let flashN = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let flashT;
  /** @param {Omit<Flash, 'n'>} f @param {number} [ms] */
  function showFlash(f, ms = 650) {
    flash = { ...f, n: ++flashN };
    clearTimeout(flashT);
    flashT = setTimeout(() => {
      flash = null;
    }, ms);
  }
  /** @param {number} sec */
  function flashSeek(sec) {
    const side = sec < 0 ? 'left' : 'right';
    const total = flash && flash.kind === 'seek' && flash.side === side ? (flash.total || 0) + sec : sec;
    showFlash({ kind: 'seek', side, total }, 800);
  }
  /* play/pause with the icon of what it does: the video's own paused flag,
   * not P.paused — play() resolves later */
  function pauseWithFlash() {
    const willPlay = !video || video.paused;
    togglePause();
    showFlash({ kind: 'icon', icon: willPlay ? 'play' : 'pause' });
  }

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
    // as wide as the window in device pixels, in the backdrop sizes the pages ask for
    const w = pickSize(window.innerWidth, [1920, 2880, 3840]);
    return imgUrl(it, 'Backdrop', { w }) || imgUrl(it, 'Thumb', { w }) || (isEp ? imgUrl(it, 'Primary', { w: 1280 }) : null);
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
    const v = loadVolume();
    if (v != null) volume = v;
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
  /** @param {number} v @param {boolean} [show] flash the level on the picture */
  function setVolume(v, show = false) {
    volume = clampVolume(v);
    if (volume > 0) muted = false;
    saveVolume(volume);
    if (show) showFlash({ kind: 'vol' });
  }
  /** @param {boolean} [show] */
  function toggleMute(show = false) {
    muted = !muted;
    if (!muted && volume === 0) setVolume(0.5);
    if (show) showFlash({ kind: 'vol' });
  }
  const volIcon = $derived(muted || volume === 0 ? 'mute' : volume < 0.5 ? 'low' : 'high');
  /* the wheel over the speaker / slider: one step per notch, or per WHEEL_PX
   * of trackpad travel (wheelSteps) — a non-passive listener, so the page
   * behind the player doesn't scroll as well */
  let volEl = $state(/** @type {HTMLDivElement | null} */ (null));
  $effect(() => {
    const el = volEl;
    if (!el) return;
    let acc = 0;
    /** @param {WheelEvent} e */
    const onWheel = (e) => {
      if (!e.deltaY) return;
      e.preventDefault();
      const w = wheelSteps(acc, e.deltaY, e.deltaMode);
      acc = w.acc;
      if (w.steps) setVolume(volume + w.steps * VOL_STEP, true);
      showOsd();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  /* ---------------- full screen, Picture in Picture ---------------- */
  let full = $state(false);
  onMount(() => {
    const on = () => (full = !!document.fullscreenElement);
    // a refusal of our own request also rejects its promise (fullFail below,
    // with the browser's reason): this one only speaks for the others
    const err = () => Date.now() - fsAskAt > 2000 && fullFail(new Error('the browser refused it'));
    document.addEventListener('fullscreenchange', on);
    document.addEventListener('fullscreenerror', err);
    return () => {
      document.removeEventListener('fullscreenchange', on);
      document.removeEventListener('fullscreenerror', err);
    };
  });
  let fsAskAt = 0;
  /* Synchronous from the key / click handler (a request after an await loses
   * the user activation, which Firefox insists on), on the whole layer so the
   * controls come along. A refusal says why in a toast, and the console has
   * the error — so a desktop where it doesn't work can tell us what happened. */
  function toggleFull() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(fullFail);
      return;
    }
    const el = rootEl;
    if (!el || typeof el.requestFullscreen !== 'function') return fullFail(new Error('this browser has no Fullscreen API'));
    if (document.fullscreenEnabled === false) return fullFail(new Error('full screen is turned off for this page'));
    fsAskAt = Date.now();
    const before = { w: window.innerWidth, h: window.innerHeight };
    el.requestFullscreen({ navigationUI: 'hide' }).then(() => {
      // a window manager can accept the request and still not make the window
      // full screen (seen as: F does nothing) — say so instead of nothing
      setTimeout(() => {
        if (document.fullscreenElement === el && fullScreenStuck(before, window, screen))
          fullFail(new Error('the browser entered full screen, but the window stayed ' + window.innerWidth + '×' + window.innerHeight + ' on a ' + screen.width + '×' + screen.height + ' screen'));
      }, 1200);
    }, fullFail);
  }
  /** @param {unknown} e */
  function fullFail(e) {
    console.warn('Full screen failed:', e);
    const why = e instanceof Error ? e.message : String((e && /** @type {any} */ (e).message) || e || '');
    toast('Full screen didn’t work' + (why ? ': ' + why : ''));
  }

  let pip = $state(false);
  /* The button (and P) only where the Picture-in-Picture API is real:
   * Chrome, and Firefox 156 (older Firefox has only its own toggle). Where we
   * have the button, the <video> carries disablePictureInPicture while not in
   * PiP: Firefox otherwise lays its "Pop out this video" toggle over the
   * picture, beside our controls. It is lifted just before our own request
   * (a request on a disabled element throws), and comes back on leaving. */
  const pipOk = typeof document !== 'undefined' && !!document.pictureInPictureEnabled && typeof HTMLVideoElement.prototype.requestPictureInPicture === 'function';
  async function togglePip() {
    if (!video) return;
    const v = video;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else {
        if (pgsActive) toast('Image subtitles (PGS) aren’t shown in Picture in Picture');
        v.disablePictureInPicture = false;
        await v.requestPictureInPicture();
      }
    } catch (e) {
      if (document.pictureInPictureElement !== v) v.disablePictureInPicture = true;
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
  /* the pointer left the window: hide the controls now rather than after the
   * idle timeout, unless they are held (paused, a panel, a drag) */
  function onLeave() {
    overControls = false;
    hover = null;
    if (open && video && !video.paused && !P.panel && !scrubbing && P.scrub == null) hideOsd();
  }
  /** @param {Element | null} el */
  const isControl = (el) => !!el?.closest?.('button, a, input, select, .scrubber, .upnext, .skipchip, .panel, .pcard, .wplayer__bar, .wplayer__top, .wkeys');
  /* a click anywhere outside an open panel closes it (its own toggles
   * excepted); on the picture the click does nothing else, on a control it
   * goes on to that control */
  /** @param {MouseEvent} e */
  function onClickOutside(e) {
    const t = /** @type {Element} */ (e.target);
    if (!open || !P.panel || t?.closest?.('.panel, [data-ptoggle]')) return;
    closePanel();
    if (!isControl(t)) e.stopPropagation();
  }
  /* A click on the picture pauses, a double click is full screen
   * (stageClicks: the pause waits out the double click, and a slow one puts
   * back the pause its own first click fired — never an earlier click's). */
  const stage = stageClicks({ pause: () => pauseWithFlash(), full: () => toggleFull(), can: () => open && !busy });
  /** @param {MouseEvent} e */
  function onStageClick(e) {
    if (!open || isControl(/** @type {Element} */ (e.target))) return;
    if (P.panel) {
      closePanel();
      return;
    }
    if (busy) return stage.cancel();
    stage.click(e.detail);
  }
  /** @param {MouseEvent} e */
  function onStageDbl(e) {
    if (!open || isControl(/** @type {Element} */ (e.target))) return;
    stage.dbl();
  }

  /* hover preview over the scrubber (the phone's shows only while dragging),
   * and a lighter fill up to the pointer (--hov on the bar, drawn by the
   * track's ::before in web.css) */
  let hover = $state(/** @type {{ x: number, w: number, l: number, at: number, f: number } | null} */ (null));
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
    hover = { x: r.left - host.left + f * r.width, w: host.width, l: host.left, at: f * P.dur, f };
  }
  const hoverTp = $derived(hover && P.trick ? trickAt(hover.at) : null);
  const HW = 240;
  /* the preview's drawn width (240 px with a trickplay frame, else just the
   * time pill or the chapter name): it is centred on the pointer and kept
   * 8 px inside the window by that, not by the frame's width */
  let trickW = $state(0);
  const hoverLeft = $derived.by(() => {
    if (!hover) return 0;
    const half = (trickW || (hoverTp ? HW : 56)) / 2;
    return Math.max(half + 8 - hover.l, Math.min(window.innerWidth - hover.l - half - 8, hover.x));
  });
  const hoverScale = $derived(P.trick ? HW / P.trick.w : 1);
  const hoverH = $derived(P.trick ? Math.round(P.trick.h * hoverScale) : 135);
  const hoverChapter = $derived.by(() => {
    if (!hover) return null;
    let c = null;
    for (const ch of P.chapters) if (ch.at <= hover.at + 0.5) c = ch;
    return c;
  });

  const nextTip = $derived.by(() => {
    const n = P.next;
    if (!n) return '';
    const code = n.IndexNumber != null ? (n.ParentIndexNumber != null ? 'S' + n.ParentIndexNumber + ' · ' : '') + 'E' + n.IndexNumber : '';
    return 'Next: ' + [code, n.Name].filter(Boolean).join(' · ') + ' (Shift+N)';
  });

  /* the bar's clock: elapsed, or (a click on it) time left */
  let remain = $state(false);
  const shownPos = $derived(P.scrub ?? P.pos);

  /* ---------------- keyboard ---------------- */
  const LIST_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
  /* Tab: inside the "?" list it stays there; elsewhere it first brings hidden
   * controls up (and takes their `inert` off) so focus lands on something
   * visible — synchronously, before the browser moves focus. */
  /** @param {KeyboardEvent} e */
  function onTab(e) {
    if (help) {
      const card = rootEl?.querySelector('.wkeys__card');
      const to = card && trapTab(card, /** @type {Element} */ (e.target), e.shiftKey);
      e.preventDefault();
      to?.focus({ preventScroll: true });
      return;
    }
    if (busy) return; // the card's buttons and Close are the stops; the controls stay inert
    showOsd();
    if (!ctl) flushSync();
  }

  /** @param {KeyboardEvent} e */
  function onKey(e) {
    if (!open || e.defaultPrevented) return;
    const t = /** @type {HTMLElement} */ (e.target);
    const mods = e.ctrlKey || e.metaKey || e.altKey;
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) return onTab(e);
    if (t && (t.tagName === 'INPUT' && /** @type {HTMLInputElement} */ (t).type !== 'range')) return;
    /** @param {() => void} fn */
    const take = (fn) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    // the volume slider keeps its own ← → Home End (in volume steps, with the flash)
    if (!mods && t?.classList?.contains('wvol__range') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key))
      return take(() => (setVolume(e.key === 'Home' ? 0 : e.key === 'End' ? 1 : volume + (e.key === 'ArrowRight' ? VOL_STEP : -VOL_STEP), true), showOsd()));
    // the position slider: Home / End (← → seek everywhere)
    if (!mods && !busy && P.dur && t?.classList?.contains('vr-scrub__hit') && (e.key === 'Home' || e.key === 'End'))
      return take(() => (seekTo(e.key === 'Home' ? 0 : Math.max(0, P.dur - SEEK_STEP)), showOsd()));
    // a popover: the arrows, Home and End move through its options (↑ ↓ from
    // its own chip or the picture go into it); Space / Enter choose one
    const panel = P.panel ? rootEl?.querySelector('.panel') : null;
    if (panel && !mods && LIST_KEYS.includes(e.key)) {
      const inside = panel.contains(t);
      const intoIt = !inside && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && (t === rootEl || !!t?.matches?.('[data-ptoggle]'));
      if (inside || intoIt) {
        const to = inside ? panelStep(panel, t, e.key) : choiceIn(panel, panelGroup());
        if (to) return take(() => (to.focus(), showOsd()));
        if (inside && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return take(() => {}); // at the end of the list: stay
      }
    }
    const a = keyAction(e);
    if (!a) return;
    // Space on a button of a card, the list, a popover, Up Next or the skip
    // chip is that button's; from the bar or the picture it pauses
    if (a.act === 'pause' && e.key === ' ' && t?.closest?.('.panel, .wkeys, .pcard, .upnext, .skipchip, .wpip')) return;
    const live = !P.error && !P.loading;
    const arg = a.arg || 0;
    /** @type {(() => void) | null} */
    let act = null;
    switch (a.act) {
      case 'close':
        act = () => {
          if (help) closeHelp();
          else if (P.panel) closePanel();
          else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
          else if (upNext) dismissUpNext();
          else exitPlayer();
        };
        break;
      case 'pause': // a focused bar button would also click on Space: the key is ours
        if (live) act = pauseWithFlash;
        break;
      case 'seek':
        if (live) act = () => (seekBy(arg), flashSeek(arg));
        break;
      case 'jump':
        if (live && P.dur) act = () => (seekTo(arg * P.dur), showFlash({ kind: 'text', text: fmtTime(arg * P.dur) }));
        break;
      case 'volume':
        act = () => setVolume(volume + arg, true);
        break;
      case 'mute':
        act = () => toggleMute(true);
        break;
      case 'subs':
        if (live && hasSubs) act = toggleSubs;
        break;
      case 'skip':
        if (skip) act = skipSegment;
        break;
      case 'full':
        act = toggleFull;
        break;
      case 'pip':
        if (pipOk && live) act = togglePip;
        break;
      case 'next':
        if (P.next && !P.trailer) act = () => playNext(true);
        break;
      case 'help':
        act = () => (help ? closeHelp() : openHelp());
        break;
    }
    if (!act) return;
    take(act);
  }

  /* the "?" list names only the keys that do something now */
  const keyRows = $derived(shortcutRows({ pip: pipOk, skip: !P.trailer && P.skips.length > 0, next: !!P.next && !P.trailer, subs: hasSubs }));

  /* the position slider is a Tab stop here (the phone's is touch-only): ← →
   * seek, Home / End, and its aria-valuetext reads "0:42 of 1:52:10" */
  $effect(() => {
    const hit = /** @type {HTMLElement | null} */ (chromeEl?.querySelector('.vr-scrub__hit'));
    if (hit) hit.tabIndex = 0;
  });

  /* error card: what failed, and for a trailer the way to it on YouTube (a
   * link — a fresh click — never a popup the browser may block) */
  const errLine = $derived(
    P.trailer ? ['Trailer', item.Name].filter(Boolean).join(' · ') : isEp ? [item.SeriesName, epCode, item.Name].filter(Boolean).join(' · ') : [item.Name, item.ProductionYear].filter(Boolean).join(' · ')
  );
  const ytHref = $derived.by(() => {
    if (!P.error || !P.trailer) return null;
    const id = trailerId();
    return id ? 'https://www.youtube.com/watch?v=' + encodeURIComponent(id) : null;
  });
</script>

<svelte:window onkeydowncapture={onKey} />

<div
  class="wplayer"
  class:wplayer--ctl={ctl}
  class:wplayer--full={full}
  class:wplayer--trailer={P.trailer}
  class:wplayer--pointer={busy || help}
  hidden={!open}
  bind:this={rootEl}
  tabindex="-1"
  role="application"
  aria-label="Video player"
  style:--sub-scale={(SET.subSize || 100) / 100}
  onpointermove={onMove}
  onpointerleave={onLeave}
  onclickcapture={onClickOutside}
  onfocusout={onRootFocusOut}
  data-component="WebPlayer"
>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="wplayer__stage" onclick={onStageClick} ondblclick={onStageDbl}>
    <!-- svelte-ignore a11y_media_has_caption -->
    <video class="wplayer__video" class:wplayer__video--dim={!!P.panel} class:wplayer__video--pip={pip} tabindex="-1" playsinline preload="auto" disablepictureinpicture={pipOk && !pip} bind:this={video}></video>
    <canvas class="vr-pgs" bind:this={canvas}></canvas>
    <div class="vr-subs-top" bind:this={subsTopEl}></div>
    <div class="vr-subs" class:vr-subs--raised={ctl} bind:this={subsEl}></div>
  </div>

  {#if flash && !busy}
    {#if flash.kind === 'seek'}
      <div class="wflash wflash--{flash.side}" role="status" aria-label="{(flash.total || 0) < 0 ? 'Back' : 'Forward'} {Math.abs(flash.total || 0)} seconds" out:fade={{ duration: 200 }}>
        {#key flash.n}
          <span class="seekflash__chev vr-chevwave" class:vr-flip={flash.side === 'left'}><Icon name="play" fill /><Icon name="play" fill /><Icon name="play" fill /></span>
        {/key}
        <span class="wflash__text">{(flash.total || 0) < 0 ? '−' : '+'}{Math.abs(flash.total || 0)} s</span>
      </div>
    {:else}
      {#key flash.n}
        <div class="wflash wflash--{flash.kind}" role="status" out:fade={{ duration: 200 }}>
          {#if flash.kind === 'icon'}
            <Icon name={flash.icon || 'play'} fill />
          {:else if flash.kind === 'vol'}
            {@render speaker(volIcon)}
            <span class="wflash__level" style="--v: {muted ? 0 : volume}"></span>
            <span class="wflash__text">{muted ? 'Muted' : Math.round(volume * 100) + ' %'}</span>
          {:else}
            <span class="wflash__text">{flash.text}</span>
          {/if}
        </div>
      {/key}
    {/if}
  {/if}

  <!-- ============ controls ============ -->
  <div class="wplayer__chrome" class:wplayer__chrome--hidden={!ctl} inert={chromeOff || undefined} bind:this={chromeEl} onfocusin={onChromeFocusIn} onfocusout={onChromeFocusOut}>
    <div class="player__scrim player__scrim--top"></div>
    <div class="player__scrim player__scrim--bottom"></div>
    <div class="wplayer__top" onpointerenter={() => (overControls = true)} onpointerleave={() => (overControls = false)} role="toolbar" tabindex="-1">
      <button class="iconbtn" type="button" aria-label={P.trailer ? 'Close trailer' : 'Close player'} data-tip="Close (Esc)" onclick={() => exitPlayer()}><Icon name="chevron-left" /></button>
      <div class="player__titles">
        {#if showLine}<p class="player__show">{showLine}</p>{/if}
        <p class="player__ep">{epLine}</p>
      </div>
      <button class="iconbtn wkeysbtn" type="button" aria-label="Keyboard shortcuts" data-tip="Keyboard shortcuts (?)" aria-haspopup="dialog" aria-expanded={help} onclick={() => (help ? closeHelp() : openHelp())}>?</button>
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
      class:wplayer__bar--hover={!!hover && !scrubbing}
      style:--hov={hover ? hover.f : 0}
    >
      {#if hover && !scrubbing}
        <div class="trick wtrick" style="left: {hoverLeft}px" bind:offsetWidth={trickW}>
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
        <button class="wpbtn" type="button" aria-label={P.paused ? 'Play' : 'Pause'} data-tip={P.paused ? 'Play (K)' : 'Pause (K)'} onclick={() => togglePause()}><Icon name={P.paused ? 'play' : 'pause'} /></button>
        <button class="wpbtn" type="button" aria-label="Back {SEEK_STEP} seconds" data-tip="Back {SEEK_STEP} s (←)" onclick={() => seekBy(-SEEK_STEP)}><Icon name="back-10" /></button>
        <button class="wpbtn" type="button" aria-label="Forward {SEEK_STEP} seconds" data-tip="Forward {SEEK_STEP} s (→)" onclick={() => seekBy(SEEK_STEP)}><Icon name="fwd-10" /></button>
        <div class="wvol" bind:this={volEl}>
          <button class="wpbtn" type="button" aria-label={muted ? 'Unmute' : 'Mute'} data-tip="{muted ? 'Unmute' : 'Mute'} (M)" onclick={() => toggleMute()}>
            {@render speaker(volIcon)}
          </button>
          <input
            class="wvol__range"
            type="range"
            min="0"
            max="100"
            step="1"
            aria-label="Volume"
            aria-valuetext={muted ? 'Muted' : Math.round(volume * 100) + ' %'}
            value={muted ? 0 : Math.round(volume * 100)}
            style="--v: {muted ? 0 : volume}"
            oninput={(e) => setVolume(Number(e.currentTarget.value) / 100)}
          />
        </div>
        <button class="wplayer__time" type="button" data-tip={remain ? 'Show time played' : 'Show time left'} onclick={() => (remain = !remain)}>
          {remain ? '−' + fmtTime(Math.max(0, (P.dur || 0) - shownPos)) : fmtTime(shownPos)} <span class="wplayer__dur">/ {fmtTime(P.dur)}</span>
        </button>
        <span class="player__spacer"></span>
        {#if P.chapters.length && !P.trailer}
          <button class="pchip" class:pchip--on={P.panel === 'chapters'} type="button" data-ptoggle data-tip="Chapters" aria-haspopup="dialog" aria-expanded={P.panel === 'chapters'} onclick={openChapters}><Icon name="chapters" />Chapters</button>
        {/if}
        {#if hasAudioChoice}
          <button class="pchip" class:pchip--on={P.panel === 'tracks' && trackTab === 'audio'} type="button" data-ptoggle data-tip="Audio track" aria-label={chipName('Audio', audioChip)} aria-haspopup="dialog" aria-expanded={P.panel === 'tracks' && trackTab === 'audio'} onclick={() => openTracks('audio')}><Icon name="audio" />{audioChip.main} {#if audioChip.dim}<span class="pchip__dim">{audioChip.dim}</span>{/if}</button>
        {/if}
        {#if hasSubs}
          <button class="pchip" class:pchip--on={P.panel === 'tracks' && trackTab === 'subs'} type="button" data-ptoggle data-tip="Subtitles (C on / off)" aria-label={chipName('Subtitles', subChip)} aria-haspopup="dialog" aria-expanded={P.panel === 'tracks' && trackTab === 'subs'} onclick={() => openTracks('subs')}><Icon name="subtitles" />{subChip.main} {#if subChip.dim}<span class="pchip__dim">{subChip.dim}</span>{/if}</button>
        {/if}
        {#if quality}
          <button class="pchip" class:pchip--on={P.panel === 'tracks' && trackTab === 'quality'} type="button" data-ptoggle data-tip="Streaming quality" aria-haspopup="dialog" aria-expanded={P.panel === 'tracks' && trackTab === 'quality'} aria-label="Streaming quality: {quality.label}" onclick={() => openTracks('quality')}><Icon name="settings" />{quality.reduced ? quality.res || 'Reduced' : 'Original'} <span class="pchip__dim">{quality.reduced ? quality.mbit + ' Mbit/s' : 'fits ' + quality.mbit + ' Mbit/s'}</span></button>
        {/if}
        {#if P.next && !P.trailer}
          <button class="wpbtn" type="button" aria-label="Next episode" data-tip={nextTip} onclick={() => playNext(true)}><Icon name="skip" /></button>
        {/if}
        {#if pipOk}<button class="wpbtn" class:wpbtn--on={pip} type="button" aria-label="Picture in Picture" data-tip={pip ? 'Leave Picture in Picture (P)' : 'Picture in Picture (P)'} onclick={togglePip}><Icon name="pip" /></button>{/if}
        <button class="wpbtn" type="button" aria-label={full ? 'Exit full screen' : 'Full screen'} data-tip="{full ? 'Exit full screen' : 'Full screen'} (F)" onclick={toggleFull}>
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
      <button class="skipchip" type="button" data-tip="Shortcut: S" onclick={skipSegment} transition:fade={{ duration: 160 }} data-component="SkipChip">
        <Icon name="skip" /><span>Skip {skip.kind === 'intro' ? 'Intro' : skip.kind === 'recap' ? 'Recap' : skip.kind === 'preview' ? 'Preview' : skip.kind}</span>
      </button>
    {/if}
  </div>

  {#if upNext && !P.panel}<div class="wupnext"><UpNextCard /></div>{/if}

  {#if pip && open}
    <!-- the picture plays in its own window: say so here, where the browser
         would draw its grey "Playing in picture-in-picture" under our title -->
    <div class="wpip" role="status" data-component="PipCard">
      <Icon name="pip" />
      <p class="wpip__title">Playing in Picture in Picture</p>
      <button class="btn btn--glass btn--sm" type="button" onclick={togglePip}><span>Back to this tab</span></button>
    </div>
  {/if}

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
      {#if errLine}<p class="pcard__eyebrow">{errLine}</p>{/if}
      <p class="pcard__title">{P.error.title}</p>
      {#if P.error.detail}<p class="pcard__text">{P.error.detail}</p>{/if}
      {#if P.error.tech}<p class="pcard__hint">{P.error.tech}</p>{/if}
      <div class="pcard__actions">
        <button class="btn btn--primary btn--sm" type="button" data-retry onclick={retryPlayback}><Icon name="refresh" size="xs" /><span>Retry</span></button>
        {#if ytHref}<a class="btn btn--glass btn--sm" href={ytHref} target="_blank" rel="noopener noreferrer"><span>Open on YouTube</span></a>{/if}
        <button class="btn btn--glass btn--sm" type="button" onclick={() => exitPlayer()}><span>Close</span></button>
      </div>
    </div>
  {/if}

  {#if busy}
    <div class="wplayer__top wplayer__top--busy">
      <!-- while a card is up it has its own Close (the keyboard's stop): this one
           is the pointer's, named like the top bar's, nothing left to cancel -->
      <button class="iconbtn" type="button" aria-label={P.error ? (P.trailer ? 'Close trailer' : 'Close player') : 'Cancel and close'} tabindex={P.error ? -1 : undefined} data-tip="Close (Esc)" onclick={() => exitPlayer()}><Icon name="x" /></button>
    </div>
  {/if}

  {#if P.panel === 'tracks'}
    <TrackPanel initial={trackTab} onclose={closePanel} />
  {:else if P.panel === 'chapters'}
    <ChapterPanel onclose={closePanel} />
  {/if}

  {#if help}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="wkeys" onclick={(e) => e.target === e.currentTarget && closeHelp()} transition:fade={{ duration: 120 }}>
      <div class="wkeys__card" role="dialog" aria-modal="true" aria-labelledby="wkeys-title" data-component="ShortcutList">
        <div class="wkeys__head">
          <h2 class="wkeys__title" id="wkeys-title">Keyboard shortcuts</h2>
          <button class="closebtn" type="button" aria-label="Close" onclick={closeHelp}><Icon name="x" size="sm" /></button>
        </div>
        <dl class="wkeys__list">
          {#each keyRows as [keys, what] (what)}
            <div class="wkeys__row">
              <dt>
                {#each keys as k, i (k)}{#if i}<span class="wkeys__or">/</span>{/if}{#each k.split('+') as part, j (j)}{#if j}<span class="wkeys__plus">+</span>{/if}<kbd>{part}</kbd>{/each}{/each}
              </dt>
              <dd>{what}</dd>
            </div>
          {/each}
        </dl>
      </div>
    </div>
  {/if}
</div>

{#snippet speaker(/** @type {string} */ kind)}
  <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" />
    {#if kind === 'mute'}<path d="M16 9.5l5 5M21 9.5l-5 5" />
    {:else if kind === 'low'}<path d="M15.5 9.5a3.5 3.5 0 0 1 0 5" />
    {:else}<path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10" />{/if}
  </svg>
{/snippet}
