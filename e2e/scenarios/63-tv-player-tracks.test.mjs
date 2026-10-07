/* TV player — audio/subtitle menus and their consequences (tracks.js score() /
 * describeTracks() / pickDefaultSub(), trackprefs.js, player.svelte.js
 * pmSetAudio / pmSetSub / attachSubtitles / restartPlayback, VideoLayer's error card).
 *
 * CLAUDE.md pinned here:
 *  - default audio prefers E-AC3/DD+ over a container-default TrueHD; a
 *    commentary never wins within a language (Mad Men: AC3 commentary vs DTS-HD)
 *  - text subtitles are fetched as VTT and attached as a same-origin blob <track>
 *  - a menu pick is remembered per account (reel.trackPrefs.<userId>) BY MEANING,
 *    keyed by SeriesId, applied to the next episode (startTracks); movies are
 *    neither read nor written
 *  - VobSub forces the one-off HLS burn-in: PlaybackInfo with the burn profile
 *    (a TranscodingProfile), MediaSourceId + SubtitleStreamIndex, and the old
 *    PlaySessionId is Stopped right after the new src is set
 *  - a broken stream gives the error card (Retry / Back); Back exits to the detail page */
import { test, assert } from '../lib/runner.mjs';
import { bootTv, waitFocus, focused, steer, checkFocusInvariants } from '../lib/tv.mjs';
import { openMovieDetail, startAndPlay, exitWithBack, until, aliceOf, epOf } from '../lib/player.mjs';
import { tvProfile } from '../lib/bodies.mjs';
import { TICKS } from '../server/seed.mjs';

const lastReport = (w, s0, kind) => w.sessions.slice(s0).filter((x) => kind.includes(x.kind)).at(-1);
const prefsOf = (page, userId) => page.eval((k) => localStorage.getItem(k), 'reel.trackPrefs.' + userId);

/* OSD up (without seeking: ◀▶ with the OSD down seek), focus on `pill`, OK → panel */
async function openPanel(page, pill) {
  if (!(await page.eval(() => document.getElementById('osd')?.classList.contains('show')))) {
    await page.key('Down', { settle: 150 }); // any key but ◀▶/OK/Back wakes the OSD on c-play
  }
  await steer(page, pill, { settle: 100 });
  await page.key('OK', { settle: 200 });
  await page.waitFor(() => { const m = document.getElementById('player-menu'); return m && !m.hidden && m.contains(document.activeElement); }, { what: 'panel open with focus inside', timeout: 3000 });
}
async function pick(page, key) {
  await steer(page, key, { settle: 100 });
  await page.key('OK', { settle: 200 });
}
async function closePanel(page) {
  for (let i = 0; i < 3 && (await page.eval(() => !document.getElementById('player-menu')?.hidden)); i++) await page.key('Back', { settle: 200 });
}
const selected = (page) => page.eval(() => [...document.querySelectorAll('#player-menu .opt.sub-sel')].map((e) => e.dataset.focus));

/* the blob <track> attached for a text subtitle, once parsed. VideoLayer flips a
 * 'showing' track to 'hidden' and draws its active cues into #subs itself. */
const textTrack = (page) =>
  page.waitFor(() => {
    const v = document.querySelector('video');
    const tr = v && v.querySelector('track');
    const tt = v && v.textTracks[0];
    return tr && tt && tt.mode !== 'disabled' && tt.cues && tt.cues.length > 0 && { src: tr.src, srclang: tr.srclang, mode: tt.mode, cue: tt.cues[0].text, n: v.querySelectorAll('track').length };
  }, { what: 'a blob <track> with parsed cues', timeout: 5000 });
/* a cue drawn into #subs (one every 10 s, up for 4 s, on the fixture's clock) */
const drawnCue = (page) =>
  page.waitFor(() => {
    const c = document.querySelector('#subs .cue');
    return c && /Fixture subtitle/.test(c.textContent) && { text: c.textContent.trim(), t: document.querySelector('video').currentTime };
  }, { what: 'a cue drawn in #subs', timeout: 14000, interval: 100 });

async function openSeries(t, name) {
  const { page, srv } = t;
  await bootTv(t);
  await waitFocus(page, 'tab-home');
  await steer(page, 'tab-shows', { settle: 150 });
  await page.key('OK', { settle: 300 });
  const s = srv.world.byName('Series', name);
  await page.waitFor((k) => !!document.querySelector(`.screen .grid [data-focus="${k}"]`), { what: 'Shows grid', timeout: 10000 }, 'tile-' + s.Id);
  await steer(page, 'tile-' + s.Id, { settle: 150 });
  await page.key('OK', { settle: 400 });
  await waitFocus(page, 'play', 10000);
  return s;
}

test('tv player tracks: DD+ beats the TrueHD default, forced English subs by default; a menu pick (English subs → blob VTT track, German audio) is remembered by meaning for the series and starts the next episode on it', { fast: false, timeout: 90000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const alice = aliceOf(w);
  const ep3 = epOf(w, 'Northern Line', 1, 3), ep4 = epOf(w, 'Northern Line', 1, 4);
  const src3 = ep3.MediaSources[0];
  const idx = (pred) => src3.MediaStreams.find(pred).Index;
  const TRUEHD = idx((s) => s.Codec === 'truehd'), DDP = idx((s) => s.Codec === 'eac3' && s.Language === 'eng'), GER = idx((s) => s.Codec === 'eac3' && s.Language === 'ger');
  const SUB_EN = idx((s) => s.Type === 'Subtitle' && s.Language === 'eng' && !s.IsForced), SUB_FORCED = idx((s) => s.Type === 'Subtitle' && s.IsForced);
  assert(src3.MediaStreams.find((s) => s.Index === TRUEHD).IsDefault, 'seed: TrueHD is the container default');

  await openSeries(t, 'Northern Line');
  // SeriesDetail's Play = the next-up episode (S1E3, resumes at 20:00)
  const l0 = srv.log.length;
  const { s0 } = await startAndPlay(t, ep3, { resumeSec: 1200 });
  const start = w.sessions.slice(s0).find((x) => x.kind === 'start');
  assert.equal(start.body.AudioStreamIndex, DDP, 'default audio: E-AC3 over the TrueHD default');
  assert.equal(start.body.SubtitleStreamIndex, SUB_FORCED, 'default subs on English audio: the forced English track');
  const vtt0 = srv.log.slice(l0).find((e) => e.path === `/Videos/${ep3.Id}/${src3.Id}/Subtitles/${SUB_FORCED}/0/Stream.vtt`);
  assert(vtt0 && vtt0.status === 200, 'the forced track was fetched as VTT');
  assert.equal(await prefsOf(page, alice.Id), null, 'computed defaults are never remembered');

  // Subtitles menu: current = forced; pick full English
  await openPanel(page, 'c-subs');
  assert.deepEqual(await selected(page), ['pm-s-' + SUB_FORCED], 'the menu marks the current track');
  assert.deepEqual(await checkFocusInvariants(page), [], 'panel is modal, invariants hold');
  const l1 = srv.log.length;
  await pick(page, 'pm-s-' + SUB_EN);
  await until(() => srv.log.slice(l1).find((e) => e.path === `/Videos/${ep3.Id}/${src3.Id}/Subtitles/${SUB_EN}/0/Stream.vtt` && e.status === 200), 'GET …/Subtitles/{i}/0/Stream.vtt', 5000);
  const tr = await textTrack(page);
  t.log('track: ' + JSON.stringify(tr));
  assert(tr.src.startsWith('blob:' + srv.urls.tv), 'a same-origin blob: <track> (' + tr.src + ')');
  assert.equal(tr.n, 1, 'the old track was removed (one <track>)');
  assert.match(tr.cue, /^Fixture subtitle \d\d:\d\d:\d\d$/, 'cues from the served VTT');
  assert.equal(tr.srclang, 'eng');
  await closePanel(page);
  const cue = await drawnCue(page);
  const [hh, mm, ss] = /(\d\d):(\d\d):(\d\d)/.exec(cue.text).slice(1).map(Number);
  const cueAt = hh * 3600 + mm * 60 + ss;
  assert(cue.t >= cueAt && cue.t < cueAt + 5, `the drawn cue matches the playhead (${cue.text} at ${cue.t.toFixed(1)} s)`);

  // Audio menu: pick German
  await openPanel(page, 'c-audio');
  assert.deepEqual(await selected(page), ['pm-a-' + DDP]);
  const s1 = w.sessions.length;
  await pick(page, 'pm-a-' + GER);
  const prog = await until(() => lastReport(w, s1, ['progress']), 'a Progress report after the switch', 5000);
  assert.equal(prog.body.AudioStreamIndex, GER, 'the switch is reported');
  assert.equal(prog.body.SubtitleStreamIndex, SUB_EN);
  await closePanel(page);

  const prefs = JSON.parse(await prefsOf(page, alice.Id));
  t.log('reel.trackPrefs: ' + JSON.stringify(prefs));
  assert.deepEqual(Object.keys(prefs), [ep3.SeriesId], 'keyed by SeriesId');
  assert.deepEqual(prefs[ep3.SeriesId].a, { lang: 'German' }, 'audio by meaning (language), not index');
  assert.deepEqual(prefs[ep3.SeriesId].s, { lang: 'English', forced: false, sdh: false, burn: false }, 'subs by meaning');
  assert.equal(await page.eval(() => localStorage.getItem('reel.trackPrefs')), null, 'not the shared legacy key');

  await exitWithBack(t, s0);
  await waitFocus(page, 'play', 10000); // back on the series page
  // the next episode starts on the remembered tracks — with its own stream indexes shuffled, to prove "by meaning"
  const src4 = ep4.MediaSources[0];
  const ger4 = src4.MediaStreams.find((s) => s.Index === GER), en4 = src4.MediaStreams.find((s) => s.Index === SUB_EN);
  const ddp4 = src4.MediaStreams.find((s) => s.Index === DDP);
  ddp4.Language = 'ger'; ddp4.DisplayTitle = 'German - Dolby Digital+ - 5.1'; // index DDP is now German, GER becomes English
  ger4.Language = 'eng'; ger4.DisplayTitle = 'English - Dolby Digital+ - 5.1';
  assert(en4 && !en4.IsForced);
  await steer(page, 'ep-' + ep4.Id, { settle: 150 });
  const s2 = w.sessions.length, l2 = srv.log.length;
  const r4 = await startAndPlay(t, ep4, { resumeSec: 0 });
  const start4 = w.sessions.slice(s2).find((x) => x.kind === 'start');
  assert.equal(start4.body.AudioStreamIndex, DDP, 'remembered German → the German DD+ track (its index in THIS file)');
  assert.equal(start4.body.SubtitleStreamIndex, SUB_EN, 'remembered English (not forced) subs');
  assert(srv.log.slice(l2).some((e) => e.path === `/Videos/${ep4.Id}/${src4.Id}/Subtitles/${SUB_EN}/0/Stream.vtt`), 'its VTT was fetched');
  await exitWithBack(t, r4.s0);
});

test('tv player tracks: a movie — the commentary never wins (DTS main vs AC3 commentary), and menu picks are not remembered', { fast: false, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const alice = aliceOf(w);
  const movie = w.list('Movie')[1];
  const ms = movie.MediaSources[0].MediaStreams;
  // the Mad Men shape: DTS-HD main (default) + an AC3 commentary in the same language
  Object.assign(ms.find((s) => s.Index === 1), { Codec: 'dts', Profile: 'DTS-HD MA', Channels: 6, ChannelLayout: '5.1', Title: 'DTS-HD MA 5.1', DisplayTitle: 'English - DTS-HD MA - 5.1 - Default' });
  Object.assign(ms.find((s) => s.Index === 2), { Language: 'ger', DisplayTitle: 'German - Dolby Digital+ - 5.1' });
  const COMM = ms.find((s) => /Commentary/.test(s.Title || '')).Index;
  await openMovieDetail(t, movie);
  const { s0 } = await startAndPlay(t, movie);
  const start = w.sessions.slice(s0).find((x) => x.kind === 'start');
  assert.equal(start.body.AudioStreamIndex, 1, 'the DTS main track, not the AC3 commentary (ac3 +1 would beat dts without the commentary penalty)');
  await openPanel(page, 'c-audio');
  await pick(page, 'pm-a-' + COMM);
  await closePanel(page);
  await openPanel(page, 'c-subs');
  await pick(page, 'pm-s--1'); // None
  await closePanel(page);
  const r = await until(() => lastReport(w, s0, ['progress']), 'Progress after the picks', 5000);
  assert.equal(r.body.SubtitleStreamIndex, -1);
  assert.equal(await prefsOf(page, alice.Id), null, 'a movie writes no track memory');
  await exitWithBack(t, s0);
});

test('tv player tracks: picking a VobSub track restarts through the burn-in — PlaybackInfo with the burn profile, MediaSourceId + SubtitleStreamIndex, HLS TranscodingUrl, old session Stopped', { fast: false, timeout: 60000, allowErrors: [/Failed to load resource: the server responded with a status of 404 \(Not Found\) http:\/\/127\.0\.0\.1:\d+\/videos\/[0-9a-f]{32}\/hls1\/main\/\d+\.ts\?/] }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const movie = w.list('Movie')[1];
  const src = movie.MediaSources[0];
  const VOB = Math.max(...src.MediaStreams.map((s) => s.Index)) + 1;
  src.MediaStreams.push({ Index: VOB, Type: 'Subtitle', Codec: 'dvd_subtitle', Language: 'fre', DisplayTitle: 'French - DVD_SUBTITLE', IsDefault: false, IsForced: false, IsExternal: false, IsTextSubtitleStream: false, SupportsExternalStream: false });
  await openMovieDetail(t, movie);
  const { s0 } = await startAndPlay(t, movie);
  const first = w.sessions.slice(s0).find((x) => x.kind === 'start').body;
  assert.equal(first.PlayMethod, 'DirectPlay');
  await openPanel(page, 'c-subs');
  // French is neither the Settings language nor the audio's: it sits in the "More languages" fold
  if (!(await page.eval((k) => !!document.querySelector(`[data-focus="${k}"]`), 'pm-s-' + VOB))) await pick(page, 'pm-s-more');
  const e0 = srv.events.length, l0 = srv.log.length, s1 = w.sessions.length;
  await pick(page, 'pm-s-' + VOB);
  const pi = await until(() => srv.events.slice(e0).find((e) => e.kind === 'playbackinfo' && e.itemId === movie.Id), 'the burn-in PlaybackInfo', 5000);
  assert.deepEqual(pi.body.DeviceProfile, tvProfile(true), 'the burn profile (bodies.mjs copy of deviceProfile(true))');
  assert.equal(pi.body.DeviceProfile.TranscodingProfiles.length, 1, 'one HLS TranscodingProfile');
  assert.equal(pi.body.MediaSourceId, src.Id, 'burn is evaluated against a specific source');
  assert.equal(pi.body.SubtitleStreamIndex, VOB);
  assert.equal(pi.body.AudioStreamIndex, first.AudioStreamIndex, 'keeps the audio track');
  assert(!('StartTimeTicks' in pi.body), 'no StartTimeTicks on the TV burn path (the restart seeks)');
  const piReq = srv.log.slice(l0).find((e) => e.method === 'POST' && e.path === `/Items/${movie.Id}/PlaybackInfo`);
  assert.deepEqual(piReq.violations, [], 'validates against 12.1');
  await page.waitFor(() => /burning them in/.test(document.body.innerText), { what: "the 'burning them in' toast", timeout: 4000 });
  const sess = [...w.playSessions.entries()].reverse().find(([, v]) => v.itemId === movie.Id)[0];
  await page.waitFor((s) => (document.querySelector('video')?.getAttribute('src') || '').includes('/master.m3u8?') && document.querySelector('video').getAttribute('src').includes('PlaySessionId=' + s), { what: 'the video loads the TranscodingUrl', timeout: 4000 }, sess);
  const vsrc = await page.eval(() => document.querySelector('video').getAttribute('src'));
  assert(vsrc.startsWith(srv.urls.jf + `/videos/${movie.Id}/master.m3u8?`), 'cfg.server + TranscodingUrl: ' + vsrc);
  assert.match(vsrc, new RegExp(`SubtitleStreamIndex=${VOB}&SubtitleMethod=Encode`));
  const stop = await until(() => w.sessions.slice(s1).find((x) => x.kind === 'stopped'), 'the old session Stopped', 5000);
  assert.equal(stop.body.PlaySessionId, first.PlaySessionId, 'the OLD PlaySessionId is stopped (no lingering transcode)');
  assert(stop.body.PlaySessionId !== sess, 'not the new session');
  t.log(`burn-in src ${vsrc.slice(0, 120)}…; HLS requests: ${srv.log.slice(l0).filter((e) => /m3u8|hls1/.test(e.path)).map((e) => e.status + ' ' + e.path.split('/').pop()).join(', ') || 'none'}`);
});

test('tv player: a stream that 404s raises the error card (Retry focused, Back); Retry while still broken keeps the card; Back exits to the movie detail', { fast: true, timeout: 60000, allowErrors: [/Failed to load resource: the server responded with a status of 404 \(Not Found\) http:\/\/127\.0\.0\.1:\d+\/Videos\/[0-9a-f]{32}\/stream\.mkv\?/] }, async (t) => {
  const { page, srv } = t;
  const w = srv.world;
  const movie = w.list('Movie')[1];
  await openMovieDetail(t, movie);
  const f = srv.fault({ origin: 'jf', method: 'GET', path: `/Videos/${movie.Id}/stream` }, { status: 404, text: 'Not found' });
  const s0 = w.sessions.length;
  await page.key('OK', { settle: 0 });
  await waitFocus(page, 'err-retry', 15000);
  const card = await page.eval(() => ({ title: document.querySelector('#play-error .petitle')?.textContent, item: document.querySelector('#play-error .peitem')?.textContent, back: !!document.querySelector('[data-focus="err-back"]') }));
  t.log('error card: ' + JSON.stringify(card));
  assert(card.title && card.back, 'the card with Retry and Back');
  assert(card.item.startsWith(movie.Name), 'it names the title: ' + card.item);
  assert.deepEqual(await checkFocusInvariants(page), [], 'the card is modal');
  const hits = f.hits;
  await page.key('OK', { settle: 300 }); // Retry, still 404
  await until(() => f.hits > hits, 'Retry re-requested the stream', 5000);
  await waitFocus(page, 'err-retry', 10000);
  assert.equal(await focused(page), 'err-retry', 'the same card, focus on Retry');
  await page.key('Back', { settle: 300 });
  await waitFocus(page, 'play', 10000);
  assert.equal(await page.eval(() => document.querySelector('.screen .hero .title')?.textContent.trim()), movie.Name, 'back on the movie detail');
  assert(await page.eval(() => document.getElementById('video-layer')?.hidden), 'the player is gone');
  t.log('reports: ' + w.sessions.slice(s0).map((x) => x.kind).join(','));
});
