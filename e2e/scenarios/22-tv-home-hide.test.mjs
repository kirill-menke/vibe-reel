/* TV Home: hold OK on a Continue Watching / Next Up tile removes it — a local,
 * per-account hide (src/lib/homehide.js; Jellyfin 12.1 has no non-destructive
 * flag), undoable with the Play key while the toast is up, and conditional:
 * a new LastPlayedDate (CW) or a different next episode (Next Up) brings the
 * title back. Nothing about it may reach the server. */
import { test, assert } from '../lib/runner.mjs';
import { bootTv, waitFocus, waitSplashGone, focused, checkFocusInvariants } from '../lib/tv.mjs';

import { ep, setPlayed } from '../lib/world.mjs';

const rail = (page, title) =>
  page.eval((title) => {
    const r = [...document.querySelectorAll('.screen.home .rails .rail')].find((r) => r.querySelector('h2')?.textContent.trim() === title);
    return r ? [...r.querySelectorAll('.strip .focus')].map((e) => e.dataset.focus) : null;
  }, title);

const waitRail = (page, title, keys, what) =>
  page.waitFor((title, keys) => {
    const r = [...document.querySelectorAll('.screen.home .rails .rail')].find((r) => r.querySelector('h2')?.textContent.trim() === title);
    const got = r ? [...r.querySelectorAll('.strip .focus')].map((e) => e.dataset.focus) : null;
    return JSON.stringify(got) === JSON.stringify(keys);
  }, { what: what || title + ' = ' + keys.join(','), timeout: 6000 }, title, keys);

const toastText = (page) => page.eval(() => (document.querySelector('#toast.show') ? document.getElementById('toast').textContent : null));

/* no hide may touch watch state on the server */
function assertNoMutation(srv) {
  const bad = srv.log.filter((e) => e.origin === 'jf' && e.method !== 'GET' && /^\/(UserPlayedItems|UserItems\/[^/]+\/UserData|Sessions\/Playing|UserFavoriteItems)/i.test(e.path));
  assert.deepEqual(bad.map((e) => e.method + ' ' + e.path), [], 'no watch-state writes for a hide');
}

async function reloadHome(page) {
  await page.reload();
  await waitSplashGone(page);
  await waitFocus(page, 'tab-home', 10000);
  await page.waitFor(() => document.querySelectorAll('.screen.home .rails .rail').length >= 2, { what: 'rails', timeout: 8000 });
}

test('tv home hide: hold OK removes a Continue Watching tile, Play undoes, the hide survives reload until played again', { fast: false }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const movies = w.list('Movie');
  const nl = ep(w, 'Northern Line', 1, 3);
  const cw = [nl.Id, movies[2].Id, movies[5].Id].map((id) => 'tile-' + id);
  await bootTv(t);
  await waitFocus(page, 'tab-home');
  await waitRail(page, 'Continue Watching', cw);
  const nuBefore = await rail(page, 'Next Up');

  await page.key('Down', { settle: 300 });
  await waitFocus(page, 'hero-resume');
  await page.key('Down', { settle: 300 });
  await waitFocus(page, cw[0]);

  // hold OK: the tile collapses, focus moves to its neighbour, the toast offers Undo
  await page.hold('OK', 700);
  await page.waitFor(() => /Removed from Continue Watching/.test(document.querySelector('#toast.show')?.textContent || ''), { what: 'toast', timeout: 3000 });
  assert.match(await toastText(page), /Undo/, 'toast offers Undo');
  await waitRail(page, 'Continue Watching', cw.slice(1));
  assert.equal(await focused(page), cw[1], 'focus on the next tile');
  // the series of the hidden episode doesn't surface in Next Up instead
  assert.deepEqual(await rail(page, 'Next Up'), nuBefore, 'Next Up unchanged');
  assert.deepEqual(await checkFocusInvariants(page, { dupOk: ['tile-'] }), [], 'focus invariants after the removal');
  const uid = await page.eval(() => localStorage.getItem('reel.userId'));
  const stored = await page.eval((k) => JSON.parse(localStorage.getItem(k) || 'null'), 'reel.homeHidden.' + uid);
  assert(stored && stored.cw && nl.Id in stored.cw, 'hide stored under reel.homeHidden.<userId>');

  // Play (415) while the toast is up: the tile comes back where it was, focused
  await page.key('Play', { settle: 150 });
  await waitRail(page, 'Continue Watching', cw);
  await waitFocus(page, cw[0]);
  assert.equal(await toastText(page), null, 'toast gone after Undo');
  const after = await page.eval((k) => JSON.parse(localStorage.getItem(k) || 'null'), 'reel.homeHidden.' + uid);
  assert(!(nl.Id in (after?.cw || {})), 'undo removed the stored hide');

  // a second removal sticks across a reload
  await page.hold('OK', 700);
  await waitRail(page, 'Continue Watching', cw.slice(1));
  await reloadHome(page);
  assert.deepEqual(await rail(page, 'Continue Watching'), cw.slice(1), 'still hidden after reload');
  const heroTitle = await page.eval(() => document.querySelector('.hero.home .title')?.textContent);
  assert(heroTitle !== 'Northern Line', 'hero no longer on the hidden episode (got ' + heroTitle + ')');

  // played again (another client): a new LastPlayedDate brings it back
  w.userData.get(uid + ':' + nl.Id).LastPlayedDate = new Date().toISOString();
  await reloadHome(page);
  await waitRail(page, 'Continue Watching', cw);
  assertNoMutation(srv);
});

test('tv home hide: Next Up hides by series → episode; a different next episode reappears', { fast: false }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const pk1 = ep(w, 'Paper Kingdom', 2, 1);
  const pk2 = ep(w, 'Paper Kingdom', 2, 2);
  const eo5 = ep(w, 'Electric Orchard', 1, 5);
  await bootTv(t);
  await waitFocus(page, 'tab-home');
  await waitRail(page, 'Next Up', ['tile-' + pk1.Id, 'tile-' + eo5.Id]);

  for (const k of ['hero-resume', /^tile-/]) {
    await page.key('Down', { settle: 300 });
    await waitFocus(page, k);
  }
  await page.key('Down', { settle: 300 });
  await waitFocus(page, 'tile-' + pk1.Id);

  await page.hold('OK', 700);
  await page.waitFor(() => /Removed from Next Up/.test(document.querySelector('#toast.show')?.textContent || ''), { what: 'toast', timeout: 3000 });
  await waitRail(page, 'Next Up', ['tile-' + eo5.Id]);
  assert.equal(await focused(page), 'tile-' + eo5.Id, 'focus on the remaining Next Up tile');
  const uid = await page.eval(() => localStorage.getItem('reel.userId'));
  const stored = await page.eval((k) => JSON.parse(localStorage.getItem(k) || 'null'), 'reel.homeHidden.' + uid);
  assert.equal(stored?.nu?.[pk1.SeriesId], pk1.Id, 'stored as series id → episode id');

  // the hide keys on the account: a different user starts with nothing hidden
  const others = await page.eval(() => Object.keys(localStorage).filter((k) => k.startsWith('reel.homeHidden.')));
  assert.deepEqual(others, ['reel.homeHidden.' + uid], 'one per-account key');

  await reloadHome(page);
  assert.deepEqual(await rail(page, 'Next Up'), ['tile-' + eo5.Id], 'still hidden after reload');

  // watched on elsewhere: S2E1 played → the series' next episode is S2E2, a different id
  setPlayed(w, uid, pk1, true, { agoMs: w.now - Date.now() });
  await reloadHome(page);
  const nu = await rail(page, 'Next Up');
  assert(nu.includes('tile-' + pk2.Id), 'Paper Kingdom is back with S2E2: ' + nu);
  assert(!nu.includes('tile-' + pk1.Id), 'not with the hidden S2E1');
  assertNoMutation(srv);
});
