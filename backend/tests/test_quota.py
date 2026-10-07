"""POST /api/library under the quota (ownership.py, app.add_to_library): a
normal user may own at most N movies and M series that still exist in
Radarr/Sonarr; admins have no limit; every add records its owner; two
concurrent adds at 9/10 can't both pass. Deletes and undos freeing a slot:
test_library_delete.py / test_permissions.py."""

from __future__ import annotations

import asyncio
import json
import logging
import stat
from datetime import datetime, timedelta, timezone

import pytest

from reel_api import ownership as own
from reel_api.security import User
from tests.conftest import NICOLE_TOKEN, NICOLE_USER, TEST_AUTH, TEST_USER, ZHENYA_TOKEN, auth_for
from tests.support.arr import episode_obj
from tests.support.arr import movie_obj, season_obj, series_obj
from tests.support.clock import FakeClock

NA = auth_for(NICOLE_TOKEN)
ZA = auth_for(ZHENYA_TOKEN)
T0 = datetime(2026, 10, 5, 12, 0, 0, tzinfo=timezone.utc)
MOVIES = list(range(1001, 1016))
SHOWS = list(range(5001, 5016))


@pytest.fixture
def catalog(sonarr, radarr):
    for m in MOVIES:
        radarr.add_catalog(movie_obj(m, f"Movie {m}", year=2000 + m % 20))
    for s in SHOWS:
        sonarr.add_catalog(series_obj(s, f"Show {s}", seasons=[season_obj(n) for n in range(1, 6)]))


@pytest.fixture
async def stop_sweepers(api):
    yield
    for t in list(api.app_module.undo._tasks):
        t.cancel()
    await asyncio.sleep(0)


async def add(api, kind, media_id, auth=NA):
    return await api.post("/api/library", json={"id": str(media_id), "type": kind},
                          headers={"Authorization": auth})


async def fill(api, kind, ids, auth=NA):
    for i in ids:
        r = await add(api, kind, i, auth)
        assert r.status_code == 202, r.text


async def me(api, auth=NA):
    r = await api.get("/api/me", headers={"Authorization": auth})
    assert r.status_code == 200, r.text
    return r.json()


def owners_file(reel_env) -> dict:
    return json.loads((reel_env.state / "owners.json").read_text())


# ---------------------------------------------------------------- the limit


async def test_the_tenth_passes_the_eleventh_is_409(api, catalog, radarr):
    await fill(api, "movie", MOVIES[:9])
    r = await add(api, "movie", MOVIES[9])
    assert r.status_code == 202
    assert (await me(api))["quota"]["movie"] == {"used": 10, "limit": 10}
    posts = radarr.count("/api/v3/movie", "POST")
    r = await add(api, "movie", MOVIES[10])
    assert r.status_code == 409
    assert r.json() == {"error": "quota_exceeded", "type": "movie", "used": 10, "limit": 10,
                        "detail": "You already have 10 of 10 movies. Delete one in My library to add another."}
    assert radarr.count("/api/v3/movie", "POST") == posts  # nothing sent to the arr
    assert radarr.title(MOVIES[10]) is None


async def test_a_series_counts_once_whatever_its_seasons(make_api, catalog, sonarr):
    async with make_api(REEL_API_QUOTA_SERIES="1") as api:
        await fill(api, "tv", SHOWS[:1])
        assert len(sonarr.title(SHOWS[0])["seasons"]) == 5
        r = await add(api, "tv", SHOWS[1])
        assert r.status_code == 409
        assert r.json()["detail"] == "You already have 1 of 1 show. Delete one in My library to add another."
        assert (r.json()["type"], r.json()["used"], r.json()["limit"]) == ("tv", 1, 1)


async def test_movies_and_series_are_counted_apart(make_api, catalog):
    async with make_api(REEL_API_QUOTA_MOVIES="2", REEL_API_QUOTA_SERIES="2") as api:
        await fill(api, "movie", MOVIES[:2])
        await fill(api, "tv", SHOWS[:2])
        assert (await add(api, "movie", MOVIES[2])).status_code == 409
        assert (await add(api, "tv", SHOWS[2])).status_code == 409
        q = (await me(api))["quota"]
        assert q == {"movie": {"used": 2, "limit": 2}, "tv": {"used": 2, "limit": 2}}


async def test_users_are_counted_apart(make_api, catalog):
    async with make_api(REEL_API_QUOTA_MOVIES="2") as api:
        await fill(api, "movie", MOVIES[:2])
        await fill(api, "movie", MOVIES[2:4], ZA)
        assert (await add(api, "movie", MOVIES[4])).status_code == 409
        assert (await add(api, "movie", MOVIES[4], ZA)).status_code == 409
        assert (await me(api, ZA))["quota"]["movie"]["used"] == 2


async def test_an_admin_has_no_limit_and_is_recorded_too(make_api, catalog, reel_env):
    async with make_api(REEL_API_QUOTA_MOVIES="1") as api:
        for m in MOVIES[:3]:
            r = await api.post("/api/library", json={"id": str(m), "type": "movie"})
            assert r.status_code == 202
        body = await me(api, TEST_AUTH)
    assert body["admin"] is True and body["quota"]["movie"] == {"used": 3, "limit": None}
    assert {k: v["owner"] for k, v in owners_file(reel_env)["titles"].items()} == {
        f"movie:{m}": TEST_USER for m in MOVIES[:3]}


async def test_limit_zero_turns_adding_off(make_api, catalog, radarr):
    async with make_api(REEL_API_QUOTA_MOVIES="0") as api:
        r = await add(api, "movie", MOVIES[0])
    assert r.status_code == 409
    assert r.json() == {"error": "quota_exceeded", "type": "movie", "used": 0, "limit": 0,
                        "detail": "Adding movies is turned off for your account."}
    assert radarr.count("/api/v3/movie", "POST") == 0


async def test_an_invalid_limit_is_the_default(make_api, catalog, caplog):
    async with make_api(REEL_API_QUOTA_MOVIES="ten", REEL_API_QUOTA_SERIES="-3") as api:
        q = (await me(api))["quota"]
    assert q == {"movie": {"used": 0, "limit": 10}, "tv": {"used": 0, "limit": 10}}
    assert "REEL_API_QUOTA_MOVIES" in caplog.text and "REEL_API_QUOTA_SERIES" in caplog.text


# ---------------------------------------------------------------- recording


async def test_an_add_records_its_owner(api, catalog, reel_env, radarr, caplog, time_machine):
    time_machine.move_to(T0, tick=False)
    with caplog.at_level(logging.INFO, logger="reel_api.actions"):
        r = await add(api, "movie", MOVIES[0])
    assert r.status_code == 202
    arr_id = radarr.title(MOVIES[0])["id"]
    assert owners_file(reel_env) == {"version": 1, "seasons": {}, "titles": {f"movie:{MOVIES[0]}": {
        "arr_id": arr_id, "title": f"Movie {MOVIES[0]}", "year": 2000 + MOVIES[0] % 20,
        "owner": NICOLE_USER, "owner_name": "nicole", "at": "2026-10-05T12:00:00Z"}}}
    assert stat.S_IMODE((reel_env.state / "owners.json").stat().st_mode) == 0o600
    assert f"library add: movie {MOVIES[0]} (Movie {MOVIES[0]}), arr id {arr_id} by nicole" in caplog.text


async def test_already_added_records_nothing_and_counts_nothing(api, catalog, radarr, reel_env):
    radarr.add_movie(movie_obj(603, "The Matrix"))
    r = await add(api, "movie", 603)
    assert r.status_code == 409 and r.json()["error"] == "already_added"
    assert not (reel_env.state / "owners.json").exists()
    assert (await me(api))["quota"]["movie"]["used"] == 0


async def test_an_arr_answer_without_id_still_records(api, catalog, radarr, reel_env):
    await me(api)  # the listing is cached: the next /api/v3/movie call is the add
    radarr.fail("/api/v3/movie", status=201, body="")
    r = await add(api, "movie", MOVIES[0])
    assert r.status_code == 202 and r.json()["undo"] is None
    assert owners_file(reel_env)["titles"][f"movie:{MOVIES[0]}"]["arr_id"] is None


async def test_records_survive_a_restart_and_a_corrupt_file_starts_empty(make_api, catalog, reel_env):
    async with make_api() as api:
        await fill(api, "movie", MOVIES[:2])
    async with make_api() as api:
        assert (await me(api))["quota"]["movie"]["used"] == 2
    (reel_env.state / "owners.json").write_text("{broken")
    async with make_api() as api:
        body = await me(api)
    assert body["quota"]["movie"]["used"] == 0 and body["titles"] == []  # legacy now: nobody's
    assert list(reel_env.state.glob("owners.json.bad-*"))


# ---------------------------------------------------------------- counting what exists


async def test_a_title_deleted_outside_frees_its_slot_after_the_listing_ttl(
        make_api, catalog, radarr, reel_env, monkeypatch, time_machine):
    clock = FakeClock().install(monkeypatch, own)
    time_machine.move_to(T0, tick=False)
    async with make_api(REEL_API_QUOTA_MOVIES="2") as api:
        await fill(api, "movie", MOVIES[:2])
        time_machine.move_to(T0 + timedelta(minutes=1), tick=False)
        assert (await me(api))["quota"]["movie"]["used"] == 2  # listing cached, both in it
        del radarr.titles[radarr.title(MOVIES[0])["id"]]  # deleted in Radarr's own UI
        r = await add(api, "movie", MOVIES[2])
        assert r.status_code == 409  # the cached listing still has it
        clock.t += own.LIBRARY_TTL + 1
        r = await add(api, "movie", MOVIES[2])
        assert r.status_code == 202, r.text  # not in the fresh listing: not counted ...
        assert [t["id"] for t in (await me(api))["titles"]] == [str(MOVIES[2]), str(MOVIES[1])]
        assert f"movie:{MOVIES[0]}" in owners_file(reel_env)["titles"]  # ... the record waits for a 2nd
        clock.t += own.LIBRARY_TTL
        await me(api)
        assert f"movie:{MOVIES[0]}" not in owners_file(reel_env)["titles"]


async def test_an_arr_that_lists_nothing_wipes_no_record(make_api, catalog, radarr, reel_env, monkeypatch,
                                                         time_machine):
    """Reviewer: Radarr answering [] once (startup race, DB hiccup) used to
    drop every movie record on the next /api/me — the owners' delete rights
    gone for good."""
    clock = FakeClock().install(monkeypatch, own)
    time_machine.move_to(T0, tick=False)
    async with make_api() as api:
        await fill(api, "movie", MOVIES[:2])
        time_machine.move_to(T0 + timedelta(minutes=1), tick=False)
        saved = dict(radarr.titles)
        radarr.titles.clear()
        for _ in range(3):
            clock.t += own.LIBRARY_TTL + 1
            await me(api)
        assert set(owners_file(reel_env)["titles"]) == {f"movie:{m}" for m in MOVIES[:2]}
        radarr.titles.update(saved)
        clock.t += own.LIBRARY_TTL + 1
        assert (await me(api))["quota"]["movie"]["used"] == 2


async def test_a_record_newer_than_the_cached_listing_counts(make_api, catalog, radarr, monkeypatch,
                                                             time_machine):
    """No over-admission from a stale listing: a record written after the
    listing was requested counts, and is not pruned by it."""
    FakeClock().install(monkeypatch, own)
    time_machine.move_to(T0, tick=False)
    async with make_api(REEL_API_QUOTA_MOVIES="2") as api:
        await fill(api, "movie", MOVIES[:1])
        time_machine.move_to(T0 + timedelta(minutes=1), tick=False)
        await me(api)  # listing cached at T0+1min, without what comes next
        time_machine.move_to(T0 + timedelta(minutes=1, seconds=10), tick=False)
        api.app_module.owners.record_title("movie", "9999", arr_id=None, title="Elsewhere", year=None,
                                           user=User(NICOLE_USER, "nicole", False),
                                           at=datetime.now(timezone.utc))
        time_machine.move_to(T0 + timedelta(minutes=1, seconds=12), tick=False)
        r = await add(api, "movie", MOVIES[1])
        assert r.status_code == 409 and r.json()["used"] == 2
        assert api.app_module.owners.title("movie", "9999") is not None


# ---------------------------------------------------------------- races


async def test_two_concurrent_adds_at_nine_of_ten_one_passes(api, catalog, radarr):
    await fill(api, "movie", MOVIES[:9])
    gate = radarr.gate("/api/v3/movie", lambda c: c.method == "POST")
    first = asyncio.create_task(add(api, "movie", MOVIES[9]))
    second = asyncio.create_task(add(api, "movie", MOVIES[10]))
    await asyncio.sleep(0.1)
    assert radarr.count("/api/v3/movie", "POST") == 10  # the second waits before the arr
    gate.set()
    got = sorted([(await first).status_code, (await second).status_code])
    assert got == [202, 409]
    assert radarr.count("/api/v3/movie", "POST") == 10
    assert (await me(api))["quota"]["movie"]["used"] == 10


async def test_different_users_and_kinds_do_not_wait_for_each_other(api, catalog, radarr, sonarr):
    gate = radarr.gate("/api/v3/movie", lambda c: c.method == "POST")
    n_movie = asyncio.create_task(add(api, "movie", MOVIES[0]))
    z_movie = asyncio.create_task(add(api, "movie", MOVIES[1], ZA))
    await asyncio.sleep(0.1)
    assert radarr.count("/api/v3/movie", "POST") == 2  # both at the arr at once
    n_show = await add(api, "tv", SHOWS[0])  # her movie add is still held: the tv add isn't
    assert n_show.status_code == 202
    gate.set()
    assert (await n_movie).status_code == (await z_movie).status_code == 202


async def test_a_season_get_counts_against_nothing(api, catalog, sonarr, stop_sweepers, time_machine):
    s = sonarr.add_series(series_obj(81189, "Breaking Bad", seasons=[season_obj(1), season_obj(2)]),
                          [episode_obj(2, 1, air=datetime.now(timezone.utc) - timedelta(days=3))])
    assert s
    await fill(api, "tv", SHOWS[:1])
    r = await api.post("/api/news/search", json={"id": "81189", "season": 2}, headers={"Authorization": NA})
    assert r.status_code == 202
    assert (await me(api))["quota"]["tv"]["used"] == 1
