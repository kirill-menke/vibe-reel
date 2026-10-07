/* Type test (T09): api() / mlFetch()'s options and the typed reel-api wrappers. */
import { api, imgUrl, qs } from '../../../src/lib/api.js';
import { mlMetadata, mlActivity, mlLookup, mlProbe, mlChart } from '../../../src/lib/medialib.js';

/** The four api() options CLAUDE.md names (body, signal, method, keepalive). */
/** @type {TypeTest.Assert<TypeTest.Equal<keyof VR.ApiOptions, 'method' | 'body' | 'signal' | 'keepalive'>>} */
export const apiOptionKeys = true;
export const post = api('/Sessions/Playing/Stopped', { method: 'POST', body: { ItemId: 'x' }, keepalive: true });
// @ts-expect-error api() has no `timeout` option: deadlines come in as a `signal`.
export const noTimeout = api('/Items', { timeout: 5000 });

/** api() is generic, default any (the caller names the shape it reads). */
/** @type {Promise<Jf.QueryResult<Jf.BaseItemDto>>} */
export const typed = api('/Items');

/** The wrappers resolve to the reel-api shapes, not any. */
/** @type {TypeTest.Assert<TypeTest.Not<TypeTest.IsAny<Awaited<ReturnType<typeof mlMetadata>>>>>} */
export const metadataNotAny = true;
/** @type {Promise<Reel.Metadata>} */ export const meta = mlMetadata('tv', '81189');
/** @type {Promise<Reel.ActivityResponse>} */ export const act = mlActivity();
/** @type {Promise<Reel.LookupResponse>} */ export const look = mlLookup({ q: 'alien', type: 'movie' }, new AbortController().signal);
/** @type {Promise<Reel.ProbeResponse>} */ export const probe = mlProbe('abcdef');
/** @type {Promise<Reel.Chart>} */ export const chart = mlChart('top-movie');
// @ts-expect-error a lookup's type is 'tv' | 'movie' — Sonarr/Radarr, not Jellyfin's 'Series'.
export const badType = mlLookup({ q: 'x', type: 'Series' });

/** imgUrl() takes a partial: Tile.svelte builds `{ SeriesId, SeriesPrimaryImageTag }` for a series poster. */
/** @type {string | null} */
export const seriesPoster = imgUrl({ SeriesId: 's', SeriesPrimaryImageTag: 't' }, 'Primary', { h: 360 });
// @ts-expect-error 'Poster' is not a Jellyfin image type (Primary is the poster).
export const badImage = imgUrl({ Id: 'x' }, 'Poster');

/** @type {string} */
export const query = qs({ a: 1, b: undefined, c: 'x' });
