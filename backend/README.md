# reel-api

VibeReel's backend: a personal LAN service in front of Sonarr, Radarr and
qBittorrent. VibeReel uses it for lookup/add, the download activity feed,
watch-while-downloading streams, metadata, trending, charts, trailers, new-season news
and push notifications. It began as a small three-stage JSON API — search → resolve
magnet → download, over Prowlarr (or a scraper) and qBittorrent (or aria2) — that no
client used any more; it was removed in 2026-10 (see "Upstreams").

**LAN use only. Do not expose this publicly.**

## Access control (`security.py`)

Every request passes three checks before it reaches a route:

1. **Host** must be an IP literal, `localhost`, or a name in
   `REEL_API_ALLOWED_HOSTS` — else `403 bad_host`. This defeats DNS rebinding
   (a rebinding page's requests carry the attacker's domain in Host). A reverse
   proxy in front must pass the browser's Host through.
2. **Origin**, when a browser sends an http(s) one, must name a host allowed by
   the same rule — else `403 bad_origin`. `null`, `file://` and app schemes
   (the TV) go on to step 3.
3. **A Jellyfin access token** of a signed-in user — else `401 unauthorized`.
   reel-api asks Jellyfin (`GET /Users/Me`) whose it is; answers are cached
   (10 min, a rejection 30 s), and a confirmed token keeps working for 24 h
   while Jellyfin is unreachable (an unknown one gets `503`). After a check
   that found Jellyfin down or hanging, such tokens are answered at once for
   30 s instead of each request waiting up to 5 s for another check. Send it as
   `Authorization: MediaBrowser Token="…"` (what the clients send Jellyfin),
   `Authorization: Bearer …` or `X-Emby-Token`; URLs a media element fetches
   itself (the `/stream` endpoint) carry it as `?api_key=…`, which the access
   log blanks.

The same `GET /Users/Me` answer names the user and their role: **admin** =
Jellyfin's `Policy.IsAdministrator` (exactly `true`; anything else is a normal
user). Routes read it as `request.state.reel_user` to apply ownership and quotas
(below). It is cached with the token, so promoting/demoting an admin or renaming a
user takes effect within 10 min, and while Jellyfin is unreachable a stale-OK token
keeps the role it had. No user name is hard-coded anywhere.

Open without a token: `GET /health` and `POST /api/push/unsubscribe` (a phone
that signed out still takes its subscription off; the endpoint it names is
itself a secret). For curl, use a signed-in user's token (e.g. the app's
`localStorage['reel.token']`):

```sh
curl -H 'Authorization: MediaBrowser Token="<jellyfin token>"' http://nas:8790/api/activity
```

## Upstreams

reel-api grabs nothing itself. **Sonarr / Radarr** find, download and import every
title (they search the indexers you configured, e.g. through Prowlarr); reel-api adds
titles to them, reads their queues, history and metadata, and cancels/undoes their
grabs. **qBittorrent** is only read and steered: live progress for the activity feed,
sequential download for the arrs' torrents, the watch-while-downloading streams (a
torrent is addressed by its info-hash, whatever its category), and removing a cancelled
grab with its partial data. **Jellyfin** checks every request's token. Trending, charts,
collections and community segments read public metadata services (IMDb, Radarr's
metadata service, IntroDB).

Removed in 2026-10, because no client called them (the apps only use the downloads'
`/stream`, `/probe` and `/hls`): `GET /api/search`, `GET /api/torrents/{id}/magnet`,
`POST /api/downloads`, `GET /api/downloads`, `GET /api/downloads/{id}` and
`DELETE /api/downloads/{id}` (now plain `404`s), with the Prowlarr search client, the
1337x-style scraper (and its optional `curl_cffi`/`beautifulsoup4`/`lxml` dependencies),
the aria2 download backend and reel-api's own qBittorrent category (`reel`, created at
startup). Torrents left in that category from earlier manual downloads stay untouched:
a cancel, undo or delete never removes one (`undo.py`, `MANUAL_CATEGORY`).

## Run (dev)

```sh
SONARR_URL=http://127.0.0.1:8989 SONARR_API_KEY=<key> \
RADARR_URL=http://127.0.0.1:7878 RADARR_API_KEY=<key> \
QBIT_URL=http://127.0.0.1:8080 JELLYFIN_URL=http://127.0.0.1:8096 \
  uv run uvicorn reel_api.app:app --port 8790
```

Config env vars:

- `QBIT_URL` — qBittorrent WebUI base; **unset = `/api/downloads/{id}/stream`,
  `/probe` and `/hls` answer 503**, `/api/activity` shows the arrs' own (≈ 1 min old)
  progress, and a cancel/undo removes only the arr's queue rows. Auth, first match
  wins:
  - `QBIT_API_KEY_FILE` / `QBIT_API_KEY` — qBittorrent 5.2+'s WebUI API key
    (Options → WebUI → API key, `qbt_` + 28 letters/digits), sent as
    `Authorization: Bearer <key>` on every call. Stateless: no login, no session
    to expire, not subject to the failed-login IP ban. The file (a systemd
    credential; the NixOS module's `qbittorrentApiKeyFile`) is read once at
    startup, stripped, and wins over `QBIT_API_KEY`; a set file that reel-api
    finds missing, empty or unreadable is logged and every download call answers 503
    (no fall-back to the password). A refused key (401/403) is a 503, never a
    login. The key is never logged. **Under the NixOS module a missing file is
    worse:** `qbittorrentApiKeyFile` goes through `LoadCredential=`, which
    systemd resolves before reel-api runs, so a missing file fails the whole
    unit (`243/CREDENTIALS`, restarted in a loop) and every endpoint is down,
    not just the downloads. Only a file that exists but is empty or holds an
    unusable key reaches the 503 path above.
  - `QBIT_USERNAME` / `QBIT_PASSWORD` — a cookie login, repeated once when the
    session expires. Ignored while a key is set.
  - neither — for a qBittorrent that skips auth for this client (loopback with
    LocalHostAuth off, or a whitelisted subnet).

  **qBittorrent 5.2 changed the login:** a good `POST /api/v2/auth/login` answers
  **204** with no body (4.1–5.1: `200 "Ok."`), bad credentials **401** (was
  `200 "Fails."`), and the session cookie is `QBT_SID_<port>` (was `SID`).
  reel-api takes either answer: `200 "Ok."` whatever the cookie is called
  (4.6–5.1 can rename it, `WebAPI\SessionCookieName`), any other 2xx only with a
  `SID`/`QBT_SID_<port>` cookie set by that answer — or, for 5.2's "still logged
  in" `204`, the one the request carried — so a proxy's page on top of a stale
  cookie is no login. Until 2026-10 it wanted exactly `200 "Ok."`, so against 5.2 it had no
  qBittorrent access at all (no progress, streaming or cancel). The IP ban after
  repeated failed logins (403 on both versions) is the other reason to prefer the
  API key.
- `SONARR_URL` / `SONARR_API_KEY`, `RADARR_URL` / `RADARR_API_KEY` — lookup, add,
  activity, metadata (`*_QUALITY_PROFILE`, default `HD-1080p`). A type without its key
  answers 503.
- `JELLYFIN_URL` (default `http://127.0.0.1:8096`) — checks every request's token
  (see Access control); push waits until a title is in Jellyfin before announcing it.
- `REEL_API_ALLOWED_HOSTS` — comma list of host names clients use besides IP
  literals and `localhost` (e.g. `nas,nas.local,nas.example.ts.net`).
- `VAPID_PRIVATE_KEY` — enables Web Push (unset = push disabled); `VAPID_SUBJECT` — a
  `mailto:` or `https:` URL identifying you to the push services (Apple rejects
  placeholders).
- `HOST` / `PORT` (default `127.0.0.1:8790`; `HOST` may be a comma list, e.g.
  `127.0.0.1,192.168.1.10`), `CACHE_DIRECTORY`, `STATE_DIRECTORY`.
- **Obsolete since 2026-10, ignored without a word in the log:** `PROWLARR_URL`,
  `PROWLARR_API_KEY`, `PROWLARR_INDEXER_IDS`, `QBIT_CATEGORY`, `QBIT_SAVE_PATH`,
  `SCRAPER_BASE_URL`, `FLARESOLVERR_URL`, `ARIA2_RPC_SECRET`, `ARIA2_RPC_URL`,
  `ARIA2_DOWNLOAD_DIR`. `PROWLARR_URL`/`PROWLARR_API_KEY` stay meaningful to the
  canary's `prowlarr` check, so keep the key in the env file the canary reads.

## Tests

```sh
uv run --frozen --group dev python tests/fetch_fixtures.py   # once per clone (network)
uv run --frozen --group dev pytest                           # offline from then on
```

Third-party test fixtures are fetched into git-ignored places, never committed:
the Sonarr/Radarr OpenAPI specs and qBittorrent API pages (`tests/.spec-cache/`;
the `spec` tests skip without them), Jellyfin 12.1's OpenAPI and the subset of it
the JellyfinSim is checked against (`tests/specs/jellyfin-12.1-subset.json`,
derived deterministically from the pinned spec) and recorded IMDb GraphQL answers
(`tests/recorded/imdb/`). Without the last two the tests that use them **fail**
with the command above. `--refresh` re-downloads and re-records. Details in
`tests/README.md`.

## Deploy on NixOS (the NAS)

This directory is a flake exposing `packages.default` (built with
`python3.withPackages`, closure = fastapi/uvicorn/httpx only) and
`nixosModules.default`. In the NAS flake:

```nix
# flake inputs:
# path: to backend/ itself — ?dir=backend would copy the whole repo (node_modules too)
inputs.reel-api.url = "path:/path/to/vibe-reel/backend";

# in the NAS host modules:
imports = [ inputs.reel-api.nixosModules.default ];
services.reel-api = {
  enable = true;
  openFirewall = true;          # reachable from LAN devices (the TV)
  listenAddresses = [ "127.0.0.1" "192.168.1.10" ];  # loopback + the LAN address, not 0.0.0.0
  allowedHosts = [ "nas" "nas.local" ];              # names clients use (default: hostName, hostName.local)
  environmentFile = "/var/lib/nixos-secrets/reel-api.env";  # SONARR_API_KEY=..., RADARR_API_KEY=...
  # qBittorrent 5.2+'s WebUI API key (one line, root-only file; a LoadCredential=,
  # wins over QBIT_USERNAME/QBIT_PASSWORD in environmentFile). The file must
  # exist before the rebuild: a missing one fails the unit (243/CREDENTIALS).
  # qbittorrentApiKeyFile = "/var/lib/nixos-secrets/reel-api-qbittorrent-api-key";
  # movieQuota = 10; seriesQuota = 10;  # per normal user (defaults); admins: no limit
};
```

The module also enables `services.flaresolverr` (loopback only; `enableFlaresolverr =
false` turns it off). reel-api itself never calls it: it is there for Prowlarr indexers
behind a Cloudflare challenge (e.g. a public tracker such as 1337x), which Sonarr and
Radarr search through; for those, point a FlareSolverr indexer proxy in Prowlarr at
`http://127.0.0.1:8191/` and tag the indexers with it (see the note at the bottom of
`nix/module.nix`). It could move to the host's arr configuration later.

The options of the removed search/download API — `prowlarrUrl`, `prowlarrIndexerIds`
and `qbittorrentCategory` — are gone; a host that still sets one fails evaluation with a
message saying so (`mkRemovedOptionModule`). `PROWLARR_API_KEY` in `environmentFile` is
ignored by reel-api (the canary's `prowlarr` check reads it).

Upgrading from the old name (`leetx-api`): rename the flake input, `services.leetx-api`
and the environment file; on the first start a one-shot `reel-api-migrate` unit moves
`/var/lib/private/leetx-api` and `/var/cache/private/leetx-api` to the new names.

## Canary (read-only health checks)

`reel-api-canary` (`src/reel_api/canary.py`, shipped in the same package) probes the
stack around reel-api for the breakages that went unnoticed for a day or more, because
nothing reports them on its own. Each check is independent, has a deadline
(`CANARY_TIMEOUT`, 30 s; `CANARY_SLOW_TIMEOUT`, 120 s, for reel-api and yt-dlp) and
ends `ok` / `warn` / `fail` with a one-line reason:

| check | asks | caught |
|---|---|---|
| `reel-api` | `/api/trending?type=movie`, `?type=tv`, `/api/charts` non-empty, signed with `REEL_API_TOKEN` (401/403 from the request guard name the token / the host) | IMDb answering 403 without `x-imdb-client-name`: empty rails |
| `jellyfin` | `/System/Info/Public` → version | Jellyfin down |
| `intro-skipper` | `/Plugins`: Intro Skipper `Active`, built for the server's major | the 10.x build `NotSupported` after 12.1: Skip Intro gone |
| `segments` | `/MediaSegments/{item}` non-empty (warn: no `Intro`) | the same outage, from the data side |
| `trickplay` | sheet 0 of `{item}` with `ApiKey=` → 200 image | 12.1 refusing `api_key=`: no scrubber previews |
| `prowlarr` | `/api/v1/indexerstatus` has no disabled indexer, ≥ `CANARY_MIN_INDEXERS` enabled | 1337x Cloudflare-banned and silently disabled |
| `sonarr` / `radarr` | `/api/v3/system/status`; `/api/v3/health` errors fail, warnings warn | an *arr down or unhealthy |
| `qbittorrent` | `/api/v2/app/version`; `/api/v2/transfer/info` `disconnected` fails, `firewalled` warns | qBittorrent / its VPN namespace down |
| `yt-dlp` | `yt-dlp -j --skip-download` with `trailers.py`'s flags + format selector | YouTube breaking yt-dlp: trailers fall back to the YouTube app |

**Read-only by construction.** Every request goes through `ReadOnlyHttp`, whose request
hook refuses any method but GET before it is sent (`tests/test_canary.py` proves it,
also for a whole run). The one exception: when `QBIT_USERNAME` is set and no API key
is, it POSTs qBittorrent's `/api/v2/auth/login` — exactly that URL, nothing else;
it only creates a session cookie (either login answer counts: 5.2's `204` or 4.x's
`200 "Ok."`). With `QBIT_API_KEY` (qBittorrent 5.2+'s WebUI API key, a Bearer header)
or a WebUI that skips auth for the host, nothing is POSTed at all. The key comes from
`QBIT_API_KEY_FILE` or `QBIT_API_KEY` under reel-api's own rules (the same code): the
file wins, and a file that is missing, empty or unusable fails the `qbittorrent` check
naming the file — no fall-back to `QBIT_API_KEY` or a login, nothing sent, the key never
shown.

**Output:** a summary on stdout, a JSON status file (`CANARY_STATUS_FILE`, default
`$STATE_DIRECTORY/canary.json`; `{version, started, finished, status, counts,
checks: [{name, status, reason, seconds}]}`, written atomically), and the exit code:
**0** nothing failed (warnings allowed), **1** a check failed, **2** configuration
error. Secrets never appear in reasons (key values and `ApiKey=`/`token=` queries are
masked).

**Configuration** is the environment, with reel-api's names where they exist:
`PROWLARR_URL`/`_API_KEY`, `SONARR_URL`/`_API_KEY`, `RADARR_URL`/`_API_KEY`, `QBIT_URL`,
`QBIT_USERNAME`/`QBIT_PASSWORD`, `JELLYFIN_URL`. New: `REEL_API_URL` (default
`http://127.0.0.1:$PORT`; its host must pass the request guard — an IP literal,
`localhost` or a name in `REEL_API_ALLOWED_HOSTS`), `REEL_API_TOKEN` (a Jellyfin *user*
access token, sent as `Authorization: MediaBrowser Token="…"` on every request — the
guard wants a signed-in user; required by the `reel-api` check; a sign-out in Jellyfin
revokes it, and the check then fails naming the token), `JELLYFIN_API_KEY` (Dashboard → API
Keys), `QBIT_API_KEY_FILE` / `QBIT_API_KEY`, `CANARY_CHECKS` (comma list, default all),
`CANARY_SEGMENTS_ITEM_ID` (an episode with an intro), `CANARY_TRICKPLAY_ITEM_ID`
(default: the segments item), `CANARY_TRICKPLAY_WIDTH` (320), `CANARY_YOUTUBE_ID`
(default `aqz-KE-bpKQ`), `CANARY_MIN_INDEXERS` (1). A selected check whose key or id
is missing is a config error, not a skip. By hand: `reel-api-canary --checks
prowlarr,yt-dlp`.

**On the NAS** — `nixosModules.canary` (`nix/canary.nix`) runs it as a hardened oneshot
(DynamicUser, `ProtectSystem=strict`, writable only `/var/lib/reel-api-canary`) on a
timer. URLs come from `services.reel-api` (Prowlarr's from the canary's own
`prowlarrUrl`, default `http://127.0.0.1:9696`), the yt-dlp is the one on reel-api's
PATH, `qbittorrentApiKeyFile` is handed over as the same `LoadCredential=` +
`QBIT_API_KEY_FILE` (a missing file fails the canary unit with `243/CREDENTIALS`,
which fires `onFailure`), and a missing item id fails the build. Next to the reel-api
import:

```nix
imports = [
  inputs.reel-api.nixosModules.default
  inputs.reel-api.nixosModules.canary
];

services.reel-api.canary = {
  enable = true;
  # interval = "00/6:00";        # OnCalendar (default every 6 h, RandomizedDelaySec 30m)
  segmentsItemId = "<jellyfin id of an episode with an intro>";
  # trickplayItemId = "...";     # default: segmentsItemId
  # minIndexers = 1;
  # checks.trickplay = false;    # any check can be turned off
  environmentFile = [
    "${config.nas.secretsDir}/reel-api.env"         # SONARR/RADARR keys (+ PROWLARR_API_KEY for the check)
    "${config.nas.secretsDir}/reel-api-canary.env"  # JELLYFIN_API_KEY=, REEL_API_TOKEN=, QBIT_API_KEY=
  ];
  onFailure = [ "notify-ntfy@%n.service" ];         # see "Alerts" below
};
```

`reel-api-canary.env` is provisioned like the other secrets (`install -m600`). The item
id is the `id=` in Jellyfin's web URL of the episode. Check a run with `systemctl start
reel-api-canary; journalctl -u reel-api-canary -n 20`, or read
`/var/lib/reel-api-canary/canary.json`.

**Alerts** are left to the host: `onFailure` lists units for `OnFailure=` (any failed
check, or a config error, fails the unit; warnings don't). Options:

- **ntfy** (phone push, simplest) — a template unit that posts the last lines of the
  failed unit's journal (use a private topic or your own ntfy server: the reasons name
  your services):

  ```nix
  systemd.services."notify-ntfy@" = {
    serviceConfig.Type = "oneshot";
    scriptArgs = "%i";
    script = ''
      ${pkgs.systemd}/bin/journalctl -u "$1" -n 15 -o cat \
        | ${pkgs.curl}/bin/curl -fsS -H "Title: $1 failed" -T - https://ntfy.sh/<private-topic>
    '';
  };
  ```

- **email** — the same template shape piping into `sendmail` (needs an MTA, e.g.
  `programs.msmtp`).
- **reel-api web push** to the iPhone app — would reuse `push.py`'s VAPID setup, but
  needs a new loopback-only endpoint in reel-api; not built.

Without `onFailure` a failure still shows in `systemctl --failed` and the status file.

## Contract

### `/api/downloads/{id}/stream`, `/probe`, `/hls` — watch while downloading

`{id}` is a grab's info-hash — the `download_id` of an `/api/activity` item (40 hex
digits, either case; anything else is `404 not_found` before qBittorrent is asked).
Any torrent qBittorrent has works, whatever its category.

- `GET|HEAD /api/downloads/{id}/stream` — the torrent's main video file, with `Range`
  support, while it downloads: a range at the download frontier waits for its pieces
  instead of failing, and the body ends after ~2 min without progress. A parked torrent
  is force-started. Never gzipped. The `<video>` element sends the token as `?api_key=`.
- `GET /api/downloads/{id}/probe` — ffprobe of the partial file once its header is on
  disk (`409 not_ready` with `Retry-After: 10` before that): container, video (codec,
  resolution, HDR / Dolby Vision), audio and subtitle tracks.
- `POST|GET /api/downloads/{id}/hls?audio=N` and `GET …/hls/{audio}/{file}` — the
  iPhone's variant: the growing file remuxed into an HLS event playlist of fMP4
  segments (`src/reel_api/livehls.py`).

`404 not_found` for a hash qBittorrent doesn't know, `409 not_ready` while the
torrent's metadata or first bytes are missing, `503` without `QBIT_URL` or while
qBittorrent is unreachable. Source: `src/reel_api/streaming.py`.

### `GET /api/lookup` / `POST /api/library` — add a title to the library

How titles get into the library: reel-api hands a *title* to Sonarr (TV) / Radarr
(movies), which then search indexers, download, and import+rename into the library
themselves.

`GET /api/lookup?q=example&type=tv|movie` → title matches from TheTVDB/TMDB:
```json
{ "query": "example", "type": "tv", "results": [ {
  "id": "123456", "type": "tv", "title": "Example Show", "year": 2023,
  "overview": "...", "poster": "https://...", "added": false } ] }
```
`id` is the TVDB/TMDB id (opaque — pass it back). `added` = already in the library.
Answers are cached 90 s (256 queries, LRU) keyed by the case/whitespace-normalised
query and type; concurrent identical lookups share one upstream call, and a
successful (or `409 already_added`) `POST /api/library` marks the title `added` in every cached
answer at once.

`POST /api/library` body `{ "id": "123456", "type": "tv" }` (`id`: the lookup's
tvdb/tmdb id, canonical — `^[1-9][0-9]{0,9}$`, else 422; the arrs would read `"0603"` as
603) → `202` `{ id, type,
title, status: "added", undo }`; adds monitored + auto-search, and records the caller
as the title's owner (see Ownership and quotas). `undo` is a token for
`DELETE /api/library/{type}/{id}` (below). `409 already_added` if
present (nothing recorded), `409 quota_exceeded` for a normal user at the limit
(`{error, detail, type, used, limit}` — nothing is sent to the arr), `409
being_deleted` while a delete with files of that title is still running, `404
not_found` if the lookup doesn't know the id; `503` only for a Sonarr/Radarr outage. Requires `SONARR_API_KEY` / `RADARR_API_KEY` (a type without its key is
omitted; calling it returns `503 not_available`). `SONARR_URL`/`RADARR_URL`
default to loopback; `SONARR_QUALITY_PROFILE`/`RADARR_QUALITY_PROFILE` default
`HD-1080p`.

### Errors

Error responses never mention the upstream site or fetch mechanics — the API
presents failures as its own. Real causes are written to the server log.

| Status | body.error | Meaning |
|---|---|---|
| 400 | `bad_id` | malformed YouTube id (`/api/trailers/…`) |
| 400 | `bad_request` | `DELETE /api/library/…` without exactly one of `undo` / `delete_files=true` (and other malformed requests) |
| 401 | `unauthorized` | no Jellyfin token, or Jellyfin rejected it |
| 403 | `bad_host` / `bad_origin` | Host or browser Origin is not this server |
| 403 | `not_owner` | delete, cancel, undo or season-undo of something that isn't yours (admins: never) |
| 409 | `quota_exceeded` | `POST /api/library` over a normal user's quota; the body adds `type`, `used`, `limit` |
| 409 | `being_deleted` | `POST /api/library` while that title's delete with files is still running |
| 409 | `importing` | a delete / cancel / undo while a grab of it is being imported |
| 404 | `not_found` | no such download, title, collection, trailer job |
| 422 | — | invalid enum/query param (FastAPI validation) |
| 500 | `internal_error` | something broke server-side — retrying won't help, check the log |
| 503 | `temporarily_unavailable` | transient — back off and retry (`Retry-After` set) |

## Layout

- `src/reel_api/app.py` — routes; upstream clients built at startup (not import);
  the lookup cache, the activity feed (arr queues + live qBittorrent rows)
- `src/reel_api/models.py` — the contract schemas (pydantic)
- `src/reel_api/arr.py` — Sonarr/Radarr: lookup, add, metadata, queue, news
- `src/reel_api/qbittorrent.py` — qBittorrent WebUI v2 client (login / API key);
  id = info-hash; reads torrents, files, pieces; force-start, sequential toggles,
  delete with data
- `src/reel_api/streaming.py` / `livehls.py` — watch while downloading (Range stream,
  probe; the phone's HLS remux)
- `src/reel_api/trending.py`, `charts.py`, `collections.py`, `introdb.py`,
  `trailers.py`, `push.py` — the other routes' sources
- `src/reel_api/ownership.py` — who added which title (`owners.json`), the
  quota and the per-user rights; `statefile.py` — the state directory and atomic
  JSON writes (`push.json`, `owners.json`)
- `src/reel_api/undo.py` — undo / cancel / delete with files
- `package.nix` / `flake.nix` / `nix/module.nix` — Nix build + NixOS service module
- `src/reel_api/canary.py` / `nix/canary.nix` — `reel-api-canary`, the read-only health
  checks of the stack, and its NixOS timer (see "Canary")

### `GET /api/news` / `POST /api/news/search` — new seasons (Sonarr)

New seasons of shows already in Sonarr that have no file yet. `kind` is `aired` (an
episode is out, the latest within a year) or `upcoming` (on TheTVDB, nothing aired;
`premiere` null = no date yet). Aired first (newest first), then upcoming (soonest first).
Cached 10 min.

```json
{"items": [{"id": "123456:4:upcoming", "kind": "upcoming", "media_id": "123456",
  "title": "Example Show", "year": 2023, "poster": "https://…", "fanart": "https://…",
  "season": 4, "premiere": "2027-07-09T04:00:00Z", "last_aired": null,
  "episodes_aired": 0, "episodes_total": 1, "monitored": true}]}
```

`POST /api/news/search` `{"id": "<tvdb>", "season": 4}` → 202 `{id, season, title,
status: "searching"}`: monitors the series, the season and its aired episodes, then starts
a Sonarr SeasonSearch. 404 for an unknown series/season, 409 `not_aired` when no episode
of the season has aired (a search would only find fakes).

`DELETE /api/news/search/{undo}` (the token from that 202) undoes one search: the
series/season/episode monitoring flags it flipped go back, and the grabs of that season
made since the search are removed (see below). 200 `{id, season, title, status:
"reverted", downloads_removed, kept}`. Anyone may Get a season; the requester is recorded
(see Ownership and quotas), and only they or an admin may undo it (else 403
`not_owner`).

### Undo, cancel and delete (`undo.py`)

- `DELETE /api/library/{type}/{id}?undo=TOKEN` — undo one add. A repeated call gets the
  same answer and changes nothing; the owner record goes only if it is that add's (same
  owner and arr entry), so an old token replayed after the title was added again drops
  no one's record. 200 `{id, type, title,
  status, downloads_removed}` with status `removed`, `removing` (the arr's search for it is
  still running; it is unmonitored now and deleted as soon as the search ends) or
  `already_removed`. A re-add while it is `removing` keeps the title instead. Only the
  user who added it (whose token it is) or an admin: else 403 `not_owner`.
- `DELETE /api/library/{type}/{id}?delete_files=true` — **delete the title from
  Sonarr/Radarr with its files** (the apps' My library → Delete). Its owner or an admin
  only (a legacy title: admins only) — else 403 `not_owner`. Its grabs go first, like an
  undo: queue rows with their torrents and partial data, grabs of the last 5 min that left
  the queue, the title unmonitored, its queued commands cancelled; then the arr deletes it
  with `deleteFiles=true` and no import-list exclusion (it can be added again). 200 `{id,
  type, title, status, downloads_removed}` with status `deleted`, `deleting` (a search of it
  is running: a watcher removes late grabs and deletes it when the search ends; the owner's
  quota slot is free at once, a repeated call answers the same, a re-add meanwhile is 409
  `being_deleted`; if the watcher fails, the owner gets the record back) or
  `already_removed` (not in the arr any more — for a normal user also when the arr entry on
  record is gone and the media id now names an entry added outside reel-api, which is the
  admins'). 409 `importing` while a
  grab of it is being imported (nothing touched). Exactly one of `undo` /
  `delete_files=true` per request, else 400 `bad_request` — a client that lost its undo
  token can never fall through to a delete.
- `DELETE /api/activity/{type}/{id}[?season=&episode=&blocklist=false]` — cancel the
  title's (or one season's / episode's) grabs: removed from the arr queue and qBittorrent
  with their partial data, and what they were for unmonitored (so RSS sync doesn't grab it
  again). A torrent goes as a whole — one episode of a season pack cancels the pack. 200
  `{id, type, status: "cancelled", downloads_removed, episodes[], unmonitored, kept}`,
  404 `not_in_queue`, 409 `importing` (everything matching is importing), then 403
  `not_owner` unless every grab that would go is the caller's (their title, or a season
  they asked for) — a pack that also covers a season that isn't theirs is refused whole.
  Admins may cancel anything.

Safety rules: no library file is deleted except by `?delete_files=true`, which needs the
owner or an admin (undo and its watcher leave the arr with `deleteFiles=false`,
hard-wired in `ArrClient.delete_title`; `delete_title_and_files` is the one call that sends
`true`, and no DELETE ever sets an import-list exclusion); an undo needs the token of that
exact action (in memory, ~10 min, 410 `undo_expired` after that or a restart), and the
arr's `added` stamp must match; 409 `has_files` / `importing` / `not_ours` refuse an undo
once anything of the title is (becoming) a library file; a grab that is importing is never
cancelled (`kept`) — that includes a finished one waiting for its import (`importPending`,
`importBlocked`), which `/api/activity` shows as `importing` too; only grabs of that title/season (arr queue + grab history since the
action) are removed, never a torrent in the old manual `reel` category (left from the
removed `POST /api/downloads`). A search that is
already running can still grab a moment after an undo — the arrs can't stop a started
command, and their history API hides grabs of a deleted title — so every undo (and a
`deleting` delete) leaves a watcher that follows the title's grab history until its
commands have finished and removes what lands. Every action is logged (`[actions]` lines
in the journal, with the user's name).

### Ownership and quotas (`ownership.py`)

Every title added through `POST /api/library` is recorded with the user who added it —
its **owner** — in `$STATE_DIRECTORY/owners.json` (on the NAS
`/var/lib/private/reel-api/owners.json`, mode 0600, beside `push.json`):

```json
{"version": 1,
 "titles":  {"movie:603": {"arr_id": 12, "title": "The Matrix", "year": 1999,
                           "owner": "<jellyfin user id>", "owner_name": "nicole",
                           "at": "2026-10-05T12:00:00Z"}},
 "seasons": {"tv:81189:3": {"owner": "<jellyfin user id>", "owner_name": "nicole",
                            "at": "2026-10-05T12:03:10Z"}}}
```

- **Admins** (Jellyfin `Policy.IsAdministrator`) may do everything and have no quota.
- **Normal users** may add titles (quota below), delete their own titles with their files,
  cancel grabs of their own titles, and undo their own adds and season Gets.
- **Legacy titles** — no record: added before ownership existed, or straight in
  Sonarr/Radarr — are the admins': any admin may act on them, no normal user may, and
  they count against nobody's quota. There is no migration.
- **Season requests**: `POST /api/news/search` (allowed for everyone — it is no new
  title and counts against nothing) records the requester of that season: the *first*
  one holds it, for 30 days (a later Get gets its own undo token, not the record). It lets
  them cancel that season's grabs **queued since they asked** — never a grab that was in
  flight before (the request time is stored rounded up to the second); nothing else.
  Undoing a Get drops the record only if that Get wrote it.
- **Quota**: a normal user may own at most `REEL_API_QUOTA_MOVIES` movies and
  `REEL_API_QUOTA_SERIES` series (NixOS `movieQuota` / `seriesQuota`; default 10 each;
  `0` turns adding that type off for them; an invalid value is the default + a warning)
  *that still exist* in Radarr/Sonarr, downloading or downloaded. A series counts once,
  whatever its seasons. Deleting (or undoing) a title frees its slot at once. Existence
  comes from a library listing cached 30 s; a record written after the listing was
  requested counts as existing (a cached listing never under-counts), and a record missing
  from a listing requested after it was written no longer counts — so a title deleted in
  Radarr's/Sonarr's own UI frees its slot within 30 s. The record itself is dropped only
  when two listings ≥ 30 s apart both lack it, and never because of an empty listing (an
  arr that answers `[]` once must not wipe everyone's records; that is logged). Two concurrent adds of one user and
  type are serialised (a per-user, per-type lock around check + add + record), so at 9/10
  exactly one passes. This relies on reel-api running **one uvicorn worker** (server.py):
  every change to the store is synchronous and saved at once (atomic rename); a failed save
  is logged and kept in memory (after a restart that title would be legacy).
- A corrupt or unknown-version `owners.json` is moved aside to
  `owners.json.bad-<UTC time>` and the service starts with an empty store (every title
  legacy) — restore it by hand if needed.

`GET /api/me` — the caller, their quota use and the titles they own (both apps' "My
library"; a 404 from an older backend means "no ownership here"):

```json
{"user": {"id": "<jellyfin user id>", "name": "nicole"}, "admin": false,
 "quota": {"movie": {"used": 3, "limit": 10}, "tv": {"used": 10, "limit": 10}},
 "titles": [{"type": "movie", "id": "603", "title": "The Matrix", "year": 1999,
             "poster": "https://…", "added_at": "2026-10-05T12:00:00Z",
             "status": "downloading", "progress": 0.43, "has_files": false}]}
```

`limit` is `null` for an admin. `titles` are the caller's own existing records (an admin's
own too; legacy titles are listed for nobody). `status`: `downloading` / `importing` /
`queued` / `warning` / `paused` (its most active grab in flight; `progress` 0..1 weighted
by size over distinct downloads) — else `in_library` (the arr counts files) or `waiting`
(nothing grabbed yet); `has_files` says whether anything is on disk (a series can be
downloading season 2 with season 1 in the library). In-flight first, then waiting, then in
the library; newest first within each.

`GET /api/activity` items carry `mine` (the caller's title, or a grab of a season they
asked for, queued since they asked)
and `can_cancel` (admin or mine) — what the apps' Cancel affordances obey.

### `GET /api/charts` / `GET /api/charts/{key}` — browse categories (IMDb)

`GET /api/charts` → `{ categories: [{ key, title, types, count, posters[] }] }`:
`top-movie`, `top-tv` (IMDb's Top 250 charts) and `genre-<Genre>` (the 20
best-rated movies and 20 best-rated shows of a genre, vote floor 25k / 50k).
`posters` are IMDb thumbnails for the category card.

`GET /api/charts/{key}` → `{ key, title, sections: [{ type, title, results[] }] }`,
results being `/api/lookup` results plus `imdb_id`, `rating`, `rating_votes`,
`rank`, in chart order. IMDb lists are cached 24 h, IMDb→tvdb/tmdb resolutions
7 days; `added` is re-derived from the arr library each request. Unknown key →
404 `no_such_chart`; IMDb down with nothing cached → 503. IMDb ids that resolve
to the same tvdb/tmdb title appear once, at the first (best) rank; the same holds
for `/api/trending`. Source:
`src/reel_api/charts.py` (warms the index and both Top 250s at startup).

### `GET /api/collection/{tmdb_collection_id}` — a movie franchise

`{ id, title, overview, poster, fanart, movies[] }`, the films in release order,
each an `/api/lookup` result (id = tmdb id, `added` from Radarr) plus `rating`
and `released`. Source: Radarr's metadata service
(`api.radarr.video/v1/movie/collection/{id}`, no key), cached 24 h; unknown id →
404. `/api/metadata/movie/{id}` now also carries `trailer` (YouTube id),
`collection` (`{ id, title }` or null) and `digital_release` (Radarr's digital
release day, `YYYY-MM-DD`, or null; always null for tv), which phone LookupDetail
shows for a title not out to download yet. `src/reel_api/collections.py`.

### `POST|GET /api/trailers/{youtube_id}` — trailers as HLS for VibeReel's player

`POST` starts (idempotently) fetching a YouTube video with yt-dlp — the best
video ≤ 2160p (AV1/VP9/H.264, HDR where offered) + the original-language audio,
remuxed without re-encoding by ffmpeg into an HLS event playlist of fMP4
segments while it downloads; `GET` polls `{ id, state: resolving|downloading|
ready|error, segments, buffered_s, duration, complete, width, height, vcodec,
title, codecs, hdr, subs, subs_done, error }` (`codecs`: the RFC 6381 string for MSE;
`subs`: the English subtitles, `{ lang, kind: manual|auto|translated }` or null, served
as `subs.vtt` next to the segments; `subs_done`: true once the subtitle fetch has
finished or given up — a client that wants them from the first frame waits for it).
Files: `GET /api/trailers/{id}/index.m3u8|init.mp4|sNNN.m4s|subs.vtt`.
First segments ~3 s after the POST, a whole trailer ~1-2 s later; finished ones
stay in `$CACHE_DIRECTORY/trailers` (LRU by last start or file read, 12 GB — a 4K trailer is ~150 MB). Needs `yt-dlp` and `ffmpeg` on
PATH (the NixOS module provides both; yt-dlp ages quickly against YouTube — a
failing trailer usually wants a nixpkgs bump). `src/reel_api/trailers.py`.

### `GET /api/segments/{series_imdb_id}/{season}/{episode}` — community skip windows

`{ intro, recap, outro }`, each `{ start, end, submissions }` (seconds) or null,
from [IntroDB](https://introdb.app) (crowdsourced, no key to read). Never fails:
an unreachable IntroDB reads as all-null. Cached 7 days (data) / 12 h (nothing
submitted). VibeReel takes recaps only from here — see `src/reel_api/introdb.py`.
