/* The harness itself: runs in both projects and proves the build-mirroring
 * (define, module redirects, lazy-libpgs) and the safety rails (no network,
 * no .env.local) are in place. If one of these fails, every other result is
 * suspect. */
import { describe, it, expect, inject } from 'vitest';
import { mockFetch } from '../helpers/fetch.js';
import { UnmockedNetworkError, allowUnmockedNetwork } from '../helpers/setup.js';
import { freshImport, TEST_SERVER } from '../helpers/modules.js';
import { cfg } from '../../src/lib/config.js';
import * as nav from '../../src/lib/nav.svelte.js';
import * as focus from '../../src/lib/focus.js';

describe('safety rails', () => {
  it('an unmocked fetch rejects without touching the network', async () => {
    allowUnmockedNetwork();
    await expect(fetch('http://example.invalid/x')).rejects.toBeInstanceOf(UnmockedNetworkError);
  });

  it('a mockFetch route answers, an unmatched one falls through to the guard', async () => {
    allowUnmockedNetwork();
    const net = mockFetch();
    net.on('GET', '/Items/abc', { Id: 'abc' });
    const r = await fetch(TEST_SERVER + '/Items/abc');
    expect(await r.json()).toEqual({ Id: 'abc' });
    await expect(fetch(TEST_SERVER + '/nope')).rejects.toBeInstanceOf(UnmockedNetworkError);
    expect(net.unmatched.map((c) => c.path)).toEqual(['/nope']);
  });

  it('mockFetch rejects an invalid method the way the browser does (an empty one is not GET)', async () => {
    const net = mockFetch();
    net.on(null, '/Items/abc', { Id: 'abc' });
    await expect(fetch(TEST_SERVER + '/Items/abc', { method: '' })).rejects.toBeInstanceOf(TypeError);
    await expect(fetch(TEST_SERVER + '/Items/abc', { method: 'GE T' })).rejects.toBeInstanceOf(TypeError);
    expect(net.calls).toEqual([]);
    expect((await fetch(TEST_SERVER + '/Items/abc', { method: undefined })).ok).toBe(true);
    expect((await fetch(TEST_SERVER + '/Items/abc', { method: 'post' })).ok).toBe(true);
    // (Fetch spec, Request constructor: "If method is not a method … throw a TypeError";
    // Chromium and WebKit do. happy-dom's own Request does not validate, so no reference here.)
  });

  it('XMLHttpRequest is guarded too', () => {
    expect(() => new XMLHttpRequest().open('GET', 'http://example.invalid/')).toThrow(UnmockedNetworkError);
  });

  it('.env.local never reaches import.meta.env (empty envDir)', () => {
    expect(import.meta.env.VITE_JELLYFIN_URL).toBeUndefined();
    expect(import.meta.env.VITE_MEDIALIB_URL).toBeUndefined();
  });

  it('localStorage starts empty in every test', () => {
    expect(localStorage.length).toBe(0);
    localStorage.setItem('leak', '1');
  });

  it('…and the previous test’s write is gone', () => {
    expect(localStorage.getItem('leak')).toBeNull();
  });
});

describe('build mirroring', () => {
  it('__PHONE__ is the project’s constant', () => {
    expect(__PHONE__).toBe(inject('project') === 'phone');
  });

  it('nav.svelte.js / focus.js resolve to the phone shims only in the phone project', () => {
    if (__PHONE__) {
      // the phone router shim re-exports resetTab and stubs the TV's focus memory
      expect(typeof nav.resetTab).toBe('function');
      expect(nav.takeGridFocus()).toBeNull();
      expect(focus.focusables()).toEqual([]);
    } else {
      expect(nav.resetTab).toBeUndefined();
      expect(nav.S.screen).toBe('boot');
      expect(typeof focus.spatialMove).toBe('function');
    }
  });

  it('config defaults follow the build (phone: same-origin /jf and /ml)', async () => {
    const { config } = await freshImport({ signedIn: false, modules: { config: 'src/lib/config.js' } });
    if (__PHONE__) {
      expect(config.cfg.server).toBe(location.origin + '/jf');
      expect(config.cfg.medialib).toBe(location.origin + '/ml');
      expect(config.cfg.deviceId).toMatch(/^reelphone-/);
    } else {
      expect(config.cfg.server).toBe('');
      expect(config.cfg.deviceId).toMatch(/^reel-/);
    }
    expect(localStorage.getItem('reel.deviceId')).toBe(config.cfg.deviceId);
  });

  it('the statically imported cfg is the unseeded default and is writable for tests', () => {
    expect(cfg.token).toBe('');
    cfg.server = TEST_SERVER;
    expect(cfg.medialib).toBe(__PHONE__ ? location.origin + '/ml' : 'http://jf.test:8790');
  });

  it('vendor/libpgs.js goes through lazy-libpgs (exports loadPgs, not PgsRenderer)', async () => {
    const m = await import('../../src/vendor/libpgs.js');
    expect(typeof m.loadPgs).toBe('function');
    expect(m.PgsRenderer).toBeUndefined();
  });
});
