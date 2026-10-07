"""reel-api-canary (canary.py): every check against fakes (ok / warn / fail),
deadlines, the GET-only guard, the JSON status file and the exit codes.

Upstreams are respx routes at the usual http://<service>.test hosts; yt-dlp is
FakeYtDlp. Nothing real is contacted."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest

from reel_api import canary as c
from tests.conftest import (GUARDED, JELLYFIN, PROWLARR, PROWLARR_KEY, RADARR, RADARR_KEY, REEL, SONARR, SONARR_KEY,
                            TEST_TOKEN)
from tests.support.fake_ytdlp import FakeYtDlp, audio_fmt, video_fmt
from tests.support.qbit import QBIT

REELAPI = "http://reel-api.test"
JF_KEY = "jellyfin-canary-key"
QBIT_KEY = "qbt_canarycanarycanarycanary1234"
FILE_KEY = "qbt_canaryfilefilefilefile123456"
ITEM = "0123456789abcdef0123456789abcdef"
YT = "canaryYtId1"

REEL_TOKEN = "canary-user-token-0123456789"
ENV = {
    "REEL_API_URL": REELAPI, "REEL_API_TOKEN": REEL_TOKEN,
    "JELLYFIN_URL": JELLYFIN, "JELLYFIN_API_KEY": JF_KEY, "CANARY_SEGMENTS_ITEM_ID": ITEM,
    "PROWLARR_URL": PROWLARR, "PROWLARR_API_KEY": PROWLARR_KEY,
    "SONARR_URL": SONARR, "SONARR_API_KEY": SONARR_KEY,
    "RADARR_URL": RADARR, "RADARR_API_KEY": RADARR_KEY,
    "QBIT_URL": QBIT, "QBIT_API_KEY": QBIT_KEY,
    "CANARY_YOUTUBE_ID": YT,
}
HTTP_CHECKS = [n for n in c.CHECKS if n != "yt-dlp"]


@pytest.fixture
def stack(upstream):
    """Every upstream healthy. Tests change single routes (route.respond / side_effect)."""
    r = upstream
    s = SimpleNamespace(router=r)
    s.trend_movie = r.get(f"{REELAPI}/api/trending", params={"type": "movie"}).respond(
        json={"type": "movie", "results": [{"id": i} for i in range(18)]})
    s.trend_tv = r.get(f"{REELAPI}/api/trending", params={"type": "tv"}).respond(
        json={"type": "tv", "results": [{"id": i} for i in range(20)]})
    s.charts = r.get(f"{REELAPI}/api/charts").respond(json={"categories": [{"key": "top"}] * 24})
    s.info = r.get(f"{JELLYFIN}/System/Info/Public").respond(json={"Version": "12.1.0", "ServerName": "nas"})
    s.plugins = r.get(f"{JELLYFIN}/Plugins").respond(json=[
        {"Name": "TMDb Box Sets", "Version": "12.0.0.0", "Status": "Active"},
        {"Name": "Intro Skipper", "Version": "12.0.4.0", "Status": "Active"},
    ])
    s.segments = r.get(f"{JELLYFIN}/MediaSegments/{ITEM}").respond(json={"Items": [
        {"Type": "Intro", "StartTicks": 0, "EndTicks": 900_000_000},
        {"Type": "Outro", "StartTicks": 1, "EndTicks": 2},
    ], "TotalRecordCount": 2})
    s.trickplay = r.get(f"{JELLYFIN}/Videos/{ITEM}/Trickplay/320/0.jpg").respond(
        content=b"\xff\xd8" + b"\0" * 4096, headers={"content-type": "image/jpeg"})
    s.indexers = r.get(f"{PROWLARR}/api/v1/indexer").respond(json=[
        {"id": 1, "name": "1337x", "enable": True},
        {"id": 2, "name": "TPB", "enable": True},
        {"id": 3, "name": "Old", "enable": False},
    ])
    s.indexerstatus = r.get(f"{PROWLARR}/api/v1/indexerstatus").respond(json=[])
    for app, base in (("sonarr", SONARR), ("radarr", RADARR)):
        setattr(s, f"{app}_status", r.get(f"{base}/api/v3/system/status").respond(
            json={"appName": app.title(), "version": "4.0.15.2941"}))
        setattr(s, f"{app}_health", r.get(f"{base}/api/v3/health").respond(
            json=[{"source": "UpdateCheck", "type": "notice", "message": "update available"}]))
    s.qb_version = r.get(f"{QBIT}/api/v2/app/version").respond(text="v5.1.2")
    s.qb_transfer = r.get(f"{QBIT}/api/v2/transfer/info").respond(json={"connection_status": "connected"})
    s.qb_login = r.post(f"{QBIT}/api/v2/auth/login").respond(text="Ok.", headers={"set-cookie": "SID=abc; path=/"})
    return s


@pytest.fixture
def ytdlp(tmp_path, monkeypatch):
    fake = FakeYtDlp(tmp_path / "yt", monkeypatch)
    fake.add(YT, [
        # no files: the canary only resolves (-j --skip-download), never downloads
        video_fmt("401", None, width=3840, height=2160, vcodec="av01.0.12M.10"),
        audio_fmt("251", None, acodec="opus"),
    ], _version={"version": "2026.09.20"})
    return fake


async def run(name: str, **env) -> c.Result:
    cfg = c.load_config({**ENV, **env}, checks=name)
    http = c.ReadOnlyHttp(cfg.slow_timeout, c._login_url(cfg))
    try:
        return await c.run_one(name, cfg, http)
    finally:
        await http.aclose()


# ---------------------------------------------------------------- read-only guard


class TestReadOnly:
    async def test_no_write_method_on_the_wrapper(self):
        http = c.ReadOnlyHttp(5)
        for m in ("post", "put", "patch", "delete", "request", "stream", "send"):
            assert not hasattr(http, m)
        await http.aclose()

    @pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
    async def test_raw_client_refuses_every_non_get(self, upstream, method):
        route = upstream.route(method=method, url=f"{SONARR}/api/v3/command").respond(201)
        http = c.ReadOnlyHttp(5, login_url=QBIT + c.QBIT_LOGIN_PATH)
        try:
            with pytest.raises(c.ReadOnlyViolation, match=f"refused {method}"):
                await http._client.request(method, f"{SONARR}/api/v3/command")
        finally:
            await http.aclose()
        assert not route.called  # refused before it left

    async def test_post_only_to_the_exact_login_url(self, upstream, stack):
        other = upstream.post(f"{QBIT}/api/v2/torrents/delete").respond(200)
        http = c.ReadOnlyHttp(5, login_url=QBIT + c.QBIT_LOGIN_PATH)
        try:
            with pytest.raises(c.ReadOnlyViolation):
                await http._client.post(f"{QBIT}/api/v2/torrents/delete", data={"hashes": "all"})
            # same path on another host: refused too
            evil = upstream.post(f"{SONARR}/api/v2/auth/login").respond(200)
            with pytest.raises(c.ReadOnlyViolation):
                await http._client.post(f"{SONARR}/api/v2/auth/login")
            r = await http.qbit_login("u", "p")
            assert r.text == "Ok."
        finally:
            await http.aclose()
        assert not other.called and not evil.called
        assert stack.qb_login.call_count == 1

    async def test_login_needs_a_login_url(self):
        http = c.ReadOnlyHttp(5)
        with pytest.raises(c.ReadOnlyViolation, match="no qBittorrent login"):
            await http.qbit_login("u", "p")
        await http.aclose()

    def test_login_url_must_be_qbits_login(self):
        with pytest.raises(c.ReadOnlyViolation, match="only qBittorrent"):
            c.ReadOnlyHttp(5, login_url=f"{QBIT}/api/v2/torrents/add")

    async def test_a_full_run_sends_only_gets(self, stack, ytdlp):
        cfg = c.load_config({**ENV, "QBIT_API_KEY": "", "QBIT_USERNAME": "admin", "QBIT_PASSWORD": "pw"})
        report = await c.run_checks(cfg)
        assert report.status == c.OK, c.summary(report)
        methods = {(call.request.method, call.request.url.path) for call in stack.router.calls}
        assert {m for m, _ in methods} == {"GET", "POST"}
        assert [p for m, p in methods if m == "POST"] == [c.QBIT_LOGIN_PATH]


# ---------------------------------------------------------------- config


class TestConfig:
    def test_defaults(self, reel_env):
        cfg = c.load_config({**ENV, "REEL_API_URL": "", "JELLYFIN_URL": "", "PROWLARR_URL": "",
                             "SONARR_URL": "", "RADARR_URL": "", "CANARY_YOUTUBE_ID": "", "PORT": "8799"})
        assert cfg.checks == list(c.CHECKS)
        assert cfg.reel_url == "http://127.0.0.1:8799"
        assert cfg.jellyfin_url == "http://127.0.0.1:8096"
        assert (cfg.prowlarr_url, cfg.sonarr_url, cfg.radarr_url) == (
            "http://127.0.0.1:9696", "http://127.0.0.1:8989", "http://127.0.0.1:7878")
        assert cfg.youtube_id == c.DEFAULT_YOUTUBE_ID
        assert cfg.trickplay_item == ITEM  # falls back to the segments item
        assert (cfg.timeout, cfg.slow_timeout, cfg.min_indexers, cfg.trickplay_width) == (30, 120, 1, 320)
        assert cfg.status_file == reel_env.state / "canary.json"

    def test_state_dir_fallbacks(self, reel_env, tmp_path):
        reel_env(STATE_DIRECTORY=None)
        assert c.load_config(ENV).status_file == reel_env.cache / "canary.json"
        reel_env(CACHE_DIRECTORY=None)
        assert c.load_config(ENV).status_file == tmp_path / "tmp" / "reel-api-state" / "canary.json"

    def test_overrides(self):
        cfg = c.load_config({**ENV, "CANARY_CHECKS": " jellyfin, sonarr ,jellyfin", "CANARY_TIMEOUT": "2.5",
                             "CANARY_MIN_INDEXERS": "0", "CANARY_TRICKPLAY_ITEM_ID": "other",
                             "CANARY_STATUS_FILE": "/x/s.json", "REEL_API_URL": "http://h:1/"})
        assert cfg.checks == ["jellyfin", "sonarr"]
        assert (cfg.timeout, cfg.min_indexers, cfg.trickplay_item) == (2.5, 0, "other")
        assert str(cfg.status_file) == "/x/s.json" and cfg.reel_url == "http://h:1"
        # arguments beat the environment
        cfg = c.load_config(ENV, checks="radarr", status_file="/y.json")
        assert cfg.checks == ["radarr"] and str(cfg.status_file) == "/y.json"

    def test_os_environ_is_the_default(self, reel_env):
        reel_env(**ENV, CANARY_CHECKS="prowlarr")
        assert c.load_config().prowlarr_key == PROWLARR_KEY

    @pytest.mark.parametrize("env,match", [
        ({"CANARY_CHECKS": "jellyfin,nope"}, "unknown check"),
        ({"CANARY_CHECKS": " , "}, "no checks selected"),
        ({"CANARY_TIMEOUT": "soon"}, "not a number"),
        ({"CANARY_TIMEOUT": "0"}, "must be >="),
        ({"CANARY_MIN_INDEXERS": "-1"}, "must be >= 0"),
        ({"CANARY_TRICKPLAY_WIDTH": "320px"}, "not a number"),
        ({"JELLYFIN_API_KEY": ""}, "intro-skipper needs JELLYFIN_API_KEY"),
        ({"CANARY_SEGMENTS_ITEM_ID": ""}, "segments needs CANARY_SEGMENTS_ITEM_ID"),
        ({"PROWLARR_API_KEY": ""}, "prowlarr needs PROWLARR_API_KEY"),
        ({"SONARR_API_KEY": "", "RADARR_API_KEY": ""}, "sonarr needs SONARR_API_KEY; radarr needs RADARR_API_KEY"),
        ({"QBIT_URL": ""}, "qbittorrent needs QBIT_URL"),
        ({"REEL_API_TOKEN": ""}, "reel-api needs REEL_API_TOKEN"),
    ])
    def test_errors(self, env, match):
        with pytest.raises(c.ConfigError, match=match):
            c.load_config({**ENV, **env})

    def test_only_the_selected_checks_need_their_settings(self):
        cfg = c.load_config({"JELLYFIN_URL": JELLYFIN, "REEL_API_TOKEN": "t"}, checks="jellyfin,reel-api,yt-dlp")
        assert cfg.checks == ["jellyfin", "reel-api", "yt-dlp"]
        cfg = c.load_config({"JELLYFIN_URL": JELLYFIN}, checks="jellyfin,yt-dlp")
        assert cfg.checks == ["jellyfin", "yt-dlp"]


# ---------------------------------------------------------------- reel-api


class TestReelApi:
    async def test_ok(self, stack):
        r = await run("reel-api")
        assert (r.status, r.reason) == (c.OK, "trending 18 movies / 20 shows, 24 chart categories")

    async def test_the_token_is_sent_on_every_request(self, stack):
        """reel-api's request guard wants a Jellyfin user token on every route
        but /health — sent as the clients send theirs."""
        await run("reel-api", REEL_API_TOKEN="user-token-1")
        for route in (stack.trend_movie, stack.trend_tv, stack.charts):
            assert route.calls.last.request.headers["authorization"] == 'MediaBrowser Token="user-token-1"'

    async def test_empty_rails_fail(self, stack):
        # IMDb answering 403 without x-imdb-client-name: reel-api serves empty rails
        stack.trend_movie.respond(json={"type": "movie", "results": []})
        stack.charts.respond(json={"categories": []})
        r = await run("reel-api")
        assert r.status == c.FAIL
        assert r.reason.startswith("empty: trending movie, charts — IMDb")

    async def test_401_names_the_token(self, stack):
        stack.trend_tv.respond(401, json={"error": "unauthorized", "detail": "Jellyfin rejected the token"})
        r = await run("reel-api")
        assert r.status == c.FAIL
        assert r.reason == ("trending tv: HTTP 401 — reel-api refused REEL_API_TOKEN "
                            "(signed out or revoked in Jellyfin? sign in again for a new one)")

    @pytest.mark.parametrize("error", ["bad_host", "bad_origin"])
    async def test_a_guard_403_names_the_host(self, stack, error):
        stack.charts.respond(403, json={"error": error, "detail": "unknown host name"})
        assert (await run("reel-api")).reason == (
            "charts: HTTP 403 — reel-api refused the host of REEL_API_URL: use an IP, "
            "localhost or a name in its REEL_API_ALLOWED_HOSTS")

    @pytest.mark.parametrize("kw", [dict(json={"error": "forbidden"}), dict(text="<html>"), dict(json=[1])])
    async def test_another_403_and_other_errors(self, stack, kw):
        stack.charts.respond(403, **kw)
        assert (await run("reel-api")).reason == "charts: HTTP 403"
        stack.trend_tv.respond(503, json={"error": "temporarily_unavailable"})
        assert (await run("reel-api")).reason == "trending tv: HTTP 503"

    async def test_not_json(self, stack):
        stack.charts.respond(text="<html>")
        assert (await run("reel-api")).reason == "charts: answer is not a JSON object"
        stack.charts.respond(json=["a list"])
        assert (await run("reel-api")).reason == "charts: answer is not a JSON object"

    async def test_unreachable(self, stack):
        stack.charts.side_effect = httpx.ConnectError("connection refused")
        r = await run("reel-api")
        assert (r.status, r.reason) == (c.FAIL, "unreachable: connection refused")


class TestReelApiThroughTheRealGuard:
    """The canary's requests against the real app and its request guard
    (security.py, with conftest's Jellyfin /Users/Me sim): the canary's URL
    is forwarded into the ASGI app as it was sent — Host and Authorization
    included. trending/charts answer canned lists (their own tests cover
    IMDb); what is under test is that the guard lets the canary in."""

    @pytest.fixture
    async def reel(self, make_api, upstream, monkeypatch):
        async with make_api(auth=None) as app:  # no default header: the canary's own goes through
            m = app.app_module
            hit = {"imdb_id": "tt1", "rating": 8.1, "rating_votes": 20000, "rank": 3, "released": "2026-07-01",
                   "id": "1", "title": "T", "year": 2026, "overview": "", "poster": None, "added": False}

            async def trend(kind):
                return [{**hit, "type": kind}] * (2 if kind == "movie" else 3)

            async def index():
                return [{"key": "top-movie", "title": "Top", "types": ["movie"], "count": 1, "posters": []}]

            monkeypatch.setattr(m.trending, "get", trend)
            monkeypatch.setattr(m.charts, "index", index)

            async def forward(request: httpx.Request):
                r = await app.request(request.method, str(request.url), headers=request.headers)
                return httpx.Response(r.status_code, headers=r.headers, content=r.content)

            for base in (REEL, "http://reel-api.nas.example"):
                upstream.route(url__startswith=base + "/").side_effect = forward
            yield app

    async def test_the_guard_lets_the_canary_in(self, reel, jf_auth):
        r = await run("reel-api", REEL_API_URL=REEL, REEL_API_TOKEN=TEST_TOKEN)
        assert (r.status, r.reason) == (c.OK, "trending 2 movies / 3 shows, 1 chart categories")
        assert jf_auth.asked == [TEST_TOKEN]  # the guard asked Jellyfin once, then cached

    async def test_a_revoked_token(self, reel, jf_auth):
        del jf_auth.users[TEST_TOKEN]
        r = await run("reel-api", REEL_API_URL=REEL, REEL_API_TOKEN=TEST_TOKEN)
        assert r.status == c.FAIL and "HTTP 401 — reel-api refused REEL_API_TOKEN" in r.reason

    async def test_a_host_the_guard_does_not_know(self, reel, jf_auth):
        r = await run("reel-api", REEL_API_URL="http://reel-api.nas.example", REEL_API_TOKEN=TEST_TOKEN)
        assert r.status == c.FAIL and "HTTP 403 — reel-api refused the host of REEL_API_URL" in r.reason
        # refused on the Host, before the token is looked at — so make_api's
        # "a signed request must reach the /Users/Me check" doesn't apply
        assert jf_auth.asked == []
        GUARDED.clear()


# ---------------------------------------------------------------- Jellyfin


class TestJellyfin:
    async def test_version(self, stack):
        assert (await run("jellyfin")).reason == "Jellyfin 12.1.0"

    async def test_no_version(self, stack):
        stack.info.respond(json={"ServerName": "nas"})
        assert (await run("jellyfin")).reason == "Jellyfin /System/Info/Public has no Version"
        stack.info.respond(json=[])
        assert (await run("jellyfin")).status == c.FAIL

    async def test_http_errors(self, stack):
        stack.info.respond(500)
        assert (await run("jellyfin")).reason == "Jellyfin /System/Info/Public: HTTP 500"
        stack.info.respond(text="not json")
        assert (await run("jellyfin")).reason == "Jellyfin /System/Info/Public: answer is not JSON"

    async def test_intro_skipper_ok_and_auth_header(self, stack):
        r = await run("intro-skipper")
        assert (r.status, r.reason) == (c.OK, "Intro Skipper 12.0.4.0 Active on Jellyfin 12.1.0")
        auth = stack.plugins.calls.last.request.headers["authorization"]
        assert auth.startswith("MediaBrowser ") and f'Token="{JF_KEY}"' in auth

    async def test_intro_skipper_after_the_12_upgrade(self, stack):
        # the real 2026-09-27 state: the 10.x build NotSupported, the 12.x build waiting for a restart
        stack.plugins.respond(json=[
            {"Name": "Intro Skipper", "Version": "1.10.11.24", "Status": "NotSupported"},
            {"Name": "Intro Skipper", "Version": "12.0.4.0", "Status": "Restart"},
        ])
        r = await run("intro-skipper")
        assert r.status == c.FAIL
        assert r.reason.startswith("Intro Skipper not Active (1.10.11.24 NotSupported, 12.0.4.0 Restart)")

    async def test_intro_skipper_wrong_major(self, stack):
        stack.plugins.respond(json=[{"Name": "Intro Skipper", "Version": "1.10.11.24", "Status": "Active"}])
        r = await run("intro-skipper")
        assert (r.status, r.reason) == (
            c.FAIL, "Intro Skipper 1.10.11.24 Active is built for another Jellyfin major than 12.1.0")

    async def test_intro_skipper_legacy_scheme_matches_10(self, stack):
        stack.info.respond(json={"Version": "10.11.11"})
        stack.plugins.respond(json=[{"Name": "Intro Skipper", "Version": "1.10.11.24", "Status": "Active"}])
        assert (await run("intro-skipper")).status == c.OK

    async def test_intro_skipper_unknown_version_warns(self, stack):
        stack.plugins.respond(json=[{"Name": "intro skipper", "Version": "dev", "Status": "Active"}])
        r = await run("intro-skipper")
        assert r.status == c.WARN and "can't tell" in r.reason
        stack.info.respond(json={"Version": "unstable"})
        stack.plugins.respond(json=[{"Name": "Intro Skipper", "Version": "12.0.4.0", "Status": "Active"}])
        assert (await run("intro-skipper")).status == c.WARN

    async def test_intro_skipper_missing(self, stack):
        stack.plugins.respond(json=[{"Name": "Trakt", "Version": "26.0.0.0", "Status": "Active"}])
        r = await run("intro-skipper")
        assert r.status == c.FAIL and r.reason.startswith("Intro Skipper is not installed")
        stack.plugins.respond(401)
        r = await run("intro-skipper")
        assert r.reason == "Jellyfin /Plugins: HTTP 401 (key or token refused)"

    def test_plugin_target(self):
        assert c.plugin_target("12.0.4.0") == 12
        assert c.plugin_target("1.10.11.24") == 10
        assert c.plugin_target("3") is None
        assert c.plugin_target("x.1") is None

    async def test_segments(self, stack):
        r = await run("segments")
        assert (r.status, r.reason) == (c.OK, "2 segment(s): Intro, Outro")
        assert f'Token="{JF_KEY}"' in stack.segments.calls.last.request.headers["authorization"]

    async def test_segments_empty_or_without_intro(self, stack):
        stack.segments.respond(json={"Items": [], "TotalRecordCount": 0})
        r = await run("segments")
        assert r.status == c.FAIL and "no media segments" in r.reason
        stack.segments.respond(json=[])
        assert (await run("segments")).status == c.FAIL
        stack.segments.respond(json={"Items": [{"Type": "Outro"}]})
        r = await run("segments")
        assert (r.status, r.reason) == (c.WARN, "1 segment(s) but no Intro (Outro)")
        stack.segments.respond(404)
        assert (await run("segments")).reason == "Jellyfin /MediaSegments: HTTP 404"

    async def test_trickplay_ok_with_apikey_query(self, stack):
        r = await run("trickplay")
        assert (r.status, r.reason) == (c.OK, "sheet 0 at 320 px: 4 KiB image/jpeg")
        req = stack.trickplay.calls.last.request
        assert req.url.params["ApiKey"] == JF_KEY and "api_key" not in req.url.params

    @pytest.mark.parametrize("status,reason", [
        (401, "trickplay sheet: HTTP 401 with ApiKey= — the scrubber previews are broken"),
        (404, "no trickplay sheet at 320 px for the canary item"),
        (500, "trickplay sheet: HTTP 500"),
    ])
    async def test_trickplay_http(self, stack, status, reason):
        stack.trickplay.respond(status)
        assert (await run("trickplay")).reason == reason

    async def test_trickplay_not_an_image(self, stack):
        stack.trickplay.respond(200, text="{}", headers={"content-type": "application/json"})
        assert (await run("trickplay")).reason == "trickplay sheet is application/json, not an image"
        stack.trickplay.respond(200, content=b"")
        assert (await run("trickplay")).reason == "trickplay sheet is untyped, not an image"

    async def test_trickplay_width(self, upstream, stack):
        route = upstream.get(f"{JELLYFIN}/Videos/other/Trickplay/480/0.jpg").respond(
            content=b"x", headers={"content-type": "image/jpeg"})
        r = await run("trickplay", CANARY_TRICKPLAY_ITEM_ID="other", CANARY_TRICKPLAY_WIDTH="480")
        assert r.status == c.OK and route.called


# ---------------------------------------------------------------- Prowlarr / arrs


class TestProwlarr:
    async def test_ok(self, stack):
        r = await run("prowlarr")
        assert (r.status, r.reason) == (c.OK, "2 enabled indexer(s), none disabled")
        assert stack.indexerstatus.calls.last.request.headers["x-api-key"] == PROWLARR_KEY

    async def test_banned_indexer_fails(self, stack):
        # 1337x behind Cloudflare error 1006: Prowlarr disables it and says nothing
        stack.indexerstatus.respond(json=[{"indexerId": 1, "disabledTill": "2999-01-01T10:00:00Z",
                                           "mostRecentFailure": "2026-09-26T08:00:00Z"}])
        r = await run("prowlarr")
        assert (r.status, r.reason) == (c.FAIL, "disabled after failures: 1337x until 2999-01-01 10:00Z; 1 working")

    async def test_status_rows(self, stack):
        stack.indexerstatus.respond(json=[
            {"indexerId": 2, "disabledTill": "2001-01-01T00:00:00"},  # expired: history, not a failure
        ])
        assert (await run("prowlarr")).status == c.OK
        stack.indexerstatus.respond(json=[{"indexerId": 9}, {"indexerId": 2, "disabledTill": "garbage"}])
        r = await run("prowlarr")
        assert r.reason == "disabled after failures: #9 (+1 more); 1 working"

    async def test_minimum(self, stack):
        stack.indexers.respond(json=[{"id": 3, "name": "Old", "enable": False}])
        r = await run("prowlarr")
        assert (r.status, r.reason) == (c.FAIL, "only 0 enabled indexer(s), want >= 1")
        assert (await run("prowlarr", CANARY_MIN_INDEXERS="0")).status == c.OK
        stack.indexers.respond(json=[{"id": 1, "name": "a", "enable": True}])
        assert (await run("prowlarr", CANARY_MIN_INDEXERS="2")).reason == "only 1 enabled indexer(s), want >= 2"

    async def test_bad_key(self, stack):
        stack.indexers.respond(401)
        assert (await run("prowlarr")).reason == "Prowlarr indexers: HTTP 401 (key or token refused)"


class TestArr:
    @pytest.mark.parametrize("app", ["sonarr", "radarr"])
    async def test_ok(self, stack, app):
        r = await run(app)
        assert (r.status, r.reason) == (c.OK, f"{app.title()} 4.0.15.2941, healthy")
        key = SONARR_KEY if app == "sonarr" else RADARR_KEY
        assert getattr(stack, f"{app}_health").calls.last.request.headers["x-api-key"] == key

    async def test_warning_warns(self, stack):
        stack.sonarr_health.respond(json=[
            {"source": "IndexerStatusCheck", "type": "warning", "message": "Indexers unavailable: 1337x"},
            {"source": "X", "type": "warning", "message": "y"},
        ])
        r = await run("sonarr")
        assert (r.status, r.reason) == (
            c.WARN, "Sonarr 4.0.15.2941: warning: IndexerStatusCheck: Indexers unavailable: 1337x (+1 more)")

    async def test_error_fails(self, stack):
        stack.radarr_health.respond(json=[
            {"source": "DownloadClientCheck", "type": "error", "message": "Unable to communicate with qBittorrent"},
            {"type": "warning", "message": "w"},
        ])
        r = await run("radarr")
        assert (r.status, r.reason) == (
            c.FAIL, "Radarr 4.0.15.2941: error: DownloadClientCheck: Unable to communicate with qBittorrent")

    async def test_status_down(self, stack):
        stack.sonarr_status.respond(502)
        assert (await run("sonarr")).reason == "Sonarr system/status: HTTP 502"
        stack.sonarr_status.respond(json=[])
        assert (await run("sonarr")).reason == "Sonarr ?, healthy"


# ---------------------------------------------------------------- qBittorrent


class TestQbit:
    async def test_api_key(self, stack):
        r = await run("qbittorrent")
        assert (r.status, r.reason) == (c.OK, "qBittorrent v5.1.2, connected")
        assert stack.qb_version.calls.last.request.headers["authorization"] == f"Bearer {QBIT_KEY}"
        assert not stack.qb_login.called

    async def test_login(self, stack):
        r = await run("qbittorrent", QBIT_API_KEY="", QBIT_USERNAME="admin", QBIT_PASSWORD="hunter22")
        assert r.status == c.OK
        assert stack.qb_login.calls.last.request.content == b"username=admin&password=hunter22"
        assert "SID=abc" in stack.qb_version.calls.last.request.headers["cookie"]

    @pytest.mark.parametrize("status, body, cookie", [
        (204, "", "QBT_SID_8080=abc"),  # qBittorrent 5.2+ (measured on 5.2.3)
        (200, "Ok.", "SID=abc"),        # 4.1 .. 5.1
    ])
    async def test_login_both_success_answers(self, stack, status, body, cookie):
        stack.qb_login.respond(status, text=body, headers={"set-cookie": f"{cookie}; path=/"})
        r = await run("qbittorrent", QBIT_API_KEY="", QBIT_USERNAME="admin", QBIT_PASSWORD="hunter22")
        assert (r.status, r.reason) == (c.OK, "qBittorrent v5.1.2, connected")
        assert cookie in stack.qb_version.calls.last.request.headers["cookie"]

    @pytest.mark.parametrize("status, body", [(401, "Unauthorized"), (403, "Your IP address has been banned"),
                                              (204, "")])  # the last: no session cookie
    async def test_login_refused_5_2(self, stack, status, body):
        stack.qb_login.respond(status, text=body)
        r = await run("qbittorrent", QBIT_API_KEY="", QBIT_USERNAME="admin", QBIT_PASSWORD="hunter22")
        assert (r.status, r.reason) == (c.FAIL, f"qBittorrent login refused (HTTP {status})")
        assert not stack.qb_version.called and "hunter22" not in r.reason

    async def test_login_refused(self, stack):
        stack.qb_login.respond(200, text="Fails.")
        r = await run("qbittorrent", QBIT_API_KEY="", QBIT_USERNAME="admin")
        assert (r.status, r.reason) == (c.FAIL, "qBittorrent login refused (HTTP 200)")
        assert not stack.qb_version.called

    async def test_unauthenticated(self, stack):
        # neither key nor user: fine when the WebUI bypasses auth for this host
        assert (await run("qbittorrent", QBIT_API_KEY="")).status == c.OK
        assert "authorization" not in stack.qb_version.calls.last.request.headers
        stack.qb_version.respond(403, text="Forbidden")
        r = await run("qbittorrent", QBIT_API_KEY="")
        assert r.status == c.FAIL and "set QBIT_API_KEY" in r.reason

    async def test_api_key_file_wins_and_is_stripped(self, stack, tmp_path, caplog):
        """QBIT_API_KEY_FILE (systemd: LoadCredential= + %d/…), qbittorrent.py's
        rules: the file wins over QBIT_API_KEY and its whitespace is stripped."""
        f = tmp_path / "qbit-api-key"
        f.write_text(f"  {FILE_KEY}\n\n")
        r = await run("qbittorrent", QBIT_API_KEY_FILE=str(f), QBIT_USERNAME="admin", QBIT_PASSWORD="pw")
        assert (r.status, r.reason) == (c.OK, "qBittorrent v5.1.2, connected")
        assert stack.qb_version.calls.last.request.headers["authorization"] == f"Bearer {FILE_KEY}"
        assert stack.qb_transfer.calls.last.request.headers["authorization"] == f"Bearer {FILE_KEY}"
        assert not stack.qb_login.called
        assert "using the file" in caplog.text
        assert FILE_KEY not in caplog.text and QBIT_KEY not in caplog.text

    async def test_api_key_file_alone(self, stack, tmp_path):
        f = tmp_path / "k"
        f.write_text(FILE_KEY)
        r = await run("qbittorrent", QBIT_API_KEY="", QBIT_API_KEY_FILE=str(f))
        assert r.status == c.OK
        assert stack.qb_version.calls.last.request.headers["authorization"] == f"Bearer {FILE_KEY}"

    @pytest.mark.parametrize("content, why", [
        (None, " is unreadable (FileNotFoundError)"),
        ("", " is empty"),
        (" \n\t", " is empty"),
        ("qbt_canary\nfilefilefilefile123456789", ": the key contains whitespace or control characters"),
    ])
    async def test_a_bad_api_key_file_fails_the_check_closed(self, stack, tmp_path, caplog, content, why):
        """Missing, empty, whitespace-only or header-unsafe: the qBittorrent
        check fails naming the file — before anything is sent, with no fall-back
        to QBIT_API_KEY or a QBIT_USERNAME login, and the key never shows."""
        f = tmp_path / "qbit-api-key"
        if content is not None:
            f.write_text(content)
        env = {"QBIT_API_KEY_FILE": str(f), "QBIT_USERNAME": "admin", "QBIT_PASSWORD": "hunter22"}
        cfg = c.load_config({**ENV, **env}, checks="qbittorrent")
        assert c._login_url(cfg) is None  # not even the login POST is allowed
        r = await run("qbittorrent", **env)
        assert r.status == c.FAIL
        assert r.reason == (f"qBittorrent: QBIT_API_KEY_FILE {f}{why}"
                            " — not falling back to QBIT_API_KEY or QBIT_USERNAME/QBIT_PASSWORD")
        assert not stack.qb_version.called and not stack.qb_transfer.called and not stack.qb_login.called
        for secret in (QBIT_KEY, "qbt_canary", "filefilefile", "hunter22"):
            assert secret not in r.reason and secret not in caplog.text

    def test_the_key_file_is_only_read_for_the_qbittorrent_check(self, tmp_path):
        missing = tmp_path / "nope"
        cfg = c.load_config({**ENV, "QBIT_API_KEY_FILE": str(missing)}, checks="sonarr")
        assert (cfg.qbit_api_key, cfg.qbit_key_error) == (QBIT_KEY, None)
        cfg = c.load_config({**ENV, "QBIT_API_KEY_FILE": str(missing)}, checks="sonarr,qbittorrent")
        assert cfg.qbit_api_key is None and "unreadable" in cfg.qbit_key_error

    def test_a_missing_key_file_exits_1_without_the_key(self, stack, reel_env, tmp_path, capsys):
        reel_env(**ENV, QBIT_API_KEY_FILE=str(tmp_path / "gone"))
        assert c.main(["--checks", "qbittorrent,sonarr"]) == 1
        out = capsys.readouterr().out
        assert "FAIL  qbittorrent  qBittorrent: QBIT_API_KEY_FILE" in out and "is unreadable" in out
        assert QBIT_KEY not in out and QBIT_KEY not in (reel_env.state / "canary.json").read_text()

    async def test_connection_status(self, stack):
        stack.qb_transfer.respond(json={"connection_status": "firewalled"})
        assert (await run("qbittorrent")).status == c.WARN
        stack.qb_transfer.respond(json={"connection_status": "disconnected"})
        r = await run("qbittorrent")
        assert (r.status, r.reason) == (c.FAIL, "qBittorrent v5.1.2: disconnected — is the VPN namespace up?")
        stack.qb_transfer.respond(json=[])
        assert (await run("qbittorrent")).reason == "qBittorrent v5.1.2, status unknown"

    async def test_version_error(self, stack):
        stack.qb_version.respond(500)
        assert (await run("qbittorrent")).reason == "qBittorrent app/version: HTTP 500"


# ---------------------------------------------------------------- yt-dlp


@pytest.mark.slow
class TestYtDlp:
    async def test_ok_with_trailers_selector(self, ytdlp):
        r = await run("yt-dlp")
        assert (r.status, r.reason) == (c.OK, "yt-dlp 2026.09.20: 2160p av01.0.12M.10 + opus")
        argv = ytdlp.calls("resolve")[0]["argv"]
        assert "--skip-download" in argv and "-j" in argv
        assert argv[argv.index("-f") + 1] == "(bv*[protocol=https][height<=2160])+(ba[protocol=https])"
        assert argv[-1] == f"https://www.youtube.com/watch?v={YT}"

    async def test_youtube_broke_it(self, ytdlp):
        ytdlp.fail(f"resolve:{YT}", stderr="WARNING: x\nERROR: [youtube] canaryYtId1: Sign in to confirm you're not a bot\n")
        r = await run("yt-dlp")
        assert (r.status, r.reason) == (
            c.FAIL, "yt-dlp: ERROR: [youtube] canaryYtId1: Sign in to confirm you're not a bot")

    async def test_unknown_video(self, ytdlp):
        r = await run("yt-dlp", CANARY_YOUTUBE_ID="goneVideo01")
        assert r.status == c.FAIL and "Video unavailable" in r.reason

    async def test_muxed_only(self, ytdlp, tmp_path):
        ytdlp.update(YT, requested=["401"])
        r = await run("yt-dlp")
        assert r.reason == "yt-dlp 2026.09.20: no separate video + audio streams (trailers would fail)"
        ytdlp.update(YT, requested=["251", "401"], _version=None)  # audio first: still split right
        assert (await run("yt-dlp")).reason == "yt-dlp ?: 2160p av01.0.12M.10 + opus"

    async def test_deadline_kills_it(self, ytdlp):
        ytdlp.gate(f"resolve:{YT}", at=0)
        r = await run("yt-dlp", CANARY_SLOW_TIMEOUT="0.5")
        assert (r.status, r.reason) == (c.FAIL, "no verdict within 0.5 s")
        assert ytdlp.alive() == []  # the subprocess was killed with the deadline


async def test_ytdlp_missing_or_garbled(monkeypatch, tmp_path):
    monkeypatch.setattr(c.shutil, "which", lambda name: None)
    assert (await run("yt-dlp")).reason == "yt-dlp not on PATH"
    monkeypatch.setattr(c.shutil, "which", lambda name: "/bin/yt-dlp")

    async def fake_run(*args, timeout):
        return 0, b"not json", b""

    monkeypatch.setattr(c, "_run", fake_run)
    assert (await run("yt-dlp")).reason == "yt-dlp -j printed no JSON"


# ---------------------------------------------------------------- running


class TestRunning:
    async def test_deadline_per_check(self, stack):
        async def hang(request):
            await asyncio.sleep(5)

        stack.info.side_effect = hang
        cfg = c.load_config({**ENV, "CANARY_TIMEOUT": "0.2"}, checks="jellyfin,sonarr")
        report = await c.run_checks(cfg)
        by = {r.name: r for r in report.checks}
        assert (by["jellyfin"].status, by["jellyfin"].reason) == (c.FAIL, "no verdict within 0.2 s")
        assert by["jellyfin"].seconds < 2
        assert by["sonarr"].status == c.OK  # independent of the hung one

    async def test_http_timeout_and_unexpected_errors(self, stack):
        stack.info.side_effect = httpx.ReadTimeout("slow")
        assert (await run("jellyfin")).reason == "no answer in time (ReadTimeout)"
        stack.info.side_effect = httpx.ConnectError("")
        assert (await run("jellyfin")).reason == "unreachable"
        stack.info.side_effect = KeyError()
        assert (await run("jellyfin")).reason == "KeyError"
        stack.info.side_effect = RuntimeError("line one\n   line two")
        assert (await run("jellyfin")).reason == "RuntimeError: line one line two"

    async def test_secrets_never_reach_the_reason(self, stack):
        stack.trickplay.side_effect = httpx.ConnectError(
            f"refused: {JELLYFIN}/Videos/{ITEM}/Trickplay/320/0.jpg?ApiKey={JF_KEY}")
        r = await run("trickplay")
        assert JF_KEY not in r.reason and "ApiKey=***" in r.reason
        assert c.redact("token=abc&x=1 api_key=zz password=p", []) == "token=***&x=1 api_key=*** password=***"
        assert c.redact("key abcd and abc", ["abcd", "abc"]) == "key *** and abc"  # < 4 chars: left alone

    async def test_report_and_summary(self, stack, ytdlp):
        stack.sonarr_health.respond(json=[{"source": "S", "type": "warning", "message": "m"}])
        stack.indexers.respond(500)
        report = await c.run_checks(c.load_config(ENV))
        assert report.status == c.FAIL
        assert report.counts == {c.OK: len(c.CHECKS) - 2, c.WARN: 1, c.FAIL: 1}
        assert [r.name for r in report.checks] == list(c.CHECKS)
        text = c.summary(report)
        assert text.splitlines()[0].endswith(f"FAIL (1 fail, 1 warn, {len(c.CHECKS) - 2} ok)")
        assert "  FAIL  prowlarr       Prowlarr indexers: HTTP 500" in text
        assert "  WARN  sonarr " in text

    def test_write_status_is_atomic(self, tmp_path):
        report = c.Report("t0", "t1", c.OK, {c.OK: 1, c.WARN: 0, c.FAIL: 0}, [c.Result("jellyfin", c.OK, "fine", 0.1)])
        path = tmp_path / "deep" / "dir" / "canary.json"
        c.write_status(path, report)
        data = json.loads(path.read_text())
        assert data == {"version": 1, "started": "t0", "finished": "t1", "status": "ok",
                        "counts": {"ok": 1, "warn": 0, "fail": 0},
                        "checks": [{"name": "jellyfin", "status": "ok", "reason": "fine", "seconds": 0.1}]}
        assert [p.name for p in path.parent.iterdir()] == ["canary.json"]


# ---------------------------------------------------------------- main / exit codes


class TestMain:
    def test_exit_0_with_a_warning_and_the_status_file(self, stack, reel_env, capsys):
        reel_env(**ENV)
        stack.radarr_health.respond(json=[{"source": "S", "type": "warning", "message": "disk"}])
        assert c.main(["--checks", ",".join(HTTP_CHECKS)]) == 0
        out = capsys.readouterr().out
        assert out.startswith("reel-api canary ") and "WARN (0 fail, 1 warn" in out
        data = json.loads((reel_env.state / "canary.json").read_text())
        assert data["status"] == "warn" and len(data["checks"]) == len(HTTP_CHECKS)
        assert JF_KEY not in out and QBIT_KEY not in (reel_env.state / "canary.json").read_text()

    def test_exit_1_on_a_failure(self, stack, reel_env, tmp_path, capsys):
        reel_env(**ENV, CANARY_CHECKS="prowlarr,jellyfin")
        stack.indexerstatus.respond(json=[{"indexerId": 1, "disabledTill": "2999-01-01T00:00:00Z"}])
        out = tmp_path / "status.json"
        assert c.main(["--status-file", str(out)]) == 1
        assert json.loads(out.read_text())["status"] == "fail"
        assert "FAIL  prowlarr" in capsys.readouterr().out

    def test_exit_2_on_config_errors(self, reel_env, capsys):
        reel_env(CANARY_CHECKS="prowlarr")
        assert c.main([]) == 2
        assert "config error: prowlarr needs PROWLARR_API_KEY" in capsys.readouterr().err
        assert not (reel_env.state / "canary.json").exists()
        with pytest.raises(SystemExit) as e:
            c.main(["--bogus"])
        assert e.value.code == 2

    def test_exit_2_when_the_status_file_cant_be_written(self, stack, reel_env, tmp_path, capsys):
        reel_env(**ENV)
        blocker = tmp_path / "file"
        blocker.write_text("")
        assert c.main(["--checks", "jellyfin", "--status-file", str(blocker / "sub" / "s.json")]) == 2
        assert "can't write" in capsys.readouterr().err
