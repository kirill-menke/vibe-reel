<script module>
  /* The browse categories are IMDb rankings — fetched once per session. */
  /** @type {Reel.ChartCategory[] | null} */
  let catsCache = null;
</script>

<script>
  /* Search tab (design 07-search--*.html). With nothing typed: the browse
   * categories (IMDb Top 250 Movies / Shows, then best rated per genre), each
   * pushing a Chart page. Typing runs the TV's Sonarr/Radarr lookup (both
   * kinds + known aliases, ranked by searchrank.js), matched against the
   * Jellyfin library so titles you have show their real poster, progress and
   * watched tick and open their detail page directly. */
  import { onDestroy, tick, untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import TopBar from '../components/TopBar.svelte';
  import Tile from '../components/Tile.svelte';
  import Icon from '../components/Icon.svelte';
  import Art from '../components/Art.svelte';
  import Button from '../components/Button.svelte';
  import StateMessage from '../components/StateMessage.svelte';
  import { errText } from '$lib/api.js';
  import { mlLookup, mlCharts } from '$lib/medialib.js';
  import { rankLookup, aliasesFor } from '$lib/searchrank.js';
  import { seedAdds } from '$lib/lookup.svelte.js';
  import { R, push } from '../lib/router.svelte.js';
  import { DUR, SPRING, EASE, reducedMotion } from '../lib/safe.js';
  import { libIndex, fold, ARTICLE, resultTile, kindWord, openResult, chartStats } from './Chart.svelte';

  let { params = {}, active = false } = $props();

  let term = $state('');
  let focused = $state(false); // the field has focus (its ring)
  let engaged = $state(false); // search mode: title away, field pinned, Cancel — outlives a blur by scrolling
  let inputEl = $state(/** @type {HTMLInputElement | null} */ (null));
  let formEl = $state(/** @type {HTMLFormElement | null} */ (null));
  let fieldEl = $state(/** @type {HTMLLabelElement | null} */ (null));
  let el = $state(/** @type {HTMLElement | null} */ (null));

  /** @type {Reel.LookupResult[]} */
  let results = $state.raw([]);
  let searched = $state(''); // the query `results` answer
  let loading = $state(false);
  let error = $state('');
  /** @type {{ tv: VR.LibIndex | null, movie: VR.LibIndex | null }} */
  let maps = $state.raw({ tv: null, movie: null });
  let dead = false;

  const q = $derived(term.trim());
  const searching = $derived(engaged || !!term);

  /* ---- the lookup (exactly the TV's: debounce, seq, an AbortController per
   * lookup so superseded ones free their connection) ---- */
  let timer = 0;
  let seq = 0;
  /** @type {AbortController | null} */
  let ctl = null;

  function onInput() {
    clearTimeout(timer);
    if (q.length < 2) {
      stop();
      return;
    }
    timer = setTimeout(run, 350);
  }

  function stop() {
    seq++;
    ctl?.abort();
    ctl = null;
    results = [];
    searched = '';
    error = '';
    loading = false;
  }

  function loadIndex() {
    for (const t of /** @type {Reel.MediaType[]} */ (['tv', 'movie'])) {
      libIndex(t)
        .then((m) => !dead && maps[t] !== m && (maps = { ...maps, [t]: m }))
        .catch(() => {});
    }
  }

  async function run() {
    clearTimeout(timer);
    const query = q;
    if (query.length < 2) return stop();
    const mine = ++seq;
    ctl?.abort();
    ctl = new AbortController();
    const sig = ctl.signal;
    loading = true;
    error = '';
    loadIndex();
    const terms = [query, ...aliasesFor(query)];
    const both = (/** @type {Reel.MediaType} */ type) =>
      Promise.allSettled(terms.map((t) => mlLookup({ q: t, type }, sig))).then((rs) => {
        if (rs[0].status === 'rejected') throw rs[0].reason;
        const seen = new Set();
        return rs
          .flatMap((r) => (r.status === 'fulfilled' ? r.value.results || [] : []))
          .filter((it) => !seen.has(it.id) && seen.add(it.id));
      });
    const [rtv, rmv] = await Promise.allSettled([both('tv'), both('movie')]);
    if (mine !== seq || dead) return;
    if (rtv.status === 'rejected' && rmv.status === 'rejected') {
      const e = rtv.reason;
      results = [];
      searched = query;
      error = e?.retriable ? 'Your library is busy — try again in a moment.' : errText(e);
      loading = false;
      return;
    }
    const tv = rtv.status === 'fulfilled' ? rtv.value : [];
    const mv = rmv.status === 'fulfilled' ? rmv.value : [];
    const r = rankLookup(terms, tv, mv);
    seedAdds(r);
    results = r;
    searched = query;
    loading = false;
    if (el) el.scrollTop = 0;
  }

  /** @param {SubmitEvent} e */
  function submit(e) {
    e.preventDefault();
    run();
    inputEl?.blur(); // dismiss the keyboard; the results stay
  }

  function clear() {
    term = '';
    stop();
    inputEl?.focus();
  }

  function cancel() {
    morph(() => {
      term = '';
      stop();
      engaged = false;
      inputEl?.blur();
    }, backY);
  }

  function onFocus() {
    focused = true;
    focusY = el?.scrollTop || 0;
    if (!searching) backY = focusY;
    morph(() => (engaged = true));
    loadIndex(); // cached 2 min: the instant library matches need it
  }

  function onBlur() {
    focused = false;
    // a blur by scrolling only puts the keyboard away; with a query the page
    // stays as it is anyway; otherwise (Done, a tap elsewhere) search mode ends
    if (!scrollBlur && !term) morph(() => (engaged = false));
  }

  /* scrolling the results puts the keyboard away, as iOS search does — search
   * mode stays (UISearchController keeps Cancel up), so nothing jumps under
   * the finger */
  let focusY = 0; // scrollTop at focus: the scroll-blur reference
  let backY = 0; // scrollTop before search mode: Cancel returns there
  let scrollBlur = false;
  let atTop = true;
  function onScroll() {
    if (!el) return;
    atTop = el.scrollTop < 8;
    if (focused && Math.abs(el.scrollTop - focusY) > 24) {
      scrollBlur = true;
      inputEl?.blur();
      scrollBlur = false;
    }
  }

  /* ---- search mode on/off moves instead of cutting (SRCH-01) ----
   * UISearchController: the large title slides away, the field rises and
   * narrows while Cancel slides in from the right (and back on Cancel). A FLIP
   * of the real elements — measured before and after the state change, played
   * from the old place with WAAPI; the leaving title / Cancel are fading clones
   * (their real elements are gone after the flush). Transform/opacity only. A
   * same-document View Transition was the proposal, but it snapshots the whole
   * page (tab bar included), would cut the content under the field and scale
   * the field's text with its width; this runs on iOS 17 too. */
  let morphing = false;
  /** @type {Animation[]} */
  let running = [];
  /** @param {() => void} fn @param {number | null} [restoreY] */
  function morph(fn, restoreY) {
    if (morphing || !el || !formEl || !fieldEl || !active || reducedMotion()) {
      fn();
      return;
    }
    const was = searching;
    for (const a of running) a.cancel();
    running = [];
    for (const g of el.querySelectorAll(':scope > .srch__ghost')) g.remove();
    const f0 = fieldEl.getBoundingClientRect();
    const next0 = formEl.nextElementSibling;
    const n0 = next0?.getBoundingClientRect().top;
    const leaving = was ? formEl.querySelector('.search__cancel') : el.querySelector(':scope > .topbar');
    const lr = leaving?.getBoundingClientRect();
    const ghost = /** @type {HTMLElement | undefined} */ (leaving?.cloneNode(true));
    const hadTerm = !!term;
    morphing = true;
    fn();
    tick().then(() => {
      morphing = false;
      if (dead || !el || !formEl || !fieldEl || searching === was) return;
      if (restoreY != null) el.scrollTop = restoreY;
      const f1 = fieldEl.getBoundingClientRect();
      const dy = f0.top - f1.top;
      const move = { duration: DUR.springQuick, easing: SPRING.smooth };
      const go = (/** @type {Element | null | undefined} */ node, /** @type {Keyframe[]} */ kf, /** @type {KeyframeAnimationOptions} */ opt = move) => node && running.push(node.animate(kf, opt));
      go(formEl, [{ transform: `translateY(${dy}px)` }, { transform: 'none' }]);
      // the fill takes the old width and settles into the new one (text unscaled)
      const bg = fieldEl.querySelector('.search__bg');
      if (f1.width > 0) go(bg, [{ transform: `scaleX(${f0.width / f1.width})` }, { transform: 'none' }]);
      // what follows the form rides along; if it was replaced (Cancel after a
      // query brings the categories back), it also fades in
      const next1 = formEl.nextElementSibling;
      if (next1) {
        const same = next1 === next0 && n0 != null;
        const cy = same ? n0 - next1.getBoundingClientRect().top : dy;
        let sib = /** @type {Element | null} */ (next1);
        const kf = same || !hadTerm
          ? [{ transform: `translateY(${cy}px)` }, { transform: 'none' }]
          : [{ transform: `translateY(${cy}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }];
        while (sib) {
          if (!sib.classList.contains('srch__ghost')) go(sib, kf);
          sib = sib.nextElementSibling;
        }
      }
      const fadeIn = { duration: DUR.fast, easing: EASE.out, delay: DUR.press };
      const edge = f0.width - f1.width; // Cancel rides the field's right edge
      if (was) {
        // off: the title comes back from just above
        go(el.querySelector(':scope > .topbar'), [{ transform: 'translateY(-12px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { ...fadeIn, fill: 'backwards' });
      } else {
        // on: Cancel comes in from the right, pushed by the narrowing field
        const cn = formEl.querySelector('.search__cancel');
        go(cn, [{ transform: `translateX(${edge}px)` }, { transform: 'none' }]);
        go(cn, [{ opacity: 0 }, { opacity: 1 }], { duration: DUR.fast, easing: EASE.out });
      }
      if (ghost && lr) {
        // the leaving element, where it was on screen, fading as it goes
        const now = el.getBoundingClientRect();
        Object.assign(ghost.style, {
          position: 'absolute', margin: '0', pointerEvents: 'none', zIndex: 'calc(var(--z-header) + 1)',
          top: lr.top - now.top + el.scrollTop + 'px', left: lr.left - now.left + 'px',
          width: lr.width + 'px', height: lr.height + 'px', boxSizing: 'border-box'
        });
        ghost.classList.add('srch__ghost');
        ghost.setAttribute('aria-hidden', 'true');
        ghost.inert = true;
        el.append(ghost);
        // Cancel leaves with the widening field's edge; the title lifts away.
        // The fades have one keyframe: they start from whatever it showed
        // (Cancel may be mid press flash).
        if (was) running.push(ghost.animate([{ transform: 'none' }, { transform: `translateX(${-edge}px)` }], { ...move, fill: 'forwards' }));
        const out = was ? [{ opacity: 0 }] : [{ transform: 'translateY(-12px)', opacity: 0 }];
        const a = ghost.animate(out, { duration: DUR.fast, easing: EASE.out, fill: 'forwards' });
        const drop = () => ghost.remove();
        a.finished.then(drop, drop);
        running.push(a);
      }
    });
  }

  const jfOf = (/** @type {Reel.LookupResult} */ item) => maps[item.type]?.byId.get(String(item.id)) || null;

  /* ---- instant library matches ----
   * The library index (every title's name + ids, loaded on focus) answers "do I
   * have it?" on every keystroke, before the 350 ms debounce and the lookup:
   * those tiles appear at once, and they catch what the Sonarr/Radarr lookup
   * doesn't (a half-typed word — "godf", "breaking ba"). Forgiving like the
   * ranking: accents, apostrophes, punctuation and a leading article don't
   * count, and every query word only has to start a title word. The titles
   * are folded once per index (libIndex's names()), only the query per key. */
  /** @param {VR.LibName} t @param {string} qf @param {string[]} words @param {string} qflat */
  function localScore(t, qf, words, qflat) {
    if (t.n === qf || t.bare === qf) return 4;
    if (t.n.startsWith(qf) || t.bare.startsWith(qf)) return 3;
    if (words.every((w) => t.words.some((x) => x.startsWith(w)))) return 2;
    // "spiderman" / "spider man" / "Spider-Man"
    return qf.length >= 4 && t.flat.includes(qflat) ? 1 : 0;
  }
  const localHits = $derived.by(() => {
    if (q.length < 2) return [];
    const qf = fold(q).replace(ARTICLE, '');
    const words = qf.split(' ').filter(Boolean);
    if (!words.length) return [];
    const qflat = qf.replaceAll(' ', '');
    const out = [];
    for (const t of /** @type {Reel.MediaType[]} */ (['movie', 'tv'])) {
      for (const n of maps[t]?.names() || []) {
        const sc = localScore(n, qf, words, qflat);
        if (sc) out.push({ jf: n.jf, sc });
      }
    }
    out.sort((a, b) => b.sc - a.sc || (a.jf.Name || '').localeCompare(b.jf.Name || ''));
    return out.slice(0, 30).map((h) => h.jf);
  });

  /* One grid: library titles first (instant matches, then library titles
   * only the lookup found, e.g. by original title), then the titles to add.
   * `current`: the lookup answered the query on screen; until then the
   * library part is already live and the rest shows the previous answer
   * dimmed, or placeholders. */
  const current = $derived(searched === q && !loading);
  const libSection = $derived.by(() => {
    const byId = new Map();
    if (current) for (const r of results) { const jf = jfOf(r); if (jf) byId.set(jf.Id, r); }
    const seen = new Set();
    const out = [];
    for (const jf of localHits) {
      seen.add(jf.Id);
      out.push({ key: 'jf:' + jf.Id, jf, item: byId.get(jf.Id) || null });
    }
    if (current) for (const [id, r] of byId) if (!seen.has(id)) out.push({ key: 'jf:' + id, jf: /** @type {Jf.BaseItemDto} */ (jfOf(r)), item: r }); // byId only holds results with a jf
    return out;
  });
  const addSection = $derived(results.filter((r) => !jfOf(r)));
  /* the previous answer's titles to add dim only while a lookup for another
   * query is actually in flight — not through the debounce — and .lib__dim
   * waits --dim-delay before it shows, so typing never pulses the grid */
  const stale = $derived(loading && searched !== q);
  const total = $derived(libSection.length + addSection.length);
  const countLine = $derived(
    !current ? 'Searching…' : total + (total === 1 ? ' result' : ' results')
  );

  /** @param {{ key: string, jf: Jf.BaseItemDto, item: Reel.LookupResult | null }} e @returns {VR.ResultTile} */
  function libTile(e) {
    const kind = e.jf.Type === 'Series' ? 'Show' : 'Movie';
    const sub = [e.jf.ProductionYear, kind].filter(Boolean).join(' · ');
    return e.item ? resultTile(e.item, e.jf, sub) : { item: e.jf, sub };
  }

  /* ---- browse categories ---- */
  let cats = $state.raw(catsCache);
  let catsError = $state(null);
  let catsBusy = $state(false);
  function loadCats() {
    if (catsBusy) return Promise.resolve();
    catsBusy = true;
    catsError = null;
    return mlCharts()
      .then((r) => {
        if (!dead) cats = catsCache = r.categories || [];
      })
      .catch((e) => {
        if (!dead) catsError = e;
      })
      .finally(() => (catsBusy = false));
  }
  if (!catsCache) loadCats();

  const tops = $derived((cats || []).filter((c) => c.key.startsWith('top-')));
  const genreCats = $derived((cats || []).filter((c) => !c.key.startsWith('top-')));

  /* "Movies · 10 in library" / "Top 40 · 2 in library" — the group label
   * already says "Best rated", so a genre card says how big it is instead */
  /** @param {Reel.ChartCategory} c */
  function catSub(c) {
    const st = chartStats[c.key];
    const head = c.key.startsWith('top-') ? (c.key === 'top-tv' ? 'Shows' : 'Movies') : c.count ? 'Top ' + c.count : 'Best rated';
    return st ? head + ' · ' + st.inLib + ' in library' : head;
  }

  /** @param {Reel.ChartCategory} c */
  function openCat(c) {
    push('chart', { key: c.key, title: c.title });
  }

  /* Results on screen and showing (again): refresh their index — after the
   * player closed, play state may have moved (libIndex re-reads after a close
   * by itself). While hidden, a close costs nothing until the tab is back. */
  $effect(() => {
    R.playerClosed;
    if (active) untrack(() => results.length && loadIndex());
  });

  /* Search tab tapped again at its root: the first tap scrolls up (App), the
   * next one — already at the top — puts the cursor in the field, as iOS
   * search tabs do. Runs inside the tap's task, so iOS raises the keyboard. */
  let seenToTop = untrack(() => R.toTop);
  $effect(() => {
    const n = R.toTop;
    if (n === seenToTop) return;
    seenToTop = n;
    if (untrack(() => active && atTop)) inputEl?.focus();
  });

  onDestroy(() => {
    dead = true;
    clearTimeout(timer);
    ctl?.abort();
  });
</script>

<main class="screen srch {searching ? 'srch--on' : ''}" bind:this={el} onscroll={onScroll}>
  {#if !searching}<TopBar title="Search" />{/if}

  <form class="search" role="search" onsubmit={submit} bind:this={formEl}>
    <label class="search__field {focused ? 'search__field--focus' : ''}" bind:this={fieldEl}>
      <span class="search__bg" aria-hidden="true"></span>
      <Icon name="search" size="sm" />
      <input
        class="search__input"
        type="search"
        placeholder="Movies and shows"
        enterkeyhint="search"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        aria-label="Search"
        bind:this={inputEl}
        bind:value={term}
        oninput={onInput}
        onfocus={onFocus}
        onblur={onBlur}
      />
      {#if term}
        <button class="search__clear" type="button" in:fade={{ duration: DUR.press }} aria-label="Clear" onpointerdown={(e) => e.preventDefault()} onclick={clear}>
          <Icon name="x" size="sm" />
        </button>
      {/if}
    </label>
    {#if searching}
      <button class="search__cancel" type="button" onpointerdown={(e) => e.preventDefault()} onclick={cancel}>Cancel</button>
    {/if}
  </form>

  {#if term}
    {#if q.length < 2}
      {#if q.length === 1}<p class="search__count">Type one more letter…</p>{/if}
    {:else if current && error && !libSection.length}
      <StateMessage icon="alert" error title="Search didn’t work" text={error} fill>
        {#snippet actions()}<Button variant="surface" onclick={run}>Try again</Button>{/snippet}
      </StateMessage>
    {:else if current && !total}
      <StateMessage
        icon="search"
        title="No results for “{searched}”"
        text="Check the spelling, or try the original title — search covers your library and titles you can add."
        fill
      />
    {:else}
      <p class="search__count" aria-live="polite">{countLine}</p>
      <!-- One grid, no "In your library" / "Not in your library" headings
           (round 3: the "+" on an addable title is the only library mark).
           Library titles lead: the index answers them on every keystroke, so
           they stay put while the lookup catches up — a purely ranked merge
           would reshuffle them each time an answer lands. -->
      <div class="grid srch__grid" aria-busy={!current}>
        {#each libSection as e, i (e.key)}
          <Tile {...libTile(e)} eager={i < 9} onclick={() => openResult(e.item, e.jf)} />
        {/each}
        {#if !(current && error)}
          {#each addSection as item, i (item.type + ':' + item.id)}
            <Tile
              {...resultTile(item, null, [item.year, kindWord(item)].filter(Boolean).join(' · '))}
              eager={libSection.length + i < 9}
              class={stale ? 'lib__dim' : ''}
              onclick={() => openResult(item, null)}
            />
          {/each}
          {#if !current && !addSection.length}
            {#each Array(libSection.length ? 3 : 6) as _, i (i)}<Tile skeleton />{/each}
          {/if}
        {/if}
      </div>
      {#if current && error}
        <div class="lib__more">
          <p class="lib__more-text">Titles to add didn’t load — {error}</p>
          <Button variant="surface" sm onclick={run}>Try again</Button>
        </div>
      {/if}
    {/if}
  {:else}
    {#if cats}
      {#if tops.length}
        <div class="group">
          <p class="group__label">Charts</p>
          <div class="catgrid">
            {#each tops as c (c.key)}{@render card(c, 'IMDb Top ' + (c.count || 250))}{/each}
          </div>
        </div>
      {/if}
      {#if genreCats.length}
        <div class="group">
          <p class="group__label">Best rated by genre</p>
          <div class="catgrid">
            {#each genreCats as c (c.key)}{@render card(c, c.title)}{/each}
          </div>
        </div>
      {/if}
    {:else if catsError}
      <StateMessage icon="cloud-off" error title="Couldn’t load the charts" text={errText(catsError)} card>
        {#snippet actions()}<Button variant="surface" busy={catsBusy} onclick={loadCats}>Retry</Button>{/snippet}
      </StateMessage>
    {:else}
      <div class="group" aria-busy="true">
        <p class="group__label">Charts</p>
        <div class="catgrid">
          {#each Array(4) as _, i (i)}<div class="skel catcard srch__skelcard"></div>{/each}
        </div>
      </div>
    {/if}
  {/if}
</main>

{#snippet card(/** @type {Reel.ChartCategory} */ c, /** @type {string} */ title)}
  <button type="button" class="catcard" onclick={() => openCat(c)}>
    <div class="catcard__fan" aria-hidden="true">
      {#each (c.posters || []).slice(0, 3) as p, i (i)}
        <div class="catcard__poster"><Art src={p} /></div>
      {/each}
    </div>
    <p class="catcard__title">{title}</p>
    <p class="catcard__sub">{catSub(c)}</p>
  </button>
{/snippet}
