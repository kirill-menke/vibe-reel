"""arr.py / push.py details found by the hardening mutation pass
(tests/run_mutmut.sh arr push): the method each arr write names in its error
text (it ends up in the server log), only slashes being stripped off a base
URL, the cancel-command log line, defaults for a title the arr/history has
none for, an episode 0 never confirming episode 1, Jellyfin's own item type
in the payload, and base64url padding for every length.

Note: test_push_internals.test_iso_is_utc_whatever_the_local_zone used to set
TZ=Asia/Tokyo, which this environment has no tzdata for — the zone silently
stayed UTC, so the test could not see a missing conversion. The version here
uses a POSIX TZ string, which needs no zone files, and checks it took."""

from __future__ import annotations

import base64
import logging
import re
import time
from datetime import datetime, timedelta, timezone

import pytest

from reel_api import push
from reel_api.arr import ArrClient, ArrError
from tests.conftest import RADARR, RADARR_KEY, SONARR, SONARR_KEY
from tests.test_undo_internals import journal  # noqa: F401 (fixture)
from tests.test_push_watcher import (  # noqa: F401 (fixtures)
    Phone, frozen, grab_import, jf, make_push, silo, started,
)


def tv(url=SONARR) -> ArrClient:
    return ArrClient("tv", url, SONARR_KEY, "x")


def movie(url=RADARR) -> ArrClient:
    return ArrClient("movie", url, RADARR_KEY, "x")


def msgs(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.name == "reel_api"]


async def raises(coro) -> str:
    with pytest.raises(ArrError) as e:
        await coro
    return str(e.value)


# ================================================================ arr


def test_only_slashes_are_stripped_off_the_base_url():
    assert tv("http://sonarr.test/X/").base_url == "http://sonarr.test/X"
    assert tv("http://sonarr.test/X").base_url == "http://sonarr.test/X"


async def test_write_error_texts_name_the_method(upstream):
    upstream.put(f"{SONARR}/api/v3/episode/monitor").respond(500, text="e")
    assert await raises(tv().set_episodes_monitored([3, 1, 3], False)) == \
        "tv PUT /api/v3/episode/monitor HTTP 500: e"
    upstream.put(f"{RADARR}/api/v3/movie/editor").respond(500, text="m")
    assert await raises(movie().set_movie_monitored(4, True)) == "movie PUT /api/v3/movie/editor HTTP 500: m"
    assert await raises(movie().set_title_monitored(4, True)) == "movie PUT /api/v3/movie/editor HTTP 500: m"
    upstream.post(f"{SONARR}/api/v3/command").respond(500, text="c")
    assert await raises(tv().search_title(9)) == "tv POST /api/v3/command HTTP 500: c"
    upstream.post(f"{RADARR}/api/v3/command").respond(500, text="d")
    assert await raises(movie().search_title(9)) == "movie POST /api/v3/command HTTP 500: d"


async def test_series_write_error_texts_name_the_method(upstream):
    upstream.get(f"{SONARR}/api/v3/series/1").respond(200, json={
        "id": 1, "monitored": True, "seasons": [{"seasonNumber": 1, "monitored": True}]})
    upstream.put(f"{SONARR}/api/v3/series/1").respond(500, text="s")
    assert await raises(tv().set_title_monitored(1, False)) == "tv PUT /api/v3/series/1 HTTP 500: s"
    assert await raises(tv().restore_season_monitoring(1, 1, series_was=False, season_was=True, flipped=[])) == \
        "tv PUT /api/v3/series/1 HTTP 500: s"


NOW = datetime(2026, 6, 15, 12, 0, tzinfo=timezone.utc)


def Z(d: datetime) -> str:
    return d.strftime("%Y-%m-%dT%H:%M:%SZ")


@pytest.fixture
def season_routes(upstream, time_machine):
    time_machine.move_to(NOW, tick=False)
    upstream.get(f"{SONARR}/api/v3/series").respond(200, json=[
        {"id": 1, "tvdbId": 11, "monitored": False, "seasons": [{"seasonNumber": 1, "monitored": False}]}])
    upstream.get(f"{SONARR}/api/v3/episode").respond(200, json=[
        {"id": 5, "seasonNumber": 1, "airDateUtc": Z(NOW - timedelta(days=1)), "monitored": False}])
    return {
        "series": upstream.put(f"{SONARR}/api/v3/series/1"),
        "monitor": upstream.put(f"{SONARR}/api/v3/episode/monitor"),
        "command": upstream.post(f"{SONARR}/api/v3/command"),
    }


@pytest.mark.parametrize("failing,text", [
    ("series", "tv PUT /api/v3/series/1 HTTP 500: x"),
    ("monitor", "tv PUT /api/v3/episode/monitor HTTP 500: x"),
    ("command", "tv POST /api/v3/command HTTP 500: x"),
])
async def test_season_search_error_texts_name_the_method(season_routes, failing, text):
    for name, route in season_routes.items():
        if name == failing:
            route.respond(500, text="x")
        else:
            route.respond(200, json={"id": 77})
    assert await raises(tv().search_season("11", 1)) == text


async def test_season_search_of_a_series_without_a_title(season_routes):
    for route in season_routes.values():
        route.respond(200, json={"id": 77})
    res = await tv().search_season("11", 1)
    assert res["title"] == "" and res["status"] == "searching"


async def test_cancel_command_log_line(upstream, caplog, journal):  # noqa: F811
    caplog.set_level(logging.INFO, logger="reel_api.actions")
    upstream.delete(f"{SONARR}/api/v3/command/7").respond(500, text="running")
    await tv().cancel_command(7)  # best effort: never raises
    assert journal() == ["tv: command 7 not cancelled: tv DELETE /api/v3/command/7 HTTP 500: running"]


# ================================================================ push: helpers and construction


def test_iso_converts_from_the_local_zone(monkeypatch):
    monkeypatch.setenv("TZ", "JST-9")  # POSIX form: no tzdata needed
    time.tzset()
    try:
        assert time.timezone == -9 * 3600  # the zone really is in effect
        assert push._iso(datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)) == "2026-01-02T03:04:05Z"
        local = datetime(2026, 1, 2, 12, 4, 5).astimezone()  # naive -> local (UTC+9)
        assert push._iso(local) == "2026-01-02T03:04:05Z"
    finally:
        monkeypatch.undo()
        time.tzset()


@pytest.mark.parametrize("n", range(1, 41))
def test_unb64u_pads_every_length(n):
    raw = bytes((i * 37 + 11) % 256 for i in range(n))
    s = base64.urlsafe_b64encode(raw).decode().rstrip("=")
    assert push._unb64u(s) == raw


def test_jellyfin_url_keeps_a_trailing_x(reel_env):
    reel_env(JELLYFIN_URL="http://jf.test/X/", VAPID_PRIVATE_KEY=None)
    assert push.Push({}).jf == "http://jf.test/X"


def test_unusable_vapid_key_log_names_the_error(reel_env, caplog):
    reel_env(VAPID_PRIVATE_KEY="!!", VAPID_SUBJECT="mailto:x@example.com")
    push.Push({})
    (m,) = msgs(caplog)
    g = re.fullmatch(r"push: VAPID_PRIVATE_KEY unusable \((.+)\) — push disabled", m)
    assert g and g.group(1) not in ("%s", "None")


def test_movie_candidate_without_a_title(make_push):  # noqa: F811
    p = make_push()
    when = datetime(2026, 6, 1, tzinfo=timezone.utc)
    c = p._candidate("movie", {"movieId": 3, "movie": {"tmdbId": 77}}, when)
    assert c["title"] == "" and c["ext"] == "77" and c["year"] is None
    c = p._candidate("tv", {"episodeId": 4, "series": {"tvdbId": 5}, "episode": {"seasonNumber": 1}}, when)
    assert c["title"] == "" and c["ep_title"] == ""


# ================================================================ push: confirming and the payload


async def test_episode_zero_does_not_confirm_episode_one(make_push, sonarr, jf, requests_mock, frozen):  # noqa: F811
    p = make_push()
    phone = Phone(p, jf.add_user("anna", "tok-a"), 1, requests_mock)
    await started(p, frozen)
    obj, item = silo(sonarr, jf, eps=(1,))
    jf.add_episode(item, 2, 0)  # a season's episode 0 is in Jellyfin; E1 not yet
    grab_import(sonarr, obj["id"], 2, [1], "e1")
    await p.tick()
    assert phone.received() == []
    jf.add_episode(item, 2, 1)
    await p.tick()
    [(payload, _)] = phone.received()
    assert payload["body"].startswith("S2E1")


async def test_payload_carries_jellyfins_item_type(make_push, jf, requests_mock):  # noqa: F811
    p = make_push()
    u = jf.add_user("anna", "tok-a")
    phone = Phone(p, u, 1, requests_mock)
    tv_c = {"kind": "tv", "gk": "tv:5", "title": "T", "s": 1, "e": 2, "ep_title": ""}
    await p._notify_ready(u.id, [phone.sub], {"Id": "x1", "Type": "Season"}, [tv_c])
    mv_c = {"kind": "movie", "gk": "movie:9", "title": "M"}
    await p._notify_ready(u.id, [phone.sub], {"Id": "x2", "Type": "Video"}, [mv_c])
    (a, _), (b, _) = phone.received()
    assert a["open"] == {"type": "item", "id": "x1", "itemType": "Season"}
    assert b["open"] == {"type": "item", "id": "x2", "itemType": "Video"}
