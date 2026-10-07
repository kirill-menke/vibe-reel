"""A stateful fake Sonarr v4 / Radarr v5 (API v3 routes), served through respx.

Field names and shapes follow the public Sonarr v4 / Radarr v5 OpenAPI specs
(tests/test_spec_arr.py checks them against the spec cache when present).
Only what reel-api calls is implemented; anything else raises AssertionError
inside the request, so an unexpected call fails the test loudly.

Sonarr (kind "tv")                          Radarr (kind "movie")
  GET    /api/v3/series[?tvdbId=]             GET    /api/v3/movie[?tmdbId=]
  GET    /api/v3/series/lookup?term=          GET    /api/v3/movie/lookup?term=
  POST   /api/v3/series            (add)      POST   /api/v3/movie            (add)
  GET    /api/v3/series/{id}                  GET    /api/v3/movie/{id}
  PUT    /api/v3/series/{id}                  PUT    /api/v3/movie/editor {movieIds, monitored}
  DELETE /api/v3/series/{id}?deleteFiles=     DELETE /api/v3/movie/{id}?deleteFiles=
  GET    /api/v3/episode?seriesId=[&seasonNumber=][&includeImages=]
  PUT    /api/v3/episode/monitor {episodeIds, monitored}
both:
  GET    /api/v3/qualityprofile, /api/v3/rootfolder
  GET    /api/v3/queue?page=&pageSize=[&includeSeries=&includeEpisode=|&includeMovie=]
  DELETE /api/v3/queue/{id}?removeFromClient=&blocklist=&skipRedownload=
  GET    /api/v3/history/since?date=[&eventType=][&includeSeries=...]
  GET    /api/v3/command, GET /api/v3/command/{id}, POST /api/v3/command,
  DELETE /api/v3/command/{id}   (only a queued command can be cancelled)

Every request must carry the right X-Api-Key (else 401, like the arrs).
Every call is recorded in `sim.calls` as `Call(method, path, params, body)`;
`sim.fail(path, status=|exc=)` queues one-shot failures; `path` is either the
exact request path or the route template ("/api/v3/series/{id}").

State is plain dicts in the arrs' own JSON shape:
  sim.catalog   — the metadata source (TheTVDB / TMDB) the lookup searches
  sim.titles    — the library: arr id -> series/movie object
  sim.episodes  — episode id -> episode object (tv)
  sim.queue     — raw queue records
  sim.history   — history events
  sim.commands  — command id -> command object
Builders: series_obj(), movie_obj(), season_obj(), episode_obj(),
queue_record(), history_event(). Scenario helpers: add_catalog(),
add_series()/add_movie() (straight into the library), grab(), import_grab().
"""

from __future__ import annotations

import asyncio
import copy
import json
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

import httpx

SONARR = "http://sonarr.test"
RADARR = "http://radarr.test"
SONARR_KEY = "sonarr-test-key"
RADARR_KEY = "radarr-test-key"

QUEUE_DEFAULT_PAGE_SIZE = 10  # Sonarr/Radarr's default when pageSize is absent


def iso(d: datetime | None) -> str | None:
    """The arrs' UTC timestamp format."""
    return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if d else None


def now_utc() -> datetime:
    """`datetime.now()` (so time_machine moves it)."""
    return datetime.now(timezone.utc)


def _parse(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _norm_words(s: str) -> list[str]:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).split()


def _truthy(v: str | None) -> bool:
    return (v or "").lower() == "true"


# ---------------------------------------------------------------- builders


def images(kind: str, key: int | str, *, poster: bool = True, fanart: bool = True,
           relative_only: bool = False) -> list[dict]:
    """images[] as the arrs send them: a relative `url` (needs the API key) and
    an absolute `remoteUrl` from TheTVDB/TMDB."""
    host = "https://artworks.thetvdb.com/banners" if kind == "tv" else "https://image.tmdb.org/t/p/original"
    out = []
    for cover, on in (("poster", poster), ("fanart", fanart)):
        if not on:
            continue
        img = {"coverType": cover, "url": f"/MediaCover/{key}/{cover}.jpg"}
        if not relative_only:
            img["remoteUrl"] = f"{host}/{cover}s/{key}.jpg"
        out.append(img)
    return out


def season_obj(n: int, *, monitored: bool = True, files: int = 0, total: int = 8,
               aired: int | None = None, previous_airing: datetime | None = None,
               next_airing: datetime | None = None) -> dict:
    """A seasons[] entry with Sonarr's per-season statistics."""
    st: dict[str, Any] = {
        "episodeFileCount": files,
        "episodeCount": aired if aired is not None else files,
        "totalEpisodeCount": total,
        "sizeOnDisk": files * 1_500_000_000,
        "releaseGroups": [],
        "percentOfEpisodes": (100.0 * files / total) if total else 0.0,
    }
    if previous_airing:
        st["previousAiring"] = iso(previous_airing)
    if next_airing:
        st["nextAiring"] = iso(next_airing)
    return {"seasonNumber": n, "monitored": monitored, "statistics": st}


def series_obj(tvdb: int, title: str, *, year: int | None = 2020, seasons: list[dict] | None = None,
               imdb: str | None = None, overview: str = "", votes: int = 1000, rating: float = 8.0,
               runtime: int = 50, genres: list[str] | None = None, certification: str | None = "TV-MA",
               status: str = "continuing", monitored: bool = True, poster: bool = True,
               fanart: bool = True, **extra) -> dict:
    """A Sonarr v4 SeriesResource as the lookup returns it (no `id`: not in
    the library). add_series() / an add turn it into a library entry."""
    seasons = seasons if seasons is not None else [season_obj(1)]
    obj = {
        "title": title,
        "sortTitle": title.lower(),
        "status": status,
        "ended": status == "ended",
        "overview": overview or f"{title} overview.",
        "network": "HBO",
        "airTime": "21:00",
        "images": images("tv", tvdb, poster=poster, fanart=fanart),
        "originalLanguage": {"id": 1, "name": "English"},
        "remotePoster": f"https://artworks.thetvdb.com/banners/posters/{tvdb}.jpg" if poster else None,
        "seasons": seasons,
        "year": year or 0,
        "qualityProfileId": 0,
        "seasonFolder": True,
        "monitored": monitored,
        "monitorNewItems": "all",
        "useSceneNumbering": False,
        "runtime": runtime,
        "tvdbId": tvdb,
        "tvRageId": 0,
        "tvMazeId": tvdb + 7,
        "tmdbId": tvdb + 11,
        "firstAired": f"{year or 2020}-01-12T00:00:00Z",
        "seriesType": "standard",
        "cleanTitle": "".join(_norm_words(title)),
        "imdbId": imdb or f"tt{tvdb:07d}",
        "titleSlug": "-".join(_norm_words(title)),
        "folder": title,
        "certification": certification,
        "genres": genres if genres is not None else ["Drama"],
        "tags": [],
        "ratings": {"votes": votes, "value": rating},
        "statistics": {"seasonCount": sum(1 for s in seasons if s["seasonNumber"] > 0)},
        "languageProfileId": 0,
    }
    obj.update(extra)
    return obj


def movie_obj(tmdb: int, title: str, *, year: int | None = 2021, imdb: str | None = None,
              original_title: str | None = None, overview: str = "", imdb_votes: int = 1000,
              imdb_rating: float | None = 7.5, tmdb_rating: float | None = 7.2,
              trakt_votes: int = 0, tmdb_votes: int = 0, runtime: int = 120,
              genres: list[str] | None = None, certification: str | None = "PG-13",
              trailer: str | None = "dQw4w9WgXcQ", collection: dict | None = None,
              digital_release: datetime | str | None = None, has_file: bool = False,
              status: str = "released", monitored: bool = True, poster: bool = True,
              fanart: bool = True, **extra) -> dict:
    """A Radarr v5 MovieResource as the lookup returns it (no `id`)."""
    ratings: dict[str, Any] = {}
    if imdb_votes or imdb_rating:
        ratings["imdb"] = {"votes": imdb_votes, "value": imdb_rating or 0, "type": "user"}
    if tmdb_votes or tmdb_rating:
        ratings["tmdb"] = {"votes": tmdb_votes, "value": tmdb_rating or 0, "type": "user"}
    if trakt_votes:
        ratings["trakt"] = {"votes": trakt_votes, "value": 7.0, "type": "user"}
    if isinstance(digital_release, datetime):
        digital_release = iso(digital_release)
    obj = {
        "title": title,
        "originalTitle": original_title or title,
        "originalLanguage": {"id": 1, "name": "English"},
        "sortTitle": title.lower(),
        "status": status,
        "overview": overview or f"{title} overview.",
        "inCinemas": f"{year or 2021}-03-01T00:00:00Z",
        "physicalRelease": f"{year or 2021}-06-01T00:00:00Z",
        "digitalRelease": digital_release if digital_release is not None else f"{year or 2021}-05-01T00:00:00Z",
        "images": images("movie", tmdb, poster=poster, fanart=fanart),
        "remotePoster": f"https://image.tmdb.org/t/p/original/posters/{tmdb}.jpg" if poster else None,
        "website": "",
        "year": year or 0,
        "youTubeTrailerId": trailer or "",
        "studio": "Studio",
        "qualityProfileId": 0,
        "hasFile": has_file,
        "movieFileId": 0,
        "monitored": monitored,
        "minimumAvailability": "announced",
        "isAvailable": True,
        "folderName": f"{title} ({year})",
        "runtime": runtime,
        "cleanTitle": "".join(_norm_words(title)),
        "imdbId": imdb or f"tt{tmdb:07d}",
        "tmdbId": tmdb,
        "titleSlug": str(tmdb),
        "folder": f"{title} ({year})",
        "certification": certification,
        "genres": genres if genres is not None else ["Science Fiction"],
        "tags": [],
        "ratings": ratings,
        "popularity": 50.0,
        "statistics": {"movieFileCount": 1 if has_file else 0, "sizeOnDisk": 4_000_000_000 if has_file else 0,
                       "releaseGroups": []},
    }
    if collection is not None:
        obj["collection"] = collection
    obj.update(extra)
    return obj


def episode_obj(season: int, episode: int, *, title: str | None = None, air: datetime | None = None,
                has_file: bool = False, monitored: bool = True, overview: str = "",
                still: bool = True, **extra) -> dict:
    """A Sonarr EpisodeResource without ids (the sim assigns id/seriesId).
    `air` None = no air date announced yet."""
    obj = {
        "tvdbId": 9_000_000 + season * 100 + episode,
        "episodeFileId": 0,
        "seasonNumber": season,
        "episodeNumber": episode,
        "title": title if title is not None else f"Episode {episode}",
        "overview": overview or f"S{season}E{episode} overview.",
        "hasFile": has_file,
        "monitored": monitored,
        "absoluteEpisodeNumber": episode,
        "unverifiedSceneNumbering": False,
        "runtime": 50,
        "_still": still,
    }
    if air is not None:
        obj["airDate"] = air.strftime("%Y-%m-%d")
        obj["airDateUtc"] = iso(air)
    obj.update(extra)
    return obj


def quality(name: str = "WEBDL-1080p", resolution: int = 1080, *, kind: str = "tv") -> dict:
    """A QualityModel. The two arrs name the source enum differently: Sonarr's
    QualitySource has "web", Radarr's Source "webdl" (their OpenAPI specs)."""
    source = "web" if kind == "tv" else "webdl"
    return {"quality": {"id": 3, "name": name, "source": source, "resolution": resolution},
            "revision": {"version": 1, "real": 0, "isRepack": False}}


def queue_record(rid: int, *, download_id: str | None, size: int = 1_000_000_000, sizeleft: int = 500_000_000,
                 state: str = "downloading", status: str = "downloading", title: str = "Some.Release.1080p",
                 series_id: int | None = None, episode_id: int | None = None, season: int | None = None,
                 movie_id: int | None = None, added: datetime | None = None, timeleft: str | None = "00:10:00",
                 error: str | None = None, status_messages: list[dict] | None = None,
                 quality_name: str = "WEBDL-1080p", **extra) -> dict:
    """A raw QueueResource (without the embedded series/episode/movie, which
    the sim adds per includeSeries/includeEpisode/includeMovie)."""
    rec: dict[str, Any] = {
        "id": rid,
        "languages": [{"id": 1, "name": "English"}],
        "quality": quality(quality_name, kind="movie" if movie_id is not None else "tv"),
        "customFormats": [],
        "customFormatScore": 0,
        "size": size,
        "title": title,
        "sizeleft": sizeleft,
        "timeleft": timeleft,
        "estimatedCompletionTime": iso(now_utc() + timedelta(minutes=10)),
        "added": iso(added or now_utc()),
        "status": status,
        "trackedDownloadStatus": "warning" if (error or status_messages) else "ok",
        "trackedDownloadState": state,
        "statusMessages": status_messages or [],
        "errorMessage": error,
        "downloadId": download_id,
        "protocol": "torrent",
        "downloadClient": "qBittorrent",
        "downloadClientHasPostImportCategory": False,
        "indexer": "1337x",
        "outputPath": f"/downloads/{title}",
    }
    if series_id is not None:
        rec.update(seriesId=series_id, episodeId=episode_id, seasonNumber=season, episodeHasFile=False)
    if movie_id is not None:
        rec.update(movieId=movie_id)
    rec.update(extra)
    return rec


def history_event(hid: int, event_type: str, *, date: datetime | None = None, download_id: str | None = None,
                  series_id: int | None = None, episode_id: int | None = None, movie_id: int | None = None,
                  source_title: str = "Some.Release.1080p", data: dict | None = None, **extra) -> dict:
    """A HistoryResource (eventType grabbed / downloadFolderImported /
    episodeFileDeleted / movieFileDeleted / ...)."""
    ev: dict[str, Any] = {
        "id": hid,
        "sourceTitle": source_title,
        "languages": [{"id": 1, "name": "English"}],
        "quality": quality(kind="movie" if movie_id is not None else "tv"),
        "customFormats": [],
        "customFormatScore": 0,
        "qualityCutoffNotMet": False,
        "date": iso(date or now_utc()),
        "downloadId": download_id,
        "eventType": event_type,
        "data": data or {},
    }
    if series_id is not None:
        ev.update(seriesId=series_id, episodeId=episode_id)
    if movie_id is not None:
        ev.update(movieId=movie_id)
    ev.update(extra)
    return ev


# ---------------------------------------------------------------- the sim


@dataclass
class Call:
    method: str
    path: str
    params: dict
    body: Any

    def __iter__(self):  # allows `method, path, params, body = call`
        return iter((self.method, self.path, self.params, self.body))


LIVE: list = []  # every ArrSim of the running test (conftest's arr_deletes_keep_files checks them)


class ArrSim:
    """kind "tv" = Sonarr, "movie" = Radarr."""

    def __init__(self, router, kind: str, base: str | None = None, api_key: str | None = None, *,
                 quality_profiles: list[dict] | None = None, root_folders: list[dict] | None = None,
                 add_queues_commands: bool = True):
        assert kind in ("tv", "movie")
        self.kind = kind
        self.base = (base or (SONARR if kind == "tv" else RADARR)).rstrip("/")
        self.api_key = api_key or (SONARR_KEY if kind == "tv" else RADARR_KEY)
        self.noun = "series" if kind == "tv" else "movie"
        self.id_field = "tvdbId" if kind == "tv" else "tmdbId"
        self.owner_field = "seriesId" if kind == "tv" else "movieId"
        self.quality_profiles = quality_profiles if quality_profiles is not None else [
            {"id": 1, "name": "Any"}, {"id": 4, "name": "HD-1080p"}, {"id": 6, "name": "Ultra-HD"}]
        self.root_folders = root_folders if root_folders is not None else [
            {"id": 1, "path": "/tank/media/tv" if kind == "tv" else "/tank/media/movies",
             "accessible": True, "freeSpace": 10**12}]
        self.add_queues_commands = add_queues_commands
        LIVE.append(self)

        self.catalog: list[dict] = []
        self.catalog_episodes: dict[int, list[dict]] = {}  # tvdbId -> episode templates
        self.titles: dict[int, dict] = {}
        self.episodes: dict[int, dict] = {}
        self.queue: list[dict] = []
        self.history: list[dict] = []
        self.commands: dict[int, dict] = {}
        self.deleted: list[dict] = []  # {"id", "params"} per title DELETE
        self.files_deleted: list[int] = []  # arr ids deleted with deleteFiles=true
        self.queue_deleted: list[dict] = []  # {"id", "params"} per queue DELETE
        self.calls: list[Call] = []
        self.lookup_overrides: dict[str, list[dict] | httpx.Response] = {}
        self.on_command: Callable[[dict], None] | None = None  # called after a POST /command
        self.on_add: Callable[[dict], None] | None = None  # called with the new library entry
        self._faults: dict[str, list] = {}
        self._gates: dict[str, tuple[asyncio.Event, Callable | None]] = {}
        self._next = {"title": 100, "episode": 1000, "queue": 5000, "history": 7000, "command": 300}

        p = "/api/v3"
        n = self.noun
        self._routes: list[tuple[str, re.Pattern, str, Callable]] = []
        table = [
            ("GET", f"{p}/{n}/lookup", self._lookup),
            ("GET", f"{p}/{n}", self._list_titles),
            ("POST", f"{p}/{n}", self._add),
            ("GET", f"{p}/{n}/{{id}}", self._get_title),
            ("DELETE", f"{p}/{n}/{{id}}", self._delete_title),
            ("GET", f"{p}/qualityprofile", lambda req, m: self._json(self.quality_profiles)),
            ("GET", f"{p}/rootfolder", lambda req, m: self._json(self.root_folders)),
            ("GET", f"{p}/queue", self._queue),
            ("DELETE", f"{p}/queue/{{id}}", self._delete_queue),
            ("GET", f"{p}/history/since", self._history_since),
            ("GET", f"{p}/command", self._list_commands),
            ("GET", f"{p}/command/{{id}}", self._get_command),
            ("POST", f"{p}/command", self._post_command),
            ("DELETE", f"{p}/command/{{id}}", self._delete_command),
        ]
        if kind == "tv":
            table += [
                ("PUT", f"{p}/series/{{id}}", self._put_series),
                ("GET", f"{p}/episode", self._list_episodes),
                ("PUT", f"{p}/episode/monitor", self._monitor_episodes),
            ]
        else:
            table += [("PUT", f"{p}/movie/editor", self._movie_editor)]
        for method, template, handler in table:
            rx = re.compile("^" + re.escape(template).replace(re.escape("{id}"), r"(?P<id>\d+)") + "$")
            self._routes.append((method, rx, template, handler))
        router.route(url__startswith=self.base + "/", name=f"arr_{kind}").mock(side_effect=self._dispatch)

    # ================================================================ test API

    def add_catalog(self, obj: dict, episodes: list[dict] | None = None) -> dict:
        """Make a title findable by the lookup (not in the library)."""
        obj = copy.deepcopy(obj)
        obj.pop("id", None)
        self.catalog.append(obj)
        if episodes is not None:
            self.catalog_episodes[obj[self.id_field]] = copy.deepcopy(episodes)
        return obj

    def add_series(self, obj: dict, episodes: list[dict] | None = None, *, added: datetime | None = None,
                   path: str | None = None) -> dict:
        assert self.kind == "tv"
        return self._into_library(obj, episodes, added=added, path=path)

    def add_movie(self, obj: dict, *, added: datetime | None = None, path: str | None = None) -> dict:
        assert self.kind == "movie"
        return self._into_library(obj, None, added=added, path=path)

    def title(self, ext_id: int | str) -> dict | None:
        """The library entry with this tvdb/tmdb id."""
        return next((t for t in self.titles.values() if str(t.get(self.id_field)) == str(ext_id)), None)

    def episodes_of(self, series_id: int, season: int | None = None) -> list[dict]:
        return sorted((e for e in self.episodes.values() if e["seriesId"] == series_id
                       and (season is None or e["seasonNumber"] == season)),
                      key=lambda e: (e["seasonNumber"], e["episodeNumber"]))

    def episode(self, series_id: int, season: int, number: int) -> dict:
        return next(e for e in self.episodes_of(series_id, season) if e["episodeNumber"] == number)

    def grab(self, arr_id: int, download_id: str, *, episode_ids: list[int] | None = None,
             history: bool = True, date: datetime | None = None, **rec) -> list[dict]:
        """A grab in flight: one queue row per episode (one for a movie) sharing
        `download_id`, plus a 'grabbed' history event per row."""
        rows = []
        targets = episode_ids if self.kind == "tv" else [None]
        assert targets, "a tv grab needs episode_ids"
        for eid in targets:
            rid = self._id("queue")
            if self.kind == "tv":
                ep = self.episodes[eid]
                row = queue_record(rid, download_id=download_id, series_id=arr_id, episode_id=eid,
                                   season=ep["seasonNumber"], added=date, **rec)
            else:
                row = queue_record(rid, download_id=download_id, movie_id=arr_id, added=date, **rec)
            self.queue.append(row)
            rows.append(row)
            if history:
                self.history.append(history_event(
                    self._id("history"), "grabbed", date=date, download_id=download_id,
                    series_id=arr_id if self.kind == "tv" else None, episode_id=eid,
                    movie_id=arr_id if self.kind == "movie" else None, source_title=row["title"]))
        return rows

    def import_grab(self, download_id: str, *, date: datetime | None = None) -> list[dict]:
        """The grab is imported: its queue rows leave, the episodes/movie get a
        file, a downloadFolderImported event per row is written."""
        rows = [r for r in self.queue if (r.get("downloadId") or "").lower() == download_id.lower()]
        self.queue = [r for r in self.queue if r not in rows]
        events = []
        for r in rows:
            if self.kind == "tv":
                ep = self.episodes.get(r.get("episodeId"))
                if ep:
                    ep["hasFile"] = True
                    ep["episodeFileId"] = self._id("history")
            else:
                m = self.titles.get(r.get("movieId"))
                if m:
                    m.update(hasFile=True, movieFileId=self._id("history"), sizeOnDisk=4_000_000_000)
                    m["statistics"] = {**m.get("statistics", {}), "movieFileCount": 1, "sizeOnDisk": 4_000_000_000}
            ev = history_event(self._id("history"), "downloadFolderImported", date=date, download_id=download_id,
                               series_id=r.get("seriesId"), episode_id=r.get("episodeId"),
                               movie_id=r.get("movieId"), source_title=r["title"])
            self.history.append(ev)
            events.append(ev)
        return events

    def add_history(self, event_type: str, **kw) -> dict:
        ev = history_event(self._id("history"), event_type, **kw)
        self.history.append(ev)
        return ev

    def add_command(self, name: str, body: dict, status: str = "queued") -> dict:
        cid = self._id("command")
        cmd = {"id": cid, "name": name, "commandName": name, "message": "", "priority": "normal",
               "status": status, "result": "unknown", "queued": iso(now_utc()), "trigger": "manual",
               "stateChangeTime": iso(now_utc()), "sendUpdatesToClient": True, "updateScheduledTask": True,
               "body": {"name": name, **body}}
        self.commands[cid] = cmd
        return cmd

    def set_command_status(self, cid: int, status: str) -> None:
        self.commands[cid]["status"] = status

    def finish_commands(self) -> None:
        for c in self.commands.values():
            if c["status"] in ("queued", "started"):
                c["status"] = "completed"

    def active_commands(self) -> list[dict]:
        return [c for c in self.commands.values() if c["status"] in ("queued", "started")]

    def set_lookup(self, term: str, result: list[dict] | httpx.Response) -> None:
        """Pin the lookup answer for one exact term."""
        self.lookup_overrides[term] = result

    def fail(self, path: str, *, status: int | None = None, exc: Exception | None = None,
             body: str = "", times: int = 1) -> None:
        """Queue failures for the next `times` calls to `path` (exact path or template)."""
        item = exc if exc is not None else httpx.Response(status or 500, text=body)
        self._faults.setdefault(path, []).extend([item] * times)

    def gate(self, path: str, match: Callable[[Call], bool] | None = None) -> asyncio.Event:
        """Hold every call to `path` (exact or template) — or only those for
        which `match(call)` is true — until the event is set."""
        ev = asyncio.Event()
        self._gates[path] = (ev, match)
        return ev

    def called(self, path: str, method: str | None = None) -> list[Call]:
        """Calls whose path (or template) is `path`."""
        return [c for c in self.calls if (c.path == path or self._template_of(c) == path)
                and (method is None or c.method == method)]

    def count(self, path: str, method: str | None = None) -> int:
        return len(self.called(path, method))

    # ================================================================ plumbing

    def _id(self, what: str) -> int:
        self._next[what] += 1
        return self._next[what]

    def _template_of(self, call: Call) -> str | None:
        for method, rx, template, _ in self._routes:
            if method == call.method and rx.match(call.path):
                return template
        return None

    @staticmethod
    def _json(obj, status: int = 200) -> httpx.Response:
        return httpx.Response(status, json=obj)

    async def _dispatch(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        params = dict(request.url.params.items())
        body = None
        if request.content:
            try:
                body = json.loads(request.content)
            except ValueError:
                body = request.content.decode(errors="replace")
        call = Call(request.method, path, params, body)
        self.calls.append(call)
        for method, rx, template, handler in self._routes:
            m = rx.match(path)
            if method != request.method or not m:
                continue
            for key in (path, template):
                if key in self._gates:
                    ev, match = self._gates[key]
                    if match is None or match(call):
                        await ev.wait()
            for key in (path, template):
                faults = self._faults.get(key)
                if faults:
                    item = faults.pop(0)
                    if isinstance(item, Exception):
                        raise item
                    return item
            if request.headers.get("X-Api-Key") != self.api_key:
                return httpx.Response(401, text="Unauthorized")
            return handler(call, m)
        raise AssertionError(f"ArrSim({self.kind}): no route for {request.method} {path}")

    def _into_library(self, obj: dict, episodes: list[dict] | None, *, added: datetime | None,
                      path: str | None) -> dict:
        obj = copy.deepcopy(obj)
        aid = obj.get("id") or self._id("title")
        root = self.root_folders[0]["path"] if self.root_folders else "/media"
        obj.update(id=aid, added=iso(added or now_utc()),
                   path=path or f"{root}/{obj.get('folder') or obj.get('title')}")
        if not obj.get("qualityProfileId"):
            obj["qualityProfileId"] = self.quality_profiles[0]["id"] if self.quality_profiles else 1
        self.titles[aid] = obj
        if self.kind == "tv":
            tmpl = episodes if episodes is not None else self.catalog_episodes.get(obj["tvdbId"], [])
            for e in tmpl:
                e = copy.deepcopy(e)
                eid = e.get("id") or self._id("episode")
                e.update(id=eid, seriesId=aid)
                self.episodes[eid] = e
        return obj

    def _with_stats(self, obj: dict) -> dict:
        """A series as GET returns it: season statistics derived from the sim's
        episodes when it has any (else as built)."""
        obj = copy.deepcopy(obj)
        if self.kind != "tv":
            return obj
        eps = self.episodes_of(obj["id"]) if obj.get("id") else []
        if not eps:
            return obj
        now = now_utc()
        tot_files = tot_eps = tot_total = 0
        for se in obj.get("seasons") or []:
            n = se["seasonNumber"]
            mine = [e for e in eps if e["seasonNumber"] == n]
            airs = [d for e in mine if (d := _parse(e.get("airDateUtc")))]
            prev = [d for d in airs if d <= now]
            nxt = [d for d in airs if d > now]
            files = sum(1 for e in mine if e.get("hasFile"))
            aired_count = sum(1 for e in mine if e.get("hasFile") or (e.get("monitored") and
                              (d := _parse(e.get("airDateUtc"))) and d <= now))
            st = {"episodeFileCount": files, "episodeCount": aired_count, "totalEpisodeCount": len(mine),
                  "sizeOnDisk": files * 1_500_000_000, "releaseGroups": [],
                  "percentOfEpisodes": 100.0 * files / aired_count if aired_count else 0.0}
            if prev:
                st["previousAiring"] = iso(max(prev))
            if nxt:
                st["nextAiring"] = iso(min(nxt))
            se["statistics"] = st
            tot_files += files
            tot_eps += aired_count
            tot_total += len(mine)
        obj["statistics"] = {"seasonCount": sum(1 for s in obj.get("seasons") or [] if s["seasonNumber"] > 0),
                             "episodeFileCount": tot_files, "episodeCount": tot_eps,
                             "totalEpisodeCount": tot_total, "sizeOnDisk": tot_files * 1_500_000_000,
                             "releaseGroups": [], "percentOfEpisodes": 100.0 * tot_files / tot_eps if tot_eps else 0.0}
        return obj

    def _public_episode(self, e: dict, with_images: bool) -> dict:
        e = {k: v for k, v in e.items() if not k.startswith("_")}
        if with_images:
            src = self.episodes.get(e["id"], {})
            e["images"] = ([{"coverType": "screenshot", "url": f"/MediaCover/e{e['id']}.jpg",
                             "remoteUrl": f"https://artworks.thetvdb.com/banners/episodes/{e['tvdbId']}.jpg"}]
                           if src.get("_still", True) else [])
        return e

    # ================================================================ handlers

    def _lookup(self, call: Call, m) -> httpx.Response:
        term = call.params.get("term")
        if term is None:
            return httpx.Response(400, json={"message": "term is required"})
        if term in self.lookup_overrides:
            res = self.lookup_overrides[term]
            return res if isinstance(res, httpx.Response) else self._json(copy.deepcopy(res))
        lib = {str(t.get(self.id_field)): t for t in self.titles.values()}
        pool = [lib.get(str(c.get(self.id_field)), c) for c in self.catalog]
        pool += [t for t in self.titles.values()
                 if not any(str(c.get(self.id_field)) == str(t.get(self.id_field)) for c in self.catalog)]
        t = term.strip()
        low = t.lower()
        if low.startswith(f"{self.id_field[:4].lower()}:"):  # tvdb: / tmdb:
            key = t.split(":", 1)[1]
            hits = [o for o in pool if str(o.get(self.id_field)) == key]
        elif low.startswith("imdb:"):
            key = t.split(":", 1)[1]
            hits = [o for o in pool if o.get("imdbId") == key]
        else:
            # whole-word matching, like the arrs' metadata search
            want = _norm_words(t)
            hits = [o for o in pool if want and all(w in _norm_words(o.get("title", "")) for w in want)]
        return self._json([self._with_stats(o) for o in hits])

    def _list_titles(self, call: Call, m) -> httpx.Response:
        items = list(self.titles.values())
        if self.id_field in call.params:  # Sonarr ?tvdbId= / Radarr ?tmdbId=
            items = [s for s in items if str(s.get(self.id_field)) == call.params[self.id_field]]
        return self._json([self._with_stats(o) for o in items])

    def _get_title(self, call: Call, m) -> httpx.Response:
        obj = self.titles.get(int(m["id"]))
        if obj is None:
            return httpx.Response(404, json={"message": "NotFound"})
        return self._json(self._with_stats(obj))

    def _add(self, call: Call, m) -> httpx.Response:
        body = call.body or {}
        ext = body.get(self.id_field)
        errors = []
        if not ext:
            errors.append({"propertyName": self.id_field[0].upper() + self.id_field[1:],
                           "errorMessage": f"'{self.id_field}' must be greater than '0'.",
                           "errorCode": "GreaterThanValidator"})
        if self.title(ext) is not None:
            noun = "series" if self.kind == "tv" else "movie"
            errors.append({"propertyName": self.id_field[0].upper() + self.id_field[1:],
                           "errorMessage": f"This {noun} has already been added",
                           "errorCode": "SeriesExistsValidator" if self.kind == "tv" else "MovieExistsValidator"})
        if not any(p["id"] == body.get("qualityProfileId") for p in self.quality_profiles):
            errors.append({"propertyName": "QualityProfileId", "errorMessage": "QualityProfile does not exist",
                           "errorCode": "QualityProfileExistsValidator"})
        if not body.get("rootFolderPath") and not body.get("path"):
            errors.append({"propertyName": "RootFolderPath", "errorMessage": "'Root Folder Path' must not be empty.",
                           "errorCode": "NotEmptyValidator"})
        if errors:
            return httpx.Response(400, json=errors)
        entry = {k: v for k, v in body.items() if k != "addOptions"}
        entry["path"] = f"{body.get('rootFolderPath', '').rstrip('/')}/{body.get('folder') or body.get('title')}"
        obj = self._into_library(entry, None, added=None, path=entry["path"])
        opts = body.get("addOptions") or {}
        if self.kind == "tv":
            mon = opts.get("monitor", "all")
            for e in self.episodes_of(obj["id"]):
                e["monitored"] = mon == "all"
            if self.add_queues_commands:
                self.add_command("RefreshSeries", {"seriesIds": [obj["id"]], "isNewSeries": True})
                if opts.get("searchForMissingEpisodes"):
                    self.add_command("SeriesSearch", {"seriesId": obj["id"]})
        elif self.add_queues_commands:
            self.add_command("RefreshMovie", {"movieIds": [obj["id"]], "isNewMovie": True})
            if opts.get("searchForMovie"):
                self.add_command("MoviesSearch", {"movieIds": [obj["id"]]})
        if self.on_add:
            self.on_add(obj)
        return self._json(self._with_stats(obj), 201)

    def _put_series(self, call: Call, m) -> httpx.Response:
        sid = int(m["id"])
        if sid not in self.titles:
            return httpx.Response(404, json={"message": "NotFound"})
        body = call.body or {}
        cur = self.titles[sid]
        for k in ("monitored", "seasons", "qualityProfileId", "seasonFolder", "monitorNewItems", "tags", "path"):
            if k in body:
                cur[k] = copy.deepcopy(body[k])
        return self._json(self._with_stats(cur), 202)

    def _movie_editor(self, call: Call, m) -> httpx.Response:
        body = call.body or {}
        out = []
        for mid in body.get("movieIds") or []:
            mv = self.titles.get(mid)
            if mv is None:
                continue
            if "monitored" in body:
                mv["monitored"] = bool(body["monitored"])
            out.append(copy.deepcopy(mv))
        return self._json(out, 202)

    def _delete_title(self, call: Call, m) -> httpx.Response:
        aid = int(m["id"])
        if aid not in self.titles:
            return httpx.Response(404, json={"message": "NotFound"})
        del self.titles[aid]
        if self.kind == "tv":
            self.episodes = {k: e for k, e in self.episodes.items() if e["seriesId"] != aid}
        self.deleted.append({"id": aid, "params": dict(call.params)})
        if _truthy(call.params.get("deleteFiles")):
            self.files_deleted.append(aid)  # the title's files went with it
        return httpx.Response(200)

    def _list_episodes(self, call: Call, m) -> httpx.Response:
        sid = call.params.get("seriesId")
        if sid is None:
            return httpx.Response(400, json={"message": "seriesId is missing"})
        if int(sid) not in self.titles:
            return httpx.Response(404, json={"message": "NotFound"})
        season = call.params.get("seasonNumber")
        eps = self.episodes_of(int(sid), int(season) if season is not None else None)
        return self._json([self._public_episode(e, _truthy(call.params.get("includeImages"))) for e in eps])

    def _monitor_episodes(self, call: Call, m) -> httpx.Response:
        """Like Sonarr's EpisodeController.SetEpisodesMonitored: 202 with the
        updated episodes (an untyped IActionResult, so the spec shows no body)."""
        body = call.body or {}
        out = []
        for eid in body.get("episodeIds") or []:
            if eid in self.episodes:
                self.episodes[eid]["monitored"] = bool(body.get("monitored"))
                out.append(self._public_episode(self.episodes[eid], _truthy(call.params.get("includeImages"))))
        return self._json(out, 202)

    def _embed(self, rec: dict, params: dict) -> dict:
        rec = {k: v for k, v in rec.items()}
        if self.kind == "tv":
            if _truthy(params.get("includeSeries")) and rec.get("seriesId") in self.titles:
                rec["series"] = self._with_stats(self.titles[rec["seriesId"]])
            if _truthy(params.get("includeEpisode")) and rec.get("episodeId") in self.episodes:
                rec["episode"] = self._public_episode(self.episodes[rec["episodeId"]], False)
        elif _truthy(params.get("includeMovie")) and rec.get("movieId") in self.titles:
            rec["movie"] = copy.deepcopy(self.titles[rec["movieId"]])
        return rec

    def _queue(self, call: Call, m) -> httpx.Response:
        page = int(call.params.get("page") or 1)
        size = int(call.params.get("pageSize") or QUEUE_DEFAULT_PAGE_SIZE)
        rows = sorted(self.queue, key=lambda r: r["id"])
        chunk = rows[(page - 1) * size: page * size]
        return self._json({"page": page, "pageSize": size, "sortKey": "timeleft", "sortDirection": "ascending",
                           "totalRecords": len(rows), "records": [self._embed(r, call.params) for r in chunk]})

    def _delete_queue(self, call: Call, m) -> httpx.Response:
        rid = int(m["id"])
        row = next((r for r in self.queue if r["id"] == rid), None)
        if row is None:
            return httpx.Response(404, json={"message": "NotFound"})
        self.queue_deleted.append({"id": rid, "params": dict(call.params)})
        dl = (row.get("downloadId") or "").lower()
        if _truthy(call.params.get("removeFromClient")) and dl:
            # the torrent goes from the client: every row of it leaves the queue
            self.queue = [r for r in self.queue if (r.get("downloadId") or "").lower() != dl]
        else:
            self.queue = [r for r in self.queue if r["id"] != rid]
        return httpx.Response(200)

    def _history_since(self, call: Call, m) -> httpx.Response:
        since = _parse(call.params.get("date"))
        if since is None:
            return httpx.Response(400, json={"message": "date is required"})
        et = call.params.get("eventType")
        out = []
        for ev in sorted(self.history, key=lambda e: (e["date"], e["id"])):
            if (_parse(ev["date"]) or since) < since:
                continue
            if et and ev["eventType"].lower() != et.lower():
                continue
            out.append(self._embed(ev, call.params))
        return self._json(out)

    def _list_commands(self, call: Call, m) -> httpx.Response:
        return self._json([copy.deepcopy(c) for c in self.commands.values()])

    def _get_command(self, call: Call, m) -> httpx.Response:
        c = self.commands.get(int(m["id"]))
        return self._json(copy.deepcopy(c)) if c else httpx.Response(404, json={"message": "NotFound"})

    def _post_command(self, call: Call, m) -> httpx.Response:
        body = dict(call.body or {})
        name = body.pop("name", None)
        if not name:
            return httpx.Response(400, json=[{"propertyName": "Name", "errorMessage": "'Name' must not be empty."}])
        cmd = self.add_command(name, body)
        if self.on_command:
            self.on_command(cmd)
        return self._json(copy.deepcopy(cmd), 201)

    def _delete_command(self, call: Call, m) -> httpx.Response:
        c = self.commands.get(int(m["id"]))
        if c is None:
            return httpx.Response(404, json={"message": "NotFound"})
        if c["status"] != "queued":
            return httpx.Response(400, json={"message": "Unable to cancel task"})
        c["status"] = "cancelled"
        return httpx.Response(200)
