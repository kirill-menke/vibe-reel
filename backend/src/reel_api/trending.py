"""Trending — the VibeReel Home rails' "new and proven good" titles.

  GET /api/trending?type=tv|movie  -> lookup-shaped results, most popular first

The source is IMDb itself: the GraphQL API behind imdb.com (no key; it only
wants an `x-imdb-client-name` header — without it the edge answers 403).
One `advancedTitleSearch` per type does the heavy filtering server-side and
sorts by IMDb popularity (the MOVIEmeter/TVmeter rank, i.e. page views — the
"trending" part). A title qualifies when

  * it has been out for at least MIN_AGE and at most MAX_AGE — for a movie by
    IMDb's primary release date (not a festival premiere), for a show by the
    premiere of its first episode (the earliest of its release dates);
  * IMDb rates it >= MIN_RATING from >= MIN_VOTES votes;
  * it is in IMDb's top MAX_RANK by popularity right now. The vote floor alone
    does not keep out titles whose votes come from a campaign rather than an
    audience (measured Sep 2026: 8.8 from 106k votes at rank ~1900); being
    widely looked at too does.

Each IMDb id is then resolved through Sonarr/Radarr (`imdb:` lookup term), so
a result carries the same opaque id (tvdb/tmdb), poster and `added` flag as
/api/lookup, and the client's lookup/add/metadata flow works on it unchanged.
Results are cached for CACHE_TTL; a failed refresh keeps serving the last good
list.
"""

import asyncio
import datetime as dt
import logging
import time

import httpx

log = logging.getLogger("reel_api")

IMDB_GRAPHQL = "https://caching.graphql.imdb.com/"
MIN_RATING = 7.5
MIN_VOTES = 10_000
MAX_RANK = 1000
MIN_AGE = dt.timedelta(weeks=4)
MAX_AGE = dt.timedelta(days=183)  # ~6 months
LIMIT = 20
CACHE_TTL = 6 * 3600

_TITLE_TYPES = {"tv": ["tvSeries", "tvMiniSeries"], "movie": ["movie"]}

# The release-date constraint matches a title with *any* release date in the
# range, so it is a superset of what we want; _released() narrows it down.
_QUERY = """
query Trending($types: [String!]!, $start: Date!, $end: Date!, $rating: Float!, $votes: Int!) {
  advancedTitleSearch(
    first: 100
    constraints: {
      titleTypeConstraint: { anyTitleTypeIds: $types }
      releaseDateConstraint: { releaseDateRange: { start: $start, end: $end } }
      userRatingsConstraint: {
        aggregateRatingRange: { min: $rating }
        ratingsCountRange: { min: $votes }
      }
    }
    sort: { sortBy: POPULARITY, sortOrder: ASC }
  ) {
    edges { node { title {
      id
      releaseDate { year month day }
      releaseDates(first: 250) { edges { node { year month day } } }
      ratingsSummary { aggregateRating voteCount }
      meterRanking { currentRank }
    } } }
  }
}
"""


def dedupe(results) -> list[dict]:
    """Drop results that resolve to a (type, id) already seen, keeping the
    first — i.e. the best-ranked — occurrence. Distinct IMDb ids can map to one
    tvdb/tmdb title (a miniseries listed twice, a re-release), and a client
    keys its tiles by that id."""
    seen: set[tuple[str, str]] = set()
    out = []
    for r in results:
        k = (r.get("type"), r.get("id"))
        if k not in seen:
            seen.add(k)
            out.append(r)
    return out


class TrendingError(Exception):
    """IMDb unreachable or answered with an error, and nothing cached."""


def _date(d: dict | None) -> dt.date | None:
    if not d or not (d.get("year") and d.get("month") and d.get("day")):
        return None  # year- or month-only dates can't be placed in the window
    try:
        return dt.date(d["year"], d["month"], d["day"])
    except ValueError:
        return None


def _released(kind: str, title: dict) -> dt.date | None:
    if kind == "movie":
        return _date(title.get("releaseDate"))
    dates = [_date(e["node"]) for e in (title.get("releaseDates") or {}).get("edges", [])]
    return min((d for d in dates if d), default=None)


class Trending:
    def __init__(self, arr_clients: dict):
        self.arr = arr_clients
        self._client = httpx.AsyncClient(
            timeout=20, headers={"x-imdb-client-name": "imdb-web-next"}
        )
        self._cache: dict[str, tuple[float, list[dict]]] = {}
        self._locks = {k: asyncio.Lock() for k in _TITLE_TYPES}

    async def _imdb(self, kind: str, today: dt.date) -> list[dict]:
        variables = {
            "types": _TITLE_TYPES[kind],
            "start": (today - MAX_AGE).isoformat(),
            "end": (today - MIN_AGE).isoformat(),
            "rating": MIN_RATING,
            "votes": MIN_VOTES,
        }
        try:
            r = await self._client.post(IMDB_GRAPHQL, json={"query": _QUERY, "variables": variables})
        except httpx.HTTPError as e:
            raise TrendingError(f"imdb unreachable: {e}") from e
        if r.status_code != 200:
            raise TrendingError(f"imdb HTTP {r.status_code}")
        body = r.json()
        if body.get("errors") or not body.get("data"):
            raise TrendingError(f"imdb: {str(body.get('errors'))[:200]}")

        out = []
        for edge in body["data"]["advancedTitleSearch"]["edges"]:
            t = edge["node"]["title"]
            rank = (t.get("meterRanking") or {}).get("currentRank")
            released = _released(kind, t)
            if not rank or rank > MAX_RANK or not released:
                continue
            if not (today - MAX_AGE <= released <= today - MIN_AGE):
                continue
            rs = t.get("ratingsSummary") or {}
            out.append({
                "imdb_id": t["id"],
                "rating": rs.get("aggregateRating"),
                "rating_votes": rs.get("voteCount") or 0,
                "rank": rank,
                "released": released.isoformat(),
            })
        return out

    async def _resolve(self, kind: str, hits: list[dict]) -> tuple[list[dict], bool]:
        """(results, complete) — complete is False when a lookup errored, so the
        caller doesn't cache a list with holes for hours."""
        client = self.arr[kind]
        sem = asyncio.Semaphore(4)
        failed = False

        async def one(hit):
            nonlocal failed
            async with sem:
                try:
                    found = await client.by_imdb(hit["imdb_id"])
                except Exception as e:  # one bad lookup costs one tile, not the rail
                    failed = True
                    log.warning("trending: %s lookup %s failed: %s", kind, hit["imdb_id"], e)
                    return None
            return {**found, **hit} if found else None

        resolved = await asyncio.gather(*(one(h) for h in hits))
        return dedupe(r for r in resolved if r), not failed

    async def get(self, kind: str, ttl: float = CACHE_TTL) -> list[dict]:
        """`ttl` below CACHE_TTL lets the background warm-up (app.py) refresh
        a list before it expires, so a request never pays for the refetch."""
        async with self._locks[kind]:  # one refresh at a time; the rest wait for it
            cached = self._cache.get(kind)
            if cached and time.monotonic() - cached[0] < ttl:
                return cached[1]
            try:
                hits = await self._imdb(kind, dt.date.today())
                results, complete = await self._resolve(kind, hits[:LIMIT])
            except TrendingError as e:
                if cached:
                    log.warning("trending %s refresh failed, serving stale: %s", kind, e)
                    return cached[1]
                raise
            if complete:
                self._cache[kind] = (time.monotonic(), results)
            elif cached:
                return cached[1]
            return results
