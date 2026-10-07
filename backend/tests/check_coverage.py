"""Per-module coverage ratchet: fail if any module's LINE coverage is below its
floor in tests/coverage-floor.json.

    uv run python tests/check_coverage.py <coverage.json>

Floors only ever go UP (raise a module's floor in the same commit that adds
its tests; never lower one to get green). `target` is the lane's goal for
the `core` modules; the table shows how far each one still is.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2
    report = json.loads(Path(argv[1]).read_text())
    cfg = json.loads((HERE / "coverage-floor.json").read_text())
    floors: dict[str, float] = cfg["floors"]
    target = cfg["target"]
    core = set(cfg["core"])
    measured: dict[str, float] = {}
    for path, data in report["files"].items():
        name = Path(path).name
        s = data["summary"]
        n = s["num_statements"]
        measured[name] = 100.0 if n == 0 else 100.0 * s["covered_lines"] / n
    bad = []
    missing = [m for m in floors if m not in measured]
    print(f"{'module':<18}{'line%':>8}{'floor':>8}{'target':>8}")
    for name in sorted(measured):
        pct = measured[name]
        floor = floors.get(name)
        tgt = target if name in core else None
        flag = ""
        if floor is None:
            flag = "  NO FLOOR (add one)"
            bad.append(name)
        elif pct + 1e-9 < floor:
            flag = "  BELOW FLOOR"
            bad.append(name)
        elif tgt is not None and pct < tgt:
            flag = f"  ({tgt - pct:.1f} to target)"
        print(f"{name:<18}{pct:>8.1f}{(floor if floor is not None else float('nan')):>8.1f}"
              f"{(tgt if tgt is not None else float('nan')):>8.1f}{flag}")
    for m in missing:
        print(f"{m:<18} in coverage-floor.json but not measured")
    if bad or missing:
        print(f"FAIL coverage ratchet: {', '.join(bad + missing)}")
        return 1
    print("PASS coverage ratchet")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
