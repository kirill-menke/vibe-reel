"""app.py helpers the route tests only reached loosely — found by the T40
mutation pass (tests/run_mutmut.sh app): the exact lookup-cache and add-memory
boundaries, which cached lookups an add/undo may patch, the server-log lines
behind the "not configured" 503s, the warm-up's TTL clamp and pass log, and
the gzip level."""

from __future__ import annotations

import asyncio
import logging
import time
import zlib

import httpx
import pytest

from reel_api import trending as trending_mod
from tests.support.arr import movie_obj, series_obj
from tests.support.clock import FakeClock
from tests.support.qbit import SimFile, SimTorrent, make_hash
from tests.test_lifespan import FakeCharts, FakeTrending

LOOKUP = "/api/v3/series/lookup"
MLOOKUP = "/api/v3/movie/lookup"


async def added(api, q, kind="tv") -> dict[str, bool]:
    r = await api.get("/api/lookup", params={"q": q, "type": kind})
    assert r.status_code == 200, r.text
    return {x["id"]: x["added"] for x in r.json()["results"]}


async def add(api, media_id, kind="tv") -> str:
    r = await api.post("/api/library", json={"id": media_id, "type": kind})
    assert r.status_code == 202, r.text
    return r.json()["undo"]


def messages(caplog, logger="reel_api") -> list[str]:
    return [r.getMessage() for r in caplog.records if r.name == logger]


# ---------------------------------------------------------------- lookup cache


async def test_lookup_cache_entry_expires_at_exactly_the_ttl(api, sonarr, monkeypatch):
    """`age < LOOKUP_TTL` is a hit; at exactly 90 s the arr is asked again."""
    clock = FakeClock().install(monkeypatch, api.app_module)
    sonarr.add_catalog(series_obj(1, "Dark"))
    await added(api, "dark")
    clock.t += api.app_module.LOOKUP_TTL
    await added(api, "dark")
    assert sonarr.count(LOOKUP) == 2


async def test_add_memory_lasts_exactly_two_ttls(api, sonarr, monkeypatch):
    """A stale arr answer is patched to added=True while the add is at most
    2 x LOOKUP_TTL old (`age > 2*TTL` forgets it), not a second longer."""
    mod = api.app_module
    clock = FakeClock().install(monkeypatch, mod)
    sonarr.add_catalog(series_obj(1, "Dark"))
    await add(api, "1")
    sonarr.set_lookup("dark", [series_obj(1, "Dark")])  # the arr still says not added
    clock.t += 2 * mod.LOOKUP_TTL
    assert await added(api, "dark") == {"1": True}
    assert ("tv", "1") in mod._recent_adds
    clock.t += 1  # the entry cached a second ago is re-patched on read: now without the add
    assert await added(api, "dark") == {"1": False}
    assert ("tv", "1") not in mod._recent_adds


async def test_an_add_never_marks_the_other_types_cached_lookups(api, sonarr, radarr):
    """tvdb and tmdb ids are separate number spaces: adding show 603 leaves a
    cached movie lookup listing film 603 as not added."""
    radarr.add_catalog(movie_obj(603, "The Matrix"))
    sonarr.add_catalog(series_obj(603, "The Matrix Show"))
    assert await added(api, "the matrix", "movie") == {"603": False}
    await add(api, "603", "tv")
    n = radarr.count(MLOOKUP)
    assert await added(api, "the matrix", "movie") == {"603": False}
    assert radarr.count(MLOOKUP) == n  # answered from the cache


async def test_undo_only_unmarks_the_undone_title(api, sonarr):
    sonarr.add_series(series_obj(1, "Dark"))  # in the library before
    sonarr.add_catalog(series_obj(2, "Dark Matter"))
    token = await add(api, "2")
    assert await added(api, "dark") == {"1": True, "2": True}
    n = sonarr.count(LOOKUP)
    r = await api.delete("/api/library/tv/2", params={"undo": token})
    assert r.status_code == 200, r.text
    assert await added(api, "dark") == {"1": True, "2": False}
    assert sonarr.count(LOOKUP) == n


async def test_a_tv_undo_keeps_the_movie_library_caches(api, sonarr):
    """Only a movie add/undo can change Radarr's library: the collections'
    and the movie charts' library-id caches survive a tv undo."""
    mod = api.app_module
    sonarr.add_catalog(series_obj(2, "Dark Matter"))
    token = await add(api, "2")
    mod.collections._library = (time.monotonic(), {"603"})
    mod.charts._library["movie"] = (time.monotonic(), {"603"})
    mod.charts._library["tv"] = (time.monotonic(), {"2"})
    assert (await api.delete("/api/library/tv/2", params={"undo": token})).status_code == 200
    assert mod.collections._library is not None
    assert "movie" in mod.charts._library and "tv" not in mod.charts._library


# ---------------------------------------------------------------- 503 causes in the server log


async def test_no_qbittorrent_logs_why(make_api, caplog):
    caplog.set_level(logging.WARNING, logger="reel_api")
    async with make_api(QBIT_URL=None) as api:
        for path in ("stream", "probe"):
            r = await api.get(f"/api/downloads/{make_hash('x')}/{path}")
            assert r.status_code == 503
    assert messages(caplog).count("download backend: qBittorrent not configured (QBIT_URL)") == 2


# ---------------------------------------------------------------- sequential fix-up log


SEQ = "/torrents/toggleSequentialDownload"


async def _poll_with_a_torrent_lacking_sequential(api, radarr, qbit):
    m = radarr.add_movie(movie_obj(5, "Alien"))
    radarr.grab(m["id"], make_hash("t").upper())
    qbit.add_torrent(SimTorrent(hash=make_hash("t"), name="t", category="radarr",
                                files=[SimFile("t.mkv", 4 * 65536)], pieces=[2, 2, 0, 0],
                                seq_dl=False, f_l_piece_prio=True))
    assert (await api.get("/api/activity")).status_code == 200
    for _ in range(50):
        await asyncio.sleep(0)


async def test_sequential_fix_up_is_logged_with_the_torrent_count(api, sonarr, radarr, qbit, caplog):
    caplog.set_level(logging.INFO, logger="reel_api")
    await _poll_with_a_torrent_lacking_sequential(api, radarr, qbit)
    assert "forced sequential download on 1 torrent(s)" in messages(caplog)


async def test_sequential_fix_up_failure_is_logged_with_its_cause(api, sonarr, radarr, qbit, caplog):
    caplog.set_level(logging.WARNING, logger="reel_api")
    qbit.fail(SEQ, exc=httpx.ConnectError("link down"))
    await _poll_with_a_torrent_lacking_sequential(api, radarr, qbit)
    (msg,) = [m for m in messages(caplog) if m.startswith("could not force sequential download: ")]
    assert "link down" in msg


# ---------------------------------------------------------------- warm-up


@pytest.fixture
def warm_loop(app_module, manual_clock, monkeypatch):
    manual_clock.install(monkeypatch, app_module)
    tasks = []

    def start(trending, charts):
        monkeypatch.setattr(app_module, "arr_clients", {"tv": object()})
        monkeypatch.setattr(app_module, "trending", trending)
        monkeypatch.setattr(app_module, "charts", charts)
        tasks.append(asyncio.create_task(app_module._keep_warm_real()))

    yield start
    for t in tasks:
        t.cancel()


async def test_warm_up_ttl_is_clamped_at_zero(warm_loop, app_module, manual_clock, monkeypatch):
    """A margin longer than the trending TTL refreshes with ttl 0, never a
    negative one."""
    monkeypatch.setattr(app_module, "WARM_MARGIN", trending_mod.CACHE_TTL + 100)
    tr = FakeTrending()
    warm_loop(tr, FakeCharts())
    await manual_clock.settle(50)
    await manual_clock.advance(app_module.WARM_EVERY, settle=50)
    assert tr.calls == [("tv", trending_mod.CACHE_TTL), ("tv", 0)]


async def test_warm_up_pass_logs_its_duration(warm_loop, manual_clock, caplog):
    caplog.set_level(logging.INFO, logger="reel_api")
    warm_loop(FakeTrending(), FakeCharts())
    await manual_clock.settle(50)
    assert messages(caplog) == ["warm-up pass done in 0.0 s"]  # virtual time stood still


# ---------------------------------------------------------------- gzip


async def test_json_is_gzipped_at_level_6(api):
    """The middleware's compresslevel is 6 (zlib's default trade-off): the
    deflate stream inside the gzip body is exactly what level 6 produces."""
    async with api.stream("GET", "/openapi.json", headers={"Accept-Encoding": "gzip"}) as r:
        assert r.headers["content-encoding"] == "gzip"
        raw = b"".join([c async for c in r.aiter_raw()])
    body = (await api.get("/openapi.json")).content

    def deflate(level: int) -> bytes:
        c = zlib.compressobj(level, zlib.DEFLATED, -zlib.MAX_WBITS)
        return c.compress(body) + c.flush()

    assert deflate(6) != deflate(7)  # the body tells the levels apart
    assert raw[10:-8] == deflate(6)
