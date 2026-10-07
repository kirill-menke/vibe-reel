"""The recorded IMDb answers (tests/recorded/imdb/, git-ignored; recorded by
tests/fetch_fixtures.py through tests/specs/record_upstreams.py) and what the
product must make of them.

The recordings are re-made from live IMDb data, so the replay tests can't
hard-code titles or ratings. Instead the expectations are computed from the
recording itself by an oracle written from trending.py's *documented* rules
(out 4 weeks..183 days, top 1000 by popularity, a movie by its primary
release date, a show by its first episode) with its own numbers, not the
module's constants — a changed constant or rule still fails the replay.

`COVERAGE` names the cases a recording must contain for the replay to prove
anything (a title cut by rank, a movie whose premiere precedes its primary
release, ...). The recorder keeps an edge for each (`missing()` on the full
answer picks them) and the tests fail on a recording without them.
"""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

from tests.support.fetched import require

REC = Path(__file__).resolve().parent.parent / "recorded" / "imdb"
NAMES = ("trending-tv", "trending-movie", "chart-top-movie", "chart-top-tv", "genre-scifi-movie",
         "genre-scifi-tv", "error-unknown-field", "error-no-client-name")

MIN_AGE = dt.timedelta(weeks=4)
MAX_AGE = dt.timedelta(days=183)
MAX_RANK = 1000

CUT_BY_RANK = "a title in the date window but ranked below the top 1000 (cut)"
MOVIE_PRIMARY = "a movie hit whose earliest release (a premiere) precedes its primary release date"
SHOW_FIRST = "a show hit whose first episode date is not its releaseDate"
COVERAGE = {"movie": (CUT_BY_RANK, MOVIE_PRIMARY), "tv": (SHOW_FIRST,)}
MIN_HITS = 3


def rec(name: str) -> dict:
    """A recording, or the test fails (never skips) with the fetch command."""
    return json.loads(require(REC / f"{name}.json").read_text())


def _day(d: dict | None) -> dt.date | None:
    if not d or not all(d.get(k) for k in ("year", "month", "day")):
        return None
    try:
        return dt.date(d["year"], d["month"], d["day"])
    except ValueError:
        return None


def _earliest(title: dict) -> dt.date | None:
    days = [_day(e["node"]) for e in (title.get("releaseDates") or {}).get("edges", [])]
    return min((d for d in days if d), default=None)


def _released(kind: str, title: dict) -> dt.date | None:
    return _day(title.get("releaseDate")) if kind == "movie" else _earliest(title)


def _in_window(day: dt.date | None, today: dt.date) -> bool:
    return day is not None and today - MAX_AGE <= day <= today - MIN_AGE


def _rank(title: dict) -> int | None:
    return (title.get("meterRanking") or {}).get("currentRank")


def trending_expected(kind: str, body: dict, today: dt.date) -> list[dict]:
    """The hits Trending._imdb must return for this answer, in its order."""
    out = []
    for edge in body["data"]["advancedTitleSearch"]["edges"]:
        t = edge["node"]["title"]
        rank, released = _rank(t), _released(kind, t)
        if rank and rank <= MAX_RANK and _in_window(released, today):
            rs = t.get("ratingsSummary") or {}
            out.append({"imdb_id": t["id"], "rating": rs.get("aggregateRating"),
                        "rating_votes": rs.get("voteCount") or 0, "rank": rank,
                        "released": released.isoformat()})
    return out


def edge_cases(kind: str, edge: dict, today: dt.date) -> set[str]:
    """Which COVERAGE cases this one edge exercises."""
    t = edge["node"]["title"]
    rank, released = _rank(t), _released(kind, t)
    hit = bool(rank) and rank <= MAX_RANK and _in_window(released, today)
    out = set()
    if rank and rank > MAX_RANK and _in_window(released, today):
        out.add(CUT_BY_RANK)
    if kind == "movie" and hit and (_earliest(t) or released) < released:
        out.add(MOVIE_PRIMARY)
    if kind == "tv" and hit and _day(t.get("releaseDate")) != released:
        out.add(SHOW_FIRST)
    return out


def missing(kind: str, body: dict, today: dt.date) -> list[str]:
    """COVERAGE cases (and the minimum number of hits) this answer lacks."""
    edges = body["data"]["advancedTitleSearch"]["edges"]
    have = set().union(*(edge_cases(kind, e, today) for e in edges))
    out = [c for c in COVERAGE[kind] if c not in have]
    if len(trending_expected(kind, body, today)) < MIN_HITS:
        out.append(f"at least {MIN_HITS} hits")
    return out
