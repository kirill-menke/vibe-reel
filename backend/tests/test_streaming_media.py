"""Watch-while-downloading with real media (slow): ffmpeg-generated MKVs fed
into a GrowingFile, streamed and probed through the app exactly as the TV
and the phone use it.

- the stream of a file that grows between reads is byte-identical to the
  source, and ffprobe of the streamed bytes sees the source's tracks;
- with only first/last-piece priority done (the middle missing), /probe
  already works and the container's tail is served at once;
- an HEVC + E-AC-3 + AAC file with subtitles probes exactly;
- /probe is 409 not_ready until the header window is on disk, then 200.
"""

from __future__ import annotations

import pytest

from reel_api import streaming
from tests.support.growing import GrowingFile
from tests.support.media import Audio, Spec, Sub, cbr, ffprobe, make_media
from tests.support.qbit import make_hash

pytestmark = [pytest.mark.slow, pytest.mark.ffmpeg]

MiB = 1 << 20


@pytest.fixture(scope="module")
def big_mkv(media_dir):
    """~15 MB, 3 s: H.264 CBR 40 Mbit/s + the default tracks of sample_mkv
    (E-AC-3 5.1 eng default, AC-3 ger, AAC eng 'Commentary', SRT, chapters)."""
    from tests.conftest import _need_ffmpeg

    _need_ffmpeg()
    return make_media(media_dir / "big.mkv", Spec(duration=3, extra=cbr("40M")))


def track_view(probe: dict) -> list[tuple]:
    """What a player cares about per stream, from raw ffprobe JSON."""
    return [
        (s["codec_type"], s["codec_name"], s.get("channels"), (s.get("tags") or {}).get("language"),
         (s.get("disposition") or {}).get("default"))
        for s in probe["streams"]
    ]


async def test_growing_file_streams_byte_identical(monkeypatch, clock, api, qbit, tmp_path, big_mkv):
    data = big_mkv.read_bytes()
    assert len(data) > 8 * MiB
    g = GrowingFile(tmp_path / "incomplete" / "Movie.2026.mkv", data, piece_size=256 * 1024)
    g.grow_to(MiB + 1)
    h = make_hash("grow-identical")
    qbit.add_growing(h, g)

    waits = []
    real_sleep = clock.sleep

    async def download_while_waiting(s, result=None):
        # the reader is at the frontier: another 1.5 MiB lands per poll
        waits.append(s)
        done = sum(1 for st in g.states if st == 2) * g.piece_size
        g.grow_to(done + 3 * MiB // 2)
        return await real_sleep(s, result)

    clock.sleep = download_while_waiting
    clock.install(monkeypatch, streaming)

    r = await api.get(f"/api/downloads/{h}/stream")
    assert r.status_code == 200
    assert r.headers["content-length"] == str(len(data))
    assert r.content == data
    assert len(waits) >= 5  # it really waited at the frontier, more than once
    assert g.is_complete

    streamed = tmp_path / "streamed.mkv"
    streamed.write_bytes(r.content)
    got, src = ffprobe(streamed), ffprobe(big_mkv)
    assert track_view(got) == track_view(src)
    assert [c["tags"]["title"] for c in got["chapters"]] == ["Intro", "Chapter 02"]


async def test_range_reads_follow_the_frontier(monkeypatch, clock, api, qbit, tmp_path, big_mkv):
    """A player's typical pattern: the head, then the tail (index), then
    ranges further in as the download advances."""
    data = big_mkv.read_bytes()
    g = GrowingFile(tmp_path / "dl" / "Movie.mkv", data, piece_size=MiB)
    g.first_last()
    h = make_hash("ranges")
    qbit.add_growing(h, g)
    clock.install(monkeypatch, streaming)

    r = await api.get(f"/api/downloads/{h}/stream", headers={"Range": "bytes=0-65535"})
    assert r.status_code == 206 and r.content == data[:65536]
    r = await api.get(f"/api/downloads/{h}/stream", headers={"Range": "bytes=-4096"})
    assert r.status_code == 206 and r.content == data[-4096:]
    assert clock.sleeps == []  # both ends were already on disk: no waiting

    g.grow_to(6 * MiB)
    r = await api.get(f"/api/downloads/{h}/stream", headers={"Range": f"bytes={4 * MiB}-{5 * MiB - 1}"})
    assert r.status_code == 206 and r.content == data[4 * MiB:5 * MiB]
    assert clock.sleeps == []


async def test_probe_with_only_first_and_last_piece(api, qbit, tmp_path, big_mkv):
    """qBittorrent's first/last-piece priority with realistic 4 MiB pieces:
    the middle of the file is still zeros, but the header fits in the first
    piece — /probe answers with the real track layout."""
    data = big_mkv.read_bytes()
    g = GrowingFile(tmp_path / "dl" / "Movie.mkv", data, piece_size=4 * MiB)
    g.first_last()
    assert not g.is_complete and g.n_pieces >= 4
    assert g.on_disk()[5 * MiB:6 * MiB] == bytes(MiB)  # the middle really is missing
    h = make_hash("first-last")
    qbit.add_growing(h, g)

    r = await api.get(f"/api/downloads/{h}/probe")
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["container"] == "matroska"
    assert p["size_bytes"] == len(data)
    assert p["duration_s"] == pytest.approx(3.0, abs=0.1)
    assert p["video"]["codec"] == "h264" and p["video"]["fps"] == 24.0
    assert [(a["codec"], a["channels"], a["lang"], a["default"]) for a in p["audio"]] == [
        ("eac3", 6, "eng", True), ("ac3", 2, "ger", False), ("aac", 2, "eng", False)]
    assert [s["codec"] for s in p["subtitles"]] == ["subrip"]


async def test_hevc_eac3_aac_probe_is_exact(api, qbit, tmp_path, media_dir):
    from tests.conftest import _need_ffmpeg

    _need_ffmpeg()
    src = make_media(media_dir / "hevc-tracks.mkv", Spec(
        video="hevc",
        audio=(Audio("eac3", 6, "eng", title="Surround", default=True),
               Audio("aac", 2, "jpn", title="Japanese")),
        subs=(Sub("eng", title="Signs & Songs", forced=True), Sub("ger", default=True)),
        size="640x360", fps=25,
    ))
    data = src.read_bytes()
    g = GrowingFile(tmp_path / "dl" / "Anime.S01E01.mkv", data, piece_size=64 * 1024)
    g.complete()
    h = make_hash("hevc-exact")
    qbit.add_growing(h, g)

    r = await api.get(f"/api/downloads/{h}/probe")
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["container"] == "matroska"
    assert p["size_bytes"] == len(data)
    assert p["video"] == {"index": 0, "codec": "hevc", "width": 640, "height": 360, "hdr": None,
                          "fps": 25.0}
    assert p["audio"] == [
        {"index": 1, "codec": "eac3", "channels": 6, "layout": "5.1(side)", "lang": "eng",
         "title": "Surround", "atmos": False, "default": True},
        {"index": 2, "codec": "aac", "channels": 2, "layout": "stereo", "lang": "jpn",
         "title": "Japanese", "atmos": False, "default": False},
    ]
    assert p["subtitles"] == [
        {"index": 3, "codec": "subrip", "lang": "eng", "title": "Signs & Songs", "forced": True,
         "default": False},
        {"index": 4, "codec": "subrip", "lang": "ger", "title": None, "forced": False, "default": True},
    ]


@pytest.mark.parametrize("piece", [MiB, 512 * 1024])
async def test_probe_is_not_ready_until_the_header_window_is_down(api, qbit, tmp_path, big_mkv, piece):
    data = big_mkv.read_bytes()
    g = GrowingFile(tmp_path / "dl" / "Movie.mkv", data, piece_size=piece)
    h = make_hash(f"header-{piece}")
    qbit.add_growing(h, g)

    window = streaming.PROBE_MIN_BYTES
    for have in range(0, window, piece):
        g.grow_to(have)
        r = await api.get(f"/api/downloads/{h}/probe")
        assert r.status_code == 409, have
        assert r.json() == {"error": "not_ready", "detail": "file header not downloaded yet"}
        assert r.headers["retry-after"] == "10"
    g.grow_to(window)
    r = await api.get(f"/api/downloads/{h}/probe")
    assert r.status_code == 200, r.text
    assert r.json()["video"]["codec"] == "h264"
    assert h in streaming._probe_cache


async def test_small_file_probe_waits_for_the_whole_file(api, qbit, tmp_path, sample_mkv):
    """A file smaller than PROBE_MIN_BYTES: the header window is the whole file."""
    data = sample_mkv.read_bytes()
    assert len(data) < streaming.PROBE_MIN_BYTES
    g = GrowingFile(tmp_path / "dl" / "Short.mkv", data, piece_size=16 * 1024)
    h = make_hash("small-whole")
    qbit.add_growing(h, g)
    g.complete_pieces(0, g.n_pieces - 2)  # every piece but the last
    g.states[-1] = 1
    assert (await api.get(f"/api/downloads/{h}/probe")).status_code == 409
    g.complete()
    r = await api.get(f"/api/downloads/{h}/probe")
    assert r.status_code == 200 and len(r.json()["audio"]) == 3
