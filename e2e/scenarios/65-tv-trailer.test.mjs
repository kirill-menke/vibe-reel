/* TV trailers in our own player (trailer.js → playTrailerStream →
 * trailerstream.js): reel-api's trailer job is an HLS event playlist of fMP4
 * segments that the app feeds through Media Source Extensions itself — POST
 * starts the job, the status says when PRELOAD_S (6 s) exist, then index.m3u8,
 * init.mp4 and the segments are appended; English subtitles (subs_done) are
 * fetched as text before the first frame. Trailer mode is P.pending + P.trailer:
 * no Jellyfin reports, and exit does NOT remount the page — it restores the
 * page's player fields and refocuses the Trailer button (CLAUDE.md,
 * "Trailers"). The fake serves the fixture's first 30 s as that HLS
 * (world.ml.trailers; VP9 + Opus in fMP4, which desktop Chrome's MSE takes). */
import { test, assert } from '../lib/runner.mjs';
import { waitFocus, focused, steer, checkFocusInvariants } from '../lib/tv.mjs';
import { openMovieDetail, until } from '../lib/player.mjs';

async function startTrailer(t) {
  const { page, srv } = t;
  const w = srv.world;
  assert(srv.media.trailer, 'fixture trailer HLS (ffmpeg): ' + (srv.media.error || 'missing'));
  const movie = w.list('Movie').find((m) => (m.RemoteTrailers || []).length);
  const ytid = /v=([\w-]{11})/.exec(movie.RemoteTrailers[0].Url)[1];
  w.ml.trailers.set(ytid, {});
  await openMovieDetail(t, movie);
  await steer(page, 'trailer', { settle: 120 });
  const l0 = srv.log.length;
  await page.key('OK', { settle: 0 });
  await page.waitFor(() => {
    const v = document.querySelector('#video-layer video');
    return v && !document.getElementById('video-layer').hidden && v.currentTime > 1 && !v.paused && !document.getElementById('play-loading')?.classList.contains('show');
  }, { what: 'the trailer playing past 0:01', timeout: 20000 });
  return { movie, ytid, l0 };
}

const jfPlayback = (srv, l0) => srv.log.slice(l0).filter((e) => e.origin === 'jf' && (/\/PlaybackInfo$/.test(e.path) || /^\/Sessions\/Playing/.test(e.path) || /^\/Videos\//.test(e.path))).map((e) => `${e.method} ${e.path}`);

test('tv trailer: a ready trailer plays through MSE — POST the job, init + segments in order, English subs fetched before the first frame and showing; Back, Back returns to the Trailer button without remounting the page; no Jellyfin reports', { fast: false, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const { movie, ytid, l0 } = await startTrailer(t);

  await t.step('the feeder: POST, playlist, init before the segments, subs before the first segment is appended', async () => {
    const ml = srv.log.slice(l0).filter((e) => e.origin === 'ml' && e.path.startsWith('/api/trailers/')).map((e) => `${e.method} ${e.path.replace('/api/trailers/' + ytid, '')}`);
    t.log(ml.join(' | '));
    assert.equal(ml[0], 'POST ', 'the job is started with a POST');
    const files = w.ml.trailerFiles.map((f) => f.name);
    assert.equal(files.indexOf('subs.vtt') >= 0, true, 'subs.vtt fetched');
    assert(files.indexOf('init.mp4') < files.indexOf('s000.m4s'), 'init before the first segment: ' + files.join(','));
    assert(files.indexOf('index.m3u8') < files.indexOf('init.mp4'), 'the playlist first');
    assert(files.indexOf('subs.vtt') < files.indexOf('init.mp4'), 'the subtitles are fetched during the preload, before anything is appended: ' + files.join(','));
    const v = await page.eval(() => {
      const v = document.querySelector('#video-layer video');
      return { src: v.getAttribute('src') || v.src, dur: v.duration, buffered: v.buffered.length ? v.buffered.end(0) : 0 };
    });
    assert.match(v.src, /^blob:/, 'a MediaSource object URL, not the playlist');
    assert(Math.abs(v.dur - 30) < 0.5, 'ms.duration from the status: ' + v.dur);
    assert.deepEqual(jfPlayback(srv, l0), [], 'trailer mode tells Jellyfin nothing');
  });

  await t.step('English subtitles are on: a blob <track> (srclang eng) with the fetched cues, drawn into #subs on the fixture clock', async () => {
    // VideoLayer flips a 'showing' track to 'hidden' and draws its active cues into #subs
    const tr = await page.waitFor(() => {
      const v = document.querySelector('#video-layer video');
      const el = v.querySelector('track'), tt = v.textTracks[0];
      return el && tt && tt.mode !== 'disabled' && tt.cues?.length > 0 && { src: el.src, srclang: el.srclang, n: tt.cues.length, first: tt.cues[0].text };
    }, { what: 'a parsed subtitle track', timeout: 5000 });
    t.log('track ' + JSON.stringify(tr));
    assert.match(tr.src, /^blob:/, 'the text handed over by the feeder, as a same-origin blob');
    assert.equal(tr.srclang, 'eng');
    assert.equal(tr.first, 'Fixture subtitle 00:00:00');
    const cue = await page.waitFor(() => {
      const c = document.querySelector('#subs .cue');
      return c && /Fixture subtitle/.test(c.textContent) && { text: c.textContent.trim(), t: document.querySelector('#video-layer video').currentTime };
    }, { what: 'a cue drawn in #subs', timeout: 14000, interval: 100 });
    t.log('cue ' + JSON.stringify(cue));
    assert.match(cue.text, /^Fixture subtitle 00:00:(00|10|20)$/);
    const at = Number(cue.text.slice(-2));
    assert(cue.t >= at && cue.t < at + 4.5, 'the drawn cue matches the playhead: ' + JSON.stringify(cue));
  });

  await t.step('Back hides the OSD (if up), Back exits onto the Trailer button; the page was not remounted', async () => {
    const n = srv.requests({ origin: 'jf', path: '/Items/' + movie.Id }).length;
    const osd = () => page.eval(() => !!document.getElementById('osd')?.classList.contains('show'));
    if (await osd()) await page.key('Back', { settle: 250 });
    assert(!(await osd()), 'OSD down');
    assert(await page.eval(() => !document.getElementById('video-layer').hidden), 'still in the trailer');
    await page.key('Back', { settle: 100 });
    await page.waitFor(() => document.getElementById('video-layer').hidden, { what: 'player down', timeout: 5000 });
    await waitFocus(page, 'trailer', 5000);
    assert.equal(await page.eval(() => document.querySelector('.screen .hero .title')?.textContent.trim()), movie.Name);
    assert.equal(srv.requests({ origin: 'jf', path: '/Items/' + movie.Id }).length, n, 'no refetch of the item: the detail page stayed mounted');
    assert.deepEqual(await checkFocusInvariants(page), [], 'focus invariants');
    assert.deepEqual(jfPlayback(srv, l0), [], 'still nothing told to Jellyfin');
  });
});

test('tv trailer: FastForward to the end — the feeder has every segment in, ends the stream, `ended` closes the trailer onto the Trailer button; a later Play still works', { fast: false, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  await startTrailer(t);
  await until(() => w.ml.trailerFiles.some((f) => f.name === 's002.m4s'), 'the last segment fetched (45 s ahead covers the 30 s trailer)', 10000);
  const pos = await page.eval(() => document.querySelector('#video-layer video').currentTime);
  // ⏩ steps 30 s: past the 30 s end — clamped to the end, where the closed stream fires 'ended'
  await page.key('FastForward', { settle: 100 });
  await page.waitFor(() => document.getElementById('video-layer').hidden, { what: 'the trailer closed itself at its end', timeout: 15000 });
  await waitFocus(page, 'trailer', 5000);
  t.log(`ended from ${pos.toFixed(1)} s via ⏩`);
  assert.equal(await focused(page), 'trailer');

  // the element and MediaSource were released: a second start joins the job again
  // (POST) and feeds a fresh MediaSource — its files may come from the HTTP cache
  // (reel-api serves them max-age=86400, the fake likewise), so count POSTs
  const posts = () => srv.requests({ origin: 'ml', method: 'POST', path: '/api/trailers/' }).length;
  const n = posts();
  await page.key('OK', { settle: 0 });
  await page.waitFor(() => {
    const v = document.querySelector('#video-layer video');
    return v && !document.getElementById('video-layer').hidden && v.currentTime > 0.5 && !v.paused;
  }, { what: 'the second start plays', timeout: 20000 });
  assert.equal(posts(), n + 1, 'the job is joined again');
  assert.match(await page.eval(() => document.querySelector('#video-layer video').src), /^blob:/, 'a new MediaSource');
  assert(await page.eval(() => document.querySelector('#video-layer video').currentTime < 10), 'from the start again');
});
