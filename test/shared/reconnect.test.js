/* reconnect.js: onReconnect(fn, { every }).
 *
 * CLAUDE.md (App lifecycle → Getting back on its feet): `onReconnect(fn, {every})`
 * fires on `online` (+1.5 s settle), on hidden→visible (+1 s, after lifecycle's
 * focus repair; `fn` gets the hidden ms) and on an optional timer — never while
 * hidden or in the player. The module comment adds: one subscriber must not
 * stop the others, and the return value is the unsubscribe.
 *
 * Each test imports a fresh graph (module-level subscriber set and listeners);
 * every subscription is undone after the test, so listeners an earlier copy of
 * the module bound fire into an empty set. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { freshImport } from '../helpers/modules.js';
import { useClock } from '../helpers/time.js';

let R, S, clock, vis, offs;

beforeEach(async () => {
  const m = await freshImport({ modules: { reconnect: 'src/lib/reconnect.js', nav: 'src/lib/nav.svelte.js' } });
  R = m.reconnect;
  S = m.nav.S;
  S.screen = 'home';
  clock = useClock();
  vis = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => vis });
  offs = [];
});

afterEach(() => {
  for (const off of offs) off();
  delete document.visibilityState;
});

function sub(fn = vi.fn(), opts) {
  offs.push(R.onReconnect(fn, opts));
  return fn;
}
const online = () => window.dispatchEvent(new Event('online'));
function setVis(v) {
  vis = v;
  document.dispatchEvent(new Event('visibilitychange'));
}

describe("'online'", () => {
  it('fires 1.5 s after the event, to every subscriber', async () => {
    const a = sub();
    const b = sub();
    online();
    await clock.tick(1499);
    expect(a).not.toHaveBeenCalled();
    await clock.tick(1);
    expect(a.mock.calls).toEqual([['online', undefined]]);
    expect(b.mock.calls).toEqual([['online', undefined]]);
  });

  it('nothing fires when the page is hidden or the player is up by the time the settle delay ends', async () => {
    const a = sub();
    online();
    S.screen = 'player';
    await clock.tick(1500);
    expect(a).not.toHaveBeenCalled();
    S.screen = 'home';
    online();
    await clock.tick(1000);
    vis = 'hidden';
    await clock.tick(500);
    expect(a).not.toHaveBeenCalled();
  });
});

describe("'visible'", () => {
  it('hidden → visible fires after 1 s with the hidden time in ms', async () => {
    const a = sub();
    setVis('hidden');
    await clock.tick(42000);
    setVis('visible');
    await clock.tick(999);
    expect(a).not.toHaveBeenCalled();
    await clock.tick(1);
    expect(a.mock.calls).toEqual([['visible', 42000]]);
  });

  it('a visible event without a hidden one before reports 0 ms', async () => {
    const a = sub();
    setVis('visible');
    await clock.tick(1000);
    expect(a.mock.calls).toEqual([['visible', 0]]);
  });

  it('going hidden again within the 1 s settle cancels the fire (checked when it runs)', async () => {
    const a = sub();
    setVis('hidden');
    await clock.tick(5000);
    setVis('visible');
    await clock.tick(500);
    setVis('hidden');
    await clock.tick(1000);
    expect(a).not.toHaveBeenCalled();
  });

  it('not during playback', async () => {
    const a = sub();
    S.screen = 'player';
    setVis('hidden');
    await clock.tick(5000);
    setVis('visible');
    await clock.tick(2000);
    expect(a).not.toHaveBeenCalled();
  });
});

describe("'tick'", () => {
  it('every: fires on the timer, only for that subscriber', async () => {
    const a = sub(vi.fn(), { every: 30000 });
    const b = sub();
    await clock.tick(29999);
    expect(a).not.toHaveBeenCalled();
    await clock.tick(1);
    expect(a.mock.calls).toEqual([['tick']]);
    await clock.tick(60000);
    expect(a).toHaveBeenCalledTimes(3);
    expect(b).not.toHaveBeenCalled();
  });

  it('no timer without every', async () => {
    sub();
    expect(clock.pending()).toBe(0);
  });

  it('the timer is quiet while hidden or in the player', async () => {
    const a = sub(vi.fn(), { every: 10000 });
    vis = 'hidden';
    await clock.tick(30000);
    vis = 'visible';
    S.screen = 'player';
    await clock.tick(30000);
    expect(a).not.toHaveBeenCalled();
    S.screen = 'home';
    await clock.tick(10000);
    expect(a).toHaveBeenCalledTimes(1);
  });
});

describe('unsubscribe and isolation', () => {
  it('the returned function stops the subscription and clears its timer', async () => {
    const a = vi.fn();
    const off = R.onReconnect(a, { every: 10000 });
    expect(clock.pending()).toBe(1);
    off();
    expect(clock.pending()).toBe(0);
    online();
    setVis('visible');
    await clock.tick(60000);
    expect(a).not.toHaveBeenCalled();
    off(); // twice is harmless
  });

  it('a throwing or rejecting subscriber does not stop the others', async () => {
    const boom = sub(vi.fn(() => { throw new Error('boom'); }), { every: 5000 });
    const rej = sub(vi.fn(() => Promise.reject(new Error('nope'))), { every: 5000 });
    const ok = sub();
    online();
    await clock.tick(1500);
    expect(boom).toHaveBeenCalledTimes(1);
    expect(rej).toHaveBeenCalledTimes(1);
    expect(ok).toHaveBeenCalledTimes(1);
    await clock.tick(3500); // the 5 s ticks: a throwing / rejecting tick is swallowed too
    expect(boom.mock.calls.at(-1)).toEqual(['tick']);
    expect(rej.mock.calls.at(-1)).toEqual(['tick']);
  });

  it('a subscriber removed by an earlier one during a fire is not called', async () => {
    let offB;
    const a = sub(vi.fn(() => offB()));
    const b = vi.fn();
    offB = R.onReconnect(b);
    online();
    await clock.tick(1500);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it('a subscriber added during a fire waits for the next one', async () => {
    const late = vi.fn();
    sub(vi.fn(() => { if (!late.added) { late.added = true; offs.push(R.onReconnect(late)); } }));
    online();
    await clock.tick(1500);
    expect(late).not.toHaveBeenCalled();
    online();
    await clock.tick(1500);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('the window/document listeners are bound once, however many subscribe', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const m = await freshImport({ modules: { reconnect: 'src/lib/reconnect.js' } });
    offs.push(m.reconnect.onReconnect(() => {}), m.reconnect.onReconnect(() => {}));
    expect(add.mock.calls.filter((c) => c[0] === 'online')).toHaveLength(1);
  });
});
