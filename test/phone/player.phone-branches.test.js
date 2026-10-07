/* The phone-only branches of the shared engine (player.svelte.js inside
 * `__PHONE__`) that the shared player suites do not reach.
 *
 * CLAUDE.md, "Streaming quality": "a file above the cap is re-encoded as H.264
 * boxed to 1080p / 720p (PHONE_CAP_BOX) …; a file under it is still copied" —
 * the player's info line / Quality picker read that as P.quality.
 * "The remux carries one audio track, so an audio switch is a restart" — and a
 * phone feed (livefeed / offline copy) "carries one audio track too: a new
 * server job for this one".
 * Picture-mode control is the TV's companion service; the phone has none. */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import path from 'node:path';
import { startPlayer, warmPlayer } from '../helpers/player.js';
import { movie, source, video as vstream, audio, playbackInfo } from '../helpers/media.js';
import { resShort } from '../../src/lib/tracks.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CAP = 'reel.qualityCellular';

/** a PlaybackInfo answer with Jellyfin's HLS remux URL carrying `query` */
function remux(src, query) {
  return playbackInfo({ ...src, SupportsDirectPlay: false, TranscodingUrl: '/videos/x/master.m3u8?MediaSourceId=' + src.Id + '&' + query }, { PlaySessionId: 'ps-1' });
}

describe('P.quality: the running stream under a cap', () => {
  beforeAll(warmPlayer, 120000);

  it('uncapped (Original): null', async () => {
    const h = await startPlayer();
    expect(h.P.quality).toBeNull();
  });

  it('8 Mbit/s and Jellyfin re-encodes (MaxWidth in the URL): a 4K file is boxed to 1080p, labelled reduced', async () => {
    const src = source([vstream({ Width: 3840, Height: 2160 }), audio()]);
    const h = await startPlayer({ item: movie({ MediaSources: [src] }), info: remux(src, 'MaxWidth=1920&VideoCodec=h264'), storage: { [CAP]: '8000000' } });
    expect(h.P.quality).toEqual({ cap: 8000000, mbit: 8, reduced: true, res: '1080p', label: '1080p · 8 Mbit/s (reduced)' });
    expect(h.P.playMethod).toBe('DirectStream');
  });

  it('4 Mbit/s: a scope 1080p file is boxed into 1280×720 (keeping its aspect), reduced by ContainerBitrateExceedsLimit alone', async () => {
    const src = source([vstream({ Width: 1920, Height: 800 }), audio()]);
    const h = await startPlayer({
      item: movie({ MediaSources: [src] }),
      info: remux(src, 'TranscodeReasons=ContainerBitrateExceedsLimit'),
      storage: { [CAP]: '4000000' }
    });
    const res = resShort(1280, 533);
    expect(h.P.quality).toEqual({ cap: 4000000, mbit: 4, reduced: true, res, label: [res, '4 Mbit/s (reduced)'].filter(Boolean).join(' · ') });
  });

  it('a file small enough is copied: "Original · fits 8 Mbit/s"', async () => {
    const src = source([vstream({ Width: 1920, Height: 1080 }), audio()]);
    const h = await startPlayer({ item: movie({ MediaSources: [src] }), info: remux(src, 'VideoCodec=hevc&AudioCodec=eac3'), storage: { [CAP]: '8000000' } });
    expect(h.P.quality).toEqual({ cap: 8000000, mbit: 8, reduced: false, res: '', label: 'Original · fits 8 Mbit/s' });
  });

  it('a progressive MP4 under a cap plays directly — never "reduced"', async () => {
    const src = source([vstream({ Width: 1920, Height: 1080 }), audio({ Codec: 'aac' })], { Container: 'mp4' });
    const h = await startPlayer({ item: movie({ MediaSources: [src] }), storage: { [CAP]: '4000000' } });
    expect(h.P.playMethod).toBe('DirectPlay');
    expect(h.P.quality.reduced).toBe(false);
  });

  it('a reduced stream with no video dimensions: label without a resolution', async () => {
    const src = source([vstream({ Width: undefined, Height: undefined }), audio()]);
    const h = await startPlayer({ item: movie({ MediaSources: [src] }), info: remux(src, 'MaxWidth=1280'), storage: { [CAP]: '4000000' } });
    expect(h.P.quality).toMatchObject({ reduced: true, res: '', label: '4 Mbit/s (reduced)' });
  });
});

describe('a start Jellyfin offers nothing playable for', () => {
  beforeAll(warmPlayer, 120000);

  it('no direct play and no remux URL: a toast in the iPhone’s words, no player', async () => {
    const src = source([vstream(), audio()]);
    const h = await startPlayer({ reach: 'request', item: movie({ MediaSources: [src] }), info: playbackInfo({ ...src, SupportsDirectPlay: false }) });
    h.release();
    await h.settle();
    await h.settle();
    const { toastState } = await import(/* @vite-ignore */ path.resolve(ROOT, 'src/lib/toast.svelte.js'));
    expect(toastState.msg).toBe('No playable source: Jellyfin offered no stream this iPhone can play for this title.');
    expect(h.video.src).toBeFalsy();
  });
});

describe('an audio switch on a phone feed restarts the feeder', () => {
  beforeAll(warmPlayer, 120000);

  it('a fresh feeder for the new track, at the same position, loading card up with the tap', async () => {
    const h = await startPlayer();
    h.player.exitPlayer();
    await h.settle();
    const feeders = [];
    const src = source([vstream(), audio({ Language: 'eng' }), audio({ Language: 'deu' })], { RunTimeTicks: 3600 * 10000000 });
    h.player.playFeedStream({
      item: movie({ MediaSources: [src] }),
      source: src,
      open: (a) => {
        const f = { url: 'blob:feed-' + (feeders.length + 1), managed: true, stop: vi.fn(), args: a };
        feeders.push(f);
        return f;
      },
      exit: vi.fn(),
      checkpoint: vi.fn()
    });
    h.video.setDuration(3600);
    h.video.emit('loadedmetadata');
    h.video.setReadyState(4);
    await h.settle();
    h.video.setTime(840);
    h.video.emit('timeupdate');
    h.player.pmSetAudio(2);
    expect(feeders).toHaveLength(2);
    expect(feeders[0].stop).toHaveBeenCalled();
    expect(feeders[1].args.audioIndex).toBe(2);
    expect(h.P.loading).toBe(true);
    expect(h.P.loadingFrom).toBe(840);
    expect(h.video.src).toBe('blob:feed-2');
    expect(h.net.calls.filter((c) => c.path.endsWith('/PlaybackInfo'))).toHaveLength(1);   // only the first item's: a feed asks Jellyfin nothing
  });
});

describe('picture-mode control is TV-only', () => {
  beforeAll(warmPlayer, 120000);

  it('svcGetModes / svcSetPicture reject without a request', async () => {
    const h = await startPlayer();
    const before = h.net.calls.length;
    await expect(h.player.svcGetModes()).rejects.toThrow('picture control is TV-only');
    await expect(h.player.svcSetPicture('cinema')).rejects.toThrow('picture control is TV-only');
    expect(h.net.calls.length).toBe(before);
  });
});
