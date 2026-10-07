/* Dev-server-only helpers for driving the phone app from desktop Chrome
 * (see phone/DEV-CHROME.md). `apply: 'serve'`: nothing here exists in a build.
 *
 *   GET /__devcreds   the dev account from phone/.devcreds.json (gitignored;
 *                     `phone/dev-chrome.sh login` creates it) → token, userId,
 *                     userName (+ deviceId when the file has one). 404 if absent.
 *   GET /__frame      the device-frame page (phone/dev/frame.html)
 *   index.html        gets <script type="module" src="/dev/client.js"> — mouse →
 *                     touch, right-click = long-press, ?safe=, reduced motion,
 *                     offline simulation, window.__reelDev. */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)); // phone/dev
export const DEVCREDS_FILE = path.join(here, '..', '.devcreds.json');

export function phoneDev() {
  return {
    name: 'phone-dev',
    apply: 'serve',
    /* REEL_DEV_HMR=0 (phone/dev-chrome.sh with HMR=0): no HMR socket, so
     * other agents' edits to phone/ or src/lib don't reload — and reset — the
     * page you're driving. Reload by hand to pick up changes. */
    config() {
      if (process.env.REEL_DEV_HMR === '0') return { server: { hmr: false, ws: false } };
    },
    configureServer(server) {
      server.middlewares.use('/__devcreds', (req, res) => {
        if (!existsSync(DEVCREDS_FILE)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        try {
          let v = JSON.parse(readFileSync(DEVCREDS_FILE, 'utf8'));
          if (typeof v === 'string') v = JSON.parse(v);
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ token: v.token, userId: v.userId, userName: v.userName, deviceId: v.deviceId || undefined }));
        } catch {
          res.statusCode = 500;
          res.end();
        }
      });
      server.middlewares.use((req, res, next) => {
        const u = (req.url || '').split('?')[0];
        if (u !== '/__frame' && u !== '/__frame/') return next();
        try {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(readFileSync(path.join(here, 'frame.html'), 'utf8'));
        } catch (e) {
          res.statusCode = 500;
          res.end(String(e));
        }
      });
    },
    transformIndexHtml: {
      order: 'pre',
      handler() {
        return [{ tag: 'script', attrs: { type: 'module', src: '/dev/client.js' }, injectTo: 'head' }];
      }
    }
  };
}
