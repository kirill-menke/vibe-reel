/* TV Person screen (Person.svelte) opened from MovieDetail's cast rail, and
 * Detail's LoadError (Detail.svelte → LoadError fkey "detail-err"): the
 * filmography query, the no-photo placeholder (no image request at all for a
 * person without a PrimaryImageTag), Back onto the cast member; and Retry on
 * a failing /Items/{id} keeping the same card and focus until it succeeds.
 * LoadError's 60 s auto-retry (onReconnect every:60000) is not waited for. */
import { test, assert } from '../lib/runner.mjs';
import { bootTv, waitFocus, focused, checkFocusInvariants } from '../lib/tv.mjs';

async function openMovieTile(t, movie) {
  const { page } = t;
  await bootTv(t);
  await waitFocus(page, 'tab-home');
  await page.key('Right', { settle: 120 });
  await waitFocus(page, 'tab-movies');
  await page.key('OK', { settle: 250 });
  await page.waitFor(() => document.querySelectorAll('.screen .grid .tile').length >= 20, { what: 'Movies grid', timeout: 10000 });
  const key = 'tile-' + movie.Id;
  const idx = await page.eval((k) => [...document.querySelectorAll('.screen .grid .tile')].findIndex((e) => e.dataset.focus === k), key);
  assert(idx >= 0 && idx < 7, `${key} in the first row (${idx})`);
  await page.key('Down', { settle: 250 });
  for (let i = 0; i < idx; i++) await page.key('Right', { settle: 150 });
  await waitFocus(page, key);
  return key;
}

/* Jellyfin's answer, from the world: Movie+Series with this person, by
 * ProductionYear, PremiereDate, SortName — all descending (one SortOrder) */
function filmography(w, pid) {
  const k = (it) => [it.ProductionYear || 0, it.PremiereDate || '', it.SortName || ''];
  return [...w.items.values()]
    .filter((it) => (it.Type === 'Movie' || it.Type === 'Series') && (it.People || []).some((p) => p.Id === pid))
    .sort((a, b) => {
      const x = k(a), y = k(b);
      for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? 1 : -1;
      return 0;
    })
    .map((it) => 'tile-' + it.Id);
}

test('tv person: cast → Person with the filmography query; a person without a photo gets the placeholder and no image request; Back returns to the cast member', { fast: true, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const people = [...w.items.values()].filter((it) => it.Type === 'Person');
  const withPic = people.find((p) => p.ImageTags.Primary);
  const noPic = people.find((p) => !p.ImageTags.Primary);
  assert(withPic && noPic, 'the seed has people with and without photos');
  const m = w.list('Movie')[1];
  m.People = [
    { Name: withPic.Name, Id: withPic.Id, Role: 'Lead', Type: 'Actor', PrimaryImageTag: withPic.ImageTags.Primary },
    { Name: noPic.Name, Id: noPic.Id, Role: 'Second', Type: 'Actor' },
    { Name: 'Ava Archer', Id: people[0].Id, Role: '', Type: 'Director', PrimaryImageTag: people[0].ImageTags.Primary }
  ];
  const tile = await openMovieTile(t, m);
  await page.key('OK', { settle: 300 });
  await waitFocus(page, 'play', 10000);
  await page.key('Down', { settle: 300 });
  const castA = `cast-${withPic.Id}-0`, castB = `cast-${noPic.Id}-1`;
  await waitFocus(page, castA);
  assert.equal(await page.eval(() => document.querySelectorAll('.screen .cast-strip .cast').length), 2, 'only actors in the cast rail');

  // A: photo + filmography
  await page.key('OK', { settle: 300 });
  await page.waitFor(() => document.querySelector('.screen .personhead .title')?.textContent.trim() && document.querySelector('.screen .grid .tile'), { what: 'Person screen with tiles', timeout: 8000 });
  assert.equal(await page.eval(() => document.querySelector('.screen .personhead .title').textContent.trim()), withPic.Name);
  const q = srv.requests({ origin: 'jf', method: 'GET', path: '/Items' }).filter((e) => e.path === '/Items').map((e) => Object.fromEntries(new URLSearchParams(e.search))).filter((x) => x.PersonIds);
  assert.equal(q.length, 1, 'one filmography query');
  assert.equal(q[0].PersonIds, withPic.Id);
  assert.equal(q[0].IncludeItemTypes, 'Movie,Series');
  assert.equal(q[0].SortBy, 'ProductionYear,PremiereDate,SortName');
  assert.equal(q[0].SortOrder, 'Descending');
  assert.equal(q[0].Recursive, 'true');
  assert(srv.requests({ origin: 'jf', method: 'GET', path: '/Items/' + withPic.Id }).some((e) => e.path === '/Items/' + withPic.Id), 'GET /Items/{personId} for the header');
  const exp = filmography(w, withPic.Id);
  assert(exp.length >= 2, 'the person has several titles');
  const got = await page.eval(() => [...document.querySelectorAll('.screen .grid .tile')].map((e) => e.dataset.focus));
  assert.deepEqual(got, exp, 'filmography in the server order');
  const n = exp.length;
  assert.equal(await page.eval(() => document.querySelector('.screen .personhead .sub').textContent.trim()), `${n} title${n === 1 ? '' : 's'} in your library`);
  await page.waitFor(() => document.querySelector('.screen .personhead .head img'), { what: 'header photo', timeout: 5000 });
  assert.match(await page.eval(() => document.querySelector('.screen .personhead .head img').src), new RegExp(`/Items/${withPic.Id}/Images/Primary`), 'photo URL');
  assert.match(await focused(page), /^tile-/, 'focus on the first title');
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants on Person');
  await page.key('Back', { settle: 300 });
  await waitFocus(page, castA, 10000);

  // B: no PrimaryImageTag → placeholder in the rail and the header, no image request anywhere
  await page.key('Right', { settle: 200 });
  await waitFocus(page, castB);
  assert.deepEqual(await page.eval((k) => {
    const h = document.querySelector(`[data-focus="${k}"] .head`);
    return [!!h.querySelector('img'), h.textContent.trim()];
  }, castB), [false, 'photo'], 'cast placeholder');
  await page.key('OK', { settle: 300 });
  await page.waitFor((name) => document.querySelector('.screen .personhead .title')?.textContent.trim() === name && document.querySelector('.screen .grid .tile, [data-focus="person-back"]'), { what: 'Person B', timeout: 8000 }, noPic.Name);
  await page.waitFor(() => !document.querySelector('.screen .vload'), { what: 'loaded', timeout: 5000 });
  assert(!(await page.eval(() => document.querySelector('.screen .personhead .head img'))), 'no header <img> without a photo');
  assert.equal(srv.requests({ origin: 'jf', path: `/Items/${noPic.Id}/Images` }).length, 0, 'no image request for a person without a photo');
  await page.key('Back', { settle: 300 });
  await waitFocus(page, castB, 10000);
  await page.key('Back', { settle: 300 });
  await waitFocus(page, tile, 10000);
});

test('tv detail: /Items/{id} failing shows the LoadError; Back leaves it; Retry keeps the card and focus while failing, then shows the detail', { fast: false, allowErrors: [/status of 500 .*\/Items\/[0-9a-f]{32}\?/] }, async (t) => {
  const { page, srv } = t;
  const m = srv.world.list('Movie')[1];
  const f = srv.fault({ origin: 'jf', method: 'GET', path: new RegExp(`^/Items/${m.Id}$`) }, { status: 500, text: 'database is locked', delay: 300 });
  const tile = await openMovieTile(t, m);
  await page.key('OK', { settle: 300 });
  await waitFocus(page, 'detail-err-retry', 10000);
  const card = () => page.eval(() => ({ t: document.querySelector('.screen .loaderr .t')?.textContent.trim(), why: document.querySelector('.screen .loaderr .why')?.textContent.trim() }));
  const c0 = await card();
  assert.equal(c0.t, 'Couldn’t load this title');
  assert.equal(c0.why, 'The server had a problem (HTTP 500)', 'why-line via errText, never the raw body');
  t.log('why-line: ' + c0.why);
  assert(await page.eval(() => !!document.querySelector('[data-focus="detail-err-back"]')), 'a Back button');
  assert(!(await page.eval(() => document.querySelector('.screen .vload'))), 'no spinner behind it');

  // Back (the key) returns to the grid tile
  await page.key('Back', { settle: 300 });
  await waitFocus(page, tile, 10000);
  await page.key('OK', { settle: 300 });
  await waitFocus(page, 'detail-err-retry', 10000);
  await page.eval(() => (document.querySelector('.screen .loaderr').__e2e = 1));

  // Retry while still failing: "Retrying…", same card, focus stays
  const hits = f.hits;
  await page.key('OK', { settle: 50 });
  await page.waitFor(() => /Retrying…/.test(document.querySelector('[data-focus="detail-err-retry"]')?.textContent || ''), { what: 'Retrying…', timeout: 2000 });
  await page.waitFor(() => document.querySelector('[data-focus="detail-err-retry"]')?.textContent.trim() === 'Retry', { what: 'Retry again', timeout: 5000 });
  assert(f.hits > hits, 'it asked again');
  assert(await page.eval(() => document.querySelector('.screen .loaderr')?.__e2e === 1), 'the same card stayed mounted (no flash to the spinner)');
  assert.equal(await focused(page), 'detail-err-retry', 'focus stays on Retry');

  // the server is back: Retry shows the detail
  f.remove();
  await page.key('OK', { settle: 300 });
  await waitFocus(page, 'play', 8000);
  assert.equal(await page.eval(() => document.querySelector('.screen .hero .title')?.textContent.trim()), m.Name);
  assert(!(await page.eval(() => document.querySelector('.screen .loaderr'))), 'card gone');
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants');
});
