/* Phone detail pages and the player modal up to its loading card
 * (phone/src/screens/MovieDetail.svelte, SeriesDetail.svelte, player/Player.svelte,
 * src/lib/player.svelte.js's __PHONE__ start path):
 *  - a grid tile zooms into its detail page; an edge swipe pops it back;
 *  - series detail: season pills and episode rows from /Shows/{id}/Seasons|Episodes;
 *  - Play: PlaybackInfo with MediaSourceId + SubtitleStreamIndex -1 and the
 *    phone profile (no MKV DirectPlay) → the fake's HLS TranscodingUrl → the
 *    player loads …/main.m3u8 with the master's own query and NEVER master.m3u8
 *    (CLAUDE.md: Safari hops variants and each hop restarts the server job);
 *  - closing the modal while it loads sends Stopped for that session.
 * The fake has no transcoder: its HLS segments are held (a hanging fault), so
 * the player stays on its loading card — requests and UI state are asserted,
 * not frames. */
import { test, assert } from '../lib/runner.mjs';
import { bootPhone, topRoute, openTab } from '../lib/phone.mjs';
import { sleep } from '../lib/page.mjs';
import { until } from '../lib/player.mjs';
import { TICKS } from '../server/seed.mjs';

/* tap the visible grid tile whose aria-label is name */
async function tapTile(page, name) {
  const p = await page.waitFor((name) => {
    const el = [...document.querySelectorAll('.screen.lib .lib__grid .tile[role="button"]')].find((e) => e.checkVisibility() && e.getAttribute('aria-label') === name);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return b.width && b.top >= 0 && b.bottom <= innerHeight ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
  }, { what: 'tile ' + name, timeout: 10000 }, name);
  await page.tap(p.x, p.y);
}

/* the top route is a settled detail page: no zoom overlay or route animation left */
const detailSettled = (page, title) => page.waitFor((title) => {
  const r = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility());
  const top = r[r.length - 1];
  if (!top || !/^detail-/.test(top.dataset.key)) return null;
  if (document.querySelector('.zoom-art') || top.classList.contains('zoom-card') || top.classList.contains('zoom-hide')) return null;
  if (top.getAnimations({ subtree: true }).some((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity)) return null;
  const h = top.querySelector('.detail__title')?.textContent.trim();
  return h === title && top.dataset.key;
}, { what: 'detail page settled: ' + title, timeout: 10000 }, title);

async function tapButton(page, scope, re) {
  const p = await page.waitFor((scope, src) => {
    const r = [...document.querySelectorAll(scope)].filter((e) => e.checkVisibility());
    const root = r[r.length - 1];
    const el = root && [...root.querySelectorAll('button, [role="button"]')].find((b) => b.checkVisibility() && new RegExp(src).test(b.textContent.trim()));
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    return b.width ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
  }, { what: 'button ' + re }, scope, re.source);
  await page.tap(p.x, p.y);
}

test('phone detail: a grid tile zooms into MovieDetail; Play loads main.m3u8 (never master) with the phone profile; Close sends Stopped; edge swipe pops', { app: 'phone', fast: true, timeout: 60000, allowErrors: [/Ignored attempt to cancel a touchmove event with cancelable=false/] }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  await bootPhone(t);
  await openTab(page, 'Movies');
  await page.waitFor(() => document.querySelectorAll('.screen.lib .lib__grid .tile[role="button"]').length >= 12, { what: 'grid', timeout: 10000 });
  const movie = w.list('Movie').slice().sort((a, b) => (a.DateCreated < b.DateCreated ? 1 : -1))[0];
  const rootKey = await topRoute(page);
  await tapTile(page, movie.Name);
  const key = await detailSettled(page, movie.Name);
  assert(srv.requests({ origin: 'jf', path: '/Items/' + movie.Id }).length + srv.requests({ origin: 'jf', path: '/Users/' }).filter((e) => e.path.endsWith('/Items/' + movie.Id)).length >= 1, 'detail fetched the item');

  // segments never answer: the player has to stay on its loading card
  const hold = srv.fault({ origin: 'jf', path: /^\/videos\/[^/]+\/hls1\//i }, { hang: true });
  const s0 = w.sessions.length;
  await tapButton(page, '.route', /^(Play|Resume)$/);
  await page.waitFor(() => document.querySelector('.vr-pload--show') && document.querySelector('.player')?.checkVisibility(), { what: 'player loading card', timeout: 8000 });
  assert.equal(await page.eval(() => document.querySelector('.vr-pload .pload__title')?.textContent.trim()), movie.Name, 'loading card names the movie');

  const pi = await until(() => srv.requests({ origin: 'jf', method: 'POST', path: '/Items/' + movie.Id + '/PlaybackInfo' })[0], 'PlaybackInfo');
  const ev = srv.events.filter((e) => e.kind === 'playbackinfo' && e.itemId === movie.Id).at(-1);
  const b = ev.body;
  assert.equal(b.MediaSourceId, movie.MediaSources[0].Id, 'MediaSourceId sent');
  assert.equal(b.SubtitleStreamIndex, -1, 'SubtitleStreamIndex -1 (subs never ride in the HLS)');
  assert(!(b.DeviceProfile.DirectPlayProfiles || []).some((p) => /mkv|matroska/.test(p.Container || '')), 'phone profile does not DirectPlay MKV');
  assert(pi.auth?.Device === 'iPhone', 'iPhone auth header');

  const m3u = await until(() => srv.requests({ origin: 'jf', path: /^\/videos\/[^/]+\/\w+\.m3u8$/i })[0], 'an HLS playlist request', 8000);
  assert.equal(m3u.path.toLowerCase(), ('/videos/' + movie.Id + '/main.m3u8').toLowerCase(), 'the first playlist is main.m3u8');
  const sess = new URLSearchParams(m3u.search).get('PlaySessionId');
  assert(sess && w.playSessions.has(sess), 'main.m3u8 carries the PlaybackInfo session');
  assert.equal(new URLSearchParams(m3u.search).get('MediaSourceId'), movie.MediaSources[0].Id, "the master's query (MediaSourceId) kept");
  await until(() => hold.hits > 0, 'a segment request', 8000);
  await sleep(500);
  const masters = srv.requests({ origin: 'jf' }).filter((e) => /master\.m3u8$/i.test(e.path));
  assert.deepEqual(masters.map((e) => e.path), [], 'master.m3u8 is never loaded');
  assert.equal(await page.eval(() => !!document.querySelector('.vr-pload--show')), true, 'still on the loading card');

  // close (the busy-state X over the loading card)
  await page.tapSel('.vr-busytop .iconbtn');
  await page.waitFor(() => !document.querySelector('.player')?.checkVisibility() || !document.querySelector('.vr-pload--show'), { what: 'player closed', timeout: 8000 });
  const stop = await until(() => w.sessions.slice(s0).find((s) => s.kind === 'stopped'), 'Stopped report', 8000);
  assert.equal(stop.body.PlaySessionId, sess, 'Stopped for that session');
  assert.equal(stop.body.ItemId, movie.Id);
  assert(stop.body.PositionTicks >= 0 && stop.body.PositionTicks < 5 * TICKS, 'closed before the first frame: position ~0, not garbage: ' + stop.body.PositionTicks);
  t.log('reports: ' + JSON.stringify(w.sessions.slice(s0).map((s) => s.kind)));
  hold.remove();

  // back on the detail page; an edge swipe pops it to the grid
  await detailSettled(page, movie.Name);
  assert.equal(await topRoute(page), key, 'the same detail page under the closed player');
  // Chrome's touch emulation delivers this swipe's touchmoves uncancelable (measured: every one,
  // even the first, with the stage's non-passive listener) and logs an intervention per
  // preventDefault; the gesture still pops. Allowed for this test only (allowErrors).
  await page.swipe(4, 150, 330, 150, { steps: 12, ms: 260 });
  await page.waitFor((k) => {
    const r = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility());
    return r.length && r[r.length - 1].dataset.key === k && !document.querySelector('.zoom-art');
  }, { what: 'popped to the grid', timeout: 8000 }, rootKey);
});

/* the visible series page: pills and episode rows */
const seriesView = (page) => page.eval(() => {
  const r = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility());
  const top = r[r.length - 1];
  return {
    pills: [...top.querySelectorAll('.pills .pill')].map((p) => ({ text: p.textContent.trim(), active: p.classList.contains('pill--active'), dim: p.classList.contains('pill--dim') })),
    rows: [...top.querySelectorAll('.episode')].filter((e) => !e.classList.contains('episode--preview') && e.checkVisibility()).map((e) => ({ num: e.querySelector('.episode__num')?.textContent.trim() || '', title: e.querySelector('.episode__title')?.textContent.trim(), disabled: e.getAttribute('aria-disabled') === 'true', watched: !!e.querySelector('.tick') }))
  };
});

test('phone detail: series page shows the start season’s episodes, season pills switch the list (with the pending S03E07 row); an episode row plays via main.m3u8', { app: 'phone', timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  await bootPhone(t);
  const uid = await page.eval(() => localStorage.getItem('reel.userId'));
  const nl = w.byName('Series', 'Northern Line');
  const seasons = nl.childIds.map((id) => w.items.get(id));
  const start = Math.max(0, seasons.findIndex((s) => !seasons.length || !s.childIds.every((e) => w.userData.get(uid + ':' + e)?.Played)));
  const epNames = (s) => s.childIds.map((id) => w.items.get(id)).sort((a, b) => a.IndexNumber - b.IndexNumber).map((e) => e.Name);

  await openTab(page, 'Shows');
  await page.waitFor(() => document.querySelectorAll('.screen.lib .lib__grid .tile[role="button"]').length >= 6, { what: 'shows grid', timeout: 10000 });
  await tapTile(page, nl.Name);
  await detailSettled(page, nl.Name);
  await page.waitFor((n) => {
    const r = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility());
    return r[r.length - 1].querySelectorAll('.episode:not(.episode--preview)').length === n;
  }, { what: 'start season rows', timeout: 10000 }, seasons[start].childIds.length);
  let v = await seriesView(page);
  assert.deepEqual(v.pills.filter((p) => !p.dim).map((p) => p.text), seasons.map((s) => s.Name), 'one pill per season');
  assert.equal(v.pills.findIndex((p) => p.active), start, 'start season = first not fully watched');
  assert.deepEqual(v.rows.map((r) => r.title), epNames(seasons[start]), 'rows = that season’s episodes');
  assert(srv.requests({ origin: 'jf', path: '/Shows/' + nl.Id + '/Seasons' }).length >= 1, 'Seasons fetched');
  const epq = srv.requests({ origin: 'jf', path: '/Shows/' + nl.Id + '/Episodes' }).map((e) => Object.fromEntries(new URLSearchParams(e.search)));
  assert(epq.some((q) => q.SeasonId === seasons[start].Id), 'Episodes for the start season');

  // Season 3: 6 imported episodes + the downloading E7, not tappable
  const s3 = seasons.findIndex((s) => s.IndexNumber === 3);
  await tapButton(page, '.route', new RegExp('^' + seasons[s3].Name));
  await page.waitFor(() => {
    const r = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility());
    return r[r.length - 1].querySelector('.episode[aria-disabled="true"]:not(.episode--preview)');
  }, { what: 'pending row in Season 3', timeout: 10000 });
  v = await seriesView(page);
  assert.equal(v.pills.findIndex((p) => p.active), s3, 'Season 3 pill active');
  assert.deepEqual(v.rows.filter((r) => !r.disabled).map((r) => r.title), epNames(seasons[s3]), 'Season 3 rows');
  const pend = v.rows.filter((r) => r.disabled);
  assert.equal(pend.length, 1, 'one pending row');
  // as on the TV (33-tv-series-detail): the title comes from Sonarr's metadata (the
  // fake's says "Episode 7"), not the feed's episode_title ("New Arrival")
  assert.equal(pend[0].title, 'Episode 7', 'pending row titled from mlMetadata');
  assert.equal(pend[0].num, 'E7');
  assert.equal(v.rows.at(-1).title, 'Episode 7', 'the pending E7 sits after E6');

  // tap E1 of Season 3: the episode starts on the HLS remux (main.m3u8)
  const e1 = w.items.get(seasons[s3].childIds.map((id) => w.items.get(id)).find((e) => e.IndexNumber === 1).Id);
  const hold = srv.fault({ origin: 'jf', path: /^\/videos\/[^/]+\/hls1\//i }, { hang: true });
  const s0 = w.sessions.length;
  const p = await page.eval((name) => {
    const r = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility());
    const el = [...r[r.length - 1].querySelectorAll('.episode')].find((e) => e.querySelector('.episode__title')?.textContent.trim() === name);
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, e1.Name);
  await page.tap(p.x, p.y);
  await page.waitFor(() => document.querySelector('.vr-pload--show'), { what: 'loading card', timeout: 8000 });
  const lc = await page.eval(() => ({ show: document.querySelector('.vr-pload .player__show')?.textContent.trim(), title: document.querySelector('.vr-pload .pload__title')?.textContent.trim() }));
  assert.equal(lc.title, e1.Name, 'loading card: episode title');
  assert(lc.show && lc.show.includes(nl.Name), 'loading card: series line ' + lc.show);
  const m3u = await until(() => srv.requests({ origin: 'jf', path: /^\/videos\/[^/]+\/\w+\.m3u8$/i })[0], 'playlist', 8000);
  assert.equal(m3u.path.toLowerCase(), ('/videos/' + e1.Id + '/main.m3u8').toLowerCase(), 'main.m3u8 of the episode');
  const pb = srv.events.filter((e) => e.kind === 'playbackinfo' && e.itemId === e1.Id).at(-1).body;
  assert.equal(pb.MediaSourceId, e1.MediaSources[0].Id);
  assert.equal(pb.SubtitleStreamIndex, -1);
  await until(() => hold.hits > 0, 'a segment request', 8000);
  assert.equal(srv.requests({ origin: 'jf' }).filter((e) => /master\.m3u8$/i.test(e.path)).length, 0, 'never master.m3u8');
  await page.tapSel('.vr-busytop .iconbtn');
  const stop = await until(() => w.sessions.slice(s0).find((s) => s.kind === 'stopped'), 'Stopped', 8000);
  assert.equal(stop.body.ItemId, e1.Id);
  hold.remove();
  await detailSettled(page, nl.Name);
});
