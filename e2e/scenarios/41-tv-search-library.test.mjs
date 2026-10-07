/* TV Search, the other outcomes of a lookup (lookup.svelte.js findJellyfin /
 * lookupOpener, Search.svelte's empty cards): a result the library already has
 * opens the real Jellyfin MovieDetail / SeriesDetail, matched by the provider
 * id the lookup is keyed by (tmdb for movies, tvdb for shows); a same-title,
 * same-year item stands in only when Jellyfin has no id of that kind; nothing
 * found and a failing lookup are non-focusable cards that leave the D-pad in
 * the bar. */
import { test, assert } from '../lib/runner.mjs';
import { bootTv, waitFocus, focused, steer } from '../lib/tv.mjs';

const resultKeys = (page) => page.eval(() => [...document.querySelectorAll('#search .grid .tile.focus')].filter((e) => e.checkVisibility()).map((e) => e.dataset.focus));
const matches = (srv, q) => [...srv.world.ml.catalog.values()].filter((e) => e.title.toLowerCase().includes(q));

async function bootSearch(t) {
  const { page } = t;
  await bootTv(t);
  await waitFocus(page, 'tab-home');
  await page.waitFor(() => document.querySelectorAll('.screen.home .rails .rail').length >= 4, { what: 'Home rails', timeout: 10000 });
  await page.key('Up', { settle: 300 });
  await page.waitFor(() => document.getElementById('search')?.classList.contains('on'), { what: 'Search up' });
  await waitFocus(page, 'q2');
}

/* From anywhere in Search: keyboard open, Clear, type `q` on the USB
 * keyboard, wait for `n` results (or the empty/error card when n = 0), Done. */
async function searchFor(page, q, n) {
  if ((await focused(page)) !== 'q2' && !(await focused(page)).startsWith('kb-')) await steer(page, 'q2', { settle: 150 });
  if ((await focused(page)) === 'q2') {
    await page.key('OK', { settle: 200 });
    await page.waitFor(() => document.querySelector('#search .skb'), { what: 'keyboard open' });
  }
  await steer(page, 'kb-clear');
  await page.key('OK', { settle: 100 });
  // the cleared query empties the grid / card after the debounce — only then is a count meaningful
  await page.waitFor(() => !document.querySelector('#search .grid .tile.focus, #search .libempty.compact'), { what: 'results cleared', timeout: 5000 });
  await page.chars(q);
  if (n) await page.waitFor((n) => document.querySelectorAll('#search .grid .tile.focus').length === n, { what: n + ' results for ' + q, timeout: 10000 }, n);
  else await page.waitFor(() => document.querySelector('#search .libempty.compact'), { what: 'empty card for ' + q, timeout: 10000 });
  await steer(page, 'kb-done');
  await page.key('OK', { settle: 250 });
  await page.waitFor(() => !document.querySelector('#search .skb'), { what: 'keyboard folded' });
}

/* Jellyfin's /Items search that findJellyfin() sends */
const jfSearches = (srv) => srv.requests({ origin: 'jf', path: /^\/Items$/ }).map((e) => new URLSearchParams(e.search)).filter((p) => p.has('searchTerm'));

test('tv search: titles already in the library open their Jellyfin detail (tmdb / tvdb id, name+year fallback); an id mismatch opens LookupDetail', { fast: false, timeout: 150000 }, async (t) => {
  const { page, srv } = t;
  const W = srv.world;
  // library titles whose name is a unique substring of the lookup catalog;
  // the ones on Home's Trending rails behind the overlay first — their result
  // key exists there too, and must still resolve inside Search (F-009)
  const trendKeys = new Set(Object.values(W.ml.trending).flat().map((e) => e.type + ':' + e.id));
  const trending = (it) => { const m = matches(srv, it.Name.toLowerCase())[0]; return trendKeys.has(m.type + ':' + m.id); };
  const unique = (type) => W.list(type).filter((it) => matches(srv, it.Name.toLowerCase()).length === 1)
    .sort((a, b) => Number(trending(b)) - Number(trending(a)));
  const [mvId, mvName, mvBad] = unique('Movie');
  const show = unique('Series')[0];
  assert(mvId && mvName && mvBad && show, 'enough uniquely-named library titles in the seed');
  assert(trending(mvId) && trending(show), 'the tmdb movie and the tvdb show are on Home\'s Trending rails (F-009)');
  // a movie Jellyfin has without a tmdb id: matched by name + year
  delete mvName.ProviderIds.Tmdb;
  const mvNameTmdb = matches(srv, mvName.Name.toLowerCase())[0].id;
  // a movie Jellyfin has under a DIFFERENT tmdb id: not the same film
  const badTmdb = mvBad.ProviderIds.Tmdb;
  mvBad.ProviderIds.Tmdb = '123456789';

  await bootSearch(t);

  const openAndCheck = async (it, card, check) => {
    await searchFor(page, it.Name.toLowerCase(), 1);
    await waitFocus(page, card);
    const n0 = jfSearches(srv).length;
    await page.key('OK', { settle: 300 });
    await check();
    const s = jfSearches(srv).slice(n0);
    assert(s.length >= 1, 'findJellyfin searched Jellyfin for ' + it.Name);
    assert.equal(s[0].get('searchTerm'), it.Name, 'searchTerm is the lookup title');
    assert.equal(s[0].get('IncludeItemTypes'), it.Type === 'Series' ? 'Series' : 'Movie');
    assert.deepEqual(s[0].get('Fields').split(',').sort(), ['ProductionYear', 'ProviderIds'], 'asks for ProviderIds + ProductionYear');
    // Back: Search again, on the card it was opened from
    await page.key('Back', { settle: 400 });
    await page.waitFor(() => document.getElementById('search')?.classList.contains('on'), { what: 'Search raised again' });
    await waitFocus(page, card);
  };
  const movieDetail = (name) => async () => {
    await waitFocus(page, 'play', 10000);
    assert(!(await page.eval(() => document.querySelector('[data-focus="lk-add"], [data-focus="lk-stat"]'))), 'not LookupDetail');
    assert.equal(await page.eval(() => document.querySelector('.screen .hero .title')?.textContent.trim()), name, 'MovieDetail of the Jellyfin item');
  };

  await t.step('movie by tmdb id → MovieDetail', () => openAndCheck(mvId, 'lk-movie-' + mvId.ProviderIds.Tmdb, movieDetail(mvId.Name)));
  await t.step('series by tvdb id → SeriesDetail', () => openAndCheck(show, 'lk-tv-' + show.ProviderIds.Tvdb, async () => {
    await page.waitFor(() => document.querySelector('.screen .seasonrow'), { what: 'SeriesDetail season row', timeout: 10000 });
    assert.equal(await page.eval(() => document.querySelector('.screen .hero .title')?.textContent.trim()), show.Name);
    assert(!(await page.eval(() => document.querySelector('[data-focus="lk-add"], [data-focus="lk-stat"]'))), 'not LookupDetail');
  }));
  await t.step('movie without a tmdb id in Jellyfin → matched by name + year', () => openAndCheck(mvName, 'lk-movie-' + mvNameTmdb, movieDetail(mvName.Name)));
  await t.step('movie whose Jellyfin tmdb id differs → LookupDetail, not the Jellyfin item', () => openAndCheck(mvBad, 'lk-movie-' + badTmdb, async () => {
    await waitFocus(page, 'lk-stat', 10000); // added: true → the status button, "In your library"
    assert.match(await page.eval(() => document.querySelector('[data-focus="lk-stat"]').textContent), /In your library/);
  }));
});

test("tv search: 'Nothing found' and a failing lookup are cards the D-pad can't enter", {
  fast: false, timeout: 90000,
  // the lookups this test fails on purpose
  allowErrors: [/status of 50[03] .*\/api\/lookup\?/]
}, async (t) => {
  const { page, srv } = t;
  await bootSearch(t);

  const card = () => page.eval(() => {
    const c = document.querySelector('#search .libempty.compact');
    return c && { t: c.querySelector('.t')?.textContent.trim(), s: c.querySelector('.s')?.textContent.trim(), focusable: !!c.querySelector('.focus, button, [tabindex]') };
  });
  const staysInBar = async () => {
    assert.equal(await focused(page), 'q2', 'with nothing to show, Done puts focus on the bar');
    for (const k of ['Down', 'Down', 'Left', 'Right']) {
      await page.key(k, { settle: 120 });
      assert.equal(await focused(page), 'q2', k + ' keeps focus on the bar');
    }
  };

  await t.step("'zzzz' → Nothing found", async () => {
    await searchFor(page, 'zzzz', 0);
    const c = await card();
    assert.equal(c.t, 'Nothing found');
    assert(!c.focusable, 'the card has nothing focusable');
    assert.deepEqual(await resultKeys(page), [], 'no result tiles');
    await staysInBar();
  });

  await t.step('503 on /api/lookup → Search didn’t work, "temporarily unavailable"', async () => {
    const f = srv.fault({ origin: 'ml', path: '/api/lookup' }, { status: 503, json: { error: 'temporarily_unavailable', detail: 'Sonarr is restarting' } });
    await searchFor(page, 'iron', 0);
    const c = await card();
    assert.equal(c.t, 'Search didn’t work');
    assert.match(c.s, /Library temporarily unavailable/);
    assert(!c.focusable, 'not focusable');
    await staysInBar();
    f.remove();
  });

  await t.step('500 → "Lookup failed"; a working retype recovers', async () => {
    const f = srv.fault({ origin: 'ml', path: '/api/lookup' }, { status: 500, json: { error: 'internal', detail: 'boom' } });
    await searchFor(page, 'iron t', 0);
    const c = await card();
    assert.equal(c.t, 'Search didn’t work');
    assert.match(c.s, /^Lookup failed: /);
    await staysInBar();
    f.remove();
    const want = matches(srv, 'quiet summit').length;
    assert.equal(want, 1, 'Quiet Summit is in the catalog, once');
    await searchFor(page, 'quiet summit', 1); // on Home's Trending rails too (F-009)
    assert.equal(await card(), null, 'the error card is gone');
    await waitFocus(page, 'lk-movie-900003');
  });
});

/* F-009: Search's result cards and Home's Trending rails are both LookupTiles
 * keyed lk-<type>-<id>, and Home stays mounted (faded) behind the overlay,
 * earlier in the DOM — a key has to resolve inside Search, not to Home's tile. */
test("tv search: a result also on Home's Trending rails — Done lands on it, Back from its detail returns to it (F-009)", { fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const key = 'lk-movie-900003';
  assert(srv.world.ml.trending.movie.some((e) => e.id === '900003'), 'Quiet Summit is trending');
  await bootSearch(t);
  await page.waitFor((k) => document.querySelector('.screen.home [data-focus="' + k + '"]'), { what: "Home's Trending tile", timeout: 10000 }, key);

  await t.step('(a) Done on the keyboard → the first result, not the bar', async () => {
    await searchFor(page, 'quiet summit', 1);
    await waitFocus(page, key);
    assert(await page.eval(() => !!document.activeElement.closest('#search')), 'the focused tile is the Search result');
  });

  await t.step('(b) Back from its LookupDetail → Search, on that result (never <body>)', async () => {
    await page.key('OK', { settle: 300 });
    await waitFocus(page, 'lk-add', 10000);
    await page.key('Back', { settle: 400 });
    await page.waitFor(() => document.getElementById('search')?.classList.contains('on'), { what: 'Search raised again' });
    await waitFocus(page, key);
    assert(await page.eval(() => !!document.activeElement.closest('#search')), 'the focused tile is the Search result');
  });
});

/* R-2: Search's Back-from-detail effect checks "does the remembered card still
 * exist?" before focusing it, else the bar. That check used byKey(), which falls
 * back to the whole document — Home's Trending tile with the same key passed it,
 * focusKey() then resolved to that tile, focusEl() refused it (outside #search)
 * and focus stayed on <body>. The card going away is simulated by re-keying the
 * Search result while its LookupDetail is up (nothing in the UI changes the
 * results from there; the check has to hold whatever the reason). */
test("tv search: Back from a result whose card is gone lands on the bar, not on Home's same-keyed Trending tile (R-2)", { fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const key = 'lk-movie-900003';
  assert(srv.world.ml.trending.movie.some((e) => e.id === '900003'), 'Quiet Summit is trending');
  await bootSearch(t);
  await page.waitFor((k) => document.querySelector('.screen.home [data-focus="' + k + '"]'), { what: "Home's Trending tile", timeout: 10000 }, key);
  await searchFor(page, 'quiet summit', 1);
  await waitFocus(page, key);
  await page.key('OK', { settle: 300 });
  await waitFocus(page, 'lk-add', 10000);
  const gone = await page.eval((k) => {
    const el = document.querySelector('#search [data-focus="' + k + '"]');
    if (el) el.dataset.focus = 'r2-gone';
    return !!el;
  }, key);
  assert(gone, 'the Search result card was there to take away');
  await page.key('Back', { settle: 400 });
  await page.waitFor(() => document.getElementById('search')?.classList.contains('on'), { what: 'Search raised again' });
  await page.waitFor(() => document.activeElement && document.activeElement !== document.body, { what: 'focus off <body>', timeout: 3000 }).catch(() => {});
  assert.equal(await focused(page), 'q2', 'focus falls back to the bar (it was <body>)');
});
