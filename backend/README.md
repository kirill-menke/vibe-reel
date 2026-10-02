# reel-api

VibeReel's backend: a personal LAN service in front of Sonarr, Radarr, Prowlarr and
qBittorrent. VibeReel uses it for lookup/add, the download activity feed,
watch-while-downloading streams, metadata, trending, charts, trailers, new-season news
and push notifications. It began as a small three-stage JSON API — **search → resolve
magnet → download**, with an opaque `id` per result carried between the steps — which
is still served.

**LAN use only. Do not expose this publicly.**

## Backends (the seam)

The contract is fixed; the two backends behind it are swappable by env var.

| Stage | Primary backend | Fallback |
|---|---|---|
| search + magnet | **Prowlarr** (`PROWLARR_API_KEY` set) | direct site scraper (`SCRAPER_BASE_URL` set) |
| download | **qBittorrent** (`QBIT_URL` set) | aria2c RPC (`ARIA2_RPC_SECRET`) |

Normally it runs as the Prowlarr + qBittorrent façade: search goes to whatever
indexers you have configured in Prowlarr (which solves Cloudflare challenges via
FlareSolverr where an indexer needs it), and qBittorrent lands files where
Sonarr/Radarr import from. The service itself knows no indexer. The fallbacks are
for standalone/dev use where neither exists: aria2 for downloads, and for search a
direct scraper written against the URL scheme and markup of one 1337x-style site,
used only without Prowlarr and only when `SCRAPER_BASE_URL` names the site (there is
no default).

`src/reel_api/*` is structured so a Prowlarr deployment never imports the
scraper's `curl_cffi`/`beautifulsoup4` (they are optional deps, imported lazily).

## Run (dev, against Prowlarr + qBittorrent)

```sh
PROWLARR_URL=http://127.0.0.1:9696 PROWLARR_API_KEY=<key> \
QBIT_URL=http://127.0.0.1:8080 QBIT_CATEGORY=reel \
  uv run uvicorn reel_api.app:app --port 8790
```

Config env vars:

- `PROWLARR_URL` / `PROWLARR_API_KEY` — Prowlarr search backend; **key unset =
  fall back to the scraper if configured, else `/api/search` answers 503.**
  `PROWLARR_INDEXER_IDS` (comma list) restricts search.
- `QBIT_URL` — qBittorrent WebUI base; **unset = fall back to aria2, else the
  /api/downloads endpoints return 503.** `QBIT_CATEGORY` (default `reel`) keeps
  manual grabs apart from Sonarr/Radarr; `QBIT_SAVE_PATH`, `QBIT_USERNAME`,
  `QBIT_PASSWORD` optional (loopback needs no auth).
- Scraper fallback: `SCRAPER_BASE_URL` (the site, required), `FLARESOLVERR_URL`. aria2 fallback:
  `ARIA2_RPC_SECRET`, `ARIA2_RPC_URL`, `ARIA2_DOWNLOAD_DIR`.
- `SONARR_URL` / `SONARR_API_KEY`, `RADARR_URL` / `RADARR_API_KEY` — lookup, add,
  activity, metadata (`*_QUALITY_PROFILE`, default `HD-1080p`). A type without its key
  answers 503.
- `JELLYFIN_URL` (default `http://127.0.0.1:8096`) — push waits until a title is in
  Jellyfin before announcing it.
- `VAPID_PRIVATE_KEY` — enables Web Push (unset = push disabled); `VAPID_SUBJECT` — a
  `mailto:` or `https:` URL identifying you to the push services (Apple rejects
  placeholders).
- `HOST` / `PORT` (default `127.0.0.1:8790`), `CACHE_DIRECTORY`, `STATE_DIRECTORY`.

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
  environmentFile = "/var/lib/nixos-secrets/reel-api.env";  # PROWLARR_API_KEY=...
};
```

The module also enables `services.flaresolverr` (loopback only; `enableFlaresolverr =
false` turns it off). It is only needed for Prowlarr indexers behind a Cloudflare
challenge (e.g. a public tracker such as 1337x); for those, point a FlareSolverr indexer
proxy in Prowlarr at `http://127.0.0.1:8191/` and tag the indexers with it (see the note
at the bottom of `nix/module.nix`).

Upgrading from the old name (`leetx-api`): rename the flake input, `services.leetx-api`
and the environment file; on the first start a one-shot `reel-api-migrate` unit moves
`/var/lib/private/leetx-api` and `/var/cache/private/leetx-api` to the new names.

## Contract

### `GET /api/search`

`q` (required), `category` (`movies|tv|games|music|apps|documentaries|anime|other|xxx`),
`sort` (`time|size|seeders|leechers`), `order` (`asc|desc`, default desc),
`page` (default 1).

```json
{
  "query": "example show", "page": 1, "total_pages": 29,
  "results": [{
    "id": "1234567",
    "title": "Example.Show.S03E08.1080p.WEBRip...",
    "seeders": 1, "leechers": 1,
    "size_bytes": 443600000, "size": "443.6 MB",
    "uploaded_at": "2026-08-21"
  }]
}
```

No magnet here — the listing page doesn't contain them, and resolving each row
would cost N upstream fetches. `size_bytes` and `uploaded_at` are normalized
best-effort and may be `null`; `size` is the raw display string.

### `GET /api/torrents/{id}/magnet`

```json
{
  "id": "1234567",
  "magnet": "magnet:?xt=urn:btih:01234567...",
  "info_hash": "0123456789ABCDEF0123456789ABCDEF01234567"
}
```

Via Prowlarr: reads the `Location` of the release's `downloadUrl` redirect (the indexer
needs preferMagnetUrl), so an id resolves only while its search is cached (1 h; else
404, search again). Via the scraper: fetches the site's detail page and extracts
`a[href^="magnet:"]`. Cached forever once resolved — magnets never change. `info_hash`
is the stable identifier; use it to dedupe re-uploads of the same content.

### `POST /api/downloads`

Hands a magnet to the download backend (qBittorrent, in the manual category; else
aria2). Body `{"magnet": "magnet:?..."}`. Returns
`202` with the download object; its `id` is the handle you poll.

```json
{
  "id": "9f3d7e27dc11b398",
  "status": "downloading",
  "name": "debian-12.5.0-amd64-netinst.iso",
  "progress": 0.0,
  "size_bytes": null,
  "downloaded_bytes": 0,
  "download_speed": 0,
  "eta_s": null
}
```

`status` is `queued | downloading | paused | complete | error | removed`.
`name`/`size_bytes`/`eta_s` are `null` at first (a magnet fetches metadata before
the file is known) and fill in on the next poll. On `error`, an `error_detail`
field carries the reason. `progress` is 0.0–1.0; `download_speed` is bytes/sec.

Requires `QBIT_URL` (or `ARIA2_RPC_SECRET`); without either the download endpoints
return `503`.

### `GET /api/downloads/{id}` / `GET /api/downloads`

Same download object (or a list of them). Poll `{id}` for live progress. The
`id` from the POST stays valid across the internal metadata→file transition.

### `DELETE /api/downloads/{id}`

Cancels an active download or clears a finished one. Returns `204`. Does **not**
delete files already written to disk.

### `GET /api/lookup` / `POST /api/library` — add a title to the library

A higher-level path than search/magnet/download: instead of grabbing one
release, it hands a *title* to Sonarr (TV) / Radarr (movies), which then search
indexers, download, and import+rename into the library themselves.

`GET /api/lookup?q=example&type=tv|movie` → title matches from TheTVDB/TMDB:
```json
{ "query": "example", "type": "tv", "results": [ {
  "id": "123456", "type": "tv", "title": "Example Show", "year": 2023,
  "overview": "...", "poster": "https://...", "added": false } ] }
```
`id` is the TVDB/TMDB id (opaque — pass it back). `added` = already in the library.
Answers are cached 90 s (256 queries, LRU) keyed by the case/whitespace-normalised
query and type; concurrent identical lookups share one upstream call, and a
successful (or `409`) `POST /api/library` marks the title `added` in every cached
answer at once.

`POST /api/library` body `{ "id": "123456", "type": "tv" }` → `202` `{ id, type,
title, status: "added", undo }`; adds monitored + auto-search. `undo` is a token for
`DELETE /api/library/{type}/{id}` (below). `409 already_added` if
present, `404 not_found` if the lookup doesn't know the id; `503` only for a
Sonarr/Radarr outage. Requires `SONARR_API_KEY` / `RADARR_API_KEY` (a type without its key is
omitted; calling it returns `503 not_available`). `SONARR_URL`/`RADARR_URL`
default to loopback; `SONARR_QUALITY_PROFILE`/`RADARR_QUALITY_PROFILE` default
`HD-1080p`.

### Errors

Error responses never mention the upstream site or fetch mechanics — the API
presents failures as its own. Real causes are written to the server log.

| Status | body.error | Meaning |
|---|---|---|
| 400 | `bad_id` / `bad_magnet` | malformed torrent id or magnet URI |
| 404 | `not_found` | id resolves to no torrent / no such download |
| 422 | — | invalid enum/query param (FastAPI validation) |
| 500 | `internal_error` | something broke server-side — retrying won't help, check the log |
| 503 | `temporarily_unavailable` | transient — back off and retry (`Retry-After` set) |

Internally, a 200 listing page with zero parseable rows and no "No results
were returned" marker is treated as an error, not an empty result — that
signature means a markup change or a challenge page, and returning `[]`
would hide it.

## Layout

- `src/reel_api/app.py` — routes; backends built at startup (not import);
  caching (search 120 s TTL, magnets forever)
- `src/reel_api/models.py` — the contract schemas (pydantic); backend-agnostic
- `src/reel_api/errors.py` — shared exception types, no third-party imports
- `src/reel_api/prowlarr.py` — **search backend**: Prowlarr `/api/v1/search`;
  id = the numeric id in the release `guid`, else a number hashed from it; magnet resolved by reading the
  `Location` of Prowlarr's `downloadUrl` 301 (needs the indexer's preferMagnetUrl)
- `src/reel_api/qbittorrent.py` — **download backend**: WebUI v2; id = info-hash;
  status/eta from `/torrents/info`; grabs scoped to a category
- `src/reel_api/scraper.py`, `fetch.py`, `parse.py` — **fallback** search backend
  (one 1337x-style site, `SCRAPER_BASE_URL`, via `DirectFetcher`/`FlareSolverrFetcher`); optional deps
- `src/reel_api/downloads.py` — **fallback** download backend (aria2 JSON-RPC)
- `package.nix` / `flake.nix` / `nix/module.nix` — Nix build + NixOS service module

Two seams: search backends expose `search()` + `magnet()`; download backends
expose `add()`/`status()`/`list()`/`remove()`. Selection is by env var in
`app.py`. Keep new transports behind those interfaces.

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
"reverted", downloads_removed, kept}`.

### Undo and cancel (`undo.py`)

- `DELETE /api/library/{type}/{id}?undo=TOKEN` — undo one add. 200 `{id, type, title,
  status, downloads_removed}` with status `removed`, `removing` (the arr's search for it is
  still running; it is unmonitored now and deleted as soon as the search ends) or
  `already_removed`. A re-add while it is `removing` keeps the title instead.
- `DELETE /api/activity/{type}/{id}[?season=&episode=&blocklist=false]` — cancel the
  title's (or one season's / episode's) grabs: removed from the arr queue and qBittorrent
  with their partial data, and what they were for unmonitored (so RSS sync doesn't grab it
  again). A torrent goes as a whole — one episode of a season pack cancels the pack. 200
  `{id, type, status: "cancelled", downloads_removed, episodes[], unmonitored, kept}`,
  404 `not_in_queue`.

Safety rules: no library file is ever deleted (titles leave the arr with
`deleteFiles=false`, hard-wired); an undo needs the token of that exact action (in memory,
~10 min, 410 `undo_expired` after that or a restart), and the arr's `added` stamp must
match; 409 `has_files` / `importing` / `not_ours` refuse an undo once anything of the title
is (becoming) a library file; a grab that is importing is never cancelled (`kept`); only
grabs of that title/season (arr queue + grab history since the action) are removed, never a
torrent in the manual `reel` category. A search that is already running can still grab a
moment after an undo — the arrs can't stop a started command, and their history API hides
grabs of a deleted title — so every undo leaves a watcher that follows the title's grab
history until its commands have finished and removes what lands. Every action is logged
(`[actions]` lines in the journal).

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
404. `/api/metadata/movie/{id}` now also carries `trailer` (YouTube id) and
`collection` (`{ id, title }` or null). `src/reel_api/collections.py`.

### `POST|GET /api/trailers/{youtube_id}` — trailers as HLS for VibeReel's player

`POST` starts (idempotently) fetching a YouTube video with yt-dlp — the best
video ≤ 2160p (AV1/VP9/H.264, HDR where offered) + the original-language audio,
remuxed without re-encoding by ffmpeg into an HLS event playlist of fMP4
segments while it downloads; `GET` polls `{ id, state: resolving|downloading|
ready|error, segments, buffered_s, duration, complete, width, height, vcodec,
title, codecs, hdr, error }` (`codecs`: the RFC 6381 string for MSE). Files: `GET /api/trailers/{id}/index.m3u8|init.mp4|sNNN.m4s`.
First segments ~3 s after the POST, a whole trailer ~1-2 s later; finished ones
stay in `$CACHE_DIRECTORY/trailers` (LRU, 12 GB — a 4K trailer is ~150 MB). Needs `yt-dlp` and `ffmpeg` on
PATH (the NixOS module provides both; yt-dlp ages quickly against YouTube — a
failing trailer usually wants a nixpkgs bump). `src/reel_api/trailers.py`.

### `GET /api/segments/{series_imdb_id}/{season}/{episode}` — community skip windows

`{ intro, recap, outro }`, each `{ start, end, submissions }` (seconds) or null,
from [IntroDB](https://introdb.app) (crowdsourced, no key to read). Never fails:
an unreachable IntroDB reads as all-null. Cached 7 days (data) / 12 h (nothing
submitted). VibeReel takes recaps only from here — see `src/reel_api/introdb.py`.
