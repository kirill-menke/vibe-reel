/* api.js path / URL builders.
 *
 * prefetch() matches by the EXACT path, and played.js invalidates by it, so a
 * warm and the screen that reads it must build byte-identical strings — these
 * tests pin them. imgUrl picks quality by size (CLAUDE.md: 1920 backdrops at
 * quality=80 are 31% smaller than 90, posters at 85 19%; changing a
 * size/quality misses Jellyfin's resize cache), and personImg uses the same
 * parameter order so the Person header reuses the cast strip's cached image. */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  qs,
  imgUrl,
  personImg,
  seasonsPath,
  episodesPaths,
  nextUpPath,
  itemPath,
  itemsPath,
  startSeason,
  empty,
  TICKS,
  ITEM_FIELDS,
  GRID_FIELDS
} from '../../src/lib/api.js';
import { cfg } from '../../src/lib/config.js';
import { TEST_SERVER, TEST_USER } from '../helpers/modules.js';

beforeEach(() => {
  cfg.server = TEST_SERVER;
  cfg.userId = TEST_USER;
});

describe('qs()', () => {
  it("drops undefined, null and '' but keeps 0 and false", () => {
    expect(qs({ a: undefined, b: null, c: '', d: 0, e: false, f: 'x' })).toBe('?d=0&e=false&f=x');
  });

  it('encodes values (not keys) and keeps insertion order', () => {
    expect(qs({ z: 'a b&c=d', y: 'Primary,Thumb', x: 'é/?' })).toBe('?z=a%20b%26c%3Dd&y=Primary%2CThumb&x=%C3%A9%2F%3F');
  });

  it('is empty for no usable values', () => {
    expect(qs({})).toBe('');
    expect(qs({ a: null, b: undefined, c: '' })).toBe('');
  });
});

describe('constants', () => {
  it('TICKS is Jellyfin ticks per second', () => {
    expect(TICKS).toBe(10000000);
  });

  it('GRID_FIELDS keeps MediaSources (tileTechBadge reads it) and nothing heavy', () => {
    expect(GRID_FIELDS).toBe('UserData,ProductionYear,PremiereDate,MediaSources');
  });

  it('ITEM_FIELDS carries MediaSources but not the top-level MediaStreams duplicate or People/Studios', () => {
    const f = ITEM_FIELDS.split(',');
    expect(f).toContain('MediaSources');
    expect(f).toContain('Overview');
    for (const heavy of ['MediaStreams', 'People', 'Studios', 'Taglines']) expect(f).not.toContain(heavy);
  });

  it('empty() is a fresh empty Jellyfin list each time', () => {
    const a = empty();
    expect(a).toEqual({ Items: [] });
    a.Items.push(1);
    expect(empty()).toEqual({ Items: [] });
  });
});

describe('imgUrl()', () => {
  const movie = { Id: 'm1', ImageTags: { Primary: 'p1', Thumb: 't1', Logo: 'l1' }, BackdropImageTags: ['b1', 'b2'] };
  const base = TEST_SERVER + '/Items/';

  it('a poster: maxHeight 480 by default at quality 85', () => {
    expect(imgUrl(movie, 'Primary')).toBe(base + 'm1/Images/Primary?tag=p1&quality=85&maxHeight=480');
  });

  it('w wins over h; quality 80 from w >= 1280', () => {
    expect(imgUrl(movie, 'Backdrop', { w: 1920 })).toBe(base + 'm1/Images/Backdrop?tag=b1&quality=80&maxWidth=1920');
    expect(imgUrl(movie, 'Backdrop', { w: 1280, h: 300 })).toBe(base + 'm1/Images/Backdrop?tag=b1&quality=80&maxWidth=1280');
    expect(imgUrl(movie, 'Backdrop', { w: 1279 })).toBe(base + 'm1/Images/Backdrop?tag=b1&quality=85&maxWidth=1279');
  });

  it('quality 80 from h >= 1080, else 85', () => {
    expect(imgUrl(movie, 'Primary', { h: 1080 })).toBe(base + 'm1/Images/Primary?tag=p1&quality=80&maxHeight=1080');
    expect(imgUrl(movie, 'Primary', { h: 1079 })).toBe(base + 'm1/Images/Primary?tag=p1&quality=85&maxHeight=1079');
    expect(imgUrl(movie, 'Primary', { h: 300 })).toBe(base + 'm1/Images/Primary?tag=p1&quality=85&maxHeight=300');
  });

  it('a big w with a small h is still big (either dimension counts)', () => {
    expect(imgUrl(movie, 'Thumb', { w: 2000, h: 100 })).toContain('quality=80');
    expect(imgUrl(movie, 'Thumb', { w: 100, h: 2000 })).toContain('quality=80');
  });

  it('Backdrop uses the first BackdropImageTags entry', () => {
    expect(imgUrl(movie, 'Backdrop')).toBe(base + 'm1/Images/Backdrop?tag=b1&quality=85&maxHeight=480');
  });

  it('opts.id overrides the item id', () => {
    expect(imgUrl(movie, 'Logo', { id: 'other' })).toBe(base + 'other/Images/Logo?tag=l1&quality=85&maxHeight=480');
  });

  it('an episode without a backdrop falls back to its parent backdrop', () => {
    const ep = { Id: 'e1', ParentBackdropItemId: 's1', ParentBackdropImageTags: ['pb'] };
    expect(imgUrl(ep, 'Backdrop', { w: 1920 })).toBe(base + 's1/Images/Backdrop?tag=pb&quality=80&maxWidth=1920');
    expect(imgUrl({ ...ep, BackdropImageTags: [] }, 'Backdrop')).toBe(base + 's1/Images/Backdrop?tag=pb&quality=85&maxHeight=480');
    // own one wins
    expect(imgUrl({ ...ep, BackdropImageTags: ['own'] }, 'Backdrop')).toContain('e1/Images/Backdrop?tag=own');
  });

  it('a parent backdrop needs both the id and the tags', () => {
    expect(imgUrl({ Id: 'e1', ParentBackdropImageTags: ['pb'] }, 'Backdrop')).toBe(null);
    expect(imgUrl({ Id: 'e1', ParentBackdropItemId: 's1' }, 'Backdrop')).toBe(null);
  });

  it('Thumb falls back to the parent thumb', () => {
    const ep = { Id: 'e1', ImageTags: {}, ParentThumbItemId: 's1', ParentThumbImageTag: 'pt' };
    expect(imgUrl(ep, 'Thumb')).toBe(base + 's1/Images/Thumb?tag=pt&quality=85&maxHeight=480');
    expect(imgUrl({ Id: 'e1', ImageTags: { Thumb: 'own' }, ParentThumbItemId: 's1', ParentThumbImageTag: 'pt' }, 'Thumb')).toContain('e1/Images/Thumb?tag=own');
    expect(imgUrl({ Id: 'e1', ParentThumbImageTag: 'pt' }, 'Thumb')).toBe(null);
  });

  it('Primary falls back to the series poster', () => {
    const ep = { Id: 'e1', SeriesId: 's1', SeriesPrimaryImageTag: 'sp' };
    expect(imgUrl(ep, 'Primary', { h: 300 })).toBe(base + 's1/Images/Primary?tag=sp&quality=85&maxHeight=300');
    expect(imgUrl({ ...ep, ImageTags: { Primary: 'own' } }, 'Primary')).toContain('e1/Images/Primary?tag=own');
  });

  it('fallbacks are per type: a series poster is not a backdrop or thumb', () => {
    const ep = { Id: 'e1', SeriesId: 's1', SeriesPrimaryImageTag: 'sp', ParentThumbItemId: 's1', ParentThumbImageTag: 'pt' };
    expect(imgUrl(ep, 'Backdrop')).toBe(null);
    expect(imgUrl({ Id: 'e1', ParentBackdropItemId: 's1', ParentBackdropImageTags: ['pb'] }, 'Thumb')).toBe(null);
    expect(imgUrl({ Id: 'e1', ParentThumbItemId: 's1', ParentThumbImageTag: 'pt' }, 'Primary')).toBe(null);
  });

  it('null when there is no tag', () => {
    expect(imgUrl({ Id: 'x' }, 'Primary')).toBe(null);
    expect(imgUrl({ Id: 'x', ImageTags: {} }, 'Logo')).toBe(null);
    expect(imgUrl({ Id: 'x', BackdropImageTags: [] }, 'Backdrop')).toBe(null);
  });

  it('uses cfg.server at call time', () => {
    cfg.server = 'http://other.test/jf';
    expect(imgUrl(movie, 'Primary')).toBe('http://other.test/jf/Items/m1/Images/Primary?tag=p1&quality=85&maxHeight=480');
  });
});

describe('personImg()', () => {
  it('the same parameter order and quality as imgUrl, at maxHeight 280', () => {
    const p = { Id: 'p1', PrimaryImageTag: 'pt' };
    expect(personImg(p)).toBe(TEST_SERVER + '/Items/p1/Images/Primary?tag=pt&quality=85&maxHeight=280');
    expect(personImg(p)).toBe(imgUrl({ Id: 'p1', ImageTags: { Primary: 'pt' } }, 'Primary', { h: 280 }));
  });

  it('null without a PrimaryImageTag', () => {
    expect(personImg({ Id: 'p1' })).toBe(null);
  });
});

describe('path builders (exact strings: prefetch matches by path)', () => {
  it('seasonsPath', () => {
    expect(seasonsPath('s1')).toBe('/Shows/s1/Seasons?UserId=u1&Fields=UserData%2CChildCount');
  });

  it('episodesPaths: the rows (no MediaSources) and the first episode with MediaSources', () => {
    expect(episodesPaths('s1', 'se2')).toEqual([
      '/Shows/s1/Episodes?SeasonId=se2&UserId=u1&Fields=Overview&EnableImageTypes=Primary%2CThumb',
      '/Shows/s1/Episodes?SeasonId=se2&UserId=u1&Fields=MediaSources&Limit=1'
    ]);
  });

  it('nextUpPath', () => {
    expect(nextUpPath('s1')).toBe('/Shows/NextUp?SeriesId=s1&UserId=u1&Limit=1&EnableResumable=true&EnableRewatching=false&DisableFirstEpisode=false');
  });

  it('itemPath / itemsPath use the 10.9+ routes with userId= (not /Users/{uid}/Items)', () => {
    expect(itemPath('abc')).toBe('/Items/abc?userId=u1');
    expect(itemsPath({ ParentId: 'lib', SortBy: 'SortName,ProductionYear', Limit: 126 })).toBe(
      '/Items?userId=u1&ParentId=lib&SortBy=SortName%2CProductionYear&Limit=126'
    );
    expect(itemsPath()).toBe('/Items?userId=u1');
  });

  it('a later cfg.userId is picked up (account switch)', () => {
    cfg.userId = 'u2';
    expect(itemPath('abc')).toBe('/Items/abc?userId=u2');
    expect(seasonsPath('s')).toContain('UserId=u2');
  });

  it('signed out: the userId parameter is left out, not sent empty', () => {
    cfg.userId = '';
    expect(itemPath('abc')).toBe('/Items/abc');
  });
});

describe('startSeason()', () => {
  const s = (played) => ({ UserData: { Played: played } });

  it('the first season not fully watched', () => {
    expect(startSeason([s(true), s(true), s(false), s(false)])).toBe(2);
    expect(startSeason([s(false), s(true)])).toBe(0);
  });

  it('a season without UserData counts as unwatched', () => {
    expect(startSeason([s(true), {}, s(false)])).toBe(1);
  });

  it('all watched or none listed → the first', () => {
    expect(startSeason([s(true), s(true)])).toBe(0);
    expect(startSeason([])).toBe(0);
  });
});
