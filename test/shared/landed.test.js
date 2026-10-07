/* landed.svelte.js: "Ready to watch" in the bell.
 *
 * CLAUDE.md (Download activity → "Ready to watch" in the bell):
 * activity.svelte.js hands every *changed* feed to onFeed(), which diffs the set
 * of active grabs against the previous one; a grab that left (or went
 * `completed`) is a candidate until Jellyfin confirms it — title by the same
 * search + matchGroup() as PendingDetail's findLanded(), and for tv the exact
 * SxEy in /Shows/{id}/Episodes (a deleted/failed grab also leaves the feed).
 * Retries at 4 s…5 min, then dropped; never checked while S.screen === 'player'.
 * Episodes of one title merge into one unseen entry ("Season 2 · 8 new
 * episodes"); time is the item's DateCreated. The snapshot and candidates
 * persist (reel.landedFeed), so a landing during playback, parking or even a
 * restart is reconciled on the next poll. Entries (reel.landed, per user, last
 * 10 / 7 days) add to the bell's count; opening the bell marks them seen.
 *
 * Feeds go through the real activity poll (startActivity → one /api/activity
 * answer → stopActivity), so onFeed() sees exactly what activity.svelte.js
 * hands it. Each test imports a fresh graph; the fake clock is installed after. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { freshImport, TEST_SERVER } from '../helpers/modules.js';
import { mockFetch } from '../helpers/fetch.js';
import { useClock, START } from '../helpers/time.js';
import { readJSON } from '../helpers/storage.js';

const PHONE = __PHONE__;
const DAY = 86400000;

let L, A, S, net, clock, feedItems, jfItems, jfEpisodes, searches, episodeCalls;

async function load(storage = {}) {
  const m = await freshImport({
    storage,
    modules: {
      activity: 'src/lib/activity.svelte.js',
      landed: 'src/lib/landed.svelte.js',
      nav: 'src/lib/nav.svelte.js'
    }
  });
  L = m.landed;
  A = m.activity;
  S = m.nav.S;
  return m;
}

function routes() {
  net = mockFetch();
  feedItems = [];
  jfItems = [];
  jfEpisodes = {};
  searches = [];
  episodeCalls = [];
  net.on('GET', '/api/activity', () => ({ items: feedItems }));
  net.on('GET', '/Items', (req) => {
    searches.push({ at: Date.now() - t0, q: new URLSearchParams(req.query) });
    return { Items: jfItems };
  });
  net.on('GET', (req) => /^\/Shows\/[^/]+\/Episodes$/.test(req.path), (req) => {
    const id = req.path.split('/')[2];
    episodeCalls.push({ id, q: new URLSearchParams(req.query) });
    return { Items: jfEpisodes[id] || [] };
  });
}

let t0;
beforeEach(async () => {
  await load();
  clock = useClock();
  t0 = Date.now();
  routes();
});

afterEach(() => {
  A.stopActivity();
});

/* a cold restart: the old module's timers die with it, the store survives */
async function restart(storage) {
  A.stopActivity();
  vi.clearAllTimers();
  await load(storage);
  routes();
}

async function settle() {
  for (let i = 0; i < 6; i++) await clock.tick(0);
}

/* one /api/activity answer through the real poll */
async function feed(items) {
  feedItems = items;
  A.startActivity();
  await settle();
  A.stopActivity();
}

const mv = (o = {}) => ({ id: 1, type: 'movie', title: 'Dune', status: 'downloading', progress: 0.5, media_id: '693134', year: 2024, poster: null, ...o });
const ep = (s, e, o = {}) => ({ id: 100 + s * 10 + e, type: 'tv', title: 'Silo', status: 'downloading', progress: 0.5, media_id: '403245', season: s, episode: e, ...o });

const jfMovie = (o = {}) => ({ Id: 'jf-dune', Type: 'Movie', Name: 'Dune', ProductionYear: 2024, ProviderIds: { Tmdb: '693134' }, DateCreated: new Date(START - 3600000).toISOString(), ...o });
const jfSeries = (o = {}) => ({ Id: 'jf-silo', Type: 'Series', Name: 'Silo', ProductionYear: 2023, ProviderIds: { Tvdb: '403245' }, ...o });
const jfEp = (s, e, o = {}) => ({ Id: `jf-e${s}-${e}`, Type: 'Episode', ParentIndexNumber: s, IndexNumber: e, DateCreated: new Date(START - 60000 * (10 - e)).toISOString(), ...o });

const stored = () => (readJSON('reel.landed') || {}).u1;
const storedFeed = () => (readJSON('reel.landedFeed') || {}).u1;

describe('feed diff → candidates', () => {
  it('the first feed is only a baseline: nothing that is missing from it becomes a candidate', async () => {
    await feed([]);
    await clock.tick(600000);
    expect(searches).toEqual([]);
    expect(storedFeed()).toEqual({ snap: {}, awaiting: [] });
  });

  it('a movie grab that left the feed is checked after 4 s and recorded with its DateCreated', async () => {
    await feed([mv()]);
    await feed([]);
    expect(storedFeed().awaiting).toEqual([
      { id: 'movie:693134', k: 'movie:693134', type: 'movie', title: 'Dune', mediaId: '693134', poster: null, year: 2024, s: null, e: null, tries: 0 }
    ]);
    jfItems = [jfMovie({ ImageTags: { Primary: 'tagP' } })];
    await clock.tick(3999);
    expect(searches).toEqual([]);
    await clock.tick(1);
    await settle();
    expect(searches).toHaveLength(1);
    const q = searches[0].q;
    expect(q.get('SearchTerm')).toBe('Dune');
    expect(q.get('IncludeItemTypes')).toBe('Movie');
    expect(q.get('Fields')).toBe('ProviderIds,DateCreated');
    expect(q.get('userId')).toBe('u1');
    expect(L.landed.items).toEqual([
      {
        key: 'movie:693134',
        id: 'jf-dune',
        jfType: 'Movie',
        type: 'movie',
        title: 'Dune',
        year: 2024,
        poster: TEST_SERVER + '/Items/jf-dune/Images/Primary?tag=tagP&quality=85&maxHeight=180',
        eps: [],
        at: START - 3600000,
        seen: false
      }
    ]);
    expect(L.unseenLanded()).toBe(1);
    expect(stored()).toEqual(L.landed.items);
    expect(storedFeed().awaiting).toEqual([]);
  });

  it("a grab reporting 'completed' counts as gone", async () => {
    await feed([mv()]);
    await feed([mv({ status: 'completed', progress: 1 })]);
    jfItems = [jfMovie()];
    await clock.tick(4000);
    await settle();
    expect(L.landed.items.map((e) => e.id)).toEqual(['jf-dune']);
  });

  it('every active status counts (queued/downloading/importing/paused/warning); other types and statuses are ignored', async () => {
    const items = ['queued', 'downloading', 'importing', 'paused', 'warning'].map((status, i) => mv({ id: i, status, media_id: 'm' + i, title: 'T' + i }));
    await feed([...items, mv({ id: 9, status: 'failed', media_id: 'mf' }), { id: 10, type: 'music', title: 'X', status: 'downloading', media_id: 'a1' }]);
    expect(Object.keys(storedFeed().snap).sort()).toEqual(['movie:m0', 'movie:m1', 'movie:m2', 'movie:m3', 'movie:m4']);
  });

  it('a tv grab without season/episode is not tracked; with them it is keyed per SxE', async () => {
    await feed([ep(1, 2), { id: 5, type: 'tv', title: 'Pack', status: 'queued', media_id: '999' }]);
    expect(Object.keys(storedFeed().snap)).toEqual(['tv:403245#1x2']);
  });

  it('without a media id the title (lower-cased) is the key', async () => {
    await feed([mv({ media_id: null, title: 'The Room' })]);
    expect(Object.keys(storedFeed().snap)).toEqual(['movie:t:the room']);
  });

  it('progress changes alone (same set of grabs) add no candidate', async () => {
    await feed([mv({ progress: 0.1 })]);
    await feed([mv({ progress: 0.2 })]);
    await clock.tick(600000);
    expect(searches).toEqual([]);
  });

  it('a candidate is not added twice when the feed changes again before the check', async () => {
    await feed([mv(), ep(1, 1)]);
    await feed([ep(1, 1)]);
    await feed([ep(1, 1), mv()]); // the movie is back
    await feed([ep(1, 1)]);       // and gone again
    expect(storedFeed().awaiting.map((a) => a.id)).toEqual(['movie:693134']);
  });
});

describe('confirmation by Jellyfin', () => {
  it('a movie with a different tmdb id is a different title, even with the same name', async () => {
    await feed([mv()]);
    await feed([]);
    jfItems = [jfMovie({ ProviderIds: { Tmdb: '438631' } })];
    await clock.tick(4000);
    await settle();
    expect(L.landed.items).toEqual([]);
    expect(storedFeed().awaiting).toHaveLength(1);
    expect(storedFeed().awaiting[0].tries).toBe(1);
  });

  it('without provider ids on either side the title matches case-insensitively', async () => {
    await feed([mv({ media_id: null, title: 'dune' })]);
    await feed([]);
    jfItems = [jfMovie({ ProviderIds: {} })];
    await clock.tick(4000);
    await settle();
    expect(L.landed.items.map((e) => e.title)).toEqual(['Dune']);
  });

  it('tv: only the exact SxE in /Shows/{id}/Episodes confirms; the rest keeps waiting', async () => {
    await feed([ep(2, 1), ep(2, 2), ep(2, 3)]);
    await feed([]);
    jfItems = [jfSeries()];
    jfEpisodes['jf-silo'] = [jfEp(1, 1), jfEp(2, 1), jfEp(2, 2), jfEp(3, 3)];
    await clock.tick(4000);
    await settle();
    expect(searches).toHaveLength(1); // one search per title, not per episode
    expect(searches[0].q.get('IncludeItemTypes')).toBe('Series');
    expect(episodeCalls).toHaveLength(1);
    expect(episodeCalls[0].q.get('UserId')).toBe('u1');
    expect(episodeCalls[0].q.get('IsMissing')).toBe('false');
    expect(L.landed.items).toHaveLength(1);
    const e = L.landed.items[0];
    expect(e).toMatchObject({ key: 'tv:403245', id: 'jf-silo', jfType: 'Series', type: 'tv', title: 'Silo', eps: ['2x1', '2x2'], seen: false });
    expect(e.at).toBe(Date.parse(jfEp(2, 2).DateCreated)); // the newest of the confirmed episodes
    expect(storedFeed().awaiting.map((a) => a.id)).toEqual(['tv:403245#2x3']);
    expect(L.landedLine(e)).toBe('Season 2 · 2 new episodes');
  });

  it('tv: a multi-episode file (IndexNumberEnd) confirms the episodes inside it', async () => {
    await feed([ep(1, 2)]);
    await feed([]);
    jfItems = [jfSeries()];
    jfEpisodes['jf-silo'] = [jfEp(1, 1, { IndexNumberEnd: 3 })];
    await clock.tick(4000);
    await settle();
    expect(L.landed.items[0].eps).toEqual(['1x2']);
  });

  it('a series found but no episode yet records nothing', async () => {
    await feed([ep(1, 4)]);
    await feed([]);
    jfItems = [jfSeries()];
    jfEpisodes['jf-silo'] = [jfEp(1, 3)];
    await clock.tick(4000);
    await settle();
    expect(L.landed.items).toEqual([]);
    expect(storedFeed().awaiting[0]).toMatchObject({ id: 'tv:403245#1x4', tries: 1 });
  });

  it('a failing search is retried like a miss', async () => {
    net.on('GET', '/Items', net.status(500), { once: true });
    await feed([mv()]);
    await feed([]);
    await clock.tick(4000);
    await settle();
    expect(storedFeed().awaiting[0].tries).toBe(1);
    jfItems = [jfMovie()];
    await clock.tick(12000);
    await settle();
    expect(L.landed.items).toHaveLength(1);
  });
});

describe('retry schedule', () => {
  it('checks at 4 s, then 12 s, 30 s, 90 s and 300 s later, then drops the candidate', async () => {
    await feed([mv()]);
    t0 = Date.now();
    await feed([]);
    await clock.tick(3600000);
    expect(searches.map((s) => s.at)).toEqual([4000, 16000, 46000, 136000, 436000]);
    expect(storedFeed().awaiting).toEqual([]);
    expect(L.landed.items).toEqual([]);
  });

  it('a candidate added while a check is already scheduled joins that timer', async () => {
    await feed([mv(), ep(1, 1)]);
    t0 = Date.now();
    await feed([ep(1, 1)]);       // movie candidate, check at 4 s
    await clock.tick(4000);       // miss → tries 1, next in 12 s
    await settle();
    await feed([]);               // the episode leaves; the 12 s timer is already running
    await clock.tick(12000);
    await settle();
    expect(searches.map((s) => s.at)).toEqual([4000, 16000, 16000]);
    // both checked together; the next wait follows the least-tried one (the episode: 12 s)
    expect(storedFeed().awaiting.map((a) => [a.id, a.tries])).toEqual([['movie:693134', 2], ['tv:403245#1x1', 1]]);
    await clock.tick(12000);
    await settle();
    expect(searches.map((s) => s.at)).toEqual([4000, 16000, 16000, 28000, 28000]);
  });

  it('never checks while the player is up; re-checks every 30 s until it is gone', async () => {
    await feed([mv()]);
    t0 = Date.now();
    await feed([]);
    jfItems = [jfMovie()];
    S.screen = 'player';
    await clock.tick(100000);
    expect(searches).toEqual([]);
    expect(storedFeed().awaiting[0].tries).toBe(0); // a deferred check is not a try
    S.screen = 'home';
    await clock.tick(30000);
    await settle();
    expect(searches.map((s) => s.at)).toEqual([124000]); // 4 s + 4 × 30 s
    expect(L.landed.items).toHaveLength(1);
  });

  it(PHONE ? 'phone: a check due while the app is hidden waits for it to be visible again' : 'TV: a hidden page still checks on time', async () => {
    let hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    try {
      await feed([mv()]);
      await feed([]);
      jfItems = [jfMovie()];
      await clock.tick(60000);
      await settle();
      if (!PHONE) {
        expect(searches).toHaveLength(1);
        return;
      }
      expect(searches).toEqual([]);
      document.dispatchEvent(new Event('visibilitychange')); // still hidden: keeps waiting
      await clock.tick(60000);
      expect(searches).toEqual([]);
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      await clock.tick(4000);
      await settle();
      expect(searches).toHaveLength(1);
      expect(L.landed.items).toHaveLength(1);
    } finally {
      delete document.hidden;
    }
  });
});

describe('merging and entry time', () => {
  it('episodes landing later merge into the unseen entry, sorted by season then episode', async () => {
    await feed([ep(2, 10), ep(2, 9), ep(1, 8)]);
    await feed([ep(2, 9), ep(1, 8)]);
    jfItems = [jfSeries()];
    jfEpisodes['jf-silo'] = [jfEp(2, 10)];
    await clock.tick(4000);
    await settle();
    await feed([]);
    jfEpisodes['jf-silo'] = [jfEp(2, 10), jfEp(2, 9), jfEp(1, 8)];
    await clock.tick(4000);
    await settle();
    expect(L.landed.items).toHaveLength(1);
    expect(L.landed.items[0].eps).toEqual(['1x8', '2x9', '2x10']);
    expect(L.landedLine(L.landed.items[0])).toBe('3 new episodes');
  });

  it('after the bell was opened, a new episode starts a fresh entry instead of reviving the seen one', async () => {
    await feed([ep(1, 1), ep(1, 2)]);
    await feed([ep(1, 2)]);
    jfItems = [jfSeries()];
    jfEpisodes['jf-silo'] = [jfEp(1, 1)];
    await clock.tick(4000);
    await settle();
    L.markLandedSeen();
    await feed([]);
    jfEpisodes['jf-silo'] = [jfEp(1, 1), jfEp(1, 2)];
    await clock.tick(4000);
    await settle();
    expect(L.landed.items).toHaveLength(1);
    expect(L.landed.items[0]).toMatchObject({ eps: ['1x2'], seen: false });
    expect(L.unseenLanded()).toBe(1);
  });

  it('a DateCreated in the future or unparseable becomes now; older than 7 days is not recorded', async () => {
    const now = () => Date.now();
    await feed([mv(), mv({ id: 2, media_id: 'm2', title: 'Arrival' }), mv({ id: 3, media_id: 'm3', title: 'Old' })]);
    await feed([]);
    jfItems = [
      jfMovie({ DateCreated: new Date(START + 10 * DAY).toISOString() }),
      jfMovie({ Id: 'jf-arr', Name: 'Arrival', ProviderIds: { Tmdb: 'm2' }, DateCreated: 'garbage' }),
      jfMovie({ Id: 'jf-old', Name: 'Old', ProviderIds: { Tmdb: 'm3' }, DateCreated: new Date(START - 8 * DAY).toISOString() })
    ];
    // one search per title; each answers with all three, matchGroup picks the right one
    await clock.tick(4000);
    await settle();
    const at = Object.fromEntries(L.landed.items.map((e) => [e.id, e.at]));
    expect(at).toEqual({ 'jf-dune': now(), 'jf-arr': now() });
    expect(storedFeed().awaiting).toEqual([]); // the old one was confirmed, just not listed
  });

  it("poster: Jellyfin's Primary, else the queue poster as a thumb, else null; title/year from Jellyfin", async () => {
    await feed([mv({ poster: 'https://image.tmdb.org/t/p/original/abc.jpg', title: 'dune (2021)', media_id: '693134', year: 2021 })]);
    await feed([]);
    jfItems = [jfMovie({ ProductionYear: undefined })];
    await clock.tick(4000);
    await settle();
    expect(L.landed.items[0]).toMatchObject({ poster: 'https://image.tmdb.org/t/p/w342/abc.jpg', title: 'Dune', year: 2021 });
  });
});

describe('persistence', () => {
  it('the snapshot survives a restart: a grab that left while the app was closed becomes a candidate', async () => {
    await feed([mv()]);
    const persisted = { 'reel.landedFeed': localStorage.getItem('reel.landedFeed') };
    await restart(persisted);
    await feed([]);
    jfItems = [jfMovie()];
    await clock.tick(4000);
    await settle();
    expect(L.landed.items.map((e) => e.id)).toEqual(['jf-dune']);
  });

  it('persisted candidates are checked after a restart even when the feed has not moved', async () => {
    await feed([mv(), ep(1, 1)]);
    await feed([ep(1, 1)]);
    expect(storedFeed().awaiting).toHaveLength(1);
    const persisted = { 'reel.landedFeed': localStorage.getItem('reel.landedFeed') };
    await restart(persisted);
    jfItems = [jfMovie()];
    await clock.tick(60000);
    expect(searches).toEqual([]); // nothing until the first feed
    t0 = Date.now();
    await feed([ep(1, 1)]); // same set as the snapshot
    await clock.tick(4000);
    await settle();
    expect(searches.map((s) => s.at)).toEqual([4000]);
    expect(L.landed.items.map((e) => e.id)).toEqual(['jf-dune']);
  });

  it('reel.landed: loads only valid entries, newest first, last 10, none older than 7 days', async () => {
    const e = (i, ageDays, o = {}) => ({ key: 'movie:k' + i, id: 'i' + i, type: 'movie', title: 'T' + i, eps: [], at: START - ageDays * DAY, seen: false, ...o });
    const list = [];
    for (let i = 0; i < 12; i++) list.push(e(i, i * 0.1));
    list.push(e(20, 8));                       // too old
    list.push({ ...e(21, 0), eps: undefined }); // invalid
    list.push({ ...e(22, 0), id: '' });         // invalid
    list.push(null);
    await restart({ 'reel.landed': { u1: list.reverse(), u2: [e(30, 0)] } });
    const ids = L.landed.items.map((x) => x.id);
    expect(ids).toEqual(['i0', 'i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8', 'i9']);
  });

  it("entries and feed are per user: another user's are neither loaded nor overwritten", async () => {
    const other = [{ key: 'movie:x', id: 'x', type: 'movie', title: 'X', eps: [], at: START, seen: false }];
    await restart({ 'reel.landed': { u2: other }, 'reel.landedFeed': { u2: { snap: { 'movie:693134': {} }, awaiting: [] } } });
    expect(L.landed.items).toEqual([]);
    await feed([]); // u1 has no baseline: the u2 snapshot must not produce a candidate
    await feed([mv()]);
    await feed([]);
    jfItems = [jfMovie()];
    await clock.tick(4000);
    await settle();
    expect(readJSON('reel.landed').u2).toEqual(other);
    expect(readJSON('reel.landed').u1.map((x) => x.id)).toEqual(['jf-dune']);
    expect(readJSON('reel.landedFeed').u2).toEqual({ snap: { 'movie:693134': {} }, awaiting: [] });
  });

  it('a corrupted or non-object store starts empty', async () => {
    await restart({ 'reel.landed': '{broken', 'reel.landedFeed': '[1,2]' });
    expect(L.landed.items).toEqual([]);
    await feed([mv()]); // baseline, not a diff against garbage
    await clock.tick(60000);
    expect(searches).toEqual([]);
    expect(storedFeed().snap).toHaveProperty(['movie:693134']);
  });
});

describe('the bell', () => {
  async function seeded(items) {
    await restart({ 'reel.landed': { u1: items } });
  }
  const entry = (i, o = {}) => ({ key: 'movie:k' + i, id: 'i' + i, type: 'movie', title: 'T' + i, eps: [], at: START - i * 1000, seen: false, ...o });

  it('markLandedSeen: remembers which were fresh, marks all seen and persists it', async () => {
    await seeded([entry(1), entry(2, { seen: true }), entry(3)]);
    expect(L.unseenLanded()).toBe(2);
    L.markLandedSeen();
    expect(L.landed.fresh).toEqual(['movie:k1', 'movie:k3']);
    expect(L.unseenLanded()).toBe(0);
    expect(readJSON('reel.landed').u1.every((e) => e.seen)).toBe(true);
  });

  it('markLandedSeen with nothing new: fresh is empty and nothing is written', async () => {
    await seeded([entry(1, { seen: true })]);
    localStorage.removeItem('reel.landed');
    L.markLandedSeen();
    expect(L.landed.fresh).toEqual([]);
    expect(localStorage.getItem('reel.landed')).toBe(null);
  });

  it('markLandedSeen prunes entries that aged past 7 days while the app ran', async () => {
    await seeded([entry(1)]);
    clock.setNow(START + 7 * DAY);
    L.markLandedSeen();
    expect(L.landed.items).toEqual([]);
    expect(L.landed.fresh).toEqual([]);
  });
});

describe('landedLine / landedAgo', () => {
  it('landedLine', () => {
    expect(L.landedLine({ type: 'movie', year: 2024, eps: [] })).toBe('Movie · 2024');
    expect(L.landedLine({ type: 'movie', eps: [] })).toBe('Movie');
    expect(L.landedLine({ type: 'tv', eps: ['2x3'] })).toBe('S2E3');
    expect(L.landedLine({ type: 'tv', eps: ['2x1', '2x2', '2x3', '2x4', '2x5', '2x6', '2x7', '2x8'] })).toBe('Season 2 · 8 new episodes');
    expect(L.landedLine({ type: 'tv', eps: ['1x9', '2x1'] })).toBe('2 new episodes');
  });

  it('landedAgo', () => {
    const now = Date.now();
    const MIN = 60000;
    expect(L.landedAgo(now)).toBe('just now');
    expect(L.landedAgo(now - 29000)).toBe('just now');
    expect(L.landedAgo(now - 31000)).toBe('1 min ago');
    expect(L.landedAgo(now - 59 * MIN)).toBe('59 min ago');
    expect(L.landedAgo(now - 60 * MIN)).toBe('1 h ago');
    expect(L.landedAgo(now - 23 * 60 * MIN)).toBe('23 h ago');
    expect(L.landedAgo(now - 24 * 60 * MIN)).toBe('yesterday');
    expect(L.landedAgo(now - 35 * 60 * MIN)).toBe('yesterday');
    expect(L.landedAgo(now - 37 * 60 * MIN)).toBe('2 days ago');
    expect(L.landedAgo(now - 6 * DAY)).toBe('6 days ago');
  });
});
