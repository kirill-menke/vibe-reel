"""Derive the slice of Jellyfin 12.1's OpenAPI that reel-api uses into
tests/specs/jellyfin-12.1-subset.json (git-ignored, like the Sonarr/Radarr
specs: third-party content is fetched, never committed), which the
JellyfinSim check (tests/support/jfspec.py) validates against. Without it the
check fails — it never skips.

    cd backend && uv run --frozen --group dev python tests/fetch_fixtures.py jellyfin   # fetch + derive
    cd backend && uv run --frozen --group dev python tests/specs/vendor_jellyfin.py [SPEC.json]  # derive only

The full spec is cached at tests/.spec-cache/jellyfin-openapi-12.1.json
(fetch_fixtures.py downloads it from SOURCE_URL and refuses bytes whose
sha256 isn't SOURCE_SHA256 — the release the sim was checked against).
The derivation is deterministic: the same spec gives the same bytes. Kept:
for each operation in OPERATIONS its parameters (name, in, required, schema)
and response status codes, and the JSON schemas its 200 answer reaches —
property names, types, formats, nullability, enums and `required`, with
`$ref`s to schemas outside SCHEMAS reduced to a bare marker (`{"x-ref":
name}`: the sim must not serve them). Descriptions and everything else are
dropped. Change OPERATIONS/SCHEMAS (and bump REVISION) when reel-api calls a
new Jellyfin route or the server's major version changes.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "jellyfin-12.1-subset.json"
DEFAULT_SRC = HERE.parent / ".spec-cache" / "jellyfin-openapi-12.1.json"
SOURCE_URL = "https://repo.jellyfin.org/files/openapi/stable/jellyfin-openapi-12.1.json"  # = e2e/server/spec.mjs
SOURCE_SHA256 = "6cc7386ebf8a52a7264969fa63a786dc746e9e37af573babf8b35bcfa1b5021d"  # 12.1.0, fetched 2026-10-03
# The date OPERATIONS / SCHEMAS / KEEP last changed (written as x-source.vendored, so the
# output depends on the inputs only, never on the day it is derived). Bump it with them.
REVISION = "2026-10-05"

# what push.py asks Jellyfin (GET as a user)
OPERATIONS = [("get", "/Users/Me"), ("get", "/Items"), ("get", "/Shows/{seriesId}/Episodes")]
# schemas inlined in full (shallowly: their own $refs become markers unless listed here too)
SCHEMAS = ["UserDto", "UserPolicy", "SyncPlayUserAccessType", "BaseItemDtoQueryResult", "BaseItemDto",
           "UserItemDataDto", "BaseItemKind", "ItemFields"]
KEEP = ("type", "format", "nullable", "enum", "required", "items", "additionalProperties", "properties",
        "allOf", "oneOf", "$ref")


def _ref_name(ref: str) -> str:
    return ref.rsplit("/", 1)[1]


def _slim(node):
    if isinstance(node, list):
        return [_slim(x) for x in node]
    if not isinstance(node, dict):
        return node
    out = {}
    for k, v in node.items():
        if k not in KEEP:
            continue
        if k == "$ref":
            name = _ref_name(v)
            if name in SCHEMAS:
                out["$ref"] = name
            else:
                out["x-ref"] = name
        elif k == "properties":
            out[k] = {p: _slim(s) for p, s in v.items()}
        else:
            out[k] = _slim(v)
    return out


def derive(raw: bytes) -> str:
    """The subset file's text for the full spec `raw`."""
    spec = json.loads(raw)
    ops = {}
    for method, path in OPERATIONS:
        op = spec["paths"][path][method]
        ok = op["responses"]["200"]["content"]["application/json"]["schema"]
        ops[f"{method.upper()} {path}"] = {
            "parameters": [{"name": p["name"], "in": p["in"], "required": bool(p.get("required")),
                            "schema": _slim(p["schema"])} for p in op.get("parameters", [])],
            "responses": sorted(op["responses"]),
            "ok": _slim(ok),
            "security": [list(s) for s in op.get("security", [])],
        }
    doc = {
        "x-source": {"url": SOURCE_URL, "sha256": hashlib.sha256(raw).hexdigest(),
                     "version": spec["info"]["version"], "vendored": REVISION,
                     "note": "names and types only, descriptions dropped (tests/specs/vendor_jellyfin.py)"},
        "operations": ops,
        "schemas": {n: _slim(spec["components"]["schemas"][n]) for n in SCHEMAS},
        "auth": spec["components"]["securitySchemes"],
    }
    return json.dumps(doc, indent=1, sort_keys=True) + "\n"


def main(src: Path = DEFAULT_SRC, out: Path = OUT) -> None:
    if not src.is_file():
        sys.exit(f"{src} missing — fetch it: cd backend && uv run --frozen --group dev "
                 "python tests/fetch_fixtures.py jellyfin")
    out.write_text(derive(src.read_bytes()))
    print(f"derived {out.name} ({len(OPERATIONS)} operations, {len(SCHEMAS)} schemas, "
          f"{out.stat().st_size} bytes)")


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SRC)
