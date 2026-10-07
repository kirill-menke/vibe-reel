"""A fake `yt-dlp` (and, when a test needs one, a fake `ffmpeg`) for the
trailer pipeline tests. Nothing here ever talks to YouTube.

`FakeYtDlp(dir, monkeypatch)` writes an executable `yt-dlp` into `dir/bin`,
puts that directory first on PATH and points the script at a JSON config.
The script answers exactly the two calls trailers.py makes:

* ``yt-dlp … -j -f SPEC URL`` prints the info JSON of the video in the
  config, with ``requested_formats`` chosen by ``ytdlp_select.select`` — a
  port of yt-dlp's own format sort and spec selection, checked against the
  picks the real yt-dlp made on recorded YouTube format lists
  (tests/recorded/ytdlp, test_ytdlp_recorded.py). A spec it doesn't fully
  understand fails the call (exit 2) instead of being half-applied.
  ``requested`` in the config overrides the choice.
* ``yt-dlp … --load-info-json PATH -f FORMAT_ID -o -`` streams the file the
  config maps to FORMAT_ID to stdout, in chunks.

Faults and timing, all per call kind:

* ``fail(kind, stderr=, rc=, after=)`` — ``kind`` is ``"resolve:<id>"`` or
  ``"download:<id>:<format_id>"``: print stderr, exit rc (with ``after``, a
  download streams its whole file first).
* ``gate(kind, at=)`` — the call waits (after streaming the fraction ``at``
  of its file, for a download; ``at=0`` waits before even its fault) until
  ``release(kind)``; an unreleased gate
  gives up after 30 s with exit 3, so a leaked process can't live long.

Every call appends one JSON line (argv, kind, pid) to the log, read back with
``calls()`` / ``calls("resolve")``.

Honest media: a format's ``file`` must be what the format claims — codec (and
for ``avc1.PPCCLL`` the profile and level, for ``vp9.2``/``vp09.02``/HDR a
10-bit profile-2 stream), width, height and container are checked with
ffprobe when the format is added (``check_media``). Tests whose files are
opaque bytes (the fast tests, with a fake ffmpeg) say so with
``FakeYtDlp(..., opaque=True)``. A format without a ``file`` is offered but
can't be downloaded. ``recorded(id)`` loads a recorded real format list;
``add_recorded(id, files)`` offers it with files for some of its formats.

`fake_ffmpeg(dir, mode)` returns the path of a stand-in ffmpeg for the
failure branches real ffmpeg won't produce on demand: ``"partial"`` drains
both inputs and writes a playlist without #EXT-X-ENDLIST, ``"fail"`` drains
them and exits 1 with an error line, ``"ok"`` drains them and writes a
finished playlist (fast tests without a real ffmpeg). With FAKE_FFMPEG_LOG
set, its argv is written there as JSON.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import sys
from pathlib import Path

_SCRIPT = r'''
import json, os, re, sys, time
sys.path.insert(0, os.environ["FAKE_YTDLP_SELECT_DIR"])
import ytdlp_select

cfg_path = os.environ["FAKE_YTDLP_CONFIG"]
cfg = json.load(open(cfg_path))
argv = sys.argv[1:]


def log(kind):
    with open(cfg["log"], "a") as f:
        f.write(json.dumps({"argv": argv, "kind": kind, "pid": os.getpid()}) + "\n")


def wait_gate(kind):
    if kind not in cfg.get("gates", {}):
        return
    path = os.path.join(cfg["gate_dir"], kind.replace(":", "_"))
    end = time.monotonic() + 30
    while not os.path.exists(path):
        if time.monotonic() > end:
            sys.stderr.write("fake yt-dlp: gate %s never released\n" % kind)
            sys.exit(3)
        time.sleep(0.01)


def fault(kind, after=False):
    f = cfg.get("faults", {}).get(kind)
    if f and f.get("after", False) == after:
        sys.stderr.write(f["stderr"])
        sys.stderr.flush()
        sys.exit(f["rc"])


def public(fmt):
    return {k: v for k, v in fmt.items() if k != "file"}


def arg(name):
    return argv[argv.index(name) + 1]


if "-j" in argv:
    url = argv[-1]
    vid = url.split("v=", 1)[1]
    kind = "resolve:" + vid
    log(kind)
    wait_gate(kind)
    fault(kind)
    video = cfg["videos"].get(vid)
    if video is None:
        sys.stderr.write("ERROR: [youtube] %s: Video unavailable\n" % vid)
        sys.exit(1)
    fmts = video["formats"]
    if "requested" in video:
        req = [next(f for f in fmts if f["format_id"] == i) for i in video["requested"]]
    else:
        try:
            req = ytdlp_select.select(fmts, arg("-f"))
        except ytdlp_select.SpecError as e:
            sys.stderr.write("fake yt-dlp: unsupported format spec: %s\n" % e)
            sys.exit(2)
        if not req:
            sys.stderr.write("ERROR: [youtube] %s: Requested format is not available. "
                             "Use --list-formats for a list of available formats\n" % vid)
            sys.exit(1)
    info = {k: v for k, v in video.items() if k not in ("formats", "requested")}
    info.update(id=vid, webpage_url=url, format_id="+".join(f["format_id"] for f in req),
                formats=[public(f) for f in fmts], requested_formats=[public(f) for f in req])
    sys.stdout.write(json.dumps(info))
    sys.exit(0)

if "--load-info-json" in argv:
    info = json.load(open(arg("--load-info-json")))
    fid = arg("-f")
    kind = "download:%s:%s" % (info["id"], fid)
    log(kind)
    assert arg("-o") == "-", argv
    frac = cfg.get("gates", {}).get(kind, 1.0)
    if frac == 0:
        wait_gate(kind)  # gated before anything happens, the fault included
    fault(kind)
    fmt = next(f for f in cfg["videos"][info["id"]]["formats"] if f["format_id"] == fid)
    if not fmt.get("file"):
        sys.stderr.write("fake yt-dlp: format %s has no file to serve\n" % fid)
        sys.exit(2)
    data = open(fmt["file"], "rb").read()
    at = int(len(data) * frac)
    out = sys.stdout.buffer
    try:
        for i in range(0, at, 65536):
            out.write(data[i:min(i + 65536, at)])
        out.flush()
        if frac:
            wait_gate(kind)
        for i in range(at, len(data), 65536):
            out.write(data[i:i + 65536])
        out.flush()
    except BrokenPipeError:
        sys.stderr.write("ERROR: unable to write data: [Errno 32] Broken pipe\n")
        sys.exit(1)
    fault(kind, after=True)
    sys.exit(0)

sys.stderr.write("fake yt-dlp: unexpected call %r\n" % (argv,))
sys.exit(2)
'''

_FFMPEG = r'''
import json, os, re, sys
argv = sys.argv[1:]
mode = os.environ["FAKE_FFMPEG_MODE"]
if os.environ.get("FAKE_FFMPEG_LOG"):
    with open(os.environ["FAKE_FFMPEG_LOG"], "w") as f:
        json.dump(argv, f)
fds = [0] + [int(m.group(1)) for a in argv for m in [re.fullmatch(r"pipe:(\d+)", a)] if m and m.group(1) != "0"]
for fd in fds:
    while os.read(fd, 65536):
        pass
if mode == "fail":
    sys.stderr.write("pipe:0: Invalid data found when processing input\n")
    sys.exit(1)
out = argv[-1]
with open(out, "w") as f:
    f.write("#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:4.000000,\ns000.m4s\n")
    if mode == "ok":
        f.write("#EXT-X-ENDLIST\n")
sys.exit(0)
'''


def _write_exe(path: Path, body: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"#!{sys.executable}\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


def fake_ffmpeg(directory: Path, mode: str, monkeypatch) -> str:
    """A stand-in ffmpeg (see the module doc); returns its path."""
    monkeypatch.setenv("FAKE_FFMPEG_MODE", mode)
    return str(_write_exe(Path(directory) / "ffbin" / "ffmpeg", _FFMPEG))


RECORDED = Path(__file__).resolve().parent.parent / "recorded" / "ytdlp"


def recorded(yt_id: str) -> dict:
    """A recorded real `yt-dlp -j` (trimmed): formats, picks, title, duration."""
    return json.loads((RECORDED / f"{yt_id}.json").read_text())


def video_fmt(format_id: str, file: Path | None, *, width: int, height: int, vcodec: str,
              dynamic_range: str = "SDR", protocol: str = "https", ext: str | None = None,
              **extra) -> dict:
    """A video-only DASH format as YouTube lists it (VP9 comes as webm)."""
    ext = ext or ("webm" if vcodec.startswith(("vp9", "vp09")) else "mp4")
    return {"format_id": format_id, "file": str(file) if file else None, "width": width,
            "height": height, "vcodec": vcodec, "acodec": "none", "dynamic_range": dynamic_range,
            "protocol": protocol, "ext": ext, **extra}


def audio_fmt(format_id: str, file: Path | None, *, acodec: str = "mp4a.40.2", protocol: str = "https",
              ext: str | None = None, **extra) -> dict:
    ext = ext or ("webm" if acodec == "opus" else "m4a")
    return {"format_id": format_id, "file": str(file) if file else None, "vcodec": "none",
            "acodec": acodec, "protocol": protocol, "ext": ext, "audio_channels": 2, **extra}


_AVC_PROFILES = {"42": {"Baseline", "Constrained Baseline"}, "4d": {"Main"}, "64": {"High"}}
_AAC = {"mp4a.40.2": "LC", "mp4a.40.5": "HE-AAC", "mp4a.40.29": "HE-AACv2"}


def check_media(fmt: dict) -> list[str]:
    """What the format's file contradicts in the format's claims ([] = honest)."""
    from tests.support.media import FFPROBE, ffprobe

    assert FFPROBE, "check_media needs ffprobe (or FakeYtDlp(opaque=True))"
    try:
        probe = ffprobe(Path(fmt["file"]))
    except Exception as e:  # noqa: BLE001
        return [f"{fmt['format_id']}: not media ffprobe can read ({e.__class__.__name__})"]
    bad = []
    fid = fmt["format_id"]
    container = probe["format"]["format_name"]
    want_c = {"webm": "matroska", "mp4": "mp4", "m4a": "mp4"}.get(fmt.get("ext"))
    if want_c and want_c not in container:
        bad.append(f"{fid}: ext {fmt.get('ext')} but the file is {container}")
    streams = [s for s in probe["streams"] if s["codec_type"] in ("video", "audio")]
    if len(streams) != 1:
        bad.append(f"{fid}: a DASH format carries one stream, the file has {len(streams)}")
        return bad
    st = streams[0]
    vc, ac = fmt.get("vcodec") or "none", fmt.get("acodec") or "none"
    if vc != "none":
        if st["codec_type"] != "video":
            return bad + [f"{fid}: claims video {vc}, the file is {st['codec_type']}"]
        if (st.get("width"), st.get("height")) != (fmt.get("width"), fmt.get("height")):
            bad.append(f"{fid}: claims {fmt.get('width')}x{fmt.get('height')}, "
                       f"the file is {st.get('width')}x{st.get('height')}")
        ten_bit = "10" in (st.get("pix_fmt") or "")
        if vc.startswith("avc1"):
            if st["codec_name"] != "h264":
                bad.append(f"{fid}: claims {vc}, the file is {st['codec_name']}")
            else:
                hexs = vc.split(".")[1].lower()
                if st.get("profile") not in _AVC_PROFILES.get(hexs[:2], set()):
                    bad.append(f"{fid}: {vc} is profile {hexs[:2]}, the file is {st.get('profile')}")
                if st.get("level") != int(hexs[4:6], 16):
                    bad.append(f"{fid}: {vc} is level {int(hexs[4:6], 16)}, the file is {st.get('level')}")
        elif vc.startswith(("vp9", "vp09")):
            two = vc == "vp9.2" or vc.startswith("vp09.02")
            if st["codec_name"] != "vp9":
                bad.append(f"{fid}: claims {vc}, the file is {st['codec_name']}")
            elif two != (st.get("profile") == "Profile 2") or two != ten_bit:
                bad.append(f"{fid}: claims {vc}, the file is {st.get('profile')} {st.get('pix_fmt')}")
        elif vc.startswith("av01"):
            depth = vc.split(".")[3] if vc.count(".") >= 3 else "08"
            if st["codec_name"] != "av1":
                bad.append(f"{fid}: claims {vc}, the file is {st['codec_name']}")
            elif (depth == "10") != ten_bit:
                bad.append(f"{fid}: claims {depth}-bit, the file is {st.get('pix_fmt')}")
        else:
            bad.append(f"{fid}: check_media doesn't know vcodec {vc}")
        if (fmt.get("dynamic_range") or "SDR") != "SDR" and not ten_bit:
            bad.append(f"{fid}: claims {fmt['dynamic_range']}, the file is {st.get('pix_fmt')}")
    elif ac != "none":
        if st["codec_type"] != "audio":
            return bad + [f"{fid}: claims audio {ac}, the file is {st['codec_type']}"]
        if ac.startswith("mp4a"):
            if st["codec_name"] != "aac" or st.get("profile") != _AAC.get(ac, st.get("profile")):
                bad.append(f"{fid}: claims {ac}, the file is {st['codec_name']} {st.get('profile')}")
        elif st["codec_name"] != {"ec-3": "eac3", "ac-3": "ac3"}.get(ac, ac):
            bad.append(f"{fid}: claims {ac}, the file is {st['codec_name']}")
        if fmt.get("audio_channels") and st.get("channels") != fmt["audio_channels"]:
            bad.append(f"{fid}: claims {fmt['audio_channels']} channels, the file has {st.get('channels')}")
    return bad


class FakeYtDlp:
    def __init__(self, directory: Path, monkeypatch, *, opaque: bool = False):
        """opaque=True: format files are stand-in bytes, not media (never
        checked against their claims)."""
        self.opaque = opaque
        self.dir = Path(directory)
        self.bin = self.dir / "bin"
        self.exe = _write_exe(self.bin / "yt-dlp", _SCRIPT)
        self.gate_dir = self.dir / "gates"
        self.gate_dir.mkdir(parents=True, exist_ok=True)
        self.log = self.dir / "calls.jsonl"
        self.config_path = self.dir / "config.json"
        self.config = {"log": str(self.log), "gate_dir": str(self.gate_dir),
                       "videos": {}, "faults": {}, "gates": {}}
        self.save()
        monkeypatch.setenv("FAKE_YTDLP_CONFIG", str(self.config_path))
        monkeypatch.setenv("FAKE_YTDLP_SELECT_DIR", str(Path(__file__).resolve().parent))
        monkeypatch.setenv("PATH", f"{self.bin}{os.pathsep}{os.environ.get('PATH', '')}")
        # The real yt-dlp must never run from a test.
        assert shutil.which("yt-dlp") == str(self.exe)

    def save(self) -> None:
        self.config_path.write_text(json.dumps(self.config))

    def add(self, yt_id: str, formats: list[dict], *, title: str = "A Trailer",
            duration: float = 9, **info) -> None:
        if not self.opaque:
            bad = [p for f in formats if f.get("file") for p in check_media(f)]
            assert not bad, "fake yt-dlp: format files contradict their formats:\n  " + "\n  ".join(bad)
        self.config["videos"][yt_id] = {"title": title, "duration": duration,
                                        "formats": formats, **info}
        self.save()

    def add_recorded(self, yt_id: str, files: dict | None = None, *, keep=None, **info) -> dict:
        """Offer a recorded real format list under its own id; `files` maps
        format ids to the files served for them (the rest can't be
        downloaded), `keep(format)` drops formats (an upload without AV1…).
        Returns the recording."""
        rec = recorded(yt_id)
        files = files or {}
        fmts = [{**f, "file": str(files[f["format_id"]]) if f["format_id"] in files else None}
                for f in rec["formats"] if keep is None or keep(f)]
        self.add(yt_id, fmts, title=rec["title"], duration=rec["duration"],
                 language=rec.get("language"), **info)
        return rec

    def update(self, yt_id: str, **info) -> None:
        self.config["videos"][yt_id].update(info)
        self.save()

    def fail(self, kind: str, stderr: str = "ERROR: boom\n", rc: int = 1, after: bool = False) -> None:
        """after=True: a download streams its whole file first, then fails."""
        self.config["faults"][kind] = {"stderr": stderr, "rc": rc, "after": after}
        self.save()

    def heal(self, kind: str) -> None:
        self.config["faults"].pop(kind, None)
        self.save()

    def gate(self, kind: str, at: float = 1.0) -> None:
        self.config["gates"][kind] = at
        self.save()

    def release(self, kind: str) -> None:
        (self.gate_dir / kind.replace(":", "_")).touch()

    def calls(self, prefix: str = "") -> list[dict]:
        try:
            lines = self.log.read_text().splitlines()
        except FileNotFoundError:
            return []
        return [c for c in map(json.loads, lines) if c["kind"].startswith(prefix)]

    def release_all(self) -> None:
        for kind in self.config["gates"]:
            self.release(kind)

    def alive(self) -> list[int]:
        """Pids of logged calls that still run (zombies count as gone)."""
        out = []
        for c in self.calls():
            try:
                with open(f"/proc/{c['pid']}/stat") as f:
                    if f.read().rsplit(")", 1)[1].split()[0] != "Z":
                        out.append(c["pid"])
            except (FileNotFoundError, ProcessLookupError):
                pass
        return out
