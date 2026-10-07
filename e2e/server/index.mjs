/* The fake server: one process, five loopback origins sharing one world.
 *
 *   jf     Jellyfin 12.1           (TV: VITE_JELLYFIN_URL)
 *   ml     reel-api                (TV: VITE_MEDIALIB_URL)
 *   tv     the TV build, static    (http://127.0.0.1:<tv>/index.html)
 *   phone  the phone build + /jf + /ml on one origin, like production
 *   pic    the TV's picture-mode companion service; the harness maps the
 *          app's hard-coded http://127.0.0.1:8791 onto it (lib/chrome.mjs)
 *
 * startFakeServer({ ports, tvDir, phoneDir, seed }) → srv. Tests use srv
 * in-process: srv.world (mutable state), srv.fault(), srv.log, srv.violations,
 * srv.events, srv.reset(). Nothing is persisted; nothing leaves loopback. */
import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readRequest, qget, send, sendFile, sendFileShaped, serveStatic } from './http.mjs';
import { createWorld } from './seed.mjs';
import { createJellyfin, parseAuthHeader } from './jellyfin.mjs';
import { createReelApi, reelGuard, reelUser } from './reelapi.mjs';
import { loadSpec } from './spec.mjs';
import { loadReelSpec } from './reelspec.mjs';
import { ensureMedia } from './media.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const E2E_DIR = path.resolve(here, '..');

const SENT = Symbol('sent');

function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Retry-After');
  res.setHeader('Access-Control-Max-Age', '600');
}

export async function startFakeServer(opts = {}) {
  const spec = opts.spec === false ? null : loadSpec();
  const reelSpec = opts.reelSpec === false ? null : loadReelSpec();
  const srv = {
    spec,
    reelSpec,
    world: null,
    urls: {},
    ports: {},
    log: [],
    violations: [],
    notes: new Set(),
    known: new Set(),
    /* requests still open on any origin, and when the last one arrived:
     * the runner waits for quiet() before it judges a test's violations */
    inflight: 0,
    lastRequestAt: 0,
    async quiet({ ms = 100, max = 1500 } = {}) {
      const t0 = Date.now();
      while (Date.now() - t0 < max) {
        if (srv.inflight === 0 && Date.now() - srv.lastRequestAt >= ms) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    },
    events: [],
    faults: [],
    media: ensureMedia(),
    reset(seedOpts = opts.seed || {}) {
      srv.world = createWorld(seedOpts);
      srv.log.length = 0;
      srv.violations.length = 0;
      srv.events.length = 0;
      srv.faults.length = 0;
      srv.notes.clear();
      srv.known.clear();
      return srv.world;
    },
    /* A fault switch. match: { origin: 'jf'|'ml'|'pic'|'*', method, path: RegExp|string-prefix }.
     * effect: { status, json, text, delay (ms), hang (never answer), drop (destroy socket) }.
     * times: how many requests it hits (default: unlimited). Returns { remove(), hits }. */
    fault(match, effect = {}, times = Infinity) {
      const f = { match, effect, times, hits: 0, remove: () => (srv.faults = srv.faults.filter((x) => x !== f)) };
      srv.faults.push(f);
      return f;
    },
    approveQuickConnect(code, userName = 'alice') {
      const st = [...srv.world.quickConnect.values()].find((s) => s.Code === code);
      if (!st) throw new Error('no such Quick Connect code ' + code);
      st.Authenticated = true;
      st.userId = [...srv.world.users.values()].find((u) => u.Name === userName).Id;
    },
    /* the token a fresh sign-in would get, for tests that start signed in */
    issueToken(userName = 'alice', deviceId = 'e2e-device') {
      const u = [...srv.world.users.values()].find((x) => x.Name === userName);
      const token = 'tok' + Math.random().toString(16).slice(2) + Date.now().toString(16);
      srv.world.tokens.set(token, { userId: u.Id, deviceId, client: 'Reel', device: 'e2e' });
      return { token, userId: u.Id, userName: u.Name };
    },
    /* headers for a test's own request to the fake reel-api: its guard wants a
     * signed-in user's token, like the real one (a fresh token per call) */
    mlAuth(userName = 'alice') {
      return { Authorization: 'MediaBrowser Token="' + srv.issueToken(userName, 'e2e-direct').token + '"' };
    },
    requests(filter = {}) {
      return srv.log.filter((e) => (!filter.origin || e.origin === filter.origin) && (!filter.method || e.method === filter.method) && (!filter.path || (filter.path instanceof RegExp ? filter.path.test(e.path) : e.path.startsWith(filter.path))));
    },
    close: null
  };
  srv.reset();

  const jf = createJellyfin(srv);
  const ml = createReelApi(srv);
  srv.routers = { jf: jf.router, ml: ml.router };

  /* every route the fake implements must exist in 12.1 */
  if (spec) {
    const missing = jf.router.templates().filter((t) => !spec.has(...t.split(' ')));
    if (missing.length) throw new Error('fake Jellyfin registers routes absent from the 12.1 spec: ' + missing.join(', '));
  }
  /* …and every fake reel-api route must exist in reel-api's own OpenAPI */
  if (reelSpec) {
    const missing = ml.router.templates().filter((t) => !t.includes('/__fixture/') && !reelSpec.has(...t.split(' ')));
    if (missing.length) throw new Error("fake reel-api registers routes absent from reel-api's OpenAPI: " + missing.join(', '));
  }

  function applyFault(origin, req, res, pathname) {
    for (const f of srv.faults) {
      const m = f.match;
      if (f.hits >= f.times) continue;
      if (m.origin && m.origin !== '*' && m.origin !== origin) continue;
      if (m.method && m.method !== req.method) continue;
      if (m.path && !(m.path instanceof RegExp ? m.path.test(pathname) : pathname.startsWith(m.path))) continue;
      f.hits++;
      return f.effect;
    }
    return null;
  }

  function makeCtx(origin, req, res, r, entry) {
    const ctx = {
      origin, req, res, ...r, params: {}, auth: null, token: null, userId: null,
      q: (n) => qget(r.query, n),
      qb: (n, def) => {
        const v = qget(r.query, n);
        return v == null ? def : /^true$/i.test(v);
      },
      status(code, text = '') {
        if (code < 300) ctx.checkOut?.(code, undefined); // the declared status (e.g. 204) still has to match
        send(res, code, code === 204 ? undefined : text);
        return SENT;
      },
      json(code, obj) {
        ctx.checkOut?.(code, obj);
        send(res, code, obj);
        return SENT;
      },
      raw(code, body, type) {
        send(res, code, body, { 'Content-Type': type });
        return SENT;
      },
      image(buf, type = 'image/png') {
        send(res, 200, req.method === 'HEAD' ? '' : buf, { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000' });
        return SENT;
      },
      file(f, type) {
        sendFile(req, res, f, { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000' });
        return SENT;
      },
      /* the fixture video; { cut: true } = its first 20 s (a download that stopped there);
       * on Jellyfin, srv.world.streamShape (when set) throttles or holds it;
       * headers: extra response headers (reel-api's stream sends Cache-Control: no-store) */
      video({ cut = false, headers = {} } = {}) {
        const f = cut ? srv.media.cut : srv.media.webm;
        if (!f) {
          ctx.note('no fixture video (ffmpeg missing?)');
          return ctx.status(404, 'no fixture video');
        }
        // srv.world.streamShape: the Jellyfin stream through a throttle the test steers (http.mjs sendFileShaped)
        const shape = !cut && origin === 'jf' ? srv.world.streamShape : null;
        if (shape) sendFileShaped(req, res, f, { 'Content-Type': 'video/webm', ...headers }, shape);
        else sendFile(req, res, f, { 'Content-Type': 'video/webm', ...headers });
        return SENT;
      },
      violation(msg) {
        entry.violations.push(msg);
        srv.violations.push({ origin, method: r.method, path: r.pathname, msg });
      },
      note(msg) {
        srv.notes.add(msg);
      }
    };
    return ctx;
  }

  async function finish(ctx, out) {
    if (out === SENT || ctx.res.headersSent) return;
    if (out instanceof Promise) out = await out;
    if (out === SENT || ctx.res.headersSent) return;
    if (out === undefined) {
      ctx.checkOut?.(204, undefined);
      return send(ctx.res, 204);
    }
    ctx.checkOut?.(200, out);
    send(ctx.res, 200, out);
  }

  /* ---------------- Jellyfin pipeline ---------------- */
  async function handleJellyfin(req, res, pathname, origin = 'jf') {
    const r = await readRequest(req);
    r.pathname = pathname;
    const entry = { t: Date.now(), origin, host: req.headers.host, method: req.method, path: pathname, search: r.url.search, status: 0, violations: [] };
    srv.log.push(entry);
    // a play report's body stays on its log entry: a faulted one (never reaching the route) is still inspectable
    if (req.method === 'POST' && pathname.startsWith('/Sessions/Playing') && r.body) entry.body = r.body;
    res.on('finish', () => ((entry.status = res.statusCode), (entry.done = Date.now())));
    const ctx = makeCtx(origin, req, res, r, entry);

    if (spec) {
      for (const v of spec.validate(r, (kd, v) => srv.known.add(kd.id + ': ' + v))) ctx.violation(v);
      // the fake's own JSON answers must fit 12.1's response schemas
      ctx.checkOut = (code, obj) => {
        if (typeof obj === 'string' || Buffer.isBuffer(obj)) return; // text/binary, not JSON
        for (const v of spec.validateResponse(req.method, pathname, code, obj === undefined ? undefined : JSON.parse(JSON.stringify(obj)))) ctx.violation(v);
      };
    }

    // ---- auth ----
    const hAuth = req.headers.authorization;
    if (!hAuth && req.headers['x-emby-authorization']) {
      ctx.violation('legacy X-Emby-Authorization header (Jellyfin 12 reads only Authorization)');
      return ctx.status(400, "Value cannot be null. (Parameter 'request.App')");
    }
    if (req.headers['x-emby-token'] || req.headers['x-mediabrowser-token']) ctx.note('legacy X-Emby-Token/X-MediaBrowser-Token header seen');
    if (hAuth) {
      ctx.auth = parseAuthHeader(hAuth);
      if (!ctx.auth) {
        ctx.violation('Authorization header is not "MediaBrowser k=\\"v\\", …": ' + hAuth.slice(0, 40));
        return ctx.status(400, "Value cannot be null. (Parameter 'request.App')");
      }
      entry.auth = { Client: ctx.auth.Client, Device: ctx.auth.Device, DeviceId: ctx.auth.DeviceId, Version: ctx.auth.Version, token: !!ctx.auth.Token };
      const miss = ['Client', 'Device', 'DeviceId', 'Version'].filter((k) => !ctx.auth[k]);
      /* Measured on 12.1 (2026-10-05): `MediaBrowser Token="<valid>"` alone is
       * enough — Jellyfin takes Client/Device/… from the token's own session
       * (GET /Users/Me → 200; reel-api's guard asks exactly so). An invalid
       * token that way is a 401 (below), not the identity-less 400. */
      if (miss.length && ctx.auth.Token && Object.keys(ctx.auth).length === 1) {
        const known = srv.world.tokens.get(ctx.auth.Token);
        if (known) Object.assign(entry.auth, { Client: known.client, Device: known.device, DeviceId: known.deviceId });
      } else if (miss.length) {
        ctx.violation('Authorization header lacks ' + miss.join(', '));
        return ctx.status(400, "Value cannot be null. (Parameter 'request.App')");
      }
    }
    let token = ctx.auth?.Token || ctx.q('ApiKey');
    if (!token && r.query.has('api_key')) {
      token = r.query.get('api_key');
      ctx.note('legacy api_key= query auth on ' + pathname.replace(/[0-9a-f]{32}/g, '{id}'));
    }
    ctx.token = token || null;
    const rec = token ? srv.world.tokens.get(token) : null;
    if (rec) ctx.userId = rec.userId;

    const m = spec?.match(req.method, pathname);
    const anon = jf.anonymous(pathname, m ? (m.op ?? m.ops.get ?? null) : undefined);

    const fx = applyFault(origin, req, res, pathname);
    if (fx && (await effect(fx, res, entry))) return;

    if (!anon && !rec) return ctx.status(401, 'Unauthorized');

    const hit = jf.router.match(req.method, pathname);
    if (!hit || !hit.route) {
      if (m && m.op) {
        ctx.violation(`fake Jellyfin does not implement ${req.method} ${m.tpl} — add it to e2e/server/jellyfin.mjs`);
        return ctx.status(501, 'not implemented in the fake');
      }
      if (!spec) ctx.violation(`unknown Jellyfin route ${req.method} ${pathname}`);
      return ctx.status(404, ''); // Kestrel: no endpoint → 404 with an empty body
    }
    ctx.params = hit.params;
    try {
      await finish(ctx, hit.route.fn(ctx));
    } catch (e) {
      ctx.violation('fake Jellyfin crashed: ' + (e.stack || e));
      send(res, 500, 'fake crashed');
    }
  }

  /* ---------------- reel-api pipeline ---------------- */
  async function handleReelApi(req, res, pathname, origin = 'ml') {
    const r = await readRequest(req);
    r.pathname = pathname;
    const entry = { t: Date.now(), origin, host: req.headers.host, method: req.method, path: pathname, search: r.url.search, status: 0, violations: [] };
    srv.log.push(entry);
    res.on('finish', () => (entry.status = res.statusCode));
    const ctx = makeCtx(origin, req, res, r, entry);
    if (reelSpec) {
      for (const v of reelSpec.validate(r)) ctx.violation(v);
      // the fake's own answers must match models.py (via the OpenAPI)
      ctx.checkOut = (code, obj) => {
        if (typeof obj === 'string' || Buffer.isBuffer(obj)) return; // text/binary, not JSON
        for (const v of reelSpec.validateResponse(req.method, pathname, code, obj === undefined ? undefined : JSON.parse(JSON.stringify(obj)))) ctx.violation(v);
      };
    }
    // the request guard runs before everything else, as in the real service
    const denied = reelGuard(srv, req, r);
    if (denied) {
      if (denied.why) ctx.violation(denied.why);
      else ctx.note('reel-api guard: 401 for a token the fake Jellyfin does not know');
      return send(res, denied.status, { error: denied.error, detail: denied.detail }, { 'Cache-Control': 'no-store', ...(denied.status === 503 ? { 'Retry-After': '10' } : {}) });
    }
    ctx.user = reelUser(srv, req, r); // the guard's user (security.py User): { id, name, admin }
    const fx = applyFault(origin, req, res, pathname);
    if (fx && (await effect(fx, res, entry))) return;
    const hit = ml.router.match(req.method, pathname);
    if (!hit || !hit.route) {
      ctx.violation(`unknown reel-api route ${req.method} ${pathname}`);
      return ctx.json(404, { error: 'not_found', detail: 'Not Found' });
    }
    ctx.params = hit.params;
    try {
      await finish(ctx, hit.route.fn(ctx));
    } catch (e) {
      ctx.violation('fake reel-api crashed: ' + (e.stack || e));
      send(res, 500, { error: 'internal_error', detail: 'fake crashed' });
    }
  }

  /* → true when the fault answered the request */
  async function effect(fx, res, entry) {
    entry.fault = true;
    if (fx.delay) {
      await new Promise((r) => setTimeout(r, fx.delay));
      entry.released = Date.now(); // the held request goes on now (its client may have aborted it)
    }
    if (fx.hang) return true; // never answered; the socket closes with the server
    if (fx.drop) {
      res.socket?.destroy();
      return true;
    }
    if (fx.status) {
      send(res, fx.status, fx.json ?? fx.text ?? '', fx.headers || {});
      return true;
    }
    return false;
  }

  /* ---------------- picture-mode service ---------------- */
  /* state lives in the world (srv.world.pic), so srv.reset() restores it between tests */
  async function handlePic(req, res, pathname) {
    const r = await readRequest(req);
    const entry = { t: Date.now(), origin: 'pic', host: req.headers.host, method: req.method, path: pathname, search: r.url.search, status: 0, violations: [] };
    srv.log.push(entry);
    res.on('finish', () => (entry.status = res.statusCode));
    const fx = applyFault('pic', req, res, pathname);
    if (fx && (await effect(fx, res, entry))) return;
    if (pathname === '/health') return send(res, 200, { ok: true });
    const pic = srv.world.pic;
    if (pathname === '/modes') return send(res, 200, { returnValue: true, current: pic.current, modes: pic.modes, dimension: { dynamicRange: 'sdr' } });
    if (pathname === '/picture') {
      const mode = r.query.get('mode');
      if (mode) {
        if (!/^\w+$/.test(mode)) return send(res, 400, { returnValue: false, errorText: 'bad mode' });
        pic.current = mode;
        srv.events.push({ kind: 'picture', mode });
      }
      return send(res, 200, { returnValue: true, current: pic.current });
    }
    if (pathname === '/desc') return send(res, 200, { returnValue: true, desc: 'fake picture service' });
    entry.violations.push('unknown picture-service route');
    srv.violations.push({ origin: 'pic', method: req.method, path: pathname, msg: 'unknown picture-service route' });
    send(res, 404, { returnValue: false, errorText: 'not found' });
  }

  /* ---------------- listeners ---------------- */
  const tvDir = opts.tvDir, phoneDir = opts.phoneDir;
  /* a same-origin page for the harness to seed localStorage from before the app loads */
  const BLANK = '<!doctype html><meta charset="utf-8"><title>e2e</title><link rel="icon" href="data:,">';
  const handlers = {
    jf: (req, res, p) => handleJellyfin(req, res, p),
    ml: (req, res, p) => handleReelApi(req, res, p),
    pic: (req, res, p) => handlePic(req, res, p),
    tv: (req, res, p) => p === '/__e2e_blank' ? send(res, 200, BLANK, { 'Content-Type': 'text/html; charset=utf-8' }) : (tvDir && existsSync(tvDir) ? serveStatic(req, res, tvDir, p) : send(res, 503, 'TV build missing')),
    phone: (req, res, p) => {
      if (/^\/jf(\/|$)/.test(p)) return handleJellyfin(req, res, p.slice(3) || '/', 'jf');
      if (/^\/ml(\/|$)/.test(p)) return handleReelApi(req, res, p.slice(3) || '/', 'ml');
      if (p === '/__e2e_blank') return send(res, 200, BLANK, { 'Content-Type': 'text/html; charset=utf-8' });
      if (/^\/__/.test(p)) return send(res, 404, 'dev-only route ' + p + ' is not part of a build');
      return phoneDir && existsSync(phoneDir) ? serveStatic(req, res, phoneDir, p, { fallback: 'index.html' }) : send(res, 503, 'phone build missing');
    }
  };
  const servers = [];
  const sockets = new Set();
  for (const name of Object.keys(handlers)) {
    const s = http.createServer((req, res) => {
      srv.inflight++;
      srv.lastRequestAt = Date.now();
      res.once('close', () => {
        srv.inflight--;
        srv.lastRequestAt = Date.now();
      });
      cors(req, res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
      const p = new URL(req.url, 'http://x').pathname;
      Promise.resolve(handlers[name](req, res, p)).catch((e) => {
        srv.violations.push({ origin: name, method: req.method, path: p, msg: 'server error: ' + (e.stack || e) });
        send(res, 500, 'fake server error');
      });
    });
    s.keepAliveTimeout = 2000;
    s.on('connection', (c) => {
      sockets.add(c);
      c.on('close', () => sockets.delete(c));
    });
    const want = opts.ports?.[name] || 0;
    const port = await listen(s, want).catch(() => listen(s, 0));
    srv.ports[name] = port;
    srv.urls[name] = 'http://127.0.0.1:' + port;
    servers.push(s);
  }
  srv.close = () =>
    new Promise((resolve) => {
      for (const c of sockets) c.destroy();
      let n = servers.length;
      for (const s of servers) s.close(() => --n || resolve());
    });
  return srv;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => {
      server.off('listening', onOk);
      reject(e);
    };
    const onOk = () => {
      server.off('error', onErr);
      resolve(server.address().port);
    };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, '127.0.0.1');
  });
}
