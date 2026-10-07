"""app.py's lifespan (backends built at startup, the background warm-up
`_keep_warm`) and the `reel-api` console entry point
(server.py)."""

from __future__ import annotations

import asyncio
import logging

import pytest

from reel_api import charts as charts_mod
from reel_api import push as push_mod
from reel_api import qbittorrent as qbit_mod
from reel_api import server
from reel_api import trending as trending_mod


# ---------------------------------------------------------------- the warm-up loop


class FakeTrending:
    def __init__(self, fail=()):
        self.calls: list[tuple[str, float]] = []
        self.fail = set(fail)

    async def get(self, kind, ttl):
        self.calls.append((kind, ttl))
        if kind in self.fail:
            raise RuntimeError(f"imdb down for {kind}")
        return []


class FakeCharts:
    def __init__(self, fail=False):
        self.margins: list[float] = []
        self.fail = fail

    async def warm(self, margin=0):
        self.margins.append(margin)
        if self.fail:
            raise RuntimeError("charts broke")


@pytest.fixture
def warm(app_module, manual_clock, monkeypatch):
    """Drive app._keep_warm (the real one) on a manual clock with fake
    trending/charts. Returns a setup(kinds, trending, charts) -> task."""
    manual_clock.install(monkeypatch, app_module)
    tasks = []

    def setup(kinds=("tv", "movie"), trending=None, charts=None):
        monkeypatch.setattr(app_module, "arr_clients", {k: object() for k in kinds})
        monkeypatch.setattr(app_module, "trending", trending or FakeTrending())
        monkeypatch.setattr(app_module, "charts", charts or FakeCharts())
        tasks.append(asyncio.create_task(app_module._keep_warm_real()))
        return tasks[-1]

    yield setup
    for t in tasks:
        t.cancel()


async def test_first_pass_fills_then_refreshes_every_warm_every_with_the_margin(warm, app_module, manual_clock):
    tr, ch = FakeTrending(), FakeCharts()
    task = warm(trending=tr, charts=ch)
    await manual_clock.settle(50)
    # first pass: margin 0 — the empty caches are filled with the full TTL
    assert tr.calls == [("tv", trending_mod.CACHE_TTL), ("movie", trending_mod.CACHE_TTL)]
    assert ch.margins == [0]
    assert manual_clock.sleeps == [app_module.WARM_EVERY]

    await manual_clock.advance(app_module.WARM_EVERY - 1, settle=50)
    assert len(ch.margins) == 1  # not a second early
    await manual_clock.advance(1, settle=50)
    # every later pass refreshes WARM_MARGIN before expiry (ttl clamped at 0)
    refreshed = max(trending_mod.CACHE_TTL - app_module.WARM_MARGIN, 0)
    assert tr.calls[2:] == [("tv", refreshed), ("movie", refreshed)]
    assert ch.margins == [0, app_module.WARM_MARGIN]
    await manual_clock.advance(app_module.WARM_EVERY, settle=50)
    assert ch.margins == [0, app_module.WARM_MARGIN, app_module.WARM_MARGIN]
    assert not task.done()


def test_warm_constants_refresh_before_expiry():
    """WARM_MARGIN > WARM_EVERY: an entry that would expire before the next
    pass is refetched in this one, so requests never land on a stale list."""
    from reel_api import app

    assert app.WARM_MARGIN > app.WARM_EVERY
    assert charts_mod.LIST_TTL > app.WARM_MARGIN


@pytest.mark.parametrize("kinds", [("tv",), ("movie",), ()])
async def test_trending_only_for_configured_kinds(warm, manual_clock, kinds):
    tr, ch = FakeTrending(), FakeCharts()
    warm(kinds=kinds, trending=tr, charts=ch)
    await manual_clock.settle(50)
    assert [k for k, _ in tr.calls] == list(kinds)
    assert ch.margins == [0]  # charts warm themselves per kind (charts.py)


async def test_failing_trending_and_charts_only_log(warm, app_module, manual_clock, caplog):
    caplog.set_level(logging.WARNING, logger="reel_api")
    tr, ch = FakeTrending(fail={"tv"}), FakeCharts(fail=True)
    task = warm(trending=tr, charts=ch)
    await manual_clock.settle(50)
    # the tv failure didn't stop the movie warm-up nor the charts
    assert [k for k, _ in tr.calls] == ["tv", "movie"] and ch.margins == [0]
    msgs = [r.getMessage() for r in caplog.records]
    assert "warm-up: trending tv failed: imdb down for tv" in msgs
    assert "warm-up: charts failed: charts broke" in msgs
    # and the loop goes on
    await manual_clock.advance(app_module.WARM_EVERY, settle=50)
    assert len(ch.margins) == 2 and not task.done()


async def test_lifespan_starts_the_warm_up_and_cancels_it_on_shutdown(make_api, app_module, monkeypatch):
    state = {"started": 0, "cancelled": 0}

    async def fake_warm():
        state["started"] += 1
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            state["cancelled"] += 1
            raise

    monkeypatch.setattr(app_module, "_keep_warm", fake_warm)
    async with make_api():
        await asyncio.sleep(0)
        assert state == {"started": 1, "cancelled": 0}
    await asyncio.sleep(0)
    assert state == {"started": 1, "cancelled": 1}


# ---------------------------------------------------------------- backends built at startup


async def test_backends_with_everything_configured(make_api, app_module):
    async with make_api():
        assert set(app_module.arr_clients) == {"tv", "movie"}
        assert isinstance(app_module.downloader, qbit_mod.QBittorrentClient)
        assert app_module.collections is not None
        assert app_module.undo.qb is app_module.downloader
        assert app_module.trending is not None and app_module.charts is not None


async def test_collections_only_with_radarr(make_api, app_module):
    async with make_api(RADARR_API_KEY=None):
        assert set(app_module.arr_clients) == {"tv"}
        assert app_module.collections is None


async def test_nothing_configured_still_starts(make_api, app_module):
    env = {k: None for k in ("SONARR_API_KEY", "RADARR_API_KEY", "QBIT_URL")}
    async with make_api(**env) as api:
        assert app_module.arr_clients == {} and app_module.downloader is None
        assert app_module.collections is None and app_module.undo.qb is None
        assert (await api.get("/health")).status_code == 200


async def test_push_watcher_not_started_without_vapid_key(make_api, caplog):
    caplog.set_level(logging.INFO, logger="reel_api")
    async with make_api():
        assert push_mod._push is not None and push_mod._push.enabled is False
        assert push_mod._push.task is None
    assert any("VAPID_PRIVATE_KEY not set" in r.getMessage() for r in caplog.records)


async def test_push_watcher_started_with_a_vapid_key(make_api):
    key, _ = push_mod.generate_key()
    async with make_api(VAPID_PRIVATE_KEY=key, VAPID_SUBJECT="mailto:test@example.com"):
        assert push_mod._push.enabled is True
        assert isinstance(push_mod._push.task, asyncio.Task) and not push_mod._push.task.done()


# ---------------------------------------------------------------- server.main


class _FakeServer:
    """uvicorn.Server stand-in: records the config and the sockets run() gets
    (the real one would serve on them, and the real _bind would take :8790)."""

    def __init__(self, calls, config):
        self.calls, self.config = calls, config

    def run(self, sockets=None):
        self.calls.append({"app": self.config.app, "host": self.config.host, "port": self.config.port,
                           "log_level": self.config.log_level, "sockets": sockets})


@pytest.fixture
def uvicorn_run(monkeypatch):
    calls = []
    bound = []
    monkeypatch.setattr(server.uvicorn, "Server", lambda config: _FakeServer(calls, config))
    monkeypatch.setattr(server.uvicorn, "run", lambda *a, **kw: pytest.fail("main() must not call uvicorn.run"))

    def fake_bind(addr, port):
        bound.append((addr, port))
        return f"sock:{addr}:{port}"

    monkeypatch.setattr(server, "_bind", fake_bind)
    return calls, bound


def test_server_defaults(uvicorn_run):
    calls, bound = uvicorn_run
    server.main()
    assert calls == [{"app": "reel_api.app:app", "host": "127.0.0.1", "port": 8790, "log_level": "info",
                      "sockets": ["sock:127.0.0.1:8790"]}]
    assert bound == [("127.0.0.1", 8790)]


def test_server_env_overrides(uvicorn_run, reel_env):
    calls, bound = uvicorn_run
    reel_env(HOST="0.0.0.0", PORT="9001", LOG_LEVEL="debug")
    server.main()
    assert calls == [{"app": "reel_api.app:app", "host": "0.0.0.0", "port": 9001, "log_level": "debug",
                      "sockets": ["sock:0.0.0.0:9001"]}]


def test_server_binds_every_listed_host(uvicorn_run, reel_env):
    calls, bound = uvicorn_run
    reel_env(HOST=" 127.0.0.1 , 192.0.2.7,,::1 ")
    server.main()
    assert bound == [("127.0.0.1", 8790), ("192.0.2.7", 8790), ("::1", 8790)]
    assert calls[0]["host"] == "127.0.0.1"
    assert calls[0]["sockets"] == ["sock:127.0.0.1:8790", "sock:192.0.2.7:8790", "sock:::1:8790"]


def test_server_bad_port_fails_before_binding(uvicorn_run, reel_env):
    calls, bound = uvicorn_run
    reel_env(PORT="eighty")
    with pytest.raises(ValueError):
        server.main()
    assert calls == [] and bound == []


def test_bind_loopback_v4():
    sock = server._bind("127.0.0.1", 0)
    try:
        assert sock.getsockname()[0] == "127.0.0.1"
        assert sock.get_inheritable()
    finally:
        sock.close()


def test_bind_v6_is_v6only():
    import socket

    try:
        sock = server._bind("::1", 0)
    except OSError:
        pytest.skip("no IPv6 loopback here")
    try:
        assert sock.family == socket.AF_INET6
        assert sock.getsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY) == 1
    finally:
        sock.close()


def test_bind_freebind_for_an_unconfigured_lan_address(monkeypatch):
    """A LAN address gets IP_FREEBIND (the service may start before the
    network); a setsockopt the kernel refuses is not fatal."""
    import socket

    opts = []

    class FakeSock:
        def __init__(self, family, kind):
            self.family = family

        def setsockopt(self, level, opt, val):
            opts.append((level, opt, val))
            if opt == server._IP_FREEBIND:
                raise OSError("not permitted")

        def bind(self, addr):
            self.addr = addr

        def set_inheritable(self, v):
            self.inheritable = v

    monkeypatch.setattr(server.socket, "socket", FakeSock)
    s = server._bind("192.0.2.7", 8790)
    assert s.addr == ("192.0.2.7", 8790) and s.inheritable is True
    assert (socket.SOL_IP, server._IP_FREEBIND, 1) in opts
    opts.clear()
    server._bind("127.0.0.1", 8790)
    assert all(o[1] != server._IP_FREEBIND for o in opts)
