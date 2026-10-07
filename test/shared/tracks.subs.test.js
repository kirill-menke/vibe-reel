/* tracks.js: the default subtitle (pickDefaultSub, by SET.subMode) and the
 * subtitle rows describeTracks() builds for the player menu. CLAUDE.md /
 * settings.svelte.js: 'auto' = forced subs, or full ones when the audio isn't
 * in a language the viewer understands; a container "default" flag alone never
 * turns subs on (a whole series flagged English SDH default on English audio);
 * VobSub/DVB are never auto-picked (they would start a burn-in transcode). */
import { describe, it, expect, beforeEach } from 'vitest';
import { pickDefaultSub, describeTracks } from '../../src/lib/tracks.js';
import { SET, DEFAULTS } from '../../src/lib/settings.svelte.js';
import { source, video, audio, sub, tracks, series, resetIds } from '../helpers/media.js';

beforeEach(() => {
  resetIds();
  Object.assign(SET, DEFAULTS);
});

/* video 0, one audio track 1 in `lang`, then `subs` from index 2 */
const mk = (lang, subs) => source([video(), audio({ Language: lang }), ...subs]);
const pick = (lang, subs) => pickDefaultSub(mk(lang, subs), 1);
const eng = (o) => sub({ Language: 'eng', ...o });
const engForced = (o) => sub({ Language: 'eng', IsForced: true, Title: 'Forced', ...o });

describe("pickDefaultSub — subMode 'auto' (the default)", () => {
  it('audio in the subtitle language → the forced track only', () => {
    expect(pick('eng', [eng(), engForced()])).toBe(3);
  });

  it('audio in the subtitle language and no forced track → no subtitles', () => {
    expect(pick('eng', [eng(), sub({ Language: 'ger' })])).toBe(-1);
  });

  it('a container IsDefault flag alone never turns subs on (English SDH default on English audio)', () => {
    expect(pick('eng', [tracks.sdh({ IsDefault: true })])).toBe(-1);
    expect(pick('eng', [eng({ IsDefault: true })])).toBe(-1);
  });

  it('untagged audio counts as understood: forced only', () => {
    expect(pick('', [eng()])).toBe(-1);
    expect(pick('und', [eng()])).toBe(-1);
    expect(pick('und', [eng(), engForced()])).toBe(3);
  });

  it('audio in the Settings audio language (≠ subtitle language) counts as understood', () => {
    SET.audioLang = 'ger';
    SET.subLang = 'eng';
    expect(pick('ger', [eng(), sub({ Language: 'ger' })])).toBe(-1);
    expect(pick('ger', [eng(), sub({ Language: 'ger', IsForced: true })])).toBe(3);
  });

  it('foreign audio → full subtitles in the subtitle language, not the forced ones', () => {
    expect(pick('jpn', [engForced(), eng()])).toBe(3);
    expect(pick('kor', [eng(), sub({ Language: 'kor' })])).toBe(2);
  });

  it('foreign audio and only a forced subLang track → that forced track', () => {
    expect(pick('ita', [engForced()])).toBe(2);
  });

  it('foreign audio and no subLang subtitles at all → none (other languages are not offered by default)', () => {
    expect(pick('ita', [sub({ Language: 'ita' }), sub({ Language: 'fre' })])).toBe(-1);
  });

  it('forced tracks are searched in the audio language first, then the subtitle language', () => {
    SET.subLang = 'ger';
    // English audio is the Settings audio language → understood → forced only
    const both = [sub({ Language: 'ger', IsForced: true }), engForced()];
    expect(pick('eng', both)).toBe(3);
    expect(pick('eng', [sub({ Language: 'ger', IsForced: true }), sub({ Language: 'fre', IsForced: true })])).toBe(2);
  });

  it('a forced track in a third language is never picked', () => {
    expect(pick('eng', [sub({ Language: 'fre', IsForced: true })])).toBe(-1);
  });

  it('language aliases collapse: "en" audio and "en" subtitles match Settings "eng"', () => {
    expect(pick('en', [sub({ Language: 'en' }), sub({ Language: 'en', IsForced: true })])).toBe(3);
    expect(pick('ja', [sub({ Language: 'en' })])).toBe(2);
    SET.subLang = 'ger';
    expect(pick('jpn', [sub({ Language: 'deu' })])).toBe(2);
  });

  it('an audio index that is not in the file behaves like untagged audio', () => {
    expect(pickDefaultSub(mk('jpn', [eng()]), 99)).toBe(-1);
    expect(pickDefaultSub(mk('jpn', [eng(), engForced()]), -1)).toBe(3);
  });
});

describe("pickDefaultSub — 'always' and 'off'", () => {
  it("always: full subLang subtitles whenever present, before forced", () => {
    SET.subMode = 'always';
    expect(pick('eng', [engForced(), eng()])).toBe(3);
    expect(pick('jpn', [engForced(), eng()])).toBe(3);
  });

  it('always: falls back to a forced track (audio language first) when no full one exists', () => {
    SET.subMode = 'always';
    expect(pick('eng', [engForced()])).toBe(2);
    expect(pick('jpn', [sub({ Language: 'jpn', IsForced: true }), engForced()])).toBe(2);
    expect(pick('eng', [sub({ Language: 'ger' })])).toBe(-1);
  });

  it('off: forced tracks only, even on foreign audio', () => {
    SET.subMode = 'off';
    expect(pick('jpn', [eng()])).toBe(-1);
    expect(pick('jpn', [eng(), engForced()])).toBe(3);
    expect(pick('eng', [eng({ IsDefault: true }), engForced()])).toBe(3);
  });

  it("an empty subMode means auto; an unknown one gets forced subtitles only", () => {
    SET.subMode = '';
    expect(pick('jpn', [engForced(), eng()])).toBe(3);
    SET.subMode = 'bogus';
    expect(pick('jpn', [engForced(), eng()])).toBe(2);
  });
});

describe('pickDefaultSub — burn-in codecs and ranking', () => {
  it('VobSub / DVB / xsub are never auto-picked, even as the only subLang track', () => {
    for (const codec of ['dvd_subtitle', 'dvdsub', 'vobsub', 'dvbsub', 'dvb_subtitle', 'xsub', 'DVDSUB']) {
      expect(pick('jpn', [sub({ Language: 'eng', Codec: codec })])).toBe(-1);
    }
    SET.subMode = 'always';
    expect(pick('eng', [tracks.vobsub({ IsForced: true }), tracks.dvbsub()])).toBe(-1);
  });

  it('a PGS track is picked like a text track; a VobSub beside it is skipped', () => {
    expect(pick('jpn', [tracks.vobsub(), tracks.pgs()])).toBe(3);
  });

  it('non-SDH beats SDH regardless of order', () => {
    expect(pick('jpn', [tracks.sdh(), eng()])).toBe(3);
    expect(pick('jpn', [eng(), tracks.sdh()])).toBe(2);
  });

  it('IsDefault breaks a tie between equal tracks; otherwise the lower Index wins', () => {
    expect(pick('jpn', [eng(), eng({ IsDefault: true })])).toBe(3);
    expect(pick('jpn', [eng(), eng()])).toBe(2);
    expect(pick('jpn', [eng({ Index: 9 }), eng({ Index: 4 })])).toBe(4);
  });

  it('an SDH track flagged default still loses to a plain one (SDH outweighs IsDefault)', () => {
    expect(pick('jpn', [tracks.sdh({ IsDefault: true }), eng()])).toBe(3);
  });

  it('SDH is recognised by "hearing" in the title too', () => {
    expect(pick('jpn', [eng({ Title: 'English (Hearing Impaired)' }), eng({ Title: 'Dialogue' })])).toBe(3);
  });

  it("SDH is recognised by Jellyfin's IsHearingImpaired flag with a plain title (V-F3)", () => {
    const flagged = eng({ Title: 'English', IsHearingImpaired: true });
    expect(pick('jpn', [flagged, eng()])).toBe(3);
    const d = describeTracks(mk('jpn', [eng({ Title: 'English', IsHearingImpaired: true }), eng()]), null);
    expect(d.subs[1].label).toContain('SDH');
    expect(d.subs[2].label).not.toContain('SDH');
  });

  it('no subtitles, no streams, no source → -1', () => {
    expect(pick('jpn', [])).toBe(-1);
    expect(pickDefaultSub({ Id: 'x' }, 1)).toBe(-1);
    expect(pickDefaultSub(null, 1)).toBe(-1);
  });
});

describe('describeTracks — subtitle rows', () => {
  it('None comes first, then the file’s subtitle streams in file order', () => {
    const d = describeTracks(mk('eng', [eng(), sub({ Language: 'ger' })]), null);
    expect(d.subs[0]).toEqual({ label: 'None', index: -1, lang: '' });
    expect(d.subs.map((s) => s.index)).toEqual([-1, 2, 3]);
    expect(d.subs.map((s) => s.label)).toEqual(['None', 'English', 'German']);
  });

  it('labels name SDH, Forced, PGS and burn-in formats (text codecs are not named)', () => {
    const d = describeTracks(
      mk('eng', [
        tracks.sdh(),
        engForced(),
        tracks.pgs(),
        tracks.vobsub(),
        sub({ Language: 'eng', Codec: 'dvbsub', IsTextSubtitleStream: false }),
        sub({ Language: 'eng', Codec: 'ass' })
      ]),
      null
    );
    expect(d.subs.slice(1).map((s) => s.label)).toEqual([
      'English · SDH',
      'English · Forced',
      'English · PGS',
      'English · DVD · burn-in',
      'English · DVB · burn-in',
      'English'
    ]);
  });

  it("ffprobe's 'dvb_subtitle' reads as DVB like 'dvbsub', not DVB_SUBTITLE (V-F2)", () => {
    const d = describeTracks(mk('eng', [tracks.dvbsub({ Language: 'eng' })]), null);
    expect(d.subs.slice(1).map((s) => s.label)).toEqual(['English · DVB · burn-in']);
  });

  it('a useful stream title is kept; one that repeats language/flags is not', () => {
    const d = describeTracks(
      mk('jpn', [sub({ Language: 'eng', Title: 'Signs & Songs' }), sub({ Language: 'eng', Title: 'English SDH' }), sub({ Language: 'eng', Title: 'SDH' })]),
      null
    );
    expect(d.subs.slice(1).map((s) => s.label)).toEqual(['English · Signs & Songs', 'English · SDH', 'English 2 · SDH']);
  });

  it('duplicate labels are numbered after the language: English, English 2, English 3', () => {
    const d = describeTracks(mk('eng', [eng(), eng(), eng(), engForced(), engForced()]), null);
    expect(d.subs.slice(1).map((s) => s.label)).toEqual(['English', 'English 2', 'English 3', 'English · Forced', 'English 2 · Forced']);
  });

  it('rows carry codec, lang (lower-cased), forced and burn flags', () => {
    const d = describeTracks(mk('eng', [sub({ Language: 'ENG', Codec: 'SubRip' }), tracks.vobsub({ IsForced: true })]), null);
    expect(d.subs[1]).toEqual({ label: 'English', index: 2, codec: 'subrip', lang: 'eng', forced: false, burn: false });
    expect(d.subs[2]).toMatchObject({ index: 3, codec: 'dvd_subtitle', forced: true, burn: true });
  });

  it('defaultSub follows the chosen default audio: anime plays Japanese, so full English subs come on', () => {
    const src = source([video(), audio({ Language: 'jpn', IsDefault: true, Codec: 'aac' }), tracks.eac3({ Language: 'eng' }), eng(), engForced()]);
    const anime = series({ Genres: ['Anime'] });
    const d = describeTracks(src, anime);
    expect(d.defaultAudio).toBe(1);
    expect(d.defaultSub).toBe(3);
    const western = describeTracks(src, series({ Genres: ['Drama'] }));
    expect(western.defaultAudio).toBe(2);
    expect(western.defaultSub).toBe(4);
  });

  it('no source → only the None row, defaults -1', () => {
    expect(describeTracks(null, null)).toEqual({ audio: [], subs: [{ label: 'None', index: -1, lang: '' }], video: '', defaultAudio: -1, defaultSub: -1 });
  });
});
