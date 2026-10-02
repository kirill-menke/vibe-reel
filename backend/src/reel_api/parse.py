"""HTML parsing for the scraper fallback: listing and detail pages of a
1337x-style torrent site.

Selectors follow what the reference scrapers rely on (td.coll-* classes,
a[href^=/torrent/], a[href^=magnet:]) — the stable part of the site for years.
"""

import re
from datetime import datetime

from bs4 import BeautifulSoup

from .errors import UpstreamError

NO_RESULTS_MARKER = "No results were returned"
TORRENT_ID_RE = re.compile(r"^/torrent/(\d+)/")
BTIH_RE = re.compile(r"urn:btih:([0-9a-fA-F]{40}|[A-Z2-7]{32})")

_SIZE_UNITS = {
    "B": 1,
    "KB": 1000,
    "MB": 1000**2,
    "GB": 1000**3,
    "TB": 1000**4,
    "KIB": 1024,
    "MIB": 1024**2,
    "GIB": 1024**3,
    "TIB": 1024**4,
}


def parse_size(text: str) -> int | None:
    m = re.match(r"([\d.,]+)\s*([KMGT]?i?B)", text.strip(), re.IGNORECASE)
    if not m:
        return None
    value = float(m.group(1).replace(",", ""))
    unit = m.group(2).upper()
    if unit not in _SIZE_UNITS:
        return None
    return int(value * _SIZE_UNITS[unit])


def parse_date(text: str) -> str | None:
    """Best-effort parse of the listing dates to an ISO date string.

    Seen formats: "Nov. 2nd '24"  /  "7am Sep. 14th"  /  "2:12pm Today".
    Anything unparseable returns None; the raw string is kept alongside.
    """
    cleaned = re.sub(r"(\d)(st|nd|rd|th)\b", r"\1", text.strip())
    cleaned = cleaned.replace("'", "")
    now = datetime.now()
    for fmt, has_year in (
        ("%b. %d %y", True),
        ("%I%p %b. %d", False),
        ("%I:%M%p %b. %d", False),
        ("%b. %d", False),
    ):
        try:
            dt = datetime.strptime(cleaned, fmt)
            if not has_year:
                dt = dt.replace(year=now.year)
            return dt.date().isoformat()
        except ValueError:
            continue
    # time-only forms ("7am", "2:12pm") mean "today"
    if re.fullmatch(r"\d{1,2}(:\d{2})?\s*[ap]m", cleaned, re.IGNORECASE):
        return now.date().isoformat()
    return None


def parse_listing(html: str) -> dict:
    soup = BeautifulSoup(html, "lxml")
    body = soup.select_one("table.table-list tbody") or soup.find("tbody")

    if body is None:
        if NO_RESULTS_MARKER in html:
            return {"total_pages": 1, "results": []}
        raise UpstreamError("no results table and no 'no results' marker")

    results = []
    for row in body.find_all("tr"):
        name_cell = row.select_one("td.coll-1")
        if name_cell is None:
            continue
        detail_a = None
        for a in name_cell.find_all("a"):
            m = TORRENT_ID_RE.match(a.get("href", ""))
            if m:
                detail_a = a
                torrent_id = m.group(1)
                break
        if detail_a is None:
            continue

        seeds = row.select_one("td.coll-2")
        leeches = row.select_one("td.coll-3")
        date_cell = row.select_one("td.coll-date")
        size_cell = row.select_one("td.coll-4")

        # size cell is "1.4 GB<span class='seeds'>812</span>" — first text node only
        size_text = ""
        if size_cell is not None and size_cell.contents:
            size_text = str(size_cell.contents[0]).strip()

        uploaded_raw = date_cell.get_text(strip=True) if date_cell else ""

        results.append(
            {
                "id": torrent_id,
                "title": detail_a.get_text(strip=True),
                "seeders": int(seeds.get_text(strip=True) or 0) if seeds else 0,
                "leechers": int(leeches.get_text(strip=True) or 0) if leeches else 0,
                "size_bytes": parse_size(size_text),
                "size": size_text,
                "uploaded_at": parse_date(uploaded_raw),
            }
        )

    if not results and NO_RESULTS_MARKER not in html:
        raise UpstreamError("results table present but no parseable rows")

    total_pages = 1
    last = soup.select_one("div.pagination li.last a")
    if last is not None:
        m = re.search(r"/(\d+)/$", last.get("href", ""))
        if m:
            total_pages = int(m.group(1))
    elif pagination := soup.select_one("div.pagination"):
        numbers = [
            int(li.get_text(strip=True))
            for li in pagination.find_all("li")
            if li.get_text(strip=True).isdigit()
        ]
        if numbers:
            total_pages = max(numbers)

    return {"total_pages": total_pages, "results": results}


def parse_magnet(html: str) -> dict:
    soup = BeautifulSoup(html, "lxml")
    a = soup.find("a", href=re.compile(r"^magnet:"))
    if a is None:
        raise UpstreamError("detail page has no magnet link")
    magnet = a["href"]
    m = BTIH_RE.search(magnet)
    info_hash = m.group(1).upper() if m else None
    return {"magnet": magnet, "info_hash": info_hash}
