/* Phone-only persisted state and module payloads (phone/src/lib): the offline downloads index
 * and manifest, the Home snapshot, the route restore payload, the freshness markers.
 * Type-only — nothing here reaches a bundle. */

declare namespace VR {
  /* ================= offline downloads (phone/src/lib/offline.svelte.js) ================= */

  /** Where a download is. 'downloading' is only ever the one entry pump() runs; loadIndex()
   * turns a saved 'downloading' back into 'queued'. */
  type OfflineStatus = 'queued' | 'downloading' | 'paused' | 'done' | 'error';

  /** A download's quality: a cap in bit/s (QUALITY_CAPS) or 'original'. */
  type OfflineQuality = number | 'original';

  /** The Jellyfin image URLs a download keeps (imgsOf()): the poster (a series' for an episode),
   * the episode's own still, a backdrop. Copies started by an older build may only have `art`. */
  interface OfflineImages {
    poster?: string | null;
    still?: string | null;
    art?: string | null;
  }

  /** One entry of the offline index (localStorage `reel.offline`) — one per account + item.
   * `dir` = `<userId>.<itemId>` (absent on entries from before per-account keys: dirOf() falls
   * back to the bare item id); `sweep` = folders to empty before the first segment (null once
   * done); `done`/`total` = segments; `bytes` fetched, `est` estimated; `added`/`posAt` ms
   * timestamps; `pos`/`dur` seconds; `sync` = a position still to send as UserData; `pics` is
   * bumped whenever artwork lands in the cache (the Downloads list re-reads it). */
  interface OfflineEntry {
    id: string;
    user: string;
    dir?: string;
    sweep?: string[] | null;
    type: Jf.ItemKind | string;
    title: string;
    line: string;
    series: string | null;
    seriesId: string | null;
    img?: OfflineImages | null;
    pics?: number;
    quality: OfflineQuality;
    state: OfflineStatus;
    error: string | null;
    done: number;
    total: number;
    bytes: number;
    est: number;
    added: number;
    pos: number;
    dur: number;
    posAt: number;
    sync: boolean;
    played?: boolean;
  }

  /** offline.svelte.js `OFF`: the index plus the origin's storage estimate (bytes; null when
   * the browser won't say) and whether the storage is persistent. */
  interface OfflineState {
    list: OfflineEntry[];
    usage: number | null;
    quota: number | null;
    persisted: boolean | null;
  }

  /** A text subtitle a download saves as VTT (`sub<index>` in its folder). */
  interface OfflineSub {
    index: number;
    url: string;
    lang: string | null | undefined;
    title: string;
    forced: boolean;
  }

  /** A segment of the download's HLS playlist, absolute URL. */
  interface OfflineSeg {
    start: number;
    end: number;
    url: string;
  }

  /** The `manifest` file in a download's folder — resolve()'s answer, plus `play` (the codec
   * string pickCodecs() chose once the init segment was read). `item` is a trimmed
   * BaseItemDto, `source` a synthetic media source (video + the one audio + the VTT subs);
   * `session`/`dlDevice` name the Jellyfin job stopJob() ends. `art` only on copies from an
   * older build (fetchOnce() turns it into `img`). */
  interface OfflineManifest {
    v: 1;
    item: Pick<Jf.BaseItemDto, 'Id' | 'Name' | 'Type' | 'SeriesName' | 'SeriesId' | 'ParentIndexNumber'
      | 'IndexNumber' | 'ProductionYear' | 'RunTimeTicks' | 'Genres' | 'Overview'>;
    source: PlayerSource & { MediaStreams: PlayerStream[] };
    audioIndex: number;
    codecs: string;
    supp: string;
    duration: number;
    init: string;
    segs: OfflineSeg[];
    subs: OfflineSub[];
    session: string;
    dlDevice: string;
    play?: string;
    art?: string;
  }
}

declare namespace VR {
  /* ================= Home snapshot (phone/src/lib/homesnap.svelte.js) ================= */

  /** The two Trending lists Home shows (reel-api /api/trending?type=…), by media type. */
  type HomeTrend = Partial<Record<Reel.MediaType, Reel.TrendingItem[]>>;

  /** localStorage `reel.homeSnap.<userId>`: api.js SWR store entries for Home's rail paths,
   * their items trimmed to KEEP/UD/HASH_TYPES (no MediaSources: nothing plays from a snapshot),
   * plus Trending — left out when the whole thing would exceed CAP. `at` = ms timestamp. */
  interface HomeSnapshot {
    v: 1;
    at: number;
    entries: Array<[string, StoreEntry]>;
    trend?: HomeTrend;
  }

  /** homesnap.svelte.js `homeSnap`. */
  interface HomeSnapState {
    /** Home has painted content this session (live or from the snapshot). */
    shown: boolean;
  }
}

declare namespace VR {
  /* ================= route restore (phone/src/lib/restore.svelte.js) ================= */

  /** One saved route above a tab's root: `y` = its page's `.screen` scrollTop. */
  interface SavedRoute {
    name: RouteName;
    params: RouteParams;
    y: number;
  }

  /** A tab's saved stack: `y0` = the root page's scrollTop, `routes` = the last DEPTH routes
   * above the root that RESTORABLE accepts. */
  interface SavedStack {
    y0: number;
    routes: SavedRoute[];
  }

  /** localStorage `reel.route` (saveRoute()): `user` = the account it belongs to, `at` = ms
   * timestamp, `closed` = when a `pagehide` marked it a quit (absent otherwise). Only tabs with
   * something to restore have a `stacks` entry. */
  interface RouteSnapshot {
    v: 1;
    user: string;
    at: number;
    tab: TabName;
    stacks: Partial<Record<TabName, SavedStack>>;
    closed?: number;
  }
}

declare namespace VR {
  /* ================= small phone state modules ================= */

  /** confirm() options (phone/src/lib/confirm.svelte.js). */
  interface ConfirmOptions {
    title?: string;
    message?: string;
    /** The confirming button's label. */
    action?: string;
    /** Draw the action red (default true). */
    danger?: boolean;
    cancel?: string;
  }

  /** `CONFIRM.req`: the open question ActionSheet renders; resolve(true) = confirmed. */
  interface ConfirmRequest extends Required<ConfirmOptions> {
    id: number;
    resolve: (v: unknown) => void;
  }

  /** confirm.svelte.js `CONFIRM`. */
  interface ConfirmState {
    req: ConfirmRequest | null;
  }

  /** conn.svelte.js `conn`: the offline banner's state. */
  interface ConnState {
    offline: boolean;
    checking: boolean;
  }

  /** Why swupdate.js reloads into a new build (its onBeforeUpdateReload hooks get it). */
  type UpdateReloadReason = 'idle' | 'hidden';
}

declare namespace VR {
  /* ================= push (phone/src/lib/push.js) ================= */

  /** What a push turns on: `ready` = "Ready to watch", `seasons` = new seasons. */
  type PushKind = 'ready' | 'seasons';

  /** localStorage `reel.push`: the kinds this device asked for. */
  type PushPrefs = Record<PushKind, boolean>;

  /** pushSupport(): 'browser' = an iOS Safari tab (push needs the Home Screen app). */
  type PushSupport = 'ok' | 'browser' | 'unsupported';

  /** A notification tap's target — sw.js posts `{ type: 'vr-open', open }`, or the cold start's
   * `?open=<type>:<id>` (`item` with `itemType` = the Jellyfin Type). */
  interface PushOpen {
    type: 'item' | 'bell' | 'home';
    id?: string;
    itemType?: string;
  }
}

declare namespace VR {
  /* ================= freshness (phone/src/lib/freshness.svelte.js) ================= */

  /** What onLibraryChange() subscribers get: `movie`/`tv` = something of that kind was added
   * or removed; `played` = an item's watched state changed or another item was played last
   * (`type` = that item's kind); `progress` = only the last played item's position moved. */
  interface LibraryChange {
    movie: boolean;
    tv: boolean;
    played: boolean;
    progress: boolean;
    type: Reel.MediaType | null;
  }

  /** The last answer's markers (`count:newestId`, `id:played:playCount`, `id:ticks:date`). */
  interface FreshnessSig {
    movie: string;
    tv: string;
    played: string;
    pos: string;
  }
}

declare namespace VR {
  /* ================= motion (phone/src/lib/safe.js) ================= */

  /** A JS easing: 0…1 time → progress. */
  type Easing = (t: number) => number;

  /** spring() / fling(): `duration` ms and 21 linear keyframe samples (`p` = progress 0 → 1),
   * run with easing: 'linear'; spring() adds `at(t)`, the same curve over 0…1 time. */
  interface SpringCurve {
    duration: number;
    frames: Array<{ offset: number; p: number }>;
    at?: Easing;
  }

  /** safeInsets(): the resolved safe-area insets, px. */
  interface Insets {
    top: number;
    right: number;
    bottom: number;
    left: number;
  }
}

declare namespace VR {
  /* ================= gestures (phone/src/lib/gestures.js) ================= */

  /** `use:longpress={fn | opts}` (`duration` ms, `tolerance` px). */
  interface LongPressOptions {
    onlongpress?: ((d: LongPressDetail) => void) | null;
    duration?: number;
    tolerance?: number;
    disabled?: boolean;
  }

  /** What edgeSwipeBack's `drag()` may return instead of the plain slide (zoom.js zoomDrag()):
   * `paint(dx, dy)` per move; `end(done, then, v)` settles (v = release speed, px/ms) and must
   * call `then` once; `threshold` = the fraction of the width the projected release must pass. */
  interface SwipeDragController {
    threshold?: number;
    paint(dx: number, dy: number): void;
    end(done: boolean, then: () => void, v?: number): void;
  }

  /** `use:edgeSwipeBack` callbacks (App.svelte's `swipe`); see gestures.js. `edge` = px from the
   * left edge a swipe may start in (default 20). */
  interface EdgeSwipeOptions {
    enabled?: () => boolean;
    top?: () => HTMLElement | null | undefined;
    beneath?: () => HTMLElement | null | undefined;
    shadow?: () => HTMLElement | null | undefined;
    reveal?: (on: boolean) => void;
    grab?: (top: HTMLElement, beneath: HTMLElement) => number | null | undefined;
    commit?: () => void;
    drag?: (top: HTMLElement, beneath: HTMLElement) => SwipeDragController | null | undefined;
    edge?: number;
  }

  /** doubleTap's detail (and the `singletap` / `doubletap` CustomEvents'): `count` 1 for a
   * single tap, 2, 3, … through a run; `side` = which half of the node. */
  interface TapDetail {
    x: number;
    y: number;
    count: number;
    side: 'left' | 'right';
  }

  /** `use:doubleTap` options (`delay` ms, `slop` px). */
  interface DoubleTapOptions {
    onsingle?: (d: TapDetail) => void;
    ondouble?: (d: TapDetail) => void;
    delay?: number;
    slop?: number;
  }

  /** `use:scrollPast` options: onchange(true) once scrollTop passes `y` (default 40). */
  interface ScrollPastOptions {
    y?: number;
    onchange?: (past: boolean) => void;
  }
}

declare namespace VR {
  /* ================= tile zoom (phone/src/lib/zoom.js) ================= */

  /** Where a pushed page was opened from: the tapped `.tile` / `.cast`, its image URL (to find
   * it again after a re-render) and whether it is a cast photo. */
  interface ZoomOrigin {
    el: Element;
    src: string;
    cast: boolean;
  }

  /** The stage box (the routes' parent), viewport px. */
  interface ZoomBox {
    left: number;
    top: number;
    W: number;
    H: number;
  }

  interface ZoomRect {
    x: number;
    y: number;
    w: number;
    h: number;
  }

  /** frameRect(): a tile's art frame in stage coordinates, its corner radius and the frame. */
  interface ZoomFrame extends ZoomRect {
    r: number;
    f: HTMLElement;
  }

  /** findTile(): the frame plus the tile it belongs to. */
  interface ZoomTile extends ZoomFrame {
    el: Element;
  }

  /** targetOf(): the page's hero (the art's destination) in the route's coordinates. */
  interface ZoomTarget extends ZoomRect {
    el: Element;
    r: number;
    hero: boolean;
    empty: boolean;
  }

  /** A geometry state: C = the card on screen, r its radius; A = the hero rect, ar its radius;
   * k = how much the art is "the whole card" (1 = the tile); dim = the page underneath. */
  interface ZoomState {
    C: ZoomRect;
    r: number;
    A: ZoomRect | null;
    ar: number;
    k: number;
    dim: number;
  }

  /** The non-geometric channels (opacities 0…1): content, NavBar, hero scrim, the tile's poster
   * copy, the backdrop copy (null: none). */
  interface ZoomChannels {
    content: number;
    nav: number;
    scrim: number;
    po: number;
    bd?: number | null;
  }

  /** One keyframe sample: time 0…1, the state, the art rect it shows, the channels (partial:
   * zoomDrag()'s cancel settle animates only the route's geometry and passes none). */
  interface ZoomSample {
    t: number;
    g: ZoomState;
    art: { A: ZoomRect; ar: number };
    c: Partial<ZoomChannels>;
  }

  /** makeOverlay(): the shared-element overlay and the tile poster copy (pw × ph). */
  interface ZoomOverlay {
    ov: HTMLDivElement;
    clip: HTMLDivElement;
    poster: HTMLDivElement | null;
    pw: number;
    ph: number;
  }

  /** addBackdrop(): the copy of the page's backdrop, bw × bh. */
  interface ZoomBackdrop {
    el: HTMLImageElement;
    bw: number;
    bh: number;
  }

  /** What animateAll() animates. */
  interface ZoomParts {
    route: HTMLElement;
    under?: HTMLElement | null;
    o?: ZoomOverlay;
    scrim?: HTMLDivElement | null;
    tg?: ZoomTarget | null;
    bd?: ZoomBackdrop | null;
  }

  /** How a running zoom-in ends: 'cut' at once, 'swap' (the real hero shows the same image),
   * 'fade' (the real hero fades in over the overlay). */
  type ZoomStop = 'cut' | 'swap' | 'fade';

  /** A zoom-in in flight (zoom.js `running`): now() = where the card is, for a pop that
   * interrupts it. */
  interface ZoomRun {
    now(): { g: ZoomState; c: ZoomChannels; bdSrc: string; scroll: number; landed: boolean };
    stop(how?: ZoomStop): void;
  }

  /** zoomIn() / zoomDrag() arguments: the pushed route, the page under it, its route key;
   * `done` runs once the geometry has landed. */
  interface ZoomArgs {
    route: HTMLElement | null | undefined;
    under: HTMLElement | null | undefined;
    key: string;
    done?: () => unknown;
  }

  /** zoomOut(): `start` = where an edge-swipe drag holds the card; `easing` replaces the sheet
   * curve (the swipe's release spring). */
  interface ZoomOutArgs extends ZoomArgs {
    start?: { g?: ZoomState; tg?: ZoomTarget | null; c?: ZoomChannels } | null;
    dur?: number;
    easing?: Easing;
  }
}

declare namespace VR {
  /* ================= Home hero carousel (phone/src/lib/carousel.js) ================= */

  /** What carousel.js reaches through `node.__carousel` (the attached HeroCarousel). */
  interface HeroCarouselLike {
    busy: boolean;
    anim: object | null;
    frame(): void;
    focusIn(m: HeroMedia, instant: boolean): void;
  }

  /** The hero element HeroCarousel.attach() runs on (`__carousel`: scripted checks, heroArt). */
  type HeroNode = HTMLElement & { __carousel?: HeroCarouselLike };

  /** A `.homehero__media` slide and the expando state carousel.js keeps on it: `__r` its focus
   * readiness 0…1, `__fi` a running focus-in, `__fiBlur` whether that focus-in uses the blurred
   * copies, `__blurred`/`__blurOf` the copies are drawn (from which small rendition),
   * `__blurUrl` the small rendition to draw them from, `__failed` the backdrop didn't load. */
  type HeroMedia = HTMLElement & {
    __r?: number;
    __fi?: { t0: number; dur: number };
    __fiBlur?: boolean;
    __blurred?: boolean;
    __blurOf?: string | null;
    __blurUrl?: string | null;
    __failed?: boolean;
  };

  /** The blurhash canvas of a slide; `__drawn` once a hash is painted. */
  type HeroHashCanvas = HTMLCanvasElement & { __drawn?: boolean };

  /** `use:heroArt` argument: the backdrop URL, its small rendition for the blurred copies, the
   * blurhash. */
  interface HeroArt {
    url?: string | null;
    blur?: string | null;
    hash?: string | null;
  }

  /** A queued blurred-copy job (carousel.js `jobs`): the small rendition's URL, the decoded
   * source to draw from (`big` = the full image, the fallback), which canvas is next, whether
   * a waiter is in a hurry, and the whenBlurred() resolvers. */
  interface HeroBlurJob {
    url: string | null | undefined;
    src: HTMLImageElement | null;
    big: HTMLImageElement | null;
    fail: boolean;
    step: number;
    urgent: boolean;
    waiters: Array<(v?: unknown) => void>;
  }

  /** Home.svelte: the four Jellyfin rails (the keys of its `U` path map). */
  type HomeRailKey = 'resume' | 'nextup' | 'movies' | 'shows';

  /** One rail's answer: `/Items/Latest` (movies, shows) answers a bare array, the others a QueryResult
   * (or api.js `empty()`'s `{ Items: [] }` stand-in). */
  type HomeRailAnswer = Jf.QueryResult<Jf.BaseItemDto> | { Items: Jf.BaseItemDto[] } | Jf.BaseItemDto[];

  /** Home.svelte `lastRaw`: the unfiltered server answers paint() renders from (removals / undo repaint).
   * resume/nextup may be api.js `empty()` (`{ Items: [] }`) on a snapshot paint; movies/shows are
   * `cached()`'s null when the snapshot has no copy (paint() reads them through `arr()`). */
  interface HomeRaw {
    resume?: Jf.QueryResult<Jf.BaseItemDto> | { Items: Jf.BaseItemDto[] };
    nextup?: Jf.QueryResult<Jf.BaseItemDto> | { Items: Jf.BaseItemDto[] };
    movies?: HomeRailAnswer | null;
    shows?: HomeRailAnswer | null;
  }

  /** Home.svelte hero slide: an in-progress item ('cw') or something new in the library ('new'). */
  interface HomeSlide {
    it: Jf.BaseItemDto;
    kind: string;
  }
}
