/* homehide.js: "Remove from Continue Watching / Next Up" (hold OK on a Home tile).
 *
 * CLAUDE.md: Jellyfin 12.1 has no non-destructive hide, so it is a local
 * per-account list (localStorage reel.homeHidden.<userId>): Continue Watching
 * by item id + its LastPlayedDate stamp (playing it again brings it back),
 * Next Up by series id → episode id (a different next episode reappears). The
 * toast offers Undo. Never reset a position or mark played to hide a tile. */
import { describe, it, expect, beforeEach } from 'vitest';
import { hiddenFilter, hideFromHome } from '../../src/lib/homehide.js';
import { cfg } from '../../src/lib/config.js';
import { readJSON, seedStorage, stubStorage } from '../helpers/storage.js';
import { mockFetch } from '../helpers/fetch.js';

const KEY = 'reel.homeHidden.u1';

beforeEach(() => {
  cfg.userId = 'u1';
});

const cwItem = (id, ud = {}) => ({ Id: id, Type: 'Movie', UserData: { PlaybackPositionTicks: 6e9, LastPlayedDate: '2026-09-01T20:00:00Z', ...ud } });
const nuItem = (id, seriesId) => ({ Id: id, Type: 'Episode', SeriesId: seriesId });

describe('Continue Watching (cw)', () => {
  it('hides by item id under reel.homeHidden.<userId>, stamped with LastPlayedDate', () => {
    const it1 = cwItem('m1');
    hideFromHome('cw', it1);
    expect(readJSON(KEY)).toEqual({ cw: { m1: '2026-09-01T20:00:00Z' }, nu: {} });
    const f = hiddenFilter();
    expect(f.cw(it1)).toBe(true);
    expect(f.cw(cwItem('m2'))).toBe(false);
  });

  it('playing the item again (a new LastPlayedDate) brings the tile back', () => {
    hideFromHome('cw', cwItem('m1'));
    const replayed = cwItem('m1', { LastPlayedDate: '2026-09-02T21:00:00Z', PlaybackPositionTicks: 9e9 });
    expect(hiddenFilter().cw(replayed)).toBe(false);
    expect(hiddenFilter().cw(cwItem('m1'))).toBe(true);
  });

  it('falls back to the resume position as the stamp when LastPlayedDate is missing', () => {
    const a = { Id: 'm1', UserData: { PlaybackPositionTicks: 12345 } };
    hideFromHome('cw', a);
    expect(readJSON(KEY).cw.m1).toBe('12345');
    expect(hiddenFilter().cw(a)).toBe(true);
    expect(hiddenFilter().cw({ Id: 'm1', UserData: { PlaybackPositionTicks: 99999 } })).toBe(false);
  });

  it('an item without UserData is stamped "0"', () => {
    hideFromHome('cw', { Id: 'm9' });
    expect(readJSON(KEY).cw.m9).toBe('0');
    expect(hiddenFilter().cw({ Id: 'm9' })).toBe(true);
    expect(hiddenFilter().cw({ Id: 'm9', UserData: { PlaybackPositionTicks: 5 } })).toBe(false);
  });

  it('a cw hide does not hide the same id from Next Up', () => {
    hideFromHome('cw', cwItem('e1'));
    expect(hiddenFilter().nu(nuItem('e1', 's1'))).toBe(false);
  });
});

describe('Next Up (nu)', () => {
  it('hides by series id → episode id', () => {
    hideFromHome('nextup', nuItem('e5', 's1'));
    expect(readJSON(KEY)).toEqual({ cw: {}, nu: { s1: 'e5' } });
    const f = hiddenFilter();
    expect(f.nu(nuItem('e5', 's1'))).toBe(true);
    expect(f.nu(nuItem('e5', 's2'))).toBe(false);
  });

  it('a different next episode of the same series reappears', () => {
    hideFromHome('nextup', nuItem('e5', 's1'));
    expect(hiddenFilter().nu(nuItem('e6', 's1'))).toBe(false);
  });

  it('hiding a second episode of the series replaces the first', () => {
    hideFromHome('nextup', nuItem('e5', 's1'));
    hideFromHome('nextup', nuItem('e6', 's1'));
    expect(readJSON(KEY).nu).toEqual({ s1: 'e6' });
    expect(hiddenFilter().nu(nuItem('e5', 's1'))).toBe(false);
  });

  it('an item without SeriesId is keyed by its own id', () => {
    hideFromHome('nextup', { Id: 'x1' });
    expect(readJSON(KEY).nu).toEqual({ x1: 'x1' });
    expect(hiddenFilter().nu({ Id: 'x1' })).toBe(true);
  });

  it('any kind other than "cw" goes to Next Up', () => {
    hideFromHome('nu', nuItem('e1', 's1'));
    expect(readJSON(KEY)).toEqual({ cw: {}, nu: { s1: 'e1' } });
  });
});

describe('undo', () => {
  it('restores a cw tile and leaves the other entries alone', () => {
    hideFromHome('cw', cwItem('m1'));
    const undo = hideFromHome('cw', cwItem('m2'));
    hideFromHome('nextup', nuItem('e1', 's1'));
    undo();
    expect(readJSON(KEY)).toEqual({ cw: { m1: '2026-09-01T20:00:00Z' }, nu: { s1: 'e1' } });
    expect(hiddenFilter().cw(cwItem('m2'))).toBe(false);
  });

  it('restores a Next Up tile by its series key', () => {
    const undo = hideFromHome('nextup', nuItem('e5', 's1'));
    hideFromHome('cw', cwItem('m1'));
    undo();
    expect(readJSON(KEY)).toEqual({ cw: { m1: '2026-09-01T20:00:00Z' }, nu: {} });
    expect(hiddenFilter().nu(nuItem('e5', 's1'))).toBe(false);
  });

  it('reads the store again when called (works after a later hide)', () => {
    const undo = hideFromHome('cw', cwItem('m1'));
    hideFromHome('cw', cwItem('m3'));
    undo();
    expect(Object.keys(readJSON(KEY).cw)).toEqual(['m3']);
  });
});

describe('per account', () => {
  it('keys the list by cfg.userId at call time', () => {
    hideFromHome('cw', cwItem('m1'));
    cfg.userId = 'u2';
    expect(hiddenFilter().cw(cwItem('m1'))).toBe(false);
    hideFromHome('nextup', nuItem('e1', 's1'));
    expect(readJSON('reel.homeHidden.u2')).toEqual({ cw: {}, nu: { s1: 'e1' } });
    expect(readJSON(KEY)).toEqual({ cw: { m1: '2026-09-01T20:00:00Z' }, nu: {} });
    cfg.userId = 'u1';
    expect(hiddenFilter().cw(cwItem('m1'))).toBe(true);
  });
});

describe('cap: 300 per list, oldest dropped first', () => {
  it('drops the oldest cw entries past 300, keeps nu independent', () => {
    for (let i = 0; i < 302; i++) hideFromHome('cw', cwItem('m' + i));
    hideFromHome('nextup', nuItem('e1', 's1'));
    const h = readJSON(KEY);
    const ks = Object.keys(h.cw);
    expect(ks.length).toBe(300);
    expect(ks[0]).toBe('m2');
    expect(ks.at(-1)).toBe('m301');
    expect(h.nu).toEqual({ s1: 'e1' });
    const f = hiddenFilter();
    expect(f.cw(cwItem('m0'))).toBe(false);
    expect(f.cw(cwItem('m1'))).toBe(false);
    expect(f.cw(cwItem('m2'))).toBe(true);
  });

  it('drops the oldest nu entries past 300', () => {
    for (let i = 0; i < 301; i++) hideFromHome('nextup', nuItem('e' + i, 's' + i));
    const ks = Object.keys(readJSON(KEY).nu);
    expect(ks.length).toBe(300);
    expect(ks[0]).toBe('s1');
  });

  it('exactly 300 entries are all kept', () => {
    for (let i = 0; i < 300; i++) hideFromHome('cw', cwItem('m' + i));
    expect(Object.keys(readJSON(KEY).cw).length).toBe(300);
    expect(readJSON(KEY).cw.m0).toBeDefined();
  });
});

describe('broken storage', () => {
  it('corrupted JSON reads as an empty list and is overwritten on the next hide', () => {
    seedStorage({ [KEY]: '{not json' });
    expect(hiddenFilter().cw(cwItem('m1'))).toBe(false);
    hideFromHome('cw', cwItem('m1'));
    expect(readJSON(KEY)).toEqual({ cw: { m1: '2026-09-01T20:00:00Z' }, nu: {} });
  });

  it('a non-object value (number, string, null) reads as empty', () => {
    for (const v of ['42', '"x"', 'null']) {
      localStorage.setItem(KEY, v);
      const f = hiddenFilter();
      expect(f.cw(cwItem('m1'))).toBe(false);
      expect(f.nu(nuItem('e1', 's1'))).toBe(false);
    }
  });

  it('an object missing one list keeps the other', () => {
    seedStorage({ [KEY]: { nu: { s1: 'e1' } } });
    expect(hiddenFilter().nu(nuItem('e1', 's1'))).toBe(true);
    hideFromHome('cw', cwItem('m1'));
    expect(readJSON(KEY)).toEqual({ cw: { m1: '2026-09-01T20:00:00Z' }, nu: { s1: 'e1' } });
  });

  it('a throwing store: filter hides nothing, hide and undo do not throw', () => {
    stubStorage({ throwOn: true });
    const f = hiddenFilter();
    expect(f.cw(cwItem('m1'))).toBe(false);
    let undo;
    expect(() => (undo = hideFromHome('cw', cwItem('m1')))).not.toThrow();
    expect(() => undo()).not.toThrow();
  });

  it('a full store (setItem throws) is tolerated', () => {
    const ls = stubStorage({ quota: 0 });
    expect(() => hideFromHome('nextup', nuItem('e1', 's1'))).not.toThrow();
    expect(ls.map.size).toBe(0);
  });
});

describe('local only', () => {
  it('never talks to the server (no UserData rewrite, no played mark)', () => {
    const net = mockFetch();
    const undo = hideFromHome('cw', cwItem('m1'));
    hideFromHome('nextup', nuItem('e1', 's1'));
    hiddenFilter();
    undo();
    expect(net.calls).toEqual([]);
  });
});
