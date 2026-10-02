<script module>
  /* Last snapshot per group key, outliving the component (the TV's lastSnap):
   * a remount after the import landed would otherwise find the group already
   * gone from the poll and show nothing instead of "Now in your library". */
  const lastSnap = new Map(); // key -> plain group
  /* …and the Jellyfin item it landed as, so a revisit shows "Open" at once */
  const lastLanded = new Map(); // key -> item
</script>

<script>
  /* Route `pending` {key}: a title still downloading/importing, no Jellyfin
   * item yet — the TV's PendingDetail on the phone layout. Two sources: the
   * live activity poll (status, %, speed, ETA) and mlMetadata() (everything
   * Sonarr/Radarr know: overview, fanart, runtime, genres, rating, trailer,
   * per-episode titles/stills). The gold button is a greyed status button;
   * Long-press an episode row, or the "Cancel" action for the whole title,
   * cancels downloads (confirm step; cancel.svelte.js) — a cancelled title
   * says so instead of waiting for an import.
   * once the whole title has imported the page looks it up in Jellyfin
   * (3 s / 8 s / 20 s, for the library scan) and offers "Now in your library
   * — Open". "Play while downloading" (canWatchPending) plays the growing file
   * as live HLS remuxed by reel-api (livefeed.js). */
  import { onDestroy, untrack } from 'svelte';
  import NavBar from '../components/NavBar.svelte';
  import Button from '../components/Button.svelte';
  import Badge from '../components/Badge.svelte';
  import TechBadges from '../components/TechBadges.svelte';
  import StateMessage from '../components/StateMessage.svelte';
  import DetailHero from '../components/detail/DetailHero.svelte';
  import MetaLine from '../components/detail/MetaLine.svelte';
  import ActionBar from '../components/detail/ActionBar.svelte';
  import Overview from '../components/detail/Overview.svelte';
  import SeasonPills from '../components/detail/SeasonPills.svelte';
  import EpisodeRow from '../components/detail/EpisodeRow.svelte';
  import StatusButton from '../components/detail/StatusButton.svelte';
  import ContextMenu from '../components/ContextMenu.svelte';
  import { isCancelling, packOf, cancelWhat, confirmItems, cancelItem, cancelGroup, cancelledGroups } from '$lib/cancel.svelte.js';
  import { confirmMenu } from '../lib/confirm.svelte.js';
  import { hmin, statusParts, pendStatus, dlOf, solidPoint, releaseBadges, epTitle, morphFade, landIn } from '../components/detail/detail.js';
  import { fade } from 'svelte/transition';
  import { scrollPast } from '../lib/gestures.js';
  import { mlMetadata, mlLookup } from '$lib/medialib.js';
  import { groupByKey, matchGroup } from '$lib/activity.svelte.js';
  import { fanartUrl } from '$lib/lookup.svelte.js';
  import { canWatchPending, canStream, playPending } from '$lib/pendingplay.js';
  import { api, itemsPath } from '$lib/api.js';
  import { replace } from '../lib/router.svelte.js'; // "Open": the detail page takes this page's place
  import { openTrailer } from '$lib/trailer.js';
  import { fmtDate } from '$lib/format.js';

  let { params = {}, active = false } = $props();
  const key = untrack(() => params.key);

  let dead = false;
  onDestroy(() => {
    dead = true;
    clearTimeout(landTimer);
    clearTimeout(metaWait);
  });

  const group = $derived(groupByKey(key));
  let snap = $state(lastSnap.get(key) || null);
  $effect(() => {
    if (group) {
      const plain = $state.snapshot(group);
      snap = plain;
      lastSnap.set(key, plain);
    }
  });
  const g = $derived(group || snap);
  /* gone from the feed because it was cancelled here, not imported */
  const cancelled = $derived(!group && !!cancelledGroups[key]);
  const done = $derived(!group && !!snap && !cancelled);
  const tv = $derived(g?.type === 'tv');

  /* metadata: by the arr id, else a title lookup (older backends) */
  let meta = $state(null);
  /* DET-02: hero waits for the metadata (fanart) — see LookupDetail */
  let metaDone = $state(false);
  const metaWait = setTimeout(() => (metaDone = true), 1200);
  let metaAsked = false;
  $effect(() => {
    const g0 = g;
    if (!g0 || metaAsked) return;
    metaAsked = true;
    untrack(() => loadMeta(g0));
  });
  async function loadMeta(g0) {
    try {
      await metaOf(g0);
    } finally {
      if (!dead) metaDone = true;
    }
  }
  async function metaOf(g0) {
    try {
      if (g0.mediaId) {
        const m = await mlMetadata(g0.type, g0.mediaId);
        if (!dead) meta = m;
        return;
      }
    } catch {
      /* fall through */
    }
    try {
      const r = await mlLookup({ q: g0.title, type: g0.type });
      const hit = (r.results || []).find((x) => x.title.toLowerCase() === g0.title.toLowerCase());
      if (hit && !dead) meta = { ...hit, genres: [], episodes: [] };
    } catch {
      /* the live queue state carries the page */
    }
  }

  const bg = $derived(metaDone ? fanartUrl(meta?.fanart || meta?.poster || g?.poster) : null);
  const year = $derived(meta?.year || g?.year || '');
  const runtime = $derived(!tv && meta?.runtime_min ? hmin(meta.runtime_min * 60) : '');
  const genres = $derived(meta?.genres?.length ? meta.genres.slice(0, 3).join(' · ') : '');
  const trailer = $derived(meta?.trailer || null);
  const qualities = $derived(g ? [...new Set(g.items.map((i) => i.quality).filter(Boolean))] : []);
  const badges = $derived(releaseBadges(qualities, g?.size));

  /* the button: the single grab for a movie, the aggregate for a show */
  const status = $derived.by(() => {
    if (!g) return null;
    const one = !tv && g.items.length === 1 ? g.items[0] : null;
    return one ? statusParts(one, one.download_speed) : statusParts(g);
  });
  const streamable = $derived(canWatchPending && g && !done ? g.items.find(canStream) || null : null);

  /* ---- tv: seasons + rows ---- */
  const seasonNums = $derived(tv ? [...new Set(g.items.map((i) => i.season).filter((n) => n != null))].sort((a, b) => a - b) : []);
  let selSeason = $state(null);
  const curSeason = $derived(selSeason != null && seasonNums.includes(selSeason) ? selSeason : seasonNums[0]);
  const eps = $derived(tv ? g.items.filter((i) => (i.season ?? null) === (curSeason ?? null)) : []);
  const epMeta = $derived.by(() => {
    const m = new Map();
    for (const e of meta?.episodes || []) m.set(e.season + ':' + e.episode, e);
    return m;
  });
  const pills = $derived(
    seasonNums.length > 1
      ? seasonNums.map((n) => {
          const its = g.items.filter((i) => i.season === n);
          const pct = Math.round((its.reduce((a, i) => a + (i.progress || 0), 0) / its.length) * 100);
          return { key: 's' + n, label: 'Season ' + n, active: n === curSeason, dim: true, pct };
        })
      : []
  );

  /* ---- the import landed: find it in Jellyfin ---- */
  let landed = $state(lastLanded.get(key) || null);
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
  async function findLanded() {
    const sg = g;
    if (!sg) return;
    try {
      const r = await api(
        itemsPath({ SearchTerm: sg.title, IncludeItemTypes: sg.type === 'tv' ? 'Series' : 'Movie', Recursive: true, Fields: 'ProviderIds', Limit: 20 })
      );
      if (dead) return;
      const it = (r.Items || []).find((i) => matchGroup([sg], i));
      if (it) {
        landed = it;
        lastLanded.set(key, it);
        return;
      }
    } catch {
      /* try again below */
    }
    if (!dead && landTries < LAND_DELAYS.length) landTimer = setTimeout(findLanded, LAND_DELAYS[landTries++]);
  }

  const eyebrow = $derived(
    done
      ? landed
        ? { text: 'In your library', kind: 'gold', icon: 'check' }
        : { text: 'Importing', icon: 'download' }
      : g?.status === 'downloading' ? { text: 'Downloading', kind: 'gold', icon: 'download' } : g?.status === 'importing' ? { text: 'Importing', icon: 'download' } : { text: 'Queued', icon: 'clock' }
  );

  const note = $derived.by(() => {
    if (done) return landed ? 'Ready to watch.' : 'All done — it’s being added to your library now.';
    if (tv) {
      const n = g.items.length;
      /* the count is in the meta line already */
      return 'You can leave this page — the bell tells you when ' + (n === 1 ? 'it’s' : 'they’re') + ' ready.';
    }
    return 'You can leave this page — the bell tells you when it’s ready.';
  });

  /* ---- cancel download: long-press a row / the Cancel action → the action
   * sheet confirms (ACT-01; no second context menu) ---- */
  let menu = $state({ open: false, rect: null, items: [], label: '' });
  function rowMenu(it, d) {
    menu = {
      open: true,
      rect: d.rect,
      label: 'Episode ' + (it.episode ?? '') + ' download',
      items: [{ label: 'Cancel download…', icon: 'x', danger: true, action: () => confirmMenu(confirmItems(cancelWhat(it), packOf(it).length, () => cancelItem(it))) }]
    };
  }
  function titleMenu() {
    const g0 = group;
    if (!g0) return;
    const n = tv ? g0.items.length : 1;
    const what = '“' + g0.title + '”' + (tv ? ' (' + n + (n === 1 ? ' episode' : ' episodes') + ')' : '');
    confirmMenu(confirmItems(what, 1, () => cancelGroup(g0)));
  }
  const groupCancelling = $derived(!!group && group.items.every(isCancelling));

  /* ---- nav bar: solid once the backdrop has scrolled under it ---- */
  let heroH = $state(440);
  let solid = $state(false);
  const solidAt = $derived(solidPoint(heroH));
</script>

{#if !g}
  <main class="screen">
    <StateMessage icon="check-circle" title="Nothing in progress" text="This download isn’t in the queue any more — it may already be in your library." fill />
  </main>
  <NavBar />
{:else if cancelled}
  <main class="screen">
    <StateMessage icon="x" title="Download cancelled" text={'Nothing more of “' + g.title + '” will download.'} fill />
  </main>
  <NavBar />
{:else}
  <main class="screen" use:scrollPast={{ y: solidAt, onchange: (s) => (solid = s) }}>
    <DetailHero src={bg} pending={!metaDone} bind:height={heroH} />
    <div class="detail__body">
      <div class="detail__head">
        <!-- a polite live region: VoiceOver hears the state *changes* (DET-10) -->
        <p class="detail__eyebrow" aria-live="polite">{#key eyebrow.text}<span class="detail__eyebrowin" in:fade={morphFade}><Badge kind={eyebrow.kind || ''} icon={eyebrow.icon} text={eyebrow.text} /></span>{/key}</p>
        <h1 class="detail__title {g.title.length > 38 ? 'detail__title--long' : ''}">{g.title}</h1>
        <MetaLine
          parts={[year, tv ? g.items.length + (g.items.length === 1 ? ' episode' : ' episodes') + ' on the way' : runtime]}
          rating={meta?.rating}
          cert={meta?.certification}
        />
        {#if genres}<p class="detail__genres">{genres}</p>{/if}
      </div>
      <!-- DET-09: one cell per slot; the states cross-fade in place, "Open"
           arrives with a small scale-up when the import lands -->
      <div class="detail__buttons">
        {#if streamable}
          <Button variant="primary" block icon="play" onclick={() => playPending(streamable, g, epMeta.get(streamable.season + ':' + streamable.episode))}>Play while downloading</Button>
        {/if}
        <div class="detail__morph">
          {#if done && landed}
            <div in:landIn out:fade={morphFade}><Button variant="primary" block icon="play" onclick={() => replace('detail', { id: landed.Id, type: landed.Type })}>Open</Button></div>
          {:else if done}
            <div transition:fade={morphFade}><StatusButton s={{ pct: '', rest: 'Importing into your library…', p: 1 }} /></div>
          {:else}
            <!-- no "Downloading · " prefix: the eyebrow says it, and the line clipped -->
            <div transition:fade={morphFade}><StatusButton s={status} /></div>
          {/if}
        </div>
        <div class="detail__noteslot">
          {#key note}<p class="detail__note" transition:fade={morphFade}>{note}</p>{/key}
        </div>
      </div>
      <ActionBar
        actions={[
          trailer && { id: 'trailer', icon: 'trailer', label: 'Trailer', onclick: () => openTrailer(trailer, { title: g.title, art: bg }) },
          !done && group?.mediaId && { id: 'cancel', icon: 'x', label: 'Cancel', busy: groupCancelling, onclick: titleMenu }
        ]}
      />
      <Overview text={meta?.overview || ''} />
      {#if !done}<TechBadges {badges} />{/if}
    </div>

    {#if tv && eps.length}
      <div class="detail__gap"></div>
      <SeasonPills {pills} onpick={(k) => (selSeason = +k.slice(1))} />
      <div class="episodes detail__episodes">
        {#each eps as it (it.id)}
          {@const em = epMeta.get(it.season + ':' + it.episode)}
          <EpisodeRow
            img={em?.still || null}
            num={[epTitle(em?.title, it.episode_title) ? 'E' + (it.episode ?? '?') : '', em?.air_date ? fmtDate(em.air_date) : ''].filter(Boolean).join(' · ')}
            title={epTitle(em?.title, it.episode_title) || 'Episode ' + (it.episode ?? '')}
            overview={em?.overview || ''}
            status={done ? 'Imported' : isCancelling(it) ? 'Cancelling…' : pendStatus(it)}
            dl={done ? null : dlOf(it)}
            class={!done && isCancelling(it) ? 'is-cancelling' : ''}
            onlongpress={done || isCancelling(it) ? null : (d) => rowMenu(it, d)}
          />
        {/each}
      </div>
    {/if}
  </main>
  <NavBar title={g.title} {solid} />
{/if}

<ContextMenu open={menu.open} rect={menu.rect} items={menu.items} label={menu.label} onclose={() => (menu = { ...menu, open: false })} />
