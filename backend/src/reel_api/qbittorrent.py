"""Download backend backed by qBittorrent's WebUI API v2.

Replaces the aria2 backend with the download client the NAS already runs. Same
four-method interface (add/status/list/remove) so app.py is unchanged. Manual
grabs go under a dedicated category so they never mix with the torrents Sonarr
and Radarr manage.

Auth: over loopback qBittorrent is configured LocalHostAuth=false, so no login
is needed. If QBIT_USERNAME/PASSWORD are set (non-loopback), it logs in and
carries the cookie.
"""

import os
import re

import httpx

BTIH_RE = re.compile(r"urn:btih:([0-9a-fA-F]{40}|[A-Z2-7]{32})")

# qBittorrent state -> our vocabulary
_STATE_MAP = {
    "queuedDL": "queued",
    "stalledDL": "downloading",
    "metaDL": "downloading",
    "downloading": "downloading",
    "forcedDL": "downloading",
    "checkingDL": "downloading",
    "allocating": "downloading",
    "pausedDL": "paused",
    "stoppedDL": "paused",
    "queuedUP": "complete",
    "stalledUP": "complete",
    "uploading": "complete",
    "forcedUP": "complete",
    "checkingUP": "complete",
    "pausedUP": "complete",
    "stoppedUP": "complete",
    "error": "error",
    "missingFiles": "error",
    "unknown": "error",
}

_ETA_INFINITY = 8640000  # qBit's sentinel for "unknown / infinite"


class DownloadError(Exception):
    """qBittorrent unreachable or rejected the call."""


class NoSuchDownload(Exception):
    """Hash is unknown to qBittorrent."""


class QBittorrentClient:
    def __init__(
        self,
        base_url: str,
        category: str,
        save_path: str | None,
        username: str | None,
        password: str | None,
    ):
        self.base_url = base_url.rstrip("/")
        self.category = category
        self.save_path = save_path
        self._username = username
        self._password = password
        self._client = httpx.AsyncClient(timeout=20)
        self._logged_in = False

    async def _login(self) -> None:
        if self._logged_in or not self._username:
            return
        r = await self._client.post(
            f"{self.base_url}/api/v2/auth/login",
            data={"username": self._username, "password": self._password or ""},
        )
        if r.status_code != 200 or r.text.strip() != "Ok.":
            raise DownloadError("qbittorrent login failed")
        self._logged_in = True

    async def _post(self, path: str, data: dict) -> httpx.Response:
        await self._login()
        try:
            return await self._client.post(self.base_url + path, data=data)
        except httpx.HTTPError as e:
            raise DownloadError(f"qbittorrent unreachable: {e}") from e

    async def _get(self, path: str, params: dict) -> object:
        await self._login()
        try:
            r = await self._client.get(self.base_url + path, params=params)
        except httpx.HTTPError as e:
            raise DownloadError(f"qbittorrent unreachable: {e}") from e
        return r.json()

    async def ensure_category(self) -> None:
        data = {"category": self.category}
        if self.save_path:
            data["savePath"] = self.save_path
        # createCategory is idempotent enough; editCategory updates the path.
        await self._post("/api/v2/torrents/createCategory", data)

    async def add(self, magnet: str) -> str:
        m = BTIH_RE.search(magnet)
        if not m:
            raise DownloadError("magnet has no btih info-hash")
        info_hash = m.group(1).lower()
        data = {
            "urls": magnet,
            "category": self.category,
            # Streamable from the start: pieces arrive in order (plus the last
            # piece early, which holds a Matroska/mp4 index when it is at the
            # end), so /api/downloads/{gid}/stream can follow the frontier.
            "sequentialDownload": "true",
            "firstLastPiecePrio": "true",
        }
        if self.save_path:
            data["savepath"] = self.save_path
        r = await self._post("/api/v2/torrents/add", data)
        # 409 = torrent already present; treat add as idempotent success.
        if r.status_code == 409 or (r.status_code == 200 and _add_ok(r.text)):
            return info_hash
        raise DownloadError(f"qbittorrent add failed: {r.status_code} {r.text[:80]}")

    async def _info(self, gid: str) -> dict | None:
        rows = await self._get("/api/v2/torrents/info", {"hashes": gid.lower()})
        return rows[0] if rows else None

    async def status(self, gid: str) -> dict:
        row = await self._info(gid)
        if row is None:
            raise NoSuchDownload(gid)
        return _shape(row)

    async def list(self) -> list[dict]:
        rows = await self._get("/api/v2/torrents/info", {"category": self.category})
        return [_shape(r) for r in rows]

    async def info_map(self) -> dict:
        """All torrents keyed by uppercase info-hash — used to enrich the arr
        activity view with live progress/speed (Sonarr's own queue lags ~1 min)."""
        rows = await self._get("/api/v2/torrents/info", {})
        return {(r.get("hash") or "").upper(): r for r in rows if r.get("hash")}

    # ---- streaming support (see streaming.py) ----

    async def raw_info(self, gid: str) -> dict | None:
        """The unshaped torrents/info row (content_path, seq_dl, state, …)."""
        return await self._info(gid)

    async def files(self, gid: str) -> list:
        return await self._get("/api/v2/torrents/files", {"hash": gid.lower()})

    async def properties(self, gid: str) -> dict:
        return await self._get("/api/v2/torrents/properties", {"hash": gid.lower()})

    async def piece_states(self, gid: str) -> list:
        """Per-piece state array: 0 pending, 1 downloading, 2 downloaded."""
        return await self._get("/api/v2/torrents/pieceStates", {"hash": gid.lower()})

    async def force_start(self, gid: str) -> None:
        """Bypass the queue slots for one torrent — used when a stream opens on
        a parked download: watching it is the priority signal."""
        await self._post(
            "/api/v2/torrents/setForceStart", {"hashes": gid.lower(), "value": "true"}
        )

    # (string annotation: the `list` method above shadows the builtin here)
    async def make_sequential(self, rows: "list[dict]") -> None:
        """Force sequential download + first/last-piece priority on the given
        torrents/info rows. The API only exposes *toggles*, so filter by each
        row's current flag to make repeated calls idempotent."""
        seq = [r["hash"] for r in rows if not r.get("seq_dl")]
        flp = [r["hash"] for r in rows if not r.get("f_l_piece_prio")]
        if seq:
            await self._post(
                "/api/v2/torrents/toggleSequentialDownload", {"hashes": "|".join(seq)}
            )
        if flp:
            await self._post(
                "/api/v2/torrents/toggleFirstLastPiecePrio", {"hashes": "|".join(flp)}
            )

    async def remove(self, gid: str) -> None:
        row = await self._info(gid)
        if row is None:
            raise NoSuchDownload(gid)
        await self._post(
            "/api/v2/torrents/delete", {"hashes": gid.lower(), "deleteFiles": "false"}
        )

    # ---- undo / cancel of arr grabs (see undo.py) ----

    async def rows(self, hashes: "list[str]") -> list:
        """torrents/info rows for exactly these hashes (unknown ones are simply
        absent)."""
        if not hashes:
            return []
        return await self._get(
            "/api/v2/torrents/info", {"hashes": "|".join(h.lower() for h in hashes)}
        )

    async def delete_with_data(self, hashes: "list[str]") -> None:
        """Remove torrents *and* their partial data. Only for grabs being
        cancelled/undone — never a finished file: the arr has imported (copied
        or hard-linked) those into the library by then, and undo.py refuses
        an importing grab."""
        if not hashes:
            return
        r = await self._post(
            "/api/v2/torrents/delete",
            {"hashes": "|".join(h.lower() for h in hashes), "deleteFiles": "true"},
        )
        if r.status_code != 200:
            raise DownloadError(f"qbittorrent delete failed: {r.status_code} {r.text[:80]}")


def _add_ok(body: str) -> bool:
    # qBit <5 replies "Ok."; qBit 5 replies JSON {"added_torrent_ids":[...],
    # "failure_count":N}. Treat an added id or the legacy "Ok." as success.
    text = body.strip()
    if text in ("Ok.", ""):
        return True
    try:
        import json

        data = json.loads(text)
    except ValueError:
        return False
    return bool(data.get("added_torrent_ids")) or int(data.get("failure_count", 0)) == 0


def _shape(row: dict) -> dict:
    total = int(row.get("size") or row.get("total_size") or 0)
    done = int(row.get("completed") or 0)
    speed = int(row.get("dlspeed") or 0)
    eta = int(row.get("eta") or 0)
    status = _STATE_MAP.get(row.get("state", ""), "downloading")
    result = {
        "id": row.get("hash", "").upper(),
        "status": status,
        "name": row.get("name") or None,
        "progress": round(float(row.get("progress") or 0.0), 4),
        "size_bytes": total or None,
        "downloaded_bytes": done,
        "download_speed": speed,
        "eta_s": eta if 0 < eta < _ETA_INFINITY else None,
    }
    if status == "error":
        result["error_detail"] = row.get("state")
    return result


def make_download_client():
    """qBittorrent when QBIT_URL/category configured, else None (endpoints 503)."""
    url = os.environ.get("QBIT_URL")
    if not url:
        return None
    return QBittorrentClient(
        base_url=url,
        category=os.environ.get("QBIT_CATEGORY", "reel"),
        save_path=os.environ.get("QBIT_SAVE_PATH"),
        username=os.environ.get("QBIT_USERNAME"),
        password=os.environ.get("QBIT_PASSWORD"),
    )
