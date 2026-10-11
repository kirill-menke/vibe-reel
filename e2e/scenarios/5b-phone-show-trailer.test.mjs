/* Phone (and the web build, which runs the same screens): a show's Trailer
 * action where Jellyfin's TMDB list has none — phone SeriesDetail /
 * LookupDetail / PendingDetail → trailer.js findShowTrailer → reel-api
 * GET /api/metadata/tv/{id}/trailer (backend showtrailers.py), as on the TV
 * (47-tv-show-trailer). The action appears once the answer lands, and not at
 * all for a null: a wrong trailer is worse than none. Seed: Electric Orchard
 * (library, no RemoteTrailers) and Golden Frontier (not in the library) have
 * a found trailer; Paper Kingdom has neither; Paper Lanterns (queued, not in
 * Jellyfin) gets one set by the test. */
import { test, assert } from '../lib/runner.mjs';
import { bootPhone, openTab, topHas, tapIn } from '../lib/phone.mjs';
import { sleep } from '../lib/page.mjs';

const trailerCalls = (srv, tvdb) => srv.requests({ origin: 'ml', method: 'GET', path: `/api/metadata/tv/${tvdb}/trailer` });

/* the top route's ActionBar labels */
const actions = (page) => page.eval(() => {
  const top = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1);
  return [...(top?.querySelectorAll('.actions .action') || [])].map((b) => (b.getAttribute('aria-label') || b.textContent).trim());
});
const trailerShows = (page) => page.waitFor(() => {
  const top = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1);
  return [...(top?.querySelectorAll('.actions .action') || [])].some((b) => /Trailer/.test(b.getAttribute('aria-label') || b.textContent));
}, { what: 'the Trailer action', timeout: 8000 });

/* Shows grid → `name`'s series page, settled */
async function openShow(page, name) {
  await page.waitFor(() => document.querySelectorAll('.screen.lib .lib__grid .tile[role="button"]').length >= 6, { what: 'shows grid', timeout: 10000 });
  // a tile with a grab in flight is labelled "Northern Line, downloading"
  await tapIn(page, '.lib__grid .tile[role="button"]', new RegExp('^' + name + '(,|$)'), { scope: 'doc' });
  await page.waitFor((n) => [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1)?.querySelector('.detail__title')?.textContent.trim() === n, { what: name + ' page', timeout: 10000 }, name);
}

/* the top route's own Back (NavBar), then the Shows grid is on top again */
async function back(page) {
  await page.eval(() => [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1).querySelector('.iconbtn[aria-label^="Back"]').click());
  await page.waitFor(() => !document.querySelector('.zoom-art') && [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1)?.querySelector('.lib__grid'), { what: 'back on the Shows grid', timeout: 10000 });
  await sleep(300);
}

test('phone show trailer: SeriesDetail asks reel-api only without RemoteTrailers (found → Trailer, null → none); a queued show’s PendingDetail and an un-added show’s LookupDetail get the found one', { app: 'phone', fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const tvdb = (name) => srv.world.byName('Series', name).ProviderIds.Tvdb;
  await bootPhone(t);
  await openTab(page, 'Shows');

  await t.step('(a) Electric Orchard: no RemoteTrailers, the search found one → Trailer appears', async () => {
    await openShow(page, 'Electric Orchard');
    await trailerShows(page);
    assert.equal(trailerCalls(srv, tvdb('Electric Orchard')).length, 1, 'asked once');
    await back(page);
  });

  await t.step('(b) Northern Line: TMDB lists a trailer → that one, no reel-api call', async () => {
    await openShow(page, 'Northern Line');
    await trailerShows(page);
    await sleep(1200);
    assert.equal(trailerCalls(srv, tvdb('Northern Line')).length, 0, 'not asked');
    await back(page);
  });

  await t.step('(c) Paper Kingdom: nothing found → asked, and no Trailer', async () => {
    await openShow(page, 'Paper Kingdom');
    for (let i = 0; i < 40 && !trailerCalls(srv, tvdb('Paper Kingdom')).length; i++) await sleep(100);
    assert.equal(trailerCalls(srv, tvdb('Paper Kingdom')).length, 1, 'asked once');
    await sleep(500);
    assert(!(await actions(page)).some((a) => /Trailer/.test(a)), 'no Trailer action: ' + (await actions(page)).join(', '));
    await back(page);
  });

  await t.step('(d) Paper Lanterns, queued: PendingDetail asks with the grab\'s tvdb id; a found one adds Trailer', async () => {
    const e = srv.world.ml.lookup('tv', '400001');
    assert(e && e.title === 'Paper Lanterns', 'the queued show is Paper Lanterns');
    e.trailer = 'ytFixtureLn';
    await tapIn(page, '.lib__grid .tile[role="button"]', /^Paper Lanterns,/, { scope: 'doc' });
    const key = await topHas(page, '.detail__title');
    assert(/^pending-/.test(key), 'PendingDetail route: ' + key);
    await trailerShows(page);
    assert.equal(trailerCalls(srv, '400001').length, 1, 'asked once');
    await back(page);
  });

  await t.step('(e) Golden Frontier from Search: LookupDetail gets the found trailer', async () => {
    await openTab(page, 'Search');
    await page.tapSel('.search__input');
    await page.waitFor(() => document.activeElement?.classList.contains('search__input'), { what: 'search input focused' });
    await page.type('golden f');
    await tapIn(page, '.srch__grid .tile[role="button"]', /^Golden Frontier/);
    const key = await topHas(page, '.detail__title');
    assert(/^lookup-/.test(key), 'LookupDetail route: ' + key);
    await trailerShows(page);
    assert.equal(trailerCalls(srv, '400002').length, 1, 'asked once');
  });
});
