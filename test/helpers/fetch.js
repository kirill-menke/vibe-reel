/* A route-table fetch mock.
 *
 *   const net = mockFetch();                       // installs it (vi.stubGlobal, undone after the test)
 *   net.on('GET', '/Items/abc', { Id: 'abc' });    // JSON 200
 *   net.on('POST', /\/Sessions\/Playing\/Stopped$/, net.status(503));
 *   net.on('GET', '/MediaSegments/x', (req) => ({ Items: [] }));     // computed
 *   net.on('GET', '/slow', net.hang());            // never answers (until its signal aborts)
 *   net.calls / net.callsTo('/Sessions/Playing/Stopped')
 *
 * Matching: a string matches the URL's path (+ query, if the string has a '?')
 * exactly, or the full URL if it starts with 'http'; a RegExp is tested against
 * the full URL; a function gets the request. Later routes win over earlier ones,
 * and `once: true` routes are consumed. An unmatched request rejects through the
 * setup guard (no network) and is recorded in `net.unmatched`, so a test can
 * assert `expect(net.unmatched).toEqual([])`.
 *
 * Handlers return a value (→ JSON 200, `null` → 204), a Response, a
 * `net.status(code, body?)` / `net.text(str, ct?)` / `net.networkError()` /
 * `net.hang()` marker, or a Promise of any of these. Each recorded call:
 * { method, url, path, query, headers, body (parsed JSON when it was JSON),
 *   signal, keepalive, init }. */
import { vi } from 'vitest';
import { fetchGuard } from './setup.js';

const MARK = Symbol('fetch-mock-marker');

function abortError(signal) {
  const r = signal && signal.reason;
  if (r && typeof r === 'object' && 'name' in r) return r;
  // Chromium 120 rejects a timed-out fetch with an AbortError (see CLAUDE.md, api() deadlines)
  return new DOMException('The operation was aborted.', 'AbortError');
}

export function mockFetch({ base = '' } = {}) {
  const routes = [];
  const calls = [];
  const unmatched = [];

  const net = {
    calls,
    unmatched,
    /** add a route; returns net for chaining */
    on(method, match, handler, opts = {}) {
      routes.push({ method: method && method.toUpperCase(), match, handler, once: !!opts.once, delay: opts.delay || 0 });
      return net;
    },
    once(method, match, handler, opts = {}) {
      return net.on(method, match, handler, { ...opts, once: true });
    },
    status(code, body = '', headers = {}) {
      return { [MARK]: 'status', code, body, headers };
    },
    text(body, contentType = 'text/plain') {
      return { [MARK]: 'status', code: 200, body, headers: { 'content-type': contentType } };
    },
    networkError(message = 'Failed to fetch') {
      return { [MARK]: 'neterr', message };
    },
    hang() {
      return { [MARK]: 'hang' };
    },
    callsTo(match, method) {
      return calls.filter((c) => (!method || c.method === method.toUpperCase()) && matches(match, c));
    },
    reset() {
      routes.length = 0;
      calls.length = 0;
      unmatched.length = 0;
    },
    fn: null
  };

  function matches(match, req) {
    if (typeof match === 'function') return !!match(req);
    if (match instanceof RegExp) return match.test(req.url);
    if (typeof match === 'string') {
      if (/^https?:/.test(match)) return req.url === match;
      return match.includes('?') ? req.path + req.query === match : req.path === match;
    }
    return false;
  }

  async function respond(out, req) {
    out = await out;
    if (out instanceof Response) return out;
    if (out && out[MARK] === 'status') {
      const isObj = out.body && typeof out.body === 'object';
      const headers = { ...(isObj ? { 'content-type': 'application/json' } : {}), ...out.headers };
      const body = out.code === 204 || out.code === 304 ? null : isObj ? JSON.stringify(out.body) : out.body;
      return new Response(body, { status: out.code, headers });
    }
    if (out && out[MARK] === 'neterr') throw new TypeError(out.message);
    if (out && out[MARK] === 'hang') {
      return new Promise((_, reject) => {
        const s = req.signal;
        if (!s) return;
        if (s.aborted) return reject(abortError(s));
        s.addEventListener('abort', () => reject(abortError(s)), { once: true });
      });
    }
    if (out === null) return new Response(null, { status: 204 });
    if (out === undefined) return new Response(null, { status: 204 });
    if (typeof out === 'string') return new Response(out, { status: 200, headers: { 'content-type': 'text/plain' } });
    if (out instanceof ArrayBuffer || ArrayBuffer.isView(out)) return new Response(out, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  const fn = vi.fn(async (input, init = {}) => {
    // like the browser's Request constructor: a given method must be an HTTP token
    // (fetch(url, { method: '' }) rejects with a TypeError, it does not mean GET)
    if (init.method !== undefined && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(String(init.method))) {
      throw new TypeError(`Failed to execute 'fetch': '${init.method}' is not a valid HTTP method.`);
    }
    const url = typeof input === 'string' ? input : input.url;
    let u;
    try {
      u = new URL(url, base || 'http://relative.invalid/');
    } catch {
      u = { pathname: url, search: '' };
    }
    let body = init.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {}
    }
    const req = {
      method: (init.method || 'GET').toUpperCase(),
      url,
      path: u.pathname,
      query: u.search,
      headers: init.headers || {},
      body,
      signal: init.signal,
      keepalive: !!init.keepalive,
      init
    };
    calls.push(req);
    if (req.signal && req.signal.aborted) throw abortError(req.signal);
    for (let i = routes.length - 1; i >= 0; i--) {
      const r = routes[i];
      if (r.method && r.method !== req.method) continue;
      if (!matches(r.match, req)) continue;
      if (r.once) routes.splice(i, 1);
      if (r.delay) await new Promise((res) => setTimeout(res, r.delay));
      const out = typeof r.handler === 'function' ? r.handler(req) : r.handler;
      return respond(out, req);
    }
    unmatched.push(req);
    return fetchGuard(url);
  });
  net.fn = fn;
  vi.stubGlobal('fetch', fn);
  return net;
}
