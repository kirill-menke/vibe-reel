/* player.svelte.js — startPlayback(), the error card, Retry and the element's
 * event handlers, at the edges the other player files leave open (lane
 * r3-tv-unit, mutation-backed: Stryker on player.svelte.js 461–951).
 *
 * CLAUDE.md, "Video playback": the playback error card "says what failed in
 * plain words (plus container/codecs when known) and offers Retry — the same
 * start again, at the last good position"; a pending stream's "ended more than
 * 60 s short of the probed runtime is the 'download stopped here' card with
 * Retry at that position"; "startGen: a stale once-listener from a failed start
 * stays quiet"; the Skip chip "needs a live position even while the OSD is
 * down" (full-rate mirroring from 5 s before a window to 2 s after it, else a
 * 2 s heartbeat); Up Next: "seeking back re-arms a dismissed card", the countdown
 * ignores the post-seek garbage reads, and without credits "the end of the
 * file" is the go (onended rolls on). */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import { startPlayer, warmPlayer } from '../helpers/player.js';
import { movie, episode, source, video, audio, sub, segment, playbackInfo } from '../helpers/media.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TICKS = 10000000;
const PEND = 'http://ml.test/api/downloads/abc/stream';

function at(h, t) {
  h.video.setTime(t);
  h.video.emit('timeupdate');
}

async function firstFrame(h, dur = 3600) {
  h.video.setDuration(dur);
  h.video.setReadyState(1);
  h.video.emit('loadedmetadata');
  await h.settle();
  h.video.setReadyState(4);
  await h.settle();
}

/** a focusable in the (TV) video layer, so focusKey() has somewhere to land */
function layerButton(key) {
  let layer = document.getElementById('video-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'video-layer';
    document.body.append(layer);
  }
  const b = document.createElement('button');
  b.className = 'focus';
  b.dataset.focus = key;
  b.getBoundingClientRect = () => ({ left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 });
  layer.append(b);
  return b;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('startPlayback', () => {
  beforeAll(warmPlayer, 120000);

  it('raises the ring and the loading card at once, and load()s the element after setting its src', async () => {
    const h = await startPlayer({ reach: 'src' });
    expect(h.P.spinner).toBe(true);
    expect(h.P.loading).toBe(true);
    const i = h.video.calls.findIndex((c) => c[0] === 'src');
    expect(h.video.calls[i + 1]).toEqual(['load']);
  });

  it('a start before the <video> exists (no element yet) raises the player without throwing', async () => {
    const h = await startPlayer({ reach: 'src' });
    h.player.exitPlayer();
    h.player.setVideoEl(null);
    expect(() => h.player.playPendingStream({ url: PEND, item: { Name: 'F' }, source: h.source })).not.toThrow();
    expect(h.S.screen).toBe('player');
    expect(h.P.loading).toBe(true);
  });

  it('a pending start clears what the previous item left: skips, credits, next, trickplay, chapters', async () => {
    const h = await startPlayer({ reach: 'src' });
    Object.assign(h.P, { skips: [{ kind: 'intro', start: 1, end: 2 }], credits: { start: 1 }, next: { Id: 'n' }, trick: { Width: 1 }, chapters: [{ at: 1, name: 'c' }] });
    h.player.playPendingStream({ url: PEND, item: { Name: 'F' }, source: h.source });
    expect(h.P).toMatchObject({ skips: [], credits: null, next: null, trick: null, chapters: [] });
  });

  it('a stale loadedmetadata listener from a start that was closed stays quiet in the next start', async () => {
    const h = await startPlayer({ reach: 'src', resumeSec: 500 });   // start A, waiting for metadata
    h.player.exitPlayer();
    h.player.playPendingStream({ url: PEND, item: { Name: 'F' }, source: h.source });   // start B at 0
    h.video.setDuration(3600);
    h.video.emit('loadedmetadata');   // A's once-listener is still attached
    expect(h.video.seeks).toEqual([]);   // A would have resumed at 500
  });

  it('a new start drops a scrub still pending from the previous video', async () => {
    const m = movie();
    const sid = m.MediaSources[0].Id;
    const layout = { Width: 320, Height: 180, TileWidth: 10, TileHeight: 10, ThumbnailCount: 270, Interval: 10000, Bandwidth: 1 };
    vi.stubGlobal('Image', class { set src(v) {} });
    const h = await startPlayer({ item: m, trickplay: { [sid]: { 320: layout } } });
    await h.settle();
    h.player.scrubBy(1);
    expect(h.P.scrub).not.toBe(null);
    h.player.playPendingStream({ url: PEND, item: { Name: 'F' }, source: h.source });
    expect(h.P.scrub).toBe(null);
    const seeks = h.video.seeks.length;
    await h.clock.tick(2000);
    expect(h.video.seeks.length).toBe(seeks);   // the scrub's commit never lands on the new video
  });
});

describe('a play() the element refuses', () => {
  beforeAll(warmPlayer, 120000);

  it('drops the card and focuses Play — but not when a newer start owns the player by then', async () => {
    const h = await startPlayer({ reach: 'src' });
    let refuse;
    h.video.play = () => new Promise((_, rej) => (refuse = rej));
    h.video.setDuration(3600);
    h.video.emit('loadedmetadata');
    h.player.playPendingStream({ url: PEND, item: { Name: 'F' }, source: h.source });   // a newer start
    refuse(new DOMException('no', 'NotAllowedError'));
    await h.settle();
    expect(h.P.loading).toBe(true);
    expect(h.P.osdShown).toBe(false);
  });

  it('the refusal drops the card and (TV) puts focus on c-play', async () => {
    const h = await startPlayer({ reach: 'src' });
    const play = layerButton('c-play');
    h.video.setPaused(true);   // the phone's early play() kick had un-paused it
    h.video.playRejects = new DOMException('no', 'NotAllowedError');
    h.video.setDuration(3600);
    h.video.emit('loadedmetadata');
    await h.settle();
    expect(h.P.loading).toBe(false);
    if (!__PHONE__) expect(document.activeElement).toBe(play);
  });
});

describe('the error card', () => {
  beforeAll(warmPlayer, 120000);

  const DEV = __PHONE__ ? 'iPhone' : 'TV';
  const table = __PHONE__
    ? {
        1: ['Playback was interrupted', 'The stream was aborted before it finished loading.'],
        2: ['Lost the connection to the server', 'The iPhone stopped receiving the video over the network.'],
        3: ['The iPhone couldn’t decode this video', 'The stream started, but its video or audio broke the iPhone’s decoder.'],
        4: ['The iPhone can’t play this stream', 'Its format isn’t supported by Safari — the server’s remux may have failed.'],
        9: ['Playback failed', 'The iPhone’s media pipeline reported an error.']
      }
    : {
        1: ['Playback was interrupted', 'The stream was aborted before it finished loading.'],
        2: ['Lost the connection to the server', 'The TV stopped receiving the video over the network.'],
        3: ['The TV couldn’t decode this video', 'The file started, but its video or audio broke the TV’s decoder.'],
        4: ['The TV can’t play this file', 'Its container or codec isn’t supported for direct play on this TV.'],
        9: ['Playback failed', 'The TV’s media pipeline reported an error.']
      };

  it.each(Object.keys(table))('MediaError code %s: title and detail in plain words (' + DEV + ')', async (code) => {
    const h = await startPlayer();
    h.video.fail(Number(code), '');
    expect(h.P.error.title).toBe(table[code][0]);
    expect(h.P.error.detail).toBe(table[code][1]);   // an empty message adds no "( )"
  });

  it('the element’s message is appended in parentheses', async () => {
    const h = await startPlayer();
    h.video.fail(9, 'PIPELINE_ERROR_DECODE');
    expect(h.P.error.detail).toBe(table[9][1] + ' (PIPELINE_ERROR_DECODE)');
  });

  it('a trailer error: "The trailer stopped" with its own detail', async () => {
    const TS = path.resolve(ROOT, 'src/lib/trailerstream.js');
    vi.doMock(TS, () => ({ createTrailerSource: () => ({ url: 'blob:t', managed: false, stop: () => {} }) }));
    try {
      const h = await startPlayer({ reach: 'src' });
      h.player.playTrailerStream({ id: 'yt12345678x', title: 'T' });
      h.video.fail(3, '');
      expect(h.P.error).toMatchObject({ title: 'The trailer stopped', detail: 'The media library stopped serving it.' });
    } finally {
      vi.doUnmock(TS);
    }
  });

  it('the tech line: container · video codec, resolution, HDR · audio badge', async () => {
    const src = source([video({ Codec: 'hevc', Width: 3840, Height: 2160, VideoRange: 'HDR', VideoRangeType: 'HDR10' }), audio({ Codec: 'eac3', IsDefault: true })], { Container: 'mkv' });
    const h = await startPlayer({ item: movie({ MediaSources: [src] }) });
    h.video.fail(3, '');
    expect(h.P.error.tech).toBe('MKV · HEVC 4K HDR10 · DD+');
  });

  it('the tech line leaves out what is unknown: no container, no video codec, no audio codec', async () => {
    const src = source([video({ Codec: undefined, Width: 1920, Height: 1080 }), audio({ Codec: undefined, IsDefault: true })], { Container: undefined });
    const h = await startPlayer({ item: movie({ MediaSources: [src] }) });
    h.P.source = src;
    h.P.audioIndex = 1;
    h.video.fail(3, '');
    expect(h.P.error.tech).toBe('1080p');
  });

  it('the tech line of a file without audio has no audio part', async () => {
    const src = source([video({ Codec: 'h264', Width: 1280, Height: 720 })], { Container: 'mp4' });
    const h = await startPlayer({ item: movie({ MediaSources: [src] }) });
    h.P.source = src;
    h.P.audioIndex = -1;
    h.video.fail(3, '');
    expect(h.P.error.tech).toBe('MP4 · H264 720p');
  });

  it('the tech line with no source at all is empty', async () => {
    const h = await startPlayer();
    h.P.source = null;
    h.video.fail(3, '');
    expect(h.P.error.tech).toBe('');
  });

  it('closes the dropdown, stops the progress reports while it is up, and (TV) focuses Retry', async () => {
    const h = await startPlayer();
    const retry = layerButton('err-retry');
    h.P.panel = 'audio';
    h.player.showOsd();
    h.video.fail(2, '');
    expect(h.P.panel).toBe(null);
    expect(h.P.osdShown).toBe(false);   // the card replaces the OSD
    const n = h.net.callsTo('/Sessions/Playing/Progress', 'POST').length;
    await h.clock.tick(35000);
    expect(h.net.callsTo('/Sessions/Playing/Progress', 'POST')).toHaveLength(n);
    if (!__PHONE__) expect(document.activeElement).toBe(retry);
  });

  it('drops a pending scrub', async () => {
    const m = movie();
    const sid = m.MediaSources[0].Id;
    vi.stubGlobal('Image', class { set src(v) {} });
    const h = await startPlayer({ item: m, trickplay: { [sid]: { 320: { Width: 320, Height: 180, TileWidth: 10, TileHeight: 10, ThumbnailCount: 270, Interval: 10000, Bandwidth: 1 } } } });
    await h.settle();
    h.player.scrubBy(1);
    h.video.fail(2, '');
    expect(h.P.scrub).toBe(null);
  });
});

describe('Retry', () => {
  beforeAll(warmPlayer, 120000);

  it('raises the loading card with the press, and clears the old subtitle track before PlaybackInfo answers', async () => {
    const item = movie({ MediaSources: [source([video(), audio(), sub({ Language: 'eng' })])] });
    const h = await startPlayer({ item, storage: { 'reel.settings': JSON.stringify({ subMode: 'always' }) } });
    await h.clock.tick(300);
    expect(h.video.querySelectorAll('track')).toHaveLength(1);
    h.video.fail(2, '');
    h.net.on('POST', '/Items/' + h.id + '/PlaybackInfo', () => new Promise(() => {}));
    h.player.retryPlayback();
    expect(h.P.loading).toBe(true);
    expect(h.video.querySelectorAll('track')).toHaveLength(0);
  });

  it('a burn-in switch clears the text track at once (restartPlayback), not after the round trip', async () => {
    const item = movie({ MediaSources: [source([video(), audio(), sub({ Language: 'eng' }), sub({ Codec: 'dvd_subtitle', IsTextSubtitleStream: false })])] });
    const h = await startPlayer({ item, storage: { 'reel.settings': JSON.stringify({ subMode: 'always' }) } });
    await h.clock.tick(300);
    expect(h.video.querySelectorAll('track')).toHaveLength(1);
    h.net.on('POST', '/Items/' + h.id + '/PlaybackInfo', () => new Promise(() => {}));
    h.player.pmSetSub(3);
    expect(h.video.querySelectorAll('track')).toHaveLength(0);
  });

  it('a pending stream retried switches the element to its default audio again', async () => {
    const h = await startPlayer({ reach: 'src' });
    const src = source([video(), audio({ Codec: 'ac3' }), audio({ Codec: 'eac3' })]);
    h.player.playPendingStream({ url: PEND, item: { Name: 'F' }, source: src });
    h.video.setAudioTracks(2);
    h.video.fail(2, '');
    h.player.retryPlayback();
    h.video.setAudioTracks(2);   // the reloaded element's tracks: the first enabled
    h.video.setDuration(3600);
    h.video.emit('loadedmetadata');
    expect([...h.video.audioTracks].map((t) => t.enabled)).toEqual([false, true]);
  });
});

describe('a pending stream that ends early', () => {
  beforeAll(warmPlayer, 120000);

  async function pending(h, runtimeSec = 3600) {
    const src = source([video(), audio()], { RunTimeTicks: runtimeSec * TICKS });
    h.player.playPendingStream({ url: PEND, item: { Name: 'F' }, source: src });
    await firstFrame(h, runtimeSec);
  }

  it('exactly 60 s short is a normal end (the card needs more than 60)', async () => {
    const h = await startPlayer({ reach: 'src', base: 'pending' });
    h.S.pendingKey = 'tv:1';
    await pending(h);
    at(h, 3540);
    h.video.end();
    expect(h.P.error).toBe(null);
    expect(h.S.screen).not.toBe('player');
  });

  it('the card names where it stopped and Retry resumes there — the seek target when it is ahead of the last timeupdate', async () => {
    const h = await startPlayer({ reach: 'src' });
    await pending(h);
    await h.clock.tick(1000);
    at(h, 1000);
    h.player.seekTo(1500);   // no timeupdate since: lastPos is still 1000
    h.video.end();
    expect(h.P.error.title).toBe('The download stopped here');
    expect(h.P.error.detail).toBe(
      'The stream ended at 25:00 of 1:00:00 — the download stalled or was removed. Retry picks up from here once more has arrived.'
    );
    h.player.retryPlayback();
    expect(h.P.loadingFrom).toBe(1500);
  });
});

describe('ontimeupdate with the OSD hidden: full rate near a skip window, else a 2 s heartbeat', () => {
  beforeAll(warmPlayer, 120000);

  async function hidden() {
    const h = await startPlayer({ segments: [segment('Intro', 60, 150)] });
    await h.settle();
    h.player.hideOsd();
    await h.clock.tick(5000);
    at(h, 10);   // a heartbeat: mirrored, and the 2 s clock starts now
    expect(h.P.pos).toBe(10);
    return h;
  }

  it('5 s before the window it mirrors at once; 5.25 s before it waits for the heartbeat', async () => {
    const h = await hidden();
    at(h, 54.75);
    expect(h.P.pos).toBe(10);
    at(h, 55);
    expect(h.P.pos).toBe(55);
  });

  it('2 s after the window it still mirrors; 2.25 s after it does not', async () => {
    const h = await hidden();
    at(h, 152);
    expect(h.P.pos).toBe(152);
    await h.clock.tick(5000);
    at(h, 160);   // heartbeat
    at(h, 152.25);
    expect(h.P.pos).toBe(160);
  });

  it('the heartbeat is every 2 s exactly', async () => {
    const h = await hidden();
    await h.clock.tick(1999);
    at(h, 12);
    expect(h.P.pos).toBe(10);
    await h.clock.tick(1);
    at(h, 13);
    expect(h.P.pos).toBe(13);
    expect(h.P.dur).toBe(h.player.seekDur());
  });

  it('with the OSD shown every update mirrors', async () => {
    const h = await hidden();
    h.player.showOsd();
    at(h, 20);
    at(h, 21);
    expect(h.P.pos).toBe(21);
  });

  it('auto-skip leaves the last second of a window alone (t < end − 1)', async () => {
    const h = await startPlayer({ segments: [segment('Intro', 60, 150)] });
    await h.settle();
    h.settings.setSetting('autoSkipIntro', true);
    await h.clock.tick(1000);
    const seeks = h.video.seeks.length;
    at(h, 149);
    expect(h.video.seeks.length).toBe(seeks);
    at(h, 148.75);
    expect(h.video.seeks.at(-1)).toBe(150);
  });

  it('a pause marks the slice paused', async () => {
    const h = await startPlayer();
    expect(h.P.paused).toBe(false);
    h.video.pause();
    expect(h.P.paused).toBe(true);
  });
});

describe('Up Next edges', () => {
  beforeAll(warmPlayer, 120000);

  async function binge(segments = [segment('Outro', 2500, 2690)]) {
    const next = episode({ IndexNumber: 2 });
    const ep = episode({ IndexNumber: 1 });   // 2700 s
    const h = await startPlayer({
      item: ep,
      next,
      segments,
      routes: (net) => net.on('POST', '/Items/' + next.Id + '/PlaybackInfo', playbackInfo(next.MediaSources[0], { PlaySessionId: 'ps-next' }))
    });
    await h.settle();
    await h.clock.tick(1000);
    return Object.assign(h, { next, rolls: () => h.net.callsTo('/Items/' + next.Id + '/PlaybackInfo', 'POST').length });
  }

  it('a dismissed card is re-armed only by going back more than 1 s before the credits', async () => {
    const h = await binge();
    at(h, 2500);
    at(h, 2505);
    h.player.dismissUpNext();
    expect(h.P.upNextOff).toBe(true);
    at(h, 2500.5);
    expect(h.P.upNextOff).toBe(true);
    at(h, 2499);
    expect(h.P.upNextOff).toBe(true);
    at(h, 2498.75);
    expect(h.P.upNextOff).toBe(false);
  });

  it('a garbage read in the seek window does not shorten the countdown from where the seek landed', async () => {
    const h = await binge();
    at(h, 2400);
    h.player.seekTo(2600);
    expect(h.player.upNextLeft()).toBe(10);
    at(h, 2550);   // currentTime reads behind the target right after the seek
    h.video.setTime(2600);
    expect(h.player.upNextLeft()).toBe(10);
  });

  it('credits ending the countdown exactly 0.5 s before the end: onended rolls on, not the countdown', async () => {
    const h = await binge([segment('Outro', 2689.5, 2699.75)]);
    at(h, 2689.5);
    at(h, 2699.5);   // go = 2689.5 + 10 = dur − 0.5
    await h.settle();
    expect(h.rolls()).toBe(0);
    h.video.end();
    await h.settle();
    expect(h.rolls()).toBe(1);
  });

  it('without credits the go is the end of the file: a timeupdate at the very end does not roll on by itself', async () => {
    const h = await binge([]);
    at(h, 2690);
    at(h, 2700);
    await h.settle();
    expect(h.rolls()).toBe(0);
    h.video.end();
    await h.settle();
    expect(h.rolls()).toBe(1);
  });
});

describe('trailer source details', () => {
  beforeAll(warmPlayer, 120000);
  const TS = path.resolve(ROOT, 'src/lib/trailerstream.js');
  let runs;
  afterEach(() => vi.doUnmock(TS));

  async function trailer({ managed = false } = {}) {
    runs = [];
    vi.doMock(TS, () => ({
      createTrailerSource: (id, cb) => {
        const r = { id, cb, url: 'blob:t' + (runs.length + 1), managed, stop: vi.fn() };
        runs.push(r);
        return r;
      }
    }));
    const h = await startPlayer({ reach: 'src' });
    h.P.sessionId = 'ps-page';
    h.P.playMethod = 'Transcode';
    h.player.playTrailerStream({ id: 'yt12345678x' });
    return h;
  }

  it('the slice of a trailer without a title: item "Trailer", no session, DirectPlay', async () => {
    const h = await trailer();
    expect(h.P.item).toEqual({ Id: null, Name: 'Trailer' });
    expect(h.P.sessionId).toBe('');
    expect(h.P.playMethod).toBe('DirectPlay');
  });

  it("the feeder's jump() is a quiet seek", async () => {
    const h = await trailer();
    h.P.osdShown = false;
    runs[0].cb.jump(7.05);
    expect(h.video.seeks.at(-1)).toBe(7.05);
    expect(h.P.osdShown).toBe(false);
  });

  it('stream info without codecs: empty codec names, the audio stream still the default audio', async () => {
    const h = await trailer();
    runs[0].cb.onInfo({ duration: 60 });
    expect(h.P.source.MediaStreams).toEqual([
      { Type: 'Video', Index: 0, Codec: '', Width: undefined, Height: undefined, VideoRangeType: 'SDR' },
      { Type: 'Audio', Index: 1, Codec: '', IsDefault: true }
    ]);
    runs[0].cb.onInfo({ codecs: 'vp09.00.40.08,ec-3', duration: 60, width: 1920, height: 1080 });
    expect(h.player.osdTechSummary()).toBe('1080p · DD+');
  });

  it('subtitles delivered twice replace each other (one subtitle stream)', async () => {
    const h = await trailer();
    runs[0].cb.onInfo({ codecs: 'avc1.640028,mp4a.40.2', duration: 60 });
    runs[0].cb.onSubs('WEBVTT\n', { kind: 'auto' });
    runs[0].cb.onSubs('WEBVTT\n', { kind: 'manual' });
    const subs = h.P.source.MediaStreams.filter((m) => m.Type === 'Subtitle');
    expect(subs).toHaveLength(1);
    expect(subs[0].Title).toBe('');
    expect(h.P.source.MediaStreams.map((m) => m.Type)).toEqual(['Video', 'Audio', 'Subtitle']);
  });

  it("an earlier trailer's late subtitles do not land on the next one", async () => {
    const h = await trailer();
    h.player.exitPlayer();
    h.player.playTrailerStream({ id: 'zz12345678x' });
    runs[1].cb.onInfo({ codecs: 'avc1.640028,mp4a.40.2', duration: 60 });
    runs[0].cb.onSubs('WEBVTT\n', { kind: 'manual' });
    expect(h.P.subIndex).toBe(-1);
    expect(h.P.source.MediaStreams.some((m) => m.Type === 'Subtitle')).toBe(false);
  });

  it('subtitles turned off and on again show again after a Retry (the track is attached)', async () => {
    const h = await trailer();
    const info = { codecs: 'avc1.640028,mp4a.40.2', duration: 60 };
    runs[0].cb.onInfo(info);
    runs[0].cb.onSubs('WEBVTT\n', { kind: 'manual' });
    await h.settle();
    h.player.pmSetSub(-1);
    await h.settle();
    h.player.pmSetSub(2);
    await h.settle();
    h.video.fail(2, '');
    h.player.retryPlayback();
    expect(h.video.querySelectorAll('track')).toHaveLength(0);
    runs[1].cb.onInfo(info);
    runs[1].cb.onSubs('WEBVTT\n', { kind: 'manual' });
    await h.settle();
    expect(h.video.querySelectorAll('track')).toHaveLength(1);
  });

  it('a feeder failure with no onFail hook still closes the trailer', async () => {
    const h = await trailer();
    expect(() => runs[0].cb.onFail(new Error('gone'))).not.toThrow();
    expect(h.P.trailer).toBe(false);
    expect(h.S.screen).not.toBe('player');
  });

  it(__PHONE__ ? 'phone: a managed trailer source turns remote playback off' : 'TV: remote playback is left alone', async () => {
    const h = await trailer({ managed: true });
    if (__PHONE__) expect(h.video.disableRemotePlayback).toBe(true);
    else expect(Object.prototype.hasOwnProperty.call(h.video, 'disableRemotePlayback')).toBe(false);
  });
});

describe('the first-frame handlers', () => {
  beforeAll(warmPlayer, 120000);

  it(__PHONE__ ? 'phone: play() is kicked right after load(), before any metadata (Low Power Mode)' : 'TV: nothing plays before the metadata', async () => {
    const h = await startPlayer({ reach: 'src' });
    const i = h.video.calls.findIndex((c) => c[0] === 'src');
    expect(h.video.calls.slice(i)).toEqual(__PHONE__ ? [['src', h.video.src], ['load'], ['play']] : [['src', h.video.src], ['load']]);
  });

  it('the metadata takes the ring down before the first frame', async () => {
    const h = await startPlayer({ reach: 'metadata' });
    expect(h.P.spinner).toBe(false);
    expect(h.P.loading).toBe(true);
  });

  it('a resume point of exactly 1 s is not sought to (only more than 1 s)', async () => {
    const h = await startPlayer({ reach: 'metadata', resumeSec: 1 });
    expect(h.video.seeks).toEqual([]);
    const g = await startPlayer({ reach: 'metadata', resumeSec: 2 });
    expect(g.video.seeks).toEqual([2]);
  });

  it('a second loadedmetadata of the same start does not un-pause what the user paused', async () => {
    const h = await startPlayer();
    h.video.pause();
    const plays = h.video.calls.filter((c) => c[0] === 'play').length;
    h.video.emit('loadedmetadata');
    await h.settle();
    expect(h.video.calls.filter((c) => c[0] === 'play')).toHaveLength(plays);
    expect(h.video.paused).toBe(true);
  });

  it("a later 'playing' (after a pause) is not a new start: one Sessions/Playing report", async () => {
    const h = await startPlayer();
    await h.settle();
    h.video.pause();
    h.video.play();
    await h.settle();
    expect(h.net.callsTo('/Sessions/Playing', 'POST')).toHaveLength(1);
  });

  it('TV: the first frame puts focus on Play', async () => {
    const h = await startPlayer({ reach: 'metadata' });
    const play = layerButton('c-play');
    h.video.setReadyState(4);
    await h.settle();
    if (!__PHONE__) expect(document.activeElement).toBe(play);
    expect(h.P.loading).toBe(false);
  });

  it('TV: with a Skip chip already up at the first frame, Play does not take focus from it', async () => {
    const h = await startPlayer({ reach: 'metadata', segments: [segment('Intro', 0, 60)] });
    await h.settle();
    const play = layerButton('c-play');
    const chip = layerButton('skip-intro');
    chip.focus();
    h.video.setReadyState(4);
    await h.settle();
    expect(h.player.skipVisible()).toMatchObject({ kind: 'intro' });
    expect(document.activeElement).toBe(chip);
    expect(document.activeElement).not.toBe(play);
  });
});

describe('the last good position (what Retry resumes from)', () => {
  beforeAll(warmPlayer, 120000);

  it('a timeupdate inside the seek window does not move it (the target is not a played position)', async () => {
    const h = await startPlayer();
    await h.clock.tick(1000);
    at(h, 100);
    h.player.seekTo(2000);
    at(h, 0);   // a garbage read inside the window
    h.video.fail(2, '');
    h.player.retryPlayback();
    expect(h.P.loadingFrom).toBe(100);
  });

  it('a playhead reading 0 outside the seek window does not move it either', async () => {
    const h = await startPlayer({ resumeSec: 900 });
    await h.clock.tick(1000);
    at(h, 0);
    h.video.fail(2, '');
    h.player.retryPlayback();
    expect(h.P.loadingFrom).toBe(900);
  });
});

describe('the OSD-hidden mirror with two skip windows', () => {
  beforeAll(warmPlayer, 120000);

  it('near either window is enough (a recap far away does not stop the intro’s mirror)', async () => {
    const h = await startPlayer();
    await h.settle();
    h.P.skips = [
      { kind: 'recap', start: 0, end: 30, from: 'introdb' },
      { kind: 'intro', start: 600, end: 690, from: 'segment' }
    ];
    h.player.hideOsd();
    await h.clock.tick(5000);
    at(h, 400);   // heartbeat: mirrored
    at(h, 596);   // near the intro only
    expect(h.P.pos).toBe(596);
  });
});

describe('Up Next: the next episode is warmed once per approach', () => {
  beforeAll(warmPlayer, 120000);

  async function binge(storage) {
    const next = episode({ IndexNumber: 2 });
    const h = await startPlayer({
      item: episode({ IndexNumber: 1 }),
      next,
      segments: [segment('Outro', 2500, 2690)],
      storage,
      routes: (net) => net.on('POST', '/Items/' + next.Id + '/PlaybackInfo', playbackInfo(next.MediaSources[0], { PlaySessionId: 'ps-next' }))
    });
    await h.settle();
    await h.clock.tick(1000);
    return Object.assign(h, { gets: () => h.net.callsTo('/Items/' + next.Id, 'GET').length });
  }

  it('leaving the window and coming back after the warm expired warms again', async () => {
    const h = await binge();
    at(h, 2496);
    await h.settle();
    expect(h.gets()).toBe(1);
    at(h, 2300);   // seeked back out of the window
    await h.clock.tick(31000);   // the parked warm is stale by now
    at(h, 2496);
    await h.settle();
    expect(h.gets()).toBe(2);
  });

  it('staying inside the window past the warm’s lifetime does not warm again', async () => {
    const h = await binge({ 'reel.settings': JSON.stringify({ autoplayNext: false }) });
    at(h, 2496);
    await h.settle();
    await h.clock.tick(31000);
    at(h, 2497);
    at(h, 2498);
    await h.settle();
    expect(h.gets()).toBe(1);
  });
});

describe("'play' without 'playing' yet", () => {
  beforeAll(warmPlayer, 120000);

  it('un-pauses the slice at once (Play pressed while the element still buffers)', async () => {
    const h = await startPlayer();
    h.video.pause();
    expect(h.P.paused).toBe(true);
    h.video.setReadyState(2);   // not enough data: 'play' now, 'playing' later
    h.video.play();
    expect(h.P.paused).toBe(false);
  });
});
