"""reel-api-canary — a read-only health probe of the NAS media stack.

Every check here catches a breakage that once went unnoticed for a day or
more, because nothing in the stack reports it on its own:

  reel-api       /api/trending (movie + tv) and the /api/charts index are
                 non-empty. IMDb began answering 403 without an
                 x-imdb-client-name header; the rails simply went empty.
  jellyfin       /System/Info/Public answers, with the server version.
  intro-skipper  /Plugins lists Intro Skipper as Active, built for the
                 server's major version. After the 12.1 upgrade the 10.x
                 build sat at NotSupported and Skip Intro silently vanished.
  segments       /MediaSegments/{item} is non-empty for a known episode
                 (the same outage, seen from the data side).
  trickplay      one trickplay sheet answers 200 with ApiKey= (12.1 started
                 refusing api_key= there, and the scrubber previews broke).
  prowlarr       no indexer is disabled after failures, and at least N are
                 enabled. 1337x was Cloudflare-banned and silently disabled.
  sonarr/radarr  /api/v3/system/status answers; /api/v3/health errors fail
                 the run, warnings warn.
  qbittorrent    /api/v2/app/version answers; /api/v2/transfer/info says
                 the client is connected (it lives in a VPN namespace).
  yt-dlp         `yt-dlp -j --skip-download` with reel-api's own format
                 selector resolves a known video. YouTube breaks yt-dlp
                 every few months and trailers fall back to the YouTube app.

Read-only by construction: every HTTP request goes through `ReadOnlyHttp`,
whose request hook refuses any method but GET before it is sent. The single
exception is qBittorrent's login, ``POST {QBIT_URL}/api/v2/auth/login``,
used only when QBIT_USERNAME is set and no API key is — that endpoint
creates a session cookie and changes nothing else.

Output: a summary on stdout, a JSON status file (CANARY_STATUS_FILE, default
$STATE_DIRECTORY/canary.json) and the exit code: 0 = no check failed
(warnings allowed), 1 = at least one check failed, 2 = configuration error.

Configuration is the environment, reusing reel-api's names where they exist
(see backend/README.md, "Canary"):

  REEL_API_URL              default http://127.0.0.1:$PORT (8790); its host must
                            pass reel-api's request guard (security.py): an IP
                            literal, localhost or a name in REEL_API_ALLOWED_HOSTS
  REEL_API_TOKEN            a Jellyfin user token (the reel-api check needs it:
                            the guard wants a signed-in user on every route)
  JELLYFIN_URL              default http://127.0.0.1:8096
  JELLYFIN_API_KEY          Dashboard > API Keys (intro-skipper, segments, trickplay)
  PROWLARR_URL / PROWLARR_API_KEY
  SONARR_URL / SONARR_API_KEY, RADARR_URL / RADARR_API_KEY
  QBIT_URL, QBIT_API_KEY_FILE / QBIT_API_KEY (Bearer, qBittorrent 5.2+; the file
                            wins, and one that is missing, empty or unusable fails
                            the qbittorrent check — exactly reel-api's rules) or
                            QBIT_USERNAME / QBIT_PASSWORD
  CANARY_CHECKS             comma list (default: all), see CHECKS
  CANARY_SEGMENTS_ITEM_ID   a Jellyfin episode id that has an intro
  CANARY_TRICKPLAY_ITEM_ID  default: the segments item; CANARY_TRICKPLAY_WIDTH (320)
  CANARY_YOUTUBE_ID         default aqz-KE-bpKQ (Blender's "Big Buck Bunny")
  CANARY_MIN_INDEXERS       default 1
  CANARY_TIMEOUT            seconds per check (30); CANARY_SLOW_TIMEOUT (120)
                            for reel-api (a cold trending fill) and yt-dlp
  CANARY_STATUS_FILE        where the JSON goes
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shutil
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Awaitable, Callable

import httpx

from reel_api.qbittorrent import api_key_from_env, login_refusal
from reel_api.trailers import AUDIO_FMT, MAX_HEIGHT, VIDEO_FMT, _last_line, _run

OK, WARN, FAIL = "ok", "warn", "fail"
_RANK = {OK: 0, WARN: 1, FAIL: 2}

# The one non-GET request the canary may ever send (see the module doc).
QBIT_LOGIN_PATH = "/api/v2/auth/login"

DEFAULT_YOUTUBE_ID = "aqz-KE-bpKQ"
INTRO_SKIPPER = "intro skipper"


class ConfigError(Exception):
    """The environment doesn't describe a runnable canary (exit 2)."""


class ReadOnlyViolation(RuntimeError):
    """A request other than GET (or the one qBittorrent login) was attempted."""


class CheckFail(Exception):
    """A check's verdict: fail, with this one-line reason."""


# ---------------------------------------------------------------- HTTP


class ReadOnlyHttp:
    """The canary's only HTTP client. It has no post/put/delete, and the
    underlying client's request hook refuses every method but GET before the
    request leaves — so even a bug that reached for the raw client could not
    change anything upstream. ``login_url`` is the single URL a POST may go
    to: qBittorrent's ``/api/v2/auth/login``, nothing else."""

    def __init__(self, timeout: float, login_url: str | None = None):
        if login_url is not None and not login_url.endswith(QBIT_LOGIN_PATH):
            raise ReadOnlyViolation(f"only qBittorrent's {QBIT_LOGIN_PATH} may be POSTed to")
        self._login_url = login_url
        self._client = httpx.AsyncClient(
            timeout=timeout, follow_redirects=False, event_hooks={"request": [self._guard]}
        )

    async def _guard(self, request: httpx.Request) -> None:
        if request.method == "GET":
            return
        target = str(request.url.copy_with(query=None, fragment=None))
        if request.method == "POST" and self._login_url is not None and target == self._login_url:
            return
        raise ReadOnlyViolation(f"canary is read-only: refused {request.method} {request.url.path}")

    async def get(self, url: str, *, params: dict | None = None, headers: dict | None = None) -> httpx.Response:
        return await self._client.get(url, params=params, headers=headers)

    async def qbit_login(self, username: str, password: str) -> httpx.Response:
        """POST the qBittorrent WebUI login — the canary's only write-shaped call.
        It only creates a session cookie; qBittorrent's state is unchanged."""
        if self._login_url is None:
            raise ReadOnlyViolation("no qBittorrent login URL configured")
        return await self._client.post(self._login_url, data={"username": username, "password": password})

    @property
    def cookies(self) -> httpx.Cookies:
        return self._client.cookies

    async def aclose(self) -> None:
        await self._client.aclose()


async def _get_json(http: ReadOnlyHttp, url: str, what: str, *, params=None, headers=None):
    r = await http.get(url, params=params, headers=headers)
    if r.status_code in (401, 403):
        raise CheckFail(f"{what}: HTTP {r.status_code} (key or token refused)")
    if not r.is_success:
        raise CheckFail(f"{what}: HTTP {r.status_code}")
    try:
        return r.json()
    except ValueError:
        raise CheckFail(f"{what}: answer is not JSON") from None


def _first(msgs: list[str]) -> str:
    """One line out of several messages: the first, plus how many more."""
    more = f" (+{len(msgs) - 1} more)" if len(msgs) > 1 else ""
    return msgs[0] + more


# ---------------------------------------------------------------- config


@dataclass
class Config:
    checks: list[str]
    status_file: Path
    timeout: float = 30.0
    slow_timeout: float = 120.0
    reel_url: str = "http://127.0.0.1:8790"
    reel_token: str | None = None
    jellyfin_url: str = "http://127.0.0.1:8096"
    jellyfin_key: str | None = None
    segments_item: str | None = None
    trickplay_item: str | None = None
    trickplay_width: int = 320
    prowlarr_url: str = "http://127.0.0.1:9696"
    prowlarr_key: str | None = None
    min_indexers: int = 1
    sonarr_url: str = "http://127.0.0.1:8989"
    sonarr_key: str | None = None
    radarr_url: str = "http://127.0.0.1:7878"
    radarr_key: str | None = None
    qbit_url: str | None = None
    qbit_api_key: str | None = None
    # QBIT_API_KEY_FILE set but unusable: the qbittorrent check fails with it.
    qbit_key_error: str | None = None
    qbit_user: str | None = None
    qbit_pass: str | None = None
    youtube_id: str = DEFAULT_YOUTUBE_ID

    def secrets(self) -> list[str]:
        vals = (self.reel_token, self.jellyfin_key, self.prowlarr_key, self.sonarr_key,
                self.radarr_key, self.qbit_api_key, self.qbit_pass)
        return [v for v in vals if v]


def _state_dir() -> Path:
    # Same rule as push.py: systemd's StateDirectory=, else next to the cache.
    base = os.environ.get("STATE_DIRECTORY") or os.environ.get("CACHE_DIRECTORY") or os.path.join(
        os.environ.get("TMPDIR", "/tmp"), "reel-api-state"
    )
    return Path(base.split(":")[0])


def _num(env: dict, name: str, default, kind=float, low=1):
    raw = env.get(name)
    if not raw:
        return default
    try:
        v = kind(raw)
    except ValueError:
        raise ConfigError(f"{name}={raw!r} is not a number") from None
    if v < low:
        raise ConfigError(f"{name} must be >= {low}")
    return v


def load_config(env: dict | None = None, checks: str | None = None,
                status_file: str | None = None) -> Config:
    """Read the environment. Raises ConfigError for an unknown check, a bad
    number, or a selected check whose required setting is missing."""
    env = dict(os.environ if env is None else env)
    g = lambda k: (env.get(k) or "").strip() or None  # noqa: E731
    raw = checks if checks is not None else g("CANARY_CHECKS")
    names = [c.strip() for c in raw.split(",") if c.strip()] if raw else list(CHECKS)
    unknown = [n for n in names if n not in CHECKS]
    if unknown:
        raise ConfigError(f"unknown check(s): {', '.join(unknown)} (known: {', '.join(CHECKS)})")
    if not names:
        raise ConfigError("no checks selected")
    port = g("PORT") or "8790"
    # The key file is read only for the check that uses it (and never logged).
    qbit_key, qbit_key_error = api_key_from_env(env) if "qbittorrent" in names else (g("QBIT_API_KEY"), None)
    seg = g("CANARY_SEGMENTS_ITEM_ID")
    cfg = Config(
        checks=list(dict.fromkeys(names)),
        status_file=Path(status_file or g("CANARY_STATUS_FILE") or _state_dir() / "canary.json"),
        timeout=_num(env, "CANARY_TIMEOUT", 30.0, low=0.01),
        slow_timeout=_num(env, "CANARY_SLOW_TIMEOUT", 120.0, low=0.01),
        reel_url=(g("REEL_API_URL") or f"http://127.0.0.1:{port}").rstrip("/"),
        reel_token=g("REEL_API_TOKEN"),
        jellyfin_url=(g("JELLYFIN_URL") or "http://127.0.0.1:8096").rstrip("/"),
        jellyfin_key=g("JELLYFIN_API_KEY"),
        segments_item=seg,
        trickplay_item=g("CANARY_TRICKPLAY_ITEM_ID") or seg,
        trickplay_width=_num(env, "CANARY_TRICKPLAY_WIDTH", 320, int),
        prowlarr_url=(g("PROWLARR_URL") or "http://127.0.0.1:9696").rstrip("/"),
        prowlarr_key=g("PROWLARR_API_KEY"),
        min_indexers=_num(env, "CANARY_MIN_INDEXERS", 1, int, low=0),
        sonarr_url=(g("SONARR_URL") or "http://127.0.0.1:8989").rstrip("/"),
        sonarr_key=g("SONARR_API_KEY"),
        radarr_url=(g("RADARR_URL") or "http://127.0.0.1:7878").rstrip("/"),
        radarr_key=g("RADARR_API_KEY"),
        qbit_url=(g("QBIT_URL") or "").rstrip("/") or None,
        qbit_api_key=qbit_key,
        qbit_key_error=qbit_key_error,
        qbit_user=g("QBIT_USERNAME"),
        qbit_pass=env.get("QBIT_PASSWORD") or "",
        youtube_id=g("CANARY_YOUTUBE_ID") or DEFAULT_YOUTUBE_ID,
    )
    missing = []
    for name in cfg.checks:
        for attr, var in CHECKS[name].needs:
            if not getattr(cfg, attr):
                missing.append(f"{name} needs {var}")
    if missing:
        raise ConfigError("; ".join(missing))
    return cfg


# ---------------------------------------------------------------- checks

Verdict = tuple[str, str]


def _jf_headers(cfg: Config) -> dict:
    # Jellyfin 12 reads only the standard Authorization header (not X-Emby-*).
    return {"Authorization": f'MediaBrowser Client="reel-api-canary", Token="{cfg.jellyfin_key}"'}


async def check_reel_api(cfg: Config, http: ReadOnlyHttp) -> Verdict:
    # The request guard (security.py) asks Jellyfin who this token belongs to,
    # so it is sent exactly as the clients send theirs.
    headers = {"Authorization": f'MediaBrowser Token="{cfg.reel_token}"'}
    base = cfg.reel_url

    async def size(path: str, params: dict | None, key: str, what: str) -> int:
        r = await http.get(base + path, params=params, headers=headers)
        if r.status_code == 401:
            raise CheckFail(f"{what}: HTTP 401 — reel-api refused REEL_API_TOKEN "
                            "(signed out or revoked in Jellyfin? sign in again for a new one)")
        if r.status_code == 403 and _guard_error(r) in ("bad_host", "bad_origin"):
            raise CheckFail(f"{what}: HTTP 403 — reel-api refused the host of REEL_API_URL: use an IP, "
                            "localhost or a name in its REEL_API_ALLOWED_HOSTS")
        if not r.is_success:
            raise CheckFail(f"{what}: HTTP {r.status_code}")
        try:
            return len(r.json().get(key) or [])
        except (ValueError, AttributeError):
            raise CheckFail(f"{what}: answer is not a JSON object") from None

    movies, shows, cats = await asyncio.gather(
        size("/api/trending", {"type": "movie"}, "results", "trending movie"),
        size("/api/trending", {"type": "tv"}, "results", "trending tv"),
        size("/api/charts", None, "categories", "charts"),
    )
    empty = [n for n, v in (("trending movie", movies), ("trending tv", shows), ("charts", cats)) if not v]
    if empty:
        return FAIL, f"empty: {', '.join(empty)} — IMDb refused or changed? see reel-api's log"
    return OK, f"trending {movies} movies / {shows} shows, {cats} chart categories"


def _guard_error(r: httpx.Response) -> str | None:
    """The `error` of a request-guard refusal ({error, detail}), else None."""
    try:
        body = r.json()
    except ValueError:
        return None
    return body.get("error") if isinstance(body, dict) else None


async def _server_version(cfg: Config, http: ReadOnlyHttp) -> str:
    info = await _get_json(http, cfg.jellyfin_url + "/System/Info/Public", "Jellyfin /System/Info/Public")
    v = info.get("Version") if isinstance(info, dict) else None
    if not v:
        raise CheckFail("Jellyfin /System/Info/Public has no Version")
    return str(v)


async def check_jellyfin(cfg: Config, http: ReadOnlyHttp) -> Verdict:
    return OK, f"Jellyfin {await _server_version(cfg, http)}"


def _major(version: str) -> int | None:
    try:
        return int(version.split(".")[0])
    except ValueError:
        return None


def plugin_target(version: str) -> int | None:
    """The Jellyfin major a plugin build is for: 12.0.4.0 -> 12; the old
    "1.<jellyfin minor>" scheme (1.10.11.24, for 10.11) -> 10."""
    parts = version.split(".")
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        return None
    if nums[0] >= 10:
        return nums[0]
    return nums[1] if len(nums) > 1 else None


async def check_intro_skipper(cfg: Config, http: ReadOnlyHttp) -> Verdict:
    server = await _server_version(cfg, http)
    plugins = await _get_json(http, cfg.jellyfin_url + "/Plugins", "Jellyfin /Plugins", headers=_jf_headers(cfg))
    found = [p for p in plugins or [] if INTRO_SKIPPER in str(p.get("Name", "")).lower()]
    if not found:
        return FAIL, f"Intro Skipper is not installed (Jellyfin {server}) — Skip Intro has no segments"
    seen = ", ".join(f"{p.get('Version')} {p.get('Status')}" for p in found)
    active = [p for p in found if p.get("Status") == "Active"]
    if not active:
        return FAIL, f"Intro Skipper not Active ({seen}) on Jellyfin {server} — a Jellyfin restart loads a new build"
    want = _major(server)
    for p in active:
        if plugin_target(str(p.get("Version"))) == want:
            return OK, f"Intro Skipper {p.get('Version')} Active on Jellyfin {server}"
    if want is None or all(plugin_target(str(p.get("Version"))) is None for p in active):
        return WARN, f"can't tell which Jellyfin Intro Skipper {seen} is built for (server {server})"
    return FAIL, f"Intro Skipper {seen} is built for another Jellyfin major than {server}"


async def check_segments(cfg: Config, http: ReadOnlyHttp) -> Verdict:
    d = await _get_json(http, f"{cfg.jellyfin_url}/MediaSegments/{cfg.segments_item}",
                        "Jellyfin /MediaSegments", headers=_jf_headers(cfg))
    items = (d.get("Items") if isinstance(d, dict) else None) or []
    if not items:
        return FAIL, "no media segments for the canary item — is Intro Skipper loaded? (GET /Plugins)"
    kinds = sorted({str(s.get("Type")) for s in items})
    if "Intro" not in kinds:
        return WARN, f"{len(items)} segment(s) but no Intro ({', '.join(kinds)})"
    return OK, f"{len(items)} segment(s): {', '.join(kinds)}"


async def check_trickplay(cfg: Config, http: ReadOnlyHttp) -> Verdict:
    # ApiKey= in the query, exactly as the TV's scrubber asks for sheets.
    w = cfg.trickplay_width
    r = await http.get(f"{cfg.jellyfin_url}/Videos/{cfg.trickplay_item}/Trickplay/{w}/0.jpg",
                       params={"ApiKey": cfg.jellyfin_key})
    if r.status_code == 401:
        return FAIL, "trickplay sheet: HTTP 401 with ApiKey= — the scrubber previews are broken"
    if r.status_code == 404:
        return FAIL, f"no trickplay sheet at {w} px for the canary item"
    if not r.is_success:
        return FAIL, f"trickplay sheet: HTTP {r.status_code}"
    ctype = r.headers.get("content-type", "")
    if not ctype.startswith("image/"):
        return FAIL, f"trickplay sheet is {ctype or 'untyped'}, not an image"
    return OK, f"sheet 0 at {w} px: {len(r.content) // 1024} KiB {ctype}"


def _parse_time(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        t = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


async def check_prowlarr(cfg: Config, http: ReadOnlyHttp) -> Verdict:
    h = {"X-Api-Key": cfg.prowlarr_key}
    indexers = await _get_json(http, cfg.prowlarr_url + "/api/v1/indexer", "Prowlarr indexers", headers=h)
    status = await _get_json(http, cfg.prowlarr_url + "/api/v1/indexerstatus", "Prowlarr indexerstatus", headers=h)
    names = {i.get("id"): i.get("name") or f"#{i.get('id')}" for i in indexers or []}
    enabled = {i.get("id") for i in indexers or [] if i.get("enable")}
    now = datetime.now(timezone.utc)
    blocked = {}
    for s in status or []:
        until = _parse_time(s.get("disabledTill"))
        # Prowlarr lists only blocked indexers here; an expired row is history.
        if until is None or until > now:
            iid = s.get("indexerId")
            blocked[iid] = f"{names.get(iid, f'#{iid}')} until {until:%Y-%m-%d %H:%MZ}" if until else names.get(iid, f"#{iid}")
    working = len(enabled - set(blocked))
    if blocked:
        return FAIL, f"disabled after failures: {_first(list(blocked.values()))}; {working} working"
    if working < cfg.min_indexers:
        return FAIL, f"only {working} enabled indexer(s), want >= {cfg.min_indexers}"
    return OK, f"{working} enabled indexer(s), none disabled"


async def _check_arr(app: str, url: str, key: str, http: ReadOnlyHttp) -> Verdict:
    h = {"X-Api-Key": key}
    st = await _get_json(http, url + "/api/v3/system/status", f"{app} system/status", headers=h)
    version = st.get("version", "?") if isinstance(st, dict) else "?"
    health = await _get_json(http, url + "/api/v3/health", f"{app} health", headers=h)
    by = {"error": [], "warning": []}
    for row in health or []:
        if row.get("type") in by:
            by[row["type"]].append(f"{row.get('source') or '?'}: {row.get('message') or ''}".strip())
    if by["error"]:
        return FAIL, f"{app} {version}: error: {_first(by['error'])}"
    if by["warning"]:
        return WARN, f"{app} {version}: warning: {_first(by['warning'])}"
    return OK, f"{app} {version}, healthy"


async def check_sonarr(cfg: Config, http: ReadOnlyHttp) -> Verdict:
    return await _check_arr("Sonarr", cfg.sonarr_url, cfg.sonarr_key, http)


async def check_radarr(cfg: Config, http: ReadOnlyHttp) -> Verdict:
    return await _check_arr("Radarr", cfg.radarr_url, cfg.radarr_key, http)


async def check_qbittorrent(cfg: Config, http: ReadOnlyHttp) -> Verdict:
    base = cfg.qbit_url
    headers = None
    if cfg.qbit_key_error:  # fail closed, like reel-api: nothing is sent
        return FAIL, (f"qBittorrent: {cfg.qbit_key_error} — not falling back to QBIT_API_KEY "
                      "or QBIT_USERNAME/QBIT_PASSWORD")
    if cfg.qbit_api_key:
        headers = {"Authorization": f"Bearer {cfg.qbit_api_key}"}
    elif cfg.qbit_user:
        r = await http.qbit_login(cfg.qbit_user, cfg.qbit_pass or "")
        if login_refusal(r, http.cookies):  # 4.x-5.1: 200 "Ok."; 5.2+: 204
            return FAIL, f"qBittorrent login refused (HTTP {r.status_code})"
    r = await http.get(base + "/api/v2/app/version", headers=headers)
    if r.status_code in (401, 403):
        return FAIL, (f"qBittorrent: HTTP {r.status_code} — set QBIT_API_KEY or "
                      "QBIT_USERNAME/QBIT_PASSWORD, or the key is wrong")
    if not r.is_success:
        return FAIL, f"qBittorrent app/version: HTTP {r.status_code}"
    version = r.text.strip()[:40]
    info = await _get_json(http, base + "/api/v2/transfer/info", "qBittorrent transfer/info", headers=headers)
    conn = info.get("connection_status") if isinstance(info, dict) else None
    if conn == "disconnected":
        return FAIL, f"qBittorrent {version}: disconnected — is the VPN namespace up?"
    if conn == "firewalled":
        return WARN, f"qBittorrent {version}: firewalled (no incoming peers; port forward?)"
    return OK, f"qBittorrent {version}, {conn or 'status unknown'}"


async def check_ytdlp(cfg: Config, http: ReadOnlyHttp) -> Verdict:
    exe = shutil.which("yt-dlp")
    if exe is None:
        return FAIL, "yt-dlp not on PATH"
    # trailers.py's own flags and format selector, at the TV's height: the
    # canary resolves exactly what a trailer start would.
    fmt = f"({VIDEO_FMT.format(h=MAX_HEIGHT)})+({AUDIO_FMT})"
    url = "https://www.youtube.com/watch?v=" + cfg.youtube_id
    rc, out, err = await _run(exe, "--no-cache-dir", "--no-warnings", "--no-playlist", "--quiet",
                              "-j", "--skip-download", "-f", fmt, url, timeout=cfg.slow_timeout)
    if rc != 0:
        return FAIL, "yt-dlp: " + _last_line(err)
    try:
        info = json.loads(out)
    except ValueError:
        return FAIL, "yt-dlp -j printed no JSON"
    ver = (info.get("_version") or {}).get("version") or "?"
    req = info.get("requested_formats") or []
    if len(req) != 2:
        return FAIL, f"yt-dlp {ver}: no separate video + audio streams (trailers would fail)"
    v, a = (req[0], req[1]) if req[0].get("vcodec") != "none" else (req[1], req[0])
    return OK, f"yt-dlp {ver}: {v.get('height')}p {v.get('vcodec')} + {a.get('acodec')}"


@dataclass(frozen=True)
class Check:
    fn: Callable[[Config, ReadOnlyHttp], Awaitable[Verdict]]
    needs: tuple[tuple[str, str], ...] = ()  # (Config attr, env var) pairs
    slow: bool = False


_JF_KEY = ("jellyfin_key", "JELLYFIN_API_KEY")
CHECKS: dict[str, Check] = {
    "reel-api": Check(check_reel_api, (("reel_token", "REEL_API_TOKEN"),), slow=True),
    "jellyfin": Check(check_jellyfin),
    "intro-skipper": Check(check_intro_skipper, (_JF_KEY,)),
    "segments": Check(check_segments, (_JF_KEY, ("segments_item", "CANARY_SEGMENTS_ITEM_ID"))),
    "trickplay": Check(check_trickplay, (_JF_KEY, ("trickplay_item", "CANARY_TRICKPLAY_ITEM_ID"))),
    "prowlarr": Check(check_prowlarr, (("prowlarr_key", "PROWLARR_API_KEY"),)),
    "sonarr": Check(check_sonarr, (("sonarr_key", "SONARR_API_KEY"),)),
    "radarr": Check(check_radarr, (("radarr_key", "RADARR_API_KEY"),)),
    "qbittorrent": Check(check_qbittorrent, (("qbit_url", "QBIT_URL"),)),
    "yt-dlp": Check(check_ytdlp, slow=True),
}


# ---------------------------------------------------------------- running


@dataclass
class Result:
    name: str
    status: str
    reason: str
    seconds: float = 0.0


@dataclass
class Report:
    started: str
    finished: str
    status: str
    counts: dict
    checks: list[Result] = field(default_factory=list)

    def to_json(self) -> dict:
        d = asdict(self)
        d["version"] = 1
        return d


_QUERY_SECRET = re.compile(r"(?i)\b(api_?key|token|password)=[^&\s\"']+")


def redact(text: str, secrets: list[str]) -> str:
    for s in secrets:
        if len(s) >= 4:
            text = text.replace(s, "***")
    return _QUERY_SECRET.sub(r"\1=***", text)


def _oneline(text: str, limit: int = 300) -> str:
    return " ".join(text.split())[:limit]


def _describe(e: BaseException) -> str:
    if isinstance(e, httpx.TimeoutException):
        return f"no answer in time ({type(e).__name__})"
    if isinstance(e, httpx.ConnectError):
        return f"unreachable: {e}" if str(e) else "unreachable"
    return f"{type(e).__name__}: {e}" if str(e) else type(e).__name__


async def run_one(name: str, cfg: Config, http: ReadOnlyHttp) -> Result:
    check = CHECKS[name]
    deadline = cfg.slow_timeout if check.slow else cfg.timeout
    t0 = time.monotonic()
    try:
        status, reason = await asyncio.wait_for(check.fn(cfg, http), deadline)
    except asyncio.TimeoutError:
        status, reason = FAIL, f"no verdict within {deadline:g} s"
    except CheckFail as e:
        status, reason = FAIL, str(e)
    except Exception as e:  # noqa: BLE001 — every failure is this check's verdict
        status, reason = FAIL, _describe(e)
    reason = _oneline(redact(reason, cfg.secrets()))
    return Result(name, status, reason, round(time.monotonic() - t0, 2))


def _login_url(cfg: Config) -> str | None:
    if ("qbittorrent" in cfg.checks and cfg.qbit_url and cfg.qbit_user and not cfg.qbit_api_key
            and not cfg.qbit_key_error):
        return cfg.qbit_url + QBIT_LOGIN_PATH
    return None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


async def run_checks(cfg: Config) -> Report:
    started = _now()
    http = ReadOnlyHttp(timeout=cfg.slow_timeout, login_url=_login_url(cfg))
    try:
        results = await asyncio.gather(*(run_one(n, cfg, http) for n in cfg.checks))
    finally:
        await http.aclose()
    counts = {s: sum(r.status == s for r in results) for s in (OK, WARN, FAIL)}
    worst = max((r.status for r in results), key=_RANK.__getitem__)
    return Report(started, _now(), worst, counts, list(results))


def summary(report: Report) -> str:
    c = report.counts
    lines = [f"reel-api canary {report.finished}: {report.status.upper()} "
             f"({c[FAIL]} fail, {c[WARN]} warn, {c[OK]} ok)"]
    width = max(len(r.name) for r in report.checks)
    for r in report.checks:
        lines.append(f"  {r.status.upper():<5} {r.name:<{width}}  {r.reason}  ({r.seconds:.1f} s)")
    return "\n".join(lines)


def write_status(path: Path, report: Report) -> None:
    """Atomically: a reader (a dashboard, an alert script) never sees half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(report.to_json(), indent=2) + "\n")
    os.replace(tmp, path)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="reel-api-canary",
        description="Read-only health checks of the NAS media stack (exit 0 ok/warn, 1 fail, 2 config error).",
    )
    ap.add_argument("--checks", help=f"comma list, overrides CANARY_CHECKS (known: {', '.join(CHECKS)})")
    ap.add_argument("--status-file", help="JSON status path, overrides CANARY_STATUS_FILE")
    args = ap.parse_args(argv)
    try:
        cfg = load_config(checks=args.checks, status_file=args.status_file)
    except ConfigError as e:
        print(f"reel-api-canary: config error: {e}", file=sys.stderr)
        return 2
    report = asyncio.run(run_checks(cfg))
    print(summary(report))
    try:
        write_status(cfg.status_file, report)
    except OSError as e:
        print(f"reel-api-canary: can't write {cfg.status_file}: {e}", file=sys.stderr)
        return 2
    return 1 if report.status == FAIL else 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
