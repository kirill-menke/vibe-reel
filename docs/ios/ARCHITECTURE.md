# VibeReel Phone (iPhone PWA) — architecture contract

This is the coordination contract for everyone building the phone app. Read it fully before
touching code. If you must change a contract here, edit this file in the same change and say so
in your report.

Design source of truth: `docs/ios/vibereel-iphone/` (`SPEC.md`, `tokens.css`, `components.css`,
`screens/*.html`, `icons/*.svg`). Open the screen HTML for anything you build and match it.
Project conventions: the TV app's `src/lib` (api(), the async/epoch patterns, the player engine).

## Decisions already made (don't reopen)

- **Playback on iPhone = Jellyfin HLS remux** (fMP4): video stream copied, audio copied when
  Safari can take it (AAC, AC3, E-AC3, FLAC, ALAC, MP3, Opus), otherwise converted by Jellyfin
  (TrueHD/DTS → E-AC3 or AAC). VobSub/DVB still burn in (then video is transcoded — as on TV).
  The TV's no-transcode device profile is untouched. The *Streaming quality* cap (Settings and
  the player's Quality picker, one per-device setting: Original / 8 / 4 Mbit/s — iOS can't tell
  cellular from Wi-Fi, so it applies everywhere) makes Jellyfin re-encode files above it:
  H.264 boxed to 1080p / 720p, HDR tone-mapped to SDR, AAC stereo at 4 Mbit/s
  (`PHONE_CAP_BOX` in `tracks.js`; measured in `MEDIA-TEST.md` → "Quality cap").
- **Hosting**: one HTTPS origin on the NAS via `tailscale serve` — **https://nas.&lt;tailnet&gt;.ts.net:9443/**
  (optional LAN http fallback, no service worker there; deploy: `phone/deploy.sh`;
  details and the tested iOS device profile: `docs/ios/MEDIA-TEST.md`):
  `/` → the built PWA (`phone/dist`), `/jf` → Jellyfin `127.0.0.1:8096`, `/ml` → reel-api
  `127.0.0.1:8790` (path prefix stripped by the proxy). So on the phone
  `cfg.server = location.origin + '/jf'`, `cfg.medialib = location.origin + '/ml'`.
  Dev: Vite proxies `/jf` → `VITE_JELLYFIN_URL` and `/ml` → `VITE_MEDIALIB_URL` (repo-root `.env.local`).
  Jellyfin returns root-relative URLs (e.g. `TranscodingUrl`) — always prefix with `cfg.server`.
- **Custom player**, not the native fullscreen one (PGS canvas, skip chip, Up Next, trickplay).
  PiP / AirPlay via the `<video>` element's WebKit APIs.
- **Same repo, shared `src/lib`**. The phone app lives in `phone/` and imports the TV's
  framework-free logic directly. It does **not** use `focus.js`, `Keys.svelte`, `lifecycle.js`,
  the picture-mode service, `Splash`, or any TV component/screen.
- **Undo / cancel** (reel-api endpoints added 2026-09-30): Undo after adding a title
  (`addToLibrary` → `undoAdd`, `mlLibraryUndo` with the add's token), Undo after *Get* in the bell
  (`getSeason` → `undoGetSeason`, `mlSeasonSearchUndo`) — both only `if (__PHONE__)`, the TV has no
  undo there — and *Cancel download* (`src/lib/cancel.svelte.js`, `mlCancelDownload`): long-press
  a downloading/queued episode row (SeriesDetail, PendingDetail), a pending tile (Library) or
  PendingDetail's *Cancel* action → confirm menu. A torrent goes as a whole (a season pack is
  every episode in it); the confirm says so. Everything else in SPEC.md is in scope, including
  the settings (they already exist in `src/lib/settings.svelte.js`: `autoplayNext`,
  `autoSkipIntro`, `autoSkipRecap`, `subMode`, `audioLang`, `subLang`, `subSize`).
- **Timings follow the engine, not the mock**: stall ring 2 s, "Buffering…" +3 s, stall card 30 s,
  Up Next in the last 20 s when there is no credits marker.
- **No web font from Google at runtime**: Instrument Serif is self-hosted (`phone/public/fonts/`).
- **Design asset bug**: `docs/ios/vibereel-iphone/icons/home.svg` is corrupt (bell markup + a chunk
  of the gallery page); `phone/scripts/icons.mjs` overrides `home` with the tab bar's glyph.

## Layout

```
phone/
  index.html            viewport-fit=cover, theme-color, apple-touch-icon, manifest link
  vite.config.js        root = phone/, outDir phone/dist, target safari17 (iOS 17+)
  public/               manifest.webmanifest, icons, splash/ (launch screens), fonts/, sw.js
  src/
    main.js             imports styles, starts swupdate/badge/lifecycle/push/offline, mounts App
    App.svelte          shell: tab stacks, sheets, player modal, toast, offline banner
    styles/
      tokens.css        = design tokens.css (verbatim, font @font-face added)
      components.css    = design components.css minus section 18 (device frame)
      app.css           shell-level additions (foundation)
      home.css library.css detail.css player.css   one per workstream — add yours there
    lib/
      nav.svelte.js     REPLACES src/lib/nav.svelte.js for the phone build (see "Module redirects")
      focus-shim.js     REPLACES src/lib/focus.js (no-ops)
      lifecycle.js      REPLACES src/lib/lifecycle.js (phone lifecycle)
      router.svelte.js  tab stacks, push/pop, sheets, scroll memory
      gestures.js       longpress, edge-swipe back, double-tap actions
      freshness.svelte.js  automatic refresh: server change markers → onLibraryChange (no pull-to-refresh)
      icons.js          the design's icons as {name: {svg, fill}} (generated: phone/scripts/icons.mjs)
      conn.svelte.js    server reachability for the offline banner (conn, checkServer, noteError)
      homesnap.svelte.js  Home's last-session snapshot (seeds api.js's store via its __PHONE__-only
                        seedStore/storeEntries) — Home paints before its first frame, online or off
      blurhash.js       Jellyfin ImageBlurHashes → average colour / 32×18 canvas (hero, tile tints)
      safe.js           safeInsets(), reducedMotion(), EASE curves, bezier()/easeSheet
      devlogin.js       dev only: /?devlogin signs in from the dev server's /__devcreds
      swupdate.js       SW registration + update policy (apply only while hidden / idle at a tab root)
      restore.svelte.js route/scroll snapshot on hide, restored before the first mount (PWA-05)
      badge.svelte.js   app icon badge = the bell's unseen count (Badging API)
    components/         shared primitives (foundation owns): Icon, Art, Tile, Rail, Grid,
                        TabBar, TopBar, NavBar, Sheet, ContextMenu, Toast, StateMessage,
                        LoadError, Skeleton, Button, ProgressBar, ProgressRing, Badge,
                        TechBadges, Switch, Segmented, List/Row, OfflineBanner,
                        Avatar, Art (+ PagePlaceholder, scaffolding only)
    screens/            Login (foundation), Home (B), Library, Search, Chart (C),
                        MovieDetail, SeriesDetail, LookupDetail, PendingDetail, Person (D)
    sheets/             Accounts, Notifications, Settings (B); SortFilter (C)
    player/             Player.svelte + parts (engine/player workstream)
```

Shared node_modules at the repo root. Build: `npx vite build --config phone/vite.config.js`.
Dev: `npx vite --config phone/vite.config.js --port <yours>` (see ports below).

## Shell: launch, updates, icon badge

- **Launch screens** (`apple-touch-startup-image`): plain `#0a0a0c` PNGs in `public/splash/`, one per
  iPhone size and orientation, and the `<link>` block in `index.html` between `splash:begin/end` —
  both generated by `phone/make-icons.sh splash` from one table. iOS shows one only when its media
  query matches the device exactly (else white), and reads them at add-to-Home-Screen time: **add a
  table row for every new iPhone screen size**. `index.html` also inlines
  `html,body{background:#0a0a0c}` so the first frame is dark before any stylesheet. The splash
  images are hashed into the SW version but not precached.
- **`sw.js` stamping**: the `sw-precache` plugin stamps the sw.js of the build's *resolved*
  `outDir` (`--outDir /tmp/x` stamps `/tmp/x/sw.js`, never `phone/dist`).
- **Updates never reload under the user** (`lib/swupdate.js`): `reg.update()` on every return to the
  foreground; `controllerchange` only marks the update pending. It is applied on the next trip to
  the background (the app switcher's snapshot hides the reload), or after 60 s without input at a
  tab root with no sheet/modal/focused field/running offline download — never under the player or
  Login. No "new version" prompt. State restore (PWA-05) hooks in via `onBeforeUpdateReload()`.
- **Boot sequence** (PWA-02): `main.js` → `initLifecycle()` → `restoreRoute()` (rebuilds the stacks
  from the snapshot, below — before `initPushLinks()` strips a `?open=` deep link, which wins over
  it) → the rest → `mount(App)`. With a stored token the **shell mounts in the first frame**
  (App's `shell` = `R.booted || (token && userId && R.modal !== 'login')`: stacks, tab bar, edge
  swipe) while `GET /Users/{id}` runs; Home paints from its snapshot meanwhile. `R.booted` (set by
  `markBooted()` when the check passes, or fails for a network reason) still gates the
  activity/news polls, freshness and notification-tap routing, and `S.screen` stays `'boot'`
  until then (so `onAuthLost` ignores the screens' own 401s). A 401/403 → `forgetRoute()`,
  `resetStacks()`, `openLogin()`: the shell unmounts under Login and whoever signs in starts on Home.
- **State restore** (`lib/restore.svelte.js`, PWA-05): on every `visibilitychange → hidden`
  (lifecycle.js) and right before an update reload, `localStorage['reel.route']` =
  `{v, user, at, tab, stacks: {tab: {y0, routes: [{name, params, y}]}}}` — per tab the root's and
  the last 3 routes' `.screen` scrollTop; restorable routes: `detail`, `person`, `lookup`, `chart`,
  `settings`, `downloads` (never the player — the page under it is the stack top —, Login, sheets,
  or `pending`; params > 50 KB are skipped). `pagehide` marks it `closed` (the app was swiped away)
  unless `updateReloading()` or bfcache. At boot it is restored if same user, < 12 h, not
  `closed`, no deep link: all tabs' stacks via `router.restoreStacks()` (only the active tab
  counts as visited — the others mount on first tap), each page's scroll put back on its first
  showing once tall enough (≤ 2.5 s; transitions off meanwhile via `.route.vr-restoring`). One
  `/Items?Ids=` request checks every restored Jellyfin id; a gone item is cut from its stack
  (`cutRoute()`, a Back animation + toast when visible). New route names that should survive a
  restart need an entry in `RESTORABLE` (plain-JSON params only).
- **Icon badge** (`lib/badge.svelte.js`, Badging API; iOS shows it only for the Home Screen app with
  notification permission): unseen "Ready to watch" + unseen new seasons *only if* this device has
  season pushes on. The page stores the count in Cache Storage `vr-badge` → `/__badge`; `sw.js`
  adds one per push while the app sleeps; the page re-sets the true count on every foreground and
  on `vr-changed`. Opening the bell clears it.

## Module redirects (how the shared lib runs on the phone)

`phone/vite.config.js` has a `resolveId` plugin that redirects these files **whatever the import
specifier** (they are imported relatively from inside `src/lib`):

| TV module | Phone replacement |
|---|---|
| `src/lib/nav.svelte.js` | `phone/src/lib/nav.svelte.js` |
| `src/lib/focus.js` | `phone/src/lib/focus-shim.js` |
| `src/lib/lifecycle.js` | `phone/src/lib/lifecycle.js` |

Plus `define: { __PHONE__: true }` (the TV's `vite.config.js` defines `__PHONE__: false`). Use
`__PHONE__` in shared `src/lib` code for the few platform branches (device profile, stream URL,
picture service off, audio switching by restart). Keep TV behaviour byte-for-byte the same when
`__PHONE__` is false. Alias `$lib` → `src/lib`, `$p` → `phone/src` in the phone config.

### The phone `nav.svelte.js` shim

Must export **every name the TV module exports** (shared lib code imports them), with phone
semantics:

- `S` — a `$state` with at least the fields the shared lib reads: `screen` ('player' while the
  player modal is up, otherwise the top route's name), `base`, `epoch`, `detailId`,
  `detailType`, `pendingKey`, `lookup`, `lastPill`, `focusKey`, `ready`. Keep them in sync
  with the router.
- `openItem(id, type)` → push `detail` ({id, type}); `openPerson(id, name)` → push `person`;
  `openLookup(item)` → push `lookup` ({item}); `openPending(key)` → push `pending` ({key});
  `openHome()` / `returnHome()` → switch to the Home tab; `openLibrary(type)` → movies/shows tab;
  `openSearch()` → search tab; `openLogin(adding)` → login modal.
- **While the player modal is up** (`S.screen === 'player'`), an `open*()` whose target equals
  the route already under the modal (the player's exit navigation does this) must **only close
  the modal** — the page underneath is still mounted. Otherwise close the modal, then push.
  After every modal close the router bumps `R.playerClosed` (a counter); detail screens and
  Home watch it to refetch play state (the TV got that by remounting via `S.epoch`).
- `S.epoch` is bumped by every navigation, as on TV (the engine's "did we navigate away while
  awaiting" checks rely on it).
- Focus-memory helpers (`takeGridFocus`, `takeHomeFocus`, `takeDetailFocus`, `peekHomeFocus`)
  return null; `onBack()` pops.

### `router.svelte.js`

- `R` — a class instance with rune fields (reads/writes like a `$state` object):
  `tab: 'home'|'movies'|'shows'|'search'`, `stacks: {tab: Route[]}` (`$state.raw`: replaced,
  never mutated), `sheet: null | {name, params, key}`, `modal: null | 'player' | 'login'`,
  `playerClosed` (counter), plus shell fields: `toTop` (counter, active tab tapped at root — App
  scrolls the top route's `.screen`s itself), `anim` (running push/pop: `{dir, from, to, gone?,
  back?, dur?, replace?}` — `back` marks a pop, `dur` is set by App's `leave()`, `replace` a
  `replace()`), `peek` (route an edge swipe reveals), `booted` (session known good — polls and
  push routing wait for it; the stacks mount before, see "Boot sequence"), `visited` (a tab's pages
  mount on its first visit only — no Movies/Shows/Search fetches at boot).
- `S` (the TV-compatible nav state) is defined in `router.svelte.js` and re-exported by the nav
  shim; `S.screen` has a setter, so the engine's `S.screen = 'player'` / `S.screen = S.base`
  open / close the player modal. `S.base` uses TV vocabulary (`library` for the movies/shows
  roots).
- `Route = { name, params, key }` (key unique per push).
- API: `push(name, params, {animate})`, `pop({animate})`, `popToRoot()`, `switchTab(tab)`
  (active tab again → pop to root; again at root → scroll to top), `openSheet(name, params)`,
  `closeSheet()`, `openPlayer()`, `closePlayer()` (modal only — to END playback call the engine's
  `exitPlayer()`), `replace(name, params)` (swap the top route: pushed over the old page, which
  then leaves the stack — PendingDetail's Open), `top(tab?)`, `beneath(tab?)`, `stack(tab?)`,
  `resetTab(tab)`, `markBooted()`, restore helpers `restoreStacks()`, `cutRoute(tab, key)`,
  `resetStacks()`,
  `openLoginModal(adding)`, `closeLoginModal()`; shell helpers `scrollToTop(scroller)` (smooth,
  stops a fling first — tab re-tap and the bar taps use it), `takeFocus(key)` / `pruneFocus(live)`
  (VoiceOver focus handed back on pop — push() remembers it).
- Every route of every stack stays **mounted**; only the top of the active tab is visible
  (others `hidden`) — scroll position and loaded data survive back navigation for free. During
  an edge-swipe pop the route beneath is revealed and translated. Cap: 10 routes per stack
  (deepest-but-root dropped first).
- **The tab bar belongs to the four roots** (NAV-17, UIKit's `hidesBottomBarWhenPushed`): every
  pushed route is `.route--deep` (`z-index: --z-route-deep`, above `--z-tabbar`, below the
  banner), so a push slides/zooms over the bar and a pop or edge swipe reveals it with the root.
  App draws the bar only while a root is on screen (at rest, in a push from / pop to it, under
  `R.peek`) and makes it inert off-root; deep routes pad to the home indicator (`--page-bottom`),
  and the toast and offline banner drop to the bottom edge there. App's inline route z-indexes
  (leaving page, `replace()` lift) are relative to `--z-route-deep`. The bar's lens can be
  dragged: a horizontal drag anywhere on the bar lifts it under the finger, and the drop switches
  to the tab under it (TabBar.svelte; a drop on the active tab does not pop to root).
- **Transitions are interruptible** (polish NAV-01): App's push/pop start from where the pages
  are (`cur()`), a pop's leaving page is animated by App itself (Svelte's `out:` only keeps it
  alive), durations scale with the distance left (`DUR.push` = `--dur-push`, one token). An edge
  swipe may start mid-push and takes the pages over. Reduce Motion: forward = the new page
  dissolves in, back = only the leaving page dissolves out. A push hands focus to the new page's
  title, a pop back to the tapped element (NAV-09). A programmatic focus target (`tabindex="-1"`)
  never draws a ring (`app.css`); keyboard `:focus-visible` rings stay on real controls.
- A screen is a Svelte component receiving `{ params, active }` props (`active` = it is the
  visible top of the active tab **and** no modal (player/login) covers it). A screen renders its
  header (TopBar/NavBar) as a sibling of its `.screen` scroller; the route wrapper is
  `position:absolute; inset:0`. Screens register in `phone/src/screens/index.js`: `{ name: Component }`. Names:
  `home, movies, shows, search, chart, detail, person, lookup, pending, settings, downloads`.
  `detail` dispatches on `params.type` to MovieDetail / SeriesDetail (like the TV `Detail.svelte`).
- Sheets register the same way in `phone/src/sheets/index.js`: `accounts, notifications,
  sortfilter, offline` (player pickers — the "tracks" panel — are the player's own, not router sheets).
  A sheet receives `{ params }` and renders `components/Sheet.svelte`; App's host adds scrim and
  the present/dismiss animation. Behind a `large` sheet the page recedes into a card (SHT-03):
  `.presenter` wraps the stage, the tab bar and the offline banner and is scaled on the sheet's
  progress; at rest it carries no styles. Overlays that must not scale (scrim, sheet host, player,
  Login, Toast, ContextMenu, ActionSheet) stay outside it. The player's pickers are `<Sheet>`s
  mounted by the player itself (see PHONE-API).
- The player modal: App mounts `$p/player/Player.svelte` once, inside `.playerhost`, and passes
  `open` (= `R.modal === 'player'`). The host is a transparent, click-through box (never
  `hidden`): Player shows and hides its own element, fades it in on open, animates its own closes
  (X, busy-X, Esc, swipe-down) before calling `exitPlayer()`, and keeps itself displayed for a
  ~180 ms fade after an engine-initiated close (polish PLY-01/02). A close from our controls must
  go through Player's `dismiss()`, not `exitPlayer()` directly, or it cuts.
- Every placeholder screen/sheet file says which workstream overwrites it.

## UI rules

- Use the design classes exactly (`.tile`, `.tile--poster`, `.rail`, `.btn--primary`, …). Don't
  invent parallel classes for something components.css already has. New classes go in your
  workstream's CSS file, global BEM-ish names, tokens only.
- Images: `.art > img`, set `src` via `imgUrl()` from `src/lib/api.js`; use
  `use:decoded` (`src/lib/decoded.js`) for backdrops. Posters `loading="lazy"`.
- Every async load follows the TV app's pattern: a `dead` flag in `onDestroy`, request
  generations, `LoadError`-style retry that returns its promise, never raw `e.message`
  (use `errText(e)`).
- No hover styles. Press states are `.pressing` from `lib/press.js` (delayed, scroll-safe; add a
  new pressable's class to its `SEL`), styled in components.css — never `:active`.
- Text isn't selectable app-wide (app.css); add `class="selectable"` where copying helps.
- Motion: transform/opacity only; honour `prefers-reduced-motion`.
- Skeletons (`.skel`) stay still 400 ms, breathe 3 times, then rest at 0.7 — nothing loops. Put
  `.fade-in` on the first real content that replaces a skeleton.
- No scroll indicators anywhere (a global rule in `app.css`, the user's call on 2026-10-01 —
  it reverses PWA-10). Don't re-enable them per element.
- Touch: long-press via `use:longpress` (500 ms, cancels on move > 10 px, suppresses the click).
  A context menu lifts its preview out of the pressed element by itself (`pressSource`, no wiring).
  **Destructive confirmations use `confirm()` (lib/confirm.svelte.js → the action sheet)**, never a
  second context menu with a disabled caption row: a menu chooses, an action sheet confirms.
- Safe areas via the tokens' `--safe-*` helpers. The app runs `display: standalone` with the
  **`black-translucent` status bar** (again since 2026-10-01; opaque `black` 2026-09-30 → 10-01):
  pages draw behind the status bar and the Dynamic Island, `--safe-top` ≈ 59 pt in portrait,
  every top edge pads with it. iOS 26 sizes such a web view one status-bar height short of the
  screen (WebKit 301108), so in standalone body/#app are `height: 100lvh` (the one unit reported
  to span the screen); elsewhere `position: fixed; inset: 0`, no other vh units, no JS-measured
  heights. ⚠️ Unverified on the iPhone: if a black band remains under the tab bar it is outside
  the web view, and the fix is the opaque status bar again (+ remove and re-add the app).
- Wordmark: the full "VibeReel" only on Login; the TopBar carries the short mark
  (`.wordmark--short`: upright V, italic gold R). `index.html` preloads both the regular and the
  italic InstrumentSerif (the R is on Home's first frame).
- Glass (`backdrop-filter`) is for chrome that appears a few times per page: bars, sheets, panels,
  the toast, a detail heading. **Chips on tile art** (badges, the quick-add +, the download ring)
  use `--chip-bg`, a flat 88 % tint — a grid of a few hundred blurs (Top 250's rank badges) costs
  a blur pass per chip per scroll frame for a nearly invisible effect. `.badge--gold` never blurs.
  The toast stays mounted but goes `visibility: hidden` + no blur after its fade.

## Performance (audit + fixes, 2026-10-01)

Measured in headless Chrome as an iPhone (393×852 @3, 4× CPU throttle — Blink, not WebKit) plus
code reading; the app needed targeted fixes, not a rewrite. Boot ~120 ms FCP unthrottled, Home
scroll ~1 % dropped frames, no leaks over repeated tab/detail cycles. Rules that came out of it:

- **Polling** — `/api/activity` goes out every 4 s only while something moves (a `downloading`
  grab with speed > 0 — stalled torrents report `downloading` at 0 for days —, any feed change in
  the last 2 min, or 2 min after `boostActivity()` from Add/Get/cancel and their undos), else
  every 30 s (was 15/min on an idle Home: the radio never slept). The stale mark needs two failed
  slow polls. `mlMetadata`'s cache is LRU 30 on the phone; landed checks wait while hidden; the
  badge's Cache Storage write happens only on a change.
- **Fields** — phone tiles don't read `MediaSources` (~11 KB/movie): Library's `listPath` asks
  `UserData,ProductionYear,PremiereDate,ProviderIds` + `EnableImageTypes=Primary&ImageTypeLimit=1`
  (126 movies 1.3 MB → 0.11 MB), `/Similar` sends no Fields (19.8 → 4.1 KB), Person only
  `People`, digested to `role` on arrival. Don't use `GRID_FIELDS` for phone tiles.
- **`R.playerClosed`** isn't bumped for a trailer close (`R.playerQuiet`, kept by
  `lib/playclose.svelte.js`). Listeners mark themselves stale and refresh when showing (Detail's
  pattern); Library adds a 5-min re-read on return for what freshness can't see (an older title
  un-watched elsewhere, Home's own mark-watched, new artwork). Chart's `libIndex()` is tied to the
  close count, returns the same object when nothing visible changed, and folds names lazily once.
- **Mounting** — Library mounts 12 tiles, then time-budgeted slices (8 ms target, 6–42 tiles);
  the activity merge rebuilds its id/name lookups only when `items` changes and a hidden grid
  catches up when shown. `restore.svelte.js` reads `scrollTop` 150 ms after scrolling rests (or on
  a save), never inside the scroll event — that forced a second layout in frames that mounted tiles.
- **Home hero** — blur copies come from a 480 px Jellyfin variant (`heroBlur`), one canvas per
  idle task, not in the first 3 s, never during a touch or glide (Chrome re-decoded the 1920
  `<img>` for canvas despite `decode()`: ~120 ms/slide at 4×; `createImageBitmap` was worse in
  WebKit). Auto-advance stops after 2 untouched rounds (touch, return to Home, foreground or a
  player close re-arms it): idle Home CPU 9 % → 0.1 %. Only cur ±1 slides hold a backdrop. Rails
  are `$state.raw` + per-item signatures; failed rails retry alone; no full reload after 10 min
  away (freshness covers it).
- **Detail** — NextUp is prefetched with the seasons (`nextUpPath()`); ActionBar's each walks
  keys, not action objects (`animate:flip` measures every item on any array change — feed fast
  values like a download's `p` through a getter); SeasonPills detects pinning with an IO on
  `.pills__mark`, glass on a permanent `::before` faded by `.pills--sticky`.
- **Streams** — segfeed's window is a 96 MB byte budget (10–45 s ahead, 5 s behind; offline 20 s);
  on quota it evicts, then shrinks the window; it sleeps until the buffer drains to ⅔ and wakes on
  `seeking`/`waiting`/`startstreaming`; a growing playlist is polled every 1 s only near its end,
  else 10 s. Phone trailers ask `/api/trailers/<id>@1080` (falls back to the plain id against an
  older backend). Offline segments `put()` straight from the response; the orphan sweep runs ~10 s
  after boot and only when stamped dirty (`reel.offline.swept`) or weekly. Chapter thumbnails are
  cut once per film from the trickplay sheets (this server extracts no chapter images); the PGS
  canvas is hidden while no subtitle is drawn; the scrubber moves with transforms.
- **Not done, needs the iPhone (Safari Web Inspector → Timelines/Layers):** DetailHero's
  scroll-driven parallax at 120 Hz; `content-visibility: auto` on grid tiles (Safari 18+ only; in
  Blink it *doubled* dropped frames at 600 tiles); the zoom transition's `clip-path` keyframes.
  Touch-move latency: Svelte delegates `pointermove`/`pointerdown` to the root, which WebKit
  treats as blocking listeners, so making `edgeSwipeBack`'s `touchmove` lazy or passive gains
  nothing (and attaching it at `touchstart` is too late for that swipe on iOS).

## Workstreams and file ownership

Only edit files you own. If you need a change in someone else's file, write it in your final
report (the integrator applies it) — except trivial additions to `phone/src/screens/index.js`
/ `phone/src/sheets/index.js` (one line per screen, append only).

| Workstream | Owns |
|---|---|
| **F — Foundation** | `phone/` scaffold, `vite.config.js`, `index.html`, `public/` (manifest, icons, fonts, sw.js), `main.js`, `App.svelte`, `styles/tokens.css`, `styles/components.css`, `styles/app.css`, `lib/*` (router, nav shim, focus shim, lifecycle, gestures, icons), `components/*`, `screens/Login.svelte`, `screens/index.js`, `sheets/index.js`; `src/lib/config.js` (phone defaults under `__PHONE__`) |
| **E — Engine & player** | `src/lib/player.svelte.js`, `tracks.js`, `trailerstream.js`, `trailer.js`, `segments.js`, `pendingplay.js`, root `vite.config.js` (`define` only), `phone/src/player/*`, `phone/src/styles/player.css` |
| **I — Infra** | the NAS's NixOS config (not in this repo), `phone/deploy.sh`, `docs/ios/MEDIA-TEST.md` |
| **B — Home & account** | `phone/src/screens/Home.svelte`, `phone/src/sheets/{Accounts,Notifications}.svelte`, `phone/src/screens/Settings.svelte`, `phone/src/styles/home.css` |
| **C — Library & search** | `phone/src/screens/{Library,Search,Chart}.svelte`, `phone/src/sheets/SortFilter.svelte`, `phone/src/styles/library.css` |
| **D — Title pages** | `phone/src/screens/{Detail,MovieDetail,SeriesDetail,LookupDetail,PendingDetail,Person}.svelte`, `phone/src/components/detail/*`, `phone/src/styles/detail.css` |

Other shared `src/lib` modules (`api.js`, `medialib.js`, `activity`, `landed`, `news`, `lookup`,
`libview`, `homehide`, `played`, `trackprefs`, `searchrank`, `format`, `account`, `settings`,
`toast`) are **read-only** for B/C/D — if one needs a change, report it.

To start playback, screens call the engine's existing functions (`play(id, resumeSec)`,
`playEpisode`, `playFromHome`, `playPendingStream`, `playTrailerStream` / `trailer.js`) — the
player modal opens itself when the engine sets `S.screen = 'player'` (the nav shim reflects that
into `R.modal`).

## Dev ports (one dev server each, never kill another agent's server)

F 8900 · E 8901 · B 8902 · C 8903 · D 8904 · integration 8905.

## Verifying your work

- `npx vite build --config phone/vite.config.js` must pass; and **`npx vite build`** (the TV
  build) must still pass if you touched `src/lib`.
- Look at your screens in headless Chrome at iPhone size, e.g.
  `google-chrome-stable --headless=new --user-data-dir=$(mktemp -d) --hide-scrollbars
  --window-size=393,852 --force-device-scale-factor=2 --screenshot=out.png http://127.0.0.1:<port>/`
  or drive it over CDP with `--remote-debugging-port=<yourport+1000>` (touch emulation:
  `Emulation.setTouchEmulationEnabled`, `Emulation.setDeviceMetricsOverride` 393×852 mobile).
  The Claude-in-Chrome tools drive the user's one real Chrome: only one agent at a time may use them
  (in a new tab), against `phone/dev-chrome.sh` → http://127.0.0.1:8930/__frame (see `phone/DEV-CHROME.md`).
  Parallel agents use headless Chrome instead.
  Compare against the design screen HTML side by side. Keep screenshots in your scratchpad, not
  the repo.
- The dev server talks to the real Jellyfin; log in with the stored TV account if needed — ask
  the integrator (report it) rather than guessing credentials. Don't modify watched state or
  add titles to the library while testing unless you revert it.
