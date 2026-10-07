/* Phone "My library" (run/design.md §7.1–7.3, §9.7 phone 1, 2, 6): the
 * Accounts sheet (and Settings) get a "My library" row — shown once GET
 * /api/me answered — with the quota summary ("3 of 10 movies · 10 of 10
 * shows", an admin "Admin · no limit"). It pushes the mylibrary route: a bar
 * per kind ("3 of 10", a full one says so), then the user's own titles
 * (poster, title, status — live from the activity feed) each with a trash
 * button. Trash asks in the iOS action sheet (focus on Keep); Keep sends
 * nothing; Delete sends exactly one DELETE /api/library/{type}/{id}
 * ?delete_files=true, the row goes, the slot is free at once. An admin sees
 * "Admin · No limit" and the titles he added; an old reel-api (404 on
 * /api/me) shows no row anywhere.
 *
 * Users: nicole (normal), kirill (admin) — e2e/README.md "Ownership and quotas". */
import { test, assert } from '../lib/runner.mjs';
import { addPending, movie } from '../lib/world.mjs';
import { bootPhone, topHas, tapIn, sheetUp, topRoute } from '../lib/phone.mjs';
import { until } from '../lib/player.mjs';

/* nicole has no profile picture (the avatar falls back to her initial on the 404) */
const NO_PIC = /status of 404 .*\/UserImage\?userId=[0-9a-f]{32}&/;
/* an old reel-api answers /api/me with FastAPI's 404 */
const OLD_ME = /status of 404 .*\/api\/me$/;

const deletes = (srv) => srv.requests({ origin: 'ml', method: 'DELETE', path: /^\/api\/library\// });
const meGets = (srv) => srv.requests({ origin: 'ml', method: 'GET', path: /^\/api\/me$/ });

const sheetSettled = (page) => page.waitFor(() => {
  const b = document.querySelector('.actsheet:not([inert]) .actsheet__box');
  return b && b.getAnimations().every((a) => a.playState !== 'running') && {
    title: b.querySelector('.actsheet__title')?.textContent.trim(),
    msg: b.querySelector('.actsheet__msg')?.textContent.trim(),
    act: b.querySelector('.actsheet__btn--danger')?.textContent.trim(),
    keep: b.querySelector('.actsheet__btn--cancel')?.textContent.trim(),
    focusKeep: document.activeElement?.classList.contains('actsheet__btn--cancel')
  };
}, { what: 'confirm sheet settled', timeout: 8000 });

const toastSays = (page, re) => page.waitFor((src) => {
  const t = [...document.querySelectorAll('.toast .toast__text')].find((x) => x.checkVisibility() && new RegExp(src).test(x.textContent.trim()));
  return t && t.textContent.trim();
}, { what: 'toast ' + re, timeout: 8000 }, re.source);

/* the Accounts sheet's rows: title + sub */
const sheetRows = (page) => page.eval(() => [...document.querySelectorAll('.sheethost .sheet .row')].map((r) => [r.querySelector('.row__title')?.textContent.trim(), r.querySelector('.row__sub')?.textContent.trim() || '']));

/* the My library screen as the user sees it */
const screen = (page) => page.eval(() => {
  const top = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1);
  const m = top?.querySelector('.screen.mylib');
  if (!m) return null;
  return {
    labels: [...m.querySelectorAll('.group__label')].map((e) => e.textContent.trim()),
    quota: [...m.querySelectorAll('.list')][0] ? [...[...m.querySelectorAll('.list')][0].querySelectorAll('.row')].map((r) => ({
      title: r.querySelector('.row__title')?.textContent.trim(),
      value: r.querySelector('.row__value')?.textContent.trim(),
      bar: r.querySelector('.progress')?.getAttribute('aria-valuenow') ?? null,
      full: r.classList.contains('is-full')
    })) : [],
    rows: [...m.querySelectorAll('.mylib__item')].map((r) => ({
      key: r.dataset.key,
      title: r.querySelector('.row__title')?.textContent.trim(),
      kind: r.querySelector('.row__sub:not(.mylib__status)')?.textContent.trim(),
      status: r.querySelector('.mylib__status')?.textContent.trim(),
      del: r.querySelector('.mylib__del')?.getAttribute('aria-label'),
      busy: r.classList.contains('is-deleting')
    })),
    empty: m.querySelector('.state__title')?.textContent.trim() || null
  };
});

async function openAccounts(page) {
  await page.tapSel('.avatarbtn');
  await sheetUp(page, 'Accounts');
}

/* Accounts sheet → My library (once /api/me answered) → the screen */
async function openMyLib(page) {
  await openAccounts(page);
  await page.waitFor(() => [...document.querySelectorAll('.sheethost .sheet .row__title')].some((e) => e.textContent.trim() === 'My library'), { what: 'the My library row', timeout: 8000 });
  await tapIn(page, '.sheethost button', /^My library/, { scope: 'doc' });
  await page.waitFor(() => !document.querySelector('.sheethost .sheet'), { what: 'Accounts sheet closed' });
  return topHas(page, '.screen.mylib .list');
}

/* the trash button of the row `key` ("movie:900002") */
const trash = (page, key) => page.waitFor((key) => {
  const top = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1);
  const b = top.querySelector(`.mylib__item[data-key="${key}"] .mylib__del`);
  if (!b) return null;
  b.scrollIntoView({ block: 'center' });
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
}, { what: 'trash of ' + key }, key);

test('phone my library: nicole — Accounts row with her quota, the screen’s bars and titles (live status), trash asks (Keep sends nothing), Delete → one DELETE with files, row gone, slot freed', { app: 'phone', fast: false, allowErrors: [NO_PIC], timeout: 120000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const harbor = movie(w, 'The Silent Harbor'); // in Jellyfin → in_library
  w.ml.own('movie', '900002', 'nicole', { at: '2026-10-04T10:00:00Z' }); // Iron Tide, downloading 43 %
  const grab = addPending(w, { type: 'movie', media_id: '900002', progress: 0.43, size_bytes: 2_000_000_000 });
  w.ml.own('movie', '900006', 'nicole', { at: '2026-10-02T10:00:00Z' }); // Secret Canyon, nothing grabbed yet
  w.ml.own('movie', harbor.ProviderIds.Tmdb, 'nicole', { at: '2026-10-01T10:00:00Z' });
  const shows = w.ml.fill('nicole', 'tv', 10); // shows full
  await bootPhone(t, { user: 'nicole' });

  await t.step('one /api/me a moment after boot; the Accounts sheet has "My library" with the summary above Settings', async () => {
    await until(() => meGets(srv).some((e) => e.status === 200), 'the boot-time /api/me', 10000);
    await openAccounts(page);
    const r = await sheetRows(page);
    t.log(JSON.stringify(r));
    const i = r.findIndex(([title]) => title === 'My library');
    assert(i >= 0, 'a My library row');
    assert.equal(r[i][1], '3 of 10 movies · 10 of 10 shows');
    assert.equal(r[i + 1][0], 'Settings', 'right above Settings');
    await page.tapSel('.sheethost .closebtn');
    await page.waitFor(() => !document.querySelector('.sheethost .sheet'), { what: 'Accounts sheet closed' });
  });

  await t.step('the screen: bars 3/10 and 10/10 full; her titles, in flight first, statuses', async () => {
    await openMyLib(page);
    assert.match(await topRoute(page), /^mylibrary/);
    const s = await screen(page);
    t.log(JSON.stringify(s));
    assert.deepEqual(s.labels, ['Your quota', 'Your titles']);
    assert.deepEqual(s.quota, [
      { title: 'Movies', value: '3 of 10', bar: '30', full: false },
      { title: 'Shows', value: '10 of 10 · full', bar: '100', full: true }
    ]);
    const want = ['movie:900002', ...shows.map((e) => 'tv:' + e.id).reverse(), 'movie:900006', 'movie:' + harbor.ProviderIds.Tmdb];
    assert.deepEqual(s.rows.map((r) => r.key), want, 'in flight first, then waiting (newest first), then in the library');
    assert.deepEqual(s.rows[0], { key: 'movie:900002', title: 'Iron Tide', kind: 'Movie · 2023', status: 'Downloading · 43%', del: 'Delete Iron Tide', busy: false });
    assert.equal(s.rows[1].status, 'Waiting for a release');
    assert.equal(s.rows[1].kind, 'Show · ' + shows.at(-1).year);
    assert.equal(s.rows.at(-1).status, 'In your library');
    const b = await trash(page, 'movie:900002');
    assert(b.w >= 44 && b.h >= 44, 'trash hit box ≥ 44 pt: ' + b.w + '×' + b.h);
  });

  await t.step('the status follows the activity feed while the page is up', async () => {
    grab.progress = 0.61;
    await page.waitFor(() => document.querySelector('.mylib__item[data-key="movie:900002"] .mylib__status')?.textContent.trim() === 'Downloading · 61%', { what: 'live 61 %', timeout: 12000 });
  });

  await t.step('trash → the action sheet asks, focus on Keep; Keep sends nothing', async () => {
    const b = await trash(page, 'movie:900002');
    await page.tap(b.x, b.y);
    const s = await sheetSettled(page);
    t.log(JSON.stringify(s));
    assert.deepEqual(s, {
      title: 'Delete “Iron Tide”?',
      msg: 'The film and its files are deleted from the server — for everyone. This can’t be undone.',
      act: 'Delete',
      keep: 'Keep',
      focusKeep: true
    });
    await page.tapSel('.actsheet:not([inert]) .actsheet__btn--cancel');
    await page.waitFor(() => !document.querySelector('.actsheet:not([inert])'), { what: 'sheet dismissed', timeout: 5000 });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(deletes(srv).length, 0, 'no DELETE after Keep');
    assert.equal((await screen(page)).rows.length, 13, 'all rows still there');
  });

  await t.step('Delete → exactly one DELETE ?delete_files=true; toast; the row goes; 2 of 10', async () => {
    const b = await trash(page, 'movie:900002');
    await page.tap(b.x, b.y);
    await sheetSettled(page);
    await page.tapSel('.actsheet:not([inert]) .actsheet__btn--danger');
    assert.equal(await toastSays(page, /^Deleted/), 'Deleted “Iron Tide”');
    const d = deletes(srv);
    assert.equal(d.length, 1);
    assert.equal(d[0].path, '/api/library/movie/900002');
    assert.equal(d[0].search, '?delete_files=true');
    assert.equal(d[0].status, 200);
    assert.deepEqual(w.ml.deletes, [{ type: 'movie', id: '900002', user: 'nicole' }]);
    await page.waitFor(() => !document.querySelector('.mylib__item[data-key="movie:900002"]'), { what: 'the row gone', timeout: 5000 });
    await page.waitFor(() => document.querySelector('.mylib__q[data-kind="movie"] .row__value')?.textContent.trim() === '2 of 10', { what: 'the movie bar at 2 of 10', timeout: 5000 });
    assert.equal(deletes(srv).length, 1, 'still one DELETE');
  });

  await t.step('Settings has the same row, with the new summary', async () => {
    await tapIn(page, '.iconbtn', /^Back/);
    await page.waitFor(() => document.querySelector('.tabbarhost:not([hidden])'), { what: 'back on the tab root', timeout: 8000 });
    await topHas(page, '.avatarbtn'); // the pop has settled
    // the "Deleted" toast sits over the sheet's lower rows until it goes
    await page.waitFor(() => !document.querySelector('.toast:not(.toast--off)'), { what: 'toast gone', timeout: 10000 });
    await openAccounts(page);
    await page.waitFor(() => [...document.querySelectorAll('.sheethost .sheet .row')].some((r) => r.querySelector('.row__title')?.textContent.trim() === 'My library' && r.querySelector('.row__sub')?.textContent.trim() === '2 of 10 movies · 10 of 10 shows'), { what: 'sheet summary 2 of 10' });
    await tapIn(page, '.sheethost button', /^Settings/, { scope: 'doc' });
    await page.waitFor(() => !document.querySelector('.sheethost .sheet'), { what: 'Accounts sheet closed' });
    await topHas(page, '[aria-label="Streaming quality"]');
    await tapIn(page, 'button.row', /^My library/);
    await topHas(page, '.screen.mylib .list');
    assert.equal((await screen(page)).rows.length, 12);
  });
});

test('phone my library: deleting the last title leaves "Nothing added yet"; its Search button opens the Search tab', { app: 'phone', fast: false, allowErrors: [NO_PIC], timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  w.ml.own('movie', '900006', 'nicole');
  await bootPhone(t, { user: 'nicole' });
  await until(() => meGets(srv).some((e) => e.status === 200), 'the boot-time /api/me', 10000);
  await openMyLib(page);
  const b = await trash(page, 'movie:900006');
  await page.tap(b.x, b.y);
  await sheetSettled(page);
  await page.tapSel('.actsheet:not([inert]) .actsheet__btn--danger');
  await page.waitFor(() => document.querySelector('.screen.mylib .state__title')?.textContent.trim() === 'Nothing added yet', { what: 'the empty state', timeout: 8000 });
  const s = await screen(page);
  assert.deepEqual(s.quota.map((q) => q.value), ['0 of 10', '0 of 10']);
  assert.deepEqual(w.ml.deletes, [{ type: 'movie', id: '900006', user: 'nicole' }]);
  await tapIn(page, '.state__actions button', /^Search$/);
  await page.waitFor(() => document.querySelector('.tabbar__item[aria-current="page"]')?.textContent.trim() === 'Search', { what: 'Search tab current' });
});

test('phone my library: tapping a title opens its page (the in-library film’s detail)', { app: 'phone', fast: false, allowErrors: [NO_PIC], timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const harbor = movie(w, 'The Silent Harbor');
  w.ml.own('movie', harbor.ProviderIds.Tmdb, 'nicole');
  await bootPhone(t, { user: 'nicole' });
  await until(() => meGets(srv).some((e) => e.status === 200), 'the boot-time /api/me', 10000);
  await openMyLib(page);
  await tapIn(page, '.mylib__item button.row', /^The Silent Harbor/);
  const key = await topHas(page, '.detail__title');
  assert.match(key, /^detail-/);
  assert.equal(await page.eval(() => [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1).querySelector('.detail__title').textContent.trim()), 'The Silent Harbor');
});

test('phone my library: kirill (admin) — "Admin · no limit", "Titles you added" (his only), his delete works', { app: 'phone', fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  w.ml.own('movie', '900003', 'kirill', { at: '2026-10-04T10:00:00Z' }); // Quiet Summit
  w.ml.own('tv', '400003', 'kirill', { at: '2026-10-03T10:00:00Z' }); // Hidden Station
  w.ml.own('movie', '900006', 'nicole'); // not his: not listed
  w.ml.fill('kirill', 'movie', 12); // over any normal limit
  await bootPhone(t, { user: 'kirill' });
  await until(() => meGets(srv).some((e) => e.status === 200), 'the boot-time /api/me', 10000);
  await openAccounts(page);
  const r = await sheetRows(page);
  assert.deepEqual(r.find(([title]) => title === 'My library'), ['My library', 'Admin · no limit']);
  await tapIn(page, '.sheethost button', /^My library/, { scope: 'doc' });
  await page.waitFor(() => !document.querySelector('.sheethost .sheet'), { what: 'Accounts sheet closed' });
  await topHas(page, '.screen.mylib .mylib__item');
  const s = await screen(page);
  assert.deepEqual(s.labels, ['Your quota', 'Titles you added']);
  assert.deepEqual(s.quota, [{ title: 'Admin', value: 'No limit', bar: null, full: false }]);
  const keys = s.rows.map((x) => x.key);
  assert.equal(keys.length, 14, '12 filled + 2');
  assert(keys.includes('movie:900003') && keys.includes('tv:400003'), 'his own titles');
  assert(!keys.includes('movie:900006'), 'nicole’s title is not his');
  const b = await trash(page, 'tv:400003');
  await page.tap(b.x, b.y);
  const c = await sheetSettled(page);
  assert.equal(c.msg, 'The show, every season and all its files are deleted from the server — for everyone. This can’t be undone.');
  await page.tapSel('.actsheet:not([inert]) .actsheet__btn--danger');
  await page.waitFor(() => !document.querySelector('.mylib__item[data-key="tv:400003"]'), { what: 'the row gone', timeout: 5000 });
  assert.deepEqual(w.ml.deletes, [{ type: 'tv', id: '400003', user: 'kirill' }]);
});

test('phone my library: an old reel-api (no /api/me) — no My library row in Accounts or Settings, asked once', { app: 'phone', fast: false, allowErrors: [NO_PIC, OLD_ME], timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  srv.world.ml.oldBackend = true;
  await bootPhone(t, { user: 'nicole' });
  await until(() => meGets(srv).some((e) => e.status === 404), 'the boot-time /api/me 404', 10000);
  await openAccounts(page);
  await page.frames(5);
  const r = await sheetRows(page);
  assert(!r.some(([title]) => title === 'My library'), 'no My library row: ' + JSON.stringify(r));
  await tapIn(page, '.sheethost button', /^Settings/, { scope: 'doc' });
  await page.waitFor(() => !document.querySelector('.sheethost .sheet'), { what: 'Accounts sheet closed' });
  await topHas(page, '[aria-label="Streaming quality"]');
  assert(!(await page.eval(() => [...document.querySelectorAll('.route .row__title')].some((e) => e.checkVisibility() && e.textContent.trim() === 'My library'))), 'no My library row in Settings');
  assert.equal(meGets(srv).length, 1, 'asked once this session');
});
