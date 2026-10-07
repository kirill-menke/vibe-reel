/* api.js: the opt-in prefetch / stale-while-revalidate layer.
 *
 * CLAUDE.md: parked prefetches expire after 30 s and the SWR store is
 * LRU-capped at 24 paths AND 800 Items in total (the newest entry is always
 * kept) — both used to grow for the whole session. A big grid can evict Home's
 * rails, by design. invalidate() matches the full request path by prefix. The
 * store and the parked map are module state, so every test imports a fresh
 * api.js (freshImport). */
import { describe, it, expect, beforeEach } from 'vitest';
import { freshImport } from '../helpers/modules.js';
import { mockFetch } from '../helpers/fetch.js';
import { useClock } from '../helpers/time.js';

let api, net, n;

beforeEach(async () => {
  ({ api } = await freshImport({ modules: { api: 'src/lib/api.js' } }));
  net = mockFetch();
  n = 0;
  // every answer is distinct, so a test can tell which request produced it
  net.on('GET', () => true, (req) => ({ path: req.path + req.query, n: ++n, Items: [] }));
});

const callsTo = (p) => net.calls.filter((c) => c.path + c.query === p).length;
const items = (k) => ({ Items: Array.from({ length: k }, (_, i) => ({ Id: 'i' + i })) });

describe('prefetch()', () => {
  it('parks one promise per path: a second prefetch reuses it', async () => {
    const a = api.prefetch('/Items/a');
    const b = api.prefetch('/Items/a');
    expect(b).toBe(a);
    await a;
    expect(callsTo('/Items/a')).toBe(1);
  });

  it('the next plain GET consumes it once, the one after that goes out again', async () => {
    const warm = api.prefetch('/Items/a');
    const first = api.api('/Items/a');
    expect(first).toBe(warm);
    expect((await first).n).toBe(1);
    const second = await api.api('/Items/a');
    expect(second.n).toBe(2);
    expect(callsTo('/Items/a')).toBe(2);
  });

  it('only stands in for the exact path', async () => {
    api.prefetch('/Items/a');
    await api.api('/Items/a?x=1');
    expect(callsTo('/Items/a')).toBe(1);
    expect(callsTo('/Items/a?x=1')).toBe(1);
  });

  it('a body, a custom method or a signal bypasses the warm (and leaves it parked)', async () => {
    net.on('POST', () => true, { posted: true });
    const warm = api.prefetch('/Items/a');
    await warm;
    expect(await api.api('/Items/a', { method: 'POST' })).toEqual({ posted: true });
    const withBody = await api.api('/Items/a', { body: { x: 1 } }); // a GET with a body still goes out
    expect(withBody.n).toBe(2);
    const ac = new AbortController();
    const viaSignal = await api.api('/Items/a', { signal: ac.signal });
    expect(viaSignal.n).toBe(3);
    // the warm is still there for a plain GET
    expect(api.api('/Items/a')).toBe(warm);
    expect(net.calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET', 'GET']);
  });

  it('an expired warm (30 s) is not served', async () => {
    const clock = useClock();
    const warm = api.prefetch('/Items/a');
    await clock.tick(29999);
    expect(api.prefetch('/Items/a')).toBe(warm); // still fresh
    await clock.tick(1);
    const fresh = api.api('/Items/a');
    expect(fresh).not.toBe(warm);
    expect((await fresh).n).toBe(2);
    // consumed (deleted) even though it was not served
    expect((await api.api('/Items/a')).n).toBe(3);
  });

  it('prefetching an expired path starts a new request', async () => {
    const clock = useClock();
    const warm = api.prefetch('/Items/a');
    await clock.tick(30000);
    const again = api.prefetch('/Items/a');
    expect(again).not.toBe(warm);
    expect((await again).n).toBe(2);
    expect(api.api('/Items/a')).toBe(again);
  });

  it('expired warms of other paths are swept by the next prefetch (never served afterwards)', async () => {
    const clock = useClock();
    api.prefetch('/Items/a');
    await clock.tick(30000);
    api.prefetch('/Items/b');
    expect((await api.api('/Items/a')).n).toBe(3);
    expect((await api.api('/Items/b')).n).toBe(2);
  });

  it('a rejected prefetch is never served to the real caller', async () => {
    net.once('GET', '/Items/bad', net.status(500));
    const warm = api.prefetch('/Items/bad');
    const err = await warm.catch((e) => e);
    expect(err.status).toBe(500);
    const real = await api.api('/Items/bad');
    expect(real.n).toBe(1);
    expect(callsTo('/Items/bad')).toBe(2);
  });

  it('a network-failed prefetch is dropped too', async () => {
    net.once('GET', '/Items/bad', net.networkError());
    await api.prefetch('/Items/bad').catch(() => {});
    expect((await api.prefetch('/Items/bad')).n).toBe(1);
    expect(callsTo('/Items/bad')).toBe(2);
  });
});

describe('revalidate() / cached()', () => {
  it('cached() misses before, revalidate() stores the answer and returns it', async () => {
    expect(api.cached('/UserItems/Resume')).toBe(null);
    const d = await api.revalidate('/UserItems/Resume');
    expect(d.n).toBe(1);
    expect(api.cached('/UserItems/Resume')).toBe(d);
  });

  it('a newer revalidation replaces the entry', async () => {
    await api.revalidate('/p');
    await api.revalidate('/p');
    expect(api.cached('/p').n).toBe(2);
  });

  it('a failed revalidation keeps the previous answer and rejects', async () => {
    const d = await api.revalidate('/p');
    net.once('GET', '/p', net.status(503));
    await expect(api.revalidate('/p')).rejects.toMatchObject({ status: 503 });
    expect(api.cached('/p')).toBe(d);
  });

  it('passes opts through to api()', async () => {
    const ac = new AbortController();
    await api.revalidate('/p', { signal: ac.signal });
    expect(net.calls[0].signal).toBe(ac.signal);
  });

  it('cached(path, maxAge) misses once the entry is older than maxAge', async () => {
    const clock = useClock();
    const d = await api.revalidate('/p');
    await clock.tick(5000);
    expect(api.cached('/p', 5000)).toBe(d);
    expect(api.cached('/p', 4999)).toBe(null);
    expect(api.cached('/p')).toBe(d);
    expect(api.cached('/p', 0)).toBe(d); // 0 = no limit
  });
});

describe('store bounds', () => {
  it('is LRU-capped at 24 paths: the oldest revalidation is evicted first', async () => {
    for (let i = 0; i < 25; i++) await api.revalidate('/p' + i);
    expect(api.cached('/p0')).toBe(null);
    for (let i = 1; i < 25; i++) expect(api.cached('/p' + i)).not.toBe(null);
  });

  it('24 paths fit', async () => {
    for (let i = 0; i < 24; i++) await api.revalidate('/p' + i);
    expect(api.cached('/p0')).not.toBe(null);
  });

  it('re-revalidating a path moves it to the young end', async () => {
    for (let i = 0; i < 24; i++) await api.revalidate('/p' + i);
    await api.revalidate('/p0');
    await api.revalidate('/p24');
    expect(api.cached('/p0')).not.toBe(null);
    expect(api.cached('/p1')).toBe(null);
  });

  it('cached() reads do not refresh the LRU position', async () => {
    for (let i = 0; i < 24; i++) await api.revalidate('/p' + i);
    api.cached('/p0');
    await api.revalidate('/p24');
    expect(api.cached('/p0')).toBe(null);
  });

  it('is capped at 800 Items in total, oldest first', async () => {
    net.on('GET', '/a', items(500));
    net.on('GET', '/b', items(300));
    net.on('GET', '/c', items(1));
    await api.revalidate('/a');
    await api.revalidate('/b');
    expect(api.cached('/a')).not.toBe(null); // exactly 800
    await api.revalidate('/c');
    expect(api.cached('/a')).toBe(null);
    expect(api.cached('/b')).not.toBe(null);
    expect(api.cached('/c')).not.toBe(null);
  });

  it('evicts as many old entries as needed', async () => {
    net.on('GET', '/s1', items(300));
    net.on('GET', '/s2', items(300));
    net.on('GET', '/s3', items(100));
    net.on('GET', '/big', items(600));
    for (const p of ['/s1', '/s2', '/s3', '/big']) await api.revalidate(p);
    expect(['/s1', '/s2', '/s3', '/big'].map((p) => api.cached(p) !== null)).toEqual([false, false, true, true]);
  });

  it('the newest entry always stays, even alone above the cap', async () => {
    net.on('GET', '/small', items(10));
    net.on('GET', '/huge', items(1000));
    await api.revalidate('/small');
    await api.revalidate('/huge');
    expect(api.cached('/small')).toBe(null);
    expect(api.cached('/huge').Items).toHaveLength(1000);
  });

  it('a plain array answer counts its length; anything else counts 0', async () => {
    net.on('GET', '/arr', Array.from({ length: 700 }, (_, i) => ({ Id: 'x' + i })));
    net.on('GET', '/obj', { Name: 'no items' });
    net.on('GET', '/none', null);
    net.on('GET', '/more', items(150));
    await api.revalidate('/arr');
    await api.revalidate('/obj');
    await api.revalidate('/none');
    expect(api.cached('/arr')).not.toBe(null);
    await api.revalidate('/more'); // 700 + 150 > 800 → /arr goes
    expect(api.cached('/arr')).toBe(null);
    expect(api.cached('/obj')).toEqual({ Name: 'no items' });
    expect(api.cached('/more')).not.toBe(null);
  });

  it('a big grid can evict Home rails (by design)', async () => {
    net.on('GET', '/UserItems/Resume', items(20));
    net.on('GET', '/Items?grid=378', items(790));
    await api.revalidate('/UserItems/Resume');
    await api.revalidate('/Items?grid=378');
    expect(api.cached('/UserItems/Resume')).toBe(null);
  });
});

describe('invalidate()', () => {
  it('drops stored entries by full-path prefix; /UserItems/Resume does not touch /Items?…', async () => {
    await api.revalidate('/UserItems/Resume?userId=u1');
    await api.revalidate('/Items?userId=u1&Sort=x');
    await api.revalidate('/Items/abc?userId=u1');
    api.invalidate('/UserItems/Resume');
    expect(api.cached('/UserItems/Resume?userId=u1')).toBe(null);
    expect(api.cached('/Items?userId=u1&Sort=x')).not.toBe(null);
    api.invalidate('/Items/abc?');
    expect(api.cached('/Items/abc?userId=u1')).toBe(null);
    expect(api.cached('/Items?userId=u1&Sort=x')).not.toBe(null);
  });

  it('accepts an array of prefixes', async () => {
    for (const p of ['/UserItems/Resume', '/Shows/NextUp?x', '/Items/Latest', '/Other']) await api.revalidate(p);
    api.invalidate(['/UserItems/Resume', '/Shows/NextUp', '/Items/Latest']);
    expect(['/UserItems/Resume', '/Shows/NextUp?x', '/Items/Latest', '/Other'].map((p) => api.cached(p) !== null)).toEqual([false, false, false, true]);
  });

  it('drops parked prefetches too', async () => {
    const warm = api.prefetch('/Items/abc?userId=u1');
    await warm;
    api.invalidate('/Items/abc');
    const real = api.api('/Items/abc?userId=u1');
    expect(real).not.toBe(warm);
    expect((await real).n).toBe(2);
  });

  it('an unmatched prefix changes nothing', async () => {
    await api.revalidate('/p');
    const warm = api.prefetch('/q');
    api.invalidate('/zzz');
    api.invalidate([]);
    expect(api.cached('/p')).not.toBe(null);
    expect(api.api('/q')).toBe(warm);
  });
});

describe('seedStore() / storeEntries() — the phone Home snapshot', () => {
  const saved = [
    ['/UserItems/Resume', { at: 1000, data: { Items: [{ Id: 'r1' }] } }],
    ['/Shows/NextUp', { at: 2000, data: { Items: [{ Id: 'n1' }] } }]
  ];

  if (!__PHONE__) {
    it('TV: seedStore is a no-op and storeEntries returns []', async () => {
      api.seedStore(saved);
      expect(api.cached('/UserItems/Resume')).toBe(null);
      await api.revalidate('/p');
      expect(api.storeEntries(['/p'])).toEqual([]);
    });
  } else {
    it('phone: seeded entries paint through cached() with their old time', async () => {
      const clock = useClock({ start: 10000 });
      api.seedStore(saved);
      expect(api.cached('/UserItems/Resume')).toEqual({ Items: [{ Id: 'r1' }] });
      expect(api.cached('/UserItems/Resume', 9000)).toEqual({ Items: [{ Id: 'r1' }] });
      expect(api.cached('/UserItems/Resume', 8999)).toBe(null);
      expect(clock.now()).toBe(10000);
    });

    it('phone: storeEntries returns [path, {at, data}] for stored paths only', async () => {
      const clock = useClock({ start: 50000 });
      api.seedStore(saved.slice(0, 1));
      const d = await api.revalidate('/p');
      expect(api.storeEntries(['/UserItems/Resume', '/missing', '/p'])).toEqual([
        ['/UserItems/Resume', { at: 1000, data: { Items: [{ Id: 'r1' }] } }],
        ['/p', { at: 50000, data: d }]
      ]);
      expect(clock.now()).toBe(50000);
    });

    it('phone: a path answered this session wins over a seeded one', async () => {
      const live = await api.revalidate('/UserItems/Resume');
      api.seedStore(saved);
      expect(api.cached('/UserItems/Resume')).toBe(live);
      expect(api.cached('/Shows/NextUp')).toEqual({ Items: [{ Id: 'n1' }] });
    });

    it('phone: a live answer replaces a seeded one', async () => {
      api.seedStore(saved);
      const live = await api.revalidate('/UserItems/Resume');
      expect(api.cached('/UserItems/Resume')).toBe(live);
    });

    it('phone: malformed entries are skipped, a bad time reads as 0', async () => {
      useClock({ start: 100 });
      api.seedStore([
        [42, { at: 1, data: { Items: [] } }],
        ['/nodata', { at: 1 }],
        ['/null', null],
        ['/badtime', { at: 'yesterday', data: { Items: [{ Id: 'b' }] } }]
      ]);
      api.seedStore(null);
      expect(api.cached('/nodata')).toBe(null);
      expect(api.cached('/null')).toBe(null);
      expect(api.storeEntries(['/badtime'])).toEqual([['/badtime', { at: 0, data: { Items: [{ Id: 'b' }] } }]]);
      expect(api.cached('/badtime', 100)).not.toBe(null);
      expect(api.cached('/badtime', 99)).toBe(null);
    });
  }
});
