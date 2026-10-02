"""Exception types shared across backends, with no third-party imports so the
app can import them without pulling in the scraper's curl_cffi / beautifulsoup4.
"""


class UpstreamError(Exception):
    """A 200 response that doesn't look like what we expect (scraper)."""


class UpstreamBlocked(Exception):
    """Anti-bot challenge — retriable later, don't hammer (scraper)."""


class UpstreamHttpError(Exception):
    def __init__(self, status: int):
        super().__init__(f"upstream returned HTTP {status}")
        self.status = status
