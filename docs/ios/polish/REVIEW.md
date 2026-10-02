# Wave 3 review — correctness pass over the polish round

Reviewer: Wave 3 · Reviewer, 2026-10-01. Scope: `git diff HEAD` + the untracked files of Waves 0–2
(phone/ and the two `src/lib` additions), read against `CLAUDE.md` (iPhone), `ARCHITECTURE.md`,
`PHONE-API.md` and `polish/README.md`. Style and token churn are out of scope. Every finding below was
either **reproduced** in the dev server (headless Chrome over CDP, 393×852, touch emulation, every
non-GET to `/jf`/`/ml` stubbed, `rm=0` unless stated) or **traced** line by line. Suspects I couldn't
substantiate are listed at the end as checked and cleared.

**Status (phase 2, after the sweep):** 3 confirmed findings, all fixed: REV-01 (raised to P1 in phase 2),
REV-02 and REV-03 (both P3). REV-04 was withdrawn: the phase-2 reproduction showed the tap already primes
the `<video>`. Each fix was reproduced before and after in the dev server. After the fixes both builds
pass and the TV bundle is still byte-identical (`a48f9174…` / `9209f54f…`, grep 0). Line numbers are
from the phase-1 tree.

## Gates

- **TV bundle:** byte-identical. `npx vite build --outDir /tmp/claude-1000/w3r/tv` gives `app.js`
  `a48f917448ea56a3ac46cbd5125a31cb` and `style.css` `9209f54f6c966c785f232b24929e79d1`, and the
  `VibeReel Phone|main.m3u8|ManagedMediaSource` grep prints 0. The `src/lib` additions are all phone-only:
  - `api.js` `seedStore`/`storeEntries`
  - `toast.svelte.js` `pauseToast`/`resumeToast`

  Each is `__PHONE__`-guarded and tree-shaken from the TV bundle.
- **Phone build:** `npx vite build --config phone/vite.config.js --outDir /tmp/…` passes with no Svelte
  warnings, and `sw.js` is stamped in the out dir (PWA-17 holds).
- **iOS 17 API guards:** clean.
  - `linear()` sits behind `@supports` in CSS and a `CSS.supports` probe in JS.
  - `checkVisibility?.()`, `'switch' in HTMLInputElement.prototype` and `setAppBadge` are feature-tested.
  - `text-wrap: balance` is progressive.
  - There is no View Transitions API, scroll timeline, `Object.groupBy` or `Promise.withResolvers`.
  - New storage access (`restore`, `homesnap`) is wrapped in try/catch.

---

## REV-01 · P1 · Home stays on the cold-start snapshot after the connection comes back — and can resume from its old position — ✅ fixed

**Where:** `phone/src/screens/Home.svelte`:
- 118: the snapshot paint sets `lastLoad = Date.now()`
- 208–212: a failed live load keeps `painted`/`stale` and sets no `failed`
- 254: `quietLoad` returns while `stale`
- 302–312: `onReconnect` only retries on `failed`
- 325–330: the `active` effect only reloads after 60 s *and* a tab switch

**Scenario:** the app starts offline or with the server unreachable (Tailscale off, NAS asleep), and Home
paints the last session's snapshot (HOME-03). The connection then returns: the `online` event, the
banner's Retry, or App's 20 s `checkServer`. The banner goes away, so the page now looks live. But
Home never loads the live rails:
- `failed` is null because something was painted, so `onReconnect` does nothing.
- `quietLoad` refuses every freshness change because the page is `stale`.
- The `active` effect only fires on a tab switch.

Continue Watching positions, Next Up and Recently Added stay days old until the user leaves the tab and
comes back after 60 s, backgrounds the app for 10 min, closes a player, or taps a Continue Watching
tile (`whenLive()` loads on demand).

The same happens after an online start where only one play-state rail failed (`stale = !!(rs.e || nu.e)`,
line 224): from then on the page ignores every `onLibraryChange`.

**Evidence: reproduced.**
1. I dropped one item from the snapshot's Resume entry and started with `?offline=1`. Home showed 6 CW
   tiles.
2. I called `__reelDev.setOffline(false)`. After 6 s the banner was gone.
3. I ran `__freshness.check()` and waited 8 s more. Home still showed 6 CW tiles; the live answer has 7.

**Proposed fix (Home.svelte):**
- `onReconnect` callback: before the `failed` check, add `if (stale && !inflight && !conn.offline) return load();`.
- Also react to `conn.offline` turning false. iOS may never fire `online` when only the tailnet comes
  back, so `checkServer` is what flips it:
  `$effect(() => { if (!conn.offline && untrack(() => stale && !inflight && !dead)) untrack(load); })`
- `quietLoad`: replace the `stale` early return with `if (stale) { if (!inflight) load(); return; }`, so
  a freshness change while stale fetches the full live set.

**Phase 2: the root cause is worse than the trace above, so this is now P1.** An instrumented run showed
`stale` was **false** after the offline start's failed load. The cause is `grab()`: on a failed request
it falls back to `cached(U[k])` and returns `{ d }` **without `e`**. At a cold start that cached copy is
the seeded snapshot, so the failed load looked like a live answer. It cleared `stale`, set
`lastLoad`/`failed = null` and re-saved the snapshot.

From then on, once back online, a Continue Watching / Next Up / hero Resume tap took the non-stale path
`start(x?.MediaSources ? x : it)` with the snapshot item. `playFromHome()` then resumed from the
snapshot's `PlaybackPositionTicks`, which can be days old. The Stopped report at the end would write that
old position back over the newer one made elsewhere (the TV).

**Fix (Home.svelte):**
- `grab()` keeps `e` on the cached fallback: `{ d: cached(…) || empty, e }`. A load whose play-state rails
  both failed is a failure again: `painted` stays, `stale` stays, and the waiters get `false`. A partial
  failure paints the fallback and stays stale for it (line 224 unchanged).
- The three hooks as proposed:
  - `onReconnect`: `if (stale && !inflight && !conn.offline) return load();`
  - an `$effect` that loads when `conn.offline` turns false while stale
  - `quietLoad` loads the full live set while stale instead of dropping the change

**Verified:**
- Before: 6 CW tiles on the snapshot → online → still 6 (the live answer has 7), and no Resume request
  went out.
- After: the snapshot showed 3 (the test trims one per run), the reload fired ~1.5 s after `online`
  (`/UserItems/Resume` 200), and Home repainted to 7.
- A normal online boot is unchanged: 7 CW tiles + 2 Next Up, one Resume and one NextUp request, no error
  card.

## REV-02 · P3 · A sheet presented while the previous one is still leaving has an invisible scrim (Reduce Motion: an invisible sheet) — ✅ fixed

**Where:** `phone/src/App.svelte`:
- 545 (RM exit): `sheetHost.animate(… opacity 0, fill: 'forwards')`
- 571 and 561 (exit): `scrimEl.animate(… opacity 0, fill: 'forwards')`
- 507–524 (present): the new animations have no fill and never cancel the old ones

**Scenario:** `closeSheet()` and then `openSheet()` within the exit window (260 ms, 180 ms under
Reduce Motion). Because `{#if sheetShown && SheetComp}` never goes false, the scrim and host elements are
reused.

The present fades the scrim 0 → 1 with no fill. Once it finishes, the exit's still-applied forwards fill
wins again, and the scrim sits at opacity 0: no dimming, though it still catches taps. Under Reduce
Motion it is the host that is left at opacity 0, so the whole new sheet is invisible but interactive.

A finger can hardly do this, because the fading scrim covers the triggers. Code can: any
close-then-open across a tick, e.g. a future "switch sheet" flow or a notification-tap route.

**Evidence: reproduced.**
- `rm=0`: after close, 80 ms, then open, the `.scrim` computed opacity is `0`, and `getAnimations()`
  holds the exit's `finished:1>0` forwards fill.
- `rm=1`: after close, 60 ms, then open, the `.sheethost` computed opacity is `0`.

**Proposed fix:** at the top of the present branch's `tick()` callback, cancel what the exit left:
`for (const x of scrimEl?.getAnimations() ?? []) x.cancel(); for (const x of sheetHost?.getAnimations() ?? []) x.cancel();`
Do this before starting the present animations, and before the RM early return.

**Phase 2:** done as proposed in `App.svelte`'s present branch. It cancels the host's and the scrim's own
animations only, not their subtree, so the new sheet's animations are untouched.
- Before: close → 60 ms → open left the scrim at opacity `0` (`rm=0`) and the host at opacity `0`
  (`rm=1`).
- After: scrim `1` / host `1` in both modes. A normal close afterwards still removes the host.

## REV-03 · P3 · A confirm() raised while the previous action sheet is leaving loses focus to the page behind — ✅ fixed

**Where:** `phone/src/components/ActionSheet.svelte`:
- 26–33: `present(r)` with `again` keeps the old `before` and cancels the exit animations
- 46–66: the old `dismiss` still has its `setTimeout(end, …)` fallback armed

**Scenario:**
1. The user answers action sheet A, and within ~410 ms a second `confirm()` (B) arrives. B takes over
   the element and focuses its Cancel.
2. Then A's fallback `end()` fires. It skips the `shown` reset, correctly, but still runs
   `before?.focus()`, which moves focus to the element behind B, and clears `before`.
3. B's own dismissal then restores focus nowhere.

With VoiceOver the user is left outside the alert (`aria-modal`) and ends up on `<body>` afterwards.

**Evidence: traced.**
- The exit animation is cancelled by `present` (`getAnimations().forEach(cancel)`), so `onfinish` never
  fires.
- The timer is not cancelled.
- `end()` has no "superseded" guard.

**Proposed fix:** in `dismiss(r)`'s `end`, return early when `shown !== r`, because a newer request
owns the sheet and the focus hand-back. Clear the fallback timer in `present` when `again`.

**Phase 2:** done as proposed. The fallback timer is kept as `exitTimer`: `present` clears it, and `end`
clears it and bails out when `shown !== r`.
- Before: focus on a page button, `confirm(A)` → answer → 100 ms → `confirm(B)`. With B up, focus was
  back on the page button behind it.
- After: focus is on B's Cancel. Answering B returns focus to the original button, and the sheet is
  removed.

## REV-04 · P3 · Reduce Motion: context-menu actions now run after an animation instead of inside the tap — ⏭ not fixed: withdrawn, the tap already primes the video

**Where:** `phone/src/components/ContextMenu.svelte` 163–168 (CTX-01 rewrite). Before this round, the
Reduce Motion close was `return done()`, synchronous inside the item's click. It now fades for `DUR.rm`
and runs `onclose` + the action from the animation's `onfinish`.

**Scenario:** under Reduce Motion, "Play from beginning" in Home's Continue Watching / Next Up menu
(`Home.svelte` 579) now calls `playLive` → `playItem` → `play()` outside the tap. `play()` relies on its
`load()` running inside the tap: CLAUDE.md, "that lifts iOS's gesture restriction so the later
`play()` has sound".

The animated (non-RM) path already had this shape before the round. HOME-03's `primeVideo()` doesn't
help here either, because it too runs from the menu's `onfinish`. Once the session's `<video>` has been
unlocked by an earlier play, nothing is lost. A first start from the menu may begin muted or be refused.

**Evidence: traced** (the code path). The iOS consequence needs the iPhone check.

**Proposed fix:** let an item opt into running in the click. For example, ContextMenu calls
`it.now?.()` synchronously in the item's `onclick`, before `close(…)`, and Home's play items pass
`now: primeVideo`. Alternatively, restore the synchronous `done()` for the RM path only when the item is
marked `sync`. The first option fixes both paths.

**Phase 2: withdrawn, no change.** The phase-1 trace missed `Player.svelte`'s mount-time primer (≈ lines
898–915). It `load()`s the session's single, always-mounted `<video>` on the first `touchend`/`click`
anywhere, in the capture phase, and that unlock lasts for the element's lifetime.

The instrumented run, with `HTMLMediaElement.prototype.load/play` hooked and a trusted CDP tap on "Play
from beginning", recorded `load()` inside the tap's own `touchend` (and `click`) before the menu's
`finish` in both `rm=1` and `rm=0`. In a real session the element is unlocked even earlier, by the
session's first touch or by the long-press's own release. So the action running from `onfinish` never
needs the gesture. An `it.now` hook would add API for no effect, so I left the menu as it is.

---

## Checked and cleared (no finding)

- **App shell interactions** (reproduced unless noted):
  - A large sheet up, then the player opens (`S.screen='player'`): the sheet leaves, the page card
    animates back, and `presenter`/`body.sheet-card`/inline styles are all cleared. The same after the
    player closes, and after a large sheet is closed and reopened.
  - Rapid push → pop at 150 ms → push → tab switch → back, and push → `replace()` 100 ms in → pop: no
    route keeps inline styles, running animations, a stuck `hidden`/`inert`, or an edge-strip animation.
  - `replace()` during the edge swipe's `grab()` (traced): the cancel runs `done()`, which hides the
    leaving page and drops the z-lift.
  - Login during restore / a 401 at boot (traced): `forgetRoute` + `resetStacks`. The shell unmounts
    without playing the local outros, `validate()`'s 401 is swallowed, and a sign-in to another account
    seeds Home by the new `userId`.
- **State restore** (reproduced):
  - A detail page and its 400 px scroll come back after a reload.
  - A stale 32-hex id on the visible tab is cut with a pop and the "isn't in your library" toast.
  - Per-account, the 12 h window, `closed` and `?open=` precedence (traced).
  - Invalid shapes are filtered by `RESTORABLE` (traced).
- **Home snapshot:**
  - Painted offline with the right banner copy (reproduced).
  - The trimmed items keep every field `imgUrl`, the tiles, the hero, `blurFor` and `hideFromHome`
    read (traced).
  - A stale Continue Watching / Next Up / hero start waits for the live item (`whenLive`); a failed or
    superseded load always settles the waiters from the newest `gen` (traced).
- **Gestures:**
  - Long-press → menu → tap outside: the source tile's `visibility` is restored and `.holding` is gone.
  - Long-press → "Go to movie": it pushes, and after the pop the tile is visible (reproduced).
  - `press.js` cancel paths, and the carousel's `swallow` only during motion (traced).
  - The 450 ms post-long-press click swallow predates this round.
- **Bell badge** (MOT-10/NAV-13): the pop-in on 0→1 and the bump on 1→2 both fire (reproduced by
  injecting `landed` items). Nothing animates on a hidden route (`checkVisibility`).
- **Player** (trailer, headless):
  - Present and close via Esc leave no `vr-player--closing`, inline styles or animations.
  - The swipe-down couldn't be driven headless: the paused video keeps the controls up, so
    `swipeGate` is closed. The code was traced instead: `dismissing`/`closing` reset in
    `hideNow`/`present`.
- **`swupdate.js`:**
  - The reload is never under the player or Login.
  - The idle path requires a root, no sheet, no input focus and no running download.
  - `updateReloading()` keeps the route snapshot.
- **`confirm()`:** every request resolves, via its answer or a newer request. `confirmMenu` maps
  `confirmItems()` correctly.
- **Optimistic Watched** (Movie/Series): reverted on failure, and reset when the item prop changes.
- **`epsSeason`:** set on every path that assigns `eps` (load, refresh, queue-only pick, error).
- **Native `<input switch>`:** a refused push toggle flips `checked` back through the prop.
