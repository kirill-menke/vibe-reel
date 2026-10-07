<script>
  import { onDestroy, untrack } from 'svelte';
  import Loading from './Loading.svelte';
  import Icon from './Icon.svelte';
  import Wordmark from './Wordmark.svelte';
  import LookupTile from './LookupTile.svelte';
  import Browse from './Browse.svelte';
  import Keyboard from './Keyboard.svelte';
  import { S, openFromSearch } from '../lib/nav.svelte.js';
  import { mlLookup } from '../lib/medialib.js';
  import { rankLookup, aliasesFor } from '../lib/searchrank.js';
  import { seedAdds, lookupOpener, trending, refreshTrending } from '../lib/lookup.svelte.js';
  import { focusKey, hasKey } from '../lib/focus.js';

  /* The Sonarr/Radarr lookup. (Music search moved to VibeSpin.) */
  let term = $state('');

  /** @type {Reel.LookupResult[]} */
  let results = $state([]);
  let searched = $state(false);
  let loading = $state(false);
  let error = $state('');

  /* The first two rows of the 7-across result grid are on screen the moment the
   * lookup lands, so their posters load eagerly; everything below stays lazy.
   * Chrome 120 on this TV uses an effectively ZERO lazy-load margin (see the
   * note in Tile.svelte), so a lazy poster starts fetching only once it is
   * already scrolling into view — which is exactly the stall the D-pad felt. */
  const EAGER = 2 * 7;

  /* ---- recent searches ----
   * The last few queries, as chips under the bar that re-run them. A
   * query counts once it was worth something: a result opened from it, or
   * Search closed while it had results — never every debounced keystroke.
   * They persist in localStorage `reel.recentSearches`. */
  const RECENT_KEY = 'reel.recentSearches';
  const RECENT_MAX = 8;
  function readRecent() {
    try {
      const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, RECENT_MAX) : [];
    } catch {
      return [];
    }
  }
  let recent = $state(readRecent());

  /** @param {string} q */
  function remember(q) {
    q = (q || '').trim();
    if (q.length < 2) return;
    /** @type {(list: string[]) => string[]} */
    const add = (list) => [q, ...list.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, RECENT_MAX);
    recent = add(recent);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    } catch {}
  }

  /** @param {string} q */
  function rerun(q) {
    clearTimeout(timer);
    term = q;
    run();
    focusKey('q2');
  }

  $effect(() => {
    if (S.search) return;
    untrack(() => {
      if (results.length) remember(term);
    });
  });

  /* Trending under the recent queries (default mode, nothing typed): the same
   * session list Home's rails show, fetched here only if Home never did. */
  const trendTv = $derived(trending.tv || []);
  const trendMv = $derived(trending.movie || []);
  $effect(() => {
    if (!S.search) return;
    untrack(() => {
      if (!trending.tv) refreshTrending('tv').catch(() => {});
      if (!trending.movie) refreshTrending('movie').catch(() => {});
    });
  });

  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /* Drops a slow response that lands after a newer one — the debounce narrows
   * the window but fast typing can still race two lookups. One bump per lookup,
   * even though a lookup now fires two parallel calls (tv + movie). */
  let seq = 0;
  /* …and the superseded lookups are aborted, not just ignored: a tv lookup
   * takes ~2 s (Sonarr → TVDB), a query is 2–4 of them (tv + movie + aliases),
   * so a few debounced keystrokes used to fill Chromium's 6-per-host
   * connection pool to the media-library service — the lookup that counts, and
   * the activity poll, queued behind answers nobody would read. */
  /** @type {AbortController | null} */
  let lookCtl = null;
  /** @param {AbortController | null} ctl @returns {AbortController} */
  function renew(ctl) {
    ctl?.abort();
    return new AbortController();
  }

  function onInput() {
    clearTimeout(timer);
    timer = setTimeout(run, 350);
  }

  /* ---- our own keyboard (Keyboard.svelte) ----
   * The bar is not a text field: focusing one opens the webOS system keyboard
   * at once, so ▼ from the bar to the categories below was impossible without
   * typing. OK on the bar opens our panel instead; it reopens on the key that
   * was pressed last. */
  let lastKey = 'kb-a';
  function openKb() {
    S.searchKb = true;
    focusKey(lastKey);
  }
  const noteKey = () => {
    const k = /** @type {HTMLElement | null} */ (document.activeElement)?.dataset?.focus;
    if (k && k.startsWith('kb-')) lastKey = k;
  };
  /** @param {string} ch */
  function typeKey(ch) {
    noteKey();
    if (ch === ' ' && (!term || term.endsWith(' '))) return;
    term = (term + ch).slice(0, 80);
    onInput();
  }
  function deleteKey() {
    noteKey();
    if (!term) return;
    term = term.slice(0, -1);
    onInput();
  }
  function clearKey() {
    noteKey();
    term = '';
    onInput();
  }
  /* Done: the keyboard folds away and focus goes to the first result (or the
     bar, with nothing to show). */
  async function doneKey() {
    S.searchKb = false;
    const first = results.length ? 'lk-' + results[0].type + '-' + results[0].id : null;
    if (!(first && (await focusKey(first)))) focusKey('q2');
  }

  /* Typing replaces an open browse category with results; clearing the query
   * again comes back to the category cards (Browse.svelte). */
  $effect(() => {
    if (term.trim()) untrack(/** @returns {null} */ () => (S.searchChart = null));
  });

  async function run() {
    const q = term.trim();
    if (q.length < 2) {
      seq++; // a lookup still in flight for the old query must not land now
      lookCtl?.abort();
      results = [];
      searched = false;
      error = '';
      loading = false;
      return;
    }
    const mine = ++seq;
    lookCtl = renew(lookCtl);
    const sig = lookCtl.signal;
    loading = true;
    error = '';
    // Search shows and movies at once and merge into one list. If only one call
    // fails we still show the other; both failing surfaces the error. A known
    // shorthand ("got", "lotr", "seven" → Se7en) is looked up alongside what
    // was typed; its failure alone is not an error.
    const terms = [q, ...aliasesFor(q)];
    /** @type {(type: Reel.MediaType) => Promise<Reel.LookupResult[]>} */
    const both = (type) =>
      Promise.allSettled(terms.map((t) => mlLookup({ q: t, type }, sig))).then((rs) => {
        if (rs[0].status === 'rejected') throw rs[0].reason;
        const seen = new Set();
        return rs
          .flatMap((r) => (r.status === 'fulfilled' ? r.value.results || [] : []))
          .filter((it) => !seen.has(it.id) && seen.add(it.id));
      });
    const [rtv, rmv] = await Promise.allSettled([both('tv'), both('movie')]);
    if (mine !== seq) return;
    const tv = rtv.status === 'fulfilled' ? rtv.value : [];
    const mv = rmv.status === 'fulfilled' ? rmv.value : [];

    if (rtv.status === 'rejected' && rmv.status === 'rejected') {
      results = [];
      searched = true;
      const e = rtv.reason;
      error = e.retriable
        ? 'Library temporarily unavailable — try again in a moment.'
        : 'Lookup failed: ' + e.message;
      loading = false;
      return;
    }

    /* The two lists are ranked by different services on different terms, so
     * they are re-scored on one scale — see searchrank.js. No cross-list
     * de-dupe needed: a title is only ever a show or a movie. */
    results = rankLookup(terms, tv, mv);
    // Seed add-state from the library flag the lookup already knows.
    seedAdds(results);
    searched = true;
    loading = false;
    /* Focus stays in the input — a debounced keystroke must not yank the D-pad
     * out mid-typing. ▼ walks down into the result cards. */
  }

  /* OK on a result opens the most complete screen that exists for it (see
   * lookupOpener). Back from any of them returns here, on this card. */
  let opening = false;
  /** @param {Reel.LookupResult} item */
  async function openResult(item) {
    if (opening) return;
    opening = true;
    S.searchKb = false;
    remember(term);
    const chart = S.searchChart;
    try {
      const open = await lookupOpener(item);
      // Back while findJellyfin() was in flight closed Search (or the browse
      // category): the user left — don't yank them into the result anyway.
      if (!S.search || S.searchChart !== chart) return;
      openFromSearch('lk-' + item.type + '-' + item.id, open);
    } finally {
      opening = false;
    }
  }

  /* The browse screen fades out underneath while this is up — body.search-on
   * in style.css. */
  $effect(() => {
    document.body.classList.toggle('search-on', S.search);
  });

  /* Focus follows it up: into the bar when raised from the tab bar, back onto
   * the result card when returning from that result's detail screen. Keyed on
   * *visible*, not S.search alone, so it re-seats on the rising edge whenever
   * the overlay comes back into view with S.search still on. */
  const visible = $derived(S.search && S.screen !== 'player');
  $effect(() => {
    if (!visible) return;
    untrack(() => {
      const k = S.searchFocus;
      S.searchFocus = null;
      focusKey(k && hasKey(k) ? k : 'q2');
    });
  });

  onDestroy(() => {
    clearTimeout(timer);
  });
</script>

<!-- Not a screen: an overlay that stays mounted for the session (so the last
     query and its results survive closing it) and is summoned by ▲ past the tab
     bar — see Keys.svelte. Its bar takes the tab bar's exact slot while the
     browse screen underneath fades out (body.search-on in style.css). `inert`
     while closed keeps it out of Tab/pointer focus; focusables() only looks in
     here while S.search is on. -->
<div id="search" class:on={S.search} inert={!S.search}>
  <div class="page">
    <div class="top">
      <!-- A button, not an <input>: a focused text field opens the system
           keyboard (see openKb). -->
      <div class="sbar focus" class:typing={S.searchKb} data-focus="q2" role="button" tabindex="0" onclick={openKb} onkeydown={null}>
        <Icon name="search" />
        <span class="sq" class:ph={!term}>{#if term}{term}{:else if !S.searchKb}Search for a show or a movie to add…{/if}{#if S.searchKb}<i class="caret"></i>{/if}</span>
        {#if !S.searchKb}<span class="skhint">OK to type</span>{/if}
      </div>
      <Wordmark size={30} />
    </div>
    <div class="grid-wrap">
      {#if S.searchKb}
        <Keyboard ontype={typeKey} ondelete={deleteKey} onclear={clearKey} ondone={doneKey} />
      {/if}
      {#if !term.trim()}
        {#if !S.searchChart}
          {@render recents()}
          {#if trendTv.length}{@render trendRail('Trending · Shows', trendTv)}{/if}
          {#if trendMv.length}{@render trendRail('Trending · Movies', trendMv)}{/if}
        {/if}
        <Browse onopen={openResult} />
      {:else if term.trim().length < 2}
        <div class="shint">Type at least 2 characters to search.</div>
      {/if}

      {#if error}
        {@render emptyCard('Search didn’t work', error)}
      {/if}

      {#if loading}
        <Loading inline delay={0} />
      {/if}

      {#if !loading && results.length}
        <div class="grid">
          {#each results as item, i (item.type + ':' + item.id)}
            <LookupTile {item} eager={i < EAGER} onopen={openResult} />
          {/each}
        </div>
      {/if}

      {#if searched && !loading && !error && !results.length}
        {@render emptyCard('Nothing found', 'No show or movie matches that — try another spelling or the original title.')}
      {/if}
    </div>
  </div>
</div>

<!-- No results / a failed lookup: Library's empty-state card, not a bare line.
     Nothing focusable — the D-pad stays in the search bar, where retyping retries. -->
{#snippet emptyCard(/** @type {string} */ t, /** @type {string} */ sub)}
  <div class="libempty compact">
    <div class="icon"><Icon name="search" /></div>
    <div class="t">{t}</div>
    {#if sub}<div class="s">{sub}</div>{/if}
  </div>
{/snippet}

<!-- Recent queries as chips; OK re-runs one and puts focus back in the bar. -->
{#snippet recents()}
  {#if recent.length}
    <div class="recents">
      <div class="rhead">Recent searches</div>
      <div class="rchips">
        {#each recent as q, i (q)}
          <button class="rchip focus" data-focus="rs-{i}" onclick={() => rerun(q)}><Icon name="search" inline />{q}</button>
        {/each}
      </div>
    </div>
  {/if}
{/snippet}

{#snippet trendRail(/** @type {string} */ title, /** @type {Reel.TrendingItem[]} */ items)}
  <div class="rail strend">
    <h2>{title}</h2>
    <div class="strip">
      {#each items as item (item.type + item.id)}
        <LookupTile {item} onopen={openResult} />
      {/each}
    </div>
  </div>
{/snippet}
