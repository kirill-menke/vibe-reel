"""A stateful fake qBittorrent WebUI API v2, served through respx.

Field names and shapes follow the public WebUI API docs (qBittorrent 4.1+ /
5.x wiki, "WebUI API (qBittorrent 4.1)"); tests/test_spec_*.py check them
against the spec cache when it is present. Only what reel-api calls is
implemented:

  POST /api/v2/auth/login                        username, password -> see "Auth" below
  GET  /api/v2/torrents/info                     hashes=a|b  -> [row]
  GET  /api/v2/torrents/files                    hash=  -> [file]   (404 unknown hash)
  GET  /api/v2/torrents/properties               hash=  -> {...}    (404 unknown hash)
  GET  /api/v2/torrents/pieceStates              hash=  -> [0|1|2]  (404 unknown hash)
  POST /api/v2/torrents/delete                   hashes, deleteFiles
  POST /api/v2/torrents/setForceStart            hashes, value
  POST /api/v2/torrents/toggleSequentialDownload hashes
  POST /api/v2/torrents/toggleFirstLastPiecePrio hashes

Every call is recorded in `sim.calls` as (method, path, params-or-form dict),
and the request itself in `sim.requests` as (path, httpx.Request).
`sim.fail(path, ...)` queues a one-shot failure (an httpx exception or a
status) for the next call to that path.

Auth (`username=` and/or `api_key=` set; neither = the WebUI skips auth for
this client, LocalHostAuth=false): every call but the login needs a live
session cookie or, on version 5, the right `Authorization: Bearer <api_key>`;
without one it answers 403 "Forbidden". `sim.logged_in = False` expires every
session (qBittorrent's session timeout, or a restart); `sim.banned = True` is
the failed-login IP ban. The login answers like the real thing:

  version 4 (4.1 .. 5.1, the wiki's "WebUI API (qBittorrent 5.0)"):
      200 "Ok." + Set-Cookie SID=…, 200 "Fails.", 403 when banned
  version 5 (5.2+, src/webui/webapplication.cpp + authcontroller.cpp at
      release-5.2.0, WebAPI changelog 2.14.0):
      204 (no body) + Set-Cookie QBT_SID_<port>=…, 401 "Unauthorized",
      403 when banned, 403 for a login carrying a Bearer header.
  An already-live session answers success again without a new cookie.
"""

from __future__ import annotations

import hashlib
import itertools
import json
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qs

import httpx

from .growing import GrowingFile

QBIT = "http://qbit.test"

# The session cookie: "SID" up to 5.1; 5.2 names it after the WebUI port
# (webapplication.cpp: SESSION_COOKIE_NAME_PREFIX = "QBT_SID_" + port).
COOKIE_V4, COOKIE_V5 = "SID", "QBT_SID_8080"
BANNED = "Your IP address has been banned after too many failed authentication attempts."


def make_hash(seed: str) -> str:
    """A deterministic 40-hex info-hash (lowercase, like qBittorrent)."""
    return hashlib.sha1(seed.encode()).hexdigest()


def magnet_for(info_hash: str, name: str = "x") -> str:
    return f"magnet:?xt=urn:btih:{info_hash}&dn={name}"


@dataclass
class SimFile:
    name: str  # torrent-relative, e.g. "Show.S01/Show.S01E01.mkv" for multi-file torrents
    size: int
    growing: GrowingFile | None = None
    priority: int = 1


@dataclass
class SimTorrent:
    hash: str
    name: str
    category: str = ""  # reel-api never reads or sets it (undo.py: MANUAL_CATEGORY excepted)
    state: str = "downloading"
    save_path: str = "/downloads"
    content_path: str | None = None  # None -> derived; "" -> not started
    files: list[SimFile] = field(default_factory=list)
    piece_size: int = 64 * 1024
    seq_dl: bool = False
    f_l_piece_prio: bool = False
    dlspeed: int = 0
    eta: int = 8640000  # qBit's "infinite" sentinel
    force_start: bool = False
    pieces: list[int] | None = None  # explicit pieceStates (else from the growing files)
    added_on: int = 1_790_000_000

    @property
    def total_size(self) -> int:
        return sum(f.size for f in self.files)

    def piece_states(self) -> list[int]:
        if self.pieces is not None:
            return list(self.pieces)
        growing = [f.growing for f in self.files if f.growing is not None]
        if len(growing) == 1:
            return growing[0].piece_states()
        n = max(1, -(-self.total_size // self.piece_size)) if self.files else 0
        return [2] * n

    @property
    def progress(self) -> float:
        st = self.piece_states()
        return round(sum(1 for s in st if s == 2) / len(st), 4) if st else 0.0

    def row(self) -> dict:
        total = self.total_size
        done = int(total * self.progress)
        if self.content_path is not None:
            content = self.content_path
        elif len(self.files) == 1 and "/" not in self.files[0].name:
            g = self.files[0].growing
            content = str(g.path) if g else f"{self.save_path}/{self.files[0].name}"
        else:
            content = f"{self.save_path}/{self.name}"
        return {
            "hash": self.hash,
            "infohash_v1": self.hash,
            "name": self.name,
            "category": self.category,
            "state": self.state,
            "save_path": self.save_path,
            "content_path": content,
            "size": total,
            "total_size": total,
            "progress": self.progress,
            "completed": done,
            "downloaded": done,
            "amount_left": total - done,
            "dlspeed": self.dlspeed,
            "upspeed": 0,
            "eta": self.eta,
            "seq_dl": self.seq_dl,
            "f_l_piece_prio": self.f_l_piece_prio,
            "force_start": self.force_start,
            "added_on": self.added_on,
            "num_seeds": 3,
            "num_leechs": 1,
            "magnet_uri": magnet_for(self.hash, self.name),
            "tags": "",
        }


class QbitSim:
    def __init__(self, router, base: str = QBIT, *, version: int = 5,
                 username: str | None = None, password: str | None = None,
                 api_key: str | None = None):
        self.base = base.rstrip("/")
        self.version = version  # 4: 4.x-5.1 (200 "Ok." login); 5: 5.2+ (204 login, API key)
        self.username, self.password, self.api_key = username, password, api_key
        self.torrents: dict[str, SimTorrent] = {}
        self.calls: list[tuple[str, str, dict]] = []
        self.requests: list[tuple[str, httpx.Request]] = []
        self.sessions: set[str] = set()
        self.banned = False
        self._sids = itertools.count(1)
        self._faults: dict[str, list] = {}
        p = self.base + "/api/v2"
        routes = {
            ("POST", "/auth/login"): self._login,
            ("GET", "/torrents/info"): self._info,
            ("GET", "/torrents/files"): self._files,
            ("GET", "/torrents/properties"): self._properties,
            ("GET", "/torrents/pieceStates"): self._piece_states,
            ("POST", "/torrents/delete"): self._delete,
            ("POST", "/torrents/setForceStart"): self._set_force_start,
            ("POST", "/torrents/toggleSequentialDownload"): self._toggle_seq,
            ("POST", "/torrents/toggleFirstLastPiecePrio"): self._toggle_flp,
        }
        self.endpoints = sorted(routes)  # (method, path under /api/v2)
        for (method, path), handler in routes.items():
            name = "qbit_" + path.strip("/").replace("/", "_")
            router.route(method=method, url=p + path, name=name).mock(side_effect=self._wrap(path, handler))

    # ---- test API ----
    def add_torrent(self, t: SimTorrent) -> SimTorrent:
        self.torrents[t.hash.lower()] = t
        return t

    def add_growing(self, info_hash: str, growing: GrowingFile, *, name: str | None = None,
                    state: str = "downloading", **kw) -> SimTorrent:
        """A single-file torrent whose one file is `growing`."""
        fname = name or growing.path.name
        t = SimTorrent(hash=info_hash.lower(), name=fname, state=state, piece_size=growing.piece_size,
                       save_path=str(growing.path.parent), files=[SimFile(fname, growing.size, growing)], **kw)
        return self.add_torrent(t)

    def fail(self, path: str, *, status: int | None = None, exc: Exception | None = None,
             body: str = "", times: int = 1) -> None:
        """Queue failures for the next `times` calls to `path` (e.g. "/torrents/info")."""
        item = exc if exc is not None else httpx.Response(status or 500, text=body)
        self._faults.setdefault(path, []).extend([item] * times)

    def called(self, path: str) -> list[dict]:
        return [d for _, p, d in self.calls if p == path]

    @property
    def cookie_name(self) -> str:
        return COOKIE_V5 if self.version >= 5 else COOKIE_V4

    @property
    def logged_in(self) -> bool:
        return bool(self.sessions)

    @logged_in.setter
    def logged_in(self, value: bool) -> None:
        if not value:
            self.sessions.clear()  # every session expired

    def _bearer(self, request: httpx.Request) -> str | None:
        """The Bearer key, on a version that reads one (5.2+)."""
        scheme, _, key = request.headers.get("authorization", "").partition(" ")
        return key.strip() if self.version >= 5 and scheme.lower() == "bearer" else None

    def _session(self, request: httpx.Request) -> str | None:
        for part in request.headers.get("cookie", "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == self.cookie_name and value in self.sessions:
                return value
        return None

    def _authorized(self, request: httpx.Request) -> bool:
        bearer = self._bearer(request)
        if bearer is not None:  # the API-key path: no cookie, no bypass (apiKeySessionInitialize)
            return bool(self.api_key) and bearer == self.api_key
        if not (self.username or self.api_key):
            return True  # auth bypassed for this client
        return self._session(request) is not None

    # ---- plumbing ----
    def _wrap(self, path, handler):
        def side_effect(request: httpx.Request):
            if request.method == "GET":
                data = {k: v for k, v in request.url.params.items()}
            else:
                data = {k: v[-1] for k, v in parse_qs(request.content.decode(), keep_blank_values=True).items()}
            self.calls.append((request.method, path, data))
            faults = self._faults.get(path)
            if faults:
                item = faults.pop(0)
                if isinstance(item, Exception):
                    raise item
                return item
            self.requests.append((path, request))
            if path == "/auth/login":
                return self._login(data, request)
            if not self._authorized(request):
                return httpx.Response(403, text="Forbidden")
            return handler(data)
        return side_effect

    def _get_t(self, h: str | None) -> SimTorrent | None:
        return self.torrents.get((h or "").lower())

    @staticmethod
    def _hashes(data: dict) -> list[str] | None:
        raw = data.get("hashes")
        if raw is None or raw == "all":
            return None
        return [h.lower() for h in raw.split("|") if h]

    # ---- handlers ----
    def _login(self, data, request):
        v5 = self.version >= 5
        if v5 and self._bearer(request) is not None:
            return httpx.Response(403, text="Forbidden")  # no auth/* with an API key
        if self._session(request) is not None:  # already signed in: success, no new cookie
            return httpx.Response(204) if v5 else httpx.Response(200, text="Ok.")
        if self.banned:
            return httpx.Response(403, text=BANNED)
        if (self.username is not None and data.get("username") == self.username
                and data.get("password") == (self.password or "")):
            sid = f"sid{next(self._sids)}"
            self.sessions.add(sid)
            cookie = {"set-cookie": f"{self.cookie_name}={sid}; HttpOnly; SameSite=Lax; path=/"}
            if v5:
                return httpx.Response(204, headers=cookie)
            return httpx.Response(200, text="Ok.", headers=cookie)
        return httpx.Response(401, text="Unauthorized") if v5 else httpx.Response(200, text="Fails.")

    def _info(self, data):
        hashes = self._hashes(data)
        rows = []
        for t in self.torrents.values():
            if hashes is not None and t.hash not in hashes:
                continue
            rows.append(t.row())
        return httpx.Response(200, json=rows)

    def _files(self, data):
        t = self._get_t(data.get("hash"))
        if t is None:
            return httpx.Response(404, text="Not Found")
        out, pos = [], 0
        for i, f in enumerate(t.files):
            first = pos // t.piece_size
            last = max(first, (pos + f.size - 1) // t.piece_size)
            g = f.growing
            out.append({
                "index": i, "name": f.name, "size": f.size,
                "progress": g.progress if g else 1.0, "priority": f.priority,
                "is_seed": False, "piece_range": [first, last], "availability": 1.0,
            })
            pos += f.size
        return httpx.Response(200, json=out)

    def _properties(self, data):
        t = self._get_t(data.get("hash"))
        if t is None:
            return httpx.Response(404, text="Not Found")
        st = t.piece_states()
        return httpx.Response(200, json={
            "save_path": t.save_path, "piece_size": t.piece_size, "pieces_num": len(st),
            "pieces_have": sum(1 for s in st if s == 2), "total_size": t.total_size,
            "dl_speed": t.dlspeed, "eta": t.eta, "seeds": 3, "peers": 1,
            "addition_date": t.added_on, "completion_date": -1, "creation_date": t.added_on,
        })

    def _piece_states(self, data):
        t = self._get_t(data.get("hash"))
        if t is None:
            return httpx.Response(404, text="Not Found")
        return httpx.Response(200, json=t.piece_states())

    def _delete(self, data):
        for h in self._hashes(data) or list(self.torrents):
            t = self.torrents.pop(h, None)
            if t is not None and data.get("deleteFiles") == "true":
                for f in t.files:
                    if f.growing is not None:
                        Path(f.growing.path).unlink(missing_ok=True)
        return httpx.Response(200, text="")

    def _set_force_start(self, data):
        for h in self._hashes(data) or list(self.torrents):
            t = self.torrents.get(h)
            if t:
                t.force_start = data.get("value") == "true"
                if t.force_start and t.state in ("queuedDL", "stoppedDL", "pausedDL", "stalledDL"):
                    t.state = "forcedDL"
        return httpx.Response(200, text="")

    def _toggle_seq(self, data):
        for h in self._hashes(data) or []:
            if h in self.torrents:
                self.torrents[h].seq_dl = not self.torrents[h].seq_dl
        return httpx.Response(200, text="")

    def _toggle_flp(self, data):
        for h in self._hashes(data) or []:
            if h in self.torrents:
                self.torrents[h].f_l_piece_prio = not self.torrents[h].f_l_piece_prio
        return httpx.Response(200, text="")


def dump(obj) -> str:  # pragma: no cover - debugging aid
    return json.dumps(obj, indent=2, default=str)
