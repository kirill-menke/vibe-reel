/* Invariant crawls of the overlays and the detail screens that hang off them:
 * the Search overlay (bar, Browse category cards, its Trending rails, its own
 * keyboard, typed results, a chart grid), the tab row's bell + avatar menus
 * (modal .lvmenu), LookupDetail and PendingDetail. Scopes are what focus.js
 * scopes to: while Search is up nothing outside #search is reachable; an open
 * menu is modal; Back peels one layer at a time. */
import { test, assert } from '../lib/runner.mjs';
import { bootTv, waitFocus, focused } from '../lib/tv.mjs';
import { crawl, crawlSummary, walkTo } from '../lib/crawler.mjs';

const report = (t, r) => {
  t.log(crawlSummary(r));
  if (r.leaves.length) t.log('leaves: ' + r.leaves.map((l) => `${l.from} ${l.key} → ${l.to}`).join(' ; '));
};
const clean = (r, what) => {
  assert.deepEqual(r.problems, [], what + ' crawl problems');
  assert.deepEqual(r.leaves, [], what + ': arrows never leave the scope');
};
const searchUp = (page) => page.eval(() => document.getElementById('search')?.classList.contains('on'));
const domKeys = (page, css) => page.eval((css) => [...document.querySelectorAll(css)].filter((e) => e.checkVisibility()).map((e) => e.dataset.focus), css);

async function bootHome(t) {
  await bootTv(t);
  await waitFocus(t.page, 'tab-home');
  await t.page.waitFor(() => document.querySelectorAll('.screen.home .rails .rail').length >= 4, { what: 'Home rails', timeout: 10000 });
}

/* ▲ on the tab row raises Search with focus on its bar */
async function raiseSearch(page) {
  await page.key('Up', { settle: 400 });
  await page.waitFor(() => document.getElementById('search')?.classList.contains('on'), { what: 'Search up' });
  await waitFocus(page, 'q2');
}

test('crawl: Search — bar, categories, trending; keyboard keys all reachable; Back closes keyboard, then Search onto its tab; a chart grid', { fast: false, timeout: 200000 }, async (t) => {
  const { page } = t;
  await bootHome(t);
  await raiseSearch(page);
  await page.waitFor(() => document.querySelectorAll('#search .catcard').length >= 3, { what: 'Browse category cards', timeout: 10000 });

  // 1. the empty Search: bar, category cards, trending rails — all inside #search
  const r = await crawl(page, { name: 'search (empty)', settle: 150, maxStates: 40, timeLimit: 50000, prefer: (id) => !id.startsWith('lk-'), log: t.log });
  report(t, r);
  clean(r, 'Search');
  const cards = await domKeys(page, '#search .catcard.focus');
  for (const k of ['q2', ...cards]) assert(r.keys.includes(k), 'visited ' + k + ': ' + r.keys.join(' '));
  assert(r.states.every((s) => !/^(tab-|nav-|hero-|tile-)/.test(s)), 'nothing behind the overlay was reached: ' + r.states.join(' '));

  // 2. its keyboard: OK on the bar opens it; every key is a D-pad target
  assert(await walkTo(page, r, 'q2', { log: t.log }), 'walked back to the bar');
  await page.key('OK', { settle: 300 });
  await page.waitFor(() => document.querySelector('#search [data-focus="kb-a"]'), { what: 'keyboard open' });
  const kbAll = await domKeys(page, '#search .skb .focus');
  assert.equal(kbAll.length, 43, '43 keyboard keys (26 letters, 10 digits, 3 symbols, Space, Delete, Clear, Done)');
  const kb = await crawl(page, { name: 'search keyboard', settle: 100, maxStates: 45, timeLimit: 70000, prefer: (id) => id.startsWith('kb-'), log: t.log });
  report(t, kb);
  clean(kb, 'Keyboard');
  assert.deepEqual(kbAll.filter((k) => !kb.keys.includes(k)), [], 'every keyboard key reached by the D-pad');

  // 3. Back closes the keyboard first (focus on the bar, Search still up) …
  await page.key('Back', { settle: 300 });
  assert(!(await page.eval(() => document.querySelector('#search .skb'))), 'keyboard closed');
  assert(await searchUp(page), 'Search still up after the first Back');
  assert.equal(await focused(page), 'q2', 'focus back on the bar');
  // … then Search itself, onto the tab it was raised from
  await page.key('Back', { settle: 400 });
  assert(!(await searchUp(page)), 'Search closed by the second Back');
  assert.equal(await focused(page), 'tab-home', 'focus returned to the tab Search was raised from');

  // 4. a Browse category: OK on its card → the chart grid; Back → the card
  await raiseSearch(page);
  assert(await walkTo(page, r, 'cat-top-movie', { log: t.log }), 'walked to the Top 250 Movies card');
  await page.key('OK', { settle: 400 });
  // (the cards stay mounted, hidden, while a category is open)
  await page.waitFor(() => [...document.querySelectorAll('#search .tile.focus')].filter((e) => e.checkVisibility()).length >= 10 && document.querySelector('#search .browse')?.hidden, { what: 'chart grid', timeout: 10000 });
  await page.waitFor(() => document.activeElement?.closest?.('#search'), { what: 'focus inside Search' });
  const ch = await crawl(page, { name: 'chart grid', settle: 150, maxStates: 25, timeLimit: 40000, log: t.log });
  report(t, ch);
  clean(ch, 'Chart grid');
  assert(ch.keys.filter((k) => k.startsWith('lk-movie-')).length >= 10, 'chart tiles reached');
  await page.key('Back', { settle: 400 });
  await waitFocus(page, 'cat-top-movie');
  assert(await searchUp(page), 'Back from a chart stays in Search, on its card');
  await page.key('Back', { settle: 400 });
  assert(!(await searchUp(page)), 'second Back closes Search');
  assert.equal(await focused(page), 'tab-home', 'focus on the tab again');
});

test('crawl: Search results → LookupDetail (movie, then a show with seasons); Back raises Search on the card', { fast: false, timeout: 200000 }, async (t) => {
  const { page, srv } = t;
  await bootHome(t);
  await raiseSearch(page);
  await page.key('OK', { settle: 300 });
  await waitFocus(page, 'kb-a');
  await page.chars('harbor');
  await page.waitFor(() => document.querySelectorAll('#search .grid .tile.focus').length >= 2, { what: 'results for "harbor"', timeout: 10000 });
  assert(srv.requests({ origin: 'ml', path: '/api/lookup' }).some((e) => /[?&]q=harbor(&|$)/.test(e.search)), 'lookup asked for "harbor"');

  // Done folds the keyboard and focuses the first result; the D-pad stays in #search
  // (▼ to the bottom row, ▶ along it to Done)
  const bottom = ['kb-space', 'kb-del', 'kb-clear', 'kb-done'];
  for (let i = 0; i < 4 && !bottom.includes(await focused(page)); i++) await page.key('Down', { settle: 120 });
  for (let i = 0; i < 4 && (await focused(page)) !== 'kb-done'; i++) await page.key('Right', { settle: 120 });
  assert.equal(await focused(page), 'kb-done', 'walked to Done');
  await page.key('OK', { settle: 300 });
  await page.waitFor(() => !document.querySelector('#search .skb'), { what: 'keyboard folded' });
  const first = await page.eval(() => document.querySelector('#search .grid .tile.focus')?.dataset.focus);
  assert.equal(await focused(page), first, 'Done focuses the first result');
  const res = await crawl(page, { name: 'search results', settle: 150, maxStates: 20, timeLimit: 30000, log: t.log });
  report(t, res);
  clean(res, 'Results');
  assert(res.keys.includes('q2') && res.keys.filter((k) => k.startsWith('lk-')).length >= 2, 'bar + results reachable: ' + res.keys.join(' '));

  // a title the library doesn't have → LookupDetail; crawl it; Back → Search on that card
  const target = 'lk-movie-900008'; // Harbor Lights (not added)
  assert(res.keys.includes(target), 'Harbor Lights among the results: ' + res.keys.join(' '));
  assert(await walkTo(page, res, target, { log: t.log }), 'walked to ' + target);
  await page.key('OK', { settle: 400 });
  await waitFocus(page, 'lk-add', 10000);
  assert(!(await searchUp(page)), 'Search hidden under LookupDetail');
  const ld = await crawl(page, { name: 'lookup detail (movie)', settle: 200, maxStates: 25, timeLimit: 40000, log: t.log });
  report(t, ld);
  clean(ld, 'LookupDetail');
  assert(ld.keys.includes('lk-add'), 'Add to library reachable');
  await page.key('Back', { settle: 500 });
  await page.waitFor(() => document.getElementById('search')?.classList.contains('on'), { what: 'Search raised again' });
  await waitFocus(page, target);

  // a show from Search's Trending rail: season pills + episode rows from reel-api metadata
  await page.key('Back', { settle: 400 }); // close Search (query stays) …
  assert(!(await searchUp(page)), 'Search closed');
  const show = 'lk-tv-400002'; // Golden Frontier: two seasons, not added
  const home = await crawl(page, { name: 'home (to find a trending show)', settle: 250, maxStates: 30, timeLimit: 40000, prefer: (id) => id.startsWith('lk-tv') || id.startsWith('tab-') });
  assert(await walkTo(page, home, show, { log: t.log }), 'walked to ' + show + ' on Home');
  await page.key('OK', { settle: 400 });
  await waitFocus(page, 'lk-add', 10000);
  await page.waitFor(() => document.querySelector('[data-focus^="lkseason-"]') && document.querySelector('[data-focus^="lkep-"]'), { what: 'season pills + episode rows', timeout: 10000 });
  const lt = await crawl(page, { name: 'lookup detail (show)', settle: 200, maxStates: 30, timeLimit: 45000, log: t.log });
  report(t, lt);
  clean(lt, 'LookupDetail (show)');
  assert(lt.keys.some((k) => k.startsWith('lkseason-')) && lt.keys.some((k) => k.startsWith('lkep-')), 'pills + episode rows reached: ' + lt.keys.join(' '));
  await page.key('Back', { settle: 500 });
  await page.waitFor(() => document.querySelector('.screen.home'), { what: 'Home after Back' });
  await waitFocus(page, show);
});

test('crawl: bell and avatar menus are modal; Back closes each onto its button', { fast: false, timeout: 120000 }, async (t) => {
  const { page } = t;
  await bootHome(t);
  for (const [btn, prefix] of [['nav-news', /^(nw-|ld-)/], ['nav-account', /^ac-/]]) {
    for (let i = 0; i < 6 && (await focused(page)) !== btn; i++) await page.key('Right', { settle: 150 });
    assert.equal(await focused(page), btn, 'reached ' + btn + ' along the tab row');
    await page.key('OK', { settle: 300 });
    await page.waitFor(() => document.querySelector('.screen .lvmenu'), { what: btn + ' menu open' });
    await page.waitFor(() => document.activeElement?.closest?.('.lvmenu'), { what: 'focus inside the menu' });
    const m = await crawl(page, { name: btn + ' menu', settle: 150, maxStates: 20, timeLimit: 30000, log: t.log });
    report(t, m);
    clean(m, btn + ' menu');
    const rows = await domKeys(page, '.screen .lvmenu .focus');
    assert(rows.length >= 2 && rows.every((k) => prefix.test(k)), `menu rows ${rows.join(' ')}`);
    assert.deepEqual(rows.filter((k) => !m.keys.includes(k)), [], 'every row reached');
    assert(m.keys.every((k) => prefix.test(k)), 'nothing outside the menu reached: ' + m.keys.join(' '));
    await page.key('Back', { settle: 300 });
    assert(!(await page.eval(() => document.querySelector('.screen .lvmenu'))), 'Back closed the menu');
    assert.equal(await focused(page), btn, 'Back closed the menu onto ' + btn);
  }
});

test('crawl: PendingDetail — a downloading movie and a queued show from the grids; Back to the pending tile', { fast: false, timeout: 150000 }, async (t) => {
  const { page } = t;
  await bootHome(t);
  for (const [tab, tile, extra] of [['movies', 'pend-movie:900001', null], ['shows', null, /^pd-q-tv-/]]) {
    for (let i = 0; i < 4 && (await focused(page)) !== 'tab-' + tab; i++) await page.key('Right', { settle: 120 });
    assert.equal(await focused(page), 'tab-' + tab, 'reached tab-' + tab);
    await page.key('OK', { settle: 400 });
    await page.waitFor(() => document.querySelector('.screen .grid .tile[data-focus^="pend-"]'), { what: 'a PendingTile leads the grid', timeout: 10000 });
    const key = tile || (await page.eval(() => document.querySelector('.screen .grid .tile[data-focus^="pend-"]').dataset.focus));
    for (let i = 0; i < 3 && (await focused(page)) !== key; i++) await page.key('Down', { settle: 250 });
    assert.equal(await focused(page), key, 'the PendingTile is the first grid tile');
    await page.key('OK', { settle: 400 });
    await page.waitFor(() => document.querySelector('[data-focus="pd-play"], .screen .btn.stat'), { what: 'PendingDetail', timeout: 10000 });
    await page.waitFor(() => document.activeElement && document.activeElement !== document.body && document.activeElement.closest('.screen'), { what: 'focus on PendingDetail' });
    const r = await crawl(page, { name: 'pending detail ' + key, settle: 200, maxStates: 25, timeLimit: 35000, log: t.log });
    report(t, r);
    clean(r, 'PendingDetail');
    assert(r.keys.length >= 1, 'something focusable: ' + r.keys.join(' '));
    if (extra) assert(r.keys.some((k) => extra.test(k)), 'the queued episode row reached: ' + r.keys.join(' '));
    await page.key('Back', { settle: 500 });
    await waitFocus(page, key, 10000);
    // up to the tab row for the next round
    for (let i = 0; i < 4 && !(await focused(page)).startsWith('tab-'); i++) await page.key('Up', { settle: 250 });
    assert((await focused(page)).startsWith('tab-'), 'back on the tab row');
  }
});
