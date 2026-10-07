/* TV player — the start and the exit (player.svelte.js play() / startPlayback()
 * / exitPlayer(), VideoLayer's loading card, Osd). The no-transcode contract:
 * PlaybackInfo carries UserId in the body and a DeviceProfile with EMPTY
 * TranscodingProfiles, and the stream is the static file URL. Desktop Chrome
 * decodes the fixture WebM (server/media.mjs), so playback really starts:
 * 'playing' drops the loading card, reports POST /Sessions/Playing, raises the
 * OSD on Play/Pause. Back hides the OSD, Back again exits with a Stopped report
 * at the playhead — and the detail page it returns to re-reads the item only
 * after that Stopped is answered (holdReads), so it shows the new resume point. */
import { test, assert } from '../lib/runner.mjs';
import { waitFocus, checkFocusInvariants } from '../lib/tv.mjs';
import { openMovieDetail, playBtn, startAndPlay, exitWithBack, fmtTime } from '../lib/player.mjs';
import { TICKS } from '../server/seed.mjs';

test('tv player: Play on MovieDetail → no-transcode PlaybackInfo → loading card → playing + OSD → Back, Back → Stopped at the playhead → detail', { fast: true, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const alice = [...w.users.values()].find((u) => u.Name === 'alice');
  const movie = w.list('Movie')[1];
  assert(!w.userData.get(alice.Id + ':' + movie.Id)?.PlaybackPositionTicks, 'a fresh movie');
  await openMovieDetail(t, movie);
  assert.equal(await playBtn(page), '▶ Play');
  const { s0 } = await startAndPlay(t, movie);
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants in the player');
  const { stop } = await exitWithBack(t, s0);
  assert.equal(stop.body.ItemId, movie.Id);
  await waitFocus(page, 'play', 10000);
  assert.equal(await page.eval(() => document.querySelector('.screen .hero .title')?.textContent.trim()), movie.Name, 'back on the movie detail');
  const ud = w.userData.get(alice.Id + ':' + movie.Id);
  // a few seconds into a feature film is < 5 % (MinResumePct): Jellyfin keeps no resume point
  assert(stop.body.PositionTicks > 0 && stop.body.PositionTicks < movie.RunTimeTicks * 0.05, 'Stopped a few seconds in: ' + stop.body.PositionTicks);
  assert.equal(ud.PlaybackPositionTicks, 0, 'below MinResumePct the server stores no position');
  assert.equal(await playBtn(page), '▶ Play', 'under 30 s there is no Resume');
});

test('tv player: Resume from a saved point seeks there; the exit Stopped saves the new point and the detail (held behind it) shows Resume at it', { fast: false, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const alice = [...w.users.values()].find((u) => u.Name === 'alice');
  const movie = w.list('Movie')[2];
  const resumeSec = Math.floor(w.userData.get(alice.Id + ':' + movie.Id).PlaybackPositionTicks / TICKS);
  assert(resumeSec > 30 && resumeSec < srv.media.duration - 60, 'resume point inside the fixture: ' + resumeSec);
  await openMovieDetail(t, movie);
  assert.equal(await playBtn(page), '▶ Resume · ' + fmtTime(resumeSec));
  const { s0 } = await startAndPlay(t, movie, { resumeSec });
  // a slow Stopped: the detail's re-read must wait for it (holdReads, ≤ 1.5 s)
  srv.fault({ origin: 'jf', method: 'POST', path: '/Sessions/Playing/Stopped' }, { delay: 1000 }, 1);
  const l0 = srv.log.length;
  const { posSec } = await exitWithBack(t, s0);
  assert(posSec > resumeSec + 1, 'played on from the resume point');
  await waitFocus(page, 'play', 10000);
  const stopReq = srv.log.slice(l0).find((e) => e.path === '/Sessions/Playing/Stopped');
  const reads = srv.log.slice(l0).filter((e) => e.method === 'GET' && (e.path === '/Items/' + movie.Id || e.path.endsWith('/Items/' + movie.Id)));
  assert(reads.length >= 1, 'the detail re-read the item');
  t.log(`Stopped arrived +${stopReq.t - srv.log[l0].t} ms, detail GET +${reads[0].t - stopReq.t} ms after it`);
  assert(reads[0].t >= stopReq.t + 900, `the detail GET waited for the Stopped answer (${reads[0].t - stopReq.t} ms after it)`);
  const ud = w.userData.get(alice.Id + ':' + movie.Id);
  assert.equal(Math.floor(ud.PlaybackPositionTicks / TICKS), Math.floor(posSec), 'server position = Stopped');
  assert.equal(await playBtn(page), '▶ Resume · ' + fmtTime(posSec), 'the detail shows the new resume point');
});
