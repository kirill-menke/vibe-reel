/* TV player — the stall watchdog (player.svelte.js startStallWatch / stallFail,
 * VideoLayer's ring, "Buffering…", the slow-link hint and the error card).
 *
 * CLAUDE.md "Stall watchdog": the TV's pipeline often fires no 'waiting', so
 * every 500 ms a currentTime unchanged for 2 s raises the ring, VideoLayer adds
 * "Buffering…" 3 s later, 30 s with neither the playhead nor the buffered end
 * moving is the "Playback stalled" card with Retry from the last position, and
 * a loading card up 60 s is "The video never started". A link that still
 * delivers keeps the ring (no card) and, measured over ≥ 8 s of stall, gets the
 * "This file needs about N Mbit/s; the TV is getting about M" hint.
 *
 * How it is driven (all in the harness, nothing in the product):
 *  - the fake's Jellyfin stream goes through a throttle (lib/player.mjs
 *    shapeStream → server/http.mjs sendFileShaped): the header at full speed,
 *    30 s of media after the resume seek, then `rate` × the media rate (0 = the
 *    connection stays open and silent — what an iptables DROP looks like);
 *  - the media element's 'waiting' is swallowed before the app sees it
 *    (installClock { waiting: false }), so the ring can only come from the
 *    watchdog, as on the TV;
 *  - playbackRate 8 runs the 20 s already buffered out in ~2.5 s;
 *  - the watchdog's 30 s / 60 s thresholds are reached by jumping the page's
 *    Date.now() (installClock → __e2eClock.skip); its 500 ms interval, the
 *    ring's and "Buffering…"'s timers and the slow-link measurement (counted
 *    in interval ticks) all stay real. */
import { test, assert } from '../lib/runner.mjs';
import { waitFocus, focused, sleep } from '../lib/tv.mjs';
import { openMovieDetail, startAndPlay, installClock, shapeStream, fmtTime, until, vstate } from '../lib/player.mjs';
import { setPosition } from '../lib/world.mjs';
import { TICKS } from '../server/seed.mjs';

const RESUME = 1200;

/* boot → MovieDetail → Resume at 20:00 through the throttle → playing; then
 * fast-forward into the stall and start a page-side sampler (50 ms, real time). */
async function playIntoStall(t, movie, { rate }) {
  const { page, srv } = t;
  await installClock(page, { waiting: false });
  setPosition(srv.world, 'alice', movie, RESUME);
  const shape = shapeStream(t, { freeSec: 45, burstSec: 30, rate });
  await openMovieDetail(t, movie);
  const r = await startAndPlay(t, movie, { resumeSec: RESUME });
  await page.eval(() => {
    const v = document.querySelector('video');
    v.playbackRate = 8;
    const s = (window.__e2eStall = { t: v.currentTime, movedPerf: performance.now(), movedVirt: Date.now(), spinAt: 0, bufAt: 0, hintAt: 0, bufEnd: 0 });
    setInterval(() => {
      if (v.currentTime !== s.t) Object.assign(s, { t: v.currentTime, movedPerf: performance.now(), movedVirt: Date.now(), spinAt: 0, bufAt: 0, hintAt: 0 });
      const sp = document.getElementById('spinner');
      const up = !!sp && !sp.hidden;
      if (up && !s.spinAt) s.spinAt = performance.now();
      if (up && !s.bufAt && /Buffering…/.test(sp.textContent)) s.bufAt = performance.now();
      if (up && !s.hintAt && sp.querySelector('.slownet')) s.hintAt = performance.now();
      const b = v.buffered;
      s.bufEnd = b.length ? b.end(b.length - 1) : 0;
    }, 50);
  });
  // the ring is up with the playhead frozen: the stall has begun
  const st = await page.waitFor(() => window.__e2eStall.spinAt && window.__e2eStall, { what: 'the watchdog ring over a frozen playhead', timeout: 15000, interval: 100 });
  return { shape, st, ...r };
}

const stall = (page) => page.eval(() => ({ ...window.__e2eStall, now: performance.now(), virt: Date.now() }));
const card = (page) =>
  page.eval(() => {
    const e = document.getElementById('play-error');
    return e && { title: e.querySelector('.petitle')?.textContent.trim(), detail: e.querySelector('.pedetail')?.textContent.trim() };
  });

test('tv player stall: a silent stream → watchdog ring at 2 s (no "waiting"), "Buffering…" 3 s later → "Playback stalled" at 30 s, not before → Retry resumes there, old session Stopped', { fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const movie = w.list('Movie')[1];
  const { st } = await playIntoStall(t, movie, { rate: 0 });
  const frozen = st.t;
  t.log(`frozen at ${frozen.toFixed(2)} s; ring ${((st.spinAt - st.movedPerf) / 1000).toFixed(2)} s after the last movement`);
  assert(frozen > RESUME + 5 && frozen < RESUME + 30, 'played on from 20:00 into the stall: ' + frozen);
  // the watchdog's 2 s (STALL_SPIN_MS) on a 500 ms tick
  const ringMs = st.spinAt - st.movedPerf;
  assert(ringMs >= 1900 && ringMs <= 3600, `the ring came up 2–3 s after the playhead stopped (${ringMs.toFixed(0)} ms)`);
  assert.equal(await page.eval(() => document.getElementById('play-loading')?.classList.contains('show')), false, 'no loading card: a stall, not a start');

  const s2 = await page.waitFor(() => window.__e2eStall.bufAt && window.__e2eStall, { what: '"Buffering…" under the ring', timeout: 6000, interval: 100 });
  const bufMs = s2.bufAt - s2.spinAt;
  assert(bufMs >= 2800 && bufMs <= 4000, `"Buffering…" ~3 s after the ring (${bufMs.toFixed(0)} ms)`);
  assert.equal(s2.t, frozen, 'the playhead is still frozen');
  assert.equal(s2.hintAt, 0, 'no slow-link hint: nothing arrives at all (a dead link is the card\'s job)');

  // 27 s of still (virtual): no card yet
  let s = await stall(page);
  await page.eval((ms) => window.__e2eClock.skip(ms), 27000 - (s.virt - s.movedVirt));
  await sleep(1200);
  s = await stall(page);
  assert.equal(await card(page), null, `no card at ${((s.virt - s.movedVirt) / 1000).toFixed(1)} s of stall`);
  assert(s.virt - s.movedVirt < 30000, 'still under 30 s (virtual) when checked');
  // past 30 s: the card
  await page.eval(() => window.__e2eClock.skip(3500));
  await page.waitFor(() => document.getElementById('play-error'), { what: 'the stall card', timeout: 2500, interval: 50 });
  const c = await card(page);
  t.log('card: ' + JSON.stringify(c));
  assert.equal(c.title, 'Playback stalled');
  const m = /^No video has arrived from the server for (\d+) s\. Check the TV’s connection, then Retry from (\d+:\d\d)\.$/.exec(c.detail);
  assert(m, 'the dead-link wording: ' + c.detail);
  assert(Number(m[1]) >= 30 && Number(m[1]) <= 34, 'nothing for ~30 s: ' + m[1]);
  assert([fmtTime(frozen), fmtTime(frozen - 1)].includes(m[2]), `Retry from the frozen position ${fmtTime(frozen)}: ${m[2]}`);
  await waitFocus(page, 'err-retry', 3000);
  assert((await vstate(page)).paused, 'stallFail paused the element (a late recovery must not play under the card)');
  assert.equal(await page.eval(() => !!document.getElementById('spinner')?.hidden), true, 'the ring went with the card');

  // Retry with the link back: a new PlaybackInfo from the frozen position, the old session Stopped there
  await page.eval(() => (window.__e2eAfterPause = document.querySelector('video').currentTime));
  w.streamShape = null;
  const ev0 = srv.events.length, s0 = w.sessions.length, l0 = srv.log.length;
  const oldSession = [...w.playSessions.entries()].reverse().find(([, v]) => v.itemId === movie.Id)?.[0];
  await page.key('OK', { settle: 0 });
  const pi = await until(() => srv.events.slice(ev0).find((e) => e.kind === 'playbackinfo' && e.itemId === movie.Id), 'Retry → PlaybackInfo', 5000);
  const start = pi.body.StartTimeTicks / TICKS;
  // lastPos follows timeupdate, also under the card: the pause stallFail does reports the playhead further on
  const afterPause = await page.eval(() => window.__e2eAfterPause);
  t.log(`Retry StartTimeTicks ${start} s, frozen playhead ${frozen.toFixed(2)} s, after the pause ${afterPause.toFixed(2)} s`);
  // R3-E2E-1 (run/findings.md): Retry resumes from the playhead as reported AFTER stallFail's pause
  // (desktop Chrome: 1213.5–1214.8 frozen → 1215.4), not quite the "Retry from" the card printed
  assert(Number.isInteger(start) && (start === Math.floor(afterPause) || start === Math.floor(afterPause) - 1), `StartTimeTicks = the last reported playhead, whole seconds (${start} vs ${afterPause})`);
  assert(start >= Math.floor(frozen) - 1 && start <= frozen + 3, `…which is the frozen position give or take (${start} vs ${frozen})`);
  await page.waitFor((p) => {
    const v = document.querySelector('video');
    return !document.getElementById('play-error') && !document.getElementById('play-loading')?.classList.contains('show') && !v.paused && v.currentTime > p + 0.5;
  }, { what: 'playing again past the frozen position', timeout: 15000 }, start);
  const stop = await until(() => w.sessions.slice(s0).find((x) => x.kind === 'stopped'), "the old session's Stopped", 5000);
  if (oldSession) assert.equal(stop.body.PlaySessionId, oldSession, 'the Stopped closes the OLD PlaySessionId');
  assert.equal(stop.body.PositionTicks, Math.floor(start) * TICKS, 'at the Retry position');
  const streams = srv.log.slice(l0).filter((e) => e.path.startsWith(`/Videos/${movie.Id}/stream`));
  assert(streams.length >= 1 && streams.every((e) => !new URLSearchParams(e.search).get('PlaySessionId') || new URLSearchParams(e.search).get('PlaySessionId') !== oldSession), 'a new stream URL (new PlaySessionId)');
  assert((await focused(page)) !== '<body>', 'focus not on <body> after the Retry');
});

test('tv player stall: a trickle keeps the ring, gives the slow-link hint, never the card; once it stops the card quotes the measurement; MovieDetail then warns', { fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const movie = w.list('Movie')[1];
  const need = Math.round(movie.MediaSources[0].Bitrate / 1e6);
  assert.equal(need, 38, 'seed: a 4K file at 37.5 Mbit/s');
  const { shape, st } = await playIntoStall(t, movie, { rate: 0.2 });
  const frozen = st.t;
  // ≥ 8 s of ring (SLOW_MIN_WALL_MS, in watchdog ticks) before the hint
  const s1 = await page.waitFor(() => window.__e2eStall.hintAt && window.__e2eStall, { what: 'the slow-link hint', timeout: 14000, interval: 100 });
  const hintMs = s1.hintAt - s1.spinAt;
  const hint = await page.eval(() => document.querySelector('#spinner .slownet')?.textContent.trim());
  t.log(`hint ${hintMs.toFixed(0)} ms after the ring: ${hint}`);
  assert(hintMs >= 7500 && hintMs <= 11000, `measured over ~8 s of ring (${hintMs.toFixed(0)} ms)`);
  const m = /^This file needs about (\d+) Mbit\/s; the TV is getting about (\d+)\.Put the TV on 5 GHz Wi-Fi or Ethernet\.$/.exec(hint);
  assert(m, 'hint wording: ' + hint);
  assert.equal(Number(m[1]), need, 'needs = the source Bitrate');
  const got = Number(m[2]);
  assert(got >= 5 && got <= 9, `getting ≈ 0.2 × ${need} (${got})`);
  assert(await page.eval(() => /Buffering…/.test(document.getElementById('spinner').textContent)), '"Buffering…" with it');
  assert.equal(s1.t, frozen, 'the playhead has not moved');

  // 40 s more of frozen playhead (virtual) while bytes still arrive: no card
  const b0 = (await stall(page)).bufEnd;
  await page.eval(() => window.__e2eClock.skip(40000));
  await sleep(1500);
  let s = await stall(page);
  assert.equal(s.t, frozen, 'the playhead stayed frozen');
  assert((s.virt - s.movedVirt) / 1000 > 40, `stalled > 40 s (virtual): ${((s.virt - s.movedVirt) / 1000).toFixed(1)}`);
  assert(s.bufEnd > b0 + 0.1, `the buffered end kept moving (${b0.toFixed(2)} → ${s.bufEnd.toFixed(2)})`);
  assert.equal(await card(page), null, 'no stall card while the download still moves');

  // the link dies: once nothing arrives for 30 s either, the card — quoting the measurement.
  // R3-INT-1: the reading freezes when the buffered end stops, so the hint on screen while the
  // ring waits out the dead link and the card's "was only getting about N" are the same number
  // (it used to keep averaging the dead ticks: 6.0 on the hint read 5 on the card).
  shape.bps = 0;
  await sleep(700);
  const bDead = (await stall(page)).bufEnd;
  const hintDead = await page.eval(() => document.querySelector('#spinner .slownet')?.textContent.trim());
  t.log('hint once the link died: ' + hintDead);
  const md = /the TV is getting about (\d+)\./.exec(hintDead || '');
  assert(md, 'the hint stays up after the link died: ' + hintDead);
  const gotDead = Number(md[1]);
  assert(gotDead >= 5 && gotDead <= 9, `still ≈ 0.2 × ${need} (${gotDead})`);
  // 3 s of real watchdog ticks over the dead link (the 30 s below are a clock skip, ~1 tick):
  // the hint holds its number — averaging those ticks in read ~2 lower
  await sleep(3000);
  const hintHeld = await page.eval(() => document.querySelector('#spinner .slownet')?.textContent.trim());
  assert.equal(hintHeld, hintDead, 'the hint after 3 s of dead link');
  await page.eval(() => window.__e2eClock.skip(31000));
  await page.waitFor(() => document.getElementById('play-error'), { what: 'the stall card once the trickle stopped', timeout: 2500, interval: 50 });
  const c = await card(page);
  t.log('card: ' + JSON.stringify(c));
  assert.equal(c.title, 'Playback stalled');
  const cm = /^This file needs about (\d+) Mbit\/s but the TV was only getting about (\d+) Mbit\/s, and then nothing for (\d+) s\. Check the TV’s connection — 5 GHz Wi-Fi or Ethernet — then Retry from (\d+:\d\d)\.$/.exec(c.detail);
  assert(cm, 'the slow-link wording: ' + c.detail);
  assert.equal((await stall(page)).bufEnd, bDead, 'nothing arrived after the hint was read');
  assert.deepEqual([Number(cm[1]), Number(cm[2])], [need, gotDead], 'the same numbers as the hint over the dead link');
  assert(Number(cm[3]) >= 33 && Number(cm[3]) <= 37, 'nothing for ~34 s: ' + cm[3]);
  assert([fmtTime(frozen), fmtTime(frozen - 1)].includes(cm[4]), 'Retry from the frozen position: ' + cm[4]);

  // Back on the card → MovieDetail, whose VIDEO row now warns (P.link, kept 30 min)
  await waitFocus(page, 'err-retry', 3000);
  await page.key('Right', { settle: 150 });
  await waitFocus(page, 'err-back', 2000);
  await page.key('OK', { settle: 300 });
  await waitFocus(page, 'play', 10000);
  const chip = await page.waitFor(() => [...document.querySelectorAll('.screen .tchip.plain')].map((e) => e.textContent.trim()).find((x) => /expect buffering/.test(x)), { what: 'the TechGrid slow-link chip', timeout: 5000 });
  assert.equal(chip, `${need} Mbit/s · the TV got about ${gotDead} earlier, expect buffering`);
});

test('tv player stall: a stream that never answers → "The video never started" at 60 s, not before → Retry plays from 0', { fast: false, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const movie = w.list('Movie')[1];
  await installClock(page);
  await openMovieDetail(t, movie);
  const path = `/Videos/${movie.Id}/stream`;
  const hang = srv.fault({ origin: 'jf', method: 'GET', path }, { hang: true });
  const l0 = srv.log.length;
  await page.key('OK', { settle: 0 });
  await until(() => srv.log.slice(l0).find((e) => e.path.startsWith(path)), 'the stream request (the watchdog is armed with the src)', 8000);
  await page.waitFor(() => document.getElementById('play-loading')?.classList.contains('show'), { what: 'loading card', timeout: 3000 });
  const armed = await page.eval(() => Date.now());
  // 57 s of loading card (virtual): no card yet
  await page.eval((ms) => window.__e2eClock.skip(ms), 57000);
  await sleep(1200);
  const v0 = await page.eval(() => Date.now());
  assert(v0 - armed < 60000, 'under 60 s (virtual) when checked');
  assert.equal(await card(page), null, `no card at ${((v0 - armed) / 1000).toFixed(1)} s`);
  assert(await page.eval(() => document.getElementById('play-loading')?.classList.contains('show')), 'the loading card is still up');
  await page.eval(() => window.__e2eClock.skip(4000));
  await page.waitFor(() => document.getElementById('play-error'), { what: '"The video never started"', timeout: 2500, interval: 50 });
  const c = await card(page);
  assert.deepEqual(c, { title: 'The video never started', detail: 'The server stopped answering before the first frame arrived. Check that the TV can reach it, then Retry.' });
  assert(!(await page.eval(() => document.getElementById('play-loading')?.classList.contains('show'))), 'the card replaced the loading card');
  await waitFocus(page, 'err-retry', 3000);

  hang.remove();
  const ev0 = srv.events.length;
  await page.key('OK', { settle: 0 });
  const pi = await until(() => srv.events.slice(ev0).find((e) => e.kind === 'playbackinfo' && e.itemId === movie.Id), 'Retry → PlaybackInfo', 5000);
  assert.equal(pi.body.StartTimeTicks, 0, 'from the start (nothing had played)');
  await page.waitFor(() => {
    const v = document.querySelector('video');
    return !document.getElementById('play-error') && !document.getElementById('play-loading')?.classList.contains('show') && !v.paused && v.currentTime > 0.5;
  }, { what: 'playing after the Retry', timeout: 15000 });
});
