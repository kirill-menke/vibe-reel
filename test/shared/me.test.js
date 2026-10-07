/* me.svelte.js: the caller's ownership and quota (reel-api GET /api/me) and
 * "My library"'s Delete (DELETE /api/library/{type}/{id}?delete_files=true).
 *
 * run/design.md §6.1 (the module API), §6.4 (delete semantics), §10 (an old
 * backend answers /api/me with 404: no My library, no client-side quota check,
 * never asked again this session). Admin = Jellyfin's Policy.IsAdministrator:
 * `limit: null`, never quota-full. */
import { describe, it, expect, beforeEach } from 'vitest';
import { freshImport, TEST_MEDIALIB } from '../helpers/modules.js';
import { mockFetch } from '../helpers/fetch.js';
import { useClock, flushPromises } from '../helpers/time.js';

const ME_URL = TEST_MEDIALIB + '/api/me';
let M, L, T, ML, net;

beforeEach(async () => {
  ({ M, L, T, ML } = await freshImport({
    modules: { M: 'src/lib/me.svelte.js', L: 'src/lib/lookup.svelte.js', T: 'src/lib/toast.svelte.js', ML: 'src/lib/medialib.js' }
  }));
  net = mockFetch();
});

const toastMsg = () => T.toastState.msg;

const dune = { type: 'movie', id: '693134', title: 'Dune', year: 2021, poster: null, added_at: '2026-10-05T12:00:00Z', status: 'in_library', progress: null, has_files: true };
const silo = { type: 'tv', id: '403245', title: 'Silo', year: 2023, poster: null, added_at: '2026-10-05T11:00:00Z', status: 'downloading', progress: 0.43, has_files: false };

function me({ admin = false, movie = [3, 10], tv = [10, 10], titles = [dune, silo] } = {}) {
  return {
    user: { id: 'u1', name: admin ? 'kirill' : 'nicole' },
    admin,
    quota: { movie: { used: movie[0], limit: admin ? null : movie[1] }, tv: { used: tv[0], limit: admin ? null : tv[1] } },
    titles: titles.map((t) => ({ ...t }))
  };
}

describe('refreshMe', () => {
  it('idle until asked; one GET /api/me → ok with the answer', async () => {
    expect(M.ME.state).toBe('idle');
    expect(M.ME.me).toBeNull();
    net.on('GET', ME_URL, me());
    const r = await M.refreshMe();
    expect(r.user.name).toBe('nicole');
    expect(M.ME.state).toBe('ok');
    expect(M.ME.me.quota.movie).toEqual({ used: 3, limit: 10 });
    expect(net.callsTo(ME_URL)).toHaveLength(1);
    expect(net.calls[0].headers.Authorization).toMatch(/Token="tok-u1"/);
  });

  it('concurrent callers share one request', async () => {
    net.on('GET', ME_URL, me(), { delay: 10 });
    const [a, b] = await Promise.all([M.refreshMe(), M.refreshMe({ maxAge: 30000 })]);
    expect(a).toBe(b);
    expect(net.callsTo(ME_URL)).toHaveLength(1);
  });

  it('maxAge keeps an answer that recent; 0 always asks again', async () => {
    const clock = useClock();
    net.on('GET', ME_URL, me());
    await M.refreshMe();
    await M.refreshMe({ maxAge: 30000 });
    expect(net.callsTo(ME_URL)).toHaveLength(1);
    await clock.tick(30001);
    await M.refreshMe({ maxAge: 30000 });
    expect(net.callsTo(ME_URL)).toHaveLength(2);
    await M.refreshMe();
    expect(net.callsTo(ME_URL)).toHaveLength(3);
  });

  it('404 (a reel-api from before ownership) → unsupported, never asked again this session', async () => {
    net.on('GET', ME_URL, net.status(404, { detail: 'Not Found' }));
    expect(await M.refreshMe()).toBeNull();
    expect(M.ME.state).toBe('unsupported');
    expect(M.ME.me).toBeNull();
    expect(await M.refreshMe()).toBeNull();
    expect(await M.refreshMe({ maxAge: 0 })).toBeNull();
    expect(net.callsTo(ME_URL)).toHaveLength(1);
    expect(M.quotaFull('movie')).toBe(false);
    expect(M.quotaSummary()).toBe('');
  });

  it('a failure → error, the last good answer stays; the next call retries', async () => {
    net.on('GET', ME_URL, me());
    await M.refreshMe();
    net.on('GET', ME_URL, net.status(503, { error: 'temporarily_unavailable', detail: 'x' }));
    expect(await M.refreshMe()).toBeNull();
    expect(M.ME.state).toBe('error');
    expect(M.ME.me.user.name).toBe('nicole');
    net.on('GET', ME_URL, net.networkError());
    await M.refreshMe();
    expect(M.ME.state).toBe('error');
    net.on('GET', ME_URL, me({ movie: [4, 10] }));
    await M.refreshMe();
    expect(M.ME.state).toBe('ok');
    expect(M.ME.me.quota.movie.used).toBe(4);
  });

  it('signed out: no request at all', async () => {
    ({ M } = await freshImport({ signedIn: false, modules: { M: 'src/lib/me.svelte.js' } }));
    net = mockFetch();
    expect(await M.refreshMe()).toBeNull();
    expect(net.calls).toEqual([]);
    expect(M.ME.state).toBe('idle');
  });

  it('an answer to a request sent before a local change is not applied over it', async () => {
    let release;
    net.once('GET', ME_URL, () => new Promise((r) => (release = () => r(me({ movie: [3, 10] })))));
    const p = M.refreshMe();
    await flushPromises();
    M.ME.me = me({ movie: [3, 10] }); // as if an earlier answer had landed
    M.ME.state = 'ok';
    M.noteAdded('movie'); // 4 of 10, locally
    net.on('GET', ME_URL, me({ movie: [4, 10] }));
    const q = M.refreshMe(); // must not share the stale request
    release();
    await p;
    expect(M.ME.me.quota.movie.used).toBe(4);
    await q;
    expect(M.ME.me.quota.movie.used).toBe(4);
    expect(net.callsTo(ME_URL)).toHaveLength(2);
  });
});

describe('quota helpers', () => {
  it('quotaFull: a normal user at or over the limit; never an admin, never without an answer', async () => {
    expect(M.quotaFull('movie')).toBe(false);
    net.on('GET', ME_URL, me({ movie: [3, 10], tv: [10, 10] }));
    await M.refreshMe();
    expect(M.quotaFull('movie')).toBe(false);
    expect(M.quotaFull('tv')).toBe(true);
    M.ME.me.quota.tv.used = 11;
    expect(M.quotaFull('tv')).toBe(true);
    M.ME.me.quota.movie = { used: 0, limit: 0 };
    expect(M.quotaFull('movie')).toBe(true);
    net.on('GET', ME_URL, me({ admin: true, movie: [40, 10], tv: [40, 10] }));
    await M.refreshMe();
    expect(M.quotaFull('movie')).toBe(false);
    expect(M.quotaFull('tv')).toBe(false);
  });

  it('a stale answer (state error) still counts — the last thing the server said', async () => {
    net.on('GET', ME_URL, me({ tv: [10, 10] }));
    await M.refreshMe();
    net.on('GET', ME_URL, net.status(500));
    await M.refreshMe();
    expect(M.ME.state).toBe('error');
    expect(M.quotaFull('tv')).toBe(true);
  });

  it('quotaLine: "10/10 movies", "3/10 shows", singular for a limit of one; an admin just the count', async () => {
    net.on('GET', ME_URL, me({ movie: [10, 10], tv: [3, 10] }));
    await M.refreshMe();
    expect(M.quotaLine('movie')).toBe('10/10 movies');
    expect(M.quotaLine('tv')).toBe('3/10 shows');
    M.ME.me.quota.movie = { used: 1, limit: 1 };
    M.ME.me.quota.tv = { used: 0, limit: 1 };
    expect(M.quotaLine('movie')).toBe('1/1 movie');
    expect(M.quotaLine('tv')).toBe('0/1 show');
    net.on('GET', ME_URL, me({ admin: true, movie: [1, 0], tv: [12, 0] }));
    await M.refreshMe();
    expect(M.quotaLine('movie')).toBe('1 movie');
    expect(M.quotaLine('tv')).toBe('12 shows');
  });

  it('quotaSummary: both kinds for a normal user, "Admin · no limit" for an admin, "" without an answer', async () => {
    expect(M.quotaSummary()).toBe('');
    net.on('GET', ME_URL, me({ movie: [3, 10], tv: [2, 10] }));
    await M.refreshMe();
    expect(M.quotaSummary()).toBe('3 of 10 movies · 2 of 10 shows');
    M.ME.me.quota.movie = { used: 1, limit: 1 };
    expect(M.quotaSummary()).toBe('1 of 1 movie · 2 of 10 shows');
    net.on('GET', ME_URL, me({ admin: true }));
    await M.refreshMe();
    expect(M.quotaSummary()).toBe('Admin · no limit');
  });

  it('quotaFromError: the 409 body patches the quota and makes the toast', async () => {
    net.on('GET', ME_URL, me({ movie: [9, 10] }));
    await M.refreshMe();
    const e = Object.assign(new Error('You already have 10 of 10 movies.'), {
      status: 409,
      code: 'quota_exceeded',
      body: { error: 'quota_exceeded', detail: 'You already have 10 of 10 movies.', type: 'movie', used: 10, limit: 10 }
    });
    expect(M.quotaFromError(e)).toBe('Quota full (10/10 movies) — delete one in My library to add another');
    expect(M.ME.me.quota.movie).toEqual({ used: 10, limit: 10 });
    expect(M.quotaFull('movie')).toBe(true);
  });

  it('quotaFromError without an answer yet, a limit of 0 or a body without numbers: the server’s sentence', () => {
    const body = { error: 'quota_exceeded', detail: 'You already have 10 of 10 shows. Delete one in My library to add another.', type: 'tv', used: 10, limit: 10 };
    const e = Object.assign(new Error(body.detail), { status: 409, code: 'quota_exceeded', body });
    expect(M.quotaFromError(e)).toBe('Quota full (10/10 shows) — delete one in My library to add another');
    expect(M.ME.me).toBeNull();
    const off = Object.assign(new Error('Adding movies is turned off for your account.'), {
      status: 409, code: 'quota_exceeded', body: { error: 'quota_exceeded', detail: 'Adding movies is turned off for your account.', type: 'movie', used: 0, limit: 0 }
    });
    expect(M.quotaFromError(off)).toBe('Adding movies is turned off for your account.');
    const bare = Object.assign(new Error('full'), { status: 409, code: 'quota_exceeded', body: null });
    expect(M.quotaFromError(bare)).toBe('full');
  });

  it('noteAdded: used + 1 at once (no answer: nothing to patch)', async () => {
    M.noteAdded('movie');
    expect(M.ME.me).toBeNull();
    net.on('GET', ME_URL, me({ movie: [3, 10] }));
    await M.refreshMe();
    M.noteAdded('movie');
    expect(M.ME.me.quota.movie.used).toBe(4);
  });
});

describe('deleteTitle', () => {
  const DEL_DUNE = TEST_MEDIALIB + '/api/library/movie/693134?delete_files=true';

  beforeEach(async () => {
    net.on('GET', ME_URL, me());
    await M.refreshMe();
  });

  it('DELETE …?delete_files=true; the row and its slot go at once, then /api/me is asked again', async () => {
    let during;
    net.on('DELETE', DEL_DUNE, () => {
      during = { ...M.deleting };
      return { id: '693134', type: 'movie', title: 'Dune', status: 'deleted', downloads_removed: 0 };
    });
    net.on('GET', ME_URL, me({ movie: [2, 10], titles: [silo] }));
    L.adds['movie:693134'] = 'added';
    const n0 = net.callsTo(ME_URL).length;
    expect(await M.deleteTitle(M.ME.me.titles[0])).toBe(true);
    expect(during).toEqual({ 'movie:693134': true });
    expect(net.callsTo(DEL_DUNE, 'DELETE')).toHaveLength(1);
    expect(M.deleting).toEqual({});
    expect(M.ME.me.titles.map((t) => t.id)).toEqual(['403245']);
    expect(M.ME.me.quota.movie.used).toBe(2);
    expect(toastMsg()).toBe('Deleted “Dune”');
    expect(L.adds['movie:693134']).toBe('idle');
    await flushPromises();
    expect(net.callsTo(ME_URL).length).toBe(n0 + 1);
  });

  it('a second press while it runs sends nothing', async () => {
    net.on('DELETE', DEL_DUNE, { id: '693134', type: 'movie', title: 'Dune', status: 'deleted', downloads_removed: 0 }, { delay: 20 });
    const t = M.ME.me.titles[0];
    const a = M.deleteTitle(t);
    expect(await M.deleteTitle(t)).toBe(false);
    await a;
    expect(net.callsTo(DEL_DUNE, 'DELETE')).toHaveLength(1);
  });

  it('drops the title’s cached metadata', async () => {
    let n = 0;
    net.on('GET', TEST_MEDIALIB + '/api/metadata/movie/693134', () => ({ n: ++n }));
    net.on('DELETE', DEL_DUNE, { id: '693134', type: 'movie', title: 'Dune', status: 'deleted', downloads_removed: 0 });
    await ML.mlMetadata('movie', '693134');
    await M.deleteTitle(M.ME.me.titles[0]);
    await ML.mlMetadata('movie', '693134');
    expect(n).toBe(2);
  });

  it('404: already gone — the same as a success', async () => {
    net.on('DELETE', DEL_DUNE, net.status(404, { error: 'not_found', detail: 'x' }));
    expect(await M.deleteTitle(M.ME.me.titles[0])).toBe(true);
    expect(toastMsg()).toBe('Already gone — “Dune”');
    expect(M.ME.me.titles.map((t) => t.id)).toEqual(['403245']);
  });

  it.each([
    ['403 not_owner', 403, { error: 'not_owner', detail: 'Only the person who added “Dune” can delete it.' }, 'Only the person who added “Dune” can delete it.'],
    ['409 importing', 409, { error: 'importing', detail: '“Dune” is being imported right now — try again in a minute.' }, '“Dune” is being imported right now — try again in a minute.'],
    ['503', 503, { error: 'temporarily_unavailable', detail: 'x' }, 'Library busy — try again in a moment'],
    ['500', 500, { detail: 'boom' }, 'Couldn’t delete: boom']
  ])('%s: the row stays and un-dims, the server says why', async (_, code, body, msg) => {
    net.on('DELETE', DEL_DUNE, net.status(code, body));
    expect(await M.deleteTitle(M.ME.me.titles[0])).toBe(false);
    expect(M.deleting).toEqual({});
    expect(M.ME.me.titles).toHaveLength(2);
    expect(M.ME.me.quota.movie.used).toBe(3);
    expect(toastMsg()).toBe(msg);
  });

  it('unreachable: "Library busy"', async () => {
    net.on('DELETE', DEL_DUNE, net.networkError());
    expect(await M.deleteTitle(M.ME.me.titles[0])).toBe(false);
    expect(toastMsg()).toBe('Library busy — try again in a moment');
  });
});

describe('edges', () => {
  it('quotaWords: "3 of 10 movies", "1 of 1 show", an admin just the count, "" without an answer', async () => {
    expect(M.quotaWords('movie')).toBe('');
    net.on('GET', ME_URL, me({ movie: [3, 10], tv: [1, 1] }));
    await M.refreshMe();
    expect(M.quotaWords('movie')).toBe('3 of 10 movies');
    expect(M.quotaWords('tv')).toBe('1 of 1 show');
    net.on('GET', ME_URL, me({ admin: true, movie: [1, 0], tv: [0, 0] }));
    await M.refreshMe();
    expect(M.quotaWords('movie')).toBe('1 movie');
    expect(M.quotaWords('tv')).toBe('0 shows');
  });

  it('quotaLine without an answer is empty', () => {
    expect(M.quotaLine('movie')).toBe('');
    expect(M.quotaToast('tv')).toBe('Quota full () — delete one in My library to add another');
  });

  it('a failure of a request older than a local change leaves the state alone', async () => {
    net.on('GET', ME_URL, me());
    await M.refreshMe();
    let fail;
    net.once('GET', ME_URL, () => new Promise((r) => (fail = () => r(net.status(500)))));
    const p = M.refreshMe();
    await flushPromises();
    M.noteAdded('movie');
    fail();
    await p;
    expect(M.ME.state).toBe('ok');
    expect(M.ME.me.quota.movie.used).toBe(4);
  });

  it('a delete of a title the list doesn’t have (or without any answer) still works', async () => {
    net.on('DELETE', () => true, { id: '1', type: 'movie', title: 'X', status: 'deleted', downloads_removed: 0 });
    net.on('GET', ME_URL, net.status(500));
    expect(await M.deleteTitle({ ...dune, id: '1', title: 'X' })).toBe(true);
    expect(toastMsg()).toBe('Deleted “X”');
    await flushPromises(); // its own refresh (a 500) settles first
    net.on('GET', ME_URL, me({ movie: [0, 10] }));
    await M.refreshMe();
    expect(await M.deleteTitle({ ...dune, id: '2', title: 'Y' })).toBe(true);
    expect(M.ME.me.titles).toHaveLength(2);
    expect(M.ME.me.quota.movie.used).toBe(0);
    M.ME.me.titles.push({ ...dune, id: '3' });
    expect(await M.deleteTitle({ ...dune, id: '3' })).toBe(true);
    expect(M.ME.me.quota.movie.used).toBe(0); // never below 0
    expect(M.titleKey(dune)).toBe('movie:693134');
  });
});

/* The words both apps show for a title (TV MyLibraryMenu, phone MyLibrary):
 * the server's status, or — on the phone, where the page stays up while the
 * download runs — the live activity group's, plus the confirmation text. */
describe('titleStatus / deleteMessage', () => {
  it('each status in words; downloading with its percentage; a running delete wins', () => {
    const at = (status, progress = null) => M.titleStatus({ ...dune, status, progress });
    expect(at('downloading', 0.426)).toBe('Downloading · 43%');
    expect(at('downloading')).toBe('Downloading');
    expect(at('queued')).toBe('Queued');
    expect(at('importing')).toBe('Importing');
    expect(at('paused')).toBe('Paused');
    expect(at('warning')).toBe('Needs attention');
    expect(at('waiting')).toBe('Waiting for a release');
    expect(at('in_library')).toBe('In your library');
    expect(at('something-new')).toBe('something-new');
    M.deleting[M.titleKey(dune)] = true;
    expect(at('downloading', 0.5)).toBe('Deleting…');
  });

  it('a live activity group overrides the server’s snapshot', () => {
    const t = { ...dune, status: 'downloading', progress: 0.1 };
    expect(M.titleStatus(t, { status: 'downloading', progress: 0.77 })).toBe('Downloading · 77%');
    expect(M.titleStatus(t, { status: 'importing', progress: 1 })).toBe('Importing');
    expect(M.titleStatus({ ...dune, status: 'waiting' }, { status: 'queued', progress: 0 })).toBe('Queued');
    expect(M.titleStatus(t, null)).toBe('Downloading · 10%');
  });

  it('deleteMessage: the film / the show, for everyone, can’t be undone', () => {
    expect(M.deleteMessage('movie')).toBe('The film and its files are deleted from the server — for everyone. This can’t be undone.');
    expect(M.deleteMessage('tv')).toBe('The show, every season and all its files are deleted from the server — for everyone. This can’t be undone.');
  });
});
