/* The recording proxy in front of the real Jellyfin, and the environment the
 * browser scenarios run in.
 *
 *   jf     http://127.0.0.1:<p>  → the real Jellyfin, every request recorded and
 *          validated against THAT server's own OpenAPI (e2e/server/spec.mjs's Spec,
 *          incl. EXTRA_ROUTES / KNOWN_DEVIATIONS), plus the legacy-auth checks
 *          (X-Emby-Authorization, api_key= on Trickplay). Any 4xx/5xx answer to an
 *          app request is a violation too (tests list the ones they provoke).
 *   phone  the phone build + /jf (→ the same recorder) + /ml (→ the fake reel-api),
 *          one origin like production
 *   ml     → the fake reel-api, through its request guard's one real-world step: a
 *          token is admitted only after the REAL Jellyfin confirms it (GET /Users/Me
 *          with a Token-only header, as backend/src/reel_api/security.py asks) —
 *          the apps hold real-server tokens, which the fake's own guard can't know
 *   tv/pic the e2e harness's fake server (reel-api isn't what this run tests)
 *
 * startRealEnv({ jfTarget, spec, tvDir, phoneDir }) → srv, shaped like the fake
 * server as far as e2e/lib/runner.mjs needs it (reset, quiet, log, violations,
 * notes, known, requests, urls), so the harness's own runner, Page and Chrome
 * guard are reused unchanged. Requests the harness makes itself (setup, the
 * contract probe's admin calls) don't go through here. */
import http from 'node:http';
import { existsSync } from 'node:fs';
import { send, serveStatic } from '../../e2e/server/http.mjs';
import { startFakeServer } from '../../e2e/server/index.mjs';
import { tokenFrom } from '../../e2e/server/reelapi.mjs';

const MAX_JSON = 4 << 20;

export function parseAuth(h) {
  if (!h || !/^MediaBrowser\s/i.test(h)) return null;
  const out = {};
  for (const m of h.slice(11).matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/* One recording reverse proxy. onEntry(entry) after the answer is complete. */
export function createRecorder({ target, spec, record }) {
  const up = new URL(target);
  return function handle(req, res, pathname, search, origin = 'jf') {
    const entry = { t: Date.now(), origin, method: req.method, path: pathname, search, status: 0, violations: [], known: [] };
    const violation = (msg) => entry.violations.push(msg);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const ct = req.headers['content-type'] || '';
      let body;
      if (raw.length && ct.includes('json')) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          violation('request body is not valid JSON');
        }
      }
      entry.body = body;
      // ---- auth form ----
      const a = req.headers.authorization;
      if (req.headers['x-emby-authorization']) violation('legacy X-Emby-Authorization header (Jellyfin 12 reads only Authorization)');
      if (req.headers['x-emby-token'] || req.headers['x-mediabrowser-token']) violation('legacy X-Emby-Token/X-MediaBrowser-Token header');
      if (a) {
        const p = parseAuth(a);
        if (!p) violation('Authorization header is not "MediaBrowser k=\\"v\\", …"');
        else {
          entry.auth = { Client: p.Client, Device: p.Device, DeviceId: p.DeviceId, Version: p.Version, token: !!p.Token };
          const miss = ['Client', 'Device', 'DeviceId', 'Version'].filter((k) => !p[k]);
          if (miss.length) violation('Authorization header lacks ' + miss.join(', '));
        }
      }
      const q = new URLSearchParams(search);
      if (/\/Trickplay\//i.test(pathname) && q.has('api_key')) violation('api_key= on a Trickplay sheet (12.1 answers 401; the client must send ApiKey=)');
      // ---- the live spec ----
      if (spec) for (const v of spec.validate({ method: req.method, pathname, query: q, body, rawBody: raw }, (kd, v) => entry.known.push(kd.id + ': ' + v))) violation(v);

      const headers = { ...req.headers, host: up.host };
      delete headers.origin;
      delete headers.referer;
      delete headers['accept-encoding']; // plain bodies, so JSON answers can be recorded
      const pr = http.request({ host: up.hostname, port: up.port, method: req.method, path: pathname + search, headers }, (ur) => {
        entry.status = ur.statusCode;
        const h = { ...ur.headers };
        for (const k of Object.keys(h)) if (k.startsWith('access-control-')) delete h[k];
        h['access-control-allow-origin'] = '*';
        h['access-control-expose-headers'] = 'Content-Range, Content-Length, Accept-Ranges, Retry-After';
        entry.ctype = ur.headers['content-type'] || '';
        entry.contentRange = ur.headers['content-range'] || null;
        const keep = /json/.test(entry.ctype) && Number(ur.headers['content-length'] || 0) < MAX_JSON;
        const got = [];
        let size = 0;
        res.writeHead(ur.statusCode, h);
        ur.on('data', (c) => {
          size += c.length;
          if (keep && size < MAX_JSON) got.push(c);
        });
        ur.pipe(res);
        ur.on('end', () => {
          entry.bytes = size;
          if (keep && got.length) {
            try {
              entry.json = JSON.parse(Buffer.concat(got).toString('utf8'));
            } catch {}
          }
          if (entry.status >= 400) violation(`real Jellyfin answered ${entry.status} to ${req.method} ${pathname}${search.length > 1 ? search.slice(0, 160) : ''}`);
          record(entry);
        });
        ur.on('error', () => record(entry));
      });
      pr.on('error', (e) => {
        entry.status = 502;
        violation('proxy: upstream error ' + e.message);
        record(entry);
        send(res, 502, 'upstream error');
      });
      res.on('close', () => {
        if (!res.writableFinished) {
          entry.aborted = true;
          pr.destroy();
          if (!entry.status) record(entry);
        }
      });
      pr.end(raw.length ? raw : undefined);
    });
  };
}

function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

const BLANK = '<!doctype html><meta charset="utf-8"><title>e2e</title><link rel="icon" href="data:,">';

export async function startRealEnv({ jfTarget, spec, tvDir, phoneDir, ports = {} }) {
  const fake = await startFakeServer({ ports: { ml: ports.mlFake, tv: ports.tv, pic: ports.pic }, tvDir, phoneDir, seed: { preset: 'empty' } });
  const own = { log: [], violations: [], known: new Set(), inflight: 0, lastRequestAt: 0 };
  const record = (e) => {
    if (e.recorded) return;
    e.recorded = true;
    own.log.push(e);
    for (const msg of e.violations) own.violations.push({ origin: e.origin, method: e.method, path: e.path, msg });
    for (const k of e.known) own.known.add(k);
  };
  const recorder = createRecorder({ target: jfTarget, spec, record });
  const mlTarget = new URL(fake.urls.ml);
  /* reel-api's guard (security.py) asks Jellyfin who a token belongs to. The fake
   * reel-api's guard knows only the fake Jellyfin's tokens; here the real server
   * answers, once per token, and a confirmed token joins the fake's world (again
   * after every reset). A token the real server refuses stays unknown: 401, as in
   * production. */
  const confirmed = new Map(); // token → Promise<user id | null>
  const admit = async (req, search) => {
    const token = tokenFrom(req.headers, new URLSearchParams(search));
    if (!token) return;
    if (!confirmed.has(token)) {
      confirmed.set(token, fetch(jfTarget + '/Users/Me', { headers: { Authorization: `MediaBrowser Token="${token}"` }, signal: AbortSignal.timeout(5000) })
        .then(async (r) => (r.status === 200 ? (await r.json()).Id || null : null))
        .catch(() => null));
    }
    const uid = await confirmed.get(token);
    if (uid && !fake.world.tokens.has(token)) fake.world.tokens.set(token, { userId: uid, deviceId: 'real-jellyfin', client: 'Reel', device: 'real Jellyfin' });
  };
  const forwardMl = async (req, res, p, search) => {
    await admit(req, search);
    const pr = http.request({ host: mlTarget.hostname, port: mlTarget.port, method: req.method, path: p + search, headers: { ...req.headers, host: mlTarget.host } }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    });
    pr.on('error', () => send(res, 502, 'fake reel-api unreachable'));
    req.pipe(pr);
  };
  const servers = [];
  const sockets = new Set();
  const mk = async (name, handler, port) => {
    const s = http.createServer((req, res) => {
      own.inflight++;
      own.lastRequestAt = Date.now();
      res.once('close', () => {
        own.inflight--;
        own.lastRequestAt = Date.now();
      });
      cors(req, res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
      const u = new URL(req.url, 'http://x');
      handler(req, res, u.pathname, u.search);
    });
    s.keepAliveTimeout = 2000;
    s.on('connection', (c) => {
      sockets.add(c);
      c.on('close', () => sockets.delete(c));
    });
    servers.push(s);
    return listen(s, port).catch(() => listen(s, 0));
  };
  const jfPort = await mk('jf', (req, res, p, search) => recorder(req, res, p, search, 'jf'), ports.jf);
  const mlPort = await mk('ml', (req, res, p, search) => forwardMl(req, res, p, search), ports.ml);
  const phonePort = await mk('phone', (req, res, p, search) => {
    if (/^\/jf(\/|$)/.test(p)) return recorder(req, res, p.slice(3) || '/', search, 'jf');
    if (/^\/ml(\/|$)/.test(p)) return forwardMl(req, res, p.slice(3) || '/', search);
    if (p === '/__e2e_blank') return send(res, 200, BLANK, { 'Content-Type': 'text/html; charset=utf-8' });
    if (/^\/__/.test(p)) return send(res, 404, 'not part of a build');
    return phoneDir && existsSync(phoneDir) ? serveStatic(req, res, phoneDir, p, { fallback: 'index.html' }) : send(res, 503, 'phone build missing');
  }, ports.phone);

  const srv = {
    fake,
    spec,
    urls: { jf: 'http://127.0.0.1:' + jfPort, phone: 'http://127.0.0.1:' + phonePort, ml: 'http://127.0.0.1:' + mlPort, tv: fake.urls.tv, pic: fake.urls.pic },
    ports: { jf: jfPort, phone: phonePort, ml: mlPort, mlFake: fake.ports.ml, tv: fake.ports.tv, pic: fake.ports.pic },
    /* everything both sides saw, oldest first */
    get log() {
      return [...own.log, ...fake.log.filter((e) => e.origin !== 'jf')].sort((a, b) => a.t - b.t);
    },
    get violations() {
      return [...own.violations, ...fake.violations];
    },
    get known() {
      return new Set([...own.known, ...fake.known]);
    },
    get notes() {
      return fake.notes;
    },
    get inflight() {
      return own.inflight + fake.inflight;
    },
    /* only the real Jellyfin's traffic (what the scenarios assert on) */
    jfLog: own.log,
    allJf: [],
    async quiet({ ms = 100, max = 1500 } = {}) {
      const t0 = Date.now();
      while (Date.now() - t0 < max) {
        if (srv.inflight === 0 && Date.now() - Math.max(own.lastRequestAt, fake.lastRequestAt) >= ms) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    },
    reset(seedOpts) {
      srv.allJf.push(...own.log); // the spec diff reads the whole run's traffic
      own.log.length = 0;
      own.violations.length = 0;
      own.known.clear();
      fake.reset({ preset: 'empty', ...(seedOpts || {}) });
    },
    requests(filter = {}) {
      return own.log.filter((e) => (!filter.method || e.method === filter.method) && (!filter.path || (filter.path instanceof RegExp ? filter.path.test(e.path) : e.path.startsWith(filter.path))));
    },
    async close() {
      for (const c of sockets) c.destroy();
      await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
      await fake.close();
    }
  };
  return srv;
}
