<script>
  /* A series' page — the phone layout of the TV's SeriesDetail: hero with
   * Resume/Play of the next-up episode, sticky season pills, episode rows with
   * watch state, and the not-yet-imported episodes of the download queue
   * interleaved as dimmed rows (a season that exists only in the queue gets
   * its own dim pill with its %). Tap an episode = play it (from its
   * progress); long-press = Play · Mark (un)watched · Mark E1–En · Mark
   * season; long-press a season pill = mark the season. Downloading/queued
   * rows aren't tappable; long-press one = Cancel download (with a confirm
   * step — cancel.svelte.js; a season pack goes as a whole).
   *
   * Request generations as on the TV: `seasonReq` guards the episode list
   * against a slower answer for a season the user already left, `dead` any
   * answer landing after the page was popped. */
  import { onDestroy, untrack, tick } from 'svelte';
  import NavBar from '../components/NavBar.svelte';
  import Button from '../components/Button.svelte';
  import ProgressBar from '../components/ProgressBar.svelte';
  import TechBadges from '../components/TechBadges.svelte';
  import Skeleton from '../components/Skeleton.svelte';
  import LoadError from '../components/LoadError.svelte';
  import ContextMenu from '../components/ContextMenu.svelte';
  import Icon from '../components/Icon.svelte';
  import DetailHero from '../components/detail/DetailHero.svelte';
  import MetaLine from '../components/detail/MetaLine.svelte';
  import ActionBar from '../components/detail/ActionBar.svelte';
  import Overview from '../components/detail/Overview.svelte';
  import CastRail from '../components/detail/CastRail.svelte';
  import SeasonPills from '../components/detail/SeasonPills.svelte';
  import EpisodeRow from '../components/detail/EpisodeRow.svelte';
  import { runtimeOf, leftOf, resumeSecOf, progressOf, techBadges, seLabel, pendStatus, dlOf, solidPoint, epTitle, lateIn } from '../components/detail/detail.js';
  import { scrollPast } from '../lib/gestures.js';
  import { safeInsets, reducedMotion, DUR, EASE } from '../lib/safe.js';
  import { cfg } from '$lib/config.js';
  import { api, errText, imgUrl, seasonsPath, nextUpPath, episodesPaths, startSeason, itemPath, prefetch } from '$lib/api.js';
  import { yearOf } from '$lib/format.js';
  import { P, playEpisode, playItem } from '$lib/player.svelte.js';
  import { S } from '$lib/nav.svelte.js';
  import { setPlayed } from '$lib/played.js';
  import { pickTrailer, openTrailer } from '$lib/trailer.js';
  import { toast } from '$lib/toast.svelte.js';
  import { act, pendingGroups, matchGroup } from '$lib/activity.svelte.js';
  import { isCancelling, packOf, cancelWhat, confirmItems, cancelItem } from '$lib/cancel.svelte.js';
  import { confirm, confirmMenu } from '../lib/confirm.svelte.js';
  import { mlMetadata } from '$lib/medialib.js';
  import { OFF, offlineSupported } from '../lib/offline.svelte.js';
  import { openSheet as openSheetR, push as pushRouteR } from '../lib/router.svelte.js';

  let { series, refresh = 0, active = false, late = false } = $props();

  let dead = false;
  onDestroy(() => {
    dead = true;
    seasonReq++;
    clearTimeout(importTimer);
    clearTimeout(staleTimer);
  });

  /* ---------------------------------------------------------------- data */
  let seasons = $state([]);
  let idx = $state(0);
  /* a queue-only season (no Jellyfin season yet) is selected: its number */
  let pidx = $state(null);
  let eps = $state([]);
  /* the season `eps` belongs to (its number, or the queue-only pidx): the
   * pending rows are merged by this, not by the selected season — while a
   * new season loads, the old list must not grow the new one's rows */
  let epsSeason = $state(null);
  let badgeEp = $state(null);
  let loading = $state(true);
  let seasonsErr = $state(null);
  let epErr = $state(null);
  let nextUp = $state(null);
  let seasonReq = 0;
  let nextReq = 0;

  function fetchEps(seasonId) {
    const [list, first] = episodesPaths(series.Id, seasonId);
    return Promise.all([api(list), api(first).catch(() => null)]).then(([r, b]) => ({
      items: r.Items || [],
      first: (b && b.Items && b.Items[0]) || null
    }));
  }

  /* `retry`: LoadError's retry — keep the card (and its error) until success.
   * `dir` (a user's pick, DET-06): +1 = a later season, −1 = an earlier one —
   * the old list dims if the answer takes > 120 ms, the new one slides in
   * from that side. */
  async function loadSeason(i, retry = false, dir = 0) {
    const req = ++seasonReq;
    const t0 = performance.now();
    idx = i;
    pidx = null;
    if (!retry) {
      epErr = null;
      loading = true;
    }
    clearTimeout(staleTimer);
    if (dir) staleTimer = setTimeout(() => req === seasonReq && loading && (stale = true), 120);
    const s = seasons[i] || seasons[0];
    try {
      const r = await fetchEps(s && s.Id);
      if (dead || req !== seasonReq) return;
      epErr = null;
      badgeEp = r.first || badgeEp;
      eps = r.items;
      epsSeason = s ? (s.IndexNumber ?? null) : null;
    } catch (e) {
      if (dead || req !== seasonReq) return;
      eps = [];
      epsSeason = s ? (s.IndexNumber ?? null) : null;
      epErr = e;
    } finally {
      if (!dead && req === seasonReq) {
        loading = false;
        clearTimeout(staleTimer);
        stale = false;
        /* the first list: dissolve it in only if its skeleton was up */
        if (dir || (!retry && performance.now() - t0 > 250)) listIn(dir);
      }
    }
  }

  /* ---- season switch motion (DET-06) ---- */
  let listEl = $state(null);
  let stale = $state(false);
  let staleTimer = 0;
  let listAnim = null;
  async function listIn(dir) {
    await tick();
    if (dead || !listEl) return;
    listAnim?.cancel();
    const rm = reducedMotion();
    const move = dir && !rm;
    listAnim = listEl.animate(
      [{ opacity: 0, transform: move ? `translateX(${dir * 12}px)` : 'none' }, { opacity: 1, transform: 'none' }],
      { duration: move ? DUR.base : DUR.rm, easing: EASE.out }
    );
  }
  /* touch-down on a pill: its episodes are usually in by the click */
  function warm(key) {
    if (key[0] !== 's') return;
    const s = seasons[+key.slice(1)];
    if (!s) return;
    for (const p of episodesPaths(series.Id, s.Id)) prefetch(p).catch(() => {});
  }

  async function loadSeasons() {
    try {
      const r = await api(seasonsPath(series.Id));
      if (dead) return;
      seasons = (r.Items || []).filter((s) => s.Type === 'Season');
      seasonsErr = null;
      await loadSeason(startSeason(seasons));
    } catch (e) {
      if (dead) return;
      seasonsErr = e;
      loading = false;
    }
  }

  function loadNext() {
    const req = ++nextReq;
    return api(nextUpPath(series.Id)) // usually warmed by Detail
      .then((r) => {
        if (!dead && req === nextReq) nextUp = (r.Items || [])[0] || null;
      })
      .catch(() => {});
  }

  /* Quiet refresh (after playback, a watched toggle, an import): re-list the
   * seasons keeping the selection by identity, the episodes on screen and the
   * next-up episode. Failures keep what is shown. */
  async function refreshAll() {
    loadNext();
    try {
      const r = await api(seasonsPath(series.Id));
      if (dead) return;
      const ns = (r.Items || []).filter((s) => s.Type === 'Season');
      const selId = pidx == null ? seasons[idx]?.Id : null;
      seasons = ns;
      if (selId) idx = Math.max(0, ns.findIndex((x) => x.Id === selId));
      else if (pidx != null) {
        const j = ns.findIndex((x) => x.IndexNumber === pidx);
        if (j >= 0) {
          idx = j;
          pidx = null;
        }
      }
      if (pidx == null && seasons[idx]) {
        const req = ++seasonReq;
        const er = await fetchEps(seasons[idx].Id);
        if (dead || req !== seasonReq) return;
        badgeEp = er.first || badgeEp;
        eps = er.items;
        epsSeason = seasons[idx]?.IndexNumber ?? null;
        epErr = null;
        loading = false;
      }
    } catch {
      /* keep the page as is */
    }
  }

  untrack(() => {
    loadSeasons();
    loadNext();
  });

  /* Detail re-read the series after the player closed: refresh the lists too */
  let seenRefresh = untrack(() => refresh);
  $effect(() => {
    if (refresh === seenRefresh) return;
    seenRefresh = refresh;
    untrack(refreshAll);
  });

  /* ---------------------------------------------------- download activity */
  const pend = $derived(matchGroup(pendingGroups('tv'), series));
  const pendEps = $derived(pend ? pend.items : []);
  let pendMeta = $state(null);
  let pendMetaFor = null;
  $effect(() => {
    const id = pend?.mediaId;
    if (!id || pendMetaFor === id) return;
    pendMetaFor = id;
    mlMetadata('tv', id)
      .then((m) => !dead && (pendMeta = m))
      .catch(() => {});
  });
  const epMeta = $derived.by(() => {
    const m = new Map();
    for (const e of pendMeta?.episodes || []) m.set(e.season + ':' + e.episode, e);
    return m;
  });
  const pendSeasons = $derived.by(() => {
    if (!pendEps.length) return [];
    const have = new Set(seasons.map((s) => s.IndexNumber));
    return [...new Set(pendEps.map((p) => p.season).filter((n) => n != null && !have.has(n)))].sort((a, b) => a - b);
  });

  /* real episodes + the not-yet-imported ones of the season they belong to */
  const rows = $derived.by(() => {
    const out = eps.map((e) => ({ k: 'e' + e.Id, e, n: e.IndexNumber ?? 0 }));
    if (epsSeason != null) {
      for (const p of pendEps) {
        if (p.season !== epsSeason) continue;
        if (p.episode != null && eps.some((e) => e.IndexNumber === p.episode)) continue;
        out.push({ k: 'p' + p.id, p, n: p.episode ?? 1e9 });
      }
      out.sort((a, b) => a.n - b.n);
    }
    return out;
  });

  /* Imports: a pending row leaves the feed before Jellyfin lists the real
   * episode — re-list after a pause for the library scan (3 s, 8 s, 20 s). */
  const IMPORT_DELAYS = [3000, 8000, 20000];
  let prevPend = new Set();
  let importTimer = 0;
  let importTries = 0;
  $effect(() => {
    const list = pendEps;
    const skip = act.stale || loading || !!seasonsErr;
    untrack(() => {
      const live = new Set(list.map((p) => p.id));
      const gone = !skip && [...prevPend].some((id) => !live.has(id));
      prevPend = live;
      if (!gone) return;
      importTries = 0;
      scheduleImport();
    });
  });
  function scheduleImport() {
    clearTimeout(importTimer);
    if (dead || importTries >= IMPORT_DELAYS.length) return;
    importTimer = setTimeout(() => {
      refreshAll();
      scheduleImport();
    }, IMPORT_DELAYS[importTries++]);
  }

  /* ---------------------------------------------------------- the header */
  const bg = $derived(imgUrl(series, 'Backdrop', { w: 1280 }) || imgUrl(series, 'Primary', { h: 1080 }));
  const trailer = $derived(pickTrailer(series));
  const genres = $derived((series.Genres || []).slice(0, 3).join(' · '));
  const yr = $derived(
    yearOf(series) + (series.Status === 'Continuing' ? '–' : series.EndDate && series.EndDate.slice(0, 4) != yearOf(series) ? '–' + series.EndDate.slice(0, 4) : '')
  );
  const nSeasons = $derived(seasons.filter((s) => (s.IndexNumber ?? 1) > 0).length);
  const badges = $derived(techBadges(badgeEp || series, series));
  const created = $derived((series.People || []).find((p) => /creator/i.test(p.Role || '')) || null);
  const overview = $derived((series.Overview || '') + (created ? ' Created by ' + created.Name + '.' : ''));
  const people = $derived((series.People || []).filter((p) => p.Type === 'Actor').slice(0, 14));

  /* the episode Resume/Play starts: NextUp, else the first unwatched (or the
   * first) of the season it opened on */
  const next = $derived(nextUp || eps.find((e) => !e.UserData?.Played) || eps[0] || null);
  const nextSec = $derived(next ? resumeSecOf(next) : 0);
  const nextResume = $derived(!!next && nextSec > 30 && !next.UserData?.Played);
  const sPlayed = $derived(!!series.UserData?.Played);
  let seriesUd = $state(null);
  const seriesWatched = $derived(seriesUd ? !!seriesUd.Played : sPlayed);

  function withCtx() {
    P.detailItem = series;
    P.series = series;
    P.seasons = seasons;
  }
  function playEp(id) {
    withCtx();
    playEpisode(id);
  }
  function startOver(e) {
    withCtx();
    const epoch = S.epoch; // Back (or another page) while the item loads → don't start
    api(itemPath(e.Id))
      .then((ep) => {
        if (dead || S.epoch !== epoch) return;
        if (!ep.Genres?.length) ep.Genres = series.Genres;
        playItem(ep, 0);
      })
      .catch((err) => !dead && S.epoch === epoch && toast('Couldn’t start this episode: ' + errText(err)));
  }

  /* optimistic once confirmed in the action sheet (DET-11): the tick flips (and pops)
   * at once, a failure puts it back with the toast; no spinner */
  let busyWatched = false;
  function toggleSeries() {
    if (busyWatched) return;
    const was = seriesUd;
    const want = !seriesWatched;
    busyWatched = true;
    seriesUd = { ...(seriesUd || series.UserData || {}), Played: want };
    setPlayed(series.Id, want)
      .then((ud) => {
        if (dead) return;
        seriesUd = ud || { Played: want };
        toast(want ? 'Marked the whole series as watched' : 'Marked the whole series as unwatched');
        refreshAll();
      })
      .catch((e) => {
        if (!dead) seriesUd = was;
        toast('Couldn’t update: ' + errText(e));
      })
      .finally(() => (busyWatched = false));
  }
  $effect(() => {
    void series;
    seriesUd = null;
  });

  const actions = $derived([
    trailer && { id: 'trailer', icon: 'trailer', label: 'Trailer', onclick: () => openTrailer(trailer, { title: series.Name, art: bg }) },
    { id: 'watched', icon: 'check-circle', label: 'Watched', on: seriesWatched, onclick: seriesMenu },
    nextResume && { id: 'restart', icon: 'restart', label: 'From start', onclick: () => startOver(next) }
  ]);

  /* ------------------------------------------------------------- pills */
  const pills = $derived([
    ...seasons.map((s, i) => ({
      key: 's' + i,
      label: s.Name || 'Season ' + s.IndexNumber,
      active: pidx == null && i === idx,
      watched: !!s.UserData?.Played && s.ChildCount !== 0
    })),
    ...pendSeasons.map((n) => {
      const its = pendEps.filter((p) => p.season === n);
      const pct = its.length ? Math.round((its.reduce((a, p) => a + (p.progress || 0), 0) / its.length) * 100) : 0;
      return { key: 'p' + n, label: 'Season ' + n, active: pidx === n, dim: true, pct };
    })
  ]);

  /* A season picked while the pills are pinned: start its list at the top,
   * right under the pinned pills, instead of mid-way down the new list. */
  let gapEl = $state(null);
  function toListTop() {
    const sc = gapEl?.closest('.screen');
    if (!sc) return;
    const nav = safeInsets().top + 56;
    const at = gapEl.offsetTop + gapEl.offsetHeight - nav;
    if (sc.scrollTop > at) sc.scrollTop = at;
  }

  function pick(key) {
    toListTop();
    const at = (k) => pills.findIndex((p) => p.key === k);
    const was = pills.findIndex((p) => p.active);
    const dir = Math.sign(at(key) - was) || 1;
    if (key[0] === 's') {
      const i = +key.slice(1);
      if (i === idx && pidx == null) return;
      loadSeason(i, false, dir);
    } else {
      if (pidx === +key.slice(1)) return;
      seasonReq++;
      clearTimeout(staleTimer);
      stale = false;
      pidx = +key.slice(1);
      idx = -1;
      eps = [];
      epsSeason = pidx;
      epErr = null;
      loading = false;
      listIn(dir);
    }
  }

  /* ------------------------------------------------------- watched state */
  function toggleEp(e) {
    const want = !e.UserData?.Played;
    setPlayed(e.Id, want)
      .then((ud) => {
        if (dead) return;
        e.UserData = ud || { ...e.UserData, Played: want, PlayedPercentage: 0, PlaybackPositionTicks: 0 };
        toast('E' + (e.IndexNumber ?? 0) + (want ? ' marked as watched' : ' marked as unwatched'));
        refreshAll();
      })
      .catch((err) => toast('Couldn’t update: ' + errText(err)));
  }

  async function markUpTo(e) {
    const n = e.IndexNumber ?? 0;
    const todo = eps.filter((x) => (x.IndexNumber ?? 0) <= n && !x.UserData?.Played);
    try {
      for (const x of todo) {
        const ud = await setPlayed(x.Id, true);
        if (dead) return;
        x.UserData = ud || { ...x.UserData, Played: true, PlayedPercentage: 0, PlaybackPositionTicks: 0 };
      }
      toast('Marked E1–E' + n + ' as watched');
    } catch (err) {
      toast('Couldn’t update: ' + errText(err));
    }
    refreshAll();
  }

  function toggleSeason(i) {
    const s = seasons[i];
    if (!s) return;
    const want = !(s.UserData?.Played && s.ChildCount !== 0);
    setPlayed(s.Id, want)
      .then((ud) => {
        if (dead) return;
        s.UserData = ud || { ...s.UserData, Played: want };
        toast((s.Name || 'Season') + (want ? ' marked as watched' : ' marked as unwatched'));
        refreshAll();
      })
      .catch((err) => toast('Couldn’t update: ' + errText(err)));
  }
  const seasonDone = (s) => !!s?.UserData?.Played && s.ChildCount !== 0;

  /* ------------------------------------------------------ context menus */
  let menu = $state({ open: false, rect: null, items: [], ep: null, pill: null, label: '' });

  /* A downloading/queued row: long-press → "Cancel download…" → the action
   * sheet confirms (ACT-01; it used to be a second menu at the same spot). */
  function pendMenu(p, d) {
    menu = {
      open: true,
      rect: d.rect,
      ep: null,
      pill: null,
      pend: p,
      label: 'Episode ' + (p.episode ?? '') + ' download',
      items: [{ label: 'Cancel download…', icon: 'x', danger: true, action: () => confirmMenu(confirmItems(cancelWhat(p), packOf(p).length, () => cancelItem(p))) }]
    };
  }

  /* Download to the phone (lib/offline.svelte.js) — or, once queued, go see it. */
  function dlItem(e) {
    const d = OFF.list.find((x) => x.id === e.Id && x.user === cfg.userId);
    if (!d) return { label: 'Download episode', icon: 'download', action: () => openSheetR('offline', { item: e }) };
    return { label: d.state === 'done' ? 'Downloaded — open Downloads' : 'Downloading — open Downloads', icon: d.state === 'done' ? 'check-circle' : 'download', action: () => pushRouteR('downloads') };
  }

  function epMenu(e, d) {
    const played = !!e.UserData?.Played;
    const n = e.IndexNumber ?? 0;
    const s = seasons[idx];
    const inProg = resumeSecOf(e) > 30 && !played;
    menu = {
      open: true,
      rect: d.rect,
      ep: e,
      pill: null,
      label: 'Episode ' + n + (e.Name ? ', ' + e.Name : ''),
      items: [
        { label: inProg ? 'Resume' : 'Play', icon: 'play', action: () => playEp(e.Id) },
        inProg && { label: 'Play from beginning', icon: 'restart', action: () => startOver(e) },
        { label: played ? 'Mark as unwatched' : 'Mark as watched', icon: played ? 'eye-off' : 'check-circle', action: () => toggleEp(e) },
        /* only when it does more than "Mark as watched" would */
        n > 1 && eps.some((x) => (x.IndexNumber ?? 0) < n && !x.UserData?.Played) && { label: 'Mark E1–E' + n + ' as watched', icon: 'check', action: () => markUpTo(e) },
        s && { sep: true },
        s && { label: 'Mark ' + (s.Name || 'season') + (seasonDone(s) ? ' as unwatched' : ' as watched'), icon: 'check-circle', action: () => toggleSeason(idx) },
        offlineSupported() && { sep: true },
        offlineSupported() && dlItem(e)
      ].filter(Boolean)
    };
  }

  /* The whole series in one tap is a lot to undo — the action sheet confirms it
   * (ACT-01). Unwatching drops every resume point, so that one is red. */
  async function seriesMenu() {
    const un = seriesWatched;
    const ok = await confirm({
      title: series.Name,
      message: un ? 'Every episode goes back to unwatched, resume points included.' : 'Every episode is marked as watched.',
      action: un ? 'Mark the Whole Series as Unwatched' : 'Mark the Whole Series as Watched',
      danger: un
    });
    if (ok && !dead && seriesWatched === un) toggleSeries();
  }

  function pillMenu(key, d) {
    if (key[0] !== 's') return;
    const i = +key.slice(1);
    const s = seasons[i];
    if (!s) return;
    menu = {
      open: true,
      rect: d.rect,
      ep: null,
      pill: { label: s.Name || 'Season ' + s.IndexNumber, watched: seasonDone(s), active: i === idx && pidx == null },
      label: s.Name,
      items: [{ label: 'Mark ' + (s.Name || 'season') + (seasonDone(s) ? ' as unwatched' : ' as watched'), icon: 'check-circle', action: () => toggleSeason(i) }]
    };
  }

  /* ------------------------------------------------------- row helpers */
  function epImg(e) {
    return imgUrl(e, 'Primary', { w: 320 }) || imgUrl(e, 'Thumb', { w: 320 });
  }
  function epNum(e, withSeason = false) {
    return [withSeason ? 'S' + (e.ParentIndexNumber ?? 0) : '', 'E' + (e.IndexNumber ?? 0), runtimeOf(e.RunTimeTicks)].filter(Boolean).join(' · ');
  }
  /* ---- nav bar: solid once the backdrop has scrolled under it ---- */
  let heroH = $state(440);
  let solid = $state(false);
  const solidAt = $derived(solidPoint(heroH));
</script>

<main class="screen" use:lateIn={late} use:scrollPast={{ y: solidAt, onchange: (s) => (solid = s) }}>
  <DetailHero src={bg} {late} bind:height={heroH} />
  <div class="detail__body">
    <div class="detail__head">
      <h1 class="detail__title {series.Name.length > 38 ? 'detail__title--long' : ''}">{series.Name}</h1>
      <MetaLine
        parts={[yr, nSeasons ? nSeasons + (nSeasons === 1 ? ' season' : ' seasons') : '']}
        rating={series.CommunityRating}
        cert={series.OfficialRating}
      />
      {#if genres}<p class="detail__genres">{genres}</p>{/if}
    </div>
    {#if next}
      {#if nextResume}
        <div class="detail__resume"><ProgressBar p={progressOf(next)} /><span>{seLabel(next)} · {leftOf(next)}</span></div>
      {/if}
      <Button variant="primary" block icon="play" onclick={() => playEp(next.Id)}>{nextResume ? 'Resume' : 'Play'} {seLabel(next)}</Button>
    {:else if loading}
      <Skeleton kind="pill" />
    {/if}
    <ActionBar {actions} />
    <Overview text={overview} />
    {#if badges.length}
      <TechBadges {badges} />
    {:else if loading && !badgeEp && series.RecursiveItemCount}
      <!-- the badges come with the first episode's answer: hold their row
           (when the show has files at all) so the pills don't drop under the finger -->
      <div class="detail__badgeslot" aria-hidden="true"></div>
    {/if}
  </div>

  {#if seasonsErr}
    <div class="detail__cardwrap">
      <LoadError card title="Couldn’t load the seasons" error={seasonsErr} retry={loadSeasons} />
    </div>
  {:else}
    <div class="detail__gap" bind:this={gapEl}></div>
    <SeasonPills {pills} onpick={pick} onlong={pillMenu} onpress={warm} />
    <div class="episodes detail__episodes {stale ? 'detail__episodes--stale' : ''}" bind:this={listEl}>
      {#if loading && !rows.length}
        {#each [0, 1, 2] as i (i)}
          <div class="detail__epskel detail__skel-late"><Skeleton kind="thumb" /><div class="skel-stack"><Skeleton kind="line" w="40%" /><Skeleton kind="line" w="80%" /></div></div>
        {/each}
      {:else if epErr}
        <div class="detail__cardwrap">
          <LoadError card title="Couldn’t load the episodes" error={epErr} retry={() => loadSeason(idx, true)} />
        </div>
      {:else if !rows.length}
        <p class="detail__empty">No episodes in this season yet.</p>
      {:else}
        {#each rows as row (row.k)}
          {#if row.p}
            {@const p = row.p}
            {@const em = epMeta.get(p.season + ':' + p.episode)}
            <EpisodeRow
              img={em?.still || null}
              num={epTitle(em?.title, p.episode_title) ? 'E' + (p.episode ?? '?') : ''}
              title={epTitle(em?.title, p.episode_title) || 'Episode ' + (p.episode ?? '')}
              overview={em?.overview || ''}
              status={isCancelling(p) ? 'Cancelling…' : pendStatus(p)}
              dl={dlOf(p)}
              class={isCancelling(p) ? 'is-cancelling' : ''}
              onlongpress={isCancelling(p) ? null : (d) => pendMenu(p, d)}
            />
          {:else}
            {@const e = row.e}
            {@const eud = e.UserData || {}}
            <EpisodeRow
              img={epImg(e)}
              num={epNum(e)}
              title={e.Name || 'Episode ' + (e.IndexNumber ?? '')}
              overview={e.Overview || ''}
              watched={!!eud.Played}
              progress={progressOf(e)}
              status={progressOf(e) ? leftOf(e) : next && e.Id === next.Id && !eud.Played ? 'Up next' : ''}
              onclick={() => playEp(e.Id)}
              onlongpress={(d) => epMenu(e, d)}
            />
          {/if}
        {/each}
      {/if}
    </div>
  {/if}

  <CastRail {people} />
</main>
<NavBar title={series.Name} {solid} />

{#snippet pillPreview()}
  <span class="pill {menu.pill.active ? 'pill--active' : ''}">{#if menu.pill.watched}<span class="tick"><Icon name="check" /></span>{/if}{menu.pill.label}</span>
{/snippet}
{#snippet pendPreview()}
  {@const p = menu.pend}
  {@const em = epMeta.get(p.season + ':' + p.episode)}
  <EpisodeRow preview img={em?.still || null} num={'S' + (p.season ?? '?') + ' · E' + (p.episode ?? '?')} title={em?.title || p.episode_title || ''} status={pendStatus(p)} dl={dlOf(p)} />
{/snippet}
{#snippet epPreview()}
  <EpisodeRow preview img={epImg(menu.ep)} num={epNum(menu.ep, true)} title={menu.ep.Name || ''} />
{/snippet}
<ContextMenu
  open={menu.open}
  rect={menu.rect}
  items={menu.items}
  label={menu.label}
  preview={menu.ep ? epPreview : menu.pill ? pillPreview : menu.pend ? pendPreview : undefined}
  fit={menu.pill ? 'rect' : 'card'}
  onclose={() => (menu = { ...menu, open: false })}
/>
