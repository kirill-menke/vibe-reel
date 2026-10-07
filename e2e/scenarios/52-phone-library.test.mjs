/* Phone Library (phone/src/screens/Library.svelte, sheets/SortFilter.svelte):
 * the Movies / Shows grids page through /Items without MediaSources (CLAUDE.md:
 * phone tiles never request it), the Sort & filter sheet lists /Genres, counts
 * with Limit=0 queries, applies only on "Show N", and a swipe down on its
 * grabber dismisses it without applying the draft. */
import { test, assert } from '../lib/runner.mjs';
import { bootPhone, openTab } from '../lib/phone.mjs';
import { sleep } from '../lib/page.mjs';

const PAGE = 126;
const PENDING_LABEL = /, (downloading|queued|importing|paused|problem|failed)$/;

/* the grid's /Items queries for one type (Limit > 0), parsed */
const gridQueries = (srv, type) =>
  srv.requests({ origin: 'jf', method: 'GET', path: '/Items' })
    .filter((e) => e.path === '/Items')
    .map((e) => Object.fromEntries(new URLSearchParams(e.search)))
    .filter((q) => q.IncludeItemTypes === type && q.StartIndex != null); // not freshness' Limit=1 markers
const countQueries = (srv, type) =>
  srv.requests({ origin: 'jf', method: 'GET', path: '/Items' })
    .filter((e) => e.path === '/Items')
    .map((e) => Object.fromEntries(new URLSearchParams(e.search)))
    .filter((q) => q.IncludeItemTypes === type && q.Limit === '0');

const bySortName = (a, b) => (a.SortName < b.SortName ? -1 : a.SortName > b.SortName ? 1 : 0);
function expected(w, type, { genre = '', unwatched = false, uid } = {}) {
  let l = w.list(type);
  if (genre) l = l.filter((m) => (m.Genres || []).includes(genre));
  if (unwatched) l = l.filter((m) => !w.userData.get(uid + ':' + m.Id)?.Played);
  const key = type === 'Series' ? 'DateLastContentAdded' : 'DateCreated';
  l = l.slice().sort((a, b) => ((a[key] || a.DateCreated) < (b[key] || b.DateCreated) ? 1 : (a[key] || a.DateCreated) > (b[key] || b.DateCreated) ? -1 : bySortName(a, b)));
  return l.map((m) => m.Name);
}

/* the visible grid: item tile labels (pending tiles apart), its dim state, the count line */
const grid = (page) => page.eval((src) => {
  const re = new RegExp(src);
  const s = [...document.querySelectorAll('.screen.lib')].find((x) => x.checkVisibility());
  if (!s) return null;
  const tiles = [...s.querySelectorAll('.lib__grid .tile[role="button"]')].map((e) => e.getAttribute('aria-label'));
  return { items: tiles.filter((l) => !re.test(l)), pending: tiles.filter((l) => re.test(l)), dim: !!s.querySelector('.lib__grid.lib__dim'), count: s.querySelector('.lib__countrow .count')?.textContent.trim() || '' };
}, PENDING_LABEL.source);

/* scroll the visible library scroller to its end until the grid has n item tiles */
async function scrollUntil(page, n, what) {
  const t0 = Date.now();
  for (;;) {
    const g = await grid(page);
    if (g && g.items.length >= n) return g;
    if (Date.now() - t0 > 15000) throw new Error(`${what}: ${g?.items.length} of ${n} tiles after 15 s`);
    await page.eval(() => {
      const s = [...document.querySelectorAll('.screen.lib')].find((x) => x.checkVisibility());
      s.scrollTop = s.scrollHeight;
      return true;
    });
    await sleep(150);
  }
}

const sheetSel = '.sheethost .sheet';
const sheetUp = (page, title) => page.waitFor((title) => {
  const s = document.querySelector('.sheethost .sheet');
  return s && s.querySelector('.sheet__title')?.textContent === title && s.getAnimations().every((a) => a.playState !== 'running');
}, { what: title + ' sheet settled' }, title);
const sheetGone = (page) => page.waitFor(() => !document.querySelector('.sheethost .sheet'), { what: 'sheet dismissed' });

/* tap the first button inside css whose text matches re */
async function tapText(page, css, re) {
  const p = await page.waitFor((css, src) => {
    const el = [...document.querySelectorAll(css)].find((b) => b.checkVisibility() && new RegExp(src).test(b.textContent.trim()));
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    return b.width ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
  }, { what: 'button ' + re }, css, re.source);
  await page.tap(p.x, p.y);
}

const showBtn = (page) => page.eval(() => document.querySelector('.sheethost .sheet__foot .btn')?.textContent.trim());

test('phone library: Movies grid pages to all 140 without MediaSources; Sort & filter lists /Genres, counts with Limit=0, applies a genre; swipe-down discards', { app: 'phone', timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  await bootPhone(t);
  const uid = await page.eval(() => localStorage.getItem('reel.userId'));
  await openTab(t.page, 'Movies');
  const all = expected(w, 'Movie');
  assert.equal(all.length, 140, 'seed has 140 movies');

  await page.waitFor(() => document.querySelectorAll('.screen.lib .lib__grid .tile[role="button"]').length >= 12, { what: 'first grid slice', timeout: 10000 });
  let q = gridQueries(srv, 'Movie');
  assert.equal(q.length, 1, 'one page so far');
  assert.equal(q[0].StartIndex, '0');
  assert.equal(q[0].Limit, String(PAGE));
  assert.equal(q[0].SortBy, 'DateCreated,SortName');
  assert(!/MediaSources/.test(q[0].Fields || ''), 'phone grid never asks for MediaSources: ' + q[0].Fields);
  assert(/ProviderIds/.test(q[0].Fields), 'ProviderIds for the activity merge');

  // scroll down: the sentinel pages in the rest
  const full = await scrollUntil(page, 140, 'paging');
  q = gridQueries(srv, 'Movie');
  assert.deepEqual(q.map((x) => [x.StartIndex, x.Limit]), [['0', String(PAGE)], [String(PAGE), String(PAGE)]], 'two pages');
  assert(q.every((x) => !/MediaSources/.test(x.Fields || '')), 'no page asks for MediaSources');
  assert.deepEqual(full.items, all, 'grid = all movies in DateCreated order');
  assert.equal(full.pending.length, 1, 'the downloading movie leads as a pending tile');
  assert.equal(full.count, '140 movies · 1 downloading');
  await sleep(500);
  assert.equal(gridQueries(srv, 'Movie').length, 2, 'no third page once everything is loaded');

  // Sort & filter: the genre list is /Genres for Movie; Show N counts with Limit=0
  await page.eval(() => [...document.querySelectorAll('.screen.lib')].find((x) => x.checkVisibility()).scrollTop = 0);
  await tapText(page, '.screen.lib .chips .chip', /^Recently added/);
  await sheetUp(page, 'Sort & filter');
  const gq = srv.requests({ origin: 'jf', path: '/Genres' }).map((e) => Object.fromEntries(new URLSearchParams(e.search)));
  assert(gq.length >= 1 && gq.every((x) => x.IncludeItemTypes === 'Movie' && x.UserId === uid), 'Genres asked for Movie with the user');
  const want = [...new Set(w.list('Movie').flatMap((m) => m.Genres || []))].sort();
  const chips = await page.waitFor(() => {
    const c = [...document.querySelectorAll('.sheethost .sheet .chips--wrap .chip')].map((b) => b.textContent.trim());
    return c.length > 1 && c;
  }, { what: 'genre chips' });
  assert.deepEqual(chips, ['All', ...want], 'genre chips = All + /Genres');
  await page.waitFor(() => document.querySelector('.sheethost .sheet__foot .btn')?.textContent.trim() === 'Show 140 movies', { what: 'Show 140 movies' });
  let cq = countQueries(srv, 'Movie');
  assert(cq.length >= 1 && !cq.at(-1).Genres && cq.at(-1).EnableImages === 'false' && cq.at(-1).EnableUserData === 'false', 'a bare Limit=0 count');

  const genre = 'Documentary';
  const gexp = expected(w, 'Movie', { genre });
  assert(gexp.length > 0 && gexp.length < 140, `${genre} narrows the list (${gexp.length})`);
  await tapText(page, sheetSel + ' .chips--wrap .chip', new RegExp('^' + genre + '$'));
  await page.waitFor((n) => document.querySelector('.sheethost .sheet__foot .btn')?.textContent.trim() === `Show ${n} movies`, { what: `Show ${gexp.length} movies` }, gexp.length);
  cq = countQueries(srv, 'Movie');
  assert.equal(cq.at(-1).Genres, genre, 'the count asks for the drafted genre');
  assert.equal(gridQueries(srv, 'Movie').length, 2, 'drafting doesn’t re-query the grid');

  await tapText(page, sheetSel + ' .sheet__foot .btn', /^Show \d+ movies$/);
  await sheetGone(page);
  await page.waitFor((names) => {
    const s = [...document.querySelectorAll('.screen.lib')].find((x) => x.checkVisibility());
    if (!s || s.querySelector('.lib__grid.lib__dim')) return false;
    const got = [...s.querySelectorAll('.lib__grid .tile[role="button"]')].map((e) => e.getAttribute('aria-label')).filter((l) => !/, (downloading|queued)$/.test(l));
    return JSON.stringify(got) === JSON.stringify(names);
  }, { what: 'genre grid', timeout: 8000 }, gexp);
  q = gridQueries(srv, 'Movie');
  assert.equal(q.at(-1).Genres, genre, 'grid re-queried with Genres=');
  assert.equal(q.at(-1).StartIndex, '0');
  const gl = await grid(page);
  assert.equal(gl.count, `${gexp.length} movies`, 'count line for the genre');
  assert.equal(await page.eval(() => [...document.querySelectorAll('.screen.lib .chips .chip')].find((c) => c.classList.contains('chip--on'))?.textContent.trim()), genre, 'Genre chip shows the pick');
  const saved = await page.eval(() => JSON.parse(localStorage.getItem('reel.libview') || '{}'));
  assert.equal(saved.movies?.genre, genre, 'reel.libview keeps the genre');

  // reopen, draft "Unwatched only", swipe the grabber down: nothing applied
  await tapText(page, '.screen.lib .chips .chip', /^Recently added/);
  await sheetUp(page, 'Sort & filter');
  await page.tapSel(sheetSel + ' .switch, ' + sheetSel + ' [role="switch"]');
  await page.waitFor(() => /Show \d+ movies/.test(document.querySelector('.sheethost .sheet__foot .btn')?.textContent || '') && document.querySelector('.sheethost .sheet [role="switch"]')?.getAttribute('aria-checked') === 'true', { what: 'Unwatched drafted' });
  const nq = gridQueries(srv, 'Movie').length;
  const r = await page.eval(() => {
    const b = document.querySelector('.sheethost .sheet .sheet__grab').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + 12 };
  });
  await page.swipe(r.x, r.y, r.x, r.y + 420, { steps: 10, ms: 220 });
  await sheetGone(page);
  await sleep(400);
  assert.equal(gridQueries(srv, 'Movie').length, nq, 'a swipe-down applies nothing');
  const after = await page.eval(() => JSON.parse(localStorage.getItem('reel.libview') || '{}'));
  assert(!after.movies?.unwatched, 'unwatched not saved');
  assert.equal((await grid(page)).count, `${gexp.length} movies`, 'grid unchanged');
});

test('phone library: Shows tab queries Series; Unwatched chip and a genre from the sheet re-query server-side', { app: 'phone', timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  await bootPhone(t);
  const uid = await page.eval(() => localStorage.getItem('reel.userId'));
  await openTab(t.page, 'Shows');
  const all = expected(w, 'Series');
  await page.waitFor((n) => {
    const s = [...document.querySelectorAll('.screen.lib')].find((x) => x.checkVisibility());
    return s && [...s.querySelectorAll('.lib__grid .tile[role="button"]')].filter((e) => !/, (downloading|queued)$/.test(e.getAttribute('aria-label'))).length === n;
  }, { what: 'shows grid', timeout: 10000 }, all.length);
  let g = await grid(page);
  assert.deepEqual(g.items, all, 'shows in DateLastContentAdded order');
  let q = gridQueries(srv, 'Series');
  assert.equal(q.length, 1);
  assert.equal(q[0].SortBy, 'DateLastContentAdded,SortName');
  assert(!/MediaSources/.test(q[0].Fields || ''), 'no MediaSources on the shows grid');
  // a show that isn't in Jellyfin yet (queued) leads as a pending tile
  assert(g.pending.length >= 1, 'pending show tile: ' + JSON.stringify(g.pending));

  // Unwatched chip: Filters=IsUnplayed on the next query, the chip turns on
  await tapText(page, '.screen.lib .chips .chip', /^Unwatched$/);
  await page.waitFor(() => [...document.querySelectorAll('.screen.lib .chips .chip')].find((c) => c.textContent.trim() === 'Unwatched')?.getAttribute('aria-pressed') === 'true', { what: 'Unwatched on' });
  await page.waitFor(() => !document.querySelector('.screen.lib .lib__grid.lib__dim'), { what: 'grid settled' });
  q = gridQueries(srv, 'Series');
  assert.equal(q.at(-1).Filters, 'IsUnplayed', 'Filters=IsUnplayed');
  const uexp = expected(w, 'Series', { unwatched: true, uid });
  g = await grid(page);
  assert.deepEqual(g.items, uexp, 'unwatched shows');
  assert(/unwatched show/.test(g.count), 'count says unwatched: ' + g.count);

  // Genre chip opens the sheet (focus: genre); the list is Series genres
  await tapText(page, '.screen.lib .chips .chip', /^(All genres|Genre)/);
  await sheetUp(page, 'Sort & filter');
  const want = [...new Set(w.list('Series').flatMap((m) => m.Genres || []))].sort();
  const chips = await page.waitFor(() => {
    const c = [...document.querySelectorAll('.sheethost .sheet .chips--wrap .chip')].map((b) => b.textContent.trim());
    return c.length > 1 && c;
  }, { what: 'genre chips' });
  assert.deepEqual(chips, ['All', ...want], 'Series genres');
  assert(srv.requests({ origin: 'jf', path: '/Genres' }).some((e) => new URLSearchParams(e.search).get('IncludeItemTypes') === 'Series'), 'Genres for Series');
  // the Unwatched switch reflects the view
  assert.equal(await page.eval(() => document.querySelector('.sheethost .sheet [role="switch"]')?.getAttribute('aria-checked')), 'true', 'switch mirrors the chip');
  await tapText(page, sheetSel + ' .chips--wrap .chip', /^Drama$/);
  const dexp = expected(w, 'Series', { genre: 'Drama', unwatched: true, uid });
  await page.waitFor((n) => document.querySelector('.sheethost .sheet__foot .btn')?.textContent.trim() === `Show ${n} ${n === 1 ? 'show' : 'shows'}`, { what: 'Show N shows' }, dexp.length);
  const cq = countQueries(srv, 'Series').at(-1);
  assert.equal(cq.Genres, 'Drama');
  assert.equal(cq.Filters, 'IsUnplayed', 'the count carries the Unwatched filter');
  await tapText(page, sheetSel + ' .sheet__foot .btn', /^Show \d+ shows?$/);
  await sheetGone(page);
  await page.waitFor((names) => {
    const s = [...document.querySelectorAll('.screen.lib')].find((x) => x.checkVisibility());
    if (!s || s.querySelector('.lib__grid.lib__dim')) return false;
    const got = [...s.querySelectorAll('.lib__grid .tile[role="button"]')].map((e) => e.getAttribute('aria-label')).filter((l) => !/, (downloading|queued)$/.test(l));
    return JSON.stringify(got) === JSON.stringify(names);
  }, { what: 'Drama grid', timeout: 8000 }, dexp);
  q = gridQueries(srv, 'Series').at(-1);
  assert.equal(q.Genres, 'Drama');
  assert.equal(q.Filters, 'IsUnplayed');

  // Clear filters resets both
  await tapText(page, '.screen.lib .lib__countrow .lib__clear', /^Clear filters$/);
  await page.waitFor((n) => {
    const s = [...document.querySelectorAll('.screen.lib')].find((x) => x.checkVisibility());
    return s && !s.querySelector('.lib__grid.lib__dim') && [...s.querySelectorAll('.lib__grid .tile[role="button"]')].filter((e) => !/, (downloading|queued)$/.test(e.getAttribute('aria-label'))).length === n;
  }, { what: 'unfiltered shows', timeout: 8000 }, all.length);
  q = gridQueries(srv, 'Series').at(-1);
  assert(!q.Genres && !q.Filters, 'cleared query');
});
