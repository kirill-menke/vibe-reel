"""Undo an add, undo a season "Get", cancel a download — the reverse gear of
POST /api/library and POST /api/news/search, plus cancelling a grab.

  DELETE /api/library/{type}/{id}?undo=TOKEN   undo one add (the token POST
                                               /api/library handed out)
  DELETE /api/news/search/{TOKEN}              undo one season search
  DELETE /api/activity/{type}/{id}[?season=&episode=&blocklist=]
                                               cancel a title's (or one
                                               episode's) grabs in flight

Safety rules, in order of importance:

  * No library file is ever deleted. Titles are removed from Sonarr/Radarr
    with deleteFiles=false (hard-wired in ArrClient.delete_title), and an undo
    is refused (409 has_files / importing) once the arr counts a file or is
    importing one.
  * An undo reverts exactly one action: the token is minted by that POST, lives
    UNDO_TTL, is bound to the title, and the arr's own `added` stamp must agree
    that the title is the one we added.
  * Only grabs belonging to that action are removed: queue rows of the title
    (undo add), or grabs of that season made after the search started (undo
    Get), or the rows the caller named (cancel). Partial data goes with them;
    a torrent in reel-api's own manual-download category is never touched.

Tokens live in memory: a restart of the service ends every undo window (410),
which is fine for a 5-second "Undo" in a toast.

A search that is already running when the undo arrives can still grab
something a moment later: the arrs cannot cancel a started command, and a
running search judges releases against the title as it loaded it (monitored).
So an undo leaves a watcher behind that follows the title's grab history until
its commands have finished (SWEEP_QUIET without one, SWEEP_MAX at most) and
removes whatever lands. Undoing an add therefore *first* unmonitors the title
(every search the arr starts later skips it) and deletes it only once its
commands are done — measured on Radarr: deleted mid-search, the search still
grabbed 7 s later, and the arrs' history API hides grabs of a deleted title,
so nothing could have found that torrent again.
"""

import asyncio
import logging
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from .arr import ArrClient, _when

# Every action here changes the library, so each is logged to the journal —
# with its own handler: the service configures no logging beyond uvicorn's, and
# the root "reel_api" logger would drop INFO. (app.py logs its add/search
# lines through this logger too.)
log = logging.getLogger("reel_api.actions")
if not log.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(levelname)s:     [actions] %(message)s"))
    log.addHandler(_h)
    log.setLevel(logging.INFO)
    log.propagate = False

UNDO_TTL = 10 * 60  # s — a toast offers 5 s; this is slack for a slow network
SWEEP_EVERY = 5  # s
SWEEP_MAX = 5 * 60  # s
SWEEP_QUIET = 15  # s with no command running before the sweeper stops
SKEW = timedelta(seconds=5)  # arr clock vs ours
# A queue row the arr is moving into the library — too late to cancel.
_IMPORTING = {"importing", "imported"}


class UndoGone(Exception):
    """Unknown or expired undo token (also: the service restarted)."""


class Refused(Exception):
    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


class NothingToCancel(Exception):
    """No queue row matches — already cancelled, or imported meanwhile."""


@dataclass
class _Add:
    kind: str
    media_id: str
    arr_id: int
    title: str
    at: datetime
    born: float = field(default_factory=time.monotonic)
    result: dict | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    revived: bool = False  # re-added while its removal waited (revive_add)
    finished: bool = False  # the deferred removal has run


@dataclass
class _Get:
    media_id: str
    season: int
    title: str
    series_id: int
    series_was: bool
    season_was: bool
    flipped: list[int]
    season_episodes: list[int]
    command_id: int | None
    at: datetime
    born: float = field(default_factory=time.monotonic)
    result: dict | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


def _state(r: dict) -> str:
    return r.get("trackedDownloadState") or r.get("status") or ""


def _dl(r: dict) -> str:
    return (r.get("downloadId") or "").upper()


class Undo:
    def __init__(self, arr_clients: dict[str, ArrClient], qbit=None):
        self.arr = arr_clients
        self.qb = qbit  # QBittorrentClient or None
        self._adds: dict[str, _Add] = {}
        self._gets: dict[str, _Get] = {}
        self._tasks: set[asyncio.Task] = set()

    # ------------------------------------------------------------ tokens

    def _prune(self) -> None:
        now = time.monotonic()
        for store in (self._adds, self._gets):
            for k in [k for k, v in store.items() if now - v.born > UNDO_TTL]:
                del store[k]

    def remember_add(self, kind: str, media_id: str, arr_id: int | None, title: str,
                     at: datetime | None) -> str | None:
        if not arr_id:
            return None
        self._prune()
        token = secrets.token_urlsafe(16)
        self._adds[token] = _Add(kind, media_id, arr_id, title, at or datetime.now(timezone.utc))
        return token

    def remember_get(self, media_id: str, season: int, title: str, info: dict) -> str:
        self._prune()
        token = secrets.token_urlsafe(16)
        self._gets[token] = _Get(
            media_id=media_id, season=season, title=title,
            series_id=info["series_id"], series_was=info["series_was"],
            season_was=info["season_was"], flipped=list(info["flipped"]),
            season_episodes=list(info["season_episodes"]),
            command_id=info.get("command_id"), at=info["at"],
        )
        return token

    # ------------------------------------------------------------ qBittorrent

    async def _purge(self, hashes: set[str]) -> int:
        """Delete whatever of these torrents qBittorrent still has, with their
        partial data. The arr's queue DELETE (removeFromClient) normally did
        that already; this catches grabs the arr hasn't picked up into its
        queue yet. Never a torrent of reel-api's own manual category."""
        if not self.qb or not hashes:
            return 0
        rows = await self.qb.rows(sorted(hashes))
        doomed = [r["hash"] for r in rows if r.get("category") != self.qb.category]
        if doomed:
            await self.qb.delete_with_data(doomed)
            log.info("undo: deleted %d torrent(s) with data from qBittorrent: %s",
                     len(doomed), ", ".join(h[:8] for h in doomed))
        return len(doomed)

    # ------------------------------------------------------------ sweeper

    def _spawn(self, coro) -> None:
        task = asyncio.create_task(coro)  # held, so it isn't collected mid-run
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _watch(self, client: ArrClient, arr_id: int, since: datetime,
                     handled: set[str], episode_ids: set[int] | None, what: str,
                     stop=lambda: False) -> None:
        """Until the title's commands have been quiet for SWEEP_QUIET (at most
        SWEEP_MAX): remove every new grab of it (of these episodes) since
        `since`. `handled` is updated in place; `stop()` true ends the watch
        (the undo itself was overtaken, see revive_add)."""
        start = time.monotonic()
        quiet = None
        while time.monotonic() - start < SWEEP_MAX:
            await asyncio.sleep(SWEEP_EVERY)
            if stop():
                break
            try:
                new = await client.grabs_since(since, arr_id, episode_ids) - handled
                if new:
                    rows = [r for r in await client.queue_records() if _dl(r) in new]
                    await client.remove_downloads(rows)
                    await self._purge(new)
                    handled |= new
                    log.info("undo sweep (%s): removed %d late grab(s)", what, len(new))
                busy = await client.active_commands(arr_id)
            except Exception as e:  # keep sweeping; a blip must not end the watch
                log.warning("undo sweep (%s): %s", what, e)
                continue
            if busy:
                quiet = None
            elif quiet is None:
                quiet = time.monotonic()
            elif time.monotonic() - quiet >= SWEEP_QUIET:
                break
        log.info("undo sweep (%s) done after %.0f s", what, time.monotonic() - start)

    # ------------------------------------------------------------ undo add

    async def undo_add(self, kind: str, media_id: str, token: str) -> dict:
        """Refusals come first and synchronously (409); after them the title is
        unmonitored, its queued commands cancelled and its grabs removed at
        once. It is deleted from the arr right away when none of its commands
        is running ("removed"), else by the watcher once they are ("removing")."""
        self._prune()
        u = self._adds.get(token)
        if u is None or u.kind != kind or u.media_id != media_id:
            raise UndoGone(token)
        async with u.lock:
            if u.result is not None:  # repeated call: same answer
                return u.result
            client = self.arr[kind]
            obj = await client.title_by_id(u.arr_id)
            if obj is None:
                u.result = self._add_result(u, 0, "already_removed")
                return u.result
            if str(obj.get(client.spec["id_field"]) or "") != media_id:
                raise Refused("not_ours", "the library entry is no longer the title that was added")
            added = _when(obj.get("added"))
            if added and added < u.at - SKEW:
                raise Refused("not_ours", "that title was in the library before this add")
            if client.has_files(obj):
                raise Refused("has_files", f"“{u.title}” already has files in the library")
            rows = [r for r in await client.queue_records() if r.get(client.owner_field) == u.arr_id]
            if any(_state(r) in _IMPORTING for r in rows):
                raise Refused("importing", f"“{u.title}” is being imported right now")

            # No new grabs: searches the arr starts from now on skip an
            # unmonitored title; a queued (not yet started) one is dropped.
            await client.set_title_monitored(u.arr_id, False)
            for c in await client.active_commands(u.arr_id):
                if c.get("status") == "queued" and c.get("id"):
                    await client.cancel_command(c["id"])

            since = u.at - SKEW
            hashes = {_dl(r) for r in rows if _dl(r)} | await client.grabs_since(since, u.arr_id)
            await client.remove_downloads(rows)
            try:
                await self._purge(hashes)
            except Exception as e:  # the watcher retries
                log.warning("undo add: qBittorrent cleanup failed: %s", e)

            if await client.active_commands(u.arr_id):
                status = "removing"
                self._spawn(self._finish_add(client, u, since, hashes))
            else:
                await client.delete_title(u.arr_id)
                status = "removed"
            log.info("undo add: %s %s (%s, arr id %s): %d grab(s) removed, title %s",
                     kind, media_id, u.title, u.arr_id, len(hashes), status)
            u.result = self._add_result(u, len(hashes), status)
            return u.result

    def pending_removal(self, kind: str, media_id: str) -> _Add | None:
        """An undone add whose deferred removal hasn't run yet."""
        for u in self._adds.values():
            if (u.kind == kind and u.media_id == media_id and u.result
                    and u.result["status"] == "removing" and not u.revived and not u.finished):
                return u
        return None

    async def revive_add(self, u: _Add) -> dict:
        """The title is added again while its removal waits for a search to
        end (Undo pressed by mistake, then Add): keep it instead — monitored
        again, searched again — and hand out a fresh undo token."""
        u.revived = True
        client = self.arr[u.kind]
        await client.set_title_monitored(u.arr_id, True)
        await client.search_title(u.arr_id)
        log.info("undo add %s:%s: re-added before the removal ran — kept", u.kind, u.media_id)
        token = self.remember_add(u.kind, u.media_id, u.arr_id, u.title, u.at)
        return {"id": u.media_id, "type": u.kind, "title": u.title, "status": "added", "undo": token}

    async def _finish_add(self, client: ArrClient, u: _Add, since: datetime, handled: set[str]) -> None:
        """Wait out the title's running commands (while it still exists, so its
        grab history is visible), removing their grabs, then delete it."""
        what = f"add {u.kind}:{u.media_id}"
        try:
            await self._watch(client, u.arr_id, since, handled, None, what,
                              stop=lambda: u.revived)
            await self._finish_add_now(client, u, since, handled, what)
        finally:
            u.finished = True

    async def _finish_add_now(self, client: ArrClient, u: _Add, since: datetime,
                              handled: set[str], what: str) -> None:
        if u.revived:
            return
        try:
            obj = await client.title_by_id(u.arr_id)
            if obj is None:
                return
            if client.has_files(obj):  # never expected; never delete a file
                log.warning("undo %s: files appeared meanwhile — left in the library, unmonitored", what)
                return
            # the last word: anything grabbed between the watcher's final look and now
            late = await client.grabs_since(since, u.arr_id) - handled
            if late and not u.revived:
                await client.remove_downloads(
                    [r for r in await client.queue_records() if _dl(r) in late])
                await self._purge(late)
            if u.revived:  # re-added while this ran
                return
            await client.delete_title(u.arr_id)
            log.info("undo %s: title deleted after its commands finished (%d late grab(s))", what, len(late))
        except Exception as e:
            log.error("undo %s: could not finish: %s", what, e)

    @staticmethod
    def _add_result(u: _Add, n: int, status: str) -> dict:
        return {"id": u.media_id, "type": u.kind, "title": u.title,
                "status": status, "downloads_removed": n}

    # ------------------------------------------------------------ undo Get

    async def undo_get(self, token: str) -> dict:
        self._prune()
        u = self._gets.get(token)
        if u is None:
            raise UndoGone(token)
        async with u.lock:
            if u.result is not None:
                return u.result
            client = self.arr["tv"]
            if u.command_id:
                await client.cancel_command(u.command_id)
            # Monitoring first, so nothing re-grabs what is removed below.
            await client.restore_season_monitoring(
                u.series_id, u.season, series_was=u.series_was,
                season_was=u.season_was, flipped=u.flipped)

            since = u.at - SKEW
            eps = set(u.season_episodes)
            hashes = await client.grabs_since(since, u.series_id, eps)
            rows = []
            for r in await client.queue_records():
                if r.get("seriesId") != u.series_id:
                    continue
                grabbed_now = _dl(r) in hashes
                queued_at = _when(r.get("added"))
                in_season = r.get("episodeId") in eps and queued_at is not None and queued_at >= since
                if grabbed_now or in_season:
                    rows.append(r)
            busy = {_dl(r) for r in rows if _state(r) in _IMPORTING}
            rows = [r for r in rows if _dl(r) not in busy]
            hashes |= {_dl(r) for r in rows if _dl(r)}
            hashes -= busy
            await client.remove_downloads(rows)
            try:
                await self._purge(hashes)
            except Exception as e:
                log.warning("undo get: qBittorrent cleanup failed: %s", e)
            log.info("undo get: %s season %d (series %s): monitoring restored, %d grab(s) removed, %d kept (importing)",
                     u.title, u.season, u.series_id, len(hashes), len(busy))
            self._spawn(self._watch(client, u.series_id, since, hashes | busy, eps,
                                    f"get {u.media_id}:{u.season}"))
            u.result = {"id": u.media_id, "season": u.season, "title": u.title,
                        "status": "reverted", "downloads_removed": len(hashes),
                        "kept": len(busy)}
            return u.result

    # ------------------------------------------------------------ cancel

    async def cancel(self, kind: str, media_id: str, season: int | None = None,
                     episode: int | None = None, blocklist: bool = False) -> dict:
        """Cancel the grabs of one title (or one season / episode of it):
        remove them from the arr queue and qBittorrent (partial data deleted)
        and unmonitor what they were for, so the arr does not grab it again at
        the next RSS sync. `blocklist` additionally marks the release as bad —
        off by default, because a cancel is not a verdict on the release."""
        client = self.arr[kind]
        records = await client.queue_records()

        def wanted(r: dict) -> bool:
            if client.media_id_of(r) != media_id:
                return False
            ep = r.get("episode") or {}
            if season is not None and ep.get("seasonNumber") != season:
                return False
            if episode is not None and ep.get("episodeNumber") != episode:
                return False
            return True

        mine = [r for r in records if wanted(r)]
        if not mine:
            raise NothingToCancel(f"{kind}:{media_id}")
        # A torrent is all-or-nothing: cancelling one episode of a season pack
        # cancels the pack, so every row sharing its download goes too.
        dls = {_dl(r) for r in mine if _dl(r)}
        ids = {r.get("id") for r in mine}
        rows = [r for r in records if r.get("id") in ids or (_dl(r) and _dl(r) in dls)]
        busy = {_dl(r) or f"row:{r.get('id')}" for r in rows if _state(r) in _IMPORTING}
        rows = [r for r in rows if (_dl(r) or f"row:{r.get('id')}") not in busy]
        if not rows:
            raise Refused("importing", "already being imported into the library")

        if kind == "tv":
            episode_ids = [r["episodeId"] for r in rows if r.get("episodeId")]
            await client.set_episodes_monitored(episode_ids, False)
            unmonitored = len(set(episode_ids))
        else:
            movie_ids = {r["movieId"] for r in rows if r.get("movieId")}
            for mid in movie_ids:
                await client.set_movie_monitored(mid, False)
            unmonitored = len(movie_ids)

        removed = await client.remove_downloads(rows, blocklist=blocklist)
        try:
            await self._purge(removed)
        except Exception as e:
            log.warning("cancel: qBittorrent cleanup failed: %s", e)
        episodes = sorted(
            {((r.get("episode") or {}).get("seasonNumber"), (r.get("episode") or {}).get("episodeNumber"))
             for r in rows if r.get("episode")},
            key=lambda t: (t[0] or 0, t[1] or 0),
        )
        log.info("cancel %s %s season=%s episode=%s: %d download(s), %d unmonitored, blocklist=%s",
                 kind, media_id, season, episode, len(removed) or len(rows), unmonitored, blocklist)
        return {
            "id": media_id, "type": kind, "status": "cancelled",
            "downloads_removed": len(removed) or len({r.get("id") for r in rows}),
            "episodes": [{"season": s, "episode": e} for s, e in episodes],
            "unmonitored": unmonitored,
            "kept": len(busy),
        }
