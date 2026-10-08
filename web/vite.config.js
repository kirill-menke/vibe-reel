import { defineConfig, loadEnv } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { webDev } from './dev/plugin.js';
import { licenses } from '../vite.licenses.js';
import { svelteConsts } from '../vite.svelte-consts.js';

/* VibeReel Web — the desktop browser build (Chrome, Firefox; mouse + keyboard).
 *
 *   npx vite build --config web/vite.config.js     → web/dist (hashed assets)
 *   npx vite --config web/vite.config.js           → dev server, http://127.0.0.1:8910
 *
 * It is the iPhone PWA's shell, screens and shared src/lib under a desktop
 * layer: the phone's module redirects (nav → phone router shim, focus → no-op
 * shim, lifecycle → web/src/lib/lifecycle.js) plus a few phone modules swapped
 * for desktop variants (WEB_SWAPS below). `__PHONE__` and `__WEB__` are both
 * true here; the TV and phone builds never see `__WEB__` code paths. Shared
 * code says what differs on the desktop in `__WEB__` branches inside its
 * `__PHONE__` ones (src/lib/api.js and config.js: Jellyfin lists this client as
 * "VibeReel Web" on "Web", DeviceIds start `reelweb-`); in Svelte markup a
 * `{__WEB__ ? '…' : '…'}` folds to plain text before compiling
 * (vite.svelte-consts.js), so the phone bundle stays byte-identical. */

const here = path.dirname(fileURLToPath(import.meta.url)); // web/
const repo = path.resolve(here, '..');
const tvLib = path.join(repo, 'src/lib');
const phone = path.join(repo, 'phone/src');
const web = path.join(here, 'src');

/* Resolved-path redirects, whatever the import specifier (src/lib imports
 * nav/focus/lifecycle relatively, phone code imports its own modules
 * relatively or via $p) — as phone/vite.config.js does for the first three. */
const REDIRECTS = new Map([
  // the phone build's three
  [path.join(tvLib, 'nav.svelte.js'), path.join(phone, 'lib/nav.svelte.js')],
  [path.join(tvLib, 'focus.js'), path.join(phone, 'lib/focus-shim.js')],
  [path.join(tvLib, 'lifecycle.js'), path.join(web, 'lib/lifecycle.js')],
  // WEB_SWAPS: phone-only machinery the desktop doesn't have (offline copies,
  // the Home snapshot, push, eviction restore) → inert stand-ins
  [path.join(phone, 'lib/offline.svelte.js'), path.join(web, 'stubs/offline.svelte.js')],
  [path.join(phone, 'lib/homesnap.svelte.js'), path.join(web, 'stubs/homesnap.svelte.js')],
  [path.join(phone, 'lib/push.js'), path.join(web, 'stubs/push.js')],
  [path.join(phone, 'lib/restore.svelte.js'), path.join(web, 'stubs/restore.svelte.js')],
  // desktop variants of phone components (same props)
  [path.join(phone, 'lib/gestures.js'), path.join(web, 'lib/gestures.js')],
  [path.join(phone, 'components/Sheet.svelte'), path.join(web, 'components/Sheet.svelte')],
  [path.join(phone, 'components/TopBar.svelte'), path.join(web, 'components/TopBar.svelte')],
  [path.join(phone, 'components/Rail.svelte'), path.join(web, 'components/Rail.svelte')],
  // the pushed pages' header lives in WebNav (the one desktop bar)
  [path.join(phone, 'components/NavBar.svelte'), path.join(web, 'components/NavBar.svelte')]
]);
/* a variant that wraps the phone original imports it under its real path */
const WRAPPERS = new Set([path.join(web, 'lib/gestures.js')]);
const NAMES = /(nav\.svelte|focus|lifecycle|offline\.svelte|homesnap\.svelte|push|restore\.svelte|gestures|Sheet\.svelte|TopBar\.svelte|Rail\.svelte|NavBar\.svelte)(\.js)?$/;

const moduleRedirects = {
  name: 'web-module-redirects',
  enforce: /** @type {const} */ ('pre'),
  /** @param {string} source @param {string | undefined} importer @param {any} options */
  async resolveId(source, importer, options) {
    if (!NAMES.test(source)) return null;
    if (importer && WRAPPERS.has(importer.split('?')[0])) return null;
    const r = await this.resolve(source, importer, { ...options, skipSelf: true });
    if (!r) return null;
    return REDIRECTS.get(r.id.split('?')[0]) || null;
  }
};

/* libpgs: the same lazy wrapper as the TV and phone builds (copied, as the
 * phone config does): src/vendor/libpgs.js stays byte-identical to upstream and
 * runs on the first PGS attach. */
const lazyLibpgs = {
  name: 'lazy-libpgs',
  /** @param {string} code @param {string} id */
  transform(code, id) {
    if (!/\/src\/vendor\/libpgs\.js(\?|$)/.test(id)) return null;
    const m = code.match(/export\s*\{\s*([\w$]+)\s+as\s+PgsRenderer\s*\};?\s*$/);
    if (!m) this.error('libpgs.js: unexpected export shape; update lazy-libpgs in web/vite.config.js');
    return {
      code: 'let _pgs;export function loadPgs(){return _pgs||(_pgs=(function(){' +
        code.slice(0, m.index) + '\n;return ' + m[1] + '})())}',
      map: null
    };
  }
};

/* The phone's public/ (fonts, favicon) is shared; what only an installed iPhone
 * app reads — the service worker, launch images, manifest and touch icons —
 * is dropped from web/dist (no service worker for the web MVP). */
let outDir = path.join(here, 'dist');
const prunePublic = {
  name: 'web-prune-public',
  apply: /** @type {const} */ ('build'),
  /** @param {import('vite').ResolvedConfig} c */
  configResolved(c) {
    outDir = path.resolve(c.root, c.build.outDir);
  },
  closeBundle() {
    for (const p of ['sw.js', 'splash', 'manifest.webmanifest', 'icons/apple-touch-icon.png', 'icons/icon-maskable-192.png', 'icons/icon-maskable-512.png'])
      rmSync(path.join(outDir, p), { recursive: true, force: true });
  }
};

const strip = (/** @type {string} */ prefix) => (/** @type {string} */ p) => p.slice(prefix.length) || '/';
const env = loadEnv('development', repo, 'VITE_');
const JF = env.VITE_JELLYFIN_URL || 'http://127.0.0.1:8096';
const ML = env.VITE_MEDIALIB_URL || JF.replace(/:\d+\/?$/, '') + ':8790';

export default defineConfig({
  root: here,
  envDir: repo,
  base: '/',
  publicDir: path.join(repo, 'phone/public'),
  plugins: [moduleRedirects, svelteConsts({ __WEB__: true }), svelte({ configFile: false }), lazyLibpgs, webDev(), licenses, prunePublic],
  define: { __PHONE__: true, __WEB__: true },
  resolve: {
    alias: {
      $lib: tvLib,
      $p: phone,
      $w: web
    }
  },
  build: {
    target: 'es2022',
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
    assetsDir: 'assets'
  },
  server: {
    host: '127.0.0.1',
    port: 8910,
    strictPort: true,
    fs: { allow: [repo] },
    proxy: {
      '^/jf(/|$)': { target: JF, changeOrigin: true, ws: true, rewrite: strip('/jf') },
      '^/ml(/|$)': { target: ML, changeOrigin: true, rewrite: strip('/ml') }
    }
  },
  preview: {
    host: '127.0.0.1',
    port: 8911,
    proxy: {
      '^/jf(/|$)': { target: JF, changeOrigin: true, rewrite: strip('/jf') },
      '^/ml(/|$)': { target: ML, changeOrigin: true, rewrite: strip('/ml') }
    }
  }
});
