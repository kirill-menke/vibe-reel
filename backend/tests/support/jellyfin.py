"""A small stateful fake Jellyfin (12.x) for what reel-api asks of it.

reel-api only reads Jellyfin in push.py, always *as a user* (the token in a
`MediaBrowser ... Token="..."` Authorization header):

  GET /Users/Me                          -> UserDto          (401: unknown token)
  GET /Items?SearchTerm=&IncludeItemTypes=&userId=&...       -> {Items, TotalRecordCount}
  GET /Shows/{id}/Episodes?userId=&IsMissing=false&...       -> {Items, TotalRecordCount}

Per-user state: which items a user can see (`visible_to`, default everyone)
and what they have played (`played`). Faults: `fail(path, status=|exc=)`
(one-shot, path = "/Items", "/Users/Me" or "/Shows/{id}/Episodes";
`times=` for more than one). `calls` records (path, params, token).

Checked against Jellyfin 12.1's OpenAPI (tests/support/jfspec.py, a fetched
subset): every request it gets and every answer it gives is validated, and
`violations` collects what doesn't match — the `jellyfin_spec_guard` fixture
(conftest.py) fails the test at teardown. Answers follow the DTOs: ids are
dashless Guids, `UserData` carries its required `Key` and its always-written
members, nulls are left out (Jellyfin doesn't write them), and optional
fields (`ProviderIds`, `DateCreated`) appear only when `Fields` asks.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field

import httpx

from tests.support.jfspec import jf_spec

SERVER_ID = uuid.uuid5(uuid.NAMESPACE_URL, "jellyfin:server").hex
CREATED = "2026-09-01T12:00:00.0000000Z"
LIVE: list = []  # every JellyfinSim of the running test (conftest's guard checks them)

_TOKEN = re.compile(r'Token="([^"]*)"')


def user_policy(admin: bool) -> dict:
    """A UserDto's Policy as 12.1 writes it (UserPolicy; the scalar fields,
    defaults of a fresh user). The request guard reads IsAdministrator."""
    return {"IsAdministrator": admin, "IsHidden": admin, "EnableCollectionManagement": admin,
            "EnableSubtitleManagement": admin, "EnableLyricManagement": admin, "IsDisabled": False,
            "BlockedTags": [], "AllowedTags": [], "EnableUserPreferenceAccess": True,
            "AccessSchedules": [], "BlockUnratedItems": [], "EnableRemoteControlOfOtherUsers": admin,
            "EnableSharedDeviceControl": True, "EnableRemoteAccess": True,
            "EnableLiveTvManagement": admin, "EnableLiveTvAccess": True, "EnableMediaPlayback": True,
            "EnableAudioPlaybackTranscoding": True, "EnableVideoPlaybackTranscoding": True,
            "EnablePlaybackRemuxing": True, "ForceRemoteSourceTranscoding": False,
            "EnableContentDeletion": admin, "EnableContentDeletionFromFolders": [],
            "EnableContentDownloading": True, "EnableSyncTranscoding": True, "EnableMediaConversion": True,
            "EnabledDevices": [], "EnableAllDevices": True, "EnabledChannels": [], "EnableAllChannels": True,
            "EnabledFolders": [], "EnableAllFolders": True, "InvalidLoginAttemptCount": 0,
            "LoginAttemptsBeforeLockout": -1, "MaxActiveSessions": 0, "EnablePublicSharing": True,
            "BlockedMediaFolders": [], "BlockedChannels": [], "RemoteClientBitrateLimit": 0,
            "AuthenticationProviderId": "Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider",
            "PasswordResetProviderId": "Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider",
            "SyncPlayAccess": "CreateAndJoinGroups"}


def user_dto(uid: str, name: str, admin: bool = False) -> dict:
    """GET /Users/Me's 200 body as 12.1 writes it (UserDto, nulls left out;
    Configuration isn't vendored, so it is left out too)."""
    return {"Name": name, "ServerId": SERVER_ID, "Id": uid, "HasPassword": True,
            "HasConfiguredPassword": True, "HasConfiguredEasyPassword": False, "EnableAutoLogin": False,
            "LastLoginDate": CREATED, "LastActivityDate": CREATED, "Policy": user_policy(admin)}


def _words(s: str) -> set[str]:
    return set(re.findall(r"\w+", s.casefold()))


def jf_id(seed: str) -> str:
    """A Jellyfin-style 32-char dashless id, stable per seed."""
    return uuid.uuid5(uuid.NAMESPACE_URL, "jellyfin:" + seed).hex


@dataclass
class JfUser:
    id: str
    name: str
    token: str


@dataclass
class JfItem:
    id: str
    name: str
    type: str  # "Series" | "Movie"
    provider_ids: dict = field(default_factory=dict)
    year: int | None = None
    visible_to: set | None = None  # None = every user
    episodes: list = field(default_factory=list)  # [{season, episode, end, id, created}]


class JellyfinSim:
    def __init__(self, router, base: str):
        self.base = base.rstrip("/")
        self.users: dict[str, JfUser] = {}  # token -> user
        self.items: dict[str, JfItem] = {}
        self.played: dict[str, set] = {}  # user id -> item/episode ids
        self.calls: list[tuple[str, dict, str]] = []
        self.violations: list[str] = []
        self._faults: dict[str, list] = {}
        router.route(url__startswith=self.base + "/").mock(side_effect=self._handle)
        LIVE.append(self)

    # ---- scenario ----
    def add_user(self, name: str, token: str, *, uid: str | None = None) -> JfUser:
        u = JfUser(uid or jf_id("user:" + name), name, token)
        self.users[token] = u
        return u

    def add_series(self, name: str, tvdb: int | str, *, year: int | None = 2020,
                   visible_to: set | None = None) -> JfItem:
        it = JfItem(jf_id(f"series:{tvdb}"), name, "Series", {"Tvdb": str(tvdb)}, year, visible_to)
        self.items[it.id] = it
        return it

    def add_movie(self, name: str, tmdb: int | str | None, *, year: int | None = 2021,
                  visible_to: set | None = None) -> JfItem:
        pids = {"Tmdb": str(tmdb)} if tmdb is not None else {}
        it = JfItem(jf_id(f"movie:{tmdb}:{name}"), name, "Movie", pids, year, visible_to)
        self.items[it.id] = it
        return it

    def add_episode(self, series: JfItem, season: int, episode: int, *, end: int | None = None,
                    created: str = CREATED) -> str:
        eid = jf_id(f"ep:{series.id}:{season}:{episode}")
        series.episodes.append({"season": season, "episode": episode, "end": end, "id": eid,
                                "created": created})
        return eid

    def mark_played(self, user: JfUser, item_id: str) -> None:
        self.played.setdefault(user.id, set()).add(item_id)

    def fail(self, path: str, *, status: int = 500, exc: Exception | None = None, times: int = 1) -> None:
        self._faults.setdefault(path, []).extend([exc or status] * times)

    def requests(self, path: str) -> list[tuple[dict, str]]:
        return [(p, t) for pa, p, t in self.calls if pa == path]

    # ---- HTTP ----
    def _handle(self, request: httpx.Request) -> httpx.Response:
        spec = jf_spec()
        self.violations += spec.request(request)
        resp = self._answer(request)
        found = spec.match(request.method, request.url.path)
        if found and resp.headers.get("content-type", "").startswith("application/json"):
            fields = {f.strip() for k, v in request.url.params.multi_items() if k.lower() == "fields"
                      for f in v.split(",") if f.strip()}
            self.violations += spec.response(found[0], resp.status_code, resp.json(), fields)
        elif found:
            self.violations += spec.response(found[0], resp.status_code, None, set()) if resp.status_code != 200 \
                else [f"JellyfinSim {request.url.path}: a 200 without a JSON body"]
        return resp

    def _answer(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        params = dict(request.url.params)
        m = _TOKEN.search(request.headers.get("Authorization", ""))
        token = m.group(1) if m else ""
        self.calls.append((path, params, token))
        faults = self._faults.get(path)
        if faults:
            f = faults.pop(0)
            if isinstance(f, Exception):
                raise f
            return httpx.Response(f, text="fault")
        user = self.users.get(token)
        if user is None:
            return httpx.Response(401, text="")
        if path == "/Users/Me":
            return httpx.Response(200, json=user_dto(user.id, user.name))
        if params.get("userId") not in (None, user.id):
            return httpx.Response(403, text="userId of another user")
        if path == "/Items":
            return self._items(user, params)
        m = re.fullmatch(r"/Shows/([^/]+)/Episodes", path)
        if m:
            return self._episodes(user, m.group(1), params)
        raise AssertionError(f"JellyfinSim: unexpected request {request.method} {request.url}")

    def _visible(self, user: JfUser, it: JfItem) -> bool:
        return it.visible_to is None or user.id in it.visible_to

    def _user_data(self, user: JfUser, item_id: str) -> dict:
        return {"PlaybackPositionTicks": 0, "PlayCount": 0, "IsFavorite": False,
                "Played": item_id in self.played.get(user.id, set()), "Key": item_id, "ItemId": item_id}

    @staticmethod
    def _fields(params: dict) -> set[str]:
        """`Fields` (any case, comma-separated), lower-cased."""
        return {f.strip().lower() for k, v in params.items() if k.lower() == "fields"
                for f in v.split(",") if f.strip()}

    def _items(self, user: JfUser, params: dict) -> httpx.Response:
        # Jellyfin's search ignores punctuation; here: every word of the term in the name
        term = _words(params.get("SearchTerm") or "")
        types = set(filter(None, (params.get("IncludeItemTypes") or "").split(",")))
        out = []
        for it in self.items.values():
            if not self._visible(user, it) or (types and it.type not in types):
                continue
            if term and not term <= _words(it.name):
                continue
            d = {"Name": it.name, "ServerId": SERVER_ID, "Id": it.id, "IsFolder": it.type == "Series",
                 "Type": it.type, "UserData": self._user_data(user, it.id), "LocationType": "FileSystem",
                 "MediaType": "Video" if it.type == "Movie" else "Unknown"}
            if "providerids" in self._fields(params):
                d["ProviderIds"] = dict(it.provider_ids)
            if it.year:
                d["ProductionYear"] = it.year
            out.append(d)
        limit = int(params.get("Limit") or len(out) or 1)
        return httpx.Response(200, json={"Items": out[:limit], "TotalRecordCount": len(out), "StartIndex": 0})

    def _episodes(self, user: JfUser, sid: str, params: dict) -> httpx.Response:
        it = self.items.get(sid)
        if it is None or not self._visible(user, it):
            return httpx.Response(404, text="Item not found")
        out = []
        for e in sorted(it.episodes, key=lambda e: (e["season"], e["episode"])):
            d = {"Name": f"Episode {e['episode']}", "ServerId": SERVER_ID, "Id": e["id"], "IsFolder": False,
                 "Type": "Episode", "SeriesName": it.name, "SeriesId": sid, "ParentIndexNumber": e["season"],
                 "IndexNumber": e["episode"], "UserData": self._user_data(user, e["id"]),
                 "LocationType": "FileSystem", "MediaType": "Video"}
            if e["end"] is not None:
                d["IndexNumberEnd"] = e["end"]
            if "datecreated" in self._fields(params):
                d["DateCreated"] = e["created"]
            out.append(d)
        return httpx.Response(200, json={"Items": out, "TotalRecordCount": len(out), "StartIndex": 0})
