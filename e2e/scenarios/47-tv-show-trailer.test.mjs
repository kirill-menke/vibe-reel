/* TV: a show's Trailer button where Jellyfin's TMDB list has none
 * (trailer.js findShowTrailer → reel-api GET /api/metadata/tv/{id}/trailer,
 * backend showtrailers.py). SeriesDetail asks only when the series has no
 * RemoteTrailers; LookupDetail asks for every show (Sonarr's metadata has no
 * trailer). The button appears once the answer lands — without taking focus —
 * and not at all for a null: a wrong trailer is worse than none, so null is
 * a common answer. Seed: Electric Orchard (library, no RemoteTrailers) and
 * Golden Frontier (not in the library) have a found trailer. */
import { test, assert } from '../lib/runner.mjs';
import { bootTv, waitFocus, focused, steer, checkFocusInvariants, sleep } from '../lib/tv.mjs';

const trailerCalls = (srv, tvdb) => srv.requests({ origin: 'ml', method: 'GET', path: `/api/metadata/tv/${tvdb}/trailer` });
const hasButton = (page, key) => page.eval((k) => !!document.querySelector(`.screen .hero .actions [data-focus="${k}"]`), key);
const buttonAppears = (page, key) =>
  page.waitFor((k) => document.querySelector(`.screen .hero .actions [data-focus="${k}"]`), { what: 'the Trailer button', timeout: 8000 }, key);

/* the answer to a null is the absence of a button: wait for the request, then a little */
async function askedOnce(srv, tvdb) {
  for (let i = 0; i < 40 && !trailerCalls(srv, tvdb).length; i++) await sleep(100);
  assert.equal(trailerCalls(srv, tvdb).length, 1, `asked for ${tvdb}'s trailer once`);
  await sleep(300);
}

/* on the Shows grid: steer onto `name`'s tile, OK into SeriesDetail */
async function openShow(page, name) {
  await page.waitFor(() => document.querySelectorAll('.screen .grid .tile').length >= 6, { what: 'Shows grid', timeout: 10000 });
  const key = await page.eval((n) => [...document.querySelectorAll('.screen .grid .tile')].find((e) => e.textContent.includes(n))?.dataset.focus, name);
  assert(key, name + ' in the Shows grid');
  await steer(page, key, { settle: 150 });
  await page.key('OK', { settle: 300 });
  await waitFocus(page, 'play', 10000);
}

test('tv show trailer: SeriesDetail asks reel-api only without RemoteTrailers; a found one adds the button, a null adds none', { fast: true, timeout: 120000 }, async (t) => {
  const { page, srv } = t;
  const tvdb = (name) => srv.world.byName('Series', name).ProviderIds.Tvdb;
  await bootTv(t);
  await waitFocus(page, 'tab-home');
  for (let i = 0; i < 4 && (await focused(page)) !== 'tab-shows'; i++) await page.key('Right', { settle: 120 });
  await waitFocus(page, 'tab-shows');
  await page.key('OK', { settle: 250 });

  await t.step('(a) Electric Orchard: no RemoteTrailers, the search found one → Trailer appears, focus stays', async () => {
    await openShow(page, 'Electric Orchard');
    await buttonAppears(page, 'trailer');
    assert.equal(trailerCalls(srv, tvdb('Electric Orchard')).length, 1, 'asked once');
    assert.equal(await focused(page), 'play', 'the late button took no focus');
    await checkFocusInvariants(page);
    await page.key('Back', { settle: 400 });
  });

  await t.step('(b) Northern Line: TMDB lists a trailer → that one, no reel-api call', async () => {
    await openShow(page, 'Northern Line');
    assert(await hasButton(page, 'trailer'), "Jellyfin's trailer button");
    await sleep(1500);   // past findShowTrailer's idle deadline
    assert.equal(trailerCalls(srv, tvdb('Northern Line')).length, 0, 'not asked');
    await page.key('Back', { settle: 400 });
  });

  await t.step('(c) Paper Kingdom: nothing found → asked, and no button', async () => {
    await openShow(page, 'Paper Kingdom');
    await askedOnce(srv, tvdb('Paper Kingdom'));
    assert(!(await hasButton(page, 'trailer')), 'no Trailer button');
  });
});

test('tv show trailer: LookupDetail of a show not in the library gets the trailer the search found (Trending · Shows)', { fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  await bootTv(t);
  await waitFocus(page, 'tab-home');
  await page.waitFor(() => document.querySelector('.screen.home [data-focus="lk-tv-400002"]'), { what: 'Golden Frontier on Trending · Shows', timeout: 10000 });

  await steer(page, 'lk-tv-400002', { settle: 150 });
  await page.key('OK', { settle: 300 });
  await waitFocus(page, 'lk-add', 10000);
  await buttonAppears(page, 'lk-trailer');
  assert.equal(trailerCalls(srv, '400002').length, 1, 'asked once');
  assert.equal(await focused(page), 'lk-add', 'the late button took no focus');
  await page.key('Back', { settle: 400 });

  // Hidden Station: nothing found → no button
  await waitFocus(page, 'lk-tv-400002', 8000);
  await steer(page, 'lk-tv-400003', { settle: 150 });
  await page.key('OK', { settle: 300 });
  await waitFocus(page, 'lk-add', 10000);
  await askedOnce(srv, '400003');
  assert(!(await hasButton(page, 'lk-trailer')), 'no Trailer button');
});
