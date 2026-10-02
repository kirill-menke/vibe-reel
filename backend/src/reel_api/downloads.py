"""Download backend: hand a magnet to a long-lived aria2c RPC daemon.

Run the daemon once (files land in ARIA2_DOWNLOAD_DIR):

    aria2c --enable-rpc --rpc-listen-all=false \\
           --rpc-secret=<token> --dir=/srv/media/incoming \\
           --seed-time=0

The endpoint calls aria2.addUri with the magnet and returns aria2's GID; the
GID is the download id the client polls. seed-time=0 (set per download here as
well) means aria2 stops as soon as the transfer completes — no seeding.

Configured via env; unset ARIA2_RPC_SECRET disables the download endpoints.
"""

import os

import httpx


class DownloadError(Exception):
    """aria2 refused the call or is unreachable."""


class NoSuchDownload(Exception):
    """GID is unknown to aria2."""


# aria2 status -> our vocabulary
_STATUS_MAP = {
    "active": "downloading",
    "waiting": "queued",
    "paused": "paused",
    "error": "error",
    "complete": "complete",
    "removed": "removed",
}

_STATUS_KEYS = [
    "gid",
    "status",
    "totalLength",
    "completedLength",
    "downloadSpeed",
    "errorCode",
    "errorMessage",
    "dir",
    "files",
    "followedBy",
    "bittorrent",
]


class Aria2Client:
    def __init__(self, rpc_url: str, secret: str, download_dir: str | None):
        self.rpc_url = rpc_url
        self.token = f"token:{secret}"
        self.download_dir = download_dir
        self._client = httpx.AsyncClient(timeout=15)
        self._id = 0

    async def _call(self, method: str, params: list) -> object:
        self._id += 1
        payload = {
            "jsonrpc": "2.0",
            "id": str(self._id),
            "method": method,
            "params": [self.token, *params],
        }
        try:
            r = await self._client.post(self.rpc_url, json=payload)
        except httpx.HTTPError as e:
            raise DownloadError(f"aria2 unreachable: {e}") from e
        data = r.json()
        if "error" in data:
            msg = data["error"].get("message", "")
            if "not found" in msg.lower():
                raise NoSuchDownload(msg)
            raise DownloadError(msg)
        return data["result"]

    async def add(self, magnet: str) -> str:
        options = {"seed-time": "0"}
        if self.download_dir:
            options["dir"] = self.download_dir
        gid = await self._call("aria2.addUri", [[magnet], options])
        return gid

    async def _tell(self, gid: str) -> dict:
        return await self._call("aria2.tellStatus", [gid, _STATUS_KEYS])

    async def _resolve(self, gid: str) -> dict:
        # A magnet's first GID is the metadata fetch; once it completes aria2
        # spawns the real torrent download and links it via followedBy. Follow
        # that chain so we act on the actual file, not the .torrent metadata.
        raw = await self._tell(gid)
        seen = {gid}
        while raw.get("followedBy"):
            nxt = raw["followedBy"][0]
            if nxt in seen:
                break
            seen.add(nxt)
            raw = await self._tell(nxt)
        return raw

    async def status(self, gid: str) -> dict:
        raw = await self._resolve(gid)
        return _shape(gid, raw)

    async def list(self) -> list[dict]:
        active = await self._call("aria2.tellActive", [_STATUS_KEYS])
        waiting = await self._call("aria2.tellWaiting", [0, 1000, _STATUS_KEYS])
        stopped = await self._call("aria2.tellStopped", [0, 1000, _STATUS_KEYS])
        # metadata entries have a followedBy pointer; hide them, the child shows
        out = []
        for raw in [*active, *waiting, *stopped]:
            if raw.get("followedBy"):
                continue
            out.append(_shape(raw["gid"], raw))
        return out

    async def remove(self, gid: str) -> None:
        raw = await self._resolve(gid)
        target = raw.get("gid", gid)
        if raw.get("status") in ("active", "waiting", "paused"):
            await self._call("aria2.forceRemove", [target])
        else:
            await self._call("aria2.removeDownloadResult", [target])


def _name(raw: dict) -> str | None:
    bt = raw.get("bittorrent") or {}
    info = bt.get("info") or {}
    if info.get("name"):
        return info["name"]
    files = raw.get("files") or []
    if files and files[0].get("path"):
        return os.path.basename(files[0]["path"])
    return None


def _shape(gid: str, raw: dict) -> dict:
    total = int(raw.get("totalLength", 0) or 0)
    done = int(raw.get("completedLength", 0) or 0)
    speed = int(raw.get("downloadSpeed", 0) or 0)
    progress = round(done / total, 4) if total else 0.0
    eta_s = int((total - done) / speed) if speed and total > done else None
    status = _STATUS_MAP.get(raw.get("status", ""), raw.get("status"))
    result = {
        "id": gid,
        "status": status,
        "name": _name(raw),
        "progress": progress,
        "size_bytes": total or None,
        "downloaded_bytes": done,
        "download_speed": speed,
        "eta_s": eta_s,
    }
    if status == "error":
        result["error_detail"] = raw.get("errorMessage") or raw.get("errorCode")
    return result


def make_download_client() -> Aria2Client | None:
    secret = os.environ.get("ARIA2_RPC_SECRET")
    if not secret:
        return None
    rpc_url = os.environ.get("ARIA2_RPC_URL", "http://127.0.0.1:6800/jsonrpc")
    download_dir = os.environ.get("ARIA2_DOWNLOAD_DIR")
    return Aria2Client(rpc_url, secret, download_dir)
