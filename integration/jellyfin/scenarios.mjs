/* The browser half of the contract: the real TV and phone bundles (built with
 * VITE_JELLYFIN_URL = the recording proxy) in headless Chrome against the real
 * Jellyfin, driven with the e2e harness's own runner, Page, keys and helpers.
 * The harness's scenarios themselves can't be reused as they are — they set
 * their case up by mutating the fake's in-memory world and read its event log —
 * so these are their real-server counterparts, asserting on the proxy's record
 * of what the real server answered (t.srv.requests()).
 *
 * Every request is validated against the running server's own OpenAPI, and any
 * 4xx/5xx answer fails the test unless listed in allowViolations (proxy.mjs).
 * t.srv.real = { jf, items, admin } from setup.mjs. */
import { test, assert } from '../../e2e/lib/runner.mjs';
import { bootTv, waitFocus, focused, steer, SIGNED_OUT_BOOT } from '../../e2e/lib/tv.mjs';
import { bootPhone, openTab } from '../../e2e/lib/phone.mjs';
import { until, vstate } from '../../e2e/lib/player.mjs';
import { sleep } from '../../e2e/lib/page.mjs';
import { call, TICKS, RESUME_SEC } from './setup.mjs';

const ok = (e) => e && e.status >= 200 && e.status < 300;
const last = (srv, method, re) => srv.requests({ method }).filter((e) => re.test(e.path)).at(-1);
const allClean = (srv) => srv.jfLog.filter((e) => e.violations.length).map((e) => `${e.method} ${e.path}: ${e.violations.join('; ')}`);

async function openTabTv(page, tab) {
  await waitFocus(page, 'tab-home');
  for (let i = 0; i < 4 && (await focused(page)) !== 'tab-' + tab; i++) await page.key('Right', { settle: 120 });
  await waitFocus(page, 'tab-' + tab);
  await page.key('OK', { settle: 250 });
}

async function openTile(page, id, what) {
  await page.waitFor((k) => document.querySelector(`.screen .grid [data-focus="${k}"]`), { what, timeout: 15000 }, 'tile-' + id);
  await page.key('Down', { settle: 250 });
  await steer(page, 'tile-' + id, { settle: 150 });
  await page.key('OK', { settle: 400 });
}

/* F-001 (a signed-out boot fires Home's rails without a token): the real server's answers to it */
const SIGNED_OUT_REAL = {
  allowErrors: [...SIGNED_OUT_BOOT.allowErrors, /status of 40\d .*\/UserImage\?userId=/],
  allowViolations: [...SIGNED_OUT_BOOT.allowViolations, /^real Jellyfin answered 401 to GET \/(UserItems\/Resume|Shows\/NextUp)/, /^real Jellyfin answered 40\d to GET \/UserImage/]
};

test('real tv login: password sign-in against the real server (Authorization header, Quick Connect code from /QuickConnect/Initiate)', { ...SIGNED_OUT_REAL, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  await bootTv(t, { signedIn: false });
  await page.waitFor(() => document.querySelector('.screen.login'), { what: 'login screen' });
  await page.waitFor(() => /\d{6}/.test(document.querySelector('.qc-code')?.textContent || ''), { what: 'Quick Connect code from the real server', timeout: 10000 });
  const qc = last(srv, 'POST', /^\/QuickConnect\/Initiate$/);
  assert(ok(qc) && /^\d{6}$/.test(qc.json?.Code), 'Initiate answered a code: ' + JSON.stringify(qc?.json)?.slice(0, 80));
  await page.eval(() => document.querySelector('[data-focus="u"]').focus());
  await page.type(t.srv.real.user.name);
  await page.key('Enter');
  await waitFocus(page, 'p');
  await page.type(t.srv.real.user.password);
  await page.key('Enter');
  await page.waitFor(() => document.querySelector('.screen.home'), { what: 'Home after sign-in', timeout: 15000 });
  const auth = last(srv, 'POST', /^\/Users\/AuthenticateByName$/);
  assert(ok(auth), 'AuthenticateByName → ' + auth?.status);
  assert.equal(auth.auth?.Client, 'Reel', 'Authorization: MediaBrowser Client="Reel"');
  assert(auth.json?.AccessToken, 'the real server issued a token');
  const saved = await page.eval(() => localStorage.getItem('reel.token'));
  assert.equal(saved, auth.json.AccessToken, 'the app saved the issued token');
  await page.waitFor(() => document.querySelectorAll('.screen.home .rails .rail').length >= 2, { what: 'Home rails', timeout: 15000 });
});

test('real tv home: Continue Watching (Browser Movie at 0:40) and Next Up (S01E02) from the real server', { timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const { items } = srv.real;
  await bootTv(t);
  await waitFocus(page, 'tab-home');
  await page.waitFor((a, b) => document.querySelector(`.screen.home [data-focus="tile-${a}"]`) && document.querySelector(`.screen.home [data-focus="tile-${b}"]`), { what: 'resume + next-up tiles', timeout: 15000 }, items.browser.Id, items.ep2.Id);
  const rails = await page.eval(() => [...document.querySelectorAll('.screen.home .rails .rail')].map((r) => ({ h: r.querySelector('h2')?.textContent.replace(/\s+/g, ' ').trim(), n: r.querySelectorAll('.tile').length })));
  t.log('rails ' + JSON.stringify(rails));
  for (const re of [/^\/UserItems\/Resume$/, /^\/Shows\/NextUp$/]) {
    const e = last(srv, 'GET', re);
    assert(ok(e), `${re} → ${e?.status}`);
  }
  const resume = last(srv, 'GET', /^\/UserItems\/Resume$/);
  assert(resume.json?.Items?.some((i) => i.Id === items.browser.Id && i.UserData?.PlaybackPositionTicks === RESUME_SEC * TICKS), 'Resume carries Browser Movie at its resume point');
  assert.deepEqual(allClean(srv), [], 'every request validated and answered 2xx');
});

test('real tv library + movie detail: Movies grid (GRID_FIELDS) → Contract Movie: HEVC / E-AC3 5.1 / German AAC / SRT + ASS from the real MediaStreams; Watched toggles /UserPlayedItems', { timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const { items } = srv.real;
  await bootTv(t);
  await openTabTv(page, 'movies');
  const grid = await until(() => last(srv, 'GET', /^\/Items$/), 'the grid /Items request', 10000);
  const q = new URLSearchParams(grid.search);
  assert(/UserData/.test(q.get('Fields')) && /MediaSources/.test(q.get('Fields')), 'GRID_FIELDS asked: ' + q.get('Fields'));
  assert(ok(grid) && grid.json?.Items?.length === 2, 'the real /Items answered the 2 movies');
  await openTile(page, items.movie.Id, 'Contract Movie tile');
  await waitFocus(page, 'play', 15000);
  const d = await page.eval(() => {
    const s = document.querySelector('.screen');
    return { title: s.querySelector('.hero .title')?.textContent.trim(), tech: s.querySelector('.techgrid')?.textContent.replace(/\s+/g, ' ').trim() || '', badges: [...s.querySelectorAll('.hero .badgerow .chip')].map((e) => e.textContent.trim()) };
  });
  t.log('detail ' + JSON.stringify(d));
  assert.match(d.title, /^Contract Movie/, 'title');
  assert.match(d.tech, /HEVC/i, 'video chip names HEVC');
  assert.match(d.tech, /DD\+|E-?AC-?3/i, 'audio chip names DD+');
  assert.match(d.tech, /5\.1/, 'audio chip says 5.1');
  assert.match(d.tech, /German|Deutsch/i, 'the second audio track');
  assert.match(d.tech, /English/i, 'the English subtitle');

  await steer(page, 'watched');
  t.log('focus before OK: ' + (await focused(page)));
  await page.key('OK', { settle: 300 });
  await page.waitFor(() => document.querySelector('[data-focus="watched"]')?.classList.contains('on'), { what: 'Watched button on', timeout: 8000 });
  const on = await until(() => last(srv, 'POST', /^\/UserPlayedItems\//), 'POST /UserPlayedItems', 8000);
  assert(ok(on) && on.json?.Played === true, 'marked played: ' + on.status);
  await page.key('OK', { settle: 300 });
  await page.waitFor(() => !document.querySelector('[data-focus="watched"]')?.classList.contains('on'), { what: 'Watched button off', timeout: 8000 });
  const off = await until(() => last(srv, 'DELETE', /^\/UserPlayedItems\//), 'DELETE /UserPlayedItems', 8000);
  assert(ok(off) && off.json?.Played === false, 'marked unplayed: ' + off.status);
  assert.deepEqual(allClean(srv), [], 'every request validated and answered 2xx');
});

test('real tv series detail: Contract Show → one season pill, two episode rows, S01E01 watched', { timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const { items } = srv.real;
  await bootTv(t);
  await openTabTv(page, 'shows');
  await openTile(page, items.series.Id, 'Contract Show tile');
  await page.waitFor(() => document.querySelectorAll('.screen .eplist .eprow').length === 2, { what: 'two episode rows', timeout: 15000 });
  const v = await page.eval(() => ({
    pills: [...document.querySelectorAll('.screen .seasonrow .pill')].map((p) => p.textContent.trim()),
    rows: [...document.querySelectorAll('.screen .eplist .eprow')].map((r) => ({ title: r.querySelector('.etitle')?.textContent.trim(), watched: r.classList.contains('watched') }))
  }));
  t.log('series ' + JSON.stringify(v));
  assert.equal(v.pills.length, 1, 'one season pill');
  assert.deepEqual(v.rows.map((r) => r.watched), [true, false], 'S01E01 watched, S01E02 not');
  const eps = srv.requests({ method: 'GET', path: `/Shows/${items.series.Id}/Episodes` });
  assert(eps.length >= 1 && eps.every(ok), 'Episodes answered');
  assert.deepEqual(allClean(srv), [], 'every request validated and answered 2xx');
});

test('real tv playback: Browser Movie resumes at 0:40 by DirectPlay (static stream, 206); scrubbing loads a trickplay sheet with ApiKey=; Back → Stopped saves the position on the server', { timeout: 120000 }, async (t) => {
  const { page, srv } = t;
  const { items, admin, jf } = srv.real;
  const m = items.browser;
  await bootTv(t);
  await openTabTv(page, 'movies');
  await openTile(page, m.Id, 'Browser Movie tile');
  await waitFocus(page, 'play', 15000);
  await page.key('OK', { settle: 0 });

  const pi = await until(() => last(srv, 'POST', new RegExp(`^/Items/${m.Id}/PlaybackInfo$`)), 'PlaybackInfo', 10000);
  assert(ok(pi), 'PlaybackInfo → ' + pi.status);
  assert.deepEqual(pi.body?.DeviceProfile?.TranscodingProfiles, [], 'the no-transcode contract: empty TranscodingProfiles');
  assert.equal(pi.body?.StartTimeTicks, RESUME_SEC * TICKS, 'resumes at the resume point');
  const src = pi.json?.MediaSources?.[0];
  assert(src && src.SupportsDirectPlay === true && !src.TranscodingUrl, 'the real server answered DirectPlay without a TranscodingUrl: ' + JSON.stringify({ dp: src?.SupportsDirectPlay, tu: src?.TranscodingUrl, why: src?.TranscodeReasons }));

  await page.waitFor(() => !document.getElementById('play-loading')?.classList.contains('show') && (document.querySelector('video')?.currentTime || 0) > 40, { what: 'playing past 0:40', timeout: 20000 });
  const stream = srv.requests({ method: 'GET', path: `/Videos/${m.Id}/stream.` });
  assert(stream.length >= 1, 'GET /Videos/{id}/stream.{container}');
  assert.equal(new URLSearchParams(stream[0].search).get('static'), 'true', 'static=true');
  assert(stream.some((e) => e.status === 206 && e.contentRange), 'a Range request answered 206: ' + stream.map((e) => e.status).join(','));
  const start = await until(() => last(srv, 'POST', /^\/Sessions\/Playing$/), 'POST /Sessions/Playing', 8000);
  assert(ok(start) && start.body?.PlayMethod === 'DirectPlay' && start.body?.PlaySessionId === pi.json.PlaySessionId, 'start report accepted, DirectPlay, the PlaybackInfo session');
  await until(() => last(srv, 'GET', new RegExp(`^/MediaSegments/${m.Id}$`)), '/MediaSegments', 8000);

  // scrub: c-play ▲ c-scrub ▶ → a trickplay preview → its sheet with ApiKey=
  await waitFocus(page, 'c-play', 8000);
  await page.key('Up', { settle: 150 });
  await waitFocus(page, 'c-scrub', 3000);
  await page.key('Right', { settle: 300 });
  const sheet = await until(() => last(srv, 'GET', /\/Trickplay\/\d+\/\d+\.jpg$/), 'a trickplay sheet', 8000);
  assert(ok(sheet) && /ApiKey=/.test(sheet.search) && !/api_key=/.test(sheet.search), `sheet with ApiKey= → ${sheet.status}`);
  await page.key('Back', { settle: 200 }); // abandons the scrub
  await sleep(1500);

  const pos = (await vstate(page)).t;
  for (let i = 0; i < 3 && (await page.eval(() => !document.getElementById('video-layer')?.hidden)); i++) await page.key('Back', { settle: 400 });
  const stop = await until(() => last(srv, 'POST', /^\/Sessions\/Playing\/Stopped$/), 'POST /Sessions/Playing/Stopped', 8000);
  assert(ok(stop), 'Stopped → ' + stop.status);
  const sec = stop.body.PositionTicks / TICKS;
  t.log(`Stopped at ${sec.toFixed(2)} s (playhead ${pos.toFixed(2)} s); stream statuses ${stream.map((e) => e.status).join(',')}`);
  await sleep(500);
  const ud = await call(jf, 'GET', `/Items/${m.Id}?userId=${admin.userId}`, { token: admin.token });
  const saved = (ud.json?.UserData?.PlaybackPositionTicks || 0) / TICKS;
  assert(Math.abs(saved - sec) < 1.5, `the server saved the position: ${saved} vs Stopped ${sec}`);
  await call(jf, 'POST', `/UserItems/${m.Id}/UserData?userId=${admin.userId}`, { token: admin.token, body: { PlaybackPositionTicks: RESUME_SEC * TICKS, Played: false } });
  assert.deepEqual(allClean(srv), [], 'every request validated and answered 2xx');
});

/* the phone: tap helpers as in e2e/scenarios/53-phone-detail.test.mjs */
async function tapTile(page, name) {
  const p = await page.waitFor((name) => {
    const el = [...document.querySelectorAll('.screen.lib .lib__grid .tile[role="button"]')].find((e) => e.checkVisibility() && (e.getAttribute('aria-label') || '').startsWith(name));
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return b.width && b.top >= 0 && b.bottom <= innerHeight ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
  }, { what: 'tile ' + name, timeout: 15000 }, name);
  await page.tap(p.x, p.y);
}
async function tapButton(page, re) {
  const p = await page.waitFor((src) => {
    const r = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility());
    const root = r[r.length - 1];
    const el = root && [...root.querySelectorAll('button, [role="button"]')].find((b) => b.checkVisibility() && new RegExp(src).test(b.textContent.trim()));
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    return b.width ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
  }, { what: 'button ' + re, timeout: 15000 }, re.source);
  await page.tap(p.x, p.y);
}

test('real phone: Home → Movies → Contract Movie → Play: the phone profile gets an HLS TranscodingUrl from the real server, and main.m3u8 (never master) answers', { app: 'phone', timeout: 120000, allowErrors: [/Ignored attempt to cancel a touchmove/, /MEDIA_ERR|DEMUXER|PIPELINE_ERROR|media/i] }, async (t) => {
  const { page, srv } = t;
  const { items, admin, jf } = srv.real;
  await bootPhone(t);
  await page.waitFor(() => [...document.querySelectorAll('.rail__title')].some((h) => /Continue Watching/.test(h.textContent)), { what: 'Continue Watching rail', timeout: 15000 });
  await openTab(page, 'Movies');
  await tapTile(page, 'Contract Movie');
  await page.waitFor(() => /Contract Movie/.test([...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1)?.querySelector('.detail__title')?.textContent || ''), { what: 'MovieDetail', timeout: 15000 });
  await sleep(600);
  await tapButton(page, /^(Play|Resume)$/);
  const pi = await until(() => last(srv, 'POST', new RegExp(`^/Items/${items.movie.Id}/PlaybackInfo$`)), 'PlaybackInfo', 10000);
  assert(ok(pi), 'PlaybackInfo → ' + pi.status);
  assert.equal(pi.auth?.Device, 'iPhone', 'iPhone auth header');
  const src = pi.json?.MediaSources?.[0];
  assert(src && !src.SupportsDirectPlay && /\/master\.m3u8\?/i.test(src.TranscodingUrl || ''), 'an HLS TranscodingUrl for the MKV: ' + String(src?.TranscodingUrl).slice(0, 100));
  const m3u = await until(() => srv.requests({ method: 'GET' }).find((e) => /\/main\.m3u8$/i.test(e.path)), 'main.m3u8', 30000);
  await until(() => m3u.status, 'the playlist answer', 30000);
  assert(ok(m3u), 'main.m3u8 → ' + m3u.status);
  assert.equal(srv.requests({ method: 'GET' }).filter((e) => /master\.m3u8$/i.test(e.path)).length, 0, 'never master.m3u8');
  await sleep(1500);
  t.log('phone requests: ' + srv.jfLog.slice(-8).map((e) => `${e.status} ${e.method} ${e.path.replace(/[0-9a-f]{32}/g, '{id}')}`).join(' | '));
  // stop whatever transcode job the player started (the page's own Stopped may not have gone out)
  await call(jf, 'DELETE', `/Videos/ActiveEncodings?deviceId=reelphone-e2e-alice&playSessionId=${pi.json.PlaySessionId}`, { token: admin.token });
});
