/* api.js holdReads(): the read-after-write barrier.
 *
 * CLAUDE.md: reportStop() arms it with the Stopped POST, because exit
 * navigates at once and the detail page used to paint the old resume point.
 * While armed (≤ 1.5 s), user-data GETs wait for the write; a hung write never
 * stalls browsing. The barrier is module state → fresh api.js per test. */
import { describe, it, expect, beforeEach } from 'vitest';
import { freshImport } from '../helpers/modules.js';
import { mockFetch } from '../helpers/fetch.js';
import { useClock, flushPromises } from '../helpers/time.js';

let api, net;

beforeEach(async () => {
  ({ api } = await freshImport({ modules: { api: 'src/lib/api.js' } }));
  net = mockFetch();
  net.on(null, () => true, (req) => ({ path: req.path + req.query, method: req.method }));
});

function deferred() {
  let resolve, reject;
  const p = new Promise((a, b) => ((resolve = a), (reject = b)));
  return { p, resolve, reject };
}
const sent = () => net.calls.map((c) => c.method + ' ' + c.path + c.query);

describe('while armed', () => {
  it.each(['/Users/u1/Items/x', '/Shows/s1/Episodes?SeasonId=a', '/UserItems/Resume?userId=u1', '/Items/abc?userId=u1', '/Items?userId=u1&ParentId=p'])(
    'GET %s waits for the write',
    async (path) => {
      const w = deferred();
      api.holdReads(w.p);
      const r = api.api(path);
      await flushPromises();
      expect(net.calls).toHaveLength(0);
      w.resolve();
      expect((await r).path).toBe(path);
      expect(sent()).toEqual(['GET ' + path]);
    }
  );

  it.each(['/System/Info', '/Items', '/ItemsByName', '/Users', '/MediaSegments/x', '/Sessions/Playing', '/Videos/x/stream'])(
    'GET %s goes out at once',
    async (path) => {
      api.holdReads(deferred().p);
      await api.api(path);
      expect(sent()).toEqual(['GET ' + path]);
    }
  );

  it('non-GETs and GETs with a body go out at once', async () => {
    api.holdReads(deferred().p);
    await api.api('/UserPlayedItems/x', { method: 'POST' });
    await api.api('/Items/x', { method: 'DELETE' });
    await api.api('/Users/u1/x', { body: { a: 1 } });
    expect(sent()).toEqual(['POST /UserPlayedItems/x', 'DELETE /Items/x', 'GET /Users/u1/x']);
  });

  it('holdReads returns the write promise itself', () => {
    const w = deferred();
    expect(api.holdReads(w.p)).toBe(w.p);
  });

  it('a held read keeps its opts (signal) when it finally goes out', async () => {
    const w = deferred();
    api.holdReads(w.p);
    const ac = new AbortController();
    const r = api.api('/Items/a', { signal: ac.signal });
    w.resolve();
    await r;
    expect(net.calls[0].signal).toBe(ac.signal);
  });
});

describe('release', () => {
  it('on the write resolving: later reads go out at once', async () => {
    const w = deferred();
    api.holdReads(w.p);
    w.resolve('ok');
    await flushPromises();
    const r = api.api('/Items/a');
    expect(net.calls).toHaveLength(1);
    await r;
  });

  it('on the write rejecting (the held read still goes out, and succeeds)', async () => {
    const w = deferred();
    api.holdReads(w.p).catch(() => {});
    const r = api.api('/Items/a');
    await flushPromises();
    expect(net.calls).toHaveLength(0);
    w.reject(new Error('Stopped failed'));
    expect((await r).path).toBe('/Items/a');
  });

  it('after the 1.5 s cap when the write hangs', async () => {
    const clock = useClock();
    api.holdReads(new Promise(() => {}));
    const r = api.api('/Items/a');
    await clock.tick(1499);
    expect(net.calls).toHaveLength(0);
    await clock.tick(1);
    expect(net.calls).toHaveLength(1);
    await r;
    // and the barrier is gone for good
    api.api('/Items/b');
    expect(net.calls).toHaveLength(2);
  });

  it('honours a custom cap', async () => {
    const clock = useClock();
    api.holdReads(new Promise(() => {}), 200);
    const r = api.api('/Shows/x');
    await clock.tick(199);
    expect(net.calls).toHaveLength(0);
    await clock.tick(1);
    expect(net.calls).toHaveLength(1);
    await r;
  });
});

describe('interplay', () => {
  it('a parked prefetch is still served during the barrier (checked before it)', async () => {
    const warm = api.prefetch('/Items/a');
    await warm;
    api.holdReads(deferred().p);
    const r = api.api('/Items/a');
    expect(r).toBe(warm);
    expect(net.calls).toHaveLength(1);
  });

  it('a newer holdReads replaces the older barrier', async () => {
    const w1 = deferred();
    const w2 = deferred();
    api.holdReads(w1.p);
    const early = api.api('/Items/early');
    api.holdReads(w2.p);
    w1.resolve();
    await flushPromises();
    // the read queued on the first barrier re-checks and now waits for the second
    expect(net.calls).toHaveLength(0);
    const late = api.api('/Items/late');
    await flushPromises();
    expect(net.calls).toHaveLength(0);
    w2.resolve();
    await Promise.all([early, late]);
    expect(sent().sort()).toEqual(['GET /Items/early', 'GET /Items/late']);
  });

  it('the older barrier settling does not clear the newer one', async () => {
    const clock = useClock();
    api.holdReads(new Promise(() => {}), 100);
    await clock.tick(50);
    api.holdReads(new Promise(() => {}), 1000);
    await clock.tick(60); // first cap passed
    api.api('/Items/a');
    await clock.flush();
    expect(net.calls).toHaveLength(0);
    await clock.tick(1000);
    expect(net.calls).toHaveLength(1);
  });
});
