# VibeReel Web: architecture

The desktop web client (`web/`) is the iPhone PWA's screens and the shared `src/lib`
engine under a desktop shell, for Chrome and Firefox with a mouse and a keyboard. It is
served from one HTTPS origin together with Jellyfin (`/jf`) and reel-api (`/ml`), like the
phone app, and streams Jellyfin's HLS fMP4 remux through Media Source Extensions.

## Build: one more flavour of the phone build

```sh
npx vite build --config web/vite.config.js     # → web/dist (hashed assets)
npx vite --config web/vite.config.js           # dev server, http://127.0.0.1:8910
```

- **Defines.** `__PHONE__: true, __WEB__: true`. The TV build defines both `false`, the
  phone build `__WEB__: false`. Web-only code sits behind `__PHONE__ && __WEB__`, or
  `__WEB__` inside a `__PHONE__` branch, so both other bundles constant-fold it away. They
  stay **byte-identical** to a tree without the web client. A scratch build of the TV
  `app.js`/`style.css` and of the whole `phone/dist`, md5-compared before and after, is the
  check.
- **Svelte markup.** Svelte never folds a constant into its static template, so
  `<p>{__WEB__ ? 'In this browser' : 'On this iPhone'}</p>` would move the phone bundle.
  `vite.svelte-consts.js` (in both the phone and web configs) folds
  `{__WEB__ ? '…' : '…'}` in markup to plain text, and `__WEB__ ? '…' : '…'` in expressions
  to the chosen literal, before the compiler runs.
- **Identity.** Jellyfin lists the client as `VibeReel Web` on device `Web`. DeviceIds start
  `reelweb-` (`src/lib/api.js`, `config.js`), so a browser never shares a device row with
  the iPhone app.
- **Module redirects** (`web/vite.config.js`, matched on the *resolved* path like the
  phone's). The phone's three apply: `nav.svelte.js` becomes the phone router shim,
  `focus.js` the no-op shim, and `lifecycle.js` becomes `web/src/lib/lifecycle.js`.
  `WEB_SWAPS` turns phone-only machinery into inert stubs (`offline`, `homesnap`, `push`,
  `restore`). The desktop variants of `gestures.js`, `Sheet`, `TopBar`, `NavBar` and
  `Rail` keep the phone props.
- **Stylesheets.** `web/src/web.css` re-proportions the phone's stylesheets for a desktop
  window; after it, one file per owner in cascade order: `styles/look.css` (tokens' use,
  focus rings, states, type, the font), then `shell`, `ctx`, `home`, `pages`, `browse`,
  `player`. A generic rule lives in look.css, so a page's own file can refine it.
- **Shared markup can't grow.** A new element, attribute or `{#if __WEB__}` block in a phone
  component compiles into the phone bundle even when false. Web-only DOM work therefore
  lives in web-only modules started from `main.js` (MutationObserver / event delegation:
  `heroarrows.js`, `tiletips.js`, `ctxmenu.js` + `ctxmore.js`, `roving.js`,
  `pagesa11y.js`), in web variants swapped in by REDIRECTS, and in `__PHONE__ && __WEB__`
  branches of component *scripts*. A shared phone screen may import a web-only module by
  relative path for such a branch; Rollup drops it from the phone bundle only if the module
  has no top-level side effects (no global reads either). A new static import between two
  shared phone modules can reorder the phone bundle even when tree-shaken — check the md5s.
- **Target** `es2022`. `phone/public` is shared (fonts, favicon). The service worker,
  launch images, manifest and touch icons are pruned from `web/dist`, because the web MVP
  has no service worker.
- **Tests.** vitest project `web` (`test/web/**`, phone redirects + `__WEB__: true`); ratchet
  project `web` (ceiling 0). e2e: tests with app `web` (`e2e/scenarios/80-web-routes`,
  `81-web-nav`, `82-web-overlays`) drive the built web app on its own fake origin
  (`node e2e/run.mjs --grep '^web'`; see e2e/README.md "The web target").

## The shell (`web/src`)

- `App.svelte` is the desktop shell. It shows `WebNav` instead of the tab bar and renders
  sheets as popovers or dialogs. A route's screen mounts the first time it shows (a deep
  link no longer loads the hidden Home or grid underneath) and then stays mounted, so
  scroll and loaded data survive Back. It also hosts `WebPlayer` (always mounted: the
  `<video>` survives across playbacks), Login, the toast and the offline banner, and prunes
  zoom.js's origins (`keepOrigins`) with the focus memory.
- **One fixed bar.** `WebNav` is the only fixed or sticky bar, apart from the series' season
  bar (`top: var(--wnav-h)`; it scrolls with the page under 600 px of window height) and
  Search's field bar. Pages render the phone's `NavBar`, which the web swaps for
  `components/NavBar.svelte`: it draws nothing and publishes `{title, solid, onback,
  trailing}` for its route to `lib/pagebar.svelte.js`. WebNav renders the active tab's
  stack as a breadcrumb trail after the sections:
  - "‹ Movies" is Back (`aria-label` "Back to Movies"), the first Tab stop after the
    sections; it calls the page's `onback`, else `pop()`.
  - Earlier crumbs pop to their level; longer trails collapse to "root › … › parent".
  - Once the page has scrolled past its h1 (`solid`), its title joins as "› Title", a
    button that scrolls to the top (`aria-current="page"`).
  - The trail is a size container: under 360 / 240 / 110 px it drops the earlier crumbs,
    then the title, then the words ("‹ Back"). Below 640 px the sections fold into a menu
    button, below 900 px the wordmark becomes the VR monogram, and under 420 px of height
    the nav is 48 px.
  - The current section is gold on `--gold-soft`. Settings and My library belong to the
    account, so no section is current there and the avatar wears the ring.
- **Glass and scrollbar.** The nav's glass comes from an IntersectionObserver on a 24 px
  `.wtopmark` App appends to the active page scroller (no scroll-event reads). App measures
  that scroller's scrollbar into `--wnav-right` (the classic width, or a 12 px strip for an
  overlay thumb), so the nav never covers the scrollbar; page scrollers keep
  `scrollbar-gutter: stable`, so the content's right edge equals the avatar's.
- **Focus.** A forward navigation focuses the new page's `.screen` (`tabindex=-1`,
  `preventScroll`) unless focus is already inside it, so PageDown/Space/End scroll and a
  screen reader hears the page; a page that swaps its `<main>` keeps that focus. Back
  restores the element that opened the page (`takeFocus`). A modal opening or closing never
  moves focus here — the player and context menus hand focus back themselves, and a sheet
  doesn't hand it back when one of its rows navigated. Page scrollers have scroll-padding
  for the nav (plus the season bar on a series), and App re-scrolls keyboard focus that
  still lands under a fixed or stuck bar.
- **Modality** (`lib/modal.svelte.js`). `.wapp` (nav + pages) is inert while a sheet is open
  or any key is held in `MODAL.holds`: `confirm` (an ActionSheet confirm; a route change
  answers it with No), `login` (the add-account Login: its first empty field takes focus,
  Esc cancels it), `ctx` (a context menu) and `player`. Release a hold before focusing
  anything inside `.wapp`.
- **Undo.** Ctrl+Z (⌘Z on a Mac) runs a toast's Undo, except while typing or under Login or
  a confirm; the button shows the chord, and the toast pauses while focus is in it. On the
  web the toast's `role=status` region is never `aria-hidden`.
- `screens.js` / `sheets.js` hold the phone's registries, minus Downloads and the offline
  sheet. Settings is the web's own.
- `lib/urlsync.svelte.js` mirrors the phone router into the address bar and history:
  `/movies`, `/shows`, `/search?q=`, `/movie/<id>`, `/show/<id>`, `/item/<id>`,
  `/person/<id>`, `/lookup/<type>/<id>?t=<title>&y=<year>`, `/search/chart/<key>?t=`,
  `/settings`, `/my-library`. Back/Forward, reloads and deep links work (a genre chart
  without `?t=` is titled by its key), and the player gets a history entry of its own, so
  the browser's Back closes it; Forward onto the entry of a player that has closed steps
  back over it. The tab title names the page from its h1 and follows it until it lands.
- `lib/lifecycle.js`: switching tab or window leaves a playing video alone. Only `pagehide`
  stops playback, with Stopped sent as `keepalive`. Back after an absence of more than
  60 s, it rechecks the server and the token.
- `player/WebPlayer.svelte` maps the mouse and keyboard onto `src/lib/player.svelte.js`:
  - Space or K: play/pause. ← → or J L: ∓10 s. 0–9: jump to 0–90 %. ↑ ↓: volume.
    M: mute. C: subtitles. S: skip intro/recap. Shift+N: next episode.
    F: full screen. P: Picture in Picture. ?: the list of shortcuts.
  - Esc: closes the shortcut list, else a panel, else leaves full screen, else
    dismisses Up Next, else closes the player. In full screen the browser takes Esc
    itself and only leaves full screen.
  - Keyboard focus: the controls are `inert` (never `aria-hidden`) while hidden, behind
    a loading/error card and under the "?" list. Tab first brings hidden controls up,
    and keyboard focus inside them keeps them up. The player holds MODAL `player`. On
    close, focus goes back to whatever opened it (Trailer/Play button, episode row,
    Continue Watching tile), else to the page's main action (`player/focusnav.js`).
  - Popovers (tracks, chapters) take focus on the selected option; ↑ ↓ Home End move
    within a column, ← → between Audio · Quality · Subtitles, Space/Enter choose, and
    closing gives focus back to the chip. The "?" list focuses its Close, traps Tab and
    lists only the keys that apply now (`shortcutRows`). The volume slider is 0–100 %
    with `aria-valuetext` and keeps ← → Home End; the position slider is a Tab stop.
    Error/stall cards focus Retry and name the title; feed errors name the HTTP status.
  - The key map is `player/shortcuts.js` (pure, pinned by
    `test/web/shortcuts.web.test.js`); it also feeds the "?" list. Keys that change
    nothing visible in the bar flash on the picture: play/pause, ∓N s (adding up
    while the key repeats), the volume %, the time a digit jumped to.
  - Mouse: a click on the picture pauses 250 ms later (a double click toggles full
    screen without pausing); the wheel over the speaker sets the volume by distance
    (`wheelSteps`: one step per notch or per 40 px of trackpad travel; remembered in
    `reel.web.volume`). A mouse drag on the scrubber maps 1:1 (the phone's fine
    scrubbing is touch-only). The controls and cursor hide after the engine's idle
    timeout or when the pointer leaves the window; the cursor stays over a loading or
    error card. Every button has a tooltip naming its key, above the scrubber for the
    bottom row; a keyboard-focus tooltip fades after ~2.4 s.
  - Scrubber: a lighter fill and a hover preview (trickplay, chapter, time) follow
    the pointer. The bar's clock shows elapsed / total; a click flips it to time left.
  - The phone's Track/Chapter panels are popovers over the right end of the bar; a
    click anywhere outside closes them (on the picture without pausing). The Up Next
    card is the phone's.
  - PiP: the button and P exist where the API does (Chrome, Firefox 156). There the
    `<video>` carries `disablePictureInPicture` while not in PiP, which hides
    Firefox's own "Pop out this video" toggle over the picture; our request lifts it
    first. While in PiP the in-page video is hidden and a card offers "Back to this tab".
  - Full screen is requested synchronously on the layer; a refusal (or a window manager
    that leaves the window small) toasts the reason.
  - The control row fits down to 800 px (chips drop their detail below 1100 px and become
    icons below 900 px). `.wplayer` is `overflow: clip`.
  - Trailers: a failure keeps the player up with an error card (Retry · Open on YouTube ·
    Close; no tab opens by itself, the app is never navigated away) and the raw yt-dlp
    error goes to the console.

## Look (`styles/look.css`, `lib/tiletips.js`)

- **Focus rings, one language.** A 2 px solid gold outline 2 px off the edge
  (`--ring-w`, `--ring-gap`, `--ring`); gold-filled controls wear `--ring-on-gold` (the light
  text colour); list items (`.row`, `.notif`, `.ctx__item`, `.option`) ring inside their
  edge, because `.list` / `.ctx__menu` clip; Settings' invisible `<select>` rows ring the
  row (`:has()`); fields ring their box; tiles ring their art (a background gap + gold, and
  a gold title); the position slider rings its thumb. Other code makes things focusable;
  look.css makes them visible.
- **States.** Hover is one `--hover-tint` overlay on surface controls (glass and selected
  fills stay), a gold-line ring on artwork, brightness only on the gold button. `:active`
  scales button-like controls to .97 (rows take `--surface-press`). Selected is gold on
  `--gold-soft` everywhere except the segmented thumb. Disabled is `--disabled-opacity`
  (0.4). `html.wscrolling` (tiletips.js, from the first scroll event to 150 ms after the
  last) drops the tile hover lift; so does reduced motion. A forced-colors block keeps tile
  focus, switches, the selected option and progress fills in system colours.
- **Type.** Six UI sizes, tokens in web.css §1: 12 micro, 13 caption, 14 tile / callout /
  small button, 16 body / button, 20 headline, 24 heading — all `calc(N * var(--tu))`.
- **Font.** Inter 4 (variable, latin + latin-ext subsets, SIL OFL) is bundled in
  `web/src/fonts` as `'Inter VR'`; `--font-ui` lists `-apple-system`/`BlinkMacSystemFont`
  first, so macOS keeps SF and never downloads it, while Linux and Windows no longer fall
  back to DejaVu Sans / Arial. `web/vite.config.js`'s `fontLicense` plugin appends the OFL
  to the web build's LICENSES.txt only.
- **Tooltips.** `tiletips.js` gives icon-only buttons outside the player their
  `aria-label` as a native title (never over a markup title) and cut-off tile captions —
  one line or the grids' two-line clamp — their whole text. An icon-only control needs a
  good `aria-label` and nothing else.
- **Confirm.** The phone's ActionSheet confirm is a 460 px desktop dialog: title and message
  left, Cancel then the action as pills in one row.
- **Progress rings** use `calc((1 - var(--p)) * 100px)`: Firefox rejects the phone's unitless
  dashoffset and drew every ring full.

## Context menus and the ⋯ (`lib/ctxmenu.js`, `lib/ctxmore.js`, `lib/gestures.js`)

The phone's ContextMenu is reused unchanged and turned into a desktop menu by a web-only
layer. The web `longpress` wrapper — the hook on every Tile, EpisodeRow and season pill —
opens it on a right-click, on Shift+F10 / the Menu key, on a mouse hold and from a visible
⋯, and records where the open came from.

- **Placement:** at the pointer, or against the ⋯ / the source for a keyboard open,
  flipped at the edges and clamped to an 8 px margin. No lifted preview and no blurred
  scrim on the desktop.
- **Keys (WAI-ARIA menu):** focus on the first enabled item; ↑ ↓ wrap, Home End,
  type-ahead; Enter / Space activate; Esc and Tab close and give focus back to the source
  (or, when an item removed it, to its neighbour). MODAL `ctx` while open.
- **The ⋯:** on tiles a glass button at the art's top-right, shown on hover / focus-within,
  `tabindex=-1` (the tile advertises Shift+F10 in `aria-keyshortcuts` and its description);
  on episode rows a permanent Tab stop (the keyboard path to a pending row's Cancel); after
  the season pills, one for the selected season.
- **Tiles** that open a page are `role=link` (Continue Watching / Next Up play, and stay
  buttons); `aria-describedby` carries the sub line, badges, rank, Queued and Watched.
  Enter / Space on a native control inside a tile or row (the quick-add "+", the bell's
  Get, a ⋯) stops at that control.
- `gestures.js` also makes `pullStretch` a no-op: a desktop scroller never rubber-bands.

## Keyboard patterns and live regions (`lib/roving.js`, `gridkeys.js`, `roving-live.js`)

- Every `role=radiogroup` / `role=tablist` outside the player and context menus has one Tab
  stop (the selected option); arrows move and select (radios all four, tabs ← →), Home /
  End. Tab lists get `aria-controls` → a `role=tabpanel` (the season's episodes, the person's
  grid). The Accounts radios only move focus (a pick switches account).
- `.grid`s get 2-D arrows by their computed columns (Home / End per row, Ctrl+Home / End for
  the grid; ↑ ↓ cross into the next grid on the page). Tiles stay Tab stops.
- Rails: Tab onto a half-visible tile glides it into view as ← → do; the ◀ ▶ head buttons
  are mouse-only (`tabindex=-1`) and named per rail; region names include the sub line.
- Two live regions on `body`: an error card's title and reason are said once (its
  `role=alert` is removed, so Retry doesn't chatter); Search's count goes through the polite
  one, and Search keeps an h1 while results show.
- `gridkeys-slices.js`: long Library and Chart grids mount in idle-time slices (≤ 8 ms) plus
  a frame slice only when the viewport nears the end, instead of a slice every frame.
- Library / Chart / Search empty and error states sit in the page flow, below the chips.
  Search has no iOS Cancel (Esc does it) and Enter keeps the cursor in the field.

## Home hero (`lib/heroarrows.js`, `styles/home.css`)

- One group in front of the slides — Pause (an `aria-pressed` toggle), Previous, Next — at
  the right end of the pager row, like a rail's ◀ ▶. Auto-advance holds while the pointer
  is over the hero, keyboard focus is in it or Pause is down; reduced motion never advances.
  When a step makes the focused slide inert, focus moves to the same control of the new one.
- The text column sits on the page gutter (`max-width: min(760px, 52vw)`), the dots on that
  column; the hero height floor is `min(480px, 78vh)` so 200 % zoom shows the first rail.
- Images: the backdrop is window-sized (below); the shown slide loads first at
  `fetchpriority=high`, its neighbours and the blur sources afterwards at low priority, cur±1
  only; nothing loads while Home is hidden; blurred copies use `ctx.filter`.
- `[hidden] .home__rail { height: 0 }` keeps Svelte's slide from building NaN keyframes on a
  hidden route.

## Title pages (`lib/pagesa11y.js`, `phone/src/components/detail/weberror.svelte.js`)

- `pagesa11y.js` (a MutationObserver) makes every `.btn--status` a progressbar named
  "Download" (value, value text, not disabled), names the pending page's Cancel "Cancel
  download" and hides avatar initials from names.
- `weberror.svelte.js` mounts a full-page LoadError over a page when a URL-born lookup has no
  metadata, or a person and their filmography both failed.
- Script branches: Login's error is `role=alert`, tied to its field (`aria-invalid`,
  `aria-describedby`); Overview's "more" is its own button; My library's Delete and
  LookupDetail's Add leave focus on the neighbour / the new status.
- Long titles wrap anywhere; the title column is 22ch (34ch and three lines for a long one);
  the season bar's glass sits on `.detail__pills` itself (0.94 alpha when pinned). Settings'
  pickers use Chrome's customizable select (`appearance: base-select`) for a dark menu.

## Window-sized images (`pickSize` in `src/lib/api.js`)

`pickSize(px, steps)` returns the smallest step that covers `px` CSS pixels at the window's
devicePixelRatio (within 10 %), else the largest. It is only called from `__WEB__` branches,
so the TV and phone bundles drop it. Steps: Jellyfin backdrops `[1920, 2880, 3840]` (Home,
title pages, the player's loading card), episode stills `[320, 640]`, person photos
`[280, 560]`, TMDB posters `w342 / w500 / w780` (TVDB original above 342). TMDB backdrops on
lookup/pending pages paint `w1280` first and swap in `original` after `decode()` above 1440
device pixels. Every new Jellyfin size misses its resize cache once (~0.7 s for a 2880
backdrop): pre-render the sizes over the library after a change.

## Hosting: `vr.kirill.es`

The NAS serves `/var/lib/vibereel-web/current` (a symlink to `releases/<stamp>/`) through
nginx. Jellyfin is at `/jf`, reel-api at `/ml`, and every unknown path falls back to
`index.html`. The nginx/ACME/tunnel configuration lives in the NAS's NixOS config, not in
this repo.

- **At home**, an AdGuard Home DNS rewrite points the name at the NAS. nginx terminates TLS
  with an ACME certificate for the name, so the LAN path has no Cloudflare in it.
- **Away**, a Cloudflare Tunnel carries the name, with Cloudflare Access in front.
  `lib/access.js` wraps `fetch` before anything else runs: when an expired Access session
  turns a `/jf` or `/ml` call into a network error, it asks `/net.json` with
  `redirect: 'manual'`. On a redirect to the Access login, it reloads the page so Access
  can sign the user in again, at most once a minute.
- **`/net.json`** answers `{"via":"lan"}` or `{"via":"tunnel"}`. `lib/net.js` makes the
  streaming-quality default Original on the LAN and 8 Mbit/s through the tunnel, until the
  user picks a quality. A missing file (the dev server) means Original.
- reel-api's request guard needs the name in `allowedHosts`, and nginx must pass `Host`
  through.

## Playback path

`src/lib/player.svelte.js` is the same engine as on the TV and the phone. In the web build
it differs in two places:

1. **`webProfile()`** (`src/lib/tracks.js`) builds the DeviceProfile from
   `MediaSource.isTypeSupported` probes (`webCaps()`), because what counts is what an fMP4
   SourceBuffer accepts. Measured on Linux:
   - **Chrome 154:** H.264, AV1, VP9, AAC, Opus, FLAC. No HEVC, AC-3/E-AC-3 or Dolby Vision.
   - **Firefox 156:** the same, plus HEVC Main/Main 10.

   How the profile uses that:
   - **DirectPlay:** progressive MP4 only, and only for the file's default audio track.
     Browsers have no `audioTracks`, so any other pick turns DirectPlay off.
   - **Everything else:** Jellyfin's HLS remux, video copied where the browser decodes it.
   - **Forced encodes:** H.264 is listed first, so HEVC on Chrome, the quality cap and
     burn-in all encode H.264.
   - **Audio:** AAC 5.1 at most. DTS, TrueHD and E-AC-3 become AAC.
   - **HDR:** claimed only on an HDR display (`video-dynamic-range: high`). DV profile 8
     plays as its base layer.
2. **`src/lib/jfhls.js`** feeds that HLS into a MediaSource through `segfeed.js`. Firefox
   has no HLS player, and Chrome's is not one to build on. The feed:
   - feeds Jellyfin's VOD media playlist `main.m3u8` (it reads `master.m3u8` once, as
     text, for the codec string — never plays it) and fetches the segments around the
     playhead;
   - rewrites a `dvh1` sample entry to `hvc1`;
   - writes each fragment's real start back into the playlist after a job restart;
   - stops the server job (`DELETE /Videos/ActiveEncodings`) when it ends.

   libpgs is its own lazy chunk in the web build (`loadPgs()` → a dynamic import).

   One feed runs at a time. Retry, an audio switch, a quality pick and the next episode
   each open a new feed, and the old one's job is stopped. Progress reports, markers,
   trickplay, Up Next and text/PGS subtitles all run as for any Jellyfin stream. Only the
   `<video>` src is the feed's blob URL.

Watch-while-downloading uses reel-api's live HLS (`livehls.py`) with `codec=aac` on every
call. Desktop browsers decode no AC-3/E-AC-3, so the server copies AAC and encodes the
rest to AAC.

## Dev server (`web/dev/plugin.js`, serve only)

- `/jf` and `/ml` are proxied to `VITE_JELLYFIN_URL` / `VITE_MEDIALIB_URL` from
  `.env.local`.
- `/?devlogin` signs in with the gitignored `phone/.devcreds.json`
  (`phone/dev-chrome.sh login` writes it), served at `/__devcreds`.
- **Playback guard:** `PlaybackInfo` and `Sessions/Playing*` answer 403, so nothing
  records a play on the real server. `REEL_DEV_ALLOWPLAY=1` lets them through, but then
  snapshot and restore the UserData of everything played.
- `REEL_DEV_READONLY=1` blocks every non-GET except sign-in and trailers.
- `REEL_DEV_NET=lan|tunnel` makes `/net.json` answer like the NAS.

## Deploy (`web/deploy.sh`)

```sh
./web/deploy.sh                 # build + publish + verify
NO_BUILD=1 ./web/deploy.sh      # publish the existing web/dist
```

`NAS` (ssh target), `WEB_ORIGIN` and `WEB_IP` come from `.env.local` or the command line.
The deploy is atomic, like the phone's:

1. rsync into `releases/<stamp>/`, hard-linking unchanged files from the live release.
2. md5-check the staged tree, then swap `current` with a rename. The last 3 releases are
   kept.
3. Verify through the real name pinned to the NAS's address, so Cloudflare and Access are
   not involved: `index.html` and every script and stylesheet it references must
   md5-match. A deep link must return `index.html`, and `/net.json` must answer (these two
   only warn).

Exit 0 means the origin serves this build. The NAS-side module must exist before the first deploy.
