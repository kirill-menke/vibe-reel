"""streaming.py edge cases: multi-file torrents (offset math, root-folder join,
main-file choice), Range parsing, not-ready states, the short read around the
incomplete/ -> complete/ move, piece-state failures, content types, and the
probe endpoint with a stubbed ffprobe (cache, missing binary, timeout,
unprobeable output) plus the pure shaping helpers.

Every test here runs streaming.py on a FakeClock (autouse `fast_clock`), so a
body that waits at the frontier ends instantly instead of after 120 real s.
"""

from __future__ import annotations

import asyncio
import json
import os
import random

import httpx
import pytest

from reel_api import qbittorrent, streaming
from tests.support.clock import _Proxy
from tests.support.growing import GrowingFile
from tests.support.qbit import QBIT, SimFile, SimTorrent, make_hash

CHUNK = streaming.CHUNK
PIECE = 64 * 1024


@pytest.fixture(autouse=True)
def fast_clock(monkeypatch, clock):
    clock.install(monkeypatch, streaming)
    return clock


def qb_client():
    return qbittorrent.QBittorrentClient(QBIT, None, None)


def blob_of(n: int, seed: int = 7) -> bytes:
    return random.Random(seed).randbytes(n)


def single(qbit, tmp_path, name: str, data: bytes, *, complete: bool = True, seed: str | None = None):
    g = GrowingFile(tmp_path / "dl" / name, data, piece_size=PIECE)
    if complete:
        g.complete()
    h = make_hash(seed or name)
    t = qbit.add_growing(h, g)
    return h, g, t


# ---------------------------------------------------------------- multi-file torrents

NFO = 1_234
SAMPLE = 300_000  # a smaller video before the main one
OFFSET = NFO + SAMPLE  # deliberately not piece-aligned
ZIP = 10 * CHUNK  # a non-video file bigger than the main video
MAIN = 3 * CHUNK + 777


@pytest.fixture
def pack(qbit, tmp_path):
    """Multi-file torrent 'Pack': nfo, Sample/sample.mp4, Movie.mkv (the main
    file, index 2, growing at a non-zero piece offset), extras.zip (bigger,
    not a video). qBittorrent's content_path is the root folder."""
    data = blob_of(MAIN, 99)
    total = OFFSET + MAIN + ZIP
    g = GrowingFile(tmp_path / "dl" / "Pack" / "Movie.mkv", data, piece_size=PIECE,
                    offset=OFFSET, torrent_size=total)
    h = make_hash("pack")
    t = SimTorrent(hash=h, name="Pack", save_path=str(tmp_path / "dl"), piece_size=PIECE, files=[
        SimFile("Pack/Pack.nfo", NFO),
        SimFile("Pack/Sample/sample.mp4", SAMPLE),
        SimFile("Pack/Movie.mkv", MAIN, g),
        SimFile("Pack/extras.zip", ZIP),
    ])
    qbit.add_torrent(t)
    return h, g, t, data


async def test_multi_file_main_file_offset_and_path(qbit, pack, tmp_path):
    h, g, t, _ = pack
    info = await streaming._main_file(qb_client(), h)
    assert info == {
        "path": os.path.join(str(tmp_path / "dl" / "Pack"), "Movie.mkv"),
        "size": MAIN,
        "offset": OFFSET,  # every file laid out before it, video or not
        "piece_size": PIECE,
        "state": "downloading",
    }


async def test_multi_file_largest_video_wins_regardless_of_order(qbit, pack):
    h, g, t, _ = pack
    # a second, smaller video after the main one, and the main file renamed upper-case
    t.files.append(SimFile("Pack/Bonus/featurette.mp4", CHUNK))
    t.files[2].name = "Pack/MOVIE.MKV"
    info = await streaming._main_file(qb_client(), h)
    assert info["size"] == MAIN and info["path"].endswith("/Pack/MOVIE.MKV")


async def test_multi_file_without_any_video_is_not_ready(api, qbit, pack):
    h, _, t, _ = pack
    t.files = [SimFile("Pack/Pack.nfo", NFO), SimFile("Pack/extras.zip", ZIP)]
    r = await api.get(f"/api/downloads/{h}/stream")
    assert r.status_code == 409
    assert r.json() == {"error": "not_ready", "detail": "torrent metadata not resolved yet"}


async def test_multi_file_range_serves_the_main_files_bytes(api, qbit, pack):
    h, g, _, data = pack
    g.complete()
    r = await api.get(f"/api/downloads/{h}/stream", headers={"Range": f"bytes={CHUNK - 10}-{CHUNK + 9}"})
    assert r.status_code == 206
    assert r.headers["content-range"] == f"bytes {CHUNK - 10}-{CHUNK + 9}/{MAIN}"
    assert r.content == data[CHUNK - 10:CHUNK + 10]


async def test_multi_file_piece_math_uses_the_file_offset(qbit, pack):
    """Grown to just short of the second window's last piece *in torrent
    coordinates*: with the offset, window 2 is not ready and only window 1 is
    served. A reader ignoring the offset would see window 2's (file-relative)
    pieces as done and serve the zeros of the not-yet-written tail."""
    h, g, _, data = pack
    g.grow_to(2 * CHUNK - 100_000)
    qb = qb_client()
    info = await streaming._main_file(qb, h)
    streaming._stream_gen[h] = 1
    got = b"".join([c async for c in streaming._body(qb, h, info, 0, MAIN - 1, 1)])
    assert got == data[:CHUNK]


async def test_single_file_content_path_is_the_file_itself(qbit, tmp_path):
    data = blob_of(5000)
    h, g, t = single(qbit, tmp_path, "Movie.mkv", data)
    elsewhere = tmp_path / "complete" / "Movie.mkv"
    g.move(elsewhere)
    t.content_path = str(elsewhere)  # qBittorrent reports where the file is now
    info = await streaming._main_file(qb_client(), h)
    assert info["path"] == str(elsewhere) and info["offset"] == 0


# ---------------------------------------------------------------- Range parsing

SMALL = 200_000


@pytest.fixture
def small(qbit, tmp_path):
    data = blob_of(SMALL, 3)
    h, _, _ = single(qbit, tmp_path, "Small.mkv", data)
    return h, data


@pytest.mark.parametrize("header,start,end", [
    ("bytes=-500", SMALL - 500, SMALL - 1),            # suffix: the last N bytes
    (f"bytes=-{SMALL * 2}", 0, SMALL - 1),             # suffix longer than the file
    ("bytes=150000-", 150_000, SMALL - 1),             # open-ended
    ("bytes=10-19,30-39", 10, 19),                     # multi-range: first range only
    (f"bytes=100-{SMALL * 5}", 100, SMALL - 1),        # end clipped to the file
    ("bytes= 5-9 ", 5, 9),                             # whitespace tolerated
])
async def test_partial_ranges(api, small, header, start, end):
    h, data = small
    r = await api.get(f"/api/downloads/{h}/stream", headers={"Range": header})
    assert r.status_code == 206
    assert r.headers["content-range"] == f"bytes {start}-{end}/{SMALL}"
    assert r.headers["content-length"] == str(end - start + 1)
    assert r.content == data[start:end + 1]


@pytest.mark.parametrize("header", [None, "bytes=abc-def", "bytes=5-x", "items=0-5", "bytes=-x", ""])
async def test_missing_or_malformed_range_is_200_full_body(api, small, header):
    h, data = small
    headers = {"Range": header} if header is not None else {}
    r = await api.get(f"/api/downloads/{h}/stream", headers=headers)
    assert r.status_code == 200
    assert "content-range" not in r.headers
    assert r.headers["content-length"] == str(SMALL)
    assert r.content == data


@pytest.mark.parametrize("header", ["bytes=-0", "bytes=500-100", f"bytes={SMALL + 1}-"])
async def test_unsatisfiable_ranges_are_416(api, small, header):
    h, _ = small
    r = await api.get(f"/api/downloads/{h}/stream", headers={"Range": header})
    assert r.status_code == 416
    assert r.headers["content-range"] == f"bytes */{SMALL}"


@pytest.mark.parametrize("header,expected", [
    (None, (0, 99, False)),
    ("bytes=0-0", (0, 0, True)),
    ("bytes=-1", (99, 99, True)),
    ("bytes=-100", (0, 99, True)),
    ("bytes=-101", (0, 99, True)),
    ("bytes=99-", (99, 99, True)),
    ("bytes=0-1000", (0, 99, True)),
    ("bytes=x-1", (0, 99, False)),
    ("Bytes=0-1", (0, 99, False)),  # the unit is case-sensitive as written
])
def test_parse_range_table(header, expected):
    assert streaming._parse_range(header, 100) == expected


# ---------------------------------------------------------------- not ready


@pytest.mark.parametrize("props", ['{"piece_size": 0}', '{"piece_size": null}', "{}"])
async def test_piece_size_zero_is_409(api, qbit, small, props):
    h, _ = small
    qbit.fail("/torrents/properties", status=200, body=props)
    r = await api.get(f"/api/downloads/{h}/stream")
    assert r.status_code == 409
    assert r.json() == {"error": "not_ready", "detail": "torrent metadata not resolved yet"}
    assert r.headers["retry-after"] == "10"


async def test_empty_content_path_is_409(api, qbit, small):
    h, _ = small
    qbit.torrents[h].content_path = ""
    r = await api.get(f"/api/downloads/{h}/stream")
    assert r.status_code == 409
    assert r.json() == {"error": "not_ready", "detail": "download has not started yet"}
    r = await api.get(f"/api/downloads/{h}/probe")
    assert r.status_code == 409 and r.json()["detail"] == "download has not started yet"


async def test_head_on_not_ready_is_409_too(api, qbit, small):
    h, _ = small
    qbit.fail("/torrents/properties", status=200, body='{"piece_size": 0}')
    r = await api.head(f"/api/downloads/{h}/stream")
    assert r.status_code == 409


# ---------------------------------------------------------------- body: move, short reads, failures


async def test_short_read_after_the_move_is_retried_not_truncated(monkeypatch, fast_clock, qbit, tmp_path):
    """The file on disk is shorter than its pieces claim (only the first
    window written; pieceStates all done). While the reader waits, qBittorrent
    moves it incomplete/ -> complete/ and the rest lands: the open fd follows
    the rename and the body delivers every byte."""
    size = 2 * CHUNK + 4321
    data = blob_of(size, 11)
    path = tmp_path / "incomplete" / "Movie.mkv"
    path.parent.mkdir(parents=True)
    path.write_bytes(data[:CHUNK])
    g = GrowingFile.__new__(GrowingFile)  # bookkeeping only; the bytes are written by hand
    g.path, g.size = path, size
    h = make_hash("moved")
    qbit.add_torrent(SimTorrent(hash=h, name="Movie.mkv", piece_size=PIECE, content_path=str(path),
                                files=[SimFile("Movie.mkv", size)], pieces=[2] * (-(-size // PIECE))))
    qb = qb_client()
    info = await streaming._main_file(qb, h)
    streaming._stream_gen[h] = 1

    moved = tmp_path / "complete" / "Movie.mkv"
    real_sleep = fast_clock.sleep
    retries = []

    async def sleep_then_finish(s, result=None):
        retries.append(s)
        if not moved.exists():
            g.move(moved)
            with open(moved, "ab") as f:
                f.write(data[CHUNK:])
        return await real_sleep(s, result)

    fast_clock.sleep = sleep_then_finish
    fast_clock.install(monkeypatch, streaming)  # the proxy binds sleep at install time
    got = b"".join([c async for c in streaming._body(qb, h, info, 0, size - 1, 1)])
    assert got == data
    assert retries == [streaming.PIECE_POLL]  # exactly one short read, one retry


async def test_short_read_that_never_recovers_gives_up_after_piece_wait_max(monkeypatch, fast_clock, qbit,
                                                                              tmp_path):
    """A file shorter than its done pieces claim (and that never grows) ends
    the body after ~PIECE_WAIT_MAX of no progress, like pieces that never
    arrive (README: "closes the stream only after ~2 min of no progress"),
    so the TV gets its "download stream broke off" error. The empty read
    used to be retried every PIECE_POLL forever (F7); the test stops it from
    the outside at 3x PIECE_WAIT_MAX so a regression can't hang."""
    size = 2 * CHUNK
    path = tmp_path / "Movie.mkv"
    path.write_bytes(blob_of(CHUNK))
    h = make_hash("short-forever")
    qbit.add_torrent(SimTorrent(hash=h, name="Movie.mkv", piece_size=PIECE, content_path=str(path),
                                files=[SimFile("Movie.mkv", size)], pieces=[2] * (size // PIECE)))
    qb = qb_client()
    info = await streaming._main_file(qb, h)
    streaming._stream_gen[h] = 1
    real_sleep = fast_clock.sleep
    limit = 3 * int(streaming.PIECE_WAIT_MAX / streaming.PIECE_POLL)

    async def count(s, result=None):
        if len(fast_clock.sleeps) >= limit:
            streaming._stream_gen[h] = 2  # the safety net: stop it from the outside
        return await real_sleep(s, result)

    fast_clock.sleep = count
    fast_clock.install(monkeypatch, streaming)
    got = b"".join([c async for c in streaming._body(qb, h, info, 0, size - 1, 1)])
    assert len(got) == CHUNK
    assert streaming._stream_gen[h] == 1, "the body only ended because the safety net stopped it"
    assert sum(fast_clock.sleeps) <= streaming.PIECE_WAIT_MAX + 2 * streaming.PIECE_POLL


async def test_piece_states_failure_is_tolerated(qbit, small):
    h, data = small
    qbit.fail("/torrents/pieceStates", exc=httpx.ConnectError("boom"))
    qbit.fail("/torrents/pieceStates", status=500, body="oops")
    qb = qb_client()
    info = await streaming._main_file(qb, h)
    streaming._stream_gen[h] = 1
    got = b"".join([c async for c in streaming._body(qb, h, info, 0, SMALL - 1, 1)])
    assert got == data
    assert len(qbit.called("/torrents/pieceStates")) == 3  # two failures, then the answer


async def test_body_superseded_before_reading_never_opens_the_file(monkeypatch, qbit, small):
    h, _ = small
    qb = qb_client()
    info = await streaming._main_file(qb, h)
    opened = []
    real_open = open
    monkeypatch.setattr("builtins.open", lambda *a, **k: opened.append(a) or real_open(*a, **k))
    streaming._stream_gen[h] = 2
    got = [c async for c in streaming._body(qb, h, info, 0, SMALL - 1, 1)]
    assert got == [] and opened == []


async def test_force_start_failure_still_streams(api, qbit, small):
    h, data = small
    qbit.torrents[h].state = "queuedDL"
    qbit.fail("/torrents/setForceStart", exc=httpx.ConnectError("down"))
    r = await api.get(f"/api/downloads/{h}/stream", headers={"Range": "bytes=0-9"})
    assert r.status_code == 206 and r.content == data[:10]
    assert len(qbit.called("/torrents/setForceStart")) == 1


async def test_each_stream_bumps_the_generation(api, qbit, small):
    h, _ = small
    await api.get(f"/api/downloads/{h}/stream", headers={"Range": "bytes=0-9"})
    await api.get(f"/api/downloads/{h}/stream", headers={"Range": "bytes=0-9"})
    assert streaming._stream_gen[h] == 2
    await api.head(f"/api/downloads/{h}/stream")  # HEAD streams nothing: no bump
    assert streaming._stream_gen[h] == 2


# ---------------------------------------------------------------- content types


@pytest.mark.parametrize("name,ctype", [
    ("Movie.mkv", "video/x-matroska"),
    ("Movie.mp4", "video/mp4"),
    ("Movie.m4v", "video/mp4"),
    ("Movie.mov", "video/quicktime"),
    ("Movie.ts", "video/mp2t"),
    ("Movie.webm", "video/webm"),
    ("Movie.avi", "video/x-msvideo"),
    ("MOVIE.MKV", "video/x-matroska"),
])
async def test_content_type_per_extension(api, qbit, tmp_path, name, ctype):
    h, _, _ = single(qbit, tmp_path, name, blob_of(1000))
    r = await api.head(f"/api/downloads/{h}/stream")
    assert r.status_code == 200 and r.headers["content-type"] == ctype


async def test_unknown_extension_on_disk_is_octet_stream(api, qbit, tmp_path):
    """The torrent lists a .mkv but the file on disk carries another suffix
    (qBittorrent's 'append .!qB to incomplete files'): CTYPE is by the path."""
    h, g, t = single(qbit, tmp_path, "Movie.mkv", blob_of(1000))
    t.content_path = str(g.path) + ".!qB"
    os.replace(g.path, t.content_path)
    r = await api.get(f"/api/downloads/{h}/stream", headers={"Range": "bytes=0-9"})
    assert r.status_code == 206
    assert r.headers["content-type"] == "application/octet-stream"


def test_ctype_covers_every_video_extension():
    assert set(streaming.CTYPE) == set(streaming.VIDEO_EXT)


# ---------------------------------------------------------------- probe (stubbed ffprobe)

PROBE_JSON = {
    "format": {"format_name": "matroska,webm", "duration": "5025.5", "bit_rate": "36000000"},
    "streams": [
        {"index": 0, "codec_type": "video", "codec_name": "hevc", "width": 3840, "height": 2160,
         "avg_frame_rate": "24000/1001", "color_transfer": "smpte2084",
         "side_data_list": [{"side_data_type": "DOVI configuration record"}]},
        {"index": 1, "codec_type": "video", "codec_name": "mjpeg"},  # cover art: ignored
        {"index": 2, "codec_type": "audio", "codec_name": "eac3", "channels": 8, "channel_layout": "7.1",
         "profile": "Dolby Digital Plus + Dolby Atmos", "tags": {"language": "eng", "title": "Atmos"},
         "disposition": {"default": 1}},
        {"index": 3, "codec_type": "audio", "codec_name": "truehd", "channels": 8, "profile": "",
         "tags": {"language": "eng"}, "disposition": {"default": 0}},
        {"index": 4, "codec_type": "subtitle", "codec_name": "hdmv_pgs_subtitle",
         "tags": {"language": "eng", "title": "Forced"}, "disposition": {"forced": 1, "default": 0}},
        {"index": 5, "codec_type": "data", "codec_name": "bin_data"},
    ],
}


class FakeProc:
    def __init__(self, out: bytes = b"", err: bytes = b"", hang: bool = False):
        self.out, self.err, self.hang = out, err, hang
        self.killed = False

    async def communicate(self):
        if self.hang:
            await asyncio.Event().wait()
        return self.out, self.err

    def kill(self):
        self.killed = True


@pytest.fixture
def ffprobe_stub(monkeypatch):
    """Replace ffprobe: `stub.which` is what shutil.which answers, `stub.procs`
    the FakeProcs handed out in order (default: PROBE_JSON), `stub.calls` the
    argv of every exec."""

    class Stub:
        which = "/fake/bin/ffprobe"
        procs: list[FakeProc] = []
        calls: list[tuple] = []

    stub = Stub()
    stub.procs, stub.calls = [], []

    async def exec_(*argv, **kw):
        stub.calls.append(argv)
        assert kw["stdout"] == asyncio.subprocess.PIPE
        return stub.procs.pop(0) if stub.procs else FakeProc(json.dumps(PROBE_JSON).encode())

    monkeypatch.setattr(streaming, "asyncio", _Proxy(streaming.asyncio, create_subprocess_exec=exec_))
    monkeypatch.setattr(streaming, "shutil", _Proxy(streaming.shutil, which=lambda name: stub.which))
    return stub


@pytest.fixture
def probed(qbit, tmp_path):
    data = blob_of(6 * CHUNK, 5)
    h, g, t = single(qbit, tmp_path, "Movie.mkv", data, complete=False, seed="probed")
    return h, g


async def test_probe_shapes_ffprobe_output(api, ffprobe_stub, probed):
    h, g = probed
    g.grow_to(streaming.PROBE_MIN_BYTES)
    r = await api.get(f"/api/downloads/{h}/probe")
    assert r.status_code == 200, r.text
    assert r.json() == {
        "container": "matroska", "duration_s": 5025.5, "bitrate": 36_000_000, "size_bytes": 6 * CHUNK,
        "video": {"index": 0, "codec": "hevc", "width": 3840, "height": 2160, "hdr": "DV", "fps": 23.976},
        "audio": [
            {"index": 2, "codec": "eac3", "channels": 8, "layout": "7.1", "lang": "eng", "title": "Atmos",
             "atmos": True, "default": True},
            {"index": 3, "codec": "truehd", "channels": 8, "layout": None, "lang": "eng", "title": None,
             "atmos": False, "default": False},
        ],
        "subtitles": [{"index": 4, "codec": "hdmv_pgs_subtitle", "lang": "eng", "title": "Forced",
                       "forced": True, "default": False}],
    }
    (argv,) = ffprobe_stub.calls
    assert argv[0] == "/fake/bin/ffprobe"
    assert argv[-1] == str(g.path)
    assert {"-show_format", "-show_streams"} <= set(argv)
    assert argv[argv.index("-print_format") + 1] == "json"


async def test_probe_cache_hit_skips_qbittorrent_and_ffprobe(api, qbit, ffprobe_stub, probed):
    h, g = probed
    g.complete()
    first = await api.get(f"/api/downloads/{h}/probe")
    n_calls = len(qbit.calls)
    second = await api.get(f"/api/downloads/{h}/probe")
    assert second.status_code == 200 and second.json() == first.json()
    assert len(ffprobe_stub.calls) == 1
    assert len(qbit.calls) == n_calls


async def test_probe_needs_the_whole_header_window(api, ffprobe_stub, probed):
    h, g = probed
    g.grow_to(streaming.PROBE_MIN_BYTES - PIECE)  # one piece short of 4 MiB
    r = await api.get(f"/api/downloads/{h}/probe")
    assert r.status_code == 409
    assert r.json() == {"error": "not_ready", "detail": "file header not downloaded yet"}
    assert r.headers["retry-after"] == "10"
    assert ffprobe_stub.calls == []


async def test_probe_of_a_file_smaller_than_the_header_window(api, qbit, tmp_path, ffprobe_stub):
    h, g, _ = single(qbit, tmp_path, "Tiny.mkv", blob_of(3 * PIECE), complete=False)
    g.complete_pieces(0, 2)
    r = await api.get(f"/api/downloads/{h}/probe")
    assert r.status_code == 200


async def test_probe_header_math_uses_the_file_offset(api, qbit, pack, ffprobe_stub):
    """Main file at a non-zero offset: the header window is counted from its
    first piece, so the files before it count as done but don't stand in."""
    h, g, t, _ = pack
    t.files[2].size = g.size = 6 * CHUNK  # bigger than the header window
    g.source = blob_of(6 * CHUNK)
    g.grow_to(streaming.PROBE_MIN_BYTES - PIECE)
    assert (await api.get(f"/api/downloads/{h}/probe")).status_code == 409
    g.grow_to(streaming.PROBE_MIN_BYTES)
    assert (await api.get(f"/api/downloads/{h}/probe")).status_code == 200


async def test_probe_piece_states_failure_is_409(api, qbit, ffprobe_stub, probed):
    h, g = probed
    g.complete()
    qbit.fail("/torrents/pieceStates", exc=httpx.ConnectError("x"))
    r = await api.get(f"/api/downloads/{h}/probe")
    assert r.status_code == 409 and r.json()["detail"] == "file header not downloaded yet"


async def test_probe_without_ffprobe_is_503_for_an_hour(api, ffprobe_stub, probed):
    h, g = probed
    g.complete()
    ffprobe_stub.which = None
    r = await api.get(f"/api/downloads/{h}/probe")
    assert r.status_code == 503
    assert r.headers["retry-after"] == "3600"
    assert r.json() == {"error": "temporarily_unavailable", "detail": "probing unavailable"}


async def test_probe_timeout_kills_ffprobe_and_is_409(monkeypatch, api, ffprobe_stub, probed):
    h, g = probed
    g.complete()
    monkeypatch.setattr(streaming, "PROBE_TIMEOUT", 0.05)
    proc = FakeProc(hang=True)
    ffprobe_stub.procs.append(proc)
    r = await api.get(f"/api/downloads/{h}/probe")
    assert r.status_code == 409
    assert r.json() == {"error": "not_ready", "detail": "probe timed out — try again shortly"}
    assert proc.killed
    # not cached: the next attempt probes again
    r = await api.get(f"/api/downloads/{h}/probe")
    assert r.status_code == 200 and len(ffprobe_stub.calls) == 2


@pytest.mark.parametrize("out", [b"", b"not json", b'{"streams": []}',
                                 json.dumps({"streams": [{"codec_type": "subtitle"}]}).encode()])
async def test_unprobeable_output_is_409_and_not_cached(api, ffprobe_stub, probed, out):
    h, g = probed
    g.complete()
    ffprobe_stub.procs.append(FakeProc(out, b"Invalid data found when processing input"))
    r = await api.get(f"/api/downloads/{h}/probe")
    assert r.status_code == 409
    assert r.json() == {"error": "not_ready", "detail": "file not probeable yet"}
    assert h not in streaming._probe_cache
    r = await api.get(f"/api/downloads/{h}/probe")
    assert r.status_code == 200


async def test_audio_only_file_is_probeable(api, ffprobe_stub, probed):
    h, g = probed
    g.complete()
    ffprobe_stub.procs.append(FakeProc(json.dumps(
        {"streams": [{"index": 0, "codec_type": "audio", "codec_name": "flac"}]}).encode()))
    r = await api.get(f"/api/downloads/{h}/probe")
    assert r.status_code == 200
    p = r.json()
    assert p["video"] is None and p["audio"][0]["codec"] == "flac"
    assert p["container"] is None and p["duration_s"] is None and p["bitrate"] is None


async def test_probe_unknown_hash_is_404(api, qbit, ffprobe_stub):
    r = await api.get(f"/api/downloads/{make_hash('nobody')}/probe")
    assert r.status_code == 404 and r.json()["error"] == "not_found"


# ---------------------------------------------------------------- pure helpers


@pytest.mark.parametrize("stream,expected", [
    ({"side_data_list": [{"side_data_type": "DOVI configuration record"}], "color_transfer": "smpte2084"}, "DV"),
    ({"side_data_list": [{"side_data_type": "dovi configuration record"}]}, "DV"),
    ({"side_data_list": [{"side_data_type": "Mastering display metadata"}], "color_transfer": "smpte2084"},
     "HDR10"),
    ({"side_data_list": [{}], "color_transfer": "arib-std-b67"}, "HLG"),
    ({"color_transfer": "bt709"}, None),
    ({"side_data_list": None, "color_transfer": None}, None),
    ({}, None),
])
def test_hdr(stream, expected):
    assert streaming._hdr(stream) == expected


@pytest.mark.parametrize("stream,expected", [
    ({"avg_frame_rate": "24000/1001"}, 23.976),
    ({"avg_frame_rate": "25/1"}, 25.0),
    ({"avg_frame_rate": "30"}, 30.0),
    ({"avg_frame_rate": "0/0"}, None),
    ({"avg_frame_rate": "", "r_frame_rate": "60000/1001"}, 59.94),
    ({"avg_frame_rate": "abc/1"}, None),
    ({"avg_frame_rate": "24/x"}, None),
    ({"avg_frame_rate": "/1"}, None),
    ({}, None),
])
def test_fps(stream, expected):
    assert streaming._fps(stream) == expected


@pytest.mark.parametrize("profile,atmos", [
    ("Dolby Digital Plus + Dolby Atmos", True),
    ("Dolby TrueHD + Dolby Atmos", True),
    ("E-AC-3 JOC", True),
    ("joc", True),
    ("LC", False),
    (None, False),
])
def test_shape_probe_atmos_flag(profile, atmos):
    out = streaming._shape_probe({"streams": [{"codec_type": "audio", "profile": profile}]}, 1)
    assert out["audio"][0]["atmos"] is atmos


def test_shape_probe_empty():
    assert streaming._shape_probe({}, 42) == {
        "container": None, "duration_s": None, "bitrate": None, "size_bytes": 42,
        "video": None, "audio": [], "subtitles": [],
    }


def test_pieces_ready():
    assert streaming._pieces_ready([2, 2, 2], 0, 2)
    assert not streaming._pieces_ready([2, 2], 0, 2)  # too short
    assert not streaming._pieces_ready([2, 1, 2], 0, 2)
    assert streaming._pieces_ready([0, 2, 2], 1, 2)
    assert not streaming._pieces_ready([], 0, 0)
