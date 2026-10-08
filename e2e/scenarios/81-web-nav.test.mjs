/* Desktop web client: the address bar and the browser's history
 * (web/src/lib/urlsync.svelte.js) and signing in (phone Login in the web
 * shell, web/src/App.svelte).
 *  - a click on a tile pushes the title's URL; the browser's Back and Forward
 *    walk it; a reload keeps the page (history.state) and what lies behind it;
 *  - a deep link gets its section's root behind it, so Back stays in the app;
 *  - signed out, every URL shows Login ("Sign in · VibeReel"); a wrong
 *    password is refused with a message under the field; a sign-in lands on
 *    the page the URL named.
 * UI-agnostic: routes, h1s, the address, roles/labels, requests. */
import { test, assert } from '../lib/runner.mjs';
import { movie, series } from '../lib/world.mjs';
import { bootWeb, waitRoute, webState, clickOn, historyBack, historyGo, webKey } from '../lib/web.mjs';

/* a wrong password: Jellyfin answers 401, which Chrome logs as a failed load */
const AUTH_401 = /status of 401 .*\/jf\/Users\/AuthenticateByName/;

test('web nav: a tile click pushes /movie/<id>; the browser\'s Back and Forward walk it; a reload keeps the page and its history', { app: 'web', fast: true }, async (t) => {
  const { page, srv } = t;
  const m = movie(srv.world, 0);
  await bootWeb(t, { path: '/movies' });
  await waitRoute(page, 'movies', { h1: 'Movies' });
  await clickOn(page, '[role="button"], [role="link"], button, a', new RegExp('^' + m.Name));
  await waitRoute(page, 'detail', { h1: m.Name, path: '/movie/' + m.Id });

  await historyBack(page);
  await waitRoute(page, 'movies', { h1: 'Movies', path: '/movies' });
  await historyGo(page, 1);
  await waitRoute(page, 'detail', { h1: m.Name, path: '/movie/' + m.Id });

  await page.reload();
  const st = await waitRoute(page, 'detail', { h1: m.Name, path: '/movie/' + m.Id });
  t.log(JSON.stringify(st));
  await historyBack(page);
  await waitRoute(page, 'movies', { h1: 'Movies', path: '/movies' });
});

test('web nav: a deep link has its section\'s root behind it — Back lands on /shows, not off the site', { app: 'web' }, async (t) => {
  const { page, srv } = t;
  const s = series(srv.world, 'Northern Line');
  await bootWeb(t, { path: '/show/' + s.Id });
  await waitRoute(page, 'detail', { h1: s.Name, path: '/show/' + s.Id });
  const { entries, currentIndex } = await page.s.send('Page.getNavigationHistory');
  assert.equal(new URL(entries[currentIndex - 1].url).pathname, '/shows', 'the entry behind the deep link is the section root');
  await historyBack(page);
  await waitRoute(page, 'shows', { h1: 'Shows', path: '/shows' });
  assert.equal((await webState(page)).title, 'Shows · VibeReel');
});

test('web nav: an unknown path falls back to Home (the SPA fallback serves index.html)', { app: 'web' }, async (t) => {
  const { page } = t;
  await bootWeb(t, { path: '/no/such/page' });
  await waitRoute(page, 'home', { h1: 'Northern Line', path: '/' });
});

/* fill a Login field (by its autocomplete token) with a trusted click + insertText */
async function fill(page, autocomplete, text) {
  await clickOn(page, `input[autocomplete="${autocomplete}"]`, /.*/, { scope: 'doc' });
  await page.eval((a) => {
    const i = document.querySelector(`input[autocomplete="${a}"]`);
    i.select();
    return true;
  }, autocomplete);
  await page.type(text);
}

const loginUp = (page) => page.waitFor(() => [...document.querySelectorAll('input[autocomplete="current-password"]')].some((e) => e.checkVisibility()), { what: 'Login', timeout: 10000 });

test('web login: signed out shows Login ("Sign in · VibeReel"); a wrong password is refused under the field; the right one lands on Home', { app: 'web', fast: true, allowErrors: [AUTH_401] }, async (t) => {
  const { page, srv } = t;
  await bootWeb(t, { signedIn: false });
  await loginUp(page);
  const st = await webState(page);
  assert.equal(st.modal, 'login', 'Login is up');
  await page.waitFor(() => document.title === 'Sign in · VibeReel', { what: 'Login tab title', timeout: 4000 });
  assert.equal(srv.requests({ origin: 'ml' }).length, 0, 'nothing reaches reel-api signed out');

  await fill(page, 'username', 'alice');
  await fill(page, 'current-password', 'not-her-password');
  await webKey(page, 'Enter');
  await page.waitFor(() => /Wrong username or password/.test(document.body.innerText), { what: 'the refusal', timeout: 8000 });
  assert.equal(srv.requests({ origin: 'jf', method: 'POST', path: '/Users/AuthenticateByName' }).at(-1).status, 401, 'Jellyfin refused it');
  assert.equal((await webState(page)).modal, 'login', 'still on Login');

  await fill(page, 'current-password', 'alice-pw');
  await clickOn(page, 'button[type="submit"]', /Sign in/, { scope: 'doc' });
  await waitRoute(page, 'home', { h1: 'Northern Line', path: '/' });
  assert.equal((await webState(page)).modal, null, 'Login is gone');
  const auth = srv.requests({ origin: 'jf', method: 'POST', path: '/Users/AuthenticateByName' }).at(-1);
  assert.equal(auth.status, 200, 'signed in');
  assert.equal(auth.auth.Client, 'VibeReel Web', 'as the web client');
  const kept = await page.eval(() => localStorage.getItem('reel.token') || '');
  assert(srv.world.tokens.has(kept), 'the token Jellyfin issued is kept: ' + kept);
});

test('web login: a deep link opened signed out lands on that page after the sign-in', { app: 'web' }, async (t) => {
  const { page, srv } = t;
  const m = movie(srv.world, 3);
  await bootWeb(t, { signedIn: false, path: '/movie/' + m.Id });
  await loginUp(page);
  await fill(page, 'username', 'alice');
  await fill(page, 'current-password', 'alice-pw');
  await webKey(page, 'Enter');
  await waitRoute(page, 'detail', { h1: m.Name, path: '/movie/' + m.Id });
});
