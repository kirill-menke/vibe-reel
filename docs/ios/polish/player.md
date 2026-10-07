# Player — polish and native-feel tasks

The player's behaviour already feels solid. Double-tap runs coalesce into one seek, fine scrubbing (half, quarter and tenth speed) works like iOS, the trickplay preview is right, the lock mode exists, and the loading card fades into the first frame and is hidden afterwards. Media Session and AirPlay are wired up, and the Skip chip and Up Next follow the playhead.

What gives the web page away is **motion at the edges**: almost every overlay mounts and unmounts in one frame. That covers the modal itself, the pickers, the Skip chip, Up Next, the lock pill and the seek feedback. The swipe-down "dismiss" also slides the video over a black void and then cuts. Four smaller gaps stand out as well: a 300 ms lag before a tap shows the controls, a portrait video that scrolls away with the info column, a portrait sheet grabber that does nothing, and an animation that runs forever next to a playing film.

Audited 2026-09-30 from the code plus headless Chrome (393×852 / 852×393, touch emulation, a YouTube trailer; screenshots in `/tmp/claude-1000/polish-player/`).

**Dev tip for every task below.** Dev playback of Jellyfin items is blocked, so drive the engine state directly. In the dev page:
```js
const u = performance.getEntriesByType('resource').map(e => e.name).find(n => n.includes('/src/lib/player.svelte.js'));
const m = await import(u);   // the same instance the app uses (verified)
m.P.skips = [{ kind: 'intro', start: 0, end: 60, from: 'x' }]; m.P.pos = 5; m.P.dur = 100;
__router.S.screen = 'player';   // opens the modal
```
Use trailers (MovieDetail → Trailer) for real video. Never pass `allowplay=1`.

## Tasks

### PLY-01 · Present and dismiss the player modal with motion, not a cut — ✅ done
- **Lane E:** done inside Player.svelte rather than App: `.playerhost` is never `hidden` any more (transparent, `pointer-events: none`, `> .player` auto); Player keeps a `shown` state that lingers for a 180 ms `EASE.in` fade (`DUR.fast`) after an engine exit. Durations are tokens: present `DUR.base`, title `DUR.sheetOut` (+40 ms), dismiss `DUR.base` `EASE.in` (landscape: stage scale .94 + player opacity; portrait: translateY 6 % + opacity); reduced motion = `DUR.rm` opacity both ways.
- **Kind:** native · **Priority:** P1 · **Effort:** M
- **Files:** `phone/src/App.svelte` (`.playerhost`, line 310, Foundation-owned), `phone/src/styles/app.css:33` (`.playerhost` background), `phone/src/player/Player.svelte` (`close()` l. 383, the busy-close button l. 813, `onKey` Escape l. 596), `phone/src/styles/player.css`
- **Now:** `.playerhost` is toggled with `hidden={R.modal !== 'player'}` (App.svelte:310). Opening swaps the detail page for the black loading card in one frame. Closing (X → `exitPlayer()` → `closePlayer()`) swaps back in one frame. The host is opaque `#000` (app.css:33), so nothing could ever show through.
- **Change:**
  - Make `.playerhost` transparent. `.player` already paints `#000` (components.css:846) and the portrait player paints `var(--bg)`.
  - **Present** (in Player.svelte, an `$effect` on `open` becoming true): `playerEl.animate([{opacity:0},{opacity:1}], {duration: 260, easing: EASE.out})`. Add `.pload__body` going `scale(.97) → 1` with opacity 0 → 1 over 320 ms `EASE.out`, delayed 40 ms, so the backdrop dissolves in and the title settles.
  - **Dismiss from our own controls:** add `dismiss()` in Player.svelte, used by X, busy-X and Escape.
    - Landscape: the stage goes `scale(1) → scale(.94)` with opacity 1 → 0 over 220 ms `EASE.in`.
    - Portrait: the whole `.vr-player` goes `translateY(0) → translateY(6%)` with opacity 1 → 0 over 240 ms `EASE.in`.
    - Then call `exitPlayer()`. Guard with a `dismissing` flag so a double tap can't exit twice, and clear inline styles when the modal reopens.
  - **Engine-initiated exits** (end of film, Up Next failure, `openItem` to another route): these call `exitPlayer()` directly and the video is emptied at once. App.svelte should keep the host mounted for a 200 ms opacity 1 → 0 fade after `R.modal` leaves `'player'`, with a `hostClosing` flag and WAAPI as the sheet host already does (App.svelte:256-270). The result is a dip from black to the page instead of a cut.
- **Why:** Modal presentation on iOS always animates (fullScreenCover, AVPlayerViewController). A hard cut from a page to a black screen is the single most "web" moment in the player.
- **Constraints & risks:**
  - Don't pause the video before `exitPlayer()`. Its `onpause` progress report could land after the Stopped (the TV note in CLAUDE.md). Let the last 220 ms keep playing; `exitPlayer()` nulls `onpause` itself.
  - Delaying `exitPlayer()` by ≤ 240 ms only delays the Stopped by that much.
  - Reduced motion: an opacity-only 180 ms fade both ways.
  - No TV code touched.
- **Verify:** Run `HMR=0 PORT=… phone/dev-chrome.sh`, then frame → MovieDetail → Trailer: the loading card fades in. Tap X: the stage shrinks and fades onto the page. Repeat with `rm=1`. In DevTools, the Animations panel at 10 % speed.
- **Depends on / conflicts with:** PLY-02 reuses `dismiss()`. PLY-07's sheets sit inside the player and fade with it. App.svelte and app.css belong to Foundation; coordinate the host change.

### PLY-02 · Make swipe-down a real interactive dismiss (the video shrinks, the page shows through) — ✅ done
- **Lane E:** direct rAF-coalesced style writes, velocity as proposed; the away animation is `DUR.fast` `EASE.in`; the spring-back uses `spring()` from safe.js (leaves at the finger's speed) instead of a fixed 320 ms curve. Portrait dims the page through a `.vr-dim` sibling in the host. A pointercancel or a second finger (pinch) springs back.
- **Kind:** native · **Priority:** P1 · **Effort:** M
- **Files:** `phone/src/player/Player.svelte` (`onDown/onMove/onUp/onCancel`, l. 251-283; `dragY` state; `style:--vr-drag` l. 639), `phone/src/styles/player.css:15-17` (`.vr-stage` transform and transition)
- **Now:** A vertical drag with the controls hidden translates `.vr-stage` 1:1 over a black background (screenshot `l-swipedown.png`: a 140 px drag leaves a black band above the video). Release past 110 px calls `exitPlayer()`, which cuts. There is no velocity: a quick 60 px flick springs back. `dragY` is `$state`, so every move re-renders the player's `style`.
- **Change:**
  - Track velocity as `Sheet.svelte` does (`v = .7*(dy/dt) + .3*v`, px/ms).
  - Write transforms straight to the element in `onMove`, not through `$state`.
  - **Landscape:** `p = clamp(dy / (0.6 * H), 0, 1)`. The stage gets `transform: translate3d(${dx*.35}px, ${dy}px, 0) scale(${1 - .3*p})` with origin centre. `.vr-player`'s background alpha goes `1 - .85*p` (with PLY-01's transparent host, the page underneath shows through).
  - **Portrait:** move the whole `.vr-player` card-style: `translateY(dy)`, a 12 px top radius, and the page underneath dimmed by `rgba(0,0,0,.5*(1-p))`. Only when the drag starts on the stage and the player's `scrollTop === 0`.
  - **Release** closes when `dy > 110 || (v > .5 && dy > 24)`. Animate from the current transform on to `translateY(dy + .25H) scale(.6)` with opacity 0 over 200 ms `EASE.in`, then `exitPlayer()` (through PLY-01's `dismiss()` path).
  - **Cancel** animates back with WAAPI, 320 ms `EASE.sheet`.
- **Why:** In Photos, the Apple TV app and Infuse, the thing under your finger shrinks and follows it, the page behind fades in, and a flick is enough. A 1:1 slide over black is a web imitation of that.
- **Constraints & risks:**
  - Keep the SPEC §4 gate: only with the controls hidden, not locked, no panel, no error (l. 264). Optionally, a drag that starts on bare video (`isControl()` already filters controls) may also work with the controls up, fading them during the drag. That is a spec change, so ask first.
  - Reduced motion: follow 1:1 without scale, and close with a fade.
  - A transform on the stage over a playing `<video>` is compositor-only, and only lives during the gesture.
- **Verify:** Dev frame `land=1`, a trailer. Wait 4 s for the controls to hide, then mouse-drag down from mid-screen. The page is visible behind, a fast 60 px flick closes, and a slow 80 px drag springs back. Repeat in portrait.
- **Depends on / conflicts with:** PLY-01 (transparent host, `dismiss()`).

### PLY-03 · Show the controls on the first tap (no 300 ms wait) — ✅ done
- **Lane E:** measured tap → controls 299 ms before, 6–11 ms after. When the double tap takes them down again they fade over `--dur-fast` (`.vr-player--seeking`), not the 420 ms drift.
- **Kind:** native · **Priority:** P1 · **Effort:** S
- **Files:** `phone/src/player/Player.svelte` (`TAP_WAIT` l. 40, `tap()` l. 285-309, `seekRun()` l. 229-249), `phone/src/styles/player.css`
- **Now:** Every single tap waits `TAP_WAIT` = 300 ms (to rule out a double tap) before `toggleControls()`, so tapping to bring up the controls always lags 300 ms.
- **Change:**
  - When the controls are **hidden**, call `showOsd()` immediately and still record `single` with `shownByTap: true`. If a second tap on the same side arrives within 300 ms, start `seekRun()` and, because the first tap raised them, `hideOsd()`: the seek feedback replaces the controls, as YouTube does.
  - When the controls are **visible**, keep the 300 ms wait before hiding, so a double tap doesn't flash them off and on.
  - For 300 ms after a tap-show, set `.vr-player--justshown .player__controls * { pointer-events: none }`. Otherwise a quick second tap near the centre lands on a just-appeared ±10 button.
- **Why:** AVKit and YouTube react on touch-up. A 300 ms delay on the most frequent gesture reads as sluggish.
- **Constraints & risks:** Locked mode (lock pill) and the panel-close path are unchanged.
- **Verify:** Dev landscape trailer with the controls hidden: one tap brings them up in the next frame (DevTools Performance). Double-tap right: +10 appears and the controls go away. Double-tap with the controls up: the seek runs, and there's no hide/show flicker.
- **Depends on / conflicts with:** PLY-10 (the feedback's look).

### PLY-04 · Keep the portrait video pinned while the info column scrolls — ✅ done
- **Lane E:** `top: var(--safe-top)` with no padding on the scroller (engines disagree on sticky insets inside a scroller's padding) and a `--bg` box-shadow shifted up by `--safe-top` to cover the strip above it. iPhone check: scroll an episode with the overview open in a Safari tab.
- **Kind:** native · **Priority:** P1 · **Effort:** S
- **Files:** `phone/src/styles/player.css:114-115` (`.vr-player--portrait`, `.vr-player--portrait .vr-stage`)
- **Now:** In portrait the whole `.vr-player` is the scroller and `.vr-stage` is `position: relative` inside it. Scrolling the overview, chips or Up Next list scrolls the playing video off the top.
- **Change:**
  ```css
  .vr-player--portrait { padding-top: var(--safe-top); }
  .vr-player--portrait .vr-stage { position: sticky; top: 0; margin-top: 0; z-index: 3; }
  ```
  Sticky insets are measured inside the scroller's padding, so the video stops under the status bar in a Safari tab (in the standalone app `--safe-top` is 0). The stage already paints `#000`, so the info slides under it.
- **Why:** The Apple TV app and YouTube both keep the picture fixed while the details scroll.
- **Constraints & risks:**
  - The portrait sheets' max-height (player.css:205) still assumes the video at the top, which remains true.
  - The compact trickplay preview lives inside the stage and is unaffected.
- **Verify:** Dev portrait trailer. Force a scroll with `document.querySelector('.pport__info').style.paddingBottom = '1200px'`, then scroll: the video stays. On the iPhone, check an episode with the overview expanded plus the Up Next row.
- **Depends on / conflicts with:** PLY-02 (portrait drag uses `scrollTop === 0`).

### PLY-05 · Stop the rotate-hint animation looping beside a playing video → merged into MOT-12
- **Kind:** perf · **Priority:** P1 · **Effort:** S
- **Files:** `phone/src/styles/components.css:1061` (`.rotatehint__icon .i … infinite`), override in `phone/src/styles/player.css`. Optional: `phone/src/player/Player.svelte` l. 843-846.
- **Now:** The hint's phone icon rotates on an infinite 2.4 s loop for as long as the player is in portrait. Measured in headless Chrome during trailer playback: `document.getAnimations()` = `[vr-rotate]`, iteration count `infinite`. The same kind of always-running animation cost ~16 % of a core on the TV (CLAUDE.md, marquee note), and here it runs next to a playing film on battery.
- **Change:**
  - `.vr-player .rotatehint__icon .i { animation-iteration-count: 2; }`. It shows twice (~5 s) and rests at 0°. The hint remounts on every return to portrait (inside `{#if portrait}`), so it replays when it is relevant.
  - Optional (P3): a module-level `rotatedOnce` set when the open player goes portrait → landscape. On later portrait visits in this session, hide the card, since the user already knows.
- **Why:** An animation that runs for the whole film costs battery, and a hint that nags after it has been followed is noise.
- **Constraints & risks:** Reduced motion is already static (components.css:1077).
- **Verify:** Headless or dev: `document.getAnimations().length === 0` about 5 s after opening a trailer in portrait.
- **Depends on / conflicts with:** Cross-ref for the motion-system auditor (components.css is Foundation's).

### PLY-06 · Skip chip: rise with a transform, and fade in and out — ✅ done
- **Lane E:** measured: the chip jumped 58 px in one frame; now it glides 282 → 224 px over ~230 ms. Lowered spot unchanged (above the PGS band in landscape). Reduced motion: no glide, fade only.
- **Kind:** bug · craft · **Priority:** P1 · **Effort:** S
- **Files:** `phone/src/styles/components.css:944-957` (`.skipchip`, `.skipchip--raised` changes `bottom`), `phone/src/styles/player.css:119-120` (portrait `bottom: 44px`), `phone/src/player/Player.svelte:743-747`
- **Now:** The chip is raised by switching `bottom`, but only `transform` has a transition. So on every tap that shows or hides the controls during an intro, it **jumps** ~70–100 px; SPEC §5 asks for a 260 ms ease-out rise. It also mounts and unmounts in one frame (`{#if skip}`).
- **Change:**
  - Wrap the chip in `<div class="vr-skipwrap">` (`position:absolute; inset:0; pointer-events:none`; the chip keeps `pointer-events:auto`).
  - Place the chip at the **raised** position, `bottom: calc(var(--safe-bottom) + var(--skip-raise))`, and lower it by translating the wrapper. A translate percentage refers to the wrapper's own height, which is the stage height:
    ```css
    .vr-skipwrap { transition: transform var(--dur-base) var(--ease-out); }
    .vr-skipwrap--low { transform: translateY(calc(var(--safe-bottom) + var(--skip-raise) - 15% - var(--s-2))); }
    .vr-player--portrait .vr-skipwrap--low { transform: translateY(32px); } /* 44 → 12 */
    ```
    The chip's own `:active` scale stays on the chip.
  - Entrance: Svelte `in:` CSS transition, opacity 0 → 1 plus `translateY(8px) → 0`, 260 ms `EASE.out`. Exit: opacity 180 ms.
- **Why:** Netflix, Apple TV+ and Infuse let the skip button glide up with the controls. A jump reads as broken.
- **Constraints & risks:**
  - The subtitle band rule: the lowered chip stays above the 15 % band.
  - `.vr-subs--raised` already uses a transform (player.css:38), so keep the two moving in step.
  - Reduced motion: no translate transition, opacity only.
- **Verify:** Use the dev tip (set `P.skips`, open the modal) and tap the stage to toggle the controls: the chip glides. Landscape and portrait.
- **Depends on / conflicts with:** PLY-09 (controls timing; use the same show duration).

### PLY-07 · Make the player's pickers real sheets and panels (slide in, and drag the grabber to dismiss) — ✅ done
> Wave 2: portrait = `.vr-picker` (fixed, full screen) → `.scrim.vr-sheetscrim` + `.vr-sheethost` → `<Sheet class="vr-sheet">`, so it's the same structure as App's host and Sheet's drag finds the scrim. TrackPanel puts the Segmented in Sheet's `head` snippet, so it doesn't scroll. The transitions live in `player/pickers.js` (`|global`) and match App's sheets (SHT-01), not the proposal's 440 ms `EASE.sheet` / 300 ms `EASE.in`: in = `SPRING.smooth` over `DUR.spring` by `100%` of the sheet's own height, with the scrim fading in over `DUR.sheetOut`. Out = from wherever the sheet is, `DUR.sheetOut` `EASE.dismiss`. The landscape `.panel` comes in 24 px from the right with opacity over `DUR.base` `easeSheet`, and leaves over `DUR.fast` `easeIn`. Reduced motion is a `DUR.rm` cross-fade both ways. Measured (trailer, 393×852 and 852×393): the sheet enters from 852 → 288 with no jump. X and a scrim tap: 288 → off screen in ~260 ms. A 40 px body drag springs back, and a 120 px body flick and a 130 px grabber drag both dismiss with no jump back at unmount. Picking "Off" set `P.subIndex` −1. `getAnimations()` is empty when idle. Fixes found on the way: (1) a measured-px intro started the sheet 140 px up, because Svelte runs the intro before the lists render (216 of 356 px). (2) Sheet.svelte's unhosted drag-dismiss let its fills go before the owner unmounted it, so the sheet flashed back to the release point. It now pins the end state. (3) The Audio / Subtitles / Quality sheet was content-sized and jumped by up to 188 px on each segment tap. It now has a fixed peek height (`.vr-sheet--fixed`). (4) A tap on the video beside an open panel waited out the 300 ms double-tap window before closing it. It now closes at once. (5) `rmOut(DUR.rm)` is 1 ms under Reduce Motion, so the reduced-motion fade-outs were cuts. The same slip in App's `loginOut` is fixed too.
- **Kind:** native · **Priority:** P1 · **Effort:** M
- **Files:** `phone/src/player/TrackPanel.svelte:220-250`, `phone/src/player/ChapterPanel.svelte:326-345`, `phone/src/player/Player.svelte:869-873`, `phone/src/components/Sheet.svelte` (reuse), `phone/src/styles/player.css:134-139, 205`
- **Now:** The portrait pickers draw a `.sheet__grabber` but have **no drag handling**, and they pop in and out with their scrim in one frame. The landscape `.panel` pops too. Every routed sheet in the app (Sheet.svelte plus App's host) slides at 440 ms `ease-sheet` and drags to dismiss. The player's are the only ones that don't.
- **Change:**
  - **Portrait:** render with `<Sheet class="vr-sheet" title=… onclose={onclose}>`, which brings drag-to-dismiss with velocity; the Segmented control goes at the top of the body.
    - Present: `translate3d(0,100%,0) → 0` over 440 ms `EASE.sheet`, with the scrim's opacity 0 → 1 over 260 ms.
    - Dismiss: 300 ms `EASE.in` (SPEC §5).
  - **Landscape panel:** in with `translateX(24px) → 0` and opacity over 300 ms `EASE.sheet`; out over 180 ms `EASE.in`.
  - Because `P.panel = null` unmounts from Player's `{#if}`, either put the transitions in Player.svelte on a wrapper, or mark them `|global`. Svelte 5 transitions are local, and the elements sit in TrackPanel's own `{#if portrait}`, so a local transition won't run.
  - The video dim already fades (player.css:21).
- **Why:** A grabber that can't be grabbed is a web tell, and sheets that don't slide aren't iOS sheets.
- **Constraints & risks:**
  - Sheet.svelte's default `onclose` is `closeSheet()` (the router), so always pass the player's `onclose`.
  - Keep `.vr-sheet`'s max-height (the video stays visible above).
  - Reduced motion: a 180 ms crossfade.
- **Verify:** Dev portrait trailer (YouTube captions give a Subtitles chip). Open it, drag the grabber down 120 px: it closes. Flick: it closes. A small drag springs back. In landscape the chip's panel slides in from the right.
- **Depends on / conflicts with:** Cross-ref Foundation (Sheet.svelte API). PLY-01.

### PLY-08 · Don't flash the buffering ring on short waits — ✅ done
- **Lane E:** measured: a −5 s seek inside the buffer mounted/unmounted the ring (2 mutations) before, 0 after; a held wait shows it at ~467 ms, fading in over 180 ms.
- **Kind:** craft · **Priority:** P1 · **Effort:** S
- **Files:** `phone/src/player/Player.svelte:141-147, 753-767`
- **Now:** The bare ring (`.pcard--bare`) appears the moment `P.spinner` is true. The engine sets it synchronously on every `waiting` event (`src/lib/player.svelte.js:760-762`), which Safari fires on most seeks and double-tap runs even when the data arrives 100–200 ms later, so the ring blinks.
- **Change:** Phone only, no engine change. Add a `spinShown` state with a 450 ms `setTimeout`, mirroring `bufLong` (l. 141-147), and render the bare ring only when `spinShown`. Fade it in over 180 ms. The Buffering card (3 s) is unchanged.
- **Why:** AVKit's indicator waits ~0.5 s. A blink on every seek looks nervous.
- **Constraints & risks:**
  - The stall watchdog's own spinner comes after 2 s anyway, so this only filters the `waiting` blips.
  - Reduced motion: no fade, same delay.
- **Verify:** Dev landscape trailer: double-tap seeks inside the buffer show no ring. DevTools network "Slow 4G" plus a far seek: the ring appears after ~0.45 s.
- **Depends on / conflicts with:** PLY-19 (the ring's look).

### PLY-09 · Controls: show fast, hide gently, then take them out of compositing — ✅ done
- **Wave 3 (reduced motion):** "no fade" was reversed across the player. iOS keeps cross-fades under Reduce Motion and drops only movement. The controls, the loading card, `.vr-fadeable`, the subtitle opacity, the buffering ring (PLY-08) and the seek flash now fade as usual. What stays off is movement: the subtitle lift, the Up Next rise, the skip-chip glide, the ripple and the chevron wave.
- **Lane E:** local vars `--vr-ctl-in: var(--dur-fast)` / `--vr-ctl-out: var(--dur-spring-quick)` (420 ms) in player.css instead of new global tokens. Computed `visibility: hidden` once hidden, `document.getAnimations()` empty in landscape playback with the controls down.
- **Kind:** perf · craft · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/styles/components.css:854-855` (overridden in player.css), `phone/src/styles/player.css:116-117`
- **Now:** The controls fade over 260 ms `ease-out` both ways. Once faded they sit at `opacity: 0` with 8 or more `backdrop-filter: blur(22px) saturate(170%)` glass elements (`.pbtn`, `.iconbtn`, `.pchip`) over a playing video. Whether WebKit skips backdrop filters at opacity 0 is unmeasured. `visibility: hidden` guarantees it, and is the same pattern as `.vr-pload` (player.css:87-89) and the TV's `#play-loading`.
- **Change:**
  ```css
  .vr-player .player__controls, .vr-pport-ctl { transition: opacity 180ms var(--ease-out), visibility 0s; }
  .vr-player .player__controls--hidden, .vr-pport-ctl.player__controls--hidden {
    visibility: hidden; transition: opacity 420ms var(--ease-inout), visibility 0s linear 420ms; }
  ```
- **Why:** AVKit's chrome snaps in and drifts out. A film playing for two hours under invisible blurred layers is avoidable battery drain.
- **Constraints & risks:**
  - Hidden controls leave the accessibility tree, which is effectively the same as today's `pointer-events: none`.
  - Reduced motion: no fade.
- **Verify:** iPhone Safari Web Inspector → Timelines (Layers/CPU), 60 s of playback with the controls hidden, before and after. In dev, `getComputedStyle(…).visibility === 'hidden'` 0.5 s after the auto-hide.
- **Depends on / conflicts with:** Motion-system tokens (a show/hide duration pair would replace the literals).

### PLY-10 · Double-tap seek: ripple, chevron wave, and the amount bumps — ✅ done
- **Lane E:** in `DUR.press`, out `DUR.base`; ripple 440 ms (`--dur-base + --dur-fast`), wave 360 ms (`2 × --dur-fast`) with 80/160 ms staggers, amount bump `DUR.fast` on `springEase.bouncy`. Everything unmounts with the half-moon.
- **Kind:** craft · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/player/Player.svelte:204-249, 676-683`, `phone/src/styles/components.css:960-972`, `phone/src/styles/player.css:74-75, 180-182`
- **Now:** `.seekflash` appears and disappears in one frame (`{#if flash}`), its three chevrons are static, and the number just swaps text (screenshot `l-doubletap.png`).
- **Change:** One-shot per tap; transform and opacity only; nothing loops.
  - The half-moon fades in over 120 ms and out over 260 ms after the run (a Svelte `out:` fade).
  - **Ripple:** per tap, a 120 px white circle at the tap point inside `.seekflash` (add `overflow: hidden`) goes `scale(0) → scale(2.4)` with opacity .28 → 0 over 450 ms `EASE.out`, removed on `animationend` (key it by a tap counter).
  - **Chevrons:** a 360 ms wave where each `.i` goes opacity .35 → 1 → .35, staggered 0/80/160 ms in the seek direction, restarted per tap.
  - **Amount:** `{#key flash.total}` with `in:` `scale(1.14) → 1` over 160 ms `EASE.spring`.
- **Why:** YouTube and the Apple TV app acknowledge each tap. Here the only feedback for the third tap is a digit changing.
- **Constraints & risks:** Reduced motion: fade only, with no ripple, wave or bump.
- **Verify:** Dev landscape trailer: triple-tap right, and take screenshots at 50, 150 and 300 ms.
- **Depends on / conflicts with:** PLY-03.

### PLY-11 · Up Next: a continuous countdown ring and a card that slides in — ✅ done (+ MOT-11's countdown part)
- **Lane E:** local override `.vr-player .upnext__ring .ring__value { transition: stroke-dashoffset 1s linear }` (sampled every 100 ms in dev by driving `P`: 0.5-unit steps, no plateaus after the first tick; a pause holds the ring). Card in: `fly` x 24 px over `DUR.push` on `easeSheet` (landscape), fade (portrait), `|global`; the portrait inline card leaves at once because its `{:else}` episode row takes the slot. Reduced motion: 260 ms steps, fade in.
- **Kind:** craft · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/player/UpNextCard.svelte:222-244`, `phone/src/styles/components.css:282-286` (`.ring__value` 260 ms), `phone/src/player/Player.svelte:749-751, 851-853`, `phone/src/styles/player.css:166`
- **Now:** `p = 1 - left/total`, where `left` is whole seconds, animated by the ring's 260 ms linear transition. The ring moves in 10 visible jumps, each followed by ~740 ms of standstill. Pausing sets `p = 0` (`counting` is false), which unwinds the ring. The card mounts in one frame.
- **Change:**
  - `.upnext__ring .ring__value { transition-duration: 1s; }`: ticks arrive once a second while the card is up (full-rate `timeupdate` near the window), which gives a continuous sweep.
  - Use `p = SET.autoplayNext ? 1 - left/total : 0`, so a pause freezes the ring where it is instead of emptying it.
  - Card: in landscape, `in:` `translateX(24px) → 0` plus opacity over 360 ms `EASE.sheet`, and `out:` opacity over 200 ms. The portrait inline card fades only.
- **Why:** Netflix and Apple TV countdowns sweep smoothly. A ticking ring that resets on pause looks unfinished.
- **Constraints & risks:**
  - `stroke-dashoffset` on a 40 px SVG is a tiny repaint, and only while the card is up.
  - Reduced motion: keep the 260 ms steps and no slide.
- **Verify:** iPhone only, on an episode near its credits. Trailers have no `P.next`, and `upNextVisible()` needs `!P.pending`. In dev you can check the ring's CSS alone with a static `ProgressRing` whose `--p` changes each second.
- **Depends on / conflicts with:** Motion system (`.ring__value` is global; override it locally).

### PLY-12 · Transport glyphs: morph play/pause, and nudge the ±10 arrows — ⏳ later round
- **Kind:** craft · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/player/Player.svelte:703-705, 734-736`, `phone/src/styles/player.css`
- **Now:** The play and pause icons swap in one frame. The ±10 buttons only have the shared press scale (components.css:888).
- **Change:**
  - Stack both glyphs inside `.pbtn--lg` and toggle between them. The incoming glyph goes opacity 0 → 1 and `scale(.6) → 1` over 180 ms `EASE.out`; the outgoing one goes to opacity 0 and `scale(.6)` over 120 ms. This is the SF Symbols "replace" feel.
  - ±10: on click, `svg.animate([{transform:'rotate(0)'},{transform:'rotate(∓18deg)'},{transform:'rotate(0)'}], {duration: 280, easing: EASE.spring})` (back rotates negative, forward positive).
  - The glyph follows `P.paused`, which the video's own events drive, so it shows the real state.
- **Why:** AVKit animates both; it's the most-touched control in the app.
- **Constraints & risks:** Reduced motion: an instant swap and no rotation.
- **Verify:** Dev trailer: tap play/pause and ±10, then slow the Animations panel to 10 %.
- **Depends on / conflicts with:** —

### PLY-13 · Lock pill: fade in and out, and show the hold progress — ⏳ later round
- **Kind:** craft · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/player/Player.svelte:352-380, 769-783`, `phone/src/styles/components.css:1022-1034`, `phone/src/styles/player.css`
- **Now:** The pill mounts and unmounts in one frame. Unlocking needs a 1 s hold (`pillDown`), but nothing shows that holding is doing anything; you either guess the duration or let go early.
- **Change:**
  - The pill enters with opacity plus `translateY(-8px) → 0` over 220 ms and leaves with opacity over 200 ms.
  - While held, `.lockpill--holding`: a 40 px SVG ring around `.lockpill__icon` whose `stroke-dashoffset` goes 100 → 0 over 1000 ms linear (a CSS animation, only while the class is set). Releasing early retracts it over 150 ms.
  - On unlock, the icon swaps lock → unlock with `scale(1.15) → 1` over 160 ms, then the pill fades as the controls come in.
- **Why:** Hold gestures on iOS (e.g. the Screen Time and Emergency SOS holds) show their progress, and it replaces the haptic we can't give.
- **Constraints & risks:** Reduced motion keeps the ring fill (it's information) and drops the bounce and slide.
- **Verify:** Dev trailer → Lock. Tap the stage and the pill fades in. Hold for 0.5 s and release, and the ring retracts. Hold for 1 s and it unlocks.
- **Depends on / conflicts with:** —

### PLY-14 · Scrubber: grow the preview out of the thumb, and snap at chapter marks — ⏳ later round
- **Kind:** craft · **Priority:** P2 · **Effort:** M
- **Files:** `phone/src/player/Scrubber.svelte` (`move()` l. 117-132, preview l. 186-201, ticks l. 184, `tipsLeft` l. 2-3), `phone/src/styles/components.css:919, 932-942`, `phone/src/styles/player.css:62-68`
- **Now:** The trickplay preview pops in and out with `{#if dragging}`. The chapter ticks are 2 px dark notches, and crossing one gives no feedback. The fine-scrub tip shows on the first two drags of every launch.
- **Change:**
  - **(a) Preview:** enters with opacity 0 → 1 and `scale: .92 → 1` (use the `scale` property; `.trick` already uses `transform: translateX(-50%)`) from `transform-origin: 50% 100%`, over 140 ms `EASE.out`. It leaves over 120 ms.
  - **(b) Chapter magnet:** only at full-speed scrubbing (`rate === 1`). When the target is within 6 px of a tick, snap `P.scrub` to that chapter's `at`. Release the snap at 10 px (hysteresis). The tick under the thumb lights up (`.scrubber__tick--hit`: `background: #fff; transform: scaleY(1.8)`, 120 ms), and the preview's chapter line (landscape) already names it.
  - **(c)** Count the fine-scrub tip in `localStorage` (`reel.fineTip`, ≤ 3 ever, try/catch) instead of per launch.
- **Why:** A detent you can see stands in for the haptic tick native players give at chapter boundaries, and makes a chapter start easy to hit.
- **Constraints & risks:**
  - No magnet in fine-scrub modes (the user is aiming precisely).
  - Reduced motion: no scale.
- **Verify:** Dev landscape trailer (trailers have no chapters, so set `m.P.chapters = [{at: 30, name: 'Test'}]` via the dev tip). Drag across 0:30 and it catches. Drag with the finger 60 px up (fine mode) and it doesn't.
- **Depends on / conflicts with:** —

### PLY-15 · AirPlay: show that it's on, and stop hiding the controls — ⏳ later round
- **Kind:** native · **Priority:** P2 · **Effort:** M
- **Files:** `phone/src/player/Player.svelte:452-534` (AirPlay/PiP effect), `phone/src/styles/player.css`, possibly `src/lib/player.svelte.js` `showOsd()` (inside `__PHONE__` only)
- **Now:**
  - The AirPlay button appears only when a target is available, and nothing reflects an active session: the button looks the same.
  - The phone's stage goes black. With custom controls, WebKit draws no "Playing on…" placeholder.
  - The controls still auto-hide after 3.5 s.
  - Text subtitles are drawn by our `.vr-subs` layer on the phone, with the track set to `'hidden'`.
- **Change:**
  - Listen for `webkitcurrentplaybacktargetiswirelesschanged` on the video and keep `wireless = video.webkitCurrentPlaybackTargetIsWireless`.
  - While wireless:
    - The AirPlay icon turns gold (`iconbtn--on`).
    - The stage shows a centred card over the blurred backdrop (reuse `loadImg` and the `.pload__art` look) with the `airplay` icon and "Playing on AirPlay". The receiver's name isn't exposed to web pages.
    - The controls stay up: the phone is now the remote (phone-side `ctl` override).
    - Subtitles: set the text track to `'showing'`, as `setPip()` does. Then **verify on a receiver** whether a side-loaded VTT reaches it. If not, toast once: "Subtitles show on the iPhone only". PGS never reaches the receiver: say so.
- **Why:** The native player shows "Playing on Living Room" with the controls pinned. A black screen that hides its own controls looks like a failure.
- **Constraints & risks:**
  - `lifecycle.js` already treats wireless as "still watching".
  - Any engine change goes inside `__PHONE__`, with the TV path byte-identical.
- **Verify:** iPhone plus an AirPlay receiver only.
- **Depends on / conflicts with:** PLY-09 (the visibility rule must respect the pinned state).

### PLY-16 · Pinch fit ↔ fill as a zoom, not a jump — ⏳ later round
- **Kind:** craft · **Priority:** P2 · **Effort:** M
- **Files:** `phone/src/player/Player.svelte:311-350` (pinch handlers, `fill`), `phone/src/styles/player.css:19-20, 27-28`
- **Now:** On `touchend`, `fill` flips `object-fit` between contain and cover in one frame, and nothing follows the fingers.
- **Change:**
  - During a two-finger pinch in landscape, apply `transform: scale(s)` to `.vr-video` and `.vr-pgs`, with `s = clamp(1, kFill, s0 * dist/pinch0)`. Write it directly, coalesced to one write per frame with rAF. `kFill = max(W / cw, H / ch)`, where `cw`/`ch` is the contained video rect from `videoWidth/Height` and the stage rect.
  - On release, animate to 1 or `kFill` over 260 ms `EASE.sheet`. On finish, set the `object-fit` class and remove the transform, so the steady state is exactly today's: no lasting transform over the hardware video.
  - Fill → fit runs the same in reverse (start at `kFill` with contain).
  - The text-cue layer is not scaled.
- **Why:** AVKit's aspect zoom animates and follows the pinch.
- **Constraints & risks:**
  - Watch for a one-frame flicker at the class swap on the iPhone (the video layer re-lays out).
  - Reduced motion: an instant swap (today's behaviour).
- **Verify:** Dev frame `land=1` → dev panel "pinch in/out" buttons. On the iPhone, a slow pinch.
- **Depends on / conflicts with:** —

### PLY-17 · Tap the remaining time to see when it ends — ⏳ later round
- **Kind:** craft · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/player/Scrubber.svelte:204`, `src/lib/player.svelte.js` `endsAt()` (l. 1733, read-only use), `phone/src/styles/player.css`
- **Now:** The right-hand label is always `−23:02`.
- **Change:** A tap on it toggles `−23:02` ↔ `ends 22:41`, with a 180 ms crossfade. The choice is kept in `localStorage` `reel.endTime` (try/catch). Give it a 44 px hit area with `::after`. Not in trailers, and it should recompute while paused (the end time slides).
- **Why:** Infuse and Plex both offer it, and it answers "can I finish this tonight?" without arithmetic.
- **Constraints & risks:** The label must not start a scrub (it sits outside `.vr-scrub__hit`, so fine).
- **Verify:** Dev trailer: tap the end time and it toggles and persists across reopen.
- **Depends on / conflicts with:** —

### PLY-18 · Lock-screen Now Playing: correct artwork shape, and skip buttons for video — ⏳ later round
- **Kind:** native · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/player/Player.svelte:536-587`
- **Now:**
  - Artwork is declared `sizes: '512x512'`, but it is a 2:3 poster (`Primary h=512`, ~341×512) or a 16:9 thumb.
  - Title is "S2 · E4 · Name", artist the series.
  - `nexttrack` is registered whenever `P.next` exists (l. 571). iOS may then show next-track buttons instead of ±skip on the lock screen for every episode, and a stray tap jumps to the next episode.
- **Change:**
  - Artwork: for an episode, its 16:9 still (`imgUrl(it, 'Primary', {w: 640})`, sizes `640x360`); for a movie, a backdrop or thumb, then the poster, each with its real size (or omit `sizes`).
  - `title` = the episode name, `artist` = "Series · S2, E4" (the Apple TV app pattern).
  - **Verify on the iPhone** which pair iOS shows when both are set. If next-track replaces ±10, register `nexttrack` only while `upNextVisible()`.
- **Why:** The native TV app shows ±skip and a correctly framed still.
- **Constraints & risks:** None for the TV. Keep the position-state throttle.
- **Verify:** iPhone only: lock the phone mid-episode (in a Safari tab, or with AirPlay, so it keeps playing).
- **Depends on / conflicts with:** Cross-ref the PWA-shell auditor (background behaviour).

### PLY-19 · Use an iOS-style activity indicator in the player — ⏳ later round
- **Kind:** native · perf · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/player/Player.svelte:765, 793` (spinner markup), `phone/src/styles/player.css` (scoped; `.spinner` in components.css:334-341 is global)
- **Now:** The player's spinner is the app's gold-topped ring rotating continuously at 60 fps. AVKit and iOS use the 8-spoke UIActivityIndicatorView, white over video.
- **Change:**
  - An inline SVG with 8 spokes (round caps, opacity ramp .25 → 1), white at 88 %, 28/36 px.
  - `animation: vr-spin .8s steps(8) infinite`. The compositor then redraws 10× a second instead of 60 on the loading and buffering cards.
  - Keep the gold ring elsewhere in the app.
- **Why:** A white spoke wheel is what a stalled iPhone video looks like. A gold ring reads as a web loader.
- **Constraints & risks:** Reduced motion: slow the steps to 1.6 s rather than stopping (it signals "working"). Coordinate with the motion-system auditor if they restyle `.spinner` globally.
- **Verify:** Dev trailer: the loading card and PLY-08's ring. The Performance panel shows ~10 frames/s while it spins.
- **Depends on / conflicts with:** PLY-08.

### PLY-20 · Subtitles: balanced lines, and a spike on honouring iOS caption style — ⏳ later round
- **Kind:** native · **Priority:** P3 · **Effort:** S (a) / M (b, spike)
- **Files:** `phone/src/styles/player.css:44-50` (`.vr-cue`), `phone/src/player/Player.svelte:387-450` (cue rendering)
- **Now:** Cues wrap wherever the text runs out, so an uneven long/short line pair is common. The user's iOS Accessibility → Subtitles & Captioning style is ignored, because the app draws the cues itself.
- **Change:**
  - **(a)** `.vr-cue { text-wrap: balance; max-width: 80%; }` in landscape (Safari 17.5+, harmless before). Broadcast-style even line breaks.
  - **(b)** iPhone-only spike: let WebKit render text cues natively (`mode = 'showing'`), which applies the iOS caption style, and lift them over the controls with `video::-webkit-media-text-track-container { transform: translateY(-Npx); transition: transform var(--dur-base) var(--ease-out) }`.
    - Keep the custom layer if cues misplace in fill mode or with `line`-positioned cues, or can't be lifted.
    - Report the findings in MEDIA-TEST.md "Found on the real iPhone".
- **Why:** Honouring the system caption style matters to exactly the people who set it.
- **Constraints & risks:** (b) touches PiP and AirPlay handling (`setPip`), so test those too. Don't ship (b) without an iPhone check.
- **Verify:** (a) dev trailer with auto-captions, landscape: two-line cues are even. (b) iPhone only, with a caption style set in Settings.
- **Depends on / conflicts with:** PLY-15 (subtitle mode switching).

## Considered and rejected
- **Haptic detents at chapters, or on lock/unlock:** `navigator.vibrate` doesn't exist on iOS. The iOS 18 `<input type=checkbox switch>` haptic trick needs a real tap activation, so it can't fire when a drag crosses a chapter or when the 1 s unlock timer fires. PLY-13 and PLY-14 give visual stand-ins.
- **Brightness and volume swipes:** iOS web has no brightness API, and `video.volume` is read-only on iOS (SPEC §4 agrees).
- **Programmatic landscape or orientation lock:** `screen.orientation.lock()` isn't supported on iOS, and element fullscreen isn't available on iPhone. Keep the rotate hint (PLY-05 tames it).
- **A "native full screen" button (`webkitEnterFullscreen`):** it hands over to AVKit and drops the PGS canvas, Skip chip, Up Next and lock. The custom player is a closed decision (ARCHITECTURE.md).
- **Auto-hiding the home indicator in landscape:** not available to web apps.
- **PiP in the home-screen app:** iOS refuses it (MEDIA-TEST.md). Already hidden.
- **Live video frames while scrubbing without trickplay:** each seek restarts the HLS remux job on the server.
- **Growing the player out of the tapped tile (zoom.js-style):** most starts come from Play buttons and the hero, and the loading card already carries the backdrop. It's high effort for a rare path; revisit after PLY-01.
- **A Ken Burns drift on the loading backdrop, or animated scrims:** always-running motion.
- **Hold for 2× speed (YouTube), or horizontal pan-to-seek on the video:** not iOS-native, and it conflicts with swipe-down and tap handling. Restraint.
- **Coalescing repeated ±10 button taps:** seeks inside the buffered range are cheap in Safari's HLS, and the double-tap run already coalesces.
- **Hiding the controls on tap while paused (AVKit does this):** SPEC §6 says never hide while paused. Kept.
- **A progress line during double-tap runs:** more chrome for a gesture whose feedback (PLY-10) already says how far.

## Cross-refs
- **Foundation:**
  - PLY-01 needs `App.svelte:310` (`.playerhost`, `hidden` → a fade-out window) and `app.css:33` (host background → transparent).
  - PLY-07 reuses `components/Sheet.svelte` inside the player; confirm its drag works outside App's `.sheethost`.
- **Motion system:**
  - `.rotatehint__icon .i` loops forever (components.css:1061); PLY-05 overrides it for the player, but the source rule should be finite everywhere.
  - A show/hide duration pair (e.g. `--dur-show 180ms`, `--dur-fade-out 420ms`) would replace PLY-09's literals.
  - `.ring__value`'s 260 ms transition makes every countdown or percent ring step (PLY-11 overrides it locally).
  - The global `.spinner` look (PLY-19).
- **PWA shell:** Media Session `play` from the lock screen while the app is hidden: after `lifecycle.js` paused the video, does iOS let a standalone app resume audio in the background, and do we want that? Unverified. PLY-18 touches the same handlers.
- **Detail screens:** the Play and Resume buttons could hand PLY-01 an origin rect later, if the tile/button zoom is ever revisited.
- **UX audit (open item):** `player.css` still has px type (22px loading title in portrait, 11px compact times); fine as is, as the audit notes.
