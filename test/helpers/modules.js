/* Fresh module graphs.
 *
 * src/lib modules read storage at import time (config.js → cfg, settings →
 * SET, trackprefs' legacy migration, landed's persisted feed) and keep state in
 * module scope (api.js's SWR store and read barrier, player.svelte.js's
 * timers). To test those paths, seed the store first, then import a fresh copy:
 *
 *   const { trackprefs, config } = await freshImport({
 *     storage: { 'reel.userId': 'u1', 'reel.server': 'http://jf.test' },
 *     modules: { trackprefs: 'src/lib/trackprefs.js', config: 'src/lib/config.js' }
 *   });
 *
 * `signedIn` (default true) seeds a test account — server http://jf.test,
 * reel-api http://ml.test, user u1, token tok-u1 — unless `storage` already
 * sets those keys. Every module listed shares one fresh graph (they see the
 * same cfg / S / P objects). Paths are repo-relative. */
import { vi } from 'vitest';
import path from 'node:path';
import { seedStorage } from './storage.js';

export const TEST_SERVER = 'http://jf.test';
export const TEST_MEDIALIB = 'http://ml.test';
export const TEST_USER = 'u1';
export const TEST_TOKEN = 'tok-u1';

export function accountStorage({ userId = TEST_USER, token = TEST_TOKEN, server = TEST_SERVER, medialib = TEST_MEDIALIB, deviceId = 'dev-test' } = {}) {
  return {
    'reel.server': server,
    'reel.medialib': medialib,
    'reel.userId': userId,
    'reel.userName': 'Tester',
    'reel.token': token,
    'reel.deviceId': deviceId
  };
}

// import.meta.dirname, not new URL(): under happy-dom the global URL is happy-dom's, which node's fileURLToPath rejects
const ROOT = path.resolve(import.meta.dirname, '../..');

export async function freshImport({ storage = {}, signedIn = true, modules = {} } = {}) {
  vi.resetModules();
  try {
    localStorage.clear();
  } catch {}
  seedStorage({ ...(signedIn ? accountStorage() : {}), ...storage });
  const out = {};
  for (const [name, rel] of Object.entries(modules)) {
    out[name] = await import(/* @vite-ignore */ path.resolve(ROOT, rel));
  }
  return out;
}
