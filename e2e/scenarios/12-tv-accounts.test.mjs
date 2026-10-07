/* TV accounts (account.svelte.js, Login.svelte's add-account mode, App.svelte's
 * onAuthLost). reel.accounts remembers every session signed in on the TV;
 * adding, switching and signing out all reload the app into the account that
 * is current afterwards. A user without a profile picture gets /UserImage 404
 * and wears their initial. A token Jellyfin revoked mid-session: the first 401
 * is confirmed with GET /Users/{id}, then a toast and Login. */
import { test, assert } from '../lib/runner.mjs';
import { bootTv, waitSplashGone, waitFocus, focused, steer, checkFocusInvariants, SIGNED_OUT_BOOT } from '../lib/tv.mjs';

const lsJson = (page, k) => page.eval((k) => JSON.parse(localStorage.getItem(k) || 'null'), k);
const session = (page) => page.eval(() => ({ userId: localStorage.getItem('reel.userId'), userName: localStorage.getItem('reel.userName'), token: localStorage.getItem('reel.token') }));

/* the app reloads itself: mark the document, run the action, wait for a fresh one */
async function expectReload(page, action) {
  await page.eval(() => (window.__e2eOld = 1));
  try {
    await action();
  } catch (e) {
    // the key's frame wait can race the reload it triggered
    if (!/navigated or closed|context was destroyed|Cannot find (default execution )?context/i.test(e.message)) throw e;
  }
  await page.waitFor(() => window.__e2eOld === undefined && document.readyState !== 'loading', { what: 'the app reloaded', timeout: 10000 });
  await waitSplashGone(page);
}

async function openAvatar(page, current) {
  for (let i = 0; i < 6 && !/^(tab-|nav-)/.test(await focused(page)); i++) await page.key('Up', { settle: 250 });
  await steer(page, 'nav-account', { settle: 150 });
  await page.key('OK', { settle: 300 });
  await waitFocus(page, 'ac-' + current);
}

async function signInForm(page, user, pw) {
  await page.waitFor(() => document.querySelector('.screen.login [data-focus="u"]'), { what: 'login form' });
  // set-up only: the form's own Enter chain is what is under test (as in 10-tv-login)
  await page.eval(() => document.querySelector('[data-focus="u"]').focus());
  await page.type(user);
  await page.key('Enter');
  await waitFocus(page, 'p');
  if (pw) await page.type(pw);
  await page.key('Enter');
}

const users = (w) => Object.fromEntries([...w.users.values()].map((u) => [u.Name, u]));

test('tv accounts: add account (Back keeps alice), sign in bob → reload into bob, initial avatar on 404, switch back in one press, sign out each → Login', {
  fast: false, timeout: 120000,
  allowErrors: [...SIGNED_OUT_BOOT.allowErrors, /status of 404 .*\/UserImage\?userId=[0-9a-f]{32}&/],
  allowViolations: SIGNED_OUT_BOOT.allowViolations
}, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const { alice, bob } = users(w);
  assert(alice && bob, 'seed users');

  await bootTv(t);
  await waitFocus(page, 'tab-home', 10000);

  await t.step('Add account opens Login "Add an account"; Back returns to Home as alice', async () => {
    await openAvatar(page, alice.Id);
    await steer(page, 'ac-add', { settle: 150 });
    await page.key('OK', { settle: 300 });
    await page.waitFor(() => document.querySelector('.screen.login'), { what: 'Login', timeout: 8000 });
    const sub = await page.eval(() => document.querySelector('.screen.login .sub')?.textContent.trim());
    assert.equal(sub, 'Add an account — ' + srv.urls.jf);
    assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants on Login');
    await page.key('Back', { settle: 400 });
    await page.waitFor(() => document.querySelector('.screen.home'), { what: 'Home after Back', timeout: 8000 });
    await page.waitFor(() => document.activeElement && document.activeElement !== document.body, { what: 'focus on Home' });
    assert.equal((await session(page)).userId, alice.Id, 'still alice');
  });

  await t.step('signing in as bob reloads into bob: empty Home, initial avatar, both accounts remembered', async () => {
    await openAvatar(page, alice.Id);
    await steer(page, 'ac-add', { settle: 150 });
    await page.key('OK', { settle: 300 });
    await expectReload(page, () => signInForm(page, 'bob', ''));
    await page.waitFor(() => /Nothing to continue yet/.test(document.querySelector('.screen.home .homeempty')?.textContent || ''), { what: "bob's empty Home", timeout: 10000 });
    const s = await session(page);
    assert.equal(s.userId, bob.Id);
    assert.equal(s.userName, 'bob');
    assert(w.tokens.get(s.token)?.userId === bob.Id, "bob's token is live on the server");
    const acc = await lsJson(page, 'reel.accounts');
    assert.deepEqual(acc.map((a) => a.userName), ['alice', 'bob']);
    assert(acc.every((a) => a.server === srv.urls.jf && w.tokens.has(a.token)), 'both tokens remembered and valid');
    // no profile picture: /UserImage 404 → the initial
    await page.waitFor(() => document.querySelector('[data-focus="nav-account"] span')?.textContent.trim() === 'B', { what: 'initial B on the avatar', timeout: 8000 });
    assert(srv.requests({ origin: 'jf', path: '/UserImage' }).some((e) => e.search.includes(bob.Id) && e.status === 404), 'the picture request 404d');
    assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants on the empty Home');
  });

  await t.step("bob's account menu: alice with her picture, bob (current) with his initial; one press switches back + reload", async () => {
    await openAvatar(page, bob.Id);
    const rows = await page.eval(() => [...document.querySelectorAll('.screen .lvmenu.account .acrow')].slice(0, 2).map((r) => ({ key: r.dataset.focus, sel: r.classList.contains('sel'), img: !!r.querySelector('.acpic img'), pic: r.querySelector('.acpic').textContent.trim() })));
    assert.deepEqual(rows, [{ key: 'ac-' + alice.Id, sel: false, img: true, pic: '' }, { key: 'ac-' + bob.Id, sel: true, img: false, pic: 'B' }]);
    await page.key('Up', { settle: 150 });
    assert.equal(await focused(page), 'ac-' + alice.Id);
    const auth0 = srv.requests({ path: /^\/Users\/Authenticate/ }).length;
    await expectReload(page, () => page.key('OK'));
    await page.waitFor(() => document.querySelector('.screen.home .hero'), { what: "alice's Home with a hero", timeout: 10000 });
    assert.equal((await session(page)).userId, alice.Id);
    assert.equal(srv.requests({ path: /^\/Users\/Authenticate/ }).length, auth0, 'no new sign-in: the remembered token');
  });

  await t.step('sign out alice → POST /Sessions/Logout revokes her token, carries on as bob', async () => {
    await page.waitFor(() => document.activeElement && document.activeElement !== document.body, { what: "focus on alice's Home", timeout: 8000 });
    const tok = (await session(page)).token;
    await openAvatar(page, alice.Id);
    await steer(page, 'ac-out', { settle: 150 });
    assert.equal(await page.eval(() => document.activeElement.textContent.trim()), 'Sign out alice');
    await expectReload(page, () => page.key('OK'));
    const lo = srv.requests({ origin: 'jf', method: 'POST', path: '/Sessions/Logout' });
    assert.equal(lo.length, 1, 'one Logout');
    assert(!w.tokens.has(tok), "alice's token revoked on the server");
    assert.equal((await session(page)).userId, bob.Id, 'the next remembered account');
    assert.deepEqual((await lsJson(page, 'reel.accounts')).map((a) => a.userName), ['bob']);
  });

  await t.step('sign out bob (the last account) → Login', async () => {
    await page.waitFor(() => document.querySelector('.screen.home .homeempty'), { what: "bob's Home", timeout: 10000 });
    await openAvatar(page, bob.Id);
    await steer(page, 'ac-out', { settle: 150 });
    await expectReload(page, () => page.key('OK'));
    await page.waitFor(() => document.querySelector('.screen.login'), { what: 'Login after the last sign-out', timeout: 10000 });
    assert.equal(srv.requests({ origin: 'jf', method: 'POST', path: '/Sessions/Logout' }).length, 2);
    const s = await session(page);
    assert(!s.token && !s.userId, 'no session left: ' + JSON.stringify(s));
    assert.deepEqual(await lsJson(page, 'reel.accounts'), []);
    assert.equal(await page.eval(() => document.querySelector('.screen.login .sub')?.textContent.trim()), 'Sign in to Jellyfin — ' + srv.urls.jf);
  });
});

test('tv accounts: a token revoked mid-session → the next request 401s, GET /Users/{id} confirms, toast + Login', {
  fast: true, timeout: 60000,
  allowErrors: [
    /status of 401 .*\/(Items|Genres)\?/, /status of 401 .*\/Users\/[0-9a-f]{32}(\?|$)/,
    /* reel-api checks the same Jellyfin token, so whatever reaches it between the
     * revocation and Login (the 4 s /api/activity poll, Browse's idle /api/charts)
     * is a legitimate 401 too; how many land depends only on how long that window
     * takes. A token-less request would still fail the test: the fake's guard
     * makes that a violation. Pinned below: none before the revocation. */
    /status of 401 .*:\d+\/api\/[a-z]/
  ]
}, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const { alice } = users(w);
  await bootTv(t);
  await waitFocus(page, 'tab-home', 10000);
  const tok = (await session(page)).token;
  assert(w.tokens.delete(tok), 'revoked server-side');
  const n0 = srv.log.length;
  assert.deepEqual(srv.log.slice(0, n0).filter((e) => e.origin === 'ml' && e.status === 401).map((e) => e.path), [], 'reel-api took the token until it was revoked');
  await steer(page, 'tab-movies', { settle: 150 });
  await page.key('OK', { settle: 300 });
  await page.waitFor(() => document.querySelector('.screen.login'), { what: 'Login', timeout: 10000 });
  await page.waitFor(() => document.getElementById('toast')?.classList.contains('show'), { what: 'toast', timeout: 3000 });
  assert.equal(await page.eval(() => document.getElementById('toast').textContent.trim()), 'Jellyfin signed this TV out — sign in again');
  t.log('reel-api 401s while the token was revoked: ' + (srv.log.slice(n0).filter((e) => e.origin === 'ml' && e.status === 401).map((e) => e.path).join(', ') || 'none'));
  const after = srv.log.slice(n0).filter((e) => e.origin === 'jf');
  const firstItems = after.findIndex((e) => e.path === '/Items' && e.status === 401);
  const confirm = after.findIndex((e) => e.path === '/Users/' + alice.Id && e.status === 401);
  assert(firstItems >= 0, 'the grid request was answered 401: ' + after.map((e) => e.method + ' ' + e.path + ' ' + e.status).join(', '));
  assert(confirm > firstItems, 'confirmed with GET /Users/{id} after the first 401');
  assert.equal(after.filter((e) => e.path === '/Users/' + alice.Id).length, 1, 'one confirmation, not one per failed request');
  await page.waitFor(() => document.activeElement && document.activeElement !== document.body && document.activeElement.closest('.screen.login'), { what: 'focus on Login' });
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants on Login');
});
