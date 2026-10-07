"""DELETE /api/library/{type}/{id}?undo=TOKEN: undo one add (undo.Undo.undo_add,
revive_add, the deferred removal _finish_add + its sweeper _watch, and
app._mark_removed). The hard rule, checked after every test by conftest's
arr_deletes_keep_files: a title DELETE to an arr carries deleteFiles=false
(an undo never sends anything else) and no import-list exclusion."""

import asyncio
import time
from datetime import timedelta

import pytest

from reel_api import undo as undo_mod
from reel_api.models import LibraryUndoResult
from tests.support.arr import episode_obj, movie_obj, now_utc, season_obj, series_obj
from tests.support.clock import FakeClock
from tests.support.qbit import SimFile, SimTorrent, make_hash

LOOKUP = "/api/v3/series/lookup"


def H(seed: str) -> str:
    return make_hash(seed).upper()


@pytest.fixture
async def stop_sweepers(api):
    """Cancel undo watchers still waiting on a manual clock at teardown."""
    yield
    for t in list(api.app_module.undo._tasks):
        t.cancel()
    await asyncio.sleep(0)


def show_catalog(sonarr, tvdb=81189, title="Breaking Bad", eps=3):
    sonarr.add_catalog(series_obj(tvdb, title, seasons=[season_obj(1)]),
                       [episode_obj(1, i) for i in range(1, eps + 1)])


async def add(api, media_id, kind="tv"):
    r = await api.post("/api/library", json={"id": media_id, "type": kind})
    assert r.status_code == 202, r.text
    return r.json()["undo"]


async def undo(api, media_id, token, kind="tv"):
    return await api.delete(f"/api/library/{kind}/{media_id}", params={"undo": token})


async def lookup(api, q, kind="tv"):
    r = await api.get("/api/lookup", params={"q": q, "type": kind})
    assert r.status_code == 200, r.text
    return {x["id"]: x["added"] for x in r.json()["results"]}


def start_search(sim):
    """The add's search command is running (cannot be cancelled any more)."""
    search = next(c for c in sim.commands.values() if c["name"] in ("SeriesSearch", "MoviesSearch"))
    sim.set_command_status(search["id"], "started")
    return search


async def sweep(clock, seconds):
    """Advance the manual clock one sweep period at a time, letting the
    sweeper's HTTP calls finish before the next deadline (a single big
    advance would skip the periods it hadn't re-armed yet)."""
    steps = max(1, round(seconds / undo_mod.SWEEP_EVERY))
    for _ in range(steps):
        await clock.advance(undo_mod.SWEEP_EVERY, settle=200)


def torrent(qbit, seed, category="tv-sonarr"):
    return qbit.add_torrent(SimTorrent(hash=make_hash(seed), name=seed, category=category,
                                       files=[SimFile(f"{seed}.mkv", 65536)]))


# ---------------------------------------------------------------- tokens


async def test_removed_right_away_when_no_command_runs(api, sonarr):
    show_catalog(sonarr)
    token = await add(api, "81189")
    sid = sonarr.title(81189)["id"]
    r = await undo(api, "81189", token)
    assert r.status_code == 200, r.text
    body = r.json()
    LibraryUndoResult.model_validate(body)
    assert body == {"id": "81189", "type": "tv", "title": "Breaking Bad", "status": "removed",
                    "downloads_removed": 0}
    assert sonarr.title(81189) is None
    assert [d["id"] for d in sonarr.deleted] == [sid]
    # the add's still-queued commands were cancelled, the series unmonitored first
    assert {c["status"] for c in sonarr.commands.values()} == {"cancelled"}
    put = sonarr.called(f"/api/v3/series/{sid}", "PUT")
    assert put and put[0].body["monitored"] is False


async def test_repeated_undo_gives_the_same_answer(api, radarr):
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    token = await add(api, "603", "movie")
    first = await undo(api, "603", token, "movie")
    n = len(radarr.calls)
    second = await undo(api, "603", token, "movie")
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert first.json()["status"] == "removed"
    assert len(radarr.calls) == n  # answered from the remembered result


@pytest.mark.parametrize("which", ["unknown", "other_title", "other_type"])
async def test_wrong_or_unknown_token_is_410(api, sonarr, radarr, which):
    show_catalog(sonarr)
    show_catalog(sonarr, tvdb=121361, title="Game of Thrones")
    token = await add(api, "81189")
    await add(api, "121361")
    path = {"unknown": ("tv", "81189", "x" * 22), "other_title": ("tv", "121361", token),
            "other_type": ("movie", "81189", token)}[which]
    kind, mid, tok = path
    r = await undo(api, mid, tok, kind)
    assert r.status_code == 410
    assert r.json() == {"error": "undo_expired", "detail": "this can no longer be undone"}
    assert sonarr.deleted == [] and radarr.deleted == []
    assert sonarr.title(81189)["monitored"] is True


async def test_token_older_than_ttl_is_410(api, sonarr, monkeypatch):
    clock = FakeClock(start=time.monotonic()).install(monkeypatch, undo_mod)
    show_catalog(sonarr)
    token = await add(api, "81189")
    clock.t += undo_mod.UNDO_TTL - 5
    show_catalog(sonarr, tvdb=2, title="Other")
    other = await add(api, "2")
    assert (await undo(api, "2", other)).status_code == 200  # inside the TTL
    clock.t += 10  # the first token is now older than UNDO_TTL
    r = await undo(api, "81189", token)
    assert r.status_code == 410
    assert sonarr.title(81189) is not None
    assert token not in api.app_module.undo._adds  # pruned


@pytest.mark.parametrize("path, params", [
    ("/api/library/tv/81189", {"undo": "short"}),
    ("/api/library/tv/81189", {"undo": "x" * 65}),
    ("/api/library/tv/abc", {"undo": "x" * 22}),
    ("/api/library/tv/12345678901", {"undo": "x" * 22}),
    ("/api/library/music/1", {"undo": "x" * 22}),
])
async def test_validation_is_422(api, sonarr, path, params):
    r = await api.delete(path, params=params)
    assert r.status_code == 422
    assert sonarr.calls == []


async def test_without_a_token_is_400_never_a_delete(api, sonarr):
    """A client that lost its token (qs() drops a null) must not fall through
    to delete_files: neither parameter is a 400 (it was a 422 before
    DELETE /api/library also took delete_files=true)."""
    r = await api.delete("/api/library/tv/81189")
    assert r.status_code == 400
    assert r.json() == {"error": "bad_request", "detail": "pass either undo=<token> or delete_files=true"}
    assert sonarr.calls == []


async def test_unconfigured_type_is_503(make_api, radarr):
    async with make_api(RADARR_API_KEY=None) as api:
        r = await undo(api, "603", "x" * 22, "movie")
    assert r.status_code == 503 and r.json()["error"] == "not_available"


# ---------------------------------------------------------------- refusals


async def test_entry_replaced_by_another_title_is_409_not_ours(api, sonarr):
    show_catalog(sonarr)
    token = await add(api, "81189")
    sonarr.title(81189)["tvdbId"] = 4242  # the arr id now names a different series
    r = await undo(api, "81189", token)
    assert r.status_code == 409
    assert r.json()["error"] == "not_ours"
    assert sonarr.deleted == []


async def test_title_added_before_this_add_is_409_not_ours(api, radarr):
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    token = await add(api, "603", "movie")
    radarr.title(603)["added"] = (now_utc() - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    r = await undo(api, "603", token, "movie")
    assert r.status_code == 409 and r.json()["error"] == "not_ours"
    assert radarr.deleted == []
    assert radarr.title(603)["monitored"] is True  # refusals change nothing


async def test_added_stamp_within_skew_is_ours(api, radarr):
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    token = await add(api, "603", "movie")
    radarr.title(603)["added"] = (now_utc() - timedelta(seconds=3)).strftime("%Y-%m-%dT%H:%M:%SZ")
    assert (await undo(api, "603", token, "movie")).json()["status"] == "removed"


@pytest.mark.parametrize("kind", ["tv", "movie"])
async def test_has_files_is_409(api, sonarr, radarr, kind):
    if kind == "tv":
        show_catalog(sonarr)
        token = await add(api, "81189")
        s = sonarr.title(81189)
        sonarr.episode(s["id"], 1, 2)["hasFile"] = True
        mid, sim = "81189", sonarr
    else:
        radarr.add_catalog(movie_obj(603, "The Matrix"))
        token = await add(api, "603", "movie")
        radarr.title(603)["hasFile"] = True
        mid, sim = "603", radarr
    r = await undo(api, mid, token, kind)
    assert r.status_code == 409 and r.json()["error"] == "has_files"
    assert sim.deleted == [] and sim.queue_deleted == []


# importPending / importBlocked hold a finished download the arr is (or is waiting to be)
# importing — never deleted, the same "importing" the activity feed shows for them.
@pytest.mark.parametrize("state", ["importing", "importPending", "importBlocked"])
async def test_importing_grab_is_409(api, radarr, qbit, state):
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    token = await add(api, "603", "movie")
    m = radarr.title(603)
    radarr.grab(m["id"], H("m"), state=state)
    torrent(qbit, "m", category="radarr")
    r = await undo(api, "603", token, "movie")
    assert r.status_code == 409 and r.json()["error"] == "importing"
    assert radarr.deleted == [] and radarr.queue_deleted == []
    assert make_hash("m") in qbit.torrents
    assert radarr.title(603)["monitored"] is True


async def test_already_removed(api, sonarr):
    show_catalog(sonarr)
    token = await add(api, "81189")
    del sonarr.titles[sonarr.title(81189)["id"]]  # removed in the Sonarr UI meanwhile
    r = await undo(api, "81189", token)
    assert r.status_code == 200
    assert r.json()["status"] == "already_removed" and r.json()["downloads_removed"] == 0
    assert sonarr.deleted == []


# ---------------------------------------------------------------- grabs


async def test_grabs_removed_from_arr_and_qbit(api, sonarr, qbit):
    show_catalog(sonarr)
    token = await add(api, "81189")
    s = sonarr.title(81189)
    eps = [e["id"] for e in sonarr.episodes_of(s["id"])]
    sonarr.grab(s["id"], H("pack"), episode_ids=eps)
    # grabbed (history) but not yet in the arr's queue
    sonarr.add_history("grabbed", download_id=H("late"), series_id=s["id"], episode_id=eps[0])
    torrent(qbit, "pack")
    torrent(qbit, "late")
    torrent(qbit, "unrelated")
    torrent(qbit, "manual", category="reel")
    sonarr.add_history("grabbed", download_id=H("manual"), series_id=s["id"], episode_id=eps[0])

    r = await undo(api, "81189", token)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "removed"
    assert r.json()["downloads_removed"] == 3  # pack + late + manual (counted, but kept)
    assert sonarr.queue == []
    assert len(sonarr.queue_deleted) == 1  # one DELETE per torrent
    assert sonarr.queue_deleted[0]["params"] == {"removeFromClient": "true", "blocklist": "false",
                                                 "skipRedownload": "true"}
    assert set(qbit.torrents) == {make_hash("unrelated"), make_hash("manual")}
    forms = qbit.called("/torrents/delete")
    assert forms and all(f["deleteFiles"] == "true" for f in forms)


async def test_grab_of_an_older_add_is_not_removed(api, radarr, qbit):
    """History before this add (minus SKEW) belongs to someone else."""
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    token = await add(api, "603", "movie")
    m = radarr.title(603)
    radarr.add_history("grabbed", download_id=H("old"), movie_id=m["id"],
                       date=now_utc() - timedelta(minutes=5))
    torrent(qbit, "old", category="radarr")
    r = await undo(api, "603", token, "movie")
    assert r.json()["downloads_removed"] == 0
    assert make_hash("old") in qbit.torrents


async def test_qbit_failure_does_not_fail_the_undo(api, radarr, qbit):
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    token = await add(api, "603", "movie")
    radarr.grab(radarr.title(603)["id"], H("m"))
    qbit.fail("/torrents/info", status=500)
    r = await undo(api, "603", token, "movie")
    assert r.status_code == 200 and r.json()["status"] == "removed"


# ---------------------------------------------------------------- lookups


async def test_cached_lookups_flip_back_to_not_added(api, sonarr):
    show_catalog(sonarr, tvdb=1, title="Dark")
    show_catalog(sonarr, tvdb=2, title="Dark Matter")
    assert await lookup(api, "dark") == {"1": False, "2": False}
    token = await add(api, "1")
    await add(api, "2")
    n = sonarr.count(LOOKUP)
    assert await lookup(api, "dark") == {"1": True, "2": True}
    assert (await undo(api, "1", token)).status_code == 200
    assert await lookup(api, "dark") == {"1": False, "2": True}
    assert sonarr.count(LOOKUP) == n  # the cached answer was patched, not refetched
    assert ("tv", "1") not in api.app_module._recent_adds


# ---------------------------------------------------------------- deferred removal


async def test_running_search_defers_the_removal(api, radarr, qbit, monkeypatch, stop_sweepers):
    clock = FakeClock(start=time.monotonic(), auto=False).install(monkeypatch, undo_mod)
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    token = await add(api, "603", "movie")
    mid = radarr.title(603)["id"]
    search = start_search(radarr)

    r = await undo(api, "603", token, "movie")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "removing"
    # unmonitored at once, the queued refresh cancelled, the title still there
    assert radarr.title(603)["monitored"] is False
    refresh = next(c for c in radarr.commands.values() if c["name"] == "RefreshMovie")
    assert refresh["status"] == "cancelled"
    assert radarr.deleted == []

    # the running search grabs something after the undo: the sweeper removes it
    await sweep(clock, undo_mod.SWEEP_EVERY)
    radarr.grab(mid, H("late"))
    torrent(qbit, "late", category="radarr")
    await sweep(clock, undo_mod.SWEEP_EVERY)
    assert radarr.queue == []
    assert make_hash("late") not in qbit.torrents
    assert radarr.deleted == []  # still waiting for the search to end

    radarr.set_command_status(search["id"], "completed")
    await clock.advance(undo_mod.SWEEP_EVERY)  # first quiet look
    assert radarr.deleted == []
    await sweep(clock, undo_mod.SWEEP_QUIET + undo_mod.SWEEP_EVERY)
    assert [d["id"] for d in radarr.deleted] == [mid]
    assert api.app_module.undo._tasks == set()
    # a repeated undo still answers the remembered result
    assert (await undo(api, "603", token, "movie")).json()["status"] == "removing"


async def test_sweeper_gives_up_waiting_at_sweep_max(api, sonarr, monkeypatch, stop_sweepers):
    clock = FakeClock(start=time.monotonic(), auto=False).install(monkeypatch, undo_mod)
    show_catalog(sonarr)
    token = await add(api, "81189")
    sid = sonarr.title(81189)["id"]
    start_search(sonarr)  # never finishes
    assert (await undo(api, "81189", token)).json()["status"] == "removing"
    await sweep(clock, undo_mod.SWEEP_MAX - undo_mod.SWEEP_EVERY)
    assert sonarr.deleted == []
    await sweep(clock, 2 * undo_mod.SWEEP_EVERY)
    assert [d["id"] for d in sonarr.deleted] == [sid]


async def test_sweeper_survives_an_arr_blip(api, radarr, monkeypatch, stop_sweepers):
    clock = FakeClock(start=time.monotonic(), auto=False).install(monkeypatch, undo_mod)
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    token = await add(api, "603", "movie")
    search = start_search(radarr)
    assert (await undo(api, "603", token, "movie")).json()["status"] == "removing"
    radarr.fail("/api/v3/history/since", status=500)
    await sweep(clock, undo_mod.SWEEP_EVERY)
    radarr.set_command_status(search["id"], "completed")
    await sweep(clock, undo_mod.SWEEP_QUIET + 3 * undo_mod.SWEEP_EVERY)
    assert len(radarr.deleted) == 1


async def test_files_appearing_meanwhile_keep_the_title(api, radarr, monkeypatch, stop_sweepers):
    clock = FakeClock(start=time.monotonic(), auto=False).install(monkeypatch, undo_mod)
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    token = await add(api, "603", "movie")
    search = start_search(radarr)
    assert (await undo(api, "603", token, "movie")).json()["status"] == "removing"
    radarr.title(603)["hasFile"] = True
    radarr.set_command_status(search["id"], "completed")
    await sweep(clock, undo_mod.SWEEP_QUIET + 3 * undo_mod.SWEEP_EVERY)
    assert api.app_module.undo._tasks == set()
    assert radarr.deleted == []
    assert radarr.title(603) is not None


async def test_re_add_while_removing_revives(api, sonarr, monkeypatch, stop_sweepers):
    clock = FakeClock(start=time.monotonic(), auto=False).install(monkeypatch, undo_mod)
    show_catalog(sonarr)
    token = await add(api, "81189")
    sid = sonarr.title(81189)["id"]
    search = start_search(sonarr)
    assert (await undo(api, "81189", token)).json()["status"] == "removing"
    n_posts = sonarr.count("/api/v3/series", "POST")

    r = await api.post("/api/library", json={"id": "81189", "type": "tv"})
    assert r.status_code == 202, r.text
    body = r.json()
    new_token = body.pop("undo")
    assert body == {"id": "81189", "type": "tv", "title": "Breaking Bad", "status": "added"}
    assert new_token and new_token != token
    assert sonarr.count("/api/v3/series", "POST") == n_posts  # not added a second time
    assert sonarr.title(81189)["monitored"] is True
    searches = [c for c in sonarr.commands.values() if c["name"] == "SeriesSearch"]
    assert len(searches) == 2 and searches[-1]["body"]["seriesId"] == sid

    # the deferred removal stands down
    sonarr.set_command_status(search["id"], "completed")
    sonarr.finish_commands()
    await sweep(clock, undo_mod.SWEEP_EVERY)
    await sweep(clock, undo_mod.SWEEP_QUIET + 2 * undo_mod.SWEEP_EVERY)
    assert api.app_module.undo._tasks == set()
    assert sonarr.deleted == []
    assert sonarr.title(81189) is not None
    # the cached lookup says added again
    assert await lookup(api, "breaking bad") == {"81189": True}
    # and the fresh token undoes the revived add
    assert (await undo(api, "81189", new_token)).json()["status"] == "removed"
    assert [d["id"] for d in sonarr.deleted] == [sid]


async def test_pending_removal_ignores_finished_and_revived(api, radarr, monkeypatch, stop_sweepers):
    clock = FakeClock(start=time.monotonic(), auto=False).install(monkeypatch, undo_mod)
    u = api.app_module.undo
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    token = await add(api, "603", "movie")
    search = start_search(radarr)
    assert (await undo(api, "603", token, "movie")).json()["status"] == "removing"
    assert u.pending_removal("movie", "603") is not None
    assert u.pending_removal("tv", "603") is None
    radarr.set_command_status(search["id"], "completed")
    await sweep(clock, undo_mod.SWEEP_QUIET + 3 * undo_mod.SWEEP_EVERY)
    assert u.pending_removal("movie", "603") is None  # finished
    # after the deferred removal, a new POST adds afresh (no revive)
    r = await api.post("/api/library", json={"id": "603", "type": "movie"})
    assert r.status_code == 202
    assert radarr.count("/api/v3/movie", "POST") == 2


async def test_remember_add_without_arr_id_gives_no_token(api):
    assert api.app_module.undo.remember_add("tv", "1", None, "x", None) is None
