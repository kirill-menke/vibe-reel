/* Phone: watching a download while it comes in (pendingplay.js →
 * playFeedStream, livefeed.js + segfeed.js). Safari can't play the growing
 * MKV, so reel-api (livehls.py) remuxes it into an HLS event playlist of fMP4
 * segments — one job per (download, audio track) — and the app appends the
 * segments to a (Managed)MediaSource itself. The job starts with POST
 * …/hls?audio=<the probe's default track>, is polled with GET while it is
 * still probing (no codecs yet), then playlist → init → segments, every file
 * no-store. P.pending gates off Jellyfin: no PlaybackInfo, no reports. The
 * fake's job (world.ml.liveHls) serves the fixture trailer's 30 s of VP9 +
 * Opus fMP4 as a playlist that is still growing (desktop Chrome has
 * MediaSource, so feedSupported() holds and the Play button shows). */
import { test, assert } from '../lib/runner.mjs';
import { bootPhone, openTab, topHas, topRoute, tapIn } from '../lib/phone.mjs';
import { holds } from '../lib/page.mjs';

const GID = 'a'.repeat(40); // the downloading movie (seed q-movie-900001; probe: audio index 1, 1:52:00)

test('phone pending play: "Play while downloading" starts the live-HLS job for the default audio track, polls it past probing, feeds playlist → init → segments through MSE and plays; nothing goes to Jellyfin; closing returns to PendingDetail', { app: 'phone', fast: false, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  assert(srv.media.trailer, 'fixture fMP4 HLS (ffmpeg): ' + (srv.media.error || 'missing'));
  w.ml.liveHls.set(GID, { probing: 1 });
  const grab = w.ml.activity.find((x) => x.download_id === GID);
  await bootPhone(t);
  await openTab(page, 'Movies');
  await page.waitFor(() => document.querySelectorAll('.screen.lib .lib__grid .tile[role="button"]').length >= 12, { what: 'grid', timeout: 10000 });
  await tapIn(page, '.lib__grid .tile[role="button"]', new RegExp('^' + grab.title + ', downloading$'));
  const key = await topHas(page, '.btn__pct');
  const l0 = srv.log.length;

  await t.step('Play while downloading → the player plays the MSE feed', async () => {
    await tapIn(page, 'button', /Play while downloading/);
    await page.waitFor(() => {
      const v = document.querySelector('video');
      return v && document.querySelector('.player')?.checkVisibility() && v.currentTime > 1 && !v.paused;
    }, { what: 'the live feed playing past 0:01', timeout: 20000 });
    const v = await page.eval(() => ({ src: document.querySelector('video').src, dur: document.querySelector('video').duration }));
    assert.match(v.src, /^blob:/, 'a MediaSource, not a URL Safari would have to play itself');
    assert(Math.abs(v.dur - 6720) < 1, 'the duration is the probed runtime, not the 30 s on disk: ' + v.dur);
  });

  await t.step('the job: POST ?audio=1, GET while probing, then playlist → init → segments (no-store)', async () => {
    const live = srv.log.slice(l0).filter((e) => e.origin === 'ml' && e.path.startsWith(`/api/downloads/${GID}/hls`)).map((e) => `${e.method} ${e.path.replace(`/api/downloads/${GID}/hls`, '')}${e.search}`);
    t.log(live.join(' | '));
    assert.equal(live[0], 'POST ?audio=1', "the job for the probe's default audio track (index 1, DD+ Atmos)");
    assert.equal(live[1], 'GET ?audio=1', 'polled while the job was probing');
    const files = w.ml.liveFiles.map((f) => `${f.audio}/${f.name}`);
    assert.deepEqual(files.slice(0, 3), ['1/index.m3u8', '1/init.mp4', '1/s00000.m4s'], 'playlist, init, first segment — under the audio track');
    assert.deepEqual(srv.log.slice(l0).filter((e) => e.origin === 'jf' && (/\/PlaybackInfo$|^\/Sessions\/Playing|^\/Videos\//.test(e.path))).map((e) => e.path), [], 'P.pending: nothing to Jellyfin');
    assert(srv.log.slice(l0).every((e) => !e.path.endsWith('/stream')), 'never the TV’s MKV Range stream');
  });

  await t.step('Esc closes the player onto the same PendingDetail', async () => {
    await page.key('Escape', { settle: 100 });
    await page.waitFor(() => !document.querySelector('.player')?.checkVisibility(), { what: 'player closed', timeout: 8000 });
    await topHas(page, '.btn__pct');
    assert.equal(await topRoute(page), key, 'the same PendingDetail route');
    const n = w.ml.liveFiles.length;
    await holds(() => w.ml.liveFiles.length === n, 1500, 'the feeder stopped fetching');
  });
});
