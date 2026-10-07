/* Small node:http helpers shared by the fake servers. */
import { createReadStream, existsSync, statSync, promises as fsp } from 'node:fs';
import path from 'node:path';

export async function readRequest(req) {
  const url = new URL(req.url, 'http://x');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const rawBody = Buffer.concat(chunks);
  let body;
  if (rawBody.length) {
    const ct = req.headers['content-type'] || '';
    if (ct.includes('json')) {
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        body = undefined;
      }
    }
  }
  return { method: req.method, url, pathname: url.pathname, query: url.searchParams, headers: req.headers, rawBody, body };
}

/* Case-insensitive query getter, like ASP.NET's binder. */
export function qget(query, name) {
  const n = name.toLowerCase();
  for (const [k, v] of query) if (k.toLowerCase() === n) return v;
  return null;
}

export function send(res, status, body, headers = {}) {
  if (res.headersSent || res.destroyed) return;
  let data = body;
  const h = { ...headers };
  if (body === undefined || body === null) {
    data = '';
  } else if (Buffer.isBuffer(body) || typeof body === 'string') {
    h['Content-Type'] ||= typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/octet-stream';
  } else {
    data = JSON.stringify(body);
    h['Content-Type'] ||= 'application/json; charset=utf-8';
  }
  h['Content-Length'] = Buffer.byteLength(data);
  res.writeHead(status, h);
  res.end(data);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.vtt': 'text/vtt', '.m3u8': 'application/vnd.apple.mpegurl', '.m4s': 'video/iso.segment',
  '.ico': 'image/x-icon', '.map': 'application/json'
};

export function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/* Serve one file with Range support (video). */
export function sendFile(req, res, file, headers = {}) {
  if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'not found');
  const size = statSync(file).size;
  const h = { 'Content-Type': headers['Content-Type'] || mimeOf(file), 'Accept-Ranges': 'bytes', ...headers };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
    let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : size - 1;
    if (start >= size || start < 0) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}`, ...h });
      return res.end();
    }
    end = Math.min(end, size - 1);
    res.writeHead(206, { ...h, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...h, 'Content-Length': size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

/* sendFile() through a throttle the test steers live (srv.world.streamShape):
 *   free  absolute byte offset up to which bytes go out at full speed
 *   burst a request starting at or past `free` (a seek, a Retry) first gets this
 *         many bytes at full speed
 *   bps   bytes per second after it; 0 = hold (the connection stays open and silent)
 *   tail  the last `tail` bytes (default 64 KiB: the WebM Cues) are always free,
 *         so a seek index read at the start never waits behind the throttle
 * The shape is read on every 100 ms step, so changing bps/free mid-response
 * takes effect at once. Counters the test can read: requests, ranges (Range headers), sent (bytes), pos
 * (the highest offset delivered). */
export function sendFileShaped(req, res, file, headers, shape) {
  if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'not found');
  const size = statSync(file).size;
  const h = { 'Content-Type': headers['Content-Type'] || mimeOf(file), 'Accept-Ranges': 'bytes', ...headers };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0, end = size - 1;
  if (range) {
    start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
    end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start < 0) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}`, ...h });
      return res.end();
    }
    res.writeHead(206, { ...h, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  } else res.writeHead(200, { ...h, 'Content-Length': size });
  shape.requests = (shape.requests || 0) + 1;
  (shape.ranges ||= []).push(req.headers.range || 'all');
  if (req.method === 'HEAD') return res.end();
  let closed = false;
  res.on('close', () => (closed = true));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    const fh = await fsp.open(file, 'r');
    try {
      let pos = start, credit = 0;
      // a request that starts past `free` (a seek) gets `burst` bytes at full speed first
      const fast = Math.max(shape.free || 0, start >= (shape.free || 0) ? start + (shape.burst || 0) : 0);
      while (pos <= end && !closed) {
        const tail = size - (shape.tail ?? 65536);
        let n;
        if (pos < fast || pos < (shape.free || 0)) n = Math.min(end + 1, Math.max(fast, shape.free || 0), pos + 65536) - pos;
        else if (pos >= tail) n = Math.min(end + 1, pos + 65536) - pos;
        else {
          await wait(100);
          if (!(shape.bps > 0)) continue; // hold
          credit += shape.bps / 10;
          n = Math.min(Math.floor(credit), end + 1 - pos);
          if (n <= 0) continue;
          credit -= n;
        }
        const buf = Buffer.alloc(n);
        const { bytesRead } = await fh.read(buf, 0, n, pos);
        if (!bytesRead) break;
        pos += bytesRead;
        shape.sent = (shape.sent || 0) + bytesRead;
        shape.pos = Math.max(shape.pos || 0, pos);
        if (closed) break;
        if (!res.write(buf.subarray(0, bytesRead))) await new Promise((r) => (res.once('drain', r), res.once('close', r)));
      }
      if (!closed) res.end();
    } finally {
      await fh.close();
    }
  })().catch(() => res.destroy());
}

/* Static directory server; `fallback` (e.g. 'index.html') for SPA routes. */
export function serveStatic(req, res, root, pathname, { fallback = null, headers = {} } = {}) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(root, rel);
  if (!file.startsWith(path.resolve(root) + path.sep)) return send(res, 403, 'forbidden');
  if (existsSync(file) && statSync(file).isFile()) {
    const extra = /(?:^|\/)(index\.html|sw\.js)$/.test(rel) ? { 'Cache-Control': 'no-cache' } : {};
    return sendFile(req, res, file, { ...extra, ...headers });
  }
  if (fallback && !path.extname(rel)) return sendFile(req, res, path.join(root, fallback), { 'Cache-Control': 'no-cache', ...headers });
  return send(res, 404, 'not found: ' + pathname);
}

/* Route table keyed by OpenAPI-style templates ('/Items/{itemId}'). */
export class Router {
  constructor() {
    this.routes = [];
  }
  add(method, tpl, fn) {
    const names = [];
    const re = tpl.replace(/\{([^}]+)\}|([^{]+)/g, (_, p, lit) => {
      if (p) {
        names.push(p);
        return '([^/]+)';
      }
      return lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    });
    const literal = tpl.split('/').filter((s) => s && !s.includes('{')).length;
    for (const m of method.split(',')) this.routes.push({ method: m, tpl, fn, names, re: new RegExp('^' + re + '$', 'i'), literal });
    this.routes.sort((a, b) => b.literal - a.literal);
    return this;
  }
  match(method, pathname) {
    let pathHit = null;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathHit = r;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const params = {};
      r.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
      return { route: r, params };
    }
    return pathHit ? { route: null, pathOnly: pathHit } : null;
  }
  templates() {
    return [...new Set(this.routes.map((r) => r.method + ' ' + r.tpl))];
  }
}
