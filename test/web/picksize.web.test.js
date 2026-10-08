/* pickSize (src/lib/api.js): the web build's image sizes follow the window
 * and its devicePixelRatio, snapped to a few steps so Jellyfin's resize cache
 * stays warm. */
import { describe, it, expect, afterEach } from 'vitest';
import { pickSize } from '../../src/lib/api.js';

const BACKDROP = [1920, 2880, 3840];
const dpr = (v) => Object.defineProperty(globalThis, 'devicePixelRatio', { value: v, configurable: true, writable: true });

afterEach(() => dpr(1));

describe('pickSize', () => {
  it('takes the smallest step that covers the box at dpr 1', () => {
    dpr(1);
    expect(pickSize(1440, BACKDROP)).toBe(1920);
    expect(pickSize(1920, BACKDROP)).toBe(1920);
    expect(pickSize(2560, BACKDROP)).toBe(2880);
  });

  it('scales the need by devicePixelRatio', () => {
    dpr(2);
    expect(pickSize(1440, BACKDROP)).toBe(2880);
    expect(pickSize(1920, BACKDROP)).toBe(3840);
  });

  it('accepts a step up to 10 % short of the need', () => {
    dpr(1);
    expect(pickSize(2100, BACKDROP)).toBe(1920); // 1920 ≥ 2100 × 0.9
    expect(pickSize(2200, BACKDROP)).toBe(2880);
  });

  it('caps at the largest step', () => {
    dpr(2);
    expect(pickSize(2560, BACKDROP)).toBe(3840);
  });

  it('treats a missing devicePixelRatio as 1', () => {
    dpr(0);
    expect(pickSize(1000, [480, 1280])).toBe(1280);
  });
});
