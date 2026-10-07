/* tracks.js phoneProfile() (deviceProfile on the phone build): the iOS Safari
 * profile, its canPlayType probes and the Settings quality caps.
 *
 * CLAUDE.md (iPhone app): DV profile 8 ranges are declared unconditionally
 * (without them DV 8.1 was re-encoded to SDR and never started); only DV 5
 * waits for the probe, DV 7 is left out on purpose. MaxAudioChannels must stay
 * 8 (6 re-encoded 8-ch DD+ Atmos). AV1 (+ Opus) only when canPlayType('av01…')
 * answers. A capped stream is H.264 boxed to 1080p / 720p (PHONE_CAP_BOX), AAC
 * stereo at 4 Mbit/s. VobSub/DVB stay out of SubtitleProfiles as on the TV.
 *
 * The probe result is cached in module scope, so every case imports a fresh
 * tracks.js after stubbing document.createElement('video'). */
import { describe, it, expect, vi } from 'vitest';
import { freshImport } from '../helpers/modules.js';

const HEVC186 = 'video/mp4; codecs="hvc1.2.4.L186"';
const HEVC183 = 'video/mp4; codecs="hvc1.2.4.L183"';
const DV5 = 'video/mp4; codecs="dvh1.05.06"';
const AV1 = 'video/mp4; codecs="av01.0.15M.10"';

const P8_RANGES = ['SDR', 'HDR10', 'HDR10Plus', 'HLG', 'DOVIWithHDR10', 'DOVIWithHLG', 'DOVIWithSDR', 'DOVIWithHDR10Plus'];

/* answers: { [mime]: 'probably' | 'maybe' | 'no' | '' }; anything else → ''.
 * mode 'throw-create' makes createElement throw, 'throw-can' makes canPlayType throw. */
function stubVideo(answers = {}, mode = null) {
  const asked = [];
  const orig = document.createElement.bind(document);
  const spy = vi.spyOn(document, 'createElement').mockImplementation((tag, ...rest) => {
    if (String(tag).toLowerCase() !== 'video') return orig(tag, ...rest);
    if (mode === 'throw-create') throw new Error('no video element');
    return {
      canPlayType(t) {
        asked.push(t);
        if (mode === 'throw-can') throw new Error('boom');
        return answers[t] ?? '';
      }
    };
  });
  return { asked, spy };
}

async function profile(answers, { mode = null, burn = false, maxBitrate } = {}) {
  const { tracks } = await freshImport({ modules: { tracks: 'src/lib/tracks.js' } });
  const stub = stubVideo(answers, mode);
  const p = tracks.deviceProfile(burn, maxBitrate);
  return { p, tracks, ...stub };
}

const hevcConds = (p) => p.CodecProfiles.find((c) => c.Codec === 'hevc' && !c.Container).Conditions;
const condOf = (conds, prop) => conds.find((c) => c.Property === prop);
const rangesOf = (conds) => condOf(conds, 'VideoRangeType').Value.split('|');
const hls = (p) => p.TranscodingProfiles[0];

describe('phone project', () => {
  it('deviceProfile is the phone profile here', async () => {
    expect(__PHONE__).toBe(true);
    const { p } = await profile({});
    expect(p.Name).toBe('VibeReel Phone (iOS Safari)');
  });
});

describe('HEVC level probe', () => {
  it.each([
    [{ [HEVC186]: 'probably' }, '186'],
    [{ [HEVC186]: 'maybe' }, '186'],
    [{ [HEVC183]: 'probably' }, '183'],
    [{ [HEVC186]: 'no', [HEVC183]: 'maybe' }, '183'],
    [{}, '153'],
    [{ [HEVC186]: 'no', [HEVC183]: 'no' }, '153']
  ])('%o → L%s', async (answers, level) => {
    const { p } = await profile(answers);
    expect(condOf(hevcConds(p), 'VideoLevel')).toStrictEqual({ Condition: 'LessThanEqual', Property: 'VideoLevel', Value: level, IsRequired: false });
  });

  it('a throwing canPlayType or createElement falls back to L153, no DV5, no AV1', async () => {
    for (const mode of ['throw-can', 'throw-create']) {
      const { p } = await profile({ [HEVC186]: 'probably', [DV5]: 'probably', [AV1]: 'probably' }, { mode });
      const c = hevcConds(p);
      expect(condOf(c, 'VideoLevel').Value).toBe('153');
      expect(rangesOf(c)).toStrictEqual(P8_RANGES);
      expect(p.CodecProfiles.some((x) => x.Codec === 'av1')).toBe(false);
    }
  });
});

describe('Dolby Vision ranges', () => {
  it('profile 8 ranges are declared even when every probe answers ""', async () => {
    const { p } = await profile({});
    expect(rangesOf(hevcConds(p))).toStrictEqual(P8_RANGES);
  });

  it("'DOVI' (profile 5) only when the dvh1.05 probe answers", async () => {
    const yes = await profile({ [DV5]: 'probably' });
    expect(rangesOf(hevcConds(yes.p))).toStrictEqual([...P8_RANGES, 'DOVI']);
    const no = await profile({ [DV5]: 'no' });
    expect(rangesOf(hevcConds(no.p))).not.toContain('DOVI');
  });

  it('DOVIWithEL / DOVIInvalid (profile 7) are never declared', async () => {
    const { p } = await profile({ [HEVC186]: 'probably', [DV5]: 'probably', [AV1]: 'probably' });
    for (const cp of p.CodecProfiles) {
      for (const c of cp.Conditions) {
        if (c.Property !== 'VideoRangeType') continue;
        const r = c.Value.split('|');
        expect(r).not.toContain('DOVIWithEL');
        expect(r).not.toContain('DOVIInvalid');
      }
    }
  });

  it('h264 stays SDR-only', async () => {
    const { p } = await profile({ [DV5]: 'probably' });
    const h = p.CodecProfiles.find((c) => c.Codec === 'h264');
    expect(condOf(h.Conditions, 'VideoRangeType').Value).toBe('SDR');
  });
});

describe('AV1 (+ Opus) only when the av01 probe answers', () => {
  it('without AV1: hevc,h264 and no opus anywhere, no av1 codec profile', async () => {
    const { p } = await profile({});
    expect(p.DirectPlayProfiles[1].VideoCodec).toBe('hevc,h264');
    expect(p.DirectPlayProfiles[1].AudioCodec).toBe('eac3,ac3,aac,flac,alac');
    expect(hls(p).VideoCodec).toBe('hevc,h264');
    expect(hls(p).AudioCodec).toBe('eac3,ac3,aac,flac,alac');
    expect(p.CodecProfiles.map((c) => c.Codec)).toStrictEqual(['h264', 'hevc', 'hevc']);
  });

  it('with AV1: av1 listed first, opus added, av1 codec profile with the same ranges as HEVC', async () => {
    const { p } = await profile({ [AV1]: 'probably', [DV5]: 'maybe' });
    expect(p.DirectPlayProfiles[1].VideoCodec).toBe('av1,hevc,h264');
    expect(p.DirectPlayProfiles[1].AudioCodec).toBe('eac3,ac3,aac,flac,alac,opus');
    expect(hls(p).VideoCodec).toBe('av1,hevc,h264');
    expect(hls(p).AudioCodec).toBe('eac3,ac3,aac,flac,alac,opus');
    const av1 = p.CodecProfiles.find((c) => c.Codec === 'av1');
    expect(av1.Conditions).toStrictEqual([{ Condition: 'EqualsAny', Property: 'VideoRangeType', Value: [...P8_RANGES, 'DOVI'].join('|'), IsRequired: false }]);
  });

  it("'no' counts as no (the probe strips it)", async () => {
    const { p } = await profile({ [AV1]: 'no' });
    expect(p.CodecProfiles.some((c) => c.Codec === 'av1')).toBe(false);
  });

  it('progressive DirectPlay never takes AV1 or Opus', async () => {
    const { p } = await profile({ [AV1]: 'probably' });
    expect(p.DirectPlayProfiles[0]).toStrictEqual({ Type: 'Video', Container: 'mp4,m4v,mov', VideoCodec: 'h264,hevc', AudioCodec: 'aac,ac3,eac3,flac,alac,mp3' });
  });
});

describe('probe cache', () => {
  it('probes once per module instance; a fresh import probes again', async () => {
    const { p, tracks, asked } = await profile({ [HEVC186]: 'probably' });
    const n = asked.length;
    expect(n).toBeGreaterThan(0);
    const again = tracks.deviceProfile(false, 4000000);
    expect(asked.length).toBe(n);
    expect(condOf(hevcConds(again), 'VideoLevel').Value).toBe('186');
    expect(condOf(hevcConds(p), 'VideoLevel').Value).toBe('186');

    vi.restoreAllMocks();
    const second = await profile({});
    expect(second.asked.length).toBeGreaterThan(0);
    expect(condOf(hevcConds(second.p), 'VideoLevel').Value).toBe('153');
  });

  it('asks exactly the documented MIME strings', async () => {
    const { asked } = await profile({});
    expect(new Set(asked)).toStrictEqual(new Set([HEVC186, HEVC183, DV5, AV1]));
  });
});

describe('quality caps (PHONE_CAP_BOX)', () => {
  it('PHONE_CAP_BOX: 8 Mbit/s → 1080p, 4 Mbit/s → 720p', async () => {
    const { tracks } = await freshImport({ modules: { tracks: 'src/lib/tracks.js' } });
    expect(tracks.PHONE_CAP_BOX).toStrictEqual({ 8000000: [1920, 1080], 4000000: [1280, 720] });
  });

  it('uncapped: 200 Mbit/s default, 8 channels, no Width/Height box', async () => {
    for (const mb of [undefined, 0, null]) {
      const { p } = await profile({}, { maxBitrate: mb });
      expect(p.MaxStreamingBitrate).toBe(200000000);
      expect(p.MaxStaticBitrate).toBe(200000000);
      expect(hls(p).MaxAudioChannels).toBe('8');
      expect(hls(p).Conditions).toBeUndefined();
      expect('Conditions' in hls(p)).toBe(false);
    }
  });

  it('8 Mbit/s: H.264 first, boxed to 1920x1080, audio still 8 channels', async () => {
    const { p } = await profile({}, { maxBitrate: 8000000 });
    expect(p.MaxStreamingBitrate).toBe(8000000);
    expect(p.MaxStaticBitrate).toBe(8000000);
    expect(hls(p).VideoCodec).toBe('h264,hevc');
    expect(hls(p).AudioCodec).toBe('eac3,ac3,aac,flac,alac');
    expect(hls(p).MaxAudioChannels).toBe('8');
    expect(hls(p).Conditions).toStrictEqual([
      { Condition: 'LessThanEqual', Property: 'Width', Value: '1920', IsRequired: false },
      { Condition: 'LessThanEqual', Property: 'Height', Value: '1080', IsRequired: false }
    ]);
  });

  it('4 Mbit/s: boxed to 1280x720, AAC stereo', async () => {
    const { p } = await profile({}, { maxBitrate: 4000000 });
    expect(hls(p).VideoCodec).toBe('h264,hevc');
    expect(hls(p).AudioCodec).toBe('aac');
    expect(hls(p).MaxAudioChannels).toBe('2');
    expect(hls(p).Conditions.map((c) => [c.Property, c.Value])).toStrictEqual([['Width', '1280'], ['Height', '720']]);
  });

  it('a capped profile with AV1 keeps h264 first, then av1, then hevc', async () => {
    const { p } = await profile({ [AV1]: 'probably' }, { maxBitrate: 8000000 });
    expect(hls(p).VideoCodec).toBe('h264,av1,hevc');
    expect(hls(p).AudioCodec).toBe('eac3,ac3,aac,flac,alac,opus');
  });

  it('a bitrate that is not a cap step is passed through without a box', async () => {
    const { p } = await profile({}, { maxBitrate: 20000000 });
    expect(p.MaxStreamingBitrate).toBe(20000000);
    expect(hls(p).Conditions).toBeUndefined();
    expect(hls(p).MaxAudioChannels).toBe('8');
    expect(hls(p).VideoCodec).toBe('hevc,h264');
  });
});

describe('profile shape', () => {
  it('HLS fMP4 remux profile + static fallback; burn changes nothing on the phone', async () => {
    const { p, tracks } = await profile({});
    expect(p.TranscodingProfiles).toHaveLength(2);
    expect(hls(p)).toMatchObject({ Type: 'Video', Container: 'mp4', Protocol: 'hls', Context: 'Streaming', MinSegments: 2, BreakOnNonKeyFrames: true });
    expect(p.TranscodingProfiles[1]).toStrictEqual({ Type: 'Video', Container: 'mp4', Protocol: 'http', Context: 'Static', VideoCodec: 'h264', AudioCodec: 'aac' });
    expect(tracks.deviceProfile(true)).toStrictEqual(p);
  });

  it('DirectPlay only progressive mp4/m4v/mov (plus the hls convention)', async () => {
    const { p } = await profile({});
    expect(p.DirectPlayProfiles.map((d) => d.Container)).toStrictEqual(['mp4,m4v,mov', 'hls']);
    for (const d of p.DirectPlayProfiles) expect(d.Container.split(',')).not.toContain('mkv');
  });

  it('subtitles: text + PGS External; VobSub/DVB absent', async () => {
    const { p } = await profile({});
    const f = p.SubtitleProfiles.map((s) => s.Format);
    expect(f.sort()).toStrictEqual(['mov_text', 'pgs', 'pgssub', 'srt', 'subrip', 'vtt']);
    for (const s of p.SubtitleProfiles) expect(s.Method).toBe('External');
    for (const bad of ['vobsub', 'dvdsub', 'dvbsub', 'dvb_subtitle', 'dvd_subtitle']) expect(f).not.toContain(bad);
  });

  it('HEVC profile: main/main 10, ≤ 60 fps required, no interlace; mp4 needs hvc1/dvh1 tag', async () => {
    const { p } = await profile({});
    const c = hevcConds(p);
    expect(condOf(c, 'VideoProfile').Value).toBe('main|main 10');
    expect(condOf(c, 'VideoFramerate')).toStrictEqual({ Condition: 'LessThanEqual', Property: 'VideoFramerate', Value: '60', IsRequired: true });
    expect(condOf(c, 'IsInterlaced')).toStrictEqual({ Condition: 'NotEquals', Property: 'IsInterlaced', Value: 'true', IsRequired: false });
    const tag = p.CodecProfiles.find((x) => x.Codec === 'hevc' && x.Container);
    expect(tag).toStrictEqual({ Type: 'Video', Codec: 'hevc', Container: 'mp4,m4v,mov', Conditions: [{ Condition: 'EqualsAny', Property: 'VideoCodecTag', Value: 'hvc1|dvh1', IsRequired: true }] });
  });

  it('h264 profile: level ≤ 52, the usual profiles', async () => {
    const { p } = await profile({});
    const h = p.CodecProfiles.find((c) => c.Codec === 'h264').Conditions;
    expect(condOf(h, 'VideoLevel').Value).toBe('52');
    expect(condOf(h, 'VideoProfile').Value).toBe('high|main|baseline|constrained baseline');
  });

  it('m4v responses are served as video/mp4; music bitrate 384k', async () => {
    const { p } = await profile({});
    expect(p.ResponseProfiles).toStrictEqual([{ Type: 'Video', Container: 'm4v', MimeType: 'video/mp4' }]);
    expect(p.MusicStreamingTranscodingBitrate).toBe(384000);
    expect(p.ContainerProfiles).toStrictEqual([]);
  });
});

/* Exact CodecProfiles / HLS profile. Every string here is read by Jellyfin's
 * StreamBuilder — a wrong Type, Condition or Property name makes it ignore the
 * condition (e.g. interlaced or HDR H.264 handed to Safari as a copy), so the
 * whole structure is pinned, for the default probe and for an AV1 device. */
describe('exact codec profiles', () => {
  const cnd = (Condition, Property, Value, IsRequired = false) => ({ Condition, Property, Value, IsRequired });
  const RANGES = P8_RANGES.join('|');
  const h264 = {
    Type: 'Video',
    Codec: 'h264',
    Conditions: [
      cnd('EqualsAny', 'VideoProfile', 'high|main|baseline|constrained baseline'),
      cnd('EqualsAny', 'VideoRangeType', 'SDR'),
      cnd('LessThanEqual', 'VideoLevel', '52'),
      cnd('NotEquals', 'IsInterlaced', 'true')
    ]
  };
  const hevc = (level, ranges) => ({
    Type: 'Video',
    Codec: 'hevc',
    Conditions: [
      cnd('EqualsAny', 'VideoProfile', 'main|main 10'),
      cnd('EqualsAny', 'VideoRangeType', ranges),
      cnd('LessThanEqual', 'VideoLevel', String(level)),
      cnd('NotEquals', 'IsInterlaced', 'true'),
      cnd('LessThanEqual', 'VideoFramerate', '60', true)
    ]
  });
  const tag = { Type: 'Video', Codec: 'hevc', Container: 'mp4,m4v,mov', Conditions: [cnd('EqualsAny', 'VideoCodecTag', 'hvc1|dvh1', true)] };

  it('default probe: h264 SDR-only, hevc L153 with the DV 8 ranges, the mp4 tag rule', async () => {
    const { p } = await profile({});
    expect(p.CodecProfiles).toStrictEqual([h264, hevc(153, RANGES), tag]);
    expect(p.DirectPlayProfiles[1]).toStrictEqual({ Type: 'Video', Container: 'hls', VideoCodec: 'hevc,h264', AudioCodec: 'eac3,ac3,aac,flac,alac' });
    expect(hls(p)).toStrictEqual({
      Type: 'Video', Container: 'mp4', Protocol: 'hls', Context: 'Streaming', VideoCodec: 'hevc,h264',
      AudioCodec: 'eac3,ac3,aac,flac,alac', MaxAudioChannels: '8', MinSegments: 2, BreakOnNonKeyFrames: true
    });
  });

  it('AV1 + DV 5 + L186 device: an av1 profile over the same ranges', async () => {
    const { p } = await profile({ [AV1]: 'probably', [DV5]: 'probably', [HEVC186]: 'probably' });
    const ranges = RANGES + '|DOVI';
    expect(p.CodecProfiles).toStrictEqual([h264, hevc(186, ranges), tag, { Type: 'Video', Codec: 'av1', Conditions: [cnd('EqualsAny', 'VideoRangeType', ranges)] }]);
    expect(p.DirectPlayProfiles[1]).toStrictEqual({ Type: 'Video', Container: 'hls', VideoCodec: 'av1,hevc,h264', AudioCodec: 'eac3,ac3,aac,flac,alac,opus' });
  });
});
