/* TV: sign-in by password, the auth header contract, wrong password. */
import { test, assert } from '../lib/runner.mjs';
import { bootTv, waitFocus, focused, screen, checkFocusInvariants, SIGNED_OUT_BOOT } from '../lib/tv.mjs';

test('tv login: password sign-in lands on Home with the token saved', { fast: true, ...SIGNED_OUT_BOOT }, async (t) => {
  const { page, srv } = t;
  await bootTv(t, { signedIn: false });
  await page.waitFor(() => document.querySelector('.screen.login'), { what: 'login screen' });
  // Login focuses its first focusable; Quick Connect shows a code from the fake
  await page.waitFor(() => /\d{6}/.test(document.querySelector('.qc-code')?.textContent || ''), { what: 'Quick Connect code' });
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants on Login');

  // focus the username field via the D-pad engine's own target, type, Enter → password
  await page.eval(() => document.querySelector('[data-focus="u"]').focus());
  await page.type('alice');
  await page.key('Enter');
  await waitFocus(page, 'p');
  await page.type('alice-pw');
  await page.key('Enter'); // Keys.svelte submits on Enter in the password field
  await page.waitFor(() => document.querySelector('.screen.home'), { what: 'Home after sign-in', timeout: 10000 });
  await waitFocus(page, 'tab-home');

  const auth = srv.requests({ path: '/Users/AuthenticateByName' });
  assert.equal(auth.length, 1, 'one AuthenticateByName');
  const saved = await page.eval(() => ({ token: localStorage.getItem('reel.token'), user: localStorage.getItem('reel.userName'), server: localStorage.getItem('reel.server') }));
  assert(saved.token && srv.world.tokens.has(saved.token), 'saved token is the one the server issued');
  assert.equal(saved.user, 'alice');
  assert.equal(saved.server, srv.urls.jf);
  assert.deepEqual(await checkFocusInvariants(page, { dupOk: ['tile-'] }), [], 'focus invariants on Home');
});

test('tv login: a wrong password says so and keeps focus on the form', { fast: true, ...SIGNED_OUT_BOOT, allowErrors: [...SIGNED_OUT_BOOT.allowErrors, /status of 401 .*\/Users\/AuthenticateByName/] }, async (t) => {
  const { page } = t;
  await bootTv(t, { signedIn: false });
  await page.waitFor(() => document.querySelector('.screen.login [data-focus="u"]'), { what: 'login form' });
  await page.eval(() => document.querySelector('[data-focus="u"]').focus());
  await page.type('alice');
  await page.key('Enter');
  await waitFocus(page, 'p');
  await page.type('nope');
  await page.key('Enter');
  await page.waitFor(() => /Wrong username or password/.test(document.querySelector('.screen.login .err')?.textContent || ''), { what: 'error line' });
  assert((await screen(page)).screen === 'login', 'still on Login');
  assert((await focused(page)) !== '<body>', 'focus not on body');
});
