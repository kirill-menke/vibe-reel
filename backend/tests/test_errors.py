"""The error contract (backend/README.md "Errors"), swept in one place.

Every exception handler in app.py and the JSON errors push / livehls /
streaming build themselves: status, body.error, a detail string, and
Retry-After exactly where documented (30 download / library, 300 charts /
trending / collections, 10 not_ready, 3600 probe) and nowhere else.

The rule that no error body names an upstream is enforced for the WHOLE
suite by conftest.no_upstream_in_error_bodies (every response >= 400 any
test receives through make_api is recorded and checked); the tests at the
bottom check that checker.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable

import httpx
import pytest

from tests.conftest import KNOWN_LEAKS, UPSTREAM_WORDS, checked_text
from tests.support.arr import episode_obj, movie_obj, season_obj, series_obj
from tests.support.imdb import ImdbSim
from tests.support.qbit import SimFile, SimTorrent, make_hash

SKY = "https://api.radarr.video/v1/movie/collection/"
UNAVAILABLE = "temporarily_unavailable"


@dataclass
class Case:
    id: str
    status: int
    error: str | None
    detail: str | None
    retry_after: str | None
    run: Callable[..., Awaitable[httpx.Response]]
    env: dict | None = None


@dataclass
class Ctx:
    api: httpx.AsyncClient
    upstream: object
    sonarr: object
    radarr: object
    qbit: object
    monkeypatch: object


async def add_then_has_files(c: Ctx) -> httpx.Response:
    c.radarr.add_catalog(movie_obj(603, "The Matrix"))
    r = await c.api.post("/api/library", json={"id": "603", "type": "movie"})
    assert r.status_code == 202
    c.radarr.title(603)["hasFile"] = True
    return await c.api.delete("/api/library/movie/603", params={"undo": r.json()["undo"]})


async def not_aired(c: Ctx) -> httpx.Response:
    soon = datetime.now(timezone.utc) + timedelta(days=3)
    c.sonarr.add_series(series_obj(5, "Upcoming", monitored=False, seasons=[season_obj(1, monitored=False)]),
                        [episode_obj(1, 1, air=soon)])
    return await c.api.post("/api/news/search", json={"id": "5", "season": 1})


async def already_added(c: Ctx) -> httpx.Response:
    c.sonarr.add_catalog(series_obj(7, "Dark"))
    c.sonarr.add_series(series_obj(7, "Dark"))
    return await c.api.post("/api/library", json={"id": "7", "type": "tv"})


async def metadata_only_torrent(c: Ctx, path: str) -> httpx.Response:
    h = make_hash("errors-no-video")
    c.qbit.add_torrent(SimTorrent(hash=h, name="x", files=[SimFile("readme.nfo", 10)]))
    return await c.api.get(f"/api/downloads/{h}/{path}")


async def probe_without_ffprobe(c: Ctx) -> httpx.Response:
    from reel_api import streaming
    from tests.support.clock import _Proxy

    h = make_hash("errors-probe")
    c.qbit.add_torrent(SimTorrent(hash=h, name="Movie.mkv", content_path="/downloads/Movie.mkv",
                                  files=[SimFile("Movie.mkv", 4096)], pieces=[2]))
    c.monkeypatch.setattr(streaming, "shutil", _Proxy(streaming.shutil, which=lambda name: None))
    return await c.api.get(f"/api/downloads/{h}/probe")


async def imdb_down(c: Ctx, path: str) -> httpx.Response:
    ImdbSim(c.upstream).fail(status=500, times=50)
    return await c.api.get(path)


async def sky(c: Ctx, status: int) -> httpx.Response:
    c.upstream.get(url__startswith=SKY).respond(status)
    return await c.api.get("/api/collection/1234")


async def qbit_down(c: Ctx) -> httpx.Response:
    # unreachable (a non-JSON HTTP error answer is F1: a plain 500)
    c.qbit.fail("/torrents/info", exc=httpx.ConnectError("refused"), times=5)
    return await c.api.get(f"/api/downloads/{GID}/probe")


async def get(c: Ctx, path: str, **params) -> httpx.Response:
    return await c.api.get(path, params=params)


DL = "download service temporarily unavailable, retry later"
LIB = "library service temporarily unavailable, retry later"
GID = make_hash("errors-unknown")

CASES = [
    # --- downloads (qBittorrent)
    Case("no-such-download", 404, "not_found", "no such download", None,  # the NoSuchDownload handler
         lambda c: get(c, "/api/downloads/all/probe")),
    Case("download-backend-down", 503, UNAVAILABLE, DL, "30", qbit_down),
    Case("no-download-backend", 503, UNAVAILABLE, DL, "30", lambda c: get(c, f"/api/downloads/{GID}/probe"),
         {"QBIT_URL": None}),
    Case("stream-needs-qbit", 503, UNAVAILABLE, DL, "30", lambda c: get(c, f"/api/downloads/{GID}/stream"),
         {"QBIT_URL": None}),
    # --- streaming / probe
    Case("stream-unknown", 404, "not_found", "no such download", None,
         lambda c: get(c, f"/api/downloads/{GID}/stream")),
    Case("stream-not-ready", 409, "not_ready", "torrent metadata not resolved yet", "10",
         lambda c: metadata_only_torrent(c, "stream")),
    Case("probe-not-ready", 409, "not_ready", "torrent metadata not resolved yet", "10",
         lambda c: metadata_only_torrent(c, "probe")),
    Case("probe-unavailable", 503, UNAVAILABLE, "probing unavailable", "3600", probe_without_ffprobe),
    # --- livehls
    Case("hls-bad-id", 400, "bad_request", "bad download id", None,
         lambda c: c.api.post("/api/downloads/not-a-hash/hls")),
    Case("hls-not-started", 404, "not_found", "not started", None,
         lambda c: get(c, f"/api/downloads/{GID}/hls")),
    # --- library (Sonarr / Radarr)
    Case("arr-down", 503, UNAVAILABLE, LIB, "30",
         lambda c: (c.sonarr.fail("/api/v3/series/lookup", status=500), get(c, "/api/lookup", q="x", type="tv"))[1]),
    Case("arr-not-configured", 503, "not_available", "that media type is not available", None,
         lambda c: get(c, "/api/lookup", q="x", type="movie"), {"RADARR_API_KEY": None}),
    Case("no-such-title", 404, "not_found", "no such title", None, lambda c: get(c, "/api/metadata/tv/999")),
    Case("bad-type", 400, "bad_type", "type must be tv or movie", None, lambda c: get(c, "/api/metadata/book/1")),
    Case("already-added", 409, "already_added", "already in the library: Dark", None, already_added),
    Case("not-aired", 409, "not_aired", "nothing has aired yet: Upcoming season 1", None, not_aired),
    Case("undo-expired", 410, "undo_expired", "this can no longer be undone", None,
         lambda c: get_delete(c, "/api/library/tv/81189", undo="x" * 22)),
    Case("refused", 409, "has_files", "“The Matrix” already has files in the library", None, add_then_has_files),
    Case("nothing-to-cancel", 404, "not_in_queue", "nothing of that is downloading", None,
         lambda c: get_delete(c, "/api/activity/movie/9")),
    Case("cancel-episode-needs-season", 400, "bad_request", "episode needs season", None,
         lambda c: get_delete(c, "/api/activity/tv/1", episode=2)),
    Case("cancel-movie-season", 400, "bad_request", "a movie has no seasons", None,
         lambda c: get_delete(c, "/api/activity/movie/1", season=1)),
    Case("not-owner", 403, "not_owner", "“The Matrix” was added by an admin; only an admin can delete it.", None,
         lambda c: nicole_deletes_legacy(c)),
    Case("delete-without-undo-or-files", 400, "bad_request", "pass either undo=<token> or delete_files=true",
         None, lambda c: get_delete(c, "/api/library/movie/603")),
    # --- IMDb charts / trending, Radarr metadata service collections
    Case("charts-down", 503, UNAVAILABLE, "charts temporarily unavailable, retry later", "300",
         lambda c: imdb_down(c, "/api/charts/top-movie")),
    Case("no-such-chart", 404, "no_such_chart", "no chart nope", None, lambda c: get(c, "/api/charts/nope")),
    Case("trending-down", 503, UNAVAILABLE, "trending list temporarily unavailable, retry later", "300",
         lambda c: imdb_down(c, "/api/trending?type=movie")),
    Case("collection-down", 503, UNAVAILABLE, "collection temporarily unavailable, retry later", "300",
         lambda c: sky(c, 500)),
    Case("no-such-collection", 404, "not_found", "no such collection", None, lambda c: sky(c, 404)),
    # --- trailers
    Case("trailer-bad-id", 400, "bad_id", "not a YouTube video id", None, lambda c: get(c, "/api/trailers/short")),
    Case("trailer-not-started", 404, "not_found", "trailer not started", None,
         lambda c: get(c, "/api/trailers/fakeTrailr1")),
    # --- push (disabled in FULL_ENV)
    Case("push-off", 503, "not_available", "push notifications are not set up", None,
         lambda c: c.api.post("/api/push/status", json={})),
]


async def nicole_deletes_legacy(c: Ctx) -> httpx.Response:
    from tests.conftest import NICOLE_TOKEN, auth_for

    c.radarr.add_movie(movie_obj(603, "The Matrix"))
    return await c.api.delete("/api/library/movie/603", params={"delete_files": "true"},
                              headers={"Authorization": auth_for(NICOLE_TOKEN)})


async def get_delete(c: Ctx, path: str, **params) -> httpx.Response:
    return await c.api.delete(path, params=params)


@pytest.mark.parametrize("case", CASES, ids=[c.id for c in CASES])
async def test_error_contract(make_api, upstream, sonarr, radarr, qbit, monkeypatch, case):
    async with make_api(**(case.env or {})) as api:
        r = await case.run(Ctx(api, upstream, sonarr, radarr, qbit, monkeypatch))
    assert r.status_code == case.status, r.text
    body = r.json()
    assert set(body) == {"error", "detail"}
    assert body["error"] == case.error
    assert isinstance(body["detail"], str) and body["detail"]
    assert body["detail"] == case.detail
    assert r.headers.get("retry-after") == case.retry_after
    assert r.headers["content-type"] == "application/json"
    assert not UPSTREAM_WORDS.search(r.text)


def test_every_handler_has_a_case(app_module):
    """A new exception handler needs a row above."""
    handled = {getattr(k, "__name__", str(k)) for k in app_module.app.exception_handlers}
    covered = {
        "NoSuchDownload", "DownloadError", "ArrError", "ChartsError", "NoSuchChart", "CollectionsError",
        "NoSuchCollection", "TrendingError", "ArrNotConfigured", "NoSuchTitle", "NotAired", "UndoGone",
        "Refused", "NothingToCancel", "AlreadyAdded", "NotOwner",
        # its 409 body is {error, detail, type, used, limit}: test_quota.py pins it exactly
        "QuotaExceeded",
        # FastAPI's own
        "HTTPException", "RequestValidationError", "WebSocketRequestValidationError",
    }
    assert handled <= covered, handled - covered
    assert len(CASES) >= 20


async def test_validation_errors_are_fastapi_422(api):
    r = await api.get("/api/lookup")
    assert r.status_code == 422
    (err,) = r.json()["detail"]
    assert err["loc"] == ["query", "q"] and err["type"] == "missing"
    assert "retry-after" not in r.headers


async def test_unknown_route_is_framework_404(api):
    r = await api.get("/api/nope")
    assert r.status_code == 404 and r.json() == {"detail": "Not Found"}


async def test_an_unhandled_crash_is_a_plain_500(make_api, monkeypatch):
    async with make_api(raise_app_exceptions=False) as api:
        async def boom(*a, **kw):
            raise RuntimeError("sonarr.test exploded: httpx internals")

        monkeypatch.setattr(api.app_module.trending, "get", boom)
        r = await api.get("/api/trending", params={"type": "movie"})
    assert r.status_code == 500
    assert r.text == "Internal Server Error"
    assert "retry-after" not in r.headers


async def test_livehls_without_qbittorrent_is_the_generic_503(make_api):
    """Without qBittorrent, POST …/hls is the same generic 503 the app's own
    /stream and /probe give for that situation: no backend named in the body
    (README "Errors"), Retry-After 30. It used to say "streaming needs the
    qBittorrent backend" without Retry-After (F13)."""
    async with make_api(QBIT_URL=None) as api:
        r = await api.post(f"/api/downloads/{GID}/hls")
        same = await api.get(f"/api/downloads/{GID}/stream")
    assert same.status_code == 503 and not UPSTREAM_WORDS.search(same.text)
    assert r.status_code == 503
    assert not UPSTREAM_WORDS.search(r.text), r.text
    assert r.json() == same.json() and r.headers.get("retry-after") == same.headers.get("retry-after") == "30"


def test_known_leaks_are_only_exempt_under_their_finding():
    """KNOWN_LEAKS (keyed by finding, exempt only under known_bug(<finding>))
    is empty since F13 was fixed: every error body is checked everywhere. A
    new entry needs a known_bug test for its finding."""
    assert KNOWN_LEAKS == {}


# ---------------------------------------------------------------- the suite-wide checker


async def test_the_recorder_sees_every_error_body(api, no_upstream_in_error_bodies):
    await api.get("/api/charts/nope")
    await api.get("/health")
    await api.get("/api/lookup")
    assert [(m, p, s) for m, p, s, _ in no_upstream_in_error_bodies] == [
        ("GET", "/api/charts/nope", 404), ("GET", "/api/lookup", 422)]
    assert json.loads(no_upstream_in_error_bodies[0][3])["error"] == "no_such_chart"


@pytest.mark.parametrize("body, flagged", [
    ('{"error":"x","detail":"Sonarr said no"}', True),
    ('{"error":"x","detail":"from http://radarr.test/api"}', True),
    ('{"error":"x","detail":"httpx.ConnectError"}', True),
    ('{"error":"x","detail":"IMDb is down"}', True),
    ('{"error":"x","detail":"qBittorrent login failed"}', True),
    ('{"error":"x","detail":"aria2 rpc"}', True),
    ('{"error":"x","detail":"no such torrent"}', False),
    ("Internal Server Error", False),
    # a validation error names the API's own parameter (imdb_id) in loc: not an upstream
    ('{"detail":[{"type":"missing","loc":["path","imdb_id"],"msg":"Field required","input":null}]}', False),
    ('{"detail":[{"type":"x","loc":["query","q"],"msg":"Value error, sonarr","input":"a"}]}', True),
])
def test_the_checker(body, flagged):
    assert bool(UPSTREAM_WORDS.search(checked_text(body))) is flagged
