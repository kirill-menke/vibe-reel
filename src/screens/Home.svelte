<script module>
  /* The hero's last rail pick, kept across remounts: a Back from a detail page
   * restores it before the first paint (see `restored` below). */
  /** @type {VR.HomeLastPick | null} */
  let lastPick = null;
</script>

<script>
  import { decoded } from '../lib/decoded.js';
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import TopNav from '../components/TopNav.svelte';
  import Loading from '../components/Loading.svelte';
  import LoadError from '../components/LoadError.svelte';
  import Rail from '../components/Rail.svelte';
  import LookupTile from '../components/LookupTile.svelte';
  import Icon from '../components/Icon.svelte';
  import { cfg } from '../lib/config.js';
  import { qs, empty, imgUrl, cached, revalidate, errText, ITEM_FIELDS } from '../lib/api.js';
  import { fmtRuntime, fmtTime, ticksToSec, yearOf } from '../lib/format.js';
  import { heroBadges } from '../lib/tracks.js';
  import { S, openItem, takeHomeFocus, peekHomeFocus, openLogin, openLibrary } from '../lib/nav.svelte.js';
  import { loginOpts } from './Login.svelte';
  import { lookupOpener, trending as trend, refreshTrending, lookupBackdrop, inLibrary } from '../lib/lookup.svelte.js';
  import { playItem, playFromHome } from '../lib/player.svelte.js';
  import { hiddenFilter, hideFromHome } from '../lib/homehide.js';
  import { toast } from '../lib/toast.svelte.js';
  import { focusKey, focusKeyInstant, focusEl, scrollElTo } from '../lib/focus.js';
  import { onReconnect } from '../lib/reconnect.js';

  let loading = $state(true);
  /* ---- Jellyfin unreachable ----
   * `failed` is set when BOTH core rails failed with nothing cached — that is
   * "can't reach the server", not "nothing to watch", and used to render as a
   * blank black screen. retryCore re-runs just the fetches (set in onMount). */
  let failed = $state(/** @type {{ title: string, reason: string } | null} */ (null));   // { title, reason } | null
  let retrying = $state(false);
  /** @type {(() => Promise<void>) | null} */
  let retryCore = null;

  async function retry() {
    if (retrying || !retryCore) return;
    retrying = true;
    try {
      await retryCore();
    } finally {
      retrying = false;
    }
  }

  /* Recover without a button press: the "Can't reach Jellyfin" card retries
   * itself when the network returns / the app is resumed / every 30 s, and a
   * Home that was parked for over 10 min refreshes its rails on resume (the
   * TV keeps the webview for days — Continue Watching would still show last
   * week's positions). core() keeps focus and the last good copy on failure. */
  const PARKED_MS = 10 * 60 * 1000;
  onDestroy(
    onReconnect(
      (why, away) => {
        if (!retryCore || retrying) return;
        if (failed) {
          // a failed core() re-focuses Retry: don't pull the D-pad off the tab row on the timer
          const f = /** @type {HTMLElement | null} */ (document.activeElement)?.dataset?.focus;
          if (why !== 'tick' || !f || f === 'home-retry') return retry();
          return;
        }
        if (why === 'visible' && /** @type {number} */ (away) > PARKED_MS && !loading) return retryCore();
      },
      { every: 30000 }
    )
  );

  function changeServer() {
    loginOpts.server = true;   // Login opens with its server field showing
    openLogin(true);           // add-account mode: Back returns here, a failed change is rolled back
  }
  let resume = $state(/** @type {Jf.BaseItemDto[]} */ ([]));
  let nextUp = $state(/** @type {Jf.BaseItemDto[]} */ ([]));
  /* Trending rails, kept for the session in lookup.svelte.js: Home remounts on
   * every visit (S.epoch), and without the cache the rails would pop in late
   * below an already painted screen — and the tile a Back returns to
   * (takeHomeFocus) would not exist yet. */
  const trendShows = $derived(trend.tv || []);
  const trendMovies = $derived(trend.movie || []);

  /* ---- the hero follows the focused tile ----
   * `sel` is the rail tile the D-pad last settled on: { jf } a Jellyfin item,
   * or { lk, meta } a Trending result (Sonarr/Radarr metadata). With nothing
   * picked yet the hero is the first thing to continue. `railFocus` is true
   * while focus is in the rails: the hero then compacts into a sticky
   * billboard (smaller title, no buttons) and each rail snaps in right under
   * it, so the hero stays in view while you browse. */
  /* Back onto the rail tile the hero was showing: start from that pick, compact,
   * instead of painting the default hero and crossfading to the tile's own
   * backdrop ~250 ms + a 1920 decode later. A Jellyfin pick is re-matched by
   * Id when the rails paint (paint() below). */
  const restored = lastPick && lastPick.key === peekHomeFocus() ? lastPick : null;
  let sel = $state(restored ? restored.sel : null);
  let selBg = $state(restored ? restored.selBg : null);
  let railFocus = $state(!!restored);
  const hero = $derived(sel ? sel.jf || null : resume[0] || nextUp[0] || null);
  const heroLk = $derived(sel?.lk || null);
  const lkMeta = $derived(sel?.meta || null);
  const heroBg = $derived(heroLk ? selBg : hero ? jfBg(hero) : null);
  /* The backdrop crossfade is two permanent <img> layers and a CSS opacity
   * transition (.hero.home .backdrop img.on in style.css): a new backdrop goes
   * into the hidden layer, which then becomes the top, visible one. It used to
   * be {#key heroBg}<img transition:fade>, whose JS transition (getComputedStyle,
   * a 25-keyframe animate() per img, an element remount) cost ~6 ms of main
   * thread per swap on the TV, competing with the next D-pad press. A change
   * from or to no backdrop cuts instead of fading, exactly like the old {#if}. */
  let bgL = $state(/** @type {(string | null)[]} */ ([null, null]));
  let bgOn = $state(0);
  $effect.pre(() => {
    const u = heroBg;
    untrack(() => {
      const cur = bgL[bgOn];
      if (u === cur) return;
      if (!u || !cur) {
        bgL[bgOn] = u;
        bgL[bgOn ^ 1] = null;
        return;
      }
      bgL[bgOn ^ 1] = u;
      bgOn ^= 1;
    });
  });
  const heroKey = $derived(heroLk ? 'lk-' + heroLk.type + '-' + heroLk.id : hero?.Id || '');
  const heroUd = $derived(hero ? hero.UserData || {} : {});
  const heroResumeSec = $derived(ticksToSec(heroUd.PlaybackPositionTicks));
  const heroCanResume = $derived(heroResumeSec > 30);
  const heroPct = $derived(heroUd.PlayedPercentage ? Math.min(100, heroUd.PlayedPercentage) : 0);
  const heroIsEp = $derived(hero?.Type === 'Episode');
  const heroTitle = $derived(hero ? (heroIsEp ? hero.SeriesName || hero.Name : hero.Name) : '');

  /* The home hero is 880px tall and its buttons sit near its bottom, so
   * ensureVisible() — which only nudges the focused element far enough to clear
   * the viewport padding — parks the page mid-hero when focus comes back up from
   * the rails, cutting off the title and backdrop. Snap the whole billboard back
   * instead.
   *
   * Deferred to a microtask on purpose: focusin is dispatched *inside*
   * focusEl()'s el.focus(), i.e. before focusEl's own ensureVisible() and before
   * the window-level one in Keys.svelte, and whichever scrollBy() runs last wins
   * the retarget. A microtask runs after the whole focus turn has unwound, so
   * `0` is the target the shared animator actually glides to — and because it is
   * the same animator, this bends the in-flight motion instead of fighting it. */
  let opening = false;
  /** @param {Reel.LookupResult} item */
  async function openTrending(item) {
    if (opening) return;
    opening = true;
    try {
      (await lookupOpener(item))();
    } finally {
      opening = false;
    }
  }

  /** @param {FocusEvent} e */
  function heroFocus(e) {
    const page = /** @type {Element} */ (e.currentTarget).closest('.page');
    if (page) queueMicrotask(() => scrollElTo(page, 0));
  }

  /** @param {Jf.BaseItemDto} it @returns {string | null} */
  function jfBg(it) {
    return imgUrl(it, 'Backdrop', { w: 1920 }) || imgUrl(it, 'Primary', { h: 1080 });
  }

  /* Height of the compact hero (.hero.home.compact in style.css): the slot a
   * focused rail's top edge is scrolled to. */
  const COMPACT_H = 500;
  const TREND_MAX_AGE = 10 * 60 * 1000;   // see refreshTrending()
  const PICK_DELAY = 250;   // D-pad auto-repeat must not fetch a backdrop per tile
  let pickTimer = 0;
  let pickGen = 0;

  /** @param {string | null | undefined} key a rail tile's data-focus @returns {VR.HomePick | null} */
  function entryFor(key) {
    if (!key) return null;
    if (key.startsWith('tile-')) {
      const id = key.slice(5);
      const jf = resume.find((i) => i.Id === id) || nextUp.find((i) => i.Id === id);
      return jf ? { jf } : null;
    }
    if (key.startsWith('lk-')) {
      const lk = [...trendShows, ...trendMovies].find((i) => key === 'lk-' + i.type + '-' + i.id);
      return lk ? { lk } : null;
    }
    return null;
  }

  /* Swap only once the new backdrop is decoded (or after a short cap), so the
   * crossfade never fades in a half-loaded image. decode(), not onload: a
   * loaded-but-undecoded 1920 backdrop entering under the fade made the
   * compositor decode it (50–110 ms on the TV's workers) while the main thread
   * sat in WaitForCommitCompletion — measured a 56–107 ms long task on every
   * hero swap, i.e. D-pad presses stalled mid-rail. Decoded up front (off the
   * main thread, same cache entry the <img> then uses): no long task, worst
   * frame 33 ms. A failed decode (404, bad data) resolves just the same.
   *
   * It resolves from a task of its own (setTimeout 0), not from decode()'s
   * settlement: Chromium settles decode() inside a frame's animate step, so the
   * swap's Svelte flush (the {#key} info block, ~6–10 ms) ran *inside* that
   * BeginMainFrame and pushed it to 15–22 ms — one dropped frame per swap.
   * On its own task the flush and the frame each fit (TV at stock 60 Hz, 16 swaps
   * per run, 3 runs each, as a runtime decode() patch on the previous build:
   * 3.2–3.7% → 0.4–0.7% dropped frames). */
  /** @param {string | null} url @param {number} [cap] ms @returns {Promise<void>} */
  function preload(url, cap = 800) {
    if (!url) return Promise.resolve();
    return new Promise((res) => {
      const im = new Image();
      const t = setTimeout(res, cap);
      const done = () => {
        clearTimeout(t);
        setTimeout(res, 0);
      };
      im.src = url;
      im.decode().then(done, done);
    });
  }

  /** @param {string | null | undefined} key */
  function pick(key) {
    const entry = entryFor(key);
    if (!entry) return;
    const mine = ++pickGen;
    clearTimeout(pickTimer);
    pickTimer = setTimeout(async () => {
      let bg = null;
      if (entry.jf) {
        if (hero && hero.Id === entry.jf.Id && !heroLk) {
          lastPick = /** @type {VR.HomeLastPick} */ ({ key, sel: entry, selBg: null });
          return;
        }
        bg = jfBg(entry.jf);
      } else {
        if (heroLk && heroLk === entry.lk) {
          lastPick = /** @type {VR.HomeLastPick} */ ({ key, sel, selBg });
          return;
        }
        const r = await lookupBackdrop(entry.lk);
        if (mine !== pickGen) return;
        bg = r.bg;
        entry.meta = r.meta;
      }
      await preload(bg);
      if (mine !== pickGen) return;
      selBg = bg;
      sel = entry;
      lastPick = /** @type {VR.HomeLastPick} */ ({ key, sel: entry, selBg: bg });
    }, PICK_DELAY);
  }

  /* Focus moving within the page: into a rail → compact hero, pick the tile,
   * and snap the rail under the hero. Deferred for the same reason as
   * heroFocus (the last scroll retarget of the focus turn wins), plus a tick
   * so the measurement sees the compacted hero. Anywhere else (hero buttons,
   * the tab row) → the full hero again; a Trending pick has no Play, so it
   * gives way to the default item there. */
  /** @param {FocusEvent} e */
  function pageFocus(e) {
    const t = /** @type {HTMLElement | null} */ (e.target);
    const rail = t?.closest?.('.rails .rail');
    if (!rail) {
      railFocus = false;
      pickGen++;
      clearTimeout(pickTimer);
      // (with nothing to continue there is no default to fall back to — and
      // dropping the hero would remount the TopNav that focus just moved into)
      if (sel?.lk && (resume[0] || nextUp[0])) sel = null;
      return;
    }
    railFocus = true;
    pick(/** @type {HTMLElement} */ (t).dataset?.focus);
    const page = /** @type {HTMLElement} */ (rail.closest('.page'));
    queueMicrotask(async () => {
      await tick();
      if (!rail.isConnected || document.activeElement !== t) return;
      const pr = page.getBoundingClientRect();
      const rr = rail.getBoundingClientRect();
      scrollElTo(page, page.scrollTop + rr.top - pr.top - COMPACT_H);
    });
  }

  /* ▲ from the first rail: the hero's buttons are hidden while it is compact,
   * so geometry alone would skip them for the tab row. Expand it and land on
   * its primary button — which then acts on the item the hero shows. The rails
   * above any other rail are still in the DOM (scrolled under the hero), so
   * plain geometry handles those. */
  /** @param {KeyboardEvent} e */
  async function pageKey(e) {
    /* ▼ from the tab row onto the "Nothing to continue" card: it sits centred,
     * so geometry (3× orthogonal penalty) would jump past it to Trending. */
    if (e.keyCode === 40 && document.activeElement?.closest?.('.tabs')) {
      const b = document.querySelector('.homeempty .focus');
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      focusEl(b);
      return;
    }
    if (e.keyCode !== 38 || !railFocus) return;
    const rail = document.activeElement?.closest?.('.rails .rail');
    if (!rail || rail.previousElementSibling) return;
    if (sel?.lk && (resume[0] || nextUp[0])) sel = null;
    if (!hero) return; // no hero buttons: the tab row is the right target
    e.preventDefault();
    e.stopPropagation();
    pickGen++;
    clearTimeout(pickTimer);
    railFocus = false;
    await tick();
    // not the old .info still fading out after a hero swap: it is inert (F-006)
    focusEl(document.querySelector('.hero.home .info:not([inert]) .hero-cta .focus'));
  }

  onDestroy(() => clearTimeout(pickTimer));

  /* The last server answer, unfiltered: a removal (or its undo) repaints from
   * it without a refetch. */
  /** @type {VR.HomeRails | null} */
  let lastRaw = null;

  /** @param {VR.HomeRails} r */
  function paint(r) {
    lastRaw = r;
    const hidden = hiddenFilter();   // hold-OK removals (homehide.js)
    const allResume = r.resume.Items || [];
    resume = allResume.filter((i) => !hidden.cw(i));
    // A series with an episode in Continue Watching doesn't also need a Next Up
    // entry — finishing that episode is its next step. (Counted before the hide
    // filter: removing that episode must not surface its series in Next Up.)
    const watching = new Set(allResume.map((i) => i.SeriesId).filter(Boolean));
    nextUp = (r.nextup.Items || []).filter((i) => !watching.has(i.SeriesId) && !hidden.nu(i));
    // A revalidation replaces the items: the hero's pick follows its Id (its
    // Resume position may have moved), or falls back when it is gone.
    if (sel?.jf) {
      const n = resume.find((i) => i.Id === /** @type {{ jf: Jf.BaseItemDto }} */ (sel).jf.Id) || nextUp.find((i) => i.Id === /** @type {{ jf: Jf.BaseItemDto }} */ (sel).jf.Id);
      sel = n ? { jf: n } : null;
    }
  }

  /* ---- Continue Watching / Next Up tiles ----
   * OK plays at once (Continue Watching resumes; Back out of the player lands
   * on this tile again — player.svelte.js playFromHome). Hold OK removes the
   * tile from its rail: a local, per-account hide (homehide.js — Jellyfin has
   * no non-destructive server flag), undoable with ▶ while the toast is up. */
  /** @param {Jf.BaseItemDto} item */
  const playTile = (item) => playFromHome(item, 'tile-' + item.Id);

  const REMOVE_MS = 200;   // .strip .tile.gone in style.css

  /* Where focus goes when `el` leaves: the next tile, else the previous one,
   * else the first tile of the rail below (or above) — the rail itself is
   * about to disappear. */
  /** @param {Element} el @returns {Element | null} */
  function neighbourOf(el) {
    const sib = el.nextElementSibling || el.previousElementSibling;
    if (sib?.classList.contains('focus')) return sib;
    const rail = el.closest('.rail');
    for (const r of [rail?.nextElementSibling, rail?.previousElementSibling]) {
      const t = r?.querySelector('.strip .focus');
      if (t) return t;
    }
    return null;
  }

  async function refocusAfterRemove() {
    await tick();
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected) return;
    // the last tile of both rails went: the hero's button, or the
    // "Nothing to continue" card, or at worst the tab row
    for (const k of ['hero-resume', 'home-movies', 'tab-home']) if (await focusKey(k)) return;
  }

  /** @param {'cw' | 'nextup'} kind @param {Jf.BaseItemDto} item */
  function removeTile(kind, item) {
    const key = 'tile-' + item.Id;
    const el = document.querySelector('.rails [data-focus="' + key + '"]');
    if (!el || el.classList.contains('gone') || !lastRaw) return;
    const undo = hideFromHome(kind, item);
    const next = neighbourOf(el);
    el.classList.add('gone');
    el.classList.remove('focus');   // not a D-pad target while it collapses
    if (next) focusEl(next);
    setTimeout(() => {
      if (lastRaw) paint(lastRaw);
      refocusAfterRemove();
    }, REMOVE_MS);
    toast('Removed from ' + (kind === 'cw' ? 'Continue Watching' : 'Next Up'), () => {
      undo();
      // undone inside REMOVE_MS: the keyed tile is still the same element
      el.classList.remove('gone');
      el.classList.add('focus');
      if (!lastRaw) return;
      paint(lastRaw);
      focusKey(key);
    });
  }
  /** @param {Jf.BaseItemDto} item */
  const removeCw = (item) => removeTile('cw', item);
  /** @param {Jf.BaseItemDto} item */
  const removeNu = (item) => removeTile('nextup', item);

  onMount(async () => {
    const uid = cfg.userId;
    const U = {
      resume:
        '/UserItems/Resume' +
        qs({ userId: uid, Limit: 16, MediaTypes: 'Video', Fields: ITEM_FIELDS, EnableImageTypes: 'Primary,Backdrop,Thumb' }),
      /* The episode after the last one watched, per series. Resumable ones are
       * left out — they are already in Continue Watching — and so is anything
       * the user finished and never came back to within the server's
       * "Next Up" cutoff (a server setting, 365 days by default). */
      nextup:
        '/Shows/NextUp' +
        qs({
          UserId: uid, Limit: 16, Fields: ITEM_FIELDS, EnableImageTypes: 'Primary,Backdrop,Thumb',
          EnableResumable: false, EnableRewatching: false
        }),
    };

    /* Trending comes from the media-library service, not Jellyfin, and never
     * holds up the screen: its rails sit below the others and fill in when
     * the answer lands. A failure keeps the last list (or no rail at all). */
    for (const type of /** @type {Reel.MediaType[]} */ (['tv', 'movie'])) refreshTrending(type, TREND_MAX_AGE).catch(() => {});

    /* Focus stays on the Home tab — the screen never grabs it for the hero's
     * Resume button; ▼ is the user's own press. The explicit focus is still
     * required: the screen (TopNav included) is remounted on every tab switch
     * (S.epoch), so the button the click focused no longer exists. Coming
     * *back* from a detail screen is different: focus returns to the tile (or
     * hero button) it was opened from. */
    async function settle() {
      loading = false;
      const back = takeHomeFocus();
      if (back && (await focusKeyInstant(back))) return;
      /* Back out of a video started from a tile that has since left its rail
       * (finished → the series moved on to Next Up under another id): the head
       * of the rails, where the most recent thing to continue sits. */
      const head = back?.startsWith('tile-') && /** @type {HTMLElement | null} */ (document.querySelector('.rails .strip .focus'));
      if (head && (await focusKeyInstant(/** @type {string} */ (head.dataset.focus)))) return;
      await focusKey('tab-home');
    }

    /* Stale-while-revalidate, same deal as the library grid: App.svelte
     * remounts this screen on every tab switch (S.epoch, deliberate) and
     * Jellyfin marks nothing cacheable, so Home → Movies → Home used to mean a
     * second cold load behind the spinner.
     *
     * Home differs from the grid in that Continue Watching and Next Up *do*
     * show mutable state — a progress bar, a hero button that resumes at a
     * position read from this data, and which episode comes next. That is why
     * the video stop path and the watched toggle call invalidatePlayState()
     * (player.svelte.js) on these prefixes: after we ourselves change play
     * state, this cache is empty and Home reloads cold. What
     * is left is drift from *other* clients, which the revalidation below
     * repairs a few hundred ms after the paint.
     *
     * Both or none: a partial paint would pop the hero (and its focus
     * target) in late, which is worse than the spinner. */
    /** @type {{ resume: Jf.QueryResult | null, nextup: Jf.QueryResult | null }} */
    const hit = { resume: cached(U.resume), nextup: cached(U.nextup) };
    const warm = !!(hit.resume && hit.nextup);
    if (warm) {
      paint(/** @type {VR.HomeRails} both set: `warm` */ (hit));
      await settle();
    }

    /* One rail failing takes neither the screen nor the other rails down, and a
     * failed revalidation keeps whatever we already had rather than blanking
     * the rail — cached() still holds the last good copy, revalidate() only
     * stores on success. */
    /* Each grab resolves to { d } (data — fresh, or the last good copy) or
     * { d: empty, e } when it failed with nothing cached, so a failure can be
     * told apart from a genuinely empty rail. Timed out: a wedged request
     * must not leave the spinner up forever. */
    /** @param {keyof typeof U} k @returns {Promise<{ d: any, e?: VR.ApiError }>} */
    const grab = (k) => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 10000);
      return revalidate(U[k], { signal: ctl.signal })
        .then((d) => ({ d }))
        .catch((e) => {
          const c = cached(U[k]);
          return c ? { d: c } : { d: empty(), e };
        })
        .finally(() => clearTimeout(t));
    };
    let painted = warm;
    async function core() {
      const [rs, nu] = await Promise.all([grab('resume'), grab('nextup')]);
      if (rs.e && nu.e && !painted) {
        const e = rs.e;
        failed = {
          title: e.status === 401 || e.status === 403 ? 'Jellyfin didn’t accept this sign-in' : 'Can’t reach Jellyfin at ' + cfg.server,
          // the title already names the server; say what to check instead of repeating it
          reason: e.network ? 'Check that Jellyfin is running and that the TV is on the same network.' : errText(e)
        };
        loading = false;
        await focusKey('home-retry');
        return false;
      }
      failed = null;
      if (!(rs.e && nu.e)) {
        /* A revalidation that flips hero ⇄ "Nothing to continue" remounts the
         * TopNav (and can drop the hero buttons or a rail tile) under focus,
         * which then falls to <body> and the D-pad has nothing to move from.
         * Put it back on the same key, else on the Home tab. */
        const ae = /** @type {HTMLElement | null} */ (document.activeElement);
        const had = ae?.closest?.('.screen.home') ? ae.dataset?.focus : null;
        paint({ resume: rs.d, nextup: nu.d });
        if (had) {
          await tick();
          if (!/** @type {HTMLElement} */ (ae).isConnected && (document.activeElement === document.body || !document.activeElement)) {
            if (!(await focusKey(had))) await focusKey('tab-home');
          }
        }
      }
      return true;
    }
    retryCore = async () => {
      if (await core()) {
        painted = true;
        await settle();
      }
    };
    if ((await core()) && !warm) {
      painted = true;
      await settle();
    }
    S.ready = true;
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="screen home" onkeydown={pageKey}>
  <div class="page" onfocusin={pageFocus}>
    {#if loading}
      <!-- header first, so a tab switch never blanks it out — only the content
           area below is waiting -->
      <TopNav active="home" />
      <Loading />
    {:else if failed}
      <!-- the nav is the only way off a failed screen — Back from Home is a no-op -->
      <TopNav active="home" />
      <LoadError title={failed.title} reason={failed.reason} {retry} busy={retrying} retryKey="home-retry"
        fkey="home" under back={false} auto={false}
        ><button class="btn ghost big focus" data-focus="home-server" onclick={changeServer}>Change server</button></LoadError
      >
    {:else}
      {#if hero || heroLk}
        <div class="hero home" class:compact={railFocus}>
          <!-- two stacked layers: a new pick crossfades over the old one (bgL/bgOn
               above, .hero.home .backdrop img in style.css) -->
          <div class="backdrop">
            <img use:decoded={bgL[0]} alt="" class:on={bgOn === 0} /><img use:decoded={bgL[1]} alt="" class:on={bgOn === 1} />
          </div>
          <div class="scrim-l"></div>
          <div class="scrim-b"></div>
          <TopNav active="home" />
          {#key heroKey}
          <div class="info" transition:fade={{ duration: 220 }}>
            {#if heroLk}
              {@render lookupInfo(heroLk, lkMeta)}
            {:else}
            <div class="title">{heroTitle}</div>
            <div class="metarow">
              <span>{yearOf(/** @type {NonNullable<typeof hero>} */ (hero))}</span>
              {#if fmtRuntime((/** @type {NonNullable<typeof hero>} */ (hero)).RunTimeTicks)}<span class="dot">·</span><span>{fmtRuntime((/** @type {NonNullable<typeof hero>} */ (hero)).RunTimeTicks)}</span>{/if}
              {#if (/** @type {NonNullable<typeof hero>} */ (hero)).OfficialRating}<span class="dot">·</span><span class="fsk">{(/** @type {NonNullable<typeof hero>} */ (hero)).OfficialRating}</span>{/if}
              {#if (/** @type {NonNullable<typeof hero>} */ (hero)).CommunityRating}<span class="star">★ {(/** @type {NonNullable<typeof hero>} */ (hero)).CommunityRating.toFixed(1)}</span>{/if}
              {#if (/** @type {NonNullable<typeof hero>} */ (hero)).Genres?.length}<span class="dot">·</span><span class="genres">{(/** @type {NonNullable<typeof hero>} */ (hero)).Genres.slice(0, 2).join(' · ')}</span>{/if}
            </div>
            {#if heroBadges(/** @type {NonNullable<typeof hero>} */ (hero)).length}
              <div class="techbadges">
                {#each heroBadges(/** @type {NonNullable<typeof hero>} */ (hero)) as b (b)}<span class="chip">{b}</span>{/each}
              </div>
            {/if}
            <div class="overview">{(/** @type {NonNullable<typeof hero>} */ (hero)).Overview || ''}</div>
            <!-- only while the rails have focus (compact hero): every Jellyfin pick
                 there is a Continue Watching / Next Up tile -->
            {#if railFocus}<div class="railhint">OK to play · Hold OK to remove</div>{/if}
            <!-- buttons + progress bar share one shrink-wrapped column so the bar
                 measures exactly as wide as the button row, whatever the labels say -->
            <div class="hero-cta" onfocusin={heroFocus}>
              <div class="actions">
                <button
                  class="btn primary big focus"
                  data-focus="hero-resume"
                  onclick={() => playItem(/** @type {NonNullable<typeof hero>} */ (hero), heroCanResume ? Math.floor(heroResumeSec) : 0)}
                >▶ {heroCanResume ? 'Resume · ' + fmtTime(heroResumeSec) : 'Play'}</button>
                {#if heroCanResume}
                  <button class="btn ghost big focus" data-focus="hero-restart" onclick={() => playItem(/** @type {NonNullable<typeof hero>} */ (hero), 0)}
                    ><Icon name="restart" inline />Start over</button
                  >
                {/if}
                <button
                  class="btn ghost big focus"
                  data-focus="hero-info"
                  onclick={() => openItem((/** @type {NonNullable<typeof hero>} */ (hero)).Id, (/** @type {NonNullable<typeof hero>} */ (hero)).Type)}
                >More info</button>
              </div>
              {#if heroPct}<div class="resume-bar"><i style="width:{heroPct}%"></i></div>{/if}
            </div>
            {/if}
          </div>
          {/key}
        </div>
      {:else}
        <TopNav active="home" />
        <!-- nothing to continue (a new account, or everything watched): say so and
             offer the way on, instead of an 880px black gap above Trending -->
        <div class="failcard homeempty">
          <div class="t">Nothing to continue yet</div>
          <div class="s">Titles you start watching show up here. Pick something from your library to begin.</div>
          <div class="row">
            <button class="btn primary big focus" data-focus="home-movies" onclick={() => openLibrary('movies')}
              ><Icon name="film" inline />Browse Movies</button
            >
            <button class="btn ghost big focus" data-focus="home-shows" onclick={() => openLibrary('shows')}
              ><Icon name="tv" inline />Browse Shows</button
            >
          </div>
        </div>
      {/if}

      <div class="rails">
        {#if resume.length}<Rail title="Continue Watching" items={resume} kind="cw" onplay={playTile} onremove={removeCw} />{/if}
        {#if nextUp.length}<Rail title="Next Up" items={nextUp} kind="nextup" onplay={playTile} onremove={removeNu} />{/if}
        {#if trendShows.length}{@render trending('Trending · Shows', trendShows)}{/if}
        {#if trendMovies.length}{@render trending('Trending · Movies', trendMovies)}{/if}
      </div>
    {/if}
  </div>
</div>

<!-- The hero for a Trending pick: the same title / metarow / overview as a
     library item, from the lookup result plus its Sonarr/Radarr metadata. No
     buttons — it only ever shows while focus is in the rails. -->
{#snippet lookupInfo(/** @type {Reel.TrendingItem} */ it, /** @type {Reel.Metadata | null | undefined} */ meta)}
  <div class="title">{it.title}</div>
  <div class="metarow">
    {#if it.year}<span>{it.year}</span>{/if}
    {#if meta?.runtime_min}<span class="dot">·</span><span>{fmtRuntime(meta.runtime_min * 600000000)}</span>{/if}
    {#if meta?.certification}<span class="dot">·</span><span class="fsk">{meta.certification}</span>{/if}
    {#if it.rating || meta?.rating}<span class="star">★ {/** @type {number} */ (it.rating || /** @type {Reel.Metadata} */ (meta).rating).toFixed(1)}</span>{/if}
    {#if meta?.genres?.length}<span class="dot">·</span><span class="genres">{meta.genres.slice(0, 2).join(' · ')}</span>{/if}
  </div>
  <div class="techbadges"><span class="chip" class:watched={inLibrary(it)}>{inLibrary(it) ? 'In your library' : 'Not in your library'}</span></div>
  <div class="overview">{meta?.overview || it.overview || ''}</div>
{/snippet}

<!-- New titles doing well on IMDb (see mlTrending), as Search-style lookup
     tiles: OK opens the richest detail that exists — the Jellyfin one when the
     title is already in the library, else LookupDetail with Add to library. -->
{#snippet trending(/** @type {string} */ title, /** @type {Reel.TrendingItem[]} */ items)}
  <div class="rail">
    <h2>{title}</h2>
    <div class="strip">
      {#each items as item (item.type + item.id)}
        <LookupTile {item} onopen={openTrending} />
      {/each}
    </div>
  </div>
{/snippet}
