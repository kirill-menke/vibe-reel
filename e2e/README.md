# e2e — fake servers + headless end-to-end harness

Runs both apps (TV build and phone PWA) against a stateful, in-memory fake
**Jellyfin 12.1** and **reel-api**, in headless Chrome driven over raw CDP.
Zero npm dependencies: Node 22 (`node:http`, global `WebSocket`), `google-chrome`,
and `ffmpeg` (fixture video + trickplay sheets, generated once into `e2e/.cache/media`, ~1 min;
without it the stream/trickplay routes 404 and `03-media` fails).

```sh
node e2e/scripts/fetch-spec.mjs   # once: Jellyfin 12.1's public OpenAPI → e2e/.cache/ (git-ignored)
node e2e/scripts/reelapi-spec.mjs # reel-api's OpenAPI from the FastAPI app (uv, may fetch from PyPI; run.mjs regenerates it offline only)
node e2e/run.mjs                  # everything
node e2e/run.mjs --fast           # smoke subset (tests marked fast: true)
node e2e/run.mjs --grep 'tv home' # by name (case-insensitive regex)
node e2e/run.mjs --list           # what would run
node e2e/run.mjs --jobs 1         # in-process, one server + one Chrome (default: E2E_JOBS, else min(3, cores/4) workers)
node e2e/run.mjs --repeat 5 --grep X  # flake check: each selected test 5×, pass counts per test
node e2e/run.mjs --update-baselines --grep 'tv visual'  # rewrite e2e/baselines/*.png (never implicit)
E2E_VERBOSE=1 node e2e/run.mjs …  # print each test's t.log() lines
```

Parallel workers (`--jobs N`, the default on a machine with ≥ 8 cores) are child
processes of `run.mjs`, each with its own fake server on its own ports, its own
builds in `e2e/.build/w<k>/` (the ports are baked into the bundles, so each worker
remembers its ports and its build stays cached) and its own Chrome. Tests are
handed out longest-first (last run's durations, `e2e/.build/timings.json`) and
their output is printed in registry order. A test never shares a server or a
browser context with another one running at the same time.

Timing under load: Chrome is spawned detached, so it runs in its own scheduler
autogroup — busy loops started from the same shell barely slow it. To saturate
the host for a timing check, give every loop its own session:
`for i in $(seq 36); do setsid -f timeout 300 node -e 'for(;;){}'; done`
(E2E-44: `E2E_SPLASH_BOOTS=20 node e2e/run.mjs --grep 'tv splash: timing' --jobs 1`
then measured the splash unchanged at load 41, and `--fast` passed 3× at load 47).

Failures leave a screenshot and a log (test errors, page console, every server
request with its violations) in `e2e/.out/`. Every run also writes
**`e2e/.out/summary.json`** — the machine-readable record for later agents:

```js
{ at, argv, mode: 'full'|'fast'|'grep', jobs, wallMs, testMs,
  spec: { jellyfin: '12.1.0' | 'skipped', reelApi: 'validated' | 'skipped: <why>' },
  totals: { tests, passed, failed, guardHits, browserNoise },
  tests: [{ name, file, ok, ms, failures: [..], rep? }],   // registry order
  known: ['fields-always-present: UserData', …],           // KNOWN_DEVIATIONS seen
  notes: ['fake ignores SortBy=popularity', …],           // what the fake doesn't model
  routes: { implemented, hit, unhit: ['ml GET /api/…', …] }, // fake-route coverage of this run
  flake: [{ name, pass, runs, ms: [..] }] }                // only with --repeat
```

The console prints one PASS/FAIL line per test, then a short block: known
deviations grouped per id (one line each), fake-server notes and guard hits
capped at 8 lines (the rest is in summary.json), and the totals line.

## Before bumping Jellyfin on the NAS

This harness checks the apps against a *fake* Jellyfin built from 12.1's published spec;
it can't notice the real server changing underneath. Before a `nix flake update` of the
NAS flake goes live, run **`integration/jellyfin/run.sh`** (see its README): it starts the
Jellyfin that the updated lock pins on loopback (state in a temp dir, removed on exit),
builds a tiny ffmpeg library, and replays the contract against it — the real TV and phone
bundles in headless Chrome through a recording proxy (this harness's runner, Page, Chrome
guard and helpers; every request validated against *that server's* OpenAPI), direct calls
from `src/lib`'s own modules, and a diff of its OpenAPI against the routes and params the
apps use (`scripts/route-inventory.mjs` + the recorded traffic). Exit 0 = safe to rebuild
the NAS. `--version <nixpkgs ref>` tries a newer one; ~2 min.

## What makes a test fail

A test fails when its function throws **or** any of these happened during it:

- the fake Jellyfin saw a request that does not validate against the 12.1
  OpenAPI spec (unknown/removed route, wrong method, unknown query parameter,
  bad enum value, non-uuid id, unknown body property, the legacy
  `X-Emby-Authorization` header, `api_key=` on Trickplay, an identity-less
  `Authorization` header), or a route the fake doesn't implement;
- the fake reel-api saw an unknown `/api/…` route, or a request off reel-api's
  own FastAPI OpenAPI (route/method, path-param pattern/range, query names,
  pydantic body), or the fake **answered** with a 2xx JSON body that doesn't
  match `models.py` (missing required field, extra property, wrong JSON type,
  null where not Optional) — or, on the routes without a response model
  (probe, live HLS, trailers, push, health: `{}` in the OpenAPI), the shapes
  in `backend/tests/support/documented.py` that the backend's contract tests
  hold the real answers to (dumped into the spec as `x-documented`) —
  `server/reelspec.mjs`, spec dumped by `scripts/reelapi-spec.mjs` (run.mjs
  regenerates it when backend/ changes, strictly `uv run --offline`; without
  uv or with a cold uv cache the **run fails** with the hint to warm it once:
  `node e2e/scripts/reelapi-spec.mjs`; `E2E_ALLOW_NO_REEL_SPEC=1` runs without
  the contract, reported as SKIPPED);
- the fake reel-api's **request guard** refused a request, exactly as
  `backend/src/reel_api/security.py` would: no signed-in user's Jellyfin token
  (`Authorization: MediaBrowser …Token="…"` / `Bearer`, `X-Emby-Token`,
  `X-MediaBrowser-Token` or `?api_key=`) on any route but `GET/HEAD /health`
  and `POST /api/push/unsubscribe`, or a Host / http(s) Origin that is not an
  IP literal or `localhost` (401/403 + a violation — so a client path that
  forgets `mlHeaders()` / `mlUrl()` fails its scenario; the `ml-no-token` and
  `stream-no-api_key` mutants prove it). A token the fake Jellyfin doesn't
  know is a 401 without a violation (revocation is a legitimate state). Tests
  that call the fake reel-api themselves sign with `srv.mlAuth()`. The fake
  Jellyfin likewise accepts `Authorization: MediaBrowser Token="<valid>"` alone,
  as 12.1 does (measured 2026-10-05), and answers `GET /Users/Me`;
- the page — or one of its dedicated workers / its service worker — logged a
  console error, an exception / unhandled rejection, or a failed resource load
  (tests that provoke one list it in `allowErrors`); a worker's errors read
  `page exception in service_worker /sw.js: …`;
- the **network guard** blocked a request: only the fake's loopback ports are
  reachable (CDP Fetch interception on pages and workers, plus a proxy sink and
  host-resolver rules behind it). The TV's hard-coded picture service
  `127.0.0.1:8791` is redirected onto the fake one. A target whose
  `Fetch.enable` fails (and that isn't a dedicated worker, whose traffic the
  owning page's session intercepts) is reported the same way, as
  `NETWORK GUARD blocked Fetch.enable failed: (unguarded … target …)`.

Violations are judged after the server has gone quiet (no open request, none
for 100 ms, at most 1.5 s), and again after the page is closed: what it sends
on its way out (a keepalive `Stopped`, a last poll) still fails *this* test,
marked `(after the test's end)`.

A test that calls `t.skip(why)` (and returns) is printed `SKIP name — why`,
listed under "SKIPPED" at the end and counted in `summary.json`
`totals.skipped`, never as a pass — the oracle self-tests do this when the
Jellyfin or reel-api spec isn't cached.

### `KNOWN_DEVIATIONS` and `EXTRA_ROUTES` (server/spec.mjs) — the policy

Both lists are exceptions to the oracle, so both are kept tiny and justified:

- **`KNOWN_DEVIATIONS`**: a client request that is off the 12.1 spec but
  *verified harmless* (the server ignores it and the request means the same).
  Each entry is as narrow as possible — one `kind` (`param` on one template,
  `enum` value of one parameter, `body` property path on one route), one id —
  has a comment saying why it is harmless, and a **run/findings.md** entry (it
  is still a product finding). Hits are reported (console + summary.json
  `known`), never failed. Remove the entry when the product is fixed.
  Current ids: `fields-always-present`, `userimage-resize`,
  `deviceprofile-responseprofiles`, `nextup-disablefirstepisode`.
- **`EXTRA_ROUTES`**: routes real 12.1 serves that its *published* spec omits
  (dynamic HLS `master.m3u8` / `main.m3u8` / `hls1/…` segments,
  `/Videos/ActiveEncodings`), each with a `reason`. Only server-issued URLs
  belong here.
- Neither list may be used to silence a client bug: a request that would break
  against a real server fails the run, and a test that needs to provoke one
  lists the exact message in `allowViolations` (with the finding id).

## Layout

| path | what |
|---|---|
| `run.mjs` | entry: start fake server → build apps → launch Chrome → run scenarios → summary |
| `server/index.mjs` | five loopback origins (jf, ml, tv, phone with `/jf` + `/ml`, pic), faults, request log |
| `server/jellyfin.mjs` | fake Jellyfin routes (templates must exist in the spec), DTO projection honouring `Fields` |
| `server/reelapi.mjs` | fake reel-api routes (backend/README.md contract, models.py shapes) |
| `server/seed.mjs` | deterministic synthetic world: users, 140 movies, 6 series, people, play state, activity, charts, … |
| `server/spec.mjs` | OpenAPI request validator (recursive JSON bodies, Jellyfin's binding rules), `EXTRA_ROUTES`, `KNOWN_DEVIATIONS` |
| `server/reelspec.mjs` | reel-api contract: requests + the fake's own responses vs the backend's OpenAPI |
| `scripts/route-inventory.mjs` | static inventory of every request path in src/ + phone/src (read as text) → shapes; `02-inventory` checks spec + fake |
| `lib/bodies.mjs` | copies of the JSON bodies the apps POST (device profiles, play reports) for the oracle self-tests |
| `server/png.mjs`, `server/media.mjs` | generated artwork (pure Node PNG); fixture media (ffmpeg, cached): a 60 min 2 fps WebM with the time burned in, trickplay sheets cut from it, a VTT on the same clock |
| `lib/build.mjs` | TV + phone builds into `e2e/.build/` with `VITE_*` pointed at the fake (cached by content hash + ports) |
| `lib/chrome.mjs`, `lib/cdp.mjs`, `lib/page.mjs` | Chrome launch + network guard, CDP client, page driver (keys, touch, eval, waitFor) |
| `lib/runner.mjs` | `test()`, `assert`, the runner |
| `lib/tv.mjs`, `lib/invariants.mjs`, `lib/phone.mjs` | app helpers: boot signed in/out, focus, scope, focus invariants |
| `lib/world.mjs`, `lib/player.mjs`, `lib/crawler.mjs`, `lib/visual.mjs` | world builders, TV player helpers, the D-pad invariant crawler, screenshot baselines |
| `baselines/*.png` | 4 committed 960×540 screenshot baselines (`25-tv-visual`) |
| `scenarios/NN-*.test.mjs` | the tests; `00–09` oracle/guard self-tests, `10–49` TV, `50–59` phone, `60–69` TV player, `70–79` crawler, `90–99` meta |

## Writing a test

```js
import { test, assert } from '../lib/runner.mjs';
import { bootTv, waitFocus, press, checkFocusInvariants } from '../lib/tv.mjs';

test('tv library: …', { fast: false, seed: { movies: 140 } }, async (t) => {
  const { page, srv } = t;            // fresh world + fresh browser context per test
  srv.world.ml.activity.length = 0;   // set the case up by mutating the world
  await bootTv(t);                    // signed in as alice; { signedIn: false } for Login
  await waitFocus(page, 'tab-home');
  await press(page, 'Right Enter');   // trusted keys: Left Up Right Down Enter Back Play Pause Stop …
  assert.deepEqual(await checkFocusInvariants(page, { dupOk: ['tile-'] }), []);
  const f = srv.fault({ origin: 'jf', path: '/UserItems/Resume' }, { status: 500 }); // fault switch
  f.remove();
  srv.requests({ origin: 'jf', path: '/Items' });   // what the app asked
});
```

Rules: never contact anything but the fake (the guard enforces it); never
weaken a check to get green — fix the test, the fake, or record a finding.

## The fake server (`t.srv`)

| member | what | example |
|---|---|---|
| `srv.world` | the in-memory world of this test (fresh per test, `seed.mjs`) | `srv.world.list('Movie')[0]` · `srv.world.byName('Series', 'Northern Line')` |
| `srv.urls` | `{ jf, ml, tv, phone, pic }` loopback origins | `page.goto(srv.urls.tv + '/index.html')` |
| `srv.requests(filter)` | the request log, filtered by `origin`, `method`, `path` (prefix or RegExp) | `srv.requests({ origin: 'ml', path: '/api/activity' }).length` |
| `srv.quiet({ ms, max })` | resolves once no request is open and none came for `ms` (bounded by `max`); `srv.inflight` is the open count | `await srv.quiet({ ms: 300 })` |
| `srv.log` | every request: `{ t, origin, host, method, path, search, status, auth?, fault?, violations }` | `srv.log.at(-1).status` |
| `srv.events` | state changes the fake applied: `played`/`unplayed`, `userdata`, `playbackinfo`, `stopEncoding`, `picture` … | `srv.events.filter((e) => e.kind === 'played')` |
| `srv.violations` | what fails the test (spec, unknown route, crash) | — (the runner checks it) |
| `srv.issueToken(user, deviceId)` | a token as a sign-in would give (`bootTv`/`bootPhone` use it) | `srv.issueToken('bob').token` |
| `srv.approveQuickConnect(code, user)` | approve a Quick Connect code shown on Login | `srv.approveQuickConnect('123456', 'alice')` |
| `srv.fault(match, effect, times)` | the **fault switch** (below) | `srv.fault({ origin: 'jf', path: '/Shows/NextUp' }, { status: 500 })` |

### Fault switch

```js
const f = srv.fault(
  { origin: 'jf' | 'ml' | 'pic' | '*', method: 'GET', path: '/UserItems/Resume' /* prefix */ | /RegExp/ },
  { status: 503, json: {…} | text: '…', delay: 8000 /* ms, then the real answer or status */,
    hang: true /* never answer */, drop: true /* destroy the socket */ },
  2 /* times; default unlimited */
);
f.hits;      // how many requests it answered
f.remove();  // back to normal
```

The first matching fault wins; a faulted request is logged with `fault: true`.
`srv.reset()` (between tests) clears all faults.

A download that stopped: `srv.world.ml.cutStreams.add(downloadId)` makes
`/api/downloads/{id}/stream` serve the first 20 s of the fixture (`media.cut`)
instead of the whole hour (`45-tv-pending-play`). The stream answers with
`Cache-Control: no-store` like reel-api's — headless Chrome still reuses a
fully loaded file from its in-memory media cache on a reload of the same URL,
so a Retry there sends no new request.

A stream that stalls or crawls: `srv.world.streamShape = { free, burst, bps }`
(`shapeStream()` in `lib/player.mjs` builds it from media seconds) sends the
Jellyfin static stream's first `free` bytes at full speed (the WebM header and
FFmpeg's probe need ~40 s' worth), a request starting past that (a resume seek)
`burst` bytes at full speed, then `bps` bytes/s — `0` holds the response open
and silent. The last 64 KiB (the Cues) are always free. Read live on every
100 ms step; `shape.sent` / `shape.requests` count what went out
(`66-tv-player-stall`). Chrome's `buffered` for a plain `src=` is the received
byte ranges mapped linearly onto the duration, so a trickle moves it smoothly.
Play reports (`/Sessions/Playing*`) keep their JSON body on the log entry
(`entry.body`), so a faulted one can be inspected; every Jellyfin entry gets
`done` (ms) when its answer finished.

A trailer that works: `srv.world.ml.trailers.set(youtubeId, { subs?, title? })`
makes reel-api's trailer job "ready" at once (POST/GET `/api/trailers/{id}`)
and serves the fixture's first 30 s as its fMP4 HLS (`media.trailer`: index.m3u8,
init.mp4, s000–s002.m4s, VP9 + Opus) plus `subs.vtt` (the fixture VTT; `subs:
null` = none). `srv.world.ml.trailerFiles` lists every file served, in order
(`65-tv-trailer`). Without an entry every trailer answers `state: 'error'`.
Keys parse like trailers.py `parse_key`: `<id>@<height>` (the phone's `@1080`)
is its own job (started per canonical key, listed in the entry's `keys`) served
from the same fixture, and `trailerFiles` entries carry that key (`59-phone-trailer`).
Cancels (`DELETE /api/activity/…`) follow undo.py: one row of a torrent takes
the whole torrent, importing torrents are kept (all importing → 409), and
`srv.world.ml.cancels` records `{ type, id, season, episode, removed }`.
The phone's live HLS of a growing download: `srv.world.ml.liveHls.set(downloadId,
{ probing: 1 })` gives `/api/downloads/{gid}/hls` a job (the first `probing`
status answers have no codecs, then "remuxing"), serving the same 30 s fMP4 as
a still-growing playlist with livehls's `s00000.m4s` names, all no-store;
`srv.world.ml.liveFiles` lists what was fetched (`58-phone-pending-play`).
Without an entry it answers like a reel-api without qBittorrent (503).

**Ownership and quotas** (run/design.md §5, pinned by `05-fake-ownership`).
Every reel-api route sees the guard's user (`ctx.user = { id, name, admin }`,
admin = the user's `admin` flag, which the fake Jellyfin's `/Users/Me` answers
as `Policy.IsAdministrator`). In `srv.world.ml`:

| field | what |
|---|---|
| `owners` | `Map` title key (`'movie:900002'`, `'tv:400001'`) → `{ owner: userId, at }`; a title without one is legacy (the admins') — every seeded title is |
| `seasons` | `Map` `'tv:<tvdb>:<n>'` → `{ owner, at }`: a season Get's requester (may cancel that season's grabs, undo the Get) |
| `quota` | `{ movie: 10, tv: 10 }` — a normal user's limits (admins: none); `0` turns adding off |
| `deletes` | `{ type, id, user }` (user = name) of every delete with files |
| `own(type, id, user, { at })` | mark a catalog entry added and record `user` (name) as its owner — `w.ml.own('movie', '900002', 'nicole')` |
| `fill(user, type, n)` | `n` fresh owned titles ("Owned Film 01…", tmdb 920001… / "Owned Show 01…", tvdb 420001…; status `waiting`) so the seed's un-added titles stay addable — `w.ml.fill('nicole', 'tv', 10)` = shows full |
| `oldBackend` | `true` = a reel-api from before ownership: `/api/me` 404, activity without `mine`/`can_cancel`, no quota or permission checks, no records |

`POST /api/library` checks a normal user's quota first (409 `quota_exceeded`
with `type`/`used`/`limit`, even for an already-added title) and records the
caller; `GET /api/me` counts and lists the caller's records whose title the
arr still has (catalog `added`, or a grab in the feed; others are pruned), with
status from the feed (size-weighted progress), else `in_library` when Jellyfin
has the title, else `waiting`. `DELETE /api/library/{type}/{id}` takes exactly
one of `undo=` (the adder or an admin; 403 `not_owner` otherwise) and
`delete_files=true` (owner or admin; a legacy title admin-only; 409 `importing`
with an importing grab; `already_removed` for a title the arr no longer has):
the grabs leave the feed, the entry is un-added, the record and the series'
season records and news go. Cancels and season-Get undos are the owner's /
requester's or an admin's (403 `not_owner`, checked after 404/409 like the
backend); `/api/activity` rows carry `mine` and `can_cancel` for the caller.
Not modelled (a run note): deletes are synchronous (no `deleting`, no 409
`being_deleted`) and leave the Jellyfin item (the real Jellyfin drops it on its
next scan).

### Seed options (`test(name, { seed: {…} })`)

| option | default | effect |
|---|---|---|
| `movies` | 140 | library size (126 per Library page → 140 means two pages) |
| `bigCharts` | false | a 250-entry Top 250 Movies chart |
| `preset: 'empty'` | — | no play state, empty activity feed, no news (a fresh account) |
| `preset: 'big'` | — | 400 movies + bigCharts |
| `now` | `Date.now()` | the clock the seed's relative dates hang off |

Defaults: alice (password `alice-pw`, admin) + bob (no password, no avatar,
normal user) + kirill (`kirill-pw`, avatar, admin) + nicole (`nicole-pw`, no
avatar, normal user) — `w.kirill`, `w.nicole` like `w.alice`/`w.bob`; 6
series, Continue Watching / Next Up for alice, an activity feed (a downloading
movie, a queued new show, a downloading episode), 2 news items. Ids derive from
names, so they are stable across runs. Details: the header of `server/seed.mjs`.

## Helper reference (`lib/*.mjs`)

Every exported name, one line each. `t` is the test context, `page` a `Page`, `w` = `t.srv.world`.

### `lib/runner.mjs`
- `test(name, opts, fn)` — register a test: `test('tv x', { fast: true, seed: { preset: 'empty' }, allowErrors: [/…/] }, async (t) => {…})`
- `innerTest(name, opts, fn)` — an unregistered test for `t.runInner([...])` (runner self-tests only)
- `assert(cond, msg)`, `assert.equal(a, b)`, `assert.deepEqual(a, b)`, `assert.match(s, re)` — `assert.equal(n, 2, 'two polls')`
- `AssertionError` — what `assert` throws (printed without a stack)
- `tests` — the registry (run.mjs reads it); `setCurrentFile(f)` — run.mjs tags tests with their file
- `runAll({ list, srv, browser, outDir })` — run tests, judge failures (run.mjs, `t.runInner`)
- `routesHit(srv)` — the fake routes the current test's requests reached (`'jf GET /Items/{itemId}'`);
  `routeTemplates(srv)` — every route the fake implements. run.mjs folds them into summary.json's `routes`
- in a test: `t.srv`, `t.page`, `t.log('…')`, `t.step('name', fn)`, `t.skip(why)`, `t.browser`, `t.runInner(list)`, `t.expectBlocked(re)`

### `lib/page.mjs` (`Page`, one per test, own browser context)
- `KEYS` — key names → webOS keycodes: `Left Up Right Down Enter OK Back Escape Backspace Play Pause Stop Rewind FastForward`
- `IPHONE` — the phone emulation metrics + iOS Safari UA
- `Page` — `await page.goto(url)` · `page.reload()` · `page.eval(fn, ...args)` · `page.waitFor(fn, { timeout, what }, ...args)` · `page.holds(fn, { ms, what })` · `page.key('Down', { settle })` · `page.hold('OK', 700)` · `page.chars('dune')` (USB keys) · `page.type('alice')` (insertText) · `page.frames(2)` · `page.tap(x, y)` · `page.press(x, y, 700)` (touch long-press) · `page.tapSel('.tabbar__item')` · `page.swipe(x0, y0, x1, y1)` · `page.screenshot(file)` · `page.errors` / `page.console`
- `sleep(ms)` — `await sleep(200)` (prefer `waitFor`/`holds`; no fixed sleeps > 500 ms)
- `holds(fn, ms, what)` — Node-side observation window: `await holds(() => polls() === n, 2500, 'no poll after sign-in')`

### `lib/tv.mjs`
- `bootTv(t, { signedIn, user, storage, skipSplash })` — `await bootTv(t, { user: 'bob' })`
- `SIGNED_OUT_BOOT` — spread into a signed-out test's opts (finding F-001 noise): `test('…', { ...SIGNED_OUT_BOOT }, …)`
- `openPendingTile(t, tab, key)` — boot → Movies/Shows tab → the PendingTile → PendingDetail: `await openPendingTile(t, 'movies', 'pend-movie:900001')`
- `waitSplashGone(page, timeout = 12000)` — `await waitSplashGone(page)`; 12 s = the splash's own 10.85 s hard deadline + margin (measured 3.6–3.8 s even on a saturated host, `26-tv-splash`); a timeout's error carries the page state (frames in 500 ms, scene opacity, screen, rails)
- `focused(page)` — the focused `data-focus` key or `<body>`: `assert.equal(await focused(page), 'play')`
- `waitFocus(page, key | /re/, timeout)` — `await waitFocus(page, /^tile-/)`
- `screen(page)` — `{ screen, search, player, splash, menu, title }`: `(await screen(page)).screen === 'home'`
- `press(page, 'Right Right Enter')` — a key sequence
- `steer(page, key)` — D-pad by geometry onto `data-focus=key`: `await steer(page, 'tile-' + m.Id)`
- `kbType(page, 'dune')` — type on Search's own keyboard with the D-pad
- `checkFocusInvariants`, `scopeKeys`, `sleep`, `holds` — re-exported (below / page.mjs)

### `lib/invariants.mjs`
- `checkFocusInvariants(page, { dupOk: ['tile-'], allowBody })` — `[]` or problems: `assert.deepEqual(await checkFocusInvariants(page, { dupOk: ['tile-'] }), [])`
- `scopeKeys(page)` — the data-focus keys in the active scope: `(await scopeKeys(page)).includes('play')`
- `inPageScope` — serialisable scope function (mirrors focus.js `focusables()`), used by the crawler

### `lib/crawler.mjs`
- `crawl(page, { name, keys, dupOk, maxStates, settle, restore, check, prefer })` — BFS over D-pad moves: `const r = await crawl(page, { name: 'home', dupOk: ['tile-'] }); assert.deepEqual(r.problems, [])`
- `crawlSummary(r)` — one line for `t.log(crawlSummary(r))`
- `walkTo(page, r, 'tile-…#1')` — replay observed edges to a crawled state
- `probe(page)` — `{ sig, id, key, body }` of the focus right now

### `lib/phone.mjs`
- `bootPhone(t, { signedIn, user, storage })` — `await bootPhone(t)`
- `tabs(page)` — tab bar labels: `['Home', 'Movies', 'Shows', 'Search']`
- `topRoute(page)` — data-key of the top route of the active stack
- `tabBarArmed(page)` — the tab bar is up with its 4 items; `openTab` waits for it
- `openTab(page, 'Movies')` — tap a tab and wait until it is current
- `topHas(page, '.hero')` — wait for a settled top route containing css → its key
- `tapIn(page, 'button', /Add/)` — tap the first visible match by label/text (scope `route` | `doc`)
- `sheetUp(page, 'Sort & filter')` — wait for a sheet with that title
- `setHidden(page, true)` — real visibilitychange by minimising the window (works for the TV page too)

### `lib/world.mjs` (scenario builders; only change memory)
- `series(w, 'Northern Line')`, `season(w, s, 2)`, `ep(w, 'Northern Line', 1, 3)` — items by name/number
- `movie(w, 0)` / `movie(w, 'The Silent Harbor')` — a Movie by library index or name
- `user(w, 'bob')` — the user record; `userData(w, 'alice', item)` — its UserData (created on demand)
- `setPosition(w, 'alice', item, 1200)` — resume point (s); `setPlayed(w, 'alice', item, true)` — watched
- `addPending(w, { type: 'movie', media_id: '900002', progress: 0.2, probe: true })` — a grab in `/api/activity`
- `landImport(w, 'q-movie-900001')` — the grab leaves the feed, Jellyfin gains the item
- `TICKS` — 10 000 000 (ticks per second)

### `lib/player.mjs` (TV player)
- `homeReady(t)` — boot → Home with 4 rails
- `openMovieDetail(t, movie)` — boot → Movies → tile → MovieDetail
- `startAndPlay(t, movie, { resumeSec })` — OK → PlaybackInfo (no-transcode asserted) → card → playing: `const { s0 } = await startAndPlay(t, m)`
- `exitWithBack(t, s0)` — play 2 s on, Back ×2 → the Stopped report
- `vstate(page)` — `{ t, paused, src, ready, err }` of the `<video>`; `playBtn(page)` — the Play button's label
- `fmtTime(1200)` → `'20:00'`; `until(() => cond(), 'what', 5000)` — poll a Node-side condition
- `aliceOf(w)`, `epOf(w, series, s, e)` — aliases of `user(w, 'alice')`, `ep()`
- `installClock(page, { waiting })` — before boot: a steerable page clock (`__e2eClock.skip(ms)` jumps `Date.now()`, `setRate(r)`, `setTimerScale(s)` scales `setTimeout` ≥ 1 s); `waiting: false` swallows the media element's `'waiting'` (the TV fires none): `await installClock(page, { waiting: false })`
- `spyFetch(page)` — before boot: every `fetch()` recorded in `window.__e2eFetches` as `{ url, method, keepalive, at }`
- `shapeStream(t, { freeSec, burstSec, rate })` — throttle the Jellyfin stream (below); returns the live shape: `const sh = shapeStream(t, { freeSec: 45, burstSec: 30, rate: 0.2 }); sh.bps = 0`

### `lib/visual.mjs` (screenshot baselines, `25-tv-visual`)
- `matchBaseline(t, 'tv-home', { mask: ['.qc-code'], tol: 40, maxRatio: 0.004 })` — settled capture vs `baselines/tv-home.png`; a mismatch writes `e2e/.out/<name>.actual.png` + `.diff.png`
- `captureSettled(page, { mask })` — fonts + images loaded, caret hidden, two identical frames → 960×540 RGB
- `decodePng(buf)`, `encodePng(img)`, `downscale(img, 2)`, `fillRects(img, rects)`, `compare(a, b, { tol })` — zero-dependency image ops
- `updating()` — true under `--update-baselines`; `BASELINE_DIR`, `MAX_BASELINE_BYTES` (150 KB each, ≤ 4 files)

### `lib/bodies.mjs` (copies of what the apps POST, for the oracle self-tests)
- `tvProfile(burn)`, `phoneProfile({ cap, av1, dv5 })` — DeviceProfiles
- `tvPlaybackInfo(userId, {…})`, `phonePlaybackInfo(userId, {…})`, `offlinePlaybackInfo(userId, {…})` — PlaybackInfo bodies
- `baseReport(itemId, {…})` — a Sessions/Playing* report; `offlineUserData({…})` — the offline sync's UserData

### `lib/chrome.mjs`, `lib/cdp.mjs`, `lib/build.mjs` (plumbing; run.mjs uses them)
- `launchChrome({ runDir, allowPorts, picUrl, headless })` → `browser` (`browser.newPage({ mobile })`, `browser.guard.blocked`, `browser.close()`)
- `CDP` — `await CDP.connect(wsUrl)`; `cdp.send(method, params, sessionId)`, `cdp.on(event, fn)`, `cdp.session(id)`
- `buildApps({ jf, ml, dir })` — TV + phone builds pointed at the fake (cached); `REPO`, `BUILD_DIR`

A fast self-test (`04-docs`) fails when an export of `lib/*.mjs` is missing here.
