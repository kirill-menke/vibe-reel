"""streaming._body while it waits at the download frontier: the file moved or
gone by the time its first window is in (it is opened lazily), the client
hanging up mid-wait, and the give-up measured in time rather than in loop
turns (a slow pieceStates answer stretches every turn).

The body runs on a FakeClock: auto (instant) unless a test steps it."""

from __future__ import annotations

import asyncio
import logging

import pytest

from reel_api import qbittorrent, streaming
from tests.conftest import TEST_AUTH
from tests.support.clock import FakeClock
from tests.support.growing import GrowingFile
from tests.support.qbit import QBIT, make_hash
from tests.test_streaming_edges import blob_of

CHUNK = streaming.CHUNK
PIECE = 64 * 1024
SIZE = 3 * CHUNK + 999


def qb_client():
    return qbittorrent.QBittorrentClient(QBIT, None, None)


def msgs(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.name == "reel_api"]


@pytest.fixture
def waiting(qbit, tmp_path):
    """A single-file torrent with nothing downloaded yet: the body's first
    window waits at the frontier before the file is ever opened."""
    data = blob_of(SIZE, 5)
    g = GrowingFile(tmp_path / "incomplete" / "Movie.mkv", data, piece_size=PIECE)
    h = make_hash("frontier")
    t = qbit.add_growing(h, g)
    return h, g, t, data


async def start(qb, h):
    info = await streaming._main_file(qb, h)
    streaming._stream_gen[h] = 1
    return info


def on_first_sleep(clock, monkeypatch, action):
    """Run `action` the first time the body sleeps (i.e. while it waits)."""
    real_sleep = clock.sleep
    done = []

    async def sleep(s, result=None):
        if not done:
            done.append(1)
            action()
        return await real_sleep(s, result)

    clock.sleep = sleep
    clock.install(monkeypatch, streaming)


# ---------------------------------------------------------------- (a) moved / gone before the lazy open


async def test_file_moved_during_the_frontier_wait_is_found_where_qbittorrent_says(
        monkeypatch, clock, qbit, waiting, tmp_path):
    """The download finishes while the body waits and qBittorrent moves it
    incomplete/ -> complete/ before the body ever opened it: the old path is
    gone, so the body asks qBittorrent where the file is now — the same
    _main_file lookup a new stream makes — and serves every byte from there."""
    h, g, t, data = waiting
    qb = qb_client()
    info = await start(qb, h)
    moved = tmp_path / "complete" / "Movie.mkv"

    def finish_and_move():
        g.grow_to(SIZE)
        g.move(moved)
        t.content_path = str(moved)

    on_first_sleep(clock, monkeypatch, finish_and_move)
    got = b"".join([c async for c in streaming._body(qb, h, info, 0, SIZE - 1, 1)])
    assert got == data


@pytest.mark.parametrize("how", ["deleted", "unknown_now", "qbittorrent_down", "other_size", "moved_and_gone"])
async def test_file_gone_during_the_frontier_wait_ends_the_body_cleanly(
        monkeypatch, clock, qbit, waiting, caplog, how):
    """If the file can't be found again (deleted with the torrent, or the
    lookup fails / names a different file), the body ends like a stall —
    the player sees the stream break off — instead of raising
    FileNotFoundError out of a response whose headers are already sent."""
    h, g, t, data = waiting
    qb = qb_client()
    info = await start(qb, h)

    def vanish():
        g.grow_to(SIZE)
        g.path.unlink()
        if how == "unknown_now":  # qBittorrent no longer knows the hash
            async def gone(qb, gid):
                return None
            monkeypatch.setattr(streaming, "_main_file", gone)
        elif how == "qbittorrent_down":
            qbit.fail("/torrents/info", status=500)
        elif how == "moved_and_gone":  # qBittorrent names a new place, nothing is there either
            t.content_path = str(g.path.parent.parent / "complete" / "Movie.mkv")
        elif how == "other_size":
            t.files[0].size = SIZE + 1  # not the file this body's offsets were computed for

    on_first_sleep(clock, monkeypatch, vanish)
    with caplog.at_level(logging.WARNING, logger="reel_api"):
        got = [c async for c in streaming._body(qb, h, info, 0, SIZE - 1, 1)]
    assert got == []
    assert msgs(caplog) == [f"stream {h}: file gone from {info['path']}, giving up"]


# ---------------------------------------------------------------- (b) client hangs up mid-wait


class _Asgi:
    """One raw ASGI GET against the app, the way uvicorn drives it: the
    request, then `http.disconnect` once the test hangs up."""

    def __init__(self, app, path: str, spec_version: str = "2.3"):
        self.app = app
        self.scope = {
            "type": "http", "asgi": {"version": "3.0", "spec_version": spec_version},
            "http_version": "1.1", "method": "GET", "scheme": "http",
            "path": path, "raw_path": path.encode(), "query_string": b"", "root_path": "",
            # signed like every client request (the request guard, security.py)
            "headers": [(b"host", b"reel.test"), (b"range", b"bytes=0-"),
                        (b"authorization", TEST_AUTH.encode())],
            "client": ("127.0.0.1", 50000), "server": ("reel.test", 80),
        }
        self.hung_up = asyncio.Event()
        self.sent: list[dict] = []
        self._requested = False

    async def receive(self):
        if not self._requested:
            self._requested = True
            return {"type": "http.request", "body": b"", "more_body": False}
        await self.hung_up.wait()
        return {"type": "http.disconnect"}

    async def send(self, message):
        self.sent.append(message)

    async def __call__(self):
        await self.app(self.scope, self.receive, self.send)


async def until_waiting(clock, real_s: float = 5.0):
    """Until the body sleeps at the frontier (real time: its reads are threads)."""
    for _ in range(int(real_s / 0.005)):
        if clock.pending_sleepers:
            return
        await asyncio.sleep(0.005)
    raise AssertionError("the body never reached its frontier wait")


@pytest.mark.parametrize("served", [0, 1], ids=["at_first_byte", "after_a_window"])
async def test_disconnect_during_the_frontier_wait_stops_the_body(monkeypatch, api, qbit, waiting, served):
    """The TV leaves the player while the body waits for pieces: the wait ends
    at once — no more pieceStates polls for a socket nobody reads, no sleeper
    left behind, the file closed, the request task finished — rather than
    polling on for PIECE_WAIT_MAX. Not a bug: uvicorn speaks ASGI 2.3, where
    Starlette's StreamingResponse listens for `http.disconnect` next to the
    body and cancels it (pinned here). An ASGI 2.4 server would get no such
    listener and the wait would run its ~2 min (nothing is sent meanwhile)."""
    h, g, t, data = waiting
    g.grow_to(served * CHUNK)
    opened = []

    def spy_open(*a, **k):
        f = open(*a, **k)
        opened.append(f)
        return f

    monkeypatch.setattr(streaming, "open", spy_open, raising=False)
    clock = FakeClock(auto=False).install(monkeypatch, streaming)
    app = api._transport.app
    call = _Asgi(app, f"/api/downloads/{h}/stream", "2.3")
    task = asyncio.create_task(call())
    try:
        await until_waiting(clock)
        assert call.sent and call.sent[0]["type"] == "http.response.start"
        assert call.sent[0]["status"] == 206
        for _ in range(5):  # a turn at a time: each read runs in a real worker thread
            await clock.advance(streaming.PIECE_POLL, settle=50)
            await until_waiting(clock)
        polls = len(qbit.called("/torrents/pieceStates"))
        assert polls >= 3  # it is waiting at the frontier
        assert len(opened) == served and not any(f.closed for f in opened)

        call.hung_up.set()
        await asyncio.wait_for(task, timeout=5)
        after = len(qbit.called("/torrents/pieceStates"))
        assert after == polls
        await clock.advance(30, settle=50)
        assert len(qbit.called("/torrents/pieceStates")) == after
        assert clock.pending_sleepers == 0
        assert all(f.closed for f in opened)
    finally:
        if not task.done():
            task.cancel()
    bodies = [m["body"] for m in call.sent if m["type"] == "http.response.body" and m.get("body")]
    assert b"".join(bodies) == data[: served * CHUNK]


# ---------------------------------------------------------------- (c) the give-up is wall time


class SlowStatesQb:
    """pieceStates that takes `delays[i]` seconds (virtual) to answer, in
    turn: a busy qBittorrent stretches every frontier turn unevenly."""

    def __init__(self, clock, gid, info, delays):
        self.clock, self.gid, self.info = clock, gid, info
        self.delays = list(delays)
        self.n = 0

    async def piece_states(self, gid):
        d = self.delays[self.n % len(self.delays)]
        self.n += 1
        self.clock.t += d
        return [0] * (self.info["size"] // self.info["piece_size"] + 1)


@pytest.mark.parametrize("delays", [[5.0], [0.0, 9.0, 0.5], [30.0]], ids=["5s", "uneven", "30s"])
async def test_frontier_give_up_is_measured_in_time_not_loop_turns(clock, monkeypatch, tmp_path, caplog, delays):
    """README: the server closes the stream "only after ~2 min of no
    progress". The stall used to add PIECE_POLL per loop turn, so with
    pieceStates taking 5 s a turn it held the TV's player for 6x that (12
    min). Now it gives up within PIECE_WAIT_MAX + one turn of the clock."""
    clock.install(monkeypatch, streaming)
    path = tmp_path / "Movie.mkv"
    path.write_bytes(b"\0" * 1000)
    info = {"path": str(path), "size": 1000, "offset": 0, "piece_size": 100, "state": "downloading"}
    qb = SlowStatesQb(clock, "g", info, delays)
    streaming._stream_gen["g"] = 1
    t0 = clock.t
    with caplog.at_level(logging.WARNING, logger="reel_api"):
        got = [c async for c in streaming._body(qb, "g", info, 0, 999, 1)]
    assert got == []
    elapsed = clock.t - t0
    assert streaming.PIECE_WAIT_MAX <= elapsed <= streaming.PIECE_WAIT_MAX + max(delays) + streaming.PIECE_POLL
    assert msgs(caplog) == ["stream g: stalled at byte 0, giving up"]


async def test_short_read_give_up_is_measured_in_time_too(clock, monkeypatch, tmp_path):
    """The same for a file that ends before its done pieces: a slow disk read
    (here 7 s a turn) doesn't stretch the ~2 min budget."""
    path = tmp_path / "Movie.mkv"
    path.write_bytes(b"x" * 100)
    info = {"path": str(path), "size": 1000, "offset": 0, "piece_size": 100, "state": "downloading"}

    class Done:
        async def piece_states(self, gid):
            return [2] * 10

    real_read = streaming._read_at

    def slow_read(f, pos, n):
        clock.t += 7.0
        return real_read(f, pos, n)

    monkeypatch.setattr(streaming, "_read_at", slow_read)
    clock.install(monkeypatch, streaming)
    streaming._stream_gen["s"] = 1
    t0 = clock.t
    got = b"".join([c async for c in streaming._body(Done(), "s", info, 0, 999, 1)])
    assert got == b"x" * 100
    elapsed = clock.t - t0
    # the one good read, then the budget, then at most one more turn (a read + a poll)
    assert streaming.PIECE_WAIT_MAX <= elapsed <= 7.0 + streaming.PIECE_WAIT_MAX + 7.0 + streaming.PIECE_POLL
