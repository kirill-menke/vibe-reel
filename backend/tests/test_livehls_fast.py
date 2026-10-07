"""livehls.py's pipeline steps without real media or a real ffmpeg — the fast
counterparts of tests/test_livehls_e2e.py (slow), added by the T41 mutation
pass: waiting for the file (_wait_file), the header wait + ffprobe (_probe,
with a stand-in ffprobe on PATH), the frontier-paced pipe into the muxer
(_remux, with a tiny Python stand-in for ffmpeg), the job wrapper (_run),
the reaper (_reap) and the exact ffmpeg command line.

Time is virtual (FakeClock on livehls); subprocesses are real but tiny."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import stat
import sys
from pathlib import Path

import pytest

from reel_api import livehls, streaming
from tests.support.clock import FakeClock, _Proxy
from tests.support.qbit import make_hash

GID = make_hash("livehls-fast")
KiB = 1024


def msgs(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.name == "reel_api"]


class FakeQb:
    """The qBittorrent calls livehls makes, scripted."""

    def __init__(self, states=None):
        self.states = states if states is not None else []
        self.state_calls: list[float] = []
        self.ps_error: Exception | None = None
        self.raw = {"state": "downloading"}
        self.raw_error: Exception | None = None
        self.forced: list[str] = []
        self.force_error: Exception | None = None
        self.clock: FakeClock | None = None
        self.on_states = None

    async def piece_states(self, gid):
        self.state_calls.append(self.clock.t if self.clock else 0.0)
        if self.on_states:
            self.on_states(self)
        if self.ps_error:
            raise self.ps_error
        return list(self.states)

    async def raw_info(self, gid):
        if self.raw_error:
            raise self.raw_error
        return self.raw

    async def force_start(self, gid):
        self.forced.append(gid)
        if self.force_error:
            raise self.force_error


@pytest.fixture
def clock(monkeypatch):
    return FakeClock().install(monkeypatch, livehls)


@pytest.fixture
def lh():
    return livehls.LiveHls()


def job(audio=1) -> livehls.Job:
    return livehls.Job(GID, audio)


# ---------------------------------------------------------------- _wait_file


def main_file(monkeypatch, answers):
    """streaming._main_file as seen from livehls: answers in order (an
    exception instance is raised); the last answer repeats."""
    calls = []

    async def fake(qb, gid):
        calls.append(gid)
        a = answers[min(len(calls) - 1, len(answers) - 1)]
        if isinstance(a, BaseException):
            raise a
        return a

    monkeypatch.setattr(livehls, "streaming", _Proxy(streaming, _main_file=fake))
    return calls


INFO = {"path": "/x.mkv", "size": 10, "offset": 0, "piece_size": 4, "state": "downloading"}


async def test_wait_file_polls_every_2_s_until_metadata(lh, clock, monkeypatch):
    nr = streaming.NotReady("metadata")
    calls = main_file(monkeypatch, [nr, nr, INFO])
    qb = FakeQb()
    assert await lh._wait_file(qb, job()) is INFO
    assert clock.sleeps == [2, 2] and calls == [GID] * 3
    assert qb.forced == []  # downloading: nothing to force


async def test_wait_file_gives_up_after_120_s(lh, clock, monkeypatch):
    main_file(monkeypatch, [streaming.NotReady("metadata")])
    with pytest.raises(RuntimeError, match="^the download has not started yet$"):
        await lh._wait_file(FakeQb(), job())
    assert clock.sleeps == [2] * 61  # attempts at 0, 2, ..., 120 s; gives up after the one at 122 s
    assert clock.t - clock._t0 == 122


async def test_wait_file_unknown_download(lh, clock, monkeypatch):
    main_file(monkeypatch, [None])
    with pytest.raises(RuntimeError, match="^no such download$"):
        await lh._wait_file(FakeQb(), job())


@pytest.mark.parametrize("state", ["queuedDL", "stoppedDL", "pausedDL", "stalledDL"])
async def test_wait_file_force_starts_a_parked_download(lh, clock, monkeypatch, state):
    main_file(monkeypatch, [{**INFO, "state": state}])
    qb = FakeQb()
    await lh._wait_file(qb, job())
    assert qb.forced == [GID]


async def test_wait_file_force_start_failure_only_logs(lh, clock, monkeypatch, caplog):
    main_file(monkeypatch, [{**INFO, "state": "queuedDL"}])
    qb = FakeQb()
    qb.force_error = RuntimeError("qb said no")
    assert (await lh._wait_file(qb, job()))["state"] == "queuedDL"
    assert msgs(caplog) == [f"livehls {GID}:1: force-start failed: qb said no"]


# ---------------------------------------------------------------- _probe


FFPROBE = r'''
import json, os, sys
log = os.environ["FAKE_FFPROBE_LOG"]
open(log, "w").write(json.dumps(sys.argv[1:]))
sys.stdout.write(os.environ["FAKE_FFPROBE_OUT"])
'''


def fake_exe(directory: Path, name: str, body: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    p = directory / name
    p.write_text(f"#!{sys.executable}\n" + body)
    p.chmod(p.stat().st_mode | stat.S_IXUSR)
    return p


@pytest.fixture
def ffprobe(tmp_path, monkeypatch):
    exe = fake_exe(tmp_path / "bin", "ffprobe", FFPROBE)
    monkeypatch.setattr(livehls, "shutil", _Proxy(livehls.shutil, which=lambda n: str(exe) if n == "ffprobe" else None))
    monkeypatch.setenv("FAKE_FFPROBE_LOG", str(tmp_path / "ffprobe.argv"))

    def answer(data: dict):
        monkeypatch.setenv("FAKE_FFPROBE_OUT", json.dumps(data))

    answer({"format": {"duration": "12.5"}, "streams": []})
    answer.argv = lambda: json.loads((tmp_path / "ffprobe.argv").read_text())
    return answer


MiB = 1 << 20


async def test_probe_waits_for_the_first_header_bytes(lh, clock, ffprobe):
    """HEADER_BYTES (8 MiB) of the file, from its offset in the torrent:
    with 1 MiB pieces and the file starting half-way into piece 2, pieces
    2..10 must be there."""
    info = {"path": "/dl/Film.mkv", "size": 50 * MiB, "offset": 2 * MiB + MiB // 2, "piece_size": MiB}
    qb = FakeQb([2] * 10 + [1] + [2] * 5)
    qb.clock = clock

    def arrive(q):
        if len(q.state_calls) == 3:
            q.states[10] = 2

    qb.on_states = arrive
    j = job()
    data = await lh._probe(qb, j, info)
    assert len(qb.state_calls) == 3 and clock.sleeps == [livehls.PIECE_POLL] * 2
    assert j.duration == 12.5 and data["format"]["duration"] == "12.5"
    assert ffprobe.argv() == ["-v", "error", "-print_format", "json", "-show_format", "-show_streams",
                              "/dl/Film.mkv"]


async def test_probe_of_a_small_file_needs_only_its_pieces(lh, clock, ffprobe):
    ffprobe({"format": {}})
    info = {"path": "/dl/a.mkv", "size": 3 * MiB, "offset": 0, "piece_size": MiB}
    j = job()
    await lh._probe(FakeQb([2, 2, 2]), j, info)
    assert clock.sleeps == [] and j.duration is None


async def test_probe_counts_a_failing_piece_query_as_not_ready_and_gives_up(lh, clock, ffprobe):
    info = {"path": "/dl/a.mkv", "size": 3 * MiB, "offset": 0, "piece_size": MiB}
    qb = FakeQb([2, 2, 2])
    qb.ps_error = RuntimeError("qb hiccup")
    with pytest.raises(RuntimeError, match="^the start of the file has not downloaded yet$"):
        await lh._probe(qb, job(), info)
    assert 180 < clock.t - clock._t0 <= 180 + livehls.PIECE_POLL


async def test_probe_without_ffprobe(lh, clock, monkeypatch):
    monkeypatch.setattr(livehls, "shutil", _Proxy(livehls.shutil, which=lambda n: None))
    info = {"path": "/dl/a.mkv", "size": 3, "offset": 0, "piece_size": MiB}
    with pytest.raises(RuntimeError, match="^ffprobe not on PATH$"):
        await lh._probe(FakeQb([2]), job(), info)


# ---------------------------------------------------------------- _remux


MUXER = r'''
import os, sys
d, rc, err = sys.argv[1], int(sys.argv[2]), sys.argv[3]
data = sys.stdin.buffer.read()
open(os.path.join(d, "piped.bin"), "wb").write(data)
open(os.path.join(d, "index.m3u8"), "w").write("#EXTM3U\n#EXTINF:6.0,\ns00000.m4s\n#EXT-X-ENDLIST\n")
if err:
    sys.stderr.write(err)
sys.exit(rc)
'''


def muxer_args(j, rc=0, err=""):
    return [sys.executable, "-c", MUXER, str(j.dir), str(rc), err]


@pytest.fixture
def film(tmp_path):
    data = os.urandom(300 * KiB + 123)
    p = tmp_path / "dl" / "Film.mkv"
    p.parent.mkdir()
    p.write_bytes(data)
    return p, data


def info_of(path, data, offset=0, piece=64 * KiB):
    return {"path": str(path), "size": len(data), "offset": offset, "piece_size": piece}


@pytest.fixture
def small_chunks(monkeypatch):
    monkeypatch.setattr(livehls, "READ_CHUNK", 32 * KiB)


async def test_remux_pipes_the_file_as_its_pieces_arrive(lh, clock, film, small_chunks):
    path, data = film
    off = 100 * KiB  # the file starts inside piece 1 of the torrent
    info = info_of(path, data, offset=off)
    n_pieces = (off + len(data) - 1) // info["piece_size"] + 1
    qb = FakeQb([2, 2] + [0] * (n_pieces - 2))
    qb.clock = clock

    def arrive(q):  # one more piece per query
        if 0 in q.states:
            q.states[q.states.index(0)] = 2

    qb.on_states = arrive
    j = job()
    await lh._remux(qb, j, info, muxer_args(j))
    assert (j.dir / "piped.bin").read_bytes() == data
    assert j.state == "remuxing" and j.progress == 1.0
    # never asked more than once per PIECE_POLL of (virtual) time
    gaps = [b - a for a, b in zip(qb.state_calls, qb.state_calls[1:])]
    assert gaps and min(gaps) >= livehls.PIECE_POLL


async def test_remux_progress_is_the_share_of_finished_pieces(lh, clock, film, small_chunks):
    path, data = film
    info = info_of(path, data)
    qb = FakeQb([2] + [1] * 3 + [0] * 4)
    qb.clock = clock
    seen = []

    def arrive(q):
        seen.append(j.progress)
        q.states = [2] * 8

    qb.on_states = arrive
    j = job()
    qb.states = [2, 1, 1, 0, 0, 0, 0, 0]
    await lh._remux(qb, j, info, muxer_args(j))
    assert seen[0] is None  # nothing known before the first answer


async def test_remux_progress_rounding(lh, clock, film, small_chunks):
    path, data = film
    info = info_of(path, data, piece=48 * KiB)  # 7 pieces
    qb = FakeQb([2, 0, 0, 0, 0, 0, 0])
    qb.clock = clock
    progress = []

    def arrive(q):
        progress.append(j.progress)
        if len(q.state_calls) == 2:
            q.states = [2] * 7

    qb.on_states = arrive
    j = job()
    await lh._remux(qb, j, info, muxer_args(j))
    assert progress[1] == round(1 / 7, 4) == 0.1429


async def test_remux_left_the_queue_unfinished(lh, clock, film, small_chunks):
    path, data = film
    qb = FakeQb([2, 0, 0, 0, 0])
    qb.clock = clock

    def gone(q):
        if len(q.state_calls) == 2:
            q.ps_error = RuntimeError("404")
            q.raw = None

    qb.on_states = gone
    j = job()
    with pytest.raises(RuntimeError, match="^the download left the queue$"):
        await lh._remux(qb, j, info_of(path, data), muxer_args(j))
    assert j.progress == 0.2


async def test_remux_left_the_queue_complete_reads_the_rest(lh, clock, film, small_chunks):
    path, data = film
    qb = FakeQb([])  # no piece list (progress stays where it was)
    qb.clock = clock

    def imported(q):
        if len(q.state_calls) == 2:
            q.ps_error = RuntimeError("404")
            q.raw = None

    qb.on_states = imported
    j = job()
    j.progress = 0.999
    await lh._remux(qb, j, info_of(path, data), muxer_args(j))
    assert (j.dir / "piped.bin").read_bytes() == data
    assert len(qb.state_calls) == 2  # gone: no more piece queries


async def test_remux_a_qbit_hiccup_keeps_waiting(lh, clock, film, small_chunks):
    path, data = film
    qb = FakeQb([2, 0, 0, 0, 0])
    qb.clock = clock

    def flaky(q):
        n = len(q.state_calls)
        q.ps_error = RuntimeError("timeout") if n == 2 else None
        q.raw_error = RuntimeError("timeout too") if n == 2 else None
        if n == 4:
            q.states = [2] * 5

    qb.on_states = flaky
    j = job()
    await lh._remux(qb, j, info_of(path, data), muxer_args(j))
    assert (j.dir / "piped.bin").read_bytes() == data


async def test_remux_gives_up_on_a_frozen_download_nobody_watches(lh, clock, film, small_chunks):
    path, data = film
    qb = FakeQb([2, 0, 0, 0, 0])
    j = job()
    with pytest.raises(RuntimeError, match="^the download stalled$"):
        await lh._remux(qb, j, info_of(path, data), muxer_args(j))
    waited = clock.t - clock._t0
    assert livehls.STALL_GIVE_UP_S < waited <= livehls.STALL_GIVE_UP_S + 2 * livehls.PIECE_POLL


async def test_remux_keeps_waiting_while_someone_watches(lh, clock, film, small_chunks, monkeypatch):
    path, data = film
    monkeypatch.setattr(livehls, "STALL_GIVE_UP_S", 50)
    monkeypatch.setattr(livehls, "IDLE_S", 20)
    qb = FakeQb([2, 0, 0, 0, 0])
    qb.clock = clock
    j = job()

    def watched(q):
        if clock.t - clock._t0 < 100:
            j.touched = clock.t  # the phone polls the status
        else:
            q.states = [2] * 5

    qb.on_states = watched
    await lh._remux(qb, j, info_of(path, data), muxer_args(j))
    assert (j.dir / "piped.bin").read_bytes() == data


async def test_remux_waits_out_a_short_read(lh, clock, film, small_chunks, monkeypatch):
    """The incomplete -> complete move: a read can come back empty once."""
    path, data = film
    reads = []

    def read_at(f, pos, n):
        reads.append(pos)
        return b"" if len(reads) == 2 else streaming._read_at(f, pos, n)

    monkeypatch.setattr(livehls, "streaming", _Proxy(streaming, _read_at=read_at))
    j = job()
    await lh._remux(FakeQb([2] * 5), j, info_of(path, data), muxer_args(j))
    assert (j.dir / "piped.bin").read_bytes() == data
    assert reads[1] == reads[2] and clock.sleeps == [livehls.PIECE_POLL]


async def test_remux_gives_up_on_a_file_that_ends_before_its_pieces(lh, clock, film, small_chunks, monkeypatch):
    """A file shorter than its done pieces claim (truncated, rechecked) never
    grows: the empty read is retried for SHORT_READ_GIVE_UP_S of (virtual) time
    — like streaming._body's cap, 120 s — then the job errors instead of
    spinning forever with the muxer waiting on its stdin."""
    path, data = film
    path.write_bytes(data[: 100 * KiB])  # the rest never lands
    j = job()
    run = lh._remux(FakeQb([2] * 5), j, info_of(path, data), muxer_args(j))
    # the safety net: a regression would spin forever (every sleep is instant)
    with pytest.raises(RuntimeError, match="^the file ends before its download$"):
        await asyncio.wait_for(run, timeout=10)
    assert livehls.SHORT_READ_GIVE_UP_S == streaming.PIECE_WAIT_MAX == 120
    waited = sum(clock.sleeps)
    assert livehls.SHORT_READ_GIVE_UP_S < waited <= livehls.SHORT_READ_GIVE_UP_S + livehls.PIECE_POLL
    assert set(clock.sleeps) == {livehls.PIECE_POLL}


async def test_remux_short_read_budget_restarts_after_progress(lh, clock, film, small_chunks, monkeypatch):
    """The budget is for one stuck spot: empty reads that each recover (the
    move, a slow disk) never add up to a give-up."""
    path, data = film
    reads = []

    def read_at(f, pos, n):
        reads.append(pos)
        # every chunk first reads empty for 100 s worth of polls, then arrives
        if reads.count(pos) <= int(100 / livehls.PIECE_POLL):
            return b""
        return streaming._read_at(f, pos, n)

    monkeypatch.setattr(livehls, "streaming", _Proxy(streaming, _read_at=read_at))
    j = job()
    await lh._remux(FakeQb([2] * 5), j, info_of(path, data), muxer_args(j))
    assert (j.dir / "piped.bin").read_bytes() == data


@pytest.mark.parametrize("err, want", [
    ("first line\nlast line\n\n", "ffmpeg: last line"),
    ("", "ffmpeg: exit 3"),
])
async def test_remux_muxer_failure(lh, clock, film, small_chunks, err, want):
    path, data = film
    j = job()
    with pytest.raises(RuntimeError) as e:
        await lh._remux(FakeQb([2] * 5), j, info_of(path, data), muxer_args(j, rc=3, err=err))
    assert str(e.value) == want


async def test_remux_muxer_that_quits_early(lh, clock, film, small_chunks):
    path, data = film
    j = job()
    args = [sys.executable, "-c", "import sys; sys.stderr.write('bad header\\n'); sys.exit(1)"]
    with pytest.raises(RuntimeError, match="^ffmpeg: bad header$"):
        await lh._remux(FakeQb([2] * 5), j, info_of(path, data), args)


async def test_remux_starts_from_an_empty_job_dir(lh, clock, film, small_chunks):
    path, data = film
    j = job()
    j.dir.mkdir(parents=True)
    (j.dir / "s00009.m4s").write_bytes(b"stale")
    await lh._remux(FakeQb([2] * 5), j, info_of(path, data), muxer_args(j))
    assert not (j.dir / "s00009.m4s").exists()


# ---------------------------------------------------------------- _run


class Proc:
    def __init__(self, rc=None):
        self.returncode = rc
        self.killed = False

    def kill(self):
        self.killed = True


def stub_steps(lh, monkeypatch, *, remux=None):
    async def wait_file(qb, j):
        return INFO

    async def probe(qb, j, info):
        return {"streams": []}

    async def remux_ok(qb, j, info, args):
        j.proc = Proc(rc=0)

    monkeypatch.setattr(lh, "_wait_file", wait_file)
    monkeypatch.setattr(lh, "_probe", probe)
    monkeypatch.setattr(lh, "_ffmpeg_args", lambda j, data: ["ffmpeg"])
    monkeypatch.setattr(lh, "_remux", remux or remux_ok)


async def test_run_ends_done(lh, monkeypatch):
    stub_steps(lh, monkeypatch)
    j = job()
    await lh._run(FakeQb(), j)
    assert j.state == "done" and j.error is None


@pytest.mark.parametrize("exc, want", [(RuntimeError("the download stalled"), "the download stalled"),
                                       (KeyError(), "KeyError")])
async def test_run_error_is_the_jobs_answer(lh, monkeypatch, caplog, exc, want):
    async def remux(qb, j, info, args):
        j.proc = Proc()
        raise exc

    stub_steps(lh, monkeypatch, remux=remux)
    j = job()
    await lh._run(FakeQb(), j)
    assert (j.state, j.error) == ("error", want)
    assert j.proc.killed
    assert msgs(caplog) == [f"livehls {GID}:1: {want}"]


async def test_run_error_after_the_muxer_exited_kills_nothing(lh, monkeypatch):
    async def remux(qb, j, info, args):
        j.proc = Proc(rc=1)
        raise RuntimeError("ffmpeg: x")

    stub_steps(lh, monkeypatch, remux=remux)
    j = job()
    await lh._run(FakeQb(), j)
    assert j.proc.killed is False


async def test_run_cancelled_kills_the_muxer(lh, monkeypatch):
    started = asyncio.Event()

    async def remux(qb, j, info, args):
        j.proc = Proc()
        started.set()
        await asyncio.sleep(3600)

    stub_steps(lh, monkeypatch, remux=remux)
    j = job()
    task = asyncio.create_task(lh._run(FakeQb(), j))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert j.proc.killed and j.state == "probing"


# ---------------------------------------------------------------- start / _drop


async def test_another_audio_track_cancels_the_running_job(lh, monkeypatch, reel_env):
    gate = asyncio.Event()

    async def run(qb, j):
        await gate.wait()

    monkeypatch.setattr(lh, "_run", run)
    monkeypatch.setattr(lh, "_reap", lambda: asyncio.sleep(3600))
    first = lh.start(FakeQb(), GID, 1)
    first.dir.mkdir(parents=True)
    second = lh.start(FakeQb(), GID, 2)
    await asyncio.sleep(0)
    assert first.task.cancelled() and not first.dir.exists()
    assert list(lh.jobs) == [f"{GID}:2"]
    gate.set()
    await second.task
    lh.reaper.cancel()


# ---------------------------------------------------------------- _reap


def add_job(lh, gid_seed, audio, touched, size):
    j = livehls.Job(make_hash(gid_seed), audio)
    j.touched = touched
    j.dir.mkdir(parents=True, exist_ok=True)
    if size:
        (j.dir / "s00000.m4s").write_bytes(b"x" * size)
    lh.jobs[j.key] = j
    return j


@pytest.fixture
async def reaper(lh, monkeypatch):
    clock = FakeClock(auto=False).install(monkeypatch, livehls)
    task = asyncio.create_task(lh._reap())
    yield clock
    task.cancel()


async def test_reaper_drops_jobs_idle_longer_than_idle_s(lh, reaper, caplog):
    caplog.set_level(logging.INFO, logger="reel_api")
    clock = reaper
    await clock.settle(5)
    t = clock.t + 60  # the first look
    old = add_job(lh, "old", 1, t - livehls.IDLE_S - 1, 10)
    edge = add_job(lh, "edge", 1, t - livehls.IDLE_S, 10)
    await clock.advance(59.9, settle=20)
    assert old.key in lh.jobs  # not before 60 s
    await clock.advance(0.1, settle=20)
    assert set(lh.jobs) == {edge.key} and not old.dir.exists()
    assert msgs(caplog) == [f"livehls {old.key}: idle, dropped"]
    await clock.advance(60, settle=20)
    assert lh.jobs == {}  # and it keeps looking


async def test_reaper_caps_the_cache_oldest_idle_first(lh, reaper, monkeypatch):
    clock = reaper
    monkeypatch.setattr(livehls, "CACHE_MAX_BYTES", 250)
    await clock.settle(5)
    t = clock.t + 60
    a = add_job(lh, "a", 1, t - 500, 100)   # oldest, idle
    b = add_job(lh, "b", 1, t - 300, 100)   # idle
    c = add_job(lh, "c", 1, t - 120, 100)   # exactly 2 min: still watched
    d = add_job(lh, "d", 1, t - 10, 100)    # watched
    await clock.advance(60, settle=20)
    # 400 > 250: a goes (300 left), b goes (200 <= 250), c and d stay
    assert set(lh.jobs) == {c.key, d.key}
    assert not a.dir.exists() and not b.dir.exists() and c.dir.exists()


async def test_reaper_cap_stops_at_exactly_the_limit(lh, reaper, monkeypatch):
    clock = reaper
    monkeypatch.setattr(livehls, "CACHE_MAX_BYTES", 200)
    await clock.settle(5)
    t = clock.t + 60
    a = add_job(lh, "a", 1, t - 500, 100)
    b = add_job(lh, "b", 1, t - 400, 100)
    c = add_job(lh, "c", 1, t - 300, 100)
    await clock.advance(60, settle=20)
    assert set(lh.jobs) == {b.key, c.key} and not a.dir.exists()


async def test_reaper_survives_an_unreadable_job_dir(lh, reaper, monkeypatch):
    clock = reaper
    monkeypatch.setattr(livehls, "CACHE_MAX_BYTES", 0)
    await clock.settle(5)
    t = clock.t + 60
    broken = livehls.Job(make_hash("broken"), 1)
    broken.touched = t
    broken.dir.parent.mkdir(parents=True, exist_ok=True)
    broken.dir.write_text("a file, not a dir")  # iterdir() raises NotADirectoryError
    lh.jobs[broken.key] = broken
    await clock.advance(60, settle=20)
    old = add_job(lh, "old", 1, clock.t - livehls.IDLE_S - 1, 10)
    await clock.advance(60, settle=20)
    assert old.key not in lh.jobs  # the loop went on after the OSError


# ---------------------------------------------------------------- odds and ends


def test_root_defaults_to_tmp(reel_env, monkeypatch):
    monkeypatch.delenv("CACHE_DIRECTORY")
    monkeypatch.delenv("TMPDIR")
    assert livehls._root() == Path("/tmp/reel-api-cache/livehls")


def test_playlist_duration_has_millisecond_precision():
    j = job()
    j.dir.mkdir(parents=True)
    (j.dir / "index.m3u8").write_text("#EXTM3U\n#EXTINF:1.00049,\ns00000.m4s\n#EXTINF:2.00002,\ns00001.m4s\n")
    assert j.playlist() == (2, 3.001, False)


@pytest.mark.parametrize("level, want", [(1, "avc1.640001"), (0, "avc1.640028")])
def test_h264_lowest_levels(level, want):
    assert livehls._h264({"profile": "High", "level": level}) == want


@pytest.mark.parametrize("level, want", [(1, "hvc1.1.6.L1.B0"), (0, "hvc1.1.6.L153.B0")])
def test_hevc_lowest_levels(level, want):
    assert livehls._hevc({"profile": "Main", "level": level}, False) == want


@pytest.fixture
def which_ffmpeg(monkeypatch):
    monkeypatch.setattr(livehls, "shutil", _Proxy(livehls.shutil, which=lambda n: "/bin/ffmpeg"))


def test_full_command_line_h264_with_copied_audio(which_ffmpeg, reel_env):
    j = job(audio=1)
    v = {"index": 0, "codec_type": "video", "codec_name": "h264", "profile": "High", "level": 40}
    a = {"index": 1, "codec_type": "audio", "codec_name": "eac3", "channels": 6}
    d = j.dir
    assert livehls.live._ffmpeg_args(j, {"streams": [v, a]}) == [
        "/bin/ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin",
        "-fflags", "+genpts", "-i", "pipe:0",
        "-map", "0:0", "-c:v", "copy", "-map", "0:1", "-c:a", "copy", "-sn", "-dn",
        "-max_muxing_queue_size", "4096",
        "-f", "hls", "-hls_time", "6", "-hls_playlist_type", "event",
        "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
        "-hls_flags", "independent_segments+temp_file",
        "-hls_segment_filename", str(d / "s%05d.m4s"), str(d / "index.m3u8"),
    ]


@pytest.mark.parametrize("channels, conv", [
    (6, ["-c:a", "ac3", "-b:a", "640k", "-ac", "6"]),
    (2, ["-c:a", "aac", "-b:a", "256k", "-ac", "2"]),
])
def test_full_stream_args_hevc_with_converted_audio(which_ffmpeg, channels, conv):
    j = job(audio=2)
    v = {"index": 0, "codec_type": "video", "codec_name": "hevc", "profile": "Main", "level": 120}
    a = {"index": 2, "codec_type": "audio", "codec_name": "dts", "channels": channels}
    args = livehls.live._ffmpeg_args(j, {"streams": [v, a]})
    i = args.index("pipe:0") + 1
    assert args[i:args.index("-sn")] == ["-map", "0:0", "-c:v", "copy", "-tag:v", "hvc1", "-map", "0:2", *conv]


def test_video_only_codecs_have_no_trailing_comma(which_ffmpeg):
    j = job()
    livehls.live._ffmpeg_args(j, {"streams": [{"index": 0, "codec_type": "video", "codec_name": "hevc",
                                               "profile": "Main", "level": 120}]})
    assert j.codecs == "hvc1.1.6.L120.B0"
