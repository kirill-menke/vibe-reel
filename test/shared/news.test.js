/* news.svelte.js: the bell's new-seasons feed.
 *
 * CLAUDE.md (Tab-row bell and avatar): "Bell = new seasons … reel-api
 * `GET /api/news` … seasons with no file that either aired within the last year
 * (`aired`, with a **Get** button → `POST /api/news/search` …; 409 `not_aired`
 * for an unaired season …) or are listed but unaired (`upcoming`, with the
 * premiere date). A season already downloading shows the live activity instead
 * of Get. Polled every 10 min on the browse screens … 'Seen' is per Jellyfin
 * user in `reel.newsSeen`, by item id, and the id includes the kind, so a
 * premiere re-notifies. Opening the menu marks everything seen." The phone's
 * Undo (`DELETE /api/news/search/{token}`) is "wired only `if (__PHONE__)`".
 * Item shape and id (`<tvdbId>:<season>:<kind>`) from backend arr.py _news_item. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { freshImport, TEST_MEDIALIB } from '../helpers/modules.js';
import { mockFetch } from '../helpers/fetch.js';
import { useClock, flushPromises } from '../helpers/time.js';
import { readJSON } from '../helpers/storage.js';

const PHONE = __PHONE__;
const NEWS = TEST_MEDIALIB + '/api/news';
const SEARCH = TEST_MEDIALIB + '/api/news/search';
const MIN = 60 * 1000;
let N, A, T, net, clock;

async function load(storage = {}) {
  ({ N, A, T } = await freshImport({
    storage,
    modules: { N: 'src/lib/news.svelte.js', A: 'src/lib/activity.svelte.js', T: 'src/lib/toast.svelte.js' }
  }));
  net = mockFetch();
  clock = useClock();
}

afterEach(() => {
  N?.stopNews();
});

const item = (o = {}) => {
  const kind = o.kind || 'aired';
  const season = o.season ?? 3;
  const media_id = o.media_id || '403245';
  return { id: media_id + ':' + season + ':' + kind, kind, media_id, title: 'Silo', season, premiere: '2025-12-20T12:00:00Z', episodes_aired: 3, episodes_total: 8, ...o };
};

describe('seen, per Jellyfin user', () => {
  it('reads this user’s list at start-up, not another account’s', async () => {
    await load({ 'reel.newsSeen': JSON.stringify({ u1: ['403245:3:aired'], u2: ['9:1:aired'] }) });
    expect(N.news.seen).toEqual(['403245:3:aired']);
  });

  it.each([
    ['not JSON', '{oops'],
    ['an object for the user', JSON.stringify({ u1: { a: 1 } })],
    ['null', 'null']
  ])('a broken store (%s) starts empty', async (_, raw) => {
    await load({ 'reel.newsSeen': raw });
    expect(N.news.seen).toEqual([]);
  });

  it('unreadCount counts unseen ids; markAllSeen remembers what was fresh and saves under the user', async () => {
    await load({ 'reel.newsSeen': JSON.stringify({ u2: ['x'] }) });
    N.news.items = [item(), item({ media_id: '1', title: 'Andor', season: 2 }), item({ kind: 'upcoming', season: 4 })];
    N.news.seen = ['1:2:aired'];
    expect(N.unreadCount()).toBe(2);
    N.markAllSeen();
    expect(N.news.fresh).toEqual(['403245:3:aired', '403245:4:upcoming']);
    expect(N.unreadCount()).toBe(0);
    expect(readJSON('reel.newsSeen')).toEqual({ u1: ['1:2:aired', '403245:3:aired', '403245:4:upcoming'], u2: ['x'] });
  });

  it('markAllSeen with nothing new writes nothing', async () => {
    await load();
    N.news.items = [item()];
    N.news.seen = ['403245:3:aired'];
    N.markAllSeen();
    expect(N.news.fresh).toEqual([]);
    expect(localStorage.getItem('reel.newsSeen')).toBeNull();
  });

  it('a premiere re-notifies: the aired id is new although the upcoming one was seen', async () => {
    await load({ 'reel.newsSeen': JSON.stringify({ u1: ['403245:3:upcoming'] }) });
    N.news.items = [item({ kind: 'upcoming' })];
    expect(N.unreadCount()).toBe(0);
    N.news.items = [item({ kind: 'aired' })];
    expect(N.unreadCount()).toBe(1);
  });

  it('a corrupted saved map is replaced, not crashed on', async () => {
    await load({ 'reel.newsSeen': JSON.stringify(['legacy']) });
    N.news.items = [item()];
    N.markAllSeen();
    expect(readJSON('reel.newsSeen')).toEqual({ u1: ['403245:3:aired'] });
  });
});

describe('polling', () => {
  it('fetches at once, then every 10 minutes; a second start adds no timer', async () => {
    await load();
    net.on('GET', NEWS, { items: [item()] });
    N.startNews();
    N.startNews();
    await clock.tick(0);
    expect(net.callsTo(NEWS)).toHaveLength(1);
    expect(N.news.loaded).toBe(true);
    expect(N.news.items.map((i) => i.id)).toEqual(['403245:3:aired']);
    await clock.tick(10 * MIN);
    expect(net.callsTo(NEWS)).toHaveLength(2);
    N.stopNews();
    await clock.tick(30 * MIN);
    expect(net.callsTo(NEWS)).toHaveLength(2);
  });

  it('a restart (every screen change) only refetches when the last answer is older than 10 min', async () => {
    await load();
    net.on('GET', NEWS, { items: [] });
    N.startNews();
    await clock.tick(0);
    N.stopNews();
    await clock.tick(5 * MIN);
    N.startNews();
    await clock.tick(0);
    expect(net.callsTo(NEWS)).toHaveLength(1);
    N.stopNews();
    await clock.tick(6 * MIN);
    N.startNews();
    await clock.tick(0);
    expect(net.callsTo(NEWS)).toHaveLength(2);
  });

  it('forgets seen ids that left the feed (and saves), so the list cannot grow forever', async () => {
    await load({ 'reel.newsSeen': JSON.stringify({ u1: ['403245:3:aired', 'gone:1:aired'], u2: ['keep'] }) });
    net.on('GET', NEWS, { items: [item()] });
    N.startNews();
    await clock.tick(0);
    expect(N.news.seen).toEqual(['403245:3:aired']);
    expect(readJSON('reel.newsSeen')).toEqual({ u1: ['403245:3:aired'], u2: ['keep'] });
  });

  it('a failed poll keeps the last list; the next tick retries', async () => {
    await load();
    net.on('GET', NEWS, { items: [item()] });
    N.startNews();
    await clock.tick(0);
    net.on('GET', NEWS, net.status(503, { error: 'busy', detail: 'Sonarr down' }));
    await clock.tick(10 * MIN);
    expect(N.news.items.map((i) => i.id)).toEqual(['403245:3:aired']);
    net.on('GET', NEWS, { items: [] });
    await clock.tick(10 * MIN);
    expect(N.news.items).toEqual([]);
  });

  it('an answer without items is an empty list', async () => {
    await load();
    net.on('GET', NEWS, {});
    N.startNews();
    await clock.tick(0);
    expect(N.news.items).toEqual([]);
    expect(N.news.loaded).toBe(true);
  });
});

describe('seasonActivity: the live download state instead of Get', () => {
  beforeEach(() => load());
  const grab = (o) => ({ id: Math.random(), type: 'tv', media_id: '403245', season: 3, title: 'Silo', status: 'queued', progress: 0, ...o });

  it('null without a grab of that series + season (completed ones do not count)', () => {
    A.act.items = [grab({ season: 2, status: 'downloading' }), grab({ media_id: '1', status: 'downloading' }), grab({ status: 'completed' }), grab({ type: 'movie', status: 'downloading' })];
    expect(N.seasonActivity(item())).toBeNull();
  });

  it('downloading grabs win, their progress averaged', () => {
    A.act.items = [grab({ status: 'queued', progress: 0 }), grab({ status: 'downloading', progress: 40 }), grab({ status: 'downloading', progress: 60 })];
    expect(N.seasonActivity(item())).toEqual({ status: 'downloading', progress: 50 });
  });

  it('else the first grab’s status and progress', () => {
    A.act.items = [grab({ status: 'importing', progress: 100 }), grab({ status: 'queued' })];
    expect(N.seasonActivity(item())).toEqual({ status: 'importing', progress: 100 });
    A.act.items = [grab({ status: 'queued' })];
    expect(N.seasonActivity(item())).toEqual({ status: 'queued', progress: 0 });
  });
});

describe('Get season', () => {
  beforeEach(() => load());

  it('POSTs { id: media_id, season } and toasts; searching for 2 min, then "none"', async () => {
    net.on('POST', SEARCH, { ok: true });
    const it0 = item();
    expect(N.searchState(it0)).toBeNull();
    await N.getSeason(it0);
    expect(net.callsTo(SEARCH)[0].body).toEqual({ id: '403245', season: 3 });
    expect(T.toastState.msg).toBe('Looking for Silo season 3…');
    expect(N.searchState(it0)).toBe('searching');
    await clock.tick(2 * MIN - 5000);
    expect(N.searchState(it0)).toBe('searching');
    await clock.tick(5000);
    expect(N.searchState(it0)).toBe('none');
  });

  it('a grab showing up in the activity feed is "found", and stays found after it leaves the feed', async () => {
    net.on('POST', SEARCH, { ok: true });
    const it0 = item();
    N.news.items = [it0];
    await N.getSeason(it0);
    A.act.items = [{ id: 1, type: 'tv', media_id: '403245', season: 3, title: 'Silo', status: 'downloading', progress: 3 }];
    expect(N.searchState(it0)).toBe('found');
    await clock.tick(5000);   // the 5 s clock notes it
    A.act.items = [];
    expect(N.searchState(it0)).toBe('found');
    await clock.tick(5 * MIN);
    expect(N.searchState(it0)).toBe('found');
  });

  it('no second request while searching or found; "none" can Retry (a new 2-min window)', async () => {
    net.on('POST', SEARCH, { ok: true });
    const it0 = item();
    await N.getSeason(it0);
    await N.getSeason(it0);
    expect(net.callsTo(SEARCH)).toHaveLength(1);
    await clock.tick(2 * MIN + 1000);
    expect(N.searchState(it0)).toBe('none');
    await N.getSeason(it0);
    expect(net.callsTo(SEARCH)).toHaveLength(2);
    expect(N.searchState(it0)).toBe('searching');
  });

  it('the 5 s clock stops once no search is waiting', async () => {
    net.on('POST', SEARCH, { ok: true });
    await N.getSeason(item());
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await clock.tick(2 * MIN + 5000);
    const before = N.news.clock;
    await clock.tick(60000);
    expect(N.news.clock).toBe(before);
  });

  it.each([
    ['409 not_aired', (n) => n.status(409, { error: 'not_aired', detail: 'season 4 has not aired' }), 'Nothing has aired yet'],
    ['503', (n) => n.status(503, { error: 'busy', detail: 'x' }), 'Library busy — try again in a moment'],
    ['anything else', (n) => n.status(500, { detail: 'Sonarr refused' }), 'Couldn’t start the search: Sonarr refused']
  ])('%s: back to Get, with its wording', async (_, answer, msg) => {
    net.on('POST', SEARCH, answer(net));
    const it0 = item();
    await N.getSeason(it0);
    expect(N.searchState(it0)).toBeNull();
    expect(T.toastState.msg).toBe(msg);
  });

  it(PHONE ? 'phone: the toast offers Undo when the server hands out a token' : 'TV: no Undo in the toast', async () => {
    net.on('POST', SEARCH, { undo: 'u-1' });
    await N.getSeason(item());
    expect(typeof T.toastState.undo === 'function').toBe(PHONE);
  });

  if (PHONE) {
    it('phone: Undo DELETEs the search by its token and the row returns to Get', async () => {
      net.on('POST', SEARCH, { undo: 'undo-tok 1' });
      net.on('DELETE', SEARCH + '/undo-tok%201', { undone: true });
      const it0 = item();
      await N.getSeason(it0);
      T.toastState.undo();
      await flushPromises();
      expect(net.callsTo(SEARCH + '/undo-tok%201', 'DELETE')).toHaveLength(1);
      expect(N.searchState(it0)).toBeNull();
      expect(T.toastState.msg).toBe('Stopped — Silo season 3 won’t download');
    });
  }

  it('undoGetSeason failures: 410 is "too late", others say why', async () => {
    net.on('DELETE', SEARCH + '/t1', net.status(410, { error: 'expired', detail: 'x' }));
    await N.undoGetSeason(item(), 't1');
    expect(T.toastState.msg).toBe('Too late to undo that search');
    net.on('DELETE', SEARCH + '/t1', net.status(500, { detail: 'nope' }));
    await N.undoGetSeason(item(), 't1');
    expect(T.toastState.msg).toBe('Couldn’t undo: nope');
  });

  it('undoGetSeason of someone else’s Get (403 not_owner): the server’s sentence', async () => {
    net.on('DELETE', SEARCH + '/t1', net.status(403, { error: 'not_owner', detail: 'Only the person who asked for that season can undo it.' }));
    await N.undoGetSeason(item(), 't1');
    expect(T.toastState.msg).toBe('Only the person who asked for that season can undo it.');
  });
});

describe('newsLine', () => {
  // the fake clock starts 2026-01-01T12:00:00Z
  beforeEach(() => load());
  const DAY = 86400000;
  const iso = (ms) => new Date(Date.now() + ms).toISOString();

  it('upcoming: no date / tomorrow / in N days / a date (with the year when it is another one)', () => {
    expect(N.newsLine(item({ kind: 'upcoming', premiere: null }))).toBe('Announced · no date yet');
    expect(N.newsLine(item({ kind: 'upcoming', premiere: iso(DAY / 2) }))).toBe('Premieres tomorrow');
    expect(N.newsLine(item({ kind: 'upcoming', premiere: iso(-DAY) }))).toBe('Premieres tomorrow');
    expect(N.newsLine(item({ kind: 'upcoming', premiere: iso(1.5 * DAY) }))).toBe('Premieres in 2 days');
    expect(N.newsLine(item({ kind: 'upcoming', premiere: iso(6 * DAY) }))).toBe('Premieres in 6 days');
    expect(N.newsLine(item({ kind: 'upcoming', premiere: '2026-01-11T12:00:00Z' }))).toBe('Premieres Jan 11');
    expect(N.newsLine(item({ kind: 'upcoming', premiere: '2027-03-05T12:00:00Z' }))).toBe('Premieres Mar 5, 2027');
  });

  it('aired: since when, and how many of how many episodes', () => {
    expect(N.newsLine(item({ premiere: '2025-12-20T12:00:00Z', episodes_aired: 3, episodes_total: 8 }))).toBe('Out since Dec 20, 2025 · 3 of 8 episodes');
    expect(N.newsLine(item({ premiere: '2026-01-01T09:00:00Z', episodes_aired: 8, episodes_total: 8 }))).toBe('Out since Jan 1 · 8 episodes');
    expect(N.newsLine(item({ premiere: '2026-01-01T09:00:00Z', episodes_aired: 1, episodes_total: 1 }))).toBe('Out since Jan 1 · 1 episode');
    expect(N.newsLine(item({ premiere: '2026-01-01T09:00:00Z', episodes_aired: 1, episodes_total: 10 }))).toBe('Out since Jan 1 · 1 of 10 episodes');
  });
});
