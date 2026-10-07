"""Trailers pipeline end to end: a fake `yt-dlp` (tests/support/fake_ytdlp.py)
answers -j and streams small lavfi-made fMP4 files, the real ffmpeg remuxes
them into the HLS event playlist, and the HTTP surface serves the result.

Real subprocesses and real time; YouTube is never contacted (the fake asserts
it is the yt-dlp on PATH, and caption URLs go through respx).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess

import httpx
import pytest

from reel_api import trailers as tr
from tests.support.clock import _Proxy
from tests.support.fake_ytdlp import FakeYtDlp, audio_fmt, fake_ffmpeg, video_fmt
from tests.support.hls import check_playlist
from tests.support.media import FFMPEG, ffprobe
from tests.support.schemas import TRAILER_STATUS, validate

pytestmark = [pytest.mark.slow, pytest.mark.ffmpeg]

YT = "fakeTrailr1"
YT2 = "fakeTrailr2"
YT3 = "fakeTrailr3"
SEGMENT = re.compile(r"^s\d{3}\.m4s$")
CAPS = "https://www.youtube.com/api/timedtext"


# ---------------------------------------------------------------- media


def _encode(path, args):
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *args,
                    "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof",
                    str(path)], check=True)
    return path


@pytest.fixture(scope="module")
def streams(tmp_path_factory):
    """9 s DASH streams as YouTube serves them, honest to the formats that
    offer them (FakeYtDlp checks): a 3840x2160 VP9 profile 2 10-bit WebM
    (itag 337, "vp9.2" HDR10), a 1920x1080 H.264 High@4.0 fragmented MP4
    (itag 137, avc1.640028), AAC-LC stereo (itag 140). 2 fps with a keyframe
    every second keeps the 4K encode to a few seconds."""
    from tests.conftest import _need_ffmpeg

    _need_ffmpeg()
    d = tmp_path_factory.mktemp("yt")
    out = {"uhd": d / "337.webm", "fhd": d / "137.mp4", "audio": d / "140.m4a"}
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                    "-f", "lavfi", "-i", "testsrc2=size=3840x2160:rate=2:duration=9",
                    "-c:v", "libvpx-vp9", "-profile:v", "2", "-pix_fmt", "yuv420p10le",
                    "-deadline", "realtime", "-cpu-used", "8", "-b:v", "100k", "-g", "2", "-an",
                    "-f", "webm", str(out["uhd"])], check=True)
    _encode(out["fhd"], [
        "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=2:duration=9",
        "-c:v", "libx264", "-preset", "superfast", "-profile:v", "high", "-level", "4.0",
        "-crf", "40", "-pix_fmt", "yuv420p", "-g", "2", "-an"])
    _encode(out["audio"], [
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=9",
        "-c:a", "aac", "-b:a", "48k", "-ac", "2", "-vn"])
    return out


def formats(streams, **over):
    """A 4K HDR VP9 offer, a 1080p H.264 one, a 4K HLS one (must be skipped;
    no file: downloading it fails) and an AAC audio — itags, codecs and ext as
    YouTube lists them (tests/recorded/ytdlp)."""
    fmts = [
        video_fmt("337", streams["uhd"], width=3840, height=2160, vcodec="vp9.2",
                  dynamic_range="HDR10"),
        video_fmt("137", streams["fhd"], width=1920, height=1080, vcodec="avc1.640028"),
        video_fmt("625", None, width=3840, height=2160, vcodec="avc1.640033",
                  protocol="m3u8_native"),
        audio_fmt("140", streams["audio"]),
    ]
    return fmts


@pytest.fixture
def yt(tmp_path, monkeypatch, streams):
    fake = FakeYtDlp(tmp_path / "fake-ytdlp", monkeypatch)
    fake.add(YT, formats(streams), title="Dune: Part Two | Official Trailer")
    return fake


@pytest.fixture
async def trailers(app_module, yt):
    """The app's Trailers. Teardown: release every gate, cancel what still
    runs and wait for its processes, so none outlives the test's event loop."""
    yield app_module.trailers
    yt.release_all()
    for job in list(app_module.trailers.jobs.values()):
        if job.task and not job.task.done():
            job.task.cancel()
            await asyncio.gather(job.task, return_exceptions=True)
    await until(lambda: yt.alive() == [], 10, "the fake yt-dlp processes to exit")
    await asyncio.sleep(0.2)  # let the loop reap the killed children (ffmpeg too)


async def until(cond, timeout: float = 30.0, what: str = "condition"):
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not cond():
        if loop.time() > end:
            raise AssertionError(f"timed out waiting for {what}")
        await asyncio.sleep(0.01)


async def status(api, key):
    r = await api.get(f"/api/trailers/{key}")
    assert r.status_code == 200
    return r.json()


async def finished(api, trailers, key, timeout: float = 30.0) -> dict:
    job = trailers.get(key)
    await until(lambda: job.task.done(), timeout, f"{key} to finish")
    return await status(api, key)


# ---------------------------------------------------------------- happy path


async def test_resolve_download_remux_and_serve(api, yt, trailers, reel_env):
    r = await api.post(f"/api/trailers/{YT}")
    assert r.status_code == 200
    assert r.json()["state"] == "resolving" and r.json()["segments"] == 0
    st = await finished(api, trailers, YT)

    assert st == {
        "id": YT, "state": "ready", "segments": 3, "buffered_s": 9.0, "duration": 9,
        "complete": True, "width": 3840, "height": 2160, "vcodec": "vp9.2",
        "codecs": "vp09.02.51.10,mp4a.40.2", "hdr": "HDR10", "subs": None, "subs_done": True,
        "title": "Dune: Part Two | Official Trailer", "error": None,
    }

    # exactly the calls trailers.py documents: one extraction, two downloads
    resolve, *downloads = yt.calls()
    assert resolve["kind"] == f"resolve:{YT}"
    assert resolve["argv"] == ["--no-cache-dir", "--no-warnings", "--no-playlist", "--quiet", "-j",
                               "-f", "(bv*[protocol=https][height<=2160])+(ba[protocol=https])",
                               f"https://www.youtube.com/watch?v={YT}"]
    d = reel_env.cache / "trailers" / YT
    assert sorted(c["kind"] for c in downloads) == [f"download:{YT}:140", f"download:{YT}:337"]
    for c in downloads:
        assert c["argv"][:4] == ["--no-cache-dir", "--no-warnings", "--no-playlist", "--quiet"]
        assert c["argv"][4:] == ["--load-info-json", str(d / "info.json"), "-f",
                                 c["kind"].rsplit(":", 1)[1], "-o", "-"]

    # the folder: playlist, init, segments, the done marker; the signed-URL info is gone
    assert sorted(p.name for p in d.iterdir()) == ["done", "index.m3u8", "init.mp4",
                                                  "s000.m4s", "s001.m4s", "s002.m4s"]
    assert json.loads((d / "done").read_text()) == {
        "v": tr.CACHE_VERSION, "duration": 9, "title": "Dune: Part Two | Official Trailer",
        "width": 3840, "height": 2160, "vcodec": "vp9.2", "codecs": "vp09.02.51.10,mp4a.40.2",
        "hdr": "HDR10", "subs": None,
    }

    r = await api.get(f"/api/trailers/{YT}/index.m3u8")
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    lines = r.text.splitlines()
    assert lines[:2] == ["#EXTM3U", "#EXT-X-START:TIME-OFFSET=0,PRECISE=YES"]
    segs = check_playlist(r.text, complete=True, segment=SEGMENT)
    assert [n for n, _ in segs] == ["s000.m4s", "s001.m4s", "s002.m4s"]
    assert sum(d for _, d in segs) == pytest.approx(st["buffered_s"], abs=0.01)

    init = await api.get(f"/api/trailers/{YT}/init.mp4")
    assert init.status_code == 200 and init.headers["content-type"] == "video/mp4"
    assert init.content == (d / "init.mp4").read_bytes()
    seg = await api.get(f"/api/trailers/{YT}/s001.m4s")
    assert seg.headers["content-type"] == "video/iso.segment"
    assert seg.content == (d / "s001.m4s").read_bytes()

    # the remux is a copy: the 4K VP9.2 stream + the AAC stream
    probe = ffprobe(d / "index.m3u8")
    kinds = {s["codec_type"]: s for s in probe["streams"]}
    assert (kinds["video"]["codec_name"], kinds["video"]["profile"], kinds["video"]["width"]) == \
        ("vp9", "Profile 2", 3840)
    assert kinds["audio"]["codec_name"] == "aac"
    assert float(probe["format"]["duration"]) == pytest.approx(9, abs=0.2)


async def test_height_in_the_key_caps_the_choice(api, yt, trailers, reel_env):
    await api.post(f"/api/trailers/{YT}@1080")
    st = await finished(api, trailers, f"{YT}@1080")
    assert st["state"] == "ready"
    assert (st["width"], st["height"], st["vcodec"], st["hdr"]) == (1920, 1080, "avc1.640028", None)
    assert st["codecs"] == "avc1.640028,mp4a.40.2"
    (resolve,) = yt.calls("resolve")
    assert "(bv*[protocol=https][height<=1080])+(ba[protocol=https])" in resolve["argv"]
    assert {c["kind"] for c in yt.calls("download")} == {f"download:{YT}:137", f"download:{YT}:140"}
    # its own folder, next to (not instead of) the plain id's
    d = reel_env.cache / "trailers" / f"{YT}@1080"
    assert (d / "done").exists() and not (reel_env.cache / "trailers" / YT).exists()
    probe = ffprobe(d / "index.m3u8")
    assert next(s for s in probe["streams"] if s["codec_type"] == "video")["width"] == 1920
    assert (await api.get(f"/api/trailers/{YT}")).status_code == 404  # 2160p was never started


async def test_states_resolving_downloading_ready(api, yt, trailers):
    yt.gate(f"resolve:{YT}")
    yt.gate(f"download:{YT}:337", at=0.75)
    await api.post(f"/api/trailers/{YT}")
    await until(lambda: yt.calls("resolve"), what="the extraction to start")
    # The fake logs the call, then blocks on its gate: until the release the
    # extraction can't answer, whatever the timing — the job must say so.
    (resolve,) = yt.calls("resolve")
    for _ in range(3):
        st = await status(api, YT)
        assert st["state"] == "resolving" and st["width"] is None and st["codecs"] is None
        assert resolve["pid"] in yt.alive()

    yt.release(f"resolve:{YT}")
    job = trailers.get(YT)
    await until(lambda: job.state == "downloading", what="downloading")
    st = await status(api, YT)
    # the format is known as soon as the extraction answered
    assert (st["width"], st["height"], st["duration"]) == (3840, 2160, 9)
    # three quarters of the video in: ffmpeg has cut segments, the playlist is open
    await until(lambda: job.playlist()[0] >= 1, what="a first segment while downloading")
    st = await status(api, YT)
    assert st["state"] == "downloading" and st["complete"] is False
    assert st["segments"] >= 1 and 0 < st["buffered_s"] < 9
    r = await api.get(f"/api/trailers/{YT}/index.m3u8")
    assert r.status_code == 200
    early = check_playlist(r.text, complete=False, segment=SEGMENT)
    assert (await api.get(f"/api/trailers/{YT}/s000.m4s")).status_code == 200

    yt.release(f"download:{YT}:337")
    st = await finished(api, trailers, YT)
    assert st["state"] == "ready" and st["complete"] is True and st["segments"] == 3
    r = await api.get(f"/api/trailers/{YT}/index.m3u8")
    final = check_playlist(r.text, complete=True, segment=SEGMENT)
    assert final[:len(early)] == early  # segments are only ever appended


async def test_post_is_idempotent(api, yt, trailers, reel_env):
    yt.gate(f"resolve:{YT}")
    first = await api.post(f"/api/trailers/{YT}")
    again = await asyncio.gather(*(api.post(f"/api/trailers/{YT}") for _ in range(3)))
    assert all(r.json() == first.json() for r in again)
    yt.release(f"resolve:{YT}")
    st = await finished(api, trailers, YT)
    assert st["state"] == "ready"
    d = reel_env.cache / "trailers" / YT
    old = d.stat().st_mtime - 1000
    os.utime(d, (old, old))
    r = await api.post(f"/api/trailers/{YT}")
    assert r.json() == st
    assert d.stat().st_mtime > old  # LRU touch on a replay
    assert len(yt.calls("resolve")) == 1 and len(yt.calls("download")) == 2


class CountingSemaphore(asyncio.Semaphore):
    """The job slots, counting who asked for one and who got it."""

    def __init__(self, value):
        super().__init__(value)
        self.asked = self.got = 0

    async def acquire(self):
        self.asked += 1
        await super().acquire()
        self.got += 1
        return True


async def test_at_most_max_running_jobs_at_once(api, yt, trailers, streams):
    assert tr.MAX_RUNNING == 2
    trailers._sem = sem = CountingSemaphore(tr.MAX_RUNNING)
    for i in (YT, YT2, YT3):
        if i != YT:
            yt.add(i, formats(streams))
        yt.gate(f"resolve:{i}")
    for i in (YT, YT2, YT3):
        await api.post(f"/api/trailers/{i}")
    await until(lambda: len(yt.calls("resolve")) == 2, what="two extractions")
    # No fixed wait: the third job has asked for a slot and not got one while
    # both holders are blocked on their gates, so it cannot have started.
    await until(lambda: sem.asked == 3, what="the third job to ask for a slot")
    assert sem.got == 2 and len(yt.alive()) == 2
    started = {c["kind"].split(":")[1] for c in yt.calls("resolve")}
    assert started == {YT, YT2}  # the third waits for a slot, still "resolving"
    assert (await status(api, YT3))["state"] == "resolving"

    yt.release(f"resolve:{YT}")
    await finished(api, trailers, YT)
    await until(lambda: len(yt.calls("resolve")) == 3, what="the third extraction")
    yt.release(f"resolve:{YT2}")
    yt.release(f"resolve:{YT3}")
    for i in (YT2, YT3):
        assert (await finished(api, trailers, i))["state"] == "ready"


# ---------------------------------------------------------------- refusals and failures


async def test_a_video_longer_than_max_duration_is_refused(api, yt, trailers, reel_env):
    yt.update(YT, duration=tr.MAX_DURATION + 1)
    await api.post(f"/api/trailers/{YT}")
    st = await finished(api, trailers, YT)
    assert st["state"] == "error"
    assert st["error"] == f"too long for a trailer ({tr.MAX_DURATION + 1} s)"
    assert st["segments"] == 0 and st["complete"] is False
    assert yt.calls("download") == []
    assert not (reel_env.cache / "trailers" / YT).exists()
    assert (await api.get(f"/api/trailers/{YT}/index.m3u8")).status_code == 404


async def test_exactly_max_duration_is_a_trailer(api, yt, trailers):
    yt.update(YT, duration=tr.MAX_DURATION)
    await api.post(f"/api/trailers/{YT}")
    st = await finished(api, trailers, YT)
    assert st["state"] == "ready" and st["duration"] == tr.MAX_DURATION


async def test_ytdlp_failure_is_the_last_stderr_line_and_retried_after_error_ttl(
        api, yt, trailers, monkeypatch, clock):
    clock.install(monkeypatch, tr)
    yt.fail(f"resolve:{YT}", stderr="WARNING: [youtube] nsig extraction failed\n"
                                    "ERROR: [youtube] fakeTrailr1: Sign in to confirm you're not a bot\n\n")
    await api.post(f"/api/trailers/{YT}")
    st = await finished(api, trailers, YT)
    assert st["state"] == "error"
    assert st["error"] == "yt-dlp: ERROR: [youtube] fakeTrailr1: Sign in to confirm you're not a bot"
    assert yt.calls("download") == []

    yt.heal(f"resolve:{YT}")
    clock.t += tr.ERROR_TTL
    r = await api.post(f"/api/trailers/{YT}")
    assert r.json()["state"] == "error"  # not before ERROR_TTL has passed
    assert len(yt.calls("resolve")) == 1

    clock.t += 1
    r = await api.post(f"/api/trailers/{YT}")
    assert r.json()["state"] == "resolving" and r.json()["error"] is None
    st = await finished(api, trailers, YT)
    assert st["state"] == "ready" and len(yt.calls("resolve")) == 2


@pytest.mark.parametrize("which, fid", [("video", "337"), ("audio", "140")])
async def test_a_failed_download_names_the_stream(api, yt, trailers, reel_env, which, fid):
    # The stream is delivered, then yt-dlp fails (a last fragment it gave up
    # on): only that process exits non-zero, and the status names it.
    yt.fail(f"download:{YT}:{fid}", stderr="ERROR: fragment 9 not found, unable to continue\n",
            after=True)
    await api.post(f"/api/trailers/{YT}")
    st = await finished(api, trailers, YT)
    assert st["state"] == "error"
    assert st["error"] == f"{which}: ERROR: fragment 9 not found, unable to continue"
    assert not (reel_env.cache / "trailers" / YT).exists()
    await until(lambda: yt.alive() == [], 5, "no fake yt-dlp left running")


async def test_a_failed_video_download_from_the_start(api, yt, trailers):
    yt.fail(f"download:{YT}:337", stderr="ERROR: unable to download video data: HTTP Error 403: Forbidden\n")
    await api.post(f"/api/trailers/{YT}")
    st = await finished(api, trailers, YT)
    assert st["error"] == "video: ERROR: unable to download video data: HTTP Error 403: Forbidden"


async def test_an_early_audio_failure_is_reported_as_the_audios_error(api, yt, trailers):
    """An audio download that fails at once makes ffmpeg give up on its empty
    input, and the video download then dies on the broken pipe. The status
    must carry the cause — the audio's 403 — not the video's broken pipe."""
    yt.fail(f"download:{YT}:140", stderr="ERROR: unable to download video data: HTTP Error 403: Forbidden\n")
    await api.post(f"/api/trailers/{YT}")
    st = await finished(api, trailers, YT)
    assert st["state"] == "error"
    assert "audio" in st["error"] and "HTTP Error 403: Forbidden" in st["error"], st["error"]


async def test_one_stream_only_is_refused(api, yt, trailers):
    yt.update(YT, requested=["137"])
    await api.post(f"/api/trailers/{YT}")
    st = await finished(api, trailers, YT)
    assert st["error"] == "no separate video + audio streams offered"
    assert yt.calls("download") == []


async def test_audio_first_in_requested_formats_still_maps_video_and_audio(api, yt, trailers):
    yt.update(YT, requested=["140", "137"])
    await api.post(f"/api/trailers/{YT}")
    st = await finished(api, trailers, YT)
    assert st["state"] == "ready" and st["codecs"] == "avc1.640028,mp4a.40.2"
    assert (st["width"], st["height"]) == (1920, 1080)


@pytest.mark.parametrize("mode, error", [
    ("fail", "ffmpeg: pipe:0: Invalid data found when processing input"),
    ("partial", "playlist not finished"),
])
async def test_ffmpeg_failure_and_an_unfinished_playlist(api, yt, trailers, monkeypatch, tmp_path,
                                                         reel_env, mode, error):
    exe = fake_ffmpeg(tmp_path, mode, monkeypatch)
    real_which = shutil.which
    monkeypatch.setattr(tr.shutil, "which", lambda n: exe if n == "ffmpeg" else real_which(n))
    await api.post(f"/api/trailers/{YT}")
    st = await finished(api, trailers, YT)
    assert st["state"] == "error" and st["error"] == error
    assert not (reel_env.cache / "trailers" / YT).exists()


async def test_a_failed_spawn_kills_the_downloads_already_started(api, yt, trailers, monkeypatch,
                                                                 tmp_path, reel_env):
    spawned = []
    real_spawn = asyncio.create_subprocess_exec

    async def spy(*args, **kw):
        proc = await real_spawn(*args, **kw)
        spawned.append((args, proc))
        return proc

    monkeypatch.setattr(tr, "asyncio", _Proxy(asyncio, create_subprocess_exec=spy))
    yt.gate(f"download:{YT}:337", at=0.5)
    yt.gate(f"download:{YT}:140", at=0.5)
    broken = tmp_path / "not-executable-ffmpeg"
    broken.write_text("")
    real_which = shutil.which
    monkeypatch.setattr(tr.shutil, "which", lambda n: str(broken) if n == "ffmpeg" else real_which(n))
    await api.post(f"/api/trailers/{YT}")
    st = await finished(api, trailers, YT)
    assert st["state"] == "error" and st["error"].startswith("[Errno 13] Permission denied")
    assert not (reel_env.cache / "trailers" / YT).exists()
    # the extraction (exited 0) and both downloads, which were killed
    assert [args[-1] for args, _ in spawned] == [f"https://www.youtube.com/watch?v={YT}", "-", "-"]
    assert spawned[0][1].returncode == 0
    for _, proc in spawned[1:]:
        assert await asyncio.wait_for(proc.wait(), 5) == -9


@pytest.mark.parametrize("missing", ["yt-dlp", "ffmpeg"])
async def test_a_missing_tool_is_an_error(api, yt, trailers, monkeypatch, missing):
    real_which = shutil.which
    monkeypatch.setattr(tr.shutil, "which", lambda n: None if n == missing else real_which(n))
    await api.post(f"/api/trailers/{YT}")
    st = await finished(api, trailers, YT)
    assert st["state"] == "error" and st["error"] == f"{missing} not on PATH"
    assert yt.calls("download") == []


async def test_resolve_timeout_kills_the_extraction(api, yt, trailers, monkeypatch):
    monkeypatch.setattr(tr, "RESOLVE_TIMEOUT", 0.5)
    yt.gate(f"resolve:{YT}")
    await api.post(f"/api/trailers/{YT}")
    st = await finished(api, trailers, YT)
    assert st["state"] == "error" and st["error"] == "TimeoutError"
    await until(lambda: yt.alive() == [], 5, "the extraction to be killed")


async def test_job_timeout_kills_downloads_and_ffmpeg(api, yt, trailers, monkeypatch, reel_env):
    monkeypatch.setattr(tr, "JOB_TIMEOUT", 1.5)
    yt.gate(f"download:{YT}:337", at=0.5)
    await api.post(f"/api/trailers/{YT}")
    st = await finished(api, trailers, YT)
    assert st["state"] == "error" and st["error"] == "TimeoutError"
    assert len(yt.calls("download")) == 2
    await until(lambda: yt.alive() == [], 5, "the downloads to be killed")
    assert not (reel_env.cache / "trailers" / YT).exists()


async def test_cancelling_a_running_job_kills_its_processes(api, yt, trailers):
    yt.gate(f"download:{YT}:337", at=0.5)
    await api.post(f"/api/trailers/{YT}")
    job = trailers.get(YT)
    await until(lambda: len(yt.calls("download")) == 2, what="both downloads")
    job.task.cancel()
    await asyncio.gather(job.task, return_exceptions=True)
    assert job.task.cancelled() and job.ended_at is not None
    await until(lambda: yt.alive() == [], 5, "the downloads to be killed")


async def test_finished_trailers_are_evicted_above_the_cache_cap(api, yt, trailers, streams,
                                                                 monkeypatch, reel_env):
    yt.add(YT2, formats(streams))
    await api.post(f"/api/trailers/{YT}@1080")
    await finished(api, trailers, f"{YT}@1080")
    root = reel_env.cache / "trailers"
    size = sum(f.stat().st_size for f in (root / f"{YT}@1080").iterdir())
    os.utime(root / f"{YT}@1080", (1_000_000, 1_000_000))  # played long ago
    monkeypatch.setattr(tr, "CACHE_MAX_BYTES", size + 1000)
    await api.post(f"/api/trailers/{YT2}@1080")
    await finished(api, trailers, f"{YT2}@1080")
    assert not (root / f"{YT}@1080").exists()
    assert (await api.get(f"/api/trailers/{YT}@1080")).status_code == 404
    assert (await status(api, f"{YT2}@1080"))["state"] == "ready"


# ---------------------------------------------------------------- English subtitles


VTT = "WEBVTT\n\n00:00:00.500 --> 00:00:02.000\nThe spice must flow.\n"


def caption(url_lang, ext):
    return {"ext": ext, "url": f"{CAPS}?v={YT}&lang={url_lang}&fmt={ext}"}


async def run_with_subs(api, yt, trailers, upstream, *, answers, **info):
    yt.update(YT, **info)
    routes = {}
    for (lang, ext), resp in answers.items():
        route = upstream.get(CAPS, params={"lang": lang, "fmt": ext})
        routes[(lang, ext)] = (route.mock(return_value=resp) if isinstance(resp, httpx.Response)
                               else route.mock(side_effect=resp))
    await api.post(f"/api/trailers/{YT}")
    st = await finished(api, trailers, YT)
    assert st["state"] == "ready" and st["subs_done"] is True
    # the documented status shape, subs populated or null (README trailers section)
    assert validate(TRAILER_STATUS, st) == []
    return st, routes


async def test_an_uploaded_english_track_wins_and_is_used_as_is(api, yt, trailers, upstream, reel_env):
    st, routes = await run_with_subs(
        api, yt, trailers, upstream,
        subtitles={"de": [caption("de", "vtt")], "en-GB": [caption("en-GB", "vtt")],
                   "en": [caption("en", "json3"), caption("en", "vtt")]},
        automatic_captions={"en-orig": [caption("en-orig", "json3")]},
        answers={("en", "vtt"): httpx.Response(200, text="﻿" + VTT),
                 ("en-orig", "json3"): httpx.Response(500)},
    )
    assert st["subs"] == {"lang": "en", "kind": "manual"}
    assert routes[("en", "vtt")].call_count == 1 and routes[("en-orig", "json3")].call_count == 0
    r = await api.get(f"/api/trailers/{YT}/subs.vtt")
    assert r.status_code == 200 and r.headers["content-type"] == "text/vtt; charset=utf-8"
    assert r.text == "﻿" + VTT
    done = json.loads((reel_env.cache / "trailers" / YT / "done").read_text())
    assert done["subs"] == {"lang": "en", "kind": "manual"}


async def test_a_regional_english_track_when_plain_en_has_no_vtt(api, yt, trailers, upstream):
    st, routes = await run_with_subs(
        api, yt, trailers, upstream,
        subtitles={"en": [caption("en", "json3")], "en-US": [caption("en-US", "vtt")],
                   "en-AU": [caption("en-AU", "vtt")]},
        answers={("en-US", "vtt"): httpx.Response(200, text=VTT),
                 ("en-AU", "vtt"): httpx.Response(200, text=VTT)},
    )
    assert st["subs"] == {"lang": "en", "kind": "manual"}
    assert routes[("en-US", "vtt")].call_count == 1 and routes[("en-AU", "vtt")].call_count == 0


async def test_auto_captions_are_rebuilt_from_json3(api, yt, trailers, upstream):
    events = {"events": [
        {"tStartMs": 0, "dDurationMs": 4000, "segs": [{"utf8": "Long live"}, {"utf8": " the fighters"}]},
        {"tStartMs": 1500, "aAppend": 1, "segs": [{"utf8": "\n"}]},
        {"tStartMs": 2000, "dDurationMs": 3000, "segs": [{"utf8": "Lisan al Gaib"}]},
    ]}
    st, _ = await run_with_subs(
        api, yt, trailers, upstream, language="en",
        automatic_captions={"en": [caption("en", "vtt"), caption("en", "json3")],
                            "en-orig": [caption("en-orig", "json3")]},
        answers={("en-orig", "json3"): httpx.Response(200, json=events)},
    )
    assert st["subs"] == {"lang": "en", "kind": "auto"}
    r = await api.get(f"/api/trailers/{YT}/subs.vtt")
    assert r.text == ("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nLong live the fighters\n\n"
                      "00:00:02.000 --> 00:00:05.000\nLisan al Gaib\n")


async def test_auto_english_of_a_foreign_video_is_a_translation(api, yt, trailers, upstream):
    events = {"events": [{"tStartMs": 100, "dDurationMs": 900, "segs": [{"utf8": "Hello"}]}]}
    st, _ = await run_with_subs(
        api, yt, trailers, upstream, language="de",
        subtitles={"de": [caption("de", "vtt")]},
        automatic_captions={"en": [caption("en", "json3")], "de": [caption("de", "json3")]},
        answers={("en", "json3"): httpx.Response(200, json=events)},
    )
    assert st["subs"] == {"lang": "en", "kind": "translated"}


@pytest.mark.parametrize("info, answers", [
    ({}, {}),  # nothing offered
    ({"subtitles": {"en": [caption("en", "vtt")]}},
     {("en", "vtt"): httpx.Response(200, text="<html>not a vtt</html>")}),
    ({"subtitles": {"en": [caption("en", "vtt")]}}, {("en", "vtt"): httpx.Response(500)}),
    ({"automatic_captions": {"en": [caption("en", "json3")]}},
     {("en", "json3"): httpx.Response(200, json={"events": [{"tStartMs": 0, "aAppend": 1}]})}),
    ({"automatic_captions": {"en": [caption("en", "json3")]}},
     {("en", "json3"): httpx.Response(200, text="{broken")}),
    ({"automatic_captions": {"en": [caption("en", "json3")]}},
     {("en", "json3"): httpx.ConnectError("down")}),
], ids=["none", "not-webvtt", "http-500", "json3-empty", "json3-broken", "unreachable"])
async def test_no_subtitles_never_fail_the_trailer(api, yt, trailers, upstream, reel_env, info, answers):
    st, _ = await run_with_subs(api, yt, trailers, upstream, answers=answers, **info)
    assert st["subs"] is None and st["error"] is None
    assert not (reel_env.cache / "trailers" / YT / "subs.vtt").exists()
    assert (await api.get(f"/api/trailers/{YT}/subs.vtt")).status_code == 404


def test_the_fake_refuses_a_format_its_file_contradicts(tmp_path, monkeypatch, streams):
    """A format's file must be what yt-dlp says it is: the 1080p H.264 file
    offered as 4K VP9.2 HDR (what this suite's fixture used to do) is refused."""
    fake = FakeYtDlp(tmp_path / "liar", monkeypatch)
    with pytest.raises(AssertionError) as e:
        fake.add("liarTrailr1", [
            video_fmt("337", streams["fhd"], width=3840, height=2160, vcodec="vp9.2", dynamic_range="HDR10"),
            video_fmt("137", streams["fhd"], width=1920, height=1080, vcodec="avc1.4d4028"),
            audio_fmt("140", streams["uhd"]),
        ])
    msg = str(e.value)
    assert "337: ext webm but the file is mov,mp4" in msg
    assert "337: claims 3840x2160, the file is 1920x1080" in msg
    assert "337: claims vp9.2, the file is h264" in msg
    assert "137: avc1.4d4028 is profile 4d, the file is High" in msg
    assert "140: claims audio mp4a.40.2, the file is video" in msg
    fake.add("honest00001", formats(streams))  # the suite's own formats pass
