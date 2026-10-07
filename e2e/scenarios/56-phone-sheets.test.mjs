/* Phone sheets and settings (phone/src/sheets/Notifications.svelte, Accounts.svelte,
 * screens/Settings.svelte, screens/Downloads.svelte, lib/push.js):
 *  - the bell opens the Notifications sheet: "Ready to watch" (an import that
 *    landed in Jellyfin) above "New seasons" (aired → Get, upcoming → premiere
 *    date); opening marks everything seen; Get → POST /api/news/search and its
 *    toast's Undo → DELETE /api/news/search/{undo}; a landed row opens its detail;
 *  - Settings (pushed from the Accounts sheet): the server host, streaming
 *    quality per device (reel.qualityCellular, survives a restart), Downloads'
 *    empty state; in a Safari tab the notification switches are off with the
 *    "Home Screen app" hint;
 *  - as a home-screen app (navigator.standalone, notifications granted) a switch
 *    asks /api/push/config, which says enabled:false → "Notifications aren't set
 *    up on the server", the switch goes back off and nothing subscribes (no
 *    /api/push/subscribe; the network guard blocks any push service).
 *    The home-screen emulation also sets safe-area-inset-top (CDP
 *    setSafeAreaInsetsOverride): with 0 the app rightly shows viewport.js's
 *    "remove VibeReel from the Home Screen and add it again" hint (a stale
 *    black-status-bar install) 4 s after start. */
import { test, assert } from '../lib/runner.mjs';
import { landImport, addPending } from '../lib/world.mjs';
import { bootPhone, openTab, topHas, tapIn, sheetUp } from '../lib/phone.mjs';
import { until } from '../lib/player.mjs';


const bellLabel = (page) => page.eval(() => document.querySelector('.topbar [aria-label^="Notifications"]')?.getAttribute('aria-label'));

/* the Notifications sheet: section labels and rows */
const notifs = (page) => page.eval(() => {
  const s = document.querySelector('.sheethost .sheet');
  if (!s) return null;
  return {
    labels: [...s.querySelectorAll('.notifs__label')].map((p) => p.textContent.trim()),
    rows: [...s.querySelectorAll('.notif')].map((n) => ({
      title: n.querySelector('.notif__title')?.textContent.trim(),
      sub: n.querySelector('.notif__sub')?.textContent.trim(),
      time: n.querySelector('.notif__time')?.textContent.trim(),
      trail: n.querySelector('.notif__trail')?.textContent.replace(/\s+/g, ' ').trim(),
      unseen: n.classList.contains('notif--unseen')
    }))
  };
});
const rowOf = async (page, title) => (await notifs(page)).rows.find((r) => r.title === title);
const toastText = (page) => page.eval(() => document.querySelector('.toast__text')?.textContent.trim() || null);

test('phone notifications: the bell sheet lists Ready to watch + aired/upcoming seasons, marks them seen; Get → search with Undo; a landed row opens its detail', { app: 'phone', timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const [aired, upcoming] = w.ml.news;
  assert.equal(aired.kind, 'aired');
  assert.equal(upcoming.kind, 'upcoming');

  await bootPhone(t);
  await page.waitFor(() => /^Notifications, 2 new$/.test(document.querySelector('.topbar [aria-label^="Notifications"]')?.getAttribute('aria-label') || ''), { what: 'bell: 2 new seasons', timeout: 10000 });
  // the landed check diffs against a stored feed: one activity answer first, then the import
  await until(() => srv.requests({ origin: 'ml', path: '/api/activity' }).some((e) => e.status === 200), 'first activity answer');
  await page.waitFor(() => !!localStorage.getItem('reel.landedFeed'), { what: 'reel.landedFeed baseline stored' });
  const item = landImport(w, 'q-movie-900001');
  // a restart polls at once (the phone's idle cadence is 30 s); the stored baseline survives it
  await page.reload();
  await page.waitFor(() => /^Notifications, 3 new$/.test(document.querySelector('.topbar [aria-label^="Notifications"]')?.getAttribute('aria-label') || ''), { what: 'bell: 3 new (landing confirmed by Jellyfin)', timeout: 20000 });

  await tapIn(page, '.topbar button', /^Notifications/, { scope: 'doc' });
  await sheetUp(page, 'Notifications');
  const n = await notifs(page);
  t.log(JSON.stringify(n));
  assert.deepEqual(n.labels, ['Ready to watch', 'New seasons'], 'sections');
  assert.deepEqual(n.rows.map((r) => r.title), [item.Name, aired.title, upcoming.title], 'rows in order');
  assert.equal(n.rows[0].sub, 'Movie · now in your library');
  assert.equal(n.rows[1].sub, 'Season 5 · aired');
  assert.equal(n.rows[1].trail, 'Get', 'aired season offers Get');
  assert.equal(n.rows[2].sub, 'Season 4 · coming');
  assert(/^Premieres/.test(n.rows[2].trail), 'upcoming season shows its premiere: ' + n.rows[2].trail);
  assert(n.rows.every((r) => r.unseen), 'all unseen when the sheet opened (dots stay while it is up)');
  await page.waitFor(() => document.querySelector('.topbar [aria-label^="Notifications"]')?.getAttribute('aria-label') === 'Notifications', { what: 'opening marked everything seen' });

  // Get → the season search, a toast with Undo
  const s0 = w.ml.searches.length;
  await tapIn(page, '.sheethost .notif button', /^Get$/, { scope: 'doc' });
  const post = await until(() => srv.requests({ origin: 'ml', method: 'POST', path: '/api/news/search' })[0], 'POST /api/news/search');
  assert.equal(post.status, 202);
  const search = w.ml.searches[s0];
  assert(search && search.id === aired.media_id && search.season === 5, 'searched the aired season: ' + JSON.stringify(search));
  await page.waitFor((t) => document.querySelector('.toast__text')?.textContent.trim() === 'Looking for ' + t + ' season 5…', { what: 'search toast' }, aired.title);
  await page.waitFor((t) => /^(Searching|Found)$/.test([...document.querySelectorAll('.sheethost .notif')].find((n) => n.querySelector('.notif__title')?.textContent.trim() === t)?.querySelector('.notif__trail')?.textContent.trim() || ''), { what: 'row shows the search' }, aired.title);

  await tapIn(page, '.toast__action', /^Undo$/, { scope: 'doc' });
  const del = await until(() => srv.requests({ origin: 'ml', method: 'DELETE', path: '/api/news/search/' })[0], 'DELETE /api/news/search/{undo}');
  assert.equal(del.path, '/api/news/search/' + search.undo, 'undid with the search token');
  assert.equal(del.status, 200);
  await page.waitFor((t) => document.querySelector('.toast__text')?.textContent.trim() === 'Stopped — ' + t + ' season 5 won’t download', { what: 'undo toast' }, aired.title);
  await page.waitFor((t) => [...document.querySelectorAll('.sheethost .notif')].find((n) => n.querySelector('.notif__title')?.textContent.trim() === t)?.querySelector('.notif__trail')?.textContent.trim() === 'Get', { what: 'row back to Get' }, aired.title);
  assert.equal(aired.monitored, false, 'season unmonitored again on the server');

  // a landed row: the sheet closes and the title's detail page opens
  await tapIn(page, '.sheethost .notif', new RegExp('^' + item.Name), { scope: 'doc' });
  await page.waitFor(() => !document.querySelector('.sheethost .sheet'), { what: 'sheet closed' });
  await topHas(page, '.detail__title');
  assert.equal(await page.eval(() => [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1).querySelector('.detail__title').textContent.trim()), item.Name, 'detail of the landed title');
  assert(srv.requests({ origin: 'jf', path: '/Items/' + item.Id }).length >= 1, 'detail fetched the landed item');
});

/* open Settings from the Accounts sheet → the settings route's key */
async function openSettings(page) {
  await page.tapSel('.avatarbtn');
  await page.waitFor(() => !!document.querySelector('.sheethost .sheet') && document.querySelector('.sheethost .sheet').getAnimations().every((a) => a.playState !== 'running'), { what: 'Accounts sheet' });
  await tapIn(page, '.sheethost button', /^Settings/, { scope: 'doc' });
  await page.waitFor(() => !document.querySelector('.sheethost .sheet'), { what: 'Accounts sheet closed' });
  return topHas(page, '[aria-label="Streaming quality"]');
}
const settingsState = (page) => page.eval(() => {
  const r = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1);
  const row = (title) => [...r.querySelectorAll('.row')].find((x) => x.querySelector('.row__title')?.textContent.trim() === title);
  return {
    server: row('Server')?.querySelector('.row__value')?.textContent.trim(),
    quality: r.querySelector('[aria-label="Streaming quality"] .seg__opt--active')?.textContent.trim(),
    qualityOpts: [...r.querySelectorAll('[aria-label="Streaming quality"] .seg__opt')].map((b) => b.textContent.trim()),
    switches: [...r.querySelectorAll('.switch')].filter((s) => /Notify/.test(s.getAttribute('aria-label'))).map((s) => ({ label: s.getAttribute('aria-label'), on: s.getAttribute('aria-checked') === 'true', disabled: s.disabled })),
    text: r.textContent.replace(/\s+/g, ' ')
  };
});

test('phone settings: server host, streaming quality persists per device, Downloads empty state; notification switches off in a Safari tab', { app: 'phone', timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  await bootPhone(t);
  await openSettings(page);
  let s = await settingsState(page);
  t.log(JSON.stringify({ ...s, text: undefined }));
  assert.equal(s.server, new URL(srv.urls.phone).host, 'About → Server shows the host of cfg.server (origin + /jf)');
  assert.equal(s.quality, 'Original', 'Original by default');
  assert.equal(s.qualityOpts.length, 3, 'three caps');
  assert(/Every file plays as it is/.test(s.text), 'the Original hint');
  assert(s.switches.length === 2 && s.switches.every((x) => !x.on && x.disabled), 'notification switches off and disabled in a browser tab: ' + JSON.stringify(s.switches));
  assert(/Notifications only work in the Home Screen app/.test(s.text), 'the Home Screen hint');

  // the lowest cap: stored per device, the hint follows
  await tapIn(page, '[aria-label="Streaming quality"] .seg__opt', new RegExp('^' + s.qualityOpts[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
  await page.waitFor(() => localStorage.getItem('reel.qualityCellular') === '4000000', { what: 'reel.qualityCellular = 4000000' });
  s = await settingsState(page);
  assert.equal(s.quality, s.qualityOpts[2]);
  assert(/720p at 4 Mbit\/s/.test(s.text), 'the 4 Mbit/s hint');

  // a restart (a swipe-away: back on Home) keeps it
  await page.reload();
  await openSettings(page);
  s = await settingsState(page);
  assert.equal(s.quality, s.qualityOpts[2], 'quality survived the restart');

  // Downloads: nothing saved on this device
  await tapIn(page, 'button.row', /^Downloads/);
  await topHas(page, '.pagehead__title');
  const dl = await page.eval(() => {
    const r = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1);
    return { title: r.querySelector('.pagehead__title')?.textContent.trim(), text: r.textContent.replace(/\s+/g, ' ') };
  });
  assert.equal(dl.title, 'Downloads');
  assert(/Nothing downloaded/.test(dl.text) && /Tap Download on a movie or episode/.test(dl.text), 'empty state: ' + dl.text.slice(0, 200));
});

test('phone settings: as a home-screen app a notification switch asks /api/push/config (enabled:false) → "Notifications aren’t set up on the server", switch back off, nothing subscribes', { app: 'phone', timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  // iOS's home-screen app: navigator.standalone (Safari-only) is true; notifications allowed
  await page.s.send('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true });" });
  // …installed with the black-translucent status bar: content under the Dynamic Island
  // (safe-area-inset-top 59 px), else viewport.js asks for a reinstall (a stale install)
  await page.s.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 59, bottom: 34, left: 0, right: 0 } });
  await page.cdp.send('Browser.grantPermissions', { origin: srv.urls.phone, permissions: ['notifications'], browserContextId: page.opts.browserContextId });
  await bootPhone(t);
  await openSettings(page);
  let s = await settingsState(page);
  assert(s.switches.length === 2 && s.switches.every((x) => !x.on && !x.disabled), 'switches enabled in the home-screen app: ' + JSON.stringify(s.switches));
  assert(!/Notifications only work in the Home Screen app/.test(s.text), 'no Safari-tab hint');

  // toasts replace each other: record every text shown
  await page.eval(() => {
    window.__toasts = [];
    new MutationObserver(() => {
      const x = document.querySelector('.toast__text')?.textContent.trim();
      if (x && window.__toasts.at(-1) !== x) window.__toasts.push(x);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
    return true;
  });
  await tapIn(page, '.switch', /^Notify me when a download is ready to watch$/);
  await until(() => srv.requests({ origin: 'ml', path: '/api/push/config' }).length >= 1, 'GET /api/push/config');
  const toasts = await page.waitFor(() => window.__toasts.length && window.__toasts, { what: 'a toast' });
  t.log('toasts ' + JSON.stringify(toasts));
  assert.deepEqual(toasts, ['Notifications aren’t set up on the server'], 'the not-set-up toast');
  await page.waitFor(() => [...document.querySelectorAll('.switch')].filter((s) => /^Notify/.test(s.getAttribute('aria-label'))).every((s) => s.getAttribute('aria-checked') === 'false' && !s.disabled), { what: 'switch back off' });
  assert.equal(await page.eval(() => localStorage.getItem('reel.push')), null, 'no push prefs stored');
  const pushCalls = srv.requests({ origin: 'ml', path: '/api/push/' }).map((e) => e.method + ' ' + e.path);
  t.log('push calls: ' + JSON.stringify(pushCalls));
  assert(pushCalls.every((c) => c === 'GET /api/push/config'), 'only the config was asked: ' + JSON.stringify(pushCalls));
});
