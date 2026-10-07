"""Every JSON route's real answers vs the schema it declares.

Each scene in tests/support/scenes.py is a real answer of the app against the
sims; it is validated with jsonschema against `app.openapi()`'s schema for
that route + status ($refs inlined), or — for routes without a
response_model (probe, hls, trailers, push, health) — against the schema
documented in tests/support/schemas.py; handled errors against the
{error, detail} ApiError body (a quota_exceeded 409 against QuotaError, which
adds type/used/limit), FastAPI's 422 against its declared HTTPValidationError.

The declared schemas are checked *strictly*: every declared property must be
present (pydantic marks defaulted fields optional, but reel-api always
serialises them, and the clients rely on the keys) and no undeclared one may
appear (response_model filters, a hand-built dict would not).
"""

from __future__ import annotations

import copy

import pytest

from tests.support import schemas
from tests.support.scenes import SCENES

# Routes that answer something other than JSON (byte ranges, HLS files) or
# nothing: not validated here (tests/test_streaming*.py, livehls, trailers).
NOT_JSON = {
    ("GET", "/api/downloads/{gid}/stream"),
    ("HEAD", "/api/downloads/{gid}/stream"),
    ("GET", "/api/downloads/{gid}/hls/{audio}/{name}"),
    ("GET", "/api/trailers/{key}/{name}"),
}


@pytest.fixture(scope="module")
def openapi():
    from reel_api.app import app

    return app.openapi()


def strict(schema):
    """Every object schema with properties: all of them required, nothing else allowed."""
    if isinstance(schema, list):
        return [strict(x) for x in schema]
    if not isinstance(schema, dict):
        return schema
    out = {k: (strict(v) if k not in ("properties", "$defs") else {n: strict(s) for n, s in v.items()})
           for k, v in schema.items()}
    if "properties" in out and out.get("type", "object") == "object":
        out["required"] = sorted(out["properties"])
        out.setdefault("additionalProperties", False)
    return out


def _param(name):
    marks = [pytest.mark.slow, pytest.mark.ffmpeg] if SCENES[name].slow else []
    return pytest.param(name, id=name, marks=marks)


# ---------------------------------------------------------------- the inventory


def json_routes(openapi) -> set[tuple[str, str]]:
    return {(m.upper(), p) for p, ms in openapi["paths"].items() for m in ms} - NOT_JSON


def test_every_json_route_has_a_real_answer(openapi):
    covered = {(s.method, s.route) for s in SCENES.values()}
    assert not json_routes(openapi) - covered, sorted(json_routes(openapi) - covered)
    assert not covered - json_routes(openapi), sorted(covered - json_routes(openapi))
    assert NOT_JSON <= {(m.upper(), p) for p, ms in openapi["paths"].items() for m in ms}


def test_enough_answers_including_errors():
    assert len(SCENES) >= 25
    assert sum(s.status >= 400 for s in SCENES.values()) >= 10
    assert {s.status for s in SCENES.values()} >= {200, 202, 400, 404, 409, 410, 422, 503}


def test_every_declared_model_is_used(openapi):
    """A route with a response_model gets validated against it, so no
    DOCUMENTED entry may shadow one, and every DOCUMENTED route exists."""
    for (method, route, status) in schemas.DOCUMENTED:
        assert schemas.api_schema(openapi, method, route, status) is None, (method, route, status)
        assert (method, route) in json_routes(openapi)


# ---------------------------------------------------------------- the answers


@pytest.mark.parametrize("name", [_param(n) for n in SCENES])
async def test_real_answer_matches_its_schema(world, openapi, name):
    sc = SCENES[name]
    if sc.slow:
        from tests.conftest import _need_ffmpeg

        _need_ffmpeg()
    r = await sc.run(world)
    assert r.headers["content-type"].startswith("application/json"), r.headers["content-type"]
    data = r.json()
    source, schema = schemas.schema_for(openapi, sc.method, sc.route, sc.status, data)
    check = strict(schema) if source == "openapi" else schema
    problems = schemas.validate(check, data)
    assert not problems, f"{sc.method} {sc.route} {sc.status} vs its {source} schema: {problems}\n{r.text[:800]}"


# ---------------------------------------------------------------- the checker itself


def test_strict_requires_defaulted_fields_and_rejects_extras(openapi):
    s = strict(schemas.api_schema(openapi, "POST", "/api/library", 202))
    ok = {"id": "1", "type": "tv", "title": "T", "status": "added", "undo": None}
    assert schemas.validate(s, ok) == []
    no_undo = {k: v for k, v in ok.items() if k != "undo"}
    assert any("'undo' is a required property" in p for p in schemas.validate(s, no_undo))
    assert any("Additional properties" in p for p in schemas.validate(s, {**ok, "extra": 1}))
    # nested models too (refs inlined)
    a = strict(schemas.api_schema(openapi, "GET", "/api/activity", 200))
    item = {k: None for k in a["properties"]["items"]["items"]["properties"]}
    assert any("items/0" in p for p in schemas.validate(a, {"items": [{**item, "bogus": 1}]}))


def test_documented_schemas_catch_shape_drift():
    st = {"id": "x", "audio": 1, "state": "done", "segments": 1, "buffered_s": 1.0, "duration": 2.0,
          "complete": True, "codecs": "avc1.640028,ec-3", "video": None, "audio_codec": "eac3",
          "progress": 1.0, "error": None}
    assert schemas.validate(schemas.HLS_STATUS, st) == []
    assert schemas.validate(schemas.HLS_STATUS, {**st, "state": "finished"})
    assert schemas.validate(schemas.HLS_STATUS, {k: v for k, v in st.items() if k != "codecs"})
    assert schemas.validate(schemas.ERROR, {"error": "x", "detail": "y"}) == []
    assert schemas.validate(schemas.ERROR, {"detail": "y"})
    assert schemas.validate(schemas.ERROR, {"error": "x", "detail": "y", "upstream": "z"})
    q = {"error": "quota_exceeded", "detail": "d", "type": "movie", "used": 10, "limit": 10}
    assert schemas.validate(schemas.QUOTA_ERROR, q) == []
    assert schemas.validate(schemas.QUOTA_ERROR, {k: v for k, v in q.items() if k != "used"})
    assert schemas.validate(schemas.ERROR, q)  # the plain error body has no room for the counts


def test_strict_does_not_touch_the_original(openapi):
    s = schemas.api_schema(openapi, "GET", "/api/news", 200)
    before = copy.deepcopy(s)
    strict(s)
    assert s == before
