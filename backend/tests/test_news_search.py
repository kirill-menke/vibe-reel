"""POST /api/news/search ("Get" on a new season: arr.search_season) and
DELETE /api/news/search/{token} (undo.Undo.undo_get +
arr.restore_season_monitoring): what is monitored, the SeasonSearch command,
and an undo that restores exactly the flags it flipped and removes only the
season's grabs made since the search."""

import asyncio
import time
from datetime import datetime, timedelta, timezone

import pytest

from reel_api import undo as undo_mod
from reel_api.models import SeasonSearchResult, SeasonSearchUndoResult
from tests.support.arr import episode_obj, season_obj, series_obj
from tests.support.clock import FakeClock
from tests.support.qbit import SimFile, SimTorrent, make_hash

NOW = datetime(2026, 6, 15, 12, 0, tzinfo=timezone.utc)
MONITOR = "/api/v3/episode/monitor"


@pytest.fixture(autouse=True)
def frozen(time_machine):
    time_machine.move_to(NOW, tick=False)


@pytest.fixture(autouse=True)
async def stop_sweepers(api):
    """undo_get always leaves a watcher behind; cancel it at teardown."""
    yield
    for t in list(api.app_module.undo._tasks):
        t.cancel()
    await asyncio.sleep(0)


def H(seed: str) -> str:
    return make_hash(seed).upper()


def torrent(qbit, seed, category="tv-sonarr"):
    return qbit.add_torrent(SimTorrent(hash=make_hash(seed), name=seed, category=category,
                                       files=[SimFile(f"{seed}.mkv", 65536)]))


def the_show(sonarr, *, series_monitored=False, s2_monitored=False):
    """Season 1 on disk; season 2: E1 aired (unmonitored), E2 aired
    (monitored), E3 airs next week (unmonitored)."""
    s = sonarr.add_series(
        series_obj(81189, "Breaking Bad", monitored=series_monitored,
                   seasons=[season_obj(1), season_obj(2, monitored=s2_monitored)]),
        [episode_obj(1, 1, air=NOW - timedelta(days=700), has_file=True),
         episode_obj(2, 1, air=NOW - timedelta(days=14), monitored=False),
         episode_obj(2, 2, air=NOW - timedelta(days=7), monitored=True),
         episode_obj(2, 3, air=NOW + timedelta(days=7), monitored=False)])
    e = {(x["seasonNumber"], x["episodeNumber"]): x["id"] for x in sonarr.episodes_of(s["id"])}
    return s, e


async def get_season(api, media_id="81189", season=2):
    return await api.post("/api/news/search", json={"id": media_id, "season": season})


def season_monitored(sonarr, sid, n):
    return next(se["monitored"] for se in sonarr.titles[sid]["seasons"] if se["seasonNumber"] == n)


# ---------------------------------------------------------------- the search


async def test_search_answers_202_and_monitors_aired_episodes(api, sonarr):
    s, e = the_show(sonarr)
    r = await get_season(api)
    assert r.status_code == 202, r.text
    body = r.json()
    SeasonSearchResult.model_validate(body)
    token = body.pop("undo")
    assert body == {"id": "81189", "season": 2, "title": "Breaking Bad", "status": "searching"}
    assert isinstance(token, str) and 8 <= len(token) <= 64

    sid = s["id"]
    assert sonarr.titles[sid]["monitored"] is True
    assert season_monitored(sonarr, sid, 2) is True
    assert season_monitored(sonarr, sid, 1) is True
    # only the aired, unmonitored episode is flipped; the future one stays off
    assert [c.body for c in sonarr.called(MONITOR, "PUT")] == [
        {"episodeIds": [e[2, 1]], "monitored": True}]
    assert sonarr.episodes[e[2, 3]]["monitored"] is False
    # monitoring first, then the search
    methods = [(c.method, c.path) for c in sonarr.calls if c.method != "GET"]
    assert methods == [("PUT", f"/api/v3/series/{sid}"), ("PUT", MONITOR), ("POST", "/api/v3/command")]
    (cmd,) = [c for c in sonarr.commands.values() if c["name"] == "SeasonSearch"]
    assert cmd["body"] == {"name": "SeasonSearch", "seriesId": sid, "seasonNumber": 2}
    assert sonarr.called("/api/v3/command", "POST")[0].body == {
        "name": "SeasonSearch", "seriesId": sid, "seasonNumber": 2}


async def test_search_with_everything_monitored_sends_no_episode_put(api, sonarr):
    s, e = the_show(sonarr, series_monitored=True, s2_monitored=True)
    sonarr.episodes[e[2, 1]]["monitored"] = True
    assert (await get_season(api)).status_code == 202
    assert sonarr.called(MONITOR, "PUT") == []
    assert sonarr.count("/api/v3/command", "POST") == 1


@pytest.mark.parametrize("media_id, season", [("999", 1), ("81189", 7)])
async def test_unknown_series_or_season_is_404(api, sonarr, media_id, season):
    the_show(sonarr)
    r = await get_season(api, media_id, season)
    assert r.status_code == 404
    assert r.json() == {"error": "not_found", "detail": "no such title"}
    assert [c for c in sonarr.calls if c.method != "GET"] == []


async def test_nothing_aired_is_409_and_sends_nothing(api, sonarr):
    s = sonarr.add_series(series_obj(5, "Upcoming", monitored=False, seasons=[season_obj(1, monitored=False)]),
                          [episode_obj(1, 1, air=NOW + timedelta(days=3)), episode_obj(1, 2)])
    r = await get_season(api, "5", 1)
    assert r.status_code == 409
    assert r.json() == {"error": "not_aired", "detail": "nothing has aired yet: Upcoming season 1"}
    assert [c for c in sonarr.calls if c.method != "GET"] == []
    assert sonarr.commands == {}
    assert sonarr.titles[s["id"]]["monitored"] is False


@pytest.mark.parametrize("payload", [{"id": "1"}, {"season": 1}, {"id": "1", "season": "x"},
                                     {"id": "081189", "season": 1}, {"id": "x", "season": 1}])
async def test_bad_body_is_422(api, payload):
    assert (await api.post("/api/news/search", json=payload)).status_code == 422


async def test_without_sonarr_is_503(make_api):
    async with make_api(SONARR_API_KEY=None) as api:
        assert (await get_season(api)).status_code == 503
        r = await api.delete("/api/news/search/" + "x" * 22)
        assert r.status_code == 503 and r.json()["error"] == "not_available"


async def test_arr_failure_while_monitoring_is_503(api, sonarr):
    s, _ = the_show(sonarr)
    # GET /series?tvdbId and GET /episode pass; the series PUT fails
    sonarr.fail(f"/api/v3/series/{s['id']}", status=500)
    r = await get_season(api)
    assert r.status_code == 503
    assert sonarr.commands == {}


# ---------------------------------------------------------------- the undo


async def test_undo_restores_exactly_what_was_flipped(api, sonarr):
    s, e = the_show(sonarr)
    sid = s["id"]
    token = (await get_season(api)).json()["undo"]
    r = await api.delete(f"/api/news/search/{token}")
    assert r.status_code == 200, r.text
    body = r.json()
    SeasonSearchUndoResult.model_validate(body)
    assert body == {"id": "81189", "season": 2, "title": "Breaking Bad", "status": "reverted",
                    "downloads_removed": 0, "kept": 0}
    assert sonarr.titles[sid]["monitored"] is False
    assert season_monitored(sonarr, sid, 2) is False
    assert season_monitored(sonarr, sid, 1) is True
    assert sonarr.episodes[e[2, 1]]["monitored"] is False  # flipped back
    assert sonarr.episodes[e[2, 2]]["monitored"] is True  # was monitored before: untouched
    assert sonarr.episodes[e[2, 3]]["monitored"] is False
    puts = sonarr.called(MONITOR, "PUT")
    assert puts[-1].body == {"episodeIds": [e[2, 1]], "monitored": False}
    # the still-queued SeasonSearch was cancelled
    (cmd,) = [c for c in sonarr.commands.values() if c["name"] == "SeasonSearch"]
    assert cmd["status"] == "cancelled"


async def test_undo_leaves_flags_that_were_already_on(api, sonarr):
    s, e = the_show(sonarr, series_monitored=True, s2_monitored=True)
    sid = s["id"]
    token = (await get_season(api)).json()["undo"]
    n_series_puts = sonarr.count(f"/api/v3/series/{sid}", "PUT")
    assert (await api.delete(f"/api/news/search/{token}")).status_code == 200
    assert sonarr.count(f"/api/v3/series/{sid}", "PUT") == n_series_puts  # nothing to restore there
    assert sonarr.titles[sid]["monitored"] is True and season_monitored(sonarr, sid, 2) is True
    assert sonarr.episodes[e[2, 1]]["monitored"] is False


async def test_undo_only_season_off_keeps_series_on(api, sonarr):
    s, e = the_show(sonarr, series_monitored=True, s2_monitored=False)
    sid = s["id"]
    token = (await get_season(api)).json()["undo"]
    assert (await api.delete(f"/api/news/search/{token}")).status_code == 200
    assert sonarr.titles[sid]["monitored"] is True
    assert season_monitored(sonarr, sid, 2) is False


@pytest.mark.parametrize("busy_state", ["importing", "importPending", "importBlocked"])
async def test_undo_removes_the_seasons_new_grabs_only(api, sonarr, qbit, time_machine, busy_state):
    s, e = the_show(sonarr)
    sid = s["id"]
    # grabbed before the search (another season search, an RSS grab): not ours
    sonarr.grab(sid, H("before"), episode_ids=[e[2, 2]], date=NOW - timedelta(hours=1))
    token = (await get_season(api)).json()["undo"]
    time_machine.move_to(NOW + timedelta(seconds=30), tick=False)
    sonarr.grab(sid, H("pack"), episode_ids=[e[2, 1], e[2, 2]])
    sonarr.grab(sid, H("s1"), episode_ids=[e[1, 1]])  # another season: not ours
    sonarr.grab(sid, H("busy"), episode_ids=[e[2, 3]], state=busy_state)
    # in the queue for the season since the search, but no grab history (yet)
    sonarr.grab(sid, H("nohist"), episode_ids=[e[2, 3]], history=False)
    for seed in ("before", "pack", "s1", "busy", "nohist"):
        torrent(qbit, seed)
    torrent(qbit, "manual", category="reel")
    sonarr.add_history("grabbed", download_id=H("manual"), series_id=sid, episode_id=e[2, 1])

    r = await api.delete(f"/api/news/search/{token}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "reverted"
    assert body["kept"] == 1
    assert body["downloads_removed"] == 3  # pack, nohist, manual (counted; kept in qBittorrent)
    left = {r["downloadId"] for r in sonarr.queue}
    assert left == {H("before"), H("s1"), H("busy")}
    assert set(qbit.torrents) == {make_hash(x) for x in ("before", "s1", "busy", "manual")}
    assert all(d["params"]["removeFromClient"] == "true" and d["params"]["blocklist"] == "false"
               for d in sonarr.queue_deleted)
    assert all(f["deleteFiles"] == "true" for f in qbit.called("/torrents/delete"))


async def test_undo_with_a_started_search_still_reverts(api, sonarr):
    """A running command can't be cancelled (the arr answers 400): the undo
    goes on — monitoring is restored so nothing re-grabs."""
    s, e = the_show(sonarr)
    token = (await get_season(api)).json()["undo"]
    (cmd,) = [c for c in sonarr.commands.values() if c["name"] == "SeasonSearch"]
    sonarr.set_command_status(cmd["id"], "started")
    r = await api.delete(f"/api/news/search/{token}")
    assert r.status_code == 200 and r.json()["status"] == "reverted"
    assert sonarr.commands[cmd["id"]]["status"] == "started"
    assert sonarr.titles[s["id"]]["monitored"] is False


async def test_repeated_undo_gives_the_same_answer(api, sonarr):
    the_show(sonarr)
    token = (await get_season(api)).json()["undo"]
    first = await api.delete(f"/api/news/search/{token}")
    n = len(sonarr.calls)
    second = await api.delete(f"/api/news/search/{token}")
    assert first.json() == second.json()
    assert len(sonarr.calls) == n


async def test_unknown_token_is_410(api, sonarr):
    the_show(sonarr)
    await get_season(api)
    r = await api.delete("/api/news/search/" + "x" * 22)
    assert r.status_code == 410
    assert r.json() == {"error": "undo_expired", "detail": "this can no longer be undone"}
    assert sonarr.titles[next(iter(sonarr.titles))]["monitored"] is True


async def test_add_token_is_not_a_search_token(api, sonarr):
    sonarr.add_catalog(series_obj(1, "Dark"))
    add = await api.post("/api/library", json={"id": "1", "type": "tv"})
    r = await api.delete(f"/api/news/search/{add.json()['undo']}")
    assert r.status_code == 410


async def test_expired_token_is_410(api, sonarr, monkeypatch):
    clock = FakeClock(start=time.monotonic()).install(monkeypatch, undo_mod)
    s, _ = the_show(sonarr)
    token = (await get_season(api)).json()["undo"]
    clock.t += undo_mod.UNDO_TTL + 1
    r = await api.delete(f"/api/news/search/{token}")
    assert r.status_code == 410
    assert sonarr.titles[s["id"]]["monitored"] is True  # nothing reverted


@pytest.mark.parametrize("token", ["short", "x" * 65])
async def test_token_length_is_422(api, sonarr, token):
    r = await api.delete(f"/api/news/search/{token}")
    assert r.status_code == 422
    assert sonarr.calls == []


async def test_watcher_removes_a_late_grab_of_the_season(api, sonarr, qbit, monkeypatch, time_machine):
    clock = FakeClock(start=time.monotonic(), auto=False).install(monkeypatch, undo_mod)
    s, e = the_show(sonarr)
    sid = s["id"]
    token = (await get_season(api)).json()["undo"]
    (cmd,) = [c for c in sonarr.commands.values() if c["name"] == "SeasonSearch"]
    sonarr.set_command_status(cmd["id"], "started")
    assert (await api.delete(f"/api/news/search/{token}")).status_code == 200
    assert len(api.app_module.undo._tasks) == 1
    await clock.settle(50)  # let the freshly spawned watcher reach its first sleep
    assert clock.pending_sleepers == 1

    time_machine.move_to(NOW + timedelta(seconds=20), tick=False)
    sonarr.grab(sid, H("late"), episode_ids=[e[2, 1]])
    sonarr.grab(sid, H("other"), episode_ids=[e[1, 1]])
    torrent(qbit, "late")
    torrent(qbit, "other")
    await clock.advance(undo_mod.SWEEP_EVERY, settle=200)
    assert {r["downloadId"] for r in sonarr.queue} == {H("other")}
    assert set(qbit.torrents) == {make_hash("other")}

    sonarr.set_command_status(cmd["id"], "completed")
    for _ in range(round(undo_mod.SWEEP_QUIET / undo_mod.SWEEP_EVERY) + 2):
        await clock.advance(undo_mod.SWEEP_EVERY, settle=200)
    assert api.app_module.undo._tasks == set()
