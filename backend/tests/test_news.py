"""GET /api/news: the new-season feed built from Sonarr's per-season
statistics (arr.season_news / _news_item), sorted and cached by app.py
(NEWS_TTL), invalidated by a season search and its undo. Dates are frozen
with time_machine (the sim derives season statistics from datetime.now())."""

from datetime import datetime, timedelta, timezone

import pytest

from reel_api import arr as arr_mod
from reel_api.models import NewsResponse
from tests.support.arr import episode_obj, images, iso, season_obj, series_obj
from tests.support.clock import FakeClock

NOW = datetime(2026, 6, 15, 12, 0, tzinfo=timezone.utc)
SERIES = "/api/v3/series"
EPISODE = "/api/v3/episode"


@pytest.fixture(autouse=True)
def frozen(time_machine):
    time_machine.move_to(NOW, tick=False)


def ago(**kw):
    return NOW - timedelta(**kw)


def ahead(**kw):
    return NOW + timedelta(**kw)


def add_show(sonarr, tvdb, title, season_eps, *, monitored=True, seasons_monitored=None, **kw):
    """season_eps: {season: [air datetime | None, ...]} (has_file via a
    (datetime, True) tuple)."""
    seasons_monitored = seasons_monitored or {}
    seasons = [season_obj(n, monitored=seasons_monitored.get(n, True)) for n in season_eps]
    eps = []
    for n, airs in season_eps.items():
        for i, a in enumerate(airs, 1):
            has = False
            if isinstance(a, tuple):
                a, has = a
            eps.append(episode_obj(n, i, air=a, has_file=has))
    return sonarr.add_series(series_obj(tvdb, title, seasons=seasons, monitored=monitored, **kw), eps)


async def news(api):
    r = await api.get("/api/news")
    assert r.status_code == 200, r.text
    NewsResponse.model_validate(r.json())
    return r.json()["items"]


# ---------------------------------------------------------------- kinds


async def test_aired_item_shape(api, sonarr):
    add_show(sonarr, 81189, "Breaking Bad", {
        1: [(ago(days=800), True), (ago(days=793), True)],
        2: [ago(days=10), ago(days=3), ahead(days=4)],
    }, year=2008)
    (item,) = await news(api)
    assert item == {
        "id": "81189:2:aired", "kind": "aired", "media_id": "81189", "title": "Breaking Bad",
        "year": 2008,
        "poster": "https://artworks.thetvdb.com/banners/posters/81189.jpg",
        "fanart": "https://artworks.thetvdb.com/banners/fanarts/81189.jpg",
        "season": 2, "premiere": iso(ago(days=10)), "last_aired": iso(ago(days=3)),
        "episodes_aired": 2, "episodes_total": 3, "monitored": True,
    }


async def test_upcoming_item_with_and_without_premiere(api, sonarr):
    add_show(sonarr, 1, "Dated", {1: [(ago(days=900), True)], 2: [ahead(days=30), ahead(days=37)]})
    # a season on TheTVDB with episode entries but no air dates yet
    add_show(sonarr, 2, "Undated", {1: [(ago(days=900), True)], 2: [None, None, None]})
    items = {i["id"]: i for i in await news(api)}
    assert set(items) == {"1:2:upcoming", "2:2:upcoming"}
    dated, undated = items["1:2:upcoming"], items["2:2:upcoming"]
    assert dated["kind"] == "upcoming" and dated["premiere"] == iso(ahead(days=30))
    assert dated["last_aired"] is None and dated["episodes_aired"] == 0
    assert dated["episodes_total"] == 2
    assert undated["premiere"] is None and undated["episodes_total"] == 3


async def test_upcoming_needs_a_date_or_an_episode_entry(api, sonarr):
    """No airing and no episodes listed: nothing on TheTVDB yet — not news."""
    sonarr.add_series(series_obj(5, "Bare", seasons=[season_obj(1, total=0), season_obj(2, total=10)]))
    items = await news(api)
    assert [i["id"] for i in items] == ["5:2:upcoming"]
    assert sonarr.count(EPISODE) == 0  # only aired candidates cost an /episode call


async def test_excluded_seasons(api, sonarr):
    # any file in the season: it is in the library already
    add_show(sonarr, 1, "Partial", {1: [(ago(days=20), True), ago(days=13)]})
    # aired longer ago than NEWS_AIRED_DAYS: back catalogue, not news
    add_show(sonarr, 2, "Old", {1: [ago(days=400), ago(days=393)]})
    # specials never count, aired or upcoming
    add_show(sonarr, 3, "Specials", {0: [ago(days=2)], 1: [(ago(days=900), True)]})
    sonarr.add_series(series_obj(4, "Upcoming special", seasons=[season_obj(0, total=3, next_airing=ahead(days=3))]))
    # no tvdb id: skipped
    sonarr.add_series(series_obj(0, "No id", seasons=[season_obj(1, total=3, next_airing=ahead(days=3))]))
    assert await news(api) == []


async def test_aired_window_boundary(api, sonarr):
    days = arr_mod.NEWS_AIRED_DAYS
    add_show(sonarr, 1, "Edge", {1: [ago(days=days)]})
    add_show(sonarr, 2, "Past edge", {1: [ago(days=days, seconds=1)]})
    assert [i["id"] for i in await news(api)] == ["1:1:aired"]


async def test_unmonitored_still_listed_with_monitored_false(api, sonarr):
    add_show(sonarr, 1, "Series off", {1: [ago(days=2)]}, monitored=False)
    add_show(sonarr, 2, "Season off", {1: [ago(days=2)]}, seasons_monitored={1: False})
    add_show(sonarr, 3, "Upcoming off", {1: [ahead(days=2)]}, seasons_monitored={1: False})
    add_show(sonarr, 4, "All on", {1: [ago(days=2)]})
    items = {i["id"]: i["monitored"] for i in await news(api)}
    assert items == {"1:1:aired": False, "2:1:aired": False, "3:1:upcoming": False, "4:1:aired": True}


async def test_relative_only_images_give_null(api, sonarr):
    add_show(sonarr, 7, "No art", {1: [ago(days=1)]}, images=images("tv", 7, relative_only=True))
    (item,) = await news(api)
    assert item["poster"] is None and item["fanart"] is None


async def test_year_zero_is_null(api, sonarr):
    add_show(sonarr, 7, "Yearless", {1: [ago(days=1)]}, year=None)
    (item,) = await news(api)
    assert item["year"] is None


# ---------------------------------------------------------------- order


async def test_order_aired_newest_first_then_upcoming_soonest_undated_last(api, sonarr):
    add_show(sonarr, 1, "Aired long ago", {1: [ago(days=60)]})
    add_show(sonarr, 2, "Aired yesterday", {1: [ago(days=1)]})
    add_show(sonarr, 3, "Aired last week", {1: [ago(days=7)]})
    add_show(sonarr, 4, "Undated", {1: [None]})
    add_show(sonarr, 5, "Premieres later", {1: [ahead(days=90)]})
    add_show(sonarr, 6, "Premieres soon", {1: [ahead(days=2)]})
    sonarr.add_series(series_obj(8, "Undated too", seasons=[season_obj(1, total=4)]))
    # one series with an aired and an upcoming season
    add_show(sonarr, 7, "Both", {1: [ago(days=3)], 2: [ahead(days=10)]})
    ids = [i["id"] for i in await news(api)]
    assert ids[:4] == ["2:1:aired", "7:1:aired", "3:1:aired", "1:1:aired"]
    assert ids[4:7] == ["6:1:upcoming", "7:2:upcoming", "5:1:upcoming"]
    assert set(ids[7:]) == {"4:1:upcoming", "8:1:upcoming"}


async def test_kind_change_gives_a_new_id(api, sonarr, time_machine, monkeypatch):
    """The same season reads as fresh news when it goes upcoming -> aired."""
    clock = FakeClock().install(monkeypatch, api.app_module)
    add_show(sonarr, 1, "Premiere", {1: [ahead(days=1), ahead(days=8)]})
    assert [i["id"] for i in await news(api)] == ["1:1:upcoming"]
    time_machine.move_to(ahead(days=2), tick=False)
    clock.t += api.app_module.NEWS_TTL + 1
    (item,) = await news(api)
    assert item["id"] == "1:1:aired" and item["episodes_aired"] == 1


# ---------------------------------------------------------------- cache


async def test_cached_for_news_ttl(api, sonarr, monkeypatch):
    clock = FakeClock().install(monkeypatch, api.app_module)
    add_show(sonarr, 1, "A", {1: [ago(days=1)]})
    first = await news(api)
    add_show(sonarr, 2, "B", {1: [ago(days=1)]})
    clock.t += api.app_module.NEWS_TTL - 1
    assert await news(api) == first
    assert sonarr.count(SERIES, "GET") == 1
    clock.t += 2
    assert len(await news(api)) == 2
    assert sonarr.count(SERIES, "GET") == 2


async def test_season_search_and_its_undo_invalidate_the_cache(api, sonarr):
    add_show(sonarr, 1, "A", {1: [ago(days=1)]}, seasons_monitored={1: False})
    assert [i["monitored"] for i in await news(api)] == [False]
    r = await api.post("/api/news/search", json={"id": "1", "season": 1})
    assert r.status_code == 202, r.text
    token = r.json()["undo"]
    assert [i["monitored"] for i in await news(api)] == [True]
    assert [i["monitored"] for i in await news(api)] == [True]  # cached again
    n = sonarr.count(SERIES, "GET")
    r = await api.delete(f"/api/news/search/{token}")
    assert r.status_code == 200, r.text
    assert [i["monitored"] for i in await news(api)] == [False]
    assert sonarr.count(SERIES, "GET") == n + 1


async def test_failed_fetch_is_not_cached(api, sonarr):
    add_show(sonarr, 1, "A", {1: [ago(days=1)]})
    sonarr.fail(SERIES, status=500)
    r = await api.get("/api/news")
    assert r.status_code == 503 and r.json()["error"] == "temporarily_unavailable"
    assert len(await news(api)) == 1


async def test_without_sonarr_is_503(make_api):
    async with make_api(SONARR_API_KEY=None) as api:
        r = await api.get("/api/news")
    assert r.status_code == 503
    assert r.json() == {"error": "not_available", "detail": "that media type is not available"}
