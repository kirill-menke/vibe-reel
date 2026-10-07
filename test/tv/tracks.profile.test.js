/* tracks.js deviceProfile() on the TV: the no-transcode contract.
 *
 * CLAUDE.md: "deviceProfile(burn) declares empty TranscodingProfiles so
 * Jellyfin has no choice but DirectPlay … The single exception is burn === true:
 * VobSub/DVB subtitles have no client-side decoder, so they are deliberately
 * omitted from SubtitleProfiles, which forces Jellyfin to burn them in via a
 * one-off HLS transcode profile. Don't add transcoding profiles for any other
 * reason."
 *
 * The TranscodingProfiles assertions are EXACT (toStrictEqual), so adding any
 * profile — or changing the burn-in one — fails here on purpose. */
import { describe, it, expect } from 'vitest';
import { deviceProfile } from '../../src/lib/tracks.js';

const BURN_PROFILE = {
  Type: 'Video',
  Container: 'ts',
  Protocol: 'hls',
  VideoCodec: 'h264',
  AudioCodec: 'aac,ac3,eac3',
  Context: 'Streaming',
  MaxAudioChannels: '8',
  MinSegments: '1',
  BreakOnNonKeyFrames: true
};

const list = (s) => s.split(',');

describe('deviceProfile(false): DirectPlay only', () => {
  it('runs in the TV project', () => {
    expect(__PHONE__).toBe(false);
  });

  it('declares no transcoding profile at all', () => {
    const p = deviceProfile(false);
    expect(p.TranscodingProfiles).toStrictEqual([]);
    expect(deviceProfile(undefined).TranscodingProfiles).toStrictEqual([]);
    expect(deviceProfile(0).TranscodingProfiles).toStrictEqual([]);
  });

  it('has no container/codec restrictions and no phone fields', () => {
    const p = deviceProfile(false);
    expect(p.ContainerProfiles).toStrictEqual([]);
    expect(p.CodecProfiles).toStrictEqual([]);
    expect(p.Name).toBeUndefined();
    expect(p.ResponseProfiles).toBeUndefined();
  });

  it('allows 400 Mbit/s streaming and static', () => {
    const p = deviceProfile(false);
    expect(p.MaxStreamingBitrate).toBe(400000000);
    expect(p.MaxStaticBitrate).toBe(400000000);
  });

  it('ignores the phone quality cap argument on the TV', () => {
    const p = deviceProfile(false, 4000000);
    expect(p.MaxStreamingBitrate).toBe(400000000);
    expect(p.TranscodingProfiles).toStrictEqual([]);
    expect(deviceProfile(true, 8000000).TranscodingProfiles).toStrictEqual([BURN_PROFILE]);
  });

  it('DirectPlays the original containers, incl. mkv', () => {
    const p = deviceProfile(false);
    expect(p.DirectPlayProfiles).toHaveLength(2);
    const v = p.DirectPlayProfiles[0];
    expect(v.Type).toBe('Video');
    expect(list(v.Container)).toEqual(expect.arrayContaining(['mkv', 'mp4', 'm4v', 'mov', 'ts', 'webm', 'avi']));
    expect(list(v.VideoCodec)).toEqual(expect.arrayContaining(['h264', 'hevc', 'av1', 'vp9']));
    expect(p.DirectPlayProfiles[1]).toStrictEqual({ Type: 'Audio' });
  });

  it('DirectPlays lossless and Dolby audio (TrueHD, DTS, E-AC3) — no audio transcode', () => {
    const a = list(deviceProfile(false).DirectPlayProfiles[0].AudioCodec);
    for (const c of ['truehd', 'dts', 'eac3', 'ac3', 'aac', 'flac', 'opus']) expect(a).toContain(c);
  });

  it('declares exactly the client-side subtitle formats (text + PGS), all External', () => {
    const subs = deviceProfile(false).SubtitleProfiles;
    expect(subs.map((s) => s.Format).sort()).toStrictEqual(['ass', 'pgs', 'pgssub', 'srt', 'ssa', 'subrip', 'vtt']);
    for (const s of subs) expect(s.Method).toBe('External');
  });

  it('never lists VobSub / DVD / DVB (that is what forces the burn-in)', () => {
    for (const burn of [false, true]) {
      const formats = deviceProfile(burn).SubtitleProfiles.map((s) => s.Format.toLowerCase());
      for (const f of ['vobsub', 'dvdsub', 'dvd_subtitle', 'dvbsub', 'dvb_subtitle', 'xsub']) expect(formats).not.toContain(f);
    }
  });

  it('returns a fresh object each call (no shared mutable profile)', () => {
    const a = deviceProfile(false);
    a.TranscodingProfiles.push({ Type: 'Video' });
    a.SubtitleProfiles.length = 0;
    const b = deviceProfile(false);
    expect(b.TranscodingProfiles).toStrictEqual([]);
    expect(b.SubtitleProfiles).toHaveLength(7);
  });
});

describe('deviceProfile(true): the one burn-in exception', () => {
  it('has exactly one transcoding profile: HLS ts h264, 8 channels, BreakOnNonKeyFrames', () => {
    expect(deviceProfile(true).TranscodingProfiles).toStrictEqual([BURN_PROFILE]);
  });

  it('keeps everything else identical to the DirectPlay profile', () => {
    const { TranscodingProfiles: a, ...restBurn } = deviceProfile(true);
    const { TranscodingProfiles: b, ...restPlain } = deviceProfile(false);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
    expect(restBurn).toStrictEqual(restPlain);
  });

  it('only a truthy burn enables it', () => {
    expect(deviceProfile(1).TranscodingProfiles).toStrictEqual([BURN_PROFILE]);
    expect(deviceProfile(null).TranscodingProfiles).toStrictEqual([]);
    expect(deviceProfile('').TranscodingProfiles).toStrictEqual([]);
  });
});
