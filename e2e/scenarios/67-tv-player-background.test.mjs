/* TV player — sent to the background or killed mid-video (lifecycle.js:
 * visibilitychange → hidden and pagehide both call player.svelte.js
 * suspendPlayback() → exitPlayer()).
 *
 * CLAUDE.md "Progress": webOS parks the webview instead of killing it, so the
 * app closes playback out itself — one Stopped, sent with keepalive, at the
 * exact position — and lands where Back would have: the detail page (Resume at
 * that position), or Home on hero-resume for a start from Home's hero.
 * Hidden/visible is Chromium's own (the window is minimised, lib/phone.mjs
 * setHidden); pagehide is a real navigation away. */
import { test, assert } from '../lib/runner.mjs';
import { waitFocus, focused, screen, holds, steer, checkFocusInvariants } from '../lib/tv.mjs';
import { setHidden } from '../lib/phone.mjs';
import { openMovieDetail, startAndPlay, homeReady, spyFetch, playBtn, fmtTime, until, vstate, aliceOf, epOf } from '../lib/player.mjs';
import { TICKS } from '../server/seed.mjs';

const stops = (w, s0) => w.sessions.slice(s0).filter((x) => x.kind === 'stopped');

/* hide the window mid-video: → the one Stopped, at the playhead, keepalive */
async function hideMidVideo(t, item, s0) {
  const { page, srv } = t;
  const w = srv.world;
  await page.waitFor(() => document.querySelector('video').currentTime > (window.__e2eT0 ??= document.querySelector('video').currentTime) + 1.5, { what: 'a little playback', timeout: 10000 });
  const before = (await vstate(page)).t;
  await setHidden(page, true);
  const stop = await until(() => stops(w, s0)[0], 'the Stopped on hide', 5000);
  const pos = stop.body.PositionTicks / TICKS;
  t.log(`hidden at ${before.toFixed(2)} s → Stopped at ${pos.toFixed(2)} s`);
  assert.equal(stop.body.ItemId, item.Id);
  assert(pos >= before - 0.1 && pos <= before + 1.5, `PositionTicks = the playhead at the hide (${pos} vs ${before})`);
  assert(!(await vstate(page)).src, 'the element was emptied while hidden');
  return { stop, pos };
}

test('tv player background: hidden mid-film (Home button) → one keepalive Stopped at the playhead; visible again → the movie detail with Resume at that position', { fast: false, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const movie = w.list('Movie')[2];
  const resumeSec = Math.floor(w.userData.get(aliceOf(w).Id + ':' + movie.Id).PlaybackPositionTicks / TICKS);
  await spyFetch(page);
  await openMovieDetail(t, movie);
  const { s0 } = await startAndPlay(t, movie, { resumeSec });
  const { stop, pos } = await hideMidVideo(t, movie, s0);
  const sent = await page.eval(() => window.__e2eFetches.filter((f) => /\/Sessions\/Playing\/Stopped$/.test(f.url)));
  assert.equal(sent.length, 1, 'one Stopped request: ' + JSON.stringify(sent));
  assert.equal(sent[0].keepalive, true, 'sent with keepalive');
  assert(stop.body.PlaySessionId, 'with its PlaySessionId');

  await setHidden(page, false);
  await waitFocus(page, 'play', 8000);
  const sc = await screen(page);
  assert(!sc.player, 'the player is gone: ' + JSON.stringify(sc));
  assert.equal(await page.eval(() => document.querySelector('.screen .hero .title')?.textContent.trim()), movie.Name, 'on the movie detail');
  assert.equal(await playBtn(page), '▶ Resume · ' + fmtTime(pos), 'Resume at the exact position');
  assert.equal(Math.floor(w.userData.get(aliceOf(w).Id + ':' + movie.Id).PlaybackPositionTicks / TICKS), Math.floor(pos), 'the server saved it');
  await holds(() => stops(w, s0).length === 1, 1000, 'still exactly one Stopped after the resume');
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants after the resume');
});

test('tv player background: hidden mid-episode started from Home\'s hero → the Stopped, and visible again lands on Home on hero-resume (not a detail page)', { fast: false, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const ep = epOf(w, 'Northern Line', 1, 3);
  await homeReady(t);
  await steer(page, 'hero-resume', { settle: 250 });
  const { s0 } = await startAndPlay(t, ep, { resumeSec: 1200 });
  const { pos } = await hideMidVideo(t, ep, s0);
  await setHidden(page, false);
  await waitFocus(page, 'hero-resume', 8000);
  const sc = await screen(page);
  assert(sc.screen && sc.screen.startsWith('home') && !sc.player, 'back on Home: ' + JSON.stringify(sc));
  assert(!(await page.eval(() => !!document.querySelector('.screen [data-focus="play"]'))), 'no detail page');
  await page.waitFor((s) => document.querySelector('[data-focus="hero-resume"]')?.textContent.includes('Resume · ' + s), { what: 'hero Resume at the new point', timeout: 8000 }, fmtTime(pos));
  await holds(() => stops(w, s0).length === 1, 800, 'exactly one Stopped');
  assert.equal(await focused(page), 'hero-resume');
});

test('tv player background: the app killed mid-film (pagehide, no visibilitychange first) → the keepalive Stopped still arrives, once, at the playhead', { fast: false, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const movie = w.list('Movie')[2];
  const resumeSec = Math.floor(w.userData.get(aliceOf(w).Id + ':' + movie.Id).PlaybackPositionTicks / TICKS);
  await openMovieDetail(t, movie);
  const { s0 } = await startAndPlay(t, movie, { resumeSec });
  await page.waitFor(() => document.querySelector('video').currentTime > (window.__e2eT0 ??= document.querySelector('video').currentTime) + 1.5, { what: 'a little playback', timeout: 10000 });
  const before = (await vstate(page)).t;
  assert.equal(await page.eval(() => document.visibilityState), 'visible');
  // a navigation away unloads the document: pagehide fires, the page is gone right after
  await page.goto(srv.urls.tv + '/__e2e_blank');
  const stop = await until(() => stops(w, s0)[0], 'the Stopped from pagehide', 5000);
  const pos = stop.body.PositionTicks / TICKS;
  t.log(`unloaded at ~${before.toFixed(2)} s → Stopped at ${pos.toFixed(2)} s`);
  assert.equal(stop.body.ItemId, movie.Id);
  assert(pos >= before - 0.1 && pos <= before + 1.5, `PositionTicks = the playhead at the unload (${pos} vs ${before})`);
  assert.equal(Math.floor(w.userData.get(aliceOf(w).Id + ':' + movie.Id).PlaybackPositionTicks / TICKS), Math.floor(pos), 'the server saved the position');
  await holds(() => stops(w, s0).length === 1, 1000, 'exactly one Stopped');
});
