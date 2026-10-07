/* TV Search (Search.svelte, Keyboard.svelte, LookupDetail.svelte,
 * lookup.svelte.js): ▲ on the tab row raises the overlay, the bar is not a
 * text field, OK opens Search's own keyboard, typed results are LookupTiles,
 * Done focuses the first one, OK on a title the library lacks opens
 * LookupDetail from reel-api metadata, Add to library posts it, Back peels
 * one layer at a time: detail → Search on the card → (keyboard) → Search
 * closed onto the tab it was raised from. */
import { test, assert } from '../lib/runner.mjs';
import { bootTv, waitFocus, focused, steer, kbType, sleep } from '../lib/tv.mjs';

const searchUp = (page) => page.eval(() => document.getElementById('search')?.classList.contains('on') && document.body.classList.contains('search-on'));
const visibleKeys = (page, css) => page.eval((css) => [...document.querySelectorAll(css)].filter((e) => e.checkVisibility()).map((e) => e.dataset.focus), css);
const resultKeys = (page) => visibleKeys(page, '#search .grid .tile.focus');
const barText = (page) => page.eval(() => document.querySelector('#search .sbar .sq')?.textContent.trim());

/* what the catalog holds for a query (the fake's lookup is a substring match) */
const expectedFor = (srv, q) => [...srv.world.ml.catalog.values()].filter((e) => e.title.toLowerCase().includes(q)).map((e) => `lk-${e.type}-${e.id}`).sort();

async function bootHome(t) {
  await bootTv(t);
  await waitFocus(t.page, 'tab-home');
  await t.page.waitFor(() => document.querySelectorAll('.screen.home .rails .rail').length >= 4, { what: 'Home rails', timeout: 10000 });
}

async function raiseSearch(page) {
  await page.key('Up', { settle: 300 });
  await page.waitFor(() => document.getElementById('search')?.classList.contains('on'), { what: 'Search up' });
  await waitFocus(page, 'q2');
}

async function until(fn, what, timeout = 8000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeout) throw new Error('timed out waiting for ' + what);
    await sleep(50);
  }
}

const lookups = (srv) => srv.requests({ origin: 'ml', path: '/api/lookup' }).map((e) => ({ q: new URLSearchParams(e.search).get('q'), type: new URLSearchParams(e.search).get('type') }));

test('tv search: ▲ raises it, on-screen keyboard types "harbor", Done → first result, LookupDetail from metadata, Add to library, Back chain', { fast: true, timeout: 120000 }, async (t) => {
  const { page, srv } = t;
  await bootHome(t);

  await t.step('▲ on the tab row raises Search with focus on the bar', async () => {
    assert(!(await searchUp(page)), 'Search starts closed');
    await raiseSearch(page);
    assert(await searchUp(page), '#search.on + body.search-on');
    assert.equal(await page.eval(() => document.querySelectorAll('#search input, #search textarea').length), 0, 'no text field (it would open the webOS system keyboard)');
  });

  await t.step('OK opens the keyboard on kb-a; D-pad + OK type "harbor"', async () => {
    await page.key('OK', { settle: 200 });
    await waitFocus(page, 'kb-a');
    assert(await page.eval(() => document.querySelector('#search .sbar')?.classList.contains('typing')), 'bar shows the typing state');
    await kbType(page, 'harbor');
    assert.equal(await barText(page), 'harbor', 'the bar shows what was typed');
    assert((await focused(page)).startsWith('kb-'), 'focus stays on the keyboard while results arrive');
  });

  const want = expectedFor(srv, 'harbor');
  await t.step('lookups go out for tv + movie, the last one for "harbor"; results are LookupTiles', async () => {
    await until(() => ['tv', 'movie'].every((ty) => lookups(srv).filter((l) => l.type === ty).at(-1)?.q === 'harbor'), 'the "harbor" lookups');
    await page.waitFor((n) => document.querySelectorAll('#search .grid .tile.focus').length === n, { what: want.length + ' results', timeout: 10000 }, want.length);
    const ls = lookups(srv);
    for (const type of ['tv', 'movie']) {
      const mine = ls.filter((l) => l.type === type);
      assert(mine.length >= 1, 'a ' + type + ' lookup went out');
      assert.equal(mine.at(-1).q, 'harbor', 'the last ' + type + ' lookup is for the whole query');
      assert(mine.every((l) => 'harbor'.startsWith(l.q) && l.q.length >= 2), 'only prefixes ≥ 2 chars were looked up: ' + mine.map((l) => l.q).join(','));
    }
    assert.deepEqual((await resultKeys(page)).sort(), want, 'the results are the catalog matches');
    assert(await page.eval(() => [...document.querySelectorAll('#search .grid .tile.focus')].every((e) => e.classList.contains('v') && e.querySelector('.poster'))), 'LookupTile shells (.tile.v with a poster)');
    assert((await focused(page)).startsWith('kb-'), 'a landing lookup does not yank focus out of the keyboard');
  });

  await t.step('Done folds the keyboard and focuses the first result', async () => {
    await steer(page, 'kb-done');
    await page.key('OK', { settle: 250 });
    await page.waitFor(() => !document.querySelector('#search .skb'), { what: 'keyboard folded' });
    const first = (await resultKeys(page))[0];
    await waitFocus(page, first);
  });

  const target = 'lk-movie-900008'; // Harbor Lights — not in the library
  await t.step('OK on a title the library lacks opens LookupDetail built from /api/metadata', async () => {
    assert(want.includes(target), 'Harbor Lights is a result');
    await steer(page, target, { settle: 150 });
    const before = srv.requests({ origin: 'ml', path: '/api/metadata/movie/900008' }).length;
    await page.key('OK', { settle: 300 });
    await waitFocus(page, 'lk-add', 10000);
    assert(!(await searchUp(page)), 'Search is down under the detail');
    await page.waitFor(() => /★ 7\.7/.test(document.querySelector('.screen .hero .metarow')?.textContent || ''), { what: 'metadata rating in the metarow', timeout: 8000 });
    assert(srv.requests({ origin: 'ml', path: '/api/metadata/movie/900008' }).length > before, 'metadata was fetched for movie 900008');
    const hero = await page.eval(() => ({ title: document.querySelector('.screen .hero .title')?.textContent.trim(), meta: document.querySelector('.screen .hero .metarow')?.textContent.replace(/\s+/g, ' ').trim(), add: document.querySelector('[data-focus="lk-add"]')?.textContent.trim() }));
    assert.equal(hero.title, 'Harbor Lights');
    assert.match(hero.meta, /2017/, 'year in the metarow');
    assert.match(hero.meta, /PG-13/, 'certification from metadata');
    assert.match(hero.add, /Add to library/);
    assert.equal(srv.world.ml.adds.length, 0, 'nothing added yet');
  });

  await t.step('Add to library posts it; the button turns into the status; a toast says so', async () => {
    await page.key('OK', { settle: 100 });
    await page.waitFor(() => !document.querySelector('[data-focus="lk-add"]') && document.querySelector('[data-focus="lk-stat"]'), { what: 'Add → status button', timeout: 8000 });
    assert.equal(srv.requests({ origin: 'ml', method: 'POST', path: '/api/library' }).length, 1, 'one POST /api/library');
    assert.deepEqual(srv.world.ml.adds.map((a) => [a.type, a.id]), [['movie', '900008']], 'the fake recorded the add');
    await page.waitFor(() => /Added — “Harbor Lights” is downloading/.test(document.querySelector('#toast.show')?.textContent || ''), { what: 'add toast', timeout: 5000 });
    await page.waitFor(() => !/Adding…/.test(document.querySelector('[data-focus="lk-stat"]')?.textContent || 'Adding…'), { what: 'status settled', timeout: 8000 });
    const stat = await page.eval(() => document.querySelector('[data-focus="lk-stat"]').textContent.trim());
    assert.match(stat, /^(Added — searching for a download|Queued.*|.*queued.*)$/i, 'status after the add');
    assert.equal(await focused(page), 'lk-stat', 'focus rode along onto the status button');
  });

  await t.step('Back raises Search again on that card', async () => {
    await page.key('Back', { settle: 400 });
    await page.waitFor(() => document.getElementById('search')?.classList.contains('on'), { what: 'Search raised again' });
    await waitFocus(page, target);
    assert.equal(await barText(page), 'harbor', 'the query survived');
  });

  await t.step('Back closes the keyboard first, then Search onto the tab', async () => {
    await steer(page, 'q2', { settle: 150 });
    await page.key('OK', { settle: 250 });
    await page.waitFor(() => document.querySelector('#search .skb'), { what: 'keyboard open again' });
    assert((await focused(page)).startsWith('kb-'), 'focus on a key');
    await page.key('Back', { settle: 300 });
    assert(!(await page.eval(() => document.querySelector('#search .skb'))), 'first Back closed the keyboard');
    assert(await searchUp(page), '… and left Search up');
    assert.equal(await focused(page), 'q2');
    await page.key('Back', { settle: 400 });
    assert(!(await page.eval(() => document.getElementById('search')?.classList.contains('on'))), 'second Back closed Search');
    assert(!(await page.eval(() => document.body.classList.contains('search-on'))), 'body.search-on removed');
    assert.equal(await focused(page), 'tab-home', 'focus back on the tab Search was raised from');
  });
});

test('tv search: a USB keyboard types and deletes; a superseded slow lookup never lands over the newer one', { fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  await bootHome(t);
  await raiseSearch(page);
  await page.key('OK', { settle: 200 });
  await waitFocus(page, 'kb-a');

  await t.step('printable keys type, Backspace deletes', async () => {
    await page.chars('lanternx');
    assert.equal(await barText(page), 'lanternx');
    await page.key('Backspace', { settle: 80 });
    assert.equal(await barText(page), 'lantern', 'Backspace deleted one character');
    const want = expectedFor(srv, 'lantern');
    assert(want.includes('lk-tv-400001'), 'Paper Lanterns is in the catalog');
    await page.waitFor((w) => JSON.stringify([...document.querySelectorAll('#search .grid .tile.focus')].map((e) => e.dataset.focus).sort()) === w, { what: 'results for "lantern"', timeout: 10000 }, JSON.stringify(want));
    assert.equal(lookups(srv).filter((l) => l.type === 'tv').at(-1).q, 'lantern');
  });

  await t.step('Clear empties the bar and brings the category cards back', async () => {
    await steer(page, 'kb-clear');
    await page.key('OK', { settle: 300 });
    assert.equal(await page.eval(() => document.querySelector('#search .sbar .sq')?.textContent.trim()), '', 'bar empty');
    await page.waitFor(() => document.querySelectorAll('#search .catcard').length >= 3, { what: 'category cards back', timeout: 8000 });
    await page.waitFor(() => !document.querySelector('#search .grid .tile.focus'), { what: 'results gone', timeout: 8000 });
  });

  await t.step('a slow lookup for an older query is dropped when a newer one lands first', async () => {
    const n0 = lookups(srv).length;
    // the next two lookups (tv + movie for "ha") answer 2.5 s late
    const slow = srv.fault({ origin: 'ml', path: '/api/lookup' }, { delay: 2500 }, 2);
    await page.chars('ha');
    for (let i = 0; i < 40 && slow.hits < 2; i++) await sleep(50);
    assert.equal(slow.hits, 2, 'the "ha" lookups went out (and are held)');
    await page.chars('rbor l');
    await page.waitFor(() => {
      const k = [...document.querySelectorAll('#search .grid .tile.focus')].map((e) => e.dataset.focus);
      return k.length === 1 && k[0] === 'lk-movie-900008';
    }, { what: 'only Harbor Lights for "harbor l"', timeout: 8000 });
    // the held "ha" answers go out 2.5 s after they came in (unless the app
    // aborted them): wait until the server released both, then give the app
    // a moment to apply anything that arrived
    const held = () => srv.log.filter((e) => e.fault && e.origin === 'ml' && e.path === '/api/lookup');
    await until(() => held().length >= 2 && held().every((e) => e.released), 'the held "ha" lookups released', 6000);
    await sleep(150);
    await page.frames(3);
    const keys = await resultKeys(page);
    assert.deepEqual(keys, ['lk-movie-900008'], 'the late "ha" answer did not replace the newer results');
    assert.equal(await barText(page), 'harbor l');
    const qs = lookups(srv).slice(n0).map((l) => l.q);
    assert(qs.includes('ha') && qs.at(-1) === 'harbor l', 'lookups after the clear: ' + qs.join(','));
    slow.remove();
  });
});
