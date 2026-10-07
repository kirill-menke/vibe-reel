/* player.svelte.js phoneQuality() / pmSetQuality(): the resolution the
 * Quality picker announces for a reduced stream, at the edges where the box
 * maths changes the tier (lane r3-tv-unit, mutation-backed: Stryker on
 * player.svelte.js 1–460).
 *
 * CLAUDE.md, "Streaming quality": "a file above the cap is re-encoded as H.264
 * boxed to 1080p / 720p (PHONE_CAP_BOX)" — the box keeps the aspect ratio, so
 * whichever side hits the box first decides the scale; a source whose size is
 * unknown (either side missing) gets no resolution in the label. The picker
 * "restarts the running item at the same position under the new cap"; off the
 * player it only stores. */
import { describe, it, expect, beforeAll } from 'vitest';
import { startPlayer, warmPlayer } from '../helpers/player.js';
import { movie, source, video as vstream, audio, playbackInfo } from '../helpers/media.js';

const CAP = 'reel.qualityCellular';

function remux(src, query) {
  return playbackInfo({ ...src, SupportsDirectPlay: false, TranscodingUrl: '/videos/x/master.m3u8?MediaSourceId=' + src.Id + '&' + query }, { PlaySessionId: 'ps-1' });
}

async function reduced(v, cap = '8000000') {
  const src = source([vstream(v), audio()]);
  const h = await startPlayer({ item: movie({ MediaSources: [src] }), info: remux(src, 'MaxWidth=1920&VideoCodec=h264'), storage: { [CAP]: cap } });
  return h.P.quality;
}

describe('P.quality: which side of the box decides', () => {
  beforeAll(warmPlayer, 120000);

  it('an ultra-wide 3840×1200 file into 1920×1080: the width decides → 1920×600, "1080p" (not 4K)', async () => {
    expect((await reduced({ Width: 3840, Height: 1200 })).res).toBe('1080p');
  });

  it('a tall 1920×2160 file into 1920×1080: the height decides → 960×1080, "1080p" (not 4K)', async () => {
    expect((await reduced({ Width: 1920, Height: 2160 })).res).toBe('1080p');
  });

  it('a file smaller than the box is not scaled up', async () => {
    expect((await reduced({ Width: 1280, Height: 720 })).res).toBe('720p');
  });

  it('a width without a height: no resolution', async () => {
    const q = await reduced({ Width: 3840, Height: undefined });
    expect(q).toMatchObject({ reduced: true, res: '', label: '8 Mbit/s (reduced)' });
  });

  it('a height without a width: no resolution', async () => {
    const q = await reduced({ Width: undefined, Height: 2160 });
    expect(q).toMatchObject({ reduced: true, res: '', label: '8 Mbit/s (reduced)' });
  });
});

describe('pmSetQuality', () => {
  beforeAll(warmPlayer, 120000);

  it('raises the loading card with the tap, at the position the restart resumes from', async () => {
    const h = await startPlayer();
    await h.clock.tick(1000);
    h.video.setTime(321.7);
    h.video.emit('timeupdate');
    h.player.pmSetQuality(4000000);
    expect(h.P.loading).toBe(true);
    expect(h.P.loadingFrom).toBe(321.7);
    await h.settle();
    const infos = h.net.callsTo('/Items/' + h.id + '/PlaybackInfo', 'POST');
    expect(infos).toHaveLength(2);
    expect(infos[1].body.MaxStreamingBitrate).toBe(4000000);
    expect(infos[1].body.StartTimeTicks).toBe(321 * 10000000);
  });

  it('off the player (the item is still in P) it only stores the cap', async () => {
    const h = await startPlayer();
    h.player.exitPlayer();
    h.S.screen = 'detail';
    h.player.pmSetQuality(8000000);
    expect(h.player.getQualityCap()).toBe(8000000);
    expect(h.P.loading).toBe(false);
    await h.settle();
    expect(h.net.callsTo('/Items/' + h.id + '/PlaybackInfo', 'POST')).toHaveLength(1);
  });
});
