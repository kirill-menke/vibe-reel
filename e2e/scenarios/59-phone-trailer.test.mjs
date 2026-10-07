/* Phone trailers (phone MovieDetail ActionBar → trailer.js openTrailer →
 * playTrailerStream → trailerstream.js under __PHONE__): the same reel-api HLS
 * job the TV feeds through MSE, but capped at 1080p — the key is
 * `<id>@1080` (trailers.py parse_key; a 4K trailer is ~150 MB for a phone
 * screen), and every request of the job (POST, status, playlist, init,
 * segments, subs) goes to that key, never the plain 2160p one. Trailer mode
 * is P.pending: nothing reaches Jellyfin. The fake serves the fixture's 30 s
 * fMP4 for every height of an id (server/reelapi.mjs). */
import { test, assert } from '../lib/runner.mjs';
import { bootPhone, openTab, topRoute } from '../lib/phone.mjs';
import { holds } from '../lib/page.mjs';

test('phone trailer: Trailer plays the <id>@1080 job through MSE (never the 2160p key), nothing to Jellyfin; Esc returns to the detail', { app: 'phone', fast: false, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  assert(srv.media.trailer, 'fixture trailer HLS (ffmpeg): ' + (srv.media.error || 'missing'));
  await bootPhone(t);
  await openTab(page, 'Movies');
  await page.waitFor(() => document.querySelectorAll('.screen.lib .lib__grid .tile[role="button"]').length >= 12, { what: 'grid', timeout: 10000 });
  // a movie with a TMDB trailer whose tile is on screen
  const withTrailer = new Map(w.list('Movie').filter((m) => (m.RemoteTrailers || []).length).map((m) => [m.Name, m]));
  const hit = await page.waitFor((names) => {
    for (const el of document.querySelectorAll('.screen.lib .lib__grid .tile[role="button"]')) {
      const b = el.getBoundingClientRect();
      if (names.includes(el.getAttribute('aria-label')) && el.checkVisibility() && b.top >= 0 && b.bottom <= innerHeight) return { name: el.getAttribute('aria-label'), x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }
    return null;
  }, { what: 'a trailer movie on screen', timeout: 8000 }, [...withTrailer.keys()]);
  const movie = withTrailer.get(hit.name);
  const ytid = /v=([\w-]{11})/.exec(movie.RemoteTrailers[0].Url)[1];
  w.ml.trailers.set(ytid, {});
  await page.tap(hit.x, hit.y);
  // the detail page settled: no zoom overlay or route animation left (53-phone-detail's detailSettled)
  await page.waitFor((n) => {
    const top = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1);
    if (!top || top.querySelector('.detail__title')?.textContent.trim() !== n) return false;
    if (document.querySelector('.zoom-art') || top.classList.contains('zoom-card') || top.classList.contains('zoom-hide')) return false;
    return !top.getAnimations({ subtree: true }).some((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity);
  }, { what: 'MovieDetail settled', timeout: 10000 }, movie.Name);
  const key = await topRoute(page);
  const l0 = srv.log.length;

  const btn = await page.waitFor(() => {
    const top = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility()).at(-1);
    const el = top && [...top.querySelectorAll('button, [role="button"]')].find((b) => b.checkVisibility() && /^Trailer$/.test(b.textContent.trim()));
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    // the same spot on two polls: no scroll or layout still moving it
    const at = b.width ? Math.round(b.left) + ',' + Math.round(b.top) : null;
    const prev = window.__e2eTrailerAt;
    window.__e2eTrailerAt = at;
    return at && at === prev ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
  }, { what: 'the Trailer action, steady', timeout: 8000, interval: 120 });
  await page.tap(btn.x, btn.y);
  await page.waitFor(() => {
    const v = document.querySelector('video');
    return v && document.querySelector('.player')?.checkVisibility() && v.currentTime > 1 && !v.paused;
  }, { what: 'the trailer playing past 0:01', timeout: 20000 });
  assert.match(await page.eval(() => document.querySelector('video').src), /^blob:/, 'a MediaSource');

  const tr = srv.log.slice(l0).filter((e) => e.origin === 'ml' && e.path.startsWith('/api/trailers/')).map((e) => `${e.method} ${decodeURIComponent(e.path.slice('/api/trailers/'.length))}`);
  t.log(tr.slice(0, 8).join(' | '));
  assert.equal(tr[0], `POST ${ytid}@1080`, 'the job is started for <id>@1080');
  assert(tr.every((x) => x.split(' ')[1].startsWith(ytid + '@1080')), 'every request under the @1080 key: ' + tr.join(', '));
  assert.deepEqual(w.ml.trailers.get(ytid).keys, [`${ytid}@1080`], 'one job, the 1080p one');
  const files = w.ml.trailerFiles.filter((f) => f.key === `${ytid}@1080`).map((f) => f.name);
  assert(files.includes('subs.vtt'), 'the English subtitles of the same job');
  assert.deepEqual(files.filter((f) => f !== 'subs.vtt').slice(0, 3), ['index.m3u8', 'init.mp4', 's000.m4s'], 'playlist, init, first segment');
  assert.deepEqual(w.ml.trailerFiles.filter((f) => f.key !== `${ytid}@1080`), [], 'nothing from another height');
  const jf = srv.log.slice(l0).filter((e) => e.origin === 'jf' && /\/PlaybackInfo$|^\/Sessions\/Playing|^\/Videos\//.test(e.path)).map((e) => e.path);
  assert.deepEqual(jf, [], 'P.pending: nothing to Jellyfin');

  await page.key('Escape', { settle: 100 });
  await page.waitFor(() => !document.querySelector('.player')?.checkVisibility(), { what: 'player closed', timeout: 8000 });
  assert.equal(await topRoute(page), key, 'the same MovieDetail route');
  const n = w.ml.trailerFiles.length;
  await holds(() => w.ml.trailerFiles.length === n, 1500, 'the feeder stopped fetching');
});
