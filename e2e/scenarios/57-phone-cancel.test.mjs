/* Phone: cancelling a download (src/lib/cancel.svelte.js, phone-only UI) —
 * reel-api DELETE /api/activity/{type}/{id}[?season=&episode=]. A destructive
 * call, so: it asks first (the action sheet, focus on the safe button), "Keep
 * downloading" sends nothing, a torrent goes as a whole (one episode of a
 * season pack cancels the pack — the confirm says so), an importing grab is
 * refused with 409 importing ("Too late"), and the rows leave with the next
 * activity poll. The fake mirrors undo.py's cancel (rows widened by torrent,
 * importing kept). */
import { test, assert } from '../lib/runner.mjs';
import { bootPhone, openTab, topHas, tapIn } from '../lib/phone.mjs';
import { addPending } from '../lib/world.mjs';
import { until } from '../lib/player.mjs';

const cancels = (srv) => srv.requests({ origin: 'ml', method: 'DELETE', path: '/api/activity/' });

const sheetSettled = (page) => page.waitFor(() => {
  const b = document.querySelector('.actsheet:not([inert]) .actsheet__box');
  return b && b.getAnimations().every((a) => a.playState !== 'running') && {
    msg: b.querySelector('.actsheet__msg')?.textContent.trim() || b.querySelector('.actsheet__title')?.textContent.trim(),
    act: b.querySelector('.actsheet__btn--danger')?.textContent.trim(),
    keep: b.querySelector('.actsheet__btn--cancel')?.textContent.trim(),
    focusKeep: document.activeElement?.classList.contains('actsheet__btn--cancel')
  };
}, { what: 'confirm sheet settled', timeout: 8000 });

const toastSays = (page, re) => page.waitFor((src) => {
  const t = [...document.querySelectorAll('.toast .toast__text')].find((x) => x.checkVisibility() && new RegExp(src).test(x.textContent.trim()));
  return t && t.textContent.trim();
}, { what: 'toast ' + re, timeout: 8000 }, re.source);

/* the visible pending tiles of the current grid: their aria-labels */
const pendingTiles = (page) => page.eval(() => [...document.querySelectorAll('.screen.lib .lib__grid .tile[role="button"]')].filter((e) => e.checkVisibility()).map((e) => e.getAttribute('aria-label')).filter((l) => /, (downloading|queued|importing)/.test(l)));

test('phone cancel: a movie download — Cancel asks first (Keep downloading sends nothing); an importing grab is "Too late" (409); confirmed → DELETE /api/activity/movie/{id}, toast, the title leaves the grid', { app: 'phone', fast: false, timeout: 90000, allowErrors: [/status of 409 \(Conflict\) http:\/\/127\.0\.0\.1:\d+\/ml\/api\/activity\/movie\/900001/] }, async (t) => {
  const { page, srv } = t;
  const grab = srv.world.ml.activity.find((x) => x.id === 'q-movie-900001');
  await bootPhone(t);
  await openTab(page, 'Movies');
  await page.waitFor(() => document.querySelectorAll('.screen.lib .lib__grid .tile[role="button"]').length >= 12, { what: 'grid', timeout: 10000 });
  await tapIn(page, '.lib__grid .tile[role="button"]', new RegExp('^' + grab.title + ', downloading$'));
  await topHas(page, '.btn__pct');

  await t.step('Cancel → the sheet asks, focus on the safe button; Keep downloading sends nothing', async () => {
    await tapIn(page, 'button.action', /^Cancel$/);
    const s = await sheetSettled(page);
    t.log(JSON.stringify(s));
    assert.equal(s.msg, `Cancel “${grab.title}”? What has arrived so far is deleted.`);
    assert.equal(s.act, 'Cancel download');
    assert.equal(s.keep, 'Keep downloading');
    assert(s.focusKeep, 'focus on Keep downloading, the safe default');
    await page.tapSel('.actsheet:not([inert]) .actsheet__btn--cancel');
    await page.waitFor(() => !document.querySelector('.actsheet:not([inert])'), { what: 'sheet dismissed', timeout: 5000 });
    await new Promise((r) => setTimeout(r, 300)); // nothing must follow the dismissal
    assert.equal(cancels(srv).length, 0, 'no DELETE after Keep downloading');
  });

  await t.step('the grab is importing: the server refuses (409 importing) → "Too late", the page keeps it', async () => {
    grab.status = 'importing';
    await tapIn(page, 'button.action', /^Cancel$/);
    await sheetSettled(page);
    await page.tapSel('.actsheet:not([inert]) .actsheet__btn--danger');
    const msg = await toastSays(page, /Too late/);
    assert.equal(msg, 'Too late — it’s being added to your library');
    const d = cancels(srv);
    assert.equal(d.length, 1);
    assert.equal(d[0].status, 409);
    assert.equal(d[0].path, '/api/activity/movie/900001');
    assert.equal(d[0].search, '', 'a movie: no season / episode');
    assert(srv.world.ml.activity.includes(grab), 'the importing grab is kept');
    await page.waitFor(() => !document.querySelector('.action[disabled]'), { what: 'Cancel un-dims after the refusal', timeout: 5000 });
  });

  await t.step('downloading again: confirmed → 200, toast, the next poll drops it, the grid loses its pending tile', async () => {
    grab.status = 'downloading';
    await tapIn(page, 'button.action', /^Cancel$/);
    await sheetSettled(page);
    const p0 = srv.requests({ origin: 'ml', path: '/api/activity', method: 'GET' }).length;
    await page.tapSel('.actsheet:not([inert]) .actsheet__btn--danger');
    assert.equal(await toastSays(page, /^Cancelled/), 'Cancelled — ' + grab.title);
    const d = cancels(srv);
    assert.equal(d.length, 2);
    assert.equal(d[1].status, 200);
    assert(!srv.world.ml.activity.includes(grab), 'gone from the fake queue');
    assert.deepEqual(srv.world.ml.cancels.at(-1).removed, ['q-movie-900001']);
    // boostActivity(): the rows go with the next poll, not up to 30 s later
    await until(() => srv.requests({ origin: 'ml', path: '/api/activity', method: 'GET' }).length > p0, 'an activity poll right after the cancel', 6000);
    // cancelledGroups: the title left the feed because of this cancel, not an import
    const msg = await page.waitFor(() => {
      const top = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1);
      return /Download cancelled/.test(top.textContent) && top.textContent.replace(/\s+/g, ' ').trim();
    }, { what: '"Download cancelled" page', timeout: 6000 });
    assert.match(msg, /Download cancelled ?Nothing more of “Glass Meridian Rising” will download\./);
    assert(!/Ready to watch|being added to your library/.test(msg), 'not mistaken for an import');
  });

  await t.step('Back: the Movies grid has no pending tile for it', async () => {
    await tapIn(page, '.iconbtn', /^Back/);
    await page.waitFor(() => document.querySelector('.tabbarhost:not([hidden])'), { what: 'back on the grid', timeout: 8000 });
    await page.waitFor((title) => ![...document.querySelectorAll('.screen.lib .lib__grid .tile[role="button"]')].some((e) => e.checkVisibility() && e.getAttribute('aria-label').startsWith(title + ',')), { what: 'pending tile gone', timeout: 8000 }, grab.title);
    assert.deepEqual(await pendingTiles(page), [], 'no pending tiles left in Movies');
  });
});

test('phone cancel: one episode of a season pack — long-press the row, the confirm says the pack goes as one download; DELETE ?season=1&episode=2 removes all three rows, another season’s grab stays', { app: 'phone', fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const PACK = 'p'.repeat(40);
  const e1 = w.ml.activity.find((x) => x.id === 'q-tv-400001-1-1');
  Object.assign(e1, { status: 'downloading', progress: 0.3, download_id: PACK, download_speed: 3_000_000, timeleft: '0:20:00', size_bytes: 6_000_000_000 });
  for (const e of [2, 3]) addPending(w, { type: 'tv', media_id: '400001', season: 1, episode: e, download_id: PACK, progress: 0.3, listInMetadata: true });
  const s2 = addPending(w, { type: 'tv', media_id: '400001', season: 2, episode: 1, listInMetadata: true });
  await bootPhone(t);
  await openTab(page, 'Shows');
  await page.waitFor(() => document.querySelectorAll('.screen.lib .lib__grid .tile[role="button"]').length >= 6, { what: 'grid', timeout: 10000 });
  await tapIn(page, '.lib__grid .tile[role="button"]', new RegExp('^' + e1.title + ', downloading$'));
  await topHas(page, '.episode');

  await t.step('long-press E2 → "Cancel download…" → the confirm names the whole pack', async () => {
    const rows = await page.waitFor(() => {
      const top = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1);
      const r = [...top.querySelectorAll('.episode')].map((e) => e.querySelector('.episode__title')?.textContent.trim());
      return r.length === 3 && r;
    }, { what: 'Season 1 rows', timeout: 8000 });
    t.log('rows: ' + rows.join(' | '));
    const p = await page.eval(() => {
      const top = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1);
      const el = top.querySelectorAll('.episode')[1];
      el.scrollIntoView({ block: 'center' });
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    });
    await page.press(p.x, p.y, 750);
    const item = await page.waitFor(() => [...document.querySelectorAll('.ctx [role="menuitem"]')].find((e) => e.checkVisibility() && /Cancel download/.test(e.textContent))?.textContent.trim(), { what: 'context menu', timeout: 5000 });
    assert.equal(item, 'Cancel download…');
    await page.waitFor(() => [...document.querySelectorAll('.ctx__menu')].every((m) => m.getAnimations().every((a) => a.playState !== 'running')), { what: 'menu settled', timeout: 5000 });
    await tapIn(page, '.ctx [role="menuitem"]', /^Cancel download/, { scope: 'doc' });
    const s = await sheetSettled(page);
    t.log(JSON.stringify(s));
    assert.equal(s.msg, 'They come as one download. Cancel Season 1 · 3 episodes? What has arrived so far is deleted.');
    assert.equal(s.act, 'Cancel all 3 episodes');
    assert.equal(cancels(srv).length, 0, 'nothing sent before the confirm');
  });

  await t.step('confirmed → one DELETE for E2 with season + episode; the server takes the whole torrent; the rows leave', async () => {
    await page.tapSel('.actsheet:not([inert]) .actsheet__btn--danger');
    assert.equal(await toastSays(page, /^Cancelled/), `Cancelled — ${e1.title} Season 1 · 3 episodes`);
    const d = cancels(srv);
    assert.equal(d.length, 1);
    assert.equal(d[0].path, '/api/activity/tv/400001');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(d[0].search)), { season: '1', episode: '2' });
    assert.equal(d[0].status, 200);
    assert.deepEqual(w.ml.cancels.at(-1).removed.sort(), ['q-tv-400001-1-1', 'q-tv-400001-1-2', 'q-tv-400001-1-3']);
    assert(w.ml.activity.includes(s2), 'the Season 2 grab (another torrent) stays');
    // the next poll: only the Season 2 grab is left on the page
    const meta = await page.waitFor(() => {
      const top = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1);
      const parts = [...(top.querySelector('.detail__head .meta')?.querySelectorAll(':scope > span:not([class])') || [])].map((e) => e.textContent.trim());
      return parts.includes('1 episode on the way') && top.querySelector('.detail__title')?.textContent.trim() + ' | ' + parts.join(' | ');
    }, { what: 'meta line: 1 episode on the way', timeout: 10000 });
    t.log('after: ' + meta);
    assert.match(meta, /Paper Lanterns/, 'still the same title (Season 2 is coming)');
    const rows = await page.eval(() => [...[...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1).querySelectorAll('.episode')].map((e) => e.querySelector('.episode__overview')?.textContent.trim()));
    assert.deepEqual(rows, ['S2E1 of Paper Lanterns.'], 'only the Season 2 row is left');
  });
});
