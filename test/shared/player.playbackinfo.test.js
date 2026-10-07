/* player.svelte.js play(): the PlaybackInfo request body, per build.
 *
 * CLAUDE.md, "Video playback — the no-transcode contract": deviceProfile(burn)
 * with empty TranscodingProfiles, and the only other knob is the burn-in. UserId
 * rides in the body ("the query form is deprecated").
 * Phone ("Playback on iOS"): "PlaybackInfo always sends MediaSourceId
 * (Audio/SubtitleStreamIndex are ignored without it) and SubtitleStreamIndex: -1
 * unless burning in: subs never ride in the HLS (VTT <track>, libpgs)." "Resume
 * = load, then seek": StartTimeTicks never reaches the HLS URL. "play() calls
 * load() on the empty <video> inside the tap — that lifts iOS's gesture
 * restriction so the later play() has sound." MaxStreamingBitrate is the quality
 * cap (200 Mbit/s for Original). */
import { describe, it, expect, beforeAll } from 'vitest';
import { startPlayer, warmPlayer } from '../helpers/player.js';
import { movie, source, video, audio, sub } from '../helpers/media.js';

const PHONE = __PHONE__;
const TICKS = 10000000;

/* 0 video · 1 E-AC3 eng · 2 AC3 ger · 3 SRT eng */
const film = () => movie({ MediaSources: [source([video(), audio({ Language: 'eng' }), audio({ Codec: 'ac3', Language: 'ger' }), sub({ Language: 'eng' })])] });

describe('the PlaybackInfo body', () => {
  beforeAll(warmPlayer, 120000);

  it(PHONE ? 'phone: MediaSourceId, the audio index, subtitles -1, the resume ticks, the cap' : 'TV: UserId, the DirectPlay profile, 400 Mbit/s, the resume ticks — no stream indexes', async () => {
    const h = await startPlayer({
      item: film(),
      resumeSec: 754.3,
      storage: { 'reel.settings': JSON.stringify({ subMode: 'always' }) },   // the English SRT is picked
      reach: 'request'
    });
    await h.settle();
    const [req] = h.net.callsTo('/Items/' + h.id + '/PlaybackInfo', 'POST');
    expect(req.query).toBe('');   // UserId rides in the body
    expect(h.P.subIndex).toBe(3);
    const { deviceProfile } = await import('../../src/lib/tracks.js');
    const base = { UserId: 'u1', AutoOpenLiveStream: true, StartTimeTicks: Math.floor(754.3 * TICKS) };
    if (PHONE) {
      expect(req.body).toEqual({
        ...base,
        DeviceProfile: JSON.parse(JSON.stringify(deviceProfile(false, 200000000))),
        MaxStreamingBitrate: 200000000,
        MediaSourceId: h.item.MediaSources[0].Id,
        AudioStreamIndex: 1,
        SubtitleStreamIndex: -1
      });
    } else {
      expect(req.body).toEqual({ ...base, DeviceProfile: JSON.parse(JSON.stringify(deviceProfile(false))), MaxStreamingBitrate: 400000000 });
    }
    h.release();
    await h.settle();
  });

  it(PHONE ? 'phone: load() on the empty element comes before the PlaybackInfo request (inside the tap)' : 'TV: no load() before the src is set', async () => {
    const h = await startPlayer({ reach: 'request' });
    await h.settle();
    expect(h.net.callsTo('/Items/' + h.id + '/PlaybackInfo', 'POST')).toHaveLength(1);
    expect(h.video.calls).toEqual(PHONE ? [['load']] : []);
    h.release();
    await h.settle();
  });
});
