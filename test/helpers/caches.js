/* Cache Storage and navigator.storage fakes (happy-dom has neither).
 *
 *   const cs = installCaches();                 // window.caches, undone after the test
 *   await caches.open('vibereel-offline-v1')    // → a FakeCache (created on first open)
 *   cs.cache('vibereel-offline-v1')             // the same FakeCache, synchronously (created if missing)
 *   cs.urls('vibereel-offline-v1')              // every stored key as a path ('/offline/u1.m1/s0'), sorted
 *   cs.bytes()                                  // bytes held by every cache (see "sizes" below)
 *   cs.seed('name', '/offline/x/s0', 'body', { 'Content-Type': 'video/mp4' })
 *   cs.beforePut = async (path, res) => {}      // runs inside every put(): throw to fail it
 *                                               // (QuotaExceededError…), await to hold it
 *   cs.openFails = true                         // caches.open() rejects (no Cache Storage)
 *
 *   const st = installStorage({ quota, usage, persisted, persist });
 *   st.usage = 123          // a number, or a function () => number (e.g. () => base + cs.bytes())
 *   st.quota = …            // null / undefined: estimate() leaves it out, like a browser that won't say
 *   st.estimate / st.persist / st.persisted   vi.fn()s; st.fail = true makes estimate() reject
 *
 * Keys behave like the real Cache API's: a relative string is resolved against
 * the page URL, so `keys()` hands back Requests whose `url` is absolute
 * (`new URL(req.url).pathname` is what offline.svelte.js reads). match() answers
 * a fresh Response each time (or undefined); put() consumes the response body —
 * a body that fails to read rejects the put and stores nothing, as a broken-off
 * download does in WebKit.
 *
 * Sizes: an entry counts its Content-Length header when it has one, else its
 * real byte length — so a test can stand in a 64 MB segment with a few bytes
 * and a `Content-Length: 67108864` header without allocating it.
 *
 * Both undo themselves when the test finishes (onTestFinished). */
import { vi, onTestFinished } from 'vitest';

const pageUrl = () => (typeof location !== 'undefined' ? location.href : 'http://test.invalid/');
const abs = (req) => new URL(typeof req === 'string' ? req : req.url, pageUrl()).href;

class FakeCache {
  constructor(owner) {
    this.owner = owner;
    /** @type {Map<string, { body: ArrayBuffer, headers: [string, string][], status: number, size: number }>} */
    this.entries = new Map();
  }
  async match(req) {
    const e = this.entries.get(abs(req));
    if (!e) return undefined;
    return new Response(e.body.slice(0), { status: e.status, headers: e.headers });
  }
  async put(req, res) {
    const url = abs(req);
    if (this.owner.beforePut) await this.owner.beforePut(new URL(url).pathname, res);
    const body = await res.arrayBuffer();
    const headers = [...res.headers.entries()];
    const declared = Number(res.headers.get('Content-Length')) || 0;
    this.entries.set(url, { body, headers, status: res.status || 200, size: declared > 0 ? declared : body.byteLength });
  }
  async delete(req) {
    return this.entries.delete(abs(req));
  }
  async keys() {
    return [...this.entries.keys()].map((url) => ({ url, method: 'GET' }));
  }
  bytes() {
    let n = 0;
    for (const e of this.entries.values()) n += e.size;
    return n;
  }
}

export function installCaches() {
  const stores = new Map();
  const cs = {
    stores,
    beforePut: null,
    openFails: false,
    cache(name) {
      if (!stores.has(name)) stores.set(name, new FakeCache(cs));
      return stores.get(name);
    },
    urls(name) {
      const c = stores.get(name);
      return c ? [...c.entries.keys()].map((u) => new URL(u).pathname).sort() : [];
    },
    bytes() {
      let n = 0;
      for (const c of stores.values()) n += c.bytes();
      return n;
    },
    seed(name, path, body = 'x', headers = {}) {
      const buf = typeof body === 'string' ? new TextEncoder().encode(body).buffer : body;
      const declared = Number(headers['Content-Length']) || 0;
      cs.cache(name).entries.set(abs(path), { body: buf, headers: Object.entries(headers), status: 200, size: declared || buf.byteLength });
    },
    api: {
      open: vi.fn(async (name) => {
        if (cs.openFails) throw new DOMException('The operation is insecure.', 'SecurityError');
        return cs.cache(name);
      }),
      has: vi.fn(async (name) => stores.has(name)),
      delete: vi.fn(async (name) => stores.delete(name)),
      keys: vi.fn(async () => [...stores.keys()]),
      match: vi.fn(async (req) => {
        for (const c of stores.values()) {
          const r = await c.match(req);
          if (r) return r;
        }
        return undefined;
      })
    }
  };
  vi.stubGlobal('caches', cs.api);
  return cs;
}

export function installStorage({ quota = 50e9, usage = 0, persisted = false, persist = true } = {}) {
  const read = (v) => (typeof v === 'function' ? v() : v);
  const st = {
    quota,
    usage,
    persistedValue: persisted,
    persistAnswer: persist,
    fail: false,
    estimate: vi.fn(async () => {
      if (st.fail) throw new TypeError('estimate failed');
      const out = {};
      const q = read(st.quota);
      const u = read(st.usage);
      if (q != null) out.quota = q;
      if (u != null) out.usage = u;
      return out;
    }),
    persist: vi.fn(async () => {
      st.persistedValue = !!st.persistAnswer;
      return st.persistedValue;
    }),
    persisted: vi.fn(async () => st.persistedValue)
  };
  const had = Object.getOwnPropertyDescriptor(navigator, 'storage');
  Object.defineProperty(navigator, 'storage', { configurable: true, value: st });
  onTestFinished(() => {
    if (had) Object.defineProperty(navigator, 'storage', had);
    else delete navigator.storage;
  });
  return st;
}
