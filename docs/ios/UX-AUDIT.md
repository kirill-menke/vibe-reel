# VibeReel Phone — cross-cutting UX / accessibility audit

2026-09-30, ux-system. Measured in headless Chrome (393×852, 375×667, 852×393 landscape, text at
115 % and 124 %) with scripted checks: every visible control's hit box incl. `::before/::after`
extensions, CSS contrast of every text node against its composited background, pixel contrast
(screenshot ring sampling) for text over images, accessible names, headings, horizontal overflow.
Plus one Claude-in-Chrome pass on the long-press menu. iOS-only behaviour (real Dynamic Type,
VoiceOver itself) is not verifiable here.

Severity: **H** breaks use / clearly fails WCAG AA · **M** noticeable friction · **L** polish.

## Findings

| Sev | Where | Measured | Fix / status |
|---|---|---|---|
| H | Whole app — text size | All type in px: a root font-size bump (or iOS Text Size) changed nothing | **Fixed.** Type roles are `calc(N * var(--tu))`, `--tu = clamp(.88px, 1rem/17, 1.24px)`; root 17px, on touch WebKit `font: -apple-system-body` (Dynamic Type). Identical at default; follows iOS Text Size up to +24 %. Wordmark, rank badge, poster lettering, tab labels stay px (as iOS does). Checked Home, Library, Search, Chart, Movie/Series detail, Person, sheets, Settings at 124 % on 393 and 375: no overflow; long row titles wrap where `wrap` is set. `--t-input` floored at 16px (no zoom). |
| H | `.switch` (Settings, 5×) | hit 51×31 | **Fixed** — `::before` inset → 63×45 |
| H | Home hero: wordmark / gold eyebrow on bright backdrops | "Reel" 1.1:1, eyebrow 2.3:1 (pixel) | Fixed by ux-home (`home.css` scrim + text-shadow, `app.css` wordmark shadow) — token `--scrim-hero` left unchanged |
| M | `.seg__opt` (Settings, player) | 40 high | **Fixed** — `::after` over the track padding → 44 |
| M | `.chip` "All" (Chart, Sort sheet) | 41×44 | **Fixed** — `min-width: var(--tap)` |
| M | `--t-micro` labels (group labels, eyebrows, badges) | 10px, below iOS's 11pt floor | **Fixed** — 11px, tracking .06em |
| M | Long-press menu | thick `.ctx__sep` between "Open" and "Mark as watched" (Library) | **Fixed in ContextMenu** — a `sep` renders only before a destructive item (design: before "Remove…"); otherwise hairline. `role="separator"` |
| M | Long-press menu close | once, in the Chrome frame, the faded `.ctx` stayed mounted (backdrop opacity 0) and swallowed every tap | **Hardened** — `close()` also finishes on a 400 ms timer if WAAPI `onfinish` never fires |
| M | Poster with no / broken image (e.g. an obscure lookup result) | empty tonal frame | **Fixed** — `Art` `label` prop letters the title in serif (`.art__label`, ≤4 lines) when the image is missing or fails; `Tile` passes its title |
| M | Landscape: sheet close button | at x = 821 of 852, inside the 59pt right inset | **Fixed** — `.sheet__head` right padding adds `--safe-right`; `.topbar`/`.navbar` too |
| M | Landscape Library/Search/Chart grids | content starts at x = 134 (gutter already includes the inset **and** `library.css` adds `padding-left: var(--safe-left)`) | **Open — ux-library**: drop the extra `padding-left/right: var(--safe-*)` in `library.css` (the landscape `--gutter` in `app.css` covers it) |
| M | Settings: "Notify me when downloads ar…" | truncated at 393 | **Fixed** — rows renamed ("Ready to watch", "New seasons") with a sub line; `Row wrap` |
| L | Settings grouping / copy | one-row "Audio" group; per-series note under Audio only; streaming foot a dense paragraph | **Fixed** — Languages (Audio, Subtitles) · Subtitles (mode, size) · Streaming with a hint for the picked cap · Notifications with subs |
| L | Focus rings | only `.tile/.row/.btn` had one | **Fixed** — gold `:focus-visible` ring on every primitive (hardware keyboard, Switch Control) |
| L | Reduced motion | `.rotatehint` icon rotated forever; dots/progress width transitions | **Fixed** — static under `prefers-reduced-motion` (push/sheet/hero/skeleton were already handled) |
| L | `ProgressBar` | `role=progressbar` without a name | **Fixed** — `label` prop, default "Watched" |
| L | `Badge label` | `aria-label` on a bare span (not announced) | **Fixed** — `role="img"` when labelled |
| L | Sheets: page and tab bar behind stay in the a11y tree | route not `inert` while a sheet/ctx is up | **Open — App.svelte**: set `inert` on `.stage` and `.tabbar` while `R.sheet` or the player is up (the ctx menu is a portal) |
| L | Long-press–only actions | Remove / Mark watched / Cancel download reachable only by hold | Open — VoiceOver's double-tap-and-hold works; consider mirroring them on the detail page |
| L | Px type left in other areas | `home.css` landscape hero title 36px, `player.css` 22px/11px | Open — fine to keep (fixed layouts), or `calc(N * var(--tu))` |
| — | Contrast of token pairs | `--text-faint` on bg/surface-1/2/3 ≥ 4.9:1; gold on bg 9.8:1; text-on-gold on gold ≈ 9:1 | Pass (only disabled controls at 40 % fall below, which WCAG exempts) |
| — | My library trash button (2026-10-05) | `iconbtn` 44×44 beside the row (never inside its `<button>`), red glyph; `aria-label` "Delete <title>"; disabled + row dimmed while its delete runs | Pass (pinned by `59-phone-mylibrary`) |
| — | Touch targets elsewhere | Home, Library, Search, Chart, detail pages, Person, Notifications, Accounts, Sort sheet: 0 below 44 after the fixes above | Pass |
| — | Accessible names / headings / alt | 0 unnamed controls; one `h1` per screen; `img` alt present | Pass |

## Settings after the pass

Playback (skip recaps, skip intros, autoplay — with one-line explanations) · Languages (Audio,
Subtitles — native picker over the row) · Subtitles (Forced only / Automatic / Always, Size) ·
Streaming (Original / 8 / 4 Mbit/s, the foot explains the picked cap) · Notifications (Ready to
watch, New seasons, test send) · About.
