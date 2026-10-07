<script module>
  /* The last snapshot, by group key, outliving the component: the player's exit
   * remounts this screen (openPending bumps S.epoch), and if the import landed
   * while the title was being watched the group is gone from the poll by then
   * — without this the remount showed "Nothing in progress…" with nothing to
   * focus instead of the "landed" note and Open in library. */
  /** @type {{ key: string, g: VR.ActivityGroup } | null} */
  let lastSnap = null;   // { key, g }
</script>

<script>
  /* Detail view for a title that is still downloading/importing — it has no
   * Jellyfin item yet, so the screen is assembled from two sources: the live
   * activity poll (status/progress/speed, refreshed every 4s while mounted)
   * and mlMetadata(), which serves everything Sonarr/Radarr already know about
   * the title (overview, poster, fanart, runtime, genres, ratings, per-episode
   * titles/overviews/air dates/stills). The layouts deliberately mirror
   * MovieDetail / SeriesDetail — same hero, metarow, season pills and episode
   * rows — with one difference: where the gold Play button would be there is a
   * greyed, *unfocusable* status badge ("Queued", or the live
   * "43% · 7.4 MB/s · 1:11:24 left"). It states the situation, there is nothing
   * to activate on it, so the D-pad skips it. There is no Back button either —
   * the remote's Back key (461, handled globally in Keys.svelte) is the way
   * out and needs no focus. What can't exist
   * yet is anything derived from the file itself (tech badges, audio tracks,
   * cast from Jellyfin); the release quality from the queue stands in. */
  import { fanartUrl } from '../lib/lookup.svelte.js';
  import { decoded } from '../lib/decoded.js';
  import { onMount } from 'svelte';
  import { S } from '../lib/nav.svelte.js';
  import { TICKS } from '../lib/api.js';
  import { fmtDate, fmtRuntime } from '../lib/format.js';
  import { mlMetadata, mlLookup, mlProbe } from '../lib/medialib.js';
  import { groupByKey, STATUS_LABEL, statLabel, humanBytes, dlBar, dlTail } from '../lib/activity.svelte.js';
  import { canStream, playPending, sourceFromProbe } from '../lib/pendingplay.js';
  import { videoStream, resShort, hdrLabel, audioBadge, describeTracks, streamByIndex } from '../lib/tracks.js';
  import { toast } from '../lib/toast.svelte.js';
  import { focusKey, focusFirst } from '../lib/focus.js';
  // import landing (see "the title finished importing" below)
  import { onDestroy, untrack } from 'svelte';
  import { openItem } from '../lib/nav.svelte.js';
  import { api, itemsPath } from '../lib/api.js';
  import { act, matchGroup } from '../lib/activity.svelte.js';
  import { recoverFocus, focusLost } from '../lib/focus.js';

  const group = $derived(groupByKey(S.pendingKey));

  /* The group vanishes from the poll the moment everything imports; keep the
   * last-seen snapshot so the screen doesn't blank mid-look — it flips to a
   * "landed in your library" note instead. */
  let snap = $state(lastSnap && lastSnap.key === S.pendingKey ? lastSnap.g : null);
  /* Episode stills whose request failed (TVDB artwork is external and does go
   * missing): show the .ph placeholder, not an empty dark box. By URL. */
  /** @type {Record<string, boolean>} */
  let badStill = $state({});
  $effect(() => {
    if (group) {
      const plain = $state.snapshot(group);
      snap = plain;
      lastSnap = { key: group.key, g: plain };
    }
  });
  const g = $derived(group || snap);
  const done = $derived(!group && !!snap);

  /* Sonarr/Radarr metadata; null until it lands (or if the backend predates
   * /api/metadata, in which case mlLookup fills what it can). */
  /** Partial: the mlLookup() fallback below only has the lookup result's fields. @type {Partial<Reel.Metadata> | null} */
  let meta = $state(/** @type {Partial<Reel.Metadata> | null} */ (null));

  onMount(async () => {
    /* The only actionable thing in the hero is Play-while-downloading, and it
     * exists only once a grab has bytes on disk. Everything else here is
     * read-only (the status badge), so when there is no Play button fall back to
     * whatever the screen does offer — the season pills / episode rows of a tv
     * title. A movie that isn't streamable yet genuinely has nothing to focus;
     * Back still works, it is a global key and needs no focused element. */
    if (!(await focusKey('pd-play'))) await focusFirst();
    autoFocused = document.activeElement;
    if (!g) return;
    try {
      if (g.mediaId) {
        meta = await mlMetadata(g.type, g.mediaId);
        return;
      }
    } catch {
      /* fall through to the lookup */
    }
    try {
      const r = await mlLookup({ q: g.title, type: g.type });
      const hit =
        (r.results || []).find((x) => g.mediaId && x.id === g.mediaId) ||
        (r.results || []).find((x) => x.title.toLowerCase() === g.title.toLowerCase());
      if (hit) meta = { ...hit, genres: [], episodes: [] };
    } catch {
      /* metadata is a bonus; the live queue state carries the screen */
    }
  });

  /* ---- watch while downloading ----
   * The first grab with bytes on disk is playable through the service's
   * stream endpoint; its ffprobe also yields the *real* file badges (4K, DV,
   * DD+ Atmos) — the same information a downloaded item's MediaStreams give. */
  const streamable = $derived(g ? g.items.find(canStream) : null);

  /* The probe inside playPending() can take a moment: the button says
     "Starting…" meanwhile (like LookupDetail's Watch), and a second OK — on
     Play or any row — is swallowed instead of starting a second probe. */
  let starting = $state(/** @type {string | null} */ (null));   // id of the grab being started
  /** @param {Reel.ActivityItem} it @param {Reel.EpisodeMetadata | undefined} [em] */
  async function startPlay(it, em) {
    if (starting) return;
    starting = it.id;
    try {
      await playPending(it, g, em);
    } finally {
      starting = null;
    }
  }

  /* A movie opened before its first bytes landed has nothing focusable; when
   * Play turns up on a later poll, give it the focus — but only if focus is
   * still nowhere, never off something the user moved to. */
  $effect(() => {
    if (!streamable || done || S.screen !== 'pending') return;
    const a = document.activeElement;
    if (!a || a === document.body) focusKey('pd-play');
  });

  /** @type {VR.PlayerSource | null} */
  let probeSrc = $state(/** @type {VR.PlayerSource | null} */ (null));
  /** @type {string | null | undefined} */
  let probeFor = null;
  $effect(() => {
    const it = streamable;
    if (!it || probeFor === it.download_id) return;
    probeFor = it.download_id;
    mlProbe(/** @type {string} */ (it.download_id))
      .then((p) => (probeSrc = sourceFromProbe(p)))
      // not enough bytes yet — clear the latch so a later poll tick retries
      .catch(/** @returns {null} */ () => (probeFor = null));
  });

  const fileBadges = $derived.by(() => {
    if (!probeSrc) return [];
    const out = [];
    const v = videoStream(probeSrc);
    if (v) {
      const rs = resShort(v.Width, v.Height);
      if (rs) out.push(rs);
      const h = hdrLabel(v);
      if (h) out.push(h);
    }
    const t = describeTracks(probeSrc, { Genres: meta?.genres });
    const ab = audioBadge(streamByIndex(probeSrc, t.defaultAudio));
    if (ab) out.push(ab);
    return out;
  });

  const bg = $derived(fanartUrl(meta?.fanart || meta?.poster || g?.poster));
  const year = $derived(meta?.year || g?.year || null);
  const runtime = $derived(meta?.runtime_min ? fmtRuntime(meta.runtime_min * 60 * TICKS) : '');
  const genres = $derived(meta?.genres?.length ? meta.genres.slice(0, 3).join(' · ') : '');

  const qualities = $derived(g ? [...new Set(g.items.map((i) => i.quality).filter(Boolean))] : []);
  // per torrent, not per episode entry — see pendingGroups()
  const totalSize = $derived(g?.size || 0);

  /* the hero button: aggregate for a show, the single grab for a movie (which
   * is the one case a per-grab timeleft is meaningful on the button) */
  const stat = $derived.by(() => {
    if (!g) return '';
    if (done) return 'In your library';
    if (act.stale) return 'Download status unavailable';
    const one = g.type !== 'tv' && g.items.length === 1 ? g.items[0] : null;
    return one
      ? statLabel({ ...one, speed: one.download_speed })
      : (g.type === 'tv' && g.status === 'downloading' ? 'Downloading · ' : '') + statLabel(g);
  });

  /* ---- tv: season pills + episode rows, like SeriesDetail ---- */
  const seasonNums = $derived(
    g && g.type === 'tv' ? [...new Set(g.items.map((i) => i.season).filter((n) => n != null))].sort((a, b) => a - b) : []
  );
  /* remember the *number*, not an index — the set of queued seasons can shrink
   * under us as imports finish */
  /** @type {number | null} */
  let selSeason = $state(/** @type {number | null} */ (null));
  const curSeason = $derived(selSeason != null && seasonNums.includes(selSeason) ? selSeason : seasonNums[0]);

  const eps = $derived(
    g && g.type === 'tv' ? g.items.filter((i) => (i.season ?? null) === (curSeason ?? null)) : []
  );

  /* per-episode metadata, keyed "season:episode" */
  const epMeta = $derived.by(() => {
    const m = new Map();
    for (const e of meta?.episodes || []) m.set(e.season + ':' + e.episode, e);
    return m;
  });

  const seasonSum = $derived(
    curSeason != null ? 'Season ' + curSeason + ' · ' + eps.length + (eps.length === 1 ? ' episode' : ' episodes') + ' on the way' : ''
  );

  /* ---- the title finished importing ----
   * Rows (and queue-only season pills) vanish one by one as episodes import,
   * and the Play button goes when the last grab does. If what vanished had
   * focus, it moves to the nearest control instead of leaving the D-pad dead.
   * Once the whole title is done, look it up in Jellyfin (after a pause for
   * the library scan, again at 8 s / 20 s) and offer "Open in library". */
  /** @type {Jf.BaseItemDto | null} */
  let landed = $state(/** @type {Jf.BaseItemDto | null} */ (null));   // the Jellyfin item, once it exists
  let prevRows = new Set();
  $effect(() => {
    const keys = new Set([
      ...eps.map((i) => 'pd-' + i.id),
      ...seasonNums.map((n) => 'pdseason-' + n),
      ...(!done && streamable ? ['pd-play'] : [])
    ]);
    untrack(() => {
      const fk = S.focusKey;
      const lost = fk && prevRows.has(fk) && !keys.has(fk);
      prevRows = keys;
      if (lost) recoverFocus();
    });
  });

  const LAND_DELAYS = [3000, 8000, 20000];
  let landTimer = 0;
  let landTries = 0;
  $effect(() => {
    if (!done || landed) return;
    untrack(() => {
      landTries = 0;
      clearTimeout(landTimer);
      landTimer = setTimeout(findLanded, LAND_DELAYS[landTries++]);
    });
  });
  let dead = false;   // a search in flight at unmount must not re-arm
  /* What onMount focused. Remounted after the player with the import already
   * landed, there is no pd-play, so focusFirst() parks on the first episode
   * row; the user hasn't chosen that, so Open in library may take it over. */
  /** @type {Element | null} */
  let autoFocused = null;
  onDestroy(() => {
    dead = true;
    clearTimeout(landTimer);
  });

  async function findLanded() {
    const snapG = g;
    if (!snapG) return;
    try {
      const r = /** @type {Jf.QueryResult} */ (await api(
        itemsPath({
          SearchTerm: snapG.title,
          IncludeItemTypes: snapG.type === 'tv' ? 'Series' : 'Movie',
          Recursive: true,
          Fields: 'ProviderIds,Path',
          Limit: 20
        })
      ));
      if (dead) return;
      const it = (r.Items || []).find((i) => matchGroup([snapG], i));
      if (it) {
        landed = it;
        // the Play button / last row went with the import — land on the way in
        if (focusLost() || document.activeElement === autoFocused) await focusKey('pd-open');
        return;
      }
    } catch {
      /* try again below */
    }
    if (!dead && landTries < LAND_DELAYS.length) landTimer = setTimeout(findLanded, LAND_DELAYS[landTries++]);
  }

  /** @param {Reel.ActivityItem} p */
  function pendClick(p) {
    toast(
      p.status === 'downloading'
        ? 'Still downloading — ' + Math.round((p.progress || 0) * 100) + '%'
        : (STATUS_LABEL[p.status] || p.status) + ' — not here yet'
    );
  }

  /** @param {Reel.ActivityItem} it */
  function epTitle(it) {
    const em = epMeta.get(it.season + ':' + it.episode);
    const name = em?.title || it.episode_title || '';
    return 'S' + (it.season || 0) + ':E' + (it.episode || 0) + (name ? ' · ' + name : '');
  }

  /* Only what precedes the inline progress bar; the speed / status word after it
     comes from dlTail(). */
  /** @param {Reel.ActivityItem} it */
  function epSub(it) {
    const em = epMeta.get(it.season + ':' + it.episode);
    return [em?.air_date ? fmtDate(em.air_date) : '', it.quality].filter(Boolean).join(' · ');
  }

  /** @param {Reel.ActivityItem} it */
  function epPlot(it) {
    const em = epMeta.get(it.season + ':' + it.episode);
    if (em?.overview) return em.overview;
    return it.status === 'downloading'
      ? 'Downloading — ' + Math.round((it.progress || 0) * 100) + '%'
      : STATUS_LABEL[it.status] || it.status;
  }
</script>

<div class="screen">
  <div class="page">
    {#if !g}
      <!-- can only happen if the poll came back empty between click and mount -->
      <div class="grid-wrap">
        <!-- no Back button here either — the remote's Back key is the way out -->
        <div class="loading" style="padding:20px 0">Nothing in progress for this title any more — it may already be in your library.</div>
      </div>
    {:else}
      <div class="hero {g.type === 'tv' ? 'series' : 'movie'}">
        <div class="backdrop">{#if bg}<img use:decoded={bg} alt="" />{/if}</div>
        <div class="scrim-l"></div>
        <div class="scrim-b"></div>
        <div class="info">
          <div class="title">{g.title}</div>
          <div class="metarow">
            {#if year}<span>{year}</span>{/if}
            {#if runtime}<span class="dot">·</span><span>{runtime}</span>{/if}
            {#if g.type === 'tv'}<span class="dot">·</span><span>{g.items.length}{g.items.length === 1 ? ' episode' : ' episodes'} on the way</span>{/if}
            {#if meta?.certification}<span class="dot">·</span><span class="fsk">{meta.certification}</span>{/if}
            {#if meta?.rating}<span class="star">★ {meta.rating.toFixed(1)}</span>{/if}
            {#if genres}<span class="dot">·</span><span class="genres">{genres}</span>{/if}
            {#if fileBadges.length || qualities.length || totalSize}
              <div class="badgerow">
                <!-- real file badges (from probing the partial file) beat the
                     release-name quality; fall back to it until the header is in -->
                {#if fileBadges.length}
                  {#each fileBadges as b (b)}<span class="chip sm">{b}</span>{/each}
                {:else}
                  {#each qualities as q (q)}<span class="chip sm">{q}</span>{/each}
                {/if}
                {#if totalSize}<span class="chip sm">{humanBytes(totalSize)}</span>{/if}
              </div>
            {/if}
          </div>
          <!-- overview in the hero for a show, in .body for a movie — matching
               where SeriesDetail and MovieDetail respectively put it -->
          {#if g.type === 'tv' && meta?.overview}<div class="overview">{meta.overview}</div>{/if}
          <div class="actions">
            {#if !done && streamable}
              <button
                class="btn primary big focus"
                data-focus="pd-play"
                onclick={() => startPlay(streamable, g.type === 'tv' ? epMeta.get(streamable.season + ':' + streamable.episode) : null)}
                >{starting === streamable.id ? 'Starting…' : '▶ ' + (g.type === 'tv' ? 'Play · S' + (streamable.season || 0) + ':E' + (streamable.episode || 0) : 'Play')}</button
              >
            {/if}
            <!-- a badge, not a control: no .focus / data-focus, so the D-pad
                 walks straight past it -->
            <span class="btn stat big">{stat}</span>
          </div>
        </div>
      </div>

      <div class="body">
        {#if done}
          <div class="loading" style="padding:8px 0 12px">
            All done — “{g.title}” has been imported and should appear in your library now.
          </div>
          {#if landed}
            <button class="btn primary big focus" data-focus="pd-open" onclick={() => openItem(/** @type {Jf.BaseItemDto} */ (landed).Id, /** @type {Jf.BaseItemDto} */ (landed).Type)}
              >Open in library</button
            >
          {/if}
        {/if}

        {#if g.type === 'tv'}
          {#if seasonNums.length > 1}
            <div class="seasonrow">
              {#each seasonNums as n (n)}
                <button class="pill pend focus" class:active={n === curSeason} data-focus="pdseason-{n}" onclick={() => (selSeason = n)}
                  >Season {n}</button
                >
              {/each}
            </div>
          {/if}
          {#if seasonSum}<div class="season-sum">{seasonSum}</div>{/if}

          <div class="eplist">
            {#each eps as it (it.id)}
              {@const em = epMeta.get(it.season + ':' + it.episode)}
              {@const bar = dlBar(it)}
              <button
                class="eprow pend focus"
                data-focus="pd-{it.id}"
                onclick={() => (canStream(it) ? startPlay(it, em) : pendClick(it))}
              >
                <!-- Same shape as SeriesDetail's pending row: no bar under the
                     thumbnail (that one is watch progress), download progress
                     inline in the header line instead of a right-hand pill. -->
                <div class="thumb">
                  {#if em?.still && !badStill[em.still]}<img loading="lazy" src={em.still} alt="" onerror={() => (badStill[em.still] = true)} />{:else}<div class="ph">on the way</div>{/if}
                </div>
                <div class="meta">
                  <div class="line">
                    <div class="etitle">{epTitle(it)}</div>
                    <div class="esub">
                      {#if epSub(it)}<span>{epSub(it)}</span>{/if}
                      <span class="dlbar" class:idle={!bar.active}><i style="width:{bar.fill}%"></i></span>
                      <span>{starting === it.id ? 'Starting…' : dlTail(it)}</span>
                    </div>
                  </div>
                  <div class="plot">{epPlot(it)}</div>
                </div>
              </button>
            {/each}
          </div>
        {:else if meta?.overview}
          <div class="overview">{meta.overview}</div>
        {/if}
      </div>
    {/if}
  </div>
</div>
