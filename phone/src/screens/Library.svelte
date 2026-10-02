<script module>
  /* Query builders shared with the Sort & filter sheet (sheets/SortFilter.svelte),
   * so its "Show N" count asks Jellyfin exactly what the grid will. */
  import { cfg } from '$lib/config.js';
  import { qs, itemsPath } from '$lib/api.js';
  import { SORTS } from '$lib/libview.svelte.js';
  import { act, STATUS_LABEL } from '$lib/activity.svelte.js';

  /* 126 titles per request, as on the TV (18 rows of 7 there, 42 rows of 3
   * here). Dev only: ?libpage=N shrinks the page to exercise paging on a
   * small library. */
  const devPage = import.meta.env.DEV ? +new URLSearchParams(location.search).get('libpage') || 0 : 0;
  export const PAGE = devPage > 0 ? devPage : 126;

  /* tab → how many titles the grid had loaded, so a remount (account switch
   * reloads anyway; a route reset) re-requests as deep as the user was */
  const loadedCount = new Map();

  export function sortEntry(tab, id) {
    const list = SORTS[tab] || SORTS.movies;
    return list.find((s) => s.id === id) || list[0];
  }

  /* SortBy/SortOrder for a sort id, optionally reversed ("Oldest first"). Only
   * the primary keys flip: SortName stays the ascending tie-breaker unless it
   * IS the sort (Title Z–A). */
  export function orderOf(tab, sortId, rev) {
    const s = sortEntry(tab, sortId);
    const by = s.by.split(',');
    let order = s.order.split(',');
    if (rev) {
      order = order.map((o, i) =>
        by[i] === 'SortName' && by.length > 1 ? o : o === 'Ascending' ? 'Descending' : 'Ascending'
      );
    }
    return { by: s.by, order: order.join(',') };
  }

  /* The labels of the two directions, in the sort's own words. */
  export function orderLabels(sortId) {
    switch (sortId) {
      case 'title': return ['A–Z', 'Z–A'];
      case 'rating': return ['Highest first', 'Lowest first'];
      case 'runtime': return ['Shortest first', 'Longest first'];
      case 'played': return ['Most recent', 'Least recent'];
      default: return ['Newest first', 'Oldest first'];
    }
  }

  /* What the sort chip adds when the order is reversed ("Title · Z–A"): the
   * default direction is implied by the label, the reversed one must show. */
  export function revTag(sortId) {
    switch (sortId) {
      case 'title': return 'Z–A';
      case 'rating': return 'lowest first';
      case 'runtime': return 'longest first';
      case 'played': return 'least recent';
      default: return 'oldest first';
    }
  }

  /* What the phone's grid reads of an item, and nothing else: the poster
   * (ImageTags.Primary — Tile, the context-menu preview), Name, the year
   * (ProductionYear, else PremiereDate), the tick / bar / unplayed count
   * (UserData — also gridSig and the watched toggle) and ProviderIds (the
   * download activity merge). Id/Name/Type/ImageTags come back unasked.
   * Not the TV's GRID_FIELDS: its MediaSources (the TV tile's resolution/HDR
   * badge, which the phone tile doesn't have) were ~10 KB of every movie's
   * ~11 KB, and only the Primary image (no backdrop/logo tags and their
   * blurhashes) is asked for. Measured against the live server 2026-10-01:
   * 12 movies 120 KB → 10.9 KB, 7 shows 9.2 KB → 6.2 KB, so a 126-title page
   * of movies ~1.3 MB → ~0.11 MB. */
  const LIST_FIELDS = 'UserData,ProductionYear,PremiereDate,ProviderIds';

  /* v = { sort, rev, genre ('A|B' — Jellyfin ORs a pipe list), unwatched } */
  export function listPath(tab, v, start, limit) {
    const o = orderOf(tab, v.sort, v.rev);
    const q = {
      IncludeItemTypes: tab === 'shows' ? 'Series' : 'Movie',
      Recursive: true,
      SortBy: o.by,
      SortOrder: o.order,
      Fields: LIST_FIELDS,
      EnableImageTypes: 'Primary',
      ImageTypeLimit: 1,
      StartIndex: start,
      Limit: limit
    };
    if (v.genre) q.Genres = v.genre;
    if (v.unwatched) q.Filters = 'IsUnplayed';
    return itemsPath(q);
  }

  /* Count only (the sheet's "Show N"): Limit=0 still returns TotalRecordCount. */
  export function countPath(tab, v) {
    const q = { IncludeItemTypes: tab === 'shows' ? 'Series' : 'Movie', Recursive: true, Limit: 0, EnableImages: false, EnableUserData: false };
    if (v.genre) q.Genres = v.genre;
    if (v.unwatched) q.Filters = 'IsUnplayed';
    return itemsPath(q);
  }

  export function genresPath(tab) {
    return '/Genres' + qs({ UserId: cfg.userId, IncludeItemTypes: tab === 'shows' ? 'Series' : 'Movie', SortBy: 'SortName' });
  }

  export function genreList(v) {
    return v.genre ? v.genre.split('|').filter(Boolean) : [];
  }

  /* "1:11:24" / "11:24" / "1.02:03:04" (Sonarr's day count) → "1 h 11 min left" */
  export function etaText(t) {
    if (!t) return '';
    const [d, rest] = t.includes('.') ? t.split('.') : ['0', t];
    const sec = rest.split(':').reduce((n, x) => n * 60 + (parseInt(x, 10) || 0), 0) + (parseInt(d, 10) || 0) * 86400;
    if (!sec) return '';
    const m = Math.max(1, Math.round(sec / 60));
    const h = Math.floor(m / 60);
    return (h ? h + ' h ' : '') + (m % 60) + ' min left';
  }

  /* An activity group → Tile's `download` prop (dimmed art + ring / Queued).
   * Tile only knows downloading|queued: importing rides the full ring,
   * paused/problem the queued look with the word in the caption. */
  export function downloadOf(g) {
    if (act.stale) return { status: 'queued', sub: 'Status unavailable' };
    const eps = g.type === 'tv' ? g.items.length : 0;
    const seasons = [...new Set(g.items.map((i) => i.season).filter((s) => s != null))];
    const tvLine = eps ? (seasons.length === 1 ? 'S' + seasons[0] + ' · ' : '') + eps + (eps === 1 ? ' episode' : ' episodes') : '';
    if (g.status === 'downloading') {
      return { status: 'downloading', p: g.progress || 0, sub: tvLine || etaText(g.timeleft) || Math.round((g.progress || 0) * 100) + '%' };
    }
    if (g.status === 'importing') return { status: 'downloading', p: 1, sub: 'Importing' };
    if (g.status === 'queued') return { status: 'queued', sub: tvLine || 'Waiting for a slot' };
    return { status: 'queued', sub: STATUS_LABEL[g.status] || g.status };
  }
</script>

<script>
  import { onDestroy, tick, untrack, flushSync } from 'svelte';
  import TopBar from '../components/TopBar.svelte';
  import Tile from '../components/Tile.svelte';
  import Icon from '../components/Icon.svelte';
  import Button from '../components/Button.svelte';
  import Skeleton from '../components/Skeleton.svelte';
  import StateMessage from '../components/StateMessage.svelte';
  import LoadError from '../components/LoadError.svelte';
  import ContextMenu from '../components/ContextMenu.svelte';
  import { api, cached, revalidate, errText } from '$lib/api.js';
  import { viewOf, sortOf, setView, isFiltered, clearFilters } from '$lib/libview.svelte.js';
  import { pendingGroups, providerId } from '$lib/activity.svelte.js';
  import { isCancelling, confirmItems, cancelGroup } from '$lib/cancel.svelte.js';
  import { confirmMenu } from '../lib/confirm.svelte.js';
  import { posterThumb } from '$lib/medialib.js';
  import { setPlayed } from '$lib/played.js';
  import { toast } from '$lib/toast.svelte.js';
  import { openItem, openPending } from '$lib/nav.svelte.js';
  import { R, openSheet, scrollToTop } from '../lib/router.svelte.js';
  import { fadeIn } from '../lib/safe.js';
  import { onLibraryChange, rebase, whenSettled, keepScroll } from '../lib/freshness.svelte.js';

  let { params = {}, active = false } = $props();

  const tab = untrack(() => (params.type === 'shows' ? 'shows' : 'movies'));
  const shows = tab === 'shows';
  const noun = shows ? ['show', 'shows'] : ['movie', 'movies'];
  const view = $derived(viewOf(tab));
  const sort = $derived(sortOf(tab));
  const genres = $derived(genreList(view));

  /* raw: 126–1000 items; a changed tile is replaced, never mutated */
  let items = $state.raw([]);
  let total = $state(0);
  let loading = $state(true);
  let refreshing = $state(false); // a sort/filter change in flight: old grid dimmed
  /* the skeleton was on screen: the first grid dissolves in over it (use:fadeIn);
     a grid painted at once from the cache doesn't */
  let skelSeen = $state(false);
  $effect(() => {
    if (loading) skelSeen = true;
  });
  let error = $state(null);
  let el = $state(null);          // the .screen scroller
  let sentinel = $state(null);
  let fetchedAt = 0;

  let dead = false;
  let gen = 0;

  /* ---- download activity, merged into the grid (activity.svelte.js) ----
   * The feed changes every 4 s poll while something downloads. The loaded
   * items are indexed once per change of `items` (keys), so a poll costs a
   * pass over the groups, not over every title; and a grid that isn't showing
   * (another tab, under a pushed page or the player) doesn't follow the feed
   * at all — it catches up the moment it shows again. */
  let lastGroups = [];
  const groups = $derived.by(() => (active ? (lastGroups = pendingGroups(shows ? 'tv' : 'movie')) : lastGroups));

  const pidKey = shows ? 'tvdb' : 'tmdb';
  const keys = $derived.by(() => {
    const byPid = new Map(); // provider id → items
    const byName = new Map(); // lower-case name → items
    const add = (m, k, it) => {
      const l = m.get(k);
      if (l) l.push(it);
      else m.set(k, [it]);
    };
    for (const it of items) {
      const pid = providerId(it, pidKey);
      if (pid) add(byPid, pid, it);
      add(byName, (it.Name || '').toLowerCase(), it);
    }
    return { byPid, byName };
  });

  /* Titles Jellyfin doesn't have yet lead the grid. A genre filter hides them:
   * nothing un-imported has Jellyfin genres to match. */
  const fresh = $derived.by(() => {
    if (loading || error || !groups.length || view.genre) return [];
    const { byPid, byName } = keys;
    return groups.filter((g) => !(g.mediaId && byPid.has(g.mediaId)) && !byName.has(g.title.toLowerCase()));
  });

  /* item.Id → group, for the corner badge on titles with grabs in flight —
   * matchGroup()'s rule turned around (group → items): a provider id match
   * when both sides have one, the name otherwise; the first group wins. */
  const pendByItem = $derived.by(() => {
    const m = new Map();
    if (!groups.length) return m;
    const { byPid, byName } = keys;
    const put = (g, it) => m.has(it.Id) || m.set(it.Id, g);
    for (const g of groups) {
      if (g.mediaId) for (const it of byPid.get(g.mediaId) || []) put(g, it);
      for (const it of byName.get(g.title.toLowerCase()) || []) if (!g.mediaId || !providerId(it, pidKey)) put(g, it);
    }
    return m;
  });

  function badgeSub(g) {
    const n = g.items.length;
    if (g.type === 'tv') return n + ' ' + (g.status === 'downloading' ? 'downloading' : g.status === 'importing' ? 'importing' : 'on the way');
    return g.status === 'downloading' ? 'Downloading ' + Math.round((g.progress || 0) * 100) + '%' : STATUS_LABEL[g.status] || '';
  }

  /* a movie already in the library with a grab in flight (an upgrade): the
   * live state top-left, so the corner keeps its watched tick */
  function movieBadge(g) {
    if (act.stale) return null;
    const t = g.status === 'downloading' ? Math.round((g.progress || 0) * 100) + '%' : STATUS_LABEL[g.status] || g.status;
    return { text: t, kind: 'gold', icon: 'download' };
  }

  /* "412 movies · 2 downloading" / "37 unwatched movies" */
  const countLine = $derived.by(() => {
    const parts = [total + ' ' + (view.unwatched ? 'unwatched ' : '') + noun[total === 1 ? 0 : 1]];
    const dl = fresh.filter((g) => g.status === 'downloading' || g.status === 'importing').length;
    const q = fresh.length - dl;
    if (dl) parts.push(dl + ' downloading');
    if (q) parts.push(q + ' queued');
    return parts.join(' · ');
  });

  /* "No unwatched sci-fi movies" */
  const emptyTitle = $derived(
    'No ' + (view.unwatched ? 'unwatched ' : '') + (genres.length === 1 ? genres[0].toLowerCase() + ' ' : '') + noun[1]
  );
  const emptyText = $derived(
    !isFiltered(tab)
      ? 'Nothing here yet — find something to add in Search.'
      : view.unwatched && !genres.length
        ? 'You’ve seen everything here. Clear the filter to see it all again.'
        : view.unwatched
          ? 'You’ve seen everything that matches. Clear a filter to see more.'
          : 'Nothing here matches. Try another genre, or show everything.'
  );
  const filtered = $derived(isFiltered(tab));

  /* ---- compact glass bar once the large title has scrolled away: the page
   * name + what the grid shows, and a tap goes back to the top (the iOS
   * status-bar tap, which a web app doesn't get) ---- */
  let solid = $state(false);
  const onScroll = (e) => {
    const s = e.currentTarget.scrollTop > 64;
    if (s !== solid) solid = s;
  };
  const barSub = $derived(
    [view.unwatched ? 'Unwatched' : '', genres.length === 1 ? genres[0] : genres.length ? genres.length + ' genres' : '', sort.label + (view.rev ? ' · ' + revTag(sort.id) : '')]
      .filter(Boolean)
      .join(' · ')
  );
  /* router's scrollToTop: stops a running fling first (else the smooth scroll
     fights the momentum on iOS), instant under Reduce Motion */
  const toTop = () => scrollToTop(el);

  const genreChip = $derived(!genres.length ? 'Genre' : genres.length === 1 ? genres[0] : genres[0] + ' +' + (genres.length - 1));

  const url = (start, limit) => listPath(tab, view, start, limit);

  /* ---- first page (SWR: paint the last answer for this exact query, then
   * swap in the fresh one) ---- */
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
      error = null;
    }
    try {
      const r = await revalidate(u);
      if (g !== gen || dead) return;
      items = r.Items || [];
      total = r.TotalRecordCount ?? items.length;
      loadedCount.set(tab, items.length);
      fetchedAt = Date.now();
      error = null;
    } catch (e) {
      if (g !== gen || dead) return;
      if (!hit) {
        error = e;
        throw e; // LoadError's retry keeps its card up on a failed retry
      }
    } finally {
      if (g === gen && !dead) {
        loading = false;
        refreshing = false;
        rearm();
      }
    }
  }

  const retry = () => load(true);

  /* ---- paging ---- */
  let more = $state(false);
  let moreErr = $state('');
  let moreTries = 0;
  let moreTimer = 0;
  const MORE_BACKOFF = [2000, 4000, 8000];
  let io = null;

  function resetMoreErr() {
    clearTimeout(moreTimer);
    moreTimer = 0;
    moreTries = 0;
    moreErr = '';
  }

  async function loadMore(how = 'io') {
    if (more || loading || refreshing || error || items.length >= total) return;
    if (moreErr && how === 'io') return;
    clearTimeout(moreTimer);
    more = true;
    const g = gen;
    let ok = false;
    try {
      const r = await api(url(items.length, PAGE));
      if (g !== gen || dead) return;
      const seen = new Set(items.map((i) => i.Id));
      items = items.concat((r.Items || []).filter((i) => !seen.has(i.Id)));
      total = r.TotalRecordCount ?? total;
      loadedCount.set(tab, items.length);
      ok = true;
      resetMoreErr();
    } catch (e) {
      if (g !== gen || dead) return;
      moreErr = errText(e);
      if (moreTries < MORE_BACKOFF.length) moreTimer = setTimeout(() => loadMore('auto'), MORE_BACKOFF[moreTries++]);
    } finally {
      if (g === gen) more = false;
      if (ok) rearm();
    }
  }

  /* An IntersectionObserver only reports changes: a page that lands with the
   * sentinel still in range would stall paging one page short. Re-observing
   * makes it report the current state again. */
  async function rearm() {
    await tick();
    if (io && sentinel) {
      io.unobserve(sentinel);
      io.observe(sentinel);
    }
  }

  $effect(() => {
    if (!sentinel || !el) return;
    const o = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && loadMore(), {
      root: el,
      rootMargin: '0px 0px 1200px 0px' // ~5 rows of lead
    });
    io = o;
    o.observe(sentinel);
    return () => {
      o.disconnect();
      if (io === o) io = null;
    };
  });

  /* ---- sort / filter changes (chips here, or the sheet) re-query in place:
   * the old grid stays up dimmed until the new first page lands ---- */
  const vkey = $derived(view.sort + '|' + !!view.rev + '|' + (view.genre || '') + '|' + !!view.unwatched);
  let lastKey = untrack(() => vkey);
  $effect(() => {
    const k = vkey;
    if (k === lastKey) return;
    lastKey = k;
    untrack(requery);
  });

  function requery() {
    loadedCount.delete(tab);
    if (!loading && !error) refreshing = true;
    // glide back to where the new order starts; from deep down, jump (a long
    // glide would drag the new grid's sentinel through view and page early)
    if (el && el.scrollTop > 0) el.scrollTo({ top: 0, behavior: el.scrollTop > 2500 ? 'instant' : 'smooth' });
    load(false).catch(() => {});
  }

  function toggleUnwatched() {
    setView(tab, { unwatched: !view.unwatched });
  }

  /* ---- keeping the grid honest without refetching all the time ----
   * After the player closes (a title may have become watched) or when
   * lib/freshness.svelte.js sees this kind of title added / removed / watched
   * on the server, re-read the loaded range in place — at once if this grid is
   * showing, else the next time it shows (a hidden grid re-read its whole
   * loaded range after every close, trailers included) — applied once no
   * finger is on the screen, the tile under it kept where it was.
   * Back after a while (AWAY): one re-read too, for what freshness's markers
   * can't see — an older title marked unwatched (its DatePlayed doesn't move),
   * Home's own mark-watched (it rebases them), new artwork. That used to be
   * every return after 60 s, which re-read hundreds of titles on most tab
   * switches; the markers cover adds, deletes and anything watched anywhere. */
  const AWAY = 5 * 60 * 1000;
  let stale = false; // a change came in while this grid wasn't showing
  async function quietRefresh() {
    if (loading || refreshing || error || dead) return;
    const g = gen;
    stale = false;
    try {
      const r = await revalidate(url(0, Math.max(PAGE, items.length)));
      if (g !== gen || dead) return;
      await whenSettled();
      if (g !== gen || dead) return;
      fetchedAt = Date.now();
      let next = r.Items || [];
      // a page that loaded while we waited for the finger (loadMore doesn't
      // bump gen) must survive: keep the tail beyond what this read covered
      if (items.length > next.length) next = next.concat(items.slice(next.length));
      if ((r.TotalRecordCount ?? next.length) === total && gridSig(next) === gridSig(items)) return; // nothing a tile shows
      const restore = keepScroll(el, '.lib__grid > *');
      const whole = rendered >= items.length;
      items = next;
      if (whole) rendered = next.length; // no slicing in: the anchor must be laid out before restore
      total = r.TotalRecordCount ?? items.length;
      loadedCount.set(tab, items.length);
      await tick();
      restore();
    } catch {}
  }

  // what a tile shows that can change (JSON of a deep grid is megabytes)
  const gridSig = (list) =>
    list.map((i) => i.Id + (i.UserData ? ':' + !!i.UserData.Played + ':' + (i.UserData.UnplayedItemCount ?? '') + ':' + Math.round(i.UserData.PlayedPercentage || 0) : '') + ':' + (i.ImageTags?.Primary || '')).join('|');

  /* A poster grid shows watched ticks, not positions: someone watching on the
   * TV (`progress`) doesn't reload it. */
  onDestroy(
    onLibraryChange((c) => {
      const mine = shows ? 'tv' : 'movie';
      if (!c[mine] && !(c.played && c.type === mine)) return;
      if (c[mine]) revalidate(genresPath(tab)).catch(() => {}); // the sheet's genre list
      if (active) quietRefresh();
      else stale = true;
    })
  );

  let seenClosed = untrack(() => R.playerClosed);
  $effect(() => {
    const n = R.playerClosed;
    if (n === seenClosed) return;
    seenClosed = n;
    stale = true;
    untrack(() => active && quietRefresh());
  });
  $effect(() => {
    if (active && fetchedAt && (stale || Date.now() - fetchedAt > AWAY)) untrack(quietRefresh);
  });

  /* A pending title that finished importing leaves the feed; its real tile only
   * appears once Jellyfin has scanned it — re-read after a pause, as on TV. */
  const IMPORT_DELAYS = [3000, 8000, 20000];
  let prevFresh = new Set();
  let importTimer = 0;
  let importTries = 0;
  $effect(() => {
    const cur = fresh;
    const live = new Set(groups.map((g) => g.key));
    const skip = act.stale || loading || refreshing;
    untrack(() => {
      const gone = skip ? [] : [...prevFresh].filter((k) => !live.has(k));
      prevFresh = new Set(cur.map((g) => g.key));
      if (!gone.length) return;
      importTries = 0;
      scheduleImport();
    });
  });
  function scheduleImport() {
    clearTimeout(importTimer);
    if (dead || importTries >= IMPORT_DELAYS.length) return;
    importTimer = setTimeout(() => quietRefresh().then(scheduleImport), IMPORT_DELAYS[importTries++]);
  }

  /* ---- long-press: mark watched / unwatched ---- */
  let menu = $state(null); // { rect, item } | { rect, pend: group }
  /* actions capture the item: ContextMenu runs them after onclose cleared `menu` */
  const menuItems = $derived.by(() => {
    if (!menu) return [];
    if (menu.pend) {
      // a title still downloading: Open · Cancel download… → the action sheet confirms (ACT-01)
      const g = menu.pend;
      const open = { label: 'Open', icon: 'info', action: () => openPending(g.key) };
      if (!g.mediaId) return [open];
      const n = g.type === 'tv' ? g.items.length : 0;
      const what = '“' + g.title + '”' + (n ? ' (' + n + (n === 1 ? ' episode' : ' episodes') + ')' : '');
      return [
        open,
        { sep: true },
        { label: 'Cancel download…', icon: 'x', danger: true, action: () => confirmMenu(confirmItems(what, 1, () => cancelGroup(g))) }
      ];
    }
    const it = menu.item;
    const played = !!it.UserData?.Played;
    return [
      { label: 'Open', icon: 'info', action: () => open(it) },
      { sep: true },
      played
        ? { label: 'Mark as unwatched', icon: 'eye-off', action: () => toggleWatched(it) }
        : { label: 'Mark as watched', icon: 'check-circle', action: () => toggleWatched(it) }
    ];
  });

  async function toggleWatched(item) {
    const to = !item.UserData?.Played;
    try {
      const ud = await setPlayed(item.Id, to);
      if (dead) return;
      const next = { ...(item.UserData || {}), ...(ud || {}), Played: to };
      if (to) {
        next.PlayedPercentage = 0;
        if (shows) next.UnplayedItemCount = 0;
      }
      items = items.map((i) => (i.Id === item.Id ? { ...i, UserData: next } : i));
      rebase(); // our own change: not reloaded again on the next check
      toast(to ? 'Marked as watched' : 'Marked as unwatched');
      // a series' unplayed count etc. come back exact on the next quiet read
      if (shows || view.unwatched) setTimeout(quietRefresh, 400);
    } catch (e) {
      toast('Couldn’t update “' + item.Name + '” — ' + errText(e));
    }
  }

  function open(item) {
    openItem(item.Id, item.Type);
  }

  /* Tiles mount in slices, one per frame, sized to the device: each slice is
   * timed (flushSync: Svelte's DOM work happens right there) and the next one
   * aims at SLICE_MS. 126 tiles in one go were a 124 ms task at 4× CPU
   * throttle and 42 per frame 52 ms (measured, desktop Chrome) — a fast
   * iPhone still gets ~42 a frame, a slow one a few rows. Even a few rows a
   * frame stay far ahead of any fling (4 rows ≈ 850 px a frame), and the first
   * slice (FIRST, ~2 screens) paints with the grid. The sentinel sits under the
   * rendered tiles, so paging waits for the slices. */
  const FIRST = 12;
  const SLICE_MS = 8;
  let slice = 6; // tiles per frame, adapted as it goes (kept between pages)
  let rendered = $state(0);
  let raf = 0;
  const shownItems = $derived(rendered >= items.length ? items : items.slice(0, rendered));
  $effect(() => {
    const n = items.length;
    if (rendered > n || loading) rendered = n; // a re-query / refresh: paint at once
    else if (rendered < n && !raf) {
      if (rendered === 0) rendered = Math.min(n, FIRST);
      const step = () => {
        if (dead) return;
        const t0 = performance.now();
        rendered = Math.min(items.length, rendered + slice);
        flushSync(); // this effect re-runs in here: `raf` still set keeps it from starting a second loop
        const dt = performance.now() - t0;
        slice = Math.max(6, Math.min(42, Math.round((slice * SLICE_MS) / Math.max(dt, 1))));
        raf = rendered < items.length ? requestAnimationFrame(step) : 0;
        if (!raf) rearm();
      };
      if (rendered < n) raf = requestAnimationFrame(step);
    }
  });

  /* eager posters: the first rows are on screen the moment the grid mounts */
  const EAGER = 12;

  let started = false;
  $effect(() => {
    if (started) return;
    started = true;
    untrack(() => {
      load(true).catch(() => {});
      revalidate(genresPath(tab)).catch(() => {}); // warms the sheet's genre list
    });
  });

  onDestroy(() => {
    dead = true;
    gen++;
    clearTimeout(moreTimer);
    clearTimeout(importTimer);
    cancelAnimationFrame(raf);
  });
</script>

<main class="screen lib" bind:this={el} onscroll={onScroll}>
  <TopBar title={shows ? 'Shows' : 'Movies'} />
  <div class="chips" role="toolbar" aria-label="Sort and filter">
    <button type="button" class="chip chip--strong" onclick={() => openSheet('sortfilter', { tab })}>
      <Icon name="sort" />{sort.label}{#if view.rev}<span class="lib__rev">· {revTag(sort.id)}</span>{/if}<Icon name="chevron-down" />
    </button>
    <button type="button" class="chip {view.unwatched ? 'chip--on' : ''}" aria-pressed={!!view.unwatched} onclick={toggleUnwatched}>Unwatched</button>
    <button type="button" class="chip {genres.length ? 'chip--on' : ''}" onclick={() => openSheet('sortfilter', { tab, focus: 'genre' })}>
      {genreChip}<Icon name="chevron-down" />
    </button>
  </div>

  {#if loading}
    <div class="count" aria-hidden="true"><Skeleton kind="line" w="110px" h="10px" /></div>
    <div class="grid" aria-busy="true">
      {#each [80, 60, 70, 55, 85, 65, 75, 50, 70, 60, 80, 55] as w, i (i)}
        <div class="tile"><Skeleton kind="poster" /><Skeleton kind="line" w="{w}%" /></div>
      {/each}
    </div>
  {:else if error}
    <LoadError title="Couldn’t load {noun[1]}" {error} {retry} />
  {:else if !items.length && !fresh.length}
    <div class="lib__emptywrap {refreshing ? 'lib__dim' : ''}">
      <StateMessage icon={isFiltered(tab) ? 'filter' : shows ? 'shows' : 'movies'} title={emptyTitle} text={emptyText} fill>
        {#snippet actions()}
          {#if isFiltered(tab)}<Button variant="surface" onclick={() => clearFilters(tab)}>Clear filters</Button>{/if}
        {/snippet}
      </StateMessage>
    </div>
  {:else}
    <div class="lib__countrow" use:fadeIn={skelSeen}>
      <p class="count">{countLine}</p>
      {#if filtered}
        <button type="button" class="btn btn--text lib__clear" onclick={() => clearFilters(tab)}><span>Clear filters</span></button>
      {/if}
    </div>
    <div class="grid lib__grid {refreshing ? 'lib__dim' : ''}" use:fadeIn={skelSeen}>
      {#each fresh as g, i (g.key)}
        <Tile
          title={g.title}
          sub={g.year ? String(g.year) : ''}
          img={posterThumb(g.poster)}
          eager={i < EAGER}
          download={downloadOf(g)}
          class={g.items.every(isCancelling) ? 'is-cancelling' : ''}
          onlongpress={(d) => (menu = { rect: d.rect, pend: g })}
          label="{g.title}, {g.status}"
          onclick={() => openPending(g.key)}
        />
      {/each}
      {#each shownItems as item, i (item.Id)}
        {@const g = pendByItem.get(item.Id)}
        <Tile
          {item}
          eager={i + fresh.length < EAGER}
          count={g && shows ? g.items.length : 0}
          badge={g && !shows ? movieBadge(g) : null}
          sub={g ? badgeSub(g) : undefined}
          onclick={() => open(item)}
          onlongpress={(d) => (menu = { rect: d.rect, item })}
        />
      {/each}
    </div>
    {#if items.length < total && rendered >= items.length}
      {#if moreErr}
        <div class="lib__more">
          <p class="lib__more-text">Couldn’t load more — {moreErr}</p>
          <Button variant="surface" sm busy={more} onclick={() => loadMore('manual')}>Retry</Button>
        </div>
      {:else}
        <!-- the spinner only while a page is in flight: idle, it spun off screen (MOT-12) -->
        <div class="lib__more" bind:this={sentinel} aria-hidden="true">{#if more}<span class="spinner"></span>{/if}</div>
      {/if}
    {/if}
  {/if}
</main>

<header class="navbar lib__bar {solid ? 'navbar--solid lib__bar--on' : ''}" aria-hidden={!solid}>
  <span></span>
  <button type="button" class="lib__bartitle" tabindex={solid ? 0 : -1} aria-label="{shows ? 'Shows' : 'Movies'}, scroll to top" onclick={toTop}>
    <span class="navbar__title">{shows ? 'Shows' : 'Movies'}</span>
    <span class="lib__barsub">{barSub}</span>
  </button>
  <span></span>
</header>

<ContextMenu
  open={!!menu}
  rect={menu?.rect}
  fit="rect"
  label={menu?.pend ? menu.pend.title : menu?.item.Name}
  onclose={() => (menu = null)}
  items={menuItems}
>
  {#snippet preview()}{#if menu?.pend}<Tile title={menu.pend.title} sub={menu.pend.year ? String(menu.pend.year) : ''} img={posterThumb(menu.pend.poster)} download={downloadOf(menu.pend)} fluid eager />{:else if menu}<Tile item={menu.item} fluid eager />{/if}{/snippet}
</ContextMenu>
