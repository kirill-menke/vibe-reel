/* tracks.js: menu labels, language keys, tech badges and the small stream
 * helpers. The language rules matter beyond display: langKey() is how a
 * Settings value ('eng'), a Matroska tag ('ger', ISO 639-2/B) and another
 * muxer's /T or 2-letter tag ('deu', 'de') compare equal (settings.svelte.js). */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  pickSource, videoStream, streamByIndex, isAtmos, isCommentary, isSdh, needsBurnIn, isBurnCodec,
  codecPretty, chLayout, usefulTitle, audioLabel, subFmt, langName, langKey,
  resTier, resShort, resLabel, hdrLabel, audioBadge, heroBadges, tileTechBadge, describeTracks, groupSubs
} from '../../src/lib/tracks.js';
import { SET, DEFAULTS } from '../../src/lib/settings.svelte.js';
import { source, video, audio, sub, tracks, movie, episode, series, resetIds } from '../helpers/media.js';

beforeEach(() => {
  resetIds();
  Object.assign(SET, DEFAULTS);
});

/* fixtures: the tech mixes the badges are built for */
const v4kDv = () => video({ Width: 3840, Height: 2160, VideoRange: 'HDR', VideoRangeType: 'DOVIWithHDR10' });
const v4kHdr10 = () => video({ Width: 3840, Height: 1608, VideoRange: 'HDR', VideoRangeType: 'HDR10' });
const v1080Hdr10Plus = () => video({ Width: 1920, Height: 1080, VideoRange: 'HDR', VideoRangeType: 'HDR10Plus' });
const v1080Sdr = () => video({ Width: 1920, Height: 1080 });
const v720 = () => video({ Codec: 'h264', Width: 1280, Height: 720 });
const vHlg = () => video({ Width: 3840, Height: 2160, VideoRange: 'HDR', VideoRangeType: 'HLG' });

describe('codecPretty / chLayout', () => {
  it.each([
    ['eac3', 'DD+'], ['EAC3', 'DD+'], ['ac3', 'DD'], ['truehd', 'TrueHD'], ['dts', 'DTS'], ['aac', 'AAC'],
    ['flac', 'FLAC'], ['opus', 'Opus'], ['mp3', 'MP3'], ['pcm_s24le', 'PCM_S24LE'], ['', ''], [null, ''], [undefined, '']
  ])('codecPretty(%j) → %j', (c, want) => {
    expect(codecPretty(c)).toBe(want);
  });

  it.each([
    [{ ChannelLayout: 'stereo', Channels: 2 }, '2.0'],
    [{ ChannelLayout: 'mono', Channels: 1 }, 'Mono'],
    [{ ChannelLayout: 'quad', Channels: 4 }, '4.0'],
    [{ ChannelLayout: 'downmix', Channels: 2 }, '2.0'],
    [{ ChannelLayout: '5.1(side)', Channels: 6 }, '5.1'],
    [{ ChannelLayout: '7.1', Channels: 8 }, '7.1'],
    [{ ChannelLayout: '5.1.2', Channels: 8 }, '5.1.2'],
    [{ Channels: 6 }, '5.1'],
    [{ Channels: 8 }, '7.1'],
    [{ Channels: 2 }, '2.0'],
    [{ Channels: 1 }, 'Mono'],
    [{ Channels: 5 }, '5ch'],
    [{ ChannelLayout: 'hexagonal', Channels: 6 }, '5.1'],
    [{ ChannelLayout: 'hexagonal', Channels: 7 }, 'hexagonal'],
    [{}, '']
  ])('chLayout(%j) → %j', (s, want) => {
    expect(chLayout(s)).toBe(want);
  });
});

describe('usefulTitle / audioLabel', () => {
  it.each([
    ['', ''],
    ['English', ''],
    ['Surround 5.1', ''],
    ['DD+ Atmos 5.1', ''],
    ['English SDH', ''],
    ['English 640kbps', ''],
    ['Dolby TrueHD 7.1 Atmos', ''],
    ['Deutsch', 'Deutsch'],   // not in the language-name table: kept
    ['A', ''],               // nothing of length ≥ 2 left
    ['Signs & Songs', 'Signs & Songs'],
    ['Commentary with the director', 'Commentary with the director']
  ])('usefulTitle(%j) → %j', (title, want) => {
    expect(usefulTitle({ Title: title })).toBe(want);
  });

  it('a long title is cut to 38 characters + …', () => {
    const t = 'Director and cinematographer audio essay on the making of it';
    const out = usefulTitle({ Title: t });
    expect(out).toBe(t.slice(0, 38).trimEnd() + '…');
    expect(out.length).toBeLessThanOrEqual(39);
    expect(usefulTitle({ Title: 'x'.repeat(40) })).toBe('x'.repeat(40));
  });

  it('audioLabel: language · codec layout · Atmos · Commentary · title', () => {
    expect(audioLabel(tracks.eac3Atmos())).toBe('English · DD+ 5.1 · Atmos');
    expect(audioLabel(tracks.truehdAtmos())).toBe('English · TrueHD 7.1 · Atmos');
    expect(audioLabel(tracks.dtsHdMa())).toBe('English · DTS 5.1');
    expect(audioLabel(tracks.aacStereo({ Language: 'jpn' }))).toBe('Japanese · AAC 2.0');
    expect(audioLabel(tracks.commentary({ Title: 'Commentary' }))).toBe('English · DD 2.0 · Commentary');
    // the title already says "commentary": not repeated
    expect(audioLabel(tracks.commentary())).toBe('English · DD 2.0 · Commentary with the director');
    expect(audioLabel(audio({ Codec: 'ac3', Language: '', Channels: 6, ChannelLayout: '' }))).toBe('Unknown · DD 5.1');
  });
});

describe('subFmt / langName / langKey', () => {
  it.each([
    ['subrip', 'SRT'], ['srt', 'SRT'], ['pgssub', 'PGS'], ['PGSSUB', 'PGS'], ['pgs', 'PGS'],
    ['dvdsub', 'DVD'], ['vobsub', 'DVD'], ['dvd_subtitle', 'DVD'], ['dvbsub', 'DVB'], ['dvb_subtitle', 'DVB'], ['DVB_SUBTITLE', 'DVB'],
    ['ass', 'ASS'], ['ssa', 'SSA'], ['vtt', 'VTT'], ['mov_text', 'MOV_TEXT'], ['', ''], [null, '']
  ])('subFmt(%j) → %j', (c, want) => {
    expect(subFmt(c)).toBe(want);
  });

  it('ISO 639-2/B, 639-2/T and 639-1 aliases collapse onto one name and one key', () => {
    for (const [codes, name] of [
      [['ger', 'deu', 'de', 'GER'], 'German'],
      [['fre', 'fra', 'fr'], 'French'],
      [['dut', 'nld', 'nl'], 'Dutch'],
      [['chi', 'zho', 'zh'], 'Chinese'],
      [['cze', 'ces', 'cs'], 'Czech'],
      [['eng', 'en', 'ENG'], 'English'],
      [['jpn', 'ja'], 'Japanese'],
      [['nor', 'nob', 'no', 'nb'], 'Norwegian'],
      [['ice', 'isl', 'is'], 'Icelandic']
    ]) {
      for (const c of codes) {
        expect(langName(c)).toBe(name);
        expect(langKey(c)).toBe(name);
      }
    }
  });

  it("an unknown code is shown upper-cased; '' and null are 'Unknown'", () => {
    expect(langName('xx')).toBe('XX');
    expect(langName('')).toBe('Unknown');
    expect(langName(null)).toBe('Unknown');
    expect(langName('und')).toBe('Unknown');
  });

  it("langKey: 'und', '' and missing are '' (never collide with a real language)", () => {
    expect(langKey('und')).toBe('');
    expect(langKey('UND')).toBe('');
    expect(langKey('')).toBe('');
    expect(langKey(null)).toBe('');
    expect(langKey(undefined)).toBe('');
    expect(langKey('xx')).toBe('XX');
  });
});

describe('resolution and HDR', () => {
  it.each([
    [3840, 2160, '2160p', '4K', '4K 2160p'],
    [3840, 1600, '2160p', '4K', '4K 2160p'],   // scope 4K: by width
    [3200, 0, '2160p', '4K', '4K 2160p'],
    [0, 1800, '2160p', '4K', '4K 2160p'],
    [1920, 1080, '1080p', '1080p', '1080p'],
    [1920, 816, '1080p', '1080p', '1080p'],    // scope 1080p is not "816p"
    [1440, 1080, '1080p', '1080p', '1080p'],
    [1280, 720, '720p', '720p', '720p'],
    [1280, 534, '720p', '720p', '720p'],
    [720, 576, '480p', '480p', '480p'],
    [640, 360, '480p', '480p', '480p'],
    [320, 240, '240p', '240p', '240p'],
    [0, 0, '', '', ''],
    [undefined, undefined, '', '', '']
  ])('%s×%s → %s / %s / %s', (w, h, tier, short, label) => {
    expect(resTier(w, h)).toBe(tier);
    expect(resShort(w, h)).toBe(short);
    expect(resLabel(w, h)).toBe(label);
  });

  it('hdrLabel reads VideoRangeType (falling back to VideoRange) and a "Dolby Vision" title', () => {
    expect(hdrLabel(v4kDv())).toBe('Dolby Vision');
    expect(hdrLabel(video({ VideoRangeType: 'DOVI' }))).toBe('Dolby Vision');
    expect(hdrLabel(video({ VideoRangeType: 'SDR', Title: 'Dolby Vision P5' }))).toBe('Dolby Vision');
    expect(hdrLabel(v4kHdr10())).toBe('HDR10');
    expect(hdrLabel(v1080Hdr10Plus())).toBe('HDR10');
    expect(hdrLabel(vHlg())).toBe('HLG');
    expect(hdrLabel(v1080Sdr())).toBe('');
    expect(hdrLabel({ VideoRange: 'HDR' })).toBe('');
    expect(hdrLabel({})).toBe('');
  });
});

describe('audioBadge / heroBadges / tileTechBadge', () => {
  it('audioBadge: DD+ / DD / DTS, + Atmos', () => {
    expect(audioBadge(tracks.eac3Atmos())).toBe('DD+ Atmos');
    expect(audioBadge(tracks.eac3())).toBe('DD+');
    expect(audioBadge(tracks.ac3())).toBe('DD');
    expect(audioBadge(tracks.dtsHdMa())).toBe('DTS');
    expect(audioBadge(tracks.aacStereo())).toBe('AAC');
    expect(audioBadge(audio({ Codec: 'flac' }))).toBe('FLAC');
    expect(audioBadge(null)).toBe('');
    expect(audioBadge(undefined)).toBe('');
  });

  // User decision 2026-10-04 (V-F4): the badge names the file's codec, as the
  // audio menu does ("English · TrueHD 7.1 · Atmos"), not "DD+".
  it('audioBadge: a TrueHD track badges as TrueHD, + Atmos', () => {
    expect(audioBadge(tracks.truehdAtmos())).toBe('TrueHD Atmos');
    expect(audioBadge(audio({ Codec: 'truehd' }))).toBe('TrueHD');
    expect(audioBadge(audio({ Codec: 'TRUEHD' }))).toBe('TrueHD');
  });

  it('heroBadges: a file whose only audio is TrueHD Atmos → "TrueHD Atmos"', () => {
    const m = movie({ MediaSources: [source([v4kDv(), tracks.truehdAtmos({ IsDefault: true })])] });
    expect(heroBadges(m)).toEqual(['4K', 'Dolby Vision', 'TrueHD Atmos']);
  });

  it('heroBadges: 4K DV with a default TrueHD Atmos and a DD+ Atmos → the DD+ track is the badge', () => {
    const m = movie({ MediaSources: [source([v4kDv(), tracks.truehdAtmos({ IsDefault: true }), tracks.eac3Atmos()])] });
    expect(heroBadges(m)).toEqual(['4K', 'Dolby Vision', 'DD+ Atmos']);
  });

  it('heroBadges: HDR10 scope 4K with DTS-HD; SDR 1080p DD+; 720p AAC', () => {
    expect(heroBadges(movie({ MediaSources: [source([v4kHdr10(), tracks.dtsHdMa()])] }))).toEqual(['4K', 'HDR10', 'DTS']);
    expect(heroBadges(movie({ MediaSources: [source([v1080Sdr(), tracks.eac3()])] }))).toEqual(['1080p', 'DD+']);
    expect(heroBadges(movie({ MediaSources: [source([v720(), tracks.aacStereo()])] }))).toEqual(['720p', 'AAC']);
  });

  it('heroBadges: the ctx item lends the genres for the audio pick (anime episode → Japanese track)', () => {
    const src = source([v1080Sdr(), audio({ Codec: 'aac', Language: 'jpn', IsDefault: true }), tracks.eac3Atmos()]);
    const ep = episode({ MediaSources: [src] });
    expect(heroBadges(ep)).toEqual(['1080p', 'DD+ Atmos']);
    expect(heroBadges(ep, series({ Genres: ['Anime'] }))).toEqual(['1080p', 'AAC']);
  });

  it('heroBadges: no video stream → audio only; no source → nothing', () => {
    expect(heroBadges(movie({ MediaSources: [source([tracks.eac3()])] }))).toEqual(['DD+']);
    expect(heroBadges(movie({ MediaSources: [] }))).toEqual([]);
    expect(heroBadges({})).toEqual([]);
  });

  it('tileTechBadge: resolution · DV / HDR10 (HLG and SDR show the resolution only)', () => {
    const t = (v) => tileTechBadge(movie({ MediaSources: [source([v, tracks.eac3()])] }));
    expect(t(v4kDv())).toBe('4K · DV');
    expect(t(v4kHdr10())).toBe('4K · HDR10');
    expect(t(v1080Hdr10Plus())).toBe('1080p · HDR10');
    expect(t(vHlg())).toBe('4K');
    expect(t(v1080Sdr())).toBe('1080p');
    expect(t(video({ Width: 0, Height: 0, VideoRangeType: 'DOVI' }))).toBe('DV');
    expect(tileTechBadge(movie({ MediaSources: [] }))).toBe('');
    expect(tileTechBadge(movie({ MediaSources: [source([tracks.eac3()])] }))).toBe('');
  });

  it("describeTracks' video line: codec · display title or height · range", () => {
    expect(describeTracks(source([video({ Codec: 'hevc', Height: 2160, VideoRange: 'HDR' })]), null).video).toBe('HEVC · 2160p · HDR');
    expect(describeTracks(source([video({ Codec: 'h264', DisplayTitle: '1080p H264 SDR' })]), null).video).toBe('H264 · 1080p H264 SDR');
    expect(describeTracks(source([{ Type: 'Video' }]), null).video).toBe('');
  });
});

describe('groupSubs — the subtitle menu order', () => {
  const subsOf = (list) => describeTracks(source([video(), audio(), ...list]), null).subs;

  it('None, the Settings subtitle language, the audio language, then the rest (file order inside groups)', () => {
    const subs = subsOf([
      sub({ Language: 'fre' }),       // 2
      sub({ Language: 'jpn' }),       // 3
      sub({ Language: 'eng' }),       // 4
      sub({ Language: 'ger' }),       // 5
      sub({ Language: 'eng', IsForced: true }), // 6
      sub({ Language: 'ja' })         // 7
    ]);
    const g = groupSubs(subs, 'jpn');
    expect(g.top.map((s) => s.index)).toEqual([-1, 4, 6, 3, 7]);
    expect(g.more.map((s) => s.index)).toEqual([2, 5]);
  });

  it('audio in the subtitle language adds no extra group; untagged audio neither', () => {
    const subs = subsOf([sub({ Language: 'ger' }), sub({ Language: 'eng' })]);
    expect(groupSubs(subs, 'eng').top.map((s) => s.index)).toEqual([-1, 3]);
    expect(groupSubs(subs, 'en').more.map((s) => s.index)).toEqual([2]);
    expect(groupSubs(subs, '').top.map((s) => s.index)).toEqual([-1, 3]);
    expect(groupSubs(subs, 'und').more.map((s) => s.index)).toEqual([2]);
  });

  it('follows SET.subLang (any alias)', () => {
    SET.subLang = 'deu';
    const subs = subsOf([sub({ Language: 'eng' }), sub({ Language: 'ger' })]);
    const g = groupSubs(subs, 'eng');
    expect(g.top.map((s) => s.index)).toEqual([-1, 3, 2]);
    expect(g.more).toEqual([]);
  });
});

describe('stream helpers — edge cases', () => {
  it('pickSource: the first MediaSource, or null', () => {
    const s = source();
    expect(pickSource({ MediaSources: [s, source()] })).toBe(s);
    expect(pickSource({ MediaSources: [] })).toBeNull();
    expect(pickSource({})).toBeNull();
  });

  it('videoStream / streamByIndex tolerate null sources and missing MediaStreams', () => {
    const s = source([audio(), video({ Codec: 'av1' })]);
    expect(videoStream(s).Codec).toBe('av1');
    expect(videoStream(source([audio()]))).toBeNull();
    expect(videoStream(null)).toBeNull();
    expect(videoStream({})).toBeNull();
    expect(streamByIndex(s, 0).Type).toBe('Audio');
    expect(streamByIndex(s, 7)).toBeNull();
    expect(streamByIndex(null, 0)).toBeNull();
    expect(streamByIndex({}, 0)).toBeNull();
  });

  it('isAtmos / isCommentary / isSdh read Profile, Title and DisplayTitle (as each does)', () => {
    expect(isAtmos({})).toBe(false);
    expect(isAtmos({ Profile: 'Dolby Digital Plus + Dolby Atmos' })).toBe(true);
    expect(isAtmos({ Title: 'ATMOS' })).toBe(true);
    expect(isAtmos({ DisplayTitle: 'English - Dolby Atmos' })).toBe(true);
    expect(isCommentary({})).toBe(false);
    expect(isCommentary({ DisplayTitle: 'Director’s Commentary' })).toBe(true);
    expect(isCommentary({ Title: 'commentary' })).toBe(true);
    expect(isSdh({})).toBe(false);
    expect(isSdh({ Title: 'English [SDH]' })).toBe(true);
    expect(isSdh({ Title: 'Hearing impaired' })).toBe(true);
    expect(isSdh({ DisplayTitle: 'English SDH' })).toBe(false);   // Title only
    expect(isSdh({ Title: 'English', IsHearingImpaired: true })).toBe(true);   // Jellyfin 10.9+ flag (V-F3)
    expect(isSdh({ Title: 'English', IsHearingImpaired: false })).toBe(false);
  });

  it('needsBurnIn: only a VobSub/DVB/xsub index that exists', () => {
    const s = source([video(), audio(), tracks.pgs(), tracks.vobsub(), tracks.dvbsub(), sub({ Codec: 'xsub' }), sub()]);
    expect(needsBurnIn(s, -1)).toBe(false);
    expect(needsBurnIn(s, 2)).toBe(false);
    expect(needsBurnIn(s, 3)).toBe(true);
    expect(needsBurnIn(s, 4)).toBe(true);
    expect(needsBurnIn(s, 5)).toBe(true);
    expect(needsBurnIn(s, 6)).toBe(false);
    expect(needsBurnIn(s, 42)).toBe(false);
    expect(needsBurnIn(null, 3)).toBe(false);
    expect(isBurnCodec(null)).toBe(false);
    expect(isBurnCodec('subrip')).toBe(false);
  });
});
