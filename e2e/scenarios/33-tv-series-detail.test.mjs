/* TV SeriesDetail (SeriesDetail.svelte): the start season (first not fully
 * watched — api.js startSeason), season pills and the two /Shows/{id}/Episodes
 * requests per season (rows without MediaSources + a Limit=1 MediaSources one
 * for the hero badges), hold-OK watched toggles on an episode row (one hold)
 * and a season pill (armed by the first hold, committed by the second), the
 * activity feed's not-yet-imported episodes as dimmed .eprow.pend rows and a
 * queue-only season's own pill, and the inline episodes LoadError + Retry. */
import { test, assert } from '../lib/runner.mjs';
import { addPending } from '../lib/world.mjs';
import { bootTv, waitFocus, focused, checkFocusInvariants } from '../lib/tv.mjs';

async function openShow(t, name) {
  const { page, srv } = t;
  const s = srv.world.byName('Series', name);
  await bootTv(t);
  await waitFocus(page, 'tab-home');
  for (let i = 0; i < 4 && (await focused(page)) !== 'tab-shows'; i++) await page.key('Right', { settle: 120 });
  await waitFocus(page, 'tab-shows');
  await page.key('OK', { settle: 250 });
  await page.waitFor(() => document.querySelectorAll('.screen .grid .tile').length >= 6, { what: 'Shows grid', timeout: 10000 });
  const key = 'tile-' + s.Id;
  const idx = await page.eval((k) => [...document.querySelectorAll('.screen .grid .tile')].findIndex((e) => e.dataset.focus === k), key);
  assert(idx >= 0 && idx < 7, `${name} in the first grid row (${idx})`);
  await page.key('Down', { settle: 250 });
  for (let i = 0; i < idx; i++) await page.key('Right', { settle: 150 });
  await waitFocus(page, key);
  await page.key('OK', { settle: 300 });
  await page.waitFor(() => document.querySelector('.screen .seasonrow') || document.querySelector('.screen .loaderr'), { what: 'SeriesDetail', timeout: 10000 });
  return { s, uid: await page.eval(() => localStorage.getItem('reel.userId')) };
}

const view = (page) =>
  page.eval(() => {
    const s = document.querySelector('.screen');
    return {
      pills: [...s.querySelectorAll('.seasonrow .pill')].map((p) => ({ key: p.dataset.focus, text: p.textContent.trim(), active: p.classList.contains('active'), done: p.classList.contains('done'), pend: p.classList.contains('pend') })),
      rows: [...s.querySelectorAll('.eplist .eprow')].map((r) => ({ key: r.dataset.focus, title: r.querySelector('.etitle')?.textContent.trim(), plot: r.querySelector('.plot')?.textContent.trim(), watched: r.classList.contains('watched'), tick: !!r.querySelector('.echk'), pend: r.classList.contains('pend') })),
      sum: s.querySelector('.season-sum')?.firstChild?.textContent.trim() ?? null
    };
  });

const epQueries = (srv, sid) =>
  srv.requests({ origin: 'jf', method: 'GET', path: `/Shows/${sid}/Episodes` }).map((e) => Object.fromEntries(new URLSearchParams(e.search)));

const eps = (w, s, sn) => w.items.get(s.childIds[sn - 1]).childIds.map((id) => w.items.get(id));

/* D-pad onto the pill `key`: ▼ from the hero buttons (pillDown enters on the
 * active season) or ▲ from the rows, then ◀/▶ along the row */
async function toPill(page, key) {
  const isPill = (k) => /^(season|pseason)-/.test(k);
  for (let i = 0; i < 12 && !isPill(await focused(page)); i++) {
    const f = await focused(page);
    await page.key(['play', 'restart', 'trailer'].includes(f) ? 'Down' : 'Up', { settle: 150 });
  }
  assert(isPill(await focused(page)), 'reached the season pills');
  const order = await page.eval(() => [...document.querySelectorAll('.screen .seasonrow .pill')].map((p) => p.dataset.focus));
  for (let i = 0; i < 8; i++) {
    const d = order.indexOf(key) - order.indexOf(await focused(page));
    if (!d) break;
    await page.key(d > 0 ? 'Right' : 'Left', { settle: 150 });
  }
  await waitFocus(page, key);
}

test('tv series detail: Paper Kingdom opens on Season 2; pills fetch Episodes?SeasonId= (+ Limit=1 MediaSources); rows show titles and overviews', { fast: true }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const { s, uid } = await openShow(t, 'Paper Kingdom');
  await waitFocus(page, 'play', 8000);
  const [s1, s2] = s.childIds;
  let v = await view(page);
  assert.deepEqual(v.pills.map((p) => [p.key, p.active, p.done]), [['season-0', false, true], ['season-1', true, false]], 'Season 1 watched ✓, Season 2 active');
  const want2 = eps(w, s, 2);
  assert.deepEqual(v.rows.map((r) => r.title), want2.map((e) => `S2:E${e.IndexNumber} · ${e.Name}`), 'Season 2 rows');
  assert.deepEqual(v.rows.map((r) => r.plot), want2.map((e) => e.Overview), 'overviews');
  assert.match(v.sum, /^Season 2 · \d{4} · 6 episodes$/, 'season summary: ' + v.sum);
  assert.match(await page.eval(() => document.querySelector('[data-focus="play"]').textContent.trim()), /^▶ Next up · S2:E1 /, 'Play the next-up episode');

  let q = epQueries(srv, s.Id).filter((x) => x.SeasonId === s2);
  const list = q.find((x) => !x.Limit);
  const first = q.find((x) => x.Limit === '1');
  assert(list && list.Fields === 'Overview' && list.EnableImageTypes === 'Primary,Thumb' && list.UserId === uid, 'row query: Fields=Overview, no MediaSources: ' + JSON.stringify(list));
  assert(first && first.Fields === 'MediaSources', 'Limit=1 MediaSources query for the badges');
  assert.equal(epQueries(srv, s.Id).filter((x) => x.SeasonId === s1).length, 0, 'Season 1 not fetched yet');

  // ▼ from Play enters the pills on the active season; ◀ + OK picks Season 1 and focus stays on the pill
  await page.key('Down', { settle: 200 });
  await waitFocus(page, 'season-1');
  await page.key('Left', { settle: 150 });
  await waitFocus(page, 'season-0');
  await page.key('OK', { settle: 300 });
  await page.waitFor((t) => document.querySelector('.screen .eprow .etitle')?.textContent.trim() === t, { what: 'Season 1 rows', timeout: 6000 }, `S1:E1 · ${eps(w, s, 1)[0].Name}`);
  v = await view(page);
  assert.equal(await focused(page), 'season-0', 'focus stays on the pressed pill');
  assert(v.pills[0].active && !v.pills[1].active, 'Season 1 active');
  assert(v.rows.length === 6 && v.rows.every((r) => r.watched && r.tick), 'every Season 1 row wears the ✓');
  q = epQueries(srv, s.Id).filter((x) => x.SeasonId === s1);
  assert.equal(q.length, 2, 'two queries for Season 1 (rows + Limit=1)');
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants');
});

test('tv series detail: hold OK toggles an episode row (DELETE/POST /UserPlayedItems); a season pill needs two holds and re-lists the season', { fast: false, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const { s, uid } = await openShow(t, 'Paper Kingdom');
  await waitFocus(page, 'play', 8000);
  await page.key('Down', { settle: 200 });
  await waitFocus(page, 'season-1');
  await page.key('Left', { settle: 150 });
  await page.key('OK', { settle: 300 });
  const e1 = eps(w, s, 1)[0];
  await page.waitFor((k) => document.querySelector(`[data-focus="${k}"]`), { what: 'Season 1 rows', timeout: 6000 }, 'ep-' + e1.Id);
  // ▼ from the pills: onto the next-up row (S1 fully watched → its first episode)
  await page.key('Down', { settle: 250 });
  await waitFocus(page, 'ep-' + e1.Id);

  const row = (id) => page.eval((k) => {
    const r = document.querySelector(`[data-focus="${k}"]`);
    return { watched: r.classList.contains('watched'), tick: !!r.querySelector('.echk') };
  }, 'ep-' + id);
  const reqs = (id) => srv.requests({ origin: 'jf', path: '/UserPlayedItems/' + id });
  assert.deepEqual(await row(e1.Id), { watched: true, tick: true });
  const toasts = () => page.eval(() => document.getElementById('toast')?.textContent || '');

  await page.hold('OK', 700);
  await page.waitFor((k) => !document.querySelector(`[data-focus="${k}"]`).classList.contains('watched'), { what: 'row unwatched', timeout: 5000 }, 'ep-' + e1.Id);
  assert.deepEqual(await row(e1.Id), { watched: false, tick: false });
  assert.deepEqual(reqs(e1.Id).map((e) => e.method), ['DELETE'], 'one DELETE');
  assert.equal(new URLSearchParams(reqs(e1.Id)[0].search).get('userId'), uid);
  assert.equal(w.userData.get(uid + ':' + e1.Id).Played, false, 'server: unwatched');
  assert.match(await toasts(), /S1:E1 marked unwatched/);
  assert.equal(await focused(page), 'ep-' + e1.Id, 'a hold does not play or move focus');
  assert.equal(srv.requests({ origin: 'jf', path: '/Items/' + e1.Id + '/PlaybackInfo' }).length, 0, 'the hold did not start playback');

  await page.hold('OK', 700);
  await page.waitFor((k) => document.querySelector(`[data-focus="${k}"]`).classList.contains('watched'), { what: 'row watched again', timeout: 5000 }, 'ep-' + e1.Id);
  assert.deepEqual(reqs(e1.Id).map((e) => e.method), ['DELETE', 'POST']);
  assert.equal(w.userData.get(uid + ':' + e1.Id).Played, true);

  // the season pill: first hold only arms it
  await toPill(page, 'season-0');
  const s1 = s.childIds[0];
  await page.hold('OK', 700);
  await page.waitFor(() => document.querySelector('[data-focus="season-0"]').classList.contains('armed'), { what: 'pill armed', timeout: 3000 });
  assert.equal(await page.eval(() => document.querySelector('[data-focus="season-0"]').textContent.trim()), 'Hold again to mark Season 1 unwatched');
  assert.equal(reqs(s1).length, 0, 'nothing sent on the first hold');
  const n = epQueries(srv, s.Id).filter((x) => x.SeasonId === s1).length;
  await page.hold('OK', 700);
  await page.waitFor(() => !document.querySelector('[data-focus="season-0"]').classList.contains('done'), { what: 'pill no longer ✓', timeout: 5000 });
  assert.deepEqual(reqs(s1).map((e) => e.method), ['DELETE'], 'DELETE /UserPlayedItems/{seasonId}');
  assert(eps(w, s, 1).every((e) => !w.userData.get(uid + ':' + e.Id)?.Played), 'server: the whole season unwatched');
  await page.waitFor(() => [...document.querySelectorAll('.screen .eprow')].every((r) => !r.classList.contains('watched')), { what: 'rows re-listed unwatched', timeout: 5000 });
  assert(epQueries(srv, s.Id).filter((x) => x.SeasonId === s1).length > n, 'the shown season was re-listed');
  assert.match(await toasts(), /Season 1 marked unwatched/);
  assert.equal(await focused(page), 'season-0', 'focus stays on the pill');
});

test('tv series detail: Northern Line interleaves the downloading S03E07 as a dimmed pending row; a queue-only season gets its own pill', { fast: false, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const nl = w.byName('Series', 'Northern Line');
  const tvdb = nl.ProviderIds.Tvdb;
  // a queued S04E01 (a season Jellyfin doesn't have) and a quality upgrade of S03E02 (exists → no row)
  addPending(w, { type: 'tv', media_id: tvdb, season: 4, episode: 1, episode_title: 'Arrival', status: 'queued', quality: 'WEBDL-2160p' });
  addPending(w, { type: 'tv', media_id: tvdb, season: 3, episode: 2, episode_title: 'Upgrade', status: 'queued', quality: 'WEBDL-2160p', download_id: 'c'.repeat(40) });

  await openShow(t, 'Northern Line');
  await page.waitFor(() => document.querySelector('[data-focus="pseason-4"]'), { what: 'queue-only Season 4 pill', timeout: 8000 });
  let v = await view(page);
  assert.deepEqual(v.pills.map((p) => p.key), ['season-0', 'season-1', 'season-2', 'pseason-4'], 'three real pills + the pending one');
  assert(v.pills[3].pend && v.pills[3].text === 'Season 4', 'pending pill is .pill.pend "Season 4"');
  assert(v.pills[0].active, 'opens on Season 1 (E3 is mid-way)');
  assert(!v.rows.some((r) => r.pend), 'no pending row in Season 1');

  await toPill(page, 'season-2');
  await page.key('OK', { settle: 300 });
  await page.waitFor(() => document.querySelector('.screen .eprow.pend'), { what: 'pending row in Season 3', timeout: 6000 });
  v = await view(page);
  const s3 = eps(w, nl, 3);
  assert.equal(v.rows.length, 7, '6 real + 1 pending');
  assert.deepEqual(v.rows.slice(0, 6).map((r) => r.key), s3.map((e) => 'ep-' + e.Id), 'real rows in order');
  const p = v.rows[6];
  assert.equal(p.key, 'pep-q-tv-300000-3-7', 'the pending row sits after E6');
  assert(p.pend, '.eprow.pend');
  assert.equal(p.title, 'S3:E7 · Episode 7', 'title from Sonarr metadata (mlMetadata), not the feed’s episode_title');
  assert.equal(p.plot, 'S3E7 of Northern Line.', 'overview from the metadata');
  assert(!v.rows.some((r) => r.key === 'pep-q-tv-300000-3-2'), 'a grab for an episode Jellyfin has stays out of the list');
  assert.equal(v.sum, `Season 3 · ${w.items.get(nl.childIds[2]).ProductionYear} · 6 episodes · 1 on the way`);
  // "dimmed" = the title in the secondary text colour (.eprow.pend .etitle), not the primary one
  const col = await page.eval(() => [document.querySelector('.screen .eprow:not(.pend) .etitle'), document.querySelector('.screen .eprow.pend .etitle')].map((e) => getComputedStyle(e).color));
  assert(col[0] !== col[1], 'pending row title is dimmed: ' + col.join(' vs '));
  const tail = await page.eval(() => document.querySelector('.screen .eprow.pend .esub').textContent.replace(/\s+/g, ' ').trim());
  assert.match(tail, /WEBDL-2160p.*5\.0 MB\/s · 00:04:10 left/, 'quality, speed and ETA: ' + tail);

  // the queue-only season
  await toPill(page, 'pseason-4');
  const n = srv.requests({ origin: 'jf', path: `/Shows/${nl.Id}/Episodes` }).length;
  await page.key('OK', { settle: 300 });
  await page.waitFor(() => document.querySelector('[data-focus="pseason-4"]').classList.contains('active'), { what: 'Season 4 active', timeout: 4000 });
  v = await view(page);
  assert.deepEqual(v.rows.map((r) => r.key), ['pep-q-tv-300000-4-1'], 'only the queued row');
  assert.equal(v.rows[0].title, 'S4:E1 · Arrival', 'no metadata for it → the feed’s episode_title');
  assert.equal(v.rows[0].plot, 'Queued', 'status word as the plot');
  assert.equal(v.sum, 'Season 4 · 1 episode on the way');
  assert.equal(srv.requests({ origin: 'jf', path: `/Shows/${nl.Id}/Episodes` }).length, n, 'no Jellyfin query for a queue-only season');
  assert.equal(await focused(page), 'pseason-4');

  // OK on a queued pending row: a toast, nothing plays
  await page.key('Down', { settle: 250 });
  await waitFocus(page, 'pep-q-tv-300000-4-1');
  await page.key('OK', { settle: 300 });
  await page.waitFor(() => /Queued — not here yet/.test(document.getElementById('toast')?.textContent || ''), { what: 'queued toast', timeout: 3000 });
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants');
});

test('tv series detail: an episodes fetch failure shows the inline LoadError; Retry keeps it (and focus) while failing, then lists the season', { fast: false, allowErrors: [/status of 500 .*\/Shows\/[0-9a-f]+\/Episodes\?/] }, async (t) => {
  const { page, srv } = t;
  const s = srv.world.byName('Series', 'Paper Kingdom');
  const f = srv.fault({ origin: 'jf', path: new RegExp(`^/Shows/${s.Id}/Episodes$`) }, { status: 500, text: 'boom', delay: 300 });
  await openShow(t, 'Paper Kingdom');
  await page.waitFor(() => document.querySelector('.screen .eplist .loaderr.inline'), { what: 'inline episodes LoadError', timeout: 8000 });
  assert.equal(await page.eval(() => document.querySelector('.screen .loaderr .t').textContent.trim()), 'Couldn’t load the episodes');
  assert(await page.eval(() => !!document.querySelector('.screen .seasonrow')), 'the pills stay up');
  assert(!(await page.eval(() => document.querySelector('[data-focus="eps-err-back"]'))), 'inline: no Back button');
  // focus is on Retry or a live control — reach Retry by D-pad if needed
  for (let i = 0; i < 4 && (await focused(page)) !== 'eps-err-retry'; i++) await page.key('Down', { settle: 200 });
  await waitFocus(page, 'eps-err-retry');
  await page.eval(() => (document.querySelector('.screen .loaderr').__e2e = 1));

  const hits = f.hits;
  await page.key('OK', { settle: 50 });
  await page.waitFor(() => /Retrying…/.test(document.querySelector('[data-focus="eps-err-retry"]')?.textContent || ''), { what: 'Retrying…', timeout: 2000 });
  await page.waitFor(() => /^Retry$/.test(document.querySelector('[data-focus="eps-err-retry"]')?.textContent.trim() || ''), { what: 'back to Retry', timeout: 5000 });
  assert(f.hits > hits, 'Retry asked again');
  assert(await page.eval(() => document.querySelector('.screen .loaderr').__e2e === 1), 'the same card stayed mounted');
  assert.equal(await focused(page), 'eps-err-retry', 'focus stays on Retry');

  f.remove();
  await page.key('OK', { settle: 300 });
  await page.waitFor(() => document.querySelectorAll('.screen .eprow').length === 6, { what: 'Season 2 rows after Retry', timeout: 6000 });
  assert(!(await page.eval(() => document.querySelector('.screen .loaderr'))), 'card gone');
  const f2 = await focused(page);
  assert(f2 !== '<body>', 'focus did not drop to <body>: ' + f2);
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants');
});
