/* Runs before every test file (both projects).
 *
 * 1. No network, ever. fetch and XMLHttpRequest are replaced by guards that
 *    fail loudly; a test that needs answers installs mockFetch() (fetch.js),
 *    which falls back to this same guard for anything it has no route for.
 *    The guard is assigned directly (not vi.stubGlobal), so `unstubGlobals`
 *    restores *to the guard* after every test, never to a real fetch.
 * 2. A clean localStorage before every test (happy-dom's real Storage), and
 *    real timers after every test, so one test's fake clock can't leak.
 *
 * Modules under src/lib keep module-level state (config.js reads localStorage
 * at import, api.js's SWR store, player.svelte.js's timers): a test that needs
 * a fresh copy uses freshImport() from modules.js — vi.resetModules() + a
 * dynamic import after the storage is seeded. */
import { beforeAll, beforeEach, afterEach, vi } from 'vitest';

export class UnmockedNetworkError extends Error {}

/* Every guard hit fails the test that made it (afterEach below), even when the
 * code under test swallowed the rejection — a fire-and-forget lookup the test
 * forgot to route is a request the test did not model. A test that reaches the
 * guard on purpose (the harness's own checks) calls allowUnmockedNetwork(). */
let guardHits = [];
let guardAllowed = false;
export function allowUnmockedNetwork() {
  guardAllowed = true;
}

function networkGuard(input) {
  const url = typeof input === 'string' ? input : input && (input.url || String(input));
  guardHits.push(url);
  const e = new UnmockedNetworkError('test tried to reach the network (unmocked fetch): ' + url);
  // Reject like a fetch would, but also make the cause impossible to miss in the log.
  // eslint-disable-next-line no-console
  console.error(e.message);
  return Promise.reject(e);
}
networkGuard.isNetworkGuard = true;

class GuardXHR {
  open(method, url) {
    throw new UnmockedNetworkError('test tried to reach the network (XMLHttpRequest): ' + method + ' ' + url);
  }
}

function installGuards() {
  globalThis.fetch = networkGuard;
  globalThis.XMLHttpRequest = GuardXHR;
  if (typeof window !== 'undefined' && window !== globalThis) {
    try {
      window.fetch = networkGuard;
      window.XMLHttpRequest = GuardXHR;
    } catch {}
  }
  if (typeof navigator !== 'undefined') {
    try {
      Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: () => { throw new UnmockedNetworkError('sendBeacon'); } });
    } catch {}
  }
}

installGuards();
export const fetchGuard = networkGuard;

beforeEach(() => {
  guardHits = [];
  guardAllowed = false;
  installGuards();
  try {
    localStorage.clear();
  } catch {}
});

afterEach(() => {
  vi.useRealTimers();
  const hits = guardHits;
  guardHits = [];
  if (hits.length && !guardAllowed) throw new UnmockedNetworkError('unmocked fetch(es) during this test — route them (mockFetch) or assert them: ' + hits.join(', '));
});

/* 3. The Svelte compiler's cold start. The first *.svelte.js transform in a run
 *    takes 8–16 s (more while other workers compile too) — longer than the 10 s
 *    test timeout, so whichever test first dynamic-imports a runes module
 *    (freshImport) timed out. Pay it here, under a hook timeout of its own. A
 *    test file's static imports are already transformed by now (collection), so
 *    this only waits when nothing in the file was a runes module. */
beforeAll(async () => {
  await import('../../src/lib/toast.svelte.js');
}, 120000);
