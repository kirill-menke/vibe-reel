"""Fetch every third-party fixture the backend tests read. None is in git (the
repo is MIT; these are GPL specs, wiki pages and IMDb data), so a fresh clone
runs this once; afterwards the tests are offline.

    cd backend && uv run --frozen --group dev python tests/fetch_fixtures.py [--refresh] [specs] [jellyfin] [imdb]

specs     Sonarr v4 / Radarr v5 OpenAPI + the qBittorrent WebUI API pages
          -> tests/.spec-cache/ (tests/specs/fetch_specs.py). Tests marked
          `spec` skip without them.
jellyfin  Jellyfin 12.1's OpenAPI -> tests/.spec-cache/jellyfin-openapi-12.1.json
          (refused unless its sha256 is the pinned 12.1.0 one), then the
          slice reel-api uses -> tests/specs/jellyfin-12.1-subset.json
          (tests/specs/vendor_jellyfin.py, deterministic). Without it the
          JellyfinSim spec guard FAILS every test with Jellyfin traffic.
imdb      Today's IMDb GraphQL answers to the product's own requests
          -> tests/recorded/imdb/ (tests/specs/record_upstreams.py). Without
          them the IMDb replay tests FAIL.

No names = all three. Anything already in place is kept unless --refresh is
given (the specs are re-checked against their manifest sha256 regardless).
Read-only GETs/POSTs to public endpoints; no credentials are ever sent.
"""

from __future__ import annotations

import asyncio
import hashlib
import shutil
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from tests.specs import fetch_specs, record_upstreams, vendor_jellyfin  # noqa: E402
from tests.support.imdb_recorded import NAMES, REC  # noqa: E402

E2E_CACHE = BACKEND.parent / "e2e" / ".cache" / "jellyfin-openapi-12.1.json"  # e2e/scripts/fetch-spec.mjs


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def jellyfin(refresh: bool) -> None:
    src = vendor_jellyfin.DEFAULT_SRC
    if refresh or not src.is_file() or _sha(src.read_bytes()) != vendor_jellyfin.SOURCE_SHA256:
        if not refresh and E2E_CACHE.is_file() and _sha(E2E_CACHE.read_bytes()) == vendor_jellyfin.SOURCE_SHA256:
            src.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(E2E_CACHE, src)
            print(f"copied  {src.name} from the e2e cache")
        else:
            data = fetch_specs._get(vendor_jellyfin.SOURCE_URL)
            if _sha(data) != vendor_jellyfin.SOURCE_SHA256:
                sys.exit(f"{vendor_jellyfin.SOURCE_URL} changed (sha256 {_sha(data)}, pinned "
                         f"{vendor_jellyfin.SOURCE_SHA256}): review it, then update SOURCE_SHA256 in "
                         "tests/specs/vendor_jellyfin.py")
            src.parent.mkdir(parents=True, exist_ok=True)
            src.write_bytes(data)
            print(f"fetched {src.name} ({len(data)} bytes)")
    else:
        print(f"ok      {src.name}")
    vendor_jellyfin.main(src)


def imdb(refresh: bool) -> None:
    if not refresh and all((REC / f"{n}.json").is_file() for n in NAMES):
        print(f"ok      {REC.relative_to(BACKEND)}/ ({len(NAMES)} recordings; --refresh re-records)")
        return
    asyncio.run(record_upstreams.record_imdb(REC))


def main(argv: list[str]) -> int:
    refresh = "--refresh" in argv
    what = [a for a in argv if not a.startswith("-")] or ["specs", "jellyfin", "imdb"]
    unknown = set(what) - {"specs", "jellyfin", "imdb"}
    if unknown:
        sys.exit(__doc__)
    if "specs" in what:
        fetch_specs.main(["--refresh"] if refresh else [])
    if "jellyfin" in what:
        jellyfin(refresh)
    if "imdb" in what:
        imdb(refresh)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
