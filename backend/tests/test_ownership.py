"""ownership.py and statefile.py on their own: the owners.json store (format,
persistence, corruption, season TTL), rights (is_mine / may), pruning, the
cached library listings, quota counting and the env limits. The routes that
use them: test_quota.py, test_permissions.py, test_library_delete.py,
test_me.py."""

from __future__ import annotations

import asyncio
import json
import logging
import stat
from datetime import datetime, timedelta, timezone

import pytest

from reel_api import ownership as own
from reel_api import push, statefile
from reel_api.arr import ArrClient, ArrError
from reel_api.security import User
from tests.conftest import NICOLE_USER, RADARR, RADARR_KEY, SONARR, SONARR_KEY, TEST_USER, ZHENYA_USER
from tests.support.arr import movie_obj, season_obj, series_obj
from tests.support.clock import FakeClock

K = User(TEST_USER, "kirill", True)
N = User(NICOLE_USER, "nicole", False)
Z = User(ZHENYA_USER, "Zhenya", False)
T0 = datetime(2026, 10, 5, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def frozen(time_machine):
    time_machine.move_to(T0, tick=False)
    return time_machine


@pytest.fixture
def owners(reel_env):
    return own.Owners()


def rec(owners, kind, mid, user, at=T0, title="T", arr_id=1, year=2020):
    owners.record_title(kind, mid, arr_id=arr_id, title=title, year=year, user=user, at=at)


def on_disk(owners) -> dict:
    return json.loads(owners.path.read_text())


# ---------------------------------------------------------------- statefile


def test_state_dir_prefers_state_then_cache_then_tmp(reel_env, tmp_path):
    assert statefile.state_dir() == reel_env.state
    reel_env(STATE_DIRECTORY=f"{tmp_path}/a:{tmp_path}/b")
    assert statefile.state_dir() == tmp_path / "a" and (tmp_path / "a").is_dir()
    reel_env(STATE_DIRECTORY=None)
    assert statefile.state_dir() == reel_env.cache
    reel_env(CACHE_DIRECTORY=None)
    assert statefile.state_dir() == tmp_path / "tmp" / "reel-api-state"
    assert push._state_dir is statefile.state_dir  # push.py uses the same directory


def test_write_json_atomic(tmp_path):
    p = tmp_path / "x.json"
    p.write_text("old")
    statefile.write_json_atomic(p, {"b": 1, "a": [1, 2]})
    assert p.read_text() == '{"a":[1,2],"b":1}'
    assert stat.S_IMODE(p.stat().st_mode) == 0o600
    assert not (tmp_path / "x.tmp").exists()
    with pytest.raises(OSError):
        statefile.write_json_atomic(tmp_path / "missing" / "x.json", {})


# ---------------------------------------------------------------- the store


def test_missing_file_is_empty_and_writes_nothing(owners):
    assert owners.titles == {} and owners.seasons == {}
    assert owners.path == statefile.state_dir() / "owners.json"
    owners.drop_title("movie", "1")
    owners.drop_season("1", 1)
    assert not owners.path.exists()


def test_records_round_trip_in_the_documented_format(owners, frozen):
    rec(owners, "movie", "603", N, title="The Matrix", arr_id=12, year=1999)
    owners.record_season("81189", 3, N, T0 + timedelta(minutes=3))
    assert on_disk(owners) == {
        "version": 1,
        "titles": {"movie:603": {"arr_id": 12, "title": "The Matrix", "year": 1999, "owner": NICOLE_USER,
                                 "owner_name": "nicole", "at": "2026-10-05T12:00:00Z"}},
        "seasons": {"tv:81189:3": {"owner": NICOLE_USER, "owner_name": "nicole", "at": "2026-10-05T12:03:00Z"}},
    }
    assert stat.S_IMODE(owners.path.stat().st_mode) == 0o600
    again = own.Owners()
    assert again.titles == owners.titles and again.seasons == owners.seasons
    assert again.title("movie", "603")["owner"] == NICOLE_USER and again.title("movie", "604") is None


def test_a_naive_or_offset_time_is_stored_as_utc_z(owners):
    rec(owners, "movie", "1", N, at=datetime(2026, 10, 5, 14, 0, tzinfo=timezone(timedelta(hours=2))))
    assert owners.title("movie", "1")["at"] == "2026-10-05T12:00:00Z"


def test_drop_title_takes_the_series_seasons_with_it(owners, frozen):
    rec(owners, "tv", "81189", N)
    rec(owners, "movie", "81189", N)
    owners.record_season("81189", 1, Z, T0)
    owners.record_season("811890", 1, Z, T0)  # another series whose id starts the same
    owners.drop_title("tv", "81189")
    assert set(on_disk(owners)["titles"]) == {"movie:81189"}
    assert set(on_disk(owners)["seasons"]) == {"tv:811890:1"}
    owners.drop_title("movie", "81189")
    assert on_disk(owners)["titles"] == {}


def test_season_records(owners, frozen):
    assert owners.record_season("81189", 2, N, T0) is True
    assert owners.record_season("81189", 2, Z, T0 + timedelta(minutes=1)) is False  # the first requester holds it
    assert owners.record_season("81189", 2, N, T0 + timedelta(minutes=2)) is False  # her own again: keeps the first
    assert owners.season("81189", 2) == {"owner": NICOLE_USER, "owner_name": "nicole", "at": "2026-10-05T12:00:00Z"}
    assert owners.season("81189", 3) is None
    owners.drop_season("81189", 2, owner=ZHENYA_USER)  # not hers
    owners.drop_season("81189", 2, owner=NICOLE_USER, at=T0 + timedelta(minutes=2))  # not that request
    assert owners.season("81189", 2) is not None
    owners.drop_season("81189", 2, owner=NICOLE_USER, at=T0)
    assert owners.season("81189", 2) is None and on_disk(owners)["seasons"] == {}
    owners.record_season("81189", 2, N, T0)
    owners.drop_season("81189", 2)  # unconditional
    assert owners.season("81189", 2) is None


def test_a_season_request_is_stored_rounded_up_to_the_second(owners, frozen):
    """The arrs stamp a grab to the second: one queued in the request's own
    second may predate it, so it isn't the requester's."""
    owners.record_season("5", 1, N, T0 + timedelta(milliseconds=400))
    assert owners.season("5", 1)["at"] == "2026-10-05T12:00:01Z"
    assert not owners.is_mine(N, "tv", "5", 1, grabbed_at=T0)
    assert owners.is_mine(N, "tv", "5", 1, grabbed_at=T0 + timedelta(seconds=1))


def test_an_expired_season_record_goes_to_the_next_requester(owners, frozen):
    owners.record_season("1", 1, N, T0 - own.SEASON_TTL - timedelta(seconds=1))
    assert owners.record_season("1", 1, Z, T0) is True
    assert owners.season("1", 1)["owner"] == ZHENYA_USER


def test_seasons_expire_after_30_days(owners, frozen, reel_env):
    owners.record_season("1", 1, N, T0 - own.SEASON_TTL + timedelta(seconds=1))
    owners.record_season("1", 2, N, T0)
    assert owners.season("1", 1) is not None
    frozen.move_to(T0 + timedelta(seconds=2), tick=False)
    assert owners.season("1", 1) is None  # expired, though still in memory
    assert own.Owners().seasons.keys() == {"tv:1:2"}  # dropped at load
    owners.record_season("2", 1, N, T0)  # and before every save
    assert set(on_disk(owners)["seasons"]) == {"tv:1:2", "tv:2:1"}


@pytest.mark.parametrize("content", ["{not json", "[]", '{"version": 2, "titles": {}}', '{"titles": {}}', ""])
def test_a_corrupt_file_is_moved_aside_and_the_store_starts_empty(reel_env, frozen, caplog, content):
    path = statefile.state_dir() / "owners.json"
    path.write_text(content)
    with caplog.at_level(logging.ERROR, logger="reel_api.actions"):
        o = own.Owners()
    assert o.titles == {} and not path.exists()
    bad = path.with_name("owners.json.bad-20261005T120000")
    assert bad.read_text() == content
    assert "owners.json" in caplog.text and "admin" in caplog.text
    rec(o, "movie", "1", N)  # a fresh file, the bad one kept
    assert path.exists() and bad.exists()


def test_an_unreadable_file_is_moved_aside(reel_env, frozen, caplog):
    path = statefile.state_dir() / "owners.json"
    path.mkdir()  # reading it fails with an OSError
    o = own.Owners()
    assert o.titles == {} and path.with_name("owners.json.bad-20261005T120000").is_dir()
    assert "unreadable" in caplog.text


def test_when_the_move_fails_too_it_is_logged(reel_env, frozen, caplog, monkeypatch):
    path = statefile.state_dir() / "owners.json"
    path.write_text("[]")

    def nope(*a):
        raise PermissionError("read-only")

    monkeypatch.setattr(own.os, "replace", nope)
    o = own.Owners()
    assert o.titles == {} and path.exists()
    assert "could not move it aside" in caplog.text


def test_malformed_entries_are_skipped_the_rest_kept(reel_env, frozen, caplog):
    path = statefile.state_dir() / "owners.json"
    good = {"owner": NICOLE_USER, "at": "2026-10-05T12:00:00Z"}
    path.write_text(json.dumps({"version": 1, "titles": {
        "movie:1": good, "book:2": good, "movie:x": good, "movie:3": "nope", "movie:4": {"at": "x"},
        "movie:5": {"owner": ""}, "movie:6": {"owner": 7}}, "seasons": {"tv:1:1": good, "tv:1": good}}))
    with caplog.at_level(logging.WARNING, logger="reel_api.actions"):
        o = own.Owners()
    assert set(o.titles) == {"movie:1"} and set(o.seasons) == {"tv:1:1"}
    assert caplog.text.count("malformed") == 7
    path.write_text(json.dumps({"version": 1, "titles": [], "seasons": None}))
    o = own.Owners()
    assert o.titles == {} and o.seasons == {} and path.exists()


def test_a_failed_save_keeps_the_change_in_memory(owners, caplog, monkeypatch):
    def full(*a):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(own, "write_json_atomic", full)
    rec(owners, "movie", "1", N)
    assert owners.title("movie", "1")["owner"] == NICOLE_USER
    assert "not saved" in caplog.text and not owners.path.exists()


def test_owned_lists_by_user_and_kind(owners):
    rec(owners, "movie", "1", N)
    rec(owners, "tv", "2", N)
    rec(owners, "movie", "3", Z)
    assert sorted((k, m) for k, m, _ in owners.owned(NICOLE_USER)) == [("movie", "1"), ("tv", "2")]
    assert [(k, m) for k, m, _ in owners.owned(NICOLE_USER, "movie")] == [("movie", "1")]
    assert owners.owned(TEST_USER) == []


# ---------------------------------------------------------------- rights


def test_is_mine_and_may(owners, frozen):
    rec(owners, "tv", "10", N)
    rec(owners, "tv", "20", K)
    owners.record_season("20", 3, N, T0)
    # her own title, any season
    assert owners.is_mine(N, "tv", "10") and owners.is_mine(N, "tv", "10", 5)
    # kirill's series: only the season she asked for, and only grabs made since she asked
    assert owners.is_mine(N, "tv", "20", 3, grabbed_at=T0)
    assert owners.is_mine(N, "tv", "20", 3, grabbed_at=T0 + timedelta(hours=1))
    assert not owners.is_mine(N, "tv", "20", 3, grabbed_at=T0 - timedelta(seconds=1))  # in flight before
    assert not owners.is_mine(N, "tv", "20", 3)  # a grab of unknown time
    assert not owners.is_mine(N, "tv", "20") and not owners.is_mine(N, "tv", "20", 4, grabbed_at=T0)
    assert owners.is_mine(N, "tv", "10", 5, grabbed_at=T0 - timedelta(days=9))  # her title: any grab
    # a movie with the same id is another title
    assert not owners.is_mine(N, "movie", "10") and not owners.is_mine(N, "movie", "20", 3, grabbed_at=T0)
    # legacy, unknown, no id
    assert not owners.is_mine(N, "tv", "30") and not owners.is_mine(N, "tv", None)
    assert not owners.is_mine(Z, "tv", "10")
    assert owners.may(N, "tv", "10") and not owners.may(Z, "tv", "10")
    assert owners.may(K, "tv", "10") and owners.may(K, "tv", "30") and owners.may(K, "tv", None)
    assert owners.is_mine(K, "tv", "20") and not owners.is_mine(K, "tv", "10")


def test_quota_lock_per_user_and_kind(owners):
    a = owners.quota_lock(NICOLE_USER, "movie")
    assert owners.quota_lock(NICOLE_USER, "movie") is a
    assert owners.quota_lock(NICOLE_USER, "tv") is not a
    assert owners.quota_lock(ZHENYA_USER, "movie") is not a


# ---------------------------------------------------------------- pruning


def test_prune_drops_what_left_the_library_before_the_listing(owners, frozen, caplog):
    rec(owners, "movie", "1", N, at=T0 - timedelta(minutes=5), title="Gone")
    rec(owners, "movie", "2", N, at=T0 - timedelta(minutes=5))           # still listed
    rec(owners, "movie", "3", N, at=T0 - timedelta(seconds=4))           # within SKEW of the listing
    rec(owners, "movie", "4", N, at=T0 + timedelta(seconds=1))           # added after it was requested
    rec(owners, "tv", "1", N, at=T0 - timedelta(minutes=5))              # the other kind
    n = owners.path.stat().st_mtime_ns
    assert owners.prune("movie", {"2"}, T0, fetched=100.0) == []  # missing once: not yet
    assert owners.path.stat().st_mtime_ns == n  # nothing dropped: not saved
    assert owners.prune("movie", {"2"}, T0, fetched=100.0 + own.LIBRARY_TTL - 1) == []
    with caplog.at_level(logging.INFO, logger="reel_api.actions"):
        assert owners.prune("movie", {"2"}, T0, fetched=100.0 + own.LIBRARY_TTL) == ["movie:1"]
    assert set(on_disk(owners)["titles"]) == {"movie:2", "movie:3", "movie:4", "tv:1"}
    assert "owner record dropped: Gone left the library outside reel-api" in caplog.text


def prune_twice(owners, kind, present, at=T0):
    """Two listings LIBRARY_TTL apart, both without the records."""
    assert owners.prune(kind, present, at, fetched=0.0) == []
    return owners.prune(kind, present, at, fetched=float(own.LIBRARY_TTL))


def test_a_record_back_in_a_listing_starts_over(owners, frozen):
    rec(owners, "movie", "1", N, at=T0 - timedelta(hours=1))
    assert owners.prune("movie", {"2"}, T0, fetched=0.0) == []
    assert owners.prune("movie", {"1", "2"}, T0, fetched=10.0) == []  # back (an arr hiccup)
    assert owners.prune("movie", {"2"}, T0, fetched=float(own.LIBRARY_TTL)) == []  # missing again: once
    assert owners.prune("movie", {"2"}, T0, fetched=2.0 * own.LIBRARY_TTL) == ["movie:1"]


def test_an_empty_listing_prunes_nothing(owners, frozen, caplog):
    """An arr that answers [] (a startup race, a DB hiccup) must not wipe every
    owner's records — they would count as the admins' for good (reviewer)."""
    rec(owners, "movie", "1", N, at=T0 - timedelta(hours=1))
    owners.record_season("7", 1, N, T0 - timedelta(hours=1))
    with caplog.at_level(logging.WARNING, logger="reel_api.actions"):
        for f in (0.0, 1000.0, 2000.0):
            assert owners.prune("movie", set(), T0, fetched=f) == []
            assert owners.prune("tv", set(), T0, fetched=f) == []
    assert owners.title("movie", "1") is not None and owners.season("7", 1) is not None
    assert "movie library listing is empty: 1 owner record(s) kept" in caplog.text
    assert "tv library listing is empty: 1 owner record(s) kept" in caplog.text
    caplog.clear()
    assert prune_twice(owners, "movie", {"2"}) == ["movie:1"]  # a real listing still prunes
    assert owners.prune("movie", set(), T0, fetched=5000.0) == []
    assert "empty" not in caplog.text  # nothing left to keep: no warning


def test_many_records_dropped_at_once_are_a_warning(owners, frozen, caplog):
    for m in range(1, 6):
        rec(owners, "movie", str(m), N, at=T0 - timedelta(hours=1))
    with caplog.at_level(logging.WARNING, logger="reel_api.actions"):
        assert prune_twice(owners, "movie", {"1"}) == ["movie:2", "movie:3", "movie:4", "movie:5"]
    assert "4 movie owner records dropped at once" in caplog.text
    caplog.clear()
    rec(owners, "movie", "9", N, at=T0 - timedelta(hours=1))
    with caplog.at_level(logging.WARNING, logger="reel_api.actions"):
        assert prune_twice(owners, "movie", {"1"}) == ["movie:9"]
    assert "at once" not in caplog.text


def test_prune_tv_drops_season_requests_of_vanished_series(owners, frozen):
    owners.record_season("7", 1, N, T0 - timedelta(minutes=5))
    owners.record_season("8", 1, N, T0 - timedelta(minutes=5))
    owners.record_season("9", 1, N, T0)
    assert prune_twice(owners, "tv", {"8"}) == []
    assert set(on_disk(owners)["seasons"]) == {"tv:8:1", "tv:9:1"}
    assert prune_twice(owners, "movie", {"1"}) == [] and len(owners.seasons) == 2


def test_a_record_without_a_time_counts_as_old(reel_env, frozen):
    path = statefile.state_dir() / "owners.json"
    path.write_text(json.dumps({"version": 1, "titles": {"movie:1": {"owner": NICOLE_USER}}, "seasons": {}}))
    o = own.Owners()
    assert prune_twice(o, "movie", {"2"}) == ["movie:1"]


def test_prune_without_a_fetch_time_uses_the_clock(owners, frozen, monkeypatch):
    clock = FakeClock().install(monkeypatch, own)
    rec(owners, "movie", "1", N, at=T0 - timedelta(hours=1))
    assert owners.prune("movie", {"2"}, T0) == []
    clock.t += own.LIBRARY_TTL
    assert owners.prune("movie", {"2"}, T0) == ["movie:1"]


# ---------------------------------------------------------------- limits


@pytest.mark.parametrize("movies, series, expect, warned", [
    (None, None, {"movie": 10, "tv": 10}, 0),
    ("3", " 7 ", {"movie": 3, "tv": 7}, 0),
    ("0", "", {"movie": 0, "tv": 10}, 0),
    ("x", "-1", {"movie": 10, "tv": 10}, 2),
    ("2.5", "12", {"movie": 10, "tv": 12}, 1),
])
def test_limits_from_env(reel_env, caplog, movies, series, expect, warned):
    reel_env(REEL_API_QUOTA_MOVIES=movies, REEL_API_QUOTA_SERIES=series)
    with caplog.at_level(logging.WARNING, logger="reel_api.actions"):
        assert own.limits_from_env() == expect
    assert caplog.text.count("not a non-negative integer") == warned


@pytest.mark.parametrize("kind, used, limit, text", [
    ("movie", 10, 10, "You already have 10 of 10 movies. Delete one in My library to add another."),
    ("tv", 12, 10, "You already have 12 of 10 shows. Delete one in My library to add another."),
    ("movie", 1, 1, "You already have 1 of 1 movie. Delete one in My library to add another."),
    ("tv", 1, 1, "You already have 1 of 1 show. Delete one in My library to add another."),
    ("movie", 0, 0, "Adding movies is turned off for your account."),
    ("tv", 3, 0, "Adding shows is turned off for your account."),
])
def test_quota_exceeded_wording(kind, used, limit, text):
    e = own.QuotaExceeded(kind, used, limit)
    assert (e.kind, e.used, e.limit, e.detail) == (kind, used, limit, text)


def test_not_owner_carries_its_detail():
    assert own.NotOwner("no").detail == "no" and str(own.NotOwner("no")) == "no"


# ---------------------------------------------------------------- listings


@pytest.fixture
def clients(upstream, sonarr, radarr):
    return {"tv": ArrClient("tv", SONARR, SONARR_KEY, "HD-1080p"),
            "movie": ArrClient("movie", RADARR, RADARR_KEY, "HD-1080p")}


async def test_listing_is_cached_for_library_ttl(clients, radarr, monkeypatch):
    clock = FakeClock().install(monkeypatch, own)
    radarr.add_movie(movie_obj(603, "The Matrix"))
    ls = own.Listings(clients)
    first = await ls.get("movie")
    assert set(first.by_id) == {"603"} and first.by_id["603"]["title"] == "The Matrix"
    clock.t += own.LIBRARY_TTL - 1
    assert await ls.get("movie") is first
    clock.t += 2
    assert await ls.get("movie") is not first
    assert radarr.count("/api/v3/movie", "GET") == 2


async def test_concurrent_callers_share_one_request(clients, sonarr):
    sonarr.add_series(series_obj(81189, "Breaking Bad", seasons=[season_obj(1)]))
    sonarr.add_series(series_obj(0, "No tvdb id", seasons=[season_obj(1)]))
    gate = sonarr.gate("/api/v3/series")
    ls = own.Listings(clients)
    tasks = [asyncio.create_task(ls.get("tv")) for _ in range(5)]
    await asyncio.sleep(0.05)
    gate.set()
    got = await asyncio.gather(*tasks)
    assert all(g is got[0] for g in got) and set(got[0].by_id) == {"81189"}
    assert sonarr.count("/api/v3/series", "GET") == 1


async def test_invalidate_drops_the_cache_and_an_answer_in_flight(clients, radarr):
    ls = own.Listings(clients)
    await ls.get("movie")
    ls.invalidate("movie")
    gate = radarr.gate("/api/v3/movie")
    task = asyncio.create_task(ls.get("movie"))
    await asyncio.sleep(0.05)
    ls.invalidate("movie")  # an add landed while the listing was on its way
    gate.set()
    await task
    await ls.get("movie")
    assert radarr.count("/api/v3/movie", "GET") == 3  # the in-flight answer was not cached


async def test_started_is_taken_before_the_request(clients, radarr, frozen):
    gate = radarr.gate("/api/v3/movie")
    task = asyncio.create_task(own.Listings(clients).get("movie"))
    await asyncio.sleep(0.05)
    frozen.move_to(T0 + timedelta(seconds=20), tick=False)
    gate.set()
    assert (await task).started == T0


async def test_an_arr_error_propagates_and_is_not_cached(clients, radarr):
    radarr.fail("/api/v3/movie", status=500)
    ls = own.Listings(clients)
    with pytest.raises(ArrError):
        await ls.get("movie")
    assert (await ls.get("movie")).by_id == {}


# ---------------------------------------------------------------- quota math


async def test_used_counts_existing_titles_only_and_prunes(clients, radarr, owners, frozen):
    radarr.add_movie(movie_obj(1, "A"))
    radarr.add_movie(movie_obj(2, "B"))
    rec(owners, "movie", "1", N, at=T0 - timedelta(hours=1))
    rec(owners, "movie", "2", Z, at=T0 - timedelta(hours=1))
    rec(owners, "movie", "3", N, at=T0 - timedelta(hours=1))  # deleted in Radarr's UI
    q = own.Quota(owners, own.Listings(clients), {"movie": 2, "tv": 10})
    assert await q.used(N, "movie") == 1  # not counted at once ...
    assert owners.title("movie", "3") is not None  # ... pruned only by a second listing (test_quota)
    await q.check(N, "movie")  # 1 of 2
    rec(owners, "movie", "4", N, at=T0 + timedelta(seconds=1))  # added after the (cached) listing
    with pytest.raises(own.QuotaExceeded) as e:
        await q.check(N, "movie")
    assert (e.value.used, e.value.limit) == (2, 2)
    await q.check(K, "movie")  # admins: no limit
    assert await q.used(Z, "movie") == 1 and await q.used(N, "tv") == 0


async def test_limit_zero_refuses_the_first(clients, owners):
    q = own.Quota(owners, own.Listings(clients), {"movie": 0, "tv": 0})
    with pytest.raises(own.QuotaExceeded) as e:
        await q.check(N, "tv")
    assert e.value.detail == "Adding shows is turned off for your account."


def test_exists_rule():
    listing = own.Listing(T0, 0.0, {"1": {}})
    assert own.exists({"at": "2020-01-01T00:00:00Z"}, "1", listing)
    assert not own.exists({"at": "2026-10-05T11:59:54Z"}, "2", listing)
    assert own.exists({"at": "2026-10-05T11:59:55Z"}, "2", listing)
    assert not own.exists({}, "2", listing)



# ---------------------------------------------------------------- the arr primitives


async def test_title_by_media_id_filters_and_double_checks(clients, radarr, sonarr, upstream):
    m = radarr.add_movie(movie_obj(603, "The Matrix"))
    s = sonarr.add_series(series_obj(81189, "Breaking Bad", seasons=[season_obj(1)]))
    assert (await clients["movie"].title_by_media_id("603"))["id"] == m["id"]
    assert (await clients["tv"].title_by_media_id("81189"))["id"] == s["id"]
    assert await clients["movie"].title_by_media_id("604") is None
    assert radarr.called("/api/v3/movie", "GET")[-1].params == {"tmdbId": "604"}
    # an arr that ignored the filter and listed everything: only the exact id counts
    radarr.fail("/api/v3/movie", status=200, body=json.dumps([{"id": 1, "tmdbId": 9}]))
    assert await clients["movie"].title_by_media_id("603") is None


@pytest.mark.deletes_files_directly
async def test_delete_title_and_files_sends_delete_files(clients, radarr, sonarr):
    m = radarr.add_movie(movie_obj(603, "The Matrix", has_file=True))
    s = sonarr.add_series(series_obj(81189, "Breaking Bad", seasons=[season_obj(1)]))
    await clients["movie"].delete_title_and_files(m["id"])
    await clients["tv"].delete_title_and_files(s["id"])
    assert radarr.deleted == [{"id": m["id"], "params": {"deleteFiles": "true", "addImportExclusion": "false"}}]
    assert sonarr.deleted == [{"id": s["id"], "params": {"deleteFiles": "true",
                                                         "addImportListExclusion": "false"}}]
    assert radarr.files_deleted == [m["id"]] and sonarr.files_deleted == [s["id"]]
    await clients["movie"].delete_title_and_files(m["id"])  # already gone: 404 counts as done
