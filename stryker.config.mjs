/* Mutation testing for the Vitest suite (lane task oracle-stryker-setup).
 *
 *   stryker/run.sh                 # install the tool if needed, then mutate the files below
 *   stryker/run.sh --mutate src/lib/format.js     # any Stryker CLI option on top
 *
 * Stryker itself lives in stryker/ (its own package.json + lock), not in the
 * root devDependencies: installing it at the root hoisted Babel 8 over the
 * Babel 7 the webOS CLI (ares-package) resolves, reshuffling ~3000 lines of the
 * root lock. See stryker/README.md.
 *
 * Stryker never touches src/: it copies the project into a sandbox under
 * run/stryker/tmp, instruments the copies there and runs `vitest` (both
 * projects, this repo's vitest.config.js) against them. Reports land in
 * run/stryker/ (git-excluded). Fully offline: the suite never reaches the
 * network (test/helpers/setup.js). */
/* player.svelte.js is not in `mutate` below: ~2400 mutants, each re-running
 * the ~400 player tests — hours. It is mutated in ranges with its own test
 * files instead (STRYKER_TESTS narrows the run, see stryker/vitest.narrow.config.js),
 * then every non-killed mutant is re-checked with stryker/verify.py:
 *
 *   P=src/lib/player.svelte.js
 *   export STRYKER_TESTS='test/shared/player.*.test.js,test/shared/helpers.player.test.js,test/shared/pendingplay.test.js,test/shared/trailer.test.js,test/tv/lifecycle.test.js,test/tv/picture*.test.js,test/phone/lifecycle.test.js,test/phone/player.*.test.js'
 *   stryker/run.sh --concurrency 3 --mutate "$P:1-460"                   # start path, PlaybackInfo
 *   stryker/run.sh --concurrency 3 --mutate "$P:461-951"                 # feeds, trailers, startPlayback, events
 *   stryker/run.sh --concurrency 3 --mutate "$P:952-1209"                # watchdog, slow link, reports, Stopped
 *   stryker/run.sh --concurrency 3 --mutate "$P:1210-1764"               # subtitles, transport, markers, scrub, Up Next
 *   stryker/run.sh --concurrency 3 --mutate "$P:1765-2079"               # OSD, exit, track menus, picture modes
 *
 * (line numbers as of 2026-10-05; ~300–700 mutants and 20–40 min each at
 * concurrency 3 on a loaded machine). Scores then (lane r3-tv-unit, every
 * non-killed mutant re-checked with verify.py; the rest triaged equivalent):
 * 1–460 94.9 %, 461–951 94.2 %, 952–1120 + 1186–1209 94.0 %, 1121–1185 +
 * 1210–1532 91.4 %, 1765–2079 92.7 % (1533–1764: 89.2 %, vitest lane w12).
 * focus.js (95.3 %) and livefeed.js (99.2 %) are in the list below; they run
 * faster narrowed too:
 *   STRYKER_TESTS='test/tv/focus*.test.js,test/phone/livefeed*.test.js' stryker/run.sh --mutate src/lib/focus.js,src/lib/livefeed.js */
const narrow = !!process.env.STRYKER_TESTS;

export default {
  testRunner: 'vitest',
  vitest: {
    configFile: narrow ? 'stryker/vitest.narrow.config.js' : 'vitest.config.js',
    // Most tests reach src/lib through freshImport() — computed dynamic imports
    // Vitest's `related` analysis can't follow, so it would skip the very tests
    // that kill the mutants. perTest coverage below already narrows each run.
    related: false
  },
  coverageAnalysis: 'perTest',
  mutate: [
    'src/lib/tracks.js',
    'src/lib/trackprefs.js',
    'src/lib/segments.js',
    'src/lib/format.js',
    'src/lib/homehide.js',
    'src/lib/api.js',
    'src/lib/searchrank.js',
    'src/lib/focus.js',
    'src/lib/livefeed.js'
  ],
  // Never copied into the sandbox: build output, the backend, local state and
  // anything holding private addresses (.env.local) — the tests need none of it.
  ignorePatterns: [
    'run',
    'dist',
    'out',
    'phone/dist',
    'backend',
    // stryker/ holds Stryker's own install; only the narrowing config goes into the sandbox
    'stryker/*',
    '!stryker/vitest.narrow.config.js',
    'docs',
    'service',
    '.env.local',
    '.env.*.local',
    'phone/.devcreds.json'
  ],
  tempDirName: 'run/stryker/tmp',
  cleanTempDir: true,
  concurrency: 8,
  timeoutMS: 20000,
  dryRunTimeoutMinutes: 10,
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'run/stryker/report.html' },
  jsonReporter: { fileName: 'run/stryker/report.json' },
  thresholds: { high: 85, low: 70, break: null }
};
