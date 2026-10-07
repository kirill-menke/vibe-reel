"""Concurrency and documented regressions: each test pins one sentence of
the project CLAUDE.md or backend/README.md (quoted in its docstring) under
the concurrent conditions the clients produce — two clients polling, a stream
re-opened mid-flight, a lookup racing an add, caches expiring underneath.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from reel_api import streaming
from tests.support.arr import movie_obj, series_obj
from tests.support.clock import FakeClock
from tests.support.imdb import ImdbSim, ImdbTitle
from tests.support.qbit import make_hash
from tests.test_activity import FLP, H, SEQ, settle
from tests.test_activity import torrent as activity_torrent
from tests.test_streaming import CHUNK, GROWN, SIZE, blob, torrent  # noqa: F401  (fixtures)

LOOKUP = "/api/v3/series/lookup"


async def until(cond, timeout: float = 5.0, what: str = "condition"):
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not cond():
        if loop.time() > end:
            raise AssertionError(f"timed out waiting for {what}")
        await asyncio.sleep(0.005)


# ---------------------------------------------------------------- streams


def polls(qbit, h):
    return sum(1 for d in qbit.called("/torrents/pieceStates") if d.get("hash") == h)


async def waited_at_the_frontier(task, qbit, h, n=3):
    """Proof that a body is waiting, not done or about to be: it polls the
    piece states once per PIECE_POLL while it waits, so n more polls after
    this call mean it went round its wait loop n times and is still there."""
    start = polls(qbit, h)
    await until(lambda: polls(qbit, h) >= start + n or task.done(), what=f"{n} more piece-state polls")
    assert not task.done(), "the body ended instead of waiting at the frontier"


async def test_a_second_stream_for_the_same_hash_supersedes_the_first(api, qbit, torrent, blob, monkeypatch):
    """CLAUDE.md, watch while downloading: "Seeking past the frontier stalls
    until those bytes arrive" — and streaming.py: a waiting body "exits as soon
    as a newer stream for the same hash supersedes this one" (a seek = a new
    Range request; the old one must not keep polling for two minutes)."""
    h, g, _ = torrent  # GROWN = 1.5 windows of 3+ downloaded
    monkeypatch.setattr(streaming, "PIECE_POLL", 0.01)
    first = asyncio.create_task(api.get(f"/api/downloads/{h}/stream", headers={"Range": f"bytes=0-{SIZE - 1}"}))
    await until(lambda: streaming._stream_gen.get(h) == 1, what="the first stream to start")
    await waited_at_the_frontier(first, qbit, h)

    second = await api.get(f"/api/downloads/{h}/stream", headers={"Range": "bytes=1000-1999"})
    assert second.status_code == 206 and second.content == blob[1000:2000]
    assert streaming._stream_gen[h] == 2

    r = await asyncio.wait_for(first, 5)  # PIECE_WAIT_MAX is 120 s: only the supersede ends it this fast
    assert r.status_code == 206
    # the first body ended at the frontier window: everything it sent is the file's bytes
    assert r.content == blob[:CHUNK] and len(r.content) < SIZE
    assert GROWN < 2 * CHUNK


async def test_streams_of_different_hashes_do_not_supersede_each_other(api, qbit, tmp_path, monkeypatch):
    from tests.support.growing import GrowingFile

    monkeypatch.setattr(streaming, "PIECE_POLL", 0.01)
    data = bytes(range(256)) * (3 * CHUNK // 256)
    hs = []
    for seed in ("one", "two"):
        g = GrowingFile(tmp_path / seed / f"{seed}.mkv", data, piece_size=64 * 1024)
        g.grow_to(CHUNK)
        hs.append(make_hash(seed))
        qbit.add_growing(hs[-1], g)
    a = asyncio.create_task(api.get(f"/api/downloads/{hs[0]}/stream"))
    await until(lambda: streaming._stream_gen.get(hs[0]) == 1)
    b = await api.get(f"/api/downloads/{hs[1]}/stream", headers={"Range": "bytes=0-99"})
    assert b.status_code == 206
    await waited_at_the_frontier(a, qbit, hs[0])  # still waiting for its own frontier
    streaming._stream_gen[hs[0]] += 1  # end it (as a seek would)
    assert len((await asyncio.wait_for(a, 5)).content) == CHUNK


# ---------------------------------------------------------------- lookup vs add


async def test_lookups_in_flight_when_an_add_lands_answer_added(api, sonarr):
    """README: "a successful (or 409) POST /api/library marks the title added
    in every cached answer at once" — including answers still being computed:
    two different queries in flight while the add lands both say added=true,
    and so does the cached copy afterwards."""
    sonarr.add_catalog(series_obj(1, "Dark"))
    for term in ("dark", "dark tv"):
        sonarr.set_lookup(term, [series_obj(1, "Dark")])
    gate = sonarr.gate(LOOKUP, match=lambda c: c.params.get("term") in ("dark", "dark tv"))
    pending = [asyncio.create_task(api.get("/api/lookup", params={"q": q, "type": "tv"}))
               for q in ("dark", "dark tv")]
    await settle(50)
    assert not any(p.done() for p in pending)
    r = await api.post("/api/library", json={"id": "1", "type": "tv"})
    assert r.status_code == 202
    for t in list(api.app_module.undo._tasks):
        t.cancel()
    gate.set()
    for p in pending:
        body = (await p).json()
        assert [(x["id"], x["added"]) for x in body["results"]] == [("1", True)], body
    cached = await api.get("/api/lookup", params={"q": "dark", "type": "tv"})
    assert cached.json()["results"][0]["added"] is True
    # "dark tv" also tried its fallback "dark" (half-typed last word); the add
    # looked the id up; the cached answer above cost nothing
    assert sorted(c.params.get("term") for c in sonarr.called(LOOKUP)) == ["dark", "dark", "dark tv", "tvdb:1"]


# ---------------------------------------------------------------- IMDb dedupe


async def test_imdb_ids_resolving_to_one_title_appear_once_at_the_best_rank(api, upstream, sonarr, time_machine):
    """README charts: "IMDb ids that resolve to the same tvdb/tmdb title appear
    once, at the first (best) rank; the same holds for /api/trending." Both
    routes, the same split title (IMDb lists an anime twice, TheTVDB keeps one)."""
    import datetime as dt

    time_machine.move_to(dt.datetime(2026, 9, 1, 12, tzinfo=dt.timezone.utc), tick=False)
    imdb = ImdbSim(upstream)
    released = dt.date(2026, 7, 1)
    a, b, c = "tt9500001", "tt9500002", "tt9500003"
    imdb.add(ImdbTitle(b, "Split (part 2)", "tvSeries", rank=4, rating=8.6, release=released, releases=[released],
                       genres=["Animation"]),
             ImdbTitle(a, "Split", "tvSeries", rank=9, rating=8.7, release=released, releases=[released],
                       genres=["Animation"]),
             ImdbTitle(c, "Other", "tvSeries", rank=6, rating=8.5, release=released, releases=[released],
                       genres=["Animation"]))
    sonarr.add_catalog(series_obj(7001, "Split", imdb=a))
    sonarr.set_lookup("imdb:" + b, [series_obj(7001, "Split", imdb=a)])
    sonarr.add_catalog(series_obj(7003, "Other", imdb=c))
    imdb.set_chart("TOP_RATED_TV_SHOWS", [a, c, b])

    trend = (await api.get("/api/trending", params={"type": "tv"})).json()["results"]
    assert [(r["id"], r["imdb_id"], r["rank"]) for r in trend] == [("7001", b, 4), ("7003", c, 6)]

    top = (await api.get("/api/charts/top-tv")).json()["sections"][0]["results"]
    assert [(r["id"], r["imdb_id"], r["rank"]) for r in top] == [("7001", a, 1), ("7003", c, 2)]


# ---------------------------------------------------------------- sequential download


async def test_consecutive_polls_toggle_sequential_once(api, radarr, qbit):
    """CLAUDE.md: "reel-api forces every arr grab to download sequentially
    (+first/last-piece priority — the API only has toggles, so the activity
    endpoint flips flags it reads back)": a later poll sees the flags on and
    toggles nothing, however many polls follow."""
    m = radarr.add_movie(movie_obj(5, "Alien"))
    radarr.grab(m["id"], H("t"))
    t = activity_torrent(qbit, "t", seq=False, flp=False)
    for _ in range(4):
        assert (await api.get("/api/activity")).status_code == 200
        await settle()
    assert len(qbit.called(SEQ)) == 1 and len(qbit.called(FLP)) == 1
    assert t.seq_dl and t.f_l_piece_prio


async def test_concurrent_polls_toggle_sequential_once(api, radarr, qbit):
    """Two /api/activity polls that both read the flags before the first
    toggle lands (the TV and the phone polling every 4 s each) must still
    toggle sequential download and first/last-piece priority once, leaving
    both ON. Each poll used to schedule its own toggle and the second one
    turned both flags OFF again (F17): a hash toggled within the last
    `SEQ_RECENT` seconds is now left alone."""
    m = radarr.add_movie(movie_obj(5, "Alien"))
    radarr.grab(m["id"], H("t"))
    t = activity_torrent(qbit, "t", seq=False, flp=False)
    a, b = await asyncio.gather(api.get("/api/activity"), api.get("/api/activity"))
    assert a.status_code == b.status_code == 200
    await settle()
    assert (t.seq_dl, t.f_l_piece_prio) == (True, True)
    assert len(qbit.called(SEQ)) == 1 and len(qbit.called(FLP)) == 1


async def test_a_failed_sequential_toggle_is_retried_by_the_next_poll(api, radarr, qbit):
    """app.py: "best-effort: the next activity poll retries" — the F17 guard
    must not hold back a toggle that never landed."""
    m = radarr.add_movie(movie_obj(5, "Alien"))
    radarr.grab(m["id"], H("t"))
    t = activity_torrent(qbit, "t", seq=False, flp=False)
    qbit.fail(SEQ, exc=httpx.ConnectError("link down"))
    assert (await api.get("/api/activity")).status_code == 200
    await settle()
    assert (t.seq_dl, t.f_l_piece_prio) == (False, False)
    assert (await api.get("/api/activity")).status_code == 200
    await settle()
    assert (t.seq_dl, t.f_l_piece_prio) == (True, True)
    assert len(qbit.called(SEQ)) == 2 and len(qbit.called(FLP)) == 1


async def test_sequential_is_forced_again_once_the_guard_expires(api, radarr, qbit, monkeypatch):
    """The F17 guard only spans a few poll periods: a torrent whose flags were
    turned off again later (by hand, or a toggle qBittorrent dropped) is
    forced back on by a poll after `SEQ_RECENT`, not left rarest-first."""
    app = api.app_module
    clock = FakeClock().install(monkeypatch, app)
    m = radarr.add_movie(movie_obj(5, "Alien"))
    radarr.grab(m["id"], H("t"))
    t = activity_torrent(qbit, "t", seq=False, flp=False)
    assert (await api.get("/api/activity")).status_code == 200
    await settle()
    t.seq_dl = t.f_l_piece_prio = False
    clock.t += app.SEQ_RECENT / 2
    assert (await api.get("/api/activity")).status_code == 200
    await settle()
    assert len(qbit.called(SEQ)) == 1 and (t.seq_dl, t.f_l_piece_prio) == (False, False)
    clock.t += app.SEQ_RECENT
    assert (await api.get("/api/activity")).status_code == 200
    await settle()
    assert len(qbit.called(SEQ)) == 2 and (t.seq_dl, t.f_l_piece_prio) == (True, True)
    assert set(app._seq_recent) == {t.hash}
