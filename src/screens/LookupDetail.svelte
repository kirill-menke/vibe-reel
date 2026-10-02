<script>
  /* Detail view for a Search result that isn't a Jellyfin item yet — the
   * counterpart of MovieDetail / SeriesDetail for a title you don't have. It is
   * assembled from mlMetadata() (Sonarr/Radarr: overview, fanart, runtime,
   * genres, rating, certification, and for a show already in Sonarr every
   * episode's title/overview/air date/still) and deliberately uses the same
   * hero, metarow, season pills and episode rows as the real screens. Where the
   * gold Play button sits, this one has Add to library; once added (or if the
   * title already was), it becomes the same greyed status badge PendingDetail
   * uses, live off the activity poll. What only a file can tell — tech badges,
   * audio tracks, Jellyfin cast — has no equivalent before download.
   *
   * Sonarr lists a series' episodes only once it has been added, so a show not
   * in the library shows its overview and no episode list; adding it evicts the
   * cached metadata (lookup.svelte.js) and the list is fetched again here. */
  import { decoded } from '../lib/decoded.js';
  import { onMount, onDestroy } from 'svelte';
  import Icon from '../components/Icon.svelte';
  import CollectionRail from '../components/CollectionRail.svelte';
  import { S, openPending, takeDetailFocus } from '../lib/nav.svelte.js';
  import { openTrailer as playInApp } from '../lib/trailer.js';
  import { TICKS } from '../lib/api.js';
  import { fmtDate, fmtRuntime } from '../lib/format.js';
  import { mlMetadata } from '../lib/medialib.js';
  import { statLabel } from '../lib/activity.svelte.js';
  import { fanartUrl, addState, addToLibrary, lookupGroup } from '../lib/lookup.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import { focusKey, focusFirst, scrollElTo } from '../lib/focus.js';
  import { canStream, playPending } from '../lib/pendingplay.js';

  const item = S.lookup;
  const tv = item.type === 'tv';

  /* null until it lands; the lookup result carries the screen until then (and
   * for good, if the metadata call fails). */
  let meta = $state(null);
  /* Episode stills whose request failed (TVDB artwork is external and does go
   * missing): show the .ph placeholder, not an empty dark box. By URL. */
  let badStill = $state({});

  async function loadMeta() {
    try {
      meta = await mlMetadata(item.type, item.id);
    } catch {
      /* metadata is a bonus — title/year/overview/poster come with the result */
    }
  }

  /* Radarr's trailer (movies only — Sonarr has none), in the YouTube app. */
  const trailer = $derived(meta?.trailer || null);
  function openTrailer() {
    playInApp(trailer, { title: title, art: bg });
  }
  const collId = $derived(!tv && meta?.collection ? meta.collection.id : '');
  let collDone;
  const collP = new Promise((r) => (collDone = r));

  const state = $derived(addState(item));
  const group = $derived(lookupGroup(item));

  /* Adding a show makes its episode list exist — refetch once it's in. */
  let refetched = false;
  $effect(() => {
    if (tv && state === 'done' && !refetched) {
      refetched = true;
      loadMeta();
    }
  });

  const title = $derived(meta?.title || item.title);
  const bg = $derived(fanartUrl(meta?.fanart || meta?.poster || item.poster));
  const year = $derived(meta?.year || item.year || null);
  const overview = $derived(meta?.overview || item.overview || '');
  const runtime = $derived(meta?.runtime_min ? fmtRuntime(meta.runtime_min * 60 * TICKS) : '');
  const genres = $derived(meta?.genres?.length ? meta.genres.slice(0, 3).join(' · ') : '');
  /* "2019– " for a running show, as SeriesDetail writes it */
  const yr = $derived(year ? year + (tv && /^continuing$/i.test(meta?.status || '') ? '– ' : '') : '');

  /* The hero button's stand-in once there is nothing to add: the live download
   * state when the title has grabs in flight, else where it stands. */
  const stat = $derived.by(() => {
    if (group) return (tv && group.status === 'downloading' ? 'Downloading · ' : '') + statLabel(group);
    if (state === 'added') return 'In your library';
    if (state === 'done') return 'Added — searching for a download';
    return '';
  });

  /* What Add will do, under the hero — from the arr's own release status
   * (Radarr: tba/announced/inCinemas/released, Sonarr: upcoming/continuing/
   * ended). The payload has no cast, so the hero shows none. */
  const addHint = $derived.by(() => {
    const st = (meta?.status || '').toLowerCase();
    if (tv) {
      if (st === 'upcoming') return 'Not aired yet — episodes download on their own as they air';
      if (st === 'ended') return 'Downloads every episode · you can start watching while they download';
      return 'Downloads every aired episode, then new ones as they air · watch while it downloads';
    }
    if (st === 'announced' || st === 'tba') return 'Not released yet — it downloads on its own once it’s out';
    if (st === 'incinemas') return 'Still in cinemas — it downloads as soon as a release turns up';
    return 'Finds the best release and downloads it · you can start watching while it downloads';
  });

  /* OK on the status: the download's own page (live progress, watch while it
   * downloads) once there is one, else say where things stand. */
  function statClick() {
    if (group) openPending(group.key);
    else if (state === 'adding') return;
    else toast(state === 'added' ? '“' + title + '” is already in your library' : 'Looking for a download — progress shows here once one starts');
  }

  /* ---- watch while downloading, right here ----
   * Once the grab Add started has bytes on disk it can play through the same
   * stream endpoint PendingDetail uses — offered as the gold button in front of
   * the status, so "Add → wait → Watch" never needs a detour through the
   * download's own page. The probe can take a moment on first press, hence the
   * "Starting…" label (feedback well inside 200 ms). */
  const streamable = $derived(group ? group.items.find(canStream) || null : null);
  let starting = $state(false);
  async function watch() {
    if (starting || !streamable) return;
    starting = true;
    const it = streamable;
    const em = tv ? episodes.find((e) => e.season === it.season && e.episode === it.episode) : null;
    try {
      await playPending(it, group, em);
    } finally {
      starting = false;
    }
  }
  /* The first time it turns up, move focus onto it — but only off the status
     button Add left focus on (or from nowhere), never off an episode row or
     season pill the user walked to. */
  let offered = false;
  $effect(() => {
    if (!streamable || offered) return;
    offered = true;
    const a = document.activeElement;
    if (!a || a === document.body || a.dataset?.focus === 'lk-stat') focusKey('lk-watch');
  });

  /* ---- tv: season pills + episode rows, like SeriesDetail ----
   * Specials (season 0) go last, the way they trail the real seasons. */
  const episodes = $derived(meta?.episodes || []);
  const seasonNums = $derived(
    [...new Set(episodes.map((e) => e.season).filter((n) => n != null))].sort((a, b) => (a || 1e9) - (b || 1e9))
  );
  let selSeason = $state(null);
  const curSeason = $derived(selSeason != null && seasonNums.includes(selSeason) ? selSeason : seasonNums[0]);
  const eps = $derived(
    episodes.filter((e) => e.season === curSeason).sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0))
  );
  const nSeasons = $derived(seasonNums.filter((n) => n > 0).length);
  const nEps = $derived(episodes.filter((e) => e.season > 0).length);

  const seasonName = (n) => (n === 0 ? 'Specials' : 'Season ' + n);
  const seasonSum = $derived.by(() => {
    if (curSeason == null) return '';
    const first = eps.find((e) => e.air_date)?.air_date;
    return [seasonName(curSeason), first ? first.slice(0, 4) : '', eps.length + (eps.length === 1 ? ' episode' : ' episodes')]
      .filter(Boolean)
      .join(' · ');
  });

  function epSub(e) {
    return [runtime, e.air_date ? fmtDate(e.air_date) : ''].filter(Boolean).join(' · ');
  }

  /* An episode row is information, not a way to play: say why OK does nothing. */
  function epClick(e) {
    if (e.has_file) toast('Downloaded — it will be in your library once Jellyfin picks it up');
    else if (state === 'idle' || state === 'error') toast('Add “' + title + '” to your library to watch it');
    else toast('Not downloaded yet');
  }

  /* See MovieDetail: ensureVisible() only scrolls far enough to reveal the
     target, so refocusing the hero's button row has to snap the page fully back
     to the top itself. */
  function homeOnTopRow(e) {
    const t = e.target;
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

  /* Adding swaps the Add button for the status button (one element from
     "Adding…" to the outcome, so focus rides along); a failure brings Add back
     as "Try again". Either way focus must land on whichever exists — a movie
     has nothing else to focus. */
  async function add() {
    const p = addToLibrary(item); // flips the state to 'adding' synchronously
    await focusKey('lk-stat');
    await p;
    if (!alive) return;
    const a = document.activeElement;
    if (!a || a === document.body) {
      if (!(await focusKey('lk-stat')) && !(await focusKey('lk-add'))) await focusFirst();
    }
  }

  /* The add and the metadata fetch can take seconds (30 s at worst); Back in
     the meantime mounts the previous screen, and while that one is still
     loading focus sits on <body> — the focusFirst() fallbacks below would then
     grab its first element before its own focus restore runs. */
  let alive = true;
  onDestroy(() => (alive = false));

  onMount(async () => {
    /* Back from a film of this one's collection lands on its tile, once the
       metadata (which names the collection) and the rail are in. */
    const back = takeDetailFocus();
    if (!(await focusKey('lk-watch')) && !(await focusKey('lk-add')) && !(await focusKey('lk-stat'))) await focusFirst();
    await loadMeta();
    if (!alive) return;
    if (back) {
      if (collId) await collP;
      if (!alive) return;
      // Only if the D-pad hasn't moved on from the button focused above.
      const a = document.activeElement;
      if (!a || a === document.body || a.closest('.hero .actions')) await focusKey(back);
    }
    if (!document.activeElement || document.activeElement === document.body) focusFirst();
  });
</script>

<div class="screen" onfocusin={homeOnTopRow}>
  <div class="page">
    <div class="hero {tv ? 'series' : 'movie'}">
      <div class="backdrop">{#if bg}<img use:decoded={bg} alt="" />{/if}</div>
      <div class="scrim-l"></div>
      <div class="scrim-b"></div>
      <div class="info">
        <div class="title">{title}</div>
        <div class="metarow">
          {#if yr}<span>{yr}</span>{/if}
          {#if tv && nSeasons}
            <span class="dot">·</span>
            <span>{nSeasons}{nSeasons === 1 ? ' season' : ' seasons'} · {nEps} episodes</span>
          {:else if runtime}
            <span class="dot">·</span><span>{runtime}</span>
          {/if}
          {#if meta?.certification}<span class="dot">·</span><span class="fsk">{meta.certification}</span>{/if}
          {#if meta?.rating}<span class="star">★ {meta.rating.toFixed(1)}</span>{/if}
          {#if genres}<span class="dot">·</span><span class="genres">{genres}</span>{/if}
        </div>
        <!-- overview in the hero for a show, in .body for a movie — matching
             where SeriesDetail and MovieDetail respectively put it -->
        {#if tv && overview}<div class="overview">{overview}</div>{/if}
        <div class="actions">
          {#if state === 'idle' || state === 'error'}
            <button class="btn primary big focus" data-focus="lk-add" onclick={add}
              ><Icon name="plus" inline />{state === 'error' ? 'Try again · Add to library' : 'Add to library'}</button
            >
          {:else}
            {#if streamable}
              <button class="btn primary big focus" data-focus="lk-watch" onclick={watch}
                >{starting ? 'Starting…' : '▶ Watch while downloading' + (tv ? ' · S' + (streamable.season || 0) + ':E' + (streamable.episode || 0) : '')}</button
              >
            {/if}
            <!-- Focusable, unlike PendingDetail's badge: after Add on a movie it is
                 the only thing left on the screen to stand on. OK opens the
                 download's page once there is one. -->
            <button class="btn stat big focus" data-focus="lk-stat" onclick={statClick}>{state === 'adding' ? 'Adding…' : stat}</button>
          {/if}
          {#if trailer}
            <button class="btn ghost big focus" data-focus="lk-trailer" onclick={openTrailer}
              ><Icon name="trailer" inline />Trailer</button
            >
          {/if}
        </div>
        {#if (state === 'idle' || state === 'error') && meta}<div class="lkhint">{addHint}</div>{/if}
      </div>
    </div>

    <div class="body">
      {#if tv}
        {#if seasonNums.length > 1}
          <div class="seasonrow">
            {#each seasonNums as n (n)}
              <button class="pill focus" class:active={n === curSeason} data-focus="lkseason-{n}" onclick={() => (selSeason = n)}
                >{seasonName(n)}</button
              >
            {/each}
          </div>
        {/if}
        {#if seasonSum}<div class="season-sum">{seasonSum}</div>{/if}
        {#if meta && !episodes.length}
          <div class="loading" style="padding:8px 0 12px">The episode list appears once the show is in your library.</div>
        {/if}

        <div class="eplist">
          {#each eps as e (e.season + ':' + e.episode)}
            <button class="eprow focus" data-focus="lkep-{e.season}-{e.episode}" onclick={() => epClick(e)}>
              <div class="thumb">
                {#if e.still && !badStill[e.still]}<img loading="lazy" src={e.still} alt="" onerror={() => (badStill[e.still] = true)} />{:else}<div class="ph">episode</div>{/if}
              </div>
              <div class="meta">
                <div class="line">
                  <div class="etitle">S{e.season}:E{e.episode}{e.title ? ' · ' + e.title : ''}</div>
                  <div class="esub">{epSub(e)}</div>
                </div>
                <div class="plot">{e.overview || ''}</div>
              </div>
            </button>
          {/each}
        </div>
      {:else if overview}
        <div class="overview">{overview}</div>
      {/if}
    </div>

    {#if collId}
      <CollectionRail id={collId} self={item.id} owned={state === 'added'} onready={collDone} />
    {/if}
  </div>
</div>
