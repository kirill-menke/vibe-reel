/* TV PendingDetail (S.screen 'pending', PendingDetail.svelte): the detail page
 * of a title Jellyfin doesn't have yet, built from the activity feed + reel-api
 * metadata + the partial file's probe. The status is a greyed, unfocusable
 * badge that follows the 4 s poll; when the import lands the screen keeps its
 * snapshot, says so, finds the new Jellyfin item (3 s scan pause) and offers
 * "Open in library" with focus on it. A tv title gets season pills and episode
 * rows like SeriesDetail. */
import { test, assert } from '../lib/runner.mjs';
import { landImport, addPending } from '../lib/world.mjs';
import { openPendingTile, waitFocus, focused, steer, checkFocusInvariants } from '../lib/tv.mjs';

const MB = 1024 * 1024;

const hero = (page) => page.eval(() => ({
  title: document.querySelector('.screen .hero .title')?.textContent.trim(),
  stat: document.querySelector('.screen .hero .btn.stat')?.textContent.trim(),
  statFocusable: !!document.querySelector('.screen .hero .btn.stat.focus, .screen .hero .btn.stat[data-focus]'),
  play: document.querySelector('[data-focus="pd-play"]')?.textContent.trim() || null,
  chips: [...document.querySelectorAll('.screen .hero .badgerow .chip')].map((e) => e.textContent.trim()),
  meta: document.querySelector('.screen .hero .metarow')?.textContent.replace(/\s+/g, ' ').trim()
}));


test('tv pending: a downloading movie — live status badge, probe file badges, poll updates, import lands → Open in library → MovieDetail', { fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const a = w.ml.activity.find((x) => x.id === 'q-movie-900001');
  // reel-api's own ETA format (_fmt_eta: no leading zero hour) and a speed that is exactly 7.4 MiB/s
  Object.assign(a, { timeleft: '1:11:24', download_speed: Math.round(7.4 * MB) });

  await openPendingTile(t, 'movies', 'pend-movie:900001');

  await t.step('hero: title, metadata, greyed status, Play, probe badges', async () => {
    await waitFocus(page, 'pd-play', 8000);
    await page.waitFor(() => document.querySelectorAll('.screen .hero .badgerow .chip').length >= 3 && /★/.test(document.querySelector('.screen .hero .metarow')?.textContent || ''), { what: 'probe badges + metadata', timeout: 8000 });
    const h = await hero(page);
    t.log('hero: ' + JSON.stringify(h));
    assert.equal(h.title, 'Glass Meridian Rising');
    assert.equal(h.stat, '43% · 7.4 MB/s · 1:11:24 left', 'live status (CLAUDE.md format)');
    assert(!h.statFocusable, 'the status is a badge, not a control');
    assert.match(h.play, /^▶ Play$/);
    assert(srv.requests({ origin: 'ml', path: '/api/downloads/' + 'a'.repeat(40) + '/probe' }).length >= 1, 'probed the partial file');
    assert(srv.requests({ origin: 'ml', path: '/api/metadata/movie/900001' }).length >= 1, 'metadata from reel-api');
    // the probe (4K HEVC Dolby Vision, E-AC3 Atmos) beats the release quality "Bluray-2160p"
    assert(!h.chips.includes('Bluray-2160p'), 'release-name quality replaced by file badges: ' + h.chips.join(' | '));
    assert.equal(h.chips[0], '4K', 'resolution badge');
    assert.equal(h.chips[1], 'Dolby Vision', 'HDR badge from the probe');
    assert.equal(h.chips[2], 'DD+ Atmos', 'audio badge from the probe');
    assert.equal(h.chips.at(-1), '7.8 GB', 'size chip');
    assert.match(h.meta, /2024/);
    assert.match(h.meta, /PG-13/);
    assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants');
  });

  await t.step('the next 4 s poll moves the badge; importing shows the status word', async () => {
    Object.assign(a, { progress: 0.57, download_speed: Math.round(12.5 * MB), timeleft: '42:05' });
    await page.waitFor(() => document.querySelector('.screen .hero .btn.stat')?.textContent.trim() === '57% · 13 MB/s · 42:05 left', { what: 'badge after the poll', timeout: 6000 });
    Object.assign(a, { status: 'importing', progress: 1, download_speed: 0, timeleft: null });
    const t0 = Date.now();
    await page.waitFor(() => document.querySelector('.screen .hero .btn.stat')?.textContent.trim() === 'Importing', { what: 'Importing', timeout: 9000 });
    t.log('Importing after ' + (Date.now() - t0) + ' ms; activity GETs: ' + srv.requests({ origin: 'ml', path: '/api/activity' }).slice(-4).map((e) => e.t - t0).join(','));
    assert.equal(await focused(page), 'pd-play', 'an importing grab is still streamable: Play keeps focus');
  });

  let item;
  await t.step('the import lands: snapshot stays, note + Open in library takes focus', async () => {
    const n0 = srv.requests({ origin: 'jf', path: /^\/Items$/ }).length;
    item = landImport(w, 'q-movie-900001', { createdAgoMs: -60_000 });
    await page.waitFor(() => /All done — “Glass Meridian Rising” has been imported/.test(document.querySelector('.screen .body')?.textContent || ''), { what: 'landed note', timeout: 6000 });
    const h = await hero(page);
    assert.equal(h.title, 'Glass Meridian Rising', 'the page did not blank');
    assert.equal(h.stat, 'In your library');
    assert.equal(h.play, null, 'Play went with the grab');
    // Play was the movie's only control: until Open in library exists the screen has
    // nothing focusable (PendingDetail's documented exception; Back still works) —
    // <body> is acceptable only while that holds
    const f = await focused(page);
    if (f === '<body>') assert.equal(await page.eval(() => document.querySelectorAll('.screen .focus').length), 0, 'focus on <body> although the screen has a control');
    await waitFocus(page, 'pd-open', 10000); // findLanded after the 3 s scan pause
    const q = srv.requests({ origin: 'jf', path: /^\/Items$/ }).slice(n0).map((e) => new URLSearchParams(e.search)).find((p) => p.get('SearchTerm'));
    assert(q, 'Jellyfin searched for the title');
    assert.equal(q.get('SearchTerm'), 'Glass Meridian Rising');
    assert.equal(q.get('IncludeItemTypes'), 'Movie');
  });

  await t.step('OK opens the Jellyfin MovieDetail of the new item', async () => {
    await page.key('OK', { settle: 400 });
    await waitFocus(page, 'play', 10000);
    assert.equal(await page.eval(() => document.querySelector('.screen .hero .title')?.textContent.trim()), 'Glass Meridian Rising');
    assert(srv.requests({ origin: 'jf', path: '/Items/' + item.Id }).length + srv.requests({ origin: 'jf', path: '/Users/' }).filter((e) => e.path.endsWith('/Items/' + item.Id)).length >= 1, 'the detail fetched the new item');
  });
});

test('tv pending: a queued show — season pills and episode rows from /api/metadata, no Play until bytes arrive, then Play takes focus', { fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  w.ml.lookup('tv', '400001').seasons = [8, 8];
  const base = w.ml.activity.find((x) => x.id === 'q-tv-400001-1-1');
  for (const [s, e] of [[1, 2], [2, 1]]) addPending(w, { type: 'tv', media_id: '400001', season: s, episode: e, status: 'queued' });
  await openPendingTile(t, 'shows', 'pend-tv:400001');

  await t.step('nothing streamable: focus on the first control (the Season 1 pill), pills for both seasons', async () => {
    await waitFocus(page, 'pdseason-1', 8000);
    await page.waitFor(() => /Episode 1/.test(document.querySelector('.screen .eplist')?.textContent || ''), { what: 'episode titles from metadata', timeout: 8000 });
    const s = await page.eval(() => ({
      pills: [...document.querySelectorAll('.screen .seasonrow .pill')].map((e) => e.dataset.focus + (e.classList.contains('active') ? '*' : '')),
      rows: [...document.querySelectorAll('.screen .eplist .eprow')].map((e) => ({ k: e.dataset.focus, t: e.querySelector('.etitle')?.textContent.trim(), plot: e.querySelector('.plot')?.textContent.trim() })),
      sum: document.querySelector('.screen .season-sum')?.textContent.trim(),
      stat: document.querySelector('.screen .hero .btn.stat')?.textContent.trim(),
      play: !!document.querySelector('[data-focus="pd-play"]'),
      meta: document.querySelector('.screen .hero .metarow')?.textContent.replace(/\s+/g, ' ')
    }));
    t.log(JSON.stringify(s));
    assert.deepEqual(s.pills, ['pdseason-1*', 'pdseason-2']);
    assert.deepEqual(s.rows.map((r) => r.k), ['pd-q-tv-400001-1-1', 'pd-q-tv-400001-1-2']);
    assert.deepEqual(s.rows.map((r) => r.t), ['S1:E1 · Episode 1', 'S1:E2 · Episode 2'], 'titles from metadata');
    assert.equal(s.rows[1].plot, 'S1E2 of Paper Lanterns.', 'overview from metadata');
    assert.equal(s.sum, 'Season 1 · 2 episodes on the way');
    assert.equal(s.stat, 'Queued');
    assert(!s.play, 'no Play without bytes on disk');
    assert.match(s.meta, /3 episodes on the way/);
    assert(srv.requests({ origin: 'ml', path: '/api/metadata/tv/400001' }).length >= 1);
  });

  await t.step('Season 2 pill lists its row', async () => {
    await steer(page, 'pdseason-2', { settle: 150 });
    await page.key('OK', { settle: 250 });
    await page.waitFor(() => [...document.querySelectorAll('.screen .eplist .eprow')].map((e) => e.dataset.focus).join() === 'pd-q-tv-400001-2-1', { what: 'season 2 rows' });
    assert.equal(await page.eval(() => document.querySelector('.screen .season-sum')?.textContent.trim()), 'Season 2 · 1 episode on the way');
    assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants');
  });

  await t.step('S1E1 starts downloading with a probe: Play · S1:E1 appears; focus is not stolen', async () => {
    w.ml.probes['c'.repeat(40)] = structuredClone(w.ml.probes['b'.repeat(40)]);
    Object.assign(base, { status: 'downloading', progress: 0.12, download_id: 'c'.repeat(40), download_speed: 3 * MB, timeleft: '9:30', size_bytes: 1_500_000_000 });
    await page.waitFor(() => document.querySelector('[data-focus="pd-play"]'), { what: 'Play appears after the poll', timeout: 6000 });
    assert.match(await page.eval(() => document.querySelector('[data-focus="pd-play"]').textContent.trim()), /^▶ Play · S1:E1$/);
    assert.equal(await focused(page), 'pdseason-2', 'Play does not steal focus from where the user is');
    assert.match(await page.eval(() => document.querySelector('.screen .hero .btn.stat').textContent.trim()), /^Downloading · /);
  });
});
