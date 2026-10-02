# VibeReel for iPhone — design spec

Phone UI for the VibeReel Jellyfin client as a standalone PWA on iPhone 15 (393 × 852 pt portrait, 852 × 393 pt landscape). Functionality is unchanged from the TV app; this spec covers layout, components, navigation, gestures, motion and the player.

**Files**

- `tokens.css` — every value as a custom property on `:root`.
- `components.css` — global BEM-ish classes using tokens only. Section 18 (device frame) is prototype-only; do not ship it.
- `screens/NN-name.html` — one file per screen/state, rendered inside a device frame. Every component root carries `data-component="…"`.
- `index.html` — gallery of all screens grouped by feature.
- `icons/*.svg` + `icons.html` — 24 × 24 viewBox, `stroke="currentColor"`, 1.75 stroke, round caps/joins. `play`, `pause` are filled shapes; `back-10`/`fwd-10` numerals use 1.5 stroke.

Images in the prototype are tonal placeholders (`.art` painted from `--a1/--a2/--a3`, with poster lettering in `.art__label`). In the app `.art` wraps an `<img>` (`.art > img` is already styled); drop the placeholder custom properties and the label.

---

## 1. Foundations

| Area | Decision |
|---|---|
| Colour | Near-black `--bg #0a0a0c`, three surfaces, warm white text in three strengths (`--text`, `--text-dim` 72 %, `--text-faint` 56 %, ≥ 4.5:1 on `--bg`/`--surface-1`). One accent `--gold #e6b450`; gold marks *the* primary action, progress, active tab, selection. `--danger` only for errors and destructive menu items. |
| Glass | Chrome over content (icon buttons, tab bar, badges, player chips) = `--glass-bg` / `--glass-bg-strong` + `--glass-blur` + 1 px inset `--glass-line`. |
| Type | SF (system stack) for UI; **Instrument Serif** (Google Font) for the wordmark, hero, detail and tab-root titles, poster lettering and chart ranks. Roles are font-shorthand tokens + a matching `-ls` tracking token (`--t-hero`, `--t-title`, `--t-large`, `--t-heading`, `--t-headline`, `--t-body`, `--t-callout`, `--t-tile`, `--t-caption`, `--t-micro`, `--t-badge`, `--t-button`, `--t-input`, `--t-num`). Inputs are 17 px so iOS never zooms. Timecodes use `tabular-nums`. |
| Spacing | 4-pt scale `--s-1…--s-16`; page gutter 20; rail gap 10; grid gaps 10 × 18; section gap 28. |
| Radii | badge 4 · tech 6 · poster 8 · thumb 10 · card 14 · field 12 · sheet 22 · pill 999. |
| Touch | Every target ≥ 44 pt. Visually smaller controls (`.btn--sm` 36, `.chip` 34, `.pill` 36, `.closebtn` 30, `.tile__add` 30) extend their hit area with a `::before/::after` inset. |
| States | No hover. `:active` scales to `--press-scale` (0.96) and darkens; `.is-pressed` draws the same statically. |
| Safe areas | `--safe-top/right/bottom/left` = `env(safe-area-inset-*)`; helpers `--page-top`, `--page-bottom` (clears the floating tab bar), `--tabbar-bottom`. Custom properties resolve where declared, so anything that overrides `--safe-*` (like the prototype frame) must re-declare the helpers. |

`<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` and `apple-mobile-web-app-status-bar-style = black-translucent` are in every screen head.

---

## 2. Component inventory

Dimensions are at 393 pt width. "Data" lists the fields each component renders.

### App shell
- **Screen** `.screen` — the scroll container for one page. `padding-bottom: --page-bottom`. Modifiers: `--no-tabbar`, `--below-topbar`, `--below-navbar` (static mid-scroll mocks). `.spacer-navbar` = nav-bar height as a flow element (use when a child is `position: sticky`, because sticky insets are measured inside the scroller's padding).
- **TopBar** `.topbar` — tab roots. Left: wordmark (Home) or large serif title (Movies, Shows, Search). Right: bell + avatar. `--overlay` sits over the hero; `--solid` is the glass state after scrolling (wordmark shrinks to 24). `--large` for titled roots. Height = safe-top + 52.
- **NavBar** `.navbar` — pushed pages. 3-column grid: glass back button · title (hidden until `--solid`) · trailing slot. Turns `--solid` once the backdrop has scrolled under it.
- **TabBar** `.tabbar` — floating glass capsule, 4 items × 76 × 54, centred, `bottom: --tabbar-bottom`. Item: icon + 10 pt label; active = gold on `--gold-soft`. `.tabbar-fade` gradient sits under it on scrolling pages.
- **IconButton** `.iconbtn` — 44 circle, glass. Variants `--plain`, `--surface`, `--on`. Optional `.iconbtn__badge` (gold count, 18 high). Data: icon, label, count.
- **AvatarButton / Avatar** — 36 circle (32 sm, 64 lg) with initial; colour per account via `--av`.
- **Wordmark** — "Vibe" in text colour, "*Reel*" in gold italic. 30 pt, 56 pt on Login.

### Buttons & actions
- **Button** `.btn` — 50 high pill. `--primary` gold, `--glass`, `--surface`, `--text` (gold text, 44 high), `--danger`, `--block`, `--grow`, `--sm` (36), disabled (40 % opacity).
- **Status button** `.btn--status` — the live download/queue state in place of the primary button: greyed, non-interactive, `.btn__fill` width = `--p`, `.btn__pct` in gold. Text: `43% · 7.4 MB/s · 1:11:24 left` or `Queued · waiting for a slot`. Data: percent, rate, ETA, queue state.
- **ActionBar** `.actions` / `.action` — secondary actions under the primary button: 44 circle icon + caption (Trailer, Watched, From start). `.action--on` = gold (e.g. watched).

### Media
- **Tile** `.tile` — anatomy: `__frame` (art, overlays) + `__title` + `__sub`.
  - Variants: `--poster` (2:3, 116 wide in rails, fluid in grids), `--landscape` (16:9, 252 wide), `--fluid`.
  - Overlays: `__progress` (bar, bottom), `__play` (glass 30 circle; landscape tiles that play on tap), `__badge` (top-left; `--bottom`), `__corner` (top-right: watched tick or episodes-downloading badge), `__rank` (charts), `__add` (quick add, bottom-right), `__overlay` (centred ring / queued).
  - States: default, pressed (frame scales), `--watched` (tick, art 72 %), `--downloading` (art 34 %, desaturated, ring with %), `--queued` (clock + "Queued"), skeleton (`.skel--poster` / `.skel--thumb` + line).
  - Data: poster/thumb, title, year or episode line, progress 0–1, played, download % and rate, queue state, in-library flag, rank, episodes-downloading count.
- **ProgressBar** `.progress` + `__fill` (`--p` 0–1). 3 high, gold on 22 % white.
- **ProgressRing** `.ring` — 44 (64 `--lg`), SVG with `pathLength="100"`, `--p` drives `stroke-dashoffset`. `--glass` backs it with a disc. Label = percent.
- **Badge** `.badge` — 20 high, 11 pt semibold, glass. `--gold`, `--outline`, `--pill`, `--rank` (serif numeral, gold for #1–3).
- **WatchedTick** `.tick` — 22 gold disc with check; `--hollow` for unwatched where a slot must be kept.
- **TechBadges** `.techbadges` / `.tech` — 22 high outlined; `--strong` for 4K / HDR format. Data: resolution, HDR format, audio codec, channels, subtitle languages.
- **Art** `.art` — image slot; `__label` placeholder lettering.

### Home
- **Hero** `.hero` — 572 high including status bar. Backdrop + `--scrim-hero`. Body: eyebrow ("Continue watching" / "New in your library"), serif title (or clearlogo), meta line, progress row ("S2 · E4 · 23 min left"), Resume + Details, pager dots. Data: backdrop, logo, title, episode title, S/E, time left, progress.
- **Rail** `.rail` — head (title + optional grey qualifier + "See all") and a horizontal snap-scroller with 20 pt inset.
- **ContextMenu** `.ctx` — blurred backdrop, lifted preview card, 312-wide menu, hairline-separated items, `.ctx__sep` group gap, `--danger` item.
- **Toast** `.toast` — glass pill above the tab bar: icon, text, optional gold action (Undo). `--no-tabbar` in the player/login.
- **OfflineBanner** `.banner` — glass card above the tab bar: danger icon, "Not connected to your server" + "Is Tailscale on?…", Retry.
- **PullToRefresh** `.ptr` — 40 disc with spinner under the status bar; content follows (`.pulled`, `--ptr-offset` 64).

### Library & search
- **LibraryToolbar** `.chips` — sort chip (`--strong`, sort icon + field + chevron) then filter chips (`--on` = gold outline). `.chips--wrap` inside sheets.
- **Count** `.count` — "412 movies · 2 downloading".
- **PosterGrid** `.grid` — `--grid-cols` 3, gaps 10 × 18. Tile width ≈ 111 pt on iPhone 15.
- **SearchField** `.search` — 50 high field, search icon, 17 pt input (gold caret), clear button drawn as iOS's filled `xmark.circle`; `--focus` gold ring; "Cancel" text button while searching. Entering / leaving search mode moves (title lifts away, field rises and narrows, Cancel rides in on its edge — polish SRCH-01).
- **Chart filter** — All / Not in library / In library is a **Segmented** control, not chips (polish LIB-04, a deliberate deviation from `07-search--ranked.html`: one of three views of one list is a segmented choice; chips stay for independent toggles like Unwatched).
- **CategoryCard** `.catcard` — 164 high card with a fan of three 58-wide posters (−11° / 0 / +11°), title, sub.
- **PageHeader** `.pagehead` — eyebrow, large serif title, sub (charts, settings).

### Title pages
- **Backdrop** `.detail__hero` 440 high + scrim; **DetailHeader** `.detail__body` overlaps it by 128.
- Header contents in order: optional eyebrow badge (Not in library / Queued / Downloading), serif title, **MetaLine** `.meta` (year · runtime/seasons · ★ rating · certification box), genres, resume row, primary button (+ `.detail__note`), ActionBar, overview (3-line clamp + "More"), TechBadges.
- **CastCard** `.cast` — 76 circle photo, name (2 lines), role.
- **CollectionRail** — rail head with title + "5 films · 2 in your library"; non-library posters carry the badge and a `.tile__add` button; the current film gets a gold "This film" badge.
- **SeasonPicker** `.pills` — 36 pills: `--active` (light fill), watched season shows a tick, `--dim` for a season that only exists in the download queue (outlined, shows %). `--sticky` pins under the solid nav bar.
- **EpisodeRow** `.episode` — 150-wide 16:9 still + "E4 · 50 min" + title + status line; overview (2-line clamp) spans the full width below. States: default, in progress (bar on still, "31 min left"), `--watched` (tick), `--downloading` (dim, ring + "Downloading · 9 min left"), `--queued` (dim, clock, "Queued"), pressed.
- **DetailsList** `.kv` — director, audio tracks, subtitles, file.
- **PersonHeader** — 132 photo, serif name, facts; bio clamp; filmography grid with filter chips; tile sub = role.

### Sheets & settings
- **Sheet** `.sheet` — surface-1, 22 radius, grabber, head (title + close or text action), scrolling body, optional foot. Medium = content height; `--large` = safe-top + 12 from the top. Lists inside use `--surface-2`.
- **List / Row** `.list`, `.row` — 52 min height, hairlines inset 16 (`--inset-sep` aligns with avatars). Parts: `__icon` (30 tile), `__main` (`__title`, `__sub`), `__value`, `__trail`, `__check`. Modifiers: `--selected` (gold title + check), `--danger`, `--action`, `--column` (label above a control).
- **Switch** `.switch` 51 × 31, `--on` gold. **Segmented** `.seg` — 40-high options, active raised.
- **NotificationRow** `.notif` — 44 mini poster, title, sub ("Season 2 · 8 new episodes"), time; trailing chevron, **Get** button, ring (downloading) or premiere date. `--unseen` = gold dot at the left edge.
- **Field** `.field` — label above, 50-high box with icon; `--focus`, `--error` (danger ring + hint).

### States
- **Skeleton** `.skel` — opacity pulse only (`vr-pulse`), variants `--poster --thumb --line --line-lg --pill --circle --hero`.
- **StateMessage** `.state` — 64 icon disc, heading, body, actions. `--error` (danger disc), `--fill` (centred in the page), `--card` (inline card).
- **Spinner** `.spinner` 22 / 32 — rotate only.

### Player
- **Player** `.player` — black stage; `__video`, `__subs` (the PGS canvas band, bottom `--subs-band` 15 %), `__controls` (fades), `__top`, `__center`, `__bottom`.
- **Transport** `.pbtn` 52 glass circles, `--lg` 72 for play/pause.
- **Scrubber** `.scrubber` — times (tabular) either side of a 4-high track: buffer, gold fill, chapter ticks (`--at`), intro/credits segment (`__mark`, `--from/--to`), 14 thumb. `--active`: 8-high track, thumb ×1.45, times gold.
- **TrickplayPreview** `.trick` — chapter name, 224 × 126 frame (320 × 180 source at 70 %, white 2 pt ring), time.
- **PlayerChip** `.pchip` — 40-high glass chip: icon + value + dim detail (Audio "English DD+ 5.1 Atmos", Subtitles "English SDH", Chapters).
- **SkipChip** `.skipchip` — light pill, dark text ("Skip Intro / Skip Recap / Skip Credits"). Bottom-right above the subtitle band; `--raised` when controls are visible.
- **SeekFeedback** `.seekflash` — half-moon ripple on the tapped side with chevrons and the accumulated amount.
- **TrackPicker** `.panel` — right-anchored glass panel, two columns (Audio | Subtitles) of `.option` rows (check, title "English · DD+ 5.1 Atmos", sub "Original / PGS · image-based").
- **ChapterPicker** `.panel--narrow` — options with 96-wide thumb, title, sub, time; current = selected with progress.
- **UpNextCard** `.upnext` — 320 wide: 124 thumb with countdown ring around a play glyph, eyebrow "Up next in 3 s", title, sub, Play now + Watch credits.
- **PlayerStatusCard** `.pcard` — buffering (spinner + hint line), error (danger icon, "Playback stalled", Retry / Close).
- **PlayerLoading** `.pload` — blurred backdrop, show eyebrow, serif episode title, "S2 · E4 · resuming at 26:14", spinner; close stays available.
- **LockIndicator** `.lockpill` — gold lock disc + "Controls locked / Press and hold to unlock".
- **PlayerPortrait** `.pport` + **RotateHint** `.rotatehint`.

---

## 3. Navigation map

**Tabs:** Home · Movies · Shows · Search. Each tab keeps its own push stack and scroll positions; tapping the active tab pops to root, tapping it again scrolls to top.

**Bell and avatar** live top-right on every tab root (Home, Movies, Shows, Search), not in the tab bar.

| From | Target | Presentation | Back / dismiss |
|---|---|---|---|
| Login | Home | replace (no back) | — |
| Any tab root | Movie / Series / Not-in-library / Downloading detail | push | edge-swipe or back → previous page at the same scroll offset, same tile |
| Detail | Person | push | back → detail |
| Detail / Person / Search | Another title | push (stack grows) | back one level |
| Search browse | Chart / genre ranked grid | push | back → Search with the field state kept |
| Bell | Notifications | large sheet | swipe down, close, or tapping a row (sheet closes, then pushes the target on the current tab) |
| Avatar | Accounts | medium sheet | swipe down / close |
| Accounts → Settings | Settings | sheet closes, Settings pushes on the current tab | back → previous page |
| Accounts → Add account | Login | full-screen modal | Cancel |
| Library sort chip / Genre chip | Sort & filter | large sheet with sticky "Show N" | swipe down applies nothing; "Show N" applies |
| Long-press tile / episode / season | Context menu | overlay | tap outside |
| Resume / Play / tile tap in Continue Watching & Next Up | Player | full-screen modal (tab bar hidden) | close (X), swipe down in portrait → back to where it was opened |
| Trailer | Player, trailer mode | full-screen modal | close |
| Player → Audio/Subtitles, Chapters | Side panel (landscape) / bottom sheet (portrait) | overlay | tap outside or close |

Scroll restoration: keep a `Map<routeKey, {scrollTop, focusedItemId}>` per tab stack; on pop, restore before the view transition's new snapshot is captured so the back animation lands on the exact tile.

---

## 4. Gestures

| Screen | Gesture | Result |
|---|---|---|
| Everywhere pushed | edge-swipe from the left 20 pt | interactive pop |
| Home hero | horizontal swipe | next/previous hero item (auto-advance every `--dur-hero`, paused while touching) |
| Home, Library | pull down past 64 pt | refresh |
| Continue Watching / Next Up tile | tap | play immediately |
| … | long-press (500 ms) | context menu: Play from beginning · Go to show · Mark as watched · **Remove from Continue Watching** → toast with Undo (5 s) |
| Recently added / grid poster | tap | detail; long-press → Mark watched/unwatched · Go to show |
| Trending / non-library poster | tap | Not-in-library detail; `+` quick add adds without leaving the page (toast with Undo) |
| Library grid | tap sort chip | sort sheet; tap filter chip toggles in place |
| Episode row | tap | play (from progress); long-press → Play · Mark as watched/unwatched · Mark E1–En as watched · Mark season as watched |
| Season pill | tap | switch season; long-press → Mark season watched/unwatched |
| Downloading/queued episode | tap | nothing (row is `aria-disabled`); long-press → Cancel download |
| Sheets | drag grabber down | dismiss |
| Player | single tap | toggle controls |
| … | double-tap left / right half | −10 / +10 s, repeated taps accumulate (+20, +30) within 700 ms |
| … | drag scrubber | seek with trickplay preview; controls other than the bottom bar fade |
| … | vertical swipe | **down to close** (portrait and landscape, when controls are hidden); nothing else — iOS owns brightness/volume via Control Centre |
| … | pinch | toggle fit ↔ fill (crop to the full 19.5:9 width) |
| … | long-press lock pill (1 s) | unlock |

---

## 5. Motion

Only `transform` and `opacity` animate (plus `stroke-dashoffset` for rings and `width` for the status-button fill, both on tiny layers).

| Transition | Duration | Easing |
|---|---|---|
| Pressed scale | `--dur-press` 110 ms | `--ease-out` |
| Chip / tab toggle, nav bar solidify, title fade | `--dur-fast` 180 ms | linear / `--ease-out` |
| Push / pop (View Transitions: new page `translateX(100%→0)`, old `0→-30%` + opacity .6) | `--dur-push` 380 ms | `--ease-sheet` |
| Sheet present / dismiss (translateY) | `--dur-sheet` 440 ms / 300 ms | `--ease-sheet` / `--ease-in` |
| Context menu lift (scale 1 → 1.03, menu scale .9 → 1 + fade) | `--dur-spring-quick` 420 ms (settle; was `--dur-ctx` 300, retired in Wave 3) | `--spring-bouncy` (was `--ease-spring`) |
| Toast in (translateY 16 → 0 + fade), out | `--dur-base` 260 ms | `--ease-out` |
| Player controls show / hide | `--dur-base` 260 ms | `--ease-out` |
| Skip chip rise when controls appear | `--dur-base` | `--ease-out` |
| Hero cross-fade | `--dur-base` | `--ease-inout` |
| Skeleton pulse | 1.4 s loop | `--ease-inout` |
| Spinner | 0.9 s loop | linear |

Respect `prefers-reduced-motion`: replace push/sheet slides with a 180 ms cross-fade and stop the skeleton pulse.

---

## 6. Player behaviour

- **Orientation.** Designed landscape-first. iOS won't lock orientation for a web app, so the player listens to `orientationchange` / a `(orientation: portrait)` media query and swaps layouts. Portrait: 16:9 video under the status bar with compact controls, info below (episode, Audio / Subtitles / Chapters chips), a rotate hint card and Up Next episodes.
- **Controls show** on open, on tap, on pause, and while scrubbing or a picker is open. **Auto-hide** after `--dur-hide` (3.5 s) of no touch while playing. Never hidden while paused, buffering, or in an error.
- **Visible with controls hidden:** video, subtitle layer, Skip chip (while its segment is active), Up Next card, status cards, lock pill (only for 2 s after a tap in lock mode).
- **Subtitle band.** Nothing permanent sits in the bottom 15 % (`--subs-band`). When controls are visible the bottom bar temporarily overlaps it; the PGS canvas keeps drawing underneath (no shifting of image subtitles).
- **Skip chip** appears when entering an intro/recap/credits segment (Jellyfin media segments), stays up for the whole segment, `--raised` above the bottom bar when controls show. With "Skip recaps automatically" on, recaps skip and a toast "Skipped recap · Undo" appears instead.
- **Up Next** replaces Skip Credits: appears at the credits segment (or 30 s before the end), ring counts 10 s → auto-plays unless Autoplay is off. "Watch credits" dismisses for this episode.
- **Pickers.** Audio and Subtitles open the same two-column side panel (landscape) so both can be changed in one visit; in portrait it is a bottom sheet with a segmented Audio | Subtitles switch. Chapters open a narrower panel. Opening a picker keeps playback running and dims the video (`--video--dim`).
- **Lock** hides all chrome and ignores taps except a tap anywhere → lock pill for 2 s; long-press the pill to unlock.
- **Buffering** card appears after 1 s of stalled playback; the hint line only when the server reports a bitrate mismatch. **Error** after 15 s stalled or a fatal error.
- **Trailer mode:** same component with `player--trailer`: no audio/subtitle/chapter chips, no lock, no Skip/Up Next; eyebrow "Trailer".
- **AirPlay / PiP:** use the native `webkitShowPlaybackTargetPicker()` and `requestPictureInPicture()` on the `<video>`.

---

## 7. Responsive notes (375 → 430 pt)

| Item | iPhone SE / mini (375) | iPhone 15 (393) | Pro Max / Plus (430) |
|---|---|---|---|
| Gutter | 16 | 20 | 20 |
| Grid | 3 cols, tiles ≈ 107 | 3 cols ≈ 111 | 3 cols ≈ 123 (keep 3; 4 is too small for titles) |
| Rail poster / thumb | 108 / 236 | 116 / 252 | 124 / 272 |
| Hero height | 520 (SE: 460, no island, `--safe-top` 20) | 572 | 620 |
| Tab item width | 72 | 76 | 84 |
| Episode still | 136 | 150 | 164 |
| Player (landscape) | 667 × 375 on SE: hide chip labels' dim detail, transport gap 32 | as designed | 932 × 430: panel 600 |

Implement with one `@media (max-width: 380px)` and one `(min-width: 420px)` block that only reassigns tokens (`--gutter`, `--poster-w-rail`, `--thumb-w-rail`, `--hero-h`, `--tabbar-item-w`, `--still-w`).

---

## 8. Open questions / assumptions

1. **Display face.** I paired SF with Instrument Serif for titles and the wordmark. If the TV app already has a wordmark face, swap `--font-display` and `--t-wordmark`.
2. **Tab set.** Home · Movies · Shows · Search, with bell + avatar on every tab root. No separate Downloads tab — downloads surface inline (library first row, badges, bell). Tell me if you want a queue view.
3. **Search scope.** Assumed search covers library + addable titles in one grid, with "Not in library" badges. People are not in results (reached via cast).
4. **Chart data.** Assumed IMDb Top 250 and "best rated per genre" come from your backend with a rank and in-library flag.
5. **Notifications** "Get" starts the season download directly (no confirm); toast with Undo.
6. **Up Next secondary action** is "Watch credits" instead of a bare "Dismiss" — same behaviour, clearer label.
7. **Vertical swipe** in the player = swipe down to close; pinch = fit/fill. Nothing for brightness/volume.
8. **Queued titles** in the library grid sort after downloading ones; both before the normal sort.
9. **Server name / accounts** on the mocks (`nas.example.ts.net`, Lena, Gast) are placeholders.
10. **Offline banner** sits above the tab bar rather than under the status bar, so the header (bell, avatar, back) stays reachable.
