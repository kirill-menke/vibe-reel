/* trackprefs.js: the per-series audio / subtitle memory.
 *
 * CLAUDE.md (Per-series track memory): a pick in the Audio/Subtitles menu is
 * stored per Jellyfin account in localStorage `reel.trackPrefs.<userId>`
 * (≤ 300 series each), keyed by SeriesId. The user is read from cfg.userId at
 * call time; signed out, reads are empty and writes dropped. The old shared
 * `reel.trackPrefs` key is moved once to whoever is signed in when the module
 * first touches it, then deleted. Stored by meaning, not stream index — audio
 * {lang}, subs {off} or {lang, forced, sdh, burn}. startTracks(): remembered
 * choice where the file has it, else exactly the describeTracks() default, per
 * dimension; overrides the anime→Japanese default; a VobSub/DVB track only if
 * the remembered one was burn-in too. Movies and pending streams are neither
 * read nor written.
 *
 * Every test imports a fresh graph (module load runs the migration). */
import { describe, it, expect, beforeEach } from 'vitest';
import { freshImport, TEST_USER } from '../helpers/modules.js';
import { readJSON, seedStorage, stubStorage, storageKeys } from '../helpers/storage.js';
import { source, video, audio, sub, tracks as T, episode, movie, resetIds } from '../helpers/media.js';

const KEY = 'reel.trackPrefs.' + TEST_USER;
const LEGACY = 'reel.trackPrefs';

async function load({ storage = {}, signedIn = true } = {}) {
  const m = await freshImport({
    storage,
    signedIn,
    modules: { tp: 'src/lib/trackprefs.js', tracks: 'src/lib/tracks.js', config: 'src/lib/config.js', settings: 'src/lib/settings.svelte.js' }
  });
  return { ...m.tp, describeTracks: m.tracks.describeTracks, cfg: m.config.cfg, SET: m.settings.SET };
}

beforeEach(() => resetIds());

/* An episode of series `sid` carrying `streams`. */
function ep(streams, o = {}) {
  const src = source(streams);
  return { item: episode({ SeriesId: o.SeriesId ?? 'sid-1', MediaSources: [src], ...o }), src };
}

describe('prefKey', () => {
  it('episodes with a SeriesId only', async () => {
    const { prefKey } = await load();
    expect(prefKey(episode({ SeriesId: 'abc' }))).toBe('abc');
    expect(prefKey(episode({ SeriesId: '' }))).toBe(null);
    expect(prefKey({ Type: 'Episode' })).toBe(null);
    expect(prefKey(movie({ SeriesId: 'abc' }))).toBe(null);
    expect(prefKey({ Type: 'Series', Id: 'abc', SeriesId: 'abc' })).toBe(null);
    expect(prefKey(null)).toBe(null);
    expect(prefKey(undefined)).toBe(null);
  });
});

describe('storage key per account', () => {
  it('writes reel.trackPrefs.<userId> = { [SeriesId]: { a, s, t } }', async () => {
    const { rememberAudio, rememberSub, trackPrefs } = await load();
    const { item, src } = ep([video(), audio({ Language: 'ger' }), sub({ Language: 'eng' })]);
    rememberAudio(item, src, 1);
    rememberSub(item, src, 2);
    const all = readJSON(KEY);
    expect(Object.keys(all)).toStrictEqual(['sid-1']);
    expect(all['sid-1'].a).toStrictEqual({ lang: 'German' });
    expect(all['sid-1'].s).toStrictEqual({ lang: 'English', forced: false, sdh: false, burn: false });
    expect(typeof all['sid-1'].t).toBe('number');
    expect(trackPrefs(item)).toStrictEqual(all['sid-1']);
    expect(localStorage.getItem(LEGACY)).toBe(null);
  });

  it('signed out: reads are null and writes are dropped', async () => {
    const { rememberAudio, rememberSub, trackPrefs, cfg } = await load({ signedIn: false });
    expect(cfg.userId).toBe('');
    const { item, src } = ep([video(), audio({ Language: 'ger' })]);
    seedStorage({ 'reel.trackPrefs.': { 'sid-1': { a: { lang: 'German' } } } });
    rememberAudio(item, src, 1);
    rememberSub(item, src, -1);
    expect(trackPrefs(item)).toBe(null);
    expect(storageKeys().filter((k) => k.startsWith(LEGACY))).toStrictEqual(['reel.trackPrefs.']);
  });

  it('the user is read at call time: an account switch applies at once', async () => {
    const { rememberAudio, trackPrefs, cfg } = await load();
    const { item, src } = ep([video(), audio({ Language: 'ger' }), audio({ Language: 'fre' })]);
    rememberAudio(item, src, 1);
    cfg.userId = 'u2';
    expect(trackPrefs(item)).toBe(null);
    rememberAudio(item, src, 2);
    expect(readJSON('reel.trackPrefs.u2')['sid-1'].a).toStrictEqual({ lang: 'French' });
    expect(readJSON(KEY)['sid-1'].a).toStrictEqual({ lang: 'German' });
    cfg.userId = TEST_USER;
    expect(trackPrefs(item).a).toStrictEqual({ lang: 'German' });
  });
});

describe('legacy shared key migration', () => {
  it('moves to the signed-in account at module load; the account’s own entries win; legacy deleted', async () => {
    const legacy = { 'sid-1': { a: { lang: 'German' }, t: 1 }, 'sid-2': { s: { off: true }, t: 2 } };
    const mine = { 'sid-1': { a: { lang: 'French' }, t: 5 } };
    await load({ storage: { [LEGACY]: legacy, [KEY]: mine } });
    expect(localStorage.getItem(LEGACY)).toBe(null);
    expect(readJSON(KEY)).toStrictEqual({ 'sid-1': { a: { lang: 'French' }, t: 5 }, 'sid-2': { s: { off: true }, t: 2 } });
  });

  it('runs once: other accounts start empty', async () => {
    const { trackPrefs, cfg } = await load({ storage: { [LEGACY]: { 'sid-1': { a: { lang: 'German' } } } } });
    cfg.userId = 'u2';
    const { item } = ep([video(), audio()]);
    expect(trackPrefs(item)).toBe(null);
    expect(localStorage.getItem('reel.trackPrefs.u2')).toBe(null);
    cfg.userId = TEST_USER;
    expect(trackPrefs(item).a).toStrictEqual({ lang: 'German' });
  });

  it('signed out at load: the legacy map waits for the first signed-in touch', async () => {
    const { trackPrefs, cfg } = await load({ signedIn: false, storage: { [LEGACY]: { 'sid-1': { a: { lang: 'German' } } } } });
    expect(localStorage.getItem(LEGACY)).not.toBe(null);
    cfg.userId = 'u7';
    const { item } = ep([video(), audio()]);
    expect(trackPrefs(item).a).toStrictEqual({ lang: 'German' });
    expect(localStorage.getItem(LEGACY)).toBe(null);
    expect(readJSON('reel.trackPrefs.u7')['sid-1'].a).toStrictEqual({ lang: 'German' });
  });

  it('an empty or corrupted legacy key is just removed (no account key written)', async () => {
    for (const raw of ['{}', 'not json', '[1,2]', 'null']) {
      await load({ storage: { [LEGACY]: raw } });
      expect(localStorage.getItem(LEGACY)).toBe(null);
      expect(localStorage.getItem(KEY)).toBe(null);
    }
  });
});

describe('stored by meaning', () => {
  it('audio stores only {lang}; commentary-ness is not carried', async () => {
    const { rememberAudio, trackPrefs } = await load();
    const { item, src } = ep([video(), T.dtsHdMa(), T.commentary()]);
    rememberAudio(item, src, 2);
    expect(trackPrefs(item).a).toStrictEqual({ lang: 'English' });
  });

  it('untagged / und audio stores lang ""', async () => {
    const { rememberAudio, trackPrefs } = await load();
    const { item, src } = ep([video(), audio({ Language: 'und' })]);
    rememberAudio(item, src, 1);
    expect(trackPrefs(item).a).toStrictEqual({ lang: '' });
  });

  it('subs: -1 → {off:true}; a track → {lang, forced, sdh, burn}', async () => {
    const { rememberSub, trackPrefs } = await load();
    const { item, src } = ep([video(), audio(), T.sdh({ Title: 'English SDH' }), sub({ Language: 'ger', IsForced: true }), T.vobsub({ Language: 'fre' })]);
    rememberSub(item, src, -1);
    expect(trackPrefs(item).s).toStrictEqual({ off: true });
    rememberSub(item, src, 2);
    expect(trackPrefs(item).s).toStrictEqual({ lang: 'English', forced: false, sdh: true, burn: false });
    rememberSub(item, src, 3);
    expect(trackPrefs(item).s).toStrictEqual({ lang: 'German', forced: true, sdh: false, burn: false });
    rememberSub(item, src, 4);
    expect(trackPrefs(item).s).toStrictEqual({ lang: 'French', forced: false, sdh: false, burn: true });
  });

  it('an index that is not a track of that type writes nothing', async () => {
    const { rememberAudio, rememberSub } = await load();
    const { item, src } = ep([video(), audio(), sub()]);
    rememberAudio(item, src, 2); // a subtitle index
    rememberAudio(item, src, 99);
    rememberSub(item, src, 1); // an audio index
    rememberAudio(item, null, 1);
    expect(localStorage.getItem(KEY)).toBe(null);
  });

  it('audio and subs are separate dimensions of one entry; t refreshes on every write', async () => {
    const { rememberAudio, rememberSub, trackPrefs } = await load();
    const { item, src } = ep([video(), audio({ Language: 'ger' }), sub()]);
    rememberAudio(item, src, 1);
    const t1 = trackPrefs(item).t;
    rememberSub(item, src, -1);
    const p = trackPrefs(item);
    expect(p.a).toStrictEqual({ lang: 'German' });
    expect(p.s).toStrictEqual({ off: true });
    expect(p.t).toBeGreaterThanOrEqual(t1);
  });
});

describe('movies and items without SeriesId', () => {
  it('neither read nor write', async () => {
    const { rememberAudio, rememberSub, trackPrefs, startTracks, describeTracks } = await load();
    const src = source([video(), audio(), audio({ Language: 'ger' }), sub()]);
    const m = movie({ Id: 'mov-1', MediaSources: [src] });
    seedStorage({ [KEY]: { 'mov-1': { a: { lang: 'German' } }, undefined: { a: { lang: 'German' } } } });
    expect(trackPrefs(m)).toBe(null);
    rememberAudio(m, src, 2);
    rememberSub(m, src, 3);
    const pending = { Type: 'Episode', Id: 'pend', MediaSources: [src] };
    expect(trackPrefs(pending)).toBe(null);
    rememberAudio(pending, src, 2);
    expect(Object.keys(readJSON(KEY)).sort()).toStrictEqual(['mov-1', 'undefined']);
    const d = describeTracks(src, m);
    expect(startTracks(src, m)).toStrictEqual({ audio: d.defaultAudio, sub: d.defaultSub });
  });
});

describe('startTracks', () => {
  it('without a remembered choice: exactly describeTracks()’ defaults', async () => {
    const { startTracks, describeTracks } = await load();
    const fixtures = [
      [video(), T.truehdAtmos({ IsDefault: true }), T.eac3Atmos(), sub({ IsForced: true })],
      [video(), T.dtsHdMa(), T.commentary(), sub({ Language: 'ger' })],
      [video(), audio({ Language: 'ita' }), audio({ Language: 'eng', Codec: 'aac' }), sub()],
      [video(), audio({ Language: 'jpn', IsDefault: true }), audio({ Language: 'eng' }), sub({ Language: 'eng' })]
    ];
    for (const streams of fixtures) {
      const { item, src } = ep(streams, { Genres: ['Anime'] });
      const d = describeTracks(src, item);
      expect(startTracks(src, item)).toStrictEqual({ audio: d.defaultAudio, sub: d.defaultSub });
    }
  });

  it('remembered audio language wins where the file has it, and re-derives the sub default against it', async () => {
    const { startTracks, rememberAudio, describeTracks } = await load();
    const first = ep([video(), audio({ Language: 'eng' }), audio({ Language: 'ger', Codec: 'ac3' }), sub({ Language: 'eng' })]);
    expect(describeTracks(first.src, first.item).defaultSub).toBe(-1); // English audio: no subs in auto
    rememberAudio(first.item, first.src, 2);
    // next episode: German at a different index, English subs present
    const next = ep([video(), audio({ Language: 'ger', Codec: 'ac3' }), audio({ Language: 'eng' }), sub({ Language: 'eng' }), sub({ Language: 'eng', IsForced: true })], { Id: 'ep-2' });
    expect(startTracks(next.src, next.item)).toStrictEqual({ audio: 1, sub: 3 }); // foreign audio → full English subs
  });

  it('within the remembered language: DD+/Atmos first, commentary last', async () => {
    const { startTracks, rememberAudio } = await load();
    const a = ep([video(), audio({ Language: 'ger' }), audio({ Language: 'eng' })]);
    rememberAudio(a.item, a.src, 1);
    const b = ep([video(), T.commentary({ Language: 'ger' }), T.dtsHdMa({ Language: 'ger' }), T.eac3Atmos({ Language: 'ger' }), audio({ Language: 'eng' })]);
    expect(startTracks(b.src, b.item).audio).toBe(3);
    const c = ep([video(), T.commentary({ Language: 'ger' }), T.dtsHdMa({ Language: 'ger' })]);
    expect(startTracks(c.src, c.item).audio).toBe(2); // the Mad Men case inside one language
  });

  it('remembered language missing from this file → that dimension falls back to the default', async () => {
    const { startTracks, rememberAudio, rememberSub, describeTracks } = await load();
    const a = ep([video(), audio({ Language: 'fre' }), sub({ Language: 'ger' })]);
    rememberAudio(a.item, a.src, 1);
    rememberSub(a.item, a.src, 2);
    const b = ep([video(), T.truehdAtmos({ IsDefault: true }), T.eac3Atmos(), sub({ Language: 'eng', IsForced: true })]);
    const d = describeTracks(b.src, b.item);
    expect(startTracks(b.src, b.item)).toStrictEqual({ audio: d.defaultAudio, sub: d.defaultSub });
    expect(d.defaultAudio).toBe(2);
    expect(d.defaultSub).toBe(3);
  });

  it('remembered English overrides the anime→Japanese default', async () => {
    const { startTracks, rememberAudio, describeTracks } = await load();
    const streams = () => [video(), audio({ Language: 'jpn', IsDefault: true, Codec: 'flac' }), audio({ Language: 'eng', Codec: 'aac' }), sub({ Language: 'eng' })];
    const a = ep(streams(), { Genres: ['Anime'] });
    expect(describeTracks(a.src, a.item).defaultAudio).toBe(1);
    expect(describeTracks(a.src, a.item).defaultSub).toBe(3);
    rememberAudio(a.item, a.src, 2);
    const b = ep(streams(), { Genres: ['Anime'], Id: 'ep-2' });
    expect(startTracks(b.src, b.item)).toStrictEqual({ audio: 2, sub: -1 });
  });

  it('remembered subs off → None even where the file flags a default SDH track', async () => {
    const { startTracks, rememberSub } = await load();
    const a = ep([video(), audio({ Language: 'ita' }), sub()]);
    rememberSub(a.item, a.src, -1);
    const b = ep([video(), audio({ Language: 'ita' }), T.sdh({ IsDefault: true }), sub()]);
    expect(startTracks(b.src, b.item).sub).toBe(-1);
  });

  it('remembered subs off leaves audio on its default', async () => {
    const { startTracks, rememberSub, describeTracks } = await load();
    const a = ep([video(), T.truehdAtmos(), T.eac3Atmos(), sub()]);
    rememberSub(a.item, a.src, -1);
    expect(startTracks(a.src, a.item)).toStrictEqual({ audio: describeTracks(a.src, a.item).defaultAudio, sub: -1 });
  });

  it('index shifts between episodes: the same meaning, a different index', async () => {
    const { startTracks, rememberSub } = await load();
    // ep 1: two commentaries push the subs to 4; ep 2 has one, so English is at 3
    const a = ep([video(), audio(), T.commentary(), T.commentary(), sub({ Language: 'eng' }), sub({ Language: 'ger' })]);
    rememberSub(a.item, a.src, 5);
    const b = ep([video(), audio(), T.commentary(), sub({ Language: 'eng' }), sub({ Language: 'ger' })]);
    expect(startTracks(b.src, b.item).sub).toBe(4);
  });

  it('forced-ness must match; SDH-ness only breaks ties', async () => {
    const { startTracks, rememberSub, describeTracks } = await load();
    const a = ep([video(), audio(), sub({ IsForced: true })]);
    rememberSub(a.item, a.src, 2);
    const onlyFull = ep([video(), audio({ Language: 'eng' }), sub({ IsForced: false })]);
    expect(startTracks(onlyFull.src, onlyFull.item).sub).toBe(describeTracks(onlyFull.src, onlyFull.item).defaultSub);
    expect(startTracks(onlyFull.src, onlyFull.item).sub).toBe(-1);

    const s = ep([video(), audio({ Language: 'ita' }), T.sdh()]);
    rememberSub(s.item, s.src, 2);
    const both = ep([video(), audio({ Language: 'ita' }), sub(), T.sdh(), sub({ IsDefault: true })]);
    expect(startTracks(both.src, both.item).sub).toBe(3);
    // no SDH this time: the plain one is still a match (IsDefault breaks the tie, then lower Index)
    const plain = ep([video(), audio({ Language: 'ita' }), sub(), sub({ IsDefault: true })]);
    expect(startTracks(plain.src, plain.item).sub).toBe(3);
  });

  // Before V-F3 isSdh() read only the Title, so a pick of a track Jellyfin flags
  // IsHearingImpaired under a plain title ("English") was stored as sdh:false —
  // the same entry a pick of the plain, unflagged track wrote. The entry can't
  // tell the two apart. Today it reads as "not SDH": the unflagged track wins
  // whatever the file's default/order (before V-F3 the default flag, then the
  // lower index decided, which was right for neither pick in general). A pick
  // made since then stores the flag and sticks either way.
  it('a pick stored before V-F3 (sdh:false from a plain title): the unflagged track wins; one re-pick of the flagged track sticks', async () => {
    const legacy = { 'sid-1': { s: { lang: 'English', forced: false, sdh: false, burn: false }, t: 1 } };
    const { startTracks, rememberSub, trackPrefs } = await load({ storage: { [KEY]: legacy } });
    const flagged = (o = {}) => sub({ IsHearingImpaired: true, ...o }); // title still plain
    // the flagged track first and the file's default: the unflagged one still wins
    const b = ep([video(), audio({ Language: 'ita' }), flagged({ IsDefault: true }), sub()]);
    expect(startTracks(b.src, b.item).sub).toBe(3);
    const c = ep([video(), audio({ Language: 'ita' }), sub(), flagged()]);
    expect(startTracks(c.src, c.item).sub).toBe(2);
    // only the flagged track in English: still a match (a tie-break, never a filter)
    const d = ep([video(), audio({ Language: 'ita' }), flagged(), sub({ Language: 'ger' })]);
    expect(startTracks(d.src, d.item).sub).toBe(2);

    // the user re-picks the flagged track (the menu now labels it SDH): stored with the flag…
    rememberSub(c.item, c.src, 3);
    expect(trackPrefs(c.item).s).toStrictEqual({ lang: 'English', forced: false, sdh: true, burn: false });
    // …and it wins from then on, over a default unflagged track listed first
    const e = ep([video(), audio({ Language: 'ita' }), sub({ IsDefault: true }), flagged()]);
    expect(startTracks(e.src, e.item).sub).toBe(3);
    // re-picking the unflagged one switches back the same way
    rememberSub(e.item, e.src, 2);
    expect(startTracks(b.src, b.item).sub).toBe(3);
  });

  it('a burn-in track only when the remembered one was burn-in too, and a text track still wins then', async () => {
    const { startTracks, rememberSub } = await load();
    const text = ep([video(), audio({ Language: 'ita' }), sub({ Language: 'eng' })]);
    rememberSub(text.item, text.src, 2);
    const onlyVob = ep([video(), audio({ Language: 'ita' }), T.vobsub({ Language: 'eng' })]);
    expect(startTracks(onlyVob.src, onlyVob.item).sub).toBe(-1); // never a transcode unasked

    const vob = ep([video(), audio({ Language: 'ita' }), T.vobsub({ Language: 'eng' })]);
    rememberSub(vob.item, vob.src, 2);
    expect(startTracks(onlyVob.src, onlyVob.item).sub).toBe(2);
    // the remembered plain DVD track must not beat an English SDH SRT (client-side format outranks SDH match)
    const mixed = ep([video(), audio({ Language: 'ita' }), T.vobsub({ Language: 'eng' }), T.sdh({ Language: 'eng' })]);
    expect(startTracks(mixed.src, mixed.item).sub).toBe(3);
    const dvb = ep([video(), audio({ Language: 'ita' }), T.dvbsub({ Language: 'eng' })]);
    expect(startTracks(dvb.src, dvb.item).sub).toBe(2);
  });

  it('matchAudio / matchSub without a pref return null', async () => {
    const { matchAudio, matchSub } = await load();
    const src = source([video(), audio(), sub()]);
    expect(matchAudio(src, null)).toBe(null);
    expect(matchAudio(src, undefined)).toBe(null);
    expect(matchSub(src, null)).toBe(null);
    expect(matchAudio(null, { lang: 'English' })).toBe(null);
    expect(matchSub(null, { lang: 'English' })).toBe(null);
    expect(matchSub(null, { off: true })).toBe(-1);
  });
});

describe('cap and broken storage', () => {
  it('MAX_SERIES 300: the oldest-touched entry is dropped', async () => {
    const all = {};
    for (let i = 0; i < 300; i++) all['s' + i] = { a: { lang: 'German' }, t: 1000 + i };
    all.s5.t = 1; // oldest
    const { rememberAudio } = await load({ storage: { [KEY]: all } });
    const { item, src } = ep([video(), audio()], { SeriesId: 'new' });
    rememberAudio(item, src, 1);
    const after = readJSON(KEY);
    expect(Object.keys(after)).toHaveLength(300);
    expect(after.s5).toBeUndefined();
    expect(after.s0).toBeDefined();
    expect(after.new.a).toStrictEqual({ lang: 'English' });
  });

  it('entries without t (or non-objects) count as the oldest', async () => {
    const all = {};
    for (let i = 0; i < 299; i++) all['s' + i] = { t: 1000 + i };
    all.junk = 'x';
    const { rememberAudio } = await load({ storage: { [KEY]: all } });
    const { item, src } = ep([video(), audio()], { SeriesId: 'new' });
    rememberAudio(item, src, 1);
    const after = readJSON(KEY);
    expect(Object.keys(after)).toHaveLength(300);
    expect('junk' in after).toBe(false);
  });

  it('a migration over the cap is capped too', async () => {
    const legacy = {};
    for (let i = 0; i < 305; i++) legacy['s' + i] = { t: i + 1 };
    await load({ storage: { [LEGACY]: legacy } });
    const after = readJSON(KEY);
    expect(Object.keys(after)).toHaveLength(300);
    for (let i = 0; i < 5; i++) expect(after['s' + i]).toBeUndefined();
  });

  it('corrupted JSON reads as empty and the next write starts a fresh map', async () => {
    for (const raw of ['{oops', '[]', '"str"', '42', 'null']) {
      const { trackPrefs, rememberAudio } = await load({ storage: { [KEY]: raw } });
      const { item, src } = ep([video(), audio()]);
      expect(trackPrefs(item)).toBe(null);
      rememberAudio(item, src, 1);
      expect(readJSON(KEY)['sid-1'].a).toStrictEqual({ lang: 'English' });
    }
  });

  it('a non-object entry for the series reads as null and is replaced by the next pick', async () => {
    const { trackPrefs, rememberSub } = await load({ storage: { [KEY]: { 'sid-1': 'garbage' } } });
    const { item, src } = ep([video(), audio(), sub()]);
    expect(trackPrefs(item)).toBe(null);
    rememberSub(item, src, 2);
    expect(readJSON(KEY)['sid-1'].s).toStrictEqual({ lang: 'English', forced: false, sdh: false, burn: false });
  });

  it('a throwing store: reads empty, writes swallowed, startTracks still answers', async () => {
    const { trackPrefs, rememberAudio, rememberSub, startTracks, describeTracks } = await load();
    const { item, src } = ep([video(), T.truehdAtmos(), T.eac3Atmos(), sub()]);
    stubStorage({ throwOn: true });
    expect(trackPrefs(item)).toBe(null);
    expect(() => rememberAudio(item, src, 1)).not.toThrow();
    expect(() => rememberSub(item, src, 3)).not.toThrow();
    const d = describeTracks(src, item);
    expect(startTracks(src, item)).toStrictEqual({ audio: d.defaultAudio, sub: d.defaultSub });
  });

  it('a store throwing at module load does not break the import', async () => {
    stubStorage({ throwOn: true });
    const { trackPrefs, cfg } = await load({ signedIn: false });
    expect(cfg.userId).toBe('');
    expect(trackPrefs(episode({ SeriesId: 'x' }))).toBe(null);
  });

  it('a migration whose read throws leaves the legacy key in place', async () => {
    const ls = stubStorage({
      initial: { 'reel.userId': TEST_USER, 'reel.token': 't', 'reel.server': 'http://jf.test', [LEGACY]: { 'sid-1': { a: { lang: 'German' } } } },
      throwOn: ['clear']
    });
    const realGet = ls.getItem;
    ls.getItem = (k) => {
      if (k === LEGACY) throw new DOMException('denied', 'SecurityError');
      return realGet(k);
    };
    const { trackPrefs } = await load({ signedIn: false });
    expect(ls.map.has(LEGACY)).toBe(true);
    expect(trackPrefs(episode({ SeriesId: 'sid-1' }))).toBe(null);
  });

  /* V-F5: a nearly full store. The legacy map must never be dropped unless the
   * account's copy was actually written. */
  const legacyStore = () => {
    const legacy = { 'sid-1': { a: { lang: 'German' } }, 'sid-2': { s: { off: true } } };
    const ls = stubStorage({
      initial: { 'reel.userId': TEST_USER, 'reel.token': 't', 'reel.server': 'http://jf.test', [LEGACY]: legacy },
      throwOn: ['clear']
    });
    const used = [...ls.map].reduce((a, [k, v]) => a + k.length + v.length, 0);
    return { ls, legacy, raw: ls.map.get(LEGACY), used };
  };

  it('a migration into a nearly full store frees the legacy key to make room, then saves (V-F5)', async () => {
    const { ls, legacy, used } = legacyStore();
    ls.quota = used + (KEY.length - LEGACY.length) + 2;   // fits only once the legacy copy is gone
    const { trackPrefs } = await load({ signedIn: false });
    expect(JSON.parse(ls.map.get(KEY))).toStrictEqual(legacy);
    expect(ls.map.has(LEGACY)).toBe(false);
    expect(trackPrefs(episode({ SeriesId: 'sid-1' }))).toStrictEqual(legacy['sid-1']);
  });

  it('a migration that cannot save even after freeing the legacy key keeps it, unchanged (V-F5)', async () => {
    const { ls, raw, used } = legacyStore();
    ls.quota = used;   // the account's copy is a few chars longer than the legacy key's
    await load({ signedIn: false });
    expect(ls.map.get(LEGACY)).toBe(raw);
    expect(ls.map.has(KEY)).toBe(false);
  });
});
