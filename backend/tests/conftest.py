"""Shared fixtures for the reel-api suite. Read tests/README.md first.

Guarantees for every test (autouse):

* no network: pytest-socket (pyproject addopts) allows only AF_UNIX and
  loopback; on top of that every httpx request goes through respx with
  ``assert_all_mocked=True`` (an unmocked URL fails the request) and every
  `requests` call (pywebpush) through `responses` (unmocked -> ConnectionError);
* a clean environment: every env var reel-api reads is removed, and
  CACHE_DIRECTORY / STATE_DIRECTORY / TMPDIR point into the test's tmp_path
  (livehls.start() rmtree's its cache root — it must never be a real one);
* fresh module state: `app_module` reloads reel_api.app (its caches and
  IntroDB/Trailers singletons live at module level) and resets the module
  globals of streaming / livehls / push.

Fake upstreams live at http://<service>.test (constants below). Build the
app with `api` (all backends configured, push off) or `make_api(**env)`.

The request guard (security.py) is never switched off: the test client sends
Host reel.test (in REEL_API_ALLOWED_HOSTS) and `Authorization: MediaBrowser
Token="<TEST_TOKEN>"`, and `jf_auth` (autouse) answers the guard's Token-only
GET /Users/Me like Jellyfin 12.1 — 200 UserDto {Id, Name, Policy} for a valid token,
401 otherwise. TEST_TOKEN is "kirill", an admin; NICOLE_TOKEN / ZHENYA_TOKEN
are normal users (send them with `auth_for(token)`).
A test that sent a guarded request must have made the guard ask (checked at
teardown).
"""

from __future__ import annotations

import asyncio
import importlib
import json
import os
import re
import shutil
import sys
from collections.abc import Iterator
from contextlib import asynccontextmanager
from contextvars import ContextVar
from pathlib import Path

import httpx
import pytest
import responses as responses_lib
import respx
from asgi_lifespan import LifespanManager

from tests.support.arr import ArrSim
from tests.support.clock import FakeClock
from tests.support.jellyfin import user_dto
from tests.support.jfspec import jf_spec
from tests.support.known_bugs import finding_ids
from tests.support.qbit import QBIT, QbitSim

SONARR = "http://sonarr.test"
RADARR = "http://radarr.test"
PROWLARR = "http://prowlarr.test"
JELLYFIN = "http://jellyfin.test"
REEL = "http://reel.test"  # base_url of the ASGI test client

# The Jellyfin session every test client signs its requests with (security.py):
# "kirill", an administrator — so every test that doesn't care about roles
# sees today's behaviour (admins may do everything, no quota).
TEST_TOKEN = "reel-test-token-0123456789abcdef"
TEST_USER = "0123456789abcdef0123456789abcdef"
TEST_AUTH = f'MediaBrowser Token="{TEST_TOKEN}"'
# Two normal (non-admin) users, for ownership and quota tests (ownership.py).
NICOLE_TOKEN = "nicole-token-0123456789abcdef"
NICOLE_USER = "11111111111111111111111111111111"
ZHENYA_TOKEN = "zhenya-token-0123456789abcdef"
ZHENYA_USER = "22222222222222222222222222222222"


def auth_for(token: str) -> str:
    """The Authorization header value a client signed in with `token` sends:
    `make_api(auth=auth_for(NICOLE_TOKEN))`, or per request
    `headers={"Authorization": auth_for(ZHENYA_TOKEN)}`."""
    return f'MediaBrowser Token="{token}"'

SONARR_KEY = "sonarr-test-key"
RADARR_KEY = "radarr-test-key"
PROWLARR_KEY = "prowlarr-test-key"

# Every variable reel-api reads (grep os.environ in src/reel_api). Keep complete.
REEL_ENV = (
    "QBIT_URL", "QBIT_USERNAME", "QBIT_PASSWORD", "QBIT_API_KEY", "QBIT_API_KEY_FILE",
    "SONARR_URL", "SONARR_API_KEY", "SONARR_QUALITY_PROFILE",
    "RADARR_URL", "RADARR_API_KEY", "RADARR_QUALITY_PROFILE",
    "JELLYFIN_URL", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT",
    "HOST", "PORT", "LOG_LEVEL", "CACHE_DIRECTORY", "STATE_DIRECTORY",
    "REEL_API_ALLOWED_HOSTS", "REEL_API_QUOTA_MOVIES", "REEL_API_QUOTA_SERIES",
    # settings of the removed search/download API (2026-10): a host env file
    # may still carry them, reel-api ignores them (test_raw_downloads_removed)
    "PROWLARR_INDEXER_IDS", "QBIT_CATEGORY", "QBIT_SAVE_PATH", "ARIA2_RPC_SECRET", "ARIA2_RPC_URL",
    "ARIA2_DOWNLOAD_DIR", "SCRAPER_BASE_URL", "FLARESOLVERR_URL",
    # reel-api-canary (canary.py) on top of the above
    "PROWLARR_URL", "PROWLARR_API_KEY", "REEL_API_URL", "REEL_API_TOKEN", "JELLYFIN_API_KEY",
    "CANARY_CHECKS", "CANARY_STATUS_FILE", "CANARY_SEGMENTS_ITEM_ID", "CANARY_TRICKPLAY_ITEM_ID",
    "CANARY_TRICKPLAY_WIDTH", "CANARY_YOUTUBE_ID", "CANARY_MIN_INDEXERS", "CANARY_TIMEOUT",
    "CANARY_SLOW_TIMEOUT",
)

# The default configuration of `api`: every backend on, push off.
FULL_ENV = {
    "SONARR_URL": SONARR, "SONARR_API_KEY": SONARR_KEY,
    "RADARR_URL": RADARR, "RADARR_API_KEY": RADARR_KEY,
    "QBIT_URL": QBIT,
    "JELLYFIN_URL": JELLYFIN,
    "REEL_API_ALLOWED_HOSTS": "reel.test",
}


# ---------------------------------------------------------------- isolation


@pytest.fixture(autouse=True)
def reel_env(monkeypatch, tmp_path):
    """Clean env + private cache/state dirs. Returns a setter: reel_env(KEY=val, KEY2=None)."""
    for k in REEL_ENV:
        monkeypatch.delenv(k, raising=False)
    cache, state, tmp = tmp_path / "cache", tmp_path / "state", tmp_path / "tmp"
    for d in (cache, state, tmp):
        d.mkdir()
    monkeypatch.setenv("CACHE_DIRECTORY", str(cache))
    monkeypatch.setenv("STATE_DIRECTORY", str(state))
    monkeypatch.setenv("TMPDIR", str(tmp))

    def set_env(**kv):
        for k, v in kv.items():
            if v is None:
                monkeypatch.delenv(k, raising=False)
            else:
                monkeypatch.setenv(k, str(v))

    set_env.cache = cache
    set_env.state = state
    return set_env


# The confirmed delete (DELETE /api/library/{type}/{id}?delete_files=true) in
# progress in this context — set by arr_deletes_keep_files around
# Undo.delete_with_files; tasks it spawns (the "deleting" watcher) inherit it.
_FILES_DELETE: ContextVar[dict | None] = ContextVar("files_delete", default=None)


class ArrDeleteWatch:
    """What arr_deletes_keep_files saw: `sent` = (kind, arr id, confirmed
    delete or None) per ArrClient.delete_title_and_files call."""

    def __init__(self, direct: bool):
        self.direct = direct
        self.sent: list[tuple[str, int, dict | None]] = []

    def violations(self) -> list[str]:
        from tests.support import arr as arr_support

        allowed = {(kind, aid) for kind, aid, c in self.sent
                   if self.direct or (c is not None and c["route"] and c["answered"] and c["kind"] == kind)}
        out = []
        for sim in arr_support.LIVE:
            excl = "addImportListExclusion" if sim.kind == "tv" else "addImportExclusion"
            for c in sim.calls:
                if c.method != "DELETE" or not c.path.startswith(f"/api/v3/{sim.noun}/"):
                    continue
                if c.params.get(excl) != "false":
                    out.append(f"import-list exclusion not false: {c}")
                files = c.params.get("deleteFiles")
                if files == "false":
                    continue
                aid = c.path.rsplit("/", 1)[1]
                if files != "true" or not aid.isdigit() or (sim.kind, int(aid)) not in allowed:
                    out.append(f"library files deleted outside the confirmed delete route: {c}")
        return out


@pytest.fixture(autouse=True)
def arr_deletes_keep_files(request, monkeypatch) -> Iterator[ArrDeleteWatch]:
    """The hard rule on library files, checked after every test: every title
    DELETE any ArrSim saw carries no import-list exclusion and deleteFiles=false
    — except one sent by ArrClient.delete_title_and_files on behalf of the
    confirmed delete route, i.e. inside Undo.delete_with_files as called by
    app.undo_library_add with delete_files=true, and only once that call has
    answered (the route's 200; a "deleting" watcher's later DELETE counts).
    A unit test of delete_title_and_files itself is marked
    `deletes_files_directly`: it may send deleteFiles=true through that method
    (never through anything else). A test that breaks the rule on purpose
    asserts `violations()` and then clears the sim's `calls`."""
    from reel_api import arr as arr_mod
    from reel_api import undo as undo_mod
    from tests.support import arr as arr_support

    arr_support.LIVE.clear()
    watch = ArrDeleteWatch(request.node.get_closest_marker("deletes_files_directly") is not None)
    real_delete = undo_mod.Undo.delete_with_files
    real_files = arr_mod.ArrClient.delete_title_and_files

    async def delete_with_files(self, kind, media_id, *a, **kw):
        caller = sys._getframe(1)  # the coroutine awaiting this one (first step)
        route = (caller.f_globals.get("__name__") == "reel_api.app"
                 and caller.f_code.co_name == "undo_library_add"
                 and caller.f_locals.get("delete_files") is True)
        confirmed = {"kind": kind, "media_id": media_id, "route": route, "answered": False}
        token = _FILES_DELETE.set(confirmed)
        try:
            result = await real_delete(self, kind, media_id, *a, **kw)
        finally:
            _FILES_DELETE.reset(token)
        confirmed["answered"] = True
        return result

    async def delete_title_and_files(self, arr_id):
        watch.sent.append((self.kind, arr_id, _FILES_DELETE.get()))
        return await real_files(self, arr_id)

    monkeypatch.setattr(undo_mod.Undo, "delete_with_files", delete_with_files)
    monkeypatch.setattr(arr_mod.ArrClient, "delete_title_and_files", delete_title_and_files)
    yield watch
    bad = watch.violations()
    arr_support.LIVE.clear()
    assert not bad, "\n  ".join(["arr title DELETEs break the library-files rule:", *bad])


@pytest.fixture(autouse=True)
def jellyfin_spec_guard(jf_auth):
    """Every JellyfinSim — and the guard's JellyfinAuthSim (`jf_auth`) —
    validates the requests it gets and the answers it gives against Jellyfin
    12.1's OpenAPI (tests/support/jfspec.py); a test whose traffic left a
    violation fails at teardown, even when reel-api swallowed the error. A
    test that provokes one on purpose clears `sim.violations` after asserting
    it. Without the fetched subset (tests/fetch_fixtures.py) a test with any
    Jellyfin traffic fails here with the fetch command — never skipped."""
    from tests.support import jellyfin
    from tests.support.jfspec import MISSING

    jellyfin.LIVE.clear()
    yield
    bad = [v for sim in [*jellyfin.LIVE, jf_auth] for v in sim.violations]
    jellyfin.LIVE.clear()
    if MISSING in bad:
        pytest.fail(MISSING, pytrace=False)
    assert not bad, "JellyfinSim traffic off the 12.1 spec:\n  " + "\n  ".join(dict.fromkeys(bad))


@pytest.fixture(autouse=True)
def no_real_ytdlp(monkeypatch, tmp_path):
    """yt-dlp runs as a subprocess, which pytest-socket can't block, and a
    real one may be on PATH. Every test sees a stand-in first on PATH that
    exits 97 and leaves a mark; the test then fails at teardown, even if the
    trailer code turned the failure into a job error. FakeYtDlp (tests/support/
    fake_ytdlp.py) prepends its own directory and so shadows this one."""
    bin_dir = tmp_path / "no-real-ytdlp"
    bin_dir.mkdir()
    mark = tmp_path / "real-ytdlp-was-called"
    exe = bin_dir / "yt-dlp"
    exe.write_text(f"#!{sys.executable}\nimport sys\nopen({str(mark)!r}, 'a').write(' '.join(sys.argv) + '\\n')\n"
                   "sys.stderr.write('ERROR: the test suite never runs a real yt-dlp\\n')\nsys.exit(97)\n")
    exe.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")
    yield exe
    assert not mark.exists(), f"a test reached the yt-dlp on PATH without FakeYtDlp: {mark.read_text()}"


@pytest.fixture(autouse=True)
def upstream():
    """The respx router every httpx client in reel-api goes through.
    Unmocked requests raise; unused routes are fine."""
    with respx.mock(assert_all_mocked=True, assert_all_called=False) as router:
        yield router


_GUARD_AUTH = re.compile(r'MediaBrowser Token="([^"]*)"')


class JellyfinAuthSim:
    """Jellyfin 12.1's GET /Users/Me as the request guard asks it: the
    Authorization header is exactly `MediaBrowser Token="…"` (no Client/Device
    fields). Answers 200 with a 12.1 UserDto — Id, Name and Policy.IsAdministrator
    from `users` (`names` and `admins` by user id; TEST_USER "kirill" is the
    admin, NICOLE_USER "nicole" and ZHENYA_USER "Zhenya" are not) — for a token
    in `users`, 401 otherwise; `fault` (an exception or an httpx.Response)
    replaces the answer while set. Requests in any other form (push.py's full
    MediaBrowser header) fall through to the test's own /Users/Me routes. Its
    requests and its own answers (not a fault: those are off the spec on
    purpose) are checked against the 12.1 spec like JellyfinSim's —
    `violations`, which jellyfin_spec_guard fails at teardown."""

    def __init__(self, router):
        self.users: dict[str, str] = {TEST_TOKEN: TEST_USER, NICOLE_TOKEN: NICOLE_USER,
                                      ZHENYA_TOKEN: ZHENYA_USER}
        self.names: dict[str, str] = {TEST_USER: "kirill", NICOLE_USER: "nicole", ZHENYA_USER: "Zhenya"}
        self.admins: set[str] = {TEST_USER}
        self.fault: Exception | httpx.Response | None = None
        self.asked: list[str] = []  # tokens, in order
        self.urls: list[str] = []
        self.violations: list[str] = []
        self.gate: asyncio.Event | None = None  # while set, answers wait for it
        self.active = 0  # checks being answered right now (with a gate)
        self.max_active = 0
        self.install(router)

    def install(self, router) -> None:
        """(Re-)register the route — again after a test cleared `upstream.routes`.
        The fixture registers it first, so it is consulted before any route a
        test adds."""
        self.route = router.route(method="GET", path__regex=r"/Users/Me$", name="guard_users_me")
        self.route.side_effect = self._answer

    def _answer(self, request: httpx.Request):
        m = _GUARD_AUTH.fullmatch(request.headers.get("Authorization", ""))
        if not m:
            return None  # not the guard: the next matching route answers
        self.asked.append(m.group(1))
        self.urls.append(str(request.url))
        # the route matches /Users/Me under any base path (Jellyfin's BaseUrl)
        self.violations += jf_spec().request(
            httpx.Request("GET", "http://jellyfin.test/Users/Me", params=request.url.params,
                          headers=request.headers))
        if self.gate is not None:
            return self._gated(m.group(1))
        return self._result(m.group(1))

    async def _gated(self, token: str):
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            await self.gate.wait()
        finally:
            self.active -= 1
        return self._result(token)

    def _result(self, token: str):
        if isinstance(self.fault, Exception):
            raise self.fault
        if self.fault is not None:
            return self.fault
        uid = self.users.get(token)
        if uid is None:
            resp = httpx.Response(401)
            self.violations += jf_spec().response("GET /Users/Me", 401, None, set())
            return resp
        body = user_dto(uid, self.names.get(uid, "Test"), admin=uid in self.admins)
        self.violations += jf_spec().response("GET /Users/Me", 200, body, set())
        return httpx.Response(200, json=body)


@pytest.fixture(autouse=True)
def jf_auth(upstream):
    """The guard's Jellyfin (JellyfinAuthSim), at whatever JELLYFIN_URL is."""
    return JellyfinAuthSim(upstream)


@pytest.fixture(autouse=True)
def requests_mock():
    """`responses` for the requests library (pywebpush). Unmocked -> ConnectionError."""
    with responses_lib.RequestsMock(assert_all_requests_are_fired=False) as rsps:
        yield rsps


# ---------------------------------------------------------------- app


def _reset_module_state():
    from reel_api import livehls, push, streaming

    streaming._stream_gen.clear()
    streaming._probe_cache.clear()
    for job in list(livehls.live.jobs.values()):
        if job.task and not job.task.done():
            job.task.cancel()
    if livehls.live.reaper is not None and not livehls.live.reaper.done():
        livehls.live.reaper.cancel()
    livehls.live = livehls.LiveHls()
    livehls._qb_getter = None
    if getattr(push, "_push", None) is not None and push._push.task is not None:
        push._push.task.cancel()
    push._push = None


@pytest.fixture
def app_module(monkeypatch):
    """A freshly reloaded reel_api.app (empty caches, new singletons).
    The background warm-up (_keep_warm: IMDb trending + charts) is replaced
    by a no-op; tests of it call app_module._keep_warm_real."""
    import reel_api.app as app_mod

    _reset_module_state()
    app_mod = importlib.reload(app_mod)
    app_mod._keep_warm_real = app_mod._keep_warm

    async def _no_warm():
        return None

    monkeypatch.setattr(app_mod, "_keep_warm", _no_warm)
    yield app_mod
    _reset_module_state()


@pytest.fixture
def qbit(upstream):
    """A stateful fake qBittorrent at QBIT (http://qbit.test)."""
    return QbitSim(upstream)


@pytest.fixture
def sonarr(upstream):
    """A stateful fake Sonarr v4 at SONARR (tests/support/arr.py)."""
    return ArrSim(upstream, "tv", SONARR, SONARR_KEY)


@pytest.fixture
def radarr(upstream):
    """A stateful fake Radarr v5 at RADARR (tests/support/arr.py)."""
    return ArrSim(upstream, "movie", RADARR, RADARR_KEY)


# ---------------------------------------------------------------- error bodies

# README "Errors": error responses never mention the upstream site or fetch
# mechanics. Every response with status >= 400 that any test gets from the app
# (through make_api / api) is recorded and checked after the test.
UPSTREAM_WORDS = re.compile(
    r"sonarr|radarr|prowlarr|qbittorrent|aria2|flaresolverr|imdb|introdb|\.test\b|httpx",
    re.IGNORECASE)

# Exact (status, body) pairs that do leak, per run/findings.md entry. A pair is
# exempt only in a test marked known_bug(<that finding>) (tests/support/
# known_bugs.py) — i.e. a strict xfail that asserts the body does NOT leak.
# Everywhere else, and in that test once the bug is fixed, nothing is exempt.
KNOWN_LEAKS: dict[str, set[tuple[int, str]]] = {
    # empty: F13 (livehls naming qBittorrent) was the last one, fixed
}

ERROR_BODIES: list[tuple[str, str, int, str]] = []  # (method, path, status, body) of the running test


def checked_text(body: str) -> str:
    """The part of an error body the rule applies to. A FastAPI validation
    error (422, detail = list) names the API's *own* parameters in `loc` (e.g.
    the documented path parameter `imdb_id`): those are dropped, its messages
    and echoed input are kept."""
    try:
        data = json.loads(body)
    except ValueError:
        return body
    if isinstance(data, dict) and isinstance(data.get("detail"), list):
        data = {**data, "detail": [{k: v for k, v in d.items() if k != "loc"} if isinstance(d, dict) else d
                                   for d in data["detail"]]}
    return json.dumps(data, ensure_ascii=False)


GUARDED: list[tuple[str, str]] = []  # (method, path) sent with TEST_AUTH to a guarded route
OPEN_ROUTES = {("GET", "/health"), ("HEAD", "/health"), ("POST", "/api/push/unsubscribe")}


class _RecordingTransport(httpx.ASGITransport):
    async def handle_async_request(self, request):
        if (request.headers.get("Authorization") == TEST_AUTH
                and (request.method, request.url.path) not in OPEN_ROUTES):
            GUARDED.append((request.method, request.url.path))
        response = await super().handle_async_request(request)
        if response.status_code >= 400:
            body = await response.aread()
            ERROR_BODIES.append((request.method, request.url.path, response.status_code,
                                 body.decode("utf-8", "replace")))
        return response


@pytest.fixture(autouse=True)
def no_upstream_in_error_bodies(request):
    """Fails the test (at teardown) if an error body it received names an upstream."""
    exempt = set().union(*(KNOWN_LEAKS.get(f, set()) for f in finding_ids(request.node)))
    ERROR_BODIES.clear()
    yield ERROR_BODIES
    leaks = [e for e in ERROR_BODIES
             if UPSTREAM_WORDS.search(checked_text(e[3])) and (e[2], e[3]) not in exempt]
    ERROR_BODIES.clear()
    assert not leaks, f"error bodies mention an upstream: {leaks}"


@pytest.fixture
def make_api(app_module, reel_env, upstream, jf_auth):
    """make_api(**env) -> async context manager yielding an httpx.AsyncClient
    on the app, after its lifespan has started with FULL_ENV updated by env
    (a value of None removes a variable).

        async with make_api(RADARR_API_KEY=None) as api:
            r = await api.get("/api/lookup", params={"q": "x", "type": "movie"})

    An exception no handler maps propagates into the test by default (so a
    test can't mistake a crash for an error response). Pass
    raise_app_exceptions=False to see what a real client gets (a plain 500).

    The client signs every request with TEST_AUTH; `auth=None` sends none,
    `auth="<header value>"` another one (a request's own headers win too).
    """
    GUARDED.clear()

    @asynccontextmanager
    async def factory(*, raise_app_exceptions: bool = True, auth: str | None = TEST_AUTH, **env):
        reel_env(**{**FULL_ENV, **env})
        headers = {"Authorization": auth} if auth else {}
        async with LifespanManager(app_module.app) as mgr:
            transport = _RecordingTransport(app=mgr.app, raise_app_exceptions=raise_app_exceptions)
            async with httpx.AsyncClient(transport=transport, base_url=REEL, headers=headers) as client:
                client.app_module = app_module
                yield client

    yield factory
    # The guard is exercised, never bypassed: a guarded request sent with the
    # test token must have made it ask Jellyfin (once per app: it caches).
    if GUARDED:
        assert TEST_TOKEN in jf_auth.asked, f"guarded requests {GUARDED[:3]} never reached the /Users/Me check"
    GUARDED.clear()


@pytest.fixture
async def api(make_api):
    """The app with every backend configured (FULL_ENV), push disabled."""
    async with make_api() as client:
        yield client


# ---------------------------------------------------------------- time


@pytest.fixture
def clock(monkeypatch):
    """A FakeClock (auto-advancing). Patch modules with clock.install(monkeypatch, mod, ...)."""
    return FakeClock()


@pytest.fixture
def manual_clock():
    """A FakeClock whose sleeps wait for `await manual_clock.advance(s)`."""
    return FakeClock(auto=False)


# ---------------------------------------------------------------- media


def _need_ffmpeg():
    from tests.support.media import HAVE_FFMPEG

    if not HAVE_FFMPEG:
        pytest.skip("ffmpeg/ffprobe not on PATH")


@pytest.fixture(scope="session")
def media_dir(tmp_path_factory) -> Path:
    return tmp_path_factory.mktemp("media")


@pytest.fixture(scope="session")
def sample_mkv(media_dir) -> Path:
    """2 s H.264 MKV: E-AC-3 5.1 eng (default), AC-3 2.0 ger, AAC 2.0 eng
    "Commentary", one SRT sub, chapters "Intro" / "Chapter 02"."""
    _need_ffmpeg()
    from tests.support.media import make_media

    return make_media(media_dir / "sample.mkv")


@pytest.fixture(scope="session")
def sample_hevc_mkv(media_dir) -> Path:
    """Like sample_mkv but HEVC video."""
    _need_ffmpeg()
    from tests.support.media import Spec, make_media

    return make_media(media_dir / "sample-hevc.mkv", Spec(video="hevc"))


@pytest.fixture
def ffmpeg_available():
    _need_ffmpeg()
    return shutil.which("ffmpeg")


# ---------------------------------------------------------------- public specs


@pytest.fixture(scope="session")
def _spec_cache_session():
    from tests.support.specs import SpecCache

    return SpecCache()


@pytest.fixture
def spec_cache(_spec_cache_session):
    """The cached public Sonarr/Radarr/qBittorrent specs (tests/support/specs.py).
    Skips the test when any of them is missing (fetch: tests/specs/fetch_specs.py)."""
    from tests.support.specs import FETCH_HINT

    missing = _spec_cache_session.missing()
    if missing:
        pytest.skip(f"spec cache incomplete ({', '.join(missing)}): {FETCH_HINT}")
    return _spec_cache_session


# ---------------------------------------------------------------- scenes


@pytest.fixture
def world(make_api, app_module, upstream, sonarr, radarr, qbit, reel_env, requests_mock, monkeypatch,
          tmp_path, request):
    """Everything a scene (tests/support/scenes.py) builds its answer from."""
    from tests.support.scenes import World

    return World(make_api=make_api, upstream=upstream, sonarr=sonarr, radarr=radarr, qbit=qbit,
                 reel_env=reel_env, requests_mock=requests_mock, monkeypatch=monkeypatch,
                 tmp_path=tmp_path, getfixture=request.getfixturevalue, app_module=app_module)
