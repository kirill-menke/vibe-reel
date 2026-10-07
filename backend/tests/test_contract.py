"""Contract: the fields the TV and phone clients read from reel-api exist in
the declared response schemas AND in real answers (tests/contract_fields.py
is the table; tests/support/scenes.py produces the answers).

A failure here means one of three things, each named in the message:
the client no longer reads the field the way the table says (update the
table), the API stopped declaring it (a contract break), or the real answer
lacks it (the declared model and the code disagree, or the scene is too thin).
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from tests import contract_fields as cf
from tests.support import schemas
from tests.support.scenes import SCENES
from tests.support.known_bugs import known_bug

# The repo root: backend/tests/ -> repo. Under mutmut the suite runs from a
# copy in backend/mutants/tests/, one level deeper, so walk up to the first
# directory that holds the client sources rather than counting parents.
REPO = next(p for p in Path(__file__).resolve().parents if (p / "src" / "lib" / "medialib.js").is_file())

ALL = [*cf.READS, *cf.CODES, *cf.STATUSES, *cf.KNOWN_GAPS]


@pytest.fixture(scope="module")
def openapi():
    from reel_api.app import app

    return app.openapi()


def _src(file: str) -> str:
    p = REPO / file
    assert p.is_file(), f"{file} does not exist (moved? update tests/contract_fields.py)"
    return p.read_text(encoding="utf-8")


def _occurs(ident: str, text: str) -> bool:
    pat = re.escape(ident)
    if re.match(r"[\w$]", ident):
        pat = r"(?<![\w$.])" + pat
    if re.search(r"[\w$]$", ident):
        pat += r"(?![\w$])"
    return re.search(pat, text) is not None


def _eid(e) -> str:
    return f"{type(e).__name__}:{e.scene}:{getattr(e, 'path', None) or getattr(e, 'code', '')}:{e.file}:{e.ident}"


# ---------------------------------------------------------------- the table itself


def test_table_entries_are_unique_and_name_known_scenes():
    ids = [_eid(e) for e in ALL]
    assert len(ids) == len(set(ids)), [i for i in ids if ids.count(i) > 1]
    unknown = sorted({e.scene for e in ALL} - set(SCENES))
    assert not unknown, f"entries name scenes that don't exist: {unknown}"


def test_table_size():
    """The table covers the ~20 client-used routes; a shrinking table is a
    weakened oracle (move entries, don't delete them)."""
    routes = {(SCENES[e.scene].method, SCENES[e.scene].route) for e in ALL}
    assert len(routes) >= 20, sorted(routes)
    assert len(cf.READS) >= 140


@pytest.mark.parametrize("entry", ALL, ids=_eid)
def test_cited_identifier_still_occurs_in_the_client(entry):
    assert _occurs(entry.ident, _src(entry.file)), (
        f"{entry.file} no longer contains {entry.ident!r}: the client changed how it reads "
        f"{entry.scene} — update tests/contract_fields.py")


def test_occurs_is_exact():
    assert _occurs("it.media_id", "x = it.media_id;")
    assert not _occurs("it.media_id", "x = it.media_idx;")
    assert not _occurs("it.media_id", "x = edit.media_id;")
    assert not _occurs("it.media_id", "x = a.it.media_id;")
    assert _occurs("meta?.collection", "if (meta?.collection) {}")
    assert _occurs("'has_files'", "e.code === 'has_files'")
    assert _occurs("e.status === 410", "if (e.status === 410) x()")
    assert not _occurs("e.status === 410", "if (e.status === 4100) x()")


def test_every_route_medialib_calls_is_in_the_table():
    """Every '/api/...' literal in the client modules is a route (or the
    prefix of a parameterised route) some entry covers."""
    covered = {SCENES[e.scene].route for e in ALL}
    literals = set()
    for f in (cf.ML, cf.LIVE, cf.TRAILER):
        literals |= set(re.findall(r"'(/api/[a-z/]*)'", _src(f)))
    for ident in ("'/config'", "'/status'"):  # push.js: base() + path
        assert _occurs(ident, _src(cf.P_PUSH)), ident
    assert "'/api/push'" in _src(cf.P_PUSH)
    literals |= {"/api/push/config", "/api/push/status"}
    assert len(literals) >= 16, sorted(literals)
    missing = [lit for lit in sorted(literals)
               if not any(r == lit or (lit.endswith("/") and r.startswith(lit)) for r in covered)]
    assert not missing, f"client routes without a contract entry: {missing}"


# ---------------------------------------------------------------- schema side


@pytest.mark.parametrize("entry", [*cf.READS], ids=_eid)
def test_field_is_declared_in_the_response_schema(openapi, entry):
    sc = SCENES[entry.scene]
    # an error scene's body schema depends on its code (quota_exceeded: QuotaError)
    data = next(({"error": c.code} for c in cf.CODES if c.scene == entry.scene), None)
    source, schema = schemas.schema_for(openapi, sc.method, sc.route, sc.status, data)
    assert schemas.has_field(schema, entry.path), (
        f"{sc.method} {sc.route} {sc.status}: {entry.path} is not in the {source} schema, "
        f"but {entry.file} reads it ({entry.ident})")


def test_has_field_walks_refs_lists_and_nullables(openapi):
    s = schemas.api_schema(openapi, "GET", "/api/activity", 200)
    assert schemas.has_field(s, "items[].media_id")
    assert not schemas.has_field(s, "items[].nope")
    assert not schemas.has_field(s, "items.media_id")  # a list must be walked with []
    m = schemas.api_schema(openapi, "GET", "/api/metadata/{media_type}/{media_id}", 200)
    assert schemas.has_field(m, "collection.id")  # CollectionRef | None
    assert schemas.has_field(m, "episodes[].still")
    c = schemas.api_schema(openapi, "GET", "/api/charts/{key}", 200)
    assert schemas.has_field(c, "sections[].results[].rank")
    assert schemas.api_schema(openapi, "GET", "/api/downloads/{gid}/probe", 200) is None


def test_payload_has_needs_every_element_and_a_non_empty_list():
    assert schemas.payload_has({"a": [{"b": None}, {"b": 1}]}, "a[].b")
    assert not schemas.payload_has({"a": [{"b": 1}, {}]}, "a[].b")
    assert not schemas.payload_has({"a": []}, "a[].b")
    assert not schemas.payload_has({"a": None}, "a.b")
    assert schemas.payload_has({"a": {"b": 0}}, "a.b")


# ---------------------------------------------------------------- real answers


def _scenes_in(entries) -> list[str]:
    return sorted({e.scene for e in entries})


def _param(name):
    return pytest.param(name, id=name, marks=[pytest.mark.slow, pytest.mark.ffmpeg] if SCENES[name].slow else [])


@pytest.mark.parametrize("name", [_param(n) for n in _scenes_in([*cf.READS, *cf.CODES, *cf.STATUSES])])
async def test_real_answer_carries_what_the_clients_read(world, name):
    sc = SCENES[name]
    if sc.slow:
        from tests.conftest import _need_ffmpeg

        _need_ffmpeg()
    r = await sc.run(world)  # asserts the scene's status
    data = r.json()
    missing = [f"{e.path} ({e.file}: {e.ident})" for e in cf.READS
               if e.scene == name and not schemas.payload_has(data, e.path)]
    assert not missing, f"{sc.method} {sc.route} {sc.status} answer lacks {missing}: {r.text[:500]}"
    for c in (c for c in cf.CODES if c.scene == name):
        assert data.get("error") == c.code, (c, data)
    # a status entry's comparison names the scene's status
    for s in (s for s in cf.STATUSES if s.scene == name):
        assert re.search(rf"\b{sc.status}\b", s.ident), (s, sc.status)


@pytest.mark.parametrize("gap", [pytest.param(g, id=_eid(g), marks=known_bug("F15", "the route never sends it"))
                                 for g in cf.KNOWN_GAPS])
async def test_known_gap_is_served(world, openapi, gap):
    """A field a client reads must be in the route's schema and its real
    answer. KNOWN_GAPS are reads the API doesn't serve yet; once one is
    served, move it to READS. Empty since F15 (phone LookupDetail's
    meta?.digital_release) was fixed, so this collects nothing; a new gap
    needs its own finding id in the marker."""
    sc = SCENES[gap.scene]
    _, schema = schemas.schema_for(openapi, sc.method, sc.route, sc.status)
    assert schemas.has_field(schema, gap.path)
    r = await sc.run(world)
    assert schemas.payload_has(r.json(), gap.path), r.text[:500]
