#!/usr/bin/env bash
# Mutation testing for the Vitest suite: installs Stryker into stryker/ (its own
# lockfile, see README.md) when needed, applies the Vitest 5 test-name fix, and
# runs it with the repo-root stryker.config.mjs. Extra arguments go to
# `stryker run` (e.g. --mutate src/lib/format.js). Reports: run/stryker/.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
cd "$repo"
[ -d node_modules/vitest ] || { echo "run 'npm ci' at the repo root first" >&2; exit 1; }
[ -d "$here/node_modules/@stryker-mutator/core" ] || npm ci --prefix "$here" --no-audit --no-fund

# Stryker's vitest runner (10.0.0) joins suite and test names with ' ' when it
# builds the per-test filter, but Vitest 5 matches testNamePattern against
# names joined with ' > ' (task.fullTestName). Unpatched, every perTest mutant
# run selects zero tests and every runtime mutant "survives". Make the runner
# use Vitest's own separator (and drop the empty file-level suite name).
rdir="$here/node_modules/@stryker-mutator/vitest-runner/dist/src"
for f in "$rdir/test-helpers.js" "$rdir/stryker-setup.js"; do
  sed -i "s/return nameParts.join(' ').trim();/return nameParts.filter(Boolean).join(' > ').trim();/" "$f"
  grep -q "join(' > ')" "$f" || { echo "stryker/run.sh: could not patch $f — check the runner version" >&2; exit 1; }
done

# Stryker's vitest runner runs the tests in worker threads, where a test's own
# process.env.TZ switch has no effect (format.test.js's V-F6 case expects a
# west-of-UTC zone and failed the dry run in CEST). The whole suite passes with a
# west-of-UTC process zone; STRYKER_TZ overrides it.
export TZ="${STRYKER_TZ:-America/New_York}"

mkdir -p run/stryker
exec node "$here/node_modules/@stryker-mutator/core/bin/stryker.js" run stryker.config.mjs "$@"
