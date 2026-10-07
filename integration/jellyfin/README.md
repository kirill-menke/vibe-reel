# integration/jellyfin — the client against a real, throwaway Jellyfin

Run this **before bumping Jellyfin on the NAS** (a `nix flake update` of the NAS flake moves
`nixpkgs#jellyfin`). It starts the Jellyfin that nixpkgs pin would deploy, on loopback, with
its state in a temp dir, and replays VibeReel's client contract against it. The e2e harness
(`e2e/`) checks the apps against a *fake* 12.1 built from the published spec; this run checks
the spec and the fake's assumptions against the *real* server, so a server-side change (a
route removed, a header no longer read, a param dropped, a different PlaybackInfo decision)
shows up here before it reaches the TV.

```sh
integration/jellyfin/run.sh                      # the Jellyfin ~/.config/nixos/flake.lock pins (~2 min)
integration/jellyfin/run.sh --version nixos-unstable          # a newer nixpkgs: branch, rev,
integration/jellyfin/run.sh --version github:nixos/nixpkgs/<rev>   # or any flake ref
integration/jellyfin/run.sh --jellyfin /nix/store/…-jellyfin-12.2   # a package you built
integration/jellyfin/run.sh --no-browser         # probe + spec diff only (no Chrome)
integration/jellyfin/run.sh --grep 'tv playback' # a subset of the browser scenarios
integration/jellyfin/run.sh --serve              # set up, print URL + login, wait for Ctrl-C
node integration/jellyfin/selftest.mjs           # offline self-test of the harness (~5 s)
```

The workflow for a bump: `nix flake update` in `~/.config/nixos` (the lock now pins the
candidate), run `run.sh` (it reads that lock; `NAS_FLAKE=…` points elsewhere), and rebuild
the NAS only on `PASS`. `--version` takes a nixpkgs ref, not a Jellyfin version number:
`nix eval github:nixos/nixpkgs/<ref>#jellyfin.version` tells which Jellyfin a ref has.

Exit 0 = every check passed, 1 = a check failed, 2 = the server couldn't be started. Needs
nix, Node 22, `google-chrome` (not for `--no-browser`) and the repo's `node_modules`.
Fixtures are made once with the Jellyfin package's own `jellyfin-ffmpeg` (~13 s).

## What it does

1. **Server** (`run.sh`): `nix build` of `jellyfin` from the chosen nixpkgs, a free port on
   127.0.0.1 (no UPnP, no discovery, no remote access), all state in a `mktemp -d` that a
   trap removes on any exit. Outbound HTTP goes to a dead loopback proxy (`HTTP(S)_PROXY`),
   so plugin repositories and metadata providers are never contacted.
2. **Setup** (`setup.mjs`, the server's own API): startup wizard, user `alice` / `alice-pw`
   with an avatar, Movies + Shows libraries with metadata fetchers off, scan, trickplay
   (320 px / 10 s like the NAS), watch state (Browser Movie resumable at 0:40, S01E01
   played → S01E02 is Next Up). `MinResumeDurationSeconds` is 0 (the files are short).
3. **Fixtures** (`fixtures.mjs`, cached in `.cache/`): *Contract Movie* — HEVC + E-AC3 5.1
   `eng` + AAC 2.0 `ger` + SRT + ASS, chapters Prologue / Intro / Story / Credits;
   *Browser Movie* — H.264 + AAC MP4 that headless Chrome decodes; *Contract Show* S01E01–02.
4. **Contract probe** (`contract.mjs`): requests built by the **shipped `src/lib` modules**,
   loaded into Node through Vite with the builds' own plugins and `__PHONE__` define
   (`client.mjs`): `api()`, `GRID_FIELDS`/`itemsPath()`, `seasonsPath()`/`episodesPaths()`/
   `nextUpPath()`, `deviceProfile()` (TV and phone), `describeTracks()`, `setPlayed()`,
   `findMarkers()`, `avatarUrl()`. URLs built inside `player.svelte.js` (it owns the
   `<video>`) are copied expression-for-expression with the source named.
5. **Browser scenarios** (`scenarios.mjs`): the real TV and phone bundles in headless
   Chrome, driven by the e2e harness's runner, keys and helpers, against the real server
   through a recording proxy (`proxy.mjs`). reel-api, the static origins and the picture
   service stay the e2e fake's; the fake reel-api enforces reel-api's request guard, and
   its token check is the real server's (`GET /Users/Me`, Token-only, once per token).
6. **Spec diff** (`specdiff.mjs`): this server's `/api-docs/openapi.json` vs the client.

Every request the apps and the probe send goes through the proxy and is validated against
**that server's** OpenAPI (e2e's `Spec`, with its `EXTRA_ROUTES` / `KNOWN_DEVIATIONS`), the
legacy auth forms are refused, and any 4xx/5xx answer fails the scenario that caused it.

## What it pins

| check | the contract | from |
|---|---|---|
| `auth-header`, *real tv login* | sign-in with `Authorization: MediaBrowser Client=…, Token=…` | api.js |
| `auth-guard-users-me` | `GET /Users/Me` with `Authorization: MediaBrowser Token="…"` alone → 200 `{Id}`; an unknown token → 401 (the scenarios' reel-api calls pass the same check: `proxy.mjs` admits a token into the fake reel-api only after the real server confirms it) | backend `security.py` |
| `auth-legacy-header` | `X-Emby-Authorization` alone → 400 (why api() doesn't send it; a change only warns) | CLAUDE.md |
| `items-grid-fields`, *real tv library* | `/Items` with `GRID_FIELDS,ProviderIds` returns UserData, year, MediaStreams | Library.svelte |
| `item-detail-tracks`, *movie detail* | `describeTracks()` on real MediaStreams: E-AC3 5.1 default, AAC `ger`, SRT + ASS | tracks.js |
| `series-paths`, *series detail* | Seasons / Episodes / NextUp builders | api.js |
| `playbackinfo-tv` | `deviceProfile(false)` → DirectPlay, no `TranscodingUrl` (MKV, MP4, episode) | the no-transcode contract |
| `playbackinfo-tv-burn` | `deviceProfile(true)` with a text sub on a VobSub-free MKV → still DirectPlay | tracks.js |
| `playbackinfo-phone`, `phone-hls-main`, *real phone* | phone profile → MKV gets a `master.m3u8` TranscodingUrl with the video copied; `main.m3u8` answers; MP4 DirectPlays; the job stops | player.svelte.js |
| `static-stream-range`, *real tv playback* | `static=true` stream with `api_key=` and Range → 206 + Content-Range | directUrl() |
| `subtitle-vtt` | `Stream.vtt` for SRT and ASS (`api_key=`) | attachSubtitles() |
| `media-segments`, `find-markers` | `/MediaSegments/{id}` shape; `findMarkers()` finds the named chapters | segments.js |
| `trickplay-apikey`, *tv playback* scrub | the `Trickplay` field shape; a sheet with `ApiKey=` → 200 | trickAt() |
| `trickplay-api-key-legacy` | `api_key=` on a sheet → 401 (recorded; a change only warns) | CLAUDE.md |
| `played-toggle`, *movie detail* Watched | `POST`/`DELETE /UserPlayedItems/{id}` and the UserData they return | played.js |
| `session-reports`, *tv playback* | `Sessions/Playing`, `/Progress`, `/Stopped` → 204; Stopped saves the position | player.svelte.js |
| `user-image` | `avatarUrl()` → `/UserImage?userId=` 200 image | account.svelte.js |
| `quick-connect`, *real tv login* | Enabled → Initiate → Connect → Authorize → AuthenticateWithQuickConnect | Login.svelte |
| `spec-routes` | every route shape in `src/` + `phone/src` (e2e's static inventory) exists | route-inventory.mjs |
| `spec-traffic` | every recorded request validates against this server's OpenAPI | the proxy |
| `spec-params` | query params / body properties of every used operation: removed since the 12.1 baseline (`e2e/.cache`, `node e2e/scripts/fetch-spec.mjs`) and sent or named in the source → fail | specdiff.mjs |
| `legacy-routes` | old routes still served? (info only) | — |

## Output

One PASS/FAIL/WARN/INFO line per check and scenario, then the verdict with timings.
`.out/report.json` holds every check, scenario and the recorded route list;
`.out/openapi-<version>.json` the server's spec; a failing scenario leaves a screenshot and
a request log in `.out/`, a failing run the server's log as `.out/jellyfin.log`.
`.cache/` (fixtures) and `.build/` (bundles pointed at the proxy, cached) are git-ignored.

Measured 2026-10-04 against the NAS pin (nixpkgs e94cb152, Jellyfin 12.1.0): 29/29 passed,
~115 requests, 87–102 s wall (server start ~25 s, setup ~11 s, probe ~10 s, browser ~41 s).
Also run against nixos-25.05 (Jellyfin 10.10.7): passes, with WARNs for the two 12.x-only behaviours.
