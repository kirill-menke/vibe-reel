/* trackprefs.js: edge cases the mutation run (oracle-mutants-core) left open.
 *
 * - signed out, a menu pick writes NOTHING (not even under a stray "null" key);
 * - a corrupted (null) entry in a full map must not make the cap's sort throw
 *   — saveAll() swallows the error, so the user's new pick would silently be
 *   lost (CLAUDE.md: "a throwing or corrupted store falls back to defaults");
 * - within the remembered audio language the usual score() decides: DD+ over
 *   AC3, whatever case the codec name comes in;
 * - two equally good remembered-language subtitles: file order (lower Index). */
import { describe, it, expect, beforeEach } from 'vitest';
import { freshImport, TEST_USER } from '../helpers/modules.js';
import { readJSON, storageKeys } from '../helpers/storage.js';
import { source, video, audio, sub, episode, resetIds } from '../helpers/media.js';

const KEY = 'reel.trackPrefs.' + TEST_USER;

async function load({ storage = {}, signedIn = true } = {}) {
  const m = await freshImport({ storage, signedIn, modules: { tp: 'src/lib/trackprefs.js' } });
  return m.tp;
}

beforeEach(() => resetIds());

function ep(streams, o = {}) {
  const src = source(streams);
  return { item: episode({ SeriesId: o.SeriesId ?? 'sid-1', MediaSources: [src], ...o }), src };
}

describe('signed out', () => {
  it('a pick writes no storage key at all', async () => {
    const tp = await load({ signedIn: false });
    const before = storageKeys();
    const { item, src } = ep([video(), audio({ Language: 'ger' }), sub()]);
    tp.rememberAudio(item, src, 1);
    tp.rememberSub(item, src, 2);
    tp.rememberSub(item, src, -1);
    expect(storageKeys()).toStrictEqual(before);
  });
});

describe('cap with a corrupted entry', () => {
  it('a null entry in a full map is dropped as the oldest; the new pick is saved', async () => {
    const all = { broken: null };
    for (let i = 0; i < 299; i++) all['s' + i] = { a: { lang: 'German' }, t: 1000 + i };
    const tp = await load({ storage: { [KEY]: all } });
    const { item, src } = ep([video(), audio()], { SeriesId: 'new' });
    tp.rememberAudio(item, src, 1);
    const after = readJSON(KEY);
    expect(after.new.a).toStrictEqual({ lang: 'English' });
    expect('broken' in after).toBe(false);
    expect(Object.keys(after)).toHaveLength(300);
  });
});

describe('matchAudio within the remembered language', () => {
  it('DD+ beats AC3 even when the AC3 track comes first', async () => {
    const tp = await load();
    const { src } = ep([video(), audio({ Codec: 'ac3' }), audio({ Codec: 'eac3' })]);
    expect(tp.matchAudio(src, { lang: 'English' })).toBe(2);
  });

  it('codec names compare case-insensitively', async () => {
    const tp = await load();
    const { src } = ep([video(), audio({ Codec: 'AC3' }), audio({ Codec: 'EAC3' })]);
    expect(tp.matchAudio(src, { lang: 'English' })).toBe(2);
  });
});

describe('matchSub ties', () => {
  it('two equally ranked subtitles: the lower stream index wins', async () => {
    const tp = await load();
    const src = source([video(), audio(), sub({ Index: 7 }), sub({ Index: 4 })]);
    expect(tp.matchSub(src, { lang: 'English', forced: false, sdh: false, burn: false })).toBe(4);
  });
});
