"""GET /api/segments/{imdb_id}/{season}/{episode} (introdb.py): IntroDB's
crowdsourced intro/recap/outro windows, ms -> s, cached HIT_TTL (data) /
MISS_TTL (nothing submitted) / ERR_TTL (failure), LRU-capped at CACHE_MAX —
and never an error to the client.

IntroDB is mocked with respx at its real URL (api.introdb.app/segments, query
imdb_id/season/episode); the payload uses its field names (start_ms, end_ms,
submission_count)."""

from __future__ import annotations

import json

import httpx
import pytest

from reel_api import introdb as introdb_mod
from reel_api.models import CommunitySegments

NONE = {"intro": None, "recap": None, "outro": None}


def seg(start_ms, end_ms, n=3):
    return {"start_ms": start_ms, "end_ms": end_ms, "submission_count": n}


@pytest.fixture
def idb(upstream):
    """(imdb, season, episode) -> payload dict | httpx.Response | exception;
    default: 404 (nothing submitted)."""
    answers: dict = {}

    def handle(request):
        p = request.url.params
        a = answers.get((p["imdb_id"], int(p["season"]), int(p["episode"])), answers.get("*"))
        if a is None:
            return httpx.Response(404, json={"error": "not found"})
        if isinstance(a, Exception):
            raise a
        if isinstance(a, httpx.Response):
            return a
        return httpx.Response(200, json=a)

    route = upstream.get(introdb_mod.API).mock(side_effect=handle)
    route.answers = answers
    return route


async def segs(api, imdb="tt1234567", s=1, e=2, status=200):
    r = await api.get(f"/api/segments/{imdb}/{s}/{e}")
    assert r.status_code == status, r.text
    if status == 200:
        CommunitySegments.model_validate(r.json())
        return r.json()
    return r


# ---------------------------------------------------------------- shape


async def test_segments_in_seconds_with_submissions(api, idb):
    idb.answers[("tt1234567", 4, 3)] = {
        "imdb_id": "tt1234567", "season": 4, "episode": 3,
        "intro": seg(36_500, 98_250, 12),
        "recap": seg(1000, 35_000, 4),
        "outro": None,
    }
    assert await segs(api, s=4, e=3) == {
        "intro": {"start": 36.5, "end": 98.25, "submissions": 12},
        "recap": {"start": 1.0, "end": 35.0, "submissions": 4},
        "outro": None,
    }
    [call] = idb.calls
    assert dict(call.request.url.params) == {"imdb_id": "tt1234567", "season": "4", "episode": "3"}
    assert call.request.headers["User-Agent"] == "reel-api (VibeReel)"


@pytest.mark.parametrize("raw,want", [
    (None, None),
    ("intro", None),
    ([1000, 2000], None),
    ({}, None),
    ({"start_ms": 1000}, None),
    ({"end_ms": 1000}, None),
    (seg(5000, 5000), None),  # empty window
    (seg(6000, 5000), None),  # end before start
    (seg("1000", 2000), None),  # not a number (F9)
    (seg(1000, "2000"), None),
    (seg(False, True), None),  # bools are ints in Python, not milliseconds
    (seg(0, 1), {"start": 0.0, "end": 0.001, "submissions": 3}),
    (seg(1234, 5678, None), {"start": 1.234, "end": 5.678, "submissions": 0}),
    (seg(1000.4, 2000.6, 2), {"start": 1.0, "end": 2.001, "submissions": 2}),
    # as coded: a negative start is not rejected (only end <= start is)
    (seg(-2000, 3000, 1), {"start": -2.0, "end": 3.0, "submissions": 1}),
])
def test_seg(raw, want):
    assert introdb_mod._seg(raw) == want


async def test_unknown_kinds_and_extra_fields_are_ignored(api, idb):
    idb.answers["*"] = {"intro": seg(1000, 2000), "credits": seg(3000, 4000), "preview": seg(1, 2)}
    out = await segs(api)
    assert set(out) == {"intro", "recap", "outro"}
    assert out["intro"]["start"] == 1.0 and out["outro"] is None


# ---------------------------------------------------------------- never fails


@pytest.mark.parametrize("answer", [
    httpx.Response(500), httpx.Response(502, text="<html>"), httpx.Response(429),
    httpx.Response(200, text="not json"),
    httpx.Response(200, json={"intro": {"start_ms": 1, "end_ms": 2, "submission_count": "many"}}),
    httpx.ConnectError("down"), httpx.ReadTimeout("slow"),
], ids=["500", "502", "429", "bad-json", "bad-count", "unreachable", "timeout"])
async def test_failures_are_no_data_cached_err_ttl(api, idb, clock, monkeypatch, caplog, answer):
    clock.install(monkeypatch, introdb_mod)
    idb.answers["*"] = answer
    assert await segs(api) == NONE
    assert "introdb tt1234567 S1E2" in caplog.text
    clock.t += introdb_mod.ERR_TTL - 1
    assert await segs(api) == NONE
    assert idb.call_count == 1
    idb.answers["*"] = {"intro": seg(1000, 2000)}
    clock.t += 1
    assert (await segs(api))["intro"]["end"] == 2.0
    assert idb.call_count == 2


# ---------------------------------------------------------------- cache


async def test_hit_ttl_seven_days(api, idb, clock, monkeypatch):
    clock.install(monkeypatch, introdb_mod)
    idb.answers["*"] = {"intro": seg(1000, 2000)}
    await segs(api)
    idb.answers["*"] = {"intro": seg(1000, 3000)}
    clock.t += introdb_mod.HIT_TTL - 1
    assert (await segs(api))["intro"]["end"] == 2.0
    clock.t += 1
    assert (await segs(api))["intro"]["end"] == 3.0
    assert idb.call_count == 2


@pytest.mark.parametrize("miss", [None, {"intro": None, "recap": None, "outro": None}, {"intro": seg(5, 5)}],
                         ids=["404", "all-null", "only-invalid"])
async def test_miss_ttl_twelve_hours(api, idb, clock, monkeypatch, miss):
    clock.install(monkeypatch, introdb_mod)
    if miss is not None:
        idb.answers["*"] = miss
    assert await segs(api) == NONE
    idb.answers["*"] = {"outro": seg(2_500_000, 2_600_000)}
    clock.t += introdb_mod.MISS_TTL - 1
    assert await segs(api) == NONE
    clock.t += 1
    assert (await segs(api))["outro"] == {"start": 2500.0, "end": 2600.0, "submissions": 3}
    assert idb.call_count == 2


async def test_cache_is_per_episode(api, idb):
    idb.answers[("tt1234567", 1, 1)] = {"intro": seg(1000, 2000)}
    idb.answers[("tt1234567", 1, 2)] = {"intro": seg(3000, 4000)}
    idb.answers[("tt7654321", 1, 1)] = {"recap": seg(0, 30_000)}
    assert (await segs(api, e=1))["intro"]["start"] == 1.0
    assert (await segs(api, e=2))["intro"]["start"] == 3.0
    assert (await segs(api, "tt7654321", 1, 1))["recap"]["end"] == 30.0
    assert (await segs(api, s=2, e=1)) == NONE
    for _ in range(3):
        await segs(api, e=1)
    assert idb.call_count == 4


async def test_stale_hit_is_served_when_a_refresh_fails(api, idb, clock, monkeypatch):
    clock.install(monkeypatch, introdb_mod)
    idb.answers["*"] = {"intro": seg(1000, 2000)}
    first = await segs(api)
    clock.t += introdb_mod.HIT_TTL
    idb.answers["*"] = httpx.Response(503)
    assert await segs(api) == first
    # not re-stamped: the very next request tries again
    idb.answers["*"] = {"intro": seg(1000, 9000)}
    assert (await segs(api))["intro"]["end"] == 9.0
    assert idb.call_count == 3


async def test_cache_max_evicts_least_recently_used(api, idb, monkeypatch):
    monkeypatch.setattr(introdb_mod, "CACHE_MAX", 3)
    idb.answers["*"] = {"intro": seg(1000, 2000)}
    for e in (1, 2, 3):
        await segs(api, e=e)
    await segs(api, e=1)  # a hit refreshes episode 1's place
    assert idb.call_count == 3
    await segs(api, e=4)  # evicts episode 2, the least recently used
    cache = api.app_module.introdb._cache
    assert [k[2] for k in cache] == [3, 1, 4]
    await segs(api, e=1)
    assert idb.call_count == 4
    await segs(api, e=2)
    assert idb.call_count == 5 and [k[2] for k in cache] == [4, 1, 2]  # 3 went


# ---------------------------------------------------------------- path validation


@pytest.mark.parametrize("path", [
    "tt1234/1/1",  # 4 digits
    "tt12345678901/1/1",  # 11 digits
    "1234567/1/1", "nm1234567/1/1", "TT1234567/1/1", "tt1234567x/1/1",
    "tt1234567/-1/1", "tt1234567/501/1", "tt1234567/one/1",
    "tt1234567/1/-1", "tt1234567/1/5001", "tt1234567/1/1.5",
])
async def test_path_validation_is_422(api, idb, path):
    r = await api.get(f"/api/segments/{path}")
    assert r.status_code == 422, r.text
    assert idb.call_count == 0


@pytest.mark.parametrize("path", ["tt12345/0/0", "tt1234567890/500/5000"])
async def test_path_bounds_are_accepted(api, idb, path):
    r = await api.get(f"/api/segments/{path}")
    assert r.status_code == 200 and r.json() == NONE


# ---------------------------------------------------------------- known bugs


@pytest.mark.parametrize("body", [
    [],  # a list: data.get -> AttributeError
    {"intro": {"start_ms": "1000", "end_ms": 2000}},  # str vs int compare -> TypeError
    {"intro": {"start_ms": "1000", "end_ms": "2000"}},  # "1000" / 1000 -> TypeError
], ids=["list-body", "mixed-types", "string-ms"])
async def test_malformed_json_shape_is_no_data_cached_err_ttl(make_api, idb, clock, monkeypatch, body):
    """introdb promises "errors are never raised to the client": a JSON body
    of an unexpected shape is no data, cached ERR_TTL like every other failure
    (test_failures_are_no_data_cached_err_ttl). It used to be a plain 500,
    nothing cached (F9)."""
    json.dumps(body)  # the payloads are valid JSON
    clock.install(monkeypatch, introdb_mod)
    idb.answers["*"] = body
    async with make_api(raise_app_exceptions=False) as api:
        assert await segs(api) == NONE
        clock.t += introdb_mod.ERR_TTL - 1
        assert await segs(api) == NONE
    assert idb.call_count == 1
