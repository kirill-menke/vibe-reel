# VibeReel Phone — polish & native-feel backlog

Eight parallel audits (2026-09-30, against `a0b4197`) produced **139 tasks** in the files below.
This index is the entry point for the implementation swarm: it merges the duplicates, settles the
conflicts, and splits the work into lanes that don't fight over the same files.

| File | Area | IDs | Tasks |
|---|---|---|---|
| [motion-system.md](motion-system.md) | Tokens, springs, press feedback, image/skeleton loading, numbers, haptics — **read first** | MOT- | 19 |
| [navigation.md](navigation.md) | Push/pop, swipe-back, bars, tab bar, scroll-to-top, VoiceOver focus | NAV- | 16 |
| [pwa-shell.md](pwa-shell.md) | Launch screens, selection/callouts, pinch, state restore, SW updates, icon badge | PWA- | 17 |
| [home.md](home.md) | Hero carousel, rails, tiles, long-press, snapshot paint | HOME- | 14 |
| [library-search.md](library-search.md) | Library grid, Search field, Charts, quick-add | LIB- / SRCH- | 15 |
| [detail.md](detail.md) | Title pages, stretchy hero, seasons, download states | DET- | 18 |
| [player.md](player.md) | Present/dismiss, gestures, scrubber, overlays, Now Playing | PLY- | 20 |
| [sheets-settings.md](sheets-settings.md) | Sheets, context menu, toasts, switches, Downloads, Login, Settings | SHT- CTX- TST- DL- ACT- LGN- ACC- SET- SW- HAP- SEG- EMP- | 20 |

Every task carries Kind / Priority / Effort / Files / Now / Change / Why / Constraints / Verify /
Depends. Each file also has a **"Considered and rejected"** list — read it before adding anything, the
restraint is deliberate.

---

## Rules for every implementer

1. **TV stays byte-identical.** Any change in shared `src/lib` goes inside `if (__PHONE__)`. After
   your lane: `npx vite build` passes and `grep -c -e 'VibeReel Phone' -e main.m3u8 -e ManagedMediaSource dist/app.js` prints 0.
2. **Phone build passes:** `npx vite build --config phone/vite.config.js`. (⚠️ PWA-17: the
   `sw-precache` plugin writes `phone/dist/sw.js` even with another `--outDir`. Don't build into
   `phone/dist` from a lane unless you're the one deploying.)
3. **Use the tokens from MOT-01** (`--spring-*`, `--dur-*`, JS `DUR`/`EASE`/`SPRING`/`spring()` in
   `phone/src/lib/safe.js`). No new literal durations or easings.
4. **Reduced motion:** every new motion has a `prefers-reduced-motion` path, via the MOT-13 helper in JS.
5. **Nothing runs while idle.** Animations that loop are finite (a few cycles) or hidden with
   `visibility`/`[hidden]`. Animate `transform`/`opacity` only; don't animate layout properties.
6. **Press states use `.pressing`** (MOT-02), never new `:active` rules.
7. **Shared CSS files** (`components.css`, `app.css`, `tokens.css`) are edited by several lanes:
   make targeted `Edit`s in your own sections only, re-read before each edit, never rewrite a file.
8. **Never mutate the real server** in dev (played, add, Get, cancel, hide, delete, playback reports,
   sign-out). Each agent runs its own dev server: `HMR=0 PORT=<own> phone/dev-chrome.sh`, headless
   Chrome over CDP; Claude in Chrome only with the lock (`phone/DEV-CHROME.md`).
9. **Update the docs you change the contract of**: `docs/ios/ARCHITECTURE.md`, `PHONE-API.md`,
   `UX-AUDIT.md`, and the CLAUDE.md iPhone section when a finding is worth keeping.
10. When done, mark the task in its file: append `— ✅ done` to the `###` heading (plus a one-line
    note under it if the result differs from the proposal), or `— ⏭ skipped: <reason>`. Don't commit —
    the orchestrator reviews and commits between waves only if the user asks.
11. **Fix bugs you trip over** on the way, even if no task names them, and note them in your report.
12. The "Needs the user's call" items are **not built in this round** (mark them `⏸ awaiting decision`).

---

## Duplicates — one canonical task each

Implement the **canonical** task and fold in what the others add; mark the others `→ merged into X`.

| Topic | Canonical | Merged in |
|---|---|---|
| Spring/motion tokens + JS `spring()` helper | **MOT-01** | NAV-02's `spring()` in `safe.js` (same file, one helper) |
| No selection / image callouts / loupe on chrome | **PWA-03** | MOT-14, DET-04 (detail keeps `.selectable` opt-ins only for overview/file info) |
| Native `<input switch>` for the real haptic | **MOT-08** | PWA-09, SW-01 (SW-01's UISwitch proportions + thumb stretch go into the fallback look) |
| Segmented control sliding thumb | **MOT-07** | LIB-03, SEG-01; LIB-04 then *uses* it |
| Glass bars fade in their blur | **NAV-03** | MOT-09 (material values from MOT-09, `::before` layer approach from NAV-03) |
| iOS scroll indicator on pages | **PWA-10** | MOT-15 |
| Idle-running animations (rotate hint, paging spinner) | **MOT-12** | PLY-05, LIB-06 |
| Quick-add "+" → spinner → ✓ | **LIB-02** | HOME-10 (same `Tile.svelte` button, one look) |
| Large title stretches on pull-down | **NAV-12** | LIB-07 |
| Paint last-known Home on cold/offline start | **HOME-03** | PWA-07 (PWA-07's `api.js` `seedStore` hook + banner copy are the mechanism) |
| Long-press build-up → lift → drop-back | **CTX-01** | MOT-04 (start values/curve), HOME-06 (Home's cell wrapper `--lifted`) |
| Resume bars glide after watching | **HOME-07** | DET-13 resume part (tick pop stays in DET-13) |
| Up Next countdown ring | **PLY-11** | MOT-11 countdown part (MOT-11 keeps the generic ProgressBar/Ring changes) |
| Bell badge pop + tabular count | **NAV-13** | MOT-10 badge part |
| "Add account" Login as a modal | **LGN-02** | NAV-16 |
| Stop dimming on every keystroke / fast answers | **LIB-01 + SRCH-02** | do together (same class) |

## Conflicts & decisions already made

- **HAP-01 (programmatic `haptic()`) is superseded — don't build it.** Two auditors independently found
  that the hidden-switch `label.click()` trick was patched in **iOS 26.5** (WebKit bug 309082), and the
  phone runs iOS 26. Only a *real tap* on a real `<input type=checkbox switch>` still ticks → MOT-08.
  Remove the dead `navigator.vibrate` calls (MOT-02). Long-press, drag thresholds and destructive
  confirmations get **visual** feedback only. The tasks that list HAP-01 as a dependency (CTX-02, DL-01,
  DL-02, ACT-01, LGN-02) drop that part.
- **NAV-07 vs NAV-11:** NAV-07 (passive listeners, edge strip) first — it needs an iPhone check (the
  busy-loop test in the doc). NAV-11 (swipe back from anywhere) is P3 and only if NAV-07's approach
  holds; it then uses passive listeners + `touch-action` as described there.
- **NAV-08 vs PWA-12 (scroll to top):** both. NAV-08 (tap the bar) is dependable; PWA-12
  (tap the status-bar strip) is an experiment layered on the same `R.toTop`.
- **DET-01 vs DET-03 vs MOT-05 (image fades on the hero):** the hero fades `opacity` on the `<img>` and
  transforms `.art`. MOT-05's generic `Art` fade **skips backdrops** so the fade isn't applied twice or
  fought by the tile→page zoom.
- **One brand flourish only:** MOT-17's single gold sheen. LGN-02's "brand moment" on Login and any Home
  wordmark idea have to be *that* sheen, not a second one.

## Needs the user's call before building

- **HOME-14** — show the title's logo art instead of the serif title in the hero (changes the app's look).
- **NAV-04** — push/pop 380 → ~500 ms; compare both on the iPhone.
- **SHT-04** — medium/large sheet detents (Effort L).
- **HOME-13 / DET-18** — scroll-timeline parallax/fade that only exists on Safari 26+ (fine on the user's phone, no-op before).
- **DET-14** Share button, **SRCH-04** recent searches, **DL-03** storage meter, **SET-01** "signature" line — new UI, small but visible.

## iPhone-only checks (can't be verified in desktop Chrome)

MOT-08 (haptic + `accent-color`), NAV-07 (scroll blocking), NAV-12 (negative `scrollTop` during
rubber-band), PWA-01 (launch images), PWA-05/06 (kill + update restore), PWA-08 (icon badge),
PWA-12 (status-bar tap), PLY-15 (AirPlay subs), PLY-18 (lock screen), PLY-20 (caption style), CTX-02
(the rail must not scroll under a menu drag), DET-01 (rubber-band feel), everything "feels 60/120 fps".
Batch them into one on-device session after deploying (`./phone/deploy.sh`) and record the results
in the task files.

---

## Execution plan

### Recommended scope (restraint)

The user asked for "not too much". **Wave 0 + all P1s + the P2s marked ★ below** is a complete,
coherent pass (~60 tasks after merging). The remaining P2/P3s are a later round, if the result feels
like it needs more rather than less.

★ P2s worth doing in the first round: MOT-06, MOT-07, MOT-08, MOT-10, MOT-13, NAV-04, NAV-05, NAV-08,
NAV-09, PWA-08, PWA-10, HOME-05, DET-05, DET-06, DET-09, DET-10,
DET-11, DET-12, PLY-09, PLY-10, PLY-11, SHT-03, CTX-01, TST-02, DL-01, ACT-01.

### Wave 0 — foundation (one agent, sequential; everyone else waits)

Touches almost every shared stylesheet, so it goes first and alone:
**MOT-01** (tokens + JS mirror incl. `spring()`), **MOT-02** (press controller), **MOT-03** (pressed look),
**PWA-03** (+MOT-14, DET-04), **PWA-04** (pinch), **MOT-12** (+PLY-05, LIB-06), **MOT-13** (reduced-motion helper).
Gate: both builds pass, TV grep = 0, a dev-frame scroll over Home rails shows no press flash.

### Wave 1 — parallel lanes (one agent each, split by file ownership)

| Lane | Owns (exclusive in this wave) | Tasks |
|---|---|---|
| **A · Navigation** | `App.svelte` (route transitions + sheet host + player host + login modal), `router.svelte.js`, `gestures.js` `edgeSwipeBack`, `TabBar`, `NavBar`, `TopBar`, `zoom.js` | NAV-01, 02, 03(+MOT-09), 04, 05, 06, 08, 09, 12, 13, 14; **SHT-01** (App's sheet effect), **PLY-01 host part** (`.playerhost` transparent + `dismiss()` hook), LGN-02 host part |
| **B · Home** | `Home.svelte`, `carousel.js`, `home.css`, `Tile.svelte`, `Art.svelte` | HOME-01…05, 07, 08, 11, 12; LIB-02 (+HOME-10), LIB-09; MOT-05 (Art fade — same file as HOME-05) |
| **C · Library & Search** | `Library.svelte`, `Search.svelte`, `Chart.svelte`, `Grid.svelte`, `Segmented.svelte`, `library.css` | LIB-01+SRCH-02, SRCH-01, 03, 04, 05, 06, MOT-07 (+LIB-03, SEG-01), LIB-04, LIB-05, LIB-08 |
| **D · Detail** | `screens/*Detail.svelte`, `Person.svelte`, `components/detail/*`, `detail.css` | DET-01…03, 05…17 |
| **E · Player** | `phone/src/player/*`, `player.css`, `__PHONE__` parts of `src/lib/player.svelte.js` | PLY-02…20 (PLY-01 Player.svelte part), PLY-11 (+MOT-11 countdown) |
| **F · Sheets & settings** | `Sheet.svelte`, `ContextMenu.svelte`, `Toast.svelte`, `Switch.svelte`, `List`/`Row`, `sheets/*`, `Settings`, `Downloads`, `Login`, `offline.css`, new `ActionSheet.svelte` | SHT-02, TST-01, TST-02, LGN-01, LGN-02, MOT-08 (+SW-01, PWA-09), CTX-01 (+MOT-04, HOME-06 hook), CTX-02, DL-01, DL-02, ACT-01, ACC-01, SET-01, EMP-01, DL-03 |
| **G · Shell** | `index.html`, `make-icons.sh`, `public/` (splash, icons, `sw.js`), `main.js`, `lifecycle.js`, `vite.config.js`, new `restore.js`/`badge.js`/`homesnap.js`, `tokens.css` contrast block | PWA-01, 06, 08, 10 (+MOT-15), 11, 13, 14, 15, 16, 17; PWA-07's `api.js` hook for HOME-03 (hand the API to lane B) |

Hand-offs inside wave 1 (message the other lane's agent rather than editing its files):
B needs G's `seedStore` for HOME-03; E needs A's `.playerhost`/`dismiss()` for PLY-01/02; F's SHT-02
needs A's SHT-01; B's HOME-06 lift needs F's CTX-01 API; D's DET-07 overrides A's NavBar material.

### Wave 2 — cross-lane tasks (after wave 1 merges)

PWA-02 + PWA-05 (boot mount + state restore: App.svelte + router, touches lane A's code), SHT-03
(page scale-back behind sheets: App.svelte stage wrapper), HOME-09 (hero → detail continuity:
`zoom.js`), NAV-07 → NAV-11, NAV-10, NAV-15, PLY-07 (player pickers on the shared Sheet), SHT-04,
MOT-10, MOT-16, MOT-17, MOT-18, and the user-decision items once decided.

### Wave 3 — sweep & verify (one agent)

MOT-19 (migrate remaining literal durations/easings to tokens across all files), a reduced-motion
pass over every screen, an idle check (no running animations on any browse screen or in portrait
playback — `document.getAnimations()` empty after 5 s idle), both builds + the TV grep, docs updated,
then deploy (`./phone/deploy.sh`, **with the user's go-ahead**) and the batched iPhone checks above.

---

## Wave 0 notes for lanes

Wave 0 is done: MOT-01, 02, 03, 12, 13 and PWA-03, 04. It also absorbed MOT-14, DET-04, PLY-05 and
LIB-06, plus NAV-02's `spring()`. The TV bundle is byte-identical (Wave 0 touched nothing in `src/`).

**CSS tokens** (`phone/src/styles/tokens.css`, Motion block):

- **Springs:** `--spring-smooth`, `--spring-snappy`, `--spring-bouncy`. These are real `linear()`
  curves under `@supports`, with cubic fallbacks for iOS 17.0–17.1. Under Reduce Motion,
  snappy/bouncy become `--ease-out`, so there's no overshoot.
- **Durations:** `--dur-spring-quick` (420 ms) and `--dur-spring` (700 ms) are *settle* times. The
  motion reads as done at ~55 %. `--dur-release` equals `--dur-spring-quick`, and `--dur-img` is 220 ms.
- **Other tokens:** `--ease-standard` (UIKit's curve, for cross-fades ≥ 200 ms), `--press-dim` (0.14),
  `--press-scale-sm` (0.9) and `--press-delay` (70, unitless, read by `press.js`).
- **Pairs:** see the "Which class uses which" table in motion-system.md.

**JS** (`phone/src/lib/safe.js`):

- `DUR.{press, fast, base, push, sheet, sheetOut, ctx, springQuick, spring, release, img, rm}` (ms)
- `EASE.{out, in, inout, sheet, standard, spring}` (WAAPI strings; `spring` stays until MOT-17)
- `SPRING.{smooth, snappy, bouncy}`: WAAPI strings. The `linear()` curve is used only where it's
  supported, so it never throws.
- `springEase.{smooth, snappy, bouncy}`: `t → x` functions for Svelte `transition:`/`animate:`
  `easing`. They're the same curves as the tokens.
- `spring(v0 = 0, response = 0.35)` returns `{ duration, frames: [{offset, p}] }`. It's a critically
  damped settle that starts at the finger's speed. `v0` = finger px/ms ÷ remaining px, toward the
  target (negative = away). `p` is clamped to 0…1. Map `p` onto your own keyframes and run them
  with `easing: 'linear'` (example in the doc comment). For finger releases: edge swipe, zoom drag,
  sheet drag.
- Reduced motion:
  - `reducedMotion()` returns a bool. Use it and don't copy it: `gestures.js` and
    `router.svelte.js` no longer have their own copies.
  - `rm(ms)` returns `ms`, or 0 under Reduce Motion.
  - `rmOut(ms)` returns at least 1. Use it for every **outro** (App.svelte: never `duration: 0` in a
    keyed-each outro group).
  - A `<script module>` has to import these itself.
- `easeSheet` and `easeInout` are JS easing functions of the tokens. `carousel.js` and `zoom.js`
  import them.

**Press states** (`phone/src/lib/press.js`, wired in `main.js`):

- There are no `:active` rules any more, and don't add any. A pressable gets `.pressing` after
  70 ms. A move over 8 px, `pointercancel` or a scroll of an ancestor cancels it without animation
  (`.press-cut`). A quick tap still flashes for 90 ms.
- **To opt an element in, add its class to `SEL` in `press.js`.** Then style
  `X.pressing` (press-in: `--dur-press` + `--ease-out`) and put the release in X's base rule
  (`--dur-release` + `--spring-snappy`). Use the full `transition` shorthand in the pressed rule,
  as components.css does.
- The innermost pressable wins, so `.tile__add` presses and its `.tile` doesn't.
- `SKIP` covers `[disabled]`, `[aria-disabled=true]`, `.tile--self`, skeleton tiles and
  `.episode--preview`.
- The controller never touches `.is-pressed`. That class stays the static "held" state a screen
  sets itself (Home's resolving tile).
- **Looks:**
  - Artwork (tile frame, cast photo, category card) scales and gets a black veil `::before` at
    `--press-dim`. Tiles put it under the badges (`--z-media-ui − 1`). Don't reuse
    `.tile__frame::before` / `.cast__photo::before` / `.catcard::before`.
  - Rows (`.row`, `.episode`, `.notif`, `.option`, `.ctx__item`) light up at once and fade out over
    `--dur-base`.
  - Text buttons dim to 0.55.
- **Lane notes:**
  - F: MOT-08 `.switch` and MOT-07 `.seg__opt` are already in `SEL`; only their looks are missing.
  - F: MOT-04's `.holding` must out-rank `.tile.pressing .tile__frame` (0,3,0).
  - B: LIB-02 can restyle `.tile__add.pressing`.

**Selection** (`app.css`):

- `body` has `user-select: none`, `-webkit-touch-callout: none`, and `img` has
  `-webkit-user-drag: none`.
- These are selectable again: `input, textarea, select, [contenteditable]`, **`.selectable`**, and
  `.state--error .state__text`.
- The opt-ins already in the markup are `Overview.svelte` (all overviews and the person bio),
  MovieDetail's `.kv` list and Settings → About (Server, Version). Put `class="selectable"` on
  anything else worth copying.
- `.no-callout` and the per-component opt-outs are now redundant but harmless.

**Zoom** (`app.css`, `main.js`):

- `html { touch-action: pan-x pan-y }`, and `main.js` cancels `gesturestart`/`gesturechange`.
- Anything that needs its own pinch must use touch events on an element with `touch-action: none`,
  as the player stage does.

**Idle:**

- `.spinner` loops forever, so only mount it while loading. There's a comment on the rule.
- The rotate hint now runs 3 alternating turns and rests at −90°.
- Library's paging sentinel shows its spinner only while a page is in flight (`more`).
- Still infinite and left for MOT-06: `.skel`'s pulse.

**Measured in the dev server** (headless Chrome, CDP touch, 393×852):

- No `.pressing` during fast or moderate horizontal rail drags (the rail scrolled 232 px), a
  vertical Home scroll started on a tile, or fast and moderate Library grid scrolls.
- A 60 ms tap gave `.pressing` on and off 90 ms later, and the zoom push still ran.
- A still hold gave `.pressing` at about 70 ms, then a cut with no transition on a 40 px move.
- `document.getAnimations()` was empty after 5 s idle on Home, Library and a movie detail page.
- The selection probe found no selectable text outside the opt-ins on Home, Library, Search or
  detail.

---

## Wave 3 sweep

Done: MOT-19, a reduced-motion pass, an idle pass and the sheet flick exit. Both builds pass. The TV
bundle is byte-identical (`app.js` a48f9174…, `style.css` 9209f54f…, grep 0).

**Tokens** (`safe.js` / `tokens.css`):

- Added `DUR.zoom`/`DUR.zoomOut` (460/420, the tile → page zoom, JS-only like `sheetOut`),
  `DUR.hero` (6000, mirrors `--dur-hero`), `easeDismiss` (the JS easing of `EASE.dismiss`) and
  `fling(v, dist, full)`.
- Removed the dead `--ease-spring`/`EASE.spring` and `--dur-ctx`/`DUR.ctx`: the context menu lifts on
  `SPRING.bouncy`/`DUR.springQuick` since CTX-01.
- Migrated: `zoom.js` (open/close, the backdrop fade 200 → `DUR.img`, the content fade 180 →
  `DUR.fast`), `carousel.js` (RM 180 → `DUR.rm`, the glide 700 → `DUR.spring`), Home's hero timer, and
  App's/Player's hand-made `bezier()` copies.

**Literals left on purpose** (the MOT-19 grep):

- Instants: `0s`, `1ms`, `duration: 0/1` (outro sentinels, `.press-cut`).
- Floors and clamps on computed durations: App `Math.max(60, …)` / `Math.max(160, …)` and the `+20`
  outro slack, the carousel release clamp `220…560`, the zoom drag `Math.max(200, …)`.
- Stagger offsets: ContextMenu menu `delay: 60`, the loading card title `delay: 40`, the chevron wave
  `80ms`/`160ms`, Downloads' `DUR.base + 80` beat.
- Periods tied to real time: `.spinner` 0.9 s per turn, the Up Next ring's `1s linear` (one countdown
  second per second), and the rotate hint's one-off `1.2s … 600ms × 3`.
- Shared code: `src/lib/player.svelte.js` `OSD_HIDE_PHONE = 3500` (`--dur-hide`). It stays: the TV
  bundle must not change.

**Reduced motion** (CDP `setEmulatedMedia` reduce + `rm=1`; every WAAPI call, CSS transition and CSS
animation that moves something is logged per step).

- Gaps fixed:
  - `.wordmark--short` scaled 34 → 28 px on scroll. It now sizes at once.
  - `.navbar__title` still started a `none → translateY(0)` transform transition, and with it a layer.
  - Fades are kept, not cut, as on iOS: the player's controls, loading card, `.vr-fadeable`, subtitle
    opacity, buffering ring and seek flash (all "no fade" before, PLY-08/09), the toast text swap,
    and Search's clear button.
- Left moving under Reduce Motion, on purpose: press feedback (the `.pressing` scale and its release,
  which is state feedback, and the release loses its overshoot via `--spring-snappy` → `--ease-out`),
  the loading spinner, and finger-driven motion (drags, edge swipe).
- Reduce Motion walk, all clean: Home (top, scrolled), Movies, SortFilter, a movie detail
  (+ scrolled), Person, Shows, series detail with a season switch, Search browse / results /
  cancel, a chart, Notifications, Accounts, Settings, Downloads, the context menu (opacity 180 ms
  both ways), the trailer player (open, landscape, controls, close) and every push/pop/tab switch.
  The only motion logged was press releases and the spinner.

**Idle** (`getAnimations()` after 6 s, minus finished animations with no fill; 393×852 headless Chrome):

| Screen | Result |
|---|---|
| Home top / scrolled, Movies, Shows | empty |
| Movie detail (+ scrolled), Series detail (+ season switch), Person | empty |
| Search browse, Search results (39 tiles), a chart (250 tiles) | empty |
| SortFilter, Notifications and Accounts sheets open, Settings, Downloads | empty |
| Context menu open | empty |
| Trailer, portrait, controls hidden (rotate hint rested) | empty, playing |
| Trailer, landscape, controls hidden / after show → auto-hide | empty, playing |

**Sheet flick exit:** see SHT-02 (sheets-settings.md). A spring aimed a whole sheet away ran ~3× the
finger's step. `fling()` continues at the finger's speed: 25 px/frame → 27, 34, 41 …, and the
slow-release and scrim-tap exits are unchanged. Bug fixed on the way: a finger that rested before lifting
still carried its last move's speed, so it counted as a flick.

A near miss worth knowing: tapping the `.ctx` container "to close" a context menu hits whichever
item is under its centre. The walk hit **Remove from Continue Watching**. That hide is local-only
(`homehide.js`, no network), and the entry was deleted again. Close menus in scripts with
`.ctx__backdrop.click()`.
