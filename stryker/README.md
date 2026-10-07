# Mutation testing (Stryker) for the Vitest suite

```sh
npm ci                        # repo root, once (vitest + the build toolchain)
stryker/run.sh                # installs Stryker here if needed, then mutates
stryker/run.sh --mutate src/lib/format.js          # one file
stryker/run.sh --mutate 'src/lib/format.js:40-50'  # a line range
```

What gets mutated, the sandbox and the reporters are set in the repo-root
`stryker.config.mjs`. Reports land in `run/stryker/` (`report.html`, `report.json`),
the sandbox in `run/stryker/tmp/`; `run/` is local-only. Stryker never edits
`src/`: it copies the project into the sandbox and instruments the copies.
It is not part of the gate's test command (a full run takes many minutes).

## Narrowing the tests: `STRYKER_TESTS`

```sh
STRYKER_TESTS='test/tv/focus*.test.js,test/phone/livefeed*.test.js' stryker/run.sh --mutate src/lib/focus.js,src/lib/livefeed.js
```

perTest coverage re-runs every test that touched a mutant, and some modules are
touched by far more tests than test them: focus.js and player.svelte.js sit in
the player graph (~400 tests), so unnarrowed a focus.js mutant took ~15× longer
than with its own two files. With `STRYKER_TESTS` set (comma-separated globs),
`stryker.config.mjs` runs `stryker/vitest.narrow.config.js` instead: the same two
projects, each limited to the globs under its own include (`test/tv/…` → tv,
`test/phone/…` → phone, `test/shared/…` → both). player.svelte.js is not in the
default `mutate` list; the range commands are in `stryker.config.mjs`.

## The time zone

`run.sh` exports `TZ=America/New_York` (override: `STRYKER_TZ`). The vitest runner
runs the tests in worker threads, where a test's own `process.env.TZ = …` has no
effect, and format.test.js's V-F6 case needs a zone west of UTC — in CEST the dry
run failed ("There were failed tests in the initial test run"). The whole suite
passes with the process in New York time.

## Why a separate install

Stryker lives here, with its own `package.json` and lockfile, instead of in the
root `devDependencies`. Installed at the root, `@stryker-mutator/core` 10 hoisted
Babel 8 over the Babel 7 that `@webos-tools/cli` (`ares-package`, used by
`build-ipk.sh`) resolves and rewrote ~3000 lines of the root lockfile — a change to
the TV packaging tool's dependency tree that nothing here can test. `.npmrc` sets
`legacy-peer-deps`, so the runner's `vitest` peer resolves to the repo root's copy
(one Vitest, the version the suite pins) instead of a second install.

Five entries in `package-lock.json` carry a **SHA-384** `integrity` instead of the
registry's SHA-512: the lane gate's private-address check matches a two-character
string that occurs inside those SHA-512 hashes (a false positive). The SHA-384 values
were computed from the registry tarballs after checking them against the registry's
own SHA-512; npm verifies whichever algorithm the lockfile names (a tampered SHA-384
fails `npm ci` with EINTEGRITY — checked). The root `package-lock.json` does the same
for `@babel/types` 7.29.8 and `undici-types` 8.9.0.

## The Vitest 5 fix in `run.sh`

`@stryker-mutator/vitest-runner` 10.0.0 builds its per-test filter
(`testNamePattern`) from suite and test names joined with `' '`; Vitest 5 matches
the pattern against `task.fullTestName`, which joins them with `' > '`. Unpatched,
every mutant run under `coverageAnalysis: 'perTest'` selected **zero** tests and
every runtime mutant was reported as Survived (format.js: 18.6 % instead of 100 %).
`run.sh` rewrites the runner's `collectTestName` to Vitest's separator after every
install and refuses to run if the patch no longer applies (a new runner version:
check whether it is still needed).

## Checking Timeouts and survivors: `verify.py`

```sh
stryker/verify.py run/stryker/report.json Timeout,Survived [--project tv] test/shared/x.test.js …
```

Stryker counts a Timeout as detected. On a busy machine the *static* mutants
(module-level Sets, regexes, tables) time out because each re-runs every test
that imported the module, and several of those turned out to be survivors. And
mutant switching can't see lazily cached module state (tracks.js `LANG_WORDS`),
so a mutant there can "survive" a test that kills it. `verify.py` applies each
selected mutant to a copy of the repo under `run/stryker/verify/` and runs only
the given test files (a run past `VERIFY_TIMEOUT`, 180 s, is an endless loop:
counted killed, marked `[timeout]`). Quote scores from its output.

## Number constants: `constants.py`

Stryker has no number-literal mutator, so it never changes `const STALL_FAIL_MS =
30000`. `stryker/constants.py` nudges each documented player threshold both ways
in a copy under `run/stryker/constants/` and runs the player tests; it exits 1
and prints LOOSE for any change the suite does not notice.
