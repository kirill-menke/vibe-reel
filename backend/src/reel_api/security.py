"""Request guard: Host / Origin checks and Jellyfin-session auth.

Every request passes three checks before it reaches a route:

1. **Host allowlist** (defeats DNS rebinding). A rebinding page talks to this
   service under the attacker's own domain name, so its requests carry that
   name in Host. Allowed: IP literals, `localhost`, and the names in
   REEL_API_ALLOWED_HOSTS (comma list, exact, case-insensitive; the NixOS
   module sets the box's LAN/tailnet names). Anything else is 403.

2. **Origin check** (cross-site requests). A browser request that carries an
   http(s) Origin must come from a host the same rule allows. Non-web origins
   (`null`, `file://`, the TV's local app scheme) pass to step 3 — they cannot
   be told apart from a sandboxed attacker frame, and step 3 doesn't need to.

3. **A Jellyfin session** (authentication). Both clients are signed in to
   Jellyfin anyway, so they send that access token and this service asks
   Jellyfin who it belongs to (GET /Users/Me, cached). No secret of its own to
   distribute, and a token Jellyfin revokes (sign-out) stops working here too.
   Accepted as `Authorization: MediaBrowser Token="…"` (what the clients send
   to Jellyfin), `Authorization: Bearer …`, `X-Emby-Token` /
   `X-MediaBrowser-Token`, or — for URLs a media element fetches itself and
   can't add a header to — the `api_key` query parameter, like Jellyfin's own
   stream URLs. The access log never shows that parameter's value.

Open without a token: GET /health, and POST /api/push/unsubscribe (a phone
signed out of Jellyfin must still be able to take its push subscription off
the server; the push endpoint URL it names is itself an unguessable secret).
"""

import asyncio
import hashlib
import ipaddress
import json
import logging
import os
import re
import time
from collections import OrderedDict
from dataclasses import dataclass
from urllib.parse import parse_qsl, urlsplit

import httpx

log = logging.getLogger("reel_api")

OK_TTL = 600  # a confirmed token is re-checked with Jellyfin after this
STALE_OK = 24 * 3600  # ...but kept working this long while Jellyfin is unreachable
BAD_TTL = 30  # a rejected token is not re-asked about for this long
DOWN_TTL = 30  # after a failed check, stale-OK answers without asking for this long
CACHE_MAX = 512
CHECK_TIMEOUT = 5
MAX_CONCURRENT_CHECKS = 4

OPEN = {("GET", "/health"), ("HEAD", "/health"), ("POST", "/api/push/unsubscribe")}

_TOKEN = re.compile(r"[A-Za-z0-9._~+/=-]{16,512}")
_MB_TOKEN = re.compile(r'(?:^|[\s,])Token\s*=\s*"([^"]*)"', re.I)
_REDACT = re.compile(r"((?:^|[?&])api_key=)[^&\s]*", re.I)


class Unavailable(Exception):
    """Jellyfin could not be asked (down, timed out, 5xx)."""


@dataclass(frozen=True)
class User:
    """The Jellyfin user a request's token belongs to."""

    id: str  # Jellyfin's user Id, dashes dropped, lowercase (32 hex)
    name: str  # Jellyfin's "Name" ("" if absent); for logs and display only
    admin: bool  # Policy.IsAdministrator is exactly true


def norm_user_id(uid) -> str:
    """Jellyfin user ids come dashed or not, in either case: one form."""
    return str(uid).replace("-", "").lower()


def user_from(body) -> User | None:
    """A GET /Users/Me body as a User; None without an Id. Anything but a
    literal `true` in Policy.IsAdministrator is not an admin (fail safe)."""
    if not isinstance(body, dict) or not body.get("Id"):
        return None
    policy = body.get("Policy")
    admin = isinstance(policy, dict) and policy.get("IsAdministrator") is True
    name = body.get("Name")
    return User(norm_user_id(body["Id"]), name if isinstance(name, str) else "", admin)


def _hostname(host: str) -> str | None:
    """`name[:port]` / `[v6]:port` -> the lowercase name; None if malformed."""
    host = host.strip()
    if not host:
        return None
    try:
        return urlsplit("//" + host).hostname
    except ValueError:
        return None


def _is_ip(name: str) -> bool:
    try:
        ipaddress.ip_address(name)
        return True
    except ValueError:
        return False


def allowed_hosts_from_env() -> frozenset[str]:
    raw = os.environ.get("REEL_API_ALLOWED_HOSTS", "")
    return frozenset(h.strip().lower().rstrip(".") for h in raw.split(",") if h.strip())


def host_allowed(name: str | None, extra: frozenset[str]) -> bool:
    if not name:
        return False
    name = name.rstrip(".")
    return _is_ip(name) or name == "localhost" or name in extra


def origin_allowed(origin: str, extra: frozenset[str]) -> bool:
    try:
        u = urlsplit(origin.strip())
    except ValueError:
        return False
    if u.scheme.lower() not in ("http", "https"):
        return True  # `null`, file://, an app scheme: no web origin to judge
    try:
        name = u.hostname
    except ValueError:
        return False
    return host_allowed(name, extra)


def token_from(headers: dict[str, str], query: str) -> str | None:
    """The client's Jellyfin token from the request, or None. A transport
    that carries no token (an empty `Token=""`, a bare `Bearer`) doesn't end
    the search: the next one is looked at."""
    auth = headers.get("authorization", "")
    if auth:
        scheme, _, rest = auth.strip().partition(" ")
        if scheme.lower() == "bearer" and rest.strip():
            return rest.strip()
        if scheme.lower() in ("mediabrowser", "emby"):
            m = _MB_TOKEN.search(" " + rest)
            if m and m.group(1):
                return m.group(1)
    for h in ("x-emby-token", "x-mediabrowser-token"):
        v = headers.get(h, "").strip()
        if v:
            return v
    if query:
        for k, v in parse_qsl(query, keep_blank_values=True):
            if k.lower() == "api_key" and v:
                return v
    return None


class JellyfinAuth:
    """Token -> Jellyfin user, via GET /Users/Me, with a small cache."""

    def __init__(self, base_url: str):
        self.base = base_url.rstrip("/")
        self._http: httpx.AsyncClient | None = None
        # sha256(token) -> (checked_at, User or None for "rejected")
        self._cache: OrderedDict[str, tuple[float, User | None]] = OrderedDict()
        self._inflight: dict[str, asyncio.Task] = {}
        self._sem: asyncio.Semaphore | None = None
        # Jellyfin could not be asked: until _down_until, a token that is
        # stale-OK answers at once instead of waiting for another check (a
        # hanging Jellyfin costs CHECK_TIMEOUT per check, and a stream makes
        # many requests back to back). _down: the outage is logged once.
        self._down = False
        self._down_until = 0.0

    async def _ask(self, token: str) -> User | None:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=CHECK_TIMEOUT)
            self._sem = asyncio.Semaphore(MAX_CONCURRENT_CHECKS)
        # Token only: Jellyfin fills Client/Device/Version from the token's own
        # device record. Sending ours would overwrite that record.
        headers = {"Authorization": f'MediaBrowser Token="{token}"'}
        async with self._sem:
            try:
                r = await self._http.get(self.base + "/Users/Me", headers=headers)
            except httpx.HTTPError as e:
                raise Unavailable(f"jellyfin unreachable: {e}") from e
        if r.status_code == 200:
            try:
                u = user_from(r.json())
            except ValueError:
                u = None
            if u is None:
                raise Unavailable("jellyfin /Users/Me answered without a user id")
            return u
        if r.status_code in (400, 401, 403, 404):
            return None
        raise Unavailable(f"jellyfin /Users/Me HTTP {r.status_code}")

    def _went_down(self, e: Exception) -> None:
        self._down_until = time.monotonic() + DOWN_TTL
        if not self._down:
            self._down = True
            log.warning("auth: %s; tokens confirmed in the last %d h keep working meanwhile",
                        e, STALE_OK // 3600)

    def _came_back(self) -> None:
        self._down_until = 0.0
        if self._down:
            self._down = False
            log.info("auth: jellyfin answers again")

    def _remember(self, key: str, u: User | None) -> None:
        self._cache[key] = (time.monotonic(), u)
        self._cache.move_to_end(key)
        while len(self._cache) > CACHE_MAX:
            self._cache.popitem(last=False)

    async def user(self, token: str) -> str | None:
        """The user id for `token` (see who())."""
        u = await self.who(token)
        return u.id if u else None

    async def who(self, token: str) -> User | None:
        """The user `token` belongs to, None if Jellyfin rejects it. Raises
        Unavailable when Jellyfin can't be asked and nothing usable is cached.
        A stale-OK answer keeps the role the user had when last confirmed."""
        if not _TOKEN.fullmatch(token):
            return None
        key = hashlib.sha256(token.encode()).hexdigest()
        now = time.monotonic()
        hit = self._cache.get(key)
        stale_ok = hit is not None and hit[1] is not None and now - hit[0] < STALE_OK
        if hit is not None:
            at, u = hit
            if now - at < (OK_TTL if u else BAD_TTL):
                return u
            if stale_ok and now < self._down_until:
                return u  # Jellyfin just failed to answer: don't wait for it again
        task = self._inflight.get(key)
        if task is None:

            async def run():
                try:
                    try:
                        u = await self._ask(token)
                    except Unavailable as e:
                        self._went_down(e)
                        raise
                    self._came_back()
                    self._remember(key, u)
                    return u
                finally:
                    self._inflight.pop(key, None)

            task = self._inflight[key] = asyncio.create_task(run())
        try:
            return await asyncio.shield(task)
        except Unavailable as e:
            if stale_ok:
                log.debug("auth: %s; accepting a token confirmed %.0f s ago", e, now - hit[0])
                return hit[1]
            raise


def _json(status: int, error: str, detail: str, headers: dict | None = None):
    body = json.dumps({"error": error, "detail": detail}).encode()
    hdrs = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
            (b"cache-control", b"no-store")]
    for k, v in (headers or {}).items():
        hdrs.append((k.lower().encode(), v.encode()))
    return status, hdrs, body


class Guard:
    """Pure ASGI middleware (no buffering, so the streaming routes are
    untouched) running the three checks above."""

    def __init__(self, app, jellyfin_url: str | None = None, allowed_hosts: frozenset[str] | None = None):
        self.app = app
        self.extra = allowed_hosts if allowed_hosts is not None else allowed_hosts_from_env()
        self.auth = JellyfinAuth(jellyfin_url or os.environ.get("JELLYFIN_URL") or "http://127.0.0.1:8096")

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {}
        for k, v in scope.get("headers") or []:
            headers.setdefault(k.decode("latin-1").lower(), v.decode("latin-1"))
        client = (scope.get("client") or ("?",))[0]
        method = scope.get("method", "GET")
        path = scope.get("path", "")

        host = headers.get("host", "")
        if not host_allowed(_hostname(host), self.extra):
            log.warning("guard: refused Host %r from %s (%s %s)", host[:100], client, method, path[:100])
            return await self._reply(send, *_json(403, "bad_host", "unknown host name"))

        origin = headers.get("origin")
        if origin is not None and not origin_allowed(origin, self.extra):
            log.warning("guard: refused Origin %r from %s (%s %s)", origin[:100], client, method, path[:100])
            return await self._reply(send, *_json(403, "bad_origin", "cross-site request refused"))

        if (method, path) in OPEN:
            return await self.app(scope, receive, send)

        query = scope.get("query_string", b"").decode("latin-1")
        token = token_from(headers, query)
        if not token:
            return await self._reply(send, *_json(401, "unauthorized", "sign in to Jellyfin first"))
        try:
            u = await self.auth.who(token)
        except Unavailable as e:
            log.warning("guard: %s", e)
            return await self._reply(
                send, *_json(503, "temporarily_unavailable", "sign-in check unavailable, retry later",
                             {"Retry-After": "10"}))
        if u is None:
            log.warning("guard: rejected token from %s (%s %s)", client, method, path[:100])
            return await self._reply(send, *_json(401, "unauthorized", "Jellyfin rejected the token"))
        # A copy: the lifespan state dict may be shared by every request
        # (uvicorn copies it per request, other ASGI servers and test
        # harnesses don't), and concurrent requests of different users must
        # never see each other's user.
        st = scope["state"] = dict(scope.get("state") or {})
        st["jellyfin_user"] = u.id  # kept for compatibility
        st["reel_user"] = u
        return await self.app(scope, receive, send)

    @staticmethod
    async def _reply(send, status, headers, body):
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": body})


class RedactTokens(logging.Filter):
    """Blanks `api_key=` values in uvicorn's access log lines."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[2], str) and "api_key" in args[2].lower():
            record.args = args[:2] + (_REDACT.sub(r"\1***", args[2]),) + args[3:]
        return True


def install_log_redaction() -> None:
    logging.getLogger("uvicorn.access").addFilter(RedactTokens())
