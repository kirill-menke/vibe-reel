"""GET /api/trending (trending.py): IMDb GraphQL advancedTitleSearch ->
window/rank filters -> Sonarr/Radarr `imdb:` resolution -> dedupe -> 6 h cache.

IMDb is ImdbSim (tests/support/imdb.py), which applies the query's own
constraints the way the real edge does (rating/votes floors, *any* release
date in range), so a wrong variable shows up as a wrong result. Dates are
frozen with time_machine; the cache runs on a FakeClock.
"""

from __future__ import annotations

import asyncio
import datetime as dt

import httpx
import pytest

from reel_api import trending as trending_mod
from reel_api.models import TrendingResponse
from tests.support.arr import movie_obj, series_obj
from tests.support.imdb import ImdbSim, ImdbTitle

TODAY = dt.date(2026, 9, 1)
START = TODAY - trending_mod.MAX_AGE  # 2026-03-02
END = TODAY - trending_mod.MIN_AGE  # 2026-08-04


@pytest.fixture(autouse=True)
def frozen(time_machine):
    time_machine.move_to(dt.datetime(2026, 9, 1, 12, 0, tzinfo=dt.timezone.utc), tick=False)


@pytest.fixture
def imdb(upstream):
    return ImdbSim(upstream)


def days(n):
    return dt.timedelta(days=n)


def movie(imdb, radarr, n, *, rank=10, released=TODAY - days(60), rating=8.0, votes=50_000,
          releases=None, resolve=True, library=False, **kw):
    tid = f"tt{9_100_000 + n}"
    imdb.add(ImdbTitle(tid, f"Movie {n}", "movie", rating=rating, votes=votes, rank=rank,
                       release=released, releases=releases or ([released] if isinstance(released, dt.date) else [])))
    if resolve:
        obj = movie_obj(5000 + n, f"Movie {n}", imdb=tid, **kw)
        radarr.add_movie(obj) if library else radarr.add_catalog(obj)
    return tid


def show(imdb, sonarr, n, *, rank=10, releases=(TODAY - days(60),), rating=8.5, votes=50_000,
         kind="tvSeries", resolve=True):
    tid = f"tt{9_200_000 + n}"
    imdb.add(ImdbTitle(tid, f"Show {n}", kind, rating=rating, votes=votes, rank=rank,
                       release=releases[0] if releases else None, releases=list(releases)))
    if resolve:
        sonarr.add_catalog(series_obj(7000 + n, f"Show {n}", imdb=tid))
    return tid


async def trending(api, kind="tv", status=200):
    r = await api.get("/api/trending", params={"type": kind})
    assert r.status_code == status, r.text
    if status == 200:
        TrendingResponse.model_validate(r.json())
        assert r.json()["type"] == kind
        return r.json()["results"]
    return r


# ---------------------------------------------------------------- the IMDb request


@pytest.mark.parametrize("kind,types", [("tv", ["tvSeries", "tvMiniSeries"]), ("movie", ["movie"])])
async def test_imdb_request(api, imdb, sonarr, radarr, kind, types):
    await trending(api, kind)
    [(variables, headers)] = imdb.requests
    assert headers["x-imdb-client-name"] == "imdb-web-next"
    assert variables == {"types": types, "start": START.isoformat(), "end": END.isoformat(),
                         "rating": 7.5, "votes": 10_000}
    assert imdb.ops == ["Trending"]


async def test_rating_and_vote_floors_are_sent(api, imdb, radarr):
    keep = movie(imdb, radarr, 1, rating=7.5, votes=10_000)
    movie(imdb, radarr, 2, rating=7.4, votes=500_000)
    movie(imdb, radarr, 3, rating=9.0, votes=9_999)
    res = await trending(api, "movie")
    assert [r["imdb_id"] for r in res] == [keep]


async def test_popularity_rank_cap(api, imdb, sonarr):
    """Regression (trending.py docstring): 8.8 from 106k votes at rank ~1900
    passed the vote floor; being in IMDb's top 1000 by popularity is required."""
    show(imdb, sonarr, 1, rank=1900, rating=8.8, votes=106_000)
    edge = show(imdb, sonarr, 2, rank=trending_mod.MAX_RANK)
    show(imdb, sonarr, 3, rank=1001)
    show(imdb, sonarr, 4, rank=None)
    first = show(imdb, sonarr, 5, rank=1)
    res = await trending(api, "tv")
    assert [r["imdb_id"] for r in res] == [first, edge]  # most popular first
    assert [r["rank"] for r in res] == [1, 1000]


async def test_movie_window_uses_the_primary_release_date(api, imdb, radarr):
    inside = movie(imdb, radarr, 1, released=START)  # boundaries are inclusive
    end = movie(imdb, radarr, 2, released=END, rank=11)
    movie(imdb, radarr, 3, released=START - days(1), rank=12)
    movie(imdb, radarr, 4, released=END + days(1), rank=13)
    # a festival premiere inside the window, the real release too recent: out
    movie(imdb, radarr, 5, released=TODAY - days(10), releases=[TODAY - days(100), TODAY - days(10)], rank=14)
    # a festival premiere long ago, the primary release inside the window: in
    late = movie(imdb, radarr, 6, released=TODAY - days(40), releases=[TODAY - days(400), TODAY - days(40)], rank=15)
    res = await trending(api, "movie")
    assert [r["imdb_id"] for r in res] == [inside, end, late]
    assert [r["released"] for r in res] == [START.isoformat(), END.isoformat(), (TODAY - days(40)).isoformat()]


async def test_show_window_uses_the_first_episode(api, imdb, sonarr):
    ok = show(imdb, sonarr, 1, releases=(TODAY - days(90), TODAY - days(30)))
    # an episode in the window, but the show premiered years ago: out
    show(imdb, sonarr, 2, releases=(TODAY - days(30), dt.date(2019, 1, 1)), rank=11)
    mini = show(imdb, sonarr, 3, releases=((2026,), TODAY - days(50)), kind="tvMiniSeries", rank=12)
    res = await trending(api, "tv")
    assert [r["imdb_id"] for r in res] == [ok, mini]
    assert res[0]["released"] == (TODAY - days(90)).isoformat()


def test_partial_and_invalid_dates():
    assert trending_mod._date({"year": 2026, "month": 2, "day": 30}) is None
    assert trending_mod._date({"year": 2026, "month": 2}) is None
    assert trending_mod._date({"year": 2026}) is None
    assert trending_mod._date(None) is None
    assert trending_mod._date({"year": 2026, "month": 2, "day": 3}) == dt.date(2026, 2, 3)
    assert trending_mod._released("tv", {"releaseDates": {"edges": [{"node": {"year": 2026}}]}}) is None
    assert trending_mod._released("tv", {}) is None
    assert trending_mod._released("movie", {"releaseDate": None}) is None


# ---------------------------------------------------------------- resolution


async def test_results_are_lookup_shaped_with_imdb_fields(api, imdb, radarr):
    tid = movie(imdb, radarr, 1, rank=7, rating=8.1, votes=123_456, library=True,
                digital_release="2026-07-15T00:00:00Z")
    unknown = movie(imdb, radarr, 2, rank=8, resolve=False)
    res = await trending(api, "movie")
    [r] = res
    assert r["imdb_id"] == tid and unknown not in {x["imdb_id"] for x in res}
    assert r["id"] == "5001" and r["type"] == "movie" and r["title"] == "Movie 1"
    assert r["added"] is True
    assert (r["rating"], r["rating_votes"], r["rank"]) == (8.1, 123_456, 7)
    assert r["released"] == (TODAY - days(60)).isoformat()
    assert r["digital_release"] == "2026-07-15"
    terms = [c.params["term"] for c in radarr.called("/api/v3/movie/lookup")]
    assert sorted(terms) == sorted(["imdb:" + tid, "imdb:" + unknown])


async def test_dedupe_keeps_the_best_ranked(api, imdb, sonarr):
    a = show(imdb, sonarr, 1, rank=5)
    b = show(imdb, sonarr, 2, rank=6, resolve=False)
    # IMDb lists the show twice; both ids resolve to the same tvdb title
    sonarr.set_lookup("imdb:" + b, [series_obj(7001, "Show 1", imdb=a)])
    res = await trending(api, "tv")
    assert [(r["imdb_id"], r["id"], r["rank"]) for r in res] == [(a, "7001", 5)]
    assert trending_mod.dedupe([{"type": "tv", "id": "1", "n": 1}, {"type": "movie", "id": "1"},
                                {"type": "tv", "id": "1", "n": 2}]) == [
        {"type": "tv", "id": "1", "n": 1}, {"type": "movie", "id": "1"}]


async def test_only_the_first_limit_hits_are_resolved(api, imdb, radarr):
    ids = [movie(imdb, radarr, n, rank=n) for n in range(1, 26)]
    res = await trending(api, "movie")
    assert [r["imdb_id"] for r in res] == ids[:trending_mod.LIMIT]
    assert radarr.count("/api/v3/movie/lookup") == trending_mod.LIMIT


async def test_a_failed_lookup_costs_one_tile_and_is_not_cached(api, imdb, radarr, caplog):
    a, b = movie(imdb, radarr, 1, rank=1), movie(imdb, radarr, 2, rank=2)
    radarr.set_lookup("imdb:" + a, httpx.Response(500))
    res = await trending(api, "movie")
    assert [r["imdb_id"] for r in res] == [b]
    assert "lookup " + a + " failed" in caplog.text
    radarr.set_lookup("imdb:" + a, [movie_obj(5001, "Movie 1", imdb=a)])
    res = await trending(api, "movie")  # incomplete list wasn't cached: refetched
    assert [r["imdb_id"] for r in res] == [a, b]
    assert len(imdb.requests) == 2


# ---------------------------------------------------------------- cache


async def test_six_hour_cache_and_ttl(api, imdb, radarr, clock, monkeypatch):
    clock.install(monkeypatch, trending_mod)
    movie(imdb, radarr, 1)
    await trending(api, "movie")
    await trending(api, "tv")  # per kind
    assert len(imdb.requests) == 2
    clock.t += trending_mod.CACHE_TTL - 1
    await trending(api, "movie")
    assert len(imdb.requests) == 2
    movie(imdb, radarr, 2, rank=1)
    clock.t += 1
    res = await trending(api, "movie")
    assert len(imdb.requests) == 3 and len(res) == 2
    # the warm-up's shorter ttl refreshes early; the next request is served from it
    t = api.app_module.trending
    clock.t += 100
    await t.get("movie", ttl=200)
    assert len(imdb.requests) == 3
    await t.get("movie", ttl=50)
    assert len(imdb.requests) == 4
    await trending(api, "movie")
    assert len(imdb.requests) == 4


async def test_concurrent_requests_share_one_refresh(api, imdb, radarr):
    movie(imdb, radarr, 1)
    gate = radarr.gate("/api/v3/movie/lookup")
    tasks = [asyncio.create_task(trending(api, "movie")) for _ in range(3)]
    for _ in range(50):
        await asyncio.sleep(0)
    gate.set()
    results = await asyncio.gather(*tasks)
    assert len(imdb.requests) == 1
    assert results[0] == results[1] == results[2] and len(results[0]) == 1


# ---------------------------------------------------------------- errors


@pytest.mark.parametrize("fault", [
    {"status": 500}, {"status": 403}, {"exc": httpx.ConnectError("down")},
    {"errors": [{"message": "rate limited"}]}, {"body": {"data": None}},
], ids=["500", "403", "unreachable", "graphql-errors", "no-data"])
async def test_imdb_failure_is_503_retry_after_300(api, imdb, radarr, fault, caplog):
    movie(imdb, radarr, 1)
    imdb.fail(**fault)
    r = await trending(api, "movie", status=503)
    assert r.headers["Retry-After"] == "300"
    assert r.json() == {"error": "temporarily_unavailable",
                        "detail": "trending list temporarily unavailable, retry later"}
    assert "trending:" in caplog.text


async def test_stale_list_is_served_when_imdb_fails(api, imdb, radarr, clock, monkeypatch, caplog):
    clock.install(monkeypatch, trending_mod)
    movie(imdb, radarr, 1)
    first = await trending(api, "movie")
    clock.t += trending_mod.CACHE_TTL + 1
    imdb.fail(status=502)
    assert await trending(api, "movie") == first
    assert "serving stale" in caplog.text
    # a refresh with a failed lookup doesn't replace the good list either
    movie(imdb, radarr, 2, rank=1)
    radarr.set_lookup("imdb:" + imdb.titles[1].id, httpx.Response(500))
    assert await trending(api, "movie") == first


async def test_missing_client_header_is_what_imdb_403s(imdb):
    """The fake's 403 without the header is the documented edge behaviour —
    and Trending always sends it (test_imdb_request)."""
    async with httpx.AsyncClient() as c:
        r = await c.post(trending_mod.IMDB_GRAPHQL, json={"query": "query Trending { x }"})
    assert r.status_code == 403


@pytest.mark.parametrize("missing", ["tv", "movie"])
async def test_type_without_its_arr_is_503(make_api, imdb, missing):
    env = {"SONARR_API_KEY": None} if missing == "tv" else {"RADARR_API_KEY": None}
    async with make_api(**env) as api:
        r = await trending(api, missing, status=503)
    assert r.json()["error"] == "not_available"
    assert imdb.requests == []


@pytest.mark.parametrize("bad", ["anime", "", "TV"])
async def test_bad_type_is_422(api, bad):
    r = await api.get("/api/trending", params={"type": bad})
    assert r.status_code == 422


async def test_default_type_is_tv(api, imdb, sonarr):
    show(imdb, sonarr, 1)
    r = await api.get("/api/trending")
    assert r.status_code == 200 and r.json()["type"] == "tv" and len(r.json()["results"]) == 1


async def test_non_json_200_from_imdb_is_503_retry_after_300(make_api, imdb, radarr):
    """A non-JSON 200 from IMDb is an IMDb failure like a 5xx
    (test_imdb_failure_is_503_retry_after_300)."""
    movie(imdb, radarr, 1)
    imdb.route.side_effect = lambda request: httpx.Response(200, text="<html>edge error</html>")
    async with make_api(raise_app_exceptions=False) as api:
        r = await trending(api, "movie", status=503)
    assert r.headers.get("Retry-After") == "300"
    assert r.json() == {"error": "temporarily_unavailable",
                        "detail": "trending list temporarily unavailable, retry later"}


async def test_stale_list_is_served_when_imdb_answers_non_json(make_api, imdb, radarr, clock, monkeypatch):
    """...and an expired cached list is served as stale, as for a 5xx
    (test_stale_list_is_served_when_imdb_fails)."""
    clock.install(monkeypatch, trending_mod)
    movie(imdb, radarr, 1)
    async with make_api(raise_app_exceptions=False) as api:
        first = await trending(api, "movie")
        clock.t += trending_mod.CACHE_TTL + 1
        imdb.route.side_effect = lambda request: httpx.Response(200, text="<html>edge error</html>")
        assert await trending(api, "movie") == first
