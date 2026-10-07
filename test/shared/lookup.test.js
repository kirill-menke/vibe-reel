/* lookup.svelte.js: the "is this in the library" state of Search results,
 * trending tiles and LookupDetail, and which screen a result opens.
 *
 * CLAUDE.md (Navigation → Search): "OK opens the richest detail that exists —
 * the Jellyfin `Detail` if the title is already there (matched by tvdb/tmdb
 * `ProviderIds`, `findJellyfin()` in `lookup.svelte.js`), `PendingDetail` if its
 * first download is in flight, else **`LookupDetail`**". "Sonarr only lists
 * episodes for a series it already has" — the cached pre-add metadata is
 * dropped after an add. iPhone: "Undo/cancel: reel-api `DELETE
 * /api/library/{type}/{id}?undo=` (the add's token, ~10 min) … back the toasts'
 * Undo — wired only `if (__PHONE__)` in `lookup`/`news`". "Library files are
 * never deleted — an undo on an imported title answers 409" (the server's
 * has_files / importing codes). Trending: "Cached 6 h server-side, per session
 * client-side". */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { freshImport, TEST_MEDIALIB, TEST_SERVER, TEST_USER } from '../helpers/modules.js';
import { mockFetch } from '../helpers/fetch.js';
import { useClock, flushPromises } from '../helpers/time.js';

const PHONE = __PHONE__;
let L, A, T, N, ML, router, net;

beforeEach(async () => {
  const m = await freshImport({
    modules: {
      L: 'src/lib/lookup.svelte.js',
      A: 'src/lib/activity.svelte.js',
      T: 'src/lib/toast.svelte.js',
      N: 'src/lib/nav.svelte.js',
      ML: 'src/lib/medialib.js',
      ...(PHONE ? { router: 'phone/src/lib/router.svelte.js' } : {})
    }
  });
  ({ L, A, T, N, ML, router } = m);
  net = mockFetch();
});

const dune = { id: '693134', type: 'movie', title: 'Dune: Part Two', year: 2024, added: false };
const silo = { id: '403245', type: 'tv', title: 'Silo', year: 2023, added: false };
const toastMsg = () => T.toastState.msg;

/* where an opener went: { screen, ...params } */
function landed() {
  if (!PHONE) return { screen: N.S.screen, detailId: N.S.detailId, pendingKey: N.S.pendingKey, lookup: N.S.lookup };
  const t = router.top();
  return { screen: t.name, detailId: t.params.id, pendingKey: t.params.key, lookup: t.params.item };
}

describe('add state', () => {
  it('lookupKey separates the tvdb and tmdb id spaces', () => {
    expect(L.lookupKey(dune)).toBe('movie:693134');
    expect(L.lookupKey({ ...dune, type: 'tv' })).toBe('tv:693134');
  });

  it('addState falls back to the result’s own added flag; inLibrary is added or done', () => {
    expect(L.addState(dune)).toBe('idle');
    expect(L.addState({ ...dune, added: true })).toBe('added');
    for (const [s, inLib] of [['idle', false], ['added', true], ['adding', false], ['done', true], ['error', false]]) {
      L.adds[L.lookupKey(dune)] = s;
      expect(L.addState(dune)).toBe(s);
      expect(L.inLibrary(dune)).toBe(inLib);
    }
  });

  it('seedAdds takes the fresh flags, except over an add in flight or just finished', () => {
    L.adds['movie:1'] = 'adding';
    L.adds['movie:2'] = 'done';
    L.adds['movie:3'] = 'error';
    L.adds['movie:4'] = 'added';
    L.seedAdds([
      { id: '1', type: 'movie', added: false },
      { id: '2', type: 'movie', added: false },
      { id: '3', type: 'movie', added: false },
      { id: '4', type: 'movie', added: false },
      { id: '5', type: 'movie', added: true }
    ]);
    expect({ ...L.adds }).toEqual({ 'movie:1': 'adding', 'movie:2': 'done', 'movie:3': 'idle', 'movie:4': 'idle', 'movie:5': 'added' });
  });
});

describe('addToLibrary', () => {
  const ADD = TEST_MEDIALIB + '/api/library';

  it('POSTs { id, type }, goes adding → done and says it is downloading', async () => {
    let during;
    net.on('POST', ADD, () => {
      during = L.addState(dune);
      return { ok: true };
    });
    await L.addToLibrary(dune);
    expect(during).toBe('adding');
    expect(net.callsTo(ADD)[0].body).toEqual({ id: '693134', type: 'movie' });
    expect(L.addState(dune)).toBe('done');
    expect(toastMsg()).toBe('Added — “Dune: Part Two” is downloading');
  });

  it(PHONE ? 'phone: the toast offers Undo when the server hands out a token' : 'TV: no Undo in the toast, even with a token', async () => {
    net.on('POST', ADD, { undo: 'tok-add-1' });
    await L.addToLibrary(dune);
    expect(typeof T.toastState.undo === 'function').toBe(PHONE);
  });

  if (PHONE) {
    it('phone: no token (an older backend), no Undo', async () => {
      net.on('POST', ADD, { ok: true });
      await L.addToLibrary(dune);
      expect(T.toastState.undo).toBeNull();
    });

    it('phone: the toast’s Undo takes the add back with the token', async () => {
      net.on('POST', ADD, { undo: 'tok add/1' });
      net.on('DELETE', () => true, { ok: true });
      await L.addToLibrary(dune);
      T.toastState.undo();
      await flushPromises();
      const del = net.calls.find((c) => c.method === 'DELETE');
      expect(del.url).toBe(TEST_MEDIALIB + '/api/library/movie/693134?undo=tok%20add%2F1');
      expect(L.addState(dune)).toBe('idle');
      expect(toastMsg()).toBe('Removed “Dune: Part Two” again');
    });
  }

  it('already there (409 or already_added): counts as in the library', async () => {
    net.on('POST', ADD, net.status(409, { detail: 'exists' }));   // code-less: an older backend (lookup.quota.test.js has the coded 409s)
    await L.addToLibrary(dune);
    expect(L.addState(dune)).toBe('added');
    expect(toastMsg()).toBe('Already in your library — “Dune: Part Two”');

    net.on('POST', ADD, net.status(400, { error: 'already_added', detail: 'x' }));
    await L.addToLibrary(silo);
    expect(L.addState(silo)).toBe('added');
  });

  it('a busy backend (503) and other errors: error state, own wording', async () => {
    net.on('POST', ADD, net.status(503, { error: 'busy', detail: 'Sonarr unreachable' }));
    await L.addToLibrary(dune);
    expect(L.addState(dune)).toBe('error');
    expect(toastMsg()).toBe('Library busy — try again in a moment');

    net.on('POST', ADD, net.status(500, { detail: 'Radarr said no' }));
    await L.addToLibrary(dune);   // an error can be retried
    expect(net.callsTo(ADD)).toHaveLength(2);
    expect(L.addState(dune)).toBe('error');
    expect(toastMsg()).toBe('Add failed: Radarr said no');
  });

  it('no request while adding, or once added / done', async () => {
    for (const s of ['adding', 'added', 'done']) {
      L.adds[L.lookupKey(dune)] = s;
      await L.addToLibrary(dune);
    }
    await L.addToLibrary({ ...dune, id: '9', added: true });
    expect(net.calls).toEqual([]);
  });

  it('drops the cached pre-add metadata (Sonarr lists episodes only after the add)', async () => {
    let n = 0;
    net.on('GET', TEST_MEDIALIB + '/api/metadata/tv/403245', () => ({ title: 'Silo', episodes: ++n === 1 ? [] : [{ season: 1, episode: 1 }] }));
    net.on('POST', ADD, { ok: true });
    expect((await ML.mlMetadata('tv', '403245')).episodes).toEqual([]);
    expect((await ML.mlMetadata('tv', '403245')).episodes).toEqual([]);   // cached
    await L.addToLibrary(silo);
    expect((await ML.mlMetadata('tv', '403245')).episodes).toHaveLength(1);
    expect(n).toBe(2);
  });

  it('a failed add keeps the cached metadata', async () => {
    let n = 0;
    net.on('GET', TEST_MEDIALIB + '/api/metadata/tv/403245', () => ({ n: ++n }));
    net.on('POST', ADD, net.status(500));
    await ML.mlMetadata('tv', '403245');
    await L.addToLibrary(silo);
    await ML.mlMetadata('tv', '403245');
    expect(n).toBe(1);
  });
});

describe('undoAdd', () => {
  const DEL = TEST_MEDIALIB + '/api/library/movie/693134?undo=t1';
  beforeEach(() => {
    L.adds[L.lookupKey(dune)] = 'done';
  });

  it('only for an add that finished this session', async () => {
    L.adds[L.lookupKey(dune)] = 'added';
    await L.undoAdd(dune, 't1');
    expect(net.calls).toEqual([]);
  });

  it.each([
    ['has_files', net0 => net0.status(409, { error: 'has_files', detail: 'x' }), '“Dune: Part Two” is already arriving — it stays in your library'],
    ['importing', net0 => net0.status(409, { error: 'importing', detail: 'x' }), '“Dune: Part Two” is already arriving — it stays in your library'],
    ['410 (token expired)', net0 => net0.status(410, { error: 'expired', detail: 'x' }), 'Too late to undo — “Dune: Part Two” stays in your library'],
    ['anything else', net0 => net0.status(500, { detail: 'boom' }), 'Couldn’t undo: boom']
  ])('%s: stays done, says why', async (_, answer, msg) => {
    net.on('DELETE', DEL, answer(net));
    await L.undoAdd(dune, 't1');
    expect(L.addState(dune)).toBe('done');
    expect(toastMsg()).toBe(msg);
  });
});

describe('findJellyfin', () => {
  const items = (list) => net.on('GET', '/Items', (req) => ((last = req), { Items: list }));
  let last;

  it('searches the title among Movies / Series with ProviderIds', async () => {
    items([]);
    await L.findJellyfin(dune);
    expect(last.url.startsWith(TEST_SERVER + '/Items?')).toBe(true);
    const q = new URLSearchParams(last.query);
    expect(Object.fromEntries(q)).toMatchObject({ userId: TEST_USER, searchTerm: 'Dune: Part Two', IncludeItemTypes: 'Movie', Recursive: 'true', Fields: 'ProviderIds,ProductionYear', Limit: '20' });
    await L.findJellyfin(silo);
    expect(new URLSearchParams(last.query).get('IncludeItemTypes')).toBe('Series');
  });

  it('matches a movie by tmdb id, a show by tvdb id (any key case), ignoring the title', async () => {
    items([
      { Id: 'a', Name: 'Dune: Part Two', ProviderIds: { Tmdb: '1' } },
      { Id: 'b', Name: 'Dune Part 2 (Extended)', ProviderIds: { Tmdb: '693134' } }
    ]);
    expect((await L.findJellyfin(dune)).Id).toBe('b');
    items([{ Id: 's', Name: 'Silo (2023)', ProviderIds: { tvdb: '403245', Tmdb: '693134' } }]);
    expect((await L.findJellyfin(silo)).Id).toBe('s');
    expect(await L.findJellyfin({ ...dune, type: 'tv', id: '693134' })).toBeNull();   // tmdb ≠ tvdb
  });

  it('a same-title (+ same-year) match only stands in when Jellyfin has no id of that kind', async () => {
    items([{ Id: 'other', Name: 'Dune: Part Two', ProductionYear: 2024, ProviderIds: { Tmdb: '42' } }]);
    expect(await L.findJellyfin(dune)).toBeNull();
    items([{ Id: 'x', Name: 'dune: part two', ProductionYear: 2024, ProviderIds: { Imdb: 'tt15239678' } }]);
    expect((await L.findJellyfin(dune)).Id).toBe('x');
    items([{ Id: 'y', Name: 'Dune: Part Two', ProductionYear: 1984 }]);
    expect(await L.findJellyfin(dune)).toBeNull();
    items([{ Id: 'z', Name: 'Dune: Part Two' }]);
    expect((await L.findJellyfin(dune)).Id).toBe('z');
    items([{ Id: 'w', Name: 'Dune: Part Two', ProductionYear: 1984 }]);
    expect((await L.findJellyfin({ ...dune, year: null })).Id).toBe('w');
  });
});

describe('lookupOpener: the richest screen that exists', () => {
  it('in the library and found in Jellyfin → its detail page', async () => {
    net.on('GET', '/Items', { Items: [{ Id: 'jf-dune', Type: 'Movie', ProviderIds: { Tmdb: '693134' } }] });
    const open = await L.lookupOpener({ ...dune, added: true });
    open();
    expect(landed()).toMatchObject({ screen: 'detail', detailId: 'jf-dune' });
  });

  it('in the library, not in Jellyfin yet, downloading → PendingDetail', async () => {
    net.on('GET', '/Items', { Items: [] });
    A.act.items = [{ id: 1, type: 'movie', title: 'Dune: Part Two', status: 'downloading', progress: 40, media_id: '693134' }];
    L.adds[L.lookupKey(dune)] = 'done';
    (await L.lookupOpener(dune))();
    expect(landed()).toMatchObject({ screen: 'pending', pendingKey: 'movie:693134' });
    expect(L.lookupGroup(dune).key).toBe('movie:693134');
  });

  it('in the library but the Jellyfin search fails and nothing downloads → LookupDetail', async () => {
    net.on('GET', '/Items', net.status(500));
    (await L.lookupOpener({ ...dune, added: true }))();
    expect(landed()).toMatchObject({ screen: 'lookup' });
    expect(landed().lookup.id).toBe('693134');
  });

  it('not in the library → LookupDetail without asking Jellyfin', async () => {
    (await L.lookupOpener(silo))();
    expect(net.calls).toEqual([]);
    expect(landed()).toMatchObject({ screen: 'lookup' });
  });

  it('lookupGroup is null without a download for that id', () => {
    A.act.items = [{ id: 1, type: 'tv', title: 'Silo', status: 'downloading', media_id: '403245', season: 1, episode: 1 }];
    expect(L.lookupGroup(dune)).toBeNull();
    expect(L.lookupGroup(silo).mediaId).toBe('403245');
  });
});

describe('trending', () => {
  const URL_TV = TEST_MEDIALIB + '/api/trending?type=tv';

  it('one request for concurrent callers; the list seeds the add states', async () => {
    net.on('GET', URL_TV, { results: [{ id: '1', type: 'tv', title: 'A', added: true }, { id: '2', type: 'tv', title: 'B' }] });
    const [a, b] = await Promise.all([L.refreshTrending('tv'), L.refreshTrending('tv')]);
    expect(a).toBe(b);
    expect(net.callsTo(URL_TV)).toHaveLength(1);
    expect(L.trending.tv.map((x) => x.id)).toEqual(['1', '2']);
    expect(L.addState({ id: '1', type: 'tv' })).toBe('added');
    expect(L.addState({ id: '2', type: 'tv' })).toBe('idle');
  });

  it('maxAge keeps a list fetched that recently; without it every call revalidates', async () => {
    const clock = useClock();
    net.on('GET', URL_TV, { results: [] });
    await L.refreshTrending('tv', 60000);
    await clock.tick(59000);
    await L.refreshTrending('tv', 60000);
    expect(net.callsTo(URL_TV)).toHaveLength(1);
    await clock.tick(2000);
    await L.refreshTrending('tv', 60000);
    expect(net.callsTo(URL_TV)).toHaveLength(2);
    await L.refreshTrending('tv');
    expect(net.callsTo(URL_TV)).toHaveLength(3);
  });

  it('a failure keeps the last list (and the next call tries again)', async () => {
    net.on('GET', URL_TV, { results: [{ id: '1', type: 'tv', title: 'A' }] });
    await L.refreshTrending('tv');
    net.on('GET', URL_TV, net.status(500));
    await expect(L.refreshTrending('tv')).rejects.toThrow();
    expect(L.trending.tv.map((x) => x.id)).toEqual(['1']);
    await expect(L.refreshTrending('tv')).rejects.toThrow();
    expect(net.callsTo(URL_TV)).toHaveLength(3);
  });

  it('the two types are separate', async () => {
    net.on('GET', URL_TV, { results: [{ id: '1', type: 'tv' }] });
    net.on('GET', TEST_MEDIALIB + '/api/trending?type=movie', { results: [{ id: '7', type: 'movie' }] });
    await Promise.all([L.refreshTrending('tv'), L.refreshTrending('movie')]);
    expect(L.trending.movie.map((x) => x.id)).toEqual(['7']);
    expect(L.trending.tv.map((x) => x.id)).toEqual(['1']);
  });
});

describe('backdrops', () => {
  it('fanartUrl: TMDB originals at w1280; TVDB and others untouched', () => {
    expect(L.fanartUrl('https://image.tmdb.org/t/p/original/abc.jpg')).toBe('https://image.tmdb.org/t/p/w1280/abc.jpg');
    expect(L.fanartUrl('http://image.tmdb.org/t/p/original/x/y.png')).toBe('http://image.tmdb.org/t/p/w1280/x/y.png');
    expect(L.fanartUrl('https://image.tmdb.org/t/p/w780/abc.jpg')).toBe('https://image.tmdb.org/t/p/w780/abc.jpg');
    expect(L.fanartUrl('https://artworks.thetvdb.com/banners/fanart/original/1.jpg')).toBe('https://artworks.thetvdb.com/banners/fanart/original/1.jpg');
    expect(L.fanartUrl('')).toBeNull();
    expect(L.fanartUrl(undefined)).toBeNull();
  });

  it('lookupBackdrop: the fanart, else the metadata poster, else the result’s poster', async () => {
    net.on('GET', TEST_MEDIALIB + '/api/metadata/movie/693134', { fanart: 'https://image.tmdb.org/t/p/original/f.jpg', poster: 'p' });
    expect(await L.lookupBackdrop(dune)).toMatchObject({ bg: 'https://image.tmdb.org/t/p/w1280/f.jpg' });
    net.on('GET', TEST_MEDIALIB + '/api/metadata/tv/403245', { poster: 'https://image.tmdb.org/t/p/original/p.jpg' });
    expect((await L.lookupBackdrop(silo)).bg).toBe('https://image.tmdb.org/t/p/w1280/p.jpg');
  });

  it('lookupBackdrop: a failing or slow metadata call falls back to the result’s poster (1.5 s)', async () => {
    const clock = useClock();
    net.on('GET', TEST_MEDIALIB + '/api/metadata/movie/693134', net.status(500));
    expect(await L.lookupBackdrop({ ...dune, poster: 'P1' })).toEqual({ bg: 'P1', meta: null });
    net.on('GET', TEST_MEDIALIB + '/api/metadata/tv/403245', () => new Promise(() => {}));
    let out = null;
    L.lookupBackdrop({ ...silo, poster: 'P2' }).then((r) => (out = r));
    await clock.tick(1400);
    expect(out).toBeNull();
    await clock.tick(200);
    expect(out).toEqual({ bg: 'P2', meta: null });
  });
});
