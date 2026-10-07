# Detail screens — polish and native-feel tasks

The title pages already have their structure right. Serif titles sit over a scrimmed backdrop. The tile → page zoom (`lib/zoom.js`) handles the page swap mid-animation. The nav bar turns solid when the header passes under it, and the season pills pin under it. The long-press menus have real previews, and every async load is epoch/generation-safe.

The gaps are the in-between moments:
- Pulling down on a page shows a black band above the backdrop.
- Search/Trending titles open on the poster and then jump to the fanart.
- On a fast network the skeleton flashes for about 90 ms. On a slow one, content and backdrop pop in with no fade.
- Season changes swap the list in one hard cut.
- The live download state jitters, remounts the Download action, and makes VoiceOver chatter.

Detail text is selectable like a web page. A few real bugs also turned up: the pill strip snaps back every activity poll, the Download action is recreated on every progress tick, and pending rows are mixed into the old season's list.

Measured in headless Chrome at 393×852 against the dev server (LAN, 2026-09-30). On a movie push the skeleton showed from 9 to 80 ms, then the title, then the backdrop at 118 ms. On a series, the episode skeleton rows showed from 104 to 176 ms. On a lookup page the hero showed the poster at 154 ms and switched to the fanart at 254 ms.

## Tasks

### DET-01 · Stretch the backdrop on pull-down, and give it a gentle parallax — ✅ done
- **Result:** Built as proposed (`heroScroll` in DetailHero, CSS in detail.css). Rubber band is iPhone-only; in the dev server 0 → 439 px drifts the art 0 → 131.7 px, ≥ H resets it, `rm=1` never drifts. Unzoom from a scrolled page measured: the overlay's first frame sits where the parallaxed art was (−84 vs −83 px at scroll 120), so no reset was needed.
- **Kind:** native · **Priority:** P1 · **Effort:** M
- **Files:** `phone/src/components/detail/DetailHero.svelte` (new action on `<header class="detail__hero">`), `phone/src/styles/detail.css` (`.detail__hero`, `.detail__hero > .art`, `.detail__scrim`)
- **Now:** The hero is ordinary content inside the `.screen` scroller. `.screen` has `overscroll-behavior-y: contain` (components.css:58), which still rubber-bands on iOS. A pull-down at the top therefore drags the backdrop down and shows `--bg` above it: a flat black band under the glass back button. Scrolling up moves the backdrop 1:1 with the text. This applies to Movie, Series, Lookup and Pending pages.
- **Change:**
  - Add an action `heroScroll` in DetailHero. It finds `node.closest('.screen')` and adds a passive `scroll` listener that writes one transform per event, only while `y < H` (H = the hero's `offsetHeight`, read once and again on resize):
    - `y < 0` (rubber band): `art.style.transform = scale(${(H - y) / H})` with `transform-origin: 50% 100%`. Apply the same transform to `.detail__scrim` so the dark foot stays aligned. The image grows upward from its bottom edge and fills the gap exactly, as in the Apple TV app and Music album headers.
    - `0 ≤ y < H`: `translate3d(0, ${y * 0.3}px, 0)` on the art only (not the scrim). The backdrop drifts slower than the text.
    - `y ≥ H`: write once to reset, then stop writing until `y < H` again.
  - CSS: replace `.detail__hero { overflow: hidden }` with `overflow: visible; clip-path: inset(-100vh 0 0 0)`. The top may overflow into the rubber-band gap. The bottom and sides stay clipped, so the parallaxed image never shows below the scrim. `.screen` already has `overflow-x: hidden`, so the wider scaled image adds no horizontal scroll. Add `will-change: transform` on `.detail__hero > .art` (one 393×440 layer; the scrim can share it).
  - Skip the parallax (but keep the stretch) while `node.closest('.route')?.classList.contains('zoom-hide')`. The zoom overlay stands in for the hero pixel for pixel, and its swap would jump by `y * 0.3`.
- **Why:** Every native media app stretches its header on overscroll. A black band opening above a photo is the clearest sign of a web page on these screens.
- **Constraints & risks:**
  - Under reduced motion: no parallax. The stretch follows the finger directly rather than playing an animation, so keep it.
  - The work is one `style.transform` write per scroll event, with no layout reads in the handler.
  - The main-thread transform lags the UI-thread scroll by about one frame on iOS. At fast flicks a 1–2 px sliver of `--bg` may flash at the top edge. If it does, also give `.detail__hero::before` a `bottom: 100%; height: 50vh; background: #0a0a0c` to match the scrim's 0.55 black top.
  - Unzoom (pop into the tile, `zoomOut`) measures `.detail__hero`. Reset the art transform when a pop starts from a scrolled page, or accept a small jump. Verify.
  - The landscape hero (`min(var(--backdrop-h), 66dvh)`) works the same way. Read H from the element, not the token.
- **Verify:** iPhone only for the rubber band (headless Chrome has no bounce). In the dev frame, check that scrolling 0 → 440 px drifts the backdrop and that nothing shows below the scrim. With `rm=1`, check there is no drift.
- **Depends on / conflicts with:** DET-03 (the hero fade must not fight this transform: fade `opacity` on the `<img>`, transform the `.art`). Navigation auditor (NavBar solid point is unchanged). Home auditor: if Home's hero adopts the same stretch, share the action.

### DET-02 · Stop the poster → fanart jump on Lookup and Pending pages — ✅ done
- **Result:** With `/ml/api/metadata` delayed 700 ms: placeholder (440 high) → fanart fading in at ~800 ms, the poster never shows; with a 2.5 s backend the 1.2 s net falls back to the poster, then the fanart dissolves over it.
- **Kind:** bug · **Priority:** P1 · **Effort:** S
- **Files:** `phone/src/screens/LookupDetail.svelte` (`bg`, `loadMeta`), `phone/src/screens/PendingDetail.svelte` (`bg`, `loadMeta`), `phone/src/components/detail/DetailHero.svelte` (new `pending` prop)
- **Now:** `bg = fanartUrl(meta?.fanart || meta?.poster || item.poster)` (LookupDetail.svelte:59, PendingDetail.svelte:99). Before `mlMetadata()` answers, the hero shows the portrait poster, center-cropped to 393×440. Then it switches with a hard cut to a completely different image, the fanart. Measured: poster at 154 ms, fanart at 254 ms on the LAN; longer on Tailscale and for cold TMDB images. After a zoom this is worse: the overlay crossfades into the poster, finishes, and the fanart then replaces it.
- **Change:**
  - Add `metaDone = $state(false)`, set in `loadMeta`'s `finally`, whether it succeeds or fails. `mlMetadata` has a session promise cache, so a repeat visit settles almost at once.
  - `bg = metaDone ? fanartUrl(meta?.fanart || meta?.poster || item.poster) : null`.
  - Give DetailHero a `pending` prop that keeps the full 440 height and the tonal placeholder (not `detail__hero--empty`, which would collapse to the short band and then jump back to 440). No pulse is needed.
  - Safety net: `setTimeout(() => (metaDone = true), 1200)` so a slow backend still falls back to the poster.
- **Why:** A native page never shows a stand-in image and then swaps it for the real one. It waits briefly on a neutral placeholder, then fades the real image in (DET-03).
- **Constraints & risks:** The zoom already waits up to `LINGER_MS` 2.5 s for a hero image, so it handles the null → fanart order. No TV code is touched.
- **Verify:** Dev frame: Search → a trending title, then Back and open it again. The hero goes placeholder → fanart only; the poster never appears. Throttle the network in CDP (`Network.emulateNetworkConditions`, 400 ms latency) to see the fallback timing.
- **Depends on / conflicts with:** DET-03.

### DET-03 · Hand off from skeleton to content without a flash or a pop — ✅ done
- **Result:** The hero skeleton never pulses (a static surface-1 block; no full-size animating layer). `late` also reaches DetailHero, so a late page's backdrop dissolves in even when it lands with the item. 400 ms latency: skeleton text from 275 ms, body + backdrop dissolve at ~430 ms; zoom opens get neither fade.
- **Kind:** craft · **Priority:** P1 · **Effort:** M
- **Files:** `phone/src/screens/Detail.svelte`, `phone/src/components/detail/DetailSkeleton.svelte`, `phone/src/components/detail/DetailHero.svelte`, `phone/src/screens/SeriesDetail.svelte` (`.detail__epskel` block), `phone/src/styles/detail.css`
- **Now:**
  - Detail.svelte:73–75 mounts `DetailSkeleton` at once. Its text lines and action circles pulse, then the real page replaces it in one hard cut. On the LAN that is a gray flash of about 70–90 ms inside a 380 ms slide (measured).
  - SeriesDetail's three skeleton episode rows (SeriesDetail.svelte:537–540) flash for about 70 ms the same way.
  - The backdrop `<img>` appears the moment `use:decoded` sets `src`. When it arrives after the push has landed (slow link, 1280 w backdrop), it pops over the tonal placeholder.
  - `zoom.js` fades the swapped-in content itself (its MutationObserver, zoom.js:387), but only during a zoom. Slide pushes and loads that finish after the zoom get nothing.
- **Change:**
  1. **Delay the skeleton's text parts.** Add `.detail__skel-late { animation: vr-fade-in 200ms var(--ease-out) 250ms both }` on DetailSkeleton's `.detail__body` and on the `.detail__epskel` rows. The hero placeholder (`.skel--hero`, surface-1) shows at once and does not pulse for its first 400 ms. Fast loads then never show gray bars.
  2. **Fade in content that arrives late.** Detail.svelte records `mountedAt = performance.now()`. If the item lands more than 250 ms later and the route is not `.zoom-card`, give the page a `detail--late` class: `.detail--late .detail__body, .detail--late .detail__body ~ * { animation: vr-fade-in 220ms var(--ease-out) both }`. Use opacity only; no translate, because the zoom already owns the rise.
  3. **Fade in a hero that arrives late.** In DetailHero, when `decoded` applies `src` after the hero has been on screen more than 150 ms and the route is not `.zoom-hide`, run `img.animate([{opacity:0},{opacity:1}], {duration: 240, easing: 'linear'})`. Never fade under `.zoom-hide`: the zoom's `finish('swap')` removes its overlay expecting the real hero to be fully opaque.
- **Why:** Native pages either show content at once or dissolve it in. Neither a flash of placeholders nor a hard pop reads as native. Under Reduce Motion iOS itself replaces motion with dissolves, so the fades stay.
- **Constraints & risks:**
  - The `vr-pulse` loop only runs while a skeleton is mounted; nothing runs when idle.
  - Add `@keyframes vr-fade-in { from { opacity: 0 } }` to detail.css (or use the motion auditor's shared keyframe if one is added).
  - Don't animate `.rail` tracks one by one; the one section-level opacity animation is enough.
- **Verify:** Dev frame. Open a movie by tile (zoom) and from Search (slide): no gray flash, and the content dissolves in. With CDP network throttling (400 ms), the skeleton lines appear about 250 ms in, then content and backdrop dissolve in. Script: the timing probe in `/tmp/claude-1000/polish-detail/s4.mjs`.
- **Depends on / conflicts with:** DET-01, DET-02. Motion-system auditor (generic image fade-ins, skeleton shimmer): the hero fade must not be applied twice if a global `img` load-fade is added via `lifecycle.js`'s capture `load` listener.

### DET-04 · Make title pages non-selectable, like native labels → merged into PWA-03
- **Kind:** native · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/styles/detail.css`
- **Now:** Only `.episode`, `.cast` and tiles set `user-select: none` / `-webkit-touch-callout: none` (detail.css:8, 35; components.css:378). Long-pressing the title, the meta line, the overview, the Details list, or the Person name and bio selects a word with blue handles and the "Copy · Look Up · Translate" callout. Long-pressing the person photo (`.person__photo > .art > img`, no overlay on top) opens iOS's image preview with "Save to Photos". The detail hero is safe only because `.detail__scrim` covers its `<img>`.
- **Change:**
  ```css
  .detail__body, .detail__kvsec, .person__head, .person__bio, .detail__hero {
    -webkit-user-select: none; user-select: none; -webkit-touch-callout: none;
  }
  .person__photo img, .detail__hero img { pointer-events: none; }
  ```
- **Why:** In UIKit, labels aren't selectable. Selecting page text is one of the tells users hit by accident while holding a finger to scroll.
- **Constraints & risks:** The Details list (file size, codec) could be worth copying, but native apps don't offer that either. If it's wanted, keep `.kv dd { user-select: text }` as a deliberate exception. No motion involved.
- **Verify:** iPhone: long-press the overview, the title and the person photo; no selection and no callout. In the dev frame, `getComputedStyle` shows `user-select: none`.
- **Depends on / conflicts with:** PWA-shell auditor, if they set a global `.screen { user-select: none }` policy (then this becomes redundant).

### DET-05 · Stop the season-pill strip from snapping back on every poll; place it instantly on open — ✅ done
- **Result:** a seven-season show + a fake queued Season 8: strip scrolled to 559 px stays there through 9 s of polls (before: slid back to 0 within one poll). A page opening on Season 6 lands positioned with no scroll animation.
- **Kind:** bug · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/components/detail/SeasonPills.svelte` (the "keep the active pill in view" `$effect`, lines 28–36)
- **Now:**
  - The effect reads `pills`, which SeriesDetail and PendingDetail rebuild as a new array whenever the activity feed changes. `pendSeasons` and `pendEps` are new arrays on every 4 s poll while anything of that show is downloading.
  - So on a show with more seasons than fit (7 pills: an 809 px strip in 393), every poll runs `el.scrollTo({left: centre of active, behavior: 'smooth'})`. A user who scrolled the strip to reach Season 6 is pulled back.
  - On first mount the same effect scrolls *smoothly*, so a page that opens on Season 5 visibly slides its pills after landing.
- **Change:**
  - `const activeKey = $derived(pills.find((p) => p.active)?.key ?? null)`. The effect depends on `activeKey` only (read `pills`/`el` via `untrack`).
  - First run: `behavior: 'auto'`. Later runs: smooth, or `'auto'` under reduced motion.
  - Skip the scroll when the active pill is already fully visible (`b.offsetLeft >= el.scrollLeft && b.offsetLeft + b.offsetWidth <= el.scrollLeft + el.clientWidth`). UIKit scrolls a selected segment/tab into view only when it's clipped.
- **Why:** Scroll positions only move because of the user. A strip that fights your thumb every 4 s feels broken.
- **Constraints & risks:** Removes a forced layout (`offsetLeft` read) per poll.
- **Verify:** Dev frame: open a show that has an episode in the download queue and more pills than fit. Scroll the strip right and wait 10 s; it stays. Reopen a show whose start season is past the fold; the strip is already positioned, with no slide.
- **Depends on / conflicts with:** DET-08 (sliding selection) touches the same component.

### DET-06 · Make a season change feel immediate: prefetch on touch-down, dim the old list, dissolve in the new one — ✅ done
- **Result:** Also the first list dissolves in (opacity only) when its skeleton was up > 250 ms. Measured with 600 ms answers: dims at ~200 ms, slides in from the right / left; the Season 2 pending row never shows in the old list; a 350 ms touch-down warm makes a 300 ms answer land ~30 ms after the click.
- **Kind:** craft · **Priority:** P2 · **Effort:** M
- **Files:** `phone/src/screens/SeriesDetail.svelte` (`pick`, `loadSeason`, `rows`), `phone/src/components/detail/SeasonPills.svelte` (new `onpress(key)` callback on `pointerdown`), `phone/src/styles/detail.css`
- **Now:**
  - `loadSeason()` (SeriesDetail.svelte:80–101) keeps the *old* season's `eps` on screen, undimmed, while the new one loads. Then it swaps them in one cut.
  - Meanwhile `seasonNum` already points at the new season, so `rows` (line 202) mixes the new season's pending download rows into the old season's episodes. That's a small bug.
  - The fetch only starts on `click`, roughly 100–150 ms after the finger lands.
- **Change:**
  1. `pointerdown` on a pill → `prefetch(episodesPaths(series.Id, seasons[i].Id)[0])` and `[1]` (`api.js` `prefetch`, parked ≤ 30 s). By the click the answer is usually there.
  2. Store `epsSeason` next to `eps` and filter pending rows by `epsSeason`, not `seasonNum`, while `loading`.
  3. While loading for more than 120 ms (a timer, so a fast answer doesn't flicker), add `.detail__episodes--stale { opacity: .45; transition: opacity 180ms linear }`.
  4. When the new rows land, animate the list container once: `el.animate([{opacity: 0, transform: 'translateX(' + dir * 12 + 'px)'}, {opacity: 1, transform: 'none'}], {duration: 240, easing: EASE.out})`. `dir` is +1 for a later season, −1 for an earlier one. Under reduced motion use opacity only, 180 ms.
- **Why:** A segmented switch should feel direct. The touch-down prefetch is how native apps hide latency, and the directional dissolve tells you which way you moved without overdoing it.
- **Constraints & risks:**
  - One layer animation per switch, on the container, not per row.
  - `toListTop()` still jumps first. Keep that order so the animation runs where the user looks.
  - Queue-only pills (`pidx`) clear the list at once. Give them the same dissolve.
- **Verify:** Dev frame on a show with several seasons: tap Season 4, then Season 2. The list dims only if slow, slides in from the right and then from the left, and never shows a pending row from another season.
- **Depends on / conflicts with:** DET-05.

### DET-07 · Make the pinned pills and the nav bar one material (single hairline), and detect pinning cheaply — ⏳ later round
- **Kind:** native · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/styles/detail.css`, `phone/src/components/detail/SeasonPills.svelte` (the `stuck` effect, lines 14–25)
- **Now:**
  - With the pills pinned there are two stacked glass bars, each with its own `inset 0 -1px 0 var(--line)` hairline: one under the NavBar and one under the pills. See the screenshot `mm-pinned.png` (2×): a line at the navbar's bottom edge cuts the material in two.
  - `stuck` is recomputed on every scroll event with `getComputedStyle(el).top` plus two `getBoundingClientRect()` calls. That's a style recalc and a layout read per scroll event, for the whole page.
- **Change:**
  - CSS: `.route:has(.pills--sticky) .navbar--solid { box-shadow: none; }`, so only the pills keep the hairline. Keep both backgrounds at `--glass-bg-strong` + `--glass-blur` (already equal).
  - Detection: read `top` once (and on resize). Replace the scroll handler with an `IntersectionObserver` on the `.detail__gap` sentinel just above the pills (`root: sc`, `rootMargin: -${top}px 0 0 0`, `threshold: 0`). The pills are stuck once the sentinel has scrolled out above that line.
- **Why:** UIKit draws a nav bar with an attached scope bar or segmented control as one continuous material with one separator at the bottom.
- **Constraints & risks:** `:has()` is Safari 15.4+. The bar's own `transition: background-color` stays.
- **Verify:** Dev frame: scroll a series until the pills pin. One hairline under the pills, none between them and the nav bar. Scroll back and the pills lose their glass at the same point as before.
- **Depends on / conflicts with:** Navigation auditor (NavBar styles; this is only a detail.css override).

### DET-08 · Give the season pills a sliding selection — ⏳ later round
- **Kind:** craft · **Priority:** P3 · **Effort:** M
- **Files:** `phone/src/components/detail/SeasonPills.svelte`, `phone/src/styles/detail.css`
- **Now:** The old pill fades from white to surface-2 and the new one fades in (`transition: background-color var(--dur-fast) linear`, components.css:496).
- **Change:**
  - Add one absolutely positioned `.pills__thumb` (white, `--r-pill`, behind the buttons, `z-index: 0`; pills are `position: relative; z-index: 1` with a transparent background when active).
  - On `activeKey` change, set `transform: translateX(${b.offsetLeft}px)` and `width: ${b.offsetWidth}px` with `transition: transform 320ms var(--ease-sheet), width 320ms var(--ease-sheet)`. `width` is acceptable on a single out-of-flow 36 px element.
  - Text colour crosses over in 180 ms. The first placement has no transition. The watched tick keeps its gold disc.
- **Why:** This is UISegmentedControl's selection: the one motion that makes a picker feel physical.
- **Constraints & risks:**
  - Reduced motion: no transition (instant move).
  - `pill--dim` (queue-only) selected keeps its outline and no white thumb: hide the thumb when the active pill is dim.
  - The long-press preview's `pillPreview` snippet still renders a standalone `.pill--active`. Keep that style working.
- **Verify:** Dev frame: tap between seasons. The thumb glides and the labels flip colour; under `rm=1` it snaps.
- **Depends on / conflicts with:** DET-05 (same effect/key), DET-07.

### DET-09 · Make the add → queued → downloading → landed transitions happen in place — ✅ done
- **Result:** Landed note reads “Ready to watch.” so the note slot never stands empty under Open; a revisit of a landed page shows Open at once (module `lastLanded`). “Play while downloading” stays outside the morph: it appearing/leaving is a real new control and still moves the page (not animated — it would be a height animation).
- **Kind:** craft · **Priority:** P2 · **Effort:** M
- **Files:** `phone/src/screens/LookupDetail.svelte` (`.detail__buttons` block lines ~405–418, `eyebrow`), `phone/src/screens/PendingDetail.svelte` (`.detail__buttons`, `eyebrow`, `landed`), `phone/src/styles/detail.css`
- **Now:**
  - Each state is a separate `{#if}` branch: a gold "Add to library" button → busy "Adding…" → grey StatusButton "Added — looking for a download" → StatusButton with live % → (PendingDetail) "Importing…" → gold "Now in your library — Open". Every step is a hard cut.
  - The eyebrow badge and the `.detail__note` under the button change at the same time. The note's height changes and the whole page below jumps.
  - The landing moment, arguably the happiest one, looks the same as any other re-render.
- **Change:**
  - Put the button branches in a `.detail__morph` grid (`display: grid; > * { grid-area: 1/1 }`). Use Svelte `transition:fade={{duration: 180}}` so outgoing and incoming overlap in the same cell, which means no layout jump. Give the notes the same treatment with `min-height` on the note slot equal to two caption lines.
  - Eyebrow: key the badge on its text (`{#key eyebrow.text}`) with `in:fade={{duration: 180}}`.
  - Landed: the eyebrow becomes a gold `check` badge "In your library". The button reads "Open" (icon `play`), not "Now in your library — Open". Its entry is a one-shot `scale(.96 → 1)` plus fade, 260 ms `--ease-spring`, and only on the transition (not when the page opens already landed, `lastSnap`).
- **Why:** Native state machines (App Store's GET → progress → OPEN) morph one control in place. A wall of text swapping in and out reads as a web form.
- **Constraints & risks:**
  - Svelte transitions are local, so they don't play on page mount; verify with `lastSnap` pages.
  - Reduced motion: fades only, no scale.
  - Never trigger a real add while testing: stub `addToLibrary` or use an item already in the arr.
- **Verify:** Dev frame with a stubbed `addToLibrary` (e.g. set `adds[key]` states from the console via the module) and a fake activity group. The button crossfades through the states and nothing below it moves.
- **Depends on / conflicts with:** DET-10 (StatusButton internals). Sheets/toast auditor (the Undo toast fires at the same moment; don't stack two animations on the same frame).

### DET-10 · Make the live download state jitter-free, compositor-only and quiet for VoiceOver — ✅ done
- **Result:** The live region is the eyebrow badge itself (`aria-live=polite` on `.detail__eyebrow`, its text is exactly the state word), so VoiceOver doesn't read the state twice. The fill glides with `--dur-spring` + `--spring-smooth` (token pair) instead of a literal 600 ms. `statusParts()` now returns `rate`/`eta` too.
- **Kind:** bug · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/components/detail/StatusButton.svelte`, `phone/src/styles/detail.css`, and `phone/src/styles/components.css` `.btn--status .btn__fill` (foundation-owned, lines 222–227)
- **Now:**
  - StatusButton puts `aria-live="polite"` on the whole button (StatusButton.svelte:10). VoiceOver reads "43% · 7.4 MB/s · 1:11:24 left" again every 4 s poll for as long as the page is open.
  - The fill animates `width` (a layout property).
  - The centred line shifts sideways whenever the speed changes digit count ("9.8 MB/s" → "12.1 MB/s"), even with tabular numbers.
  - The button's ETA is a clock ("1:11:24 left", `clockLeft`) while the episode rows say "1 h 16 min left" (`etaLeft`) for the same thing.
- **Change:**
  - Remove `aria-live` from the button. Add a visually hidden `<span class="sr-only" aria-live="polite">` that changes only on status *transitions* ("Queued", "Downloading", "Importing", "In your library").
  - Fill: `width: 100%; transform: scaleX(var(--p)); transform-origin: left; transition: transform 600ms var(--ease-out)`. Reduced motion keeps `transition: none` (already in the list at components.css:1078).
  - Numbers: `.btn__pct { display: inline-block; min-width: 3.2ch; text-align: right }` and wrap the speed in `<span class="btn__rate">` with `min-width: 7ch`.
  - Use one ETA format everywhere: the `hmin` wording ("1 h 12 min left"). It's calmer, and a changing seconds digit every 4 s adds nothing.
- **Why:** Progress UI on iOS (App Store, Files) updates smoothly without making the label dance, and VoiceOver announces state changes, not every tick.
- **Constraints & risks:**
  - A 600 ms transform transition per 4 s poll is idle about 85 % of the time, with no always-running animation.
  - The Button component is foundation's. Either change `.btn--status .btn__fill` there, or scope the override to `.detail__buttons .btn--status .btn__fill`.
  - The phone's Downloads screen may reuse the status button. Check before changing it globally.
- **Verify:** Dev frame with a fake downloading group. The text stays put as the speed changes and the fill glides. In a VoiceOver/Accessibility Inspector pass, one announcement per state change.
- **Depends on / conflicts with:** DET-09.

### DET-11 · ActionBar: stable keys, an App-Store-style download ring and an optimistic Watched toggle — ✅ done
- **Result:** Series' Watched is optimistic too, once confirmed in its menu. `animate:flip` included. Verified with `setPlayed` stubbed at the network: tick + pop on the tap, no spinner, “From start” slides out; 5/5 taps on the ring opened Downloads and 0 action nodes were recreated during 5 s of fake progress (before: 12 recreations in 1 s).
- **Kind:** bug + craft · **Priority:** P2 · **Effort:** M
- **Files:** `phone/src/components/detail/ActionBar.svelte`, `phone/src/screens/MovieDetail.svelte` (`dlAction`, `actions`, `toggleWatched`), `phone/src/screens/SeriesDetail.svelte` (`actions`), `phone/src/styles/detail.css`
- **Now:**
  - `{#each list as a (a.label)}` (ActionBar.svelte:11) is keyed by the *label*. MovieDetail's Download action has `label: '43%'`, then `'44%'` and so on (MovieDetail.svelte:105), and `offline.svelte.js` bumps `e.done` per HLS segment. So the button is destroyed and recreated several times a second while a download runs. A tap that lands during a recreate is lost (pointerdown on the old node, pointerup on the new).
  - The action icon for a running download is just the static arrow, with the percentage as the caption. The caption is not tabular, so it wobbles.
  - Watched shows a spinner in the circle until the server answers, then flips.
- **Change:**
  1. Add an `id` to every action (`'trailer'`, `'watched'`, `'restart'`, `'show'`, `'download'`, `'cancel'`) and key the `#each` on it.
  2. Add an optional `p` (0–1) to actions. ActionBar renders a `ProgressRing` (40 px, no label, `--ring-stroke` 2.5) around a small `download` glyph in `.action__icon` while `p != null`. MovieDetail passes `p: dl.done / dl.total` for `downloading`, and the label becomes "Downloading". Apply `.action { font-variant-numeric: tabular-nums }`.
  3. Watched: flip `on` optimistically (a local `$state`, reverted on error with the existing toast) and drop the spinner. When `on` becomes true, run one `check` pop on `.action__icon`: `animate([{transform:'scale(.85)'},{transform:'scale(1.08)'},{transform:'none'}], {duration: 320, easing: EASE.spring})`. Nothing on mount, nothing when unchecking. Keep `busy` to block double taps without showing a spinner.
  4. Optional: `animate:flip={{duration: 220}}` on the items, so "From start" leaving after a Watched toggle slides the neighbours instead of teleporting them.
- **Why:** The App Store's download ring is the iOS idiom for "this is downloading to your phone". Optimistic toggles with a small pop are how Apple TV and Podcasts mark things played.
- **Constraints & risks:**
  - Reduced motion: no pop, no flip.
  - Never exercise the real Watched toggle against the server. Stub `setPlayed` in the dev frame, or restore UserData afterwards per CLAUDE.md.
  - SeriesDetail's Watched opens a confirm menu. Keep that, and apply the pop only once it is confirmed.
- **Verify:** Dev frame: with `setPlayed` stubbed, tap Watched; the check pops once. Start a fake offline entry (`OFF.list` from the console) and tap the ring repeatedly while `done` increments; every tap opens Downloads.
- **Depends on / conflicts with:** Downloads/sheets auditor (the Download action leads there).

### DET-12 · Overview: an inline "more" at the end of the third line, and tap the text to expand — ✅ done
- **Kind:** native · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/components/detail/Overview.svelte`, `phone/src/styles/detail.css`
- **Now:** A clipped overview gets a separate bold "More" button on its own row below the text (Overview.svelte:30; `.overview__more` pulls up only 12 px). The text itself isn't tappable. Expanding snaps the paragraph open.
- **Change:**
  - Wrap in `.overview-wrap { position: relative }`. When clipped, place the button over the end of line 3: `position: absolute; right: 0; bottom: 0; padding-left: 28px; background: linear-gradient(90deg, transparent, var(--bg) 24px)`. Label "more" in `--text`, weight 600, `--t-body`.
  - Make the paragraph itself a button target (`role="button"`, `aria-expanded`) that expands on tap.
  - Reveal: after flipping `open`, animate `clip-path: inset(0 0 ${newH - oldH}px 0)` → `inset(0)` over 220 ms `--ease-out` on the paragraph. The rest of the page reflows once, instantly; only the new lines unveil.
  - No collapse: App Store doesn't collapse either.
- **Why:** The App Store and Apple TV use exactly this treatment: "…more" trailing the truncated line, and a tap anywhere on the text.
- **Constraints & risks:**
  - Keep the 44 pt hit box: the `::after` extension already exists.
  - Reduced motion: no clip animation.
  - Person's bio uses the same component (fine).
  - The gradient must match the page background (`--bg`). On a landscape hero overlap the text sits on `--bg` too.
- **Verify:** Dev frame: a movie with a long overview and a long actor bio. "more" sits at the end of line 3 over a soft fade, and tapping either expands.
- **Depends on / conflicts with:** DET-04 (the text is no longer selectable, so a tap-to-expand is unambiguous).

### DET-13 · Animate play-state changes where they happen: resume bar glide, tick pop — ⏳ later round
- **Result:** Resume-bar glide → merged into HOME-07; the tick pop stays here.
- **Kind:** craft · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/styles/detail.css`, `phone/src/components/detail/EpisodeRow.svelte`
- **Now:**
  - After the player closes, Detail re-reads the item (Detail.svelte:53–67), and the resume bar jumps from, say, 22 % to 58 %.
  - Marking an episode watched from the long-press menu swaps its progress bar for the gold tick instantly (EpisodeRow.svelte:214–218).
- **Change:**
  - `.detail__resume .progress__fill { transition: width 700ms var(--ease-out) }`. Only the page's own resume bar, one 3 px element. It is a CSS transition, so it never runs on mount.
  - EpisodeRow: `{#if watched}<span class="tile__corner tick" in:scale={{start: .6, duration: 260, easing: spring}}>`. Svelte 5 transitions are local, so this plays on a toggle, not when the list renders. Use the progress bar's `out:fade={{duration: 120}}`.
- **Why:** When you come back from watching, the bar moving to where you stopped confirms your spot was saved. It's the same moment Apple TV shows.
- **Constraints & risks:** Reduced motion: `transition: none` on the fill, and a plain fade for the tick. Stub `setPlayed` when testing.
- **Verify:** Dev frame: change `udNow` / an episode's `UserData` from the console and watch both animate once.
- **Depends on / conflicts with:** DET-11.

### DET-14 · Add a Share button to title pages (Web Share API) — ⏸ awaiting decision
- **Kind:** native · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/screens/MovieDetail.svelte`, `SeriesDetail.svelte`, `LookupDetail.svelte`, `PendingDetail.svelte` (NavBar `trailing` snippet); new icon `docs/ios/vibereel-iphone/icons/share.svg` + regenerate `phone/src/lib/icons.js` via `phone/scripts/icons.mjs`
- **Now:** The NavBar's trailing slot is empty on every title page. There is no way to send a title to someone.
- **Change:**
  - Put a glass `iconbtn` "share" (square with an up arrow, 24 viewBox, 1.75 stroke, round caps, like the rest of the set) in `trailing`. On solid, `.navbar--solid .iconbtn` already turns it plain.
  - On tap: `navigator.share({ title: name, text: name + (year ? ' (' + year + ')' : ''), url })`. The URL is `https://www.imdb.com/title/${ProviderIds.Imdb}/` (Jellyfin items; the single-item GET returns ProviderIds), lookup `imdb_id`, else TMDB `https://www.themoviedb.org/movie|tv/${id}`.
  - Hide the button when `!navigator.share` or no id. Ignore the `AbortError` thrown when the user dismisses the sheet.
- **Why:** The share sheet is the most iOS-native control a PWA can reach, and the Apple TV app has Share on every title. The app's own URLs point at a private server, so a public IMDb link is what the recipient can use.
- **Constraints & risks:**
  - Must run synchronously in the tap (user activation).
  - Icon generation is foundation's script (append-only).
  - No motion.
- **Verify:** iPhone for the share sheet itself. In desktop Chrome, `navigator.share` exists on some platforms; otherwise check that the button hides.
- **Depends on / conflicts with:** Navigation auditor (NavBar trailing-slot layout, title truncation with a trailing button).

### DET-15 · Person page: title threshold from the name, no initials flash, photo dissolves in — ⏳ later round
- **Kind:** craft · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/screens/Person.svelte`, `phone/src/components/detail/CastRail.svelte`, `phone/src/styles/detail.css`
- **Now:**
  - `scrollPast={{ y: 200 }}` (Person.svelte:96) is a fixed number. The serif name sits about 150 px below the bar, so the nav title shows up at an unrelated moment.
  - `.cast__initials` is always rendered under the photo (Person.svelte:98, CastRail.svelte:16). While a photo loads (Person waits for the person record before it even has a URL, Person.svelte:33) the user sees "LD" and then the face pops over it.
- **Change:**
  - Bind the name element and use `y = name.offsetTop + name.offsetHeight - (safeInsets().top + 56)`.
  - Render the initials only when there is no image or it failed (`!src || broken`; use Art's `onerror` path or check `img.imgfail`). While loading, show a plain surface-2 disc.
  - When the photo arrives after first paint, fade it in: 200 ms opacity, not under `.zoom-hide`.
  - Optional: pass `PrimaryImageTag` through `openPerson` params so the photo URL is known on mount. `openPerson` is the nav shim's (foundation), so report it rather than change it.
- **Why:** Placeholders should be neutral until the app knows there's no photo. A letter pair flashing before a face reads as a glitch.
- **Constraints & risks:** The zoom from a cast photo hides `.person__photo` and fades out itself when it lands (`finish(false)` for person photos). Don't double-fade.
- **Verify:** Dev frame with network throttling: open a cast member and check that no initials appear before the photo. For a person without an image, the initials do appear.
- **Depends on / conflicts with:** DET-03 (the same late-image fade helper). Motion auditor (generic image fade).

### DET-16 · Series: name the episode the Play button will start — ⏳ later round
- **Kind:** native · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/screens/SeriesDetail.svelte` (lines 516–523), `phone/src/styles/detail.css`
- **Now:** The button says "Play S1 · E1" or "Resume S2 · E4". The resume row only exists when resuming, and shows "S2 · E4 · 31 min left". The episode's *name* never appears, and a fully watched series (all ticks) still says "Play S1 · E1" with no hint that it's a rewatch.
- **Change:**
  - Under the button, add a `.detail__note`-style line: `E4 · Episode Name` when not resuming.
  - When resuming, extend the resume row to `S2 · E4 · Episode Name · 31 min left`. `detail.css:432` already expects exactly this format, but the code never adds the title.
  - When `seriesWatched && !nextUp`, label the button "Play again S1 · E1".
- **Why:** Apple TV shows "S2, E4: Title" under its Play button. Knowing what you're about to start is part of the native feel.
- **Constraints & risks:** Keep it to one line (ellipsis). No motion.
- **Verify:** Dev frame on a show in progress, one untouched, and a fully watched one.
- **Depends on / conflicts with:** none.

### DET-17 · Let the long-press preview of an episode be a real peek — ⏳ later round
- **Kind:** native · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/screens/SeriesDetail.svelte` (`epPreview` snippet), `phone/src/components/detail/EpisodeRow.svelte` (`preview` mode), `phone/src/styles/detail.css`
- **Now:** Episode rows play on tap, and their overview is clamped to 2 lines (`.episode__overview`), so there is no way to read an episode's full synopsis. The long-press preview renders the row *without* the overview (`{#if overview && !preview}`, EpisodeRow.svelte:225).
- **Change:** In preview mode, render the still full-width (16:9, `--r-thumb`) above the "S2 · E4 · 50 min" line, the title, and the overview clamped to 6 lines. Cap the preview card at 312 px wide, like the menu.
- **Why:** An iOS context-menu preview is a larger look at the item. It's where native apps show what doesn't fit in the row.
- **Constraints & risks:** ContextMenu places the preview at the pressed rect and moves it up when there's no room. Check a row near the bottom of the screen and in landscape.
- **Verify:** Dev frame: right-click (= long-press) an episode near the top and near the bottom.
- **Depends on / conflicts with:** Sheets/menus auditor (ContextMenu placement).

### DET-18 · Fade the serif title as it slides under the nav bar (Safari 26 scroll timeline) — ⏳ later round
- **Kind:** craft · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/styles/detail.css`
- **Now:** The big serif `h1` scrolls under the glass bar at full opacity while the small nav title fades in at `solidAt`, so both titles show for a moment.
- **Change:**
  ```css
  @supports (animation-timeline: view()) {
    .detail__title, .person__name {
      animation: vr-title-out linear both;
      animation-timeline: view();
      animation-range: exit-crossing 30% exit-crossing 100%;
    }
    @keyframes vr-title-out { to { opacity: 0; } }
  }
  ```
  Tune the range so it reaches 0 exactly when the nav title is at full opacity.
- **Why:** Apple Music and Apple TV hand the title from the page to the bar as one continuous motion.
- **Constraints & risks:**
  - Scroll-driven animations shipped in Safari 26. On iOS 17/18 the `@supports` block does nothing, and today's behaviour stays.
  - Compositor-driven, no JS. Under reduced motion it's still acceptable (an opacity change tied to scroll), but it may be dropped.
  - The rest of the view is offset by the sticky navbar height, so tune the range on a device.
- **Verify:** iPhone on iOS 26 only (headless Chrome also supports `view()`, so the range can be tuned there first).
- **Depends on / conflicts with:** DET-01 (independent layers), Navigation auditor (nav title fade timing).

## Considered and rejected
- **Clearlogo instead of the serif title.** The Instrument Serif title is the design's identity, logos vary wildly in colour and quality, and Home doesn't use them either.
- **Auto-playing the trailer in the hero (Apple TV app style).** A cold `yt-dlp` start takes 4–5 s, it costs cellular data and battery, it needs audio-policy handling, and it conflicts with the "nothing runs when idle" rule.
- **Swipe actions on episode rows (Mail-style mark watched).** Not an Apple TV convention. It collides with horizontal scrolling and edge-swipe back, and a hidden gesture that fires a real server mutation is too easy to trigger by accident.
- **Count-up animation of download percentages.** Busy for no information; a gliding fill (DET-10) is enough.
- **A "Less" collapse on the overview.** Native apps don't collapse either, and it adds a control.
- **A nav-bar "…" menu that mirrors every long-press action (UX-AUDIT open item).** Most long-press actions are per episode and can't be mirrored on the page. Keep the page calm; Share (DET-14) is the one nav-bar action worth adding.
- **Blurred backdrop or header art behind the Person page.** People have no backdrops, and a blurred portrait behind a portrait is decoration.
- **View Transitions API for the season switch.** Not in iOS 17, and it would nest inside the router's own route animations. The container dissolve (DET-06) is cheaper.
- **A continuous `width` creep of the status fill over the 4 s poll interval.** It would animate for as long as the page is open. DET-10 uses a 600 ms glide per update instead.
- **A sticky Play button bar at the bottom.** Not native for media titles, and the floating tab bar already owns the bottom edge.

## Cross-refs
- **Navigation:**
  - The NavBar title could rise about 6 px as it fades in (`.navbar__title { translate: 0 6px }` → `0` on `--solid`, 220 ms `--ease-out`), as UIKit's inline title does.
  - Status-bar tap-to-top can't reach nested `.screen` scrollers in a PWA (it only scrolls the document). Say so honestly, or offer a tap on the nav bar title as a stand-in.
- **Motion system:**
  - Rows get `:active` highlights on touch-down even when the touch becomes a scroll: episode rows flicker while flicking a season. UITableView delays highlighting about 80 ms and cancels it on scroll. A shared `.is-pressed` via a delayed pointerdown would fix all lists.
  - `navigator.vibrate(8)` in `gestures.js` `longpress` does nothing on iOS. The only web haptic on iOS 18+ is toggling a `<input type="checkbox" switch>`, via a hidden label click. Worth a shared `haptic()` helper for long-press and the add/landed moments (DET-09, DET-11).
- **Foundation/Tile:** warm the Jellyfin item on `pointerdown` of a `.tile` (`prefetch(itemPath(id))`). That's about 100–150 ms head start before the click that pushes `detail`, and it would often remove the skeleton entirely (pairs with DET-03).
- **Foundation/router:** PendingDetail's "Open" pushes `detail` on top of the pending page. A `replace()` would let Back skip the stale pending page. (The nav shim has no replace yet.) — ✅ wave 2: `router.replace(name, params)`; PendingDetail's Open uses it (the detail slides in over the pending page, which then leaves the stack; Reduce Motion: dissolves over it).
- **PWA shell:** consider a global selection policy (`.screen { user-select: none; -webkit-touch-callout: none }`, with opt-ins). DET-04 only covers the title pages.
- **Foundation (components.css):** `.btn--status .btn__fill` animates `width`; DET-10 proposes `transform: scaleX()`. Also `.skel` pulses from the first frame everywhere; a 250 ms delay would help lists as much as it helps DET-03.
- **Sheets/menus:** UX-AUDIT's open item (`inert` on `.stage` while a sheet or menu is up) also affects the detail pages' ContextMenus.
