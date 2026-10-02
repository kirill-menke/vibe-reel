<script module>
  /* tab → how many titles the grid had loaded (see PAGE below) */
  const loadedCount = new Map();
</script>

<script>
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import TopNav from '../components/TopNav.svelte';
  import LibraryBar from '../components/LibraryBar.svelte';
  import Icon from '../components/Icon.svelte';
  import Loading from '../components/Loading.svelte';
  import LoadError from '../components/LoadError.svelte';
  import Tile from '../components/Tile.svelte';
  import PendingTile from '../components/PendingTile.svelte';
  import { cfg } from '../lib/config.js';
  import { api, qs, cached, revalidate, errText, GRID_FIELDS, itemsPath } from '../lib/api.js';
  import { S, takeGridFocus } from '../lib/nav.svelte.js';
  import { focusKey, focusKeyInstant, scrollElTo, focusLost, recoverFocus } from '../lib/focus.js';
  import { viewOf, sortOf, isFiltered, clearFilters } from '../lib/libview.svelte.js';
  import { act, pendingGroups, matchGroup, providerId } from '../lib/activity.svelte.js';
  import { onReconnect } from '../lib/reconnect.js';

  let items = $state([]);
  let total = $state(0);          // TotalRecordCount of the current query
  let loading = $state(true);
  let refreshing = $state(false); // a sort/filter change is in flight — dim, don't blank
  let error = $state('');
  let genres = $state([]);
  let sentinel = $state(null);

  const tab = S.tab;              // fixed for this mount: a tab switch remounts (S.epoch)
  const view = $derived(viewOf(tab));
  const shows = tab === 'shows';
  const noun = shows ? ['show', 'shows'] : ['movie', 'movies'];

  /* ---- paging ----
   * The grid used to be one request capped at 400, so a bigger library just
   * ended there without a word. Now it is fetched PAGE titles at a time, the
   * next page as the viewport nears the end (a sentinel after the grid, see
   * the IntersectionObserver below). PAGE is a whole number of 7-wide rows so
   * a page boundary never leaves a ragged row while the next one loads.
   *
   * `loadedCount` survives remounts: coming back from a detail page opened
   * deep in the grid asks for that many up front, so the tile focus returns to
   * (takeGridFocus) is actually there. */
  const PAGE = 18 * 7;
  let gen = 0;          // bumped per query; a late page of an old query is dropped
  let more = $state(false); // a next-page request is in flight (the retry row shows it)
  let io = null;        // the sentinel's IntersectionObserver
  /* ---- download activity, merged into the grid ----
   * Titles still downloading/importing that Jellyfin doesn't know yet lead the
   * grid as synthetic tiles; a library item that activity DOES know (a show
   * growing new episodes) keeps its real tile and gets a badge. Matching is by
   * provider id (ProviderIds is added to the query below), title as fallback. */
  const groups = $derived(pendingGroups(shows ? 'tv' : 'movie'));

  /* A genre filter hides them: a title that isn't imported yet has no Jellyfin
   * genres to match. (Unwatched keeps them — nothing on the way is watched.) */
  const fresh = $derived.by(() => {
    if (loading || !groups.length || view.genre) return [];
    const pids = new Set();
    const names = new Set();
    for (const it of items) {
      const pid = providerId(it, shows ? 'tvdb' : 'tmdb');
      if (pid) pids.add(pid);
      names.add((it.Name || '').toLowerCase());
    }
    return groups.filter((g) => !(g.mediaId && pids.has(g.mediaId)) && !names.has(g.title.toLowerCase()));
  });

  /* item.Id → group, computed once per poll tick instead of per tile */
  const pendByItem = $derived.by(() => {
    const m = new Map();
    if (!groups.length) return m;
    for (const it of items) {
      const g = matchGroup(groups, it);
      if (g) m.set(it.Id, g);
    }
    return m;
  });

  /* ---- a pending title finished importing ----
   * Its group leaves the activity feed, so its PendingTile disappears at once —
   * but the real Jellyfin item isn't in `items` until the grid is re-fetched,
   * so the title used to vanish until the next remount. Watch for groups that
   * were showing as pending tiles and have left the feed, and re-fetch the
   * loaded range in place (same count, scroll untouched) after a pause for
   * Jellyfin's library scan — again at 8 s and 20 s while the title still
   * isn't there. If the vanished tile had focus, focus goes to the nearest
   * tile at once (so the D-pad isn't dead), then onto the real tile when it
   * lands — unless the user has moved on meanwhile. A stale feed (polls
   * failing) keeps its last list, so it never looks like an import. */
  const IMPORT_DELAYS = [3000, 8000, 20000];
  let prevFresh = new Map();   // key -> group snapshot, as last rendered
  let awaiting = [];           // vanished groups whose real tile hasn't shown up yet
  let lostFocus = null;        // { key, parked }: the vanished tile had focus
  let importTimer = 0;
  let importTries = 0;

  $effect(() => {
    const cur = fresh;
    const live = new Set(groups.map((g) => g.key));
    const skip = act.stale || loading || refreshing;
    untrack(() => {
      const gone = skip ? [] : [...prevFresh.values()].filter((g) => !live.has(g.key));
      prevFresh = new Map(cur.map((g) => [g.key, { key: g.key, type: g.type, title: g.title, mediaId: g.mediaId }]));
      if (!gone.length) return;
      awaiting.push(...gone);
      const had = gone.find((g) => S.focusKey === 'pend-' + g.key);
      if (had) {
        lostFocus = { key: had.key, parked: null };
        recoverFocus().then(() => lostFocus && (lostFocus.parked = document.activeElement));
      }
      importTries = 0;
      scheduleImportCheck();
    });
  });

  function scheduleImportCheck() {
    clearTimeout(importTimer);
    // a check in flight at unmount must not re-arm (and later focusKey('tile-…') into Home's rails)
    if (dead || importTries >= IMPORT_DELAYS.length) {
      awaiting = [];
      lostFocus = null;
      return;
    }
    importTimer = setTimeout(importCheck, IMPORT_DELAYS[importTries++]);
  }

  async function importCheck() {
    if (loading || refreshing || error) return scheduleImportCheck();
    const g0 = gen;
    try {
      const r = await revalidate(url(0, Math.max(PAGE, items.length)));
      if (g0 !== gen || dead) return; // a requery replaced the grid anyway
      items = r.Items || [];
      total = r.TotalRecordCount ?? items.length;
      loadedCount.set(tab, items.length);
    } catch {
      return scheduleImportCheck();
    }
    const found = new Map();
    awaiting = awaiting.filter((g) => {
      const it = items.find((i) => matchGroup([g], i));
      if (it) found.set(g.key, it);
      return !it;
    });
    const lf = lostFocus;
    if (lf && found.has(lf.key)) {
      lostFocus = null;
      await tick();
      if (focusLost() || document.activeElement === lf.parked) await focusKey('tile-' + found.get(lf.key).Id);
    }
    if (awaiting.length) scheduleImportCheck();
    else lostFocus = null;
  }

  let dead = false;
  onDestroy(() => {
    dead = true;
    gen++;   // drops a loadMore()/load() answer still in flight (and its retry timer)
    clearTimeout(importTimer);
    clearTimeout(moreTimer);
  });

  /* The first two rows are on screen the instant the grid mounts, so they load
   * eagerly; everything below stays lazy (and content-visibility'd, see
   * `.grid .tile:not(:focus)` in style.css) and loads as it scrolls in.
   * Pending tiles lead the grid, so they consume the budget first and the
   * library tiles behind them are offset by however many there are. */
  const EAGER_ROWS = 2 * 7;

  /* "7 movies", "3 movies · Drama · Unwatched", "… · 2 on the way" */
  const summary = $derived.by(() => {
    const parts = [total + ' ' + noun[total === 1 ? 0 : 1]];
    if (view.genre) parts.push(view.genre);
    if (view.unwatched) parts.push('Unwatched');
    if (fresh.length) parts.push(fresh.length + ' on the way');
    return parts.join(' · ');
  });
  const emptyText = $derived(
    'No ' + (view.unwatched ? 'unwatched ' : '') + (view.genre ? view.genre + ' ' : '') + noun[1]
  );

  function url(start, limit) {
    const s = sortOf(tab);
    const q = {
      IncludeItemTypes: shows ? 'Series' : 'Movie',
      Recursive: true,
      SortBy: s.by,
      SortOrder: s.order,
      // + ProviderIds (not in GRID_FIELDS — the Home rails don't need it):
      // tvdb/tmdb ids are what ties a grid item to its download activity.
      Fields: GRID_FIELDS + ',ProviderIds',
      StartIndex: start,
      Limit: limit
    };
    if (view.genre) q.Genres = view.genre;
    if (view.unwatched) q.Filters = 'IsUnplayed';
    return itemsPath(q);
  }

  /* Opening the tab leaves focus on the tab itself — entering the grid is the
   * user's own ▼ press, not something the screen does for them. This is not a
   * no-op: App.svelte remounts the screen on every tab switch (S.epoch), which
   * destroys the very button the click focused, so the tab has to be re-focused
   * explicitly or focus falls back to <body> and the D-pad has nothing to move
   * from. Called from both paths below, so the instant cached paint and the
   * first-ever load behave the same.
   *
   * The one exception is coming *back* from a detail page: that remount is a
   * return, not a fresh visit, so focus goes to the tile it was opened from
   * (nav.svelte.js remembers the key per tab and hands it over once). If that
   * tile is gone — the title finished importing, so a pending tile turned into
   * a real one — the tab is still the right fallback.
   *
   * focusKey() awaits tick() — mandatory, the focus engine measures the live
   * DOM and the grid has only just been (re)mounted. */
  async function focusNav() {
    const back = takeGridFocus();
    if (back && (await focusKeyInstant(back))) return;
    await focusKey('tab-' + tab);
  }

  /* First page of the current sort/filter. Stale-while-revalidate: App.svelte
   * remounts this screen on every tab switch (deliberately — see S.epoch), and
   * Jellyfin makes the query uncacheable, so without the cache every switch to
   * Movies/Shows costs a round trip behind the loading indicator. A grid tile
   * renders only the poster, title, year and tech badge — nothing the user can
   * change from here — so last session's answer is safe to paint immediately
   * while the refetch runs behind it.
   *
   * The Unwatched filter is the exception to "nothing the user can change": a
   * cached page may still hold something watched since. The revalidation
   * repairs it a moment later, which is the same trade the Home rails make. */
  async function load(first) {
    const g = ++gen;
    resetMoreErr();
    const n = Math.max(PAGE, first ? loadedCount.get(tab) || 0 : 0);
    const u = url(0, n);
    const hit = cached(u);
    if (hit) {
      items = hit.Items || [];
      total = hit.TotalRecordCount ?? items.length;
      loading = false;
      refreshing = false;
      error = '';   // a Retry after a failed /Views: the cached grid is good, drop the card now
      if (first) await focusNav();
    }
    try {
      const r = await revalidate(u);
      if (g !== gen) return;
      // The revalidation can drop the focused tile from a cached paint (e.g.
      // Unwatched on, back from watching that very title) — keep the D-pad alive.
      const ae = hit ? document.activeElement : null;
      items = r.Items || [];
      total = r.TotalRecordCount ?? items.length;
      loadedCount.set(tab, items.length);
      error = '';
      if (ae?.closest?.('.grid')) {
        await tick();
        if (!ae.isConnected) await recoverFocus();
      }
      if (!hit) {
        loading = false;
        refreshing = false;
        if (first) await focusNav();
      }
    } catch (e) {
      // a failed revalidation leaves the (still perfectly good) stale grid up
      if (g === gen && !hit) {
        error = errText(e);
        loading = false;
        refreshing = false;
        // the remount destroyed whatever had focus; give the D-pad somewhere to start
        if (first) await focusNav();
      }
    }
  }

  /* ---- a next page that failed ----
   * Re-arming the observer after a failure made it fire again at once (the
   * sentinel never left the lead margin) — a tight retry loop against a server
   * that is down. So a failure stops auto-paging: the sentinel is replaced by
   * a focusable "Couldn't load more" row (OK retries), with a few automatic
   * retries backing off 2/4/8 s. Success, or a new query, resets it. */
  let moreErr = $state('');
  let moreTries = 0;
  let moreTimer = 0;
  const MORE_BACKOFF = [2000, 4000, 8000];

  function resetMoreErr() {
    clearTimeout(moreTimer);
    moreTimer = 0;
    moreTries = 0;
    moreErr = '';
  }

  /* how: 'io' (the sentinel came into range), 'auto' (backoff timer), 'manual' (OK) */
  async function loadMore(how = 'io') {
    if (more || loading || refreshing || items.length >= total) return;
    if (moreErr && how === 'io') return;
    clearTimeout(moreTimer);
    moreTimer = 0;
    more = true;
    const g = gen;
    let ok = false;
    try {
      const r = await api(url(items.length, PAGE));
      if (g !== gen) return;
      const seen = new Set(items.map((i) => i.Id));
      const add = (r.Items || []).filter((i) => !seen.has(i.Id));
      items = items.concat(add);
      total = r.TotalRecordCount ?? total;
      loadedCount.set(tab, items.length);
      ok = true;
      const wasErr = !!moreErr;
      resetMoreErr();
      // the retry row just went away under the focus: land on the first new tile
      if (wasErr && add.length) {
        await tick();
        if (focusLost()) await focusKey('tile-' + add[0].Id);
      }
    } catch (e) {
      if (g !== gen) return;
      moreErr = errText(e);
      if (moreTries < MORE_BACKOFF.length) moreTimer = setTimeout(() => loadMore('auto'), MORE_BACKOFF[moreTries++]);
    } finally {
      more = false;
      if (ok) rearm();
    }
  }

  /* An IntersectionObserver only reports *changes*. When a page lands and the
   * sentinel is still inside the lead margin (a short page, a tall screen), it
   * never stopped intersecting, so no new callback would come and paging would
   * stall one page short — measured: 3 → 6 of 7 with a 3-title page. Observing
   * afresh makes the observer report the current state once more. */
  async function rearm() {
    await tick();
    if (io && sentinel) {
      io.unobserve(sentinel);
      io.observe(sentinel);
    }
  }

  /* A sort or filter change from the bar: re-query in place. The old grid
   * stays up, dimmed, until the new first page lands — blanking it would
   * flash the loading indicator for what is usually a ~100 ms swap — and the
   * page glides back to the top, where the new order starts. Focus stays on
   * the bar (LibraryBar hands it back to the pill). */
  function requery() {
    loadedCount.delete(tab);
    refreshing = true;
    const page = document.querySelector('.screen .page');
    if (page) scrollElTo(page, 0);
    load(false);
  }

  async function clearAll() {
    clearFilters(tab);
    requery();
    await focusKey('lv-genre');
  }

  $effect(() => {
    if (!sentinel) return;
    io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && loadMore(), {
      root: sentinel.closest('.page'),
      rootMargin: '0px 0px 1400px 0px'   // about three rows of lead
    });
    io.observe(sentinel);
    return () => {
      io.disconnect();
      io = null;
    };
  });

  // The genre list is small and changes only with the library; SWR it too.
  function loadGenres() {
    const gq = { UserId: cfg.userId, IncludeItemTypes: shows ? 'Series' : 'Movie', SortBy: 'SortName' };
    const gu = '/Genres' + qs(gq);
    const gh = cached(gu);
    genres = gh ? (gh.Items || []).map((x) => x.Name) : [];
    revalidate(gu)
      .then((r) => (genres = (r.Items || []).map((x) => x.Name)))
      .catch(() => {});
  }

  /* ---- Retry after a failed first page ---- */
  let retrying = $state(false);
  async function retryLoad() {
    if (retrying) return;
    retrying = true;
    try {
      await start();
    } finally {
      retrying = false;
    }
    if (error) await focusKey('lib-retry');
  }

  onMount(() => start());

  /* A failed first page retries itself when the network returns, the app is
   * resumed, or every 30 s (reconnect.js). On the timer only while the D-pad
   * isn't elsewhere — a failed retry re-focuses lib-retry. */
  onDestroy(
    onReconnect(
      (why) => {
        if (!error || loading || retrying) return;
        const f = document.activeElement?.dataset?.focus;
        if (why !== 'tick' || !f || f === 'lib-retry') return retryLoad();
      },
      { every: 30000 }
    )
  );

  async function start() {
    const p = load(true);
    loadGenres();
    await p;
  }
</script>

<div class="screen">
  <div class="page">
    <TopNav active={tab}>
      <LibraryBar {tab} {genres} onchange={requery} />
    </TopNav>
    <div class="grid-wrap">
      {#if loading}
        <Loading />
      {:else if error}
        <LoadError title="Couldn’t load {noun[1]}" reason={error} retry={retryLoad} busy={retrying} retryKey="lib-retry"
          fkey="lib" under back={false} auto={false} />
      {:else if !items.length && !fresh.length}
        <!-- Nothing matches — with a filter on the way out is right here; an
             unfiltered empty grid is a library with nothing in it yet. -->
        <div class="libempty" class:dim={refreshing}>
          <div class="icon"><Icon name={shows ? 'tv' : 'film'} /></div>
          <div class="t">{emptyText}</div>
          {#if isFiltered(tab)}
            <div class="s">Nothing here matches. Try another genre, or show everything.</div>
          {:else}
            <div class="s">Nothing here yet — ▲ on the tab to search for something to add.</div>
          {/if}
          {#if isFiltered(tab)}
            <button class="btn ghost big focus" data-focus="lv-clear" onclick={clearAll}>Clear filters</button>
          {/if}
        </div>
      {:else}
        <div class="libhead">{summary}</div>
        <div class="grid" class:dim={refreshing}>
          {#each fresh as g, i (g.key)}
            <PendingTile group={g} eager={i < EAGER_ROWS} />
          {/each}
          {#each items as item, i (item.Id)}
            <Tile {item} kind="added" eager={i + fresh.length < EAGER_ROWS} pend={pendByItem.get(item.Id) || null} />
          {/each}
        </div>
        {#if items.length < total}
          {#if moreErr}
            <!-- a failed next page: paging stops here until OK (or a backoff retry) -->
            <div class="gridfail">
              <button class="btn ghost big focus" class:busy={more} data-focus="grid-more-retry" onclick={() => loadMore('manual')}
                >{more ? 'Loading…' : 'Couldn’t load more — OK to retry'}</button
              >
            </div>
          {:else}
            <div class="gridmore" bind:this={sentinel}><Loading inline /></div>
          {/if}
        {/if}
      {/if}
    </div>
  </div>
</div>
