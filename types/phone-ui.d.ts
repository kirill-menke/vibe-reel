/* Phone UI shapes: the props of phone/src/components (the shared "design system" the phone
 * screens are built from) and the gesture details they hand back. Global namespace `VR`,
 * merged with types/app.d.ts. Type-only: nothing here reaches a bundle. */

declare namespace VR {
  /** A Svelte 5 snippet prop (`{#snippet}` passed to a component, `{@render x?.()}` inside). */
  type Snip<A extends unknown[] = []> = import('svelte').Snippet<A>;

  /** A Svelte transition function as `in:` / `out:` / `transition:` call it — a module-level
   * `function grow() {…}` that ignores its arguments still has to accept them. */
  /** The phone player's track picker tabs (TrackPanel `initial`, Player `trackTab`). */
  type TrackTab = 'audio' | 'subs' | 'quality';

  type TransitionFn = (node: Element, params?: any, options?: { direction: 'in' | 'out' | 'both' }) =>
    import('svelte/transition').TransitionConfig | (() => import('svelte/transition').TransitionConfig);

  /** `use:longpress` detail (phone/src/lib/gestures.js): where the finger was, the held
   * node's rect at that moment (ContextMenu's `rect`; pressSource(rect) maps it back to the
   * node) and the node itself. Also the `longpress` CustomEvent's detail. */
  interface LongPressDetail {
    x: number;
    y: number;
    rect: DOMRect;
    node: HTMLElement;
  }

  /** What `...rest` forwards onto a component's root element (Row, Button, Icon): aria-*,
   * data-* and the few plain attributes the screens pass. */
  interface RestAttrs {
    [attr: `aria-${string}`]: any;
    [attr: `data-${string}`]: any;
    role?: string;
    id?: string;
    tabindex?: number;
    style?: string;
    disabled?: boolean;
  }

  /** Tile `badge` (phone/src/components/Tile.svelte): a plain string is a glass badge. */
  type TileBadge = string | {
    text: string;
    kind?: '' | 'gold' | 'outline';
    icon?: string;
    /** bottom-left instead of top-left */
    bottom?: boolean;
  };

  /** Tile `download` / EpisodeRow `dl`: dimmed art + ring with % (downloading) or a clock
   * (queued); `sub` replaces the tile caption's sub line. */
  interface TileDownload {
    status: string;
    p?: number;
    sub?: string;
  }

  /** ContextMenu `items` entry: an action, a section break (`sep`, drawn only before a
   * danger item) or a centred caption (`title` + `label`). One interface with optional
   * fields, not a union: the menu reads every field off every entry. */
  /** A screen's long-press menu state (Downloads, PendingDetail), handed to ContextMenu. */
  interface CtxMenuState {
    open: boolean;
    rect: DOMRect | null;
    items: CtxItem[];
    label: string;
  }

  interface CtxItem {
    label?: string;
    icon?: string;
    danger?: boolean;
    action?: () => any;
    disabled?: boolean;
    sep?: boolean;
    title?: boolean;
  }

  /** Segmented `options` entry (or a plain string = value and label). */
  type SegOption = string | { value: any; label: string };

  /** SeasonPills `pills` entry. */
  interface SeasonPill {
    key: string;
    label: string;
    active?: boolean;
    watched?: boolean;
    dim?: boolean;
    /** 0–1 download progress of the season (ring on the pill) */
    pct?: number | null;
  }

  /** ActionBar `actions` entry (falsy entries are skipped). */
  interface BarAction {
    /** stable key: the label may change under the finger without the button being recreated */
    id: string;
    icon: string;
    label: string;
    on?: boolean;
    onclick?: (e: MouseEvent) => any;
    busy?: boolean;
    /** 0–1: a download in progress (may be a getter, so only the ring follows it) */
    p?: number | null;
  }

  /** A title page's eyebrow badge (LookupDetail / PendingDetail): Badge `kind`, `icon`, `text`. */
  interface Eyebrow {
    text: string;
    kind?: '' | 'gold' | 'outline';
    icon: string;
  }

  /** statusParts() (phone/src/components/detail/detail.js): StatusButton's `s`. */
  interface StatusParts {
    pct: string;
    rate?: string;
    eta?: string;
    rest: string;
    p: number;
  }

  /** Sheet.svelte followSheet(f): the page card behind a large hosted sheet follows the drag
   * (App.svelte registers it). `p` = 1 − dy / height. */
  interface SheetFollower {
    grab(): void;
    paint(p: number): void;
    settle(frames: Array<{ offset: number; p: number }>, opts: KeyframeAnimationOptions, skip: number): void;
  }

  /** Sheet.svelte's drag-to-dismiss state `d`. */
  interface SheetDrag {
    y0: number;
    dy: number;
    v: number;
    lastY: number;
    lastT: number;
    fromBody: boolean;
    live: boolean;
    /** the sheet's height once the drag went live (0 before) */
    h: number;
    scrim: HTMLElement | null;
    follow: SheetFollower | null;
  }

  /** One `.tech` chip of TechBadges (detail.js techBadges() / releaseBadges()). */
  type TechBadge = string | { label: string; strong?: boolean };

  /** One row of a title page's details list (detail.js detailRows()): one value or several lines. */
  interface DetailRow {
    k: string;
    v?: string;
    lines?: string[];
  }

  /** detail.js slowLink(): the slow-link hint. `capped` = the stream runs at the quality cap. */
  interface SlowLinkHint {
    need: number;
    got: number;
    capped: boolean;
  }

  /** Chart.svelte libIndex(): one library title with its name folded for Search's instant matches. */
  interface LibName {
    jf: Jf.BaseItemDto;
    /** fold(Name) */
    n: string;
    /** `n` without a leading article */
    bare: string;
    words: string[];
    /** `n` without spaces */
    flat: string;
  }

  /** Chart.svelte libIndex(type): provider id (tvdb / tmdb) → Jellyfin item, `sig` = what a tile shows
   * (an unchanged re-read resolves to the same object), `names()` built on first use. */
  interface LibIndex {
    byId: Map<string, Jf.BaseItemDto>;
    sig: string;
    names: () => LibName[];
  }

  /** Chart.svelte resultTile(): Tile props for a lookup / chart result — the Jellyfin item when the
   * library has it (+ count / badge for grabs in flight), else the lookup's poster + add state. */
  interface ResultTile {
    item?: Jf.BaseItemDto;
    title?: string;
    sub?: string;
    img?: string | null;
    count?: number;
    badge?: TileBadge;
    watched?: boolean;
    progress?: number;
    download?: TileDownload | null;
    addState?: AddState | null;
    onadd?: (() => any) | null;
  }
}
