/* TV player — Settings → "Skip recaps automatically" (settings.svelte.js
 * autoSkipRecap, player.svelte.js ontimeupdate → skipTo + toast).
 *
 * CLAUDE.md "Skip Recap / Preview": recaps come from a chapter named like one
 * or from IntroDB (never from Jellyfin's Recap segments, 62-tv-player-segments).
 * With the setting on, a recap is skipped as the playhead enters it — no chip,
 * a "Skipped recap" toast — once per item: seeking back into it on purpose
 * shows the chip instead. Intros have their own setting. With it off (the
 * default) the chip asks. */
import { test, assert } from '../lib/runner.mjs';
import { bootTv, waitFocus, focused, steer } from '../lib/tv.mjs';
import { startAndPlay, homeReady, aliceOf, epOf, until } from '../lib/player.mjs';
import { TICKS } from '../server/seed.mjs';

const RECAP = [46, 56];

/* NL S1E3 with a chapter named "Previously on" over 46–56 s (Intro segment 60–150 is seeded) */
function chapterRecap(w) {
  const ep = epOf(w, 'Northern Line', 1, 3);
  ep.Chapters = [
    { StartPositionTicks: 0, Name: 'Chapter 01' },
    { StartPositionTicks: RECAP[0] * TICKS, Name: 'Previously on' },
    { StartPositionTicks: RECAP[1] * TICKS, Name: 'Chapter 02' },
    { StartPositionTicks: 5 * 60 * TICKS, Name: 'Chapter 03' }
  ];
  return ep;
}

/* resume point 40 s → Home's hero is this episode */
function resumeAt40(w, ep) {
  const ud = w.userData.get(aliceOf(w).Id + ':' + ep.Id);
  ud.PlaybackPositionTicks = 40 * TICKS;
  ud.LastPlayedDate = new Date().toISOString();
}

/* a 50 ms page sampler: chip sightings inside the recap window, the playhead's
 * jumps, toasts */
const watchRecap = (page) =>
  page.eval((r) => {
    const s = (window.__e2eRecap = { chips: [], toasts: [], jumps: [], last: null });
    setInterval(() => {
      const v = document.querySelector('video');
      const c = document.querySelector('[data-focus="c-skip"]');
      const tst = document.getElementById('toast');
      if (c && !c.hidden && c.checkVisibility() && v.currentTime >= r[0] - 0.5 && v.currentTime < r[1]) s.chips.push(+v.currentTime.toFixed(2) + ' ' + c.textContent.trim());
      if (tst?.classList.contains('show') && s.toasts.at(-1) !== tst.textContent.trim()) s.toasts.push(tst.textContent.trim());
      if (s.last != null && v.currentTime - s.last > 3) s.jumps.push([+s.last.toFixed(2), +v.currentTime.toFixed(2)]);
      s.last = v.currentTime;
    }, 50);
  }, RECAP);
const recapState = (page) => page.eval(() => ({ ...window.__e2eRecap, t: document.querySelector('video').currentTime }));

async function exit(t) {
  const { page, srv } = t;
  const w = srv.world;
  const s0 = w.sessions.length;
  await page.key('Back', { settle: 150 });
  if (await page.eval(() => !document.getElementById('video-layer')?.hidden)) await page.key('Back', { settle: 150 });
  await until(() => w.sessions.slice(s0).find((x) => x.kind === 'stopped'), 'Stopped on exit', 5000);
}

test('tv player auto-skip: switched on in Settings → a "Previously on" chapter recap is skipped without the chip; Rewind back into it shows the chip; the intro still asks', { fast: false, timeout: 75000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const ep = chapterRecap(w);
  resumeAt40(w, ep);
  await homeReady(t);

  // avatar → Settings → the recap row: off by default, OK switches it on and persists it
  for (let i = 0; i < 6 && !/^(tab-|nav-)/.test(await focused(page)); i++) await page.key('Up', { settle: 200 });
  await steer(page, 'nav-account', { settle: 150 });
  await page.key('OK', { settle: 300 });
  await steer(page, 'ac-settings', { settle: 150 });
  await page.key('OK', { settle: 300 });
  await waitFocus(page, 'set-audioLang');
  await steer(page, 'set-autoSkipRecap', { settle: 150 });
  const row = () => page.eval(() => document.querySelector('[data-focus="set-autoSkipRecap"]')?.getAttribute('aria-checked'));
  assert.equal(await row(), 'false', 'off by default');
  await page.key('OK', { settle: 200 });
  assert.equal(await row(), 'true', 'OK switched it on');
  const saved = await page.eval(() => JSON.parse(localStorage.getItem('reel.settings') || '{}'));
  assert.equal(saved.autoSkipRecap, true, 'persisted in reel.settings');
  assert.equal(saved.autoSkipIntro, false, 'the intro setting untouched');
  await page.key('Back', { settle: 300 });
  assert.equal(await focused(page), 'nav-account', 'Back closed Settings onto the avatar');

  // the hero settles on the episode (one .info, Resume · 0:40) before the D-pad goes there
  await page.waitFor(() => document.querySelectorAll('.hero.home .info').length === 1 && /Resume · 0:40/.test(document.querySelector('[data-focus="hero-resume"]')?.textContent || ''), { what: 'the hero on S1E3 at 0:40', timeout: 5000 });
  // along the tab row first: ▼ from the avatar lands on a rail tile, and the hero follows a resting tile
  await steer(page, 'tab-home', { settle: 120 });
  await steer(page, 'hero-resume', { settle: 250 });
  await page.waitFor(() => document.activeElement?.dataset.focus === 'hero-resume' && document.activeElement.isConnected && document.querySelectorAll('.hero.home .info').length === 1, { what: 'hero-resume focused, settled', timeout: 3000 });
  await startAndPlay(t, ep, { resumeSec: 40 });
  await watchRecap(page);
  const s1 = await page.waitFor(() => window.__e2eRecap.jumps.length && window.__e2eRecap, { what: 'the jump over the recap', timeout: 15000, interval: 100 });
  t.log('jump ' + JSON.stringify(s1.jumps) + ', toasts ' + JSON.stringify(s1.toasts));
  const [from, to] = s1.jumps[0];
  assert(from >= RECAP[0] - 0.6 && from < RECAP[0] + 1.5, `skipped as the playhead entered the recap (${from})`);
  assert(to >= RECAP[1] - 0.5 && to < RECAP[1] + 2, `to its end (${to})`);
  assert.deepEqual(s1.chips, [], 'no chip for the auto-skipped recap');
  await page.waitFor(() => window.__e2eRecap.toasts.includes('Skipped recap'), { what: '"Skipped recap" toast', timeout: 3000 });

  // once per item: Rewind (−10 s) back into it → the chip, no second skip
  await page.waitFor((e) => document.querySelector('video').currentTime >= e + 0.5, { what: 'playing on after the skip', timeout: 5000 }, RECAP[1]);
  await page.key('Rewind', { settle: 0 });
  await page.waitFor((r) => { const v = document.querySelector('video'); return v.currentTime >= r[0] && v.currentTime < r[1] - 2; }, { what: 'back inside the recap', timeout: 4000 }, RECAP);
  await page.waitFor(() => /Skip recap/.test(document.querySelector('[data-focus="c-skip"]:not([hidden])')?.textContent || ''), { what: 'the recap chip after seeking back', timeout: 4000 });
  const s2 = await recapState(page);
  assert(s2.t >= RECAP[0] && s2.t < RECAP[1], 'still inside the recap, not skipped again: ' + s2.t);
  assert.equal(s2.jumps.filter(([a, b]) => b > a).length, 1, 'no second forward jump');

  // the intro (Jellyfin segment 60–150) is not covered by the recap setting: FastForward (+30 s) into it, its chip asks
  await page.key('FastForward', { settle: 0 });
  await page.waitFor(() => /Skip intro/.test(document.querySelector('[data-focus="c-skip"]:not([hidden])')?.textContent || ''), { what: 'the Skip intro chip', timeout: 6000, interval: 100 });
  await page.waitFor(() => document.querySelector('video').currentTime > 80, { what: 'playing on inside the intro', timeout: 5000 });
  const s3 = await recapState(page);
  assert(s3.t >= 60 && s3.t < 90, 'inside the intro, not skipped: ' + s3.t);
  assert(/Skip intro/.test(await page.eval(() => document.querySelector('[data-focus="c-skip"]:not([hidden])')?.textContent || '')), 'the intro chip still up');
  await exit(t);
});

test('tv player auto-skip: on → an IntroDB recap is skipped without the chip; off (default) → a chapter recap only raises the chip', { fast: false, timeout: 75000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const ep = epOf(w, 'Northern Line', 1, 3);
  const imdb = w.items.get(ep.SeriesId).ProviderIds.Imdb;
  w.ml.segments.set(`${imdb}:1:3`, { intro: null, recap: { start: RECAP[0], end: RECAP[1], submissions: 3 }, outro: null });
  resumeAt40(w, ep);
  await bootTv(t, { storage: { 'reel.settings': { autoSkipRecap: true } } });
  await waitFocus(page, 'tab-home');
  await page.waitFor(() => document.querySelectorAll('.screen.home .rails .rail').length >= 4, { what: 'Home rails', timeout: 10000 });
  await steer(page, 'hero-resume', { settle: 250 });
  const l0 = srv.log.length;
  await startAndPlay(t, ep, { resumeSec: 40 });
  assert(srv.log.slice(l0).some((e) => e.origin === 'ml' && e.path === `/api/segments/${imdb}/1/3`), 'IntroDB asked');
  await watchRecap(page);
  const s1 = await page.waitFor(() => window.__e2eRecap.jumps.length && window.__e2eRecap, { what: 'the jump over the IntroDB recap', timeout: 15000, interval: 100 });
  const [from, to] = s1.jumps[0];
  assert(from >= RECAP[0] - 0.6 && from < RECAP[0] + 1.5 && to >= RECAP[1] - 0.5 && to < RECAP[1] + 2, 'skipped over 46–56: ' + JSON.stringify(s1.jumps));
  assert.deepEqual(s1.chips, [], 'no chip');
  await page.waitFor(() => window.__e2eRecap.toasts.includes('Skipped recap'), { what: '"Skipped recap" toast', timeout: 3000 });
  await exit(t);

  // the setting off, a named chapter recap on the next start: the chip, no skip
  await page.eval(() => localStorage.setItem('reel.settings', JSON.stringify({ autoSkipRecap: false })));
  w.ml.segments.delete(`${imdb}:1:3`);
  chapterRecap(w);
  resumeAt40(w, ep);
  await bootTv(t);
  await waitFocus(page, 'tab-home');
  await page.waitFor(() => document.querySelectorAll('.screen.home .rails .rail').length >= 4, { what: 'Home rails', timeout: 10000 });
  await steer(page, 'hero-resume', { settle: 250 });
  await startAndPlay(t, ep, { resumeSec: 40 });
  await watchRecap(page);
  await page.waitFor(() => /Skip recap/.test(document.querySelector('[data-focus="c-skip"]:not([hidden])')?.textContent || ''), { what: 'the Skip recap chip', timeout: 12000, interval: 100 });
  await waitFocus(page, 'c-skip', 2000);
  const s2 = await page.waitFor((e) => document.querySelector('video').currentTime >= e && window.__e2eRecap, { what: 'playing through the recap', timeout: 8000, interval: 100 }, RECAP[0] + 4);
  assert.deepEqual(s2.jumps, [], 'not skipped');
  assert(!s2.toasts.includes('Skipped recap'), 'no "Skipped recap"');
  await exit(t);
});
