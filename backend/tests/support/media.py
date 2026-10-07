"""Tiny real media files, generated with ffmpeg's lavfi sources (nothing binary
is committed). Used by the probe / livehls / streaming tests.

    make_media(path, video="hevc", audio=[Audio("eac3", 6, "eng", default=True), ...])

Defaults: 2 s of 320x180 testsrc2 at 24 fps, H.264, three audio tracks
(E-AC-3 5.1 eng default, AC-3 stereo ger, AAC stereo eng "Commentary"), one
SRT subtitle, two chapters ("Intro", "Chapter 02"). Generation takes well
under a second per file; the session fixtures in conftest.py build each
variant once.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
HAVE_FFMPEG = bool(FFMPEG and FFPROBE)

_VCODEC = {
    "h264": ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"],
    "hevc": ["-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
             "-x265-params", "log-level=error"],
}
_LAYOUT = {1: "mono", 2: "stereo", 6: "5.1"}


@dataclass
class Audio:
    codec: str  # aac | ac3 | eac3 | opus | flac ...
    channels: int = 2
    lang: str | None = "eng"
    title: str | None = None
    default: bool = False


@dataclass
class Sub:
    lang: str = "eng"
    title: str | None = None
    forced: bool = False
    default: bool = False


DEFAULT_AUDIO = (
    Audio("eac3", 6, "eng", default=True),
    Audio("ac3", 2, "ger"),
    Audio("aac", 2, "eng", title="Commentary"),
)


@dataclass
class Spec:
    video: str | None = "h264"
    audio: tuple[Audio, ...] = DEFAULT_AUDIO
    subs: tuple[Sub, ...] = (Sub(),)
    chapters: tuple[tuple[float, str], ...] = ((0.0, "Intro"), (1.0, "Chapter 02"))
    duration: float = 2.0
    size: str = "320x180"
    fps: int = 24
    extra: list[str] = field(default_factory=list)


def cbr(rate: str = "40M") -> list[str]:
    """Spec.extra for an H.264 file padded to a constant bitrate (x264 filler
    NALs): ``Spec(extra=cbr("40M"), duration=3)`` is ~15 MB — big enough for
    multi-piece / multi-CHUNK streaming tests, generated in ~0.2 s."""
    return ["-b:v", rate, "-minrate", rate, "-maxrate", rate, "-bufsize", "2M",
            "-x264-params", "nal-hrd=cbr"]


def _chapters_file(path: Path, chapters, duration: float) -> Path:
    meta = path.with_suffix(".ffmeta")
    lines = [";FFMETADATA1"]
    for i, (start, title) in enumerate(chapters):
        end = chapters[i + 1][0] if i + 1 < len(chapters) else duration
        lines += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={int(start * 1000)}",
                  f"END={int(end * 1000)}", f"title={title}"]
    meta.write_text("\n".join(lines) + "\n")
    return meta


def make_media(path: Path, spec: Spec | None = None) -> Path:
    if not HAVE_FFMPEG:
        raise RuntimeError("ffmpeg/ffprobe not on PATH")
    spec = spec or Spec()
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    args = [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
    maps: list[str] = []
    n = 0
    if spec.video:
        args += ["-f", "lavfi", "-i", f"testsrc2=size={spec.size}:rate={spec.fps}:duration={spec.duration}"]
        maps += ["-map", f"{n}:v"]
        n += 1
    for i, a in enumerate(spec.audio):
        layout = _LAYOUT.get(a.channels, "stereo")
        args += ["-f", "lavfi", "-i",
                 f"sine=frequency={300 + 100 * i}:sample_rate=48000:duration={spec.duration},"
                 f"aformat=channel_layouts={layout}"]
        maps += ["-map", f"{n}:a"]
        n += 1
    srt = None
    if spec.subs:
        srt = path.with_suffix(".srt")
        srt.write_text("1\n00:00:00,000 --> 00:00:01,000\nHello\n\n2\n00:00:01,000 --> 00:00:02,000\nWorld\n")
        for _ in spec.subs:
            args += ["-i", str(srt)]
            maps += ["-map", f"{n}:s"]
            n += 1
    meta_idx = None
    if spec.chapters:
        meta = _chapters_file(path, spec.chapters, spec.duration)
        args += ["-f", "ffmetadata", "-i", str(meta)]
        meta_idx = n
        n += 1
    args += maps
    if meta_idx is not None:
        args += ["-map_chapters", str(meta_idx)]
    if spec.video:
        args += _VCODEC[spec.video]
    for i, a in enumerate(spec.audio):
        args += [f"-c:a:{i}", a.codec, f"-ac:a:{i}", str(a.channels)]
        if a.lang:
            args += [f"-metadata:s:a:{i}", f"language={a.lang}"]
        if a.title:
            args += [f"-metadata:s:a:{i}", f"title={a.title}"]
        args += [f"-disposition:a:{i}", "default" if a.default else "0"]
    for i, s in enumerate(spec.subs):
        args += [f"-c:s:{i}", "srt" if path.suffix == ".mkv" else "mov_text",
                 f"-metadata:s:s:{i}", f"language={s.lang}"]
        if s.title:
            args += [f"-metadata:s:s:{i}", f"title={s.title}"]
        disp = "+".join(d for d, on in (("default", s.default), ("forced", s.forced)) if on) or "0"
        args += [f"-disposition:s:{i}", disp]
    args += spec.extra + ["-t", str(spec.duration), str(path)]
    subprocess.run(args, check=True, capture_output=True, timeout=60)
    if srt is not None:
        srt.unlink(missing_ok=True)
    path.with_suffix(".ffmeta").unlink(missing_ok=True)
    return path


def ffprobe(path: Path) -> dict:
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-print_format", "json", "-show_format", "-show_streams",
         "-show_chapters", str(path)],
        check=True, capture_output=True, timeout=30,
    ).stdout
    return json.loads(out)
