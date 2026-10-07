"""DELETE /api/activity/{type}/{id}: cancel a title's grabs in flight
(app.cancel_activity -> undo.Undo.cancel). Removes the queue rows from the arr
(removeFromClient, skipRedownload, blocklist only on request), deletes the
torrents with their partial data from qBittorrent (never one in the old
manual-download category, undo.MANUAL_CATEGORY), unmonitors what was cancelled, keeps importing grabs."""

import pytest

from reel_api.models import CancelResult
from tests.support.arr import episode_obj, movie_obj, season_obj, series_obj
from tests.support.qbit import SimFile, SimTorrent, make_hash

DELETE_PATH = "/torrents/delete"


def H(seed: str) -> str:
    return make_hash(seed).upper()


def show(sonarr, tvdb=81189, title="Breaking Bad", seasons=(1, 2), eps=3):
    s = sonarr.add_series(
        series_obj(tvdb, title, seasons=[season_obj(n) for n in seasons]),
        [episode_obj(n, i) for n in seasons for i in range(1, eps + 1)])
    return s


def ep_id(sonarr, s, season, number):
    return sonarr.episode(s["id"], season, number)["id"]


def torrent(qbit, seed, category="tv-sonarr"):
    return qbit.add_torrent(SimTorrent(hash=make_hash(seed), name=seed, category=category,
                                       files=[SimFile(f"{seed}.mkv", 65536)]))


def deleted_hashes(qbit) -> list[tuple[str, str]]:
    """(hash, deleteFiles) per hash of every torrents/delete call."""
    out = []
    for form in qbit.called(DELETE_PATH):
        for h in form["hashes"].split("|"):
            out.append((h, form["deleteFiles"]))
    return out


async def cancel(api, kind, media_id, **params):
    return await api.delete(f"/api/activity/{kind}/{media_id}", params=params)


# ---------------------------------------------------------------- validation


async def test_episode_without_season_is_400(api, sonarr):
    r = await cancel(api, "tv", "81189", episode=1)
    assert r.status_code == 400
    assert r.json() == {"error": "bad_request", "detail": "episode needs season"}
    assert sonarr.calls == []


@pytest.mark.parametrize("params", [{"season": 1}, {"season": 1, "episode": 2}])
async def test_movie_with_season_is_400(api, radarr, params):
    r = await cancel(api, "movie", "603", **params)
    assert r.status_code == 400
    assert r.json() == {"error": "bad_request", "detail": "a movie has no seasons"}
    assert radarr.calls == []


@pytest.mark.parametrize("path", [
    "/api/activity/music/1", "/api/activity/tv/abc", "/api/activity/tv/12345678901",
    "/api/activity/tv/1?season=-1", "/api/activity/tv/1?season=501",
    "/api/activity/tv/1?season=1&episode=5001",
])
async def test_path_and_query_validation_is_422(api, path):
    r = await api.delete(path)
    assert r.status_code == 422


async def test_without_the_arr_is_503(make_api):
    async with make_api(SONARR_API_KEY=None) as api:
        r = await cancel(api, "tv", "81189")
    assert r.status_code == 503
    assert r.json()["error"] == "not_available"


async def test_nothing_in_queue_is_404(api, sonarr, qbit):
    s = show(sonarr)
    other = show(sonarr, tvdb=121361, title="Game of Thrones")
    sonarr.grab(other["id"], H("got"), episode_ids=[ep_id(sonarr, other, 1, 1)])
    sonarr.grab(s["id"], H("bb-s1"), episode_ids=[ep_id(sonarr, s, 1, 1)])
    for params in ({}, {"season": 2}, {"season": 1, "episode": 3}):
        target = "81189" if params else "999"
        r = await cancel(api, "tv", target, **params)
        assert r.status_code == 404, params
        assert r.json() == {"error": "not_in_queue", "detail": "nothing of that is downloading"}
    assert sonarr.queue_deleted == []
    assert qbit.called(DELETE_PATH) == []


# ---------------------------------------------------------------- selection


async def test_whole_title_cancels_every_grab_of_it(api, sonarr, qbit):
    s = show(sonarr)
    other = show(sonarr, tvdb=121361, title="Game of Thrones")
    e11, e12, e21 = ep_id(sonarr, s, 1, 1), ep_id(sonarr, s, 1, 2), ep_id(sonarr, s, 2, 1)
    sonarr.grab(s["id"], H("a"), episode_ids=[e11])
    sonarr.grab(s["id"], H("b"), episode_ids=[e12])
    sonarr.grab(s["id"], H("c"), episode_ids=[e21])
    sonarr.grab(other["id"], H("got"), episode_ids=[ep_id(sonarr, other, 1, 1)])
    for seed in ("a", "b", "c", "got"):
        torrent(qbit, seed)

    r = await cancel(api, "tv", "81189")
    assert r.status_code == 200, r.text
    body = r.json()
    CancelResult.model_validate(body)
    assert body == {"id": "81189", "type": "tv", "status": "cancelled", "downloads_removed": 3,
                    "episodes": [{"season": 1, "episode": 1}, {"season": 1, "episode": 2},
                                 {"season": 2, "episode": 1}],
                    "unmonitored": 3, "kept": 0}
    left = {r["downloadId"] for r in sonarr.queue}
    assert left == {H("got")}
    assert set(qbit.torrents) == {make_hash("got")}
    assert sorted(h for h, _ in deleted_hashes(qbit)) == sorted(make_hash(x) for x in "abc")


async def test_one_season(api, sonarr, qbit):
    s = show(sonarr)
    e11, e21, e22 = ep_id(sonarr, s, 1, 1), ep_id(sonarr, s, 2, 1), ep_id(sonarr, s, 2, 2)
    sonarr.grab(s["id"], H("s1"), episode_ids=[e11])
    sonarr.grab(s["id"], H("s2a"), episode_ids=[e21])
    sonarr.grab(s["id"], H("s2b"), episode_ids=[e22])

    r = await cancel(api, "tv", "81189", season=2)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["downloads_removed"] == 2
    assert body["episodes"] == [{"season": 2, "episode": 1}, {"season": 2, "episode": 2}]
    assert [r["downloadId"] for r in sonarr.queue] == [H("s1")]
    assert sonarr.episodes[e11]["monitored"] is True
    assert sonarr.episodes[e21]["monitored"] is False
    assert sonarr.episodes[e22]["monitored"] is False


async def test_one_episode(api, sonarr, qbit):
    s = show(sonarr)
    e11, e12 = ep_id(sonarr, s, 1, 1), ep_id(sonarr, s, 1, 2)
    sonarr.grab(s["id"], H("e1"), episode_ids=[e11])
    sonarr.grab(s["id"], H("e2"), episode_ids=[e12])
    torrent(qbit, "e1")
    torrent(qbit, "e2")

    r = await cancel(api, "tv", "81189", season=1, episode=2)
    assert r.status_code == 200, r.text
    assert r.json()["episodes"] == [{"season": 1, "episode": 2}]
    assert r.json()["unmonitored"] == 1
    assert [r["downloadId"] for r in sonarr.queue] == [H("e1")]
    assert set(qbit.torrents) == {make_hash("e1")}
    assert sonarr.episodes[e11]["monitored"] is True
    assert sonarr.episodes[e12]["monitored"] is False


async def test_season_pack_goes_as_a_whole(api, sonarr, qbit):
    """One episode of a season pack asked for: the pack is one torrent, so
    every episode it covers is cancelled (and unmonitored) with it."""
    s = show(sonarr, eps=4)
    pack = [ep_id(sonarr, s, 1, i) for i in range(1, 5)]
    sonarr.grab(s["id"], H("pack"), episode_ids=pack)
    single = ep_id(sonarr, s, 2, 1)
    sonarr.grab(s["id"], H("single"), episode_ids=[single])
    torrent(qbit, "pack")
    torrent(qbit, "single")

    r = await cancel(api, "tv", "81189", season=1, episode=3)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["downloads_removed"] == 1  # one torrent
    assert body["episodes"] == [{"season": 1, "episode": i} for i in range(1, 5)]
    assert body["unmonitored"] == 4
    # one queue DELETE for the torrent, not one per episode row
    assert len(sonarr.queue_deleted) == 1
    assert [r["downloadId"] for r in sonarr.queue] == [H("single")]
    assert all(sonarr.episodes[e]["monitored"] is False for e in pack)
    assert sonarr.episodes[single]["monitored"] is True
    monitor_calls = sonarr.called("/api/v3/episode/monitor", "PUT")
    assert [c.body for c in monitor_calls] == [{"episodeIds": sorted(pack), "monitored": False}]
    assert deleted_hashes(qbit) == [(make_hash("pack"), "true")]


# ---------------------------------------------------------------- safety


async def test_importing_grab_is_kept(api, sonarr, qbit):
    s = show(sonarr)
    e11, e12 = ep_id(sonarr, s, 1, 1), ep_id(sonarr, s, 1, 2)
    sonarr.grab(s["id"], H("busy"), episode_ids=[e11], state="importing")
    dl_row = sonarr.grab(s["id"], H("dl"), episode_ids=[e12])[0]["id"]
    torrent(qbit, "busy")
    torrent(qbit, "dl")

    r = await cancel(api, "tv", "81189")
    assert r.status_code == 200, r.text
    assert [d["id"] for d in sonarr.queue_deleted] == [dl_row]
    body = r.json()
    assert body["kept"] == 1
    assert body["downloads_removed"] == 1
    assert body["episodes"] == [{"season": 1, "episode": 2}]
    assert {r["downloadId"] for r in sonarr.queue} == {H("busy")}
    assert make_hash("busy") in qbit.torrents
    assert make_hash("busy") not in [h for h, _ in deleted_hashes(qbit)]
    assert sonarr.episodes[e11]["monitored"] is True  # not cancelled -> not unmonitored


# importPending / importBlocked: the download is finished and the arr is (about to be)
# moving it into the library — the data is the import's, not a partial to delete.
@pytest.mark.parametrize("state", ["importing", "imported", "importPending", "importBlocked"])
async def test_only_importing_grabs_is_409(api, radarr, qbit, state):
    m = radarr.add_movie(movie_obj(603, "The Matrix"))
    radarr.grab(m["id"], H("m"), state=state)
    torrent(qbit, "m", category="radarr")

    r = await cancel(api, "movie", "603")
    assert r.status_code == 409
    assert r.json()["error"] == "importing"
    assert radarr.queue_deleted == []
    assert qbit.called(DELETE_PATH) == []
    assert radarr.titles[m["id"]]["monitored"] is True


async def test_importing_pack_keeps_all_its_rows(api, sonarr, qbit):
    """A pack whose import has begun (one row importing) is kept as a whole:
    the other rows of the same torrent are not removed either."""
    s = show(sonarr, eps=2)
    e1, e2 = ep_id(sonarr, s, 1, 1), ep_id(sonarr, s, 1, 2)
    rows = sonarr.grab(s["id"], H("pack"), episode_ids=[e1, e2])
    rows[0]["trackedDownloadState"] = "importing"
    r = await cancel(api, "tv", "81189", season=1, episode=2)
    assert r.status_code == 409
    assert sonarr.queue_deleted == []


async def test_manual_category_torrent_is_never_deleted(api, sonarr, qbit):
    """A hash that qBittorrent files under the old manual-download category
    ("reel", from the removed POST /api/downloads) stays in qBittorrent even
    when its arr row goes."""
    s = show(sonarr)
    sonarr.grab(s["id"], H("mine"), episode_ids=[ep_id(sonarr, s, 1, 1)])
    sonarr.grab(s["id"], H("arr"), episode_ids=[ep_id(sonarr, s, 1, 2)])
    torrent(qbit, "mine", category="reel")
    torrent(qbit, "arr")

    r = await cancel(api, "tv", "81189")
    assert r.status_code == 200, r.text
    assert make_hash("mine") in qbit.torrents
    assert deleted_hashes(qbit) == [(make_hash("arr"), "true")]


async def test_qbit_delete_only_for_cancelled_hashes(api, sonarr, qbit):
    s = show(sonarr)
    sonarr.grab(s["id"], H("x"), episode_ids=[ep_id(sonarr, s, 1, 1)])
    for seed in ("x", "y", "z"):
        torrent(qbit, seed)
    r = await cancel(api, "tv", "81189")
    assert r.status_code == 200
    # the rows lookup asks for exactly the cancelled hash
    infos = [f for f in qbit.called("/torrents/info") if "hashes" in f]
    assert infos and all(f["hashes"] == make_hash("x") for f in infos)
    assert deleted_hashes(qbit) == [(make_hash("x"), "true")]
    assert set(qbit.torrents) == {make_hash("y"), make_hash("z")}


async def test_qbit_failure_still_cancels(api, sonarr, qbit):
    """qBittorrent unreachable: the arr side (queue DELETE with
    removeFromClient) already went through — the cancel still answers 200."""
    s = show(sonarr)
    sonarr.grab(s["id"], H("x"), episode_ids=[ep_id(sonarr, s, 1, 1)])
    torrent(qbit, "x")
    qbit.fail("/torrents/info", status=500)
    r = await cancel(api, "tv", "81189")
    assert r.status_code == 200, r.text
    assert r.json()["downloads_removed"] == 1
    assert sonarr.queue == []


# ---------------------------------------------------------------- arr parameters


@pytest.mark.parametrize("blocklist, expect", [(None, "false"), ("false", "false"), ("true", "true")])
async def test_queue_delete_parameters(api, radarr, qbit, blocklist, expect):
    m = radarr.add_movie(movie_obj(603, "The Matrix"))
    row = radarr.grab(m["id"], H("m"))[0]
    torrent(qbit, "m", category="radarr")
    params = {} if blocklist is None else {"blocklist": blocklist}

    r = await cancel(api, "movie", "603", **params)
    assert r.status_code == 200, r.text
    assert radarr.queue_deleted == [{"id": row["id"], "params": {
        "removeFromClient": "true", "blocklist": expect, "skipRedownload": "true"}}]


async def test_movie_cancel_unmonitors_the_movie(api, radarr, qbit):
    m = radarr.add_movie(movie_obj(603, "The Matrix"))
    other = radarr.add_movie(movie_obj(604, "The Matrix Reloaded"))
    radarr.grab(m["id"], H("m"))
    radarr.grab(other["id"], H("o"))
    torrent(qbit, "m", category="radarr")
    torrent(qbit, "o", category="radarr")

    r = await cancel(api, "movie", "603")
    assert r.status_code == 200, r.text
    body = r.json()
    CancelResult.model_validate(body)
    assert body == {"id": "603", "type": "movie", "status": "cancelled", "downloads_removed": 1,
                    "episodes": [], "unmonitored": 1, "kept": 0}
    assert radarr.titles[m["id"]]["monitored"] is False
    assert radarr.titles[other["id"]]["monitored"] is True
    editor = radarr.called("/api/v3/movie/editor", "PUT")
    assert [c.body for c in editor] == [{"movieIds": [m["id"]], "monitored": False}]
    assert [r["downloadId"] for r in radarr.queue] == [H("o")]
    assert set(qbit.torrents) == {make_hash("o")}
    # a cancel never removes the title itself
    assert radarr.deleted == []


async def test_row_without_download_id_is_removed_by_row(api, radarr, qbit):
    """A queue row with no downloadId yet (a grab the client hasn't reported):
    removed by its row id, counted once, nothing to delete in qBittorrent."""
    m = radarr.add_movie(movie_obj(603, "The Matrix"))
    row = radarr.grab(m["id"], None, history=False)[0]
    r = await cancel(api, "movie", "603")
    assert r.status_code == 200, r.text
    assert r.json()["downloads_removed"] == 1
    assert [d["id"] for d in radarr.queue_deleted] == [row["id"]]
    assert qbit.called(DELETE_PATH) == []


async def test_arr_queue_delete_failure_is_503(api, radarr, qbit):
    m = radarr.add_movie(movie_obj(603, "The Matrix"))
    row = radarr.grab(m["id"], H("m"))[0]
    radarr.fail(f"/api/v3/queue/{row['id']}", status=500)
    r = await cancel(api, "movie", "603")
    assert r.status_code == 503
    assert r.headers["retry-after"] == "30"
    assert r.json()["error"] == "temporarily_unavailable"
