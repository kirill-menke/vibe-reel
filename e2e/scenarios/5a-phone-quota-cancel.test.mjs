/* Phone quota-full Add and owner-only Cancel/Undo (run/design.md §7.4–7.5,
 * §9.7 phone 3–6).
 *  - LookupDetail of a normal user at the quota: the gold Add becomes a grey
 *    "Quota full (10/10 movies)" that opens My library, with the reason under
 *    it — nothing is sent. A tile's quick "+" at the quota toasts the same
 *    and sends nothing. When the server knows better (409 quota_exceeded) the
 *    toast quotes its numbers and the button turns.
 *  - Cancel is offered only on the user's own grabs (reel-api's can_cancel):
 *    nicole's pending tile has "Cancel download…" and PendingDetail's Cancel;
 *    a legacy title's (the admins') has neither, nor its episode rows'
 *    long-press. kirill (admin) cancels anything; against an old reel-api
 *    (no can_cancel) everyone gets Cancel as before.
 *  - Undo of an add works for the adder; a 403 not_owner toasts the
 *    server's sentence.
 *
 * Users: nicole (normal), kirill (admin) — e2e/README.md "Ownership and quotas". */
import { test, assert } from '../lib/runner.mjs';
import { addPending } from '../lib/world.mjs';
import { bootPhone, openTab, topHas, tapIn, topRoute } from '../lib/phone.mjs';
import { until } from '../lib/player.mjs';

const NO_PIC = /status of 404 .*\/UserImage\?userId=[0-9a-f]{32}&/;
const OLD_ME = /status of 404 .*\/api\/me$/;

const posts = (srv) => srv.requests({ origin: 'ml', method: 'POST', path: '/api/library' });
const meGets = (srv) => srv.requests({ origin: 'ml', method: 'GET', path: /^\/api\/me$/ });
const cancels = (srv) => srv.requests({ origin: 'ml', method: 'DELETE', path: '/api/activity/' });

const toastSays = (page, re) => page.waitFor((src) => {
  const t = [...document.querySelectorAll('.toast:not(.toast--off) .toast__text')].find((x) => new RegExp(src).test(x.textContent.trim()));
  return t && t.textContent.trim();
}, { what: 'toast ' + re, timeout: 8000 }, re.source);

/* the top route's add slot: the button's text and the note under it */
const addSlot = (page) => page.eval(() => {
  const top = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1);
  return {
    button: top.querySelector('.detail__morph .btn')?.textContent.replace(/\s+/g, ' ').trim() || null,
    note: top.querySelector('.detail__note')?.textContent.trim() || null
  };
});

async function search(page, srv, q) {
  await openTab(page, 'Search');
  await page.tapSel('.search__input');
  await page.waitFor(() => document.activeElement?.classList.contains('search__input'), { what: 'search input focused' });
  if (await page.eval(() => !!document.querySelector('.search__input').value)) {
    await page.tapSel('.search__clear');
    await page.waitFor(() => !document.querySelector('.search__input').value && document.activeElement?.classList.contains('search__input'), { what: 'query cleared' });
  }
  await page.type(q);
  await until(() => srv.requests({ origin: 'ml', path: '/api/lookup' }).filter((e) => new URLSearchParams(e.search).get('q') === q).length >= 2, 'lookups for ' + q, 8000);
}

/* long-press the first visible element matching css whose label/text matches re → the context menu's items */
async function longPress(page, css, re) {
  const p = await page.waitFor((css, src) => {
    const top = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1);
    const el = top && [...top.querySelectorAll(css)].find((b) => b.checkVisibility() && new RegExp(src).test((b.getAttribute('aria-label') || b.textContent).trim()));
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    return b.width ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
  }, { what: `${css} ${re}` }, css, re.source);
  await page.press(p.x, p.y, 750);
  await new Promise((r) => setTimeout(r, 600));
  return page.eval(() => [...document.querySelectorAll('.ctx [role="menuitem"]')].filter((e) => e.checkVisibility()).map((e) => e.textContent.trim()));
}

/* close an open context menu (tap its backdrop) */
async function closeMenu(page) {
  if (!(await page.eval(() => !!document.querySelector('.ctx')))) return;
  await page.waitFor(() => [...document.querySelectorAll('.ctx__menu')].every((m) => m.getAnimations().every((a) => a.playState !== 'running')), { what: 'menu settled', timeout: 5000 });
  await page.key('Escape');
  await page.waitFor(() => !document.querySelector('.ctx'), { what: 'menu closed', timeout: 5000 });
}

const actions = (page) => page.eval(() => [...[...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1).querySelectorAll('button.action')].map((b) => b.textContent.trim()));

async function moviesGrid(page) {
  await openTab(page, 'Movies');
  await page.waitFor(() => document.querySelectorAll('.screen.lib .lib__grid .tile[role="button"]').length >= 12, { what: 'grid', timeout: 10000 });
}

test('phone quota: nicole at 10/10 movies — LookupDetail shows "Quota full (10/10 movies)" and opens My library; a tile’s "+" toasts; nothing is sent', { app: 'phone', fast: false, allowErrors: [NO_PIC], timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  srv.world.ml.fill('nicole', 'movie', 10);
  await bootPhone(t, { user: 'nicole' });
  await until(() => meGets(srv).some((e) => e.status === 200), 'the boot-time /api/me', 10000);
  await search(page, srv, 'iron tide');

  await t.step('the result tile’s quick "+": the quota toast, no request', async () => {
    await tapIn(page, '.srch__grid .tile__add', /^Add Iron Tide to library$/);
    assert.equal(await toastSays(page, /^Quota full/), 'Quota full (10/10 movies) — delete one in My library to add another');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(posts(srv).length, 0, 'no POST /api/library');
  });

  await t.step('LookupDetail: the grey "Quota full" button with the reason; tap → My library', async () => {
    await tapIn(page, '.srch__grid .tile[role="button"]', /^Iron Tide/);
    await topHas(page, '.detail__title');
    await page.waitFor(() => /^Quota full/.test([...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1).querySelector('.detail__morph .btn')?.textContent.trim() || ''), { what: 'the quota-full button', timeout: 8000 });
    assert.deepEqual(await addSlot(page), { button: 'Quota full (10/10 movies)', note: 'You have 10 of 10 movies. Delete one in My library to add another.' });
    await tapIn(page, '.detail__morph .btn', /^Quota full/);
    await topHas(page, '.screen.mylib .list');
    assert.match(await topRoute(page), /^mylibrary/);
    assert.equal(posts(srv).length, 0, 'still no POST');
  });
});

test('phone quota: the server disagrees (client 9/10, server 10/10) — the 409 toasts its numbers, the button turns "Quota full", nothing is "added"', { app: 'phone', fast: false, allowErrors: [NO_PIC, /status of 409 .*\/api\/library$/], timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  w.ml.fill('nicole', 'movie', 9);
  await bootPhone(t, { user: 'nicole' });
  await until(() => meGets(srv).some((e) => e.status === 200), 'the boot-time /api/me', 10000);
  w.ml.fill('nicole', 'movie', 1); // another device takes the last slot
  await search(page, srv, 'iron tide');
  await tapIn(page, '.srch__grid .tile[role="button"]', /^Iron Tide/);
  await topHas(page, '.detail__title');
  assert.equal((await addSlot(page)).button, 'Add to library', 'the client still thinks there is room');
  await tapIn(page, '.detail__morph .btn', /^Add to library$/);
  await until(() => posts(srv).some((e) => e.status === 409), 'the refused POST');
  assert.equal(await toastSays(page, /^Quota full/), 'Quota full (10/10 movies) — delete one in My library to add another');
  await page.waitFor(() => [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1).querySelector('.detail__morph .btn')?.textContent.trim() === 'Quota full (10/10 movies)', { what: 'the button turned', timeout: 5000 });
  assert.equal(w.ml.lookup('movie', '900002').added, false, 'nothing was added');
  assert.equal(posts(srv).length, 1);
});

test('phone cancel: nicole may cancel her own download only — her tile and PendingDetail offer Cancel, a legacy title’s tile, page and episode rows don’t', { app: 'phone', fast: false, allowErrors: [NO_PIC], timeout: 120000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  w.ml.own('movie', '900002', 'nicole');
  addPending(w, { type: 'movie', media_id: '900002', progress: 0.3 });
  await bootPhone(t, { user: 'nicole' });
  await until(() => srv.requests({ origin: 'ml', path: '/api/activity' }).some((e) => e.status === 200), 'an activity answer', 10000);
  await moviesGrid(page);

  await t.step('long-press: her tile has "Cancel download…", the legacy one only "Open"', async () => {
    assert.deepEqual(await longPress(page, '.lib__grid .tile[role="button"]', /^Iron Tide, downloading$/), ['Open', 'Cancel download…']);
    await closeMenu(page);
    assert.deepEqual(await longPress(page, '.lib__grid .tile[role="button"]', /^Glass Meridian Rising, downloading$/), ['Open']);
    await closeMenu(page);
  });

  await t.step('PendingDetail: no Cancel on the legacy title', async () => {
    await tapIn(page, '.lib__grid .tile[role="button"]', /^Glass Meridian Rising, downloading$/);
    await topHas(page, '.btn__pct');
    assert(!(await actions(page)).includes('Cancel'), 'no Cancel action: ' + JSON.stringify(await actions(page)));
    await tapIn(page, '.iconbtn', /^Back/);
    await page.waitFor(() => document.querySelector('.tabbarhost:not([hidden])'), { what: 'back on the grid', timeout: 8000 });
  });

  await t.step('PendingDetail of hers: Cancel → confirmed → 200', async () => {
    await tapIn(page, '.lib__grid .tile[role="button"]', /^Iron Tide, downloading$/);
    await topHas(page, '.btn__pct');
    await tapIn(page, 'button.action', /^Cancel$/);
    await page.waitFor(() => document.querySelector('.actsheet:not([inert]) .actsheet__box')?.getAnimations().every((a) => a.playState !== 'running'), { what: 'confirm sheet', timeout: 8000 });
    await page.tapSel('.actsheet:not([inert]) .actsheet__btn--danger');
    assert.equal(await toastSays(page, /^Cancelled/), 'Cancelled — Iron Tide');
    assert.deepEqual(cancels(srv).map((c) => [c.path, c.status]), [['/api/activity/movie/900002', 200]]);
  });

  await t.step('a legacy show’s queued episode row: no long-press menu', async () => {
    await tapIn(page, '.iconbtn', /^Back/);
    await openTab(page, 'Shows');
    await page.waitFor(() => document.querySelectorAll('.screen.lib .lib__grid .tile[role="button"]').length >= 6, { what: 'grid', timeout: 10000 });
    await tapIn(page, '.lib__grid .tile[role="button"]', /^Paper Lanterns, queued$/);
    await topHas(page, '.episode');
    assert(!(await actions(page)).includes('Cancel'), 'no whole-title Cancel');
    assert.deepEqual(await longPress(page, '.episode', /./), [], 'no menu on the row');
    assert.equal(cancels(srv).length, 1, 'nothing more sent');
  });
});

test('phone cancel: kirill (admin) is offered Cancel on a legacy title', { app: 'phone', fast: false, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  await bootPhone(t, { user: 'kirill' });
  await until(() => srv.requests({ origin: 'ml', path: '/api/activity' }).some((e) => e.status === 200), 'an activity answer', 10000);
  await moviesGrid(page);
  assert.deepEqual(await longPress(page, '.lib__grid .tile[role="button"]', /^Glass Meridian Rising, downloading$/), ['Open', 'Cancel download…']);
  await closeMenu(page);
  await tapIn(page, '.lib__grid .tile[role="button"]', /^Glass Meridian Rising, downloading$/);
  await topHas(page, '.btn__pct');
  assert((await actions(page)).includes('Cancel'), 'Cancel action');
});

test('phone cancel: an old reel-api (no can_cancel, no /api/me) — Cancel offered as before', { app: 'phone', fast: false, allowErrors: [NO_PIC, OLD_ME], timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  srv.world.ml.oldBackend = true;
  await bootPhone(t, { user: 'nicole' });
  await until(() => srv.requests({ origin: 'ml', path: '/api/activity' }).some((e) => e.status === 200), 'an activity answer', 10000);
  await moviesGrid(page);
  assert.deepEqual(await longPress(page, '.lib__grid .tile[role="button"]', /^Glass Meridian Rising, downloading$/), ['Open', 'Cancel download…']);
});

test('phone undo: nicole’s Undo of her own add works; a 403 not_owner toasts the server’s sentence', { app: 'phone', fast: false, allowErrors: [NO_PIC, /status of 403 .*\/api\/library\/movie\/900003\?undo=/], timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  await bootPhone(t, { user: 'nicole' });
  await until(() => meGets(srv).some((e) => e.status === 200), 'the boot-time /api/me', 10000);
  const undos = () => srv.requests({ origin: 'ml', method: 'DELETE', path: '/api/library/' });

  await t.step('add Iron Tide, Undo → 200', async () => {
    await search(page, srv, 'iron tide');
    await tapIn(page, '.srch__grid .tile__add', /^Add Iron Tide to library$/);
    await until(() => posts(srv).some((e) => e.status === 202), 'the add');
    await page.waitFor(() => document.querySelector('.toast:not(.toast--off) .toast__action'), { what: 'toast with Undo' });
    await page.tapSel('.toast .toast__action');
    await until(() => undos().length === 1, 'the undo');
    assert.equal(undos()[0].status, 200);
    assert.equal(w.ml.owners.has('movie:900002'), false, 'her record went with it');
  });

  await t.step('an Undo the server refuses (403 not_owner): its sentence', async () => {
    await page.waitFor(() => !document.querySelector('.toast:not(.toast--off)'), { what: 'toast gone', timeout: 10000 });
    await search(page, srv, 'quiet summit');
    await tapIn(page, '.srch__grid .tile__add', /^Add Quiet Summit to library$/);
    await until(() => posts(srv).filter((e) => e.status === 202).length === 2, 'the second add');
    w.ml.adds.at(-1).user = w.kirill.Id; // as if the token were someone else's
    await page.waitFor(() => document.querySelector('.toast:not(.toast--off) .toast__action'), { what: 'toast with Undo' });
    await page.tapSel('.toast .toast__action');
    assert.equal(await toastSays(page, /^Only/), 'Only the person who added “Quiet Summit” can undo that.');
    assert.equal(undos().at(-1).status, 403);
  });
});
