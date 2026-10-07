"""Watch-while-downloading: HTTP Range streaming of a torrent's main video
file straight out of the download directory, plus ffprobe of the partial file
for track metadata.

This works because the arrs' torrents are forced sequential (app.py's activity
poll, with first/last-piece priority): the file grows linearly from the
front, so a player following behind the frontier reads
contiguous bytes. A range covered by downloaded pieces is served immediately;
a range at the frontier waits (bounded) for the pieces to land; a completed
torrent behaves like a plain file server. First/last-piece priority means the
container index that some muxers put at the end of the file is available
early, so probing and duration/seeking work minutes into the download.

The open file descriptor survives qBittorrent's incomplete/ -> complete/ move:
both live on the same filesystem (deliberately — see the NAS arr config), so
the move is a rename(2) and the fd keeps reading the same inode. A body still
waiting for its first window has no fd yet: it looks the file up again (_open).
"""

import asyncio
import json
import logging
import os
import shutil
import time

from fastapi import Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

log = logging.getLogger("reel_api")

VIDEO_EXT = (".mkv", ".mp4", ".m4v", ".mov", ".ts", ".webm", ".avi")
CTYPE = {
    ".mkv": "video/x-matroska",
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".ts": "video/mp2t",
    ".webm": "video/webm",
    ".avi": "video/x-msvideo",
}

CHUNK = 1 << 20  # read/yield unit
PIECE_POLL = 1.0  # seconds between piece-availability re-checks
PIECE_WAIT_MAX = 120  # close the stream if the frontier stalls this long
PROBE_MIN_BYTES = 4 << 20  # header bytes required before ffprobe is attempted
PROBE_TIMEOUT = 20


class NotReady(Exception):
    """The torrent has no resolved video file (or header) yet."""


def _not_ready(detail: str):
    return JSONResponse(
        status_code=409,
        headers={"Retry-After": "10"},
        content={"error": "not_ready", "detail": detail},
    )


def _not_found():
    return JSONResponse(
        status_code=404, content={"error": "not_found", "detail": "no such download"}
    )


# hash -> generation. A new stream for a hash bumps this; the superseded
# generator notices on its next chunk and exits. One TV, one player: an
# abandoned connection (webOS keeps the old media socket around after Back)
# must never compete with the playback the user just started.
_stream_gen: dict[str, int] = {}


def _read_at(f, pos: int, n: int) -> bytes:
    """One positioned read — runs in a worker thread (asyncio.to_thread), so
    disk latency and full-speed pumping never block the event loop. That
    starvation was measurable: an aborted stream draining into a dead socket
    froze every other request for ~30 s."""
    f.seek(pos)
    return f.read(n)


async def _main_file(qb, gid: str) -> dict | None:
    """Locate the torrent's main video file on disk. Returns None for an
    unknown hash; raises NotReady while metadata hasn't resolved. The result
    carries everything the byte->piece math needs."""
    row = await qb.raw_info(gid)
    if row is None:
        return None
    files = await qb.files(gid)
    vids = [f for f in files if f["name"].lower().endswith(VIDEO_EXT)]
    if not vids:
        raise NotReady("torrent metadata not resolved yet")
    main = max(vids, key=lambda f: int(f["size"]))
    # Byte offset of this file inside the torrent's piece space = the sizes of
    # everything laid out before it (qBittorrent's file index order is the
    # torrent's layout order).
    offset = sum(int(f["size"]) for f in files if f["index"] < main["index"])
    props = await qb.properties(gid)
    piece_size = int(props.get("piece_size") or 0)
    if piece_size <= 0:
        raise NotReady("torrent metadata not resolved yet")
    # content_path is the file itself for a single-file torrent, the root
    # folder for a multi-file one (the file name then embeds that root).
    rel = main["name"].split("/", 1)
    content = row.get("content_path") or ""
    if not content:
        raise NotReady("download has not started yet")
    path = content if len(rel) == 1 else os.path.join(content, rel[1])
    return {
        "path": path,
        "size": int(main["size"]),
        "offset": offset,
        "piece_size": piece_size,
        "state": row.get("state") or "",
    }


def _pieces_ready(states: list, p0: int, p1: int) -> bool:
    return len(states) > p1 and all(states[i] == 2 for i in range(p0, p1 + 1))


async def _open(qb, gid: str, info: dict):
    """Open the main file for a body. That happens lazily, once its first
    window is in — so the download may have finished and been moved
    incomplete/ -> complete/ during the wait, before any fd could follow the
    rename: then it is wherever qBittorrent says now (the lookup a new stream
    makes). None when it is gone for good — the body ends like a stall,
    never with an exception after the headers went out."""
    try:
        return open(info["path"], "rb")
    except OSError:
        pass
    try:
        now = await _main_file(qb, gid)
    except Exception:  # noqa: BLE001 — NotReady, qBittorrent unreachable
        now = None
    same = ("size", "offset", "piece_size")
    if now and now["path"] != info["path"] and all(now[k] == info[k] for k in same):
        try:
            return open(now["path"], "rb")
        except OSError:
            pass
    log.warning("stream %s: file gone from %s, giving up", gid, info["path"])
    return None


async def _body(qb, gid: str, info: dict, start: int, end: int, gen: int):
    """Yield bytes [start, end] of the main file, waiting at the download
    frontier for pieces to arrive. Gives up (closing the response early) only
    after PIECE_WAIT_MAX of no progress — the client sees a network error,
    which beats hanging a TV's player forever on a dead torrent. Exits as soon
    as a newer stream for the same hash supersedes this one."""
    ps = info["piece_size"]
    off = info["offset"]
    pos = start
    f = None
    states: list = []
    fetched_at = 0.0
    # When the current wait began (monotonic), None while bytes flow. Time, not
    # loop turns: a slow pieceStates answer or disk read stretches every turn.
    stalled = None
    short = None  # empty reads at done pieces; `stalled` resets whenever they read ready
    try:
        while pos <= end:
            if _stream_gen.get(gid) != gen:
                return  # a newer play of this torrent took over
            p0 = (off + pos) // ps
            p1 = (off + min(end, pos + CHUNK - 1)) // ps
            if not _pieces_ready(states, p0, p1):
                now = time.monotonic()
                if now - fetched_at >= PIECE_POLL:
                    try:
                        states = await qb.piece_states(gid)
                    except Exception:
                        states = []
                    fetched_at = now
                if not _pieces_ready(states, p0, p1):
                    if stalled is None:
                        stalled = now
                    elif time.monotonic() - stalled >= PIECE_WAIT_MAX:
                        log.warning("stream %s: stalled at byte %d, giving up", gid, pos)
                        return
                    await asyncio.sleep(PIECE_POLL)
                    continue
            stalled = None
            if f is None:
                f = await _open(qb, gid, info)
                if f is None:
                    return
            read_at = time.monotonic()
            data = await asyncio.to_thread(_read_at, f, pos, min(CHUNK, end - pos + 1))
            if not data:
                # shorter than expected despite the pieces reading as done —
                # transient during the incomplete->complete move; retry, but a
                # file that never grows (truncated, rechecked) gives up like a
                # stalled frontier
                if short is None:
                    short = read_at
                elif time.monotonic() - short >= PIECE_WAIT_MAX:
                    log.warning("stream %s: file ends at byte %d before its pieces, giving up", gid, pos)
                    return
                await asyncio.sleep(PIECE_POLL)
                continue
            short = None
            yield data
            pos += len(data)
    finally:
        if f is not None:
            f.close()


def _parse_range(header: str | None, size: int):
    """One range spec only (players send one). Returns (start, end, partial)."""
    if not header or not header.startswith("bytes="):
        return 0, size - 1, False
    spec = header[6:].split(",")[0].strip()
    s, _, e = spec.partition("-")
    try:
        if s == "":  # suffix form: last N bytes
            n = int(e)
            return max(0, size - n), size - 1, True
        start = int(s)
        end = int(e) if e else size - 1
    except ValueError:
        return 0, size - 1, False
    return start, min(end, size - 1), True


async def stream_endpoint(qb, gid: str, request: Request):
    try:
        info = await _main_file(qb, gid)
    except NotReady as e:
        return _not_ready(str(e))
    if info is None:
        return _not_found()
    size = info["size"]
    ext = os.path.splitext(info["path"])[1].lower()
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": CTYPE.get(ext, "application/octet-stream"),
        "Cache-Control": "no-store",
    }
    if request.method == "HEAD":
        headers["Content-Length"] = str(size)
        return Response(status_code=200, headers=headers)
    start, end, partial = _parse_range(request.headers.get("range"), size)
    if start >= size or start > end:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})

    # Pressing Play is the strongest priority signal there is: a torrent parked
    # by the client's queue slots (or paused) gets force-started so the stream
    # has a frontier that actually advances.
    if info["state"] in ("queuedDL", "stoppedDL", "pausedDL", "stalledDL"):
        try:
            await qb.force_start(gid)
            log.info("stream %s: force-started parked torrent", gid)
        except Exception as e:
            log.warning("stream %s: force-start failed: %s", gid, e)

    # supersede any previous stream of this torrent (see _stream_gen)
    gen = _stream_gen.get(gid, 0) + 1
    _stream_gen[gid] = gen

    headers["Content-Length"] = str(end - start + 1)
    status = 200
    if partial:
        status = 206
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return StreamingResponse(
        _body(qb, gid, info, start, end, gen),
        status_code=status,
        headers=headers,
        media_type=headers["Content-Type"],
    )


# ---------------- probe ----------------

_probe_cache: dict[str, dict] = {}  # per-hash; track layout never changes


def _hdr(v: dict) -> str | None:
    for sd in v.get("side_data_list") or []:
        if "DOVI" in (sd.get("side_data_type") or "").upper():
            return "DV"
    ct = v.get("color_transfer") or ""
    if ct == "smpte2084":
        return "HDR10"
    if ct == "arib-std-b67":
        return "HLG"
    return None


def _fps(v: dict) -> float | None:
    raw = v.get("avg_frame_rate") or v.get("r_frame_rate") or ""
    num, _, den = raw.partition("/")
    try:
        return round(int(num) / int(den or 1), 3) if num else None
    except (ValueError, ZeroDivisionError):
        return None


def _shape_probe(data: dict, size_bytes: int) -> dict:
    fmt = data.get("format") or {}
    out = {
        "container": (fmt.get("format_name") or "").split(",")[0] or None,
        "duration_s": float(fmt["duration"]) if fmt.get("duration") else None,
        "bitrate": int(fmt["bit_rate"]) if fmt.get("bit_rate") else None,
        "size_bytes": size_bytes,
        "video": None,
        "audio": [],
        "subtitles": [],
    }
    for s in data.get("streams") or []:
        tags = s.get("tags") or {}
        disp = s.get("disposition") or {}
        kind = s.get("codec_type")
        if kind == "video" and out["video"] is None:
            out["video"] = {
                "index": s.get("index"),
                "codec": s.get("codec_name"),
                "width": s.get("width"),
                "height": s.get("height"),
                "hdr": _hdr(s),
                "fps": _fps(s),
            }
        elif kind == "audio":
            profile = s.get("profile") or ""
            out["audio"].append(
                {
                    "index": s.get("index"),
                    "codec": s.get("codec_name"),
                    "channels": s.get("channels"),
                    "layout": s.get("channel_layout"),
                    "lang": tags.get("language"),
                    "title": tags.get("title"),
                    "atmos": "atmos" in profile.lower() or "joc" in profile.lower(),
                    "default": bool(disp.get("default")),
                }
            )
        elif kind == "subtitle":
            out["subtitles"].append(
                {
                    "index": s.get("index"),
                    "codec": s.get("codec_name"),
                    "lang": tags.get("language"),
                    "title": tags.get("title"),
                    "forced": bool(disp.get("forced")),
                    "default": bool(disp.get("default")),
                }
            )
    return out


async def probe_endpoint(qb, gid: str):
    hit = _probe_cache.get(gid)
    if hit:
        return hit
    try:
        info = await _main_file(qb, gid)
    except NotReady as e:
        return _not_ready(str(e))
    if info is None:
        return _not_found()

    # The container header must be on disk before ffprobe can say anything.
    ps = info["piece_size"]
    off = info["offset"]
    p0 = off // ps
    p1 = (off + min(PROBE_MIN_BYTES, info["size"]) - 1) // ps
    try:
        states = await qb.piece_states(gid)
    except Exception:
        states = []
    if not _pieces_ready(states, p0, p1):
        return _not_ready("file header not downloaded yet")

    ffprobe = shutil.which("ffprobe")
    if ffprobe is None:
        log.error("probe: ffprobe not on PATH")
        return JSONResponse(
            status_code=503,
            headers={"Retry-After": "3600"},
            content={"error": "temporarily_unavailable", "detail": "probing unavailable"},
        )
    proc = await asyncio.create_subprocess_exec(
        ffprobe,
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        info["path"],
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=PROBE_TIMEOUT)
    except asyncio.TimeoutError:
        proc.kill()
        return _not_ready("probe timed out — try again shortly")
    try:
        data = json.loads(out or b"{}")
    except ValueError:
        data = {}
    shaped = _shape_probe(data, info["size"])
    if not shaped["video"] and not shaped["audio"]:
        log.warning("probe %s: no streams found (%s)", gid, (err or b"")[:120])
        return _not_ready("file not probeable yet")
    _probe_cache[gid] = shaped
    return shaped
