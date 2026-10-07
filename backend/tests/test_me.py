"""GET /api/me: who the caller is, their quota use and the titles they own,
each with a live status (the same queue + qBittorrent rows /api/activity
builds) — what both apps' "My library" shows."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from reel_api.models import MeResponse
from reel_api.security import User
from tests.conftest import NICOLE_TOKEN, NICOLE_USER, TEST_AUTH, ZHENYA_TOKEN, auth_for
from tests.support.arr import episode_obj, movie_obj, season_obj, series_obj
from tests.support.qbit import SimFile, SimTorrent, make_hash

NA = auth_for(NICOLE_TOKEN)
ZA = auth_for(ZHENYA_TOKEN)
T0 = datetime(2026, 10, 5, 12, 0, 0, tzinfo=timezone.utc)
N = User(NICOLE_USER, "nicole", False)


@pytest.fixture(autouse=True)
def sims(sonarr, radarr, qbit):
    """Both arrs and qBittorrent answer (empty unless a test fills them)."""


def H(seed: str) -> str:
    return make_hash(seed).upper()


async def add(api, kind, media_id, auth=NA):
    r = await api.post("/api/library", json={"id": str(media_id), "type": kind}, headers={"Authorization": auth})
    assert r.status_code == 202, r.text


async def me(api, auth=NA):
    r = await api.get("/api/me", headers={"Authorization": auth})
    assert r.status_code == 200, r.text
    MeResponse.model_validate(r.json())
    return r.json()


def torrent(qbit, seed, state="downloading", pieces=(2, 0, 0, 0)):
    qbit.add_torrent(SimTorrent(hash=make_hash(seed), name=seed, category="radarr", state=state,
                                files=[SimFile(f"{seed}.mkv", 4 * 65536)], pieces=list(pieces),
                                seq_dl=True, f_l_piece_prio=True))


async def test_who_and_an_empty_library(api, qbit):
    body = await me(api, NA)
    assert body == {"user": {"id": NICOLE_USER, "name": "nicole"}, "admin": False,
                    "quota": {"movie": {"used": 0, "limit": 10}, "tv": {"used": 0, "limit": 10}},
                    "titles": []}
    admin = await me(api, TEST_AUTH)
    assert admin["admin"] is True and admin["user"]["name"] == "kirill"
    assert admin["quota"] == {"movie": {"used": 0, "limit": None}, "tv": {"used": 0, "limit": None}}


async def test_every_status_and_the_order(api, sonarr, radarr, qbit, time_machine):
    """In flight first (downloading, importing, queued, warning, paused), then
    waiting, then in the library; newest first within a group."""
    names = {}
    for i, m in enumerate(range(101, 108)):
        radarr.add_catalog(movie_obj(m, f"Movie {m}", year=2000 + i))
    sonarr.add_catalog(series_obj(81189, "Breaking Bad", year=2008, seasons=[season_obj(1), season_obj(2)]),
                       [episode_obj(1, 1, has_file=True), episode_obj(2, 1), episode_obj(2, 2)])
    order = [("movie", 101), ("movie", 102), ("movie", 103), ("movie", 104), ("movie", 105), ("movie", 106),
             ("movie", 107), ("tv", 81189)]
    for n, (kind, mid) in enumerate(order):
        time_machine.move_to(T0 + timedelta(minutes=n), tick=False)
        await add(api, kind, mid)
        names[mid] = (radarr if kind == "movie" else sonarr).title(mid)["id"]
    radarr.grab(names[101], H("a"))                                     # downloading, live 25 %
    torrent(qbit, "a")
    radarr.grab(names[102], H("b"), state="queued", sizeleft=250_000_000)  # queued, arr numbers: 75 %
    radarr.grab(names[103], H("c"), state="importPending")              # importing
    radarr.grab(names[104], H("d"))                                     # paused in qBittorrent
    torrent(qbit, "d", state="pausedDL")
    radarr.grab(names[105], H("e"), state="failedPending")              # warning
    radarr.grab(names[106], H("f"))                                     # imported: in the library
    radarr.import_grab(H("f"))
    # 107: nothing grabbed yet -> waiting
    sid = names[81189]
    s2e1 = sonarr.episode(sid, 2, 1)["id"]
    sonarr.grab(sid, H("s2"), episode_ids=[s2e1])                       # season 2 while season 1 is on disk
    torrent(qbit, "s2", pieces=(2, 2, 2, 0))

    titles = (await me(api))["titles"]
    got = [(t["id"], t["status"], t["progress"], t["has_files"]) for t in titles]
    assert got == [
        ("81189", "downloading", 0.75, True),
        ("101", "downloading", 0.25, False),
        ("103", "importing", 0.5, False),
        ("102", "queued", 0.75, False),
        ("105", "warning", 0.5, False),
        ("104", "paused", 0.25, False),
        ("107", "waiting", None, False),
        ("106", "in_library", None, True),
    ]
    first = titles[0]
    assert first == {"type": "tv", "id": "81189", "title": "Breaking Bad", "year": 2008,
                     "poster": "https://artworks.thetvdb.com/banners/posters/81189.jpg",
                     "added_at": "2026-10-05T12:07:00Z", "status": "downloading", "progress": 0.75,
                     "has_files": True}
    assert titles[-1]["poster"] == "https://image.tmdb.org/t/p/original/posters/106.jpg"
    assert (await me(api))["quota"] == {"movie": {"used": 7, "limit": 10}, "tv": {"used": 1, "limit": 10}}


async def test_progress_is_weighted_by_size_over_distinct_downloads(api, sonarr, qbit):
    sonarr.add_catalog(series_obj(81189, "Breaking Bad", seasons=[season_obj(1), season_obj(2)]),
                       [episode_obj(1, 1), episode_obj(1, 2), episode_obj(2, 1)])
    await add(api, "tv", 81189)
    sid = sonarr.title(81189)["id"]
    eps = [e["id"] for e in sonarr.episodes_of(sid)]
    # a season pack: two rows, one torrent, each row repeating the torrent's numbers
    sonarr.grab(sid, H("pack"), episode_ids=eps[:2], size=1000, sizeleft=500)
    sonarr.grab(sid, H("single"), episode_ids=eps[2:], size=3000, sizeleft=0)
    sonarr.queue.append({**sonarr.queue[-1], "id": 9999, "downloadId": None, "size": 0, "sizeleft": 0,
                         "trackedDownloadState": "downloading"})  # a row with no size and no hash
    t = (await me(api))["titles"][0]
    # (0.5 * 1000 + 1.0 * 3000) / 4000 — the pack once, the size-less row ignored by the weights
    assert t["progress"] == 0.875 and t["status"] == "downloading"


async def test_a_title_with_only_unsized_rows_averages(api, radarr, qbit):
    radarr.add_catalog(movie_obj(1, "A"))
    await add(api, "movie", 1)
    radarr.grab(radarr.title(1)["id"], None, size=0, sizeleft=0)
    assert (await me(api))["titles"][0]["progress"] == 0.0


async def test_completed_rows_and_other_titles_rows_are_ignored(api, sonarr, radarr, qbit):
    radarr.add_catalog(movie_obj(42, "Mine"))
    radarr.add_movie(movie_obj(43, "Not mine"))
    sonarr.add_series(series_obj(42, "A show with the same id", seasons=[season_obj(1)]), [episode_obj(1, 1)])
    await add(api, "movie", 42)
    radarr.grab(radarr.title(42)["id"], H("done"), state="imported")
    radarr.grab(radarr.title(43)["id"], H("other"))
    s = sonarr.title(42)
    sonarr.grab(s["id"], H("tv42"), episode_ids=[sonarr.episode(s["id"], 1, 1)["id"]])
    (t,) = (await me(api))["titles"]
    assert (t["id"], t["type"], t["status"], t["progress"]) == ("42", "movie", "waiting", None)


async def test_admin_sees_own_records_only_legacy_nobody(api, radarr, qbit):
    for m in (1, 2):
        radarr.add_catalog(movie_obj(m, f"M{m}"))
    radarr.add_movie(movie_obj(3, "Legacy"))
    await add(api, "movie", 1, TEST_AUTH)
    await add(api, "movie", 2, NA)
    admin = await me(api, TEST_AUTH)
    assert [t["id"] for t in admin["titles"]] == ["1"] and admin["quota"]["movie"]["used"] == 1
    assert [t["id"] for t in (await me(api, NA))["titles"]] == ["2"]
    assert (await me(api, ZA))["titles"] == []


async def test_a_record_not_yet_listed_uses_its_snapshot(api, radarr, qbit, time_machine):
    time_machine.move_to(T0, tick=False)
    await me(api)  # listing cached
    time_machine.move_to(T0 + timedelta(seconds=3), tick=False)
    api.app_module.owners.record_title("movie", "77", arr_id=None, title="Fresh", year=2026, user=N,
                                       at=T0 + timedelta(seconds=3))
    (t,) = (await me(api))["titles"]
    assert t == {"type": "movie", "id": "77", "title": "Fresh", "year": 2026, "poster": None,
                 "added_at": "2026-10-05T12:00:03Z", "status": "waiting", "progress": None, "has_files": False}


async def test_an_unconfigured_type_counts_nothing(make_api, radarr, qbit):
    radarr.add_catalog(movie_obj(1, "A"))
    async with make_api(SONARR_API_KEY=None) as api:
        await add(api, "movie", 1)
        body = await me(api)
    assert body["quota"] == {"movie": {"used": 1, "limit": 10}, "tv": {"used": 0, "limit": 10}}
    assert [t["type"] for t in body["titles"]] == ["movie"]


async def test_no_arr_at_all(make_api):
    async with make_api(SONARR_API_KEY=None, RADARR_API_KEY=None, QBIT_URL=None) as api:
        body = await me(api)
    assert body["quota"]["movie"] == {"used": 0, "limit": 10} and body["titles"] == []


@pytest.mark.parametrize("path", ["/api/v3/movie", "/api/v3/series"])
async def test_an_arr_listing_failure_is_503(api, sonarr, radarr, qbit, path):
    (radarr if "movie" in path else sonarr).fail(path, status=500)
    r = await api.get("/api/me", headers={"Authorization": NA})
    assert r.status_code == 503
    assert r.json() == {"error": "temporarily_unavailable",
                        "detail": "library service temporarily unavailable, retry later"}


async def test_without_a_token_is_401(make_api):
    async with make_api(auth=None) as api:
        assert (await api.get("/api/me")).status_code == 401
