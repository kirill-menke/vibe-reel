"""Real answers of every client-used route, produced by the app against the
sims — one small scenario ("scene") per (route, status) answer. Shared by
test_contract.py (fields the clients read) and test_openapi_responses.py
(the answers vs the declared schemas).

    sc = SCENES["activity"]          # .method .route .status .slow
    resp = await sc.run(world)       # httpx.Response, already read

A scene builds its own upstream state with the sims and opens the app with
`world.make_api(...)`; `World` is assembled by the `world` fixture in the
test modules (tests/conftest.py fixtures + a few extras). Scenes are
deliberately rich: every nullable field the clients read gets a value where
the upstream data allows, and every list a client walks is non-empty, so a
field check against the answer means something.
"""

from __future__ import annotations

import asyncio
import datetime as dt
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import httpx

from tests.support.arr import episode_obj, movie_obj, season_obj, series_obj
from tests.support.imdb import ImdbSim, ImdbTitle
from tests.support.qbit import SimFile, SimTorrent, make_hash


@dataclass
class World:
    make_api: Any
    upstream: Any
    sonarr: Any
    radarr: Any
    qbit: Any
    reel_env: Any
    requests_mock: Any
    monkeypatch: Any
    tmp_path: Any
    getfixture: Callable[[str], Any]  # request.getfixturevalue (session media etc.)
    app_module: Any = None
    extra: dict = field(default_factory=dict)


@dataclass
class Scene:
    name: str
    method: str
    route: str  # the route template as app.openapi() lists it
    status: int
    fn: Callable[[World], Awaitable[httpx.Response]]
    slow: bool = False

    async def run(self, w: World) -> httpx.Response:
        r = await self.fn(w)
        assert r.status_code == self.status, f"scene {self.name}: {r.status_code} {r.text[:300]}"
        assert r.request.method == self.method, (self.name, r.request.method)
        return r


SCENES: dict[str, Scene] = {}


def scene(name: str, method: str, route: str, status: int, *, slow: bool = False):
    def deco(fn):
        assert name not in SCENES, name
        SCENES[name] = Scene(name, method, route, status, fn, slow)
        return fn

    return deco


def H(seed: str) -> str:
    """Sonarr/Radarr report downloadId uppercase."""
    return make_hash(seed).upper()


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def _iso_day(d: dt.date) -> str:
    return d.isoformat() + "T00:00:00Z"


async def _cancel_undo_watchers(api) -> None:
    for t in list(api.app_module.undo._tasks):
        t.cancel()
    await asyncio.sleep(0)


# ---------------------------------------------------------------- lookup / trending / charts


@scene("lookup", "GET", "/api/lookup", 200)
async def _lookup(w):
    w.radarr.add_catalog(movie_obj(194, "Amelie", year=2001, original_title="Le Fabuleux Destin",
                                   overview="Paris.", imdb_votes=800_000))
    w.radarr.add_movie(movie_obj(195, "Amelie Again", year=2003, overview="Paris again."))
    async with w.make_api() as api:
        return await api.get("/api/lookup", params={"q": "amelie", "type": "movie"})


@scene("trending", "GET", "/api/trending", 200)
async def _trending(w):
    imdb = ImdbSim(w.upstream)
    today = dt.date.today()
    released = today - dt.timedelta(days=60)
    tid = "tt9100001"
    imdb.add(ImdbTitle(tid, "Movie 1", "movie", rating=8.1, votes=123_456, rank=7,
                       release=released, releases=[released]))
    w.radarr.add_catalog(movie_obj(5001, "Movie 1", imdb=tid,
                                   digital_release=_iso_day(today + dt.timedelta(days=30))))
    async with w.make_api() as api:
        return await api.get("/api/trending", params={"type": "movie"})


def _chart_titles(w, imdb):
    films, shows = [], []
    for n in range(1, 4):
        tid = f"tt{9_300_000 + n}"
        imdb.add(ImdbTitle(tid, f"Film {n}", "movie", rating=9 - n / 10, votes=100_000, genres=["Crime"]))
        w.radarr.add_catalog(movie_obj(6000 + n, f"Film {n}", imdb=tid))
        films.append(tid)
    for n in range(1, 3):
        tid = f"tt{9_400_000 + n}"
        imdb.add(ImdbTitle(tid, f"Series {n}", "tvSeries", rating=9 - n / 10, votes=100_000, genres=["Crime"]))
        w.sonarr.add_catalog(series_obj(8000 + n, f"Series {n}", imdb=tid))
        shows.append(tid)
    imdb.set_chart("TOP_RATED_MOVIES", films)
    imdb.set_chart("TOP_RATED_TV_SHOWS", shows)


@scene("charts", "GET", "/api/charts", 200)
async def _charts(w):
    imdb = ImdbSim(w.upstream)
    _chart_titles(w, imdb)
    async with w.make_api() as api:
        return await api.get("/api/charts")


@scene("chart", "GET", "/api/charts/{key}", 200)
async def _chart(w):
    imdb = ImdbSim(w.upstream)
    _chart_titles(w, imdb)
    async with w.make_api() as api:
        return await api.get("/api/charts/genre-Crime")


# ---------------------------------------------------------------- library add / undo


def _show_catalog(sonarr, tvdb=81189, title="Breaking Bad"):
    sonarr.add_catalog(series_obj(tvdb, title, seasons=[season_obj(1)]),
                       [episode_obj(1, i) for i in range(1, 4)])


@scene("library-add", "POST", "/api/library", 202)
async def _library_add(w):
    _show_catalog(w.sonarr)
    async with w.make_api() as api:
        r = await api.post("/api/library", json={"id": "81189", "type": "tv"})
        await _cancel_undo_watchers(api)
        return r


@scene("library-add-exists", "POST", "/api/library", 409)
async def _library_add_exists(w):
    w.radarr.add_movie(movie_obj(603, "The Matrix"))
    async with w.make_api() as api:
        return await api.post("/api/library", json={"id": "603", "type": "movie"})


@scene("library-add-quota", "POST", "/api/library", 409)
async def _library_add_quota(w):
    from tests.conftest import NICOLE_TOKEN, auth_for

    w.radarr.add_catalog(movie_obj(603, "The Matrix"))
    async with w.make_api(REEL_API_QUOTA_MOVIES="0", auth=auth_for(NICOLE_TOKEN)) as api:
        return await api.post("/api/library", json={"id": "603", "type": "movie"})


@scene("library-undo", "DELETE", "/api/library/{media_type}/{media_id}", 200)
async def _library_undo(w):
    _show_catalog(w.sonarr)
    async with w.make_api() as api:
        token = (await api.post("/api/library", json={"id": "81189", "type": "tv"})).json()["undo"]
        r = await api.delete("/api/library/tv/81189", params={"undo": token})
        await _cancel_undo_watchers(api)
        return r


@scene("library-undo-has-files", "DELETE", "/api/library/{media_type}/{media_id}", 409)
async def _library_undo_has_files(w):
    w.radarr.add_catalog(movie_obj(603, "The Matrix"))
    async with w.make_api() as api:
        token = (await api.post("/api/library", json={"id": "603", "type": "movie"})).json()["undo"]
        w.radarr.title(603)["hasFile"] = True
        r = await api.delete("/api/library/movie/603", params={"undo": token})
        await _cancel_undo_watchers(api)
        return r


@scene("library-undo-expired", "DELETE", "/api/library/{media_type}/{media_id}", 410)
async def _library_undo_expired(w):
    async with w.make_api() as api:
        return await api.delete("/api/library/tv/81189", params={"undo": "no-such-token"})


def _nicole():
    from tests.conftest import NICOLE_TOKEN, auth_for

    return auth_for(NICOLE_TOKEN)


@scene("library-delete", "DELETE", "/api/library/{media_type}/{media_id}", 200)
async def _library_delete(w):
    """nicole deletes her movie, with a grab in flight."""
    w.radarr.add_catalog(movie_obj(603, "The Matrix"))
    async with w.make_api(auth=_nicole()) as api:
        await api.post("/api/library", json={"id": "603", "type": "movie"})
        w.radarr.finish_commands()
        w.radarr.grab(w.radarr.title(603)["id"], H("del"))
        return await api.delete("/api/library/movie/603", params={"delete_files": "true"})


@scene("library-delete-deleting", "DELETE", "/api/library/{media_type}/{media_id}", 200)
async def _library_delete_deleting(w):
    w.sonarr.add_catalog(series_obj(81189, "Breaking Bad", seasons=[season_obj(1)]), [episode_obj(1, 1)])
    async with w.make_api(auth=_nicole()) as api:
        await api.post("/api/library", json={"id": "81189", "type": "tv"})
        search = next(c for c in w.sonarr.commands.values() if c["name"] == "SeriesSearch")
        w.sonarr.set_command_status(search["id"], "started")
        r = await api.delete("/api/library/tv/81189", params={"delete_files": "true"})
        await _cancel_undo_watchers(api)
        return r


@scene("library-delete-gone", "DELETE", "/api/library/{media_type}/{media_id}", 200)
async def _library_delete_gone(w):
    async with w.make_api() as api:
        return await api.delete("/api/library/movie/603", params={"delete_files": "true"})


@scene("library-delete-not-owner", "DELETE", "/api/library/{media_type}/{media_id}", 403)
async def _library_delete_not_owner(w):
    w.radarr.add_movie(movie_obj(603, "The Matrix"))  # legacy: the admins'
    async with w.make_api(auth=_nicole()) as api:
        return await api.delete("/api/library/movie/603", params={"delete_files": "true"})


@scene("library-delete-bad-request", "DELETE", "/api/library/{media_type}/{media_id}", 400)
async def _library_delete_bad_request(w):
    async with w.make_api() as api:
        return await api.delete("/api/library/movie/603")


@scene("library-add-being-deleted", "POST", "/api/library", 409)
async def _library_add_being_deleted(w):
    w.radarr.add_catalog(movie_obj(603, "The Matrix"))
    async with w.make_api(auth=_nicole()) as api:
        await api.post("/api/library", json={"id": "603", "type": "movie"})
        search = next(c for c in w.radarr.commands.values() if c["name"] == "MoviesSearch")
        w.radarr.set_command_status(search["id"], "started")
        await api.delete("/api/library/movie/603", params={"delete_files": "true"})
        r = await api.post("/api/library", json={"id": "603", "type": "movie"})
        await _cancel_undo_watchers(api)
        return r


# ---------------------------------------------------------------- activity / cancel


def _grabbing_show(w):
    s = w.sonarr.add_series(series_obj(81189, "Breaking Bad", year=2008, seasons=[season_obj(1)]),
                            [episode_obj(1, i, title=f"Ep {i}") for i in range(1, 3)])
    eps = [e["id"] for e in w.sonarr.episodes_of(s["id"])]
    w.sonarr.grab(s["id"], H("live"), episode_ids=eps[:1], size=4 * 65536, sizeleft=2 * 65536,
                  status_messages=[{"title": "Some.Release", "messages": ["Not enough seeders"]}])
    w.qbit.add_torrent(SimTorrent(hash=make_hash("live"), name="live", category="tv-sonarr",
                                  state="downloading", files=[SimFile("live.mkv", 4 * 65536)],
                                  pieces=[2, 2, 0, 0], dlspeed=7_400_000, eta=3725,
                                  seq_dl=True, f_l_piece_prio=True))
    return s, eps


@scene("activity", "GET", "/api/activity", 200)
async def _activity(w):
    _grabbing_show(w)
    async with w.make_api() as api:
        return await api.get("/api/activity")


@scene("cancel", "DELETE", "/api/activity/{media_type}/{media_id}", 200)
async def _cancel(w):
    _grabbing_show(w)
    async with w.make_api() as api:
        return await api.delete("/api/activity/tv/81189")


@scene("cancel-not-owner", "DELETE", "/api/activity/{media_type}/{media_id}", 403)
async def _cancel_not_owner(w):
    _grabbing_show(w)  # legacy: the admins'
    async with w.make_api(auth=_nicole()) as api:
        return await api.delete("/api/activity/tv/81189")


@scene("activity-normal-user", "GET", "/api/activity", 200)
async def _activity_normal_user(w):
    """nicole: a row of a season she asked for (mine), others not."""
    _grabbing_show(w)
    async with w.make_api(auth=_nicole()) as api:
        api.app_module.owners.record_season("81189", 1, _user("nicole"), _now())
        return await api.get("/api/activity")


def _user(name):
    from reel_api.security import User
    from tests.conftest import NICOLE_USER, ZHENYA_USER

    return User({"nicole": NICOLE_USER, "Zhenya": ZHENYA_USER}[name], name, False)


@scene("cancel-not-in-queue", "DELETE", "/api/activity/{media_type}/{media_id}", 404)
async def _cancel_none(w):
    w.sonarr.add_series(series_obj(81189, "Breaking Bad", seasons=[season_obj(1)]), [episode_obj(1, 1)])
    async with w.make_api() as api:
        return await api.delete("/api/activity/tv/81189")


# ---------------------------------------------------------------- me


@scene("me", "GET", "/api/me", 200)
async def _me(w):
    """nicole: a movie downloading, a show in the library (rich: every
    nullable field set)."""
    from tests.conftest import NICOLE_TOKEN, auth_for

    w.radarr.add_catalog(movie_obj(603, "The Matrix", year=1999))
    w.sonarr.add_catalog(series_obj(81189, "Breaking Bad", year=2008, seasons=[season_obj(1)]),
                         [episode_obj(1, 1, has_file=True)])
    async with w.make_api(auth=auth_for(NICOLE_TOKEN)) as api:
        for kind, mid in (("tv", "81189"), ("movie", "603")):
            assert (await api.post("/api/library", json={"id": mid, "type": kind})).status_code == 202
        await _cancel_undo_watchers(api)
        w.radarr.grab(w.radarr.title(603)["id"], H("me"), size=4 * 65536, sizeleft=2 * 65536)
        w.qbit.add_torrent(SimTorrent(hash=make_hash("me"), name="me", category="radarr", state="downloading",
                                      files=[SimFile("me.mkv", 4 * 65536)], pieces=[2, 2, 0, 0],
                                      seq_dl=True, f_l_piece_prio=True))
        return await api.get("/api/me")


@scene("me-admin", "GET", "/api/me", 200)
async def _me_admin(w):
    """kirill (admin): no limit, an empty list."""
    async with w.make_api() as api:
        return await api.get("/api/me")


# ---------------------------------------------------------------- news


def _news_show(w):
    """Season 1 on disk; season 2 aired 10 and 3 days ago, one more next week;
    season 3 announced (dated)."""
    now = _now()
    ago, ahead = (lambda d: now - dt.timedelta(days=d)), (lambda d: now + dt.timedelta(days=d))
    eps = [episode_obj(1, 1, air=ago(800), has_file=True),
           episode_obj(2, 1, air=ago(10), monitored=False), episode_obj(2, 2, air=ago(3)),
           episode_obj(2, 3, air=ahead(4)), episode_obj(3, 1, air=ahead(200))]
    return w.sonarr.add_series(series_obj(81189, "Breaking Bad", year=2008, monitored=False,
                                          seasons=[season_obj(1), season_obj(2, monitored=False),
                                                   season_obj(3)]), eps)


@scene("news", "GET", "/api/news", 200)
async def _news(w):
    _news_show(w)
    async with w.make_api() as api:
        return await api.get("/api/news")


@scene("news-search", "POST", "/api/news/search", 202)
async def _news_search(w):
    _news_show(w)
    async with w.make_api() as api:
        r = await api.post("/api/news/search", json={"id": "81189", "season": 2})
        await _cancel_undo_watchers(api)
        return r


@scene("news-search-not-aired", "POST", "/api/news/search", 409)
async def _news_search_not_aired(w):
    _news_show(w)
    async with w.make_api() as api:
        return await api.post("/api/news/search", json={"id": "81189", "season": 3})


@scene("news-undo", "DELETE", "/api/news/search/{token}", 200)
async def _news_undo(w):
    _news_show(w)
    async with w.make_api() as api:
        token = (await api.post("/api/news/search", json={"id": "81189", "season": 2})).json()["undo"]
        r = await api.delete(f"/api/news/search/{token}")
        await _cancel_undo_watchers(api)
        return r


@scene("news-undo-not-owner", "DELETE", "/api/news/search/{token}", 403)
async def _news_undo_not_owner(w):
    from tests.conftest import ZHENYA_TOKEN, auth_for

    _news_show(w)
    async with w.make_api(auth=_nicole()) as api:
        token = (await api.post("/api/news/search", json={"id": "81189", "season": 2})).json()["undo"]
        r = await api.delete(f"/api/news/search/{token}", headers={"Authorization": auth_for(ZHENYA_TOKEN)})
        await _cancel_undo_watchers(api)
        return r


@scene("news-undo-expired", "DELETE", "/api/news/search/{token}", 410)
async def _news_undo_expired(w):
    async with w.make_api() as api:
        return await api.delete("/api/news/search/no-such-token")


# ---------------------------------------------------------------- metadata / segments / collection


@scene("metadata-tv", "GET", "/api/metadata/{media_type}/{media_id}", 200)
async def _metadata_tv(w):
    day = dt.datetime(2016, 7, 15, tzinfo=dt.timezone.utc)
    w.sonarr.add_series(
        series_obj(305288, "Stranger Things", year=2016, overview="Hawkins.", runtime=51,
                   genres=["Drama", "Mystery"], rating=8.66, certification="TV-14", status="ended",
                   seasons=[season_obj(1)]),
        [episode_obj(1, 1, title="The Vanishing of Will Byers", air=day, has_file=True),
         episode_obj(1, 2, title="The Weirdo on Maple Street", air=day)])
    async with w.make_api() as api:
        return await api.get("/api/metadata/tv/305288")


@scene("metadata-movie", "GET", "/api/metadata/{media_type}/{media_id}", 200)
async def _metadata_movie(w):
    w.radarr.add_catalog(movie_obj(438631, "Dune", year=2021, runtime=155, genres=["Science Fiction"],
                                   imdb_rating=8.04, certification="PG-13", trailer="n9xhJrPXop4",
                                   collection={"title": "Dune Collection", "tmdbId": 726871}))
    async with w.make_api() as api:
        return await api.get("/api/metadata/movie/438631")


@scene("segments", "GET", "/api/segments/{imdb_id}/{season}/{episode}", 200)
async def _segments(w):
    from reel_api import introdb

    def seg(a, b, n):
        return {"start_ms": a, "end_ms": b, "submission_count": n}

    w.upstream.get(introdb.API).respond(200, json={
        "imdb_id": "tt1234567", "season": 4, "episode": 3,
        "intro": seg(36_500, 98_250, 12), "recap": seg(1000, 35_000, 4), "outro": seg(3_000_000, 3_100_000, 2)})
    async with w.make_api() as api:
        return await api.get("/api/segments/tt1234567/4/3")


@scene("collection", "GET", "/api/collection/{cid}", 200)
async def _collection(w):
    def part(tmdb, title, year, premier, rating):
        return {"TmdbId": tmdb, "ImdbId": f"tt{tmdb:07d}", "Title": title, "OriginalTitle": title,
                "Year": year, "Overview": f"{title} overview.",
                "Images": [{"CoverType": c, "Url": f"https://image.tmdb.test/{c.lower()}/{tmdb}.jpg"}
                           for c in ("Poster", "Fanart")],
                "MovieRatings": {"Imdb": {"Count": 900_000, "Value": rating, "Type": "User"}},
                "Premier": premier, "InCinema": None, "DigitalRelease": None, "PhysicalRelease": None,
                "Runtime": 117, "Genres": ["Horror"]}

    w.upstream.get(url__startswith="https://api.radarr.video/v1/movie/collection/").respond(200, json={
        "TmdbId": 8091, "Name": "Alien Collection", "Overview": "Xenomorphs.",
        "Images": [{"CoverType": c, "Url": f"https://image.tmdb.test/{c.lower()}/8091.jpg"}
                   for c in ("Poster", "Fanart")],
        "Parts": [part(348, "Alien", 1979, "1979-06-22T00:00:00Z", 8.5),
                  part(679, "Aliens", 1986, "1986-07-18T00:00:00Z", 8.4)]})
    w.radarr.add_movie(movie_obj(348, "Alien", year=1979))
    async with w.make_api() as api:
        return await api.get("/api/collection/8091")


# ---------------------------------------------------------------- watch while downloading


PIECE = 64 * 1024


def _growing(w, data: bytes, seed: str):
    from tests.support.growing import GrowingFile

    g = GrowingFile(w.tmp_path / "dl" / f"{seed}.mkv", data, piece_size=PIECE)
    h = make_hash(seed)
    w.qbit.add_growing(h, g)
    return h, g


@scene("probe", "GET", "/api/downloads/{gid}/probe", 200, slow=True)
async def _probe(w):
    data = w.getfixture("sample_mkv").read_bytes()
    h, g = _growing(w, data, "probe")
    g.complete()
    async with w.make_api() as api:
        return await api.get(f"/api/downloads/{h}/probe")


@scene("probe-not-ready", "GET", "/api/downloads/{gid}/probe", 409)
async def _probe_not_ready(w):
    h, g = _growing(w, bytes(8 * PIECE), "probe-early")
    async with w.make_api() as api:
        return await api.get(f"/api/downloads/{h}/probe")


async def _until(cond, timeout: float = 30.0, what: str = "condition"):
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not cond():
        if loop.time() > end:
            raise AssertionError(f"timed out waiting for {what}")
        await asyncio.sleep(0.01)


async def _hls_job(w, api):
    """POST the remux of a whole sample download, wait until it is done."""
    from reel_api import livehls

    w.monkeypatch.setattr(livehls, "PIECE_POLL", 0.01)
    data = w.getfixture("sample_mkv").read_bytes()
    h, g = _growing(w, data, "hls")
    g.complete()
    r = await api.post(f"/api/downloads/{h}/hls", params={"audio": 1})
    job = livehls.live.jobs[f"{h}:1"]
    await _until(lambda: job.state in ("done", "error"), what="the remux to finish")
    assert job.error is None, job.error
    return h, r


@scene("hls-start", "POST", "/api/downloads/{gid}/hls", 200, slow=True)
async def _hls_start(w):
    async with w.make_api() as api:
        h, r = await _hls_job(w, api)
        return await api.post(f"/api/downloads/{h}/hls", params={"audio": 1})  # joins the finished job


@scene("hls-status", "GET", "/api/downloads/{gid}/hls", 200, slow=True)
async def _hls_status(w):
    async with w.make_api() as api:
        h, _ = await _hls_job(w, api)
        return await api.get(f"/api/downloads/{h}/hls", params={"audio": 1})


# ---------------------------------------------------------------- trailers (fake yt-dlp, real ffmpeg)


TRAILER = "fakeTrailr9"


async def _trailer_ready(w, api):
    from tests.support.fake_ytdlp import FakeYtDlp, audio_fmt, video_fmt
    from tests.test_trailers_pipeline import _encode

    d = w.tmp_path / "yt-media"
    d.mkdir()
    # itag 160 as YouTube offers it: 256x144 H.264 Main@1.2 (avc1.4d400c)
    video = _encode(d / "v.mp4", ["-f", "lavfi", "-i", "testsrc2=size=256x144:rate=24:duration=4",
                                  "-c:v", "libx264", "-preset", "superfast", "-profile:v", "main",
                                  "-level", "1.2", "-crf", "40", "-pix_fmt", "yuv420p", "-g", "24", "-an"])
    audio = _encode(d / "a.m4a", ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=4",
                                  "-c:a", "aac", "-b:a", "48k", "-ac", "2", "-vn"])
    yt = FakeYtDlp(w.tmp_path / "fake-ytdlp", w.monkeypatch)
    yt.add(TRAILER, [video_fmt("160", video, width=256, height=144, vcodec="avc1.4d400c"),
                     audio_fmt("140", audio)], title="A Film | Official Trailer")
    r = await api.post(f"/api/trailers/{TRAILER}")
    job = api.app_module.trailers.get(TRAILER)
    await _until(lambda: job.task.done(), what="the trailer to finish")
    await _until(lambda: yt.alive() == [], 10, "the fake yt-dlp processes to exit")
    assert job.state == "ready", job.error
    return r


@scene("trailer-start", "POST", "/api/trailers/{key}", 200, slow=True)
async def _trailer_start(w):
    async with w.make_api() as api:
        await _trailer_ready(w, api)
        return await api.post(f"/api/trailers/{TRAILER}")  # idempotent: the finished job


@scene("trailer-status", "GET", "/api/trailers/{key}", 200, slow=True)
async def _trailer_status(w):
    async with w.make_api() as api:
        await _trailer_ready(w, api)
        return await api.get(f"/api/trailers/{TRAILER}")


# ---------------------------------------------------------------- push


PUSH_ENDPOINT = "https://push.test/sub/1"


def _push_env(w) -> dict:
    from reel_api import push

    if "vapid" not in w.extra:
        w.extra["vapid"] = push.generate_key()
    return {"VAPID_PRIVATE_KEY": w.extra["vapid"][0], "VAPID_SUBJECT": "mailto:test@example.com"}


def _browser_subscription() -> dict:
    import base64
    import os

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    def b64u(b: bytes) -> str:
        return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

    pub = ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return {"endpoint": PUSH_ENDPOINT, "keys": {"p256dh": b64u(pub), "auth": b64u(os.urandom(16))}}


def _jellyfin_me(w):
    from tests.conftest import JELLYFIN

    w.upstream.get(f"{JELLYFIN}/Users/Me").respond(
        200, json={"Id": "0123456789abcdef0123456789abcdef", "Name": "Kirill"})


async def _subscribe(api):
    r = await api.post("/api/push/subscribe", json={
        "subscription": _browser_subscription(), "token": "tok", "device_id": "dev-1",
        "ready": True, "seasons": True})
    return r


@scene("push-config", "GET", "/api/push/config", 200)
async def _push_config(w):
    async with w.make_api(**_push_env(w)) as api:
        return await api.get("/api/push/config")


@scene("push-subscribe", "POST", "/api/push/subscribe", 200)
async def _push_subscribe(w):
    _jellyfin_me(w)
    async with w.make_api(**_push_env(w)) as api:
        return await _subscribe(api)


@scene("push-status", "POST", "/api/push/status", 200)
async def _push_status(w):
    _jellyfin_me(w)
    async with w.make_api(**_push_env(w)) as api:
        await _subscribe(api)
        return await api.post("/api/push/status", json={"endpoint": PUSH_ENDPOINT})


@scene("push-unsubscribe", "POST", "/api/push/unsubscribe", 200)
async def _push_unsubscribe(w):
    _jellyfin_me(w)
    async with w.make_api(**_push_env(w)) as api:
        await _subscribe(api)
        return await api.post("/api/push/unsubscribe", json={"endpoint": PUSH_ENDPOINT})


@scene("push-test", "POST", "/api/push/test", 200)
async def _push_test(w):
    _jellyfin_me(w)
    w.requests_mock.post(PUSH_ENDPOINT, status=201)
    async with w.make_api(**_push_env(w)) as api:
        await _subscribe(api)
        return await api.post("/api/push/test", json={"endpoint": PUSH_ENDPOINT})


@scene("push-test-unknown", "POST", "/api/push/test", 404)
async def _push_test_unknown(w):
    async with w.make_api(**_push_env(w)) as api:
        return await api.post("/api/push/test", json={"endpoint": PUSH_ENDPOINT})


@scene("not-available", "GET", "/api/lookup", 503)
async def _not_available(w):
    async with w.make_api(RADARR_API_KEY=None) as api:
        return await api.get("/api/lookup", params={"q": "amelie", "type": "movie"})


@scene("health", "GET", "/health", 200)
async def _health(w):
    async with w.make_api() as api:
        return await api.get("/health")


@scene("hls-not-started", "GET", "/api/downloads/{gid}/hls", 404)
async def _hls_not_started(w):
    async with w.make_api() as api:
        return await api.get(f"/api/downloads/{make_hash('nothing')}/hls")


@scene("segments-invalid", "GET", "/api/segments/{imdb_id}/{season}/{episode}", 422)
async def _segments_invalid(w):
    async with w.make_api() as api:
        return await api.get("/api/segments/nm0000001/1/1")


@scene("chart-unknown", "GET", "/api/charts/{key}", 404)
async def _chart_unknown(w):
    async with w.make_api() as api:
        return await api.get("/api/charts/genre-Nope")


@scene("metadata-unknown", "GET", "/api/metadata/{media_type}/{media_id}", 404)
async def _metadata_unknown(w):
    async with w.make_api() as api:
        return await api.get("/api/metadata/movie/1")


@scene("trailer-bad-key", "GET", "/api/trailers/{key}", 400)
async def _trailer_bad_key(w):
    async with w.make_api() as api:
        return await api.get("/api/trailers/short")


@scene("trending-imdb-down", "GET", "/api/trending", 503)
async def _trending_down(w):
    imdb = ImdbSim(w.upstream)
    imdb.fail(status=500)
    async with w.make_api() as api:
        return await api.get("/api/trending", params={"type": "tv"})
