"""POST /api/library: add a title to Sonarr/Radarr (arr.add), the 409/404/503
answers, and how an add patches cached lookups and chart/collection caches."""

import asyncio

import httpx
import pytest

from tests.support.arr import movie_obj, series_obj
from tests.support.clock import FakeClock

LOOKUP = "/api/v3/series/lookup"


async def _add(api, id, type="tv"):
    return await api.post("/api/library", json={"id": id, "type": type})


async def _lookup(api, q, type="tv"):
    r = await api.get("/api/lookup", params={"q": q, "type": type})
    assert r.status_code == 200, r.text
    return {x["id"]: x["added"] for x in r.json()["results"]}


async def test_add_tv_returns_202_with_undo_token(api, sonarr):
    sonarr.add_catalog(series_obj(81189, "Breaking Bad"))
    r = await _add(api, "81189")
    assert r.status_code == 202
    body = r.json()
    undo = body.pop("undo")
    assert body == {"id": "81189", "type": "tv", "title": "Breaking Bad", "status": "added"}
    assert isinstance(undo, str) and 8 <= len(undo) <= 64
    assert sonarr.title(81189) is not None


async def test_tv_add_request_body(make_api, sonarr):
    sonarr.add_catalog(series_obj(81189, "Breaking Bad"))
    async with make_api(SONARR_QUALITY_PROFILE="ultra-HD") as api:
        assert (await _add(api, "81189")).status_code == 202
    (lookup,) = sonarr.called(LOOKUP)
    assert lookup.params == {"term": "tvdb:81189"}
    body = sonarr.called("/api/v3/series", "POST")[0].body
    assert body["tvdbId"] == 81189 and body["title"] == "Breaking Bad"
    assert body["qualityProfileId"] == 6  # "Ultra-HD", matched case-insensitively
    assert body["rootFolderPath"] == "/tank/media/tv"
    assert body["monitored"] is True
    assert body["addOptions"] == {"monitor": "all", "searchForMissingEpisodes": True}
    assert body["seasonFolder"] is True and body["seriesType"] == "standard"
    assert "minimumAvailability" not in body


async def test_movie_add_request_body_default_profile(api, radarr):
    radarr.add_catalog(movie_obj(438631, "Dune"))
    r = await _add(api, "438631", "movie")
    assert r.status_code == 202 and r.json()["type"] == "movie"
    assert radarr.called("/api/v3/movie/lookup")[0].params == {"term": "tmdb:438631"}
    body = radarr.called("/api/v3/movie", "POST")[0].body
    assert body["tmdbId"] == 438631
    assert body["qualityProfileId"] == 4  # default RADARR_QUALITY_PROFILE "HD-1080p"
    assert body["rootFolderPath"] == "/tank/media/movies" and body["monitored"] is True
    assert body["addOptions"] == {"searchForMovie": True}
    assert body["minimumAvailability"] == "released"
    assert "seasonFolder" not in body and "seriesType" not in body


async def test_unknown_profile_name_falls_back_to_first_profile(make_api, radarr):
    radarr.quality_profiles = [{"id": 11, "name": "Remux"}, {"id": 12, "name": "Any"}]
    radarr.add_catalog(movie_obj(1, "Alien"))
    async with make_api(RADARR_QUALITY_PROFILE="nope") as api:
        assert (await _add(api, "1", "movie")).status_code == 202
    assert radarr.called("/api/v3/movie", "POST")[0].body["qualityProfileId"] == 11


async def test_profile_and_root_folder_fetched_once_per_client(api, sonarr, radarr):
    for i in (1, 2, 3):
        sonarr.add_catalog(series_obj(i, f"Show {i}"))
        assert (await _add(api, str(i))).status_code == 202
    radarr.add_catalog(movie_obj(9, "Heat"))
    assert (await _add(api, "9", "movie")).status_code == 202
    assert sonarr.count("/api/v3/qualityprofile") == 1 and sonarr.count("/api/v3/rootfolder") == 1
    assert radarr.count("/api/v3/qualityprofile") == 1 and radarr.count("/api/v3/rootfolder") == 1


async def test_already_in_library_is_409_and_marks_cached_lookups(api, sonarr):
    sonarr.add_catalog(series_obj(7, "Dark"))
    assert await _lookup(api, "dark") == {"7": False}
    sonarr.add_series(series_obj(7, "Dark"))  # added elsewhere (the arr's own UI)
    r = await _add(api, "7")
    assert r.status_code == 409
    assert r.json() == {"error": "already_added", "detail": "already in the library: Dark"}
    assert sonarr.count("/api/v3/series", "POST") == 0
    n = sonarr.count(LOOKUP)
    assert await _lookup(api, "dark") == {"7": True}  # from the cache, patched
    assert sonarr.count(LOOKUP) == n


async def test_add_race_400_exists_is_409(api, radarr):
    radarr.add_catalog(movie_obj(5, "Alien"))
    radarr.fail("/api/v3/movie", status=400,
                body='[{"propertyName":"TmdbId","errorMessage":"This movie has already been added",'
                     '"errorCode":"MovieExistsValidator"}]')
    r = await _add(api, "5", "movie")
    assert r.status_code == 409 and r.json()["detail"] == "already in the library: Alien"


async def test_other_add_failure_is_503(api, radarr):
    radarr.add_catalog(movie_obj(5, "Alien"))
    radarr.fail("/api/v3/movie", status=400, body='[{"errorMessage":"Root folder is not writable"}]')
    r = await _add(api, "5", "movie")
    assert r.status_code == 503 and r.headers["Retry-After"] == "30"
    assert r.json()["error"] == "temporarily_unavailable"


async def test_unknown_id_is_404_and_nothing_is_posted(api, sonarr):
    r = await _add(api, "424242")
    assert r.status_code == 404
    assert r.json() == {"error": "not_found", "detail": "no such title"}
    assert sonarr.count("/api/v3/series", "POST") == 0


@pytest.mark.parametrize("path, fault", [
    ("/api/v3/series/lookup", {"exc": httpx.ConnectError("refused")}),
    ("/api/v3/qualityprofile", {"status": 500}),
    ("/api/v3/series", {"exc": httpx.ReadTimeout("slow")}),
])
async def test_arr_down_is_503_retry_after_30(api, sonarr, path, fault):
    sonarr.add_catalog(series_obj(1, "Dark"))
    sonarr.fail(path, **fault)
    r = await _add(api, "1")
    assert r.status_code == 503 and r.headers["Retry-After"] == "30"
    assert r.json() == {"error": "temporarily_unavailable",
                        "detail": "library service temporarily unavailable, retry later"}


async def test_no_root_folder_is_503(api, sonarr):
    sonarr.root_folders = []
    sonarr.add_catalog(series_obj(1, "Dark"))
    assert (await _add(api, "1")).status_code == 503
    assert sonarr.count("/api/v3/series", "POST") == 0


async def test_bad_type_is_400_and_unconfigured_type_503(make_api, sonarr):
    async with make_api(SONARR_API_KEY=None) as api:
        r = await _add(api, "1", "music")
        assert r.status_code == 400
        assert r.json() == {"error": "bad_type", "detail": "type must be tv or movie"}
        r = await _add(api, "1", "tv")
        assert r.status_code == 503 and r.json()["error"] == "not_available"
    assert sonarr.calls == []


@pytest.mark.parametrize("payload", [{"id": "1"}, {"type": "tv"}, {}])
async def test_missing_fields_are_422(api, payload):
    assert (await api.post("/api/library", json=payload)).status_code == 422


@pytest.mark.parametrize("media_id", ["0603", "00", "0", "603 ", " 603", "+603", "6e2", "６０３", "abc", "",
                                      "12345678901", "-1", "603\n"])
async def test_an_id_that_is_not_canonical_is_422_and_touches_nothing(api, radarr, reel_env, media_id):
    """The arrs parse the lookup term with int.TryParse, so "0603" would add
    tmdb 603 under a record keyed "0603" that no listing ever matches: pruned,
    slot free, title kept (reviewer: a way past the quota)."""
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    r = await _add(api, media_id, "movie")
    assert r.status_code == 422
    assert radarr.calls == [] and not (reel_env.state / "owners.json").exists()


async def test_arr_without_id_in_reply_gives_no_undo(api, radarr):
    radarr.add_catalog(movie_obj(5, "Alien"))
    radarr.fail("/api/v3/movie", status=201, body="")
    r = await _add(api, "5", "movie")
    assert r.status_code == 202 and r.json()["undo"] is None and r.json()["status"] == "added"


async def test_lookup_cached_before_the_add_answers_added(api, sonarr, radarr):
    sonarr.add_catalog(series_obj(1, "Dark"))
    sonarr.add_catalog(series_obj(2, "Dark Matter"))
    assert await _lookup(api, "dark") == {"1": False, "2": False}
    assert (await _add(api, "1")).status_code == 202
    n = sonarr.count(LOOKUP)
    assert await _lookup(api, "dark") == {"1": True, "2": False}
    assert sonarr.count(LOOKUP) == n  # cached, not refetched
    assert await _lookup(api, "dark", "movie") == {}  # other type untouched


async def test_lookup_in_flight_during_the_add_answers_added(api, sonarr):
    sonarr.add_catalog(series_obj(1, "Dark"))
    # the in-flight answer was computed before the add: it says "not added"
    sonarr.set_lookup("dark", [series_obj(1, "Dark")])
    gate = sonarr.gate(LOOKUP, match=lambda c: c.params.get("term") == "dark")
    pending = asyncio.create_task(api.get("/api/lookup", params={"q": "dark"}))
    for _ in range(50):
        await asyncio.sleep(0)
    assert not pending.done()
    assert (await _add(api, "1")).status_code == 202
    gate.set()
    r = await pending
    assert [(x["id"], x["added"]) for x in r.json()["results"]] == [("1", True)]


async def test_recent_add_memory_expires_after_two_ttls(api, sonarr, monkeypatch):
    mod = api.app_module
    clock = FakeClock().install(monkeypatch, mod)
    sonarr.add_catalog(series_obj(1, "Dark"))
    sonarr.set_lookup("dark", [series_obj(1, "Dark")])  # a stale arr answer
    assert (await _add(api, "1")).status_code == 202
    clock.t += 100  # past the lookup TTL, inside 2 x TTL: still patched
    assert await _lookup(api, "dark") == {"1": True}
    clock.t += 2 * mod.LOOKUP_TTL
    assert await _lookup(api, "dark") == {"1": False}
    assert ("tv", "1") not in mod._recent_adds


async def test_add_drops_chart_and_collection_library_caches(api, radarr, sonarr):
    mod = api.app_module
    mod.charts._library["movie"] = (0.0, set())
    mod.charts._library["tv"] = (0.0, set())
    mod.collections._library = (0.0, set())
    sonarr.add_catalog(series_obj(1, "Dark"))
    assert (await _add(api, "1")).status_code == 202
    assert "tv" not in mod.charts._library and "movie" in mod.charts._library
    assert mod.collections._library is not None  # a show doesn't touch collections
    radarr.add_catalog(movie_obj(5, "Alien"))
    assert (await _add(api, "5", "movie")).status_code == 202
    assert "movie" not in mod.charts._library and mod.collections._library is None


async def test_409_also_drops_chart_cache(api, radarr):
    mod = api.app_module
    mod.charts._library["movie"] = (0.0, set())
    mod.collections._library = (0.0, set())
    radarr.add_movie(movie_obj(5, "Alien"))
    radarr.add_catalog(movie_obj(5, "Alien"))
    assert (await _add(api, "5", "movie")).status_code == 409
    assert "movie" not in mod.charts._library and mod.collections._library is None
