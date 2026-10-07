#!/usr/bin/env bash
# Mutation testing, one reel_api module at a time (mutmut 3, config in
# pyproject.toml [tool.mutmut]).
#
#   tests/run_mutmut.sh <module> [more modules...]     e.g. tests/run_mutmut.sh qbittorrent
#   MUTMUT_CHILDREN=4 (parallel workers, default 4)
#
# mutmut copies src/ and tests/ into backend/mutants/ (git-ignored) and only
# ever mutates that copy; the first run also records which tests reach which
# function (cached in mutants/, re-done when sources change). The fast suite
# (-m "not slow") is what has to kill a mutant, with the same no-network
# guards as always (pytest-socket + respx/responses, from pyproject addopts
# and conftest.py).
#
# Prints killed / timeout / survived / no-tests counts per module and
# score = (killed + timeout) / (total - equivalent). Mutants proven equivalent
# are listed in tests/mutmut-equivalent.txt ("<mutant name>  # reason").
# Inspect a survivor:  uv run ... mutmut show <name>   (NEVER `mutmut apply`:
# that writes the mutant into src/).
set -euo pipefail
cd "$(dirname "$0")/.."   # backend/
[ $# -ge 1 ] || { sed -n '2,20p' "$0"; exit 2; }
T=(uv run --frozen --group dev)

src_state() { git status --porcelain --untracked-files=all -- src; git diff --no-ext-diff -- src | md5sum; }
before=$(src_state)

# mutants/ first (and patched for a mutmut limitation, see the script's docstring)
"${T[@]}" python tests/mutmut_prepare.py >mutants-prepare.log 2>&1 || {
  echo "generating mutants failed (see backend/mutants-prepare.log):"; tail -20 mutants-prepare.log; exit 1; }
grep '^patched' mutants-prepare.log || true

rc=0
for mod in "$@"; do
  mod=${mod%.py}
  [ -f "src/reel_api/$mod.py" ] || { echo "no such module: src/reel_api/$mod.py"; exit 2; }
  echo "=== mutmut: reel_api.$mod"
  "${T[@]}" mutmut run --max-children "${MUTMUT_CHILDREN:-4}" "reel_api.$mod.*" >"mutants-$mod.log" 2>&1 || {
    echo "mutmut run failed for $mod (see backend/mutants-$mod.log):"; tail -20 "mutants-$mod.log"; rc=1; continue; }
  "${T[@]}" python - "$mod" <<'PY'
import json, sys
from collections import Counter
from pathlib import Path
from mutmut.stats import status_by_exit_code

mod = sys.argv[1]
meta = json.loads(Path(f"mutants/src/reel_api/{mod}.py.meta").read_text())
codes = meta["exit_code_by_key"]
eq_file = Path("tests/mutmut-equivalent.txt")
equivalent = set()
if eq_file.exists():
    for line in eq_file.read_text().splitlines():
        name = line.split("#", 1)[0].strip()
        if name:
            equivalent.add(name)
status = {k: status_by_exit_code[v] for k, v in codes.items()}
eq = {k for k in status if k in equivalent}
c = Counter(v for k, v in status.items() if k not in eq)
total = len(status) - len(eq)
caught = c["killed"] + c["timeout"]
score = 100.0 * caught / total if total else 100.0
print(f"{mod}: total {len(status)}  equivalent {len(eq)}  killed {c['killed']}  timeout {c['timeout']}"
      f"  survived {c['survived']}  no-tests {c['no tests']}"
      + "".join(f"  {k} {n}" for k, n in sorted(c.items())
                if k not in ("killed", "timeout", "survived", "no tests"))
      + f"  score {score:.1f}%")
for k in sorted(k for k, v in status.items() if v in ("survived", "no tests") and k not in eq):
    print(f"  {status[k]:<9} {k}")
PY
done

after=$(src_state)
if [ "$before" != "$after" ]; then echo "FAIL: mutmut changed files under backend/src"; exit 1; fi
exit $rc
