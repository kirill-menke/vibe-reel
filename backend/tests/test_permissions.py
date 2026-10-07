"""Who may do what (design §9.1). Actors: K = kirill (admin), N = nicole and
Z = Zhenya (normal users). Titles: N's (added by N), K's (added by K) and L
(legacy: in the arr, never added through reel-api — the admins').

  delete with files    owner or admin
  cancel a grab        owner, the season's requester, or admin
  undo an add          the adder (their token) or admin
  Get a season         everyone; its undo: the requester or admin
  activity flags       mine / can_cancel per row for the caller

Every 403 leaves the arrs, qBittorrent and owners.json untouched."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from tests.conftest import NICOLE_TOKEN, TEST_AUTH, ZHENYA_TOKEN, auth_for
from tests.support.arr import episode_obj, movie_obj, season_obj, series_obj
from tests.support.qbit import SimFile, SimTorrent, make_hash

K, N, Z = TEST_AUTH, auth_for(NICOLE_TOKEN), auth_for(ZHENYA_TOKEN)
ACTORS = {"K": K, "N": N, "Z": Z}
MOVIE = {"N": "601", "K": "602", "L": "603"}
SHOW = {"N": "7001", "K": "7002", "L": "7003"}


def H(seed: str) -> str:
    return make_hash(seed).upper()


def _eps():
    long_ago = datetime.now(timezone.utc) - timedelta(days=400)
    aired = datetime.now(timezone.utc) - timedelta(days=3)
    return [episode_obj(1, 1, air=long_ago), episode_obj(1, 2, air=long_ago),
            episode_obj(2, 1, air=aired), episode_obj(2, 2, air=aired)]


async def _add(api, kind, mid, auth):
    r = await api.post("/api/library", json={"id": mid, "type": kind}, headers={"Authorization": auth})
    assert r.status_code == 202, r.text
    return r.json()["undo"]


@pytest.fixture
async def lib(api, sonarr, radarr, qbit, reel_env):
    radarr.add_catalog(movie_obj(601, "Nicole's movie"))
    radarr.add_catalog(movie_obj(602, "Kirill's movie"))
    radarr.add_movie(movie_obj(603, "Legacy movie"))
    for who in ("N", "K"):
        sonarr.add_catalog(series_obj(int(SHOW[who]), f"{who} show", seasons=[season_obj(1), season_obj(2)]), _eps())
    sonarr.add_series(series_obj(7003, "Legacy show", seasons=[season_obj(1), season_obj(2)]), _eps())
    tokens = {}
    for who in ("N", "K"):
        tokens[("movie", who)] = await _add(api, "movie", MOVIE[who], ACTORS[who])
        tokens[("tv", who)] = await _add(api, "tv", SHOW[who], ACTORS[who])
    for sim in (sonarr, radarr):  # the adds' commands are done: deletes and undos go at once
        sim.finish_commands()
    yield SimpleNamespace(api=api, tokens=tokens, sonarr=sonarr, radarr=radarr, qbit=qbit, reel_env=reel_env)
    for t in list(api.app_module.undo._tasks):
        t.cancel()
    await asyncio.sleep(0)


def grab_movie(lib, who, seed):
    m = lib.radarr.title(MOVIE[who])
    lib.radarr.grab(m["id"], H(seed))
    lib.qbit.add_torrent(SimTorrent(hash=make_hash(seed), name=seed, category="radarr",
                                    files=[SimFile(f"{seed}.mkv", 65536)]))


def later():
    """A grab the search started a moment ago makes (seconds later, as on the real arrs)."""
    return datetime.now(timezone.utc) + timedelta(seconds=3)


def grab_show(lib, who, seed, eps, date=None):
    """eps: [(season, episode)] in one torrent; `date`: when it was grabbed (now)."""
    s = lib.sonarr.title(SHOW[who])
    ids = [lib.sonarr.episode(s["id"], sn, en)["id"] for sn, en in eps]
    lib.sonarr.grab(s["id"], H(seed), episode_ids=ids, date=date)
    lib.qbit.add_torrent(SimTorrent(hash=make_hash(seed), name=seed, category="tv-sonarr",
                                    files=[SimFile(f"{seed}.mkv", 65536)]))


def snapshot(lib):
    owners = lib.reel_env.state / "owners.json"
    return ([(c.method, c.path, c.params) for c in lib.sonarr.calls + lib.radarr.calls if c.method != "GET"],
            sorted(lib.qbit.torrents), len(lib.sonarr.queue) + len(lib.radarr.queue),
            owners.read_bytes() if owners.exists() else None)


async def refused(lib, call):
    before = snapshot(lib)
    r = await call
    assert r.status_code == 403, r.text
    assert r.json()["error"] == "not_owner"
    assert snapshot(lib) == before, "a refused request changed something"
    return r


# ---------------------------------------------------------------- delete with files


@pytest.mark.parametrize("actor, owner, ok", [
    ("N", "N", True), ("N", "K", False), ("N", "L", False),
    ("Z", "N", False), ("Z", "K", False), ("Z", "L", False),
    ("K", "N", True), ("K", "K", True), ("K", "L", True),
])
@pytest.mark.parametrize("kind", ["movie", "tv"])
async def test_delete(lib, actor, owner, ok, kind):
    mid = (MOVIE if kind == "movie" else SHOW)[owner]
    sim = lib.radarr if kind == "movie" else lib.sonarr
    call = lib.api.delete(f"/api/library/{kind}/{mid}", params={"delete_files": "true"},
                          headers={"Authorization": ACTORS[actor]})
    if ok:
        aid = sim.title(mid)["id"]
        r = await call
        assert r.status_code == 200 and r.json()["status"] == "deleted"
        assert sim.files_deleted == [aid]
        assert lib.api.app_module.owners.title(kind, mid) is None
    else:
        r = await refused(lib, call)
        name = sim.title(mid)["title"]
        if owner == "L":
            assert r.json()["detail"] == f"“{name}” was added by an admin; only an admin can delete it."
        else:
            assert r.json()["detail"] == f"Only the person who added “{name}” can delete it."
        assert sim.title(mid) is not None


# ---------------------------------------------------------------- cancel


@pytest.mark.parametrize("actor, owner, ok", [
    ("N", "N", True), ("N", "K", False), ("N", "L", False),
    ("Z", "N", False), ("Z", "K", False), ("Z", "L", False),
    ("K", "N", True), ("K", "K", True), ("K", "L", True),
])
async def test_cancel_a_title(lib, actor, owner, ok):
    grab_movie(lib, owner, "m")
    grab_show(lib, owner, "s", [(1, 1)])
    for kind, mid in (("movie", MOVIE[owner]), ("tv", SHOW[owner])):
        call = lib.api.delete(f"/api/activity/{kind}/{mid}", headers={"Authorization": ACTORS[actor]})
        if ok:
            r = await call
            assert r.status_code == 200 and r.json()["status"] == "cancelled"
        else:
            r = await refused(lib, call)
            assert r.json()["detail"].startswith("Only the person who added “")
            assert r.json()["detail"].endswith("” can cancel its download.")


async def test_the_requester_cancels_her_season_of_someone_elses_series(lib):
    r = await lib.api.post("/api/news/search", json={"id": SHOW["K"], "season": 2}, headers={"Authorization": N})
    assert r.status_code == 202
    grab_show(lib, "K", "s2", [(2, 1), (2, 2)], later())
    grab_show(lib, "K", "s1", [(1, 1)], later())
    # season 1 is not hers, nor the whole title
    await refused(lib, lib.api.delete(f"/api/activity/tv/{SHOW['K']}", params={"season": 1},
                                      headers={"Authorization": N}))
    await refused(lib, lib.api.delete(f"/api/activity/tv/{SHOW['K']}", headers={"Authorization": N}))
    # Zhenya didn't ask for it
    await refused(lib, lib.api.delete(f"/api/activity/tv/{SHOW['K']}", params={"season": 2},
                                      headers={"Authorization": Z}))
    r = await lib.api.delete(f"/api/activity/tv/{SHOW['K']}", params={"season": 2, "episode": 1},
                             headers={"Authorization": N})
    assert r.status_code == 200 and r.json()["episodes"] == [{"season": 2, "episode": 1}, {"season": 2, "episode": 2}]
    assert make_hash("s2") not in lib.qbit.torrents and make_hash("s1") in lib.qbit.torrents


async def test_a_season_get_grants_nothing_over_grabs_already_in_flight(lib):
    """Reviewer repro: Kirill's series has a season-1 grab in flight; Zhenya
    'Gets' season 1 and could then cancel it (torrent and partial data gone)."""
    grab_show(lib, "K", "k1", [(1, 1), (1, 2)])
    r = await lib.api.post("/api/news/search", json={"id": SHOW["K"], "season": 1}, headers={"Authorization": Z})
    assert r.status_code == 202
    await refused(lib, lib.api.delete(f"/api/activity/tv/{SHOW['K']}", params={"season": 1},
                                      headers={"Authorization": Z}))
    r = await lib.api.get("/api/activity", headers={"Authorization": Z})
    assert {(i["mine"], i["can_cancel"]) for i in r.json()["items"]} == {(False, False)}
    # what her request grabs afterwards is hers
    lib.sonarr.queue.clear()
    grab_show(lib, "K", "k1-new", [(1, 1)], later())
    r = await lib.api.delete(f"/api/activity/tv/{SHOW['K']}", params={"season": 1}, headers={"Authorization": Z})
    assert r.status_code == 200 and make_hash("k1-new") not in lib.qbit.torrents


async def test_a_later_requester_does_not_take_the_season_over(lib):
    r = await lib.api.post("/api/news/search", json={"id": SHOW["K"], "season": 2}, headers={"Authorization": N})
    assert r.status_code == 202
    r = await lib.api.post("/api/news/search", json={"id": SHOW["K"], "season": 2}, headers={"Authorization": Z})
    assert r.status_code == 202 and r.json()["undo"]  # allowed, with her own undo token
    assert lib.api.app_module.owners.season(SHOW["K"], 2)["owner_name"] == "nicole"
    grab_show(lib, "K", "s2", [(2, 1)], later())
    await refused(lib, lib.api.delete(f"/api/activity/tv/{SHOW['K']}", params={"season": 2},
                                      headers={"Authorization": Z}))
    r = await lib.api.delete(f"/api/activity/tv/{SHOW['K']}", params={"season": 2}, headers={"Authorization": N})
    assert r.status_code == 200


async def test_a_pack_spanning_a_season_that_isnt_hers_is_refused_whole(lib):
    await lib.api.post("/api/news/search", json={"id": SHOW["K"], "season": 2}, headers={"Authorization": N})
    grab_show(lib, "K", "pack", [(1, 2), (2, 1)], later())
    r = await refused(lib, lib.api.delete(f"/api/activity/tv/{SHOW['K']}", params={"season": 2},
                                          headers={"Authorization": N}))
    assert r.json()["detail"] == "Only the person who added “K show” can cancel its download."
    assert make_hash("pack") in lib.qbit.torrents


async def test_nothing_in_queue_and_importing_answer_before_the_permission_check(lib):
    r = await lib.api.delete(f"/api/activity/movie/{MOVIE['K']}", headers={"Authorization": N})
    assert r.status_code == 404
    m = lib.radarr.title(MOVIE["K"])
    lib.radarr.grab(m["id"], H("imp"), state="importing")
    r = await lib.api.delete(f"/api/activity/movie/{MOVIE['K']}", headers={"Authorization": N})
    assert r.status_code == 409 and r.json()["error"] == "importing"


# ---------------------------------------------------------------- undo an add


@pytest.mark.parametrize("actor, status", [("N", 200), ("Z", 403), ("K", 200)])
async def test_undo_nicoles_add(lib, actor, status):
    token = lib.tokens[("movie", "N")]
    call = lib.api.delete(f"/api/library/movie/{MOVIE['N']}", params={"undo": token},
                          headers={"Authorization": ACTORS[actor]})
    if status == 403:
        r = await refused(lib, call)
        assert r.json()["detail"] == "Only the person who added “Nicole's movie” can undo that."
    else:
        r = await call
        assert r.status_code == 200 and r.json()["status"] == "removed"
        assert lib.radarr.title(MOVIE["N"]) is None and lib.radarr.files_deleted == []
        assert lib.api.app_module.owners.title("movie", MOVIE["N"]) is None


async def test_undo_frees_the_slot(make_api, radarr):
    for m in (1, 2, 3):
        radarr.add_catalog(movie_obj(m, f"M{m}"))
    async with make_api(REEL_API_QUOTA_MOVIES="2") as api:
        await _add(api, "movie", "1", N)
        token = await _add(api, "movie", "2", N)
        r = await api.post("/api/library", json={"id": "3", "type": "movie"}, headers={"Authorization": N})
        assert r.status_code == 409
        r = await api.delete("/api/library/movie/2", params={"undo": token}, headers={"Authorization": N})
        assert r.status_code == 200
        await _add(api, "movie", "3", N)


async def test_a_revive_is_quota_checked_and_recorded_for_the_reviver(make_api, radarr):
    radarr.add_catalog(movie_obj(1, "M1"))
    radarr.add_catalog(movie_obj(2, "M2"))
    async with make_api(REEL_API_QUOTA_MOVIES="1") as api:
        token = await _add(api, "movie", "1", N)
        search = next(c for c in radarr.commands.values() if c["name"] == "MoviesSearch")
        radarr.set_command_status(search["id"], "started")
        r = await api.delete("/api/library/movie/1", params={"undo": token}, headers={"Authorization": N})
        assert r.json()["status"] == "removing"
        await _add(api, "movie", "2", N)  # the slot was freed by the undo
        r = await api.post("/api/library", json={"id": "1", "type": "movie"}, headers={"Authorization": N})
        assert r.status_code == 409 and r.json()["error"] == "quota_exceeded"  # a revive is a new add
        new = await _add(api, "movie", "1", Z)  # Zhenya revives it: hers now, with her token
        assert api.app_module.owners.title("movie", "1")["owner_name"] == "Zhenya"
        r = await api.delete("/api/library/movie/1", params={"undo": new}, headers={"Authorization": N})
        assert r.status_code == 403
        for t in list(api.app_module.undo._tasks):
            t.cancel()


async def _undo(api, mid, token, auth):
    r = await api.delete(f"/api/library/movie/{mid}", params={"undo": token}, headers={"Authorization": auth})
    assert r.status_code == 200, r.text
    return r.json()["status"]


async def test_a_replayed_undo_after_a_re_add_keeps_the_new_record(make_api, radarr):
    """Reviewer repro: at 1/1 a replayed token used to drop the re-add's
    record (cached 'removed' answer) and free the slot — unlimited titles."""
    radarr.add_catalog(movie_obj(1, "M1"))
    radarr.add_catalog(movie_obj(2, "M2"))
    async with make_api(REEL_API_QUOTA_MOVIES="1") as api:
        t1 = await _add(api, "movie", "1", N)
        radarr.finish_commands()
        assert await _undo(api, "1", t1, N) == "removed"
        await _add(api, "movie", "1", N)
        radarr.finish_commands()
        aid = radarr.title(1)["id"]
        r = await api.post("/api/library", json={"id": "2", "type": "movie"}, headers={"Authorization": N})
        assert r.status_code == 409
        assert await _undo(api, "1", t1, N) == "removed"  # the same answer as before ...
        rec = api.app_module.owners.title("movie", "1")
        assert rec is not None and rec["arr_id"] == aid and rec["owner_name"] == "nicole"  # ... nothing undone
        assert radarr.title(1)["id"] == aid
        r = await api.post("/api/library", json={"id": "2", "type": "movie"}, headers={"Authorization": N})
        assert r.status_code == 409 and r.json()["used"] == 1


async def test_a_replayed_undo_never_drops_someone_elses_record(make_api, radarr):
    radarr.add_catalog(movie_obj(1, "M1"))
    async with make_api() as api:
        t1 = await _add(api, "movie", "1", N)
        radarr.finish_commands()
        assert await _undo(api, "1", t1, N) == "removed"
        await _add(api, "movie", "1", Z)
        radarr.finish_commands()
        assert await _undo(api, "1", t1, N) == "removed"
        assert api.app_module.owners.title("movie", "1")["owner_name"] == "Zhenya"
        r = await api.delete("/api/library/movie/1", params={"delete_files": "true"}, headers={"Authorization": Z})
        assert r.status_code == 200 and r.json()["status"] == "deleted"


async def test_a_replayed_undo_after_a_revive_keeps_the_revivers_record(make_api, radarr):
    radarr.add_catalog(movie_obj(1, "M1"))
    async with make_api() as api:
        t1 = await _add(api, "movie", "1", N)
        search = next(c for c in radarr.commands.values() if c["name"] == "MoviesSearch")
        radarr.set_command_status(search["id"], "started")
        assert await _undo(api, "1", t1, N) == "removing"
        await _add(api, "movie", "1", Z)  # revived: Zhenya's now
        assert await _undo(api, "1", t1, N) == "removing"
        assert api.app_module.owners.title("movie", "1")["owner_name"] == "Zhenya"
        for t in list(api.app_module.undo._tasks):
            t.cancel()


async def test_an_old_token_of_a_title_deleted_and_re_added_drops_nothing(make_api, radarr):
    """First use of the token, but the title it names is gone (an admin
    deleted it) and Zhenya added it again under a new arr id."""
    radarr.add_catalog(movie_obj(1, "M1"))
    async with make_api() as api:
        t1 = await _add(api, "movie", "1", N)
        radarr.finish_commands()
        r = await api.delete("/api/library/movie/1", params={"delete_files": "true"}, headers={"Authorization": K})
        assert r.json()["status"] == "deleted"
        await _add(api, "movie", "1", Z)
        assert await _undo(api, "1", t1, N) == "already_removed"
        assert api.app_module.owners.title("movie", "1")["owner_name"] == "Zhenya"
        assert radarr.title(1) is not None
        assert ("movie", "1") in api.app_module._recent_adds  # still offered as added


async def test_an_undo_whose_record_is_gone_still_counts_as_removed(make_api, radarr):
    """The record was dropped meanwhile (e.g. pruned): the undo still runs and
    the lookups stop offering the title as added."""
    radarr.add_catalog(movie_obj(1, "M1"))
    async with make_api() as api:
        t1 = await _add(api, "movie", "1", N)
        radarr.finish_commands()
        api.app_module.owners.drop_title("movie", "1")
        assert ("movie", "1") in api.app_module._recent_adds
        assert await _undo(api, "1", t1, N) == "removed"
        assert ("movie", "1") not in api.app_module._recent_adds


# ---------------------------------------------------------------- seasons


@pytest.mark.parametrize("actor", ["N", "Z", "K"])
@pytest.mark.parametrize("owner", ["N", "K", "L"])
async def test_everyone_may_get_a_season(lib, actor, owner):
    r = await lib.api.post("/api/news/search", json={"id": SHOW[owner], "season": 2},
                           headers={"Authorization": ACTORS[actor]})
    assert r.status_code == 202
    rec = lib.api.app_module.owners.season(SHOW[owner], 2)
    assert rec["owner_name"] == {"N": "nicole", "Z": "Zhenya", "K": "kirill"}[actor]


@pytest.mark.parametrize("actor, status", [("N", 200), ("Z", 403), ("K", 200)])
async def test_undo_nicoles_get(lib, actor, status):
    r = await lib.api.post("/api/news/search", json={"id": SHOW["K"], "season": 2}, headers={"Authorization": N})
    token = r.json()["undo"]
    call = lib.api.delete(f"/api/news/search/{token}", headers={"Authorization": ACTORS[actor]})
    if status == 403:
        r = await refused(lib, call)
        assert r.json()["detail"] == "Only the person who asked for that season can undo it."
        assert lib.api.app_module.owners.season(SHOW["K"], 2) is not None
    else:
        r = await call
        assert r.status_code == 200 and r.json()["status"] == "reverted"
        assert lib.api.app_module.owners.season(SHOW["K"], 2) is None


async def _get(lib, auth, season=2):
    r = await lib.api.post("/api/news/search", json={"id": SHOW["K"], "season": season},
                           headers={"Authorization": auth})
    assert r.status_code == 202, r.text
    return r.json()["undo"]


async def _undo_get(lib, token, auth):
    r = await lib.api.delete(f"/api/news/search/{token}", headers={"Authorization": auth})
    assert r.status_code == 200, r.text


async def test_undoing_a_later_get_keeps_the_first_requesters_record(lib):
    await _get(lib, N)
    tz = await _get(lib, Z)
    await _undo_get(lib, tz, Z)
    assert lib.api.app_module.owners.season(SHOW["K"], 2)["owner_name"] == "nicole"
    t2 = await _get(lib, N)  # her own second Get: not the recorded one either
    await _undo_get(lib, t2, N)
    assert lib.api.app_module.owners.season(SHOW["K"], 2)["owner_name"] == "nicole"


async def test_a_replayed_get_undo_keeps_the_next_requesters_record(lib):
    t1 = await _get(lib, N)
    await _undo_get(lib, t1, N)
    assert lib.api.app_module.owners.season(SHOW["K"], 2) is None
    await _get(lib, Z)
    await _undo_get(lib, t1, N)  # the cached answer again
    assert lib.api.app_module.owners.season(SHOW["K"], 2)["owner_name"] == "Zhenya"


# ---------------------------------------------------------------- activity flags


async def test_activity_flags_per_caller(lib):
    for who in ("N", "K", "L"):
        grab_movie(lib, who, f"m{who}")
    await lib.api.post("/api/news/search", json={"id": SHOW["K"], "season": 2}, headers={"Authorization": N})
    grab_show(lib, "K", "k-s2", [(2, 1)], later())
    grab_show(lib, "K", "k-s1", [(1, 1)], later())

    async def flags(auth):
        r = await lib.api.get("/api/activity", headers={"Authorization": auth})
        return {(i["type"], i["media_id"], i["season"]): (i["mine"], i["can_cancel"]) for i in r.json()["items"]}

    assert await flags(N) == {
        ("movie", MOVIE["N"], None): (True, True),
        ("movie", MOVIE["K"], None): (False, False),
        ("movie", MOVIE["L"], None): (False, False),
        ("tv", SHOW["K"], 2): (True, True),   # the season she asked for
        ("tv", SHOW["K"], 1): (False, False),
    }
    assert await flags(K) == {
        ("movie", MOVIE["N"], None): (False, True),
        ("movie", MOVIE["K"], None): (True, True),
        ("movie", MOVIE["L"], None): (False, True),
        ("tv", SHOW["K"], 2): (True, True),
        ("tv", SHOW["K"], 1): (True, True),
    }
    assert set((await flags(Z)).values()) == {(False, False)}


async def test_a_row_without_a_media_id_is_nobodys(lib):
    from tests.support.arr import queue_record

    lib.radarr.queue.append(queue_record(1, download_id=None, movie_id=999_999))  # no movie to embed
    r = await lib.api.get("/api/activity", headers={"Authorization": N})
    (row,) = [i for i in r.json()["items"] if i["media_id"] is None]
    assert (row["mine"], row["can_cancel"]) == (False, False)
    r = await lib.api.get("/api/activity", headers={"Authorization": K})
    (row,) = [i for i in r.json()["items"] if i["media_id"] is None]
    assert (row["mine"], row["can_cancel"]) == (False, True)
