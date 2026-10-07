"""yt-dlp: the fake's format choice and trailers.py's codec strings against
real YouTube format lists.

tests/recorded/ytdlp/<id>.json are trimmed `yt-dlp -j` answers for three real
trailers (tests/specs/record_upstreams.py) — between them AV1 SDR and HDR10,
VP9 profile 0 and VP9.2 HDR10, H.264, a 2:1 4K picture, DRC audio twins —
plus the picks the real yt-dlp made from each list, offline, for every height
trailers.py may ask for, on the whole list and with codecs taken away (an
upload without AV1; H.264 + AAC only).

  * `ytdlp_select` (what the fake yt-dlp runs) must make the same picks;
  * the codec strings trailers.py derives from real picks must be valid
    RFC 6381 strings of the kind the TV's MSE takes (and for VP9, whose DASH
    formats only say "vp9"/"vp9.2", a level the picture fits in);
  * a real list through the fake yt-dlp and the product's resolve gives the
    job status the TV reads.
"""

from __future__ import annotations

import asyncio
import json
import re
import subprocess

import pytest

from reel_api import trailers as tr
from tests.support import ytdlp_select
from tests.support.fake_ytdlp import RECORDED, FakeYtDlp, fake_ffmpeg, recorded

IDS = sorted(p.stem for p in RECORDED.glob("*.json"))
VARIANTS = {
    "all": lambda f: True,
    "no_av1": lambda f: not (f.get("vcodec") or "").startswith("av01"),
    "avc_aac": lambda f: (f.get("vcodec") or "none").startswith(("avc1", "none"))
                         and (f.get("acodec") or "none").startswith(("mp4a", "none")),
}
SPEC = f"({tr.VIDEO_FMT})+({tr.AUDIO_FMT})"
RERECORD = ("the product's format spec changed: re-record the picks with "
            "`uv run --frozen --group dev python tests/specs/record_upstreams.py ytdlp-repick`")


def spec(h) -> str:
    return SPEC.format(h=h)


def test_recordings_cover_the_codecs_that_matter():
    fmts = [f for i in IDS for f in recorded(i)["formats"] if f.get("protocol") == "https"]
    vcodecs = {f["vcodec"].split(".")[0] if f["vcodec"].startswith(("av01", "avc1")) else f["vcodec"]
               for f in fmts if f.get("vcodec") not in (None, "none")}
    assert vcodecs >= {"av01", "vp9", "vp9.2", "avc1"}
    assert {f.get("dynamic_range") for f in fmts} >= {"SDR", "HDR10"}
    assert {f["acodec"] for f in fmts if f.get("vcodec") == "none"} >= {"opus", "mp4a.40.2", "mp4a.40.5"}
    assert any(f["format_id"].endswith("-drc") for f in fmts)
    assert len(IDS) >= 3


@pytest.mark.parametrize("yt_id", IDS)
def test_the_picks_were_made_with_the_products_spec(yt_id):
    assert recorded(yt_id)["spec"] == SPEC, RERECORD


@pytest.mark.parametrize("variant", VARIANTS)
@pytest.mark.parametrize("yt_id", IDS)
def test_fake_selection_matches_real_ytdlp(yt_id, variant):
    rec = recorded(yt_id)
    fmts = [f for f in rec["formats"] if VARIANTS[variant](f)]
    for h, want in rec["picks"][variant].items():
        got = ytdlp_select.select(fmts, spec(h))
        assert (got and [f["format_id"] for f in got]) == want, (yt_id, variant, h)


def test_a_naive_choice_would_not_pass():
    """The recorded picks discriminate: "the tallest https video, first in
    list order" (the fake's old rule) gets the codec wrong."""
    rec = recorded("_YUzQa_1RCE")
    vids = [f for f in rec["formats"] if f.get("vcodec") != "none" and f.get("protocol") == "https"
            and (f.get("height") or 0) <= 1080]
    naive = max(vids, key=lambda f: f.get("height") or 0)
    assert naive["format_id"] != rec["picks"]["all"]["1080"][0]


@pytest.mark.parametrize("bad", [
    "bv*[vcodec^=av01]+ba",             # an operator the fake doesn't implement
    "bv*[height<=?1080]+ba",            # the optional '?' form
    "bv*[filesize<50M]+ba",             # a size with a unit
    "bv*.2+ba",                         # the n-th best
    "(bv*+ba",
])
def test_a_spec_the_fake_does_not_understand_is_refused(bad):
    with pytest.raises(ytdlp_select.SpecError):
        ytdlp_select.select(recorded("_YUzQa_1RCE")["formats"], bad)


def test_fallbacks_and_filters_work():
    fmts = recorded("zgGTVaG2UiQ")["formats"]
    got = ytdlp_select.select(fmts, "(bv*[height>=4000])+(ba)/(bv*[height<=480][vcodec!=vp9])+(ba[acodec=opus])")
    assert [f["format_id"] for f in got] == ["397", "251"]
    assert ytdlp_select.select(fmts, "bv*[height>=4000]+ba") is None


# ---------------------------------------------------------------- codec strings (RFC 6381)

# VP9 levels (VP9 bitstream spec, Annex A): max luma picture size, max luma samples/s
_VP9_LEVELS = {10: (36864, 829440), 11: (73728, 2764800), 20: (122880, 4608000),
               21: (245760, 9216000), 30: (552960, 20736000), 31: (983040, 36864000),
               40: (2228224, 83558400), 41: (2228224, 160432128), 50: (8912896, 311951360),
               51: (8912896, 588251136), 52: (8912896, 1176502272), 60: (35651584, 1176502272),
               61: (35651584, 2353004544), 62: (35651584, 4706009088)}
_AV1 = re.compile(r"av01\.[012]\.(\d\d)[MH]\.(08|10|12)(\.[01]\.[0-3][0-3][0-3]\.\d\d\.\d\d\.\d\d\.[01])?")
_AVC = re.compile(r"avc1\.(42|4d|58|64)[0-9a-f]{2}[0-9a-f]{2}")
_VP9 = re.compile(r"vp09\.(0[0-3])\.(\d\d)\.(08|10|12)")
TV_AUDIO = {"opus", "mp4a.40.2", "mp4a.40.5", "ec-3", "ac-3"}


def check_video_codec(fmt: dict) -> list[str]:
    c = tr.mse_video_codec(fmt)
    hdr = (fmt.get("dynamic_range") or "SDR") != "SDR"
    w, h, fps = fmt.get("width") or 0, fmt.get("height") or 0, fmt.get("fps") or 30
    if m := _VP9.fullmatch(c):
        prof, level, depth = m.group(1), int(m.group(2)), m.group(3)
        out = []
        if level not in _VP9_LEVELS:
            out.append(f"{c}: no VP9 level {level}")
        elif w * h > _VP9_LEVELS[level][0] or w * h * fps > _VP9_LEVELS[level][1]:
            out.append(f"{c}: {w}x{h}@{fps} doesn't fit level {level}")
        if hdr and (prof, depth) != ("02", "10"):
            out.append(f"{c}: {fmt['dynamic_range']} needs profile 2, 10 bit")
        if fmt["vcodec"] == "vp9" and not hdr and (prof, depth) != ("00", "08"):
            out.append(f"{c}: plain vp9 SDR is profile 0, 8 bit")
        return out
    if m := _AV1.fullmatch(c):
        return [f"{c}: HDR needs 10 bit"] if hdr and m.group(2) == "08" else []
    if _AVC.fullmatch(c):
        return []
    return [f"{c}: not an RFC 6381 string the TV's MSE takes"]


@pytest.mark.parametrize("yt_id", IDS)
def test_every_real_video_format_gets_a_valid_codec_string(yt_id):
    bad = [f"{f['format_id']} {f['vcodec']} -> {p}" for f in recorded(yt_id)["formats"]
           if f.get("protocol") == "https" and f.get("vcodec") not in (None, "none")
           for p in check_video_codec(f)]
    assert bad == []


@pytest.mark.parametrize("yt_id", IDS)
def test_every_real_audio_format_maps_to_a_codec_the_tv_takes(yt_id):
    got = {tr.mse_audio_codec(f) for f in recorded(yt_id)["formats"]
           if f.get("protocol") == "https" and f.get("vcodec") == "none" and f.get("acodec") != "none"}
    assert got and got <= TV_AUDIO


@pytest.mark.parametrize("yt_id,variant,h,codecs", [
    ("_YUzQa_1RCE", "all", 2160, "av01.0.12M.08,opus"),
    ("QlDFSu3NSu8", "all", 2160, "av01.0.12M.10.0.110.09.16.09.0,opus"),
    ("QlDFSu3NSu8", "no_av1", 2160, "vp09.02.51.10,opus"),   # VP9.2 HDR10, 3840x1920
    ("QlDFSu3NSu8", "no_av1", 1080, "vp09.02.41.10,opus"),
    ("_YUzQa_1RCE", "no_av1", 2160, "vp09.00.51.08,opus"),
    ("_YUzQa_1RCE", "no_av1", 1440, "vp09.00.50.08,opus"),
    ("_YUzQa_1RCE", "no_av1", 720, "vp09.00.31.08,opus"),
    ("zgGTVaG2UiQ", "avc_aac", 2160, "avc1.640028,mp4a.40.2"),
    ("zgGTVaG2UiQ", "avc_aac", 144, "avc1.4d400c,mp4a.40.2"),
])
def test_codecs_of_real_picks(yt_id, variant, h, codecs):
    rec = recorded(yt_id)
    by_id = {f["format_id"]: f for f in rec["formats"]}
    v, a = (by_id[i] for i in rec["picks"][variant][str(h)])
    assert tr.mse_video_codec(v) + "," + tr.mse_audio_codec(a) == codecs


# ---------------------------------------------------------------- through the fake binary and the product


def test_fake_binary_answers_with_the_real_picks(tmp_path, monkeypatch):
    yt = FakeYtDlp(tmp_path / "y", monkeypatch)
    rec = yt.add_recorded("QlDFSu3NSu8")
    for h in ("2160", "1080", "360"):
        out = subprocess.run([str(yt.exe), "--no-cache-dir", "--no-warnings", "--no-playlist", "--quiet",
                              "-j", "-f", spec(h), "https://www.youtube.com/watch?v=QlDFSu3NSu8"],
                             capture_output=True, text=True, timeout=30, check=True)
        info = json.loads(out.stdout)
        assert [f["format_id"] for f in info["requested_formats"]] == rec["picks"]["all"][h]
        assert info["format_id"] == "+".join(rec["picks"]["all"][h])
        assert all("file" not in f for f in info["requested_formats"] + info["formats"])


def test_fake_binary_refuses_an_unknown_spec(tmp_path, monkeypatch):
    yt = FakeYtDlp(tmp_path / "y", monkeypatch)
    yt.add_recorded("QlDFSu3NSu8")
    out = subprocess.run([str(yt.exe), "-j", "-f", "bv*[vcodec^=av01]+ba",
                          "https://www.youtube.com/watch?v=QlDFSu3NSu8"], capture_output=True, text=True,
                         timeout=30)
    assert out.returncode == 2 and "unsupported format spec" in out.stderr


@pytest.mark.parametrize("yt_id,variant,key,want", [
    ("QlDFSu3NSu8", "all", "QlDFSu3NSu8",
     (3840, 1920, "av01.0.12M.10.0.110.09.16.09.0", "av01.0.12M.10.0.110.09.16.09.0,opus", "HDR10")),
    ("QlDFSu3NSu8", "no_av1", "QlDFSu3NSu8",
     (3840, 1920, "vp9.2", "vp09.02.51.10,opus", "HDR10")),
    ("_YUzQa_1RCE", "no_av1", "_YUzQa_1RCE@1080",
     (1920, 1080, "vp9", "vp09.00.41.08,opus", None)),
    ("zgGTVaG2UiQ", "avc_aac", "zgGTVaG2UiQ@720",
     (1280, 720, "avc1.4d401f", "avc1.4d401f,mp4a.40.2", None)),
])
async def test_resolve_of_a_real_list_gives_the_status_the_tv_reads(tmp_path, monkeypatch, reel_env,
                                                                    yt_id, variant, key, want):
    rec = recorded(yt_id)
    h = key.split("@")[1] if "@" in key else str(tr.MAX_HEIGHT)
    picked = rec["picks"][variant][h]
    files = {}
    for fid in picked:  # opaque stand-ins: the fake ffmpeg drains them
        files[fid] = tmp_path / f"{fid}.bin"
        files[fid].write_bytes(fid.encode() * 1000)
    yt = FakeYtDlp(tmp_path / "y", monkeypatch, opaque=True)
    yt.add_recorded(yt_id, files, keep=VARIANTS[variant])
    exe = fake_ffmpeg(tmp_path, "ok", monkeypatch)
    real = tr.shutil.which
    monkeypatch.setattr(tr.shutil, "which", lambda n: exe if n == "ffmpeg" else real(n))
    t = tr.Trailers()
    job = t.start(key)
    await asyncio.wait_for(job.task, 30)
    st = job.status()
    assert st["state"] == "ready", st["error"]
    assert (st["width"], st["height"], st["vcodec"], st["codecs"], st["hdr"]) == want
    assert (st["title"], st["duration"]) == (rec["title"], rec["duration"])
    assert sorted(c["kind"].rsplit(":", 1)[1] for c in yt.calls("download")) == sorted(picked)
