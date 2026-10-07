"""Watch-while-downloading: /api/downloads/{gid}/stream and /probe (streaming.py)
against the fake qBittorrent + a file that grows piece by piece.

Documented behaviour (backend README, CLAUDE.md "Watch while downloading"):
Range support; a range at the frontier waits instead of 404ing; the stream
closes after ~2 min of no progress; 409 not_ready (+Retry-After) before the
header is on disk; a parked torrent is force-started on Play; never gzipped.
"""

import random

import pytest

from reel_api import qbittorrent, streaming
from tests.support.growing import GrowingFile
from tests.support.qbit import QBIT, make_hash

CHUNK = streaming.CHUNK  # 1 MiB: the body is read (and awaited) in these windows
SIZE = 3 * CHUNK + 12_345
PIECE = 64 * 1024
GROWN = CHUNK + CHUNK // 2  # downloaded so far: the first window and half of the next


@pytest.fixture
def blob():
    return random.Random(1234).randbytes(SIZE)


@pytest.fixture
def torrent(qbit, tmp_path, blob):
    """A single-file torrent 'Movie.2026.mkv', 1.5 MiB of ~3 MiB downloaded sequentially."""
    g = GrowingFile(tmp_path / "dl" / "Movie.2026.mkv", blob, piece_size=PIECE)
    g.grow_to(GROWN)
    h = make_hash("movie")
    t = qbit.add_growing(h, g)
    return h, g, t


async def test_head_reports_full_size_and_ranges(api, torrent):
    h, g, _ = torrent
    r = await api.head(f"/api/downloads/{h}/stream")
    assert r.status_code == 200
    assert r.headers["content-length"] == str(SIZE)
    assert r.headers["accept-ranges"] == "bytes"
    assert r.headers["content-type"] == "video/x-matroska"
    assert r.headers["cache-control"] == "no-store"


async def test_range_inside_the_downloaded_part_is_206_with_exact_bytes(api, torrent, blob):
    h, _, _ = torrent
    r = await api.get(f"/api/downloads/{h}/stream", headers={"Range": "bytes=1000-50999",
                                                            "Accept-Encoding": "gzip"})
    assert r.status_code == 206
    assert r.headers["content-range"] == f"bytes 1000-50999/{SIZE}"
    assert r.headers["content-length"] == "50000"
    assert r.content == blob[1000:51000]
    # the stream route bypasses gzip: byte offsets must stay meaningful
    assert "content-encoding" not in r.headers


async def test_range_past_the_end_is_416(api, torrent):
    h, _, _ = torrent
    r = await api.get(f"/api/downloads/{h}/stream", headers={"Range": f"bytes={SIZE}-"})
    assert r.status_code == 416
    assert r.headers["content-range"] == f"bytes */{SIZE}"


async def test_unknown_hash_is_404(api, qbit):
    r = await api.get(f"/api/downloads/{make_hash('nope')}/stream")
    assert r.status_code == 404
    assert r.json()["error"] == "not_found"


async def test_no_video_file_yet_is_409_not_ready(api, qbit, torrent):
    h, _, t = torrent
    t.files = []  # metadata not resolved: qBittorrent lists no files yet
    r = await api.get(f"/api/downloads/{h}/stream")
    assert r.status_code == 409
    assert r.json()["error"] == "not_ready"
    assert r.headers["retry-after"] == "10"


@pytest.mark.parametrize("state", ["queuedDL", "stoppedDL", "pausedDL", "stalledDL"])
async def test_play_force_starts_a_parked_torrent(api, qbit, torrent, state):
    h, _, t = torrent
    t.state = state
    r = await api.get(f"/api/downloads/{h}/stream", headers={"Range": "bytes=0-99"})
    assert r.status_code == 206
    assert qbit.called("/torrents/setForceStart") == [{"hashes": h, "value": "true"}]


async def test_downloading_torrent_is_not_force_started(api, qbit, torrent):
    h, _, _ = torrent
    await api.get(f"/api/downloads/{h}/stream", headers={"Range": "bytes=0-99"})
    assert qbit.called("/torrents/setForceStart") == []


async def test_body_waits_at_the_frontier_then_gives_up_after_piece_wait_max(
        monkeypatch, clock, qbit, torrent, blob):
    """Reading toward the frontier serves every complete CHUNK window, then
    polls; with no progress for PIECE_WAIT_MAX it ends the body early (never
    hangs). A window is only served once all of its pieces are in, so the
    half-downloaded second window is not sent."""
    clock.install(monkeypatch, streaming)
    h, g, _ = torrent
    qb = qbittorrent.QBittorrentClient(QBIT, None, None)
    info = await streaming._main_file(qb, h)
    streaming._stream_gen[h] = 1
    got = b"".join([c async for c in streaming._body(qb, h, info, 0, SIZE - 1, 1)])
    assert got == blob[:CHUNK]
    waited = sum(clock.sleeps)
    assert streaming.PIECE_WAIT_MAX <= waited <= streaming.PIECE_WAIT_MAX + streaming.PIECE_POLL


async def test_body_continues_when_the_frontier_moves(monkeypatch, clock, qbit, torrent, blob):
    h, g, _ = torrent
    qb = qbittorrent.QBittorrentClient(QBIT, None, None)
    info = await streaming._main_file(qb, h)
    streaming._stream_gen[h] = 1
    real_sleep = clock.sleep

    async def sleep_and_download(s, result=None):
        g.grow_to(SIZE)  # the next pieces land while the reader waits
        return await real_sleep(s, result)

    clock.sleep = sleep_and_download
    clock.install(monkeypatch, streaming)
    got = b"".join([c async for c in streaming._body(qb, h, info, 0, SIZE - 1, 1)])
    assert got == blob


async def test_newer_stream_supersedes_the_old_one(qbit, torrent):
    h, g, _ = torrent
    g.grow_to(SIZE)
    qb = qbittorrent.QBittorrentClient(QBIT, None, None)
    info = await streaming._main_file(qb, h)
    streaming._stream_gen[h] = 1
    gen = streaming._body(qb, h, info, 0, SIZE - 1, 1)
    first = await gen.__anext__()
    assert first
    streaming._stream_gen[h] = 2  # the player opened a new stream
    rest = [c async for c in gen]
    assert rest == []


@pytest.mark.slow
@pytest.mark.ffmpeg
async def test_probe_reports_real_tracks_of_the_partial_file(api, qbit, tmp_path, sample_mkv):
    data = sample_mkv.read_bytes()
    g = GrowingFile(tmp_path / "dl" / "Show.S01E01.mkv", data, piece_size=PIECE)
    h = make_hash("probe")
    qbit.add_growing(h, g)

    r = await api.get(f"/api/downloads/{h}/probe")
    assert r.status_code == 409 and r.json()["error"] == "not_ready"  # header not on disk

    g.complete()
    r = await api.get(f"/api/downloads/{h}/probe")
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["container"] == "matroska"
    assert p["size_bytes"] == len(data)
    assert p["video"]["codec"] == "h264"
    assert (p["video"]["width"], p["video"]["height"]) == (320, 180)
    assert p["video"]["fps"] == 24.0
    assert [a["codec"] for a in p["audio"]] == ["eac3", "ac3", "aac"]
    eac3, ac3, aac = p["audio"]
    assert eac3["channels"] == 6 and eac3["lang"] == "eng" and eac3["default"] is True
    assert ac3["lang"] == "ger" and ac3["default"] is False
    assert aac["title"] == "Commentary"
    assert [s["codec"] for s in p["subtitles"]] == ["subrip"]
