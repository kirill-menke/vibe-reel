"""GET /api/charts and /api/charts/{key} (charts.py): IMDb chartTitles /
advancedTitleSearch -> Sonarr/Radarr `imdb:` resolution -> dedupe, with
`added` re-derived from the arr library on every request.

IMDb is ImdbSim (tests/support/imdb.py): the genre query's own variables
(types, genre, vote floor, n) decide what it answers, so a wrong variable
shows up as a wrong result. Caches run on a FakeClock installed on charts.py.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from reel_api import charts as charts_mod
from reel_api.models import Chart, ChartIndex
from tests.support.arr import movie_obj, series_obj
from tests.support.imdb import IMG, ImdbSim, ImdbTitle


@pytest.fixture
def imdb(upstream):
    return ImdbSim(upstream)


def movie(imdb, radarr, n, *, rating=8.0, votes=100_000, genres=("Drama",), resolve=True, library=False,
          tmdb=None, image="default", **kw):
    tid = f"tt{9_300_000 + n}"
    imdb.add(ImdbTitle(tid, f"Film {n}", "movie", rating=rating, votes=votes, genres=list(genres), image=image))
    if resolve:
        obj = movie_obj(tmdb or 6000 + n, f"Film {n}", imdb=tid, **kw)
        radarr.add_movie(obj) if library else radarr.add_catalog(obj)
    return tid


def show(imdb, sonarr, n, *, rating=8.5, votes=100_000, genres=("Drama",), kind="tvSeries", resolve=True,
         library=False, image="default"):
    tid = f"tt{9_400_000 + n}"
    imdb.add(ImdbTitle(tid, f"Series {n}", kind, rating=rating, votes=votes, genres=list(genres), image=image))
    if resolve:
        obj = series_obj(8000 + n, f"Series {n}", imdb=tid)
        sonarr.add_series(obj) if library else sonarr.add_catalog(obj)
    return tid


def thumb(tid):
    return IMG.format(id=tid).split("._V1_")[0] + "._V1_QL75_UX200_.jpg"


async def get_chart(api, key, status=200):
    r = await api.get(f"/api/charts/{key}")
    assert r.status_code == status, r.text
    if status == 200:
        Chart.model_validate(r.json())
        return r.json()
    return r


async def get_index(api, status=200):
    r = await api.get("/api/charts")
    assert r.status_code == status, r.text
    if status == 200:
        ChartIndex.model_validate(r.json())
        return {c["key"]: c for c in r.json()["categories"]}
    return r


def fail_when(imdb, pred, status=500):
    """Make ImdbSim answer `status` for every request whose variables match pred."""
    real = imdb._handle

    def handle(request):
        v = json.loads(request.content).get("variables") or {}
        if pred(v):
            imdb.requests.append((v, request.headers))
            return httpx.Response(status, text="error")
        return real(request)

    imdb.route.side_effect = handle


# ---------------------------------------------------------------- categories


def test_categories_keys_and_kinds():
    cats = charts_mod.categories()
    keys = [c["key"] for c in cats]
    assert keys[:2] == ["top-movie", "top-tv"]
    assert keys[2:] == ["genre-" + g for g in charts_mod.GENRES]
    assert len(set(keys)) == len(keys)
    by = {c["key"]: c for c in cats}
    assert by["top-movie"] == {"key": "top-movie", "title": "Top 250 Movies", "kinds": ["movie"]}
    assert by["top-tv"] == {"key": "top-tv", "title": "Top 250 Shows", "kinds": ["tv"]}
    assert by["genre-Sci-Fi"] == {"key": "genre-Sci-Fi", "title": "Sci-Fi", "genre": "Sci-Fi",
                                  "kinds": ["movie", "tv"]}


@pytest.mark.parametrize("url,want", [
    (None, None),
    ("", ""),
    ("https://img.test/x.jpg", "https://img.test/x.jpg"),
    ("https://m.media-amazon.test/images/M/abc@._V1_.jpg",
     "https://m.media-amazon.test/images/M/abc@._V1_QL75_UX200_.jpg"),
    ("https://m.media-amazon.test/images/M/abc@._V1_QL50_UY400_.jpg",
     "https://m.media-amazon.test/images/M/abc@._V1_QL75_UX200_.jpg"),
])
def test_thumb_rewrite(url, want):
    assert charts_mod._thumb(url) == want


def test_thumb_width():
    assert charts_mod._thumb("https://i.test/a@._V1_.jpg", 120) == "https://i.test/a@._V1_QL75_UX120_.jpg"


# ---------------------------------------------------------------- index


async def test_index_lists_every_category_with_preview_posters(api, imdb, sonarr, radarr):
    films = [movie(imdb, radarr, n, rating=9 - n / 10, genres=("Crime",)) for n in range(1, 6)]
    shows = [show(imdb, sonarr, n, rating=9 - n / 10, genres=("Crime",)) for n in range(1, 3)]
    imdb.set_chart("TOP_RATED_MOVIES", films)
    imdb.set_chart("TOP_RATED_TV_SHOWS", shows)
    idx = await get_index(api)
    assert set(idx) == {c["key"] for c in charts_mod.categories()}
    top = idx["top-movie"]
    assert top == {"key": "top-movie", "title": "Top 250 Movies", "types": ["movie"], "count": 5,
                   "posters": [thumb(t) for t in films[:charts_mod.PREVIEW]]}
    assert idx["top-tv"]["count"] == 2 and idx["top-tv"]["types"] == ["tv"]
    # a genre interleaves its kinds: movie, show, movie
    crime = idx["genre-Crime"]
    assert crime["types"] == ["movie", "tv"] and crime["count"] == 7
    assert crime["posters"] == [thumb(films[0]), thumb(shows[0]), thumb(films[1])]
    # an empty genre is still listed (count 0, no posters)
    assert idx["genre-Western"]["count"] == 0 and idx["genre-Western"]["posters"] == []
    # the index costs no arr lookups at all
    assert radarr.count("/api/v3/movie/lookup") == 0 and sonarr.count("/api/v3/series/lookup") == 0
    # one IMDb call per (category, kind)
    assert len(imdb.requests) == 2 + 2 * len(charts_mod.GENRES)


async def test_index_skips_titles_without_an_image(api, imdb, radarr, sonarr):
    a = movie(imdb, radarr, 1, image=None)
    b = movie(imdb, radarr, 2)
    imdb.set_chart("TOP_RATED_MOVIES", [a, b])
    idx = await get_index(api)
    assert idx["top-movie"]["posters"] == [thumb(b)]


async def test_index_leaves_out_a_failing_category(api, imdb, sonarr, radarr, caplog):
    imdb.set_chart("TOP_RATED_MOVIES", [movie(imdb, radarr, 1)])
    fail_when(imdb, lambda v: v.get("chart") == "TOP_RATED_TV_SHOWS" or v.get("genre") == "War")
    idx = await get_index(api)
    assert "top-tv" not in idx and "top-movie" in idx
    # a genre with one kind failing still shows the other
    fail_when(imdb, lambda v: v.get("genre") == "Horror" and v["types"] == ["movie"])
    api.app_module.charts._lists.clear()
    idx = await get_index(api)
    assert idx["genre-Horror"]["types"] == ["movie", "tv"]  # types are the configured kinds
    assert "charts: top-tv unavailable" in caplog.text


async def test_index_with_imdb_down_and_nothing_cached_is_503(api, imdb, sonarr, radarr, caplog):
    imdb.fail(exc=httpx.ConnectError("down"), times=200)
    r = await get_index(api, status=503)
    assert r.headers["Retry-After"] == "300"
    assert r.json() == {"error": "temporarily_unavailable", "detail": "charts temporarily unavailable, retry later"}
    assert "no chart could be fetched" in caplog.text


async def test_index_without_radarr_has_only_tv(make_api, imdb, sonarr):
    imdb.set_chart("TOP_RATED_TV_SHOWS", [show(imdb, sonarr, 1)])
    async with make_api(RADARR_URL=None, RADARR_API_KEY=None) as api:
        idx = await get_index(api)
        assert "top-movie" not in idx
        assert all(c["types"] == ["tv"] for c in idx.values())
        assert all(v.get("types") != ["movie"] for v, _ in imdb.requests if "types" in v)
        await get_chart(api, "top-movie", status=404)


# ---------------------------------------------------------------- one chart


async def test_top_chart_is_lookup_shaped_in_chart_order(api, imdb, radarr):
    ids = [movie(imdb, radarr, n, rating=9.0 - n / 10, votes=1_000_000 - n) for n in range(1, 4)]
    unresolvable = movie(imdb, radarr, 9, resolve=False)
    imdb.set_chart("TOP_RATED_MOVIES", [ids[1], unresolvable, ids[0], ids[2]])
    body = await get_chart(api, "top-movie")
    assert body["key"] == "top-movie" and body["title"] == "Top 250 Movies"
    [sec] = body["sections"]
    assert sec["type"] == "movie" and sec["title"] == "Movies"
    res = sec["results"]
    # the arr can't resolve tt…09: left out; the others keep IMDb's rank
    assert [(r["imdb_id"], r["rank"]) for r in res] == [(ids[1], 1), (ids[0], 3), (ids[2], 4)]
    r = res[0]
    assert r["rating"] == 8.8 and r["rating_votes"] == 1_000_000 - 2
    assert r["id"] == "6002" and r["type"] == "movie" and r["title"] == "Film 2" and r["added"] is False
    assert "digital_release" not in r
    assert imdb.requests[0][0] == {"chart": "TOP_RATED_MOVIES"}
    assert {c.params["term"] for c in radarr.called("/api/v3/movie/lookup")} == {
        "imdb:" + t for t in (*ids, unresolvable)}


async def test_top_tv_uses_the_tv_chart(api, imdb, sonarr):
    a = show(imdb, sonarr, 1)
    imdb.set_chart("TOP_RATED_TV_SHOWS", [a])
    body = await get_chart(api, "top-tv")
    [sec] = body["sections"]
    assert sec["type"] == "tv" and sec["title"] == "Shows"
    assert [r["id"] for r in sec["results"]] == ["8001"]
    assert imdb.requests[0][0] == {"chart": "TOP_RATED_TV_SHOWS"}


async def test_genre_query_vote_floors_and_order(api, imdb, sonarr, radarr):
    # movies: 25k floor; shows: 50k floor
    m_ok = movie(imdb, radarr, 1, rating=8.0, votes=25_000, genres=("Sci-Fi",))
    m_low = movie(imdb, radarr, 2, rating=9.9, votes=24_999, genres=("Sci-Fi",))
    m_best = movie(imdb, radarr, 3, rating=8.5, votes=900_000, genres=("Sci-Fi", "Drama"))
    movie(imdb, radarr, 4, rating=9.5, genres=("Drama",))  # other genre
    s_ok = show(imdb, sonarr, 1, rating=9.0, votes=50_000, genres=("Sci-Fi",), kind="tvMiniSeries")
    show(imdb, sonarr, 2, rating=9.8, votes=49_999, genres=("Sci-Fi",))
    body = await get_chart(api, "genre-Sci-Fi")
    assert body["title"] == "Sci-Fi"
    secs = {s["type"]: s for s in body["sections"]}
    assert [s["type"] for s in body["sections"]] == ["movie", "tv"]
    assert [(r["imdb_id"], r["rank"]) for r in secs["movie"]["results"]] == [(m_best, 1), (m_ok, 2)]
    assert [r["imdb_id"] for r in secs["tv"]["results"]] == [s_ok]
    assert m_low not in {r["imdb_id"] for r in secs["movie"]["results"]}
    sent = sorted((v for v, _ in imdb.requests), key=lambda v: v["types"][0])
    assert sent == [
        {"types": ["movie"], "genre": "Sci-Fi", "votes": 25_000, "n": charts_mod.TOP_N},
        {"types": ["tvSeries", "tvMiniSeries"], "genre": "Sci-Fi", "votes": 50_000, "n": charts_mod.TOP_N},
    ]


async def test_genre_takes_top_n(api, imdb, radarr, sonarr):
    for n in range(1, charts_mod.TOP_N + 6):
        movie(imdb, radarr, n, rating=9.0 - n / 100, genres=("War",))
    body = await get_chart(api, "genre-War")
    res = body["sections"][0]["results"]
    assert len(res) == charts_mod.TOP_N
    assert [r["rank"] for r in res] == list(range(1, charts_mod.TOP_N + 1))


async def test_ids_resolving_to_one_title_are_deduped(api, imdb, radarr):
    a = movie(imdb, radarr, 1, tmdb=777)
    b = movie(imdb, radarr, 2, resolve=False)
    radarr.set_lookup("imdb:" + b, [movie_obj(777, "Film 1", imdb=b)])
    imdb.set_chart("TOP_RATED_MOVIES", [b, a])
    res = (await get_chart(api, "top-movie"))["sections"][0]["results"]
    assert [(r["imdb_id"], r["rank"]) for r in res] == [(b, 1)]


@pytest.mark.parametrize("key", ["nope", "genre-Nope", "genre-", "top-anime", "Top-movie", "genre-drama"])
async def test_unknown_key_is_404(api, key):
    r = await get_chart(api, key, status=404)
    assert r.json() == {"error": "no_such_chart", "detail": f"no chart {key}"}


async def test_a_failed_lookup_costs_one_tile_and_is_retried(api, imdb, radarr, caplog):
    a, b = movie(imdb, radarr, 1), movie(imdb, radarr, 2)
    imdb.set_chart("TOP_RATED_MOVIES", [a, b])
    radarr.set_lookup("imdb:" + a, httpx.Response(500))
    res = (await get_chart(api, "top-movie"))["sections"][0]["results"]
    assert [r["imdb_id"] for r in res] == [b]
    assert f"lookup {a} failed" in caplog.text
    del radarr.lookup_overrides["imdb:" + a]
    res = (await get_chart(api, "top-movie"))["sections"][0]["results"]
    assert [r["imdb_id"] for r in res] == [a, b]
    # b's resolution was cached, a's failure was not
    terms = [c.params["term"] for c in radarr.called("/api/v3/movie/lookup")]
    assert terms.count("imdb:" + a) == 2 and terms.count("imdb:" + b) == 1


async def test_library_failure_is_503_retry_after_30(api, imdb, radarr):
    imdb.set_chart("TOP_RATED_MOVIES", [movie(imdb, radarr, 1)])
    radarr.fail("/api/v3/movie", status=500)
    r = await get_chart(api, "top-movie", status=503)
    assert r.headers["Retry-After"] == "30"


# ---------------------------------------------------------------- added


async def test_added_comes_from_the_library_and_its_60s_cache(api, imdb, radarr, clock, monkeypatch):
    clock.install(monkeypatch, charts_mod)
    a = movie(imdb, radarr, 1, library=True)
    b = movie(imdb, radarr, 2)
    imdb.set_chart("TOP_RATED_MOVIES", [a, b])

    async def added():
        res = (await get_chart(api, "top-movie"))["sections"][0]["results"]
        return {r["imdb_id"]: r["added"] for r in res}

    assert await added() == {a: True, b: False}
    # b goes into the library behind reel-api's back: cached ids for LIBRARY_TTL
    radarr.add_movie(movie_obj(6002, "Film 2", imdb=b))
    clock.t += charts_mod.LIBRARY_TTL - 1
    assert await added() == {a: True, b: False}
    assert radarr.count("/api/v3/movie", "GET") == 1
    clock.t += 1
    assert await added() == {a: True, b: True}
    assert radarr.count("/api/v3/movie", "GET") == 2
    # the resolutions themselves were cached all along
    assert radarr.count("/api/v3/movie/lookup") == 2


async def test_an_add_through_reel_api_flips_added_at_once(api, imdb, radarr, clock, monkeypatch):
    clock.install(monkeypatch, charts_mod)
    a = movie(imdb, radarr, 1)
    imdb.set_chart("TOP_RATED_MOVIES", [a])
    res = (await get_chart(api, "top-movie"))["sections"][0]["results"]
    assert res[0]["added"] is False
    r = await api.post("/api/library", json={"id": "6001", "type": "movie"})
    assert r.status_code == 202, r.text
    res = (await get_chart(api, "top-movie"))["sections"][0]["results"]
    assert res[0]["added"] is True
    # and the undo flips it back without waiting for LIBRARY_TTL
    r = await api.delete("/api/library/movie/6001", params={"undo": r.json()["undo"]})
    assert r.status_code == 200, r.text
    res = (await get_chart(api, "top-movie"))["sections"][0]["results"]
    assert res[0]["added"] is False


# ---------------------------------------------------------------- caches and failures


async def test_list_ttl(api, imdb, radarr, clock, monkeypatch):
    clock.install(monkeypatch, charts_mod)
    a = movie(imdb, radarr, 1)
    imdb.set_chart("TOP_RATED_MOVIES", [a])
    await get_chart(api, "top-movie")
    b = movie(imdb, radarr, 2)
    imdb.set_chart("TOP_RATED_MOVIES", [b, a])
    clock.t += charts_mod.LIST_TTL - 1
    res = (await get_chart(api, "top-movie"))["sections"][0]["results"]
    assert [r["imdb_id"] for r in res] == [a] and len(imdb.requests) == 1
    clock.t += 1
    res = (await get_chart(api, "top-movie"))["sections"][0]["results"]
    assert [r["imdb_id"] for r in res] == [b, a] and len(imdb.requests) == 2


async def test_resolve_ttl(api, imdb, radarr, clock, monkeypatch):
    clock.install(monkeypatch, charts_mod)
    a = movie(imdb, radarr, 1)
    imdb.set_chart("TOP_RATED_MOVIES", [a])
    await get_chart(api, "top-movie")
    radarr.set_lookup("imdb:" + a, [movie_obj(6001, "Film 1 (Renamed)", imdb=a)])
    clock.t += charts_mod.RESOLVE_TTL - 1
    api.app_module.charts._lists.clear()  # the list may refresh; the resolution may not
    res = (await get_chart(api, "top-movie"))["sections"][0]["results"]
    assert res[0]["title"] == "Film 1" and radarr.count("/api/v3/movie/lookup") == 1
    clock.t += 1
    res = (await get_chart(api, "top-movie"))["sections"][0]["results"]
    assert res[0]["title"] == "Film 1 (Renamed)" and radarr.count("/api/v3/movie/lookup") == 2


async def test_a_title_the_arr_does_not_know_is_cached_as_unknown(api, imdb, radarr):
    a = movie(imdb, radarr, 1, resolve=False)
    imdb.set_chart("TOP_RATED_MOVIES", [a])
    assert (await get_chart(api, "top-movie"))["sections"][0]["results"] == []
    assert (await get_chart(api, "top-movie"))["sections"][0]["results"] == []
    assert radarr.count("/api/v3/movie/lookup") == 1


@pytest.mark.parametrize("fault", [
    {"status": 500}, {"status": 403}, {"exc": httpx.ReadTimeout("slow")},
    {"errors": [{"message": "boom"}]}, {"body": {"data": None}},
], ids=["500", "403", "timeout", "graphql-errors", "no-data"])
async def test_imdb_down_with_nothing_cached_is_503(api, imdb, radarr, fault, caplog):
    imdb.fail(**fault)
    r = await get_chart(api, "top-movie", status=503)
    assert r.headers["Retry-After"] == "300"
    assert r.json()["error"] == "temporarily_unavailable"
    assert "charts: imdb" in caplog.text


async def test_stale_list_is_served_when_imdb_fails(api, imdb, radarr, clock, monkeypatch, caplog):
    clock.install(monkeypatch, charts_mod)
    a = movie(imdb, radarr, 1)
    imdb.set_chart("TOP_RATED_MOVIES", [a])
    first = await get_chart(api, "top-movie")
    clock.t += charts_mod.LIST_TTL + 1
    imdb.fail(status=502)
    assert await get_chart(api, "top-movie") == first
    assert "charts top-movie/movie refresh failed, serving stale" in caplog.text
    # the stale entry keeps its old timestamp: the next request tries IMDb again
    await get_chart(api, "top-movie")
    assert len(imdb.requests) == 3


async def test_concurrent_requests_share_one_list_fetch(api, imdb, radarr):
    imdb.set_chart("TOP_RATED_MOVIES", [movie(imdb, radarr, 1)])
    tasks = [asyncio.create_task(get_chart(api, "top-movie")) for _ in range(4)]
    results = await asyncio.gather(*tasks)
    assert len(imdb.requests) == 1
    assert all(r == results[0] for r in results)


# ---------------------------------------------------------------- warm


async def test_warm_builds_every_category_gently(api, imdb, sonarr, radarr, clock, monkeypatch):
    clock.install(monkeypatch, charts_mod)
    a = movie(imdb, radarr, 1, genres=("Drama",))
    s = show(imdb, sonarr, 1, genres=("Drama",))
    imdb.set_chart("TOP_RATED_MOVIES", [a])
    imdb.set_chart("TOP_RATED_TV_SHOWS", [s])
    ch = api.app_module.charts
    await ch.warm(pause=0.25)
    # one pause per (category, kind), after each
    pairs = 2 + 2 * len(charts_mod.GENRES)
    assert clock.sleeps == [0.25] * pairs
    # the index filled every list once; the per-category pass reused them
    assert len(imdb.requests) == pairs
    assert radarr.count("/api/v3/movie/lookup") == 1 and sonarr.count("/api/v3/series/lookup") == 1
    # a request afterwards costs nothing upstream but the library ids
    await get_chart(api, "genre-Drama")
    assert len(imdb.requests) == pairs
    assert radarr.count("/api/v3/movie/lookup") == 1


async def test_warm_margin_refreshes_only_what_expires_soon(api, imdb, radarr, sonarr, clock, monkeypatch):
    clock.install(monkeypatch, charts_mod)
    a = movie(imdb, radarr, 1, genres=())
    imdb.set_chart("TOP_RATED_MOVIES", [a])
    ch = api.app_module.charts
    await ch.warm(pause=0)
    pairs = 2 + 2 * len(charts_mod.GENRES)
    assert len(imdb.requests) == pairs
    # fresh entries, small margin: nothing refetched
    clock.t += 3600
    await ch.warm(margin=3600, pause=0)
    assert len(imdb.requests) == pairs and radarr.count("/api/v3/movie/lookup") == 1
    # the lists expire within the margin, the resolutions don't
    clock.t += charts_mod.LIST_TTL - 2 * 3600
    await ch.warm(margin=3600 + 1, pause=0)
    assert len(imdb.requests) == 2 * pairs
    assert radarr.count("/api/v3/movie/lookup") == 1
    # resolutions within the margin are re-looked-up too
    await ch.warm(margin=charts_mod.RESOLVE_TTL, pause=0)
    assert radarr.count("/api/v3/movie/lookup") == 2


async def test_warm_survives_failures(api, imdb, radarr, sonarr, clock, monkeypatch, caplog):
    clock.install(monkeypatch, charts_mod)
    a = movie(imdb, radarr, 1)
    imdb.set_chart("TOP_RATED_MOVIES", [a])
    fail_when(imdb, lambda v: True)  # IMDb down for the whole pass
    ch = api.app_module.charts
    await ch.warm(pause=0)  # must not raise
    assert "warm-up of the index failed" in caplog.text
    assert "warm-up of top-movie/movie failed" in caplog.text
    assert "warm-up of genre-Western/tv failed" in caplog.text
    # every category was still attempted (index + one per pair)
    pairs = 2 + 2 * len(charts_mod.GENRES)
    assert len(imdb.requests) == 2 * pairs
    # a lookup failing mid-pass costs that title only
    imdb.route.side_effect = imdb._handle
    radarr.set_lookup("imdb:" + a, httpx.Response(500))
    await ch.warm(pause=0)
    assert (charts_mod.categories()[0]["key"], "movie") in ch._lists
    assert ("movie", a) not in ch._resolved


async def test_non_json_200_from_imdb_with_nothing_cached_is_503(make_api, imdb, radarr):
    """A 200 whose body isn't JSON (captive portal, CDN/edge error page,
    truncated body) is an IMDb failure like a 5xx: 503 + Retry-After 300
    (test_imdb_down_with_nothing_cached_is_503)."""
    imdb.route.side_effect = lambda request: httpx.Response(200, text="<html>edge error</html>")
    async with make_api(raise_app_exceptions=False) as api:
        r = await get_chart(api, "top-movie", status=503)
    assert r.headers.get("Retry-After") == "300"
    assert r.json()["error"] == "temporarily_unavailable"


async def test_stale_list_is_served_when_imdb_answers_non_json(make_api, imdb, radarr, clock, monkeypatch):
    """...and with an expired list cached, that list is served as stale, as
    for a 5xx (test_stale_list_is_served_when_imdb_fails)."""
    clock.install(monkeypatch, charts_mod)
    imdb.set_chart("TOP_RATED_MOVIES", [movie(imdb, radarr, 1)])
    async with make_api(raise_app_exceptions=False) as api:
        first = await get_chart(api, "top-movie")
        clock.t += charts_mod.LIST_TTL + 1
        imdb.route.side_effect = lambda request: httpx.Response(200, text="<html>edge error</html>")
        assert await get_chart(api, "top-movie") == first
