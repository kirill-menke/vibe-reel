"""Watch-while-downloading for the iPhone: the growing download as HLS fMP4.

  POST /api/downloads/{gid}/hls?audio=N        start (or join) -> status
  GET  /api/downloads/{gid}/hls?audio=N        status
  GET  /api/downloads/{gid}/hls/{audio}/{file} index.m3u8 | init.mp4 | sNNNNN.m4s

status: { id, audio, state, segments, buffered_s, duration, complete,
codecs, video, error, progress }; state is probing | remuxing | done | error.

The TV plays the growing MKV as it is (streaming.py: Range requests that wait
at the download frontier). iOS Safari can't play an MKV at all, and its media
stack wants either a finished MP4 or HLS. So here the same frontier-aware
reader feeds ffmpeg on a pipe, and ffmpeg remuxes — video copied, audio copied
when the phone can take it (AAC, AC-3, E-AC-3), else converted like Jellyfin
does for the phone (DTS/TrueHD/FLAC/Opus… -> AC-3 5.1 640k, or AAC for
stereo) — into an HLS *event* playlist of fMP4 segments that grows with the
download (-hls_playlist_type event; #EXT-X-ENDLIST once the file is complete).

The phone does not hand this playlist to Safari's HLS player: a growing event
playlist is "live" to it (starts near the end, infinite duration). It feeds
the segments into a (Managed)MediaSource itself — src/lib/segfeed.js in
VibeReel, the trailer approach — with the duration from ffprobe up front, so
the scrubber shows the whole film and a seek past what exists waits there.

The pipe reads the file from byte 0 at whatever pace the pieces arrive; a
torrent that is already further along is remuxed at disk speed up to the
frontier. A job serves one (download, audio track); picking another audio
track starts a second job, and the first is dropped. The remux lives in the
cache directory: jobs nobody has asked about for IDLE_S are stopped and their
files deleted (a whole film's remux is as large as the film), and the total is
capped at CACHE_MAX_BYTES.

Video: H.264 and HEVC (tagged hvc1; Dolby Vision profile 5, which has no HDR10
base layer, keeps its DV signalling as dvh1 + dvcC; other DV profiles play as
their HDR10 base layer). Anything else answers `unsupported_video`.
"""

import asyncio
import json
import logging
import os
import re
import shutil
import time
from pathlib import Path

from fastapi import APIRouter, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response

from . import streaming

log = logging.getLogger("reel_api")

SEGMENT_S = 6
IDLE_S = 10 * 60
CACHE_MAX_BYTES = 300 << 30
READ_CHUNK = 4 << 20
PIECE_POLL = 1.0
STALL_GIVE_UP_S = 30 * 60     # frontier frozen this long with nobody watching: stop
HEADER_BYTES = 8 << 20
FILE = re.compile(r"^(index\.m3u8|init\.mp4|s\d{5}\.m4s)$")
GID = re.compile(r"^[0-9a-fA-F]{40}$")
COPY_AUDIO = {"aac", "ac3", "eac3"}

CTYPE = {".m3u8": "application/vnd.apple.mpegurl", ".mp4": "video/mp4", ".m4s": "video/iso.segment"}

router = APIRouter()
_qb_getter = None  # () -> the qBittorrent client (app.py's), set by register()


def _root() -> Path:
    base = os.environ.get("CACHE_DIRECTORY") or os.path.join(os.environ.get("TMPDIR", "/tmp"), "reel-api-cache")
    return Path(base.split(":")[0]) / "livehls"


def _h264(s: dict) -> str | None:
    prof = {"baseline": 0x42, "constrained baseline": 0x42, "main": 0x4D, "high": 0x64, "high 10": 0x6E}.get(
        (s.get("profile") or "").lower())
    lvl = s.get("level")
    if not prof or not isinstance(lvl, int) or lvl <= 0:
        return "avc1.640028"
    cons = 0x40 if (s.get("profile") or "").lower() == "constrained baseline" else 0
    return f"avc1.{prof:02X}{cons:02X}{lvl:02X}"


def _dovi(s: dict) -> dict | None:
    for sd in s.get("side_data_list") or []:
        if "DOVI" in (sd.get("side_data_type") or "").upper():
            return sd
    return None


def _hevc(s: dict, dv5: bool) -> str:
    lvl = s.get("level") if isinstance(s.get("level"), int) and s.get("level") > 0 else 153
    if dv5:
        return "dvh1.05.06"
    main10 = "10" in (s.get("profile") or "") or (s.get("pix_fmt") or "").endswith("10le")
    return f"hvc1.2.4.L{lvl}.B0" if main10 else f"hvc1.1.6.L{lvl}.B0"


def _aac(s: dict) -> str:
    p = (s.get("profile") or "").lower()
    return "mp4a.40.29" if "he-aacv2" in p else "mp4a.40.5" if "he-aac" in p else "mp4a.40.2"


class Job:
    def __init__(self, gid: str, audio: int):
        self.gid = gid
        self.audio = audio
        self.key = f"{gid}:{audio}"
        self.dir = _root() / f"{gid}-{audio}"
        self.state = "probing"
        self.error: str | None = None
        self.duration: float | None = None
        self.codecs: str | None = None
        self.video: dict | None = None
        self.audio_out: str | None = None
        self.progress: float | None = None
        self.touched = time.monotonic()
        self.task: asyncio.Task | None = None
        self.proc: asyncio.subprocess.Process | None = None

    def playlist(self) -> tuple[int, float, bool]:
        try:
            text = (self.dir / "index.m3u8").read_text()
        except OSError:
            return 0, 0.0, False
        durs = [float(m) for m in re.findall(r"#EXTINF:([\d.]+)", text)]
        return len(durs), round(sum(durs), 3), "#EXT-X-ENDLIST" in text

    def status(self) -> dict:
        segs, secs, complete = self.playlist()
        return {
            "id": self.gid,
            "audio": self.audio,
            "state": self.state,
            "segments": segs,
            "buffered_s": secs,
            "duration": self.duration,
            "complete": complete,
            "codecs": self.codecs,
            "video": self.video,
            "audio_codec": self.audio_out,
            "progress": self.progress,
            "error": self.error,
        }


class LiveHls:
    def __init__(self):
        self.jobs: dict[str, Job] = {}
        self.reaper: asyncio.Task | None = None

    def get(self, gid: str, audio: int) -> Job | None:
        j = self.jobs.get(f"{gid}:{audio}")
        if j:
            j.touched = time.monotonic()
        return j

    def start(self, qb, gid: str, audio: int) -> Job:
        if self.reaper is None:
            shutil.rmtree(_root(), ignore_errors=True)  # left over from before a restart
            self.reaper = asyncio.create_task(self._reap())
        job = self.get(gid, audio)
        if job and job.state != "error":
            return job
        # one job per download: another audio track replaces the running one
        for k, other in list(self.jobs.items()):
            if other.gid == gid:
                self._drop(other)
        job = Job(gid, audio)
        self.jobs[job.key] = job
        job.task = asyncio.create_task(self._run(qb, job))
        return job

    def _drop(self, job: Job) -> None:
        self.jobs.pop(job.key, None)
        if job.task and not job.task.done():
            job.task.cancel()
        shutil.rmtree(job.dir, ignore_errors=True)

    async def _reap(self) -> None:
        while True:
            await asyncio.sleep(60)
            now = time.monotonic()
            for job in list(self.jobs.values()):
                if now - job.touched > IDLE_S:
                    log.info("livehls %s: idle, dropped", job.key)
                    self._drop(job)
            # cap: oldest-touched finished/errored first, then anything idle > 2 min
            try:
                sizes = {j.key: sum(f.stat().st_size for f in j.dir.iterdir()) for j in self.jobs.values() if j.dir.exists()}
            except OSError:
                continue
            total = sum(sizes.values())
            for job in sorted(self.jobs.values(), key=lambda j: j.touched):
                if total <= CACHE_MAX_BYTES:
                    break
                if now - job.touched > 120:
                    total -= sizes.get(job.key, 0)
                    self._drop(job)

    # ---------------- the pipeline ----------------

    async def _run(self, qb, job: Job) -> None:
        try:
            info = await self._wait_file(qb, job)
            probe = await self._probe(qb, job, info)
            args = self._ffmpeg_args(job, probe)
            await self._remux(qb, job, info, args)
            job.state = "done"
        except asyncio.CancelledError:
            if job.proc and job.proc.returncode is None:
                job.proc.kill()
            raise
        except Exception as e:  # noqa: BLE001 — the job's answer
            job.state = "error"
            job.error = str(e) or type(e).__name__
            log.warning("livehls %s: %s", job.key, job.error)
            if job.proc and job.proc.returncode is None:
                job.proc.kill()

    async def _wait_file(self, qb, job: Job) -> dict:
        t0 = time.monotonic()
        while True:
            try:
                info = await streaming._main_file(qb, job.gid)
            except streaming.NotReady:
                info = False
            if info is None:
                raise RuntimeError("no such download")
            if info:
                if info["state"] in ("queuedDL", "stoppedDL", "pausedDL", "stalledDL"):
                    try:
                        await qb.force_start(job.gid)  # watching it is the priority signal
                    except Exception as e:  # noqa: BLE001
                        log.warning("livehls %s: force-start failed: %s", job.key, e)
                return info
            if time.monotonic() - t0 > 120:
                raise RuntimeError("the download has not started yet")
            await asyncio.sleep(2)

    async def _probe(self, qb, job: Job, info: dict) -> dict:
        ps, off = info["piece_size"], info["offset"]
        p0, p1 = off // ps, (off + min(HEADER_BYTES, info["size"]) - 1) // ps
        t0 = time.monotonic()
        while True:
            try:
                states = await qb.piece_states(job.gid)
            except Exception:  # noqa: BLE001
                states = []
            if streaming._pieces_ready(states, p0, p1):
                break
            if time.monotonic() - t0 > 180:
                raise RuntimeError("the start of the file has not downloaded yet")
            await asyncio.sleep(PIECE_POLL)
        exe = shutil.which("ffprobe")
        if exe is None:
            raise RuntimeError("ffprobe not on PATH")
        proc = await asyncio.create_subprocess_exec(
            exe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", info["path"],
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, _ = await asyncio.wait_for(proc.communicate(), 30)
        data = json.loads(out or b"{}")
        fmt = data.get("format") or {}
        job.duration = float(fmt["duration"]) if fmt.get("duration") else None
        return data

    def _ffmpeg_args(self, job: Job, data: dict) -> list[str]:
        streams = data.get("streams") or []
        v = next((s for s in streams if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")), None)
        if v is None:
            raise RuntimeError("no video stream")
        a = next((s for s in streams if s.get("codec_type") == "audio" and s.get("index") == job.audio), None)
        if a is None:
            a = next((s for s in streams if s.get("codec_type") == "audio" and (s.get("disposition") or {}).get("default")), None) \
                or next((s for s in streams if s.get("codec_type") == "audio"), None)
        vcodec = v.get("codec_name")
        dv = _dovi(v)
        dv5 = bool(dv and dv.get("dv_profile") == 5)
        vargs = ["-map", f"0:{v['index']}", "-c:v", "copy"]
        if vcodec == "h264":
            vstr = _h264(v)
        elif vcodec == "hevc":
            vstr = _hevc(v, dv5)
            vargs += ["-tag:v", "dvh1", "-strict", "unofficial"] if dv5 else ["-tag:v", "hvc1"]
        else:
            raise RuntimeError(f"unsupported_video: {vcodec}")
        job.video = {"codec": vcodec, "width": v.get("width"), "height": v.get("height"),
                     "dv_profile": dv.get("dv_profile") if dv else None}
        aargs: list[str] = []
        astr = None
        if a is not None:
            ac = a.get("codec_name")
            ch = a.get("channels") or 2
            aargs = ["-map", f"0:{a['index']}"]
            if ac in COPY_AUDIO:
                aargs += ["-c:a", "copy"]
                astr = {"aac": _aac(a), "ac3": "ac-3", "eac3": "ec-3"}[ac]
                job.audio_out = ac
            elif ch > 2:
                aargs += ["-c:a", "ac3", "-b:a", "640k", "-ac", "6"]
                astr, job.audio_out = "ac-3", "ac3"
            else:
                aargs += ["-c:a", "aac", "-b:a", "256k", "-ac", "2"]
                astr, job.audio_out = "mp4a.40.2", "aac"
        job.codecs = vstr + ("," + astr if astr else "")
        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg is None:
            raise RuntimeError("ffmpeg not on PATH")
        return [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
            "-fflags", "+genpts", "-i", "pipe:0",
            *vargs, *aargs, "-sn", "-dn",
            "-max_muxing_queue_size", "4096",
            "-f", "hls", "-hls_time", str(SEGMENT_S), "-hls_playlist_type", "event",
            "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
            "-hls_flags", "independent_segments+temp_file",
            "-hls_segment_filename", str(job.dir / "s%05d.m4s"),
            str(job.dir / "index.m3u8"),
        ]

    async def _remux(self, qb, job: Job, info: dict, args: list[str]) -> None:
        shutil.rmtree(job.dir, ignore_errors=True)
        job.dir.mkdir(parents=True, exist_ok=True)
        job.state = "remuxing"
        job.proc = await asyncio.create_subprocess_exec(
            *args, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        err_task = asyncio.create_task(job.proc.stderr.read())
        ps, off, size = info["piece_size"], info["offset"], info["size"]
        pos = 0
        states: list = []
        fetched = 0.0
        moved = time.monotonic()
        gone = False
        f = open(info["path"], "rb")
        try:
            while pos < size:
                if job.proc.returncode is not None:
                    break
                n = min(READ_CHUNK, size - pos)
                p0, p1 = (off + pos) // ps, (off + pos + n - 1) // ps
                if not gone and not streaming._pieces_ready(states, p0, p1):
                    if time.monotonic() - fetched >= PIECE_POLL:
                        fetched = time.monotonic()
                        try:
                            states = await qb.piece_states(job.gid)
                            if states:
                                job.progress = round(sum(1 for s in states if s == 2) / len(states), 4)
                        except Exception:  # noqa: BLE001 — gone from the client, or it hiccuped
                            row = None
                            try:
                                row = await qb.raw_info(job.gid)
                            except Exception:  # noqa: BLE001
                                row = False
                            if row is None:
                                # left the client: imported (complete) or removed
                                if (job.progress or 0) >= 0.999:
                                    gone = True
                                    continue
                                raise RuntimeError("the download left the queue")
                            states = []
                    if not streaming._pieces_ready(states, p0, p1):
                        if time.monotonic() - moved > STALL_GIVE_UP_S and time.monotonic() - job.touched > IDLE_S:
                            raise RuntimeError("the download stalled")
                        await asyncio.sleep(PIECE_POLL)
                        continue
                data = await asyncio.to_thread(streaming._read_at, f, pos, n)
                if not data:
                    await asyncio.sleep(PIECE_POLL)  # the incomplete -> complete move
                    continue
                job.proc.stdin.write(data)
                await job.proc.stdin.drain()
                pos += len(data)
                moved = time.monotonic()
            job.proc.stdin.close()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            f.close()
        rc = await job.proc.wait()
        err = (await err_task).decode(errors="replace").strip().splitlines()
        if rc != 0:
            raise RuntimeError("ffmpeg: " + (err[-1] if err else f"exit {rc}"))
        job.progress = 1.0

    # ---------------- HTTP ----------------

    def file_response(self, gid: str, audio: int, name: str):
        job = self.get(gid, audio)
        path = job.dir / name if job else None
        if job is None or path is None or not path.is_file():
            return JSONResponse(status_code=404, content={"error": "not_found", "detail": "no such segment (yet)"})
        if name.endswith(".m3u8"):
            text = path.read_text()
            if "#EXT-X-START" not in text:
                text = text.replace("#EXTM3U\n", "#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n", 1)
            return Response(text, media_type=CTYPE[".m3u8"], headers={"Cache-Control": "no-store"})
        return FileResponse(path, media_type=CTYPE[path.suffix], headers={"Cache-Control": "no-store"})


live = LiveHls()


def register(qb_getter) -> None:
    """app.py: hand over how to get the qBittorrent client (built at startup)."""
    global _qb_getter
    _qb_getter = qb_getter


def _bad(detail: str, code: int = 400):
    return JSONResponse(status_code=code, content={"error": "bad_request", "detail": detail})


@router.post("/api/downloads/{gid}/hls")
async def hls_start(gid: str, audio: int = Query(-1, ge=-1, le=200)):
    if not GID.match(gid):
        return _bad("bad download id")
    qb = _qb_getter() if _qb_getter else None
    if qb is None:
        return JSONResponse(status_code=503, content={"error": "temporarily_unavailable", "detail": "streaming needs the qBittorrent backend"})
    return live.start(qb, gid.lower(), audio).status()


@router.get("/api/downloads/{gid}/hls")
async def hls_status(gid: str, audio: int = Query(-1, ge=-1, le=200)):
    job = live.get(gid.lower(), audio)
    if job is None:
        return JSONResponse(status_code=404, content={"error": "not_found", "detail": "not started"})
    return job.status()


@router.get("/api/downloads/{gid}/hls/{audio}/{name}")
async def hls_file(gid: str, audio: int, name: str):
    if not GID.match(gid) or not FILE.match(name):
        return JSONResponse(status_code=404, content={"error": "not_found", "detail": "no such file"})
    return live.file_response(gid.lower(), audio, name)
