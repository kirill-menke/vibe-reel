<script>
  import { decoded } from '../lib/decoded.js';
  import { onMount, onDestroy } from 'svelte';
  import Loading from '../components/Loading.svelte';
  import LoadError from '../components/LoadError.svelte';
  import Icon from '../components/Icon.svelte';
  import { pickTrailer, openTrailer as playInApp } from '../lib/trailer.js';
  import { cfg } from '../lib/config.js';
  import { episodesPaths, startSeason, api, qs, imgUrl, errText, seasonsPath, prefetch, itemPath } from '../lib/api.js';
  import { fmtDate, fmtRuntime, fmtTime, ticksToSec, timeLeft, yearOf } from '../lib/format.js';
  import { heroBadges } from '../lib/tracks.js';
  import { P, playEpisode, playItem } from '../lib/player.svelte.js';
  import { S } from '../lib/nav.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import { focusKey, focusEl, byKey, scrollElTo } from '../lib/focus.js';
  import { pendingGroups, matchGroup, STATUS_LABEL, dlBar, dlTail } from '../lib/activity.svelte.js';
  import { canStream, playPending } from '../lib/pendingplay.js';
  import { mlMetadata } from '../lib/medialib.js';
  import { setPlayed } from '../lib/played.js';
  // import refresh (see "episodes finishing their import" below)
  import { untrack, tick } from 'svelte';
  import { act } from '../lib/activity.svelte.js';
  import { recoverFocus, focusLost } from '../lib/focus.js';

  /** @type {{ series: Jf.BaseItemDto }} */
  let { series } = $props();

  /* Trailer: TMDB's YouTube list from Jellyfin, opened in the YouTube app. */
  const trailer = $derived(pickTrailer(series));
  function openTrailer() {
    playInApp(trailer, { title: series.Name, art: bg });
  }

  /** @type {Jf.BaseItemDto[]} */
  let seasons = $state([]);
  /* Episode stills whose request failed (TVDB artwork is external and does go
   * missing): show the .ph placeholder, not an empty dark box. By URL. */
  /** @type {Record<string, boolean>} */
  let badStill = $state({});
  /** @type {Jf.BaseItemDto[]} */
  let eps = $state([]);
  /* The season's first episode *with* MediaSources — the hero's tech badges are
     the only reader of those on this page (a row plays via playEpisode(), which
     fetches the full item), so the list itself goes without. See fetchEps(). */
  let badgeEp = $state(/** @type {Jf.BaseItemDto | null} */ (null));
  let idx = $state(0);
  /* A season that exists only in the download queue (no Jellyfin season item
   * yet). null = a real season is selected via idx; a number = that pending
   * season's episodes are shown from activity alone. */
  let pidx = $state(/** @type {number | null} */ (null));
  let loading = $state(true);
  /* /Seasons failing used to leave a page with nothing focusable; an episode
     list failing, a silent empty list. Both now say so with a Retry. */
  let seasonsErr = $state(/** @type {VR.ApiError | null} */ (null));
  let epErr = $state(/** @type {VR.ApiError | null} */ (null));

  /* ---- episodes still on the way (download activity) ----
   * Matched by tvdb id / title; every derived below is live off the 4s poll. */
  const pend = $derived(matchGroup(pendingGroups('tv'), series));
  const pendEps = $derived(pend ? pend.items : []);

  /* Sonarr metadata for the pending rows — real episode titles, overviews,
   * air dates and TVDB stills, so a not-yet-imported episode renders like a
   * downloaded one. One fetch per series (mlMetadata caches for the session);
   * needs the extended backend's media_id, placeholders otherwise. */
  /** @type {Reel.Metadata | null} */
  let pendMeta = $state(null);
  /** @type {string | null} */
  let pendMetaFor = null;
  $effect(() => {
    const id = pend?.mediaId;
    if (!id || pendMetaFor === id) return;
    pendMetaFor = id;
    mlMetadata('tv', id)
      .then((m) => (pendMeta = m))
      .catch(() => {});
  });
  const epMeta = $derived.by(() => {
    const m = new Map();
    for (const e of pendMeta?.episodes || []) m.set(e.season + ':' + e.episode, e);
    return m;
  });

  /* seasons the queue knows but Jellyfin doesn't — extra pills */
  const pendSeasons = $derived.by(() => {
    if (!pendEps.length) return [];
    const have = new Set(seasons.map((s) => s.IndexNumber));
    return [...new Set(pendEps.map((p) => p.season).filter(/** @type {(n: number | null | undefined) => n is number} */ ((n) => n != null && !have.has(n))))].sort((a, b) => a - b);
  });

  const seasonNum = $derived(pidx != null ? pidx : ((seasons[idx] || {}).IndexNumber ?? null));

  /* The visible list: real episodes plus the not-yet-imported ones for this
   * season, interleaved in episode order. A pending grab whose episode already
   * exists in Jellyfin (a quality upgrade) stays out of the list — the badge on
   * the grid tile covers that. */
  const rows = $derived.by(() => {
    /** An episode row (`e`) or a not-yet-imported grab (`p`); `n` orders them.
     * @type {Array<{ k: string, e: Jf.BaseItemDto, p?: undefined, n: number } | { k: string, e?: undefined, p: Reel.ActivityItem, n: number }>} */
    const out = eps.map((e) => ({ k: 'e' + e.Id, e, n: e.IndexNumber ?? 0 }));
    if (seasonNum != null) {
      for (const p of pendEps) {
        if (p.season !== seasonNum) continue;
        if (p.episode != null && eps.some((e) => e.IndexNumber === p.episode)) continue;
        out.push({ k: 'p' + p.id, p, n: p.episode ?? 1e9 });
      }
      out.sort((a, b) => a.n - b.n);
    }
    return out;
  });

  const bg = $derived(imgUrl(series, 'Backdrop', { w: 1920 }) || imgUrl(series, 'Primary', { h: 1080 }));
  const season = $derived(seasons[idx] || /** @type {Jf.BaseItemDto} */ ({}));
  const nextEp = $derived(eps.find((e) => !(e.UserData && e.UserData.Played)) || eps[0] || null);
  /* Partly watched: the button says Resume and where, like MovieDetail and the
     Home hero, with the same thin progress bar — and offers Start over. */
  const nextUd = $derived(nextEp?.UserData || {});
  const nextResume = $derived(ticksToSec(nextUd.PlaybackPositionTicks));
  const nextCanResume = $derived(nextResume > 30 && !nextUd.Played);
  const nextPct = $derived(nextUd.PlayedPercentage ? Math.min(100, nextUd.PlayedPercentage) : 0);
  /* Tech badges (1080p, DD+, …) describe the files, so they read off an episode
     and only fall back to the series while the episode list is still loading. */
  const badges = $derived(heroBadges((eps[0] && badgeEp?.Id === eps[0].Id ? badgeEp : null) || series, series));

  const yr = $derived(
    yearOf(series) + (series.Status === 'Continuing' ? '– ' : series.EndDate ? '–' + series.EndDate.slice(0, 4) : '')
  );

  const seasonSum = $derived(
    pidx != null
      ? 'Season ' + pidx + ' · ' + rows.length + (rows.length === 1 ? ' episode' : ' episodes') + ' on the way'
      : [
          season.Name,
          yearOf(season) || yearOf(series),
          eps.length || rows.length === eps.length ? eps.length + (eps.length === 1 ? ' episode' : ' episodes') : '',
          // pending rows interleaved below — a season still downloading read "0 episodes"
          rows.length > eps.length ? rows.length - eps.length + ' on the way' : ''
        ]
          .filter(Boolean)
          .join(' · ')
  );

  const created = $derived(
    (series.People || []).find((p) => p.Type === 'Director' || /creator/i.test(p.Role || '')) || null
  );
  const overview = $derived((series.Overview || '') + (created ? ' Created by ' + created.Name + '.' : ''));

  /* `stay` = the user picked this season with OK, so focus must not leave the
     pill they pressed. Only the initial load (mount) is allowed to jump to the
     Next-up button. Either way we go through focusKey(), which awaits tick() —
     the episode list has just been replaced and the focus engine measures the
     flushed DOM. */
  /* Bumped by every season pick (and on destroy): a slower answer for a season
     the user has already moved off — or for a page already left — must not
     overwrite the list on screen or grab focus. */
  let seasonReq = 0;
  /* A season's episode rows need Overview + the image tags, not MediaSources
     (~3–5 KB per episode with every stream): measured on the NAS, one show's
     season 132 KB → 37 KB, another's 103 KB → 23 KB. The first episode's
     MediaSources (for the hero badges) come from a parallel Limit=1 call; its
     failure only costs the badges. UserData/PremiereDate/RunTimeTicks/
     IndexNumber come back without being asked for. */
  /** @param {string} seasonId @returns {Promise<{ items: Jf.BaseItemDto[], first: Jf.BaseItemDto | null }>} */
  function fetchEps(seasonId) {
    const [list, first] = episodesPaths(series.Id, seasonId);
    return Promise.all([
      /** @type {Promise<Jf.QueryResult>} */ (api(list)),
      /** @type {Promise<Jf.QueryResult>} */ (api(first)).catch(/** @returns {null} */ () => null)
    ]).then(([r, b]) => ({ items: r.Items || [], first: (b && b.Items && b.Items[0]) || null }));
  }
  /* `retry` = a LoadError retry, which reconnect.js also fires by itself (on
     resume / Wi-Fi back / every minute). The user may be on the hero or a
     pill by then — only land focus if it has nowhere live to be (the pressed
     Retry button was unmounted with the error — or is still on it) or is already
     on the pills. */
  function mayRefocus() {
    const a = /** @type {HTMLElement | null} */ (document.activeElement);
    return !a || a === document.body || !a.isConnected || a.offsetParent === null || !!a.closest('.seasonrow, .loaderr');
  }
  /** @param {number} i index into `seasons` @param {boolean} [stay] @param {boolean} [retry] */
  async function loadSeason(i, stay = false, retry = false) {
    const req = ++seasonReq;
    idx = i;
    pidx = null;
    /* A retry keeps the error card up while it runs, so LoadError shows
       "Retrying…" in place (and keeps focus) instead of the season reading
       "0 episodes" over an empty list until the request settles. */
    if (!retry) epErr = null;
    const s = seasons[i] || seasons[0];
    try {
      const r = await fetchEps(s && s.Id);
      if (req !== seasonReq) return;
      epErr = null;
      badgeEp = r.first;
      eps = r.items;
      loading = false;
      if (retry && !mayRefocus()) return;
      await focusKey(!stay && nextEp ? 'play' : 'season-' + idx);
    } catch (e) {
      if (req !== seasonReq) return;
      eps = [];
      epErr = /** @type {VR.ApiError} */ (e);
      loading = false;
    }
  }

  /* Playing an episode is Items/{id} → PlaybackInfo, serial (~85 ms for the
     item on the TV). Warm the item once the D-pad rests on a row or the Play
     button, like Tile.svelte; the dwell keeps a sweep down the list from
     firing a request per row. A watched toggle drops the warm
     (invalidatePlayState), so a stale resume point is never played. */
  /** @type {ReturnType<typeof setTimeout> | null} */
  let epDwell = null;
  /** @param {string} id */
  function warmEp(id) {
    clearTimeout(epDwell);
    epDwell = setTimeout(() => prefetch(itemPath(id)).catch(() => {}), 350);
  }
  function unwarmEp() {
    clearTimeout(epDwell);
  }

  /* Start over: the same fetch playEpisode() makes (a full item, with its
     MediaSources), played from 0 instead of the resume point. */
  /** @param {Jf.BaseItemDto} e */
  function startOver(e) {
    /** @type {Promise<Jf.BaseItemDto>} */ (api(itemPath(e.Id)))
      .then((ep) => {
        if (!ep.Genres?.length) ep.Genres = series.Genres;
        playItem(ep, 0);
      })
      .catch((err) => toast('Couldn’t start this episode: ' + errText(err)));
  }

  /* See MovieDetail: ensureVisible() only scrolls far enough to reveal the
     target, so refocusing the hero's button row (the top row) has to snap the
     page fully back to the top itself. */
  /** @param {FocusEvent} e */
  function homeOnTopRow(e) {
    const t = /** @type {Element | null} */ (e.target);
    if (!t || !t.closest || !t.closest('.hero')) return;
    const page = t.closest('.page');
    if (!page) return;
    const snap = () => {
      const a = document.activeElement;
      if (a && a.closest && a.closest('.hero')) scrollElTo(page, 0);
    };
    queueMicrotask(snap);
    setTimeout(snap, 120);
  }

  /* Show a pending-only season: no Jellyfin query to make, the rows come
   * straight out of the activity store. */
  /** @param {number} n season number */
  function selectPend(n) {
    seasonReq++;
    pidx = n;
    idx = -1;
    eps = [];
    epErr = null;
    loading = false;
    focusKey('pseason-' + n);
  }

  /* OK on a pending row: stream it while it downloads when the grab has bytes
   * on disk; otherwise say why it can't play yet. */
  /** @param {Reel.ActivityItem} p */
  function pendClick(p) {
    if (canStream(p)) {
      playPending(p, pend, epMeta.get(p.season + ':' + p.episode));
      return;
    }
    toast(
      p.status === 'downloading'
        ? 'Still downloading — ' + Math.round((p.progress || 0) * 100) + '%'
        : (STATUS_LABEL[p.status] || p.status) + ' — not here yet'
    );
  }

  /* Hold OK on an episode row: flip its watched state. The server answers with
   * the new UserData, which replaces the row's in place — tick, progress bar
   * and the Next-up button all derive from it. */
  /** @param {Jf.BaseItemDto} e */
  function toggleEp(e) {
    const want = !(e.UserData && e.UserData.Played);
    setPlayed(e.Id, want)
      .then((ud) => {
        e.UserData = ud || { ...e.UserData, Played: want, PlayedPercentage: 0, PlaybackPositionTicks: 0 };
        toast(epNum(e) + (want ? ' marked watched' : ' marked unwatched'));
      })
      .catch((err) => toast('Couldn’t update: ' + errText(err)));
  }

  /* Hold OK on a season pill marks the whole season — one slip of the thumb
   * used to rewrite a season's watch state. The first hold only arms the pill
   * ("Hold again to …"); a second hold within ARM_MS commits. Moving off the
   * pill or waiting it out disarms. */
  const ARM_MS = 4000;
  let armed = $state(/** @type {number | null} */ (null));
  /** @type {ReturnType<typeof setTimeout> | null} */
  let armTimer = null;
  function disarm() {
    clearTimeout(armTimer);
    armed = null;
  }
  /** @param {number} i */
  function holdSeason(i) {
    if (!seasons[i]) return;
    if (armed !== i) {
      disarm();
      armed = i;
      armTimer = setTimeout(disarm, ARM_MS);
      return;
    }
    disarm();
    toggleSeason(i);
  }
  onDestroy(() => {
    clearTimeout(armTimer);
    clearTimeout(epDwell);
    seasonReq++;
  });

  /* ▼ from the season pills lands on the next-up episode (scrolled into view by
   * focusEl → ensureVisible), not on E1: that row is what you came for. Only
   * from the pills' last row — a wrapped row below still gets geometry.
   * Capture phase, so it runs before Keys.svelte's window handler. */
  /** @param {KeyboardEvent} e */
  function pillDown(e) {
    if (e.keyCode !== 40 || S.screen !== 'detail' || S.search) return;
    const a = /** @type {HTMLElement | null} */ (document.activeElement);
    /* ▼ from Play / Start over / Trailer enters the pills on the season being shown, not
     * on whichever pill happens to sit under the (wide) button. */
    if (a && ['play', 'restart', 'trailer'].includes(/** @type {string} */ (a.dataset?.focus))) {
      const sel = document.querySelector('.seasonrow .pill.active');
      if (!sel) return;
      e.preventDefault();
      e.stopPropagation();
      focusEl(sel);
      return;
    }
    if (!a || !a.classList.contains('pill') || !a.closest('.seasonrow')) return;
    if (!nextEp || pidx != null) return;
    const bottom = a.getBoundingClientRect().bottom;
    const below = [...document.querySelectorAll('.seasonrow .pill')].some((p) => p.getBoundingClientRect().top >= bottom);
    if (below) return;
    const el = byKey('ep-' + nextEp.Id);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    focusEl(el);
  }
  onMount(() => {
    window.addEventListener('keydown', pillDown, true);
    return () => window.removeEventListener('keydown', pillDown, true);
  });

  /* The whole season. Jellyfin applies it to every episode below; if that
   * season is the one on screen, re-list it. */
  /** @param {number} i */
  function toggleSeason(i) {
    const s = seasons[i];
    if (!s) return;
    // the pill's own reading (sDone): an empty season is Played but shows no ✓
    // and offers "mark watched" — toggling the raw flag would unmark it instead
    const want = !(s.UserData && s.UserData.Played && s.ChildCount !== 0);
    setPlayed(s.Id, want)
      .then((ud) => {
        s.UserData = ud || { ...s.UserData, Played: want };
        toast(s.Name + (want ? ' marked watched' : ' marked unwatched'));
        if (i === idx) loadSeason(i, true);
      })
      .catch((err) => toast('Couldn’t update: ' + errText(err)));
  }

  /** @param {Jf.BaseItemDto} e */
  function epNum(e) {
    return 'S' + (e.ParentIndexNumber || 0) + ':E' + (e.IndexNumber || 0);
  }

  /** @param {Jf.BaseItemDto} e */
  function epSub(e) {
    return [fmtRuntime(e.RunTimeTicks), e.PremiereDate ? fmtDate(e.PremiereDate) : ''].filter(Boolean).join(' · ');
  }

  async function loadSeasons(retry = false) {
    seasonsErr = null;
    loading = true;
    try {
      const r = /** @type {Jf.QueryResult} */ (await api(seasonsPath(series.Id))); // usually warmed by Detail/Tile
      seasons = (r.Items || []).filter((s) => s.Type === 'Season');
      P.seasons = seasons;
      // open on the first season that isn't fully watched (the one warmed ahead)
      await loadSeason(startSeason(seasons), false, retry);
    } catch (e) {
      seasonsErr = /** @type {VR.ApiError} */ (e);
      loading = false;
    }
  }

  /* ---- episodes finishing their import ----
   * A pending row disappears the moment its grab leaves the activity feed, but
   * the real episode only shows up once the season is re-listed — so an
   * imported episode used to vanish from the list until the next visit. When
   * pending rows leave the feed, re-list the seasons (a queue-only season may
   * now exist) and the selected season's episodes after a pause for
   * Jellyfin's scan, again at 8 s / 20 s while they are still missing. The
   * selection is kept by season identity, not index. If a vanished row (or a
   * queue-only season pill) had focus, focus goes to the nearest row at once,
   * then onto the real episode when it lands, unless the user moved on. A
   * stale feed keeps its last list, so it never looks like an import. */
  const IMPORT_DELAYS = [3000, 8000, 20000];
  let prevPend = new Map();   // pending item id -> { id, season, episode }
  /** @type {Array<{ id: string, season: number | null, episode: number | null }>} */
  let importAwait = [];       // vanished rows whose real episode hasn't appeared
  /** @type {{ p?: { id: string, season: number | null, episode: number | null }, season?: number | null, parked: Element | null } | null} */
  let importLost = null;      // { p, parked } | { season, parked }: what had focus
  let importTimer = 0;
  let importTries = 0;

  $effect(() => {
    const list = pendEps;
    const skip = act.stale || loading || !!seasonsErr;
    untrack(() => {
      const live = new Set(list.map((p) => p.id));
      const gone = skip ? [] : [...prevPend.values()].filter((p) => !live.has(p.id));
      prevPend = new Map(list.map((p) => [p.id, { id: p.id, season: p.season, episode: p.episode }]));
      if (!gone.length) return;
      importAwait.push(...gone);
      const fk = S.focusKey || '';
      const hadRow = gone.find((p) => fk === 'pep-' + p.id);
      const hadPill = fk.startsWith('pseason-') ? +fk.slice(8) : null;
      if (hadRow || hadPill != null) {
        importLost = hadRow ? { p: hadRow, parked: null } : { season: hadPill, parked: null };
        recoverFocus().then(() => importLost && (importLost.parked = document.activeElement));
      }
      importTries = 0;
      scheduleImport();
    });
  });

  function scheduleImport() {
    clearTimeout(importTimer);
    if (dead || importTries >= IMPORT_DELAYS.length) {
      importAwait = [];
      importLost = null;
      return;
    }
    importTimer = setTimeout(importCheck, IMPORT_DELAYS[importTries++]);
  }
  /* A check in flight at unmount must neither re-arm nor write P.seasons /
     focus into whatever screen came next. */
  let dead = false;
  onDestroy(() => {
    dead = true;
    clearTimeout(importTimer);
  });

  async function importCheck() {
    if (loading) return scheduleImport();
    try {
      const rs = /** @type {Jf.QueryResult} */ (await api('/Shows/' + series.Id + '/Seasons' + qs({ UserId: cfg.userId, Fields: 'UserData,ChildCount' })));
      if (dead) return;
      const ns = (rs.Items || []).filter((x) => x.Type === 'Season');
      // remap the live selection onto the new list — a new season may sort in before it
      const selId = pidx == null ? seasons[idx]?.Id : null;
      seasons = ns;
      P.seasons = ns;
      if (selId) idx = Math.max(0, ns.findIndex((x) => x.Id === selId));
      else if (pidx != null) {
        const j = ns.findIndex((x) => x.IndexNumber === pidx);
        if (j >= 0) {
          idx = j;   // the queue-only season is a real one now
          pidx = null;
        }
      }
      if (pidx == null && seasons[idx]) {
        const my = seasons[idx].Id;
        const er = await fetchEps(my);
        if (dead) return;
        if (pidx == null && seasons[idx]?.Id === my) {
          badgeEp = er.first;
          eps = er.items;
          epErr = null;
        }
      }
    } catch {
      return scheduleImport();
    }
    const have = new Set(seasons.map((x) => x.IndexNumber));
    const curNum = pidx == null ? seasons[idx]?.IndexNumber : null;
    /** @param {{ season: number | null, episode: number | null }} p */
    const epOf = (p) => eps.find((e) => e.ParentIndexNumber === p.season && e.IndexNumber === p.episode);
    // still waiting: its season isn't in Jellyfin yet, or it is the one on screen and the episode isn't
    importAwait = importAwait.filter((p) => !have.has(p.season) || (p.season === curNum && !epOf(p)));
    const lf = importLost;
    if (lf) {
      const target = lf.p ? (lf.p.season === curNum && epOf(lf.p) ? 'ep-' + /** @type {Jf.BaseItemDto} */ (epOf(lf.p)).Id : null) : lf.season === curNum ? 'season-' + idx : null;
      if (target) {
        importLost = null;
        await tick();
        if (focusLost() || document.activeElement === lf.parked) await focusKey(target);
      }
    }
    if (importAwait.length) scheduleImport();
    else importLost = null;
  }

  onMount(() => {
    P.series = series;
    P.detailItem = series;
    loadSeasons();
  });
</script>

<div class="screen" onfocusin={homeOnTopRow}>
  <div class="page">
    <div class="hero series">
      <div class="backdrop">{#if bg}<img use:decoded={bg} alt="" />{/if}</div>
      <div class="scrim-l"></div>
      <div class="scrim-b"></div>
      <div class="info">
        <div class="title">{series.Name}</div>
        <div class="metarow">
          <span>{yr}</span>
          <span class="dot">·</span>
          <span
            >{seasons.length}{seasons.length === 1 ? ' season' : ' seasons'}{series.RecursiveItemCount
              ? ' · ' + series.RecursiveItemCount + ' episodes'
              : ''}</span
          >
          {#if series.OfficialRating}<span class="dot">·</span><span class="fsk">{series.OfficialRating}</span>{/if}
          {#if series.CommunityRating}<span class="star">★ {series.CommunityRating.toFixed(1)}</span>{/if}
          {#if series.Genres?.length}<span class="dot">·</span><span class="genres">{series.Genres.slice(0, 3).join(' · ')}</span>{/if}
          <!-- flex-basis:100% on .badgerow forces the wrap, so the tech badges
               always get a row of their own instead of trailing the genres. -->
          {#if badges.length}
            <div class="badgerow">{#each badges as b (b)}<span class="chip sm">{b}</span>{/each}</div>
          {/if}
        </div>
        {#if overview}<div class="overview">{overview}</div>{/if}
        <div class="actions">
          {#if nextEp}
            <!-- playEpisode() resumes from the saved position by itself -->
            <button class="btn primary big focus" class:hasbar={nextCanResume && nextPct} data-focus="play" onclick={() => playEpisode(nextEp.Id)}
              onfocus={() => warmEp(nextEp.Id)} onblur={unwarmEp}
              >▶ {#if nextCanResume}Resume {epNum(nextEp)} · {fmtTime(nextResume)}{:else}{nextUd.Played ? 'Watch again' : 'Next up'} · {epNum(nextEp)}{nextEp.Name
                  ? ' “' + nextEp.Name + '”'
                  : ''}{/if}{#if nextCanResume && nextPct}<span class="rbar"><i style="width:{nextPct}%"></i></span>{/if}</button
            >
            {#if nextCanResume}
              <button class="btn ghost big focus" data-focus="restart" onclick={() => startOver(nextEp)}
                ><Icon name="restart" inline />Start over</button
              >
            {/if}
          {/if}
          {#if trailer}
            <button class="btn ghost big focus" data-focus="trailer" onclick={openTrailer}
              ><Icon name="trailer" inline />Trailer</button
            >
          {/if}
        </div>
      </div>
    </div>

    <div class="body">
      <!-- The season picker belongs to the episode list it filters, so it lives
           in the black content section rather than on the artwork: a row of its
           own above the list, clear of the gold Next-up button (the hero's 36px
           bottom inset + .body's 24px padding + the 12px here = 72px). Outside
           .hero on purpose — homeOnTopRow() snaps the page back to the top for
           anything focused inside the hero, and the pills must not do that. The
           full 1792px content width also fits ten pills before wrapping, where
           the hero row used to wrap after four. -->
      {#if seasonsErr}
        <LoadError title="Couldn’t load the seasons of “{series.Name}”" error={seasonsErr} retry={() => loadSeasons(true)} fkey="seasons-err" />
      {:else if seasons.length || pendSeasons.length}
        <div class="seasonrow">
          {#each seasons as s, i (s.Id)}
            <!-- Jellyfin reports an empty season (all of it still downloading) as
                 Played; ChildCount keeps that from wearing a watched ✓ -->
            {@const sDone = !!s.UserData?.Played && s.ChildCount !== 0}
            <!-- a fully watched season carries a ✓ and a muted label -->
            <button
              class="pill focus"
              class:active={pidx == null && i === idx}
              class:done={sDone}
              class:armed={armed === i}
              data-focus="season-{i}"
              data-hold
              onclick={() => {
                disarm();
                loadSeason(i, true);
              }}
              onblur={() => armed === i && disarm()}
              onokhold={() => holdSeason(i)}
              >{#if armed === i}Hold again to mark {s.Name} {sDone ? 'unwatched' : 'watched'}{:else}{#if sDone}<Icon
                    name="checkthin"
                    inline
                  />{/if}{s.Name}{/if}</button
            >
          {/each}
          <!-- seasons that only exist in the download queue so far -->
          {#each pendSeasons as n (n)}
            <button class="pill pend focus" class:active={pidx === n} data-focus="pseason-{n}" onclick={() => selectPend(n)}
              >Season {n}</button
            >
          {/each}
        </div>
      {/if}
      {#if !seasonsErr}
      <div class="season-sum">
        {seasonSum}{#if eps.length}<span class="holdhint">Hold OK on an episode or season to mark it watched</span>{/if}
      </div>

      <div class="eplist">
        {#if loading}
          <Loading inline />
        {:else if epErr}
          <LoadError title="Couldn’t load the episodes" error={epErr} retry={() => loadSeason(idx, true, true)} fkey="eps-err" inline />
        {:else}
          {#each rows as row (row.k)}
            {#if row.p}
              {@const p = row.p}
              {@const em = epMeta.get(p.season + ':' + p.episode)}
              {@const bar = dlBar(p)}
              {@const phead = [em?.air_date ? fmtDate(em.air_date) : '', p.quality].filter(Boolean).join(' · ')}
              <button class="eprow pend focus" data-focus="pep-{p.id}" onclick={() => pendClick(p)}>
                <!-- No .progress under the thumbnail here: that bar means "how far
                     you watched" everywhere else, and download progress now lives
                     inline in the header line (.dlbar) instead. -->
                <div class="thumb">
                  {#if em?.still && !badStill[em.still]}<img loading="lazy" src={em.still} alt="" onerror={() => (badStill[em.still] = true)} />{:else}<div class="ph">on the way</div>{/if}
                </div>
                <div class="meta">
                  <div class="line">
                    <div class="etitle">
                      S{p.season || 0}:E{p.episode || 0}{em?.title || p.episode_title ? ' · ' + (em?.title || p.episode_title) : ''}
                    </div>
                    <!-- air date · quality → the bar → speed · time left. The bar
                         replaces the old right-hand percentage/"Queued" pill. -->
                    <div class="esub">
                      {#if phead}<span>{phead}</span>{/if}
                      <span class="dlbar" class:idle={!bar.active}><i style="width:{bar.fill}%"></i></span>
                      <span>{dlTail(p)}</span>
                    </div>
                  </div>
                  <div class="plot">
                    {em?.overview ||
                      (p.status === 'downloading'
                        ? 'Downloading — ' + Math.round((p.progress || 0) * 100) + '%'
                        : STATUS_LABEL[p.status] || p.status)}
                  </div>
                </div>
              </button>
            {:else}
              {@const e = row.e}
              {@const eud = e.UserData || {}}
              {@const epct = eud.PlayedPercentage ? Math.min(100, eud.PlayedPercentage) : 0}
              <!-- w:320 for the 300×169 .thumb (h:260 fetched 462×260: ~40% more
                   bytes, 2× the decoded pixels, and upscaled portrait fallbacks) -->
              {@const img = imgUrl(e, 'Primary', { w: 320 }) || imgUrl(e, 'Thumb', { w: 320 })}
              <button
                class="eprow focus"
                class:current={epct && !eud.Played}
                class:watched={eud.Played}
                data-focus="ep-{e.Id}"
                onfocus={() => warmEp(e.Id)}
                onblur={unwarmEp}
                data-hold
                onclick={() => playEpisode(e.Id)}
                onokhold={() => toggleEp(e)}
              >
                <div class="thumb">
                  {#if img && !badStill[img]}<img loading="lazy" src={img} alt="" onerror={() => (badStill[img] = true)} />{:else}<div class="ph">episode</div>{/if}
                  {#if epct}<div class="progress"><i style="width:{epct}%"></i></div>{/if}
                </div>
                <div class="meta">
                  <div class="line">
                    <div class="etitle">{epNum(e)} · {e.Name || ''}</div>
                    <div class="esub">{epSub(e)}</div>
                  </div>
                  <div class="plot">{e.Overview || ''}</div>
                </div>
                <!-- Sibling of .meta, not inside .line: .eprow is align-items:center,
                     so the mark centres on the row instead of sitting on the
                     title's baseline. -->
                {#if eud.Played}<div class="echk" aria-label="Watched"><Icon name="checkthin" /></div>
                {:else if epct}<div class="eleft">{timeLeft(e)}</div>{/if}
              </button>
            {/if}
          {/each}
        {/if}
      </div>
      {/if}
    </div>
  </div>
</div>
