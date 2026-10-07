import { defineConfig, loadEnv } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { phoneDev } from './dev/plugin.js';
import { licenses } from '../vite.licenses.js';

/* VibeReel Phone — the iPhone PWA build. See docs/ios/ARCHITECTURE.md.
 *
 *   npx vite build --config phone/vite.config.js          → phone/dist
 *   npx vite --config phone/vite.config.js --port 8900    → dev server
 *
 * Shares src/lib with the TV app; three TV modules are swapped for phone
 * replacements (moduleRedirects below), and `__PHONE__` is true here. */

const here = path.dirname(fileURLToPath(import.meta.url));   // phone/
const repo = path.resolve(here, '..');
const tvLib = path.join(repo, 'src/lib');
const phoneLib = path.join(here, 'src/lib');

/* Swap TV modules for phone ones *whatever the import specifier* — src/lib
 * imports them relatively ('./nav.svelte.js'), phone code via $lib. Matching
 * on the resolved absolute path catches both. */
const REDIRECTS = new Map([
  [path.join(tvLib, 'nav.svelte.js'), path.join(phoneLib, 'nav.svelte.js')],
  [path.join(tvLib, 'focus.js'), path.join(phoneLib, 'focus-shim.js')],
  [path.join(tvLib, 'lifecycle.js'), path.join(phoneLib, 'lifecycle.js')]
]);

const moduleRedirects = {
  name: 'phone-module-redirects',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!/(nav\.svelte|focus|lifecycle)(\.js)?$/.test(source)) return null;
    const r = await this.resolve(source, importer, { ...options, skipSelf: true });
    if (!r) return null;
    const clean = r.id.split('?')[0];
    const to = REDIRECTS.get(clean);
    return to ? to : null;
  }
};

/* Same as the TV build's lazy-libpgs (root vite.config.js, owned by the engine
 * workstream — copied, not imported): src/vendor/libpgs.js stays byte-identical
 * to upstream, its module body is wrapped into a `loadPgs()` factory that runs
 * on the first PGS attach. */
const lazyLibpgs = {
  name: 'lazy-libpgs',
  transform(code, id) {
    if (!/\/src\/vendor\/libpgs\.js(\?|$)/.test(id)) return null;
    const m = code.match(/export\s*\{\s*([\w$]+)\s+as\s+PgsRenderer\s*\};?\s*$/);
    if (!m) this.error('libpgs.js: unexpected export shape; update lazy-libpgs in phone/vite.config.js');
    return {
      code: 'let _pgs;export function loadPgs(){return _pgs||(_pgs=(function(){' +
        code.slice(0, m.index) + '\n;return ' + m[1] + '})())}',
      map: null
    };
  }
};

/* Dev only (serve mode): /__devcreds (from the gitignored phone/.devcreds.json),
 * the /__frame device-frame page and the mouse/safe-area/offline helpers
 * injected into index.html — see phone/dev/plugin.js and phone/DEV-CHROME.md.
 * Never part of a build. */

/* Build only: stamp <outDir>/sw.js with a version (hash of every shipped file)
 * and the precache list — see public/sw.js. The out dir is the *resolved* one
 * (PWA-17): `--outDir /tmp/x` must stamp /tmp/x/sw.js, never phone/dist's.
 * The launch images (public/splash/, PWA-01) are hashed into the version but
 * not precached: iOS reads them only when the app is added to the Home Screen
 * and never through the service worker, and 22 of them would only slow every
 * install. */
let outDir = path.join(here, 'dist');
const swPrecache = {
  name: 'sw-precache',
  apply: 'build',
  configResolved(c) {
    outDir = path.resolve(c.root, c.build.outDir);
  },
  closeBundle() {
    const dist = outDir;
    const sw = path.join(dist, 'sw.js');
    if (!existsSync(sw)) return;
    const files = [];
    const walk = (d) => {
      for (const f of readdirSync(d)) {
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(dist);
    const h = createHash('sha256');
    const list = [];
    for (const f of files.sort()) {
      const rel = '/' + path.relative(dist, f).split(path.sep).join('/');
      if (rel === '/sw.js' || rel.endsWith('.map') || rel.endsWith('OFL.txt') || rel === '/LICENSES.txt') continue;
      h.update(rel).update(readFileSync(f));
      if (!rel.startsWith('/splash/')) list.push(rel);
    }
    const version = h.digest('hex').slice(0, 12);
    const src = readFileSync(sw, 'utf8')
      .replace("const VERSION = 'dev';", `const VERSION = '${version}';`)
      .replace('const PRECACHE = [];', `const PRECACHE = ${JSON.stringify(list)};`);
    writeFileSync(sw, src);
  }
};

const strip = (prefix) => (p) => p.slice(prefix.length) || '/';
// regex keys: '/jf' alone would also swallow e.g. '/jfoo'

/* The dev server proxies /jf and /ml to the same Jellyfin and reel-api the TV
 * build points at: VITE_JELLYFIN_URL / VITE_MEDIALIB_URL from the repo root's
 * .env.local (see .env.example). */
const env = loadEnv('development', repo, 'VITE_');
const JF = env.VITE_JELLYFIN_URL || 'http://127.0.0.1:8096';
const ML = env.VITE_MEDIALIB_URL || JF.replace(/:\d+\/?$/, '') + ':8790';

export default defineConfig({
  root: here,
  envDir: repo,
  base: '/',
  publicDir: path.join(here, 'public'),
  plugins: [
    moduleRedirects,
    // No svelte.config.js for the phone: runes are Svelte 5's default and
    // nothing here needs a preprocessor (the repo root's config is the TV's).
    svelte({ configFile: false }),
    lazyLibpgs,
    phoneDev(),
    licenses,
    swPrecache
  ],
  define: { __PHONE__: true },
  resolve: {
    alias: {
      $lib: tvLib,
      $p: path.join(here, 'src')
    }
  },
  build: {
    target: 'safari17',
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
    assetsDir: 'assets'
  },
  server: {
    host: '127.0.0.1',
    port: 8900,
    strictPort: true,
    fs: { allow: [repo] },
    proxy: {
      '^/jf(/|$)': { target: JF, changeOrigin: true, ws: true, rewrite: strip('/jf') },
      '^/ml(/|$)': { target: ML, changeOrigin: true, rewrite: strip('/ml') }
    }
  },
  preview: {
    host: '127.0.0.1',
    proxy: {
      '^/jf(/|$)': { target: JF, changeOrigin: true, rewrite: strip('/jf') },
      '^/ml(/|$)': { target: ML, changeOrigin: true, rewrite: strip('/ml') }
    }
  }
});
