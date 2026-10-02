import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { licenses } from './vite.licenses.js';

/* The TV runs Chromium 120.0.6099.270 / V8 12.0 (webOS 10.3.1).
 * Target it exactly: no point down-levelling further, and nothing newer is safe.
 *
 * Output filenames are pinned to app.js / style.css rather than hashed. The app
 * is unpacked straight into the TV's app directory and relaunched, so there is
 * no cache to bust — and deploy.sh verifies the deploy by md5-comparing exactly
 * those two names against the TV. Hashed bundles would break that check. */
/* Vite stamps crossorigin="" on the emitted <script>/<link>. WAM loads the app
 * from a local scheme, not http, where that attribute can only turn a plain
 * fetch into a CORS-checked one — there is nothing cross-origin here to guard.
 * Strip it. */
const stripCrossorigin = {
  name: 'strip-crossorigin',
  transformIndexHtml(html) {
    return html.replace(/\s+crossorigin(?=[\s>])/g, '');
  }
};

/* src/vendor/libpgs.js stays byte-identical to upstream, but its module body
 * (bundled core-js ponyfills + the renderer classes) cost ~20 ms of top-level
 * evaluation on every cold start (measured on the C4), for something only a
 * PGS subtitle ever needs. Rewrite it at build time into one lazy factory,
 * `loadPgs()` → PgsRenderer, run on first use. Same bundle, no extra chunk.
 * The only global it touches is `__core-js_shared__`, so deferring is safe. */
const lazyLibpgs = {
  name: 'lazy-libpgs',
  transform(code, id) {
    if (!/\/src\/vendor\/libpgs\.js(\?|$)/.test(id)) return null;
    const m = code.match(/export\s*\{\s*([\w$]+)\s+as\s+PgsRenderer\s*\};?\s*$/);
    if (!m) this.error('libpgs.js: unexpected export shape; update lazy-libpgs in vite.config.js');
    return {
      code: 'let _pgs;export function loadPgs(){return _pgs||(_pgs=(function(){' +
        code.slice(0, m.index) + '\n;return ' + m[1] + '})())}',
      map: null
    };
  }
};

export default defineConfig({
  plugins: [svelte(), stripCrossorigin, lazyLibpgs, licenses],
  // Shared src/lib code branches on __PHONE__ for the iPhone PWA (phone/vite.config.js
  // defines it true); here it is a constant false, so every phone branch is dropped.
  define: { __PHONE__: 'false' },
  base: './',
  build: {
    target: 'chrome120',
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: '.',
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: '[name].js',
        assetFileNames: function (info) {
          var name = (info.names && info.names[0]) || info.name || '';
          return name.slice(-4) === '.css' ? 'style.css' : '[name][extname]';
        }
      }
    }
  },
  server: { host: '127.0.0.1', port: 8899 }
});
