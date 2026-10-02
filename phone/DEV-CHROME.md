# Driving the phone app in desktop Chrome

This is for UI/UX work: an agent (or you) drives the phone PWA with a mouse in Chrome, for example
through the Claude in Chrome tools, and takes screenshots that look like an iPhone.
Everything here is dev-server only (`phone/dev/`, `apply: 'serve'`). None of it ends up in
`phone/dist`.

## Start it

```sh
phone/dev-chrome.sh           # starts the dev server on 127.0.0.1:8930, or reuses the one already running, and prints the URLs
phone/dev-chrome.sh login     # one-time setup: sign in to Jellyfin, which writes phone/.devcreds.json
phone/dev-chrome.sh status | stop
HMR=0 phone/dev-chrome.sh     # hot reload off (stop the server first if it is already running)
```

- **Frame:** http://127.0.0.1:8930/__frame shows the app in an iPhone frame. This is the page to drive and screenshot.
- **App alone:** http://127.0.0.1:8930/?safe=59,0,34,0

The log is written to `$XDG_RUNTIME_DIR/vibereel-phone-dev-8930.log`. Set `PORT=` to use a different port.

**Hot reload resets the page.** Other agents edit `phone/` and `src/lib` at the same time as
you. Each of their edits makes Vite reload the page, which drops you back on Home, and it can
happen between two clicks. `HMR=0` turns reloading off; press *Reload* in the frame to pick up
changes. When you script a click, check the route right before it (`reelFrame.app.__router.R`).

## Credentials

`/?devlogin` and the frame sign in from **`phone/.devcreds.json`**. The file is gitignored and
has mode 0600. Create it with `phone/dev-chrome.sh login`:

1. The script asks for the Jellyfin username and password. The password is not echoed.
2. It calls `POST /jf/Users/AuthenticateByName` through the dev proxy with its own
   `DeviceId="reel-chrome-dev"`. Running it again replaces only that device's token, never the
   TV's or the iPhone's.
3. It stores `{token, userId, userName, deviceId}`. The token is never printed.

`devlogin.js` also adopts that `deviceId`, so Jellyfin sees one consistent device. The file
that exists right now was copied from the TV account's credentials without the TV's deviceId.
Replace it with `login` when convenient.

The frame signs in by itself when the app has no token and `/__devcreds` answers. Its *Dev
login* button forces a new sign-in.

## The frame (`/__frame`)

- **Devices:** iPhone 15 at 393×852 with Dynamic Island, status bar (9:41) and home indicator.
  Also SE at 375×667 (no island, 20 px status bar) and Pro Max at 430×932. Portrait or
  landscape (852×393, with the island on the left).
- **Scaling:** the device is scaled down to fit the window. Resize the window to about
  1100×1000 to get 100 %, or pass `scale=1`.
- **Overlays:** the overlays and the frame ignore the pointer, so the app inside stays fully
  clickable.
- **Query options** (the page keeps them in its URL):

  | Option | Effect |
  |---|---|
  | `device=375\|393\|430` | Device size |
  | `land=1` | Landscape |
  | `safe=0` | Turn off the emulated insets |
  | `chrome=0` | Hide the status bar, island and home indicator |
  | `rm=1` | Reduced motion |
  | `offline=1` | Offline |
  | `allowplay=1` | Allow real Jellyfin playback |
  | `scale=1` | Show at 100 % instead of fitting the window |
  | `ui=0` | Hide the dev button |
  | `path=/…` | App URL to load in the frame |

- **Dev panel:** the round **dev** button at the bottom right, or the `d` key, opens a panel
  that stays outside the device. It has:
  - device size, rotate (`r`) and scale
  - safe areas, status bar, reduced motion, offline, and *allow real playback*
  - gesture buttons: edge swipe back, pinch in and pinch out
  - reload and dev login
- **Scripting from the top page** (for example with `javascript_tool`):
  - `reelFrame.app` is the app's `window`, which also gives you `reelFrame.app.__router`.
  - `reelFrame.dev` is the app's `__reelDev`.
  - `reelFrame.set('land', true)` changes a frame option.
  - `reelFrame.state()` returns the current options.

### What the app honours in dev (`phone/dev/client.js`, injected into index.html)

- **Safe areas.** `?safe=t,r,b,l` sets `--safe-top/right/bottom/left` on `:root`, where the
  `--page-top`/`--page-bottom`/`--tabbar-bottom` helpers are also computed, so they follow.
  `off` goes back to `env()`. The value is kept in sessionStorage so it survives devlogin's
  reload. The frame sends 59,0,34,0 in portrait and 0,59,21,59 in landscape (SE: 20,0,0,0).
- **Reduced motion.** `?rm=1` makes `matchMedia('(prefers-reduced-motion…)')` answer as reduced
  (safe.js, gestures.js, router), and rewrites the CSS `@media (prefers-reduced-motion…)` rules.
- **Offline.** `?offline=1` makes `/jf` and `/ml` fetches fail, sets `navigator.onLine` to
  false and fires `offline`, so the banner comes up. Images that are already cached still show.
- **Playback guard (on by default).** `PlaybackInfo` and `Sessions/Playing*` answer 403 unless
  `?allowplay=1` or the panel toggle is set. A real Jellyfin start records a play session and
  moves resume points and Continue Watching. Desktop Chrome also can't play the iPhone's HLS
  remux or HEVC, so without the guard you would get an error card anyway. Trailers go through
  `/ml` and play normally.
- **Automatic refresh** (there is no pull-to-refresh): `__freshness.check()` in the app window runs
  the server change check now instead of waiting ~90 s; `__freshness.state()` shows the last
  markers. To fake a server change, intercept the `SortBy=DatePlayed` / `DateCreated` marker
  responses (CDP `Fetch`) — never mutate the real library.
- **`?mouse=0`** turns off mouse-to-touch translation. It also turns itself off after the first
  real touch, or when `navigator.maxTouchPoints > 0` (DevTools touch emulation).

## What works by mouse

| Gesture | By mouse | Notes |
|---|---|---|
| Tap | click | |
| Long-press (tiles, episode rows, season pills) | hold the left button 500 ms, **or right-click** | Right-click sends a synthetic 600 ms touch hold. The Claude in Chrome `computer` tool has no press-and-hold, so use `right_click`. The release after the hold is swallowed, so it can't hit a menu item |
| Edge swipe back | drag from the leftmost ~20 px of the screen to the right | `left_click_drag` from x ≈ device left + 3. Releasing past 35 % commits the pop. The panel button does the same |
| Sheet dismiss | drag the grabber/head, or the body at scrollTop 0, downwards | |
| Player double tap ±10 s | `double_click` on the left or right half | Taps keep adding while the run lasts |
| Player swipe down to close, scrubber drag | mouse drag | Pointer events; the controls must be hidden for the swipe |
| Pinch (player fit ↔ fill) | `+` / `-` keys (focus in the app: click it first; the frame page also forwards them) or the panel | Synthetic two-finger touches on `.vr-stage` |
| Player keys | Esc closes, Space pauses, ←/→ seek | These already exist in `Player.svelte` |
| Vertical scroll | wheel (`scroll` action) | |
| Horizontal rails | shift+wheel / `scroll` left or right | A mouse drag does **not** scroll a rail. A synthetic touch can't start native scrolling |

**How it works.** A left-button mouse drag also dispatches synthetic
`touchstart`/`touchmove`/`touchend` on the element it started on. Edge swipe,
the sheet body drag and pinch listen to touch only. A drag that moved swallows its click, so
starting on a tile doesn't open it. Long-press, double tap,
the player surface and the sheet grabber already use pointer events, which fire for the mouse.
Text selection and native image/link drag are suppressed during a drag.

## Several agents at once

The Claude-in-Chrome tools drive the user's one real Chrome. Only one agent uses them at a time:
take the lock with `mkdir /tmp/claude-1000/chrome-lock` (and write your name + `date +%s` into
`chrome-lock/owner`); if `mkdir` fails, do code work or check in your own headless Chrome and try
again later. Hold it for one short session (≤ 8 min) in a tab of your own, then close the tab and
`rm chrome-lock/owner && rmdir chrome-lock`. An owner file older than 15 min is a crashed holder.
Each agent runs its own server with hot reload off (`HMR=0 PORT=<own port> phone/dev-chrome.sh`),
so edits by the others don't reset its page.

## Limits

- **No real video playback.** It is blocked on purpose (see the guard above) and would not
  decode anyway. The player UI can be exercised with **trailers** (Trailer button on a detail
  page), which play through MSE in desktop Chrome with subtitles. When a trailer fails,
  including when you go offline mid-trailer, the app falls back to opening YouTube in a new tab.
- **iOS-only behaviour can't be reproduced:**
  - PiP, AirPlay and rotation lock (the player's "Turn your iPhone" hint shows in portrait)
  - real `env(safe-area-inset-*)`
  - momentum scrolling and rubber-banding
  - `:active` timing and the haptics from `navigator.vibrate`
  - standalone display mode and the service worker (dev has none)
  - fonts: the system face is not SF Pro
- **Hot reload** resets navigation (see above).
- **Claude in Chrome's `screenshot`** captures the whole window. Use `zoom` with the device's
  rectangle to crop it. Resize the window to about 1100×1000 so the device is shown at 100 %.
- **Nothing here stops a context-menu action from writing state.** Mark watched and Remove from
  Continue Watching are real actions: undo them if you try them.
