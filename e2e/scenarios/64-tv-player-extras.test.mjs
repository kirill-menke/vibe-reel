/* TV player extras — the picture-mode panel against the (fake) companion
 * service, and the trailer fallback.
 *
 * Picture (player.svelte.js loadPictureModes / setPictureMode, PlayerMenu): the
 * app talks to the hard-coded http://127.0.0.1:8791, which lib/chrome.mjs maps
 * onto the fake's `pic` origin. CLAUDE.md: every call has a 6 s deadline; on a
 * timeout setPictureMode() waits 4.5 s, re-reads /modes and believes the TV's
 * `current` over the timeout (Chromium rejects with AbortError — must count as
 * the timeout); a dead service turns the panel into a Retry row.
 *
 * Trailer (trailer.js openTrailer → playTrailerStream): reel-api's trailer job
 * answering `error` toasts and falls back to the YouTube app through
 * PalmServiceBridge → luna://com.webos.applicationManager/launch. Desktop
 * Chrome has no PalmServiceBridge, so the test installs a recording stub (the
 * webOS environment) — without one the app would window.open() youtube.com,
 * which the network guard forbids. */
import { test, assert } from '../lib/runner.mjs';
import { waitFocus, focused, steer, checkFocusInvariants } from '../lib/tv.mjs';
import { openMovieDetail, startAndPlay, exitWithBack, until } from '../lib/player.mjs';

const toastText = (page) => page.eval(() => (document.querySelector('#toast.show')?.textContent || '').trim());
const waitToast = (page, re, timeout = 5000) =>
  page.waitFor((src) => new RegExp(src).test(document.querySelector('#toast.show')?.textContent || '') && document.querySelector('#toast.show').textContent.trim(), { what: 'toast ' + re, timeout, interval: 50 }, re.source);
const picRows = (page) => page.eval(() => [...document.querySelectorAll('#player-menu .opt')].map((e) => ({ key: e.dataset.focus || null, text: e.textContent.replace(/\s+/g, ' ').trim(), sel: e.classList.contains('sub-sel'), pend: e.classList.contains('pend') })));

async function openPicture(page) {
  if (!(await page.eval(() => document.getElementById('osd')?.classList.contains('show')))) await page.key('Down', { settle: 150 });
  await steer(page, 'c-pic', { settle: 100 });
  await page.key('OK', { settle: 200 });
  await page.waitFor(() => { const m = document.getElementById('player-menu'); return m && !m.hidden && !document.querySelector('#player-menu .opt.muted') && m.contains(document.activeElement); }, { what: 'picture panel loaded, focus inside', timeout: 8000 });
}

async function playing(t) {
  const movie = t.srv.world.list('Movie')[1];
  await openMovieDetail(t, movie);
  return { movie, ...(await startAndPlay(t, movie)) };
}

test('tv picture: the panel lists the service modes with the current one marked; a pick sends /picture?mode= and toasts "Picture mode → …"', { fast: false, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const { s0 } = await playing(t);
  const l0 = srv.log.length;
  await openPicture(page);
  assert(srv.log.slice(l0).some((e) => e.origin === 'pic' && e.path === '/modes'), 'GET /modes (asked on every open)');
  let rows = await picRows(page);
  t.log('rows: ' + JSON.stringify(rows));
  assert.deepEqual(rows.map((r) => r.key), ['filmMaker', 'cinema', 'standard', 'vivid', 'expert1'].map((m) => 'pm-pic-' + m), 'one row per mode, service order');
  assert.deepEqual(rows.filter((r) => r.sel).map((r) => r.key), ['pm-pic-filmMaker'], 'current marked');
  assert.equal(await focused(page), 'pm-pic-filmMaker', 'focus lands on the current mode');
  assert.match(await page.eval(() => document.querySelector('#player-menu .eyebrow')?.textContent), /PICTURE MODE · SDR/);
  assert.deepEqual(await checkFocusInvariants(page), [], 'panel modal');
  const label = rows.find((r) => r.key === 'pm-pic-cinema').text;
  const e0 = srv.events.length;
  await steer(page, 'pm-pic-cinema', { settle: 100 });
  await page.key('OK', { settle: 0 });
  const msg = await waitToast(page, /^Picture mode → /);
  assert.equal(msg, 'Picture mode → ' + label.replace(/\s*●$/, ''), 'toast names the mode as the row does');
  const req = srv.log.slice(l0).find((e) => e.origin === 'pic' && e.path === '/picture');
  assert.equal(new URLSearchParams(req.search).get('mode'), 'cinema');
  assert(srv.events.slice(e0).some((e) => e.kind === 'picture' && e.mode === 'cinema'), 'the service applied it');
  rows = await picRows(page);
  assert.deepEqual(rows.filter((r) => r.sel).map((r) => r.key), ['pm-pic-cinema'], 'the mark moved once confirmed');
  // the same mode again is a no-op
  const n = srv.log.filter((e) => e.path === '/picture').length;
  await page.key('OK', { settle: 300 });
  assert.equal(srv.log.filter((e) => e.path === '/picture').length, n, 'picking the current mode sends nothing');
  await page.key('Back', { settle: 200 });
  await exitWithBack(t, s0);
});

test('tv picture: a set that outlives the 6 s deadline (lands at 8 s) is believed from the 4.5 s re-read; one that never lands says "Couldn’t set picture mode"', { fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  await playing(t);
  await openPicture(page);
  // 1) the service answers after 8 s, having applied the mode: the client's 6 s abort fires first
  srv.fault({ origin: 'pic', path: '/picture' }, { delay: 8000 }, 1);
  const t0 = Date.now();
  await steer(page, 'pm-pic-vivid', { settle: 100 });
  await page.key('OK', { settle: 150 });
  const pend = await picRows(page);
  assert(pend.find((r) => r.key === 'pm-pic-vivid').pend && /Applying…/.test(pend.find((r) => r.key === 'pm-pic-vivid').text), 'the row shows Applying… while the set is out');
  const l1 = srv.log.length;
  const msg = await waitToast(page, /Picture mode → |Couldn’t|unavailable/, 15000);
  const ms = Date.now() - t0;
  t.log(`toast after ${ms} ms: ${msg}`);
  assert.match(msg, /^Picture mode → Vivid/, 'the re-read current wins over the timeout (AbortError counted as the timeout)');
  assert(ms >= 10000 && ms < 13000, `6 s deadline + 4.5 s wait (${ms} ms)`);
  assert(srv.log.slice(l1).some((e) => e.origin === 'pic' && e.path === '/modes'), 'the re-read went to /modes');
  await page.waitFor(() => document.querySelector('#player-menu .opt.sub-sel')?.dataset.focus === 'pm-pic-vivid', { what: 'vivid marked', timeout: 3000 });

  // 2) a set that hangs and never applies → after the re-read, failure
  srv.fault({ origin: 'pic', path: '/picture' }, { hang: true }, 1);
  const t1 = Date.now();
  await steer(page, 'pm-pic-standard', { settle: 100 });
  await page.key('OK', { settle: 150 });
  const msg2 = await waitToast(page, /Picture mode → Standard|Couldn’t|unavailable/, 15000); // the Vivid toast may still be up
  t.log(`toast after ${Date.now() - t1} ms: ${msg2}`);
  assert.equal(msg2, 'Couldn’t set picture mode');
  await page.waitFor(() => !document.querySelector('#player-menu .opt.pend') && document.querySelector('#player-menu .opt.sub-sel')?.dataset.focus === 'pm-pic-vivid', { what: 'still vivid, nothing pending', timeout: 5000 });
  assert((await focused(page)).startsWith('pm-pic-'), 'focus stays in the list');
});

test('tv picture: with the service down the panel offers "Picture control unavailable" + a Retry row; Retry after it is back lists the modes', { fast: false, timeout: 60000, allowErrors: [/Failed to load resource: net::ERR_\w+ http:\/\/127\.0\.0\.1:8791\/modes/] }, async (t) => {
  const { page, srv } = t;
  await playing(t);
  const down = srv.fault({ origin: 'pic' }, { drop: true });
  if (!(await page.eval(() => document.getElementById('osd')?.classList.contains('show')))) await page.key('Down', { settle: 150 });
  await steer(page, 'c-pic', { settle: 100 });
  await page.key('OK', { settle: 200 });
  await waitFocus(page, 'pm-pic-retry', 8000);
  const rows = await picRows(page);
  t.log('rows: ' + JSON.stringify(rows));
  assert.equal(rows.length, 1);
  assert.match(rows[0].text, /^Picture control unavailable — companion service not running\s*Retry$/);
  assert.deepEqual(await checkFocusInvariants(page), [], 'a focusable row, not a dead end');
  // Retry while still down: the same row comes back
  const h = down.hits;
  await page.key('OK', { settle: 200 });
  await until(() => down.hits > h, 'Retry asked /modes again', 5000);
  await waitFocus(page, 'pm-pic-retry', 5000);
  down.remove();
  await page.key('OK', { settle: 200 });
  await page.waitFor(() => document.querySelectorAll('#player-menu [data-focus^="pm-pic-"]:not([data-focus="pm-pic-retry"])').length === 5, { what: 'modes listed after Retry', timeout: 5000 });
  await page.waitFor(() => document.getElementById('player-menu').contains(document.activeElement) && document.activeElement.dataset.focus === 'pm-pic-filmMaker', { what: 'focus moved onto the current mode', timeout: 3000 });
});

test('tv trailer: the trailer job answers error → toast, YouTube app launched through PalmServiceBridge (luna applicationManager/launch), back on the Trailer button; nothing leaves loopback', { fast: false, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const movie = w.list('Movie').find((m) => (m.RemoteTrailers || []).length);
  const ytid = /v=([\w-]{11})/.exec(movie.RemoteTrailers[0].Url)[1];
  // the webOS bridge, recording (webOS answers the launch with returnValue:true)
  await page.s.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__e2eLuna = []; window.PalmServiceBridge = function () { const b = this; b.call = (uri, payload) => { window.__e2eLuna.push({ uri, payload: JSON.parse(payload) }); setTimeout(() => b.onservicecallback && b.onservicecallback(JSON.stringify({ returnValue: true })), 20); }; b.cancel = () => {}; };`
  });
  await openMovieDetail(t, movie);
  await steer(page, 'trailer', { settle: 120 });
  const l0 = srv.log.length;
  await page.key('OK', { settle: 0 });
  const msg = await waitToast(page, /Couldn’t load the trailer here/, 10000);
  t.log('toast: ' + msg);
  assert.match(msg, /^Couldn’t load the trailer here \(.+\) — opening YouTube$/);
  const reqs = srv.log.slice(l0).filter((e) => e.origin === 'ml' && e.path.startsWith('/api/trailers/'));
  assert(reqs.some((e) => e.path === '/api/trailers/' + ytid), 'reel-api asked for this trailer: ' + reqs.map((e) => e.method + ' ' + e.path));
  const luna = await page.waitFor(() => window.__e2eLuna.length && window.__e2eLuna, { what: 'a luna call', timeout: 5000 });
  assert.deepEqual(luna, [{ uri: 'luna://com.webos.applicationManager/launch', payload: { id: 'youtube.leanback.v4', params: { contentTarget: 'https://www.youtube.com/tv?v=' + ytid } } }], 'launch the YouTube app on this video');
  await waitFocus(page, 'trailer', 5000);
  assert(await page.eval(() => document.getElementById('video-layer')?.hidden), 'the trailer player is down');
  assert(!(await page.eval(() => /Couldn’t open YouTube either/.test(document.getElementById('toast')?.textContent || ''))), 'the launch counted as success');
  const foreign = srv.log.slice(l0).filter((e) => !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(e.host || ''));
  assert.deepEqual(foreign, [], 'every request the fake saw came over loopback');
});
