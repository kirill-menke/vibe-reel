# Phone shell API reference (from workstream F)

Each component file in `phone/src/components/` starts with a props comment — that is authoritative;
this is the overview.

## Router — `phone/src/lib/router.svelte.js`
- `R` fields: `tab`, `stacks[tab]` (Route `{name, params, key}`; replaced, never mutated), `sheet`
  (`{name, params, key}`), `modal` (`null|'player'|'login'`), `playerClosed` (counter — watch it to
  refetch play state), shell-internal: `toTop`, `anim`, `peek`, `booted`, `visited`.
- `push(name, params, {animate=true})`, `pop({animate=true})`, `popToRoot()`, `switchTab(tab)`,
  `resetTab(tab)`, `top(tab?)`, `beneath(tab?)`, `stack(tab?)`, `openSheet(name, params)`,
  `closeSheet()`, `openPlayer()`/`closePlayer()` (modal only — to end playback call the engine's
  `exitPlayer()`), `openLoginModal(adding)`, `closeLoginModal()`, `markBooted()`.
  `window.__router` exposes it for CDP tests.
- Route names: `home, movies, shows, search, chart, detail {id,type}, person {id,name},
  lookup {item}, pending {key}, settings, downloads, mylibrary`. Sheets: `accounts, notifications, sortfilter,
  offline {item}` (the Download quality sheet).
- Screens get `{ params, active }` (`active` = visible top of the active tab and no modal over it).
  A screen renders its TopBar / NavBar as a **sibling** of its `<main class="screen">`.
- Register in `screens/index.js` / `sheets/index.js` (one line each). Sheets get `{ params }` and
  render `<Sheet>`.
- Only visited tabs are mounted. Push/pop use WAAPI; scroll positions remembered per scroller.
- **Tile → page zoom** (`lib/zoom.js`): a push of `detail`/`lookup`/`pending`/`person` that follows a
  tap on a `.tile` / `.cast` (same route, < 3 s — a capture-phase click listener remembers it; no
  wiring in tiles or screens) grows the page out of the tile (`R.anim.dir = 'zoom'`), and its pop /
  edge swipe shrinks it back into the tile (`'unzoom'`; re-measured, found again by image, fade +
  scale-down when it is off screen). Other pushes slide; reduced motion fades. The page's hero must
  stay `.detail__hero` (or `.person__photo`) with its image in `.art > img` — the overlay stands in
  for it while `.route.zoom-hide` hides it.

## Nav shim — `phone/src/lib/nav.svelte.js`
Exports every TV name. `openItem/openPerson/openLookup/openPending` push (while the player is up:
only close it if the target equals the page underneath, else close + push). `openHome/returnHome/
openLibrary/openSearch` switch tabs. `openLogin(adding)` raises the Login modal. `onBack` = close
Login-when-adding / close sheet / pop. Focus-memory helpers return null.

## Gestures — `phone/src/lib/gestures.js`
- `use:longpress={fn | {onlongpress, duration=500, tolerance=10, disabled}}` → `longpress` event,
  detail `{x, y, rect, node}`, swallows the next click. After 150 ms of stillness the node gets
  `.holding` (the build-up: artwork sinks to .92, rows light — components.css), dropped on lift /
  move. `pressSource(rect)` returns the node for a detail's `rect`, which is how ContextMenu finds
  what to lift out of with no caller wiring.
- `use:edgeSwipeBack` (wired in App already): `{enabled, top, beneath, shadow, reveal, grab, commit,
  drag, edge=20}`. `shadow()` = the page-edge strip (`.stage__edge`), `grab(top, beneath)` → px =
  take over a push still running; the optional `drag(top, beneath)` controller lets zoom.js
  shrink a zoomed page with the finger instead of sliding it (`end(done, then, v)`, v = release
  px/ms). Release = UIKit's projection (`x + 499·v` past 50 % / the controller's `threshold`),
  velocity over the last 100 ms cut at a direction change, settle on `spring()`.
- `use:doubleTap={{onsingle, ondouble, delay=300, slop=30}}` → `{x, y, count, side}`.
- `use:scrollPast={{y=40, onchange}}` — drive TopBar/NavBar `solid`.
- `use:portal` → moves the element into `#app`.

## Other libs
- `conn.svelte.js`: `conn.offline`, `conn.checking`, `checkServer()`, `noteError(e)`.
- `freshness.svelte.js` (no pull-to-refresh — the app refreshes itself): `onLibraryChange(fn)` →
  unsubscribe; `fn({movie, tv, played, progress, type})` after a ~90 s check of three Limit=1
  markers saw the server change. `whenSettled()` (no finger down / scroll for 700 ms),
  `keepScroll(scroller, rowsSel)` → `restore()` after `tick()`, `rebase()` after the app's own change.
- `safe.js`: `safeInsets()`, `reducedMotion()`, `rm(ms)` / `rmOut(ms)` (Reduce Motion → 0 / 1 ms),
  `DUR.*` (incl. `sheetOut` 260 — modal dismiss, `hold` 350 — long-press build-up, `zoom`/`zoomOut`
  460/420 — the tile → page zoom, `hero` 6000 — Home's auto-advance interval), `EASE.{out,in,inout,sheet,standard,dismiss}` (`dismiss`: a modal leaving on its own), `SPRING.{smooth,snappy,bouncy}` (WAAPI
  strings), `springEase.*` (Svelte easings), `spring(v0, response)` (velocity settle → 21 linear
  keyframes + `at(t)`, ends where an overshooting flick first arrives; for settling *onto* a point),
  `fling(v, dist, full)` (a flick-dismiss *off* screen: the finger's speed plus a constant pull that
  would carry `full` px from rest in `DUR.sheetOut`; same `{duration, frames}` shape — sheet exits),
  `DUR.push` (read from `--dur-push`: change the token, not the JS), `easeSheet`, `easeInout`,
  `easeOut`, `easeIn`, `easeDismiss` (JS easings of the tokens), `bezier()`. No literal durations or
  curves elsewhere (MOT-19; the leftovers and why are in `polish/README.md`, "Wave 3 sweep").
  `use:fadeIn={on}` / `use:fadeInRest={on}` (the node / the node and its later siblings): content
  replacing a skeleton dissolves in (WAAPI, `DUR.fast` linear; skipped when `on` is false — painted
  from a cache, no skeleton seen —, under Reduce Motion and during the tile → page zoom).
  Tokens: `tokens.css` Motion block.
- `press.js`: `initPress()` (main.js) — `.pressing` on the `SEL` classes; see polish/README.md.
- `confirm.svelte.js` (ACT-01): `await confirm({title, message, action, danger=true,
  cancel='Cancel'})` → `true|false` — the iOS action sheet for destructive confirmations (App
  mounts the one `ActionSheet`; scrim / Cancel / Escape → false; a newer confirm answers the open one
  false). `confirmMenu(items)` shows cancel.svelte.js's `confirmItems()` shape as an action sheet and
  runs its action on yes: `confirmMenu(confirmItems(what, n, fn))` instead of a second ContextMenu.
  Wired: Library pending tile, PendingDetail (Cancel action + episode rows) and SeriesDetail
  (episode rows) cancels via `confirmMenu`; SeriesDetail's Watched (whole series) via `confirm()`
  (red only for *unwatched*, which drops resume points); Downloads → Delete; Sign out;
  My library → Delete (`askDelete`, below).
- `mylib.js` (My library, run/design.md §7): `askDelete(t)` — `confirm({title: 'Delete “X”?',
  message: deleteMessage(type), action: 'Delete', cancel: 'Keep'})`, then the shared
  `deleteTitle(t)` (`DELETE /api/library/{type}/{id}?delete_files=true`: title **and files** leave
  the server, for everyone) → `true` once deleted; nothing while that title's delete runs.
  `meAtBoot()` — one `refreshMe()` 2 s after `R.booted` (App.svelte), never twice.
- `$lib/toast.svelte.js` phone-only additions: `pauseToast()` / `resumeToast(ms=2000)` (Toast's
  hold-to-keep; no-ops on the TV).
- `icons.js`: `ICONS[name] = {svg, fill}`.
- `blurhash.js`: `avgColor(hash)` → `'rgb(r g b)'` (memoised; Tile's `tint`), `drawBlurhash(canvas,
  hash, w=32, h=18)`, `blurFor(item, url)` — the `ImageBlurHashes` entry of the exact image an
  `imgUrl()` URL names (type + `tag=`), else that type's first hash.
- `homesnap.svelte.js` (Home only): `seedHome(paths)` seeds the api.js store from
  `localStorage['reel.homeSnap.<userId>']` (≤ 14 days) → `{trend}` | null; `saveHome(paths, trend)`
  (debounced 1.5 s; trimmed items, ~35 KB); `homeSnap.shown` — Home painted something this session
  (the offline banner's "Showing what was loaded last."). Snapshots of accounts no longer in
  `reel.accounts` are pruned at boot. A snapshot item has no `MediaSources`: never play from it.
- `carousel.js` (Home hero): `HeroCarousel` + `use:heroArt={{url, hash}}`; each
  `.homehero__media` is `canvas.homehero__hash` + 2 × `canvas.homehero__blur` + `img` (bottom → top).
  A touch that catches the hero moving only stops it (the click is swallowed).

## Components — `phone/src/components/`
- **Icon** `name, size (''|sm|xs|lg), fill, gold, class, label`
- **Art** `src, alt, eager, decode (backdrops), fill, label, labelSm, class, style, children` — flat
  `--surface-2` (or the `--a2` tint) while loading, lazy images fade in over `--dur-img` (not when
  already in the memory cache; `decode` backdrops never), a missing/failed image → `.art--empty`
  tonal gradient + label.
- **Tile** `item` (Jellyfin) or explicit `title/sub/subGold/img` (explicit wins), `variant
  (poster|landscape), fluid, eager, skeleton, progress 0–1, inline (title + sub on one line, sub
  right-aligned and never cut), badge (string | {text, kind, icon, bottom}), watched, count, rank,
  onadd (tap doesn't also open), addState (lookup.svelte.js's add state: spinner while `adding`,
  then a gold ✓ for 1.2 s — pass `onadd` only for `idle`/`error`; Chart/Search, Home Trending and
  CollectionRail all do; LookupDetail's Add button speaks the same language: + → spinner → ✓
  "Added" → status), tint (`avgColor()` of the
  image's blurhash → tinted loading placeholder), download ({status: 'downloading'|'queued', p,
  sub}), onclick, onlongpress(detail), label, class, children`. No play glyph and no library-status
  badge/caption: the quick-add "+" (`onadd`) is the only mark of an addable title (round 3).
- **Rail** `title, sub, head snippet, label, bind:track, children` — no "See all" (round 3).
- **Grid** `class, style, bind:el, children`.
- **TopBar** `title (''→wordmark), overlay, solid, actions snippet`; bell count = news + landed; bell →
  `notifications` sheet, avatar → `accounts` sheet. Solid: glass fades in (`::before`), the mark
  scales, a tap on the bar's empty space scrolls the page up. The badge (tabular digits) springs in
  when it appears and bumps on an increase (WAAPI, not on mount / a decrease / a hidden tab / Reduce
  Motion).
- **NavBar** `title, solid, onback (default pop), trailing snippet`. Solid: glass fades in, the title
  rises in and is a button (tap = scroll to top); the back button reads "Back to <page under>".
  Style overrides of the bar material go on `.navbar::before` / `.topbar::before`, not the bar.
- **Sheet** `title, large, onclose (default closeSheet), headAction/head/foot snippets, bind:bodyEl,
  children` — drag grabber/head (or body at top) to dismiss: the scrim follows (1 − dy/h), upward
  pulls rubber-band, release springs at the finger's speed; dismiss past min(110, h/3) or a flick.
  Inside App's `.sheethost` the host runs present/dismiss (by the sheet's own height; the drag's
  speed is handed over via `takeSheetExitV()`, exported from Sheet's module script). **Mounted
  anywhere else** (e.g. the player's pickers) a drag-dismiss animates the sheet out itself, then
  calls `onclose`; present/other dismissals are the owner's. Its scrim, if any, must be the `.scrim`
  right before the Sheet's parent element. Such a drag-dismiss pins the sheet off screen (and the scrim
  at 0) before `onclose`, so an owner's outro must start from where the sheet *is* (read its computed
  transform), as `player/pickers.js` does.
  **Page card (SHT-03):** behind a `large` sheet in App's host the page (`.presenter` = stage + tab
  bar + offline banner) scales to .92 under the status bar with 14 px corners, on the sheet's progress
  p = 1 − dy/height: the present/exit use the sheet's own curve and duration, a drag paints it per
  frame and a release settles it on the same spring. Sheet's module exports `followSheet({grab,
  paint(p), settle(frames, opts, skip)})` (App registers the one follower; only hosted sheets drive
  it). Not for medium sheets, Reduce Motion, phone landscape, or with the player/Login up. Anything
  `position: fixed` inside a route is contained by the card while it is up (same box at rest).
- **ContextMenu** `open, rect, items ([{label, icon, danger, action, disabled} | {sep:true} |
  {title:true, label}]), onclose, preview snippet, fit ('card'|'rect'), source, label` — the preview
  grows out of the pressed element (found via `pressSource(rect)`, or pass `source`) which is hidden
  while open; tap outside / Escape drops it back, an item fades. Closes itself when the app
  navigates (tab, stacks, modal, sheet). Questions go to `confirm()`, not a caption row.
- **ActionSheet** — mounted once by App; driven by `confirm()` (above).
- **Toast** (App mounts it) `noTabbar, aboveBanner` — red alert glyph for failures (`isBadToast(msg)`
  by wording), check with an undo, info otherwise; springs in, bumps on a new message, a touch holds
  it, a drag down dismisses it.
- **StateMessage** `icon, title, text, error, fill, card, actions snippet, children`.
- **LoadError** `title, error, reason, retry (return the promise!), busy, auto (60 s onReconnect),
  fill/card, children` — network errors also raise the offline banner.
- **Skeleton** `kind (poster|thumb|line|line-lg|pill|circle|hero), w, h`. Still for 400 ms, three breaths, then rests
  at 0.7 (no endless pulse). Give the first real content that replaces one `use:fadeIn` (safe.js) —
  not the `.fade-in` class inside a page: routes toggle `[hidden]`, which restarts CSS animations, so
  it replayed on every pop/tab switch back.
- **Button** `variant (primary|glass|surface|text|danger|status), sm, block, grow, icon, iconFill,
  label|children, disabled, busy, p (status fill), onclick`.
- **ProgressBar** `p, class` · **ProgressRing** `p, label, lg, glass` · **Badge** `kind
  (gold|outline), pill, rank, icon, text, class, label` · **TechBadges** `badges ([string |
  {label, strong}])` · **Switch** `bind:on, onchange, label, disabled` (native `<input type=checkbox
  switch>` in gold on iOS 17.4+ — the real tap haptic; a drawn UISwitch lookalike elsewhere; `NATIVE`
  in Switch.svelte turns the native one off) · **Segmented** `options, bind:value,
  onchange, label` (one `.seg__thumb` slides to the picked option on `--spring-snappy`; equal-width
  options; placed by `--n`/`--i`, so a mount never animates) · **List** `label, foot, group, flush, role` · **Row** `title, sub, icon, iconStyle, lead
  snippet, value, chevron, check, trail snippet, selected, danger, action, column, insetSep, onclick`
  · **Avatar** `account, size, photo`. OfflineBanner / Toast / TabBar / ActionSheet are mounted by App (TabBar: one gliding
  selection lens, `.tabbar__lens`).

## Player — `phone/src/player/Player.svelte`
- Mounted once by App inside `.playerhost` (transparent, click-through); it hides/shows its own
  element. Its closes (X, busy-X, Esc, swipe-down) run `dismiss()`: an out-animation, then the
  engine's `exitPlayer()`. An engine-initiated close fades the (emptied) player out over ~180 ms.
- Stage gestures: tap with the controls hidden raises them at once (a second tap on the same half
  within 300 ms turns it into a double tap and drops them); with them shown, a tap hides them after
  300 ms. Double tap = ±10 s runs. Swipe down (controls hidden, not locked, no panel/error; portrait
  only with the info column at the top) follows the finger and closes past 110 px or on a flick
  (> 0.5 px/ms past 24 px), else springs back (`spring()` from `safe.js`). Pinch = fit ↔ fill.
- Portrait: the video box is `position: sticky` in the scrolling player. The bare buffering ring
  waits 450 ms; hidden controls are `visibility: hidden`.
- Pickers (`P.panel` = `'tracks' | 'chapters'`; TrackPanel, ChapterPanel): portrait = a real
  `<Sheet class="vr-sheet">` inside `.vr-picker` (fixed layer: `.scrim.vr-sheetscrim` +
  `.vr-sheethost`) — slides up on the smooth spring, drags/flicks down to dismiss, stops under the
  16:9 video (the track sheet at a fixed height, `.vr-sheet--fixed`, so segment taps don't resize
  it); landscape = the glass `.panel`, sliding in from the right. Transitions: `player/pickers.js`
  (`pickerIn/Out`, `panelIn/Out`, used `|global`). A tap on the video beside an open panel closes it
  at once. Always pass the player's `onclose` (Sheet's default is the router's `closeSheet()`).

## Dev login
Dev server: open `http://127.0.0.1:<port>/?devlogin` — seeds the session from the dev-only
`/__devcreds` route (serve mode only), then reloads.

## Title-page components — `phone/src/components/detail/` (lane D)
- **DetailHero** `src, skeleton, pending (URL not known yet: full-height placeholder, not the short
  no-art band), late (dissolve the backdrop in even if it lands at once), bind:height` — stretches on
  rubber-band pull-down, parallax 0.3× on scroll (not under Reduce Motion / `.zoom-hide`), fades a
  backdrop in that lands > 150 ms after mount. The hero stays `.detail__hero > .art > img` (zoom.js).
- **ActionBar** `actions [{id, icon, label, on, onclick, busy, p}]` — keyed by `id` (give every action
  one: a changing label no longer recreates the button); `p` 0–1 draws a download ring; `on` turning
  true after mount pops the circle once.
- **SeasonPills** `pills, onpick, onlong, onpress(key)` (touch-down on an unselected pill — prefetch).
  Scrolls the selected pill into view only when the *selection* changes and only if it is clipped.
- **StatusButton** `s` = `statusParts()` `{pct, rate, eta, rest, p}` — not a live region; pages put
  `aria-live="polite"` on their eyebrow badge (the state word) instead.
- **Overview** `text` — clamped to 3 lines; when clipped, "more" trails line 3 and the text itself
  expands on tap.
- `detail.js`: `lateIn` (use: on a page's `.screen` — dissolve late content), `morphFade` / `landIn`
  (in-place state cross-fade in a `.detail__morph` grid cell; the landed "Open" arrival).
