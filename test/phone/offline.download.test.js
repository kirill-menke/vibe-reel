/* offline.svelte.js — the download loop: queue → PlaybackInfo → HLS segments
 * into Cache Storage, resumable per segment, stopped below 500 MB of room.
 *
 * CLAUDE.md (iPhone app): "offline copies (offline.svelte.js: the same HLS
 * segments in Cache Storage, resumable per segment because iOS suspends the app
 * off screen; one copy per account + item, stopped below 500 MB of free quota
 * (a full quota also breaks the SW update)". The module comment: Jellyfin's HLS
 * fMP4 remux at the Settings quality cap, fetched with a `<deviceId>-dl`
 * DeviceId, audio limited to E-AC-3 / AC-3 / AAC; network trouble retries
 * (5 s, 15 s, 60 s) and then parks the copy as 'Paused —'; a 401/403/404 on a
 * segment re-resolves the playlist once; the Jellyfin job is stopped on
 * pause / delete / the end.
 *
 * The server is a fake Jellyfin (test/helpers/offline.js); nothing reaches the
 * network. */
import { describe, it, expect } from 'vitest';
import { bootOffline, jellyfinHls, OFFLINE_CACHE, MB } from '../helpers/offline.js';
import { movie, episode, source, video, audio, tracks } from '../helpers/media.js';
import { TICKS_PER_SECOND } from '../helpers/time.js';

const segKeys = (n) => Array.from({ length: n }, (_, i) => 's' + i);

describe('a download, start to finish', () => {
  it('fetches init + every segment into u1.<id>/, writes the manifest, stops the job, says so', async () => {
    const h = await bootOffline();
    const m = movie({ Id: 'm1', Name: 'Dune', BackdropImageTags: ['bd1'], MediaSources: [source([video(), tracks.truehdAtmos({ IsDefault: true }), tracks.eac3Atmos()], { Id: 'src-m1' })] });
    const srv = jellyfinHls(h, m, { segs: 4, subs: [{ Index: 3, Language: 'eng', DisplayTitle: 'English' }] });
    h.off.queueDownload(m, 'original');
    // saved as queued at once (a kill right after the tap keeps it), and started straight away
    expect(h.index()).toEqual([expect.objectContaining({ id: 'm1', user: 'u1', dir: 'u1.m1', state: 'queued', quality: 'original', title: 'Dune', line: '2024' })]);
    expect(h.entry('m1').state).toBe('downloading');
    expect(h.toast.toastState.msg).toBe('Downloading “Dune” — keep VibeReel open until it’s done');
    await h.settle();
    const e = h.entry('m1');
    expect(e.state).toBe('done');
    expect(e.done).toBe(4);
    expect(e.total).toBe(4);
    expect(h.toast.toastState.msg).toBe('“Dune” is downloaded');
    expect(h.files('u1.m1')).toEqual(['art', 'init', 'manifest', 'poster', ...segKeys(4), 'sub3'].sort());
    expect(srv.segFetches.map(([i]) => i)).toEqual([0, 1, 2, 3]);
    // the job is stopped under the download's own DeviceId, and only once (at the end)
    expect(srv.stops).toEqual([{ deviceId: 'dev-test-dl', playSessionId: 'ps1' }]);
    // the persisted index says done (pump's finally saves at once)
    expect(h.index().find((x) => x.id === 'm1')).toMatchObject({ state: 'done', done: 4, total: 4 });
  });

  it('asks Jellyfin for an HLS remux the MediaSource can take, under a -dl DeviceId', async () => {
    const h = await bootOffline();
    const m = movie({ Id: 'm2', MediaSources: [source([video(), tracks.dtsHdMa({ IsDefault: true }), tracks.eac3({ Language: 'ger' })], { Id: 'src-m2' })] });
    const srv = jellyfinHls(h, m, { segs: 2 });
    h.off.queueDownload(m, 8000000);
    await h.settle();
    expect(h.entry('m2').state).toBe('done');
    const body = srv.infoCalls[0];
    expect(body).toMatchObject({ UserId: 'u1', MaxStreamingBitrate: 8000000, EnableDirectPlay: false, MediaSourceId: 'src-m2', SubtitleStreamIndex: -1, StartTimeTicks: 0 });
    expect(body.DeviceProfile.DirectPlayProfiles).toEqual([]);
    const hls = body.DeviceProfile.TranscodingProfiles.filter((p) => p.Protocol === 'hls');
    expect(hls.length).toBeGreaterThan(0);
    for (const p of hls) for (const c of p.AudioCodec.split(',')) expect(['eac3', 'ac3', 'aac']).toContain(c);
    // the playlists come under the download's own device (its job never collides with the player's)
    const pl = h.net.calls.filter((c) => /\.m3u8/.test(c.path));
    expect(pl.map((c) => c.path)).toEqual(['/videos/m2/master.m3u8', '/videos/m2/main.m3u8']);
    for (const c of pl) expect(c.url).toContain('DeviceId=dev-test-dl');
    for (const c of pl) expect(c.url).not.toContain('DeviceId=dev-test&');
  });

  it('"original" asks for 200 Mbit/s; the manifest keeps what the player needs', async () => {
    const h = await bootOffline();
    const m = movie({ Id: 'm3', Name: 'Film', RunTimeTicks: 24 * TICKS_PER_SECOND, MediaSources: [source([video(), audio({ Codec: 'eac3', IsDefault: true }), audio({ Codec: 'aac', Language: 'fra' })], { Id: 'src-m3', Bitrate: 12000000 })] });
    jellyfinHls(h, m, { segs: 4, segLen: 6, subs: [{ Index: 3, Language: 'eng', DisplayTitle: 'English', IsForced: true }] });
    h.off.queueDownload(m, 'original');
    await h.settle();
    const man = await (await h.cs.cache(OFFLINE_CACHE).match('/offline/u1.m3/manifest')).json();
    expect(man).toMatchObject({
      v: 1,
      audioIndex: 1,
      codecs: 'hvc1.2.4.L150.B0,ec-3',
      play: 'hvc1.2.4.L150.B0,ec-3',
      duration: 24,
      session: 'ps1',
      dlDevice: 'dev-test-dl',
      init: 'http://jf.test/videos/m3/hls1/main/-1.mp4?PlaySessionId=ps1'
    });
    expect(man.item).toMatchObject({ Id: 'm3', Name: 'Film', Type: 'Movie', RunTimeTicks: 24 * TICKS_PER_SECOND });
    expect(man.source.Bitrate).toBe(12000000);   // original: the file's own rate
    expect(man.source.MediaStreams.map((s) => [s.Type, s.Index])).toEqual([['Video', 0], ['Audio', 1], ['Subtitle', 3]]);
    expect(man.source.MediaStreams[2]).toMatchObject({ Codec: 'webvtt', IsExternal: true, IsForced: true, Language: 'eng' });
    expect(man.subs).toEqual([{ index: 3, url: 'http://jf.test/Videos/m3/src-m3/Subtitles/3/0/Stream.vtt?api_key=tok', lang: 'eng', title: 'English', forced: true }]);
    expect(man.segs[3]).toEqual({ start: 18, end: 24, url: 'http://jf.test/videos/m3/hls1/main/3.mp4?PlaySessionId=ps1' });
    expect(srvBitrate(h)).toBe(200000000);
  });
});

function srvBitrate(h) {
  return h.net.calls.find((c) => c.path.endsWith('/PlaybackInfo')).body.MaxStreamingBitrate;
}

describe('artwork and subtitles ride along', () => {
  it('artwork is fetched before the first segment (the cover is there offline from then on)', async () => {
    const h = await bootOffline();
    const m = movie({ Id: 'a1', BackdropImageTags: ['bd'], MediaSources: [source(undefined, { Id: 'sa1' })] });
    jellyfinHls(h, m, { segs: 2 });
    h.off.queueDownload(m, 'original');
    await h.settle();
    const paths = h.net.calls.map((c) => c.path);
    const firstImg = paths.findIndex((p) => p.includes('/Images/'));
    const firstSeg = paths.findIndex((p) => /hls1\/main\/\d+\.mp4$/.test(p));
    expect(firstImg).toBeGreaterThan(-1);
    expect(firstImg).toBeLessThan(firstSeg);
  });

  it('a subtitle or artwork that fails does not fail the copy', async () => {
    const h = await bootOffline();
    const m = movie({ Id: 'a2', BackdropImageTags: ['bd'], MediaSources: [source(undefined, { Id: 'sa2' })] });
    const srv = jellyfinHls(h, m, { segs: 2, subs: [{ Index: 2 }, { Index: 3 }] });
    srv.image = () => h.net.status(500);
    h.net.on('GET', (r) => r.path.endsWith('/Subtitles/2/0/Stream.vtt'), h.net.networkError());
    h.net.on('GET', (r) => r.path.endsWith('/Subtitles/3/0/Stream.vtt'), h.net.status(404));
    h.off.queueDownload(m, 'original');
    await h.settle();
    expect(h.entry('a2').state).toBe('done');
    expect(h.files('u1.a2')).toEqual(['init', 'manifest', 's0', 's1']);
    expect(h.entry('a2').pics).toBe(0);
  });
});

describe('per-segment resume', () => {
  it('a relaunch picks up at the next missing segment: no new PlaybackInfo, nothing fetched twice', async () => {
    const h1 = await bootOffline();
    const m = movie({ Id: 'r1', MediaSources: [source(undefined, { Id: 'sr1' })] });
    const srv1 = jellyfinHls(h1, m, { segs: 5 });
    srv1.seg = (i) => (i === 2 ? h1.net.hang() : undefined);
    h1.off.queueDownload(m, 'original');
    await h1.settle();
    await h1.clock.tick(1000);   // the debounced index write
    const snapshot = h1.index();
    expect(snapshot[0]).toMatchObject({ state: 'downloading', done: 2, total: 5 });
    h1.off.pauseDownload('r1');   // (stops graph 1's loop; the snapshot is the "killed" state)
    await h1.settle(5);

    const h2 = await bootOffline({ index: snapshot, reuseCaches: h1.cs });
    // an index saved mid-download comes back queued
    expect(h2.entry('r1').state).toBe('queued');
    const srv2 = jellyfinHls(h2, m, { segs: 5 });
    h2.off.pump();
    await h2.settle();
    expect(h2.entry('r1')).toMatchObject({ state: 'done', done: 5 });
    expect(srv2.infoCalls).toEqual([]);   // the cached manifest is used
    expect(srv2.segFetches.map(([i]) => i)).toEqual([2, 3, 4]);
    expect(h2.files('u1.r1')).toEqual(['init', 'manifest', 'poster', 's0', 's1', 's2', 's3', 's4']);
  });

  it('segments already in the cache are skipped even when the index lagged behind', async () => {
    const h1 = await bootOffline();
    const m = movie({ Id: 'r2', MediaSources: [source(undefined, { Id: 'sr2' })] });
    const srv1 = jellyfinHls(h1, m, { segs: 4 });
    srv1.seg = (i) => (i === 3 ? h1.net.hang() : undefined);
    h1.off.queueDownload(m, 'original');
    await h1.settle();
    const snapshot = h1.index();   // written at the start: done 0, the debounced write never happened
    expect(snapshot[0].done).toBe(0);
    h1.off.pauseDownload('r2');
    await h1.settle(5);

    const h2 = await bootOffline({ index: snapshot, reuseCaches: h1.cs });
    const srv2 = jellyfinHls(h2, m, { segs: 4 });
    h2.off.pump();
    await h2.settle();
    expect(h2.entry('r2').state).toBe('done');
    expect(srv2.segFetches.map(([i]) => i)).toEqual([3]);
  });

  it('a fresh download starts from an empty folder (files of a failed copy are not taken as fetched)', async () => {
    const h = await bootOffline();
    h.cs.seed(OFFLINE_CACHE, '/offline/u1.r3/s0', 'stale');
    h.cs.seed(OFFLINE_CACHE, '/offline/u1.r3/manifest', '{"stale":true}');
    h.cs.seed(OFFLINE_CACHE, '/offline/u1.other/s0', 'keep');
    const m = movie({ Id: 'r3', MediaSources: [source(undefined, { Id: 'sr3' })] });
    const srv = jellyfinHls(h, m, { segs: 2 });
    h.off.queueDownload(m, 'original');
    await h.settle();
    expect(h.entry('r3').state).toBe('done');
    expect(srv.segFetches.map(([i]) => i)).toEqual([0, 1]);
    expect(srv.infoCalls).toHaveLength(1);
    expect(h.files('u1.other')).toEqual(['s0']);
    expect(h.entry('r3').sweep).toBe(null);
  });

  it('pause stops the job and the loop; resume continues where it stopped, on the same playlist', async () => {
    const h = await bootOffline();
    const m = movie({ Id: 'p1', MediaSources: [source(undefined, { Id: 'sp1' })] });
    const srv = jellyfinHls(h, m, { segs: 5 });
    srv.seg = (i) => (i === 2 ? h.net.hang() : undefined);
    h.off.queueDownload(m, 'original');
    await h.settle();
    expect(h.entry('p1').done).toBe(2);
    h.off.pauseDownload('p1');
    expect(h.entry('p1')).toMatchObject({ state: 'paused', error: null });
    expect(srv.stops).toEqual([{ deviceId: 'dev-test-dl', playSessionId: 'ps1' }]);
    expect(h.index()[0].state).toBe('paused');
    await h.settle();
    expect(h.entry('p1').state).toBe('paused');   // the aborted loop leaves it paused
    expect(srv.segFetches.map(([i]) => i)).toEqual([0, 1, 2]);
    srv.seg = null;
    h.off.resumeDownload('p1');
    await h.settle();
    expect(h.entry('p1')).toMatchObject({ state: 'done', done: 5 });
    expect(srv.segFetches.map(([i]) => i)).toEqual([0, 1, 2, 2, 3, 4]);
    expect(srv.infoCalls).toHaveLength(1);
  });

  it('pause / resume only act on the states they make sense for', async () => {
    const h = await bootOffline({
      index: [
        { id: 'd', user: 'u1', dir: 'u1.d', state: 'done', title: 'D', done: 2, total: 2 },
        { id: 'q', user: 'u1', dir: 'u1.q', state: 'paused', title: 'Q', error: null }
      ]
    });
    h.off.pauseDownload('d');
    expect(h.entry('d').state).toBe('done');
    h.off.resumeDownload('d');
    expect(h.entry('d').state).toBe('done');
    h.off.pauseDownload('nope');
    h.off.resumeDownload('nope');
    expect(h.off.OFF.list).toHaveLength(2);
  });

  it('pausing a queued copy (not the running one) keeps it out of the queue', async () => {
    const h = await bootOffline();
    const a = movie({ Id: 'qa', MediaSources: [source(undefined, { Id: 'sqa' })] });
    const b = movie({ Id: 'qb', MediaSources: [source(undefined, { Id: 'sqb' })] });
    const sa = jellyfinHls(h, a, { segs: 2 });
    const sb = jellyfinHls(h, b, { segs: 2 });
    sa.seg = (i) => (i === 1 ? h.net.hang() : undefined);
    h.off.queueDownload(a, 'original');
    h.off.queueDownload(b, 'original');
    expect(h.entry('qb').state).toBe('queued');   // one download at a time
    h.off.pauseDownload('qb');
    expect(h.entry('qb').state).toBe('paused');
    expect(sa.stops).toEqual([]);   // the running copy's job is left alone
    sa.seg = null;
    h.off.pauseDownload('qa');
    h.off.resumeDownload('qa');
    await h.settle();
    expect(h.entry('qa').state).toBe('done');
    expect(h.entry('qb').state).toBe('paused');
    expect(sb.infoCalls).toEqual([]);
    h.off.resumeDownload('qb');
    await h.settle();
    expect(h.entry('qb').state).toBe('done');
  });

  it('copies download one after another, in queue order', async () => {
    const h = await bootOffline();
    const a = movie({ Id: 'oa', MediaSources: [source(undefined, { Id: 'soa' })] });
    const b = movie({ Id: 'ob', MediaSources: [source(undefined, { Id: 'sob' })] });
    jellyfinHls(h, a, { segs: 2 });
    jellyfinHls(h, b, { segs: 2 });
    h.off.queueDownload(a, 'original');
    h.off.queueDownload(b, 'original');
    await h.settle();
    expect([h.entry('oa').state, h.entry('ob').state]).toEqual(['done', 'done']);
    const segs = h.net.calls.filter((c) => /hls1\/main\/\d+\.mp4$/.test(c.path)).map((c) => c.path.split('/')[2]);
    expect(segs).toEqual(['oa', 'oa', 'ob', 'ob']);
  });
});

describe('network trouble: retried 5 s, 15 s, 60 s, then parked as "Paused —"', () => {
  it('backs off on the schedule, then parks it with the reason', async () => {
    const h = await bootOffline();
    const m = movie({ Id: 'n1', MediaSources: [source(undefined, { Id: 'sn1' })] });
    const srv = jellyfinHls(h, m, { segs: 3 });
    srv.seg = (i) => (i === 1 ? h.net.networkError() : undefined);
    h.off.queueDownload(m, 'original');
    await h.settle();
    const tries = () => srv.segFetches.filter(([i]) => i === 1).length;
    expect(tries()).toBe(1);
    for (const [wait, n] of [[5000, 2], [15000, 3], [60000, 4]]) {
      await h.clock.tick(wait - 1);
      expect(tries()).toBe(n - 1);
      await h.clock.tick(1);
      await h.settle(10);
      expect(tries()).toBe(n);
    }
    expect(h.entry('n1')).toMatchObject({ state: 'paused', error: 'Paused — Failed to fetch', done: 1 });
    await h.clock.tick(600000);
    expect(tries()).toBe(4);
  });

  it('a pause during the back-off ends the wait at once and keeps it paused', async () => {
    const h = await bootOffline();
    const m = movie({ Id: 'n2', MediaSources: [source(undefined, { Id: 'sn2' })] });
    const srv = jellyfinHls(h, m, { segs: 3 });
    srv.seg = (i) => (i === 0 ? h.net.networkError() : undefined);
    h.off.queueDownload(m, 'original');
    await h.settle();
    h.off.pauseDownload('n2');
    await h.settle(10);
    expect(h.entry('n2')).toMatchObject({ state: 'paused', error: null });
    await h.clock.tick(100000);
    expect(srv.segFetches).toHaveLength(1);
  });

  it('a 401 / 403 / 404 on a segment re-resolves the playlist once and goes on with the new job', async () => {
    const h = await bootOffline();
    const m = movie({ Id: 't1', MediaSources: [source(undefined, { Id: 'st1' })] });
    const srv = jellyfinHls(h, m, { segs: 4 });
    srv.seg = (i, req) => (i === 2 && req.url.includes('ps1') ? h.net.status(401) : undefined);
    h.off.queueDownload(m, 'original');
    await h.settle();
    expect(h.entry('t1')).toMatchObject({ state: 'done', done: 4 });
    expect(srv.segFetches).toEqual([[0, 'ps1'], [1, 'ps1'], [2, 'ps1'], [2, 'ps2'], [3, 'ps2']]);
    expect(srv.infoCalls).toHaveLength(2);
    // the old job is stopped when it is replaced, the new one at the end
    expect(srv.stops.map((s) => s.playSessionId)).toEqual(['ps1', 'ps2']);
    const man = await (await h.cs.cache(OFFLINE_CACHE).match('/offline/u1.t1/manifest')).json();
    expect(man.session).toBe('ps2');
    expect(man.segs[0].url).toContain('PlaySessionId=ps2');
  });

  it('only once per pass: a second refusal is an error like any other', async () => {
    const h = await bootOffline();
    const m = movie({ Id: 't2', MediaSources: [source(undefined, { Id: 'st2' })] });
    const srv = jellyfinHls(h, m, { segs: 3 });
    srv.seg = (i) => (i === 1 ? h.net.status(403) : undefined);
    h.off.queueDownload(m, 'original');
    await h.settle();
    expect(srv.infoCalls).toHaveLength(2);
    expect(srv.segFetches.filter(([i]) => i === 1)).toHaveLength(2);
    expect(h.entry('t2').state).toBe('downloading');   // waiting out its first back-off
  });

  it('…also when the second refusal comes on a later segment', async () => {
    const h = await bootOffline();
    const m = movie({ Id: 't5', MediaSources: [source(undefined, { Id: 'st5' })] });
    const srv = jellyfinHls(h, m, { segs: 4 });
    srv.seg = (i, req) => ((i === 0 && req.url.includes('ps1')) || i === 2 ? h.net.status(401) : undefined);
    h.off.queueDownload(m, 'original');
    await h.settle();
    expect(srv.infoCalls).toHaveLength(2);
    expect(srv.segFetches).toEqual([[0, 'ps1'], [0, 'ps2'], [1, 'ps2'], [2, 'ps2']]);
    expect(h.entry('t5')).toMatchObject({ state: 'downloading', done: 2 });
  });

  it('a playlist with a different length means the file changed: the copy fails for good', async () => {
    const h = await bootOffline();
    const m = movie({ Id: 't3', MediaSources: [source(undefined, { Id: 'st3' })] });
    const srv = jellyfinHls(h, m, { segs: 4 });
    srv.seg = (i) => {
      if (i === 1) {
        srv.segs = 5;
        return h.net.status(404);
      }
    };
    h.off.queueDownload(m, 'original');
    await h.settle();
    expect(h.entry('t3')).toMatchObject({ state: 'error', error: 'The file changed on the server — delete and download again' });
    expect(srv.stops.map((s) => s.playSessionId)).toEqual(['ps2']);   // the fresh job; ps1 stays the manifest's
    await h.clock.tick(100000);
    expect(srv.infoCalls).toHaveLength(2);   // no retries
  });
});

describe('what Jellyfin can get wrong while a copy starts', () => {
  /* Retryable: the network, the token, a server hiccup — retried, then parked
   * 'Paused — …' (initOffline's kick re-queues those). */
  it.each([
    ['the media playlist failing', (srv, h) => (srv.playlist = () => h.net.status(500)), 'Paused — playlist: HTTP 500'],
    ['the init segment failing', (srv, h) => (srv.init = () => h.net.status(503)), 'Paused — HTTP 503'],
    ['the item answering 401 (the token, not the title)', (srv, h) => (srv.item = () => h.net.status(401)), 'Paused — The server refused this sign-in (HTTP 401)'],
    ['the item answering 500', (srv, h) => (srv.item = () => h.net.status(500)), 'Paused — The server had a problem (HTTP 500)'],
    ['the item answering 429', (srv, h) => (srv.item = () => h.net.status(429)), 'Paused — The server answered HTTP 429'],
    ['PlaybackInfo answering 502', (srv, h) => h.net.on('POST', (r) => r.path.endsWith('/PlaybackInfo'), h.net.status(502)), 'Paused — The server had a problem (HTTP 502)']
  ])('retried, then parked with its reason: %s', async (_, breakIt, error) => {
    const h = await bootOffline();
    const m = movie({ Id: 'j1', MediaSources: [source(undefined, { Id: 'sj1' })] });
    const srv = jellyfinHls(h, m, { segs: 2 });
    breakIt(srv, h, m);
    h.off.queueDownload(m, 'original');
    await h.settle();
    for (const wait of [5000, 15000, 60000]) {
      await h.clock.tick(wait);
      await h.settle(10);
    }
    expect(h.entry('j1')).toMatchObject({ state: 'paused', error });
    expect(srv.itemCalls).toBe(4);
    expect(h.files('u1.j1')).toEqual([]);   // no manifest: the next try starts over
  });

  /* R3-PO-1: final — Jellyfin answered, and asking again won't change it. An
   * 'error' at once, no retries (the kick never re-queues an 'error'). */
  it.each([
    ['no file for the title', (srv, h, m) => (srv.item = { ...m, MediaSources: [] }), 'Jellyfin has no file for this title'],
    ['PlaybackInfo without a stream', (srv, h) => h.net.on('POST', (r) => r.path.endsWith('/PlaybackInfo'), { MediaSources: [{ Id: 'x' }] }), 'Jellyfin offered no stream for this title'],
    ['an empty playlist', (srv, h) => (srv.playlist = () => h.net.text('#EXTM3U\n#EXT-X-ENDLIST\n')), 'Jellyfin’s playlist is empty'],
    ['the item answering 404', (srv, h) => (srv.item = () => h.net.status(404)), 'Not found on the server (HTTP 404)'],
    ['the item answering 403', (srv, h) => (srv.item = () => h.net.status(403)), 'The server refused this sign-in (HTTP 403)'],
    ['PlaybackInfo answering 400', (srv, h) => h.net.on('POST', (r) => r.path.endsWith('/PlaybackInfo'), h.net.status(400)), 'The server answered HTTP 400']
  ])('R3-PO-1: final at once: %s', async (_, breakIt, error) => {
    const h = await bootOffline();
    const m = movie({ Id: 'j1', MediaSources: [source(undefined, { Id: 'sj1' })] });
    const srv = jellyfinHls(h, m, { segs: 2 });
    breakIt(srv, h, m);
    h.off.queueDownload(m, 'original');
    await h.settle();
    expect(h.entry('j1')).toMatchObject({ state: 'error', error });
    await h.clock.tick(100000);
    await h.settle(10);
    expect(srv.itemCalls).toBe(1);
    expect(h.files('u1.j1')).toEqual([]);
  });

  it('R3-PO-1: an empty playlist stops the job PlaybackInfo started', async () => {
    const h = await bootOffline();
    const m = movie({ Id: 'j1', MediaSources: [source(undefined, { Id: 'sj1' })] });
    const srv = jellyfinHls(h, m, { segs: 2 });
    srv.playlist = () => h.net.text('#EXTM3U\n#EXT-X-ENDLIST\n');
    h.off.queueDownload(m, 'original');
    await h.settle();
    expect(h.entry('j1').state).toBe('error');
    expect(srv.stops.map((s) => s.playSessionId)).toEqual(['ps1']);
  });

  it('R3-PO-1: a final error still takes a manual retry, which can succeed', async () => {
    const h = await bootOffline();
    const m = movie({ Id: 'j1', MediaSources: [source(undefined, { Id: 'sj1' })] });
    const srv = jellyfinHls(h, m, { segs: 2 });
    srv.item = () => h.net.status(404);
    h.off.queueDownload(m, 'original');
    await h.settle();
    expect(h.entry('j1').state).toBe('error');
    srv.item = m;
    h.off.resumeDownload('j1');
    await h.settle();
    expect(h.entry('j1')).toMatchObject({ state: 'done', done: 2, error: null });
    expect(srv.itemCalls).toBe(2);
  });

  it('a master playlist that fails is not fatal: the copy just has no CODECS to offer beyond the default', async () => {
    const h = await bootOffline();
    const m = movie({ Id: 'j2', MediaSources: [source(undefined, { Id: 'sj2' })] });
    jellyfinHls(h, m, { segs: 1 });
    h.net.on('GET', (r) => r.path === '/videos/j2/master.m3u8', h.net.status(500));
    h.off.queueDownload(m, 'original');
    await h.settle();
    // an empty CODECS string is offered to the MediaSource as it is
    expect(h.mse.typeQueries).toContain('video/mp4; codecs=""');
  });

  it('a copy deleted during its back-off ends there', async () => {
    const h = await bootOffline();
    const m = movie({ Id: 'j3', MediaSources: [source(undefined, { Id: 'sj3' })] });
    const srv = jellyfinHls(h, m, { segs: 2 });
    srv.seg = () => h.net.networkError();
    h.off.queueDownload(m, 'original');
    await h.settle();
    await h.off.deleteDownload('j3');
    expect(h.off.OFF.list).toEqual([]);
    await h.clock.tick(100000);
    await h.settle(10);
    expect(srv.segFetches).toHaveLength(1);
    expect(h.allFiles()).toEqual([]);
  });

  it('a resumed copy does not fetch subtitles it already has', async () => {
    const h = await bootOffline();
    const m = movie({ Id: 'j4', MediaSources: [source(undefined, { Id: 'sj4' })] });
    const srv = jellyfinHls(h, m, { segs: 2, subs: [{ Index: 2 }] });
    h.off.queueDownload(m, 'original');
    await h.settle();
    expect(srv.subFetches).toHaveLength(1);
    // a re-run over the finished copy (as a resume after the last segment would be)
    h.entry('j4').state = 'paused';
    h.off.resumeDownload('j4');
    await h.settle();
    expect(h.entry('j4').state).toBe('done');
    expect(srv.subFetches).toHaveLength(1);
    expect(srv.segFetches).toHaveLength(2);
  });

  it('a copy started by an older build (no img, the backdrop in its manifest) gets that backdrop', async () => {
    const h1 = await bootOffline();
    const m = movie({ Id: 'j5', ImageTags: {}, MediaSources: [source(undefined, { Id: 'sj5' })] });
    const srv1 = jellyfinHls(h1, m, { segs: 2 });
    srv1.seg = (i) => (i === 1 ? h1.net.hang() : undefined);
    h1.off.queueDownload(m, 'original');
    await h1.settle();
    h1.off.pauseDownload('j5');
    await h1.settle(5);
    // rewrite the copy as an older build left it: manifest.art, no img on the entry
    const c = h1.cs.cache(OFFLINE_CACHE);
    const man = await (await c.match('/offline/u1.j5/manifest')).json();
    man.art = 'http://jf.test/Items/j5/Images/Backdrop?tag=old';
    await c.put('/offline/u1.j5/manifest', new Response(JSON.stringify(man)));
    const index = h1.index().map((e) => ({ ...e, img: undefined, state: 'queued' }));

    const h2 = await bootOffline({ index, reuseCaches: h1.cs });
    const srv2 = jellyfinHls(h2, m, { segs: 2 });
    h2.off.pump();
    await h2.settle();
    expect(h2.entry('j5')).toMatchObject({ state: 'done', img: { art: 'http://jf.test/Items/j5/Images/Backdrop?tag=old' } });
    expect(srv2.images).toEqual(['http://jf.test/Items/j5/Images/Backdrop?tag=old']);
    expect(h2.files('u1.j5')).toContain('art');
  });
});

describe('room: a download stops with less than 500 MB left', () => {
  const NO_ROOM = 'Stopped — less than 500 MB left for VibeReel on this iPhone. Delete a download or free up space, then tap to resume';

  it('does not start below 500 MB free; waits for the user (not re-queued on its own)', async () => {
    const h = await bootOffline({ quota: 10e9, usage: 10e9 - 500 * MB + 1 });
    const m = movie({ Id: 'q1', MediaSources: [source(undefined, { Id: 'sq1' })] });
    const srv = jellyfinHls(h, m, { segs: 2 });
    h.off.queueDownload(m, 'original');
    await h.settle();
    expect(h.entry('q1')).toMatchObject({ state: 'paused', error: NO_ROOM });
    expect(h.toast.toastState.msg).toBe('Download stopped — the iPhone is almost out of room for VibeReel');
    expect(srv.infoCalls).toEqual([]);
    expect(srv.segFetches).toEqual([]);
  });

  it('exactly 500 MB free is enough to start', async () => {
    const h = await bootOffline({ quota: 10e9, usage: 10e9 - 500 * MB });
    const m = movie({ Id: 'q2', MediaSources: [source(undefined, { Id: 'sq2' })] });
    jellyfinHls(h, m, { segs: 2 });
    h.off.queueDownload(m, 'original');
    await h.settle();
    expect(h.entry('q2').state).toBe('done');
  });

  it('a browser that will not say how much room there is does not stop it', async () => {
    const h = await bootOffline();
    h.st.quota = null;
    const m = movie({ Id: 'q3', MediaSources: [source(undefined, { Id: 'sq3' })] });
    jellyfinHls(h, m, { segs: 2 });
    h.off.queueDownload(m, 'original');
    await h.settle();
    expect(h.entry('q3').state).toBe('done');
    expect(h.off.freeBytes()).toBe(null);
  });

  it('checked again every 128 MB written: stops mid-way, job stopped, the copy kept for a resume', async () => {
    const base = 1e9;
    const h = await bootOffline({ quota: base + 800 * MB });
    h.st.usage = () => base + h.cs.bytes();
    const m = movie({ Id: 'q4', MediaSources: [source(undefined, { Id: 'sq4' })] });
    const srv = jellyfinHls(h, m, { segs: 20, segSize: 64 * MB });
    h.off.queueDownload(m, 'original');
    await h.settle();
    // 64 MB segments: checks after 2, 4, 6 → 672, 544, 416 MB left → stops after the 6th
    expect(h.entry('q4')).toMatchObject({ state: 'paused', error: NO_ROOM, done: 6 });
    expect(srv.segFetches.map(([i]) => i)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(srv.stops).toEqual([{ deviceId: 'dev-test-dl', playSessionId: 'ps1' }]);
    expect(h.entry('q4').bytes).toBe(6 * 64 * MB + 72);   // Content-Length per segment + the init (72 bytes)
    // the start check, one per 128 MB, and the refresh after the loop — not one per segment
    expect(h.st.estimate).toHaveBeenCalledTimes(1 + 3 + 1);
    // freeing room and tapping resume continues with segment 6
    h.st.quota = base + 5000 * MB;
    h.off.resumeDownload('q4');
    await h.settle();
    expect(h.entry('q4').state).toBe('done');
    expect(srv.segFetches.map(([i]) => i).slice(6)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it.each([
    ['by name', () => new DOMException('The operation failed.', 'QuotaExceededError')],
    ['by message (WebKit)', () => new DOMException('Exceeded storage quota', 'UnknownError')]
  ])('a put the quota refuses (%s) fails the copy with the room message', async (_, err) => {
    const h = await bootOffline();
    const m = movie({ Id: 'q5', MediaSources: [source(undefined, { Id: 'sq5' })] });
    jellyfinHls(h, m, { segs: 3 });
    h.cs.beforePut = (p) => {
      if (p.endsWith('/s1')) throw err();
    };
    h.off.queueDownload(m, 'original');
    await h.settle();
    expect(h.entry('q5')).toMatchObject({ state: 'error', error: 'The iPhone has no more room for downloads — delete one, or free up space' });
  });

  it('a put that fails for another reason is retried like network trouble', async () => {
    const h = await bootOffline();
    const m = movie({ Id: 'q6', MediaSources: [source(undefined, { Id: 'sq6' })] });
    const srv = jellyfinHls(h, m, { segs: 3 });
    let fail = true;
    h.cs.beforePut = (p) => {
      if (p.endsWith('/s1') && fail) {
        fail = false;
        throw new TypeError('body stream broke off');
      }
    };
    h.off.queueDownload(m, 'original');
    await h.settle();
    expect(h.entry('q6').state).toBe('downloading');
    await h.clock.tick(5000);
    await h.settle();
    expect(h.entry('q6').state).toBe('done');
    expect(srv.segFetches.filter(([i]) => i === 1)).toHaveLength(2);
  });

  it('bytes come from Content-Length, or from the body when there is none', async () => {
    const h = await bootOffline();
    const m = movie({ Id: 'q7', MediaSources: [source(undefined, { Id: 'sq7' })] });
    jellyfinHls(h, m, { segs: 3 });
    h.off.queueDownload(m, 'original');
    await h.settle();
    expect(h.entry('q7').bytes).toBe(72 + 3 * 5);   // init (72 bytes) + three 5-byte segments
  });
});

describe('one copy per account + item', () => {
  it('a second tap says so instead of queueing it again', async () => {
    const h = await bootOffline();
    const m = movie({ Id: 'c1', Name: 'Heat', MediaSources: [source(undefined, { Id: 'sc1' })] });
    const srv = jellyfinHls(h, m, { segs: 2 });
    srv.seg = (i) => (i === 1 ? h.net.hang() : undefined);
    h.off.queueDownload(m, 'original');
    h.off.queueDownload(m, 4000000);
    expect(h.toast.toastState.msg).toBe('Already downloading');
    expect(h.off.OFF.list).toHaveLength(1);
    srv.seg = null;
    h.off.pauseDownload('c1');
    h.off.resumeDownload('c1');
    await h.settle();
    h.off.queueDownload(m, 'original');
    expect(h.toast.toastState.msg).toBe('Already downloaded');
    expect(h.off.OFF.list).toHaveLength(1);
    expect(h.entry('c1').quality).toBe('original');
  });

  it('another account keeps its own copy of the same title, in its own folder', async () => {
    const h = await bootOffline({
      index: [{ id: 'c2', user: 'u2', dir: 'u2.c2', state: 'done', title: 'Theirs', done: 1, total: 1, type: 'Movie' }]
    });
    h.cs.seed(OFFLINE_CACHE, '/offline/u2.c2/s0', 'theirs');
    h.cs.seed(OFFLINE_CACHE, '/offline/u2.c2/manifest', '{}');
    const m = movie({ Id: 'c2', MediaSources: [source(undefined, { Id: 'sc2' })] });
    jellyfinHls(h, m, { segs: 2 });
    expect(h.off.entryOf('c2')).toBe(null);   // u2's copy is not u1's
    h.off.queueDownload(m, 'original');
    await h.settle();
    expect(h.off.OFF.list.map((e) => [e.user, e.dir, e.state])).toEqual([
      ['u2', 'u2.c2', 'done'],
      ['u1', 'u1.c2', 'done']
    ]);
    expect(h.files('u2.c2')).toEqual(['manifest', 's0']);
    await h.off.deleteDownload('c2');
    expect(h.off.OFF.list.map((e) => e.user)).toEqual(['u2']);
    expect(h.files('u1.c2')).toEqual([]);
    expect(h.files('u2.c2')).toEqual(['manifest', 's0']);
  });

  it("only the signed-in account's queue runs", async () => {
    const h = await bootOffline({
      index: [{ id: 'c3', user: 'u2', dir: 'u2.c3', state: 'queued', title: 'Theirs', done: 0, total: 0, type: 'Movie', quality: 'original' }]
    });
    h.off.pump();
    await h.settle();
    expect(h.net.calls).toEqual([]);
    expect(h.off.OFF.list[0].state).toBe('queued');
  });

  it('a failed copy is replaced by a fresh one; its old (pre-account) folder is swept', async () => {
    const h = await bootOffline({
      index: [{ id: 'c4', user: 'u1', state: 'error', error: 'boom', title: 'Old', done: 3, total: 9, type: 'Movie', quality: 'original' }]
    });
    h.cs.seed(OFFLINE_CACHE, '/offline/c4/s0', 'old');
    h.cs.seed(OFFLINE_CACHE, '/offline/c4/manifest', '{}');
    const m = movie({ Id: 'c4', MediaSources: [source(undefined, { Id: 'sc4' })] });
    const srv = jellyfinHls(h, m, { segs: 2 });
    h.off.queueDownload(m, 'original');
    expect(h.off.OFF.list).toHaveLength(1);
    expect(h.entry('c4')).toMatchObject({ dir: 'u1.c4', state: 'downloading', done: 0, sweep: ['u1.c4', 'c4'] });
    await h.settle();
    expect(h.entry('c4').state).toBe('done');
    expect(h.files('c4')).toEqual([]);
    expect(srv.segFetches.map(([i]) => i)).toEqual([0, 1]);
  });

  it('entries saved without an account belong to whoever is signed in (and are saved so)', async () => {
    const h = await bootOffline({
      index: [{ id: 'c5', state: 'done', title: 'Legacy', done: 1, total: 1, type: 'Movie' }, { x: 1 }, null]
    });
    expect(h.off.OFF.list).toEqual([expect.objectContaining({ id: 'c5', user: 'u1' })]);
    expect(h.off.entryOf('c5')).not.toBe(null);
  });

  it('a corrupt index starts empty', async () => {
    const h = await bootOffline({ storage: { 'reel.offline': '{nope' } });
    expect(h.off.OFF.list).toEqual([]);
    const h2 = await bootOffline({ storage: { 'reel.offline': '{"a":1}' } });
    expect(h2.off.OFF.list).toEqual([]);
  });
});

describe('delete', () => {
  it('deleting the running copy waits for its in-flight write before sweeping the folder', async () => {
    const h = await bootOffline();
    const m = movie({ Id: 'x1', MediaSources: [source(undefined, { Id: 'sx1' })] });
    const srv = jellyfinHls(h, m, { segs: 4 });
    let release;
    const held = new Promise((r) => (release = r));
    h.cs.beforePut = async (p) => {
      if (p.endsWith('/s1')) await held;
    };
    h.off.queueDownload(m, 'original');
    await h.settle();
    expect(h.files('u1.x1')).toContain('s0');
    localStorage.setItem('reel.offline.swept', '123');
    const del = h.off.deleteDownload('x1');
    expect(h.off.OFF.list).toEqual([]);
    expect(h.index()).toEqual([]);
    // a kill before the sweep below finishes: the next start's orphan sweep must run
    expect(localStorage.getItem('reel.offline.swept')).toBe(null);
    expect(srv.stops).toEqual([{ deviceId: 'dev-test-dl', playSessionId: 'ps1' }]);
    await h.settle(5);
    release();
    await del;
    await h.settle(5);   // anything still in flight lands now — and must not leave a stray file
    expect(h.files('u1.x1')).toEqual([]);
    expect(srv.segFetches.map(([i]) => i)).toEqual([0, 1]);
  });

  it('deleting a finished copy removes its files and nothing else', async () => {
    const h = await bootOffline();
    const m = movie({ Id: 'x2', MediaSources: [source(undefined, { Id: 'sx2' })] });
    const srv = jellyfinHls(h, m, { segs: 2 });
    h.cs.seed(OFFLINE_CACHE, '/offline/u1.x3/s0', 'other');
    h.off.queueDownload(m, 'original');
    await h.settle();
    const stops = srv.stops.length;
    await h.off.deleteDownload('x2');
    expect(h.files('u1.x2')).toEqual([]);
    expect(h.files('u1.x3')).toEqual(['s0']);
    expect(srv.stops).toHaveLength(stops);   // nothing running: no job to stop
    await h.off.deleteDownload('x2');   // already gone: nothing happens
  });
});

describe('formats', () => {
  it("a format this iPhone can't play fails at once, before any segment, and stops the job", async () => {
    const h = await bootOffline({ supported: (mime) => !/hvc1/.test(mime) });
    const m = movie({ Id: 'f1', MediaSources: [source(undefined, { Id: 'sf1' })] });
    const srv = jellyfinHls(h, m, { segs: 3 });
    h.off.queueDownload(m, 'original');
    await h.settle();
    expect(h.entry('f1')).toMatchObject({ state: 'error', error: 'This iPhone can’t play this format offline (hvc1.2.4.L150.B0,ec-3)' });
    expect(srv.segFetches).toEqual([]);
    expect(srv.stops).toEqual([{ deviceId: 'dev-test-dl', playSessionId: 'ps1' }]);
    expect(h.files('u1.f1')).toEqual([]);
    await h.clock.tick(100000);
    expect(srv.infoCalls).toHaveLength(1);
  });

  it.each([
    ['DV where it plays: SUPPLEMENTAL-CODECS (dvhe → dvh1) + the audio', 'dvh1', 'dvhe.08.07/db1p', () => true, 'dvh1.08.07,ec-3'],
    ['a dvhe sample entry counts as DV too', 'dvhe', 'dvh1.08.07/db1p', () => true, 'dvh1.08.07,ec-3'],
    ['SUPPLEMENTAL-CODECS refused: the profile 8 default', 'dvh1', 'dvhe.08.07/db1p', (mime) => !/08\.07/.test(mime), 'dvh1.08.06,ec-3'],
    ['DV without SUPPLEMENTAL-CODECS: the profile 8 default', 'dvh1', '', () => true, 'dvh1.08.06,ec-3'],
    ['DV the iPhone refuses: the HDR10 base', 'dvhe', 'dvh1.08.06/db1p', (mime) => !/dvh1/.test(mime), 'hvc1.2.4.L150.B0,ec-3'],
    ['not DV: the master CODECS as they are', 'hvc1', 'dvh1.08.06/db1p', () => true, 'hvc1.2.4.L150.B0,ec-3']
  ])('codec pick — %s', async (_, entry, supp, supported, want) => {
    const h = await bootOffline({ supported });
    const m = movie({ Id: 'f2', MediaSources: [source(undefined, { Id: 'sf2' })] });
    jellyfinHls(h, m, { segs: 1, entry, supp });
    h.off.queueDownload(m, 'original');
    await h.settle();
    const man = await (await h.cs.cache(OFFLINE_CACHE).match('/offline/u1.f2/manifest')).json();
    expect(man.play).toBe(want);
  });

  it('video-only master CODECS: the DV candidate carries no audio part', async () => {
    const h = await bootOffline();
    const m = movie({ Id: 'f3', MediaSources: [source(undefined, { Id: 'sf3' })] });
    jellyfinHls(h, m, { segs: 1, entry: 'dvh1', supp: 'dvhe.08.06/db1p', codecs: 'hvc1.2.4.L150.B0' });
    h.off.queueDownload(m, 'original');
    await h.settle();
    const man = await (await h.cs.cache(OFFLINE_CACHE).match('/offline/u1.f3/manifest')).json();
    expect(man.play).toBe('dvh1.08.06');
  });
});

describe('queueing', () => {
  it('no Cache Storage or no MediaSource: says so, queues nothing', async () => {
    const h = await bootOffline({ caches: false });
    expect(h.off.offlineSupported()).toBe(false);
    h.off.queueDownload(movie({ Id: 'z1' }), 'original');
    expect(h.toast.toastState.msg).toBe('Downloads need iOS 17.1 or later');
    expect(h.off.OFF.list).toEqual([]);
    const h2 = await bootOffline({ managed: false });
    expect(h2.off.offlineSupported()).toBe(false);
    h2.off.pump();
  });

  it('asks for persistent storage from the tap', async () => {
    const h = await bootOffline();
    const m = movie({ Id: 'z2', MediaSources: [source(undefined, { Id: 'sz2' })] });
    jellyfinHls(h, m, { segs: 1 });
    h.off.queueDownload(m, 'original');
    expect(h.st.persist).toHaveBeenCalledTimes(1);
    await h.settle();
    expect(h.off.OFF.persisted).toBe(true);
  });

  it('an episode: title, "Series · S2E5" line, series, the start position from UserData', async () => {
    const h = await bootOffline();
    const ep = episode({
      Id: 'e1', Name: 'Pilot', SeriesName: 'Silo', SeriesId: 'ser1', ParentIndexNumber: 2, IndexNumber: 5,
      RunTimeTicks: 3000 * TICKS_PER_SECOND,
      UserData: { PlaybackPositionTicks: 754.9 * TICKS_PER_SECOND },
      MediaSources: [source(undefined, { Id: 'se1' })]
    });
    jellyfinHls(h, ep, { segs: 1 });
    h.off.queueDownload(ep, 4000000);
    expect(h.entry('e1')).toMatchObject({ type: 'Episode', title: 'Pilot', line: 'Silo · S2E5', series: 'Silo', seriesId: 'ser1', pos: 754, dur: 3000, posAt: 0, sync: false, quality: 4000000 });
    await h.settle();
  });

  it.each([
    [{ Type: 'Episode', SeriesName: undefined, ParentIndexNumber: undefined, IndexNumber: undefined }, 'S?E?'],
    [{ Type: 'Movie', ProductionYear: undefined }, 'Movie'],
    [{ Type: 'Movie', ProductionYear: 1995 }, '1995']
  ])('the line under the title (%o)', async (o, line) => {
    const h = await bootOffline();
    const it = { ...movie({ Id: 'l1', MediaSources: [source(undefined, { Id: 'sl1' })] }), ...o };
    jellyfinHls(h, it, { segs: 1 });
    h.off.queueDownload(it, 'original');
    expect(h.entry('l1').line).toBe(line);
    await h.settle();
  });
});

describe('estimateBytes', () => {
  const at = (bitrate, sec = 1000) => movie({ RunTimeTicks: sec * TICKS_PER_SECOND, MediaSources: [source(undefined, { Bitrate: bitrate })] });
  it('original: the file’s own rate', async () => {
    const h = await bootOffline();
    expect(h.off.estimateBytes(at(20e6), 'original')).toBe((20e6 * 1000) / 8);
    expect(h.off.estimateBytes(at(20e6), null)).toBe((20e6 * 1000) / 8);
  });
  it('a cap above the file: copied as it is', async () => {
    const h = await bootOffline();
    expect(h.off.estimateBytes(at(3e6), 4000000)).toBe((3e6 * 1000) / 8);
    expect(h.off.estimateBytes(at(4e6), 4000000)).toBe((4e6 * 1000) / 8);
  });
  it('a cap under the file: the cap plus ~256 kbit/s of audio', async () => {
    const h = await bootOffline();
    expect(h.off.estimateBytes(at(20e6), 8000000)).toBe(((8000000 + 256000) * 1000) / 8);
  });
  it('unknown length or rate: 0', async () => {
    const h = await bootOffline();
    expect(h.off.estimateBytes(at(0), 'original')).toBe(0);
    expect(h.off.estimateBytes({ ...at(20e6), RunTimeTicks: 0, MediaSources: [source(undefined, { Bitrate: 20e6, RunTimeTicks: 0 })] }, 'original')).toBe(0);
    expect(h.off.estimateBytes({ RunTimeTicks: 0 }, 'original')).toBe(0);
    // the source's runtime stands in for the item's
    expect(h.off.estimateBytes({ ...at(8e6), RunTimeTicks: 0 }, 'original')).toBe((8e6 * 3600) / 8);
  });
});
