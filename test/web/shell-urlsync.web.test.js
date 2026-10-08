/* lane shell: web/src/lib/urlsync.svelte.js — what a lookup URL carries. */
import { describe, it, expect } from 'vitest';
import { urlOf, parseUrl } from '../../web/src/lib/urlsync.svelte.js';

describe('lookup URLs', () => {
  it('carry the title and year, like a chart carries its title', () => {
    expect(urlOf('search', { name: 'lookup', params: { item: { id: '900002', type: 'movie', title: 'Iron Tide', year: 2023 } } })).toBe('/lookup/movie/900002?t=Iron+Tide&y=2023');
    expect(urlOf('search', { name: 'lookup', params: { item: { id: '420005', type: 'tv', title: 'Ä & B', year: null } } })).toBe('/lookup/tv/420005?t=%C3%84+%26+B');
    expect(urlOf('search', { name: 'lookup', params: { item: { id: '1', type: 'movie', title: '' } } })).toBe('/lookup/movie/1');
    expect(urlOf('search', { name: 'lookup', params: { item: { title: 'no id' } } })).toBe('/lookup');
  });

  it('a reload or a shared link gets them back', () => {
    const p = parseUrl('/lookup/movie/900002', '?t=Iron%20Tide&y=2023');
    expect(p.tab).toBe('search');
    expect(p.stack).toEqual([{ name: 'lookup', params: { item: { id: '900002', type: 'movie', title: 'Iron Tide', year: 2023 } } }]);
    // round trip
    const back = urlOf(p.tab, p.stack[0]);
    expect(parseUrl(back.split('?')[0], '?' + back.split('?')[1])).toEqual(p);
  });

  it('an old link without them still opens the page (title filled in by reel-api)', () => {
    expect(parseUrl('/lookup/tv/420005', '').stack).toEqual([{ name: 'lookup', params: { item: { id: '420005', type: 'tv', title: '' } } }]);
    expect(parseUrl('/lookup/movie/7', '?y=abc').stack[0].params?.item).toEqual({ id: '7', type: 'movie', title: '' });
  });
});

describe('chart URLs', () => {
  it('a genre chart linked without ?t= is titled by its genre', () => {
    expect(parseUrl('/search/chart/genre-Science%20Fiction', '').stack).toEqual([{ name: 'chart', params: { key: 'genre-Science Fiction', title: 'Science Fiction' } }]);
    expect(parseUrl('/search/chart/genre-Drama', '?t=Drama%20picks').stack[0].params).toEqual({ key: 'genre-Drama', title: 'Drama picks' });
    expect(parseUrl('/search/chart/top-movie', '').stack[0].params).toEqual({ key: 'top-movie', title: '' });
  });
});
