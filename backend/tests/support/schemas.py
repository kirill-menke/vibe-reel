"""reel-api's own response schemas, for the contract tests (test_contract.py,
test_openapi_responses.py).

`api_schema(openapi, method, route, status)` is the JSON Schema a route
declares in `app.openapi()` (FastAPI emits OpenAPI 3.1, i.e. plain JSON
Schema 2020-12 with `$ref: #/components/schemas/...`), with every `$ref`
inlined. Routes without a `response_model` declare nothing (an empty schema);
for those `DOCUMENTED` holds a hand-written schema derived from the module
that builds the answer (its docstring + the dict it returns) and the README.
`ERROR` is the `{error, detail}` body every handled error carries
(models.ApiError, README "Errors"); no route declares it in OpenAPI.

`has_field(schema, "items[].media_id")` walks a dotted path through a
schema (`name[]` = the array under `name`, then its items), following
anyOf/oneOf/allOf; `payload_has(data, path)` is the same walk through a
real JSON answer (every element of a list must have the field).
"""

from __future__ import annotations

import copy

from jsonschema import Draft202012Validator

from reel_api.models import ApiError, QuotaError


# ---------------------------------------------------------------- OpenAPI


def _inline(node, components: dict, seen: tuple = ()):
    if isinstance(node, list):
        return [_inline(x, components, seen) for x in node]
    if not isinstance(node, dict):
        return node
    ref = node.get("$ref")
    if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
        name = ref.rsplit("/", 1)[1]
        if name in seen:  # recursive model: stop (no reel-api model is)
            return {}
        target = components["schemas"][name]
        rest = {k: v for k, v in node.items() if k != "$ref"}
        out = _inline(copy.deepcopy(target), components, seen + (name,))
        return {**out, **_inline(rest, components, seen)} if rest else out
    return {k: _inline(v, components, seen) for k, v in node.items()}


def operation(openapi: dict, method: str, route: str) -> dict:
    try:
        return openapi["paths"][route][method.lower()]
    except KeyError:
        raise AssertionError(f"{method} {route} is not in app.openapi()") from None


def api_schema(openapi: dict, method: str, route: str, status: int) -> dict | None:
    """The declared JSON response schema of method+route for `status`, $refs
    inlined; None if the route declares none (no response_model) for it."""
    resp = operation(openapi, method, route)["responses"].get(str(status))
    if resp is None:
        return None
    schema = (resp.get("content") or {}).get("application/json", {}).get("schema")
    if not schema:
        return None
    return _inline(schema, openapi.get("components") or {})


# ---------------------------------------------------------------- path walks


def _branches(schema: dict) -> list[dict]:
    """A schema and the alternatives it is made of (anyOf/oneOf/allOf)."""
    out = [schema]
    for key in ("anyOf", "oneOf", "allOf"):
        for sub in schema.get(key) or []:
            out.extend(_branches(sub))
    return out


def _step(schemas: list[dict], seg: str) -> list[dict]:
    name, many = (seg[:-2], True) if seg.endswith("[]") else (seg, False)
    nxt = []
    for s in schemas:
        for b in _branches(s):
            prop = (b.get("properties") or {}).get(name)
            if prop is None:
                continue
            if many:
                nxt.extend(x["items"] for x in _branches(prop) if isinstance(x.get("items"), dict))
            else:
                nxt.append(prop)
    return nxt


def has_field(schema: dict, path: str) -> bool:
    """True if the dotted path names a property the schema declares."""
    cur = [schema]
    for seg in path.split("."):
        cur = _step(cur, seg)
        if not cur:
            return False
    return True


def payload_has(data, path: str) -> bool:
    """True if the real JSON answer carries the path (as a key; null counts).
    Every element of a `name[]` list is checked, and the list must not be
    empty — a field nobody saw in a real answer proves nothing."""
    cur = [data]
    for seg in path.split("."):
        name, many = (seg[:-2], True) if seg.endswith("[]") else (seg, False)
        nxt = []
        for obj in cur:
            if not isinstance(obj, dict) or name not in obj:
                return False
            val = obj[name]
            if many:
                if not isinstance(val, list) or not val:
                    return False
                nxt.extend(val)
            else:
                nxt.append(val)
        cur = nxt
    return True


def validate(schema: dict, data) -> list[str]:
    """jsonschema errors (as 'path: message' strings) of data against schema."""
    v = Draft202012Validator(schema)
    return [f"{'/'.join(map(str, e.absolute_path)) or '$'}: {e.message}"
            for e in sorted(v.iter_errors(data), key=lambda e: list(map(str, e.absolute_path)))]


# ---------------------------------------------------------------- hand-written schemas

from tests.support.documented import (  # noqa: E402,F401  (re-exported)
    BOOL, DOCUMENTED, HEALTH, HLS_STATUS, INT, NUM, PROBE, PUSH_CONFIG, PUSH_OK, PUSH_STATUS,
    PUSH_SUBSCRIBED, STR, TRAILER_STATUS, _obj, opt,
)

# models.ApiError — README "Errors": every handled error is {error, detail}.
ERROR = {**ApiError.model_json_schema(), "additionalProperties": False}
# POST /api/library over the quota: {error, detail} plus what it counted.
QUOTA_ERROR = {**QuotaError.model_json_schema(), "additionalProperties": False}


def schema_for(openapi: dict, method: str, route: str, status: int, data=None) -> tuple[str, dict]:
    """(source, schema) for a real answer: the OpenAPI one when the route
    declares one, else the documented one; any error status >= 400 but 422
    (FastAPI's own validation body, declared in OpenAPI) is ERROR — except a
    `quota_exceeded` body (pass the answer as `data`), which is QUOTA_ERROR.
    Raises if a route has neither, or has both (a hand schema must not
    shadow a declared model)."""
    declared = api_schema(openapi, method, route, status)
    if status >= 400 and status != 422:
        assert declared is None, f"{method} {route} {status} now declares a schema: use it"
        if isinstance(data, dict) and data.get("error") == "quota_exceeded":
            return "error", QUOTA_ERROR
        return "error", ERROR
    hand = DOCUMENTED.get((method, route, status))
    if declared is not None:
        assert hand is None, f"{method} {route} {status} declares a response model now: drop DOCUMENTED"
        return "openapi", declared
    assert hand is not None, f"{method} {route} {status}: no schema in app.openapi() nor in DOCUMENTED"
    return "documented", hand
