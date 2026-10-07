"""Who added which title, and how many each user may have.

Every title added through POST /api/library is recorded with the user who
added it (its *owner*), in $STATE_DIRECTORY/owners.json (statefile.py). A
title with no record — added before this existed, or straight in
Sonarr/Radarr — is *legacy*: treated as the admins' (any admin may act on it,
no normal user may) and counted against nobody's quota.

  admin   Jellyfin's Policy.IsAdministrator (security.User.admin): may do
          everything, no quota.
  owner   may delete the title (with its files), cancel its grabs, undo its add.
  season  POST /api/news/search records who asked for a season; that user may
          cancel the season's grabs made since they asked — what their request
          caused, never a grab that was in flight before it. The first
          requester holds the season until the record expires (a later
          request gets its undo token, not the record). Nothing else (no
          delete, no quota).

Quota: a normal user may own at most REEL_API_QUOTA_MOVIES movies and
REEL_API_QUOTA_SERIES series *that still exist* in Radarr/Sonarr, downloading
or downloaded (a series counts once, whatever its seasons). Existence comes
from a cached library listing (LIBRARY_TTL); a record written after the
listing was requested counts as existing, so a cached listing can never
under-count. A record missing from the listing counts against nothing (the
title was deleted outside reel-api: its slot is free again), and it is pruned
once two listings LIBRARY_TTL apart, both taken after it was written, lack
it — never from an empty listing (an arr hiccup must not wipe every record).

Every mutation is synchronous — no await between reading the state and
writing the file — and reel-api runs one uvicorn worker (server.py), so no two
mutations interleave. Adds of one user and kind serialise on quota_lock(), so
two concurrent adds at 9/10 can't both pass.
"""

import asyncio
import json
import logging
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .arr import _iso, _when
from .security import User
from .statefile import state_dir, write_json_atomic

log = logging.getLogger("reel_api.actions")  # handler: undo.py

VERSION = 1
SEASON_TTL = timedelta(days=30)  # a season request grants its cancel right this long
LIBRARY_TTL = 30  # s, a cached Sonarr/Radarr library listing
SKEW = timedelta(seconds=5)  # a record this much older than a listing's start may be missing from it
DEFAULT_LIMIT = 10
LIMIT_ENV = {"movie": "REEL_API_QUOTA_MOVIES", "tv": "REEL_API_QUOTA_SERIES"}
KINDS = ("movie", "tv")

_TITLE_KEY = re.compile(r"^(movie|tv):(\d{1,10})$")
_SEASON_KEY = re.compile(r"^tv:(\d{1,10}):(\d{1,3})$")
_NOUN = {"movie": ("movie", "movies"), "tv": ("show", "shows")}
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


class NotOwner(Exception):
    """The user may not do that to this title (app.py: 403 not_owner)."""

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


class QuotaExceeded(Exception):
    """A normal user's add over the limit (app.py: 409 quota_exceeded)."""

    def __init__(self, kind: str, used: int, limit: int):
        super().__init__(f"{kind} {used}/{limit}")
        self.kind, self.used, self.limit = kind, used, limit

    @property
    def detail(self) -> str:
        one, many = _NOUN[self.kind]
        if self.limit == 0:
            return f"Adding {many} is turned off for your account."
        return (f"You already have {self.used} of {self.limit} {many if self.limit != 1 else one}. "
                f"Delete one in My library to add another.")


def limits_from_env() -> dict[str, int]:
    """{"movie": n, "tv": n}: the env value when it is a non-negative
    integer, else DEFAULT_LIMIT (an invalid one with a warning)."""
    out = {}
    for kind, name in LIMIT_ENV.items():
        raw = os.environ.get(name, "").strip()
        out[kind] = DEFAULT_LIMIT
        if not raw:
            continue
        try:
            v = int(raw)
        except ValueError:
            v = -1
        if v < 0:
            log.warning("%s=%r is not a non-negative integer; using %d", name, raw, DEFAULT_LIMIT)
            continue
        out[kind] = v
    return out


def _at(rec: dict) -> datetime:
    return _when(rec.get("at")) or _EPOCH


def _stamp(d: datetime) -> str:
    return _iso(d.astimezone(timezone.utc))


def _season_stamp(at: datetime) -> str:
    """A season request's time, to the second and rounded UP: the arrs stamp a
    grab to the second, and one queued in the request's own second may
    predate it."""
    if at.microsecond:
        at = at.replace(microsecond=0) + timedelta(seconds=1)
    return _stamp(at)


class Owners:
    """owners.json in memory; every change is saved at once."""

    def __init__(self, path: Path | None = None):
        self.path = path or state_dir() / "owners.json"
        self.titles: dict[str, dict] = {}
        self.seasons: dict[str, dict] = {}
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}
        self._missing: dict[str, float] = {}  # "<kind>:<media id>" -> first listing (monotonic) without it
        self._load()

    # ------------------------------------------------------------ file

    def _load(self) -> None:
        try:
            raw = self.path.read_text()
        except FileNotFoundError:
            return
        except OSError as e:
            self._quarantine(f"unreadable ({e})")
            return
        try:
            st = json.loads(raw)
        except ValueError:
            st = None
        if not isinstance(st, dict) or st.get("version") != VERSION:
            self._quarantine("not a version-1 owners file")
            return
        for store, rx, name in ((self.titles, _TITLE_KEY, "titles"), (self.seasons, _SEASON_KEY, "seasons")):
            entries = st.get(name)
            if not isinstance(entries, dict):
                entries = {}
            for k, v in entries.items():
                if not rx.match(str(k)) or not isinstance(v, dict) or not isinstance(v.get("owner"), str) \
                        or not v["owner"]:
                    log.warning("owners.json: skipped a malformed %s entry %r", name, str(k)[:40])
                    continue
                store[k] = v
        self._expire_seasons()

    def _quarantine(self, why: str) -> None:
        bad = self.path.with_name(f"{self.path.name}.bad-{datetime.now(timezone.utc):%Y%m%dT%H%M%S}")
        log.error("owners.json %s: moved to %s; every title counts as an admin's until it is restored",
                  why, bad.name)
        try:
            os.replace(self.path, bad)
        except OSError as e:
            log.error("owners.json: could not move it aside: %s", e)

    def _save(self) -> None:
        self._expire_seasons()
        try:
            write_json_atomic(self.path, {"version": VERSION, "titles": self.titles, "seasons": self.seasons})
        except OSError as e:
            log.error("owners.json not saved (kept in memory until a restart): %s", e)

    def _expire_seasons(self) -> None:
        cutoff = datetime.now(timezone.utc) - SEASON_TTL
        for k in [k for k, v in self.seasons.items() if _at(v) < cutoff]:
            del self.seasons[k]

    # ------------------------------------------------------------ titles

    def title(self, kind: str, media_id: str) -> dict | None:
        return self.titles.get(f"{kind}:{media_id}")

    def record_title(self, kind: str, media_id: str, *, arr_id: int | None, title: str,
                     year: int | None, user: User, at: datetime) -> None:
        self.titles[f"{kind}:{media_id}"] = {
            "arr_id": arr_id, "title": title, "year": year,
            "owner": user.id, "owner_name": user.name, "at": _stamp(at),
        }
        self._save()

    def drop_title(self, kind: str, media_id: str) -> None:
        """The title's record and, for a series, its season requests."""
        gone = self.titles.pop(f"{kind}:{media_id}", None) is not None
        if kind == "tv":
            for k in [k for k in self.seasons if k.startswith(f"tv:{media_id}:")]:
                del self.seasons[k]
                gone = True
        if gone:
            self._save()

    def restore_title(self, kind: str, media_id: str, rec: dict) -> None:
        """Put back a record a failed delete had dropped — unless the title
        has a record again by then."""
        if self.title(kind, media_id) is None:
            self.titles[f"{kind}:{media_id}"] = rec
            self._save()

    def owned(self, user_id: str, kind: str | None = None) -> list[tuple[str, str, dict]]:
        """(kind, media id, record) of every title `user_id` owns."""
        out = []
        for k, v in self.titles.items():
            k_kind, _, mid = k.partition(":")
            if v["owner"] == user_id and (kind is None or k_kind == kind):
                out.append((k_kind, mid, v))
        return out

    # ------------------------------------------------------------ seasons

    def season(self, media_id: str, season: int) -> dict | None:
        rec = self.seasons.get(f"tv:{media_id}:{season}")
        if rec is None or _at(rec) < datetime.now(timezone.utc) - SEASON_TTL:
            return None
        return rec

    def record_season(self, media_id: str, season: int, user: User, at: datetime) -> bool:
        """The first requester holds the season: a live record is never
        overwritten — not by another user (it would take the first one's
        rights), not by the same one (a later `at` would only narrow them).
        True when this request was recorded."""
        if self.season(media_id, season) is not None:
            return False
        self.seasons[f"tv:{media_id}:{season}"] = {"owner": user.id, "owner_name": user.name,
                                                   "at": _season_stamp(at)}
        self._save()
        return True

    def drop_season(self, media_id: str, season: int, *, owner: str | None = None,
                    at: datetime | None = None) -> None:
        """With `owner`/`at`: only the record that request wrote (an undo of
        a Get that wasn't recorded, or of a replaced record, drops nothing)."""
        key = f"tv:{media_id}:{season}"
        rec = self.seasons.get(key)
        if rec is None or (owner is not None and rec["owner"] != owner) \
                or (at is not None and rec.get("at") != _season_stamp(at)):
            return
        del self.seasons[key]
        self._save()

    # ------------------------------------------------------------ rights

    def is_mine(self, user: User, kind: str, media_id: str | None, season: int | None = None,
                grabbed_at: datetime | None = None) -> bool:
        """The user owns the title, or (a tv row grabbed at `grabbed_at`) asked
        for that season before the grab. A grab of unknown time is not a
        season requester's."""
        if not media_id:
            return False
        rec = self.title(kind, media_id)
        if rec is not None and rec["owner"] == user.id:
            return True
        if kind == "tv" and season is not None and grabbed_at is not None:
            s = self.season(media_id, season)
            return s is not None and s["owner"] == user.id and grabbed_at >= _at(s)
        return False

    def may(self, user: User, kind: str, media_id: str | None, season: int | None = None,
            grabbed_at: datetime | None = None) -> bool:
        return user.admin or self.is_mine(user, kind, media_id, season, grabbed_at)

    # ------------------------------------------------------------ quota

    def prune(self, kind: str, present: set[str], listed_at: datetime,
              fetched: float | None = None) -> list[str]:
        """Drop the records of titles that left the library outside reel-api:
        missing from two listings fetched (monotonic `fetched`, default now)
        at least LIBRARY_TTL apart, both requested after the record was
        written (+SKEW). An empty listing prunes nothing — an arr hiccup that
        answers [] must not wipe every owner's rights. Returns the dropped
        title keys."""
        if fetched is None:
            fetched = time.monotonic()
        cutoff = listed_at - SKEW
        titles = [k for k, v in self.titles.items()
                  if k.startswith(kind + ":") and k.partition(":")[2] not in present and _at(v) < cutoff]
        seasons = [] if kind != "tv" else [
            k for k, v in self.seasons.items() if k.split(":")[1] not in present and _at(v) < cutoff]
        if not present:
            if titles or seasons:
                log.warning("%s library listing is empty: %d owner record(s) kept", kind,
                            len(titles) + len(seasons))
            return []
        missing = {f"{kind}:{k.split(':')[1]}" for k in titles + seasons}
        for k in [k for k in self._missing if k.startswith(kind + ":") and k not in missing]:
            del self._missing[k]  # listed again: starts over
        ripe = {k for k in missing if fetched - self._missing.setdefault(k, fetched) >= LIBRARY_TTL}
        dropped = [k for k in titles if k in ripe]
        seasons = [k for k in seasons if f"tv:{k.split(':')[1]}" in ripe]
        for k in ripe:
            del self._missing[k]
        for k in dropped:
            log.info("owner record dropped: %s left the library outside reel-api",
                     self.titles[k].get("title") or k)
            del self.titles[k]
        for k in seasons:
            del self.seasons[k]
        if len(dropped) > 3:
            log.warning("%d %s owner records dropped at once (missing from two library listings)",
                        len(dropped), kind)
        if dropped or seasons:
            self._save()
        return dropped

    def quota_lock(self, user_id: str, kind: str) -> asyncio.Lock:
        return self._locks.setdefault((user_id, kind), asyncio.Lock())


def exists(rec: dict, media_id: str, listing: "Listing") -> bool:
    """In the listing, or recorded after the listing was requested."""
    return media_id in listing.by_id or _at(rec) >= listing.started - SKEW


@dataclass
class Listing:
    started: datetime  # wall clock, taken before the request was sent
    fetched: float  # monotonic, for the TTL
    by_id: dict[str, dict]  # media id -> the arr's series/movie object


class Listings:
    """One cached library listing per kind (GET /api/v3/series|movie);
    concurrent callers share one request."""

    def __init__(self, arr_clients: dict):
        self.arr = arr_clients
        self._cache: dict[str, Listing] = {}
        self._inflight: dict[str, asyncio.Task] = {}
        self._gen: dict[str, int] = {}

    def invalidate(self, kind: str) -> None:
        self._cache.pop(kind, None)
        self._gen[kind] = self._gen.get(kind, 0) + 1  # an answer in flight is not cached

    async def get(self, kind: str) -> Listing:
        hit = self._cache.get(kind)
        if hit is not None and time.monotonic() - hit.fetched < LIBRARY_TTL:
            return hit
        task = self._inflight.get(kind)
        if task is None:
            client = self.arr[kind]
            gen = self._gen.get(kind, 0)

            async def run():
                try:
                    started = datetime.now(timezone.utc)
                    items = await client.titles()
                    field = client.spec["id_field"]
                    listing = Listing(started, time.monotonic(),
                                      {str(v): it for it in items if (v := it.get(field))})
                    if self._gen.get(kind, 0) == gen:
                        self._cache[kind] = listing
                    return listing
                finally:
                    self._inflight.pop(kind, None)

            task = self._inflight[kind] = asyncio.create_task(run())
        return await asyncio.shield(task)


class Quota:
    """Counting what users own against the configured limits."""

    def __init__(self, owners: Owners, listings: Listings, limits: dict[str, int]):
        self.owners = owners
        self.listings = listings
        self.limits = limits

    async def listing(self, kind: str) -> Listing:
        """The (cached) listing, after pruning the records it proves stale."""
        listing = await self.listings.get(kind)
        self.owners.prune(kind, set(listing.by_id), listing.started, listing.fetched)
        return listing

    async def used(self, user: User, kind: str) -> int:
        listing = await self.listing(kind)
        return sum(1 for _, mid, rec in self.owners.owned(user.id, kind) if exists(rec, mid, listing))

    async def check(self, user: User, kind: str) -> None:
        """Raises QuotaExceeded when a normal user is at the limit. Run it
        inside quota_lock(user.id, kind), together with the add it guards."""
        if user.admin:
            return
        limit = self.limits[kind]
        used = await self.used(user, kind)
        if used >= limit:
            raise QuotaExceeded(kind, used, limit)
