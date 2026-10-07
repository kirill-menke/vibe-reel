<script>
  /* The phone shell: every route of every tab stack (only the active top
   * shown), the floating tab bar, the sheet host, the player modal (always
   * mounted), Login as a full-screen modal, toast and offline banner.
   * Navigation state: lib/router.svelte.js; TV-compatible S: lib/nav.svelte.js. */
  import { onMount, tick } from 'svelte';
  import { R, S, TABS, top, beneath, pop, closeSheet, markBooted, resetStacks, scrollToTop, takeFocus, pruneFocus } from './lib/router.svelte.js';
  import { forgetRoute } from './lib/restore.svelte.js';
  import { openLogin } from './lib/nav.svelte.js';
  import { screens } from './screens/index.js';
  import { sheets } from './sheets/index.js';
  import Login from './screens/Login.svelte';
  import Player from './player/Player.svelte';
  import TabBar from './components/TabBar.svelte';
  import Toast from './components/Toast.svelte';
  import OfflineBanner from './components/OfflineBanner.svelte';
  import { edgeSwipeBack } from './lib/gestures.js';
  import { zoomIn, zoomOut, zoomDrag, keepOrigins, ZOOM_CLOSE_MS } from './lib/zoom.js';
  import { reducedMotion, EASE, DUR } from './lib/safe.js';
  import { conn, checkServer } from './lib/conn.svelte.js';
  import { cfg } from '$lib/config.js';
  import { api, onAuthLost } from '$lib/api.js';
  import { toast } from '$lib/toast.svelte.js';
  import { onReconnect } from '$lib/reconnect.js';
  import { startActivity, stopActivity } from '$lib/activity.svelte.js';
  import { startNews, stopNews } from '$lib/news.svelte.js';
  import '$lib/landed.svelte.js'; // registers its activity-feed listener (the bell's "Ready to watch")
  import { rememberCurrent } from '$lib/account.svelte.js';
  import { meAtBoot } from './lib/mylib.js';
  /* sheet host, login modal, toast, action sheet (polish lane F) */
  import * as mo from './lib/safe.js';
  import { takeSheetExitV, followSheet } from './components/Sheet.svelte';
  import ActionSheet from './components/ActionSheet.svelte';

  /* ------------------------------------------------------------ polling ---- */
  /* Activity (download badges) and the bell's feed poll only while the app is
   * on screen and browsing — never under the player or Login (as on the TV). */
  let visible = $state(document.visibilityState !== 'hidden');
  onMount(() => {
    const onVis = () => (visible = document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  });
  const browsing = $derived(visible && R.booted && !R.modal);
  /* The quota (GET /api/me) once, a moment after boot: the tiles' quick "+"
   * then refuses an add over it without a request (lib/mylib.js). */
  $effect(() => {
    if (R.booted) meAtBoot();
  });
  $effect(() => {
    if (browsing) {
      startActivity();
      startNews();
    } else {
      stopActivity();
      stopNews();
    }
  });

  /* ------------------------------------------------------- auth / boot ---- */
  let authCheck = false;
  onAuthLost(async () => {
    const busy = () => S.screen === 'login' || S.screen === 'boot' || S.screen === 'player';
    if (authCheck || busy()) return;
    authCheck = true;
    try {
      await api('/Users/' + cfg.userId);
    } catch (e) {
      if (/** @type {VR.ApiError} */ (e)?.status === 401 && !busy()) {
        closeSheet();
        toast('Jellyfin signed this iPhone out — sign in again');
        openLogin();
      }
    } finally {
      authCheck = false;
    }
  });

  /* PWA-02: with a stored session the shell — stacks (restored by
   * lib/restore.svelte.js before this mounts), tab bar — is there in the first
   * frame and fills in while the session check runs, instead of a blank screen
   * until /Users/{id} answers (Home's requests used to wait for it too).
   * R.booted still gates what needs a known-good session: the activity/news
   * polls, freshness and notification-tap routing. A 401 takes the shell down
   * again under Login (Home's own 401s are ignored while S.screen is 'boot'). */
  const shell = $derived(R.booted || (!!cfg.token && !!cfg.userId && R.modal !== 'login'));

  onMount(() => {
    S.ready = true;
    if (!cfg.token || !cfg.userId) {
      openLogin();
      return;
    }
    /* Only a real auth rejection means "sign in again"; a network error keeps
     * the session and raises the offline banner. */
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    api('/Users/' + cfg.userId, { signal: ctl.signal })
      .then(() => {
        rememberCurrent();
        markBooted();
      })
      .catch((e) => {
        if (e && (e.status === 401 || e.status === 403)) {
          // whoever signs in starts on Home, not on the revoked session's pages
          forgetRoute();
          resetStacks();
          openLogin();
        } else {
          markBooted();
          conn.offline = true;
          checkServer();
        }
      })
      .finally(() => clearTimeout(t));
  });

  onMount(() => onReconnect(() => conn.offline && checkServer(), { every: 20000 }));

  /* ------------------------------------------------------------ routes ---- */
  let stage = $state(/** @type {HTMLDivElement | null} */ (null));

  /* The tab bar belongs to the four roots (NAV-17, as UIKit's
   * hidesBottomBarWhenPushed): every pushed page sits above it (.route--deep,
   * app.css) and covers it as it slides or zooms in; a pop reveals it again
   * with the root. It is drawn only while a root is on screen — at rest, in a
   * push from / pop to it, under an edge swipe back to it — so a push between
   * two deeper pages (the covered one dims) never shows it through. */
  const rootKey = $derived(R.stacks[R.tab][0].key);
  const atRoot = $derived(R.stacks[R.tab].length < 2);
  const barShown = $derived(atRoot || R.peek === rootKey || (!!R.anim && (R.anim.from === rootKey || R.anim.to === rootKey)));
  const el = (/** @type {string | null | undefined} */ key) => /** @type {HTMLElement | null | undefined} */ (stage?.querySelector(`.route[data-key="${key}"]`));

  /** @param {VR.TabName} tab @param {VR.Route} route @param {boolean} isTop */
  function shown(tab, route, isTop) {
    if (tab !== R.tab) return false;
    if (isTop) return true;
    const a = R.anim;
    return R.peek === route.key || (a && (a.from === route.key || a.to === route.key));
  }

  /* push: new page slides in from the right, the old one drifts to −30 % and
   * dims; pop: the reverse (the leaving page's slide is leave() below, since
   * it is already gone from the stack). Reduced motion: a cross-dissolve.
   *
   * Interruptible (NAV-01): every transition starts from where the pages ARE
   * — a Back 150 ms into a push, a second Back mid-pop, a push mid-pop —
   * never from the canonical start (that jerked the page forward a frame
   * before it slid out). cur() reads a route's live position and cancels
   * the animation that put it there; durations shrink with the distance left.
   * Only animations started here (`mine`) are touched — a leaving route also
   * carries Svelte's outro timer, and cancelling that would leak the node.
   * The page edge casts a shadow strip (.stage__edge, NAV-04) that moves with
   * the sliding page — cheaper than a box-shadow on a full-page layer. */
  let edgeEl = $state(/** @type {HTMLDivElement | null} */ (null));
  const EDGE = 24; // px, the strip's width
  const mine = new WeakSet();
  const W = () => stage?.clientWidth || window.innerWidth;
  const tx = (/** @type {number} */ x) => `translate3d(${Math.round(x * 100) / 100}px,0,0)`;
  /** @param {Element} node @param {Keyframe[]} kf @param {KeyframeAnimationOptions} opts */
  function run(node, kf, opts) {
    const an = node.animate(kf, opts);
    mine.add(an);
    return an;
  }
  /** @template {{ x: number, o: number } | null} T @param {Element} node @param {T} rest
   * @returns {{ x: number, o: number } | T} `rest` when none of our animations runs on it */
  function cur(node, rest) {
    const ours = node.getAnimations().filter((an) => mine.has(an));
    if (!ours.length) return rest;
    const cs = getComputedStyle(node);
    const x = cs.transform === 'none' ? 0 : new DOMMatrixReadOnly(cs.transform).m41;
    const o = +cs.opacity;
    for (const an of ours) an.cancel();
    return { x, o };
  }
  /* the strip rides the sliding page's left edge, fading over the last 20 % */
  /** @param {number} x0 @param {number} x1 @param {number} duration */
  function edge(x0, x1, duration) {
    if (!edgeEl) return;
    for (const an of edgeEl.getAnimations()) an.cancel();
    const at = (/** @type {number} */ p) => ({ transform: tx(x0 + (x1 - x0) * p - EDGE) });
    run(edgeEl, [{ offset: 0, ...at(0), opacity: 1 }, { offset: 0.8, ...at(0.8), opacity: 1 }, { offset: 1, ...at(1), opacity: 0 }], {
      duration,
      easing: EASE.sheet
    });
  }
  const pushMs = (/** @type {number} */ dist) => Math.min(DUR.push, Math.max(160, (DUR.push * dist) / W()));

  $effect(() => {
    const a = R.anim;
    if (!a) {
      // cut short (a tab switch mid-push): the strip must not slide on over another tab
      if (edgeEl) for (const an of edgeEl.getAnimations()) an.cancel();
      return;
    }
    tick().then(() => {
      if (R.anim !== a) return;
      const from = el(a.from);
      const to = el(a.to);
      /** @returns {unknown} */
      const done = () => {
        if (a.replace) {
          // replace(): the old page leaves the DOM a moment later — hide it
          // now, then the new page can drop the lift below (back to .route--deep's)
          if (from) from.style.visibility = 'hidden';
          if (to) to.style.zIndex = '';
        }
        return R.anim === a && (R.anim = null);
      };
      /* opened from a tile: the page grows out of it (lib/zoom.js) — still
       * before the first paint of the new route */
      if (a.dir === 'zoom' && zoomIn({ route: to, under: from, key: a.to, done })) return;
      /* back into that tile: a frame later, once the page underneath has its
       * scroll offsets back (the tile is measured) — the card is still full
       * screen, so nothing shows the wait */
      if (a.dir === 'unzoom') {
        requestAnimationFrame(() => zoomOut({ route: from, under: to, key: a.from }).then(done));
        return;
      }
      const w = W();
      let main = null;
      // replace(): Svelte's outro keeps the replaced page where it was — after
      // the new one in the DOM, so on top of it: lift the new page while they cross
      if (a.replace && to) to.style.zIndex = 'calc(var(--z-route-deep) + 1)';
      if (a.dir === 'push' || a.dir === 'zoom') {
        // a pushed page is always new: it enters from the edge; the page it
        // covers drifts on from wherever it is (mid-pop, say)
        const d = DUR.push;
        const f = from && cur(from, { x: 0, o: 1 });
        if (to) {
          main = run(to, [{ transform: tx(w) }, { transform: tx(0) }], { duration: d, easing: EASE.sheet });
          edge(w, 0, d);
        }
        if (from) run(from, [{ transform: tx(/** @type {NonNullable<typeof f>} */ (f).x), opacity: /** @type {NonNullable<typeof f>} */ (f).o }, { transform: tx(-0.3 * w), opacity: 0.6 }], { duration: d, easing: EASE.sheet, fill: a.replace ? 'forwards' : 'none' });
      } else if (a.dir === 'pop') {
        // leave() has started the leaving page and says how long it takes
        const t = to && cur(to, { x: -0.3 * w, o: 0.6 });
        if (to) main = run(to, [{ transform: tx(/** @type {NonNullable<typeof t>} */ (t).x), opacity: /** @type {NonNullable<typeof t>} */ (t).o }, { transform: tx(0), opacity: 1 }], { duration: a.dur ?? DUR.push, easing: EASE.sheet });
      } else if (!a.back) {
        // Reduce Motion, forward: the new page dissolves in over the old one
        const t = to && cur(to, { x: 0, o: 0 });
        if (from) {
          const f = cur(from, { x: 0, o: 1 });
          if (f.o < 1) run(from, [{ opacity: f.o }, { opacity: 1 }], { duration: DUR.rm * (1 - f.o), easing: 'linear' });
        }
        if (to) main = run(to, [{ opacity: /** @type {NonNullable<typeof t>} */ (t).o }, { opacity: 1 }], { duration: Math.max(60, DUR.rm * (1 - /** @type {NonNullable<typeof t>} */ (t).o)), easing: 'linear' });
      } else if (to) {
        // Reduce Motion, back (NAV-14): only the leaving page fades (leave());
        // this one stays at full opacity under it — two half-faded pages
        // showed the black background through them
        const t = cur(to, { x: 0, o: 1 });
        if (t.o < 1) main = run(to, [{ opacity: t.o }, { opacity: 1 }], { duration: a.dur ?? DUR.rm, easing: 'linear' });
      }
      if (main) main.onfinish = main.oncancel = done;
      else done();
    });
  });

  /* Svelte out-transition for the page leaving on a pop (it's already out of
   * the stack, Svelte keeps it until this finishes). Instant otherwise.
   * The movement itself is our own WAAPI animation from wherever the page is
   * now (mid-push, mid-reveal); Svelte only gets the duration to keep the
   * node alive for. */
  /* Never `duration: 0`: Svelte 5.56's keyed each drops several items as one
   * outro group, and an item whose outro finishes synchronously (duration 0)
   * is never taken off the group's pending set — so a popToRoot that removed
   * the animated top page plus instant ones kept all of them in the DOM for
   * good (measured: 9 detail pages left mounted after one tab-bar tap).
   * 1 ms goes through the async path like the animated one. */
  /** @param {HTMLElement} node @param {{ key: string }} params */
  function leave(node, { key }) {
    const a = R.anim;
    // replace(): the old page is the one being covered — the push/dissolve in
    // the $effect above moves it; keep it until the new page has landed
    if (a?.replace && a.from === key) return { duration: (a.dir === 'fade' ? DUR.rm : DUR.push) + 20 };
    if (!a || a.from !== key || a.dir === 'push' || a.dir === 'zoom') return { duration: 1 };
    node.style.zIndex = 'calc(var(--z-route-deep) + 2)';
    // zoom.js animates the node itself; keep it until that has landed
    if (a.dir === 'unzoom') return { duration: ZOOM_CLOSE_MS + 120 };
    const c = cur(node, { x: 0, o: 1 });
    const opts = /** @type {KeyframeAnimationOptions} */ ({ easing: EASE.sheet, fill: 'forwards' });
    if (a.dir === 'fade') {
      a.dur = Math.max(60, DUR.rm * c.o);
      run(node, [{ opacity: c.o }, { opacity: 0 }], { ...opts, duration: a.dur, easing: 'linear' });
    } else {
      const w = W();
      a.dur = pushMs(w - c.x);
      run(node, [{ transform: tx(c.x), opacity: c.o }, { transform: tx(w), opacity: 1 }], { ...opts, duration: a.dur });
      edge(c.x, w, a.dur);
    }
    return { duration: a.dur + 20 };
  }

  /* Hidden pages lose their scroll offset in some engines when display:none
   * comes and goes — remember every scroller's offset per route and put it
   * back when the route shows again.
   * A scroll event only notes the scroller; the offsets are read once
   * scrolling rests, and before anything can hide a route ($effect.pre
   * below) — reading them inside the event forced a layout in frames where a
   * grid then mounted more tiles (0.75–2 s of forced layout over a 600-title
   * Library pass at 4× throttle, headless Chrome; restore.svelte.js does the
   * same). */
  const offsets = new Map(); // routeKey → Map(element → [top, left])
  const moved = new Map(); // element → routeKey, scrolled since the last read
  let lastScroll = 0;
  let readTimer = 0;
  const REST = 150; // ms without a scroll event before the offsets are read
  /** @param {Event} e */
  function onScroll(e) {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const r = /** @type {HTMLElement | null} */ (t.closest('.route'));
    if (!r || r.hidden) return;
    moved.set(t, r.dataset.key);
    lastScroll = performance.now();
    if (!readTimer) readTimer = setTimeout(readMoved, REST);
  }
  function readMoved() {
    readTimer = 0;
    const wait = REST - (performance.now() - lastScroll);
    if (wait > 0) readTimer = setTimeout(readMoved, wait);
    else flushOffsets();
  }
  function flushOffsets() {
    clearTimeout(readTimer);
    readTimer = 0;
    for (const [t, key] of moved) {
      if (!t.isConnected || t.closest('.route')?.hidden) continue;
      let m = offsets.get(key);
      if (!m) offsets.set(key, (m = new Map()));
      m.set(t, [t.scrollTop, t.scrollLeft]);
    }
    moved.clear();
  }
  $effect.pre(() => {
    // before the DOM update that may hide a route: its offsets still read true
    void R.tab, R.stacks, R.anim, R.peek, R.modal;
    if (moved.size) flushOffsets();
  });
  $effect(() => {
    // re-run whenever visibility can change
    void R.tab, R.stacks, R.anim, R.peek, R.modal;
    tick().then(() => {
      if (!stage) return;
      // a scroller still moving (momentum) is current, not to be put back
      if (moved.size) flushOffsets();
      const live = new Set();
      for (const r of /** @type {NodeListOf<HTMLElement>} */ (stage.querySelectorAll('.route'))) {
        live.add(r.dataset.key);
        if (r.hidden) continue;
        const m = offsets.get(r.dataset.key);
        if (!m) continue;
        for (const [node, [st, sl]] of m) {
          if (!node.isConnected) {
            m.delete(node);
            continue;
          }
          if (node.scrollTop !== st) node.scrollTop = st;
          if (node.scrollLeft !== sl) node.scrollLeft = sl;
        }
      }
      for (const k of offsets.keys()) if (!live.has(k)) offsets.delete(k);
      keepOrigins(live);
      pruneFocus(live);
    });
  });

  /* Active tab tapped at its root: scroll its page(s) to the top. */
  let lastToTop = 0;
  $effect(() => {
    const n = R.toTop;
    if (n === lastToTop) return;
    lastToTop = n;
    const r = el(top().key);
    if (!r) return;
    for (const s of /** @type {NodeListOf<HTMLElement>} */ (r.querySelectorAll('.screen, [data-scroll-top]'))) scrollToTop(s);
    offsets.delete(top().key);
  });

  /* VoiceOver (NAV-09), as UIKit's "screen changed": a push that has landed
   * hands focus to the new page's title, a pop gives it back to what had it
   * on the page underneath (the tapped tile — router.push() remembers it,
   * since the page turns inert, and loses focus, the moment it is covered).
   * A touch-driven focus() shows no ring (:focus-visible). Not on a tab
   * switch (the tab bar keeps it), nor under a sheet or modal. */
  /** @type {{ tab: VR.TabName, key: string } | null} */
  let landed = null; // { tab, key }
  $effect(() => {
    const a = R.anim;
    const t = top();
    const tab = R.tab;
    if (a || !shell) return;
    const was = landed;
    landed = { tab, key: t.key };
    if (!was || was.tab !== tab || was.key === t.key || R.modal || R.sheet) return;
    const pushed = R.stacks[tab].some((r) => r.key === was.key);
    tick().then(() => {
      const r = el(t.key);
      if (!r || top().key !== t.key || R.anim) return;
      if (pushed) {
        const h = /** @type {HTMLElement | null} */ (r.querySelector('.screen h1') || r.querySelector('h1, .navbar__title'));
        if (!h) return;
        if (!h.matches('button, a, [tabindex]')) h.tabIndex = -1;
        h.focus({ preventScroll: true });
      } else {
        const f = takeFocus(t.key);
        // a tab re-tap (pop to root) keeps focus on the tab bar
        if (f?.isConnected && r.contains(f) && !document.activeElement?.closest('.tabbar')) f.focus({ preventScroll: true });
      }
    });
  });

  /** @type {VR.EdgeSwipeOptions} */
  const swipe = {
    /* also mid-push (NAV-01): the swipe takes the pages over from where they are */
    enabled: () => shell && !R.modal && !R.sheet && (!R.anim || R.anim.dir === 'push') && !!beneath(),
    top: () => el(top().key),
    beneath: () => el(beneath()?.key),
    shadow: () => edgeEl,
    reveal: (on) => (R.peek = on ? beneath()?.key || null : null),
    /* the drag starts: stop a push still sliding in, and say where its page is */
    grab: (route, under) => {
      if (R.anim?.dir !== 'push') return 0;
      const x = cur(route, { x: 0, o: 1 }).x;
      cur(under, null);
      if (edgeEl) for (const an of edgeEl.getAnimations()) an.cancel();
      R.anim = null;
      return Math.max(0, x);
    },
    /* a page opened from a tile shrinks with the finger instead of sliding */
    drag: (route, under) => zoomDrag({ route, under, key: top().key }),
    commit: () => {
      R.peek = null;
      pop({ animate: false });
    }
  };

  /* ------------------------------------------------------------- sheets ---- */
  /** @type {VR.SheetRoute | null} */
  let sheetShown = $state.raw(/** @type {VR.SheetRoute | null} */ (null));
  let sheetHost = $state(/** @type {HTMLDivElement | null} */ (null));
  let scrimEl = $state(/** @type {HTMLDivElement | null} */ (null));

  /* SHT-01: the `.sheet` itself travels its own height (a 365 px sheet used
   * to cross the whole 852 px screen: invisible for ~70 ms, then a burst and a
   * crawl). Present: from h below to rest, on the sheet curve. Dismiss: from
   * wherever it is now (a drag leaves it offset) — after a drag at the
   * finger's speed on a spring (SHT-02, Sheet.svelte hands the speed over),
   * else accelerating away; the scrim fades on the same progress. */
  const sheetEl = () => /** @type {HTMLElement | null | undefined} */ (sheetHost?.querySelector('.sheet'));

  /* SHT-03: behind a *large* sheet the page recedes into a card (iOS page
   * sheet): `.presenter` (stage + tab bar + banner) scales to .92 from its top
   * edge, drops to just under the status bar and rounds its corners; the body
   * shows black around it. Driven by the sheet's own progress p (1 = sheet at
   * rest): the present and the exit run the same curve and duration as the
   * sheet, a drag paints it per frame and a release settles it on the drag's
   * spring (Sheet.svelte's followSheet()). Not for medium sheets, under Reduce
   * Motion (the scrim alone dims), in phone landscape (iOS shows those sheets
   * full screen) or with the player / Login up. The transform animates on the
   * compositor; the corner radius runs as its own animation, so a busy main
   * thread can only delay the corners, never the movement. */
  let presEl = $state(/** @type {HTMLDivElement | null} */ (null));
  const CARD_S = 0.92; // scale at rest
  const CARD_R = 14; // corner radius at rest, in the card's own px (≈ 13 on screen)
  let cardTop = 6; // px the card's top drops at rest: safe-top + 6 (the sheet's top is safe-top + 16)
  let cardLive = false; // the card effect is on (classes set, may be mid-animation)
  /** @type {Animation[]} */
  let cardAnims = [];
  const cardLand = typeof matchMedia === 'function' ? matchMedia('(orientation: landscape) and (max-height: 500px)') : null;
  const clamp01 = (/** @type {number} */ x) => Math.max(0, Math.min(1, x));
  /** @param {Element | null | undefined} s */
  function cardWanted(s) {
    return !!s && s.classList.contains('sheet--large') && !R.modal && !mo.reducedMotion() && !cardLand?.matches;
  }
  const cardT = (/** @type {number} */ p) => `translate3d(0,${(cardTop * p).toFixed(2)}px,0) scale(${(1 - (1 - CARD_S) * p).toFixed(4)})`;
  const cardRad = (/** @type {number} */ p) => `${(CARD_R * p).toFixed(2)}px`;
  function cardStop() {
    for (const a of cardAnims) a.cancel();
    cardAnims = [];
  }
  /* where the card is now (a running animation or the drag's inline style) */
  function cardNow() {
    if (!cardLive || !presEl) return 0;
    const t = getComputedStyle(presEl).transform;
    if (!t || t === 'none') return 0;
    return clamp01((1 - new DOMMatrixReadOnly(t).a) / (1 - CARD_S));
  }
  function cardStart() {
    if (!presEl) return false;
    if (!cardLive) {
      cardTop = mo.safeInsets().top + 6;
      presEl.classList.add('presenter--card');
      document.body.classList.add('sheet-card');
      cardLive = true;
    }
    return true;
  }
  function cardOff() {
    cardStop();
    cardLive = false;
    if (!presEl) return;
    presEl.classList.remove('presenter--card');
    document.body.classList.remove('sheet-card');
    presEl.style.transform = '';
    presEl.style.borderRadius = '';
  }
  /** @param {number} p */
  function cardPaint(p) {
    if (!cardLive || !presEl) return;
    cardStop();
    presEl.style.transform = cardT(p);
    presEl.style.borderRadius = cardRad(p);
  }
  /* frames [{offset, p}] with WAAPI opts; the end state is committed inline,
   * and a card that ends at 0 switches the effect off */
  /** @param {Array<{ offset: number, p: number }>} frames @param {KeyframeAnimationOptions} opts */
  function cardRun(frames, opts, skip = 0) {
    if (!cardLive || !presEl) return;
    cardStop();
    const o = /** @type {KeyframeAnimationOptions} */ ({ ...opts, fill: 'forwards' });
    const t = presEl.animate(frames.map((f) => ({ offset: f.offset, transform: cardT(f.p) })), o);
    const r = presEl.animate(frames.map((f) => ({ offset: f.offset, borderRadius: cardRad(f.p) })), o);
    if (skip) t.currentTime = r.currentTime = skip;
    cardAnims = [t, r];
    const endP = frames[frames.length - 1].p;
    t.onfinish = () => {
      if (cardAnims[0] !== t) return;
      if (endP <= 0) cardOff();
      else cardPaint(endP);
    };
  }
  /* back to full screen with a sheet leaving on its own (App's exit) */
  /** @param {Array<{ offset: number, p: number }>} frames @param {KeyframeAnimationOptions} opts @param {number} [skip] */
  function cardBack(frames, opts, skip) {
    if (!cardLive) return;
    if (mo.reducedMotion()) return cardOff();
    cardRun(frames, opts, skip);
  }
  let cardHeld = false; // a finger is on the sheet
  onMount(() =>
    followSheet({
      grab: () => {
        cardHeld = true;
        if (cardLive) cardPaint(cardNow());
      },
      paint: (p) => cardPaint(p),
      settle: (frames, opts, skip) => {
        cardHeld = false;
        cardRun(frames, opts, skip);
      }
    })
  );
  /* rotating into phone landscape with the card up: iOS has no card there —
   * drop it; back in portrait with the sheet still up, re-seat it under the
   * status bar (the drop depends on safe-top) */
  onMount(() => {
    const re = () => {
      if (cardAnims.length || cardHeld) return;
      if (!R.sheet || !cardWanted(sheetEl())) return cardLive && cardOff();
      cardStart();
      cardTop = mo.safeInsets().top + 6;
      cardPaint(1);
    };
    window.addEventListener('resize', re);
    return () => window.removeEventListener('resize', re);
  });

  $effect(() => {
    const want = R.sheet;
    if (want && sheetShown?.key !== want.key) {
      sheetShown = want;
      tick().then(() => {
        const s = sheetEl();
        if (!s || R.sheet !== want) return;
        // one sheet replaced by another: the card follows the new one's size
        const card = cardWanted(s);
        if (!card && cardLive) cardBack([{ offset: 0, p: cardNow() }, { offset: 1, p: 0 }], { duration: mo.DUR.sheetOut, easing: mo.EASE.dismiss });
        // presented while the previous sheet was still leaving: the host and
        // scrim are the same elements, and the exit's forwards fills (opacity 0)
        // would win again once the unfilled present below ends (REV-02)
        for (const x of sheetHost?.getAnimations() ?? []) x.cancel();
        for (const x of scrimEl?.getAnimations() ?? []) x.cancel();
        if (reducedMotion()) {
          sheetHost?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: mo.DUR.rm });
          return;
        }
        // a critically damped spring from rest: on screen from the first
        // frame, a third of the way at 100 ms, reads as landed at ~400 ms
        s.animate([{ transform: `translate3d(0,${s.offsetHeight}px,0)` }, { transform: 'translate3d(0,0,0)' }], {
          duration: mo.DUR.spring,
          easing: mo.SPRING.smooth
        });
        scrimEl?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: mo.DUR.sheetOut, easing: 'linear' });
        // the page recedes on the same curve (the sheet's travel is linear in p)
        if (card) {
          const p0 = cardNow();
          if (cardStart()) cardRun([{ offset: 0, p: p0 }, { offset: 1, p: 1 }], { duration: mo.DUR.spring, easing: mo.SPRING.smooth });
        }
      });
    } else if (!want && sheetShown) {
      const gone = sheetShown;
      const s = sheetEl();
      const v = takeSheetExitV();
      if (!sheetHost || !s) {
        sheetShown = null;
        cardOff();
        return;
      }
      const end = () => {
        if (sheetShown === gone && !R.sheet) sheetShown = null;
      };
      if (reducedMotion()) {
        cardOff();
        sheetHost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: mo.DUR.rm, easing: 'linear', fill: 'forwards' }).onfinish = end;
        return;
      }
      const h = s.offsetHeight || 1;
      const y0 = new DOMMatrixReadOnly(getComputedStyle(s).transform).m42 || 0; // a drag's offset, or mid-present
      const o0 = scrimEl ? Number(getComputedStyle(scrimEl).opacity) : 1;
      for (const x of s.getAnimations()) x.cancel();
      if (scrimEl) for (const x of scrimEl.getAnimations()) x.cancel();
      const left = Math.max(1, h - y0);
      cardHeld = false;
      const c0 = cardNow(); // the page card, where the present / drag left it
      let a;
      if (v > 0) {
        // thrown on at the finger's speed (fling(), not a spring: a spring
        // aimed a whole sheet away jumped ~3× the finger's step, Wave 3)
        const sp = mo.fling(v, left, h);
        const o = /** @type {KeyframeAnimationOptions} */ ({ duration: sp.duration, easing: 'linear', fill: 'forwards' });
        a = s.animate(sp.frames.map(({ offset, p }) => ({ offset, transform: `translate3d(0,${y0 + left * p}px,0)` })), o);
        const f = scrimEl?.animate(sp.frames.map(({ offset, p }) => ({ offset, opacity: o0 * (1 - p) })), o);
        // the finger was moving in the frame before: no repeated frame at the hand-off
        a.currentTime = 16;
        if (f) f.currentTime = 16;
        cardBack(sp.frames.map(({ offset, p }) => ({ offset, p: c0 * (1 - p) })), { duration: sp.duration, easing: 'linear' }, 16);
      } else {
        const o = /** @type {KeyframeAnimationOptions} */ ({ duration: mo.DUR.sheetOut, easing: mo.EASE.dismiss, fill: 'forwards' });
        a = s.animate([{ transform: `translate3d(0,${y0}px,0)` }, { transform: `translate3d(0,${h}px,0)` }], o);
        scrimEl?.animate([{ opacity: o0 }, { opacity: 0 }], { duration: mo.DUR.sheetOut, easing: 'linear', fill: 'forwards' });
        cardBack([{ offset: 0, p: c0 }, { offset: 1, p: 0 }], { duration: mo.DUR.sheetOut, easing: mo.EASE.dismiss });
      }
      a.onfinish = end;
    }
  });

  const SheetComp = $derived(sheetShown ? sheets[sheetShown.name] : null);

  /* ------------------------------------------------------------- login ---- */
  /* Login as a modal (LGN-02 / NAV-16): "Add account" slides up over the app
   * and Cancel slides it back down; a first-run / signed-out Login (it is the
   * whole app then) appears at once and fades out on a sign-in that doesn't
   * reload. `adding` is caught at open: closeLoginModal() clears it before
   * the outro runs. Reduced motion: a fade. */
  let loginSlides = false;
  const easeDismiss = mo.easeDismiss; // EASE.dismiss as a JS easing
  /** @type {VR.TransitionFn} */
  function loginIn() {
    loginSlides = !!S.addingAccount;
    if (!loginSlides) return { duration: 0 };
    if (mo.reducedMotion()) return { duration: mo.DUR.rm, css: (t) => `opacity:${t}` };
    return { duration: mo.DUR.sheet, easing: mo.easeSheet, css: (t, u) => `transform:translate3d(0,${u * 100}%,0)` };
  }
  /** @type {VR.TransitionFn} */
  function loginOut() {
    // DUR.rm itself: rmOut() is 1 ms under Reduce Motion (it cut the fade)
    if (mo.reducedMotion()) return { duration: mo.DUR.rm, css: (t) => `opacity:${t}` };
    if (!loginSlides) return { duration: mo.DUR.base, css: (t) => `opacity:${t}` };
    return { duration: mo.DUR.sheetOut, easing: easeDismiss, css: (t, u) => `transform:translate3d(0,${u * 100}%,0)` };
  }
</script>

<!-- the presenting page (SHT-03): recedes into a card behind a large sheet -->
<div class="presenter" bind:this={presEl}>
<div class="stage" bind:this={stage} use:edgeSwipeBack={swipe} onscrollcapture={onScroll}>
  {#if shell}
    {#each TABS.filter((t) => R.visited[t]) as tab (tab)}
      {#each R.stacks[tab] as route, i (route.key)}
        {@const Screen = screens[route.name]}
        {@const isTop = i === R.stacks[tab].length - 1}
        {@const active = tab === R.tab && isTop}
        <section
          class="route {i ? 'route--deep' : ''}"
          data-key={route.key}
          data-route={route.name}
          hidden={!shown(tab, route, isTop)}
          inert={!active || !!R.modal || !!R.sheet || undefined}
          out:leave={{ key: route.key }}
        >
          {#if Screen}<Screen params={route.params} active={active && !R.modal} />{/if}
        </section>
      {/each}
    {/each}
  {/if}
  <div class="stage__edge" bind:this={edgeEl} aria-hidden="true"></div>
</div>

{#if shell}<div class="tabbarhost" hidden={!barShown || undefined} inert={!!R.modal || !!R.sheet || !atRoot || undefined}><TabBar /></div>{/if}

<OfflineBanner raised={atRoot} />
</div>

{#if sheetShown && SheetComp}
  <div class="scrim" bind:this={scrimEl} onclick={closeSheet} role="presentation"></div>
  <div class="sheethost" bind:this={sheetHost}>
    {#key sheetShown.key}<SheetComp params={sheetShown.params} />{/key}
  </div>
{/if}

<!-- transparent and click-through: Player shows/hides itself, so it can fade
     in and out over the page (PLY-01) -->
<div class="playerhost">
  <Player open={R.modal === 'player'} />
</div>

{#if R.modal === 'login'}
  <div class="loginhost" in:loginIn out:loginOut><Login /></div>
{/if}

<Toast noTabbar={!!R.modal || !shell || !atRoot} aboveBanner={conn.offline && !R.modal && shell} />

<ActionSheet />
