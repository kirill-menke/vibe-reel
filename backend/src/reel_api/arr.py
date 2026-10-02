"""Sonarr / Radarr proxy — the "add a show/movie to the library" backend.

Unlike the search/magnet/download path (which grabs a specific torrent), this
adds a *title* to Sonarr (TV) or Radarr (movies), which then searches indexers
via Prowlarr, downloads through qBittorrent, and imports+renames into the
library on its own. Two endpoints back the VibeReel "Add" screen:

  GET  /api/lookup?q=&type=tv|movie   -> title matches from TheTVDB/TMDB
  POST /api/library {id,type}         -> add + monitor + auto-search

Both Sonarr and Radarr speak the same API v3 shape; this parameterizes over the
handful of differences (series vs movie, tvdbId vs tmdbId, add options).
"""

import asyncio
import logging
import os
import re
import unicodedata
from datetime import datetime, timedelta, timezone

import httpx

log = logging.getLogger("reel_api.actions")  # handler: undo.py

_KIND = {
    "tv": {
        "lookup": "/api/v3/series/lookup",
        "add": "/api/v3/series",
        "id_field": "tvdbId",
        "term_prefix": "tvdb:",
        "add_extra": {"seriesType": "standard", "seasonFolder": True},
        "add_options": {"monitor": "all", "searchForMissingEpisodes": True},
    },
    "movie": {
        "lookup": "/api/v3/movie/lookup",
        "add": "/api/v3/movie",
        "id_field": "tmdbId",
        "term_prefix": "tmdb:",
        "add_extra": {"minimumAvailability": "released"},
        "add_options": {"searchForMovie": True},
    },
}

# Service name, default URL and default quality profile per kind.
_ENV = {
    "tv": ("SONARR", "http://127.0.0.1:8989"),
    "movie": ("RADARR", "http://127.0.0.1:7878"),
}


class ArrError(Exception):
    """Sonarr/Radarr unreachable or returned an error."""


class ArrNotConfigured(Exception):
    """No API key for this media type."""


class AlreadyAdded(Exception):
    def __init__(self, title: str):
        super().__init__(title)
        self.title = title


class NotAired(Exception):
    """A season search asked for before any episode of the season has aired."""


class NoSuchTitle(Exception):
    """Metadata requested for an id the arr's lookup doesn't know."""


def _image(item: dict, cover: str) -> str | None:
    """Absolute image URL of the given coverType, or None. Relative `url`s
    (Sonarr's /api/v3/mediacover/... paths) are useless to a client without the
    API key, so only http(s) URLs count."""
    for img in item.get("images", []):
        if img.get("coverType") == cover:
            u = img.get("remoteUrl") or img.get("url") or ""
            return u if u.startswith("http") else None
    return None


def _poster(item: dict) -> str | None:
    return _image(item, "poster")


def _rating(item: dict) -> float | None:
    # Sonarr: ratings = {votes, value}; Radarr v5: ratings = {imdb: {value}, tmdb: {...}}
    r = item.get("ratings") or {}
    for v in (r.get("value"), (r.get("imdb") or {}).get("value"), (r.get("tmdb") or {}).get("value")):
        if v:
            return round(float(v), 1)
    return None


def _votes(item: dict) -> int:
    """Vote count as a popularity signal for ranking lookup results. Sonarr's
    `ratings.votes` and Radarr's `ratings.imdb.votes` are both IMDb-scale
    counts (851k for The Office (US), 1.09M for Dune (2021)), so shows and
    movies can be ranked against each other. Trakt, then TMDB, stand in for a
    movie IMDb hasn't rated."""
    r = item.get("ratings") or {}
    for v in (r.get("votes"), (r.get("imdb") or {}).get("votes"),
              (r.get("trakt") or {}).get("votes"), (r.get("tmdb") or {}).get("votes")):
        if v:
            return int(v)
    return 0


# A season that aired longer ago than this and still has no file is old news —
# a gap in the back catalogue, not a new season.
NEWS_AIRED_DAYS = 365


def _when(s: str | None) -> datetime | None:
    """Sonarr's UTC timestamps ("2026-09-04T04:00:00Z") as aware datetimes."""
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def _iso(d: datetime | None) -> str | None:
    return d.strftime("%Y-%m-%dT%H:%M:%SZ") if d else None


def _norm(s: str) -> str:
    """Title/query key for match checks: accents folded, lowercase, trailing
    "(US)"/"(2012)" tags and punctuation dropped, no leading article. Mirrors
    norm() in VibeReel's src/lib/searchrank.js."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"['’]", "", s)
    s = re.sub(r"(\s*\((\d{4}|[a-z]{2})\))+\s*$", "", s)
    s = re.sub(r"[^a-z0-9]+", " ", s.replace("&", " and ")).strip()
    return re.sub(r"^(the|a|an) ", "", s)


# /api/v3/queue paging: a season pack is one row per episode, so the queue can
# hold far more rows than titles.
QUEUE_PAGE_SIZE = 200
QUEUE_MAX_PAGES = 25
MESSAGE_MAX = 160


def _queue_message(r: dict) -> str | None:
    """Why a queue row needs attention, in one line: Sonarr/Radarr's
    errorMessage, else the texts of its statusMessages (the per-file import
    warnings — their `title` is just the release/file name, so it is skipped).
    None when the row carries no reason."""
    texts = [r.get("errorMessage") or ""]
    for sm in r.get("statusMessages") or []:
        texts.extend(sm.get("messages") or [])
    seen: list[str] = []
    for t in texts:
        t = " ".join(str(t).split())
        if t and t not in seen:
            seen.append(t)
    if not seen:
        return None
    msg = "; ".join(seen)
    return msg if len(msg) <= MESSAGE_MAX else msg[: MESSAGE_MAX - 1].rstrip() + "…"


class ArrClient:
    def __init__(self, kind: str, base_url: str, api_key: str, quality_profile: str):
        self.kind = kind
        self.spec = _KIND[kind]
        self.base_url = base_url.rstrip("/")
        self.quality_profile = quality_profile
        self._client = httpx.AsyncClient(timeout=45, headers={"X-Api-Key": api_key})
        self._qp_id: int | None = None
        self._root: str | None = None

    async def _get(self, path: str, params: dict | None = None):
        try:
            r = await self._client.get(self.base_url + path, params=params or {})
        except httpx.HTTPError as e:
            raise ArrError(f"{self.kind} backend unreachable: {e}") from e
        if r.status_code != 200:
            raise ArrError(f"{self.kind} HTTP {r.status_code}")
        return r.json()

    def _shape(self, item: dict) -> dict:
        return {
            "id": str(item.get(self.spec["id_field"]) or ""),
            "type": self.kind,
            "title": item.get("title") or "",
            "year": item.get("year") or None,
            "overview": item.get("overview") or "",
            "poster": _poster(item),
            "added": bool(item.get("id")),  # id>0 => already in the library
            "votes": _votes(item),
            # Radarr's original-language title ("Cidade de Deus" for City of
            # God) — VibeReel matches queries against it. Sonarr has none.
            "original_title": orig if (orig := item.get("originalTitle")) and orig != item.get("title") else None,
        }

    def _term(self, media_id: str) -> str:
        return self.spec["term_prefix"] + media_id

    async def _lookup(self, term: str) -> list[dict]:
        raw = await self._get(self.spec["lookup"], {"term": term})
        return [s for s in (self._shape(i) for i in raw) if s["id"]]

    async def lookup(self, term: str) -> list[dict]:
        """Title search, with a fallback for a half-typed last word.

        The client searches as you type, but Sonarr's lookup matches whole
        words: "the mandal" and "better ca" return nothing useful. So for a
        multi-word query the lookup also runs without its last word, in
        parallel, and — only if the full query found no title equal to it or
        starting with it as whole words — appends those results whose title
        has a word starting like the dropped one (first 3 letters, so a typo'd
        tail still counts: "shawshank redemtion" keeps The Shawshank
        Redemption)."""
        words = term.split()
        if len(words) < 2:
            return await self._lookup(term)
        full, rest = await asyncio.gather(
            self._lookup(term), self._lookup(" ".join(words[:-1])),
            return_exceptions=True,
        )
        if isinstance(full, BaseException):
            raise full
        # A title that *is* the query, or continues it past a word boundary,
        # means the full query already worked. Without the boundary a partial
        # match would count: "the mandal" finds a show called "Mandala".
        q = _norm(term)
        if isinstance(rest, BaseException) or any(
            t == q or t.startswith(q + " ") for t in (_norm(r["title"]) for r in full)
        ):
            return full
        stem = _norm(words[-1])[:3]
        if not stem:
            return full
        seen = {r["id"] for r in full}
        extra = [
            r for r in rest
            if r["id"] not in seen and any(w.startswith(stem) for w in _norm(r["title"]).split())
        ]
        return full + extra

    async def by_imdb(self, imdb_id: str) -> dict | None:
        """The lookup-shaped title for an IMDb id (Sonarr and Radarr both take
        an `imdb:` term), or None if the arr's metadata source doesn't know it.
        Movies also carry Radarr's digital release date: a title can be months
        into its cinema run before there is anything to download."""
        matches = await self._get(self.spec["lookup"], {"term": "imdb:" + imdb_id})
        if not matches:
            return None
        obj = matches[0]
        out = self._shape(obj)
        if not out["id"]:
            return None
        if self.kind == "movie":
            out["digital_release"] = (obj.get("digitalRelease") or "")[:10] or None
        return out

    async def library_ids(self) -> set[str]:
        """The tvdb/tmdb ids of every title already in the library — one call
        (`/api/v3/series` or `/api/v3/movie`, the add route listed)."""
        items = await self._get(self.spec["add"])
        return {str(v) for it in items if (v := it.get(self.spec["id_field"]))}

    async def _quality_profile_id(self) -> int:
        if self._qp_id is None:
            profiles = await self._get("/api/v3/qualityprofile")
            match = next(
                (p for p in profiles if p["name"].lower() == self.quality_profile.lower()),
                None,
            )
            self._qp_id = match["id"] if match else profiles[0]["id"]
        return self._qp_id

    async def _root_folder(self) -> str:
        if self._root is None:
            roots = await self._get("/api/v3/rootfolder")
            if not roots:
                raise ArrError(f"{self.kind}: no root folder configured")
            self._root = roots[0]["path"]
        return self._root

    async def queue(self) -> list[dict]:
        """Every queue row, shaped for /api/activity."""
        return [self._shape_queue(r) for r in await self.queue_records()]

    async def queue_records(self) -> list[dict]:
        """Every raw queue row. The queue is paged, and a season pack is one row
        per episode, so a few packs outgrow any single page: fetch pages until
        totalRecords is covered (QUEUE_MAX_PAGES caps a runaway loop)."""
        if self.kind == "tv":
            params = {"includeSeries": "true", "includeEpisode": "true"}
        else:
            params = {"includeMovie": "true"}
        records: list[dict] = []
        for page in range(1, QUEUE_MAX_PAGES + 1):
            raw = await self._get(
                "/api/v3/queue", {**params, "page": str(page), "pageSize": str(QUEUE_PAGE_SIZE)}
            )
            rows = raw.get("records") or []
            records.extend(rows)
            if not rows or len(records) >= int(raw.get("totalRecords") or 0):
                break
        return records

    def _shape_queue(self, r: dict) -> dict:
        size = int(r.get("size") or 0)
        left = int(r.get("sizeleft") or 0)
        progress = round(1 - left / size, 4) if size else 0.0
        state = r.get("trackedDownloadState") or r.get("status") or ""
        status = {
            "downloading": "downloading",
            "queued": "queued",
            "delay": "queued",
            "importPending": "importing",
            "importing": "importing",
            "imported": "completed",
            "failedPending": "warning",
            "failed": "warning",
            "warning": "warning",
            "paused": "paused",
            "completed": "importing",
        }.get(state, "downloading")

        if self.kind == "tv":
            series = r.get("series") or {}
            ep = r.get("episode") or {}
            media = series
            title = series.get("title") or r.get("title") or ""
            sn, en = ep.get("seasonNumber"), ep.get("episodeNumber")
            episode_title = ep.get("title") or None
            subtitle = ""
            if sn is not None and en is not None:
                subtitle = f"S{sn:02d}E{en:02d}"
                if episode_title:
                    subtitle += f" · {episode_title}"
        else:
            movie = r.get("movie") or {}
            media = movie
            title = movie.get("title") or r.get("title") or ""
            subtitle = str(movie.get("year") or "")
            sn = en = episode_title = None

        return {
            "id": str(r.get("id") or ""),
            "type": self.kind,
            "title": title,
            "subtitle": subtitle,
            "status": status,
            "progress": progress,
            "size_bytes": size or None,
            "timeleft": r.get("timeleft"),
            "quality": ((r.get("quality") or {}).get("quality") or {}).get("name"),
            "download_speed": 0,
            # The arr's reason for a warning/failed/blocked-import row, or None.
            "message": _queue_message(r),
            # Structured identity/metadata so the client can merge activity into
            # its browse UI: the lookup id (tvdbId/tmdbId — the same opaque id
            # /api/lookup hands out), season/episode numbers, and the poster/year
            # Sonarr/Radarr already attached to the queue row.
            "media_id": str(media.get(self.spec["id_field"]) or "") or None,
            "season": sn,
            "episode": en,
            "episode_title": episode_title,
            "poster": _poster(media),
            "year": media.get("year") or None,
            # internal, stripped before the response: the qBittorrent hash used
            # to look up live progress/speed for this grab.
            "download_id": (r.get("downloadId") or "").upper(),
        }

    async def metadata(self, media_id: str) -> dict:
        """Full metadata for one title, keyed by the same opaque id lookup hands
        out (tvdbId/tmdbId). Sonarr/Radarr already hold everything TheTVDB/TMDB
        know the moment a title is added — overview, poster, fanart, runtime,
        genres, ratings, and (tv, once the series is in Sonarr) every episode's
        title/overview/air date plus a TVDB still via includeImages. This is
        what lets a client render a not-yet-downloaded title exactly like a
        downloaded one."""
        matches = await self._get(
            self.spec["lookup"], {"term": self._term(media_id)}
        )
        if not matches:
            raise NoSuchTitle(media_id)
        obj = matches[0]
        out = {
            "id": media_id,
            "type": self.kind,
            "title": obj.get("title") or "",
            "year": obj.get("year") or None,
            "overview": obj.get("overview") or "",
            "poster": _poster(obj),
            "fanart": _image(obj, "fanart"),
            "runtime_min": obj.get("runtime") or None,
            "genres": obj.get("genres") or [],
            "rating": _rating(obj),
            "certification": obj.get("certification") or None,
            "status": obj.get("status") or None,
            "episodes": [],
            # Radarr only: Sonarr's lookup carries neither.
            "trailer": obj.get("youTubeTrailerId") or None,
            "collection": (
                {"id": str(c["tmdbId"]), "title": c.get("title") or ""}
                if (c := obj.get("collection")) and c.get("tmdbId") else None
            ),
        }
        if self.kind == "tv" and obj.get("id"):
            # Only an *added* series has an episode list in Sonarr; a queued
            # download implies added, so this covers every pending title.
            eps = await self._get(
                "/api/v3/episode", {"seriesId": obj["id"], "includeImages": "true"}
            )
            out["episodes"] = [
                {
                    "season": e.get("seasonNumber"),
                    "episode": e.get("episodeNumber"),
                    "title": e.get("title") or "",
                    "overview": e.get("overview") or "",
                    "air_date": e.get("airDate") or None,
                    "still": _image(e, "screenshot"),
                    "has_file": bool(e.get("hasFile")),
                }
                for e in eps
            ]
        return out

    async def season_news(self) -> list[dict]:
        """New seasons of the shows already in Sonarr, for a notification feed.

        Two kinds, both "a season with no file yet":
          aired    — at least one episode has aired, the latest within
                     NEWS_AIRED_DAYS, and nothing is on disk: out there, not here
          upcoming — nothing has aired yet but the season is on TheTVDB
                     (a premiere date, or at least an episode entry)
        Season 0 (specials) never counts. A season with any file is simply in
        the library — the client's activity merge covers it from there.

        One /series call gives every season's statistics; only the series with
        an aired candidate cost a second (/episode) call, for the premiere date
        and the aired/total counts."""
        series = await self._get("/api/v3/series")
        now = datetime.now(timezone.utc)
        items: list[dict] = []
        aired: dict[int, tuple[dict, list[int]]] = {}
        for s in series:
            tvdb = s.get("tvdbId")
            if not tvdb:
                continue
            for se in s.get("seasons") or []:
                n = se.get("seasonNumber") or 0
                st = se.get("statistics") or {}
                if n <= 0 or st.get("episodeFileCount"):
                    continue
                prev, nxt = _when(st.get("previousAiring")), _when(st.get("nextAiring"))
                if prev:
                    if now - prev <= timedelta(days=NEWS_AIRED_DAYS):
                        aired.setdefault(s["id"], (s, []))[1].append(n)
                elif nxt or st.get("totalEpisodeCount"):
                    items.append(
                        self._news_item(s, n, "upcoming", premiere=nxt, aired=0,
                                        total=st.get("totalEpisodeCount") or 0,
                                        monitored=bool(se.get("monitored")))
                    )

        async def season_eps(sid: int):
            return await self._get("/api/v3/episode", {"seriesId": sid})

        eps_by_series = await asyncio.gather(*(season_eps(sid) for sid in aired))
        for (s, seasons), eps in zip(aired.values(), eps_by_series):
            mon = {se.get("seasonNumber"): bool(se.get("monitored")) for se in s.get("seasons") or []}
            for n in seasons:
                dates = [d for e in eps if e.get("seasonNumber") == n
                         if (d := _when(e.get("airDateUtc")))]
                out = [d for d in dates if d <= now]
                items.append(
                    self._news_item(s, n, "aired", premiere=min(out) if out else None,
                                    aired=len(out),
                                    total=sum(1 for e in eps if e.get("seasonNumber") == n),
                                    monitored=mon.get(n, False), last=max(out) if out else None)
                )
        return items

    def _news_item(self, s: dict, n: int, kind: str, *, premiere, aired: int, total: int,
                   monitored: bool, last=None) -> dict:
        return {
            "id": f"{s['tvdbId']}:{n}:{kind}",
            "kind": kind,
            "media_id": str(s["tvdbId"]),
            "title": s.get("title") or "",
            "year": s.get("year") or None,
            "poster": _poster(s),
            "fanart": _image(s, "fanart"),
            "season": n,
            "premiere": _iso(premiere),
            "last_aired": _iso(last),
            "episodes_aired": aired,
            "episodes_total": total,
            "monitored": monitored and bool(s.get("monitored")),
        }

    async def search_season(self, media_id: str, season: int) -> dict:
        """Get one aired season now: monitor the series, the season and its aired
        episodes (an unmonitored episode is skipped by every Sonarr search),
        then start a SeasonSearch. Only for a series Sonarr already has — the
        news feed never offers anything else."""
        series = await self._get("/api/v3/series", {"tvdbId": media_id})
        if not series:
            raise NoSuchTitle(media_id)
        s = series[0]
        if not any(se.get("seasonNumber") == season for se in s.get("seasons") or []):
            raise NoSuchTitle(f"{media_id} season {season}")

        eps = await self._get("/api/v3/episode", {"seriesId": s["id"], "seasonNumber": season})
        now = datetime.now(timezone.utc)
        out = [e for e in eps if (d := _when(e.get("airDateUtc"))) and d <= now]
        if not out:
            # A search for an unaired season finds nothing real — only fakes
            # named like it. Sonarr picks it up by itself once it airs.
            raise NotAired(f"{s.get('title')} season {season}")

        # What this changes is recorded (`_undo`, stripped from the response)
        # so POST /api/news/search can be undone exactly: undo.py restores
        # these flags and removes the grabs made after `at`.
        at = datetime.now(timezone.utc)
        series_was = bool(s.get("monitored"))
        season_was = any(
            se.get("seasonNumber") == season and se.get("monitored") for se in s["seasons"]
        )
        s["monitored"] = True
        for se in s["seasons"]:
            if se.get("seasonNumber") == season:
                se["monitored"] = True
        await self._send("PUT", f"/api/v3/series/{s['id']}", s)

        ids = [e["id"] for e in out if not e.get("monitored")]
        if ids:
            await self._send("PUT", "/api/v3/episode/monitor", {"episodeIds": ids, "monitored": True})

        cmd = await self._send("POST", "/api/v3/command",
                               {"name": "SeasonSearch", "seriesId": s["id"], "seasonNumber": season})
        return {
            "id": media_id, "season": season, "title": s.get("title") or "", "status": "searching",
            "_undo": {
                "series_id": s["id"],
                "series_was": series_was,
                "season_was": season_was,
                "flipped": ids,
                "season_episodes": [e["id"] for e in eps],
                "command_id": (cmd or {}).get("id"),
                "at": at,
            },
        }

    async def _send(self, method: str, path: str, body: dict):
        try:
            r = await self._client.request(method, self.base_url + path, json=body)
        except httpx.HTTPError as e:
            raise ArrError(f"{self.kind} {method} {path} failed: {e}") from e
        if r.status_code not in (200, 201, 202):
            raise ArrError(f"{self.kind} {method} {path} HTTP {r.status_code}: {r.text[:120]}")
        return r.json() if r.content else None

    async def add(self, media_id: str) -> dict:
        matches = await self._get(
            self.spec["lookup"], {"term": self._term(media_id)}
        )
        if not matches:
            raise NoSuchTitle(media_id)  # a bad id, not an outage: 404
        obj = matches[0]
        if obj.get("id"):  # already in the library
            raise AlreadyAdded(obj.get("title") or media_id)

        obj["qualityProfileId"] = await self._quality_profile_id()
        obj["rootFolderPath"] = await self._root_folder()
        obj["monitored"] = True
        obj["addOptions"] = dict(self.spec["add_options"])
        obj.update(self.spec["add_extra"])

        at = datetime.now(timezone.utc)
        try:
            r = await self._client.post(self.base_url + self.spec["add"], json=obj)
        except httpx.HTTPError as e:
            raise ArrError(f"{self.kind} add failed: {e}") from e
        if r.status_code in (200, 201):
            try:
                arr_id = int((r.json() or {}).get("id") or 0) or None
            except ValueError:
                arr_id = None
            # `_arr_id`/`_at` (stripped from the response) let app.py mint an
            # undo token for exactly this add.
            return {"id": media_id, "type": self.kind, "title": obj.get("title") or "", "status": "added",
                    "_arr_id": arr_id, "_at": at}
        if r.status_code == 400 and "exist" in r.text.lower():
            raise AlreadyAdded(obj.get("title") or media_id)
        raise ArrError(f"{self.kind} add HTTP {r.status_code}: {r.text[:120]}")


    # ---- undo / cancel primitives (orchestrated by undo.py) ----

    @property
    def owner_field(self) -> str:
        """The queue/history field naming the title a row belongs to."""
        return "seriesId" if self.kind == "tv" else "movieId"

    def media_id_of(self, record: dict) -> str | None:
        """The tvdb/tmdb id of a raw queue record (fetched with includeSeries /
        includeMovie)."""
        media = record.get("series" if self.kind == "tv" else "movie") or {}
        v = media.get(self.spec["id_field"])
        return str(v) if v else None

    async def _delete(self, path: str, params: dict | None = None) -> int:
        """DELETE; a 404 counts as done (already gone), anything else non-2xx
        is an ArrError. Returns the status."""
        try:
            r = await self._client.delete(self.base_url + path, params=params or {})
        except httpx.HTTPError as e:
            raise ArrError(f"{self.kind} DELETE {path} failed: {e}") from e
        if r.status_code not in (200, 202, 204, 404):
            raise ArrError(f"{self.kind} DELETE {path} HTTP {r.status_code}: {r.text[:120]}")
        return r.status_code

    async def title_by_id(self, arr_id: int) -> dict | None:
        """The series/movie by the arr's own id, or None once it is gone."""
        try:
            r = await self._client.get(f"{self.base_url}{self.spec['add']}/{arr_id}")
        except httpx.HTTPError as e:
            raise ArrError(f"{self.kind} backend unreachable: {e}") from e
        if r.status_code == 404:
            return None
        if r.status_code != 200:
            raise ArrError(f"{self.kind} HTTP {r.status_code}")
        return r.json()

    def has_files(self, obj: dict) -> bool:
        """Anything of this title on disk in the library (counted by the arr)."""
        st = obj.get("statistics") or {}
        if self.kind == "tv":
            return bool(st.get("episodeFileCount") or st.get("sizeOnDisk"))
        return bool(obj.get("hasFile") or obj.get("movieFileId") or obj.get("sizeOnDisk")
                    or st.get("movieFileCount") or st.get("sizeOnDisk"))

    async def delete_title(self, arr_id: int) -> None:
        """Remove the series/movie from the arr. deleteFiles is hard-wired off:
        this never touches a file in the library, whatever the caller checked."""
        params = {"deleteFiles": "false"}
        params["addImportListExclusion" if self.kind == "tv" else "addImportExclusion"] = "false"
        await self._delete(f"{self.spec['add']}/{arr_id}", params)

    async def remove_downloads(self, records: list[dict], *, blocklist: bool = False) -> set[str]:
        """Remove queue rows from the arr *and* the download client (partial
        data deleted). One DELETE per torrent: a season pack is one row per
        episode, and removing one row removes the torrent under all of them.
        skipRedownload: this is a cancel, not "find me another release".
        Returns the (uppercase) download ids removed."""
        done: set[str] = set()
        for r in records:
            dl = (r.get("downloadId") or "").upper()
            key = dl or f"row:{r.get('id')}"
            if key in done or r.get("id") is None:
                continue
            done.add(key)
            await self._delete(
                f"/api/v3/queue/{r['id']}",
                {"removeFromClient": "true", "blocklist": "true" if blocklist else "false",
                 "skipRedownload": "true"},
            )
        return {k for k in done if not k.startswith("row:")}

    async def grabs_since(self, since: datetime, arr_id: int,
                          episode_ids: set[int] | None = None) -> set[str]:
        """Download ids of every grab of this title since `since` (history
        'grabbed' events — written even for a grab that lands after the title
        was deleted, with the old id), optionally only for these episodes."""
        rows = await self._get(
            "/api/v3/history/since", {"date": _iso(since), "eventType": "grabbed"}
        )
        out = set()
        for h in rows or []:
            if h.get(self.owner_field) != arr_id:
                continue
            if episode_ids is not None and h.get("episodeId") not in episode_ids:
                continue
            if dl := (h.get("downloadId") or "").upper():
                out.add(dl)
        return out

    async def active_commands(self, arr_id: int) -> list[dict]:
        """Queued/running arr commands about this title (the add's refresh and
        search, a SeasonSearch) — while one runs, a grab can still land."""
        cmds = await self._get("/api/v3/command")
        out = []
        for c in cmds or []:
            if c.get("status") not in ("queued", "started"):
                continue
            b = c.get("body") or {}
            ids = [b.get("seriesId"), b.get("movieId"), *(b.get("seriesIds") or []),
                   *(b.get("movieIds") or [])]
            if arr_id in ids:
                out.append(c)
        return out

    async def cancel_command(self, cmd_id: int) -> None:
        """Cancel a command that has not started yet (the arr refuses to
        cancel a running one — best effort, never an error)."""
        try:
            await self._delete(f"/api/v3/command/{cmd_id}")
        except ArrError as e:
            log.info("%s: command %s not cancelled: %s", self.kind, cmd_id, e)

    async def set_episodes_monitored(self, episode_ids: list[int], monitored: bool) -> None:
        if episode_ids:
            await self._send("PUT", "/api/v3/episode/monitor",
                             {"episodeIds": sorted(set(episode_ids)), "monitored": monitored})

    async def set_movie_monitored(self, movie_id: int, monitored: bool) -> None:
        await self._send("PUT", "/api/v3/movie/editor",
                         {"movieIds": [movie_id], "monitored": monitored})

    async def search_title(self, arr_id: int) -> None:
        """Search the whole series / the movie now (what an add does)."""
        if self.kind == "tv":
            await self._send("POST", "/api/v3/command", {"name": "SeriesSearch", "seriesId": arr_id})
        else:
            await self._send("POST", "/api/v3/command", {"name": "MoviesSearch", "movieIds": [arr_id]})

    async def set_title_monitored(self, arr_id: int, monitored: bool) -> None:
        """The whole series/movie. An unmonitored title is skipped by RSS sync
        and by every search the arr starts itself (e.g. the one an add queues)."""
        if self.kind == "movie":
            await self.set_movie_monitored(arr_id, monitored)
            return
        s = await self.title_by_id(arr_id)
        if s is not None and bool(s.get("monitored")) != monitored:
            s["monitored"] = monitored
            await self._send("PUT", f"/api/v3/series/{arr_id}", s)

    async def restore_season_monitoring(self, series_id: int, season: int, *,
                                        series_was: bool, season_was: bool,
                                        flipped: list[int]) -> None:
        """Put back what search_season() changed — only the flags it flipped."""
        await self.set_episodes_monitored(flipped, False)
        if series_was and season_was:
            return
        s = await self.title_by_id(series_id)
        if s is None:
            return
        if not series_was:
            s["monitored"] = False
        if not season_was:
            for se in s.get("seasons") or []:
                if se.get("seasonNumber") == season:
                    se["monitored"] = False
        await self._send("PUT", f"/api/v3/series/{series_id}", s)

def _make(kind: str) -> ArrClient | None:
    prefix, default_url = _ENV[kind]
    key = os.environ.get(f"{prefix}_API_KEY")
    if not key:
        return None
    url = os.environ.get(f"{prefix}_URL", default_url)
    qp = os.environ.get(f"{prefix}_QUALITY_PROFILE", "HD-1080p")
    return ArrClient(kind, url, key, qp)


def make_arr_clients() -> dict[str, ArrClient]:
    """Map of configured clients by type; missing key => type omitted."""
    clients = {}
    for kind in _KIND:
        c = _make(kind)
        if c is not None:
            clients[kind] = c
    return clients
