/* Dev-server-only helpers for the web build (`apply: 'serve'`: nothing here
 * exists in web/dist).
 *
 *   GET /__devcreds   the dev account from phone/.devcreds.json (gitignored;
 *                     `phone/dev-chrome.sh login` creates it) — what `/?devlogin`
 *                     signs in with (web/src/main.js → $p/lib/devlogin.js).
 *   GET /net.json     404, as a missing file on a dev box: the quality default
 *                     stays Original. REEL_DEV_NET=lan|tunnel answers like the NAS
 *                     ({"via": …}) to try the tunnel default.
 *   playback guard    the same rule as the phone's dev client, but server-side so
 *                     it also covers <video> and keepalive requests: PlaybackInfo
 *                     and Sessions/Playing* answer 403 (they record a play on the
 *                     real server). REEL_DEV_ALLOWPLAY=1 lets them through.
 *   read-only mode    REEL_DEV_READONLY=1: every non-GET to /jf or /ml answers 403
 *                     (played, add, Get, cancel, hide, delete …) except Jellyfin's
 *                     sign-in and starting a trailer — for poking at the real
 *                     server without touching it. */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)); // web/dev
const DEVCREDS_FILE = path.join(here, '..', '..', 'phone', '.devcreds.json');
const PLAY_RE = /^\/jf\/(Items\/[^/]+\/PlaybackInfo|Sessions\/Playing)(\/|$|\?)/i;
const SIGN_IN_RE = /^\/jf\/Users\/AuthenticateByName(\?|$)/i;
// trailers: a POST starts reel-api's fetch of the YouTube trailer — no user data changes
const TRAILER_RE = /^\/ml\/api\/trailers\//;

/** @param {import('node:http').ServerResponse} res @param {string} why */
function refuse(res, why) {
  res.statusCode = 403;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('web dev server: ' + why + ' (web/dev/plugin.js)');
}

export function webDev() {
  return {
    name: 'web-dev',
    apply: /** @type {const} */ ('serve'),
    /** @param {import('vite').ViteDevServer} server */
    configureServer(server) {
      // before Vite's own middlewares (proxy included)
      server.middlewares.use((req, res, next) => {
        const url = req.url || '';
        const p = url.split('?')[0];
        if (p === '/__devcreds') {
          if (!existsSync(DEVCREDS_FILE)) {
            res.statusCode = 404;
            return res.end();
          }
          try {
            let v = JSON.parse(readFileSync(DEVCREDS_FILE, 'utf8'));
            if (typeof v === 'string') v = JSON.parse(v);
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            return res.end(JSON.stringify({ token: v.token, userId: v.userId, userName: v.userName, deviceId: v.deviceId || undefined }));
          } catch {
            res.statusCode = 500;
            return res.end();
          }
        }
        if (p === '/net.json') {
          const via = process.env.REEL_DEV_NET;
          if (via !== 'lan' && via !== 'tunnel') {
            res.statusCode = 404;
            return res.end();
          }
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          return res.end(JSON.stringify({ via }));
        }
        if (PLAY_RE.test(url) && process.env.REEL_DEV_ALLOWPLAY !== '1') {
          server.config.logger.warn('[web-dev] blocked real playback call ' + p + ' (REEL_DEV_ALLOWPLAY=1 lets it through)');
          return refuse(res, 'real playback is blocked');
        }
        if (process.env.REEL_DEV_READONLY === '1' && /^\/(jf|ml)(\/|$)/.test(p) && req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && !SIGN_IN_RE.test(p) && !TRAILER_RE.test(p)) {
          server.config.logger.warn('[web-dev] read-only: blocked ' + req.method + ' ' + p);
          return refuse(res, 'read-only mode');
        }
        next();
      });
    }
  };
}
