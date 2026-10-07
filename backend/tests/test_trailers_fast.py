"""trailers.py's pipeline without a real ffmpeg — the fast counterparts of
tests/test_trailers_pipeline.py (slow), added by the T41 mutation pass:
_fetch with the fake yt-dlp and the fake ffmpeg in "ok"/"partial"/"fail"
mode (exact command lines, stream choice, job fields, errors), _work (done
marker, error answer, timeout, concurrency), _subs (which caption track,
json3 rebuild, failures), _run and _ytdlp, plus a few helper edges.

Caption URLs go through respx; YouTube is never contacted."""

from __future__ import annotations

import asyncio
import json
import logging
import sys
import time
from pathlib import Path

import httpx
import pytest

from reel_api import trailers as tr
from tests.support.fake_ytdlp import FakeYtDlp, audio_fmt, fake_ffmpeg, video_fmt

YT = "fastTrailr1"
CAPS = "https://www.youtube.com/api/timedtext"


def msgs(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.name == "reel_api"]


@pytest.fixture
def t(reel_env):
    return tr.Trailers()


@pytest.fixture
def files(tmp_path):
    d = tmp_path / "streams"
    d.mkdir()
    out = {}
    for name in ("v4k", "v1080", "audio"):
        out[name] = d / name
        out[name].write_bytes(name.encode() * 5000)
    return out


@pytest.fixture
def yt(tmp_path, monkeypatch, files):
    fake = FakeYtDlp(tmp_path / "fake-ytdlp", monkeypatch, opaque=True)  # bytes, a fake ffmpeg
    fake.add(YT, [
        video_fmt("313", files["v4k"], width=3840, height=2160, vcodec="vp9.2", dynamic_range="HDR10"),
        video_fmt("137", files["v1080"], width=1920, height=1080, vcodec="avc1.640028"),
        audio_fmt("140", files["audio"]),
    ], title="Dune: Part Two | Official Trailer", duration=95)
    return fake


@pytest.fixture
def ffmpeg(tmp_path, monkeypatch):
    """The fake ffmpeg as the one trailers.py finds; returns set_mode(mode)."""
    log = tmp_path / "ffmpeg.argv"
    monkeypatch.setenv("FAKE_FFMPEG_LOG", str(log))
    exe = fake_ffmpeg(tmp_path, "ok", monkeypatch)
    real = tr.shutil.which
    monkeypatch.setattr(tr.shutil, "which", lambda n: exe if n == "ffmpeg" else real(n))

    def set_mode(mode):
        monkeypatch.setenv("FAKE_FFMPEG_MODE", mode)

    set_mode.exe = exe
    set_mode.argv = lambda: json.loads(log.read_text())
    return set_mode


# ---------------------------------------------------------------- _fetch


async def test_fetch_happy_path_command_lines_and_fields(t, yt, ffmpeg):
    job = tr.Job(YT, t.root)
    await t._fetch(job)
    (resolve,) = yt.calls("resolve")
    base = ["--no-cache-dir", "--no-warnings", "--no-playlist", "--quiet"]
    assert resolve["argv"] == base + ["-j", "-f", "(bv*[protocol=https][height<=2160])+(ba[protocol=https])",
                                      f"https://www.youtube.com/watch?v={YT}"]
    downloads = sorted(c["argv"] for c in yt.calls("download"))
    info_json = str(job.dir / "info.json")
    assert downloads == sorted([base + ["--load-info-json", info_json, "-f", fid, "-o", "-"]
                                for fid in ("313", "140")])
    argv = ffmpeg.argv()
    a_fd = argv[argv.index("-i", argv.index("-i") + 1) + 1]
    assert a_fd.startswith("pipe:") and a_fd != "pipe:0"
    assert argv == ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", "pipe:0", "-i", a_fd,
                    "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-f", "hls", "-hls_time", "4",
                    "-hls_playlist_type", "event", "-hls_segment_type", "fmp4",
                    "-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename",
                    str(job.dir / "s%03d.m4s"), str(job.dir / "index.m3u8")]
    assert (job.state, job.duration, job.title) == ("downloading", 95, "Dune: Part Two | Official Trailer")
    assert (job.width, job.height, job.vcodec, job.hdr) == (3840, 2160, "vp9.2", "HDR10")
    assert job.codecs == "vp09.02.51.10,mp4a.40.2"
    assert not (job.dir / "info.json").exists()  # signed URLs: gone once done
    assert job.subs_done is True and job.subs is None


async def test_fetch_height_cap_and_sdr(t, yt, ffmpeg):
    job = tr.Job(YT, t.root, 1080)
    await t._fetch(job)
    assert "(bv*[protocol=https][height<=1080])+(ba[protocol=https])" in yt.calls("resolve")[0]["argv"]
    assert (job.height, job.vcodec, job.hdr, job.codecs) == (1080, "avc1.640028", None, "avc1.640028,mp4a.40.2")


async def test_fetch_audio_listed_first_is_still_the_audio(t, yt, ffmpeg):
    yt.update(YT, requested=["140", "137"])
    job = tr.Job(YT, t.root)
    await t._fetch(job)
    assert (job.width, job.vcodec) == (1920, "avc1.640028")
    assert job.codecs == "avc1.640028,mp4a.40.2"


async def test_fetch_errors(t, yt, ffmpeg):
    yt.fail(f"resolve:{YT}", stderr="WARNING: x\nERROR: Sign in to confirm your age\n\n")
    with pytest.raises(RuntimeError) as e:
        await t._fetch(tr.Job(YT, t.root))
    assert str(e.value) == "yt-dlp: ERROR: Sign in to confirm your age"
    yt.heal(f"resolve:{YT}")
    yt.update(YT, duration=tr.MAX_DURATION + 1)
    with pytest.raises(RuntimeError) as e:
        await t._fetch(tr.Job(YT, t.root))
    assert str(e.value) == f"too long for a trailer ({tr.MAX_DURATION + 1} s)"
    yt.update(YT, duration=tr.MAX_DURATION, requested=["137"])
    with pytest.raises(RuntimeError) as e:
        await t._fetch(tr.Job(YT, t.root))
    assert str(e.value) == "no separate video + audio streams offered"


async def test_fetch_zero_duration_is_unknown(t, yt, ffmpeg):
    yt.update(YT, duration=0)
    job = tr.Job(YT, t.root)
    await t._fetch(job)
    assert job.duration is None


@pytest.mark.parametrize("which, fid", [("video", "313"), ("audio", "140")])
async def test_fetch_download_failure_names_the_stream(t, yt, ffmpeg, which, fid):
    yt.fail(f"download:{YT}:{fid}", stderr="ERROR: fragment 9 not found\n", after=True)
    with pytest.raises(RuntimeError) as e:
        await t._fetch(tr.Job(YT, t.root))
    assert str(e.value) == f"{which}: ERROR: fragment 9 not found"


async def test_fetch_muxer_failure_and_unfinished_playlist(t, yt, ffmpeg):
    ffmpeg("fail")
    with pytest.raises(RuntimeError) as e:
        await t._fetch(tr.Job(YT, t.root))
    assert str(e.value) == "ffmpeg: pipe:0: Invalid data found when processing input"
    ffmpeg("partial")
    job = tr.Job(YT, t.root)
    with pytest.raises(RuntimeError) as e:
        await t._fetch(job)
    assert str(e.value) == "playlist not finished"
    assert (job.dir / "info.json").exists()  # only a finished fetch removes it


async def test_fetch_without_ffmpeg(t, yt, monkeypatch):
    real = tr.shutil.which
    monkeypatch.setattr(tr.shutil, "which", lambda n: None if n == "ffmpeg" else real(n))
    with pytest.raises(RuntimeError, match="^ffmpeg not on PATH$"):
        await t._fetch(tr.Job(YT, t.root))


async def test_fetch_starts_from_an_empty_dir(t, yt, ffmpeg):
    job = tr.Job(YT, t.root)
    job.dir.mkdir(parents=True)
    (job.dir / "s009.m4s").write_bytes(b"stale")
    await t._fetch(job)
    assert not (job.dir / "s009.m4s").exists()


def test_ytdlp_command_and_missing(t, monkeypatch):
    monkeypatch.setattr(tr.shutil, "which", lambda n: "/opt/yt-dlp" if n == "yt-dlp" else None)
    assert t._ytdlp() == ["/opt/yt-dlp", "--no-cache-dir", "--no-warnings", "--no-playlist", "--quiet"]
    monkeypatch.setattr(tr.shutil, "which", lambda n: None)
    with pytest.raises(RuntimeError, match="^yt-dlp not on PATH$"):
        t._ytdlp()


# ---------------------------------------------------------------- _run


async def test_run_returns_code_and_output():
    rc, out, err = await tr._run(sys.executable, "-c", "import sys; print('o'); sys.stderr.write('e'); sys.exit(4)",
                                 timeout=30)
    assert (rc, out, err) == (4, b"o\n", b"e")


async def test_run_timeout_kills_the_process(tmp_path):
    marker = tmp_path / "pid"
    code = f"import os, time; open({str(marker)!r}, 'w').write(str(os.getpid())); time.sleep(60)"
    t0 = time.monotonic()
    with pytest.raises(asyncio.TimeoutError):
        await tr._run(sys.executable, "-c", code, timeout=1)
    assert time.monotonic() - t0 < 10
    pid = int(marker.read_text())
    assert not Path(f"/proc/{pid}").exists() or Path(f"/proc/{pid}/stat").read_text().split(")")[1].split()[0] == "Z"


# ---------------------------------------------------------------- _work


async def test_work_marks_done_with_the_metadata(t, monkeypatch):
    evicted = []

    async def fetch(job):
        job.dir.mkdir(parents=True, exist_ok=True)
        job.duration, job.title, job.width, job.height = 95, "T", 3840, 2160
        job.vcodec, job.codecs, job.hdr, job.subs = "vp9.2", "vp09.02.51.10,opus", "HDR10", {"lang": "en", "kind": "auto"}

    monkeypatch.setattr(t, "_fetch", fetch)
    monkeypatch.setattr(t, "_evict", lambda: evicted.append(1))
    job = tr.Job(YT, t.root)
    await t._work(job)
    assert job.state == "ready" and evicted == [1] and job.ended_at is not None
    assert json.loads((job.dir / "done").read_text()) == {
        "v": tr.CACHE_VERSION, "duration": 95, "title": "T", "width": 3840, "height": 2160,
        "vcodec": "vp9.2", "codecs": "vp09.02.51.10,opus", "hdr": "HDR10", "subs": {"lang": "en", "kind": "auto"}}
    again = t._from_disk(YT, tr.MAX_HEIGHT)
    assert (again.hdr, again.subs, again.state, again.subs_done) == ("HDR10", {"lang": "en", "kind": "auto"},
                                                                      "ready", True)


@pytest.mark.parametrize("exc, want", [(RuntimeError("yt-dlp: ERROR: x"), "yt-dlp: ERROR: x"), (KeyError(), "KeyError")])
async def test_work_failure_is_the_jobs_answer(t, monkeypatch, caplog, exc, want):
    async def fetch(job):
        job.dir.mkdir(parents=True, exist_ok=True)
        (job.dir / "s000.m4s").write_bytes(b"x")
        raise exc

    monkeypatch.setattr(t, "_fetch", fetch)
    job = tr.Job(YT, t.root, 720)
    await t._work(job)
    assert (job.state, job.error) == ("error", want)
    assert not job.dir.exists() and job.ended_at is not None
    assert msgs(caplog) == [f"trailer {YT}@720: {want}"]


async def test_work_times_out(t, monkeypatch):
    monkeypatch.setattr(tr, "JOB_TIMEOUT", 0.05)

    async def fetch(job):
        await asyncio.sleep(10)

    monkeypatch.setattr(t, "_fetch", fetch)
    job = tr.Job(YT, t.root)
    await t._work(job)
    assert (job.state, job.error) == ("error", "TimeoutError")


async def test_work_runs_at_most_max_running_at_once(t, monkeypatch):
    running, peak = [0], [0]
    gate = asyncio.Event()

    async def fetch(job):
        running[0] += 1
        peak[0] = max(peak[0], running[0])
        await gate.wait()
        running[0] -= 1
        job.dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(t, "_fetch", fetch)
    jobs = [tr.Job(f"fastTrailr{i}", t.root) for i in range(4)]
    tasks = [asyncio.create_task(t._work(j)) for j in jobs]
    for _ in range(20):
        await asyncio.sleep(0)
    assert running[0] == tr.MAX_RUNNING
    gate.set()
    await asyncio.gather(*tasks)
    assert peak[0] == tr.MAX_RUNNING and all(j.state == "ready" for j in jobs)


async def test_start_retries_an_error_only_after_error_ttl(t, monkeypatch):
    monkeypatch.setattr(tr, "time", type("T", (), {"monotonic": staticmethod(lambda: 1000.0)}))
    started = []

    async def work(job):
        started.append(job)

    monkeypatch.setattr(t, "_work", work)
    job = t.start(YT)
    job.state, job.ended_at = "error", None  # never ended: counts from 0
    assert t.start(YT) is not job  # 1000 s since "0" > ERROR_TTL
    await asyncio.sleep(0)
    assert len(started) == 2
    job2 = t.jobs[YT]
    job2.state, job2.ended_at = "error", 1000.0 - tr.ERROR_TTL
    assert t.start(YT) is job2  # exactly ERROR_TTL: not yet


def test_start_rejects_a_bad_key(t):
    with pytest.raises(ValueError) as e:
        t.start("nope")
    assert str(e.value) == "not a trailer key: nope"


# ---------------------------------------------------------------- _subs


def info(**kw):
    return {"language": "en", **kw}


def vtt_track(url):
    return [{"ext": "srv3", "url": url + "&fmt=srv3"}, {"ext": "vtt", "url": url}]


def json3_track(url):
    return [{"ext": "vtt", "url": url + "&fmt=vtt"}, {"ext": "json3", "url": url}]


VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n"
J3 = {"events": [{"tStartMs": 0, "dDurationMs": 1000, "segs": [{"utf8": "Hi"}]}]}


@pytest.fixture
def subs_job(t):
    job = tr.Job(YT, t.root)
    job.dir.mkdir(parents=True)
    return job


@pytest.mark.parametrize("tracks, picked", [
    ({"en-CA": "ca", "en-GB": "gb", "de": "de"}, "gb"),
    ({"en-CA": "ca", "en-AU": "au"}, "au"),
    ({"en": "en", "en-US": "us"}, "en"),
    ({"en-US": "us", "en-GB": "gb"}, "gb"),
    ({"english": "x", "fr": "fr"}, None),
])
async def test_subs_manual_track_choice(t, subs_job, upstream, tracks, picked):
    routes = {}
    for lang, tag in tracks.items():
        routes[tag] = upstream.get(f"{CAPS}?v={YT}&lang={lang}").respond(200, text=VTT)
    subtitles = {lang: vtt_track(f"{CAPS}?v={YT}&lang={lang}") for lang in tracks}
    await t._subs(subs_job, info(subtitles=subtitles))
    assert subs_job.subs_done is True
    if picked is None:
        assert subs_job.subs is None and not any(r.called for r in routes.values())
    else:
        assert [tag for tag, r in routes.items() if r.called] == [picked]
        assert subs_job.subs == {"lang": "en", "kind": "manual"}
        assert (subs_job.dir / "subs.vtt").read_text() == VTT


async def test_subs_manual_without_vtt_falls_to_auto(t, subs_job, upstream):
    upstream.get(f"{CAPS}?v={YT}&kind=asr").respond(200, json=J3)
    await t._subs(subs_job, info(subtitles={"en": [{"ext": "srv3", "url": f"{CAPS}?srv3"}]},
                                 automatic_captions={"en": json3_track(f"{CAPS}?v={YT}&kind=asr")}))
    assert subs_job.subs == {"lang": "en", "kind": "auto"}
    assert (subs_job.dir / "subs.vtt").read_text() == "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHi\n"


async def test_subs_manual_with_a_bom_is_kept_and_junk_is_not(t, subs_job, upstream):
    route = upstream.get(f"{CAPS}?v={YT}&lang=en")
    route.respond(200, text="﻿" + VTT)
    await t._subs(subs_job, info(subtitles={"en": vtt_track(f"{CAPS}?v={YT}&lang=en")}))
    assert subs_job.subs == {"lang": "en", "kind": "manual"}
    other = tr.Job("fastTrailr2", t.root)
    other.dir.mkdir(parents=True)
    route.respond(200, text="<html>consent</html>")
    await t._subs(other, info(subtitles={"en": vtt_track(f"{CAPS}?v={YT}&lang=en")}))
    assert other.subs is None and not (other.dir / "subs.vtt").exists() and other.subs_done


@pytest.mark.parametrize("auto, language, kind", [
    ({"en-orig": "orig", "en": "en"}, "en", "auto"),
    ({"en-orig": "orig"}, "de", "auto"),           # en-orig is the original track whatever the language
    ({"en": "en"}, "de", "translated"),             # YouTube's machine translation
    ({"en": "en"}, None, "auto"),                   # no language: assume English
    ({"en": "en"}, "en-US", "auto"),
])
async def test_subs_auto_caption_kinds(t, subs_job, upstream, auto, language, kind):
    routes = {tag: upstream.get(f"{CAPS}?v={YT}&tlang={lang}").respond(200, json=J3)
              for lang, tag in auto.items()}
    caps = {lang: json3_track(f"{CAPS}?v={YT}&tlang={lang}") for lang in auto}
    data = {"automatic_captions": caps}
    if language:
        data["language"] = language
    else:
        data = {"automatic_captions": caps}
    await t._subs(subs_job, data)
    assert subs_job.subs == {"lang": "en", "kind": kind}
    assert [tag for tag, r in routes.items() if r.called] == [next(iter(auto.values()))]


async def test_subs_empty_json3_writes_nothing(t, subs_job, upstream):
    upstream.get(f"{CAPS}?v={YT}&kind=asr").respond(200, json={"events": []})
    await t._subs(subs_job, info(automatic_captions={"en": json3_track(f"{CAPS}?v={YT}&kind=asr")}))
    assert subs_job.subs is None and not (subs_job.dir / "subs.vtt").exists() and subs_job.subs_done


async def test_subs_without_any_track(t, subs_job):
    await t._subs(subs_job, info(automatic_captions={"de": json3_track(f"{CAPS}?de")}))
    assert subs_job.subs is None and subs_job.subs_done


async def test_subs_failure_only_logs(t, subs_job, upstream, caplog):
    caplog.set_level(logging.INFO, logger="reel_api")
    upstream.get(f"{CAPS}?v={YT}&lang=en").respond(500)
    await t._subs(subs_job, info(subtitles={"en": vtt_track(f"{CAPS}?v={YT}&lang=en")}))
    assert subs_job.subs is None and subs_job.subs_done
    (m,) = msgs(caplog)
    assert m.startswith(f"trailer {YT}: no subtitles (") and "500" in m


# ---------------------------------------------------------------- helper edges


def test_cache_root_defaults_to_tmp(reel_env, monkeypatch):
    monkeypatch.delenv("CACHE_DIRECTORY")
    monkeypatch.delenv("TMPDIR")
    assert tr._cache_root() == Path("/tmp/reel-api-cache/trailers")


def test_json3_skips_append_events_and_segless_parts():
    data = {"events": [
        {"tStartMs": 0, "dDurationMs": 2000, "segs": [{"utf8": "One "}, {}, {"utf8": "line"}]},
        {"tStartMs": 1000, "aAppend": 1, "segs": [{"utf8": "\n"}]},
        {"tStartMs": 1500},
        {"tStartMs": 3000, "segs": [{"utf8": "Two"}]},
    ]}
    assert tr._json3_to_vtt(data) == ("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nOne line\n\n"
                                      "00:00:03.000 --> 00:00:06.000\nTwo\n")


@pytest.mark.parametrize("acodec, want", [("ec-3", "ec-3"), ("EC-3", "ec-3"), ("ac-3", "ac-3"), ("AC-3", "ac-3")])
def test_audio_codec_dashed_names(acodec, want):
    assert tr.mse_audio_codec({"acodec": acodec}) == want


@pytest.mark.parametrize("vcodec", ["av01.0.12M.10", "avc1.640028", "vp09.00.51.08", "hev1.1.6.L150.90",
                                    "hvc1.2.4.L153.B0"])
def test_full_rfc6381_video_strings_pass_through(vcodec):
    assert tr.mse_video_codec({"vcodec": vcodec, "height": 2160, "dynamic_range": "HDR10"}) == vcodec


def test_job_keeps_its_height_and_playlist_precision(t):
    job = tr.Job(YT, t.root, 720)
    assert job.max_height == 720 and job.key == f"{YT}@720"
    job.dir.mkdir(parents=True)
    (job.dir / "index.m3u8").write_text("#EXTM3U\n#EXTINF:1.00049,\ns000.m4s\n#EXTINF:2.00002,\ns001.m4s\n")
    assert job.playlist() == (2, 3.001, False)


def test_evict_stops_at_exactly_the_cap(t, monkeypatch):
    for i, mtime in ((0, 100), (1, 200), (2, 300)):
        d = t.root / f"fastTrailr{i}"
        d.mkdir(parents=True)
        (d / "done").write_text("{}")
        (d / "s000.m4s").write_bytes(b"x" * 98)
        import os
        os.utime(d, (mtime, mtime))
    monkeypatch.setattr(tr, "CACHE_MAX_BYTES", 200)
    t._evict()
    assert sorted(p.name for p in t.root.iterdir()) == ["fastTrailr1", "fastTrailr2"]


def test_evict_tolerates_a_dir_vanishing(t, monkeypatch):
    d = t.root / "fastTrailr0"
    d.mkdir(parents=True)
    (d / "done").write_text("{}")
    (d / "s000.m4s").write_bytes(b"x" * 10)
    monkeypatch.setattr(tr, "CACHE_MAX_BYTES", 0)
    real = tr.shutil.rmtree

    def rmtree(p, ignore_errors=False):
        real(p)
        if not ignore_errors:
            raise FileNotFoundError(p)

    monkeypatch.setattr(tr.shutil, "rmtree", rmtree)
    t._evict()
    assert not d.exists()


async def test_m3u8_gets_one_start_tag_and_no_store(api, reel_env):
    t = api.app_module.trailers
    job = tr.Job(YT, t.root)
    job.dir.mkdir(parents=True)
    (job.dir / "done").write_text(json.dumps({"v": tr.CACHE_VERSION}))
    (job.dir / "index.m3u8").write_text("#EXTM3U\n#EXTINF:4.0,\ns000.m4s\n#EXTM3U\n")
    (job.dir / "s000.m4s").write_bytes(b"seg")
    r = await api.get(f"/api/trailers/{YT}/index.m3u8")
    assert r.text.count("#EXT-X-START") == 1
    assert r.headers["cache-control"] == "no-store"
    r = await api.get(f"/api/trailers/{YT}/s000.m4s")
    assert r.headers["cache-control"] == "max-age=86400"
