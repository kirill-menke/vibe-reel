/* describeTracks()/score(): the default audio track (CLAUDE.md "Video playback
 * — the no-transcode contract"). Wave-0 proof of the harness; the full
 * tracks.js suite is task tracks-* in run/tasks.json. */
import { describe, it, expect, beforeEach } from 'vitest';
import { describeTracks, score } from '../../src/lib/tracks.js';
import { SET, DEFAULTS } from '../../src/lib/settings.svelte.js';
import { source, video, audio, tracks, series, episode, resetIds } from '../helpers/media.js';

beforeEach(() => {
  resetIds();
  Object.assign(SET, DEFAULTS);
});

describe('default audio', () => {
  it('prefers E-AC3/DD+ Atmos over a container-default TrueHD Atmos', () => {
    const src = source([video(), tracks.truehdAtmos({ IsDefault: true }), tracks.eac3Atmos()]);
    const d = describeTracks(src, episode());
    expect(d.defaultAudio).toBe(2);
    expect(d.audio.map((a) => a.index)).toEqual([2, 1]);
  });

  it('a DTS-HD main track beats the AC3 commentaries in the same language (the Mad Men case)', () => {
    const src = source([
      video(),
      tracks.dtsHdMa({ IsDefault: true }),
      tracks.commentary({ Title: 'Commentary with Matthew Weiner' }),
      tracks.commentary({ Title: 'Commentary with the cast' })
    ]);
    expect(describeTracks(src, episode()).defaultAudio).toBe(1);
  });

  // User decision 2026-10-04 (V-F1): the penalty outweighs the language bonus
  // plus every codec bonus (10 + 5), so a commentary in the preferred language loses to a foreign main track too.
  it('commentary is −16: it loses to any main track, same language or foreign', () => {
    const want = 'English';
    const comm = { codec: 'ac3', atmos: false, commentary: true, lang: 'eng' };
    const mainDts = { codec: 'dts', atmos: false, commentary: false, lang: 'eng' };
    const foreignAc3 = { codec: 'ac3', atmos: false, commentary: false, lang: 'ita' };
    const foreignAac = { codec: 'aac', atmos: false, commentary: false, lang: 'ita' };
    const foreignAtmos = { codec: 'eac3', atmos: true, commentary: false, lang: 'ita' };
    expect(score(comm, want)).toBe(10 + 1 - 16);
    expect(score(mainDts, want)).toBeGreaterThan(score(comm, want));
    for (const f of [foreignAc3, foreignAac, foreignAtmos]) expect(score(f, want)).toBeGreaterThan(score(comm, want));
    // the best possible commentary (preferred language, DD+ Atmos) still loses to a bare foreign track
    const bestComm = { codec: 'eac3', atmos: true, commentary: true, lang: 'eng' };
    expect(score(foreignAac, want)).toBeGreaterThan(score(bestComm, want));
  });

  it('an English AC3 commentary next to an Italian DD+ Atmos main track → the Italian main track', () => {
    const src = source([video(), tracks.commentary({ IsDefault: true }), tracks.eac3Atmos({ Language: 'ita' })]);
    const d = describeTracks(src, movieLike());
    expect(d.defaultAudio).toBe(2);
    expect(d.audio.map((a) => a.index)).toEqual([2, 1]);
  });

  it('an English AAC commentary next to a plain Italian AAC main track → the Italian main track', () => {
    const src = source([video(), tracks.commentary({ Codec: 'aac' }), tracks.aacStereo({ Language: 'ita' })]);
    expect(describeTracks(src, movieLike()).defaultAudio).toBe(2);
  });

  it('a file whose only audio is a commentary still plays it', () => {
    const src = source([video(), tracks.commentary()]);
    expect(describeTracks(src, movieLike()).defaultAudio).toBe(1);
  });

  it('language dominates codec: an English AAC beats a foreign DD+ Atmos', () => {
    const src = source([video(), tracks.eac3Atmos({ Language: 'ita', IsDefault: true }), tracks.aacStereo({ Language: 'eng' })]);
    expect(describeTracks(src, movieLike()).defaultAudio).toBe(2);
  });

  it('language aliases collapse (en / eng / English all match the Settings language)', () => {
    const src = source([video(), tracks.eac3({ Language: 'ger', IsDefault: true }), tracks.ac3({ Language: 'en' })]);
    expect(describeTracks(src, movieLike()).defaultAudio).toBe(2);
  });

  it('anime → Japanese when the container default is Japanese', () => {
    const src = source([video(), audio({ Codec: 'aac', Language: 'jpn', IsDefault: true }), tracks.eac3({ Language: 'eng' })]);
    const anime = series({ Genres: ['Anime', 'Action'] });
    expect(describeTracks(src, anime).defaultAudio).toBe(1);
    // the same file without the genre plays the English DD+
    expect(describeTracks(src, series({ Genres: ['Action'] })).defaultAudio).toBe(2);
  });

  it('an animated title with an English default stays English (Western cartoon with a Japanese dub)', () => {
    const src = source([video(), tracks.eac3({ Language: 'eng', IsDefault: true }), audio({ Codec: 'aac', Language: 'jpn' })]);
    expect(describeTracks(src, series({ Genres: ['Animation'] })).defaultAudio).toBe(1);
  });

  it('follows SET.audioLang', () => {
    SET.audioLang = 'ger';
    const src = source([video(), tracks.eac3Atmos({ Language: 'eng', IsDefault: true }), tracks.ac3({ Language: 'deu' })]);
    expect(describeTracks(src, movieLike()).defaultAudio).toBe(2);
  });

  it('no source → empty description with None as the only subtitle row', () => {
    const d = describeTracks(null, null);
    expect(d).toMatchObject({ audio: [], defaultAudio: -1, defaultSub: -1 });
    expect(d.subs).toEqual([{ label: 'None', index: -1, lang: '' }]);
  });
});

function movieLike() {
  return { Type: 'Movie', Genres: [] };
}
