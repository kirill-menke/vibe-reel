/* activity.svelte.js: grouping the /api/activity feed per title, matching it to
 * Jellyfin items, and the status words / bars the tiles and rows show.
 *
 * CLAUDE.md (Download activity): items are grouped per title and merged in
 * place; matching is by tvdb/tmdb id with case-insensitive title as fallback;
 * against an older backend the structured fields are absent and the module
 * falls back to parsing `subtitle`. The module comments add: status is the
 * most-active status of any grab, progress is size-weighted (plain mean without
 * sizes), res is the best resolution in flight, and speed/size/progress/ETA
 * are per *torrent* (a season pack listed once per episode counts once).
 *
 * act is module state, so each test imports a fresh graph. Items assigned to
 * act.items directly skip norm() (as poll() would apply it); the older-backend
 * tests go through one real poll. */
import { describe, it, expect, beforeEach } from 'vitest';
import { freshImport } from '../helpers/modules.js';
import { mockFetch } from '../helpers/fetch.js';

let A;

beforeEach(async () => {
  const m = await freshImport({ modules: { activity: 'src/lib/activity.svelte.js' } });
  A = m.activity;
});

let nid = 0;
function tv(o = {}) {
  nid++;
  return { id: nid, type: 'tv', title: 'Silo', status: 'queued', progress: 0, media_id: '403245', season: 1, episode: nid, ...o };
}
function mv(o = {}) {
  nid++;
  return { id: nid, type: 'movie', title: 'Dune', status: 'queued', progress: 0, media_id: '693134', year: 2024, ...o };
}
function setItems(items) {
  A.act.items = items;
}

/* one real poll of /api/activity, so norm() runs on the items */
async function pollOnce(items) {
  const net = mockFetch();
  net.on('GET', '/api/activity', { items });
  A.startActivity();
  A.stopActivity();
  for (let i = 0; i < 10 && !A.act.loaded; i++) await new Promise((r) => setTimeout(r, 0));
  expect(A.act.loaded).toBe(true);
  return net;
}

describe('pendingGroups: one group per title', () => {
  it('groups by type + media_id, episodes sorted by season/episode', () => {
    setItems([
      tv({ season: 2, episode: 1 }),
      tv({ season: 1, episode: 3 }),
      mv(),
      tv({ season: 1, episode: 2 }),
      tv({ title: 'Severance', media_id: '371980', season: 1, episode: 1 })
    ]);
    const g = A.pendingGroups('tv');
    expect(g.map((x) => x.key)).toEqual(['tv:371980', 'tv:403245']);
    const silo = g.find((x) => x.title === 'Silo');
    expect(silo.items.map((i) => [i.season, i.episode])).toEqual([[1, 2], [1, 3], [2, 1]]);
    expect(silo.mediaId).toBe('403245');
    expect(silo.type).toBe('tv');
    expect(A.pendingGroups('movie').map((x) => x.key)).toEqual(['movie:693134']);
  });

  it('without a media_id the key is the lower-cased title; such groups have mediaId null', () => {
    setItems([tv({ media_id: null, title: 'The Bear' }), tv({ media_id: undefined, title: 'the bear' })]);
    const g = A.pendingGroups('tv');
    expect(g).toHaveLength(1);
    expect(g[0].key).toBe('tv:t:the bear');
    expect(g[0].mediaId).toBe(null);
    expect(g[0].title).toBe('The Bear');
    expect(g[0].items).toHaveLength(2);
  });

  it('a movie and a show with the same media_id are different groups', () => {
    setItems([tv({ media_id: '1' }), mv({ media_id: '1' })]);
    expect(A.pendingGroups('tv')[0].key).toBe('tv:1');
    expect(A.pendingGroups('movie')[0].key).toBe('movie:1');
  });

  it("only active statuses — 'completed' (imported) and unknown words are left out", () => {
    setItems([mv({ status: 'completed' }), mv({ status: 'failed', media_id: '2' }), mv({ status: 'paused', media_id: '3' })]);
    expect(A.pendingGroups('movie').map((g) => g.mediaId)).toEqual(['3']);
  });

  it('group status is the most active one: downloading < importing < queued < warning < paused', () => {
    const order = ['paused', 'warning', 'queued', 'importing', 'downloading'];
    for (let n = 1; n <= order.length; n++) {
      setItems(order.slice(0, n).map((status) => tv({ status })));
      expect(A.pendingGroups('tv')[0].status).toBe(order[n - 1]);
    }
    setItems([tv({ status: 'warning' }), tv({ status: 'paused' })]);
    expect(A.pendingGroups('tv')[0].status).toBe('warning');
  });

  it('groups are sorted by status rank, then title', () => {
    setItems([
      mv({ media_id: 'a', title: 'Zodiac', status: 'queued' }),
      mv({ media_id: 'b', title: 'Alien', status: 'paused' }),
      mv({ media_id: 'c', title: 'Heat', status: 'downloading' }),
      mv({ media_id: 'd', title: 'Brazil', status: 'queued' }),
      mv({ media_id: 'e', title: 'Arrival', status: 'importing' }),
      mv({ media_id: 'f', title: 'Up', status: 'warning' })
    ]);
    expect(A.pendingGroups('movie').map((g) => g.title)).toEqual(['Heat', 'Arrival', 'Brazil', 'Zodiac', 'Up', 'Alien']);
  });

  it('poster and year: the first item that has one', () => {
    setItems([tv({ poster: null, year: null }), tv({ poster: 'https://p/1.jpg', year: 2023 }), tv({ poster: 'https://p/2.jpg', year: 2024 })]);
    const g = A.pendingGroups('tv')[0];
    expect(g.poster).toBe('https://p/1.jpg');
    expect(g.year).toBe(2023);
    setItems([tv({})]);
    expect(A.pendingGroups('tv')[0].poster).toBe(null);
    expect(A.pendingGroups('tv')[0].year).toBe(null);
  });

  it('res is the best resolution in flight', () => {
    setItems([tv({ quality: 'HDTV-720p' }), tv({ quality: 'WEBDL-2160p' }), tv({ quality: 'Bluray-1080p' })]);
    expect(A.pendingGroups('tv')[0].res).toBe('4K');
    setItems([tv({ quality: 'HDTV-720p' }), tv({ quality: null })]);
    expect(A.pendingGroups('tv')[0].res).toBe('720p');
    setItems([tv({ quality: 'Unknown' })]);
    expect(A.pendingGroups('tv')[0].res).toBe('');
    setItems([tv({ quality: 'Remux UHD' }), tv({ quality: 'Bluray-1080p' })]);
    expect(A.pendingGroups('tv')[0].res).toBe('4K');
  });

  it('progress is size-weighted across grabs; a plain mean without sizes', () => {
    setItems([tv({ download_id: 'a', progress: 1, size_bytes: 1000 }), tv({ download_id: 'b', progress: 0, size_bytes: 3000 })]);
    expect(A.pendingGroups('tv')[0].progress).toBeCloseTo(0.25);
    expect(A.pendingGroups('tv')[0].size).toBe(4000);
    setItems([tv({ download_id: 'a', progress: 1 }), tv({ download_id: 'b', progress: 0 })]);
    expect(A.pendingGroups('tv')[0].progress).toBeCloseTo(0.5);
    expect(A.pendingGroups('tv')[0].size).toBe(0);
    // items without progress count as 0
    setItems([tv({ download_id: 'a', progress: undefined }), tv({ download_id: 'b', progress: 0.8 })]);
    expect(A.pendingGroups('tv')[0].progress).toBeCloseTo(0.4);
  });

  it('a season pack (one torrent listed per episode) counts its speed, size and progress once', () => {
    const pack = { download_id: 'HASH1', progress: 0.5, size_bytes: 20e9, download_speed: 5e6, timeleft: '00:40:00' };
    setItems(Array.from({ length: 20 }, (_, i) => tv({ ...pack, episode: i + 1 })));
    const g = A.pendingGroups('tv')[0];
    expect(g.items).toHaveLength(20);
    expect(g.speed).toBe(5e6);
    expect(g.size).toBe(20e9);
    expect(g.progress).toBeCloseTo(0.5);
    expect(g.timeleft).toBe('00:40:00');
  });

  it('items without a download_id are separate grabs (keyed by item id)', () => {
    setItems([tv({ download_speed: 1e6 }), tv({ download_speed: 2e6 })]);
    expect(A.pendingGroups('tv')[0].speed).toBe(3e6);
  });

  it('the title is done when the slowest grab is: timeleft is the longest ETA, as given', () => {
    setItems([
      tv({ download_id: 'a', timeleft: '1:15:38' }),
      tv({ download_id: 'b', timeleft: '1.02:03:04' }),
      tv({ download_id: 'c', timeleft: '15:38' }),
      tv({ download_id: 'd', timeleft: null })
    ]);
    expect(A.pendingGroups('tv')[0].timeleft).toBe('1.02:03:04');
    // 2 days beat 23 hours: the day count is parsed, not just the clock part
    setItems([tv({ download_id: 'a', timeleft: '23:59:59' }), tv({ download_id: 'b', timeleft: '2.00:00:01' })]);
    expect(A.pendingGroups('tv')[0].timeleft).toBe('2.00:00:01');
    setItems([tv({ download_id: 'a', timeleft: '59:00' }), tv({ download_id: 'b', timeleft: '1:00:00' })]);
    expect(A.pendingGroups('tv')[0].timeleft).toBe('1:00:00');
    setItems([tv({ timeleft: null })]);
    expect(A.pendingGroups('tv')[0].timeleft).toBe(null);
  });

  it('is memoised per act.items array (the same array → the same result object)', () => {
    setItems([tv()]);
    const a = A.pendingGroups('tv');
    expect(A.pendingGroups('tv')).toBe(a);
    const m = A.pendingGroups('movie');
    expect(A.pendingGroups('movie')).toBe(m);
    setItems([tv()]);
    expect(A.pendingGroups('tv')).not.toBe(a);
  });

  it('groupByKey finds a group by its key (type from the prefix); unknown or empty → null', () => {
    setItems([tv(), mv()]);
    expect(A.groupByKey('tv:403245').title).toBe('Silo');
    expect(A.groupByKey('movie:693134').title).toBe('Dune');
    expect(A.groupByKey('tv:nope')).toBe(null);
    expect(A.groupByKey('')).toBe(null);
    expect(A.groupByKey(null)).toBe(null);
  });
});

describe('older backend: parse subtitle when the structured fields are missing', () => {
  it("tv: 'S01E02 · Title' → season, episode, episode_title", async () => {
    await pollOnce([
      { id: 1, type: 'tv', title: 'Silo', status: 'queued', subtitle: 'S01E02 · Holston' },
      { id: 2, type: 'tv', title: 'Silo', status: 'queued', subtitle: 'S10 E7' },
      { id: 3, type: 'tv', title: 'Silo', status: 'queued', subtitle: 'Season pack' }
    ]);
    const [a, b, c] = A.act.items;
    expect([a.season, a.episode, a.episode_title]).toEqual([1, 2, 'Holston']);
    expect([b.season, b.episode, b.episode_title]).toEqual([10, 7, undefined]);
    expect([c.season, c.episode]).toEqual([undefined, undefined]);
    // without media_id the title groups them
    expect(A.pendingGroups('tv')).toHaveLength(1);
    expect(A.pendingGroups('tv')[0].items.map((i) => i.id)).toEqual([3, 1, 2]);
  });

  it('structured fields win over the subtitle; an existing episode_title is kept', async () => {
    await pollOnce([
      { id: 1, type: 'tv', title: 'X', status: 'queued', season: 3, episode: 4, episode_title: 'Real', subtitle: 'S01E01 · Other' },
      { id: 2, type: 'tv', title: 'X', status: 'queued', season: 3, subtitle: 'S05E06 · Parsed' },
      { id: 3, type: 'tv', title: 'X', status: 'queued', episode_title: 'Kept', subtitle: 'S01E09 · Other' }
    ]);
    const [a, b, c] = A.act.items;
    expect([a.season, a.episode, a.episode_title]).toEqual([3, 4, 'Real']);
    // one of the two missing → both re-parsed from the subtitle
    expect([b.season, b.episode, b.episode_title]).toEqual([5, 6, 'Parsed']);
    expect([c.season, c.episode, c.episode_title]).toEqual([1, 9, 'Kept']);
  });

  it('movie: a four-digit subtitle is the year; anything else is not', async () => {
    await pollOnce([
      { id: 1, type: 'movie', title: 'Dune', status: 'queued', subtitle: '2021' },
      { id: 2, type: 'movie', title: 'Alien', status: 'queued', subtitle: 'Director’s Cut' },
      { id: 3, type: 'movie', title: 'Heat', status: 'queued', subtitle: '1999', year: 1995 }
    ]);
    expect(A.act.items.map((i) => i.year)).toEqual([2021, undefined, 1995]);
  });

  it('does not mutate the raw answer objects', async () => {
    const raw = { id: 1, type: 'tv', title: 'X', status: 'queued', subtitle: 'S01E02 · Y' };
    const net = await pollOnce([raw]);
    expect(A.act.items[0]).not.toBe(raw);
    expect(net.calls).toHaveLength(1);
  });
});

describe('providerId', () => {
  it('matches mixed-case keys and returns a string', () => {
    expect(A.providerId({ ProviderIds: { Tvdb: 81189 } }, 'tvdb')).toBe('81189');
    expect(A.providerId({ ProviderIds: { tmdb: '1' } }, 'tmdb')).toBe('1');
    expect(A.providerId({ ProviderIds: { TMDB: '2' } }, 'tmdb')).toBe('2');
    expect(A.providerId({ ProviderIds: { Imdb: 'tt1' } }, 'tvdb')).toBe(null);
    expect(A.providerId({}, 'tvdb')).toBe(null);
  });
});

describe('matchGroup', () => {
  function groups(items) {
    setItems(items);
    return [...A.pendingGroups('tv'), ...A.pendingGroups('movie')];
  }

  it('Series match by tvdb, movies by tmdb', () => {
    const gs = groups([tv({ media_id: '403245' }), mv({ media_id: '693134' })]);
    expect(A.matchGroup(gs, { Type: 'Series', Name: 'whatever', ProviderIds: { Tvdb: '403245' } }).key).toBe('tv:403245');
    expect(A.matchGroup(gs, { Type: 'Movie', Name: 'whatever', ProviderIds: { Tmdb: '693134' } }).key).toBe('movie:693134');
    // a movie's tvdb id is not used
    expect(A.matchGroup(gs, { Type: 'Movie', Name: 'x', ProviderIds: { Tvdb: '693134' } })).toBe(null);
  });

  it('a provider-id mismatch is a different title even with the same name', () => {
    const gs = groups([tv({ title: 'The Office', media_id: '73244' })]);
    expect(A.matchGroup(gs, { Type: 'Series', Name: 'The Office', ProviderIds: { Tvdb: '78107' } })).toBe(null);
  });

  it('falls back to a case-insensitive title when either side lacks an id', () => {
    let gs = groups([tv({ title: 'The Office', media_id: null })]);
    expect(A.matchGroup(gs, { Type: 'Series', Name: 'the office', ProviderIds: { Tvdb: '78107' } }).title).toBe('The Office');
    gs = groups([tv({ title: 'The Office', media_id: '73244' })]);
    expect(A.matchGroup(gs, { Type: 'Series', Name: 'THE OFFICE' }).title).toBe('The Office');
    expect(A.matchGroup(gs, { Type: 'Series', Name: 'The Office (US)' })).toBe(null);
    expect(A.matchGroup(gs, { Type: 'Series' })).toBe(null);
  });

  it('only groups of the item type are considered', () => {
    const gs = groups([mv({ title: 'Fargo', media_id: null }), tv({ title: 'Fargo', media_id: null })]);
    expect(A.matchGroup(gs, { Type: 'Series', Name: 'Fargo' }).type).toBe('tv');
    expect(A.matchGroup(gs, { Type: 'Movie', Name: 'Fargo' }).type).toBe('movie');
  });

  it('an id mismatch on one group does not stop a later id match', () => {
    const gs = groups([tv({ title: 'Silo', media_id: '1' }), tv({ title: 'Silo', media_id: '2', status: 'paused' })]);
    expect(A.matchGroup(gs, { Type: 'Series', Name: 'Silo', ProviderIds: { tvdb: '2' } }).mediaId).toBe('2');
  });
});

/* Library's `fresh`: the groups that lead the grid as PendingTiles are the ones
 * no loaded library item claims — by matchGroup()'s rule, seen from the group. */
describe('unclaimedGroups (F-008)', () => {
  function groups(items) {
    setItems(items);
    return [...A.pendingGroups('tv'), ...A.pendingGroups('movie')];
  }
  const keys = (gs) => gs.map((g) => g.key);

  it('a same-named title with a different id is unclaimed (a remake, not the library tile)', () => {
    const gs = groups([mv({ title: 'Dune', media_id: '399999' })]);
    const lib = [{ Type: 'Movie', Name: 'Dune', ProviderIds: { Tmdb: '438631' } }];
    expect(keys(A.unclaimedGroups(gs, lib))).toEqual(['movie:399999']);
    // …and matchGroup agrees: the library tile does not wear it
    expect(A.matchGroup(gs, lib[0])).toBe(null);
  });

  it('an id match claims the group, whatever the names', () => {
    const gs = groups([tv({ title: 'Northern Line (UK)', media_id: '7' })]);
    expect(A.unclaimedGroups(gs, [{ Type: 'Series', Name: 'Northern Line', ProviderIds: { Tvdb: '7' } }])).toEqual([]);
  });

  it('the name decides only when ids cannot: a group without an id, or an item without the provider id', () => {
    let gs = groups([tv({ title: 'Silo', media_id: null })]);
    expect(A.unclaimedGroups(gs, [{ Type: 'Series', Name: 'SILO', ProviderIds: { Tvdb: '1' } }])).toEqual([]);
    gs = groups([tv({ title: 'Silo', media_id: '2' })]);
    expect(A.unclaimedGroups(gs, [{ Type: 'Series', Name: 'silo' }])).toEqual([]);
    expect(A.unclaimedGroups(gs, [{ Type: 'Series', Name: 'silo', ProviderIds: { Tmdb: '2' } }])).toEqual([]);
    expect(keys(A.unclaimedGroups(gs, [{ Type: 'Series', Name: 'Silo (2023)' }]))).toEqual(['tv:2']);
  });

  it('agrees with matchGroup on every group/item pair', () => {
    const gs = groups([
      tv({ title: 'Silo', media_id: '1' }), tv({ title: 'Silo', media_id: null }), tv({ title: 'Fargo', media_id: '3' }),
      mv({ title: 'Dune', media_id: '10' }), mv({ title: 'Alien', media_id: null })
    ]);
    const lib = [
      { Type: 'Series', Name: 'Silo', ProviderIds: { Tvdb: '9' } }, { Type: 'Series', Name: 'fargo' },
      { Type: 'Movie', Name: 'Dune', ProviderIds: { Tmdb: '10' } }, { Type: 'Movie', Name: 'alien', ProviderIds: { Tmdb: '5' } },
      { Type: 'Movie', Name: 'Silo' }
    ];
    const claimed = (g) => lib.some((it) => A.matchGroup([g], it) === g);
    expect(keys(A.unclaimedGroups(gs, lib))).toEqual(keys(gs.filter((g) => !claimed(g))));
    expect(keys(A.unclaimedGroups(gs, lib))).toEqual(['tv:1']);
  });

  it('an item without the provider id claims only the group matchGroup gives it, not every same-named one (R-3)', () => {
    // two different 'Dune' films downloading, the library's Dune has no Tmdb id
    const gs = groups([mv({ title: 'Dune', media_id: '10' }), mv({ title: 'Dune', media_id: '20' })]);
    const lib = [{ Type: 'Movie', Name: 'Dune' }];
    const first = A.matchGroup(gs, lib[0]);
    expect(first.mediaId).toBe('10');
    expect(keys(A.unclaimedGroups(gs, lib))).toEqual(keys(gs.filter((g) => g !== first)));
    expect(keys(A.unclaimedGroups(gs, lib))).toEqual(['movie:20']);
    // a second bare Dune tile wears the same badge, so it claims nothing more
    expect(keys(A.unclaimedGroups(gs, [...lib, { Type: 'Movie', Name: 'dune' }]))).toEqual(['movie:20']);
  });

  it('agrees with matchGroup(groups, item) — the group each tile wears — on a mixed library (R-3)', () => {
    const gs = groups([
      tv({ title: 'Silo', media_id: '1' }), tv({ title: 'Silo', media_id: '2' }), tv({ title: 'Fargo', media_id: null }),
      mv({ title: 'Dune', media_id: '10' }), mv({ title: 'Dune', media_id: '20' }), mv({ title: 'Alien', media_id: '30' })
    ]);
    const lib = [
      { Type: 'Series', Name: 'silo' }, { Type: 'Series', Name: 'Fargo', ProviderIds: { Tvdb: '8' } },
      { Type: 'Movie', Name: 'Dune', ProviderIds: { Tmdb: '20' } }, { Type: 'Movie', Name: 'Dune' }, { Type: 'Movie', Name: 'Alien', ProviderIds: { Tmdb: '31' } }
    ];
    const worn = new Set(lib.map((it) => A.matchGroup(gs, it)));
    expect(keys(A.unclaimedGroups(gs, lib))).toEqual(keys(gs.filter((g) => !worn.has(g))));
    expect(keys(A.unclaimedGroups(gs, lib))).toEqual(['tv:2', 'movie:30']);
  });

  it('an item without a Name claims nothing by name (only by id), like matchGroup', () => {
    const gs = groups([tv({ title: 'Silo', media_id: null }), mv({ title: 'Dune', media_id: '10' })]);
    const lib = [{ Type: 'Series' }, { Type: 'Movie', ProviderIds: { Tmdb: '10' } }];
    const silo = gs.find((g) => g.title === 'Silo'), dune = gs.find((g) => g.title === 'Dune');
    expect(A.unclaimedGroups(gs, lib)).toEqual([silo]);
    expect(A.matchGroup(gs, lib[0])).toBe(null);
    expect(A.matchGroup(gs, lib[1])).toBe(dune);
  });
});

describe('tile status, ring, bar, tail, stat label', () => {
  it('tileStatus spells out the state', () => {
    expect(A.tileStatus({ status: 'downloading', progress: 0.434 })).toBe('Downloading 43%');
    expect(A.tileStatus({ status: 'downloading' })).toBe('Downloading 0%');
    expect(A.tileStatus({ status: 'queued' })).toBe('Queued');
    expect(A.tileStatus({ status: 'importing' })).toBe('Importing');
    expect(A.tileStatus({ status: 'paused' })).toBe('Paused');
    expect(A.tileStatus({ status: 'warning' })).toBe('Problem');
    expect(A.tileStatus({ status: 'warning', message: 'No files found' })).toBe('Problem: No files found');
    expect(A.tileStatus({ status: 'warning', items: [{}, { message: 'Stalled' }, { message: 'later' }] })).toBe('Problem: Stalled');
    expect(A.tileStatus({ status: 'odd' })).toBe('odd');
    expect(A.tileStatus({})).toBe('');
  });

  it('stale feed: every label says unavailable, ring is stale, bar is empty', () => {
    A.act.stale = true;
    const x = { status: 'downloading', progress: 0.5, download_speed: 1e6, speed: 1e6, timeleft: '1:00' };
    expect(A.tileStatus(x)).toBe('Status unavailable');
    expect(A.ringClass(x)).toBe('stale');
    expect(A.dlBar(x)).toEqual({ active: false, fill: 0 });
    expect(A.dlTail(x)).toBe('Status unavailable');
    expect(A.statLabel(x)).toBe('Download status unavailable');
    A.act.stale = false;
    expect(A.ringClass(x)).toBe('downloading');
    expect(A.ringClass({ status: 'queued' })).toBe('queued');
  });

  it('humanBytes: 1024-based, one decimal below 10', () => {
    expect(A.humanBytes(0)).toBe('');
    expect(A.humanBytes(null)).toBe('');
    expect(A.humanBytes(512)).toBe('512 B');
    expect(A.humanBytes(1023)).toBe('1023 B');
    expect(A.humanBytes(1024)).toBe('1.0 KB');
    expect(A.humanBytes(7.4 * 1024 * 1024)).toBe('7.4 MB');
    expect(A.humanBytes(12.6 * 1024 * 1024)).toBe('13 MB');
    expect(A.humanBytes(3 * 1024 ** 3)).toBe('3.0 GB');
    expect(A.humanBytes(2 * 1024 ** 4)).toBe('2.0 TB');
    expect(A.humanBytes(5000 * 1024 ** 4)).toBe('5000 TB');
  });

  it('dlBar: downloading fills by %, importing full, anything else an empty grey track', () => {
    expect(A.dlBar({ status: 'downloading', progress: 0.256 })).toEqual({ active: true, fill: 26 });
    expect(A.dlBar({ status: 'downloading' })).toEqual({ active: true, fill: 0 });
    expect(A.dlBar({ status: 'importing', progress: 0.3 })).toEqual({ active: true, fill: 100 });
    expect(A.dlBar({ status: 'queued' })).toEqual({ active: false, fill: 0 });
    expect(A.dlBar({ status: 'paused', progress: 0.7 })).toEqual({ active: false, fill: 0 });
  });

  it('dlTail: speed (or % without one) + ETA while downloading; the status word otherwise', () => {
    expect(A.dlTail({ status: 'downloading', progress: 0.43, download_speed: 7.4 * 1024 * 1024, timeleft: '1:11:24' })).toBe('7.4 MB/s · 1:11:24 left');
    expect(A.dlTail({ status: 'downloading', progress: 0.43 })).toBe('43%');
    expect(A.dlTail({ status: 'downloading', progress: 0.43, timeleft: '5:00' })).toBe('43% · 5:00 left');
    expect(A.dlTail({ status: 'queued' })).toBe('Queued');
    expect(A.dlTail({ status: 'warning' })).toBe('Problem');
    expect(A.dlTail({ status: 'weird' })).toBe('weird');
  });

  it("statLabel: '43% · 7.4 MB/s · 1:11:24 left' while downloading", () => {
    expect(A.statLabel({ status: 'downloading', progress: 0.43, speed: 7.4 * 1024 * 1024, timeleft: '1:11:24' })).toBe('43% · 7.4 MB/s · 1:11:24 left');
    expect(A.statLabel({ status: 'downloading', progress: 0.43 })).toBe('43%');
    expect(A.statLabel({ status: 'downloading' })).toBe('0%');
    expect(A.statLabel({ status: 'importing' })).toBe('Importing');
    expect(A.statLabel({ status: 'unknown' })).toBe('unknown');
  });

  it('qualityRes: the short resolution word of a release quality', () => {
    expect(A.qualityRes('WEBDL-2160p')).toBe('4K');
    expect(A.qualityRes('Bluray-1080p')).toBe('1080p');
    expect(A.qualityRes('HDTV-720p')).toBe('720p');
    expect(A.qualityRes('DVD-480p')).toBe('480p');
    expect(A.qualityRes('Bluray-1800p')).toBe('4K');
    expect(A.qualityRes('Remux-2160P')).toBe('4K');
    expect(A.qualityRes('WEB 4K')).toBe('4K');
    expect(A.qualityRes('UHD Bluray')).toBe('4K');
    expect(A.qualityRes('Unknown')).toBe('');
    expect(A.qualityRes('')).toBe('');
    expect(A.qualityRes(null)).toBe('');
    expect(A.qualityRes('1080i')).toBe('');
  });

  it('STATUS_LABEL covers every active status', () => {
    expect(A.STATUS_LABEL).toEqual({ queued: 'Queued', downloading: 'Downloading', importing: 'Importing', paused: 'Paused', warning: 'Problem' });
  });
});
