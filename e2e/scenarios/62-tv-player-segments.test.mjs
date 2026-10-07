/* TV player — Skip chip (segments.js findMarkers + communityMarkers, merged in
 * player.svelte.js lookUpMarkers), Up Next (upNextWindow / playNext) and the
 * trickplay scrubber (lookUpTrickplay / trickAt / scrubBy / commitScrub).
 *
 * CLAUDE.md invariants pinned here:
 *  - Recaps never come from Jellyfin `Recap` segments (Intro Skipper's are cold
 *    opens); IntroDB (reel-api /api/segments/{imdb}/{s}/{e}) supplies them.
 *  - The chip takes focus when it appears, one OK skips, and the skipped window
 *    keeps its chip down (P.skipped).
 *  - Up Next appears at the Outro segment with a 10 s countdown; OK rolls on to
 *    the next episode from /Shows/{sid}/Episodes?StartItemId=…&Limit=2&IsMissing=false
 *    and the old one's Stopped goes out at the END position (counts as watched).
 *  - Trickplay sheets go out with ApiKey= (12.1 answers api_key= with 401);
 *    ◀▶ on the scrubber move a pending target, one real seek after 900 ms rest. */
import { test, assert } from '../lib/runner.mjs';
import { waitFocus, focused, steer, checkFocusInvariants } from '../lib/tv.mjs';
import { startAndPlay, exitWithBack, until, aliceOf, epOf, homeReady } from '../lib/player.mjs';
import { TICKS } from '../server/seed.mjs';

const chip = (page) =>
  page.eval(() => {
    const c = document.querySelector('[data-focus="c-skip"]');
    const v = document.querySelector('video');
    return { shown: !!c && !c.hidden && c.checkVisibility(), text: c?.textContent.trim(), t: v?.currentTime, focus: document.activeElement?.dataset?.focus };
  });

/* Resume `ep` from `sec` via Home's hero (it is the head of Continue Watching) */
async function playFromHero(t, ep, sec) {
  const { page, srv } = t;
  const w = srv.world;
  const ud = w.userData.get(aliceOf(w).Id + ':' + ep.Id);
  ud.PlaybackPositionTicks = sec * TICKS;
  ud.LastPlayedDate = new Date().toISOString();
  await homeReady(t);
  await steer(page, 'hero-resume', { settle: 250 });
  assert.equal(await page.eval(() => document.querySelector('.hero.home .title')?.textContent), ep.SeriesName, 'the hero is this episode');
  return startAndPlay(t, ep, { resumeSec: sec });
}

test('tv player segments: a Jellyfin Recap segment is ignored, the IntroDB recap and the Intro segment each raise the focused chip, one OK skips, the chip stays down', { fast: false, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const ep = epOf(w, 'Northern Line', 1, 3);
  const series = w.items.get(ep.SeriesId);
  const imdb = series.ProviderIds.Imdb;
  // seed: Intro 60–150 s, Outro at the end. Add an Intro-Skipper-style Recap (must be ignored)
  w.segments.get(ep.Id).push({ Id: '0e2e00000000000000000000000000ca', ItemId: ep.Id, Type: 'Recap', StartTicks: 31 * TICKS, EndTicks: 45 * TICKS });
  // and IntroDB's hand-marked recap
  w.ml.segments.set(`${imdb}:1:3`, { intro: null, recap: { start: 46, end: 56, submissions: 3 }, outro: null });
  const l0 = srv.log.length;
  await playFromHero(t, ep, 40);
  assert(srv.log.slice(l0).some((e) => e.path === '/MediaSegments/' + ep.Id && e.status === 200), 'GET /MediaSegments/{id}');
  assert(srv.log.slice(l0).some((e) => e.origin === 'ml' && e.path === `/api/segments/${imdb}/1/3`), 'IntroDB lookup /api/segments/{imdb}/1/3');

  // 40–46 s sits inside the Jellyfin Recap window (31–45): no chip there
  const early = await page.waitFor(() => {
    const c = document.querySelector('[data-focus="c-skip"]');
    const v = document.querySelector('video');
    window.__e2eChipEarly ??= [];
    if (c && !c.hidden && v.currentTime < 45.5) window.__e2eChipEarly.push(v.currentTime + ':' + c.textContent.trim());
    return v.currentTime >= 46.5 && { early: window.__e2eChipEarly };
  }, { what: 'playhead past 46 s', timeout: 15000, interval: 100 });
  assert.deepEqual(early.early, [], 'no chip for the Jellyfin Recap segment');

  // IntroDB recap 46–56: the chip, focused, labelled by kind
  await waitFocus(page, 'c-skip', 4000);
  let c = await chip(page);
  assert(c.shown && /Skip recap/.test(c.text), 'Skip recap chip: ' + JSON.stringify(c));
  assert(c.t >= 45.5 && c.t < 56, 'inside the recap window: ' + c.t);
  await page.key('OK', { settle: 300 });
  await page.waitFor(() => document.querySelector('video').currentTime >= 55.5, { what: 'skipped to the recap end', timeout: 4000 });
  c = await chip(page);
  assert(!c.shown || /Skip intro/.test(c.text), 'the recap chip stayed down after the skip: ' + JSON.stringify(c));

  // Intro 60–150 (Jellyfin segment): the chip comes up for the intro
  await page.waitFor(() => /Skip intro/.test(document.querySelector('[data-focus="c-skip"]:not([hidden])')?.textContent || ''), { what: 'Skip intro chip', timeout: 8000, interval: 50 });
  await waitFocus(page, 'c-skip', 2000);
  c = await chip(page);
  assert(c.t >= 59 && c.t < 150, 'inside the intro window: ' + c.t);
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants with the chip up');
  await page.key('OK', { settle: 300 });
  await page.waitFor(() => document.querySelector('video').currentTime >= 149.5, { what: 'one OK skipped past 150 s', timeout: 4000 });
  // the chip stays down for 2 s of playback after the skip
  const after = await page.waitFor(() => {
    const c = document.querySelector('[data-focus="c-skip"]');
    const v = document.querySelector('video');
    window.__e2eChipAfter ??= [];
    if (c && !c.hidden) window.__e2eChipAfter.push(v.currentTime);
    return v.currentTime >= 152.5 && { seen: window.__e2eChipAfter };
  }, { what: 'two seconds after the skip', timeout: 8000, interval: 100 });
  assert.deepEqual(after.seen, [], 'the chip stayed down after the intro skip');
  assert((await focused(page)) !== '<body>', 'focus not on <body> after the chip left');
  const s0 = w.sessions.length;
  await page.key('Back', { settle: 150 }); // the OSD may be down: Back exits or hides it
  if (await page.eval(() => !document.getElementById('video-layer')?.hidden)) await page.key('Back', { settle: 150 });
  await until(() => w.sessions.slice(s0).find((x) => x.kind === 'stopped'), 'Stopped on exit', 5000);
});

test('tv player Up Next: the Outro segment raises the countdown card, OK rolls on (StartItemId episode), the old Stopped is at the end; trickplay scrub sends ApiKey sheets and seeks once', { fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const alice = aliceOf(w);
  const ep = epOf(w, 'Northern Line', 1, 3);
  const next = epOf(w, 'Northern Line', 1, 4);
  const rt = ep.RunTimeTicks / TICKS;
  const outro = w.segments.get(ep.Id).find((s) => s.Type === 'Outro');
  const credits = outro.StartTicks / TICKS;
  assert(credits < srv.media.duration - 30, `the credits (${credits} s) are inside the fixture`);
  const l0 = srv.log.length;
  const { s0 } = await playFromHero(t, ep, credits - 5);

  const epReq = srv.log.slice(l0).find((e) => e.path === `/Shows/${ep.SeriesId}/Episodes`);
  assert(epReq, 'GET /Shows/{sid}/Episodes for the next episode');
  const q = new URLSearchParams(epReq.search);
  assert.equal(q.get('StartItemId'), ep.Id);
  assert.equal(q.get('Limit'), '2');
  assert.equal(q.get('IsMissing'), 'false');

  // the card at the credits, focused, counting down from 10
  await waitFocus(page, 'c-next', 10000);
  const card = await page.eval(() => {
    const c = document.querySelector('[data-focus="c-next"]');
    return { shown: !c.hidden && c.checkVisibility(), text: c.textContent.replace(/\s+/g, ' ').trim(), t: document.querySelector('video').currentTime };
  });
  t.log('Up Next card: ' + JSON.stringify(card));
  assert(card.shown, 'Up Next card shown');
  assert(card.t >= credits - 0.5, `at the credits (${card.t} vs ${credits})`);
  const left0 = Number(/in (\d+)/.exec(card.text)?.[1]);
  assert(left0 >= 8 && left0 <= 10, 'countdown starts at ~10: ' + card.text);
  await page.waitFor((l) => Number(/in (\d+)/.exec(document.querySelector('[data-focus="c-next"]').textContent)?.[1]) < l, { what: 'countdown ticks', timeout: 3000 }, left0);
  assert(srv.log.slice(l0).some((e) => e.method === 'GET' && e.path === '/Items/' + next.Id), 'the next episode was prefetched before the roll');

  const vdur = await page.eval(() => document.querySelector('video').duration);
  const e0 = srv.events.length, s1 = w.sessions.length;
  await page.key('OK', { settle: 100 });
  const stop = await until(() => w.sessions.slice(s0).find((x) => x.kind === 'stopped' && x.body.ItemId === ep.Id), 'the old episode Stopped', 5000);
  t.log(`Stopped at ${stop.body.PositionTicks / TICKS} s; video duration ${vdur}; runtime ${rt}`);
  assert(Math.abs(stop.body.PositionTicks / TICKS - vdur) < 1, 'Stopped at the END position (seekDur), not the playhead');
  assert.equal(w.userData.get(alice.Id + ':' + ep.Id).Played, true, 'the old episode now counts as watched');
  // the next one starts in the same player
  await until(() => srv.events.slice(e0).find((e) => e.kind === 'playbackinfo' && e.itemId === next.Id), 'PlaybackInfo for the next episode', 8000);
  await page.waitFor((id) => [...document.querySelectorAll('video')].some((v) => (v.getAttribute('src') || '').includes('/Videos/' + id + '/')), { what: 'the next stream', timeout: 8000 }, next.Id);
  await page.waitFor(() => !document.getElementById('play-loading')?.classList.contains('show') && !document.querySelector('video').paused, { what: 'next episode playing', timeout: 15000 });
  const start2 = await until(() => w.sessions.slice(s1).find((x) => x.kind === 'start' && x.body.ItemId === next.Id), 'Playing report for the next episode', 5000);
  assert(start2, 'POST /Sessions/Playing for the next episode');
  const s2 = w.sessions.length; // reports of the next episode only from here

  // trickplay: wait for the layout (Fields=Trickplay item read), then ▲ to the scrubber and ▶▶▶
  await page.waitFor(() => !!document.querySelector('video') && document.querySelector('video').currentTime > 1, { what: 'next episode plays a second', timeout: 10000 });
  await page.key('Up', { settle: 150 }); // wakes the OSD if it is down, else → scrubber
  if ((await focused(page)) !== 'c-scrub') await page.key('Up', { settle: 150 });
  await waitFocus(page, 'c-scrub', 3000);
  await page.eval(() => {
    const v = document.querySelector('video');
    window.__e2eSeeks = [];
    v.addEventListener('seeking', () => window.__e2eSeeks.push(v.currentTime));
  });
  const before = await page.eval(() => document.querySelector('video').currentTime);
  const l1 = srv.log.length;
  for (let i = 0; i < 3; i++) await page.key('Right', { settle: 120 });
  const mid = await page.eval(() => ({ seeks: window.__e2eSeeks.length, trick: getComputedStyle(document.querySelector('.trick') || document.body).backgroundImage }));
  assert.equal(mid.seeks, 0, 'no real seek while scrubbing');
  assert(/\/Trickplay\/320\/0\.jpg/.test(mid.trick), 'the preview shows sheet 0: ' + mid.trick);
  await page.waitFor(() => window.__e2eSeeks.length > 0, { what: 'the one seek after 900 ms rest', timeout: 3000 });
  await page.waitFor(() => !document.querySelector('video').seeking, { what: 'seek done', timeout: 5000 });
  const seeks = await page.eval(() => window.__e2eSeeks);
  assert.equal(seeks.length, 1, 'exactly one seek: ' + JSON.stringify(seeks));
  assert(Math.abs(seeks[0] - (before + 30)) < 3, `landed ~30 s on (${before} → ${seeks[0]})`);
  const sheets = srv.log.slice(l0).filter((e) => e.path.includes('/Trickplay/'));
  assert(sheets.length >= 1, 'trickplay sheets requested');
  for (const s of sheets) {
    const sq = new URLSearchParams(s.search);
    assert(sq.has('ApiKey') && !sq.has('api_key'), 'ApiKey=, never api_key=: ' + s.path + s.search);
    assert(w.tokens.has(sq.get('ApiKey')), 'the session token');
    assert.equal(s.status, 200, 'sheet served');
    assert.match(s.path, new RegExp(`^/Videos/(${ep.Id}|${next.Id})/Trickplay/320/\\d+\\.jpg$`));
  }
  t.log(`sheets: ${sheets.map((s) => s.path.split('/').slice(-1)[0]).join(',')} (${srv.log.slice(l1).filter((e) => e.path.includes('/Trickplay/')).length} during the scrub)`);
  const r = await exitWithBack(t, s2);
  assert.equal(r.stop.body.ItemId, next.Id);
});
