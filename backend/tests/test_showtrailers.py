"""GET /api/metadata/{type}/{id}/trailer (showtrailers.py): a show's YouTube
trailer from a strictly checked yt-dlp search, Radarr's for a movie.

The rules (accept()/pick()) are tested on hand-built search results and on two
recorded real searches (tests/recorded/ytsearch/, record_upstreams.py
ytsearch); the route through the app with the Sonarr/Radarr sims and the fake
yt-dlp's search mode — the real one never runs (conftest no_real_ytdlp)."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

import pytest

from reel_api import showtrailers as st
from reel_api.models import TitleTrailer
from tests.support.arr import movie_obj, series_obj
from tests.support.fake_ytdlp import RECORDED_SEARCH, FakeYtDlp, recorded_search, search_entry

NOW = datetime(2026, 10, 10, tzinfo=timezone.utc)


def e(title, yt_id="aaaaaaaaaaa", **kw):
    return search_entry(yt_id, title, **kw)


def ok(title, name="Succession", first=2018, clashes=(), **kw):
    return st.accept(e(title, **kw), st.words(name), first, list(clashes)) is not None


# ---------------------------------------------------------------- helpers


def test_words_fold_accents_ampersands_apostrophes_and_keep_articles():
    assert st.words("SHŌGUN — Official Trailer") == ["shogun", "official", "trailer"]
    assert st.words("Clarkson’s Farm & Friends") == ["clarksons", "farm", "and", "friends"]
    assert st.words("The House") == ["the", "house"]
    assert st.words(None) == [] and st.words("") == []


def test_show_name_drops_tvdb_disambiguation():
    assert st.show_name("Avatar: The Last Airbender (2024)") == "Avatar: The Last Airbender"
    assert st.show_name("The Office (US)") == "The Office"
    assert st.show_name("Doctor Who (2023) (UK)") == "Doctor Who"
    assert st.show_name("Scam 1992 - The Harshad Mehta Story") == "Scam 1992 - The Harshad Mehta Story"
    assert st.show_name("") == ""


def test_premiere_year():
    assert st.premiere_year({"year": 2018, "firstAired": "2017-01-01T00:00:00Z"}) == 2018
    assert st.premiere_year({"year": 0, "firstAired": "2019-06-03T00:00:00Z"}) == 2019
    assert st.premiere_year({"year": 0, "firstAired": None}) is None
    assert st.premiere_year({}) is None


def test_clash_years():
    shows = [
        {"id": "74852", "title": "Avatar: The Last Airbender", "year": 2005, "votes": 456_476},  # itself
        {"id": "385925", "title": "Avatar: The Last Airbender (2024)", "year": 2024, "votes": 93_974},
        {"id": "251085", "title": "The Legend of Korra", "year": 2012, "votes": 154_968},  # other name
        {"id": "9", "title": "Avatar: The Last Airbender", "year": 1999, "votes": 99},  # old, unknown
        {"id": "10", "title": "Avatar: the last airbender", "year": 2025, "votes": 0},  # recent: counts
    ]
    films = [
        {"id": "1", "title": "Avatar: The Last Airbender", "year": 2026, "votes": 3},  # upcoming
        {"id": "2", "title": "Ein Film", "original_title": "Avatar: The Last Airbender", "year": 2001,
         "votes": 5000},  # by its original title
        {"id": "3", "title": "Avatar: The Last Airbender", "year": None, "votes": 0},  # a stub
        {"id": "4", "title": "Avatar", "year": 2009, "votes": 1_400_000},
    ]
    assert st.clash_years("Avatar: The Last Airbender", "74852", shows, films, NOW) == [2024, 2025, 2026, 2001]
    assert st.clash_years("The Legend of Korra", "251085", shows, [], NOW) == []
    # an unknown year with votes: still a clash (and no year of the show's escapes it)
    assert st.clash_years("X", "1", [{"id": "2", "title": "X", "year": None, "votes": 500}], [], NOW) == [0]
    assert st.clash_years("X", "1", [], [], None) == []


# ---------------------------------------------------------------- accept()


@pytest.mark.parametrize("title", [
    "Succession: Season 1 | Official Trailer | HBO",
    "Succession | Official Trailer | HBO",
    "SUCCESSION Official Teaser (2018)",
    "Succession (2017) Trailer",          # a year before the premiere: trailers come first
    "Succession - Trailer #2",
    "Succession Season Two Trailer",
    "Succession S1 Official Trailer",
    "Succession Series 1 Extended Trailer | Sky",
    "SUCCESSION - Seasons 1-4 Trailer",
    "Succession: Season 3 | New Season Trailer",
    "Succession Trailer (Second Season)",
])
def test_accepted(title):
    assert ok(title)


@pytest.mark.parametrize("title, kw, why", [
    ("Succession | Official Trailer | HBO", {"verified": None}, "unverified channel"),
    ("Succession | Official Trailer | HBO", {"verified": False}, "unverified channel"),
    ("Succession | Official Trailer | HBO", {"channel": "HBO Deutschland"}, "a dub's channel"),
    ("Succession | Official Trailer | HBO", {"duration": 19}, "too short"),
    ("Succession | Official Trailer | HBO", {"duration": 361}, "too long"),
    ("Succession | Official Trailer | HBO", {"duration": None}, "no duration (upcoming premiere)"),
    ("Succession Wars | Official Trailer", {}, "another title"),
    ("The Succession | Official Trailer", {}, "another title"),
    ("Succession Explained in 5 Minutes | Trailer", {}, "junk"),
    ("Succession | Official Trailer REACTION", {}, "junk after the word"),
    ("Succession | Trailer (Deutsch)", {}, "a dub"),
    ("Succession: The Movie | Official Trailer", {}, "the film"),
    ("Succession (2021) | Season 3 Official Trailer | HBO", {}, "a later year"),
    ("Succession (2016) | Official Trailer", {}, "two years early"),
    ("Succession | Featurette", {}, "no trailer word"),
    ("Succession: The Final Season Trailer", {}, "the ending"),
    ("Succession | The Final Season Teaser- UK & Ireland [HD] | Netflix", {}, "the ending"),
    ("Succession: Last Season | Official Trailer", {}, "the ending"),
    ("Succession Seasons Wars | Trailer", {}, "another title after a count word"),
    ("Succession", {}, "the name alone"),
    ("Success | Official Trailer", {}, "a shorter name"),
])
def test_refused(title, kw, why):
    assert not ok(title, **kw), why


def test_articles_and_numbers_tell_titles_apart():
    assert not ok("The House - Official Trailer [HD]", name="House", first=2004)
    assert not ok("Civil War | Official Trailer HD | A24", name="The Civil War", first=1990)
    assert not ok("Planet Earth II: Official Extended Trailer", name="Planet Earth", first=2006)
    assert not ok("Steins;Gate 0 - Official Trailer", name="Steins;Gate", first=2011)
    assert not ok("Friends: The Reunion - Official Teaser Trailer", name="Friends", first=1994)
    assert ok("Planet Earth II: Official Extended Trailer | BBC Earth", name="Planet Earth II", first=2016)
    assert ok("Scam 1992 – The Harshad Mehta Story | Official Trailer", name="Scam 1992 - The Harshad Mehta Story",
              first=2020)  # a year inside the name is the name's
    assert not ok("Fargo (1996) | Official Trailer | MGM Studios", name="Fargo", first=2014)


def test_an_ambiguous_name_needs_the_premiere_year_and_none_of_the_others():
    shogun = dict(name="Shōgun", first=2024, clashes=[1980])
    assert ok("SHŌGUN Official Trailer (2024) Hiroyuki Sanada", **shogun)
    assert ok("Shogun | Official Trailer 2023 | FX", **shogun)
    assert not ok("Shōgun | Official Trailer | FX", **shogun)  # no year: which Shōgun?
    assert not ok("Shōgun (1980) | Trailer", **shogun)
    # the other one premiered within a year: no year tells them apart
    assert not ok("Persona | Official Trailer (2019)", name="Persona", first=2019, clashes=[2018])
    assert not ok("Persona | Official Trailer (2019)", name="Persona", first=2019, clashes=[0, 2020])
    assert ok("Persona | Official Trailer (2019)", name="Persona", first=2019, clashes=[0, 1966])


# ---------------------------------------------------------------- pick()


def test_pick_prefers_first_season_then_trailer_then_youtube_order():
    entries = [
        e("Succession: Season 3 | Official Trailer | HBO", "s3xxxxxxxxx"),
        e("Succession | Official Teaser | HBO", "teaserxxxxx"),
        e("Succession: Season 2 | Official Trailer", "s2xxxxxxxxx"),
        e("Succession: Season 1 | Official Trailer | HBO", "s1xxxxxxxxx"),
        e("Succession | Official Trailer | HBO", "plainxxxxxx"),
    ]
    assert st.pick(entries, "Succession", 2018, [])["id"] == "s1xxxxxxxxx"
    assert st.pick(entries[:3], "Succession", 2018, [])["id"] == "teaserxxxxx"
    assert st.pick([entries[2], entries[0]], "Succession", 2018, [])["id"] == "s2xxxxxxxxx"  # YouTube's order
    assert st.pick(entries[:1], "Succession", 2018, [])["id"] == "s3xxxxxxxxx"  # later, but the show's own
    # an unnumbered "New Season" is a later one too: a season-less teaser beats it
    new = e("Succession | New Season | Official Trailer", "newxxxxxxxx")
    assert st.pick([new, entries[1]], "Succession", 2018, [])["id"] == "teaserxxxxx"
    assert st.pick([new], "Succession", 2018, [])["id"] == "newxxxxxxxx"
    # the final season is the ending: never, not even as the only hit
    assert st.pick([e("Succession: The Final Season | Official Trailer", "finalxxxxxx")], "Succession", 2018, []) is None


def test_breaking_bad_gets_the_series_trailer_not_the_final_season_teaser():
    # YouTube's verified hits for "Breaking Bad official trailer", 2026-10-10
    entries = [
        e("BREAKING BAD - Seasons 1-5 Trailer", "XZ8daibM3AE", duration=65),
        e("Breaking Bad: Official YouTube Channel Trailer", "VaOt6tXyf2Y", duration=86),
        e("El Camino: A Breaking Bad Movie | Official Trailer | Netflix", "1JLUn2DFW4w", duration=137),
        e("Breaking Bad | The Final Season Teaser- UK & Ireland [HD] | Netflix", "2gTC4uWP3_Y", duration=34),
    ]
    assert st.pick(entries, "Breaking Bad", 2008, [])["id"] == "XZ8daibM3AE"
    assert st.pick(entries[1:], "Breaking Bad", 2008, []) is None


def test_pick_skips_what_isnt_a_playable_result():
    good = e("Succession | Official Trailer | HBO", "plainxxxxxx")
    junk = ["not a dict", None, e("Succession | Official Trailer", "short"), {**good, "id": None},
            e("Succession | Official Trailer", "abc@1080xyz")]
    assert st.pick(junk + [good], "Succession", 2018, [])["id"] == "plainxxxxxx"
    assert st.pick(junk, "Succession", 2018, []) is None
    assert st.pick([good], "!!!", 2018, []) is None  # a name without words matches nothing


# ---------------------------------------------------------------- recorded real searches


def test_fake_search_entries_have_the_keys_real_ones_have():
    for p in sorted(RECORDED_SEARCH.glob("*.json")):
        rec = json.loads(p.read_text())
        assert rec["entries"], p.name
        for entry in rec["entries"]:
            assert set(entry) == set(search_entry("x" * 11, "t")), (p.name, entry["id"])
        assert rec["query"] == rec["show"] + " official trailer"


def test_recorded_search_succession_gets_a_verified_first_season_trailer():
    rec = recorded_search("succession")
    best = st.pick(rec["entries"], "Succession", 2018, [])
    assert best is not None and best["channel_is_verified"] is True
    w = st.words(best["title"])
    assert w[0] == "succession" and ("trailer" in w or "teaser" in w)
    assert st._season(w[1:]) <= 1


def test_recorded_search_a_remake_s_trailer_is_not_the_original_s():
    """The 2005 series shares its name with Netflix's 2024 remake, whose
    trailers are all YouTube has: none of them is taken for the 2005 one."""
    rec = recorded_search("avatar-the-last-airbender")
    assert st.pick(rec["entries"], "Avatar: The Last Airbender", 2005, [2024]) is None
    # what the clash rule prevents: without it, the remake's trailer would win
    assert st.pick(rec["entries"], "Avatar: The Last Airbender", 2005, []) is not None


# ---------------------------------------------------------------- the route


SHOW = 305288
QUERY = "Stranger Things official trailer"
TRAILER = "b9EkMc79ZSU"


@pytest.fixture(autouse=True)
def arrs(sonarr, radarr):
    """Both sims answer in every test: the route asks Radarr too."""
    return sonarr, radarr


@pytest.fixture
def yt(tmp_path, monkeypatch):
    return FakeYtDlp(tmp_path / "fake-ytdlp", monkeypatch, opaque=True)


@pytest.fixture
def show(sonarr):
    sonarr.add_catalog(series_obj(SHOW, "Stranger Things", year=2016))


def results(*extra):
    return [
        e("Stranger Things Recap in 3 Minutes", "recapxxxxxx"),
        e("Stranger Things | Official Trailer | Netflix", TRAILER, channel="Netflix"),
        *extra,
    ]


async def trailer(api, kind="tv", media_id=SHOW, status=200):
    r = await api.get(f"/api/metadata/{kind}/{media_id}/trailer")
    assert r.status_code == status, r.text
    if status == 200:
        TitleTrailer.model_validate(r.json())
        return r.json()["trailer"]
    return r.json()


async def test_show_trailer_found_and_cached(api, yt, show, sonarr, radarr):
    yt.search(QUERY, results())
    assert await trailer(api) == TRAILER
    (call,) = yt.calls("search:")
    assert call["argv"] == ["--no-cache-dir", "--no-warnings", "--quiet", "--flat-playlist", "-J",
                            f"ytsearch10:{QUERY}"]
    # the name was looked up for others of its name, once in each arr
    assert [c.params["term"] for c in sonarr.called("/api/v3/series/lookup")] == [f"tvdb:{SHOW}", "Stranger Things"]
    assert [c.params["term"] for c in radarr.called("/api/v3/movie/lookup")] == ["Stranger Things"]
    assert await trailer(api) == TRAILER
    assert yt.searched() == [QUERY] and sonarr.count("/api/v3/series/lookup") == 2


async def test_no_acceptable_result_is_null_and_cached(api, yt, show, monkeypatch):
    yt.search(QUERY, [e("Stranger Things | Official Trailer | Netflix", TRAILER, verified=None)])
    assert await trailer(api) is None
    assert await trailer(api) is None
    assert yt.searched() == [QUERY]
    monkeypatch.setattr(st, "MISS_TTL", 0)  # a miss is asked again after MISS_TTL
    assert await trailer(api) is None
    assert yt.searched() == [QUERY, QUERY]


async def test_youtube_finds_nothing(api, yt, show):
    assert await trailer(api) is None
    assert yt.searched() == [QUERY]


async def test_a_name_another_show_or_film_has_needs_its_year(api, yt, sonarr, radarr):
    sonarr.add_catalog(series_obj(74852, "Avatar: The Last Airbender", year=2005, votes=456_476))
    sonarr.add_catalog(series_obj(385925, "Avatar: The Last Airbender (2024)", year=2024, votes=93_974))
    netflix = e("Avatar: The Last Airbender | Official Trailer | Netflix", "ByAn8DF8Ykk", channel="Netflix")
    yt.search("Avatar: The Last Airbender official trailer", [netflix])
    assert await trailer(api, media_id=74852) is None
    # a film of the same name makes it ambiguous just the same
    sonarr.add_catalog(series_obj(305289, "Severance", year=2022))
    radarr.add_catalog(movie_obj(1000, "Severance", year=2006, imdb_votes=40_000))
    yt.search("Severance official trailer", [
        e("Severance | Official Trailer | Apple TV+", "appleplusxx"),
        e("SEVERANCE Trailer (2022) Apple TV+", "kinocheckxx", channel="KinoCheck.com"),
    ])
    assert await trailer(api, media_id=305289) == "kinocheckxx"


async def test_search_failures_answer_null_and_retry_after_err_ttl(api, yt, show, monkeypatch, caplog):
    yt.search(QUERY, results())
    yt.fail(f"search:{QUERY}", stderr="ERROR: [youtube:search] Sign in to confirm you're not a bot\n")
    assert await trailer(api) is None
    assert "Sign in to confirm" in caplog.text
    assert await trailer(api) is None and len(yt.searched()) == 1  # within ERR_TTL: not again
    yt.heal(f"search:{QUERY}")
    monkeypatch.setattr(st, "ERR_TTL", 0)
    assert await trailer(api) == TRAILER


@pytest.mark.parametrize("fault, words", [
    ({"stderr": "", "rc": 0}, "unreadable answer"),  # exit 0, nothing printed
])
async def test_search_unreadable_answer(api, yt, show, caplog, fault, words):
    yt.fail(f"search:{QUERY}", **fault)
    assert await trailer(api) is None
    assert words in caplog.text


async def test_search_answer_without_a_list(api, yt, show, caplog):
    yt.search(QUERY, "not a list")
    assert await trailer(api) is None
    assert "no search results list" in caplog.text


async def test_search_timeout_kills_it(api, yt, show, monkeypatch, caplog):
    monkeypatch.setattr(st, "SEARCH_TIMEOUT", 0.3)
    yt.gate(f"search:{QUERY}")
    try:
        assert await trailer(api) is None
        assert "search timed out" in caplog.text
        for _ in range(100):
            if not yt.alive():
                break
            await asyncio.sleep(0.05)
        assert yt.alive() == []
    finally:
        yt.release_all()


async def test_no_ytdlp_on_path(api, show, monkeypatch, caplog, tmp_path):
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    assert await trailer(api) is None
    assert "yt-dlp not on PATH" in caplog.text


async def test_ytdlp_cannot_start(api, show, monkeypatch, caplog, tmp_path):
    bad = tmp_path / "bin" / "yt-dlp"
    bad.parent.mkdir()
    bad.write_text("not executable")
    monkeypatch.setattr(st.shutil, "which", lambda name: str(bad))
    assert await trailer(api) is None
    assert "yt-dlp: [Errno 13]" in caplog.text


async def test_concurrent_requests_share_one_search(api, yt, show):
    yt.search(QUERY, results())
    yt.gate(f"search:{QUERY}")
    a = asyncio.create_task(trailer(api))
    b = asyncio.create_task(trailer(api))
    for _ in range(200):
        if yt.searched():
            break
        await asyncio.sleep(0.02)
    yt.release(f"search:{QUERY}")
    assert await asyncio.gather(a, b) == [TRAILER, TRAILER]
    assert yt.searched() == [QUERY]


async def test_cache_is_bounded(api, yt, sonarr, monkeypatch):
    monkeypatch.setattr(st, "CACHE_MAX", 2)
    for i, name in enumerate(["Alpha", "Bravo", "Charlie"]):
        sonarr.add_catalog(series_obj(900 + i, name, year=2020))
        yt.search(f"{name} official trailer", [e(f"{name} | Official Trailer", f"{name.lower():x<11}")])
        assert await trailer(api, media_id=900 + i) == f"{name.lower():x<11}"
    assert list(api.app_module.show_trailers._cache) == ["901", "902"]
    assert await trailer(api, media_id=900) == "alphaxxxxxx"  # evicted: searched again
    assert yt.searched().count("Alpha official trailer") == 2


async def test_a_show_without_a_premiere_year_gets_none(api, yt, sonarr):
    sonarr.add_catalog(series_obj(SHOW, "Stranger Things", year=None, firstAired=None))
    assert await trailer(api) is None
    assert yt.searched() == []


async def test_unknown_show_is_404_and_sonarr_down_is_503_uncached(api, yt, show, sonarr):
    body = await trailer(api, media_id=1, status=404)
    assert body["error"] == "not_found"
    yt.search(QUERY, results())
    sonarr.fail("/api/v3/series/lookup", status=500)
    assert (await trailer(api, status=503))["error"] == "temporarily_unavailable"
    assert yt.searched() == []
    assert await trailer(api) == TRAILER  # nothing was cached


async def test_a_failed_name_lookup_is_503_not_a_guess(api, yt, show, radarr):
    """Without Radarr's answer the name can't be known to be unambiguous."""
    yt.search(QUERY, results())
    radarr.fail("/api/v3/movie/lookup", status=500)
    assert (await trailer(api, status=503))["error"] == "temporarily_unavailable"
    assert await trailer(api) == TRAILER


async def test_without_radarr_films_are_not_checked(make_api, yt, show):
    async with make_api(RADARR_API_KEY=None) as api:
        yt.search(QUERY, results())
        assert await trailer(api) == TRAILER


async def test_movie_trailer_is_radarrs(api, yt, radarr):
    radarr.add_catalog(movie_obj(438631, "Dune", year=2021, trailer="n9xhJrPXop4"))
    radarr.add_catalog(movie_obj(438632, "Dune 2", year=2024, trailer=None))
    assert await trailer(api, "movie", 438631) == "n9xhJrPXop4"
    assert await trailer(api, "movie", 438632) is None
    assert yt.searched() == []


async def test_bad_requests(api):
    assert (await trailer(api, "music", 1, status=400))["error"] == "bad_type"
    r = await api.get("/api/metadata/tv/abc/trailer")
    assert r.status_code == 422


async def test_without_sonarr(make_api):
    async with make_api(SONARR_API_KEY=None) as api:
        assert (await trailer(api, status=503))["error"] == "not_available"
