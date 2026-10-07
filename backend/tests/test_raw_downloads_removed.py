"""The manual search/download API is gone (2026-10): no client called it —
src/ and phone/src only use /api/downloads/{id}/stream, /probe and /hls,
which work on any torrent by its info-hash.

Removed: GET /api/search, GET /api/torrents/{tid}/magnet, POST /api/downloads,
GET /api/downloads, GET /api/downloads/{gid}, DELETE /api/downloads/{gid};
with them the Prowlarr search client, the 1337x-style scraper, the aria2
backend and reel-api's own qBittorrent category ("reel", created at startup).
"""

from __future__ import annotations

import logging

import pytest

from tests.support.growing import GrowingFile
from tests.support.qbit import SimTorrent, make_hash

H = make_hash("removed-routes")

REMOVED = [
    ("GET", "/api/search?q=dune"),
    ("GET", "/api/torrents/77/magnet"),
    ("POST", "/api/downloads"),
    ("GET", "/api/downloads"),
    ("GET", f"/api/downloads/{H}"),
    ("DELETE", f"/api/downloads/{H}"),
]


@pytest.mark.parametrize("method, path", REMOVED)
async def test_removed_routes_are_404_and_reach_no_upstream(api, qbit, upstream, method, path):
    qbit.add_torrent(SimTorrent(hash=H, name="kept.mkv", category="radarr"))
    body = {"magnet": f"magnet:?xt=urn:btih:{H}"} if method == "POST" else None
    r = await api.request(method, path, json=body)
    assert r.status_code == 404, r.text
    assert r.json() == {"detail": "Not Found"}
    assert qbit.requests == []
    assert H in qbit.torrents  # nothing deleted


def test_removed_routes_are_not_in_the_openapi(app_module):
    paths = app_module.app.openapi()["paths"]
    assert not {"/api/search", "/api/torrents/{tid}/magnet", "/api/downloads", "/api/downloads/{gid}"} & set(paths)
    for p in paths:
        assert not p.startswith("/api/torrents"), p


async def test_startup_writes_nothing_to_qbittorrent(make_api, qbit):
    """No category is created any more: reel-api never adds a torrent."""
    async with make_api() as api:
        assert (await api.get("/health")).status_code == 200
    assert qbit.requests == []
    assert [k for k in qbit.endpoints if k[1] in ("/torrents/add", "/torrents/createCategory")] == []


async def test_obsolete_settings_are_ignored_silently(make_api, qbit, sonarr, radarr, upstream, caplog):
    """A host env file may still carry the old settings (PROWLARR_API_KEY
    stays in reel-api.env for the canary): they start nothing, ask nothing
    and are not logged."""
    caplog.set_level(logging.DEBUG)
    old = {"PROWLARR_URL": "http://prowlarr.test", "PROWLARR_API_KEY": "old-prowlarr-key",
           "PROWLARR_INDEXER_IDS": "1,2", "QBIT_CATEGORY": "reel", "QBIT_SAVE_PATH": "/srv/dl",
           "ARIA2_RPC_SECRET": "old-aria2-secret", "ARIA2_RPC_URL": "http://aria2.test/jsonrpc",
           "ARIA2_DOWNLOAD_DIR": "/srv/dl", "SCRAPER_BASE_URL": "http://scraper.test",
           "FLARESOLVERR_URL": "http://flaresolverr.test"}
    async with make_api(**old) as api:
        assert (await api.get("/api/activity")).status_code == 200
    hosts = {c.request.url.host for c in upstream.calls}
    assert not hosts & {"prowlarr.test", "aria2.test", "scraper.test", "flaresolverr.test"}, hosts
    for word in ("PROWLARR", "old-prowlarr-key", "ARIA2", "old-aria2-secret", "SCRAPER", "QBIT_CATEGORY",
                 "QBIT_SAVE_PATH", "qbit category", "createCategory"):
        assert word not in caplog.text, word


@pytest.mark.parametrize("category", ["radarr", "tv-sonarr", "", "reel"])
async def test_stream_probe_and_hls_work_by_info_hash_whatever_the_category(api, qbit, tmp_path, category):
    """The kept routes look a torrent up by its info-hash only: an arr grab
    (radarr / tv-sonarr), an uncategorised torrent and a leftover manual grab
    stream alike."""
    data = bytes(range(256)) * 1024
    g = GrowingFile(tmp_path / "Movie.mkv", data, piece_size=64 * 1024)
    g.grow_to(len(data))
    h = make_hash("by-hash-" + category)
    qbit.add_growing(h, g, category=category)
    head = await api.head(f"/api/downloads/{h.upper()}/stream")
    assert head.status_code == 200 and head.headers["content-length"] == str(len(data))
    r = await api.get(f"/api/downloads/{h}/stream", headers={"Range": "bytes=10-19"})
    assert r.status_code == 206 and r.content == data[10:20]
    hls = await api.get(f"/api/downloads/{h}/hls")
    assert hls.status_code == 404 and hls.json()["error"] == "not_found"  # not started: a job, not the torrent
    calls = [(m, p) for m, p, _ in qbit.calls]
    assert ("GET", "/torrents/info") in calls
    assert all(d.get("category") is None for _, _, d in qbit.calls)
