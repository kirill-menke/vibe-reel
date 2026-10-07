/* TV quota-full Add (run/design.md §6.5, §9.7 TV 4–6): LookupDetail asks GET
 * /api/me (after its own work) and, for a normal user at the limit, its Add
 * button — the same lk-add element — reads "Quota full (10/10 shows)", greyed;
 * OK only says why and sends nothing. The other kind still adds, and the avatar
 * summary counts it at once. When the server disagrees (the client saw 9/10,
 * the server is at 10/10) the 409 quota_exceeded is not "already added": the
 * toast quotes the server's numbers and the button turns "Quota full". An
 * admin is never full. */
import { test, assert } from '../lib/runner.mjs';
import { bootTv, waitFocus, focused, steer, checkFocusInvariants } from '../lib/tv.mjs';

/* nicole has no profile picture (the avatar falls back to her initial on the 404) */
const NO_PIC = /status of 404 .*\/UserImage\?userId=[0-9a-f]{32}&/;
/* an old reel-api answers /api/me with FastAPI's 404 */
const OLD_ME = /status of 404 .*\/api\/me$/;

const toastText = (page) => page.eval(() => (document.querySelector('#toast.show') ? document.getElementById('toast').textContent.trim() : null));
const addText = (page) => page.eval(() => document.querySelector('[data-focus="lk-add"]')?.textContent.trim() || null);
const posts = (srv) => srv.requests({ origin: 'ml', method: 'POST', path: '/api/library' });

async function until(fn, what, timeout = 8000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeout) throw new Error('timed out after ' + timeout + ' ms: ' + what);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/* ▲ → Search, its keyboard (cleared), USB-type `q`, Done, then OK on `key` →
 * LookupDetail. Queries are picked to match few titles ("station": Hidden
 * Station only; "iron tide": Iron Tide + the library's The Iron Tide), so the
 * card is near the top of the results. */
async function openFromSearch(page, q, key) {
  if (!(await page.eval(() => document.getElementById('search')?.classList.contains('on')))) {
    await page.key('Up', { settle: 300 });
    await page.waitFor(() => document.getElementById('search')?.classList.contains('on'), { what: 'Search up' });
  }
  await steer(page, 'q2', { settle: 150 });
  await page.key('OK', { settle: 200 });
  await page.waitFor(() => document.activeElement?.dataset?.focus?.startsWith('kb-'), { what: 'the keyboard open' });
  await steer(page, 'kb-clear');
  await page.key('OK', { settle: 150 });
  await page.chars(q);
  await page.waitFor((k) => document.querySelector(`#search [data-focus="${k}"]`), { what: key + ' among the results', timeout: 10000 }, key);
  await steer(page, 'kb-done');
  await page.key('OK', { settle: 250 });
  await page.waitFor(() => !document.querySelector('#search .skb'), { what: 'keyboard folded' });
  await steer(page, key, { settle: 120 });
  await page.key('OK', { settle: 400 });
  await waitFocus(page, 'lk-add', 10000);
}

async function backToTabs(page) {
  for (let i = 0; i < 4 && !(await focused(page)).startsWith('tab-'); i++) await page.key('Back', { settle: 400 });
  assert((await focused(page)).startsWith('tab-'), 'back on the tab row');
}

test('tv quota: nicole at 10/10 shows — a show’s Add reads "Quota full (10/10 shows)" and sends nothing; a movie at 3/10 adds and the summary says 4 of 10', { fast: false, allowErrors: [NO_PIC], timeout: 120000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  w.ml.fill('nicole', 'tv', 10);
  w.ml.fill('nicole', 'movie', 3);
  await bootTv(t, { user: 'nicole' });
  await waitFocus(page, 'tab-home', 10000);

  await t.step('Hidden Station (not added): Add turns into "Quota full (10/10 shows)" once /api/me answered', async () => {
    await openFromSearch(page, 'station', 'lk-tv-400003');
    await page.waitFor(() => document.querySelector('[data-focus="lk-add"]')?.textContent.trim() === 'Quota full (10/10 shows)', { what: 'the quota-full button', timeout: 8000 });
    assert.equal(await focused(page), 'lk-add', 'focus stayed on the (same) button');
    assert(await page.eval(() => document.querySelector('[data-focus="lk-add"]').classList.contains('stat')), 'greyed like a status');
    assert.equal(await page.eval(() => document.querySelector('.screen .lkhint')?.textContent.trim()), 'Delete a title in My library to make room.');
    await page.key('OK', { settle: 300 });
    await page.waitFor(() => /^You have 10 of 10 shows\. Delete one in My library/.test(document.querySelector('#toast.show')?.textContent || ''), { what: 'the toast', timeout: 3000 });
    assert.equal(posts(srv).length, 0, 'no POST /api/library');
    assert.equal(await addText(page), 'Quota full (10/10 shows)', 'still full');
    assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants');
  });

  await t.step('Iron Tide (a movie, 3/10): Add goes through', async () => {
    await page.key('Back', { settle: 400 });
    await waitFocus(page, 'lk-tv-400003');
    await openFromSearch(page, 'iron tide', 'lk-movie-900002');
    assert.equal(await addText(page), 'Add to library');
    await page.key('OK', { settle: 300 });
    await until(() => posts(srv).length === 1, 'the POST');
    assert.equal(w.ml.owners.get('movie:900002')?.owner, w.nicole.Id, 'recorded as nicole’s');
    await page.waitFor(() => /Added — “Iron Tide” is downloading/.test(document.querySelector('#toast.show')?.textContent || ''), { what: 'the add toast', timeout: 3000 });
  });

  await t.step('the avatar summary counts it: 4 of 10 movies · 10 of 10 shows', async () => {
    await backToTabs(page);
    await steer(page, 'nav-account', { settle: 150 });
    await page.key('OK', { settle: 300 });
    await page.waitFor(() => document.querySelector('[data-focus="ac-mylib"] .acsub')?.textContent.trim() === '4 of 10 movies · 10 of 10 shows', { what: 'summary 4 of 10', timeout: 8000 });
  });
});

test('tv quota: the server disagrees (client 9/10, server 10/10) — 409 quota_exceeded toasts the server’s numbers, the button turns "Quota full", nothing is "added"', { fast: false, allowErrors: [NO_PIC, /status of 409 .*\/api\/library$/], timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  w.ml.fill('nicole', 'movie', 9);
  await bootTv(t, { user: 'nicole' });
  await waitFocus(page, 'tab-home', 10000);
  // the avatar menu asks /api/me: 9 of 10
  await steer(page, 'nav-account', { settle: 150 });
  await page.key('OK', { settle: 300 });
  await page.waitFor(() => document.querySelector('[data-focus="ac-mylib"] .acsub')?.textContent.trim() === '9 of 10 movies · 0 of 10 shows', { what: 'summary 9 of 10', timeout: 8000 });
  await page.key('Back', { settle: 300 });
  // another device fills the last slot
  w.ml.fill('nicole', 'movie', 1);
  await waitFocus(page, 'nav-account');
  await steer(page, 'tab-home', { settle: 150 });
  await openFromSearch(page, 'iron tide', 'lk-movie-900002');
  assert.equal(await addText(page), 'Add to library', 'the client still thinks there is room (its answer is < 60 s old)');
  await page.key('OK', { settle: 300 });
  await until(() => posts(srv).some((e) => e.status === 409), 'the refused POST');
  await page.waitFor(() => document.querySelector('#toast.show')?.textContent.trim() === 'Quota full (10/10 movies) — delete one in My library to add another', { what: 'the quota toast', timeout: 3000 });
  await page.waitFor(() => document.querySelector('[data-focus="lk-add"]')?.textContent.trim() === 'Quota full (10/10 movies)', { what: 'the button turned', timeout: 3000 });
  assert.equal(await focused(page), 'lk-add', 'focus back on the button');
  assert.equal(w.ml.lookup('movie', '900002').added, false, 'nothing was added');
  assert(!(await page.eval(() => document.querySelector('[data-focus="lk-stat"]'))), 'no "In your library" status');
  assert.equal(posts(srv).length, 1, 'one POST');
  assert.equal(await toastText(page), 'Quota full (10/10 movies) — delete one in My library to add another');
});

test('tv quota: kirill (admin, 12 movies) is never full — Add goes through', { fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  w.ml.fill('kirill', 'movie', 12);
  await bootTv(t, { user: 'kirill' });
  await waitFocus(page, 'tab-home', 10000);
  await openFromSearch(page, 'iron tide', 'lk-movie-900002');
  await until(() => srv.requests({ origin: 'ml', method: 'GET', path: /^\/api\/me$/ }).some((e) => e.status === 200), 'the /api/me answer');
  await page.frames(5);
  assert.equal(await addText(page), 'Add to library');
  await page.key('OK', { settle: 300 });
  await until(() => posts(srv).some((e) => e.status === 202), 'the add');
  assert.equal(w.ml.owners.get('movie:900002')?.owner, w.kirill.Id);
});

test('tv quota: an old reel-api (no /api/me) — Add works as before, no client-side check', { fast: false, allowErrors: [NO_PIC, OLD_ME], timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  w.ml.oldBackend = true;
  w.ml.fill('nicole', 'movie', 10); // an old backend has no quota
  await bootTv(t, { user: 'nicole' });
  await waitFocus(page, 'tab-home', 10000);
  await openFromSearch(page, 'iron tide', 'lk-movie-900002');
  await until(() => srv.requests({ origin: 'ml', method: 'GET', path: /^\/api\/me$/ }).some((e) => e.status === 404), 'the /api/me 404');
  await page.frames(5);
  assert.equal(await addText(page), 'Add to library');
  await page.key('OK', { settle: 300 });
  await until(() => posts(srv).some((e) => e.status === 202), 'the add');
  await page.frames(5);
  assert.equal(srv.requests({ origin: 'ml', method: 'GET', path: /^\/api\/me$/ }).length, 1, 'never asked again');
});
