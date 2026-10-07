"""Download the public upstream API specs the mock-fidelity tests validate against.

    cd backend && uv run python tests/specs/fetch_specs.py [--refresh]

Writes into tests/.spec-cache/ (git-ignored — these files are GPL / wiki
content and must never be committed), plus manifest.json recording each
file's URL, sha256, size and fetch date. Idempotent: a file whose bytes still
match its manifest entry is not downloaded again unless --refresh is given.

The specs are pinned to release tags of the versions the NAS runs (Sonarr v4,
Radarr v5): Radarr's `develop` branch has moved on to v6, and a tag keeps the
sha256 stable. Override a source with NAME=URL arguments if needed.

Tests marked `spec` skip (not fail) while the cache is missing; see
tests/support/specs.py.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import sys
from pathlib import Path

import httpx  # a runtime dependency; brings certifi's CA bundle (uv's Python has none on NixOS)

CACHE = Path(__file__).resolve().parent.parent / ".spec-cache"
MANIFEST = CACHE / "manifest.json"

RAW = "https://raw.githubusercontent.com"
SOURCES: dict[str, str] = {
    # Sonarr's v3 API docs "apply to both v3 and v4" (its info.description); last v4 release tag.
    "sonarr-v4.openapi.json": f"{RAW}/Sonarr/Sonarr/v4.0.20.3014/src/Sonarr.Api.V3/openapi.json",
    # Radarr v5 serves the same /api/v3 surface; last v5 release tag.
    "radarr-v5.openapi.json": f"{RAW}/Radarr/Radarr/v5.28.0.10274/src/Radarr.Api.V3/openapi.json",
    # The qBittorrent WebUI API v2 reference (wiki pages, markdown source).
    "qbittorrent-webui-api-5.0.md": f"{RAW}/wiki/qbittorrent/qBittorrent/WebUI-API-(qBittorrent-5.0).md",
    "qbittorrent-webui-api-4.1.md": f"{RAW}/wiki/qbittorrent/qBittorrent/WebUI-API-(qBittorrent-4.1).md",
}


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _get(url: str) -> bytes:
    r = httpx.get(url, headers={"User-Agent": "reel-api-tests/fetch_specs"}, timeout=60, follow_redirects=True)
    r.raise_for_status()
    return r.content


def _check(name: str, data: bytes) -> None:
    """Refuse to cache something that isn't what we asked for (an HTML error page...)."""
    if name.endswith(".json"):
        doc = json.loads(data)
        if not str(doc.get("openapi", "")).startswith("3.") or "paths" not in doc:
            raise ValueError(f"{name}: not an OpenAPI 3 document")
    elif b"/api/v2/torrents/info" not in data:
        raise ValueError(f"{name}: not the qBittorrent WebUI API page")


def main(argv: list[str]) -> int:
    refresh = "--refresh" in argv
    sources = dict(SOURCES)
    for arg in argv:
        if "=" in arg:
            k, _, v = arg.partition("=")
            sources[k] = v
    CACHE.mkdir(parents=True, exist_ok=True)
    try:
        manifest = json.loads(MANIFEST.read_text())
    except (OSError, ValueError):
        manifest = {}
    changed = False
    for name, url in sources.items():
        path = CACHE / name
        entry = manifest.get(name)
        if (not refresh and entry and entry.get("url") == url and path.is_file()
                and _sha256(path.read_bytes()) == entry.get("sha256")):
            print(f"ok      {name}")
            continue
        data = _get(url)
        _check(name, data)
        path.write_bytes(data)
        manifest[name] = {"url": url, "sha256": _sha256(data), "size": len(data),
                          "fetched": dt.date.today().isoformat()}
        changed = True
        print(f"fetched {name} ({len(data)} bytes)")
    if changed or not MANIFEST.exists():
        MANIFEST.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
