/* TV Library grid × download activity (activity.svelte.js, Library.svelte,
 * PendingTile.svelte, Tile.svelte's `pend`): a title Jellyfin doesn't know yet
 * leads the grid as a PendingTile, an existing title with grabs in flight wears
 * the .dlring + a "Downloading N%" caption (CLAUDE.md calls it the .dlbadge;
 * the markup is .dlring + .cap .s.dlstat), the 4 s poll moves the numbers, a
 * feed failing for > 20 s goes stale (no %, no pulse) without dropping tiles,
 * matching is by tvdb/tmdb id first and title only as the fallback, and an
 * import landing swaps the PendingTile for the real tile. */
import { test, assert } from '../lib/runner.mjs';
import { landImport } from '../lib/world.mjs';
import { bootTv, waitFocus, focused, sleep, holds, checkFocusInvariants } from '../lib/tv.mjs';

const E503 = /status of 503 .*\/api\/activity/;

async function openTab(t, tab) {
  const { page } = t;
  await bootTv(t);
  await waitFocus(page, 'tab-home');
  for (let i = 0; i < 4 && (await focused(page)) !== 'tab-' + tab; i++) await page.key('Right', { settle: 120 });
  await waitFocus(page, 'tab-' + tab);
  await page.key('OK', { settle: 250 });
  await page.waitFor(() => document.querySelectorAll('.screen .grid .tile').length >= 5, { what: tab + ' grid', timeout: 10000 });
  await waitFocus(page, 'tab-' + tab);
}

const gridKeys = (page) => page.eval(() => [...document.querySelectorAll('.screen .grid .tile')].map((e) => e.dataset.focus));

/* what a tile shows about its download, read from the DOM */
const tileInfo = (page, key) =>
  page.eval((key) => {
    const el = document.querySelector(`.screen .grid [data-focus="${CSS.escape(key)}"]`);
    if (!el) return null;
    const ring = el.querySelector('.dlring');
    const cs = ring && getComputedStyle(ring);
    return {
      cap: el.querySelector('.cap .s')?.textContent.trim() ?? null,
      title: el.querySelector('.cap .t')?.textContent.trim() ?? null,
      ring: ring ? [...ring.classList].filter((c) => c !== 'dlring').join(' ') : null,
      anim: cs ? cs.animationName : null,
      badge: el.querySelector('.techbadge')?.textContent.trim() ?? null,
      index: [...document.querySelectorAll('.screen .grid .tile')].indexOf(el)
    };
  }, key);

const waitCap = (page, key, re, timeout, what) =>
  page.waitFor((key, src) => {
    const c = document.querySelector(`.screen .grid [data-focus="${CSS.escape(key)}"] .cap .s`)?.textContent.trim();
    return c && new RegExp(src).test(c) && c;
  }, { what: what || `${key} caption ~ ${re}`, timeout }, key, re.source);

const activityPolls = (srv) => srv.requests({ origin: 'ml', method: 'GET', path: '/api/activity' }).length;

test('tv library activity: the downloading movie leads Movies as a PendingTile; the 4 s poll moves its %', { fast: true }, async (t) => {
  const { page, srv } = t;
  const ml = srv.world.ml;
  await openTab(t, 'movies');
  const key = 'pend-movie:900001';
  const keys = await gridKeys(page);
  assert.equal(keys[0], key, 'the PendingTile for Glass Meridian Rising leads the grid');
  assert.equal(keys.filter((k) => k.startsWith('pend-')).length, 1, 'exactly one pending movie (the feed has one movie)');
  const info = await tileInfo(page, key);
  assert.equal(info.title, 'Glass Meridian Rising');
  assert.equal(info.cap, 'Downloading 43% · 2024', 'status leads the caption, then the year');
  assert.equal(info.ring, 'downloading', '.dlring.downloading');
  assert.equal(info.badge, '4K', 'Bluray-2160p → the same 4K techbadge a downloaded tile wears');
  // no real movie tile carries a ring: nothing else of the feed is a movie
  const rings = await page.eval(() => document.querySelectorAll('.screen .grid .tile[data-focus^="tile-"] .dlring').length);
  assert.equal(rings, 0, 'no library movie has a ring');

  // the poll: progress moves → the caption follows within one 4 s period
  const a = ml.activity.find((x) => x.media_id === '900001');
  a.progress = 0.58;
  const n0 = activityPolls(srv);
  await waitCap(page, key, /^Downloading 58% · 2024$/, 6000);
  assert(activityPolls(srv) > n0, 'it was a poll that moved it');
  // status word changes the ring modifier too
  a.status = 'importing';
  await waitCap(page, key, /^Importing · 2024$/, 6000);
  assert.equal((await tileInfo(page, key)).ring, 'importing');
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants');
});

test('tv library activity: a feed failing > 20 s goes stale (no %, no pulse) and keeps every tile; recovery restores it', { fast: false, timeout: 90000, allowErrors: [E503] }, async (t) => {
  const { page, srv } = t;
  await openTab(t, 'movies');
  const key = 'pend-movie:900001';
  await waitCap(page, key, /^Downloading 43%/, 5000);
  const before = await gridKeys(page);

  const f = srv.fault({ origin: 'ml', path: '/api/activity' }, { status: 503, json: { error: 'temporarily_unavailable', detail: 'sonarr down' } });
  const t0 = Date.now();
  // a blip is not stale: the last list keeps its numbers for 20 s
  await holds(async () => (await tileInfo(page, key))?.cap === 'Downloading 43% · 2024', 9000, 'the last-known % for ~9 s of failures (a blip is not stale)');
  assert(f.hits >= 1, 'the poll hit the fault');
  await waitCap(page, key, /^Status unavailable · 2024$/, 25000, 'stale caption');
  const took = Date.now() - t0;
  assert(took >= 19000, `stale only after ~20 s of failing polls (took ${took} ms)`);
  const st = await tileInfo(page, key);
  assert.equal(st.ring, 'stale', '.dlring.stale');
  assert.equal(st.anim, 'none', 'a stale ring does not pulse');
  assert(!/%/.test(st.cap), 'no % while stale');
  assert.deepEqual(await gridKeys(page), before, 'no tile vanished, none appeared (a stale feed never looks like an import)');

  // recovery: the next good poll clears it
  f.remove();
  await waitCap(page, key, /^Downloading 43% · 2024$/, 6000, 'live caption again');
  assert.equal((await tileInfo(page, key)).ring, 'downloading');
  assert.deepEqual(await gridKeys(page), before, 'same grid after recovery');
});

test('tv library activity: Shows — Northern Line keeps its real tile with the live 71%, matched by tvdb id even when the feed renames it', { fast: false, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const nl = w.byName('Series', 'Northern Line');
  const key = 'tile-' + nl.Id;
  await openTab(t, 'shows');
  let info = await tileInfo(page, key);
  assert(info, 'Northern Line tile is in the grid');
  assert.equal(info.ring, 'downloading', 'its real tile wears the ring');
  assert.match(info.cap, /^Downloading 71% · /, 'live % in the caption');
  const keys = await gridKeys(page);
  // the queued Paper Lanterns isn't in Jellyfin → a PendingTile; Northern Line is not duplicated as one
  assert.deepEqual(keys.filter((k) => k.startsWith('pend-')), ['pend-tv:400001'], 'only the un-imported show is pending');
  assert.equal((await tileInfo(page, 'pend-tv:400001')).cap, 'Queued · 1 episode');
  assert.equal((await tileInfo(page, 'pend-tv:400001')).ring, 'queued');

  // the feed renames the title: the tvdb id still matches
  const a = w.ml.activity.find((x) => x.media_id === nl.ProviderIds.Tvdb);
  a.title = 'Northern Line (UK)';
  a.progress = 0.8;
  await waitCap(page, key, /^Downloading 80% · /, 6000, 'renamed feed entry still on the real tile');
  assert(!(await gridKeys(page)).some((k) => k === 'pend-tv:' + nl.ProviderIds.Tvdb), 'no PendingTile for the renamed title');

  // a different id under the same name is a DIFFERENT title (no name fallback when both sides have ids)
  a.media_id = '399999';
  a.title = 'Northern Line';
  await page.waitFor((k) => !document.querySelector(`.screen .grid [data-focus="${k}"] .dlring`), { what: 'ring gone after the id mismatch', timeout: 6000 }, key);
  info = await tileInfo(page, key);
  assert.equal(info.ring, null, 'the real tile lost its ring: ids differ');
  assert(!/Downloading/.test(info.cap), 'and its download caption: ' + info.cap);
  /* F-008: being a different title, it leads the grid as its own PendingTile
   * (Library's `fresh` used to drop it by NAME, so it showed nowhere). */
  await page.waitFor(() => !!document.querySelector('.screen .grid [data-focus="pend-tv:399999"]'), { what: 'PendingTile for the same-named, different-id show (F-008)', timeout: 6000 });
  assert.match((await tileInfo(page, 'pend-tv:399999')).cap, /^Downloading 80% · /, 'the PendingTile carries the download');

  // no id in the feed (older backend): case-insensitive title is the fallback
  a.media_id = null;
  a.title = 'NORTHERN LINE';
  await waitCap(page, key, /^Downloading 80% · /, 6000, 'title fallback matched');
  assert(!(await gridKeys(page)).some((k) => /^pend-tv:t:/.test(k)), 'no title-keyed PendingTile');
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants');
});

test('tv library activity: pending tiles are hidden while a genre is picked and come back with All', { fast: false }, async (t) => {
  const { page } = t;
  await openTab(t, 'movies');
  assert((await gridKeys(page))[0].startsWith('pend-'), 'pending tile first');
  for (let i = 0; i < 4 && (await focused(page)) !== 'lv-genre'; i++) await page.key('Right', { settle: 120 });
  await waitFocus(page, 'lv-genre');
  await page.key('OK', { settle: 200 });
  await waitFocus(page, 'lv-g-all');
  await page.key('Down', { settle: 120 });
  await page.key('OK', { settle: 250 });
  await page.waitFor(() => {
    const g = document.querySelector('.screen .grid');
    return g && !g.classList.contains('dim') && !g.querySelector('[data-focus^="pend-"]') && g.querySelectorAll('.tile').length > 0;
  }, { what: 'genre grid without pending tiles', timeout: 8000 });
  await waitFocus(page, 'lv-genre');
  await page.key('OK', { settle: 200 });
  await page.key('Up', { settle: 120 });
  await waitFocus(page, 'lv-g-all');
  await page.key('OK', { settle: 250 });
  await page.waitFor(() => document.querySelector('.screen .grid .tile')?.dataset.focus === 'pend-movie:900001', { what: 'pending tile back with All genres', timeout: 8000 });
});

test('tv library activity: an import landing swaps the focused PendingTile for the real tile', { fast: false, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  await openTab(t, 'movies');
  const pkey = 'pend-movie:900001';
  await page.key('Down', { settle: 250 });
  await waitFocus(page, pkey);

  // the import: Radarr's grab leaves the feed, Jellyfin gains the movie (tmdb 900001)
  const n0 = srv.requests({ origin: 'jf', path: '/Items' }).filter((e) => e.path === '/Items').length;
  const { Id: id } = landImport(w, 'q-movie-900001', { createdAgoMs: -60_000 });

  // the PendingTile goes with the next poll; focus must not drop to <body>
  await page.waitFor((k) => !document.querySelector(`[data-focus="${k}"]`), { what: 'pending tile gone', timeout: 6000 }, pkey);
  assert((await focused(page)) !== '<body>', 'focus parked on a tile, not <body>');
  // the grid re-fetches its loaded range after Jellyfin's scan pause (3 s) and focus lands on the real tile
  await waitFocus(page, 'tile-' + id, 12000);
  const after = srv.requests({ origin: 'jf', path: '/Items' }).filter((e) => e.path === '/Items').slice(n0).map((e) => Object.fromEntries(new URLSearchParams(e.search)));
  assert(after.some((q) => q.IncludeItemTypes === 'Movie' && q.StartIndex === '0'), 'the grid was re-fetched in place');
  assert.equal((await gridKeys(page))[0], 'tile-' + id, 'the real tile now leads the grid');
  const info = await tileInfo(page, 'tile-' + id);
  assert.equal(info.ring, null, 'no ring: nothing in flight any more');
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants');
});
