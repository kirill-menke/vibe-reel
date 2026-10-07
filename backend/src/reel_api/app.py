import asyncio
import logging
import time
from collections import OrderedDict
from contextlib import asynccontextmanager, nullcontext
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, Path, Query, Request
from fastapi.responses import JSONResponse
from starlette.middleware.gzip import GZipMiddleware

from . import qbittorrent as qbit
from . import streaming
from . import push as push_mod
from . import livehls
from . import trending as trending_mod
from .trending import Trending, TrendingError
from .charts import Charts, ChartsError, NoSuchChart
from .collections import Collections, CollectionsError, NoSuchCollection
from .introdb import IntroDB
from .trailers import FILE as TRAILER_FILE, Trailers, parse_key as trailer_key
from .arr import AlreadyAdded, ArrError, ArrNotConfigured, NoSuchTitle, NotAired, _poster, _when, make_arr_clients
from .undo import NothingToCancel, Refused, Undo, UndoGone, log as action_log
from .ownership import Listings, NotOwner, Owners, Quota, QuotaExceeded, exists, limits_from_env
from .security import Guard, User, install_log_redaction
from .models import (
    Chart,
    ChartIndex,
    Collection,
    CommunitySegments,
    ActivityResponse,
    CancelResult,
    LibraryAddRequest,
    LibraryAddResult,
    LibraryUndoResult,
    LookupResponse,
    MeResponse,
    NewsResponse,
    SeasonSearchRequest,
    SeasonSearchResult,
    SeasonSearchUndoResult,
    TitleMetadata,
    TrendingResponse,
)

WARM_EVERY = 2 * 3600  # background refresh period for trending + charts
# Refresh anything that would expire before the pass after next could catch
# it, so the TV never lands on an expired (cold, ~5 s) entry.
WARM_MARGIN = WARM_EVERY + 600

log = logging.getLogger("reel_api")


# Backends are built at startup, not import — so importing this module has no
# side effects (and needs no backend deps). qBittorrent (QBIT_URL) is only ever
# read and steered — live progress, the sequential fix-up, streaming, cancel —
# never handed a torrent: the arrs add every grab. Unset = None, and the routes
# that need it answer 503.
downloader: qbit.QBittorrentClient | None = None
arr_clients: dict = {}
trending: Trending | None = None
charts: Charts | None = None
collections: Collections | None = None
introdb = IntroDB()
trailers = Trailers()
undo: Undo | None = None
owners: Owners | None = None  # who added which title (ownership.py)
listings: Listings | None = None
quota: Quota | None = None


@asynccontextmanager
async def lifespan(app):
    global downloader, arr_clients, trending, charts, collections, undo, owners, listings, quota
    downloader = qbit.make_download_client()
    arr_clients = make_arr_clients()
    push_mod.start(arr_clients)  # Web Push watcher (push.py)
    trending = Trending(arr_clients)
    charts = Charts(arr_clients)
    collections = Collections(arr_clients["movie"]) if "movie" in arr_clients else None
    undo = Undo(arr_clients, downloader)
    owners = Owners()
    listings = Listings(arr_clients)
    quota = Quota(owners, listings, limits_from_env())
    warm = asyncio.create_task(_keep_warm())  # held so it isn't collected mid-run
    yield
    warm.cancel()


async def _keep_warm():
    """Background pre-warm: trending (Home's rails) first, then every chart
    category, at startup and every WARM_EVERY — never on the request path, and
    never fatal: a failed pass only logs, and requests still fetch on demand."""
    margin = 0  # first pass: fill the empty caches
    while True:
        t0 = time.monotonic()
        for kind in ("tv", "movie"):
            if kind in arr_clients:
                try:
                    await trending.get(kind, ttl=max(trending_mod.CACHE_TTL - margin, 0))
                except Exception as e:
                    log.warning("warm-up: trending %s failed: %s", kind, e)
        try:
            await charts.warm(margin=margin)
        except Exception as e:  # warm() logs its own; this is belt and braces
            log.warning("warm-up: charts failed: %s", e)
        log.info("warm-up pass done in %.1f s", time.monotonic() - t0)
        margin = WARM_MARGIN
        await asyncio.sleep(WARM_EVERY)


app = FastAPI(title="reel-api", version="0.1.0", lifespan=lifespan)


class _GZipExceptStreams:
    """gzip for the JSON API (a Top 250 chart is 139 KB raw, ~50 KB gzipped),
    but never for the video stream: it answers Range requests of a growing
    file with 206 + Content-Range + Content-Length, and gzip would drop the
    length, re-chunk the body and make the byte offsets meaningless to the
    player. Starlette's GZipMiddleware only skips text/event-stream, so the
    route is bypassed by path before it gets a look."""

    def __init__(self, app, minimum_size: int = 1024, compresslevel: int = 6):
        self.app = app
        self.gzip = GZipMiddleware(app, minimum_size=minimum_size, compresslevel=compresslevel)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and (scope.get("path", "").endswith("/stream") or "/hls/" in scope.get("path", "")):
            await self.app(scope, receive, send)
        else:
            await self.gzip(scope, receive, send)


app.add_middleware(_GZipExceptStreams)
# Added last = outermost: Host/Origin checks and the Jellyfin sign-in run
# before anything else sees the request (security.py).
app.add_middleware(Guard)
install_log_redaction()
app.include_router(push_mod.router)
app.include_router(livehls.router)  # phone: the growing download as HLS (livehls.py)
livehls.register(lambda: downloader)

# Error responses never mention a backend or its mechanics — the API presents
# failures as its own. Real causes go to the server log.


def _unavailable(detail: str, retry_after: str):
    return JSONResponse(
        status_code=503,
        headers={"Retry-After": retry_after},
        content={"error": "temporarily_unavailable", "detail": detail},
    )


def _not_found(detail: str):
    return JSONResponse(status_code=404, content={"error": "not_found", "detail": detail})


@app.exception_handler(qbit.NoSuchDownload)
async def no_download_handler(request, exc):
    return _not_found("no such download")


@app.exception_handler(qbit.DownloadError)
async def download_error_handler(request, exc):
    log.error("download backend: %s", exc)
    return _unavailable("download service temporarily unavailable, retry later", "30")


@app.exception_handler(ArrError)
async def arr_error_handler(request, exc):
    log.error("library backend: %s", exc)
    return _unavailable("library service temporarily unavailable, retry later", "30")


@app.exception_handler(ChartsError)
async def charts_error_handler(request, exc):
    log.error("charts: %s", exc)
    return _unavailable("charts temporarily unavailable, retry later", "300")


@app.exception_handler(NoSuchChart)
async def no_such_chart_handler(request, exc):
    return JSONResponse(status_code=404, content={"error": "no_such_chart", "detail": f"no chart {exc}"})


@app.exception_handler(CollectionsError)
async def collections_error_handler(request, exc):
    log.error("collections: %s", exc)
    return _unavailable("collection temporarily unavailable, retry later", "300")


@app.exception_handler(NoSuchCollection)
async def no_such_collection_handler(request, exc):
    return _not_found("no such collection")


@app.exception_handler(TrendingError)
async def trending_error_handler(request, exc):
    log.error("trending: %s", exc)
    return _unavailable("trending list temporarily unavailable, retry later", "300")


@app.exception_handler(ArrNotConfigured)
async def arr_not_configured_handler(request, exc):
    return JSONResponse(
        status_code=503,
        content={"error": "not_available", "detail": "that media type is not available"},
    )


@app.exception_handler(NoSuchTitle)
async def no_title_handler(request, exc):
    return _not_found("no such title")


@app.exception_handler(NotAired)
async def not_aired_handler(request, exc):
    return JSONResponse(
        status_code=409,
        content={"error": "not_aired", "detail": f"nothing has aired yet: {exc}"},
    )


@app.exception_handler(UndoGone)
async def undo_gone_handler(request, exc):
    return JSONResponse(
        status_code=410,
        content={"error": "undo_expired", "detail": "this can no longer be undone"},
    )


@app.exception_handler(Refused)
async def refused_handler(request, exc):
    action_log.info("refused %s %s: %s", request.method, request.url.path, exc.detail)
    return JSONResponse(status_code=409, content={"error": exc.code, "detail": exc.detail})


@app.exception_handler(NothingToCancel)
async def nothing_to_cancel_handler(request, exc):
    return JSONResponse(
        status_code=404,
        content={"error": "not_in_queue", "detail": "nothing of that is downloading"},
    )


@app.exception_handler(NotOwner)
async def not_owner_handler(request, exc):
    action_log.info("refused %s %s: %s", request.method, request.url.path, exc.detail)
    return JSONResponse(status_code=403, content={"error": "not_owner", "detail": exc.detail})


@app.exception_handler(QuotaExceeded)
async def quota_exceeded_handler(request, exc):
    action_log.info("refused %s %s: quota %s %d/%d", request.method, request.url.path, exc.kind, exc.used,
                    exc.limit)
    return JSONResponse(status_code=409, content={"error": "quota_exceeded", "detail": exc.detail,
                                                  "type": exc.kind, "used": exc.used, "limit": exc.limit})


@app.exception_handler(AlreadyAdded)
async def already_added_handler(request, exc):
    return JSONResponse(
        status_code=409,
        content={"error": "already_added", "detail": f"already in the library: {exc.title}"},
    )


def current_user(request: Request) -> User:
    """The signed-in Jellyfin user (the request guard put it there)."""
    return request.state.reel_user


def require_arr(media_type: str):
    client = arr_clients.get(media_type)
    if client is None:
        raise ArrNotConfigured(media_type)
    return client


def _require_qbit() -> qbit.QBittorrentClient:
    if downloader is None:
        raise qbit.DownloadError("qBittorrent not configured (QBIT_URL)")
    return downloader


# Watch-while-downloading: Range-stream the torrent's main video file while it
# is still coming in (see streaming.py). `gid` is the info-hash — the
# `download_id` on activity items; any torrent qBittorrent has, whatever its
# category.
@app.get("/api/downloads/{gid}/stream")
@app.head("/api/downloads/{gid}/stream")
async def stream_download_file(gid: str, request: Request):
    return await streaming.stream_endpoint(_require_qbit(), gid, request)


# ffprobe of the (partial) file: real container/video/audio/subtitle metadata
# as soon as the header is on disk — what lets a client show true tech badges
# and pick audio tracks before the download finishes.
@app.get("/api/downloads/{gid}/probe")
async def probe_download_file(gid: str):
    return await streaming.probe_endpoint(_require_qbit(), gid)


MEDIA_TYPES = ("tv", "movie")


# Title lookups go out to TheTVDB/TMDB through the arr and take 0.65–2.5 s, and
# a search-as-you-type client repeats them (retyping, Back into Search). Cache
# briefly, keyed by the whitespace/case-normalised query, and let concurrent
# identical lookups share one upstream call. Only `added` can go stale within
# the TTL, and POST /api/library patches that (see _mark_added).
LOOKUP_TTL = 90
LOOKUP_MAX = 256  # entries, LRU
_lookup_cache: OrderedDict[tuple[str, str], tuple[float, list[dict]]] = OrderedDict()
_lookup_inflight: dict[tuple[str, str], asyncio.Task] = {}
# (type, id) -> when it was added here; applied to lookups that were already
# in flight (or cached) when the add landed.
_recent_adds: dict[tuple[str, str], float] = {}


def _lookup_key(q: str, media_type: str) -> tuple[str, str]:
    return (" ".join(q.split()).casefold(), media_type)


def _with_adds(media_type: str, results: list[dict]) -> list[dict]:
    now = time.monotonic()
    for k in [k for k, t in _recent_adds.items() if now - t > 2 * LOOKUP_TTL]:
        del _recent_adds[k]
    if not any(k[0] == media_type for k in _recent_adds):
        return results
    return [
        {**r, "added": True} if not r["added"] and (media_type, r["id"]) in _recent_adds else r
        for r in results
    ]


def _mark_added(media_type: str, media_id: str) -> None:
    """A title just went into the library: no cached lookup may still offer it
    as not added. Chart `added` flags come from a 60 s library-id cache — drop
    that too."""
    _recent_adds[(media_type, media_id)] = time.monotonic()
    for k, (t, results) in list(_lookup_cache.items()):
        if k[1] == media_type:
            _lookup_cache[k] = (t, _with_adds(media_type, results))
    if charts is not None:
        charts._library.pop(media_type, None)
    if collections is not None and media_type == "movie":
        collections.forget_library()


async def _cached_lookup(client, q: str, media_type: str) -> list[dict]:
    key = _lookup_key(q, media_type)
    hit = _lookup_cache.get(key)
    if hit and time.monotonic() - hit[0] < LOOKUP_TTL:
        _lookup_cache.move_to_end(key)
        return _with_adds(media_type, hit[1])
    task = _lookup_inflight.get(key)
    if task is None:
        async def run():
            try:
                results = await client.lookup(q)
                _lookup_cache[key] = (time.monotonic(), results)
                _lookup_cache.move_to_end(key)
                while len(_lookup_cache) > LOOKUP_MAX:
                    _lookup_cache.popitem(last=False)
                return results
            finally:
                _lookup_inflight.pop(key, None)

        task = _lookup_inflight[key] = asyncio.create_task(run())
    # shield: one waiter disconnecting must not cancel the others' call
    return _with_adds(media_type, await asyncio.shield(task))


@app.get("/api/lookup", response_model=LookupResponse)
async def lookup(
    q: str = Query(min_length=1),
    type: str = Query("tv", pattern="^(tv|movie)$"),
):
    client = require_arr(type)
    results = await _cached_lookup(client, q, type)
    return {"query": q, "type": type, "results": results}


@app.get("/api/trending", response_model=TrendingResponse)
async def trending_titles(type: str = Query("tv", pattern="^(tv|movie)$")):
    require_arr(type)
    return {"type": type, "results": await trending.get(type)}


@app.get("/api/charts", response_model=ChartIndex)
async def chart_index():
    return {"categories": await charts.index()}


@app.get("/api/charts/{key}", response_model=Chart)
async def chart(key: str):
    return await charts.get(key)


@app.get("/api/collection/{cid}", response_model=Collection)
async def movie_collection(cid: str = Path(pattern=r"^\d{1,10}$")):
    if collections is None:
        raise ArrNotConfigured("movie")
    return await collections.get(cid)


@app.get("/api/segments/{imdb_id}/{season}/{episode}", response_model=CommunitySegments)
async def community_segments(
    imdb_id: str = Path(pattern=r"^tt\d{5,10}$"),
    season: int = Path(ge=0, le=500),
    episode: int = Path(ge=0, le=5000),
):
    return await introdb.get(imdb_id, season, episode)


def _bad_trailer():
    return JSONResponse(status_code=400, content={"error": "bad_id", "detail": "not a YouTube video id"})


# {key}: the YouTube id (best up to 2160p) or `<id>@<height>` (best up to that
# height — the iPhone asks for @1080); see trailers.py.
@app.post("/api/trailers/{key}")
async def start_trailer(key: str):
    """Start fetching a YouTube trailer as HLS (idempotent); see trailers.py."""
    if trailer_key(key) is None:
        return _bad_trailer()
    return trailers.start(key).status()


@app.get("/api/trailers/{key}")
async def trailer_status(key: str):
    if trailer_key(key) is None:
        return _bad_trailer()
    job = trailers.get(key)
    if job is None:
        return _not_found("trailer not started")
    return job.status()


@app.get("/api/trailers/{key}/{name}")
async def trailer_file(key: str, name: str):
    if trailer_key(key) is None or not TRAILER_FILE.fullmatch(name):
        return _not_found("no such trailer file")
    return trailers.file_response(key, name)


@app.get("/api/metadata/{media_type}/{media_id}", response_model=TitleMetadata)
async def title_metadata(media_type: str, media_id: str):
    if media_type not in MEDIA_TYPES:
        return JSONResponse(
            status_code=400,
            content={"error": "bad_type", "detail": "type must be tv or movie"},
        )
    return await require_arr(media_type).metadata(media_id)


# Add a title. A normal user's add is checked against the quota and runs under
# that user's per-kind lock, so two concurrent adds can't both take the last
# slot (ownership.py); every add records the caller as the title's owner.
@app.post("/api/library", response_model=LibraryAddResult, status_code=202)
async def add_to_library(req: LibraryAddRequest, user: User = Depends(current_user)):
    if req.type not in MEDIA_TYPES:
        return JSONResponse(
            status_code=400,
            content={"error": "bad_type", "detail": "type must be tv or movie"},
        )
    client = require_arr(req.type)
    async with (nullcontext() if user.admin else owners.quota_lock(user.id, req.type)):
        deleting = undo.pending_delete(req.type, req.id)
        if deleting is not None:
            raise Refused("being_deleted", f"“{deleting.title}” is being deleted right now — add it again in a minute.")
        await quota.check(user, req.type)
        pending = undo.pending_removal(req.type, req.id)
        if pending is not None:  # undone a moment ago, removal still waiting: keep it
            result = await undo.revive_add(pending, user)
            _mark_added(req.type, req.id)
            _record(req.type, req.id, pending.arr_id, pending.title, pending.year, user)
            return result
        try:
            result = await client.add(req.id)
        except AlreadyAdded:
            _mark_added(req.type, req.id)
            raise
        _mark_added(req.type, req.id)
        arr_id, at, year = result.pop("_arr_id", None), result.pop("_at", None), result.pop("_year", None)
        result["undo"] = undo.remember_add(req.type, req.id, arr_id, result["title"], at, user=user, year=year)
        _record(req.type, req.id, arr_id, result["title"], year, user)
    action_log.info("library add: %s %s (%s), arr id %s by %s", req.type, req.id, result["title"], arr_id,
                    user.name or user.id)
    return result


def _record(kind: str, media_id: str, arr_id, title: str, year, user: User) -> None:
    owners.record_title(kind, media_id, arr_id=arr_id, title=title, year=year, user=user,
                        at=datetime.now(timezone.utc))
    listings.invalidate(kind)


def _mark_removed(media_type: str, media_id: str) -> None:
    """The reverse of _mark_added, after an undo: cached lookups may not
    offer the title as added any more."""
    _recent_adds.pop((media_type, media_id), None)
    for k, (t, results) in list(_lookup_cache.items()):
        if k[1] == media_type:
            _lookup_cache[k] = (t, [{**r, "added": False} if r["id"] == media_id else r for r in results])
    if charts is not None:
        charts._library.pop(media_type, None)
    if collections is not None and media_type == "movie":
        collections.forget_library()


# Two jobs, exactly one per request:
#  ?undo=TOKEN         undo an add — only with the token POST /api/library handed
#                      out, only while nothing of the title is in the library yet;
#                      never deletes a file (undo.py).
#  ?delete_files=true  delete the title from Sonarr/Radarr WITH ITS FILES (My
#                      library → Delete) — its owner or an admin only.
# Neither or both is a 400: a client that lost its undo token must never fall
# through to a delete.
@app.delete("/api/library/{media_type}/{media_id}", response_model=LibraryUndoResult)
async def undo_library_add(
    media_type: str = Path(pattern="^(tv|movie)$"),
    media_id: str = Path(pattern=r"^\d{1,10}$"),
    undo_token: str | None = Query(None, alias="undo", min_length=8, max_length=64),
    delete_files: bool = False,
    user: User = Depends(current_user),
):
    global _news_cache
    if (undo_token is not None) == delete_files:
        return JSONResponse(
            status_code=400,
            content={"error": "bad_request", "detail": "pass either undo=<token> or delete_files=true"},
        )
    require_arr(media_type)
    if delete_files:
        rec = owners.title(media_type, media_id)
        result = await undo.delete_with_files(
            media_type, media_id, user, rec,
            on_failed=None if rec is None else lambda: owners.restore_title(media_type, media_id, rec))
        if media_type == "tv":
            _news_cache = None
        owners.drop_title(media_type, media_id)  # every answer here means it is (going) away
        listings.invalidate(media_type)
        _mark_removed(media_type, media_id)
        return result
    return await undo.undo_add(media_type, media_id, undo_token, user, on_undone=_undone)


def _undone(u) -> None:
    """After the call that undid an add (undo.py): drop the owner record only
    if it is the one that add wrote — same owner, same arr entry, not revived
    since. A token used after the title was deleted and added again (by
    anyone) names an arr id that is gone: that add's record stays."""
    rec = owners.title(u.kind, u.media_id)
    mine = (rec is not None and not u.revived and rec.get("owner") == u.user_id
            and rec.get("arr_id") == u.arr_id)
    if mine:
        owners.drop_title(u.kind, u.media_id)
    listings.invalidate(u.kind)
    if mine or u.result["status"] != "already_removed":
        _mark_removed(u.kind, u.media_id)


# New-season feed (VibeReel's notification bell). Sonarr's season statistics
# change on the scale of hours (a metadata refresh, an air date passing), and
# clients poll every few minutes, so one answer serves everyone for a while.
NEWS_TTL = 600
_news_cache: tuple[float, list] | None = None


@app.get("/api/news", response_model=NewsResponse)
async def season_news():
    global _news_cache
    if _news_cache and time.monotonic() - _news_cache[0] < NEWS_TTL:
        return {"items": _news_cache[1]}
    items = await require_arr("tv").season_news()
    # aired first, newest first; then upcoming, soonest first, undated last
    aired = sorted((i for i in items if i["kind"] == "aired"),
                   key=lambda i: i["last_aired"] or "", reverse=True)
    upcoming = sorted((i for i in items if i["kind"] == "upcoming"),
                      key=lambda i: (i["premiere"] is None, i["premiere"] or ""))
    _news_cache = (time.monotonic(), aired + upcoming)
    return {"items": _news_cache[1]}


# Get a season of a series already in the library: anyone may (it isn't a new
# title, no quota); the first requester is recorded and may cancel the
# season's grabs made since (not one in flight before), and only the one who
# asked (or an admin) may undo a Get.
@app.post("/api/news/search", response_model=SeasonSearchResult, status_code=202)
async def search_season(req: SeasonSearchRequest, user: User = Depends(current_user)):
    global _news_cache
    result = await require_arr("tv").search_season(req.id, req.season)
    _news_cache = None  # the season is monitored now
    info = result.pop("_undo")
    recorded = owners.record_season(req.id, req.season, user, info["at"])  # unless someone asked first
    result["undo"] = undo.remember_get(req.id, req.season, result["title"], info, user, recorded)
    action_log.info("season search: %s season %d (%s) by %s", req.id, req.season, result["title"],
                    user.name or user.id)
    return result


@app.delete("/api/news/search/{token}", response_model=SeasonSearchUndoResult)
async def undo_search_season(token: str = Path(min_length=8, max_length=64), user: User = Depends(current_user)):
    global _news_cache
    require_arr("tv")
    result = await undo.undo_get(token, user, on_undone=_get_undone)
    _news_cache = None  # monitoring changed back
    return result


def _get_undone(u) -> None:
    """After the call that undid a Get: drop the season record only if this
    Get wrote it and it is still that one (not expired and taken by another
    request since)."""
    if u.recorded:
        owners.drop_season(u.media_id, u.season, owner=u.user_id, at=u.at)


_ETA_INF = 8640000  # qBit's "unknown/infinite" sentinel
_DL_STATES = {"downloading", "forcedDL", "metaDL", "stalledDL", "checkingDL", "allocating"}
_QUEUE_STATES = {"queuedDL"}
# Stopped by hand (or by the arr) in qBittorrent: "paused".
# qBittorrent 5 calls pausedDL stoppedDL. Not made sequential — the toggles wait
# until it runs again (a stream force-starts it). A finished torrent's
# pausedUP/stoppedUP, like the other states, keeps the arr's word.
_PAUSED_STATES = {"pausedDL", "stoppedDL"}
_STATUS_RANK = {
    "downloading": 0,
    "importing": 1,
    "queued": 2,
    "warning": 3,
    "paused": 4,
    "completed": 5,
}


# hash -> when its sequential/first-last toggles were sent. The API only has
# toggles, and a poll acts on the flags *it* read: two overlapping polls (TV +
# phone, or a slow torrents/info answer) would both toggle and turn the flags
# off again. A hash toggled within SEQ_RECENT s — several poll periods, so any
# read from before the toggle has been processed by then — is left alone.
SEQ_RECENT = 15.0
_seq_recent: dict[str, float] = {}


async def _sequentialize(qb: qbit.QBittorrentClient, rows: list[dict]) -> None:
    try:
        await qb.make_sequential(rows)
        log.info("forced sequential download on %d torrent(s)", len(rows))
    except Exception as e:  # best-effort: the next activity poll retries
        for r in rows:
            _seq_recent.pop(r["hash"], None)
        log.warning("could not force sequential download: %s", e)


def _fmt_eta(seconds: int) -> str:
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:d}:{s:02d}"


async def _activity_items() -> list[dict]:
    """Every arr queue row, live-patched from qBittorrent (and the arr
    torrents made sequential) — /api/activity's items, /api/me's statuses."""
    clients = list(arr_clients.values())
    if not clients:
        return []

    # Sonarr/Radarr give the title↔episode mapping and import state; qBittorrent
    # gives LIVE progress/speed (the arr queues only refresh ~once a minute).
    qb = downloader
    tasks = [c.queue() for c in clients] + ([qb.info_map()] if qb else [])
    results = await asyncio.gather(*tasks, return_exceptions=True)

    qbit_map = {}
    if qb:
        m = results[-1]
        if isinstance(m, Exception):
            log.warning("activity qbit fetch failed: %s", m)
        else:
            qbit_map = m
        results = results[:-1]

    items = []
    for r in results:
        if isinstance(r, Exception):
            log.warning("activity queue fetch failed: %s", r)
            continue
        items.extend(r)

    seq_rows = {}
    for it in items:
        h = it.get("download_id") or ""
        row = qbit_map.get(h)
        # The hash doubles as the client's streaming handle
        # (/api/downloads/{id}/stream), so it stays in the response now.
        it["download_id"] = h.lower() or None
        if row and it["status"] not in ("importing", "completed"):
            it["progress"] = round(float(row.get("progress") or 0), 4)
            it["download_speed"] = int(row.get("dlspeed") or 0)
            eta = int(row.get("eta") or 0)
            it["timeleft"] = _fmt_eta(eta) if 0 < eta < _ETA_INF else None
            state = row.get("state", "")
            if state in _DL_STATES:
                it["status"] = "downloading"
            elif state in _QUEUE_STATES:
                it["status"] = "queued"
            elif state in _PAUSED_STATES:
                it["status"] = "paused"
            # Arr-grabbed torrents must download sequentially or the partial
            # file is unplayable (rarest-first leaves holes). The API only has
            # toggles, so make_sequential() filters by the current flags.
            if (state in _DL_STATES or state in _QUEUE_STATES) and not (
                row.get("seq_dl") and row.get("f_l_piece_prio")
            ):
                seq_rows[row["hash"]] = row

    if qb:
        now = time.monotonic()
        for h in [h for h, t in _seq_recent.items() if now - t > SEQ_RECENT]:
            del _seq_recent[h]
        rows = [r for h, r in seq_rows.items() if h not in _seq_recent]
        if rows:
            for r in rows:
                _seq_recent[r["hash"]] = now
            asyncio.create_task(_sequentialize(qb, rows))

    # Active downloads first, fastest at the top; then importing, queued, etc.
    items.sort(
        key=lambda i: (
            _STATUS_RANK.get(i["status"], 9),
            -(i.get("download_speed") or 0),
            -(i.get("progress") or 0),
        )
    )
    return items


@app.get("/api/activity", response_model=ActivityResponse)
async def activity(user: User = Depends(current_user)):
    items = await _activity_items()
    for it in items:  # whose row it is, and whether the caller may cancel it
        it["mine"] = owners.is_mine(user, it["type"], it.get("media_id"), it.get("season"),
                                    _when(it.pop("queued_at", None)))
        it["can_cancel"] = user.admin or it["mine"]
    return {"items": items}


def _title_status(rows: list[dict]) -> tuple[str | None, float | None]:
    """The most active status of a title's rows in flight, and their progress
    weighted by size over distinct downloads (a season pack is one torrent
    listed once per episode) — the arithmetic of the apps' activity groups."""
    rows = [r for r in rows if r["status"] != "completed"]
    if not rows:
        return None, None
    status = min((r["status"] for r in rows), key=lambda s: _STATUS_RANK.get(s, 9))
    grabs = {r.get("download_id") or "i:" + r["id"]: r for r in rows}
    wsum = sum(r["size_bytes"] for r in grabs.values() if r.get("size_bytes"))
    if wsum:
        p = sum((r.get("progress") or 0) * r["size_bytes"] for r in grabs.values() if r.get("size_bytes")) / wsum
    else:
        p = sum(r.get("progress") or 0 for r in grabs.values()) / len(grabs)
    return status, round(p, 4)


_ME_ORDER = {**_STATUS_RANK, "waiting": 10, "in_library": 11}


@app.get("/api/me", response_model=MeResponse)
async def who_am_i(user: User = Depends(current_user)):
    """The caller, their quota use and the titles they own (My library)."""
    kinds = [k for k in MEDIA_TYPES if k in arr_clients]
    rows, *lists = await asyncio.gather(_activity_items(), *(quota.listing(k) for k in kinds))
    out_quota = {k: {"used": 0, "limit": None if user.admin else quota.limits[k]} for k in MEDIA_TYPES}
    titles = []
    for kind, listing in zip(kinds, lists):
        client = arr_clients[kind]
        mine = [(mid, rec) for _, mid, rec in owners.owned(user.id, kind) if exists(rec, mid, listing)]
        out_quota[kind]["used"] = len(mine)
        for mid, rec in mine:
            obj = listing.by_id.get(mid)
            status, progress = _title_status([r for r in rows if r["type"] == kind and r.get("media_id") == mid])
            has_files = bool(obj) and client.has_files(obj)
            titles.append({
                "type": kind, "id": mid,
                "title": (obj or {}).get("title") or rec.get("title") or mid,
                "year": ((obj or {}).get("year") or None) if obj else rec.get("year"),
                "poster": _poster(obj) if obj else None,
                "added_at": rec.get("at") or "",
                "status": status or ("in_library" if has_files else "waiting"),
                "progress": progress,
                "has_files": has_files,
            })
    titles.sort(key=lambda t: t["added_at"], reverse=True)
    titles.sort(key=lambda t: _ME_ORDER.get(t["status"], 9))
    return {"user": {"id": user.id, "name": user.name}, "admin": user.admin, "quota": out_quota,
            "titles": titles}


# Cancel a download: the title's grabs in flight (or one season's / episode's —
# a season pack goes as a whole), removed from the arr queue and qBittorrent
# with their partial data, and unmonitored so the arr doesn't grab them again.
# A normal user only cancels grabs of their own titles or of seasons they asked
# for (403 not_owner otherwise, before anything is touched); admins anything.
@app.delete("/api/activity/{media_type}/{media_id}", response_model=CancelResult)
async def cancel_activity(
    media_type: str = Path(pattern="^(tv|movie)$"),
    media_id: str = Path(pattern=r"^\d{1,10}$"),
    season: int | None = Query(None, ge=0, le=500),
    episode: int | None = Query(None, ge=0, le=5000),
    blocklist: bool = False,
    user: User = Depends(current_user),
):
    client = require_arr(media_type)
    if episode is not None and season is None:
        return JSONResponse(
            status_code=400,
            content={"error": "bad_request", "detail": "episode needs season"},
        )
    if media_type == "movie" and (season is not None or episode is not None):
        return JSONResponse(
            status_code=400,
            content={"error": "bad_request", "detail": "a movie has no seasons"},
        )

    def may(row: dict) -> bool:  # the caller's title, or a grab their season request made
        ep_season = (row.get("episode") or {}).get("seasonNumber", row.get("seasonNumber"))
        return owners.may(user, media_type, client.media_id_of(row), ep_season, _when(row.get("added")))

    return await undo.cancel(media_type, media_id, season, episode, blocklist, may=may)


@app.get("/health")
async def health():
    return {"ok": True}
