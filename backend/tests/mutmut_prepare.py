"""Generate mutmut's mutants/ tree and make it importable (run by run_mutmut.sh).

    uv run ... python tests/mutmut_prepare.py

Does what `mutmut run` does first (copy src/ + tests/ into mutants/, write
every mutant), then patches one mutmut 3.8 limitation in the *generated
copies* (src/ is never touched):

A class method named like a builtin used in the class's annotations (until
2026-10 the aria2 and qBittorrent clients' `async def list(self) -> list[dict]`;
no product class has one now, the patch stays for the next) gets
its trampoline bound to that name in the class body before the mutant
copies are defined, so their `-> list[dict]` subscripts the trampoline at
class creation (TypeError: 'function' object is not subscriptable, and every
test errors). Such a generated file gets `from __future__ import
annotations` after its docstring: annotations are then never evaluated,
which neither module relies on (plain httpx clients, no pydantic/FastAPI
models in them).

Idempotent: mutmut regenerates a mutant file only when its source is newer,
and a patched file is not patched again. `mutmut run` afterwards finds the
files up to date and keeps them.
"""

from __future__ import annotations

import ast
import os
import re
from pathlib import Path

import mutmut.__main__ as mm

SHADOW = re.compile(r"ǁ(list|dict|set|tuple|type|str|int|bytes|float)__mutmut_orig\(")
FUTURE = "from __future__ import annotations\n"


def patch(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    if not SHADOW.search(text):
        return False
    tree = ast.parse(text)
    if any(isinstance(n, ast.ImportFrom) and n.module == "__future__"
           and any(a.name == "annotations" for a in n.names) for n in tree.body):
        return False
    lines = text.splitlines(keepends=True)
    first = tree.body[0]
    at = first.end_lineno if (isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant)
                              and isinstance(first.value.value, str)) else 0
    lines.insert(at, FUTURE)
    st = path.stat()
    path.write_text("".join(lines), encoding="utf-8")
    os.utime(path, ns=(st.st_atime_ns, max(st.st_mtime_ns, path.stat().st_mtime_ns)))
    return True


def main() -> None:
    mm.set_mutant_under_test("mutant_generation")
    os.makedirs("mutants", exist_ok=True)
    mm.copy_src_dir()
    mm.copy_also_copy_files()
    mm.setup_source_paths()
    mm.store_lines_covered_by_tests()
    mm.create_mutants(4)
    for path in sorted(Path("mutants/src").rglob("*.py")):
        if patch(path):
            print(f"patched (from __future__ import annotations): {path}")


if __name__ == "__main__":
    main()
