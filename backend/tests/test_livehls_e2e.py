"""livehls pipeline end to end: a growing download remuxed by the real
ffmpeg into an HLS event playlist of fMP4 segments, served over HTTP.

Real time, real subprocesses; livehls.PIECE_POLL is shortened so the
frontier waits take milliseconds. Tests of the give-up timers (120 s / 180 s
/ STALL_GIVE_UP_S) and of the reaper run on a FakeClock instead.
"""

from __future__ import annotations

import asyncio
import os
import re
import stat
import subprocess

import httpx
import pytest

from reel_api import livehls
from tests.support.clock import _Proxy
from tests.support.growing import GrowingFile
from tests.support.hls import check_playlist
from tests.support.media import FFMPEG, Audio, Spec, cbr, ffprobe, make_media
from tests.support.qbit import make_hash

MiB = 1 << 20
SEGMENT = re.compile(r"^s\d{5}\.m4s$")

# The whole module is slow: most tests share a 20 s generated film and real
# ffmpeg/ffprobe runs; the few that don't are cheap and live here for context.
pytestmark = pytest.mark.slow


async def until(cond, timeout: float = 30.0, what: str = "condition"):
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not cond():
        if loop.time() > end:
            raise AssertionError(f"timed out waiting for {what}")
        await asyncio.sleep(0.01)


@pytest.fixture(autouse=True)
def quick_poll(monkeypatch):
    monkeypatch.setattr(livehls, "PIECE_POLL", 0.01)


@pytest.fixture(scope="module")
def film(media_dir):
    """~20 MB, 20 s: H.264 High CBR 8 Mbit/s with a 2 s GOP (so ~4 HLS segments);
    audio 1 E-AC-3 5.1 eng (default), 2 AC-3 2.0 ger, 3 FLAC 5.1 fra."""
    from tests.conftest import _need_ffmpeg

    _need_ffmpeg()
    return make_media(media_dir / "film.mkv", Spec(
        duration=20, extra=["-preset", "veryfast"] + cbr("8M") + ["-g", "48"],  # High profile
        audio=(Audio("eac3", 6, "eng", default=True), Audio("ac3", 2, "ger"), Audio("flac", 6, "fra")),
    ))


@pytest.fixture
def download(qbit, tmp_path, film):
    """The film as a single-file torrent, 1 MiB pieces, nothing downloaded yet.
    `grow(rate)` starts a background 'download' of `rate` bytes every 10 ms."""
    data = film.read_bytes()
    g = GrowingFile(tmp_path / "incomplete" / "Film.2026.mkv", data, piece_size=MiB // 4)
    h = make_hash("film")
    t = qbit.add_growing(h, g)
    tasks = []

    class D:
        pass

    d = D()
    d.hash, d.g, d.t, d.data = h, g, t, data

    def grow(rate: int = 2 * MiB, upto: int | None = None):
        async def run():
            have = 0
            stop = len(data) if upto is None else upto
            while have < stop:
                have = min(stop, have + rate)
                g.grow_to(have)
                await asyncio.sleep(0.01)

        tasks.append(asyncio.create_task(run()))
        return tasks[-1]

    d.grow = grow
    yield d
    for task in tasks:
        task.cancel()


def job_of(h: str, audio: int) -> livehls.Job:
    return livehls.live.jobs[f"{h}:{audio}"]


def avc1_from_sps(path) -> str:
    """The RFC 6381 avc1.PPCCLL string from the source's actual SPS NAL
    (profile_idc, constraint flags, level_idc), extracted with ffmpeg."""
    raw = subprocess.run(
        [FFMPEG, "-v", "error", "-i", str(path), "-map", "0:v:0", "-c:v", "copy", "-frames:v", "1",
         "-bsf:v", "h264_mp4toannexb", "-f", "h264", "-"],
        check=True, capture_output=True, timeout=30).stdout
    i = raw.index(b"\x00\x00\x01\x67") + 4  # first SPS (nal_unit_type 7)
    return "avc1." + raw[i:i + 3].hex().upper()


# ---------------------------------------------------------------- the happy path


@pytest.mark.slow
@pytest.mark.ffmpeg
async def test_growing_download_becomes_a_served_hls_event_playlist(api, qbit, download, film, tmp_path):
    h = download.hash
    download.g.grow_to(MiB)  # only the start is in when the phone asks
    r = await api.post(f"/api/downloads/{h}/hls", params={"audio": 1})
    assert r.status_code == 200 and r.json()["state"] == "probing"
    job = job_of(h, 1)

    states = []
    download.grow(rate=MiB)

    def watch():
        if not states or states[-1] != job.state:
            states.append(job.state)
        return job.state in ("done", "error")

    await until(watch, what="job to finish")
    assert job.error is None, job.error
    assert states[0] == "probing" and states[-1] == "done" and "remuxing" in states

    st = (await api.get(f"/api/downloads/{h}/hls", params={"audio": 1})).json()
    assert st["state"] == "done" and st["complete"] is True and st["progress"] == 1.0
    assert st["codecs"] == f"{avc1_from_sps(film)},ec-3"
    assert st["codecs"].startswith("avc1.6400")  # High, no constraint flags
    assert st["video"] == {"codec": "h264", "width": 320, "height": 180, "dv_profile": None}
    assert st["audio_codec"] == "eac3"
    assert st["duration"] == pytest.approx(20.0, abs=0.2)
    assert st["segments"] >= 3
    assert st["buffered_s"] == pytest.approx(20.0, abs=0.5)

    r = await api.get(f"/api/downloads/{h}/hls/1/index.m3u8")
    assert r.status_code == 200
    segs = check_playlist(r.text, complete=True, segment=SEGMENT)
    names = [n for n, _ in segs]
    assert len(names) == st["segments"] and names[0] == "s00000.m4s"
    assert all(livehls.FILE.fullmatch(n) for n in names)
    assert sum(d for _, d in segs) == pytest.approx(st["buffered_s"], abs=0.01)

    remux = tmp_path / "remux.mp4"
    with open(remux, "wb") as out:
        for name in ["init.mp4", *names]:
            r = await api.get(f"/api/downloads/{h}/hls/1/{name}")
            assert r.status_code == 200, name
            assert r.content == (job.dir / name).read_bytes()
            out.write(r.content)
    p = ffprobe(remux)
    assert [(s["codec_type"], s["codec_name"]) for s in p["streams"]] == [("video", "h264"), ("audio", "eac3")]
    assert next(s for s in p["streams"] if s["codec_type"] == "audio")["channels"] == 6
    assert float(p["format"]["duration"]) == pytest.approx(20.0, abs=0.5)


@pytest.mark.slow
@pytest.mark.ffmpeg
async def test_playlist_stays_open_while_the_download_grows(api, qbit, download):
    """While the file is still coming in, the served playlist is a valid
    *open* EVENT playlist — no #EXT-X-ENDLIST (a player would take it for the
    whole film and stop there) — whose segments only ever get appended: the
    finished playlist starts with exactly the segments served before."""
    h = download.hash
    half = len(download.data) * 6 // 10
    download.g.grow_to(half)
    await api.post(f"/api/downloads/{h}/hls", params={"audio": 1})
    job = job_of(h, 1)
    await until(lambda: job.playlist()[0] >= 1 and job.state == "remuxing", what="a first segment")
    await until(lambda: len(qbit.called("/torrents/pieceStates")) > 3, what="the remux at the frontier")
    r = await api.get(f"/api/downloads/{h}/hls/1/index.m3u8")
    assert r.status_code == 200
    early = check_playlist(r.text, complete=False, segment=SEGMENT)
    assert job.status()["complete"] is False

    download.grow()
    await asyncio.wait_for(job.task, 60)
    assert job.state == "done", job.error
    r = await api.get(f"/api/downloads/{h}/hls/1/index.m3u8")
    final = check_playlist(r.text, complete=True, segment=SEGMENT)
    assert len(final) > len(early) and final[:len(early)] == early


@pytest.mark.slow
@pytest.mark.ffmpeg
async def test_flac_51_is_converted_to_ac3(api, qbit, download, tmp_path):
    h = download.hash
    download.g.complete()
    await api.post(f"/api/downloads/{h}/hls", params={"audio": 3})
    job = job_of(h, 3)
    await asyncio.wait_for(job.task, 60)
    assert job.state == "done", job.error
    assert job.codecs.endswith(",ac-3") and job.audio_out == "ac3"
    remux = tmp_path / "remux.mp4"
    remux.write_bytes((job.dir / "init.mp4").read_bytes() + (job.dir / "s00000.m4s").read_bytes())
    a = next(s for s in ffprobe(remux)["streams"] if s["codec_type"] == "audio")
    assert a["codec_name"] == "ac3" and a["channels"] == 6 and int(a["bit_rate"]) == 640_000


# ---------------------------------------------------------------- one job per download


@pytest.mark.slow
@pytest.mark.ffmpeg
async def test_another_audio_track_replaces_the_running_job(api, qbit, download):
    h = download.hash
    download.g.grow_to(10 * MiB)  # header in; the rest comes later
    await api.post(f"/api/downloads/{h}/hls", params={"audio": 1})
    first = job_of(h, 1)
    await until(lambda: first.state == "remuxing" and first.proc is not None and first.progress is not None,
                what="first job to remux")
    proc = first.proc

    r = await api.post(f"/api/downloads/{h}/hls", params={"audio": 2})
    assert r.status_code == 200 and r.json()["audio"] == 2
    assert f"{h}:1" not in livehls.live.jobs
    await until(lambda: first.task.done(), what="first job to stop")
    assert first.task.cancelled()
    await asyncio.wait_for(proc.wait(), 10)  # its ffmpeg was killed, not left running
    assert proc.returncode != 0
    assert not first.dir.exists()
    assert (await api.get(f"/api/downloads/{h}/hls", params={"audio": 1})).status_code == 404

    second = job_of(h, 2)
    download.grow()
    await asyncio.wait_for(second.task, 60)
    assert second.state == "done", second.error
    assert second.codecs.endswith(",ac-3") and second.audio_out == "ac3"  # AC-3 2.0 is copied


# ---------------------------------------------------------------- the torrent leaves the client


@pytest.mark.slow
@pytest.mark.ffmpeg
async def test_torrent_leaving_mid_download_is_an_error(api, qbit, download):
    h = download.hash
    download.g.grow_to(10 * MiB)
    await api.post(f"/api/downloads/{h}/hls", params={"audio": 1})
    job = job_of(h, 1)
    await until(lambda: job.state == "remuxing" and job.progress is not None, what="remux at the frontier")
    assert job.progress < 0.999
    proc = job.proc
    del qbit.torrents[h]  # removed from qBittorrent (cancelled, or deleted by hand)
    await asyncio.wait_for(job.task, 30)
    assert job.state == "error" and job.error == "the download left the queue"
    await asyncio.wait_for(proc.wait(), 10)
    st = (await api.get(f"/api/downloads/{h}/hls", params={"audio": 1})).json()
    assert st["state"] == "error" and st["error"] == "the download left the queue" and st["complete"] is False


@pytest.mark.slow
@pytest.mark.ffmpeg
async def test_torrent_leaving_after_99_9_percent_finishes(api, qbit, download):
    """Imported: the last piece is on disk but its state never reached 'done'
    before qBittorrent dropped the torrent. >= 99.9 % counts as complete, the
    remux reads the rest of the file and finishes."""
    g = GrowingFile(download.g.path.with_name("Film.small-pieces.mkv"), download.data, piece_size=16 * 1024)
    h = make_hash("film-small-pieces")
    qbit.add_growing(h, g)
    assert g.n_pieces >= 1000
    g.complete()
    g.states[-1] = 1  # bytes written, piece not yet reported
    await api.post(f"/api/downloads/{h}/hls", params={"audio": 1})
    job = job_of(h, 1)
    n0 = len(qbit.called("/torrents/pieceStates"))
    await until(lambda: job.state == "remuxing" and len(qbit.called("/torrents/pieceStates")) > n0 + 3,
                what="remux waiting on the last piece")
    assert job.progress >= 0.999
    del qbit.torrents[h]
    await asyncio.wait_for(job.task, 60)
    assert job.state == "done", job.error
    assert job.status()["complete"] is True


# ---------------------------------------------------------------- parked torrents, cache root


@pytest.mark.slow
@pytest.mark.ffmpeg
@pytest.mark.parametrize("state", ["queuedDL", "stoppedDL", "pausedDL", "stalledDL"])
async def test_parked_torrent_is_force_started(api, qbit, download, state):
    h = download.hash
    download.t.state = state
    download.g.complete()
    await api.post(f"/api/downloads/{h}/hls")
    await asyncio.wait_for(job_of(h, -1).task, 60)
    assert qbit.called("/torrents/setForceStart") == [{"hashes": h, "value": "true"}]
    assert job_of(h, -1).state == "done"


@pytest.mark.ffmpeg
async def test_force_start_failure_is_not_fatal(api, qbit, download, monkeypatch):
    h = download.hash
    download.t.state = "pausedDL"
    download.g.grow_to(MiB)
    qbit.fail("/torrents/setForceStart", exc=httpx.ConnectError("refused"))
    reached = asyncio.Event()

    async def stop_at_probe(self, qb, job, info):
        reached.set()
        raise RuntimeError("stop here")

    monkeypatch.setattr(livehls.LiveHls, "_probe", stop_at_probe)
    await api.post(f"/api/downloads/{h}/hls")
    await asyncio.wait_for(reached.wait(), 10)
    assert len(qbit.called("/torrents/setForceStart")) == 1


async def test_first_start_clears_only_the_livehls_cache_root(api, qbit, reel_env):
    root = reel_env.cache / "livehls"
    (root / "stale-1").mkdir(parents=True)
    (root / "stale-1" / "s00000.m4s").write_bytes(b"old")
    (reel_env.cache / "trailers").mkdir()
    (reel_env.cache / "trailers" / "keep.mp4").write_bytes(b"keep")
    (reel_env.state / "keep.json").write_text("{}")

    await api.post(f"/api/downloads/{make_hash('a')}/hls")
    assert not (root / "stale-1").exists()
    assert (reel_env.cache / "trailers" / "keep.mp4").read_bytes() == b"keep"
    assert (reel_env.state / "keep.json").exists()

    # only the first start: a later one leaves what is there
    (root / "later").mkdir(parents=True)
    await api.post(f"/api/downloads/{make_hash('b')}/hls")
    assert (root / "later").exists()


# ---------------------------------------------------------------- failures inside the pipeline


async def test_unknown_download_is_an_error(api, qbit):
    h = make_hash("ghost")
    await api.post(f"/api/downloads/{h}/hls")
    await asyncio.wait_for(job_of(h, -1).task, 10)
    assert job_of(h, -1).error == "no such download"


@pytest.fixture
async def parked_reaper(monkeypatch):
    """A placeholder reaper so start() neither clears the root nor spawns the
    real one (which would race through virtual time on an auto FakeClock).
    The give-up timers are counted in PIECE_POLL steps: use the real value."""
    monkeypatch.setattr(livehls, "PIECE_POLL", 1.0)
    holder = asyncio.get_running_loop().create_future()
    livehls.live.reaper = holder
    yield
    holder.cancel()


@pytest.mark.ffmpeg
async def test_download_that_never_starts_gives_up_after_120s(monkeypatch, clock, api, qbit, download,
                                                              parked_reaper):
    clock.install(monkeypatch, livehls)
    download.t.files = []  # no metadata yet: NotReady forever
    await api.post(f"/api/downloads/{download.hash}/hls")
    job = job_of(download.hash, -1)
    await asyncio.wait_for(job.task, 10)
    assert job.state == "error" and job.error == "the download has not started yet"
    assert 120 < sum(clock.sleeps) <= 124 and set(clock.sleeps) == {2}


@pytest.mark.ffmpeg
async def test_header_that_never_arrives_gives_up_after_180s(monkeypatch, clock, api, qbit, download,
                                                             parked_reaper):
    clock.install(monkeypatch, livehls)
    download.g.grow_to(livehls.HEADER_BYTES - MiB)
    await api.post(f"/api/downloads/{download.hash}/hls")
    job = job_of(download.hash, -1)
    await asyncio.wait_for(job.task, 10)
    assert job.state == "error" and job.error == "the start of the file has not downloaded yet"
    assert 180 < sum(clock.sleeps) <= 181


@pytest.mark.ffmpeg
async def test_piece_state_failures_while_probing_are_retried(api, qbit, download, monkeypatch):
    download.g.complete()
    qbit.fail("/torrents/pieceStates", status=500, body="busy", times=3)
    probed = asyncio.Event()
    real_args = livehls.LiveHls._ffmpeg_args

    def stop_after_probe(self, job, data):
        probed.set()
        real_args(self, job, data)
        raise RuntimeError("stop here")

    monkeypatch.setattr(livehls.LiveHls, "_ffmpeg_args", stop_after_probe)
    await api.post(f"/api/downloads/{download.hash}/hls")
    job = job_of(download.hash, -1)
    await asyncio.wait_for(job.task, 30)
    assert probed.is_set() and job.duration == pytest.approx(20.0, abs=0.2)
    assert len(qbit.called("/torrents/pieceStates")) >= 4


@pytest.mark.slow
@pytest.mark.ffmpeg
async def test_frontier_frozen_with_nobody_watching_stops_the_job(monkeypatch, clock, api, qbit, download,
                                                                  parked_reaper):
    clock.install(monkeypatch, livehls)
    download.g.grow_to(10 * MiB)
    await api.post(f"/api/downloads/{download.hash}/hls")
    job = job_of(download.hash, -1)
    await asyncio.wait_for(job.task, 60)
    assert job.state == "error" and job.error == "the download stalled"
    assert sum(clock.sleeps) >= livehls.STALL_GIVE_UP_S
    await asyncio.wait_for(job.proc.wait(), 10)  # killed
    assert job.proc.returncode != 0


def fake_binary(tmp_path, name: str, script: str) -> str:
    p = tmp_path / "bin" / name
    p.parent.mkdir(exist_ok=True)
    p.write_text("#!/bin/sh\n" + script + "\n")
    p.chmod(p.stat().st_mode | stat.S_IXUSR)
    return str(p)


@pytest.mark.slow
@pytest.mark.ffmpeg
@pytest.mark.parametrize("script,error", [
    ('cat >/dev/null; echo "first line" >&2; echo "Invalid data found when processing input" >&2; exit 1',
     "ffmpeg: Invalid data found when processing input"),
    ("exit 3", "ffmpeg: exit 3"),  # dies before reading: the pipe breaks, the exit code is the answer
])
async def test_ffmpeg_failure_is_the_jobs_error(monkeypatch, api, qbit, download, tmp_path, script, error):
    exe = fake_binary(tmp_path, "ffmpeg", script)
    real_which = livehls.shutil.which
    monkeypatch.setattr(livehls, "shutil", _Proxy(livehls.shutil,
                                                  which=lambda n: exe if n == "ffmpeg" else real_which(n)))
    download.g.complete()
    await api.post(f"/api/downloads/{download.hash}/hls")
    job = job_of(download.hash, -1)
    await asyncio.wait_for(job.task, 30)
    assert job.state == "error" and job.error == error


@pytest.mark.ffmpeg
async def test_ffprobe_missing_is_the_jobs_error(monkeypatch, api, qbit, download):
    monkeypatch.setattr(livehls, "shutil", _Proxy(livehls.shutil, which=lambda n: None))
    download.g.complete()
    await api.post(f"/api/downloads/{download.hash}/hls")
    job = job_of(download.hash, -1)
    await asyncio.wait_for(job.task, 10)
    assert job.state == "error" and job.error == "ffprobe not on PATH"


@pytest.mark.slow
@pytest.mark.ffmpeg
async def test_unsupported_video_is_the_jobs_error(api, qbit, tmp_path, media_dir):
    from tests.conftest import _need_ffmpeg

    _need_ffmpeg()
    # a later -c:v wins: the H.264 encoder args are overridden by MPEG-4 Part 2
    src = make_media(media_dir / "mpeg4.mkv", Spec(audio=(Audio("aac"),), subs=(), extra=["-c:v", "mpeg4"]))
    g = GrowingFile(tmp_path / "dl" / "Old.avi.mkv", src.read_bytes())
    g.complete()
    h = make_hash("mpeg4")
    qbit.add_growing(h, g)
    await api.post(f"/api/downloads/{h}/hls")
    job = job_of(h, -1)
    await asyncio.wait_for(job.task, 30)
    assert job.state == "error" and job.error == "unsupported_video: mpeg4"
    assert job.video is None
    assert job.proc is None  # ffmpeg never started


# ---------------------------------------------------------------- the reaper


@pytest.mark.slow
@pytest.mark.ffmpeg
async def test_reaper_drops_a_job_idle_for_longer_than_idle_s(monkeypatch, manual_clock, api, qbit, download):
    manual_clock.install(monkeypatch, livehls)
    download.g.complete()  # the pipeline needs no sleeps: it finishes on the real clock
    await api.post(f"/api/downloads/{download.hash}/hls")
    job = job_of(download.hash, -1)
    await asyncio.wait_for(job.task, 60)
    assert job.state == "done" and job.dir.exists()
    await manual_clock.settle(20)
    assert manual_clock.pending_sleepers == 1  # the reaper

    for _ in range(livehls.IDLE_S // 60):  # 10 min of reaper rounds: still there
        await manual_clock.advance(60, settle=20)
    assert f"{download.hash}:-1" in livehls.live.jobs

    # a status request touches it: another full IDLE_S from now
    await api.get(f"/api/downloads/{download.hash}/hls")
    for _ in range(livehls.IDLE_S // 60):
        await manual_clock.advance(60, settle=20)
    assert f"{download.hash}:-1" in livehls.live.jobs
    await manual_clock.advance(60, settle=20)
    assert f"{download.hash}:-1" not in livehls.live.jobs
    assert not job.dir.exists()
    r = await api.get(f"/api/downloads/{download.hash}/hls/-1/index.m3u8")
    assert r.status_code == 404


async def test_reaper_caps_the_cache_oldest_idle_first(monkeypatch, manual_clock, reel_env):
    manual_clock.install(monkeypatch, livehls)
    monkeypatch.setattr(livehls, "CACHE_MAX_BYTES", 2500)
    live = livehls.live
    jobs = []
    for i, (age, size) in enumerate([(300, 1000), (200, 1000), (100, 1000), (30, 1000)]):
        j = livehls.Job(make_hash(f"cap{i}"), -1)
        j.dir.mkdir(parents=True)
        (j.dir / "s00000.m4s").write_bytes(bytes(size))
        j.touched = manual_clock.monotonic() + 60 - age  # age as of the first reaper round
        live.jobs[j.key] = j
        jobs.append(j)
    live.reaper = asyncio.create_task(live._reap())
    await manual_clock.settle(5)
    await manual_clock.advance(60, settle=20)
    # 4000 bytes > 2500: drop oldest-touched first, only those idle > 120 s -> two go
    assert [j.key in live.jobs for j in jobs] == [False, False, True, True]
    assert not jobs[0].dir.exists() and jobs[2].dir.exists()
    live.reaper.cancel()


async def test_reaper_never_drops_recent_jobs_for_the_cap(monkeypatch, manual_clock, reel_env):
    manual_clock.install(monkeypatch, livehls)
    monkeypatch.setattr(livehls, "CACHE_MAX_BYTES", 10)
    live = livehls.live
    j = livehls.Job(make_hash("recent"), -1)
    j.dir.mkdir(parents=True)
    (j.dir / "s00000.m4s").write_bytes(bytes(1000))
    live.jobs[j.key] = j
    j2 = livehls.Job(make_hash("no-dir"), -1)  # still probing: no files yet
    live.jobs[j2.key] = j2
    live.reaper = asyncio.create_task(live._reap())
    await manual_clock.settle(5)
    await manual_clock.advance(60, settle=20)
    assert j.key in live.jobs and j2.key in live.jobs
    live.reaper.cancel()
    assert os.path.isdir(j.dir)
