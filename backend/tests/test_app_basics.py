"""App wiring: health, the route table, backends chosen from env at startup."""

import pytest


async def test_health(api):
    r = await api.get("/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_openapi_lists_every_contract_route(app_module):
    paths = app_module.app.openapi()["paths"]
    expected = {
        "/api/downloads/{gid}/stream": {"get", "head"},
        "/api/downloads/{gid}/probe": {"get"},
        "/api/downloads/{gid}/hls": {"get", "post"},
        "/api/downloads/{gid}/hls/{audio}/{name}": {"get"},
        "/api/lookup": {"get"},
        "/api/library": {"post"},
        "/api/library/{media_type}/{media_id}": {"delete"},
        "/api/trending": {"get"},
        "/api/charts": {"get"},
        "/api/charts/{key}": {"get"},
        "/api/collection/{cid}": {"get"},
        "/api/segments/{imdb_id}/{season}/{episode}": {"get"},
        "/api/trailers/{key}": {"get", "post"},
        "/api/trailers/{key}/{name}": {"get"},
        "/api/metadata/{media_type}/{media_id}": {"get"},
        "/api/news": {"get"},
        "/api/news/search": {"post"},
        "/api/news/search/{token}": {"delete"},
        "/api/activity": {"get"},
        "/api/me": {"get"},
        "/api/activity/{media_type}/{media_id}": {"delete"},
        "/api/push/config": {"get"},
        "/api/push/subscribe": {"post"},
        "/api/push/status": {"post"},
        "/api/push/unsubscribe": {"post"},
        "/api/push/test": {"post"},
        "/health": {"get"},
    }
    for path, methods in expected.items():
        assert path in paths, path
        assert methods <= set(paths[path]), (path, set(paths[path]))
    assert set(paths) == set(expected), set(paths) ^ set(expected)


async def test_downloads_without_qbittorrent_is_503(make_api):
    async with make_api(QBIT_URL=None) as api:
        r = await api.get(f"/api/downloads/{'a' * 40}/probe")
    assert r.status_code == 503
    assert r.json()["error"] == "temporarily_unavailable"
    assert r.headers["retry-after"] == "30"
    assert "qbit" not in r.text.lower()


@pytest.mark.parametrize("media_type,key", [("tv", "SONARR_API_KEY"), ("movie", "RADARR_API_KEY")])
async def test_lookup_type_without_its_key_is_503_not_available(make_api, media_type, key):
    async with make_api(**{key: None}) as api:
        r = await api.get("/api/lookup", params={"q": "x", "type": media_type})
    assert r.status_code == 503
    assert r.json()["error"] == "not_available"
