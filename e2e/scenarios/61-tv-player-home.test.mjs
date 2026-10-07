/* TV player — starts from Home (player.svelte.js playItem()/playFromHome(),
 * homeReturn → returnHome()) and the S.epoch start guard.
 *
 * CLAUDE.md "Exit destination": Back from a video started on Home goes back to
 * Home — the hero's Resume button for a hero start, the tile for a Continue
 * Watching / Next Up start — never to a detail page the user never saw.
 * "Every await can land on a different screen": Back 30 ms after Play on a
 * detail page (PlaybackInfo still in flight) must not start video over the
 * page Back went to. */
import { test, assert } from '../lib/runner.mjs';
import { bootTv, waitFocus, focused, steer, screen, sleep, checkFocusInvariants } from '../lib/tv.mjs';
import { openMovieDetail, startAndPlay, exitWithBack, fmtTime, until, vstate, aliceOf, epOf, homeReady } from '../lib/player.mjs';
import { TICKS } from '../server/seed.mjs';

/* the rail (h2 title) an element with this key sits in, for the focused one */
const focusedRail = (page) => page.eval(() => document.activeElement?.closest('.rail')?.querySelector('h2')?.textContent.trim() || null);

test('tv player from Home: hero Resume starts at 20:00 (StartTimeTicks), Back, Back returns to Home on hero-resume — not a detail page', { fast: true, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const alice = aliceOf(w);
  const ep = epOf(w, 'Northern Line', 1, 3);
  const resumeSec = Math.floor(w.userData.get(alice.Id + ':' + ep.Id).PlaybackPositionTicks / TICKS);
  assert.equal(resumeSec, 1200, 'seed: NL S1E3 resumes at 20:00');
  await homeReady(t);
  assert.match(await page.eval(() => document.querySelector('[data-focus="hero-resume"]')?.textContent), /Resume · 20:00/, 'hero offers Resume · 20:00');
  await steer(page, 'hero-resume', { settle: 250 });

  const { s0 } = await startAndPlay(t, ep, { resumeSec });
  assert.equal((await screen(page)).player, true, 'the video layer is up');
  const { stop, posSec } = await exitWithBack(t, s0);
  assert.equal(stop.body.ItemId, ep.Id);
  assert(posSec > resumeSec + 1, `played on from 20:00 (${posSec})`);

  await waitFocus(page, 'hero-resume', 10000);
  const sc = await screen(page);
  assert(sc.screen && sc.screen.startsWith('home'), 'back on Home: ' + JSON.stringify(sc));
  assert(!sc.player, 'the video layer is gone');
  assert(!(await page.eval(() => !!document.querySelector('.screen [data-focus="play"]'))), 'no detail page (its Play button)');
  // Home re-read Continue Watching after the Stopped: the hero now resumes at the new point
  await page.waitFor((s) => document.querySelector('[data-focus="hero-resume"]')?.textContent.includes('Resume · ' + s), { what: 'hero Resume at the new point', timeout: 8000 }, fmtTime(posSec));
  assert.deepEqual(await checkFocusInvariants(page, { dupOk: ['tile-'] }), [], 'focus invariants back on Home');
});

test('tv player from Home: a Continue Watching tile plays on OK from its resume point and Back lands on that tile; a Next Up tile plays from 0', { fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const alice = aliceOf(w);
  const movie = w.list('Movie')[2];
  const resumeSec = Math.floor(w.userData.get(alice.Id + ':' + movie.Id).PlaybackPositionTicks / TICKS);
  assert(resumeSec > 30 && resumeSec < srv.media.duration - 60, 'movie[2] resumes inside the fixture: ' + resumeSec);
  await homeReady(t);

  // Continue Watching: 2nd tile (NL S1E3, movie[2], movie[5])
  const key = 'tile-' + movie.Id;
  await steer(page, key, { settle: 250 });
  assert.equal(await focusedRail(page), 'Continue Watching', 'the tile is in Continue Watching');
  const { s0 } = await startAndPlay(t, movie, { resumeSec });
  const { posSec } = await exitWithBack(t, s0);
  assert(posSec > resumeSec + 1, 'played on from the resume point');
  await waitFocus(page, key, 10000);
  assert.equal(await focusedRail(page), 'Continue Watching', 'Back landed on that tile in Continue Watching');
  assert((await screen(page)).screen.startsWith('home'), 'on Home');
  // the movie is now the most recently played → the head of Continue Watching
  await page.waitFor((k) => document.querySelector('.screen.home .rails .rail .strip .focus')?.dataset.focus === k, { what: 'movie heads Continue Watching', timeout: 8000 }, key);

  // Next Up: Paper Kingdom S2E1 has no position → plays from 0
  const nu = epOf(w, 'Paper Kingdom', 2, 1);
  const nuKey = 'tile-' + nu.Id;
  assert(!w.userData.get(alice.Id + ':' + nu.Id)?.PlaybackPositionTicks, 'S2E1 has no resume point');
  await steer(page, nuKey, { settle: 250 });
  assert.equal(await focusedRail(page), 'Next Up');
  const r2 = await startAndPlay(t, nu, { resumeSec: 0 });
  await exitWithBack(t, r2.s0);
  await waitFocus(page, nuKey, 10000);
  assert((await screen(page)).screen.startsWith('home'), 'back on Home after the Next Up start');
  t.log(`Next Up tile after exit sits in "${await focusedRail(page)}"`);
});

test('tv player: Back 30 ms after Play on a detail page (PlaybackInfo still in flight) drops the start — no stream, no video over the grid; control: the same slow answer without Back plays', { fast: false, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const movie = w.list('Movie')[1];
  await openMovieDetail(t, movie);
  const piPath = `/Items/${movie.Id}/PlaybackInfo`;
  srv.fault({ origin: 'jf', method: 'POST', path: piPath }, { delay: 1500 }, 1);
  const l0 = srv.log.length, s0 = w.sessions.length;
  await page.key('OK', { settle: 0 });
  await sleep(30);
  await page.key('Back', { settle: 100 });
  // Back from MovieDetail → the Movies grid on the tile (onBack → openLibrary, S.epoch++)
  await waitFocus(page, 'tile-' + movie.Id, 5000);
  const pi = await until(() => srv.log.slice(l0).find((e) => e.method === 'POST' && e.path === piPath && e.status), 'the delayed PlaybackInfo answered', 5000);
  assert.equal(pi.status, 200, 'PlaybackInfo answered normally, late');
  // give the app the answer's task + a few frames to (not) act on it
  await page.eval(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => r(true), 250)))));
  const streams = srv.log.slice(l0).filter((e) => e.path.startsWith('/Videos/'));
  assert.deepEqual(streams.map((e) => e.path), [], 'no stream request');
  assert.equal(w.sessions.slice(s0).length, 0, 'no play report');
  const sc = await screen(page);
  assert(!sc.player, 'the video layer stayed hidden: ' + JSON.stringify(sc));
  assert(await page.eval(() => !!document.querySelector('.screen .grid') && !document.querySelector('.screen [data-focus="play"]')), 'still on the Movies grid (no detail Play button)');
  assert(!(await page.eval(() => document.getElementById('play-loading')?.classList.contains('show'))), 'no loading card');
  const v = await vstate(page);
  assert(!v || !v.src, 'the <video> got no src: ' + JSON.stringify(v));
  assert.equal(await focused(page), 'tile-' + movie.Id, 'focus stays on the tile');
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants on the grid');

  // control: a slow PlaybackInfo (500 ms: startAndPlay wants the card within 1 s), no Back → the video starts
  await page.key('OK', { settle: 400 });
  await waitFocus(page, 'play', 10000);
  srv.fault({ origin: 'jf', method: 'POST', path: piPath }, { delay: 500 }, 1);
  const { s0: s1 } = await startAndPlay(t, movie);
  await exitWithBack(t, s1);
  await waitFocus(page, 'play', 10000);
});
