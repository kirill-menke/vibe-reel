"""Charts — the VibeReel Search overlay's browse categories.

  GET /api/charts        -> the categories, each with a few poster thumbnails
  GET /api/charts/{key}  -> one category's titles, lookup-shaped, in chart order

Categories are IMDb's own rankings, from the same GraphQL API as trending.py:

  * `top-movie` / `top-tv` — the Top 250 Movies / Top 250 TV Shows charts
    (`chartTitles`, exactly what imdb.com/chart/top shows);
  * `genre-<Genre>` — the TOP_N best-rated movies and shows in a genre
    (`advancedTitleSearch` sorted by rating), with a vote floor so a title
    rated 9.6 by 800 people doesn't lead the list. Movies use IMDb's own 25k
    floor for its genre charts; shows need a higher one — at 25k the lists
    fill up with fan-voted anime and web series (measured Sep 2026).

A category's IMDb list is cached for LIST_TTL. Its titles are resolved through
Sonarr/Radarr (`imdb:` lookup) like trending — so they carry the tvdb/tmdb id,
poster and overview the client's lookup/add flow expects — and each resolution
is cached for RESOLVE_TTL, since an IMDb id's tvdb/tmdb match doesn't change.
Only `added` goes stale that way, so it is re-derived on every request from the
arr's library (ids cached LIBRARY_TTL). A title the arr's metadata source
doesn't know is left out, as on the trending rail.
"""

import asyncio
import logging
import time

import httpx

from .trending import IMDB_GRAPHQL, dedupe

log = logging.getLogger("reel_api")

TOP_N = 20
LIST_TTL = 24 * 3600
RESOLVE_TTL = 7 * 24 * 3600
LIBRARY_TTL = 60
PREVIEW = 3  # poster thumbnails per category on the index

_TITLE_TYPES = {"tv": ["tvSeries", "tvMiniSeries"], "movie": ["movie"]}
_CHART = {"movie": "TOP_RATED_MOVIES", "tv": "TOP_RATED_TV_SHOWS"}
_MIN_VOTES = {"movie": 25_000, "tv": 50_000}
_KIND_TITLE = {"movie": "Movies", "tv": "Shows"}

# IMDb genre ids (they double as display names). Kept to the ones with enough
# well-voted titles of both kinds to fill a list.
GENRES = [
    "Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary",
    "Drama", "Family", "Fantasy", "History", "Horror", "Music", "Mystery",
    "Romance", "Sci-Fi", "Sport", "Thriller", "War", "Western",
]

_FIELDS = """
  id
  titleText { text }
  releaseYear { year }
  ratingsSummary { aggregateRating voteCount }
  primaryImage { url }
"""

_CHART_QUERY = """
query Chart($chart: ChartTitleType!) {
  chartTitles(chart: { chartType: $chart }, first: 250) {
    edges { currentRank node { %s } }
  }
}
""" % _FIELDS

_GENRE_QUERY = """
query Genre($types: [String!]!, $genre: String!, $votes: Int!, $n: Int!) {
  advancedTitleSearch(
    first: $n
    constraints: {
      titleTypeConstraint: { anyTitleTypeIds: $types }
      genreConstraint: { allGenreIds: [$genre] }
      userRatingsConstraint: { ratingsCountRange: { min: $votes } }
    }
    sort: { sortBy: USER_RATING, sortOrder: DESC }
  ) {
    edges { node { title { %s } } }
  }
}
""" % _FIELDS


class ChartsError(Exception):
    """IMDb unreachable or answered with an error, and nothing cached."""


class NoSuchChart(Exception):
    pass


def _thumb(url: str | None, width: int = 200) -> str | None:
    """Amazon's image CDN resizes on request: `…@._V1_.jpg` is the ~2000px
    original, `…@._V1_QL75_UX200_.jpg` a 200px-wide JPEG of ~10 KB — cards draw them
    at most ~170px wide, and every oversized decode costs the TV GPU memory."""
    if not url or "._V1_" not in url:
        return url
    return url.split("._V1_")[0] + f"._V1_QL75_UX{width}_.jpg"


def _hit(t: dict, rank: int) -> dict:
    rs = t.get("ratingsSummary") or {}
    return {
        "imdb_id": t["id"],
        "title": (t.get("titleText") or {}).get("text") or "",
        "rating": rs.get("aggregateRating"),
        "rating_votes": rs.get("voteCount") or 0,
        "rank": rank,
        "image": (t.get("primaryImage") or {}).get("url"),
    }


def categories() -> list[dict]:
    """Every category: key, title, and which kinds' lists it is made of."""
    out = [
        {"key": "top-movie", "title": "Top 250 Movies", "kinds": ["movie"]},
        {"key": "top-tv", "title": "Top 250 Shows", "kinds": ["tv"]},
    ]
    out += [{"key": "genre-" + g, "title": g, "genre": g, "kinds": ["movie", "tv"]} for g in GENRES]
    return out


_BY_KEY = {c["key"]: c for c in categories()}


class Charts:
    def __init__(self, arr_clients: dict):
        self.arr = arr_clients
        self._client = httpx.AsyncClient(
            timeout=20, headers={"x-imdb-client-name": "imdb-web-next"}
        )
        self._imdb_sem = asyncio.Semaphore(6)
        # (key, kind) -> (fetched_at, hits); a failed refresh keeps the old list
        self._lists: dict[tuple[str, str], tuple[float, list[dict]]] = {}
        self._list_locks: dict[tuple[str, str], asyncio.Lock] = {}
        # (kind, imdb_id) -> (resolved_at, lookup-shaped dict | None)
        self._resolved: dict[tuple[str, str], tuple[float, dict | None]] = {}
        # kind -> (fetched_at, set of tvdb/tmdb ids in the library)
        self._library: dict[str, tuple[float, set[str]]] = {}

    # ---- IMDb --------------------------------------------------------------

    async def _gql(self, query: str, variables: dict) -> dict:
        async with self._imdb_sem:
            try:
                r = await self._client.post(IMDB_GRAPHQL, json={"query": query, "variables": variables})
            except httpx.HTTPError as e:
                raise ChartsError(f"imdb unreachable: {e}") from e
        if r.status_code != 200:
            raise ChartsError(f"imdb HTTP {r.status_code}")
        body = r.json()
        if body.get("errors") or not body.get("data"):
            raise ChartsError(f"imdb: {str(body.get('errors'))[:200]}")
        return body["data"]

    async def _fetch(self, cat: dict, kind: str) -> list[dict]:
        if "genre" not in cat:
            data = await self._gql(_CHART_QUERY, {"chart": _CHART[kind]})
            return [_hit(e["node"], e["currentRank"]) for e in data["chartTitles"]["edges"]]
        data = await self._gql(_GENRE_QUERY, {
            "types": _TITLE_TYPES[kind],
            "genre": cat["genre"],
            "votes": _MIN_VOTES[kind],
            "n": TOP_N,
        })
        edges = data["advancedTitleSearch"]["edges"]
        return [_hit(e["node"]["title"], i + 1) for i, e in enumerate(edges)]

    async def _list(self, cat: dict, kind: str, ttl: float = LIST_TTL) -> list[dict]:
        k = (cat["key"], kind)
        async with self._list_locks.setdefault(k, asyncio.Lock()):
            cached = self._lists.get(k)
            if cached and time.monotonic() - cached[0] < ttl:
                return cached[1]
            try:
                hits = await self._fetch(cat, kind)
            except ChartsError as e:
                if cached:
                    log.warning("charts %s/%s refresh failed, serving stale: %s", *k, e)
                    return cached[1]
                raise
            self._lists[k] = (time.monotonic(), hits)
            return hits

    # ---- Sonarr/Radarr -------------------------------------------------------

    async def _library_ids(self, kind: str) -> set[str]:
        cached = self._library.get(kind)
        if cached and time.monotonic() - cached[0] < LIBRARY_TTL:
            return cached[1]
        ids = await self.arr[kind].library_ids()
        self._library[kind] = (time.monotonic(), ids)
        return ids

    async def _resolve(self, kind: str, hits: list[dict], ttl: float = RESOLVE_TTL,
                       concurrency: int = 8) -> list[dict]:
        client = self.arr[kind]
        sem = asyncio.Semaphore(concurrency)
        now = time.monotonic()

        async def one(hit):
            k = (kind, hit["imdb_id"])
            cached = self._resolved.get(k)
            if cached and now - cached[0] < ttl:
                found = cached[1]
            else:
                async with sem:
                    try:
                        found = await client.by_imdb(hit["imdb_id"])
                    except Exception as e:  # one bad lookup costs one tile, not the list
                        log.warning("charts: %s lookup %s failed: %s", kind, hit["imdb_id"], e)
                        return None  # not cached: retried on the next request
                self._resolved[k] = (time.monotonic(), found)
            if not found:
                return None
            out = {**found, **{f: hit[f] for f in ("imdb_id", "rating", "rating_votes", "rank")}}
            out.pop("digital_release", None)
            return out

        resolved = await asyncio.gather(*(one(h) for h in hits))
        return dedupe(r for r in resolved if r)

    # ---- endpoints -----------------------------------------------------------

    def _kinds(self, cat: dict) -> list[str]:
        return [k for k in cat["kinds"] if k in self.arr]

    async def index(self, ttl: float = LIST_TTL) -> list[dict]:
        """Every category with PREVIEW poster thumbnails (IMDb's, so the index
        costs no arr lookups). A category whose lists all failed is left out
        rather than failing the whole index."""

        async def one(cat):
            kinds = self._kinds(cat)
            if not kinds:
                return None
            lists = await asyncio.gather(*(self._list(cat, k, ttl) for k in kinds), return_exceptions=True)
            ok = [l for l in lists if not isinstance(l, BaseException)]
            if not ok:
                log.warning("charts: %s unavailable: %s", cat["key"], lists[0])
                return None
            # Interleave the kinds so a genre's preview shows a movie and a show.
            posters = [
                _thumb(h["image"])
                for row in zip(*(l[:PREVIEW] for l in ok))
                for h in row
                if h.get("image")
            ][:PREVIEW]
            return {
                "key": cat["key"],
                "title": cat["title"],
                "types": kinds,
                "count": sum(len(l) for l in ok),
                "posters": posters,
            }

        out = [c for c in await asyncio.gather(*(one(c) for c in categories())) if c]
        if not out:
            raise ChartsError("no chart could be fetched")
        return out

    async def warm(self, margin: float = 0, pause: float = 0.5) -> None:
        """Pre-build every category, so nobody opening one waits for its IMDb
        list and ~40-500 arr lookups (a cold genre took ~5 s, measured).

        Run at startup and then periodically (app.py): `margin` makes the
        refresh happen *before* expiry — anything that would go stale within
        `margin` seconds is refetched now, so a request never lands on an
        expired entry. Deliberately gentle on IMDb and the arrs: one category
        at a time, two lookups in flight, a pause in between. Failures are
        only logged — the request path still fetches on demand."""
        list_ttl = max(LIST_TTL - margin, 0)
        resolve_ttl = max(RESOLVE_TTL - margin, 0)
        try:
            await self.index(list_ttl)
        except Exception as e:
            log.warning("charts: warm-up of the index failed: %s", e)
        for cat in categories():
            for kind in self._kinds(cat):
                try:
                    hits = await self._list(cat, kind, list_ttl)
                    await self._resolve(kind, hits, resolve_ttl, concurrency=2)
                except Exception as e:
                    log.warning("charts: warm-up of %s/%s failed: %s", cat["key"], kind, e)
                await asyncio.sleep(pause)

    async def get(self, key: str) -> dict:
        cat = _BY_KEY.get(key)
        if not cat or not self._kinds(cat):
            raise NoSuchChart(key)

        async def section(kind):
            hits, library = await asyncio.gather(self._list(cat, kind), self._library_ids(kind))
            results = await self._resolve(kind, hits)
            for r in results:
                r["added"] = r["id"] in library
            return {"type": kind, "title": _KIND_TITLE[kind], "results": results}

        sections = await asyncio.gather(*(section(k) for k in self._kinds(cat)))
        return {"key": key, "title": cat["title"], "sections": list(sections)}
