/* Desktop web client (web/, VibeReel Web): a smoke test per URL route of
 * web/src/lib/urlsync.svelte.js, each loaded as a deep link into a signed-in
 * browser — the route renders its <main> and its h1, the browser tab is
 * titled after it ("<h1> · VibeReel"), and the data it shows is the fake
 * world's, fetched through the web origin's /jf and /ml. Every test also fails
 * on a console error, a request off the Jellyfin 12.1 / reel-api spec, a
 * reel-api guard refusal or any request off loopback (the harness).
 *
 * Kept UI-agnostic on purpose (the web UI is being redesigned): routes,
 * landmarks, h1s, the tab title, text the world supplies and the requests the
 * app made — no layout classes. Helpers: lib/web.mjs. */
import { test, assert } from '../lib/runner.mjs';
import { addPending, movie, series, ep } from '../lib/world.mjs';
import { bootWeb, waitRoute, openSection, webState } from '../lib/web.mjs';

/* nicole has no profile picture: the avatar falls back to her initial on the 404 */
const NO_PIC = /status of 404 .*\/UserImage\?userId=[0-9a-f]{32}&/;

/* the active route's visible text */
const routeText = (page) => page.eval(() => [...document.querySelectorAll('[data-route][data-key]')].find((e) => e.checkVisibility())?.innerText.replace(/\s+/g, ' ') || '');
const textHas = (page, s, what) => page.waitFor((s) => [...document.querySelectorAll('[data-route][data-key]')].find((e) => e.checkVisibility())?.innerText.replace(/\s+/g, ' ').includes(s), { what: what || 'route text has ' + s, timeout: 10000 }, s);

test('web: signed-in boot paints Home through the web origin\'s /jf + /ml as "VibeReel Web"; the header\'s section links switch routes', { app: 'web', fast: true }, async (t) => {
  const { page, srv } = t;
  await bootWeb(t);
  const st = await waitRoute(page, 'home', { h1: 'Northern Line', path: '/' });
  assert.equal(st.title, 'VibeReel', 'Home tab title');
  assert.equal(st.modal, null, 'nothing over Home');

  // desktop emulation: a hovering fine pointer, no touch
  const env = await page.eval(() => ({ hover: matchMedia('(hover: hover) and (pointer: fine)').matches, touch: navigator.maxTouchPoints, w: innerWidth, h: innerHeight }));
  assert.deepEqual(env, { hover: true, touch: 0, w: 1440, h: 900 }, 'desktop page metrics');

  // same origin: Jellyfin and reel-api were asked through the page's own host, as the web client
  const webHost = new URL(srv.urls.web).host;
  const resume = srv.requests({ origin: 'jf', path: '/UserItems/Resume' });
  assert(resume.length && resume.every((e) => e.host === webHost && e.status === 200), 'Resume via the web origin: ' + JSON.stringify(resume.map((e) => [e.host, e.status])));
  assert.equal(resume[0].auth.Client, 'VibeReel Web', 'Jellyfin client name');
  assert.equal(resume[0].auth.Device, 'Web', 'Jellyfin device name');
  assert.match(resume[0].auth.DeviceId, /^reelweb-/, 'DeviceId');
  assert(srv.requests({ origin: 'ml', path: '/api/trending' }).every((e) => e.host === webHost), 'trending via /ml');
  assert(srv.requests({ origin: 'ml', path: '/api/activity' }).length >= 1, 'the activity poll runs while browsing');

  for (const [name, h1, title, type] of [['Movies', 'Movies', 'Movies · VibeReel', 'Movie'], ['Shows', 'Shows', 'Shows · VibeReel', 'Series'], ['Search', 'Search', 'Search · VibeReel', null]]) {
    const s = await openSection(page, name);
    await waitRoute(page, name.toLowerCase(), { h1 });
    assert.equal((await webState(page)).title, title, name + ' tab title');
    if (type) assert(srv.requests({ origin: 'jf', path: '/Items' }).some((e) => new RegExp('IncludeItemTypes=' + type).test(e.search)), name + ' grid queried /Items');
    t.log(name, JSON.stringify(s));
  }
  await openSection(page, 'Home');
  await waitRoute(page, 'home', { h1: 'Northern Line', path: '/' });
});

/* one test per route: [name, opts, path(w), route, h1(w), check(t, w)] */
const ROUTES = [
  ['/movies', { fast: true }, () => '/movies', 'movies', () => 'Movies', async (t, w) => {
    await textHas(t.page, movie(w, 0).Name, 'the first movie tile');
    assert(t.srv.requests({ origin: 'jf', path: '/Items' }).some((e) => /IncludeItemTypes=Movie/.test(e.search)), 'movie grid query');
  }],
  ['/shows', {}, () => '/shows', 'shows', () => 'Shows', async (t) => {
    await textHas(t.page, 'Northern Line');
    assert(t.srv.requests({ origin: 'jf', path: '/Items' }).some((e) => /IncludeItemTypes=Series/.test(e.search)), 'series grid query');
  }],
  ['/search (Browse charts)', {}, () => '/search', 'search', () => 'Search', async (t) => {
    await textHas(t.page, 'IMDb Top');
    assert(t.srv.requests({ origin: 'ml', path: '/api/charts' }).length >= 1, 'chart index fetched');
  }],
  ['/search?q= (results)', { fast: true }, () => '/search?q=harbor', 'search', () => false, async (t) => {
    await textHas(t.page, 'Crimson Harbor', 'a result for "harbor"');
    const st = await webState(t.page);
    assert.equal(st.search, '?q=harbor', 'the query stays in the address');
    assert(t.srv.log.some((e) => /harbor/i.test(e.search)), 'a request carried the query');
  }],
  ['/search?q= (nothing found)', {}, () => '/search?q=zzqxv', 'search', () => false, async (t) => {
    await textHas(t.page, 'No results for “zzqxv”');
  }],
  ['/search/chart/<key>', {}, () => '/search/chart/top-movie', 'chart', () => /Top/, async (t, w) => {
    assert(t.srv.requests({ origin: 'ml', path: '/api/charts/top-movie' }).length >= 1, 'the chart fetched');
    const first = w.ml.charts['top-movie'].items?.[0]?.title || movie(w, 0).Name;
    await textHas(t.page, first, 'the chart\'s #1');
  }],
  ['/movie/<id>', { fast: true }, (w) => '/movie/' + movie(w, 0).Id, 'detail', (w) => movie(w, 0).Name, async (t, w) => {
    assert(t.srv.requests({ origin: 'jf' }).some((e) => e.path.includes(movie(w, 0).Id)), 'the item fetched');
    await textHas(t.page, 'synthetic film', 'the overview');
  }],
  ['/show/<id>', {}, (w) => '/show/' + series(w, 'Northern Line').Id, 'detail', () => 'Northern Line', async (t, w) => {
    const id = series(w, 'Northern Line').Id;
    assert(t.srv.requests({ origin: 'jf', path: '/Shows/' + id }).length >= 1, 'seasons/episodes fetched');
    await textHas(t.page, ep(w, 'Northern Line', 1, 1).Name, 'an episode row');
  }],
  ['/item/<id> (an episode)', {}, (w) => '/item/' + ep(w, 'Northern Line', 1, 3).Id, 'detail', (w) => ep(w, 'Northern Line', 1, 3).Name, async (t) => {
    await textHas(t.page, 'Northern Line', 'the series name');
  }],
  ['/person/<id>', {}, (w) => '/person/' + movie(w, 0).People[0].Id, 'person', (w) => movie(w, 0).People[0].Name, async (t, w) => {
    await textHas(t.page, movie(w, 0).Name, 'a film of the filmography');
  }],
  ['/lookup/<type>/<id>', {}, () => '/lookup/movie/900002', 'lookup', (w) => w.ml.lookup('movie', '900002').title, async (t) => {
    assert(t.srv.requests({ origin: 'ml', path: '/api/metadata/movie/900002' }).length >= 1, 'metadata fetched');
    await textHas(t.page, 'Add to library');
  }],
  ['/pending/<key> (a live download)', {}, (w) => {
    addPending(w, { type: 'movie', media_id: '900003', progress: 0.37, probe: true });
    return '/pending/' + encodeURIComponent('movie:900003');
  }, 'pending', (w) => w.ml.lookup('movie', '900003').title, async (t) => {
    await textHas(t.page, '37%', 'the live progress');
    assert(t.srv.requests({ origin: 'ml', path: '/api/activity' }).length >= 1, 'activity feed polled');
  }],
  ['/settings', {}, () => '/settings', 'settings', () => 'Settings', async (t) => {
    await textHas(t.page, 'alice', 'the signed-in user');
  }],
  ['/my-library (a normal user with owned titles)', { user: 'nicole', allowErrors: [NO_PIC] }, (w) => {
    w.ml.fill('nicole', 'movie', 3);
    return '/my-library';
  }, 'mylibrary', () => 'My library', async (t) => {
    await textHas(t.page, 'Owned Film 01', 'an owned title');
    await textHas(t.page, '3 of 10', 'the movie quota');
    assert(t.srv.requests({ origin: 'ml', path: '/api/me' }).some((e) => e.status === 200), '/api/me answered');
  }]
];

for (const [name, opts, pathOf, route, h1Of, check] of ROUTES) {
  const { user, ...rest } = opts;
  test('web route: ' + name, { app: 'web', ...rest }, async (t) => {
    const { page, srv } = t;
    const w = srv.world;
    const path = pathOf(w);
    await bootWeb(t, { path, user: user || 'alice' });
    const h1 = h1Of(w);
    // h1 false: a running search hides the page head, so only the route + its <main>
    const st = await waitRoute(page, route, { h1 });
    assert.equal(st.route, route, 'route');
    assert(st.main, 'the route\'s <main> is shown');
    assert.equal(st.modal, null, 'nothing over the page');
    // the tab is titled after the page's h1 (urlsync retitles 0.4 s and 1.9 s after a navigation)
    if (typeof h1 === 'string') await page.waitFor((want) => document.title === want, { what: `tab title "${h1} · VibeReel"`, timeout: 4000 }, h1 + ' · VibeReel');
    t.log(JSON.stringify(st));
    await check(t, w);
    const end = await webState(page);
    assert.equal(end.route, route, 'still on the route after its data landed');
  });
}
