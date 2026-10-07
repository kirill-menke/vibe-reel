/* tracks.js: the edge cases the mutation run (oracle-mutants-core) showed the
 * other tracks.* files left open. Each case names the behaviour it protects:
 *
 * - the audio default: DD+/Atmos preference and AC3's +1 over DTS within one
 *   language (CLAUDE.md: "the Mad Men AC3 commentaries used to beat its DTS-HD
 *   main track" — the +1 is exactly what made that happen, the −16 what fixes it),
 *   the anime→Japanese default read off the container's default track;
 * - the auto subtitle rule: audio in the Settings *subtitle* language counts as
 *   understood (forced only), not just audio in the audio language;
 * - menu labels: ffmpeg layout names without a channel count, the title-noise
 *   filter (a Title repeating language/codec/"Main"/"Original" is not shown),
 *   duplicate audio rows numbered like subtitle rows, non-audio/sub streams
 *   (cover art) never becoming subtitle rows;
 * - language aliases collapsing onto one name (every pair in the table);
 * - resolution tiers with inclusive thresholds and a missing width. */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  chLayout, usefulTitle, audioLabel, langName, langKey, needsBurnIn, preferredAudioLang, describeTracks,
  pickDefaultSub, resTier, hdrLabel, heroBadges, audioBadge, tileTechBadge, groupSubs
} from '../../src/lib/tracks.js';
import { SET, DEFAULTS } from '../../src/lib/settings.svelte.js';
import { source, video, audio, sub, tracks as T, movie, series, resetIds } from '../helpers/media.js';

beforeEach(() => {
  resetIds();
  Object.assign(SET, DEFAULTS);
});

describe('chLayout: the layout name alone is enough', () => {
  // Jellyfin normally sends Channels too, but a probe-built source (pendingplay)
  // or a stream without a count must still read as numbers people know.
  it.each([
    [{ ChannelLayout: 'mono' }, 'Mono'],
    [{ ChannelLayout: 'stereo' }, '2.0'],
    [{ ChannelLayout: 'downmix' }, '2.0'],
    [{ ChannelLayout: '5.1(side)' }, '5.1'],
    [{ ChannelLayout: '7.1(wide)' }, '7.1'],
    [{ ChannelLayout: '5.1 (side)' }, '5.1'],
    [{ ChannelLayout: '5.1.2' }, '5.1.2']
  ])('%j → %j', (s, want) => {
    expect(chLayout(s)).toBe(want);
  });

  it('a named layout with a suffix wins over a channel count the table does not know', () => {
    // 4 channels have no numeric fallback; 'quad(side)' must still read 4.0
    expect(chLayout({ ChannelLayout: 'quad(side)', Channels: 4 })).toBe('4.0');
  });

  it('a label without any layout or count carries no trailing separator', () => {
    const a = audio({ Codec: 'eac3', ChannelLayout: '', Channels: undefined });
    expect(audioLabel(a)).toBe('English · DD+');
  });
});

describe('usefulTitle: titles that only repeat what the label says are dropped', () => {
  it.each([
    'Original', 'Main', 'Audio', 'English Track', 'Commentary', 'Stereo 2 ch', 'The English',
    'English and German', 'With Atmos', 'Subs for English',
    // ISO codes as muxers write them count as language words too
    'ENG', 'ger / jpn',
    // bitrates and bit depths are numbers, not information
    'Dolby Digital 640', 'FLAC 24-bit', 'DTS-HD MA 5.1 1536kbps',
    // codec / format / role words as muxers write them
    'Full', 'Sub', 'Default', 'Dialogue', 'Dialog', 'Mono', 'Dolby Digital Plus', 'True HD', 'DTS', 'DTS ES',
    'AAC', 'AC3', 'AC-3', 'EAC3', 'E-AC-3', 'E-AC3', 'DD', 'DDP', 'Opus', 'PCM', 'LPCM', 'MP3',
    'Subtitle', 'Subtitles', 'CC', 'Forced', 'SRT', 'PGS', 'ASS', 'SSA', 'VTT', 'VobSub', 'Text',
    '640 kbps', 'Channel', '6 Channels'
  ])('%j → ""', (Title) => {
    expect(usefulTitle({ Title })).toBe('');
  });

  it.each([
    ['2nd Commentary', '2nd Commentary'],
    ['English US', 'English US'],
    ['  Signs & Songs  ', 'Signs & Songs']
  ])('%j is shown as %j', (Title, want) => {
    expect(usefulTitle({ Title })).toBe(want);
  });

  it('a long title is cut at 38 characters with the ellipsis right after the last word', () => {
    const Title = 'Director and producer commentary with the cast and crew';
    expect(Title[37]).toBe(' ');
    expect(usefulTitle({ Title })).toBe('Director and producer commentary with…');
  });
});

describe('langName / langKey: every alias of a language collapses onto one name', () => {
  const GROUPS = {
    Arabic: ['ara', 'ar'], Bulgarian: ['bul', 'bg'], Czech: ['ces', 'cze', 'cs'], Chinese: ['chi', 'zho', 'zh'],
    Danish: ['dan', 'da'], German: ['deu', 'ger', 'de'], Greek: ['ell', 'gre', 'el'], English: ['eng', 'en'],
    Estonian: ['est', 'et'], Finnish: ['fin', 'fi'], French: ['fra', 'fre', 'fr'], Hebrew: ['heb', 'he'],
    Hindi: ['hin', 'hi'], Croatian: ['hrv', 'hr'], Hungarian: ['hun', 'hu'], Indonesian: ['ind', 'id'],
    Italian: ['ita', 'it'], Japanese: ['jpn', 'ja'], Korean: ['kor', 'ko'], Latvian: ['lav', 'lv'],
    Lithuanian: ['lit', 'lt'], Dutch: ['nld', 'dut', 'nl'], Norwegian: ['nor', 'nob', 'no', 'nb'],
    Polish: ['pol', 'pl'], Portuguese: ['por', 'pt'], Romanian: ['ron', 'rum', 'ro'], Russian: ['rus', 'ru'],
    Slovak: ['slk', 'slo', 'sk'], Slovenian: ['slv', 'sl'], Spanish: ['spa', 'es'], Serbian: ['srp', 'sr'],
    Swedish: ['swe', 'sv'], Thai: ['tha', 'th'], Turkish: ['tur', 'tr'], Ukrainian: ['ukr', 'uk'],
    Vietnamese: ['vie', 'vi'], Icelandic: ['isl', 'ice', 'is'], Catalan: ['cat', 'ca'], Basque: ['eus', 'baq', 'eu'],
    Galician: ['glg', 'gl'], Malay: ['msa', 'may', 'ms'], Filipino: ['fil', 'tgl', 'tl'], Persian: ['fas', 'per', 'fa'],
    Urdu: ['urd', 'ur'], Bengali: ['ben', 'bn'], Tamil: ['tam', 'ta'], Telugu: ['tel', 'te']
  };
  it.each(Object.entries(GROUPS))('%s', (name, codes) => {
    for (const c of codes) {
      expect(langName(c)).toBe(name);
      expect(langName(c.toUpperCase())).toBe(name);
      expect(langKey(c)).toBe(name);
    }
  });
});

describe('the audio default (score + preferredAudioLang)', () => {
  it('DD+ Atmos beats a plain DD+ in the same language even when listed second', () => {
    const src = source([video(), T.eac3({ Title: 'Main' }), T.eac3Atmos()]);
    expect(describeTracks(src, movie()).defaultAudio).toBe(2);
  });

  it('within one language AC3 outranks DTS (the +1 the commentary −16 has to outweigh)', () => {
    const src = source([video(), T.dtsHdMa(), T.ac3()]);
    expect(describeTracks(src, movie()).defaultAudio).toBe(2);
  });

  it('anime: the container DEFAULT track decides, not the first one', () => {
    const src = source([video(), audio({ Language: 'eng' }), audio({ Language: 'jpn', IsDefault: true })]);
    const anime = series({ Genres: ['Anime'] });
    expect(preferredAudioLang(anime, src)).toBe('Japanese');
    expect(describeTracks(src, anime).defaultAudio).toBe(2);
    // with no default flag the first track is the signal
    const plain = source([video(), audio({ Language: 'eng' }), audio({ Language: 'jpn' })]);
    expect(preferredAudioLang(anime, plain)).toBe('English');
  });

  it('anime without a source falls back to the Settings language', () => {
    expect(preferredAudioLang(series({ Genres: ['Animation'] }), null)).toBe('English');
    SET.audioLang = 'ger';
    expect(preferredAudioLang(series({ Genres: ['Animation'] }), undefined)).toBe('German');
  });

  it('an empty or untagged Settings language means English', () => {
    const src = source([video(), audio({ Language: 'ger', Codec: 'eac3' }), audio({ Language: 'eng', Codec: 'aac' })]);
    for (const v of ['', 'und']) {
      SET.audioLang = v;
      expect(preferredAudioLang(movie(), src)).toBe('English');
      expect(describeTracks(src, movie()).defaultAudio).toBe(2);
    }
  });
});

describe('pickDefaultSub: auto mode', () => {
  it('audio in the Settings subtitle language is understood: forced only, no full subs', () => {
    SET.subLang = 'ger';
    SET.audioLang = 'eng';
    const src = source([video(), audio({ Language: 'ger' }), sub({ Language: 'ger' }), sub({ Language: 'ger', IsForced: true })]);
    expect(pickDefaultSub(src, 1)).toBe(3);
  });

  it('an empty / untagged Settings subtitle language means English', () => {
    const src = source([video(), audio({ Language: 'jpn' }), sub({ Language: 'ger' }), sub({ Language: 'eng' })]);
    for (const v of ['', 'und']) {
      SET.subLang = v;
      SET.audioLang = v;
      expect(pickDefaultSub(src, 1)).toBe(3);
    }
  });
});

describe('describeTracks rows', () => {
  it('two audio tracks that read the same are numbered like subtitle rows', () => {
    const src = source([video(), T.eac3(), T.eac3()]);
    const labels = describeTracks(src, movie()).audio.map((a) => a.label);
    expect(labels).toStrictEqual(['English · DD+ 5.1', 'English 2 · DD+ 5.1']);
  });

  it('cover art / attachments never become subtitle rows', () => {
    const src = source([video(), audio(), { Type: 'EmbeddedImage', Codec: 'mjpeg' }, { Type: 'Data', Codec: 'bin_data' }, sub()]);
    const t = describeTracks(src, movie());
    expect(t.subs.map((s) => s.index)).toStrictEqual([-1, 4]);
  });

  it('a stream without codec or language: empty codec / lang fields, Unknown label', () => {
    const src = source([video(), { Type: 'Audio' }, { Type: 'Subtitle' }]);
    const t = describeTracks(src, movie());
    // an empty codec part is left out, not joined as a dangling ' · ' (V-F10)
    expect(t.audio).toStrictEqual([{ index: 1, codec: '', atmos: false, commentary: false, lang: '', label: 'Unknown' }]);
    expect(t.subs[1]).toStrictEqual({ index: 2, codec: '', lang: '', forced: false, burn: false, label: 'Unknown' });
    expect(audioLabel({ Type: 'Audio' })).toBe('Unknown');
  });

  it('a codec-less English stream reads "English", with a layout "English · 5.1" (V-F10)', () => {
    const en = { Type: 'Audio', Language: 'eng' };
    expect(audioLabel(en)).toBe('English');
    expect(describeTracks(source([video(), en]), movie()).audio[0].label).toBe('English');
    expect(audioLabel({ ...en, Channels: 6 })).toBe('English · 5.1');
  });

  it('a source without MediaStreams describes nothing', () => {
    expect(describeTracks({ Id: 'x' }, movie())).toStrictEqual({
      audio: [], subs: [{ label: 'None', index: -1, lang: '' }], video: '', defaultAudio: -1, defaultSub: -1
    });
  });

  it("PGS is named whichever codec name the muxer used ('pgssub' or 'pgs')", () => {
    const src = source([video(), audio(), sub({ Codec: 'pgs' }), sub({ Codec: 'pgssub', Language: 'ger' })]);
    expect(describeTracks(src, movie()).subs.map((s) => s.label)).toStrictEqual(['None', 'English · PGS', 'German · PGS']);
  });
});

describe('needsBurnIn', () => {
  it('any non-negative index is looked up (an external VobSub can sit at index 0)', () => {
    const src = source([T.vobsub(), video(), audio()]);
    expect(needsBurnIn(src, 0)).toBe(true);
    expect(needsBurnIn(src, -1)).toBe(false);
  });
});

describe('resTier: inclusive thresholds, height decides when the width is missing', () => {
  it.each([
    [1800, 0, '1080p'], [0, 1000, '1080p'], [1799, 999, '720p'],
    [1200, 0, '720p'], [0, 700, '720p'], [960, 720, '720p'], [0, 720, '720p'],
    [0, 460, '480p'], [0, 576, '480p'], [0, 459, '459p']
  ])('%i×%i → %s', (w, h, want) => {
    expect(resTier(w, h)).toBe(want);
  });
});

describe('badges', () => {
  it("hdrLabel reads 'DolbyVision' (no space) in a title as Dolby Vision", () => {
    expect(hdrLabel({ VideoRange: 'HDR', Title: 'DolbyVision HDR' })).toBe('Dolby Vision');
    expect(hdrLabel({})).toBe('');
  });

  it('a video stream without dimensions adds no empty resolution badge', () => {
    const it0 = movie({ MediaSources: [source([video({ Width: undefined, Height: undefined, VideoRangeType: 'HDR10' }), T.eac3()])] });
    expect(heroBadges(it0)).toStrictEqual(['HDR10', 'DD+']);
  });

  it('codec-less audio and range-less video badge as nothing', () => {
    expect(audioBadge({ Type: 'Audio' })).toBe('');
    const m = movie({ MediaSources: [source([{ Type: 'Video', Width: 1920, Height: 1080 }])] });
    expect(tileTechBadge(m)).toBe('1080p');
  });
});

describe('groupSubs', () => {
  it('an empty Settings subtitle language groups English first', () => {
    SET.subLang = '';
    const subs = [{ index: -1, lang: '' }, { index: 3, lang: 'ger' }, { index: 4, lang: 'eng' }];
    expect(groupSubs(subs, 'ger')).toStrictEqual({ top: [subs[0], subs[2], subs[1]], more: [] });
  });
});
