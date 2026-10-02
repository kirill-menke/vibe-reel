"""Scraper search backend — a direct scraper for one 1337x-style torrent site
(its URL scheme and markup), wrapped to expose the same search()/magnet()
interface as ProwlarrBackend. It is the dev/standalone fallback, used only
when Prowlarr is not configured AND SCRAPER_BASE_URL names the site; there is
no default site.
"""

from urllib.parse import quote

from .fetch import make_fetcher
from .parse import parse_listing, parse_magnet


class ScraperBackend:
    def __init__(self, base_url: str, fetcher=None):
        self.base_url = base_url.rstrip("/")
        self.fetcher = fetcher or make_fetcher()

    def _search_url(self, q, category, sort, order, page) -> str:
        query = quote(q.strip().replace(" ", "+"), safe="+")
        if sort and category:
            return f"{self.base_url}/sort-category-search/{query}/{category.site_value}/{sort.value}/{order.value}/{page}/"
        if sort:
            return f"{self.base_url}/sort-search/{query}/{sort.value}/{order.value}/{page}/"
        if category:
            return f"{self.base_url}/category-search/{query}/{category.site_value}/{page}/"
        return f"{self.base_url}/search/{query}/{page}/"

    async def search(self, q, category, sort, order, page, page_size=40) -> dict:
        html = await self.fetcher.get(self._search_url(q, category, sort, order, page))
        return parse_listing(html)

    async def magnet(self, tid: str) -> dict:
        html = await self.fetcher.get(f"{self.base_url}/torrent/{tid}/x/")
        return {"id": tid, **parse_magnet(html)}
