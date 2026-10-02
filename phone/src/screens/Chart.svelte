<script module>
  /* Helpers shared with Search.svelte: what the library already has (for the
   * in-library tick and a direct open), a lookup result's tile props, and the
   * "open the richest detail" step. */
  import { api, itemsPath } from '$lib/api.js';
  import { act, providerId, STATUS_LABEL } from '$lib/activity.svelte.js';
  import { posterThumb } from '$lib/medialib.js';
  import { inLibrary, addState, addToLibrary, lookupGroup, lookupOpener } from '$lib/lookup.svelte.js';
  import { S, openItem } from '$lib/nav.svelte.js';
  import { untrack } from 'svelte';
  import { R } from '../lib/router.svelte.js';
  import { downloadOf } from './Library.svelte';

  /* ---- library index: provider id → Jellyfin item, one list per kind ----
   * Search and the charts ask "is this lookup result a Jellyfin title, and is it
   * watched?" for up to 250 titles at once; one light list query per kind
   * answers all of them (no images/MediaSources; ~1 KB per title). Kept 2 min,
   * and only for the play session it was read in: a player close (R.playerClosed
   * — not a trailer's) makes the next call re-read it.
   *
   * An index is { byId: Map(pid → item), sig, names() }. A re-read that comes
   * back with nothing a tile shows changed resolves to the SAME object as
   * before, so a screen can skip the assignment — a chart re-ran all 250
   * resultTile()s on every activation for an identical answer. */
  const IDX_TTL = 120000;
  const idx = {}; // type -> { at, closed, p }
  const lastIdx = {}; // type -> the last index built

  export function libIndex(type) {
    const closed = untrack(() => R.playerClosed);
    const e = idx[type];
    if (e && e.closed === closed && Date.now() - e.at < IDX_TTL) return e.p;
    const tv = type === 'tv';
    const p = api(
      itemsPath({
        IncludeItemTypes: tv ? 'Series' : 'Movie',
        Recursive: true,
        Fields: 'ProviderIds,ProductionYear',
        EnableImageTypes: 'Primary',
        ImageTypeLimit: 1
      })
    ).then((r) => {
      const next = makeIndex(r.Items || [], tv);
      const prev = lastIdx[type];
      if (prev && prev.sig === next.sig) return prev;
      lastIdx[type] = next;
      return next;
    });
    idx[type] = { at: Date.now(), closed, p };
    p.catch(() => idx[type]?.p === p && delete idx[type]);
    return p;
  }

  function makeIndex(items, tv) {
    const byId = new Map();
    let sig = '';
    for (const it of items) {
      const pid = providerId(it, tv ? 'tvdb' : 'tmdb');
      if (!pid) continue;
      byId.set(pid, it);
      // what a tile made from it shows (resultTile → Tile item): poster, title, year, tick, bar
      const ud = it.UserData || {};
      sig += pid + '=' + it.Id + ':' + (it.ImageTags?.Primary || '') + ':' + it.Name + ':' + (it.ProductionYear || '') + ':' +
        !!ud.Played + ':' + (ud.UnplayedItemCount ?? '') + ':' + Math.round(ud.PlayedPercentage || 0) + '|';
    }
    let names = null;
    return {
      byId,
      sig,
      /* every title's name folded for Search's instant matches — once per
       * index, on the first keystroke that needs it, not per keystroke */
      names: () =>
        names ||
        (names = [...byId.values()].map((jf) => {
          const n = fold(jf.Name);
          return { jf, n, bare: n.replace(ARTICLE, ''), words: n.split(' '), flat: n.replaceAll(' ', '') };
        }))
    };
  }

  /* Forgiving title matching (Search's instant library matches): accents,
   * apostrophes, punctuation and a leading article don't count. */
  export function fold(s) {
    return (s || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }
  export const ARTICLE = /^(the|a|an) /;

  /* Tile props for a Sonarr/Radarr lookup (or chart) result. `jf` = its
   * Jellyfin item when the library has it: then the tile is that item
   * (Jellyfin poster, progress, watched tick). Library membership is never
   * spelled out — no "In library" caption, no "Not in library" / "Added"
   * badge (round 3: the user found them noise; the detail page says where a
   * title stands). The quick-add "+" is the one mark, on titles that can be
   * added. `ranked`: the rank badge holds the top-left corner, so a download
   * badge goes bottom-left. Reactive (activity feed, add state). */
  export function resultTile(item, jf, sub, ranked = false) {
    const g = lookupGroup(item);
    if (jf) {
      const lib = { item: jf, sub };
      // a library title with grabs in flight (new episodes, an upgrade) keeps
      // its real tile and gets the library grid's badge, not the pending ring
      if (!g || act.stale) return lib;
      if (g.type === 'tv') return { ...lib, count: g.items.length };
      const t = g.status === 'downloading' ? Math.round((g.progress || 0) * 100) + '%' : STATUS_LABEL[g.status] || g.status;
      return { ...lib, badge: { text: t, kind: 'gold', icon: 'download', bottom: ranked } };
    }
    const st = addState(item);
    return {
      title: item.title,
      sub,
      img: posterThumb(item.poster),
      watched: false,
      progress: 0,
      download: g ? downloadOf(g) : null,
      // the "+" stays and answers: spinner while adding, then a gold ✓ (LIB-02)
      addState: g ? null : st,
      onadd: !g && (st === 'idle' || st === 'error') ? () => addToLibrary(item) : null
    };
  }

  export function kindWord(item) {
    return item.type === 'tv' ? 'Show' : 'Movie';
  }

  /* Open the richest screen for a result: its Jellyfin detail, PendingDetail
   * while the first download is in flight, else LookupDetail. The lookup
   * step can take a moment — navigating away meanwhile (S.epoch) cancels it. */
  let opening = false;
  export async function openResult(item, jf) {
    if (jf) return openItem(jf.Id, jf.Type);
    if (opening) return;
    opening = true;
    const ep = S.epoch;
    try {
      const go = await lookupOpener(item);
      if (S.epoch === ep) go();
    } finally {
      opening = false;
    }
  }

  /* chart key → { total, inLib }, filled when a chart page has loaded; the
   * Search tab's category cards show it */
  export const chartStats = $state({});
  const chartCache = new Map(); // key -> chart (IMDb rankings don't move within a session)
</script>

<script>
  import { onDestroy, tick } from 'svelte';
  import NavBar from '../components/NavBar.svelte';
  import Segmented from '../components/Segmented.svelte';
  import Tile from '../components/Tile.svelte';
  import Skeleton from '../components/Skeleton.svelte';
  import StateMessage from '../components/StateMessage.svelte';
  import LoadError from '../components/LoadError.svelte';
  import { mlChart } from '$lib/medialib.js';
  import { seedAdds } from '$lib/lookup.svelte.js';
  import { scrollPast } from '../lib/gestures.js';
  import { DUR, rm, fadeInRest } from '../lib/safe.js';

  let { params = {}, active = false } = $props();

  const key = untrack(() => params.key || '');
  const isTop = key.startsWith('top-');
  const title = untrack(() => (isTop ? 'IMDb Top 250' : params.title || 'Best rated'));

  let chart = $state.raw(chartCache.get(key) || null);
  const skelSeen = !chartCache.get(key); // the skeleton shows first: the chart dissolves in over it
  let error = $state(null);
  let maps = $state.raw({ tv: null, movie: null });
  let filter = $state('all'); // all | out | in
  let solid = $state(false);
  let el = $state(null); // the .screen scroller
  let segEl = $state(null);
  let dead = false;

  async function load() {
    const c = chartCache.get(key) || (await mlChart(key));
    if (dead) return;
    for (const s of c.sections || []) seedAdds(s.results || []);
    chartCache.set(key, c);
    chart = c;
    error = null;
  }
  function loadIndex() {
    for (const t of ['tv', 'movie']) {
      libIndex(t)
        .then((m) => !dead && maps[t] !== m && (maps = { ...maps, [t]: m }))
        .catch(() => {});
    }
  }
  const retry = () =>
    load().catch((e) => {
      if (!dead) error = e;
      throw e;
    });

  retry().catch(() => {});
  loadIndex();

  /* Showing again — back from an Add (LookupDetail), a while away, or after the
   * player closed (play state moved; libIndex re-reads after a close): refresh
   * the index cheaply. While hidden, a close costs nothing. */
  $effect(() => {
    R.playerClosed;
    if (active) untrack(loadIndex);
  });

  onDestroy(() => {
    dead = true;
    cancelAnimationFrame(raf);
  });

  const jfOf = (item) => maps[item.type]?.byId.get(String(item.id)) || null;
  const inLib = (item) => !!jfOf(item) || inLibrary(item);

  /* Mounting all 250 tiles in the push was an ~90 ms task (measured): the
   * first 24 go in with the page, the rest 48 per frame after the push. */
  let limit = $state(24);
  let raf = 0;
  $effect(() => {
    if (!chart || raf) return;
    const step = () => {
      raf = 0;
      if (dead) return;
      limit += 48;
      if (limit < totalCount) raf = requestAnimationFrame(step);
    };
    untrack(() => limit < totalCount && (raf = requestAnimationFrame(step)));
  });

  const sections = $derived.by(() => {
    let off = 0;
    return (chart?.sections || []).map((s) => {
      const all = filter === 'all' ? s.results : s.results.filter((r) => (filter === 'in') === inLib(r));
      const shown = all.slice(0, Math.max(0, limit - off));
      off += all.length;
      return { ...s, all, shown };
    });
  });
  const totalCount = $derived((chart?.sections || []).reduce((n, s) => n + s.results.length, 0));
  const inCount = $derived((chart?.sections || []).reduce((n, s) => n + s.results.filter(inLib).length, 0));
  const kinds = $derived.by(() => {
    const t = new Set((chart?.sections || []).map((s) => s.type));
    if (!t.size) t.add(key === 'top-tv' ? 'tv' : 'movie');
    return t.size > 1 ? 'Movies & shows' : t.has('tv') ? 'Shows' : 'Movies';
  });
  const indexed = $derived(!!(maps.tv && maps.movie));
  const subHead = $derived(
    kinds + (chart && indexed ? ' · ' + inCount + ' in your library' : chart ? ' · ' + totalCount + ' titles' : '')
  );

  $effect(() => {
    if (chart && indexed) chartStats[key] = { total: totalCount, inLib: inCount };
  });

  /* One of three views of one list → a segmented control, not chips (LIB-04).
   * From deep in the list the page would clamp to wherever the shorter grid
   * ends; instead the control comes to rest under the nav bar, and the new
   * grid fades in rather than swapping in one frame. */
  const FILTERS = [
    { value: 'all', label: 'All' },
    { value: 'out', label: 'Not in library' },
    { value: 'in', label: 'In library' }
  ];
  async function setFilter(v) {
    filter = v;
    await tick();
    if (dead || !el || !segEl) return;
    const bar = el.querySelector(':scope > .spacer-navbar')?.offsetHeight || 0;
    const top = segEl.offsetTop - bar;
    if (el.scrollTop > top) el.scrollTop = top;
    const d = rm(DUR.fast);
    if (d) for (const n of el.querySelectorAll('.chart__grid, .chart__section, :scope > .state')) n.animate([{ opacity: 0 }, { opacity: 1 }], { duration: d, easing: 'linear' });
  }

  const subLine = (it) => [it.year, it.rating ? '★ ' + it.rating.toFixed(1) : ''].filter(Boolean).join(' · ');
  const EAGER = 9;
</script>

<NavBar {title} {solid} />
<main class="screen chart" bind:this={el} use:scrollPast={{ y: 64, onchange: (v) => (solid = v) }}>
  <div class="spacer-navbar"></div>
  <header class="pagehead">
    <p class="pagehead__eyebrow">{isTop ? 'Chart' : 'Best rated'}</p>
    <h1 class="pagehead__title">{title}</h1>
    <p class="pagehead__sub">{subHead}</p>
  </header>

  {#if error && !chart}
    <LoadError title="Couldn’t load this chart" {error} {retry} />
  {:else if !chart}
    <div class="chart__seg" aria-hidden="true"><Skeleton kind="pill" w="100%" h="var(--seg-h)" /></div>
    <div class="grid">
      {#each Array(9) as _, i (i)}<Tile skeleton />{/each}
    </div>
  {:else}
    <div class="chart__seg" bind:this={segEl} use:fadeInRest={skelSeen}>
      <Segmented options={FILTERS} value={filter} label="Filter" onchange={setFilter} />
    </div>
    {#each sections as sec (sec.type)}
      {#if chart.sections.length > 1 && sec.all.length}
        <h2 class="chart__section">{sec.title}</h2>
      {/if}
      {#if sec.shown.length}
        <div class="grid chart__grid">
          {#each sec.shown as item, i (item.type + ':' + item.id)}
            {@const jf = jfOf(item)}
            <Tile {...resultTile(item, jf, subLine(item), true)} rank={item.rank} eager={i < EAGER} onclick={() => openResult(item, jf)} />
          {/each}
        </div>
      {/if}
    {/each}
    {#if !sections.some((s) => s.all.length)}
      <StateMessage
        icon="search"
        title={filter === 'in' ? 'None of these in your library yet' : 'You have every title here'}
        text={filter === 'in' ? 'Add one from the list — it shows up here once it’s in.' : 'Everything on this chart is already in your library.'}
        card
      />
    {/if}
  {/if}
</main>
