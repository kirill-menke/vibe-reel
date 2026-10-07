# Motion system & micro-interactions — polish and native-feel tasks

The app's motion is already disciplined. It uses transform/opacity almost everywhere, reduced motion is mostly handled, and in headless Chrome no animation runs on any browse screen at idle. It still reads as "web" in three places. **Press feedback** is raw `:active`: iOS sets it on touchstart, so tiles and rows light up under a scrolling thumb, and the release is a flat 110 ms ease-out with no spring. **Images pop in** with no fade, and the gradient placeholder doesn't match the skeleton's flat tone. **Controls don't move like iOS controls**: the segmented selection jumps, the switch is a painted button without the system haptic, and the glass bars flip their blur on in one frame. This file adds a small spring token set (real spring equations as `linear()`, with fallbacks) and one press controller. It then gives each shared primitive a few well-tuned details, and fixes two things that animate forever: the portrait player's rotate hint and the paging spinner.

Measured with headless Chrome 154 over CDP at 393×852 against the dev server and the real Jellyfin (dev account: 12 movies and 7 shows). iOS-only behaviour is marked **verify on device**.

## Inventory (table)

"Idle?" means the animation can run with nobody touching the phone. RM = honours `prefers-reduced-motion`. All citations are `phone/src/...` unless stated otherwise.

### CSS transitions / keyframes

| Where | What animates | Duration | Easing | RM | Idle? | Flag |
|---|---|---|---|---|---|---|
| `styles/components.css:128,130` `.iconbtn` | press scale + bg | 110 | `--ease-out` / linear | – | no | `:active`: flashes while scrolling (all press rows below) |
| `components.css:163` `.avatarbtn .avatar` | press scale | **none** | – | – | no | snaps (no transition on `.avatar`) |
| `components.css:180` `.tabbar__item` | color, bg 180 linear; press 110 | 180/110 | linear / ease-out | – | no | active pill cross-fades between items instead of sliding (cross-ref Nav) |
| `components.css:199-211` `.btn` | press scale, bg, color | 110/110/180 | ease-out / linear | – | no | release uses the same 110 ms curve as press (no spring) |
| `components.css:226` `.btn--status .btn__fill` | **width** | 260 | linear | ✓ `:1078` | no | layout property (allowed by SPEC §5, tiny layer) |
| `components.css:242-244` `.action__icon` | press scale + bg | 110 | ease-out / linear | – | no | |
| `components.css:285` `.ring__value` | stroke-dashoffset | 260 | linear | ✓ | no | Up Next countdown moves 260 ms then waits 740 ms each second (stepped) |
| `components.css:330` `.dots__dot` | **width** | 260 | ease-out | ✓ | no | Home overrides it (`home.css:35`, JS-driven) |
| `components.css:338` `.spinner` | rotate, **infinite** | 900 | linear | ✗ | **yes** | e.g. Library's paging sentinel (`screens/Library.svelte:642`) spins off screen whenever more pages exist |
| `components.css:388,392` `.tile__frame` | press scale | 110 | ease-out | – | no | no dim; SPEC §1 "scales **and darkens**" |
| `components.css:472-473` `.cast__photo` | press scale | 110 | ease-out | – | no | |
| `components.css:496-499` `.pill` | press scale, bg | 110/180 | ease-out / linear | – | no | |
| `components.css:513,515` `.episode` | bg | 110 | linear | – | no | row highlight fades out as fast as it comes in (UIKit fades out slower) |
| `components.css:568-570` `.catcard` | press scale | 110 | ease-out | – | no | |
| `components.css:599,603` `.row` | bg | 110 | linear | – | no | same as `.episode` |
| `components.css:624,630` `.switch` | track bg 180 linear, knob transform 180 | 180 | linear / ease-out | ✗ (fine) | no | no pressed stretch, no haptic (MOT-08) |
| `components.css:643,646` `.seg__opt` | bg, color | 180 | linear | – | no | selection jumps; no sliding thumb (MOT-07) |
| `components.css:657-660` `.chip` | press scale, bg | 110/180 | ease-out / linear | – | no | |
| `components.css:671` `.field__box` | box-shadow (focus ring) | 180 | linear | – | no | paint property, tiny: fine |
| `components.css:734/766` `.option` / `.ctx__item` | bg | 110 / **none** | linear | – | no | ctx item snaps |
| `components.css:807,816` `.skel` | opacity pulse, **infinite** | 1400 | `--ease-inout` | ✓ `app.css:48` | **yes** while loading | pulses from frame 1 (fast loads flicker), forever if a load hangs |
| `components.css:832-833` `.notif` | bg | 110 | linear | – | no | |
| `components.css:854` `.player__controls` | opacity | 260 | ease-out | via player.css | no | |
| `components.css:886,888` `.pbtn` | press scale **0.9** (literal) | 110 | ease-out | – | no | not a token |
| `components.css:904` `.pchip` | press scale | **none** | – | – | no | snaps (no transition declared) |
| `components.css:914` `.scrubber__track` | **height** 4→8 | 180 | ease-out | ✓ | no | layout property per frame (small; P3) |
| `components.css:925` `.scrubber__thumb` | transform | 180 | ease-out | ✓ | no | |
| `components.css:953` `.skipchip` | transform | 260 | ease-out | – | no | |
| `components.css:1061,1064` `.rotatehint__icon .i` | rotate, **infinite** 2.4 s | 2400 | `--ease-inout` | ✓ `:1077` | **YES: the whole portrait playback** | `player/Player.svelte:843` renders it unconditionally in portrait (MOT-13) |
| `components.css:105,110` `.navbar`, `.navbar__title` | bg, title opacity | 180 | linear | – | no | `backdrop-filter` and hairline switch on in one frame; only the tint fades (MOT-09) |
| `components.css:85-90` + `app.css:91-93` `.topbar--solid` | **nothing** | – | – | – | no | glass pops on; wordmark jumps 34→28 px |
| `app.css:39` `.toast` | opacity + `translate` | 260 | ease-out | ✓ | no | in and out share one curve |
| `app.css:96` `.toast__action` | opacity press | 110 | ease-out | – | no | |
| `home.css:19` hero hot layers | `will-change` only | – | – | – | – | carousel.js paints them |
| `library.css:10,82` `.lib__dim`, `.lib__barsub` | opacity | 180 | linear | – | no | |
| `detail.css:20` `.detail__pills` | bg | 180 | linear | – | no | the glass pops, as on `.navbar` |
| `detail.css:71` `.is-cancelling` | opacity | 260 | ease-out | – | no | |
| `detail.css:85-87` `.detail__series` | press opacity | 110 | linear | – | no | |
| `player.css:17,21,37,58-59,88-89,116,153,166,175` | stage drag settle, video fade, cue lift, fadeables, loading card, portrait ctl, lock dim, Up Next rise | 180/260 | ease-out / linear | ✓ `:141,207` | no | consistent; owned by Player |

### JS / WAAPI / Svelte

| Where | What | Duration | Easing | RM | Idle? | Flag |
|---|---|---|---|---|---|---|
| `App.svelte:117-149` | push / pop / RM fade | 380 / 180 | `EASE.sheet` / linear | ✓ (router sets `dir: 'fade'`) | no | literals |
| `App.svelte:163-171` | `out:leave` for the popped page | 380 / 180 / `ZOOM_CLOSE_MS+120` | `easeSheet` | ✓ | no | literals |
| `App.svelte:246-267` | sheet present / dismiss, scrim | 440 / 300; scrim 300 | `EASE.sheet` / `EASE.in`; scrim linear | ✓ | no | a 300 ms scrim at linear is the longest linear fade in the app |
| `components/Sheet.svelte:56` | drag snap-back | 300 | `EASE.sheet` | – (finger-driven) | no | |
| `lib/gestures.js:10-11,17-23,209-220` | edge-swipe settle | 120–380 | own copy of ease-sheet | own `reduced()` | no | **duplicates** `safe.js` curves and `reducedMotion()` |
| `lib/gestures.js:57` | `navigator.vibrate?.(8)` | – | – | – | – | dead on iOS (no Vibration API) |
| `components/ContextMenu.svelte:52-55,69` | open: backdrop 220 linear, preview + menu 300 `EASE.spring`; close 180 `EASE.in` | 220/300/180 | cubic overshoot | ✓ | no | one bezier overshoot; iOS lifts with a real spring |
| `lib/zoom.js:30-31,416,481,535` | tile→page zoom 460 / 420, backdrop fade 200, content fade 180, under-page `'ease-out'` | 460/420/200/180 | ease-sheet sampled into 24 linear keyframes; **CSS keyword `ease-out`** at :535 | ✓ (router) | no | `ease-out` keyword is the only non-token curve in the app |
| `lib/carousel.js:39,84,184,189` | hero auto-advance, drag release, RM | 700 / 220–560 / 180 | easeInout / easeSheet | ✓ | **every 6 s on idle Home** (by design, `--dur-hero`) | fine; stops when inactive/touching/RM |
| `screens/Home.svelte:608,629,726-732` | `animate:flip` 260 + `out:shrink` 220 on removing a Continue Watching / Next Up tile | 260 / 220 | Svelte default (cubicOut) / linear | **✗** | no | `shrink` animates **width + margin-right** (layout); neither respects RM |
| `App.svelte:219`, `screens/Library.svelte:249`, `components/detail/SeasonPills.svelte:34` | smooth `scrollTo` | UA | UA | ✓ | no | |
| `player/*` | seek flash, track panel, portrait `.vr-sheet` | – | – | – | no | appear/disappear **without motion** (cross-ref Player) |

### Measured

- **Idle:** `document.getAnimations()` filtered to `running`, 2.5 s after settling, found **none** on Home (top and scrolled), Movies (top and bottom), Shows, Search, a Movie detail or the Notifications sheet. The dev library has only 12 movies, so the paging sentinel never mounts there. The rotate hint lives only in the portrait player, where dev playback is blocked; the code proves both cases.
- **Declared transitions:** 103 elements carry `transform 110ms --ease-out` (the press). The rest are 180/260 ms, `linear` or `--ease-out`. Nothing uses the CSS default `ease` and nothing uses a spring.
- **`font` shorthand resets `font-variant-numeric`:** `.ring--lg .ring__label` computes to `normal` (its tabular-nums is lost), and so do `.iconbtn__badge` and `.row__value` (checked with `getComputedStyle`).
- **Haptics:** programmatic iOS haptics (clicking a hidden `<input type=checkbox switch>`'s label from JS) worked on iOS 17.4–26.4. Apple **patched them in iOS 26.5**, but a real tap on a real `<input type="checkbox" switch>` still produces the system haptic ([iOS Haptics Tester](https://rapidtoolset.com/en/tool/ios-haptics-tester); technique: [ios-haptics](https://unpkg.com/ios-haptics@latest/README.md), [azukiazusa](https://azukiazusa.dev/en/blog/ios-safari-web-haptics)).
- **`linear()`:** available since Safari 17.2 ([Chrome docs, compat note](https://developer.chrome.com/docs/css-ui/css-linear-easing-function)). The app targets iOS 17.0+, so 17.0–17.1 need a fallback.
- **`:active` on iOS:** WebKit applies it on touchstart and does not clear it when the touch turns into a scroll ([WebKit bug 138816](https://bugs.webkit.org/show_bug.cgi?id=138816) and related), which is exactly the "list flashes while scrolling" tell.

## Proposed tokens (ready-to-paste CSS)

The springs follow SwiftUI's parameterisation (WWDC23): `duration` = response, `bounce` → damping ratio ζ = 1 − bounce, stiffness = (2π/duration)², mass 1, starting at rest. A `linear()` curve is normalised in time, so **its shape depends only on ζ**; the duration token sets the speed. Durations are the **settle time** (|1 − x| < 0.2 %), not the perceived length: the motion reads as finished at about 55 % of it.

| Token | ζ | = SwiftUI | Settle @ 0.3 s / 0.5 s response | Overshoot |
|---|---|---|---|---|
| `--spring-smooth` | 1.0 | `.smooth` | 410 / 680 ms | 0 |
| `--spring-snappy` | 0.85 | `.snappy` | 390 / 650 ms | 0.6 % |
| `--spring-bouncy` | 0.7 | `.bouncy` | 440 / 730 ms | 4.6 % |

Append to the Motion block of `phone/src/styles/tokens.css`. The fallbacks sit in `:root`, and the `linear()` values replace them inside `@supports`. That way a token is never invalid at computed-value time: an invalid `var()` would silently fall back to `ease`, not to the previous declaration.

```css
  /* ---- Motion v2 (motion-system.md MOT-01) ---- */
  --ease-standard:   cubic-bezier(0.42, 0, 0.58, 1);  /* UIKit's default UIView curve — cross-fades ≥ 200 ms */
  /* Springs (fallbacks for iOS 17.0–17.1, which lack linear(); replaced below) */
  --spring-smooth:   cubic-bezier(0.22, 0.9, 0.3, 1);
  --spring-snappy:   cubic-bezier(0.2, 0.9, 0.25, 1.02);
  --spring-bouncy:   cubic-bezier(0.34, 1.3, 0.64, 1);
  --dur-spring-quick: 420ms;  /* response 0.3 s: press release, switch knob, segment thumb, badge pop */
  --dur-spring:       700ms;  /* response 0.5 s: toast in, context-menu lift, sliding indicators */
  --dur-release:      var(--dur-spring-quick);
  --dur-img:          220ms;  /* image fade-in once decoded */
  --press-dim:        0.14;   /* black veil over pressed artwork */
  --press-scale-sm:   0.9;    /* player transport (was a literal) */
  --press-delay:      70;     /* ms, read by lib/press.js (unitless on purpose) */
}
@supports (transition-timing-function: linear(0, 1)) {
  :root {
    --spring-smooth: linear(0, 0.005 1.3%, 0.02 2.5%, 0.081 5.5%, 0.158 8.3%, 0.462 18.3%, 0.554 21.8%, 0.63 25%, 0.695 28.2%, 0.754 31.8%, 0.806 35.5%, 0.848 39.3%, 0.887 43.8%, 0.92 48.8%, 0.945 54.3%, 0.965 60.5%, 0.988 75.3%, 1);
    --spring-snappy: linear(0, 0.005 1.3%, 0.022 2.8%, 0.055 4.5%, 0.098 6.3%, 0.186 9.3%, 0.51 19.3%, 0.609 22.8%, 0.689 26%, 0.758 29.3%, 0.816 32.5%, 0.863 35.8%, 0.903 39.3%, 0.937 43.3%, 0.965 47.8%, 0.985 52.8%, 0.997 58.3%, 1.006 71.8%, 1);
    --spring-bouncy: linear(0, 0.006 1.3%, 0.028 2.8%, 0.063 4.3%, 0.108 5.8%, 0.218 8.8%, 0.585 17.8%, 0.692 20.8%, 0.776 23.5%, 0.848 26.3%, 0.911 29.3%, 0.959 32.3%, 0.995 35.3%, 1.017 38%, 1.034 41%, 1.046 47.8%, 1.004 76.8%, 1);
  }
}
@media (prefers-reduced-motion: reduce) {
  :root { --spring-snappy: var(--ease-out); --spring-bouncy: var(--ease-out); }   /* no overshoot */
}
```

(The first block goes *inside* the existing `:root { … }` before its closing brace; the `@supports` and `@media` blocks go after it. `--ease-spring` stays for now; MOT-17 retires it.)

**Which class uses which.** Existing tokens keep their jobs (`--ease-sheet` for push/sheet, `--ease-in` for dismissals, `--dur-fast`/`--dur-base` for fades).

| Motion | Token pair |
|---|---|
| Press **in** (scale down / dim on) | `--dur-press` + `--ease-out` |
| Press **release** (scale back / dim off) | `--dur-release` + `--spring-snappy` |
| Row / list highlight off | `--dur-base` + `--ease-out` (on: instant) |
| Switch knob, segmented thumb, tab-bar pill | `--dur-spring-quick` + `--spring-snappy` |
| Badge pop, context-menu lift, toast in | `--dur-spring-quick`/`--dur-spring` + `--spring-bouncy` (badge, lift) / `--spring-smooth` (toast) |
| Image fade-in | `--dur-img` + `--ease-out` |
| Cross-fades ≥ 200 ms (scrims, backdrop fades) | `--ease-standard` |
| Short fades ≤ 180 ms (titles, dims) | `linear`: keep, it's intentional |
| Push, pop, sheet present | unchanged (`--ease-sheet`); a spring variant is the Nav/Sheets auditors' call |

**Generator** (to regenerate or add a spring; node 22): sample x(t) of the damped spring from 0→1 over the settle time, then keep the points with Ramer–Douglas–Peucker at 0.004 tolerance.

```js
// x(t) for ζ<1: 1 + e^(−ζω t)·(−cos(ωd t) − (ζω/ωd)·sin(ωd t)), ω = 2π/response, ωd = ω√(1−ζ²)
// ζ=1: 1 − e^(−ω t)(1 + ω t). Settle = last t with |1−x| ≥ 0.002. Points = RDP(tol 0.004) of 400 samples.
```

## Tasks

### MOT-01 · Add the motion tokens and one JS mirror of them — ✅ done
- **Wave 0:** Also exported: `EASE.standard`, `SPRING` (feature-gated), `springEase.{smooth,snappy,bouncy}` (JS easing functions for Svelte), `spring()` (NAV-02), `easeInout`, `rm()`/`rmOut()` (MOT-13). `router.svelte.js` lost its own `reduced()` copy too.
- **Kind:** craft · **Priority:** P1 · **Effort:** S
- **Files:** `phone/src/styles/tokens.css` (Motion block, line 159–173); `phone/src/lib/safe.js`; `phone/src/lib/gestures.js:10-23`; `phone/src/lib/carousel.js:35-36`; `phone/src/lib/zoom.js:37`
- **Now:** The curves exist three times: CSS `tokens.css:168-172`, `safe.js:29-35` and hard-coded strings in `gestures.js:10-11`. `reducedMotion()` is duplicated as `gestures.js:17-23`, and `carousel.js`/`zoom.js` rebuild `bezier(0.32, 0.72, 0, 1)` themselves. There are no springs.
- **Change:**
  1. Paste the CSS above.
  2. In `safe.js` add:
     ```js
     const LIN = (() => { try { return CSS.supports('transition-timing-function', 'linear(0, 1)'); } catch { return false; } })();
     export const SPRING = {
       smooth: LIN ? 'linear(…smooth…)' : 'cubic-bezier(0.22, 0.9, 0.3, 1)',
       snappy: LIN ? 'linear(…snappy…)' : 'cubic-bezier(0.2, 0.9, 0.25, 1.02)',
       bouncy: LIN ? 'linear(…bouncy…)' : 'cubic-bezier(0.34, 1.3, 0.64, 1)'
     };
     export const DUR = { press: 110, fast: 180, base: 260, push: 380, sheet: 440, sheetOut: 300, ctx: 300, springQuick: 420, spring: 700, img: 220, rm: 180 };
     export const EASE_STANDARD = 'cubic-bezier(0.42, 0, 0.58, 1)'; // also add as EASE.standard
     ```
     Copy the exact `linear()` strings. WAAPI throws a `TypeError` on an unknown easing, which is why `SPRING` is gated.
  3. `gestures.js`: import `EASE`, `reducedMotion` from `./safe.js` and delete the local copies. `carousel.js` and `zoom.js`: import `easeSheet` from `safe.js`.
- **Why:** Every later task (and the other auditors') references one source. Real springs, with correct fallbacks, are the base of "native feel".
- **Constraints & risks:** Pure additions; no TV impact (phone-only files). Keep the old tokens: `--ease-spring` is still used by ContextMenu until MOT-17.
- **Verify:** `npx vite build --config phone/vite.config.js`. In the page, `getComputedStyle(document.documentElement).getPropertyValue('--spring-snappy')` starts with `linear(` in Chrome/Safari ≥ 17.2. In JS, `document.body.animate([{opacity:0},{opacity:1}], {duration: 10, easing: SPRING.snappy})` doesn't throw.
- **Depends on / conflicts with:** none. Everything else depends on it.

### MOT-02 · Replace `:active` with one delayed, scroll-safe press controller — ✅ done
- **Wave 0:** Also in SEL: `.closebtn`, `a.row`; SKIP also skips skeleton tiles (`.tile[aria-hidden="true"]`). Scroll cancels only when the scrolled element contains the pressed one. The dead `navigator.vibrate` in `sheets/Accounts.svelte` went too.
- **Kind:** native · **Priority:** P1 · **Effort:** M
- **Files:** new `phone/src/lib/press.js`; `phone/src/main.js:31-32`; `phone/src/styles/components.css` (every `:active` selector: lines 130, 163, 182, 201, 204, 211, 244, 392, 473, 499, 515, 570, 603, 660, 736, 766, 833, 888, 904, 956); `app.css:97`; `detail.css:32-34,47,87`; `lib/gestures.js:56-58`
- **Now:** `main.js:32` adds an empty `touchstart` listener so iOS applies `:active`. iOS sets it on touch-*start* and leaves it on while the touch becomes a scroll, so scrolling a grid or list lights up whatever the thumb lands on. The web tell is strongest on `.row`, `.episode` and `.tile`.
- **Change:** a delegated controller, one set of listeners on `document`:
  ```js
  // lib/press.js
  const SEL = '.btn,.iconbtn,.avatarbtn,.tabbar__item,.action,.tile,.cast,.pill,.episode,.catcard,button.row,.chip,.option,.ctx__item,.notif,.pbtn,.pchip,.skipchip,.toast__action,.detail__series,.tile__add,.closebtn,.seg__opt,.switch,.search__clear,.search__cancel,.overview__more,.lib__bartitle';
  const SKIP = '[disabled],[aria-disabled="true"],.tile--self,.episode--preview';
  // pointerdown (primary, not mouse right-button): el = e.target.closest(SEL); if !el or el.matches(SKIP) return
  //   t = setTimeout(() => el.classList.add('pressing'), DELAY)          // DELAY = --press-delay (70 ms)
  // pointermove > 8 px from start, pointercancel (iOS fires it when the scroll takes over), scroll (capture):
  //   clearTimeout(t); drop(el, instant=true)
  // pointerup: if not yet pressing → add now and drop after 90 ms (a quick tap still flashes); else drop now
  // drop(el, instant): instant → add 'press-cut' (transition-duration: 0s on el and descendants) for one frame, then remove both classes
  ```
  CSS: rename every `X:active` to `X.pressing`. Keep `.is-pressed` as the *held/static* state: Home holds a tile pressed while it resolves (`screens/Home.svelte:717`), and Svelte rewrites `class` there, so the controller must never touch `is-pressed`. Add `.press-cut, .press-cut * { transition-duration: 0s !important; }`. Delete the `touchstart` no-op in `main.js`, and delete `navigator.vibrate?.(8)` in `gestures.js:56-58` (a no-op on iOS; see Rejected).
  Innermost wins: `closest()` picks `.tile__add` over its `.tile`, as native does. The long-press action keeps working unchanged (it listens on the node).
- **Why:** Native UIKit highlights only once a touch is clearly a tap (UIScrollView delays content touches), and cancels without animation when the scroll starts.
- **Constraints & risks:**
  - Phone-only files.
  - One `pointerdown` per tap and a `setTimeout`: negligible. The `scroll` listener must be passive and capture.
  - Hardware keyboard / Switch Control never produced `:active` on buttons anyway; no regression.
  - Test that the Tile→page zoom (`lib/zoom.js`, capture-phase click) still finds its tile: the tile may still carry `.pressing` while the zoom measures it. Measure `.tile__frame` via `getBoundingClientRect` *after* removing `pressing`, or accept the 4 % size. Check visually.
- **Verify:**
  - CDP `Input.dispatchTouchEvent`: touchStart on a tile, move 30 px within 50 ms, then hold → no `.pressing` at any point.
  - A 60 ms tap → `.pressing` present for about 90 ms after touchEnd.
  - A still hold → `.pressing` at 70 ms.
  - On device, scroll the Movies grid and a Settings list with slow and fast drags: nothing lights up.
- **Depends on / conflicts with:** MOT-01. Visuals in MOT-03. Other auditors adding new press states must use `.pressing`.

### MOT-03 · One pressed look: spring release, dim for artwork, UITableView-style rows — ✅ done
- **Wave 0:** Pressed rules carry a full `transition` shorthand (press-in values), so other properties keep their own timing. Extra looks: `.closebtn`/`.tile__add` scale to `--press-scale-sm`; `.overview__more`, `.search__clear`, `.search__cancel`, `.detail__series`, `.toast__action` dim to 0.55–0.6.
- **Kind:** craft · **Priority:** P1 · **Effort:** S
- **Files:** `phone/src/styles/components.css` (`.iconbtn` 128, `.avatarbtn .avatar` 153/163, `.tabbar__item` 180, `.btn` 199, `.action__icon` 242, `.tile__frame` 384-392, `.cast__photo` 472, `.pill` 496, `.episode` 513, `.catcard` 568, `.row` 599, `.chip` 657, `.option` 734, `.ctx__item` 760-766, `.notif` 832, `.pbtn` 886-888, `.pchip` 893-904, `.skipchip` 953); `detail.css:85-87`; `app.css:96-97`
- **Now:** Press in and out share `110ms --ease-out`, so the release feels as abrupt as the press. `.avatar`, `.pchip` and `.ctx__item` snap (no transition). Artwork scales but doesn't darken (SPEC §1 says "scales **and darkens**"). Rows fade out their grey in 110 ms linear. `.pbtn` uses a literal `0.9`.
- **Change** (pattern: base rule = release, pressed rule = press-in):
  ```css
  .tile__frame, .cast__photo, .catcard, .iconbtn, .btn, .action__icon, .pill, .chip, .pchip, .pbtn, .skipchip, .avatarbtn .avatar {
    transition: transform var(--dur-release) var(--spring-snappy), background-color var(--dur-fast) linear;
  }
  .tile.pressing .tile__frame, .cast.pressing .cast__photo, .catcard.pressing, .iconbtn.pressing, .btn.pressing, .action.pressing .action__icon,
  .pill.pressing, .chip.pressing, .pchip.pressing, .skipchip.pressing, .avatarbtn.pressing .avatar {
    transform: scale(var(--press-scale));
    transition-duration: var(--dur-press); transition-timing-function: var(--ease-out);
  }
  .pbtn.pressing { transform: scale(var(--press-scale-sm)); … }
  /* artwork darkens: an opacity veil, never filter */
  .tile__frame::before, .cast__photo::before, .catcard::before { content: ""; position: absolute; inset: 0; z-index: var(--z-media-ui); border-radius: inherit; background: #000; opacity: 0; pointer-events: none; transition: opacity var(--dur-base) var(--ease-out); }
  .tile.pressing .tile__frame::before, .cast.pressing .cast__photo::before, .catcard.pressing::before { opacity: var(--press-dim); transition-duration: var(--dur-press); }
  /* rows: highlight on at once, fade out like UITableView's deselect */
  .row, .episode, .notif, .option, .ctx__item { transition: background-color var(--dur-base) var(--ease-out); }
  .row.pressing, .episode.pressing, .notif.pressing, .option.pressing, .ctx__item.pressing { transition-duration: 0s; }
  ```
  Keep the existing background colours (`--surface-press` etc.). `.catcard` already has `overflow: hidden`; `.tile__frame::after` stays the hairline. Put the veil under `.tile__badge`/`__corner`/`__add` (they use `--z-media-ui`, so set the veil `z-index: calc(var(--z-media-ui) - 1)`).
- **Why:** A crisp press-in plus a soft spring-out is the single biggest "made with care" cue on iOS. The dim makes the press visible on dark posters, where a 4 % scale alone barely reads.
- **Constraints & risks:**
  - Transform/opacity only.
  - The veil is one small static layer per tile and paints only on press.
  - Reduced motion: MOT-01's `@media` maps `--spring-snappy` to ease-out, so there's no overshoot.
  - `detail.css:47` (`.tile--self`) and `:32-34` must become `.pressing` overrides.
- **Verify:**
  - Screenshots of a pressed tile, row and button (force `.pressing`), next to the current `.is-pressed` look.
  - `getComputedStyle(tileFrame).transitionTimingFunction` starts with `linear(` in the base state.
- **Depends on / conflicts with:** MOT-01, MOT-02.

### MOT-04 · Long-press builds up under the finger, then hands off to the menu's lift → merged into CTX-01 ✅
> Built in `gestures.js` + `components.css` (`.holding` after 150 ms, `--dur-hold` `--ease-in`, doubled class to out-rank `.pressing`; rows light). The preview starts from the source's held size (a FLIP) rather than a fixed .94.
- **Kind:** native · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/lib/gestures.js:31-111` (`longpress`); `phone/src/styles/components.css` (tile/episode/cast); `phone/src/components/ContextMenu.svelte:50-56`
- **Now:** Holding a tile shows the normal 4 % press, then at 500 ms the menu appears (preview scale 1 → 1.03, `EASE.spring` 300 ms). UIKit's context menu instead *shrinks the cell slowly while you hold*, which tells you something is about to happen, and pops it when the menu triggers.
- **Change:** in `longpress`, after 150 ms of stillness add `holding` to the node and remove it on cancel/trigger. CSS:
  ```css
  .tile.holding .tile__frame, .cast.holding .cast__photo { transform: scale(0.92); transition: transform 350ms var(--ease-in); }
  .episode.holding, .row.holding { background: var(--surface-press); }
  ```
  On trigger, ContextMenu's preview starts from 0.92 instead of 1: `prevEl.animate([{transform:'scale(.94)'},{transform:'scale(1.03)'}], {duration: DUR.springQuick, easing: SPRING.bouncy})`. The menu gets `{opacity:0, transform:'scale(.9)'}` → 1 with the same spring. On cancel (finger moved, lifted before 500 ms), the MOT-03 release spring brings it back.
- **Why:** This is the native cue that a long press is in progress. Today a hold looks like a stuck tap until the menu snaps in.
- **Constraints & risks:**
  - The class lives on the node that has `use:longpress` (Tile, EpisodeRow, cast, season pills).
  - Reduced motion: skip the scale, keep the row background.
  - The `holding` transform and `.pressing` both target `.tile__frame`; give `.holding` the higher specificity.
- **Verify:** CDP touch hold on a tile: `.holding` at 150 ms; frame scale ≈ 0.92 at 500 ms; menu open; preview animation starts from 0.94. Hold and move 20 px → no menu, spring back.
- **Depends on / conflicts with:** MOT-01, MOT-02, MOT-03. The ContextMenu choreography itself belongs to the Sheets/menus auditor; this task only changes the start values and curve.

### MOT-05 · Fade posters in once loaded, on a placeholder that matches the skeleton — ✅ done
> Wave 1 · B: Art's lazy `<img>` is `.art__fade` with `use:fadeIn` (`.is-in` on `load`; `.no-fade` + at once when `complete && naturalWidth`). `decode` images (backdrops) don't fade. `.art` is flat `var(--a2, --surface-2)`; the gradient moved to `.art--empty` (no src / broken). Measured: throttled Library shows flat skeleton-toned frames, then fades; a second mount of a detail page had 12/16 images `no-fade` at 80 ms (memory cache, no blink).
- **Kind:** craft · **Priority:** P1 · **Effort:** S
- **Files:** `phone/src/components/Art.svelte`; `phone/src/styles/components.css:251-258` (`.art`); `phone/src/styles/app.css:23`
- **Now:**
  - `Art.svelte:28` sets `src` and the poster pops in whenever the network delivers.
  - The `.art` background is the prototype's radial-gradient "tonal placeholder" (`components.css:253-256`, `#3a3a42` highlight). The skeleton before it is flat `--surface-2` (`components.css:807`).
  - So a tile goes skeleton (flat) → gradient frame → image pop: two visible steps.
- **Change:**
  - Art gets `use:fadeIn` on the lazy `<img>`. On mount, if `img.complete && img.naturalWidth`, add `is-in` at once with no transition. Otherwise add it on `load`.
  - CSS: `.art > img { opacity: 0; transition: opacity var(--dur-img) var(--ease-out); } .art > img.is-in { opacity: 1; }` and `.art > img.no-fade { transition: none; }`.
  - Leave `decode` images (backdrops) **without** the fade: `lib/zoom.js` swaps its overlay for the real hero on the assumption that the hero shows the image at once ("at once if the real hero now shows the same image", `zoom.js:458`). A fading hero under a removed overlay would blink. The slide-push path can get its own backdrop fade later (cross-ref Detail).
  - Placeholder: default `.art` background becomes flat `var(--surface-2)` (same as `.skel`). The gradient moves to `.art--empty`, which Art sets when `missing` (no src or a broken one), so the lettered title-card look stays for real misses.
- **Why:** Native media apps fade artwork in (TV app, Photos). Matching tones makes skeleton → frame → image one continuous change instead of two pops.
- **Constraints & risks:**
  - An in-memory-cached image fires `load` asynchronously, so without the `complete` check a back navigation or remount would blink. That check is mandatory.
  - The zoom clone (`zoom.js:256`) copies `.art` including the `is-in` class. Fine.
  - `img.imgfail` (`app.css:23`) keeps working.
  - Reduced motion: keep the fade; it's opacity only and short.
  - Cost: one listener per image and one opacity transition.
- **Verify:**
  - With CDP `Network.emulateNetworkConditions` (slow 3G), grid posters fade in over flat `#1b1b20`.
  - Scroll away and back (cached) → no fade.
  - Open and close a tile zoom → no blink on the hero.
  - A missing poster still shows the serif label on the gradient.
- **Depends on / conflicts with:** MOT-01. Home's hero is carousel-painted (`.homehero__media > img`, not `.art`) and unaffected.

### MOT-06 · Skeletons: wait, pulse briefly, then rest; fade content in on handoff — ✅ done
- **Wave 2 (agent 3), handoff:** screens use `use:fadeIn` / `use:fadeInRest` (safe.js, WAAPI, same `--dur-fast` linear) instead of the `.fade-in` class: a CSS animation inside a route restarts whenever the route is un-hidden (every pop / tab switch back replayed the fade). Wired: Library (count row + first grid, only if the skeleton was up), Chart (segmented + sections), Person (filmography), SortFilter (genre chips). Home (painted snapshot, carousel fades its own art) and Detail (`lateIn`) already had theirs; Search's browse groups ride its own search-on/off choreography and were left alone. Measured: one 180 ms opacity animation per element on the first grid, none on returning to the tab or popping back, none on a cached Chart reopen.
- **Wave 1 (G):** as proposed, with tokens `--dur-skel-wait` (400 ms) / `--dur-skel-pulse` (1.6 s) and **no fill mode** (base `opacity: 0.7` = the keyframes' ends), so a finished pulse leaves `getAnimations()` — `both` would have kept 3 × N finished animations in it and failed the wave-3 idle check. `.fade-in` is `--dur-fast linear` (the tokens' "short fades ≤ 180 ms stay linear" pair), no fill, `animation: none` under Reduce Motion. Measured (dev server, Home with every rail request held): 11 skeletons, `vr-pulse` iterations 3 / delay 400 / 1600 ms; at +5.1 s still running, at +5.6 s `getAnimations()` empty, opacity 0.7, skeletons still up. Reduce Motion: no animations, static 0.7. Applying `.fade-in` is the screen lanes' job.
- **Kind:** craft · perf · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/styles/components.css:807,816`; `phone/src/styles/app.css:47-50`
- **Now:** `.skel` pulses `0.55 ↔ 1` on a 1.4 s infinite loop from the first frame. A fast load shows one half-pulse (a flicker), and a hung load (offline, slow NAS) pulses forever. iOS itself uses static redacted placeholders.
- **Change:**
  ```css
  .skel { opacity: 0.7; animation: vr-pulse 1.6s var(--ease-inout) 400ms 3 both; }
  @keyframes vr-pulse { 0%, 100% { opacity: 0.7; } 50% { opacity: 1; } }
  .fade-in { animation: vr-fade-in var(--dur-fast) var(--ease-out) both; }
  @keyframes vr-fade-in { from { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .fade-in { animation: none; } }
  ```
  So: static for 400 ms (loads under that never pulse), three breaths, then rest at 0.7. The keyframes start and end on the resting value, so there's no jump. `.fade-in` is the handoff utility screens put on the first real content that replaces a skeleton (Home rails, detail body, Chart grid). Applying it is the screen owners' job (cross-refs).
- **Why:** Restraint. An endless pulse reads as "stuck" after a few seconds, and it's the same rule the TV learned for marquees and download rings (three cycles, then rest).
- **Constraints & risks:** The reduced-motion rule in `app.css:48` stays (`animation: none`, so opacity is 0.7 static).
- **Verify:** On Home with a throttled network, `document.getAnimations()` shows `vr-pulse` with `iterations: 3`. After 400 + 4800 ms, none running while the skeleton is still up.
- **Depends on / conflicts with:** none. Screen auditors use `.fade-in`.

### MOT-07 · Segmented control: a sliding thumb with a spring, and a pressed segment — ✅ done
- **Wave 2 (player, Lane C's request):** checked in the player's portrait track sheet (3 options, 393 px). The thumb sits exactly on each option (22/139/256 px, 115×40) and slides to Quality. In landscape the picker is the two-column glass panel, which has no Segmented, so there's nothing to check there. No change needed.
- **Done** (with LIB-03, SEG-01): `.seg__thumb` placed by `--n`/`--i`, `transform` on `--dur-spring-quick` + `--spring-snappy`; no `ready` class needed — a CSS transition never runs on a first style, so opening a sheet / un-hiding a route paints the thumb in place (measured: 0 animations on open). Pressed option label scales to `--press-scale`; pressing the picked one also squeezes the thumb (`scale`, via `:has(.seg__opt--active.pressing)`); a press a scroll cuts drops the thumb's spring too. Reduce Motion: `transition: none`. Props unchanged.
- **Kind:** native · **Priority:** P2 · **Effort:** M
- **Files:** `phone/src/components/Segmented.svelte`; `phone/src/styles/components.css:637-646`
- **Now:** The selected segment's background and shadow switch in place over 180 ms linear. UISegmentedControl slides one thumb to the new segment, and the touched segment's label shrinks slightly while held.
- **Change:** render one thumb element and position it by index:
  ```svelte
  <div class="seg" role="radiogroup" style="--n: {opts.length}; --i: {Math.max(0, opts.findIndex((o) => o.value === value))}">
    <span class="seg__thumb" aria-hidden="true"></span>
    {#each opts as o (o.value)}<button class="seg__opt {…}">…</button>{/each}
  </div>
  ```
  ```css
  .seg { position: relative; }
  .seg__thumb { position: absolute; top: 2px; bottom: 2px; left: 2px;
    width: calc((100% - 4px - (var(--n) - 1) * 2px) / var(--n));
    transform: translateX(calc(var(--i) * (100% + 2px)));
    border-radius: calc(var(--r-field) - 2px); background: var(--surface-press); box-shadow: 0 1px 4px rgba(0,0,0,.35);
    transition: transform var(--dur-spring-quick) var(--spring-snappy); }
  .seg__opt { position: relative; z-index: 1; }            /* labels above the thumb */
  .seg__opt--active { background: none; box-shadow: none; } /* the thumb draws it */
  .seg__opt.pressing { transform: scale(0.95); transition: transform var(--dur-press) var(--ease-out); }
  ```
  No transition on first render: add the `transition` only after mount (a `ready` class set in `onMount`), or the thumb slides in from 0 on every sheet open.
- **Why:** This is one of the most recognisable iOS control behaviours. It's used in Settings (subtitle mode, streaming quality), the Sort sheet and the player's pickers.
- **Constraints & risks:**
  - Equal-width segments are assumed; `.seg__opt { flex: 1 1 0 }` already guarantees it.
  - Transform only.
  - Reduced motion: `transition: none` on `.seg__thumb`.
  - Keep `role=radio` semantics.
- **Verify:** In Settings → Subtitles, tap Automatic → Always: the thumb glides with a barely visible settle. The screenshot at rest is identical to today. `getAnimations()` is empty 500 ms later.
- **Depends on / conflicts with:** MOT-01, MOT-02 (`.pressing`). The player auditor may restyle its own segmented usage; the component change is shared.

### MOT-08 · Switch: use the native `<input type="checkbox" switch>` for the real haptic; spring the fallback — ✅ done (iPhone check pending)
> `Switch.svelte`: a visible native switch with `accent-color: var(--gold)` where `'switch' in HTMLInputElement.prototype`, wrapped in a 44 pt `.switch-hit` label. Otherwise the drawn switch with SW-01's look. If the gold doesn't take on the device, flip `NATIVE` to false at the top of Switch.svelte. Desktop: the thumb stretches to 34 px while pressed.
- **Kind:** native · **Priority:** P2 · **Effort:** M
- **Files:** `phone/src/components/Switch.svelte`; `phone/src/styles/components.css:620-635`
- **Now:** `Switch.svelte` is a `<button role="switch">` painted with CSS: no haptic, no pressed stretch of the knob, and a 180 ms ease-out knob.
- **Change:**
  - Where `'switch' in HTMLInputElement.prototype` (Safari 17.4+), render `<input type="checkbox" switch role="switch" class="switch-native" bind:checked={on} {disabled} aria-label={label} onchange={…}>` with `.switch-native { accent-color: var(--gold); }`. Enlarge its hit box with a wrapping `<label>` or `::before`-equivalent padding (inputs don't take pseudo-elements; wrap it in a 44 pt `<label>`).
  - Otherwise (desktop dev Chrome, iOS < 17.4) keep the current button, with a native-style motion:
    ```css
    .switch::after { transition: transform var(--dur-spring-quick) var(--spring-snappy), width var(--dur-press) var(--ease-out); }
    .switch.pressing::after { width: calc(var(--switch-h) - 4px + 7px); }                                                  /* knob stretches while held */
    .switch--on.pressing::after { transform: translateX(calc(var(--switch-w) - var(--switch-h) - 7px)); }
    ```
    (A `width` transition on a 27 px absolutely positioned pseudo-element is a layout change of nothing. Same exception class as SPEC §5's status fill.)
- **Why:** A real tap on a native switch still gives the system haptic on iOS 26.5+, where every programmatic haptic trick was patched (see Measured). Settings' five switches are the one place the app can feel native in the hand.
- **Constraints & risks:**
  - **Verify on device**: the native switch's size, its gold via `accent-color`, and that it sits well in `.row` (UX-AUDIT required a 63×45 hit area). If `accent-color` doesn't take on iOS, the fallback look is the design's and only the haptic is lost, so gate on a device check before shipping.
  - `bind:on` semantics and `onchange(next)` must stay.
- **Verify:** On the iPhone, toggle "Skip recaps automatically": a haptic tick, gold track, and the value persists. In desktop Chrome, the fallback knob stretches while the mouse is held.
- **Depends on / conflicts with:** MOT-01, MOT-02. Settings (Home/Settings auditor) only consumes `Switch`.

### MOT-09 · Glass bars fade their blur in, not just their tint → merged into NAV-03 ✅
- **Wave 1 (lane A):** built as NAV-03 with these material values, but **without `isolation: isolate`** (NAV-03's backdrop-root caution; the bars' `z-index` already makes the stacking context `z-index: -1` needs). iPhone check: the `::before` blur samples the page on WebKit, and ramps at partial opacity. `.detail__pills` / `.pills--sticky` is lane D's (DET-07).
- **Kind:** craft · **Priority:** P2 · **Effort:** M
- **Files:** `phone/src/styles/components.css:78-118` (`.topbar`, `.topbar--solid`, `.navbar`, `.navbar--solid`, `.navbar--solid .iconbtn`); `:483-489` (`.pills--sticky`); `detail.css:217-221`; `app.css:91-93`
- **Now:**
  - `.navbar` transitions `background-color` only, while `backdrop-filter` and the hairline `box-shadow` switch on in one frame. The blur pops, then the tint catches up.
  - `.topbar--solid` has no transition at all, and the short mark jumps from 34 to 28 px (`app.css:91-93`).
  - The back button's own glass disappears instantly as the bar turns solid (`:118`).
  - `.detail__pills` has the same pop.
- **Change:** move the material onto a pseudo-layer and fade that layer's opacity:
  ```css
  .topbar, .navbar, .detail__pills { isolation: isolate; }
  .topbar::before, .navbar::before, .detail__pills::before {
    content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
    background: var(--glass-bg-strong); -webkit-backdrop-filter: var(--glass-blur); backdrop-filter: var(--glass-blur);
    box-shadow: inset 0 -1px 0 var(--line);
    opacity: 0; transition: opacity var(--dur-fast) linear;
  }
  .topbar--solid::before, .navbar--solid::before, .pills--sticky::before { opacity: 1; }
  .topbar--solid, .navbar--solid, .pills--sticky { background: none; -webkit-backdrop-filter: none; backdrop-filter: none; box-shadow: none; }
  .navbar .iconbtn { transition: transform var(--dur-release) var(--spring-snappy), background-color var(--dur-fast) linear, box-shadow var(--dur-fast) linear; }
  ```
  For the wordmark, replace the `font-size` change with `transform: scale(0.82); transform-origin: left center;` and a `--dur-fast` `--ease-out` transition.
- **Why:** iOS bars cross-fade their material as content scrolls under them. The one-frame blur pop is one of the more visible web tells, and it happens on every page scroll.
- **Constraints & risks:**
  - A `backdrop-filter` element fading its opacity is fine on WebKit (composited).
  - **Verify on device** that `isolation` + `z-index: -1` keeps the pseudo-layer above the page content but below the bar's buttons, and that the blur shows at partial opacity rather than snapping at 1.
  - `.detail__pills` also pins; keep `position: sticky` on it (the pseudo-layer needs a positioned parent, and sticky is positioned).
- **Verify:** Scroll a movie detail slowly past the backdrop and record a screencast (CDP `Page.startScreencast`, 60 fps): the bar's blur ramps over ~180 ms with no single-frame jump. The same on Home's top bar.
- **Depends on / conflicts with:** MOT-01. The Nav auditor may change the bars' layout. This is material-only, so coordinate on `components.css:78-118`.

### MOT-10 · Numbers that change live stay still (tabular-nums done right) and the bell badge pops — ✅ done
- **Wave 2 (agent 3, + NAV-13):** `font-variant-numeric: tabular-nums` after the `font:` shorthand on `.ring--lg .ring__label`, `.iconbtn__badge`, `.row__value`, `.search__count`, `.notif__time` (components.css), `.lib__barsub` (library.css) and `.dl__status` (offline.css; it has no shorthand); `.btn--status` / `.count` already had it; the `--t-num` comment says so. Measured (CDP, probe elements in the real cascade): all ten read `tabular-nums`. Badge: **WAAPI, not a CSS class** — routes toggle `[hidden]` and un-hiding would replay a CSS animation; TopBar animates the bound badge in an `$effect`: 0 → n springs in (`scale .4`, opacity 0 → 1), an increase that changes the text bumps (`scale .75` → 1), both `DUR.springQuick` + `SPRING.bouncy`, no fill. Never on mount, a decrease, a hidden tab (`checkVisibility()`), or Reduce Motion. Measured with fake unseen news items: pop keyframes on 0 → 1 (scale 0.87 at 90 ms), bump on 1 → 2 → 3, nothing on 3 → 2, nothing with `rm=1`, `getAnimations()` 0 a second later. The numeric roll (optional P3) is not built.
- **Kind:** bug · craft · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/styles/components.css` (`.ring--lg .ring__label` 289, `.iconbtn__badge` 134-141, `.row__value` 609, `.search__count` 559); `library.css:189-193` (`.lib__barsub`); `offline.css:373-378` (`.dl__status`); `home.css:79-80` (`.notif__time`); `phone/src/components/TopBar.svelte:41`
- **Now:**
  - The `font` shorthand resets `font-variant-numeric`, so any rule setting `font:` after the tabular declaration silently drops it. Measured: `.ring--lg .ring__label` is `normal`.
  - The download status line in Downloads (`43% · 120 MB of ~2.1 GB`, updating live) is proportional and jitters.
  - `.iconbtn__badge` and `.row__value` are proportional.
  - The bell count just appears.
- **Change:**
  1. Add `font-variant-numeric: tabular-nums` *after* the `font:` shorthand in each rule listed, and add a one-line comment in `tokens.css` at `--t-num`: "the `font` shorthand resets font-variant-numeric — declare tabular-nums after it".
  2. Badge pop, on increase only. TopBar keeps `let prev = unread` and sets `bump = unread > prev`:
     ```css
     .iconbtn__badge.bump { animation: vr-pop var(--dur-spring-quick) var(--spring-bouncy); }
     @keyframes vr-pop { from { transform: scale(0.4); opacity: 0; } }
     ```
     Re-arm it with `{#key unread}`. Skip it on first mount (a tab root mounting with 3 unseen must not pop). Reduced motion: `animation: none`.
  3. *(Optional, P3)* a numeric roll, like `contentTransition(.numericText())`, in exactly one place: the detail page's download percent (`components/detail/StatusButton.svelte`). Per changed digit, the old digit slides up and out while the new one rises in 8 px (`--dur-base`, `--ease-out`). Wrap each digit in a `display:inline-block` span with a fixed tabular width. Nowhere else: not the Up Next countdown, not the scrubber.
- **Why:** Digits that dance while downloading look cheap. A badge that springs in once is a tiny, native-feeling acknowledgement.
- **Constraints & risks:** The roll must not run on a poll that doesn't change the number (the feed re-assigns only on change, per `activity.svelte.js`).
- **Verify:** `getComputedStyle` of each listed selector → `tabular-nums`. On Downloads while a copy runs, the status line width doesn't wobble (screencast). The badge pops when `landed`/`news` counts increase (simulate by setting `newsState`).
- **Depends on / conflicts with:** MOT-01. `StatusButton` belongs to the Detail auditor (the roll is optional there).

### MOT-11 · Progress primitives: a continuous countdown, eased updates, compositor-only fill
- **Countdown part → merged into PLY-11 (✅, lane E):** the Up Next ring sweeps via a local `player.css` override (`.vr-player .upnext__ring .ring__value`, 1 s linear), so the `tick` prop isn't needed for it. The generic ProgressRing/ProgressBar changes here are still open.
- **Kind:** craft · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/components/ProgressRing.svelte`; `ProgressBar.svelte`; `components.css:272-286`; `phone/src/player/UpNextCard.svelte:37` (one prop)
- **Now:**
  - `.ring__value` eases every change over 260 ms linear. The Up Next countdown updates once a second, so its ring moves for 260 ms then stands for 740 ms (stepped).
  - `.progress__fill` has no transition, so a download bar in Downloads (`screens/Downloads.svelte:139`) jumps on each update, and it animates `width`.
- **Change:**
  - ProgressRing takes a `tick` prop (ms): `style="--ring-t: {tick}ms"`, with `.ring__value { transition: stroke-dashoffset var(--ring-t, var(--dur-base)) var(--ring-ease, var(--ease-out)); }`. UpNextCard passes `tick={1000}` and `--ring-ease: linear`, so the ring sweeps continuously.
  - ProgressBar takes `live`: `.progress--live .progress__fill { width: 100%; transform: scaleX(var(--p)); transform-origin: left; transition: transform var(--dur-base) var(--ease-out); }`. Downloads uses `live`. Resume bars (static) stay as they are.
- **Why:** A countdown ring that ticks is a web tell; UIKit timers sweep. Live progress should glide, not step.
- **Constraints & risks:**
  - At 3 px height the fill's rounded end squashes slightly under `scaleX` at small p. That's invisible, but check it.
  - Reduced motion: `components.css:1078` already zeroes `.ring__value`. Extend it to `.progress--live .progress__fill`.
  - Pausing leaves the last second's sweep finishing; that's acceptable.
- **Verify:** In the player at the credits (trailer in dev, `allowplay=1`), sample the ring's `stroke-dashoffset` every 100 ms: monotonic, no plateaus. Downloads bar: `getAnimations()` shows a transform transition per update.
- **Depends on / conflicts with:** MOT-01. The UpNextCard edit is one prop; tell the Player auditor.

### MOT-12 · Stop the two animations that can run while nothing happens — ✅ done
- **Wave 2 (agent 3):** the rotate hint's rest pose (−90°) is now its base style and the fill is `backwards` only (upright during the delay), so the finished animation leaves `document.getAnimations()` instead of holding its end frame for the whole film. Measured in a portrait trailer: running at 1.0/1.3/2.8 s, 0 animations at 5.3 s with `matrix(0,-1,1,0)`; the whole page's `getAnimations()` empty after 9 s.
- **Wave 0:** Rotate hint: `1.2s … 600ms 3 alternate both` over `0%,25% 0deg → 75%,100% −90deg` (turns, turns back, turns; rests at −90°, the reduced-motion pose), not the two-loop proposal, which would have snapped back to 0° between loops.
- **Kind:** perf · **Priority:** P1 · **Effort:** S
- **Files:** `phone/src/styles/components.css:1061,1064`; `phone/src/player/Player.svelte:843-846`; `phone/src/screens/Library.svelte:642`
- **Now:**
  - `.rotatehint__icon .i` loops forever (2.4 s). The hint is rendered unconditionally in the **portrait player**, so a film watched in portrait keeps an animation (and the display pipeline) running for its whole length. On ProMotion that also stops iOS from dropping the refresh rate.
  - Library's paging sentinel always contains a spinning `.spinner` while `items.length < total`, including while it sits far below the viewport.
- **Change:**
  - Rotate hint: `animation: vr-rotate 2.4s var(--ease-inout) 600ms 2 both;` (two demonstrations, then rest). Rest on the rotated pose so the still frame explains itself: end keyframe `100% { transform: rotate(-90deg) }`, and make the loop's last segment hold instead of returning.
  - Sentinel: show the spinner only while a page is actually in flight (`{#if more}<span class="spinner"></span>{/if}`, `more` being the existing flag at `Library.svelte:639`). Otherwise the sentinel is an empty 64 px block.
  - General rule for new code (add it as a comment at `.spinner`): an infinite animation must be `[hidden]`/unmounted when idle. The TV learned the same lesson (CLAUDE.md, `#play-loading`, `.dlring`).
- **Why:** An idle app must cost nothing. These are the only two infinite animations that can outlive their purpose.
- **Constraints & risks:** The `Library.svelte` change is the Library auditor's file and `Player.svelte` is the Player's. Both are one-liners; coordinate.
- **Verify:**
  - Portrait player (trailer, dev): `document.getAnimations().filter(a => a.playState === 'running')` is empty 6 s after the controls hide.
  - Library with more than 126 titles (the real account on the NAS build): no running animation while scrolled to the top.
- **Depends on / conflicts with:** none.

### MOT-13 · Reduced motion: close the remaining gaps with one helper — ✅ done
- **Wave 0:** Home: `animate:flip={{ duration: rm(DUR.base) }}`; `shrink` defaults to `rmOut(220)` (import in the `<script module>`). Its width animation is kept; that is lane B's call.
- **Kind:** bug · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/lib/safe.js`; `phone/src/screens/Home.svelte:608,629,726-732`; `phone/src/lib/zoom.js:535`
- **Now:**
  - Svelte transitions ignore `prefers-reduced-motion`. Home's `animate:flip` (260 ms) and `out:shrink` (220 ms) run in full under Reduce Motion.
  - `shrink` animates `width` and `margin-right`, which are layout properties, per frame, while `flip` measures.
  - `zoom.js:535` uses the bare CSS keyword `'ease-out'`, the only off-token curve in the app.
- **Change:**
  - `safe.js`: `export const rm = (ms) => (reducedMotion() ? 0 : ms);` for Svelte params (`animate:flip={{ duration: rm(260), easing: springEase }}`). Note the App.svelte rule "never `duration: 0` in a keyed-each outro group" (`App.svelte:157-162`): for outros use `Math.max(1, rm(ms))`.
  - Home: `out:shrink={{ duration: Math.max(1, rm(220)) }}`. Recommend that shrink collapse by `transform: scale` + opacity, with only the final width snap, *or* keep width and accept it. It's one tile, once, and the Home auditor decides.
  - `zoom.js:535`: `easing: EASE.out`.
- **Why:** Reduce Motion users get today's full choreography in exactly the places Svelte handles the motion.
- **Constraints & risks:** Home and zoom belong to their auditors; `safe.js` is foundation (this area).
- **Verify:** CDP `Emulation.setEmulatedMedia` reduce → remove a Continue Watching tile (stub the hide; `homehide.js` is local-only, so no server mutation) → no running animation longer than 1 ms.
- **Depends on / conflicts with:** MOT-01.

### MOT-14 · No text selection, image callouts or loupe on app chrome → merged into PWA-03
- **Kind:** native · **Priority:** P1 · **Effort:** S
- **Files:** `phone/src/styles/components.css:10-19` (base) or `app.css`
- **Now:** Only buttons, tiles, episodes, cast and the player opt out of selection (`components.css:30,378`, `.no-callout`). Long-pressing a detail title, an overview, a rail heading or a backdrop starts iOS text selection with the loupe, or the image "Save to Photos / Copy" callout. Native apps never do that on labels.
- **Change:**
  ```css
  body { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
  input, textarea, [contenteditable], .selectable { -webkit-user-select: text; user-select: text; -webkit-touch-callout: default; }
  img { -webkit-user-drag: none; }
  ```
  Decide on `.selectable` per screen: probably none. The server address on Login might want it.
- **Why:** One of the most common "this is a web page" giveaways on iOS.
- **Constraints & risks:**
  - VoiceOver text reading is unaffected.
  - Check that the search field and Login inputs still place a caret and select.
  - Possible overlap with the PWA-shell auditor, who may also list this; one of the two implements it.
- **Verify:** On device, long-press a movie title, its overview and a backdrop: nothing happens (and on tiles the context menu still opens). In the search field, double-tap selects a word.
- **Depends on / conflicts with:** PWA-shell auditor (same fix, implement once).

### MOT-15 · Show iOS's scroll indicator on vertical pages — → merged into PWA-10 (✅ done, lane G)
- **Kind:** native · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/styles/components.css:55-63` (`.screen`), `:705` (`.sheet__body`); `app.css:30`
- **Now:** Every scroller hides its indicator (`scrollbar-width: none` + `::-webkit-scrollbar { display: none }`). iOS Safari honours this, so a 126-poster grid or a long Settings sheet scrolls with no sense of position. UIKit shows a thin indicator while scrolling vertical content.
- **Change:** remove the two hiding rules from `.screen` and `.sheet__body` only. Keep them on horizontal rails, pills and chips (native rails hide theirs too). `color-scheme: dark` (`tokens.css:31`) already makes the overlay indicator light.
- **Why:** Position feedback in long lists; one more native cue.
- **Constraints & risks:** **Verify on device**: the overlay indicator must not take layout width (iOS indicators are overlay) and must respect the safe area. In desktop dev Chrome a classic scrollbar may appear; either accept that (dev only) or scope with `@media (pointer: coarse)`.
- **Verify:** On device, scrolling Movies shows a thin light indicator on the right that fades after scrolling stops. Rails show none.
- **Depends on / conflicts with:** none.

### MOT-16 · Icon strokes keep one visual weight at every size (SF-Symbols-like)
- **Kind:** craft · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/styles/components.css:42-50` (`.i`), plus the ad-hoc overrides at `:150` (2.2), `:301` (2.4), `:315` (2.6), `:406` (2.2), and 18-px icons at `:605`, `:902`, `:955`, `:1032`
- **Now:** Every icon uses `stroke-width: 1.75` in a 24-unit viewBox, so the rendered line gets thinner as the icon shrinks: 1.75 px at 24, 1.46 px at 20, 1.17 px at 16. A handful of places patch this by hand with different values.
- **Change:**
  ```css
  .i--sm { stroke-width: 1.95; }  /* ≈ 1.6 px at 20 */
  .i--xs { stroke-width: 2.2; }   /* ≈ 1.45 px at 16 */
  .row__icon .i, .pchip .i, .skipchip .i, .lockpill__icon .i { stroke-width: 2.1; }  /* 18 px */
  ```
  Then delete the per-component overrides that these values now cover (keep the heavier ticks/badges: 11–13 px glyphs *should* read bolder, as SF does).
- **Why:** Mixed line weights next to each other (a 20 px chevron beside a 24 px icon) are subtle, but they are the kind of detail that separates "assembled" from "designed".
- **Constraints & risks:** Visual only; compare screenshots of Settings rows, the player chips and the sheet close button before and after.
- **Verify:** Headless screenshots at 3×: line thickness in pixels within ±0.15 px across sizes.
- **Depends on / conflicts with:** none.

### MOT-17 · Materials and one brand moment: specular glass edge, a warm Play button, a single gold sheen
- **Kind:** craft · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/styles/tokens.css` (glass block 62-67), `components.css` (`.tabbar` 173, `.iconbtn` 127, `.btn--primary` 203, `.wordmark__accent` 73), `phone/src/components/TopBar.svelte`, `ContextMenu.svelte:52`
- **Now:** Glass capsules use a uniform 1 px inset line. The gold primary button is a flat fill. The brand mark is static. `--ease-spring` (a cubic overshoot) drives the context-menu lift.
- **Change** (pick all or some; each is tiny and static):
  1. Specular edge (iOS 26's glass catches light at the top): `--glass-edge: inset 0 1px 0 rgba(255,255,255,.16), inset 0 0 0 1px var(--glass-line);` used by `.tabbar`, `.iconbtn`, `.toast`, `.banner`, `.upnext`, `.pcard`, `.lockpill` in place of the plain inset line.
  2. Play button warmth: `.btn--primary { box-shadow: inset 0 1px 0 rgba(255,255,255,.28), 0 8px 24px -10px rgba(230,180,80,.55); }`. The glow sits under the button, subtle, and doesn't animate.
  3. Gold sheen, once per cold launch: the TopBar's italic gold "R" gets `background: linear-gradient(100deg, var(--gold) 40%, #fff3d0 50%, var(--gold) 60%) 200% 0 / 300% 100%; -webkit-background-clip: text; color: transparent;`. One run of `@keyframes vr-sheen { to { background-position: -100% 0 } }`, 1.1 s `--ease-inout`, 800 ms after `R.booted`, gated by a module-level flag (not storage) so it happens once per launch. Not under reduced motion. A two-letter element, so the per-frame paint cost is negligible.
  4. `ContextMenu.svelte:52`: `{ duration: DUR.springQuick, easing: SPRING.bouncy }`. Then delete `--ease-spring` / `EASE.spring`.
- **Why:** These are the "made with love" touches. Each is invisible until you compare it side by side, and none runs after the first second.
- **Constraints & risks:**
  - Keep contrast (UX-AUDIT): the wordmark shadow at `app.css:85` must still apply. `background-clip: text` + `text-shadow` can clash, so put the sheen on an overlaid `::after` copy if the shadow disappears.
  - Items 1–2 are static CSS.
  - Item 3 must end with `color: var(--gold)` restored (animation `forwards` to a solid-gold background).
- **Verify:** Screenshot comparisons (tab bar, Play button) at 3×. Cold launch → one sheen, then `getAnimations()` is empty. Reduced motion → none.
- **Depends on / conflicts with:** MOT-01. The Home auditor may have their own hero/wordmark ideas; one brand moment is enough, so coordinate.

### MOT-18 · Unify focus rings (hardware keyboard, Full Keyboard Access, Switch Control)
- **Kind:** craft · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/styles/app.css:14-15`; `components.css:1069-1075`
- **Now:** Two different rings. `app.css:15` draws `.tile/.row/.btn` with `--gold-line` (50 % alpha), while `components.css:1069-1075` draws everything else in solid `--gold`. A tile's ring wraps the whole cell (art plus caption), not the artwork.
- **Change:** one token `--focus-ring: 2px solid var(--gold)` with offset 2px everywhere. `.tile:focus-visible { outline: none } .tile:focus-visible .tile__frame { outline: var(--focus-ring); outline-offset: 2px; }` (Safari's outline follows `border-radius`). Same for `.cast` → `.cast__photo`.
- **Why:** Consistency for keyboard and Switch Control users. iOS's own focus ring hugs the artwork.
- **Constraints & risks:** Touch never shows it (`:focus-visible`).
- **Verify:** CDP `Input.dispatchKeyEvent` Tab through Home: every stop shows the same ring, and on tiles it hugs the frame.
- **Depends on / conflicts with:** none.

### MOT-19 · Migrate the literal durations and easings to tokens — ✅ done
- **Wave 3:** by the sweep most rows below were already on tokens (the lanes applied their own). What was left: `zoom.js` open/close → new `DUR.zoom`/`DUR.zoomOut` (460/420, JS-only like `sheetOut`), its backdrop fade 200 → `DUR.img` (220) and content fade 180 → `DUR.fast`; `carousel.js` RM 180 → `DUR.rm` (×2) and the auto-advance glide 700 → `DUR.spring`; Home's hero timer 6000 → new `DUR.hero` (mirrors `--dur-hero`); App's and Player's hand-made `bezier(…)` copies → new `easeDismiss` / the existing `easeOut`. Dead tokens removed: `--ease-spring`/`EASE.spring` and `--dur-ctx`/`DUR.ctx` (CTX-01 lifts on `SPRING.bouncy`/`DUR.springQuick`). The player's `--vr-ctl-in/out` stay local vars — they already alias `--dur-fast`/`--dur-spring-quick`. What remains literal, and why: `polish/README.md` → "Wave 3 sweep".
- **Kind:** craft · **Priority:** P2 · **Effort:** M
- **Files / replacements** (JS uses `DUR`/`EASE`/`SPRING` from `safe.js`, CSS uses the vars):

| File:line | Now | → |
|---|---|---|
| `App.svelte:117,170` | `380`, `easeSheet` | `DUR.push`, `EASE.sheet` / `easeSheet` |
| `App.svelte:148,169,247` | `180` | `DUR.rm` |
| `App.svelte:251` | `440` | `DUR.sheet` |
| `App.svelte:254,267` | scrim `300 'linear'` | `DUR.sheetOut`, `EASE.standard` |
| `App.svelte:265` | `rm ? 180 : 300` | `rm ? DUR.rm : DUR.sheetOut` |
| `components/Sheet.svelte:56` | `300`, `EASE.sheet` | `DUR.sheetOut`, `EASE.sheet` |
| `components/ContextMenu.svelte:52` | `300`, `EASE.spring` | MOT-17 item 4 |
| `components/ContextMenu.svelte:53` | `220 'linear'` | `DUR.base`, `EASE.standard` |
| `components/ContextMenu.svelte:69` | `180`, `EASE.in` | `DUR.fast`, `EASE.in` |
| `lib/gestures.js:209` | `380`, `EASE_SHEET` | `DUR.push`, `EASE.sheet` (MOT-01 removes the copies) |
| `lib/zoom.js:416,481` | `200`/`180 'linear'` | `DUR.img`/`DUR.fast`, keep linear (fades ≤ 200 over moving art) |
| `lib/zoom.js:535` | `'ease-out'` | `EASE.out` (MOT-13) |
| `lib/carousel.js:84,184` | `180` | `DUR.rm` |
| `screens/Home.svelte:608,629` | flip `260` | `DUR.base` (MOT-13) |
| `styles/components.css:888` | `scale(0.9)` | `var(--press-scale-sm)` |
| `styles/components.css:338` | `0.9s` spinner | keep (a rotation period, not a transition) |
| `styles/player.css` | already tokens | – |

- **Why:** One place to tune. The spring tokens only pay off if the code actually uses them.
- **Constraints & risks:**
  - Pure refactor with the same values (except where noted), so there should be no visible change.
  - The files belong to several auditors. Do it as one mechanical pass after their changes land, or have each owner apply their rows.
- **Verify:** `grep -rnE "duration: [0-9]{3}|'linear'|'ease-out'" phone/src` returns only the documented exceptions. Both builds pass.
- **Depends on / conflicts with:** MOT-01, MOT-13, MOT-17.

## Considered and rejected

- **A programmatic `haptic()` helper** (hidden `<input switch>` + `label.click()`). It worked on iOS 17.4–26.4, and **Apple patched it in iOS 26.5**. The user's phone is on iOS 26 (index.html cites WebKit 301108 on iOS 26), so it's dead or dying on the target and is exactly the kind of hack that silently breaks. Only real taps on a real native switch still buzz, hence MOT-08. `navigator.vibrate` doesn't exist on iOS, so the call in `gestures.js:57` is removed (MOT-02). No haptics for long-press triggers, pull thresholds or removal; iOS web can't do them.
- **Shimmer skeletons** (moving gradient sweep). Not an iOS idiom; Apple uses static redacted placeholders. It also costs a paint per frame on every skeleton. MOT-06 does a delayed, finite pulse instead.
- **Numeric roll on every changing number** (countdown, scrubber times, download % in tiles). Too busy; at most one place (MOT-10, optional).
- **JS-driven springs (rAF physics) for presses, toggles and toasts.** CSS `linear()` gives the same curve on the compositor with no main-thread work. Keep rAF for finger-driven motion only (carousel, edge swipe, sheet drag), where it already is.
- **Animating `filter: brightness()` for the pressed dim.** A filter change on a large image layer can repaint in WebKit; an opacity veil is compositor-only (MOT-03).
- **Scroll-driven animations (`animation-timeline: scroll()`) for bar solidify.** WebKit only has them since Safari 26; the app supports iOS 17+. `scrollPast` + a class plus MOT-09's fade is enough.
- **Parallax or gyroscope tilt on posters, confetti, animated gradients behind the Play button, a "breathing" gold glow.** Overload, and each is an always-on cost. The single sheen in MOT-17 is the one brand flourish.
- **A global `@media (prefers-reduced-motion) { * { transition: none !important } }` safety net.** It would also kill state feedback that Reduce Motion keeps on iOS (highlights, fades) and fight the handled cases. Keep it targeted (MOT-13).
- **Changing push/pop and sheet timing to springs here.** `--ease-sheet` at 380/440 ms is already an iOS-like curve, and those choreographies belong to the Navigation and Sheets auditors. The tokens are ready if they want `--spring-smooth` at 0.45 s response.

## Cross-refs

- **Navigation / transitions:**
  - TabBar selection should *slide* between items like iOS 26's tab bar: one `.tabbar__pill` translated by index, `--dur-spring-quick` + `--spring-snappy`, the same technique as MOT-07. Today `components.css:180,183` cross-fades the `--gold-soft` fill.
  - A push could use `--spring-smooth` (0.45 s response ≈ 610 ms settle) instead of `--ease-sheet` 380 ms, for interruptible feel. Their call.
  - Pinch-zooming the whole app is possible: nothing sets `touch-action: pan-x pan-y` on `html` and the viewport allows scaling. That's a web tell (PWA-shell auditor too).
- **Home:**
  - Put `.fade-in` (MOT-06) on the rails' first real content.
  - `out:shrink` animates width (MOT-13).
  - The hero auto-advance (700 ms every 6 s) is the only periodic idle motion; keep it, but it must also stop while a sheet or context menu is up (it does: `Home.svelte:349`).
- **Library / Search / Chart:** MOT-12's sentinel change is in `Library.svelte:642`. Chart and Search grids should put `.fade-in` on the first page after skeletons.
- **Detail:**
  - A slide-push (not zoom) detail backdrop still pops in after decode. A `--dur-img` fade on the hero `<img>` is safe *only* when `lib/zoom.js` isn't running on that route (check `.route.zoom-hide`); see MOT-05.
  - The StatusButton digit roll is optional (MOT-10).
- **Player:**
  - `.seekflash`, the landscape `.panel` and the portrait `.vr-sheet` appear and disappear with no motion. Suggested: seek flash fades in 110 ms, out 260 ms `--ease-out`, with the chevrons nudging 6 px; the panel slides 24 px + fades with `--spring-smooth`.
  - UpNextCard `tick={1000}` (MOT-11) and rotate hint (MOT-12) are one-liners in their files.
- **Sheets / menus / toasts / settings:**
  - Toast in: `--spring-smooth` at `--dur-spring`; out: `--ease-in` 200 ms (today one 260 ms ease-out both ways, `app.css:39`). A message swap while shown should cross-fade the text.
  - The context menu's close could shrink the preview back toward the tile (scale 1.03 → 1) rather than only fading.
  - Settings switches come from MOT-08, segmented from MOT-07.
- **PWA shell:** MOT-14 (selection/callouts) and MOT-15 (scroll indicators) touch global CSS; implement once. The status bar is opaque black (ARCHITECTURE), so no motion under it.
