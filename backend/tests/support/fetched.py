"""Third-party fixtures that are fetched, never committed (tests/fetch_fixtures.py).

The Jellyfin 12.1 OpenAPI subset (tests/specs/jellyfin-12.1-subset.json) and
the recorded IMDb answers (tests/recorded/imdb/) are git-ignored like the
Sonarr/Radarr specs. Unlike those (`spec` tests skip without them), the tests
that read these FAIL while a file is missing — `require()` — with a one-line
hint naming the fetch command: a fresh clone runs the command once.
"""

from __future__ import annotations

from pathlib import Path

import pytest

TESTS = Path(__file__).resolve().parent.parent
FETCH = "cd backend && uv run --frozen --group dev python tests/fetch_fixtures.py"


def hint(path: Path) -> str:
    return f"{path.relative_to(TESTS.parent)} missing (third-party, not in git) — fetch it: {FETCH}"


def require(path: Path) -> Path:
    """`path`, or fail the test (never skip) with the fetch command."""
    if not path.is_file():
        pytest.fail(hint(path), pytrace=False)
    return path
