/* player.svelte.js — the start path's edges (lane r3-tv-unit, mutation-backed:
 * Stryker on player.svelte.js 1–460): the DirectPlay URL, playEpisode()'s
 * genre loan and guards, and how a start that fails before any video exists is
 * reported (failStart).
 *
 * CLAUDE.md, "Video playback — the no-transcode contract": "playback uses a
 * `static=true` `/Videos/{id}/stream.{container}` URL". tracks.js: "Episodes
 * usually have no genres of their own; playEpisode() lends them the series'"
 * (so an anime episode still picks its Japanese track). "Every await can land
 * on a different screen … a start captures S.epoch and gives up if it changed
 * (play(), playEpisode(), …)". A start that fails "from a detail page is a
 * toast (nothing is on screen to put a card in); inside the player — a Retry, a
 * burn-in restart, an Up Next roll — it is the error card". */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import { startPlayer, warmPlayer } from '../helpers/player.js';
import { movie, episode, source, video, audio, tracks, playbackInfo } from '../helpers/media.js';
import { freshImport } from '../helpers/modules.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TICKS = 10000000;
const toastOf = async () => (await import(path.resolve(ROOT, 'src/lib/toast.svelte.js'))).toastState;

describe('the DirectPlay URL', () => {
  beforeAll(warmPlayer, 120000);

  // the phone DirectPlays only a progressive MP4 (startPlayer serves everything else as the HLS remux)
  const container = __PHONE__ ? 'mp4' : 'mkv';

  it('static=true /Videos/{id}/stream.{container} with the source, the token, the session and the device', async () => {
    const src = source([video(), audio()], { Container: container });
    const h = await startPlayer({ item: movie({ MediaSources: [src] }) });
    expect(h.video.src).toBe(
      'http://jf.test/Videos/' + h.id + '/stream.' + container +
        '?static=true&mediaSourceId=' + src.Id + '&api_key=tok-u1&PlaySessionId=ps-1&deviceId=dev-test'
    );
    expect(h.P.playMethod).toBe('DirectPlay');
  });

  it(__PHONE__ ? 'phone: a source without a container is not DirectPlayed' : 'a source without a container is served as .mkv', async () => {
    const src = source([video(), audio()], { Container: undefined });
    const h = await startPlayer({ item: movie({ MediaSources: [src] }) });
    if (__PHONE__) expect(h.video.src).toMatch(/\/main\.m3u8\?/);
    else expect(h.video.src).toMatch(new RegExp('/Videos/' + h.id + '/stream\\.mkv\\?static=true&'));
  });

  it('the id in the URL is the item asked for, also when the detail item carries another id', async () => {
    const h = await startPlayer();
    h.P.detailItem = { Id: 'detail-page', Name: 'x' };
    h.net.on('POST', '/Items/other/PlaybackInfo', playbackInfo(h.source, { PlaySessionId: 'ps-9' }));
    h.net.on('GET', (r) => r.path === '/Items' && new URLSearchParams(r.query).get('Ids') === 'other', { Items: [{ Id: 'other' }] });
    h.net.on('GET', '/MediaSegments/other', { Items: [] });
    h.player.play('other', 0);
    await h.settle();
    expect(h.P.item.Id).toBe('other');
    expect(h.P.sessionId).toBe('ps-9');
    if (!__PHONE__) expect(h.video.src).toContain('/Videos/other/stream.mkv?static=true&mediaSourceId=' + h.source.Id + '&api_key=tok-u1&PlaySessionId=ps-9&');
  });
});

describe('playEpisode', () => {
  beforeAll(warmPlayer, 120000);

  /* 0 video · 1 Japanese AAC (the container default, as the NAS marks anime) · 2 English E-AC3 */
  const dual = () => source([video(), audio({ Codec: 'aac', Language: 'jpn', IsDefault: true }), audio({ Codec: 'eac3', Language: 'eng' })]);

  async function setup({ ep, ctx, routes } = {}) {
    const h = await startPlayer();
    const e = ep || episode({ SeriesId: 'show-1', MediaSources: [dual()] });
    h.net.on('GET', '/Items/' + e.Id, () => ({ ...e }));
    h.net.on('POST', '/Items/' + e.Id + '/PlaybackInfo', playbackInfo(e.MediaSources[0], { PlaySessionId: 'ps-ep' }));
    h.net.on('GET', (r) => r.path === '/Items' && new URLSearchParams(r.query).get('Ids') === e.Id, { Items: [{ Id: e.Id }] });
    h.net.on('GET', '/MediaSegments/' + e.Id, { Items: [] });
    h.net.on('GET', '/Items/show-1', { Id: 'show-1', Type: 'Series', ProviderIds: {} });
    h.net.on('GET', '/Shows/show-1/Episodes', { Items: [e] });
    if (routes) routes(h.net, e);
    if (ctx !== undefined) h.P.detailItem = ctx;
    return { h, e };
  }
  const infos = (h, e) => h.net.callsTo('/Items/' + e.Id + '/PlaybackInfo', 'POST');

  it("borrows the series' genres when the detail item is the series: an anime episode starts in Japanese", async () => {
    const { h, e } = await setup({ ctx: { Id: 'show-1', Type: 'Series', Genres: ['Anime'] } });
    expect(await h.player.playEpisode(e.Id)).toBe(true);
    await h.settle();
    expect(h.P.detailItem.Id).toBe(e.Id);
    expect(h.P.detailItem.Genres).toEqual(['Anime']);
    expect(h.P.audioIndex).toBe(1);
    expect(infos(h, e)).toHaveLength(1);
  });

  it('borrows them from the previous episode of the same series too', async () => {
    const { h, e } = await setup({ ctx: { Id: 'ep-0', Type: 'Episode', SeriesId: 'show-1', Genres: ['Animation'] } });
    await h.player.playEpisode(e.Id);
    await h.settle();
    expect(h.P.detailItem.Genres).toEqual(['Animation']);
    expect(h.P.audioIndex).toBe(1);
  });

  it("an unrelated detail item lends nothing: English (the Settings language)", async () => {
    const { h, e } = await setup({ ctx: { Id: 'other-show', Type: 'Series', SeriesId: 'x', Genres: ['Anime'] } });
    await h.player.playEpisode(e.Id);
    await h.settle();
    expect(h.P.detailItem.Genres).toBeUndefined();
    expect(h.P.audioIndex).toBe(2);
  });

  it('an episode with genres of its own keeps them', async () => {
    const ep = episode({ SeriesId: 'show-1', Genres: ['Drama'], MediaSources: [dual()] });
    const { h, e } = await setup({ ep, ctx: { Id: 'show-1', Type: 'Series', Genres: ['Anime'] } });
    await h.player.playEpisode(e.Id);
    await h.settle();
    expect(h.P.detailItem.Genres).toEqual(['Drama']);
    expect(h.P.audioIndex).toBe(2);
  });

  it('no detail item at all: nothing to borrow, still plays', async () => {
    const { h, e } = await setup({ ctx: null });
    expect(await h.player.playEpisode(e.Id)).toBe(true);
    await h.settle();
    expect(h.P.audioIndex).toBe(2);
  });

  it.each([
    [0, 0],
    [30, 0],
    [30.5, 30],
    [612.9, 612]
  ])('a saved position of %s s starts at %s', async (pos, start) => {
    const ep = episode({ SeriesId: 'show-1', MediaSources: [dual()], UserData: { PlaybackPositionTicks: Math.round(pos * TICKS) } });
    const { h, e } = await setup({ ep });
    await h.player.playEpisode(e.Id);
    await h.settle();
    expect(infos(h, e)[0].body.StartTimeTicks).toBe(start * TICKS);
  });

  it('an episode without UserData starts at 0', async () => {
    const ep = episode({ SeriesId: 'show-1', MediaSources: [dual()] });
    delete ep.UserData;
    const { h, e } = await setup({ ep });
    await h.player.playEpisode(e.Id);
    await h.settle();
    expect(infos(h, e)[0].body.StartTimeTicks).toBe(0);
  });

  it('wanted() turning false while the item loads drops the start (false)', async () => {
    const { h, e } = await setup();
    let want = true;
    const p = h.player.playEpisode(e.Id, () => want);
    want = false;
    expect(await p).toBe(false);
    await h.settle();
    expect(infos(h, e)).toHaveLength(0);
  });

  it('a page change (S.epoch) while the item loads drops the start (false)', async () => {
    const { h, e } = await setup();
    const p = h.player.playEpisode(e.Id);
    h.S.epoch++;
    expect(await p).toBe(false);
    await h.settle();
    expect(infos(h, e)).toHaveLength(0);
  });

  it('an item that does not load toasts the reason and resolves false', async () => {
    const { h, e } = await setup({ routes: (net, ep) => net.on('GET', '/Items/' + ep.Id, net.status(404, { message: 'nope' })) });
    expect(await h.player.playEpisode(e.Id)).toBe(false);
    const t = await toastOf();
    expect(t.msg).toMatch(/^Couldn’t start this episode: /);
    expect(t.msg.length).toBeGreaterThan('Couldn’t start this episode: '.length);
    expect(infos(h, e)).toHaveLength(0);
  });
});

describe('a start that fails before any video exists (failStart)', () => {
  beforeAll(warmPlayer, 120000);

  it('PlaybackInfo with no source, from a detail page: a toast with the device wording, no card', async () => {
    const h = await startPlayer({ reach: 'request', routes: (net, { id }) => net.on('POST', '/Items/' + id + '/PlaybackInfo', { MediaSources: [], PlaySessionId: 'x' }) });
    await h.settle();
    const t = await toastOf();
    expect(t.msg).toBe(
      'No playable source: ' +
        (__PHONE__ ? 'Jellyfin offered no stream this iPhone can play for this title.' : 'Jellyfin found no file this TV can play for this title.')
    );
    expect(h.P.error).toBe(null);
    expect(h.S.screen).toBe('detail');
    expect(h.video.src).toBe('');
  });

  it('PlaybackInfo without a MediaSources field at all is the same', async () => {
    const h = await startPlayer({ reach: 'request', routes: (net, { id }) => net.on('POST', '/Items/' + id + '/PlaybackInfo', { PlaySessionId: 'x' }) });
    await h.settle();
    expect((await toastOf()).msg).toMatch(/^No playable source: /);
    expect(h.video.src).toBe('');
  });

  it('an unreachable server from a detail page: "Couldn’t start playback: <reason>"', async () => {
    const h = await startPlayer({ reach: 'request', routes: (net, { id }) => net.on('POST', '/Items/' + id + '/PlaybackInfo', net.networkError('Failed to fetch')) });
    await h.settle();
    const t = await toastOf();
    expect(t.msg).toMatch(/^Couldn’t start playback: ./);
    expect(h.P.error).toBe(null);
  });

  it('inside the player (a Retry) the same failure is the error card at the last good position', async () => {
    let fail = false;
    const h = await startPlayer({
      routes: (net, { id, item }) => net.on('POST', '/Items/' + id + '/PlaybackInfo', () => (fail ? { MediaSources: [], PlaySessionId: 'x' } : playbackInfo(item.MediaSources[0], { PlaySessionId: 'ps-1' })))
    });
    h.video.setTime(500);
    h.video.emit('timeupdate');
    h.video.fail(2, '');
    fail = true;
    h.player.retryPlayback();
    await h.settle();
    expect(h.P.error).toMatchObject({ title: 'No playable source' });
    expect(h.P.error.detail).toMatch(/can play for this title\.$/);
    h.net.on('POST', '/Items/' + h.id + '/PlaybackInfo', playbackInfo(h.source, { PlaySessionId: 'ps-2' }));
    h.player.retryPlayback();
    expect(h.P.loadingFrom).toBe(500);
  });

  it('inside the player an unreachable server is the card "Couldn’t start playback" with errText(e) as the reason', async () => {
    const h = await startPlayer();
    h.net.on('POST', '/Items/' + h.id + '/PlaybackInfo', h.net.networkError('Failed to fetch'));
    h.player.restartPlayback(42);
    await h.settle();
    expect(h.P.error).toMatchObject({ title: 'Couldn’t start playback' });
    expect(h.P.error.detail).toMatch(/^Can’t reach the server at \S+$/);
  });

  it('R3-TU-1: an HTTP 500 is the server’s problem, not "couldn’t reach" — and never the request path', async () => {
    const h = await startPlayer({ reach: 'request', routes: (net, { id }) => net.on('POST', '/Items/' + id + '/PlaybackInfo', net.status(500)) });
    await h.settle();
    const msg = (await toastOf()).msg;
    expect(msg).toBe('Couldn’t start playback: The server had a problem (HTTP 500)');
    const p = await startPlayer();
    p.net.on('POST', '/Items/' + p.id + '/PlaybackInfo', p.net.status(500));
    p.player.restartPlayback(42);
    await p.settle();
    expect(p.P.error).toMatchObject({ title: 'Couldn’t start playback', detail: 'The server had a problem (HTTP 500)' });
  });

  it('a failure that lands after the player was closed raises nothing', async () => {
    let answer;
    const h = await startPlayer({ reach: 'request', routes: (net, { id }) => net.on('POST', '/Items/' + id + '/PlaybackInfo', () => new Promise((_, rej) => (answer = rej))) });
    await h.settle();
    h.player.exitPlayer();
    const before = (await toastOf()).msg;
    answer(new TypeError('Failed to fetch'));
    await h.settle();
    expect((await toastOf()).msg).toBe(before);
    expect(h.P.error).toBe(null);
  });
});

describe('playItem / playPendingStream seed the slice', () => {
  beforeAll(warmPlayer, 120000);

  it('playItem resets the subtitle offset and clears a pending flag left by a pending stream', async () => {
    const h = await startPlayer();
    h.player.exitPlayer();
    h.P.subOffset = 2.5;
    h.P.pending = true;
    h.player.playItem(h.item);
    await h.settle();
    expect(h.P.subOffset).toBe(0);
    expect(h.P.pending).toBe(false);
    expect(h.net.callsTo('/Items/' + h.id + '/PlaybackInfo', 'POST').at(-1).body.StartTimeTicks).toBe(0);
  });

  it('a pending stream: DirectPlay, the default audio of the probe, subs off, no session, no item id', async () => {
    const h = await startPlayer({ reach: 'src' });
    const src = source([video(), audio({ Codec: 'ac3', Language: 'eng' }), audio({ Codec: 'eac3', Language: 'eng' })]);
    h.P.subIndex = 3;
    h.P.subOffset = 1;
    h.P.sessionId = 'old';
    h.player.playPendingStream({ url: 'http://ml.test/api/downloads/abc/stream', item: { Name: 'Film', Type: 'Movie' }, source: src, downloadId: 'abc' });
    expect(h.P).toMatchObject({ pending: true, downloadId: 'abc', sessionId: '', subIndex: -1, subOffset: 0, playMethod: 'DirectPlay', audioIndex: 2 });
    expect(h.P.item).toEqual({ Id: null, Name: 'Film' });
    expect(h.P.detailItem).toEqual({ Name: 'Film', Type: 'Movie' });
    expect(h.video.src).toBe('http://ml.test/api/downloads/abc/stream');
    expect(h.P.loadingFrom).toBe(0);
  });
});

describe('the player slice before anything plays', () => {
  it('starts idle: no item, nothing loading, DirectPlay, no tracks, paused, empty lists', async () => {
    const { player } = await freshImport({ modules: { player: 'src/lib/player.svelte.js' } });
    const want = {
      item: null, source: null, pending: false, trailer: false, sessionId: '', audioIndex: -1, subIndex: -1,
      playMethod: 'DirectPlay', detailItem: null, series: null, seasons: null, panel: null, osdShown: false,
      spinner: false, paused: true, pos: 0, dur: 0, skips: [], skipped: null, credits: null, next: null,
      upNextOff: false, trick: null, scrub: null, picSvc: null, pictureModes: [], pictureMode: null, picErr: false,
      picLoading: false, picPending: null, subOffset: 0, loading: false, loadingItem: null, loadingFrom: 0,
      downloadId: null, error: null, slowNet: null, link: null, chapters: []
    };
    expect({ ...player.P }).toEqual(__PHONE__ ? { ...want, quality: null } : want);
  }, 120000);
});

describe('the PGS canvas', () => {
  beforeAll(warmPlayer, 120000);

  it('setPgsCanvas sizes it to the window; sizePgs follows a resize; no canvas, no throw', async () => {
    const { player } = await freshImport({ modules: { player: 'src/lib/player.svelte.js' } });
    expect(() => player.sizePgs()).not.toThrow();
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    player.setPgsCanvas(c);
    expect([c.width, c.height]).toEqual([window.innerWidth, window.innerHeight]);
    const w = window.innerWidth;
    const h = window.innerHeight;
    try {
      window.innerWidth = 777;
      window.innerHeight = 333;
      player.sizePgs();
      expect([c.width, c.height]).toEqual([777, 333]);
    } finally {
      window.innerWidth = w;
      window.innerHeight = h;
    }
  }, 120000);
});

describe('play(): what the PlaybackInfo answer is applied to', () => {
  beforeAll(warmPlayer, 120000);

  it('a start with no detail item plays a bare { Id } item', async () => {
    const h = await startPlayer();
    h.player.exitPlayer();
    h.P.detailItem = null;
    h.player.play(h.id, 0);
    await h.settle();
    expect(h.P.error).toBe(null);
    expect(h.P.item).toEqual({ Id: h.id });
    expect(h.S.screen).toBe('player');
  });

  it('no audio chosen yet (-1): the default track of the answered source; a chosen one is kept', async () => {
    const item = movie({ MediaSources: [source([video(), audio({ Codec: 'ac3', Language: 'eng' }), audio({ Codec: 'eac3', Language: 'eng' })])] });
    const h = await startPlayer({ item });
    expect(h.P.audioIndex).toBe(2);
    h.player.exitPlayer();
    h.P.audioIndex = -1;
    h.player.play(h.id, 0);
    await h.settle();
    expect(h.P.audioIndex).toBe(2);
    h.player.exitPlayer();
    h.P.audioIndex = 1;
    h.player.play(h.id, 0);
    await h.settle();
    expect(h.P.audioIndex).toBe(1);
  });

  it(__PHONE__ ? 'phone: an MKV is the HLS remux, DirectStream — no burn-in toast' : 'TV: an MKV is DirectPlay', async () => {
    const h = await startPlayer();
    expect(h.P.playMethod).toBe(__PHONE__ ? 'DirectStream' : 'DirectPlay');
    expect((await toastOf()).msg).toBe('');
  });

  it('a burn-in start of a file without audio sends no audio index', async () => {
    const item = movie({ MediaSources: [source([video(), tracks.vobsub()])] });
    const h = await startPlayer({ item });
    h.player.exitPlayer();
    Object.assign(h.P, { source: item.MediaSources[0], subIndex: 1, audioIndex: -1 });
    h.net.on('POST', '/Items/' + h.id + '/PlaybackInfo', () => new Promise(() => {}));
    h.player.play(h.id, 0);
    await h.settle();
    const req = h.net.callsTo('/Items/' + h.id + '/PlaybackInfo', 'POST').at(-1);
    expect(req.body.SubtitleStreamIndex).toBe(1);
    expect(req.body.MediaSourceId).toBe(item.MediaSources[0].Id);
    expect('AudioStreamIndex' in req.body).toBe(false);
  });

  it('two restarts in a row: the first answer, arriving last, is dropped (playGen)', async () => {
    const answers = [];
    const h = await startPlayer();
    h.net.on('POST', '/Items/' + h.id + '/PlaybackInfo', () => new Promise((res) => answers.push(res)));
    const src = h.source;
    h.player.restartPlayback(100);
    h.player.restartPlayback(200);
    await h.settle();
    expect(answers).toHaveLength(2);
    answers[1](playbackInfo(src, { PlaySessionId: 'ps-B' }));
    await h.settle();
    answers[0](playbackInfo(src, { PlaySessionId: 'ps-A' }));
    await h.settle();
    expect(h.P.sessionId).toBe('ps-B');
    expect(h.P.loadingFrom).toBe(200);
  });

  it('an error before any timeupdate: Retry resumes at the position the start asked for', async () => {
    const h = await startPlayer({ resumeSec: 754 });
    h.video.fail(2, '');
    h.player.retryPlayback();
    expect(h.P.loadingFrom).toBe(754);
  });

  it(__PHONE__ ? 'phone: a restart inside the player does not load() the element before PlaybackInfo' : 'TV: a restart never load()s before the src is set', async () => {
    const h = await startPlayer();
    const before = h.video.calls.length;
    h.net.on('POST', '/Items/' + h.id + '/PlaybackInfo', () => new Promise(() => {}));
    h.player.restartPlayback(10);
    await h.settle();
    expect(h.video.calls.slice(before)).toEqual([]);
  });
});

describe('homeReturn across a restart', () => {
  beforeAll(warmPlayer, 120000);

  it('a Continue Watching start keeps its tile through a Retry: Back lands on that tile', async () => {
    const h = await startPlayer({ screen: 'home', base: 'home', reach: 'request' });
    h.release();
    await h.settle();
    h.player.exitPlayer();
    h.nav.takeHomeFocus();
    h.player.playFromHome({ ...h.item, UserData: { PlaybackPositionTicks: 0 } }, 'tile-cw-3');
    await h.settle();
    h.video.fail(2, '');
    h.player.retryPlayback();
    await h.settle();
    h.player.exitPlayer();
    expect(h.S.screen).toBe('home');
    expect(h.nav.takeHomeFocus()).toBe(__PHONE__ ? null : 'tile-cw-3');
  });
});

describe('Play, then Trailer before the PlaybackInfo answered', () => {
  beforeAll(warmPlayer, 120000);
  const TRAILERSTREAM = path.resolve(ROOT, 'src/lib/trailerstream.js');
  afterEach(() => vi.doUnmock(TRAILERSTREAM));

  it('the first Play’s late answer is dropped once the trailer closed and Play was pressed again', async () => {
    vi.doMock(TRAILERSTREAM, () => ({ createTrailerSource: () => ({ url: 'blob:trailer', managed: false, stop: () => {} }) }));
    const answers = [];
    const h = await startPlayer({ reach: 'request', routes: (net, { id }) => net.on('POST', '/Items/' + id + '/PlaybackInfo', () => new Promise((res) => answers.push(res))) });
    await h.settle();
    h.player.playTrailerStream({ id: 'yt12345678x', title: 'T' });
    h.player.exitPlayer();   // the trailer closes: back on the same page, no remount
    expect(h.S.screen).not.toBe('player');
    h.player.playItem(h.item, 0);   // Play again
    await h.settle();
    expect(answers).toHaveLength(2);
    answers[0](playbackInfo(h.source, { PlaySessionId: 'ps-old' }));
    await h.settle();
    expect(h.P.sessionId).not.toBe('ps-old');
    expect(h.video.calls.filter((c) => c[0] === 'src' && !c[1].startsWith('blob:'))).toEqual([]);
    answers[1](playbackInfo(h.source, { PlaySessionId: 'ps-new' }));
    await h.settle();
    expect(h.P.sessionId).toBe('ps-new');
  });
});

describe('the PlaybackInfo answer, read strictly', () => {
  beforeAll(warmPlayer, 120000);

  it('an answer without a PlaySessionId: the session is empty and the URL carries none', async () => {
    const src = source([video(), audio()], { Container: __PHONE__ ? 'mp4' : 'mkv' });
    const h = await startPlayer({ item: movie({ MediaSources: [src] }), info: { MediaSources: [src] } });
    expect(h.P.sessionId).toBe('');
    expect(h.video.src).not.toMatch(/PlaySessionId/);
    expect(h.video.src).toMatch(/[?&]static=true&/);
  });

  it('a source that also carries a TranscodingUrl is still DirectPlayed when nothing needs burning in (no-transcode contract)', async () => {
    const src = source([video(), audio()], { Container: __PHONE__ ? 'mp4' : 'mkv' });
    const served = { ...src, TranscodingUrl: '/videos/x/master.m3u8?MediaSourceId=' + src.Id + '&VideoCodec=h264' };
    const h = await startPlayer({ item: movie({ MediaSources: [src] }), info: playbackInfo(served, { PlaySessionId: 'ps-1' }) });
    expect(h.P.playMethod).toBe('DirectPlay');
    expect(h.video.src).toContain('/stream.' + (__PHONE__ ? 'mp4' : 'mkv') + '?static=true&');
    expect((await toastOf()).msg).toBe('');
  });

  it(__PHONE__ ? 'phone: the slice carries the quality of the stream' : 'TV: the slice never grows a quality field', async () => {
    const h = await startPlayer();
    expect('quality' in h.P).toBe(__PHONE__);
  });

  it('a pending stream switches the element to its default audio track once the metadata is in', async () => {
    const h = await startPlayer({ reach: 'src' });
    const src = source([video(), audio({ Codec: 'ac3', Language: 'eng' }), audio({ Codec: 'eac3', Language: 'eng' })]);
    h.player.playPendingStream({ url: 'http://ml.test/api/downloads/abc/stream', item: { Name: 'F' }, source: src });
    h.video.setAudioTracks(2);
    h.video.setDuration(3600);
    h.video.emit('loadedmetadata');
    expect([...h.video.audioTracks].map((t) => t.enabled)).toEqual([false, true]);
  });
});

describe('a failed start that is no longer wanted stays quiet', () => {
  beforeAll(warmPlayer, 120000);

  it('the first of two restarts failing late raises no card (the second one owns the player)', async () => {
    const h = await startPlayer();
    const answers = [];
    h.net.on('POST', '/Items/' + h.id + '/PlaybackInfo', () => new Promise((res, rej) => answers.push({ res, rej })));
    h.player.restartPlayback(100);
    h.player.restartPlayback(200);
    await h.settle();
    answers[0].rej(new TypeError('Failed to fetch'));
    await h.settle();
    expect(h.P.error).toBe(null);
    answers[1].res(playbackInfo(h.source, { PlaySessionId: 'ps-2' }));
    await h.settle();
    expect(h.P.sessionId).toBe('ps-2');
  });

  it('a start from a page the user already left fails silently (no toast on the next page)', async () => {
    let fail;
    const h = await startPlayer({ reach: 'request', routes: (net, { id }) => net.on('POST', '/Items/' + id + '/PlaybackInfo', () => new Promise((_, rej) => (fail = rej))) });
    await h.settle();
    const before = (await toastOf()).msg;
    h.nav.openItem('elsewhere', 'Movie');
    fail(new TypeError('Failed to fetch'));
    await h.settle();
    expect((await toastOf()).msg).toBe(before);
  });

  /* R3-TU-1 (fixed): the toast/card detail was api()'s raw e.message
   * ("network error: /Items/…/PlaybackInfo"); CLAUDE.md says failures are shown via
   * errText(e) — api()'s userMessage, "Can’t reach the server at <server>". */
  it('R3-TU-1: an unreachable server: the toast shows errText(e), not the request path', async () => {
    const h = await startPlayer({ reach: 'request', routes: (net, { id }) => net.on('POST', '/Items/' + id + '/PlaybackInfo', net.networkError('Failed to fetch')) });
    await h.settle();
    const msg = (await toastOf()).msg;
    expect(msg).toMatch(/: Can’t reach the server at \S+$/);
    expect(msg).not.toContain('/PlaybackInfo');
  });
});
