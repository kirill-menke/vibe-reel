"""Search backend backed by Prowlarr instead of scraping.

Prowlarr already manages whatever indexers the user configured, handles
Cloudflare challenges via its own FlareSolverr integration, and exposes
GET /api/v1/search across all of them.
This backend maps that onto the same contract the scraper served, so app.py and
models.py are unchanged.

How Prowlarr actually returns torrents (verified against the live instance):
its search results carry NO infoHash or magnetUrl — only a `guid` (usually the
indexer's detail-page URL, e.g. https://<tracker>/torrent/6710569/...) and a
proxied `downloadUrl`. Our opaque `id` is the numeric id in the guid when it
has one, else a number derived from the guid (see _release_id). The magnet is
resolved by fetching `downloadUrl` WITHOUT following redirects: with the indexer
set to preferMagnetUrl, Prowlarr 301s straight to the `magnet:` URI in the
Location header.

Because downloadUrl can't be reconstructed from the id alone, an id is only
resolvable to a magnet while it sits in the recent-search cache (1 h TTL). Cache
miss -> NoSuchRelease (404, "search again").
"""

import hashlib
import os
import re
import time

import httpx

GUID_ID_RE = re.compile(r"/torrent/(\d+)/")
BTIH_RE = re.compile(r"urn:btih:([0-9a-fA-F]{40}|[A-Z2-7]{32})")

# Our category enum -> Newznab category ids. Unmapped -> no category filter.
_CATEGORY_NEWZNAB = {
    "movies": [2000],
    "tv": [5000],
    "music": [3000],
    "anime": [5070],
    "documentaries": [],
    "games": [1000, 4000],
    "apps": [4000],
    "other": [8000],
    "xxx": [6000],
}

_SORT_KEY = {
    "time": lambda r: r.get("uploaded_at") or "",
    "size": lambda r: r.get("size_bytes") or 0,
    "seeders": lambda r: r.get("seeders") or 0,
    "leechers": lambda r: r.get("leechers") or 0,
}

_RELEASE_TTL = 3600  # seconds an id stays resolvable to a magnet


def _release_id(guid: str) -> str:
    """The indexer's own numeric id when the guid carries one (/torrent/<n>/),
    else a stable 15-hex-digit hash of the guid as a decimal number — numeric
    either way, which is what /api/torrents/{id}/magnet accepts."""
    m = GUID_ID_RE.search(guid)
    if m:
        return m.group(1)
    return str(int(hashlib.sha1(guid.encode()).hexdigest()[:15], 16))


class ProwlarrError(Exception):
    """Prowlarr unreachable or returned an error."""


class NoSuchRelease(Exception):
    """id is unknown / expired out of the search cache."""


def _fmt_size(n: int) -> str:
    if not n:
        return ""
    size = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1000 or unit == "TB":
            return f"{int(size)} B" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1000
    return ""


class ProwlarrBackend:
    def __init__(self, base_url: str, api_key: str, indexer_ids: list[int] | None):
        self.base_url = base_url.rstrip("/")
        self.indexer_ids = indexer_ids or []
        self._client = httpx.AsyncClient(timeout=60, headers={"X-Api-Key": api_key})
        # id -> (expires_at, downloadUrl)
        self._cache: dict[str, tuple[float, str]] = {}

    async def _get_json(self, path: str, params: list[tuple[str, str]]) -> object:
        try:
            r = await self._client.get(self.base_url + path, params=params)
        except httpx.HTTPError as e:
            raise ProwlarrError(f"prowlarr unreachable: {e}") from e
        if r.status_code != 200:
            raise ProwlarrError(f"prowlarr HTTP {r.status_code}")
        return r.json()

    async def search(self, q, category, sort, order, page, page_size=40) -> dict:
        params: list[tuple[str, str]] = [
            ("query", q),
            ("type", "search"),
            ("limit", "200"),
        ]
        for cat in _CATEGORY_NEWZNAB.get(category.value if category else "", []):
            params.append(("categories", str(cat)))
        for iid in self.indexer_ids:
            params.append(("indexerIds", str(iid)))

        raw = await self._get_json("/api/v1/search", params)

        results = []
        now = time.monotonic()
        for rel in raw:
            if (rel.get("protocol") or "torrent") != "torrent":
                continue
            guid = rel.get("guid") or ""
            download_url = rel.get("downloadUrl")
            if not guid or not download_url:
                continue
            tid = _release_id(guid)
            self._cache[tid] = (now + _RELEASE_TTL, download_url)
            size = int(rel.get("size") or 0)
            pub = rel.get("publishDate") or ""
            results.append(
                {
                    "id": tid,
                    "title": rel.get("title") or "",
                    "seeders": int(rel.get("seeders") or 0),
                    "leechers": int(rel.get("leechers") or 0),
                    "size_bytes": size or None,
                    "size": _fmt_size(size),
                    "uploaded_at": pub[:10] or None,
                }
            )

        if sort:
            results.sort(key=_SORT_KEY[sort.value], reverse=(order.value == "desc"))

        total_pages = max(1, (len(results) + page_size - 1) // page_size)
        start = (page - 1) * page_size
        return {"total_pages": total_pages, "results": results[start : start + page_size]}

    async def magnet(self, tid: str) -> dict:
        entry = self._cache.get(tid)
        if entry is None or entry[0] < time.monotonic():
            self._cache.pop(tid, None)
            raise NoSuchRelease(tid)
        download_url = entry[1]
        # preferMagnetUrl makes Prowlarr 301 to the magnet; read Location, don't follow.
        try:
            r = await self._client.get(download_url, follow_redirects=False)
        except httpx.HTTPError as e:
            raise ProwlarrError(f"magnet resolve failed: {e}") from e
        location = r.headers.get("location", "")
        if not location.startswith("magnet:"):
            raise ProwlarrError("download link did not resolve to a magnet")
        m = BTIH_RE.search(location)
        return {
            "id": tid,
            "magnet": location,
            "info_hash": m.group(1).upper() if m else None,
        }


def make_search_backend():
    """ProwlarrBackend when PROWLARR_API_KEY is set, else None (caller falls
    back to the scraper). Returning None keeps the scraper — and its curl_cffi
    / beautifulsoup4 deps — from being imported on a Prowlarr deployment."""
    api_key = os.environ.get("PROWLARR_API_KEY")
    if not api_key:
        return None
    base = os.environ.get("PROWLARR_URL", "http://127.0.0.1:9696")
    ids = os.environ.get("PROWLARR_INDEXER_IDS", "")
    indexer_ids = [int(x) for x in ids.replace(",", " ").split() if x.strip().isdigit()]
    return ProwlarrBackend(base, api_key, indexer_ids)
