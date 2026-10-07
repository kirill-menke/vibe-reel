/* TV player — the Stopped report's retries (player.svelte.js postStopped,
 * STOP_RETRY_MS = [3000, 10000, 30000]).
 *
 * CLAUDE.md "Stopped is retried": after 3/10/30 s on a network error or a 5xx
 * (4xx is final) — a lost one left the resume point behind, an Up Next roll's
 * episode unwatched and a ghost session. A retry is dropped once the item has a
 * newer session (newestSession), or a late Stopped would rewind it.
 *
 * The retry delays are setTimeout()s; the page clock (lib/player.mjs
 * installClock → __e2eClock.setTimerScale(0.1)) runs them at a tenth, so the
 * 3/10/30 s schedule is 0.3/1/3 s of wall time and is checked as such. The
 * scale is switched on only after the OSD is down (its 5 s auto-hide is a
 * setTimeout too). Every attempt's body is on its log entry (server/index.mjs
 * keeps play-report bodies), so faulted attempts are inspectable. */
import { test, assert } from '../lib/runner.mjs';
import { waitFocus, holds, sleep } from '../lib/tv.mjs';
import { openMovieDetail, startAndPlay, exitWithBack, installClock, until, aliceOf } from '../lib/player.mjs';
import { TICKS } from '../server/seed.mjs';

const STOPPED = '/Sessions/Playing/Stopped';
const SCALE = 0.1;
const attempts = (srv, l0) => srv.log.slice(l0).filter((e) => e.method === 'POST' && e.path === STOPPED);
/* Chrome's network stack resends a request by itself, once and at once, when a
 * reused keep-alive socket dies before any answer: the app sees one failure.
 * So requests < 150 ms apart are one app attempt. */
function appAttempts(list) {
  const out = [];
  for (const e of list) {
    const last = out.at(-1);
    if (last && e.t - last.at(-1).t < 150) last.push(e);
    else out.push([e]);
  }
  return out;
}

/* Back (OSD down), timers × scale, Back (exit) → the playhead just before the exit */
async function exitScaled(t, scale = SCALE) {
  const { page } = t;
  await page.waitFor(() => document.querySelector('video').currentTime > (window.__e2eT0 ??= document.querySelector('video').currentTime) + 1.5, { what: 'a little playback', timeout: 10000 });
  await page.eval(() => (window.__e2eT0 = undefined));
  if (!(await page.eval(() => document.getElementById('osd')?.classList.contains('show')))) await page.key('Play', { settle: 150 });
  await page.key('Back', { settle: 200 });
  assert(await page.eval(() => !document.getElementById('osd')?.classList.contains('show') && !document.getElementById('video-layer')?.hidden), 'OSD down, still in the player');
  await page.eval((s) => window.__e2eClock.setTimerScale(s), scale);
  const at = await page.eval(() => document.querySelector('video').currentTime);
  await page.key('Back', { settle: 100 });
  return at;
}

/* gaps between consecutive attempts vs the scaled schedule */
function checkGaps(t, list, want, scale = SCALE) {
  const gaps = list.slice(1).map((e, i) => e.t - list[i].t);
  t.log(`attempt gaps ${gaps.join(' / ')} ms (scaled schedule ${want.join(' / ')})`);
  gaps.forEach((g, i) => assert(g >= want[i] * 0.9 && g <= want[i] + 800, `retry ${i + 1} after ${want[i] / scale / 1000} s (scaled ${want[i]} ms): ${g} ms`));
}

const FAILS = [
  /Failed to load resource: the server responded with a status of 50[03] \([^)]*\) http:\/\/127\.0\.0\.1:\d+\/Sessions\/Playing\/Stopped/,
  /Failed to load resource: the server responded with a status of 400 \(Bad Request\) http:\/\/127\.0\.0\.1:\d+\/Sessions\/Playing\/Stopped/,
  /Failed to load resource: net::ERR_\w+ http:\/\/127\.0\.0\.1:\d+\/Sessions\/Playing\/Stopped/
];

test('tv player Stopped retries: network error and 503 retried at 3/10 s with one body until one lands; 503 forever → 3/10/30 s then given up; 400 is final', { fast: false, timeout: 90000, allowErrors: FAILS }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const movie = w.list('Movie')[1];
  await installClock(page);
  await openMovieDetail(t, movie);

  await t.step('a dropped connection, a 503, then 204: three app attempts at 0 / +3 s / +10 s, one body', async () => {
    const { s0 } = await startAndPlay(t, movie);
    // every request dropped until Chrome's own resends are through (they follow within ms), so the
    // app really sees a network error; then one 503 for its first retry (due 0.75 s later at this scale)
    const drop = srv.fault({ origin: 'jf', method: 'POST', path: STOPPED }, { drop: true });
    const l0 = srv.log.length;
    const before = await exitScaled(t, 0.25);
    await until(() => drop.hits >= 1, 'the first attempt', 3000);
    await sleep(200);
    drop.remove();
    const f503 = srv.fault({ origin: 'jf', method: 'POST', path: STOPPED }, { status: 503, text: 'Service Unavailable' }, 1);
    const ok = await until(() => w.sessions.slice(s0).find((x) => x.kind === 'stopped'), 'the attempt that lands', 6000);
    const list = attempts(srv, l0);
    const app = appAttempts(list);
    t.log('attempts: ' + app.map((a) => a.map((e) => e.status).join('+')).join(' | '));
    assert.equal(f503.hits, 1, 'the 503 was served');
    assert(app[0].every((e) => e.status === 0), 'the first app attempt died without an answer (network error)');
    assert.equal(app.at(-1).at(-1).status, 204, 'the last one landed');
    assert(app.slice(0, -1).every((a) => a.every((e) => e.status === 0 || e.status === 503)), 'everything before it failed');
    assert(app.length === 3, 'a network error and a 503, each retried: ' + app.length + ' app attempts');
    checkGaps(t, app.map((a) => a[0]), [3000 * 0.25, 10000 * 0.25, 30000 * 0.25].slice(0, app.length - 1), 0.25);
    assert(list.every((e) => JSON.stringify(e.body) === JSON.stringify(list[0].body)), 'the same body every time: ' + list.map((e) => JSON.stringify(e.body)).join(' | '));
    assert(Math.abs(ok.body.PositionTicks / TICKS - before) < 1.5, 'at the exit position');
    await holds(() => attempts(srv, l0).length === list.length, 1200, 'no attempt after the one that landed');
    await page.eval(() => window.__e2eClock.setTimerScale(1));
    await waitFocus(page, 'play', 8000);
  });

  await t.step('400: final, no retry', async () => {
    await startAndPlay(t, movie);
    const f = srv.fault({ origin: 'jf', method: 'POST', path: STOPPED }, { status: 400, text: 'Bad Request' });
    const l0 = srv.log.length;
    await exitScaled(t);
    await until(() => attempts(srv, l0).length >= 1, 'the Stopped', 3000);
    await holds(() => attempts(srv, l0).length === 1, 1500, 'no retry of a 400 (the first would come after 0.3 s)');
    assert.equal(attempts(srv, l0)[0].status, 400);
    f.remove();
    await page.eval(() => window.__e2eClock.setTimerScale(1));
    await waitFocus(page, 'play', 8000);
  });

  await t.step('503 forever: the first attempt + 3 retries at +3 s / +10 s / +30 s, then nothing', async () => {
    await startAndPlay(t, movie);
    const f = srv.fault({ origin: 'jf', method: 'POST', path: STOPPED }, { status: 503, text: 'Service Unavailable' });
    const l0 = srv.log.length;
    await exitScaled(t);
    await until(() => attempts(srv, l0).length >= 4, 'four attempts', 8000);
    const list = attempts(srv, l0);
    assert(list.every((e) => e.status === 503), 'all answered 503');
    checkGaps(t, list, [3000 * SCALE, 10000 * SCALE, 30000 * SCALE]);
    assert(list.every((e) => e.body.PlaySessionId === list[0].body.PlaySessionId && e.body.PositionTicks === list[0].body.PositionTicks), 'one session, one position');
    await holds(() => attempts(srv, l0).length === 4, 4000, 'given up after the third retry');
    f.remove();
    await page.eval(() => window.__e2eClock.setTimerScale(1));
  });
});

test('tv player Stopped retries: a retry is dropped once the item plays again; the new session\'s Stopped stands', { fast: false, timeout: 60000, allowErrors: FAILS }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const alice = aliceOf(w);
  const movie = w.list('Movie')[2];
  const resumeSec = Math.floor(w.userData.get(alice.Id + ':' + movie.Id).PlaybackPositionTicks / TICKS);
  await installClock(page);
  await openMovieDetail(t, movie);
  await startAndPlay(t, movie, { resumeSec });
  // the old session's Stopped hangs 6 s, then fails with a 503 → a retry would be due 0.3 s later
  srv.fault({ origin: 'jf', method: 'POST', path: STOPPED }, { delay: 6000, status: 503, text: 'Service Unavailable' }, 1);
  const l0 = srv.log.length;
  await exitScaled(t);
  const old = await until(() => attempts(srv, l0)[0], 'the old session\'s Stopped', 3000);
  const oldSession = old.body.PlaySessionId;
  // the new session runs at real timers (its OSD auto-hide); the retry is armed only when the 503 lands, at the scale then
  await page.eval(() => window.__e2eClock.setTimerScale(1));
  await waitFocus(page, 'play', 8000);
  // the detail could not wait for the Stopped (holdReads gives up after 1.5 s): it offers the stored point
  const stored = Math.floor(w.userData.get(alice.Id + ':' + movie.Id).PlaybackPositionTicks / TICKS);
  const second = await startAndPlay(t, movie, { resumeSec: stored });
  const newSession = w.sessions.slice(second.s0).find((x) => x.kind === 'start')?.body.PlaySessionId;
  assert(newSession && newSession !== oldSession, 'a new PlaySessionId');
  assert.equal(old.status, 0, 'the old Stopped was still unanswered when the new session started (else this proves nothing)');
  await page.eval((s) => window.__e2eClock.setTimerScale(s), SCALE);
  await until(() => old.status === 503, 'the old Stopped fails', 8000);
  await holds(() => attempts(srv, l0).filter((e) => e.body?.PlaySessionId === oldSession).length === 1, 1500, 'no retry of the old session (one would be due 0.3 s after the 503)');
  await page.eval(() => window.__e2eClock.setTimerScale(1));
  t.log(`old ${oldSession} Stopped answered 503 at +${old.done - old.t} ms; new session ${newSession} kept playing`);

  const { stop, posSec } = await exitWithBack(t, second.s0);
  assert.equal(stop.body.PlaySessionId, newSession);
  await sleep(300);
  assert.equal(Math.floor(w.userData.get(alice.Id + ':' + movie.Id).PlaybackPositionTicks / TICKS), Math.floor(posSec), "the new session's position stands");
});
