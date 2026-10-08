/* web/src/lib/gridkeys-slices.js (lane browse): a long grid's loaded tiles
 * mount in idle time, and in a frame only while the viewport is near the end
 * of what is mounted. IntersectionObserver, requestIdleCallback and the
 * animation frame are stubbed: the test drives them. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** @type {any[]} */ let observers;
/** @type {Function[]} */ let idles;
/** @type {Function[]} */ let frames;
let slices;

class FakeIO {
  constructor(cb, opts) {
    this.cb = cb;
    this.opts = opts;
    this.targets = new Set();
    observers.push(this);
  }
  observe(t) { this.targets.add(t); }
  unobserve(t) { this.targets.delete(t); }
  disconnect() { this.targets.clear(); this.off = true; }
  fire(t, near) { this.cb([{ target: t, isIntersecting: near }]); }
}

beforeEach(async () => {
  observers = [];
  idles = [];
  frames = [];
  vi.stubGlobal('IntersectionObserver', FakeIO);
  vi.stubGlobal('requestIdleCallback', (cb) => idles.push(cb));
  vi.stubGlobal('cancelIdleCallback', () => {});
  vi.stubGlobal('requestAnimationFrame', (cb) => frames.push(cb));
  vi.resetModules();
  slices = await import('../../web/src/lib/gridkeys-slices.js');
  document.body.innerHTML = '';
});
afterEach(() => vi.unstubAllGlobals());

const tick = () => new Promise((r) => queueMicrotask(() => r(undefined)));

/** a scroller with a grid of `n` tiles, and a more() that appends up to `total` */
function page(n, total) {
  const scroller = document.createElement('main');
  const grid = document.createElement('div');
  grid.className = 'grid lib__grid';
  scroller.append(grid);
  document.body.append(scroller);
  const add = (k) => {
    for (let i = 0; i < k && grid.children.length < total; i++) {
      const t = document.createElement('div');
      t.className = 'tile';
      grid.append(t);
    }
  };
  add(n);
  const asked = [];
  const more = (k) => {
    asked.push(k);
    add(k);
    return grid.children.length < total;
  };
  return { scroller, grid, more, asked };
}

const idle = (ms, didTimeout = false) => idles.shift()?.({ didTimeout, timeRemaining: () => ms });
const frame = (now) => frames.shift()?.(now);

describe('sliceAhead', () => {
  it('watches the last tile with a 1.5-screen margin below the viewport', async () => {
    const p = page(12, 100);
    slices.sliceAhead(p.scroller, '.lib__grid', p.more);
    await tick();
    const io = observers[0];
    expect(io.opts).toEqual({ root: p.scroller, rootMargin: '0px 0px 150% 0px' });
    expect([...io.targets]).toEqual([p.grid.lastElementChild]);
  });

  it('mounts in idle time what the idle period buys, until the list is done', async () => {
    const p = page(12, 40);
    slices.sliceAhead(p.scroller, '.lib__grid', p.more);
    await tick();
    idle(5); // 5 ms, less a 1 ms margin, at the starting guess of 0.5 ms a tile → 8 tiles
    expect(p.asked[0]).toBe(8);
    expect(p.grid.children.length).toBe(20);
    idle(0.2); // too short for a tile: wait for the next period
    expect(p.asked.length).toBe(1);
    for (let i = 0; i < 20 && slices.slicing(p.scroller); i++) idle(50, true);
    expect(p.grid.children.length).toBe(40);
    expect(slices.slicing(p.scroller)).toBe(false);
    expect(observers[0].off).toBe(true);
  });

  it('near the end: a slice on the next frame, then the new last tile is watched', async () => {
    const p = page(12, 200);
    slices.sliceAhead(p.scroller, '.lib__grid', p.more);
    await tick();
    const io = observers[0];
    const last = p.grid.lastElementChild;
    io.fire(last, true);
    expect(frames.length).toBe(1);
    frame(1000);
    expect(p.asked.length).toBe(1);
    await tick();
    expect([...io.targets]).toEqual([p.grid.lastElementChild]);
    expect(p.grid.lastElementChild).not.toBe(last);
    // far away: no frame work
    io.fire(p.grid.lastElementChild, false);
    expect(frames.length).toBe(0);
  });

  it('a long frame after an urgent slice makes the next one smaller', async () => {
    const p = page(12, 400);
    slices.sliceAhead(p.scroller, '.lib__grid', p.more);
    await tick();
    const io = observers[0];
    io.fire(p.grid.lastElementChild, true);
    frame(1000);
    const first = p.asked[0];
    await tick();
    io.fire(p.grid.lastElementChild, true);
    frame(1000 + 4 * (1000 / 60)); // the frame after it took 4 frames
    expect(p.asked[1]).toBeLessThan(first);
  });

  it('a second call for the same scroller only swaps the closure', async () => {
    const p = page(12, 100);
    slices.sliceAhead(p.scroller, '.lib__grid', p.more);
    const other = vi.fn(() => true);
    slices.sliceAhead(p.scroller, '.lib__grid', other);
    await tick();
    expect(observers.length).toBe(1);
    idle(5);
    expect(other).toHaveBeenCalledOnce();
    expect(p.asked).toEqual([]);
  });

  it('stops when more() says done, even with nothing new to mount', async () => {
    const p = page(3, 3);
    slices.sliceAhead(p.scroller, '.lib__grid', () => false);
    await tick();
    idle(5);
    expect(slices.slicing(p.scroller)).toBe(false);
  });
});
