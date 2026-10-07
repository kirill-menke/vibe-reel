"""Community skip segments — IntroDB (https://introdb.app), for VibeReel's Skip chip.

  GET /api/segments/{imdb_id}/{season}/{episode}
      -> {intro, recap, outro}, each {start, end, submissions} or null

IntroDB is crowdsourced: people mark the intro / "previously on" recap / end
credits of an episode by hand, keyed by the *series'* IMDb id. VibeReel wants it
for one thing Jellyfin can't give it reliably: recaps. Intro Skipper's recap
detector finds a studio sting shared across a season's episodes (the HBO /
Netflix / "An Apple Original" card) and calls everything from 0:00 to the last
black frame before the intro a recap — on the NAS (measured 2026-09-28) that
was the cold open on three different series, and a real recap only on a
fourth, which IntroDB agrees with (1-35 s vs 0-36 s on one episode).

No key is needed to read. Answers are cached — an episode's segments hardly
ever change: HIT_TTL for an answer with data, MISS_TTL for "nothing submitted
yet" (submissions do trickle in). Errors are never raised to the client: a
failed lookup is "no community data", and is retried after ERR_TTL.
"""

import logging
import time
from collections import OrderedDict

import httpx

log = logging.getLogger("reel_api")

API = "https://api.introdb.app/segments"
HIT_TTL = 7 * 24 * 3600
MISS_TTL = 12 * 3600
ERR_TTL = 5 * 60
CACHE_MAX = 5000
KINDS = ("intro", "recap", "outro")


def _seg(v) -> dict | None:
    if not isinstance(v, dict):
        return None
    start, end = v.get("start_ms"), v.get("end_ms")
    if not all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in (start, end)):
        return None  # missing, or not a number ("1000", true, …)
    if end <= start:
        return None
    return {
        "start": round(start / 1000, 3),
        "end": round(end / 1000, 3),
        "submissions": int(v.get("submission_count") or 0),
    }


class IntroDB:
    def __init__(self):
        self._http = httpx.AsyncClient(timeout=8, headers={"User-Agent": "reel-api (VibeReel)"})
        self._cache: OrderedDict[tuple, tuple[float, float, dict]] = OrderedDict()

    async def get(self, imdb_id: str, season: int, episode: int) -> dict:
        key = (imdb_id, season, episode)
        hit = self._cache.get(key)
        if hit and time.monotonic() - hit[0] < hit[1]:
            self._cache.move_to_end(key)
            return hit[2]
        empty = {k: None for k in KINDS}
        try:
            r = await self._http.get(
                API, params={"imdb_id": imdb_id, "season": season, "episode": episode}
            )
            if r.status_code == 404:
                out, ttl = empty, MISS_TTL
            elif r.status_code != 200:
                raise httpx.HTTPError(f"HTTP {r.status_code}")
            else:
                data = r.json()
                if not isinstance(data, dict):
                    raise ValueError(f"answer is a {type(data).__name__}, not an object")
                out = {k: _seg(data.get(k)) for k in KINDS}
                ttl = HIT_TTL if any(out.values()) else MISS_TTL
        except (httpx.HTTPError, ValueError) as e:
            log.warning("introdb %s S%dE%d: %s", imdb_id, season, episode, e)
            if hit:
                return hit[2]
            out, ttl = empty, ERR_TTL
        self._cache[key] = (time.monotonic(), ttl, out)
        self._cache.move_to_end(key)
        while len(self._cache) > CACHE_MAX:
            self._cache.popitem(last=False)
        return out
