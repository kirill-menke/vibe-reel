/* phone/src/lib/freshness.svelte.js — automatic freshness for the browse screens.
 *
 * CLAUDE.md: "While on screen, booted, not under the player/Login and online:
 * every 90 s (5 min after 10 min without a touch, 15 min after 1 h) and on every
 * return to the foreground, three Limit=1 /Items markers … the newest Movie and
 * the newest Episode by DateCreated with their TotalRecordCount (added/removed),
 * and the last played Movie/Episode with its UserData (watched anywhere).
 * onLibraryChange tells Home/Library what moved … A position-only change
 * (someone watching on the TV) refreshes Continue Watching, not the poster grids
 * … It also checks at once when an import lands (landed.svelte.js) and when a
 * push arrives while the app is open (sw.js posts vr-changed); after the player
 * closes the next answer only becomes the baseline."
 *
 * Jellyfin is a fake library (`srv`) behind mockFetch(); time is the fake clock,
 * installed before the import so the module's idle clock starts on it. Every
 * listener the module graph adds to window / document is removed after the
 * test, so an old graph never reacts to a later test's events. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { freshImport, TEST_USER } from '../helpers/modules.js';
import { mockFetch } from '../helpers/fetch.js';
import { useClock } from '../helpers/time.js';

const SEC = 1000;
const MIN = 60 * SEC;

/* ---------------------------------------------------------------- harness ---- */

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
let hidden = false;
afterEach(() => {
  for (const [t, type, fn, o] of added) t.removeEventListener(type, fn, o);
  added = [];
  for (const [t, orig] of origAdd) t.addEventListener = orig;
  origAdd.clear();
  hidden = false;
  delete document.visibilityState;
  delete navigator.onLine;
  delete navigator.serviceWorker;
});

function setHidden(h) {
  hidden = h;
  document.dispatchEvent(new Event('visibilitychange'));
}

let clock, net, m, srv, changes, sw;
/** The fake library the markers read. */
function library() {
  return {
    movie: { total: 10, top: 'm10' },
    tv: { total: 50, top: 'e50' },
    played: { Id: 'e7', Type: 'Episode', UserData: { Played: false, PlayCount: 0, PlaybackPositionTicks: 100, LastPlayedDate: '2026-01-01T10:00:00Z' } }
  };
}
const kinds = { Movie: 'movie', Episode: 'tv', 'Movie,Episode': 'played' };

async function setup({ boot = true, subscribe = true, serviceWorker = true } = {}) {
  clock = useClock();
  captureListeners(window, document);
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  sw = null;
  if (serviceWorker) {
    sw = new EventTarget();
    captureListeners(sw);
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: sw });
  }
  m = await freshImport({
    modules: {
      fr: 'phone/src/lib/freshness.svelte.js',
      router: 'phone/src/lib/router.svelte.js',
      conn: 'phone/src/lib/conn.svelte.js',
      landed: 'src/lib/landed.svelte.js',
      config: 'src/lib/config.js'
    }
  });
  srv = library();
  net = mockFetch();
  net.on('GET', (req) => req.path === '/Items', (req) => {
    const q = new URLSearchParams(req.query);
    const k = kinds[q.get('IncludeItemTypes')];
    if (k === 'played') return srv.played ? { Items: [structuredClone(srv.played)], TotalRecordCount: 99 } : { Items: [], TotalRecordCount: 0 };
    const s = srv[k];
    return { Items: s.top ? [{ Id: s.top, Type: k === 'tv' ? 'Episode' : 'Movie' }] : [], TotalRecordCount: s.total };
  });
  net.on('GET', '/System/Info/Public', {}); // conn.svelte.js's own reachability check on `online`
  changes = [];
  if (subscribe) m.unsub = m.fr.onLibraryChange((c) => changes.push(c));
  if (boot) m.router.markBooted();
  await clock.tick(0); // the gate effect
}

/** Times (ms since the fake start) of every marker round, by its movie query. */
const isKind = (types) => (r) => r.path === '/Items' && new URLSearchParams(r.query).get('IncludeItemTypes') === types;
const rounds = () => net.callsTo(isKind('Movie'));
const roundCount = () => rounds().length;
const NO_CHANGE = { movie: false, tv: false, played: false, progress: false };

/* ------------------------------------------------------------ the markers ---- */

describe('the three Limit=1 /Items markers', () => {
  it('first check 300 ms after boot: movie / episode by DateCreated, last played with UserData — no images, one item each', async () => {
    await setup();
    expect(roundCount()).toBe(0);
    await clock.tick(300);
    const calls = net.callsTo((r) => r.path === '/Items');
    expect(calls).toHaveLength(3);
    const qs = calls.map((c) => Object.fromEntries(new URLSearchParams(c.query)));
    const base = { userId: TEST_USER, Recursive: 'true', SortOrder: 'Descending', Limit: '1', EnableImages: 'false' };
    expect(qs).toEqual([
      { ...base, IncludeItemTypes: 'Movie', SortBy: 'DateCreated', EnableUserData: 'false' },
      { ...base, IncludeItemTypes: 'Episode', SortBy: 'DateCreated', EnableUserData: 'false' },
      { ...base, IncludeItemTypes: 'Movie,Episode', SortBy: 'DatePlayed', EnableUserData: 'true' }
    ]);
    expect(calls.every((c) => c.url.startsWith('http://jf.test/Items?'))).toBe(true);
    expect(calls.every((c) => c.signal)).toBe(true); // its own 10 s deadline
    expect(changes).toEqual([]); // the first answer is only the baseline
    expect(net.unmatched).toEqual([]);
  });

  it('the first subscriber starts the checks; nothing runs without one', async () => {
    await setup({ subscribe: false });
    await clock.tick(10 * MIN);
    expect(net.calls).toEqual([]);
    m.fr.checkSoon(0); // before start(): a no-op
    await clock.tick(1000);
    expect(net.calls).toEqual([]);
    m.fr.onLibraryChange(() => {});
    await clock.tick(300);
    expect(roundCount()).toBe(1);
  });
});

/* --------------------------------------------------------------- cadence ---- */

describe('cadence: 90 s, 5 min after 10 min untouched, 15 min after 1 h', () => {
  it('the gaps between checks follow the idle back-off', async () => {
    await setup();
    const at = [];
    net.on('GET', isKind('Movie'), (req) => (at.push(clock.now()), { Items: [{ Id: 'm10' }], TotalRecordCount: 10 }));
    const start = clock.now();
    await clock.tick(95 * MIN);
    const gaps = at.slice(1).map((t, i) => (t - at[i]) / SEC);
    expect(at[0] - start).toBe(300);
    // 0.3 s … 630.3 s every 90 s (idle ≤ 10 min when each was scheduled); idle > 10 min at
    // 630.3 → every 5 min; idle > 1 h at 3630.3 → every 15 min (4530.3, 5430.3)
    expect(gaps).toEqual([...Array(7).fill(90), ...Array(10).fill(300), 900, 900]);
  });

  it('a touch after 10 min idle checks at once and restores the 90 s pace; a touch while active doesn’t add a check', async () => {
    await setup();
    await clock.tick(300);
    await clock.tick(30 * SEC);
    window.dispatchEvent(new Event('pointerdown'));
    await clock.tick(100);
    expect(roundCount()).toBe(1); // not idle: nothing extra
    await clock.tick(20 * MIN); // checks at 90 s steps until idle, then 5 min
    const before = roundCount();
    window.dispatchEvent(new Event('keydown'));
    await clock.tick(0);
    expect(roundCount()).toBe(before + 1);
    const after = roundCount();
    await clock.tick(90 * SEC);
    expect(roundCount()).toBe(after + 1);
  });

  it.each(['touchstart', 'pointerdown', 'keydown', 'wheel'])('%s counts as input', async (type) => {
    await setup();
    await clock.tick(15 * MIN);
    const n = roundCount();
    const e = new Event(type);
    Object.defineProperty(e, 'touches', { value: [] });
    window.dispatchEvent(e);
    await clock.tick(0);
    expect(roundCount()).toBe(n + 1);
  });
});

/* ----------------------------------------------------------------- gates ---- */

describe('only while on screen, booted, not under the player/Login, and online', () => {
  it('not booted: nothing; markBooted starts it', async () => {
    await setup({ boot: false });
    await clock.tick(5 * MIN);
    expect(net.calls).toEqual([]);
    m.router.markBooted();
    await clock.tick(300);
    expect(roundCount()).toBe(1);
  });

  it('hidden stops it; every return to the foreground checks 800 ms later', async () => {
    await setup();
    await clock.tick(300);
    setHidden(true);
    await clock.tick(60 * MIN);
    expect(roundCount()).toBe(1);
    setHidden(false);
    await clock.tick(799);
    expect(roundCount()).toBe(1);
    await clock.tick(1);
    expect(roundCount()).toBe(2);
    setHidden(true);
    await clock.tick(SEC);
    setHidden(false);
    await clock.tick(800);
    expect(roundCount()).toBe(3);
  });

  it.each(['player', 'login'])('under the %s modal: no checks; closed after it was due → a check at once (300 ms)', async (modal) => {
    await setup();
    await clock.tick(300);
    m.router.R.modal = modal;
    await clock.tick(10 * MIN);
    expect(roundCount()).toBe(1);
    m.router.R.modal = null; // directly: closePlayer() would also bump playerClosed
    await clock.tick(299);
    expect(roundCount()).toBe(1);
    await clock.tick(1);
    expect(roundCount()).toBe(2);
  });

  it('a modal closed before the next check was due keeps the original schedule', async () => {
    await setup();
    await clock.tick(300); // check at 0.3 s
    m.router.R.modal = 'login';
    await clock.tick(40 * SEC);
    m.router.R.modal = null; // at 40.3 s: due at 90.3 s
    await clock.tick(50 * SEC - 1);
    expect(roundCount()).toBe(1);
    await clock.tick(1);
    expect(roundCount()).toBe(2);
  });

  it('the offline banner (conn.offline) closes the gate; its clearing reopens it', async () => {
    await setup();
    await clock.tick(300);
    m.conn.conn.offline = true;
    await clock.tick(10 * MIN);
    expect(roundCount()).toBe(1);
    m.conn.conn.offline = false;
    await clock.tick(300);
    expect(roundCount()).toBe(2);
  });

  it('navigator.onLine false: the due check is skipped; `online` checks 2 s later', async () => {
    await setup();
    await clock.tick(300);
    let online = false;
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
    await clock.tick(10 * MIN);
    expect(roundCount()).toBe(1);
    online = true;
    window.dispatchEvent(new Event('online'));
    await clock.tick(1999);
    expect(roundCount()).toBe(1);
    await clock.tick(1);
    expect(roundCount()).toBe(2);
  });

  /* every trigger goes through the same gate: a push, `online`, a landing or the
   * first touch after a long idle must not sneak a check past a closed one */
  it.each([
    ['hidden', () => (hidden = true)],
    ['not booted', () => (m.router.R.booted = false)],
    // (the server stays unreachable: conn's own `online` re-check keeps the banner up)
    ['offline banner', () => ((m.conn.conn.offline = true), net.on('GET', '/System/Info/Public', net.networkError()))],
    ['under the player', () => (m.router.R.modal = 'player')]
  ])('gate shut (%s): no trigger gets a check through', async (_, shut) => {
    await setup();
    await clock.tick(300);
    expect(roundCount()).toBe(1);
    shut();
    await clock.tick(15 * MIN); // idle by now
    sw.dispatchEvent(new MessageEvent('message', { data: { type: 'vr-changed' } }));
    window.dispatchEvent(new Event('online'));
    m.landed.landed.items = [{ key: 'tv:9', eps: [], at: 9, seen: false }];
    window.dispatchEvent(new Event('pointerdown'));
    await clock.tick(10 * MIN);
    expect(roundCount()).toBe(1);
  });

  it('signed out (no token): no checks', async () => {
    await setup({ boot: false });
    m.config.cfg.token = '';
    m.router.markBooted();
    await clock.tick(10 * MIN);
    expect(net.calls).toEqual([]);
  });
});

/* --------------------------------------------------------------- diffing ---- */

describe('onLibraryChange: what moved', () => {
  async function baseline() {
    await setup();
    await clock.tick(300);
    expect(roundCount()).toBe(1);
  }
  const next = async () => {
    await clock.tick(90 * SEC);
  };

  it('nothing changed: no call', async () => {
    await baseline();
    await next();
    await next();
    expect(roundCount()).toBe(3);
    expect(changes).toEqual([]);
  });

  it('a movie added (count + newest) → movie only', async () => {
    await baseline();
    srv.movie = { total: 11, top: 'm11' };
    await next();
    expect(changes).toEqual([{ ...NO_CHANGE, movie: true, type: 'tv' }]);
  });

  it('a movie deleted: same newest, the count drops → movie', async () => {
    await baseline();
    srv.movie.total = 9;
    await next();
    expect(changes).toEqual([{ ...NO_CHANGE, movie: true, type: 'tv' }]);
  });

  it('the newest replaced at the same count (one added, one removed) → movie', async () => {
    await baseline();
    srv.movie.top = 'm99';
    await next();
    expect(changes).toEqual([{ ...NO_CHANGE, movie: true, type: 'tv' }]);
  });

  it('an episode added → tv only; the library emptied → tv', async () => {
    await baseline();
    srv.tv = { total: 51, top: 'e51' };
    await next();
    srv.tv = { total: 0, top: null };
    await next();
    expect(changes).toEqual([
      { ...NO_CHANGE, tv: true, type: 'tv' },
      { ...NO_CHANGE, tv: true, type: 'tv' }
    ]);
  });

  it('watched elsewhere (Played flips) → played, with the item’s kind', async () => {
    await baseline();
    srv.played.UserData.Played = true;
    srv.played.UserData.PlayCount = 1;
    await next();
    expect(changes).toEqual([{ ...NO_CHANGE, played: true, type: 'tv' }]);
  });

  it('PlayCount alone (a rewatch finished) → played', async () => {
    await baseline();
    srv.played.UserData.PlayCount = 2;
    await next();
    expect(changes).toEqual([{ ...NO_CHANGE, played: true, type: 'tv' }]);
  });

  it('another item was played last → played; a Movie → type movie', async () => {
    await baseline();
    srv.played = { Id: 'm3', Type: 'Movie', UserData: { PlaybackPositionTicks: 5 } };
    await next();
    expect(changes).toEqual([{ ...NO_CHANGE, played: true, type: 'movie' }]);
  });

  it('position only (someone watching on the TV) → progress only: Continue Watching, not the poster grids', async () => {
    await baseline();
    srv.played.UserData.PlaybackPositionTicks = 9e9;
    await next();
    expect(changes).toEqual([{ movie: false, tv: false, played: false, progress: true, type: 'tv' }]);
    srv.played.UserData.LastPlayedDate = '2026-01-01T12:05:00Z'; // the date alone moves too
    await next();
    expect(changes[1]).toEqual({ movie: false, tv: false, played: false, progress: true, type: 'tv' });
  });

  it('a played change that also moved the position is `played`, not `progress`', async () => {
    await baseline();
    srv.played.UserData = { Played: true, PlayCount: 1, PlaybackPositionTicks: 0, LastPlayedDate: '2026-01-01T12:05:00Z' };
    await next();
    expect(changes).toEqual([{ ...NO_CHANGE, played: true, type: 'tv' }]);
  });

  it('nothing was ever played, then something is: played, type from that item; no played item → type null', async () => {
    await setup();
    srv.played = null;
    await clock.tick(300);
    srv.movie.total = 12;
    await next();
    expect(changes).toEqual([{ ...NO_CHANGE, movie: true, type: null }]);
    srv.played = { Id: 'm1', Type: 'Movie', UserData: {} };
    await next();
    expect(changes[1]).toEqual({ ...NO_CHANGE, played: true, type: 'movie' });
  });

  it('several things at once arrive in one call', async () => {
    await baseline();
    srv.movie.total = 11;
    srv.tv.top = 'e99';
    srv.played.UserData.Played = true;
    await next();
    expect(changes).toEqual([{ movie: true, tv: true, played: true, progress: false, type: 'tv' }]);
  });

  it('a throwing subscriber doesn’t stop the others; an unsubscribed one hears nothing', async () => {
    await baseline();
    const other = [];
    const off = m.fr.onLibraryChange(() => {
      throw new Error('boom');
    });
    m.fr.onLibraryChange((c) => other.push(c));
    const gone = [];
    const offGone = m.fr.onLibraryChange((c) => gone.push(c));
    expect(offGone()).toBe(true);
    srv.movie.total = 11;
    await next();
    expect(changes).toHaveLength(1);
    expect(other).toHaveLength(1);
    expect(gone).toEqual([]);
    off();
  });

  it('a failed round (network) changes nothing: the next good answer is compared with the last good one', async () => {
    await baseline();
    net.once('GET', isKind('Episode'), net.networkError());
    srv.movie.total = 11;
    await next();
    expect(changes).toEqual([]);
    await next();
    expect(changes).toEqual([{ ...NO_CHANGE, movie: true, type: 'tv' }]);
  });

  it('a hung server: the round gives up at 10 s and the next one is a period after that', async () => {
    await baseline();
    net.once('GET', isKind('Movie,Episode'), net.hang());
    await next(); // round 2 starts at 90.3 s and hangs
    const hung = net.callsTo(isKind('Movie,Episode')).at(-1);
    await clock.tick(10 * SEC - 1);
    expect(hung.signal.aborted).toBe(false);
    await clock.tick(1);
    expect(hung.signal.aborted).toBe(true);
    await clock.tick(90 * SEC - 1);
    expect(roundCount()).toBe(2);
    await clock.tick(1);
    expect(roundCount()).toBe(3);
  });

  it('a check asked for while one is in flight doesn’t start a second round', async () => {
    await baseline();
    net.once('GET', isKind('Movie'), { Items: [{ Id: 'm10' }], TotalRecordCount: 10 }, { delay: 5000 });
    await next();
    expect(roundCount()).toBe(2);
    setHidden(false); // a foreground event mid-round → checkSoon(800)
    await clock.tick(2000);
    expect(roundCount()).toBe(2);
    await clock.tick(3000);
    expect(roundCount()).toBe(2);
  });
});

/* ------------------------------------------------- the player closed: rebase ---- */

describe('after the player closes the next answer only becomes the baseline', () => {
  it('playerClosed → a check 4 s later whose changes are not reported; later changes are', async () => {
    await setup();
    await clock.tick(300);
    m.router.R.modal = 'player';
    await clock.tick(20 * MIN);
    // what this device just did while playing
    srv.played.UserData = { Played: true, PlayCount: 1, PlaybackPositionTicks: 0, LastPlayedDate: 'x' };
    window.dispatchEvent(new Event('pointerdown')); // the tap on Close (no check: the gate is shut)
    m.router.closePlayer();
    expect(m.router.R.playerClosed).toBe(1);
    // 4 s later — after the Stopped report has been stored — not the gate's 300 ms
    await clock.tick(3999);
    expect(roundCount()).toBe(1);
    await clock.tick(1);
    expect(roundCount()).toBe(2);
    expect(changes).toEqual([]);
    await clock.tick(90 * SEC);
    expect(changes).toEqual([]);
    srv.movie.total = 11;
    await clock.tick(90 * SEC);
    expect(changes).toEqual([{ ...NO_CHANGE, movie: true, type: 'tv' }]);
  });

  it('rebase() (a change this app made itself) swallows exactly the next answer', async () => {
    await setup();
    await clock.tick(300);
    srv.played.UserData.Played = true;
    m.fr.rebase();
    await clock.tick(90 * SEC);
    expect(changes).toEqual([]);
    srv.played.UserData.PlayCount = 3;
    await clock.tick(90 * SEC);
    expect(changes).toEqual([{ ...NO_CHANGE, played: true, type: 'tv' }]);
  });

  it('an answer that lands while a modal is up is only the baseline', async () => {
    await setup();
    await clock.tick(300);
    net.once('GET', isKind('Movie'), { Items: [{ Id: 'm11' }], TotalRecordCount: 11 }, { delay: 3000 });
    await clock.tick(90 * SEC); // round 2 in flight
    m.router.R.modal = 'login';
    srv.movie = { total: 11, top: 'm11' };
    await clock.tick(3000);
    expect(changes).toEqual([]);
    m.router.R.modal = null;
    await clock.tick(90 * SEC);
    expect(changes).toEqual([]); // m11 was already the baseline
  });
});

/* ------------------------------------------- immediate checks: landed, push ---- */

describe('a check at once on an import landing or a vr-changed push', () => {
  it('a landed entry (Ready to watch) → a check 300 ms later', async () => {
    await setup();
    await clock.tick(300);
    await clock.tick(10 * SEC);
    m.landed.landed.items = [{ key: 'tv:1', eps: [{ s: 1, e: 1 }], at: 1, seen: false }];
    await clock.tick(299);
    expect(roundCount()).toBe(1);
    await clock.tick(1);
    expect(roundCount()).toBe(2);
    // another episode of the same title lands
    m.landed.landed.items = [{ key: 'tv:1', eps: [{ s: 1, e: 1 }, { s: 1, e: 2 }], at: 1, seen: false }];
    await clock.tick(300);
    expect(roundCount()).toBe(3);
  });

  it('a vr-changed message from sw.js → a check 1.5 s later; other messages don’t', async () => {
    await setup();
    await clock.tick(300);
    await clock.tick(10 * SEC);
    sw.dispatchEvent(new MessageEvent('message', { data: { type: 'vr-open', open: {} } }));
    sw.dispatchEvent(new MessageEvent('message', { data: null }));
    await clock.tick(5 * SEC);
    expect(roundCount()).toBe(1);
    sw.dispatchEvent(new MessageEvent('message', { data: { type: 'vr-changed' } }));
    await clock.tick(1499);
    expect(roundCount()).toBe(1);
    await clock.tick(1);
    expect(roundCount()).toBe(2);
  });

  it('a landing, a push and a resume together make one check (debounced)', async () => {
    await setup();
    await clock.tick(300);
    await clock.tick(10 * SEC);
    sw.dispatchEvent(new MessageEvent('message', { data: { type: 'vr-changed' } }));
    m.landed.landed.items = [{ key: 'movie:9', eps: [], at: 5, seen: false }];
    setHidden(false);
    await clock.tick(5 * SEC);
    expect(roundCount()).toBe(2);
  });

  it('no service worker: start() still works', async () => {
    await setup({ serviceWorker: false });
    await clock.tick(300);
    expect(roundCount()).toBe(1);
  });

  it('the landing check honours the gate (none under the player)', async () => {
    await setup();
    await clock.tick(300);
    m.router.R.modal = 'player';
    await clock.tick(0);
    m.landed.landed.items = [{ key: 'tv:1', eps: [], at: 2, seen: false }];
    await clock.tick(SEC);
    expect(roundCount()).toBe(1);
  });
});

/* ------------------------------------------------------------ whenSettled ---- */

function touch(type, n) {
  const e = new Event(type);
  Object.defineProperty(e, 'touches', { value: Array.from({ length: n }) });
  window.dispatchEvent(e);
}
function pointer(type, pointerType, isPrimary = true) {
  const e = new Event(type);
  Object.defineProperty(e, 'pointerType', { value: pointerType });
  Object.defineProperty(e, 'isPrimary', { value: isPrimary });
  window.dispatchEvent(e);
}

describe('whenSettled(): once no finger is down and no scroll ran for 700 ms', () => {
  it('quiet: resolves at once', async () => {
    await setup();
    let done = false;
    m.fr.whenSettled().then(() => (done = true));
    await clock.flush();
    expect(done).toBe(true);
  });

  it('a finger down: waits for touchend with no touches left (polled every 250 ms)', async () => {
    await setup();
    touch('touchstart', 1);
    touch('touchstart', 2);
    let done = false;
    m.fr.whenSettled().then(() => (done = true));
    await clock.tick(5 * SEC);
    expect(done).toBe(false);
    touch('touchend', 1);
    await clock.tick(1000);
    expect(done).toBe(false);
    touch('touchend', 0);
    await clock.tick(250);
    expect(done).toBe(true);
  });

  it('touchcancel and a primary touch pointerup / pointercancel also lift it (iOS drops touchend for a detached node)', async () => {
    await setup();
    for (const lift of [() => touch('touchcancel', 0), () => pointer('pointerup', 'touch'), () => pointer('pointercancel', 'touch')]) {
      touch('touchstart', 1);
      let done = false;
      m.fr.whenSettled().then(() => (done = true));
      await clock.tick(500);
      expect(done).toBe(false);
      lift();
      await clock.tick(250);
      expect(done).toBe(true);
    }
  });

  it('a mouse pointerup or a non-primary touch pointerup doesn’t count as the finger lifting', async () => {
    await setup();
    touch('touchstart', 1);
    let done = false;
    m.fr.whenSettled().then(() => (done = true));
    pointer('pointerup', 'mouse');
    pointer('pointerup', 'touch', false);
    await clock.tick(2 * SEC);
    expect(done).toBe(false);
  });

  it('a scroll (momentum included) holds it until 700 ms after the last one', async () => {
    await setup();
    window.dispatchEvent(new Event('scroll'));
    let done = false;
    m.fr.whenSettled().then(() => (done = true));
    await clock.tick(500);
    window.dispatchEvent(new Event('scroll')); // momentum
    await clock.tick(500);
    expect(done).toBe(false);
    await clock.tick(500);
    expect(done).toBe(true);
  });
});

/* ------------------------------------------------------------- keepScroll ---- */

/* A tiny layout engine: rows stack vertically by their `h`, tiles in a rail
 * horizontally by their `w` after a 16 px padding; rects follow scroll. */
function vRoot(heights, { top = 100, scrollTop = 0 } = {}) {
  const root = document.createElement('div');
  let st = scrollTop;
  Object.defineProperty(root, 'scrollTop', { get: () => st, set: (v) => (st = v) });
  root.getBoundingClientRect = () => ({ top, bottom: top + 800, height: 800 });
  for (const h of heights) root.append(vRow(h, root, top));
  document.body.append(root);
  return root;
}
function vRow(h, root, top = 100) {
  const el = document.createElement('section');
  el.h = h;
  el.getBoundingClientRect = () => {
    let y = 0;
    for (const s of el.parentElement.children) {
      if (s === el) break;
      y += s.h || 0;
    }
    const t = top + y - root.scrollTop;
    return { top: t, bottom: t + h, height: h };
  };
  return el;
}
function rail(widths, scrollLeft) {
  const tr = document.createElement('div');
  tr.className = 'rail__track';
  let sl = scrollLeft;
  Object.defineProperty(tr, 'scrollLeft', { get: () => sl, set: (v) => (sl = v) });
  for (const w of widths) tr.append(tile(w));
  return tr;
}
function tile(w) {
  const el = document.createElement('a');
  Object.defineProperty(el, 'offsetWidth', { get: () => w });
  Object.defineProperty(el, 'offsetLeft', {
    get: () => {
      let x = 16;
      for (const s of el.parentElement.children) {
        if (s === el) break;
        x += s.offsetWidth;
      }
      return x;
    }
  });
  return el;
}

describe('keepScroll(): what is under the finger stays put across a re-render', () => {
  afterEach(() => (document.body.innerHTML = ''));

  it('scrolled: a row inserted above the anchor shifts scrollTop by its height', async () => {
    await setup();
    const root = vRoot([300, 300, 300, 300], { scrollTop: 450 }); // anchor: row 2 (300..600), 150 px into it
    const restore = m.fr.keepScroll(root);
    root.prepend(vRow(200, root));
    restore();
    expect(root.scrollTop).toBe(650);
  });

  it('a row removed above the anchor shifts it back; nothing moved → scrollTop untouched', async () => {
    await setup();
    const root = vRoot([300, 300, 300], { scrollTop: 450 });
    let restore = m.fr.keepScroll(root);
    root.firstElementChild.remove();
    restore();
    expect(root.scrollTop).toBe(150);
    restore = m.fr.keepScroll(root);
    restore();
    expect(root.scrollTop).toBe(150);
  });

  it('at the top: no anchoring — new things may appear there', async () => {
    await setup();
    const root = vRoot([300, 300], { scrollTop: 0 });
    const restore = m.fr.keepScroll(root);
    root.prepend(vRow(200, root));
    restore();
    expect(root.scrollTop).toBe(0);
  });

  it('zero-height rows are skipped; a custom `rows` selector picks the anchor set', async () => {
    await setup();
    const root = vRoot([0, 300, 300], { scrollTop: 100 });
    const restore = m.fr.keepScroll(root);
    root.children[1].before(vRow(50, root)); // before the anchor (the 300 one), after the empty one
    restore();
    expect(root.scrollTop).toBe(150);

    // an absolutely placed empty element first in DOM order (rect inside the viewport) is no anchor
    const r3 = vRoot([300, 300, 300], { scrollTop: 450 });
    const abs = document.createElement('i');
    abs.getBoundingClientRect = () => ({ top: 400, bottom: 400, height: 0 });
    r3.prepend(abs);
    const restore3 = m.fr.keepScroll(r3);
    r3.children[1].before(vRow(200, r3));
    restore3();
    expect(r3.scrollTop).toBe(650);

    const grid = document.createElement('div');
    grid.className = 'g';
    const r2 = vRoot([], { scrollTop: 250 });
    r2.append(grid);
    grid.getBoundingClientRect = () => ({ top: 100 - r2.scrollTop, bottom: 0, height: 0 });
    for (const h of [100, 100, 100, 100]) grid.append(vRow(h, r2));
    const restore2 = m.fr.keepScroll(r2, '.g > *');
    grid.prepend(vRow(100, r2));
    restore2();
    expect(r2.scrollTop).toBe(350);
  });

  it('an anchor that left the DOM: scrollTop left alone', async () => {
    await setup();
    const root = vRoot([300, 300, 300], { scrollTop: 450 });
    const restore = m.fr.keepScroll(root);
    root.children[1].remove();
    root.prepend(vRow(500, root));
    restore();
    expect(root.scrollTop).toBe(450);
  });

  it('every scrolled rail keeps its first visible tile; an unscrolled rail is left alone', async () => {
    await setup();
    const root = vRoot([400, 400], { scrollTop: 0 });
    const a = rail([100, 100, 100, 100], 150); // first visible: tile 1 (116..216), 34 px left of the edge… off = 116-16-150 = -50
    const b = rail([100, 100], 0);
    root.children[0].append(a);
    root.children[1].append(b);
    const restore = m.fr.keepScroll(root);
    a.prepend(tile(120));
    b.prepend(tile(120));
    restore();
    expect(a.scrollLeft).toBe(270);
    expect(b.scrollLeft).toBe(0);
  });

  it('a rail tile that moved to another rail or was removed: that rail is left alone', async () => {
    await setup();
    const root = vRoot([400], { scrollTop: 0 });
    const a = rail([100, 100, 100], 150);
    const other = rail([100], 0);
    root.children[0].append(a, other);
    const restore = m.fr.keepScroll(root);
    const anchor = a.children[1];
    other.prepend(tile(400));
    other.append(anchor); // now at 400 in the other rail: following it would scroll `a` to 450
    restore();
    expect(a.scrollLeft).toBe(150);
  });

  it('an empty scrolled rail is skipped; no root → a no-op restore', async () => {
    await setup();
    const root = vRoot([400], { scrollTop: 0 });
    const a = rail([], 10);
    root.children[0].append(a);
    expect(() => m.fr.keepScroll(root)()).not.toThrow();
    expect(a.scrollLeft).toBe(10);
    expect(() => m.fr.keepScroll(null)()).not.toThrow();
  });
});

it('dev hook: __freshness.state() reports the last answer and the current period', async () => {
  await setup();
  await clock.tick(300);
  const st = window.__freshness.state();
  expect(st.sig.movie).toBe('10:m10');
  expect(st.period).toBe(90 * SEC);
  await window.__freshness.check();
  expect(roundCount()).toBe(2);
});
