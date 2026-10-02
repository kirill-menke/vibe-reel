<script module>
  /* Session caches: Browse unmounts while a query is typed (Search shows the
   * results in its place) and must come back without a refetch. The category
   * lists are IMDb rankings — they don't move within a session. */
  let catsCache = null;
  const chartCache = new Map();
</script>

<script>
  /* What the Search overlay shows under its bar before anything is typed:
   * category cards — IMDb's Top 250 Movies / Top 250 Shows and the 20
   * best-rated titles of each genre (reel-api /api/charts). OK on a card
   * opens that category in place (S.searchChart) as an ordinary grid of
   * LookupTiles, so a title opens and adds exactly like a search result — and
   * Back from its detail screen lands here again, on the same tile. Back from
   * an open category returns to the cards (Keys.svelte → closeSearchChart). */
  import { onDestroy, tick, untrack } from 'svelte';
  import Loading from './Loading.svelte';
  import LookupTile from './LookupTile.svelte';
  import { S } from '../lib/nav.svelte.js';
  import { mlCharts, mlChart, posterThumb } from '../lib/medialib.js';
  import { seedAdds } from '../lib/lookup.svelte.js';
  import { focusEl, jumpScroll } from '../lib/focus.js';
  import { toast } from '../lib/toast.svelte.js';

  let { onopen } = $props();

  let cats = $state(catsCache);
  let catsError = $state('');
  let loadingCats = false;

  /* The cards are built ahead of the first ▲, a few per idle period while the
   * overlay is still hidden: building all 21 at once was the whole cost of
   * opening Search the first time (~120 ms of script, measured on the TV). Most
   * of it is the posters — assigning the src of an image that is already in the
   * memory cache runs its load synchronously, ~1 ms per poster here, 63 of them.
   * `nCards` counts the cards mounted so far; raising Search mounts the rest at
   * once. */
  let nCards = $state(catsCache ? catsCache.length : 0);
  let prewarm = $state(false);
  const CARDS_PER_IDLE = 3;
  const PREWARM_AFTER = 3000;   // after the splash is gone, once Home has settled
  const shownCats = $derived((cats || []).slice(0, S.search ? Infinity : nCards));
  const tops = $derived(shownCats.filter((c) => c.key.startsWith('top-')));
  const genres = $derived(shownCats.filter((c) => c.key.startsWith('genre-')));

  let idleId = 0;
  let prewarmTimer = 0;
  $effect(() => {
    if (S.splashActive || prewarm || prewarmTimer) return;
    prewarmTimer = setTimeout(() => {
      idleId = requestIdleCallback(() => {
        idleId = 0;
        prewarm = true;
      }, { timeout: 4000 });
    }, PREWARM_AFTER);
  });
  // One chunk per idle period: the mount itself happens in Svelte's flush right
  // after this callback, so a timeRemaining() loop here would release them all.
  /* Pre-built posters are loaded but not decoded — the overlay is hidden — so
   * the first raise made the compositor decode all of them inside one commit
   * (an 85–90 ms task). Decoding them while building moved that off the ▲:
   * A/B on the TV, longest task of the first open 93 → 46 ms. */
  function decodeNew() {
    for (const im of document.querySelectorAll('#search .catcard img:not([data-dec]), #search .strend img:not([data-dec])')) {
      if (!im.closest('.catcard') && !(im.complete && im.naturalWidth)) continue;   // lazy, not loaded
      im.dataset.dec = '1';
      im.decode().catch(() => {});
    }
  }
  function mountStep() {
    idleId = 0;
    if (!cats) return;
    nCards = Math.min(cats.length, nCards + CARDS_PER_IDLE);
    tick().then(decodeNew);
    if (nCards < cats.length) idleId = requestIdleCallback(mountStep);
  }
  $effect(() => {
    if (!cats || S.search) return;
    untrack(() => {
      if (nCards < cats.length && !idleId) idleId = requestIdleCallback(mountStep);
    });
  });
  $effect(() => {
    if (S.search && cats) untrack(() => (nCards = cats.length));
  });
  onDestroy(() => {
    clearTimeout(prewarmTimer);
    if (idleId) cancelIdleCallback(idleId);
  });

  /* Fetched once Search is first up, or ahead of that shortly after boot
   * (`prewarm`), and again on the next raise if that failed. */
  $effect(() => {
    if (!(S.search || prewarm) || cats || loadingCats) return;
    loadingCats = true;
    catsError = '';
    mlCharts()
      .then((r) => (cats = catsCache = r.categories || []))
      .catch((e) => {
        catsError = e.retriable ? 'Charts temporarily unavailable.' : 'Charts failed: ' + e.message;
      })
      .finally(() => (loadingCats = false));
  });

  const chart = $derived(S.searchChart ? chartCache.get(S.searchChart) || null : null);

  /* A Top 250 is windowed. With every tile laid out, each D-pad move cost a
   * ~60 ms task on the TV — the geometric scan, style, pre-paint and paint all
   * walk every tile box (measured 2026-09-28: 250 tiles → 55–70 ms a move,
   * 84 → none over 50 ms). So:
   *   · tiles mount a row at a time in idle time between presses (`shown`),
   *     not on the press: mounting a row on the key path cost ~50 ms a move
   *     on the first pass down, and 42 at once a 150 ms hitch;
   *   · the next rows' posters are fetched and decoded in idle time too
   *     (`ahead`): starting 7 fetches on the press was ~10 ms of it, and a
   *     row decoded ahead is only a cache hit when the glide brings it in;
   *   · at most WIN rows are laid out: rows scrolled well above the focus are
   *     `hidden` (display:none, still mounted — no refetch, no remount) and the
   *     grid's padding-top stands in for them, so nothing on screen moves.
   *     The window follows the focus a row per idle period (`want`), not on
   *     the press: re-anchoring 4–5 rows on the key path was a 53–67 ms task
   *     every 4–5 rows; a one-row step is a ~10 ms longer frame, off the key
   *     path. The press re-anchors only if idle time fell behind (a held ▼).
   * A genre's two 20-title sections never reach either limit. */
  const COLS = 7;
  const WIN = 12; // rows laid out
  const LEAD = 5; // rows kept above the focus row
  let shown = $state(4 * COLS);
  let win = $state(0); // first laid-out row
  let ahead = 4 * COLS; // preload posters up to this index
  let preloaded = 0; // … done up to here
  let pad = $state(0); // px standing in for the hidden rows
  let want = 0; // first row the focus asks for (idle steps win toward it)
  let pitch = 0; // row pitch px (tile height + row gap), measured once per chart

  // From two laid-out rows. Reading offsetTop can force a layout, so only once.
  function rowPitch() {
    if (!pitch) {
      const tiles = document.querySelectorAll('#search .chart .grid > .tile:not([hidden])');
      pitch = tiles.length > COLS ? tiles[COLS].offsetTop - tiles[0].offsetTop : 0;
    }
    return pitch;
  }

  $effect(() => {
    const k = S.focusKey;
    if (!chart || chart.sections.length !== 1 || !k?.startsWith('lk-')) return;
    untrack(() => {
      const list = chart.sections[0].results;
      const i = list.findIndex((it) => 'lk-' + it.type + '-' + it.id === k);
      if (i < 0) return;
      const row = Math.floor(i / COLS);
      ahead = (row + 4) * COLS;
      // Faster than idle time could keep up (a held ▼): mount on the press after all.
      if ((row + 2) * COLS > shown && shown < list.length) shown = Math.min(list.length, (row + 3) * COLS);
      want = Math.max(0, row - LEAD);
      // Idle time moves the window; re-anchor here only when the focus nears
      // either edge of it because idle couldn't keep up.
      if ((row < win + 2 || row > win + WIN - 4) && want !== win && rowPitch() > 0) {
        win = want;
        pad = win * pitch;
      }
      kick();
    });
  });

  /* Idle work for a long chart, a row per idle period: step the window a row
   * toward the focus, else mount the next row, else fetch + decode the posters
   * of the next row below the focus. */
  /* The loop stops once it has caught up (window at the focus, every row
   * mounted, the posters ahead decoded) and while Search is hidden — it used to
   * re-post itself forever, ~22 idle callbacks a second for as long as a chart
   * stayed open behind a detail page or the video (measured). A focus move or
   * raising Search again restarts it (kick). */
  let kick = () => {};
  $effect(() => {
    if (!chart || chart.sections.length !== 1) return;
    const list = chart.sections[0].results;
    preloaded = 0;
    pitch = 0;
    let id = 0;
    const pending = () =>
      (want !== untrack(() => win) && rowPitch() > 0) ||
      untrack(() => shown) < list.length ||
      preloaded < Math.min(ahead, list.length);
    const step = (deadline) => {
      id = 0;
      if (!S.search) return;
      if (deadline.timeRemaining() > 8) {
        const w = untrack(() => win);
        if (want !== w && rowPitch() > 0) {
          win = w + Math.sign(want - w);
          pad = win * pitch;
        } else if (untrack(() => shown) < list.length) shown = Math.min(list.length, untrack(() => shown) + COLS);
        else if (preloaded < Math.min(ahead, list.length)) {
          for (const it of list.slice(preloaded, preloaded + COLS)) {
            const src = posterThumb(it.poster);
            if (!src) continue;
            const im = new Image();
            im.src = src;
            im.decode().catch(() => {});
          }
          preloaded += COLS;
        }
      }
      if (pending()) id = requestIdleCallback(step);
    };
    kick = () => {
      if (!id) id = requestIdleCallback(step);
    };
    kick();
    return () => {
      cancelIdleCallback(id);
      id = 0;
      kick = () => {};
    };
  });
  $effect(() => {
    if (S.search) untrack(() => kick());
  });

  /* The cards stay up (dimmed, the card keeps focus) until the category's list
   * lands; only then does the view switch, onto its first tile. A 250-title
   * chart the server hasn't resolved yet takes a few seconds. */
  let opening = $state(null);
  let gen = 0;

  async function openChart(cat) {
    const mine = ++gen;
    let c = chartCache.get(cat.key);
    if (!c) {
      opening = cat.key;
      try {
        c = await mlChart(cat.key);
      } catch (e) {
        if (mine === gen) toast(e.retriable ? 'Charts busy — try again in a moment' : 'Couldn’t load “' + cat.title + '”');
        return;
      } finally {
        if (mine === gen) opening = null;
      }
      chartCache.set(cat.key, c);
    }
    // Back, a keystroke or closing Search while it loaded: stay where we are.
    if (mine !== gen || !S.search || S.searchChart) return;
    for (const s of c.sections) seedAdds(s.results);
    const page = document.querySelector('#search .page');
    jumpScroll(page, 0);
    shown = 4 * COLS;
    ahead = 4 * COLS;
    preloaded = 0;
    win = 0;
    want = 0;
    pad = 0;
    S.searchChart = cat.key;
    await tick();
    focusEl(document.querySelector('#search .chart .grid > .focus'));
  }

  // Leaving Search (or typing, which unmounts this) abandons an open in flight.
  $effect(() => {
    if (!S.search) gen++;
  });
  onDestroy(() => gen++);

  const EAGER = 2 * 7;
</script>

{#if chart}
  <div class="chart">
    <div class="chhead">
      <div class="chk">{chart.key.startsWith('top-') ? 'IMDb' : 'Top rated'}</div>
      <div class="cht">{chart.title}</div>
    </div>
    {#each chart.sections as sec, si (sec.type)}
      {#if chart.sections.length > 1}
        <div class="libhead" class:after={si > 0}>{sec.title}</div>
      {/if}
      <div class="grid" style:padding-top={pad ? pad + 'px' : null}>
        {#each chart.sections.length === 1 ? sec.results.slice(0, shown) : sec.results as item, i (item.type + ':' + item.id)}
          <LookupTile {item} rank={item.rank} eager={i < EAGER} hidden={i < win * COLS || i >= (win + WIN) * COLS} {onopen} />
        {/each}
      </div>
    {/each}
  </div>
{/if}
<!-- The cards stay mounted (just hidden) while a category is open: rebuilding
     them on Back cost ~90 ms of script plus a full re-raster of every card. -->
{#if cats}
  <div class="browse" class:dim={opening} hidden={!!chart}>
    {#if tops.length}
      <div class="cats lead">
        {#each tops as c (c.key)}{@render card(c, 'IMDb')}{/each}
      </div>
    {/if}
    {#if genres.length}
      <div class="bhead">Top 20 by genre</div>
      <div class="cats">
        {#each genres as c (c.key)}{@render card(c, 'Top 20')}{/each}
      </div>
    {/if}
  </div>
{:else if catsError}
  <div class="shint">{catsError}</div>
{:else}
  <Loading inline delay={300} />
{/if}

<!-- A category card: kicker + title on the left over a solid fade, a stack of
     the category's leading posters on the right. -->
{#snippet card(c, kicker)}
  <button class="catcard focus" class:busy={opening === c.key} data-focus="cat-{c.key}" onclick={() => openChart(c)}>
    <div class="ccart">
      {#each c.posters as p, i (p)}
        <img src={p} alt="" decoding="async" style="--i:{i}" />
      {/each}
    </div>
    <div class="cctxt">
      <div class="cck">{kicker}</div>
      <div class="cct">{c.title}</div>
    </div>
    {#if opening === c.key}<span class="mlbars"><i></i><i></i><i></i></span>{/if}
  </button>
{/snippet}
