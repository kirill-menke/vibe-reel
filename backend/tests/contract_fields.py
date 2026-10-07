"""What the clients read from reel-api — the hand-maintained side of the
contract test (tests/test_contract.py).

Every entry names a real answer (a scene in tests/support/scenes.py, i.e. a
route + status), the field path in it (`name[]` = each element of the list
`name`), and where a client reads it: the repo-relative file and the exact
expression there. test_contract.py checks, per entry:

* the expression still occurs in that file (so the table can't rot silently
  when a client stops reading a field or renames its variable — then the
  entry has to be updated or dropped);
* the field is declared in the route's response schema (app.openapi(), $refs
  resolved; a route without response_model uses its documented schema in
  tests/support/schemas.py; error bodies the {error, detail} ApiError);
* the field is present in the real answer the scene produced.

CODES pin the `error` values (and STATUSES the status codes) the clients
branch on: the literal must occur in the file and the scene's answer must
carry exactly that code / status.

KNOWN_GAPS are reads the API does not serve (findings.md). They are
checked like READS, as strict xfails: a fix XPASSes and fails the run —
then move the entry to READS.

Sources: src/lib/medialib.js (the TV and phone client of every route but
hls/trailers/push), the src/lib modules that consume its answers, the TV
screens/components, and phone/src (push, Settings, Chart, Search,
LookupDetail, CollectionRail, Notifications, nav).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Read:
    scene: str
    path: str
    file: str
    ident: str


@dataclass(frozen=True)
class Code:
    scene: str
    code: str  # the answer's `error`
    file: str
    ident: str  # the literal the client compares with


@dataclass(frozen=True)
class Status:
    scene: str
    file: str
    ident: str  # the comparison with the scene's status code


ML = "src/lib/medialib.js"
ACT = "src/lib/activity.svelte.js"
LANDED = "src/lib/landed.svelte.js"
NEWS = "src/lib/news.svelte.js"
LOOKUP = "src/lib/lookup.svelte.js"
RANK = "src/lib/searchrank.js"
PEND = "src/lib/pendingplay.js"
SEGS = "src/lib/segments.js"
LIVE = "src/lib/livefeed.js"
TRAILER = "src/lib/trailerstream.js"
PLAYER = "src/lib/player.svelte.js"
CANCEL = "src/lib/cancel.svelte.js"
ME = "src/lib/me.svelte.js"
TILE = "src/components/LookupTile.svelte"
BROWSE = "src/components/Browse.svelte"
RAIL = "src/components/CollectionRail.svelte"
TOPNAV = "src/components/TopNav.svelte"
LDETAIL = "src/screens/LookupDetail.svelte"
MYLIB = "src/components/MyLibraryMenu.svelte"
P_PUSH = "phone/src/lib/push.js"
P_NAV = "phone/src/lib/nav.svelte.js"
P_SETTINGS = "phone/src/screens/Settings.svelte"
P_MYLIB = "phone/src/screens/MyLibrary.svelte"
P_CHART = "phone/src/screens/Chart.svelte"
P_SEARCH = "phone/src/screens/Search.svelte"
P_LDETAIL = "phone/src/screens/LookupDetail.svelte"
P_RAIL = "phone/src/components/detail/CollectionRail.svelte"
P_NOTES = "phone/src/sheets/Notifications.svelte"


def _many(scene: str, prefix: str, file: str, pairs: list[tuple[str, str]]) -> list[Read]:
    return [Read(scene, f"{prefix}{field}", file, ident) for field, ident in pairs]


READS: list[Read] = [
    # GET /api/lookup — Search results, ranked by searchrank.js, add state in lookup.svelte.js
    *_many("lookup", "results[].", TILE, [("id", "item.id"), ("type", "item.type"), ("poster", "item.poster")]),
    *_many("lookup", "results[].", RANK, [("title", "it.title"), ("year", "it.year"), ("votes", "it.votes"),
                                           ("original_title", "it.original_title")]),
    Read("lookup", "results[].added", LOOKUP, "it.added"),
    Read("lookup", "results[].overview", LDETAIL, "item.overview"),
    Read("lookup", "results", LOOKUP, "r.results"),

    # GET /api/trending — Home rails (lookup-shaped + IMDb fields)
    *_many("trending", "results[].", TILE, [("rating", "item.rating"), ("rating_votes", "item.rating_votes"),
                                             ("digital_release", "item.digital_release")]),
    Read("trending", "results[].digital_release", P_LDETAIL, "item.digital_release"),
    Read("trending", "results[].imdb_id", P_NAV, "it.imdb_id"),
    Read("trending", "results[].type", ML, "it.type"),
    Read("trending", "results[].id", ML, "it.id"),

    # GET /api/charts — Browse category cards (TV), phone Search
    Read("charts", "categories", BROWSE, "r.categories"),
    Read("charts", "categories[].key", BROWSE, "c.key"),
    Read("charts", "categories[].title", BROWSE, "cat.title"),
    Read("charts", "categories[].posters", BROWSE, "c.posters"),
    Read("charts", "categories[].count", P_SEARCH, "c.count"),

    # GET /api/charts/{key} — the category grid
    Read("chart", "sections", ML, "c.sections"),
    Read("chart", "sections[].results", ML, "s.results"),
    Read("chart", "sections[].type", P_CHART, "s.type"),
    Read("chart", "sections[].title", P_CHART, "sec.title"),
    Read("chart", "sections[].results[].rank", BROWSE, "item.rank"),
    Read("chart", "sections[].results[].rating", P_CHART, "it.rating"),
    Read("chart", "sections[].results[].id", ML, "it.id"),
    Read("chart", "sections[].results[].type", ML, "it.type"),

    # POST /api/library, POST /api/news/search — the toast's Undo token
    Read("library-add", "undo", LOOKUP, "r.undo"),
    Read("news-search", "undo", NEWS, "r.undo"),

    # GET /api/activity — merged into the browse screens, pending playback, the bell
    *_many("activity", "items[].", ACT, [
        ("id", "i.id"), ("type", "it.type"), ("title", "it.title"), ("subtitle", "it.subtitle"),
        ("status", "x.status"), ("progress", "x.progress"), ("size_bytes", "i.size_bytes"),
        ("timeleft", "x.timeleft"), ("quality", "i.quality"), ("download_speed", "i.download_speed"),
        ("message", "i.message"), ("media_id", "it.media_id"), ("season", "it.season"),
        ("episode", "it.episode"), ("episode_title", "it.episode_title"), ("poster", "it.poster"),
        ("year", "it.year"), ("download_id", "i.download_id"),
    ]),
    Read("activity", "items", ACT, "r.items"),
    Read("activity", "items[].download_id", PEND, "it.download_id"),
    Read("activity", "items[].media_id", LANDED, "it.media_id"),
    Read("activity", "items[].status", LANDED, "it.status"),

    # GET /api/me — quota and owned titles (me.svelte.js; TV My library, phone MyLibrary)
    Read("me", "titles", ME, "ME.me.titles"),
    Read("me", "admin", ME, "m.admin"),
    Read("me", "quota.movie.used", ME, "q.used"),
    Read("me", "quota.tv.limit", ME, "q.limit"),
    Read("me-admin", "admin", ME, "ME.me.admin"),
    Read("me-admin", "quota.movie.limit", ME, "q.limit"),
    *_many("me", "titles[].", MYLIB, [
        ("type", "t.type"), ("id", "t.id"), ("title", "t.title"), ("year", "t.year"), ("poster", "t.poster"),
        ("status", "t.status"),
    ]),
    # the status line (titleStatus, shared by both apps)
    Read("me", "titles[].progress", ME, "t.progress"),
    # the phone's My library screen
    *_many("me", "titles[].", P_MYLIB, [
        ("type", "t.type"), ("id", "t.id"), ("title", "t.title"), ("year", "t.year"), ("poster", "t.poster"),
        ("status", "t.status"),
    ]),
    Read("me", "user.name", P_MYLIB, "me?.user.name"),

    # POST /api/library 409 quota_exceeded — its numbers patch the quota (quotaFromError)
    *_many("library-add-quota", "", ME, [("type", "b.type"), ("used", "b.used"), ("limit", "b.limit")]),

    # GET /api/activity as a normal user — Cancel only where the server allows it
    Read("activity-normal-user", "items[].can_cancel", CANCEL, "it.can_cancel"),

    # GET /api/news — the bell (TV TopNav + news.svelte.js, phone Notifications)
    *_many("news", "items[].", NEWS, [
        ("id", "item.id"), ("kind", "item.kind"), ("media_id", "item.media_id"), ("title", "item.title"),
        ("season", "item.season"), ("premiere", "item.premiere"), ("episodes_aired", "item.episodes_aired"),
        ("episodes_total", "item.episodes_total"),
    ]),
    Read("news", "items", NEWS, "r.items"),
    Read("news", "items[].poster", TOPNAV, "it.poster"),
    Read("news", "items[].year", P_NOTES, "it.year"),

    # GET /api/metadata/{type}/{id} — LookupDetail / PendingDetail / SeriesDetail
    *_many("metadata-tv", "", LDETAIL, [
        ("poster", "meta?.poster"), ("year", "meta?.year"), ("fanart", "meta?.fanart"),
        ("overview", "meta?.overview"), ("runtime_min", "meta?.runtime_min"), ("genres", "meta?.genres"),
        ("rating", "meta?.rating"), ("certification", "meta?.certification"), ("status", "meta?.status"),
        ("episodes", "meta?.episodes"),
    ]),
    Read("metadata-tv", "title", P_LDETAIL, "meta?.title"),
    *_many("metadata-tv", "episodes[].", LDETAIL, [
        ("season", "e.season"), ("episode", "e.episode"), ("title", "e.title"), ("still", "e.still"),
        ("air_date", "e.air_date"), ("has_file", "e.has_file"),
    ]),
    Read("metadata-tv", "episodes[].overview", PEND, "em.overview"),
    Read("metadata-movie", "trailer", LDETAIL, "meta?.trailer"),
    Read("metadata-movie", "collection", LDETAIL, "meta?.collection"),
    Read("metadata-movie", "collection.id", LDETAIL, "meta.collection.id"),
    Read("metadata-movie", "digital_release", P_LDETAIL, "(meta)?.digital_release"),  # was F15

    # GET /api/segments/{imdb}/{season}/{episode} — skip chips (segments.js)
    Read("segments", "intro", SEGS, "r.intro"),
    Read("segments", "recap", SEGS, "r.recap"),
    Read("segments", "outro", SEGS, "r.outro"),
    Read("segments", "intro.start", SEGS, "v.start"),
    Read("segments", "intro.end", SEGS, "v.end"),

    # GET /api/collection/{id} — the franchise rail
    Read("collection", "title", RAIL, "(coll).title"),
    Read("collection", "movies", RAIL, "coll.movies"),
    Read("collection", "movies[].id", RAIL, "m.id"),
    Read("collection", "movies[].title", P_RAIL, "m.title"),
    Read("collection", "movies[].added", LOOKUP, "it.added"),

    # GET /api/downloads/{id}/probe — the synthetic MediaSource (pendingplay.js sourceFromProbe)
    *_many("probe", "", PEND, [
        ("container", "probe.container"), ("duration_s", "probe.duration_s"), ("bitrate", "probe.bitrate"),
        ("video", "probe.video"), ("audio", "probe.audio"),
    ]),
    *_many("probe", "video.", PEND, [("codec", "v.codec"), ("width", "v.width"), ("height", "v.height"),
                                      ("hdr", "v.hdr")]),
    *_many("probe", "audio[].", PEND, [
        ("index", "a.index"), ("codec", "a.codec"), ("channels", "a.channels"), ("layout", "a.layout"),
        ("lang", "a.lang"), ("title", "a.title"), ("atmos", "a.atmos"), ("default", "a.default"),
    ]),

    # POST|GET /api/downloads/{id}/hls — phone watch-while-downloading (livefeed.js prepare())
    *[Read(sc, f, LIVE, f"st.{f}") for sc in ("hls-start", "hls-status")
      for f in ("state", "codecs", "duration", "error")],

    # POST|GET /api/trailers/{key} — trailerstream.js run(), the OSD tech line in player.svelte.js
    *[Read(sc, f, TRAILER, f"st.{f}") for sc in ("trailer-start", "trailer-status")
      for f in ("state", "error", "buffered_s", "subs_done", "codecs", "vcodec", "duration")],
    *[Read(sc, "subs", TRAILER, "x.subs") for sc in ("trailer-start", "trailer-status")],
    *[Read("trailer-status", f, PLAYER, f"st.{f}") for f in ("codecs", "duration", "width", "height", "hdr")],

    # /api/push/* — phone push.js and Settings
    Read("push-config", "enabled", P_PUSH, "conf.enabled"),
    Read("push-config", "key", P_PUSH, "conf.key"),
    Read("push-status", "ready", P_SETTINGS, "s.ready"),
    Read("push-status", "seasons", P_SETTINGS, "s.seasons"),

    # error bodies: mlFetch() reads {error, detail}; push.js / livefeed.js / trailerstream.js the detail
    Read("library-add-exists", "error", ML, "body.error"),
    Read("library-add-exists", "detail", ML, "body.detail"),
    Read("not-available", "error", ML, "b503.error"),
    Read("not-available", "detail", ML, "b503.detail"),
    Read("push-test-unknown", "detail", P_PUSH, "b.detail"),
    Read("hls-not-started", "detail", LIVE, "b.detail"),
]

CODES: list[Code] = [
    Code("library-add-exists", "already_added", LOOKUP, "'already_added'"),
    Code("library-undo-has-files", "has_files", LOOKUP, "'has_files'"),
    Code("news-search-not-aired", "not_aired", NEWS, "'not_aired'"),
    Code("not-available", "not_available", ML, "'not_available'"),
    Code("probe-not-ready", "not_ready", PEND, "'not_ready'"),
    Code("library-add-quota", "quota_exceeded", LOOKUP, "'quota_exceeded'"),
    Code("library-add-being-deleted", "being_deleted", LOOKUP, "'being_deleted'"),
]

STATUSES: list[Status] = [
    Status("library-add-exists", LOOKUP, "(e).status === 409"),
    Status("library-undo-expired", LOOKUP, "(e).status === 410"),
    Status("news-undo-expired", NEWS, "(e).status === 410"),
    Status("cancel-not-in-queue", CANCEL, "(e).status === 404"),
    Status("probe-not-ready", PEND, "(e).status === 409"),
    Status("not-available", ML, "r.status === 503"),
    Status("hls-not-started", LIVE, "e.status === 404"),
    Status("library-delete-not-owner", ME, "e.status === 403"),
    Status("cancel-not-owner", CANCEL, "(e).status === 403"),
    Status("news-undo-not-owner", NEWS, "(e).status === 403"),
]

# Reads the API doesn't serve (run/findings.md): strict xfails in test_contract.py
# (test_known_gap_is_served); when one is fixed, move it to READS.
KNOWN_GAPS: list[Read] = [
    # empty: F15 (/api/metadata's digital_release) was the last one, fixed
]
