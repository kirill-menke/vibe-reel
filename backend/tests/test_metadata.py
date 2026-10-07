"""GET /api/metadata/{type}/{id}: the full Sonarr/Radarr metadata that lets a
client render a queued title like a downloaded one (arr.py ArrClient.metadata,
_image/_rating)."""

from datetime import datetime, timezone

import httpx
import pytest

from reel_api.arr import _image, _rating
from reel_api.models import TitleMetadata
from tests.support.arr import episode_obj, movie_obj, season_obj, series_obj

LOOKUP = "/api/v3/series/lookup"
MLOOKUP = "/api/v3/movie/lookup"
EPISODES = "/api/v3/episode"


def _d(y, m, d):
    return datetime(y, m, d, 2, 0, tzinfo=timezone.utc)


async def _meta(api, type, id, status=200):
    r = await api.get(f"/api/metadata/{type}/{id}")
    assert r.status_code == status, r.text
    return r.json()


# ---------------------------------------------------------------- tv


async def test_tv_full_metadata_with_episodes(api, sonarr):
    s = sonarr.add_series(
        series_obj(305288, "Stranger Things", year=2016, overview="Hawkins.", runtime=51,
                   genres=["Drama", "Mystery"], rating=8.66, certification="TV-14", status="ended",
                   seasons=[season_obj(1), season_obj(2)]),
        [episode_obj(1, 1, title="The Vanishing of Will Byers", overview="Will goes missing.",
                     air=_d(2016, 7, 15), has_file=True),
         episode_obj(1, 2, title="The Weirdo on Maple Street", air=_d(2016, 7, 15)),
         episode_obj(2, 1, title="MADMAX", air=None, still=False)],
    )
    body = await _meta(api, "tv", 305288)
    TitleMetadata.model_validate(body)
    assert {k: v for k, v in body.items() if k != "episodes"} == {
        "id": "305288", "type": "tv", "title": "Stranger Things", "year": 2016,
        "overview": "Hawkins.",
        "poster": "https://artworks.thetvdb.com/banners/posters/305288.jpg",
        "fanart": "https://artworks.thetvdb.com/banners/fanarts/305288.jpg",
        "runtime_min": 51, "genres": ["Drama", "Mystery"], "rating": 8.7,
        "certification": "TV-14", "status": "ended", "trailer": None, "collection": None,
        "digital_release": None,
    }
    tvdb = [e["tvdbId"] for e in sonarr.episodes_of(s["id"])]
    assert body["episodes"] == [
        {"season": 1, "episode": 1, "title": "The Vanishing of Will Byers",
         "overview": "Will goes missing.", "air_date": "2016-07-15",
         "still": f"https://artworks.thetvdb.com/banners/episodes/{tvdb[0]}.jpg", "has_file": True},
        {"season": 1, "episode": 2, "title": "The Weirdo on Maple Street",
         "overview": "S1E2 overview.", "air_date": "2016-07-15",
         "still": f"https://artworks.thetvdb.com/banners/episodes/{tvdb[1]}.jpg", "has_file": False},
        {"season": 2, "episode": 1, "title": "MADMAX", "overview": "S2E1 overview.",
         "air_date": None, "still": None, "has_file": False},
    ]


async def test_tv_lookup_by_tvdb_term_and_episodes_with_images(api, sonarr):
    s = sonarr.add_series(series_obj(81189, "Breaking Bad"), [episode_obj(1, 1, air=_d(2008, 1, 20))])
    await _meta(api, "tv", 81189)
    (look,) = sonarr.called(LOOKUP, "GET")
    assert look.params == {"term": "tvdb:81189"}
    (eps,) = sonarr.called(EPISODES, "GET")
    assert eps.params == {"seriesId": str(s["id"]), "includeImages": "true"}


async def test_tv_not_added_has_no_episode_list_and_no_episode_call(api, sonarr):
    sonarr.add_catalog(series_obj(121361, "Game of Thrones"))
    body = await _meta(api, "tv", 121361)
    assert body["episodes"] == [] and body["title"] == "Game of Thrones"
    assert sonarr.count(EPISODES) == 0


async def test_tv_relative_only_images_are_none(api, sonarr):
    # Sonarr's /MediaCover/... urls need the API key: useless to a client
    obj = series_obj(1, "Local Art")
    obj["images"] = [{"coverType": "poster", "url": "/MediaCover/1/poster.jpg"},
                     {"coverType": "fanart", "url": "/MediaCover/1/fanart.jpg"}]
    sonarr.add_catalog(obj)
    body = await _meta(api, "tv", 1)
    assert body["poster"] is None and body["fanart"] is None


async def test_minimal_tv_payload_does_not_crash(api, sonarr):
    sonarr.set_lookup("tvdb:7", [{"tvdbId": 7, "id": 3}])
    # an episode row with nothing but ids: the sim's own handler needs numbers to sort by
    bare = lambda call, m: httpx.Response(200, json=[{"id": 1, "seriesId": 3}])
    sonarr._routes = [(mth, rx, t, bare if t == EPISODES else h) for mth, rx, t, h in sonarr._routes]
    body = await _meta(api, "tv", 7)
    TitleMetadata.model_validate(body)
    assert body == {
        "id": "7", "type": "tv", "title": "", "year": None, "overview": "", "poster": None,
        "fanart": None, "runtime_min": None, "genres": [], "rating": None,
        "certification": None, "status": None, "trailer": None, "collection": None,
        "digital_release": None,
        "episodes": [{"season": None, "episode": None, "title": "", "overview": "",
                      "air_date": None, "still": None, "has_file": False}],
    }


# ---------------------------------------------------------------- movie


async def test_movie_trailer_collection_and_rating(api, radarr):
    radarr.add_catalog(movie_obj(438631, "Dune", year=2021, runtime=155, genres=["Science Fiction"],
                                 imdb_rating=8.04, certification="PG-13", trailer="n9xhJrPXop4",
                                 collection={"title": "Dune Collection", "tmdbId": 726871}))
    body = await _meta(api, "movie", 438631)
    TitleMetadata.model_validate(body)
    assert body["type"] == "movie" and body["id"] == "438631"
    assert body["trailer"] == "n9xhJrPXop4"
    assert body["collection"] == {"id": "726871", "title": "Dune Collection"}
    assert body["rating"] == 8.0 and body["runtime_min"] == 155 and body["episodes"] == []
    assert body["poster"] == "https://image.tmdb.org/t/p/original/posters/438631.jpg"
    assert body["fanart"] == "https://image.tmdb.org/t/p/original/fanarts/438631.jpg"
    (look,) = radarr.called(MLOOKUP, "GET")
    assert look.params == {"term": "tmdb:438631"}
    assert radarr.count(EPISODES) == 0


async def test_movie_in_library_never_asks_for_episodes(api, radarr):
    radarr.add_movie(movie_obj(27205, "Inception", has_file=True))
    body = await _meta(api, "movie", 27205)
    assert body["episodes"] == []
    assert radarr.count(EPISODES) == 0


@pytest.mark.parametrize("collection, want", [
    (None, None),
    ({"title": "No id", "tmdbId": 0}, None),
    ({"tmdbId": 10}, {"id": "10", "title": ""}),
])
async def test_movie_collection_variants(api, radarr, collection, want):
    radarr.add_catalog(movie_obj(5, "Solo", trailer=None, collection=collection))
    body = await _meta(api, "movie", 5)
    assert body["collection"] == want
    assert body["trailer"] is None  # empty youTubeTrailerId -> null


@pytest.mark.parametrize("digital, want", [
    ("2026-11-04T00:00:00Z", "2026-11-04"),
    ("", None),
    ("absent", None),
])
async def test_movie_digital_release_is_the_day(api, radarr, digital, want):
    """Radarr's digitalRelease, as a date: phone LookupDetail shows it for a
    title not out to download yet (the same shape by_imdb gives trending)."""
    obj = movie_obj(7, "Soon", digital_release=digital)
    if digital == "absent":
        del obj["digitalRelease"]
    radarr.add_catalog(obj)
    body = await _meta(api, "movie", 7)
    TitleMetadata.model_validate(body)
    assert body["digital_release"] == want


async def test_movie_rating_falls_back_to_tmdb(api, radarr):
    radarr.add_catalog(movie_obj(6, "Obscure", imdb_rating=None, imdb_votes=0, tmdb_rating=6.66))
    assert (await _meta(api, "movie", 6))["rating"] == 6.7


async def test_first_lookup_match_wins(api, radarr):
    radarr.set_lookup("tmdb:9", [movie_obj(9, "First"), movie_obj(9, "Second")])
    assert (await _meta(api, "movie", 9))["title"] == "First"


# ---------------------------------------------------------------- errors


async def test_unknown_id_is_404(api, sonarr, radarr):
    assert await _meta(api, "tv", 999, 404) == {"error": "not_found", "detail": "no such title"}
    assert await _meta(api, "movie", 999, 404) == {"error": "not_found", "detail": "no such title"}


async def test_bad_type_is_400(api):
    assert await _meta(api, "music", 1, 400) == {"error": "bad_type", "detail": "type must be tv or movie"}


async def test_arr_failure_is_503(api, sonarr):
    sonarr.fail(LOOKUP, status=500)
    r = await api.get("/api/metadata/tv/1")
    assert r.status_code == 503 and r.headers["retry-after"] == "30"
    assert "sonarr" not in r.text.lower()


async def test_episode_call_failure_is_503(api, sonarr):
    sonarr.add_series(series_obj(2, "Two"), [episode_obj(1, 1)])
    sonarr.fail(EPISODES, exc=httpx.ConnectError("down"))
    r = await api.get("/api/metadata/tv/2")
    assert r.status_code == 503


async def test_unconfigured_arr_is_503(make_api):
    async with make_api(RADARR_URL=None, RADARR_API_KEY=None) as api:
        r = await api.get("/api/metadata/movie/1")
    assert r.status_code == 503


# ---------------------------------------------------------------- helpers


@pytest.mark.parametrize("images, want", [
    ([], None),
    ([{"coverType": "banner", "remoteUrl": "https://x/b.jpg"}], None),
    ([{"coverType": "poster", "url": "https://x/u.jpg"}], "https://x/u.jpg"),
    ([{"coverType": "poster", "remoteUrl": "https://x/r.jpg", "url": "https://x/u.jpg"}], "https://x/r.jpg"),
    # the first matching cover decides, even if it is relative
    ([{"coverType": "poster", "url": "/rel.jpg"}, {"coverType": "poster", "remoteUrl": "https://x/2.jpg"}], None),
    ([{"coverType": "poster"}], None),
])
def test_image(images, want):
    assert _image({"images": images}, "poster") == want


def test_image_without_images_key():
    assert _image({}, "fanart") is None


@pytest.mark.parametrize("ratings, want", [
    ({"votes": 10, "value": 8.25}, 8.2),
    ({"imdb": {"value": 7.06}}, 7.1),
    ({"imdb": {"value": 0}, "tmdb": {"value": 5.55}}, 5.5),
    ({"value": 0}, None),
    ({}, None),
    (None, None),
])
def test_rating(ratings, want):
    assert _rating({"ratings": ratings}) == want
