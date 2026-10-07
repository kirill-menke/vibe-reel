/* player.svelte.js pmSetAudio / pmSetSub on the phone: which switches are a
 * restart and that the loading card goes up with the tap (lane r3-tv-unit,
 * mutation-backed: Stryker on player.svelte.js 1765–2079).
 *
 * CLAUDE.md (iPhone app): "The remux carries one audio track, so an audio
 * switch is a restart at restartPos() (card raised with the tap, old session
 * Stopped)"; a progressive MP4 Safari takes as is (DirectPlay) switches its
 * audio client-side like the TV; a burn-in subtitle switch is a restart too,
 * card raised with the tap. Phone project only. */
import { describe, it, expect, beforeAll } from 'vitest';
import { startPlayer, warmPlayer } from '../helpers/player.js';
import { movie, source, video, audio, tracks, playbackInfo } from '../helpers/media.js';

const VOBSUB = 3;
/* 0 video · 1 AAC eng · 2 AAC ger · 3 VobSub */
const streams = () => [video(), audio({ Codec: 'aac', Language: 'eng' }), audio({ Codec: 'aac', Language: 'ger' }), tracks.vobsub()];

function jellyfin(net, { id, item }) {
  let n = 0;
  net.on('POST', '/Items/' + id + '/PlaybackInfo', (req) => {
    const ps = 'ps-' + ++n;
    const src = item.MediaSources[0];
    const burn = req.body.SubtitleStreamIndex === VOBSUB;
    const direct = src.Container === 'mp4' && !burn;
    return playbackInfo(direct ? src : { ...src, SupportsDirectPlay: false, TranscodingUrl: '/videos/' + id + '/master.m3u8?PlaySessionId=' + ps }, { PlaySessionId: ps });
  });
}
const infos = (h) => h.net.callsTo('/Items/' + h.id + '/PlaybackInfo', 'POST');

describe('phone track switches', () => {
  beforeAll(warmPlayer, 120000);

  it('a progressive MP4 (DirectPlay) switches audio on the element, no restart', async () => {
    const h = await startPlayer({ item: movie({ MediaSources: [source(streams(), { Container: 'mp4' })] }), routes: jellyfin });
    expect(h.P.playMethod).toBe('DirectPlay');
    h.video.setAudioTracks(2);
    h.player.pmSetAudio(2);
    expect(h.P.loading).toBe(false);
    expect([...h.video.audioTracks].map((t) => t.enabled)).toEqual([false, true]);
    await h.settle();
    expect(infos(h)).toHaveLength(1);
  });

  it('the HLS remux (DirectStream): the card goes up with the tap and the stream restarts', async () => {
    const h = await startPlayer({ item: movie({ MediaSources: [source(streams())] }), routes: jellyfin });
    expect(h.P.playMethod).toBe('DirectStream');
    h.player.pmSetAudio(2);
    expect(h.P.loading).toBe(true);
    await h.settle();
    expect(infos(h)).toHaveLength(2);
    expect(infos(h)[1].body.AudioStreamIndex).toBe(2);
  });

  it('inside a burn-in (Transcode): an audio switch raises the card with the tap too', async () => {
    const h = await startPlayer({ item: movie({ MediaSources: [source(streams())] }), routes: jellyfin });
    h.player.pmSetSub(VOBSUB);
    expect(h.P.loading).toBe(true);
    await h.settle();
    expect(h.P.playMethod).toBe('Transcode');
    h.P.loading = false;
    h.player.pmSetAudio(2);
    expect(h.P.loading).toBe(true);
  });

  it('a burn-in subtitle off again: a restart with the card up at once', async () => {
    const h = await startPlayer({ item: movie({ MediaSources: [source(streams())] }), routes: jellyfin });
    h.player.pmSetSub(VOBSUB);
    await h.settle();
    h.P.loading = false;
    h.player.pmSetSub(-1);
    expect(h.P.loading).toBe(true);
    await h.settle();
    expect(infos(h)).toHaveLength(3);
  });

  it('a pending feed: an audio switch is a new feeder at the same spot, card up', async () => {
    const h = await startPlayer({ reach: 'src' });
    const feeders = [];
    h.player.playFeedStream({
      item: movie({ Name: 'F' }),
      source: source(streams()),
      open: (args) => {
        const f = { url: 'blob:f' + (feeders.length + 1), managed: true, stop: () => {}, args };
        feeders.push(f);
        return f;
      }
    });
    h.P.loading = false;
    h.player.pmSetAudio(2);
    expect(h.P.loading).toBe(true);
    expect(feeders).toHaveLength(2);
    expect(feeders[1].args.audioIndex).toBe(2);
  });
});
