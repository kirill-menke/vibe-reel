"""Self-tests of ArrSim (tests/support/arr.py), driven through reel-api's own
ArrClient so the fake and the client agree on every route family."""

from datetime import datetime, timedelta, timezone

import httpx
import pytest

from reel_api.arr import AlreadyAdded, ArrClient, ArrError, NoSuchTitle
from tests.conftest import RADARR, RADARR_KEY, SONARR, SONARR_KEY
from tests.support.arr import (
    episode_obj,
    movie_obj,
    season_obj,
    series_obj,
)
from tests.support.qbit import make_hash


@pytest.fixture
async def tv():
    c = ArrClient("tv", SONARR, SONARR_KEY, "HD-1080p")
    yield c
    await c._client.aclose()


@pytest.fixture
async def movie():
    c = ArrClient("movie", RADARR, RADARR_KEY, "hd-1080P")
    yield c
    await c._client.aclose()


def _ago(**kw) -> datetime:
    return datetime.now(timezone.utc) - timedelta(**kw)


def _show(sonarr, tvdb=81189, title="Breaking Bad", n_eps=3, aired=True):
    eps = [episode_obj(1, i, air=_ago(days=30 - i) if aired else None) for i in range(1, n_eps + 1)]
    return sonarr.add_series(series_obj(tvdb, title, seasons=[season_obj(0), season_obj(1)]), eps)


async def test_wrong_api_key_is_401(sonarr):
    bad = ArrClient("tv", SONARR, "nope", "HD-1080p")
    try:
        with pytest.raises(ArrError, match="HTTP 401"):
            await bad._get("/api/v3/series")
    finally:
        await bad._client.aclose()
    assert sonarr.calls[-1].method == "GET" and sonarr.calls[-1].path == "/api/v3/series"


async def test_lookup_by_term_and_id_prefixes(sonarr, radarr, tv, movie):
    sonarr.add_catalog(series_obj(1, "The Mandalorian", imdb="tt8111088"))
    sonarr.add_catalog(series_obj(2, "Mandala"))
    _show(sonarr, tvdb=3, title="Better Call Saul")
    radarr.add_catalog(movie_obj(438631, "Dune", imdb="tt1160419"))

    assert [r["title"] for r in await tv._lookup("the mandalorian")] == ["The Mandalorian"]
    assert await tv._lookup("the mandal") == []  # whole words only, like the arrs
    hit = (await tv._lookup("tvdb:3"))[0]
    assert hit["added"] is True and hit["id"] == "3"
    assert (await tv._lookup("tvdb:1"))[0]["added"] is False
    assert (await tv.by_imdb("tt8111088"))["title"] == "The Mandalorian"
    m = await movie.by_imdb("tt1160419")
    assert m["id"] == "438631" and m["digital_release"] == "2021-05-01"
    assert [r["id"] for r in await movie._lookup("tmdb:438631")] == ["438631"]
    sonarr.set_lookup("pinned", [series_obj(9, "Pinned")])
    assert [r["title"] for r in await tv._lookup("pinned")] == ["Pinned"]
    assert sonarr.count("/api/v3/series/lookup") == 6


async def test_add_series_creates_library_entry_episodes_and_commands(sonarr, tv):
    sonarr.add_catalog(series_obj(81189, "Breaking Bad"), episodes=[episode_obj(1, 1), episode_obj(1, 2)])
    res = await tv.add("81189")
    assert res["status"] == "added" and res["_arr_id"]
    entry = sonarr.titles[res["_arr_id"]]
    assert entry["qualityProfileId"] == 4  # "HD-1080p" by name
    assert entry["rootFolderPath"] == "/tank/media/tv" and entry["path"] == "/tank/media/tv/Breaking Bad"
    assert entry["added"]
    eps = sonarr.episodes_of(entry["id"])
    assert [(e["seasonNumber"], e["episodeNumber"], e["monitored"]) for e in eps] == [(1, 1, True), (1, 2, True)]
    names = [(c["name"], c["status"]) for c in sonarr.commands.values()]
    assert names == [("RefreshSeries", "queued"), ("SeriesSearch", "queued")]
    # a second add: the lookup now carries the arr id
    with pytest.raises(AlreadyAdded):
        await tv.add("81189")
    # quality profile and root folder were fetched once
    assert sonarr.count("/api/v3/qualityprofile") == 1 and sonarr.count("/api/v3/rootfolder") == 1


async def test_add_existing_title_directly_is_400_with_exists_validator(sonarr, radarr, tv, movie):
    obj = _show(sonarr)
    r = await tv._client.post(SONARR + "/api/v3/series", json={**obj, "id": None, "qualityProfileId": 1,
                                                                  "rootFolderPath": "/x"})
    assert r.status_code == 400 and "exist" in r.text.lower()
    radarr.add_movie(movie_obj(5, "Alien"))
    r = await movie._client.post(RADARR + "/api/v3/movie", json={"tmdbId": 5, "title": "Alien", "qualityProfileId": 99})
    assert r.status_code == 400
    codes = {e["errorCode"] for e in r.json()}
    assert codes == {"MovieExistsValidator", "QualityProfileExistsValidator", "NotEmptyValidator"}


async def test_movie_add_and_unknown_id(radarr, movie):
    radarr.add_catalog(movie_obj(438631, "Dune"))
    res = await movie.add("438631")
    entry = radarr.titles[res["_arr_id"]]
    assert entry["qualityProfileId"] == 4  # case-insensitive name match
    assert entry["minimumAvailability"] == "released" and "addOptions" not in entry
    assert radarr.called("/api/v3/movie", "POST")[0].body["addOptions"] == {"searchForMovie": True}
    assert [c["name"] for c in radarr.commands.values()] == ["RefreshMovie", "MoviesSearch"]
    with pytest.raises(NoSuchTitle):
        await movie.add("1")
    assert await movie.library_ids() == {"438631"}


async def test_series_list_filter_title_by_id_put_and_delete(sonarr, tv):
    a = _show(sonarr, tvdb=10, title="A")
    _show(sonarr, tvdb=11, title="B")
    r = await tv._get("/api/v3/series", {"tvdbId": "11"})
    assert [s["title"] for s in r] == ["B"]
    assert await tv.library_ids() == {"10", "11"}
    await tv.set_title_monitored(a["id"], False)
    assert sonarr.titles[a["id"]]["monitored"] is False
    assert sonarr.count("/api/v3/series/{id}", "PUT") == 1
    await tv.set_title_monitored(a["id"], False)  # no change -> no PUT
    assert sonarr.count("/api/v3/series/{id}", "PUT") == 1
    await tv.delete_title(a["id"])
    assert sonarr.deleted == [{"id": a["id"], "params": {"deleteFiles": "false", "addImportListExclusion": "false"}}]
    assert await tv.title_by_id(a["id"]) is None
    assert a["id"] not in {e["seriesId"] for e in sonarr.episodes.values()}


async def test_queue_paging_and_embeds(sonarr, tv):
    s = _show(sonarr, n_eps=3)
    ep_ids = [e["id"] for e in sonarr.episodes_of(s["id"])]
    for i in range(150):
        sonarr.grab(s["id"], make_hash(f"q{i}"), episode_ids=ep_ids, history=False)
    assert len(sonarr.queue) == 450
    recs = await tv.queue_records()
    assert len(recs) == 450 and len({r["id"] for r in recs}) == 450
    pages = [c.params["page"] for c in sonarr.called("/api/v3/queue")]
    assert pages == ["1", "2", "3"]
    assert recs[0]["series"]["tvdbId"] == s["tvdbId"] and recs[0]["episode"]["episodeNumber"] == 1
    raw = (await tv._client.get(SONARR + "/api/v3/queue")).json()
    assert raw["pageSize"] == 10 and raw["totalRecords"] == 450 and "series" not in raw["records"][0]


async def test_queue_delete_removes_whole_torrent_from_client(sonarr, tv):
    s = _show(sonarr, n_eps=3)
    ep_ids = [e["id"] for e in sonarr.episodes_of(s["id"])]
    pack = sonarr.grab(s["id"], make_hash("pack"), episode_ids=ep_ids)
    other = sonarr.grab(s["id"], make_hash("single"), episode_ids=ep_ids[:1])
    removed = await tv.remove_downloads(pack, blocklist=True)
    assert removed == {make_hash("pack").upper()}
    assert [r["id"] for r in sonarr.queue] == [other[0]["id"]]
    assert sonarr.queue_deleted == [{"id": pack[0]["id"], "params": {
        "removeFromClient": "true", "blocklist": "true", "skipRedownload": "true"}}]
    # a row deleted without removeFromClient only takes itself; unknown row -> 404 (counted as done)
    r = await tv._client.delete(f"{SONARR}/api/v3/queue/{other[0]['id']}")
    assert r.status_code == 200 and sonarr.queue == []
    assert await tv._delete("/api/v3/queue/1") == 404


async def test_history_since_filters_by_date_and_event(sonarr, radarr, tv, movie):
    s = _show(sonarr, n_eps=2)
    e1, e2 = (e["id"] for e in sonarr.episodes_of(s["id"]))
    sonarr.grab(s["id"], make_hash("old"), episode_ids=[e1], date=_ago(hours=5))
    sonarr.grab(s["id"], make_hash("new"), episode_ids=[e2], date=_ago(minutes=5))
    sonarr.add_history("downloadFolderImported", date=_ago(minutes=1), series_id=s["id"], episode_id=e2,
                       download_id=make_hash("new"))
    got = await tv.grabs_since(_ago(hours=1), s["id"])
    assert got == {make_hash("new").upper()}
    assert await tv.grabs_since(_ago(hours=6), s["id"], {e1}) == {make_hash("old").upper()}
    assert await tv.grabs_since(_ago(hours=6), s["id"] + 1) == set()
    evs = await tv._get("/api/v3/history/since", {"date": "2000-01-01T00:00:00Z",
                                                  "includeSeries": "true", "includeEpisode": "true"})
    assert [e["eventType"] for e in evs] == ["grabbed", "grabbed", "downloadFolderImported"]
    assert evs[-1]["series"]["id"] == s["id"] and evs[-1]["episode"]["id"] == e2
    with pytest.raises(ArrError, match="HTTP 400"):
        await tv._get("/api/v3/history/since")
    m = radarr.add_movie(movie_obj(7, "Heat"))
    radarr.grab(m["id"], make_hash("heat"))
    assert await movie.grabs_since(_ago(hours=1), m["id"]) == {make_hash("heat").upper()}


async def test_episode_list_images_and_monitor(sonarr, tv):
    s = _show(sonarr, n_eps=3)
    eps = await tv._get("/api/v3/episode", {"seriesId": s["id"], "seasonNumber": 1})
    assert len(eps) == 3 and "images" not in eps[0] and not any(k.startswith("_") for k in eps[0])
    eps = await tv._get("/api/v3/episode", {"seriesId": s["id"], "includeImages": "true"})
    assert eps[0]["images"][0]["coverType"] == "screenshot"
    assert eps[0]["images"][0]["remoteUrl"].startswith("https://")
    ids = [e["id"] for e in eps]
    await tv.set_episodes_monitored(ids[:2], False)
    assert [sonarr.episodes[i]["monitored"] for i in ids] == [False, False, True]
    assert sonarr.called("/api/v3/episode/monitor")[0].body == {"episodeIds": sorted(ids[:2]), "monitored": False}
    with pytest.raises(ArrError, match="HTTP 404"):
        await tv._get("/api/v3/episode", {"seriesId": 999})


async def test_search_season_flips_monitoring_and_queues_season_search(sonarr, tv):
    s = sonarr.add_series(series_obj(5, "Silo", monitored=False,
                                     seasons=[season_obj(1, monitored=False), season_obj(2, monitored=False)]),
                          [episode_obj(1, 1, air=_ago(days=400), has_file=True),
                           episode_obj(2, 1, air=_ago(days=3), monitored=False),
                           episode_obj(2, 2, air=_ago(days=-4), monitored=False)])
    res = await tv.search_season("5", 2)
    lib = sonarr.titles[s["id"]]
    assert lib["monitored"] is True
    assert {se["seasonNumber"]: se["monitored"] for se in lib["seasons"]} == {1: False, 2: True}
    aired, future = sonarr.episode(s["id"], 2, 1), sonarr.episode(s["id"], 2, 2)
    assert aired["monitored"] is True and future["monitored"] is False
    cmd = sonarr.commands[res["_undo"]["command_id"]]
    assert cmd["name"] == "SeasonSearch" and cmd["body"]["seasonNumber"] == 2 and cmd["status"] == "queued"
    # derived statistics: season 2 has aired episodes and no file
    got = (await tv._get(f"/api/v3/series/{s['id']}"))["seasons"]
    st = {se["seasonNumber"]: se["statistics"] for se in got}
    assert st[1]["episodeFileCount"] == 1 and st[2]["episodeFileCount"] == 0
    assert st[2]["previousAiring"] and st[2]["nextAiring"] and st[2]["totalEpisodeCount"] == 2


async def test_commands_list_cancel_and_active(sonarr, radarr, tv, movie):
    q = sonarr.add_command("SeriesSearch", {"seriesId": 42})
    st = sonarr.add_command("RefreshSeries", {"seriesIds": [42]}, status="started")
    sonarr.add_command("SeriesSearch", {"seriesId": 43})
    assert {c["id"] for c in await tv.active_commands(42)} == {q["id"], st["id"]}
    await tv.cancel_command(q["id"])
    assert sonarr.commands[q["id"]]["status"] == "cancelled"
    await tv.cancel_command(st["id"])  # a started command can't be cancelled: logged, no error
    assert sonarr.commands[st["id"]]["status"] == "started"
    assert [c["id"] for c in await tv.active_commands(42)] == [st["id"]]
    sonarr.finish_commands()
    assert await tv.active_commands(42) == []
    one = await tv._get(f"/api/v3/command/{q['id']}")
    assert one["status"] == "cancelled"
    m = radarr.add_movie(movie_obj(8, "Tenet"))
    await movie.search_title(m["id"])
    assert [c["body"]["movieIds"] for c in radarr.active_commands()] == [[m["id"]]]


async def test_movie_editor_monitor_and_delete(radarr, movie):
    m = radarr.add_movie(movie_obj(9, "Arrival"))
    await movie.set_title_monitored(m["id"], False)
    assert radarr.titles[m["id"]]["monitored"] is False
    assert radarr.called("/api/v3/movie/editor")[0].body == {"movieIds": [m["id"]], "monitored": False}
    obj = await movie.title_by_id(m["id"])
    assert movie.has_files(obj) is False
    radarr.grab(m["id"], make_hash("arr"))
    radarr.import_grab(make_hash("arr"))
    assert movie.has_files(await movie.title_by_id(m["id"])) is True and radarr.queue == []
    await movie.delete_title(m["id"])
    assert radarr.deleted[0]["params"] == {"deleteFiles": "false", "addImportExclusion": "false"}


async def test_fail_is_one_shot_and_matches_path_or_template(sonarr, tv):
    s = _show(sonarr)
    sonarr.fail("/api/v3/series", status=503)
    with pytest.raises(ArrError, match="HTTP 503"):
        await tv.library_ids()
    assert await tv.library_ids() == {str(s["tvdbId"])}
    sonarr.fail("/api/v3/series/{id}", exc=httpx.ConnectError("down"))
    with pytest.raises(ArrError, match="unreachable"):
        await tv.title_by_id(s["id"])
    assert (await tv.title_by_id(s["id"]))["id"] == s["id"]
    sonarr.fail("/api/v3/queue", status=500, times=2)
    for _ in range(2):
        with pytest.raises(ArrError):
            await tv.queue_records()
    assert await tv.queue_records() == []


async def test_gate_holds_calls_until_released(sonarr, tv):
    import asyncio

    sonarr.add_catalog(series_obj(1, "Dark"))
    gate = sonarr.gate("/api/v3/series/lookup")
    task = asyncio.create_task(tv._lookup("dark"))
    for _ in range(20):
        await asyncio.sleep(0)
    assert not task.done() and sonarr.count("/api/v3/series/lookup") == 1
    gate.set()
    assert [r["title"] for r in await task] == ["Dark"]


async def test_unknown_route_fails_loudly(sonarr, tv):
    with pytest.raises(AssertionError, match="no route for GET /api/v3/system/status"):
        await tv._get("/api/v3/system/status")
    with pytest.raises(AssertionError, match="no route for PUT /api/v3/movie/editor"):
        await tv._send("PUT", "/api/v3/movie/editor", {})
