# Claude Design brief — VibeReel for iPhone

> Paste everything below the line into Claude Design. Attach 3–5 screenshots of the TV app
> (Home, a series page, the player OSD) so the brand carries over.

---

## Who this is for and what it is

**VibeReel** is my personal Jellyfin client. It exists today as a TV app (LG webOS, 10-foot UI,
D-pad remote). I want the same app on my **iPhone 15** as an installable **PWA** (Add to Home
Screen, standalone display mode). Single user household (me + a few accounts), no public release,
no App Store.

All functionality already exists and stays the same. **Your job is the phone UI and UX**: turn a
remote-driven TV interface into a touch-first phone app. I will implement your design myself in
Svelte 5 with one global stylesheet, so I need precise, transplantable HTML/CSS — not a Figma
description.

## Brand (keep it)

- Near-black background, **gold `#e6b450`** accent, cinematic backdrops, glass capsules for
  chrome. Wordmark "VibeReel".
- Premium, calm, content-first: posters and backdrops carry the page, chrome stays out of the way.
- Dark only is fine. Respect iOS conventions where they help (bottom tab bar, sheets, swipe
  back, safe areas, Dynamic Island, home indicator) but it should feel like VibeReel, not a
  stock UIKit app.

## Device and platform constraints

- iPhone 15: **393 × 852 pt** portrait, 852 × 393 landscape, Dynamic Island, 3× display.
- Standalone PWA: no Safari chrome; you own the status-bar area (`viewport-fit=cover`, use
  `env(safe-area-inset-*)`). Status bar style is black-translucent (white text over content).
- Browse screens are **portrait**. The player is **landscape** (iOS won't let a web app lock
  orientation — design a graceful portrait state for the player too, and a "rotate" hint).
- Touch targets ≥ 44 pt. No hover states. Pressed states instead of focus rings.
- System font stack (`-apple-system`, SF Pro) is fine; if you want a display face for titles /
  wordmark, it must be a Google Font.
- Icons: inline SVG, 24 pt grid, one consistent stroke style. Deliver them as SVG source.

## Screens and features to design

For each: the portrait layout, loading (skeleton) state, empty state, and error state
("Couldn't reach the server" + Retry) where it applies.

1. **Login** — server address, username, password; list of remembered accounts to pick from.
2. **Home**
   - Hero: large backdrop of the most recent in-progress title with *Resume* (progress bar,
     "S2 · E4 · 23 min left") — swipeable between a few hero items.
   - Rails: **Continue Watching** (landscape thumbs with progress, tap = play immediately,
     long-press = remove with Undo), **Next Up** (same behaviour), **Recently added** movies /
     shows, **Trending · Shows** and **Trending · Movies** (titles NOT in the library yet —
     badge "Not in library", tap opens a page with *Add to library*).
3. **Library** (Movies tab, Shows tab) — paged poster grid (3 columns?) with sort (Recently
   added / New episodes / Title / Release date / Rating, asc/desc) and filters (genre,
   unwatched). Titles that are **still downloading** appear first as dimmed posters with a
   live progress ring / % badge; titles in the library that have episodes downloading get a
   small badge.
4. **Movie detail** — backdrop, logo/title, year · runtime · rating · certification, genres,
   overview; buttons Play/Resume, Trailer, Watched toggle; **tech badges** (4K · Dolby Vision ·
   DD+ Atmos · 5.1 · subtitle languages); cast rail (→ Person page); **Collection** rail
   ("<Franchise> Collection · 4 films · 1 in your library", non-library films addable); More Like This.
5. **Series detail** — as above plus season picker (pills or segmented) and episode list:
   still, "E4 · Title", runtime, overview (2 lines), progress bar, watched check. Episodes that
   are still downloading appear inline, dimmed, with live % ; a season that exists only in the
   download queue gets a dimmed pill. Long-press an episode or season = mark watched/unwatched.
6. **Person** — photo, bio, filmography grid.
7. **Search** — search field + results as poster grid (library and non-library titles mixed,
   non-library ones badged). With the field empty: **Browse categories** — IMDb Top 250 Movies,
   Top 250 Shows, and "best rated" per genre, each a card with a fan of 3 posters; opening one
   shows a ranked grid (#1, #2 … badge).
8. **Not-in-library detail** — same layout as movie/series detail, but the primary button is
   **Add to library** (then becomes "Queued" / "Downloading 43%"). Un-added shows have no
   episode list.
9. **Downloading detail** — a title that is being downloaded: same layout, but the primary
   button is a greyed live status "43% · 7.4 MB/s · 1:11:24 left". When the download finishes
   while the page is open, it flips to "Now in your library — Open".
10. **Notifications (bell)** — two sections: **Ready to watch** ("<Series> · Season 2 · 8 new
    episodes", time) and **New seasons** (aired: *Get* button; upcoming: premiere date; already
    downloading: live %). Unseen count badge on the bell.
11. **Account switcher** — avatar menu: accounts on this device, switch, add account, sign out.
    Plus **Settings** (e.g. "Skip recaps automatically", default subtitle behaviour,
    streaming quality on cellular: Original / 8 / 4 Mbit/s).
12. **Player** (the most important one; landscape first)
    - Controls overlay (tap to show/hide, auto-hide): title + episode line, close, scrubber with
      elapsed / remaining, play/pause, ±10 s, **Audio** and **Subtitles** pickers (sheet listing
      tracks like "English · DD+ 5.1 Atmos", "German · AC3 5.1", subs "English · Forced",
      "English · SDH", "Off"), Chapters, AirPlay, Picture-in-Picture, lock-controls.
    - **Scrubbing with trickplay thumbnails** (a 320×180 preview above the thumb while dragging).
    - Double-tap left/right half = −10 / +10 s; vertical swipe for nothing (iOS owns
      brightness/volume) — tell me if you'd do otherwise.
    - **Skip Intro / Skip Recap / Skip Credits** chip bottom-right, visible even when controls
      are hidden.
    - **Up Next** card at the credits: next episode thumb + title + 10 s countdown ring,
      "Play now" / dismiss.
    - Loading card (backdrop + title + spinner), **Buffering…** with an optional hint line
      ("This file needs about 36 Mbit/s; the phone is getting about 13."), and error card
      ("Playback stalled" + Retry).
    - Graphic subtitles (PGS) are drawn on a canvas layer over the video — keep the bottom
      15% of the frame free of permanent chrome.
    - Portrait state of the player (video letterboxed at top, info below, or just a rotate hint).
    - Trailer mode: same player, stripped down (no audio/sub pickers).
13. **Global**: bottom tab bar (Home · Movies · Shows · Search?), where the bell and avatar
    live, toasts (with an optional Undo), offline banner ("Not connected to your server —
    is Tailscale on?"), pull-to-refresh on Home and Library.

## Navigation & interaction — decide and document

- Tab structure and where Search, bell and avatar go.
- Push navigation with iOS edge-swipe back (I'll implement it with the View Transitions API /
  CSS transitions); Back always returns to the exact scroll position and tile.
- What opens as a sheet vs a full page (track pickers, sort/filter, bell, accounts?).
- Long-press menus (remove from Continue Watching, mark watched) — a context-menu style or an
  action sheet.
- Motion: durations/easings as tokens. Keep motion cheap (transform/opacity only).

## Output format — what to hand back

Plain **HTML + CSS only**. No React, no Tailwind, no build step, no JS frameworks (a few lines of
vanilla JS for toggling states in the prototype are fine). I will lift the markup into Svelte
components and the CSS into one global stylesheet, so:

1. **`tokens.css`** — every design decision as CSS custom properties on `:root`: colors
   (semantic names: `--bg`, `--surface-1`, `--text-dim`, `--gold`, `--danger` …), type scale
   (size / line-height / weight / letter-spacing per role: `--t-hero`, `--t-title`, `--t-body`,
   `--t-caption` …), spacing scale, radii, shadows/blur for glass, z-layers, motion durations +
   easings, poster/thumb aspect ratios and sizes, safe-area helpers.
2. **`components.css`** — styles for every component, **global class names** (BEM-ish, e.g.
   `.tile`, `.tile--landscape`, `.tile__progress`), using only the tokens. No per-screen
   one-off magic numbers; if a value repeats, it's a token.
3. **`screens/NN-name.html`** — one static file per screen *and* state (e.g.
   `04-movie-detail.html`, `04-movie-detail--loading.html`,
   `12-player--controls.html`, `12-player--upnext.html`, `12-player--portrait.html`), each
   linking `../tokens.css` and `../components.css`, rendered at **393×852** (landscape player:
   **852×393**) inside a device frame that shows the Dynamic Island and home indicator safe
   areas. Use realistic content (real show/movie titles, German + English track names), not
   lorem ipsum. Mark every component root with `data-component="Tile"` etc.
4. **`index.html`** — a gallery linking all screens as thumbnails, grouped by feature.
5. **`icons/`** — each icon as its own SVG (24×24 viewBox, `currentColor` stroke) plus
   `icons.html` showing them all with names.
6. **`SPEC.md`** containing:
   - **Component inventory**: for each component — anatomy, variants, states (default,
     pressed, disabled, loading/skeleton, downloading, watched), dimensions, and **which data
     fields it shows** (e.g. Tile: poster, title, year, progress 0–1, played, download %).
   - **Navigation map**: tabs, push/sheet/modal per screen, what Back does from each screen.
   - **Gestures**: every tap / long-press / swipe / double-tap, per screen.
   - **Motion**: each transition, its duration + easing token.
   - **Player behaviour**: when controls show/hide (timings), what's visible with controls
     hidden, how pickers open, portrait vs landscape.
   - **Responsive notes**: what changes between 375 and 430 pt widths (SE-sized up to Pro Max).
   - **Open questions / assumptions** you made that I should confirm.

Put it all in one folder / zip with exactly that structure.
