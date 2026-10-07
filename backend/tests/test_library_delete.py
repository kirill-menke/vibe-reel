"""DELETE /api/library/{type}/{id}?delete_files=true: remove a title from
Sonarr/Radarr WITH ITS FILES (undo.Undo.delete_with_files) — the one request
that ever sends deleteFiles=true. Its grabs are cancelled first (queue rows
removed with their torrents and partial data, never a torrent of the old
manual-download category), the title unmonitored, its queued commands cancelled; while
a search of it is running the delete waits ("deleting"), removing late grabs.

Hard rules checked after every test by conftest's `arr_deletes_keep_files`:
a title DELETE with deleteFiles=true only from this route (inside
Undo.delete_with_files called by the route with delete_files=true, after it
answered), and never an import-list exclusion."""

from __future__ import annotations

import asyncio
import json
import time

import pytest

from reel_api import undo as undo_mod
from reel_api.models import LibraryUndoResult
from tests.conftest import NICOLE_TOKEN, TEST_AUTH, ZHENYA_TOKEN, auth_for
from tests.support.arr import episode_obj, movie_obj, season_obj, series_obj
from tests.support.clock import FakeClock
from tests.support.qbit import SimFile, SimTorrent, make_hash

NA = auth_for(NICOLE_TOKEN)
ZA = auth_for(ZHENYA_TOKEN)



def H(seed: str) -> str:
    return make_hash(seed).upper()


@pytest.fixture
async def stop_sweepers(api):
    yield
    for t in list(api.app_module.undo._tasks):
        t.cancel()
    await asyncio.sleep(0)


async def add(api, kind, media_id, auth=NA):
    r = await api.post("/api/library", json={"id": str(media_id), "type": kind}, headers={"Authorization": auth})
    assert r.status_code == 202, r.text
    return r.json()["undo"]


async def delete(api, kind, media_id, auth=NA, **params):
    return await api.delete(f"/api/library/{kind}/{media_id}", params={"delete_files": "true", **params},
                            headers={"Authorization": auth})


def torrent(qbit, seed, category="radarr"):
    return qbit.add_torrent(SimTorrent(hash=make_hash(seed), name=seed, category=category,
                                       files=[SimFile(f"{seed}.mkv", 65536)]))


def start_search(sim):
    search = next(c for c in sim.commands.values() if c["name"] in ("SeriesSearch", "MoviesSearch"))
    sim.set_command_status(search["id"], "started")
    return search


async def sweep(clock, seconds):
    for _ in range(max(1, round(seconds / undo_mod.SWEEP_EVERY))):
        await clock.advance(undo_mod.SWEEP_EVERY, settle=200)


def owners_titles(reel_env) -> dict:
    p = reel_env.state / "owners.json"
    return json.loads(p.read_text())["titles"] if p.exists() else {}


# ---------------------------------------------------------------- the delete


async def test_owner_deletes_a_downloading_movie_with_its_files(api, radarr, qbit, reel_env):
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    await add(api, "movie", 603)
    mid = radarr.title(603)["id"]
    radarr.grab(mid, H("grab"))
    torrent(qbit, "grab")
    r = await delete(api, "movie", 603)
    assert r.status_code == 200, r.text
    LibraryUndoResult.model_validate(r.json())
    assert r.json() == {"id": "603", "type": "movie", "title": "The Matrix", "status": "deleted",
                        "downloads_removed": 1}
    assert radarr.title(603) is None and radarr.files_deleted == [mid]
    assert radarr.deleted == [{"id": mid, "params": {"deleteFiles": "true", "addImportExclusion": "false"}}]
    assert radarr.queue == [] and radarr.queue_deleted[0]["params"] == {
        "removeFromClient": "true", "blocklist": "false", "skipRedownload": "true"}
    assert make_hash("grab") not in qbit.torrents
    # unmonitored first, its queued commands cancelled
    editor = radarr.called("/api/v3/movie/editor", "PUT")
    assert editor and editor[0].body == {"movieIds": [mid], "monitored": False}
    assert {c["status"] for c in radarr.commands.values()} == {"cancelled"}
    assert owners_titles(reel_env) == {}


async def test_a_series_in_the_library_goes_with_every_season(api, sonarr, qbit, reel_env):
    sonarr.add_catalog(series_obj(81189, "Breaking Bad", seasons=[season_obj(1), season_obj(2)]),
                       [episode_obj(1, 1, has_file=True), episode_obj(2, 1)])
    await add(api, "tv", 81189)
    sid = sonarr.title(81189)["id"]
    sonarr.grab(sid, H("s2"), episode_ids=[sonarr.episode(sid, 2, 1)["id"]])
    torrent(qbit, "s2", category="tv-sonarr")
    r = await delete(api, "tv", 81189)
    assert r.status_code == 200 and r.json()["status"] == "deleted"
    assert sonarr.deleted == [{"id": sid, "params": {"deleteFiles": "true", "addImportListExclusion": "false"}}]
    assert sonarr.files_deleted == [sid] and sonarr.queue == [] and make_hash("s2") not in qbit.torrents


async def test_grabs_already_gone_from_the_queue_are_purged_never_the_manual_category(api, radarr, qbit):
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    await add(api, "movie", 603)
    mid = radarr.title(603)["id"]
    radarr.grab(mid, H("left-queue"))
    radarr.grab(mid, H("manual"))
    radarr.queue = []  # the arr dropped them from its queue; history still has the grabs
    torrent(qbit, "left-queue")
    torrent(qbit, "manual", category="reel")  # the old manual-download category
    r = await delete(api, "movie", 603)
    assert r.json()["downloads_removed"] == 2
    assert make_hash("left-queue") not in qbit.torrents
    assert make_hash("manual") in qbit.torrents


async def test_a_qbittorrent_failure_does_not_stop_the_delete(api, radarr, qbit):
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    await add(api, "movie", 603)
    radarr.grab(radarr.title(603)["id"], H("g"))
    qbit.fail("/torrents/info", status=500)
    r = await delete(api, "movie", 603)
    assert r.status_code == 200 and r.json()["status"] == "deleted"


async def test_an_importing_grab_refuses_and_touches_nothing(api, radarr, qbit, reel_env):
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    await add(api, "movie", 603)
    mid = radarr.title(603)["id"]
    radarr.grab(mid, H("imp"), state="importing")
    radarr.grab(mid, H("other"))
    n = len(radarr.calls)
    r = await delete(api, "movie", 603)
    assert r.status_code == 409
    assert r.json() == {"error": "importing",
                        "detail": "“The Matrix” is being imported right now — try again in a minute."}
    mutating = [c for c in radarr.calls[n:] if c.method != "GET"]
    assert mutating == [] and radarr.title(603)["monitored"] is True
    assert "movie:603" in owners_titles(reel_env)


async def test_already_gone_answers_already_removed_and_drops_the_record(api, radarr, reel_env):
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    await add(api, "movie", 603)
    del radarr.titles[radarr.title(603)["id"]]
    r = await delete(api, "movie", 603)
    assert r.status_code == 200
    assert r.json() == {"id": "603", "type": "movie", "title": "The Matrix", "status": "already_removed",
                        "downloads_removed": 0}
    assert owners_titles(reel_env) == {} and radarr.deleted == []
    # and again (a retry after the first answer was lost): the same, no 403
    r = await delete(api, "movie", 603)
    assert r.status_code == 200 and r.json()["status"] == "already_removed" and r.json()["title"] == "603"


async def test_a_stale_arr_id_falls_back_to_the_media_id_for_an_admin(api, radarr, reel_env):
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    await add(api, "movie", 603)
    obj = radarr.title(603)
    # the arr id on record now names another movie (re-added in Radarr's UI meanwhile)
    del radarr.titles[obj["id"]]
    other = radarr.add_movie({**movie_obj(604, "Other"), "id": obj["id"]})
    moved = radarr.add_movie(movie_obj(603, "The Matrix"))
    r = await delete(api, "movie", 603, TEST_AUTH)
    assert r.status_code == 200 and r.json()["status"] == "deleted"
    assert radarr.files_deleted == [moved["id"]] and radarr.title(604) == other
    assert radarr.called("/api/v3/movie", "GET")[-1].params == {"tmdbId": "603"}


@pytest.mark.parametrize("reused", [True, False])
async def test_a_stale_arr_id_is_already_removed_for_its_owner(api, radarr, reel_env, reused):
    """Reviewer: the title was deleted outside reel-api and added again
    straight in Radarr (a legacy title now) before a prune ran: the old
    record's owner must not delete the new entry with its files."""
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    await add(api, "movie", 603)
    obj = radarr.title(603)
    del radarr.titles[obj["id"]]
    if reused:  # the arr id names another movie now
        radarr.add_movie({**movie_obj(604, "Other"), "id": obj["id"]})
    again = radarr.add_movie(movie_obj(603, "The Matrix", has_file=True))
    r = await delete(api, "movie", 603)
    assert r.status_code == 200
    assert r.json() == {"id": "603", "type": "movie", "title": "The Matrix", "status": "already_removed",
                        "downloads_removed": 0}
    assert radarr.files_deleted == [] and radarr.title(603) == again
    assert owners_titles(reel_env) == {}  # it is a legacy title now: the admins'
    r = await delete(api, "movie", 603)
    assert r.status_code == 403


async def test_an_admin_deletes_a_legacy_title_found_by_its_media_id(api, radarr, sonarr):
    m = radarr.add_movie(movie_obj(603, "The Matrix", has_file=True))
    s = sonarr.add_series(series_obj(81189, "Breaking Bad", seasons=[season_obj(1)]), [episode_obj(1, 1)])
    r1 = await delete(api, "movie", 603, TEST_AUTH)
    r2 = await delete(api, "tv", 81189, TEST_AUTH)
    assert r1.json()["status"] == r2.json()["status"] == "deleted"
    assert radarr.files_deleted == [m["id"]] and sonarr.files_deleted == [s["id"]]
    assert sonarr.called("/api/v3/series", "GET")[-1].params == {"tvdbId": "81189"}


async def test_lookups_say_not_added_afterwards(api, radarr):
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    await add(api, "movie", 603)
    r = await api.get("/api/lookup", params={"q": "matrix", "type": "movie"})
    assert r.json()["results"][0]["added"] is True
    await delete(api, "movie", 603)
    r = await api.get("/api/lookup", params={"q": "matrix", "type": "movie"})
    assert r.json()["results"][0]["added"] is False


async def test_a_series_delete_drops_its_season_requests_and_the_news_cache(api, sonarr, reel_env, stop_sweepers):
    from datetime import datetime, timedelta, timezone

    aired = datetime.now(timezone.utc) - timedelta(days=3)
    sonarr.add_catalog(series_obj(81189, "Breaking Bad", seasons=[season_obj(1), season_obj(2)]),
                       [episode_obj(1, 1, air=aired), episode_obj(2, 1, air=aired)])
    await add(api, "tv", 81189)
    r = await api.post("/api/news/search", json={"id": "81189", "season": 2}, headers={"Authorization": ZA})
    assert r.status_code == 202
    await api.get("/api/news")
    assert api.app_module._news_cache is not None
    assert api.app_module.owners.season("81189", 2) is not None
    r = await delete(api, "tv", 81189)
    assert r.status_code == 200
    assert api.app_module._news_cache is None
    assert api.app_module.owners.season("81189", 2) is None
    assert json.loads((reel_env.state / "owners.json").read_text())["seasons"] == {}


async def test_a_delete_frees_the_slot_at_once(make_api, radarr):
    for m in (1, 2, 3):
        radarr.add_catalog(movie_obj(m, f"M{m}"))
    async with make_api(REEL_API_QUOTA_MOVIES="2") as api:
        await add(api, "movie", 1)
        await add(api, "movie", 2)
        r = await api.post("/api/library", json={"id": "3", "type": "movie"}, headers={"Authorization": NA})
        assert r.status_code == 409
        assert (await delete(api, "movie", 1)).status_code == 200
        await add(api, "movie", 3)


# ---------------------------------------------------------------- while a search runs


async def test_a_running_search_defers_the_delete(api, radarr, qbit, monkeypatch, stop_sweepers, reel_env):
    clock = FakeClock(start=time.monotonic(), auto=False).install(monkeypatch, undo_mod)
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    await add(api, "movie", 603)
    mid = radarr.title(603)["id"]
    search = start_search(radarr)
    r = await delete(api, "movie", 603)
    assert r.status_code == 200 and r.json()["status"] == "deleting"
    assert radarr.title(603)["monitored"] is False and radarr.deleted == []
    assert owners_titles(reel_env) == {}  # the slot is free at once

    # the same request again: the remembered answer, nothing new sent
    n = len(radarr.calls)
    assert (await delete(api, "movie", 603)).json() == r.json()
    assert len(radarr.calls) == n
    # another user may not ride on it
    assert (await delete(api, "movie", 603, ZA)).status_code == 403
    # adding it back meanwhile is refused
    a = await api.post("/api/library", json={"id": "603", "type": "movie"}, headers={"Authorization": NA})
    assert a.status_code == 409
    assert a.json() == {"error": "being_deleted",
                        "detail": "“The Matrix” is being deleted right now — add it again in a minute."}

    # the search grabs something late: removed by the watcher
    await sweep(clock, undo_mod.SWEEP_EVERY)
    radarr.grab(mid, H("late"))
    torrent(qbit, "late")
    await sweep(clock, undo_mod.SWEEP_EVERY)
    assert radarr.queue == [] and make_hash("late") not in qbit.torrents
    assert radarr.deleted == []

    radarr.set_command_status(search["id"], "completed")
    await sweep(clock, undo_mod.SWEEP_QUIET + 2 * undo_mod.SWEEP_EVERY)
    assert radarr.files_deleted == [mid]
    assert api.app_module.undo._tasks == set()
    assert api.app_module.undo.pending_delete("movie", "603") is None
    # done: a new add is a fresh add
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    await add(api, "movie", 603)


async def test_a_grab_landing_after_the_watch_is_removed_before_the_delete(api, radarr, qbit, monkeypatch,
                                                                         stop_sweepers):
    clock = FakeClock(start=time.monotonic(), auto=False).install(monkeypatch, undo_mod)
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    await add(api, "movie", 603)
    mid = radarr.title(603)["id"]
    search = start_search(radarr)
    real_watch = undo_mod.Undo._watch

    async def watch_then_grab(self, *a, **kw):
        await real_watch(self, *a, **kw)
        radarr.grab(mid, H("last"))  # between the watcher's last look and the delete
        torrent(qbit, "last")

    monkeypatch.setattr(undo_mod.Undo, "_watch", watch_then_grab)
    assert (await delete(api, "movie", 603)).json()["status"] == "deleting"
    radarr.set_command_status(search["id"], "completed")
    await sweep(clock, undo_mod.SWEEP_QUIET + 3 * undo_mod.SWEEP_EVERY)
    assert api.app_module.undo._tasks == set()
    assert make_hash("last") not in qbit.torrents and radarr.queue == []
    assert radarr.files_deleted == [mid]


async def test_a_failing_watcher_logs_and_clears_the_pending_delete(api, radarr, monkeypatch, caplog,
                                                                  stop_sweepers, reel_env):
    clock = FakeClock(start=time.monotonic(), auto=False).install(monkeypatch, undo_mod)
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    await add(api, "movie", 603)
    mid = radarr.title(603)["id"]
    search = start_search(radarr)
    assert (await delete(api, "movie", 603)).json()["status"] == "deleting"
    radarr.set_command_status(search["id"], "completed")
    radarr.fail("/api/v3/movie/{id}", status=500, times=1)
    await sweep(clock, undo_mod.SWEEP_QUIET + 3 * undo_mod.SWEEP_EVERY)
    assert "could not finish" in caplog.text
    assert api.app_module.undo.pending_delete("movie", "603") is None
    assert radarr.title(603) is not None
    # still there, so still hers (reviewer: the record was gone, her retry a 403 "added by an admin")
    assert owners_titles(reel_env)["movie:603"]["owner_name"] == "nicole"
    assert (await delete(api, "movie", 603)).json()["status"] == "deleted"
    assert radarr.files_deleted == [mid] and owners_titles(reel_env) == {}


async def test_a_failing_watcher_restores_no_record_someone_wrote_meanwhile(api, radarr, monkeypatch,
                                                                          stop_sweepers, reel_env):
    clock = FakeClock(start=time.monotonic(), auto=False).install(monkeypatch, undo_mod)
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    await add(api, "movie", 603)
    mid = radarr.title(603)["id"]
    search = start_search(radarr)
    assert (await delete(api, "movie", 603)).json()["status"] == "deleting"
    from reel_api.security import User
    api.app_module.owners.record_title("movie", "603", arr_id=mid, title="The Matrix", year=None,
                                       user=User("z", "Zhenya", False), at=undo_mod.datetime.now(undo_mod.timezone.utc))
    radarr.set_command_status(search["id"], "completed")
    radarr.fail("/api/v3/movie/{id}", status=500, times=1)
    await sweep(clock, undo_mod.SWEEP_QUIET + 3 * undo_mod.SWEEP_EVERY)
    assert owners_titles(reel_env)["movie:603"]["owner_name"] == "Zhenya"


async def test_a_failing_watcher_of_a_legacy_title_restores_nothing(api, radarr, monkeypatch, caplog,
                                                                  stop_sweepers, reel_env):
    clock = FakeClock(start=time.monotonic(), auto=False).install(monkeypatch, undo_mod)
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    await add(api, "movie", 603, TEST_AUTH)
    api.app_module.owners.drop_title("movie", "603")  # no record: legacy
    m = radarr.title(603)
    search = start_search(radarr)
    assert (await delete(api, "movie", 603, TEST_AUTH)).json()["status"] == "deleting"
    radarr.set_command_status(search["id"], "completed")
    radarr.fail("/api/v3/movie/{id}", status=500, times=1)
    await sweep(clock, undo_mod.SWEEP_QUIET + 3 * undo_mod.SWEEP_EVERY)
    assert "could not finish" in caplog.text
    assert owners_titles(reel_env) == {}


async def test_a_failure_mid_delete_leaves_no_pending_delete(api, radarr):
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    await add(api, "movie", 603)
    radarr.fail("/api/v3/movie/editor", status=500)
    r = await delete(api, "movie", 603)
    assert r.status_code == 503
    assert api.app_module.undo.pending_delete("movie", "603") is None
    assert (await delete(api, "movie", 603)).json()["status"] == "deleted"


# ---------------------------------------------------------------- the request


@pytest.mark.parametrize("params", [{}, {"delete_files": "false"}, {"undo": "x" * 22, "delete_files": "true"}])
async def test_neither_or_both_is_400(api, radarr, params):
    r = await api.delete("/api/library/movie/603", params=params)
    assert r.status_code == 400
    assert r.json() == {"error": "bad_request", "detail": "pass either undo=<token> or delete_files=true"}
    assert radarr.calls == []


async def test_undo_still_never_deletes_files(api, radarr, reel_env):
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    token = await add(api, "movie", 603)
    r = await api.delete("/api/library/movie/603", params={"undo": token, "delete_files": "false"},
                         headers={"Authorization": NA})
    assert r.status_code == 200 and r.json()["status"] == "removed"
    assert radarr.deleted[0]["params"]["deleteFiles"] == "false" and radarr.files_deleted == []
    assert owners_titles(reel_env) == {}  # the undo drops the record too


async def test_an_unconfigured_type_is_503(make_api):
    async with make_api(RADARR_API_KEY=None) as api:
        r = await delete(api, "movie", 603, TEST_AUTH)
    assert r.status_code == 503 and r.json()["error"] == "not_available"
