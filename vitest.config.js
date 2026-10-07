/* Vitest for the shared framework-free logic in src/lib — two projects, one per build:
 *
 *   tv     __PHONE__ = false, src/lib as the TV build resolves it
 *   phone  __PHONE__ = true, with phone/vite.config.js's module redirects
 *          (nav.svelte.js → phone router shim, focus.js → focus-shim.js,
 *          lifecycle.js → phone lifecycle) and its $lib / $p aliases
 *
 *   npx vitest run                 both projects
 *   npx vitest run --project tv    one project
 *   npx vitest run --coverage      + v8 coverage of src/lib and phone/src/lib
 *
 * The build-time plugins that change what a module *is* are taken from the real
 * build configs by name (never copied), so the tests run the code the bundles
 * contain: lazy-libpgs (vendor/libpgs.js → loadPgs()) and, for the phone,
 * phone-module-redirects. The Svelte plugin compiles *.svelte.js runes modules.
 *
 * Safety: envDir points at an empty directory, so the gitignored .env.local
 * (the real Jellyfin / reel-api addresses) never reaches import.meta.env, and
 * test/helpers/setup.js replaces fetch with a guard that fails any request a
 * test did not mock. Tests never touch the network. */
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import tvConfig from './vite.config.js';
import phoneConfig from './phone/vite.config.js';

const repo = path.dirname(fileURLToPath(import.meta.url));
const emptyEnv = path.join(repo, 'test/env');

function plugin(config, name) {
  const p = (config.plugins || []).flat().find((x) => x && x.name === name);
  if (!p) throw new Error(`vitest.config.js: plugin "${name}" not found in the build config — update the lookup`);
  return p;
}

const common = {
  envDir: emptyEnv,
  resolve: { conditions: ['browser'] }
};

const testCommon = {
  environment: 'happy-dom',
  setupFiles: [path.join(repo, 'test/helpers/setup.js')],
  restoreMocks: true,
  allowOnly: false,
  unstubGlobals: true,
  testTimeout: 10000
};

export default defineConfig({
  // root level too: vitest loads env files for the whole run from the root config's envDir
  envDir: emptyEnv,
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.js', 'phone/src/lib/**/*.js'],
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: path.join(repo, 'run/coverage'),
      /* The ratchet (task oracle-coverage-ratchet; raised to the final measured
       * values in oracle-final-audit, 2026-10-03; landed/segfeed/trailerstream and
       * the total raised again by the hardening round). Every file and the total are
       * pinned at the measured percentage floored to one decimal (whole suite,
       * both projects merged; two consecutive runs measured identical counts).
       * A run below any of these fails LANE_TEST. Later changes may only RAISE
       * them — never lower one to get green; add the missing tests instead.
       * Globs are relative to the repo root.
       *
       * Scope: Vitest's top-level (global) thresholds apply to *every* measured
       * file, and phone/src/lib is measured too since round 3 — most of it still
       * untested, which would sink the total. So the src/lib total that used to be
       * the global one is pinned as the 'src/lib/**' glob below (same numbers, same
       * files: a glob threshold is checked against its files' combined coverage),
       * and there is no top-level total. phone/src/lib files are pinned one by one
       * as they get tests; untested ones are measured (run/coverage) but unpinned. */
      thresholds: {
        'src/lib/**/*.js': { statements: 98.8, branches: 95.7, functions: 98.9, lines: 99.7 },
        'src/lib/account.svelte.js': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/lib/activity.svelte.js': { statements: 100, branches: 96.4, functions: 100, lines: 100 },
        'src/lib/api.js': { statements: 100, branches: 98.9, functions: 100, lines: 100 },
        'src/lib/cancel.svelte.js': { statements: 100, branches: 98, functions: 100, lines: 100 },
        'src/lib/config.js': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/lib/decoded.js': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/lib/focus.js': { statements: 100, branches: 97.7, functions: 100, lines: 100 },
        'src/lib/format.js': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/lib/header.svelte.js': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/lib/homehide.js': { statements: 100, branches: 95.2, functions: 100, lines: 100 },
        'src/lib/icons.js': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/lib/landed.svelte.js': { statements: 99.3, branches: 94.5, functions: 100, lines: 100 },
        'src/lib/libview.svelte.js': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/lib/lifecycle.js': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/lib/livefeed.js': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/lib/lookup.svelte.js': { statements: 100, branches: 96.3, functions: 100, lines: 100 },
        'src/lib/me.svelte.js': { statements: 100, branches: 98.7, functions: 100, lines: 100 },
        'src/lib/medialib.js': { statements: 97.4, branches: 98.3, functions: 96.6, lines: 98 },
        'src/lib/nav.svelte.js': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/lib/news.svelte.js': { statements: 100, branches: 96.5, functions: 100, lines: 100 },
        'src/lib/pendingplay.js': { statements: 100, branches: 98, functions: 100, lines: 100 },
        'src/lib/played.js': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/lib/player.svelte.js': { statements: 99.7, branches: 97.3, functions: 99.3, lines: 100 },
        'src/lib/reconnect.js': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/lib/refresh60.js': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/lib/searchrank.js': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/lib/segfeed.js': { statements: 100, branches: 96.9, functions: 100, lines: 100 },
        'src/lib/segments.js': { statements: 98.9, branches: 97, functions: 100, lines: 100 },
        'src/lib/settings.svelte.js': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/lib/toast.svelte.js': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/lib/trackprefs.js': { statements: 100, branches: 98.8, functions: 100, lines: 100 },
        'src/lib/tracks.js': { statements: 100, branches: 99.7, functions: 100, lines: 100 },
        'src/lib/trailer.js': { statements: 98.4, branches: 95.1, functions: 100, lines: 100 },
        'src/lib/trailerstream.js': { statements: 97.9, branches: 96.2, functions: 100, lines: 100 },

        /* phone/src/lib — per file, raise-only like the rest. */
        // round 3, lane r3-phone-offline (test/phone/offline.*.test.js, swupdate.test.js)
        'phone/src/lib/offline.svelte.js': { statements: 99.6, branches: 93.5, functions: 96.7, lines: 99.7 },
        'phone/src/lib/swupdate.js': { statements: 100, branches: 97.8, functions: 100, lines: 100 },
        // round 3, lane r3-phone-sync (test/phone/push.test.js, sw.push.test.js, freshness.test.js,
        // homesnap.test.js, home.freshness.test.js) — measured on the integrated tree (with main's
        // request-guard push tests), floored to 0.1
        'phone/src/lib/freshness.svelte.js': { statements: 99.4, branches: 94.7, functions: 100, lines: 100 },
        'phone/src/lib/homesnap.svelte.js': { statements: 100, branches: 96, functions: 100, lines: 100 },
        'phone/src/lib/push.js': { statements: 100, branches: 97.7, functions: 100, lines: 100 }
      }
    },
    projects: [
      {
        ...common,
        plugins: [svelte({ configFile: false }), plugin(tvConfig, 'lazy-libpgs')],
        define: { ...tvConfig.define },
        test: {
          ...testCommon,
          name: 'tv',
          provide: { project: 'tv' },
          include: ['test/tv/**/*.test.js', 'test/shared/**/*.test.js'],
          environmentOptions: { happyDOM: { url: 'http://tv.test/' } }
        }
      },
      {
        ...common,
        root: repo,
        plugins: [
          plugin(phoneConfig, 'phone-module-redirects'),
          svelte({ configFile: false }),
          plugin(phoneConfig, 'lazy-libpgs')
        ],
        define: { ...phoneConfig.define },
        resolve: { ...common.resolve, alias: { ...phoneConfig.resolve.alias } },
        test: {
          ...testCommon,
          name: 'phone',
          provide: { project: 'phone' },
          include: ['test/phone/**/*.test.js', 'test/shared/**/*.test.js'],
          environmentOptions: { happyDOM: { url: 'http://phone.test/' } }
        }
      }
    ]
  }
});
