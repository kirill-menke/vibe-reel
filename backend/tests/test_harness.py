"""The harness itself: no network, isolated env, virtual time, fresh app state.

If one of these fails, every other result in the suite is suspect."""

import asyncio
import os
import re
import socket

import httpx
import pytest
import pytest_socket
import respx

from reel_api.arr import ArrClient
from reel_api.security import User
from tests.conftest import RADARR, RADARR_KEY, TEST_USER
from tests.support.arr import movie_obj
from tests.support.clock import FakeClock

BLOCKED = (pytest_socket.SocketBlockedError, pytest_socket.SocketConnectBlockedError)


def _contains_blocked(exc: BaseException) -> bool:
    seen = set()
    stack = [exc]
    while stack:
        e = stack.pop()
        if e is None or id(e) in seen:
            continue
        seen.add(id(e))
        if isinstance(e, BLOCKED):
            return True
        stack += [e.__cause__, e.__context__, *getattr(e, "exceptions", ())]
    return False


def test_outbound_socket_is_blocked():
    with pytest.raises(BLOCKED):
        socket.create_connection(("192.0.2.1", 80), timeout=1)  # TEST-NET-1, never routable


def test_ipv6_connect_to_non_loopback_is_blocked():
    with pytest.raises(BLOCKED):
        socket.create_connection(("2001:db8::1", 80), timeout=1)  # documentation prefix


async def test_real_httpx_transport_cannot_leave_the_host():
    # bypass respx entirely: a raw transport must still be refused by the socket guard
    with respx.mock(assert_all_mocked=False) as r:
        r.route().pass_through()
        async with httpx.AsyncClient(timeout=2) as c:
            with pytest.raises(BaseException) as ei:
                await c.get("http://192.0.2.1/")
    assert _contains_blocked(ei.value), repr(ei.value)


async def test_unmocked_httpx_request_fails():
    async with httpx.AsyncClient() as c:
        with pytest.raises(respx.models.AllMockedAssertionError):
            await c.get("http://sonarr.test/api/v3/system/status")


def test_env_is_isolated(tmp_path):
    assert os.environ["CACHE_DIRECTORY"].startswith(str(tmp_path))
    assert os.environ["STATE_DIRECTORY"].startswith(str(tmp_path))
    for k in ("SONARR_API_KEY", "RADARR_API_KEY", "PROWLARR_API_KEY", "QBIT_URL", "VAPID_PRIVATE_KEY"):
        assert k not in os.environ


async def test_fake_clock_auto_advances_module_time(monkeypatch):
    from reel_api import streaming

    clock = FakeClock(start=100.0).install(monkeypatch, streaming)
    t0 = streaming.time.monotonic()
    await streaming.asyncio.sleep(120)
    assert streaming.time.monotonic() - t0 == 120
    assert clock.sleeps == [120]
    # only the patched module sees fake time; asyncio itself is untouched
    assert asyncio.sleep is not streaming.asyncio.sleep


async def test_manual_clock_wakes_sleepers_in_order():
    clock = FakeClock(auto=False)
    woke = []

    async def sleeper(name, s):
        await clock.sleep(s)
        woke.append((name, clock.monotonic()))

    tasks = [asyncio.create_task(sleeper("b", 20)), asyncio.create_task(sleeper("a", 10))]
    await clock.settle()
    assert clock.pending_sleepers == 2 and woke == []
    await clock.advance(15)
    assert woke == [("a", clock.monotonic() - 5)]
    await clock.advance(5)
    assert [n for n, _ in woke] == ["a", "b"]
    await asyncio.gather(*tasks)


async def test_app_module_is_fresh_per_test_a(api):
    api.app_module._lookup_cache[("marker", "tv")] = (0.0, [])


async def test_app_module_is_fresh_per_test_b(api):
    assert ("marker", "tv") not in api.app_module._lookup_cache


def test_the_yt_dlp_on_path_is_the_guard(no_real_ytdlp, tmp_path):
    """No test can reach a real yt-dlp: the first one on PATH is the guard,
    which fails, and a call to it fails the test at teardown."""
    import shutil
    import subprocess

    assert shutil.which("yt-dlp") == str(no_real_ytdlp)
    r = subprocess.run([shutil.which("yt-dlp"), "-j", "x"], capture_output=True, text=True)
    assert r.returncode == 97 and "never runs a real yt-dlp" in r.stderr
    mark = tmp_path / "real-ytdlp-was-called"
    assert mark.read_text().endswith(" -j x\n")
    mark.unlink()  # this test called it on purpose


async def test_a_trailer_without_fake_ytdlp_never_goes_online(api, tmp_path):
    """POST /api/trailers/{id} without FakeYtDlp reaches only the guard: the
    job fails with its error line and nothing leaves the machine."""
    r = await api.post("/api/trailers/dQw4w9WgXcQ")
    assert r.status_code in (200, 202)
    for _ in range(200):
        st = (await api.get("/api/trailers/dQw4w9WgXcQ")).json()
        if st["state"] == "error":
            break
        await asyncio.sleep(0.02)
    assert st["state"] == "error" and "never runs a real yt-dlp" in (st["error"] or ""), st
    mark = tmp_path / "real-ytdlp-was-called"
    assert mark.exists()
    mark.unlink()  # this test called it on purpose


# ---------------------------------------------------------------- the HLS playlist checker (support/hls.py)

_HLS_SEG = re.compile(r"^s\d{3}\.m4s$")
_HLS_OK = ("#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n"
           "#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-INDEPENDENT-SEGMENTS\n"
           '#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.004000,\ns000.m4s\n#EXTINF:3.5,\ns001.m4s\n')


def test_hls_checker_accepts_an_open_and_a_closed_playlist():
    from tests.support.hls import check_playlist

    assert check_playlist(_HLS_OK, complete=False, segment=_HLS_SEG) == [("s000.m4s", 4.004), ("s001.m4s", 3.5)]
    assert len(check_playlist(_HLS_OK + "#EXT-X-ENDLIST\n", complete=True, segment=_HLS_SEG)) == 2


@pytest.mark.parametrize("broken, complete", [
    (_HLS_OK.replace("TARGETDURATION:4", "TARGETDURATION:3"), False),           # a segment rounds above it
    (_HLS_OK.replace("#EXTINF:3.5,", "#EXTINF:4.6,"), False),                   # 4.6 rounds to 5 > 4
    (_HLS_OK.replace("s001.m4s", "s002.m4s"), False),                           # a gap in the numbering
    (_HLS_OK.replace("MEDIA-SEQUENCE:0", "MEDIA-SEQUENCE:1"), False),           # first segment isn't the sequence
    (_HLS_OK.replace("#EXTINF:4.004000,\ns000.m4s\n#EXTINF:3.5,\ns001.m4s\n",
                     "#EXTINF:3.5,\ns001.m4s\n#EXTINF:4.004000,\ns000.m4s\n"), False),  # out of order
    (_HLS_OK + "#EXT-X-ENDLIST\n", False),                                       # closed while growing
    (_HLS_OK, True),                                                            # never closed
    (_HLS_OK.replace("#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n", ""), False),    # start not pinned
    (_HLS_OK.replace("#EXT-X-PLAYLIST-TYPE:EVENT\n", ""), False),
    (_HLS_OK + "s002.m4s\n", False),                                            # a URI without EXTINF
])
def test_hls_checker_rejects(broken, complete):
    from tests.support.hls import check_playlist

    with pytest.raises(AssertionError):
        check_playlist(broken, complete=complete, segment=_HLS_SEG)



# ------------------------------------------------- the library-files rule (conftest's arr_deletes_keep_files)
# Each test that breaks the rule on purpose asserts what the check reports,
# then clears the sim's calls so the real teardown check passes.


def _movie(radarr, tmdb=603, title="The Matrix"):
    """(an ArrClient for Radarr, a library movie with a file)."""
    return ArrClient("movie", RADARR, RADARR_KEY, "HD-1080p"), radarr.add_movie(movie_obj(tmdb, title, has_file=True))


async def test_files_rule_passes_a_delete_that_keeps_files(radarr, arr_deletes_keep_files):
    c, m = _movie(radarr)
    await c.delete_title(m["id"])
    assert radarr.deleted and arr_deletes_keep_files.violations() == []


async def test_files_rule_passes_the_confirmed_route(api, radarr, arr_deletes_keep_files):
    _, m = _movie(radarr)
    r = await api.delete("/api/library/movie/603", params={"delete_files": "true"})  # TEST_TOKEN: an admin
    assert r.status_code == 200 and r.json()["status"] == "deleted", r.text
    assert radarr.files_deleted == [m["id"]]
    assert arr_deletes_keep_files.violations() == []


@pytest.mark.parametrize("how", ["delete_title_and_files", "delete_with_files", "raw", "exclusion"])
async def test_files_rule_fails_a_files_delete_outside_the_route(api, radarr, arr_deletes_keep_files, how):
    c, m = _movie(radarr)
    if how == "delete_title_and_files":  # the method itself, no route
        await c.delete_title_and_files(m["id"])
    elif how == "delete_with_files":  # the undo step, but not called by the route
        await api.app_module.undo.delete_with_files("movie", "603", User(TEST_USER, "kirill", True), None)
    elif how == "raw":  # deleteFiles=true by any other call
        await c._delete(f"/api/v3/movie/{m['id']}", {"deleteFiles": "true", "addImportExclusion": "false"})
    else:  # files kept, but an import-list exclusion
        await c._delete(f"/api/v3/movie/{m['id']}", {"deleteFiles": "false", "addImportExclusion": "true"})
    bad = arr_deletes_keep_files.violations()
    want = "import-list exclusion" if how == "exclusion" else "outside the confirmed delete route"
    assert len(bad) == 1 and want in bad[0], bad
    radarr.calls.clear()


@pytest.mark.deletes_files_directly
async def test_files_rule_marker_allows_only_the_method(radarr, arr_deletes_keep_files):
    c, m = _movie(radarr)
    await c.delete_title_and_files(m["id"])
    assert arr_deletes_keep_files.violations() == []
    _, other = _movie(radarr, 604, "The Matrix Reloaded")
    await c._delete(f"/api/v3/movie/{other['id']}", {"deleteFiles": "true", "addImportExclusion": "false"})
    bad = arr_deletes_keep_files.violations()
    assert len(bad) == 1 and f"/movie/{other['id']}" in bad[0], bad
    radarr.calls.clear()
