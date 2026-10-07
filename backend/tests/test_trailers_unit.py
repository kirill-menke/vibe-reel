"""trailers.py without yt-dlp: key parsing, MSE codec strings, json3 -> VTT,
the playlist/status/file surface, the on-disk cache (CACHE_VERSION, LRU
eviction) and the HTTP routes. The pipeline itself (`_work`/`_fetch`) is
stubbed here; tests/test_trailers_pipeline.py runs it with a fake yt-dlp.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path

import pytest

from reel_api import trailers as tr

YT = "dQw4w9WgXcQ"  # 11 chars
YT2 = "aBcDeFgHiJk"
VTT_TS = re.compile(r"^\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}$")


# ---------------------------------------------------------------- parse_key


@pytest.mark.parametrize("key,want", [
    (YT, (YT, 2160, YT)),
    (f"{YT}@1080", (YT, 1080, f"{YT}@1080")),
    (f"{YT}@720", (YT, 720, f"{YT}@720")),
    (f"{YT}@144", (YT, 144, f"{YT}@144")),  # MIN_HEIGHT
    (f"{YT}@0144", (YT, 144, f"{YT}@144")),  # leading zero: same canonical key
    (f"{YT}@2160", (YT, 2160, YT)),  # MAX_HEIGHT is the plain id: one job, one folder
    (f"{YT}@4320", (YT, 2160, YT)),  # above it: clamped
    ("a-b_c-d_e-f", ("a-b_c-d_e-f", 2160, "a-b_c-d_e-f")),
    (f"{YT}@143", None),  # below MIN_HEIGHT
    (f"{YT}@99", None),  # 2 digits
    (f"{YT}@10800", None),  # 5 digits
    (f"{YT}@", None),
    (f"{YT}@abc", None),
    (YT[:10], None),
    (YT + "x", None),
    ("dQw4w9WgXc!", None),
    ("dQw4w9W.XcQ", None),
    ("../../../etc", None),
    ("..%2f..%2fet", None),
    ("", None),
])
def test_parse_key(key, want):
    assert tr.parse_key(key) == want


def test_height_bounds_constants():
    assert (tr.MIN_HEIGHT, tr.MAX_HEIGHT) == (144, 2160)


# ---------------------------------------------------------------- codecs


@pytest.mark.parametrize("fmt,want", [
    ({"vcodec": "av01.0.12M.10"}, "av01.0.12M.10"),
    ({"vcodec": "avc1.640028"}, "avc1.640028"),
    ({"vcodec": "vp09.00.51.08"}, "vp09.00.51.08"),
    ({"vcodec": "hev1.1.6.L150.90"}, "hev1.1.6.L150.90"),
    ({"vcodec": "hvc1.2.4.L153"}, "hvc1.2.4.L153"),
    # DASH VP9 that only says "vp9": profile/level/depth built from the format
    ({"vcodec": "vp9", "height": 2160}, "vp09.00.51.08"),
    ({"vcodec": "vp9", "height": 2160, "dynamic_range": "SDR"}, "vp09.00.51.08"),
    ({"vcodec": "vp9.2", "height": 2160}, "vp09.02.51.10"),
    ({"vcodec": "vp9", "height": 2160, "dynamic_range": "HDR10"}, "vp09.02.51.10"),
    ({"vcodec": "vp9", "height": 1441}, "vp09.00.51.08"),
    ({"vcodec": "vp9", "height": 1440}, "vp09.00.50.08"),
    ({"vcodec": "vp9", "height": 1081}, "vp09.00.50.08"),
    ({"vcodec": "vp9", "height": 1080}, "vp09.00.41.08"),
    ({"vcodec": "vp9", "height": 721}, "vp09.00.41.08"),
    ({"vcodec": "vp9", "height": 720}, "vp09.00.31.08"),
    ({"vcodec": "vp9", "height": 360}, "vp09.00.31.08"),
    ({"vcodec": "vp9"}, "vp09.00.41.08"),  # no height: assume 1080
    ({"vcodec": "vp9", "height": None, "dynamic_range": None}, "vp09.00.41.08"),
    ({"vcodec": "theora"}, "theora"),
    ({}, ""),
    ({"vcodec": None}, ""),
])
def test_mse_video_codec(fmt, want):
    assert tr.mse_video_codec(fmt) == want


@pytest.mark.parametrize("acodec,want", [
    ("mp4a.40.2", "mp4a.40.2"),
    ("mp4a.40.5", "mp4a.40.5"),
    ("MP4A.40.2", "MP4A.40.2"),  # a full string is passed through as given
    ("mp4a", "mp4a.40.2"),
    ("aac", "mp4a.40.2"),
    ("AAC", "mp4a.40.2"),
    ("ec-3", "ec-3"), ("eac3", "ec-3"), ("EC-3", "ec-3"),
    ("ac-3", "ac-3"), ("ac3", "ac-3"),
    ("opus", "opus"), ("Opus", "opus"), ("flac", "flac"),
    (None, ""), ("", ""),
])
def test_mse_audio_codec(acodec, want):
    assert tr.mse_audio_codec({"acodec": acodec}) == want


# ---------------------------------------------------------------- captions


@pytest.mark.parametrize("ms,want", [
    (0, "00:00:00.000"), (999, "00:00:00.999"), (1000, "00:00:01.000"),
    (61_005, "00:01:01.005"), (3_723_004, "01:02:03.004"), (1500.7, "00:00:01.500"),
    (360_000_000, "100:00:00.000"),
])
def test_ts(ms, want):
    assert tr._ts(ms) == want


def json3(*events):
    return {"wireMagic": "pb3", "events": list(events)}


def ev(start, dur, *texts, append=False):
    e = {"tStartMs": start, "dDurationMs": dur, "wWinId": 1}
    if texts:
        e["segs"] = [{"utf8": t} for t in texts]
    if append:
        e["aAppend"] = 1
    return e


def parse_vtt(text):
    assert text.startswith("WEBVTT\n\n") and text.endswith("\n")
    cues = []
    for block in text[len("WEBVTT\n\n"):].strip("\n").split("\n\n"):
        ts, *lines = block.split("\n")
        assert VTT_TS.match(ts), ts
        assert len(lines) == 1, block  # one line per cue
        a, b = ts.split(" --> ")
        cues.append((a, b, lines[0]))
    return cues


def test_json3_to_vtt_one_line_cues_without_rolling_duplicates():
    data = json3(
        {"tStartMs": 0, "dDurationMs": 60_000, "id": 1, "wpWinPosId": 1},  # window definition, no segs
        ev(1200, 4000, "In a world", " where"),
        ev(2000, 3200, "\n", append=True),  # rolling line break
        ev(3000, 2200, "nothing", " is", " what", " it", " seems"),
        ev(4100, 1100, "\n", append=True),
        ev(5000, 2000, "   "),  # blank: dropped
        ev(6000, None, "one man"),  # no duration: 3 s
        ev(9500, 500, "..."),
    )
    cues = parse_vtt(tr._json3_to_vtt(data))
    assert cues == [
        ("00:00:01.200", "00:00:03.000", "In a world where"),  # clipped at the next line's start
        ("00:00:03.000", "00:00:05.200", "nothing is what it seems"),
        ("00:00:06.000", "00:00:09.000", "one man"),
        ("00:00:09.500", "00:00:10.000", "..."),
    ]
    texts = [c[2] for c in cues]
    assert len(texts) == len(set(texts))


def test_json3_lines_starting_together_drop_the_empty_cue():
    data = json3(ev(1000, 2000, "first"), ev(1000, 2000, "second"))
    assert parse_vtt(tr._json3_to_vtt(data)) == [("00:00:01.000", "00:00:03.000", "second")]


@pytest.mark.parametrize("data", [{}, {"events": None}, json3(), json3(ev(0, 1000, " "), ev(10, 5, append=True))])
def test_json3_without_text_is_empty(data):
    assert tr._json3_to_vtt(data) == ""


def test_json3_missing_start_is_zero():
    assert parse_vtt(tr._json3_to_vtt(json3({"segs": [{"utf8": "hi"}]}))) == [
        ("00:00:00.000", "00:00:03.000", "hi")]


@pytest.mark.parametrize("err,want", [
    (b"", "failed"), (b"\n  \n", "failed"),
    (b"WARNING: x\nERROR: [youtube] dQw4w9WgXcQ: Video unavailable\n\n", "ERROR: [youtube] dQw4w9WgXcQ: Video unavailable"),
    (b"bad \xff byte", "bad � byte"),
    (b"x" * 400, "x" * 300),
])
def test_last_line(err, want):
    assert tr._last_line(err) == want


# ---------------------------------------------------------------- Job


def test_job_paths_and_keys(tmp_path):
    assert tr.Job(YT, tmp_path).dir == tmp_path / YT
    j = tr.Job(YT, tmp_path, 1080)
    assert j.key == f"{YT}@1080" and j.dir == tmp_path / f"{YT}@1080"


def test_playlist_and_status(tmp_path):
    j = tr.Job(YT, tmp_path)
    assert j.playlist() == (0, 0.0, False)
    j.dir.mkdir()
    (j.dir / "index.m3u8").write_text(
        "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:EVENT\n"
        '#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.004000,\ns000.m4s\n#EXTINF:4.004000,\ns001.m4s\n'
        "#EXTINF:1.5,\ns002.m4s\n")
    assert j.playlist() == (3, 9.508, False)
    with open(j.dir / "index.m3u8", "a") as f:
        f.write("#EXT-X-ENDLIST\n")
    assert j.playlist() == (3, 9.508, True)
    st = j.status()
    assert st == {
        "id": YT, "state": "resolving", "segments": 3, "buffered_s": 9.508, "duration": None, "complete": True,
        "width": None, "height": None, "vcodec": None, "codecs": None, "hdr": None, "subs": None,
        "subs_done": False, "title": None, "error": None,
    }


# ---------------------------------------------------------------- the on-disk cache


def write_done(root: Path, key: str, v=tr.CACHE_VERSION, size=0, mtime=None, **meta):
    d = root / key
    d.mkdir(parents=True, exist_ok=True)
    (d / "done").write_text(json.dumps({"v": v, **meta}) if v is not None else "{not json")
    (d / "index.m3u8").write_text("#EXTM3U\n#EXTINF:4.0,\ns000.m4s\n#EXT-X-ENDLIST\n")
    (d / "init.mp4").write_bytes(b"\0" * 16)
    if size:
        (d / "s000.m4s").write_bytes(b"\0" * size)
    if mtime is not None:
        os.utime(d, (mtime, mtime))
    return d


@pytest.fixture
def trailers(reel_env):
    t = tr.Trailers()
    assert t.root == reel_env.cache / "trailers"
    return t


def test_cache_root_follows_cache_directory(reel_env, monkeypatch):
    monkeypatch.setenv("CACHE_DIRECTORY", f"{reel_env.cache}:/somewhere/else")
    assert tr._cache_root() == reel_env.cache / "trailers"
    monkeypatch.delenv("CACHE_DIRECTORY")
    assert tr._cache_root() == Path(os.environ["TMPDIR"]) / "reel-api-cache" / "trailers"


def test_from_disk_current_version_is_ready(trailers):
    meta = {"duration": 96.5, "title": "Trailer", "width": 3840, "height": 2160, "vcodec": "vp9",
            "codecs": "vp09.00.51.08,opus", "hdr": None, "subs": {"lang": "en", "kind": "auto"}}
    write_done(trailers.root, YT, **meta)
    job = trailers.get(YT)
    assert job.state == "ready" and job.subs_done is True
    assert {k: getattr(job, k) for k in meta} == meta
    assert trailers.jobs[YT] is job and trailers.get(YT) is job
    assert job.status()["complete"] is True and job.status()["segments"] == 1


@pytest.mark.parametrize("v", [tr.CACHE_VERSION - 1, None, "3"], ids=["older", "corrupt", "string"])
def test_from_disk_other_versions_are_fetched_again(trailers, v):
    write_done(trailers.root, YT, v=v)
    assert trailers.get(YT) is None
    assert YT not in trailers.jobs


def test_from_disk_needs_the_done_marker(trailers):
    d = trailers.root / YT
    d.mkdir(parents=True)
    (d / "index.m3u8").write_text("#EXTM3U\n")
    assert trailers.get(YT) is None


def test_heights_have_their_own_folders(trailers):
    write_done(trailers.root, f"{YT}@1080", title="1080")
    assert trailers.get(YT) is None
    assert trailers.get(f"{YT}@1080").title == "1080"
    assert trailers.get(f"{YT}@0720") is None
    assert trailers.get("junk") is None


def test_evict_drops_least_recently_played_over_the_cap(trailers, monkeypatch):
    monkeypatch.setattr(tr, "CACHE_MAX_BYTES", 2500)
    keys = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd"]
    for i, k in enumerate(keys):
        write_done(trailers.root, k, size=1000, mtime=1_000_000 + i)
    trailers.get(keys[0])  # loaded jobs are dropped along with their folder
    # an unfinished folder (no done marker) neither counts nor goes
    part = trailers.root / "eeeeeeeeeee"
    part.mkdir()
    (part / "s000.m4s").write_bytes(b"\0" * 5000)
    trailers._evict()
    left = sorted(p.name for p in trailers.root.iterdir())
    # each folder is ~1000 + 16 + playlist bytes: two fit under 2500
    assert left == ["ccccccccccc", "ddddddddddd", "eeeeeeeeeee"]
    assert keys[0] not in trailers.jobs


def test_evict_order_follows_mtime_not_name(trailers, monkeypatch):
    monkeypatch.setattr(tr, "CACHE_MAX_BYTES", 1500)
    write_done(trailers.root, "aaaaaaaaaaa", size=1000, mtime=2_000_000)
    write_done(trailers.root, "bbbbbbbbbbb", size=1000, mtime=1_000_000)
    trailers._evict()
    assert [p.name for p in trailers.root.iterdir()] == ["aaaaaaaaaaa"]


@pytest.mark.parametrize("name", ["index.m3u8", "init.mp4", "s000.m4s"])
def test_reading_a_trailer_counts_as_a_use_for_the_lru(trailers, monkeypatch, name):
    """A trailer being watched is read segment by segment for minutes after its
    start(): every read of a ready trailer's file touches it, so a fetch that
    finishes meanwhile evicts an idle one, not the one on screen."""
    monkeypatch.setattr(tr, "CACHE_MAX_BYTES", 1500)
    watched = write_done(trailers.root, "aaaaaaaaaaa", size=1000, mtime=1_000_000)
    write_done(trailers.root, "bbbbbbbbbbb", size=1000, mtime=2_000_000)
    assert trailers.file_response("aaaaaaaaaaa", name).status_code == 200
    assert watched.stat().st_mtime > 2_000_000
    trailers._evict()
    assert [p.name for p in trailers.root.iterdir()] == ["aaaaaaaaaaa"]


def test_a_failed_lru_touch_still_serves_the_file(trailers, monkeypatch):
    write_done(trailers.root, YT, size=10)

    def no_utime(*a, **k):
        raise PermissionError("read-only cache")

    monkeypatch.setattr(tr.os, "utime", no_utime)
    r = trailers.file_response(YT, "s000.m4s")
    assert r.status_code == 200


def test_a_404_read_touches_nothing(trailers):
    d = write_done(trailers.root, YT, mtime=1_000_000)
    assert trailers.file_response(YT, "s999.m4s").status_code == 404
    assert d.stat().st_mtime == 1_000_000


def test_reading_a_trailer_still_downloading_leaves_its_mtime_to_the_writes(trailers):
    """Only a ready trailer is touched: one still being fetched is never
    evicted anyway (and ffmpeg's writes keep its folder fresh)."""
    d = trailers.root / YT
    d.mkdir(parents=True)
    (d / "index.m3u8").write_text("#EXTM3U\n#EXTINF:4.0,\ns000.m4s\n")
    os.utime(d, (1_000_000, 1_000_000))
    job = tr.Job(YT, trailers.root)
    job.state = "downloading"
    trailers.jobs[YT] = job
    assert trailers.file_response(YT, "index.m3u8").status_code == 200
    assert d.stat().st_mtime == 1_000_000


def test_evict_skips_a_running_job(trailers, monkeypatch):
    monkeypatch.setattr(tr, "CACHE_MAX_BYTES", 10)
    write_done(trailers.root, "aaaaaaaaaaa", size=1000, mtime=1_000_000)
    write_done(trailers.root, "bbbbbbbbbbb", size=1000, mtime=2_000_000)
    job = tr.Job("aaaaaaaaaaa", trailers.root)
    job.state = "downloading"  # a re-fetch in flight over an old folder
    trailers.jobs["aaaaaaaaaaa"] = job
    trailers._evict()
    assert [p.name for p in trailers.root.iterdir()] == ["aaaaaaaaaaa"]


def test_evict_under_the_cap_and_without_a_root(trailers):
    trailers._evict()  # no root yet: nothing to do, no error
    write_done(trailers.root, YT, size=1000)
    trailers._evict()
    assert (trailers.root / YT).exists()


def test_start_is_idempotent_and_touches_a_ready_trailer(trailers, monkeypatch):
    started = []

    async def fake_work(job):
        started.append(job.key)

    monkeypatch.setattr(trailers, "_work", fake_work)
    d = write_done(trailers.root, YT, mtime=1_000_000)
    job = trailers.start(YT)
    assert job.state == "ready" and started == []
    assert d.stat().st_mtime > 1_000_000  # LRU touch
    with pytest.raises(ValueError):
        trailers.start("nope")


async def test_start_runs_once_and_retries_an_error_after_error_ttl(trailers, monkeypatch, clock):
    clock.install(monkeypatch, tr)
    started = []

    async def fake_work(job):
        started.append(job.key)

    monkeypatch.setattr(trailers, "_work", fake_work)
    job = trailers.start(f"{YT}@1080")
    assert job.state == "resolving" and job.key == f"{YT}@1080"
    assert trailers.start(f"{YT}@1080") is job
    await job.task
    assert started == [f"{YT}@1080"]
    job.state, job.ended_at = "error", clock.monotonic()
    clock.t += tr.ERROR_TTL
    assert trailers.start(f"{YT}@1080") is job  # not yet
    clock.t += 1
    again = trailers.start(f"{YT}@1080")
    assert again is not job and trailers.jobs[f"{YT}@1080"] is again
    await again.task
    assert started == [f"{YT}@1080"] * 2


# ---------------------------------------------------------------- HTTP


@pytest.fixture
def stub_work(app_module, monkeypatch):
    started = []

    async def fake_work(job):
        started.append(job.key)

    monkeypatch.setattr(app_module.trailers, "_work", fake_work)
    return started


@pytest.mark.parametrize("key", ["short", f"{YT}@99", f"{YT}x", "a" * 30])
async def test_bad_key_is_400(api, stub_work, key):
    for method in ("POST", "GET"):
        r = await api.request(method, f"/api/trailers/{key}")
        assert r.status_code == 400
        assert r.json() == {"error": "bad_id", "detail": "not a YouTube video id"}
    assert stub_work == []


async def test_status_is_404_before_start(api, stub_work):
    r = await api.get(f"/api/trailers/{YT}")
    assert r.status_code == 404
    assert r.json() == {"error": "not_found", "detail": "trailer not started"}


async def test_post_starts_and_get_reports(api, stub_work):
    r = await api.post(f"/api/trailers/{YT}@1080")
    assert r.status_code == 200
    assert r.json()["id"] == YT and r.json()["state"] == "resolving" and r.json()["segments"] == 0
    r2 = await api.post(f"/api/trailers/{YT}@1080")
    assert r2.json() == r.json()
    assert (await api.get(f"/api/trailers/{YT}@1080")).json() == r.json()
    assert (await api.get(f"/api/trailers/{YT}")).status_code == 404  # another height, another job
    await asyncio.sleep(0)
    assert stub_work == [f"{YT}@1080"]


async def test_status_of_a_trailer_cached_by_an_earlier_process(api, stub_work, reel_env):
    write_done(reel_env.cache / "trailers", YT, duration=90.0, codecs="av01.0.12M.10,opus")
    r = await api.get(f"/api/trailers/{YT}")
    assert r.status_code == 200
    assert r.json()["state"] == "ready" and r.json()["complete"] is True
    assert r.json()["codecs"] == "av01.0.12M.10,opus"
    assert stub_work == []


async def test_files_are_served_with_their_types(api, stub_work, reel_env):
    d = write_done(reel_env.cache / "trailers", YT, size=100)
    (d / "subs.vtt").write_text("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi\n")
    r = await api.get(f"/api/trailers/{YT}/index.m3u8")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/vnd.apple.mpegurl"
    assert r.headers["cache-control"] == "no-store"
    # EXT-X-START pins the start to 0 for the TV's player
    assert r.text.startswith("#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n#EXTINF:4.0,")
    r = await api.get(f"/api/trailers/{YT}/init.mp4")
    assert r.status_code == 200 and r.headers["content-type"] == "video/mp4"
    assert r.headers["cache-control"] == "max-age=86400" and r.content == b"\0" * 16
    r = await api.get(f"/api/trailers/{YT}/s000.m4s")
    assert r.headers["content-type"] == "video/iso.segment" and len(r.content) == 100
    r = await api.get(f"/api/trailers/{YT}/subs.vtt")
    assert r.headers["content-type"] == "text/vtt; charset=utf-8" and r.text.startswith("WEBVTT")


async def test_playlist_with_its_own_start_is_left_alone(api, stub_work, reel_env):
    d = write_done(reel_env.cache / "trailers", YT)
    text = "#EXTM3U\n#EXT-X-START:TIME-OFFSET=2\n#EXTINF:4.0,\ns000.m4s\n"
    (d / "index.m3u8").write_text(text)
    assert (await api.get(f"/api/trailers/{YT}/index.m3u8")).text == text


@pytest.mark.parametrize("name", [
    "s1.m4s", "s123456.m4s", "index.m3u", "init.mp4.bak", "done", "info.json", "S001.m4s",
    "%2e%2e", "s001.m4s%00", "index.m3u8%0A",
])
async def test_file_names_outside_the_pattern_are_404(api, stub_work, reel_env, name):
    write_done(reel_env.cache / "trailers", YT)
    r = await api.get(f"/api/trailers/{YT}/{name}")
    assert r.status_code == 404
    assert r.json() == {"error": "not_found", "detail": "no such trailer file"}


@pytest.mark.parametrize("name", ["..", "../done", "..%2Fdone", "%2e%2e%2fdone", "..%2F..%2F..%2Fsecret"])
async def test_traversal_in_the_file_name_never_reaches_a_file(api, stub_work, reel_env, name):
    """Dot segments are resolved before routing (or the decoded '/' leaves
    the route): whatever answers, it is a 400/404 and never the file."""
    write_done(reel_env.cache / "trailers", YT)
    (reel_env.cache / "secret").write_text("SECRET")
    r = await api.get(f"/api/trailers/{YT}/{name}")
    assert r.status_code in (400, 404)
    assert r.json() in ({"error": "not_found", "detail": "no such trailer file"}, {"detail": "Not Found"},
                        {"error": "bad_id", "detail": "not a YouTube video id"})
    assert "SECRET" not in r.text


def test_file_regex_rejects_traversal():
    """FILE is matched whole (fullmatch, as app.trailer_file does): a prefix
    match, or `$` before a trailing newline, is not a file name."""
    for bad in ("../x", "../index.m3u8", "a/index.m3u8", "/etc/passwd", "%2e%2e", "index.m3u8/..",
                "s001.m4s/../../done", "index.m3u8\n", "subs.vtt\n", "s００1.m4s", "s001.m4sx"):
        assert not tr.FILE.fullmatch(bad), bad
    for good in ("index.m3u8", "init.mp4", "s000.m4s", "s99999.m4s", "subs.vtt"):
        assert tr.FILE.fullmatch(good), good


def test_key_regex_is_ascii_and_whole():
    assert tr.parse_key("dQw4w9WgXcQ") is not None
    assert tr.parse_key("dQw4w9WgXcQ@1080") is not None
    for bad in ("dQw4w9WgXcQ\n", "dQw4w9WgXc\u0661", "dQw4w9WgXcQ@1080\n", "dQw4w9WgXcQ@١٠٨٠", "dQw4w9WgXcQx"):
        assert tr.parse_key(bad) is None, bad


async def test_traversal_through_the_key_is_404(api, stub_work, reel_env):
    (reel_env.cache / "secret").write_text("SECRET")
    for path in (f"/api/trailers/..%2F..%2Fsecret/index.m3u8", "/api/trailers/%2e%2e/index.m3u8"):
        r = await api.get(path)
        assert r.status_code in (400, 404), path
        assert "SECRET" not in r.text


async def test_missing_file_unknown_trailer_and_error_state_are_404(api, stub_work, reel_env, app_module):
    # never started
    r = await api.get(f"/api/trailers/{YT}/index.m3u8")
    assert r.status_code == 404 and r.json()["detail"] == "no such trailer file"
    # started, nothing written yet
    await api.post(f"/api/trailers/{YT2}")
    assert (await api.get(f"/api/trailers/{YT2}/index.m3u8")).status_code == 404
    # a ready trailer without that segment
    write_done(reel_env.cache / "trailers", YT)
    assert (await api.get(f"/api/trailers/{YT}/s005.m4s")).status_code == 404
    assert (await api.get(f"/api/trailers/{YT}/index.m3u8")).status_code == 200
    # a job in error serves nothing, even with files left on disk
    app_module.trailers.jobs[YT].state = "error"
    assert (await api.get(f"/api/trailers/{YT}/init.mp4")).status_code == 404
    # a bad key on the file route is the same 404
    assert (await api.get("/api/trailers/short/index.m3u8")).status_code == 404
