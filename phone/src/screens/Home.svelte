<script>
  /* Home — hero carousel + rails (design screens/02-home*.html).
   *
   * Data logic ported from the TV's src/screens/Home.svelte:
   *   Continue Watching  /UserItems/Resume
   *   Next Up            /Shows/NextUp, minus series already in Continue Watching
   *                      (counted before the hide filter, as on the TV)
   *   Recently added     /Items/Latest (movies; shows)
   *   Trending           mlTrending via lookup.svelte.js (session cache), tiles open
   *                      through lookupOpener() like the TV's rails / Search
   *   Remove from CW/NU  homehide.js (local, per account) + toast with Undo
   *
   * The screen stays mounted for the session (phone router), so instead of the
   * TV's remount-per-visit it refetches the play-state rails when the player
   * modal closes (R.playerClosed), after a watched toggle, when it comes back
   * into view after a while — and, with no gesture, whenever
   * lib/freshness.svelte.js sees the library change on the server (added,
   * watched elsewhere, an import landing; it also asks on every return to the
   * foreground): only the rails it touches, applied once the finger is off the
   * screen, scroll kept. A rail whose answer matches what is shown (same
   * items, positions, art: railSig) isn't touched at all.
   *
   * Cold start: Home paints synchronously from the last session's snapshot
   * (lib/homesnap.svelte.js, seeded into the api.js store) and the live
   * answers replace it the way a background change does. While `stale`, a
   * Continue Watching / Next Up / hero start waits for the live item (a
   * snapshot item has no MediaSources). Every rail change animates the same
   * way: a new tile grows in, a removed one shrinks away, the rest glide
   * (flip), and a rail that empties folds its height (polish HOME-03/04). */
  import { onMount, onDestroy, untrack, tick } from 'svelte';
  import { flip } from 'svelte/animate';
  import { slide } from 'svelte/transition';
  import TopBar from '../components/TopBar.svelte';
  import Tile from '../components/Tile.svelte';
  import Rail from '../components/Rail.svelte';
  import Button from '../components/Button.svelte';
  import ProgressBar from '../components/ProgressBar.svelte';
  import Skeleton from '../components/Skeleton.svelte';
  import LoadError from '../components/LoadError.svelte';
  import StateMessage from '../components/StateMessage.svelte';
  import ContextMenu from '../components/ContextMenu.svelte';
  import { R } from '../lib/router.svelte.js';
  import { scrollPast, pullStretch } from '../lib/gestures.js';
  import { onLibraryChange, rebase, whenSettled, keepScroll } from '../lib/freshness.svelte.js';
  import { reducedMotion, rm, rmOut, DUR, easeSheet } from '../lib/safe.js';
  import { avgColor, blurFor } from '../lib/blurhash.js';
  import { seedHome, saveHome, homeSnap } from '../lib/homesnap.svelte.js';
  import { HeroCarousel, heroArt } from '../lib/carousel.js';
  import { conn } from '../lib/conn.svelte.js';
  import { cfg } from '$lib/config.js';
  import { api, qs, imgUrl, revalidate, cached, empty, errText, itemPath, ITEM_FIELDS } from '$lib/api.js';
  import { ticksToSec, yearOf } from '$lib/format.js';
  import { S, openItem, openLogin, openSearch } from '$lib/nav.svelte.js';
  import { playItem, playFromHome, videoEl } from '$lib/player.svelte.js';
  import { setPlayed } from '$lib/played.js';
  import { hiddenFilter, hideFromHome } from '$lib/homehide.js';
  import { toast } from '$lib/toast.svelte.js';
  import { onReconnect } from '$lib/reconnect.js';
  import { trending as trend, refreshTrending, lookupOpener, inLibrary, addState, addToLibrary, lookupGroup } from '$lib/lookup.svelte.js';
  import { pendingGroups, matchGroup, tileStatus } from '$lib/activity.svelte.js';
  import { posterThumb } from '$lib/medialib.js';

  let { params = {}, active = false } = $props();

  /* ------------------------------------------------------------ data ---- */
  const uid = cfg.userId;
  const IMG = 'Primary,Backdrop,Thumb';
  const LATEST_FIELDS = 'Genres,ProductionYear,PremiereDate,ProviderIds,RunTimeTicks,Overview';
  const U = {
    resume: '/UserItems/Resume' + qs({ userId: uid, Limit: 16, MediaTypes: 'Video', Fields: ITEM_FIELDS, EnableImageTypes: IMG }),
    nextup:
      '/Shows/NextUp' +
      qs({ UserId: uid, Limit: 16, Fields: ITEM_FIELDS, EnableImageTypes: IMG, EnableResumable: false, EnableRewatching: false }),
    movies: '/Items/Latest' + qs({ userId: uid, Limit: 16, IncludeItemTypes: 'Movie', Fields: LATEST_FIELDS, EnableImageTypes: IMG }),
    shows: '/Items/Latest' + qs({ userId: uid, Limit: 16, IncludeItemTypes: 'Series', Fields: LATEST_FIELDS, EnableImageTypes: IMG })
  };

  let loading = $state(true);
  let failed = $state(null); // the error when both core rails failed with nothing painted
  let retrying = $state(false);
  let painted = $state(false);
  let dead = false;
  let gen = 0;
  let lastLoad = 0;

  /* raw: a repaint replaces a rail (or keeps it, see keep()), never mutates
   * it — deep proxies over ~16 items with MediaSources each bought nothing */
  let resume = $state.raw([]);
  let nextUp = $state.raw([]);
  let movies = $state.raw([]);
  let shows = $state.raw([]);
  let lastRaw = null; // unfiltered server answer: removals / undo repaint from it
  let snapTrend = $state.raw({}); // the snapshot's Trending lists, until the live ones land
  const trendShows = $derived(trend.tv || snapTrend.tv || []);
  const trendMovies = $derived(trend.movie || snapTrend.movie || []);

  function paint(r) {
    lastRaw = r;
    homeSnap.shown = true;
    const hidden = hiddenFilter();
    const all = r.resume?.Items || [];
    resume = keep(resume, all.filter((i) => !hidden.cw(i)));
    const watching = new Set(all.map((i) => i.SeriesId).filter(Boolean));
    nextUp = keep(nextUp, (r.nextup?.Items || []).filter((i) => !watching.has(i.SeriesId) && !hidden.nu(i)));
    movies = keep(movies, arr(r.movies));
    shows = keep(shows, arr(r.shows));
  }
  const arr = (d) => (Array.isArray(d) ? d : d?.Items || []);

  /* What a tile or the hero shows of an item: a repaint keeps the old object
   * of an item whose signature didn't change, and the old array when none
   * did — Svelte then has nothing to reconcile (no flip measuring every tile,
   * no prop updates). Every repaint used to rebuild all four rails as deep
   * proxies, and a background check compared them by JSON.stringify of whole
   * items, MediaSources included (~200 KB a rail, twice). Plays never read
   * a rail's copy for its MediaSources: they take lastRaw's (currentItem). */
  const ud = (u) => (u ? [u.PlaybackPositionTicks, u.PlayedPercentage, u.Played, u.UnplayedItemCount] : 0);
  const itemSig = (it) =>
    JSON.stringify([
      it.Id, it.Type, it.Name, it.SeriesName, it.SeriesId, it.IndexNumber, it.ParentIndexNumber, it.RunTimeTicks,
      it.ProductionYear, it.PremiereDate, it.Genres?.[0], it.ImageTags, it.BackdropImageTags?.[0],
      it.ParentBackdropImageTags?.[0], it.ParentThumbImageTag, it.SeriesPrimaryImageTag, it.ProviderIds,
      !!it.ImageBlurHashes, !!it.MediaSources, ud(it.UserData)
    ]);
  const sigs = new WeakMap(); // item → itemSig (answers are never mutated)
  function sigOf(it) {
    let x = sigs.get(it);
    if (x === undefined) sigs.set(it, (x = itemSig(it)));
    return x;
  }
  const railSig = (d) => arr(d).map(sigOf).join('\n');
  function keep(prev, next) {
    const old = new Map(prev.map((i) => [i.Id, i]));
    let changed = prev.length !== next.length;
    const out = next.map((it, k) => {
      const o = old.get(it.Id);
      if (!o || sigOf(o) !== sigOf(it)) return (changed = true), it;
      if (prev[k] !== o) changed = true;
      return o;
    });
    return changed ? out : prev;
  }

  /* ---- the last session's Home, painted before the first frame (HOME-03) */
  const PATHS = Object.values(U);
  let stale = $state(false); // painted from the snapshot; the live answers haven't landed
  {
    const snap = seedHome(PATHS);
    const rs = cached(U.resume), nu = cached(U.nextup);
    if (snap && (rs || nu)) {
      snapTrend = snap.trend;
      paint({ resume: rs || empty(), nextup: nu || empty(), movies: cached(U.movies), shows: cached(U.shows) });
      painted = true;
      loading = false;
      stale = true;
      lastLoad = Date.now(); // the live load is on its way (onMount)
    }
  }
  const snapTrendGet = { get tv() { return trend.tv || snapTrend.tv; }, get movie() { return trend.movie || snapTrend.movie; } };
  const save = () => saveHome(PATHS, snapTrendGet);

  /* A start from a Continue Watching / Next Up item waits for the live answer
   * while Home shows the snapshot: whenLive() → true once it landed. */
  let inflight = 0;
  let liveWaiters = [];
  function whenLive() {
    if (!stale) return Promise.resolve(true);
    if (!inflight) loadFailed();
    return new Promise((res) => liveWaiters.push(res));
  }
  function settleLive(ok) {
    const w = liveWaiters;
    liveWaiters = [];
    for (const res of w) res(ok);
  }
  /* the current copy of a play-state item: a live one carries MediaSources,
   * a snapshot one doesn't (its rail's live answer failed) */
  function currentItem(id) {
    for (const k of ['resume', 'nextup']) {
      const x = (lastRaw?.[k]?.Items || []).find((i) => i.Id === id);
      if (x) return x;
    }
    return null;
  }
  /* iOS lifts the <video>'s gesture restriction on a load() inside the tap —
   * the engine does it in play(), which a wait for the live item delays past
   * the tap, so do it here (same guard as play()) */
  function primeVideo() {
    const v = videoEl();
    if (v && !v.getAttribute('src')) {
      try {
        v.load();
      } catch {}
    }
  }
  let waiting = $state(null); // id of the item a start is waiting for (pressed look)
  async function playLive(it, start) {
    if (conn.offline) return;
    if (!stale) {
      // a menu opened over the snapshot may hold its (MediaSources-less) copy
      const x = currentItem(it.Id);
      return start(x?.MediaSources ? x : it);
    }
    primeVideo();
    const ep = S.epoch;
    waiting = it.Id;
    const ok = await whenLive();
    if (waiting === it.Id) waiting = null;
    if (dead || S.epoch !== ep) return;
    const x = ok ? currentItem(it.Id) : null;
    if (x?.MediaSources) return start(x);
    toast(ok && !x ? '“' + titleOf(it) + '” isn’t in progress any more' : 'Couldn’t reach the server');
  }

  /* Each grab resolves to { d } or { d: last copy | empty, e } — a failure is
   * told apart from an empty rail. The last copy keeps its `e`: at a cold
   * start it is the snapshot's (no MediaSources, days-old positions), and a
   * failed load that passed it off as live cleared `stale` — a later tap then
   * resumed from the snapshot's position (REV-01). Timed out: a wedged
   * request must not spin forever. */
  function grab(k) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12000);
    return revalidate(U[k], { signal: ctl.signal })
      .then((d) => ({ d }))
      .catch((e) => ({ d: cached(U[k]) || (k === 'movies' || k === 'shows' ? [] : empty()), e }))
      .finally(() => clearTimeout(t));
  }

  /* Loads the Jellyfin rails (all of them unless `keys` says which).
   * Resolves true on success; a failure with something already painted keeps
   * the last good copy (no error card). */
  const KEYS = Object.keys(U);
  const failedKeys = new Set(); // rails whose last live answer failed (they show an older copy)
  async function load(keys = KEYS) {
    const mine = ++gen;
    inflight++;
    let ok = false;
    try {
      ok = await loadRails(mine, keys);
    } finally {
      inflight--;
    }
    if (mine === gen) settleLive(ok);
    return ok;
  }
  /* Retry just the rails that failed (all of them before the first answer):
   * one Next Up that keeps failing used to keep `stale` set, and with it a
   * reload of all four rails every 30 s. */
  const loadFailed = () => load(failedKeys.size ? [...failedKeys] : KEYS);
  async function loadRails(mine, keys) {
    const got = await Promise.all(keys.map(grab));
    if (dead || mine !== gen) return false;
    const a = Object.fromEntries(keys.map((k, i) => [k, got[i]]));
    // everything failed (a full load: both play-state rails) — nothing live to show
    if (keys === KEYS ? a.resume.e && a.nextup.e : got.every((x) => x.e)) {
      if (!painted) failed = (a.resume || got[0]).e;
      loading = false;
      return false;
    }
    failed = null;
    lastLoad = Date.now();
    const r = { ...lastRaw };
    for (const k of keys) {
      if (a[k].e) failedKeys.add(k);
      else failedKeys.delete(k);
      // a retry that failed again keeps what is shown; a full load takes the
      // last good copy (grab's fallback), as before
      if (!a[k].e || keys === KEYS || !lastRaw) r[k] = a[k].d;
    }
    if (stale) {
      /* over the snapshot: applied like a background change — once no finger
       * is down, what's under it kept in place, tiles gliding to their spots */
      await whenSettled();
      if (dead || mine !== gen) return false;
      const restore = keepScroll(page);
      paint(r);
      // a rail that failed still shows its snapshot copy: stay stale for it
      stale = failedKeys.has('resume') || failedKeys.has('nextup');
      rewarm();
      await tick();
      restore();
    } else {
      paint(r);
      rewarm(); // resolved hero items carry play state: resolve them again
    }
    painted = true;
    loading = false;
    save();
    return true;
  }

  // LoadError contract: return the promise, clear the error only on success
  async function retry() {
    retrying = true;
    try {
      await load();
    } finally {
      retrying = false;
    }
  }

  /* A change on the server (lib/freshness.svelte.js): re-read just those rails
   * in the background, then paint them once no finger is on the screen, with
   * what's under it kept in place. Rails whose answer didn't change aren't
   * touched. */
  let page = $state(null); // the .screen scroller
  async function quietLoad(keys) {
    if (loading || failed || dead || !lastRaw) return;
    // still on the snapshot (a rail's live answer failed): the change calls
    // for the whole live set, not a partial repaint over old copies (REV-01)
    if (stale) {
      if (!inflight) load();
      return;
    }
    const mine = gen;
    const got = await Promise.all(keys.map((k) => revalidate(U[k]).then((d) => [k, d], () => null)));
    if (dead || mine !== gen) return;
    await whenSettled();
    if (dead || mine !== gen || !lastRaw) return;
    const r = { ...lastRaw };
    let changed = false;
    for (const x of got) {
      if (!x) continue;
      failedKeys.delete(x[0]);
      // the fresh answer either way (its MediaSources are what a play takes);
      // a repaint only when something a tile shows changed
      if (railSig(x[1]) !== railSig(lastRaw[x[0]])) changed = true;
      r[x[0]] = x[1];
    }
    lastLoad = Date.now();
    if (!changed) {
      lastRaw = r;
      return;
    }
    const restore = keepScroll(page);
    paint(r);
    rewarm(); // resolved hero items carry play state
    await tick();
    restore();
    save();
  }
  onDestroy(
    onLibraryChange((c) => {
      const k = new Set();
      if (c.movie) k.add('movies');
      if (c.tv) k.add('shows').add('nextup');
      if (c.played || c.progress) k.add('resume');
      if (c.played) {
        k.add('nextup');
        k.add(c.type === 'tv' ? 'shows' : 'movies'); // watched ticks, the hero's unwatched pick
      }
      if (k.size) quietLoad([...k]);
    })
  );

  onMount(() => {
    load();
    for (const t of ['tv', 'movie']) refreshTrending(t, 10 * 60 * 1000).catch(() => {});
  });
  // fresh Trending lists go into the snapshot too
  $effect(() => {
    if ((trend.tv || trend.movie) && untrack(() => painted && !stale)) untrack(save);
  });
  onDestroy(() => (dead = true));

  /* Back online / in front / every 30 s: the error card retries; a rail that
   * failed retries alone. Painted from the snapshot and the live load failed
   * (offline start): back online, replace it (REV-01). A return after a long
   * time away no longer reloads every rail: freshness.svelte.js asks the
   * server on every return to the foreground and revalidates exactly the
   * rails that moved (any play elsewhere moves its last-played marker —
   * position, watched, another item), so the full reload repeated that and
   * could race its quietLoad. Trending isn't Jellyfin's: it refreshes here. */
  onDestroy(
    onReconnect(
      (why, away) => {
        if (failed && !retrying) return retry();
        if ((stale || failedKeys.size) && !inflight && !conn.offline) return loadFailed();
        if (why === 'visible' && away > 10 * 60 * 1000) {
          for (const t of ['tv', 'movie']) refreshTrending(t, 60 * 60 * 1000).catch(() => {});
        }
      },
      { every: 30000 }
    )
  );

  /* the server is reachable again (App's checkServer / the banner's Retry —
   * iOS may never fire `online` when only the tailnet comes back): a Home
   * still showing the snapshot loads the live rails (REV-01) */
  $effect(() => {
    if (!conn.offline && untrack(() => stale && !inflight && !dead && !loading)) untrack(loadFailed);
  });

  /* play state changed underneath: the player closed (engine invalidated the
   * SWR entries on its Stopped), so revalidate */
  let seenClosed = R.playerClosed;
  $effect(() => {
    const n = R.playerClosed;
    if (n === seenClosed) return;
    seenClosed = n;
    untrack(() => (load(), (autoRuns = 0)));
  });

  /* back on the Home tab after a while (another client may have played on) */
  $effect(() => {
    if (!active) return;
    untrack(() => {
      if (painted && !loading && Date.now() - lastLoad > 60000) load();
    });
  });

  /* ------------------------------------------------------------ text ---- */
  function dur(sec) {
    const t = Math.max(1, Math.round(sec / 60));
    const h = Math.floor(t / 60);
    const m = t % 60;
    return h ? h + ' h' + (m ? ' ' + m + ' min' : '') : m + ' min';
  }
  const se = (it) => (it.ParentIndexNumber != null || it.IndexNumber != null ? `S${it.ParentIndexNumber ?? 0} · E${it.IndexNumber ?? 0}` : '');
  function leftOf(it) {
    const rem = ticksToSec(it.RunTimeTicks) - ticksToSec(it.UserData?.PlaybackPositionTicks);
    return rem > 0 ? dur(rem) + ' left' : '';
  }
  const isEp = (it) => it.Type === 'Episode';
  /* Continue Watching items are in progress by definition — a rewatch keeps
   * Played: true next to its resume point (a rewatched episode: "26 min left" over
   * an empty bar, plus a watched tick on the tile). Show the position anyway. */
  const pct = (it) => {
    const p = it.UserData?.PlayedPercentage;
    return p ? Math.min(100, p) / 100 : 0;
  };
  const join = (...a) => a.filter(Boolean).join(' · ');
  const cwSub = (it) => (isEp(it) ? join(se(it), leftOf(it)) : leftOf(it) || String(yearOf(it) || ''));
  /* the rail tiles put the sub on the title's line, so it is compact —
   * "S2 · E4 · 23m left", "1h 12m left", "S1 · E4 · 45m" */
  function short(sec) {
    const t = Math.max(1, Math.round(sec / 60));
    const h = Math.floor(t / 60);
    return h ? h + 'h' + (t % 60 ? ' ' + (t % 60) + 'm' : '') : t + 'm';
  }
  function leftShort(it) {
    const rem = ticksToSec(it.RunTimeTicks) - ticksToSec(it.UserData?.PlaybackPositionTicks);
    return rem > 0 ? short(rem) + ' left' : '';
  }
  const cwTileSub = (it) => (isEp(it) ? join(se(it), leftShort(it)) : leftShort(it) || String(yearOf(it) || ''));
  const nuTileSub = (it) => join(se(it), it.RunTimeTicks ? short(ticksToSec(it.RunTimeTicks)) : '');
  const titleOf = (it) => (isEp(it) ? it.SeriesName || it.Name : it.Name);
  const genreLine = (it) => join(String(yearOf(it) || ''), it.Genres?.[0]);
  const thumbOf = (it) => imgUrl(it, 'Thumb', { w: 760 }) || imgUrl(it, 'Backdrop', { w: 760 }) || imgUrl(it, 'Primary', { w: 760 });
  /* the loading placeholder takes the image's own colour (blurhash DC term) */
  const tintOf = (it, url) => avgColor(blurFor(it, url));
  const posterOf = (it) => imgUrl(it, 'Primary', { h: 540 }); // = Tile's own pick for a poster

  /* ------------------------------------------------------------ hero ---- */
  /* In progress first (Continue Watching), then what's new in the library,
   * five at most. A new series plays its next (first) episode, resolved ahead. */
  const slides = $derived.by(() => {
    // one slide per show: two half-watched episodes of one series made
    // two near-identical slides (the rail below still lists both)
    const out = [];
    const have = new Set();
    for (const it of resume) {
      if (out.length >= 3) break;
      const k = it.SeriesId || it.Id;
      if (have.has(k)) continue;
      have.add(k);
      out.push({ it, kind: 'cw' });
    }
    // interleave movies and shows so two of the same kind don't sit together
    const mix = [];
    const m = movies.filter((i) => !i.UserData?.Played);
    const s = shows.filter((i) => !i.UserData?.Played);
    for (let i = 0; mix.length < 5 && (i < m.length || i < s.length); i++) {
      if (s[i]) mix.push(s[i]);
      if (m[i]) mix.push(m[i]);
    }
    for (const it of mix) {
      if (out.length >= 5) break;
      if (have.has(it.Id)) continue;
      have.add(it.Id);
      out.push({ it, kind: 'new' });
    }
    return out;
  });

  let cur = $state(0);
  let curId = null;
  // keep the shown item across a refetch (its index may move)
  $effect.pre(() => {
    const list = slides;
    untrack(() => {
      const i = curId ? list.findIndex((s) => s.it.Id === curId) : -1;
      cur = i >= 0 ? i : Math.min(cur, Math.max(0, list.length - 1));
      curId = list[cur]?.it.Id || null;
    });
  });
  function go(i) {
    const n = slides.length;
    if (!n) return;
    cur = (i + n) % n;
    curId = slides[cur].it.Id;
    warm(cur);
    warm((cur + 1) % n);
  }
  /* At rest, backdrops are held for the settled slide and its two neighbours
   * only — the slides a swipe or auto-advance can reach next, decoded ahead
   * (no flash). The rest give theirs back (url null): a decoded 1920 backdrop
   * is ~8 MB, and every slide ever shown used to stay (~41 MB for five).
   * While auto-advance is still cycling every slide keeps its backdrop: the
   * ±1 window there re-requested and re-decoded each returning backdrop
   * (~60 ms main thread each at 4× throttle, +3.7 points CPU over the first
   * minute on Home, measured) for memory the rounds would claim back anyway. */
  const near = $derived.by(() => {
    const n = slides.length, k = new Set();
    const all = cycling();
    for (let d = 0; d < n; d++) if (all || d <= 1 || d === n - 1) k.add(slides[(cur + d) % n]?.it.Id);
    return k;
  });
  const heroBg = (it) => imgUrl(it, 'Backdrop', { w: 1920 }) || imgUrl(it, 'Primary', { h: 1080 });
  // the source of the slide's blurred copies (lib/carousel.js): 480 wide
  const heroBlur = (it) => imgUrl(it, 'Backdrop', { w: 480 }) || imgUrl(it, 'Primary', { w: 480 });

  /* The carousel follows the finger (lib/carousel.js): p moves continuously,
   * the backdrops blur/crossfade and the text crossfades as a function of it.
   * `cur` is the settled slide; `dom` the one nearer to p, whose buttons are
   * the only live ones mid-drag. */
  let dom = $state(0);
  let touching = $state(false);
  const car = new HeroCarousel({
    onsettle: (i, auto) => (go(i), auto && autoRuns++),
    ondominant: (i) => (dom = i),
    onbusy: (b) => ((touching = b), b && (autoRuns = 0))
  });
  $effect(() => {
    const n = slides.length, c = cur; // slides: repaint after a reorder too
    untrack(() => car.set(n, c));
  });

  /* auto-advance every --dur-hero (6 s) with the same transition (~700 ms),
   * paused while touching / off screen / menu or sheet up / reduced motion —
   * and over after two full rounds nobody touched (as the TV's marquee
   * settles after MQ_LOOPS): every glide is ~580 ms of main thread at 4× CPU
   * throttling, and an untouched Home on the hero kept the page at ~10 % CPU
   * for as long as it stayed open. A touch on the hero (swipe or tap), a
   * return to Home (tab, app in front again) or the player closing re-arms it. */
  const AUTO_ROUNDS = 2;
  let autoRuns = $state(0); // auto-advances since the last re-arm
  let ctx = $state(null);
  let pageHidden = $state(typeof document !== 'undefined' && document.hidden);
  $effect(() => {
    const vis = () => (pageHidden = document.hidden);
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  });
  $effect(() => {
    if (active && !pageHidden) autoRuns = 0;
  });
  // auto-advance has rounds left on a showing Home (near, above, reads it)
  const cycling = () => active && !pageHidden && !reducedMotion() && slides.length > 1 && autoRuns < AUTO_ROUNDS * slides.length;
  $effect(() => {
    void cur;
    // also held while a sheet is up (it moved behind the bell/accounts sheet)
    // and once the hero has scrolled away under the solid top bar
    if (!active || pageHidden || touching || ctx || R.sheet || solid || slides.length < 2 || reducedMotion()) return;
    if (autoRuns >= AUTO_ROUNDS * slides.length) return;
    const t = setTimeout(() => car.advance(), DUR.hero);
    return () => (clearTimeout(t), car.hold());
  });

  /* The full item a "new" slide plays: a movie's own item (the Latest answer
   * carries no MediaSources), a series' next (first) episode. Resolved ahead
   * so the tap starts playback synchronously (iOS media-gesture rule). */
  const full = new Map(); // id → item | Promise
  let fullTick = $state(0);
  function warm(i) {
    const s = slides[i];
    if (!s || s.kind !== 'new' || full.has(s.it.Id)) return;
    const it = s.it;
    const p = (
      it.Type === 'Series'
        ? api('/Shows/NextUp' + qs({ UserId: uid, SeriesId: it.Id, Limit: 1, Fields: ITEM_FIELDS, EnableResumable: true }))
            .then((r) => r.Items?.[0] || api('/Shows/' + it.Id + '/Episodes' + qs({ UserId: uid, Limit: 1, IsMissing: false, Fields: ITEM_FIELDS })).then((e) => e.Items?.[0]))
            .then((ep) => ep || null)
        : api(itemPath(it.Id))
    ).then(
      (x) => {
        full.set(it.Id, x);
        fullTick++;
        return x;
      },
      () => {
        full.delete(it.Id);
        return null;
      }
    );
    full.set(it.Id, p);
  }
  $effect(() => {
    if (slides.length) untrack(() => (warm(cur), warm((cur + 1) % slides.length)));
  });
  const ready = (it) => (void fullTick, full.get(it.Id));
  /* after a repaint: resolve the hero's items again (they carry play state).
   * The effect above only re-runs when the slides change — a repaint that
   * kept every rail doesn't — and a tap must find its item resolved. */
  function rewarm() {
    full.clear();
    fullTick++;
    const n = slides.length;
    if (n) (warm(cur), warm((cur + 1) % n));
  }

  let heroWait = $state(null);
  async function heroPlay(s) {
    if (conn.offline) return;
    if (s.kind === 'cw') {
      // the live copy (lastRaw's): a kept slide item may be an older object
      if (!stale) return playLive(s.it, (x) => playFromHome(x, 'hero'));
      heroWait = s.it.Id; // the Resume spinner while the live item lands
      await playLive(s.it, (x) => playFromHome(x, 'hero'));
      if (heroWait === s.it.Id) heroWait = null;
      return;
    }
    const ep = S.epoch; // navigated away while the item loads → don't start
    let x = full.get(s.it.Id);
    if (!x) {
      warm(slides.indexOf(s));
      x = full.get(s.it.Id);
    }
    if (x instanceof Promise) {
      heroWait = s.it.Id; // the item is still resolving: spinner on Play
      x = await x;
      heroWait = null;
    }
    if (dead || S.epoch !== ep) return;
    if (!x) return toast('Couldn’t start “' + s.it.Name + '”');
    const sec = ticksToSec(x.UserData?.PlaybackPositionTicks);
    playItem(x, sec > 30 ? Math.floor(sec) : 0);
  }
  function details(it) {
    if (isEp(it) && it.SeriesId) openItem(it.SeriesId, 'Series');
    else openItem(it.Id, it.Type);
  }

  /* ----------------------------------------------------- page chrome ---- */
  let solid = $state(false);
  let heroH = $state(0);
  const pastY = $derived(heroH ? Math.max(8, heroH - 400) : 8); // solid before the hero text slides under it
  const hasHero = $derived(!loading && !failed && slides.length > 0);
  // what stretches into the rubber-band gap above the hero (carousel.js
  // writes the transforms of the layers *inside* each media, never these)
  const STRETCH = ':scope > .homehero__media, :scope > .skel, :scope > .hero__scrim';

  /* ------------------------------------------------------ tile actions ---- */
  const playTile = (it) => playLive(it, (x) => playFromHome(x, 'tile-' + x.Id));

  function removeTile(kind, item) {
    if (!lastRaw) return;
    const undo = hideFromHome(kind, item);
    paint(lastRaw);
    toast('Removed from ' + (kind === 'cw' ? 'Continue Watching' : 'Next Up'), () => {
      undo();
      if (!lastRaw || dead) return;
      paint(lastRaw);
      // back in its rail: bring it into view (the track kept its scroll offset)
      tick().then(() =>
        document
          .querySelector(`.home [data-cell="${kind}-${item.Id}"]`)
          ?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' })
      );
    });
  }

  async function markPlayed(item, played) {
    try {
      await setPlayed(item.Id, played);
      if (dead) return;
      toast(played ? 'Marked as watched' : 'Marked as unwatched');
      rebase(); // our own change: repainted here, not again on the next check
      load();
    } catch (e) {
      toast('Couldn’t update “' + titleOf(item) + '”: ' + errText(e));
    }
  }

  function menuFor(kind, item) {
    const ep = isEp(item);
    if (kind === 'cw' || kind === 'nextup') {
      return [
        { label: 'Play from beginning', icon: 'restart', action: () => playLive(item, (x) => playItem(x, 0)), disabled: conn.offline },
        { label: ep ? 'Go to show' : 'Go to movie', icon: ep ? 'shows' : 'movies', action: () => details(item) },
        { label: 'Mark as watched', icon: 'check-circle', action: () => markPlayed(item, true) },
        { sep: true },
        {
          label: kind === 'cw' ? 'Remove from Continue Watching' : 'Remove from Next Up',
          icon: 'minus-circle',
          danger: true,
          action: () => removeTile(kind, item)
        }
      ];
    }
    const played = !!item.UserData?.Played;
    return [
      { label: played ? 'Mark as unwatched' : 'Mark as watched', icon: played ? 'x' : 'check-circle', action: () => markPlayed(item, !played) },
      { label: item.Type === 'Series' ? 'Go to show' : 'Go to movie', icon: item.Type === 'Series' ? 'shows' : 'movies', action: () => details(item) }
    ];
  }

  function openMenu(kind, item, detail) {
    ctx = { kind, item, rect: detail.rect, items: menuFor(kind, item) };
  }

  /* ------------------------------------------------ downloads / lookup ---- */
  function libDownload(item) {
    const type = item.Type === 'Series' ? 'tv' : 'movie';
    return matchGroup(pendingGroups(type), item);
  }

  /* lookupOpener() may search Jellyfin first (a title already in the library):
   * the tapped tile stays pressed meanwhile, so the tap visibly registered */
  let opening = $state(null); // key of the tile being opened
  async function openTrending(item) {
    if (opening) return;
    opening = item.type + item.id;
    const ep = S.epoch;
    try {
      const go = await lookupOpener(item);
      if (!dead && S.epoch === ep) go();
    } finally {
      opening = null;
    }
  }

  function dlOf(g) {
    if (!g) return null;
    const dl = g.status === 'downloading' || g.status === 'importing';
    return { status: dl ? 'downloading' : 'queued', p: g.status === 'importing' ? 1 : g.progress || 0, sub: tileStatus(g) };
  }
</script>

<main
  class="screen home {hasHero ? '' : 'screen--below-topbar'}"
  aria-busy={loading || undefined}
  bind:this={page}
  use:scrollPast={{ y: pastY, onchange: (s) => (solid = s) }}
>
  {#if loading && !painted}
    <section class="hero" aria-hidden="true" use:pullStretch={STRETCH}>
      <div class="skel skel--hero"></div>
      <div class="hero__scrim"></div>
      <div class="hero__body">
        <Skeleton kind="line" w="120px" h="10px" />
        <Skeleton kind="line-lg" w="220px" h="40px" />
        <Skeleton kind="line" w="160px" />
        <div class="hero__actions"><Skeleton kind="pill" w="132px" /><Skeleton kind="pill" w="104px" /></div>
      </div>
    </section>
    <section class="rail" aria-hidden="true">
      <div class="rail__head"><Skeleton kind="line" w="150px" h="14px" /></div>
      <div class="rail__track">
        <div class="tile tile--landscape"><Skeleton kind="thumb" /><Skeleton kind="line" w="120px" /></div>
        <div class="tile tile--landscape"><Skeleton kind="thumb" /><Skeleton kind="line" w="90px" /></div>
      </div>
    </section>
  {:else if failed}
    <LoadError
      title={failed.status === 401 || failed.status === 403 ? 'Jellyfin didn’t accept this sign-in' : 'Couldn’t reach the server'}
      reason={failed.network || failed.status >= 502
        ? new URL(cfg.server, location.href).host + ' didn’t answer. Check that Tailscale is on, then try again.'
        : ''}
      error={failed}
      {retry}
      busy={retrying}
      auto={false}
    >
      <Button variant="surface" onclick={() => openLogin(true)}>Switch server</Button>
    </LoadError>
  {:else}
    {#if slides.length}
      <section
        class="hero homehero"
        aria-roledescription="carousel"
        aria-label="Featured"
        bind:clientHeight={heroH}
        use:car.attach
        use:pullStretch={STRETCH}
      >
        <!-- backdrops: the blurhash, then pre-blurred copies under the sharp
             image, all driven by lib/carousel.js (opacity/transform only). The
             hash is there for every slide at once (it costs nothing); the
             image is held for the current slide and its neighbours. -->
        {#each slides as s, i (s.it.Id)}
          {@const bg = heroBg(s.it)}
          <div
            class="homehero__media"
            data-i={i}
            aria-hidden="true"
            use:heroArt={{ url: near.has(s.it.Id) ? bg : null, blur: heroBlur(s.it), hash: blurFor(s.it, bg) }}
          >
            <canvas class="homehero__hash"></canvas>
            <canvas class="homehero__blur"></canvas>
            <canvas class="homehero__blur"></canvas>
            <img class="homehero__sharp" alt="" />
          </div>
        {/each}
        <div class="hero__scrim"></div>
        {#each slides as s, i (s.it.Id)}
          {@const it = s.it}
          {@const on = i === dom}
          <div class="hero__body homehero__body" data-i={i} aria-hidden={!on} inert={!on || undefined}>
            <p class="hero__eyebrow">{s.kind === 'cw' ? 'Continue watching' : 'New in your library'}</p>
            <h1 class="hero__title">{titleOf(it)}</h1>
            <p class="hero__meta">{isEp(it) ? it.Name : genreLine(it) || ' '}</p>
            {#if s.kind === 'cw'}
              <div class="hero__progress">
                <ProgressBar p={pct(it)} /><span>{cwSub(it)}</span>
              </div>
            {/if}
            <div class="hero__actions">
              <Button
                variant="primary"
                icon="play"
                disabled={conn.offline || (s.kind === 'new' && ready(it) === null)}
                busy={heroWait === it.Id}
                onclick={() => heroPlay(s)}>{s.kind === 'cw' ? 'Resume' : 'Play'}</Button
              >
              <Button variant="glass" onclick={() => details(it)}>Details</Button>
            </div>
            {#if slides.length > 1}<div class="hero__dots homehero__dotslot"></div>{/if}
          </div>
        {/each}
        {#if slides.length > 1}
          <!-- one pager for all slides; each dot's width/colour follows p -->
          <div class="dots hero__dots homehero__dots" aria-hidden="true">
            {#each slides as d, j (d.it.Id)}<span class="dots__dot" data-i={j}></span>{/each}
          </div>
        {/if}
      </section>
    {:else if !movies.length && !shows.length}
      <StateMessage
        card
        icon="movies"
        title="Your library is empty"
        text="Add something from Trending below, or search for a title — it lands here as soon as it’s downloaded."
      >
        {#snippet actions()}<Button variant="primary" sm onclick={() => openSearch()}>Search titles</Button>{/snippet}
      </StateMessage>
    {/if}

    <!-- every rail: a new tile grows in, a removed one shrinks away, the rest
         glide (flip); a rail that empties folds its height, one that comes
         back unfolds (local transitions: nothing runs at first paint) -->
    {#if resume.length}
      <div class="home__rail" transition:slide={{ duration: rmOut(DUR.base), easing: easeSheet }}>
        <Rail title="Continue Watching">
          {#each resume as it (it.Id)}
            {@const img = thumbOf(it)}
            <div class="home__cell" data-cell="cw-{it.Id}" animate:flip={{ duration: rm(DUR.push), easing: easeSheet }} in:grow out:shrink>
              <Tile
                item={it}
                variant="landscape"
                {img}
                tint={tintOf(it, img)}
                sub={cwTileSub(it)}
                inline
                progress={pct(it)}
                watched={false}
                label="Play {titleOf(it)}"
                class={waiting === it.Id ? 'is-pressed' : ''}
                onclick={() => playTile(it)}
                onlongpress={(d) => openMenu('cw', it, d)}
              />
            </div>
          {/each}
        </Rail>
      </div>
    {/if}

    {#if nextUp.length}
      <div class="home__rail" transition:slide={{ duration: rmOut(DUR.base), easing: easeSheet }}>
        <Rail title="Next Up">
          {#each nextUp as it (it.Id)}
            {@const img = thumbOf(it)}
            <div class="home__cell" data-cell="nextup-{it.Id}" animate:flip={{ duration: rm(DUR.push), easing: easeSheet }} in:grow out:shrink>
              <Tile
                item={it}
                variant="landscape"
                {img}
                tint={tintOf(it, img)}
                sub={nuTileSub(it)}
                inline
                progress={0}
                label="Play {titleOf(it)}"
                class={waiting === it.Id ? 'is-pressed' : ''}
                onclick={() => playTile(it)}
                onlongpress={(d) => openMenu('nextup', it, d)}
              />
            </div>
          {/each}
        </Rail>
      </div>
    {/if}

    {#if movies.length}
      <div class="home__rail" transition:slide={{ duration: rmOut(DUR.base), easing: easeSheet }}>{@render latest('Movies', movies)}</div>
    {/if}
    {#if shows.length}
      <div class="home__rail" transition:slide={{ duration: rmOut(DUR.base), easing: easeSheet }}>{@render latest('Shows', shows)}</div>
    {/if}

    {#if trendShows.length}
      <div class="home__rail" transition:slide={{ duration: rmOut(DUR.base), easing: easeSheet }}>{@render trending('Shows', trendShows)}</div>
    {/if}
    {#if trendMovies.length}
      <div class="home__rail" transition:slide={{ duration: rmOut(DUR.base), easing: easeSheet }}>{@render trending('Movies', trendMovies)}</div>
    {/if}
  {/if}
</main>

<TopBar overlay {solid} />

<ContextMenu
  open={!!ctx}
  rect={ctx?.rect}
  items={ctx?.items || []}
  fit={ctx && (ctx.kind === 'cw' || ctx.kind === 'nextup') ? 'card' : 'rect'}
  label={ctx ? titleOf(ctx.item) : ''}
  onclose={() => (ctx = null)}
>
  {#snippet preview()}
    {#if ctx}
      {@const it = ctx.item}
      {#if ctx.kind === 'cw' || ctx.kind === 'nextup'}
        <Tile
          item={it}
          variant="landscape"
          fluid
          eager
          img={thumbOf(it)}
          progress={ctx.kind === 'cw' ? pct(it) : 0}
          watched={false}
          sub={isEp(it) ? join(se(it), it.Name, ctx.kind === 'cw' ? leftOf(it) : '') : cwSub(it)}
        />
      {:else}
        <Tile item={it} fluid eager />
      {/if}
    {/if}
  {/snippet}
</ContextMenu>

{#snippet latest(kind, items)}
  <Rail title="Recently Added" sub={kind}>
    {#each items as it (it.Id)}
      {@const g = libDownload(it)}
      <div class="home__cell" animate:flip={{ duration: rm(DUR.push), easing: easeSheet }} in:grow out:shrink>
        <Tile
          item={it}
          tint={tintOf(it, posterOf(it))}
          count={g && it.Type === 'Series' ? g.items.length : 0}
          badge={g && it.Type !== 'Series' ? { text: tileStatus(g), kind: 'gold' } : null}
          onclick={() => openItem(it.Id, it.Type)}
          onlongpress={(d) => openMenu('latest', it, d)}
        />
      </div>
    {/each}
  </Rail>
{/snippet}

{#snippet trending(kind, items)}
  <Rail title="Trending" sub={kind}>
    {#each items as it (it.type + it.id)}
      {@const own = inLibrary(it)}
      {@const st = addState(it)}
      {@const g = lookupGroup(it)}
      <!-- the year, never library status: the "+" alone marks what can be
           added, and answers a tap with a spinner, then a gold ✓ (LIB-02) -->
      <div class="home__cell" animate:flip={{ duration: rm(DUR.push), easing: easeSheet }} in:grow out:shrink>
        <Tile
          title={it.title}
          sub={it.year ? String(it.year) : ''}
          img={posterThumb(it.poster) || null}
          download={dlOf(g)}
          addState={g ? null : st}
          onadd={!own && !g && (st === 'idle' || st === 'error') ? () => addToLibrary(it) : null}
          class={opening === it.type + it.id ? 'is-pressed' : ''}
          onclick={() => openTrending(it)}
        />
      </div>
    {/each}
  </Rail>
{/snippet}

<script module>
  import { rm as rmMs, rmOut as rmOutMs, DUR as D, easeIn, easeOut } from '../lib/safe.js';

  /* UICollectionView's vocabulary for a rail change (HOME-04). A removed tile
   * fades and shrinks in place (Svelte takes an outroing animated cell out of
   * the flow — position: absolute — so width can't fold; flip glides the rest
   * into its gap). Reduce Motion: gone at once (rmOut: never 0 in an outro,
   * see App.svelte). */
  function shrink() {
    return { duration: rmOutMs(D.fast), easing: easeIn, css: (t) => `opacity:${t}; transform: scale(${0.86 + 0.14 * t})` };
  }
  /* a new tile fades and grows in, a beat after its neighbours start making
   * room (local: never at first paint) */
  function grow() {
    return { duration: rmMs(D.base), delay: rmMs(D.press), easing: easeOut, css: (t) => `opacity:${t}; transform: scale(${0.9 + 0.1 * t})` };
  }
</script>
