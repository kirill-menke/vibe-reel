/* TV Login: Quick Connect (approve → Home, a dead code, Quick Connect off)
 * and the two-step Change server button. Login.svelte is the contract:
 * POST /QuickConnect/Initiate → a 2 s poll of GET /QuickConnect/Connect →
 * POST /Users/AuthenticateWithQuickConnect once the code is approved. */
import { test, assert } from '../lib/runner.mjs';
import { bootTv, waitFocus, focused, screen, holds, checkFocusInvariants, SIGNED_OUT_BOOT } from '../lib/tv.mjs';

const qcCode = (page) => page.waitFor(() => (document.querySelector('.qc-code')?.textContent || '').match(/^\d{6}$/)?.[0], { what: 'Quick Connect code', timeout: 8000 });

const withErrors = (...re) => ({ ...SIGNED_OUT_BOOT, allowErrors: [...SIGNED_OUT_BOOT.allowErrors, ...re] });

test('tv quick connect: an approved code signs in and lands on Home', { fast: true, ...SIGNED_OUT_BOOT }, async (t) => {
  const { page, srv } = t;
  await bootTv(t, { signedIn: false });
  const code = await qcCode(page);
  const init = srv.requests({ method: 'POST', path: '/QuickConnect/Initiate' });
  assert.equal(init.length, 1, 'one Initiate');
  assert.equal([...srv.world.quickConnect.values()].find((s) => s.Code === code)?.Code, code, 'the code on screen is the one the server handed out');

  // the poll runs every 2 s while the code is unapproved
  const t0 = Date.now();
  while (srv.requests({ method: 'GET', path: '/QuickConnect/Connect' }).length < 2 && Date.now() - t0 < 6000) await new Promise((r) => setTimeout(r, 100));
  assert(srv.requests({ method: 'GET', path: '/QuickConnect/Connect' }).length >= 2, 'the code is polled');
  assert.equal(srv.requests({ path: '/Users/AuthenticateWithQuickConnect' }).length, 0, 'no exchange before approval');

  srv.approveQuickConnect(code, 'alice');
  await page.waitFor(() => document.querySelector('.screen.home'), { what: 'Home after Quick Connect', timeout: 8000 });
  await waitFocus(page, 'tab-home');

  const ex = srv.requests({ method: 'POST', path: '/Users/AuthenticateWithQuickConnect' });
  assert.equal(ex.length, 1, 'one AuthenticateWithQuickConnect');
  assert.equal(ex[0].status, 200, 'exchange answered 200');
  const saved = await page.eval(() => ({ token: localStorage.getItem('reel.token'), user: localStorage.getItem('reel.userName'), uid: localStorage.getItem('reel.userId') }));
  const tok = srv.world.tokens.get(saved.token);
  assert(tok, 'the saved token is one the server issued');
  assert.equal(saved.user, 'alice', 'signed in as the approving user');
  assert.equal(tok.userId, saved.uid, 'token belongs to the saved user id');
  // the secret is spent and polling stopped
  const polls = srv.requests({ method: 'GET', path: '/QuickConnect/Connect' }).length;
  await holds(() => srv.requests({ method: 'GET', path: '/QuickConnect/Connect' }).length === polls, 2600, 'no poll after sign-in (2 s cadence)');
  assert.deepEqual(await checkFocusInvariants(page, { dupOk: ['tile-'] }), [], 'focus invariants on Home');
});

test('tv quick connect: a code the server forgot says it expired and offers a new one', {
  fast: false,
  ...withErrors(/status of 404 .*\/QuickConnect\/Connect\?/)
}, async (t) => {
  const { page, srv } = t;
  await bootTv(t, { signedIn: false });
  const first = await qcCode(page);
  await waitFocus(page, 'u'); // focusFirst() lands on the form, under the code
  // the server forgets the secret (Jellyfin drops it after ~10 min)
  const f = srv.fault({ origin: 'jf', method: 'GET', path: '/QuickConnect/Connect' }, { status: 404, text: 'Unknown secret' });
  await page.waitFor(() => /This code has expired\./.test(document.querySelector('#qc .qc-dead')?.textContent || ''), { what: 'expired note', timeout: 6000 });
  assert(await page.eval(() => !document.querySelector('.qc-code')), 'the dead code is no longer shown');
  const hits = f.hits;
  await holds(() => f.hits === hits, 2500, 'the poll stopped after the 404');
  assert((await focused(page)) !== '<body>', 'focus not on body');
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants with the dead code');

  // ▲ from the username field reaches "Get a new code"; OK asks for a fresh code
  await page.key('Up', { settle: 120 });
  await waitFocus(page, 'qc-new');
  assert.match(await page.eval(() => document.querySelector('[data-focus="qc-new"]').textContent), /Get a new code/);
  f.remove();
  await page.key('OK', { settle: 120 });
  const second = await qcCode(page);
  assert(second !== first, 'a different code');
  assert.equal(srv.requests({ method: 'POST', path: '/QuickConnect/Initiate' }).length, 2, 'two Initiates');
  const fo = await focused(page);
  assert(fo !== '<body>', 'focus not on body after the button went away (got ' + fo + ')');
  assert.equal(fo, 'u', 'focus back on the form');
  // and the new code works
  srv.approveQuickConnect(second);
  await page.waitFor(() => document.querySelector('.screen.home'), { what: 'Home after the second code', timeout: 8000 });
});

test('tv quick connect: disabled on the server shows "unavailable" and Try again', {
  fast: false,
  ...withErrors(/status of 401 .*\/QuickConnect\/Initiate/)
}, async (t) => {
  const { page, srv } = t;
  srv.world.quickConnectEnabled = false;
  await bootTv(t, { signedIn: false });
  await page.waitFor(() => /Quick Connect unavailable/.test(document.getElementById('qc')?.textContent || ''), { what: 'unavailable note' });
  assert.equal(srv.requests({ method: 'POST', path: '/QuickConnect/Initiate' })[0]?.status, 401, 'Initiate answered 401');
  assert.equal(srv.requests({ method: 'GET', path: '/QuickConnect/Connect' }).length, 0, 'nothing to poll');
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants');
  await waitFocus(page, /^(qc-new|u)$/);
  if ((await focused(page)) === 'u') await page.key('Up', { settle: 120 });
  await waitFocus(page, 'qc-new');
  assert.match(await page.eval(() => document.querySelector('[data-focus="qc-new"]').textContent), /Try Quick Connect again/);

  // still off: the same note comes back
  await page.key('OK', { settle: 150 });
  await page.waitFor(() => /Quick Connect unavailable/.test(document.getElementById('qc')?.textContent || ''), { what: 'unavailable again' });
  assert.equal(srv.requests({ method: 'POST', path: '/QuickConnect/Initiate' }).length, 2, 'retried');
  assert((await focused(page)) !== '<body>', 'focus not on body after a failed retry');

  // switched on: Try again shows a code
  srv.world.quickConnectEnabled = true;
  if ((await focused(page)) !== 'qc-new') {
    await page.key('Up', { settle: 120 });
    await waitFocus(page, 'qc-new');
  }
  await page.key('OK', { settle: 120 });
  await qcCode(page);
  assert((await focused(page)) !== '<body>', 'focus not on body');
});

/* ▼ from the password field onto the button row (geometry picks Sign in or
 * Change server, whichever is nearer), then ▶ if it was Sign in */
async function toServerButton(page) {
  await page.key('Down', { settle: 100 });
  const f = await waitFocus(page, /^(login|server)$/);
  if (f === 'login') await page.key('Right', { settle: 100 });
  await waitFocus(page, 'server');
}

test('tv login: Change server reveals the field, then applies it and re-initiates Quick Connect', { fast: false, ...SIGNED_OUT_BOOT }, async (t) => {
  const { page, srv } = t;
  await bootTv(t, { signedIn: false });
  await qcCode(page);
  await waitFocus(page, 'u');
  assert(await page.eval(() => !document.querySelector('[data-focus="srv"]')), 'no server field at first');

  // D-pad to "Change server" (▼ from the password field lands on the button row)
  await page.key('Down', { settle: 100 });
  await waitFocus(page, 'p');
  await toServerButton(page);

  await page.key('OK', { settle: 150 });
  await waitFocus(page, 'srv'); // first press: the field appears, focused
  const shown = await page.eval(() => document.querySelector('[data-focus="srv"]').value);
  assert.equal(shown, srv.urls.jf, 'the field starts with the current server');
  assert.equal(await page.eval(() => document.querySelector('.screen.login .sub')?.textContent),
    'Sign in to Jellyfin — ' + srv.urls.jf, 'the header names the current server');
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants with the server field');

  // the same fake Jellyfin, under another name: requests must follow the new value
  const next = srv.urls.jf.replace('127.0.0.1', 'localhost');
  assert(next !== srv.urls.jf, 'a distinct server URL');
  await page.eval(() => document.querySelector('[data-focus="srv"]').select());
  await page.type(next);
  const initBefore = srv.requests({ method: 'POST', path: '/QuickConnect/Initiate' }).length;

  // back to the button by D-pad: srv → u → p → the button row
  await page.key('Down', { settle: 100 });
  await waitFocus(page, 'u');
  await page.key('Down', { settle: 100 });
  await waitFocus(page, 'p');
  await toServerButton(page);
  await page.key('OK', { settle: 150 });
  await page.waitFor((u) => document.querySelector('#toast.show')?.textContent === 'Server: ' + u, { what: 'toast names the new server' }, next);
  // the "Sign in to Jellyfin — <server>" line follows the change (it kept the old URL: F-007)
  await page.waitFor((u) => document.querySelector('.screen.login .sub')?.textContent === 'Sign in to Jellyfin — ' + u,
    { what: 'the header names the new server (F-007)' }, next);
  const saved = await page.eval(() => localStorage.getItem('reel.server'));
  assert.equal(saved, next, 'reel.server saved');
  await qcCode(page);
  const inits = srv.requests({ method: 'POST', path: '/QuickConnect/Initiate' });
  assert.equal(inits.length, initBefore + 1, 'Quick Connect re-initiated');
  assert.equal(inits.at(-1).host, next.replace(/^https?:\/\//, ''), 'Initiate went to the new server');
  assert.equal((await screen(page)).screen, 'login', 'still on Login');
  assert((await focused(page)) !== '<body>', 'focus not on body');
});
