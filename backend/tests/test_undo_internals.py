"""undo.py beyond the route tests — found by the T40 mutation pass
(tests/run_mutmut.sh undo): the actions journal (every library change is
logged to `reel_api.actions`, undo.py's own handler), the sweeper's exact
quiet period and what keeps it alive, the deferred removal's last look for
late grabs, revive keeping the original add's stamp, rows without a download
id, and the boundaries of the undo window and the Get's grab window."""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from reel_api import undo as undo_mod
from tests.support.arr import episode_obj, movie_obj, queue_record, season_obj, series_obj
from tests.support.clock import FakeClock
from tests.support.qbit import SimFile, SimTorrent, make_hash

NOW = datetime(2026, 6, 15, 12, 0, tzinfo=timezone.utc)
EVERY = undo_mod.SWEEP_EVERY


def H(seed: str) -> str:
    return make_hash(seed).upper()


def torrent(qbit, seed, category="radarr"):
    return qbit.add_torrent(SimTorrent(hash=make_hash(seed), name=seed, category=category,
                                       files=[SimFile(f"{seed}.mkv", 65536)]))


@pytest.fixture
def journal():
    """The messages logged to the actions journal (reel_api.actions does not
    propagate, so caplog can't see it)."""
    records: list[logging.LogRecord] = []

    class Keep(logging.Handler):
        def emit(self, record):
            records.append(record)

    lg = logging.getLogger("reel_api.actions")
    h = Keep(logging.DEBUG)
    lg.addHandler(h)
    yield lambda: [r.getMessage() for r in records]
    lg.removeHandler(h)


@pytest.fixture
def frozen(time_machine):
    time_machine.move_to(NOW, tick=False)
    return time_machine


@pytest.fixture
async def sweepers(api):
    yield
    for t in list(api.app_module.undo._tasks):
        t.cancel()
    await asyncio.sleep(0)


@pytest.fixture
def manual(monkeypatch, sweepers):
    return FakeClock(start=time.monotonic(), auto=False).install(monkeypatch, undo_mod)


async def add(api, media_id, kind="movie") -> str:
    r = await api.post("/api/library", json={"id": media_id, "type": kind})
    assert r.status_code == 202, r.text
    return r.json()["undo"]


async def undo(api, media_id, token, kind="movie"):
    return await api.delete(f"/api/library/{kind}/{media_id}", params={"undo": token})


def matrix(radarr):
    radarr.add_catalog(movie_obj(603, "The Matrix"))


def start_search(sim):
    search = next(c for c in sim.commands.values() if c["name"] in ("SeriesSearch", "MoviesSearch"))
    sim.set_command_status(search["id"], "started")
    return search


async def tick(clock, n=1):
    for _ in range(n):
        await clock.advance(EVERY, settle=200)


# ---------------------------------------------------------------- tokens


async def test_tokens_carry_16_random_bytes(api, radarr, sonarr, frozen):
    matrix(radarr)
    assert len(await add(api, "603")) == 22  # token_urlsafe(16)
    sonarr.add_series(series_obj(81189, "Breaking Bad", seasons=[season_obj(1, monitored=False)]),
                      [episode_obj(1, 1, air=NOW - timedelta(days=3), monitored=False)])
    r = await api.post("/api/news/search", json={"id": "81189", "season": 1})
    assert len(r.json()["undo"]) == 22


async def test_an_add_without_a_stamp_is_stamped_now_in_utc(api):
    ud = api.app_module.undo
    token = ud.remember_add("tv", "1", 5, "x", None)
    assert ud._adds[token].at.tzinfo is not None
    assert abs(ud._adds[token].at - datetime.now(timezone.utc)) < timedelta(seconds=5)


async def test_token_is_still_good_at_exactly_the_ttl(api, radarr, monkeypatch):
    """`age > UNDO_TTL` expires a token: at exactly 10 min it still undoes."""
    clock = FakeClock(start=time.monotonic()).install(monkeypatch, undo_mod)
    matrix(radarr)
    token = await add(api, "603")
    api.app_module.undo._adds[token].born = clock.t  # `born` is stamped by the real clock
    clock.t += undo_mod.UNDO_TTL
    assert (await undo(api, "603", token)).status_code == 200


# ---------------------------------------------------------------- refusals: body + journal


async def test_refusals_name_their_reason(api, radarr, journal, frozen):
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    token = await add(api, "603")
    m = radarr.title(603)
    m["tmdbId"] = 604  # the entry became another title
    r = await undo(api, "603", token)
    detail = "the library entry is no longer the title that was added"
    assert r.status_code == 409 and r.json() == {"error": "not_ours", "detail": detail}
    m["tmdbId"] = 603
    m["added"] = (NOW - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    r = await undo(api, "603", token)
    assert r.json() == {"error": "not_ours", "detail": "that title was in the library before this add"}
    assert [m for m in journal() if m.startswith("refused")] == [
        f"refused DELETE /api/library/movie/603: {detail}",
        "refused DELETE /api/library/movie/603: that title was in the library before this add",
    ]


async def test_added_exactly_at_the_skew_edge_is_ours(api, radarr, frozen):
    """`added < at - SKEW` is someone else's: exactly SKEW earlier still counts as this add."""
    matrix(radarr)
    token = await add(api, "603")
    radarr.title(603)["added"] = (NOW - undo_mod.SKEW).strftime("%Y-%m-%dT%H:%M:%SZ")
    assert (await undo(api, "603", token)).json()["status"] == "removed"


async def test_importing_refusal_names_the_title(api, radarr):
    matrix(radarr)
    token = await add(api, "603")
    radarr.grab(radarr.title(603)["id"], H("imp"), state="importing")
    r = await undo(api, "603", token)
    assert r.json() == {"error": "importing", "detail": "“The Matrix” is being imported right now"}


# ---------------------------------------------------------------- undo add: journal


async def test_undo_add_journal_and_purge_line(api, radarr, qbit, journal):
    matrix(radarr)
    token = await add(api, "603")
    mid = radarr.title(603)["id"]
    radarr.grab(mid, H("a"))
    radarr.grab(mid, H("b"))
    torrent(qbit, "a")
    torrent(qbit, "b")
    assert (await undo(api, "603", token)).json()["status"] == "removed"
    (purge,) = [m for m in journal() if m.startswith("undo: deleted")]
    shown = sorted(purge.split(": ", 2)[2].split(", "))
    assert purge.startswith("undo: deleted 2 torrent(s) with data from qBittorrent: ")
    assert shown == sorted([make_hash("a")[:8], make_hash("b")[:8]])
    assert journal()[-1] == f"undo add: movie 603 (The Matrix, arr id {mid}): 2 grab(s) removed, title removed"


async def test_qbit_cleanup_failures_are_journalled(api, radarr, sonarr, qbit, journal, frozen, sweepers):
    matrix(radarr)
    token = await add(api, "603")
    radarr.grab(radarr.title(603)["id"], H("a"))
    torrent(qbit, "a")
    qbit.fail("/torrents/info", exc=httpx.ConnectError("qb gone"))
    assert (await undo(api, "603", token)).status_code == 200
    # a cancel
    m = radarr.add_movie(movie_obj(5, "Alien"))
    radarr.grab(m["id"], H("c"))
    torrent(qbit, "c")
    qbit.fail("/torrents/info", exc=httpx.ConnectError("qb gone"))
    assert (await api.delete("/api/activity/movie/5")).status_code == 200
    # an undo Get
    s = sonarr.add_series(series_obj(81189, "Breaking Bad", seasons=[season_obj(1, monitored=False)]),
                          [episode_obj(1, 1, air=NOW - timedelta(days=3), monitored=False)])
    gtok = (await api.post("/api/news/search", json={"id": "81189", "season": 1})).json()["undo"]
    sonarr.grab(s["id"], H("g"), episode_ids=[sonarr.episodes_of(s["id"])[0]["id"]])
    torrent(qbit, "g", category="tv-sonarr")
    qbit.fail("/torrents/info", exc=httpx.ConnectError("qb gone"))
    assert (await api.delete(f"/api/news/search/{gtok}")).status_code == 200
    failed = [m for m in journal() if "cleanup failed" in m]
    assert [m.split(": ", 1)[0] for m in failed] == ["undo add", "cancel", "undo get"]
    for m in failed:
        assert m.split(": ", 1)[1].startswith("qBittorrent cleanup failed: ")
        assert "qb gone" in m


async def test_without_qbittorrent_purge_is_skipped(make_api, radarr, journal, upstream):
    """Without QBIT_URL there is no qBittorrent client: the undo removes the
    arr's queue rows and nothing else."""
    async with make_api(QBIT_URL=None) as api:
        assert api.app_module.undo.qb is None
        matrix(radarr)
        token = await add(api, "603")
        radarr.grab(radarr.title(603)["id"], H("a"))
        assert (await undo(api, "603", token)).json()["downloads_removed"] == 1
    assert not any("cleanup failed" in m for m in journal())


async def test_undo_with_no_grabs_never_asks_qbittorrent(api, radarr, qbit):
    """An empty hash list must not reach torrents/info (which would list every torrent)."""
    matrix(radarr)
    token = await add(api, "603")
    torrent(qbit, "unrelated")
    assert (await undo(api, "603", token)).json()["status"] == "removed"
    assert qbit.called("/torrents/info") == []
    assert make_hash("unrelated") in qbit.torrents


# ---------------------------------------------------------------- commands of other titles


async def test_other_titles_commands_neither_block_nor_get_cancelled(api, radarr):
    matrix(radarr)
    token = await add(api, "603")
    mid = radarr.title(603)["id"]
    radarr.finish_commands()
    other_running = radarr.add_command("MoviesSearch", {"movieIds": [mid + 100]}, status="started")
    other_queued = radarr.add_command("RefreshMovie", {"movieIds": [mid + 100]})
    r = await undo(api, "603", token)
    assert r.json()["status"] == "removed"
    assert radarr.commands[other_queued["id"]]["status"] == "queued"
    assert radarr.commands[other_running["id"]]["status"] == "started"


async def test_a_started_search_is_not_asked_to_cancel(api, radarr):
    matrix(radarr)
    token = await add(api, "603")
    search = start_search(radarr)
    await undo(api, "603", token)
    assert radarr.called(f"/api/v3/command/{search['id']}", "DELETE") == []


# ---------------------------------------------------------------- the sweeper


async def test_sweeper_timeline(api, radarr, qbit, journal, manual):
    """Late grab removed once; the title is deleted exactly SWEEP_QUIET after
    the first quiet look; a never-ending command of another title doesn't
    count; every step is journalled."""
    matrix(radarr)
    token = await add(api, "603")
    mid = radarr.title(603)["id"]
    search = start_search(radarr)
    radarr.add_command("MoviesSearch", {"movieIds": [mid + 100]}, status="started")
    assert (await undo(api, "603", token)).json()["status"] == "removing"
    assert journal()[-1] == f"undo add: movie 603 (The Matrix, arr id {mid}): 0 grab(s) removed, title removing"
    await manual.settle(50)

    radarr.grab(mid, H("late"))
    torrent(qbit, "late")
    await tick(manual)  # t=5
    assert journal()[-2:] == ["undo: deleted 1 torrent(s) with data from qBittorrent: " + make_hash("late")[:8],
                              "undo sweep (add movie:603): removed 1 late grab(s)"]
    await tick(manual)  # t=10: the same grab is not removed twice
    assert sum("late grab(s)" in m for m in journal()) == 1

    radarr.set_command_status(search["id"], "completed")
    await tick(manual)  # t=15: first quiet look
    await tick(manual, 2)  # t=20, 25
    assert radarr.deleted == []
    await tick(manual)  # t=30: quiet for SWEEP_QUIET
    assert [d["id"] for d in radarr.deleted] == [mid]
    assert journal()[-2:] == [
        "undo sweep (add movie:603) done after 30 s",
        "undo add movie:603: title deleted after its commands finished (0 late grab(s))",
    ]


async def test_sweeper_keeps_going_after_a_blip(api, radarr, journal, manual):
    matrix(radarr)
    token = await add(api, "603")
    start_search(radarr)
    await undo(api, "603", token)
    await manual.settle(50)
    radarr.fail("/api/v3/history/since", status=500)
    await tick(manual)
    assert journal()[-1] == "undo sweep (add movie:603): movie HTTP 500"
    await tick(manual, 6)  # the search still runs: nothing deleted, still watching
    assert radarr.deleted == [] and len(api.app_module.undo._tasks) == 1


async def test_revived_title_keeps_its_new_grabs_and_its_add_stamp(api, sonarr, qbit, journal, manual, frozen):
    """Re-added while the removal waited: the watcher stands down (a grab of
    the revived search stays), and the fresh token still undoes the add later
    — the title's `added` stamp is the original add's, not the revive's."""
    sonarr.add_catalog(series_obj(81189, "Breaking Bad", seasons=[season_obj(1)]),
                       [episode_obj(1, i) for i in (1, 2)])
    token = await add(api, "81189", "tv")
    sid = sonarr.title(81189)["id"]
    start_search(sonarr)
    assert (await undo(api, "81189", token, "tv")).json()["status"] == "removing"
    await manual.settle(50)

    frozen.move_to(NOW + timedelta(seconds=60), tick=False)
    r = await api.post("/api/library", json={"id": "81189", "type": "tv"})
    new_token = r.json()["undo"]
    assert journal()[-1] == "undo add tv:81189: re-added before the removal ran — kept"
    eps = [e["id"] for e in sonarr.episodes_of(sid)]
    sonarr.grab(sid, H("kept"), episode_ids=eps)
    torrent(qbit, "kept", category="tv-sonarr")
    await tick(manual, 2)
    assert "undo sweep (add tv:81189) done after 5 s" in journal()  # stood down at its next look
    assert {r["downloadId"] for r in sonarr.queue} == {H("kept")}
    assert make_hash("kept") in qbit.torrents

    sonarr.finish_commands()
    r = await undo(api, "81189", new_token, "tv")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "removed"


# ---------------------------------------------------------------- the deferred removal's last look


def _pending(api, radarr, mid, *, revived=False):
    ud = api.app_module.undo
    u = undo_mod._Add("movie", "603", mid, "The Matrix", NOW)
    u.revived = revived
    return ud, ud.arr["movie"], u


async def test_last_look_removes_grabs_the_watcher_missed(api, radarr, qbit, journal, frozen):
    m = radarr.add_movie(movie_obj(603, "The Matrix"), added=NOW)
    other = radarr.add_movie(movie_obj(5, "Alien"), added=NOW)
    radarr.grab(m["id"], H("late"))
    radarr.grab(other["id"], H("other"))
    torrent(qbit, "late")
    torrent(qbit, "other")
    ud, client, u = _pending(api, radarr, m["id"])
    await ud._finish_add_now(client, u, NOW - undo_mod.SKEW, set(), "add movie:603")
    assert {r["downloadId"] for r in radarr.queue} == {H("other")}
    assert set(qbit.torrents) == {make_hash("other")}
    assert [d["id"] for d in radarr.deleted] == [m["id"]]
    assert journal()[-1] == "undo add movie:603: title deleted after its commands finished (1 late grab(s))"


async def test_last_look_without_late_grabs_reads_no_queue(api, radarr, frozen):
    m = radarr.add_movie(movie_obj(603, "The Matrix"), added=NOW)
    radarr.grab(m["id"], H("seen"))
    ud, client, u = _pending(api, radarr, m["id"])
    n = radarr.count("/api/v3/queue")
    await ud._finish_add_now(client, u, NOW - undo_mod.SKEW, {H("seen")}, "add movie:603")
    assert radarr.count("/api/v3/queue") == n
    assert [d["id"] for d in radarr.deleted] == [m["id"]]


async def test_last_look_journals_files_and_failures(api, radarr, journal, frozen):
    m = radarr.add_movie(movie_obj(603, "The Matrix"), added=NOW)
    ud, client, u = _pending(api, radarr, m["id"])
    m["hasFile"] = True
    await ud._finish_add_now(client, u, NOW, set(), "add movie:603")
    assert journal()[-1] == "undo add movie:603: files appeared meanwhile — left in the library, unmonitored"
    radarr.fail("/api/v3/movie/{id}", status=500)
    await ud._finish_add_now(client, u, NOW, set(), "add movie:603")
    assert journal()[-1] == "undo add movie:603: could not finish: movie HTTP 500"
    assert radarr.deleted == []


# ---------------------------------------------------------------- cancel


async def test_cancel_journal_counts_downloads_not_rows(api, sonarr, qbit, journal):
    s = sonarr.add_series(series_obj(81189, "Breaking Bad", seasons=[season_obj(1)]),
                          [episode_obj(1, i) for i in (1, 2, 3)])
    eps = [e["id"] for e in sonarr.episodes_of(s["id"])]
    sonarr.grab(s["id"], H("pack"), episode_ids=eps)
    torrent(qbit, "pack", category="tv-sonarr")
    r = await api.delete("/api/activity/tv/81189", params={"season": 1})
    assert r.status_code == 200
    assert journal()[-1] == "cancel tv 81189 season=1 episode=None: 1 download(s), 3 unmonitored, blocklist=False"


async def test_rows_without_download_id_are_not_one_download(api, radarr, journal):
    a = radarr.add_movie(movie_obj(5, "Alien"))
    b = radarr.add_movie(movie_obj(6, "Aliens"))
    radarr.grab(a["id"], None, history=False)
    radarr.grab(b["id"], None, history=False)
    r = await api.delete("/api/activity/movie/5", params={"blocklist": "true"})
    assert r.status_code == 200 and r.json()["downloads_removed"] == 1
    assert [q["movieId"] for q in radarr.queue] == [b["id"]]
    assert journal()[-1] == "cancel movie 5 season=None episode=None: 1 download(s), 1 unmonitored, blocklist=True"


async def test_importing_row_without_download_id_keeps_only_itself(api, radarr):
    a = radarr.add_movie(movie_obj(5, "Alien"))
    radarr.grab(a["id"], None, history=False, state="importing")
    radarr.grab(a["id"], None, history=False)
    r = await api.delete("/api/activity/movie/5")
    assert r.status_code == 200, r.text
    assert r.json()["kept"] == 1 and r.json()["downloads_removed"] == 1
    assert [q["trackedDownloadState"] for q in radarr.queue] == ["importing"]


async def test_status_stands_in_for_a_missing_tracked_state(api, radarr):
    a = radarr.add_movie(movie_obj(5, "Alien"))
    radarr.grab(a["id"], H("x"), state=None, status="importing")
    r = await api.delete("/api/activity/movie/5")
    assert r.status_code == 409
    assert r.json() == {"error": "importing", "detail": "already being imported into the library"}


async def test_cancelled_episodes_sort_missing_numbers_first(api, sonarr, monkeypatch):
    """An episode the arr sends without a season/episode number sorts as 0
    (season 6 makes the set's iteration order disagree with that)."""
    s = sonarr.add_series(series_obj(81189, "Breaking Bad", seasons=[season_obj(n) for n in (1, 2, 6)]),
                          [episode_obj(1, 1), episode_obj(1, 2), episode_obj(2, 5),
                           episode_obj(6, 1), episode_obj(6, 2)])
    sonarr.grab(s["id"], H("all"), episode_ids=[e["id"] for e in sonarr.episodes_of(s["id"])])
    client = api.app_module.undo.arr["tv"]
    real = client.queue_records

    async def records():
        rows = await real()
        for r in rows:
            ep = r["episode"]
            key = (ep["seasonNumber"], ep["episodeNumber"])
            if key == (6, 2):
                del ep["episodeNumber"]
            elif key == (2, 5):
                del ep["seasonNumber"]
        return rows

    monkeypatch.setattr(client, "queue_records", records)
    res = await api.app_module.undo.cancel("tv", "81189")
    assert [(e["season"], e["episode"]) for e in res["episodes"]] == [
        (None, 5), (1, 1), (1, 2), (6, None), (6, 1)]


async def test_cancel_of_one_episode_is_journalled(api, sonarr, journal):
    s = sonarr.add_series(series_obj(81189, "Breaking Bad", seasons=[season_obj(1)]),
                          [episode_obj(1, i) for i in (1, 2)])
    sonarr.grab(s["id"], H("e2"), episode_ids=[sonarr.episode(s["id"], 1, 2)["id"]])
    r = await api.delete("/api/activity/tv/81189", params={"season": 1, "episode": 2})
    assert r.status_code == 200
    assert journal()[-1] == "cancel tv 81189 season=1 episode=2: 1 download(s), 1 unmonitored, blocklist=False"


# ---------------------------------------------------------------- undo Get


@pytest.fixture
def season2(sonarr, frozen):
    s = sonarr.add_series(series_obj(81189, "Breaking Bad", monitored=False,
                                     seasons=[season_obj(1), season_obj(2, monitored=False)]),
                          [episode_obj(1, 1, has_file=True, air=NOW - timedelta(days=700)),
                           episode_obj(2, 1, air=NOW - timedelta(days=3), monitored=False),
                           episode_obj(2, 2, air=NOW - timedelta(days=2), monitored=False)])
    e = {(x["seasonNumber"], x["episodeNumber"]): x["id"] for x in sonarr.episodes_of(s["id"])}
    return s, e


async def get_then(api, frozen, at: timedelta):
    token = (await api.post("/api/news/search", json={"id": "81189", "season": 2})).json()["undo"]
    frozen.move_to(NOW + at, tick=False)
    return token


async def test_get_window_starts_skew_before_the_search(api, sonarr, season2, frozen, journal, sweepers):
    s, e = season2
    sid = s["id"]
    other = sonarr.add_series(series_obj(2, "Other", seasons=[season_obj(1)]), [episode_obj(1, 1)])
    sonarr.grab(other["id"], H("other"), episode_ids=[sonarr.episodes_of(other["id"])[0]["id"]])
    token = await get_then(api, frozen, timedelta(seconds=1))
    sonarr.grab(sid, H("soon"), episode_ids=[e[2, 1]], date=NOW + timedelta(seconds=1))
    # queued exactly SKEW before the search, without grab history
    sonarr.grab(sid, H("edge"), episode_ids=[e[2, 2]], history=False, date=NOW - undo_mod.SKEW)
    # in the grab history, but the queue row lacks its `added` stamp
    (row,) = sonarr.grab(sid, H("nostamp"), episode_ids=[e[2, 2]])
    row["added"] = None
    r = await api.delete(f"/api/news/search/{token}")
    assert r.json()["downloads_removed"] == 3
    assert {q["downloadId"] for q in sonarr.queue} == {H("other")}
    assert journal()[-1] == (f"undo get: Breaking Bad season 2 (series {sid}): monitoring restored, "
                             "3 grab(s) removed, 0 kept (importing)")


async def test_get_watcher_does_not_redo_the_undos_removals(api, sonarr, qbit, season2, frozen, journal,
                                                            manual):
    s, e = season2
    token = await get_then(api, frozen, timedelta(seconds=10))
    sonarr.grab(s["id"], H("g"), episode_ids=[e[2, 1]])
    torrent(qbit, "g", category="tv-sonarr")
    assert (await api.delete(f"/api/news/search/{token}")).json()["downloads_removed"] == 1
    await manual.settle(50)
    n = len(journal())
    await tick(manual, 4)  # t=5 first quiet look, quiet for 15 s at t=20
    assert journal()[n:] == ["undo sweep (get 81189:2) done after 20 s"]
    assert api.app_module.undo._tasks == set()
