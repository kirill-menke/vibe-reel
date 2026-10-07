/* TV tab-row bell + avatar (TopNav.svelte, news.svelte.js, landed.svelte.js,
 * account.svelte.js). The bell's count is the unseen /api/news seasons plus the
 * unseen "Ready to watch" landings; opening it marks both seen (per Jellyfin
 * user, reel.newsSeen / reel.landed, surviving a restart). An aired season has
 * a Get button (POST /api/news/search) whose row then follows the live activity
 * feed; an upcoming one shows its premiere date. A landing is a grab that left
 * the activity feed AND is found in Jellyfin (search + matchGroup, 4 s after the
 * feed changed). The avatar lists reel.accounts and swaps in Settings. */
import { test, assert } from '../lib/runner.mjs';
import { landImport, addPending } from '../lib/world.mjs';
import { bootTv, waitSplashGone, waitFocus, focused, steer, checkFocusInvariants } from '../lib/tv.mjs';

const bellCount = (page) => page.eval(() => document.querySelector('[data-focus="nav-news"] .hcount')?.textContent.trim() || '');

const menuRows = (page) => page.eval(() => [...document.querySelectorAll('.screen .lvmenu .nwrow')].map((r) => ({
  keys: [...r.querySelectorAll('[data-focus]')].map((e) => e.dataset.focus),
  title: r.querySelector('.nwtitle')?.textContent.trim(),
  season: r.querySelector('.nwseason')?.textContent.trim(),
  line: r.querySelector('.nwline')?.textContent.trim(),
  get: r.querySelector('.nwget')?.textContent.trim() || null,
  fresh: r.classList.contains('fresh')
})));

const caps = (page) => page.eval(() => [...document.querySelectorAll('.screen .lvmenu .lvcap')].map((e) => e.textContent.trim()));

/* news.svelte.js's day(): "Jul 9" this year, "Jul 9, 2027" otherwise — computed in
 * the page (its time zone) from the world's ISO date, not from the app's output */
const day = (page, iso) => page.eval((iso) => {
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = new Date(iso);
  const s = MON[d.getMonth()] + ' ' + d.getDate();
  return d.getFullYear() === new Date().getFullYear() ? s : s + ', ' + d.getFullYear();
}, iso);

const lsJson = (page, k) => page.eval((k) => JSON.parse(localStorage.getItem(k) || 'null'), k);

/* a condition on the server side (the fake's world / request log) */
async function until(fn, what, timeout = 8000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeout) throw new Error('timed out after ' + timeout + ' ms: ' + what);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function toButton(page, key) {
  await waitFocus(page, 'tab-home', 10000);
  await steer(page, key, { settle: 150 });
}


test('tv bell: new-season count, aired + upcoming rows, opening marks seen (per user, survives reload), Get → live activity, Back onto the bell', { fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const [aired, upcoming] = w.ml.news;
  assert.equal(aired.kind, 'aired');
  assert.equal(upcoming.kind, 'upcoming');
  const alice = [...w.users.values()].find((u) => u.Name === 'alice');

  await bootTv(t);
  await page.waitFor(() => document.querySelector('[data-focus="nav-news"] .hcount')?.textContent.trim() === '2', { what: 'bell count 2 (both news items unseen)', timeout: 10000 });
  assert(srv.requests({ origin: 'ml', method: 'GET', path: '/api/news' }).length >= 1, 'the feed came from reel-api /api/news');

  await t.step('OK opens the menu on the first season; rows, lines, Get only on the aired one', async () => {
    await toButton(page, 'nav-news');
    await page.key('OK', { settle: 300 });
    await waitFocus(page, 'nw-' + aired.id);
    assert.deepEqual(await caps(page), ['New seasons'], 'no "Ready to watch" section without landings');
    const rows = await menuRows(page);
    t.log('rows: ' + JSON.stringify(rows));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0].keys, ['nw-' + aired.id, 'nw-get-' + aired.id], 'aired row: main + Get');
    assert.equal(rows[0].title, aired.title);
    assert.equal(rows[0].season, 'Season 5');
    assert.equal(rows[0].line, `Out since ${await day(page, aired.premiere)} · 4 of 8 episodes`);
    assert.equal(rows[0].get, 'Get');
    assert.deepEqual(rows[1].keys, ['nw-' + upcoming.id], 'upcoming row: no Get');
    assert.equal(rows[1].title, upcoming.title);
    assert.equal(rows[1].season, 'Season 4Upcoming');
    assert.equal(rows[1].line, `Premieres ${await day(page, upcoming.premiere)}`);
    assert(rows.every((r) => r.fresh), 'both rows were new when the menu opened');
    assert.equal(await bellCount(page), '', 'count dropped to 0');
    const seen = await lsJson(page, 'reel.newsSeen');
    assert.deepEqual(Object.keys(seen), [alice.Id], 'seen list keyed by the Jellyfin user');
    assert.deepEqual([...seen[alice.Id]].sort(), [aired.id, upcoming.id].sort());
    assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants in the open menu');
  });

  await t.step('Get → POST /api/news/search {id, season}; Searching…; the grab shows up as live activity', async () => {
    await steer(page, 'nw-get-' + aired.id, { settle: 150 });
    await page.key('OK', { settle: 300 });
    await until(() => w.ml.searches.length === 1, 'the season search reached reel-api', 5000);
    const s = w.ml.searches[0];
    assert.equal(s.id, aired.media_id, 'body id = the series tvdb id');
    assert.equal(s.season, 5, 'body season');
    assert.equal(srv.requests({ origin: 'ml', method: 'POST', path: '/api/news/search' }).length, 1, 'one POST');
    assert(aired.monitored, 'the fake monitored the season');
    await page.waitFor((id) => {
      const r = document.querySelector(`[data-focus="nw-get-${id}"]`)?.closest('.nwrow');
      return r && r.querySelector('.nwget')?.textContent.trim() === 'Searching…' && r.querySelector('.nwline')?.textContent.trim() === 'Searching the indexers…';
    }, { what: 'Searching… state', timeout: 4000 }, aired.id);
    assert.equal(await focused(page), 'nw-get-' + aired.id, 'focus stays on the (now status) button');
    // Sonarr grabs an episode of that season: the activity feed has it on the next poll
    addPending(w, { id: 'q-tv-hs-5-1', type: 'tv', media_id: aired.media_id, season: 5, episode: 1, episode_title: 'Return', progress: 0.12, size_bytes: 1_900_000_000, timeleft: '0:20:00', speed: 3_000_000, download_id: 'c'.repeat(40) });
    await page.waitFor((id) => {
      const r = document.querySelector(`[data-focus="nw-get-${id}"]`)?.closest('.nwrow');
      return r && r.querySelector('.nwget')?.textContent.trim() === 'Found' && r.querySelector('.nwline')?.textContent.trim() === 'Found — Downloading · 12%';
    }, { what: 'row follows the activity feed', timeout: 10000 }, aired.id);
    w.ml.activity.at(-1).progress = 0.5;
    await page.waitFor((id) => document.querySelector(`[data-focus="nw-get-${id}"]`)?.closest('.nwrow')?.querySelector('.nwline')?.textContent.trim() === 'Found — Downloading · 50%', { what: 'next poll moves the %', timeout: 10000 }, aired.id);
  });

  await t.step('Back closes the menu onto the bell', async () => {
    await page.key('Back', { settle: 300 });
    assert(!(await page.eval(() => document.querySelector('.lvmenu'))), 'menu closed');
    assert.equal(await focused(page), 'nav-news');
  });

  await t.step('seen survives a restart; a premiere (upcoming → aired, new id) re-notifies', async () => {
    const newsGets = () => srv.requests({ origin: 'ml', method: 'GET', path: '/api/news' }).filter((e) => e.status === 200).length;
    const n0 = newsGets();
    await page.goto(srv.urls.tv + '/index.html');
    await waitSplashGone(page);
    await waitFocus(page, 'tab-home', 10000);
    await until(() => newsGets() > n0, 'the news feed polled after the restart');
    await page.frames(10);
    assert.equal(await bellCount(page), '', 'nothing unseen after the restart');

    upcoming.kind = 'aired';
    upcoming.id = upcoming.media_id + ':4:aired';
    Object.assign(upcoming, { premiere: new Date(Date.now() - 86_400_000).toISOString(), episodes_aired: 1, monitored: false });
    await page.goto(srv.urls.tv + '/index.html');
    await waitSplashGone(page);
    await page.waitFor(() => document.querySelector('[data-focus="nav-news"] .hcount')?.textContent.trim() === '1', { what: 'the premiere counts again', timeout: 10000 });
    const seen = (await lsJson(page, 'reel.newsSeen'))[alice.Id];
    assert.deepEqual(seen, [aired.id], 'the seen id that left the feed was forgotten');
  });
});

test('tv bell: Ready to watch — an import that lands in Jellyfin appears as ld-<id>, counts, opens MovieDetail; avatar lists accounts and swaps in Settings', { fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const alice = [...w.users.values()].find((u) => u.Name === 'alice');

  await bootTv(t);
  await page.waitFor(() => document.querySelector('[data-focus="nav-news"] .hcount')?.textContent.trim() === '2', { what: 'bell count 2', timeout: 10000 });
  // the baseline snapshot needs one activity answer before the grab leaves
  await until(() => srv.requests({ origin: 'ml', path: '/api/activity' }).some((e) => e.status === 200), 'first activity answer');

  let item;
  await t.step('the grab leaves the feed + Jellyfin gains the title → bell count 3 after the landed check', async () => {
    item = landImport(w, 'q-movie-900001');
    const t1 = Date.now();
    await page.waitFor(() => document.querySelector('[data-focus="nav-news"] .hcount')?.textContent.trim() === '3', { what: 'bell count 3', timeout: 20000 });
    t.log('landed after ' + (Date.now() - t1) + ' ms');
    const q = srv.requests({ origin: 'jf', path: /^\/Items$/ }).map((e) => new URLSearchParams(e.search)).find((p) => p.get('SearchTerm') === 'Glass Meridian Rising');
    assert(q, 'Jellyfin searched for the title');
    assert.equal(q.get('IncludeItemTypes'), 'Movie');
    const stored = (await lsJson(page, 'reel.landed'))[alice.Id];
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, item.Id);
    assert.equal(stored[0].seen, false);
  });

  await t.step('the bell opens on the landing, above New seasons; opening marks it seen', async () => {
    await toButton(page, 'nav-news');
    await page.key('OK', { settle: 300 });
    await waitFocus(page, 'ld-' + item.Id);
    assert.deepEqual(await caps(page), ['Ready to watch', 'New seasons']);
    const rows = await menuRows(page);
    assert.deepEqual(rows[0].keys, ['ld-' + item.Id]);
    assert.equal(rows[0].title, 'Glass Meridian Rising');
    assert.equal(rows[0].season, 'Movie · 2024');
    assert.equal(rows[0].line, 'Added just now');
    assert(rows[0].fresh, 'the landing was new');
    assert.equal(await bellCount(page), '');
    assert.equal((await lsJson(page, 'reel.landed'))[alice.Id][0].seen, true, 'seen persisted');
    assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants');
  });

  await t.step('OK opens the Jellyfin MovieDetail of the landed item', async () => {
    await page.key('OK', { settle: 400 });
    await waitFocus(page, 'play', 10000);
    assert.equal(await page.eval(() => document.querySelector('.screen .hero .title')?.textContent.trim()), 'Glass Meridian Rising');
    assert(!(await page.eval(() => document.querySelector('.lvmenu'))), 'the menu did not follow onto the detail');
    await page.key('Back', { settle: 500 });
    await page.waitFor(() => document.querySelector('.screen.home'), { what: 'Home after Back', timeout: 8000 });
    await page.waitFor(() => document.activeElement && document.activeElement !== document.body, { what: 'focus restored on Home' });
  });

  await t.step('avatar: the account list (reel.accounts) opens on the current account', async () => {
    for (let i = 0; i < 6 && !(await focused(page)).startsWith('tab-') && !(await focused(page)).startsWith('nav-'); i++) await page.key('Up', { settle: 250 });
    await steer(page, 'nav-account', { settle: 150 });
    await page.key('OK', { settle: 300 });
    await waitFocus(page, 'ac-' + alice.Id);
    // My library (46-tv-mylibrary) pops in once GET /api/me answered
    await page.waitFor(() => document.querySelector('[data-focus="ac-mylib"]'), { what: 'the My library row', timeout: 8000 });
    const rows = await page.eval(() => [...document.querySelectorAll('.screen .lvmenu.account .focus')].map((e) => [e.dataset.focus, e.textContent.trim(), e.classList.contains('sel')]));
    assert.deepEqual(rows.map((r) => r[0]), ['ac-' + alice.Id, 'ac-add', 'ac-mylib', 'ac-settings', 'ac-out']);
    assert.equal(rows[0][1], 'alice');
    assert(rows[0][2], 'the current account is marked');
    assert.equal(rows[2][1], 'My libraryAdmin · no limit', 'alice is an admin');
    assert.equal(rows[4][1], 'Sign out alice');
    const acc = await lsJson(page, 'reel.accounts');
    assert.deepEqual(acc.map((a) => [a.userId, a.userName, a.server]), [[alice.Id, 'alice', srv.urls.jf]], 'rememberCurrent stored the boot session');
    // OK on the current account just closes the menu onto the avatar
    await page.key('OK', { settle: 300 });
    assert(!(await page.eval(() => document.querySelector('.lvmenu'))), 'OK on the current account closed the menu');
    assert.equal(await focused(page), 'nav-account');
  });

  await t.step('Settings swaps in for the account list (set-audioLang focused); Back closes onto the avatar', async () => {
    await page.key('OK', { settle: 300 });
    await waitFocus(page, 'ac-' + alice.Id);
    await steer(page, 'ac-settings', { settle: 150 });
    await page.key('OK', { settle: 300 });
    await waitFocus(page, 'set-audioLang');
    assert(!(await page.eval(() => document.querySelector('.lvmenu.account'))), 'the account list was swapped out');
    assert((await page.eval(() => [...document.querySelectorAll('.screen .lvmenu .focus')].every((e) => e.dataset.focus.startsWith('set-')))), 'only settings rows in the open menu');
    assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants in Settings');
    await page.key('Back', { settle: 300 });
    assert(!(await page.eval(() => document.querySelector('.lvmenu'))), 'Back closed Settings');
    assert.equal(await focused(page), 'nav-account');
  });
});
