/* TV lifecycle (CLAUDE.md "App lifecycle", "Download activity"): the activity
 * poll (every 4 s) and the news poll (every 10 min) run only on the browse
 * screens AND while the page is visible (App.svelte's $effects); back to
 * visible, activity polls at once and news only if its copy is old. A parked
 * webview comes back with focus on <body>; lifecycle.js resume() puts it on a
 * real element (focusFirst). Playback never polls activity.
 *
 * Hidden/visible is real: the test's window is minimised and restored
 * (Browser.setWindowBounds), which gives Chromium's own visibilitychange. */
import { test, assert } from '../lib/runner.mjs';
import { bootTv, waitFocus, focused, steer, holds, checkFocusInvariants } from '../lib/tv.mjs';
import { setHidden } from '../lib/phone.mjs';
import { openMovieDetail, startAndPlay, exitWithBack, until } from '../lib/player.mjs';
import { movie } from '../lib/world.mjs';

const PERIOD = 4000; // activity.svelte.js
const count = (srv, path) => srv.requests({ origin: 'ml', method: 'GET', path }).filter((e) => e.path === path).length;
const activity = (srv) => count(srv, '/api/activity');
const news = (srv) => count(srv, '/api/news');

async function home(t) {
  await bootTv(t);
  await waitFocus(t.page, 'tab-home');
  await t.page.waitFor(() => document.querySelectorAll('.screen.home .rails .rail').length >= 4, { what: 'Home rails', timeout: 10000 });
  await until(() => activity(t.srv) >= 1 && news(t.srv) >= 1, 'the first activity + news polls', 8000);
}

test('tv lifecycle: hidden stops the activity poll (and news); visible polls activity at once, not news (still fresh); focus on <body> while parked is repaired on resume', { fast: false, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  await home(t);
  // a steady 4 s cadence while visible
  const a0 = activity(srv);
  await until(() => activity(srv) >= a0 + 1, 'the next 4 s activity poll', PERIOD + 2000);

  await setHidden(page, true);
  // the parked webview loses its focused element
  await page.eval(() => document.activeElement?.blur());
  assert.equal(await focused(page), '<body>', 'focus on <body> while parked');
  // an in-flight poll may still land; from then on nothing for two periods and more
  await new Promise((r) => setTimeout(r, 300));
  const a1 = activity(srv), n1 = news(srv);
  await holds(() => activity(srv) === a1 && news(srv) === n1, 2 * PERIOD + 1500, 'no activity or news poll while hidden');

  const tv = Date.now();
  await setHidden(page, false);
  await until(() => activity(srv) > a1, 'an activity poll right after visible', 1500);
  t.log(`activity polled ${Date.now() - tv} ms after visible`);
  // focus repaired by lifecycle.js resume() → focusFirst()
  await page.waitFor(() => document.activeElement && document.activeElement !== document.body && document.activeElement.dataset.focus, { what: 'focus repaired on resume', timeout: 3000 });
  t.log('focus after resume: ' + (await focused(page)));
  assert.deepEqual(await checkFocusInvariants(page, { dupOk: ['tile-'] }), [], 'focus invariants after resume');
  // the D-pad works from there
  const f0 = await focused(page);
  await page.key('Down', { settle: 200 });
  assert((await focused(page)) !== '<body>', 'a D-pad move after resume lands on an element');
  t.log(`▼ from ${f0} → ${await focused(page)}`);
  // news is fresh (< 10 min): the restart does not refetch it
  await holds(() => news(srv) === n1, 1000, 'no news refetch on resume (its copy is fresh)');
  // and the 4 s cadence is back
  const a2 = activity(srv);
  await until(() => activity(srv) > a2, 'the 4 s cadence after resume', PERIOD + 2000);
});

test('tv lifecycle: news is polled once — tab switches, a detail page and Back never refetch it within its 10 min period', { fast: false, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  await home(t);
  const n0 = news(srv);
  assert.equal(n0, 1, 'one news poll at boot');
  for (const tab of ['movies', 'shows', 'home', 'movies']) {
    await steer(page, 'tab-' + tab, { settle: 100 });
    await page.key('OK', { settle: 300 });
    await page.waitFor((tab) => document.querySelector('.tab.active')?.dataset.focus === 'tab-' + tab, { what: tab + ' tab active', timeout: 8000 }, tab);
  }
  // into a detail page and back out (detail is a news screen too)
  await page.waitFor(() => document.querySelectorAll('.screen .grid .tile').length >= 7, { what: 'Movies grid', timeout: 10000 });
  const m = movie(srv.world, 1);
  await steer(page, 'tile-' + m.Id, { settle: 150 });
  await page.key('OK', { settle: 300 });
  await waitFocus(page, 'play', 10000);
  await page.key('Back', { settle: 300 });
  await waitFocus(page, 'tile-' + m.Id, 8000);
  await holds(() => news(srv) === n0, 600, 'still exactly one news request');
  assert(activity(srv) >= 2, 'activity kept polling across the screens');
});

test('tv lifecycle: no activity poll while a film plays; the exit back to the detail page polls at once', { fast: false, timeout: 60000 }, async (t) => {
  const { srv } = t;
  const m = movie(srv.world, 1);
  await openMovieDetail(t, m);
  await until(() => activity(srv) >= 1, 'activity polled on the detail page', 6000);
  const { s0 } = await startAndPlay(t, m);
  await new Promise((r) => setTimeout(r, 300)); // a poll in flight at Play may still land
  const a1 = activity(srv);
  await holds(() => activity(srv) === a1, 2 * PERIOD + 1500, 'no /api/activity while the player is up');
  await exitWithBack(t, s0);
  await waitFocus(t.page, 'play', 8000);
  await until(() => activity(srv) > a1, 'activity polls as soon as the detail page is back', 2000);
});
