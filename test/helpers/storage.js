/* localStorage helpers.
 *
 * setup.js clears happy-dom's real localStorage before every test. For the
 * cases where the store itself misbehaves (CLAUDE.md: "a throwing or corrupted
 * store falls back to defaults instead of killing the bundle at module init"),
 * stubStorage() swaps in a Map-backed Storage that can throw on demand:
 *
 *   seedStorage({ 'reel.userId': 'u1', 'reel.trackPrefs': { s1: {…} } });  // objects are JSON-encoded
 *   const ls = stubStorage({ throwOn: ['getItem'] });   // every getItem throws
 *   ls.throwOn = ['setItem'];                            // change mid-test
 *   ls.quota = 100;                                      // setItem throws QuotaExceededError past 100 chars total
 *   readJSON('reel.landed.u1')                           // parsed value or null
 *
 * stubStorage uses vi.stubGlobal, so it is undone after the test. */
import { vi } from 'vitest';

export function seedStorage(entries) {
  for (const [k, v] of Object.entries(entries)) {
    localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
}

export function readJSON(key) {
  const raw = localStorage.getItem(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function storageKeys() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) out.push(localStorage.key(i));
  return out.sort();
}

export function stubStorage({ throwOn = [], quota = Infinity, initial = {} } = {}) {
  const map = new Map(Object.entries(initial).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  const ls = {
    throwOn,
    quota,
    map,
    get length() {
      maybeThrow('length');
      return map.size;
    },
    key(i) {
      maybeThrow('key');
      return [...map.keys()][i] ?? null;
    },
    getItem(k) {
      maybeThrow('getItem');
      return map.has(String(k)) ? map.get(String(k)) : null;
    },
    setItem(k, v) {
      maybeThrow('setItem');
      const used = [...map].reduce((a, [kk, vv]) => (kk === String(k) ? a : a + kk.length + vv.length), 0);
      if (used + String(k).length + String(v).length > ls.quota) throw new DOMException('quota', 'QuotaExceededError');
      map.set(String(k), String(v));
    },
    removeItem(k) {
      maybeThrow('removeItem');
      map.delete(String(k));
    },
    clear() {
      maybeThrow('clear');
      map.clear();
    }
  };
  function maybeThrow(op) {
    if (ls.throwOn === true || (Array.isArray(ls.throwOn) && ls.throwOn.includes(op))) throw new DOMException('storage disabled', 'SecurityError');
  }
  vi.stubGlobal('localStorage', ls);
  return ls;
}
