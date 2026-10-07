/* Phone: sign-in by password (Login is a full-screen modal while signed out),
 * wrong password, an unreachable server and its folded Server field, and the
 * Accounts sheet from the top bar's avatar (list, Sign out → Logout → Login).
 * Every request stays on the phone's one origin (/jf, /ml). */
import { test, assert } from '../lib/runner.mjs';
import { bootPhone } from '../lib/phone.mjs';

/* A signed-out phone start sends nothing without a session: the shell isn't
 * mounted until a token exists, so unlike the TV (F-001, SIGNED_OUT_BOOT) there
 * are no 401s and no empty-userId /UserImage to allow. Verified: with no
 * allowance, the three tests below see no other console error or violation;
 * the only one is the 401 the wrong-password test provokes itself. */
const SIGNED_OUT = { app: 'phone' };
const WRONG_PASSWORD = { allowErrors: [/status of 401 .*\/jf\/Users\/AuthenticateByName$/] }; // provoked by the test

const loginUp = (page) => page.waitFor(() => {
  const f = document.querySelector('.login .form');
  return f && f.checkVisibility() && !!document.querySelector('.login input[autocomplete="username"]');
}, { what: 'Login modal', timeout: 10000 });

/* focus an input the way a finger does (touch tap), then type like the iOS keyboard */
async function fill(page, css, text) {
  await page.tapSel(css);
  await page.waitFor((css) => document.activeElement === document.querySelector(css), { what: 'focus on ' + css }, css);
  await page.eval((css) => document.querySelector(css).select?.(), css);
  await page.type(text);
}

async function signIn(page, user, pw) {
  await fill(page, '.login input[autocomplete="username"]', user);
  await fill(page, '.login input[autocomplete="current-password"]', pw);
  await page.tapSel('.login button[type="submit"]');
}

const homeUp = (page) => page.waitFor(() =>
  !document.querySelector('.login') && document.querySelectorAll('.tabbar .tabbar__item').length === 4 &&
  [...document.querySelectorAll('.rail__title')].some((h) => /Continue Watching/.test(h.textContent)),
{ what: 'Home after sign-in', timeout: 15000 });

/* every request of the run went to the phone origin's own host */
function assertOneOrigin(srv) {
  const phoneHost = new URL(srv.urls.phone).host;
  // /__fixture/ images stand in for the arr's third-party poster CDNs (TMDB/TVDB
  // URLs in production), so they are absolute URLs on the fake's ml origin
  const off = srv.log.filter((e) => !e.path.startsWith('/__fixture/') && (e.host !== phoneHost || (e.origin !== 'jf' && e.origin !== 'ml')));
  assert.deepEqual(off.map((e) => e.origin + ' ' + e.host + ' ' + e.path), [], 'every request went to the phone origin via /jf or /ml');
}

test('phone login: signed out → Login modal; password sign-in sends the iPhone auth header and lands on Home', { ...SIGNED_OUT, fast: true }, async (t) => {
  const { page, srv } = t;
  await bootPhone(t, { signedIn: false });
  await loginUp(page);
  // the shell (tab bar) isn't up behind a signed-out Login
  assert.equal(await page.eval(() => document.querySelectorAll('.tabbar .tabbar__item').length), 0, 'no tab bar while signed out');
  // the Server field is folded: the button names this origin's host
  const srvBtn = await page.eval(() => document.querySelector('.login__server')?.textContent.trim());
  assert.equal(srvBtn, 'Server · ' + new URL(srv.urls.phone).host, 'server folded under its host');

  await signIn(page, 'alice', 'alice-pw');
  await homeUp(page);

  const auth = srv.requests({ path: '/Users/AuthenticateByName', method: 'POST' });
  assert.equal(auth.length, 1, 'one AuthenticateByName');
  assert.equal(auth[0].origin, 'jf');
  assert.equal(auth[0].status, 200);
  assert.equal(auth[0].auth?.Device, 'iPhone', 'Device="iPhone" in the Authorization header');
  assert.equal(auth[0].auth?.Client, 'Reel');
  assert.equal(auth[0].auth?.token, false, 'no token sent with the sign-in');
  const saved = await page.eval(() => ({ token: localStorage.getItem('reel.token'), user: localStorage.getItem('reel.userName'), server: localStorage.getItem('reel.server'), accounts: JSON.parse(localStorage.getItem('reel.accounts') || '[]').map((a) => a.userName) }));
  assert(saved.token && srv.world.tokens.has(saved.token), 'saved token is the one the server issued');
  assert.equal(saved.user, 'alice');
  assert.deepEqual(saved.accounts, ['alice'], 'account remembered');
  // Home's later calls carry that token with the same device id
  const resume = srv.requests({ path: '/UserItems/Resume' }).at(-1);
  assert(resume && resume.status === 200 && resume.auth?.token && resume.auth.Device === 'iPhone', 'Resume authorised as the iPhone');
  assert.equal(resume.auth.DeviceId, auth[0].auth.DeviceId, 'one DeviceId for the session');
  assertOneOrigin(srv);
});

test('phone login: wrong password says so and stays on Login; an unreachable server unfolds the Server field; Try again signs in', { ...SIGNED_OUT, allowErrors: [...WRONG_PASSWORD.allowErrors, /status of 503 .*\/jf\/Users\/AuthenticateByName$/] }, async (t) => {
  const { page, srv } = t;
  await bootPhone(t, { signedIn: false });
  await loginUp(page);

  // empty username: a local hint, no request
  await page.tapSel('.login button[type="submit"]');
  await page.waitFor(() => /Enter your username/.test(document.querySelector('.login .field__hint')?.textContent || ''), { what: 'username hint' });
  assert.equal(srv.requests({ path: '/Users/AuthenticateByName' }).length, 0, 'nothing sent without a username');

  await signIn(page, 'alice', 'nope');
  await page.waitFor(() => /Wrong username or password/.test(document.querySelector('.login .field--error .field__hint')?.textContent || ''), { what: 'wrong password hint' });
  assert.equal(srv.requests({ path: '/Users/AuthenticateByName' }).at(-1).status, 401);
  assert(await page.eval(() => !!document.querySelector('.login') && !localStorage.getItem('reel.token')), 'still on Login, no token');
  // the password is selected for retyping (pwEl.select())
  assert(await page.eval(() => {
    const p = document.querySelector('.login input[autocomplete="current-password"]');
    return document.activeElement === p && p.selectionStart === 0 && p.selectionEnd === p.value.length;
  }), 'password field focused and selected');

  // the server is down: the Server field unfolds with this origin's /jf, and the button turns into Try again
  const f = srv.fault({ origin: 'jf', path: '/Users/AuthenticateByName' }, { status: 503, text: 'down' });
  await fill(page, '.login input[autocomplete="current-password"]', 'alice-pw');
  await page.tapSel('.login button[type="submit"]');
  await page.waitFor(() => /Couldn’t reach the server/.test(document.querySelector('.login .field--error .field__hint')?.textContent || ''), { what: 'server hint' });
  const st = await page.eval(() => ({ server: document.querySelector('.login input[type="url"]')?.value, btn: document.querySelector('.login button[type="submit"]').textContent.trim(), folded: !!document.querySelector('.login__server') }));
  assert.equal(st.server, srv.urls.phone + '/jf', 'Server field shows the default /jf');
  assert.equal(st.btn, 'Try again');
  assert.equal(st.folded, false, 'the Server button is gone once the field is shown');
  assert.equal(f.hits, 1);

  f.remove();
  await page.tapSel('.login button[type="submit"]');
  await homeUp(page);
  assert.equal(await page.eval(() => localStorage.getItem('reel.server')), srv.urls.phone + '/jf', 'server stays the phone origin');
  assertOneOrigin(srv);
});

test('phone accounts: the avatar opens the Accounts sheet; Sign out confirms, sends /Sessions/Logout and returns to Login', { ...SIGNED_OUT, fast: false }, async (t) => {
  const { page, srv } = t;
  await bootPhone(t, { signedIn: false });
  await loginUp(page);
  await signIn(page, 'alice', 'alice-pw');
  await homeUp(page);
  const token = await page.eval(() => localStorage.getItem('reel.token'));

  await page.tapSel('.avatarbtn');
  const rows = await page.waitFor(() => {
    const s = [...document.querySelectorAll('.sheet')].find((x) => x.checkVisibility() && /Accounts/.test(x.textContent));
    if (!s) return null;
    const r = [...s.querySelectorAll('[role="radio"]')].map((x) => ({ title: x.querySelector('.row__title')?.textContent.trim(), sub: x.querySelector('.row__sub')?.textContent.trim(), checked: x.getAttribute('aria-checked') }));
    return r.length ? { rows: r, label: s.querySelector('.group__label')?.textContent.trim(), text: s.textContent } : null;
  }, { what: 'Accounts sheet', timeout: 8000 });
  assert.deepEqual(rows.rows, [{ title: 'alice', sub: 'Signed in', checked: 'true' }], 'one account, current');
  assert.equal(rows.label, 'On this iPhone · ' + new URL(srv.urls.phone).host);
  assert(/Add account/.test(rows.text) && /Sign out of alice/.test(rows.text), 'Add account + Sign out rows');

  // Sign out asks first (ACT-01); Cancel keeps the session
  const tapRow = (re) => page.eval((src) => {
    const s = [...document.querySelectorAll('.sheet')].find((x) => x.checkVisibility() && /Accounts/.test(x.textContent));
    const el = [...s.querySelectorAll('button, [role="button"]')].find((b) => new RegExp(src).test(b.textContent));
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, re.source).then((p) => page.tap(p.x, p.y));
  await tapRow(/Sign out of alice/);
  const settled = () => page.waitFor(() => {
    const b = document.querySelector('.actsheet:not([inert]) .actsheet__box');
    return b && b.getAnimations().every((a) => a.playState !== 'running');
  }, { what: 'confirm sheet settled' });
  await page.waitFor(() => document.querySelector('.actsheet:not([inert]) .actsheet__title')?.textContent === 'Sign out of alice?', { what: 'confirm sheet' });
  await settled();
  assert.equal(await page.eval(() => document.activeElement?.classList.contains('actsheet__btn--cancel')), true, 'focus on Cancel, the safe default');
  assert.equal(await page.eval(() => document.querySelector('.actsheet__msg')?.textContent), 'Signing back in needs the password.');
  await page.tapSel('.actsheet__btn--cancel');
  await page.waitFor(() => !document.querySelector('.actsheet'), { what: 'confirm dismissed' });
  assert.equal(srv.requests({ path: '/Sessions/Logout' }).length, 0, 'Cancel: no logout');

  await tapRow(/Sign out of alice/);
  await page.waitFor(() => document.querySelector('.actsheet:not([inert]) .actsheet__btn--danger')?.textContent === 'Sign Out', { what: 'confirm sheet again' });
  await settled();
  try {
    await page.tapSel('.actsheet__btn--danger');
  } catch (e) {
    if (!/navigated|closed|context/i.test(String(e.message))) throw e; // signOut() reloads the app
  }
  await loginUp(page);
  const out = srv.requests({ path: '/Sessions/Logout', method: 'POST' });
  assert.equal(out.length, 1, 'one /Sessions/Logout');
  assert.equal(out[0].status, 204);
  assert(!srv.world.tokens.has(token), 'token revoked on the server');
  const ls = await page.eval(() => ({ token: localStorage.getItem('reel.token'), accounts: localStorage.getItem('reel.accounts') }));
  assert(!ls.token, 'token cleared');
  assert.equal(ls.accounts, '[]', 'account forgotten');
  assertOneOrigin(srv);
});
