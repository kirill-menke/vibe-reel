"""GET /api/activity: the arr queues shaped per row (arr._shape_queue), paged
(queue_records), overlaid with qBittorrent's live progress/speed, sorted, and
the sequential-download fix-up for torrents that lack it."""

import asyncio
import logging

import httpx
import pytest

from reel_api import arr as arr_mod
from reel_api.arr import ArrClient
from tests.conftest import RADARR, RADARR_KEY, SONARR, SONARR_KEY
from tests.support.arr import episode_obj, movie_obj, queue_record, season_obj, series_obj
from tests.support.qbit import SimFile, SimTorrent, make_hash

QUEUE = "/api/v3/queue"
SEQ = "/torrents/toggleSequentialDownload"
FLP = "/torrents/toggleFirstLastPiecePrio"


def H(seed: str) -> str:
    """Sonarr/Radarr report downloadId uppercase."""
    return make_hash(seed).upper()


def tv_client():
    return ArrClient("tv", SONARR, SONARR_KEY, "x")


def movie_client():
    return ArrClient("movie", RADARR, RADARR_KEY, "x")


def show(sonarr, tvdb=81189, title="Breaking Bad", eps=3, year=2008):
    s = sonarr.add_series(series_obj(tvdb, title, year=year, seasons=[season_obj(1)]),
                          [episode_obj(1, i, title=f"Ep {i}") for i in range(1, eps + 1)])
    return s, [e["id"] for e in sonarr.episodes_of(s["id"])]


def torrent(qbit, seed, *, state="downloading", progress_pieces=(2, 2, 0, 0), dlspeed=0, eta=8640000,
            seq=True, flp=True, category="tv-sonarr"):
    return qbit.add_torrent(SimTorrent(hash=make_hash(seed), name=seed, category=category, state=state,
                                       files=[SimFile(f"{seed}.mkv", 4 * 65536)], pieces=list(progress_pieces),
                                       dlspeed=dlspeed, eta=eta, seq_dl=seq, f_l_piece_prio=flp))


async def items(api):
    r = await api.get("/api/activity")
    assert r.status_code == 200, r.text
    return r.json()["items"]


async def settle(n=50):
    for _ in range(n):
        await asyncio.sleep(0)


# ---------------------------------------------------------------- _shape_queue


@pytest.mark.parametrize("state, status", [
    ("downloading", "downloading"),
    ("queued", "queued"),
    ("delay", "queued"),
    ("importPending", "importing"),
    ("importBlocked", "importing"),
    ("importing", "importing"),
    ("imported", "completed"),
    ("failedPending", "warning"),
    ("failed", "warning"),
    ("warning", "warning"),
    ("paused", "paused"),
    ("completed", "importing"),
    ("somethingNew", "downloading"),
    ("", "downloading"),
])
def test_tracked_state_maps_to_status(state, status):
    rec = queue_record(1, download_id=None, state=state, status="ignored-when-state-set")
    if not state:
        rec["status"] = ""
    assert tv_client()._shape_queue(rec)["status"] == status


@pytest.mark.parametrize("status, want", [("paused", "paused"), ("delay", "queued"), ("completed", "importing")])
def test_status_is_the_fallback_without_tracked_state(status, want):
    rec = queue_record(1, download_id=None, status=status)
    del rec["trackedDownloadState"]
    assert movie_client()._shape_queue(rec)["status"] == want


@pytest.mark.parametrize("size, left, progress, size_bytes", [
    (1000, 250, 0.75, 1000),
    (3, 2, 0.3333, 3),
    (1000, 0, 1.0, 1000),
    (0, 0, 0.0, None),
    (None, None, 0.0, None),
])
def test_progress_from_size_and_sizeleft(size, left, progress, size_bytes):
    out = tv_client()._shape_queue(queue_record(1, download_id=None, size=size, sizeleft=left))
    assert out["progress"] == progress and out["size_bytes"] == size_bytes


def test_tv_row_fields():
    rec = queue_record(77, download_id=H("a"), timeleft="01:02:03", quality_name="Bluray-2160p")
    rec["series"] = series_obj(81189, "Breaking Bad", year=2008)
    rec["episode"] = episode_obj(2, 5, title="Gliding Over All")
    out = tv_client()._shape_queue(rec)
    assert out == {
        "id": "77", "type": "tv", "title": "Breaking Bad", "subtitle": "S02E05 · Gliding Over All",
        "status": "downloading", "progress": 0.5, "size_bytes": 1_000_000_000, "timeleft": "01:02:03",
        "quality": "Bluray-2160p", "download_speed": 0, "message": None, "media_id": "81189",
        "season": 2, "episode": 5, "episode_title": "Gliding Over All",
        "poster": "https://artworks.thetvdb.com/banners/posters/81189.jpg", "year": 2008,
        "download_id": H("a"), "queued_at": rec["added"],  # internal, not in ActivityItem
    }


def test_tv_row_without_episode_or_series():
    rec = queue_record(3, download_id=None, title="Raw.Release.Name")
    rec["episode"] = episode_obj(1, 1, title="")
    out = tv_client()._shape_queue(rec)
    assert out["title"] == "Raw.Release.Name" and out["subtitle"] == "S01E01" and out["episode_title"] is None
    assert out["media_id"] is None and out["poster"] is None and out["year"] is None and out["download_id"] == ""
    bare = tv_client()._shape_queue({"id": 4})
    assert bare["subtitle"] == "" and bare["season"] is None and bare["quality"] is None


def test_movie_row_fields():
    rec = queue_record(9, download_id=H("m"))
    rec["movie"] = movie_obj(438631, "Dune", year=2021)
    out = movie_client()._shape_queue(rec)
    assert (out["type"], out["title"], out["subtitle"], out["media_id"], out["year"]) == \
        ("movie", "Dune", "2021", "438631", 2021)
    assert out["season"] is None and out["episode"] is None and out["episode_title"] is None
    assert out["poster"] == "https://image.tmdb.org/t/p/original/posters/438631.jpg"


def test_message_joins_dedupes_and_truncates():
    rec = queue_record(1, download_id=None, error="  Import   failed ",
                       status_messages=[{"title": "file.mkv", "messages": ["Import failed", "Not a sample"]},
                                        {"title": "other.mkv", "messages": []}])
    assert tv_client()._shape_queue(rec)["message"] == "Import failed; Not a sample"
    assert tv_client()._shape_queue(queue_record(1, download_id=None))["message"] is None
    long = queue_record(1, download_id=None, error="word " * 60)
    msg = tv_client()._shape_queue(long)["message"]
    assert len(msg) == arr_mod.MESSAGE_MAX and msg.endswith("…") and not msg[:-1].endswith(" ")
    exact = queue_record(1, download_id=None, error="x" * arr_mod.MESSAGE_MAX)
    assert tv_client()._shape_queue(exact)["message"] == "x" * arr_mod.MESSAGE_MAX


# ---------------------------------------------------------------- paging


async def test_queue_is_paged_until_total_records(api, sonarr, radarr, qbit):
    s, eps = show(sonarr, eps=10)
    for i in range(25):  # a few packs: 250 rows > one 200-row page
        sonarr.grab(s["id"], H(f"p{i}"), episode_ids=eps)
    got = await items(api)
    assert len(got) == 250
    calls = sonarr.called(QUEUE)
    assert [c.params["page"] for c in calls] == ["1", "2"]
    assert all(c.params["pageSize"] == "200" and c.params["includeSeries"] == "true"
               and c.params["includeEpisode"] == "true" for c in calls)
    assert radarr.called(QUEUE)[0].params == {"includeMovie": "true", "page": "1", "pageSize": "200"}


async def test_queue_paging_stops_at_max_pages(api, sonarr, radarr, qbit, monkeypatch):
    monkeypatch.setattr(arr_mod, "QUEUE_PAGE_SIZE", 2)
    s, eps = show(sonarr, eps=1)
    for i in range(arr_mod.QUEUE_MAX_PAGES * 2 + 10):
        sonarr.grab(s["id"], H(f"r{i}"), episode_ids=eps)
    got = await items(api)
    assert len(got) == arr_mod.QUEUE_MAX_PAGES * 2
    assert sonarr.count(QUEUE) == arr_mod.QUEUE_MAX_PAGES


async def test_queue_paging_stops_on_an_empty_page(api, sonarr, radarr, qbit):
    real = sonarr._queue

    def lying(call, m):  # totalRecords claims more than there is
        r = real(call, m)
        body = r.json()
        body["totalRecords"] = 10_000
        return httpx.Response(200, json=body)

    sonarr._routes = [(mth, rx, t, lying if t == QUEUE else h) for mth, rx, t, h in sonarr._routes]
    s, eps = show(sonarr, eps=3)
    sonarr.grab(s["id"], H("x"), episode_ids=eps)
    assert len(await items(api)) == 3
    assert sonarr.count(QUEUE) == 2


# ---------------------------------------------------------------- qBittorrent overlay


async def test_qbit_overlay_live_progress_speed_eta(api, sonarr, radarr, qbit):
    s, eps = show(sonarr, eps=1)
    sonarr.grab(s["id"], H("live"), episode_ids=eps, size=1000, sizeleft=900, timeleft="05:00:00")
    t = torrent(qbit, "live", state="stalledDL", dlspeed=7_400_000, eta=3725)
    t.row = lambda: {**SimTorrent.row(t), "progress": 0.123456}
    (it,) = await items(api)
    assert it["progress"] == 0.1235 and it["download_speed"] == 7_400_000
    assert it["timeleft"] == "1:02:05" and it["status"] == "downloading"
    assert it["download_id"] == make_hash("live")  # lowercase: the streaming handle


@pytest.mark.parametrize("eta, want", [(245, "4:05"), (59, "0:59"), (3600, "1:00:00"),
                                       (0, None), (8640000, None), (8640001, None)])
async def test_qbit_eta_formatting(api, sonarr, radarr, qbit, eta, want):
    s, eps = show(sonarr, eps=1)
    sonarr.grab(s["id"], H("e"), episode_ids=eps)
    torrent(qbit, "e", eta=eta)
    assert (await items(api))[0]["timeleft"] == want


@pytest.mark.parametrize("qstate, arr_state, want", [
    ("downloading", "queued", "downloading"),
    ("forcedDL", "queued", "downloading"),
    ("metaDL", "queued", "downloading"),
    ("stalledDL", "queued", "downloading"),
    ("checkingDL", "queued", "downloading"),
    ("allocating", "queued", "downloading"),
    ("queuedDL", "downloading", "queued"),
    ("stoppedDL", "downloading", "paused"),  # qBittorrent 5's name for pausedDL
    ("pausedDL", "downloading", "paused"),
    ("error", "warning", "warning"),  # other qBit states keep the arr's word
    ("uploading", "downloading", "downloading"),
    ("pausedUP", "downloading", "downloading"),  # finished: not a paused download
    ("stoppedUP", "downloading", "downloading"),  # ... on qBittorrent 5 either
    ("moving", "downloading", "downloading"),
    ("checkingResumeData", "downloading", "downloading"),
])
async def test_qbit_state_overrides_status(api, sonarr, radarr, qbit, qstate, arr_state, want):
    m = radarr.add_movie(movie_obj(5, "Alien"))
    radarr.grab(m["id"], H("s"), state=arr_state)
    torrent(qbit, "s", state=qstate)
    assert (await items(api))[0]["status"] == want


@pytest.mark.parametrize("arr_state, want", [("importing", "importing"), ("importPending", "importing"),
                                             ("importBlocked", "importing"), ("imported", "completed")])
async def test_no_overlay_for_importing_or_completed(api, sonarr, radarr, qbit, arr_state, want):
    m = radarr.add_movie(movie_obj(5, "Alien"))
    radarr.grab(m["id"], H("i"), state=arr_state, size=100, sizeleft=0, timeleft="00:00:00")
    torrent(qbit, "i", state="downloading", dlspeed=999, eta=10, seq=False, flp=False)
    (it,) = await items(api)
    assert (it["status"], it["progress"], it["download_speed"], it["timeleft"]) == (want, 1.0, 0, "00:00:00")
    await settle()
    assert qbit.called(SEQ) == [] and qbit.called(FLP) == []


async def test_rows_without_download_id_or_torrent(api, sonarr, radarr, qbit):
    m = radarr.add_movie(movie_obj(5, "Alien"))
    radarr.grab(m["id"], None, size=100, sizeleft=40)  # not handed to the client yet
    radarr.grab(m["id"], H("gone"), size=100, sizeleft=10)  # client lost it
    got = sorted(await items(api), key=lambda i: i["progress"])
    assert [(i["download_id"], i["progress"], i["download_speed"]) for i in got] == \
        [(None, 0.6, 0), (make_hash("gone"), 0.9, 0)]


async def test_sort_by_status_then_speed_then_progress(api, sonarr, radarr, qbit):
    m = radarr.add_movie(movie_obj(5, "Alien"))
    spec = [  # (seed, arr state, qbit state | None, speed, size left of 100)
        ("warn", "warning", None, 0, 50),
        ("imp", "importing", None, 0, 0),
        ("slow", "downloading", "downloading", 10, 20),
        ("fast", "downloading", "downloading", 99, 90),
        ("q-far", "queued", None, 0, 80),
        ("q-near", "queued", None, 0, 10),
        ("paused", "paused", None, 0, 50),
        ("done", "imported", None, 0, 0),
        ("odd", "downloading", "downloading", 10, 5),
    ]
    for seed, st, qst, speed, left in spec:
        radarr.grab(m["id"], H(seed), state=st, size=100, sizeleft=left)
        if qst:
            pieces = [2] * (100 - left) + [0] * left
            torrent(qbit, seed, state=qst, dlspeed=speed, progress_pieces=pieces)
    order = [i["download_id"] for i in await items(api)]
    want = ["fast", "odd", "slow", "imp", "q-near", "q-far", "warn", "paused", "done"]
    assert order == [make_hash(s) for s in want]


# ---------------------------------------------------------------- failures


async def test_one_arr_failing_still_returns_the_other(api, sonarr, radarr, qbit, caplog):
    s, eps = show(sonarr, eps=2)
    sonarr.grab(s["id"], H("tv"), episode_ids=eps)
    m = radarr.add_movie(movie_obj(5, "Alien"))
    radarr.grab(m["id"], H("mv"))
    radarr.fail(QUEUE, exc=httpx.ConnectError("down"))
    with caplog.at_level(logging.WARNING, logger="reel_api"):
        got = await items(api)
    assert {i["type"] for i in got} == {"tv"} and len(got) == 2
    assert "activity queue fetch failed" in caplog.text


async def test_qbit_failing_gives_arr_only_items(api, sonarr, radarr, qbit, caplog):
    m = radarr.add_movie(movie_obj(5, "Alien"))
    radarr.grab(m["id"], H("mv"), size=100, sizeleft=25, timeleft="00:01:00")
    torrent(qbit, "mv", dlspeed=5, eta=10)
    qbit.fail("/torrents/info", exc=httpx.ConnectError("down"))
    with caplog.at_level(logging.WARNING, logger="reel_api"):
        (it,) = await items(api)
    assert (it["progress"], it["download_speed"], it["timeleft"]) == (0.75, 0, "00:01:00")
    assert it["download_id"] == make_hash("mv")
    assert "activity qbit fetch failed" in caplog.text


async def test_both_arrs_failing_is_an_empty_200(api, sonarr, radarr, qbit):
    sonarr.fail(QUEUE, status=500)
    radarr.fail(QUEUE, status=503)
    assert await items(api) == []


async def test_no_arr_configured_is_empty_without_any_call(make_api, qbit):
    async with make_api(SONARR_API_KEY=None, RADARR_API_KEY=None) as api:
        assert await items(api) == []
    assert qbit.called("/torrents/info") == []


async def test_without_qbit_the_arr_rows_stand(make_api, radarr, sonarr):
    m = radarr.add_movie(movie_obj(5, "Alien"))
    radarr.grab(m["id"], H("mv"), size=100, sizeleft=50)
    async with make_api(QBIT_URL=None) as api:
        (it,) = await items(api)
    assert it["progress"] == 0.5 and it["download_id"] == make_hash("mv")


# ---------------------------------------------------------------- sequential fix-up


@pytest.mark.parametrize("seq, flp, want_seq, want_flp", [
    (False, False, True, True),
    (False, True, True, False),
    (True, False, False, True),
    (True, True, False, False),
])
async def test_missing_toggles_are_flipped_once(api, sonarr, radarr, qbit, seq, flp, want_seq, want_flp):
    m = radarr.add_movie(movie_obj(5, "Alien"))
    radarr.grab(m["id"], H("t"))
    t = torrent(qbit, "t", seq=seq, flp=flp)
    await items(api)
    await settle()
    assert len(qbit.called(SEQ)) == int(want_seq) and len(qbit.called(FLP)) == int(want_flp)
    assert t.seq_dl and t.f_l_piece_prio
    # idempotent: the next poll sees both flags on and toggles nothing
    await items(api)
    await settle()
    assert len(qbit.called(SEQ)) == int(want_seq) and len(qbit.called(FLP)) == int(want_flp)


async def test_toggles_batch_hashes_and_skip_paused(api, sonarr, radarr, qbit):
    m = radarr.add_movie(movie_obj(5, "Alien"))
    for seed, st in (("a", "downloading"), ("b", "queuedDL"), ("c", "pausedDL"), ("d", "error"),
                     ("e", "stoppedDL")):
        radarr.grab(m["id"], H(seed))
        torrent(qbit, seed, state=st, seq=False, flp=False)
    # a season pack: two rows, one torrent — toggled once
    s, eps = show(sonarr, eps=2)
    sonarr.grab(s["id"], H("pack"), episode_ids=eps)
    torrent(qbit, "pack", seq=False, flp=True)
    await items(api)
    await settle()
    (seq_call,) = qbit.called(SEQ)
    assert set(seq_call["hashes"].split("|")) == {make_hash(x) for x in ("a", "b", "pack")}
    (flp_call,) = qbit.called(FLP)
    assert set(flp_call["hashes"].split("|")) == {make_hash(x) for x in ("a", "b")}


async def test_toggle_failure_only_logs(api, sonarr, radarr, qbit, caplog):
    m = radarr.add_movie(movie_obj(5, "Alien"))
    radarr.grab(m["id"], H("t"))
    torrent(qbit, "t", seq=False, flp=False)
    qbit.fail(SEQ, exc=httpx.ConnectError("down"))
    with caplog.at_level(logging.WARNING, logger="reel_api"):
        assert len(await items(api)) == 1
        await settle()
    assert "could not force sequential download" in caplog.text
    # the next poll retries
    await items(api)
    await settle()
    assert len(qbit.called(SEQ)) == 2
