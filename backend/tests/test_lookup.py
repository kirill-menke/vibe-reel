"""GET /api/lookup: result shaping, the half-typed-last-word fallback, and the
90 s shared lookup cache (app.py _cached_lookup)."""

import asyncio

import httpx
import pytest

from reel_api.arr import ArrClient
from tests.conftest import SONARR, SONARR_KEY
from tests.support.arr import movie_obj, series_obj
from tests.support.clock import FakeClock

LOOKUP = "/api/v3/series/lookup"
MLOOKUP = "/api/v3/movie/lookup"


async def _titles(api, q, type="tv"):
    r = await api.get("/api/lookup", params={"q": q, "type": type})
    assert r.status_code == 200, r.text
    return [x["title"] for x in r.json()["results"]]


# ---------------------------------------------------------------- shaping


async def test_tv_result_shape(api, sonarr):
    sonarr.add_catalog(series_obj(81189, "Breaking Bad", year=2008, overview="Chemistry.", votes=2_100_000))
    r = await api.get("/api/lookup", params={"q": "breaking bad"})
    body = r.json()
    assert body["query"] == "breaking bad" and body["type"] == "tv"
    assert body["results"] == [{
        "id": "81189", "type": "tv", "title": "Breaking Bad", "year": 2008, "overview": "Chemistry.",
        "poster": "https://artworks.thetvdb.com/banners/posters/81189.jpg", "added": False,
        "votes": 2_100_000, "original_title": None,
    }]


async def test_rows_without_id_are_dropped_and_added_means_arr_id(api, sonarr):
    sonarr.set_lookup("dark", [
        series_obj(0, "Dark (no tvdb id)"),
        {**series_obj(5, "Dark"), "id": 12},
        {**series_obj(6, "Dark Matter"), "id": 0},
        series_obj(7, "Dark Winds"),
    ])
    res = (await api.get("/api/lookup", params={"q": "dark"})).json()["results"]
    assert [(x["id"], x["added"]) for x in res] == [("5", True), ("6", False), ("7", False)]
    assert all(isinstance(x["id"], str) for x in res)


async def test_movie_shape_original_title_and_tmdb_id(api, radarr):
    radarr.set_lookup("city of god", [
        movie_obj(598, "City of God", original_title="Cidade de Deus", imdb_votes=800_000),
        movie_obj(599, "God's City", original_title="God's City"),
    ])
    res = (await api.get("/api/lookup", params={"q": "city of god", "type": "movie"})).json()["results"]
    assert [(x["id"], x["original_title"]) for x in res] == [("598", "Cidade de Deus"), ("599", None)]
    assert res[0]["type"] == "movie" and res[0]["votes"] == 800_000
    assert res[0]["poster"] == "https://image.tmdb.org/t/p/original/posters/598.jpg"


@pytest.mark.parametrize("imgs, want", [
    ([{"coverType": "fanart", "remoteUrl": "https://x/f.jpg"},
      {"coverType": "poster", "url": "/MediaCover/1/poster.jpg", "remoteUrl": "https://x/p.jpg"}], "https://x/p.jpg"),
    ([{"coverType": "poster", "url": "https://x/u.jpg"}], "https://x/u.jpg"),
    ([{"coverType": "poster", "url": "/MediaCover/1/poster.jpg"}], None),  # relative: useless without the key
    ([{"coverType": "banner", "remoteUrl": "https://x/b.jpg"}], None),
    ([], None),
])
def test_poster_prefers_absolute_remote_url(imgs, want):
    c = ArrClient("tv", SONARR, SONARR_KEY, "x")
    assert c._shape({"tvdbId": 1, "title": "t", "images": imgs})["poster"] == want


@pytest.mark.parametrize("ratings, votes", [
    ({"votes": 851_000, "value": 9.0}, 851_000),  # Sonarr
    ({"imdb": {"votes": 1_090_000}, "tmdb": {"votes": 12_000}}, 1_090_000),  # Radarr: IMDb first
    ({"imdb": {"votes": 0}, "trakt": {"votes": 5_000}, "tmdb": {"votes": 900}}, 5_000),
    ({"tmdb": {"votes": 900}}, 900),
    ({}, 0),
    (None, 0),
])
def test_votes_fallback_order(ratings, votes):
    c = ArrClient("movie", SONARR, SONARR_KEY, "x")
    assert c._shape({"tmdbId": 1, "title": "t", "ratings": ratings})["votes"] == votes


async def test_year_zero_and_missing_fields_become_null_or_empty(api, sonarr):
    sonarr.set_lookup("bare", [{"tvdbId": 3, "year": 0}])
    res = (await api.get("/api/lookup", params={"q": "bare"})).json()["results"]
    assert res == [{"id": "3", "type": "tv", "title": "", "year": None, "overview": "", "poster": None,
                    "added": False, "votes": 0, "original_title": None}]


# ---------------------------------------------------------------- half-typed fallback


async def test_single_word_query_makes_one_upstream_call(api, sonarr):
    sonarr.add_catalog(series_obj(1, "Dark"))
    assert await _titles(api, "dark") == ["Dark"]
    assert [c.params["term"] for c in sonarr.called(LOOKUP)] == ["dark"]


async def test_half_typed_last_word_falls_back_to_rest_with_stem(api, sonarr):
    sonarr.add_catalog(series_obj(1, "Better Call Saul"))
    sonarr.add_catalog(series_obj(2, "Better Things"))
    sonarr.add_catalog(series_obj(3, "Call the Midwife"))
    # "better ca": the full query finds nothing; "better" finds both Better shows,
    # and only the one with a word starting "ca" is kept
    assert await _titles(api, "better ca") == ["Better Call Saul"]
    assert sorted(c.params["term"] for c in sonarr.called(LOOKUP)) == ["better", "better ca"]


async def test_the_mandal_does_not_accept_mandala_as_a_hit(api, sonarr):
    sonarr.set_lookup("the mandal", [series_obj(2, "Mandala")])
    sonarr.set_lookup("the", [series_obj(1, "The Mandalorian"), series_obj(2, "Mandala"),
                              series_obj(3, "The Office")])
    # "Mandala" only *starts* with "mandal" — no word boundary, so the fallback runs
    assert await _titles(api, "the mandal") == ["Mandala", "The Mandalorian"]


async def test_typo_in_last_word_keeps_title_by_three_letter_stem(api, radarr):
    radarr.set_lookup("shawshank redemtion", [])
    radarr.set_lookup("shawshank", [movie_obj(278, "The Shawshank Redemption"),
                                    movie_obj(279, "Shawshank: The Whole Story")])
    assert await _titles(api, "shawshank redemtion", "movie") == ["The Shawshank Redemption"]


@pytest.mark.parametrize("full_titles", [
    ["Breaking Bad"],  # the title *is* the query
    ["Breaking Bad: Original Minisodes"],  # continues it past a word boundary
    ["The Breaking Bad"],  # leading article and punctuation normalised away
])
async def test_full_query_hit_skips_the_fallback(api, sonarr, full_titles):
    sonarr.set_lookup("breaking bad", [series_obj(10 + i, t) for i, t in enumerate(full_titles)])
    sonarr.set_lookup("breaking", [series_obj(99, "Breaking Badly"), series_obj(98, "Breaking Bread")])
    assert await _titles(api, "breaking bad") == full_titles


async def test_fallback_does_not_repeat_full_results(api, sonarr):
    sonarr.set_lookup("dark win", [series_obj(1, "Dark Winds Special")])  # not a boundary match of "dark win"
    sonarr.set_lookup("dark", [series_obj(1, "Dark Winds Special"), series_obj(2, "Dark Winds"),
                               series_obj(3, "Dark")])
    assert await _titles(api, "dark win") == ["Dark Winds Special", "Dark Winds"]


async def test_fallback_without_a_usable_stem_returns_full(api, sonarr):
    sonarr.set_lookup("dark !!", [])
    sonarr.set_lookup("dark", [series_obj(3, "Dark")])
    assert await _titles(api, "dark !!") == []


async def test_full_query_error_propagates_as_503(api, sonarr):
    sonarr.set_lookup("dark ma", httpx.Response(500))
    sonarr.set_lookup("dark", [series_obj(3, "Dark Matter")])
    r = await api.get("/api/lookup", params={"q": "dark ma"})
    assert r.status_code == 503 and r.headers["Retry-After"] == "30"
    assert r.json() == {"error": "temporarily_unavailable",
                        "detail": "library service temporarily unavailable, retry later"}


async def test_rest_query_error_is_ignored(api, sonarr):
    sonarr.set_lookup("dark ma", [series_obj(4, "Dark Mansion")])
    sonarr.set_lookup("dark", httpx.Response(502))
    assert await _titles(api, "dark ma") == ["Dark Mansion"]


# ---------------------------------------------------------------- cache


@pytest.fixture
def fake_time(monkeypatch, api):
    return FakeClock().install(monkeypatch, api.app_module)


async def test_cache_ttl_is_90_seconds(api, sonarr, fake_time):
    sonarr.add_catalog(series_obj(1, "Dark"))
    await _titles(api, "dark")
    fake_time.t += 89
    await _titles(api, "dark")
    assert sonarr.count(LOOKUP) == 1
    fake_time.t += 2
    await _titles(api, "dark")
    assert sonarr.count(LOOKUP) == 2


async def test_cache_key_ignores_case_and_whitespace_but_not_type(api, sonarr, radarr, fake_time):
    sonarr.add_catalog(series_obj(1, "Dark"))
    radarr.add_catalog(movie_obj(2, "Dark"))
    await _titles(api, "Dark")
    r = await api.get("/api/lookup", params={"q": "  dARK  "})
    assert r.json()["query"] == "  dARK  " and [x["id"] for x in r.json()["results"]] == ["1"]
    assert sonarr.count(LOOKUP) == 1
    assert await _titles(api, "dark", "movie") == ["Dark"]
    assert radarr.count(MLOOKUP) == 1
    await _titles(api, "the  dark")  # inner whitespace collapses, words still differ
    await _titles(api, "THE dark")
    assert sonarr.count(LOOKUP) == 1 + 2  # "the dark" -> full + rest, once


async def test_cache_is_lru_capped(api, sonarr, fake_time):
    mod = api.app_module
    assert mod.LOOKUP_MAX == 256
    client = mod.arr_clients["tv"]
    for i in range(256):
        await mod._cached_lookup(client, f"q{i}", "tv")
    await mod._cached_lookup(client, "q0", "tv")  # touch: q0 becomes the newest
    assert sonarr.count(LOOKUP) == 256
    await mod._cached_lookup(client, "q256", "tv")  # evicts the oldest: q1
    assert len(mod._lookup_cache) == 256
    assert ("q1", "tv") not in mod._lookup_cache and ("q0", "tv") in mod._lookup_cache
    await mod._cached_lookup(client, "q0", "tv")
    assert sonarr.count(LOOKUP) == 257
    await mod._cached_lookup(client, "q1", "tv")
    assert sonarr.count(LOOKUP) == 258


async def test_concurrent_identical_lookups_share_one_call(api, sonarr):
    sonarr.add_catalog(series_obj(1, "Dark"))
    gate = sonarr.gate(LOOKUP)
    reqs = [asyncio.create_task(api.get("/api/lookup", params={"q": q})) for q in ("dark", "Dark", " dark")]
    for _ in range(50):
        await asyncio.sleep(0)
    assert sonarr.count(LOOKUP) == 1
    gate.set()
    for r in await asyncio.gather(*reqs):
        assert [x["title"] for x in r.json()["results"]] == ["Dark"]
    assert sonarr.count(LOOKUP) == 1
    assert api.app_module._lookup_inflight == {}


async def test_cancelled_waiter_does_not_cancel_the_shared_lookup(api, sonarr):
    mod = api.app_module
    client = mod.arr_clients["tv"]
    sonarr.add_catalog(series_obj(1, "Dark"))
    gate = sonarr.gate(LOOKUP)
    first = asyncio.create_task(mod._cached_lookup(client, "dark", "tv"))
    second = asyncio.create_task(mod._cached_lookup(client, "dark", "tv"))
    for _ in range(50):
        await asyncio.sleep(0)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    gate.set()
    assert [x["title"] for x in await second] == ["Dark"]
    assert ("dark", "tv") in mod._lookup_cache and sonarr.count(LOOKUP) == 1


async def test_failed_lookup_is_not_cached(api, sonarr):
    sonarr.add_catalog(series_obj(1, "Dark"))
    sonarr.fail(LOOKUP, status=500)
    assert (await api.get("/api/lookup", params={"q": "dark"})).status_code == 503
    assert await _titles(api, "dark") == ["Dark"]
    assert api.app_module._lookup_inflight == {}


# ---------------------------------------------------------------- validation


@pytest.mark.parametrize("params", [{"q": "x", "type": "foo"}, {"q": "", "type": "tv"}, {"type": "tv"}])
async def test_bad_params_are_422(api, params):
    r = await api.get("/api/lookup", params=params)
    assert r.status_code == 422


async def test_unconfigured_type_is_503_not_available(make_api, sonarr):
    sonarr.add_catalog(series_obj(1, "Dark"))
    async with make_api(RADARR_API_KEY=None) as api:
        r = await api.get("/api/lookup", params={"q": "dark", "type": "movie"})
        assert r.status_code == 503
        assert r.json() == {"error": "not_available", "detail": "that media type is not available"}
        assert "Retry-After" not in r.headers
        assert await _titles(api, "dark") == ["Dark"]


async def test_default_type_is_tv(api, sonarr, radarr):
    sonarr.add_catalog(series_obj(1, "Dark"))
    r = await api.get("/api/lookup", params={"q": "dark"})
    assert r.json()["type"] == "tv" and radarr.calls == []
