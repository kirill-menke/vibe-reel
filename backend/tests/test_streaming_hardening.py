"""streaming.py details the earlier tests reached only loosely — found by the
hardening mutation pass (tests/run_mutmut.sh streaming): a one-byte Range,
a nested file inside a multi-file torrent, the exact window/header piece
boundaries (a byte of a piece that is not downloaded yet is never served or
probed), the 1 s throttle on qBittorrent's pieceStates, the exact give-up
point at the frontier, the ffprobe command line as run from PATH (stderr
captured into the log line), and the operator-facing log lines.

streaming.py runs on a FakeClock here (autouse), so waits end instantly."""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path

import pytest

from reel_api import streaming
from tests.support.growing import GrowingFile
from tests.support.qbit import SimFile, SimTorrent, make_hash
from tests.test_streaming_edges import PROBE_JSON, blob_of, ffprobe_stub, qb_client, single  # noqa: F401


@pytest.fixture(autouse=True)
def fast_clock(monkeypatch, clock):
    clock.install(monkeypatch, streaming)
    return clock


def msgs(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.name == "reel_api"]


class FakeQb:
    """Just the qBittorrent calls streaming.py makes. `states` is a list of
    pieceStates answers handed out in order (the last one repeats); `calls`
    records the FakeClock time of every pieceStates call."""

    def __init__(self, clock, path: str, size: int, piece_size: int, states: list[list[int]]):
        self.clock, self.path, self.size, self.piece_size = clock, path, size, piece_size
        self.states = list(states)
        self.calls: list[float] = []

    async def raw_info(self, gid):
        return {"content_path": self.path, "state": "downloading"}

    async def files(self, gid):
        return [{"index": 0, "name": os.path.basename(self.path), "size": self.size}]

    async def properties(self, gid):
        return {"piece_size": self.piece_size}

    async def piece_states(self, gid):
        self.calls.append(self.clock.t)
        return self.states.pop(0) if len(self.states) > 1 else self.states[0]


def write(tmp_path: Path, data: bytes, name: str = "Movie.mkv") -> str:
    p = tmp_path / name
    p.write_bytes(data)
    return str(p)


async def body(qb, gid, start, end):
    info = await streaming._main_file(qb, gid)
    streaming._stream_gen[gid] = 1
    return b"".join([c async for c in streaming._body(qb, gid, info, start, end, 1)])


# ---------------------------------------------------------------- Range edges


async def test_a_one_byte_range_is_served(api, qbit, tmp_path):
    data = blob_of(1000, 11)
    h, _, _ = single(qbit, tmp_path, "One.mkv", data)
    r = await api.get(f"/api/downloads/{h}/stream", headers={"Range": "bytes=5-5"})
    assert r.status_code == 206
    assert r.headers["content-range"] == "bytes 5-5/1000"
    assert r.headers["content-length"] == "1"
    assert r.content == data[5:6]
    # the last byte alone, too
    r = await api.get(f"/api/downloads/{h}/stream", headers={"Range": "bytes=999-999"})
    assert r.status_code == 206 and r.content == data[999:]


@pytest.mark.parametrize("header", ["bytes=-1-5", "bytes=-3-"])
async def test_a_negative_start_is_malformed_not_a_seek(api, qbit, tmp_path, header):
    """Only the first '-' splits start from end: '-1-5' is a malformed suffix
    (full 200 body), never start=-1."""
    data = blob_of(1000, 12)
    h, _, _ = single(qbit, tmp_path, "Neg.mkv", data)
    r = await api.get(f"/api/downloads/{h}/stream", headers={"Range": header})
    assert r.status_code == 200 and r.content == data
    assert streaming._parse_range(header, 1000) == (0, 999, False)


# ---------------------------------------------------------------- multi-file: nested folders


async def test_main_file_in_a_subfolder_of_the_torrent(api, qbit, tmp_path):
    """content_path is the torrent's root folder; the file name embeds that
    root and any folders below it — only the root is replaced."""
    data = blob_of(5000, 13)
    root = tmp_path / "dl" / "Show.S01"
    g = GrowingFile(root / "Season 1" / "Extras" / "Show.S01E01.mkv", data, piece_size=1024,
                    offset=100, torrent_size=5100)
    g.complete()
    h = make_hash("nested")
    qbit.add_torrent(SimTorrent(hash=h, name="Show.S01", save_path=str(tmp_path / "dl"), piece_size=1024,
                                files=[SimFile("Show.S01/info.nfo", 100),
                                       SimFile("Show.S01/Season 1/Extras/Show.S01E01.mkv", 5000, g)]))
    info = await streaming._main_file(qb_client(), h)
    assert info["path"] == os.path.join(str(root), "Season 1/Extras/Show.S01E01.mkv")
    r = await api.get(f"/api/downloads/{h}/stream", headers={"Range": "bytes=0-99"})
    assert r.status_code == 206 and r.content == data[:100]


# ---------------------------------------------------------------- body: piece boundaries, polling


async def test_a_window_ending_on_the_first_byte_of_a_missing_piece_waits(monkeypatch, fast_clock, tmp_path):
    """CHUNK 4, pieces of 3: the first window is bytes 0-3, and byte 3 is
    piece 1 — not downloaded, so nothing may be served."""
    monkeypatch.setattr(streaming, "CHUNK", 4)
    data = b"abcdefghi"
    qb = FakeQb(fast_clock, write(tmp_path, data), 9, 3, [[2, 0, 0]])
    assert await body(qb, "h1", 0, 8) == b""
    # once piece 1 is in, the window goes out (and no further: piece 2 is missing)
    qb.states = [[2, 2, 0]]
    assert await body(qb, "h1", 0, 8) == b"abcd"


async def test_piece_states_are_polled_at_most_once_a_second(monkeypatch, fast_clock, tmp_path):
    """A served window is followed by the next one at once, on the states
    already fetched; only after a 1 s wait are they fetched again."""
    monkeypatch.setattr(streaming, "CHUNK", 4)
    data = b"01234567"
    qb = FakeQb(fast_clock, write(tmp_path, data), 8, 4, [[2, 0], [2, 2]])
    t0 = fast_clock.t
    assert await body(qb, "h2", 0, 7) == data
    assert qb.calls == [t0, t0 + streaming.PIECE_POLL]
    assert fast_clock.sleeps == [streaming.PIECE_POLL]


async def test_a_stall_from_the_first_byte_gives_up_after_exactly_piece_wait_max(fast_clock, tmp_path, caplog):
    data = b"x" * 100
    qb = FakeQb(fast_clock, write(tmp_path, data), 100, 50, [[0, 0]])
    assert await body(qb, "deadbeef", 0, 99) == b""
    # PIECE_WAIT_MAX polls of PIECE_POLL each, then the next miss ends the body
    n = int(streaming.PIECE_WAIT_MAX / streaming.PIECE_POLL)
    assert fast_clock.sleeps == [streaming.PIECE_POLL] * n
    assert msgs(caplog) == ["stream deadbeef: stalled at byte 0, giving up"]


async def test_give_up_log_names_the_byte_it_stalled_at(monkeypatch, fast_clock, tmp_path, caplog):
    monkeypatch.setattr(streaming, "CHUNK", 10)
    qb = FakeQb(fast_clock, write(tmp_path, b"y" * 40), 40, 10, [[2, 2, 0, 0]])
    assert await body(qb, "cafe", 0, 39) == b"y" * 20
    assert msgs(caplog) == ["stream cafe: stalled at byte 20, giving up"]


# ---------------------------------------------------------------- force-start log lines


async def test_force_start_log_lines(api, qbit, tmp_path, caplog):
    import httpx

    caplog.set_level(logging.INFO, logger="reel_api")
    data = blob_of(1000, 14)
    h, _, t = single(qbit, tmp_path, "Parked.mkv", data)
    t.state = "pausedDL"
    r = await api.get(f"/api/downloads/{h}/stream", headers={"Range": "bytes=0-9"})
    assert r.status_code == 206
    assert f"stream {h}: force-started parked torrent" in msgs(caplog)
    caplog.clear()
    t.state = "queuedDL"  # parked again (the sim's force-start had moved it on)
    qbit.fail("/torrents/setForceStart", exc=httpx.ConnectError("qbit down"))
    r = await api.get(f"/api/downloads/{h}/stream", headers={"Range": "bytes=0-9"})
    assert r.status_code == 206
    (m,) = [m for m in msgs(caplog) if "force-start" in m]
    prefix = f"stream {h}: force-start failed: "
    assert m.startswith(prefix) and "qbit down" in m[len(prefix):]


# ---------------------------------------------------------------- probe: header window, real exec


async def test_probe_header_window_ends_on_the_first_byte_of_a_piece(ffprobe_stub, fast_clock, tmp_path):  # noqa: F811
    """A 1025-byte file in 1024-byte pieces: its header window (the whole
    file) ends on byte 1024, which is piece 1."""
    qb = FakeQb(fast_clock, write(tmp_path, b"z" * 1025), 1025, 1024, [[2, 0]])
    r = await streaming.probe_endpoint(qb, "hdr1")
    assert r.status_code == 409
    assert json.loads(r.body) == {"error": "not_ready", "detail": "file header not downloaded yet"}
    assert ffprobe_stub.calls == []
    qb.states = [[2, 2]]
    assert (await streaming.probe_endpoint(qb, "hdr1"))["container"] == "matroska"


@pytest.fixture
def path_ffprobe(tmp_path, monkeypatch):
    """A stand-in `ffprobe` executable first on PATH. It records its argv,
    prints FAKE_PROBE_OUT on stdout and FAKE_PROBE_ERR on stderr."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    log = tmp_path / "ffprobe-argv.json"
    exe = bindir / "ffprobe"
    exe.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys\n"
        f"open({str(log)!r}, 'w').write(json.dumps(sys.argv[1:]))\n"
        "sys.stdout.write(os.environ.get('FAKE_PROBE_OUT', ''))\n"
        "sys.stderr.write(os.environ.get('FAKE_PROBE_ERR', ''))\n"
    )
    exe.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bindir}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setenv("FAKE_PROBE_OUT", json.dumps(PROBE_JSON))
    monkeypatch.setenv("FAKE_PROBE_ERR", "")

    class P:
        def argv(self):
            return json.loads(log.read_text())

    return P()


async def test_probe_runs_ffprobe_from_path_with_the_exact_arguments(api, qbit, tmp_path, path_ffprobe):
    data = blob_of(5000, 15)
    h, g, _ = single(qbit, tmp_path, "Probe.mkv", data)
    r = await api.get(f"/api/downloads/{h}/probe")
    assert r.status_code == 200, r.text
    assert r.json()["video"]["codec"] == "hevc"
    assert path_ffprobe.argv() == ["-v", "error", "-print_format", "json", "-show_format", "-show_streams",
                                   str(g.path)]


async def test_no_streams_log_line_carries_ffprobes_stderr(api, qbit, tmp_path, path_ffprobe, monkeypatch,
                                                           caplog):
    data = blob_of(5000, 16)
    h, _, _ = single(qbit, tmp_path, "Broken.mkv", data)
    err = "E" * 100 + "F" * 100  # longer than the 120 bytes the log keeps
    monkeypatch.setenv("FAKE_PROBE_OUT", "{}")
    monkeypatch.setenv("FAKE_PROBE_ERR", err)
    r = await api.get(f"/api/downloads/{h}/probe")
    assert r.status_code == 409 and r.json()["detail"] == "file not probeable yet"
    assert msgs(caplog) == [f"probe {h}: no streams found ({err.encode()[:120]!r})"]
    caplog.clear()
    monkeypatch.setenv("FAKE_PROBE_ERR", "")
    r = await api.get(f"/api/downloads/{h}/probe")
    assert r.status_code == 409
    assert msgs(caplog) == [f"probe {h}: no streams found (b'')"]


async def test_probe_without_ffprobe_on_path_logs_it(api, qbit, tmp_path, monkeypatch, caplog):
    empty = tmp_path / "empty-bin"
    empty.mkdir()
    monkeypatch.setenv("PATH", str(empty))
    h, _, _ = single(qbit, tmp_path, "NoProbe.mkv", blob_of(5000, 17))
    r = await api.get(f"/api/downloads/{h}/probe")
    assert r.status_code == 503
    assert msgs(caplog) == ["probe: ffprobe not on PATH"]


# ---------------------------------------------------------------- shaping


def test_subtitle_default_flag():
    data = {"streams": [
        {"index": 0, "codec_type": "subtitle", "codec_name": "subrip", "disposition": {"default": 1}},
        {"index": 1, "codec_type": "subtitle", "codec_name": "subrip", "disposition": {"default": 0}},
        {"index": 2, "codec_type": "subtitle", "codec_name": "ass"},
    ]}
    subs = streaming._shape_probe(data, 1)["subtitles"]
    assert [s["default"] for s in subs] == [True, False, False]
