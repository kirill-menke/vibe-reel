"""The request guard (security.py): Host allowlist, Origin check, the
Jellyfin-session token in every transport, the /Users/Me cache, the open
routes, and keeping `api_key` out of logs and error bodies.

Most checks drive `Guard` as a raw ASGI app around a stub (full control over
Host, headers, query and client); the route sweep and the transports also go
through the real app via `make_api`. Jellyfin is `jf_auth` (conftest).
"""

from __future__ import annotations

import asyncio
import json
import logging
import types

import httpx
import pytest

from reel_api import security as sec
from tests.conftest import JELLYFIN, NICOLE_TOKEN, NICOLE_USER, TEST_TOKEN, TEST_USER

OTHER = "other-token-0123456789abcdef"
OTHER_USER = "fedcba9876543210fedcba9876543210"


# ---------------------------------------------------------------- helpers


class Inner:
    """The app behind the guard: records what got through and answers 200."""

    def __init__(self):
        self.scopes: list[dict] = []

    async def __call__(self, scope, receive, send):
        self.scopes.append(scope)
        if scope["type"] != "http":
            return
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/plain")]})
        await send({"type": "http.response.body", "body": b"inner"})


class Reply:
    def __init__(self, sent):
        start = next(m for m in sent if m["type"] == "http.response.start")
        self.status = start["status"]
        self.headers = {k.decode(): v.decode() for k, v in start["headers"]}
        self.body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")

    def json(self):
        return json.loads(self.body)


def make_guard(hosts=("nas", "nas.example.ts.net"), jellyfin=JELLYFIN):
    inner = Inner()
    return sec.Guard(inner, jellyfin_url=jellyfin, allowed_hosts=frozenset(hosts)), inner


async def call(guard, *, method="GET", path="/api/activity", host="nas", headers=(), query="", token=TEST_TOKEN,
               raw_headers=None):
    """One request through `guard`. `token` goes in as the clients send it
    (MediaBrowser Token=); None sends none. `raw_headers` replaces every
    header, Host included."""
    if raw_headers is None:
        hs = [] if host is None else [("host", host)]
        if token is not None:
            hs.append(("authorization", f'MediaBrowser Token="{token}"'))
        hs.extend(headers)
    else:
        hs = list(raw_headers)
    scope = {"type": "http", "method": method, "path": path, "query_string": query.encode("latin-1"),
             "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in hs],
             "client": ("192.0.2.9", 50000)}
    sent = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(m):
        sent.append(m)

    await guard(scope, receive, send)
    return Reply(sent)


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def monotonic(self):
        return self.t


@pytest.fixture
def clock(monkeypatch):
    """security.py's own time.monotonic (never the event loop's)."""
    c = Clock()
    monkeypatch.setattr(sec, "time", types.SimpleNamespace(monotonic=c.monotonic))
    return c


# ---------------------------------------------------------------- Host


@pytest.mark.parametrize("host, name", [
    ("nas", "nas"),
    ("NAS:8790", "nas"),
    ("Nas.Example.TS.net", "nas.example.ts.net"),
    ("[::1]:8790", "::1"),
    ("[FE80::1]", "fe80::1"),
    ("192.0.2.7:8790", "192.0.2.7"),
    ("  nas  ", "nas"),
    ("", None),
    ("   ", None),
    ("[::1", None),  # unterminated IPv6 literal
])
def test_hostname(host, name):
    assert sec._hostname(host) == name


@pytest.mark.parametrize("name, ok", [
    ("127.0.0.1", True), ("192.0.2.7", True), ("::1", True), ("fe80::1", True),
    ("localhost", True), ("localhost.", True),
    ("nas", True), ("nas.", True), ("nas.example.ts.net", True), ("nas.example.ts.net.", True),
    ("evil.example", False), ("nas.evil.example", False), ("127.0.0.1.nip.io", False),
    ("0x7f.0.0.1", False), ("2130706433", False),  # not IP literals ipaddress accepts
    ("", False), (None, False),
])
def test_host_allowed(name, ok):
    assert sec.host_allowed(name, frozenset({"nas", "nas.example.ts.net"})) is ok


def test_allowed_hosts_from_env(reel_env):
    reel_env(REEL_API_ALLOWED_HOSTS=" NAS , nas.local. ,, Nas.Example.ts.net")
    assert sec.allowed_hosts_from_env() == frozenset({"nas", "nas.local", "nas.example.ts.net"})
    reel_env(REEL_API_ALLOWED_HOSTS=None)
    assert sec.allowed_hosts_from_env() == frozenset()


@pytest.mark.parametrize("host", ["nas", "NAS", "nas.", "Nas:8790", "nas.example.ts.net:443", "localhost:8790",
                                  "127.0.0.1", "192.0.2.7:8790", "[::1]:8790", "[fe80::1]"])
async def test_allowed_host_passes(host):
    guard, inner = make_guard()
    r = await call(guard, host=host)
    assert r.status == 200 and len(inner.scopes) == 1


@pytest.mark.parametrize("host", ["evil.example", "evil.example:8790", "nas.evil.example", "", "  ", "[::1",
                                  "nas@evil.example", "evil.example#nas"])
async def test_other_host_is_403(host):
    guard, inner = make_guard()
    r = await call(guard, host=host)
    assert r.status == 403
    assert r.json() == {"error": "bad_host", "detail": "unknown host name"}
    assert r.headers["cache-control"] == "no-store" and r.headers["content-type"] == "application/json"
    assert inner.scopes == []


async def test_missing_host_is_403(jf_auth):
    guard, inner = make_guard()
    r = await call(guard, host=None)
    assert r.status == 403 and r.json()["error"] == "bad_host"
    assert jf_auth.asked == []  # refused before the token is even looked at


async def test_host_is_checked_before_the_open_routes():
    guard, inner = make_guard()
    r = await call(guard, method="GET", path="/health", host="evil.example", token=None)
    assert r.status == 403 and inner.scopes == []


async def test_forwarded_headers_are_ignored():
    """Only Host counts: X-Forwarded-Host / Forwarded can neither admit a
    rebinding request nor refuse a good one."""
    guard, inner = make_guard()
    fwd = [("x-forwarded-host", "nas"), ("forwarded", "host=nas"), ("x-forwarded-for", "127.0.0.1"),
           ("x-real-ip", "127.0.0.1")]
    assert (await call(guard, host="evil.example", headers=fwd)).status == 403
    bad_fwd = [("x-forwarded-host", "evil.example"), ("forwarded", "host=evil.example")]
    assert (await call(guard, host="nas", headers=bad_fwd)).status == 200


async def test_first_host_header_wins():
    guard, _ = make_guard()
    r = await call(guard, raw_headers=[("host", "evil.example"), ("host", "nas"),
                                       ("authorization", f'MediaBrowser Token="{TEST_TOKEN}"')])
    assert r.status == 403


async def test_allowed_hosts_come_from_the_env_by_default(reel_env, jf_auth):
    reel_env(REEL_API_ALLOWED_HOSTS="box.lan", JELLYFIN_URL="http://jf.example:8096/")
    inner = Inner()
    guard = sec.Guard(inner)
    assert guard.extra == frozenset({"box.lan"})
    assert (await call(guard, host="box.lan")).status == 200
    assert (await call(guard, host="nas")).status == 403
    assert jf_auth.urls == ["http://jf.example:8096/Users/Me"]


async def test_jellyfin_url_defaults_to_loopback(reel_env, jf_auth):
    guard = sec.Guard(Inner(), allowed_hosts=frozenset())
    assert (await call(guard, host="127.0.0.1")).status == 200
    assert jf_auth.urls == ["http://127.0.0.1:8096/Users/Me"]


# ---------------------------------------------------------------- Origin


@pytest.mark.parametrize("origin", ["http://nas", "https://nas.example.ts.net", "http://nas:8790",
                                    "HTTPS://NAS:443", "http://127.0.0.1:8899", "http://[::1]:8900",
                                    "http://localhost:5173"])
async def test_same_site_origin_passes(origin):
    guard, inner = make_guard()
    assert (await call(guard, headers=[("origin", origin)])).status == 200


@pytest.mark.parametrize("origin", ["http://evil.example", "https://nas.evil.example", "HTTP://EVIL.example:8790",
                                    "https://nas@evil.example", "http://[::1", "https://"])
async def test_cross_site_origin_is_403(origin, jf_auth):
    guard, inner = make_guard()
    r = await call(guard, headers=[("origin", origin)])
    assert r.status == 403
    assert r.json() == {"error": "bad_origin", "detail": "cross-site request refused"}
    assert inner.scopes == [] and jf_auth.asked == []


@pytest.mark.parametrize("origin", ["null", "file://", "file:///media/developer/apps/x/index.html",
                                    "app://com.kirill.reel", "chrome-extension://abc"])
async def test_non_web_origin_goes_on_to_the_token_check(origin):
    guard, inner = make_guard()
    assert (await call(guard, headers=[("origin", origin)])).status == 200
    r = await call(guard, headers=[("origin", origin)], token=None)
    assert r.status == 401 and r.json()["error"] == "unauthorized"


def test_origin_allowed_directly():
    extra = frozenset({"nas"})
    assert sec.origin_allowed("http://nas", extra)
    assert not sec.origin_allowed("http://evil.example", extra)
    assert sec.origin_allowed("null", extra)
    assert not sec.origin_allowed("http://[::1", extra)  # urlsplit raises
    assert not sec.origin_allowed("https://", extra)  # an http(s) origin without a host


def test_origin_with_a_malformed_host(monkeypatch):
    """urlsplit() itself parses, but reading .hostname raises: refused."""

    class Broken:
        scheme = "http"

        @property
        def hostname(self):
            raise ValueError("bad")

    monkeypatch.setattr(sec, "urlsplit", lambda s: Broken())
    assert sec.origin_allowed("http://whatever", frozenset()) is False


# ---------------------------------------------------------------- token transports


@pytest.mark.parametrize("headers, query, token", [
    ({"authorization": f'MediaBrowser Token="{TEST_TOKEN}"'}, "", TEST_TOKEN),
    ({"authorization": f'MediaBrowser Client="VibeReel", Device="TV", DeviceId="d", Version="1", '
                       f'Token="{TEST_TOKEN}"'}, "", TEST_TOKEN),
    ({"authorization": f'mediabrowser token = "{TEST_TOKEN}"'}, "", TEST_TOKEN),
    ({"authorization": f'Emby UserId="u", Token="{TEST_TOKEN}"'}, "", TEST_TOKEN),
    ({"authorization": f"Bearer {TEST_TOKEN}"}, "", TEST_TOKEN),
    ({"authorization": f"bearer   {TEST_TOKEN}  "}, "", TEST_TOKEN),
    ({"x-emby-token": TEST_TOKEN}, "", TEST_TOKEN),
    ({"x-emby-token": f"  {TEST_TOKEN} "}, "", TEST_TOKEN),
    ({"x-mediabrowser-token": TEST_TOKEN}, "", TEST_TOKEN),
    ({}, f"api_key={TEST_TOKEN}", TEST_TOKEN),
    ({}, f"x=1&API_KEY={TEST_TOKEN}&y=2", TEST_TOKEN),
    ({}, "api_key=a%2Bb%3D", "a+b="),
    # precedence: Authorization > X-Emby-Token > X-MediaBrowser-Token > api_key
    ({"authorization": f"Bearer {TEST_TOKEN}", "x-emby-token": OTHER}, f"api_key={OTHER}", TEST_TOKEN),
    ({"x-emby-token": TEST_TOKEN, "x-mediabrowser-token": OTHER}, "", TEST_TOKEN),
    ({"x-mediabrowser-token": TEST_TOKEN}, f"api_key={OTHER}", TEST_TOKEN),
    # an Authorization the guard can't read falls through to the others
    ({"authorization": "Basic dXNlcjpwYXNz", "x-emby-token": TEST_TOKEN}, "", TEST_TOKEN),
    ({"authorization": 'MediaBrowser Client="x"', "x-emby-token": TEST_TOKEN}, "", TEST_TOKEN),
    ({"authorization": 'MediaBrowser Client="x"'}, f"api_key={TEST_TOKEN}", TEST_TOKEN),
    # nothing usable
    ({}, "", None),
    ({}, "api_key=", None),
    ({}, "apikey=x&token=y", None),
    ({"authorization": "Basic dXNlcjpwYXNz"}, "", None),
    ({"authorization": f'MediaBrowser XToken="{TEST_TOKEN}"'}, "", None),
    ({"x-emby-token": ""}, "", None),
])
def test_token_from(headers, query, token):
    assert sec.token_from(headers, query) == token


@pytest.mark.parametrize("headers, query", [
    ({"Authorization": f'MediaBrowser Token="{TEST_TOKEN}"'}, ""),
    ({"Authorization": f"Bearer {TEST_TOKEN}"}, ""),
    ({"X-Emby-Token": TEST_TOKEN}, ""),
    ({"X-MediaBrowser-Token": TEST_TOKEN}, ""),
    ({}, f"?api_key={TEST_TOKEN}"),
], ids=["mediabrowser", "bearer", "x-emby-token", "x-mediabrowser-token", "api_key"])
async def test_every_transport_through_the_app(make_api, jf_auth, headers, query):
    async with make_api(auth=None) as api:
        r = await api.get("/api/push/config" + query, headers=headers)
    assert r.status_code == 200 and r.json() == {"enabled": False, "key": None}
    assert jf_auth.asked == [TEST_TOKEN]


async def test_the_guard_asks_jellyfin_with_the_token_only(make_api, upstream, jf_auth):
    """Jellyfin 12.1 answers /Users/Me for `MediaBrowser Token="…"` alone (200)
    and fills the device fields from the token's own session; reel-api sends
    nothing else, so it never rewrites the client's device record."""
    async with make_api(auth=None) as api:
        await api.get("/api/push/config", headers={"X-Emby-Token": TEST_TOKEN})
    req = jf_auth.route.calls.last.request
    assert req.headers["Authorization"] == f'MediaBrowser Token="{TEST_TOKEN}"'
    assert "x-emby-token" not in req.headers and "x-emby-authorization" not in req.headers
    assert req.url == httpx.URL(f"{JELLYFIN}/Users/Me")


async def test_no_token_is_401(make_api, jf_auth):
    async with make_api(auth=None) as api:
        r = await api.get("/api/push/config")
    assert r.status_code == 401
    assert r.json() == {"error": "unauthorized", "detail": "sign in to Jellyfin first"}
    assert r.headers["cache-control"] == "no-store"
    assert jf_auth.asked == []


async def test_rejected_token_is_401(make_api, jf_auth, caplog):
    async with make_api(auth=f'MediaBrowser Token="{OTHER}"') as api:
        r = await api.get("/api/push/config")
    assert r.status_code == 401
    assert r.json() == {"error": "unauthorized", "detail": "Jellyfin rejected the token"}
    assert jf_auth.asked == [OTHER]
    assert "guard: rejected token" in caplog.text and OTHER not in caplog.text


@pytest.mark.parametrize("token", ["short", "x" * 15, "x" * 513, "has space in it 0123", 'quote"inside-0123456',
                                   "ünïcödé-0123456789abc"])
async def test_malformed_token_is_401_without_asking(token, jf_auth):
    guard, inner = make_guard()
    r = await call(guard, token=None, headers=[("x-emby-token", token)])
    assert r.status == 401 and r.json()["detail"] == "Jellyfin rejected the token"
    assert jf_auth.asked == [] and inner.scopes == []


async def test_the_user_id_reaches_the_route():
    guard, inner = make_guard()
    await call(guard)
    assert inner.scopes[0]["state"]["jellyfin_user"] == TEST_USER


async def test_the_user_and_role_reach_the_route():
    guard, inner = make_guard()
    await call(guard)
    await call(guard, token=NICOLE_TOKEN)
    st = [s["state"] for s in inner.scopes]
    assert st[0]["reel_user"] == sec.User(TEST_USER, "kirill", True)
    assert st[1]["reel_user"] == sec.User(NICOLE_USER, "nicole", False)
    assert st[1]["jellyfin_user"] == NICOLE_USER


async def test_each_request_gets_its_own_state_dict():
    """A server that hands every request the same lifespan state dict (asgi-
    lifespan does; uvicorn copies) must not let one request's user leak into
    another's: the guard writes into a copy."""
    guard, inner = make_guard()
    shared = {"from_lifespan": 1}
    for token in (TEST_TOKEN, NICOLE_TOKEN):
        scope = {"type": "http", "method": "GET", "path": "/api/activity", "query_string": b"",
                 "headers": [(b"host", b"nas"), (b"authorization", f'MediaBrowser Token="{token}"'.encode())],
                 "client": ("192.0.2.9", 1), "state": shared}
        sent = []

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(m):
            sent.append(m)

        await guard(scope, receive, send)
    a, b = (s["state"] for s in inner.scopes)
    assert a["reel_user"].id == TEST_USER and b["reel_user"].id == NICOLE_USER
    assert a["from_lifespan"] == b["from_lifespan"] == 1
    assert shared == {"from_lifespan": 1}


async def test_non_http_scopes_pass_untouched():
    guard, inner = make_guard()
    scope = {"type": "lifespan"}
    await guard(scope, None, None)
    assert inner.scopes == [scope]


# ---------------------------------------------------------------- open routes


@pytest.mark.parametrize("method, path", [("GET", "/health"), ("HEAD", "/health"),
                                          ("POST", "/api/push/unsubscribe")])
async def test_open_routes_need_no_token(method, path, jf_auth):
    guard, inner = make_guard()
    r = await call(guard, method=method, path=path, token=None)
    assert r.status == 200 and len(inner.scopes) == 1 and jf_auth.asked == []


@pytest.mark.parametrize("method, path", [("POST", "/health"), ("GET", "/health/"), ("GET", "/HEALTH"),
                                          ("GET", "/api/push/unsubscribe"), ("POST", "/api/push/unsubscribe/"),
                                          ("POST", "/api/push/subscribe"), ("GET", "/"), ("GET", "/docs"),
                                          ("GET", "/openapi.json"), ("OPTIONS", "/api/activity")])
async def test_everything_else_needs_a_token(method, path):
    guard, inner = make_guard()
    r = await call(guard, method=method, path=path, token=None)
    assert r.status == 401 and inner.scopes == []


def _all_routes(routes, prefix=""):
    """(method, path) of every route, routers included with include_router
    (FastAPI >= 0.140 keeps those as one _IncludedRouter entry) flattened."""
    out = []
    for r in routes:
        inner = getattr(r, "original_router", None)
        if inner is not None:
            out += _all_routes(inner.routes, prefix)  # the routers here have no prefix of their own
        else:
            out += [(m, prefix + r.path) for m in sorted(getattr(r, "methods", None) or ())]
    return out


def _concrete(path: str) -> str:
    """A route path with every {param} filled in."""
    import re

    return re.sub(r"\{[^}]+\}", "x", path)


async def test_every_app_route_but_the_open_ones_is_guarded(make_api, jf_auth):
    """Sweep the real app's route table: without a token, every method of
    every route is 401 — except exactly GET/HEAD /health and POST
    /api/push/unsubscribe."""
    async with make_api(auth=None) as api:
        routes = _all_routes(api.app_module.app.routes)
        paths = {p for _, p in routes}
        # every documented path is in the sweep, and the docs pages too
        assert set(api.app_module.app.openapi()["paths"]) <= paths
        assert {"/docs", "/redoc", "/openapi.json", "/api/push/subscribe", "/api/downloads/{gid}/hls"} <= paths
        opened = []
        for method, path in routes:
            r = await api.request(method, _concrete(path))
            if r.status_code != 401:
                opened.append((method, path, r.status_code))
            elif method != "HEAD":
                assert r.json()["error"] == "unauthorized"
    assert set(opened) == {("GET", "/health", 200),
                           ("POST", "/api/push/unsubscribe", 503)}  # push off in FULL_ENV
    assert jf_auth.asked == []


async def test_health_through_the_app_without_a_token(make_api):
    async with make_api(auth=None) as api:
        assert (await api.get("/health")).status_code == 200
        # HEAD passes the guard; the app itself has no HEAD route for /health
        assert (await api.head("/health")).status_code == 405


# ---------------------------------------------------------------- the /Users/Me cache


async def test_ok_is_cached_for_ok_ttl(clock, jf_auth):
    auth = sec.JellyfinAuth(JELLYFIN)
    assert await auth.user(TEST_TOKEN) == TEST_USER
    clock.t += sec.OK_TTL - 1
    assert await auth.user(TEST_TOKEN) == TEST_USER
    assert jf_auth.asked == [TEST_TOKEN]
    clock.t += 2
    assert await auth.user(TEST_TOKEN) == TEST_USER
    assert jf_auth.asked == [TEST_TOKEN, TEST_TOKEN]


async def test_a_rejection_is_cached_for_bad_ttl(clock, jf_auth):
    auth = sec.JellyfinAuth(JELLYFIN)
    assert await auth.user(OTHER) is None
    clock.t += sec.BAD_TTL - 1
    assert await auth.user(OTHER) is None
    assert jf_auth.asked == [OTHER]
    jf_auth.users[OTHER] = OTHER_USER  # e.g. the user signed in again
    clock.t += 2
    assert await auth.user(OTHER) == OTHER_USER
    assert jf_auth.asked == [OTHER, OTHER]


async def test_a_revoked_token_stops_working_after_ok_ttl(clock, jf_auth):
    auth = sec.JellyfinAuth(JELLYFIN)
    assert await auth.user(TEST_TOKEN) == TEST_USER
    del jf_auth.users[TEST_TOKEN]  # signed out in Jellyfin
    clock.t += sec.OK_TTL + 1
    assert await auth.user(TEST_TOKEN) is None


@pytest.mark.parametrize("status", [400, 401, 403, 404])
async def test_jellyfin_refusals_are_a_rejection(status, jf_auth):
    jf_auth.fault = httpx.Response(status)
    assert await sec.JellyfinAuth(JELLYFIN).user(TEST_TOKEN) is None


@pytest.mark.parametrize("fault", [
    httpx.ConnectError("refused"), httpx.ReadTimeout("hung"), httpx.Response(500), httpx.Response(502),
    httpx.Response(200, json={"Name": "no id"}), httpx.Response(200, json=None),
    httpx.Response(200, text="<html>not json</html>"), httpx.Response(302),
], ids=["refused", "timeout", "500", "502", "no-id", "null", "not-json", "redirect"])
async def test_unavailable_with_nothing_cached_raises(fault, jf_auth):
    jf_auth.fault = fault
    with pytest.raises(sec.Unavailable):
        await sec.JellyfinAuth(JELLYFIN).user(TEST_TOKEN)


async def test_jellyfin_down_and_nothing_cached_is_503(make_api, jf_auth, caplog):
    jf_auth.fault = httpx.ConnectError("refused")
    async with make_api() as api:
        r = await api.get("/api/push/config")
    assert r.status_code == 503
    assert r.json() == {"error": "temporarily_unavailable", "detail": "sign-in check unavailable, retry later"}
    assert r.headers["retry-after"] == "10" and r.headers["cache-control"] == "no-store"
    assert "jellyfin unreachable" in caplog.text


async def test_stale_ok_while_jellyfin_is_down(clock, jf_auth, caplog):
    auth = sec.JellyfinAuth(JELLYFIN)
    assert await auth.user(TEST_TOKEN) == TEST_USER
    jf_auth.fault = httpx.ConnectError("refused")
    clock.t += sec.OK_TTL + 1
    with caplog.at_level(logging.DEBUG, logger="reel_api"):
        assert await auth.user(TEST_TOKEN) == TEST_USER
    assert "jellyfin unreachable" in caplog.text
    clock.t += sec.STALE_OK  # a day later, still down: no longer good enough
    with pytest.raises(sec.Unavailable):
        await auth.user(TEST_TOKEN)


async def test_a_rejected_token_is_never_stale_ok(clock, jf_auth):
    auth = sec.JellyfinAuth(JELLYFIN)
    assert await auth.user(OTHER) is None
    jf_auth.fault = httpx.ConnectError("refused")
    clock.t += sec.BAD_TTL + 1
    with pytest.raises(sec.Unavailable):
        await auth.user(OTHER)


async def test_stale_ok_through_the_app(make_api, jf_auth, clock):
    async with make_api() as api:
        assert (await api.get("/api/push/config")).status_code == 200
        jf_auth.fault = httpx.ReadTimeout("hung")
        clock.t += sec.OK_TTL + 1
        assert (await api.get("/api/push/config")).status_code == 200
        r = await api.get("/api/push/config", headers={"Authorization": f'MediaBrowser Token="{OTHER}"'})
        assert r.status_code == 503  # an unknown token has nothing to fall back on


async def test_concurrent_checks_of_one_token_share_one_request(jf_auth):
    auth = sec.JellyfinAuth(JELLYFIN)
    jf_auth.gate = asyncio.Event()
    tasks = [asyncio.create_task(auth.user(TEST_TOKEN)) for _ in range(8)]
    await asyncio.sleep(0.05)
    assert jf_auth.asked == [TEST_TOKEN]
    jf_auth.gate.set()
    assert await asyncio.gather(*tasks) == [TEST_USER] * 8
    assert jf_auth.asked == [TEST_TOKEN] and auth._inflight == {}


async def test_a_cancelled_waiter_does_not_cancel_the_shared_check(jf_auth):
    auth = sec.JellyfinAuth(JELLYFIN)
    jf_auth.gate = asyncio.Event()
    first = asyncio.create_task(auth.user(TEST_TOKEN))
    second = asyncio.create_task(auth.user(TEST_TOKEN))
    await asyncio.sleep(0.05)
    first.cancel()  # a client went away mid-check
    jf_auth.gate.set()
    assert await second == TEST_USER
    assert jf_auth.asked == [TEST_TOKEN]


async def test_at_most_four_checks_at_a_time(jf_auth):
    auth = sec.JellyfinAuth(JELLYFIN)
    tokens = [f"token-{i:02d}-0123456789abcdef" for i in range(9)]
    for t in tokens:
        jf_auth.users[t] = f"{len(jf_auth.users):032x}"  # a user id (Guid) per token
    jf_auth.gate = asyncio.Event()
    tasks = [asyncio.create_task(auth.user(t)) for t in tokens]
    await asyncio.sleep(0.05)
    assert jf_auth.active == sec.MAX_CONCURRENT_CHECKS
    jf_auth.gate.set()
    assert len(await asyncio.gather(*tasks)) == 9
    assert jf_auth.max_active == sec.MAX_CONCURRENT_CHECKS


async def test_the_cache_is_bounded(monkeypatch, jf_auth):
    monkeypatch.setattr(sec, "CACHE_MAX", 2)
    auth = sec.JellyfinAuth(JELLYFIN)
    a, b, c = (f"{n}-token-0123456789abcdef" for n in "abc")
    for t in (a, b, c):
        jf_auth.users[t] = t[:1] * 32
        await auth.user(t)
    assert len(auth._cache) == 2
    await auth.user(b)  # still cached
    await auth.user(a)  # evicted: asked again
    assert jf_auth.asked == [a, b, c, a]


async def test_the_cache_keys_are_hashes_not_tokens(jf_auth):
    auth = sec.JellyfinAuth(JELLYFIN)
    await auth.user(TEST_TOKEN)
    assert TEST_TOKEN not in repr(auth._cache)


# ---------------------------------------------------------------- api_key in logs and error bodies


def _access_record(path: str) -> logging.LogRecord:
    """A record shaped like uvicorn's access log line."""
    return logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d',
                             ("192.0.2.9:50000", "GET", path, "1.1", 200), None)


@pytest.mark.parametrize("path, shown", [
    (f"/api/downloads/x/stream?api_key={TEST_TOKEN}", "/api/downloads/x/stream?api_key=***"),
    (f"/s?a=1&API_KEY={TEST_TOKEN}&b=2", "/s?a=1&API_KEY=***&b=2"),
    (f"/s?api_key={TEST_TOKEN}&api_key={OTHER}", "/s?api_key=***&api_key=***"),
    ("/s?not_api_key=1", "/s?not_api_key=1"),
    ("/api/activity", "/api/activity"),
])
def test_the_access_log_blanks_api_key(path, shown):
    rec = _access_record(path)
    assert sec.RedactTokens().filter(rec) is True
    assert rec.args[2] == shown
    assert TEST_TOKEN not in rec.getMessage() and OTHER not in rec.getMessage()


def test_redaction_leaves_other_records_alone():
    rec = logging.LogRecord("x", logging.INFO, __file__, 1, "plain %s", ("api_key=1",), None)
    assert sec.RedactTokens().filter(rec) and rec.args == ("api_key=1",)
    rec = logging.LogRecord("x", logging.INFO, __file__, 1, "no args", None, None)
    assert sec.RedactTokens().filter(rec) and rec.args is None


def test_the_app_installs_the_redaction_on_uvicorns_access_log(app_module):
    assert any(isinstance(f, sec.RedactTokens) for f in logging.getLogger("uvicorn.access").filters)


async def test_api_key_never_appears_in_an_error_body_or_the_guard_log(make_api, jf_auth, caplog):
    async with make_api(auth=None) as api:
        bad = await api.get(f"/api/push/config?api_key={OTHER}")
        missing = await api.get(f"/api/downloads/{'ab' * 20}/hls?api_key={TEST_TOKEN}")
        invalid = await api.get(f"/api/trailers/short?api_key={TEST_TOKEN}")
    assert bad.status_code == 401 and OTHER not in bad.text
    assert missing.status_code == 404 and TEST_TOKEN not in missing.text
    assert invalid.status_code == 400 and TEST_TOKEN not in invalid.text
    assert OTHER not in caplog.text and TEST_TOKEN not in caplog.text


async def test_a_validation_error_does_not_echo_the_token(make_api):
    """FastAPI's 422 echoes the bad input; a token in another parameter stays out."""
    async with make_api(auth=None) as api:
        r = await api.get(f"/api/lookup?type=book&q=x&api_key={TEST_TOKEN}")
    assert r.status_code == 422 and TEST_TOKEN not in r.text


# ---------------------------------------------------------------- a hanging Jellyfin


async def test_a_jellyfin_outage_is_waited_for_once_not_per_request(clock, jf_auth, caplog):
    """Jellyfin hanging (not refusing) used to cost every request of a token
    confirmed > OK_TTL ago a fresh check and up to CHECK_TIMEOUT of waiting
    before stale-OK: back-to-back Range/segment/live-HLS requests all paid
    it. After one failed check the outage is remembered for DOWN_TTL and
    stale-OK answers at once; it is logged once."""
    auth = sec.JellyfinAuth(JELLYFIN)
    assert await auth.user(TEST_TOKEN) == TEST_USER
    jf_auth.fault = httpx.ReadTimeout("hung")
    clock.t += sec.OK_TTL + 1
    with caplog.at_level(logging.INFO, logger="reel_api"):
        for _ in range(20):
            assert await auth.user(TEST_TOKEN) == TEST_USER
        clock.t += sec.DOWN_TTL - 1
        assert await auth.user(TEST_TOKEN) == TEST_USER
    assert jf_auth.asked == [TEST_TOKEN, TEST_TOKEN]  # the first check, then the one that hung
    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert len(warnings) == 1 and "jellyfin unreachable" in warnings[0].getMessage()


async def test_the_outage_marker_expires_and_recovery_clears_it(clock, jf_auth, caplog):
    auth = sec.JellyfinAuth(JELLYFIN)
    await auth.user(TEST_TOKEN)
    jf_auth.fault = httpx.ConnectError("refused")
    clock.t += sec.OK_TTL + 1
    assert await auth.user(TEST_TOKEN) == TEST_USER
    clock.t += sec.DOWN_TTL + 1  # marker over, still down: asked again, still stale-OK
    with caplog.at_level(logging.INFO, logger="reel_api"):
        assert await auth.user(TEST_TOKEN) == TEST_USER
        assert len(jf_auth.asked) == 3
        assert len([r for r in caplog.records if r.levelno >= logging.WARNING]) == 1  # still the first outage
        jf_auth.fault = None
        clock.t += sec.DOWN_TTL + 1
        assert await auth.user(TEST_TOKEN) == TEST_USER
    assert len(jf_auth.asked) == 4
    assert "jellyfin answers again" in caplog.text
    # back to normal: a revoked token is caught by the next OK_TTL check again
    del jf_auth.users[TEST_TOKEN]
    clock.t += sec.OK_TTL + 1
    assert await auth.user(TEST_TOKEN) is None


async def test_during_an_outage_every_confirmed_token_answers_at_once(clock, jf_auth):
    auth = sec.JellyfinAuth(JELLYFIN)
    jf_auth.users[OTHER] = OTHER_USER
    await auth.user(TEST_TOKEN)
    await auth.user(OTHER)
    jf_auth.fault = httpx.ReadTimeout("hung")
    clock.t += sec.OK_TTL + 1
    assert await auth.user(TEST_TOKEN) == TEST_USER  # this check finds the outage
    assert await auth.user(OTHER) == OTHER_USER  # this one doesn't ask again
    assert jf_auth.asked == [TEST_TOKEN, OTHER, TEST_TOKEN]


async def test_an_unknown_token_is_still_checked_during_an_outage(clock, jf_auth):
    """No fallback for it, so it isn't refused unasked: Jellyfin may be back."""
    auth = sec.JellyfinAuth(JELLYFIN)
    await auth.user(TEST_TOKEN)
    jf_auth.fault = httpx.ReadTimeout("hung")
    clock.t += sec.OK_TTL + 1
    await auth.user(TEST_TOKEN)
    with pytest.raises(sec.Unavailable):
        await auth.user(OTHER)
    jf_auth.fault = None
    jf_auth.users[OTHER] = OTHER_USER
    assert await auth.user(OTHER) == OTHER_USER
    assert jf_auth.asked[-2:] == [OTHER, OTHER]


async def test_back_to_back_stream_requests_during_an_outage(make_api, jf_auth, clock):
    async with make_api() as api:
        assert (await api.get("/api/push/config")).status_code == 200
        jf_auth.fault = httpx.ReadTimeout("hung")
        clock.t += sec.OK_TTL + 1
        for _ in range(10):
            assert (await api.get("/api/push/config")).status_code == 200
    assert jf_auth.asked == [TEST_TOKEN, TEST_TOKEN]


# ---------------------------------------------------------------- an empty token


@pytest.mark.parametrize("auth", ['MediaBrowser Token=""', 'MediaBrowser Client="VibeReel", Token=""',
                                  'Emby Token=""', "Bearer", "Bearer    "])
@pytest.mark.parametrize("other, query", [
    ({"x-emby-token": TEST_TOKEN}, ""),
    ({"x-mediabrowser-token": TEST_TOKEN}, ""),
    ({}, f"api_key={TEST_TOKEN}"),
])
def test_an_empty_authorization_token_falls_through(auth, other, query):
    assert sec.token_from({"authorization": auth, **other}, query) == TEST_TOKEN


@pytest.mark.parametrize("auth", ['MediaBrowser Token=""', "Bearer "])
def test_an_empty_token_alone_is_none(auth):
    assert sec.token_from({"authorization": auth}, "") is None


def test_a_blank_x_emby_token_falls_through():
    assert sec.token_from({"x-emby-token": "   ", "x-mediabrowser-token": TEST_TOKEN}, "") == TEST_TOKEN
    assert sec.token_from({"x-emby-token": " ", "x-mediabrowser-token": ""}, f"api_key={TEST_TOKEN}") == TEST_TOKEN


async def test_an_empty_token_header_with_api_key_through_the_app(make_api):
    async with make_api(auth='MediaBrowser Token=""') as api:
        assert (await api.get(f"/api/push/config?api_key={TEST_TOKEN}")).status_code == 200


# ---------------------------------------------------------------- the user and the role


async def test_who_names_the_user_and_the_role(jf_auth):
    auth = sec.JellyfinAuth(JELLYFIN)
    assert await auth.who(TEST_TOKEN) == sec.User(TEST_USER, "kirill", True)
    assert await auth.who(NICOLE_TOKEN) == sec.User(NICOLE_USER, "nicole", False)
    assert await auth.who(OTHER) is None
    assert await auth.who("short") is None
    assert await auth.user(NICOLE_TOKEN) == NICOLE_USER  # user() still answers the id


@pytest.mark.parametrize("body, admin", [
    ({"Id": "A" * 32, "Name": "x"}, False),                                       # no Policy
    ({"Id": "A" * 32, "Name": "x", "Policy": None}, False),
    ({"Id": "A" * 32, "Name": "x", "Policy": []}, False),
    ({"Id": "A" * 32, "Name": "x", "Policy": {}}, False),
    ({"Id": "A" * 32, "Name": "x", "Policy": {"IsAdministrator": "true"}}, False),  # a string is not true
    ({"Id": "A" * 32, "Name": "x", "Policy": {"IsAdministrator": 1}}, False),
    ({"Id": "A" * 32, "Name": "x", "Policy": {"IsAdministrator": False}}, False),
    ({"Id": "A" * 32, "Name": "x", "Policy": {"IsAdministrator": True}}, True),
], ids=["no-policy", "null", "list", "empty", "string", "one", "false", "true"])
async def test_only_a_literal_true_is_an_admin(jf_auth, body, admin):
    jf_auth.fault = httpx.Response(200, json=body)
    u = await sec.JellyfinAuth(JELLYFIN).who(TEST_TOKEN)
    assert u == sec.User("a" * 32, "x", admin)


@pytest.mark.parametrize("name, expect", [(None, ""), (5, ""), ("Zhenya", "Zhenya")])
async def test_a_missing_or_odd_name_is_empty(jf_auth, name, expect):
    body = {"Id": TEST_USER, "Policy": {"IsAdministrator": True}}
    if name is not None:
        body["Name"] = name
    jf_auth.fault = httpx.Response(200, json=body)
    assert (await sec.JellyfinAuth(JELLYFIN).who(TEST_TOKEN)).name == expect


async def test_a_dashed_uppercase_id_is_normalised(jf_auth):
    jf_auth.fault = httpx.Response(200, json={"Id": "4F1C0D9E-8B7A-4C3D-2E1F-0A9B8C7D6E5F", "Name": "n"})
    u = await sec.JellyfinAuth(JELLYFIN).who(TEST_TOKEN)
    assert u.id == "4f1c0d9e8b7a4c3d2e1f0a9b8c7d6e5f"
    assert sec.norm_user_id("4F1C-0D9E") == "4f1c0d9e"


async def test_a_list_body_is_unavailable(jf_auth):
    jf_auth.fault = httpx.Response(200, json=[{"Id": TEST_USER}])
    with pytest.raises(sec.Unavailable):
        await sec.JellyfinAuth(JELLYFIN).who(TEST_TOKEN)


async def test_the_role_is_cached_with_the_token(clock, jf_auth):
    """A promotion/demotion takes effect at the next check, within OK_TTL."""
    auth = sec.JellyfinAuth(JELLYFIN)
    assert (await auth.who(NICOLE_TOKEN)).admin is False
    jf_auth.admins.add(NICOLE_USER)
    clock.t += sec.OK_TTL - 1
    assert (await auth.who(NICOLE_TOKEN)).admin is False
    clock.t += 2
    assert (await auth.who(NICOLE_TOKEN)).admin is True
    jf_auth.admins.discard(NICOLE_USER)
    clock.t += sec.OK_TTL + 1
    assert (await auth.who(NICOLE_TOKEN)).admin is False


async def test_stale_ok_keeps_the_role_it_had(clock, jf_auth):
    auth = sec.JellyfinAuth(JELLYFIN)
    assert (await auth.who(TEST_TOKEN)).admin is True
    jf_auth.admins.clear()  # demoted, but Jellyfin goes down before anyone asks
    jf_auth.fault = httpx.ConnectError("refused")
    clock.t += sec.OK_TTL + 1
    assert await auth.who(TEST_TOKEN) == sec.User(TEST_USER, "kirill", True)
    clock.t += 1  # inside DOWN_TTL: answered from the cache at once
    assert (await auth.who(TEST_TOKEN)).admin is True
