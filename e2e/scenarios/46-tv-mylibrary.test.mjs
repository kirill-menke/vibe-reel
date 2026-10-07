/* TV "My library" (run/design.md §6.2–6.4, §9.7 TV 1–3, 6–8): the avatar menu
 * gets a row — shown once GET /api/me answered — with the quota summary
 * ("3 of 10 movies · 10 of 10 shows", an admin "Admin · no limit"). OK swaps
 * in MyLibraryMenu: quota bars, then the user's own titles (status from the
 * feed) each with a Delete. Delete asks first (focus on Keep; Back and Keep
 * return to that row's Delete); confirmed, it sends exactly one DELETE
 * /api/library/{type}/{id}?delete_files=true, the row goes, focus moves to the
 * next row (else the previous, else "find something in Search"), and the slot
 * is free at once. Back from the list closes onto the avatar. An old reel-api
 * (404 on /api/me) shows no row and is asked once.
 *
 * Users: nicole (normal), kirill (admin) — e2e/README.md "Ownership and quotas". */
import { test, assert } from '../lib/runner.mjs';
import { addPending, movie } from '../lib/world.mjs';
import { bootTv, waitFocus, focused, steer, checkFocusInvariants } from '../lib/tv.mjs';
import { crawl, crawlSummary } from '../lib/crawler.mjs';

/* nicole has no profile picture (the avatar falls back to her initial on the 404) */
const NO_PIC = /status of 404 .*\/UserImage\?userId=[0-9a-f]{32}&/;
/* an old reel-api answers /api/me with FastAPI's 404 */
const OLD_ME = /status of 404 .*\/api\/me$/;

const toastText = (page) => page.eval(() => (document.querySelector('#toast.show') ? document.getElementById('toast').textContent.trim() : null));
const menuKeys = (page) => page.eval(() => [...document.querySelectorAll('.screen .lvmenu .focus')].map((e) => e.dataset.focus));
const deletes = (srv) => srv.requests({ origin: 'ml', method: 'DELETE', path: /^\/api\/library\// });
const meGets = (srv) => srv.requests({ origin: 'ml', method: 'GET', path: /^\/api\/me$/ });

/* the panel as the user sees it */
const panel = (page) => page.eval(() => {
  const m = document.querySelector('.screen .lvmenu.mylib');
  if (!m) return null;
  return {
    caps: [...m.querySelectorAll('.lvcap')].map((e) => e.textContent.trim()),
    admin: m.querySelector('.myadmin')?.textContent.trim() || null,
    bars: [...m.querySelectorAll('.myq')].map((q) => ({
      kind: q.dataset.kind,
      label: q.querySelector('.myqhead span')?.textContent.trim(),
      text: q.querySelector('.myqn')?.textContent.trim(),
      full: q.classList.contains('full'),
      width: q.querySelector('.mybar b')?.style.width
    })),
    rows: [...m.querySelectorAll('.myrow')].map((r) => ({
      keys: [...r.querySelectorAll('[data-focus]')].map((e) => e.dataset.focus),
      title: r.querySelector('.nwtitle')?.textContent.trim(),
      kind: r.querySelector('.nwseason')?.textContent.trim(),
      status: r.querySelector('.mystatus')?.textContent.trim(),
      busy: r.classList.contains('busy')
    }))
  };
});

async function until(fn, what, timeout = 8000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeout) throw new Error('timed out after ' + timeout + ' ms: ' + what);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/* boot as `user`, open the avatar menu and wait for its My library row */
async function openAccountMenu(t, user) {
  const { page } = t;
  await waitFocus(page, 'tab-home', 10000);
  await steer(page, 'nav-account', { settle: 150 });
  await page.key('OK', { settle: 300 });
  await waitFocus(page, 'ac-' + t.srv.world[user].Id);
  await page.waitFor(() => document.querySelector('[data-focus="ac-mylib"]'), { what: 'the My library row', timeout: 8000 });
}

const subLine = (page) => page.eval(() => document.querySelector('[data-focus="ac-mylib"] .acsub')?.textContent.trim());

async function openMyLib(t, user, first) {
  const { page } = t;
  await openAccountMenu(t, user);
  await steer(page, 'ac-mylib', { settle: 150 });
  await page.key('OK', { settle: 300 });
  await waitFocus(page, first);
}

test('tv my library: nicole — avatar row with her quota, bars + her titles with statuses, confirm (Keep / Back), delete → one DELETE with files, row gone, focus on the next row, slot freed; Back onto the avatar', { fast: false, allowErrors: [NO_PIC], timeout: 150000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const harbor = movie(w, 'The Silent Harbor'); // in Jellyfin → in_library
  w.ml.own('movie', '900002', 'nicole', { at: '2026-10-04T10:00:00Z' }); // Iron Tide, downloading 43 %
  addPending(w, { type: 'movie', media_id: '900002', progress: 0.43, size_bytes: 2_000_000_000 });
  w.ml.own('movie', '900006', 'nicole', { at: '2026-10-02T10:00:00Z' }); // Secret Canyon, nothing grabbed yet
  w.ml.own('movie', harbor.ProviderIds.Tmdb, 'nicole', { at: '2026-10-01T10:00:00Z' });
  const shows = w.ml.fill('nicole', 'tv', 10); // shows full, all waiting, newer than 900006
  await bootTv(t, { user: 'nicole' });

  await t.step('the avatar menu gains "My library" with the summary, between Add account and Settings', async () => {
    await openAccountMenu(t, 'nicole');
    assert.deepEqual(await menuKeys(page), ['ac-' + w.nicole.Id, 'ac-add', 'ac-mylib', 'ac-settings', 'ac-out']);
    assert.equal(await subLine(page), '3 of 10 movies · 10 of 10 shows');
    assert.equal(meGets(srv).length, 1, 'one /api/me for the menu');
    assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants in the account menu');
  });

  await t.step('OK swaps in My library on the first title: bars 3/10 and 10/10 full, statuses', async () => {
    await steer(page, 'ac-mylib', { settle: 150 });
    await page.key('OK', { settle: 300 });
    await waitFocus(page, 'my-movie-900002');
    assert(!(await page.eval(() => document.querySelector('.lvmenu.account'))), 'the account list was swapped out');
    const p = await panel(page);
    t.log(JSON.stringify(p));
    assert.deepEqual(p.caps, ['My library', 'Your titles']);
    assert.equal(p.admin, null);
    assert.deepEqual(p.bars, [
      { kind: 'movie', label: 'Movies', text: '3 of 10', full: false, width: '30%' },
      { kind: 'tv', label: 'Shows', text: '10 of 10 · full', full: true, width: '100%' }
    ]);
    const want = ['movie-900002', ...shows.map((e) => 'tv-' + e.id).reverse(), 'movie-900006', 'movie-' + harbor.ProviderIds.Tmdb];
    assert.deepEqual(p.rows.map((r) => r.keys), want.map((k) => ['my-' + k, 'my-del-' + k]), 'in flight first, then waiting (newest first), then in the library');
    assert.deepEqual(p.rows[0], { keys: ['my-movie-900002', 'my-del-movie-900002'], title: 'Iron Tide', kind: 'Movie · 2023', status: 'Downloading · 43%', busy: false });
    assert.equal(p.rows[1].status, 'Waiting for a release');
    assert.equal(p.rows[1].kind, 'Show · ' + shows.at(-1).year);
    assert.equal(p.rows.at(-1).status, 'In your library');
    assert.equal(p.rows.at(-1).title, 'The Silent Harbor');
    assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants in My library');
  });

  await t.step('the panel is modal: arrows reach every row and its Delete, nothing outside', async () => {
    const r = await crawl(page, { name: 'my library', settle: 120, maxStates: 40, timeLimit: 60000, log: t.log });
    t.log(crawlSummary(r));
    assert.deepEqual(r.problems, [], 'crawl problems');
    assert.deepEqual(r.leaves, [], 'arrows never leave the panel');
    assert.deepEqual((await menuKeys(page)).filter((k) => !r.keys.includes(k)), [], 'every row and Delete reached');
    assert(r.keys.every((k) => k.startsWith('my-')), 'nothing outside: ' + r.keys.join(' '));
  });

  await t.step('Delete asks first, on Keep; Back returns to that row’s Delete; nothing was sent', async () => {
    await steer(page, 'my-del-movie-900002', { settle: 150 });
    await page.key('OK', { settle: 300 });
    await waitFocus(page, 'my-keep');
    assert.deepEqual(await menuKeys(page), ['my-keep', 'my-delete'], 'the confirmation replaces the list');
    assert.equal(await page.eval(() => document.querySelector('.mylib.confirm .myconfq')?.textContent.trim()), 'Delete “Iron Tide” (2023)?');
    assert.match(await page.eval(() => document.querySelector('.mylib.confirm .msg')?.textContent.trim()), /^The film and its files are deleted from the server — for everyone\./);
    assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants in the confirmation');
    const c = await crawl(page, { name: 'confirm', settle: 120, maxStates: 4, timeLimit: 10000 });
    assert.deepEqual([c.problems, c.leaves, c.keys.sort()], [[], [], ['my-delete', 'my-keep']], 'Keep ◀▶ Delete, nothing else');
    await page.key('Back', { settle: 300 });
    await waitFocus(page, 'my-del-movie-900002');
    assert((await panel(page)).rows.length === 13, 'back on the list');
    // Keep does the same
    await page.key('OK', { settle: 300 });
    await waitFocus(page, 'my-keep');
    await page.key('OK', { settle: 300 });
    await waitFocus(page, 'my-del-movie-900002');
    assert.equal(deletes(srv).length, 0, 'no DELETE sent');
  });

  await t.step('confirmed: exactly one DELETE ?delete_files=true; the row goes, focus on the next row, toast, 2 of 10', async () => {
    await page.key('OK', { settle: 300 });
    await waitFocus(page, 'my-keep');
    await page.key('Right', { settle: 200 });
    assert.equal(await focused(page), 'my-delete');
    await page.key('OK', { settle: 200 });
    await until(() => deletes(srv).length === 1, 'the DELETE');
    const d = deletes(srv)[0];
    assert.equal(d.path, '/api/library/movie/900002');
    assert.equal(d.search, '?delete_files=true');
    assert.deepEqual(w.ml.deletes, [{ type: 'movie', id: '900002', user: 'nicole' }]);
    await page.waitFor(() => !document.querySelector('[data-focus="my-movie-900002"]'), { what: 'the row gone', timeout: 5000 });
    await waitFocus(page, 'my-tv-' + shows.at(-1).id);
    assert.equal(await toastText(page), 'Deleted “Iron Tide”');
    await page.waitFor(() => document.querySelector('.myq[data-kind="movie"] .myqn')?.textContent.trim() === '2 of 10', { what: 'the movie bar at 2 of 10', timeout: 5000 });
    assert.equal(deletes(srv).length, 1, 'still one DELETE');
    assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants after the delete');
  });

  await t.step('Back closes the panel onto the avatar; reopened, the summary says 2 of 10', async () => {
    await page.key('Back', { settle: 300 });
    assert(!(await page.eval(() => document.querySelector('.screen .lvmenu'))), 'panel closed');
    assert.equal(await focused(page), 'nav-account');
    await page.key('OK', { settle: 300 });
    await waitFocus(page, 'ac-' + w.nicole.Id);
    await page.waitFor(() => document.querySelector('[data-focus="ac-mylib"] .acsub')?.textContent.trim() === '2 of 10 movies · 10 of 10 shows', { what: 'summary 2 of 10', timeout: 5000 });
  });
});

test('tv my library: deleting the last title leaves "find something in Search"; OK raises Search', { fast: false, allowErrors: [NO_PIC], timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  w.ml.own('movie', '900006', 'nicole');
  await bootTv(t, { user: 'nicole' });
  await openMyLib(t, 'nicole', 'my-movie-900006');
  await steer(page, 'my-del-movie-900006', { settle: 150 });
  await page.key('OK', { settle: 300 });
  await waitFocus(page, 'my-keep');
  await page.key('Right', { settle: 200 });
  await page.key('OK', { settle: 200 });
  await waitFocus(page, 'my-search', 8000);
  assert.equal(await page.eval(() => document.querySelector('[data-focus="my-search"]').textContent.trim()), 'Nothing added yet — find something in Search');
  assert.deepEqual(w.ml.deletes, [{ type: 'movie', id: '900006', user: 'nicole' }]);
  assert.equal(await page.eval(() => document.querySelector('.myq[data-kind="movie"] .myqn')?.textContent.trim()), '0 of 10');
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants on the empty panel');
  await page.key('OK', { settle: 400 });
  await page.waitFor(() => document.getElementById('search')?.classList.contains('on'), { what: 'Search up' });
  await waitFocus(page, 'q2');
  assert(!(await page.eval(() => document.querySelector('.screen .lvmenu'))), 'the panel closed');
});

test('tv my library: OK on a title opens its page (here: the in-library film’s MovieDetail)', { fast: false, allowErrors: [NO_PIC], timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const harbor = movie(w, 'The Silent Harbor');
  w.ml.own('movie', harbor.ProviderIds.Tmdb, 'nicole');
  await bootTv(t, { user: 'nicole' });
  await openMyLib(t, 'nicole', 'my-movie-' + harbor.ProviderIds.Tmdb);
  await page.key('OK', { settle: 400 });
  await waitFocus(page, 'play', 10000);
  assert.equal(await page.eval(() => document.querySelector('.screen .hero .title')?.textContent.trim()), 'The Silent Harbor');
  assert(!(await page.eval(() => document.querySelector('.lvmenu'))), 'the panel did not follow onto the detail');
});

test('tv my library: kirill (admin) — "Admin · no limit", the titles he added, his delete works', { fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  w.ml.own('movie', '900003', 'kirill', { at: '2026-10-04T10:00:00Z' }); // Quiet Summit
  w.ml.own('tv', '400003', 'kirill', { at: '2026-10-03T10:00:00Z' }); // Hidden Station
  w.ml.own('movie', '900006', 'nicole'); // not his: not listed
  w.ml.fill('kirill', 'movie', 12); // over any normal limit
  await bootTv(t, { user: 'kirill' });
  await openAccountMenu(t, 'kirill');
  assert.equal(await subLine(page), 'Admin · no limit');
  await steer(page, 'ac-mylib', { settle: 150 });
  await page.key('OK', { settle: 300 });
  await page.waitFor(() => document.querySelector('.screen .lvmenu.mylib .myrow'), { what: 'his titles' });
  await page.waitFor(() => document.activeElement?.closest?.('.myrow'), { what: 'focus on the first title' });
  const p = await panel(page);
  assert.deepEqual(p.caps, ['My library', 'Titles you added']);
  assert.equal(p.admin, 'Admin · no limit');
  assert.deepEqual(p.bars, [], 'no bars for an admin');
  const ids = p.rows.map((r) => r.keys[0]);
  assert.equal(ids.length, 14, '12 filled + 2');
  assert(ids.includes('my-movie-900003') && ids.includes('my-tv-400003'), 'his own titles');
  assert(!ids.includes('my-movie-900006'), 'nicole’s title is not his');
  await steer(page, 'my-del-tv-400003', { settle: 120 });
  await page.key('OK', { settle: 300 });
  await waitFocus(page, 'my-keep');
  assert.match(await page.eval(() => document.querySelector('.mylib.confirm .msg')?.textContent.trim()), /^The show, every season and all its files are deleted from the server/);
  await page.key('Right', { settle: 200 });
  await page.key('OK', { settle: 200 });
  await page.waitFor(() => !document.querySelector('[data-focus="my-tv-400003"]'), { what: 'the row gone', timeout: 5000 });
  assert.deepEqual(w.ml.deletes, [{ type: 'tv', id: '400003', user: 'kirill' }]);
  await page.waitFor(() => document.activeElement?.closest?.('.myrow'), { what: 'focus on a neighbouring row' });
  assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants');
});

test('tv my library: an old reel-api (no /api/me) — no My library row, asked once', { fast: false, allowErrors: [NO_PIC, OLD_ME], timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  srv.world.ml.oldBackend = true;
  await bootTv(t, { user: 'nicole' });
  await waitFocus(page, 'tab-home', 10000);
  for (let round = 0; round < 2; round++) {
    await steer(page, 'nav-account', { settle: 150 });
    await page.key('OK', { settle: 300 });
    await waitFocus(page, 'ac-' + srv.world.nicole.Id);
    await until(() => meGets(srv).some((e) => e.status === 404), 'the /api/me 404');
    await page.frames(5);
    assert.deepEqual(await menuKeys(page), ['ac-' + srv.world.nicole.Id, 'ac-add', 'ac-settings', 'ac-out'], 'no My library row');
    await page.key('Back', { settle: 300 });
    assert.equal(await focused(page), 'nav-account');
  }
  assert.equal(meGets(srv).length, 1, 'asked once this session');
});

for (const how of ['Back', 'Keep']) {
  test(`tv my library: the title under the confirmation vanishes meanwhile (deleted elsewhere) — ${how} lands on the next row, never <body>`, { fast: false, allowErrors: [NO_PIC], timeout: 90000 }, async (t) => {
    const { page, srv } = t;
    const w = srv.world;
    const [, b, a, d] = w.ml.fill('nicole', 'movie', 4); // rows newest first: d, a, b, c
    await bootTv(t, { user: 'nicole' });
    await openMyLib(t, 'nicole', 'my-movie-' + d.id);
    srv.fault({ origin: 'ml', method: 'DELETE', path: '/api/library/movie/' + d.id }, { delay: 2500 }, 1);
    // d: confirmed, "Deleting…" for 2.5 s
    await steer(page, 'my-del-movie-' + d.id, { settle: 150 });
    await page.key('OK', { settle: 300 });
    await waitFocus(page, 'my-keep');
    await page.key('Right', { settle: 150 });
    await page.key('OK', { settle: 200 });
    await waitFocus(page, 'my-del-movie-' + d.id);
    // meanwhile a's confirmation, and a is deleted on another device
    await steer(page, 'my-del-movie-' + a.id, { settle: 150 });
    await page.key('OK', { settle: 300 });
    await waitFocus(page, 'my-keep');
    w.ml.owners.delete('movie:' + a.id);
    const before = meGets(srv).length;
    // d's delete lands: its refreshMe() drops a from the list under the confirmation
    await until(() => w.ml.deletes.length === 1 && meGets(srv).length > before, 'd deleted, /api/me asked again');
    await new Promise((r) => setTimeout(r, 500));
    if (how === 'Back') await page.key('Back', { settle: 300 });
    else await page.key('OK', { settle: 300 }); // Keep has focus
    await waitFocus(page, 'my-movie-' + b.id);
    assert.equal(await page.eval(() => document.querySelector('.mylib.confirm')), null, 'back on the list');
    assert.equal(w.ml.deletes.length, 1, 'only d was deleted');
    assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants');
  });
}
