/* api(): deadlines and error normalisation (CLAUDE.md "api() — auth header,
 * deadlines, caching"). Wave-0 proof of the fetch mock + fake clock; the full
 * api.js suite is task api-* in run/tasks.json. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { api, errText, onAuthLost } from '../../src/lib/api.js';
import { cfg } from '../../src/lib/config.js';
import { mockFetch } from '../helpers/fetch.js';
import { TEST_SERVER, TEST_TOKEN } from '../helpers/modules.js';
import { useClock } from '../helpers/time.js';

beforeEach(() => {
  cfg.server = TEST_SERVER;
  cfg.token = TEST_TOKEN;
  onAuthLost(null);
});

describe('api() errors', () => {
  it('sends the MediaBrowser Authorization header (not X-Emby-Authorization) with the token', async () => {
    const net = mockFetch();
    net.on('GET', '/System/Info', { Version: '12.1.0' });
    await api('/System/Info');
    const h = net.calls[0].headers;
    expect(h['X-Emby-Authorization']).toBeUndefined();
    expect(h.Authorization).toMatch(/^MediaBrowser Client="Reel", Device="(LG webOS TV|iPhone)", DeviceId="[^"]+", Version="[^"]+", Token="tok-u1"$/);
    expect(h.Authorization).toContain(__PHONE__ ? 'Device="iPhone"' : 'Device="LG webOS TV"');
  });

  it('gives every request a 30 s deadline; the timeout surfaces as AbortError with a userMessage', async () => {
    const clock = useClock();
    const net = mockFetch();
    net.on('GET', '/Items', net.hang());
    const p = api('/Items');
    const settled = p.then(() => 'resolved', (e) => e);
    expect(clock.timeouts).toEqual([30000]);
    await clock.tick(29999);
    expect(net.calls[0].signal.aborted).toBe(false);
    await clock.tick(2);
    const e = await settled;
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('AbortError');
    expect(e.status).toBe(0);
    expect(e.network).toBe(true);
    expect(errText(e)).toBe('The server at ' + TEST_SERVER + ' took too long to answer');
  });

  it('treats a TimeoutError rejection exactly like an AbortError (Chromium 120 says AbortError, others TimeoutError)', async () => {
    const net = mockFetch();
    net.on('GET', '/a', () => Promise.reject(new DOMException('t', 'TimeoutError')));
    net.on('GET', '/b', () => Promise.reject(new DOMException('t', 'AbortError')));
    const ea = await api('/a').catch((e) => e);
    const eb = await api('/b').catch((e) => e);
    expect(ea.name).toBe('AbortError');
    expect(eb.name).toBe('AbortError');
    expect(errText(ea)).toBe(errText(eb));
  });

  it('a caller-supplied signal replaces the default deadline; keepalive requests get none', async () => {
    const net = mockFetch();
    net.on('POST', '/Sessions/Playing/Stopped', null);
    net.on('GET', '/x', {});
    const ac = new AbortController();
    await api('/x', { signal: ac.signal });
    await api('/Sessions/Playing/Stopped', { method: 'POST', keepalive: true, body: { a: 1 } });
    expect(net.calls[0].signal).toBe(ac.signal);
    expect(net.calls[1].signal).toBeUndefined();
    expect(net.calls[1].keepalive).toBe(true);
    expect(net.calls[1].body).toEqual({ a: 1 });
    expect(net.calls[1].headers['Content-Type']).toBe('application/json');
  });

  it.each([
    [401, 'The server refused this sign-in (HTTP 401)'],
    [403, 'The server refused this sign-in (HTTP 403)'],
    [404, 'Not found on the server (HTTP 404)'],
    [500, 'The server had a problem (HTTP 500)'],
    [503, 'The server had a problem (HTTP 503)'],
    [409, 'The server answered HTTP 409']
  ])('HTTP %i → status + userMessage', async (code, msg) => {
    const net = mockFetch();
    net.on('GET', '/Items/x', net.status(code));
    const e = await api('/Items/x').catch((err) => err);
    expect(e.status).toBe(code);
    expect(errText(e)).toBe(msg);
  });

  it('a network failure (fetch rejects with TypeError) reads "Can’t reach the server"', async () => {
    const net = mockFetch();
    net.on('GET', '/x', net.networkError());
    const e = await api('/x').catch((err) => err);
    expect(e.name).toBe('NetworkError');
    expect(e.cause).toBeInstanceOf(TypeError);
    expect(errText(e)).toBe('Can’t reach the server at ' + TEST_SERVER);
  });

  it('a truncated / non-JSON body is normalised too, never a raw SyntaxError', async () => {
    const net = mockFetch();
    net.on('GET', '/x', net.text('{"Items": [', 'application/json'));
    const e = await api('/x').catch((err) => err);
    expect(e.status).toBe(0);
    expect(e.cause).toBeInstanceOf(SyntaxError);
    expect(errText(e)).toBe('The server sent an answer this app couldn’t read');
  });

  it('204 → null; text/plain → string', async () => {
    const net = mockFetch();
    net.on('POST', '/a', null);
    net.on('GET', '/b', net.text('hello'));
    expect(await api('/a', { method: 'POST' })).toBeNull();
    expect(await api('/b')).toBe('hello');
  });

  it('errText never throws and prefers userMessage', () => {
    expect(errText(null)).toBe('Unknown error');
    expect(errText(new Error('raw'))).toBe('raw');
    expect(errText(Object.assign(new Error('raw'), { userMessage: 'nice' }))).toBe('nice');
    expect(errText('plain')).toBe('plain');
  });

  it('a 401 on the current token calls onAuthLost(path); a throwing handler does not change the error', async () => {
    const net = mockFetch();
    net.on('GET', '/Users/u1', net.status(401));
    const lost = vi.fn(() => {
      throw new Error('handler bug');
    });
    onAuthLost(lost);
    const e = await api('/Users/u1').catch((err) => err);
    expect(lost).toHaveBeenCalledWith('/Users/u1');
    expect(e.status).toBe(401);
  });

  it('a 401 for a token that has since changed (account switch mid-flight) is not reported', async () => {
    const net = mockFetch();
    let release;
    net.on('GET', '/Users/u1', () => new Promise((r) => (release = r)).then(() => net.status(401)));
    const lost = vi.fn();
    onAuthLost(lost);
    const p = api('/Users/u1').catch((err) => err);
    await Promise.resolve();
    cfg.token = 'tok-other';
    release();
    expect((await p).status).toBe(401);
    expect(lost).not.toHaveBeenCalled();
  });
});
