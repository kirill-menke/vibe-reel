/* player.svelte.js in the desktop web build (`__PHONE__ && __WEB__`).
 *
 * The web build asks Jellyfin for what the phone gets — DirectPlay of a
 * progressive MP4, else the HLS fMP4 remux — but no browser is handed the
 * playlist: play() opens a jfhls.js feed on main.m3u8 and gives <video> its
 * blob URL. Everything else is an ordinary Jellyfin playback (reports, markers,
 * trickplay, Up Next): P.pending stays false. One feed at a time: a restart
 * (audio switch, Retry, next episode) opens a new one and stops the old, exit
 * stops the last, and so does any other kind of start. A multi-audio file
 * direct-plays only for its default track (desktop browsers have no
 * audioTracks): any other pick asks with EnableDirectPlay false, and an audio
 * switch on a direct play restarts through the remux. Error wording names
 * the browser / this computer. jfhls.js itself is test/web/jfhls.test.js;
 * here it is a stub that records what the player hands it. */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { startPlayer, warmPlayer } from '../helpers/player.js';
import { movie, episode, source, video as vstream, audio, sub, playbackInfo } from '../helpers/media.js';

const H = vi.hoisted(() => {
  const H = { feeds: [], loaded: false };
  H.stub = () => ({
    createJfFeed: (opts) => {
      const f = { url: 'blob:jf-' + (H.feeds.length + 1), managed: false, stop: vi.fn(), opts };
      H.feeds.push(f);
      return f;
    }
  });
  return H;
});
vi.mock('../../src/lib/jfhls.js', () => H.stub());

const ROOT = path.resolve(import.meta.dirname, '../..');
const TICKS = 10000000;

beforeEach(() => {
  H.feeds = [];
  H.loaded = false;
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
});

/* startPlayer() up to 'playing', waiting out the feed module's dynamic import */
async function startWeb(opts = {}) {
  const h = await startPlayer({ ...opts, reach: 'request' });
  h.release();
  await vi.waitFor(() => expect(h.video.src).toBeTruthy(), { timeout: 5000, interval: 5 });
  if (opts.reach === 'src') return h;
  h.video.setDuration(opts.duration ?? 3600);
  h.video.setReadyState(1);
  h.video.emit('loadedmetadata');
  await h.settle();
  if (opts.reach === 'metadata') return h;
  h.video.setReadyState(4);
  await h.settle();
  return h;
}

const infos = (h) => h.net.callsTo(/\/PlaybackInfo$/, 'POST').map((c) => c.body);
const stopped = (h) => h.net.callsTo('/Sessions/Playing/Stopped', 'POST').map((c) => c.body.PlaySessionId);

describe('a remux plays through a MediaSource feed', () => {
  beforeAll(warmPlayer, 120000);

  it('main.m3u8 to jfhls.js, its blob URL on <video>, DirectStream, an ordinary Jellyfin playback', async () => {
    const h = await startWeb();
    expect(H.feeds).toHaveLength(1);
    const o = H.feeds[0].opts;
    expect(o.url).toBe('http://jf.test/videos/' + h.id + '/main.m3u8?MediaSourceId=' + h.source.Id + '&PlaySessionId=ps-1&VideoCodec=hevc&AudioCodec=eac3');
    expect(o.media).toBe(h.video);
    expect(o.hdr).toBe(false);
    expect(o.bitrate).toBe(25000000);
    expect(h.video.src).toBe('blob:jf-1');
    expect(h.P.playMethod).toBe('DirectStream');
    expect(h.P.pending).toBe(false);
    expect(h.P.loading).toBe(false);
    const start = h.net.callsTo('/Sessions/Playing', 'POST');
    expect(start).toHaveLength(1);
    expect(start[0].body.PlayMethod).toBe('DirectStream');
    expect(h.net.callsTo('/MediaSegments/' + h.id)).toHaveLength(1);
    // the phone's PlaybackInfo shape: source, audio, no subtitles in the stream
    expect(infos(h)[0]).toMatchObject({ MediaSourceId: h.source.Id, SubtitleStreamIndex: -1, StartTimeTicks: 0 });
    expect(infos(h)[0].DeviceProfile.Name).toBe('VibeReel Web');
    expect(infos(h)[0].EnableDirectPlay).toBeUndefined();
  });

  it('position(): the start point until the resume seek has landed, then the playhead; a pending seek wins', async () => {
    const h = await startWeb({ resumeSec: 600, reach: 'src' });
    const position = H.feeds[0].opts.position;
    expect(position()).toBe(600);
    h.video.setReadyState(1);   // metadata, but the resume seek is not in yet
    expect(position()).toBe(600);
    h.video.setDuration(3600);
    h.video.emit('loadedmetadata');   // startPlayback() seeks to 600
    await h.settle();
    expect(h.video.currentTime).toBe(600);
    expect(position()).toBe(600);
    h.video.setTime(650);
    expect(position()).toBe(650);   // the start point is forgotten
    h.player.seekTo(1200);
    expect(position()).toBe(1200);
  });

  it('a start from 0: the playhead as soon as there is metadata', async () => {
    const h = await startWeb({ reach: 'src' });
    const position = H.feeds[0].opts.position;
    h.video.setReadyState(1);
    h.video.setTime(0.2);
    expect(position()).toBe(0.2);
  });

  it('the feed’s jump() is a quiet seek', async () => {
    const h = await startWeb();
    h.P.osdShown = false;
    H.feeds[0].opts.jump(123.45);
    expect(h.video.currentTime).toBe(123.45);
    expect(h.P.osdShown).toBe(false);
  });

  it('an HDR display: the feed may keep an HDR copy', async () => {
    vi.stubGlobal('matchMedia', (q) => ({ matches: /video-dynamic-range: high/.test(q) }));
    await startWeb();
    expect(H.feeds[0].opts.hdr).toBe(true);
  });
});

describe('feed failures', () => {
  beforeAll(warmPlayer, 120000);

  /* the card names what happened by the HTTP status the feed gave up on (a
   * 404 is the server ending the job, not a lost connection), with the feed's
   * own message on a second line; no status = no answer at all */
  it.each([
    [500, 'The server had a problem with this stream', 'Retry asks it to start again from 0:00.'],
    [404, 'The server ended this stream', 'Retry asks it to start again from 0:00.'],
    [410, 'The server ended this stream', 'Retry asks it to start again from 0:00.'],
    [401, 'The server refused this stream', 'Signing in again may help.'],
    [403, 'The server refused this stream', 'Signing in again may help.']
  ])('a feed that gave up on HTTP %i: %s', async (status, title, first) => {
    const h = await startWeb();
    const msg = 'Jellyfin stopped sending the video (segment 4: HTTP ' + status + ')';
    H.feeds[0].opts.onFail(Object.assign(new Error(msg), { status }));
    expect(h.P.error).toMatchObject({ title, detail: first + '\n' + msg });
    h.player.exitPlayer();
  });

  it('no answer at all is the connection card; a codec the browser lacks says so', async () => {
    let h = await startWeb();
    H.feeds[0].opts.onFail(new Error('Jellyfin stopped sending the video (segment 4: no answer)'));
    expect(h.P.error).toMatchObject({ title: 'Lost the connection to the server', detail: 'Jellyfin stopped sending the video (segment 4: no answer)' });
    h.player.exitPlayer();
    H.feeds.length = 0;
    h = await startWeb();
    H.feeds[0].opts.onFail(Object.assign(new Error(''), { code: 'unsupported', status: 415 }));
    expect(h.P.error).toMatchObject({ title: 'This browser can’t play this stream', detail: '' });
  });

  it('ignored from a stale feed, over another error card, or off the player', async () => {
    const h = await startWeb();
    const first = H.feeds[0];
    h.player.pmSetAudio(h.source.MediaStreams[1].Index);   // a restart: a second feed
    await vi.waitFor(() => expect(H.feeds).toHaveLength(2), { timeout: 5000, interval: 5 });
    first.opts.onFail(new Error('old'));
    expect(h.P.error).toBe(null);
    h.P.error = { title: 'Other', detail: '', tech: '' };
    H.feeds[1].opts.onFail(new Error('x'));
    expect(h.P.error.title).toBe('Other');
    h.P.error = null;
    h.S.screen = 'detail';
    H.feeds[1].opts.onFail(new Error('x'));
    expect(h.P.error).toBe(null);
  });
});

describe('one feed at a time', () => {
  beforeAll(warmPlayer, 120000);

  it('exit stops the feed (and with it the server job)', async () => {
    const h = await startWeb();
    h.player.exitPlayer();
    expect(H.feeds[0].stop).toHaveBeenCalledTimes(1);
    expect(stopped(h)).toEqual(['ps-1']);
  });

  it('an audio switch: a new PlaybackInfo with that track, a new feed at the same spot, the old one stopped and its session Stopped', async () => {
    const src = source([vstream(), audio({ IsDefault: true }), audio({ Language: 'deu', Codec: 'ac3' })]);
    const h = await startWeb({ item: movie({ MediaSources: [src] }) });
    h.video.setTime(840);
    h.video.emit('timeupdate');
    h.net.on('POST', '/Items/' + h.id + '/PlaybackInfo', playbackInfo({ ...src, SupportsDirectPlay: false, TranscodingUrl: '/videos/' + h.id + '/master.m3u8?PlaySessionId=ps-2' }, { PlaySessionId: 'ps-2' }));
    h.player.pmSetAudio(2);
    expect(h.P.loading).toBe(true);
    expect(h.P.loadingFrom).toBe(840);
    await vi.waitFor(() => expect(H.feeds).toHaveLength(2), { timeout: 5000, interval: 5 });
    expect(infos(h)[1]).toMatchObject({ AudioStreamIndex: 2, StartTimeTicks: 840 * TICKS, EnableDirectPlay: false });
    expect(H.feeds[0].stop).toHaveBeenCalled();
    expect(H.feeds[1].opts.url).toBe('http://jf.test/videos/' + h.id + '/main.m3u8?PlaySessionId=ps-2');
    expect(H.feeds[1].opts.position()).toBe(840);
    expect(h.video.src).toBe('blob:jf-2');
    expect(stopped(h)).toEqual(['ps-1']);
  });

  it('the old session’s Stopped failing changes nothing', async () => {
    const src = source([vstream(), audio({ IsDefault: true }), audio({ Language: 'deu' })]);
    const h = await startWeb({ item: movie({ MediaSources: [src] }) });
    h.net.on('POST', '/Sessions/Playing/Stopped', h.net.status(500));
    h.net.on('POST', '/Items/' + h.id + '/PlaybackInfo', playbackInfo({ ...src, SupportsDirectPlay: false, TranscodingUrl: '/videos/' + h.id + '/master.m3u8?PlaySessionId=ps-3' }, { PlaySessionId: 'ps-3' }));
    h.player.pmSetAudio(2);
    await vi.waitFor(() => expect(H.feeds).toHaveLength(2), { timeout: 5000, interval: 5 });
    await h.settle();
    expect(stopped(h)).toEqual(['ps-1']);
    expect(h.video.src).toBe('blob:jf-2');
  });

  it('a restart whose session id did not change stops nothing on the server', async () => {
    const h = await startWeb();
    h.player.pmSetAudio(h.source.MediaStreams[1].Index);
    await vi.waitFor(() => expect(H.feeds).toHaveLength(2), { timeout: 5000, interval: 5 });
    expect(stopped(h)).toEqual([]);
  });

  it('another kind of start (a pending stream) stops a feed still running', async () => {
    const h = await startWeb();
    h.player.playPendingStream({ url: 'http://ml.test/api/downloads/x/stream', item: movie(), source: source(), downloadId: 'x' });
    expect(H.feeds[0].stop).toHaveBeenCalled();
    expect(h.video.src).toBe('http://ml.test/api/downloads/x/stream');
  });

  it('closed while the feed module was still loading: no feed, no video', async () => {
    let open;
    const gate = new Promise((r) => (open = r));
    // a fresh factory (vi.mock's result is cached across module resets): held until open()
    vi.doMock('../../src/lib/jfhls.js', async () => {
      await gate;
      H.loaded = true;
      return { createJfFeed: (opts) => (H.feeds.push({ opts }), { url: 'blob:late', managed: false, stop() {} }) };
    });
    const h = await startPlayer({ reach: 'request' });
    h.release();
    await h.settle();
    await h.settle();
    expect(infos(h)).toHaveLength(1);
    h.player.exitPlayer();
    expect(H.loaded).toBe(false);
    open();
    await vi.waitFor(() => expect(H.loaded).toBe(true), { timeout: 5000, interval: 5 });
    for (let i = 0; i < 20; i++) await h.settle();
    expect(H.feeds).toHaveLength(0);
    expect(h.video.src).toBeFalsy();
    vi.doMock('../../src/lib/jfhls.js', () => H.stub());
  });
});

describe('direct play and the default audio track', () => {
  beforeAll(warmPlayer, 120000);

  const mp4 = () => source([vstream({ Codec: 'h264' }), audio({ Codec: 'aac', IsDefault: true }), audio({ Codec: 'aac', Language: 'deu' }), sub({ Codec: 'dvd_subtitle' })], { Container: 'mp4' });

  it('a progressive MP4 Jellyfin direct-plays: the file itself, no feed', async () => {
    const src = mp4();
    const h = await startWeb({ item: movie({ MediaSources: [src] }) });
    expect(H.feeds).toHaveLength(0);
    expect(h.video.src).toContain('/stream.mp4?static=true');
    expect(h.P.playMethod).toBe('DirectPlay');
  });

  it('EnableDirectPlay is off for any but the file’s default track — and not part of a burn-in request', async () => {
    const src = mp4();
    const h = await startWeb({ item: movie({ MediaSources: [src] }) });
    h.player.exitPlayer();
    h.P.source = src;
    h.P.audioIndex = 2;
    h.player.play(h.id, 0);
    h.P.audioIndex = 1;
    h.player.play(h.id, 0);
    h.P.audioIndex = 2;
    h.P.subIndex = 3;   // VobSub: burn in
    h.player.play(h.id, 0);
    h.P.subIndex = -1;
    h.P.audioIndex = -1;
    h.player.play(h.id, 0);
    const b = infos(h).slice(1);
    expect(b.map((x) => x.EnableDirectPlay)).toEqual([false, undefined, undefined, undefined]);
  });

  it('an audio switch on a direct play restarts (through the remux), loading card up at once', async () => {
    const src = mp4();
    const h = await startWeb({ item: movie({ MediaSources: [src] }) });
    h.video.setTime(300);
    h.video.emit('timeupdate');
    h.player.pmSetAudio(2);
    expect(h.P.loading).toBe(true);
    expect(h.P.loadingFrom).toBe(300);
    await h.settle();
    expect(infos(h)[1]).toMatchObject({ AudioStreamIndex: 2, EnableDirectPlay: false, StartTimeTicks: 300 * TICKS });
  });

  it('…but on a pending stream it stays a client-side switch', async () => {
    const h = await startWeb();
    h.player.exitPlayer();
    const src = source([vstream(), audio({ IsDefault: true }), audio({ Language: 'deu' })]);
    h.player.playPendingStream({ url: 'http://ml.test/s', item: movie(), source: src, downloadId: 'x' });
    const n = infos(h).length;
    h.player.pmSetAudio(2);
    expect(infos(h).length).toBe(n);
    expect(h.P.loading).toBe(true);   // still the pending start's card, not a restart's
  });
});

describe('error wording names the browser', () => {
  beforeAll(warmPlayer, 120000);

  it('media errors', async () => {
    let h = await startWeb();
    h.video.fail(2, '');
    expect(h.P.error).toMatchObject({ title: 'Lost the connection to the server', detail: 'The browser stopped receiving the video over the network.' });
    h.player.exitPlayer();
    h = await startWeb();
    h.video.fail(9, 'odd');
    expect(h.P.error).toMatchObject({ title: 'Playback failed', detail: 'The browser’s media pipeline reported an error. (odd)' });
  });

  it('nothing playable offered', async () => {
    const src = source([vstream(), audio()]);
    const h = await startPlayer({ reach: 'request', item: movie({ MediaSources: [src] }), info: playbackInfo({ ...src, SupportsDirectPlay: false }) });
    h.release();
    await h.settle();
    await h.settle();
    const { toastState } = await import(/* @vite-ignore */ path.resolve(ROOT, 'src/lib/toast.svelte.js'));
    expect(toastState.msg).toBe('No playable source: Jellyfin offered no stream this browser can play for this title.');
  });

  it('a phone-style feed the browser can’t play', async () => {
    const h = await startWeb();
    h.player.exitPlayer();
    let args;
    h.player.playFeedStream({ item: movie(), source: source(), open: (a) => ((args = a), { url: 'blob:f', managed: false, stop() {} }) });
    args.onFail(Object.assign(new Error('this browser can’t play hvc1'), { code: 'unsupported' }));
    expect(h.P.error.title).toBe('This browser can’t play this file');
  });

  it('the stall watchdog: never started, stalled, stalled on a slow link', async () => {
    let h = await startWeb({ reach: 'metadata' });
    await h.clock.tick(60500);
    expect(h.P.error).toMatchObject({ title: 'The video never started' });
    expect(h.P.error.detail).toBe('The server stopped answering before the first frame arrived. Check that this computer can reach it, then Retry.');
    h.player.exitPlayer();
    h = await startWeb();
    h.video.advance(42);
    await h.clock.tick(500);
    await h.clock.tick(30000);
    expect(h.P.error.title).toBe('Playback stalled');
    // a no-break space between the number and its unit: "30" never ends a line
    expect(h.P.error.detail).toBe('No video has arrived from the server for 30\u00a0s. Check this computer’s connection, then Retry from 0:42.');
    h.player.exitPlayer();
    h = await startWeb();
    h.video.advance(42);
    await h.clock.tick(5000);
    h.P.slowNet = { need: 25, got: 6 };
    await h.clock.tick(26000);
    expect(h.P.error.detail).toMatch(/^This stream needs about 25\u00a0Mbit\/s but this computer was only getting about 6\u00a0Mbit\/s, and then nothing for 3\d\u00a0s\./);
  });
});

describe('an episode rolls on through a new feed', () => {
  beforeAll(warmPlayer, 120000);

  it('Up Next: the next episode’s PlaybackInfo opens a second feed, the first is stopped', async () => {
    const ep1 = episode({ Id: 'ep1', IndexNumber: 1 });
    const ep2 = episode({ Id: 'ep2', IndexNumber: 2 });
    const h = await startWeb({ item: ep1, next: ep2 });
    await vi.waitFor(() => expect(h.P.next).toBeTruthy(), { timeout: 5000, interval: 5 });
    h.net.on('POST', '/Items/ep2/PlaybackInfo', playbackInfo({ ...ep2.MediaSources[0], SupportsDirectPlay: false, TranscodingUrl: '/videos/ep2/master.m3u8?PlaySessionId=ps-n' }, { PlaySessionId: 'ps-n' }));
    h.player.playNext(true);
    await vi.waitFor(() => expect(H.feeds).toHaveLength(2), { timeout: 5000, interval: 5 });
    expect(H.feeds[0].stop).toHaveBeenCalled();
    expect(H.feeds[1].opts.url).toBe('http://jf.test/videos/ep2/main.m3u8?PlaySessionId=ps-n');
    expect(stopped(h)).toContain('ps-1');
  });
});
