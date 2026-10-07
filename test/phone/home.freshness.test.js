/* Home.svelte and Library.svelte as freshness / snapshot subscribers, mounted.
 *
 * CLAUDE.md: "onLibraryChange tells Home/Library what moved; they revalidate only
 * those rails/grids … A position-only change (someone watching on the TV)
 * refreshes Continue Watching, not the poster grids." And the Home snapshot:
 * "its four Jellyfin rail answers … go to localStorage['reel.homeSnap.<userId>']
 * after every live load; at the next start Home … paints before its first frame
 * … A snapshot item has no MediaSources — a Continue Watching / Next Up / hero
 * start waits for the live item (playLive())."
 *
 * The screens are mounted with svelte's mount() into happy-dom against a fake
 * Jellyfin (mockFetch); the freshness markers are the same fake library as in
 * freshness.test.js, driven by the fake clock. */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { freshImport } from '../helpers/modules.js';
import { mockFetch } from '../helpers/fetch.js';
import { useClock } from '../helpers/time.js';
import { readJSON } from '../helpers/storage.js';
import { movie, episode, series } from '../helpers/media.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SEC = 1000;

let added = [];
const origAdd = new Map();
function captureListeners(...targets) {
  for (const t of targets) {
    if (origAdd.has(t)) continue;
    const orig = t.addEventListener;
    origAdd.set(t, orig);
    t.addEventListener = function (type, fn, o) {
      added.push([t, type, fn, o]);
      return orig.call(this, type, fn, o);
    };
  }
}

let comp = null;
afterEach(() => {
  try {
    if (comp) m.svelte.unmount(comp);
  } catch {}
  comp = null;
  for (const [t, type, fn, o] of added) t.removeEventListener(type, fn, o);
  added = [];
  for (const [t, orig] of origAdd) t.addEventListener = orig;
  origAdd.clear();
  document.body.innerHTML = '';
  delete globalThis.IntersectionObserver;
});

/* ------------------------------------------------------------ fake server ---- */

let clock, net, m, srv;
const kindOf = (req) => new URLSearchParams(req.query).get('IncludeItemTypes');
const isMarker = (req) => req.path === '/Items' && new URLSearchParams(req.query).get('Limit') === '1' && new URLSearchParams(req.query).get('EnableImages') === 'false';

function library() {
  return {
    movie: { total: 10, top: 'm10' },
    tv: { total: 50, top: 'e50' },
    played: { Id: 'e7', Type: 'Episode', UserData: { Played: false, PlayCount: 0, PlaybackPositionTicks: 100, LastPlayedDate: '2026-01-01T10:00:00Z' } }
  };
}

function routes() {
  net.on('GET', isMarker, (req) => {
    const k = kindOf(req);
    if (k === 'Movie,Episode') return { Items: [structuredClone(srv.played)], TotalRecordCount: 99 };
    const s = k === 'Movie' ? srv.movie : srv.tv;
    return { Items: [{ Id: s.top }], TotalRecordCount: s.total };
  });
  net.on('GET', '/UserItems/Resume', () => ({ Items: srv.resume, TotalRecordCount: srv.resume.length }));
  net.on('GET', '/Shows/NextUp', () => ({ Items: srv.nextup, TotalRecordCount: srv.nextup.length }));
  net.on('GET', '/Items/Latest', (req) => (kindOf(req) === 'Movie' ? srv.latestMovies : srv.latestShows));
  net.on('GET', /\/api\/trending\?type=/, []);
  net.on('GET', '/Genres', { Items: [] });
  // the hero resolves its pick to a full item
  net.on('GET', (req) => /^\/Items\/[^/]+$/.test(req.path) && req.path !== '/Items/Latest', (req) => {
    const id = req.path.split('/')[2];
    return [...srv.resume, ...srv.nextup, ...srv.latestMovies, ...srv.latestShows].find((i) => i.Id === id) || net.status(404);
  });
  net.on('GET', (req) => req.path === '/Items' && !isMarker(req), (req) => ({ Items: kindOf(req) === 'Movie' ? srv.latestMovies : srv.latestShows, TotalRecordCount: 2 }));
}

async function setup({ storage = {}, hang = false } = {}) {
  clock = useClock();
  captureListeners(window, document);
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  m = await freshImport({
    storage,
    modules: {
      svelte: 'node_modules/svelte/src/index-client.js',
      Home: 'phone/src/screens/Home.svelte',
      Library: 'phone/src/screens/Library.svelte',
      router: 'phone/src/lib/router.svelte.js',
      fr: 'phone/src/lib/freshness.svelte.js',
      snap: 'phone/src/lib/homesnap.svelte.js'
    }
  });
  srv = {
    ...library(),
    resume: [movie({ Id: 'cw1', Name: 'Live Resume One', UserData: { PlaybackPositionTicks: 6e9, PlayedPercentage: 20, Played: false } })],
    nextup: [episode({ Id: 'nu1', Name: 'Live Next One', SeriesId: 'sx' })],
    latestMovies: [movie({ Id: 'lm1', Name: 'Latest Movie One' })],
    latestShows: [series({ Id: 'ls1', Name: 'Latest Show One' })]
  };
  net = mockFetch();
  if (!hang) routes();
  m.router.markBooted();
}

async function mountScreen(name, props) {
  const target = document.createElement('div');
  document.body.append(target);
  comp = m.svelte.mount(m[name].default, { target, props });
  m.svelte.flushSync();
  return target;
}

const reqs = (p) => net.calls.filter((c) => !isMarker(c) && c.path === p);
const latest = (k) => reqs('/Items/Latest').filter((c) => kindOf(c) === k);
const gridReqs = () => net.calls.filter((c) => c.path === '/Items' && !isMarker(c));
const markerRounds = () => net.calls.filter((c) => isMarker(c) && kindOf(c) === 'Movie').length;

/** Mount, let the live load and the freshness baseline land; returns the request counts after. */
async function loaded(name, props) {
  const target = await mountScreen(name, props);
  await clock.tick(2 * SEC); // live load + first marker round (300 ms)
  expect(markerRounds()).toBe(1);
  return target;
}
const counts = () => ({
  resume: reqs('/UserItems/Resume').length,
  nextup: reqs('/Shows/NextUp').length,
  movies: latest('Movie').length,
  shows: latest('Series').length,
  grid: gridReqs().length,
  genres: reqs('/Genres').length
});
const delta = (a, b) => Object.fromEntries(Object.keys(a).map((k) => [k, b[k] - a[k]]));
const ZERO = { resume: 0, nextup: 0, movies: 0, shows: 0, grid: 0, genres: 0 };

/* ---------------------------------------------------------- Home: changes ---- */

describe('Home revalidates only the rails a change touches', () => {
  it('position only (someone watching on the TV) → Continue Watching only', async () => {
    await setup();
    await loaded('Home', { active: true });
    const c0 = counts();
    srv.played.UserData.PlaybackPositionTicks = 9e9;
    await clock.tick(90 * SEC);
    expect(delta(c0, counts())).toEqual({ ...ZERO, resume: 1 });
  });

  it('a movie added → the Latest Movies rail only', async () => {
    await setup();
    await loaded('Home', { active: true });
    const c0 = counts();
    srv.movie.total = 11;
    await clock.tick(90 * SEC);
    expect(delta(c0, counts())).toEqual({ ...ZERO, movies: 1 });
  });

  it('an episode added → Latest Shows and Next Up', async () => {
    await setup();
    await loaded('Home', { active: true });
    const c0 = counts();
    srv.tv.total = 51;
    await clock.tick(90 * SEC);
    expect(delta(c0, counts())).toEqual({ ...ZERO, shows: 1, nextup: 1 });
  });

  it('an episode watched elsewhere → Continue Watching, Next Up and Latest Shows (watched ticks)', async () => {
    await setup();
    await loaded('Home', { active: true });
    const c0 = counts();
    srv.played.UserData.Played = true;
    await clock.tick(90 * SEC);
    expect(delta(c0, counts())).toEqual({ ...ZERO, resume: 1, nextup: 1, shows: 1 });
  });

  it('a movie watched elsewhere → Continue Watching, Next Up and Latest Movies', async () => {
    await setup();
    await loaded('Home', { active: true });
    const c0 = counts();
    srv.played = { Id: 'm3', Type: 'Movie', UserData: { Played: true } };
    await clock.tick(90 * SEC);
    expect(delta(c0, counts())).toEqual({ ...ZERO, resume: 1, nextup: 1, movies: 1 });
  });
});

/* ------------------------------------------------------- Library: changes ---- */

describe('a poster grid shows watched ticks, not positions', () => {
  it('Movies: position only → no reload; a movie watched → the grid reloads; an episode watched → not', async () => {
    await setup();
    await loaded('Library', { params: { type: 'movies' }, active: true });
    let c0 = counts();
    srv.played.UserData.PlaybackPositionTicks = 9e9;
    await clock.tick(90 * SEC);
    expect(delta(c0, counts())).toEqual(ZERO);

    c0 = counts();
    srv.played.UserData.Played = true; // an Episode
    await clock.tick(90 * SEC);
    expect(delta(c0, counts())).toEqual(ZERO);

    c0 = counts();
    srv.played = { Id: 'm3', Type: 'Movie', UserData: { Played: true } };
    await clock.tick(90 * SEC);
    expect(delta(c0, counts())).toEqual({ ...ZERO, grid: 1 });
    expect(kindOf(gridReqs().at(-1))).toBe('Movie');
  });

  it('Movies: a movie added → the grid and the genre list; an episode added → nothing', async () => {
    await setup();
    await loaded('Library', { params: { type: 'movies' }, active: true });
    let c0 = counts();
    srv.tv.total = 51;
    await clock.tick(90 * SEC);
    expect(delta(c0, counts())).toEqual(ZERO);
    c0 = counts();
    srv.movie.total = 11;
    await clock.tick(90 * SEC);
    expect(delta(c0, counts())).toEqual({ ...ZERO, grid: 1, genres: 1 });
  });

  it('Shows: position only → no reload; an episode added → the shows grid', async () => {
    await setup();
    await loaded('Library', { params: { type: 'shows' }, active: true });
    let c0 = counts();
    srv.played.UserData.LastPlayedDate = '2026-01-01T12:00:00Z';
    await clock.tick(90 * SEC);
    expect(delta(c0, counts())).toEqual(ZERO);
    c0 = counts();
    srv.tv.top = 'e51';
    await clock.tick(90 * SEC);
    expect(delta(c0, counts())).toEqual({ ...ZERO, grid: 1, genres: 1 });
    expect(kindOf(gridReqs().at(-1))).toBe('Series');
  });
});

/* ------------------------------------------------------- Home: snapshot ---- */

const text = (el) => el.textContent.replace(/\s+/g, ' ');

describe('Home and its snapshot', () => {
  it('a live load is saved 1.5 s later under reel.homeSnap.u1: the four rails, trimmed (no MediaSources)', async () => {
    await setup();
    await mountScreen('Home', { active: true });
    await clock.tick(500);
    expect(srv.resume[0].MediaSources).toBeTruthy();
    await clock.tick(1500);
    const s = readJSON('reel.homeSnap.u1');
    expect(s && s.v).toBe(1);
    const paths = s.entries.map((e) => e[0]);
    expect(paths.map((p) => p.split('?')[0]).sort()).toEqual(['/Items/Latest', '/Items/Latest', '/Shows/NextUp', '/UserItems/Resume']);
    const cw = s.entries.find((e) => e[0].startsWith('/UserItems/Resume'))[1].data.Items[0];
    expect(cw.Id).toBe('cw1');
    expect(cw.MediaSources).toBeUndefined();
    expect(m.snap.homeSnap.shown).toBe(true);
  });

  it('next start: painted from the snapshot in the mount itself, before any answer; a Continue Watching tap waits for the live item', async () => {
    // session 1: a live load writes the snapshot
    await setup();
    await mountScreen('Home', { active: true });
    await clock.tick(2000);
    const raw = localStorage.getItem('reel.homeSnap.u1');
    expect(raw).toBeTruthy();
    m.svelte.unmount(comp);
    comp = null;
    for (const [t, type, fn, o] of added) t.removeEventListener(type, fn, o);
    added = [];

    // session 2: the same user, the server slow to answer the rails
    await setup({ storage: { 'reel.homeSnap.u1': raw }, hang: true });
    const gate = {};
    const live = new Promise((res) => (gate.open = res));
    net.on('GET', /./, () => live.then(() => ({ Items: [], TotalRecordCount: 0 })));
    net.on('GET', '/UserItems/Resume', () => live.then(() => ({ Items: srv.resume, TotalRecordCount: 1 })));
    net.on('GET', '/Shows/NextUp', () => live.then(() => ({ Items: srv.nextup, TotalRecordCount: 1 })));
    net.on('GET', '/Items/Latest', (req) => live.then(() => (kindOf(req) === 'Movie' ? srv.latestMovies : srv.latestShows)));
    net.on('GET', /\/api\/trending\?type=/, []);
    net.on('POST', /\/PlaybackInfo/, net.hang());
    const target = await mountScreen('Home', { active: true });
    // synchronously after mount: the snapshot's tiles, no answer has landed
    expect(text(target)).toContain('Continue Watching');
    expect(target.querySelector('[data-cell="cw-cw1"]')).not.toBe(null);
    expect(m.snap.homeSnap.shown).toBe(true);

    // a tap on the snapshot tile: nothing plays from a MediaSources-less copy
    target.querySelector('[data-cell="cw-cw1"] [role="button"]').click();
    await clock.tick(1000);
    expect(net.callsTo(/\/PlaybackInfo/)).toEqual([]);
    expect(target.querySelector('[data-cell="cw-cw1"] .is-pressed')).not.toBe(null);

    // the live answer lands → the start goes ahead with the live item
    gate.open();
    await clock.tick(1000);
    const pi = net.callsTo(/\/Items\/cw1\/PlaybackInfo/);
    expect(pi.length).toBeGreaterThan(0);
    // with the live copy: its MediaSource (the snapshot copy has none to name)
    expect(pi[0].body.MediaSourceId).toBe(srv.resume[0].MediaSources[0].Id);
  });

  it('another user’s snapshot is never painted', async () => {
    await setup();
    await mountScreen('Home', { active: true });
    await clock.tick(2000);
    const raw = localStorage.getItem('reel.homeSnap.u1');
    m.svelte.unmount(comp);
    comp = null;
    for (const [t, type, fn, o] of added) t.removeEventListener(type, fn, o);
    added = [];

    await setup({
      storage: {
        'reel.userId': 'u2',
        'reel.token': 'tok-u2',
        'reel.accounts': [{ server: 'http://jf.test', userId: 'u1', userName: 'A', token: 'tok-u1' }],
        'reel.homeSnap.u1': raw
      },
      hang: true
    });
    net.on('GET', /./, net.hang());
    const target = await mountScreen('Home', { active: true });
    expect(target.querySelector('[data-cell="cw-cw1"]')).toBe(null);
    expect(text(target)).not.toContain('Continue Watching');
    expect(m.snap.homeSnap.shown).toBe(false);
  });
});
