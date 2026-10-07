"""charts.py / trending.py details the earlier tests reached only loosely —
found by the hardening mutation pass (tests/run_mutmut.sh charts trending):
the IMDb request deadline, the exact error texts (they become the server log
lines), skipped IMDb edges not ending the scan, a missing vote count, the
lookup concurrency limits (8 per chart request, 2 during warm-up, 4 for
trending), per-list refresh locks, the index's ttl, the warm-up's defaults
and margin arithmetic, and every operator-facing log line."""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging

import httpx
import pytest

from reel_api import charts as charts_mod
from reel_api import trending as trending_mod
from reel_api.charts import ChartsError
from reel_api.trending import TrendingError
from tests.support.imdb import ImdbSim
from tests.test_charts import movie as chart_movie
from tests.test_trending import TODAY, days
from tests.test_trending import movie as trend_movie


@pytest.fixture
def imdb(upstream):
    return ImdbSim(upstream)


def msgs(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.name == "reel_api"]


async def spin(n: int = 50) -> None:
    for _ in range(n):
        await asyncio.sleep(0)


TOP_MOVIE = charts_mod.categories()[0]
PAIRS = 2 + 2 * len(charts_mod.GENRES)  # (category, kind) lists


# ================================================================ trending


@pytest.fixture
def frozen(time_machine):
    time_machine.move_to(dt.datetime(2026, 9, 1, 12, 0, tzinfo=dt.timezone.utc), tick=False)


async def test_trending_imdb_deadline_is_20s(api):
    assert api.app_module.trending._client.timeout == httpx.Timeout(20)


@pytest.mark.parametrize("fault,text", [
    ({"exc": httpx.ConnectError("no route")}, "imdb unreachable: no route"),
    ({"status": 500}, "imdb HTTP 500"),
])
async def test_trending_error_texts(api, imdb, fault, text):
    imdb.fail(**fault)
    with pytest.raises(TrendingError) as e:
        await api.app_module.trending._imdb("movie", TODAY)
    assert str(e.value) == text


async def test_trending_graphql_errors_next_to_data_are_an_error(api, imdb):
    errors = [{"message": "m" * 300}]
    imdb.fail(body={"errors": errors, "data": {"advancedTitleSearch": {"edges": []}}})
    with pytest.raises(TrendingError) as e:
        await api.app_module.trending._imdb("movie", TODAY)
    assert str(e.value) == "imdb: " + str(errors)[:200]


async def test_a_skipped_edge_does_not_end_the_scan(api, imdb, radarr, frozen):
    """Both skip rules `continue`: a better-ranked title that fails the date
    rules must not hide the qualifying titles after it."""
    # rank 1: in IMDb's range only through a festival date; primary release too old
    trend_movie(imdb, radarr, 1, rank=1, released=TODAY - days(400), releases=[TODAY - days(400), TODAY - days(60)])
    # rank 2: primary release only month-precise -> can't be placed
    trend_movie(imdb, radarr, 2, rank=2, released=(2026, 7), releases=[(2026, 7), TODAY - days(60)])
    ok = trend_movie(imdb, radarr, 3, rank=3)
    hits = await api.app_module.trending._imdb("movie", TODAY)
    assert [h["imdb_id"] for h in hits] == [ok]


async def test_a_missing_vote_count_is_zero(api, imdb, radarr, frozen):
    tid = "tt9100001"
    node = {"id": tid, "releaseDate": {"year": 2026, "month": 7, "day": 1},
            "ratingsSummary": {"aggregateRating": 8.0}, "meterRanking": {"currentRank": 3}}
    imdb.fail(body={"data": {"advancedTitleSearch": {"edges": [{"node": {"title": node}}]}}})
    [hit] = await api.app_module.trending._imdb("movie", TODAY)
    assert hit["rating_votes"] == 0


async def test_trending_resolves_at_most_four_at_once(api, imdb, radarr, frozen):
    for n in range(1, 8):
        trend_movie(imdb, radarr, n, rank=n)
    gate = radarr.gate("/api/v3/movie/lookup")
    task = asyncio.create_task(api.app_module.trending.get("movie"))
    await spin()
    assert radarr.count("/api/v3/movie/lookup") == 4
    gate.set()
    assert len(await task) == 7


async def test_trending_log_lines(api, imdb, radarr, frozen, clock, monkeypatch, caplog):
    clock.install(monkeypatch, trending_mod)
    a = trend_movie(imdb, radarr, 1, rank=1)
    trend_movie(imdb, radarr, 2, rank=2)
    radarr.set_lookup("imdb:" + a, httpx.Response(500))
    t = api.app_module.trending
    await t.get("movie")
    assert msgs(caplog) == [f"trending: movie lookup {a} failed: movie HTTP 500"]
    del radarr.lookup_overrides["imdb:" + a]
    await t.get("movie")  # complete now: cached
    caplog.clear()
    clock.t += trending_mod.CACHE_TTL
    imdb.fail(status=502)
    await t.get("movie")
    assert msgs(caplog) == ["trending movie refresh failed, serving stale: imdb HTTP 502"]


# ================================================================ charts


def test_a_chart_hit_without_a_vote_count_has_zero_votes():
    hit = charts_mod._hit({"id": "tt1", "ratingsSummary": {"aggregateRating": 7.0}}, 5)
    assert hit["rating_votes"] == 0 and hit["rank"] == 5
    assert charts_mod._hit({"id": "tt2"}, 1)["rating_votes"] == 0


async def test_different_lists_refresh_concurrently(api, monkeypatch):
    """The refresh lock is per (category, kind): one slow list never holds
    up another (the index fetches ~40 at once)."""
    ch = api.app_module.charts
    inside, release = [0], asyncio.Event()

    async def slow_fetch(cat, kind):
        inside[0] += 1
        await release.wait()
        return []

    monkeypatch.setattr(ch, "_fetch", slow_fetch)
    cats = charts_mod.categories()
    tasks = [asyncio.create_task(ch._list(cats[0], "movie")), asyncio.create_task(ch._list(cats[1], "tv")),
             asyncio.create_task(ch._list(cats[2], "movie")), asyncio.create_task(ch._list(cats[2], "tv"))]
    await spin()
    assert inside[0] == 4
    release.set()
    await asyncio.gather(*tasks)


async def test_a_chart_request_resolves_at_most_eight_at_once(api, imdb, radarr):
    ids = [chart_movie(imdb, radarr, n) for n in range(1, 11)]
    imdb.set_chart("TOP_RATED_MOVIES", ids)
    gate = radarr.gate("/api/v3/movie/lookup")
    task = asyncio.create_task(api.app_module.charts.get("top-movie"))
    await spin()
    assert radarr.count("/api/v3/movie/lookup") == 8
    gate.set()
    assert len((await task)["sections"][0]["results"]) == 10


async def test_index_ttl_is_honoured(api, imdb, radarr, sonarr):
    imdb.set_chart("TOP_RATED_MOVIES", [chart_movie(imdb, radarr, 1)])
    ch = api.app_module.charts
    await ch.index()
    assert len(imdb.requests) == PAIRS
    await ch.index()
    assert len(imdb.requests) == PAIRS  # all fresh
    await ch.index(0)  # ttl 0: every list is refetched
    assert len(imdb.requests) == 2 * PAIRS


async def test_index_error_and_log_texts(api, imdb, radarr, sonarr, caplog):
    imdb.fail(status=500, times=PAIRS)
    with pytest.raises(ChartsError) as e:
        await api.app_module.charts.index()
    assert str(e.value) == "no chart could be fetched"
    assert "charts: top-movie unavailable: imdb HTTP 500" in msgs(caplog)
    assert "charts: genre-Western unavailable: imdb HTTP 500" in msgs(caplog)


async def test_warm_defaults(api, imdb, radarr, sonarr, clock, monkeypatch, caplog):
    """No arguments: a 0.5 s pause per list, and margin 0 — an entry one
    second short of its ttl is still fresh, so a second pass fetches nothing
    and logs nothing."""
    clock.install(monkeypatch, charts_mod)
    imdb.set_chart("TOP_RATED_MOVIES", [chart_movie(imdb, radarr, 1)])
    ch = api.app_module.charts
    t0 = clock.t
    await ch.warm()
    assert clock.sleeps == [0.5] * PAIRS
    assert len(imdb.requests) == PAIRS and radarr.count("/api/v3/movie/lookup") == 1
    # everything was fetched at t0 (the index first, the one lookup before the first pause)
    clock.t = t0 + charts_mod.LIST_TTL - 1
    await ch.warm(pause=0)
    assert len(imdb.requests) == PAIRS and radarr.count("/api/v3/movie/lookup") == 1
    assert msgs(caplog) == []


async def test_warm_with_a_margin_past_the_ttl_refreshes_everything_now(api, imdb, radarr, sonarr, clock,
                                                                         monkeypatch, caplog):
    clock.install(monkeypatch, charts_mod)
    imdb.set_chart("TOP_RATED_MOVIES", [chart_movie(imdb, radarr, 1)])
    ch = api.app_module.charts
    await ch.warm(pause=0)
    big = 2 * max(charts_mod.LIST_TTL, charts_mod.RESOLVE_TTL)
    await ch.warm(margin=big, pause=0)  # no time passed at all: ttl 0, still refetched
    assert len(imdb.requests) >= 2 * PAIRS
    assert radarr.count("/api/v3/movie/lookup") >= 2
    assert msgs(caplog) == []


async def test_warm_retries_a_list_whose_index_refresh_failed(api, imdb, radarr, sonarr, clock, monkeypatch,
                                                              caplog):
    """The per-category pass uses the warm-up's shortened ttl too: a list the
    index pass could only serve stale is fetched again right away."""
    clock.install(monkeypatch, charts_mod)
    imdb.set_chart("TOP_RATED_MOVIES", [chart_movie(imdb, radarr, 1)])
    ch = api.app_module.charts
    await ch.warm(pause=0)
    clock.t += charts_mod.LIST_TTL - 100
    real, failed = imdb._handle, []

    def once(request):
        v = json.loads(request.content).get("variables") or {}
        if v.get("chart") == "TOP_RATED_MOVIES" and not failed:
            failed.append(v)
            imdb.requests.append((v, request.headers))
            return httpx.Response(500, text="error")
        return real(request)

    imdb.route.side_effect = once
    await ch.warm(margin=200, pause=0)
    assert failed
    tops = [v for v, _ in imdb.requests if v.get("chart") == "TOP_RATED_MOVIES"]
    assert len(tops) == 3  # first warm, the failed index refresh, the per-category retry
    assert len(imdb.requests) == 2 * PAIRS + 1
    assert msgs(caplog) == ["charts top-movie/movie refresh failed, serving stale: imdb HTTP 500"]


async def test_warm_resolves_two_at_a_time(api, imdb, radarr, sonarr, clock, monkeypatch):
    clock.install(monkeypatch, charts_mod)
    imdb.set_chart("TOP_RATED_MOVIES", [chart_movie(imdb, radarr, n) for n in range(1, 6)])
    gate = radarr.gate("/api/v3/movie/lookup")
    task = asyncio.create_task(api.app_module.charts.warm(pause=0))
    for _ in range(2000):
        if radarr.count("/api/v3/movie/lookup") >= 2:
            break
        await asyncio.sleep(0)
    await spin()
    assert radarr.count("/api/v3/movie/lookup") == 2
    gate.set()
    await task
    assert radarr.count("/api/v3/movie/lookup") == 5


async def test_warm_and_lookup_log_lines(api, imdb, radarr, sonarr, clock, monkeypatch, caplog):
    clock.install(monkeypatch, charts_mod)
    a = chart_movie(imdb, radarr, 1)
    imdb.set_chart("TOP_RATED_MOVIES", [a])
    radarr.set_lookup("imdb:" + a, httpx.Response(500))
    ch = api.app_module.charts
    await ch.get("top-movie")
    assert msgs(caplog) == [f"charts: movie lookup {a} failed: movie HTTP 500"]
    caplog.clear()
    ch._lists.clear()
    imdb.fail(status=500, times=10 * PAIRS)
    await ch.warm(pause=0)
    got = msgs(caplog)
    assert "charts: warm-up of the index failed: no chart could be fetched" in got
    assert "charts: warm-up of top-movie/movie failed: imdb HTTP 500" in got
    assert "charts: warm-up of genre-Western/tv failed: imdb HTTP 500" in got
    assert all("None" not in m and "%s" not in m for m in got)
