/* tracks.js webProfile() (deviceProfile in the desktop web build) and webCaps().
 *
 * The web build runs the phone engine in desktop Chrome / Firefox, which get
 * Jellyfin's HLS fMP4 remux appended to a MediaSource (jfhls.js) — so what a
 * SourceBuffer takes is probed (MediaSource.isTypeSupported), not canPlayType.
 * Measured 2026-10-07 on Linux: Chrome 154 has no HEVC, no AC-3/E-AC-3, no DV;
 * Firefox 156 adds HEVC Main/Main 10. H.264 is the transcode target (listed
 * first); HDR only on an HDR display; DV 5 only where dvh1.05 plays; the
 * phone's quality cap (PHONE_CAP_BOX) applies. The probe is cached in module
 * scope, so every case imports a fresh tracks.js after stubbing. */
import { describe, it, expect, vi } from 'vitest';
import { freshImport } from '../helpers/modules.js';
import { installMSE } from '../helpers/mse.js';

const CHROME = ['avc1.640028', 'av01.0.08M.08', 'av01.0.08M.10', 'vp09.00.10.08', 'vp09.02.10.10', 'mp4a.40.2', 'opus', 'flac'];
const FIREFOX = [...CHROME, 'hvc1.2.4.L153.B0', 'hvc1.1.6.L120.90', 'hvc1.2.4.L186.B0', 'hvc1.2.4.L183.B0'];
const P8 = 'SDR|HDR10|HDR10Plus|HLG|DOVIWithHDR10|DOVIWithHLG|DOVIWithSDR|DOVIWithHDR10Plus';

/* codecs the fake MediaSource takes; hdr = the display; mp3 = canPlayType('audio/mpeg') */
async function load({ codecs = CHROME, hdr = false, mp3 = 'probably', noMS = false } = {}) {
  const { tracks } = await freshImport({ modules: { tracks: 'src/lib/tracks.js' } });
  const asked = [];
  if (noMS) {
    vi.stubGlobal('MediaSource', undefined);
    vi.stubGlobal('ManagedMediaSource', undefined);
  } else {
    installMSE({
      supported: (mime) => {
        asked.push(mime);
        const c = (String(mime).match(/codecs="([^"]+)"/) || [])[1];
        return codecs.includes(c);
      }
    });
  }
  vi.stubGlobal('matchMedia', (q) => ({ matches: hdr && /video-dynamic-range: high/.test(q), media: q }));
  const orig = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag, ...rest) =>
    String(tag).toLowerCase() === 'video' ? { canPlayType: (t) => (t === 'audio/mpeg' ? mp3 : '') } : orig(tag, ...rest)
  );
  return { tracks, asked };
}

const prof = async (o, burn = false, br) => {
  const m = await load(o);
  return { p: m.tracks.deviceProfile(burn, br), ...m };
};
const codec = (p, c, container) => p.CodecProfiles.find((x) => x.Codec === c && (container ? x.Container : !x.Container));
const cond = (cp, prop) => cp.Conditions.find((c) => c.Property === prop);
const hls = (p) => p.TranscodingProfiles[0];

describe('the web build', () => {
  it('deviceProfile is the web profile here (not the phone’s)', async () => {
    expect(__PHONE__ && __WEB__).toBe(true);
    const { p } = await prof();
    expect(p.Name).toBe('VibeReel Web');
  });
});

describe('Chrome on Linux (no HEVC, no AC-3/E-AC-3)', () => {
  it('copies H.264 / AV1 / VP9, transcodes to H.264 (listed first), AAC/Opus/FLAC audio, 6 channels', async () => {
    const { p } = await prof();
    expect(p.DirectPlayProfiles).toEqual([{ Type: 'Video', Container: 'mp4,m4v', VideoCodec: 'h264,av1,vp9', AudioCodec: 'aac,mp3,opus,flac' }]);
    expect(hls(p)).toEqual({
      Type: 'Video', Container: 'mp4', Protocol: 'hls', Context: 'Streaming', VideoCodec: 'h264,av1,vp9',
      AudioCodec: 'aac,opus,flac', MaxAudioChannels: '6', MinSegments: 1, BreakOnNonKeyFrames: false
    });
    expect(p.TranscodingProfiles[1]).toMatchObject({ Protocol: 'http', Context: 'Static', VideoCodec: 'h264', AudioCodec: 'aac' });
    expect(codec(p, 'hevc')).toBeUndefined();
    expect(codec(p, 'hevc', true)).toBeUndefined();
    expect(p.MaxStreamingBitrate).toBe(200000000);
    expect(p.MaxStaticBitrate).toBe(200000000);
  });

  it('an SDR display claims no HDR: SDR (and DV with an SDR base) only — Jellyfin tone-maps the rest', async () => {
    const { p } = await prof();
    expect(cond(codec(p, 'av1'), 'VideoRangeType').Value).toBe('SDR|DOVIWithSDR');
    expect(cond(codec(p, 'vp9'), 'VideoRangeType').Value).toBe('SDR');
    expect(cond(codec(p, 'h264'), 'VideoRangeType').Value).toBe('SDR');
  });

  it('H.264 keeps the phone’s rules; 10-bit AV1/VP9 need no bit-depth cap', async () => {
    const { p } = await prof();
    expect(codec(p, 'h264').Conditions.map((c) => [c.Property, c.Value])).toEqual([
      ['VideoProfile', 'high|main|baseline|constrained baseline'], ['VideoRangeType', 'SDR'], ['VideoLevel', '52'], ['IsInterlaced', 'true']
    ]);
    expect(cond(codec(p, 'av1'), 'VideoBitDepth')).toBeUndefined();
    expect(cond(codec(p, 'vp9'), 'VideoBitDepth')).toBeUndefined();
  });

  it('VobSub/DVB stay out of SubtitleProfiles (burn-in, as on the phone); no ResponseProfiles', async () => {
    const { p } = await prof();
    expect(p.SubtitleProfiles.map((s) => s.Format)).toEqual(['vtt', 'srt', 'subrip', 'mov_text', 'pgssub', 'pgs']);
    expect(p.SubtitleProfiles.every((s) => s.Method === 'External')).toBe(true);
    expect(p.ResponseProfiles).toBeUndefined();
  });

  it('probes MediaSource with the fMP4 MIME types', async () => {
    const { asked } = await prof();
    expect(asked).toContain('video/mp4; codecs="hvc1.2.4.L153.B0"');
    expect(asked).toContain('audio/mp4; codecs="ec-3"');
    expect(asked).toContain('video/mp4; codecs="dvh1.05.06"');
  });
});

describe('Firefox (HEVC Main/Main 10)', () => {
  it('copies HEVC up to the probed level; an HEVC MP4 direct-plays only tagged hvc1/hev1', async () => {
    const { p } = await prof({ codecs: FIREFOX });
    expect(hls(p).VideoCodec).toBe('h264,hevc,av1,vp9');
    expect(p.DirectPlayProfiles[0].VideoCodec).toBe('h264,hevc,av1,vp9');
    const h = codec(p, 'hevc');
    expect(cond(h, 'VideoProfile').Value).toBe('main|main 10');
    expect(cond(h, 'VideoLevel').Value).toBe('186');
    expect(cond(h, 'IsInterlaced').Value).toBe('true');
    expect(cond(h, 'VideoRangeType').Value).toBe('SDR|DOVIWithSDR');
    expect(codec(p, 'hevc', true)).toEqual({
      Type: 'Video', Codec: 'hevc', Container: 'mp4,m4v',
      Conditions: [{ Condition: 'EqualsAny', Property: 'VideoCodecTag', Value: 'hvc1|hev1', IsRequired: true }]
    });
  });

  it('level 183 / 153 when the higher probes fail; 8-bit only HEVC is Main only', async () => {
    let { p } = await prof({ codecs: [...CHROME, 'hvc1.2.4.L153.B0', 'hvc1.2.4.L183.B0'] });
    expect(cond(codec(p, 'hevc'), 'VideoLevel').Value).toBe('183');
    ({ p } = await prof({ codecs: [...CHROME, 'hvc1.1.6.L120.90'] }));
    expect(cond(codec(p, 'hevc'), 'VideoLevel').Value).toBe('153');
    expect(cond(codec(p, 'hevc'), 'VideoProfile').Value).toBe('main');
  });
});

describe('HDR display, Dolby Vision, surround, bit depth', () => {
  it('an HDR display claims HDR10/HLG and DV profile 8; DOVI (profile 5) only where dvh1.05 plays', async () => {
    let { p } = await prof({ codecs: FIREFOX, hdr: true });
    expect(cond(codec(p, 'hevc'), 'VideoRangeType').Value).toBe(P8);
    expect(cond(codec(p, 'av1'), 'VideoRangeType').Value).toBe(P8);
    expect(cond(codec(p, 'vp9'), 'VideoRangeType').Value).toBe('SDR|HDR10|HLG');
    ({ p } = await prof({ codecs: [...FIREFOX, 'dvh1.05.06'], hdr: true }));
    expect(cond(codec(p, 'hevc'), 'VideoRangeType').Value).toBe(P8 + '|DOVI');
  });

  it('a browser that takes dvh1 (DV 8) direct-plays dvh1/dvhe-tagged MP4s too', async () => {
    const { p } = await prof({ codecs: [...FIREFOX, 'dvh1.08.06'] });
    expect(cond(codec(p, 'hevc', true), 'VideoCodecTag').Value).toBe('hvc1|hev1|dvh1|dvhe');
  });

  it('AC-3 / E-AC-3, where probed, are copied (and direct-played)', async () => {
    const { p } = await prof({ codecs: [...CHROME, 'ec-3', 'ac-3'] });
    expect(hls(p).AudioCodec).toBe('aac,opus,flac,eac3,ac3');
    expect(p.DirectPlayProfiles[0].AudioCodec).toBe('aac,mp3,opus,flac,eac3,ac3');
  });

  it('8-bit-only AV1 / VP9 decoders get a VideoBitDepth ≤ 8 condition; none at all → not listed', async () => {
    let { p } = await prof({ codecs: ['avc1.640028', 'av01.0.08M.08', 'vp09.00.10.08', 'mp4a.40.2'] });
    expect(cond(codec(p, 'av1'), 'VideoBitDepth')).toEqual({ Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: false });
    expect(cond(codec(p, 'vp9'), 'VideoBitDepth').Value).toBe('8');
    ({ p } = await prof({ codecs: ['avc1.640028', 'mp4a.40.2'] }));
    expect(hls(p).VideoCodec).toBe('h264');
    expect(hls(p).AudioCodec).toBe('aac');
    expect(p.CodecProfiles.map((c) => c.Codec)).toEqual(['h264']);
  });

  it('no MP3 from canPlayType → not in DirectPlay', async () => {
    const { p } = await prof({ mp3: '' });
    expect(p.DirectPlayProfiles[0].AudioCodec).toBe('aac,opus,flac');
  });
});

describe('quality cap (the phone’s PHONE_CAP_BOX)', () => {
  it('8 Mbit/s: the re-encode boxed to 1080p, audio unchanged', async () => {
    const { p } = await prof({}, false, 8000000);
    expect(p.MaxStreamingBitrate).toBe(8000000);
    expect(hls(p).Conditions.map((c) => [c.Property, c.Value])).toEqual([['Width', '1920'], ['Height', '1080']]);
    expect(hls(p).AudioCodec).toBe('aac,opus,flac');
    expect(hls(p).MaxAudioChannels).toBe('6');
  });

  it('4 Mbit/s: 720p and AAC stereo', async () => {
    const { p } = await prof({}, false, 4000000);
    expect(hls(p).Conditions.map((c) => c.Value)).toEqual(['1280', '720']);
    expect(hls(p).AudioCodec).toBe('aac');
    expect(hls(p).MaxAudioChannels).toBe('2');
  });

  it('a bitrate that is not a cap: no box', async () => {
    const { p } = await prof({}, true, 12345);
    expect(hls(p).Conditions).toBeUndefined();
    expect(p.MaxStreamingBitrate).toBe(12345);
  });
});

describe('webCaps()', () => {
  it('reports what was probed, once per page', async () => {
    const { tracks, asked } = await load({ codecs: FIREFOX, hdr: true });
    const c = tracks.webCaps();
    expect(c).toEqual({
      h264: true, hevc: true, hevc10: true, hevcLevel: 186, av1: true, av1_10: true, vp9: true, vp9_10: true,
      aac: true, mp3: true, opus: true, flac: true, ac3: false, eac3: false, dv8: false, dv5: false, hdr: true
    });
    const n = asked.length;
    expect(tracks.webCaps()).toBe(c);
    expect(asked.length).toBe(n);
  });

  it('no MediaSource at all: nothing but MP3; failing probes count as no', async () => {
    let { tracks } = await load({ noMS: true });
    expect(Object.entries(tracks.webCaps()).filter(([, v]) => v === true).map(([k]) => k)).toEqual(['mp3']);
    ({ tracks } = await freshImport({ modules: { tracks: 'src/lib/tracks.js' } }));
    installMSE({ supported: () => { throw new Error('boom'); } });
    vi.stubGlobal('matchMedia', () => { throw new Error('no media queries'); });
    vi.spyOn(document, 'createElement').mockImplementation(() => { throw new Error('no elements'); });
    const c = tracks.webCaps();
    expect(c.h264).toBe(false);
    expect(c.hdr).toBe(false);
    expect(c.mp3).toBe(false);
    expect(c.hevcLevel).toBe(153);
  });

  it('ManagedMediaSource alone is used when there is no MediaSource', async () => {
    const { tracks } = await freshImport({ modules: { tracks: 'src/lib/tracks.js' } });
    installMSE({ managed: 'only', supported: (m) => /avc1/.test(m) });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(tracks.webCaps().h264).toBe(true);
    expect(tracks.webCaps().aac).toBe(false);
  });
});

describe('fileDefaultAudio()', () => {
  it('the track flagged default, else the first by index, else -1', async () => {
    const { tracks } = await freshImport({ modules: { tracks: 'src/lib/tracks.js' } });
    const a = (Index, IsDefault = false) => ({ Type: 'Audio', Index, IsDefault });
    expect(tracks.fileDefaultAudio({ MediaStreams: [a(1), a(2, true), a(3)] })).toBe(2);
    expect(tracks.fileDefaultAudio({ MediaStreams: [{ Type: 'Video', Index: 0 }, a(2), a(4)] })).toBe(2);
    expect(tracks.fileDefaultAudio({ MediaStreams: [{ Type: 'Audio' }] })).toBe(-1);
    expect(tracks.fileDefaultAudio({ MediaStreams: [{ Type: 'Video', Index: 0 }] })).toBe(-1);
    expect(tracks.fileDefaultAudio({})).toBe(-1);
    expect(tracks.fileDefaultAudio(null)).toBe(-1);
  });
});
