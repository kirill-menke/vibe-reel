/* src/lib/medialib.js in the web build (lane browse): poster sizes follow the
 * window and its devicePixelRatio (posterThumb → pickSize), and a reel-api
 * failure without a reason of its own reads like api()'s Jellyfin failures
 * ("The server had a problem (HTTP 500)", not a bare "HTTP 500"). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshImport, TEST_MEDIALIB } from '../helpers/modules.js';
import { mockFetch } from '../helpers/fetch.js';
import { useClock } from '../helpers/time.js';

let ml, api, net;
const setWin = (w, dpr) => {
  Object.defineProperty(globalThis, 'innerWidth', { value: w, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'devicePixelRatio', { value: dpr, configurable: true, writable: true });
};
const win0 = { w: globalThis.innerWidth, dpr: globalThis.devicePixelRatio };

beforeEach(async () => {
  const m = await freshImport({ modules: { ml: 'src/lib/medialib.js', api: 'src/lib/api.js' } });
  ml = m.ml;
  api = m.api;
  net = mockFetch();
});
afterEach(() => setWin(win0.w, win0.dpr));

const TMDB = 'https://image.tmdb.org/t/p/original/abc.jpg';
const TVDB = 'https://artworks.thetvdb.com/banners/posters/81189-1.jpg';

describe('posterThumb on the web', () => {
  it('w342 / _t where a poster is small (dpr 1, or dpr 2 up to ~1440)', () => {
    for (const [w, d] of [[1440, 1], [2560, 1], [1280, 2], [1440, 2]]) {
      setWin(w, d);
      expect(ml.posterThumb(TMDB)).toBe('https://image.tmdb.org/t/p/w342/abc.jpg');
      expect(ml.posterThumb(TVDB)).toBe('https://artworks.thetvdb.com/banners/posters/81189-1_t.jpg');
    }
  });

  it('w500 and the TVDB original on a big dpr-2 window (posters 200–236 CSS px)', () => {
    for (const w of [1920, 2560]) {
      setWin(w, 2);
      expect(ml.posterThumb(TMDB)).toBe('https://image.tmdb.org/t/p/w500/abc.jpg');
      expect(ml.posterThumb(TVDB)).toBe(TVDB);
    }
  });

  it('w780 at dpr 3', () => {
    setWin(1920, 3);
    expect(ml.posterThumb(TMDB)).toBe('https://image.tmdb.org/t/p/w780/abc.jpg');
  });

  it('anything else is still returned untouched', () => {
    setWin(2560, 2);
    for (const u of ['https://m.media-amazon.com/images/M/x.jpg', '', null, undefined]) expect(ml.posterThumb(u)).toBe(u);
  });
});

describe('reel-api failures in words', () => {
  const ML = TEST_MEDIALIB;
  it.each([
    [500, 'The server had a problem (HTTP 500)'],
    [502, 'The server had a problem (HTTP 502)'],
    [404, 'Not found on the server (HTTP 404)'],
    [401, 'The server refused this sign-in (HTTP 401)'],
    [403, 'The server refused this sign-in (HTTP 403)'],
    [418, 'The server answered HTTP 418']
  ])('HTTP %i without a body → %s', async (code, text) => {
    net.on('GET', ML + '/api/charts/top-movie', net.status(code, 'oops'));
    const err = await ml.mlChart('top-movie').catch((e) => e);
    expect(err.status).toBe(code);
    expect(err.message).toBe('HTTP ' + code);
    expect(api.errText(err)).toBe(text);
  });

  it("reel-api's own reason wins", async () => {
    net.on('GET', ML + '/api/charts/top-movie', net.status(500, JSON.stringify({ error: 'upstream', detail: 'IMDb did not answer' }), { 'content-type': 'application/json' }));
    const err = await ml.mlChart('top-movie').catch((e) => e);
    expect(api.errText(err)).toBe('IMDb did not answer');
  });

  it('unreachable / timed out', async () => {
    net.on('GET', ML + '/api/charts', net.networkError());
    expect(api.errText(await ml.mlCharts().catch((e) => e))).toBe('Can’t reach the media library');
    const clock = useClock();
    net.on('GET', ML + '/api/news', net.hang());
    const p = ml.mlNews().catch((e) => e);
    await clock.tick(30001);
    const err = await p;
    expect(err.message).toBe('media library timed out');
    expect(api.errText(err)).toBe('The media library took too long to answer');
  });
});
