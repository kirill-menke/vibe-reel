"""Movie collections — "Part of the <Franchise> Collection" on a VibeReel detail page.

  GET /api/collection/{tmdb_collection_id}  -> the franchise's films, in release
                                               order, lookup-shaped

A collection is a TMDB concept (Jellyfin exposes the id as ProviderIds
`TmdbCollection`; Radarr's lookup as `collection.tmdbId`), but Radarr's own
`/api/v3/collection` only knows collections of movies it already has. So the
list comes from Radarr's metadata service — the same SkyHook Radarr itself
reads, `api.radarr.video/v1/movie/collection/{id}`, no key — whose `Parts` are
full movie records (TMDB id, year, overview, images, ratings). Each part is
shaped like an /api/lookup result (the id is its tmdb id), so a client opens
and adds it exactly like a Search result; `added` comes from Radarr's library
(the same 60 s id cache the charts use).

Collections change rarely: cached CACHE_TTL, and a failed refresh keeps
serving the last good copy.
"""

import logging
import time

import httpx

log = logging.getLogger("reel_api")

SKYHOOK = "https://api.radarr.video/v1/movie/collection/{}"
CACHE_TTL = 24 * 3600
LIBRARY_TTL = 60
CACHE_MAX = 200


class CollectionsError(Exception):
    """The metadata service could not be reached (and nothing is cached)."""


class NoSuchCollection(Exception):
    """The metadata service doesn't know that collection id."""


def _img(obj: dict, cover: str) -> str | None:
    for i in obj.get("Images") or []:
        if i.get("CoverType") == cover and (u := i.get("Url") or "").startswith("http"):
            return u
    return None


def _rating(part: dict) -> float | None:
    r = part.get("MovieRatings") or {}
    for k in ("Imdb", "Tmdb"):
        v = (r.get(k) or {}).get("Value")
        if v:
            return round(float(v), 1)
    return None


def _votes(part: dict) -> int:
    r = part.get("MovieRatings") or {}
    for k in ("Imdb", "Trakt", "Tmdb"):
        v = (r.get(k) or {}).get("Count")
        if v:
            return int(v)
    return 0


def _released(part: dict) -> str | None:
    # Primary release first: InCinema can be a festival premiere years early.
    for k in ("Premier", "InCinema", "DigitalRelease", "PhysicalRelease"):
        if d := (part.get(k) or "")[:10]:
            return d
    return None


def shape(raw: dict) -> dict:
    parts = []
    for p in raw.get("Parts") or []:
        if not p.get("TmdbId"):
            continue
        title = p.get("Title") or ""
        orig = p.get("OriginalTitle")
        parts.append({
            "id": str(p["TmdbId"]),
            "type": "movie",
            "title": title,
            "year": p.get("Year") or None,
            "overview": p.get("Overview") or "",
            "poster": _img(p, "Poster"),
            "added": False,
            "votes": _votes(p),
            "original_title": orig if orig and orig != title else None,
            "rating": _rating(p),
            "released": _released(p),
        })
    # Release order; announced films without a date go last, by year.
    parts.sort(key=lambda m: (m["released"] is None, m["released"] or "", m["year"] or 9999))
    return {
        "id": str(raw.get("TmdbId") or ""),
        "title": raw.get("Name") or "",
        "overview": raw.get("Overview") or "",
        "poster": _img(raw, "Poster"),
        "fanart": _img(raw, "Fanart"),
        "movies": parts,
    }


class Collections:
    def __init__(self, radarr):
        self.radarr = radarr  # ArrClient("movie"), for `added`
        self._http = httpx.AsyncClient(timeout=20, headers={"User-Agent": "reel-api"})
        self._cache: dict[str, tuple[float, dict]] = {}
        self._library: tuple[float, set[str]] | None = None

    def forget_library(self) -> None:
        self._library = None

    async def _library_ids(self) -> set[str]:
        if self._library and time.monotonic() - self._library[0] < LIBRARY_TTL:
            return self._library[1]
        ids = await self.radarr.library_ids()
        self._library = (time.monotonic(), ids)
        return ids

    async def _fetch(self, cid: str) -> dict:
        hit = self._cache.get(cid)
        if hit and time.monotonic() - hit[0] < CACHE_TTL:
            return hit[1]
        try:
            r = await self._http.get(SKYHOOK.format(cid))
        except httpx.HTTPError as e:
            if hit:
                log.warning("collection %s refresh failed, serving stale: %s", cid, e)
                return hit[1]
            raise CollectionsError(f"metadata service unreachable: {e}") from e
        if r.status_code == 404:
            raise NoSuchCollection(cid)
        if r.status_code != 200:
            if hit:
                return hit[1]
            raise CollectionsError(f"metadata service HTTP {r.status_code}")
        data = shape(r.json())
        self._cache[cid] = (time.monotonic(), data)
        if len(self._cache) > CACHE_MAX:
            del self._cache[min(self._cache, key=lambda k: self._cache[k][0])]
        return data

    async def get(self, cid: str) -> dict:
        data = await self._fetch(cid)
        try:
            library = await self._library_ids()
        except Exception as e:  # `added` is a nicety; the list still stands
            log.warning("collection %s: radarr library unavailable: %s", cid, e)
            library = set()
        return {**data, "movies": [{**m, "added": m["id"] in library} for m in data["movies"]]}
