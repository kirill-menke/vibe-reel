# Home — polish and native-feel tasks

Audit of `phone/src/screens/Home.svelte` and what it uses (carousel, Rail, Tile, Art, ProgressBar, ContextMenu,
freshness), 2026-09-30. Measured in headless Chrome at 393×852 against the live server (read-only), with
image requests held back 1.8 s through CDP `Fetch` to see a slow first load.

**What already works:** the hero carousel follows the finger and blurs between slides. On release it continues
at the finger's speed, the blur copies are pre-computed and only opacity/transform animate. Continue Watching
and Next Up reorder with `flip`, and live updates wait for the finger to lift (`whenSettled`) and keep their
scroll position (`keepScroll`). The fourth poster peeks in from the edge. Layout shift at first paint is
effectively zero (CLS 0.0001).

**The biggest gaps:**
- **Hard cuts.** The hero backdrop pops in over flat black. Posters pop in over grey. Recently Added and
  Trending swap their tiles with no animation. When the last tile of a rail is removed, the whole rail vanishes
  and the page below jumps.
- **A real mis-tap bug.** A tap during the hero's auto-advance lands on the incoming slide's Resume while that
  slide is still nearly invisible.
- **Every cold start shows a skeleton.** Offline, a cold start shows an error card instead of the last content,
  which the design (`02-home--offline`) says to show.
- **Long-press doesn't feel like iOS yet.** The menu has no build-up while the finger holds and no drop-back
  when it closes. Svelte `flip`/`shrink` ignore reduced motion.

## Tasks

### HOME-01 · Fix: a touch that catches the moving hero only stops it — ✅ done
> Wave 1 · B: `down()` swallows the click for 600 ms when the carousel was moving (`anim` or p off an integer); the drag swallow keeps the later of the two. Measured: 420 ms into `advance()` (p ≈ 0.75) the tap reached no slide, the hero settled on the nearer slide, a second tap 1 s later worked.
- **Kind:** bug / native  ·  **Priority:** P1  ·  **Effort:** S
- **Files:** `phone/src/lib/carousel.js` (`attach()` → `down`, `click`, `end`)
- **Now:** `down()` (carousel.js:100–108) calls `cancelAnim()` and the transition stops where it is. The click
  that follows is swallowed only after a horizontal drag (`swallow`, :136 and :150–156).
  - A plain tap during an auto-advance or a snap goes straight to whichever slide's buttons are live.
    `dom` flips at p = .5, when both text blocks are at ~0 opacity.
  - **Measured:** I tapped Resume 420 ms into `advance()` (p = 0.71). The click reached **slide 1's** Resume,
    whose text was at 28 % opacity. The user was looking at slide 0 and would start the other title.
  - Auto-advance runs 700 ms out of every 6 s, so about 12 % of random taps on the hero land in this window.
- **Change:** In `down()`, remember whether the carousel was moving:
  `const moving = !!this.anim || (this.p % 1) > 1e-3;`. If it was, set `swallow = performance.now() + 600`
  whether or not a drag follows. The release still snaps to `Math.round(p)` (unchanged), so the touch only stops
  the carousel. This is `UIScrollView` behaviour: touching moving content stops it and doesn't activate what's
  under the finger.
- **Why:** On iOS, touching a paging view in motion never triggers a button inside it.
- **Constraints & risks:** Only swallow while moving. A tap on a settled hero must still work on the first
  touch. Keep the existing post-drag swallow. Reduced-motion auto-advance (180 ms) goes through the same path.
- **Verify:** Dev frame. Call `document.querySelector('.homehero').__carousel.advance()`. After ~400 ms, tap
  Resume. With a capture `click` listener on `window` that logs `e.target.closest('.homehero__body').dataset.i`
  and calls `preventDefault()` + `stopImmediatePropagation()` (no playback), nothing should be logged, and the
  carousel should settle on the nearer slide. A second tap then works. Reference script:
  `/tmp/claude-1000/polish-home/run5.mjs`.
- **Depends on / conflicts with:** HOME-02 and HOME-08 also touch carousel.js (different functions).

### HOME-02 · Bring the hero into focus: a blurhash placeholder that sharpens, instead of text on black and a pop — ✅ done
> Wave 1 · B: `lib/blurhash.js` (`avgColor`, `drawBlurhash`, `blurFor(item, url)` = the hash of the exact tag `imgUrl()` picked). The hash canvas is the first child of `.homehero__media`; `paint()` composes the real stack with coverage `c·smooth(r/0.4)` and fills the rest exactly (`(c − q)/(1 − q)`), so a swipe during the focus-in keeps its coverage. Focus-in runs over `DUR.spring` (700 ms) with `--ease-out` — the token nearest to 520 ms that reads right (ease-out is front-loaded: r ≈ .86 after ~250 ms); Reduce Motion: a linear `DUR.rm` fade of the sharp image. A broken backdrop keeps the hash (`__failed`, auto-advance still moves on). Measured with images held 1.8 s: hash colours from the first frame, then blurred → sharp; warm reload: no focus-in (0 slides focusing); `getAnimations()` empty after.
- **Kind:** craft / native  ·  **Priority:** P1  ·  **Effort:** M
- **Files:**
  - `phone/src/lib/carousel.js` (`heroArt`, `paint`, new `focusIn`)
  - `phone/src/screens/Home.svelte` (the hero `{#each}` at :554–560, `heroBg` at :318)
  - new `phone/src/lib/blurhash.js`
- **Now:**
  - `heroArt` (carousel.js:332–353) gives the sharp `<img>` its `src` only after a detached `decode()`.
    Until then the slide is the hero's flat `--surface-1` with the title, buttons and dots already on it.
  - When the image arrives it replaces that at full opacity in a single frame. The filmstrip with images held
    back 1.8 s shows 1.8 s of text on black, then a hard cut. On the phone over Tailscale a cold 1920 backdrop
    often takes that long.
  - Jellyfin already sends `ImageBlurHashes` on every Resume/NextUp/Latest item (checked: e.g. `Backdrop:
    {tag: "WEInRGK4mT;3yC-B…"}`, and the parent's backdrop hash on episodes). Nothing uses them.
- **Change:**
  1. **`blurhash.js`** (about 40 lines, no dependency):
     - `avgColor(hash)`: the DC term, chars 2–6, base83, is the sRGB average colour.
     - `decodeBlurhash(hash, w, h) → ImageData`: the standard decoder. Components from char 0
       (`nx = size%9+1, ny = floor(size/9)+1`), `maxAC = (d83(hash[1])+1)/166`. Each AC value is
       `signPow((q-9)/9, 2)·maxAC` with `q = [v/361, v/19 % 19, v % 19]`. Sum the cosines in linear light,
       then convert back to sRGB.
     - Decoding to 32×18 is about 7 k multiply-adds, well under 1 ms.
  2. **Home.svelte:** pass the hash along with the URL: `use:heroArt={{ url, hash }}`.
     - `hash` = `ImageBlurHashes.Backdrop[<tag imgUrl used>]` (for an episode, the tag from
       `ParentBackdropImageTags`), else the first Backdrop hash, else the Primary one, else none.
     - Pass it for **every** slide, not just `seenSlides`: the placeholder costs nothing, and a swipe onto a
       not-yet-loaded slide then shows the right colours instead of black.
  3. **carousel.js:**
     - Add a 4th, bottom layer `canvas.homehero__hash` to each `.homehero__media`, and draw the 32×18 decode
       into it at once. Let the compositor scale it: the upscale is the blur.
     - Keep a per-slide readiness `r ∈ [0,1]` (0 until the backdrop has decoded).
     - In `paint()`, multiply the real stack's coverage by `smooth(r/0.4)` and raise its blur level to
       `max(bl, 1 − smooth((r−0.2)/0.8))`. The real image first fades in heavily blurred over the hash, then
       sharpens through soft to sharp, using the same two-dissolve blur ladder a swipe uses.
     - The hash layer gets opacity `c` (the slide's coverage) and is hidden (overdraw rule, :287–288) once the
       real stack is opaque.
     - `heroArt` calls `car.focusIn(i)` after `drawBlurs`. That animates `r` 0→1 over **520 ms**, eased with
       `bezier(0.22, 0.9, 0.3, 1)` (`--ease-out`), through the existing `frame()` loop, and stops at 1.
  4. **Skip the animation when it would only flicker.** If the slide wasn't visible (`role === 'off'`), or its
     placeholder had been on screen for less than 100 ms (cache hit), set `r = 1` directly.
  5. Without a hash (Trending-only titles, missing art), keep the flat background but still run `focusIn`, so
     the image fades in over `--surface-1` instead of cutting.
  6. **Reduced motion:** hash under the sharp image, then a plain 180 ms opacity fade of the sharp image.
- **Why:** Native media apps (TV, Photos, App Store) never show a hole where art belongs. They show its colours,
  then the image resolves. Here it also reuses the carousel's own language: a slide comes into focus exactly
  the way a swiped-to slide does.
- **Constraints & risks:**
  - Opacity/transform only, and the rAF loop runs only during the 520 ms.
  - `advance()` (:73–85) must keep waiting for `img.complete`. Don't auto-advance onto a slide with r < 1.
  - Keep `will-change` limited to hot slides. The new canvas joins the `--hot` rule in `home.css:15–18`.
  - No TV code involved.
- **Verify:** Dev frame with image requests delayed. CDP: `Network.setCacheDisabled`, then `Fetch.enable
  {urlPattern:'*Images*'}` and `continueRequest` after 1800 ms (`/tmp/claude-1000/polish-home/run4.mjs`).
  Expected: colours at once, then a smooth sharpen, and no frame of text on flat black. Warm reload: no fade.
  Swipe during the load: correct colours.
- **Depends on / conflicts with:** HOME-05 reuses `avgColor`. Cross-ref: the motion auditor's generic image
  fade-in (Art) must not also fade hero `<img>`s. The hero doesn't use `Art`, so there's no clash if the fade is
  scoped to `.art > img`.

### HOME-03 · Paint Home instantly from the last session, online or off — ✅ done
> Wave 1 · B, with PWA-07 as the mechanism: `lib/homesnap.svelte.js` saves the api.js store entries of Home's four paths (trimmed; ~35 KB measured) + both Trending lists (debounced 1.5 s, after `load()`, an applied `quietLoad()`, and fresh Trending); `seedHome()` puts them back through the `__PHONE__`-only `seedStore()` at Home's init, so `cached()` paints before the first frame and a failed `revalidate()` falls back to them. Signed-out accounts' snapshots are pruned when the module loads at boot (sign-out reloads), so the Accounts sheet needed no change. While `stale`, CW/NU/hero/"Play from beginning" wait for the live item (pressed tile / Resume spinner; `videoEl().load()` inside the tap keeps iOS's gesture unlock). Measured: online and offline reloads mount Home with the hero + 6 rails and no skeleton; offline with no snapshot still shows the skeleton → error card. The banner says "Showing what was loaded last." only once Home painted (else "Your downloads still play." when there are downloads).
- **Kind:** native / perf  ·  **Priority:** P1  ·  **Effort:** M
- **Files:** `phone/src/screens/Home.svelte` (`load`, `paint`, `quietLoad`, init)
- **Now:**
  - The SWR store in `src/lib/api.js` is in memory only, so every cold start shows the skeleton
    (Home.svelte:512–529) until four requests return.
  - Offline, both core rails fail and Home shows the "Couldn't reach the server" `LoadError`
    (Home.svelte:530–542). The design (`02-home--offline.html`) wants the last content under the banner:
    "Showing what was loaded last."
  - Measured answer sizes: Resume 52 KB decoded, Latest 19 + 9 KB, NextUp 15 KB. Trimmed of `MediaSources`
    they are about 10–15 KB.
- **Change:**
  - **Write.** After a successful `load()`, and after `quietLoad()` has applied a change, save a snapshot to
    `localStorage['reel.homeSnap.' + cfg.userId]`.
    - Contents: `{ v: 1, at, raw, trend: { tv, movie } }`. In `raw`, each item keeps only what the tiles and
      hero read: `Id, Name, Type, SeriesId, SeriesName, IndexNumber, ParentIndexNumber, RunTimeTicks,
      ProductionYear, PremiereDate, Genres, ImageTags, BackdropImageTags, ParentBackdropItemId,
      ParentBackdropImageTags, ParentThumbItemId, ParentThumbImageTag, SeriesPrimaryImageTag,
      ImageBlurHashes` and `UserData {PlaybackPositionTicks, PlayedPercentage, Played, UnplayedItemCount}`.
      Check `imgUrl()` in `src/lib/api.js` for the image fields it reads.
    - Debounce with `setTimeout(…, 1500)`. iOS Safari has no `requestIdleCallback`.
    - Wrap reads and writes in try/catch, as `src/lib/config.js` does.
  - **Read.** Synchronously at component init, before first render, if the snapshot is younger than 14 days:
    `paint(snap.raw)`, `painted = true`, `loading = false`, `stale = true`.
    - Trending rails fall back to `snap.trend` while `trend.tv/movie` are empty. Don't write into
      `lookup.svelte.js`: it is read-only for Home.
    - Then run `load()` as today, but apply its result the way `quietLoad` does: `whenSettled()`, then
      `keepScroll`, then `paint()`. Flip moves the changes into place and nothing jumps.
  - **Taps while `stale`.**
    - A Continue Watching / Next Up tile, or the hero's Resume, **waits for the live answer** (the Resume
      button's existing `busy` spinner, `heroWait`), then plays the fresh item.
    - Never start from a snapshot position: `playItem()` needs `MediaSources`, and the position may be old.
    - Navigation (Details, rails → detail) works at once.
    - Offline: the existing `conn.offline` gates already disable play.
  - **Signing out** (Accounts sheet) should delete the user's key.
- **Why:** Native apps open on what you saw last and update in place. A skeleton on every launch, and an error
  card offline, are what "a web page" looks like.
- **Constraints & risks:**
  - The snapshot is at most a few days stale. Watched state changed elsewhere is corrected within one request,
    and HOME-04 makes that correction animate instead of jump.
  - Images come from the HTTP cache. Offline they may be missing: `Art` falls back to lettering, and HOME-02
    and HOME-05 give colour.
  - Parsing ~15 KB takes about 1 ms.
  - No `src/lib` change, so the TV is untouched.
- **Verify:** Dev frame. Load Home, reload: the rails appear on the first frame with no skeleton. Reload with
  `?offline=1`: the last content plus the offline banner, and Resume disabled. Online reload after changing
  CW order elsewhere (fake it by editing the stored snapshot): tiles flip into place, with no hard swap.
- **Depends on / conflicts with:** HOME-04 (the animated re-apply). HOME-12 only matters when there was no
  snapshot. The accounts sheet (B) handles key deletion.

### HOME-04 · Animate every rail change the same way: insert, remove, reorder, and the last tile going — ✅ done
> Wave 1 · B: all six rails in `.home__cell` (flip `DUR.push` + `easeSheet`, `in:grow` `DUR.base` after `DUR.press`, `out:shrink` `DUR.fast` ease-in, opacity + scale only) and `.home__rail` wrappers with `transition:slide` (`DUR.base`, `rmOut`). Tokens instead of the proposal's 340/280/80/200/300 ms. Measured with rewritten Resume/Latest answers: 2 shrinks + 16 flips on a reorder, the emptied CW rail folds (260 ms) and unfolds when it returns; Reduce Motion: only 1 ms outros; idle `getAnimations()` empty.
- **Kind:** craft / bug  ·  **Priority:** P1  ·  **Effort:** M
- **Files:** `phone/src/screens/Home.svelte` (CW/NU `{#each}` at :605–644, `latest`/`trending` snippets at
  :689–722, `shrink` at :724–733, undo `scrollIntoView` at :433–435), `phone/src/styles/home.css`
  (`.home__cell`)
- **Now:**
  - Only Continue Watching / Next Up have `animate:flip={{duration: 260}}` + `out:shrink`, and **no `in:`**.
    - A tile brought back by Undo, or inserted by a freshness check, pops in while its neighbours slide.
  - Recently Added and Trending have neither.
    - When an import lands, or a title moves up after `freshness` or `landed`, the whole rail swaps in one
      frame. At `scrollLeft 0` every tile jumps right by one width.
  - Removing the **last** CW/NU tile destroys the `{#if resume.length}` block.
    - Local transitions don't run for the cell, so the rail vanishes and everything below jumps up about
      250 pt in one frame.
  - `shrink` animates `width`/`margin-right`, but that is dead code. Svelte 5 `fix()`es an outroing animated
    cell to `position:absolute` before the outro (`node_modules/svelte/…/blocks/each.js:632–639`), so only
    the linear 220 ms fade + scale is visible.
  - Svelte transitions don't respect `prefers-reduced-motion`. `flip`, `shrink` and the smooth
    `scrollIntoView` all run with reduced motion on.
- **Change:**
  - Wrap every rail's tiles in `<div class="home__cell" data-cell=…>` with the same three directives:
    `animate:flip={{ duration: rm ? 0 : 340, easing: easeSheet }}`, `in:grow`, `out:shrink`.
    - `easeSheet` from `../lib/safe.js`; `rm = reducedMotion()`.
    - Trending is keyed by `it.type + it.id`.
  - `shrink`: `duration: rm ? 0 : 200`, easing `bezier(0.4,0,1,1)` (`--ease-in`),
    `css: t => \`opacity:${t}; transform: scale(${0.86 + 0.14*t})\``. Drop width/margin.
  - `grow`: `duration: rm ? 0 : 280`, `delay: rm ? 0 : 80` (neighbours start making room first), easing
    `bezier(0.22,0.9,0.3,1)`, `css: t => \`opacity:${t}; transform: scale(${0.9 + 0.1*t})\``.
    - Local by default, so it does **not** run at first paint, only on later inserts.
  - Put each `{#if X.length}<Rail …>` inside `<div class="home__rail" transition:slide={{ duration: rm ? 0 :
    300, easing: easeSheet }}>`. The last removal then folds the rail's height (`slide` handles the
    `.rail` padding-top), and a rail that comes back unfolds. Also local, so first paint is unaffected.
  - Undo: `scrollIntoView({ …, behavior: rm ? 'auto' : 'smooth' })`.
- **Why:** In `UICollectionView`, deletions fade and shrink while neighbours glide, insertions fade and grow
  in, and a section that empties collapses. One consistent motion vocabulary for every change is what makes
  live updates read as intentional rather than glitchy.
- **Constraints & risks:**
  - `animate:` needs an element that is the direct child of the keyed each, hence the cell wrappers. Snap
    alignment then applies to `.home__cell` (`.rail__track > *` already covers it), and `.home__cell {flex:
    none; display:flex}` already exists.
  - `keepScroll` (freshness.svelte.js:269–307) measures `.rail__track` children. It works on cells unchanged
    because it uses `offsetLeft`.
  - A `slide` height animation re-lays out the page for 300 ms. That is a one-off and acceptable.
- **Verify:** Dev frame. Fake a freshness change by editing a CDP `Fetch` response of the `DateCreated`
  marker + `/Items/Latest` (DEV-CHROME.md, "Automatic refresh"), then `__freshness.check()`. The new poster
  should grow in while the others glide. With `rm=1`, everything is instant.
  - ⚠️ Don't use real Remove on the server account for testing. Removal is local (`homehide.js`), so it is
    allowed but not necessary: stub `hideFromHome` in DevTools, or exercise `paint()` with an edited `lastRaw`.
- **Depends on / conflicts with:** HOME-03 relies on this. HOME-07 uses the cell wrappers.

### HOME-05 · Give posters and thumbs their own colour while they load — ✅ done
> Wave 1 · B: Tile `tint` → Art `.art--tint` (`--a2` = 45 % of the colour over `--surface-2`, not 55 %: a white poster stays a mid grey). Home tints CW/NU (their thumb URL) and Recently Added (the poster URL); the Trending rails have no hashes. With MOT-05 the placeholder is flat, so the tint is flat too; the gradient remains for a real miss (`.art--empty`).
- **Kind:** craft  ·  **Priority:** P2  ·  **Effort:** S
- **Files:** `phone/src/components/Tile.svelte` (new `tint` prop → `Art`), `phone/src/components/Art.svelte`
  (`style` already passes through), `phone/src/screens/Home.svelte` (CW, NU, Latest tiles),
  `phone/src/lib/blurhash.js` (from HOME-02)
- **Now:** Every unloaded tile shows the same grey tonal gradient (`.art` default, components.css:251–257).
  Rails are `loading="lazy"`, so a fast horizontal flick reveals rows of identical grey frames that then pop.
- **Change:**
  - Home passes `tint={avgColor(hash)}`, with `hash` taken from `ImageBlurHashes`:
    - landscape tiles: the Thumb, else the Backdrop;
    - poster tiles: the Primary (for an episode, the series one if that's what `imgUrl` used).
  - Tile forwards it as `style="--a2: color-mix(in srgb, <rgb> 55%, var(--surface-2)); --a1: color-mix(in
    srgb, <rgb> 80%, white 10%)"`. The existing radial gradient then becomes a soft, darker version of the
    poster's own colour.
  - The 55 % mix keeps a white poster from flashing a bright box on the dark page.
  - Trending (reel-api) has no hashes: unchanged.
- **Why:** The TV app, App Store and Photos all use dominant-colour placeholders. The rail feels already
  "there" and the image arrival is gentle, even without a fade.
- **Constraints & risks:**
  - Zero runtime cost beyond a 4-char base83 decode per tile (memoise per hash).
  - Tile and Art are shared (foundation). The prop is optional, so other screens are unaffected, and the Library
    and Detail auditors can adopt it.
- **Verify:** Dev frame with images delayed (HOME-02 verify recipe). Placeholders should be tinted per title.
- **Depends on / conflicts with:** HOME-02 (`blurhash.js`). The motion auditor's Art fade-in composes with this
  and should fade the `<img>` over the tinted frame.

### HOME-06 · Long-press like `UIContextMenuInteraction`: build-up, lift, drop-back → merged into CTX-01 ✅
> Generic in ContextMenu and longpress: the source tile hides itself, so there is no `home__cell--lifted` and Home needs no change. The drop-back applies to every fit (card too) when dismissed by a tap outside.
- **Kind:** native  ·  **Priority:** P2  ·  **Effort:** M
- **Files:**
  - `phone/src/components/Tile.svelte` (class when `onlongpress` is set, :122)
  - `phone/src/styles/components.css` (`.tile__frame`, :384–392), or home.css if kept Home-only
  - `phone/src/components/ContextMenu.svelte` (`place()` :43–56, `close()` :58–78)
  - `phone/src/screens/Home.svelte` (hide the source cell while the menu is up)
- **Now:**
  - `:active` scales the frame to .96 in 110 ms and nothing else happens until 500 ms. Then the menu appears
    with the preview animating `scale(1) → scale(1.03)`. That is a small jump back up from the pressed .96.
  - The source tile stays visible, blurred, under the preview.
  - On dismiss, the whole stack just fades out in 180 ms (`close()`, :69–71).
- **Change:**
  1. **Build-up, CSS only.** It uses the individual `scale` property (Safari 14.1+), which composes with the
     existing `transform` press, on `.tile--holdable`:
     ```css
     .tile--holdable .tile__frame { transition: transform var(--dur-press) var(--ease-out), scale 220ms var(--ease-out); }
     .tile--holdable:active .tile__frame { scale: .965; transition: transform var(--dur-press) var(--ease-out), scale 340ms var(--ease-inout) 160ms; }
     ```
     A quick tap looks exactly as today. A hold keeps sinking to ≈ .93 by the 500 ms mark.
  2. **Lift.** In `place()`, the preview keyframes go from `scale(.93)` to `scale(1.03)`, 340 ms,
     `EASE.spring`. The menu keeps `.9 → 1`. Add the haptic tick here once a helper exists (cross-ref).
  3. **Hide the source** while the menu is up (`fit === 'rect'` only). Home sets `home__cell--lifted`
     (`visibility: hidden`) on the pressed cell (`ctx.item.Id`) and clears it in `onclose`. The lifted preview
     is then the only copy, as on iOS.
  4. **Drop-back** on a dismiss by tapping outside, or on an item that doesn't remove the tile:
     - the preview animates `scale(1.03) → scale(1)`, 260 ms, `EASE.sheet`, landing exactly on the source rect;
     - the menu fades to 0 with a scale to .9, 160 ms, `EASE.in`;
     - the backdrop fades out over 240 ms;
     - `onclose` fires at the end, the source is unhidden and the preview removed in the same frame.
     - For `fit: 'card'` (CW/NU) and for "Remove…", keep today's fade.
  5. Keep the 400 ms safety timer and stretch it to the longest duration + 150 ms.
- **Why:** Native context menus telegraph the hold and hand the item back to where it came from. Today's version
  reads as a web popover.
- **Constraints & risks:**
  - Transform/opacity only. `scale` is compositor-only.
  - `zoom.js` measures `.tile__frame` rects on tap. The build-up is delayed 160 ms, so a tap still measures
    ≤ .96 as today.
  - Reduced motion: no build-up (`@media (prefers-reduced-motion: reduce) { .tile--holdable:active .tile__frame
    { scale: none } }`) and no drop-back (ContextMenu already skips animations).
  - ContextMenu is shared (Library, SeriesDetail rows). The drop-back applies wherever `fit: 'rect'`, which is
    wanted, but coordinate with the sheets/menus auditor.
- **Verify:** Dev frame. Right-click (synthetic 600 ms hold) on a Recently Added poster: the frame sinks, then
  the lift has no jump. Tap outside: the preview shrinks exactly onto the tile, which reappears in the same
  frame. The feel of a real hold is iPhone only.
- **Depends on / conflicts with:** HOME-04 (cell wrappers carry the `--lifted` class). Motion-system auditor
  (haptic helper, global press states).

### HOME-07 · Let resume bars move to their new position after watching — ⏳ later round
- **Kind:** craft  ·  **Priority:** P2  ·  **Effort:** S
- **Files:** `phone/src/styles/home.css` (or components.css if the owner agrees)
- **Now:** `.progress__fill` (components.css:272–276) sets `width` with no transition.
  - After the player closes, `load()` (Home.svelte:201–206) repaints Continue Watching. The item flips to the
    front, but its bar jumps to the new position.
  - When someone watches on the TV, the freshness `progress` change also jumps it.
- **Change:**
  ```css
  .tile__progress .progress__fill, .homehero .hero__progress .progress__fill {
    transition: width 700ms var(--ease-out) 150ms;
  }
  @media (prefers-reduced-motion: reduce) { .tile__progress .progress__fill, .homehero .progress__fill { transition: none; } }
  ```
  - The 150 ms delay lets the player modal's dismissal clear first.
  - The first mount doesn't animate: CSS transitions only run on change, and Tile mounts the bar only when
    progress > 0.
- **Why:** Seeing your own progress advance is feedback that the app noticed. It is the kind of small detail
  Apple's TV app has.
- **Constraints & risks:**
  - `width` on a 3 pt absolutely positioned bar: layout is confined to it, and it runs once per change.
  - Scope it to tiles and the hero, not Downloads (whose 4 s updates would keep it animating).
- **Verify:** Dev frame. Fake a `progress` change: edit `lastRaw.resume.Items[0].UserData.PlayedPercentage` in
  a CDP-intercepted Resume response, then `__freshness.check()` or `quietLoad`. The bar should glide.
  Real watching is iPhone only.
- **Depends on / conflicts with:** none. The detail auditor may want the same for `.detail__resume`.

### HOME-08 · Tap the hero art to open the title; long-press it like a tile — ⏳ later round
- **Kind:** native  ·  **Priority:** P2  ·  **Effort:** S
- **Files:** `phone/src/screens/Home.svelte` (hero `<section>`, :545–593; `details()`, `menuFor`, `openMenu`)
- **Now:** Only the small glass "Details" button opens the title. Tapping the backdrop or title, the biggest
  target on the screen, does nothing. Long-press on the hero does nothing.
- **Change:**
  - **Tap.** An `onclick` on `.homehero`: `if (e.target.closest('button')) return;
    details(slides[dom].it)`. The carousel's capture listener already swallows the click after a drag, and
    HOME-01 swallows it after a caught transition.
  - **Long-press.** `use:longpress` on the section (`disabled` while `car.busy`). It opens `menuFor(s.kind ===
    'cw' ? 'cw' : 'latest', it)` with `fit: 'card'` and a landscape `Tile` preview, the same menu as the tile.
  - Add no press highlight (the TV app has none). The push, or HOME-09's continuity, is the feedback.
- **Why:** In iOS media apps the whole featured card is tappable. Users will try it first.
- **Constraints & risks:**
  - The long-press must not fire during a horizontal drag. `longpress` already cancels on a move over 10 px,
    and the carousel locks the axis at 8 px.
  - `aria` is unchanged: the buttons stay the accessible path.
- **Verify:** Dev frame. Tap the title area: detail opens. Drag, then release on the art: no navigation.
  Right-click the art: menu.
- **Depends on / conflicts with:** HOME-01 (same click path). HOME-09.

### HOME-09 · Hero → detail continuity: the backdrop stays put while the page arrives — ⏳ later round
- **Kind:** native  ·  **Priority:** P2  ·  **Effort:** M
- **Files:** `phone/src/lib/zoom.js` (owner: navigation), `phone/src/screens/Home.svelte` (mark the origin)
- **Now:** "Details" (and HOME-08's tap) push with the generic slide. The detail page then shows the **same
  backdrop** 440 pt tall, where it was 572 on Home, so the image visibly jumps sideways and back.
  `zoom.js` only takes origins from `.tile` / `.cast` taps (zoom.js:52–61).
- **Change:**
  - Let `zoom.js` accept the hero as an origin. Taps inside `.homehero` resolve to the dominant slide's
    `.homehero__sharp` `<img>`, and the source rect is the hero rect minus the part scrolled away.
  - The overlay morphs from the 393×572 rect to the detail's `.detail__hero` rect: it's the same image, so it
    is mostly a crop change. The detail body slides up/fades in under it (`--dur-push` 380 ms, `--ease-sheet`).
  - On pop, reverse it back into the hero. If the hero has scrolled away or the slide changed meanwhile, use
    zoom.js's existing fade fallback.
- **Why:** In the TV app, Music and the App Store, the featured artwork carries into the page. The backdrop is
  the one element both screens share, so moving it is the most natural transition available.
- **Constraints & risks:**
  - Auto-advance must be held while the page is pushed. `active` is already false then, and the slide can't
    change under the reverse animation.
  - Reduced motion: zoom.js already fades.
  - The navigation auditor owns zoom.js; this task needs their agreement on the origin API.
- **Verify:** Dev frame: Details from a hero slide; swipe back. The backdrop should never jump.
- **Depends on / conflicts with:** HOME-08. Navigation auditor (zoom.js).

### HOME-10 · Let the quick-add "+" confirm: + → spinner → ✓ → away → merged into LIB-02 ✅
- **Kind:** craft  ·  **Priority:** P2  ·  **Effort:** S
- **Files:** `phone/src/components/Tile.svelte` (`{#if onadd}` block, :143), `phone/src/screens/Home.svelte`
  (trending snippet, :716)
- **Now:** Home passes `onadd={!own && st !== 'adding' ? … : null}`. The moment the "+" is tapped it disappears
  in the same frame. Success is only told by a toast at the bottom of the screen, far from the finger.
- **Change:**
  - Tile takes `addState` (`'idle' | 'adding' | 'done' | 'added' | 'error'`, as `lookup.svelte.js` defines).
    The button stays mounted while `idle | adding | done`:
    - `adding`: a 14 px spinner replaces the plus. Use the existing `.spinner`, sized down; rotate is
      transform-only.
    - `done`: a gold ✓ (icon `check`) scales `.6 → 1` over 260 ms with `EASE.spring`, holds 1.2 s, then the
      button fades and scales to `.8` over 200 ms and unmounts.
    - `error`: back to `+`.
  - Home: `addState={st}`, and `onadd` only when `st === 'idle' || st === 'error'`.
- **Why:** This is the App Store's GET → progress → done pattern. The feedback stays where the finger is.
- **Constraints & risks:**
  - The spinner is an infinite animation, but only while a request is in flight.
  - Tile is shared: Search, Chart and the Collection rail use `onadd`. Tell the Library/Search and Detail
    auditors so they adopt it rather than build a variant.
  - Reduced motion: no scale, just swap the icons.
- **Verify:** ⚠️ Adding is a real mutation. Don't test against the server. In DevTools, stub `addToLibrary` (or
  intercept `POST /ml/api/library…` with CDP `Fetch` and fulfil 200 after 800 ms), then tap "+".
- **Depends on / conflicts with:** Library/Search auditor (same component).

### HOME-11 · Stop the 6 s auto-advance after two laps, and restart it on the next visit — ⏳ later round
- **Kind:** perf / craft  ·  **Priority:** P3  ·  **Effort:** S
- **Files:** `phone/src/screens/Home.svelte` (auto-advance effect, :345–352)
- **Now:** While Home sits at the top, the hero advances every 6 s forever. At 700 ms per transition that is
  about 12 % of the time with full-screen layers animating at the display's top rate.
- **Change:**
  - Count auto-advances since the last hero touch or `active`/visibility change.
  - After `2 × slides.length`, stop. Land the last one on slide 0 (the most relevant item) by advancing only
    while `cur !== 0` in the final lap.
  - Reset the count on pointerdown on the hero, on `active` becoming true, and on `pageHidden` → visible.
- **Why:** This is the project's "3 loops, then settle" rule for the marquee and download ring
  (`/CLAUDE.md`). An idle screen should end up truly idle. It is also calmer: after a minute the hero rests on
  what you were watching.
- **Constraints & risks:** None. Reduced motion already disables auto-advance.
- **Verify:** Dev frame. Leave Home idle for 2 × n × 6 s. `__carousel.p` should stop changing and end at 0.
- **Depends on / conflicts with:** none.

### HOME-12 · Fade the first content paint in over the skeleton instead of cutting — ⏳ later round
- **Kind:** craft  ·  **Priority:** P3  ·  **Effort:** S
- **Files:** `phone/src/screens/Home.svelte` (skeleton branch, :512), `phone/src/styles/home.css`
- **Now:** The skeleton (hero block + one rail) is replaced by the full page in one frame (~500 ms on the dev
  frame).
- **Change:**
  - Only when the skeleton was actually shown: set `reveal = true` on the paint, and remove it 700 ms later so
    later inserts never re-trigger it.
  - CSS:
    `.home--reveal > .homehero, .home--reveal > .rail, .home--reveal > .home__rail { animation: home-in 260ms var(--ease-out) both; }`
    with `@keyframes home-in { from { opacity: 0 } }`.
  - Add a stagger of 40 ms × index for the first three rails only (`:nth-child`). No translate: content should
    not appear to move.
  - Reduced motion: no animation.
- **Why:** iOS content loads cross-dissolve out of placeholders. A hard cut from pulse blocks to a full-bleed
  image is the most "web" moment of a first launch.
- **Constraints & risks:** The parent opacity animation groups the carousel layers for 260 ms, which is fine.
  With HOME-03 this path only runs on a first-ever launch or after a sign-in.
- **Verify:** Dev frame: clear `reel.homeSnap.*`, reload. The page should dissolve in without a hard cut.
- **Depends on / conflicts with:** HOME-03, HOME-04 (`.home__rail` wrapper).

### HOME-13 · Slow parallax of the backdrop on vertical scroll (Safari 26+, compositor-only) — ⏳ later round
- **Kind:** craft  ·  **Priority:** P3  ·  **Effort:** S
- **Files:** `phone/src/styles/home.css`
- **Now:** The hero scrolls rigidly with the page.
- **Change:** Progressive enhancement with scroll-driven animations. No JS, and nothing on iOS < 26.
  ```css
  @supports (animation-timeline: scroll()) {
    @media (prefers-reduced-motion: no-preference) {
      .home { scroll-timeline: --home block; }
      .homehero__media { animation: homehero-parallax linear both; animation-timeline: --home; animation-range: 0 var(--hero-h); }
      @keyframes homehero-parallax { to { transform: translate3d(0, 30%, 0); } }
    }
  }
  ```
  - It must be a **named** timeline. `scroll(nearest)` would resolve to `.hero` / `.homehero__media`
    themselves, because `overflow: hidden` makes them scroll containers, and the animation would never move.
  - It goes on `.homehero__media`, whose `transform` carousel.js never writes. carousel.js only sets
    `zIndex`/`visibility` there and writes transforms on the children, so the two compose.
  - Don't animate opacity on `.homehero__body`: an animation would override carousel.js's inline opacity.
- **Why:** The TV app and App Store heroes scroll slower than the page, which gives depth.
- **Constraints & risks:**
  - The area revealed above the media is off-screen. Its top edge sits at −0.7·scrollTop.
  - Verify on the iPhone that WebKit runs it smoothly. If it jitters, drop it: never do this with a JS scroll
    listener.
- **Verify:** iPhone (iOS 26) only. Headless Chrome also supports it, so layout can be checked there.
- **Depends on / conflicts with:** none.

### HOME-14 · Optional: the title's clear logo instead of serif text in the hero — ⏸ awaiting decision
- **Kind:** craft  ·  **Priority:** P3 (product decision)  ·  **Effort:** M
- **Files:** `phone/src/screens/Home.svelte` (`U` query `EnableImageTypes`, hero body :566–568),
  `phone/src/styles/home.css`
- **Now:** Always the Instrument Serif title. SPEC §2 Hero allows "serif title (or clearlogo)".
- **Change:**
  - Add `Logo` to `EnableImageTypes`.
  - When `ImageTags.Logo` (or `ParentLogoItemId`/`ParentLogoImageTag` for episodes) exists, render
    `<img class="hero__logo" src={imgUrl(it,'Logo',{h:176})} alt="">`: `max-height: 88px; max-width: 72%;
    object-fit: contain; object-position: left bottom; filter: drop-shadow(0 1px 12px rgb(0 0 0 / .5))`.
  - Keep the `<h1>` for VoiceOver (`.sr-only`).
  - Fall back to serif.
- **Why:** It is the TV app's signature look, and a hand-made title treatment per film.
- **Constraints & risks:**
  - It trades the app's consistent serif voice for varied studio logos. **Ask the user before building.**
  - Dark logos need the shadow.
  - `filter` on a static image is painted once, not animated.
- **Verify:** Dev frame on a few slides, including a dark logo.
- **Depends on / conflicts with:** HOME-02 (same slide body).

## Considered and rejected
- **Time-of-day greeting ("Good evening, Alice"):** the hero eyebrow already sets context, a greeting adds a line
  of chrome with no information, and the design has none.
- **Stretchy hero on pull-down:** the top ~110 pt of the hero is veiled to 78 % `--bg` (home.css:48–60), so the
  rubber-band gap is nearly invisible. Doing it needs `.hero` clipping changes plus a scroll listener. Not worth it.
- **`scroll-snap-stop: always` / custom paging for rails:** one tile per flick is tedious for 16-item rails.
  Native overflow scrolling already is `UIScrollView` physics, and a JS replacement would lose it.
- **A continuous "timer fill" in the active page dot (UIPageControl progress):** it turns a 6 s interval into
  an always-running animation that keeps the display at full rate. Revisit only together with HOME-11.
- **Crossfading the hero when its current slide disappears (removed or watched):** a keyed `out:` would leave
  stale `data-i` nodes for carousel.js's selectors. The event is rare, and the cut is acceptable.
- **Dominant colour by sampling decoded images:** needs a canvas readback per tile (CORS, main thread). The
  blurhash DC term is already in the API response (HOME-05).
- **Rubber-banding past ±1 slide in a carousel drag:** it clamps at one slide (carousel.js:128), which the
  user can't really notice with a circular carousel.
- **Tap/scrub on the page dots:** 6 pt targets; swiping the hero is the real gesture.

## Cross-refs
- **Motion system / micro-interactions:**
  - `.tile:active` (components.css:392) applies on touchstart, so every horizontal swipe that starts on a tile
    flashes the press scale. iOS delays content highlights ~100–150 ms (`delaysContentTouches`) and cancels
    them on scroll. A delayed `.is-pressed` (≈ 90 ms, cancelled on move > 10 px or on `scroll`) with a
    springy release would fix it globally. It is most visible in Home's rails.
  - Generic image fade-in for `.art > img` should compose with HOME-05's tinted placeholder and not touch
    the hero.
  - **Haptics:** `gestures.js:57` calls `navigator.vibrate`, which is a no-op on iOS. The only web path is the
    `<input type="checkbox" switch>` + `label.click()` trick (iOS 18+). It may not fire from the long-press
    timer, because it needs transient user activation. iPhone-only to verify.
- **Navigation / transitions:**
  - The TopBar wordmark jumps 34 → 28 px and the glass appears with no transition (`.topbar--solid`,
    components.css:85–90; app.css `.wordmark--short`). iOS large titles collapse continuously.
  - Status-bar tap-to-top can't work: the document never scrolls (body fixed, inner `.screen` scrollers).
    Tab re-tap should scroll to top smoothly (unless reduced motion).
  - HOME-09 needs a hero origin in `zoom.js`.
  - After Home's tab-root scroll-to-top, auto-advance resumes by itself (`solid` goes false). No change needed.
- **Sheets / menus:**
  - `.ctx__menu` is 312 wide (iOS ≈ 250). "Remove from Continue Watching" wraps to two lines at that width,
    which is acceptable.
  - HOME-06 changes ContextMenu's open/close choreography for every screen that uses `fit: 'rect'`.
- **Library / Search / Chart and Detail:**
  - HOME-10 (quick-add confirmation) and HOME-05 (`tint` placeholder) are Tile props they can adopt.
  - HOME-07 fits `.detail__resume` too.
- **PWA shell:** the service worker never caches `/jf` images. HOME-03's offline snapshot will show lettering
  wherever iOS's HTTP cache evicted a poster. Caching Jellyfin images with a tag parameter in the service worker
  (immutable by tag) would complete it.
