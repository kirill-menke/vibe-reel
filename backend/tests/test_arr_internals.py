"""arr.ArrClient details the endpoint tests reached only loosely — found by
the T40 mutation pass (tests/run_mutmut.sh arr): what counts as a file on
disk, the accepted status codes, the operator-facing error texts (they end up
in the server log as "library backend: ..."), configuration defaults, the
half-typed-word fallback for longer queries, rows/history entries without a
download id, and season_news edge cases. Upstreams are respx routes or the
ArrSim (tests/support/arr.py)."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from reel_api import arr as arr_mod
from reel_api.arr import ArrClient, ArrError
from tests.conftest import RADARR, RADARR_KEY, SONARR, SONARR_KEY
from tests.support.arr import movie_obj, queue_record, series_obj

NOW = datetime(2026, 6, 15, 12, 0, tzinfo=timezone.utc)


def Z(d: datetime) -> str:
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")


def tv(url=SONARR) -> ArrClient:
    return ArrClient("tv", url, SONARR_KEY, "x")


def movie(url=RADARR) -> ArrClient:
    return ArrClient("movie", url, RADARR_KEY, "x")


# ---------------------------------------------------------------- has_files: never delete a file


@pytest.mark.parametrize("obj", [
    {"statistics": {"episodeFileCount": 1}},
    {"statistics": {"sizeOnDisk": 1}},
], ids=["episodeFileCount", "sizeOnDisk"])
def test_any_tv_file_signal_counts(obj):
    assert tv().has_files(obj) is True
    assert tv().has_files({"statistics": {}}) is False


@pytest.mark.parametrize("obj", [
    {"hasFile": True},
    {"movieFileId": 7},
    {"sizeOnDisk": 1},
    {"statistics": {"movieFileCount": 1}},
    {"statistics": {"sizeOnDisk": 1}},
], ids=["hasFile", "movieFileId", "sizeOnDisk", "statistics.movieFileCount", "statistics.sizeOnDisk"])
def test_any_movie_file_signal_counts(obj):
    assert movie().has_files(obj) is True
    assert movie().has_files({"hasFile": False, "movieFileId": 0, "statistics": {}}) is False


def test_series_file_counts_are_read_as_series():
    """A series reports files only under statistics; the movie fields mean nothing on it."""
    assert tv().has_files({"statistics": {"episodeFileCount": 2, "movieFileCount": 0}}) is True


# ---------------------------------------------------------------- status codes


@pytest.mark.parametrize("status", [200, 202, 204, 404])
async def test_delete_accepts_2xx_and_gone(upstream, status):
    upstream.delete(f"{SONARR}/api/v3/queue/1").respond(status)
    assert await tv()._delete("/api/v3/queue/1") == status


@pytest.mark.parametrize("status", [201, 203, 205, 400, 500])
async def test_delete_refuses_other_statuses(upstream, status):
    upstream.delete(f"{SONARR}/api/v3/queue/1").respond(status, text="x" * 200)
    with pytest.raises(ArrError) as e:
        await tv()._delete("/api/v3/queue/1")
    assert str(e.value) == f"tv DELETE /api/v3/queue/1 HTTP {status}: " + "x" * 120


@pytest.mark.parametrize("status", [200, 201, 202])
async def test_send_accepts_200_201_202_and_an_empty_body(upstream, status):
    upstream.put(f"{SONARR}/api/v3/series/1").respond(status, json={"id": 1})
    assert await tv()._send("PUT", "/api/v3/series/1", {}) == {"id": 1}
    upstream.put(f"{SONARR}/api/v3/series/2").respond(status)
    assert await tv()._send("PUT", "/api/v3/series/2", {}) is None


async def test_send_error_texts(upstream):
    upstream.put(f"{SONARR}/api/v3/series/1").respond(500, text="y" * 200)
    with pytest.raises(ArrError) as e:
        await tv()._send("PUT", "/api/v3/series/1", {})
    assert str(e.value) == "tv PUT /api/v3/series/1 HTTP 500: " + "y" * 120
    upstream.put(f"{SONARR}/api/v3/series/2").mock(side_effect=httpx.ConnectError("refused"))
    with pytest.raises(ArrError) as e:
        await tv()._send("PUT", "/api/v3/series/2", {})
    assert str(e.value) == "tv PUT /api/v3/series/2 failed: refused"


async def test_get_delete_and_title_error_texts(upstream):
    upstream.get(f"{SONARR}/api/v3/series").mock(side_effect=httpx.ConnectError("refused"))
    with pytest.raises(ArrError) as e:
        await tv()._get("/api/v3/series")
    assert str(e.value) == "tv backend unreachable: refused"
    upstream.delete(f"{SONARR}/api/v3/queue/3").mock(side_effect=httpx.ConnectError("refused"))
    with pytest.raises(ArrError) as e:
        await tv()._delete("/api/v3/queue/3")
    assert str(e.value) == "tv DELETE /api/v3/queue/3 failed: refused"
    upstream.get(f"{RADARR}/api/v3/movie/9").respond(500)
    with pytest.raises(ArrError) as e:
        await movie().title_by_id(9)
    assert str(e.value) == "movie HTTP 500"
    upstream.get(f"{RADARR}/api/v3/rootfolder").respond(200, json=[])
    with pytest.raises(ArrError) as e:
        await movie()._root_folder()
    assert str(e.value) == "movie: no root folder configured"


@pytest.fixture
def add_route(upstream):
    """Radarr lookup + profiles + root folder for one movie; returns the POST route."""
    upstream.get(f"{RADARR}/api/v3/movie/lookup").respond(200, json=[{"tmdbId": 603, "title": "The Matrix"}])
    upstream.get(f"{RADARR}/api/v3/qualityprofile").respond(200, json=[{"id": 4, "name": "x"}])
    upstream.get(f"{RADARR}/api/v3/rootfolder").respond(200, json=[{"path": "/m"}])
    return upstream.post(f"{RADARR}/api/v3/movie")


async def test_add_accepts_200(add_route):
    add_route.respond(200, json={"id": 31})
    res = await movie().add("603")
    assert res["status"] == "added" and res["_arr_id"] == 31


async def test_add_without_an_id_in_the_answer_has_no_arr_id(add_route):
    add_route.respond(201, json={})
    assert (await movie().add("603"))["_arr_id"] is None


async def test_add_error_texts(add_route):
    add_route.respond(500, text="z" * 200)
    with pytest.raises(ArrError) as e:
        await movie().add("603")
    assert str(e.value) == "movie add HTTP 500: " + "z" * 120
    add_route.mock(side_effect=httpx.ConnectError("refused"))
    with pytest.raises(ArrError) as e:
        await movie().add("603")
    assert str(e.value) == "movie add failed: refused"


async def test_add_answers_an_empty_title_when_the_arr_has_none(upstream):
    upstream.get(f"{RADARR}/api/v3/movie/lookup").respond(200, json=[{"tmdbId": 603}])
    upstream.get(f"{RADARR}/api/v3/qualityprofile").respond(200, json=[{"id": 4, "name": "x"}])
    upstream.get(f"{RADARR}/api/v3/rootfolder").respond(200, json=[{"path": "/m"}])
    upstream.post(f"{RADARR}/api/v3/movie").respond(201, json={"id": 31})
    assert (await movie().add("603"))["title"] == ""


# ---------------------------------------------------------------- configuration


def test_client_defaults_from_the_environment(reel_env):
    reel_env(SONARR_API_KEY="k", SONARR_URL=None, SONARR_QUALITY_PROFILE=None,
             RADARR_API_KEY="k", RADARR_URL=None, RADARR_QUALITY_PROFILE=None)
    clients = arr_mod.make_arr_clients()
    assert clients["tv"].base_url == "http://127.0.0.1:8989"
    assert clients["movie"].base_url == "http://127.0.0.1:7878"
    assert clients["tv"].quality_profile == clients["movie"].quality_profile == "HD-1080p"
    assert clients["tv"]._client.timeout == httpx.Timeout(45)


async def test_trailing_slash_in_the_url_is_dropped(sonarr):
    sonarr.add_catalog(series_obj(81189, "Breaking Bad"))
    c = tv(SONARR + "/")
    assert c.base_url == SONARR
    assert [r["id"] for r in await c.lookup("breaking bad")] == ["81189"]


# ---------------------------------------------------------------- lookup fallback for 3+ words


async def test_fallback_drops_only_the_last_word_and_matches_its_first_three_letters(sonarr):
    sonarr.set_lookup("star trek picx", [])
    sonarr.set_lookup("star trek", [series_obj(1, "Star Trek: Picard"), series_obj(2, "Star Trek: Discovery")])
    res = await tv().lookup("star trek picx")
    assert [r["title"] for r in res] == ["Star Trek: Picard"]


# ---------------------------------------------------------------- queue rows


def test_tv_row_without_numbers_or_titles():
    rec = {"id": 4, "series": {}, "episode": {"seasonNumber": 2}}
    out = tv()._shape_queue(rec)
    assert out["subtitle"] == "" and out["title"] == ""


def test_movie_row_falls_back_to_the_release_title():
    out = movie()._shape_queue({"movie": {}, "title": "Some.Release.2160p"})
    assert out["title"] == "Some.Release.2160p"
    assert out["subtitle"] == "" and out["id"] == ""
    assert movie()._shape_queue({"movie": {}})["title"] == ""


async def test_command_body_with_a_single_movie_id_counts(upstream):
    upstream.get(f"{RADARR}/api/v3/command").respond(200, json=[
        {"id": 1, "status": "started", "body": {"movieId": 9}},
        {"id": 2, "status": "started", "body": {"movieId": 10}},
    ])
    assert [c["id"] for c in await movie().active_commands(9)] == [1]


async def test_grabs_since_skips_other_titles_and_rows_without_a_download_id(upstream):
    upstream.get(f"{RADARR}/api/v3/history/since").respond(200, json=[
        {"movieId": 2, "downloadId": "aa"},
        {"movieId": 1, "downloadId": None},
        {"movieId": 1, "downloadId": "bb"},
    ])
    assert await movie().grabs_since(NOW, 1) == {"BB"}


async def test_remove_downloads_one_delete_per_torrent_and_per_idless_row(radarr):
    """A torrent's rows go with one DELETE; rows without a download id are
    removed one by one; a row without a queue id is skipped; only real
    download ids are reported."""
    m = radarr.add_movie(movie_obj(5, "Alien"))
    (aa,) = radarr.grab(m["id"], "AA" * 20)
    radarr.queue.append(queue_record(901, download_id=None, movie_id=m["id"]))
    radarr.queue.append(queue_record(902, download_id=None, movie_id=m["id"]))
    rows = [{**r} for r in radarr.queue] + [{**aa}, {"downloadId": "CC" * 20}]
    removed = await movie().remove_downloads(rows)
    assert removed == {"AA" * 20}
    assert [d["id"] for d in radarr.queue_deleted] == [aa["id"], 901, 902]
    assert radarr.queue == []


async def test_cancel_sends_qbittorrent_only_real_hashes(api, radarr, qbit):
    m = radarr.add_movie(movie_obj(5, "Alien"))
    radarr.grab(m["id"], "AA" * 20)
    radarr.queue.append(queue_record(901, download_id=None, movie_id=m["id"]))
    assert (await api.delete("/api/activity/movie/5")).status_code == 200
    sent = [h for call in qbit.called("/torrents/info") for h in call["hashes"].split("|")]
    assert sent == ["aa" * 20]


# ---------------------------------------------------------------- by_imdb


async def test_by_imdb_without_a_digital_release_is_null(upstream):
    upstream.get(f"{RADARR}/api/v3/movie/lookup").respond(200, json=[{"tmdbId": 603, "title": "The Matrix"}])
    assert (await movie().by_imdb("tt0133093"))["digital_release"] is None


# ---------------------------------------------------------------- season_news / search_season edges


def _series(sid, tvdb, seasons, **kw):
    return {"id": sid, "tvdbId": tvdb, "title": f"Show {sid}", "monitored": True, "seasons": seasons, **kw}


def _season(n, monitored=True, **st):
    return {"seasonNumber": n, "monitored": monitored, "statistics": st}


@pytest.fixture
def frozen(time_machine):
    time_machine.move_to(NOW, tick=False)


async def test_news_keeps_going_after_a_series_without_tvdb(upstream, frozen):
    upstream.get(f"{SONARR}/api/v3/series").respond(200, json=[
        _series(1, 0, [_season(1, nextAiring=Z(NOW + timedelta(days=3)))]),
        _series(2, 22, [_season(1, nextAiring=Z(NOW + timedelta(days=3)))]),
    ])
    assert [i["media_id"] for i in await tv().season_news()] == ["22"]


async def test_upcoming_without_a_count_has_zero_episodes_and_its_monitored_flag(upstream, frozen):
    upstream.get(f"{SONARR}/api/v3/series").respond(200, json=[
        _series(1, 11, [_season(1, monitored=True, nextAiring=Z(NOW + timedelta(days=3))),
                        _season(2, monitored=False, nextAiring=Z(NOW + timedelta(days=90)))]),
    ])
    items = await tv().season_news()
    assert [(i["season"], i["episodes_total"], i["monitored"]) for i in items] == [(1, 0, True), (2, 0, False)]


async def test_aired_news_counts_an_episode_airing_this_second(upstream, frozen):
    upstream.get(f"{SONARR}/api/v3/series").respond(200, json=[
        _series(1, 11, [_season(1, previousAiring=Z(NOW))])])
    upstream.get(f"{SONARR}/api/v3/episode").respond(200, json=[
        {"seasonNumber": 1, "airDateUtc": Z(NOW)},
        {"seasonNumber": 1, "airDateUtc": Z(NOW + timedelta(days=7))},
    ])
    (item,) = await tv().season_news()
    assert item["episodes_aired"] == 1 and item["premiere"] == item["last_aired"] == Z(NOW)


async def test_aired_news_with_no_dated_episode_has_no_dates(upstream, frozen):
    upstream.get(f"{SONARR}/api/v3/series").respond(200, json=[
        _series(1, 11, [_season(1, previousAiring=Z(NOW - timedelta(days=2)))])])
    upstream.get(f"{SONARR}/api/v3/episode").respond(200, json=[{"seasonNumber": 1}])
    (item,) = await tv().season_news()
    assert (item["premiere"], item["last_aired"], item["episodes_aired"], item["episodes_total"]) == \
        (None, None, 0, 1)


async def test_news_item_title_defaults_to_empty(upstream, frozen):
    s = _series(1, 11, [_season(1, nextAiring=Z(NOW + timedelta(days=3)))])
    del s["title"]
    upstream.get(f"{SONARR}/api/v3/series").respond(200, json=[s])
    assert (await tv().season_news())[0]["title"] == ""


async def test_season_search_counts_an_episode_airing_this_second(upstream, frozen):
    upstream.get(f"{SONARR}/api/v3/series").respond(200, json=[
        _series(1, 11, [_season(1, monitored=False)], monitored=False)])
    upstream.get(f"{SONARR}/api/v3/episode").respond(200, json=[
        {"id": 5, "seasonNumber": 1, "airDateUtc": Z(NOW), "monitored": False}])
    put = upstream.put(f"{SONARR}/api/v3/series/1").respond(200, json={})
    mon = upstream.put(f"{SONARR}/api/v3/episode/monitor").respond(202, json={})
    upstream.post(f"{SONARR}/api/v3/command").respond(201, json={"id": 77})
    res = await tv().search_season("11", 1)
    assert res["status"] == "searching" and res["_undo"]["flipped"] == [5]
    assert put.called and json.loads(mon.calls[0].request.content) == {"episodeIds": [5], "monitored": True}
