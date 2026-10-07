/* TV MovieDetail (MovieDetail.svelte, TechGrid, CollectionRail): opened from
 * the Movies grid by D-pad, what it shows from GET /Items/{id} (title, year,
 * runtime, overview, hero badges, tech chips), the Watched toggle against
 * /UserPlayedItems (12.1's route — the legacy /Users/{uid}/PlayedItems is
 * gone), the TMDB collection rail from reel-api, More Like This from
 * /Items/{id}/Similar, MovieDetail's own ▼/▲ routing between the buttons and
 * the first rail, and Back onto the grid tile it was opened from. */
import { test, assert } from '../lib/runner.mjs';
import { bootTv, waitFocus, focused, checkFocusInvariants } from '../lib/tv.mjs';
import { TICKS } from '../../e2e/server/seed.mjs';

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

/* D-pad from the tab row to the grid tile of `movie`, by index in the grid */
async function toTile(page, movie) {
  const key = 'tile-' + movie.Id;
  const idx = await page.eval((k) => [...document.querySelectorAll('.screen .grid .tile')].findIndex((e) => e.dataset.focus === k), key);
  assert(idx >= 0 && idx < 7, `${key} is in the first grid row (index ${idx})`);
  await page.key('Down', { settle: 250 });
  for (let i = 0; i < idx; i++) await page.key('Right', { settle: 150 });
  await waitFocus(page, key);
  return key;
}

const detail = (page) =>
  page.eval(() => {
    const s = document.querySelector('.screen');
    const txt = (sel) => s.querySelector(sel)?.textContent.replace(/\s+/g, ' ').trim() ?? null;
    return {
      title: txt('.hero .title'),
      meta: [...s.querySelectorAll('.hero .metarow > span')].map((e) => e.textContent.trim()).filter((x) => x && x !== '·'),
      badges: [...s.querySelectorAll('.hero .badgerow .chip')].map((e) => e.textContent.trim()),
      overview: txt('.hero .overview'),
      video: [...s.querySelectorAll('.techgrid .eyebrow')].find((e) => e.textContent === 'VIDEO')?.nextElementSibling ? [...[...s.querySelectorAll('.techgrid .eyebrow')].find((e) => e.textContent === 'VIDEO').nextElementSibling.querySelectorAll('.tchip')].map((e) => e.textContent.trim()) : [],
      rails: [...s.querySelectorAll('.page > .rail > h2')].map((h) => h.textContent.replace(/\s+/g, ' ').trim()),
      buttons: [...s.querySelectorAll('.hero .actions .focus')].map((b) => b.dataset.focus)
    };
  });

const runtime = (ticks) => {
  const m = Math.round(ticks / TICKS / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

test('tv movie detail: opened from the grid shows /Items/{id}; 4K DV + DD+ Atmos badges; collection + More Like This rails; ▼/▲ hop buttons ⇄ first rail; Back to the tile', { fast: true, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const m = w.list('Movie')[0]; // The Silent Harbor: 4k-dv, TmdbCollection 7001
  assert.equal(m.ProviderIds.TmdbCollection, '7001');
  // make its E-AC3 track the Atmos one (the seed's Atmos is on TrueHD, which never wins)
  const dd = m.MediaSources[0].MediaStreams.find((s) => s.Codec === 'eac3' && s.Language === 'eng');
  dd.Title = 'DD+ Atmos 5.1';
  dd.DisplayTitle = 'English - Dolby Digital+ Atmos - 5.1';

  await openMovies(t);
  const tile = await toTile(page, m);
  await page.key('OK', { settle: 300 });
  await waitFocus(page, 'play', 10000);
  assert(srv.requests({ origin: 'jf', method: 'GET', path: '/Items/' + m.Id }).some((e) => e.path === '/Items/' + m.Id), 'GET /Items/{id} went out');

  const d0 = await detail(page);
  assert.equal(d0.title, m.Name, 'title');
  assert(d0.meta.includes(String(m.ProductionYear)), 'year in the metarow: ' + d0.meta.join(' | '));
  assert(d0.meta.includes(runtime(m.RunTimeTicks)), `runtime ${runtime(m.RunTimeTicks)} in the metarow: ` + d0.meta.join(' | '));
  assert(d0.meta.includes(m.OfficialRating), 'rating in the metarow');
  assert.equal(d0.overview, m.Overview, 'overview');
  assert.deepEqual(d0.badges, ['4K', 'Dolby Vision', 'DD+ Atmos'], 'hero badges');
  assert(d0.video.includes('3840 × 2160'), 'video chip resolution: ' + d0.video.join(' | '));
  assert(d0.video.includes('DV Profile 8.1') && d0.video.includes('HDR10 fallback'), 'DV profile chips: ' + d0.video.join(' | '));
  assert.deepEqual(d0.buttons, ['play', 'watched', 'trailer'], 'action buttons (no resume, has a trailer)');

  // the rails land asynchronously: collection + More Like This
  await page.waitFor(() => document.querySelectorAll('.screen .page > .rail > h2').length >= 3, { what: 'cast + collection + similar rails', timeout: 8000 });
  const d1 = await detail(page);
  assert.equal(d1.rails[0], 'Cast', 'Cast first');
  assert.equal(d1.rails[1], 'Harbor Collection3 films · 1 in your library', 'collection rail heading (title + .railsub)');
  const sub = await page.eval(() => document.querySelector('.screen .rail.coll h2 .railsub')?.textContent.trim());
  assert.equal(sub, '3 films · 1 in your library', 'railsub counts this film as owned');
  assert.equal(d1.rails[2], 'More Like This');
  assert.equal(srv.requests({ origin: 'ml', path: '/api/collection/7001' }).length, 1, 'one /api/collection/7001');
  const coll = await page.eval(() => [...document.querySelectorAll('.screen .rail.coll .tile')].map((e) => e.dataset.focus));
  assert.deepEqual(coll, ['lk-movie-900008', 'lk-movie-900009'], 'the other two films of the collection (self left out)');
  const sim = srv.requests({ origin: 'jf', path: `/Items/${m.Id}/Similar` });
  assert.equal(sim.length, 1, 'one /Similar request');
  const sq = Object.fromEntries(new URLSearchParams(sim[0].search));
  assert.equal(sq.Limit, '12');
  const simTiles = await page.eval(() => [...document.querySelectorAll('.screen .page > .rail:last-child .tile')].map((e) => e.dataset.focus));
  assert(simTiles.length > 0 && !simTiles.includes('tile-' + m.Id), 'More Like This has tiles, not the film itself');

  // ▼ from any action button → the first rail (Cast), ▲ from there → back to a button (MovieDetail pageKey)
  await page.key('Right', { settle: 150 });
  await waitFocus(page, 'watched');
  await page.key('Down', { settle: 300 });
  const c = await focused(page);
  assert.match(c, /^cast-/, '▼ from Watched went straight to the cast rail');
  await page.key('Up', { settle: 300 });
  assert(['play', 'watched', 'trailer'].includes(await focused(page)), '▲ from the cast rail went straight back to a button: ' + (await focused(page)));
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants on MovieDetail');

  // Back → the grid, on the tile it was opened from
  await page.key('Back', { settle: 300 });
  await waitFocus(page, tile, 10000);
  assert(await page.eval(() => !!document.querySelector('.screen .grid')), 'back on the Movies grid');
});

test('tv movie detail: Watched sends POST then DELETE /UserPlayedItems/{id}?userId= and the button follows; 1080p badges; no collection rail', { fast: false }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const m = w.list('Movie')[1]; // 4k-hdr, unwatched, no collection
  const m2 = w.list('Movie')[2]; // 1080p, resumable
  const uid = await openMovies(t);
  assert(!w.userData.get(uid + ':' + m.Id)?.Played, 'starts unwatched');
  await toTile(page, m);
  await page.key('OK', { settle: 300 });
  await waitFocus(page, 'play', 10000);
  const d = await detail(page);
  assert.deepEqual(d.badges, ['4K', 'HDR10', 'DD+'], '4K HDR10 badges (DD+ wins over TrueHD)');
  assert(!(await page.eval(() => document.querySelector('.screen .rail.coll'))), 'no collection rail');
  assert.equal(srv.requests({ origin: 'ml', path: '/api/collection/' }).length, 0, 'no collection request without TmdbCollection');

  const btn = () => page.eval(() => {
    const b = document.querySelector('[data-focus="watched"]');
    return { text: b.textContent.trim(), on: b.classList.contains('on') };
  });
  assert.deepEqual(await btn(), { text: 'Mark watched', on: false });
  await page.key('Right', { settle: 150 });
  await waitFocus(page, 'watched');
  const played = () => srv.requests({ origin: 'jf', path: '/UserPlayedItems/' + m.Id });
  await page.key('OK', { settle: 200 });
  await page.waitFor(() => document.querySelector('[data-focus="watched"]').classList.contains('on'), { what: 'button on', timeout: 5000 });
  assert.deepEqual(await btn(), { text: 'Watched', on: true });
  let p = played();
  assert.equal(p.length, 1, 'one request');
  assert.equal(p[0].method, 'POST');
  assert.equal(new URLSearchParams(p[0].search).get('userId'), uid, '?userId=<uid>');
  assert.equal(w.userData.get(uid + ':' + m.Id)?.Played, true, 'the server has it watched');
  await page.waitFor(() => /Marked watched/.test(document.getElementById('toast')?.textContent || ''), { what: 'toast', timeout: 3000 });
  assert.equal(srv.requests({ origin: 'jf', path: /^\/Users\/[^/]+\/PlayedItems/ }).length, 0, 'never the legacy route');

  await page.key('OK', { settle: 200 });
  await page.waitFor(() => !document.querySelector('[data-focus="watched"]').classList.contains('on'), { what: 'button off', timeout: 5000 });
  assert.deepEqual(await btn(), { text: 'Mark watched', on: false });
  p = played();
  assert.equal(p.length, 2);
  assert.equal(p[1].method, 'DELETE');
  assert.equal(w.userData.get(uid + ':' + m.Id)?.Played, false, 'unwatched again on the server');
  assert.equal(await focused(page), 'watched', 'focus stays on the button');

  // a 1080p SDR title: 1080p + DD+, and a resumable one has Resume + Start over
  await page.key('Back', { settle: 300 });
  await waitFocus(page, 'tile-' + m.Id, 10000);
  await page.key('Right', { settle: 150 });
  await waitFocus(page, 'tile-' + m2.Id);
  await page.key('OK', { settle: 300 });
  await waitFocus(page, 'play', 10000);
  const d2 = await detail(page);
  assert.deepEqual(d2.badges, ['1080p', 'DD+'], '1080p badges');
  assert(d2.video.includes('1920 × 1080'), 'video chip 1920 × 1080');
  assert.deepEqual(d2.buttons.slice(0, 3), ['play', 'restart', 'watched'], 'resume → Start over button');
  assert.match(await page.eval(() => document.querySelector('[data-focus="play"]').textContent.trim()), /^▶ Resume · /, 'Resume label');
});
