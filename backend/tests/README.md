# reel-api tests

```sh
cd backend
T="uv run --frozen --group dev"
$T python tests/fetch_fixtures.py         # once per clone: third-party fixtures (network)
$T pytest                                 # everything (no network, ~seconds)
$T pytest -m "not slow"                   # skip ffmpeg-generated media / subprocess tests
$T pytest --cov=reel_api --cov-branch --cov-report=term-missing \
   --cov-report=json:/tmp/cov.json && $T python tests/check_coverage.py /tmp/cov.json
```

The test tooling is the `dev` dependency group in `pyproject.toml` (exact
pins for the direct dependencies), locked with everything else in `uv.lock`;
`--frozen` runs exactly what the lock says. Adding a test dependency:
`uv add --dev <pkg>==<version>`, and commit `pyproject.toml` + `uv.lock`
together. The Nix package (`package.nix`) reads neither: it lists the runtime
dependencies itself.

**Third-party fixtures are fetched, never committed** (the repo is MIT;
these are GPL specs, wiki pages and IMDb data): `tests/fetch_fixtures.py
[--refresh] [specs] [jellyfin] [imdb]` puts them in git-ignored places —
the Sonarr/Radarr/qBittorrent specs in `tests/.spec-cache/` (`spec` tests
skip without them), Jellyfin 12.1's OpenAPI there too plus the subset derived
from it (`tests/specs/jellyfin-12.1-subset.json`), and today's IMDb answers
(`tests/recorded/imdb/`). Without the last two the tests that need them
**fail** (never skip) with one line naming the command
(`tests/support/fetched.py`). Anything present is kept; `--refresh`
re-downloads / re-records.

Test order is shuffled on every run (pytest-randomly; the seed is printed in
the header without `-q`). Reproduce a failure with `-p randomly
--randomly-seed=<seed>`, or run in file order with `-p no:randomly`. A test
that only passes in one order is an isolation bug: fix the fixture, never pin
the order.

`tests/check_coverage.py` is a per-module **line-coverage ratchet** against
`tests/coverage-floor.json`: a module below its floor fails the run. Raise a
module's floor in the same change that adds its tests; never lower one.

## Ground rules

- **No network.** pytest-socket only lets tests connect to loopback (and
  AF_UNIX); every httpx request goes through respx with
  `assert_all_mocked=True` (`upstream` fixture, autouse) and every `requests`
  call (pywebpush) through `responses` (`requests_mock`, autouse). An
  unmocked URL fails the test.
- **Fake upstreams** live at `http://<service>.test`: `sonarr.test`,
  `radarr.test`, `prowlarr.test` (the canary), `qbit.test`,
  `jellyfin.test` (constants in `conftest.py`). Hard-coded public upstreams (IMDb GraphQL, IntroDB,
  api.radarr.video, YouTube) are mocked at their real URLs — mocked, never
  contacted.
- **Clean env per test** (`reel_env`, autouse): every variable reel-api reads
  is removed; `CACHE_DIRECTORY`/`STATE_DIRECTORY`/`TMPDIR` point into
  `tmp_path`. `reel_env(KEY=value, OTHER=None)` sets/removes.
- **No upstream in error bodies** (`no_upstream_in_error_bodies`, autouse):
  every response >= 400 a test gets through `make_api`/`api` is recorded and
  checked at teardown against `UPSTREAM_WORDS` (sonarr, radarr, prowlarr,
  qbittorrent, aria2, flaresolverr, imdb, introdb, `.test`, httpx); FastAPI
  422 `loc` entries (our own parameter names) are ignored. `KNOWN_LEAKS` holds
  the exact bodies of known leaks keyed by finding; a body is exempt only in a
  test marked `known_bug("<that finding>")`, nothing else is.
- **Library files are never deleted by accident** (`arr_deletes_keep_files`,
  autouse): after every test, each title `DELETE` any `ArrSim` saw must carry
  no import-list exclusion and `deleteFiles=false` — except one sent by
  `ArrClient.delete_title_and_files` inside `Undo.delete_with_files` as called
  by the route `DELETE /api/library/{type}/{id}?delete_files=true`, after that
  call answered (a `deleting` watcher's later DELETE inherits it). A unit test
  of `delete_title_and_files` itself is marked `deletes_files_directly`. A test
  that breaks the rule on purpose asserts the fixture's `violations()` and
  clears the sim's `calls` (`test_harness.py`).
- **No real yt-dlp** (`no_real_ytdlp`, autouse): the first `yt-dlp` on PATH is a
  stand-in that exits 97 and fails the test at teardown; `FakeYtDlp` shadows it.
- **The request guard is always on** (`security.py`): the test client talks
  to Host `reel.test` (in `REEL_API_ALLOWED_HOSTS`) and signs every request
  `Authorization: MediaBrowser Token="<TEST_TOKEN>"`; `jf_auth` (autouse,
  `JellyfinAuthSim`) answers the guard's Token-only `GET /Users/Me` like
  Jellyfin 12.1 (200 with a `UserDto` — `Id`, `Name`, `Policy.IsAdministrator`
  — for a token in `jf_auth.users`, 401 otherwise; `jf_auth.fault` injects an
  outage), spec-checked like `JellyfinSim` (below).
  Roles: `TEST_TOKEN` is "kirill", an **admin** (every test that ignores roles
  sees admin behaviour: everything allowed, no quota); `NICOLE_TOKEN` /
  `ZHENYA_TOKEN` are normal users (`NICOLE_USER` / `ZHENYA_USER`). Sign as
  one with `make_api(auth=auth_for(NICOLE_TOKEN))` or per request
  `headers={"Authorization": auth_for(…)}`; `jf_auth.admins` / `jf_auth.names`
  (by user id) change roles and names. Other `/Users/Me` requests (push.py's
  full header) fall through to the test's own routes. A test that sent a
  guarded request must have made the guard ask (checked at teardown), so no
  test can pass with the guard bypassed. `make_api(auth=None)` sends no token.
- **Fresh app per test**: `app_module` reloads `reel_api.app` (module-level
  caches, IntroDB/Trailers singletons) and resets streaming/livehls/push
  globals. The startup warm-up `_keep_warm` is a no-op unless a test calls
  `app_module._keep_warm_real`.

## Fixtures (conftest.py)

| fixture | what |
|---|---|
| `api` | `httpx.AsyncClient` on the app after lifespan, every backend configured (`FULL_ENV`), push off |
| `make_api(**env, raise_app_exceptions=True, auth=TEST_AUTH)` | the same as an async context manager with env overrides (`None` removes); `auth` is the client's default Authorization header (`None`: none) |
| `jf_auth` | `JellyfinAuthSim` — the guard's `GET /Users/Me` (`users`, `names`, `admins`, `fault`, `asked`; `install(router)` after clearing routes) |
| `app_module` | the freshly reloaded `reel_api.app` module (`api.app_module` too) |
| `upstream` | the respx router; add routes with `upstream.get(url).respond(...)` |
| `requests_mock` | `responses.RequestsMock` for pywebpush |
| `qbit` | `QbitSim` — stateful fake qBittorrent WebUI v2 (`tests/support/qbit.py`) |
| `sonarr` / `radarr` | `ArrSim` — stateful fake Sonarr v4 / Radarr v5 at `SONARR`/`RADARR` (`tests/support/arr.py`) |
| `clock` / `manual_clock` | `FakeClock` (auto-advancing / stepped); `clock.install(monkeypatch, module, ...)` |
| `sample_mkv`, `sample_hevc_mkv` | session-scoped tiny MKVs generated by ffmpeg (`tests/support/media.py`) |

Helpers in `tests/support/`:

- `qbit.py` — `QbitSim(router)`, `SimTorrent`, `SimFile`, `make_hash(seed)`,
  `magnet_for(hash)`. `sim.fail(path, status=|exc=)` injects one-shot faults;
  `sim.called(path)` lists the params/forms of calls to a path.
- `arr.py` — `ArrSim(router, "tv"|"movie")`: `catalog` (what the lookup
  finds: `add_catalog(obj, episodes)`), `titles` (the library:
  `add_series(obj, episodes)` / `add_movie(obj)`), `episodes`, `queue`,
  `history`, `commands`; `grab(arr_id, hash, episode_ids=)` puts rows in the
  queue + 'grabbed' history, `import_grab(hash)` imports them;
  `add_command`/`set_command_status`/`finish_commands`; `set_lookup(term, res)`
  pins a lookup answer; `fail(path_or_template, status=|exc=)`, `gate(path)`
  (hold calls until the event is set), `called(path, method)`/`count(...)`;
  `deleted`/`queue_deleted` record DELETE params (`files_deleted`: arr ids
  deleted with deleteFiles=true). Builders: `series_obj`,
  `season_obj`, `movie_obj`, `episode_obj`, `queue_record`, `history_event`.
  Season statistics of a library series are derived from its episodes (dates
  vs `datetime.now()`, so `time_machine` moves them). A wrong X-Api-Key is
  401; a route the sim doesn't know raises AssertionError in the test.
- `growing.py` — `GrowingFile(path, source_bytes, piece_size, offset)`: a
  sparse file that fills piece by piece (`grow_to`, `first_last`,
  `complete_piece(s)`, `complete`, `move`), with qBittorrent's pieceStates.
- `clock.py` — `FakeClock`: patches a module's `time`/`asyncio` names only
  (real event loop untouched). Auto mode: sleeps advance instantly. Manual
  mode: sleeps wait for `await clock.advance(s)`. Dates: use `time_machine`.
- `media.py` — `make_media(path, Spec(...))` with `Audio`/`Sub` tracks and
  chapters from lavfi sources; `ffprobe(path)`.
- `fake_ytdlp.py` — `FakeYtDlp(dir, monkeypatch, opaque=False)`: an executable
  fake `yt-dlp` first on PATH (asserts the real one can't run). `add(id,
  formats)` with `video_fmt`/`audio_fmt` (file + reported size/codec; VP9 is
  webm), `add_recorded(id, files, keep=)` for a recorded real format list,
  `update`, `fail(kind, stderr=, after=)`, `gate(kind, at=)`/`release(kind)`
  for `"resolve:<id>"` / `"download:<id>:<format_id>"`, `calls(prefix)`,
  `alive()`. The choice is `ytdlp_select.select` — yt-dlp's own format sort
  and spec grammar, ported; a spec it doesn't understand exits 2. Every
  format file must be what the format claims (`check_media`: codec,
  avc1 profile/level, VP9 profile 2 / 10 bit, size, container — ffprobe);
  stand-in bytes need `opaque=True`. `fake_ffmpeg(dir, "fail"|"partial"|"ok",
  monkeypatch)` for the ffmpeg failure branches.

## Recorded upstream answers (fake fidelity)

`tests/recorded/` holds trimmed real answers the hand-written fakes are
checked against, recorded by an opt-in, networked script (the tests never
touch the network). `ytdlp/` is committed; `imdb/` is IMDb's data, so it is
git-ignored and recorded by `tests/fetch_fixtures.py` (the replay tests fail
without it):

```sh
uv run --frozen --group dev python tests/fetch_fixtures.py --refresh imdb     # IMDb GraphQL, via the product's own clients
uv run --frozen --group dev python tests/specs/record_upstreams.py ytdlp   # yt-dlp -j for 3 trailers + offline picks
```

- `imdb/` — what `trending.py`/`charts.py` send and IMDb's answers (a few
  titles each), plus how IMDb answers an unknown field (400) and a missing
  `x-imdb-client-name` (403). `test_imdb_recorded.py`: the product still
  sends the recorded request (else: re-record), `ImdbSim` answers it with the
  recorded body exactly, and the raw answers parse to the hits an oracle
  derives from the recording itself (`support/imdb_recorded.py`: trending.py's
  documented rules with their own numbers — a fresh recording has other
  titles, so nothing hard-codes one). A trending recording must hold a title
  cut by rank, a movie whose premiere precedes its primary release and a show
  dated by its first episode; the recorder keeps one of each, and refuses an
  answer without.
  `support/imdb.py` executes the GraphQL it gets (`support/graphql.py`
  parses aliases, fragments, variables) and answers only the selection set.
- `ytdlp/<id>.json` — three real trailers' format lists (AV1 SDR/HDR10,
  VP9 / VP9.2 HDR10, H.264, DRC audio; URLs stripped) and the real yt-dlp's
  picks for every height, made offline from the trimmed list, also with AV1
  removed and with H.264 + AAC only. `test_ytdlp_recorded.py`: the fake's
  selector makes the same picks, `mse_video_codec`/`mse_audio_codec` give
  valid RFC 6381 strings (VP9 level fits the picture) on every real format,
  and a real list through the fake binary + `Trailers` gives the status the
  TV reads. `ytdlp-repick` recomputes picks offline after a spec change.

## Contract (what the clients read, what the routes declare)

- `support/scenes.py` — `SCENES`: one real answer per (route, status), built
  with the sims (`scene(name, method, route, status, slow=)`; run with
  `await SCENES[name].run(world)`, the `world` fixture in conftest). Rich on
  purpose: nullable fields get values, lists are non-empty. Add a scene for
  every new route (test_openapi_responses.py fails until one exists).
- `support/schemas.py` — `api_schema(openapi, method, route, status)` ($refs
  inlined), `DOCUMENTED` hand schemas for routes without response_model
  (probe, hls, trailers, push, health; they live in the import-free
  `support/documented.py`, which the e2e harness also checks its fake
  reel-api against), `ERROR` ({error, detail}),
  `has_field` / `payload_has` path walks (`items[].media_id`), `validate`.
- `contract_fields.py` — the table: `Read(scene, path, file, ident)` per field
  a TV/phone file reads (the exact expression, checked to still occur),
  `Code`/`Status` for error codes and statuses the clients branch on,
  `KNOWN_GAPS` for reads the API doesn't serve (findings; strict xfails in test_contract.py). A client change
  that reads a new field: add a Read.
- `test_contract.py` checks each Read against the declared schema and the
  scene's real answer; `test_openapi_responses.py` validates every scene's
  answer against its schema (declared models strictly: every property
  present, nothing extra).

## Known product bugs (strict xfails)

Product code is not changed in this lane. A test for a suspected bug
(run/findings.md, local only) states the *intended* behaviour and carries
`@known_bug("F8", "why")` from `support/known_bugs.py` — `xfail(strict=True,
raises=AssertionError)` (`xfail_strict = true` in pyproject as well). While the
bug is there it is an XFAIL; a fix makes it XPASS, which fails the run: then
remove the marker and the test guards the fixed behaviour. Through the app
these tests use `make_api(raise_app_exceptions=False)`, so a crash is the
plain 500 a client sees and fails an assertion; any other exception (a broken
fixture) is a real failure, not a silent XFAIL. `pytest -rx` lists them;
`--runxfail` shows each one's actual failure.

## Markers

- `slow` — ffmpeg-generated media or real subprocesses; excluded by the fast run.
- `ffmpeg` — needs ffmpeg/ffprobe (skips without).
- `spec` — validates mocks against a public API spec in `tests/.spec-cache/`
  (git-ignored; fetched by a script, never committed); skips when missing.

## Jellyfin 12.1 (fetched, never skipped)

`tests/specs/jellyfin-12.1-subset.json` is the slice of Jellyfin 12.1's
OpenAPI that push.py uses (3 GET operations and the DTOs they answer with:
names, types, formats, enums, `required` — descriptions dropped). It is not
in git: `tests/fetch_fixtures.py jellyfin` downloads the full spec into
`tests/.spec-cache/` (refused unless its sha256 is the pinned 12.1.0 one,
`SOURCE_SHA256`) and `tests/specs/vendor_jellyfin.py` derives the subset
from it deterministically (same spec, same bytes; change its `OPERATIONS` /
`SCHEMAS` and bump `REVISION` when push.py calls a new route).
`JellyfinSim` and the guard's `JellyfinAuthSim` validate every request they get and every answer they give
against it (`support/jfspec.py`: route, parameter names/values incl. enums
and uuids, the `MediaBrowser` auth parts — all of Client/Device/DeviceId/
Version/Token, or exactly `Token="…"`, which 12.1 answers from the token's
device record, measured 2026-10-05; answer statuses, strict DTO shapes,
`Fields`-gated optional fields — an injected `jf_auth.fault` is exempt), and
the autouse `jellyfin_spec_guard` fails the test at teardown on
any violation — and, while the subset isn't fetched, every test with Jellyfin
traffic with the fetch command. `test_jellyfin_spec.py` checks the subset is
exactly that derivation of the pinned spec, covers push.py's calls, and that
the validator catches what it claims.

## Public specs (mock fidelity)

```sh
uv run --frozen --group dev python tests/fetch_fixtures.py [--refresh] specs   # = tests/specs/fetch_specs.py -> tests/.spec-cache/ + manifest.json
```

Sonarr v4 and Radarr v5 OpenAPI JSON (pinned release tags; Radarr's
`develop` is v6 now) and the qBittorrent WebUI API wiki pages (5.0 and 4.1)
are downloaded from public GitHub URLs. They are GPL/wiki content: the cache
is git-ignored and must never be committed. Tests take the `spec_cache`
fixture (skips while a file is missing) and get `.sonarr` / `.radarr` (dicts),
`.qbit` / `.qbit41` (markdown); a cached file whose sha256 differs from the
manifest fails. `tests/support/specs.py` `qbit_endpoints(md)` parses the
WebUI page into `{"/api/v2/<group>/<name>": QbitEndpoint}` with `.params`
and `.fields` (first-column names of its tables).

## Pitfalls

- `undo._Add`/`_Get` stamp `born` with `field(default_factory=time.monotonic)`
  bound at import: a FakeClock installed on `undo` does not change it. Start
  the clock at the real monotonic time (`FakeClock(start=time.monotonic())`)
  so both agree.
- `streaming._body` serves in `CHUNK` (1 MiB) windows and waits until *all*
  pieces of the next window are in — tests at the frontier need files of a
  few MiB, not KiB.
- httpx's `ASGITransport` buffers a whole streaming body: test frontier waits
  on `streaming._body(...)` directly with a fake clock, not through HTTP.
- `livehls.LiveHls.start()` rmtree's `$CACHE_DIRECTORY/livehls` on its first
  call — only ever with the per-test cache dir.
- Manual `FakeClock` + a background loop (undo sweeper, push watcher): a
  task spawned by the request may not have reached its first `sleep` when
  the response is back — `await clock.settle(50)` (check
  `clock.pending_sleepers`) before the first `advance`. And advance one
  period at a time with a generous `settle` (e.g. `advance(SWEEP_EVERY,
  settle=200)`): one big advance only wakes sleepers already registered, so
  a loop whose HTTP calls outlast the default 10 settle iterations re-arms
  after the target and silently skips periods (see `sweep()` in
  test_undo_add.py).
- `time_machine.move_to(NOW, tick=False)` (time-machine 3) freezes
  `datetime.now()` for both reel-api and the sims; the event loop is fine.

## Mutation testing (mutmut 3)

```sh
tests/run_mutmut.sh qbittorrent streaming     # one module at a time; MUTMUT_CHILDREN=4
```

Config: `[tool.mutmut]` in `pyproject.toml`. mutmut copies `src/` and
`tests/` into `backend/mutants/` (git-ignored) and mutates only that copy,
running the fast suite (`-m "not slow"`, file order) with the usual
no-network guards; the script fails if anything under `src/` changed. It
prints killed / timeout / survived / no-tests and
`score = (killed + timeout) / (total - equivalent)`, then the survivors.
`tests/mutmut-equivalent.txt` lists mutants proven equivalent
(`<name>  # reason`). Look at a survivor with `mutmut show <name>` (via the
same `uv run ...` prefix) — never `mutmut apply`, which writes into `src/`.
The first run per source state records which tests reach which function (a
full fast-suite pass, ~5 min, cached in `mutants/`; new tests are added
incrementally).

Two mutmut 3.8 quirks are handled in the tests, not the product:
`tests/mutmut_prepare.py` generates `mutants/` first and adds `from __future__
import annotations` to generated copies where a method named like a builtin
(once the aria2/qBittorrent clients' `list`) would shadow `list[dict]`
annotations; and a test that
reads product *source* must read the unmutated file (`product_source()` in
test_spec_qbit.py), not `inspect.getsource` of the mutated copy.
