/* lookup.svelte.js under ownership and quotas (run/design.md §6.1, §10):
 * - a normal user at the limit (as GET /api/me last said) gets a toast and no
 *   request at all;
 * - the server's 409 quota_exceeded is NOT "already added" (the old blanket
 *   `status === 409` read it that way): the state goes back to idle and the
 *   quota is patched from the body;
 * - 409 being_deleted: idle + the server's sentence;
 * - a code-less 409 (an older backend) still means "already added";
 * - an add counts at once (noteAdded) and /api/me is asked again;
 * - undo 403 not_owner: the server's sentence. */
import { describe, it, expect, beforeEach } from 'vitest';
import { freshImport, TEST_MEDIALIB } from '../helpers/modules.js';
import { mockFetch } from '../helpers/fetch.js';
import { flushPromises } from '../helpers/time.js';

const ADD = TEST_MEDIALIB + '/api/library';
const ME_URL = TEST_MEDIALIB + '/api/me';
let L, M, T, net;

beforeEach(async () => {
  ({ L, M, T } = await freshImport({
    modules: { L: 'src/lib/lookup.svelte.js', M: 'src/lib/me.svelte.js', T: 'src/lib/toast.svelte.js' }
  }));
  net = mockFetch();
});

const dune = { id: '693134', type: 'movie', title: 'Dune: Part Two', year: 2024, added: false };
const silo = { id: '403245', type: 'tv', title: 'Silo', year: 2023, added: false };
const toastMsg = () => T.toastState.msg;
const quota = (movie, tv, admin = false) => ({
  user: { id: 'u1', name: 'nicole' },
  admin,
  quota: { movie: { used: movie[0], limit: admin ? null : movie[1] }, tv: { used: tv[0], limit: admin ? null : tv[1] } },
  titles: []
});
const added = (it) => ({ id: it.id, type: it.type, title: it.title, status: 'added', undo: 'tok-1' });

describe('addToLibrary at the quota', () => {
  it('full (per /api/me): a toast, no request, the state stays idle', async () => {
    net.on('GET', ME_URL, quota([3, 10], [10, 10]));
    await M.refreshMe();
    await L.addToLibrary(silo);
    expect(net.callsTo(ADD)).toHaveLength(0);
    expect(L.addState(silo)).toBe('idle');
    expect(toastMsg()).toBe('Quota full (10/10 shows) — delete one in My library to add another');
  });

  it('the other kind still adds; it counts at once and /api/me is asked again', async () => {
    net.on('GET', ME_URL, quota([3, 10], [10, 10]));
    await M.refreshMe();
    net.on('POST', ADD, added(dune));
    net.on('GET', ME_URL, quota([4, 10], [10, 10]));
    const p = L.addToLibrary(dune);
    await p;
    expect(L.addState(dune)).toBe('done');
    expect(M.ME.me.quota.movie.used).toBe(4);
    await flushPromises();
    expect(net.callsTo(ME_URL)).toHaveLength(2);
  });

  it('an admin is never full', async () => {
    net.on('GET', ME_URL, quota([50, 0], [50, 0], true));
    await M.refreshMe();
    net.on('POST', ADD, added(dune));
    await L.addToLibrary(dune);
    expect(L.addState(dune)).toBe('done');
  });

  it('no /api/me answer (never asked, or an old backend): no client-side check, no extra request', async () => {
    net.on('POST', ADD, added(dune));
    await L.addToLibrary(dune);
    expect(L.addState(dune)).toBe('done');
    expect(net.callsTo(ME_URL)).toHaveLength(0);
    net.on('GET', ME_URL, net.status(404, { detail: 'Not Found' }));
    await M.refreshMe();
    net.on('POST', ADD, added(silo));
    await L.addToLibrary(silo);
    await flushPromises();
    expect(L.addState(silo)).toBe('done');
    expect(net.callsTo(ME_URL)).toHaveLength(1);
  });

  it('409 quota_exceeded from the server: idle (not "added"), the quota patched from the body, the quota toast', async () => {
    net.on('GET', ME_URL, quota([9, 10], [0, 10]));
    await M.refreshMe();
    net.on('POST', ADD, net.status(409, { error: 'quota_exceeded', detail: 'You already have 10 of 10 movies. Delete one in My library to add another.', type: 'movie', used: 10, limit: 10 }));
    net.on('GET', ME_URL, quota([10, 10], [0, 10]));
    await L.addToLibrary(dune);
    expect(L.addState(dune)).toBe('idle');
    expect(L.inLibrary(dune)).toBe(false);
    expect(toastMsg()).toBe('Quota full (10/10 movies) — delete one in My library to add another');
    expect(M.quotaFull('movie')).toBe(true);
    await flushPromises();
    expect(net.callsTo(ME_URL)).toHaveLength(2);
  });

  it('409 being_deleted: idle, the server’s sentence', async () => {
    net.on('POST', ADD, net.status(409, { error: 'being_deleted', detail: '“Dune: Part Two” is being deleted right now — add it again in a minute.' }));
    await L.addToLibrary(dune);
    expect(L.addState(dune)).toBe('idle');
    expect(toastMsg()).toBe('“Dune: Part Two” is being deleted right now — add it again in a minute.');
  });

  it('a code-less 409 (an older backend) and already_added still mean "already in the library"', async () => {
    net.on('POST', ADD, net.status(409, { detail: 'exists' }));
    await L.addToLibrary(dune);
    expect(L.addState(dune)).toBe('added');
    net.on('POST', ADD, net.status(409, { error: 'already_added', detail: 'x' }));
    await L.addToLibrary(silo);
    expect(L.addState(silo)).toBe('added');
    expect(toastMsg()).toBe('Already in your library — “Silo”');
  });

  it('a 409 with another code is a failure, not "added"', async () => {
    net.on('POST', ADD, net.status(409, { error: 'conflict', detail: 'Something else' }));
    await L.addToLibrary(dune);
    expect(L.addState(dune)).toBe('error');
    expect(toastMsg()).toBe('Add failed: Something else');
  });
});

describe('undo of someone else’s add', () => {
  it('403 not_owner: stays done, the server’s sentence', async () => {
    L.adds[L.lookupKey(dune)] = 'done';
    net.on('DELETE', TEST_MEDIALIB + '/api/library/movie/693134?undo=t1', net.status(403, { error: 'not_owner', detail: 'Only the person who added “Dune: Part Two” can undo that.' }));
    await L.undoAdd(dune, 't1');
    expect(L.addState(dune)).toBe('done');
    expect(toastMsg()).toBe('Only the person who added “Dune: Part Two” can undo that.');
  });

  it('an undo frees the slot: /api/me is asked again', async () => {
    net.on('GET', ME_URL, quota([10, 10], [0, 10]));
    await M.refreshMe();
    L.adds[L.lookupKey(dune)] = 'done';
    net.on('DELETE', TEST_MEDIALIB + '/api/library/movie/693134?undo=t1', { id: '693134', type: 'movie', title: 'Dune: Part Two', status: 'removed', downloads_removed: 0 });
    net.on('GET', ME_URL, quota([9, 10], [0, 10]));
    await L.undoAdd(dune, 't1');
    await flushPromises();
    expect(M.ME.me.quota.movie.used).toBe(9);
  });
});
