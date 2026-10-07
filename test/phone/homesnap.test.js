/* phone/src/lib/homesnap.svelte.js — Home opens on the last session, online or off.
 *
 * CLAUDE.md: "its four Jellyfin rail answers (trimmed, ~35 KB) + Trending go to
 * localStorage['reel.homeSnap.<userId>'] after every live load; at the next start
 * Home seeds api.js's SWR store from it (seedStore, inside __PHONE__ …) and paints
 * before its first frame … A snapshot item has no MediaSources — a Continue
 * Watching / Next Up / hero start waits for the live item." And "localStorage is
 * read through guarded helpers everywhere: a throwing or corrupted store falls
 * back to defaults instead of killing the bundle at module init."
 *
 * The module-level contract is tested here; Home.svelte's use of it (save after
 * a live load, paint from the snapshot) is in home.freshness.test.js. */
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { freshImport, accountStorage } from '../helpers/modules.js';
import { useClock } from '../helpers/time.js';
import { readJSON, stubStorage, storageKeys } from '../helpers/storage.js';
import { movie, episode, series } from '../helpers/media.js';

const RESUME = '/UserItems/Resume?userId=u1&Limit=16';
const NEXTUP = '/Shows/NextUp?UserId=u1&Limit=16';
const LATEST_M = '/Items/Latest?userId=u1&IncludeItemTypes=Movie';
const LATEST_S = '/Items/Latest?userId=u1&IncludeItemTypes=Series';
const PATHS = [RESUME, NEXTUP, LATEST_M, LATEST_S];
const DAY = 24 * 3600 * 1000;

let m;
async function load(storage = {}, opts = {}) {
  m = await freshImport({
    ...opts,
    storage,
    modules: {
      snap: 'phone/src/lib/homesnap.svelte.js',
      api: 'src/lib/api.js',
      config: 'src/lib/config.js'
    }
  });
  return m;
}

/** A full Jellyfin item, as Home's rails request them (MediaSources and all). */
function fat(o = {}) {
  return movie({
    Overview: 'A long overview '.repeat(20),
    People: [{ Name: 'Someone' }],
    Chapters: [{ Name: 'Intro' }],
    CommunityRating: 7.7,
    Genres: ['Drama'],
    PremiereDate: '2024-01-01T00:00:00Z',
    ImageBlurHashes: { Primary: { a: 'LKO2' }, Backdrop: { b: 'LEHV' }, Thumb: { c: 'L6PZ' }, Logo: { d: 'xx' }, Art: { e: 'yy' } },
    UserData: { PlaybackPositionTicks: 42, PlayedPercentage: 12.5, Played: false, UnplayedItemCount: 3, LastPlayedDate: '2026-01-01T00:00:00Z', IsFavorite: true, Key: 'k', PlayCount: 4 },
    ...o
  });
}

function seedLive(entries) {
  m.api.seedStore(entries.map(([p, data, at = Date.now()]) => [p, { at, data }]));
}
const snapKey = (u = 'u1') => 'reel.homeSnap.' + u;

const SNAP_MODULE = path.resolve(import.meta.dirname, '../../phone/src/lib/homesnap.svelte.js');

/* ------------------------------------------------------------------ save ---- */

describe('saveHome(): debounced, trimmed, keyed by user', () => {
  it('writes reel.homeSnap.<userId> 1.5 s after the call: v, at, the store entries for these paths, trending', async () => {
    const clock = useClock();
    await load();
    const cw = fat({ Id: 'cw1' });
    seedLive([
      [RESUME, { Items: [cw], TotalRecordCount: 1, StartIndex: 0 }, clock.now() - 5000],
      [LATEST_M, [fat({ Id: 'lm1' })]],
      ['/elsewhere', { Items: [fat()] }]
    ]);
    const trend = { tv: [{ id: 1, title: 'T' }], movie: [{ id: 2, title: 'M' }] };
    m.snap.saveHome(PATHS, trend);
    await clock.tick(1499);
    expect(localStorage.getItem(snapKey())).toBe(null);
    await clock.tick(1);
    const s = readJSON(snapKey());
    expect(s.v).toBe(1);
    expect(s.at).toBe(clock.now());
    expect(s.entries.map((e) => e[0])).toEqual([RESUME, LATEST_M]); // only these paths, only what is in the store
    expect(s.entries[0][1].at).toBe(clock.now() - 6500); // the answer's own age is kept
    expect(s.trend).toEqual(trend);
    expect(storageKeys().filter((k) => k.startsWith('reel.homeSnap.'))).toEqual([snapKey()]);
  });

  it('trimmed to what tiles and the hero read: no MediaSources, Overview, People…; UserData and blur hashes cut down', async () => {
    const clock = useClock();
    await load();
    const ep = episode({ Id: 'e1', SeriesId: 's1', SeriesName: 'Silo', IndexNumber: 3, ParentIndexNumber: 2, SeriesPrimaryImageTag: 'sp', ParentBackdropItemId: 's1', ParentBackdropImageTags: ['pb'], ParentThumbItemId: 's1', ParentThumbImageTag: 'pt', Overview: 'x', MediaSources: [{}] });
    seedLive([
      [RESUME, { Items: [fat({ Id: 'cw1' }), ep], TotalRecordCount: 2 }],
      [LATEST_S, [series({ Id: 'sr1', ProviderIds: { Tvdb: '1' } })]]
    ]);
    m.snap.saveHome(PATHS);
    await clock.tick(1500);
    const s = readJSON(snapKey());
    const [cw, e] = s.entries[0][1].data.Items;
    expect(Object.keys(s.entries[0][1].data)).toEqual(['Items']); // TotalRecordCount etc. dropped
    expect(cw.MediaSources).toBeUndefined(); // nothing may play from a snapshot item
    expect(cw.Overview).toBeUndefined();
    expect(cw.People).toBeUndefined();
    expect(cw.Chapters).toBeUndefined();
    expect(cw.CommunityRating).toBeUndefined();
    expect(cw).toMatchObject({ Id: 'cw1', Type: 'Movie', ProductionYear: 2024, Genres: ['Drama'], PremiereDate: '2024-01-01T00:00:00Z', ImageTags: { Primary: 'tag-cw1' } });
    expect(cw.UserData).toEqual({ PlaybackPositionTicks: 42, PlayedPercentage: 12.5, Played: false, UnplayedItemCount: 3, LastPlayedDate: '2026-01-01T00:00:00Z' });
    expect(cw.ImageBlurHashes).toEqual({ Primary: { a: 'LKO2' }, Backdrop: { b: 'LEHV' }, Thumb: { c: 'L6PZ' } });
    expect(e).toEqual({
      Id: 'e1', Name: 'Episode e1', Type: 'Episode', SeriesId: 's1', SeriesName: 'Silo', IndexNumber: 3, ParentIndexNumber: 2,
      RunTimeTicks: ep.RunTimeTicks, ImageTags: { Primary: 'tag-e1' }, BackdropImageTags: [],
      ParentBackdropItemId: 's1', ParentBackdropImageTags: ['pb'], ParentThumbItemId: 's1', ParentThumbImageTag: 'pt',
      SeriesPrimaryImageTag: 'sp', UserData: { PlaybackPositionTicks: 0, Played: false } // SeasonId, PlayCount, IsFavorite: dropped
    });
    expect(s.entries[1][1].data).toEqual([{ Id: 'sr1', Name: 'Series sr1', Type: 'Series', RunTimeTicks: expect.any(Number), Genres: [], ProviderIds: { Tvdb: '1' }, ImageTags: { Primary: 'tag-sr1' }, BackdropImageTags: [], UserData: { PlaybackPositionTicks: 0, Played: false } }]);
    // a normal Home stays small: ~1 KB here for 3 items that were ~3 KB fat
    expect(localStorage.getItem(snapKey()).length).toBeLessThan(JSON.stringify([fat(), ep]).length);
  });

  it('a store entry that is neither a list nor a QueryResult is kept as it is', async () => {
    const clock = useClock();
    await load();
    seedLive([[RESUME, { Something: 1 }]]);
    m.snap.saveHome(PATHS);
    await clock.tick(1500);
    expect(readJSON(snapKey()).entries[0][1].data).toEqual({ Something: 1 });
  });

  it('debounced: a burst of saves writes once, with the last call’s paths and trend', async () => {
    const clock = useClock();
    await load();
    seedLive([[RESUME, { Items: [fat()] }], [NEXTUP, { Items: [] }]]);
    const ls = stubStorage({ initial: accountStorage() });
    const set = ls.setItem;
    let writes = 0;
    ls.setItem = (k, v) => (k.startsWith('reel.homeSnap.') && writes++, set(k, v));
    m.snap.saveHome([RESUME], { tv: [{ id: 1 }] });
    await clock.tick(1000);
    m.snap.saveHome([RESUME, NEXTUP], { movie: [{ id: 2 }] });
    await clock.tick(1499);
    expect(writes).toBe(0);
    await clock.tick(1);
    expect(writes).toBe(1);
    const s = JSON.parse(ls.getItem(snapKey()));
    expect(s.entries.map((e) => e[0])).toEqual([RESUME, NEXTUP]);
    expect(s.trend).toEqual({ movie: [{ id: 2 }] });
  });

  it('only loaded Trending lists are kept (null / undefined / non-arrays are not)', async () => {
    const clock = useClock();
    await load();
    seedLive([[RESUME, { Items: [] }]]);
    m.snap.saveHome(PATHS, { tv: null, movie: undefined });
    await clock.tick(1500);
    expect(readJSON(snapKey()).trend).toEqual({});
    m.snap.saveHome(PATHS, { tv: { not: 'a list' }, movie: [] });
    await clock.tick(1500);
    expect(readJSON(snapKey()).trend).toEqual({ movie: [] });
    m.snap.saveHome(PATHS, null);
    await clock.tick(1500);
    expect(readJSON(snapKey()).trend).toEqual({});
  });

  it('the account changed (or signed out) before the write: nothing is written under anyone', async () => {
    const clock = useClock();
    await load();
    seedLive([[RESUME, { Items: [fat()] }]]);
    m.snap.saveHome(PATHS);
    m.config.cfg.userId = 'u2';
    await clock.tick(1500);
    expect(storageKeys().filter((k) => k.startsWith('reel.homeSnap.'))).toEqual([]);
    m.snap.saveHome(PATHS); // as u2 …
    m.config.cfg.userId = ''; // … who signs out
    await clock.tick(1500);
    expect(storageKeys().filter((k) => k.startsWith('reel.homeSnap.'))).toEqual([]);
  });

  it('signed out: never written; nothing in the store: not written', async () => {
    const clock = useClock();
    await load({}, { signedIn: false });
    m.snap.saveHome(PATHS);
    await clock.tick(1500);
    await load();
    m.snap.saveHome(PATHS);
    await clock.tick(1500);
    expect(storageKeys().filter((k) => k.startsWith('reel.homeSnap.'))).toEqual([]);
  });

  it('over the 300 K-char cap: Trending is dropped first; still over → no write (the old snapshot stays)', async () => {
    const clock = useClock();
    await load();
    const big = (n) => Array.from({ length: n }, (_, i) => ({ id: i, title: 'x'.repeat(1000) }));
    seedLive([[RESUME, { Items: [fat({ Id: 'cw1' })] }]]);
    m.snap.saveHome(PATHS, { tv: big(400) }); // ~400 K of trending
    await clock.tick(1500);
    const s = readJSON(snapKey());
    expect(s.trend).toBeUndefined();
    expect(s.entries[0][1].data.Items[0].Id).toBe('cw1');

    const huge = Array.from({ length: 400 }, (_, i) => fat({ Id: 'h' + i, Name: 'n'.repeat(1000) }));
    seedLive([[NEXTUP, { Items: huge }]]);
    m.snap.saveHome(PATHS);
    await clock.tick(1500);
    expect(readJSON(snapKey())).toEqual(s);
  });

  it('a full quota (setItem throws) is swallowed', async () => {
    const clock = useClock();
    await load();
    seedLive([[RESUME, { Items: [fat()] }]]);
    const ls = stubStorage({ initial: accountStorage(), throwOn: ['setItem'] });
    m.snap.saveHome(PATHS);
    await expect(clock.tick(1500)).resolves.toBeUndefined();
    expect(ls.map.has(snapKey())).toBe(false);
  });
});

/* ------------------------------------------------------------------ seed ---- */

const snapshot = (o = {}) => ({
  v: 1,
  at: Date.now(),
  entries: [
    [RESUME, { at: 1000, data: { Items: [{ Id: 'cw1', Name: 'Snap CW' }] } }],
    [LATEST_M, { at: 2000, data: [{ Id: 'lm1' }] }]
  ],
  trend: { tv: [{ id: 7 }] },
  ...o
});

describe('seedHome(): the store seeded from this user’s snapshot', () => {
  it('seeds the wanted paths (with their old `at`) and returns the trend', async () => {
    await load({ [snapKey()]: snapshot() });
    expect(m.api.cached(RESUME)).toBe(null);
    expect(m.snap.seedHome(PATHS)).toEqual({ trend: { tv: [{ id: 7 }] } });
    expect(m.api.cached(RESUME)).toEqual({ Items: [{ Id: 'cw1', Name: 'Snap CW' }] });
    expect(m.api.cached(LATEST_M)).toEqual([{ Id: 'lm1' }]);
    expect(m.api.cached(NEXTUP)).toBe(null);
    expect(m.api.storeEntries([RESUME])[0][1].at).toBe(1000); // old: a maxAge read treats it as stale
    expect(m.api.cached(RESUME, 60 * 1000)).toBe(null);
  });

  it('only the paths asked for; none of them in the snapshot → null, nothing seeded', async () => {
    await load({ [snapKey()]: snapshot() });
    expect(m.snap.seedHome([LATEST_M]).trend).toEqual({ tv: [{ id: 7 }] });
    expect(m.api.cached(RESUME)).toBe(null);
    await load({ [snapKey()]: snapshot() });
    expect(m.snap.seedHome(['/other'])).toBe(null);
    expect(m.api.cached(RESUME)).toBe(null);
  });

  it('a path already answered this session wins over the snapshot', async () => {
    await load({ [snapKey()]: snapshot() });
    seedLive([[RESUME, { Items: [{ Id: 'live' }] }]]);
    m.snap.seedHome(PATHS);
    expect(m.api.cached(RESUME)).toEqual({ Items: [{ Id: 'live' }] });
  });

  it('no trend in the snapshot → {}', async () => {
    await load({ [snapKey()]: snapshot({ trend: undefined }) });
    expect(m.snap.seedHome(PATHS)).toEqual({ trend: {} });
  });

  it('older than 14 days → null', async () => {
    const clock = useClock();
    await load({ [snapKey()]: snapshot({ at: Date.now() - 14 * DAY - 1 }) });
    expect(m.snap.seedHome(PATHS)).toBe(null);
    expect(m.api.cached(RESUME)).toBe(null);
    await load({ [snapKey()]: snapshot({ at: clock.now() - 14 * DAY }) });
    expect(m.snap.seedHome(PATHS)).not.toBe(null);
  });

  it.each([
    ['corrupted JSON', '{"v":1,"entr'],
    ['another version', snapshot({ v: 2 })],
    ['entries not a list', snapshot({ entries: { a: 1 } })],
    ['JSON null', 'null'],
    ['a bare string', '"x"']
  ])('%s → null, nothing seeded', async (_, raw) => {
    await load({ [snapKey()]: raw });
    expect(m.snap.seedHome(PATHS)).toBe(null);
    expect(m.api.cached(RESUME)).toBe(null);
  });

  it('malformed entries are skipped, good ones still seed', async () => {
    await load({
      [snapKey()]: snapshot({
        entries: ['junk', null, [RESUME, null], [NEXTUP, { at: 1 }], [42, { at: 1, data: [] }], [LATEST_M, { at: 'x', data: [{ Id: 'ok' }] }]]
      })
    });
    expect(m.snap.seedHome([...PATHS, 42])).not.toBe(null);
    expect(m.api.cached(LATEST_M)).toEqual([{ Id: 'ok' }]);
    expect(m.api.storeEntries([LATEST_M])[0][1].at).toBe(0);
    expect([m.api.cached(RESUME), m.api.cached(NEXTUP)]).toEqual([null, null]);
  });

  it('another user’s snapshot is never used', async () => {
    await load({
      'reel.accounts': [{ server: 'http://jf.test', userId: 'u2', userName: 'B', token: 't2' }],
      [snapKey('u2')]: snapshot()
    });
    expect(m.snap.seedHome(PATHS)).toBe(null);
    expect(m.api.cached(RESUME)).toBe(null);
    expect(localStorage.getItem(snapKey('u2'))).not.toBe(null); // still theirs, untouched
  });

  it('signed out → null', async () => {
    await load({ [snapKey()]: snapshot() }, { signedIn: false });
    expect(m.snap.seedHome(PATHS)).toBe(null);
  });

  it('a throwing localStorage (getItem) → null, no throw', async () => {
    await load();
    stubStorage({ initial: { ...accountStorage(), [snapKey()]: snapshot() }, throwOn: ['getItem'] });
    expect(m.snap.seedHome(PATHS)).toBe(null);
  });

  it('round trip: what saveHome wrote, seedHome seeds in the next session — without MediaSources', async () => {
    const clock = useClock();
    await load();
    seedLive([[RESUME, { Items: [fat({ Id: 'cw1' })] }]]);
    m.snap.saveHome(PATHS, { movie: [{ id: 1 }] });
    await clock.tick(1500);
    const raw = localStorage.getItem(snapKey());
    await load({ [snapKey()]: raw });
    expect(m.snap.seedHome(PATHS)).toEqual({ trend: { movie: [{ id: 1 }] } });
    const it0 = m.api.cached(RESUME).Items[0];
    expect(it0.Id).toBe('cw1');
    expect('MediaSources' in it0).toBe(false);
  });
});

/* ------------------------------------------------- module load: clean-up ---- */

describe('at module load: snapshots of signed-out accounts are dropped', () => {
  it('keeps the current user’s and every remembered account’s; drops the rest; leaves other keys alone', async () => {
    await load({
      'reel.accounts': [{ server: 'http://jf.test', userId: 'u2', userName: 'B', token: 't2' }],
      [snapKey('u1')]: snapshot(),
      [snapKey('u2')]: snapshot(),
      [snapKey('gone')]: snapshot(),
      [snapKey('')]: snapshot(),
      'reel.homeSnapshot': 'not ours',
      'reel.other': 'x'
    });
    const keys = storageKeys();
    expect(keys).toContain(snapKey('u1'));
    expect(keys).toContain(snapKey('u2'));
    expect(keys).not.toContain(snapKey('gone'));
    expect(keys).not.toContain(snapKey(''));
    expect(keys).toContain('reel.homeSnapshot');
    expect(keys).toContain('reel.other');
  });

  it('signed out with no accounts: every snapshot goes', async () => {
    await load({ [snapKey('u1')]: snapshot(), [snapKey('u2')]: snapshot() }, { signedIn: false });
    expect(storageKeys().filter((k) => k.startsWith('reel.homeSnap.'))).toEqual([]);
  });

  it('a throwing localStorage at boot: the module still loads and works', async () => {
    vi.resetModules();
    stubStorage({ throwOn: true });
    const s = await import(/* @vite-ignore */ SNAP_MODULE);
    expect(s.homeSnap).toEqual({ shown: false });
    expect(s.seedHome(PATHS)).toBe(null);
  });

  it('removeItem throwing during the clean-up is swallowed per key', async () => {
    vi.resetModules();
    const ls = stubStorage({ initial: { ...accountStorage(), [snapKey('gone')]: snapshot(), [snapKey('u1')]: snapshot() }, throwOn: ['removeItem'] });
    await import(/* @vite-ignore */ SNAP_MODULE);
    expect(ls.map.has(snapKey('u1'))).toBe(true);
    expect(ls.map.has(snapKey('gone'))).toBe(true); // couldn't, but didn't throw
  });
});
