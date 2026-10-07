"""Smoke test of the public-spec cache (tests/specs/fetch_specs.py,
tests/support/specs.py). Skips when the cache hasn't been fetched."""

from __future__ import annotations

import json

import pytest

from tests.specs.fetch_specs import SOURCES
from tests.support.specs import SpecCache, SpecMissing, qbit_endpoints

pytestmark = pytest.mark.spec


def test_sonarr_v4_openapi(spec_cache):
    doc = spec_cache.sonarr
    assert doc["openapi"].startswith("3.") and doc["info"]["title"] == "Sonarr"
    for path in ("/api/v3/series", "/api/v3/series/lookup", "/api/v3/queue", "/api/v3/episode",
                 "/api/v3/command", "/api/v3/history"):
        assert path in doc["paths"], path
    assert "SeriesResource" in doc["components"]["schemas"]


def test_radarr_v5_openapi(spec_cache):
    doc = spec_cache.radarr
    assert doc["openapi"].startswith("3.") and doc["info"]["title"] == "Radarr"
    for path in ("/api/v3/movie", "/api/v3/movie/lookup", "/api/v3/queue", "/api/v3/command"):
        assert path in doc["paths"], path
    assert "MovieResource" in doc["components"]["schemas"]


@pytest.mark.parametrize("which", ["qbit", "qbit41"])
def test_qbittorrent_webui_api_doc(spec_cache, which):
    eps = qbit_endpoints(getattr(spec_cache, which))
    for endpoint in ("/api/v2/auth/login", "/api/v2/torrents/info", "/api/v2/torrents/files",
                     "/api/v2/torrents/pieceStates", "/api/v2/torrents/setForceStart"):
        assert endpoint in eps, endpoint
    assert eps["/api/v2/torrents/files"].params == {"hash", "indexes"}
    assert eps["/api/v2/torrents/setForceStart"].params == {"hashes", "value"}
    assert {"hash", "name", "progress", "state"} <= eps["/api/v2/torrents/info"].fields
    assert len(eps) > 60


def test_manifest_lists_every_source_with_its_url(spec_cache):
    manifest = json.loads((spec_cache.root / "manifest.json").read_text())
    for name, url in SOURCES.items():
        assert manifest[name]["url"] == url
        assert len(manifest[name]["sha256"]) == 64


# These don't need the cache: they prove the "skip, don't fail" and the
# integrity behaviour on a scratch directory.


def test_missing_cache_reports_every_file(tmp_path):
    cache = SpecCache(tmp_path / "nothing")
    assert cache.missing() == list(SOURCES)
    with pytest.raises(SpecMissing):
        cache.sonarr


def test_a_tampered_file_fails_instead_of_validating(tmp_path):
    name = "sonarr-v4.openapi.json"
    (tmp_path / name).write_text('{"openapi": "3.0.1", "paths": {}}')
    (tmp_path / "manifest.json").write_text(json.dumps({name: {"url": SOURCES[name], "sha256": "0" * 64}}))
    with pytest.raises(AssertionError, match="sha256 differs"):
        SpecCache(tmp_path).sonarr
