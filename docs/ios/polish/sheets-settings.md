# Sheets, menus, toasts & settings — polish and native-feel tasks

Audited 2026-09-30 from the code and from headless Chrome at 393×852 (touch emulation, dev server on :8946,
fake offline entries injected in memory only; nothing written to the server). What already feels right:
the grouped inset lists (Settings, Accounts, Sort) are close to iOS, sheets already have a grabber,
velocity-aware drag-to-dismiss and a reduced-motion fade, the long-press menu has a blurred backdrop, a
lifted preview and a danger-only separator, and every overlay is `inert`-correct. The biggest gaps:
**medium sheets enter wrong** (they travel the viewport height, not their own, so they arrive late and
too fast), **the drag is only half interactive** (the scrim doesn't follow, dismissal ignores the finger's
speed), **there is no haptic feedback at all on iPhone** (`navigator.vibrate` is a no-op in Safari),
**the toast draws over an open context menu and turns into a stadium blob when it wraps**, and a
**Login bug** (Return in the username field submits the form). The Downloads list lost its hairlines, and it
is missing the two things every iOS downloads list has: ring progress controls and swipe-to-delete.

## Tasks

### SHT-01 · Make a sheet travel its own height, not the screen's — ✅ done
> App animates the `.sheet` by its own height. Present uses `SPRING.smooth` over `DUR.spring` rather than `EASE.sheet` 420 ms: `EASE.sheet` had already covered 73 % by 100 ms, and the spring covers 34 %. Measured on Accounts: on screen at 24 ms, 727/852 at 107 ms, landed by ~400 ms. Dismiss starts from the current offset, using `DUR.sheetOut` 260 ms and the new `EASE.dismiss`. A close during the present continues from wherever the sheet is.
- **Kind:** native / bug · **Priority:** P1 · **Effort:** S
- **Files:** `phone/src/App.svelte` (sheet `$effect`, lines 241–272), `phone/src/styles/app.css` (`.sheethost`, line 26)
- **Now:** `.sheethost` is `inset: 0`, and App animates *the host* from `translate3d(0,100%,0)`, which is
  852 px for every sheet. The Accounts sheet (365 px tall, top at 487) was sampled every frame:
  `7 ms: 1339 · 36: 1174 · 86: 812 · 136: 614 · 186: 550 · 286: 502 · 436: 487`. It is invisible for the
  first ~70 ms. Then it covers 240 px in about 65 ms (≈ 3.6 px/ms) and spends the last 300 ms creeping the final
  30 px. Dismiss has the same problem in reverse: 300 ms `EASE.in` over 852 px, and the sheet is gone after about 170 ms.
  Large sheets (Notifications, Sort) are nearly screen-height, so they look right.
- **Change:** animate the `.sheet` element itself (`sheetHost.querySelector('.sheet')`), in px of its own
  height:
  ```js
  const s = sheetHost.querySelector('.sheet'); const h = s.offsetHeight;
  s.animate([{ transform: `translate3d(0,${h}px,0)` }, { transform: 'none' }], { duration: 420, easing: EASE.sheet });
  // dismiss: from the sheet's current drag offset (see SHT-02) to h, 260 ms, cubic-bezier(.3,0,.8,.15)
  ```
  Keep the scrim fade at 300 ms linear in, but make the dismiss fade match the sheet's own duration.
- **Why:** a UIKit sheet appears from the bottom edge on the first frame and decelerates evenly over its
  own height. The current burst-then-crawl reads as a web modal.
- **Constraints & risks:** Sheet.svelte writes `el.style.transform` during a drag, and the dismiss must start
  from that value (SHT-02). Reduced motion keeps the existing 180 ms opacity path. This is phone-only code.
- **Verify:** dev frame → `__router.openSheet('accounts')` and sample `.sheet.getBoundingClientRect().top`
  per rAF. The sheet must be on screen by frame 1–2 and must not have covered more than about 60 % of its height by 100 ms.
- **Depends on / conflicts with:** do it before SHT-02 and SHT-03, which also touch this effect.

### SHT-02 · Make the sheet drag fully interactive: the scrim follows, release keeps the finger's speed, and the upward pull rubber-bands — ✅ done
> Wave 3: a flick-**dismiss** now leaves on `fling()` (safe.js), not the spring. A spring aimed a whole sheet away pulls at ω²·distance. On the 777 px Notifications sheet after a 200 px flick at 25 px/frame, it stepped 43 px and then ~70 px per frame, well ahead of the finger. `fling()` keeps the finger's speed and adds the pull that carries the sheet from rest in `DUR.sheetOut`. Measured (App host): 25 → 27, 34, 41 … 85 px, gone in 166 ms. Accounts: 25 → 25, 29, 32. Sheet.svelte's unhosted exit (player pickers) uses it too. Snap-back is unchanged (spring). A finger that rests ≥ 60 ms before lifting now counts as speed 0, so it gets the fixed `DUR.sheetOut`/`EASE.dismiss` exit: `d.v` only updated on moves, and a hold-then-lift used to still count as a flick.
> The release uses `spring(v/remaining, 0.3)` for both the exit and the snap-back. The scrim follows the same progress. Sheet hands the finger's speed to App through `takeSheetExitV()`. Outside `.sheethost`, Sheet animates the exit itself. Measured after a 300 px flick: the frame steps were 12, 12 and 9 px against a last drag step of 15. The hand-off has no repeated frame.
- **Kind:** native · **Priority:** P1 · **Effort:** M
- **Files:** `phone/src/components/Sheet.svelte` (`dMove`, `dEnd`, lines 29–58), `phone/src/App.svelte` (scrim element, dismiss)
- **Now:** during a drag only the sheet moves. The scrim stays at full opacity (see the drag screenshot: the page stays
  dark at 220 px of pull). Past 110 px or on a flick (`v > .5 px/ms`), `close()` hands over to App's fixed
  300 ms `EASE.in` exit. That curve starts at zero speed, so a fast flick visibly *stalls*, then falls. An upward
  pull is `dy / 4`, linear with no limit. The snap-back is `EASE.sheet` 300 ms, whatever the distance.
- **Change:**
  1. Progress-driven scrim: `scrim.style.opacity = 1 - clamp(dy / sheetHeight, 0, 1)`. Expose the scrim
     through a tiny store/context from App, or let Sheet find `.scrim` as its previous sibling of the host.
  2. Velocity-matched exit. Keep the current tracked `v` in px/ms. Remaining distance `r = h - dy`; duration
     `T = clamp(r / max(v, 0.9) * 1.6, 160, 320)` ms; easing `cubic-bezier(.2,.6,.35,1)` (so the initial slope is about
     the finger's speed). Start from the current `dy`, not from 0 (with SHT-01 it is the same element).
     Let Sheet run this animation itself and call `onclose` from `onfinish`, and give App's effect a
     `R.sheet.dragged` flag (or a module flag) so it skips its own exit and only fades the scrim.
  3. iOS rubber band for the upward pull: `up = -(1 - 1 / (|dy| * 0.55 / h + 1)) * h * 0.12` (asymptotic,
     never more than about 12 % of the height).
  4. Snap-back: `duration = clamp(dy * 1.2, 180, 320)`, `EASE.sheet`. The scrim goes back to 1 alongside.
  5. Dismiss threshold: `dy > min(110, h * 0.33)` or `v > 0.5 && dy > 20` (short sheets needed 110 px, a
     third of their height).
- **Why:** on iOS the sheet, the dim and the presenting page are one gesture-driven state. Letting go mid-flick
  continues the motion, and it doesn't start a new animation.
- **Constraints & risks:** only transform and opacity change, per touchmove, on 2–3 elements: compositor-cheap. Keep
  `preventDefault` only once `live`. Reduced motion: the drag still follows the finger (direct
  manipulation), and the exit is the 180 ms fade.
- **Verify:** dev frame, drag the Accounts grabber 150 px slowly and release: it returns. Drag it quickly and flick:
  it leaves at about finger speed with no pause at release, and the scrim fades in step. With CDP `Input.dispatchTouchEvent`,
  sample `top` per frame after a 20-step 300 px flick. There must be no frame where Δtop drops below 60 % of the
  last drag step.
- **Depends on / conflicts with:** needs SHT-01. SHT-03 hooks into the same progress value.

### LGN-01 · Return in the Username field must move to Password, not submit — ✅ done
> Return also moves from Server to Username. Measured: Enter in Username focuses Password and sends no `AuthenticateByName`.
- **Kind:** bug · **Priority:** P1 · **Effort:** S
- **Files:** `phone/src/screens/Login.svelte` (username `<input>`, line ~160 `enterkeyhint="next"`; `submit`, line ~61)
- **Now:** the keyboard shows "next", but the form has a submit button. By HTML implicit submission, Return
  in *any* text input submits. So "alice ⏎" sends `AuthenticateByName` with an empty password and shows
  "Wrong username or password". It also costs the user a failed-login entry in Jellyfin's activity log.
- **Change:** `onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); pwEl.focus(); } }}` on the
  username input (bind the password input to `pwEl`). Do the same on the server field → username.
- **Why:** every iOS login form walks the fields with Return and submits only from the last one.
- **Constraints & risks:** none. iOS Password AutoFill still fills both fields (autocomplete attrs unchanged).
- **Verify:** dev `/?` signed out: type a name, press Enter → focus moves to Password and there is no request in the
  Network panel (don't submit real credentials).
- **Depends on / conflicts with:** LGN-02 touches the same file.

### TST-01 · Fix the toast's shape, layering and meaning — ✅ done
> The heuristic is `isBadToast()` in Toast.svelte. It covers the listed prefixes plus "Library busy", "Download service unavailable", "Picture in Picture isn’t" and "…needs iOS". The measured banner is 65 px tall, so the toast sits 76 px above it.
- **Kind:** bug / craft · **Priority:** P1 · **Effort:** S
- **Files:** `phone/src/styles/components.css` (`.toast`, lines 772–788; z tokens in `tokens.css` 148–157),
  `phone/src/styles/app.css` (lines 36–42), `phone/src/components/Toast.svelte`
- **Now:**
  - `--z-toast: 70` is above `--z-ctx: 60`. A toast still up (such as the Undo after a removal) draws *over the
    long-press menu* and hides its last items (screenshot: "Remove from Continue Watching" under an error toast).
  - `border-radius: 999px` with wrapping text (`app.css` sets `white-space: normal`). A 2–3-line message
    becomes a stadium with huge round ends and the text crowding them.
  - The icon is `check` when there is an undo, otherwise `info` in gold. So "Couldn’t update …" errors look like
    good news.
  - The toast (bottom = tab bar + 20) sits on top of the offline banner (bottom = tab bar + 12), so both
    are unreadable when a request fails offline.
- **Change:**
  - `--z-ctx: 75` (the menu covers a lingering toast; a toast raised *by* a menu action appears after the
    menu has closed). Keep toast 70 above sheet 50 and player 65.
  - `.toast { border-radius: 22px; }` (= pill at the 44 px single-line height, a rounded rect when it
    wraps), `text-align: left`, and `padding-block: 10px` so wrapped lines breathe.
  - Toast kind in the phone component only, no shared change:
    `const bad = /^(Couldn’t|Can’t|Couldn't|Add failed|Test failed|Download stopped|This download is damaged|Too late|Not enough)/`.
    Error → `alert` icon in `var(--danger)`. With an undo → `check`. Otherwise `info`.
  - When `conn.offline`, raise the toast above the banner:
    `.toast--above-banner { bottom: calc(var(--tabbar-bottom) + var(--tabbar-h) + var(--s-3) + 64px) }`
    (banner height ≈ 56).
- **Why:** an iOS HUD never covers the menu you're using, and red plus an alert glyph is how iOS says "that failed".
- **Constraints & risks:** `toast.svelte.js` is shared. Everything here is in phone files. The regex is a
  heuristic. Keep it next to the component, with a comment listing the shared messages it covers.
- **Verify:** dev frame: `import('/src/lib/toast.svelte.js')` from the resource list, call
  `toast('Couldn’t update “X” — The server didn’t answer in time. Is Tailscale on?')` → rounded rect, red icon.
  Long-press a Continue Watching tile while an undo toast is up → the menu is on top. Frame `offline=1` plus a toast → both readable.
- **Depends on / conflicts with:** TST-02 (same component); the motion auditor may retune `--dur-base`.

### HAP-01 · Add a `haptic()` helper that actually fires on iPhone — ⏭ superseded (iOS 26.5 patched label.click haptics)
- **Kind:** native · **Priority:** P2 · **Effort:** S
- **Files:** new `phone/src/lib/haptics.js`; call sites `phone/src/lib/gestures.js` (longpress, line 57),
  `phone/src/sheets/Accounts.svelte` (line 58), plus the tasks below
- **Now:** the two `navigator.vibrate?.(…)` calls do nothing: Safari has no Vibration API. The app has no
  tactile feedback anywhere.
- **Change:** iOS 18+ plays the system selection haptic when a native `<input type="checkbox" switch>`
  toggles, including via a label click. A 10-line helper:
  ```js
  let lbl;
  export function haptic() {
    if (!lbl) { lbl = document.createElement('label'); lbl.ariaHidden = 'true'; lbl.style.display = 'none';
      const i = document.createElement('input'); i.type = 'checkbox'; i.setAttribute('switch', ''); lbl.append(i); document.body.append(lbl); }
    try { lbl.click(); } catch {}
    try { navigator.vibrate?.(8); } catch {}   // Android / desktop no-op
  }
  ```
  Use it *sparingly* (restraint): long-press menu open, a sheet crossing its dismiss threshold during
  a drag (once per crossing), the drag-to-select item change in the menu (CTX-03), a destructive
  confirmation, swipe-to-delete passing the full-swipe point (DL-02), and a wrong password (LGN-02).
  Never on plain taps or toggles that already make a native haptic (SW-01).
- **Why:** UIKit gives these moments a tick. Without it, long-press and swipe gestures feel dead in the hand.
- **Constraints & risks:** it's an undocumented side-effect. It may need transient user activation, so the long-press
  (fired from a timer, finger still down) is the one to confirm on device. If it doesn't fire there, it stays a
  silent no-op. No cost when idle.
- **Verify:** iPhone only (iOS 18+): long-press a tile → a tick. Desktop: no errors.
- **Depends on / conflicts with:** the motion/micro-interaction auditor may propose the same. Build one helper.

### SW-01 · Make Switch a real UISwitch → merged into MOT-08
- **Kind:** native · **Priority:** P2 · **Effort:** M
- **Files:** `phone/src/components/Switch.svelte`, `phone/src/styles/components.css` (`.switch`, lines 620–635)
- **Now:** a `<button role=switch>` with `::after` thumb, 180 ms `--ease-out` slide, no press state. The off track
  is `--surface-3` `#26262c` on a `--surface-2` `#1b1b20` list row. In the Sort sheet the off switch is
  nearly invisible (about +11 levels of luminance; iOS's off track on a grouped cell is about `#39393d`).
- **Change:** two layers:
  1. **Native where available.** On iOS (feature-detect `'switch' in HTMLInputElement.prototype`), render
     `<input type="checkbox" switch role="switch" bind:checked={on} style="accent-color: var(--gold)">`. It gives
     the exact UISwitch geometry, thumb drag, spring and the system haptic for free. Keep the 44 pt hit wrapper
     (`.switch-hit` label, `inset: -7px -6px`).
  2. **Custom fallback (desktop dev, older iOS), tuned to UISwitch:** off track
     `rgba(120,120,128,.32)`; thumb 27 px with `box-shadow: 0 3px 8px rgba(0,0,0,.15), 0 3px 1px rgba(0,0,0,.06)`;
     `transition: transform 300ms cubic-bezier(.3,1.35,.5,1)` (a hint of spring). While `:active`, the thumb
     stretches to 34 px toward the centre (`width` on a 27-px pseudo is layout, so use
     `transform: translateX(…) scaleX(1.26)` with `transform-origin` left when off and right when on).
- **Why:** the switch is the most-touched native control in Settings, and people know exactly how it feels.
- **Constraints & risks:** if WebKit ignores `accent-color` on switches, the native track is iOS green.
  In that case keep the custom one (layer 2) and only borrow the haptic via HAP-01 in `toggle()`. Check on device
  before deleting the fallback. `bind:on` / `onchange` API unchanged (Settings, SortFilter). Reduced motion:
  `transition-duration: 1ms`.
- **Verify:** dev frame Settings/Sort sheet: the off switch is clearly visible on both list colours, and pressing and
  holding stretches the thumb. iPhone: native switch, gold, haptic.
- **Depends on / conflicts with:** HAP-01.

### SHT-03 · Scale the page back behind a large sheet (iOS page-sheet card) — ✅ done
> Wave 2: `.presenter` (App.svelte) wraps stage + tab bar + offline banner; at rest it has no styles (no layer, no stacking context). Behind a `.sheet--large` it goes to `translate3d(0, safe-top + 6px, 0) scale(.92)` from its top edge, radius 14 px (unscaled), body `#000`; the large sheet's top moved to `safe-top + 16px`, so 10 px of the card peek. It runs on the sheet's own progress, not separate timings: the present uses the sheet's `SPRING.smooth`/`DUR.spring` (not 420 ms `EASE.sheet`), the exit uses `DUR.sheetOut`/`EASE.dismiss` or the drag's spring, and a drag paints it per frame through `followSheet()` in Sheet.svelte. The transform and the radius are two animations, so only the corners can lag on a busy main thread. It's off for medium sheets, Reduce Motion (dim only), phone landscape (iOS shows those sheets full screen) and a sheet opened with the player or Login up. Rotating to landscape drops it, and rotating back re-seats it. Measured per frame (393×852, safe-top 59): scale = 1 − 0.08·p to 4 decimals for the present, a close, a 100 px drag that springs back, and a 200 px flick. At rest it's 0.92 / 65 px / 14 px. After the flick the inline style and classes are cleared, and `getAnimations()` is empty. A medium sheet (Accounts) stays at scale 1. A push while the card is up leaves nothing behind. 📱 iPhone check: the card's look (in dark mode the 10 px peek is subtle), the NavBar/TopBar blur inside the scaled card, and 60 fps during a drag.
- **Kind:** native / craft · **Priority:** P2 · **Effort:** M
- **Files:** `phone/src/App.svelte` (wrap `.stage` + the TabBar wrapper, line 277–299), `phone/src/styles/app.css`
- **Now:** behind every sheet the page only dims (`.scrim` 56 %). The Notifications and Sort sheets stop
  12 px under the top and cover a page that looks untouched.
- **Change:** only for `large` sheets (Sheet can report it: `R.sheet.large` or a class on the host).
  Wrap stage and tab bar in `<div class="presenter">` (not `display: contents`, it must transform) and animate it
  together with the sheet:
  `transform: translateY(calc(var(--safe-top) + 6px)) scale(.92); border-radius: 14px; transform-origin: 50% 0; overflow: hidden`
  with body `background: #000`, 420 ms `EASE.sheet` in and 260 ms out. Move `.sheet--large` to
  `top: calc(var(--safe-top) + 16px)` so about 10 px of the card peeks above it. During a drag (SHT-02), interpolate
  scale `.92 → 1` and radius `14 → 0` with the same progress as the scrim. Set `will-change: transform`
  only while a large sheet is up.
- **Why:** this "card stack" is the single most recognisable sign of a native modal sheet on iPhone.
- **Constraints & risks:** a transformed ancestor re-contains `position: fixed` descendants. The ContextMenu portal
  and Toast live outside the wrapper, so they aren't affected. Check the NavBar/TopBar blur still renders. Keep the
  `inert` handling that is there now. `edgeSwipeBack` is already disabled while a sheet is up. Reduced motion:
  no scale, dim only. It's one big compositor layer during a 420 ms animation, so no idle cost. Don't apply it to medium
  sheets (iOS doesn't).
- **Verify:** dev frame → `__router.openSheet('notifications')`: the page recedes with rounded corners, and a drag
  brings it back in step. Check `rm=1`.
- **Depends on / conflicts with:** SHT-01, SHT-02. The navigation auditor owns App's push/zoom code in the same
  file, so coordinate the wrapper.

### CTX-01 · Lift the preview out of the pressed tile and put it back on close — ✅ done
> This is generic, so no caller changed. `longpress` gives its detail a `node` and registers `rect → node`, and ContextMenu finds the source through `pressSource(rect)` or an optional `source` prop. A tap outside or Escape drops the preview back, while an item fades the stack. The source is hidden only when a preview is lifted. The MOT-04 build-up (`.holding`) and HOME-06 are folded in. Measured on a poster: the preview starts at the held size (98 px at 20 + 4) and springs to 1.03. The drop-back lands exactly on the source (20:360:106), which reappears in the same frame. A programmatic tab switch closes the menu.
- **Kind:** craft / native · **Priority:** P2 · **Effort:** M
- **Files:** `phone/src/components/ContextMenu.svelte` (`place()`, lines 43–56; `close()`, 58–76)
- **Now:** in `fit='card'` the preview card appears at full width instantly (the 90 ms frame already shows it
  full size). Only a 1 → 1.03 scale plays. The source tile stays under the blur, so there are two copies. Close
  fades the whole stack out in 180 ms, in place. There is also a bug: the menu is a portal in `#app` and stays open when its screen
  goes inactive. It was still up over Movies after a tab switch (programmatic navigation, such as a push tap or
  auth loss), and a sheet then opened *under* it.
- **Change:**
  - FLIP from `rect`: measure the preview's final box `f`, start it at
    `translate(rect.left - f.left, rect.top - f.top) scale(rect.width / f.width)` (origin top-left) at
    `scale(.96)` of that (the tile's pressed size, since `:active` is 0.96), and spring to `scale(1.03)` at its
    place in 340 ms `EASE.spring`. The menu keeps `.9 → 1` plus fade, 60 ms delayed. Set `visibility: hidden` on the
    source element while open (pass it in via `longpress` detail `node`).
  - Close = reverse: preview back to `rect` at scale 1 in 220 ms `EASE.out`, menu `scale(.92)` plus fade toward
    its anchor in 150 ms, backdrop fade 220 ms. Un-hide the source on finish. If the action navigates
    (Go to movie), just fade (the zoom transition takes over).
  - Close on `active → false`: add an `active` prop (screens pass theirs) or close in an `$effect` on
    `R.tab/R.stacks/R.modal/R.sheet` changes.
- **Why:** iOS menus grow *from* the thing you pressed and shrink back into it. That continuity is what makes the
  gesture feel physical.
- **Constraints & risks:** transform/opacity only. The 400 ms safety timer in `close()` must stay. Reduced
  motion: no FLIP, crossfade only. Screens that pass `fit='rect'` (posters) get the same code path (the scale is
  about 1).
- **Verify:** dev frame, right-click (long-press) a Continue Watching tile and record 10 frames: the card grows
  from the tile. Tap outside: it returns there. Switch tab programmatically while open: the menu closes.
- **Depends on / conflicts with:** CTX-02. Callers in Home/Library/SeriesDetail/PendingDetail/Downloads (other
  areas) only need the optional new prop.

### CTX-02 · Press, drag onto an item, release to choose — ⏳ later round
- **Kind:** native · **Priority:** P2 · **Effort:** M
- **Files:** `phone/src/lib/gestures.js` (`longpress`, lines 31–100), `phone/src/components/ContextMenu.svelte`
- **Now:** after the 500 ms hold the menu opens, and the release click is swallowed window-wide (good). But the finger
  has to lift and tap again. Sliding onto an item does nothing, and moving the finger may start scrolling the rail
  underneath.
- **Change:** after `longpress` fires, keep following the same pointer. A window `touchmove` (non-passive,
  `preventDefault` while this press owns an open menu, which stops the rail pan) plus `pointermove` →
  `document.elementFromPoint` → the `.ctx__item` under the finger gets `.is-pressed` and a `haptic()` (HAP-01) on
  every change of item. `pointerup` over an item runs it. `pointerup` elsewhere leaves the menu open (as
  now). Tell ContextMenu through a small event (`ctx:drag` / `ctx:drop` with x, y) so gestures.js stays
  component-agnostic.
- **Why:** press-slide-release is the iOS power gesture for context menus. Its absence is noticeable for anyone who
  uses iOS menus daily.
- **Constraints & risks:** the first touchmove after a still hold is cancelable on iOS, so `preventDefault`
  works. Verify on device. Must not break the "release never clicks an item under the finger" guarantee: only
  a pointerup that *moved onto* an item selects. No idle cost (listeners only while held).
- **Verify:** dev frame: hold the left mouse button 500 ms on a tile, drag onto "Mark as watched" (use a
  harmless item: *Go to movie*), release → it navigates. Release without moving → the menu stays. iPhone: ticks per item.
- **Depends on / conflicts with:** CTX-01, HAP-01.

### TST-02 · Give the toast a spring, a swipe-away and a hold-to-keep — ✅ done
> Toast in uses `--spring-smooth`/`--dur-spring` (MOT-01's pair for the toast) and out uses `--dur-fast` `--ease-in`. The optional Undo hairline was left out. Measured: a text change gives one `scale .97 → 1` bump. A 6.5 s hold kept the toast, which hid 2 s after release. A 40 px drag down dismissed it.
- **Kind:** craft / native · **Priority:** P2 · **Effort:** M
- **Files:** `phone/src/components/Toast.svelte`, `phone/src/styles/app.css` (lines 36–42),
  `src/lib/toast.svelte.js` (shared, `__PHONE__` only)
- **Now:** in and out are the same 260 ms `--ease-out` translate 16 px plus fade. A second toast while one is up only
  swaps the text (the pill jumps to a new width with no acknowledgement). It can't be swiped away, and a thumb
  resting on it doesn't keep it. The Undo window runs out while you're aiming.
- **Change:**
  - In: `translate 24px → 0` 420 ms `cubic-bezier(.34,1.3,.64,1)` plus opacity 180 ms. Out: 200 ms
    `ease-in`, translate 12 px down (different `transition` on `.toast--off`).
  - Message change while shown: `{#key toastState.msg}` on `.toast__text` with a 150 ms fade, plus a one-shot
    WAAPI bump on the pill (`scale .97 → 1`, 220 ms `EASE.spring`).
  - Swipe down to dismiss: pointer drag on the pill moves `translate`. Release past 24 px or `v > .3` → set
    `toastState.show = false; toastState.undo = null` (phone writes the exported state, no shared code needed).
  - Hold to keep: in `toast.svelte.js` add `if (__PHONE__)`-guarded `pauseToast()` / `resumeToast()`
    (clear the timer / restart it with 2 s). Toast calls them on pointerdown/up.
  - Optional, only with an Undo: a 2 px gold hairline along the bottom inside the pill, `scaleX(1 → 0)` over
    the hold time (compositor-only, bounded to 5 s). Leave it out if it feels busy.
- **Why:** iOS banners and HUDs spring in, can be flicked away, and stay while touched.
- **Constraints & risks:** **TV bundle must stay byte-identical**: keep the new functions `__PHONE__`-guarded
  and unused by the TV (tree-shaken). Check that `dist/app.js` md5 is unchanged before and after. Reduced motion: opacity
  only (the existing `.toast--off { translate: none }` rule stays). No running animation when hidden.
- **Verify:** dev frame: two `toast()` calls 1 s apart → the text crossfades and the pill bumps once. Drag the toast down
  → gone. Hold for 6 s → it stays, then hides 2 s after release. `npx vite build` → app.js md5 unchanged.
- **Depends on / conflicts with:** TST-01.

### DL-01 · Downloads rows: restore the hairlines, use ring controls, add a finish moment — ✅ done
> There is no haptic (HAP-01 is superseded). The foot text is unchanged until DL-02. Delete from the menu now asks in an action sheet (ACT-01). Measured with in-memory entries: hairlines at 72 px, and distinct stop, dashed, paused and error controls. On `downloading → done` the ring is shown at 100 % and then the disc pops in, 343 ms later.
- **Kind:** bug / native / craft · **Priority:** P2 · **Effort:** M
- **Files:** `phone/src/screens/Downloads.svelte` (rows, lines 124–141), `phone/src/styles/offline.css`,
  `phone/src/components/ProgressRing.svelte` (already takes `children`)
- **Now:**
  - **Bug:** each `Row` is wrapped in `<div use:longpress>` (line 125), so `.row + .row::before` never
    matches. The list has no separators at all (screenshot with 4 entries).
  - The state is shown three times: a 32 px disc with play/pause/download (line 131), a status line, and a full-width
    `ProgressBar` (line 139). *Queued* and *paused* both show a download arrow.
  - Completion is only a toast. The row just flips its text.
- **Change:**
  - Separators: `class="dl__item"` on the wrapper, plus
    `.dl__item + .dl__item > .row::before { content:""; position:absolute; top:0; left: calc(var(--s-4) + 44px + var(--s-3)); right:0; height:1px; background: var(--line); }`
    (inset to the text, past the 44 pt cover).
  - Trailing control like the App Store / TV app: `<ProgressRing p={done/total} label="">` 32 px with a
    filled 8 px square (stop/pause) inside while downloading. Queued = the ring track only, with a 2-segment dashed
    stroke (static, no spinner). Paused = ring at its % with the download arrow inside. Error = `alert` in danger.
    Done = the existing play disc. Drop the linear `ProgressBar` (the ring carries it). Keep the status text
    line.
  - Finish moment, only when an entry changes `downloading → done` while the screen is `active`: the ring
    completes (`--p: 1`, the existing ring transition), then it crossfades into the play disc with a one-shot
    `scale(1 → 1.12 → 1)` 320 ms `EASE.spring`, plus `haptic()`. Reduced motion: swap only.
  - Trim the foot text once DL-02 lands ("Swipe left to delete.").
- **Why:** ring-with-stop is the iOS idiom for "downloading, tap to stop". One control reads faster than a disc plus a bar.
- **Constraints & risks:** the ring's `stroke-dashoffset` transition only runs when `done` changes (a few
  times a second at most). There is no continuous animation. Row separators elsewhere are unaffected.
- **Verify:** dev frame: inject entries in memory
  (`import('/src/lib/offline.svelte.js').then(m => m.OFF.list = [...])` with `state:
  'done'|'downloading'|'queued'|'paused'` and **no** `pump()`), push `downloads` → hairlines, rings, distinct
  queued/paused. Set one entry's `state = 'done'` → one pop.
- **Depends on / conflicts with:** DL-02, HAP-01. The Detail auditor may restyle the detail page's Download action
  the same way (keep the ring look shared).

### DL-02 · Swipe a download left to delete, with Undo — ⏳ later round
- **Kind:** native · **Priority:** P2 · **Effort:** M
- **Files:** `phone/src/screens/Downloads.svelte`, `phone/src/lib/gestures.js` (new `use:swipeActions`),
  `phone/src/lib/offline.svelte.js` (`deleteDownload`, lines 301–317), `offline.css`
- **Now:** deleting is only reachable via long-press → menu → "Delete download", and it is immediate and
  irreversible (a multi-GB copy that took an evening to fetch). There is no confirm and no undo. The footnote has to
  explain the hold.
- **Change:**
  - `use:swipeActions={{ onfull, reveal: 88 }}` on `.dl__item`: horizontal pan with `touch-action: pan-y` on
    the row (vertical scroll stays native). Direction is locked after 8 px. The row content translates with the finger,
    and a red `--danger` "Delete" panel (trash icon + label, 88 px) is revealed under it. Past 55 % of the width the
    panel stretches to full width with a `haptic()`, and release deletes (full swipe). A tap on the revealed button deletes.
    A tap elsewhere or a scroll closes it (220 ms `EASE.out`). Only one row is open at a time.
  - Deleting = soft: collapse the row (height → 0 over 240 ms; it's a list, so a height animation is acceptable
    here, or fade + `transform: scaleY` on a wrapper), call `pauseDownload` if running, and show
    `toast('Deleted “<Title>”', undo)`. Run `deleteDownload(id)` after the toast's hold (5 s) unless
    undone. On undo, restore the row and `resumeDownload` if it was running. Keep the long-press menu item and
    route it through the same soft delete.
- **Why:** swipe-to-delete is *the* iOS list convention (Mail, Files, TV app downloads). Undo matches the rest
  of the app (Continue Watching removal, add, Get).
- **Constraints & risks:** if the app is killed within the 5 s, the file survives (safe direction). A pending
  soft-delete must be excluded from `pump()` and from the banner's "Downloads" link count. Don't leave a hidden
  entry in `OFF.list` forever: flush pending deletes on `pagehide`.
- **Verify:** dev frame with injected in-memory entries (never real downloads): mouse-drag a row left (the dev
  client maps mouse drags to touches) → the panel shows, and a full drag collapses the row and toasts. Undo brings it back.
  Vertical scroll still works when starting on a row.
- **Depends on / conflicts with:** DL-01, TST-02 (Undo timing), HAP-01.

### ACT-01 · An iOS action sheet for destructive confirmations — ✅ done
> Wave 2 (agent 3) wired the rest: Library's pending tile, PendingDetail's Cancel action (straight to the sheet, no menu) and episode rows, SeriesDetail's episode rows → `confirmMenu(confirmItems(…))` after the first menu's "Cancel download…"; SeriesDetail's Watched (whole series) → `confirm({title: series, message, action})`, red only for *unwatched* (it drops resume points). The second-menu `confirm` state and `setTimeout` re-opens are gone. `detail.css`'s `.ctx__item:disabled` caption look is removed — it was also restyling Home's real disabled item ("Play from beginning" offline) as a tiny caption; components.css now dims a disabled `.ctx__item` to 0.4. Measured with every mutation stubbed: all five sites open the sheet (menu closed first, ctx gone), Keep downloading → no request, confirm → one stubbed `DELETE /ml/api/activity/movie/…` / `POST /jf/UserPlayedItems/<series>`.
> This lane wired Downloads → Delete and Sign out. Sign out replaced the armed row. The Library, SeriesDetail and PendingDetail cancel-download confirms and SeriesDetail's mark-all are handed to their lanes: each is a one-line `confirmMenu(confirmItems(…))`. ContextMenu gained a `{ title: true }` caption item (`.ctx__title` in components.css). The haptic was dropped (HAP-01).
- **Kind:** native · **Priority:** P2 · **Effort:** M
- **Files:** new `phone/src/components/ActionSheet.svelte` + `phone/src/lib/confirm.svelte.js`
  (`confirm({ title, message, action, danger, cancel }) → Promise<boolean>`), mounted once in `App.svelte`;
  adopters `phone/src/screens/{Library,SeriesDetail,PendingDetail}.svelte`,
  `phone/src/sheets/Accounts.svelte`
- **Now:** "Cancel download…" re-opens a *second context menu* at the same spot, whose first item is a
  disabled button restyled as a caption (`detail.css:70`, a global rule living in a workstream file), and
  "Mark the whole series as watched" does the same. Sign out uses a 4 s "Tap again to sign out" armed row
  (`Accounts.svelte` 51–67) whose only feedback is the text change.
- **Change:** an action sheet exactly like `UIAlertController(.actionSheet)`. It sits at the bottom inside `--gutter`
  and `safe-bottom + 8`. It has two groups 8 px apart, radius 14, `--surface-2` at 96 % with `--glass-blur`. The first group
  holds a centred 13 pt `--text-faint` title/message block and a hairline, then 56 px centred action buttons (17 pt, destructive
  in `--danger`, weight 400). The second group is **Cancel** (weight 600). It uses the scrim and slides up 360 ms
  `EASE.sheet` from its own height; out takes 220 ms. Tapping the scrim cancels, and so does Escape. `haptic()` fires on show when the action is
  destructive. Adopt it for Cancel download (all three screens, using the texts `confirmItems()` already builds),
  series mark-all, and optionally Sign out ("Sign out of alice?" / "Switches to Lena." · **Sign Out**).
  If Sign out keeps the armed row (a deliberate earlier decision: "the row itself asks"), at least tint the
  armed row `background: var(--danger-soft)` with a 180 ms transition.
- **Why:** on iOS a menu *chooses* and an action sheet *confirms*. A menu that asks a question in a disabled
  row is a web workaround. Move `.ctx__item:disabled` into components.css as a proper `.ctx__title` (centred,
  13 pt, faint) for any menu that keeps a header.
- **Constraints & risks:** `cancel.svelte.js` is shared: don't change `confirmItems()`. Phone screens
  just read its label strings (or build their own). Owners of Library/SeriesDetail/PendingDetail must apply
  the adopter edits. Reduced motion: fade.
- **Verify:** dev frame: `confirm({ message: 'Cancel test?', action: 'Cancel download', danger: true })` from the
  console resolves true/false correctly. Don't confirm on a real pending download.
- **Depends on / conflicts with:** CTX-01 (menus close before the sheet opens), HAP-01. Library/Detail auditors'
  files.

### LGN-02 · Login: present like a modal, one brand moment, errors that shake, busy that doesn't fade — ✅ done (bug/busy/shake + modal only)
> Built: Add account slides up (`DUR.sheet`, `easeSheet`) and down (`DUR.sheetOut`, `EASE.dismiss`). First-run Login appears at once and fades out on sign-in, and Reduce Motion fades. `.btn[aria-busy]` stays at full opacity. The field it concerns shakes (the password is also selected) and Reduce Motion skips the shake. Not built: the brand moment (MOT-17 owns the one flourish), placeholder/label de-duplication and vertical centring (⏳ later round).
- **Kind:** native / craft · **Priority:** P2 · **Effort:** M
- **Files:** `phone/src/App.svelte` (`{#if R.modal === 'login'}`, lines 314–316),
  `phone/src/screens/Login.svelte`, `phone/src/styles/components.css` (`.login`, `.btn[disabled]` line 218),
  `phone/src/components/Button.svelte` (line 35)
- **Now:**
  - Login pops in and out with no transition, including "Add account" from the Accounts sheet (the sheet
    slides down while Login is already there) and a successful sign-in (Home just replaces it).
  - While signing in the button is `disabled` → `.btn[disabled] { opacity: .4 }`, so "Signing in…" looks
    greyed-out and broken. `Button busy` does the same everywhere (LoadError's "Retrying…").
  - A wrong password only turns the ring red and adds the hint.
  - The first impression is a static top-aligned stack with the lower 45 % of the screen empty. Labels and placeholders
    repeat each other ("Username" twice).
- **Change:**
  - Present "Add account" / re-sign-in as a full-screen modal: `.loginhost` slides up from 100 % in 420 ms
    `EASE.sheet`, and Cancel slides it down in 300 ms. Keep it mounted during the out-animation (the same pattern as the sheet
    host). The first-run Login (no session) doesn't slide. On success without a reload, fade Login out over 220 ms.
  - Brand moment, **first run only** (not when adding an account): the wordmark fades in and rises 8 px (600 ms
    `EASE.out`), the tagline and form follow 120 ms later (fade, 400 ms). Add a static warm glow behind the mark:
    `.login::before { background: radial-gradient(60% 32% at 50% 18%, rgba(230,180,80,.10), transparent 70%) }`.
    No looping animation.
  - Wrong password: shake `.field__box` (`translateX 0,-8,8,-6,6,-3,0`, 380 ms), select the password text,
    `haptic()`. Reduced motion: no shake.
  - Busy: `.btn[aria-busy="true"] { opacity: 1 }` (the spinner is the signal; `pointer-events` stay off).
    Login's submit should set `aria-busy` like Button does.
  - Drop the placeholders (the labels stay, as in iOS Settings-style forms), or keep placeholders and drop
    the labels. Pick one.
  - Centre the block vertically when the keyboard is down:
    `.login { min-height: 100%; justify-content: center; padding-bottom: calc(var(--safe-bottom) + 12vh) }`.
    Check on the SE (667) with the keyboard up that Password stays visible.
- **Why:** iOS presents sign-in modally and answers a wrong password with the passcode shake. A 40 %-faded
  button reads as "can't tap", not "working".
- **Constraints & risks:** Login and App are Foundation's. The `.btn[aria-busy]` rule affects every busy
  Button (intended). The brand animation only runs once per cold start.
- **Verify:** dev `/?` signed out → entrance plays once. Accounts → Add account → slides up, and Cancel slides
  down. Force an error by pointing the server field at an unreachable URL (not a real wrong password against Jellyfin)
  → the serverErr field shakes.
- **Depends on / conflicts with:** LGN-01, HAP-01. The PWA-shell auditor owns index.html's boot splash: the brand
  moment should hand over from it, not repeat it.

### ACC-01 · Make an account switch or sign-out feel like a transition, not a reload — ⏳ later round
- **Kind:** craft · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/sheets/Accounts.svelte` (`pick`, lines 36–41; `out`, 54–67), `phone/src/screens/Login.svelte`
  (remembered-account rows), small overlay in `phone/src/App.svelte` or a module in `phone/src/lib`
- **Now:** tapping another account sets `busy` (rows disabled, no visual change), awaits `pushSignOut()`
  (a network call that can take a second), then `location.reload()`. The app blinks black and cold-starts. The
  user sees nothing between the tap and the blink.
- **Change:** on tap, show a full-screen `--bg` overlay fading in over 200 ms, centred on the target account's `Avatar lg` (64)
  with "Switching to Lena…" (or "Signing out…") and a small spinner. Start the overlay *first*, then
  `pushSignOut()`, then reload. On the next boot, the index.html splash or Home takes over. Also show a `spinner` in the tapped
  row's trail while `busy`, for the frame before the overlay.
- **Why:** native apps with multiple accounts (YouTube, Gmail) cover the context switch with a deliberate
  interstitial, so the reload is hidden inside a transition the user asked for.
- **Constraints & risks:** never do this on the real account in testing (sign out / switch are real
  mutations). The overlay must not block `location.reload()` if `pushSignOut` hangs; it already has its own
  deadline via `.finally`.
- **Verify:** code review, plus a dev-frame check with `switchTo` / `pushSignOut` stubbed in the console.
- **Depends on / conflicts with:** LGN-02 (same hand-off on the next boot). PWA-shell auditor (boot splash).

### SHT-04 · Detents: open Notifications at medium, pull up for large — ⏸ awaiting decision
- **Kind:** native · **Priority:** P3 · **Effort:** L
- **Files:** `phone/src/components/Sheet.svelte` (new `detents` prop), `phone/src/sheets/Notifications.svelte`
  (line 195 `large`), `components.css` `.sheet`
- **Now:** Notifications is always `large`. With the usual 1–3 rows (screenshot: one row) it is a nearly
  full-height empty slab.
- **Change:** `detents={['medium','large']}`: the sheet is laid out at large height and presented translated
  down to `max(contentHeight, 50 %)` (medium). Dragging the grabber/head up snaps to large (velocity rule as in
  SHT-02, `EASE.sheet` 320 ms). While at medium, an upward drag on the body expands the sheet instead of scrolling (the first touchmove is cancelable). The
  body scrolls only at large. Dragging down from medium dismisses. Only large gets the SHT-03 card effect, and it is
  interpolated between the detents.
- **Why:** medium/large detents are how iOS sizes sheets whose content varies (Maps, Find My, Music).
- **Constraints & risks:** the largest change here, so do it after SHT-01–03. Keep `large` behaviour for the Sort sheet
  (its sticky "Show N" foot needs the full height). Mid-gesture scroll ↔ drag handoff at the large detent is
  not possible in Safari (see rejected).
- **Verify:** dev frame: Notifications with 1 item opens at about half height, drag up → large, drag down → medium →
  dismiss.
- **Depends on / conflicts with:** SHT-01, SHT-02, SHT-03.

### SEG-01 · Segmented control: a sliding thumb instead of a jump → merged into MOT-07
- **Kind:** craft / native · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/components/Segmented.svelte`, `components.css` `.seg` (lines 637–646)
- **Now:** the active segment's background jumps to the new option (colour transitions only). It's used in
  Settings (Subtitles mode, Quality), the Sort sheet (Order) and the player's TrackPanel.
- **Change:** one absolutely positioned `.seg__thumb` (surface-press, shadow as now) under the options, placed with
  `transform: translateX(calc(var(--i) * (100% + 2px)))` and `width: calc((100% - 4px - (var(--n) - 1) * 2px) / var(--n))`.
  Transition `transform 300ms cubic-bezier(.3,1.25,.5,1)`. While an option is `:active`, the thumb scales to
  `.95`. Options become transparent. Reduced motion: `transition: none`.
- **Why:** UISegmentedControl's thumb slides with a slight spring. The jump is one of the last "web" tells in
  Settings.
- **Constraints & risks:** equal-width options only (they already are, `flex: 1 1 0`). The player auditor owns
  TrackPanel's usage. The API is unchanged.
- **Verify:** dev frame Settings: tap Forced only → Always: the thumb glides across the middle.
- **Depends on / conflicts with:** the motion auditor's easing tokens.

### SET-01 · Settings: iOS grouped-list details and a quiet signature — ✅ bug part done; rest ⏳ later round (signature ⏸ awaiting decision)
> Push errors go through `pushErr()`, so a bare "HTTP 502" becomes a sentence.
- **Kind:** native / craft / bug · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/screens/Settings.svelte`, `phone/src/styles/components.css` (`.row`, lines 596–618),
  `phone/src/styles/home.css` (`.setrow`), `phone/src/lib/icons.js` via `phone/scripts/icons.mjs`
- **Now:**
  - Audio, Subtitles and Size are native `<select>`s (an in-place pop-up menu on iOS) drawn with a
    **chevron-right**, which on iOS means "pushes a page" (lines 129–149).
  - Separators start 16 px in for every row, so on icon rows (Accounts "Settings"/"Sign out", Settings
    "Downloads") the hairline runs under the icon tile instead of starting at the text.
  - Row highlight fades in and out over the same 110 ms. iOS highlights on touch-down and fades out slower.
  - About says "VibeReel 0.1.0 · iPhone": the TV's `appinfo.json` version, with nothing identifying the phone build.
  - Error toasts use raw `e.message` (lines 51, 178). `push.js` can throw `'HTTP 502'`.
- **Change:**
  - A `chevrons-up-down` icon (SF "chevron.up.chevron.down", 12 × 16, 1.75 stroke) for the three select rows.
    Keep chevron-right for Downloads.
  - `.row:has(.row__icon) + .row::before, .row + .row:has(.row__icon)::before { left: calc(var(--s-4) + 30px + var(--s-3)); }`.
  - `.row { transition: background-color 280ms ease-out } .row:active { transition-duration: 0ms }`.
  - Build line: define `__BUILD__` (short git sha + date) in `phone/vite.config.js` and show "Version 0.1.0
    (a0b4197) · 30 Sep 2026". Below the last group add a centred signature: the short mark (`.wordmark--short`,
    28 px, `--text-faint`) over one caption line, e.g. "Made for movie nights at home". Static, no animation.
  - `toast(errText(e))` instead of `e.message`.
- **Why:** these are the small tells an iOS user reads subconsciously: the right chevron, a separator that
  starts at the text, a highlight that lingers. A signature line says someone cared.
- **Constraints & risks:** the `.row` press timing overlaps the motion auditor's global press states, so agree on
  one owner. `vite.config.js` is Foundation's.
- **Verify:** dev frame Settings and Accounts screenshots at 393 and 375, with text at 124 %.
- **Depends on / conflicts with:** the motion auditor (press states).

### DL-03 · A storage meter on Downloads — ⏸ awaiting decision
- **Kind:** craft · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/screens/Downloads.svelte` (pagehead, lines 107–111), `offline.css`
- **Now:** "8.3 GB on this iPhone · 10 GB free" as text only.
- **Change:** under the subtitle, a 6 px rounded bar (`--surface-3` track): a gold segment = this account's downloads
  (`used`) and a `--text-faint` segment = everything else the origin uses (`OFF.usage - used`), scaled to
  `OFF.quota`. Widths via `transform: scaleX` on absolutely positioned fills, transition 400 ms `EASE.out` when
  they change. Legend dots only if it needs them (it probably doesn't: the text line already names both).
- **Why:** the iPhone Storage bar is the familiar picture of "how full am I". It turns two numbers into one glance.
- **Constraints & risks:** `navigator.storage.estimate()` numbers are origin-quota, not disk. Label them as "free for
  downloads", as OfflineSheet does. Hide the bar when `quota` is null.
- **Verify:** dev frame with injected entries.
- **Depends on / conflicts with:** DL-01.

### EMP-01 · Empty states with a little character — ⏳ later round
- **Kind:** craft · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/components/StateMessage.svelte`, `components.css` `.state` (lines 818–829)
- **Now:** every empty/positive state ("You’re all caught up", "Nothing downloaded") uses the same grey 64 px
  disc as neutral messages, and appears with the page.
- **Change:** a `tone` prop: `'good'` → `--gold-soft` disc with a gold icon (for "caught up"), and the default stays
  grey. A one-shot entrance on mount: icon disc `scale(.9) → 1` plus fade (320 ms `EASE.spring`), text fade 60 ms
  later. Nothing loops. Reduced motion: none. Copy stays as is.
- **Why:** a tiny warm moment at "nothing to do" is where apps show care. Restraint keeps it to one beat.
- **Constraints & risks:** StateMessage is also the base of LoadError. Keep errors unanimated (they can
  re-mount on retries).
- **Verify:** dev frame: open Notifications with nothing new (or render StateMessage in PagePlaceholder).
- **Depends on / conflicts with:** the motion auditor's generic fade-ins (don't double-animate).

## Considered and rejected
- **Scroll → drag handoff mid-gesture** (scroll the sheet body to the top and keep pulling to dismiss): once Safari
  starts a native scroll, `touchmove` is no longer cancelable, so the sheet can't take over. The current "start at
  top, pull down" behaviour is the most a PWA can do.
- **Toast at the top (iOS banner position):** system banners are the OS's. In-app Undo confirmations on iOS
  (Mail's Undo Send, Photos) sit at the bottom within thumb reach. Keep it bottom.
- **iOS 26 floating (inset, all-corners-rounded) medium sheets and Liquid Glass menus:** the design system is
  the iOS 17-era dark/gold look. Adopting 26's glass piecemeal would clash. Revisit for the whole app at once.
- **"Edit" button with delete circles on Downloads:** swipe-to-delete (DL-02) covers it with less chrome for a
  list that rarely exceeds a dozen rows.
- **Countdown ring on the toast's Undo:** a running ring on every undo toast is more motion than the moment
  deserves. At most the optional hairline in TST-02.
- **Animating the unseen gold dots in Notifications (pulse/fade):** Mail keeps unread dots static, and a pulse would be
  an always-running animation.
- **Replacing the Settings `<select>`s with custom pickers:** the native iOS pop-up menu is already the most
  native thing on the page.
- **Rubber-band scaling of the whole sheet on overscroll:** iOS stretches only the translate, so the sheet doesn't scale.

## Cross-refs
- **Navigation / App shell:** SHT-03's `.presenter` wrapper and SHT-01's host changes live in `App.svelte` next
  to push/zoom code. The NavBar large-title → inline-title collapse on Settings/Downloads (`pagehead` + `NavBar solid`)
  is a plain swap today. iOS morphs the large title into the bar.
- **TopBar (nav auditor):** when the bell sheet opens and `markAllSeen()` clears the count, the gold badge
  vanishes in one frame. It could scale out over 180 ms.
- **Motion system:** the `haptic()` helper (HAP-01), `.row`/`.btn` press timing (SET-01) and StateMessage
  entrance (EMP-01) overlap its global press states and fade-ins, so pick one owner each. `Avatar`'s photo pops over the
  initial with no fade.
- **Detail pages:** the Download action on Movie/Episode pages should become the same ring-with-stop as DL-01 once a
  download starts (today the only confirmation is a toast). Cancel-download confirms in SeriesDetail/PendingDetail
  are ACT-01 adopters.
- **Library (C):** Library's pending-tile "Cancel download…" confirm is an ACT-01 adopter. The Sort sheet discards its
  draft silently on swipe-down: that's fine for a filter, but maybe worth a note in its header.
- **PWA shell:** the Login brand moment (LGN-02) and the account-switch overlay (ACC-01) should hand over to the index.html
  boot splash rather than play twice.
- **Player:** `Segmented` in `TrackPanel` gets SEG-01's sliding thumb for free. Check it inside the glass panel.
