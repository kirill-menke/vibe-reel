"""Trailers for VibeReel's own player — YouTube → HLS on the NAS, via yt-dlp.

  POST /api/trailers/{key}              start (idempotent) -> status
  GET  /api/trailers/{key}              status
  GET  /api/trailers/{key}/{file}       index.m3u8, init.mp4, sNNN.m4s

{key} is the YouTube id — the best video up to 2160p (the TV) — or
`<id>@<height>` for the best up to that height: the iPhone asks for `@1080`,
a 4K trailer being ~150 MB for a screen that shows a fraction of it. Each
height is its own job and cache folder (named by the key, so the 2160p ones
from before keep their plain-id folders). The height rides in the path, not a
query, so the client's segment URLs (base + "/" + name) need no change.

status: { id, state, segments, buffered_s, duration, complete, width, height,
vcodec, title, error }; state is resolving | downloading | ready | error.

YouTube serves video and audio as separate DASH streams, and the TV's <video>
needs them muxed. A muxed MP4 written while it downloads has no length and no
index until it is finished — unplayable as a growing file. So the two streams
are remuxed (no re-encode, -c copy) into an **HLS event playlist** of fMP4
segments: the TV's pipeline plays HLS natively (VibeReel's burn-in path uses
it), a client can start after the first segments, and once the download ends
ffmpeg appends #EXT-X-ENDLIST and it is an ordinary seekable VOD.

Pipeline per trailer:

  1. `yt-dlp -j` once — the stream URLs (~2 s, mostly YouTube's player JS);
  2. video and audio downloaded in parallel with `--load-info-json` (no
     re-extraction), both piped straight into ffmpeg, which writes segments as
     they arrive — the first one ~3.9 s after the start (dev box).

The downloads go through yt-dlp rather than ffmpeg reading the URLs itself:
YouTube throttles a single long GET of a DASH stream to ~3x realtime and then
resets it (measured: the audio broke off mid-trailer); yt-dlp fetches in
ranged chunks and retries.

Formats: the best video up to 2160p (or the key's height) and the best
original-language audio (see VIDEO_FMT); a 4K VP9 trailer is ~13 Mbit/s, fine for the TV on 5 GHz. The
status carries `codecs`, the RFC 6381 string the client's MediaSource needs.

Finished trailers stay in the cache directory (LRU, CACHE_MAX_BYTES), so a
second play starts at once. yt-dlp breaks whenever YouTube changes things:
then the job ends in `error` and the client falls back to the YouTube app.
"""

import asyncio
import json
import logging
import os
import re
import shutil
import time
from pathlib import Path

import httpx

from fastapi.responses import FileResponse, JSONResponse, Response

log = logging.getLogger("reel_api")

KEY = re.compile(r"^([\w-]{11})(?:@(\d{3,4}))?$")
MAX_HEIGHT = 2160
MIN_HEIGHT = 144
FILE = re.compile(r"^(index\.m3u8|init\.mp4|s\d{3,5}\.m4s|subs\.vtt)$")
# The best there is, as plain DASH over https: yt-dlp's default order (resolution,
# fps, HDR, then codec AV1 > VP9 > H.264, then bitrate) within 2160p — the TV is
# 4K — or the height the key asks for ({h}). YouTube's HLS "Premium" variants are skipped: piped they arrived ~2x slower
# (4K VP9, measured: 2 segments after 5.3 s vs 3.1 s, whole 96 s trailer 25 s vs
# 15 s), and its HLS audio is flagged "Maybe DRM". Audio: yt-dlp prefers the
# original language — a dubbed trailer carries up to 8 tracks — then channels
# (an E-AC-3 5.1 track beats stereo), then codec. The TV's MSE takes AV1 (8/10
# bit), VP9 profile 0/2, H.264, AAC, Opus, AC-3 and E-AC-3 in MP4 (measured).
VIDEO_FMT = "bv*[protocol=https][height<={h}]"
AUDIO_FMT = "ba[protocol=https]"
SEGMENT_S = 4
MAX_DURATION = 20 * 60  # a "trailer" longer than this is not one
MAX_RUNNING = 2
# Bumped when the format choice changes: older cache entries are fetched again.
CACHE_VERSION = 3
CACHE_MAX_BYTES = 12 << 30  # 4K trailers are ~150 MB each
RESOLVE_TIMEOUT = 45
JOB_TIMEOUT = 300
ERROR_TTL = 120  # a failed trailer may be retried after this

CTYPE = {
    ".m3u8": "application/vnd.apple.mpegurl",
    ".mp4": "video/mp4",
    ".m4s": "video/iso.segment",
    ".vtt": "text/vtt; charset=utf-8",
}


def parse_key(key: str) -> tuple[str, int, str] | None:
    """`<id>` or `<id>@<height>` -> (yt_id, max height, canonical key), or None.
    A height at or above MAX_HEIGHT is the plain id (one job, one folder)."""
    m = KEY.match(key)
    if not m:
        return None
    h = int(m.group(2)) if m.group(2) else MAX_HEIGHT
    if h < MIN_HEIGHT:
        return None
    h = min(h, MAX_HEIGHT)
    return m.group(1), h, m.group(1) if h == MAX_HEIGHT else f"{m.group(1)}@{h}"


def _cache_root() -> Path:
    # systemd CacheDirectory= sets CACHE_DIRECTORY; dev runs use /tmp.
    base = os.environ.get("CACHE_DIRECTORY") or os.path.join(os.environ.get("TMPDIR", "/tmp"), "reel-api-cache")
    return Path(base.split(":")[0]) / "trailers"


class Job:
    def __init__(self, yt_id: str, root: Path, max_height: int = MAX_HEIGHT):
        self.id = yt_id
        self.max_height = max_height
        self.key = yt_id if max_height == MAX_HEIGHT else f"{yt_id}@{max_height}"
        self.dir = root / self.key
        self.state = "resolving"
        self.error: str | None = None
        self.duration: float | None = None
        self.title: str | None = None
        self.width: int | None = None
        self.height: int | None = None
        self.vcodec: str | None = None
        self.codecs: str | None = None
        self.hdr: str | None = None
        self.subs: dict | None = None  # {"lang": "en", "kind": manual|auto|translated}
        self.subs_done = False
        self.ended_at: float | None = None
        self.task: asyncio.Task | None = None

    def playlist(self) -> tuple[int, float, bool]:
        """(segments, seconds, complete) as written so far."""
        try:
            text = (self.dir / "index.m3u8").read_text()
        except OSError:
            return 0, 0.0, False
        durs = [float(m) for m in re.findall(r"#EXTINF:([\d.]+)", text)]
        return len(durs), round(sum(durs), 3), "#EXT-X-ENDLIST" in text

    def status(self) -> dict:
        segs, secs, complete = self.playlist()
        return {
            "id": self.id,
            "state": self.state,
            "segments": segs,
            "buffered_s": secs,
            "duration": self.duration,
            "complete": complete,
            "width": self.width,
            "height": self.height,
            "vcodec": self.vcodec,
            "codecs": self.codecs,
            "hdr": self.hdr,
            "subs": self.subs,
            "subs_done": self.subs_done,
            "title": self.title,
            "error": self.error,
        }


async def _run(*args: str, stdout=None, timeout: float) -> tuple[int, bytes, bytes]:
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=stdout or asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        proc.kill()
        await proc.wait()
        raise
    return proc.returncode, out or b"", err or b""


def mse_video_codec(fmt: dict) -> str:
    """The RFC 6381 codec string MediaSource wants. YouTube's DASH VP9 (webm)
    formats only say "vp9"/"vp9.2"; MSE needs vp09.PP.LL.DD — profile 2 and 10
    bit for HDR, a level by resolution (the TV accepts a generous level)."""
    vc = fmt.get("vcodec") or ""
    if vc.startswith(("av01.", "avc1.", "vp09.", "hev1.", "hvc1.")):
        return vc
    if vc.startswith("vp9"):
        hdr = vc == "vp9.2" or (fmt.get("dynamic_range") or "SDR") != "SDR"
        h = fmt.get("height") or 1080
        level = 51 if h > 1440 else 50 if h > 1080 else 41 if h > 720 else 31
        return f"vp09.{'02' if hdr else '00'}.{level}.{'10' if hdr else '08'}"
    return vc


def mse_audio_codec(fmt: dict) -> str:
    ac = (fmt.get("acodec") or "").lower()
    if ac.startswith("mp4a") or ac == "aac":
        return fmt.get("acodec") if "." in ac else "mp4a.40.2"
    if ac in ("ec-3", "eac3"):
        return "ec-3"
    if ac in ("ac-3", "ac3"):
        return "ac-3"
    return ac  # "opus", "flac"


def _ts(ms: int) -> str:
    h, ms = divmod(int(ms), 3_600_000)
    m, ms = divmod(ms, 60_000)
    sec, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{sec:02d}.{ms:03d}"


def _json3_to_vtt(data: dict) -> str:
    """YouTube auto captions (json3) -> VTT with one cue per spoken line, each
    ending when the next begins. Append events (aAppend) are the rolling
    display's line breaks and carry no text."""
    lines = []
    for ev in data.get("events") or []:
        if ev.get("aAppend") or "segs" not in ev:
            continue
        text = "".join(sg.get("utf8", "") for sg in ev["segs"]).strip()
        if not text:
            continue
        start = int(ev.get("tStartMs") or 0)
        lines.append([start, start + int(ev.get("dDurationMs") or 3000), text])
    for i in range(len(lines) - 1):
        lines[i][1] = min(lines[i][1], lines[i + 1][0])
    cues = [f"{_ts(a)} --> {_ts(b)}\n{t}" for a, b, t in lines if b > a]
    return "WEBVTT\n\n" + "\n\n".join(cues) + "\n" if cues else ""


def _last_line(err: bytes) -> str:
    lines = [l for l in err.decode(errors="replace").splitlines() if l.strip()]
    return (lines[-1] if lines else "failed")[:300]


class Trailers:
    def __init__(self):
        self.root = _cache_root()
        self.jobs: dict[str, Job] = {}
        self._sem = asyncio.Semaphore(MAX_RUNNING)

    def _ytdlp(self) -> list[str]:
        exe = shutil.which("yt-dlp")
        if exe is None:
            raise RuntimeError("yt-dlp not on PATH")
        return [exe, "--no-cache-dir", "--no-warnings", "--no-playlist", "--quiet"]

    def _from_disk(self, yt_id: str, max_height: int) -> Job | None:
        """A trailer finished by an earlier process (the cache outlives restarts)."""
        job = Job(yt_id, self.root, max_height)
        d = job.dir
        if not (d / "done").exists():
            return None
        try:
            meta = json.loads((d / "done").read_text())
        except (OSError, ValueError):
            meta = {}
        if meta.get("v") != CACHE_VERSION:
            return None  # an older format (1080p H.264 only): fetch it again
        for k in ("duration", "title", "width", "height", "vcodec", "codecs", "hdr", "subs"):
            setattr(job, k, meta.get(k))
        job.subs_done = True
        job.state = "ready"
        return job

    def get(self, key: str) -> Job | None:
        """The job for a trailer key (see parse_key), or None (unknown / malformed)."""
        parsed = parse_key(key)
        if parsed is None:
            return None
        yt_id, max_height, key = parsed
        job = self.jobs.get(key)
        if job is None:
            job = self._from_disk(yt_id, max_height)
            if job:
                self.jobs[key] = job
        return job

    def start(self, key: str) -> Job:
        parsed = parse_key(key)
        if parsed is None:
            raise ValueError("not a trailer key: " + key)
        yt_id, max_height, key = parsed
        job = self.get(key)
        if job and not (job.state == "error" and time.monotonic() - (job.ended_at or 0) > ERROR_TTL):
            if job.state == "ready":
                os.utime(job.dir)  # LRU
            return job
        job = Job(yt_id, self.root, max_height)
        self.jobs[key] = job
        job.task = asyncio.create_task(self._work(job))
        return job

    async def _work(self, job: Job) -> None:
        try:
            async with self._sem:
                await asyncio.wait_for(self._fetch(job), JOB_TIMEOUT)
            job.state = "ready"
            (job.dir / "done").write_text(json.dumps({
                "v": CACHE_VERSION,
                "duration": job.duration, "title": job.title, "width": job.width,
                "height": job.height, "vcodec": job.vcodec, "codecs": job.codecs, "hdr": job.hdr,
                "subs": job.subs,
            }))
            self._evict()
        except Exception as e:  # noqa: BLE001 — every failure is the job's answer
            job.state = "error"
            job.error = str(e) or type(e).__name__
            log.warning("trailer %s: %s", job.key, job.error)
            shutil.rmtree(job.dir, ignore_errors=True)
        finally:
            job.ended_at = time.monotonic()

    async def _fetch(self, job: Job) -> None:
        shutil.rmtree(job.dir, ignore_errors=True)
        job.dir.mkdir(parents=True, exist_ok=True)
        url = "https://www.youtube.com/watch?v=" + job.id
        base = self._ytdlp()

        # 1. one extraction; both downloads reuse it
        video_fmt = VIDEO_FMT.format(h=job.max_height)
        rc, out, err = await _run(*base, "-j", "-f", f"({video_fmt})+({AUDIO_FMT})", url, timeout=RESOLVE_TIMEOUT)
        if rc != 0:
            raise RuntimeError("yt-dlp: " + _last_line(err))
        info = json.loads(out)
        dur = info.get("duration") or 0
        if dur > MAX_DURATION:
            raise RuntimeError(f"too long for a trailer ({dur} s)")
        req = info.get("requested_formats") or []
        if len(req) != 2:
            raise RuntimeError("no separate video + audio streams offered")
        v, a = (req[0], req[1]) if req[0].get("vcodec") != "none" else (req[1], req[0])
        job.duration = dur or None
        job.title = info.get("title")
        job.width, job.height, job.vcodec = v.get("width"), v.get("height"), v.get("vcodec")
        job.hdr = v.get("dynamic_range") if v.get("dynamic_range") not in (None, "SDR") else None
        job.codecs = mse_video_codec(v) + "," + mse_audio_codec(a)
        info_path = job.dir / "info.json"
        info_path.write_text(json.dumps(info))
        job.state = "downloading"
        subs_task = asyncio.create_task(self._subs(job, info))

        # 2+3. video and audio downloaded in parallel, each piped into ffmpeg
        # (video on its stdin, audio on an extra fd), which writes segments as
        # both arrive. Fetching the audio first cost ~1 s before the first
        # segment (measured: first segment 3.9 s after the start, vs ~5 s).
        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg is None:
            raise RuntimeError("ffmpeg not on PATH")
        procs: list = []
        fds: list[int] = []
        try:
            v_r, v_w = os.pipe()
            fds += [v_r, v_w]
            a_r, a_w = os.pipe()
            fds += [a_r, a_w]

            async def dl(fmt: str, w: int):
                return await asyncio.create_subprocess_exec(
                    *base, "--load-info-json", str(info_path), "-f", fmt, "-o", "-",
                    stdout=w, stderr=asyncio.subprocess.PIPE,
                )

            procs.append(await dl(v["format_id"], v_w))
            procs.append(await dl(a["format_id"], a_w))
            procs.append(await asyncio.create_subprocess_exec(
                ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
                "-i", "pipe:0", "-i", f"pipe:{a_r}",
                "-map", "0:v:0", "-map", "1:a:0", "-c", "copy",
                "-f", "hls", "-hls_time", str(SEGMENT_S), "-hls_playlist_type", "event",
                "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
                "-hls_segment_filename", str(job.dir / "s%03d.m4s"),
                str(job.dir / "index.m3u8"),
                stdin=v_r, pass_fds=(a_r,), stderr=asyncio.subprocess.PIPE,
            ))
        except BaseException:
            for p in procs:
                if p.returncode is None:
                    p.kill()
            raise
        finally:
            # The children hold their own ends; ours would keep ffmpeg's inputs
            # open past the downloads' exit, and it would never see EOF.
            for fd in fds:
                os.close(fd)
        try:
            results = await asyncio.gather(*(p.communicate() for p in procs))
        except asyncio.CancelledError:
            for p in procs:
                if p.returncode is None:
                    p.kill()
            raise
        for p, (_, err), what in zip(procs, results, ("video", "audio", "ffmpeg")):
            if p.returncode != 0:
                raise RuntimeError(f"{what}: " + _last_line(err))
        await subs_task  # never raises; seconds at most
        _, _, complete = job.playlist()
        if not complete:
            raise RuntimeError("playlist not finished")
        info_path.unlink(missing_ok=True)  # holds signed URLs; no use any more

    async def _subs(self, job: Job, info: dict) -> None:
        """English subtitles to subs.vtt, if YouTube has any — VibeReel shows
        them by default. An uploaded track (clean VTT, used as is) beats
        YouTube's auto captions; those come as json3 (one event per spoken
        line) and are rebuilt into one-line cues, because their VTT form is the
        rolling "karaoke" kind with every line shown twice. For a non-English
        video the auto track is YouTube's machine translation. Best effort: any
        failure just means no subtitles."""
        try:
            manual = {k: v for k, v in (info.get("subtitles") or {}).items()
                      if k == "en" or k.startswith("en-")}
            auto = info.get("automatic_captions") or {}
            pick = None
            for k in sorted(manual, key=lambda k: (k not in ("en", "en-US", "en-GB"), k)):
                url = next((f["url"] for f in manual[k] if f.get("ext") == "vtt"), None)
                if url:
                    pick = ("manual", url)
                    break
            if pick is None:
                for k, kind in (("en-orig", "auto"), ("en", "auto")):
                    url = next((f["url"] for f in auto.get(k) or [] if f.get("ext") == "json3"), None)
                    if url:
                        orig = (info.get("language") or "en").startswith("en") or k == "en-orig"
                        pick = ("json3", url, kind if orig else "translated")
                        break
            if pick is None:
                return
            async with httpx.AsyncClient(timeout=15) as http:
                r = await http.get(pick[1])
                r.raise_for_status()
            if pick[0] == "manual":
                text = r.text
                if not text.lstrip("\ufeff").startswith("WEBVTT"):
                    return
                kind = "manual"
            else:
                text = _json3_to_vtt(r.json())
                kind = pick[2]
                if not text:
                    return
            (job.dir / "subs.vtt").write_text(text)
            job.subs = {"lang": "en", "kind": kind}
        except Exception as e:  # noqa: BLE001
            log.info("trailer %s: no subtitles (%s)", job.key, e)
        finally:
            job.subs_done = True

    def _evict(self) -> None:
        """Drop the least recently played finished trailers above CACHE_MAX_BYTES."""
        try:
            dirs = [d for d in self.root.iterdir() if (d / "done").exists()]
        except OSError:
            return
        sized = []
        for d in dirs:
            size = sum(f.stat().st_size for f in d.iterdir() if f.is_file())
            sized.append((d.stat().st_mtime, size, d))
        total = sum(s for _, s, _ in sized)
        for _, size, d in sorted(sized):
            if total <= CACHE_MAX_BYTES:
                break
            job = self.jobs.get(d.name)
            if job and job.state != "ready":
                continue
            shutil.rmtree(d, ignore_errors=True)
            self.jobs.pop(d.name, None)
            total -= size

    def file_response(self, key: str, name: str):
        job = self.get(key)
        path = job.dir / name if job else None
        if job is None or job.state == "error" or not path.is_file():
            return JSONResponse(status_code=404, content={"error": "not_found", "detail": "no such trailer file"})
        if name.endswith(".m3u8"):
            # While it grows, the TV's player treats the event playlist as live
            # and joins ~5 s in, at the "live edge" (measured). EXT-X-START
            # pins the start to 0. The playlist changes: never cache it.
            text = path.read_text()
            if "#EXT-X-START" not in text:
                text = text.replace("#EXTM3U\n", "#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n", 1)
            return Response(text, media_type=CTYPE[".m3u8"], headers={"Cache-Control": "no-store"})
        return FileResponse(path, media_type=CTYPE[path.suffix], headers={"Cache-Control": "max-age=86400"})
