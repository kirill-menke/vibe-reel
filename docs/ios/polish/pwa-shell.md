# PWA shell & platform — polish and native-feel tasks

Audit 2026-09-30 (pwa-shell). Sources: code read, a scratch build, the LAN origin's headers
(read-only), headless Chrome over CDP at 393×852 (selectable text, slow-boot and offline-start
frames), and WebKit/Safari docs for what iOS allows.

Summary. Most of the base is right: a fixed app shell where each page scrolls on its own (no
page-wide rubber band), the opaque status bar that works around WebKit 301108, Dynamic Type via
`-apple-system-body` with a clamp, inputs of 16 px or more, `color-scheme: dark`, no tap
highlight, working `:active`, a cache-first shell that starts offline, push permission asked
inside the tap, and background/PiP handling. What still gives the web page away:
**(1)** there are no `apple-touch-startup-image`s, so launch shows a white (or stale) screen,
then a blank dark frame for the whole session check; **(2)** long-press selects text or opens
Safari's image menu almost everywhere except tiles, and a pinch zooms the whole app;
**(3)** navigation state is lost when iOS kills the app, and a service-worker update reloads the
page seconds after the user comes back and starts tapping; **(4)** a cold start with no network
shows nothing, even though the images are HTTP-cached.

## Wave 1 status (lane G) and what needs the iPhone

Done: PWA-01, 06, 08, 10 (+ MOT-15), 17, and MOT-06 (motion-system.md). Wave 2: PWA-02, 05 ✅.
Merged: PWA-07 → HOME-03, PWA-09 → MOT-08. Later round: PWA-11–16.

**📱 Only the iPhone can confirm** (batch these into the post-deploy session):
1. **PWA-01 launch screens** — remove the app from the Home Screen, re-add it, swipe it away,
   cold-launch while screen-recording: dark from the icon on, no white frame. Rotate to landscape
   and cold-launch once more.
2. **PWA-06 update while hidden** — deploy, open the app and keep browsing (no reload, even after
   the new SW activates), go to the Home Screen and back (new build, same page and scroll — PWA-05).
3. **PWA-08 icon badge** — with notifications allowed: Settings → send a test push with the app in
   the background (badge 1), open the app (true count), open the bell (badge gone).
4. **PWA-05 restore after eviction** — open a series (Shows tab) and scroll, open a movie in the
   Movies tab, then open several heavy apps until VibeReel is evicted (the relaunch shows no
   white/dark frame and is instant only if it wasn't): same tab, same page, same scroll, the other
   tab's page there on first tap. Then swipe the app away in the switcher and relaunch → Home.
   **If the swipe-away relaunch lands on the old page instead**, iOS fires no `pagehide` on
   swipe-away (check `reel.route.closed` in Web Inspector); if a plain trip home and back
   (no eviction) ever sets `reel.route.hidePagehide`, iOS fires `pagehide` on backgrounding and the
   30-min fallback is in force.
5. **PWA-10 scroll indicator** — Library and a long sheet show the thin light indicator that fades;
   rails don't; check it over the Home hero and under the tab bar.

## Tasks

### PWA-01 · Ship dark launch screens for every iPhone and paint the first frame dark — ✅ done
- **Wave 1 (G):** `phone/make-icons.sh splash` draws 22 plain `#0a0a0c` PNGs (11 sizes × 2 orientations, 217–556 B each) into `phone/public/splash/` and rewrites the `<link>` block between `<!-- splash:begin/end -->` in `index.html` from the same table (idempotent). Inline `<style>html,body{background:#0a0a0c}</style>` right after the viewport meta. **Not precached** (hashed into the SW version only). Checked in headless Chrome: for every row, portrait and landscape (screen = portrait device size, viewport rotated), exactly one link matches and it is the right image; 393×852@2 and 360×800@3 match none. The 2026 line-up (iPhone 18 / 17e) could not be checked from here — add a row if a new size shipped. **📱 iPhone check:** remove + re-add the app, screen-record a cold launch: no white frame.
- **Kind:** native · **Priority:** P1 · **Effort:** M
- **Files:** `phone/index.html` (head), `phone/make-icons.sh` (generator), new `phone/public/splash/*.png`, `phone/vite.config.js` (`swPrecache`: optionally skip `/splash/`)
- **Now:** `index.html:1-29` has no `apple-touch-startup-image`. iOS ignores the manifest's `background_color` for launch ([firt.dev](https://firt.dev/notes/pwa-ios/): "Still the only way to define splash screens"). Without these links the launch animation shows a white screen, or on some versions a screenshot of the last session. Either one is followed by the dark app. The page also has no inline background: the first dark frame depends on the external stylesheet (served from the SW cache today, but not on a first uncached load).
- **Change:**
  1. In `make-icons.sh`, generate **plain `#0a0a0c`** PNGs, one per device and orientation. Put no logo on them: the first app frame is the dark Home skeleton (see PWA-02), and a plain frame hands over to it without a jump. HIG: a launch screen should look like the empty first screen, not a splash. `magick -size ${W}x${H} xc:'#0a0a0c' -strip splash/${W}x${H}.png` gives files of a few hundred bytes each.
  2. Add one `<link>` per image. Sizes for iOS 17+ iPhones (CSS px @ DPR → portrait image):

     | device-width × height | DPR | image | models |
     |---|---|---|---|
     | 440×956 | 3 | 1320×2868 | 16 Pro Max, 17 Pro Max |
     | 402×874 | 3 | 1206×2622 | 16 Pro, 17, 17 Pro |
     | 420×912 | 3 | 1260×2736 | iPhone Air |
     | 430×932 | 3 | 1290×2796 | 14 Pro Max, 15 Plus/Pro Max, 16 Plus |
     | 393×852 | 3 | 1179×2556 | 14 Pro, 15, 15 Pro, 16 |
     | 428×926 | 3 | 1284×2778 | 12/13 Pro Max, 14 Plus |
     | 390×844 | 3 | 1170×2532 | 12, 13, 14, 16e |
     | 375×812 | 3 | 1125×2436 | XS, 11 Pro, 12/13 mini |
     | 414×896 | 3 | 1242×2688 | XS Max, 11 Pro Max |
     | 414×896 | 2 | 828×1792 | XR, 11 |
     | 375×667 | 2 | 750×1334 | SE 2/3 |

     ```html
     <link rel="apple-touch-startup-image" href="/splash/1179x2556.png"
       media="screen and (device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)">
     <link rel="apple-touch-startup-image" href="/splash/2556x1179.png"
       media="screen and (device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)">
     ```
     Landscape images are the rotated size. Generate the link block from the same table in the script, so the two can't drift. Check any model released since (the 2026 line-up) against its screen spec and add a row.
  3. Put an inline `<style>html,body{background:#0a0a0c}</style>` in `<head>` before anything else, so even an uncached first paint is dark.
- **Why:** a native app's launch fades from its icon into its own background colour. A white flash, or yesterday's screenshot followed by a reload, is the most visible "this is a website" moment.
- **Constraints & risks:** the media query must match the device exactly, otherwise iOS falls back to white. iOS may read these links only when the app is added to the Home Screen, like the status-bar tag, so test with a fresh remove + re-add. Phone-only files; TV untouched. With PWA-17 in place, exclude `/splash/` from `PRECACHE` if you want to keep SW installs lean (the files are tiny either way).
- **Verify:** built `index.html` has 22 links whose `href`s all exist in `dist/splash/`. **iPhone only:** screen-record a cold launch (swipe the app away first) before and after; there should be no white frame.
- **Depends on / conflicts with:** pairs with PWA-02 (dark launch → dark skeleton, no blank gap). PWA-15 edits the same script.

### PWA-02 · Mount the tab stacks while the session check is still running — ✅ done
- **Wave 2:** `App.svelte`: `shell = R.booted || (token && userId && R.modal !== 'login')` gates the stage, the tab bar, the edge swipe, the VoiceOver landing effect and the Toast's tab-bar offset; `R.booted` still gates the polls, freshness and notification-tap routing. A boot 401/403 now also `forgetRoute()` + `resetStacks()` before `openLogin()` (the shell unmounts under Login, so whoever signs in starts on Home). Measured (dev server, headless Chrome 393×852, `/jf/Users/<id>` held 2.5 s via `Fetch`): before, the first `.route`/`.tabbar` existed at **2693 / 2706 ms** and the 600/1500 ms frames were empty `#0a0a0c`; after, **197–607 ms** (the high one is the dev server's first module transform) with Home painted from its snapshot. A 401 on `/Users/<id>` → Login at ~500 ms, 0 routes and no tab bar left mounted.
- **Kind:** perf / native · **Priority:** P1 · **Effort:** S
- **Files:** `phone/src/App.svelte` (boot `onMount` 68-92, `{#if R.booted}` at 278 and 299), `phone/src/lib/router.svelte.js` (`markBooted`, `sync`)
- **Now:** with a stored token, nothing mounts until `GET /Users/{id}` answers (`App.svelte:78`). Only then does Home start its own requests, so the two round trips run one after the other. Measured with `/Users/{id}` delayed by 2.5 s: frames at 0.6 s and 1.5 s are empty `#0a0a0c` with no top bar and no tab bar; Home's skeleton appears only at 2.6 s. Over Tailscale on a weak cellular link that gap is seconds long. The TV solved the same problem long ago: Home mounts behind the splash and a good token only flips `S.screen`.
- **Change:** when `cfg.token && cfg.userId`, mount the stage and the TabBar at once (e.g. `const shell = $derived(R.booted || (!!cfg.token && !!cfg.userId && R.modal !== 'login'))`), and keep `R.booted` for what it gates today: polling (`browsing`), freshness, the edge swipe, and push routing. A 401 still goes through the existing path (App's own check → `openLogin()`; `onAuthLost` already ignores `S.screen === 'boot'`). A network error already calls `markBooted()`.
- **Why:** native apps show their chrome in the first frame and fill it in. A blank frame between launch and UI reads as "loading a website".
- **Constraints & risks:** check every screen for reads of `S.screen === 'home'` or `R.booted` that assumed boot had finished (grep them). Home's requests now race the token check: a revoked token means Home shows its error card briefly under the Login modal. That's fine, because Login covers it. No TV impact.
- **Verify:** re-run the slow-boot probe (inject a 2.5 s delay on `/jf/Users/<id>` via `Page.addScriptToEvaluateOnNewDocument`, screenshot at 600 ms): the top bar, tab bar and Home skeleton should be there. Sign-out → Login still works. With a token revoked on the server, Login still opens.
- **Depends on / conflicts with:** PWA-01 (the handover), PWA-05 (restore routes before this first mount), PWA-07 (seed Home's data before it mounts). Navigation auditor owns the router.

### PWA-03 · Stop text selection, image callouts and drag on UI chrome; keep selection where copying helps — ✅ done
- **Wave 0:** On `body`, not `.app` (portaled overlays included). Opt-ins: `Overview.svelte` (every overview + the person bio), MovieDetail's `.kv` list, Settings → About Server/Version, and error cards' why line (`.state--error .state__text`, CSS). `format-detection` extended. DET-04's `pointer-events: none` on hero images wasn't needed: images have no callout now.
- **Kind:** native · **Priority:** P1 · **Effort:** S
- **Files:** `phone/src/styles/app.css` (base block), `phone/src/styles/components.css:9-39` (`.no-callout`, button), `phone/index.html:18` (`format-detection`); owners add `.selectable` in their markup
- **Now:** only `.tile` (components.css:378), `.cast`, `.episode`, buttons and the player turn selection or the callout off. Measured in headless Chrome, the text that a long-press selects on screen includes: Home: the TopBar **"VR" wordmark**, hero eyebrow/title/meta/progress line, rail titles. Detail: title, year, runtime, rating, certification, genres, **every tech badge**, the "Cast & Crew" heading, the navbar title. No `<img>` outside tiles/cast has `-webkit-touch-callout: none`: a long-press on the Home hero, the detail backdrop, the person photo, an avatar, a notification poster or a Downloads cover opens iOS's image menu (Save to Photos / Copy / Share) and lets you drag the image out.
- **Change:**
  ```css
  /* app.css — native default: UI text isn't selectable, images don't have a callout */
  .app { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
  .app img { -webkit-user-drag: none; }
  /* opt back in where copying makes sense */
  .app input, .app textarea, .app [contenteditable], .app .selectable {
    -webkit-user-select: text; user-select: text; -webkit-touch-callout: default;
  }
  ```
  Opt-ins (owners add the class): the detail/person **overview and bio** (Look Up / Translate are useful for plot text), `.kv` values in the detail file list (file name, codecs), Settings → About (server address, version), and the "why" line of error cards. Remove the per-component duplicates afterwards (`.no-callout`, `.tile`, `.episode`, `.cast`) or leave them, since they're harmless. Also extend `index.html:18` to `content="telephone=no, date=no, address=no, email=no"`, so iOS data detectors never turn an air date into a link.
- **Why:** in a native app a long-press on a label does nothing, and a long-press on artwork either opens the app's own menu or does nothing. A text loupe on the wordmark is a clear web tell.
- **Constraints & risks:** **inputs must stay `user-select: text`.** On iOS, `-webkit-user-select: none` inherited from an ancestor has broken focusing and typing in the past, so the re-enable line is load-bearing: test Search, Login and the Settings `<select>`s. The long-press gesture (`gestures.js`) is unaffected. VoiceOver is unaffected. Phone CSS only.
- **Verify:** dev frame: re-run the "selectable text" probe (a TreeWalker over visible text nodes whose parent has computed `user-select !== 'none'`); only `.selectable`, inputs and `.overview` should remain. **iPhone:** long-press the Home hero image, the wordmark and a tech badge (nothing happens); type in Search and Login (works); long-press an overview (selection + Look Up).
- **Depends on / conflicts with:** detail/home/settings owners add `.selectable`. The motion auditor's press states are unaffected.

### PWA-04 · Stop pinch-zoom and double-tap-zoom of the whole shell — ✅ done
- **Wave 0:** Player pinch/double-tap read touch events on `.vr-stage` (touch-action: none) — unaffected. Verify on the iPhone.
- **Kind:** native · **Priority:** P1 · **Effort:** S
- **Files:** `phone/src/styles/app.css:10`, `phone/src/main.js` (next to the `touchstart` listener, line 32)
- **Now:** the viewport meta (`index.html:5`) leaves scaling on, and apart from the player, the sheet grabber and the Home hero, `touch-action` is unset. Pinching anywhere in Home, Library or a sheet zooms the entire fixed shell (tab bar included). `viewport.js:22` even says so ("a pinch-zoom the user made"). A double-tap on text can zoom as well.
- **Change:**
  ```css
  html { touch-action: pan-x pan-y; }   /* pans still work in every scroller; the root can't zoom */
  ```
  Zoom is done by the root, so the intersection of ancestor `touch-action`s reaches every element, while pans still stop at each `.screen` / rail. In `main.js`, as a WebKit belt-and-braces:
  ```js
  for (const t of ['gesturestart', 'gesturechange']) document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
  ```
  The player's own pinch (fit ↔ fill) uses touch events (`Player.svelte:311-350`), which `gesturestart.preventDefault()` does not cancel.
- **Why:** native apps never zoom their UI. Dynamic Type (already wired through `--tu`) and the system Zoom accessibility feature, which works regardless of the page, are the iOS answers to "too small".
- **Constraints & risks:** don't add `user-scalable=no` / `maximum-scale`: iOS ignores them for accessibility, and `maximum-scale` also changes input auto-zoom. Make sure the Home hero (`touch-action: pan-y`) and the rails still pan, and the player's double-tap seek and pinch still work.
- **Verify:** **iPhone only**: pinch on Home and in a sheet (no zoom), double-tap a rail title (no zoom), pinch in the landscape player (fit/fill still toggles).
- **Depends on / conflicts with:** player owner (confirm the pinch still works).

### PWA-05 · Restore where the user was after iOS kills the app (and after an update reload) — ✅ done
- **Wave 2:** `phone/src/lib/restore.svelte.js` (runes: a `$effect.root` applies scroll when a page first shows), router `restoreStacks()` / `cutRoute()` / `resetStacks()`, `restoreRoute()` in `main.js` before `initPushLinks()` (a `?open=` deep link wins), saves from phone `lifecycle.js` (hidden) and `onBeforeUpdateReload()`, `closeRoute()` on `pagehide` (skipped for `updateReloading()` and bfcache). Differences from the proposal: **12 h** expiry, not 6 (evening → next morning is still wanted context; beyond half a day Home is the better start); **every** tab's stack is restored (root + last 3), but only the active tab is marked visited, so the others still mount on their first tap (no extra boot fetches); **`pending` pages are not restored** (the activity feed isn't polled before the session check, so the page would say "Nothing in progress" first — the grid leads with that title anyway); stale ids: one `/Items?Ids=…` request validates every restored `detail`/`person` (it answers only the ones that exist — checked read-only against 12.1, Person ids included); a missing one is cut with everything above it (a Back animation + toast if showing). Scroll: `.screen` scrollTop per route, applied on first show once tall enough (≤ 2.5 s, a touch/wheel ends the wait), with `.route.vr-restoring` switching bar transitions off for 3 frames so the NavBar doesn't fade to solid. **Bug found on the way:** an unloading document fires `visibilitychange → hidden` *after* `pagehide` (Chrome, measured), so the hidden-save wiped the quit mark and a swipe-away still restored — a save after `pagehide` now keeps it. Self-calibration for the unverified iOS side: if the page survives a `pagehide` (comes back visible), `reel.route.hidePagehide` is set and a `closed` snapshot then still restores within 30 min. Measured (dev server + a `vite preview` build, headless Chrome): Home → movie → person and Movies (grid scrolled 290) → movie (scrolled 420), active Movies; eviction reload (snapshot put back, no pagehide) → both stacks, Movies active, 420 on the top page, 290 on the grid after Back, the Home tab's person page on first tap; Home root scrolled 700 → 700 from the **first frame** (168 ms); real `pagehide` → Home cold; a stale id on the top page → popped at ~250 ms onto the grid (at 290) + "That title isn’t in your library any more"; update reload (sw.js byte-bump → pending, no reload while visible → hidden → reload) → same series page at 600, snapshot not `closed`; `?open=Movie:<id>` with a Movies snapshot → Home + that movie, no restore. Only loading states animate on the restored paint (detail skeleton until its item lands). **📱 iPhone check:** item 4 above.
- **Kind:** native · **Priority:** P1 · **Effort:** M–L
- **Files:** new `phone/src/lib/restore.js`, `phone/src/lib/lifecycle.js` (`onHidden`, `pagehide` at 88-90), `phone/src/lib/router.svelte.js` (a `restoreStacks()` API), `phone/src/App.svelte` (boot + `offsets` map)
- **Now:** iOS evicts suspended home-screen web apps under memory pressure. This app keeps up to 10 mounted routes per tab with big decoded backdrops, which makes eviction more likely. The next launch then starts cold on Home: the tab, the stack (Shows → series → season) and the scroll position are gone. The same happens on every service-worker update reload (`main.js:43-50`) and after sign-in reloads.
- **Change:** save `{v, user, at, tab, stacks: {tab: [{name, params}]}, scroll: {routeKey→scrollTop of its .screen}}` to localStorage `reel.route` on `visibilitychange → hidden` and just before an update reload (PWA-06). **Clear it on `pagehide`** unless an update reload is in progress: swiping the app away fires `pagehide` (lifecycle.js already relies on that for the player), and native state restoration also discards state when the user force-quits. At boot, before the first mount (PWA-02), if `user === cfg.userId`, `at` is less than ~6 h old, and no `?open=` deep link is pending, rebuild the stacks without animation. Rebuild the active tab's stack capped at root + last 3 routes; other tabs get their roots only. Restore the top route's scroll once its content is tall enough (rAF loop ≤ 2 s until `scrollHeight ≥ saved + clientHeight`). Never reopen the player or a sheet: land on the page the player was opened from. Skip saving a route whose params serialize to more than ~50 KB (e.g. a huge `lookup {item}`).
- **Why:** iOS apps come back exactly where they were, even after the system killed them in the background. Landing on Home after a phone call is the most "web" behaviour left in the app.
- **Constraints & risks:** route params must be plain JSON (they are today: ids, names, lookup items, pending keys). Restored detail pages refetch, which is fine. Confirm on the iPhone that swipe-away fires `pagehide` and that a memory kill doesn't; if swipe-away can't be told apart, fall back to "restore if < 30 min". The router is owned by the navigation auditor: agree on the `restoreStacks()` shape.
- **Verify:** dev: navigate Shows → series → season, scroll, then `localStorage` has the snapshot; `location.reload()` lands on the same page and scroll. **iPhone:** open a series, open several heavy apps until VibeReel is evicted, relaunch (same page). Swipe the app away and relaunch (Home).
- **Depends on / conflicts with:** PWA-02, PWA-06; navigation auditor (router, scroll memory).

### PWA-06 · Apply service-worker updates while the app is in the background, not under the user's finger — ✅ done
- **Wave 1 (G):** `phone/src/lib/swupdate.js` (`initUpdates()` from `main.js`). `controllerchange` only sets `pending`; applied on the next `visibilitychange → hidden` (not under the player/Login), or after ≥ 60 s without pointer/key/wheel/scroll at a tab root with no sheet, no modal, no focused field and no offline download running (rechecked every 10 s while pending; nothing runs otherwise). An update that finishes installing while already hidden applies at once. `reg.update()` still on every foreground (skipped while one is pending). PWA-05 hooks: `onBeforeUpdateReload(fn)` and `updateReloading()`. Measured on a `vite preview` build (headless Chrome, sw.js byte-bumped): first install → no reload; update while visible → noted, no reload; simulated hidden → reloaded onto the new cache; idle at Home → reloaded exactly 60 s after the last touch; Accounts sheet up → no reload in 75 s, then hidden → reloaded. **📱 iPhone check:** deploy, keep browsing (no reload), home screen and back (new build).
- **Kind:** bug / native · **Priority:** P1 · **Effort:** S
- **Files:** `phone/src/main.js:40-62`
- **Now:** every return to the foreground calls `reg.update()` (`main.js:58`). After a deploy the new SW installs (~600 KB precache), `skipWaiting()` + `clients.claim()` fire `controllerchange`, and the page `location.reload()`s at once unless the player or Login is up (`main.js:43-50`). That is a few seconds after the user came back and started browsing: the page blanks and resets to Home in the middle of a tap.
- **Change:** don't reload on `controllerchange`; set `updatePending = true`. Reload on the next `visibilitychange → hidden` (not under the player): save the route first (PWA-05) and set the "updating" flag so `pagehide` keeps it. The app-switcher snapshot covers the reload, and the user comes back to the same page on the new build. Fallback for someone who never leaves the app: reload when at a tab root, with no sheet or modal, after ≥ 60 s without a touch. Keep the existing "not under the player / Login" rule. Don't show a "new version" prompt: native apps update silently.
- **Why:** an update should be invisible, never a reload while someone is using the app.
- **Constraints & risks:** between `controllerchange` and the reload, the old page runs its old bundle against the new SW cache. That's safe here: there's one hashed bundle, and the old one is already in memory. Font and icon paths are shared across builds.
- **Verify:** build twice with a changed string, serve with `vite preview`: with the page open, the second SW activates and no reload happens. Switch tabs away and back (reloaded, same route). **iPhone:** deploy, open the app, keep browsing (no reload), go to the home screen and back (new build, same page).
- **Depends on / conflicts with:** PWA-05 (without it, a background reload still lands on Home, which is still better than a reload under the finger).

### PWA-07 · Paint last-known Home on a cold or offline start — → merged into HOME-03 (lane B) ✅
> Built as HOME-03's mechanism in wave 1 · B: `seedStore`/`storeEntries` in `src/lib/api.js` (inside `__PHONE__`, tree-shaken from the TV: `app.js` md5 unchanged), `phone/src/lib/homesnap.svelte.js` instead of a main.js hook (Home seeds at its own init, synchronously, before its first render), and the banner copy.
- **Kind:** perf / native · **Priority:** P2 · **Effort:** M
- **Files:** `src/lib/api.js` (a `__PHONE__`-only `seedStore(entries)` / `storeEntries(filter)` next to `cached()`/`revalidate()`), new `phone/src/lib/homesnap.js`, `phone/src/main.js`; banner copy in `phone/src/components/OfflineBanner.svelte:17`
- **Now:** the SWR store (`api.js`, in memory) is empty on every cold start, so Home always starts from skeletons. Offline (Tailscale off; the SW still serves the shell), Home shows "Couldn't reach the server" with *Retry / Switch server*, and the banner says "Showing what was loaded last" (measured frame: there is nothing loaded). Jellyfin images are `max-age=31536000` (api.js comment), so the posters and backdrops are very likely still in the HTTP cache.
- **Change:** after Home's rail revalidations land (debounced 2 s), write the store entries for Home's Jellyfin rail paths (Resume, NextUp, Latest…) to `localStorage["reel.homeSnap.<userId>"]` (cap ~300 KB, newest wins). At boot, before Home mounts, `seedStore()` them with their saved `at`. Home's existing `cached()` + `revalidate()` then paints them instantly and replaces them when the network answers; offline, they stay. The banner says "Showing what was loaded last" only when something was painted from the snapshot or live data; otherwise "Your downloads still play" plus the Downloads button that is already there.
- **Why:** native media apps open to yesterday's shelf, even in airplane mode, never to an empty page.
- **Constraints & risks:** `api.js` is shared. Keep the new exports unused by the TV so `app.js` stays byte-identical (run the grep check in CLAUDE.md, and `npx vite build` must pass). Staleness: resume positions may be off for one round trip. Home's revalidate already diffs in place (`keepScroll`, `whenSettled`). Per-account key, cleared on sign-out.
- **Verify:** dev: load Home, reload with `/jf/*` blocked (`Network.setBlockedURLs`): the rails paint from the snapshot and the banner copy is correct. **iPhone:** Tailscale off, cold launch.
- **Depends on / conflicts with:** Home owner (B) for which paths to snapshot and for the offline card's "Switch server" action; sheets/banner owner for the copy. PWA-02.

### PWA-08 · Put the "Ready to watch" count on the app icon — ✅ done
- **Wave 1 (G):** `phone/src/lib/badge.svelte.js` (`initBadge()` from `main.js`, no App.svelte call site): `$effect.root` on `unseenLanded()` + `unreadCount()` only when the device has season pushes on; guarded by `setAppBadge` + `Notification.permission === 'granted'`; stores the count in Cache Storage `vr-badge` → `/__badge`. `sw.js` `bumpBadge()` adds one per push (then posts `vr-changed`); the page re-applies the true count on `vr-changed` and on every foreground. Measured on a preview build with notifications granted and two unseen landed entries seeded: boot → `setAppBadge(2)` (bell said 3: one season, not counted without the season pref); SW bump 2 → 3 → page re-applied 2; SW alone with a stored 2 → 3, 4, and 1 with nothing stored; opening the bell → `clearAppBadge()`, stored 0. **📱 iPhone check:** `sendTestPush()` from Settings with the app backgrounded (badge 1), open the app + bell (gone).
- **Kind:** native · **Priority:** P2 · **Effort:** S
- **Files:** new `phone/src/lib/badge.js` (called from `App.svelte`), `phone/public/sw.js` (`push` handler, ~line 59)
- **Now:** no `setAppBadge` anywhere. The Badging API exists for Home Screen web apps since iOS 16.4 and shows only when notification permission is granted ([WebKit](https://webkit.org/blog/14112/badging-for-home-screen-web-apps/)). That's exactly this app's push users.
- **Change:** app: an `$effect` on `unseenLanded()` (plus `unreadCount()` only when the "New seasons" push pref is on, so the badge doesn't just echo the bell's season list) → `navigator.setAppBadge(n)` / `clearAppBadge()`, guarded by `'setAppBadge' in navigator && Notification.permission === 'granted'`. Store `n` in a tiny Cache entry (`vr-badge`). SW `push`: `self.navigator.setAppBadge?.((stored || 0) + 1)` inside the same `waitUntil`, and write it back. The next foreground sets the true count, and opening the bell (`markLandedSeen`) clears it.
- **Why:** a red count on the icon for "your episode is ready" is how iOS apps say it. The data already exists.
- **Constraints & risks:** without permission the call is a silent no-op, which is fine. Don't badge for news the user didn't opt in to push. SW code must stay ES2017-safe for iOS 17 (it is plain JS). No TV impact.
- **Verify:** `sendTestPush()` from Settings with the app backgrounded (badge 1). Open the app and the bell (badge gone). **iPhone only.**
- **Depends on / conflicts with:** Home/account owner (B) owns the bell sheet (call site of `markLandedSeen`).

### PWA-09 · Give switches the real system haptic with a native `<input type=checkbox switch>` — → merged into MOT-08 (lane F)
- **Kind:** native / craft · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/components/Switch.svelte` (line 12), `phone/src/styles/components.css:620-635` (`.switch`), Settings rows that toggle
- **Now:** `Switch.svelte` is a `<button role="switch">`, so toggling gives no haptic. iOS has no Vibration API. Since iOS 17.4/18, WebKit plays the system switch haptic when a **real tap** activates an `<input type="checkbox" switch>` or its `<label>`. Programmatic `label.click()` stopped ticking in iOS 26.5 (WebKit bug 309082; see [ios-haptics](https://github.com/tijnjh/ios-haptics/pull/13), [project-fathom](https://github.com/m1ckc3s/project-fathom)), but trusted taps still tick.
- **Change:** render the switch as a `<label class="switch …">` wrapping `<input type="checkbox" switch class="switch__native" checked={on} {disabled} aria-label={label} onchange={…}>`. The input is `position:absolute; inset:-7px -6px; margin:0; opacity:0` over the existing drawn track and knob (keep the visuals). Where a whole Settings row toggles the switch, make the row the `<label>` (a trusted tap anywhere on the row then ticks) instead of calling `toggle()` from JS. Optionally apply the same pattern to other binary toggles the owners care about (the detail page's Watched action); stop there.
- **Why:** UISwitch taps on iPhone come with a light tick. It's small, it's what users expect, and it's the one haptic a web app can still get.
- **Constraints & risks:** unknown whether `opacity:0` or `appearance:none` suppresses the haptic. Test `opacity:0` with the default appearance first. VoiceOver now gets a native switch, which is better. `bind:on` / `onchange` API unchanged.
- **Verify:** dev: Settings switches still toggle and keep their state. **iPhone only:** feel the tick. Tapping the row label ticks too. No double toggle.
- **Depends on / conflicts with:** sheets/settings auditor (Settings rows).

### PWA-10 · Show iOS's own scroll indicator on vertical page scrollers — ✅ done, then ↩ reverted 2026-10-01 (user: no scrollbars anywhere; global rule in app.css)
- **Wave 1 (G):** the hiding rules are gone from `.screen` (components.css) and `.sheet__body` (components.css + app.css); horizontal `.rail__track`/`.pills`/`.chips` keep theirs; `@media (pointer: fine)` hides it for desktop dev screenshots. Merged MOT-15. The player's `.vr-colstack`/`.vr-player--portrait`/`.pport` still hide theirs (lane E's call). **📱 iPhone check:** scroll Library (thin light indicator, fades), a rail (none), and look at it over the Home hero and under the tab bar.
- **Wave 2 (player):** the landscape picker panel's columns (`.vr-colstack`, `.vr-player .panel__col`/`.panel__body`) now show the indicator (hidden under `pointer: fine` only). The portrait player (`.vr-player--portrait`) keeps it hidden on purpose. The scroller there is the whole player with the video sticky inside it, and web code can't inset the indicator, so its thumb would run down the playing picture's right edge on every scroll. Showing it means making the info column its own scroller under the video, which is a layout change that touches PLY-02's scroll gate and PLY-04. Left for a later round.
- **Kind:** native · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/styles/components.css:54-63` (`.screen`), `:705` (`.sheet__body`), `phone/src/styles/app.css:30`
- **Now:** every scroller hides its scrollbar (`scrollbar-width: none` + `::-webkit-scrollbar { display: none }`), and on iOS that also hides the thin overlay indicator. A 400-title Library grid or a long episode list scrolls with no sense of where you are.
- **Change:** keep hiding it on horizontal scrollers (`.rail__track`, `.chips`, `.pills`: native carousels hide theirs too). Drop the two hiding rules from `.screen` and `.sheet__body`. To keep desktop dev screenshots clean: `@media (pointer: fine) { .screen, .sheet__body { scrollbar-width: none; } }`.
- **Why:** UIKit scroll views flash an auto-hiding indicator while moving. Its absence is subtle but reads as "web page with scrollbars styled away". The indicator may also enable iOS's grab-the-indicator fast scroll on long lists; check this on the device.
- **Constraints & risks:** the indicator spans the full `.screen` height, including under the floating tab bar and top bar, and web code can't set indicator insets. Check that it doesn't look wrong over the Home hero.
- **Verify:** **iPhone only**: scroll Library (thin light indicator, fades out), scroll a rail (none).
- **Depends on / conflicts with:** player owner for `.vr-colstack` / `.pport` (portrait player info, same decision).

### PWA-11 · Honour "Increase Contrast" in the tokens — ⏳ later round
- **Kind:** native / a11y · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/styles/tokens.css` (after `:root`, near the Dynamic Type block at 253-260)
- **Now:** no `prefers-contrast` rule. With iOS Settings → Accessibility → Display & Text Size → Increase Contrast on, native apps make blur materials more opaque and hairlines and secondary text stronger. This app's glass chrome (`--glass-bg` 50 %) and 56 % faint text stay the same.
- **Change:**
  ```css
  @media (prefers-contrast: more) {
    :root {
      --text-dim: rgba(243,239,230,.86); --text-faint: rgba(243,239,230,.72);
      --line: rgba(255,255,255,.16); --line-strong: rgba(255,255,255,.34);
      --glass-bg: var(--glass-bg-strong); --glass-line: rgba(255,255,255,.28);
      --track-dim: rgba(255,255,255,.38);
    }
  }
  @media (prefers-reduced-transparency: reduce) { :root { --glass-bg: var(--glass-bg-strong); } }  /* inert until WebKit ships it */
  ```
- **Why:** respecting the system accessibility switches is part of feeling native, and it's a token-only change.
- **Constraints & risks:** tokens only. Check that the gold on `--gold-soft` tab pill still reads.
- **Verify:** CDP `Emulation.setEmulatedMedia({features:[{name:'prefers-contrast',value:'more'}]})` and screenshot Home, a sheet and the tab bar. **iPhone:** toggle Increase Contrast.
- **Depends on / conflicts with:** motion/visual auditor if they also touch glass tokens.

### PWA-12 · Make a tap on the status bar scroll to the top (experiment) — ⏳ later round
- **Kind:** native · **Priority:** P2 · **Effort:** M
- **Files:** new `phone/src/lib/statusbar.js` (init from `main.js`), `phone/src/styles/app.css:10-12`, `phone/src/lib/viewport.js:22-23`, `App.svelte` (`R.toTop` effect at 211-221)
- **Now:** iOS's status-bar tap scrolls only the web view's *document* to the top. The shell never scrolls the document (`body` fixed, `overflow: hidden`), so the tap does nothing in any page. Every iOS user reflexively taps the clock to jump up a long list.
- **Change (standalone only, behind a flag):** give the document exactly 1 px of scroll (`html.sbtap { overflow-y: auto; height: calc(100% + 1px); }`, body stays `position: fixed`) and park it at `scrollY = 1`. A status-bar tap animates the document to 0 without any touch reaching the page. On `scroll` with `scrollY === 0`: if no touch is active, none ended in the last 600 ms, no field has focus, and `visualViewport.scale ≈ 1`, then scroll the visible target to top. That target is an open sheet's `.sheet__body`, else the top route (`R.toTop++`, which App already handles). Then put the document back at `scrollY = 1`. `viewport.js`'s keyboard fix must restore to `(0, 1)` instead of `(0, 0)`.
- **Why:** it's one of the most-used iOS gestures, and nothing else in the web platform exposes it.
- **Constraints & risks:** experimental. A drag on non-scrolling chrome can move the 1 px; the touch guard filters that out. Keep `overscroll-behavior: none` on `html` so the 1 px never bounces. Test with the keyboard, the player (ignore while `R.modal`) and landscape. If anything misbehaves, ship without it: the tab-bar re-tap already scrolls to top.
- **Verify:** **iPhone only**: scroll Library far down, tap the clock (glides to top). Scroll and release near the tab bar (no false trigger). Open and close the keyboard in Search (no shift).
- **Depends on / conflicts with:** navigation auditor (`R.toTop`), PWA-04 (`touch-action` on html; pans still allowed).

### PWA-13 · Offer "Notify me when it's ready" once, in context — ⏳ later round
- **Kind:** craft / native · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/lib/push.js` (`setPush`, `pushSupport`, `pushPrefs`), call sites owned by others: `phone/src/screens/PendingDetail.svelte` / `LookupDetail.svelte` (after *Add to library*), or `phone/src/sheets/Notifications.svelte`
- **Now:** push can only be switched on in Settings → Notifications. Asking only inside a tap is correct, but a user who never opens Settings never learns that "Ready to watch" can reach the lock screen.
- **Change:** show one quiet row, not a modal: "Notify me when it's ready", with a bell icon, under the status button on PendingDetail (and after a successful add on LookupDetail). Show it only when `pushSupport() === 'ok'`, `Notification.permission === 'default'`, the `ready` pref is off, and it hasn't been dismissed (`reel.pushAsk` in localStorage). The tap calls `setPush('ready', true)` **synchronously** (it already asks for permission first). On success the row turns into "We'll let you know", on denial into nothing.
- **Why:** iOS apps ask for notification permission at the moment it makes sense ("tell me when my download is done"), not in a settings screen and not at launch.
- **Constraints & risks:** at most once per title page and never after a denial. Keep it off in a Safari tab (`'browser'`).
- **Verify:** dev (desktop Chrome has PushManager): the row appears and the tap calls `setPush` (stub the server). **iPhone:** the permission prompt comes from the row tap.
- **Depends on / conflicts with:** detail owner (D) for placement.

### PWA-14 · Gold caret and selection, and a dark AutoFill — ⏳ later round
- **Kind:** craft · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/styles/components.css:32` (`input` base), `phone/src/styles/tokens.css:30`
- **Now:** no `caret-color` or `accent-color`, so the Search, Login and field carets use iOS's default blue. No `:-webkit-autofill` rule, so when Safari fills the Login fields from Passwords they get WebKit's AutoFill tint over the dark field.
- **Change:**
  ```css
  :root { accent-color: var(--gold); }
  input, textarea { caret-color: var(--gold); }
  ::selection { background: rgba(230,180,80,.35); }
  input:-webkit-autofill, input:-webkit-autofill:focus {
    -webkit-text-fill-color: var(--text);
    box-shadow: 0 0 0 100px var(--surface-2) inset;   /* the .field__box fill */
    transition: background-color 9999s;
  }
  ```
- **Why:** native apps tint the caret and selection handles with the app's accent colour. A blue caret in a gold app is a small but real seam.
- **Constraints & risks:** check the `.field__box` background token before copying it. `::selection` may not be honoured on iOS, which is harmless.
- **Verify:** dev: caret gold in Search. **iPhone:** AutoFill Login from Passwords (the field stays dark).
- **Depends on / conflicts with:** Login owner (sheets/login auditor).

### PWA-15 · Sharpen the home-screen icon (and optionally give it a little depth) — ⏳ later round
- **Kind:** craft · **Priority:** P3 · **Effort:** S
- **Files:** `phone/make-icons.sh`, `phone/public/icons/apple-touch-icon.png`, `phone/index.html:21`
- **Now:** `apple-touch-icon.png` is 180×180 (flat `#0a0a0c` + gold bars-and-play glyph, the TV's). iOS 18's "Large" icons and iOS 26's glass rendering draw icons above 180 px, so it's upscaled. The glyph's triangle has sharp corners next to fully rounded bars. The link overrides the manifest icons ([firt.dev](https://firt.dev/notes/pwa-ios/)).
- **Change:** render `apple-touch-icon.png` at 1024×1024 (same file name, fully opaque, no rounding, since iOS masks it). Optional, and show the user both before switching: a very soft vertical gradient on the background (`#15151a → #09090b`), and triangle corners rounded to match the bars (draw the polygon with `-stroke '#e6b450' -strokewidth N -draw "stroke-linejoin round polygon …"`). Leave the TV's `build-ipk.sh` glyph as it is.
- **Why:** a crisp icon is the first thing the user sees 50 times a day. Rounded corners on every part of the glyph read as deliberate.
- **Constraints & risks:** brand change, so the user decides on the optional part. iOS may cache the icon until the app is re-added.
- **Verify:** `magick identify` shows 1024×1024, opaque. **iPhone:** Large icon mode (sharp).
- **Depends on / conflicts with:** PWA-01 (same script).

### PWA-16 · Preload the italic serif used by the "R" of the top-bar mark — ⏳ later round
- **Kind:** craft / perf · **Priority:** P3 · **Effort:** S
- **Files:** `phone/index.html:23`
- **Now:** only `InstrumentSerif-Regular-latin.woff2` is preloaded. The TopBar mark's gold italic "R" (`.wordmark__accent`) and Login's "*Reel*" need `InstrumentSerif-Italic-latin.woff2`, which is found only after CSS and layout. With `font-display: swap`, a first uncached launch paints a Georgia-italic "R" and then swaps it.
- **Change:** add `<link rel="preload" href="/fonts/InstrumentSerif-Italic-latin.woff2" as="font" type="font/woff2" crossorigin>`.
- **Why:** the brand mark should never visibly change font.
- **Constraints & risks:** +15 KB fetched early, already precached by the SW.
- **Verify:** built `index.html` has two font preloads. Dev network panel: italic fetched before first paint.
- **Depends on / conflicts with:** none.

### PWA-17 · Make `sw-precache` stamp the sw.js of the build it runs in — ✅ done
- **Wave 1 (G):** `configResolved` remembers `path.resolve(root, build.outDir)`; `closeBundle` stamps that dir's `sw.js`. `/splash/` is hashed into VERSION but left out of PRECACHE (14 entries, 633 KB — unchanged). Evidence of the bug: before the fix `phone/dist/sw.js` had an mtime of 22:51 against `index.html`'s 21:06 (other lanes' scratch builds had been rewriting it); after it, a `--outDir /tmp/claude-1000/laneG/phone` build stamped `VERSION = '81a4789e6c48'` there and left `phone/dist/sw.js` untouched.
- **Kind:** bug · **Priority:** P3 · **Effort:** S
- **Files:** `phone/vite.config.js:69-99` (`swPrecache`, `const dist = path.join(here, 'dist')` at 73)
- **Now:** the plugin always reads and writes `phone/dist`, whatever `build.outDir` is. Measured: `npx vite build --config phone/vite.config.js --outDir /tmp/…` left that build's `sw.js` unstamped (`VERSION = 'dev'`, `PRECACHE = []`, so an offline start from it would fail) and rewrote `phone/dist/sw.js` instead (same content this time, since the replace found nothing to change).
- **Change:** remember the resolved out dir: `configResolved(c) { outDir = c.build.outDir; }` and use it in `closeBundle`.
- **Why:** parallel agents build into scratch dirs. This silently touches the deploy tree and produces a broken SW elsewhere.
- **Constraints & risks:** none. `phone/deploy.sh` builds into the default dir.
- **Verify:** build with `--outDir /tmp/x`: `/tmp/x/sw.js` has a 12-hex `VERSION` and a non-empty `PRECACHE`, and `phone/dist/sw.js`'s mtime is unchanged.
- **Depends on / conflicts with:** PWA-01 (optional `/splash/` exclusion goes in the same filter).

## Platform capability notes

| Capability | iOS home-screen web app (iOS 17–26) | Used today? |
|---|---|---|
| Launch screen | only `apple-touch-startup-image`, exact device media query; manifest `background_color` ignored ([firt.dev](https://firt.dev/notes/pwa-ios/)) | no → PWA-01 |
| Status bar | `default` / `black` / `black-translucent`; translucent + `viewport-fit=cover` hits WebKit 301108 on iOS 26 | `black-translucent` again since 2026-10-01 (user's call; shell at `100lvh` in standalone, unverified) |
| Status-bar tap → top | scrolls the document only | not reachable → PWA-12 |
| Icons | `apple-touch-icon` overrides manifest icons; no dark/tinted/monochrome variant API for web clips | 180 px → PWA-15 |
| Badging API | yes since 16.4, Home Screen only, needs notification permission ([WebKit](https://webkit.org/blog/14112/badging-for-home-screen-web-apps/)) | no → PWA-08 |
| Web Push | yes since 16.4, Home Screen only, permission from a gesture | yes |
| Vibration API | no | — |
| Haptics via `<input type=checkbox switch>` | real taps only; `label.click()` patched in 26.5 | no → PWA-09 |
| Orientation lock (API or manifest) | no | — (player swaps layouts) |
| Manifest shortcuts / share target / file handlers | no | — |
| Background Fetch / Periodic Sync | no | — (offline copies resume per segment) |
| Web Share (L2) | yes | no (cross-ref) |
| Media Session | yes | yes (player) |
| Picture in Picture | not in standalone (measured, CLAUDE.md) | Safari tab only |
| `navigator.storage.persist()` | yes | yes |
| `prefers-contrast` | yes | no → PWA-11 |
| `prefers-reduced-transparency` | not in WebKit (as far as known) | — |
| Dynamic Type (`font: -apple-system-body`) | yes | yes |
| `touch-action` pan-x/pan-y/manipulation | yes (iOS 13+) | partly → PWA-04 |
| `interactive-widget` viewport key | Chromium only | — (viewport.js handles the keyboard) |
| Keyboard accessory bar (◀ ▶ Done) | can't be removed from the web | — |
| Scroll-driven animations, `text-wrap: pretty` | Safari 26 only (fallback needed for 17–18) | no (cross-ref) |
| iOS 26 "Open as Web App" | any site added opens standalone; manifest still honoured ([WebKit](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)) | — |

## Considered and rejected
- ~~**`black-translucent` status bar for a full-bleed hero:** WebKit 301108 leaves an unpaintable band at the bottom on iOS 26.~~ Overruled 2026-10-01: the user wants the page behind the Dynamic Island; tried with the `100lvh` workaround, pending the iPhone check.
- **Colouring the status-bar strip to `#0a0a0c` (`default` + `theme-color`):** needs a remove + re-add on the phone, and the `#000` vs `#0a0a0c` difference is barely visible on OLED.
- **Programmatic haptics (`label.click()` libraries):** Apple broke the trick in iOS 26.5. Only the real-tap switch (PWA-09) is dependable.
- **A logo splash or animated intro (like the TV's Splash):** it slows every launch. Native launch screens are static and handed over instantly.
- **"New version available — reload?" prompt:** native apps update silently. PWA-05/06 make the reload invisible instead.
- **`user-scalable=no` / `maximum-scale=1`:** iOS ignores them for accessibility, and `maximum-scale` changes input zoom. PWA-04 uses `touch-action` instead.
- **Trimming mounted routes on background to avoid eviction:** the page can't measure its memory on iOS. Making an eviction harmless (PWA-05) is the reliable answer.
- **An "Add to Home Screen" banner in Safari tabs:** a single-user app that is already installed. Push already explains "open from the Home Screen" when needed.
- **Pull-to-refresh:** decided against (freshness.svelte.js refreshes by itself).

## Cross-refs
- **Home (B):** the offline-start card offers *Switch server*, which is odd when simply offline (PWA-07). With the opaque status bar, the hero image starts hard against a `#000` strip, so check the top of `--scrim-hero` at 1× on the device. A stretchy hero on pull-down at the top, like the TV app on iOS, would feel native (scrollTop < 0 → scale the backdrop). Same idea for the detail hero (D).
- **Detail (D):** `text-wrap: pretty` on overviews (Safari 26, harmless elsewhere). Consider a *Share* item (`navigator.share({title, url: IMDb/TMDB})`) in the long-press menu or detail actions. Mark overview/bio/file rows `.selectable` (PWA-03).
- **Player (E):** after the trailer fallback's `location.href = youtube…` (`src/lib/trailer.js:89`) in standalone, handle `pageshow` with `persisted` like a resume. `.vr-colstack` / `.pport` hide their scroll indicators (PWA-10 decision). Confirm the pinch still works after PWA-04.
- **Sheets/settings/toasts:** OfflineBanner copy on a cold offline start (PWA-07). Settings rows as `<label>` for the switch haptic (PWA-09). Login AutoFill colours (PWA-14).
- **Motion:** TopBar/NavBar solidify via `animation-timeline: scroll()` on Safari 26 would take `scrollPast` off the main thread, but needs the JS path kept for iOS 17–18.
- **Navigation:** `restoreStacks()` and the scroll-offset map for PWA-05. `R.toTop` reuse for PWA-12. UX-AUDIT's open "inert on stage while a sheet is up" item looks already done (`App.svelte:289,299`), so it can be closed there.
- **Infra:** none needed. The LAN origin already sends `no-cache` for `index.html`/manifest and `no-store` for `sw.js`, and serves the SPA fallback.
