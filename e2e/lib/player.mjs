/* TV player helpers shared by the 6x-tv-player* scenarios (moved out of
 * 60-tv-player.test.mjs). Everything reads the DOM / the fake's logs.
 *
 *   openMovieDetail(t, movie)        boot → Movies tab → the tile (first row) → MovieDetail
 *   startAndPlay(t, item, {resumeSec})
 *                                    OK → PlaybackInfo (no-transcode
 *                                    contract asserted) → loading card → static stream →
 *                                    'playing' + OSD; returns { s0, l0 }
 *   exitWithBack(t, s0)              play 2 s on, Back (OSD) + Back → the Stopped report
 *   vstate(page), playBtn(page), fmtTime(sec), until(fn, what, timeout)
 *   aliceOf(world), epOf(world, series, season, episode), homeReady(t) (boot → Home, 4 rails)
 */
import { assert } from './runner.mjs';
import { bootTv, waitFocus } from './tv.mjs';
import { tvProfile } from './bodies.mjs';
import { statSync } from 'node:fs';
import { TICKS } from '../server/seed.mjs';

import { user, ep } from './world.mjs';

export const aliceOf = (w) => user(w, 'alice');
export const epOf = ep;

export async function homeReady(t) {
  const { page } = t;
  await bootTv(t);
  await waitFocus(page, 'tab-home');
  await page.waitFor(() => document.querySelectorAll('.screen.home .rails .rail').length >= 4, { what: 'Home rails', timeout: 10000 });
}

/* poll a Node-side condition (world, request log) */
export async function until(fn, what, timeout = 5000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 40));
  }
}

export async function openMovieDetail(t, movie) {
  const { page } = t;
  await bootTv(t);
  await waitFocus(page, 'tab-home');
  await page.key('Right', { settle: 120 });
  await waitFocus(page, 'tab-movies');
  await page.key('OK', { settle: 250 });
  await page.waitFor(() => document.querySelectorAll('.screen .grid .tile').length >= 20, { what: 'Movies grid', timeout: 10000 });
  const key = 'tile-' + movie.Id;
  const idx = await page.eval((k) => [...document.querySelectorAll('.screen .grid .tile')].findIndex((e) => e.dataset.focus === k), key);
  assert(idx >= 0 && idx < 7, `${key} is in the first grid row (index ${idx})`);
  await page.key('Down', { settle: 250 });
  for (let i = 0; i < idx; i++) await page.key('Right', { settle: 150 });
  await waitFocus(page, key);
  await page.key('OK', { settle: 400 });
  await waitFocus(page, 'play', 10000);
  assert.equal(await page.eval(() => document.querySelector('.screen .hero .title')?.textContent.trim()), movie.Name);
}

export const playBtn = (page) => page.eval(() => document.querySelector('[data-focus="play"]')?.firstChild?.textContent.trim());

export const vstate = (page) => page.eval(() => {
  const v = document.querySelector('#video-layer video') || document.querySelector('video');
  return v && { t: v.currentTime, paused: v.paused, src: v.getAttribute('src'), ready: v.readyState, err: v.error && v.error.code };
});

export function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' : '') + (h ? String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

/* the play-through common to both tests: OK on Play/Resume → PlaybackInfo →
 * loading card → stream → playing; returns what it saw */
export async function startAndPlay(t, movie, { resumeSec = 0 } = {}) {
  const { page, srv } = t;
  const w = srv.world;
  const alice = [...w.users.values()].find((u) => u.Name === 'alice');
  const ev0 = srv.events.length, s0 = w.sessions.length, l0 = srv.log.length;
  // a fast start (from 0, the fixture file warm) can raise and drop the card
  // between two polls under load: a MutationObserver records that it was shown
  await page.eval(() => {
    const el = document.getElementById('play-loading');
    window.__e2eCard = { at: 0, obs: null };
    if (!el) return;
    const seen = () => el.classList.contains('show') && !window.__e2eCard.at && (window.__e2eCard.at = performance.now());
    window.__e2eCard.obs = new MutationObserver(seen);
    window.__e2eCard.obs.observe(el, { attributes: true, attributeFilter: ['class'] });
  });
  const t0 = Date.now();
  await page.key('OK', { settle: 0 });
  await page.waitFor(() => window.__e2eCard?.at || document.getElementById('play-loading')?.classList.contains('show'), { what: 'loading card', timeout: 1000, interval: 20 });
  const cardMs = Date.now() - t0;
  await page.eval(() => window.__e2eCard?.obs?.disconnect());

  const pi = srv.events.slice(ev0).find((e) => e.kind === 'playbackinfo' && e.itemId === movie.Id);
  assert(pi, 'POST /Items/{id}/PlaybackInfo');
  assert.equal(pi.body.UserId, alice.Id, 'UserId rides in the body');
  assert.deepEqual(pi.body.DeviceProfile.TranscodingProfiles, [], 'the no-transcode contract: empty TranscodingProfiles');
  assert.deepEqual(pi.body.DeviceProfile, tvProfile(false), 'the TV DeviceProfile (bodies.mjs copy is current)');
  assert.equal(pi.body.MaxStreamingBitrate, 400000000);
  assert.equal(pi.body.StartTimeTicks, Math.floor(resumeSec * TICKS), 'StartTimeTicks');
  const piReq = srv.log.slice(l0).find((e) => e.method === 'POST' && e.path === `/Items/${movie.Id}/PlaybackInfo`);
  assert(!new URLSearchParams(piReq.search).has('UserId') && !new URLSearchParams(piReq.search).has('userId'), 'not the deprecated query form');
  assert.deepEqual(piReq.violations, [], 'PlaybackInfo validates against 12.1');

  await page.waitFor(() => !document.getElementById('play-loading')?.classList.contains('show'), { what: "'playing' drops the loading card", timeout: 15000 });
  const playMs = Date.now() - t0;
  const stream = srv.log.slice(l0).filter((e) => e.path === `/Videos/${movie.Id}/stream.${movie.MediaSources[0].Container}`);
  assert(stream.length >= 1, 'GET /Videos/{id}/stream.{container}');
  const q = new URLSearchParams(stream[0].search);
  assert.equal(q.get('static'), 'true', 'static=true: the file itself, no transcode');
  assert.equal(q.get('mediaSourceId'), movie.MediaSources[0].Id);
  assert(w.tokens.has(q.get('api_key')), 'the session token');
  const sess = w.playSessions && [...w.playSessions.entries()].reverse().find(([, v]) => v.itemId === movie.Id)?.[0]; // the newest one for this item
  if (sess) assert.equal(q.get('PlaySessionId'), sess, "PlaybackInfo's PlaySessionId");
  assert(stream.every((e) => e.violations.length === 0), 'stream URL validates');
  t.log(`loading card after ${cardMs} ms, playing after ${playMs} ms; stream requests ${stream.map((e) => e.status).join(',')}`);

  await waitFocus(page, 'c-play', 5000); // 'playing' raises the OSD on Play/Pause
  assert(await page.eval(() => document.getElementById('osd')?.classList.contains('show')), 'OSD up');
  // the start report goes out with 'playing', in the same tick the OSD takes focus: wait for it to land
  const start = await until(() => w.sessions.slice(s0).find((x) => x.kind === 'start'), 'POST /Sessions/Playing', 5000);
  assert.equal(start.body.ItemId, movie.Id);
  assert.equal(start.body.PlayMethod, 'DirectPlay');
  const v = await vstate(page);
  assert(!v.paused && v.err == null, 'the video plays: ' + JSON.stringify(v));
  if (resumeSec) assert(v.t >= resumeSec - 1, `seeked to the resume point ${resumeSec}: ${v.t}`);
  return { s0, l0 };
}

export async function exitWithBack(t, s0) {
  const { page, srv } = t;
  const w = srv.world;
  // play on a little, then Back hides the OSD, Back again leaves
  await page.eval(() => { window.__e2eT0 = undefined; });
  await page.waitFor(() => {
    const v = document.querySelector('video');
    return v && v.currentTime > (window.__e2eT0 ??= v.currentTime) + 2;
  }, { what: 'two more seconds of playback', timeout: 10000 });
  // the OSD auto-hides 5 s after the last key: on a loaded machine the wait above can
  // outlast it, and then the first Back would already leave. Play (415) while playing
  // only re-raises the OSD (Keys.svelte), so the two-step Back is what gets tested.
  const osdUp = () => page.eval(() => !!document.getElementById('osd')?.classList.contains('show'));
  if (!(await osdUp())) await page.key('Play', { settle: 150 });
  assert(await osdUp(), 'OSD up before the first Back');
  await page.key('Back', { settle: 250 });
  assert(!(await page.eval(() => document.getElementById('osd')?.classList.contains('show'))), 'first Back hid the OSD');
  assert(await page.eval(() => !document.getElementById('video-layer')?.hidden), 'still in the player');
  const before = (await vstate(page)).t;
  const t0 = Date.now();
  await page.key('Back', { settle: 100 });
  const stop = await (async () => {
    for (;;) {
      const x = w.sessions.slice(s0).find((e) => e.kind === 'stopped');
      if (x) return x;
      if (Date.now() - t0 > 5000) throw new Error('no Stopped report');
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  const posSec = stop.body.PositionTicks / TICKS;
  t.log(`Stopped at ${posSec.toFixed(2)} s (playhead before Back ${before.toFixed(2)} s)`);
  assert(Math.abs(posSec - before) < 1.5, `PositionTicks ≈ currentTime (${posSec} vs ${before})`);
  assert(w.sessions.slice(s0).filter((e) => e.kind === 'progress' && e.at > stop.at).length === 0, 'no progress report after the Stopped');
  const v = await vstate(page);
  assert(!v.src, 'the element was emptied');
  return { stop, posSec };
}


/* A steerable page clock, installed before the app's first byte
 * (Page.addScriptToEvaluateOnNewDocument): Date.now() runs on a virtual clock
 * the test can jump (`__e2eClock.skip(ms)`) or speed up (`setRate(r)`), and
 * setTimeout delays of ≥ 1 s can be scaled (`setTimerScale(s)`). The player's
 * stall watchdog measures with Date.now() on a real 500 ms setInterval, so a
 * skip turns "30 s without progress" into a moment while the interval (and
 * the media pipeline) stay real. `waiting: false` swallows the media element's
 * 'waiting' event in the capture phase, before the app's onwaiting: the TV's
 * pipeline often fires none (CLAUDE.md, stall watchdog), headless Chrome does.
 * performance.now() and `new Date()` are untouched. */
const CLOCK_SRC = `(() => {
  if (window.__e2eClock) return;
  const realNow = Date.now.bind(Date), realST = window.setTimeout.bind(window);
  let base = realNow(), virt = base, rate = 1, scale = 1;
  const now = () => { const r = realNow(); virt += (r - base) * rate; base = r; return Math.floor(virt); };
  Date.now = now;
  window.setTimeout = function (fn, ms, ...a) { return realST(fn, scale !== 1 && typeof ms === 'number' && ms >= 1000 ? ms * scale : ms, ...a); };
  window.__e2eClock = {
    skip(ms) { now(); virt += ms; return now(); },
    setRate(r) { now(); rate = r; },
    setTimerScale(s) { scale = s; },
    waiting: true
  };
  window.addEventListener('waiting', (e) => { if (!window.__e2eClock.waiting) e.stopImmediatePropagation(); }, true);
})();`;

export async function installClock(page, { waiting = true } = {}) {
  await page.s.send('Page.addScriptToEvaluateOnNewDocument', { source: CLOCK_SRC + (waiting ? '' : ';window.__e2eClock.waiting = false;') });
}

/* Throttle the Jellyfin static stream (server/http.mjs sendFileShaped): the
 * first `freeSec` media seconds' worth of bytes at full speed (the WebM header
 * and FFmpeg's probe read need ~40 s' worth), a request starting past that (a
 * resume seek) `burstSec` worth at full speed, then `rate` ×
 * the fixture's average byte rate (0 = hold: the response goes silent). The
 * returned shape is live — set `.bps` / `.free` to change it mid-stream;
 * `bytesPerSec` is the fixture's average (media s → bytes). */
export function shapeStream(t, { freeSec = 0, burstSec = 0, rate = 0 } = {}) {
  const { srv } = t;
  const size = statSync(srv.media.webm).size;
  const bytesPerSec = size / srv.media.duration;
  const shape = { free: Math.round(freeSec * bytesPerSec), burst: Math.round(burstSec * bytesPerSec), bps: rate * bytesPerSec, bytesPerSec };
  srv.world.streamShape = shape;
  return shape;
}

/* Record every fetch() the page makes — { url, method, keepalive } in
 * window.__e2eFetches — installed before boot like installClock. The fake sees
 * the request but not whether it was sent with keepalive (what lets a Stopped
 * outlive a page being frozen or unloaded). */
export async function spyFetch(page) {
  await page.s.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      if (window.__e2eFetches) return;
      const real = window.fetch.bind(window);
      window.__e2eFetches = [];
      window.fetch = function (input, init) {
        try { window.__e2eFetches.push({ url: String(input && input.url || input), method: (init && init.method) || 'GET', keepalive: !!(init && init.keepalive), at: performance.now() }); } catch {}
        return real(input, init);
      };
    })();`
  });
}
