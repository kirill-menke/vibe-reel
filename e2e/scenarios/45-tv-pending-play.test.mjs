/* TV watch-while-downloading (pendingplay.js → playPendingStream): Play on a
 * PendingDetail probes the partial file, then plays reel-api's growing file
 * (GET /api/downloads/{id}/stream, Range) through the same DirectPlay <video>
 * — with P.pending gating off everything Jellyfin: no PlaybackInfo, no
 * Sessions/Playing* reports. Exit goes back to the pending page (openPending),
 * not to a Jellyfin item. A stream that legitimately waits for bytes shows
 * "Waiting for download — N%" on the loading card (VideoLayer polls the feed);
 * an `ended` well short of the probed runtime is "The download stopped here"
 * with Retry at that position, a stream that fails is "The download stream
 * broke off" (CLAUDE.md, "Watch while downloading"). The fixture's growing file
 * is the 60 min WebM; world.ml.cutStreams serves its first 20 s instead. */
import { test, assert } from '../lib/runner.mjs';
import { openPendingTile, waitFocus, focused, checkFocusInvariants } from '../lib/tv.mjs';
import { vstate, until } from '../lib/player.mjs';

const ID = 'a'.repeat(40); // the downloading movie's info-hash (seed: q-movie-900001, probe 1:52:00)
const STREAM = `/api/downloads/${ID}/stream`;
const TITLE = 'Glass Meridian Rising';

/* nothing Jellyfin-side may be told about a pending stream */
function assertNoJellyfinPlayback(srv, l0) {
  const bad = srv.log.slice(l0).filter((e) => e.origin === 'jf' && (/\/PlaybackInfo$/.test(e.path) || /^\/Sessions\/Playing/.test(e.path) || /^\/Videos\//.test(e.path)));
  assert.deepEqual(bad.map((e) => `${e.method} ${e.path}`), [], 'P.pending gates off PlaybackInfo, play reports and Jellyfin streams');
}

const card = (page) => page.eval(() => ({
  title: document.querySelector('#play-error .petitle')?.textContent.trim() || null,
  item: document.querySelector('#play-error .peitem')?.textContent.trim() || null,
  detail: document.querySelector('#play-error .pedetail')?.textContent.trim() || null
}));

/* OK on pd-play; records whether the loading card showed (it can come and go between polls) */
async function pressPlay(page) {
  await waitFocus(page, 'pd-play', 8000);
  await page.eval(() => {
    const el = document.getElementById('play-loading');
    window.__e2eCard = { at: 0, waits: [] };
    const seen = () => {
      if (el.classList.contains('show') && !window.__e2eCard.at) window.__e2eCard.at = performance.now();
      const w = el.querySelector('.waitmsg')?.textContent.trim();
      if (w && window.__e2eCard.waits.at(-1) !== w) window.__e2eCard.waits.push(w);
    };
    window.__e2eCard.obs = new MutationObserver(seen);
    window.__e2eCard.obs.observe(el, { attributes: true, attributeFilter: ['class'], subtree: true, childList: true, characterData: true });
  });
  await page.key('OK', { settle: 0 });
}

test('tv pending play: Play on a downloading movie streams /api/downloads/{id}/stream through the DirectPlay <video> — "Waiting for download — N%" while the bytes are held, no PlaybackInfo / Sessions reports; Back, Back returns to PendingDetail', { fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const grab = w.ml.activity.find((x) => x.id === 'q-movie-900001');
  await openPendingTile(t, 'movies', 'pend-movie:900001');
  const l0 = srv.log.length;

  await t.step('the stream waits at the download frontier: the loading card says how far the download is', async () => {
    // reel-api holds a Range request at the frontier instead of failing it: hold the first one
    const hold = srv.fault({ origin: 'ml', method: 'GET', path: STREAM }, { delay: 9000 }, 1);
    await pressPlay(page);
    await page.waitFor(() => window.__e2eCard.at, { what: 'loading card', timeout: 3000, interval: 20 });
    await page.waitFor(() => document.querySelector('#play-loading .waitmsg')?.textContent.trim() === 'Waiting for download — 43%', { what: 'waiting text with the feed %', timeout: 6000 });
    assert.equal(await page.eval(() => document.querySelector('#play-loading .pltitle')?.textContent.trim()), TITLE, 'the card names the title');
    // PendingDetail probed on open (file badges); Play reuses that answer (mlProbe's session cache)
    assert(srv.requests({ origin: 'ml', path: `/api/downloads/${ID}/probe` }).length >= 1, 'the partial file was probed');
    // the feed moves on while the request is held: the card follows the 4 s poll
    grab.progress = 0.47;
    await page.waitFor(() => document.querySelector('#play-loading .waitmsg')?.textContent.trim() === 'Waiting for download — 47%', { what: 'waiting text follows the poll', timeout: 7000 });
    assert.equal(hold.hits, 1, 'the stream request was the held one');
  });

  await t.step('bytes arrive: playing, OSD up, the src is the reel-api stream', async () => {
    await page.waitFor(() => !document.getElementById('play-loading')?.classList.contains('show'), { what: "'playing' drops the loading card", timeout: 20000 });
    await waitFocus(page, 'c-play', 8000);
    const v = await vstate(page);
    assert(!v.paused && v.err == null, 'plays: ' + JSON.stringify(v));
    assert.equal(new URL(v.src).pathname, STREAM, 'the <video> plays the growing file itself');
    const s = srv.log.slice(l0).filter((e) => e.path === STREAM);
    assert(s.length >= 1 && s.every((e) => e.violations.length === 0 && (e.status === 200 || e.status === 206 || e.status === 0)), 'stream requests: ' + s.map((e) => e.status).join(','));
    assert(await page.eval(() => document.getElementById('osd')?.classList.contains('show')), 'OSD up');
  });

  await t.step('Back hides the OSD, Back exits to PendingDetail (remounted), not to a Jellyfin item', async () => {
    await page.waitFor(() => document.querySelector('video')?.currentTime > 1.5, { what: 'some playback', timeout: 10000 });
    if (!(await page.eval(() => document.getElementById('osd')?.classList.contains('show')))) await page.key('Play', { settle: 150 });
    await page.key('Back', { settle: 250 });
    assert(await page.eval(() => !document.getElementById('video-layer')?.hidden), 'first Back only hid the OSD');
    await page.key('Back', { settle: 100 });
    await page.waitFor(() => document.getElementById('video-layer')?.hidden && document.querySelector('.screen .hero .btn.stat'), { what: 'back on PendingDetail', timeout: 8000 });
    assert.equal(await page.eval(() => document.querySelector('.screen .hero .title')?.textContent.trim()), TITLE);
    await page.waitFor(() => document.activeElement && document.activeElement !== document.body, { what: 'focus restored', timeout: 5000 });
    assert.equal(await focused(page), 'pd-play', 'focus on Play again');
    assert.equal(await page.eval(() => document.querySelector('video')?.getAttribute('src') || null), null, 'the element was emptied');
    assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants');
    assertNoJellyfinPlayback(srv, l0);
  });
});

test('tv pending play: a stream that ends at 0:20 of a 1:52:00 probe is "The download stopped here" with Retry focused; Retry restarts at 0:20, not from 0; its Back leaves to PendingDetail', { fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  assert(srv.media.cut, 'fixture cut clip (ffmpeg): ' + (srv.media.error || 'missing'));
  w.ml.cutStreams.add(ID);
  await openPendingTile(t, 'movies', 'pend-movie:900001');
  const l0 = srv.log.length;

  await t.step('the stream ends at 0:20: error card, Retry focused', async () => {
    await pressPlay(page);
    await page.waitFor(() => document.querySelector('#play-error .petitle'), { what: 'error card', timeout: 40000 });
    const c = await card(page);
    t.log(JSON.stringify(c));
    assert.equal(c.title, 'The download stopped here');
    assert.match(c.detail, /^The stream ended at 0:(19|20) of 1:52:00 — the download stalled or was removed\./, 'position of the end and the probed runtime');
    assert.equal(c.item, TITLE);
    await waitFocus(page, 'err-retry', 5000);
    assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants on the card');
  });

  await t.step('Retry reloads the stream and seeks to 0:20 (not 0); nothing more has arrived, so it is the same card again', async () => {
    // Headless Chrome answers the reload from its in-memory media cache (no new
    // request, even with Cache-Control: no-store), so "more arrived" can't be
    // shown here — the element's own events say where Retry restarted.
    await page.eval(() => {
      const v = document.querySelector('video');
      window.__e2eEv = [];
      for (const ev of ['loadstart', 'seeking', 'ended']) v.addEventListener(ev, () => window.__e2eEv.push([ev, Math.round(v.currentTime)]));
    });
    await page.key('OK', { settle: 0 });
    await page.waitFor(() => window.__e2eEv.some(([e]) => e === 'ended') && document.querySelector('#play-error .petitle'), { what: 'Retry ran to the end again', timeout: 20000 });
    const ev = await page.eval(() => window.__e2eEv);
    t.log(JSON.stringify(ev));
    assert.equal(ev[0][0], 'loadstart', 'Retry reloads the source');
    const seek = ev.find(([e]) => e === 'seeking');
    assert(seek && seek[1] >= 19, 'Retry seeks to where the stream stopped: ' + JSON.stringify(ev));
    assert.equal((await card(page)).title, 'The download stopped here');
    await waitFocus(page, 'err-retry', 5000);
  });

  await t.step('the card\'s Back exits to PendingDetail on Play; nothing told Jellyfin', async () => {
    await page.key('Right', { settle: 120 });
    await waitFocus(page, 'err-back');
    await page.key('OK', { settle: 200 });
    await page.waitFor(() => document.getElementById('video-layer')?.hidden && document.querySelector('.screen .hero .btn.stat'), { what: 'back on PendingDetail', timeout: 8000 });
    await waitFocus(page, 'pd-play', 5000);
    assertNoJellyfinPlayback(srv, l0);
  });
});

test('tv pending play: a stream that 404s (the grab left the download client after the probe) is "The download stream broke off"; Back leaves to PendingDetail', { fast: false, timeout: 60000, allowErrors: [/Failed to load resource: the server responded with a status of 404 \(Not Found\) http:\/\/127\.0\.0\.1:\d+\/api\/downloads\/a{40}\/stream/] }, async (t) => {
  const { page, srv } = t;
  await openPendingTile(t, 'movies', 'pend-movie:900001');
  const l0 = srv.log.length;
  const gone = srv.fault({ origin: 'ml', path: STREAM }, { status: 404, json: { error: 'not_found', detail: 'no such download' } });
  await pressPlay(page);
  await page.waitFor(() => document.querySelector('#play-error .petitle'), { what: 'error card', timeout: 20000 });
  const c = await card(page);
  t.log(JSON.stringify(c));
  assert.equal(c.title, 'The download stream broke off', 'a pending stream failing is the download side, not "can\'t play this file"');
  assert.match(c.detail, /^The media library stopped serving this file/);
  assert(gone.hits >= 1, 'the stream was asked for');
  await waitFocus(page, 'err-retry', 5000);
  await page.key('Right', { settle: 120 });
  await waitFocus(page, 'err-back');
  await page.key('OK', { settle: 200 });
  await page.waitFor(() => document.getElementById('video-layer')?.hidden && document.querySelector('.screen .hero .btn.stat'), { what: 'back on PendingDetail', timeout: 8000 });
  await waitFocus(page, 'pd-play', 5000);
  assertNoJellyfinPlayback(srv, l0);
});
