/* TV Library grid (Library.svelte, LibraryBar.svelte, libview.svelte.js):
 * paging past 126 by D-pad, server-side sort / genre / Unwatched, the
 * dropdowns' modality, reel.libview across a reload, and Back from a detail
 * page onto the tile it was opened from (takeGridFocus + loadedCount). */
import { test, assert } from '../lib/runner.mjs';
import { bootTv, waitFocus, waitSplashGone, focused, scopeKeys, checkFocusInvariants } from '../lib/tv.mjs';

const PAGE = 126;

/* the /Items grid queries for one item type, parsed */
const gridQueries = (srv, type = 'Movie') =>
  srv.requests({ origin: 'jf', method: 'GET', path: '/Items' })
    .filter((e) => e.path === '/Items')
    .map((e) => Object.fromEntries(new URLSearchParams(e.search)))
    .filter((q) => q.IncludeItemTypes === type);

const gridKeys = (page) => page.eval(() => [...document.querySelectorAll('.screen .grid .tile')].map((e) => e.dataset.focus));
const tileKeys = async (page) => (await gridKeys(page)).filter((k) => k.startsWith('tile-'));

/* what the fake (and Jellyfin) should answer, computed from the world */
const bySortName = (a, b) => (a.SortName < b.SortName ? -1 : a.SortName > b.SortName ? 1 : 0);
function expected(w, uid, { sort = 'added', genre = '', unwatched = false } = {}) {
  let l = w.list('Movie');
  if (genre) l = l.filter((m) => (m.Genres || []).includes(genre));
  if (unwatched) l = l.filter((m) => !w.userData.get(uid + ':' + m.Id)?.Played);
  l = l.slice().sort(sort === 'title' ? bySortName : (a, b) => (a.DateCreated < b.DateCreated ? 1 : a.DateCreated > b.DateCreated ? -1 : bySortName(a, b)));
  return l.map((m) => 'tile-' + m.Id);
}

async function openMovies(t) {
  const { page } = t;
  await bootTv(t);
  await waitFocus(page, 'tab-home');
  await page.key('Right', { settle: 120 });
  await waitFocus(page, 'tab-movies');
  await page.key('OK', { settle: 250 });
  await page.waitFor(() => document.querySelectorAll('.screen .grid .tile').length >= 20, { what: 'Movies grid', timeout: 10000 });
  await waitFocus(page, 'tab-movies');
  return page.eval(() => localStorage.getItem('reel.userId'));
}

const gridSettled = (page, keys, what) =>
  page.waitFor((keys) => {
    const g = document.querySelector('.screen .grid');
    if (!g || g.classList.contains('dim')) return false;
    const got = [...g.querySelectorAll('.tile')].map((e) => e.dataset.focus).filter((k) => k.startsWith('tile-'));
    return JSON.stringify(got) === JSON.stringify(keys);
  }, { what, timeout: 8000 }, keys);

async function pressUntil(page, key, cond, max, settle = 150) {
  for (let i = 0; i < max; i++) {
    if (await cond()) return true;
    await page.key(key, { settle });
  }
  return cond();
}

test('tv library: Movies pages past 126 by D-pad in DateCreated order; Back from a page-2 detail re-requests what was loaded', { fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const uid = await openMovies(t);
  const all = expected(w, uid);
  assert.equal(all.length, 140, 'seed has 140 movies');

  const q0 = gridQueries(srv);
  assert.equal(q0.length, 1, 'one grid query on open');
  assert.equal(q0[0].StartIndex, '0', 'StartIndex=0');
  assert.equal(q0[0].Limit, String(PAGE), 'Limit=126');
  assert(q0[0].Fields.split(',').includes('ProviderIds'), 'Fields include ProviderIds: ' + q0[0].Fields);
  assert.equal(q0[0].SortBy, 'DateCreated,SortName');
  assert.equal(q0[0].SortOrder, 'Descending,Ascending');
  assert.equal(q0[0].Recursive, 'true');
  assert.deepEqual(await tileKeys(page), all.slice(0, PAGE), 'first page in DateCreated desc order');
  // the downloading movie Jellyfin doesn't know yet leads the grid
  assert((await gridKeys(page))[0].startsWith('pend-'), 'a PendingTile leads the grid');

  // ▼ down the grid until the sentinel asks for page 2, then all 140 are there
  const asked = await pressUntil(page, 'Down', async () => gridQueries(srv).some((q) => q.StartIndex === String(PAGE)), 30);
  assert(asked, 'D-pad down the grid requested StartIndex=126');
  const q1 = gridQueries(srv).find((q) => q.StartIndex === String(PAGE));
  assert.equal(q1.Limit, String(PAGE), 'page 2 Limit=126');
  assert.equal(q1.SortBy, q0[0].SortBy, 'same sort on page 2');
  await gridSettled(page, all, 'all 140 movies in the grid, in order');
  assert(!(await page.eval(() => document.querySelector('.screen .gridmore'))), 'sentinel gone when everything is loaded');
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants deep in the grid');

  // keep going into page 2's rows and open one
  const inPage2 = async () => all.indexOf(await focused(page)) >= PAGE;
  assert(await pressUntil(page, 'Down', inPage2, 10), 'reached a page-2 tile by D-pad');
  const key = await focused(page);
  const n = gridQueries(srv).length;
  await page.key('OK', { settle: 300 });
  await waitFocus(page, 'play', 10000);
  await page.key('Back', { settle: 300 });
  await waitFocus(page, key, 10000);
  const back = gridQueries(srv).slice(n);
  assert.equal(back.length, 1, 'one grid query on return');
  assert.equal(back[0].StartIndex, '0');
  assert.equal(back[0].Limit, '140', 'return re-requests as many as were loaded (loadedCount)');
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants after Back');
});

test('tv library: sort + genre + Unwatched are server-side, dropdowns are modal, the view survives a reload', { fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const uid = await openMovies(t);
  assert(await pressUntil(page, 'Right', async () => (await focused(page)) === 'lv-sort', 4, 120), 'walked to the Sort pill');

  // modal: while open only its rows are focusable; Back closes onto the pill
  await page.key('OK', { settle: 200 });
  await waitFocus(page, 'lv-s-added'); // lands on the current choice
  const scope = await scopeKeys(page);
  assert(scope.keys.length === 6 && scope.keys.every((k) => k.startsWith('lv-s-')), 'only sort rows in scope: ' + scope.keys.join(' '));
  for (const k of ['Left', 'Right', 'Up']) {
    await page.key(k, { settle: 100 });
    assert(/^lv-s-/.test(await focused(page)), k + ' stays inside the dropdown');
  }
  await page.key('Back', { settle: 200 });
  await waitFocus(page, 'lv-sort');
  assert(!(await page.eval(() => document.querySelector('.lvmenu'))), 'Back closed the dropdown');

  // Title: SortBy=SortName, order follows
  await page.key('OK', { settle: 200 });
  await waitFocus(page, 'lv-s-added');
  await page.key('Down', { settle: 120 });
  await waitFocus(page, 'lv-s-title');
  let n = gridQueries(srv).length;
  await page.key('OK', { settle: 200 });
  await waitFocus(page, 'lv-sort');
  await gridSettled(page, expected(w, uid, { sort: 'title' }).slice(0, PAGE), 'grid in title order');
  let q = gridQueries(srv).slice(n);
  assert.equal(q.length, 1, 'one re-query');
  assert.equal(q[0].SortBy, 'SortName');
  assert.equal(q[0].SortOrder, 'Ascending');
  assert.equal(q[0].StartIndex, '0');
  assert.equal(await page.eval(() => document.querySelector('[data-focus="lv-sort"]').textContent.trim()), 'Title', 'pill shows the sort');

  // Unwatched: Filters=IsUnplayed, the 4 watched movies are gone
  assert(await pressUntil(page, 'Right', async () => (await focused(page)) === 'lv-unseen', 3, 120), 'walked to Unwatched');
  n = gridQueries(srv).length;
  await page.key('OK', { settle: 200 });
  const unw = expected(w, uid, { sort: 'title', unwatched: true });
  assert.equal(unw.length, 136, '136 unwatched movies in the seed');
  await gridSettled(page, unw.slice(0, PAGE), 'unwatched grid');
  q = gridQueries(srv).slice(n);
  assert.equal(q[0].Filters, 'IsUnplayed');
  const watched = w.list('Movie').filter((m) => w.userData.get(uid + ':' + m.Id)?.Played).map((m) => 'tile-' + m.Id);
  assert.equal(watched.length, 4);
  const dom = await gridKeys(page);
  assert(watched.every((k) => !dom.includes(k)), 'no watched movie in the grid');
  assert.match(await page.eval(() => document.querySelector('.screen .libhead').textContent), /^136 movies · Unwatched/, 'summary');
  assert.equal(await focused(page), 'lv-unseen', 'focus stays on the toggle');
  await page.key('OK', { settle: 200 }); // off again
  await gridSettled(page, expected(w, uid, { sort: 'title' }).slice(0, PAGE), 'all movies again');

  // Genre: Genres=<g>, only matching titles, pending tiles hidden
  await page.key('Left', { settle: 120 });
  await waitFocus(page, 'lv-genre');
  await page.key('OK', { settle: 200 });
  await waitFocus(page, 'lv-g-all');
  const gscope = await scopeKeys(page);
  assert(gscope.keys.every((k) => k.startsWith('lv-g-')), 'only genre rows in scope');
  await page.key('Down', { settle: 120 });
  await waitFocus(page, 'lv-g-0');
  const genre = await page.eval(() => document.querySelector('[data-focus="lv-g-0"]').textContent.trim());
  const gq = srv.requests({ path: '/Genres' }).map((e) => Object.fromEntries(new URLSearchParams(e.search)));
  assert(gq.some((x) => x.IncludeItemTypes === 'Movie'), 'genre list asked for Movie genres');
  n = gridQueries(srv).length;
  await page.key('OK', { settle: 200 });
  await waitFocus(page, 'lv-genre');
  const gexp = expected(w, uid, { sort: 'title', genre });
  assert(gexp.length > 0 && gexp.length < 140, `genre ${genre} narrows the list (${gexp.length})`);
  await gridSettled(page, gexp.slice(0, PAGE), 'genre grid');
  q = gridQueries(srv).slice(n);
  assert.equal(q[0].Genres, genre, 'Genres=<g>');
  assert(!(await gridKeys(page)).some((k) => k.startsWith('pend-')), 'pending tiles hidden while a genre is picked');
  assert.equal(await page.eval(() => document.querySelector('[data-focus="lv-genre"]').textContent.trim()), genre, 'pill shows the genre');

  // reel.libview: a reload comes back with the same view and asks the server for it
  const saved = await page.eval(() => JSON.parse(localStorage.getItem('reel.libview')));
  assert.deepEqual(saved.movies, { sort: 'title', genre, unwatched: false }, 'reel.libview');
  n = gridQueries(srv).length;
  await page.reload();
  await waitSplashGone(page);
  await waitFocus(page, 'tab-home', 10000);
  await page.key('Right', { settle: 120 });
  await waitFocus(page, 'tab-movies');
  await page.key('OK', { settle: 250 });
  await gridSettled(page, gexp.slice(0, PAGE), 'genre grid after reload');
  q = gridQueries(srv).slice(n);
  assert.equal(q[0].SortBy, 'SortName', 'sort restored');
  assert.equal(q[0].Genres, genre, 'genre restored');
  assert.equal(await page.eval(() => document.querySelector('[data-focus="lv-sort"]').textContent.trim()), 'Title');
});

test('tv library: Back from a detail opened from row 3 returns focus to that tile', { fast: false }, async (t) => {
  const { page, srv } = t;
  await openMovies(t);
  for (let i = 0; i < 3; i++) await page.key('Down', { settle: 250 });
  const key = await focused(page);
  const idx = (await gridKeys(page)).indexOf(key);
  assert(idx >= 14 && idx < 21, `row 3 of the 7-wide grid (index ${idx}, ${key})`);
  const n = gridQueries(srv).length;
  await page.key('OK', { settle: 300 });
  await waitFocus(page, 'play', 10000);
  await page.key('Back', { settle: 300 });
  await waitFocus(page, key, 10000);
  assert(await page.eval(() => !!document.querySelector('.screen .grid')), 'back on the grid');
  const back = gridQueries(srv).slice(n);
  assert(back.length <= 1 && (!back.length || back[0].Limit === String(PAGE)), 'a cached (or one-page) return: ' + JSON.stringify(back));
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants after Back');
});
