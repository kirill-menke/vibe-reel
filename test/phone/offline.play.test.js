/* offline.svelte.js — playing an offline copy, its position, and the sync of
 * that position back to Jellyfin.
 *
 * CLAUDE.md (iPhone app): "nothing reports to Jellyfin while one plays — the
 * position is checkpointed into the index on every pause and on backgrounding
 * (`checkpointFeed()`; iOS kills a suspended app without `pagehide`), never
 * from a close before the first frame (`restartPos()` + `feedRun.started`),
 * and goes up as UserData later, unless the server has a newer
 * `LastPlayedDate`." The player side (checkpointFeed calling `checkpoint` on
 * pause / backgrounding, `started` false before the first frame) is pinned in
 * test/shared/player.modes.test.js and test/phone/lifecycle.test.js; here the
 * offline module's half: what `checkpoint` and `exit` do with what they are
 * told, and syncPositions().
 *
 * player.svelte.js is a stub; segfeed's createSegFeeder is replaced by a
 * recorder (stubFeeder) so the feeder's options can be checked against the cache. */
import { describe, it, expect, vi } from 'vitest';
import { bootOffline, OFFLINE_CACHE } from '../helpers/offline.js';
import { TICKS_PER_SECOND, START } from '../helpers/time.js';
import { langKey } from '../../src/lib/tracks.js';

const T = TICKS_PER_SECOND;
const iso = (ms) => new Date(ms).toISOString();

function entry(o = {}) {
  return { id: 'm1', user: 'u1', dir: 'u1.m1', type: 'Movie', title: 'Dune', state: 'done', done: 3, total: 3, pos: 0, posAt: 0, sync: false, played: false, dur: 3000, ...o };
}

function manifest(o = {}) {
  return {
    v: 1,
    item: { Id: 'm1', Name: 'Dune', Type: 'Movie', RunTimeTicks: 3000 * T, Genres: [], Overview: '' },
    source: {
      Id: 'offline',
      RunTimeTicks: 3000 * T,
      Bitrate: 8000000,
      MediaStreams: [
        { Type: 'Video', Index: 0, Codec: 'hevc' },
        { Type: 'Audio', Index: 1, Codec: 'eac3', Language: 'eng', Channels: 6 },
        { Type: 'Subtitle', Index: 3, Codec: 'webvtt', Language: 'eng', Title: 'English', DisplayTitle: 'English', IsForced: false, IsExternal: true },
        { Type: 'Subtitle', Index: 4, Codec: 'webvtt', Language: 'ger', Title: 'Deutsch', DisplayTitle: 'Deutsch', IsForced: false, IsExternal: true }
      ]
    },
    audioIndex: 1,
    codecs: 'hvc1.2.4.L150.B0,ec-3',
    play: 'dvh1.08.06,ec-3',
    duration: 3000,
    init: 'http://jf.test/videos/m1/hls1/main/-1.mp4',
    segs: [
      { start: 0, end: 1000, url: 'x0' },
      { start: 1000, end: 2000, url: 'x1' },
      { start: 2000, end: 3000, url: 'x2' }
    ],
    subs: [],
    session: 'ps1',
    dlDevice: 'dev-test-dl',
    ...o
  };
}

/* a finished copy in the cache: manifest, init, segments, the English sub (the German one is missing) */
function seedCopy(h, { dir = 'u1.m1', man = manifest(), art = [] } = {}) {
  h.cs.seed(OFFLINE_CACHE, '/offline/' + dir + '/manifest', JSON.stringify(man), { 'Content-Type': 'application/json' });
  h.cs.seed(OFFLINE_CACHE, '/offline/' + dir + '/init', new Uint8Array([1, 2, 3]).buffer);
  for (let i = 0; i < man.segs.length; i++) h.cs.seed(OFFLINE_CACHE, '/offline/' + dir + '/s' + i, new Uint8Array([9, i]).buffer);
  h.cs.seed(OFFLINE_CACHE, '/offline/' + dir + '/sub3', 'WEBVTT\n\n00:01.000 --> 00:02.000\nhello\n');
  for (const p of art) h.cs.seed(OFFLINE_CACHE, '/offline/' + dir + '/' + p, new Blob([p]).size ? new TextEncoder().encode(p).buffer : '', { 'Content-Type': 'image/jpeg' });
}

/* GET /Items/{id}?userId= → UserData */
function serverItem(h, id, ud, opts) {
  const calls = [];
  h.net.on('GET', (r) => r.path === '/Items/' + id, (req) => {
    calls.push(req);
    return typeof ud === 'function' ? ud(req) : { Id: id, UserData: ud };
  }, opts);
  return calls;
}
function userDataPosts(h, id) {
  const posts = [];
  h.net.on('POST', (r) => r.path === '/UserItems/' + id + '/UserData', (req) => {
    posts.push(req);
    return null;
  });
  return posts;
}

async function startOffline(h, id = 'm1') {
  await h.off.playOffline(id);
  await h.settle(3);
  expect(h.player.playFeedStream).toHaveBeenCalledTimes(1);
  return h.player.playFeedStream.mock.calls[0][0];
}

describe('syncPositions(): positions watched offline → Jellyfin UserData', () => {
  it('POSTs position / played / LastPlayedDate when the server has nothing newer, then clears the flag', async () => {
    const at = START - 60000;
    const h = await bootOffline({ index: [entry({ pos: 1234, posAt: at, sync: true })] });
    serverItem(h, 'm1', { LastPlayedDate: iso(at - 1000), PlaybackPositionTicks: 99 * T, Played: false });
    const posts = userDataPosts(h, 'm1');
    await h.off.syncPositions();
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('http://jf.test/UserItems/m1/UserData?userId=u1');
    expect(posts[0].body).toEqual({ PlaybackPositionTicks: 1234 * T, Played: false, LastPlayedDate: iso(at) });
    expect(h.entry('m1').sync).toBe(false);
    expect(h.index()[0].sync).toBe(false);   // saved at once
  });

  it('never played on the server (no LastPlayedDate): ours goes up', async () => {
    const h = await bootOffline({ index: [entry({ pos: 10, posAt: START - 5, sync: true })] });
    serverItem(h, 'm1', {});
    const posts = userDataPosts(h, 'm1');
    await h.off.syncPositions();
    expect(posts).toHaveLength(1);
  });

  it('the same LastPlayedDate is not "newer": ours goes up', async () => {
    const at = START - 60000;
    const h = await bootOffline({ index: [entry({ pos: 50, posAt: at, sync: true })] });
    serverItem(h, 'm1', { LastPlayedDate: iso(at) });
    const posts = userDataPosts(h, 'm1');
    await h.off.syncPositions();
    expect(posts).toHaveLength(1);
  });

  it('skipped when the server has a newer LastPlayedDate (watched elsewhere since): nothing is sent, the flag clears', async () => {
    const at = START - 60000;
    const h = await bootOffline({ index: [entry({ pos: 1234, posAt: at, sync: true })] });
    serverItem(h, 'm1', { LastPlayedDate: iso(at + 1), PlaybackPositionTicks: 5 * T });
    const posts = userDataPosts(h, 'm1');
    await h.off.syncPositions();
    expect(posts).toEqual([]);
    expect(h.entry('m1').sync).toBe(false);
  });

  it('keeps the server\'s Played; a copy watched to the end marks it played at 0', async () => {
    const h = await bootOffline({ index: [entry({ pos: 300, posAt: START - 10, sync: true }), entry({ id: 'm2', dir: 'u1.m2', pos: 0, played: true, posAt: START - 10, sync: true })] });
    serverItem(h, 'm1', { Played: true });
    serverItem(h, 'm2', { Played: false });
    const p1 = userDataPosts(h, 'm1');
    const p2 = userDataPosts(h, 'm2');
    await h.off.syncPositions();
    expect(p1[0].body).toMatchObject({ PlaybackPositionTicks: 300 * T, Played: true });
    expect(p2[0].body).toMatchObject({ PlaybackPositionTicks: 0, Played: true });
  });

  it("only the signed-in account's entries; entries without a pending sync are left alone", async () => {
    const h = await bootOffline({
      index: [entry({ user: 'u2', dir: 'u2.m1', sync: true, posAt: START - 5 }), entry({ id: 'm3', dir: 'u1.m3', sync: false })]
    });
    await h.off.syncPositions();
    expect(h.net.calls).toEqual([]);
    expect(h.off.OFF.list[0].sync).toBe(true);
  });

  it('signed out: nothing', async () => {
    const h = await bootOffline({ signedIn: false, storage: { 'reel.userId': 'u1', 'reel.server': 'http://jf.test' }, index: [entry({ sync: true, posAt: 5 })] });
    await h.off.syncPositions();
    expect(h.net.calls).toEqual([]);
  });

  it.each([
    ['404 on the item (gone from the server)', 'item', 404],
    ['400 on the UserData POST', 'post', 400],
    ['403 on the UserData POST', 'post', 403]
  ])('a 4xx drops that sync and goes on with the next: %s', async (_, where, code) => {
    const h = await bootOffline({ index: [entry({ sync: true, posAt: START - 5 }), entry({ id: 'm2', dir: 'u1.m2', sync: true, posAt: START - 5, pos: 77 })] });
    if (where === 'item') serverItem(h, 'm1', () => h.net.status(code));
    else {
      serverItem(h, 'm1', {});
      h.net.on('POST', (r) => r.path === '/UserItems/m1/UserData', h.net.status(code));
    }
    serverItem(h, 'm2', {});
    const p2 = userDataPosts(h, 'm2');
    await h.off.syncPositions();
    expect(h.entry('m1').sync).toBe(false);
    expect(h.index()[0].sync).toBe(false);
    expect(p2).toHaveLength(1);
    expect(h.entry('m2').sync).toBe(false);
  });

  it.each([
    ['a network error', (h) => h.net.networkError()],
    ['a 5xx', (h) => h.net.status(502)],
    ['a 401 (the token, not the item)', (h) => h.net.status(401)]
  ])('%s stops the run and keeps every pending sync for later', async (_, answer) => {
    const h = await bootOffline({ index: [entry({ sync: true, posAt: START - 5 }), entry({ id: 'm2', dir: 'u1.m2', sync: true, posAt: START - 5 })] });
    serverItem(h, 'm1', () => answer(h));
    const second = serverItem(h, 'm2', {});
    await h.off.syncPositions();
    expect(h.entry('m1').sync).toBe(true);
    expect(h.entry('m2').sync).toBe(true);
    expect(second).toEqual([]);
    // …and the next run (network back) sends both
    serverItem(h, 'm1', {});
    const p1 = userDataPosts(h, 'm1');
    const p2 = userDataPosts(h, 'm2');
    await h.off.syncPositions();
    expect([p1.length, p2.length]).toEqual([1, 1]);
  });

  it('a POST that fails with a network error keeps the sync pending', async () => {
    const h = await bootOffline({ index: [entry({ sync: true, posAt: START - 5 })] });
    serverItem(h, 'm1', {});
    h.net.on('POST', (r) => r.path === '/UserItems/m1/UserData', h.net.networkError());
    await h.off.syncPositions();
    expect(h.entry('m1').sync).toBe(true);
  });

  it('a checkpoint landing while the POST is out stays pending (it is newer than what was sent)', async () => {
    const h = await bootOffline({ index: [entry({ sync: true, posAt: START - 5000, pos: 100 })], stubFeeder: true });
    seedCopy(h);
    serverItem(h, 'm1', {});
    const opts = await startOffline(h);
    let release;
    const gate = new Promise((r) => (release = r));
    const posts = [];
    h.net.on('POST', (r) => r.path === '/UserItems/m1/UserData', async (req) => {
      posts.push(req);
      await gate;
      return null;
    });
    const run = h.off.syncPositions();
    await h.settle(3);
    expect(posts).toHaveLength(1);
    await h.clock.tick(1000);
    opts.checkpoint(500, 3000);   // the player pauses meanwhile
    release();
    await run;
    expect(posts[0].body.PlaybackPositionTicks).toBe(100 * T);
    expect(h.entry('m1')).toMatchObject({ pos: 500, sync: true });
    // the next run sends the newer spot
    const again = userDataPosts(h, 'm1');
    await h.off.syncPositions();
    expect(again[0].body.PlaybackPositionTicks).toBe(500 * T);
    expect(h.entry('m1').sync).toBe(false);
  });

  it('one run at a time', async () => {
    const h = await bootOffline({ index: [entry({ sync: true, posAt: START - 5 })] });
    let release;
    const gate = new Promise((r) => (release = r));
    const calls = serverItem(h, 'm1', async () => {
      await gate;
      return { Id: 'm1', UserData: {} };
    });
    userDataPosts(h, 'm1');
    const a = h.off.syncPositions();
    await h.settle(2);
    await h.off.syncPositions();
    release();
    await a;
    expect(calls).toHaveLength(1);
    // and the guard lifts afterwards
    h.entry('m1').sync = true;
    await h.off.syncPositions();
    expect(calls).toHaveLength(2);
  });
});

describe('the position of an offline copy: checkpoint / exit', () => {
  it('checkpoint (pause, backgrounding) records the spot at once and marks it for sync — no request', async () => {
    const h = await bootOffline({ index: [entry({ pos: 0 })], stubFeeder: true });
    seedCopy(h);
    serverItem(h, 'm1', {});
    const opts = await startOffline(h);
    const before = h.net.calls.length;
    await h.clock.tick(5000);
    opts.checkpoint(1234.9, 3000);
    expect(h.entry('m1')).toMatchObject({ pos: 1234, played: false, sync: true, posAt: h.clock.now() });
    expect(h.index()[0]).toMatchObject({ pos: 1234, sync: true, posAt: h.clock.now() });   // iOS may kill the app next
    expect(h.net.calls.length).toBe(before);   // nothing reports to Jellyfin while it plays
  });

  it('90 % in counts as watched: position 0, played', async () => {
    const h = await bootOffline({ index: [entry()], stubFeeder: true });
    seedCopy(h);
    serverItem(h, 'm1', {});
    const opts = await startOffline(h);
    opts.checkpoint(2699, 3000);
    expect(h.entry('m1')).toMatchObject({ pos: 2699, played: false });
    opts.checkpoint(2700, 3000);
    expect(h.entry('m1')).toMatchObject({ pos: 0, played: true });
    opts.checkpoint(50, 0);   // unknown duration: never "played"
    expect(h.entry('m1')).toMatchObject({ pos: 50, played: false });
  });

  it('a close before the first frame leaves the saved spot and a pending sync exactly as they were', async () => {
    const at = START - 3600e3;
    const h = await bootOffline({ index: [entry({ pos: 900, posAt: at, sync: true })], stubFeeder: true });
    seedCopy(h);
    serverItem(h, 'm1', {});
    const opts = await startOffline(h);
    expect(opts.start).toBe(900);
    const sent = h.net.calls.length;
    opts.exit(900, 3000, false);
    opts.exit(0, 3000, false);   // (restartPos() on a loading card can read the start, or 0)
    expect(h.entry('m1')).toMatchObject({ pos: 900, posAt: at, sync: true });
    expect(h.net.calls.length).toBe(sent);
  });

  it('a close after playback records the spot and syncs it right away', async () => {
    const h = await bootOffline({ index: [entry({ pos: 0 })], stubFeeder: true });
    seedCopy(h);
    serverItem(h, 'm1', {});
    const posts = userDataPosts(h, 'm1');
    const opts = await startOffline(h);
    await h.clock.tick(60000);
    opts.exit(1500, 3000, true);
    expect(h.entry('m1')).toMatchObject({ pos: 1500, sync: true });
    await h.settle(5);
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ PlaybackPositionTicks: 1500 * T, Played: false, LastPlayedDate: iso(h.clock.now()) });
    expect(h.entry('m1').sync).toBe(false);
  });

  it('a copy deleted while it played: exit records nothing and syncs nothing', async () => {
    const h = await bootOffline({ index: [entry(), entry({ id: 'm2', dir: 'u1.m2', sync: true, posAt: 5 })], stubFeeder: true });
    seedCopy(h);
    serverItem(h, 'm1', {});
    const opts = await startOffline(h);
    h.off.OFF.list = h.off.OFF.list.filter((e) => e.id !== 'm1');
    const sent = h.net.calls.length;
    opts.checkpoint(100, 3000);
    opts.exit(100, 3000, true);
    await h.settle(5);
    expect(h.net.calls.length).toBe(sent);
  });

  it('positions go to the account that started playback, even after a switch', async () => {
    const h = await bootOffline({ index: [entry(), entry({ user: 'u2', dir: 'u2.m1', pos: 7 })], stubFeeder: true });
    seedCopy(h);
    serverItem(h, 'm1', {});
    const opts = await startOffline(h);
    h.cfg.userId = 'u2';
    opts.checkpoint(600, 3000);
    expect(h.off.OFF.list.map((e) => [e.user, e.pos])).toEqual([['u1', 600], ['u2', 7]]);
  });
});

describe('playOffline()', () => {
  it('hands the player the cached copy: item, source with cached VTT, audio, the feeder over Cache Storage', async () => {
    const h = await bootOffline({ index: [entry({ pos: 600 })], stubFeeder: true });
    seedCopy(h, { art: ['art', 'poster'] });
    serverItem(h, 'm1', {});
    const opts = await startOffline(h);
    expect(opts.item).toMatchObject({ Id: 'm1', Name: 'Dune', Type: 'Movie' });
    expect(opts.item._art).toMatch(/^blob:/);
    expect(opts.start).toBe(600);
    expect(opts.audioIndex).toBe(1);
    // the German sub was never saved: it is left out; the English one carries its text
    const subs = opts.source.MediaStreams.filter((s) => s.Type === 'Subtitle');
    expect(subs.map((s) => s.Index)).toEqual([3]);
    expect(subs[0]._vtt).toContain('hello');
    expect(opts.source.MediaStreams.map((s) => s.Type)).toEqual(['Video', 'Audio', 'Subtitle']);
    // inside the tap: the empty <video> is load()ed so a later play() has sound
    expect(h.video.load).toHaveBeenCalledTimes(1);

    const jump = vi.fn();
    const onFail = vi.fn();
    const f = opts.open({ position: () => 0, jump, onFail });
    expect(f).toBe(h.feeders[0]);
    const o = h.feeders[0].opts;
    expect(o).toMatchObject({ jump, onFail, media: h.video, bitrate: 8000000, aheadS: 20 });
    expect(await o.prepare()).toEqual({ codecs: 'dvh1.08.06,ec-3', duration: 3000 });
    expect(await o.playlist()).toEqual({
      segs: [{ start: 0, end: 1000, name: 's0' }, { start: 1000, end: 2000, name: 's1' }, { start: 2000, end: 3000, name: 's2' }],
      complete: true
    });
    expect(new Uint8Array(await o.fetchInit())).toEqual(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(await o.fetchSeg({ name: 's2' }))).toEqual(new Uint8Array([9, 2]));
    await h.cs.cache(OFFLINE_CACHE).delete('/offline/u1.m1/s1');
    await expect(o.fetchSeg({ name: 's1' })).rejects.toThrow('part of this download is missing — delete it and download again');
    await h.cs.cache(OFFLINE_CACHE).delete('/offline/u1.m1/init');
    expect(await o.fetchInit()).toBe(null);
  });

  it('a copy made before the codec pick plays with the master CODECS; no Bitrate is 0', async () => {
    const man = manifest();
    delete man.play;
    man.source.Bitrate = 0;
    const h = await bootOffline({ index: [entry()], stubFeeder: true });
    seedCopy(h, { man });
    serverItem(h, 'm1', {});
    const opts = await startOffline(h);
    opts.open({ position: () => 0, jump() {}, onFail() {} });
    expect((await h.feeders[0].opts.prepare()).codecs).toBe('hvc1.2.4.L150.B0,ec-3');
    expect(h.feeders[0].opts.bitrate).toBe(0);
  });

  it.each([
    [30, 0, 'the first 30 s: from the start'],
    [31, 31, 'past 30 s: resumed'],
    [2939, 2939, 'more than a minute before the end: resumed'],
    [2940, 0, 'the last minute: from the start']
  ])('start position %i → %i (%s)', async (pos, start) => {
    const h = await bootOffline({ index: [entry({ pos })], stubFeeder: true });
    seedCopy(h);
    serverItem(h, 'm1', {});
    expect((await startOffline(h)).start).toBe(start);
  });

  it('a manifest without a duration resumes anywhere past 30 s', async () => {
    const h = await bootOffline({ index: [entry({ pos: 99999 })], stubFeeder: true });
    seedCopy(h, { man: manifest({ duration: 0 }) });
    serverItem(h, 'm1', {});
    expect((await startOffline(h)).start).toBe(99999);
  });

  it('online: a newer position from the server (watched on the TV) wins over the copy\'s', async () => {
    const at = START - 3600e3;
    const h = await bootOffline({ index: [entry({ pos: 100, posAt: at })], stubFeeder: true });
    seedCopy(h);
    const calls = serverItem(h, 'm1', { LastPlayedDate: iso(at + 1000), PlaybackPositionTicks: 1800.7 * T });
    const opts = await startOffline(h);
    expect(calls[0].url).toBe('http://jf.test/Items/m1?userId=u1');
    expect(opts.start).toBe(1800);
    expect(h.entry('m1')).toMatchObject({ pos: 1800, posAt: at + 1000 });
  });

  it('…but not over a position watched offline that has not been synced yet', async () => {
    const at = START - 3600e3;
    const h = await bootOffline({ index: [entry({ pos: 100, posAt: at, sync: true })], stubFeeder: true });
    seedCopy(h);
    serverItem(h, 'm1', { LastPlayedDate: iso(at + 1000), PlaybackPositionTicks: 1800 * T });
    expect((await startOffline(h)).start).toBe(100);
  });

  it('an older server position does not override the copy\'s', async () => {
    const at = START - 3600e3;
    const h = await bootOffline({ index: [entry({ pos: 100, posAt: at })], stubFeeder: true });
    seedCopy(h);
    serverItem(h, 'm1', { LastPlayedDate: iso(at - 1000), PlaybackPositionTicks: 1800 * T });
    expect((await startOffline(h)).start).toBe(100);
  });

  it('offline, or the server failing: plays from the copy without waiting on it', async () => {
    const h = await bootOffline({ index: [entry({ pos: 100 })], stubFeeder: true });
    seedCopy(h);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect((await startOffline(h)).start).toBe(100);
    expect(h.net.calls).toEqual([]);

    const h2 = await bootOffline({ index: [entry({ pos: 100 })], stubFeeder: true });
    seedCopy(h2);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    serverItem(h2, 'm1', () => h2.net.status(500));
    expect((await startOffline(h2)).start).toBe(100);
  });

  it('a slow server is given 2.5 s, then the copy plays', async () => {
    const h = await bootOffline({ index: [entry({ pos: 100 })], stubFeeder: true });
    seedCopy(h);
    serverItem(h, 'm1', () => h.net.hang());
    const p = h.off.playOffline('m1');
    await h.clock.tick(2499);
    expect(h.player.playFeedStream).not.toHaveBeenCalled();
    await h.clock.tick(1);
    await p;
    expect(h.player.playFeedStream).toHaveBeenCalledTimes(1);
  });

  it('nothing for a copy that is not done, an unknown id, or while the player is up', async () => {
    const h = await bootOffline({ index: [entry({ state: 'downloading' }), entry({ id: 'm2', dir: 'u1.m2' })], stubFeeder: true });
    await h.off.playOffline('m1');
    await h.off.playOffline('nope');
    h.S.screen = 'player';
    await h.off.playOffline('m2');
    expect(h.player.playFeedStream).not.toHaveBeenCalled();
    expect(h.net.calls).toEqual([]);
  });

  it('a damaged copy (no manifest) says so', async () => {
    const h = await bootOffline({ index: [entry()], stubFeeder: true });
    serverItem(h, 'm1', {});
    await h.off.playOffline('m1');
    expect(h.toast.toastState.msg).toBe('This download is damaged — delete it and download again');
    expect(h.player.playFeedStream).not.toHaveBeenCalled();
  });

  it.each([
    ['the user navigated away (epoch)', (h) => h.S.epoch++],
    ['the player opened meanwhile', (h) => (h.S.screen = 'player')],
    ['the copy was deleted meanwhile', (h) => (h.off.OFF.list = [])]
  ])('gives up when %s during the awaits, and frees the artwork URL', async (_, change) => {
    const h = await bootOffline({ index: [entry()], stubFeeder: true });
    seedCopy(h, { art: ['art'] });
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    // the change lands right after the artwork's object URL was made (the last await)
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      change(h);
      return 'blob:http://phone.test/art-1';
    });
    serverItem(h, 'm1', {});
    await h.off.playOffline('m1');
    expect(h.player.playFeedStream).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith('blob:http://phone.test/art-1');
  });

  it('the artwork URL is freed 5 s after the player closes', async () => {
    const h = await bootOffline({ index: [entry()], stubFeeder: true });
    seedCopy(h, { art: ['still'] });
    serverItem(h, 'm1', {});
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const opts = await startOffline(h);
    opts.exit(0, 3000, false);
    await h.clock.tick(4999);
    expect(revoke).not.toHaveBeenCalled();
    await h.clock.tick(1);
    expect(revoke).toHaveBeenCalledWith(opts.item._art);
  });

  it('remembered subtitles apply when the copy has them', async () => {
    const h = await bootOffline({
      index: [entry({ id: 'e1', dir: 'u1.e1', type: 'Episode' })],
      storage: { 'reel.trackPrefs.u1': { ser1: { s: { lang: langKey('eng'), forced: false, sdh: false, burn: false }, t: 1 } } },
      stubFeeder: true
    });
    const man = manifest({ item: { Id: 'e1', Name: 'Pilot', Type: 'Episode', SeriesId: 'ser1', RunTimeTicks: 3000 * T, Genres: [], Overview: '' } });
    seedCopy(h, { dir: 'u1.e1', man });
    serverItem(h, 'e1', {});
    const opts = await startOffline(h, 'e1');
    expect(opts.subIndex).toBe(3);
  });

  it('a remembered subtitle the copy did not save (not a text track then) is not asked for: -1', async () => {
    const h = await bootOffline({
      index: [entry({ id: 'e1', dir: 'u1.e1', type: 'Episode' })],
      storage: { 'reel.trackPrefs.u1': { ser1: { s: { lang: langKey('ger'), forced: false, sdh: false, burn: false }, t: 1 } } },
      stubFeeder: true
    });
    const man = manifest({ item: { Id: 'e1', Name: 'Pilot', Type: 'Episode', SeriesId: 'ser1', RunTimeTicks: 3000 * T, Genres: [], Overview: '' } });
    seedCopy(h, { dir: 'u1.e1', man });   // sub4 (German) is in the manifest but not in the cache
    serverItem(h, 'e1', {});
    const opts = await startOffline(h, 'e1');
    expect(opts.subIndex).toBe(-1);
  });

  it('no remembered or default subtitle: -1', async () => {
    const h = await bootOffline({ index: [entry()], stubFeeder: true });
    seedCopy(h);
    serverItem(h, 'm1', {});
    expect((await startOffline(h)).subIndex).toBe(-1);
  });
});
