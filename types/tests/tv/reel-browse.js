/* Type test: reel-api browse payloads (types/reel-api.d.ts, T04) — lookup, trending,
 * charts, collection, metadata, news, IntroDB segments, trailers, push. Invented
 * fixtures shaped like backend/src/reel_api/models.py serialises them. */
import { S } from '../../../src/lib/nav.svelte.js';

/** @type {Reel.LookupResult} */
export const lookup = {
  id: '424242', type: 'movie', title: 'Glass Orchard', year: 2021, overview: 'A gardener grows a forest.',
  poster: 'https://image.example.invalid/p/424242.jpg', added: false, votes: 18234, original_title: null
};

/** @type {Reel.LookupResponse} */
export const lookupResponse = { query: 'glass orchard', type: 'movie', results: [lookup] };

/** The bell's partial ref (TopNav.svelte) is a valid S.lookup. */
/** @type {Reel.LookupRef} */
export const bellRef = { id: '7654321', type: 'tv', title: 'Harbour Lights', year: 2022, poster: null, added: true };
/** @type {VR.NavState['lookup']} */ export const navLookupFull = lookup;
/** @type {VR.NavState['lookup']} */ export const navLookupRef = bellRef;
/** @type {TypeTest.Assert<TypeTest.Not<TypeTest.IsAny<typeof S.lookup>>>} */
export const navLookupNotAny = true;

/** @type {Reel.TrendingResponse} */
export const trending = {
  type: 'movie',
  results: [{ ...lookup, imdb_id: 'tt0000002', rating: 7.9, rating_votes: 41000, rank: 37, released: '2026-06-12', digital_release: '2026-08-30' }]
};

/** @type {Reel.ChartIndex} */
export const charts = {
  categories: [
    { key: 'top-movie', title: 'Top 250 Movies', types: ['movie'], count: 250, posters: ['https://m.example.invalid/1.jpg'] },
    { key: 'genre-Drama', title: 'Drama', types: ['movie', 'tv'], count: 40, posters: [] }
  ]
};

/** @type {Reel.Chart} */
export const chart = {
  key: 'top-tv',
  title: 'Top 250 Shows',
  sections: [{ type: 'tv', title: 'Shows', results: [{ ...lookup, id: '7654321', type: 'tv', imdb_id: 'tt0000001', rating: 9.1, rating_votes: 250000, rank: 1 }] }]
};

/** @type {Reel.CollectionResponse} */
export const collection = {
  id: '999', title: 'Orchard Collection', overview: '', poster: null, fanart: null,
  movies: [{ ...lookup, rating: 7.4, released: '2021-10-01' }, { ...lookup, id: '424243', title: 'Glass Orchard II', added: false, rating: null, released: null }]
};

/** @type {Reel.Metadata} */
export const tvMetadata = {
  id: '7654321', type: 'tv', title: 'Harbour Lights', year: 2022, overview: 'Lights.', poster: null,
  fanart: 'https://artworks.example.invalid/fanart/7654321.jpg', runtime_min: 52, genres: ['Drama'], rating: 8.1,
  certification: 'TV-14', status: 'continuing',
  episodes: [{ season: 2, episode: 3, title: 'The Lighthouse Keeper', overview: '', air_date: '2023-04-09', still: null, has_file: false }]
};

/** @type {Reel.Metadata} */
export const movieMetadata = {
  id: '424242', type: 'movie', title: 'Glass Orchard', year: 2021, overview: '', poster: null, fanart: null,
  runtime_min: 118, genres: [], rating: null, certification: null, status: 'released', episodes: [],
  trailer: 'xxxxxxxxxxx', collection: { id: '999', title: 'Orchard Collection' }
};

/** @type {Reel.NewsResponse} */
export const news = {
  items: [
    { id: '7654321:3:aired', kind: 'aired', media_id: '7654321', title: 'Harbour Lights', year: 2022, poster: null, fanart: null,
      season: 3, premiere: '2026-09-01T02:00:00Z', last_aired: '2026-09-29T02:00:00Z', episodes_aired: 5, episodes_total: 8, monitored: false },
    { id: '7654321:4:upcoming', kind: 'upcoming', media_id: '7654321', title: 'Harbour Lights', year: 2022, poster: null, fanart: null,
      season: 4, premiere: null, last_aired: null, episodes_aired: 0, episodes_total: 0, monitored: true }
  ]
};

/** @type {Reel.SegmentsResponse} */
export const introdb = { intro: { start: 1, end: 35, submissions: 4 }, recap: null, outro: null };

/** @type {Reel.TrailerStatus} */
export const trailer = {
  id: 'xxxxxxxxxxx', state: 'downloading', segments: 3, buffered_s: 6.006, duration: 152.4, complete: false,
  width: 3840, height: 2160, vcodec: 'av01', codecs: 'av01.0.12M.10,opus', hdr: 'HDR10',
  subs: { lang: 'en', kind: 'auto' }, subs_done: true, title: 'Glass Orchard — Official Trailer', error: null
};

/** @type {Reel.PushConfig} */ export const pushConfig = { enabled: true, key: 'BOrA-not-a-real-key' };
/** @type {Reel.PushStatus} */ export const pushStatus = { subscribed: true, ready: true, seasons: false };
/** @type {Reel.PushSubscribeResult} */ export const pushSub = { ok: true, user: 'viewer' };

/* ---- negatives ---- */

// @ts-expect-error news kind is 'aired' | 'upcoming' only ('new' is not a kind).
/** @type {Reel.NewsItem['kind']} */ export const badKind = 'new';

// @ts-expect-error a lookup result needs `added` (and the rest): the shape is closed and complete.
/** @type {Reel.LookupResult} */ export const noAdded = { id: '1', type: 'movie', title: 'x', year: null, overview: '', poster: null };

// @ts-expect-error trailer state 'playing' does not exist (resolving/downloading/ready/error).
/** @type {Reel.TrailerStatus['state']} */ export const badState = 'playing';

// @ts-expect-error IntroDB windows are in seconds as numbers, not 'mm:ss' strings.
/** @type {Reel.CommunitySegment} */ export const strSeg = { start: '0:01', end: 35, submissions: 1 };

// @ts-expect-error MediaType is 'movie' | 'tv'; Jellyfin's 'Series' is not one.
/** @type {Reel.Metadata['type']} */ export const jfType = 'Series';

// @ts-expect-error a bare id string is not a valid S.lookup (needs at least id/type/title).
/** @type {VR.NavState['lookup']} */ export const navLookupString = '424242';
