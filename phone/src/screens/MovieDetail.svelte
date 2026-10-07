<script>
  /* A movie's (or a single episode's) page — the phone layout of the TV's
   * MovieDetail: backdrop, serif title, meta line, genres, resume row, gold
   * Play/Resume, ActionBar (Trailer · Watched · From start), overview, tech
   * badges (+ the slow-link hint off P.link), Cast & Crew, the franchise
   * (CollectionRail), More Like This and the details list. The item comes
   * from Detail.svelte, which re-reads it after playback. */
  import { onDestroy } from 'svelte';
  import NavBar from '../components/NavBar.svelte';
  import Button from '../components/Button.svelte';
  import Icon from '../components/Icon.svelte';
  import Rail from '../components/Rail.svelte';
  import Tile from '../components/Tile.svelte';
  import ProgressBar from '../components/ProgressBar.svelte';
  import TechBadges from '../components/TechBadges.svelte';
  import DetailHero from '../components/detail/DetailHero.svelte';
  import MetaLine from '../components/detail/MetaLine.svelte';
  import ActionBar from '../components/detail/ActionBar.svelte';
  import Overview from '../components/detail/Overview.svelte';
  import CastRail from '../components/detail/CastRail.svelte';
  import CollectionRail from '../components/detail/CollectionRail.svelte';
  import { runtimeOf, leftOf, resumeSecOf, progressOf, techBadges, detailRows, slowLink, solidPoint, lateIn } from '../components/detail/detail.js';
  import { scrollPast } from '../lib/gestures.js';
  import { cfg } from '$lib/config.js';
  import { api, qs, errText, imgUrl } from '$lib/api.js';
  import { yearOf } from '$lib/format.js';
  import { openItem } from '$lib/nav.svelte.js';
  import { P, playItem } from '$lib/player.svelte.js';
  import { setPlayed } from '$lib/played.js';
  import { pickTrailer, openTrailer } from '$lib/trailer.js';
  import { toast } from '$lib/toast.svelte.js';
  import { OFF, offlineSupported } from '../lib/offline.svelte.js';
  import { openSheet, push as pushRoute } from '../lib/router.svelte.js';

  let { item, late = false } = $props();

  let dead = false;
  onDestroy(() => (dead = true));

  /* The watched toggle's answer, until Detail hands in a fresher item. */
  let udNow = $state(/** @type {Jf.UserItemData | null} */ (null));
  /** @type {Jf.BaseItemDto | null} */
  let udFor = null;
  $effect(() => {
    if (item !== udFor) {
      udFor = item;
      udNow = null;
    }
  });
  const it = $derived(udNow ? { ...item, UserData: udNow } : item);
  const ud = $derived(it.UserData || {});
  const resumeSec = $derived(resumeSecOf(it));
  const canResume = $derived(resumeSec > 30 && !ud.Played);
  const isEp = $derived(item.Type === 'Episode');

  const bg = $derived(
    /* an episode shows its own still (the series' backdrop said nothing about which episode) */
    (isEp ? imgUrl(item, 'Primary', { w: 1280 }) : null) || imgUrl(item, 'Backdrop', { w: 1280 }) || imgUrl(item, 'Primary', { h: 1080 })
  );
  const badges = $derived(techBadges(item));
  const slow = $derived(slowLink(P.link, item));
  const rows = $derived(detailRows(item));
  const trailer = $derived(pickTrailer(item));
  const collId = $derived(item.Type === 'Movie' ? item.ProviderIds?.TmdbCollection || '' : '');
  const genres = $derived((item.Genres || []).slice(0, 3).join(' · '));

  const people = $derived.by(() => {
    const ps = item.People || [];
    const actors = ps.filter((/** @type {Jf.BaseItemPerson} */ p) => p.Type === 'Actor').slice(0, 14);
    const crew = ps.filter((/** @type {Jf.BaseItemPerson} */ p) => p.Type === 'Director').slice(0, 2);
    return [...actors, ...crew];
  });

  const epLine = $derived.by(() => {
    if (!isEp) return '';
    const eb = [];
    if (item.ParentIndexNumber != null) eb.push('Season ' + item.ParentIndexNumber);
    if (item.IndexNumber != null) eb.push('Episode ' + item.IndexNumber);
    return eb.join(' · ');
  });

  /* ---- actions ---- */
  /* Watched flips at once (DET-11): the tick shows on the tap, the server's
   * answer confirms it; a failure puts it back with the toast. `busyWatched`
   * only blocks a second tap meanwhile — no spinner. */
  let busyWatched = false;
  let wantWatched = $state(/** @type {boolean | null} */ (null));
  $effect(() => {
    void item;
    wantWatched = null;
  });
  const watchedOn = $derived(wantWatched ?? !!ud.Played);
  function toggleWatched() {
    if (busyWatched) return;
    const want = !watchedOn;
    busyWatched = true;
    wantWatched = want;
    setPlayed(item.Id, want)
      .then((r) => {
        if (dead) return;
        udNow = r || { ...ud, Played: want, PlaybackPositionTicks: 0, PlayedPercentage: 0 };
        wantWatched = null;
        toast(want ? 'Marked as watched' : 'Marked as unwatched');
      })
      .catch((e) => {
        if (!dead) wantWatched = null;
        toast('Couldn’t update: ' + errText(e));
      })
      .finally(() => (busyWatched = false));
  }

  /* Download to the phone (lib/offline.svelte.js): the sheet picks a quality;
   * once queued the action shows its progress and leads to Downloads. */
  const dl = $derived(OFF.list.find((e) => e.id === item.Id && e.user === cfg.userId) || null);
  /* The ring's fraction ticks with every segment; it is read through a getter
   * so only the ring follows it — `dl.done` in the object itself rebuilt
   * the whole action list per segment. */
  const dlP = $derived(dl && dl.state === 'downloading' && dl.total ? dl.done / dl.total : null);
  const dlState = $derived(dl ? dl.state : null);
  const dlAction = $derived(
    !dlState
      ? { id: 'download', icon: 'download', label: 'Download', onclick: () => openSheet('offline', { item }) }
      : {
          id: 'download',
          icon: dlState === 'done' ? 'check-circle' : 'download',
          label: dlState === 'done' ? 'Downloaded' : dlState === 'downloading' ? 'Downloading' : dlState === 'error' ? 'Failed' : dlState === 'paused' ? 'Paused' : 'Waiting',
          /* the ring (App Store style) while segments come in */
          get p() {
            return dlP;
          },
          on: dlState === 'done',
          onclick: () => pushRoute('downloads')
        }
  );

  const actions = $derived([
    trailer && { id: 'trailer', icon: 'trailer', label: 'Trailer', onclick: () => openTrailer(trailer, { title: item.Name, art: bg }) },
    { id: 'watched', icon: 'check-circle', label: 'Watched', on: watchedOn, onclick: toggleWatched },
    canResume && !wantWatched && { id: 'restart', icon: 'restart', label: 'From start', onclick: () => playItem(item, 0) },
    isEp && item.SeriesId && { id: 'show', icon: 'shows', label: 'Show', onclick: () => openItem(item.SeriesId, 'Series') },
    offlineSupported() && dlAction
  ]);

  /* ---- More Like This ----
   * No Fields: a poster Tile reads only Name/Type/ImageTags/UserData/
   * ProductionYear/PremiereDate, which /Similar returns anyway. GRID_FIELDS
   * dragged MediaSources along for a tech badge the phone's Tile doesn't draw
   * (measured: 19.8 KB → 4.1 KB for 12 titles). Keyed on the id, not the
   * item: Detail hands in a new object after every playback, and the list
   * doesn't change with the play state. */
  const itemId = $derived(item.Id);
  let similar = $state.raw(/** @type {Jf.BaseItemDto[]} */ ([]));
  $effect(() => {
    const id = itemId;
    let gone = false;
    /** @type {Promise<Jf.QueryResult>} */ (api('/Items/' + id + '/Similar' + qs({ userId: cfg.userId, Limit: 12 })))
      .then((r) => !gone && (similar = r.Items || []))
      .catch(() => {});
    return () => (gone = true);
  });

  /* ---- nav bar: solid once the backdrop has scrolled under it ---- */
  let heroH = $state(440);
  let solid = $state(false);
  const solidAt = $derived(solidPoint(heroH));
</script>

<main class="screen" use:lateIn={late} use:scrollPast={{ y: solidAt, onchange: (s) => (solid = s) }}>
  <DetailHero src={bg} {late} bind:height={heroH} />
  <div class="detail__body">
    <div class="detail__head">
      {#if isEp && item.SeriesName}
        <button type="button" class="detail__series" onclick={() => openItem(item.SeriesId, 'Series')}>{item.SeriesName}<Icon name="chevron-right" size="xs" /></button>
      {/if}
      <h1 class="detail__title {item.Name.length > 38 ? 'detail__title--long' : ''}">{item.Name}</h1>
      <MetaLine parts={[epLine || yearOf(item), runtimeOf(item.RunTimeTicks)]} rating={item.CommunityRating} cert={item.OfficialRating} />
      {#if genres}<p class="detail__genres">{genres}</p>{/if}
    </div>
    {#if canResume}
      <div class="detail__resume"><ProgressBar p={progressOf(it)} /><span>{leftOf(it)}</span></div>
    {/if}
    <Button variant="primary" block icon="play" onclick={() => playItem(item, canResume ? Math.floor(resumeSec) : 0)}>{canResume ? 'Resume' : 'Play'}</Button>
    <ActionBar {actions} />
    <Overview text={item.Overview || ''} />
    <TechBadges {badges} />
    {#if slow}
      <p class="detail__hint"><Icon name="info" />{slow.capped ? 'At your streaming quality this needs' : 'This file needs'} about {slow.need} Mbit/s; the phone got about {slow.got} earlier — expect buffering.</p>
    {/if}
  </div>

  <CastRail {people} />
  {#if collId}<CollectionRail id={collId} self={item.ProviderIds?.Tmdb} owned />{/if}
  {#if similar.length}
    <Rail title="More Like This">
      {#each similar as s (s.Id)}<Tile item={s} onclick={() => openItem(s.Id, s.Type)} />{/each}
    </Rail>
  {/if}
  {#if rows.length}
    <section class="section detail__kvsec" aria-label="Details">
      <div class="section__head"><h2 class="section__title">Details</h2></div>
      <dl class="kv selectable">
        {#each rows as r (r.k)}
          <dt>{r.k}</dt>
          <dd>{#if r.lines}{#each r.lines as l, i (i)}{#if i}<br />{/if}{l}{/each}{:else}{r.v}{/if}</dd>
        {/each}
      </dl>
    </section>
  {/if}
</main>
<NavBar title={item.Name} {solid} />
