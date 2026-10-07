/* TV Home when Jellyfin fails: the LoadError card (Retry keeps the same card
 * up while it fails — CLAUDE.md "LoadError is the only didn't-load card"),
 * recovery, the 10 s grab deadline, one rail failing, the auto-retry on
 * `online`, and the card's Change server button. */
import { test, assert } from '../lib/runner.mjs';
import { bootTv, waitFocus, focused, screen, checkFocusInvariants } from '../lib/tv.mjs';

const RAILS = /^\/(UserItems\/Resume|Shows\/NextUp)$/;
const E500 = /status of 500 .*\/(UserItems\/Resume|Shows\/NextUp)\?/;

const card = (page) =>
  page.eval(() => {
    const c = document.querySelector('.screen.home .loaderr');
    if (!c) return null;
    return {
      title: c.querySelector('.t')?.textContent,
      why: c.querySelector('.why')?.textContent,
      retry: c.querySelector('[data-focus="home-retry"]')?.textContent,
      tagged: c.__e2e === 1,
      keys: [...c.querySelectorAll('.focus')].map((e) => e.dataset.focus)
    };
  });

const railTitles = (page) => page.eval(() => [...document.querySelectorAll('.screen.home .rails .rail h2')].map((h) => h.textContent.trim()));

/* fail both core rails: 500 (optionally slow) */
function failRails(srv, effect = { status: 500, text: 'boom' }) {
  const f = srv.fault({ origin: 'jf', method: 'GET', path: RAILS }, effect);
  return f;
}

test('tv home errors: both rails 500 → card; Retry while failing keeps the same card; recovery paints the rails', {
  fast: true,
  allowErrors: [E500]
}, async (t) => {
  const { page, srv } = t;
  const f = failRails(srv, { status: 500, text: 'boom', delay: 600 });
  await bootTv(t);
  await waitFocus(page, 'home-retry', 12000);
  let c = await card(page);
  assert(c, 'the LoadError card is up');
  assert.equal(c.title, 'Can’t reach Jellyfin at ' + srv.urls.jf, 'card title names the server');
  assert.equal(c.why, 'The server had a problem (HTTP 500)', 'why-line');
  assert.deepEqual(c.keys, ['home-retry', 'home-server'], 'Retry + Change server, no Back on Home');
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants on the card');
  // the tab row is still there — the nav is the only way off a failed Home
  assert(await page.eval(() => !!document.querySelector('[data-focus="tab-home"]')), 'tab row mounted');

  // mark the card element; a retry that fails must not remount it
  await page.eval(() => (document.querySelector('.screen.home .loaderr').__e2e = 1));
  const before = srv.requests({ path: '/UserItems/Resume' }).length;
  await page.key('OK', { settle: 0 });
  await page.waitFor(() => document.querySelector('[data-focus="home-retry"]')?.textContent === 'Retrying…', { what: 'Retrying… while in flight', timeout: 2000 });
  assert.equal(await focused(page), 'home-retry', 'focus stays on Retry during the retry');
  await page.waitFor(() => document.querySelector('[data-focus="home-retry"]')?.textContent === 'Retry', { what: 'Retry again after the failure', timeout: 5000 });
  c = await card(page);
  assert(c && c.tagged, 'the SAME card stayed mounted through the failed retry');
  assert.equal(await focused(page), 'home-retry', 'focus still on Retry');
  assert.equal(srv.requests({ path: '/UserItems/Resume' }).length, before + 1, 'the retry re-requested Resume');
  assert(!(await page.eval(() => document.querySelector('.screen.home .vload'))), 'no spinner swapped in');

  // the server comes back: Retry paints the rails and focus lands on the tab
  f.remove();
  await page.key('OK', { settle: 0 });
  await page.waitFor(() => document.querySelectorAll('.screen.home .rails .rail').length >= 2, { what: 'rails after recovery', timeout: 8000 });
  assert(!(await card(page)), 'card gone');
  await waitFocus(page, 'tab-home');
  assert.deepEqual((await railTitles(page)).slice(0, 2), ['Continue Watching', 'Next Up'], 'core rails back');
  assert.deepEqual(await checkFocusInvariants(page, { dupOk: ['tile-'] }), [], 'focus invariants after recovery');
});

test('tv home errors: a request that never answers still ends in the card (10 s grab deadline)', {
  fast: false,
  timeout: 40000
}, async (t) => {
  const { page, srv } = t;
  failRails(srv, { hang: true });
  const t0 = Date.now();
  await bootTv(t, { skipSplash: false });
  await page.waitFor(() => !!document.querySelector('.screen.home .vload'), { what: 'spinner while waiting', timeout: 8000 });
  await waitFocus(page, 'home-retry', 16000);
  const took = Date.now() - t0;
  t.log('card after ' + took + ' ms');
  assert(took >= 9000, 'not before the 10 s deadline (' + took + ' ms)');
  const c = await card(page);
  assert.equal(c.why, 'Check that Jellyfin is running and that the TV is on the same network.', 'an aborted grab reads as unreachable');
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants on the card');
});

test('tv home errors: one failing rail keeps the screen up with the other', {
  fast: false,
  allowErrors: [/status of 500 .*\/Shows\/NextUp\?/]
}, async (t) => {
  const { page, srv } = t;
  srv.fault({ origin: 'jf', method: 'GET', path: '/Shows/NextUp' }, { status: 500, text: 'boom' });
  await bootTv(t);
  await waitFocus(page, 'tab-home', 12000);
  await page.waitFor(() => document.querySelectorAll('.screen.home .rails .rail').length >= 1, { what: 'rails', timeout: 8000 });
  assert(!(await card(page)), 'no error card');
  const titles = await railTitles(page);
  assert.equal(titles[0], 'Continue Watching', 'Continue Watching still there');
  assert(!titles.includes('Next Up'), 'no Next Up rail: ' + titles.join(', '));
  assert(await page.eval(() => !!document.querySelector('[data-focus="hero-resume"]')), 'hero up');
  assert.deepEqual(await checkFocusInvariants(page, { dupOk: ['tile-'] }), [], 'focus invariants');
});

test('tv home errors: the card retries by itself when the network comes back', {
  fast: false,
  allowErrors: [E500]
}, async (t) => {
  const { page, srv } = t;
  const f = failRails(srv);
  await bootTv(t);
  await waitFocus(page, 'home-retry', 12000);
  // walk off Retry onto the tab row: an `online` retry must still run
  await page.key('Up', { settle: 150 });
  const off = await focused(page);
  assert(/^tab-|^nav-/.test(off), 'focus on the tab row: ' + off);
  f.remove();
  const n = srv.requests({ path: '/UserItems/Resume' }).length;
  // the browser sees the network return (CDP offline → online fires `online`)
  await page.s.send('Network.enable');
  await page.s.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.s.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.waitFor(() => document.querySelectorAll('.screen.home .rails .rail').length >= 2, { what: 'rails after the auto-retry', timeout: 6000 });
  assert.equal(srv.requests({ path: '/UserItems/Resume' }).length, n + 1, 'one automatic retry');
  assert((await focused(page)) !== '<body>', 'focus not on body after the auto-retry');
});

test('tv home errors: Change server opens Login on the server field; Back returns to Home', {
  fast: false,
  allowErrors: [E500]
}, async (t) => {
  const { page, srv } = t;
  const f = failRails(srv);
  await bootTv(t);
  await waitFocus(page, 'home-retry', 12000);
  await page.key('Right', { settle: 120 });
  await waitFocus(page, 'home-server');
  await page.key('OK', { settle: 200 });
  await page.waitFor(() => document.querySelector('.screen.login'), { what: 'Login' });
  await waitFocus(page, 'srv');
  const sub = await page.eval(() => document.querySelector('.screen.login .sub').textContent);
  assert.match(sub, /^Add an account — /, 'add-account mode (the session underneath stays)');
  assert.equal(await page.eval(() => document.querySelector('[data-focus="srv"]').value), srv.urls.jf, 'field shows the current server');
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants on Login');
  f.remove();
  await page.key('Back', { settle: 200 });
  await page.waitFor(() => document.querySelector('.screen.home'), { what: 'Home after Back' });
  await page.waitFor(() => document.querySelectorAll('.screen.home .rails .rail').length >= 2, { what: 'rails', timeout: 8000 });
  assert.equal((await screen(page)).screen, 'home');
  assert((await focused(page)) !== '<body>', 'focus not on body');
  assert(await page.eval(() => !!localStorage.getItem('reel.token')), 'still signed in');
});
