/* api.js: cases the mutation run (oracle-mutants-api) showed the other api.*
 * files left open. Each names the behaviour it protects:
 *
 * - a body that fails mid-download is classified like a failed fetch: the
 *   deadline firing during the body (AbortError — or TimeoutError, CLAUDE.md:
 *   "Chromium 120 rejects a timed-out fetch with AbortError, not TimeoutError —
 *   test both names") reads "took too long", a dropped connection (TypeError)
 *   is a network error, only an unreadable body is "couldn't read";
 * - onAuthLost fires for a 401 on the token actually sent — never for another
 *   status, and never for a request sent with no token (a failed sign-in);
 * - a parked prefetch that an invalidate() replaced: the OLD warm's late
 *   rejection must not evict the NEW one;
 * - holdReads holds GETs only: a body-less DELETE to a held path goes out;
 * - (phone) a snapshot entry whose path is not a string is not seeded;
 * - a plain GET carries no Content-Type (a JSON content type on a GET forces a
 *   CORS preflight per request on the phone/dev origins) and says GET;
 * - signed out, the Authorization header carries no Token="" part;
 * - an invalidated warm that then fails leaves no unhandled rejection;
 * - ITEM_FIELDS: what Home's rails and playFromHome() read, and nothing heavy
 *   (api.js: People/MediaStreams/Chapters were measured payload, not used). */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { api, errText, onAuthLost, holdReads, ITEM_FIELDS } from '../../src/lib/api.js';
import { cfg } from '../../src/lib/config.js';
import { freshImport, TEST_SERVER, TEST_TOKEN } from '../helpers/modules.js';
import { mockFetch } from '../helpers/fetch.js';

beforeEach(() => {
  cfg.server = TEST_SERVER;
  cfg.token = TEST_TOKEN;
  onAuthLost(null);
});

/* A 200 JSON answer whose body read rejects with `err`. */
function brokenBody(err) {
  class R extends Response {
    json() {
      return Promise.reject(err);
    }
  }
  return new R('{}', { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('a body that fails mid-download', () => {
  it.each(['AbortError', 'TimeoutError'])('%s while reading the body: AbortError, "took too long"', async (name) => {
    const net = mockFetch();
    const cause = new DOMException('The operation was aborted.', name);
    net.on('GET', '/Items/x', () => brokenBody(cause));
    const e = await api('/Items/x').catch((err) => err);
    expect(e.name).toBe('AbortError');
    expect(e.status).toBe(0);
    expect(e.network).toBe(true);
    expect(e.cause).toBe(cause);
    expect(errText(e)).toBe('The server at ' + TEST_SERVER + ' took too long to answer');
  });

  it('a connection dropped while reading (TypeError) is a network error: "dropped"', async () => {
    const net = mockFetch();
    net.on('GET', '/Items/x', () => brokenBody(new TypeError('network error')));
    const e = await api('/Items/x').catch((err) => err);
    expect(e.name).toBe('Error');
    expect(e.network).toBe(true);
    expect(errText(e)).toBe('The connection to ' + TEST_SERVER + ' dropped');
  });

  it('an unreadable body is not a network error', async () => {
    const net = mockFetch();
    net.on('GET', '/Items/x', () => brokenBody(new SyntaxError('Unexpected end of JSON input')));
    const e = await api('/Items/x').catch((err) => err);
    expect(e.name).toBe('Error');
    expect(e.network).toBe(false);
    expect(errText(e)).toBe('The server sent an answer this app couldn’t read');
  });

  it('an answer without a content-type is read as text', async () => {
    const net = mockFetch();
    net.on('GET', '/x', () => new Response('plain'));
    const r = await api('/x');
    expect(r).toBe('plain');
  });
});

describe('onAuthLost: a 401 on the token sent, nothing else', () => {
  it.each([403, 404, 500])('HTTP %i is not reported', async (code) => {
    const net = mockFetch();
    net.on('GET', '/Users/u1', net.status(code));
    const lost = vi.fn();
    onAuthLost(lost);
    const e = await api('/Users/u1').catch((err) => err);
    expect(e.status).toBe(code);
    expect(lost).not.toHaveBeenCalled();
  });

  it('a 401 to a request sent with no token (a failed sign-in) is not reported', async () => {
    cfg.token = '';
    const net = mockFetch();
    net.on('POST', '/Users/AuthenticateByName', net.status(401));
    const lost = vi.fn();
    onAuthLost(lost);
    const e = await api('/Users/AuthenticateByName', { method: 'POST', body: { Username: 'x', Pw: 'y' } }).catch((err) => err);
    expect(e.status).toBe(401);
    expect(lost).not.toHaveBeenCalled();
  });
});

describe('prefetch: a replaced warm', () => {
  it("the old warm's late rejection does not evict the new one", async () => {
    const m = await freshImport({ modules: { api: 'src/lib/api.js' } });
    const net = mockFetch();
    let fail;
    let n = 0;
    net.on('GET', '/Items/a', () => (++n === 1 ? new Promise((r) => (fail = () => r(net.status(500)))) : { n }));
    const old = m.api.prefetch('/Items/a');
    old.catch(() => {});
    m.api.invalidate('/Items/a');
    const fresh = m.api.prefetch('/Items/a');
    expect(fresh).not.toBe(old);
    await fresh;
    fail();
    await old.catch(() => {});
    await Promise.resolve();
    expect(await m.api.api('/Items/a')).toStrictEqual({ n: 2 });
    expect(n).toBe(2);
  });
});

describe('holdReads holds GETs only', () => {
  it('a body-less DELETE to a held path goes out at once', async () => {
    const net = mockFetch();
    net.on('DELETE', '/UserItems/abc/Rating', null);
    let release;
    holdReads(new Promise((r) => (release = r)));
    const p = api('/UserItems/abc/Rating', { method: 'DELETE' });
    await Promise.resolve();
    expect(net.calls.map((c) => c.method + ' ' + c.path)).toStrictEqual(['DELETE /UserItems/abc/Rating']);
    expect(await p).toBe(null);
    release();
  });
});

describe('seedStore (phone Home snapshot)', () => {
  it('an entry whose path is not a string is skipped', async () => {
    const m = await freshImport({ modules: { api: 'src/lib/api.js' } });
    m.api.seedStore([[42, { at: 1, data: { Items: [1] } }], ['/ok', { at: 1, data: { Items: [2] } }]]);
    const got = m.api.storeEntries([42, '/ok']);
    // the TV build never seeds (seedStore is a no-op there)
    expect(got).toStrictEqual(__PHONE__ ? [['/ok', { at: 1, data: { Items: [2] } }]] : []);
  });
});

describe('request shape', () => {
  it('a plain GET says GET and carries no Content-Type; a body adds the JSON one', async () => {
    const net = mockFetch();
    net.on('GET', '/Items/a', {});
    net.on('POST', '/Items/b', null);
    await api('/Items/a');
    await api('/Items/b', { method: 'POST', body: { x: 1 } });
    expect(net.calls[0].init.method).toBe('GET');
    expect(net.calls[0].headers['Content-Type']).toBeUndefined();
    expect(net.calls[0].init.body).toBeUndefined();
    expect(net.calls[1].headers['Content-Type']).toBe('application/json');
    expect(net.calls[1].init.body).toBe('{"x":1}');
  });

  it('signed out: no Token part in the Authorization header', async () => {
    cfg.token = '';
    const net = mockFetch();
    net.on('GET', '/System/Info/Public', {});
    await api('/System/Info/Public');
    expect(net.calls[0].headers.Authorization).not.toContain('Token');
  });
});

describe('prefetch: an invalidated warm that fails', () => {
  it('rejects quietly: nothing is left parked and no handler throws', async () => {
    const m = await freshImport({ modules: { api: 'src/lib/api.js' } });
    const net = mockFetch();
    let fail;
    let n = 0;
    net.on('GET', '/Items/a', () => (++n === 1 ? new Promise((r) => (fail = () => r(net.status(500)))) : { n }));
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const old = m.api.prefetch('/Items/a');
      old.catch(() => {});
      m.api.invalidate('/Items/a');
      fail();
      await old.catch(() => {});
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).toEqual([]);
      expect(await m.api.api('/Items/a')).toStrictEqual({ n: 2 });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('ITEM_FIELDS', () => {
  it('the fields the rails and a Home start read; no People, MediaStreams or Chapters', () => {
    expect(ITEM_FIELDS.split(',').sort()).toStrictEqual([
      'CommunityRating', 'Genres', 'IndexNumber', 'MediaSources', 'OfficialRating', 'Overview', 'ParentIndexNumber',
      'PremiereDate', 'ProductionYear', 'RunTimeTicks', 'SeriesName', 'UserData'
    ]);
  });
});
