<script>
  /* The phone player — a full-screen modal over the tab stacks, mounted for the
   * whole session and shown while the engine has the player up (S.screen ===
   * 'player', which the nav shim mirrors into R.modal). Like the TV's
   * VideoLayer it owns the one <video> element and the PGS canvas and hands
   * both to the engine (setVideoEl / setPgsCanvas): the element must survive
   * across playbacks (libpgs holds it, and iOS keeps its "user started media"
   * unlock on the element).
   *
   * Everything playback-related is the engine's (src/lib/player.svelte.js):
   * this file maps touch onto it. One DOM for both orientations — the stage
   * holding the video is the same node in portrait (16:9 box at the top, info
   * below) and landscape (full screen), so rotating never reloads the video.
   *
   * Gestures on the stage: tap = controls on at once when hidden (a second
   * tap within 300 ms on the same half turns it into a double tap and drops
   * them again); off after 300 ms when shown (so a double tap doesn't flash
   * them); double tap on a half = −/+10 s, further taps within 700 ms
   * add 10 s each and one seek goes out when they stop; vertical swipe down
   * with the controls hidden = an interactive dismiss (the video shrinks and
   * follows the finger, the page shows through); pinch (landscape) = fit ↔ fill.
   *
   * Present / dismiss (PLY-01): the element stays displayed (`shown`) for a
   * short fade after the engine closes the modal, and our own close paths (X,
   * busy-X, Esc, swipe) animate out first and call exitPlayer() at the end.
   * App's .playerhost is a transparent, click-through box. */
  import { onMount, tick, untrack } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import Icon from '$p/components/Icon.svelte';
  import { DUR, EASE, easeOut, springEase, spring, reducedMotion } from '$p/lib/safe.js';
  import Scrubber from './Scrubber.svelte';
  import TrackPanel from './TrackPanel.svelte';
  import ChapterPanel from './ChapterPanel.svelte';
  import UpNextCard from './UpNextCard.svelte';
  import { S } from '$lib/nav.svelte.js';
  import { imgUrl } from '$lib/api.js';
  import { fmtTime, fmtRuntime } from '$lib/format.js';
  import { decoded } from '$lib/decoded.js';
  import { SET } from '$lib/settings.svelte.js';
  import { toast } from '$lib/toast.svelte.js';
  import { describeTracks, streamByIndex } from '$lib/tracks.js';
  import { mlActivity } from '$lib/medialib.js';
  import {
    P, setVideoEl, setPgsCanvas, showOsd, hideOsd, togglePause, seekTo, seekBy, effectivePos,
    skipVisible, skipSegment, upNextVisible, playNext, retryPlayback, exitPlayer, closePanel,
    getQualityCap, pmSetQuality, QUALITY_CAPS
  } from '$lib/player.svelte.js';

  const SEEK_STEP = 10;      // the design's ⏪10 / ⏩10 and double-tap step
  const TAP_WAIT = 300;      // single vs double tap
  const RUN_WAIT = 700;      // a double-tap run keeps adding within this
  const SWIPE_CLOSE = 110;   // px down to close (or a flick: > 0.5 px/ms past 24 px)
  const SPIN_DELAY = 450;    // a `waiting` shorter than this shows no ring (AVKit waits ~0.5 s)

  let video = $state(null);
  let canvas = $state(null);
  $effect(() => setVideoEl(video));
  $effect(() => setPgsCanvas(canvas));
  /* PGS: while a PGS track is on, the canvas is a full-screen layer for the
   * whole film (the engine shows it with display: block), though most of the
   * time it holds no subtitle. libpgs draws through this canvas's one 2d
   * context: clearRect of the last cue, then putImageData of the next, in the
   * same task. A clear with no draw after it in that task means nothing is on
   * screen — hide the canvas (visibility takes its layer out) until the next
   * draw. Wrapped on the context, so libpgs itself stays untouched. */
  $effect(() => {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx || ctx._vrWrapped) return;
    ctx._vrWrapped = true;
    const put = ctx.putImageData;
    const clear = ctx.clearRect;
    let drawn = 0;
    ctx.putImageData = function (...a) {
      drawn++;
      canvas.style.visibility = '';
      return put.apply(this, a);
    };
    ctx.clearRect = function (...a) {
      const at = drawn;
      queueMicrotask(() => {
        if (drawn === at) canvas.style.visibility = 'hidden';
      });
      return clear.apply(this, a);
    };
  });

  // App.svelte passes R.modal === 'player'; the engine's S.screen says the same
  let { open: openProp = false } = $props();
  const open = $derived(openProp || S.screen === 'player');

  /* ---------------- present / dismiss (PLY-01, PLY-02) ----------------
   * `shown` keeps the element displayed while it fades out after the engine
   * closed the modal (end of film, an Up Next failure, openItem elsewhere):
   * the video is emptied at once, so that is a short dip from black to the
   * page instead of a cut. Our own closes animate first and then call
   * exitPlayer() — the video keeps playing through the animation (pausing
   * first would send a progress report after the Stopped). */
  let playerEl = $state(null);
  let dimEl = $state(null);
  let shown = $state(false);
  let closing = $state(false);   // fading out / dismissing: click-through
  let dismissing = false;        // our own dismiss ran; exitPlayer() follows
  let anims = [];                // our WAAPI animations on the player, to cancel

  function track(a) {
    if (a) anims.push(a);
    return a;
  }
  function resetMotion() {
    for (const a of anims) {
      try {
        a.cancel();
      } catch {}
    }
    anims = [];
    for (const el of [playerEl, stageEl, dimEl]) {
      if (!el) continue;
      el.style.transform = '';
      el.style.opacity = '';
      el.style.backgroundColor = '';
      el.style.borderRadius = '';
    }
  }

  function present() {
    resetMotion();
    dismissing = false;
    closing = false;
    shown = true;
    tick().then(() => {
      if (!open || !playerEl) return;
      if (reducedMotion()) {
        track(playerEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR.rm, easing: 'linear' }));
        return;
      }
      track(playerEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DUR.base, easing: EASE.out }));
      // the backdrop dissolves in, the title settles into place
      const body = playerEl.querySelector('.vr-pload--show .pload__body');
      if (body)
        track(body.animate([{ opacity: 0, scale: '0.97' }, { opacity: 1, scale: '1' }], {
          duration: DUR.sheetOut, delay: 40, easing: EASE.out, fill: 'backwards'
        }));
    });
  }

  function hideNow() {
    shown = false;
    closing = false;
    dismissing = false;
    // after the element is display:none, so the reset can't flash a frame
    tick().then(() => {
      if (!open) resetMotion();
    });
  }

  // engine-initiated close: fade the (already emptied) player onto the page
  function fadeAway() {
    if (dismissing || !playerEl) return hideNow();
    closing = true;
    const from = getComputedStyle(playerEl).opacity;
    const a = track(playerEl.animate([{ opacity: from }, { opacity: 0 }], { duration: DUR.fast, easing: EASE.in, fill: 'forwards' }));
    a.onfinish = () => {
      if (!open) hideNow();
    };
  }

  $effect(() => {
    const o = open;
    untrack(() => {
      if (o) present();
      else if (shown) fadeAway();
    });
  });

  /* Our own close (X, busy-X, Esc): landscape = the stage shrinks and fades
   * onto the page; portrait = the card drops a little and fades. */
  function dismiss() {
    if (dismissing || !open) return;
    if (!playerEl || !stageEl) return exitPlayer();
    dismissing = true;
    closing = true;
    const done = () => {
      if (open) exitPlayer();
      else hideNow();
    };
    let a;
    if (reducedMotion()) {
      a = playerEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DUR.rm, easing: 'linear', fill: 'forwards' });
    } else if (portrait) {
      a = playerEl.animate([{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(6%)', opacity: 0 }], {
        duration: DUR.base, easing: EASE.in, fill: 'forwards'
      });
    } else {
      track(stageEl.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.94)' }], { duration: DUR.base, easing: EASE.in, fill: 'forwards' }));
      a = playerEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DUR.base, easing: EASE.in, fill: 'forwards' });
    }
    track(a).onfinish = done;
  }

  /* ---------------- orientation ---------------- */
  let portrait = $state(false);
  onMount(() => {
    const mq = matchMedia('(orientation: portrait)');
    const upd = () => (portrait = mq.matches);
    upd();
    mq.addEventListener('change', upd);
    return () => mq.removeEventListener('change', upd);
  });

  /* ---------------- state ---------------- */
  let locked = $state(false);
  let lockPill = $state(false);
  let lockT = 0;
  let scrubbing = $state(false);
  let fill = $state(false);
  let trackTab = $state('audio');
  let overviewOpen = $state(false);

  // a new playback starts unlocked, fitted, with no panel
  $effect(() => {
    if (!open) {
      locked = false;
      lockPill = false;
      fill = false;
      scrubbing = false;
      overviewOpen = false;
    }
  });

  const busy = $derived(P.loading || !!P.error);
  const ctl = $derived(open && !locked && !busy && !P.panel && (P.osdShown || P.paused || scrubbing));
  // not while a finger scrubs: the raised chip sat on the trickplay preview
  const skip = $derived(open && !locked && !busy && !scrubbing ? skipVisible() : null);
  const upNext = $derived(open && !busy && upNextVisible());

  /* ---------------- titles ---------------- */
  const item = $derived(P.loadingItem || P.detailItem || P.item || {});
  const isEp = $derived(item.Type === 'Episode');
  const epCode = $derived(isEp ? 'S' + (item.ParentIndexNumber ?? 0) + ' · E' + (item.IndexNumber ?? 0) : '');
  const showLine = $derived(P.trailer ? 'Trailer' : isEp ? item.SeriesName || '' : item.ProductionYear ? String(item.ProductionYear) : '');
  const epLine = $derived(P.trailer ? item.Name || '' : isEp ? [epCode, item.Name].filter(Boolean).join(' · ') : item.Name || '');

  /* ---------------- tracks (chips) ---------------- */
  const tracks = $derived(describeTracks(P.source, P.detailItem));
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

  function openTracks(tab) {
    trackTab = tab;
    P.panel = 'tracks';
    showOsd();
  }
  function openChapters() {
    P.panel = 'chapters';
    showOsd();
  }
  function closePanels() {
    closePanel();
  }

  /* ---------------- loading card ---------------- */
  const loadImg = $derived.by(() => {
    const it = item;
    if (it && it._art) return it._art;
    if (!it || !it.Id) return null;
    return imgUrl(it, 'Backdrop', { w: 1280 }) || imgUrl(it, 'Thumb', { w: 1280 }) || (isEp ? imgUrl(it, 'Primary', { w: 1280 }) : null);
  });
  const loadSub = $derived(
    [P.trailer ? '' : epCode, P.loadingFrom > 30 ? 'resuming at ' + fmtTime(P.loadingFrom) : ''].filter(Boolean).join(' · ')
  );

  /* ---------------- buffering ---------------- */
  let bufLong = $state(false);
  $effect(() => {
    bufLong = false;
    if (!P.spinner || P.loading || P.error) return;
    const t = setTimeout(() => (bufLong = true), 3000);
    return () => clearTimeout(t);
  });
  /* PLY-08: the engine raises P.spinner on every `waiting`, which Safari fires
   * on most seeks even when the data is there 100–200 ms later — the bare
   * ring only shows once a wait has lasted SPIN_DELAY. (The stall watchdog's
   * own ring comes after 2 s anyway; the Buffering card after 3 s.) */
  let spinShown = $state(false);
  $effect(() => {
    spinShown = false;
    if (!P.spinner || P.loading || P.error) return;
    const t = setTimeout(() => (spinShown = true), SPIN_DELAY);
    return () => clearTimeout(t);
  });
  /* A download watched while it comes in (P.pending + P.downloadId) waits at
   * the download frontier, not on the network: say so with the grab's live %
   * (the TV's VideoLayer wording). Polled only while the ring/card is up. */
  let waitPct = $state(null);
  let waitGone = $state(null);
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
  /* The slow-link hint compares against what the stream runs at — the file's
   * bitrate, or the cap when the server re-encodes to it (P.quality). The card
   * offers the highest quality cap below that the measured link carries, as a
   * one-tap switch (pmSetQuality: restart at the same position, and it sticks
   * like the Settings choice). None when even 4 Mbit/s is too much. */
  const fitCap = $derived.by(() => {
    const sn = P.slowNet;
    if (!sn || P.pending || P.trailer) return 0;
    return QUALITY_CAPS.find((c) => c !== 'original' && c / 1e6 < sn.need && c / 1e6 <= sn.got) || 0;
  });
  const slowHint = $derived.by(() => {
    const sn = P.slowNet;
    if (!sn) return '';
    return (P.quality && P.quality.reduced ? 'This stream needs about ' : 'This file needs about ') + sn.need + ' Mbit/s; the phone is getting about ' + sn.got + '.' +
      (fitCap ? '' : sn.got < 4 && !P.pending && !P.trailer ? ' That’s too slow even for 4 Mbit/s.' : '');
  });
  // the quality line (portrait info, landscape chip) — only while a cap is on
  const quality = $derived(!P.pending && !P.trailer && P.quality ? P.quality : null);

  /* ---------------- controls: tap, double tap, swipe, pinch ---------------- */
  let stageEl = $state(null);
  let flash = $state(null);       // { side, total, n, rx, ry } for the seek feedback
  let run = null;                 // { side, total, base, t }
  let runT = 0;
  let flashT = 0;
  let flashN = 0;                 // per-tap counter: restarts the ripple / chevron wave
  let single = null;              // pending single tap { t, x, side, timer, shownByTap }
  let drag = null;                // { id, x, y, vertical, moved, v, ly, lt, dx, dy }
  let dragFrame = 0;
  let justShown = $state(false);  // controls just raised by a tap: not hittable yet
  let justT = 0;

  function isControl(el) {
    return !!(el && el.closest && el.closest('button, a, input, .scrubber, .upnext, .skipchip, .lockpill, .panel, .sheet, .pcard, .vr-noswipe'));
  }

  function toggleControls() {
    if (locked) return showLockPill();
    if (P.panel) return closePanels();
    if (ctl && !P.paused) hideOsd();
    else showOsd();
  }

  function showLockPill() {
    lockPill = true;
    clearTimeout(lockT);
    lockT = setTimeout(() => (lockPill = false), 2000);
  }

  function seekRun(side, x, y) {
    const dir = side === 'left' ? -1 : 1;
    const now = Date.now();
    if (!run || run.side !== side || now - run.t > RUN_WAIT) run = { side, total: 0, base: effectivePos(), t: now };
    run.total += dir * SEEK_STEP;
    run.t = now;
    // the ripple's centre, in the half-moon's own box (38 % of the stage, at its side)
    let rx = 0;
    let ry = 0;
    if (stageEl && x != null) {
      const r = stageEl.getBoundingClientRect();
      rx = x - r.left - (side === 'right' ? r.width * 0.62 : 0);
      ry = y - r.top;
    }
    flash = { side, total: run.total, n: ++flashN, rx, ry };
    clearTimeout(runT);
    clearTimeout(flashT);
    // one real seek per run — seeking the HLS remux restarts it on the server
    runT = setTimeout(() => {
      const r = run;
      if (!r) return;
      P.skipped = null;
      seekTo(r.base + r.total, true);
    }, 450);
    flashT = setTimeout(() => {
      flash = null;
      run = null;
    }, RUN_WAIT);
  }

  // the seek amount acknowledges each tap with a small pop (PLY-10)
  function bump() {
    if (reducedMotion()) return { duration: 0 };
    return { duration: DUR.fast, easing: springEase.bouncy, css: (t) => `transform: scale(${1.14 - 0.14 * t})` };
  }

  /* ---- swipe down: an interactive dismiss (PLY-02) ----
   * Transforms are written straight to the elements (one write per frame),
   * never through $state. Landscape: the stage follows the finger and shrinks
   * toward 0.7, the black behind it thins out, so the page shows through.
   * Portrait: the whole player moves like a card over the dimmed page. */
  function dragP(dy) {
    return Math.min(1, Math.max(0, dy / (0.6 * (playerEl ? playerEl.clientHeight : innerHeight))));
  }
  function dragStyle(dx, dy) {
    const p = dragP(dy);
    const still = reducedMotion();   // follow 1:1, no scale
    if (portrait) {
      playerEl.style.transform = `translate3d(0, ${dy}px, 0)`;
      playerEl.style.borderRadius = '12px 12px 0 0';
      if (dimEl) dimEl.style.opacity = String(1 - p);
    } else {
      stageEl.style.transform = still ? `translate3d(0, ${dy}px, 0)` : `translate3d(${dx * 0.35}px, ${dy}px, 0) scale(${1 - 0.3 * p})`;
      playerEl.style.backgroundColor = `rgba(0, 0, 0, ${1 - 0.85 * p})`;
    }
  }
  function queueDrag() {
    if (dragFrame) return;
    dragFrame = requestAnimationFrame(() => {
      dragFrame = 0;
      if (drag && drag.vertical) dragStyle(drag.dx, drag.dy);
    });
  }
  function swipeGate() {
    // only with the chrome down (a drag over visible controls is aiming at
    // them), never locked, with a panel or an error up; in portrait only
    // while the info column is scrolled to the top
    return !ctl && !locked && !P.panel && !P.error && !dismissing && !(portrait && playerEl && playerEl.scrollTop > 0);
  }
  function swipeRelease(d) {
    const dy = d.dy;
    const H = playerEl.clientHeight;
    if (dy > SWIPE_CLOSE || (d.v > 0.5 && dy > 24)) {
      // away: on from where the finger left it, then exitPlayer()
      dismissing = true;
      closing = true;
      let a;
      if (reducedMotion()) {
        a = playerEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DUR.rm, easing: 'linear', fill: 'forwards' });
      } else if (portrait) {
        a = playerEl.animate(
          [{ transform: `translate3d(0, ${dy}px, 0)`, opacity: 1 }, { transform: `translate3d(0, ${dy + 0.25 * H}px, 0)`, opacity: 0 }],
          { duration: DUR.fast, easing: EASE.in, fill: 'forwards' }
        );
        if (dimEl) track(dimEl.animate([{ opacity: getComputedStyle(dimEl).opacity }, { opacity: 0 }], { duration: DUR.fast, easing: EASE.in, fill: 'forwards' }));
      } else {
        const p = dragP(dy);
        track(stageEl.animate(
          [{ transform: `translate3d(${d.dx * 0.35}px, ${dy}px, 0) scale(${1 - 0.3 * p})`, opacity: 1 },
           { transform: `translate3d(${d.dx * 0.35}px, ${dy + 0.25 * H}px, 0) scale(0.6)`, opacity: 0 }],
          { duration: DUR.fast, easing: EASE.in, fill: 'forwards' }
        ));
        a = playerEl.animate([{ backgroundColor: `rgba(0, 0, 0, ${1 - 0.85 * p})` }, { backgroundColor: 'rgba(0, 0, 0, 0)' }], {
          duration: DUR.fast, easing: EASE.in, fill: 'forwards'
        });
      }
      track(a).onfinish = () => {
        if (open) exitPlayer();
        else hideNow();
      };
      return;
    }
    // back: a spring that leaves at the finger's speed (v toward the rest
    // position = −v, in "remaining distances" per ms)
    const s = spring(dy > 1 ? -d.v / dy : 0);
    const p0 = dragP(dy);
    const still = reducedMotion();
    const frames = (f) => s.frames.map(({ offset, p }) => ({ offset, ...f(1 - p) }));
    let a;
    if (portrait) {
      a = playerEl.animate(frames((k) => ({ transform: `translate3d(0, ${dy * k}px, 0)` })), { duration: s.duration, easing: 'linear' });
      if (dimEl) track(dimEl.animate(frames((k) => ({ opacity: 1 - p0 * k })), { duration: s.duration, easing: 'linear' }));
    } else {
      a = stageEl.animate(
        frames((k) => ({ transform: still ? `translate3d(0, ${dy * k}px, 0)` : `translate3d(${d.dx * 0.35 * k}px, ${dy * k}px, 0) scale(${1 - 0.3 * p0 * k})` })),
        { duration: s.duration, easing: 'linear' }
      );
      track(playerEl.animate(frames((k) => ({ backgroundColor: `rgba(0, 0, 0, ${1 - 0.85 * p0 * k})` })), { duration: s.duration, easing: 'linear' }));
    }
    // the inline drag styles go now; the running animation covers them
    for (const el of [playerEl, stageEl]) {
      el.style.transform = '';
      el.style.backgroundColor = '';
      el.style.borderRadius = portrait ? '12px 12px 0 0' : '';
    }
    if (dimEl) dimEl.style.opacity = '';
    track(a).onfinish = () => {
      if (!drag && !dismissing) resetMotion();
    };
  }

  function onDown(e) {
    if (!open || dismissing) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (isControl(e.target)) return;
    const now = performance.now();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, vertical: false, moved: false, v: 0, ly: e.clientY, lt: now, dx: 0, dy: 0 };
  }
  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    const now = performance.now();
    const dt = now - drag.lt;
    if (dt > 0) drag.v = 0.7 * ((e.clientY - drag.ly) / dt) + 0.3 * drag.v;   // px/ms, down = +
    drag.ly = e.clientY;
    drag.lt = now;
    if (Math.hypot(dx, dy) > 12) drag.moved = true;
    if (!drag.vertical && dy > 16 && dy > Math.abs(dx) * 1.5 && swipeGate()) {
      drag.vertical = true;
      resetMotion();   // a spring-back still running from the last drag
    }
    if (drag.vertical) {
      drag.dx = dx;
      drag.dy = Math.max(0, dy);
      queueDrag();
    }
  }
  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (d.vertical) {
      cancelAnimationFrame(dragFrame);
      dragFrame = 0;
      // a finger resting before it lifts is no flick
      if (performance.now() - d.lt > 80) d.v = 0;
      swipeRelease(d);
      return;
    }
    if (d.moved || pinching) return;
    tap(e.clientX, e.clientY);
  }
  function onCancel() {
    const d = drag;
    drag = null;
    if (d && d.vertical) {
      cancelAnimationFrame(dragFrame);
      dragFrame = 0;
      d.v = 0;
      d.dy = Math.min(d.dy, SWIPE_CLOSE);   // never closes on a cancel
      swipeRelease(d);
    }
  }

  function markJustShown() {
    justShown = true;
    clearTimeout(justT);
    justT = setTimeout(() => (justShown = false), TAP_WAIT);
  }

  function tap(x, y) {
    if (locked) return showLockPill();
    if (P.error || P.loading) return;
    // a picker is up: a tap beside it closes it at once, like a sheet's scrim
    // (it used to wait out the 300 ms double-tap window first) — PLY-07
    if (P.panel) {
      if (single) clearTimeout(single.timer);
      single = null;
      return closePanels();
    }
    const r = stageEl.getBoundingClientRect();
    const side = x - r.left < r.width / 2 ? 'left' : 'right';
    const now = Date.now();
    // inside a running double-tap run: every tap on that side adds 10 s
    if (run && run.side === side && now - run.t < RUN_WAIT) {
      seekRun(side, x, y);
      return;
    }
    if (single && now - single.t < TAP_WAIT && single.side === side && Math.abs(x - single.x) < 90) {
      clearTimeout(single.timer);
      const first = single;
      single = null;
      // the first tap raised the controls: the seek feedback replaces them
      if (first.shownByTap) {
        hideOsd();
        justShown = false;
      }
      seekRun(side, x, y);
      return;
    }
    if (single) clearTimeout(single.timer);
    const s = { t: now, x, side, timer: 0, shownByTap: false };
    if (!ctl && !P.panel) {
      // hidden: up on this tap (PLY-03) — a double tap takes them down again
      showOsd();
      markJustShown();
      s.shownByTap = true;
      s.timer = setTimeout(() => {
        if (single === s) single = null;
      }, TAP_WAIT);
    } else {
      // shown: wait out a possible double tap before hiding them
      s.timer = setTimeout(() => {
        if (single === s) single = null;
        toggleControls();
      }, TAP_WAIT);
    }
    single = s;
  }

  // pinch: fit ↔ fill (landscape; a 16:9 box in portrait has nothing to crop)
  let pinching = false;
  let pinch0 = 0;
  function dist(t) {
    return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  }
  function onTouchStart(e) {
    if (e.touches.length === 2) {
      pinching = true;
      pinch0 = dist(e.touches);
      onCancel();
      if (single) {
        clearTimeout(single.timer);
        single = null;
      }
    }
  }
  function onTouchMove(e) {
    if (pinching && e.touches.length === 2) e.preventDefault();
  }
  // Svelte binds touchmove passive, where preventDefault() throws a console
  // error and does nothing — the pinch guard needs a non-passive listener.
  $effect(() => {
    const el = stageEl;
    if (!el) return;
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => el.removeEventListener('touchmove', onTouchMove);
  });
  function onTouchEnd(e) {
    if (!pinching) return;
    if (e.touches.length < 2 && e.changedTouches.length) {
      const pts = [...e.touches, ...e.changedTouches];
      if (pts.length >= 2 && !portrait && !locked) {
        const r = dist(pts) / (pinch0 || 1);
        if (r > 1.15) fill = true;
        else if (r < 0.87) fill = false;
      }
    }
    if (e.touches.length === 0) setTimeout(() => (pinching = false), 50);
  }

  /* ---------------- lock ---------------- */
  function lock() {
    locked = true;
    P.panel = null;
    hideOsd();
    showLockPill();
  }
  let holdT = 0;
  function pillDown(e) {
    e.stopPropagation();
    clearTimeout(holdT);
    clearTimeout(lockT);
    holdT = setTimeout(() => {
      locked = false;
      lockPill = false;
      showOsd();
    }, 1000);
  }
  /* Locked: the portrait info column (chips, Up Next list) and the Up Next
   * card are pointer-events: none (player.css), so a touch there lands here
   * and only raises the pill — as a tap on the video does. */
  function onLockedDown(e) {
    if (!locked || (e.target.closest && e.target.closest('.lockpill, .vr-stage'))) return;
    showLockPill();
  }
  function pillUp() {
    clearTimeout(holdT);
    if (locked) showLockPill();
  }

  /* ---------------- close ---------------- */
  function close() {
    dismiss();
  }

  /* ---------------- text subtitles, drawn by us ----------------
   * As on the TV (VideoLayer.svelte): the showing text track is flipped to
   * 'hidden' and its active cues are drawn into .vr-subs, which rides above
   * the bottom controls while they are up. In Picture in Picture our DOM isn't
   * drawn, so the track goes back to 'showing' there and WebKit renders it. */
  let subsEl = $state(null);
  let subsTopEl = $state(null);
  let cueTrack = null;
  let pip = $state(false);

  function renderCues() {
    if (!subsEl || !subsTopEl) return;
    const bottom = [];
    const top = [];
    const cues = cueTrack && cueTrack.mode !== 'disabled' && !pip ? cueTrack.activeCues : null;
    if (cues) {
      for (let i = 0; i < cues.length; i++) {
        const c = cues[i];
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

  /* ---------------- Picture in Picture / AirPlay ---------------- */
  let pipOk = $state(false);
  let airplayOk = $state(false);

  function inPip() {
    if (!video) return false;
    try {
      return document.pictureInPictureElement === video || video.webkitPresentationMode === 'picture-in-picture';
    } catch {
      return false;
    }
  }

  function setPip(on) {
    pip = on;
    if (cueTrack) {
      try {
        cueTrack.mode = on ? 'showing' : 'hidden';
      } catch {}
    }
    renderCues();
  }

  async function togglePip() {
    if (!video) return;
    try {
      if (inPip()) {
        if (typeof video.webkitSetPresentationMode === 'function') video.webkitSetPresentationMode('inline');
        else await document.exitPictureInPicture();
        return;
      }
      if (pgsActive) toast('Image subtitles (PGS) aren’t shown in Picture in Picture');
      // Both calls stay synchronous inside the tap: WebKit only grants PiP to a
      // live user gesture. The standard API first (it reports why it refuses),
      // the WebKit presentation mode as the fallback.
      if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function') {
        await video.requestPictureInPicture();
      } else if (typeof video.webkitSetPresentationMode === 'function') {
        video.webkitSetPresentationMode('picture-in-picture');
        setTimeout(() => {
          if (!inPip()) pipFail('the WebKit presentation mode stayed ' + video.webkitPresentationMode);
        }, 1500);
      } else pipFail('no PiP API');
    } catch (e) {
      pipFail(e && (e.name + ': ' + e.message));
    }
  }

  function pipFail(why) {
    console.warn('PiP failed:', why);
    toast('Picture in Picture isn’t available right now');
  }

  function airplay() {
    try {
      video.webkitShowPlaybackTargetPicker();
    } catch {}
  }

  $effect(() => {
    const v = video;
    if (!v) return;
    /* iOS gives no Picture in Picture to a home-screen web app: the element
     * answers "does not support the pip mode" there, while the same page in a
     * Safari tab has it (checked on the iPhone 2026-09-29). So the button only
     * shows in the browser; the installed app pauses when it goes to the
     * background instead (lifecycle.js). */
    pipOk = !navigator.standalone && (
      (typeof v.webkitSupportsPresentationMode === 'function' && v.webkitSupportsPresentationMode('picture-in-picture')) ||
      (!!document.pictureInPictureEnabled && typeof v.requestPictureInPicture === 'function'));
    const onPres = () => setPip(inPip());
    const onAvail = (e) => (airplayOk = e.availability === 'available');
    v.addEventListener('enterpictureinpicture', onPres);
    v.addEventListener('leavepictureinpicture', onPres);
    v.addEventListener('webkitpresentationmodechanged', onPres);
    if (window.WebKitPlaybackTargetAvailabilityEvent) v.addEventListener('webkitplaybacktargetavailabilitychanged', onAvail);
    return () => {
      v.removeEventListener('enterpictureinpicture', onPres);
      v.removeEventListener('leavepictureinpicture', onPres);
      v.removeEventListener('webkitpresentationmodechanged', onPres);
      v.removeEventListener('webkitplaybacktargetavailabilitychanged', onAvail);
    };
  });

  /* ---------------- Media Session (lock screen, Control Centre) ---------------- */
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
  let posStamp = 0;
  $effect(() => {
    const pos = P.pos;
    const dur = P.dur;
    const paused = P.paused;
    if (!open || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = paused ? 'paused' : 'playing';
      const now = Date.now();
      if (dur > 0 && pos <= dur && now - posStamp > 1500) {
        posStamp = now;
        navigator.mediaSession.setPositionState({ duration: dur, position: Math.max(0, pos), playbackRate: 1 });
      }
    } catch {}
  });

  /* ---------------- keyboard (a hardware keyboard / desktop dev) ---------------- */
  function onKey(e) {
    if (!open || e.defaultPrevented) return;
    const k = e.key;
    if (k === 'Escape') {
      e.preventDefault();
      if (P.panel) closePanels();
      else close();
    } else if (k === ' ' && !P.error && !P.loading) {
      e.preventDefault();
      togglePause();
    } else if ((k === 'ArrowLeft' || k === 'ArrowRight') && !P.error && !P.loading) {
      e.preventDefault();
      seekBy(k === 'ArrowLeft' ? -SEEK_STEP : SEEK_STEP);
    }
  }

  /* iOS unlocks a media element for scripted, un-gestured play() once it has
   * been load()ed/played inside a user gesture. The engine does that at the
   * start of a tap-started play(); this catches the first touch anywhere too
   * (an Up Next roll, a Retry, a start whose tap was lost in an await). */
  onMount(() => {
    const prime = () => {
      if (video && !video.getAttribute('src')) {
        try {
          video.load();
        } catch {}
      }
    };
    document.addEventListener('touchend', prime, { once: true, capture: true });
    document.addEventListener('click', prime, { once: true, capture: true });
    return () => {
      document.removeEventListener('touchend', prime, true);
      document.removeEventListener('click', prime, true);
    };
  });
</script>

<svelte:window onkeydown={onKey} />

<!-- portrait swipe-down: the page under the card, dimmed (PLY-02) -->
<div class="vr-dim" hidden={!shown || !portrait} bind:this={dimEl}></div>
<div
  class="player vr-player {portrait ? 'vr-player--portrait' : ''} {P.trailer ? 'player--trailer' : ''} {scrubbing ? 'vr-player--scrubbing' : ''} {locked ? 'vr-player--locked' : ''}"
  class:vr-player--ctl={ctl}
  class:vr-player--upnext={upNext && !portrait && !P.panel}
  class:vr-player--seeking={!!flash}
  class:vr-player--closing={closing}
  class:vr-player--justshown={justShown}
  hidden={!shown}
  bind:this={playerEl}
  onpointerdown={onLockedDown}
  role="application"
  aria-label="Video player"
  style:--sub-scale={(SET.subSize || 100) / 100}
  data-component="Player"
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="vr-stage"
    bind:this={stageEl}
    onpointerdown={onDown}
    onpointermove={onMove}
    onpointerup={onUp}
    onpointercancel={onCancel}
    onscroll={(e) => {
      // overflow: hidden still scrolls programmatically (focus, scrollIntoView,
      // VoiceOver) — that shifted the video up under a black band
      const el = e.currentTarget;
      if (el.scrollTop || el.scrollLeft) el.scrollTo(0, 0);
    }}
    ontouchstart={onTouchStart}
    ontouchend={onTouchEnd}
  >
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      class="player__video vr-video"
      class:player__video--dim={!!P.panel}
      class:vr-video--fill={fill}
      playsinline
      webkit-playsinline
      autopictureinpicture
      x-webkit-airplay="allow"
      preload="auto"
      bind:this={video}
    ></video>
    <canvas class="vr-pgs" class:vr-pgs--fill={fill} bind:this={canvas}></canvas>
    <div class="vr-subs-top" bind:this={subsTopEl}></div>
    <div class="vr-subs" class:vr-subs--raised={ctl} bind:this={subsEl}></div>

    {#if flash}
      <!-- PLY-10: one-shot per tap — a ripple at the finger, a chevron wave in
           the seek direction, the amount bumps; nothing loops -->
      <div
        class="seekflash seekflash--{flash.side} vr-seekflash"
        data-component="SeekFeedback"
        role="status"
        aria-label="{flash.total < 0 ? 'Back' : 'Forward'} {Math.abs(flash.total)} seconds"
        in:fade={{ duration: DUR.press }}
        out:fade={{ duration: DUR.base }}
      >
        {#key flash.n}
          <span class="vr-ripple" style:left="{flash.rx}px" style:top="{flash.ry}px"></span>
          <span class="seekflash__chev vr-chevwave" class:vr-flip={flash.side === 'left'}>
            <Icon name="play" fill /><Icon name="play" fill /><Icon name="play" fill />
          </span>
        {/key}
        {#key flash.total}
          <span class="vr-seekamt" in:bump>{flash.total < 0 ? '−' : '+'}{Math.abs(flash.total)} s</span>
        {/key}
      </div>
    {/if}

    <!-- ============ controls ============ -->
    {#if !portrait}
      <div class="player__controls" class:player__controls--hidden={!ctl} data-component="PlayerControls">
        <div class="player__scrim player__scrim--top"></div>
        <div class="player__scrim player__scrim--bottom"></div>
        <div class="player__top vr-fadeable">
          <button class="iconbtn" type="button" aria-label={P.trailer ? 'Close trailer' : 'Close player'} onclick={close}><Icon name="x" /></button>
          <div class="player__titles">
            {#if showLine}<p class="player__show">{showLine}</p>{/if}
            <p class="player__ep">{epLine}</p>
          </div>
          <div class="player__tools">
            {#if airplayOk && !((P.trailer || P.pending) && video?.disableRemotePlayback)}<button class="iconbtn" type="button" aria-label="AirPlay" onclick={airplay}><Icon name="airplay" /></button>{/if}
            {#if pipOk}<button class="iconbtn" type="button" aria-label="Picture in Picture" onclick={togglePip}><Icon name="pip" /></button>{/if}
            {#if !P.trailer}<button class="iconbtn" type="button" aria-label="Lock controls" onclick={lock}><Icon name="unlock" /></button>{/if}
          </div>
        </div>
        <div class="player__center vr-fadeable" data-component="Transport">
          <button class="pbtn" type="button" aria-label="Back {SEEK_STEP} seconds" onclick={() => seekBy(-SEEK_STEP)}><Icon name="back-10" /></button>
          <button class="pbtn pbtn--lg" type="button" aria-label={P.paused ? 'Play' : 'Pause'} onclick={togglePause}><Icon name={P.paused ? 'play' : 'pause'} /></button>
          <button class="pbtn" type="button" aria-label="Forward {SEEK_STEP} seconds" onclick={() => seekBy(SEEK_STEP)}><Icon name="fwd-10" /></button>
        </div>
        <div class="player__bottom">
          <Scrubber onscrubbing={(v) => (scrubbing = v)} />
          <div class="player__row vr-fadeable">
            {#if P.chapters.length && !P.trailer}
              <button class="pchip" type="button" onclick={openChapters}><Icon name="chapters" />Chapters</button>
            {/if}
            <span class="player__spacer"></span>
            {#if hasAudioChoice}
              <button class="pchip" type="button" onclick={() => openTracks('audio')}><Icon name="audio" />{audioChip.main} {#if audioChip.dim}<span class="pchip__dim">{audioChip.dim}</span>{/if}</button>
            {/if}
            {#if hasSubs}
              <button class="pchip" type="button" onclick={() => openTracks('subs')}><Icon name="subtitles" />{subChip.main} {#if subChip.dim}<span class="pchip__dim">{subChip.dim}</span>{/if}</button>
            {/if}
            {#if quality}
              <button class="pchip" type="button" aria-label="Streaming quality: {quality.label}" onclick={() => openTracks('quality')}><Icon name="settings" />{quality.reduced ? quality.res || 'Reduced' : 'Original'} <span class="pchip__dim">{quality.reduced ? quality.mbit + ' Mbit/s' : 'fits ' + quality.mbit + ' Mbit/s'}</span></button>
            {/if}
          </div>
        </div>
      </div>
    {:else}
      <div class="pport__overlay vr-pport-ctl" class:player__controls--hidden={!ctl} data-component="PlayerControls">
        <button class="iconbtn pport__close" type="button" aria-label={P.trailer ? 'Close trailer' : 'Close player'} onclick={close}><Icon name="x" /></button>
        <div class="pport__tools vr-fadeable">
          {#if airplayOk && !((P.trailer || P.pending) && video?.disableRemotePlayback)}<button class="iconbtn" type="button" aria-label="AirPlay" onclick={airplay}><Icon name="airplay" /></button>{/if}
          {#if pipOk}<button class="iconbtn" type="button" aria-label="Picture in Picture" onclick={togglePip}><Icon name="pip" /></button>{/if}
        </div>
        <div class="pport__center vr-fadeable">
          <button class="pbtn" type="button" aria-label="Back {SEEK_STEP} seconds" onclick={() => seekBy(-SEEK_STEP)}><Icon name="back-10" /></button>
          <button class="pbtn pbtn--lg" type="button" aria-label={P.paused ? 'Play' : 'Pause'} onclick={togglePause}><Icon name={P.paused ? 'play' : 'pause'} /></button>
          <button class="pbtn" type="button" aria-label="Forward {SEEK_STEP} seconds" onclick={() => seekBy(SEEK_STEP)}><Icon name="fwd-10" /></button>
        </div>
        <div class="pport__scrub"><Scrubber compact onscrubbing={(v) => (scrubbing = v)} /></div>
      </div>
    {/if}

    <!-- ============ always-on-top bits ============ -->
    <!-- PLY-06: the chip sits at its raised spot and the wrapper lowers it
         with a transform, so it glides with the controls instead of jumping -->
    <div class="vr-skipwrap" class:vr-skipwrap--low={!ctl}>
      {#if skip}
        <button
          class="skipchip"
          type="button"
          onclick={skipSegment}
          data-component="SkipChip"
          in:fly={{ y: reducedMotion() ? 0 : 8, duration: DUR.base, easing: easeOut }}
          out:fade={{ duration: DUR.fast }}
        >
          <Icon name="skip" /><span>Skip {skip.kind === 'intro' ? 'Intro' : skip.kind === 'recap' ? 'Recap' : skip.kind === 'preview' ? 'Preview' : skip.kind}</span>
        </button>
      {/if}
    </div>

    {#if upNext && !portrait && !P.panel}
      <UpNextCard />
    {/if}

    {#if P.spinner && !P.loading && !P.error}
      {#if bufLong}
        <div class="pcard vr-noswipe-pass" role="status" data-component="PlayerStatusCard">
          <div class="pcard__row"><span class="spinner"></span><span>{waitText || 'Buffering…'}</span></div>
          {#if slowHint}<p class="pcard__hint">{slowHint}</p>{/if}
          {#if fitCap}
            <div class="pcard__actions">
              <button class="btn btn--glass btn--sm" type="button" onclick={() => pmSetQuality(fitCap)}><span>Switch to {fitCap / 1e6} Mbit/s</span></button>
            </div>
          {/if}
        </div>
      {:else if spinShown}
        <div class="pcard pcard--bare vr-noswipe-pass" role="status" aria-label="Loading" in:fade={{ duration: DUR.fast }}><span class="spinner spinner--lg"></span></div>
      {/if}
    {/if}

    {#if locked && lockPill}
      <button
        class="lockpill"
        type="button"
        aria-label="Controls locked. Press and hold to unlock."
        onpointerdown={pillDown}
        onpointerup={pillUp}
        onpointercancel={pillUp}
        oncontextmenu={(e) => e.preventDefault()}
        data-component="LockIndicator"
      >
        <span class="lockpill__icon"><Icon name="lock" /></span>
        <span class="lockpill__text">Controls locked<span>Press and hold to unlock</span></span>
      </button>
    {/if}

    <!-- loading card: backdrop + title + spinner until the first frame -->
    <div class="pload vr-pload" class:vr-pload--show={P.loading && !P.error} aria-hidden={!P.loading} role="status" data-component="PlayerLoading">
      <div class="pload__art art">{#if loadImg}<img use:decoded={loadImg} alt="" />{/if}</div>
      <div class="pload__body">
        {#if showLine}<p class="player__show">{showLine}</p>{/if}
        <h1 class="pload__title">{isEp || P.trailer ? item.Name || '' : item.Name || ''}</h1>
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
          <button class="btn btn--glass btn--sm" type="button" onclick={close}><span>Close</span></button>
        </div>
      </div>
    {/if}

    {#if busy}
      <!-- close stays reachable over the loading and error cards -->
      <div class="player__top vr-busytop">
        <button class="iconbtn" type="button" aria-label="Cancel and close" onclick={close}><Icon name="x" /></button>
      </div>
    {/if}
  </div>

  <!-- ============ portrait: info below the video ============ -->
  {#if portrait}
    <div class="pport__info">
      {#if P.trailer}
        <p class="player__show">Trailer</p>
        <h1 class="pport__title">{item.Name || ''}</h1>
      {:else}
        <p class="player__show">{[isEp ? item.SeriesName : item.ProductionYear, epCode].filter(Boolean).join(' · ')}</p>
        <h1 class="pport__title">{item.Name || ''}</h1>
        <p class="pport__meta">{[item.RunTimeTicks ? fmtRuntime(item.RunTimeTicks) : '', tracks.audio.find((a) => a.index === P.audioIndex)?.label || ''].filter(Boolean).join(' · ')}</p>
        {#if quality}<p class="pport__meta vr-quality-line" class:vr-quality-line--on={quality.reduced}>{quality.label}</p>{/if}
      {/if}
      <div class="pport__chips">
        {#if hasAudioChoice}<button class="pchip" type="button" onclick={() => openTracks('audio')}><Icon name="audio" />Audio</button>{/if}
        {#if hasSubs}<button class="pchip" type="button" onclick={() => openTracks('subs')}><Icon name="subtitles" />{P.subIndex < 0 ? 'Subtitles off' : [subChip.main, subChip.dim].filter(Boolean).join(' ')}</button>{/if}
        {#if !P.pending}<button class="pchip" type="button" onclick={() => openTracks('quality')}><Icon name="settings" />Quality</button>{/if}
        {#if P.chapters.length && !P.trailer}<button class="pchip" type="button" onclick={openChapters}><Icon name="chapters" />Chapters</button>{/if}
        {#if !P.trailer}<button class="pchip" type="button" onclick={lock}><Icon name="unlock" />Lock</button>{/if}
      </div>
      <!-- the "peek" layout: what this is about, clamped; a tap opens it all -->
      {#if item.Overview}
        <button class="vr-pport-overview" class:vr-pport-overview--open={overviewOpen} type="button" aria-expanded={overviewOpen} onclick={() => (overviewOpen = !overviewOpen)}>{item.Overview}</button>
      {/if}
    </div>

    <div class="rotatehint" data-component="RotateHint">
      <span class="rotatehint__icon"><Icon name="phone" /></span>
      <p class="rotatehint__text"><strong>Turn your iPhone for full screen</strong>Rotation lock has to be off — a web app can’t rotate by itself.</p>
    </div>

    {#if P.next && !P.trailer}
      <section class="section vr-pport-next" aria-label="Up next">
        <div class="section__head"><h2 class="section__title">Up Next</h2></div>
        {#if upNext && !busy}
          <div class="vr-pport-upnext"><UpNextCard inline /></div>
        {:else}
          <div class="episodes">
            <button class="episode" type="button" onclick={() => playNext(true)}>
              <div class="episode__still"><div class="art">{#if imgUrl(P.next, 'Primary', { w: 320 })}<img src={imgUrl(P.next, 'Primary', { w: 320 })} alt="" loading="lazy" />{/if}</div></div>
              <div class="episode__head">
                <p class="episode__num">{['E' + (P.next.IndexNumber ?? ''), P.next.RunTimeTicks ? fmtRuntime(P.next.RunTimeTicks) : ''].filter(Boolean).join(' · ')}</p>
                <p class="episode__title">{P.next.Name || ''}</p>
              </div>
            </button>
          </div>
        {/if}
      </section>
    {/if}
  {/if}

  <!-- ============ panels ============ -->
  {#if P.panel === 'tracks'}
    <TrackPanel {portrait} initial={trackTab} onclose={closePanels} />
  {:else if P.panel === 'chapters'}
    <ChapterPanel {portrait} onclose={closePanels} />
  {/if}
</div>
