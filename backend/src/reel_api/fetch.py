"""The fetch layer of the scraper fallback — the part that keeps changing.

Two implementations behind one interface:

- DirectFetcher: curl_cffi with Chrome TLS impersonation. Cheap, but blocked
  whenever the site runs a Cloudflare interactive challenge (as Cloudflare-
  gated public trackers commonly do).
- FlareSolverrFetcher: proxies through a FlareSolverr instance
  (docker run -p 8191:8191 ghcr.io/flaresolverr/flaresolverr:latest),
  which drives a real browser to pass the challenge and reuses the
  clearance cookie across requests.

Selected via the FLARESOLVERR_URL env var; unset means direct.
"""

import asyncio
import os
import time

import httpx

from .errors import UpstreamBlocked, UpstreamHttpError

REQUEST_DELAY = 2.0  # seconds between upstream fetches, like the reference scrapers

_CF_MARKERS = ("cf-chl", "challenge-platform", "Just a moment", "_cf_chl_opt")


def looks_blocked(status: int, text: str) -> bool:
    return status in (403, 503) and any(m in text for m in _CF_MARKERS)


class BaseFetcher:
    """Serializes upstream requests and enforces a polite delay."""

    def __init__(self):
        self._lock = asyncio.Lock()
        self._last_fetch = 0.0

    async def get(self, url: str) -> str:
        async with self._lock:
            wait = REQUEST_DELAY - (time.monotonic() - self._last_fetch)
            if wait > 0:
                await asyncio.sleep(wait)
            try:
                return await self._get(url)
            finally:
                self._last_fetch = time.monotonic()

    async def _get(self, url: str) -> str:
        raise NotImplementedError


class DirectFetcher(BaseFetcher):
    async def _get(self, url: str) -> str:
        from curl_cffi import requests as curl_requests  # optional scraper dep

        def fetch():
            return curl_requests.get(url, impersonate="chrome", timeout=25)

        r = await asyncio.to_thread(fetch)
        if looks_blocked(r.status_code, r.text):
            raise UpstreamBlocked("cloudflare challenge on direct fetch")
        if r.status_code != 200:
            raise UpstreamHttpError(r.status_code)
        return r.text


class FlareSolverrFetcher(BaseFetcher):
    def __init__(self, solver_url: str):
        super().__init__()
        self.endpoint = solver_url.rstrip("/") + "/v1"
        self.session_id: str | None = None
        self._client = httpx.AsyncClient(timeout=90)

    async def _cmd(self, payload: dict) -> dict:
        r = await self._client.post(self.endpoint, json=payload)
        r.raise_for_status()
        return r.json()

    async def _ensure_session(self) -> str:
        if self.session_id is None:
            data = await self._cmd({"cmd": "sessions.create"})
            self.session_id = data["session"]
        return self.session_id

    async def _get(self, url: str) -> str:
        session = await self._ensure_session()
        payload = {"cmd": "request.get", "url": url, "session": session, "maxTimeout": 90000}
        data = await self._cmd(payload)
        if data.get("status") != "ok" and "Timeout" in data.get("message", ""):
            # challenge solving is flaky; one retry in the same session often
            # sails through ("Challenge not detected") on the second attempt
            data = await self._cmd(payload)
        if data.get("status") != "ok":
            msg = data.get("message", "")
            if "Challenge" in msg or "challenge" in msg:
                raise UpstreamBlocked(f"flaresolverr could not solve: {msg}")
            raise UpstreamHttpError(502)
        solution = data["solution"]
        status = solution.get("status", 200)
        text = solution.get("response", "")
        if looks_blocked(status, text):
            raise UpstreamBlocked("challenge page returned through flaresolverr")
        if status != 200:
            raise UpstreamHttpError(status)
        return text


def make_fetcher() -> BaseFetcher:
    solver = os.environ.get("FLARESOLVERR_URL")
    if solver:
        return FlareSolverrFetcher(solver)
    return DirectFetcher()
