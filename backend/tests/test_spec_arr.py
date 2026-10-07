"""Mock fidelity: ArrSim (tests/support/arr.py) against the public Sonarr v4 /
Radarr v5 OpenAPI specs (tests/specs/fetch_specs.py; skips without the cache).

A "tour" per arr drives every ArrClient primitive reel-api has (arr.py — the
same calls app.py, undo.py and push.py make) against the sim, plus the one
route reel-api doesn't call, and records every request and answer. Then:

* every route the sim serves was exercised (the tour is complete);
* every answer validates against the spec's response schema — including
  `additionalProperties: false`, so a field the spec doesn't know is caught;
* every request body reel-api sends validates against the requestBody schema;
* every query parameter reel-api sends is a documented parameter of that path.

Deviations the spec can't express are listed below, each with its reason —
nothing else is exempt.

What this found in the sim (fixed in tests/support/arr.py): the quality
`source` enum differs per arr (Sonarr QualitySource "web", Radarr Source
"webdl" — the sim sent "web" to both), and PUT /episode/monitor answered an
empty 202 where Sonarr returns the updated episodes. No builder field is
unknown to the spec; the sim-private `_still` flag never leaves the sim.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from reel_api import push
from reel_api.arr import ArrClient
from tests.conftest import RADARR, RADARR_KEY, SONARR, SONARR_KEY
from tests.support.arr import (episode_obj, history_event, movie_obj, now_utc, queue_record, season_obj,
                               series_obj)
from tests.support.openapi import OpenApi, template_for
from tests.support.qbit import make_hash

pytestmark = pytest.mark.spec

# Command bodies: the spec models POST /api/v3/command as the generic
# CommandResource (closed: name, priority, ...), but both arrs deserialize the
# body into the *named* command's own class (SeriesSearchCommand: seriesId,
# SeasonSearchCommand: seriesId + seasonNumber, MoviesSearchCommand: movieIds,
# RefreshSeries: seriesIds/isNewSeries, RefreshMovie: movieIds/isNewMovie —
# Sonarr/Radarr source, NzbDrone.Core/IndexerSearch and .../Commands). Those
# fields are what a command request is for, so they are allowed on the
# request and inside a CommandResource's `body` (the Command schema is closed
# too). Only these names, only there.
COMMAND_FIELDS = {
    "SeriesSearch": {"seriesId"},
    "SeasonSearch": {"seriesId", "seasonNumber"},
    "MoviesSearch": {"movieIds"},
    "RefreshSeries": {"seriesIds", "isNewSeries"},
    "RefreshMovie": {"movieIds", "isNewMovie"},
}

# Answers the spec shows without a body because the controller returns an
# untyped IActionResult, but which carry resources on the real arrs (their
# source at the pinned tags): Sonarr EpisodeController.SetEpisodesMonitored
# `return Accepted(resources)` (EpisodeResource list), Radarr
# MovieEditorController.SaveAll `return Accepted(moviesResources)`. The sim
# answers the same, and those bodies are validated against these schemas.
UNTYPED_BODIES = {
    ("PUT", "/api/v3/episode/monitor"): {"type": "array", "items": {"$ref": "#/components/schemas/EpisodeResource"}},
    ("PUT", "/api/v3/movie/editor"): {"type": "array", "items": {"$ref": "#/components/schemas/MovieResource"}},
}


class Recorder:
    """Wraps the sim's respx route: (call, template, response) per request."""

    def __init__(self, upstream, sim):
        self.sim = sim
        self.log: list[tuple] = []
        route = upstream.routes[f"arr_{sim.kind}"]
        inner = route.side_effect

        async def side_effect(request):
            resp = await inner(request)
            call = sim.calls[-1]
            self.log.append((call, sim._template_of(call), resp))
            return resp

        route.side_effect = side_effect

    def templates(self) -> set[tuple[str, str]]:
        return {(c.method, t) for c, t, _ in self.log if t}


def sim_routes(sim) -> set[tuple[str, str]]:
    return {(method, template) for method, _, template, _ in sim._routes}


# ---------------------------------------------------------------- tours


async def tv_tour(sonarr) -> None:
    now = now_utc()
    c = ArrClient("tv", SONARR, SONARR_KEY, "HD-1080p")
    # in the library: S1 on disk, S2 aired last month (no file), S3 premieres next month
    wire = sonarr.add_series(
        series_obj(79126, "The Wire", monitored=False,
                   seasons=[season_obj(0), season_obj(1), season_obj(2, monitored=False), season_obj(3)]),
        [episode_obj(1, 1, air=now - timedelta(days=900), has_file=True),
         episode_obj(2, 1, air=now - timedelta(days=40), monitored=False),
         episode_obj(2, 2, air=now - timedelta(days=33), monitored=True, still=False),
         episode_obj(3, 1, air=now + timedelta(days=30))])
    # findable, not added yet
    sonarr.add_catalog(series_obj(81189, "Breaking Bad", seasons=[season_obj(1)]),
                       [episode_obj(1, 1, air=now - timedelta(days=5000))])

    await c.lookup("breaking")
    await c.lookup("tvdb:79126")
    await c.library_ids()
    await c.metadata("79126")                     # in the library: episodes with images
    added = await c.add("81189")                  # quality profile, root folder, POST + its commands
    bb = added["_arr_id"]
    ep = sonarr.episode(bb, 1, 1)["id"]
    h = make_hash("tour-tv")
    sonarr.grab(bb, h, episode_ids=[ep])
    sonarr.queue.append(queue_record(1, download_id=None, series_id=wire["id"], episode_id=None, season=None,
                                     status="warning", state="importBlocked", error="No files found",
                                     status_messages=[{"title": "x.mkv", "messages": ["Sample"]}]))
    await c.queue()
    await c.season_news()
    got = await c.search_season("79126", 2)
    await c.title_by_id(bb)
    await c.title_by_id(999_999)                   # gone: 404
    await c.grabs_since(now - timedelta(hours=1), bb)
    cmds = await c.active_commands(bb)
    queued = next(x for x in cmds if x["status"] == "queued")
    sonarr.set_command_status(cmds[-1]["id"], "started")
    await c.cancel_command(queued["id"])
    await c.cancel_command(cmds[-1]["id"])         # running: refused (400), best effort
    await c._get(f"/api/v3/command/{queued['id']}")  # not used by reel-api; served by the sim
    await c.remove_downloads(await c.queue_records())
    await c.set_episodes_monitored([ep], False)
    await c.search_title(bb)
    await c.set_title_monitored(bb, False)
    u = got["_undo"]
    await c.restore_season_monitoring(u["series_id"], 2, series_was=u["series_was"],
                                      season_was=u["season_was"], flipped=u["flipped"])
    # push.py's history watch (its own params) and an import seen there
    sonarr.add_history("downloadFolderImported", download_id=h, series_id=bb, episode_id=ep)
    sonarr.add_history("episodeFileDeleted", series_id=wire["id"], episode_id=ep, data={"reason": "Upgrade"})
    p = push.Push({"tv": c})
    p.state["since"]["tv"] = (now - timedelta(hours=1)).isoformat()
    await p.tick()
    await c.delete_title(bb)
    # ownership.py / delete with files: the listing, the lookup by tvdb id, the delete
    await c.titles()
    assert (await c.title_by_media_id("79126"))["id"] == wire["id"]
    await c.delete_title_and_files(wire["id"])


async def movie_tour(radarr) -> None:
    now = now_utc()
    c = ArrClient("movie", RADARR, RADARR_KEY, "HD-1080p")
    radarr.add_movie(movie_obj(603, "The Matrix", has_file=True,
                               collection={"title": "The Matrix Collection", "tmdbId": 2344}))
    radarr.add_catalog(movie_obj(27205, "Inception", original_title="Inception", trakt_votes=50,
                                 tmdb_votes=30_000, digital_release=now - timedelta(days=30)))

    await c.lookup("inception")
    await c.lookup("imdb:tt0000603")
    await c.library_ids()
    await c.metadata("603")
    added = await c.add("27205")
    mid = added["_arr_id"]
    h = make_hash("tour-movie")
    radarr.grab(mid, h)
    await c.queue()
    await c.title_by_id(mid)
    await c.title_by_id(999_999)
    await c.grabs_since(now - timedelta(hours=1), mid)
    cmds = await c.active_commands(mid)
    await c.cancel_command(cmds[0]["id"])
    await c._get(f"/api/v3/command/{cmds[0]['id']}")  # not used by reel-api; served by the sim
    await c.remove_downloads(await c.queue_records(), blocklist=True)
    await c.set_movie_monitored(mid, False)
    await c.search_title(mid)
    await c.set_title_monitored(mid, True)
    radarr.add_history("downloadFolderImported", download_id=h, movie_id=mid)
    p = push.Push({"movie": c})
    p.state["since"]["movie"] = (now - timedelta(hours=1)).isoformat()
    await p.tick()
    await c.delete_title(mid)
    await c.titles()
    matrix = await c.title_by_media_id("603")
    assert matrix["tmdbId"] == 603
    await c.delete_title_and_files(matrix["id"])


TOURS = {"tv": (tv_tour, "sonarr"), "movie": (movie_tour, "radarr")}


@pytest.fixture(params=["tv", "movie"])
async def toured(request, upstream, spec_cache):
    """(kind, sim, spec, recorder) after the kind's tour ran."""
    kind = request.param
    tour, name = TOURS[kind]
    sim = request.getfixturevalue(name)
    rec = Recorder(upstream, sim)
    await tour(sim)
    spec = OpenApi(spec_cache.sonarr if kind == "tv" else spec_cache.radarr)
    return kind, sim, spec, rec


def _command_name(body) -> str | None:
    return body.get("name") if isinstance(body, dict) else None


def allowed_extra(kind_of_payload: str, problem, payload) -> bool:
    """The documented exceptions (COMMAND_FIELDS) — nothing else."""
    if problem.kind != "additionalProperties":
        return False
    extra = set(problem.unknown_fields())
    if kind_of_payload == "command-request":
        return extra <= COMMAND_FIELDS.get(_command_name(payload), set())
    if kind_of_payload == "command-response" and problem.where.endswith(".body"):
        return extra <= set().union(*COMMAND_FIELDS.values())
    return False


# ---------------------------------------------------------------- tests


@pytest.mark.deletes_files_directly  # the tour calls delete_title_and_files itself
async def test_the_tour_exercises_every_route_the_sim_serves(toured):
    _, sim, spec, rec = toured
    assert rec.templates() == sim_routes(sim)


@pytest.mark.deletes_files_directly  # the tour calls delete_title_and_files itself
async def test_every_route_the_sim_serves_is_in_the_spec(toured):
    _, sim, spec, _ = toured
    missing = sorted(f"{m} {t}" for m, t in sim_routes(sim) if not spec.has_operation(t, m))
    assert missing == []


@pytest.mark.deletes_files_directly  # the tour calls delete_title_and_files itself
async def test_every_answer_validates_against_the_response_schema(toured):
    kind, sim, spec, rec = toured
    bad = []
    for call, template, resp in rec.log:
        if resp.status_code >= 400:
            continue  # error answers: the spec documents none
        schema = spec.response_schema(template, call.method) or UNTYPED_BODIES.get((call.method, template))
        if schema is None:
            if resp.content:
                bad.append((call.method, call.path, "body where the spec documents none", resp.text[:80]))
            continue
        payload = resp.json()
        what = "command-response" if template.startswith("/api/v3/command") else "response"
        for p in spec.problems(payload, schema):
            if not allowed_extra(what, p, payload):
                bad.append((call.method, call.path, p.where, p.message[:160]))
    assert bad == []


@pytest.mark.deletes_files_directly  # the tour calls delete_title_and_files itself
async def test_every_request_body_validates_against_the_request_schema(toured):
    kind, sim, spec, rec = toured
    bodies = [(c, t) for c, t, _ in rec.log if c.body is not None]
    sent = {(c.method, t) for c, t in bodies}
    expected = {("POST", f"/api/v3/{sim.noun}"), ("POST", "/api/v3/command")}
    expected |= ({("PUT", "/api/v3/series/{id}"), ("PUT", "/api/v3/episode/monitor")} if kind == "tv"
                 else {("PUT", "/api/v3/movie/editor")})
    assert sent == expected
    bad = []
    for call, template in bodies:
        schema = spec.request_schema(template, call.method)
        assert schema is not None, f"{call.method} {template}: the spec takes no body"
        what = "command-request" if template == "/api/v3/command" else "request"
        for p in spec.problems(call.body, schema):
            if not allowed_extra(what, p, call.body):
                bad.append((call.method, call.path, p.where, p.message[:160]))
    assert bad == []


@pytest.mark.deletes_files_directly  # the tour calls delete_title_and_files itself
async def test_every_query_parameter_sent_is_documented(toured):
    _, sim, spec, rec = toured
    bad = set()
    for call, template, _ in rec.log:
        documented = spec.query_params(template, call.method)
        for name in call.params:
            if name not in documented:
                bad.add((call.method, template, name))
    assert sorted(bad) == []


async def test_the_command_exception_is_narrow(spec_cache):
    """The COMMAND_FIELDS allowance doesn't swallow anything else: a stray
    field on a command request, or one outside `body`, still fails."""
    spec = OpenApi(spec_cache.sonarr)
    schema = spec.request_schema("/api/v3/command", "POST")
    ok = {"name": "SeasonSearch", "seriesId": 1, "seasonNumber": 2}
    assert all(allowed_extra("command-request", p, ok) for p in spec.problems(ok, schema))
    stray = {"name": "SeasonSearch", "seriesId": 1, "seasonNumber": 2, "deleteFiles": True}
    assert not all(allowed_extra("command-request", p, stray) for p in spec.problems(stray, schema))
    other = {"name": "SeriesSearch", "seasonNumber": 2}
    assert not all(allowed_extra("command-request", p, other) for p in spec.problems(other, schema))
    series = spec.request_schema("/api/v3/series", "POST")
    assert not all(allowed_extra("request", p, {"seriesId": 1}) for p in spec.problems({"seriesId": 1}, series))


def test_the_validator_reports_unknown_fields_types_and_enums(spec_cache):
    """Guards the guard: the strict checks above really bite."""
    spec = OpenApi(spec_cache.sonarr)
    obj = series_obj(1, "A")
    obj["bogus"] = 1
    obj["seasons"][0]["statistics"]["extra"] = 2
    obj["year"] = "2020"
    obj["status"] = "airing"
    got = {(p.where, p.kind) for p in spec.problems(obj, spec.schema("SeriesResource"))}
    assert got == {("$", "additionalProperties"), ("$.seasons[0].statistics", "additionalProperties"),
                   ("$.year", "type"), ("$.status", "enum")}
    assert [p.unknown_fields() for p in spec.problems({"a": 1, "b": 2}, spec.schema("Ratings"))] == [["a", "b"]]


# ---------------------------------------------------------------- the builders on their own


SCHEMAS = {"tv": "sonarr", "movie": "radarr"}


@pytest.mark.parametrize("kind,name,schema", [
    ("tv", "series_obj", "SeriesResource"),
    ("tv", "series_obj ended, no art", "SeriesResource"),
    ("movie", "movie_obj", "MovieResource"),
    ("movie", "movie_obj with collection + all ratings", "MovieResource"),
    ("tv", "episode_obj", "EpisodeResource"),
    ("tv", "episode_obj unaired", "EpisodeResource"),
    ("tv", "season_obj", "SeasonResource"),
    ("tv", "queue_record tv", "QueueResource"),
    ("movie", "queue_record movie", "QueueResource"),
    ("tv", "history_event tv", "HistoryResource"),
    ("movie", "history_event movie", "HistoryResource"),
])
def test_builders_validate_against_their_resource(spec_cache, kind, name, schema):
    spec = OpenApi(getattr(spec_cache, SCHEMAS[kind]))
    now = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
    obj = {
        "series_obj": lambda: series_obj(1, "A", seasons=[season_obj(1, previous_airing=now, next_airing=now)]),
        "series_obj ended, no art": lambda: series_obj(2, "B", status="ended", poster=False, fanart=False,
                                                       year=None, certification=None),
        "movie_obj": lambda: movie_obj(1, "M"),
        "movie_obj with collection + all ratings": lambda: movie_obj(
            2, "N", trakt_votes=5, tmdb_votes=6, collection={"title": "C", "tmdbId": 9}, digital_release=now,
            trailer=None, certification=None),
        "episode_obj": lambda: {**episode_obj(1, 2, air=now), "id": 5, "seriesId": 6},
        "episode_obj unaired": lambda: {**episode_obj(1, 3), "id": 7, "seriesId": 6},
        "season_obj": lambda: season_obj(3, previous_airing=now),
        "queue_record tv": lambda: queue_record(1, download_id="ABC", series_id=1, episode_id=2, season=1,
                                                error="boom", status_messages=[{"title": "t", "messages": ["m"]}]),
        "queue_record movie": lambda: queue_record(2, download_id=None, movie_id=3, timeleft=None),
        "history_event tv": lambda: history_event(1, "grabbed", download_id="ABC", series_id=1, episode_id=2,
                                                  data={"indexer": "x"}),
        "history_event movie": lambda: history_event(2, "downloadFolderImported", movie_id=3),
    }[name]()
    obj = {k: v for k, v in obj.items() if not k.startswith("_")}  # sim-private keys never leave the sim
    assert spec.problems(obj, spec.schema(schema)) == []
