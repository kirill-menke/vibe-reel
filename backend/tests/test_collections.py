"""GET /api/collection/{cid} (collections.py): Radarr's metadata service
(SkyHook, api.radarr.video/v1/movie/collection/{id}) -> lookup-shaped films in
release order, `added` from Radarr's library (60 s id cache), 24 h cache with
CACHE_MAX eviction and a stale copy served on upstream failure.

SkyHook is mocked with respx at its real URL; its payload follows what the
service returns (PascalCase records: TmdbId, Title, Year, Images[{CoverType,
Url}], MovieRatings{Imdb,Tmdb,Trakt}{Count,Value}, Premier/InCinema/...)."""

from __future__ import annotations

import httpx
import pytest

from reel_api import collections as coll_mod
from reel_api.models import Collection
from tests.support.arr import movie_obj

SKY = "https://api.radarr.video/v1/movie/collection/"


def imgs(key, *covers, scheme="https"):
    return [{"CoverType": c, "Url": f"{scheme}://image.tmdb.test/{c.lower()}/{key}.jpg"} for c in covers]


def part(tmdb, title, *, year=2000, premier=None, cinema=None, digital=None, physical=None, imdb=None,
         tmdb_rating=None, trakt=None, original=None, overview=None, poster=True, **extra):
    ratings = {}
    if imdb is not None:
        ratings["Imdb"] = {"Count": imdb[1], "Value": imdb[0], "Type": "User"}
    if tmdb_rating is not None:
        ratings["Tmdb"] = {"Count": tmdb_rating[1], "Value": tmdb_rating[0], "Type": "User"}
    if trakt is not None:
        ratings["Trakt"] = {"Count": trakt[1], "Value": trakt[0], "Type": "User"}
    p = {
        "TmdbId": tmdb, "ImdbId": f"tt{tmdb:07d}", "Title": title, "OriginalTitle": original or title,
        "Year": year, "Overview": overview if overview is not None else f"{title} overview.",
        "Images": imgs(tmdb, "Poster", "Fanart") if poster else [],
        "MovieRatings": ratings,
        "Premier": premier, "InCinema": cinema, "DigitalRelease": digital, "PhysicalRelease": physical,
        "Runtime": 117, "Genres": ["Horror"],
    }
    p.update(extra)
    return p


def collection(cid=8091, name="Alien Collection", parts=(), **extra):
    c = {"TmdbId": cid, "Name": name, "Overview": "Xenomorphs.", "Images": imgs(cid, "Poster", "Fanart"),
         "Parts": list(parts)}
    c.update(extra)
    return c


ALIEN = collection(parts=[
    part(679, "Aliens", year=1986, premier="1986-07-18T00:00:00Z", imdb=(8.4, 790_000)),
    part(348, "Alien", year=1979, cinema="1979-05-25T00:00:00Z", premier="1979-06-22T00:00:00Z",
         imdb=(8.5, 950_000)),
    part(1000001, "Alien: Next", year=2027),  # announced, no date
    part(8077, "Alien³", year=1992, digital="1999-01-01", tmdb_rating=(6.4, 5000), trakt=(6.5, 12_000)),
    part(1000000, "Untitled Alien", year=None),
    part(126889, "Alien: Covenant", year=2017, physical="2017-08-15T00:00:00Z", original="Alien Covenant",
         poster=False),
])


@pytest.fixture
def sky(upstream):
    """cid -> payload (dict) or httpx.Response / exception; unknown -> 404."""
    answers: dict = {}

    def handle(request):
        cid = request.url.path.rsplit("/", 1)[1]
        a = answers.get(cid)
        if a is None:
            return httpx.Response(404, json={"message": "not found"})
        if isinstance(a, list):  # a queue of answers
            a = a.pop(0) if len(a) > 1 else a[0]
        if isinstance(a, Exception):
            raise a
        if isinstance(a, httpx.Response):
            return a
        return httpx.Response(200, json=a)

    route = upstream.get(url__startswith=SKY).mock(side_effect=handle)
    route.answers = answers
    return route


async def get(api, cid, status=200):
    r = await api.get(f"/api/collection/{cid}")
    assert r.status_code == status, r.text
    if status == 200:
        Collection.model_validate(r.json())
        return r.json()
    return r


# ---------------------------------------------------------------- shape


async def test_shape_release_order_and_lookup_fields(api, sky, radarr):
    sky.answers["8091"] = ALIEN
    body = await get(api, 8091)
    assert body["id"] == "8091" and body["title"] == "Alien Collection" and body["overview"] == "Xenomorphs."
    assert body["poster"] == "https://image.tmdb.test/poster/8091.jpg"
    assert body["fanart"] == "https://image.tmdb.test/fanart/8091.jpg"
    movies = body["movies"]
    # dated films by primary release (Premier before InCinema), then undated by year, unknown year last
    assert [m["id"] for m in movies] == ["348", "679", "8077", "126889", "1000001", "1000000"]
    alien = movies[0]
    assert alien == {
        "id": "348", "type": "movie", "title": "Alien", "year": 1979, "overview": "Alien overview.",
        "poster": "https://image.tmdb.test/poster/348.jpg", "added": False, "votes": 950_000,
        "original_title": None, "rating": 8.5, "released": "1979-06-22",
    }
    a3 = movies[2]
    assert a3["rating"] == 6.4 and a3["votes"] == 12_000 and a3["released"] == "1999-01-01"
    cov = movies[3]
    assert cov["original_title"] == "Alien Covenant" and cov["poster"] is None and cov["released"] == "2017-08-15"
    assert cov["rating"] is None and cov["votes"] == 0
    assert movies[5]["year"] is None and movies[5]["released"] is None
    assert sky.call_count == 1
    assert sky.calls[0].request.headers["User-Agent"] == "reel-api"


def test_shape_edges():
    raw = {"Parts": [
        {"TmdbId": 0, "Title": "no id"},  # dropped
        {"Title": "missing id"},  # dropped
        {"TmdbId": 5, "Title": "T", "Images": [{"CoverType": "Poster", "Url": "/relative.jpg"},
                                              {"CoverType": "Poster", "Url": "https://x.test/p.jpg"}],
         "MovieRatings": {"Imdb": {"Value": 0, "Count": 0}, "Tmdb": {"Value": 7.26, "Count": 3}},
         "Year": 0, "InCinema": "2001-02-03T04:05:06Z"},
    ]}
    out = coll_mod.shape(raw)
    assert out == {"id": "", "title": "", "overview": "", "poster": None, "fanart": None, "movies": [{
        "id": "5", "type": "movie", "title": "T", "year": None, "overview": "", "poster": "https://x.test/p.jpg",
        "added": False, "votes": 3, "original_title": None, "rating": 7.3, "released": "2001-02-03"}]}
    assert coll_mod.shape({})["movies"] == []
    assert coll_mod.shape({"Parts": None, "Images": None})["poster"] is None


async def test_added_from_the_radarr_library(api, sky, radarr):
    radarr.add_movie(movie_obj(679, "Aliens", imdb="tt0090605"))
    sky.answers["8091"] = ALIEN
    body = await get(api, 8091)
    assert {m["id"]: m["added"] for m in body["movies"]}["679"] is True
    assert sum(m["added"] for m in body["movies"]) == 1


async def test_library_failure_only_loses_added(api, sky, radarr, caplog):
    radarr.add_movie(movie_obj(679, "Aliens"))
    radarr.fail("/api/v3/movie", status=500)
    sky.answers["8091"] = ALIEN
    body = await get(api, 8091)
    assert not any(m["added"] for m in body["movies"])
    assert "radarr library unavailable" in caplog.text
    # not cached: the next request asks Radarr again
    body = await get(api, 8091)
    assert {m["id"]: m["added"] for m in body["movies"]}["679"] is True


# ---------------------------------------------------------------- caches


async def test_library_ttl_and_forget_after_an_add(api, sky, radarr, clock, monkeypatch):
    clock.install(monkeypatch, coll_mod)
    sky.answers["8091"] = ALIEN
    radarr.add_catalog(movie_obj(348, "Alien"))

    async def added(mid):
        return {m["id"]: m["added"] for m in (await get(api, 8091))["movies"]}[mid]

    assert await added("679") is False
    radarr.add_movie(movie_obj(679, "Aliens"))  # behind reel-api's back
    clock.t += coll_mod.LIBRARY_TTL - 1
    assert await added("679") is False
    clock.t += 1
    assert await added("679") is True
    assert radarr.count("/api/v3/movie", "GET") == 2
    # an add through reel-api forgets the ids at once
    r = await api.post("/api/library", json={"id": "348", "type": "movie"})
    assert r.status_code == 202, r.text
    assert await added("348") is True
    # and so does its undo
    r = await api.delete("/api/library/movie/348", params={"undo": r.json()["undo"]})
    assert r.status_code == 200, r.text
    assert await added("348") is False
    assert sky.call_count == 1  # the collection itself stayed cached throughout


async def test_24h_cache(api, sky, radarr, clock, monkeypatch):
    clock.install(monkeypatch, coll_mod)
    sky.answers["8091"] = ALIEN
    await get(api, 8091)
    sky.answers["8091"] = collection(name="Alien Anthology", parts=ALIEN["Parts"])
    clock.t += coll_mod.CACHE_TTL - 1
    assert (await get(api, 8091))["title"] == "Alien Collection"
    clock.t += 1
    assert (await get(api, 8091))["title"] == "Alien Anthology"
    assert sky.call_count == 2


async def test_cache_max_evicts_the_oldest(api, sky, radarr, clock, monkeypatch):
    clock.install(monkeypatch, coll_mod)
    monkeypatch.setattr(coll_mod, "CACHE_MAX", 3)
    for cid in range(1, 5):
        sky.answers[str(cid)] = collection(cid, f"C{cid}")
    for cid in (1, 2, 3):
        await get(api, cid)
        clock.t += 1
    assert sky.call_count == 3
    await get(api, 4)  # 4 entries > 3: the oldest (1) goes
    cache = api.app_module.collections._cache
    assert sorted(cache) == ["2", "3", "4"]
    await get(api, 2)
    assert sky.call_count == 4
    await get(api, 1)
    assert sky.call_count == 5 and sorted(cache) == ["1", "3", "4"]


# ---------------------------------------------------------------- errors


async def test_unknown_collection_is_404(api, sky, radarr):
    r = await get(api, 4242, status=404)
    assert r.json() == {"error": "not_found", "detail": "no such collection"}


@pytest.mark.parametrize("answer", [
    httpx.Response(500), httpx.Response(502), httpx.Response(429),
    httpx.ConnectError("down"), httpx.ReadTimeout("slow"),
], ids=["500", "502", "429", "unreachable", "timeout"])
async def test_upstream_error_is_503_retry_after_300(api, sky, radarr, answer, caplog):
    sky.answers["8091"] = answer
    r = await get(api, 8091, status=503)
    assert r.headers["Retry-After"] == "300"
    assert r.json() == {"error": "temporarily_unavailable", "detail": "collection temporarily unavailable, retry later"}
    assert "collections: metadata service" in caplog.text


@pytest.mark.parametrize("answer", [httpx.Response(503), httpx.ConnectError("down")], ids=["503", "unreachable"])
async def test_stale_copy_is_served_on_failure(api, sky, radarr, clock, monkeypatch, answer):
    clock.install(monkeypatch, coll_mod)
    sky.answers["8091"] = ALIEN
    first = await get(api, 8091)
    clock.t += coll_mod.CACHE_TTL + 1
    sky.answers["8091"] = answer
    assert await get(api, 8091) == first
    # the stale entry isn't re-stamped: once the service is back it is refetched
    sky.answers["8091"] = collection(name="Alien Anthology", parts=ALIEN["Parts"])
    assert (await get(api, 8091))["title"] == "Alien Anthology"


async def test_a_collection_gone_upstream_is_404_even_when_cached(api, sky, radarr, clock, monkeypatch):
    clock.install(monkeypatch, coll_mod)
    sky.answers["8091"] = ALIEN
    await get(api, 8091)
    clock.t += coll_mod.CACHE_TTL
    del sky.answers["8091"]
    await get(api, 8091, status=404)


@pytest.mark.parametrize("cid", ["abc", "12a", "-1", "12345678901", "1.5", "%20", "1%0A"])
async def test_cid_pattern_is_422(api, sky, cid):
    await get(api, cid, status=422)
    assert sky.call_count == 0


async def test_ten_digit_id_is_accepted(api, sky, radarr):
    sky.answers["1234567890"] = collection(1234567890, "Big")
    assert (await get(api, 1234567890))["id"] == "1234567890"
    assert str(sky.calls[0].request.url) == SKY + "1234567890"


async def test_without_radarr_is_503_not_available(make_api, sky, sonarr):
    async with make_api(RADARR_URL=None, RADARR_API_KEY=None) as api:
        r = await get(api, 8091, status=503)
        assert r.json() == {"error": "not_available", "detail": "that media type is not available"}
        assert "Retry-After" not in r.headers
    assert sky.call_count == 0


async def test_non_json_200_is_503_retry_after_300(make_api, sky, radarr):
    """A 200 whose body isn't JSON (a captive portal, a CDN error page) is a
    metadata-service failure like a 5xx (test_upstream_error_is_503_retry_
    after_300)."""
    sky.answers["8091"] = httpx.Response(200, text="<html>maintenance</html>")
    async with make_api(raise_app_exceptions=False) as api:
        r = await get(api, 8091, status=503)
    assert r.headers.get("Retry-After") == "300"
    assert r.json() == {"error": "temporarily_unavailable", "detail": "collection temporarily unavailable, retry later"}


async def test_stale_copy_is_served_on_a_non_json_200(make_api, sky, radarr, clock, monkeypatch):
    """...and an expired cached copy is served, as for a 5xx
    (test_stale_copy_is_served_on_failure)."""
    clock.install(monkeypatch, coll_mod)
    sky.answers["8091"] = ALIEN
    async with make_api(raise_app_exceptions=False) as api:
        first = await get(api, 8091)
        clock.t += coll_mod.CACHE_TTL + 1
        sky.answers["8091"] = httpx.Response(200, text="<html>maintenance</html>")
        assert await get(api, 8091) == first
