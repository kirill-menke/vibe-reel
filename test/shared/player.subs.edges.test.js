/* player.svelte.js — subtitles, reports, transport and the marker lookup at
 * the edges the other player files leave open (lane r3-tv-unit,
 * mutation-backed: Stryker on player.svelte.js 1121–1185 and 1210–1532).
 *
 * CLAUDE.md, "Video playback": text subtitles are "fetched as VTT and attached
 * as a same-origin blob <track>", PGS "decoded client-side by libpgs onto the
 * #pgs canvas" (a VobSub/DVB track has no client decoder: burn-in only);
 * "a slow extraction must not land on the next video"; reportStop() "drops
 * Home's SWR entries for Resume, Latest and /Shows/NextUp" for the item it
 * stopped; "Seeking keeps a private seekTarget for ~900ms" and a seek into the
 * credits restarts the Up Next countdown from where it lands; Up Next's next
 * episode is the second of `/Shows/{sid}/Episodes?StartItemId={id}&Limit=2`,
 * never the episode itself; IntroDB is asked only for an episode with a season
 * and episode number, through the series' IMDb id. */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import { startPlayer, warmPlayer } from '../helpers/player.js';
import { movie, episode, source, video, audio, sub, tracks, segment, playbackInfo } from '../helpers/media.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const LIBPGS = path.resolve(ROOT, 'src/vendor/libpgs.js');
const TICKS = 10000000;

function at(h, t) {
  h.video.setTime(t);
  h.video.emit('timeupdate');
}

afterEach(() => {
  vi.doUnmock(LIBPGS);
});

/** a fake text track with cues (the fake <video> keeps textTracks as a plain array) */
function textTrack(cues = []) {
  return { mode: 'showing', cues: cues.map(([s, e]) => ({ startTime: s, endTime: e })) };
}

describe('text subtitles', () => {
  beforeAll(warmPlayer, 120000);

  /* 0 video · 1 audio · 2 SRT (no language) · 3 SRT ger */
  const film = () => movie({ MediaSources: [source([video(), audio(), sub({ Language: undefined }), sub({ Language: 'ger' })])] });

  it('the VTT comes from /Videos/{item}/{source}/Subtitles/{index}/0/Stream.vtt with the token', async () => {
    const h = await startPlayer({ item: film() });
    h.player.pmSetSub(2);
    await h.settle();
    const call = h.net.calls.find((c) => c.path.endsWith('/Stream.vtt'));
    expect(call.url).toBe('http://jf.test/Videos/' + h.id + '/' + h.item.MediaSources[0].Id + '/Subtitles/2/0/Stream.vtt?api_key=tok-u1');
  });

  it('the track: a default text/vtt blob of the answer, language "und" when the stream has none', async () => {
    const blobs = [];
    const mk = URL.createObjectURL;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      blobs.push(b);
      return mk.call(URL, b);
    });
    const h = await startPlayer({ item: film(), vtt: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n' });
    h.player.pmSetSub(2);
    await h.settle();
    const t = h.video.querySelector('track');
    expect(t.default).toBe(true);
    expect(t.kind).toBe('subtitles');
    expect(t.srclang).toBe('und');
    const b = blobs.find((x) => x.type === 'text/vtt');
    expect(b).toBeTruthy();
    expect(await b.text()).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n');
  });

  it('250 ms after the attach every text track is showing (two tracks: both)', async () => {
    const h = await startPlayer({ item: film() });
    h.video.textTracks.push({ mode: 'disabled', cues: null }, { mode: 'disabled', cues: null });
    h.player.pmSetSub(3);
    await h.settle();
    await h.clock.tick(250);
    expect(h.video.textTracks.map((t) => t.mode)).toEqual(['showing', 'showing']);
  });

  it('a slow VTT that arrives after the next video started is dropped (playGen)', async () => {
    let answer;
    const h = await startPlayer({
      item: film(),
      routes: (net) => net.on('GET', (r) => r.path.endsWith('/Stream.vtt'), () => new Promise((res) => (answer = res)))
    });
    h.player.pmSetSub(2);
    await h.settle();
    // the restart's PlaybackInfo stays out, so its startPlayback (which clears tracks) can't hide a late append
    h.net.on('POST', '/Items/' + h.id + '/PlaybackInfo', () => new Promise(() => {}));
    h.player.restartPlayback(10);   // same item, same subtitle track: only playGen tells them apart
    answer(h.net.text('WEBVTT\n', 'text/vtt'));
    await h.settle();
    expect(h.video.querySelectorAll('track')).toHaveLength(0);
  });

  it('a VTT that fails after the user picked another track: no toast, the new pick stands', async () => {
    let fail;
    const h = await startPlayer({
      item: film(),
      routes: (net) => net.on('GET', (r) => r.path.endsWith('/2/0/Stream.vtt'), () => new Promise((_, rej) => (fail = rej)))
    });
    h.player.pmSetSub(2);
    await h.settle();
    const toast = (await import(path.resolve(ROOT, 'src/lib/toast.svelte.js'))).toastState;
    const before = toast.msg;
    h.player.pmSetSub(3);
    fail(new TypeError('Failed to fetch'));
    await h.settle();
    expect(toast.msg).toBe(before);
    expect(h.P.subIndex).toBe(3);
  });

  it('a VTT that fails after the next video started: no toast either', async () => {
    let fail;
    const h = await startPlayer({
      item: film(),
      routes: (net) => net.on('GET', (r) => r.path.endsWith('/Stream.vtt'), () => new Promise((_, rej) => (fail = rej)))
    });
    h.player.pmSetSub(2);
    await h.settle();
    const toast = (await import(path.resolve(ROOT, 'src/lib/toast.svelte.js'))).toastState;
    const before = toast.msg;
    h.player.restartPlayback(10);
    fail(new TypeError('Failed to fetch'));
    await h.settle();
    expect(toast.msg).toBe(before);
    expect(h.P.subIndex).toBe(2);
  });

  /* R3-TU-2 (fixed): off and on again while the first VTT is still loading — both
   * requests carried the same track and playGen, so both answers were attached and
   * every cue showed twice. Every clearSubs() now supersedes the request in flight. */
  it('R3-TU-2: off and on again while the VTT loads: the track is attached once', async () => {
    const answers = [];
    const h = await startPlayer({
      item: film(),
      routes: (net) => net.on('GET', (r) => r.path.endsWith('/2/0/Stream.vtt'), () => new Promise((res) => answers.push(res)))
    });
    h.player.pmSetSub(2);
    await h.settle();
    h.player.pmSetSub(-1);
    await h.settle();
    h.player.pmSetSub(2);
    await h.settle();
    expect(answers).toHaveLength(2);
    for (const a of answers) a(h.net.text('WEBVTT\n', 'text/vtt'));
    await h.settle();
    expect(h.video.querySelectorAll('track')).toHaveLength(1);
  });

  it('R3-TU-2: the superseded request is aborted, mints no blob, raises no toast; the one blob is revoked by the next clear', async () => {
    const minted = [];
    const revoked = [];
    const mk = URL.createObjectURL;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      const u = mk.call(URL, b);
      if (b.type === 'text/vtt') minted.push(u);
      return u;
    });
    const rv = URL.revokeObjectURL;
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => {
      revoked.push(u);
      return rv.call(URL, u);
    });
    const answers = [];
    const h = await startPlayer({
      item: film(),
      routes: (net) => net.on('GET', (r) => r.path.endsWith('/2/0/Stream.vtt'), (req) => new Promise((res) => answers.push([req, res])))
    });
    const toast = (await import(path.resolve(ROOT, 'src/lib/toast.svelte.js'))).toastState;
    const before = toast.msg;
    h.player.pmSetSub(2);
    await h.settle();
    h.player.pmSetSub(-1);
    h.player.pmSetSub(2);
    await h.settle();
    expect(answers).toHaveLength(2);
    expect(answers[0][0].signal.aborted).toBe(true);
    expect(answers[1][0].signal.aborted).toBe(false);
    for (const [, res] of answers) res(h.net.text('WEBVTT\n', 'text/vtt'));
    await h.settle();
    expect(minted).toHaveLength(1);
    expect(h.video.querySelector('track').src).toBe(minted[0]);
    expect(toast.msg).toBe(before);
    expect(h.P.subIndex).toBe(2);
    h.player.pmSetSub(-1);
    expect(revoked).toEqual(minted);
  });

  it('R3-TU-2: switched off within the 250 ms after its answer landed: the tracks stay disabled', async () => {
    const h = await startPlayer({ item: film() });
    h.video.textTracks.push({ mode: 'disabled', cues: null });
    h.player.pmSetSub(3);
    await h.settle();
    h.player.pmSetSub(-1);
    await h.clock.tick(250);
    expect(h.video.textTracks.map((t) => t.mode)).toEqual(['disabled']);
  });

  it('a subtitle index the source does not have attaches nothing and does not throw', async () => {
    const h = await startPlayer({ item: film() });
    h.P.subIndex = 9;
    expect(() => h.player.attachSubtitles(h.P.source)).not.toThrow();
    expect(h.video.querySelectorAll('track')).toHaveLength(0);
  });

  it('a DirectPlay start with a VobSub selected (Jellyfin gave no transcode) fetches no VTT for it', async () => {
    const item = movie({ MediaSources: [source([video(), audio(), tracks.vobsub()])] });
    const h = await startPlayer({ item });
    h.player.exitPlayer();
    h.P.subIndex = 2;
    h.player.attachSubtitles(item.MediaSources[0]);
    await h.settle();
    expect(h.net.calls.filter((c) => c.path.includes('/Subtitles/'))).toEqual([]);
  });
});

describe('clearSubs', () => {
  beforeAll(warmPlayer, 120000);

  it('disables every text track and clears the PGS canvas', async () => {
    const h = await startPlayer();
    h.video.textTracks.push(textTrack(), textTrack());
    const ctx = { clearRect: vi.fn() };
    const canvas = document.createElement('canvas');
    canvas.getContext = (t) => (t === '2d' ? ctx : null);
    h.player.setPgsCanvas(canvas);
    canvas.style.display = 'block';
    h.player.clearSubs();
    expect(h.video.textTracks.map((t) => t.mode)).toEqual(['disabled', 'disabled']);
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, canvas.width, canvas.height);
    expect(canvas.style.display).toBe('none');
  });

  it('with no <video> (nothing mounted yet) it does nothing', async () => {
    const h = await startPlayer();
    h.player.setVideoEl(null);
    expect(() => h.player.clearSubs()).not.toThrow();
  });
});

describe('subtitle timing on several text tracks', () => {
  beforeAll(warmPlayer, 120000);

  it('every cue of every track moves; a track without cues is skipped, not the end of the loop', async () => {
    const h = await startPlayer();
    const a = textTrack([[1, 2], [3, 4]]);
    const b = textTrack([[10, 11]]);
    h.video.textTracks.push(a, { mode: 'showing', cues: null }, b);
    h.player.nudgeSubOffset(1);
    h.player.nudgeSubOffset(1);
    h.player.nudgeSubOffset(1);
    h.player.nudgeSubOffset(1);   // +1 s
    expect(a.cues.map((c) => [c.startTime, c.endTime])).toEqual([[2, 3], [4, 5]]);
    expect(b.cues.map((c) => [c.startTime, c.endTime])).toEqual([[11, 12]]);
  });

  it('with no <video> a nudge only changes the offset', async () => {
    const h = await startPlayer();
    h.player.setVideoEl(null);
    expect(() => h.player.nudgeSubOffset(1)).not.toThrow();
    expect(h.P.subOffset).toBe(0.25);
  });
});

describe('PGS edges', () => {
  beforeAll(warmPlayer, 120000);

  function libpgs({ ctor } = {}) {
    const made = [];
    class R {
      constructor(o) {
        if (ctor) ctor(o);
        this.o = o;
        made.push(this);
      }
      dispose() {}
    }
    vi.doMock(LIBPGS, () => ({ loadPgs: () => R }));
    return made;
  }

  it('a stream with a DeliveryUrl is fetched from the server + that URL; a codec named "pgs" counts as PGS', async () => {
    const made = libpgs();
    const item = movie({ MediaSources: [source([video(), audio(), sub({ Codec: 'PGS', IsTextSubtitleStream: false, DeliveryUrl: '/Videos/x/sub.sup' })])] });
    const h = await startPlayer({ item });
    h.player.setPgsCanvas(document.createElement('canvas'));
    h.player.pmSetSub(2);
    expect(made).toHaveLength(1);
    expect(made[0].o.subUrl).toBe('http://jf.test/Videos/x/sub.sup');
  });

  it('no canvas yet: nothing is constructed and nothing throws', async () => {
    const made = libpgs();
    const item = movie({ MediaSources: [source([video(), audio(), tracks.pgs()])] });
    const h = await startPlayer({ item });
    expect(() => h.player.pmSetSub(2)).not.toThrow();
    expect(made).toHaveLength(0);
  });

  it('a libpgs that loads as nothing leaves the canvas hidden and toasts', async () => {
    vi.doMock(LIBPGS, () => ({ loadPgs: () => null }));
    const item = movie({ MediaSources: [source([video(), audio(), tracks.pgs()])] });
    const h = await startPlayer({ item });
    const canvas = document.createElement('canvas');
    h.player.setPgsCanvas(canvas);
    canvas.style.display = 'none';
    h.player.pmSetSub(2);
    expect(canvas.style.display).toBe('none');
    const toast = (await import(path.resolve(ROOT, 'src/lib/toast.svelte.js'))).toastState;
    expect(toast.msg).toBe('Couldn’t show these subtitles');
  });

  it('a renderer that throws on construction toasts instead of breaking playback', async () => {
    libpgs({ ctor: () => { throw new Error('bad sup'); } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const item = movie({ MediaSources: [source([video(), audio(), tracks.pgs()])] });
    const h = await startPlayer({ item });
    h.player.setPgsCanvas(document.createElement('canvas'));
    expect(() => h.player.pmSetSub(2)).not.toThrow();
    const toast = (await import(path.resolve(ROOT, 'src/lib/toast.svelte.js'))).toastState;
    expect(toast.msg).toBe('Couldn’t show these subtitles');
    expect(h.P.error).toBe(null);
  });
});

describe('reports', () => {
  beforeAll(warmPlayer, 120000);

  it('a Progress report says the stream can seek, at full volume', async () => {
    const h = await startPlayer();
    h.player.reportProgress(false);
    await h.settle();
    expect(h.net.callsTo('/Sessions/Playing/Progress', 'POST').at(-1).body).toMatchObject({ CanSeek: true, VolumeLevel: 100, PlayMethod: h.P.playMethod });
  });

  it('the Stopped report drops Home’s play-state caches for that item (not the next episode’s warm)', async () => {
    const h = await startPlayer();
    h.net.on('GET', (r) => r.path === '/UserItems/Resume', { Items: [{ Id: h.id }] });
    h.net.on('GET', '/Items/other', { Id: 'other' });
    await h.api.revalidate('/UserItems/Resume?userId=u1');
    await h.api.revalidate('/Items/other?userId=u1');
    expect(h.api.cached('/UserItems/Resume?userId=u1')).not.toBe(null);
    h.player.exitPlayer();
    expect(h.api.cached('/UserItems/Resume?userId=u1')).toBe(null);
    expect(h.api.cached('/Items/other?userId=u1')).not.toBe(null);
  });
});

describe('transport', () => {
  beforeAll(warmPlayer, 120000);

  it('seekDur without a known duration: the source runtime; with no source either, 0', async () => {
    const h = await startPlayer({ duration: NaN });
    expect(h.player.seekDur()).toBe(h.item.MediaSources[0].RunTimeTicks / TICKS);
    h.P.source = null;
    expect(h.player.seekDur()).toBe(0);
  });

  it('a live-like (infinite) or zero duration falls back to the source runtime', async () => {
    const h = await startPlayer({ duration: Infinity });
    const runtime = h.item.MediaSources[0].RunTimeTicks / TICKS;
    expect(h.player.seekDur()).toBe(runtime);
    h.video.setDuration(0);
    expect(h.player.seekDur()).toBe(runtime);
    h.video.setDuration(1234);
    expect(h.player.seekDur()).toBe(1234);
  });

  it('a seek raises the OSD; a quiet one does not', async () => {
    const h = await startPlayer();
    h.player.hideOsd();
    h.player.seekTo(100, true);
    expect(h.P.osdShown).toBe(false);
    h.player.seekBy(10);
    expect(h.P.osdShown).toBe(true);
    expect(h.video.seeks.at(-1)).toBe(110);
  });

  it('togglePause with no <video> does nothing', async () => {
    const h = await startPlayer();
    h.player.setVideoEl(null);
    expect(() => h.player.togglePause()).not.toThrow();
  });

  it('a seek to just before the credits does not start the Up Next countdown early', async () => {
    const next = episode({ IndexNumber: 2 });
    const h = await startPlayer({
      item: episode({ IndexNumber: 1 }),
      next,
      segments: [segment('Outro', 2500, 2690)],
      routes: (net) => net.on('POST', '/Items/' + next.Id + '/PlaybackInfo', playbackInfo(next.MediaSources[0], { PlaySessionId: 'ps-next' }))
    });
    await h.settle();
    h.player.seekTo(2499.25);
    await h.clock.tick(1000);
    at(h, 2499.5);
    at(h, 2500);
    at(h, 2509.5);
    await h.settle();
    expect(h.net.callsTo('/Items/' + next.Id + '/PlaybackInfo', 'POST')).toHaveLength(0);
    expect(h.player.upNextLeft()).toBe(1);
  });
});

describe('Up Next / IntroDB lookups', () => {
  beforeAll(warmPlayer, 120000);

  it('asks for the next episode with Primary,Thumb images', async () => {
    const h = await startPlayer({ item: episode() });
    await h.settle();
    const q = new URLSearchParams(h.net.callsTo((r) => r.path.endsWith('/Episodes'))[0].query);
    expect(q.get('EnableImageTypes')).toBe('Primary,Thumb');
    expect(q.get('Limit')).toBe('2');
    expect(q.get('IsMissing')).toBe('false');
  });

  it('a list that repeats the episode itself is no next episode', async () => {
    const ep = episode();
    const h = await startPlayer({ item: ep, routes: (net) => net.on('GET', '/Shows/' + ep.SeriesId + '/Episodes', { Items: [ep, ep] }) });
    await h.settle();
    expect(h.P.next).toBe(null);
  });

  it('a next-episode answer for an item no longer playing is dropped', async () => {
    const ep = episode();
    const next = episode({ IndexNumber: 2 });
    let answer;
    const h = await startPlayer({ item: ep, routes: (net) => net.on('GET', '/Shows/' + ep.SeriesId + '/Episodes', () => new Promise((r) => (answer = r))) });
    h.player.exitPlayer();
    answer({ Items: [ep, next] });
    await h.settle();
    expect(h.P.next).toBe(null);
  });

  it.each([
    ['season', { ParentIndexNumber: null }],
    ['episode', { IndexNumber: null }]
  ])('an episode without a %s number is not looked up in IntroDB', async (_, o) => {
    const ep = episode(o);
    const h = await startPlayer({ item: ep, seriesItem: { Id: ep.SeriesId, Type: 'Series', ProviderIds: { Imdb: 'tt0000042' } } });
    await h.settle();
    expect(h.net.callsTo((r) => r.url.includes('/api/segments/'))).toHaveLength(0);
  });

  it('started from its series page, the series is not fetched again for its IMDb id', async () => {
    const ep = episode();
    const h = await startPlayer({ item: ep, reach: 'request' });
    h.P.series = { Id: ep.SeriesId, Type: 'Series', ProviderIds: { Imdb: 'tt0000042' } };
    h.release();
    await h.settle();
    await h.clock.tick(50);
    expect(h.net.callsTo('/Items/' + ep.SeriesId, 'GET')).toHaveLength(0);
    expect(h.net.callsTo((r) => r.url.includes('/api/segments/tt0000042/1/1'))).toHaveLength(1);
  });
});

describe('marker lookups: what lands, and when', () => {
  beforeAll(warmPlayer, 120000);

  it('a restart clears the previous skip windows until the new answer lands', async () => {
    const h = await startPlayer({ segments: [segment('Intro', 60, 150)] });
    await h.settle();
    expect(h.P.skips).toHaveLength(1);
    h.net.on('GET', '/MediaSegments/' + h.id, () => new Promise(() => {}));
    h.player.restartPlayback(10);
    await h.settle();
    expect(h.P.skips).toEqual([]);
  });

  it('segments answering after the exit do not land', async () => {
    let answer;
    const h = await startPlayer({ routes: (net, { id }) => net.on('GET', '/MediaSegments/' + id, () => new Promise((r) => (answer = r))) });
    h.player.exitPlayer();
    answer({ Items: [segment('Intro', 60, 150)] });
    await h.settle();
    await h.clock.tick(50);
    expect(h.P.skips).toEqual([]);
  });

  it('IntroDB answering before Jellyfin: its windows alone, nothing else in the list', async () => {
    const ep = episode();
    let answer;
    const h = await startPlayer({
      item: ep,
      seriesItem: { Id: ep.SeriesId, Type: 'Series', ProviderIds: { Imdb: 'tt0000042' } },
      introdb: { intro: { start: 200, end: 290 } },
      routes: (net, { id }) => net.on('GET', '/MediaSegments/' + id, () => new Promise((r) => (answer = r)))
    });
    await h.settle();
    await h.clock.tick(50);
    expect(h.P.skips).toEqual([{ kind: 'intro', start: 200, end: 290, from: 'introdb' }]);
    answer({ Items: [] });
  });

  it('a series extra (a Video with a SeriesId) gets no Up Next lookup', async () => {
    const item = movie({ Type: 'Video', SeriesId: 'show-1' });
    const h = await startPlayer({ item });
    await h.settle();
    expect(h.net.callsTo((r) => r.path.endsWith('/Episodes'))).toHaveLength(0);
    expect(h.P.next).toBe(null);
  });

  it("P.series of another show is not the episode's series: its own series is fetched for the IMDb id", async () => {
    const ep = episode();
    const h = await startPlayer({ item: ep, reach: 'request', seriesItem: { Id: ep.SeriesId, Type: 'Series', ProviderIds: { Imdb: 'tt0000042' } } });
    h.P.series = { Id: 'another-show', Type: 'Series', ProviderIds: { Imdb: 'tt0000099' } };
    h.release();
    await h.settle();
    await h.clock.tick(50);
    expect(h.net.callsTo((r) => r.url.includes('/api/segments/tt0000042/1/1'))).toHaveLength(1);
    expect(h.net.callsTo((r) => r.url.includes('/api/segments/tt0000099/'))).toHaveLength(0);
  });
});
