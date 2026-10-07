/* Phone Search tab (phone/src/screens/Search.svelte, LookupDetail.svelte,
 * Chart.svelte) and PendingDetail, plus the phone's activity cadence
 * (src/lib/activity.svelte.js: 4 s only while something moves, else 30 s):
 *  - typing queries /ml/api/lookup for tv + movie; a title not in the library
 *    opens LookupDetail; Add → POST /ml/api/library, the toast's Undo →
 *    DELETE /ml/api/library/{type}/{id}?undo=<the add's token> (phone-only);
 *  - with nothing typed the chart cards show; one opens the Chart screen with
 *    rank badges in the server's order;
 *  - a downloading title opens PendingDetail with the live % / speed, and a
 *    poll moves it. */
import { test, assert } from '../lib/runner.mjs';
import { bootPhone, topRoute, openTab } from '../lib/phone.mjs';
import { holds } from '../lib/page.mjs';
import { until } from '../lib/player.mjs';

/* the top visible route element's key and the first match of css inside it */
const topHas = (page, css) => page.waitFor((css) => {
  const r = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility());
  const top = r[r.length - 1];
  if (!top || document.querySelector('.zoom-art')) return null;
  if (top.getAnimations({ subtree: true }).some((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity)) return null;
  return top.querySelector(css) ? top.dataset.key : null;
}, { what: 'top route with ' + css, timeout: 10000 }, css);

/* tap the first visible element inside the top route matching css whose text / aria-label matches re */
async function tapIn(page, css, re) {
  const p = await page.waitFor((css, src) => {
    const r = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility());
    const top = r[r.length - 1];
    const el = top && [...top.querySelectorAll(css)].find((b) => b.checkVisibility() && new RegExp(src).test((b.getAttribute('aria-label') || b.textContent).trim()));
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    return b.width ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
  }, { what: `${css} ${re}`, timeout: 10000 }, css, re.source);
  await page.tap(p.x, p.y);
}

const lookups = (srv) => srv.requests({ origin: 'ml', path: '/api/lookup' }).map((e) => Object.fromEntries(new URLSearchParams(e.search)));

test('phone search: typing looks up tv + movie; a new title opens LookupDetail; Add → POST /api/library; the toast’s Undo → DELETE with the add’s token', { app: 'phone', fast: false, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const ml = srv.world.ml;
  await bootPhone(t);
  await openTab(page, 'Search');
  await page.tapSel('.search__input');
  await page.waitFor(() => document.activeElement?.classList.contains('search__input'), { what: 'search input focused' });
  await page.type('harbor l');
  await until(() => lookups(srv).filter((q) => q.q === 'harbor l').length >= 2, 'lookups for "harbor l"', 8000);
  const ql = lookups(srv).filter((q) => q.q === 'harbor l');
  assert.deepEqual(ql.map((q) => q.type).sort(), ['movie', 'tv'], 'one lookup per type');
  assert(lookups(srv).every((q) => q.q.length >= 2), 'nothing looked up below 2 letters: ' + JSON.stringify(lookups(srv).map((q) => q.q)));

  const target = ml.catalog.get('movie:900008') || [...ml.catalog.values()].find((e) => e.type === 'movie' && String(e.id) === '900008');
  assert(target && /Harbor Lights/.test(target.title) && !target.added, 'Harbor Lights is a catalog title not in the library');
  await tapIn(page, '.srch__grid .tile[role="button"]', new RegExp('^' + target.title));
  const key = await topHas(page, '.detail__title');
  assert(/^lookup-/.test(key), 'LookupDetail route: ' + key);
  assert.equal(await page.eval(() => [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1).querySelector('.detail__title').textContent.trim()), target.title);
  assert(srv.requests({ origin: 'ml', path: '/api/metadata/movie/900008' }).length >= 1, 'metadata fetched');

  await tapIn(page, 'button', /^Add to library$/);
  const add = await until(() => srv.requests({ origin: 'ml', method: 'POST', path: '/api/library' })[0], 'POST /api/library', 8000);
  assert.equal(add.status, 202);
  const token = await until(() => ml.adds.find((a) => String(a.id) === '900008')?.undo, 'the add recorded');
  const toastText = await page.waitFor(() => {
    const t = document.querySelector('.toast');
    return t && t.querySelector('.toast__action') && t.checkVisibility() && t.textContent.trim();
  }, { what: 'toast with Undo', timeout: 8000 });
  assert(/Undo/.test(toastText), 'toast offers Undo: ' + toastText);
  await page.tapSel('.toast .toast__action');
  const del = await until(() => srv.requests({ origin: 'ml', method: 'DELETE', path: '/api/library/' })[0], 'DELETE /api/library', 8000);
  assert.equal(del.path, '/api/library/movie/900008');
  assert.equal(new URLSearchParams(del.search).get('undo'), token, 'Undo carries the add’s token');
  assert.equal(del.status, 200, 'undo accepted');
  assert(ml.undos.some((u) => String(u.id) === '900008'), 'the fake saw the undo');
  // nothing left the phone origin for any of it
  const phoneHost = new URL(srv.urls.phone).host;
  assert.deepEqual(srv.log.filter((e) => !e.path.startsWith('/__fixture/') && e.host !== phoneHost).map((e) => e.path), [], 'one origin');
});

test('phone search: chart cards open the Chart screen with ranks; a downloading title opens PendingDetail with live % that follows the feed', { app: 'phone', fast: false, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const act = srv.world.ml.activity.find((a) => a.type === 'movie' && a.status === 'downloading');
  const MB = 1024 * 1024; // the label's MB/s are binary (as in 43-tv-pending)
  act.download_speed = Math.round(7.4 * MB);
  await bootPhone(t);
  await openTab(page, 'Search');
  const cards = await page.waitFor(() => {
    const c = [...document.querySelectorAll('.catcard')].filter((e) => e.checkVisibility()).map((e) => e.querySelector('.catcard__title')?.textContent.trim());
    return c.length >= 3 && c;
  }, { what: 'chart cards', timeout: 10000 });
  assert(cards.some((c) => /^IMDb Top \d+$/.test(c)), 'a Top card: ' + JSON.stringify(cards));
  const r = await (await fetch(srv.urls.ml + '/api/charts/top-movie', { headers: srv.mlAuth() })).json();
  const want = r.sections[0].results.map((i) => [i.rank, i.title]);
  await tapIn(page, '.catcard', /^IMDb Top \d+\s*Movies/);
  await topHas(page, '.chart__grid .tile');
  const got = await page.waitFor((n) => {
    const top = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1);
    const tiles = [...top.querySelectorAll('.chart__grid .tile[role="button"]')];
    return tiles.length >= n && tiles.map((e) => [Number(e.querySelector('.badge--rank')?.textContent.trim()), e.getAttribute('aria-label')]);
  }, { what: 'chart tiles', timeout: 10000 }, Math.min(12, want.length));
  const head = await page.eval(() => [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1).querySelector('.pagehead__title')?.textContent.trim());
  assert(/^IMDb Top \d+$/.test(head), 'chart page title: ' + head);
  const n = got.length;
  assert.deepEqual(got.map((x) => x[0]), want.slice(0, n).map((x) => x[0]), 'rank badges in server order');
  assert.deepEqual(got.map((x) => x[1].split(',')[0]), want.slice(0, n).map((x) => x[1]), 'titles in server order');

  // the tab bar hides on a pushed page: Back (the nav bar's button) returns to Search
  await tapIn(page, '.iconbtn', /^Back/);
  await page.waitFor(() => document.querySelector('.tabbarhost:not([hidden])') && [...document.querySelectorAll('.catcard')].some((e) => e.checkVisibility()), { what: 'back on Search with the tab bar', timeout: 8000 });

  // PendingDetail: the downloading movie (43 %, 7.4 MB/s) from the Movies grid
  await openTab(page, 'Movies');
  await page.waitFor(() => document.querySelectorAll('.screen.lib .lib__grid .tile[role="button"]').length >= 12, { what: 'grid', timeout: 10000 });
  await tapIn(page, '.lib__grid .tile[role="button"]', new RegExp('^' + act.title + ', downloading$'));
  const pk = await topHas(page, '.btn__pct');
  assert(/^pending-/.test(pk), 'PendingDetail route: ' + pk);
  const stat = () => page.eval(() => {
    const top = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1);
    return { title: top.querySelector('.detail__title')?.textContent.trim(), pct: top.querySelector('.btn__pct')?.textContent.trim(), rate: top.querySelector('.btn__rate')?.textContent.trim() };
  });
  let s = await stat();
  assert.equal(s.title, act.title);
  assert.equal(s.pct, '43%');
  assert.equal(s.rate, '7.4 MB/s');
  act.progress = 0.58;
  act.download_speed = Math.round(9.5 * MB);
  await page.waitFor(() => [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1).querySelector('.btn__pct')?.textContent.trim() === '58%', { what: '58% after a poll', timeout: 10000 });
  s = await stat();
  assert.equal(s.rate, '9.5 MB/s', 'speed follows the feed');
});

test('phone activity cadence: an idle feed (nothing moving) polls ≤ 1× in 12 s; a moving download polls every ~4 s', { app: 'phone', fast: false, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const ml = srv.world.ml;
  // idle: every grab queued or stalled at speed 0
  const saved = ml.activity.map((a) => ({ ...a }));
  for (const a of ml.activity) a.download_speed = 0;
  await bootPhone(t);
  await page.waitFor(() => document.querySelectorAll('.tabbar .tabbar__item').length === 4, { what: 'tab bar', timeout: 10000 });
  await until(() => srv.requests({ origin: 'ml', path: '/api/activity' }).length >= 1, 'first activity poll', 8000);
  const t0 = Date.now();
  const n0 = srv.requests({ origin: 'ml', path: '/api/activity' }).length;
  const idleCount = () => srv.requests({ origin: 'ml', path: '/api/activity' }).length - n0;
  await holds(() => idleCount() <= 1, 12000, `idle feed: at most one poll in 12 s (30 s cadence), got ${idleCount()}`);
  const idle = idleCount();
  t.log(`idle: ${idle} polls in ${Date.now() - t0} ms`);

  // moving: speed back on, a fresh start (reload) — the boot poll sees a live speed, so the 4 s cadence runs
  ml.activity.splice(0, ml.activity.length, ...saved);
  await page.reload();
  await page.waitFor(() => document.querySelectorAll('.tabbar .tabbar__item').length === 4, { what: 'tab bar after reload', timeout: 10000 });
  const n1 = srv.requests({ origin: 'ml', path: '/api/activity' }).length;
  await until(() => srv.requests({ origin: 'ml', path: '/api/activity' }).length > n1, 'the boot poll after reload', 8000);
  const n2 = srv.requests({ origin: 'ml', path: '/api/activity' }).length;
  const n2t = Date.now();
  const movingCount = () => srv.requests({ origin: 'ml', path: '/api/activity' }).length - n2;
  await until(() => movingCount() >= 2, 'two polls of a moving download (4 s cadence)', 12000);
  // …and no faster than ~4 s for the rest of the 12 s window
  await holds(() => movingCount() <= 4, 12000 - (Date.now() - n2t), 'moving download: at most 4 polls in 12 s');
  const moving = movingCount();
  t.log(`moving: ${moving} polls in 12 s`);
  assert(moving >= 2 && moving <= 4, `moving download: ~4 s cadence (2–4 polls in 12 s), got ${moving}`);
});
