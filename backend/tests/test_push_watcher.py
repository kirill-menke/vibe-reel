"""The push watcher (push.py): arr import history -> confirmed in Jellyfin as
each user -> one Web Push per title.

Real pieces: ArrSim (Sonarr/Radarr history/since with embedded
series/episode/movie), JellyfinSim (tests/support/jellyfin.py), pywebpush
against `responses` at https://push.test (payloads decrypted). Dates and
`time.time()` are frozen with time_machine and moved explicitly; the loop
itself (`_loop`) runs on a manual FakeClock.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from reel_api import push
from reel_api.arr import make_arr_clients
from tests.conftest import JELLYFIN, RADARR, RADARR_KEY, SONARR, SONARR_KEY
from tests.support.arr import episode_obj, movie_obj, series_obj
from tests.support.clock import FakeClock
from tests.support.jellyfin import JellyfinSim
from tests.support.qbit import make_hash
from tests.test_push_api import Browser

NOW = datetime(2026, 9, 1, 12, 0, tzinfo=timezone.utc)
PASS = timedelta(seconds=push.POLL_S)


@pytest.fixture
def frozen(time_machine):
    time_machine.move_to(NOW, tick=False)
    return time_machine


@pytest.fixture
def jf(upstream):
    return JellyfinSim(upstream, JELLYFIN)


@pytest.fixture
def make_push(reel_env, frozen, sonarr, radarr):
    key = push.generate_key()[0]

    def factory(**env):
        reel_env(**{"SONARR_URL": SONARR, "SONARR_API_KEY": SONARR_KEY, "RADARR_URL": RADARR,
                    "RADARR_API_KEY": RADARR_KEY, "JELLYFIN_URL": JELLYFIN + "/", "VAPID_PRIVATE_KEY": key,
                    "VAPID_SUBJECT": "mailto:t@example.com", **env})
        return push.Push(make_arr_clients())

    return factory


class Phone:
    """A subscribed device of a Jellyfin user, and what it received."""

    def __init__(self, p: push.Push, user, n: int, requests_mock, *, ready=True, seasons=False, created=None):
        self.browser = Browser(n)
        self.rm = requests_mock
        requests_mock.post(self.browser.endpoint, status=201)
        self.sub = {**self.browser.subscription, "user_id": user.id, "user_name": user.name, "token": user.token,
                    "device_id": f"dev-{n}", "ready": ready, "seasons": seasons,
                    "created": created if created is not None else 1000.0 + n, "last_ok": None}
        p.state["subs"][self.browser.endpoint] = self.sub

    def received(self) -> list[tuple[dict, str]]:
        """(payload, TTL header) of every push sent to this device."""
        return [(self.browser.decrypt(c.request.body), c.request.headers["TTL"])
                for c in self.rm.calls if c.request.url == self.browser.endpoint]

    def bodies(self) -> list[str]:
        return [p["body"] for p, _ in self.received()]


def shift(frozen, **kw):
    frozen.shift(timedelta(**kw))


async def started(p, frozen):
    """First tick (watermark), then one pass later."""
    await p.tick()
    shift(frozen, seconds=30)


def silo(sonarr, jf, *, eps=(1, 2, 3), in_jf=(), season=2):
    obj = sonarr.add_series(series_obj(361753, "Silo", year=2023),
                            [episode_obj(season, e, title=f"Episode {e} title") for e in eps])
    item = jf.add_series("Silo", 361753, year=2023)
    for e in in_jf:
        jf.add_episode(item, season, e)
    return obj, item


def grab_import(sonarr, sid, season, eps, seed):
    h = make_hash(seed).upper()
    ids = [sonarr.episode(sid, season, e)["id"] for e in eps]
    sonarr.grab(sid, h, episode_ids=ids)
    return sonarr.import_grab(h)


def movie_import(radarr, tmdb, title, seed, *, year=2021):
    m = radarr.add_movie(movie_obj(tmdb, title, year=year))
    h = make_hash(seed).upper()
    radarr.grab(m["id"], h)
    radarr.import_grab(h)
    return m


# ---------------------------------------------------------------- watermark / history


async def test_first_tick_only_sets_the_watermark(make_push, sonarr, radarr, jf, requests_mock, frozen):
    p = make_push()
    u = jf.add_user("anna", "tok-a")
    phone = Phone(p, u, 1, requests_mock)
    obj, item = silo(sonarr, jf, in_jf=(1,))
    shift(frozen, minutes=-10)
    grab_import(sonarr, obj["id"], 2, [1], "old")  # imported 10 minutes before start-up
    shift(frozen, minutes=10)
    await p.tick()
    assert p.state["since"] == {"tv": "2026-09-01T12:00:00Z", "movie": "2026-09-01T12:00:00Z"}
    assert not sonarr.called("/api/v3/history/since") and not radarr.called("/api/v3/history/since")
    shift(frozen, minutes=1)
    await p.tick()
    assert p.state["cands"] == [] and phone.received() == []
    assert not jf.calls  # nothing to confirm


async def test_history_query_params_and_watermark_advance(make_push, sonarr, radarr, jf, requests_mock, frozen):
    p = make_push()
    Phone(p, jf.add_user("anna", "tok-a"), 1, requests_mock)
    await started(p, frozen)
    obj, _ = silo(sonarr, jf)
    grab_import(sonarr, obj["id"], 2, [1], "w1")  # at NOW+30s
    shift(frozen, seconds=30)
    await p.tick()
    tv = sonarr.called("/api/v3/history/since")[-1].params
    mv = radarr.called("/api/v3/history/since")[-1].params
    assert tv["date"] == "2026-09-01T11:58:00Z"  # 2 minutes of overlap behind the watermark
    assert tv["includeSeries"] == "true" and tv["includeEpisode"] == "true" and "includeMovie" not in tv
    assert mv == {"date": "2026-09-01T11:58:00Z", "includeMovie": "true"}
    assert p.state["since"]["tv"] == "2026-09-01T12:00:30Z"  # the newest event
    assert p.state["since"]["movie"] == "2026-09-01T12:00:00Z"  # no events: unchanged
    # an event dated in the future (clock skew) never moves the watermark past now
    sonarr.add_history("grabbed", series_id=obj["id"], date=NOW + timedelta(hours=1))
    await p.tick()
    assert p.state["since"]["tv"] == "2026-09-01T12:01:00Z"


@pytest.mark.parametrize("broken", ["tv", "movie"])
@pytest.mark.parametrize("fault", [dict(status=500), dict(exc=httpx.ConnectError("down"))], ids=["500", "down"])
async def test_one_arrs_history_failure_does_not_stop_the_other(make_push, sonarr, radarr, jf, requests_mock,
                                                               frozen, broken, fault, caplog):
    """Each arr is its own pass: Sonarr's history call failing must not end the
    tick before Radarr's (or the other way round). The failed arr keeps its
    watermark, so its imports are picked up on the next pass."""
    p = make_push()
    phone = Phone(p, jf.add_user("anna", "tok-a"), 1, requests_mock)
    await started(p, frozen)
    since = dict(p.state["since"])
    obj, _ = silo(sonarr, jf, in_jf=(1,))
    grab_import(sonarr, obj["id"], 2, [1], "tv1")
    movie_import(radarr, 603, "The Matrix", "m1", year=1999)
    jf.add_movie("The Matrix", 603, year=1999)
    (sonarr if broken == "tv" else radarr).fail("/api/v3/history/since", **fault)
    shift(frozen, seconds=30)
    with caplog.at_level(logging.WARNING, logger="reel_api"):
        await p.tick()
    ok_body = "Ready to watch · 1999" if broken == "tv" else "S2E1 · Episode 1 title is ready to watch"
    assert phone.bodies() == [ok_body]
    assert p.state["since"][broken] == since[broken]  # retried from the same watermark
    assert f"push watcher: {broken} history: " in caplog.text
    await p.tick()
    assert sorted(phone.bodies()) == sorted(["Ready to watch · 1999", "S2E1 · Episode 1 title is ready to watch"])


async def test_seen_ids_dedupe_across_ticks(make_push, sonarr, jf, requests_mock, frozen, monkeypatch):
    p = make_push()
    phone = Phone(p, jf.add_user("anna", "tok-a"), 1, requests_mock)
    await started(p, frozen)
    obj, item = silo(sonarr, jf)
    grab_import(sonarr, obj["id"], 2, [1], "d1")
    await p.tick()  # candidate; not in Jellyfin yet
    assert len(p.state["cands"]) == 1
    await p.tick()  # the overlap returns the same events again
    await p.tick()
    assert len(p.state["cands"]) == 1
    jf.add_episode(item, 2, 1)
    await p.tick()
    assert phone.bodies() == ["S2E1 · Episode 1 title is ready to watch"]
    # the seen list is capped
    monkeypatch.setattr(push, "SEEN_KEEP", 2)
    for i in range(4):
        sonarr.add_history("grabbed", series_id=obj["id"])
    await p.tick()
    assert len(p.state["seen"]["tv"]) == 2


async def test_import_is_a_candidate_only_with_a_ready_subscriber(make_push, sonarr, jf, requests_mock, frozen):
    p = make_push()
    u = jf.add_user("anna", "tok-a")
    Phone(p, u, 1, requests_mock, ready=False, seasons=True)
    await started(p, frozen)
    obj, _ = silo(sonarr, jf, in_jf=(1,))
    grab_import(sonarr, obj["id"], 2, [1], "c1")
    await p.tick()
    assert p.state["cands"] == []
    assert len(p.state["seen"]["tv"]) == 2  # seen anyway: a later subscriber doesn't get old news
    Phone(p, u, 2, requests_mock)
    await p.tick()
    assert p.state["cands"] == []


async def test_candidates_need_ids(make_push, sonarr, radarr, jf, requests_mock, frozen):
    p = make_push()
    Phone(p, jf.add_user("anna", "tok-a"), 1, requests_mock)
    await started(p, frozen)
    # history rows whose series/episode/movie is gone (deleted since): nothing embedded
    sonarr.add_history("downloadFolderImported", series_id=999, episode_id=999)
    radarr.add_history("downloadFolderImported", movie_id=999)
    await p.tick()
    assert p.state["cands"] == []
    assert p._candidate("tv", {"series": {"tvdbId": 1}, "episode": {}}, NOW) is None
    assert p._candidate("tv", {"series": {}, "episode": {"seasonNumber": 1}}, NOW) is None
    assert p._candidate("movie", {"movie": {"title": "x"}}, NOW) is None
    c = p._candidate("tv", {"episodeId": 7, "series": {"tvdbId": 5, "title": "T"},
                            "episode": {"seasonNumber": 0, "episodeNumber": 3}}, NOW)
    assert c["s"] == 0 and c["ref"] == "tv:7" and c["gk"] == "tv:5" and c["at"] == NOW.timestamp()


# ---------------------------------------------------------------- upgrades


@pytest.mark.parametrize("kind", ["tv", "movie"])
@pytest.mark.parametrize("reason,gap_min,notified", [
    ("Upgrade", 0, False), ("upgrade", 14, False), ("Upgrade", 16, True), ("Manual", 0, True),
])
async def test_upgrade_imports_are_not_announced(make_push, sonarr, radarr, jf, requests_mock, frozen,
                                                 kind, reason, gap_min, notified):
    p = make_push()
    phone = Phone(p, jf.add_user("anna", "tok-a"), 1, requests_mock)
    await started(p, frozen)
    if kind == "tv":
        obj, _ = silo(sonarr, jf, in_jf=(1,))
        ep = sonarr.episode(obj["id"], 2, 1)
        sonarr.add_history("episodeFileDeleted", series_id=obj["id"], episode_id=ep["id"], data={"reason": reason})
        shift(frozen, minutes=gap_min)
        grab_import(sonarr, obj["id"], 2, [1], "up")
    else:
        m = radarr.add_movie(movie_obj(603, "The Matrix", year=1999))
        jf.add_movie("The Matrix", 603, year=1999)
        radarr.add_history("movieFileDeleted", movie_id=m["id"], data={"reason": reason})
        shift(frozen, minutes=gap_min)
        h = make_hash("up").upper()
        radarr.grab(m["id"], h)
        radarr.import_grab(h)
    await p.tick()
    assert bool(phone.received()) is notified
    assert p.state["cands"] == []
    if not notified:
        assert not jf.requests("/Items")  # dropped before any lookup


async def test_upgrade_records_expire(make_push, jf, frozen, sonarr):
    p = make_push()
    await started(p, frozen)
    p.state["upgrades"] = [{"k": "tv:1", "t": (NOW - timedelta(minutes=31)).timestamp()},
                           {"k": "tv:2", "t": (NOW - timedelta(minutes=29)).timestamp()}]
    await p.tick()
    assert [u["k"] for u in p.state["upgrades"]] == ["tv:2"]


# ---------------------------------------------------------------- confirm + notify


async def test_movie_confirmed_then_notified(make_push, radarr, jf, requests_mock, frozen):
    p = make_push()
    u = jf.add_user("anna", "tok-a")
    phone = Phone(p, u, 1, requests_mock)
    await started(p, frozen)
    movie_import(radarr, 603, "The Matrix", "m1", year=1999)
    await p.tick()  # imported, Jellyfin's scan hasn't picked it up yet
    assert phone.received() == [] and len(p.state["cands"]) == 1
    item = jf.add_movie("The Matrix", 603, year=1999)
    shift(frozen, minutes=1)
    await p.tick()
    [(payload, ttl)] = phone.received()
    assert ttl == str(push.TTL_READY)
    assert payload == {"title": "The Matrix", "body": "Ready to watch · 1999", "tag": "ready:movie:603",
                       "open": {"type": "item", "id": item.id, "itemType": "Movie"}}
    params, token = jf.requests("/Items")[-1]
    assert token == "tok-a" and params["userId"] == u.id
    assert params["IncludeItemTypes"] == "Movie" and params["SearchTerm"] == "The Matrix"
    assert params["Fields"] == "ProviderIds" and params["Recursive"] == "true"
    assert p.state["cands"] == [] and p.state["sent"][u.id] == ["movie:603"]
    assert phone.sub["last_ok"] is not None


async def test_movie_matched_by_name_when_provider_ids_differ(make_push, radarr, jf, requests_mock, frozen):
    p = make_push()
    phone = Phone(p, jf.add_user("anna", "tok-a"), 1, requests_mock)
    await started(p, frozen)
    jf.add_movie("Amélie The Movie Returns", 42)  # found by the search, but another id and name: skipped
    jf.add_movie("Amélie: The Movie", None, year=None)  # no ids, other punctuation
    movie_import(radarr, 194, "Amélie The Movie", "am")
    await p.tick()
    [(payload, _)] = phone.received()
    assert payload["title"] == "Amélie: The Movie" and payload["body"] == "Ready to watch"


async def test_each_user_confirms_with_their_own_token(make_push, radarr, jf, requests_mock, frozen):
    p = make_push()
    anna, ben = jf.add_user("anna", "tok-a"), jf.add_user("ben", "tok-b")
    pa1, pa2 = Phone(p, anna, 1, requests_mock), Phone(p, anna, 2, requests_mock, created=5000.0)
    pb = Phone(p, ben, 3, requests_mock)
    pa2.sub["token"] = "tok-a"  # the newest subscription's token is the one used
    pa1.sub["token"] = "tok-a-stale"
    await started(p, frozen)
    jf.add_movie("Kids Film", 11, visible_to={anna.id})  # ben's library access doesn't include it
    movie_import(radarr, 11, "Kids Film", "k")
    await p.tick()
    assert len(pa1.received()) == 1 and len(pa2.received()) == 1  # every device of anna
    assert pb.received() == []
    assert {t for _, t in jf.requests("/Items")} == {"tok-a", "tok-b"}
    assert len(p.state["cands"]) == 1  # still waiting for ben
    assert p.state["cands"][0]["done"] == [anna.id]
    await p.tick()
    assert len(pa1.received()) == 1  # not twice


async def test_played_titles_never_notify(make_push, sonarr, radarr, jf, requests_mock, frozen):
    p = make_push()
    u = jf.add_user("anna", "tok-a")
    phone = Phone(p, u, 1, requests_mock)
    await started(p, frozen)
    m = jf.add_movie("Seen It", 77)
    jf.mark_played(u, m.id)
    movie_import(radarr, 77, "Seen It", "s")
    obj, item = silo(sonarr, jf, eps=(1, 2), in_jf=(1, 2))
    jf.mark_played(u, item.episodes[0]["id"])
    grab_import(sonarr, obj["id"], 2, [1, 2], "e")
    await p.tick()
    assert phone.bodies() == ["S2E2 · Episode 2 title is ready to watch"]
    assert p.state["cands"] == []


async def test_episodes_of_one_series_merge(make_push, sonarr, jf, requests_mock, frozen):
    p = make_push()
    u = jf.add_user("anna", "tok-a")
    phone = Phone(p, u, 1, requests_mock)
    await started(p, frozen)
    obj, item = silo(sonarr, jf, in_jf=(1, 2, 3))
    grab_import(sonarr, obj["id"], 2, [1, 2, 3], "pack")
    await p.tick()
    [(payload, _)] = phone.received()
    assert payload == {"title": "Silo", "body": "Season 2 · 3 new episodes are ready to watch",
                       "tag": "ready:tv:361753", "open": {"type": "item", "id": item.id, "itemType": "Series"}}
    params, token = jf.requests(f"/Shows/{item.id}/Episodes")[-1]
    assert params == {"userId": u.id, "IsMissing": "false", "Fields": "DateCreated"} and token == "tok-a"
    assert sorted(p.state["sent"][u.id]) == ["tv:361753:2x1", "tv:361753:2x2", "tv:361753:2x3"]


async def test_episodes_across_seasons_merge_without_a_season(make_push, sonarr, jf, requests_mock, frozen):
    p = make_push()
    phone = Phone(p, jf.add_user("anna", "tok-a"), 1, requests_mock)
    await started(p, frozen)
    obj = sonarr.add_series(series_obj(5, "Two Seasons"), [episode_obj(1, 9), episode_obj(2, 1)])
    item = jf.add_series("Two Seasons", 5)
    jf.add_episode(item, 1, 9)
    jf.add_episode(item, 2, 1)
    h = make_hash("two").upper()
    sonarr.grab(obj["id"], h, episode_ids=[sonarr.episode(obj["id"], 1, 9)["id"], sonarr.episode(obj["id"], 2, 1)["id"]])
    sonarr.import_grab(h)
    await p.tick()
    assert phone.bodies() == ["2 new episodes are ready to watch"]


async def test_multi_episode_file_matches_index_number_end(make_push, sonarr, jf, requests_mock, frozen):
    p = make_push()
    phone = Phone(p, jf.add_user("anna", "tok-a"), 1, requests_mock)
    await started(p, frozen)
    obj, item = silo(sonarr, jf, eps=(1, 2))
    jf.add_episode(item, 2, 1, end=2)  # one file "S02E01-E02"
    grab_import(sonarr, obj["id"], 2, [1, 2], "double")
    await p.tick()
    assert phone.bodies() == ["Season 2 · 2 new episodes are ready to watch"]


async def test_a_missing_sibling_holds_the_batch(make_push, sonarr, jf, requests_mock, frozen):
    p = make_push()
    phone = Phone(p, jf.add_user("anna", "tok-a"), 1, requests_mock)
    await started(p, frozen)
    obj, item = silo(sonarr, jf, eps=(1, 2, 3), in_jf=(1,))
    grab_import(sonarr, obj["id"], 2, [1, 2], "batch")
    await p.tick()
    assert phone.received() == []  # E1 is in, E2 isn't yet
    assert all(c["done"] == [] for c in p.state["cands"])
    shift(frozen, seconds=push.HOLD_SIBLINGS_S - 30)
    jf.add_episode(item, 2, 2)
    await p.tick()
    assert phone.bodies() == ["Season 2 · 2 new episodes are ready to watch"]


async def test_held_episode_goes_alone_after_the_hold(make_push, sonarr, jf, requests_mock, frozen):
    p = make_push()
    phone = Phone(p, jf.add_user("anna", "tok-a"), 1, requests_mock)
    await started(p, frozen)
    obj, item = silo(sonarr, jf, eps=(1, 2), in_jf=(1,))
    grab_import(sonarr, obj["id"], 2, [1, 2], "batch")
    await p.tick()
    shift(frozen, seconds=push.HOLD_SIBLINGS_S - 1)
    await p.tick()
    assert phone.received() == []
    shift(frozen, seconds=2)
    await p.tick()
    assert phone.bodies() == ["S2E1 · Episode 1 title is ready to watch"]
    assert len(p.state["cands"]) == 1  # E2 keeps waiting on its own
    jf.add_episode(item, 2, 2)
    await p.tick()
    assert phone.bodies()[1:] == ["S2E2 · Episode 2 title is ready to watch"]


async def test_unconfirmed_candidates_are_dropped(make_push, radarr, jf, requests_mock, frozen):
    p = make_push()
    phone = Phone(p, jf.add_user("anna", "tok-a"), 1, requests_mock)
    await started(p, frozen)
    movie_import(radarr, 9, "Never Scanned", "n")
    await p.tick()
    shift(frozen, seconds=push.CONFIRM_FOR_S - 1)
    await p.tick()
    assert len(p.state["cands"]) == 1
    shift(frozen, seconds=2)
    await p.tick()
    assert p.state["cands"] == []
    jf.add_movie("Never Scanned", 9)
    await p.tick()
    assert phone.received() == []


@pytest.mark.parametrize("where", ["/Items", "episodes"])
async def test_jellyfin_401_drops_that_users_subscriptions(make_push, sonarr, jf, requests_mock, frozen, where, caplog):
    p = make_push()
    anna, ben = jf.add_user("anna", "tok-a"), jf.add_user("ben", "tok-b")
    pa1, pa2, pb = Phone(p, anna, 1, requests_mock), Phone(p, anna, 2, requests_mock), Phone(p, ben, 3, requests_mock)
    await started(p, frozen)
    obj, item = silo(sonarr, jf, in_jf=(1,))
    grab_import(sonarr, obj["id"], 2, [1], "x")
    jf.fail("/Items" if where == "/Items" else f"/Shows/{item.id}/Episodes", status=401)  # anna goes first
    with caplog.at_level(logging.INFO, logger="reel_api"):
        await p.tick()
    assert set(p.state["subs"]) == {pb.browser.endpoint}
    assert pa1.received() == [] and pa2.received() == []
    assert pb.bodies() == ["S2E1 · Episode 1 title is ready to watch"]
    assert "rejected the token" in caplog.text
    assert p.state["cands"] == []  # every live user is done


async def test_jellyfin_errors_retry_next_pass(make_push, radarr, jf, requests_mock, frozen):
    p = make_push()
    phone = Phone(p, jf.add_user("anna", "tok-a"), 1, requests_mock)
    await started(p, frozen)
    jf.add_movie("Flaky", 31)
    movie_import(radarr, 31, "Flaky", "f")
    jf.fail("/Items", status=500)
    await p.tick()
    assert phone.received() == [] and len(p.state["cands"]) == 1
    jf.fail("/Items", exc=httpx.ConnectError("down"))
    await p.tick()
    assert phone.received() == []
    await p.tick()
    assert phone.bodies() == ["Ready to watch · 2021"]


async def test_each_title_notifies_once_per_user(make_push, sonarr, radarr, jf, requests_mock, frozen, monkeypatch):
    p = make_push()
    u = jf.add_user("anna", "tok-a")
    phone = Phone(p, u, 1, requests_mock)
    await started(p, frozen)
    obj, item = silo(sonarr, jf, in_jf=(1,))
    grab_import(sonarr, obj["id"], 2, [1], "first")
    await p.tick()
    assert len(phone.received()) == 1
    # a manual re-import of the same episode (no Upgrade deletion): already sent
    shift(frozen, minutes=1)
    grab_import(sonarr, obj["id"], 2, [1], "again")
    await p.tick()
    assert len(phone.received()) == 1
    assert p.state["cands"] == []
    # the sent list is capped
    monkeypatch.setattr(push, "SENT_KEEP", 1)
    jf.add_movie("Other", 8)
    movie_import(radarr, 8, "Other", "o")
    await p.tick()
    assert p.state["sent"][u.id] == ["movie:8"]


async def test_a_gone_device_is_removed_while_notifying(make_push, radarr, jf, requests_mock, frozen):
    p = make_push()
    u = jf.add_user("anna", "tok-a")
    gone, ok = Phone(p, u, 1, requests_mock), Phone(p, u, 2, requests_mock)
    requests_mock.replace("POST", gone.browser.endpoint, status=410)
    await started(p, frozen)
    jf.add_movie("Film", 4)
    movie_import(radarr, 4, "Film", "g")
    await p.tick()
    assert set(p.state["subs"]) == {ok.browser.endpoint}
    assert len(ok.received()) == 1


async def test_state_round_trips_through_push_json(make_push, radarr, jf, requests_mock, frozen):
    p = make_push()
    Phone(p, jf.add_user("anna", "tok-a"), 1, requests_mock)
    await started(p, frozen)
    movie_import(radarr, 21, "Pending", "p")
    await p.tick()
    p._save()
    q = make_push()  # a restart: the candidate, watermark and seen ids come back
    assert q.state["cands"] == p.state["cands"] and q.state["since"] == p.state["since"]
    assert q.state["seen"] == p.state["seen"]
    jf.add_movie("Pending", 21)
    await q.tick()
    assert len([c for c in requests_mock.calls if c.request.url.startswith("https://push.test")]) == 1


# ---------------------------------------------------------------- the loop


@pytest.fixture
def loop_push(make_push, monkeypatch):
    clock = FakeClock(auto=False)
    p = make_push()
    clock.install(monkeypatch, push)
    calls = []

    async def tick():
        calls.append(("tick", clock.t))
        if len([c for c in calls if c[0] == "tick"]) == 2:
            raise RuntimeError("arr down")

    async def news_tick():
        calls.append(("news", clock.t))

    monkeypatch.setattr(p, "tick", tick)
    monkeypatch.setattr(p, "news_tick", news_tick)
    yield p, clock, calls
    if p.task is not None:
        p.task.cancel()


async def test_loop_schedule(loop_push, reel_env, caplog):
    p, clock, calls = loop_push
    t0 = clock.t
    p.start()
    first = p.task
    p.start()
    assert p.task is first  # only one watcher
    await clock.settle(20)
    assert clock.pending_sleepers == 1 and clock.sleeps == [15]
    await clock.advance(14.9, settle=50)
    assert calls == []
    await clock.advance(0.1, settle=50)
    assert calls == [("tick", t0 + 15), ("news", t0 + 15)]
    assert (reel_env.state / "push.json").exists()  # saved after every pass
    for _ in range(11):
        await clock.advance(push.POLL_S, settle=50)
    ticks = [t - t0 for k, t in calls if k == "tick"]
    news = [t - t0 for k, t in calls if k == "news"]
    assert ticks == [15 + i * push.POLL_S for i in range(12)]
    # pass 2 raised inside tick (its news check never ran); news again once NEWS_POLL_S passed
    assert news == [15, 15 + push.NEWS_POLL_S]
    assert "push watcher: arr down" in caplog.text
    assert not p.task.done()


async def test_loop_survives_a_save_failure_and_stops_on_cancel(loop_push, monkeypatch):
    p, clock, calls = loop_push

    def boom():
        raise ValueError("disk")

    monkeypatch.setattr(p, "_save", boom)
    p.start()
    await clock.settle(20)
    await clock.advance(15, settle=50)
    await clock.advance(push.POLL_S, settle=50)
    assert len([c for c in calls if c[0] == "tick"]) == 2
    p.task.cancel()
    await clock.settle(20)
    assert p.task.cancelled()


async def test_no_watcher_without_a_key(make_push):
    p = make_push(VAPID_PRIVATE_KEY=None)
    p.start()
    assert p.task is None and not p.enabled


async def test_cancel_during_a_pass_propagates(loop_push, monkeypatch):
    import asyncio

    p, clock, calls = loop_push
    entered = asyncio.Event()

    async def hang():
        entered.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(p, "tick", hang)
    p.start()
    await clock.settle(20)
    await clock.advance(15, settle=50)
    assert entered.is_set()
    p.task.cancel()
    await clock.settle(20)
    assert p.task.cancelled()  # not swallowed by the "a failed pass only logs" handler
    assert not p.lock.locked()


async def test_bad_dates_in_state_or_history(make_push, sonarr, jf, requests_mock, frozen):
    p = make_push()
    phone = Phone(p, jf.add_user("anna", "tok-a"), 1, requests_mock)
    p.state["since"] = {"tv": "yesterday-ish", "movie": ""}
    await p.tick()  # an unreadable watermark counts as a first start
    assert p.state["since"] == {"tv": "2026-09-01T12:00:00Z", "movie": "2026-09-01T12:00:00Z"}
    shift(frozen, seconds=30)
    obj, item = silo(sonarr, jf, in_jf=(1,))
    [ev] = grab_import(sonarr, obj["id"], 2, [1], "bad")
    ev["date"] = "garbage"  # an import whose date can't be read counts as "now"
    shift(frozen, seconds=30)
    await p.tick()
    assert phone.bodies() == ["S2E1 · Episode 1 title is ready to watch"]
    assert p.state["since"]["tv"] == "2026-09-01T12:01:00Z"
    assert push._parse("not a date") is None and push._parse(None) is None
