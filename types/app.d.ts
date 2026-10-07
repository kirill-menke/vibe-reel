/* App-level shapes: the shared $state objects and module APIs. Global namespace `VR`.
 * NavState (S), PlayerState (P), RouterState (R, phone), PhoneNavState (the phone S), the
 * phone-shim helper ShimOf and the error shapes (ApiError, OfflineError) are complete; later
 * tasks add the activity group. */

declare namespace VR {
  type Screen = 'boot' | 'login' | 'home' | 'library' | 'detail' | 'person' | 'player' | 'pending' | 'lookup';

  /** `S` in src/lib/nav.svelte.js (the TV navigation state). */
  interface NavState {
    screen: Screen;
    /** The browse screen mounted behind any overlay (player, Search). */
    base: Screen;
    tab: string;
    focusKey: string | null;
    lastPill: string | null;
    detailId: string | null;
    /** undefined when openItem() was called without a type (the Detail page then reads it from the item). */
    detailType: string | null | undefined;
    personId: string | null;
    personName: string;
    /** Activity group key shown by PendingDetail. */
    pendingKey: string | null;
    search: boolean;
    searchFocus: string | null;
    searchChart: string | null;
    searchKb: boolean;
    /** The /api/lookup result LookupDetail shows — or the partial {@link Reel.LookupRef}
     * the news bell builds (TopNav: `{ id, type, title, year, poster, added }`). */
    lookup: Reel.LookupResult | Reel.LookupRef | null;
    addingAccount: boolean;
    ready: boolean;
    splashActive: boolean;
    /** Bumped by every open*(); App.svelte keys the screen on it. */
    epoch: number;
  }

  /* ================= player (P in src/lib/player.svelte.js) ================= */

  /** What `P.item` / `P.detailItem` / `P.loadingItem` hold: a Jellyfin item, or the stub a
   * pending stream / trailer builds (`{ Id: null, Name }`). Two client-only fields ride on a
   * trailer's detailItem (playTrailerStream) and on an offline copy's item (phone offline.svelte.js):
   * `_art` = the backdrop the loading card shows, `_sub` = its subtitle line ("Trailer").
   * `Id` is optional/nullable for those stubs: pendingplay.js builds the pending stream's item
   * (`{ Type, Name, SeriesName, …, Genres, RunTimeTicks }`) with no Id at all, and P.item for a
   * pending/feed stream is `{ Id: null, Name }`. */
  type PlayerItem = Omit<Jf.BaseItemDto, 'Id'> & {
    Id?: string | null;
    _art?: string | null;
    _sub?: string;
  };

  /** A media stream as the player holds it: Jellyfin's, plus `_vtt` — the subtitle text itself
   * when it is already in memory (a trailer's English track from trailerstream.js, an offline
   * copy's cached subtitle), so attachSubs() skips the fetch. */
  type PlayerStream = Omit<Jf.MediaStream, 'VideoRangeType'> & {
    _vtt?: string | null;
    /** Jellyfin's VideoRangeType — or, on a trailer's synthetic video stream (startTrailer()),
     * yt-dlp's `dynamic_range` as reel-api passes it ('HDR10', 'HLG', 'HDR10+', 'HDR12', 'DV'),
     * which hdrLabel() only partly understands (finding F06). */
    VideoRangeType?: Jf.VideoRangeType | (string & {}) | null;
  };

  /** `P.source`: the PlaybackInfo media source, a synthetic one (sourceFromProbe for a pending
   * stream, the trailer feeder's `{ Id: 'trailer', RunTimeTicks, MediaStreams }`), or null. */
  type PlayerSource = Omit<Jf.MediaSourceInfo, 'MediaStreams'> & {
    MediaStreams?: PlayerStream[];
  };

  /** What playFeedStream()'s `open` gets (phone MSE streams, player.svelte.js startFeed()):
   * the audio stream index, the player's live position getter (effectivePos), a seek callback
   * for the feeder's gap jumps, and the failure hook. */
  interface FeedOpenArgs {
    audioIndex: number;
    position: () => number;
    jump: (t: number) => void;
    onFail: (e: ApiError) => void;
  }

  /** A running MSE feed (livefeed.js liveOpener(), offline.svelte.js): the blob URL for the
   * <video>, whether it is a ManagedMediaSource, and stop(). */
  interface Feed {
    url: string;
    managed: boolean;
    stop(): void;
  }

  /** playFeedStream() options (src/lib/player.svelte.js). `open` makes a fresh feeder (Retry and
   * an audio switch need a new MediaSource); `exit(pos, dur, started)` / `checkpoint(pos, dur)`
   * only for an offline copy — a pending download (pendingplay.js) passes neither. */
  interface FeedStreamOptions {
    item: PlayerItem;
    source: PlayerSource;
    downloadId?: string | null;
    open: (args: FeedOpenArgs) => Feed;
    exit?: ((pos: number, dur: number, started: boolean) => void) | null;
    checkpoint?: ((pos: number, dur: number) => void) | null;
    /** Start position, seconds (default 0). */
    start?: number;
    /** Stream index; default describeTracks()'s. */
    audioIndex?: number | null;
    /** Stream index, default -1 (none). */
    subIndex?: number;
  }

  /** Which OSD dropdown is open. TV: audio / subs / picture (PlayerMenu) and chapters (VideoLayer);
   * phone: tracks (TrackPanel) and chapters (ChapterPanel). */
  type PlayerPanel = 'audio' | 'subs' | 'picture' | 'chapters' | 'tracks';

  /** A Skip-chip kind (segments.js). */
  type SkipKind = 'intro' | 'recap' | 'preview';

  /** Where a skip/credits window came from: Jellyfin Media Segments, a named Matroska
   * chapter, or IntroDB via reel-api. */
  type SegmentSource = 'segment' | 'chapter' | 'introdb';

  /** A window in seconds (segments.js `check()`/`win()`). */
  interface SegmentWindow {
    start: number;
    end: number;
    from: SegmentSource;
  }

  /** One of `P.skips`: the Skip chip's window for one kind. */
  interface SkipWindow extends SegmentWindow {
    kind: SkipKind;
  }

  /** `P.trick`: the trickplay sheet layout lookUpTrickplay() picked (narrowest width). */
  interface TrickLayout {
    /** The item id the sheets belong to. */
    id: string;
    sourceId: string;
    /** Thumbnail width = the `{width}` in /Videos/{id}/Trickplay/{width}/{sheet}.jpg. */
    res: number;
    /** One thumbnail's size in px. */
    w: number;
    h: number;
    /** Tiles per sheet row / column. */
    cols: number;
    rows: number;
    count: number;
    /** Seconds between thumbnails. */
    interval: number;
  }

  /** `P.error`: the playback error card. */
  interface PlayerError {
    title: string;
    detail: string;
    /** techLine(): "4K HDR10 · DD+ 5.1 · DirectPlay"-style summary. */
    tech: string;
  }

  /** `P.slowNet`: Mbit/s the file needs vs. what the TV/phone is getting (stall watchdog). */
  interface SlowNet {
    need: number;
    got: number;
  }

  /** `P.link`: the last slowNet measurement (Mbit/s) and when (Date.now() ms), kept 30 min for
   * TechGrid's "expect buffering" chip. */
  interface LinkSample {
    got: number;
    at: number;
  }

  /** One of `P.chapters`: scrubber ticks + the Chapters list. */
  interface PlayerChapter {
    /** Seconds. */
    at: number;
    name: string;
    /** Read by phone ChapterPanel (`c.img`, "Jellyfin's chapter images") but never set:
     * lookUpTrickplay() builds `{ at, name }` only — finding F04 (run/findings.md). */
    img?: undefined;
  }

  /** The phone's streaming-quality cap: 'original' or bit/s (QUALITY_CAPS). */
  type QualityCap = 'original' | 8000000 | 4000000;

  /** `P.quality` (phone only): the stream under the Settings cap (phoneQuality), null uncapped. */
  interface PhoneQuality {
    /** bit/s. */
    cap: number;
    mbit: number;
    /** The server re-encodes (a file above the cap); false = the file fits and is copied. */
    reduced: boolean;
    /** '1080p' / '720p'-style, '' when unknown or not reduced. */
    res: string;
    label: string;
  }

  /* ---------- player.svelte.js module state and call shapes (T15) ---------- */

  /** What startPlayback() was asked to run: a Jellyfin PlayMethod, or one of the two MSE
   * blob-URL kinds — 'Feed' (phone: pending download / offline copy, segfeed.js) and 'Trailer'
   * (trailerstream.js). Only the Jellyfin ones ever reach `P.playMethod`. */
  type StartMethod = Jf.PlayMethod | 'Feed' | 'Trailer';

  /** createTrailerSource() (trailerstream.js): the blob URL for the <video>, `managed` (phone
   * builds only — `...(__PHONE__ ? { managed } : {})`: a ManagedMediaSource) and stop(). */
  interface TrailerSource {
    url: string;
    managed?: boolean;
    stop(): void;
  }

  /** createTrailerSource()'s hooks (trailerstream.js; player.svelte.js startTrailer() passes all five). */
  interface TrailerSourceHooks {
    /** The trailer can't be had (yt-dlp failed, the service is down, the codec is refused). */
    onFail?: ((e: Error) => void) | null;
    /** The server's status once known (duration, resolution, codecs) — for the OSD. */
    onInfo?: ((st: Reel.TrailerStatus) => void) | null;
    /** English subtitles exist: the VTT text and the status's `subs`. */
    onSubs?: ((vtt: string, subs: Reel.TrailerSubs) => void) | null;
    /** The playhead, seconds. */
    position?: (() => number) | null;
    /** A quiet seek, for stepping over a hole between buffered ranges. */
    jump: (t: number) => void;
  }

  /** player.svelte.js `feedRun`: the phone MSE stream playing (playFeedStream()). */
  interface FeedRun {
    open: FeedStreamOptions['open'];
    exit?: FeedStreamOptions['exit'];
    checkpoint?: FeedStreamOptions['checkpoint'];
    /** The current feeder; replaced by every startFeed() (Retry, audio switch). */
    feeder: Feed | null;
    /** A frame has played ('playing' fired) — before that the position is only the start asked for. */
    started: boolean;
  }

  /** playTrailerStream() argument (trailer.js openTrailer()). */
  interface TrailerStreamArgs {
    /** YouTube video id. */
    id: string;
    title?: string | null;
    /** Backdrop URL for the loading card. */
    art?: string | null;
    /** The trailer can't be had: trailer.js falls back to the YouTube app. */
    onFail?: ((e: Error) => void) | null;
  }

  /** The P fields a detail page had seeded before a trailer started, restored by endTrailer(). */
  type TrailerSaved = Pick<PlayerState, 'detailItem' | 'item' | 'source' | 'series' | 'audioIndex'
    | 'subIndex' | 'subOffset' | 'sessionId' | 'playMethod'>;

  /** player.svelte.js `trailerRun`: the trailer playing. */
  interface TrailerRun {
    id: string;
    onFail?: TrailerStreamArgs['onFail'];
    /** data-focus of the button it was started from (focus goes back there). */
    back: string | null;
    saved: TrailerSaved;
    /** Subtitles switched off during this trailer (pmSetSub) — a Retry keeps them off. */
    subsOff?: boolean;
  }

  /** playPendingStream() argument (pendingplay.js). */
  interface PendingStreamArgs {
    /** reel-api `/api/downloads/{id}/stream`. */
    url: string;
    item: PlayerItem;
    source: PlayerSource;
    downloadId?: string | null;
  }

  /** findMarkers() / communityMarkers() (segments.js): the Skip-chip windows (sorted by start,
   * at most one per kind) and the closing credits. */
  interface Markers {
    skips: SkipWindow[];
    credits: SegmentWindow | null;
  }

  /** upNextWindow(): the card shows from `at`, rolls on at `go` (seconds). */
  interface UpNextWindow {
    at: number;
    go: number;
  }

  /** trickAt(): the trickplay sheet URL and the thumbnail's offset in it (sheet px). */
  interface TrickThumb {
    url: string;
    x: number;
    y: number;
  }

  /** The picture-mode companion service's answers (service/service.js, `http://127.0.0.1:8791`):
   * `/modes` → `{ returnValue, current, modes }`; `/picture?mode=` → `{ returnValue, errorText? }`
   * (`errorText: 'superseded'` when a newer set replaced a waiting one). */
  interface PictureReply {
    returnValue: boolean;
    current?: string | null;
    modes?: string[];
    errorText?: string;
  }

  /** `P` in src/lib/player.svelte.js — the reactive slice the OSD / panel / info read. */
  interface PlayerState {
    item: PlayerItem | null;
    source: PlayerSource | null;
    /** A still-downloading file (or, phone, an offline copy / MSE feed): every Jellyfin side
     * call is gated off. Also true for a trailer. */
    pending: boolean;
    /** A YouTube trailer in our own player (P.pending is set too). */
    trailer: boolean;
    /** PlaySessionId, '' when none. */
    sessionId: string;
    /** Stream index, -1 = none. */
    audioIndex: number;
    subIndex: number;
    playMethod: Jf.PlayMethod;
    /** The item the detail page shows (the series for an episode started from SeriesDetail). */
    detailItem: PlayerItem | null;
    series: Jf.BaseItemDto | null;
    seasons: Jf.BaseItemDto[] | null;
    panel: PlayerPanel | null;
    osdShown: boolean;
    spinner: boolean;
    paused: boolean;
    /** Seconds. */
    pos: number;
    dur: number;
    skips: SkipWindow[];
    /** `kind + ':' + start` of the window just skipped — its chip stays down (skipSegment). */
    skipped: string | null;
    credits: SegmentWindow | null;
    /** The episode Up Next would play. */
    next: Jf.BaseItemDto | null;
    upNextOff: boolean;
    trick: TrickLayout | null;
    /** Pending scrubber target in seconds while previewing. */
    scrub: number | null;
    /** The picture-mode companion service answered `/health` (rooted TVs only); null = not asked yet. */
    picSvc: boolean | null;
    /** Picture-mode ids the companion service offers for the live signal (`/modes`). */
    pictureModes: string[];
    pictureMode: string | null;
    picErr: boolean;
    picLoading: boolean;
    /** Mode asked of the service, not yet confirmed. */
    picPending: string | null;
    /** Subtitle timing shift in seconds (+ = later). */
    subOffset: number;
    loading: boolean;
    loadingItem: PlayerItem | null;
    /** Start position the loading card announces, seconds. */
    loadingFrom: number;
    /** Pending streams: the grab's info-hash. */
    downloadId: string | null;
    error: PlayerError | null;
    slowNet: SlowNet | null;
    link: LinkSample | null;
    chapters: PlayerChapter[];
    /** Phone builds only (`...(__PHONE__ ? { quality: null } : {})`). */
    quality?: PhoneQuality | null;
  }

  /* ================= tracks (src/lib/tracks.js describeTracks) ================= */

  /** One audio row of describeTracks(): `label` is the menu text ("English · DD+ 5.1 · Atmos",
   * duplicates numbered), `index` the MediaStream Index, `codec`/`lang` lower-cased. Rows are
   * built with `parts` (string pieces) and numberDupes() turns them into `label` and deletes
   * `parts` — so `parts` only exists while describeTracks() runs. */
  interface AudioTrack {
    label: string;
    index: number;
    codec: string;
    atmos: boolean;
    commentary: boolean;
    lang: string;
    parts?: string[];
  }

  /** One subtitle row of describeTracks(); the first is always `{ label: 'None', index: -1, lang: '' }`
   * (no codec/forced/burn). `burn` = VobSub/DVB, only playable as a Jellyfin burn-in. */
  interface SubTrack {
    label: string;
    index: number;
    lang: string;
    codec?: string;
    forced?: boolean;
    burn?: boolean;
    parts?: string[];
  }

  /** describeTracks(src, item): the menus' rows plus the defaults (stream indexes; -1 = none).
   * `audio` is sorted best-first by score(); `video` is the one-line video summary. */
  interface TrackList {
    audio: AudioTrack[];
    subs: SubTrack[];
    video: string;
    defaultAudio: number;
    defaultSub: number;
  }

  /* ================= phone router (phone/src/lib/router.svelte.js) ================= */

  /** A phone tab = one push stack (TABS). */
  type TabName = 'home' | 'movies' | 'shows' | 'search';

  /** A route = a screen of phone/src/screens/index.js (`screens` map). */
  type RouteName = TabName | 'chart' | 'detail' | 'person' | 'lookup' | 'pending' | 'settings' | 'downloads' | 'mylibrary';

  /** A sheet of phone/src/sheets/index.js (`sheets` map). */
  type SheetName = 'accounts' | 'notifications' | 'sortfilter' | 'offline';

  /** Everything any route/sheet is pushed with (push(name, params) / openSheet(name, params)).
   * One shape for all: each screen reads only its own keys. */
  interface RouteParams {
    /** detail / person: the Jellyfin item id. */
    id?: string;
    /** detail: the item Type ('Movie', 'Series', …; null/absent when the opener didn't know it —
     * nav openItem()'s `type` is optional); movies/shows roots: 'movies' | 'shows'. */
    type?: string | null;
    /** person: the name. */
    name?: string;
    /** lookup: the /api/lookup result (or the bell's partial ref); offline sheet: the Jellyfin item. */
    item?: Reel.LookupResult | Reel.LookupRef | Jf.BaseItemDto;
    /** pending: the activity group key; chart: the chart key. */
    key?: string;
    /** chart: the category title. */
    title?: string;
    /** sortfilter sheet: which library tab. */
    tab?: string;
    /** sortfilter sheet: open on this section ('genre'). */
    focus?: string;
  }

  /** `{ name, params, key }` — key is unique per push (`name-<seq>`). */
  interface Route {
    name: RouteName;
    params: RouteParams;
    key: string;
  }

  /** `R.sheet`: key is `sheet-<seq>`. */
  interface SheetRoute {
    name: SheetName;
    params: RouteParams;
    key: string;
  }

  /** The two full-screen modals. */
  type Modal = 'player' | 'login';

  /** `R.anim`: the running push/pop transition App.svelte animates. */
  interface RouteAnim {
    dir: 'push' | 'pop' | 'fade' | 'zoom' | 'unzoom';
    /** Route keys. */
    from: string;
    to: string;
    /** pop/cut: the route leaving (App keeps it painted until the animation ends). */
    gone?: Route;
    back?: boolean;
    /** replace() swapped the top route. */
    replace?: boolean;
    /** ms; App.svelte sets it when an edge-swipe release finishes a pop at its own speed. */
    dur?: number;
  }

  /** `R` (class Router) in phone/src/lib/router.svelte.js. */
  interface RouterState {
    tab: TabName;
    stacks: Record<TabName, Route[]>;
    sheet: SheetRoute | null;
    modal: Modal | null;
    /** Bumped after a player-modal close that may have moved play state (not after a trailer). */
    playerClosed: number;
    /** The player shows something that reports no play state (a trailer) — plain field, not $state. */
    playerQuiet: boolean;
    /** Bumped when the active tab is tapped at its root. */
    toTop: number;
    anim: RouteAnim | null;
    /** Key of the route an edge swipe is revealing. */
    peek: string | null;
    booted: boolean;
    visited: Record<TabName, boolean>;
  }

  /** What the phone's `S.screen` can be: the top route's name, 'player' / 'login' while that
   * modal is up, 'boot' before markBooted() — and, transiently, 'library' (the engine lowers the
   * player with `S.screen = S.base`, which the setter turns into closePlayer() + a resync). */
  type PhoneScreen = Screen | RouteName;

  /** The phone's `S.base`: the top route in TV vocabulary ('library' for the movies/shows roots). */
  type PhoneBase = Exclude<RouteName, 'movies' | 'shows'> | 'library';

  /** The phone's `S` (class NavState in router.svelte.js, re-exported by the nav shim): every
   * VR.NavState key, but `screen`/`base` are wider (phone route names) and `screen` is an accessor
   * over `_screen` whose setter opens/closes the player modal. src/lib, type-checked against the
   * TV nav module (TypeScript can't follow the build's redirect), sees VR.NavState. */
  interface PhoneNavState extends Omit<NavState, 'screen' | 'base'> {
    /** The raw value (markBooted() writes it to skip the setter). */
    _screen: PhoneScreen;
    screen: PhoneScreen;
    base: PhoneBase;
  }

  /* ================= phone module shims (phone/vite.config.js redirects) ================= */

  /** The signature a phone shim export must have to stand in for TV function `F`: it accepts
   * every argument list `F` accepts, and returns what `F` returns — or nothing (a no-op shim's
   * "nothing here": undefined, falsy where the TV returns a boolean). Async stays async.
   * Used as `@type {VR.ShimOf<typeof tv.focusEl>}` on the no-op exports of focus-shim.js, and
   * asserted for every shim export in types/tests/phone/module-redirects.js. */
  type ShimOf<F extends (...args: any[]) => any> = (
    ...args: Parameters<F>
  ) => ReturnType<F> extends Promise<infer T> ? Promise<T | void> : ReturnType<F> | void;

  /** ShimOf for an `async function` shim: TypeScript wants an async function's declared return
   * type to be a plain `Promise<…>`, not a conditional type that resolves to one. */
  type AsyncShimOf<F extends (...args: any[]) => Promise<any>> = (
    ...args: Parameters<F>
  ) => Promise<Awaited<ReturnType<F>> | void>;

  /* ================= errors ================= */

  /** Every Error the client's fetch layers throw — `new Error(…)` plus the fields its creator
   * sets (cast at the creation site). One shape for all, every extra field optional; which ones
   * are set depends on the source:
   *
   * - **api()** (src/lib/api.js, Jellyfin): `status` (0 = no HTTP answer), `userMessage` (a
   *   sentence the UI shows as-is — via errText(e), never raw `e.message`), `network` (no answer
   *   at all, or the body read died on the wire), `cause` (the raw DOMException/TypeError).
   *   `name` is 'AbortError' for a deadline / abort, 'NetworkError' for a failed fetch.
   *   ⚠️ Chromium 120 (the TV) rejects a fetch timed out by `AbortSignal.timeout()` with
   *   **AbortError**, not TimeoutError — test both names or `signal.aborted`. api() normalises
   *   both to `name === 'AbortError'`.
   * - **mlFetch()** (src/lib/medialib.js, reel-api): `status` (0 = unreachable or timed out),
   *   `code` (reel-api's machine code — Reel.ApiError `error`: 'not_ready', 'not_found',
   *   'not_available', 'already_added', 'has_files', 'importing', 'not_aired', …), `detail`
   *   (Reel.ApiError `detail`), `retriable` (unreachable, or a 503 other than 'not_available'),
   *   `retryAfter` (seconds, from a 503's Retry-After, default 60), `body` (a non-OK, non-503
   *   answer's parsed JSON, null when it wasn't JSON — the quota 409's `type`/`used`/`limit`).
   * - **segfeed.js** `code: 'unsupported'` (the iPhone can't play the codecs); **livefeed.js**
   *   and phone **push.js** `status` (the HTTP status of a reel-api call). */
  interface ApiError extends Error {
    status?: number;
    userMessage?: string;
    network?: boolean;
    code?: string | null;
    detail?: string | null;
    retriable?: boolean;
    retryAfter?: number;
    body?: Record<string, any> | null;
  }

  /** Errors of the phone's offline downloader (phone/src/lib/offline.svelte.js `fatal()` /
   * `noRoom()`): `fatal` = stop the download for good (no retry); `noRoom` = the storage quota is
   * (nearly) full. */
  interface OfflineError extends ApiError {
    fatal?: boolean;
    noRoom?: boolean;
  }
  /* ================= download activity (src/lib/activity.svelte.js) ================= */

  /** One title's downloads in flight — `groupsOf()` in activity.svelte.js: one group per
   * show/movie, its grabs under `items` (sorted by season/episode). `status` is the most active
   * status of any grab, `progress` size-weighted across *torrents* (a season pack counts once),
   * `res` the best resolution in flight ('4K' / '1080p' / ''), `speed` bytes/s, `size` bytes,
   * `timeleft` the slowest torrent's ETA string. `key` = `type:media_id` (or `type:t:<title>`
   * against an old backend) — S.pendingKey. */
  interface ActivityGroup {
    key: string;
    type: Reel.MediaType;
    title: string;
    mediaId: string | null;
    poster: string | null;
    year: number | null;
    res: string;
    items: Reel.ActivityItem[];
    status: Reel.ActivityStatus;
    progress: number;
    speed: number;
    size: number;
    timeleft: string | null;
  }

  /* ---------- src/lib state modules (T16) ---------- */

  /** activity.svelte.js `act`: the feed (items normalised by norm(): season/episode/year parsed
   * from `subtitle` against an old backend), `stale` once the poll has failed for > 20 s. */
  interface ActivityState {
    items: Reel.ActivityItem[];
    loaded: boolean;
    stale: boolean;
  }

  /** What tileStatus() / ringClass() / dlBar() / dlTail() / statLabel() read: an activity item, a
   * group, or a hand-built `{ status, progress, speed, timeleft }` (statLabel's "pass an item's
   * download_speed as speed"). */
  interface ActivityLike {
    status: Reel.ActivityStatus;
    progress?: number | null;
    message?: string | null;
    items?: Reel.ActivityItem[];
    download_speed?: number | null;
    speed?: number | null;
    timeleft?: string | null;
  }

  /** dlBar(): the inline download bar on an episode row (`fill` in %). */
  interface DlBar {
    active: boolean;
    fill: number;
  }

  /** toast.svelte.js `toastState`. `undo` runs on the remote's Play key while the toast is up
   * (Keys.svelte takeUndo()), and on the phone's Undo button. */
  interface ToastState {
    msg: string;
    show: boolean;
    undo: (() => void) | null;
  }

  /** Settings → "Show subtitles" (settings.svelte.js SUB_MODES). */
  type SubMode = 'auto' | 'always' | 'off';

  /** settings.svelte.js `SET` (localStorage `reel.settings`; written only through setSetting()). */
  interface Settings {
    /** ISO 639-2/B ('eng', 'ger', …). */
    audioLang: string;
    subLang: string;
    subMode: SubMode;
    autoplayNext: boolean;
    autoSkipIntro: boolean;
    autoSkipRecap: boolean;
    /** % of the default subtitle size (SUB_SIZE_MIN…SUB_SIZE_MAX). */
    subSize: number;
  }

  /** header.svelte.js `HM`: which tab-row dropdown is down (modal for the D-pad). 'mylib' /
   * 'mylib-del' are the avatar's My library panel and its delete confirmation. */
  interface HeaderMenuState {
    open: 'news' | 'account' | 'settings' | 'mylib' | 'mylib-del' | null;
  }

  /** me.svelte.js `ME`: the caller's GET /api/me. `state`: 'idle' (never asked / signed out),
   * 'ok', 'unsupported' (404 — a reel-api from before ownership; never asked again this
   * session), 'error' (the last try failed; `me` keeps the last good answer). */
  interface MeState {
    state: 'idle' | 'ok' | 'unsupported' | 'error';
    me: Reel.Me | null;
    /** Date.now() of the last applied answer. */
    at: number;
  }

  /** me.svelte.js `MY`: the TV's My library panel — the title whose Delete is being confirmed. */
  interface MyLibState {
    confirm: Reel.OwnedTitle | null;
  }

  /** The two library grids (libview.svelte.js SORTS / LV keys). */
  type LibTab = 'movies' | 'shows';

  /** One tab's view (`reel.libview`): SORTS id, genre ('' = all; the phone's SortFilter joins
   * several with '|'), unwatched only, and — phone only — `rev` (reverse the sort). */
  interface LibView {
    sort: string;
    genre: string;
    unwatched: boolean;
    rev?: boolean;
  }

  /** libview.svelte.js `LV`. */
  interface LibViewState {
    movies: LibView;
    shows: LibView;
    /** The library bar's dropdown currently down. */
    open: 'sort' | 'genre' | null;
  }

  /** One of libview.svelte.js SORTS: `by`/`order` go straight into Jellyfin's SortBy/SortOrder. */
  interface SortOption {
    id: string;
    label: string;
    by: string;
    order: string;
  }

  /** One remembered sign-in (account.svelte.js, localStorage `reel.accounts`). */
  interface Account {
    server: string;
    userId: string;
    userName: string;
    token: string;
  }

  /** account.svelte.js `accounts`. */
  interface AccountsState {
    list: Account[];
  }

  /** news.svelte.js `news`: the bell's new-seasons feed. */
  interface NewsState {
    items: Reel.NewsItem[];
    loaded: boolean;
    /** NewsItem ids seen by this user (`reel.newsSeen`). */
    seen: string[];
    /** Ids that were unseen when the menu was opened (they keep their dot). */
    fresh: string[];
    /** id → Date.now() of the last "Get season" this session. */
    searching: Record<string, number>;
    /** id → true once a searched season showed up in the activity feed. */
    found: Record<string, boolean>;
    /** Ticks while a search waits for a grab (searchState). */
    clock: number;
  }

  /** searchState(): the Get button's life after a press (null = never pressed, or it failed). */
  type SeasonSearchState = 'searching' | 'found' | 'none' | null;

  /** seasonActivity(): the most active grab of a news item's season. */
  interface SeasonActivity {
    status: Reel.ActivityStatus;
    progress: number;
  }

  /** lookup.svelte.js `adds` values: per-result add state (keyed by lookupKey()). */
  type AddState = 'idle' | 'added' | 'adding' | 'done' | 'error';

  /** lookup.svelte.js `trending`: one list per type, null until first loaded. */
  interface TrendingState {
    tv: Reel.TrendingItem[] | null;
    movie: Reel.TrendingItem[] | null;
  }

  /** lookupBackdrop(): the hero backdrop for a lookup/trending result, plus its metadata (null when
   * the call failed or took longer than the timeout). */
  interface LookupBackdrop {
    bg: string | null;
    meta: Reel.Metadata | null;
  }

  /** Home.svelte `sel`: the rail tile the hero shows — `{ jf }` a Jellyfin item, or `{ lk, meta }` a
   * Trending result plus its Sonarr/Radarr metadata (filled in once lookupBackdrop() answered). */
  type HomePick =
    | { jf: Jf.BaseItemDto; lk?: undefined; meta?: Reel.Metadata | null }
    | { jf?: undefined; lk: Reel.TrendingItem; meta?: Reel.Metadata | null };

  /** Home.svelte's module-level `lastPick`: restored before the first paint on a Back onto `key`. */
  interface HomeLastPick {
    key: string;
    sel: HomePick | null;
    selBg: string | null;
  }

  /** Home.svelte paint(): the two Jellyfin rail answers (UserItems/Resume, Shows/NextUp). */
  interface HomeRails {
    resume: Jf.QueryResult<Jf.BaseItemDto>;
    nextup: Jf.QueryResult<Jf.BaseItemDto>;
  }

  /** A ContextMenu row (phone): a disabled caption, an action, or a separator — cancel.svelte.js
   * confirmItems(). */
  interface MenuRow {
    label?: string;
    icon?: string;
    danger?: boolean;
    disabled?: boolean;
    sep?: boolean;
    action?: () => void;
  }

  /** landed.svelte.js: one grab in the feed snapshot (`reel.landedFeed` `snap`, keyed by
   * `type:media_id[#SxE]`). `k` is the activity group key, `s`/`e` season/episode (tv). */
  interface LandedGrab {
    k: string;
    type: Reel.MediaType;
    title: string;
    mediaId: string | null;
    poster: string | null;
    year: number | null;
    s: number | null;
    e: number | null;
  }

  /** A grab that left the feed, waiting for Jellyfin to confirm it (`reel.landedFeed` `awaiting`). */
  interface LandedCandidate extends LandedGrab {
    id: string;
    /** Checks so far (DELAYS index). */
    tries: number;
  }

  /** One "Ready to watch" row in the bell (`reel.landed`, per user, last 10 / 7 days). `eps` are
   * `'<season>x<episode>'` strings (tv), `at` the item's DateCreated in ms. */
  interface LandedEntry {
    key: string;
    /** The Jellyfin item (series for tv) — OK → openItem(id, jfType). */
    id: string;
    jfType: Jf.ItemKind;
    type: Reel.MediaType;
    title: string;
    year: number | null;
    poster: string | null;
    eps: string[];
    at: number;
    seen: boolean;
  }

  /** landed.svelte.js `landed`. */
  interface LandedState {
    items: LandedEntry[];
    /** Keys that were unseen when the menu was opened. */
    fresh: string[];
  }

  /* ---------- remaining src/lib modules (T17) ---------- */

  /** reconnect.js onReconnect() subscriber: why it fired ('visible' passes the ms spent hidden).
   * May return a promise (its rejection is swallowed). */
  type ReconnectFn = (why: 'online' | 'visible' | 'tick', away?: number) => any;

  /** What searchrank.js rankLookup() reads of a lookup result. */
  type RankItem = Pick<Reel.LookupResult, 'title' | 'year' | 'added'> & Partial<Pick<Reel.LookupResult, 'votes' | 'original_title'>>;

  /** nav.svelte.js detail → detail back stack: a page left for another detail page, with the
   * element focus was on (Back re-opens it there). */
  type TrailEntry =
    | { screen: 'detail'; id: NavState['detailId']; type: NavState['detailType']; focus: string | null }
    | { screen: 'person'; id: NavState['personId']; name: string; focus: string | null }
    | { screen: 'lookup'; item: NavState['lookup']; focus: string | null };

  /** segments.js: a window passes (returned, possibly the same object) or fails (null) a sanity check. */
  type SegmentCheck = (w: SegmentWindow | null) => SegmentWindow | null;

  /** trackprefs.js: a remembered audio choice, by meaning — the language key, never a stream index. */
  interface AudioPref {
    lang: string;
  }

  /** trackprefs.js: a remembered subtitle choice — `{ off: true }`, or by meaning
   * `{ lang, forced, sdh, burn }` (language key + flavour; never a stream index). One shape with
   * optional fields rather than a union: matchSub() tests `pref.off` and then reads the rest inside
   * a filter callback, where a union would not stay narrowed. */
  interface SubPref {
    off?: boolean;
    lang?: string;
    forced?: boolean;
    sdh?: boolean;
    burn?: boolean;
  }

  /** One series' entry in localStorage `reel.trackPrefs.<userId>` (keyed by SeriesId); `t` = last
   * touched (Date.now()), for the 300-series cap. */
  interface TrackPrefEntry {
    a?: AudioPref;
    s?: SubPref;
    t?: number;
  }

  /** One media segment of an HLS playlist on the media timeline (segfeed.js parsePlaylist(),
   * trailerstream.js): seconds from the start, and its URI. */
  interface HlsSegment {
    start: number;
    end: number;
    name: string;
  }

  /** A parsed HLS media playlist. `init` = the #EXT-X-MAP URI (parsePlaylist() only). */
  interface HlsPlaylist {
    segs: HlsSegment[];
    complete: boolean;
    init?: string | null;
  }

  /** createSegFeeder() options (segfeed.js; livefeed.js and phone offline.svelte.js build them).
   * `media`: the <video>, for waking on 'seeking'/'waiting'; `bitrate` (bit/s) sizes the window
   * until segments have been measured. */
  interface SegFeederOptions {
    prepare: () => Promise<{ codecs: string; duration: number }>;
    playlist: () => Promise<HlsPlaylist>;
    fetchInit: () => Promise<ArrayBuffer | null>;
    fetchSeg: (seg: HlsSegment) => Promise<ArrayBuffer | null>;
    position?: (() => number) | null;
    jump?: ((t: number) => void) | null;
    onFail?: ((e: ApiError) => void) | null;
    media?: HTMLMediaElement | null;
    bitrate?: number;
    preloadS?: number;
    aheadS?: number;
    behindS?: number;
    pollMs?: number;
  }

  /** homehide.js (localStorage `reel.homeHidden.<userId>`): Continue Watching item id → the
   * LastPlayedDate stamp it was hidden at; Next Up series id → the episode id hidden. */
  interface HomeHidden {
    cw: Record<string, string>;
    nu: Record<string, string>;
  }

  /** Tile.svelte `kind`: Continue Watching, Next Up (landscape), or any other rail/grid. */
  type TileKind = 'cw' | 'nextup' | 'added';

  /** What a LookupTile shows: any lookup-shaped result — a search hit (Reel.LookupResult), a
   * trending tile (Reel.TrendingItem), a chart entry (Reel.ChartResult) or a collection film
   * (Reel.CollectionMovie). The extras only some of them carry are optional here; LookupTile
   * shows IMDb rating + votes instead of the kind when `rating_votes` is there. */
  type LookupTileItem = Reel.LookupResult & {
    rating?: number | null;
    rating_votes?: number;
    digital_release?: string | null;
    rank?: number;
  };

  /* ================= api.js / medialib.js options (T09) ================= */

  /** api() options (src/lib/api.js). A parked prefetch only stands in for a plain GET: any
   * `body`, a non-GET `method` or a `signal` makes the exact request go out. */
  interface ApiOptions {
    /** HTTP method, default 'GET'. */
    method?: string;
    /** JSON-encoded by api() (sets Content-Type: application/json). */
    body?: unknown;
    /** The caller's own deadline/cancel; without one api() applies its 30 s timeout. */
    signal?: AbortSignal;
    /** fetch keepalive: the request outlives a frozen page (suspendPlayback()); no timeout then. */
    keepalive?: boolean;
  }

  /** mlFetch() options (src/lib/medialib.js, private). */
  interface MlOptions {
    /** Wait out one 503's Retry-After (≤ 60 s) and try again once. */
    retryOn503?: boolean;
    /** HTTP method, default 'GET'. */
    method?: string;
    /** JSON-encoded request body. */
    body?: unknown;
    /** The caller's cancel, combined with mlFetch's 30 s deadline. */
    signal?: AbortSignal;
  }

  /** One entry of api.js's SWR store (`cached()` / `revalidate()`; phone Home snapshot via
   * `storeEntries()` / `seedStore()`). `at` = Date.now() when it was answered. */
  interface StoreEntry {
    at: number;
    data: any;
  }

  /** An element whose ancestors the code looks up are HTML elements: closest(selector) answers
   * HTMLElement (for `.dataset`, `.hidden`, `.offsetTop` …) instead of the DOM typings' Element.
   * The override comes first in the intersection, so it wins overload resolution; any `E` is
   * assignable to it (for `bind:this`), since Element's own closest<E>() is generic. */
  type HtmlClosest<E extends Element = HTMLElement> = { closest(selectors: string): HTMLElement | null } & E;

  /** An element whose inline style the code writes numbers into (`el.style.opacity = 0.5` —
   * the CSSOM stringifies them). Splash.svelte's rAF draw does that for every frame; the DOM
   * typings only take strings. An HTMLElement is assignable to it (for `bind:this`). */
  type NumStyled = Omit<HTMLElement, 'style'> & {
    style: { [K in keyof CSSStyleDeclaration]: CSSStyleDeclaration[K] extends string ? string | number : CSSStyleDeclaration[K] };
  };

  /** imgUrl() options (src/lib/api.js): `id` overrides the item's Id; `w` sets maxWidth, else
   * `h` (default 480) sets maxHeight; ≥ 1280 wide or ≥ 1080 high uses quality 80, else 85. */
  /** What imgUrl() reads off an item: its own tags, then the parent backdrop/thumb and the
   * series poster as fallbacks. A partial on purpose — Tile.svelte passes just
   * `{ SeriesId, SeriesPrimaryImageTag }` for a series poster, the phone player P.item.
   * `Id` may be null: a PlayerItem stub (pending stream / trailer) has `Id: null`, and imgUrl()
   * then falls back to `opts.id` or the parent ids (VideoLayer's loading card). */
  type ImageSource = Partial<Pick<Jf.BaseItemDto, 'ImageTags' | 'BackdropImageTags' | 'ParentBackdropImageTags'
    | 'ParentBackdropItemId' | 'ParentThumbImageTag' | 'ParentThumbItemId' | 'SeriesPrimaryImageTag' | 'SeriesId'>> & {
    Id?: string | null;
  };

  interface ImgOptions {
    id?: string;
    w?: number;
    h?: number;
  }
}

