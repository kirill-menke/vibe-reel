"""Jellyfin 12.1's OpenAPI, the slice reel-api uses (tests/specs/
jellyfin-12.1-subset.json, derived by tests/specs/vendor_jellyfin.py), as a
validator for JellyfinSim's traffic. Third-party, so git-ignored and fetched
(tests/fetch_fixtures.py); offline once fetched. Without it every check
answers the one violation MISSING (the fetch hint), which jellyfin_spec_guard
fails the test with — it never skips.

    spec = jf_spec()
    spec.request(httpx_request)                  -> [problem, ...]
    spec.response(op, status, json_body, fields) -> [problem, ...]

Requests: the route template and method exist; path and query parameters are
declared (names case-insensitive, as ASP.NET binds them), required ones are
there, and values bind (int32, bool, uuid with or without dashes, enum
members case-insensitively, arrays comma-separated or repeated); the
`Authorization: MediaBrowser Client=…, Device=…, DeviceId=…, Version=…,
Token=…` header carries every part — or is exactly `MediaBrowser Token="…"`,
which 12.1 answers from the token's own device record (measured 2026-10-05;
what the request guard, security.py, sends) — and the legacy
X-Emby-Authorization is refused by 12.x.

Responses: the status is one the operation declares (5xx always allowed);
a 200 body matches the schema strictly — no property the schema lacks
(additionalProperties false), `required` present, JSON types, uuid /
date-time formats, enums, null only where nullable — and a BaseItemDto
carries an optional field (one named in the ItemFields enum) only when the
request asked for it in `Fields`. A `$ref` to a schema the subset doesn't
vendor fails: vendor it before the sim serves it.
"""

from __future__ import annotations

import functools
import json
import re
from pathlib import Path

import httpx

from tests.support.fetched import hint

SUBSET = Path(__file__).resolve().parent.parent / "specs" / "jellyfin-12.1-subset.json"
UUID = re.compile(r"[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
DATETIME = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})")
AUTH_PARTS = ("Client", "Device", "DeviceId", "Version", "Token")


class JfSpec:
    def __init__(self, doc: dict):
        self.doc = doc
        self.schemas = doc["schemas"]
        self.ops = {}
        for key, op in doc["operations"].items():
            method, tpl = key.split(" ", 1)
            rx = re.compile("^" + re.sub(r"\\\{(\w+)\\\}", r"(?P<\1>[^/]+)", re.escape(tpl)) + "$", re.I)
            self.ops[key] = (method, tpl, rx, op)
        self.optional_fields = set(self.schemas["ItemFields"]["enum"])

    # ---- requests ----
    def match(self, method: str, path: str):
        for key, (m, _tpl, rx, op) in self.ops.items():
            hit = rx.match(path)
            if hit and m == method:
                return key, op, hit.groupdict()
        return None

    def request(self, request: httpx.Request) -> list[str]:
        where = f"Jellyfin {request.method} {request.url.path}"
        found = self.match(request.method, request.url.path)
        if not found:
            return [f"{where}: route not in the 12.1 subset (vendor it: tests/specs/vendor_jellyfin.py)"]
        key, op, path_params = found
        out = []
        params = {p["name"].lower(): p for p in op["parameters"]}
        for name, val in path_params.items():
            e = self.scalar(params[name.lower()]["schema"], val)
            if e:
                out.append(f"{where}: path {name}={val!r} {e}")
        seen = set()
        for name, val in request.url.params.multi_items():
            p = params.get(name.lower())
            if p is None or p["in"] != "query":
                out.append(f"{where}: unknown query parameter {name!r}")
                continue
            seen.add(name.lower())
            e = self.scalar(p["schema"], val)
            if e:
                out.append(f"{where}: query {name}={val!r} {e}")
        for n, p in params.items():
            if p["required"] and p["in"] == "query" and n not in seen:
                out.append(f"{where}: required query parameter {p['name']!r} missing")
        if "x-emby-authorization" in request.headers:
            out.append(f"{where}: X-Emby-Authorization is not read by 12.x (400 'request.App')")
        if op.get("security"):
            auth = request.headers.get("authorization", "")
            m = re.match(r"\s*MediaBrowser\s+(.*)$", auth, re.I)
            parts = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1))) if m else {}
            missing = [k for k in AUTH_PARTS if not parts.get(k)]
            token_only = set(parts) == {"Token"} and parts["Token"]
            if missing and not token_only:
                out.append(f"{where}: Authorization lacks {', '.join(missing)}")
        return out

    def scalar(self, schema: dict, raw: str) -> str | None:
        """Does a query/path string bind to this parameter schema? (None = yes)"""
        schema = self.deref(schema)
        if schema.get("type") == "array":
            for item in [x for x in raw.split(",")]:
                e = self.scalar(schema["items"], item.strip())
                if e:
                    return e
            return None
        if "enum" in schema:
            return None if raw.lower() in {v.lower() for v in schema["enum"]} else "is not one of the enum"
        t, fmt = schema.get("type"), schema.get("format")
        if t == "integer":
            return None if re.fullmatch(r"-?\d+", raw) and -2**31 <= int(raw) < 2**31 else "is not an int32"
        if t == "boolean":
            return None if raw.lower() in ("true", "false") else "is not a boolean"
        if fmt == "uuid":
            return None if UUID.fullmatch(raw) else "is not a uuid"
        return None

    # ---- responses ----
    def deref(self, schema: dict) -> dict:
        if "$ref" in schema:
            return self.schemas[schema["$ref"]]
        return schema

    def response(self, op_key: str, status: int, body, fields: set[str]) -> list[str]:
        op = self.ops[op_key][3]
        where = f"JellyfinSim {op_key} -> {status}"
        if status >= 500:
            return []
        if str(status) not in op["responses"]:
            return [f"{where}: status not declared (declares {', '.join(op['responses'])})"]
        if status != 200:
            return []
        out: list[str] = []
        self.node(op["ok"], body, "$", out, {f.lower() for f in fields})
        return [f"{where}: {p}" for p in out]

    def node(self, schema: dict, v, path: str, out: list, fields: set[str], name: str | None = None) -> None:
        if "x-ref" in schema:
            out.append(f"{path}: schema {schema['x-ref']} isn't vendored — vendor it before serving it")
            return
        if "$ref" in schema:
            return self.node(self.schemas[schema["$ref"]], v, path, out, fields, schema["$ref"])
        if v is None:
            if not schema.get("nullable"):
                out.append(f"{path}: null where not nullable")
            return
        for sub in schema.get("allOf", []):
            if "x-ref" in sub and "enum" in schema:
                continue  # an enum type, inlined as "enum" next to it
            self.node(sub, v, path, out, fields)
        if "enum" in schema and v not in schema["enum"]:
            out.append(f"{path}={json.dumps(v)} is not one of the enum")
        t = schema.get("type")
        if t == "object" or "properties" in schema:
            if not isinstance(v, dict):
                out.append(f"{path}: expected an object")
                return
            props = schema.get("properties", {})
            for k in schema.get("required", []):
                if k not in v:
                    out.append(f"{path}: required {k} missing")
            extra = schema.get("additionalProperties", True)
            for k, x in v.items():
                if k in props:
                    if name == "BaseItemDto" and k in self.optional_fields and k.lower() not in fields:
                        out.append(f"{path}.{k}: an optional field (ItemFields) served without Fields={k}")
                    self.node(props[k], x, f"{path}.{k}", out, fields)
                elif extra is False:
                    out.append(f"{path}.{k}: not in the {name or 'object'} schema")
                elif isinstance(extra, dict):
                    self.node(extra, x, f"{path}.{k}", out, fields)
        elif t == "array":
            if not isinstance(v, list):
                out.append(f"{path}: expected an array")
                return
            for i, x in enumerate(v):
                self.node(schema.get("items", {}), x, f"{path}[{i}]", out, fields)
        elif t == "integer":
            if not isinstance(v, int) or isinstance(v, bool):
                out.append(f"{path}={json.dumps(v)} is not an integer")
        elif t == "number":
            if not isinstance(v, (int, float)) or isinstance(v, bool):
                out.append(f"{path}={json.dumps(v)} is not a number")
        elif t == "boolean":
            if not isinstance(v, bool):
                out.append(f"{path}={json.dumps(v)} is not a boolean")
        elif t == "string":
            if not isinstance(v, str):
                out.append(f"{path}={json.dumps(v)} is not a string")
            elif schema.get("format") == "uuid" and not UUID.fullmatch(v):
                out.append(f"{path}={v!r} is not a uuid")
            elif schema.get("format") == "date-time" and not DATETIME.fullmatch(v):
                out.append(f"{path}={v!r} is not a date-time")


MISSING = hint(SUBSET)


class _NoSpec:
    """Stands in while the subset isn't fetched: every request and answer is the violation MISSING."""

    ops: dict = {}

    def match(self, method: str, path: str):
        return None

    def request(self, request: httpx.Request) -> list[str]:
        return [MISSING]

    def response(self, key: str, status: int, body, fields: set) -> list[str]:
        return [MISSING]


@functools.cache
def _load() -> JfSpec:
    return JfSpec(json.loads(SUBSET.read_text()))


def jf_spec() -> JfSpec | _NoSpec:
    return _load() if SUBSET.is_file() else _NoSpec()
