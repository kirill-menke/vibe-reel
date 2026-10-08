/* Desktop web client: what opens over a page — the header's Accounts and
 * Notifications popovers, the library's Sort & filter dialog, a tile's
 * context menu (right-click) and the player (a fixture trailer; a Jellyfin
 * movie's start up to its first segment).
 * Each opens from a real mouse click, shows its content from the fake world,
 * closes with Esc, and leaves the page (route, address) as it was — or does
 * what its control says (a sort re-queries Jellyfin, Settings navigates).
 * UI-agnostic: roles + aria-labels (dialog, menu/menuitem, radio, the
 * player's role="application"), routes, requests. */
import { test, assert } from '../lib/runner.mjs';
import { movie, TICKS } from '../lib/world.mjs';
import { until } from '../lib/player.mjs';
import { bootWeb, waitRoute, webState, clickOn, webKey, dialogUp, dialogGone, menuItems } from '../lib/web.mjs';

const ACCOUNT_BTN = 'button[aria-label^="Account"]';
const BELL_BTN = 'button[aria-label^="Notifications"]';
/* anything that is not a read: a context menu, a popover or Esc must not change state */
const writes = (srv) => srv.log.filter((e) => e.method !== 'GET' && e.method !== 'HEAD' && e.method !== 'OPTIONS');

test('web popovers: the avatar opens Accounts (alice, Settings, Sign out); Esc closes it; its Settings row opens /settings', { app: 'web', fast: true }, async (t) => {
  const { page, srv } = t;
  await bootWeb(t);
  await waitRoute(page, 'home', { h1: 'Northern Line' });
  await clickOn(page, ACCOUNT_BTN, /alice/, { scope: 'doc' });
  await dialogUp(page, 'Accounts');
  const text = await page.eval(() => [...document.querySelectorAll('[role="dialog"]')].find((d) => d.checkVisibility()).innerText.replace(/\s+/g, ' '));
  for (const s of ['alice', 'Settings', 'Sign out']) assert(text.includes(s), `Accounts lists ${s}: ${text}`);
  assert.equal((await webState(page)).route, 'home', 'the page stays under the popover');

  await webKey(page, 'Escape');
  await dialogGone(page, 'Accounts');
  assert.equal((await webState(page)).path, '/', 'Esc only closed the popover');

  await clickOn(page, ACCOUNT_BTN, /alice/, { scope: 'doc' });
  await dialogUp(page, 'Accounts');
  await clickOn(page, 'button, a, [role="button"]', /^Settings$/, { scope: 'dialog' });
  await waitRoute(page, 'settings', { h1: 'Settings', path: '/settings' });
  await dialogGone(page, 'Accounts');
  assert.deepEqual(writes(srv).map((e) => e.method + ' ' + e.path), [], 'nothing written');
});

test('web popovers: the bell opens Notifications with the world\'s new seasons; Esc closes it', { app: 'web' }, async (t) => {
  const { page, srv } = t;
  const news = srv.world.ml.news;
  assert(news.length >= 2, 'the seed has news');
  await bootWeb(t);
  await waitRoute(page, 'home', { h1: 'Northern Line' });
  // the bell counts them once the news feed answered
  await page.waitFor(() => /new/.test(document.querySelector('button[aria-label^="Notifications"]')?.getAttribute('aria-label') || ''), { what: 'the bell counts unseen news', timeout: 10000 });
  await clickOn(page, BELL_BTN, /Notifications/, { scope: 'doc' });
  await dialogUp(page, 'Notifications');
  const text = await page.eval(() => [...document.querySelectorAll('[role="dialog"]')].find((d) => d.checkVisibility()).innerText.replace(/\s+/g, ' '));
  for (const n of news) assert(text.includes(n.title), `Notifications lists ${n.title}: ${text}`);
  await webKey(page, 'Escape');
  await dialogGone(page, 'Notifications');
  // opening marked everything seen
  await page.waitFor(() => document.querySelector('button[aria-label^="Notifications"]')?.getAttribute('aria-label') === 'Notifications', { what: 'the bell without a count', timeout: 5000 });
  assert.equal((await webState(page)).route, 'home');
});

test('web sort & filter: the library\'s sort control opens the dialog; Title + apply re-queries Jellyfin by SortName', { app: 'web' }, async (t) => {
  const { page, srv } = t;
  await bootWeb(t, { path: '/movies' });
  await waitRoute(page, 'movies', { h1: 'Movies' });
  await page.waitFor(() => document.querySelector('[role="toolbar"][aria-label="Sort and filter"] button'), { what: 'the sort control', timeout: 8000 });
  await clickOn(page, '[role="toolbar"][aria-label="Sort and filter"] button', /Recently added/);
  await dialogUp(page, 'Sort & filter');
  await clickOn(page, '[role="radio"]', /^Title$/, { scope: 'dialog' });
  await page.waitFor(() => [...document.querySelectorAll('[role="radio"]')].find((r) => r.textContent.trim() === 'Title')?.getAttribute('aria-checked') === 'true', { what: 'Title checked' });
  const before = srv.log.length;
  await clickOn(page, 'button', /^Show \d+ movies$/, { scope: 'dialog' });
  await dialogGone(page, 'Sort & filter');
  const q = await until(() => srv.log.slice(before).find((e) => e.origin === 'jf' && e.path === '/Items' && /IncludeItemTypes=Movie/.test(e.search) && /SortBy=SortName(&|$)/.test(e.search)), 'a /Items query sorted by SortName', 5000);
  assert(q, 'the grid re-queried /Items with SortBy=SortName');
  assert.equal((await webState(page)).route, 'movies', 'still the Movies grid');
});

test('web context menu: a right-click on a tile opens its menu (Open, Mark as watched …); Esc closes it without a write', { app: 'web', fast: true }, async (t) => {
  const { page, srv } = t;
  const m = movie(srv.world, 0);
  await bootWeb(t, { path: '/movies' });
  await waitRoute(page, 'movies', { h1: 'Movies' });
  await clickOn(page, '[role="button"], button, a', new RegExp('^' + m.Name), { button: 'right' });
  const items = await page.waitFor(() => {
    const m = [...document.querySelectorAll('[role="menu"]')].find((x) => x.checkVisibility());
    return m && [...m.querySelectorAll('[role="menuitem"]')].length && true;
  }, { what: 'a context menu', timeout: 5000 }).then(() => menuItems(page));
  t.log(JSON.stringify(items));
  assert(items.some((x) => /^Open/.test(x)), 'an Open item: ' + JSON.stringify(items));
  assert(items.some((x) => /watched/i.test(x)), 'a watched toggle: ' + JSON.stringify(items));
  assert.equal((await webState(page)).route, 'movies', 'the right-click did not open the title');
  await webKey(page, 'Escape');
  await page.waitFor(() => ![...document.querySelectorAll('[role="menu"]')].some((x) => x.checkVisibility()), { what: 'the menu closed', timeout: 5000 });
  const st = await webState(page);
  assert.equal(st.route, 'movies', 'still the grid');
  assert.equal(st.path, '/movies');
  assert.deepEqual(writes(srv).map((e) => e.method + ' ' + e.path), [], 'nothing written');
});

test('web trailer: Trailer on a movie plays the fixture through MSE in the player (titled "… · Trailer"); Esc closes it back onto the page; nothing reaches Jellyfin\'s play reports', { app: 'web', timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  assert(srv.media.trailer, 'fixture trailer HLS (ffmpeg): ' + (srv.media.error || 'missing'));
  const m = w.list('Movie').find((x) => (x.RemoteTrailers || []).length);
  const ytid = /v=([\w-]{11})/.exec(m.RemoteTrailers[0].Url)[1];
  w.ml.trailers.set(ytid, {});
  await bootWeb(t, { path: '/movie/' + m.Id });
  await waitRoute(page, 'detail', { h1: m.Name });
  await clickOn(page, 'button, a, [role="button"]', /^Trailer$/);
  await page.waitFor(() => {
    const p = document.querySelector('[role="application"][aria-label="Video player"]');
    const v = p?.querySelector('video');
    return p?.checkVisibility() && v && v.currentTime > 1 && !v.paused;
  }, { what: 'the trailer playing past 0:01', timeout: 20000 });
  const st = await webState(page);
  assert.equal(st.modal, 'player', 'the player is up');
  assert.match(await page.eval(() => document.querySelector('[role="application"] video').src), /^blob:/, 'a MediaSource');
  await page.waitFor((n) => document.title === n + ' · Trailer · VibeReel', { what: 'the tab names the trailer', timeout: 4000 }, m.Name);
  assert(w.ml.trailerFiles.length > 0, 'the fixture trailer was fetched');

  await webKey(page, 'Escape');
  await page.waitFor(() => !document.querySelector('[role="application"][aria-label="Video player"]')?.checkVisibility(), { what: 'the player closed', timeout: 8000 });
  const back = await waitRoute(page, 'detail', { h1: m.Name, path: '/movie/' + m.Id });
  assert.equal(back.modal, null, 'nothing over the page');
  await page.waitFor((n) => document.title === n + ' · VibeReel', { what: 'the tab names the page again', timeout: 4000 }, m.Name);
  assert.equal(srv.requests({ origin: 'jf', path: /^\/Sessions\/Playing/ }).length, 0, 'a trailer reports nothing to Jellyfin');
  assert.equal(await page.eval(() => document.querySelector('[role="application"] video').paused), true, 'the video stopped');
});

test('web play: Play on a movie asks PlaybackInfo with the web profile (MediaSourceId, no MKV DirectPlay) as "VibeReel Web", feeds main.m3u8 through MSE; Esc stops the job and reports Stopped', { app: 'web', timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const m = movie(w, 5);
  await bootWeb(t, { path: '/movie/' + m.Id });
  await waitRoute(page, 'detail', { h1: m.Name });
  // the fake has no transcoder: its segments would 404 — hold them, the player stays on its loading card
  const hold = srv.fault({ origin: 'jf', path: /^\/videos\/[^/]+\/hls1\//i }, { hang: true });
  const s0 = w.sessions.length;
  await clickOn(page, 'button, a, [role="button"]', /^(Play|Resume)$/);
  await page.waitFor(() => document.querySelector('[role="application"][aria-label="Video player"]')?.checkVisibility(), { what: 'the player', timeout: 8000 });

  const pi = await until(() => srv.requests({ origin: 'jf', method: 'POST', path: '/Items/' + m.Id + '/PlaybackInfo' })[0], 'PlaybackInfo', 8000);
  assert.equal(pi.auth.Client, 'VibeReel Web', 'as the web client');
  const b = srv.events.filter((e) => e.kind === 'playbackinfo' && e.itemId === m.Id).at(-1).body;
  assert.equal(b.MediaSourceId, m.MediaSources[0].Id, 'MediaSourceId sent');
  assert(!(b.DeviceProfile.DirectPlayProfiles || []).some((p) => /mkv|matroska/.test(p.Container || '')), 'the web profile does not DirectPlay MKV');
  /* jfhls.js reads the master once, as text, for its variant's codec string;
   * what it feeds is the media playlist, main.m3u8 — never a master the
   * browser could hop variants on (each hop restarts the server's job) */
  const m3u = await until(() => srv.requests({ origin: 'jf', path: new RegExp('^/videos/' + m.Id + '/main\\.m3u8$', 'i') })[0], 'main.m3u8', 8000);
  const sess = new URLSearchParams(m3u.search).get('PlaySessionId');
  assert(sess && w.playSessions.has(sess), 'main.m3u8 carries the PlaybackInfo session');
  assert.equal(new URLSearchParams(m3u.search).get('MediaSourceId'), m.MediaSources[0].Id, "the TranscodingUrl's query (MediaSourceId) kept");
  await until(() => hold.hits > 0, 'a segment request', 8000);
  assert.match(srv.log.find((e) => e.fault)?.path || '', /\/hls1\/main\//, 'segments come from the main playlist');
  assert(srv.requests({ origin: 'jf' }).filter((e) => /master\.m3u8$/i.test(e.path)).length <= 1, 'the master is read at most once (codecs)');
  assert.match(await page.eval(() => document.querySelector('[role="application"] video')?.src || ''), /^blob:/, 'the <video> plays a MediaSource, never a playlist URL');
  await page.waitFor((n) => document.title === n + ' · VibeReel' && history.state?.player === true, { what: 'the player\'s own history entry, titled after the movie', timeout: 4000 }, m.Name);

  await webKey(page, 'Escape');
  await page.waitFor(() => !document.querySelector('[role="application"][aria-label="Video player"]')?.checkVisibility(), { what: 'the player closed', timeout: 8000 });
  const stop = await until(() => w.sessions.slice(s0).find((x) => x.kind === 'stopped'), 'Stopped report', 8000);
  assert.equal(stop.body.PlaySessionId, sess, 'Stopped for that session');
  assert(stop.body.PositionTicks >= 0 && stop.body.PositionTicks < 5 * TICKS, 'closed before the first frame: position ~0: ' + stop.body.PositionTicks);
  await until(() => srv.requests({ origin: 'jf', method: 'DELETE', path: '/Videos/ActiveEncodings' }).length, 'the HLS job stopped (DELETE /Videos/ActiveEncodings)', 8000);
  hold.remove();
  const back = await waitRoute(page, 'detail', { h1: m.Name, path: '/movie/' + m.Id });
  assert.equal(back.modal, null, 'back on the page');
});
