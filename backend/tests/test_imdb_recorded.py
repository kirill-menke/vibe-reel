"""IMDb GraphQL: the fake (tests/support/imdb.py) against recorded real answers.

tests/recorded/imdb/*.json are real answers to exactly the requests
trending.py and charts.py send (tests/specs/record_upstreams.py, trimmed to a
few titles). IMDb's data, so git-ignored and fetched by tests/fetch_fixtures.py;
a test that reads one fails without it (never skips). Each fetch records
today's answers, so nothing here hard-codes a title or a rating: the
expectations come from the recording (tests/support/imdb_recorded.py).
Three kinds of checks:

  * the product still sends what was recorded (query, variables, header) —
    otherwise the recording proves nothing and has to be re-recorded;
  * the fake, given the recorded titles, answers the product's request with
    the recorded body byte for byte (data: keys, nesting, order, JSON types),
    and answers the recorded mistakes the way IMDb did;
  * the recorded answers replayed raw through the product's parsing give the
    expected hits (no fake involved).

Plus the GraphQL mechanics the fake now honours: only the selection set,
aliases, fragments, variables.
"""

from __future__ import annotations

import datetime as dt
import json

import httpx
import pytest

from reel_api import charts as charts_mod
from reel_api import trending as trending_mod
from tests.support import imdb_recorded as ir
from tests.support.fetched import FETCH
from tests.support.imdb import URL, ImdbSim, ImdbTitle
from tests.support.imdb_recorded import rec

RERECORD = f"re-record: {FETCH} --refresh imdb"


# name -> (how the product makes this request, the recorded root field)
CASES = {
    "trending-tv": ("trending", "tv", None),
    "trending-movie": ("trending", "movie", None),
    "chart-top-movie": ("charts", "movie", "top-movie"),
    "chart-top-tv": ("charts", "tv", "top-tv"),
    "genre-scifi-movie": ("charts", "movie", "genre-Sci-Fi"),
    "genre-scifi-tv": ("charts", "tv", "genre-Sci-Fi"),
}


async def product_call(name: str):
    """Run the product's IMDb call for a recording, as of the day it was recorded."""
    how, kind, key = CASES[name]
    if how == "trending":
        t = trending_mod.Trending({})
        try:
            return await t._imdb(kind, dt.date.fromisoformat(rec(name)["recorded"]))
        finally:
            await t._client.aclose()
    c = charts_mod.Charts({})
    try:
        return await c._fetch(charts_mod._BY_KEY[key], kind)
    finally:
        await c._client.aclose()


def sim_from_recording(upstream, name: str) -> ImdbSim:
    """An ImdbSim holding exactly the recorded titles (chart order, types, genre)."""
    r = rec(name)
    sim = ImdbSim(upstream)
    v = r["variables"]
    (root,) = r["body"]["data"].values()
    if "chart" in v:
        nodes = [e["node"] for e in root["edges"]]
        sim.add(*(ImdbTitle.from_node(n) for n in nodes))
        sim.set_chart(v["chart"], [n["id"] for n in nodes])
    else:
        genres = [v["genre"]] if "genre" in v else []
        sim.add(*(ImdbTitle.from_node(e["node"]["title"], type=v["types"][0], genres=genres)
                  for e in root["edges"]))
    return sim


# ---------------------------------------------------------------- the request is still the recorded one


@pytest.mark.parametrize("name", CASES)
async def test_product_sends_the_recorded_request(upstream, name):
    sent = []

    def capture(request: httpx.Request) -> httpx.Response:
        sent.append((json.loads(request.content), request.headers))
        return httpx.Response(200, json=rec(name)["body"])

    upstream.post(URL).mock(side_effect=capture)
    await product_call(name)
    [(payload, headers)] = sent
    r = rec(name)
    assert payload == {"query": r["query"], "variables": r["variables"]}, RERECORD
    for k, v in r["headers"].items():
        assert headers.get(k) == v, RERECORD


# ---------------------------------------------------------------- the fake answers like IMDb


@pytest.mark.parametrize("name", CASES)
async def test_fake_answers_the_recorded_body(upstream, name):
    sim = sim_from_recording(upstream, name)
    answers = []
    real = sim._handle

    def keep(request):
        resp = real(request)
        answers.append(resp)
        return resp

    sim.route.side_effect = keep
    await product_call(name)
    [resp] = answers
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"] == rec(name)["body"]["data"]
    # and as text: IMDb writes 8, not 8.0
    assert json.dumps(resp.json()["data"]) == json.dumps(rec(name)["body"]["data"])


async def test_fake_rejects_an_unknown_field_like_imdb(upstream):
    r = rec("error-unknown-field")
    sim = ImdbSim(upstream)
    async with httpx.AsyncClient(headers={"x-imdb-client-name": "imdb-web-next"}) as h:
        resp = await h.post(URL, json={"query": r["query"], "variables": r["variables"]})
    assert resp.status_code == r["status"] == 400
    [got], [want] = resp.json()["errors"], r["body"]["errors"]
    assert got["message"] == want["message"] == 'Cannot query field "noSuchField" on type "Title".'
    assert {k: got["extensions"][k] for k in ("code", "errorType")} == \
        {k: want["extensions"][k] for k in ("code", "errorType")}
    assert "data" not in resp.json() and "data" not in r["body"]
    assert sim.errors == [want["message"]]


async def test_fake_forbids_a_request_without_client_name_like_imdb(upstream):
    r = rec("error-no-client-name")
    ImdbSim(upstream)
    async with httpx.AsyncClient() as h:
        resp = await h.post(URL, json={"query": charts_mod._CHART_QUERY,
                                       "variables": {"chart": "TOP_RATED_MOVIES"}})
    assert (resp.status_code, resp.headers["content-type"], resp.text) == \
        (r["status"], r["content_type"], r["body"])


# ---------------------------------------------------------------- recorded answers through the real parsing


@pytest.fixture
def replay(upstream):
    def go(name):
        upstream.post(URL).respond(200, json=rec(name)["body"])
        return product_call(name)
    return go


def test_every_recording_is_fetched():
    for name in ir.NAMES:
        rec(name)


@pytest.mark.parametrize("kind", ["tv", "movie"])
async def test_trending_parses_the_real_answer(replay, kind):
    r = rec(f"trending-{kind}")
    today = dt.date.fromisoformat(r["recorded"])
    assert not ir.missing(kind, r["body"], today), RERECORD
    hits = await replay(f"trending-{kind}")
    # in the top 1000 and out 4 weeks..183 days before the recording, in IMDb's popularity order
    assert hits == ir.trending_expected(kind, r["body"], today)
    assert [h["rank"] for h in hits] == sorted(h["rank"] for h in hits)
    assert all(isinstance(h["rating"], (int, float)) and h["rating_votes"] >= 10_000 for h in hits)


async def test_trending_movie_cuts_by_rank_and_dates_by_primary_release(replay):
    r = rec("trending-movie")
    today = dt.date.fromisoformat(r["recorded"])
    edges = r["body"]["data"]["advancedTitleSearch"]["edges"]
    hits = {h["imdb_id"]: h for h in await replay("trending-movie")}
    # well rated, in the window, but not in the top 1000 (a vote campaign, not an audience): cut
    cut = [e["node"]["title"]["id"] for e in edges if ir.CUT_BY_RANK in ir.edge_cases("movie", e, today)]
    assert cut and not set(cut) & set(hits), RERECORD
    # a premiere before the primary release: the primary date is the one that counts
    early = [e["node"]["title"] for e in edges if ir.MOVIE_PRIMARY in ir.edge_cases("movie", e, today)]
    assert early, RERECORD
    for t in early:
        d = t["releaseDate"]
        assert hits[t["id"]]["released"] == dt.date(d["year"], d["month"], d["day"]).isoformat()


async def test_trending_tv_dates_a_show_by_its_first_episode(replay):
    r = rec("trending-tv")
    today = dt.date.fromisoformat(r["recorded"])
    edges = r["body"]["data"]["advancedTitleSearch"]["edges"]
    hits = {h["imdb_id"]: h for h in await replay("trending-tv")}
    shows = [e["node"]["title"] for e in edges if ir.SHOW_FIRST in ir.edge_cases("tv", e, today)]
    assert shows, RERECORD
    for t in shows:
        first = min(dt.date(n["year"], n["month"], n["day"]) for n in
                    (x["node"] for x in t["releaseDates"]["edges"]) if n["year"] and n["month"] and n["day"])
        assert hits[t["id"]]["released"] == first.isoformat()


def chart_expected(edges, ranks) -> list[dict]:
    return [{"imdb_id": n["id"], "title": n["titleText"]["text"], "rating": n["ratingsSummary"]["aggregateRating"],
             "rating_votes": n["ratingsSummary"]["voteCount"], "rank": rank, "image": n["primaryImage"]["url"]}
            for n, rank in zip(edges, ranks)]


@pytest.mark.parametrize("kind", ["movie", "tv"])
async def test_chart_parses_the_real_answer(replay, kind):
    edges = rec(f"chart-top-{kind}")["body"]["data"]["chartTitles"]["edges"]
    hits = await replay(f"chart-top-{kind}")
    assert [h["rank"] for h in hits] == list(range(1, 13))
    assert hits == chart_expected([e["node"] for e in edges], [e["currentRank"] for e in edges])
    assert all(h["title"] and h["rating"] and h["rating_votes"] > 0 for h in hits)
    for h in hits:  # real poster URLs take the resize suffix
        thumb = charts_mod._thumb(h["image"])
        assert h["image"].endswith("._V1_.jpg") and thumb.endswith("._V1_QL75_UX200_.jpg"), h


@pytest.mark.parametrize("kind,votes", [("movie", 25_000), ("tv", 50_000)])
async def test_genre_parses_the_real_answer(replay, kind, votes):
    edges = rec(f"genre-scifi-{kind}")["body"]["data"]["advancedTitleSearch"]["edges"]
    hits = await replay(f"genre-scifi-{kind}")
    assert [h["rank"] for h in hits] == list(range(1, 9))  # numbered by position: the answer has no rank
    assert hits == chart_expected([e["node"]["title"] for e in edges], range(1, 9))
    assert all(h["rating_votes"] >= votes for h in hits)
    assert [h["rating"] for h in hits] == sorted((h["rating"] for h in hits), reverse=True)


# ---------------------------------------------------------------- GraphQL mechanics


async def gql(upstream_sim, query, variables=None, headers=True):
    async with httpx.AsyncClient(headers={"x-imdb-client-name": "t"} if headers else {}) as h:
        return await h.post(URL, json={"query": query, "variables": variables or {}})


@pytest.fixture
def chart_sim(upstream):
    sim = ImdbSim(upstream)
    sim.add(ImdbTitle("tt1", "One", year=1999, rating=8.0, votes=10, rank=None, image=None),
            ImdbTitle("tt2", "Two", year=2001, rating=7.25, votes=20, rank=5))
    sim.set_chart("TOP_RATED_MOVIES", ["tt1", "tt2"])
    return sim


async def test_only_the_selection_set_is_answered(chart_sim):
    r = await gql(chart_sim, "{ chartTitles(chart: {chartType: TOP_RATED_MOVIES}, first: 5) "
                             "{ edges { node { id titleText { text } } } } }")
    assert r.status_code == 200
    assert r.json()["data"] == {"chartTitles": {"edges": [
        {"node": {"id": "tt1", "titleText": {"text": "One"}}},
        {"node": {"id": "tt2", "titleText": {"text": "Two"}}}]}}


async def test_a_query_without_ratings_gets_no_ratings(upstream):
    """The point of the projection: drop `ratingsSummary` from charts.py's
    selection and the product sees no rating at all (rating None, 0 votes)."""
    sim = ImdbSim(upstream)
    sim.add(ImdbTitle("tt7", "Seven", rating=9.0, votes=99))
    sim.set_chart("TOP_RATED_MOVIES", ["tt7"])
    q = charts_mod._CHART_QUERY.replace("ratingsSummary { aggregateRating voteCount }", "")
    assert q != charts_mod._CHART_QUERY
    r = await gql(sim, q, {"chart": "TOP_RATED_MOVIES"})
    node = r.json()["data"]["chartTitles"]["edges"][0]["node"]
    assert "ratingsSummary" not in node
    assert charts_mod._hit(node, 1)["rating"] is None


async def test_aliases_fragments_and_first(chart_sim):
    q = """
    query Q($c: ChartTitleType!) {
      top: chartTitles(chart: {chartType: $c}, first: 1) { edges { rank: currentRank node { ...T } } }
      all: chartTitles(chart: {chartType: $c}, first: 9) { edges { node { ... on Title { tid: id } } } }
    }
    fragment T on Title { id ratingsSummary { r: aggregateRating } meterRanking { currentRank } }
    """
    r = await gql(chart_sim, q, {"c": "TOP_RATED_MOVIES"})
    assert r.status_code == 200, r.text
    assert r.json()["data"] == {
        "top": {"edges": [{"rank": 1, "node": {"id": "tt1", "ratingsSummary": {"r": 8},
                                                "meterRanking": None}}]},
        "all": {"edges": [{"node": {"tid": "tt1"}}, {"node": {"tid": "tt2"}}]},
    }


@pytest.mark.parametrize("query,variables,message", [
    ("{ chartTitles(chart: {chartType: TOP_RATED_MOVIES}, first: 1) { edges { node { id genres } } } }", {},
     'Cannot query field "genres" on type "Title".'),
    ("{ chartTitles(chart: {chartType: TOP_RATED_MOVIES}, first: 1, limit: 3) { edges { currentRank } } }", {},
     'Unknown argument "limit" on field "Query.chartTitles".'),
    ("{ chartTitles(chart: {chartType: TOP_RATED_MOVIES}, first: 1) { edges { node { titleText } } } }", {},
     'Field "titleText" of type "TitleText" must have a selection of subfields. Did you mean "titleText { ... }"?'),
    ("{ chartTitles(chart: {chartType: TOP_RATED_MOVIES}, first: 1) { edges { node { id { x } } } } }", {},
     'Field "id" must not have a selection since type "ID!" has no subfields.'),
    ("query Q($c: ChartTitleType!) { chartTitles(chart: {chartType: $c}, first: 1) { edges { currentRank } } }",
     {}, 'Variable "$c" of required type "ChartTitleType!" was not provided.'),
    ("query Q($c: ChartTitleType!, $n: Int) { chartTitles(chart: {chartType: $c}, first: 1) "
     "{ edges { currentRank } } }", {"c": "TOP_RATED_MOVIES"}, 'Variable "$n" is never used in operation "Q".'),
    ("query Q { chartTitles(chart: {chartType: $c}, first: 1) { edges { currentRank } } }", {},
     'Variable "$c" is not defined by operation "Q".'),
    ("query Q($c: String!) { chartTitles(chart: {chartType: $c}, first: 1) { edges { currentRank } } }",
     {"c": "TOP_RATED_MOVIES"},
     'Variable "$c" of type "String!" used in position expecting type "ChartTitleType!".'),
    ("query Q($c: ChartTitleType!) { chartTitles(chart: {chartType: $c}, first: 1) { edges { currentRank } } }",
     {"c": "TOP_250"}, 'Expected type "ChartTitleType" at variable "$c", found "TOP_250".'),
    ("query Q($n: Int!) { chartTitles(chart: {chartType: TOP_RATED_MOVIES}, first: $n) { edges { currentRank } } }",
     {"n": "20"}, 'Expected type "Int" at variable "$n", found "20".'),
])
async def test_invalid_requests_are_400_like_imdb(chart_sim, query, variables, message):
    r = await gql(chart_sim, query, variables)
    assert r.status_code == 400
    assert [e["message"] for e in r.json()["errors"]] == [message]


async def test_syntax_error_is_400(chart_sim):
    r = await gql(chart_sim, "{ chartTitles(chart: {chartType: TOP_RATED_MOVIES} { id }")
    assert r.status_code == 400 and r.json()["errors"][0]["extensions"]["code"] == "GRAPHQL_PARSE_FAILED"


async def test_unmodelled_input_fails_the_test_loudly(chart_sim):
    q = ("{ advancedTitleSearch(first: 5, constraints: {genreConstraint: {anyGenreIds: [\"Drama\"]}}, "
         "sort: {sortBy: USER_RATING, sortOrder: DESC}) { edges { node { title { id } } } } }")
    with pytest.raises(AssertionError, match="not modelled"):
        chart_sim.execute(q, {})


async def test_releasedates_first_slices(upstream):
    sim = ImdbSim(upstream)
    sim.add(ImdbTitle("tt9", "Nine", "tvSeries", rank=1,
                      releases=[dt.date(2026, 5, 1), dt.date(2026, 5, 2), (2026, 6)]))
    q = """{ advancedTitleSearch(first: 3, constraints: {titleTypeConstraint: {anyTitleTypeIds: ["tvSeries"]}},
             sort: {sortBy: POPULARITY, sortOrder: ASC}) {
             edges { node { title { releaseDates(first: 2) { edges { node { year month day } } } } } } } }"""
    r = await gql(sim, q)
    dates = r.json()["data"]["advancedTitleSearch"]["edges"][0]["node"]["title"]["releaseDates"]["edges"]
    assert dates == [{"node": {"year": 2026, "month": 5, "day": 1}}, {"node": {"year": 2026, "month": 5, "day": 2}}]
