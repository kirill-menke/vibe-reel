"""push.py details the earlier push tests reached only loosely — found by the
T41 mutation pass (tests/run_mutmut.sh push): exact error bodies and log
lines, the watcher's boundaries (upgrade window, sibling hold, confirm
window, upgrade-record expiry), matching a Jellyfin item by provider id when
the names differ, one group's trouble not stopping the others, the payload's
fallbacks, defaults (state dir, Jellyfin URL), and base64url/ISO helpers.
Builds on the harness of test_push_watcher.py / test_push_api.py."""

from __future__ import annotations

import base64
import json
import logging
import time
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from reel_api import push, statefile
from tests.support.arr import episode_obj, movie_obj, series_obj
from tests.support.clock import FakeClock
from tests.support.qbit import make_hash
from tests.test_push_api import Browser, push_api, sub_body, vapid  # noqa: F401 (fixtures)
from tests.test_push_watcher import (  # noqa: F401 (fixtures)
    NOW, Phone, frozen, grab_import, jf, make_push, movie_import, shift, silo, started,
)


def msgs(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.name == "reel_api"]


@pytest.fixture
def jf_me(upstream):
    from tests.conftest import JELLYFIN

    state = {"me": {"Id": "0123456789abcdef0123456789abcdef", "Name": "Kirill"}}

    def handler(request):
        if 'Token="tok"' in request.headers.get("Authorization", ""):
            return httpx.Response(200, json=state["me"])
        return httpx.Response(401)

    state["route"] = upstream.get(f"{JELLYFIN}/Users/Me").mock(side_effect=handler)
    return state


# ---------------------------------------------------------------- HTTP: exact bodies


async def test_subscribe_error_bodies(push_api, jf_me, upstream, caplog):  # noqa: F811
    from tests.conftest import JELLYFIN

    b = Browser()
    async with push_api() as api:
        r = await api.post("/api/push/subscribe", json={"subscription": b.subscription})
        assert r.json() == {"error": "bad_request", "detail": "subscription and token required"}
        r = await api.post("/api/push/subscribe", json=sub_body(b, token="nope"))
        assert r.json() == {"error": "unauthorized", "detail": "Jellyfin rejected the token"}
        r = await api.post("/api/push/subscribe", json=sub_body(b, user_id="f" * 32))
        assert r.json() == {"error": "forbidden", "detail": "token belongs to another user"}
        r = await api.post("/api/push/test", json={"endpoint": "https://push.test/nobody"})
        assert r.json() == {"error": "not_found", "detail": "not subscribed"}
        upstream.get(f"{JELLYFIN}/Users/Me").mock(side_effect=httpx.ConnectError("jf down"))
        r = await api.post("/api/push/subscribe", json=sub_body(b))
        assert r.json() == {"error": "temporarily_unavailable", "detail": "Jellyfin unreachable"}
    assert "push: Jellyfin check failed: jf down" in msgs(caplog)


async def test_test_notification_text(push_api, jf_me, requests_mock):  # noqa: F811
    b = Browser()
    requests_mock.post(b.endpoint, status=201)
    async with push_api() as api:
        await api.post("/api/push/subscribe", json=sub_body(b))
        assert (await api.post("/api/push/test", json={"endpoint": b.endpoint})).json() == {"ok": True}
    payload = b.decrypt(requests_mock.calls[-1].request.body)
    assert payload == {"title": "VibeReel", "tag": "test", "open": {"type": "home"},
                       "body": "Notifications work. You’ll hear from VibeReel when a download is ready to watch."}


async def test_a_3xx_from_the_push_service_is_a_failure(push_api, jf_me, requests_mock):  # noqa: F811
    b = Browser()
    requests_mock.post(b.endpoint, status=300, body="moved")
    async with push_api() as api:
        await api.post("/api/push/subscribe", json=sub_body(b))
        r = await api.post("/api/push/test", json={"endpoint": b.endpoint})
    assert r.status_code == 502 and r.json()["detail"] == "push service answered 300"
    assert push._push.state["subs"][b.endpoint]["last_ok"] is None


async def test_subscribe_without_a_user_name_or_device(push_api, jf_me, reel_env):  # noqa: F811
    jf_me["me"] = {"Id": "0123456789abcdef0123456789abcdef"}
    b1, b2 = Browser(1), Browser(2)
    async with push_api() as api:
        r = await api.post("/api/push/subscribe", json={"subscription": b1.subscription, "token": "tok"})
        assert r.json() == {"ok": True, "user": ""}
        await api.post("/api/push/subscribe", json={"subscription": b2.subscription, "token": "tok"})
    subs = json.loads((reel_env.state / "push.json").read_text())["subs"]
    assert set(subs) == {b1.endpoint, b2.endpoint}  # no device id: not one device
    assert subs[b1.endpoint]["device_id"] == "" and subs[b1.endpoint]["user_name"] == ""


async def test_start_hands_the_arr_clients_to_the_watcher(push_api):  # noqa: F811
    async with push_api() as api:
        assert push._push.arr is api.app_module.arr_clients


# ---------------------------------------------------------------- construction


def test_defaults_and_warnings(reel_env, caplog):
    caplog.set_level(logging.INFO, logger="reel_api")
    reel_env(JELLYFIN_URL=None, VAPID_PRIVATE_KEY=None, VAPID_SUBJECT=None)
    p = push.Push({})
    assert p.jf == "http://127.0.0.1:8096"
    assert p.http.timeout == httpx.Timeout(20)
    assert msgs(caplog) == []  # no key: no subject warning either
    reel_env(VAPID_PRIVATE_KEY=push.generate_key()[0], VAPID_SUBJECT="mailto:x@example.com")
    push.Push({})
    assert msgs(caplog) == []
    reel_env(VAPID_SUBJECT=None)
    push.Push({})
    assert msgs(caplog) == ["push: VAPID_SUBJECT unset — Apple's push service may reject mailto:admin@localhost"]
    reel_env(VAPID_PRIVATE_KEY="!!", VAPID_SUBJECT="mailto:x@example.com")
    caplog.clear()
    push.Push({})
    (m,) = msgs(caplog)
    assert m.startswith("push: VAPID_PRIVATE_KEY unusable (") and m.endswith(") — push disabled")
    assert "None" not in m and "()" not in m


def test_disabled_log_line(reel_env, caplog):
    caplog.set_level(logging.INFO, logger="reel_api")
    reel_env(VAPID_PRIVATE_KEY=None)
    push.start({})
    assert msgs(caplog) == ["push: VAPID_PRIVATE_KEY not set — /api/push disabled"]


def test_state_dir_fallbacks(reel_env, monkeypatch, tmp_path):
    reel_env(STATE_DIRECTORY=None)
    assert push._state_dir() == reel_env.cache
    reel_env(CACHE_DIRECTORY=None, TMPDIR=str(tmp_path / "t"))
    assert push._state_dir() == tmp_path / "t" / "reel-api-state"
    assert (tmp_path / "t" / "reel-api-state").is_dir()


def test_state_dir_default_tmp(reel_env, monkeypatch):
    reel_env(STATE_DIRECTORY=None, CACHE_DIRECTORY=None)
    monkeypatch.delenv("TMPDIR")
    made = []
    monkeypatch.setattr(statefile.Path, "mkdir", lambda self, **kw: made.append(self))  # statefile.py since 2026-10
    assert push._state_dir() == statefile.Path("/tmp/reel-api-state")
    assert made == [statefile.Path("/tmp/reel-api-state")]


def test_load_fills_missing_keys(reel_env):
    (reel_env.state / "push.json").write_text(json.dumps({"news": ["x"]}))
    p = push.Push({})
    assert p.state == {"subs": {}, "since": {}, "seen": {}, "cands": [], "upgrades": [], "sent": {}, "news": ["x"]}


def test_save_failure_is_logged(reel_env, caplog, monkeypatch):
    p = push.Push({})
    monkeypatch.setattr(push.os, "replace", lambda *a: (_ for _ in ()).throw(OSError("ro fs")))
    p._save()
    assert msgs(caplog) == ["push: could not save state: ro fs"]


# ---------------------------------------------------------------- sending


def _fake_webpush(monkeypatch, *, raise_=None):
    import pywebpush

    seen = {}

    def fake(**kw):
        seen.update(kw)
        if raise_:
            raise raise_

    monkeypatch.setattr(pywebpush, "webpush", fake)
    return seen


def test_send_sync_contract(make_push, monkeypatch):  # noqa: F811
    p = make_push()
    seen = _fake_webpush(monkeypatch)
    sub = {**Browser().subscription, "user_id": "u"}
    assert p._send_sync(sub, {"a": 1}, 77) == 201
    assert seen["timeout"] == 15 and seen["ttl"] == 77 and seen["data"] == '{"a": 1}'
    assert seen["subscription_info"] == {"endpoint": sub["endpoint"], "keys": sub["keys"]}


def test_send_sync_failures_are_logged(make_push, monkeypatch, caplog):  # noqa: F811
    from pywebpush import WebPushException

    p = make_push()
    sub = Browser().subscription
    _fake_webpush(monkeypatch, raise_=WebPushException("encryption broke"))
    assert p._send_sync(sub, {}, 1) == 0
    assert msgs(caplog)[-1] == "push: push.test answered 0: WebPushException: encryption broke"
    resp = type("R", (), {"status_code": 500, "text": "e" * 300})()
    _fake_webpush(monkeypatch, raise_=WebPushException("x", response=resp))
    assert p._send_sync(sub, {}, 1) == 500
    assert msgs(caplog)[-1] == "push: push.test answered 500: " + "e" * 200
    _fake_webpush(monkeypatch, raise_=OSError("no route"))
    assert p._send_sync(sub, {}, 1) == 0
    assert msgs(caplog)[-1] == "push: send failed: no route"


async def test_gone_device_is_logged_and_survives_a_second_send(make_push, jf, requests_mock, frozen, sonarr,  # noqa: F811
                                                                radarr, caplog):
    """Two titles ready in one pass for a user whose device is gone: the
    second send to it must not trip over the already-removed subscription."""
    caplog.set_level(logging.INFO, logger="reel_api")
    p = make_push()
    u = jf.add_user("anna", "tok-a")
    gone, ok = Phone(p, u, 1, requests_mock), Phone(p, u, 2, requests_mock)
    requests_mock.replace("POST", gone.browser.endpoint, status=410)
    await started(p, frozen)
    jf.add_movie("Alien", 1)
    jf.add_movie("Aliens", 2)
    movie_import(radarr, 1, "Alien", "a1")
    movie_import(radarr, 2, "Aliens", "a2")
    await p.tick()
    assert [pl["title"] for pl, _ in ok.received()] == ["Alien", "Aliens"]
    assert set(p.state["subs"]) == {ok.browser.endpoint}
    assert "push: subscription gone (410), removed" in msgs(caplog)


# ---------------------------------------------------------------- the watcher


async def test_found_by_provider_id_when_the_names_differ(make_push, sonarr, radarr, jf, requests_mock, frozen):  # noqa: F811
    p = make_push()
    u = jf.add_user("anna", "tok-a")
    phone = Phone(p, u, 1, requests_mock)
    await started(p, frozen)
    obj = sonarr.add_series(series_obj(361753, "Silo"), [episode_obj(2, 1, title="Freedom Day")])
    item = jf.add_series("Silo (2023)", 361753)
    jf.add_episode(item, 2, 1)
    grab_import(sonarr, obj["id"], 2, [1], "s")
    jf.add_movie("Dune (2021)", 438631)
    movie_import(radarr, 438631, "Dune", "d")
    await p.tick()
    assert [pl["title"] for pl, _ in phone.received()] == ["Silo (2023)", "Dune (2021)"]
    params = [q for q, _ in jf.requests("/Items")]
    assert [(q["SearchTerm"], q["Limit"], q["IncludeItemTypes"]) for q in params] == [
        ("Silo", "20", "Series"), ("Dune", "20", "Movie")]


async def test_another_kinds_provider_id_does_not_match(make_push, radarr, jf, requests_mock, frozen):  # noqa: F811
    p = make_push()
    phone = Phone(p, jf.add_user("anna", "tok-a"), 1, requests_mock)
    await started(p, frozen)
    it = jf.add_movie("Dune (2021)", None)
    it.provider_ids = {"Tvdb": "438631"}  # a tvdb id equal to the movie's tmdb id
    movie_import(radarr, 438631, "Dune", "d")
    await p.tick()
    assert phone.received() == []


async def test_titles_missing_in_the_arr_fall_back(make_push, sonarr, radarr, jf, requests_mock, frozen):  # noqa: F811
    """No series/movie/episode title in the arr's history: search with an
    empty term (provider ids still match), no " · title" in the body."""
    p = make_push()
    phone = Phone(p, jf.add_user("anna", "tok-a"), 1, requests_mock)
    await started(p, frozen)
    obj = sonarr.add_series(series_obj(361753, "Silo"), [episode_obj(2, 1)])
    sonarr.titles[obj["id"]]["title"] = ""
    sonarr.episodes[sonarr.episode(obj["id"], 2, 1)["id"]]["title"] = ""
    item = jf.add_series("Silo", 361753)
    jf.add_episode(item, 2, 1)
    grab_import(sonarr, obj["id"], 2, [1], "s")
    await p.tick()
    assert phone.bodies() == ["S2E1 is ready to watch"]
    assert jf.requests("/Items")[0][0]["SearchTerm"] == ""


async def test_payload_fallbacks_without_name_or_type(make_push, jf, requests_mock):  # noqa: F811
    p = make_push()
    u = jf.add_user("anna", "tok-a")
    phone = Phone(p, u, 1, requests_mock)
    tv = {"kind": "tv", "gk": "tv:5", "title": "Arr Title", "s": 1, "e": 2, "ep_title": "Pilot"}
    await p._notify_ready(u.id, [phone.sub], {"Id": "x1"}, [tv])
    mv = {"kind": "movie", "gk": "movie:9", "title": "Arr Movie"}
    await p._notify_ready(u.id, [phone.sub], {"Id": "x2"}, [mv])
    (a, _), (b, _) = phone.received()
    assert a == {"title": "Arr Title", "body": "S1E2 · Pilot is ready to watch", "tag": "ready:tv:5",
                 "open": {"type": "item", "id": "x1", "itemType": "Series"}}
    assert b == {"title": "Arr Movie", "body": "Ready to watch", "tag": "ready:movie:9",
                 "open": {"type": "item", "id": "x2", "itemType": "Movie"}}


async def test_ready_log_line(make_push, radarr, jf, requests_mock, frozen, caplog):  # noqa: F811
    caplog.set_level(logging.INFO, logger="reel_api")
    p = make_push()
    u = jf.add_user("anna", "tok-a")
    Phone(p, u, 1, requests_mock)
    await started(p, frozen)
    jf.add_movie("Alien", 1)
    movie_import(radarr, 1, "Alien", "a1")
    await p.tick()
    assert f"push: ready Alien (1) -> user {u.id}" in msgs(caplog)


async def test_an_unnumbered_jellyfin_episode_confirms_nothing(make_push, sonarr, jf, requests_mock, frozen,  # noqa: F811
                                                                monkeypatch):  # noqa: F811
    p = make_push()
    phone = Phone(p, jf.add_user("anna", "tok-a"), 1, requests_mock)
    await started(p, frozen)
    obj, item = silo(sonarr, jf, eps=(1, 2))
    jf.add_episode(item, 2, 99)  # served without an IndexNumber (below)
    jf.add_episode(item, 2, 3, end=4)  # a later double episode: not E2
    real = jf._episodes

    def episodes(user, sid, params):
        r = real(user, sid, params)
        body = r.json()
        for e in body["Items"]:
            if e["IndexNumber"] == 99:
                del e["IndexNumber"]
        return httpx.Response(200, json=body)

    monkeypatch.setattr(jf, "_episodes", episodes)
    grab_import(sonarr, obj["id"], 2, [1], "e1")
    grab_import(sonarr, obj["id"], 2, [2], "e2")
    await p.tick()
    assert phone.received() == []


async def test_a_missing_first_sibling_does_not_hide_the_rest(make_push, sonarr, jf, requests_mock, frozen):  # noqa: F811
    p = make_push()
    phone = Phone(p, jf.add_user("anna", "tok-a"), 1, requests_mock)
    await started(p, frozen)
    obj, item = silo(sonarr, jf, eps=(1, 2), in_jf=(2,))
    grab_import(sonarr, obj["id"], 2, [1, 2], "batch")  # E1 first in the batch, not scanned yet
    await p.tick()
    shift(frozen, seconds=push.HOLD_SIBLINGS_S)  # the hold ends at exactly HOLD_SIBLINGS_S
    await p.tick()
    assert phone.bodies() == ["S2E2 · Episode 2 title is ready to watch"]


async def test_one_held_or_missing_title_does_not_stop_the_next(make_push, sonarr, radarr, jf, requests_mock, frozen):  # noqa: F811
    p = make_push()
    phone = Phone(p, jf.add_user("anna", "tok-a"), 1, requests_mock)
    await started(p, frozen)
    obj, item = silo(sonarr, jf, eps=(1, 2), in_jf=(1,))
    grab_import(sonarr, obj["id"], 2, [1, 2], "held")  # Silo: held for E2
    movie_import(radarr, 7, "Not Scanned", "n")  # not in Jellyfin yet
    jf.add_movie("Alien", 1)
    movie_import(radarr, 1, "Alien", "a1")
    await p.tick()
    assert [pl["title"] for pl, _ in phone.received()] == ["Alien"]


async def test_one_users_jellyfin_error_does_not_stop_the_others(make_push, radarr, jf, requests_mock, frozen,  # noqa: F811
                                                                 caplog):
    caplog.set_level(logging.INFO, logger="reel_api")
    p = make_push()
    anna, ben = jf.add_user("anna", "tok-a"), jf.add_user("ben", "tok-b")
    pa, pb = Phone(p, anna, 1, requests_mock), Phone(p, ben, 2, requests_mock)
    await started(p, frozen)
    jf.add_movie("Alien", 1)
    movie_import(radarr, 1, "Alien", "a1")
    jf.fail("/Items", status=500)  # anna's lookup (first)
    await p.tick()
    assert pa.received() == [] and len(pb.received()) == 1
    (m,) = [m for m in msgs(caplog) if m.startswith("push: Jellyfin lookup failed (")]
    assert m.endswith("), retrying next pass") and "500" in m


async def test_jellyfin_token_drop_is_logged(make_push, radarr, jf, requests_mock, frozen, caplog):  # noqa: F811
    caplog.set_level(logging.INFO, logger="reel_api")
    p = make_push()
    anna = jf.add_user("anna", "tok-a")
    Phone(p, anna, 1, requests_mock)
    await started(p, frozen)
    movie_import(radarr, 1, "Alien", "a1")
    jf.fail("/Items", status=401)
    await p.tick()
    assert f"push: Jellyfin rejected the token of user {anna.id} — dropping their subscriptions" in msgs(caplog)


async def test_confirm_window_ends_at_exactly_confirm_for(make_push, radarr, jf, requests_mock, frozen):  # noqa: F811
    p = make_push()
    Phone(p, jf.add_user("anna", "tok-a"), 1, requests_mock)
    await started(p, frozen)
    movie_import(radarr, 9, "Never Scanned", "n")
    await p.tick()
    shift(frozen, seconds=push.CONFIRM_FOR_S)
    await p.tick()
    assert p.state["cands"] == []


async def test_upgrade_window_includes_its_edge(make_push, radarr, jf, requests_mock, frozen):  # noqa: F811
    p = make_push()
    phone = Phone(p, jf.add_user("anna", "tok-a"), 1, requests_mock)
    await started(p, frozen)
    m = radarr.add_movie(movie_obj(1, "Alien"))
    jf.add_movie("Alien", 1)
    radarr.add_history("movieFileDeleted", movie_id=m["id"], data={"reason": "Upgrade"})
    shift(frozen, seconds=push.UPGRADE_WINDOW_S)  # imported exactly one window after the delete
    h = make_hash("up").upper()
    radarr.grab(m["id"], h)
    radarr.import_grab(h)
    await p.tick()
    assert phone.received() == []


async def test_a_movie_upgrade_only_silences_that_movie(make_push, radarr, jf, requests_mock, frozen):  # noqa: F811
    p = make_push()
    phone = Phone(p, jf.add_user("anna", "tok-a"), 1, requests_mock)
    await started(p, frozen)
    old = radarr.add_movie(movie_obj(1, "Alien"))
    jf.add_movie("Alien", 1)
    jf.add_movie("Aliens", 2)
    radarr.add_history("movieFileDeleted", movie_id=old["id"], data={"reason": "Upgrade"})
    h = make_hash("up").upper()
    radarr.grab(old["id"], h)
    radarr.import_grab(h)
    movie_import(radarr, 2, "Aliens", "fresh")
    await p.tick()
    assert [pl["title"] for pl, _ in phone.received()] == ["Aliens"]


async def test_upgrade_records_expire_after_exactly_two_windows(make_push, jf, frozen, sonarr):  # noqa: F811
    p = make_push()
    await started(p, frozen)
    edge = time.time() - 2 * push.UPGRADE_WINDOW_S
    p.state["upgrades"] = [{"k": "tv:1", "t": edge}, {"k": "tv:2", "t": edge + 1}]
    await p.tick()
    assert [u["k"] for u in p.state["upgrades"]] == ["tv:2"]


async def test_a_grab_is_not_an_import(make_push, sonarr, jf, requests_mock, frozen):  # noqa: F811
    """Only downloadFolderImported events are candidates: a grab of an
    episode Jellyfin already has (an upgrade on its way) notifies nothing."""
    p = make_push()
    phone = Phone(p, jf.add_user("anna", "tok-a"), 1, requests_mock)
    await started(p, frozen)
    obj, _ = silo(sonarr, jf, eps=(1,), in_jf=(1,))
    sonarr.grab(obj["id"], make_hash("g").upper(), episode_ids=[sonarr.episode(obj["id"], 2, 1)["id"]])
    await p.tick()
    assert p.state["cands"] == [] and phone.received() == []


async def test_news_already_sent_skips_only_that_item(make_push, sonarr, jf, requests_mock, frozen):  # noqa: F811
    p = make_push()
    u = jf.add_user("anna", "tok-a")
    phone = Phone(p, u, 1, requests_mock, ready=False, seasons=True)
    p.state["news"] = []
    items = [{"id": "1:2:aired", "kind": "aired", "title": "A", "season": 2},
             {"id": "3:4:aired", "kind": "aired", "title": "B", "season": 4}]

    class Tv:
        async def season_news(self):
            return items

    p.arr = {"tv": Tv()}
    p.state["sent"][u.id] = ["news:1:2:aired"]
    await p.news_tick()
    assert [pl["title"] for pl, _ in phone.received()] == ["B"]


async def test_first_news_pass_right_after_boot(make_push, monkeypatch):  # noqa: F811
    """A monotonic clock still under NEWS_POLL_S (a fresh boot) must not
    skip the first news pass."""
    p = make_push()
    clock = FakeClock(start=0.0, auto=False).install(monkeypatch, push)
    calls = []

    async def tick():
        calls.append("tick")

    async def news_tick():
        calls.append("news")

    monkeypatch.setattr(p, "tick", tick)
    monkeypatch.setattr(p, "news_tick", news_tick)
    p.start()
    try:
        await clock.settle(20)
        await clock.advance(15, settle=50)
        assert calls == ["tick", "news"]
    finally:
        p.task.cancel()


async def test_watcher_failure_log_line(make_push, monkeypatch, caplog):  # noqa: F811
    p = make_push()
    clock = FakeClock(auto=False).install(monkeypatch, push)

    async def tick():
        raise RuntimeError("arr down")

    monkeypatch.setattr(p, "tick", tick)
    p.start()
    try:
        await clock.settle(20)
        await clock.advance(15, settle=50)
        assert msgs(caplog) == ["push watcher: arr down"]
    finally:
        p.task.cancel()


# ---------------------------------------------------------------- helpers


@pytest.mark.parametrize("n", range(1, 9))
def test_base64url_round_trip_any_length(n):
    raw = bytes(range(250, 250 - n, -1)) if n < 6 else b"\xfb\xff\xbf" * n
    s = push._b64u(raw)
    assert "=" not in s and push._unb64u(s) == raw
    assert s == base64.urlsafe_b64encode(raw).decode().rstrip("=")


def test_b64u_keeps_a_trailing_x():
    raw = b"\x00\x00\x17"  # urlsafe "AAAX"
    assert push._b64u(raw) == "AAAX" and push._unb64u("AAAX") == raw


def test_iso_is_utc_whatever_the_local_zone(monkeypatch):
    monkeypatch.setenv("TZ", "JST-9")  # POSIX form: "Asia/Tokyo" needs tzdata, absent here (it stayed UTC)
    time.tzset()
    try:
        assert time.timezone == -9 * 3600
        assert push._iso(datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)) == "2026-01-02T03:04:05Z"
    finally:
        monkeypatch.undo()
        time.tzset()


def test_norm():
    assert push._norm("Amélie: The Movie!") == "amélie" + "themovie"
    assert push._norm(None) == "" and push._norm("") == ""
