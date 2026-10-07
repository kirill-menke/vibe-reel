<script>
  /* Route `lookup` {item}: a title that isn't in Jellyfin yet (a Search /
   * Trending / collection result) — the TV's LookupDetail on the phone layout.
   * Built from the lookup result plus mlMetadata() (Sonarr/Radarr: overview,
   * fanart, runtime, genres, rating, certification, trailer, collection and —
   * for a show Sonarr already has — every episode). Where Play would be:
   * "Add to library" (mlLibraryAdd via addToLibrary; toast with Undo), which
   * then turns into the live Queued/Downloading status off the activity poll.
   * A show not in Sonarr has no episode list; a movie gets its collection.
   * A normal user at their quota (GET /api/me, me.svelte.js) gets a grey
   * "Quota full (10/10 movies)" instead, which opens My library — nothing is
   * sent (run/design.md §7.4). */
  import { onDestroy, onMount, untrack } from 'svelte';
  import NavBar from '../components/NavBar.svelte';
  import Button from '../components/Button.svelte';
  import Badge from '../components/Badge.svelte';
  import Icon from '../components/Icon.svelte';
  import DetailHero from '../components/detail/DetailHero.svelte';
  import MetaLine from '../components/detail/MetaLine.svelte';
  import ActionBar from '../components/detail/ActionBar.svelte';
  import Overview from '../components/detail/Overview.svelte';
  import SeasonPills from '../components/detail/SeasonPills.svelte';
  import EpisodeRow from '../components/detail/EpisodeRow.svelte';
  import StatusButton from '../components/detail/StatusButton.svelte';
  import CollectionRail from '../components/detail/CollectionRail.svelte';
  import { hmin, statusParts, pendStatus, dlOf, solidPoint, epTitle, morphFade } from '../components/detail/detail.js';
  import { fade, scale } from 'svelte/transition';
  import { DUR, rm, springEase } from '../lib/safe.js';
  import { scrollPast } from '../lib/gestures.js';
  import { mlMetadata } from '$lib/medialib.js';
  import { fanartUrl, addState, addToLibrary, lookupGroup } from '$lib/lookup.svelte.js';
  import { openTrailer } from '$lib/trailer.js';
  import { fmtDate } from '$lib/format.js';
  import { quotaFull, quotaLine, quotaWords, refreshMe } from '$lib/me.svelte.js';
  import { push } from '../lib/router.svelte.js';

  let { params = {}, active = false } = $props();
  const item = untrack(() => params.item) || {};
  const tv = item.type === 'tv';

  let dead = false;
  onDestroy(() => (dead = true));

  /** @type {Reel.Metadata | null} */
  let meta = $state(/** @type {Reel.Metadata | null} */ (null));
  /* DET-02: the hero waits (tonal placeholder, full height) until the metadata
   * has answered, so it goes placeholder → fanart instead of poster → fanart;
   * a slow backend falls back to the poster after 1.2 s. */
  let metaDone = $state(false);
  const metaWait = setTimeout(() => (metaDone = true), 1200);
  onDestroy(() => clearTimeout(metaWait));
  function loadMeta() {
    return mlMetadata(item.type, item.id)
      .then((m) => !dead && (meta = m))
      .catch(() => {
        /* the lookup result carries the page on its own */
      })
      .finally(() => {
        if (!dead) metaDone = true;
      });
  }
  loadMeta();

  const st = $derived(addState(item));
  const group = $derived(lookupGroup(item));

  /* Adding a show makes its episode list exist — refetch once it's in. */
  let refetched = false;
  $effect(() => {
    if (tv && st === 'done' && !refetched) {
      refetched = true;
      loadMeta();
    }
  });

  const title = $derived(meta?.title || item.title || '');
  const bg = $derived(metaDone ? fanartUrl(meta?.fanart || meta?.poster || item.poster) : null);
  const year = $derived(meta?.year || item.year || '');
  const yr = $derived(year ? year + (tv && /^continuing$/i.test(meta?.status || '') ? '–' : '') : '');
  const overview = $derived(meta?.overview || item.overview || '');
  const runtime = $derived(!tv && meta?.runtime_min ? hmin(meta.runtime_min * 60) : '');
  const genres = $derived(meta?.genres?.length ? meta.genres.slice(0, 3).join(' · ') : '');
  const trailer = $derived(meta?.trailer || null);
  const collId = $derived(!tv && meta?.collection ? meta.collection.id : '');

  /* ---- tv: seasons + episodes (only once Sonarr has the show) ---- */
  const episodes = $derived(meta?.episodes || []);
  const seasonNums = $derived(
    [...new Set(episodes.map((e) => e.season).filter((n) => n != null))].sort((a, b) => (a || 1e9) - (b || 1e9))
  );
  const nSeasons = $derived(seasonNums.filter((n) => n > 0).length);
  /** @type {number | null} */
  let selSeason = $state(/** @type {number | null} */ (null));
  const curSeason = $derived(selSeason != null && seasonNums.includes(selSeason) ? selSeason : seasonNums[0]);
  const eps = $derived(episodes.filter((e) => e.season === curSeason).sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0)));
  const seasonName = (/** @type {number} */ n) => (n === 0 ? 'Specials' : 'Season ' + n);
  const pills = $derived(
    seasonNums.length > 1 ? seasonNums.map((n) => ({ key: 's' + n, label: seasonName(n), active: n === curSeason })) : []
  );
  const pendOf = (/** @type {Reel.EpisodeMetadata} */ e) => group?.items.find((p) => p.season === e.season && p.episode === e.episode) || null;

  /* what Add will do (the arr's own release status) */
  const addHint = $derived.by(() => {
    const s = (meta?.status || '').toLowerCase();
    if (tv) {
      if (s === 'upcoming') return 'Not aired yet — episodes download on their own as they air.';
      if (s === 'ended') return 'Sends every episode to the download queue on your server.';
      return 'Sends every aired episode to the download queue, then new ones as they air.';
    }
    return waitLine || 'Sends it to the download queue on your server.';
  });

  /* A movie that isn't out on disc/streaming yet: say so, with the digital
   * release date when the lookup (trending / search) carries one. */
  const digital = $derived.by(() => {
    const d = item.digital_release || /** @type {{ digital_release?: string | null } | null} F09: never in /api/metadata */ (meta)?.digital_release;
    return d && Date.parse(d) > Date.now() ? fmtDate(d) : '';
  });
  const waitLine = $derived.by(() => {
    if (tv) return '';
    const s = (meta?.status || '').toLowerCase();
    const when = digital ? ' Digital release expected ' + digital + '.' : '';
    if (s === 'announced' || s === 'tba') return 'Not released yet — it downloads on its own once it’s out.' + when;
    if (s === 'incinemas') return 'Still in cinemas — it downloads as soon as a release turns up.' + when;
    return when.trim();
  });

  /** @type {VR.Eyebrow} */
  const eyebrow = $derived.by(() => {
    if (group) return group.status === 'downloading' ? { text: 'Downloading', kind: 'gold', icon: 'download' } : { text: 'Queued', icon: 'clock' };
    if (st === 'idle' || st === 'error') return { text: 'Not in library', icon: 'plus' };
    if (st === 'adding') return { text: 'Adding…', icon: 'clock' };
    return { text: 'Added', icon: 'check' };
  });

  const note = $derived.by(() => {
    if (group) {
      if (tv) {
        const n = group.items.length;
        return n + (n === 1 ? ' episode' : ' episodes') + ' on the way. They’ll appear in your library as each one finishes.';
      }
      return 'You can leave this page — the bell tells you when it’s ready.';
    }
    if (st === 'done') return 'Progress shows here as soon as a download starts.';
    if (st === 'added') return waitLine || 'It’s on your server’s list — waiting for a release to download.';
    return '';
  });

  /* at the quota: no Add, the way to make room instead (the server would
   * refuse with 409 quota_exceeded anyway) */
  onMount(() => {
    refreshMe({ maxAge: 60000 });
  });
  const full = $derived(!group && (st === 'idle' || st === 'error') && quotaFull(item.type));

  const noteText = $derived(
    full
      ? 'You have ' + quotaWords(item.type) + '. Delete one in My library to add another.'
      : st === 'idle' || st === 'error'
        ? addHint
        : st === 'adding'
          ? ''
          : note
  );

  /* The button answers where the finger is, in the tiles' quick-add language
   * (LIB-02): one gold button that stays put — "+ Add to library" → spinner
   * "Adding…" → a ✓ that pops in, "Added", held 1.2 s (only when this page saw
   * the add; opened already added shows the status at once) — then the grey
   * status button cross-fades in. A download starting wins at once. */
  let sawAdding = false;
  let addedHold = $state(false);
  $effect(() => {
    const s = st;
    if (s === 'adding') sawAdding = true;
    else if (s === 'done' && sawAdding) {
      sawAdding = false;
      addedHold = true;
      const t = setTimeout(() => (addedHold = false), 1200);
      return () => clearTimeout(t);
    } else if (s !== 'done') {
      sawAdding = false;
      addedHold = false;
    }
  });
  const addPhase = $derived(
    group ? null : st === 'idle' || st === 'error' ? 'plus' : st === 'adding' ? 'busy' : st === 'done' && addedHold ? 'done' : null
  );

  function add() {
    if (addPhase !== 'plus') return;
    addToLibrary(item);
  }

  /* ---- nav bar: solid once the backdrop has scrolled under it ---- */
  let heroH = $state(440);
  let solid = $state(false);
  const solidAt = $derived(solidPoint(heroH));
</script>

<main class="screen" use:scrollPast={{ y: solidAt, onchange: (s) => (solid = s) }}>
  <DetailHero src={bg} pending={!metaDone} bind:height={heroH} />
  <div class="detail__body">
    <div class="detail__head">
      <!-- a polite live region: VoiceOver hears the state *changes* (DET-10) -->
      <p class="detail__eyebrow" aria-live="polite">{#key eyebrow.text}<span class="detail__eyebrowin" in:fade={morphFade}><Badge kind={eyebrow.kind || ''} icon={eyebrow.icon} text={eyebrow.text} /></span>{/key}</p>
      <h1 class="detail__title {title.length > 38 ? 'detail__title--long' : ''}">{title}</h1>
      <MetaLine
        parts={[yr, tv ? (nSeasons ? nSeasons + (nSeasons === 1 ? ' season' : ' seasons') : '') : runtime]}
        rating={meta?.rating}
        cert={meta?.certification}
      />
      {#if genres}<p class="detail__genres">{genres}</p>{/if}
    </div>
    <!-- DET-09: one cell per slot; the states cross-fade in place -->
    <div class="detail__buttons">
      <div class="detail__morph">
        {#if full}
          <div transition:fade={morphFade}>
            <Button variant="surface" block icon="lock" class="lk__full" onclick={() => push('mylibrary')}>Quota full ({quotaLine(item.type)})</Button>
          </div>
        {:else if addPhase}
          <!-- one button through + → spinner → ✓ (no cross-fade between them) -->
          <div transition:fade={morphFade}>
            <Button
              variant="primary"
              block
              icon={addPhase === 'plus' ? 'plus' : ''}
              busy={addPhase === 'busy'}
              aria-disabled={addPhase === 'done' || undefined}
              class={addPhase === 'done' ? 'btn--added' : ''}
              onclick={add}
            >{#if addPhase === 'done'}<span class="btn__check" in:scale={{ start: 0.6, duration: rm(DUR.springQuick), easing: springEase.bouncy }}><Icon name="check" size="sm" /></span>Added{:else if addPhase === 'busy'}Adding…{:else}{st === 'error' ? 'Try again · Add to library' : 'Add to library'}{/if}</Button>
          </div>
        {:else if group}
          <div transition:fade={morphFade}><StatusButton s={statusParts(group)} /></div>
        {:else}
          <div transition:fade={morphFade}><StatusButton s={{ pct: '', rest: st === 'done' ? 'Added — looking for a download' : 'Waiting for a release', p: 0 }} /></div>
        {/if}
      </div>
      <div class="detail__noteslot">
        {#key noteText}<p class="detail__note" transition:fade={morphFade}>{noteText}</p>{/key}
      </div>
    </div>
    <ActionBar actions={[trailer && { id: 'trailer', icon: 'trailer', label: 'Trailer', onclick: () => openTrailer(trailer, { title, art: bg }) }]} />
    <Overview text={overview} />
  </div>

  {#if tv && eps.length}
    <div class="detail__gap"></div>
    <SeasonPills {pills} onpick={(k) => (selSeason = +k.slice(1))} />
    <div class="episodes detail__episodes">
      {#each eps as e (e.season + ':' + e.episode)}
        {@const p = pendOf(e)}
        <EpisodeRow
          img={e.still || null}
          num={'E' + e.episode + (e.air_date ? ' · ' + fmtDate(e.air_date) : '')}
          title={epTitle(e.title) || 'Episode ' + e.episode}
          overview={e.overview || ''}
          status={p ? pendStatus(p) : e.has_file ? 'Downloaded' : ''}
          dl={p ? dlOf(p) : null}
        />
      {/each}
    </div>
  {:else if tv && meta && (st === 'done' || st === 'added')}
    <p class="detail__empty">The episode list appears once your server has the show.</p>
  {/if}

  {#if collId}<CollectionRail id={collId} self={item.id} owned={st === 'added'} />{/if}
</main>
<NavBar {title} {solid} />
