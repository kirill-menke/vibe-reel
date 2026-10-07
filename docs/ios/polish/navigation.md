# Navigation & transitions — polish and native-feel tasks

Most of the structure already reads as native. Each tab has its own stack, and every page stays mounted, so scroll positions and data survive for free. Push and pop slide with the −30 % parallax and a dim. The edge swipe follows the finger, and the tile → page zoom (`lib/zoom.js`) can be interrupted and dragged. Re-tapping the active tab pops to the root and then scrolls to the top, and on Search it focuses the field. Tab switches are instant, as in UIKit, and the pushed pages' glass back button matches iOS 26.

The gaps are in the physics and in the edge cases. A Back pressed during a push jumps. The swipe release ignores where the finger actually went: it commits on a stale velocity and even on a flick back. The bar glass snaps on instead of fading. Re-showing a hidden page costs a full re-layout. VoiceOver focus is lost on every push.

Measurements below were taken in headless Chrome at 393×852 with touch emulation (scripts in `/tmp/claude-1000/polish-nav/`). WebKit numbers will differ, so each task says what needs checking on the iPhone.

## Tasks

### NAV-01 · Make push/pop interruptible: every transition starts from where the pages are now — ✅ done
- **Done (Wave 1, lane A):** as proposed, incl. step 5 (a swipe mid-push takes over: `swipe.grab()`). `cur()` only reads/cancels animations App started itself (a `WeakSet`), never Svelte's outro timer on a leaving route (cancelling that would leak the node). The pop's duration comes from `leave()` (`a.dur`, scaled by distance, ≤ `DUR.push`), the revealed page uses the same. Measured (headless, 393 px): Back 150 ms into a push — before: page 43 → **0** → 41…; after: 43 → 43 → 85 → … → 393, Home −105 → 0, both monotonic. Double Back (3-deep, 120 ms apart): the middle page reverses from −23 px with no jump. A swipe 120 ms into a push continues from x ≈ 20 px and pops.
- **Kind:** bug · **Priority:** P1 · **Effort:** M
- **Files:** `phone/src/App.svelte` (the `R.anim` `$effect` at 110–153, `leave()` at 163–171, `swipe.enabled` at 224); `phone/src/lib/router.svelte.js` (`pop`, `popToRoot`)
- **Now:** Every transition animates from its canonical start state. `push` animates the new page `100%→0` and `pop` animates `−30%→0` (App.svelte:131–146), and `leave()` slides the popped page from `0` (App.svelte:170). The measured case was Back pressed 150 ms into a push, with the new page at x = 43 px and Home at −105 px. For one frame the page snapped to 0 and Home to −118 px. Then the full 380 ms pop ran from those snapped positions, so the page visibly jerks forward before it slides out. A double tap on Back (pop during a pop) goes through the same path. The edge swipe is also refused for the whole animation (`!R.anim`, App.svelte:224), so a swipe that starts right after a push does nothing.
- **Change:**
  1. Add a helper in App.svelte that reads a route's current state and then cancels its animations:
     `const cur = (el) => { const cs = getComputedStyle(el); const x = new DOMMatrixReadOnly(cs.transform === 'none' ? undefined : cs.transform).m41; const o = +cs.opacity; el.getAnimations().forEach(a => a.cancel()); return { x, o }; }`
  2. In the `R.anim` effect, read `cur()` for both `from` and `to` **before** creating new animations. Animate from those values in px, not from the canonical `%` values, to the target.
  3. Scale the duration by the distance left: `dur = Math.max(160, 380 * Math.abs(xEnd − x) / W)`. If NAV-02 lands, use its spring with v = 0 instead.
  4. In `leave()` for `pop`, read `cur(node)` and start `node.animate([{transform:`translate3d(${x}px,0,0)`},{transform:`translate3d(${W}px,0,0)`}], {duration: d, easing: EASE.sheet, fill:'forwards'})` yourself. Return `{ duration: d + 20 }` with no `css`, so that Svelte only keeps the node alive. Keep the existing note: never `duration: 0`.
  5. Optional second step, closer to iOS 26 where navigation transitions can be interrupted: let `swipe.enabled` accept a running `push`/`pop` (not `zoom`/`unzoom`, which zoom.js already handles). On the swipe's first move, call `cur()` on both pages, set `R.anim = null` and continue the drag from the current x. `paint(dx + x0)` needs an x-offset.
- **Why:** UIKit transitions never jump. iOS 26 made push/pop fully interruptible: you can grab a page mid-push and swipe it back.
- **Constraints & risks:** The `done` guard (`R.anim === a`) already ignores stale finishes, so keep it. Canceled animations fire `oncancel → done` for the old `a`, which is harmless. The zoom path (`zoomOut` mid-open, zoom.js:514–518) is already interruptible, so don't touch it. Reduced motion: a mid-fade Back fades from the current opacity. Phone-only file, so the TV is unaffected.
- **Verify:** In the dev frame (`/__frame`), tap *Details* on the Home hero and tap the back chevron about 150 ms later (or run `setTimeout(()=>__router.pop(),150)` from the console). Record a rAF log of `getComputedStyle(route).transform` as `s2.mjs interrupt` does. The detail page's x must fall monotonically from its current value to 393, with no frame at 0. Also try Back pressed twice quickly on a 3-deep stack.
- **Depends on / conflicts with:** NAV-02 (the spring helper), NAV-04 (durations). NAV-11 (a content swipe) uses the same `cur()` helper.

### NAV-02 · Edge-swipe release: windowed velocity, iOS projection rule, and a settle that carries the finger's speed — ✅ done
- **Done:** projection `at + 499·v > w·T` (T 0.5 slide / 0.3 zoom card), settle on `spring()` for both pages + the edge strip, `ctl.end(done, then, v)` → `zoomDrag` settles on the spring too (`zoomOut({ easing })`, `spring().at`). Two refinements the measurement forced: the velocity window is **cut at the last change of direction** (a 100 ms window across a drag-right-then-flick-back netted +0.76 px/ms and still popped), and the **lift point** (`touchend.changedTouches`) is the last sample — a final `touchmove` isn't guaranteed. The 60 ms rest rule is measured from the last sample that moved. `spring()` now also ends where an overshooting flick first reaches the target (the clamp only held it there and delayed `commit`). Verified with in-page synthetic `TouchEvent`s (CDP `Input.dispatchTouchEvent` round-trips are ~45 ms and deliver the last move after the lift — useless for flick speeds): fast 30 % + 400 ms hold → stays; 60 % + flick back → stays; 60 px in 30 ms → pops; slow 40 % → stays; slow 60 % → pops; the same four on the zoom card. Page-leaves-at-finger-speed: iPhone check.
- **Wave 0:** `spring()` is in `safe.js` (Wave 0, MOT-01); the gesture changes are still to do.
- **Kind:** native / bug · **Priority:** P1 · **Effort:** M
- **Files:** `phone/src/lib/gestures.js` `edgeSwipeBack` (`move` 147–181, `end` 193–232); `phone/src/lib/zoom.js` `zoomDrag().end` (614–642); new `spring()` helper in `phone/src/lib/safe.js`
- **Now:**
  - The velocity is an exponential average that is updated only on `touchmove` (gestures.js:174–175) and never decays. A fast drag to 30 %, then 400 ms of holding still, then a lift **commits the pop** (measured; iOS cancels this).
  - The commit rule `dx/w > 0.35 || (v > 0.45 && dx > 24)` (gestures.js:200) ignores direction. A drag to 61 % followed by a flick back left **still pops** (measured; iOS cancels).
  - The settle is a fixed curve (`EASE_SHEET`) whose duration depends only on the remaining distance (gestures.js:208–220). A fast flick slows down at release, and a slow release starts with a jolt.
  - The zoom drag uses the same `done` flag, with a threshold of 0.22 (zoom.js:605) and fixed durations of 360/300 ms (zoom.js:626, 634).
- **Change:**
  1. Keep the last ~100 ms of `(t, x)` samples. At `end`, compute `v = (x_last − x_first)/(t_last − t_first)` over the samples from the last 100 ms. If the last sample is more than 60 ms old, `v = 0`.
  2. Decide by projection, as UIKit does (WWDC18 "Designing Fluid Interfaces": `project(v) = v · r/(1−r)` with the normal deceleration rate `r = 0.998`, about `0.5 s × v`): `projected = dx + 499 * v` (v in px/ms → px). Commit when `projected > w * T`, where T = 0.5 for the slide and T = 0.3 for the zoom card. The same rule cancels a flick back.
  3. Settle with a critically damped spring that starts at the finger's velocity. Add this to `safe.js`:
     ```js
     /* progress 0→1 of a critically damped spring; v0 = initial velocity in
      * "distances per ms" (finger px/ms ÷ remaining px, toward the target) */
     export function spring(v0 = 0, response = 0.35) {
       const w = (2 * Math.PI) / (response * 1000);
       const x = (t) => 1 + (-1 + (v0 - w) * t) * Math.exp(-w * t);
       let T = 16; while (T < 900 && Math.abs(1 - x(T)) > 0.002) T += 16;
       const frames = Array.from({ length: 21 }, (_, i) => ({ offset: i / 20, p: Math.min(1, Math.max(0, x((T * i) / 20))) }));
       return { duration: T, frames }; // animate with easing: 'linear'
     }
     ```
     Map `p` to both pages' keyframes (top page `x0 → target`, the page beneath `−30 % → 0` and opacity `.6 → 1`, from the same `p`). This keeps them locked together. For a cancel, the target is 0 and `v0 = −v/dx`.
  4. Pass the same `v` to `ctl.end(done, then, v)`, so that `zoomDrag` can derive its durations from `spring()` instead of 360/300.
- **Why:** On iOS, a hesitation cancels, a flick back cancels, a small fast flick commits, and the page leaves at the speed you threw it. This is the gesture people use most, so it is where "web page" shows the most.
- **Constraints & risks:** `spring()` samples 21 keyframes and runs them linearly (zoom.js already does this), so there is no per-frame JS. Clamp `v0` so that a very fast flick can't push `p` above 1 (the clamp is in the helper). Reduced motion: the swipe itself still tracks the finger, which is fine because it is direct manipulation. The release is short either way, so keep it. Sheet.svelte has its own drag (another area, see Cross-refs).
- **Verify:** Run `s6.mjs` in the scratch folder over CDP `Input.dispatchTouchEvent`. Expected: fast to 30 % + hold 400 ms + lift → stays. To 60 % + flick left → stays. A 60 px flick at more than 1 px/ms → pops. On the iPhone, check by feel that the page leaves at your finger's speed.
- **Depends on / conflicts with:** NAV-01 (reuses `spring`), NAV-11. The motion-system auditor may want `spring()` in its token set.

### NAV-03 · Fade the bar glass in and out instead of snapping it (TopBar, NavBar, Library's compact bar) — ✅ done (+ MOT-09)
- **Done:** `::before` glass on `.topbar`/`.navbar` (Library's `.lib__bar` inherits), MOT-09's material values, no `isolation` (NAV-03's backdrop-root warning wins over MOT-09's snippet). Back disc keeps its blur until the bar has faded in (measured: blur still on at 70 ms, off at 370 ms). Mark scales 34 → 28 px (`scale(.82)`). Toggling is **0 Layout** (CDP trace, Home bar on/off) after two extra fixes: the mark's `transform` rests at `scale(1)` and the title's at `translateY(0)` (`none` ↔ a transform is a layout change in Chromium), and the mark's hero text-shadow stays on in the solid state (switching it re-laid the mark out). The detail back button's own `backdrop-filter → none` still lays out that 44 px button (pre-existing, negligible). `.detail__pills` (MOT-09's third bar) is lane D's: see DET-07. **iPhone check:** that the `::before` blur samples the page behind on WebKit (MOT-09's device caveat) and fades at partial opacity.
- **Kind:** craft · **Priority:** P1 · **Effort:** S
- **Files:** `phone/src/styles/components.css` §3 (`.topbar--solid` 85–90, `.navbar` 101–118); `phone/src/styles/app.css` (`.topbar--solid .wordmark--short` at 93); `phone/src/styles/library.css` `.lib__bar` (72–84) inherits the change automatically
- **Now:** `.topbar` has no transition at all, so the Home bar's glass, hairline and blur appear in one frame when the hero scrolls away. `.navbar` fades only `background-color` (components.css:105). `backdrop-filter` and the hairline switch on at once, and `.navbar--solid .iconbtn` removes the back button's glass disc in the same frame (components.css:118). On Home, the "VR" mark jumps from 34 to 28 px (app.css:93), which is a font-size change and therefore a re-layout.
- **Change:** Move the material onto a pseudo-layer and fade only its opacity:
  ```css
  .topbar, .navbar { background: none; }                    /* the glass lives on ::before */
  .topbar::before, .navbar::before {
    content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
    background: var(--glass-bg-strong);
    -webkit-backdrop-filter: var(--glass-blur); backdrop-filter: var(--glass-blur);
    box-shadow: inset 0 -1px 0 var(--line);
    opacity: 0; transition: opacity var(--dur-fast) linear;
  }
  .topbar--solid::before, .navbar--solid::before { opacity: 1; }
  /* back button: lose its disc only after the bar has faded in; get it back at once */
  .navbar .iconbtn { transition: transform var(--dur-press) var(--ease-out), background-color var(--dur-fast) linear, box-shadow var(--dur-fast) linear, -webkit-backdrop-filter 0s, backdrop-filter 0s; }
  .navbar--solid .iconbtn { transition-delay: 0s, 0s, 0s, var(--dur-fast), var(--dur-fast); }
  /* inline title: fade + 4 px rise */
  .navbar__title { transform: translateY(4px); transition: opacity var(--dur-fast) linear, transform var(--dur-fast) var(--ease-out); }
  .navbar--solid .navbar__title { transform: none; }
  /* Home mark: scale, not font-size */
  .topbar .wordmark--short { transform-origin: 0 60%; transition: transform var(--dur-fast) var(--ease-out); }
  .topbar--solid .wordmark--short { font-size: 34px; transform: scale(.82); }
  @media (prefers-reduced-motion: reduce) { .navbar__title { transform: none; } }
  ```
  Remove the `.topbar--solid`/`.navbar--solid` background rules from the element itself. The topbar is already `position: relative`, `.topbar--overlay` is `absolute`, and the navbar is `absolute`, so all of them are containing blocks for `::before`.
- **Why:** On iOS 15+, the bar's scroll-edge appearance → standard appearance is a short crossfade. A snapping blur is one of the most visible web tells, and every page shows it on every scroll.
- **Constraints & risks:** **Do not** put `isolation`, `opacity`, `filter` or `transform` on `.topbar`/`.navbar` themselves. They would become a *backdrop root*, and the `::before` blur would then sample nothing. `z-index: -1` works because both bars already form stacking contexts (they have `z-index`). zoom.js animates the NavBar's opacity during a zoom, which briefly makes it a backdrop root. That is harmless because the bar is not solid then. The cost is one opacity animation on a small layer for 180 ms. A fade is not a slide, so reduced motion keeps it.
- **Verify:** In the frame, scroll a Movie detail past the backdrop and back, then do the same on Home past the hero and on Movies past the large title (`.lib__bar`). The blur, tint and hairline should fade together, the back button's disc should vanish only as the bar arrives, and "VR" should shrink without the bell or avatar moving. Record a CDP trace and check that toggling causes no Layout.
- **Depends on / conflicts with:** The motion-system auditor (it owns `--dur-fast`). Library (C) needs no change.

### NAV-04 · Tune push/pop to UIKit's weight: ~500 ms on the same curve, a real edge shadow, tokens instead of literals — ✅ done (duration: token only, still 380 ms ⏸ awaiting the user's 380 vs 500 call)
- **Done:** `DUR.push` is a getter that reads `--dur-push` from tokens.css once, so **changing `--dur-push: 380ms` → `500ms` in tokens.css is the whole switch** (App's push/pop and their interrupted variants follow; the swipe release uses the spring, zoom its own 460/420). The edge strip is `.stage__edge` (App.svelte + app.css), moved by the push/pop (`edge()`) and by the swipe (`shadow()` option); the route's `box-shadow` is gone. The Paint comparison was not conclusive in headless Chrome (same Paint count either way) — check on the iPhone with Web Inspector.
- **Kind:** native / craft · **Priority:** P2 · **Effort:** S (duration) / M (shadow)
- **Files:** `phone/src/App.svelte` (117, 148, 169–170), `phone/src/lib/gestures.js` (10–11, 169, 209), `phone/src/styles/app.css`
- **Now:** Push and pop run 380 ms on `cubic-bezier(.32,.72,0,1)`. That curve front-loads the motion: in the measured run, 80 % of the travel (393 → 78 px) was done by about 100 ms, followed by a 250 ms tail of tiny movement. The whole thing reads as "snappy web". The swipe paints a `box-shadow` on the dragged page (gestures.js:169), but push and pop have no edge at all. The value 380 is hardcoded in three places, although `--dur-push` exists in tokens.css.
- **Change:**
  1. Use `--dur-push`, read once through `getComputedStyle(document.documentElement)`, and have the motion-system owner set it to **500 ms**. Keep `--ease-sheet`. Ionic's frame-matched iOS page transition is 540 ms on exactly this curve. zoom.js already uses 460/420.
  2. For a shadow without repainting the page, add one sibling to `.stage`: `<div class="stage__edge" aria-hidden="true">`, 24 px wide, `background: linear-gradient(to left, rgba(0,0,0,.35), transparent)`, `position:absolute; top:0; bottom:0; left:0; z-index:1; pointer-events:none`. Animate it with the moving page's px transform (`translateX(x − 24px)`) and fade it to 0 over the last 20 %. The swipe uses the same element instead of setting `box-shadow` on the route: changing `box-shadow` on a full-page layer repaints the whole page on the first drag frame.
- **Why:** UIKit's push is a critically damped ~0.5 s settle. The current timing is correct in shape but short. The edge shadow is what makes the pages read as stacked cards on bright backdrops.
- **Constraints & risks:** A longer animation makes NAV-01 more important, so land NAV-01 first. Reduced motion stays at the 180 ms fade. The shadow strip is only visible over bright content, and on the dark background it is invisible, which is fine.
- **Verify:** Compare 380 and 500 on the iPhone side by side with the user (push into a detail page and Back several times). Record a CDP trace during a swipe start with the old `box-shadow` and with the strip, and compare Paint events.
- **Depends on / conflicts with:** NAV-01, NAV-02 (the release uses the spring, not this duration), the motion-system auditor (tokens).

### NAV-05 · Tab bar: one sliding selection lens and a tinted active glyph — ✅ done
- **Done:** `.tabbar__lens` with `--dur-spring-quick` + `--spring-snappy` (the motion-system pair for a tab-bar pill) instead of the literal 420 ms curve; the stretch uses the `scale` property (composes with the glide's `transform`), skipped under Reduce Motion; active glyph `fill-opacity: .22`. Measured: lens at `translateX(160px)` = the Shows item's x (198.5), stretch 1.11 at 60 ms.
- **Kind:** craft / native · **Priority:** P2 · **Effort:** M
- **Files:** `phone/src/components/TabBar.svelte` (15–25), `phone/src/styles/components.css` §4 (`.tabbar` 166–174, `.tabbar__item--active` 183)
- **Now:** Each item carries its own `--gold-soft` background. When the tab changes, the old pill fades out and the new one fades in over 180 ms linear (components.css:180), so the selection jumps between items.
- **Change:** Add `<span class="tabbar__lens" style="--i:{idx}" aria-hidden="true"></span>` as the first child of `.tabbar` and remove the background from `.tabbar__item--active`.
  ```css
  .tabbar { position: absolute; }                     /* already; the lens is positioned in it */
  .tabbar__lens {
    position: absolute; left: var(--s-1); top: var(--s-1);
    width: var(--tabbar-item-w); height: var(--tabbar-h); border-radius: var(--r-pill);
    background: var(--gold-soft); pointer-events: none;
    transform: translateX(calc(var(--i) * (var(--tabbar-item-w) + var(--s-1))));
    transition: transform 420ms cubic-bezier(0.32, 0.72, 0, 1);
  }
  .tabbar__item { position: relative; }               /* above the lens */
  .tabbar__item--active .i { fill: currentColor; fill-opacity: .22; }  /* SF "filled when selected" */
  @media (prefers-reduced-motion: reduce) { .tabbar__lens { transition: none; } }
  ```
  An optional "liquid" touch in the iOS 26 lens manner: when `--i` changes, run one WAAPI keyframe set on the lens (`scaleX 1 → 1.12 → 1` at offsets 0/.4/1, 420 ms). Skip it under reduced motion.
- **Why:** The iOS 26 floating tab bar moves one selection lens between items, and selected SF symbols switch to their filled variant. The capsule already looks iOS 26, so a moving selection is what makes it behave that way.
- **Constraints & risks:** The home, movies, shows and search paths are closed shapes, and the door notch in home stays open, so a low-opacity fill tints them cleanly. The search handle is a line and gets no fill. Check the look at 2×. The lens animates only on a change (one small layer, idle otherwise). The content switch itself stays instant (see Rejected).
- **Verify:** In the frame, tap through the four tabs and check that the lens glides with no fade. With reduced motion (`rm=1`) it jumps. A CDP trace shows no Layout on a tab tap from the lens.
- **Depends on / conflicts with:** none. The micro-interactions auditor may touch `.tabbar__item:active`.

### NAV-06 · Keep hidden pages' rendering state warm (`content-visibility: hidden` instead of `display: none` for likely-next pages) — ⏳ later round
- **Kind:** perf · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/App.svelte` (the `<section class="route">` at 284–291), `phone/src/styles/app.css` (13, 19)
- **Now:** Every non-shown route is `hidden`, which means `display:none !important` (app.css:13). Returning to it (a pop, or a tab switch) rebuilds layout and paint for the whole page in the first frame, and App re-applies the saved scroll offsets (App.svelte:173–209).
  Measured at 4× CPU throttle, from tap to the next frame, with a stylesheet override (`.route[hidden]{display:block!important;content-visibility:hidden}`) as the B variant:

  | Action | `display: none` | `content-visibility: hidden` |
  |---|---|---|
  | Tab switch Home ↔ Movies | median ~34 ms (17–50) | ~17 ms (13–33) |
  | Pop | 5–15 ms | 3–7 ms |
- **Change:** Mark the routes that are likely to show next with `data-warm`: the top of each visited tab, and `beneath()` of the active tab. For example, `data-warm={isTop || (tab === R.tab && i === R.stacks[tab].length - 2) || undefined}`. Then add:
  ```css
  @supports (content-visibility: hidden) {
    .route[data-warm][hidden] { display: block !important; content-visibility: hidden; }
  }
  ```
  Keep the `hidden` attribute and `inert` as they are (for semantics and focus), and keep the offsets Map as a safety net.
- **Why:** UIKit keeps the view controllers of other tabs and the one beneath fully laid out, so going back is free. This is the web equivalent, and it targets the first frame of every pop and tab switch.
- **Constraints & risks:** Safari 18+ only (iOS 17 falls back to `display:none`). Memory: only about 5 routes stay warm, not the whole stack (10 per tab), and deeper pages keep `display:none`. IntersectionObservers in warm-hidden pages (Library paging sentinel) must not fire, so verify that Library doesn't page while another tab is shown. Hidden contents stay out of the a11y tree and find-in-page.
- **Verify:** Rerun `s5.mjs` against the real change. On the iPhone, use Safari Web Inspector → Timelines and compare the Layout/Paint time of a tab tap before and after.
- **Depends on / conflicts with:** NAV-01 (reads `getComputedStyle` of shown routes only, so no conflict), zoom.js `findTile` (measures `under`, which is shown by then).

### NAV-07 · Stop making every scroll wait for JS: move the non-passive `touchmove` from the whole stage to a thin edge strip — ⏳ later round (needs the iPhone busy-loop check first)
- **Kind:** perf · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/lib/gestures.js` (`edgeSwipeBack` listeners 234–236), `phone/src/App.svelte` (277), `phone/src/styles/app.css`
- **Now:** `edgeSwipeBack` sits on `.stage`, which covers the whole screen, with `touchmove` `{ passive: false }` (gestures.js:235). WebKit records non-passive listeners as a *synchronous* event-tracking region. Inside that region, a touchmove has to be handled by the web process before the scroll may start, because the handler could `preventDefault()`. As a result, every vertical scroll and rail swipe anywhere in the browsing UI starts only after the main thread has answered, so a busy frame (image decode, a Svelte flush) delays the first scroll movement. The handler returns within microseconds for 99 % of touches, which don't start at the edge, but it still has to be dispatched synchronously.
- **Change:** Render `{#if R.booted && !R.modal && beneath()}<div class="edgezone" use:edgeSwipeBack={swipe} aria-hidden="true"></div>{/if}` inside `.stage` after the routes. Style it as `.edgezone { position:absolute; left:0; top:0; bottom:0; width:16px; z-index:3; touch-action:none; }`, and remove `use:edgeSwipeBack` from `.stage`. Touch events keep targeting the element where the touch started, so the drag works unchanged. Only touches that start in the strip are synchronous. If the strip overlaps the back button (x 12–56), a tap with no drag should be forwarded: on `touchend` without `started`, set `el.style.pointerEvents='none'`, call `document.elementFromPoint(x,y)?.click()`, then restore.
- **Why:** Native scrolling never waits for app code. Keeping the rest of the page on passive listeners is the closest a web view gets to that.
- **Constraints & risks:** **Verify on the iPhone first.** The benefit is a WebKit behaviour and can't be measured in Chrome. To test it, add a temporary 150 ms busy loop in a `touchstart` capture listener: before the change, a scroll starts late; after it, the scroll starts at once. If that shows no difference, drop this task. A rail dragged from inside the 16 px strip now becomes a back swipe, as the system edge gesture does on iOS.
- **Verify:** On the iPhone, use the busy-loop test above. In the dev frame, the frame's *edge swipe back* dev button still works (it dispatches from x ≈ 5).
- **Depends on / conflicts with:** **Conflicts with NAV-11** (a content swipe needs listeners across the content). If NAV-11 is done, it uses passive listeners plus CSS `touch-action`, as described there.

### NAV-08 · Tap the top bar to scroll to the top, on every page (the status-bar tap substitute) — ✅ done
- **Wave 2 (agent 3):** Library's compact bar now calls the router's `scrollToTop()` too (the fling stop) instead of its own `scrollTo`. Measured: 130 → 14 → 0 px over ~360 ms.
- **Done:** NavBar's title is always a `<button>` (untappable via `pointer-events` and `tabindex=-1` while the bar is clear, so the fade is kept); TopBar has an always-rendered `.topbar__totop` behind its content, tappable only while solid (no DOM insert on the toggle). One helper, `scrollToTop()` in router.svelte.js, also used by the tab re-tap: it stops a fling first (overflow off for a frame) — the during-a-fling behaviour is an iPhone check. Measured: bar tap → scrollTop 597 → 0 in ≈ 1.3 s smooth.
- **Kind:** native · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/components/NavBar.svelte` (13–16), `phone/src/components/TopBar.svelte` (26–47); pattern already in `phone/src/screens/Library.svelte` (`toTop` 248–250, `.lib__bartitle` 650)
- **Now:** Only Movies/Shows scroll to the top when their compact bar is tapped. Detail, Person, Chart, Settings, Downloads and Home have no equivalent apart from re-tapping the tab, which only works at a root.
- **Change:** When the NavBar is `solid`, render its title as a `<button class="navbar__title" aria-label="{title}, scroll to top">`. Its handler is:
  `const s = e.currentTarget.closest('.route')?.querySelector('.screen'); s?.scrollTo({ top: 0, behavior: reducedMotion() ? 'instant' : 'smooth' })`.
  Do the same on TopBar for the empty flex space between the mark/title and the actions: an `aria-hidden` absolutely positioned button under the actions, only when `solid`.
- **Why:** On iOS, tapping the top of the screen scrolls up. A web app can't get the status-bar tap (see Rejected), but the bar sits right under it, so a tap there lands where users already aim.
- **Constraints & risks:** WebKit may ignore a programmatic scroll during momentum on an overflow scroller. Test a tap during a fling. If it's ignored, stop the momentum first: set `s.style.overflowY='hidden'`, then in the next frame set it back to `''` and call `scrollTo`. The title must stay non-interactive while the bar is clear (it's invisible then).
- **Verify:** In the frame, scroll a detail page, tap the bar title, and check that it glides to the top. On the iPhone, repeat during a fling.
- **Depends on / conflicts with:** NAV-03 (the same elements).

### NAV-09 · Hand VoiceOver focus to the new page on push, and back to the tile on pop — ✅ done
- **Wave 2 (agent 3):** `app.css` `[tabindex="-1"]:focus { outline: none }` — Chrome counts script focus as `:focus-visible` after a keyboard press (and when it saw no pointer), so the focused title showed a ring. Measured: Tab, then push Settings/Downloads → the h1 matches `:focus-visible` but `outline-style: none`; the next Tab lands on a control with its 2 px ring.
- **Done:** router.push() remembers the covered page's focused element (it turns inert and drops focus in the same flush); App focuses the new page's `.screen h1` (else `h1, .navbar__title`, `tabindex=-1`) when a push lands, and restores the remembered element when a pop lands (not after a tab re-tap, which keeps focus on the tab bar; not on tab switches; not under a sheet/modal). NavBar's back button reads "Back to <page underneath>" (tab root name or its heading). Measured: push → `activeElement` = `H1.detail__title`; pop → the tile again. VoiceOver itself: iPhone check.
- **Kind:** native (a11y) · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/App.svelte` (the `R.anim` effect's `done`, 118), `phone/src/components/NavBar.svelte` (14)
- **Now:** After a push, focus stays on the tapped tile, which is now inside an `inert` route, so the VoiceOver cursor is lost. After a pop, focus goes nowhere in particular. The back button is announced only as "Back".
- **Change:**
  1. Before a push, store `document.activeElement` per `from` route key. When a push lands (in `done`, and at once when there is no animation), call `route.querySelector('h1, .navbar__title')` on the new top, give it `tabindex="-1"` if needed, and call `.focus({ preventScroll: true })`.
  2. When a pop lands, re-focus the stored element if it is still connected.
  3. Give NavBar an optional `backLabel` (the title of the page beneath, read from the DOM `h1` of `beneath()` in App and passed through a tiny store, or simply `aria-label="Back"` plus a visually hidden previous title).
- **Why:** UIKit posts a *screen changed* notification on push and pop, so VoiceOver lands on the new title, and the back button reads "Movies, back button".
- **Constraints & risks:** A programmatic focus after a touch doesn't show `:focus-visible` rings, so this is invisible for sighted users. Skip it while a sheet or modal is up.
- **Verify:** In the frame, push a detail page and check that `document.activeElement` is its title. On the iPhone, check with VoiceOver on.
- **Depends on / conflicts with:** NAV-10 (uses the same titles).

### NAV-10 · Long-press the back button → a menu of the back stack — ⏳ later round
- **Kind:** native · **Priority:** P3 · **Effort:** M
- **Files:** `phone/src/components/NavBar.svelte`, `phone/src/lib/router.svelte.js` (new `popTo(key)`), `phone/src/components/ContextMenu.svelte` (reuse)
- **Now:** Back steps one page at a time. On deep stacks (Detail → Person → Detail → Collection film…) the only way home is several taps, or the tab (which goes all the way to the root).
- **Change:** Add `use:longpress` on the back button that opens a `ContextMenu` with `fit="rect"` anchored at the button. It lists the stack below the top, most recent first, with each title read from that route's DOM (`.route[data-key] h1` / `.navbar__title`, falling back to the tab name for the root). Selecting an item calls `popTo(key)`: `R.anim = {dir:'pop', from: top.key, to: key, gone}` and `setStack(tab, stack.slice(0, idx+1))`, the same as `popToRoot`. A plain tap still pops once.
- **Why:** iOS 14+ has exactly this on every back button, and power users rely on it.
- **Constraints & risks:** `longpress` swallows the following click (gestures.js:78–83), so the tap does not also pop. The menu has no preview snippet.
- **Verify:** In the frame, push 3 pages, right-click (which acts as a long-press) the back button, pick the root entry, and check that one pop animation lands on the root.
- **Depends on / conflicts with:** NAV-01 (`popTo` goes through the same transition path), NAV-09.

### NAV-11 · Swipe back from anywhere in the page (iOS 26 content swipe), not only from the 20 px edge — ⏳ later round (only if NAV-07 holds on the iPhone)
- **Kind:** native · **Priority:** P3 · **Effort:** M
- **Files:** `phone/src/lib/gestures.js` (`edgeSwipeBack.start` at 132–137, `move` at 147–173), `phone/src/App.svelte` (`swipe`)
- **Now:** A swipe only starts at `clientX ≤ 20` (gestures.js:135).
- **Change:** Add an option `content: true`. A touch anywhere qualifies unless the target has a horizontally scrollable ancestor up to the route (`scrollWidth > clientWidth` and `overflow-x` auto/scroll: `.rail` tracks, season pills) or an ancestor with `[data-noswipe]`. Put `data-noswipe` on the Home hero carousel, the player, and the scrubber/sheet (outside the stage anyway). Lock the axis after 10 px, requiring `dx > 0 && dx > 2·|dy|`. Use passive listeners and `touch-action: pan-y` on `.screen` (a rail's own `pan-x` still wins, because touch-action is resolved only up to the element that pans). Once the axis locks, set `overflow-y:hidden` on the page's `.screen` until the gesture ends so that it stops drifting vertically.
- **Why:** iOS 26 lets you swipe back from anywhere in the content of a navigation stack, which is much easier one-handed on a 6.1″ screen.
- **Constraints & risks:** This is the riskiest gesture change. Rails at `scrollLeft 0` must still rubber-band and not pop, so exclude horizontal scrollers entirely, even at their start. It **conflicts with NAV-07**: if both land, the strip keeps the edge case and the content path is passive. Check that it does not break the long-press menu, double-tap or text selection. Consider it only after NAV-02 is solid.
- **Verify:** In the frame, drag horizontally from the middle of a detail page's overview (it pops) and on its cast rail (the rail scrolls). On the iPhone, test the Home hero carousel and the season pills.
- **Depends on / conflicts with:** NAV-02 (the release rule), NAV-07 (conflict), Home auditor (carousel).

### NAV-12 · Large titles stretch on pull-down, as UIKit's do — ⏳ later round
- **Kind:** native / craft · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/components/TopBar.svelte` (`.topbar__title`), the scroll handlers that already exist in `phone/src/screens/Library.svelte` (239–242) and Search. Add a tiny shared action in `phone/src/lib/gestures.js` (`use:overscrollTitle`).
- **Now:** Pulling Movies/Shows/Search down past the top rubber-bands the content, but the large title stays rigid.
- **Change:** An action on the `.screen` that, on `scroll`, sets `title.style.transform = scale(${1 + Math.min(0.12, -scrollTop / 600)})` with `transform-origin: 0 100%` while `scrollTop < 0`, and clears it at ≥ 0. Only write the style when the value changes. Skip it under reduced motion.
- **Why:** UIKit large titles scale up slightly when you pull the page down. It is a small, well-known sign of care.
- **Constraints & risks:** **Verify first** that iOS WebKit reports negative `scrollTop` for an overflow scroller while it rubber-bands. If it clamps to 0, drop this task, because no other signal is cheap. There is one style write per scroll event, and only during overscroll.
- **Verify:** iPhone only.
- **Depends on / conflicts with:** Library/Search (C) own the screens, so ask them to add `use:overscrollTitle`.

### NAV-13 · Bell badge: pop in when it appears, a tiny bump when the count changes → merged into MOT-10 (Wave 2) — ✅ done
- **Wave 2:** built as MOT-10's WAAPI pop/bump (not `{#key}` + `@starting-style`: a keyed CSS entry would replay whenever the route is un-hidden, and would pop at boot, which MOT-10 rules out). Bumps on an increase only.
- **Kind:** craft · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/components/TopBar.svelte` (41), `phone/src/styles/components.css` (`.iconbtn__badge` 134–141)
- **Now:** The badge appears and changes instantly.
- **Change:** Use `{#key unread}<span class="iconbtn__badge">…</span>{/key}` and add:
  ```css
  .iconbtn__badge { transition: transform 360ms var(--ease-spring), opacity 150ms linear; }
  @starting-style { .iconbtn__badge { transform: scale(.5); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .iconbtn__badge { transition: none; } }
  ```
- **Why:** iOS badges scale in with a small spring. This is one of those "someone cared" details, and it only runs when the count actually changes.
- **Constraints & risks:** `@starting-style` needs Safari 17.5+. iOS 17.0–17.4 simply don't animate. Because the badge is keyed on the count, it replays when the count goes up while you look at the screen, which is intended. It also plays once at boot, which is fine.
- **Verify:** In the frame, run `__reelDev` or toggle a news item seen/unseen and watch the badge.
- **Depends on / conflicts with:** the motion-system auditor (`--ease-spring`).

### NAV-14 · Reduced motion: pop cross-fades without dipping to black — ✅ done
- **Done:** pops carry `back: true`; under Reduce Motion only the leaving page fades, from its current opacity. Measured: the revealed Home stays at opacity 1.00 through the pop (before: both at 0.5 halfway); a Back 90 ms into a fade-push fades out from 0.46 instead of jumping to 1.
- **Kind:** bug · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/App.svelte` (147–148, 169)
- **Now:** Under reduced motion, a pop fades the leaving page 1 → 0 (`leave`, App.svelte:169) **and** the revealed page 0 → 1 (App.svelte:148) at the same time. Measured halfway: both are at 0.5, so about 25 % of the black background shows through, a visible dip.
- **Change:** In the `fade` branch, animate `to` only when `a.dir` came from a push. For a pop, leave `to` at opacity 1 underneath. `router.pop` sets `dir: 'fade'` for both, so add `back: true` to the pop's `R.anim` and branch on it.
- **Why:** iOS's Reduce Motion push/pop is a clean cross-dissolve.
- **Constraints & risks:** none.
- **Verify:** Run `s3.mjs` (reduced motion emulated). The opacity of `home-1` stays 1 throughout the pop.
- **Depends on / conflicts with:** NAV-01 (same code).

### NAV-15 · Start mounting a first-visit tab on touch-down, not on click — ⏳ later round
- **Kind:** perf · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/components/TabBar.svelte` (18–22), `phone/src/lib/router.svelte.js` (`R.visited`)
- **Now:** The first tap on Movies mounts the whole Library page inside the click task. Measured: 133 ms from tap to frame at 4× throttle, against ~20–40 ms for later taps. The tab bar's own selection only updates after that.
- **Change:** On `pointerdown` of an unvisited tab item, set `R.visited[tab] = true`, which mounts it hidden. The `click` then only switches. Nothing changes if the finger slides off: the tab is mounted and fetched about 100 ms earlier than it would have been, which is harmless.
- **Why:** Tab bars on iOS respond on the first frame. This moves the mount cost into the time the finger is down.
- **Constraints & risks:** The per-tab "no fetch until first visit" decision stays intact, because this still only fires on an intent to visit. The screen gets `active=false` until the click lands. Check that Library doesn't assume it is active on mount.
- **Verify:** In the frame, measure tap → frame for the first Movies visit, as in `s4.mjs`.
- **Depends on / conflicts with:** NAV-06.

### NAV-16 · Present "Add account" Login as a modal that slides up and down → merged into LGN-02 ✅
- **Kind:** native · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/App.svelte` (`{#if R.modal === 'login'}` 314–316)
- **Now:** Login appears and disappears in one frame. That is right at boot and after a sign-out (it is the whole app then). From *Accounts → Add account*, though, it pops over the page with no motion.
- **Change:** Only when `S.addingAccount` is set, run the sheet's present animation on `.loginhost` (`translate3d(0,100%,0) → 0`, `--dur-sheet` 440 ms, `EASE.sheet`). On dismiss, slide down over 300 ms with `EASE.in` (keep it mounted until the animation ends, as the sheet host does at App.svelte:256–271). Under reduced motion, use a 180 ms fade.
- **Why:** iOS presents a full-screen cover from the bottom, and the add-account flow is a modal task over the running app.
- **Constraints & risks:** Keep the boot and sign-out paths instant.
- **Verify:** In the frame, open Avatar → Add account → Cancel.
- **Depends on / conflicts with:** Sheets auditor (Accounts sheet closes at the same time).

## Considered and rejected
- **A cross-fade on tab switch.** UITabBarController switches instantly. A fade would read as web and add latency; the moving lens (NAV-05) carries the motion.
- **A symbol "bounce" on the newly selected tab icon.** Together with the lens, it would be one animation too many.
- **Tab bar minimizing on scroll** (iOS 26 Music/News `tabBarMinimizeBehavior`). The capsule is already small. It would add a scroll-linked animation to every page and hide navigation.
- **A real status-bar tap-to-top.** It is impossible here. In the installed app, the opaque status bar is outside the web view. In a Safari tab, WebKit only scrolls the *document* scroller, while the app scrolls nested `.screen`s. Making the document the scroller would undo the fixed-shell fix for the keyboard and the iOS 26 bottom gap. NAV-08 is the substitute.
- **A shared UIKit-style nav bar that stays put while its title and back label cross-fade.** The per-page floating glass bars match iOS 26, and a shared bar would need a second layout system for heroes and zoom.
- **The iOS 26 scroll-edge effect** (a masked progressive blur instead of a glass bar). That is a design-level change, and the cost of a masked `backdrop-filter` on WebKit is unknown. Revisit it with the designer.
- **The View Transitions API for push/pop** (SPEC §5 suggests it). Its snapshots can't follow a finger (edge swipe), the zoom needs live DOM, and it is Safari 18+ only. WAAPI on live routes is the better tool.
- **History API entries per push** (Safari-tab back gesture). The home-screen app has no browser gesture, and in a tab Safari's own snapshot swipe would double-animate.
- **Haptics on push, pop or tab switch.** iOS gives none there.
- **Dragging the tab lens across tabs** (iOS 26 scrub). Too much for four tabs.

## Cross-refs
- **Sheets:** The iOS large-sheet "card stack" is missing: the page behind should scale to ~0.93 with rounded corners (~10 → 12 px) and dim while a large sheet is up. It needs a transform on `.stage` plus `.tabbar` in `App.svelte`, so coordinate with the shell. `Sheet.svelte` also has a non-passive `touchmove` (84–85) and probably has the same stale-velocity problem as NAV-02, so reuse `spring()` and the windowed velocity there.
- **Motion system:** `App.svelte:117` and `:170` and `gestures.js:209` hardcode 380 instead of `--dur-push`. `gestures.js:10–11` duplicate the `EASE` curves instead of importing them from `safe.js`. NAV-02's `spring()` belongs in the shared motion helpers.
- **Micro-interactions:** `longpress` calls `navigator.vibrate(8)` (gestures.js:57), which iOS Safari doesn't implement, so there is no haptic on the iPhone. The iOS 18 `<input type="checkbox" switch>` haptic trick only fires from a trusted tap, not from the 500 ms timer.
- **Library / Search / Chart:** Search removes its TopBar in one frame when the field focuses (`{#if !searching}`, Search.svelte:289); iOS slides the large title away while the field rises and *Cancel* slides in. A scrolled Search root has no compact bar, unlike Movies/Shows (`Library.svelte:648`); consider a sticky search field that turns glass once it sticks. The landscape double inset in `library.css` is still open (UX-AUDIT).
- **Player:** `.playerhost` appears and disappears via `hidden` (App.svelte:310) with no present or dismiss motion. The player area should decide on a short fade-through-black or a slide-up.
- **Detail pages:** On a plain (non-zoom) push, the skeleton → content swap and the backdrop decode happen during the slide. zoom.js smooths this with a MutationObserver fade, but the slide path doesn't.
- **PWA shell:** In a Safari tab (not standalone), the 20 px left-edge swipe competes with Safari's own history-back gesture.
