"""livehls.py without running ffmpeg: RFC 6381 codec strings, the ffmpeg
argument builder (audio copy/convert rules, track choice, video tags), the
playlist reader behind the status, the file endpoint (#EXT-X-START
injection, 404s) and the HTTP surface (400/503/404, gzip bypass).

The pipeline itself (probe -> remux -> done with a real ffmpeg) is
tests/test_livehls_e2e.py.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from reel_api import livehls
from tests.support.clock import _Proxy
from tests.support.qbit import make_hash

GID = make_hash("livehls-unit")


@pytest.fixture
def fake_ffmpeg(monkeypatch):
    """shutil.which inside livehls answers fixed paths (no real binaries needed)."""
    paths = {"ffmpeg": "/fake/bin/ffmpeg", "ffprobe": "/fake/bin/ffprobe"}
    monkeypatch.setattr(livehls, "shutil", _Proxy(livehls.shutil, which=lambda name: paths.get(name)))
    return paths


def job(audio: int = -1, gid: str = GID) -> livehls.Job:
    return livehls.Job(gid, audio)


# ---------------------------------------------------------------- codec strings


@pytest.mark.parametrize("profile,level,expected", [
    ("High", 40, "avc1.640028"),
    ("High", 51, "avc1.640033"),
    ("Main", 31, "avc1.4D001F"),
    ("Baseline", 30, "avc1.42001E"),
    ("Constrained Baseline", 30, "avc1.42401E"),
    ("High 10", 41, "avc1.6E0029"),
    ("high", 42, "avc1.64002A"),        # ffprobe's case doesn't matter
    ("High 4:4:4 Predictive", 40, "avc1.640028"),  # unknown profile -> the High 4.0 fallback
    ("High", None, "avc1.640028"),
    ("High", -99, "avc1.640028"),       # ffprobe's "unknown" level
    ("High", "40", "avc1.640028"),      # not an int
    (None, 40, "avc1.640028"),
])
def test_h264_codec_string(profile, level, expected):
    assert livehls._h264({"profile": profile, "level": level}) == expected


@pytest.mark.parametrize("stream,dv5,expected", [
    ({"profile": "Main", "level": 120}, False, "hvc1.1.6.L120.B0"),
    ({"profile": "Main 10", "level": 153}, False, "hvc1.2.4.L153.B0"),
    ({"profile": "Rext", "pix_fmt": "yuv420p10le", "level": 150}, False, "hvc1.2.4.L150.B0"),
    ({"profile": "Main"}, False, "hvc1.1.6.L153.B0"),          # no level -> 5.1
    ({"profile": "Main 10", "level": -99}, False, "hvc1.2.4.L153.B0"),
    ({"profile": "Main 10", "level": 153}, True, "dvh1.05.06"),
    ({}, False, "hvc1.1.6.L153.B0"),
])
def test_hevc_codec_string(stream, dv5, expected):
    assert livehls._hevc(stream, dv5) == expected


@pytest.mark.parametrize("profile,expected", [
    ("LC", "mp4a.40.2"),
    ("HE-AAC", "mp4a.40.5"),
    ("HE-AACv2", "mp4a.40.29"),
    ("he-aacv2", "mp4a.40.29"),
    (None, "mp4a.40.2"),
    ("Main", "mp4a.40.2"),
])
def test_aac_codec_string(profile, expected):
    assert livehls._aac({"profile": profile}) == expected


def test_dovi_side_data():
    rec = {"side_data_type": "DOVI configuration record", "dv_profile": 8}
    assert livehls._dovi({"side_data_list": [{"side_data_type": "Mastering display"}, rec]}) is rec
    assert livehls._dovi({"side_data_list": [{}]}) is None
    assert livehls._dovi({}) is None


# ---------------------------------------------------------------- ffmpeg args

H264 = {"index": 0, "codec_type": "video", "codec_name": "h264", "profile": "High", "level": 40,
        "width": 1920, "height": 1080}
HEVC = {"index": 0, "codec_type": "video", "codec_name": "hevc", "profile": "Main 10", "level": 153,
        "width": 3840, "height": 2160}


def aud(index, codec, channels=2, default=False, profile=None):
    return {"index": index, "codec_type": "audio", "codec_name": codec, "channels": channels,
            "profile": profile, "disposition": {"default": int(default)}}


def args_of(j, *streams):
    return livehls.live._ffmpeg_args(j, {"streams": list(streams)})


def opt(args, flag):
    """Value after `flag` (first occurrence)."""
    return args[args.index(flag) + 1]


@pytest.mark.parametrize("codec,astr", [("aac", "mp4a.40.2"), ("ac3", "ac-3"), ("eac3", "ec-3")])
def test_phone_audio_is_copied(fake_ffmpeg, codec, astr):
    j = job()
    a = args_of(j, H264, aud(1, codec, 6, default=True))
    assert a[a.index("-c:a") + 1] == "copy"
    assert "-b:a" not in a and "-ac" not in a
    assert j.audio_out == codec
    assert j.codecs == f"avc1.640028,{astr}"


def test_he_aac_copy_reports_its_profile(fake_ffmpeg):
    j = job()
    args_of(j, H264, aud(1, "aac", 2, profile="HE-AAC"))
    assert j.codecs == "avc1.640028,mp4a.40.5"


@pytest.mark.parametrize("codec,channels", [("truehd", 8), ("dts", 6), ("flac", 6), ("opus", 3)])
def test_multichannel_other_codecs_become_ac3_640k_51(fake_ffmpeg, codec, channels):
    j = job()
    a = args_of(j, H264, aud(1, codec, channels))
    i = a.index("-c:a")
    assert a[i:i + 6] == ["-c:a", "ac3", "-b:a", "640k", "-ac", "6"]
    assert j.audio_out == "ac3" and j.codecs.endswith(",ac-3")


@pytest.mark.parametrize("codec,channels", [("dts", 2), ("flac", 1), ("opus", 2), ("mp3", None)])
def test_stereo_other_codecs_become_aac_256k(fake_ffmpeg, codec, channels):
    j = job()
    a = args_of(j, H264, aud(1, codec, channels))
    i = a.index("-c:a")
    assert a[i:i + 6] == ["-c:a", "aac", "-b:a", "256k", "-ac", "2"]
    assert j.audio_out == "aac" and j.codecs.endswith(",mp4a.40.2")


def test_requested_audio_index_is_honoured(fake_ffmpeg):
    j = job(audio=3)
    a = args_of(j, H264, aud(1, "eac3", 6, default=True), aud(2, "ac3"), aud(3, "aac"))
    assert a.count("-map") == 2
    assert a[a.index("-map", a.index("-map") + 1) + 1] == "0:3"
    assert j.audio_out == "aac"


@pytest.mark.parametrize("audio", [-1, 0, 7])  # none / the video's index / no such stream
def test_otherwise_the_default_audio_track(fake_ffmpeg, audio):
    j = job(audio=audio)
    a = args_of(j, H264, aud(1, "ac3"), aud(2, "eac3", 6, default=True), aud(3, "aac"))
    maps = [a[i + 1] for i, x in enumerate(a) if x == "-map"]
    assert maps == ["0:0", "0:2"]


def test_otherwise_the_first_audio_track(fake_ffmpeg):
    j = job()
    a = args_of(j, H264, aud(1, "ac3"), aud(2, "eac3"))
    maps = [a[i + 1] for i, x in enumerate(a) if x == "-map"]
    assert maps == ["0:0", "0:1"]


def test_no_audio_is_video_only(fake_ffmpeg):
    j = job()
    a = args_of(j, H264)
    assert "-c:a" not in a and a.count("-map") == 1
    assert j.codecs == "avc1.640028" and j.audio_out is None


def test_attached_pic_is_not_the_video(fake_ffmpeg):
    cover = {"index": 0, "codec_type": "video", "codec_name": "mjpeg", "disposition": {"attached_pic": 1}}
    j = job()
    a = args_of(j, cover, {**H264, "index": 1}, aud(2, "aac"))
    assert opt(a, "-map") == "0:1"
    assert j.video == {"codec": "h264", "width": 1920, "height": 1080, "dv_profile": None}


@pytest.mark.parametrize("streams", [[], [aud(0, "aac")],
                                     [{"index": 0, "codec_type": "video", "codec_name": "png",
                                       "disposition": {"attached_pic": 1}}, aud(1, "aac")]])
def test_no_video_stream_is_an_error(fake_ffmpeg, streams):
    with pytest.raises(RuntimeError, match="^no video stream$"):
        args_of(job(), *streams)


@pytest.mark.parametrize("vcodec", ["av1", "vp9", "mpeg2video", None])
def test_unsupported_video_codec_is_an_error(fake_ffmpeg, vcodec):
    v = {"index": 0, "codec_type": "video", "codec_name": vcodec}
    with pytest.raises(RuntimeError, match=f"^unsupported_video: {vcodec}$"):
        args_of(job(), v, aud(1, "aac"))


def test_hevc_is_tagged_hvc1(fake_ffmpeg):
    j = job()
    a = args_of(j, HEVC, aud(1, "eac3", 6))
    assert opt(a, "-tag:v") == "hvc1" and "-strict" not in a
    assert j.codecs == "hvc1.2.4.L153.B0,ec-3"
    assert j.video["dv_profile"] is None


def test_dolby_vision_profile_5_keeps_dvh1(fake_ffmpeg):
    v = {**HEVC, "side_data_list": [{"side_data_type": "DOVI configuration record", "dv_profile": 5}]}
    j = job()
    a = args_of(j, v, aud(1, "eac3", 6))
    assert opt(a, "-tag:v") == "dvh1" and opt(a, "-strict") == "unofficial"
    assert j.codecs == "dvh1.05.06,ec-3"
    assert j.video == {"codec": "hevc", "width": 3840, "height": 2160, "dv_profile": 5}


@pytest.mark.parametrize("profile", [7, 8])
def test_other_dolby_vision_profiles_play_as_hdr10(fake_ffmpeg, profile):
    v = {**HEVC, "side_data_list": [{"side_data_type": "DOVI configuration record", "dv_profile": profile}]}
    j = job()
    a = args_of(j, v)
    assert opt(a, "-tag:v") == "hvc1"
    assert j.codecs == "hvc1.2.4.L153.B0" and j.video["dv_profile"] == profile


def test_args_shape_and_segment_pattern_inside_the_job_dir(fake_ffmpeg, reel_env):
    j = job(audio=1)
    a = args_of(j, H264, aud(1, "eac3", 6))
    assert a[0] == "/fake/bin/ffmpeg"
    assert opt(a, "-i") == "pipe:0"
    assert opt(a, "-c:v") == "copy"
    assert {"-sn", "-dn"} <= set(a)
    assert opt(a, "-f") == "hls"
    assert opt(a, "-hls_time") == str(livehls.SEGMENT_S)
    assert opt(a, "-hls_playlist_type") == "event"
    assert opt(a, "-hls_segment_type") == "fmp4"
    assert opt(a, "-hls_fmp4_init_filename") == "init.mp4"
    assert opt(a, "-hls_segment_filename") == str(reel_env.cache / "livehls" / f"{GID}-1" / "s%05d.m4s")
    assert a[-1] == str(reel_env.cache / "livehls" / f"{GID}-1" / "index.m3u8")
    # every name the pattern produces is one hls_file serves
    assert livehls.FILE.fullmatch("s%05d.m4s" % 12) and livehls.FILE.fullmatch("init.mp4")


def test_ffmpeg_missing_is_an_error(monkeypatch):
    monkeypatch.setattr(livehls, "shutil", _Proxy(livehls.shutil, which=lambda name: None))
    with pytest.raises(RuntimeError, match="^ffmpeg not on PATH$"):
        args_of(job(), H264)


# ---------------------------------------------------------------- the job's playlist / status


def test_root_follows_cache_directory(reel_env, monkeypatch, tmp_path):
    assert livehls._root() == reel_env.cache / "livehls"
    monkeypatch.setenv("CACHE_DIRECTORY", f"{tmp_path}/a:{tmp_path}/b")  # systemd lists several
    assert livehls._root() == tmp_path / "a" / "livehls"
    monkeypatch.delenv("CACHE_DIRECTORY")
    monkeypatch.setenv("TMPDIR", str(tmp_path / "t"))
    assert livehls._root() == tmp_path / "t" / "reel-api-cache" / "livehls"


PLAYLIST = """#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:EVENT
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6.006000,
s00000.m4s
#EXTINF:6.006000,
s00001.m4s
#EXTINF:2.488000,
s00002.m4s
"""


def write_job_files(j: livehls.Job, playlist: str = PLAYLIST) -> None:
    j.dir.mkdir(parents=True, exist_ok=True)
    (j.dir / "index.m3u8").write_text(playlist)
    (j.dir / "init.mp4").write_bytes(b"\x00\x00\x00\x18ftypiso6" + bytes(12))
    for i in range(3):
        (j.dir / f"s{i:05d}.m4s").write_bytes(bytes([i]) * 1000)


def test_playlist_counts_segments_and_duration():
    j = job()
    assert j.playlist() == (0, 0.0, False)  # nothing written yet
    write_job_files(j)
    assert j.playlist() == (3, 14.5, False)
    (j.dir / "index.m3u8").write_text(PLAYLIST + "#EXT-X-ENDLIST\n")
    assert j.playlist() == (3, 14.5, True)


def test_status_shape():
    j = job(audio=2)
    write_job_files(j)
    j.state, j.duration, j.codecs, j.audio_out, j.progress = "remuxing", 5025.5, "avc1.640028,ec-3", "eac3", 0.25
    j.video = {"codec": "h264", "width": 1920, "height": 1080, "dv_profile": None}
    assert j.status() == {
        "id": GID, "audio": 2, "state": "remuxing", "segments": 3, "buffered_s": 14.5,
        "duration": 5025.5, "complete": False, "codecs": "avc1.640028,ec-3",
        "video": {"codec": "h264", "width": 1920, "height": 1080, "dv_profile": None},
        "audio_codec": "eac3", "progress": 0.25, "error": None,
    }


# ---------------------------------------------------------------- HTTP: files


@pytest.fixture
def served(api):
    """A job with files on disk, registered as if started (no pipeline task)."""
    j = job(audio=1)
    write_job_files(j)
    livehls.live.jobs[j.key] = j
    return j


async def test_index_gets_ext_x_start_injected_once(api, served):
    r = await api.get(f"/api/downloads/{GID}/hls/1/index.m3u8")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/vnd.apple.mpegurl"
    assert r.headers["cache-control"] == "no-store"
    lines = r.text.splitlines()
    assert lines[:2] == ["#EXTM3U", "#EXT-X-START:TIME-OFFSET=0,PRECISE=YES"]
    assert r.text.count("#EXT-X-START") == 1
    assert r.text.replace("#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n", "") == PLAYLIST
    # the file on disk is not modified
    assert (served.dir / "index.m3u8").read_text() == PLAYLIST


async def test_existing_ext_x_start_is_kept(api, served):
    own = PLAYLIST.replace("#EXTM3U\n", "#EXTM3U\n#EXT-X-START:TIME-OFFSET=12\n")
    (served.dir / "index.m3u8").write_text(own)
    r = await api.get(f"/api/downloads/{GID}/hls/1/index.m3u8")
    assert r.text == own


@pytest.mark.parametrize("name,ctype", [("init.mp4", "video/mp4"), ("s00001.m4s", "video/iso.segment")])
async def test_init_and_segments_are_served_as_files(api, served, name, ctype):
    r = await api.get(f"/api/downloads/{GID}/hls/1/{name}")
    assert r.status_code == 200
    assert r.headers["content-type"] == ctype
    assert r.headers["cache-control"] == "no-store"
    assert r.content == (served.dir / name).read_bytes()


async def test_upper_case_gid_finds_the_job(api, served):
    r = await api.get(f"/api/downloads/{GID.upper()}/hls/1/s00000.m4s")
    assert r.status_code == 200


@pytest.mark.parametrize("path,detail", [
    (f"/api/downloads/{GID}/hls/1/s00009.m4s", "no such segment (yet)"),   # not written yet
    (f"/api/downloads/{GID}/hls/2/index.m3u8", "no such segment (yet)"),   # another audio: no job
    (f"/api/downloads/{make_hash('other')}/hls/1/index.m3u8", "no such segment (yet)"),
    (f"/api/downloads/{GID}/hls/1/s1.m4s", "no such file"),                # name not in FILE
    (f"/api/downloads/{GID}/hls/1/index.m3u", "no such file"),
    (f"/api/downloads/{GID}/hls/1/s00000.m4s.tmp", "no such file"),        # ffmpeg's temp_file
    ("/api/downloads/not-a-hash/hls/1/index.m3u8", "no such file"),
    (f"/api/downloads/{GID}z/hls/1/index.m3u8", "no such file"),
])
async def test_file_404s(api, served, path, detail):
    r = await api.get(path)
    assert r.status_code == 404
    assert r.json() == {"error": "not_found", "detail": detail}


@pytest.mark.parametrize("path", ["..%2F..%2Findex.m3u8", "%2E%2E%2Fs00000.m4s", "../../../etc/passwd"])
async def test_traversal_never_reaches_the_disk(api, served, path):
    r = await api.get(f"/api/downloads/{GID}/hls/1/{path}")
    assert r.status_code == 404


async def test_hls_files_bypass_gzip(api, served):
    big = PLAYLIST + "".join(f"#EXTINF:6.006000,\ns{i:05d}.m4s\n" for i in range(3, 200))
    (served.dir / "index.m3u8").write_text(big)
    r = await api.get(f"/api/downloads/{GID}/hls/1/index.m3u8", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200 and len(r.content) > 2048
    assert "content-encoding" not in r.headers
    (served.dir / "s00002.m4s").write_bytes(b"a" * 100_000)  # very compressible
    r = await api.get(f"/api/downloads/{GID}/hls/1/s00002.m4s", headers={"Accept-Encoding": "gzip"})
    assert "content-encoding" not in r.headers
    assert r.headers["content-length"] == "100000"


async def test_get_touches_the_job(monkeypatch, clock, api, served):
    clock.install(monkeypatch, livehls)
    served.touched = 0.0
    await api.get(f"/api/downloads/{GID}/hls/1/s00000.m4s")
    assert served.touched == clock.monotonic()
    clock.t += 500
    await api.get(f"/api/downloads/{GID}/hls", params={"audio": 1})
    assert served.touched == clock.monotonic()


# ---------------------------------------------------------------- HTTP: start / status


@pytest.mark.parametrize("gid", ["abc", "g" * 40, "a" * 39, "a" * 41])
async def test_start_with_a_bad_id_is_400(api, gid):
    r = await api.post(f"/api/downloads/{gid}/hls")
    assert r.status_code == 400
    assert r.json() == {"error": "bad_request", "detail": "bad download id"}
    assert livehls.live.jobs == {} and livehls.live.reaper is None


async def test_start_without_qbittorrent_is_503_and_starts_nothing(make_api):
    # Called directly, not over HTTP (the body is checked over HTTP below).
    async with make_api(QBIT_URL=None):
        r = await livehls.hls_start(GID, -1)
        assert r.status_code == 503
        assert json.loads(r.body)["error"] == "temporarily_unavailable"
    assert livehls.live.jobs == {}


async def test_start_without_qbittorrent_is_the_generic_503(make_api):
    """Without qBittorrent, POST …/hls answers like the app's own /stream:
    the generic 503 body that names no backend, with Retry-After 30."""
    async with make_api(QBIT_URL=None) as api:
        r = await api.post(f"/api/downloads/{GID}/hls")
        same = await api.get(f"/api/downloads/{GID}/stream")
    assert livehls.live.jobs == {}
    assert same.status_code == 503 and "qbittorrent" not in same.text.lower()
    assert r.status_code == 503
    assert r.json() == same.json(), r.text
    assert r.headers.get("retry-after") == same.headers.get("retry-after") == "30"


@pytest.mark.parametrize("audio", ["-2", "201", "x"])
async def test_audio_out_of_range_is_422(api, audio):
    r = await api.post(f"/api/downloads/{GID}/hls", params={"audio": audio})
    assert r.status_code == 422
    r = await api.get(f"/api/downloads/{GID}/hls", params={"audio": audio})
    assert r.status_code == 422


async def test_status_before_start_is_404(api):
    r = await api.get(f"/api/downloads/{GID}/hls")
    assert r.status_code == 404
    assert r.json() == {"error": "not_found", "detail": "not started"}


async def test_start_answers_probing_then_status_follows_the_job(api, qbit):
    """An unknown download: the POST answers the fresh job (probing), the
    pipeline then fails it with 'no such download', and GET status says so."""
    r = await api.post(f"/api/downloads/{GID.upper()}/hls", params={"audio": 2})
    assert r.status_code == 200
    assert r.json() == {
        "id": GID, "audio": 2, "state": "probing", "segments": 0, "buffered_s": 0.0, "duration": None,
        "complete": False, "codecs": None, "video": None, "audio_codec": None, "progress": None, "error": None,
    }
    j = livehls.live.jobs[f"{GID}:2"]
    await j.task
    r = await api.get(f"/api/downloads/{GID}/hls", params={"audio": 2})
    assert r.json()["state"] == "error" and r.json()["error"] == "no such download"
    # the default audio (-1) is a different job
    assert (await api.get(f"/api/downloads/{GID}/hls")).status_code == 404


async def test_start_twice_joins_the_running_job(api, qbit, monkeypatch):
    started = []

    async def held_run(self, qb, j):
        started.append(j.key)
        await asyncio.Event().wait()

    monkeypatch.setattr(livehls.LiveHls, "_run", held_run)
    await api.post(f"/api/downloads/{GID}/hls", params={"audio": 1})
    first = livehls.live.jobs[f"{GID}:1"]
    r = await api.post(f"/api/downloads/{GID}/hls", params={"audio": 1})
    assert r.status_code == 200
    await asyncio.sleep(0)
    assert livehls.live.jobs[f"{GID}:1"] is first
    assert started == [f"{GID}:1"]


async def test_start_after_an_error_restarts_the_job(api, qbit):
    await api.post(f"/api/downloads/{GID}/hls")
    first = livehls.live.jobs[f"{GID}:-1"]
    await first.task
    assert first.state == "error"
    r = await api.post(f"/api/downloads/{GID}/hls")
    assert r.json()["state"] == "probing"
    assert livehls.live.jobs[f"{GID}:-1"] is not first
