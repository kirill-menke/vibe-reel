/* player.svelte.js — the streams that are not a Jellyfin item: pending
 * downloads (playPendingStream), trailers (playTrailerStream), the phone's
 * MediaSource-fed streams (playFeedStream / checkpointFeed) and the phone's
 * streaming quality cap (getQualityCap / setQualityCap / pmSetQuality).
 *
 * CLAUDE.md:
 * - Watch while downloading: "the same <video> DirectPlay pipeline with
 *   P.pending = true gating off everything Jellyfin-specific: progress reports,
 *   intro lookup, subtitle fetch …, and exit navigation (returns to the
 *   pending/detail screen instead of a Jellyfin item)".
 * - "an `ended` more than 60 s short of the probed runtime is the 'download
 *   stopped here' card with Retry at that position, and any non-decode `error`
 *   is 'the download stream broke off'".
 * - Trailers: "Trailer mode = P.pending + P.trailer … exit does not remount the
 *   page — it restores the P fields the page had seeded and refocuses the
 *   Trailer button. Any failure … toasts and falls back to the YouTube app".
 * - Phone offline copies: "the position is checkpointed into the index on every
 *   pause and on backgrounding (checkpointFeed()), never from a close before the
 *   first frame (restartPos() + feedRun.started)".
 * - Streaming quality (Settings + the player's Quality picker; Original / 8 / 4
 *   Mbit/s, per device).
 *
 * The trailer feeder (trailerstream.js) has its own suite; here it is replaced
 * by a stub so the test drives its onInfo / onSubs / onFail callbacks. */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import { warmPlayer, startPlayer } from '../helpers/player.js';
import { freshImport } from '../helpers/modules.js';
import { useClock } from '../helpers/time.js';
import { mockFetch } from '../helpers/fetch.js';
import { fakeVideo } from '../helpers/video.js';
import { movie, source, video as vstream, audio, sub } from '../helpers/media.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TRAILERSTREAM = path.resolve(ROOT, 'src/lib/trailerstream.js');
const TICKS = 10000000;
const URL_PENDING = 'http://ml.test/api/downloads/abc/stream';

/** A fresh player graph with nothing playing: the detail page's view of it. */
async function boot({ storage } = {}) {
  const m = await freshImport({
    storage: storage || {},
    modules: {
      player: 'src/lib/player.svelte.js',
      nav: 'src/lib/nav.svelte.js',
      toast: 'src/lib/toast.svelte.js',
      trailer: 'src/lib/trailer.js'
    }
  });
  const clock = useClock();
  const net = mockFetch();
  const video = fakeVideo();
  m.player.setVideoEl(video);
  return { ...m, P: m.player.P, S: m.nav.S, clock, net, video, settle: () => clock.flush() };
}

/** the stream delivers its first frame */
async function firstFrame(h, dur) {
  h.video.setDuration(dur);
  h.video.setReadyState(1);
  h.video.emit('loadedmetadata');
  await h.settle();
  h.video.setReadyState(4);
  await h.settle();
}

function at(h, t) {
  h.video.setTime(t);
  h.video.emit('timeupdate');
}

const pendingSource = (sec = 3600) => source([vstream(), audio({ Codec: 'eac3', Language: 'eng' }), audio({ Codec: 'aac', Language: 'deu' })], { RunTimeTicks: sec * TICKS });

/* ------------------------------------------------------------------------ */

describe('playPendingStream: a download in flight, DirectPlay over the Range URL', () => {
  beforeAll(warmPlayer, 120000);

  it('sets the pending slice: no Jellyfin item, no session, subs off, the default audio', async () => {
    const h = await boot();
    const src = pendingSource();
    const item = movie({ Name: 'Pending film', MediaSources: [src] });
    h.player.playPendingStream({ url: URL_PENDING, item, source: src, downloadId: 'abc' });
    expect(h.P.pending).toBe(true);
    expect(h.P.downloadId).toBe('abc');
    expect(h.P.item).toEqual({ Id: null, Name: 'Pending film' });
    expect(h.P.detailItem).toEqual(item);
    expect(h.P.sessionId).toBe('');
    expect(h.P.subIndex).toBe(-1);
    expect(h.P.audioIndex).toBe(1);   // describeTracks' default: the E-AC3 track
    expect(h.P.playMethod).toBe('DirectPlay');
    expect(h.S.screen).toBe('player');
    expect(h.video.src).toBe(URL_PENDING);
  });

  it('no downloadId is null, not undefined', async () => {
    const h = await boot();
    const src = pendingSource();
    h.player.playPendingStream({ url: URL_PENDING, item: movie({ MediaSources: [src] }), source: src });
    expect(h.P.downloadId).toBeNull();
  });

  it('asks Jellyfin nothing: no markers, no trickplay, no subtitles, no reports — start to exit', async () => {
    const h = await boot();
    const src = pendingSource();
    h.player.playPendingStream({ url: URL_PENDING, item: movie({ MediaSources: [src] }), source: src, downloadId: 'abc' });
    await firstFrame(h, 3600);
    expect(h.P.loading).toBe(false);
    for (let i = 0; i < 30; i++) {
      h.video.advance(1);
      await h.clock.tick(1000);
    }
    h.video.pause();
    h.player.exitPlayer();
    await h.settle();
    expect(h.net.calls).toEqual([]);
    expect(h.P.skips).toEqual([]);
    expect(h.P.trick).toBeNull();
    expect(h.P.next).toBeNull();
  });

  it('exit returns to PendingDetail it was started from, and clears P.pending', async () => {
    const h = await boot();
    h.nav.openPending('grp-1');
    const src = pendingSource();
    h.player.playPendingStream({ url: URL_PENDING, item: movie({ MediaSources: [src] }), source: src, downloadId: 'abc' });
    await firstFrame(h, 3600);
    h.player.exitPlayer();
    expect(h.P.pending).toBe(false);
    expect(h.S.screen).toBe('pending');
    expect(h.S.pendingKey).toBe('grp-1');
  });

  it('exit returns to the LookupDetail it was started from', async () => {
    const h = await boot();
    const look = { title: 'Some Film', year: 2024, tmdbId: 77 };
    h.nav.openLookup(look);
    const src = pendingSource();
    h.player.playPendingStream({ url: URL_PENDING, item: movie({ MediaSources: [src] }), source: src });
    await firstFrame(h, 3600);
    h.player.exitPlayer();
    expect(h.S.screen).toBe('lookup');
    expect(h.S.lookup).toEqual(look);
  });

  it('exit from a pending stream started on a detail page returns to that page (not the synthetic item)', async () => {
    const h = await boot();
    h.nav.openItem('series-9', 'Series');
    const src = pendingSource();
    h.player.playPendingStream({ url: URL_PENDING, item: movie({ Id: 'synthetic', MediaSources: [src] }), source: src });
    await firstFrame(h, 3600);
    h.player.exitPlayer();
    expect(h.S.screen).toBe('detail');
    expect(h.S.detailId).toBe('series-9');
  });

  it('suspendPlayback() (Home button / closing the card) exits it the same way', async () => {
    const h = await boot();
    h.nav.openPending('grp-2');
    const src = pendingSource();
    h.player.playPendingStream({ url: URL_PENDING, item: movie({ MediaSources: [src] }), source: src });
    await firstFrame(h, 3600);
    h.player.suspendPlayback();
    expect(h.S.screen).toBe('pending');
    expect(h.net.calls).toEqual([]);
  });
});

describe("pending: 'ended' short of the probed runtime is the download stopping", () => {
  beforeAll(warmPlayer, 120000);

  async function pendingAt(t, { runtime = 3600, dur = runtime } = {}) {
    const h = await boot();
    h.nav.openPending('grp-1');
    const src = pendingSource(runtime);
    h.player.playPendingStream({ url: URL_PENDING, item: movie({ MediaSources: [src] }), source: src, downloadId: 'abc' });
    await firstFrame(h, dur);
    at(h, t);
    return h;
  }

  it('ended 1000 s into a 1 h file: the "download stopped here" card, not an exit', async () => {
    const h = await pendingAt(1000);
    h.video.end();
    expect(h.S.screen).toBe('player');
    expect(h.P.error.title).toBe('The download stopped here');
    expect(h.P.error.detail).toContain('The stream ended at 16:40 of 1:00:00');
  });

  it('Retry restarts the same URL at the position it stopped at', async () => {
    const h = await pendingAt(1000);
    h.video.end();
    h.player.retryPlayback();
    expect(h.P.error).toBeNull();
    expect(h.P.loading).toBe(true);
    expect(h.P.loadingFrom).toBe(1000);
    expect(h.video.calls.filter((c) => c[0] === 'src').map((c) => c[1])).toEqual([URL_PENDING, URL_PENDING]);
    h.video.setReadyState(1);
    h.video.emit('loadedmetadata');
    expect(h.video.seeks).toContain(1000);
  });

  it('the 60 s line: 61 s short is the card, 59 s short is a normal end (exit)', async () => {
    const a = await pendingAt(3600 - 61);
    a.video.end();
    expect(a.P.error && a.P.error.title).toBe('The download stopped here');

    const b = await pendingAt(3600 - 59);
    b.video.end();
    expect(b.P.error).toBeNull();
    expect(b.S.screen).toBe('pending');
  });

  it('the probed runtime counts even when the element reports a shorter duration (the growing file)', async () => {
    const h = await pendingAt(500, { runtime: 3600, dur: 520 });
    h.video.end();
    expect(h.P.error.title).toBe('The download stopped here');
    expect(h.P.error.detail).toContain('of 1:00:00');
  });

  it('a file of 2 min or less never gets the card', async () => {
    const h = await pendingAt(10, { runtime: 120 });
    h.video.end();
    expect(h.P.error).toBeNull();
    expect(h.S.screen).toBe('pending');
  });

  it('a non-decode error is "the download stream broke off" (codes 1, 2, 4 and none)', async () => {
    for (const code of [1, 2, 4, 0]) {
      const h = await pendingAt(100);
      h.video.fail(code, '');
      expect(h.P.error.title, 'code ' + code).toBe('The download stream broke off');
      expect(h.P.error.detail).toMatch(/download may have stalled/);
    }
  });

  it('a decode error (3) keeps the decoder wording — that one is the device', async () => {
    const h = await pendingAt(100);
    h.video.fail(3, 'bad frame');
    expect(h.P.error.title).toBe(__PHONE__ ? 'The iPhone couldn’t decode this video' : 'The TV couldn’t decode this video');
    expect(h.P.error.detail).toContain('(bad frame)');
  });

  it('a library item failing with code 2 keeps the device wording (contrast)', async () => {
    const h = await startPlayer();
    h.video.fail(2, '');
    expect(h.P.error.title).toBe('Lost the connection to the server');
  });
});

/* ------------------------------------------------------------------------ */

describe('playTrailerStream: a trailer over the page it was started from', () => {
  beforeAll(warmPlayer, 120000);

  let runs;
  function stubFeeder() {
    runs = [];
    vi.doMock(TRAILERSTREAM, () => ({
      createTrailerSource: (id, cb) => {
        const r = { id, cb, url: 'blob:trailer-' + (runs.length + 1), managed: false, stop: vi.fn() };
        runs.push(r);
        return r;
      }
    }));
  }
  afterEach(() => {
    vi.doUnmock(TRAILERSTREAM);
    document.body.innerHTML = '';
  });

  /** a detail page with its Trailer button focused and the P fields it seeds */
  async function detailPage() {
    stubFeeder();
    const h = await boot();
    h.nav.openItem('m1', 'Movie');
    const btn = document.createElement('button');
    btn.className = 'focus';
    btn.dataset.focus = 'd-trailer';
    document.body.append(btn);
    btn.focus();
    const src = source([vstream(), audio({ Codec: 'truehd' }), audio({ Codec: 'eac3' }), sub({ Codec: 'srt' })]);
    const seeded = {
      detailItem: movie({ Id: 'm1', MediaSources: [src] }),
      item: { Id: 'm1', Name: 'Film' },
      source: src,
      series: null,
      audioIndex: 2,
      subIndex: 3,
      subOffset: 0.5,
      sessionId: '',
      playMethod: 'DirectPlay'
    };
    Object.assign(h.P, seeded);
    return { h, btn, seeded };
  }

  it('raises the player in trailer mode with the title and backdrop on the loading card', async () => {
    const { h } = await detailPage();
    h.player.playTrailerStream({ id: 'yt12345678x', title: 'Dune: Part Two', art: 'http://jf.test/b.jpg', onFail: vi.fn() });
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe('yt12345678x');
    expect(h.P.trailer).toBe(true);
    expect(h.P.pending).toBe(true);
    expect(h.P.downloadId).toBeNull();
    expect(h.P.detailItem).toEqual({ Id: null, Name: 'Dune: Part Two', _art: 'http://jf.test/b.jpg', _sub: 'Trailer' });
    expect(h.P.item).toEqual({ Id: null, Name: 'Dune: Part Two' });
    expect(h.P.source).toBeNull();
    expect(h.P.audioIndex).toBe(-1);
    expect(h.P.subIndex).toBe(-1);
    expect(h.S.screen).toBe('player');
    expect(h.video.src).toBe('blob:trailer-1');
  });

  it("no title: 'Trailer'; no art: null", async () => {
    const { h } = await detailPage();
    h.player.playTrailerStream({ id: 'yt12345678x' });
    expect(h.P.detailItem).toEqual({ Id: null, Name: 'Trailer', _art: null, _sub: 'Trailer' });
  });

  it('onInfo builds the OSD source from the RFC 6381 codecs (E-AC-3, AC-3, AAC mapped)', async () => {
    const { h } = await detailPage();
    h.player.playTrailerStream({ id: 'yt12345678x', title: 'T' });
    const cases = [['ec-3', 'eac3'], ['ac-3', 'ac3'], ['mp4a.40.2', 'aac'], ['opus', 'opus']];
    for (const [rfc, codec] of cases) {
      runs[0].cb.onInfo({ codecs: 'av01.0.12M.10,' + rfc, duration: 150.5, width: 3840, height: 2160, hdr: 'HDR10' });
      expect(h.P.source.MediaStreams[1].Codec).toBe(codec);
    }
    expect(h.P.source.Id).toBe('trailer');
    expect(h.P.source.RunTimeTicks).toBe(150.5 * TICKS);
    expect(h.P.source.MediaStreams[0]).toMatchObject({ Type: 'Video', Codec: 'av01', Width: 3840, Height: 2160, VideoRangeType: 'HDR10' });
    expect(h.P.audioIndex).toBe(1);
    runs[0].cb.onInfo({ codecs: 'avc1.640028,mp4a.40.2', duration: 90, width: 1920, height: 1080 });
    expect(h.P.source.MediaStreams[0].VideoRangeType).toBe('SDR');
  });

  it('English subtitles are on by default and need no Jellyfin request (the VTT text comes with them)', async () => {
    const { h } = await detailPage();
    h.player.playTrailerStream({ id: 'yt12345678x', title: 'T' });
    runs[0].cb.onInfo({ codecs: 'avc1.640028,mp4a.40.2', duration: 90, width: 1920, height: 1080 });
    runs[0].cb.onSubs('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n', { kind: 'auto' });
    await h.settle();
    expect(h.P.subIndex).toBe(2);
    expect(h.P.source.MediaStreams[2]).toMatchObject({ Type: 'Subtitle', Codec: 'webvtt', Language: 'eng', Title: 'Auto-generated' });
    expect(h.video.querySelectorAll('track')).toHaveLength(1);
    expect(h.net.calls).toEqual([]);
  });

  it('subtitles switched off stay off across a Retry (a fresh source re-delivers them); back on, they show again', async () => {
    const { h } = await detailPage();
    h.player.playTrailerStream({ id: 'yt12345678x', title: 'T' });
    const info = { codecs: 'avc1.640028,mp4a.40.2', duration: 90, width: 1920, height: 1080 };
    runs[0].cb.onInfo(info);
    runs[0].cb.onSubs('WEBVTT\n', { kind: 'manual' });
    expect(h.P.subIndex).toBe(2);
    h.player.pmSetSub(-1);
    expect(h.P.subIndex).toBe(-1);
    h.video.fail(2, '');
    h.player.retryPlayback();
    runs[1].cb.onInfo(info);
    runs[1].cb.onSubs('WEBVTT\n', { kind: 'manual' });
    expect(h.P.subIndex).toBe(-1);
    expect(h.P.source.MediaStreams[2]).toMatchObject({ Type: 'Subtitle', Title: '' });   // still offered in the menu
    h.player.pmSetSub(2);
    h.video.fail(2, '');
    h.player.retryPlayback();
    runs[2].cb.onInfo(info);
    runs[2].cb.onSubs('WEBVTT\n', { kind: 'translated' });
    expect(h.P.subIndex).toBe(2);
    expect(h.P.source.MediaStreams[2].Title).toBe('Auto-translated');
    expect(h.net.calls).toEqual([]);   // no Progress reports for a trailer either
  });

  it('subtitles before the stream info are dropped (nothing to hang them on)', async () => {
    const { h } = await detailPage();
    h.player.playTrailerStream({ id: 'yt12345678x', title: 'T' });
    runs[0].cb.onSubs('WEBVTT\n', { kind: 'manual' });
    expect(h.P.source).toBeNull();
    expect(h.P.subIndex).toBe(-1);
  });

  it('exit restores every P field the page had seeded and lowers the player onto the page — no remount', async () => {
    const { h, seeded } = await detailPage();
    const epoch = h.S.epoch;
    h.player.playTrailerStream({ id: 'yt12345678x', title: 'T' });
    await firstFrame(h, 120);
    runs[0].cb.onInfo({ codecs: 'avc1.640028,mp4a.40.2', duration: 120, width: 1920, height: 1080 });
    h.player.exitPlayer();
    expect(runs[0].stop).toHaveBeenCalled();
    expect(h.P.trailer).toBe(false);
    expect(h.P.pending).toBe(false);
    for (const k of Object.keys(seeded)) expect(h.P[k], k).toEqual(seeded[k]);
    expect(h.S.screen).toBe('detail');
    expect(h.S.detailId).toBe('m1');
    expect(h.S.epoch).toBe(epoch);
    expect(h.net.calls).toEqual([]);
  });

  it('exit refocuses the Trailer button (TV; the phone has no D-pad focus)', async () => {
    const { h, btn } = await detailPage();
    h.player.playTrailerStream({ id: 'yt12345678x', title: 'T' });
    btn.blur();
    expect(document.activeElement).not.toBe(btn);
    h.player.exitPlayer();
    await h.settle();
    expect(document.activeElement === btn).toBe(!__PHONE__);
  });

  it('the trailer playing to its end exits the same way', async () => {
    const { h, seeded } = await detailPage();
    h.player.playTrailerStream({ id: 'yt12345678x', title: 'T' });
    await firstFrame(h, 120);
    at(h, 30);   // far short of its end: still no "download stopped" card for a trailer
    h.video.end();
    expect(h.P.error).toBeNull();
    expect(h.P.trailer).toBe(false);
    expect(h.P.source).toEqual(seeded.source);
    expect(h.S.screen).toBe('detail');
  });

  it("a media error is 'The trailer stopped'; Retry builds a fresh source at the last position", async () => {
    const { h } = await detailPage();
    h.player.playTrailerStream({ id: 'yt12345678x', title: 'T' });
    await firstFrame(h, 120);
    at(h, 42);
    h.video.fail(2, '');
    expect(h.P.error.title).toBe('The trailer stopped');
    h.player.retryPlayback();
    expect(runs).toHaveLength(2);
    expect(runs[0].stop).toHaveBeenCalled();
    expect(h.video.src).toBe('blob:trailer-2');
    expect(h.P.loadingFrom).toBe(42);
  });

  it('a feeder failure exits (page restored) and then hands the error to onFail', async () => {
    const { h, seeded } = await detailPage();
    const onFail = vi.fn(() => {
      // by the time the fallback runs, the page is back
      expect(h.P.trailer).toBe(false);
      expect(h.S.screen).toBe('detail');
    });
    h.player.playTrailerStream({ id: 'yt12345678x', title: 'T', onFail });
    const err = new Error('yt-dlp failed');
    runs[0].cb.onFail(err);
    expect(onFail).toHaveBeenCalledWith(err);
    expect(h.P.audioIndex).toBe(seeded.audioIndex);
  });

  it('a late failure of an earlier trailer is ignored', async () => {
    const { h } = await detailPage();
    const first = vi.fn();
    h.player.playTrailerStream({ id: 'aaaaaaaaaaa', title: 'A', onFail: first });
    h.player.exitPlayer();
    const second = vi.fn();
    h.player.playTrailerStream({ id: 'bbbbbbbbbbb', title: 'B', onFail: second });
    runs[0].cb.onFail(new Error('late'));
    runs[0].cb.onInfo({ codecs: 'avc1,mp4a', duration: 1 });
    expect(first).not.toHaveBeenCalled();
    expect(h.P.trailer).toBe(true);
    expect(h.P.source).toBeNull();
  });

  it('openTrailer (trailer.js) end to end: a failure toasts the reason and falls back to YouTube', async () => {
    const { h } = await detailPage();
    const open = vi.fn(() => ({}));
    vi.stubGlobal('open', open);
    h.trailer.openTrailer('yt12345678x', { title: 'T' });
    expect(h.P.trailer).toBe(true);
    runs[0].cb.onFail(new Error('yt-dlp failed'));
    await h.settle();
    expect(h.toast.toastState.msg).toBe('Couldn’t load the trailer here (yt-dlp failed) — opening YouTube');
    expect(open).toHaveBeenCalledWith('https://www.youtube.com/watch?v=yt12345678x', '_blank');
    expect(h.S.screen).toBe('detail');
  });
});

/* ------------------------------------------------------------------------ */

describe('playFeedStream / checkpointFeed — ' + (__PHONE__ ? 'phone: MediaSource-fed streams' : 'TV: not built in'), () => {
  beforeAll(warmPlayer, 120000);

  function feedOpts(extra = {}) {
    const feeders = [];
    const o = {
      item: movie({ Name: 'Offline film' }),
      source: pendingSource(),
      open: vi.fn((args) => {
        const f = { url: 'blob:feed-' + (feeders.length + 1), managed: true, stop: vi.fn(), args };
        feeders.push(f);
        return f;
      }),
      exit: vi.fn(),
      checkpoint: vi.fn(),
      ...extra
    };
    return { o, feeders };
  }

  it(__PHONE__ ? 'starts a fresh feeder and plays its blob URL as a pending stream' : 'is a no-op', async () => {
    const h = await boot();
    const { o, feeders } = feedOpts({ downloadId: 'abc', start: 120 });
    h.player.playFeedStream(o);
    if (!__PHONE__) {
      expect(o.open).not.toHaveBeenCalled();
      expect(h.P.pending).toBe(false);
      expect(h.S.screen).not.toBe('player');
      return;
    }
    expect(feeders).toHaveLength(1);
    expect(feeders[0].args.audioIndex).toBe(1);
    expect(h.P.pending).toBe(true);
    expect(h.P.downloadId).toBe('abc');
    expect(h.P.loadingFrom).toBe(120);
    expect(h.video.src).toBe('blob:feed-1');
    expect(h.video.disableRemotePlayback).toBe(true);   // a ManagedMediaSource refuses to attach otherwise
  });

  it('checkpointFeed (TV: never)', async () => {
    const h = await boot();
    const { o } = feedOpts({ start: 300 });
    h.player.playFeedStream(o);
    h.player.checkpointFeed();
    expect(o.checkpoint).not.toHaveBeenCalled();   // no frame yet: 300 is only where the start was asked for
    if (!__PHONE__) return;
    await firstFrame(h, 3600);
    at(h, 1234);
    h.player.checkpointFeed();
    expect(o.checkpoint).toHaveBeenLastCalledWith(1234, 3600);
  });

  if (__PHONE__) {
    it('every pause checkpoints the position (iOS kills a suspended app without pagehide)', async () => {
      const h = await boot();
      const { o } = feedOpts();
      h.player.playFeedStream(o);
      await firstFrame(h, 3600);
      at(h, 500);
      h.video.pause();
      expect(o.checkpoint).toHaveBeenCalledWith(500, 3600);
      expect(h.net.calls).toEqual([]);   // an offline copy reports nothing to Jellyfin
    });

    it('a pause before the first frame does not checkpoint', async () => {
      const h = await boot();
      const { o } = feedOpts({ start: 300 });
      h.player.playFeedStream(o);
      h.video.pause();
      expect(o.checkpoint).not.toHaveBeenCalled();
    });

    it('not in the player any more: no checkpoint', async () => {
      const h = await boot();
      const { o } = feedOpts();
      h.player.playFeedStream(o);
      await firstFrame(h, 3600);
      at(h, 500);
      h.S.screen = h.S.base;
      h.player.checkpointFeed();
      expect(o.checkpoint).not.toHaveBeenCalled();
    });

    it('exit hands (pos, dur, started) to the exit hook, stops the feeder and lowers the player', async () => {
      const h = await boot();
      const { o, feeders } = feedOpts();
      h.player.playFeedStream(o);
      await firstFrame(h, 3600);
      at(h, 2000);
      h.player.exitPlayer();
      expect(o.exit).toHaveBeenCalledWith(2000, 3600, true);
      expect(feeders[0].stop).toHaveBeenCalled();
      expect(h.P.pending).toBe(false);
      expect(h.S.screen).not.toBe('player');
    });

    it('exit on the loading card: started = false and the position is the start asked for, not 0', async () => {
      const h = await boot();
      const { o } = feedOpts({ start: 777 });
      h.player.playFeedStream(o);
      h.player.exitPlayer();
      expect(o.exit).toHaveBeenCalledWith(777, expect.anything(), false);
    });

    it('no exit hook (a pending download): exit is the pending stream’s — back to PendingDetail', async () => {
      const h = await boot();
      h.nav.openPending('grp-3');
      const { o, feeders } = feedOpts({ exit: undefined, downloadId: 'abc' });
      h.player.playFeedStream(o);
      await firstFrame(h, 3600);
      h.player.exitPlayer();
      expect(feeders[0].stop).toHaveBeenCalled();
      expect(h.S.screen).toBe('pending');
      expect(h.S.pendingKey).toBe('grp-3');
    });

    it('feeder failures: unsupported / download broke off / offline copy unplayable — Retry opens a fresh feeder', async () => {
      const cases = [
        [{ downloadId: 'abc' }, { code: 'unsupported', message: 'no hvc1' }, 'This iPhone can’t play this file'],
        [{ downloadId: 'abc' }, { message: 'HTTP 502' }, 'The download stream broke off'],
        [{}, null, 'This download can’t be played']
      ];
      for (const [extra, err, title] of cases) {
        const h = await boot();
        const { o, feeders } = feedOpts(extra);
        h.player.playFeedStream(o);
        await firstFrame(h, 3600);
        at(h, 900);
        feeders[0].args.onFail(err);
        expect(h.P.error.title).toBe(title);
        expect(h.P.error.detail).toBe((err && err.message) || '');
        h.player.retryPlayback();
        expect(feeders).toHaveLength(2);
        expect(feeders[0].stop).toHaveBeenCalled();
        expect(h.video.src).toBe('blob:feed-2');
        expect(h.P.loadingFrom).toBe(900);
      }
    });

    it("a stale feeder's failure (after a restart or exit) raises no card", async () => {
      const h = await boot();
      const { o, feeders } = feedOpts();
      h.player.playFeedStream(o);
      await firstFrame(h, 3600);
      h.player.retryPlayback();
      feeders[0].args.onFail({ message: 'old' });
      expect(h.P.error).toBeNull();
      h.player.exitPlayer();
      feeders[1].args.onFail({ message: 'after exit' });
      expect(h.P.error).toBeNull();
    });

    it('a second playFeedStream stops the first feeder', async () => {
      const h = await boot();
      const a = feedOpts();
      h.player.playFeedStream(a.o);
      const b = feedOpts();
      h.player.playFeedStream(b.o);
      expect(a.feeders[0].stop).toHaveBeenCalled();
      expect(h.video.src).toBe('blob:feed-1');   // b's first feeder
      expect(b.o.open).toHaveBeenCalledTimes(1);
    });

    it('audioIndex / subIndex given win over the defaults', async () => {
      const h = await boot();
      const { o, feeders } = feedOpts({ audioIndex: 2, subIndex: -1 });
      h.player.playFeedStream(o);
      expect(h.P.audioIndex).toBe(2);
      expect(feeders[0].args.audioIndex).toBe(2);
    });
  }
});

/* ------------------------------------------------------------------------ */

describe('streaming quality cap (per device: reel.qualityCellular)', () => {
  beforeAll(warmPlayer, 120000);

  it('Original by default; 8 / 4 Mbit/s persist; Original removes the key', async () => {
    const h = await boot();
    expect(h.player.QUALITY_CAPS).toEqual(['original', 8000000, 4000000]);
    expect(h.player.getQualityCap()).toBe('original');
    h.player.setQualityCap(8000000);
    expect(localStorage.getItem('reel.qualityCellular')).toBe('8000000');
    expect(h.player.getQualityCap()).toBe(8000000);
    h.player.setQualityCap(4000000);
    expect(h.player.getQualityCap()).toBe(4000000);
    h.player.setQualityCap('original');
    expect(localStorage.getItem('reel.qualityCellular')).toBeNull();
    expect(h.player.getQualityCap()).toBe('original');
  });

  it('survives a restart (read from the store each time)', async () => {
    const h = await boot({ storage: { 'reel.qualityCellular': '4000000' } });
    expect(h.player.getQualityCap()).toBe(4000000);
  });

  it('an unknown stored value reads as Original; an unknown value set clears the cap', async () => {
    const h = await boot({ storage: { 'reel.qualityCellular': '6000000' } });
    expect(h.player.getQualityCap()).toBe('original');
    localStorage.setItem('reel.qualityCellular', '8000000');
    h.player.setQualityCap(6000000);
    expect(localStorage.getItem('reel.qualityCellular')).toBeNull();
  });

  it('a throwing store: Original, and setting never throws', async () => {
    const h = await boot();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(h.player.getQualityCap()).toBe('original');
    expect(() => h.player.setQualityCap(8000000)).not.toThrow();
  });

  it(__PHONE__ ? 'pmSetQuality stores the cap and restarts the running item at the same position' : 'pmSetQuality is a no-op on the TV', async () => {
    const h = await startPlayer();
    at(h, 600);
    const infos = () => h.net.callsTo('/Items/' + h.id + '/PlaybackInfo', 'POST');
    h.player.pmSetQuality(8000000);
    await h.settle();
    if (!__PHONE__) {
      expect(h.player.getQualityCap()).toBe('original');
      expect(infos()).toHaveLength(1);
      return;
    }
    expect(h.player.getQualityCap()).toBe(8000000);
    expect(h.P.loadingFrom).toBe(600);
    expect(infos()).toHaveLength(2);
    expect(infos()[1].body.MaxStreamingBitrate).toBe(8000000);
    expect(infos()[1].body.StartTimeTicks).toBe(600 * TICKS);
  });

  if (__PHONE__) {
    it('pmSetQuality: the same cap again, or an unknown one, does nothing', async () => {
      const h = await startPlayer();
      const infos = () => h.net.callsTo('/Items/' + h.id + '/PlaybackInfo', 'POST');
      h.player.pmSetQuality('original');
      h.player.pmSetQuality(1234);
      await h.settle();
      expect(infos()).toHaveLength(1);
      expect(localStorage.getItem('reel.qualityCellular')).toBeNull();
    });

    it('pmSetQuality during a pending stream only stores (no PlaybackInfo to redo)', async () => {
      const h = await boot();
      const src = pendingSource();
      h.player.playPendingStream({ url: URL_PENDING, item: movie({ MediaSources: [src] }), source: src });
      h.player.pmSetQuality(4000000);
      await h.settle();
      expect(h.player.getQualityCap()).toBe(4000000);
      expect(h.net.calls).toEqual([]);
      expect(h.video.src).toBe(URL_PENDING);
    });
  }
});
