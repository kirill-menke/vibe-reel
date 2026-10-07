/* Phone resilience (phone/src/lib/conn.svelte.js + OfflineBanner, homesnap.svelte.js,
 * restore.svelte.js):
 *  - a /jf outage raises "Not connected to your server" (one failed screen fetch
 *    → conn.noteError → /System/Info/Public); the banner's Retry while still down
 *    keeps it; the 20 s onReconnect timer clears it once the server answers, and
 *    the failed screen retries by itself (LoadError follows conn.offline);
 *    the browser's own offline/online events raise and clear it too;
 *  - Home opens on the last session's snapshot (reel.homeSnap.<userId>) with /jf
 *    down — the banner says "Showing what was loaded last." — and the live answer
 *    replaces it once the server is back;
 *  - state restore: a page hidden (saveRoute) and then killed without pagehide
 *    (iOS evicting the frozen app) comes back on the same route stack; a
 *    swipe-away (pagehide → closed) starts on Home; a restored title that left
 *    the library is cut with a toast (validate(): one /Items?Ids= at boot).
 *
 * Emulation: "hidden" is a real visibilitychange (the window minimised,
 * lib/phone.mjs setHidden). An eviction is a reload whose pagehide never reaches
 * the app: a listener installed before the app's own swallows it (see evict()). Killing the renderer instead
 * left the CDP session unusable (Page.navigate timed out after the crash). */
import { test, assert } from '../lib/runner.mjs';
import { bootPhone, openTab, setHidden, topHas, tapIn } from '../lib/phone.mjs';
import { until } from '../lib/player.mjs';

const NET_ERRORS = [/Failed to load resource: net::ERR_EMPTY_RESPONSE/];
// the restored page of the removed title asks for it once before validate() cuts it
const GONE_404 = [/^Failed to load resource: the server responded with a status of 404 \(Not Found\) http:\/\/127\.0\.0\.1:\d+\/jf\/Items\/[0-9a-f]{32}\?userId=[0-9a-f]{32}$/];
const HTTP_503 = [/Failed to load resource: the server responded with a status of 503/];

const banner = (page) => page.eval(() => {
  const b = document.querySelector('.banner[role="status"]');
  return b && b.checkVisibility() ? b.textContent.replace(/\s+/g, ' ').trim() : null;
});
const waitBanner = (page, on, timeout = 10000) => page.waitFor((on) => {
  const b = document.querySelector('.banner[role="status"]');
  return on ? !!b && b.checkVisibility() : !b;
}, { what: on ? 'offline banner up' : 'offline banner gone', timeout }, on);

/* the visible Home rails: title → tile count */
const rails = (page) => page.eval(() => Object.fromEntries(
  [...document.querySelectorAll('.rail')].filter((r) => r.checkVisibility()).map((r) => [
    r.querySelector('.rail__title')?.firstChild?.textContent?.trim() || r.getAttribute('aria-label'),
    r.querySelectorAll('.rail__track > *').length
  ])
));
const cwCount = (page, n, what, timeout = 10000) => page.waitFor((n) => {
  const r = [...document.querySelectorAll('.rail')].find((r) => r.checkVisibility() && /Continue Watching/.test(r.querySelector('.rail__title')?.textContent || ''));
  const c = r ? r.querySelectorAll('.rail__track > *').length : -1;
  return c === n ? c : null;
}, { what, timeout }, n);

const movieGrid = (page) => page.waitFor(() => {
  const g = [...document.querySelectorAll('.screen.lib .lib__grid')].find((x) => x.checkVisibility());
  return g && g.querySelectorAll('.tile[role="button"]').length >= 12;
}, { what: 'movie grid', timeout: 10000 });

/* tap the visible grid tile labelled name */
async function tapTile(page, name) {
  const p = await page.waitFor((name) => {
    const el = [...document.querySelectorAll('.screen.lib .lib__grid .tile[role="button"]')].find((e) => e.checkVisibility() && e.getAttribute('aria-label') === name);
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    return b.width ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
  }, { what: 'tile ' + name, timeout: 10000 }, name);
  await page.tap(p.x, p.y);
}

/* the top visible route: key, detail title, whether it holds a library grid */
const top = (page) => page.eval(() => {
  const r = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility());
  const t = r[r.length - 1];
  return t ? { key: t.dataset.key, title: t.querySelector('.detail__title')?.textContent.trim() || null, grid: !!t.querySelector('.lib__grid') } : null;
});
const atGrid = (page, what) => page.waitFor(() => {
  const r = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1);
  return !!r?.querySelector('.lib__grid') && !r.querySelector('.detail__title') && !document.querySelector('.zoom-art');
}, { what, timeout: 8000 });

const routeSnap = (page) => page.eval(() => JSON.parse(localStorage.getItem('reel.route') || 'null'));

/* iOS evicts the frozen app: the document goes away and no pagehide reaches it.
 * A listener installed before the app's own (addScriptToEvaluateOnNewDocument:
 * runs before any page script) swallows pagehide while window.__e2eEvict is set —
 * the at-target capture-first order does NOT hold here (measured: a capture
 * listener added after lifecycle.js's bubble one ran second). */
const EVICT_HOOK = `window.addEventListener('pagehide', (e) => { if (window.__e2eEvict) e.stopImmediatePropagation(); }, true);`;
const installEvictHook = (page) => page.s.send('Page.addScriptToEvaluateOnNewDocument', { source: EVICT_HOOK });
async function evict(page) {
  await page.eval(() => (window.__e2eEvict = true));
  await page.reload();
}

test('phone resilience: a /jf outage raises the offline banner (Retry keeps it while down); the 20 s timer clears it and the failed grid retries itself; offline/online events', { app: 'phone', timeout: 90000, allowErrors: NET_ERRORS }, async (t) => {
  const { page, srv } = t;
  await bootPhone(t);
  await cwCount(page, 3, 'Home live');
  assert.equal(await banner(page), null, 'no banner while the server answers');

  // the server goes away (connection dropped, no answer): the next screen fetch fails
  const down = srv.fault({ origin: 'jf' }, { drop: true });
  await openTab(page, 'Movies');
  await waitBanner(page, true);
  const text = await banner(page);
  assert(/^Not connected to your server/.test(text), 'banner title: ' + text);
  assert(srv.requests({ origin: 'jf', path: '/System/Info/Public' }).some((e) => e.fault), 'the check pinged /System/Info/Public');
  await page.waitFor(() => {
    const r = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1);
    return r && [...r.querySelectorAll('button')].some((b) => b.checkVisibility() && /Retry/.test(b.textContent));
  }, { what: 'the Movies grid shows its error card with Retry' });

  // the banner's Retry while still down: a new ping, then the banner stays
  const pings0 = srv.requests({ origin: 'jf', path: '/System/Info/Public' }).length;
  await tapIn(page, '.banner button', /^Retry$/, { scope: 'doc' });
  await until(() => srv.requests({ origin: 'jf', path: '/System/Info/Public' }).length > pings0, 'Retry pinged the server', 5000);
  await page.waitFor(() => [...document.querySelectorAll('.banner button')].some((b) => /^Retry$/.test(b.textContent.trim()) && !b.disabled), { what: 'Retry enabled again' });
  assert(await banner(page), 'still offline after a failed Retry');

  // the server is back: nothing is tapped — the 20 s reconnect tick clears the banner
  down.remove();
  const t0 = Date.now();
  await waitBanner(page, false, 25000);
  const took = Date.now() - t0;
  t.log('banner cleared after ' + took + ' ms');
  assert(took <= 23000, 'cleared by the 20 s timer: ' + took);
  // …and the grid's error card retried at once (it follows conn.offline)
  await movieGrid(page);

  // the browser's own network events: offline raises it at once, online re-checks (1.5 s settle)
  await page.s.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await waitBanner(page, true, 3000);
  await page.s.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await waitBanner(page, false, 6000);
});

test('phone resilience: Home paints the last snapshot with /jf down ("Showing what was loaded last."); the live answer replaces it when the server is back', { app: 'phone', timeout: 60000, allowErrors: HTTP_503 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  await bootPhone(t);
  const uid = await page.eval(() => localStorage.getItem('reel.userId'));
  await cwCount(page, 3, 'Home live with 3 Continue Watching tiles');
  const live = await rails(page);
  t.log('live rails ' + JSON.stringify(live));
  // saveHome is debounced 1.5 s after the live load
  const snap = await page.waitFor((k) => {
    const s = JSON.parse(localStorage.getItem(k) || 'null');
    return s && s.entries?.length ? { n: s.entries.length, len: JSON.stringify(s).length } : null;
  }, { what: 'reel.homeSnap saved', timeout: 6000 }, 'reel.homeSnap.' + uid);
  t.log('snapshot ' + JSON.stringify(snap));

  // meanwhile one of them is finished elsewhere: the live answer has 2 now
  const cw = [...w.userData.entries()].filter(([k, v]) => k.startsWith(uid + ':') && v.PlaybackPositionTicks > 0 && !v.Played).map(([k]) => w.items.get(k.split(':')[1])).filter((it) => it?.Type === 'Movie');
  assert(cw.length >= 1, 'a resumable movie in the seed');
  Object.assign(w.userData.get(uid + ':' + cw[0].Id), { PlaybackPositionTicks: 0, Played: true, PlayCount: 1 });

  // cold start with the server answering 503 to everything under /jf
  const down = srv.fault({ origin: 'jf' }, { status: 503, text: 'Service Unavailable' });
  const n0 = srv.log.length;
  await page.reload();
  await cwCount(page, 3, 'Continue Watching painted from the snapshot', 5000);
  const painted = await rails(page);
  t.log('snapshot rails ' + JSON.stringify(painted));
  for (const k of Object.keys(live)) if (/Continue Watching|Next Up/.test(k)) assert.equal(painted[k], live[k], k + ' painted as last session');
  await waitBanner(page, true);
  const text = await banner(page);
  assert(/Showing what was loaded last\./.test(text), 'banner says it shows the snapshot: ' + text);
  assert(srv.log.slice(n0).some((e) => e.origin === 'jf' && e.path === '/UserItems/Resume' && e.fault), 'the live Resume request went out (and failed)');

  // the server is back: the banner's Retry finds it, and Home loads live
  down.remove();
  await tapIn(page, '.banner button', /^Retry$/, { scope: 'doc' });
  await waitBanner(page, false, 8000);
  await cwCount(page, 2, 'the live answer replaced the snapshot (2 tiles)', 10000);
});

test('phone resilience: state restore — an evicted app comes back on its route stack; a swipe-away starts on Home; a title gone from the library is cut with a toast', { app: 'phone', timeout: 90000, allowErrors: GONE_404 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  await installEvictHook(page);
  await bootPhone(t);
  const movies = w.list('Movie').slice().sort((a, b) => (a.DateCreated < b.DateCreated ? 1 : -1));

  // 1. Movies → a detail page; the app goes to the background (saveRoute) and is evicted
  await openTab(page, 'Movies');
  await movieGrid(page);
  const m = movies[1];
  await tapTile(page, m.Name);
  await topHas(page, '.detail__title');
  assert.equal((await top(page)).title, m.Name, 'detail open');
  await setHidden(page, true);
  const s = await routeSnap(page);
  t.log('reel.route ' + JSON.stringify(s));
  assert.equal(s.tab, 'movies', 'saved tab');
  assert.deepEqual(s.stacks.movies?.routes?.map((r) => [r.name, r.params.id]), [['detail', m.Id]], 'saved the detail route');
  assert(!s.closed, 'not marked closed by a hide');

  const n0 = srv.log.length;
  await evict(page);
  await setHidden(page, false);
  await page.waitFor((title) => {
    const r = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility());
    return r.at(-1)?.querySelector('.detail__title')?.textContent.trim() === title;
  }, { what: 'restored detail page', timeout: 10000 }, m.Name);
  const check = await until(() => srv.log.slice(n0).find((e) => e.origin === 'jf' && e.path === '/Items' && new URLSearchParams(e.search).get('Ids')), 'validate(): /Items?Ids= at boot', 8000);
  assert.equal(new URLSearchParams(check.search).get('Ids').toLowerCase(), m.Id.toLowerCase(), 'validated the restored id');
  // the stack under it was rebuilt: Back lands on the Movies grid
  await tapIn(page, '.iconbtn', /^Back/);
  await atGrid(page, 'Back to the Movies grid');
  assert.equal(await page.eval(() => document.querySelector('.tabbar__item[aria-current="page"]')?.textContent.trim()), 'Movies', 'Movies tab current');

  // 2. a swipe-away (pagehide reaches the app → closed): the next start is Home
  await tapTile(page, m.Name);
  await topHas(page, '.detail__title');
  await page.reload();
  await page.waitFor(() => document.querySelector('.tabbar__item[aria-current="page"]')?.textContent.trim() === 'Home', { what: 'Home tab after a swipe-away', timeout: 10000 });
  const after = await top(page);
  assert(!after.title, 'no restored detail after a swipe-away: ' + JSON.stringify(after));
  assert((await routeSnap(page)).closed > 0 || !(await routeSnap(page)).stacks.movies, 'the snapshot was marked closed (or replaced by the fresh start)');

  // 3. the title leaves the library while the app sleeps: cut, with a toast, on the grid
  await openTab(page, 'Movies');
  await movieGrid(page);
  const gone = movies[2];
  await tapTile(page, gone.Name);
  await topHas(page, '.detail__title');
  await setHidden(page, true);
  w.items.delete(gone.Id);
  await evict(page);
  await setHidden(page, false);
  await page.waitFor(() => /isn.t in your library any more/.test(document.querySelector('.toast__text')?.textContent || ''), { what: 'toast: title not in the library', timeout: 10000 });
  await atGrid(page, 'cut back to the Movies grid');
});
