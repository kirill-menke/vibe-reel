/* offline.svelte.js — artwork, the start-up work (initOffline: kick, orphan
 * sweep, re-queue) and storage figures.
 *
 * CLAUDE.md (iPhone app): "Artwork (poster — the series' for an episode —,
 * episode still, backdrop) goes into the same folder when the download starts,
 * and the entry keeps the image URLs (`img`) so a queued title has its cover
 * too; the Downloads list renders from the cache (object URLs), so covers show
 * offline. Entries without one get it once the server answers (`fillArt`)."
 * docs/ios/ARCHITECTURE.md: "the orphan sweep runs ~10 s after boot and only
 * when stamped dirty (`reel.offline.swept`) or weekly." */
import { describe, it, expect, vi } from 'vitest';
import { bootOffline, jellyfinHls, OFFLINE_CACHE } from '../helpers/offline.js';
import { captureListeners, visibility } from '../helpers/pwa.js';
import { stubStorage } from '../helpers/storage.js';
import { movie, episode, source } from '../helpers/media.js';

const J = 'http://jf.test';
const poster = (id, tag) => J + '/Items/' + id + '/Images/Primary?tag=' + tag + '&quality=85&maxHeight=360';
const still = (id, tag) => J + '/Items/' + id + '/Images/Primary?tag=' + tag + '&quality=85&maxWidth=640';
const backdrop = (id, tag) => J + '/Items/' + id + '/Images/Backdrop?tag=' + tag + '&quality=80&maxWidth=1280';

function ep(o = {}) {
  return episode({
    Id: 'e1', Name: 'Pilot', SeriesId: 'ser1', SeriesName: 'Silo', SeriesPrimaryImageTag: 'sp1',
    ImageTags: { Primary: 'ep1' }, ParentBackdropItemId: 'ser1', ParentBackdropImageTags: ['sb1'],
    MediaSources: [source(undefined, { Id: 'se1' })],
    ...o
  });
}

describe('the artwork a copy keeps (img)', () => {
  it("an episode: the series' poster, its own still, the series backdrop", async () => {
    const h = await bootOffline();
    const e = ep();
    jellyfinHls(h, e, { segs: 1 });
    h.off.queueDownload(e, 'original');
    expect(h.entry('e1').img).toEqual({ poster: poster('ser1', 'sp1'), still: still('e1', 'ep1'), art: backdrop('ser1', 'sb1') });
    expect(h.entry('e1').pics).toBe(0);
    await h.settle();
    expect(h.files('u1.e1')).toEqual(expect.arrayContaining(['poster', 'still', 'art']));
    expect(h.entry('e1').pics).toBe(1);   // bumped once: the Downloads list re-reads its cover
  });

  it('an episode without a series poster gets none (never its own still as the poster)', async () => {
    const h = await bootOffline();
    const e = ep({ SeriesPrimaryImageTag: undefined, ImageTags: { Primary: 'ep1' } });
    const srv = jellyfinHls(h, e, { segs: 1 });
    h.off.queueDownload(e, 'original');
    expect(h.entry('e1').img.poster).toBe(null);
    expect(h.entry('e1').img.still).toBe(still('e1', 'ep1'));
    srv.item = { ...e, SeriesPrimaryImageTag: 'late' };
    await h.settle();
    // the full item fetched at the start fills in what the tapped one lacked
    expect(h.entry('e1').img.poster).toBe(poster('ser1', 'late'));
  });

  it('an episode without its own image has no still; a movie has no still', async () => {
    const h = await bootOffline();
    const e = ep({ ImageTags: {}, ParentBackdropImageTags: undefined });
    jellyfinHls(h, e, { segs: 1 });
    h.off.queueDownload(e, 'original');
    expect(h.entry('e1').img).toEqual({ poster: poster('ser1', 'sp1'), still: null, art: null });
    await h.settle();
    const m = movie({ Id: 'm1', ImageTags: { Primary: 'mp' }, BackdropImageTags: ['mb'], MediaSources: [source(undefined, { Id: 'sm1' })] });
    jellyfinHls(h, m, { segs: 1 });
    h.off.queueDownload(m, 'original');
    expect(h.entry('m1').img).toEqual({ poster: poster('m1', 'mp'), still: null, art: backdrop('m1', 'mb') });
    await h.settle();
  });

  it('artwork that failed at the start is tried again at the end of the download', async () => {
    const h = await bootOffline();
    const e = ep();
    const srv = jellyfinHls(h, e, { segs: 2 });
    let failing = true;
    srv.image = (req) => (failing && req.path.includes('/ser1/Images/Primary') ? h.net.networkError() : undefined);
    srv.seg = (i) => {
      if (i === 1) failing = false;
    };
    h.off.queueDownload(e, 'original');
    await h.settle();
    expect(h.entry('e1').state).toBe('done');
    expect(h.files('u1.e1')).toEqual(expect.arrayContaining(['poster', 'still', 'art']));
    expect(srv.images.filter((u) => u.includes('/ser1/Images/Primary'))).toHaveLength(2);
    expect(srv.images.filter((u) => u.includes('/e1/Images/Primary'))).toHaveLength(1);   // not fetched twice
    expect(h.entry('e1').pics).toBe(2);
  });

  it('an image that never answers is given up after 20 s; the download goes on', async () => {
    const h = await bootOffline();
    const e = ep();
    const srv = jellyfinHls(h, e, { segs: 1 });
    srv.image = (req) => (req.path.includes('/e1/Images/Primary') ? h.net.hang() : undefined);
    h.off.queueDownload(e, 'original');
    await h.settle();
    expect(srv.segFetches).toEqual([]);
    await h.clock.tick(19999);
    expect(srv.segFetches).toEqual([]);
    await h.clock.tick(1);
    await h.settle();
    expect(srv.segFetches.map(([i]) => i)).toEqual([0]);
    // (the end-of-download pass tries it once more and waits its 20 s too)
    await h.clock.tick(20000);
    await h.settle();
    expect(h.entry('e1').state).toBe('done');
    expect(h.files('u1.e1')).toEqual(expect.arrayContaining(['poster', 'art']));
    expect(h.files('u1.e1')).not.toContain('still');
  });

  it('a pause while artwork loads stops it at once', async () => {
    const h = await bootOffline();
    const e = ep();
    const srv = jellyfinHls(h, e, { segs: 1 });
    srv.image = () => h.net.hang();
    h.off.queueDownload(e, 'original');
    await h.settle();
    expect(srv.images).toHaveLength(1);
    h.off.pauseDownload('e1');
    await h.settle();
    expect(srv.images).toHaveLength(1);   // the other two are not even asked for
    expect(h.entry('e1').state).toBe('paused');
  });

  it('a copy deleted while its artwork loads gets no artwork written', async () => {
    const h = await bootOffline();
    const e = ep();
    const srv = jellyfinHls(h, e, { segs: 1 });
    let release;
    const held = new Promise((r) => (release = r));
    srv.image = async () => {
      await held;
      return new Response(new Blob([new Uint8Array([1])], { type: 'image/jpeg' }));
    };
    h.off.queueDownload(e, 'original');
    await h.settle();
    const del = h.off.deleteDownload('e1');
    release();
    await del;
    await h.settle();
    expect(h.allFiles()).toEqual([]);
  });

  it('artUrl(): an object URL for the first part the copy has, in the order asked; null when none', async () => {
    const h = await bootOffline({ index: [{ id: 'e1', user: 'u1', dir: 'u1.e1', state: 'done', type: 'Episode' }] });
    expect(await h.off.artUrl('e1')).toBe(null);
    h.cs.seed(OFFLINE_CACHE, '/offline/u1.e1/poster', 'P', { 'Content-Type': 'image/jpeg' });
    h.cs.seed(OFFLINE_CACHE, '/offline/u1.e1/still', 'S', { 'Content-Type': 'image/jpeg' });
    const made = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => {
      made.push(b);
      return 'blob:x' + made.length;
    });
    expect(await h.off.artUrl('e1')).toBe('blob:x1');   // default order art → still → poster
    expect(await made[0].text()).toBe('S');
    await h.off.artUrl('e1', ['poster']);
    expect(await made[1].text()).toBe('P');
    expect(await h.off.artUrl('nope')).toBe(null);
    h.cs.openFails = true;
    expect(await h.off.artUrl('e1')).toBe(null);
  });
});

describe('initOffline(): the start-up work', () => {
  async function init(opts = {}, { screen } = {}) {
    const h = await bootOffline(opts);
    // fillArt looks up every copy without a cached cover on the first kick: by
    // default the server knows none of them (a 4xx: tried once per session).
    // Routes a test adds later win over this one.
    h.net.on('GET', (r) => /^\/Items\/[^/]+$/.test(r.path), h.net.status(404));
    const vis = visibility('visible');
    const live = captureListeners();
    if (screen) h.S.screen = screen;
    h.off.initOffline();
    return { h, vis, live };
  }

  it('unsupported (no Cache Storage): does nothing at all', async () => {
    const h = await bootOffline({ caches: false });
    const live = captureListeners();
    h.off.initOffline();
    await h.clock.tick(20000);
    expect(live.added).toEqual([]);
    expect(h.st.estimate).not.toHaveBeenCalled();
  });

  it('reads the storage figures', async () => {
    const { h } = await init({ quota: 1000, usage: 400 });
    await h.settle(3);
    expect([h.off.OFF.quota, h.off.OFF.usage, h.off.OFF.persisted]).toEqual([1000, 400, false]);
    expect(h.off.freeBytes()).toBe(600);
  });

  it('storage figures that fail to read leave what was known', async () => {
    const { h } = await init();
    await h.settle(3);
    h.st.fail = true;
    h.st.persisted.mockRejectedValueOnce(new Error('no'));
    await h.off.refreshStorage();
    expect(h.off.OFF.quota).toBe(50e9);
    expect(h.off.OFF.persisted).toBe(false);
    navigator.storage.persisted = undefined;
    await h.off.refreshStorage();
    expect(h.off.OFF.persisted).toBe(null);
  });

  it('an index migrated to the signed-in account is saved right away', async () => {
    const { h } = await init({ index: [{ id: 'old', state: 'done', title: 'Old' }] });
    expect(h.index()).toEqual([expect.objectContaining({ id: 'old', user: 'u1' })]);
  });

  it('resumes a queued download at once, signed in and not on Login', async () => {
    const m = movie({ Id: 'q1', MediaSources: [source(undefined, { Id: 'sq1' })] });
    const index = [{ id: 'q1', user: 'u1', dir: 'u1.q1', type: 'Movie', state: 'downloading', quality: 'original', done: 0, total: 0, bytes: 0, title: 'Q' }];
    const { h } = await init({ index });
    jellyfinHls(h, m, { segs: 1 });
    await h.settle();
    expect(h.entry('q1').state).toBe('done');
  });

  it.each([
    ['on Login', { index: null }, 'login'],
    ['signed out', { signedIn: false }, null]
  ])('…but not %s', async (_, o, screen) => {
    const index = [{ id: 'q1', user: 'u1', dir: 'u1.q1', type: 'Movie', state: 'queued', quality: 'original', title: 'Q' }];
    const { h } = await init({ index, ...(o.signedIn === false ? { signedIn: false, storage: { 'reel.userId': 'u1' } } : {}) }, { screen });
    await h.clock.tick(4000);
    await h.settle(5);
    expect(h.net.calls.filter((c) => c.method !== 'GET' || !/^\/Items\/[^/]+$/.test(c.path))).toEqual([]);   // fillArt's lookups only
    expect(h.entry('q1').state).toBe('queued');
  });

  describe('the kick (4 s after start, on every return to the foreground, when back online)', () => {
    const parked = (o) => ({ id: 'k1', user: 'u1', dir: 'u1.k1', type: 'Movie', quality: 'original', title: 'K', done: 0, total: 0, bytes: 0, ...o });

    it("re-queues copies the suspension broke off ('Paused —'), not ones the user paused or that ran out of room", async () => {
      const index = [
        parked({ state: 'paused', error: 'Paused — Failed to fetch' }),
        parked({ id: 'k2', dir: 'u1.k2', state: 'paused', error: null }),
        parked({ id: 'k3', dir: 'u1.k3', state: 'paused', error: 'Stopped — less than 500 MB left for VibeReel on this iPhone. Delete a download or free up space, then tap to resume' })
      ];
      const { h } = await init({ index });
      const srv = jellyfinHls(h, movie({ Id: 'k1', MediaSources: [source(undefined, { Id: 'sk1' })] }), { segs: 1 });
      await h.clock.tick(3999);
      expect(h.entry('k1').state).toBe('paused');
      await h.clock.tick(1);
      await h.settle();
      expect(h.entry('k1')).toMatchObject({ state: 'done', error: null });
      expect(h.entry('k2').state).toBe('paused');
      expect(h.entry('k3').state).toBe('paused');
      expect(srv.infoCalls).toHaveLength(1);
    });

    it('syncs pending positions', async () => {
      const { h } = await init({ index: [parked({ state: 'done', sync: true, posAt: 5, pos: 10 })] });
      h.net.on('GET', '/Items/k1', { Id: 'k1', UserData: {} });
      const posts = [];
      h.net.on('POST', '/UserItems/k1/UserData', (r) => (posts.push(r), null));
      // the cover is already there, so fillArt asks nothing
      h.cs.seed(OFFLINE_CACHE, '/offline/u1.k1/poster', 'p');
      await h.clock.tick(4000);
      await h.settle(5);
      expect(posts).toHaveLength(1);
    });

    it('runs again 1.5 s after the page comes back, and 2 s after the network does; not while hidden', async () => {
      const { h, vis } = await init({ index: [parked({ state: 'paused', error: 'Paused — Failed to fetch' })] });
      const srv = jellyfinHls(h, movie({ Id: 'k1', MediaSources: [source(undefined, { Id: 'sk1' })] }), { segs: 1 });
      srv.item = () => h.net.networkError();
      await h.clock.tick(4000);
      await h.settle(5);
      // tried, failed, now waiting out its back-off: park it again by hand for the next kicks
      const park = async () => {
        h.off.pauseDownload('k1');
        await h.settle(5);
        h.entry('k1').error = 'Paused — Failed to fetch';
      };
      await park();
      const n0 = srv.itemCalls;
      vis.hide();
      await h.clock.tick(5000);
      expect(srv.itemCalls).toBe(n0);
      vis.show();
      await h.clock.tick(1499);
      expect(srv.itemCalls).toBe(n0);
      await h.clock.tick(1);
      await h.settle(5);
      expect(srv.itemCalls).toBe(n0 + 1);
      await park();
      window.dispatchEvent(new Event('online'));
      await h.clock.tick(1999);
      expect(srv.itemCalls).toBe(n0 + 1);
      await h.clock.tick(1);
      await h.settle(5);
      expect(srv.itemCalls).toBe(n0 + 2);
      await park();
      // a kick that finds the page hidden does nothing
      window.dispatchEvent(new Event('online'));
      vis.quiet('hidden');
      await h.clock.tick(2000);
      await h.settle(5);
      expect(srv.itemCalls).toBe(n0 + 2);
      expect(h.entry('k1').state).toBe('paused');
    });

    it('on Login it re-queues but does not start', async () => {
      const { h } = await init({ index: [parked({ state: 'paused', error: 'Paused — Failed to fetch' })] }, { screen: 'login' });
      await h.clock.tick(4000);
      await h.settle(5);
      expect(h.entry('k1').state).toBe('queued');
      expect(h.net.calls.filter((c) => c.path.includes('PlaybackInfo'))).toEqual([]);
    });

    it('R3-PO-1: a title the server no longer has (404) is not re-queued on every return to the foreground', async () => {
      const { h, vis } = await init();
      const m = movie({ Id: 'g1', MediaSources: [source(undefined, { Id: 'sg1' })] });
      const srv = jellyfinHls(h, m, { segs: 1 });
      srv.item = () => h.net.status(404);
      h.off.queueDownload(m, 'original');
      await h.settle();
      // a 4xx from Jellyfin is final at once: 'error' (the user retries or deletes it)
      expect(srv.itemCalls).toBe(1);
      expect(h.entry('g1')).toMatchObject({ state: 'error', error: 'Not found on the server (HTTP 404)' });
      await h.clock.tick(5000 + 15000 + 60000);
      await h.settle();
      vis.hide();
      vis.show();
      await h.clock.tick(1500);
      await h.settle();
      window.dispatchEvent(new Event('online'));
      await h.clock.tick(2000);
      await h.settle();
      expect(srv.itemCalls).toBe(1);
      expect(h.entry('g1').state).toBe('error');
    });
  });

  describe('fillArt (part of the kick): covers for copies that have none cached', () => {
    const done = (o) => ({ id: 'f1', user: 'u1', dir: 'u1.f1', type: 'Movie', state: 'done', title: 'F', done: 1, total: 1, ...o });

    it('an entry from before artwork was kept: looks the item up, keeps its URLs, caches them', async () => {
      const { h } = await init({ index: [done({ type: 'Episode', id: 'e1', dir: 'u1.e1' })] });
      const srv = jellyfinHls(h, ep(), { segs: 1 });
      await h.clock.tick(4000);
      await h.settle();
      expect(srv.itemCalls).toBe(1);
      expect(h.entry('e1')).toMatchObject({ series: 'Silo', img: { poster: poster('ser1', 'sp1'), still: still('e1', 'ep1'), art: backdrop('ser1', 'sb1') } });
      expect(h.files('u1.e1').sort()).toEqual(['art', 'poster', 'still']);
      expect(h.entry('e1').pics).toBe(2);   // once for the URLs, once for the files
    });

    it('URLs already kept: no item lookup, just the files', async () => {
      const img = { poster: poster('f1', 'p'), still: null, art: null };
      const { h } = await init({ index: [done({ img, pics: 0 })] });
      const srv = jellyfinHls(h, movie({ Id: 'f1' }), { segs: 1 });
      await h.clock.tick(4000);
      await h.settle();
      expect(srv.itemCalls).toBe(0);
      expect(h.files('u1.f1')).toEqual(['poster']);
    });

    it('a cover already cached, another account\'s copy, or the running download: left alone', async () => {
      const { h } = await init({
        index: [done({ id: 'a', dir: 'u1.a' }), done({ id: 'b', dir: 'u2.b', user: 'u2' }), done({ id: 'c', dir: 'u1.c', state: 'queued', quality: 'original' })]
      });
      h.cs.seed(OFFLINE_CACHE, '/offline/u1.a/poster', 'p');
      const srv = jellyfinHls(h, movie({ Id: 'c', MediaSources: [source(undefined, { Id: 'sc' })] }), { segs: 1 });
      srv.seg = () => h.net.hang();   // keeps 'c' running through the kick
      await h.clock.tick(4000);
      await h.settle();
      const lookups = h.net.calls.filter((c) => /^\/Items\/[^/]+$/.test(c.path)).map((c) => c.path);
      expect(lookups).toEqual(['/Items/c']);   // the download's own lookup, nothing from fillArt
    });

    it('once per session; a network failure is tried again on the next kick, a 4xx is not', async () => {
      const { h, vis } = await init({ index: [done({ id: 'n', dir: 'u1.n' }), done({ id: 'g', dir: 'u1.g' })] });
      let nAnswer = h.net.networkError();
      let n = 0;
      let g = 0;
      h.net.on('GET', '/Items/n', () => (n++, nAnswer));
      h.net.on('GET', '/Items/g', () => (g++, h.net.status(404)));
      await h.clock.tick(4000);
      await h.settle();
      expect([n, g]).toEqual([1, 1]);
      vis.show();
      await h.clock.tick(1500);
      await h.settle();
      expect([n, g]).toEqual([2, 1]);
      nAnswer = { Id: 'n', Type: 'Movie', ImageTags: { Primary: 'np' } };
      h.net.on('GET', (r) => r.path.startsWith('/Items/n/Images/'), new Response(new Blob([new Uint8Array([1])], { type: 'image/jpeg' })));
      vis.show();
      await h.clock.tick(1500);
      await h.settle();
      expect(n).toBe(3);
      expect(h.files('u1.n')).toEqual(['poster']);
      vis.show();
      await h.clock.tick(1500);
      await h.settle();
      expect([n, g]).toEqual([3, 1]);
    });

    it('one pass at a time: a kick while a lookup hangs adds none; the lookup gives up after 8 s and is tried again', async () => {
      const { h, vis } = await init({ index: [done()] });
      let n = 0;
      h.net.on('GET', '/Items/f1', () => (n++, h.net.hang()));
      await h.clock.tick(4000);
      await h.settle(3);
      expect(n).toBe(1);
      vis.show();
      await h.clock.tick(1500);
      await h.settle(3);
      expect(n).toBe(1);   // the first pass still runs
      await h.clock.tick(8000 - 1500);
      await h.settle(5);
      vis.show();
      await h.clock.tick(1500);
      await h.settle(5);
      expect(n).toBe(2);   // timed out = not the server's answer: asked again
    });

    it('a copy deleted while fillArt fetches its cover gets no file written after the delete', async () => {
      const img = { poster: poster('f1', 'p'), still: null, art: null };
      const { h } = await init({ index: [done({ img })] });
      let release;
      const held = new Promise((r) => (release = r));
      h.net.on('GET', (r) => r.path === '/Items/f1/Images/Primary', async () => {
        await held;
        return new Response(new Blob([new Uint8Array([1])], { type: 'image/jpeg' }));
      });
      await h.clock.tick(4000);
      await h.settle(3);
      await h.off.deleteDownload('f1');
      release();
      await h.settle();
      expect(h.allFiles()).toEqual([]);
    });

    it('a copy whose folder is still to be swept gets its URLs, but its files wait for the download', async () => {
      const { h } = await init({ index: [done({ state: 'paused', error: null, sweep: ['u1.f1'] })] });
      const srv = jellyfinHls(h, movie({ Id: 'f1', ImageTags: { Primary: 'fp' } }), { segs: 1 });
      await h.clock.tick(4000);
      await h.settle();
      expect(srv.itemCalls).toBe(1);
      expect(h.entry('f1').img.poster).toBe(poster('f1', 'fp'));
      expect(srv.images).toEqual([]);
    });

    it('no Cache Storage: nothing breaks', async () => {
      const { h } = await init({ index: [done()] });
      h.cs.openFails = true;
      await h.clock.tick(4000);
      await h.settle();
      expect(h.net.calls).toEqual([]);
    });
  });

  describe('orphan sweep', () => {
    function seedDirs(h) {
      for (const p of ['/offline/u1.keep/s0', '/offline/legacy/s0', '/offline/u1.gone/s0', '/offline/u1.gone/manifest', '/offline/u2.gone/s0']) h.cs.seed(OFFLINE_CACHE, p, 'x');
    }
    const index = [
      { id: 'keep', user: 'u1', dir: 'u1.keep', state: 'done', title: 'K' },
      { id: 'legacy', user: 'u1', state: 'done', title: 'L' }   // pre-account entry: files under the bare id
    ];

    it('never swept (no stamp): ~10 s after start, every folder no entry uses goes; then stamped', async () => {
      const { h } = await init({ index });
      seedDirs(h);
      await h.clock.tick(9999);
      await h.settle(3);
      expect(h.allFiles()).toHaveLength(5);
      await h.clock.tick(1);
      await h.clock.tick(1);   // (the fallback for requestIdleCallback is a 0 ms timer; the fake clock runs it 1 ms on)
      await h.settle();
      expect(h.allFiles()).toEqual(['/offline/legacy/s0', '/offline/u1.keep/s0']);
      expect(Number(localStorage.getItem('reel.offline.swept'))).toBe(h.clock.now());
    });

    it('swept within the week: not again', async () => {
      const { h } = await init({ index, storage: { 'reel.offline.swept': String(Date.UTC(2026, 0, 1, 12) - 6 * 86400e3) } });
      seedDirs(h);
      await h.clock.tick(20000);
      await h.settle();
      expect(h.allFiles()).toHaveLength(5);
    });

    it('a stamp older than a week: swept again', async () => {
      const { h } = await init({ index, storage: { 'reel.offline.swept': String(Date.UTC(2026, 0, 1, 12) - 7 * 86400e3 - 1) } });
      seedDirs(h);
      await h.clock.tick(10001);
      await h.settle();
      expect(h.allFiles()).toHaveLength(2);
    });

    it('waits for an idle period where the browser has requestIdleCallback', async () => {
      const idle = [];
      vi.stubGlobal('requestIdleCallback', (f) => idle.push(f));
      const { h } = await init({ index });
      seedDirs(h);
      await h.clock.tick(10000);
      await h.settle(3);
      expect(h.allFiles()).toHaveLength(5);
      expect(idle).toHaveLength(1);
      idle[0]();
      await h.settle();
      expect(h.allFiles()).toHaveLength(2);
    });

    it('a localStorage that throws: swept (and the stamp write fails quietly)', async () => {
      // stamped just now: the first start below does not sweep
      const { h } = await init({ index, storage: { 'reel.offline.swept': String(Date.UTC(2026, 0, 1, 12)) } });
      seedDirs(h);
      const ls = stubStorage({ throwOn: true });
      h.off.initOffline();   // a second start, with the store gone
      await h.clock.tick(10001);
      await h.settle();
      expect(h.allFiles()).toHaveLength(2);
      expect(ls.map.size).toBe(0);
    });

    it('a sweep that fails (no Cache Storage) is swallowed and not stamped', async () => {
      const { h } = await init({ index });
      h.cs.openFails = true;
      await h.clock.tick(10001);
      await h.settle();
      expect(localStorage.getItem('reel.offline.swept')).toBe(null);
    });
  });
});
