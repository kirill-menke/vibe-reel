/* phone/src/lib/mylib.js: My library's phone glue (run/design.md §7).
 *
 * askDelete(t): the iOS action sheet confirms first ("Delete “Dune”?", the
 * shared deleteMessage, a red Delete and Keep); Keep/scrim send nothing,
 * Delete runs me.svelte.js's deleteTitle (DELETE …?delete_files=true). A row
 * whose delete already runs asks nothing.
 *
 * meAtBoot(): one GET /api/me a moment after boot (the tiles' quick "+" then
 * knows the quota), never twice, nothing while signed out.
 *
 * Phone project only (confirm.svelte.js is the phone's). */
import { describe, it, expect, beforeEach } from 'vitest';
import { freshImport, TEST_MEDIALIB } from '../helpers/modules.js';
import { mockFetch } from '../helpers/fetch.js';
import { useClock, flushPromises } from '../helpers/time.js';

const ME_URL = TEST_MEDIALIB + '/api/me';
const dune = { type: 'movie', id: '693134', title: 'Dune', year: 2021, poster: null, added_at: '2026-10-05T12:00:00Z', status: 'in_library', progress: null, has_files: true };
const silo = { type: 'tv', id: '403245', title: 'Silo', year: 2023, poster: null, added_at: '2026-10-05T11:00:00Z', status: 'downloading', progress: 0.43, has_files: false };
const me = () => ({
  user: { id: 'u1', name: 'nicole' },
  admin: false,
  quota: { movie: { used: 3, limit: 10 }, tv: { used: 1, limit: 10 } },
  titles: [{ ...dune }, { ...silo }]
});

let L, C, M, net;
async function load(opts = {}) {
  ({ L, C, M } = await freshImport({
    ...opts,
    modules: { L: 'phone/src/lib/mylib.js', C: 'phone/src/lib/confirm.svelte.js', M: 'src/lib/me.svelte.js' }
  }));
  net = mockFetch();
}
const deletes = () => net.calls.filter((c) => c.method === 'DELETE');

describe('askDelete', () => {
  beforeEach(() => load());

  it('asks first: the title, the shared message, a red Delete and Keep', async () => {
    const p = L.askDelete(silo);
    const q = C.CONFIRM.req;
    expect(q).toMatchObject({
      title: 'Delete “Silo”?',
      message: M.deleteMessage('tv'),
      action: 'Delete',
      danger: true,
      cancel: 'Keep'
    });
    C.answer(false);
    expect(await p).toBe(false);
    expect(deletes()).toEqual([]);
  });

  it('Delete → one DELETE …?delete_files=true; the row leaves the list', async () => {
    net.on('GET', ME_URL, me());
    await M.refreshMe();
    net.on('DELETE', TEST_MEDIALIB + '/api/library/movie/693134?delete_files=true', { id: '693134', type: 'movie', title: 'Dune', status: 'deleted', downloads_removed: 0 });
    const p = L.askDelete(dune);
    C.answer(true);
    expect(await p).toBe(true);
    expect(deletes().map((c) => c.url)).toEqual([TEST_MEDIALIB + '/api/library/movie/693134?delete_files=true']);
    expect(M.ME.me.titles.map((t) => t.id)).toEqual(['403245']);
    expect(M.ME.me.quota.movie.used).toBe(2);
  });

  it('a row whose delete already runs: no second question, nothing sent', async () => {
    M.deleting[M.titleKey(dune)] = true;
    expect(await L.askDelete(dune)).toBe(false);
    expect(C.CONFIRM.req).toBeNull();
    expect(deletes()).toEqual([]);
  });
});

describe('meAtBoot', () => {
  it('one GET /api/me after the delay, never twice', async () => {
    await load();
    const clock = useClock();
    net.on('GET', ME_URL, me());
    L.meAtBoot();
    L.meAtBoot();
    expect(net.callsTo(ME_URL)).toHaveLength(0); // not on the boot path itself
    await clock.tick(2000);
    await flushPromises();
    expect(net.callsTo(ME_URL)).toHaveLength(1);
    expect(M.ME.state).toBe('ok');
    L.meAtBoot();
    await clock.tick(5000);
    expect(net.callsTo(ME_URL)).toHaveLength(1);
  });

  it('signed out: nothing is sent', async () => {
    await load({ signedIn: false });
    const clock = useClock();
    L.meAtBoot();
    await clock.tick(3000);
    expect(net.calls).toEqual([]);
  });
});
