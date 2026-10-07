/* reel-api (backend/, FastAPI on the NAS, :8790) payloads the clients read.
 * Global namespace `Reel`. The backend's own README.md is the contract; mirror it
 * here, field names exactly as the JSON (snake_case).
 *
 * Mirrors backend/src/reel_api/models.py (pydantic response models) and the routes in
 * app.py / streaming.py; each interface names the model or function it mirrors. No index
 * signatures: a field the backend adds must be added here (T28 checks the drift).
 * T03: activity, probe, cancel/undo. T04: metadata, lookup, charts, trending, news, … */

declare namespace Reel {
  type MediaType = 'movie' | 'tv';

  /** The body of every reel-api error answer (models.py `ApiError`; FastAPI routes return it
   * via JSONResponse). `error` is a machine code: 'not_ready' (409, + Retry-After), 'not_found',
   * 'bad_request', 'temporarily_unavailable' (503), 'not_aired' (news search), 'not_owner'
   * (403: delete/cancel/undo of something that isn't the caller's), 'being_deleted' (409,
   * POST /api/library while that title's delete runs), … `detail` is a sentence for the user. */
  interface ApiError {
    error: string;
    detail: string;
  }

  /** The 409 of `POST /api/library` over a normal user's quota — models.py `QuotaError`
   * (error 'quota_exceeded'). */
  interface QuotaError {
    error: string;
    detail: string;
    type: MediaType;
    used: number;
    limit: number;
  }

  /** ActivityItem.status — `_shape_queue()` (arr.py) maps the arr's trackedDownloadState,
   * then `activity()` (app.py) overrides it from qBittorrent's live state. 'completed' =
   * imported (the client drops it: it belongs to Jellyfin now). */
  type ActivityStatus = 'queued' | 'downloading' | 'importing' | 'completed' | 'paused' | 'warning';

  /** One entry of `GET /api/activity` — models.py `ActivityItem`, built by `ArrClient._shape_queue()`
   * (arr.py) and live-patched by `activity()` (app.py). Pydantic serialises every field, so on a
   * current backend the optional ones are present (null when unknown); they are `?` because an
   * OLDER backend sent only the first block and activity.svelte.js falls back to parsing
   * `subtitle` (CLAUDE.md "extended activity payload"). */
  interface ActivityItem {
    /** The arr's queue row id (a string). */
    id: string;
    type: MediaType;
    title: string;
    /** tv: 'S02E05 · Episode title' (or ''), movie: the year as a string (or ''). */
    subtitle: string;
    status: ActivityStatus;
    /** 0.0 – 1.0 (4 decimals). */
    progress: number;
    size_bytes: number | null;
    /** 'H:MM:SS' / 'M:SS' from qBittorrent's eta, or Sonarr's own ('1.02:03:04' with days). */
    timeleft: string | null;
    /** Release quality name: 'WEBDL-2160p', 'Bluray-1080p', … */
    quality: string | null;
    /** bytes/s, live from qBittorrent (0 when stalled/queued). */
    download_speed: number;

    /** The arr's reason when a row needs attention (≤ 160 chars), else null. */
    message?: string | null;
    /** tvdbId (tv) / tmdbId (movie) — the same opaque id /api/lookup hands out. */
    media_id?: string | null;
    season?: number | null;
    episode?: number | null;
    episode_title?: string | null;
    /** Remote https poster URL straight from Sonarr/Radarr. */
    poster?: string | null;
    year?: number | null;
    /** The grab's info-hash, lower-case — the key of /api/downloads/{id}/stream and /probe
     * (watch-while-downloading). null until the grab reaches qBittorrent. */
    download_id?: string | null;
    /** The row is the caller's: their title, or (tv) a season they asked for with Get
     * (ownership.py). Absent from a backend without ownership. */
    mine?: boolean;
    /** The caller may cancel it (admin or mine). Absent (older backend) = allowed. */
    can_cancel?: boolean;
  }

  /** `GET /api/activity` — models.py `ActivityResponse`. Active downloads first, fastest on top. */
  interface ActivityResponse {
    items: ActivityItem[];
  }

  /** Video stream of a probe — streaming.py `_shape_probe()`. */
  interface ProbeVideo {
    index: number | null;
    codec: string | null;
    width: number | null;
    height: number | null;
    /** `_hdr()`: Dolby Vision side data → 'DV', smpte2084 → 'HDR10', arib-std-b67 → 'HLG', else null. */
    hdr: 'DV' | 'HDR10' | 'HLG' | null;
    fps: number | null;
  }

  interface ProbeAudio {
    index: number | null;
    codec: string | null;
    channels: number | null;
    /** ffprobe channel_layout ('5.1(side)', 'stereo', …). */
    layout: string | null;
    lang: string | null;
    title: string | null;
    /** The server's verdict: profile mentions Atmos or JOC. */
    atmos: boolean;
    default: boolean;
  }

  interface ProbeSubtitle {
    index: number | null;
    codec: string | null;
    lang: string | null;
    title: string | null;
    forced: boolean;
    default: boolean;
  }

  /** `GET /api/downloads/{download_id}/probe` (200) — streaming.py `probe_endpoint()` /
   * `_shape_probe()`. Before the file header is on disk the route answers 409 with
   * {@link ProbeNotReady}; an unknown hash 404 `{error:'not_found'}`; no ffprobe 503. */
  interface ProbeResponse {
    /** First ffprobe format name: 'matroska', 'mov', … (sourceFromProbe maps matroska → 'mkv'). */
    container: string | null;
    duration_s: number | null;
    /** bit/s. */
    bitrate: number | null;
    size_bytes: number;
    video: ProbeVideo | null;
    audio: ProbeAudio[];
    subtitles: ProbeSubtitle[];
  }

  /** The 409 body of /probe (`_not_ready()`, streaming.py), sent with `Retry-After: 10`. */
  interface ProbeNotReady extends ApiError {
    error: 'not_ready';
  }

  /** One episode a cancel covered — models.py `CancelledEpisode`. */
  interface CancelledEpisode {
    season: number | null;
    episode: number | null;
  }

  /** `DELETE /api/activity/{type}/{id}[?season=&episode=&blocklist=]` — models.py `CancelResult`,
   * undo.py `cancel()`. 400 `bad_request` for an episode without season / a movie with one. */
  interface CancelResponse {
    id: string;
    type: MediaType;
    status: 'cancelled';
    downloads_removed: number;
    /** Every episode the cancelled torrents covered (a season pack: all of them); [] for a movie. */
    episodes: CancelledEpisode[];
    /** Episodes (tv) / movies now unmonitored, so the arr doesn't grab them again. */
    unmonitored: number;
    /** Downloads left alone because they were already importing. */
    kept: number;
  }

  /** An undo token: opaque, minted by the POST it undoes, in memory for ~10 min (410 after a
   * restart or expiry). undo.py. */
  type UndoToken = string;

  /** `POST /api/library` {id, type} (202) — models.py `LibraryAddResult`. */
  interface LibraryAddResult {
    id: string;
    type: MediaType;
    title: string;
    status: string;
    /** Hand back to `DELETE /api/library/{type}/{id}?undo=`; null when the arr didn't say what it created. */
    undo?: UndoToken | null;
  }

  /** `DELETE /api/library/{type}/{id}?undo=` (undo.py `undo_add()`; 409 when the title was
   * already imported — an undo never deletes files) or `?delete_files=true` (undo.py
   * `delete_with_files()`: the title AND its files, owner or admin only) — models.py
   * `LibraryUndoResult`. */
  interface LibraryUndoResult {
    id: string;
    type: MediaType;
    title: string;
    /** undo: 'removing' = deleted once its running searches end. delete: 'deleting' = deleted
     * with its files once its running searches end. */
    status: 'removed' | 'removing' | 'already_removed' | 'deleted' | 'deleting';
    downloads_removed: number;
  }

  /** `GET /api/me` user — models.py `MeUser`. */
  interface MeUser {
    /** Jellyfin user id, 32 lowercase hex. */
    id: string;
    name: string;
  }

  /** One kind's quota use — models.py `QuotaUse`. */
  interface QuotaUse {
    /** Titles of this kind the user added that still exist. */
    used: number;
    /** null = no limit (an admin). */
    limit: number | null;
  }

  /** models.py `Quota`. */
  interface Quota {
    movie: QuotaUse;
    tv: QuotaUse;
  }

  /** One of the caller's titles in `GET /api/me` — models.py `OwnedTitle`. */
  interface OwnedTitle {
    type: MediaType;
    /** tmdb / tvdb id, as /api/lookup hands it out. */
    id: string;
    title: string;
    year: number | null;
    poster: string | null;
    /** UTC ISO, when it was added. */
    added_at: string;
    /** Its most active grab in flight, else 'waiting' (nothing grabbed, no files) or
     * 'in_library'. */
    status: 'downloading' | 'queued' | 'importing' | 'paused' | 'warning' | 'waiting' | 'in_library';
    /** 0..1 over its grabs in flight (size-weighted), else null. */
    progress: number | null;
    /** Anything of it on disk (a series can be downloading too). */
    has_files: boolean;
  }

  /** `GET /api/me` — models.py `MeResponse`: the caller, their quota and the titles they own.
   * 404 from an older backend (no ownership). */
  interface Me {
    user: MeUser;
    /** Jellyfin Policy.IsAdministrator: may do everything, no quota. */
    admin: boolean;
    quota: Quota;
    titles: OwnedTitle[];
  }

  /** `POST /api/news/search` {id, season} (202) — models.py `SeasonSearchResult`. */
  interface SeasonSearchResult {
    id: string;
    season: number;
    title: string;
    status: 'searching';
    /** Hand back to `DELETE /api/news/search/{undo}`. */
    undo?: UndoToken | null;
  }

  /** `DELETE /api/news/search/{token}` — models.py `SeasonSearchUndoResult`, undo.py `undo_get()`. */
  interface SeasonSearchUndoResult {
    id: string;
    season: number;
    title: string;
    status: 'reverted';
    downloads_removed: number;
    /** Grabs already importing, left alone. */
    kept: number;
  }

  /* ================= browse: lookup, trending, charts, collection (T04) ================= */

  /** One `/api/lookup` result — models.py `LookupResult` (Sonarr/Radarr lookup, `id` = tvdbId
   * for tv, tmdbId for movies — "the opaque lookup id" every other route takes). */
  interface LookupResult {
    id: string;
    type: MediaType;
    title: string;
    year: number | null;
    overview: string;
    /** Remote https poster. */
    poster: string | null;
    /** Already in Sonarr/Radarr (re-derived from the arr library on every request). */
    added: boolean;
    /** IMDb-scale vote count, a popularity signal for ranking (default 0). */
    votes?: number;
    /** Radarr's original-language title, when it differs. */
    original_title?: string | null;
  }

  /** What the client hands lookupOpener()/openLookup() when it has no full result: the
   * news bell builds `{ id, type, title, year, poster, added }` from a NewsItem (TopNav.svelte,
   * phone Notifications.svelte), so S.lookup can hold one of these. */
  type LookupRef = Pick<LookupResult, 'id' | 'type' | 'title'> & Partial<LookupResult>;

  /** `GET /api/lookup?q=&type=` — models.py `LookupResponse`. */
  interface LookupResponse {
    query: string;
    type: string;
    results: LookupResult[];
  }

  /** One Home trending tile — models.py `TrendingResult` (trending.py). */
  interface TrendingItem extends LookupResult {
    imdb_id: string;
    /** IMDb rating (≥ 7.5 by the server's filter). */
    rating: number;
    rating_votes: number;
    /** IMDb popularity rank (MOVIEmeter/TVmeter), 1 = most popular. */
    rank: number;
    /** ISO date: primary release (movie) / first episode (show). */
    released: string;
    /** ISO date, movies only, when Radarr knows it (still in cinemas while ahead). */
    digital_release?: string | null;
  }

  /** `GET /api/trending?type=` — models.py `TrendingResponse`. mlTrending() de-duplicates
   * `results` by type:id client-side. */
  interface TrendingResponse {
    type: MediaType;
    results: TrendingItem[];
  }

  /** One browse card — models.py `ChartCategory` (charts.py). */
  interface ChartCategory {
    /** 'top-movie' | 'top-tv' | 'genre-<Genre>'. */
    key: string;
    title: string;
    /** The kinds its titles come in. */
    types: MediaType[];
    count: number;
    /** A few IMDb poster thumbnails for the card's fan. */
    posters: string[];
  }

  /** `GET /api/charts` — models.py `ChartIndex`. */
  interface ChartIndex {
    categories: ChartCategory[];
  }

  /** One chart entry — models.py `ChartResult`. */
  interface ChartResult extends LookupResult {
    imdb_id: string;
    rating: number | null;
    rating_votes: number;
    /** Position in the chart, 1-based (the `#rank` badge). */
    rank: number;
  }

  /** models.py `ChartSection` — one per kind. */
  interface ChartSection {
    type: MediaType;
    title: string;
    results: ChartResult[];
  }

  /** `GET /api/charts/{key}` — models.py `Chart`. mlChart() de-duplicates each section. */
  interface Chart {
    key: string;
    title: string;
    sections: ChartSection[];
  }

  /** One film of a collection — models.py `CollectionMovie` (lookup-shaped, id = tmdb id). */
  interface CollectionMovie extends LookupResult {
    /** IMDb rating, else TMDB. */
    rating?: number | null;
    /** ISO date of the primary release, when known. */
    released?: string | null;
  }

  /** `GET /api/collection/{tmdbCollectionId}` — models.py `Collection` (collections.py). */
  interface CollectionResponse {
    id: string;
    title: string;
    overview: string;
    poster: string | null;
    fanart: string | null;
    /** In release order. */
    movies: CollectionMovie[];
  }

  /* ================= metadata (T04) ================= */

  /** models.py `EpisodeMetadata` (tv only). */
  interface EpisodeMetadata {
    season: number | null;
    episode: number | null;
    title: string;
    overview: string;
    /** ISO date. */
    air_date: string | null;
    /** Remote https TVDB still (Sonarr's includeImages=true). */
    still: string | null;
    has_file: boolean;
  }

  /** models.py `CollectionRef`. */
  interface CollectionRef {
    /** TMDB collection id — what /api/collection/{id} takes. */
    id: string;
    title: string;
  }

  /** `GET /api/metadata/{type}/{id}` — models.py `TitleMetadata` (arr.py `metadata()`): what
   * Sonarr/Radarr know about a title, downloaded or not. */
  interface Metadata {
    id: string;
    type: MediaType;
    title: string;
    year: number | null;
    overview: string;
    poster: string | null;
    /** Remote https backdrop. */
    fanart: string | null;
    runtime_min: number | null;
    genres: string[];
    rating: number | null;
    certification: string | null;
    /** continuing/ended (tv), released/inCinemas/… (movie). */
    status: string | null;
    /** tv only; empty for movies and for a series not yet added. */
    episodes: EpisodeMetadata[];
    /** YouTube video id (Radarr's youTubeTrailerId; movies only). */
    trailer?: string | null;
    /** The TMDB collection a movie belongs to. */
    collection?: CollectionRef | null;
    /** ISO date (YYYY-MM-DD) of Radarr's digital release; movies only, null for tv. */
    digital_release?: string | null;
  }

  /* ================= news bell (T04) ================= */

  /** One new season — models.py `NewsItem` (`GET /api/news`, built from Sonarr's per-season
   * statistics). */
  interface NewsItem {
    /** '{tvdb}:{season}:{kind}' — stable per season AND kind, so a premiere re-notifies. */
    id: string;
    /** aired: episodes out, latest within a year (Get button); upcoming: listed, nothing aired. */
    kind: 'aired' | 'upcoming';
    /** tvdb id — the opaque lookup id. */
    media_id: string;
    title: string;
    year: number | null;
    poster: string | null;
    fanart: string | null;
    season: number;
    /** ISO UTC: first episode's air time (null = not announced). */
    premiere: string | null;
    /** ISO UTC, aired only. */
    last_aired: string | null;
    episodes_aired: number;
    episodes_total: number;
    /** Series + season monitored: Sonarr will grab it by itself. */
    monitored: boolean;
  }

  /** `GET /api/news` — models.py `NewsResponse`. */
  interface NewsResponse {
    items: NewsItem[];
  }

  /* ================= segments (IntroDB) (T04) ================= */

  /** models.py `CommunitySegment` — seconds. */
  interface CommunitySegment {
    start: number;
    end: number;
    /** How many people marked it (IntroDB's submission_count). */
    submissions: number;
  }

  /** `GET /api/segments/{seriesImdb}/{season}/{episode}` — models.py `CommunitySegments`
   * (introdb.py). null = nothing submitted for that kind. */
  interface SegmentsResponse {
    intro: CommunitySegment | null;
    recap: CommunitySegment | null;
    outro: CommunitySegment | null;
  }

  /* ================= trailers (T04) ================= */

  /** trailers.py `Job.status()` — `POST /api/trailers/{key}` (start, idempotent) and
   * `GET /api/trailers/{key}` (poll; 404 `not_found` before a start). `key` = YouTube id, or
   * `<id>@<height>` (the phone asks for @1080). Files: `/api/trailers/{key}/index.m3u8`, the
   * fMP4 segments, `subs.vtt`. */
  interface TrailerStatus {
    /** The YouTube id. */
    id: string;
    state: 'resolving' | 'downloading' | 'ready' | 'error';
    /** Segments written to the HLS event playlist so far. */
    segments: number;
    buffered_s: number;
    /** From yt-dlp, seconds (the feeder sets ms.duration from it). */
    duration: number | null;
    /** `#EXT-X-ENDLIST` written. */
    complete: boolean;
    width: number | null;
    height: number | null;
    vcodec: string | null;
    /** RFC 6381 codecs string for MSE (`vp09.PP.LL.DD,opus` — the server builds VP9's). */
    codecs: string | null;
    /** yt-dlp's dynamic_range when not SDR ('HDR10', 'HLG', …), else null. */
    hdr: string | null;
    /** English subtitles fetched next to the video, or null. */
    subs: TrailerSubs | null;
    /** The subtitle fetch has finished (with or without a track). */
    subs_done: boolean;
    title: string | null;
    error: string | null;
  }

  /** `POST /api/downloads/{gid}/hls?audio=` (start or join) and `GET` (poll; 404 `not_found` before a
   * start) — livehls.py `Job.status()`: one remux of a growing download into an fMP4 event playlist
   * (phone watch-while-downloading, src/lib/livefeed.js). */
  interface LiveHlsStatus {
    /** The download's info-hash (lower-case). */
    id: string;
    /** The audio stream index the job remuxes (-1 = the default track). */
    audio: number;
    state: 'probing' | 'remuxing' | 'done' | 'error';
    /** Segments written to the playlist so far. */
    segments: number;
    buffered_s: number;
    /** ffprobe's duration, seconds. */
    duration: number | null;
    /** `#EXT-X-ENDLIST` written. */
    complete: boolean;
    /** RFC 6381 codecs string for MSE, once probed. */
    codecs: string | null;
    video: { codec: string; width: number | null; height: number | null; dv_profile: number | null } | null;
    audio_codec: string | null;
    progress: number | null;
    error: string | null;
  }

  interface TrailerSubs {
    lang: 'en';
    /** manual = an uploaded en* track; auto = YouTube's captions; translated = machine translation. */
    kind: 'manual' | 'auto' | 'translated';
  }

  /* ================= push (phone) (T04) ================= */

  /** `GET /api/push/config` — push.py. `enabled` is false when VAPID_PRIVATE_KEY is unset. */
  interface PushConfig {
    enabled: boolean;
    /** VAPID public key (base64url). */
    key: string | null;
  }

  /** `POST /api/push/subscribe` body — phone/src/lib/push.js subscribeAndRegister(). */
  interface PushSubscribeBody {
    subscription: PushSubscriptionJSON;
    token: string;
    user_id: string;
    device_id: string;
    ready: boolean;
    seasons: boolean;
  }

  /** `POST /api/push/subscribe` answer. */
  interface PushSubscribeResult {
    ok: true;
    /** The Jellyfin user name the token belongs to. */
    user: string;
  }

  /** `POST /api/push/status` {endpoint} answer — what Settings' switches show. */
  interface PushStatus {
    subscribed: boolean;
    ready: boolean;
    seasons: boolean;
  }
}
