/* landed.svelte.js ("Ready to watch"): edges found by mutation testing
 * (hardening round, Stryker on landed.svelte.js). Each pins documented
 * behaviour landed.test.js left loose:
 *   - the diff is about the *set* of grabs: one leaving while another arrives
 *     (same count) is still a candidate;
 *   - a pending check is not postponed by the 4 s polls of a feed that only
 *     changes its progress;
 *   - the Jellyfin search is recursive, the episode list carries DateCreated
 *     (the entry time is the episode's, also for tv), a multi-episode file
 *     confirms exactly the episodes it spans;
 *   - merging keeps the newest time and the last known poster; a fresh entry's
 *     episodes are sorted; landedLine counts seasons ≥ 10 correctly;
 *   - corrupted stores at module init ('null', a number, a junk snapshot) start
 *     clean and heal on the next write (CLAUDE.md: guarded storage at module init);
 *   - phone: a check deferred by a hidden app resumes after a second hide too.
 *
 * Same harness as landed.test.js: feeds go through the real activity poll. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { freshImport } from '../helpers/modules.js';
import { mockFetch } from '../helpers/fetch.js';
import { useClock, START } from '../helpers/time.js';
import { readJSON } from '../helpers/storage.js';

const PHONE = __PHONE__;
const DAY = 86400000;

let L, A, S, net, clock, feedItems, jfItems, jfEpisodes, searches, episodeCalls, t0;

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

beforeEach(async () => {
  await load();
  clock = useClock();
  t0 = Date.now();
  routes();
});

afterEach(() => {
  A.stopActivity();
});

async function restart(storage) {
  A.stopActivity();
  vi.clearAllTimers();
  await load(storage);
  routes();
}

async function settle() {
  for (let i = 0; i < 6; i++) await clock.tick(0);
}

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

const storedFeed = () => (readJSON('reel.landedFeed') || {}).u1;

describe('the feed diff is about the set of grabs', () => {
  it('one grab leaving while another arrives (same count) still makes a candidate', async () => {
    await feed([mv(), ep(1, 1)]);
    await feed([ep(1, 1), ep(1, 2)]); // Dune left, S1E2 arrived: still two grabs
    expect(storedFeed().awaiting.map((a) => a.id)).toEqual(['movie:693134']);
  });

  it('a tv grab missing its season or its episode is not tracked', async () => {
    await feed([ep(1, 1), ep(2, null, { id: 7 }), ep(null, 4, { id: 8 })]);
    expect(Object.keys(storedFeed().snap)).toEqual(['tv:403245#1x1']);
  });

  it('a pending check is not postponed by polls that only move the progress', async () => {
    await feed([mv()]);
    t0 = Date.now();
    await feed([]);
    await clock.tick(4000); // miss → next check in 12 s
    await settle();
    expect(searches.map((s) => s.at)).toEqual([4000]);
    // a download of something else keeps the poll busy (its % changes every answer)
    for (let i = 1; i <= 4; i++) {
      await feed([ep(1, 1, { progress: i / 10 })]);
      await clock.tick(i === 1 ? 0 : 4000);
    }
    await clock.tick(12000);
    await settle();
    expect(searches.map((s) => s.at)).toEqual([4000, 16000]);
  });
});

describe('what is asked of Jellyfin', () => {
  it('the title search is recursive, typed, with ProviderIds + DateCreated, at most 20', async () => {
    await feed([mv()]);
    await feed([]);
    await clock.tick(4000);
    await settle();
    const q = searches[0].q;
    expect(q.get('SearchTerm')).toBe('Dune');
    expect(q.get('Recursive')).toBe('true');
    expect(q.get('IncludeItemTypes')).toBe('Movie');
    expect(q.get('Fields')).toBe('ProviderIds,DateCreated');
    expect(q.get('Limit')).toBe('20');
  });

  it("tv: the episode list carries DateCreated and the entry time is the episode's", async () => {
    await feed([ep(1, 3)]);
    await feed([]);
    jfItems = [jfSeries()];
    const created = START - 2 * DAY;
    jfEpisodes['jf-silo'] = [jfEp(1, 3, { DateCreated: new Date(created).toISOString() })];
    await clock.tick(4000);
    await settle();
    expect(episodeCalls[0].q.get('Fields')).toBe('DateCreated');
    expect(L.landed.items[0].at).toBe(created);
  });

  it('tv: an unparseable episode DateCreated becomes now (the entry is still recorded)', async () => {
    await feed([ep(1, 3)]);
    await feed([]);
    jfItems = [jfSeries()];
    jfEpisodes['jf-silo'] = [jfEp(1, 3, { DateCreated: 'garbage' })];
    await clock.tick(4000);
    await settle();
    expect(L.landed.items).toHaveLength(1);
    expect(L.landed.items[0].at).toBe(Date.now());
  });

  it('a multi-episode file confirms the episodes it spans, its last one included — and nothing before it', async () => {
    await feed([ep(1, 3), ep(1, 4)]);
    await feed([]);
    jfItems = [jfSeries()];
    jfEpisodes['jf-silo'] = [jfEp(1, 2, { IndexNumberEnd: 3 }), jfEp(1, 5, { IndexNumberEnd: 6 })];
    await clock.tick(4000);
    await settle();
    expect(L.landed.items[0].eps).toEqual(['1x3']); // E3 is the end of E02–E03; E4 is in no file
    expect(storedFeed().awaiting.map((a) => a.id)).toEqual(['tv:403245#1x4']);
  });
});

describe('merging', () => {
  it('a later landing of the same title moves the entry time forward and keeps the poster when it brings none', async () => {
    await feed([ep(1, 1), ep(1, 2)]);
    await feed([ep(1, 2)]);
    jfItems = [jfSeries({ ImageTags: { Primary: 'tagA' } })];
    jfEpisodes['jf-silo'] = [jfEp(1, 1, { DateCreated: new Date(START - DAY).toISOString() })];
    await clock.tick(4000);
    await settle();
    const first = L.landed.items[0];
    expect(first.poster).toBeTruthy();
    await feed([]);
    jfItems = [jfSeries()]; // no image this time, no queue poster either
    jfEpisodes['jf-silo'] = [jfEp(1, 1), jfEp(1, 2, { DateCreated: new Date(START - 3600000).toISOString() })];
    await clock.tick(4000);
    await settle();
    expect(L.landed.items).toHaveLength(1);
    expect(L.landed.items[0].eps).toEqual(['1x1', '1x2']);
    expect(L.landed.items[0].at).toBe(START - 3600000); // the newer of the two
    expect(L.landed.items[0].poster).toBe(first.poster);
  });

  it('a new poster on a later landing replaces the old one', async () => {
    await feed([ep(1, 1), ep(1, 2)]);
    await feed([ep(1, 2)]);
    jfItems = [jfSeries()];
    jfEpisodes['jf-silo'] = [jfEp(1, 1)];
    await clock.tick(4000);
    await settle();
    const before = L.landed.items[0].poster;
    await feed([]);
    jfItems = [jfSeries({ ImageTags: { Primary: 'tagB' } })];
    jfEpisodes['jf-silo'] = [jfEp(1, 1), jfEp(1, 2)];
    await clock.tick(4000);
    await settle();
    expect(L.landed.items[0].poster).toBeTruthy();
    expect(L.landed.items[0].poster).not.toBe(before);
    expect(L.landed.items[0].poster).toContain('tagB');
  });

  it("a fresh entry's episodes are sorted even when they were confirmed out of order", async () => {
    await feed([ep(2, 2), ep(1, 9), ep(2, 1)]);
    await feed([]);
    jfItems = [jfSeries()];
    jfEpisodes['jf-silo'] = [jfEp(1, 9), jfEp(2, 1), jfEp(2, 2)];
    await clock.tick(4000);
    await settle();
    expect(L.landed.items[0].eps).toEqual(['1x9', '2x1', '2x2']);
  });

  it("a new landing keeps other titles' entries, seen ones included", async () => {
    await feed([mv(), ep(1, 1)]);
    await feed([ep(1, 1)]);
    jfItems = [jfMovie()];
    await clock.tick(4000);
    await settle();
    L.markLandedSeen(); // Dune: seen
    await feed([]);
    jfItems = [jfSeries()];
    jfEpisodes['jf-silo'] = [jfEp(1, 1)];
    await clock.tick(4000);
    await settle();
    expect(L.landed.items.map((e) => [e.id, e.seen])).toEqual([['jf-silo', false], ['jf-dune', true]]);
  });

  it('landedLine tells seasons 10 and 12 apart', () => {
    expect(L.landedLine({ type: 'tv', eps: ['10x1', '12x3'] })).toBe('2 new episodes');
    expect(L.landedLine({ type: 'tv', eps: ['10x1', '10x3'] })).toBe('Season 10 · 2 new episodes');
  });
});

describe('the store at module init', () => {
  it('fresh state: no entries, nothing fresh', () => {
    expect(L.landed.items).toEqual([]);
    expect(L.landed.fresh).toEqual([]);
  });

  it("a stored 'null' loads as empty and the module still works", async () => {
    await restart({ 'reel.landed': 'null', 'reel.landedFeed': 'null' });
    expect(L.landed.items).toEqual([]);
    await feed([mv()]);
    await feed([]);
    jfItems = [jfMovie()];
    await clock.tick(4000);
    await settle();
    expect(L.landed.items.map((e) => e.id)).toEqual(['jf-dune']);
  });

  it('a stored number is replaced by a proper map on the next write', async () => {
    await restart({ 'reel.landed': '5', 'reel.landedFeed': '7' });
    await feed([mv()]);
    await feed([]);
    jfItems = [jfMovie()];
    await clock.tick(4000);
    await settle();
    expect(readJSON('reel.landed').u1.map((e) => e.id)).toEqual(['jf-dune']);
    expect(storedFeed()).toMatchObject({ awaiting: [] });
  });

  it('a snapshot that is not an object is no baseline (null, a string)', async () => {
    for (const snap of [null, 'garbage']) {
      await restart({ 'reel.landedFeed': { u1: { snap, awaiting: [] } } });
      await feed([mv()]); // a baseline, not a diff against the junk
      await clock.tick(60000);
      expect(searches).toEqual([]);
      expect(storedFeed().snap).toEqual({ 'movie:693134': expect.any(Object) });
    }
  });
});

if (PHONE) {
  describe('phone: a check deferred while hidden', () => {
    it('resumes after a second trip to the background too', async () => {
      let hidden = false;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      try {
        await feed([mv()]);
        t0 = Date.now();
        await feed([]);
        hidden = true;
        await clock.tick(4000); // due while hidden: waits
        expect(searches).toEqual([]);
        hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
        await clock.tick(4000); // checks (a miss: Jellyfin has nothing yet) → next in 12 s
        await settle();
        expect(searches).toHaveLength(1);
        hidden = true;
        await clock.tick(12000); // due while hidden again
        await settle();
        expect(searches).toHaveLength(1);
        jfItems = [jfMovie()];
        hidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
        await clock.tick(12000);
        await settle();
        expect(searches).toHaveLength(2);
        expect(L.landed.items).toHaveLength(1);
      } finally {
        delete document.hidden;
      }
    });
  });
}
