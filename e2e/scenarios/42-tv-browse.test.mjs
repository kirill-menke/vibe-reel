/* TV Browse categories (Browse.svelte, medialib.js mlCharts/mlChart): with
 * nothing typed, Search shows reel-api's chart index as category cards; OK on
 * one swaps in an ordinary LookupTile grid with #rank badges; a Top 250 is
 * windowed (≤ 12 rows laid out, rows above [hidden] + padding-top) and mounted
 * a row per idle period; Back returns to the card; typing a query drops the
 * open category; a type:id the server repeats appears once (uniqResults). */
import { test, assert } from '../lib/runner.mjs';
import { bootTv, waitFocus, focused, steer } from '../lib/tv.mjs';

const COLS = 7, WIN = 12;

async function bootSearch(t) {
  const { page } = t;
  await bootTv(t);
  await waitFocus(page, 'tab-home');
  await page.waitFor(() => document.querySelectorAll('.screen.home .rails .rail').length >= 4, { what: 'Home rails', timeout: 10000 });
  await page.key('Up', { settle: 300 });
  await page.waitFor(() => document.getElementById('search')?.classList.contains('on'), { what: 'Search up' });
  await waitFocus(page, 'q2');
  await page.waitFor(() => document.querySelectorAll('#search .catcard').length >= 3, { what: 'category cards', timeout: 10000 });
}

/* the open chart grid as the DOM shows it */
const chartState = (page) => page.eval(() => {
  const tiles = [...document.querySelectorAll('#search .chart .grid > .tile')];
  const a = document.activeElement;
  return {
    head: document.querySelector('#search .chart .cht')?.textContent.trim() || null,
    mounted: tiles.length,
    laidOut: tiles.filter((e) => !e.hidden).length,
    hiddenBefore: tiles.findIndex((e) => !e.hidden),
    keys: tiles.map((e) => e.dataset.focus),
    ranks: tiles.map((e) => e.querySelector('.runbadge.rank')?.textContent.trim() || null),
    focus: a === document.body ? '<body>' : a?.dataset?.focus || null,
    focusIdx: tiles.indexOf(a),
    focusHidden: !!a?.hidden,
    inSearch: !!a?.closest?.('#search'),
    pad: parseFloat(document.querySelector('#search .chart .grid')?.style.paddingTop || '0') || 0,
    cardsHidden: document.querySelector('#search .browse')?.hidden ?? null
  };
});

/* what the fake serves for a chart, in order, first occurrence of each type:id */
const served = (srv, key) => {
  const seen = new Set();
  return srv.world.ml.charts[key].sections.flatMap((s) => s.entries.map((e, i) => ({ k: `lk-${e.type}-${e.id}`, rank: i + 1 }))).filter((x) => !seen.has(x.k) && seen.add(x.k));
};

test('tv browse: chart index → Top 250 Movies grid with rank badges; held ▼ through 250 titles keeps ≤ 12 rows laid out; Back to the card', { fast: false, seed: { bigCharts: true }, timeout: 150000 }, async (t) => {
  const { page, srv } = t;
  await bootSearch(t);

  await t.step('the cards are the categories /api/charts lists', async () => {
    assert(srv.requests({ origin: 'ml', path: '/api/charts' }).some((e) => e.path === '/api/charts'), 'GET /api/charts');
    const want = Object.values(srv.world.ml.charts).map((c) => ({ k: 'cat-' + c.key, title: c.title }));
    const got = await page.eval(() => [...document.querySelectorAll('#search .catcard')].map((e) => ({ k: e.dataset.focus, title: e.querySelector('.cct')?.textContent.trim() })));
    assert.deepEqual(got.map((x) => x.k).sort(), want.map((x) => x.k).sort(), 'one card per category');
    for (const w of want) assert.equal(got.find((x) => x.k === w.k).title, w.title, 'card title of ' + w.k);
    // tops lead, then the genres under their own heading
    assert.deepEqual(got.slice(0, 2).map((x) => x.k), ['cat-top-movie', 'cat-top-tv'], 'Top 250 cards first');
  });

  const list = served(srv, 'top-movie');
  assert.equal(list.length, 250, 'the seed serves 250 titles');

  await t.step('OK on Top 250 Movies opens its grid on the first tile, ranks in chart order', async () => {
    await steer(page, 'cat-top-movie', { settle: 150 });
    await page.key('OK', { settle: 300 });
    await waitFocus(page, list[0].k, 10000);
    assert(srv.requests({ origin: 'ml', path: '/api/charts/top-movie' }).length >= 1, 'GET /api/charts/top-movie');
    const st = await chartState(page);
    assert.equal(st.head, 'Top 250 Movies');
    assert.equal(st.cardsHidden, true, 'the cards stay mounted, hidden');
    assert(st.mounted >= 4 * COLS && st.mounted < 250, `mounted a few rows first, not all 250 (${st.mounted})`);
    assert.deepEqual(st.keys, list.slice(0, st.mounted).map((x) => x.k), 'chart order');
    assert.deepEqual(st.ranks, list.slice(0, st.mounted).map((x) => '#' + x.rank), '#rank badges');
  });

  await t.step('holding ▼ through all 36 rows: ≤ 12 rows laid out, focus never on <body>', async () => {
    const rows = Math.ceil(250 / COLS);
    let maxLaid = 0, minHidden = Infinity;
    for (let i = 1; i < rows + 2; i++) {
      await page.key('Down', { repeat: true, settle: 30 });
      const st = await chartState(page);
      assert(st.focus !== '<body>' && st.inSearch, `press ${i}: focus inside Search (${st.focus})`);
      assert(!st.focusHidden, `press ${i}: the focused tile is laid out`);
      assert(st.laidOut <= WIN * COLS, `press ${i}: ${st.laidOut} tiles laid out (> ${WIN} rows)`);
      maxLaid = Math.max(maxLaid, st.laidOut);
      if (i > 20) minHidden = Math.min(minHidden, st.hiddenBefore);
    }
    // the press only records where the window should be; idle time steps it there
    await page.waitFor((lead) => {
      const tiles = [...document.querySelectorAll('#search .chart .grid > .tile')];
      const row = Math.floor(tiles.indexOf(document.activeElement) / 7);
      const first = tiles.findIndex((e) => !e.hidden);
      return tiles.length === 250 && first === (row - lead) * 7;
    }, { what: 'window settled 5 rows above the focus, all 250 mounted', timeout: 10000 }, 5);
    const st = await chartState(page);
    t.log(`end: focus #${st.focusIdx + 1}, laid out ${st.laidOut}, first laid-out tile ${st.hiddenBefore}, pad ${st.pad}px, max laid out while held ${maxLaid}`);
    assert.equal(Math.floor(st.focusIdx / COLS), rows - 1, 'focus reached the last row');
    assert(st.hiddenBefore > 0 && minHidden > 0, 'rows above the window are [hidden]');
    assert(st.pad > 0, 'padding-top stands in for the hidden rows');
    assert(st.laidOut <= WIN * COLS);
    assert.deepEqual(st.ranks.slice(-3), ['#248', '#249', '#250'], 'the last ranks');
    const top = await page.eval(() => document.activeElement.getBoundingClientRect().top);
    assert(top > 0 && top < 1080, 'the focused tile is on screen: ' + top);
  });

  await t.step('Back in the chart returns to its card', async () => {
    await page.key('Back', { settle: 400 });
    await waitFocus(page, 'cat-top-movie');
    const st = await chartState(page);
    assert.equal(st.head, null, 'chart closed');
    assert.equal(st.cardsHidden, false, 'cards visible again');
    assert(await page.eval(() => document.getElementById('search')?.classList.contains('on')), 'still in Search');
  });
});

test('tv browse: a repeated type:id appears once; a genre chart has Movies + Shows sections; typing drops the open category', { fast: false, timeout: 120000 }, async (t) => {
  const { page, srv } = t;
  // the server repeats a title (two IMDb ids resolving to one Radarr movie)
  const top = srv.world.ml.charts['top-movie'].sections[0].entries;
  top.splice(3, 0, top[0]);
  await bootSearch(t);

  await t.step('Top 250 with a duplicate: first occurrence wins, keys unique', async () => {
    await steer(page, 'cat-top-movie', { settle: 150 });
    await page.key('OK', { settle: 300 });
    const want = served(srv, 'top-movie');
    await waitFocus(page, want[0].k, 10000);
    await page.waitFor((n) => document.querySelectorAll('#search .chart .grid > .tile').length >= Math.min(n, 28), { what: 'tiles mounted' }, want.length);
    const st = await chartState(page);
    assert.equal(new Set(st.keys).size, st.keys.length, 'no duplicate data-focus keys');
    assert.deepEqual(st.keys, want.slice(0, st.mounted).map((x) => x.k), 'served order minus the repeat');
    assert.deepEqual(st.ranks.slice(0, 5), ['#1', '#2', '#3', '#5', '#6'], 'the repeat (#4) is dropped, ranks are the server\'s');
    await page.key('Back', { settle: 400 });
    await waitFocus(page, 'cat-top-movie');
  });

  await t.step('a genre chart: two sections, Back to its card', async () => {
    const g = srv.world.ml.charts['genre-Drama'];
    assert.equal(g.sections.length, 2, 'the seed has Drama movies and shows');
    await steer(page, 'cat-genre-Drama', { settle: 150 });
    await page.key('OK', { settle: 300 });
    await page.waitFor(() => document.querySelector('#search .chart'), { what: 'genre chart', timeout: 10000 });
    const st = await page.eval(() => ({
      head: document.querySelector('#search .chart .cht')?.textContent.trim(),
      kicker: document.querySelector('#search .chart .chk')?.textContent.trim(),
      sections: [...document.querySelectorAll('#search .chart .libhead')].map((e) => e.textContent.trim()),
      perGrid: [...document.querySelectorAll('#search .chart .grid')].map((g) => g.querySelectorAll('.tile').length)
    }));
    assert.equal(st.head, 'Drama');
    assert.equal(st.kicker, 'Top rated');
    assert.deepEqual(st.sections, ['Movies', 'Shows']);
    assert.deepEqual(st.perGrid, g.sections.map((s) => s.entries.length), 'every title of both sections, unwindowed');
    assert(srv.requests({ origin: 'ml', path: '/api/charts/genre-Drama' }).length >= 1);
    await page.key('Back', { settle: 400 });
    await waitFocus(page, 'cat-genre-Drama');
  });

  await t.step('typing a query drops the open category; clearing it shows the cards, not the chart', async () => {
    await steer(page, 'cat-top-movie', { settle: 150 });
    await page.key('OK', { settle: 300 });
    await page.waitFor(() => document.querySelector('#search .chart'), { what: 'chart open (cached)', timeout: 10000 });
    await steer(page, 'q2', { settle: 120 });
    await page.key('OK', { settle: 200 });
    await page.waitFor(() => document.querySelector('#search .skb'), { what: 'keyboard' });
    await page.chars('harbor');
    await page.waitFor(() => !document.querySelector('#search .chart') && document.querySelectorAll('#search .grid .tile.focus').length > 0, { what: 'results replace the chart', timeout: 10000 });
    await steer(page, 'kb-clear');
    await page.key('OK', { settle: 200 });
    await page.waitFor(() => {
      const b = document.querySelector('#search .browse');
      return b && !b.hidden && !document.querySelector('#search .chart');
    }, { what: 'cards back, no chart', timeout: 8000 });
    // Back: keyboard, then Search
    await page.key('Back', { settle: 300 });
    assert.equal(await focused(page), 'q2');
    await page.key('Back', { settle: 400 });
    assert.equal(await focused(page), 'tab-home');
  });
});
