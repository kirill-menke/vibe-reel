"""reel-api's qBittorrent client (WebUI API v2).

Sonarr and Radarr add every torrent; reel-api never does. It reads them —
live progress for /api/activity, files and pieces for the streams
(streaming.py, livehls.py) — and steers them: forces sequential download,
force-starts a stream's torrent, and removes a cancelled/undone grab with its
partial data (undo.py). A torrent is addressed by its info-hash only.

Auth, first match wins:
- QBIT_API_KEY_FILE / QBIT_API_KEY — qBittorrent 5.2+'s WebUI API key, sent as
  `Authorization: Bearer <key>` on every call. Stateless: no login, no session
  to expire, not subject to the failed-login IP ban. A refused key (401/403) is
  a DownloadError, never a login attempt.
- QBIT_USERNAME / QBIT_PASSWORD — a cookie login (4.x .. 5.2 answers, see
  login_refusal), repeated once when the session has expired.
- neither — qBittorrent skips auth for this client (LocalHostAuth=false on
  loopback, or a whitelisted subnet).
"""

import logging
import os
import re
from collections.abc import Mapping
from pathlib import Path

import httpx

log = logging.getLogger("reel_api")

# A torrent's id is its 40-hex info-hash. qBittorrent's `hashes` parameters
# also take `all` and `|`-separated lists, so an id is checked before it gets
# anywhere near one: a stream id of `all` must never reach setForceStart, nor
# a stray value torrents/delete (that would remove every torrent).
HASH_RE = re.compile(r"[0-9a-fA-F]{40}")


def _hash(gid: object) -> str:
    if not isinstance(gid, str) or not HASH_RE.fullmatch(gid):
        raise NoSuchDownload(str(gid)[:64])
    return gid.lower()


# qBittorrent's API keys: "qbt_" + 28 letters/digits (src/base/utils/apikey.cpp).
# Anything else is sent anyway, with a warning: qBittorrent will refuse it.
API_KEY_RE = re.compile(r"qbt_[A-Za-z0-9]{28}")
_HEADER_SAFE = re.compile(r"[\x21-\x7e]+")  # no whitespace/control chars: it goes into a header


# The WebUI session cookie: "SID" up to 5.1 (4.6+ lets the user rename it,
# WebAPI\SessionCookieName); 5.2 always names it after the WebUI port
# (webapplication.cpp: SESSION_COOKIE_NAME_PREFIX "QBT_SID_", no setting).
_SESSION_COOKIE = re.compile(r"SID|QBT_SID_\d+")


def _session_names(cookies) -> set[str]:
    return {c.name for c in cookies if _SESSION_COOKIE.fullmatch(c.name)}


def _sent_session_names(request: httpx.Request) -> set[str]:
    names = (part.split("=", 1)[0].strip() for part in request.headers.get("cookie", "").split(";"))
    return {n for n in names if _SESSION_COOKIE.fullmatch(n)}


def login_refusal(r: httpx.Response, cookies: httpx.Cookies) -> str | None:
    """Why qBittorrent did not accept a POST /api/v2/auth/login — None when it
    did. `cookies` is the client's jar after the answer.

    4.1 .. 5.1 answer 200 "Ok." or 200 "Fails."; 5.2 answers 204 with no body
    or 401 (WebAPI 2.14.0; measured on 5.2.3: 204, with or without Referer).
    Both answer 403 while the client's IP is banned for failed logins.

    200 "Ok." is qBittorrent's own word for success, so it is a login whatever
    the cookie is called (4.6 .. 5.1 can rename it) — or with none at all, when
    the session was live already. Any other 2xx (5.2's 204) counts only with a
    session cookie set by *this* answer, or, for 5.2's "still logged in" shape
    (204, no body, no new cookie), the session cookie the POST itself carried
    and the jar still holds. A cookie merely left in the jar is no proof: the
    client logs in again because its session expired, so a proxy's 2xx page
    on top of a stale cookie is not a login."""
    body = r.text.strip()
    if r.status_code == 401 or (r.is_success and body == "Fails."):
        return f"wrong username or password (HTTP {r.status_code})"
    if r.status_code == 403:
        return f"refused (HTTP 403: {body[:100]!r}) — is this IP banned after failed logins?"
    if not r.is_success:
        return f"HTTP {r.status_code}"
    if r.status_code == 200 and body == "Ok.":
        return None
    if _session_names(r.cookies.jar):
        return None
    if r.status_code == 204 and not body and _sent_session_names(r.request) & _session_names(cookies.jar):
        return None
    return f"no session cookie in the answer (HTTP {r.status_code})"


class DownloadError(Exception):
    """qBittorrent unreachable or rejected the call."""


class NoSuchDownload(Exception):
    """Hash is unknown to qBittorrent."""


class QBittorrentClient:
    def __init__(
        self,
        base_url: str,
        username: str | None,
        password: str | None,
        api_key: str | None = None,
        *,
        config_error: str | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self._api_key = api_key or None
        # The key wins: with one, no cookie login is ever attempted.
        self._username = None if self._api_key else username
        self._password = None if self._api_key else password
        # A configured but unusable credential: every call fails, nothing is sent.
        self._config_error = config_error
        headers = {"Authorization": f"Bearer {self._api_key}"} if self._api_key else None
        self._client = httpx.AsyncClient(timeout=20, headers=headers)
        self._logged_in = False

    async def _login(self) -> None:
        if self._logged_in or not self._username:
            return
        try:
            r = await self._client.post(
                f"{self.base_url}/api/v2/auth/login",
                data={"username": self._username, "password": self._password or ""},
            )
        except httpx.HTTPError as e:
            raise DownloadError(f"qbittorrent unreachable: {e}") from e
        why = login_refusal(r, self._client.cookies)
        if why:
            raise DownloadError(f"qbittorrent login failed: {why}")
        self._logged_in = True

    async def _request(self, method: str, path: str, **kw) -> httpx.Response:
        if self._config_error:
            raise DownloadError(self._config_error)
        await self._login()
        try:
            return await self._client.request(method, self.base_url + path, **kw)
        except httpx.HTTPError as e:
            raise DownloadError(f"qbittorrent unreachable: {e}") from e

    async def _send(self, method: str, path: str, **kw) -> httpx.Response:
        """One WebUI call. The session cookie expires (qBittorrent's session
        timeout, or a restart) and every call then answers 403 "Forbidden":
        log in again and send it once more."""
        r = await self._request(method, path, **kw)
        if self._api_key and r.status_code in (401, 403):
            # A wrong or deleted key; logging in can't fix it (and auth/* refuses
            # Bearer requests anyway). Raised for POSTs too, which otherwise
            # don't look at the status.
            raise DownloadError(f"qbittorrent refused the API key (HTTP {r.status_code}) on {path}")
        if r.status_code == 403 and self._username:
            self._logged_in = False
            r = await self._request(method, path, **kw)
        return r

    async def _post(self, path: str, data: dict) -> httpx.Response:
        return await self._send("POST", path, data=data)

    async def _get(self, path: str, params: dict) -> object:
        r = await self._send("GET", path, params=params)
        # files/properties/pieceStates answer a plain-text 404 for a hash
        # qBittorrent doesn't know (e.g. removed since its torrents/info row).
        if r.status_code == 404 and "hash" in params:
            raise NoSuchDownload(params["hash"])
        if not r.is_success:
            raise DownloadError(f"qbittorrent {path}: {r.status_code} {r.text[:80]}")
        try:
            return r.json()
        except ValueError as e:
            raise DownloadError(f"qbittorrent {path}: not JSON: {r.text[:80]!r}") from e

    async def _info(self, gid: str) -> dict | None:
        rows = await self._get("/api/v2/torrents/info", {"hashes": _hash(gid)})
        return rows[0] if rows else None

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
        return await self._get("/api/v2/torrents/files", {"hash": _hash(gid)})

    async def properties(self, gid: str) -> dict:
        return await self._get("/api/v2/torrents/properties", {"hash": _hash(gid)})

    async def piece_states(self, gid: str) -> list:
        """Per-piece state array: 0 pending, 1 downloading, 2 downloaded."""
        return await self._get("/api/v2/torrents/pieceStates", {"hash": _hash(gid)})

    async def force_start(self, gid: str) -> None:
        """Bypass the queue slots for one torrent — used when a stream opens on
        a parked download: watching it is the priority signal."""
        await self._post(
            "/api/v2/torrents/setForceStart", {"hashes": _hash(gid), "value": "true"}
        )

    async def make_sequential(self, rows: list[dict]) -> None:
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

    # ---- undo / cancel of arr grabs (see undo.py) ----

    async def rows(self, hashes: list[str]) -> list:
        """torrents/info rows for exactly these hashes (unknown ones are simply
        absent)."""
        hashes = _valid(hashes)
        if not hashes:
            return []
        return await self._get("/api/v2/torrents/info", {"hashes": "|".join(hashes)})

    async def delete_with_data(self, hashes: list[str]) -> None:
        """Remove torrents *and* their partial data. Only for grabs being
        cancelled/undone — never a finished file: the arr has imported (copied
        or hard-linked) those into the library by then, and undo.py refuses
        an importing grab."""
        hashes = _valid(hashes)
        if not hashes:
            return
        r = await self._post(
            "/api/v2/torrents/delete",
            {"hashes": "|".join(hashes), "deleteFiles": "true"},
        )
        if r.status_code != 200:
            raise DownloadError(f"qbittorrent delete failed: {r.status_code} {r.text[:80]}")


def _valid(hashes: list[str]) -> list[str]:
    """The well-formed info-hashes of `hashes`, lowercased; anything else
    (which could only widen a `hashes=` parameter) is logged and skipped."""
    out = []
    for h in hashes:
        if isinstance(h, str) and HASH_RE.fullmatch(h):
            out.append(h.lower())
        else:
            log.warning("qbit: ignoring malformed info-hash %r", str(h)[:64])
    return out


def api_key_from_env(env: Mapping[str, str] | None = None) -> tuple[str | None, str | None]:
    """(key, error) from `env` (default os.environ). QBIT_API_KEY_FILE (a
    systemd credential: LoadCredential= + QBIT_API_KEY_FILE=%d/…) is read here,
    once, and wins over QBIT_API_KEY; both are stripped, and empty means unset.
    A set file that can't give a key is an error, not a fall-back to
    QBIT_API_KEY or QBIT_USERNAME/PASSWORD. Never logs a key. The canary reads
    its key through this too, so both apply the same rules."""
    env = os.environ if env is None else env
    key = (env.get("QBIT_API_KEY") or "").strip() or None
    path = env.get("QBIT_API_KEY_FILE")
    name = "QBIT_API_KEY"
    if path:
        if key:
            log.warning("qbittorrent: QBIT_API_KEY_FILE and QBIT_API_KEY are both set; using the file")
        name = f"QBIT_API_KEY_FILE {path}"
        try:
            key = Path(path).read_text(encoding="utf-8").strip()
        except (OSError, UnicodeDecodeError) as e:
            return None, f"{name} is unreadable ({type(e).__name__})"
        if not key:
            return None, f"{name} is empty"
    if key and not _HEADER_SAFE.fullmatch(key):
        return None, f"{name}: the key contains whitespace or control characters"
    if key and not API_KEY_RE.fullmatch(key):
        log.warning("qbittorrent: %s is not in qBittorrent's API key format (qbt_ + 28 letters/digits); "
                    "sending it anyway", name)
    return key, None


def make_download_client():
    """qBittorrent when QBIT_URL is set, else None (the routes that need it 503)."""
    url = os.environ.get("QBIT_URL")
    if not url:
        return None
    username, password = os.environ.get("QBIT_USERNAME"), os.environ.get("QBIT_PASSWORD")
    api_key, error = api_key_from_env()
    if error:
        log.error("qbittorrent: %s — every download call fails until it is fixed", error)
        username = password = None
    elif api_key and (username or password):
        log.info("qbittorrent: using the API key; QBIT_USERNAME/QBIT_PASSWORD are ignored")
    return QBittorrentClient(
        base_url=url,
        username=username,
        password=password,
        api_key=api_key,
        config_error=f"qbittorrent: {error}" if error else None,
    )
