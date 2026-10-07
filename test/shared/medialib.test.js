/* medialib.js: the reel-api client.
 *
 * CLAUDE.md (api() — deadlines): "`mlFetch` 30 s (a hung call used to wedge the
 * activity poll's `inflight` flag)" and "Chromium 120 rejects a timed-out fetch
 * with AbortError, not TimeoutError — test both names or signal.aborted".
 * Metadata comes from GET /api/metadata/{type}/{id} "with a session
 * promise-cache"; the module header documents the normalised error shape
 * (.status, .code, .retriable only for 503 — except 'not_available' —,
 * .retryAfter from Retry-After, falling back to 60). The phone's metadata cache
 * is LRU-capped at 30 (ARCHITECTURE "Performance").
 *
 * The caches are module state, so every test imports a fresh graph; reel-api is
 * http://ml.test (freshImport's test account). */
import { describe, it, expect, beforeEach } from 'vitest';
import { freshImport, TEST_MEDIALIB, TEST_TOKEN } from '../helpers/modules.js';
import { mockFetch } from '../helpers/fetch.js';
import { useClock } from '../helpers/time.js';

const ML = TEST_MEDIALIB;
/* reel-api's guard (backend security.py) takes the signed-in user's Jellyfin token */
const AUTH = 'MediaBrowser Token="' + TEST_TOKEN + '"';
let ml, api, cfg, net;

beforeEach(async () => {
  const m = await freshImport({ modules: { ml: 'src/lib/medialib.js', api: 'src/lib/api.js', config: 'src/lib/config.js' } });
  ml = m.ml;
  api = m.api;
  cfg = m.config.cfg;
  net = mockFetch();
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = (p) => p.then((v) => ({ ok: v }), (e) => ({ err: e }));

describe('mlFetch deadline', () => {
  it('every request gets a 30 s deadline; a hang rejects at 30 s as "timed out", retriable, status 0', async () => {
    const clock = useClock();
    net.on('GET', '/api/activity', net.hang());
    const r = settle(ml.mlActivity());
    expect(clock.timeouts).toEqual([30000]);
    await clock.tick(29999);
    expect(net.calls[0].signal.aborted).toBe(false);
    await clock.tick(2);
    const { err } = await r;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('media library timed out');
    expect(err.status).toBe(0);
    expect(err.retriable).toBe(true);
    expect(api.errText(err)).toBe('media library timed out');
  });

  it.each(['AbortError', 'TimeoutError'])('a rejection named %s after the deadline fired reads as a timeout', async (name) => {
    const clock = useClock();
    net.on('GET', '/api/news', (req) => new Promise((_, rej) => req.signal.addEventListener('abort', () => rej(new DOMException('x', name)))));
    const r = settle(ml.mlNews());
    await clock.tick(30000);
    const { err } = await r;
    expect(err.message).toBe('media library timed out');
  });

  it('a connection failure (signal not aborted) reads as unreachable', async () => {
    net.on('GET', '/api/charts', net.networkError());
    const { err } = await settle(ml.mlCharts());
    expect(err.message).toBe('media library unreachable');
    expect(err.status).toBe(0);
    expect(err.retriable).toBe(true);
  });

  it("the caller's signal is combined with the deadline (Search cancels a superseded lookup)", async () => {
    const clock = useClock();
    net.on('GET', '/api/lookup', net.hang());
    const ac = new AbortController();
    const r = settle(ml.mlLookup({ q: 'dune', type: 'movie' }, ac.signal));
    expect(clock.timeouts).toEqual([30000]);
    const sent = net.calls[0].signal;
    expect(sent).not.toBe(ac.signal);
    expect(sent.aborted).toBe(false);
    ac.abort();
    const { err } = await r;
    expect(sent.aborted).toBe(true);
    expect(err.status).toBe(0);
    // the deadline still applies to a lookup nobody cancels
    const r2 = settle(ml.mlLookup({ q: 'x', type: 'tv' }, new AbortController().signal));
    await clock.tick(30001);
    expect((await r2).err.message).toBe('media library timed out');
  });

  it('a hung request does not wedge the next one: after the deadline a new call goes out and answers', async () => {
    const clock = useClock();
    net.once('GET', '/api/activity', net.hang());
    const first = settle(ml.mlActivity());
    await clock.tick(30001);
    expect((await first).err).toBeTruthy();
    net.on('GET', '/api/activity', { items: [{ id: 1 }] });
    expect(await ml.mlActivity()).toEqual({ items: [{ id: 1 }] });
    expect(net.calls).toHaveLength(2);
  });
});

describe('mlFetch error normalisation', () => {
  it('503 with Retry-After → retriable, retryAfter seconds, code/detail from the body', async () => {
    net.on('GET', '/api/activity', net.status(503, { error: 'node_down', detail: 'Sonarr unreachable' }, { 'Retry-After': '17' }));
    const { err } = await settle(ml.mlActivity());
    expect(err.status).toBe(503);
    expect(err.message).toBe('Sonarr unreachable');
    expect(err.code).toBe('node_down');
    expect(err.detail).toBe('Sonarr unreachable');
    expect(err.retriable).toBe(true);
    expect(err.retryAfter).toBe(17);
  });

  it('503 without Retry-After or JSON body → retryAfter 60, generic message and code', async () => {
    net.on('GET', '/api/activity', net.status(503, 'Service Unavailable'));
    const { err } = await settle(ml.mlActivity());
    expect(err.message).toBe('temporarily unavailable');
    expect(err.code).toBe('temporarily_unavailable');
    expect(err.detail).toBe(null);
    expect(err.retriable).toBe(true);
    expect(err.retryAfter).toBe(60);
  });

  it("503 'not_available' (no Sonarr/Radarr for that type) is NOT retriable", async () => {
    net.on('GET', '/api/lookup', net.status(503, { error: 'not_available', detail: 'no radarr configured' }));
    const { err } = await settle(ml.mlLookup({ q: 'x', type: 'movie' }));
    expect(err.code).toBe('not_available');
    expect(err.retriable).toBe(false);
    expect(err.message).toBe('no radarr configured');
  });

  it('a 503 is answered once, not retried (no exported call opts into retryOn503)', async () => {
    net.on('GET', '/api/news', net.status(503, { error: 'busy' }));
    await settle(ml.mlNews());
    expect(net.calls).toHaveLength(1);
  });

  it('other errors: message from detail, else error, else "HTTP <status>"; code from error', async () => {
    net.on('POST', '/api/library', net.status(409, { error: 'already_added', detail: 'Dune is already in the library' }));
    let { err } = await settle(ml.mlLibraryAdd({ id: 'tmdb:1', type: 'movie' }));
    expect(err.status).toBe(409);
    expect(err.code).toBe('already_added');
    expect(err.message).toBe('Dune is already in the library');
    expect(err.retriable).toBeUndefined();

    net.on('POST', '/api/news/search', net.status(409, { error: 'not_aired' }));
    ({ err } = await settle(ml.mlSeasonSearch({ id: 1, season: 2 })));
    expect(err.message).toBe('not_aired');
    expect(err.code).toBe('not_aired');

    net.on('GET', '/api/charts', net.status(500, '<html>oops</html>'));
    ({ err } = await settle(ml.mlCharts()));
    expect(err.message).toBe('HTTP 500');
    expect(err.status).toBe(500);
    expect(err.code).toBe(null);
    expect(api.errText(err)).toBe('HTTP 500');
  });

  it("probe 409 'not_ready' keeps its code (pendingplay retries on it)", async () => {
    net.on('GET', '/api/downloads/abc/probe', net.status(409, { error: 'not_ready' }));
    const { err } = await settle(ml.mlProbe('abc'));
    expect(err.status).toBe(409);
    expect(err.code).toBe('not_ready');
  });
});

describe('exact URLs, methods and bodies', () => {
  beforeEach(() => net.on(null, () => true, (req) => ({ path: req.path })));
  const last = () => net.calls[net.calls.length - 1];

  it('lookup / trending / charts / chart', async () => {
    await ml.mlLookup({ q: 'the office & co', type: 'tv' });
    expect(last().url).toBe(ML + '/api/lookup?q=the%20office%20%26%20co&type=tv');
    expect(last().method).toBe('GET');
    expect(last().init.body).toBeUndefined();
    expect(last().headers).toEqual({ Authorization: AUTH });
    await ml.mlTrending('movie');
    expect(last().url).toBe(ML + '/api/trending?type=movie');
    await ml.mlCharts();
    expect(last().url).toBe(ML + '/api/charts');
    await ml.mlChart('genre-Sci-Fi/x');
    expect(last().url).toBe(ML + '/api/charts/genre-Sci-Fi%2Fx');
  });

  it('library add (POST JSON) and undo (DELETE ?undo=)', async () => {
    await ml.mlLibraryAdd({ id: 'tvdb:81189', type: 'tv' });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(ML + '/api/library');
    expect(last().headers).toEqual({ 'Content-Type': 'application/json', Authorization: AUTH });
    expect(last().init.body).toBe(JSON.stringify({ id: 'tvdb:81189', type: 'tv' }));
    await ml.mlLibraryUndo({ id: 'tvdb:81189', type: 'tv', undo: 'tok/1' });
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe(ML + '/api/library/tv/tvdb%3A81189?undo=tok%2F1');
    await ml.mlLibraryUndo({ id: '5', type: 'movie' });
    expect(last().url).toBe(ML + '/api/library/movie/5');
  });

  it('cancel a download: DELETE with only the given season/episode/blocklist', async () => {
    await ml.mlCancelDownload({ type: 'tv', id: '81189' });
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe(ML + '/api/activity/tv/81189');
    await ml.mlCancelDownload({ type: 'tv', id: '81189', season: 2, episode: 3, blocklist: true });
    expect(last().url).toBe(ML + '/api/activity/tv/81189?season=2&episode=3&blocklist=true');
    await ml.mlCancelDownload({ type: 'tv', id: '81189', season: 0 });
    // season 0 (specials) is a real season and must not be dropped
    expect(last().url).toBe(ML + '/api/activity/tv/81189?season=0');
  });

  it('activity / news / season search + undo', async () => {
    await ml.mlActivity();
    expect(last().url).toBe(ML + '/api/activity');
    expect(last().method).toBe('GET');
    await ml.mlNews();
    expect(last().url).toBe(ML + '/api/news');
    await ml.mlSeasonSearch({ id: 81189, season: 5 });
    expect(last().method).toBe('POST');
    expect(last().url).toBe(ML + '/api/news/search');
    expect(last().init.body).toBe(JSON.stringify({ id: 81189, season: 5 }));
    await ml.mlSeasonSearchUndo('u/1');
    expect(last().method).toBe('DELETE');
    expect(last().url).toBe(ML + '/api/news/search/u%2F1');
  });

  it('metadata / segments / collection / probe / stream', async () => {
    await ml.mlMetadata('tv', 'tvdb:1');
    expect(last().url).toBe(ML + '/api/metadata/tv/tvdb%3A1');
    await ml.mlSegments('tt0903747', 1, 2);
    expect(last().url).toBe(ML + '/api/segments/tt0903747/1/2');
    await ml.mlCollection('86311');
    expect(last().url).toBe(ML + '/api/collection/86311');
    await ml.mlProbe('ABCDEF/0');
    expect(last().url).toBe(ML + '/api/downloads/ABCDEF%2F0/probe');
    // a URL the <video> fetches itself can't carry a header: the token rides as api_key
    expect(ml.mlStreamUrl('ABCDEF/0')).toBe(ML + '/api/downloads/ABCDEF%2F0/stream?api_key=' + TEST_TOKEN);
    expect(net.calls.every((c) => c.method === 'GET' && c.init.body === undefined)).toBe(true);
    expect(net.calls.every((c) => c.headers.Authorization === AUTH)).toBe(true);
  });

  it('URLs follow cfg.medialib at call time', async () => {
    cfg.medialib = 'http://other-ml.test:1';
    await ml.mlActivity();
    expect(last().url).toBe('http://other-ml.test:1/api/activity');
    expect(ml.mlStreamUrl('x')).toBe('http://other-ml.test:1/api/downloads/x/stream?api_key=' + TEST_TOKEN);
  });

  it('every request carries the token, at call time (an account switch applies at once)', async () => {
    await ml.mlActivity();
    await ml.mlNews();
    await ml.mlLibraryAdd({ id: 'tvdb:1', type: 'tv' });
    await ml.mlCancelDownload({ type: 'movie', id: '9' });
    expect(net.calls.length).toBe(4);
    expect(net.calls.map((c) => c.headers.Authorization)).toEqual([AUTH, AUTH, AUTH, AUTH]);
    cfg.token = 'tok-u2';
    await ml.mlActivity();
    expect(last().headers).toEqual({ Authorization: 'MediaBrowser Token="tok-u2"' });
  });

  it('mlHeaders / mlUrl', () => {
    expect(ml.mlHeaders()).toEqual({ Authorization: AUTH });
    expect(ml.mlHeaders(null)).toEqual({ Authorization: AUTH });
    const extra = { 'Content-Type': 'application/json' };
    expect(ml.mlHeaders(extra)).toEqual({ 'Content-Type': 'application/json', Authorization: AUTH });
    expect(extra).toEqual({ 'Content-Type': 'application/json' }); // not mutated
    expect(ml.mlUrl('/api/x')).toBe(ML + '/api/x?api_key=' + TEST_TOKEN);
    expect(ml.mlUrl('/api/x?a=1')).toBe(ML + '/api/x?a=1&api_key=' + TEST_TOKEN);
    cfg.token = 'a+b/c=';
    expect(ml.mlUrl('/s')).toBe(ML + '/s?api_key=a%2Bb%2Fc%3D');
  });
});

describe('signed out: no token anywhere', () => {
  beforeEach(async () => {
    const m = await freshImport({ storage: { 'reel.token': '' }, modules: { ml: 'src/lib/medialib.js', config: 'src/lib/config.js' } });
    ml = m.ml;
    cfg = m.config.cfg;
    net = mockFetch();
    net.on(null, () => true, (req) => ({ path: req.path }));
  });

  it('no request goes out (reel-api would 401 it): a non-retriable 401 "unauthorized"', async () => {
    expect(cfg.token).toBe('');
    for (const call of [() => ml.mlActivity(), () => ml.mlTrending('tv'), () => ml.mlCharts(), () => ml.mlLibraryAdd({ id: 'tvdb:1', type: 'tv' })]) {
      const { err } = await settle(call());
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('sign in to Jellyfin first');
      expect(err.status).toBe(401);
      expect(err.code).toBe('unauthorized');
      expect(err.retriable).toBeFalsy();
    }
    expect(net.calls).toEqual([]);
  });

  it('signing in later: the next call goes out with the token', async () => {
    await settle(ml.mlActivity());
    cfg.token = 'tok-late';
    await ml.mlActivity();
    expect(net.calls.map((c) => c.headers)).toEqual([{ Authorization: 'MediaBrowser Token="tok-late"' }]);
  });

  it('URLs and headers carry no token', () => {
    expect(ml.mlStreamUrl('x')).toBe(ML + '/api/downloads/x/stream');
    expect(ml.mlUrl('/a?b=1')).toBe(ML + '/a?b=1');
    expect(ml.mlHeaders({ X: '1' })).toEqual({ X: '1' });
  });
});

describe('trending / chart de-duplication (first type:id wins)', () => {
  it('mlTrending drops repeated type:id, keeps order and the first copy', async () => {
    net.on('GET', '/api/trending', {
      type: 'tv',
      results: [
        { type: 'tv', id: 1, title: 'A' },
        { type: 'tv', id: 2, title: 'B' },
        { type: 'tv', id: 1, title: 'A again' },
        { type: 'movie', id: 1, title: 'same id, other type' }
      ]
    });
    const r = await ml.mlTrending('tv');
    expect(r.results.map((x) => x.title)).toEqual(['A', 'B', 'same id, other type']);
    expect(r.type).toBe('tv');
  });

  it('mlTrending tolerates a missing results list', async () => {
    net.on('GET', '/api/trending', { type: 'tv' });
    expect((await ml.mlTrending('tv')).results).toEqual([]);
  });

  it('mlChart de-duplicates per section', async () => {
    net.on('GET', '/api/charts/top-tv', {
      key: 'top-tv',
      sections: [
        { type: 'tv', results: [{ type: 'tv', id: 9 }, { type: 'tv', id: 9 }, { type: 'tv', id: 8 }] },
        { type: 'tv', results: [{ type: 'tv', id: 9 }] },
        { type: 'tv' }
      ]
    });
    const c = await ml.mlChart('top-tv');
    expect(c.sections[0].results.map((x) => x.id)).toEqual([9, 8]);
    expect(c.sections[1].results.map((x) => x.id)).toEqual([9]);
    expect(c.sections[2].results).toEqual([]);
  });

  it('mlChart without sections passes through', async () => {
    net.on('GET', '/api/charts/x', { key: 'x' });
    expect(await ml.mlChart('x')).toEqual({ key: 'x' });
  });
});

describe('session promise-caches', () => {
  const cached = [
    ['mlMetadata', () => ml.mlMetadata('tv', '42'), '/api/metadata/tv/42'],
    ['mlSegments', () => ml.mlSegments('tt1', 1, 2), '/api/segments/tt1/1/2'],
    ['mlCollection', () => ml.mlCollection('7'), '/api/collection/7'],
    ['mlProbe', () => ml.mlProbe('h1'), '/api/downloads/h1/probe']
  ];

  it.each(cached)('%s: concurrent and later callers share one request', async (_n, call, path) => {
    let n = 0;
    net.on('GET', path, () => ({ n: ++n }));
    const a = call();
    const b = call();
    expect(a).toBe(b);
    expect(await a).toEqual({ n: 1 });
    expect(await call()).toEqual({ n: 1 });
    expect(net.calls).toHaveLength(1);
  });

  it.each(cached)('%s: a failure is not cached — the next caller retries', async (_n, call, path) => {
    net.once('GET', path, net.status(500));
    const { err } = await settle(call());
    expect(err.status).toBe(500);
    net.on('GET', path, { ok: true });
    expect(await call()).toEqual({ ok: true });
    expect(net.calls).toHaveLength(2);
  });

  it('metadata is keyed by type and id', async () => {
    net.on('GET', () => true, (req) => ({ path: req.path }));
    await ml.mlMetadata('tv', '1');
    await ml.mlMetadata('movie', '1');
    await ml.mlMetadata('tv', '2');
    await ml.mlMetadata('tv', '1');
    expect(net.calls.map((c) => c.path)).toEqual(['/api/metadata/tv/1', '/api/metadata/movie/1', '/api/metadata/tv/2']);
  });

  it('segments are keyed by series imdb + season + episode', async () => {
    net.on('GET', () => true, (req) => ({ path: req.path }));
    await ml.mlSegments('tt1', 1, 2);
    await ml.mlSegments('tt1', 1, 3);
    await ml.mlSegments('tt1', 2, 2);
    await ml.mlSegments('tt2', 1, 2);
    await ml.mlSegments('tt1', 1, 2);
    expect(net.calls).toHaveLength(4);
  });

  it('mlMetadata.evict forgets one answer (a series added this session gains its episodes)', async () => {
    let n = 0;
    net.on('GET', () => true, () => ({ n: ++n }));
    await ml.mlMetadata('tv', '1');
    await ml.mlMetadata('tv', '2');
    ml.mlMetadata.evict('tv', '1');
    expect(await ml.mlMetadata('tv', '1')).toEqual({ n: 3 });
    expect(await ml.mlMetadata('tv', '2')).toEqual({ n: 2 });
  });

  it('a stale rejection does not evict a newer request under the same key (V-F7)', async () => {
    let rejectFirst;
    net.once('GET', '/api/metadata/tv/1', () => new Promise((_, rej) => (rejectFirst = rej)));
    const first = settle(ml.mlMetadata('tv', '1'));
    ml.mlMetadata.evict('tv', '1');
    let n = 0;
    net.on('GET', '/api/metadata/tv/1', () => ({ n: ++n }));
    const second = ml.mlMetadata('tv', '1');
    await second;
    rejectFirst(new TypeError('Failed to fetch'));
    expect((await first).err).toBeTruthy();
    await flush();
    // the newer answer is still cached: the next caller shares it, no new fetch
    expect(ml.mlMetadata('tv', '1')).toBe(second);
    await flush();
    expect(n).toBe(1);
  });

  if (__PHONE__) {
    it('phone: the metadata cache is LRU-capped at 30 (a hit refreshes recency)', async () => {
      net.on('GET', () => true, (req) => ({ path: req.path }));
      for (let i = 0; i < 30; i++) await ml.mlMetadata('movie', String(i));
      expect(net.calls).toHaveLength(30);
      await ml.mlMetadata('movie', '0'); // hit: 0 becomes the newest
      expect(net.calls).toHaveLength(30);
      await ml.mlMetadata('movie', '30'); // 31st entry evicts the oldest, which is now 1
      await ml.mlMetadata('movie', '0');
      expect(net.calls).toHaveLength(31);
      await ml.mlMetadata('movie', '1');
      expect(net.calls).toHaveLength(32);
      expect(net.calls[31].path).toBe('/api/metadata/movie/1');
    });
  } else {
    it('TV: the metadata cache is not capped', async () => {
      net.on('GET', () => true, (req) => ({ path: req.path }));
      for (let i = 0; i < 40; i++) await ml.mlMetadata('movie', String(i));
      for (let i = 0; i < 40; i++) await ml.mlMetadata('movie', String(i));
      expect(net.calls).toHaveLength(40);
    });
  }

  it('uncached calls go out every time', async () => {
    net.on('GET', () => true, {});
    await ml.mlActivity();
    await ml.mlActivity();
    await ml.mlNews();
    await ml.mlNews();
    await ml.mlCharts();
    await ml.mlCharts();
    expect(net.calls).toHaveLength(6);
  });
});

describe('posterThumb', () => {
  it('TMDB: any size segment becomes w342', () => {
    expect(ml.posterThumb('https://image.tmdb.org/t/p/original/abc.jpg')).toBe('https://image.tmdb.org/t/p/w342/abc.jpg');
    expect(ml.posterThumb('http://image.tmdb.org/t/p/w1280/x/y.png')).toBe('http://image.tmdb.org/t/p/w342/x/y.png');
  });

  it('TVDB: _t before the extension, once', () => {
    expect(ml.posterThumb('https://artworks.thetvdb.com/banners/posters/81189-1.jpg')).toBe('https://artworks.thetvdb.com/banners/posters/81189-1_t.jpg');
    expect(ml.posterThumb('https://artworks.thetvdb.com/banners/v4/series/1/posters/abc.JPEG')).toBe('https://artworks.thetvdb.com/banners/v4/series/1/posters/abc_t.JPEG');
    expect(ml.posterThumb('https://artworks.thetvdb.com/banners/posters/81189-1_t.jpg')).toBe('https://artworks.thetvdb.com/banners/posters/81189-1_t.jpg');
  });

  it('anything else is returned untouched', () => {
    for (const u of ['https://m.media-amazon.com/images/M/x.jpg', 'https://image.tmdb.org/t/p/', 'https://artworks.thetvdb.com/banners/noext', '', null, undefined]) {
      expect(ml.posterThumb(u)).toBe(u);
    }
  });
});

/* run/design.md §6.1: ownership and quotas */
describe('mlMe / mlLibraryDelete / error bodies', () => {
  it('mlMe is GET /api/me with the token', async () => {
    net.on('GET', ML + '/api/me', { user: { id: 'u1', name: 'nicole' }, admin: false, quota: {}, titles: [] });
    expect((await ml.mlMe()).user.name).toBe('nicole');
    expect(net.calls[0].method).toBe('GET');
    expect(net.calls[0].headers.Authorization).toBe(AUTH);
  });

  it('mlLibraryDelete is DELETE /api/library/{type}/{id}?delete_files=true — never an undo', async () => {
    net.on('DELETE', () => true, { id: 'a b', type: 'tv', title: 'X', status: 'deleted', downloads_removed: 1 });
    await ml.mlLibraryDelete({ type: 'tv', id: 'a b' });
    expect(net.calls[0].method).toBe('DELETE');
    expect(net.calls[0].url).toBe(ML + '/api/library/tv/a%20b?delete_files=true');
    expect(net.calls[0].url).not.toMatch(/undo=/);
  });

  it('a non-OK answer carries its parsed body (the quota numbers ride on the 409)', async () => {
    const body = { error: 'quota_exceeded', detail: 'You already have 10 of 10 movies.', type: 'movie', used: 10, limit: 10 };
    net.on('POST', ML + '/api/library', net.status(409, body));
    const { err } = await settle(ml.mlLibraryAdd({ id: '1', type: 'movie' }));
    expect(err.status).toBe(409);
    expect(err.code).toBe('quota_exceeded');
    expect(err.body).toEqual(body);
    expect(api.errText(err)).toBe('You already have 10 of 10 movies.');
    net.on('DELETE', () => true, net.status(403, 'nope'));
    const r = await settle(ml.mlLibraryDelete({ type: 'movie', id: '1' }));
    expect(r.err.status).toBe(403);
    expect(r.err.body).toBeNull();
  });
});
