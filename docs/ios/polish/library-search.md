# Library, Search & Charts — polish and native-feel tasks

Audited 2026-09-30 by reading the code and running it in headless Chrome at 393×852, 375×667 and 852×393 against the real server. The library is small: 12 movies and 7 shows. The charts hold 250 titles, 10 of them in the library.

Several things already feel right. The large title turns into a compact glass bar that scrolls to the top when tapped. Grids mount in slices and use a constant `content-visibility`. Search has the right keyboard (`type=search`, `enterkeyhint`, autocorrect off, keyboard dismissed on scroll). Library matches appear on every keystroke. Library screens refresh themselves quietly.

The biggest gaps are state changes that cut instead of moving:
- The re-query dim snaps back without a transition.
- Search results dim on every keystroke.
- Focusing the search field makes the title disappear and the field jump 52 pt, with *Cancel* appearing instantly.
- Tapping the quick-add "+" gives no feedback on the tile. The button just disappears.
- The segmented controls have no sliding thumb.

## Tasks

### LIB-01 · Make the re-query dim fade back in, and don't dim fast answers — ✅ done
- **Done:** as proposed, on `:where(.lib__grid, .lib__emptywrap, .srch__grid > .tile)` (so `.lib__dim` wins). Un-dim is `--dur-base` + `--ease-out`; the delay is a new token `--dim-delay` (200 ms). Measured: fast re-queries (~70–150 ms) no longer dim at all (was 1 → 0.59 → snap); a 600 ms answer dims from 200 ms and eases 0.45 → 1 over ~200 ms.
- **Kind:** bug / craft · **Priority:** P1 · **Effort:** S
- **Files:** `phone/src/styles/library.css` (`.lib__dim`, new base rules for `.lib__grid` / `.srch__grid > .tile`), `phone/src/screens/Library.svelte:594,608`
- **Now:** `.lib__dim { opacity: .45; transition: opacity var(--dur-fast) linear; }` (`library.css:10`). The transition exists only on the dimmed state. A CSS transition uses the *new* style's `transition`, so dimming fades but un-dimming snaps to 1 in the same frame the new tiles replace the old ones. That reads as a hard cut. Measured: Title sort applied from the sheet, the grid was dimmed 0–100 ms and then snapped. A fast answer (< 180 ms) also gives a half-dim flicker, because the fade down never finishes before the snap back.
- **Change:** Put a transition on both states, and delay only the dim, so answers under 200 ms never dim:
  ```css
  .lib__grid, .srch__grid > .tile, .lib > div:has(> .state) { transition: opacity 220ms var(--ease-out); }
  .lib__dim { opacity: .45; pointer-events: none;
              transition: opacity var(--dur-fast) linear 200ms; } /* dim only if still waiting after 200 ms */
  ```
  When un-dimming, the new content "develops" from 0.45 to 1 over 220 ms. Keep `pointer-events: none` immediate, since it is not transitioned.
- **Why:** iOS never flashes a list between states. Content that is replaced settles in. A dim that only appears when something is really slow reads as calm.
- **Constraints & risks:** Opacity only, on the grid layer, so it is cheap. Reduced motion needs no change (a fade is allowed). Don't add `will-change`: the grid is huge.
- **Verify:** In the dev frame, open Movies → sort chip → pick Title → Show. The grid should ease from dim to full with no snap. Use DevTools network throttling (Slow 4G) to see the delayed dim appear.
- **Depends on / conflicts with:** SRCH-02 uses the same class. Do them together.

### SRCH-01 · Animate the search field into its focused state (title out, field up, Cancel in) — ✅ done
- **Done differently:** a FLIP with WAAPI instead of a View Transition (a VT snapshots the whole page — tab bar included — and cuts the content under the field with `animation: none` on root, and scales the field's text with its width; the FLIP also runs on iOS 17). The field's fill is now its own `.search__bg` layer that `scaleX`es from the old width, so text and icon don't stretch; Cancel rides in on the field's right edge; the title and a leaving Cancel are fading clones (`.srch__ghost`); the content below rides along (and fades in when Cancel swaps results for the categories). `DUR.springQuick` + `SPRING.smooth`; Reduce Motion = today's instant cut. Also: search mode now **survives a blur by scrolling** (`engaged` state, as UISearchController keeps Cancel up) — before, scrolling the categories with an empty focused field put the title back mid-scroll and jumped the page under the finger. Cancel restores the scroll position from before search mode.
- **Kind:** native · **Priority:** P1 · **Effort:** M
- **Files:** `phone/src/screens/Search.svelte` (`onfocus`, `cancel()`, `{#if !searching}<TopBar/>`), `phone/src/styles/library.css` (`.srch--on .search`)
- **Now:** Focus sets `focused = true`. The whole `TopBar` unmounts (`Search.svelte:289`) and the field becomes sticky with `padding-top: var(--page-top)`. Measured at 393 pt, in one frame:
  - the field jumps from y 143 to y 91
  - it shrinks from 353 to about 266 wide
  - *Cancel* appears
  - the bell and avatar vanish

  *Cancel* reverses this with the same cut. After typing, the browse cards are unmounted, and when you cancel they come back at scrollTop 0, not where you were.
- **Change:** Morph the state with a same-document View Transition. Safari 18+ supports it; on iOS 17 it falls back to today's cut.
  ```js
  function morph(fn) {
    if (!document.startViewTransition || reducedMotion()) return fn();
    document.documentElement.classList.add('vt-search');
    const t = document.startViewTransition(() => { fn(); return tick(); });
    t.finished.finally(() => document.documentElement.classList.remove('vt-search'));
  }
  // onfocus: morph(() => { focused = true; })   — focus itself already happened in the tap, so iOS still raises the keyboard
  // cancel(): morph(() => { term = ''; stop(); focused = false; }); then restore el.scrollTop = scrollY0
  ```
  ```css
  .srch .search__field { view-transition-name: srch-field; }
  .srch .search__cancel { view-transition-name: srch-cancel; }
  .srch .topbar { view-transition-name: srch-title; }
  html.vt-search::view-transition-old(root), html.vt-search::view-transition-new(root) { animation: none; }
  html.vt-search::view-transition-group(*) { animation-duration: 320ms; animation-timing-function: var(--ease-sheet); }
  html.vt-search::view-transition-new(srch-cancel):only-child { animation: 320ms var(--ease-sheet) both vt-slide-in; }
  html.vt-search::view-transition-old(srch-title):only-child { animation: 200ms var(--ease-out) both vt-fade-up; }
  @keyframes vt-slide-in { from { transform: translateX(24px); opacity: 0; } }
  @keyframes vt-fade-up { to { transform: translateY(-12px); opacity: 0; } }
  ```
  The field's group morphs position and width for free. Blur with a non-empty term (the Search key) must *not* morph, because nothing moves then.
- **Why:** In UISearchController the large title slides away, the field rises and narrows, and *Cancel* slides in from the right, all in about 0.3 s. It is the single most "native" moment on this tab.
- **Constraints & risks:**
  - A view transition captures the whole page. That is fine once per focus, but never run it per keystroke.
  - `view-transition-name` must be unique in the document. Only the Search route has these names, and Search is mounted once.
  - The caret isn't drawn during the 320 ms, because the input is a snapshot. That is acceptable.
  - Check that no other auditor's push/pop uses View Transitions at the same moment. The router uses WAAPI today.
  - If View Transitions turn out to be unreliable with the keyboard animation on a real iPhone, fall back to a FLIP of `.search` (translateY) plus a WAAPI slide-in of `.search__cancel`, and accept the width cut.
- **Verify:** Desktop Chrome in the dev frame (Chrome supports View Transitions): tap the field, then Cancel, with `rm=1` for the instant path. The keyboard interplay can only be checked on an iPhone.
- **Depends on / conflicts with:** SRCH-03 (field styling). Cross-ref Navigation: if they adopt View Transitions for push, share the `vt-*` class convention.

### SRCH-02 · Stop dimming search results on every keystroke — ✅ done
- **Done:** `stale = loading && searched !== q`, plus LIB-01's delayed dim / eased un-dim. Measured: typing " par" after "dune" no longer dims (was 0.45 from the first keystroke for ~2.7 s); with a 1.2 s lookup the grid dims ~200 ms after the lookup starts and eases back when it lands.
- **Kind:** bug / craft · **Priority:** P1 · **Effort:** S
- **Files:** `phone/src/screens/Search.svelte:196,355`
- **Now:** `current = searched === q && !loading` turns false on the first keystroke. Every addable tile then gets `lib__dim` at once and stays dimmed through the 350 ms debounce plus the lookup, which measured about 1 s for "dune" and over 2.5 s for "br". Typing "dune part" makes the grid pulse dim and bright once per pause, and the snap back has the same bug as LIB-01.
- **Change:** Take the delayed dim and eased un-dim from LIB-01. Also only dim when the on-screen answer is actually stale *and* a lookup is in flight (`loading`), not during the debounce:
  ```js
  const stale = $derived(loading && searched !== q);
  // class={stale ? 'lib__dim' : ''}
  ```
  With the 200 ms transition delay, fast typists never see a dim. After a pause it fades to 0.45 and comes back smoothly.
- **Why:** iOS search results stay put while you type and update in place. Flicker reads as nervousness.
- **Constraints & risks:** `countLine` still says "Searching…". Keep that, because it is the honest signal. The skeleton tiles (first query) stay as they are.
- **Verify:** In the dev frame, type "dune", wait, then type " p" quickly. There should be no dim unless the lookup takes more than 200 ms, and no snap when the answer lands.
- **Depends on / conflicts with:** LIB-01.

### LIB-02 · Confirm a quick-add on the tile itself (spinner, then a gold check) → Lane B (with HOME-10, same `Tile.svelte` button) — ✅ done
> Wave 2 (agent 3): CollectionRail passes `addState` (not for the page's own film or one downloading) with `onadd` only for idle/error. LookupDetail's *Add to library* is **one** gold button through the states — "+ Add to library" → spinner "Adding…" → a ✓ popping in (`scale .6`, `DUR.springQuick`, `springEase.bouncy`) with "Added", held 1.2 s only if the page saw the add — then the grey status button cross-fades in; a download starting wins at once (`.btn--added`, `.btn__check` in detail.css). Measured (POST stubbed, 900 ms): rail spinner at 100 ms, ✓ at 1.1 s, gone at 2.3 s, route unchanged; LookupDetail one element in the morph cell through spinner → ✓ "Added" (1.0–2.0 s) → "Added — looking for a download" at 2.5 s, `getAnimations()` empty after.
> Wave 1 · B (+ HOME-10): Tile `addState` keeps the disc while `adding` (14 px spinner, `aria-disabled`, a tap is a no-op and doesn't open the tile), then a gold ✓ that pops in (`scale .6 → 1`, `DUR.springQuick`, `springEase.bouncy`), holds 1.2 s (a Tile `$effect` + timer — only if this tile saw the add; mounted already `done` shows nothing) and leaves with `scale .8` + fade (`DUR.fast`, ease-in). `error` and an Undo (`done → idle`) bring the "+" back; a download ring replaces it. Wired in `resultTile()` (Chart + Search) and Home's Trending. Measured with the POST stubbed in CDP: spinner at 100 ms, ✓ at ~1 s, gone by ~2.1 s, one request, route unchanged. CollectionRail and LookupDetail's Add button are lane D's (cross-lane).
- **Kind:** craft / native · **Priority:** P1 · **Effort:** M
- **Files:** `phone/src/screens/Chart.svelte` (`resultTile()`, lines 58–79), `phone/src/components/Tile.svelte` (the `onadd` button, owned by Foundation), `phone/src/styles/components.css` (`.tile__add`), read-only `src/lib/lookup.svelte.js` (`addState`)
- **Now:** Tapping "+" calls `addToLibrary`, which sets `adds[k] = 'adding'`. `resultTile` then returns `onadd: null`, so the button **vanishes** in the same frame (`Chart.svelte:77`). The tile looks exactly like a library title until the activity poll (up to 4 s, longer while the arr searches) brings a download ring, or forever if nothing gets grabbed. The only feedback is the toast.
- **Change:** Give Tile an `addState` prop (`'idle'|'adding'|'done'|null`) and keep the 30 pt disc mounted while adding:
  - `'adding'`: the disc keeps its glass look. The "+" is replaced by a 14 px `.spinner` (border 2 px) and the button is disabled.
  - `'done'`: the disc turns gold (`--gold`, `--text-on-gold` check icon). It enters with Svelte `in:scale={{ start: .6, duration: 300, easing: backOut }}`, holds for 1.2 s, then `out:fade={{ duration: 200 }}`. Drive it with a local `$state` and a `setTimeout` in Tile, not a CSS animation: routes are toggled with `[hidden]`, which restarts CSS animations.
  - `'error'`: the "+" comes back (the current behaviour).
  - Once `download` is set, the ring replaces everything, as today.

  `resultTile` passes `addState: st` whenever `!g`, and keeps `onadd` only for idle/error.
- **Why:** The App Store's GET → progress ring → OPEN teaches that the button you tapped answers. A vanishing control reads as "did it work?". The check doesn't stay, which honours the round-3 decision: no permanent library badge.
- **Constraints & risks:**
  - Tile belongs to Foundation. The spinner is an infinite animation, but it lives only while `adding` (usually under 1 s).
  - Reduced motion: no scale, just swap the icons.
  - Optional haptic: see Cross-refs, the iOS 18 `<input switch>` trick.
  - ⚠️ Never test with a real add. Stub `mlLibraryAdd` in DevTools, or set `adds['movie:<id>'] = 'adding'` / `'done'` by hand via the module.
- **Verify:** In the dev frame, open a chart and, from the console, import `/@fs/.../src/lib/lookup.svelte.js` and set `adds[...]` to `'adding'`, then `'done'`. Check the spinner, the gold check pop and the fade.
- **Depends on / conflicts with:** Detail's LookupDetail Add button (another area) should use the same visual language. Share the `.tile__add--busy/--done` look.

### LIB-03 · Give Segmented a sliding thumb (UISegmentedControl) → merged into MOT-07
- **Kind:** native / craft · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/components/Segmented.svelte`, `phone/src/styles/components.css:637–646` (`.seg`, `.seg__opt--active`)
- **Now:** The active option is a background colour on the chosen button (`transition: background-color 180ms`). The selection cross-fades between two places instead of travelling. Used in the Sort sheet (Order), Settings (Subtitles mode, Size, Streaming) and the player's TrackPanel.
- **Change:** Add one thumb element behind the options:
  ```svelte
  <div class="seg" style="--n:{opts.length}; --i:{Math.max(0, opts.findIndex(o => o.value === value))}">
    <span class="seg__thumb" aria-hidden="true"></span> …buttons…
  </div>
  ```
  ```css
  .seg { position: relative; }
  .seg__thumb { position: absolute; top: 2px; bottom: 2px; left: 2px;
    width: calc((100% - 4px - (var(--n) - 1) * 2px) / var(--n));
    border-radius: calc(var(--r-field) - 2px); background: var(--surface-press); box-shadow: 0 1px 4px rgba(0,0,0,.35);
    transform: translateX(calc(var(--i) * (100% + 2px)));
    transition: transform 280ms var(--ease-sheet); }
  .seg__opt { position: relative; z-index: 1; }
  .seg__opt--active { background: none; box-shadow: none; }
  .seg:has(.seg__opt--active:active) .seg__thumb { scale: .96; transition: transform 280ms var(--ease-sheet), scale 110ms var(--ease-out); }
  @media (prefers-reduced-motion: reduce) { .seg__thumb { transition: none; } }
  ```
  Option text colour keeps its 180 ms colour transition.
- **Why:** The thumb gliding, and squeezing slightly under the finger, is the signature of iOS segmented controls. The current jump looks like web tabs.
- **Constraints & risks:** The thumb lives on a small layer and only animates on change. Equal widths are already enforced by `flex: 1 1 0`. Check the three-option Quality variant in TrackPanel (player area) and the `::after` 44 pt hit extension.
- **Verify:** Sort sheet → Order, Settings → Subtitles. Toggle, then check `rm=1`.
- **Depends on / conflicts with:** LIB-04 reuses it. Cross-ref Player (TrackPanel) and Settings owners.

### LIB-04 · Chart filter: use a segmented control and keep the reader's place — ✅ done
- **Done:** Segmented in `.chart__seg`; the skeleton is one full-width pill. The grid fades in with a WAAPI opacity on `.chart__grid`/`.chart__section` (`DUR.fast`, skipped under Reduce Motion) instead of a `{#key}` remount, which would re-mount up to 250 tiles (~90 ms). Measured: tapping "In library" with the control half under the bar → 10 tiles, control at y 115 (the bar's bottom); with it fully visible the page doesn't move. SPEC §2 notes the deviation.
- **Kind:** native · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/screens/Chart.svelte:241–245`, `phone/src/styles/library.css` (`.chart__chips`)
- **Now:** "All / Not in library / In library" are three chips, but they are a single choice (one of three is always on). Switching swaps the grid in one frame (250 → 10 tiles, measured). From deep in the list the page clamps to wherever the shorter grid ends.
- **Change:**
  - Replace the chips with `<Segmented options={[{value:'all',label:'All'},{value:'out',label:'Not in library'},{value:'in',label:'In library'}]} bind:value={filter} label="Filter" />` inside a `padding: 0 var(--gutter) var(--s-4)` wrapper. It fits at 375 pt: 13 pt semibold, about 100 pt per option.
  - On change, if `el.scrollTop` is past the header, jump the scroller so the control sits under the nav bar: `el.scrollTop = segEl.offsetTop - navbarH`. That keeps the context instead of landing mid-grid.
  - Fade the grid in: a keyed `{#key filter}<div in:fade={{duration:160}}>…{/key}`, or reuse LIB-01's transition.
- **Why:** iOS uses a segmented control for mutually exclusive views of one list (App Store Top Charts: Paid | Free). Chips mean independent toggles, as in the Library's Unwatched chip.
- **Constraints & risks:** Differs from the design mock `07-search--ranked.html` (chips). This is a deliberate native-feel deviation, so note it in `SPEC.md` §2. The skeleton row (`Chart.svelte:236`) becomes one `Skeleton kind="pill"` at full width.
- **Verify:** In the dev frame, open IMDb Top 250, scroll to #40, and tap "In library". The control should pin under the bar and 10 tiles fade in.
- **Depends on / conflicts with:** LIB-03.

### SRCH-03 · Make the field look like an iOS search field (filled clear button, tinted caret) — ✅ done
- **Done:** filled clear disc scoped to `.search .search__clear .i` (Login's password eye reuses `.search__clear`), gold caret, clear button fades in (`DUR.press`). The pressed states already existed via `.pressing` (Wave 0).
- **Kind:** native · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/styles/components.css:547–558` (`.search__*`), or `library.css` overrides; `phone/src/screens/Search.svelte:314–318`
- **Now:** The clear button is a bare faint "x" stroke (`Icon name="x"`), and the caret is the UA default (white). There is no pressed state on Clear or *Cancel*.
- **Change:**
  - Draw the clear button as iOS's `xmark.circle.fill` with CSS on the existing icon: `.search__clear .i { width: 17px; height: 17px; padding: 3.5px; border-radius: 50%; background: var(--text-faint); color: var(--surface-2); stroke-width: 3; }`.
  - Add `.search__input { caret-color: var(--gold); }`.
  - Add `.search__cancel:active, .search__clear:active { opacity: .55; transition: opacity var(--dur-press) var(--ease-out); }`, as `.toast__action` already does.
  - Optional: fade the clear button in with `in:fade={{duration:120}}` when the first character is typed.
- **Why:** These are small details you would notice on a native field. The tinted caret ties it to the app's accent, which is what UIKit's `tintColor` does.
- **Constraints & risks:** Keep the 44 pt hit (`.search__clear` is already 44×44). Keep `onpointerdown` preventDefault so the keyboard stays up.
- **Verify:** In the dev frame, type in Search and compare against an iOS screenshot.
- **Depends on / conflicts with:** SRCH-01.

### SRCH-04 · Show recent searches when the field is focused and empty — ⏸ awaiting decision
- **Kind:** native · **Priority:** P2 · **Effort:** M
- **Files:** `phone/src/screens/Search.svelte` (new block while `focused && !term`), `phone/src/styles/library.css`
- **Now:** Focusing an empty field shows the browse cards unchanged. Nothing remembers what you searched.
- **Change:**
  - Keep the last 8 queries per account in `localStorage` under `reel.recentSearches.<cfg.userId>`, read and written with try/catch.
  - Record a query only when a result is opened (`openResult`) or the Search key is pressed. Never record per keystroke.
  - While focused and empty, render above the categories a `group__label` "Recent" with a text button "Clear" on the right, then a `.list` of `Row`s: title = the query, leading `search` icon in faint, no chevron. Tapping one fills `term` and calls `run()`.
  - Long-press or swipe-to-delete is not needed.
  - Fade the block in with `in:fade={{duration:160}}`.
- **Why:** The TV app, Music and the App Store all show Recents the moment the field is focused. It is the most common "native" expectation of a search tab.
- **Constraints & risks:** A per-viewer convenience, so `localStorage` is right, as with `reel.libview`. Account switch reloads the app, so reading the key once at mount is enough. Keep it out of the TV build: the component is phone-only.
- **Verify:** In the dev frame, search "dune", open a result, go back, clear, and focus again. "dune" should be listed.
- **Depends on / conflicts with:** SRCH-01 (appears inside the focused state).

### LIB-05 · Fade the chip row's right edge when it overflows — ⏳ later round
- **Kind:** craft · **Priority:** P2 · **Effort:** S
- **Files:** `phone/src/screens/Library.svelte:574–582`, `phone/src/styles/library.css` (`.lib .chips`)
- **Now:** At 393 and 375 pt the Genre chip is cut mid-word or mid-chevron at the screen edge ("Genre ⌄" → "Genre"). This is visible in `se-movies.png` and `movies.png`. It looks like a layout bug rather than a scroll affordance.
- **Change:** Toggle a class when the row can scroll further right: a `scroll` listener plus a `ResizeObserver` on the row, with `more = row.scrollLeft + row.clientWidth < row.scrollWidth - 1`. Then:
  ```css
  .lib .chips--more { -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 32px), transparent); mask-image: …same…; }
  ```
  Alternatively, shrink the sort chip's label to the sort name without "Recently" (`Added`) at < 400 pt.
- **Why:** iOS filter rows (Music, Photos) fade their overflowing edge so the cut reads as "more this way".
- **Constraints & risks:** A static mask costs nothing when idle. Only toggle the class on change. Landscape fits all three chips, so no mask there.
- **Verify:** In the dev frame, `device=375` and `393`: the edge should fade; scrolling the chips fully left should remove the fade.
- **Depends on / conflicts with:** None.

### LIB-06 · Show the paging spinner only while a page is loading → merged into MOT-12 (done in Wave 0)
- **Kind:** perf · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/screens/Library.svelte:635–644`
- **Now:** Whenever `items.length < total`, the sentinel carries an infinitely rotating `.spinner`, even while nothing is fetching and the row is screens below. It is mounted with the first page of any library over 126 titles, and nothing hides it idle. That breaks the "cost nothing when idle" rule.
- **Change:** Keep the sentinel `div` (the IntersectionObserver needs it) and render `<span class="spinner">` inside it only when `more` is true. Optionally fade it in after 300 ms (`animation-delay`) so fast pages never show it.
- **Why:** An idle page should keep the compositor quiet. On the TV an always-running spinner measured about 4–10 % of a core.
- **Constraints & risks:** None. The row keeps its 64 px `min-height`, so the layout doesn't jump.
- **Verify:** Use `?libpage=4` on a larger library (or Shows with `libpage=2`). In DevTools Performance, no animation frames should be produced while idle mid-grid.
- **Depends on / conflicts with:** None.

### LIB-07 · Stretch the large title on the top rubber band → merged into NAV-12
- **Kind:** native · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/screens/Library.svelte` (`onScroll`), `phone/src/screens/Search.svelte` (`onScroll`), `phone/src/components/TopBar.svelte` (Foundation, `.topbar__title`)
- **Now:** Pulling past the top of Movies, Shows or Search bounces the page. The large title moves with it but stays the same size. There is no pull-to-refresh (by design).
- **Change:** In the existing scroll handlers, when `scrollTop < 0` (iOS reports negative values during the bounce, and `overscroll-behavior: contain` keeps the bounce), set `titleEl.style.transform = 'scale(' + (1 + Math.min(-scrollTop, 120) / 600) + ')'` with `transform-origin: left bottom`. Clear it when `scrollTop >= 0`. Only write on change.
- **Why:** UIKit's large titles grow slightly as you pull down. It is a small detail that marks the header as native.
- **Constraints & risks:** Transform on one text layer, and only during an overscroll. Skip it under reduced motion. It needs a TopBar hook (a `titleEl` bindable, or a CSS variable `--pull` on `.topbar`). This could live in Foundation's TopBar so Home gets it too.
- **Verify:** iPhone only. Desktop Chrome doesn't rubber-band.
- **Depends on / conflicts with:** Cross-ref Navigation/TopBar owner.

### SRCH-05 · Don't blank the page on the first letter — ⏳ later round
- **Kind:** craft · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/screens/Search.svelte:325–327`, `175–189` (`localHits`)
- **Now:** Typing one letter unmounts the browse cards and shows only "Type one more letter…" on an empty page. The second letter then brings in six pulsing skeletons. That is three different screens within about 300 ms.
- **Change:** For `q.length === 1`, show the instant library matches whose (article-stripped) title *starts with* the letter (score ≥ 3 in `localScore`), capped at 9. If there are none, keep the "Type one more letter…" line but leave it at `search__count` style so the page doesn't jump. No lookup is fired, so the network behaviour stays the same.
- **Why:** iOS search starts answering at the first character. An empty page reads as "nothing happened".
- **Constraints & risks:** The index is loaded on focus (`loadIndex()`), so this is instant. For the 2-character path, keep the library-matches-first order so tiles don't reshuffle.
- **Verify:** In the dev frame, type "m" in Search: the library titles starting with M should appear immediately.
- **Depends on / conflicts with:** None.

### SRCH-06 · Fade newly arriving result tiles in (search and chart only) — ⏳ later round
- **Kind:** craft · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/screens/Search.svelte:347–361`, `phone/src/screens/Chart.svelte:252–255`
- **Now:** When the lookup lands, skeletons are replaced by all tiles in one frame (23 at once for "dune"). Refining a query swaps tiles in place, and survivors jump to new positions.
- **Change:** Add `in:fade={{ duration: 160 }}` on the keyed tiles of the *add* section, so only newly inserted tiles fade. Svelte 5 transitions are local, so this doesn't play on remount or on un-hide. Nothing else: no stagger and no FLIP.
- **Why:** New content that settles in feels considered. More than a quick fade would feel busy on a screen you type into.
- **Constraints & risks:**
  - Use a Svelte transition, **not** a CSS `@keyframes` on insertion. Routes are toggled with `[hidden]`, which restarts CSS animations, so every tab switch would re-fade the grid.
  - Don't apply it to the Library grid (126-tile pages).
  - `in:` can't be put on a component, and a `display: contents` wrapper can't carry an opacity transition. Either add an `intro` prop to Tile that puts `in:fade` on its root (Foundation's file), or wrap each tile in a `.srch__cell` div that becomes the grid item.
- **Verify:** In the dev frame, type "dune", then " part": new tiles fade and old ones don't re-fade.
- **Depends on / conflicts with:** SRCH-02.

### LIB-08 · Let the category card's poster fan spread under the finger — ⏳ later round
- **Kind:** craft · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/styles/components.css:562–583` (`.catcard__poster:nth-child(n)`)
- **Now:** Pressing a card only scales the whole card by 0.96.
- **Change:**
  ```css
  .catcard__poster { transition: transform 220ms var(--ease-spring); }
  .catcard:active .catcard__poster:nth-child(1) { transform: translateX(-34px) rotate(-14deg); }
  .catcard:active .catcard__poster:nth-child(2) { transform: translateY(-7px); }
  .catcard:active .catcard__poster:nth-child(3) { transform: translateX(34px) rotate(14deg); }
  @media (prefers-reduced-motion: reduce) { .catcard__poster { transition: none; } }
  ```
- **Why:** A small, discoverable delight that says the card holds a stack of titles. It only moves while pressed.
- **Constraints & risks:** Three small transformed layers, only during a press. Don't add rest shadows or blur: the TV found blurred rotated shadows expensive, and the phone should stay flat too.
- **Verify:** In the dev frame, press and hold a catcard.
- **Depends on / conflicts with:** None. Leave global press-state tokens to the Motion auditor.

### LIB-09 · Pop the watched tick when a long-press marks a title — ⏳ later round
- **Kind:** craft · **Priority:** P3 · **Effort:** S
- **Files:** `phone/src/components/Tile.svelte` (the `tile__corner tick` span, Foundation), used by `Library.svelte:toggleWatched`
- **Now:** "Mark as watched" swaps the tick in, and dims the art to 0.72, in one frame behind the closing menu. The toast is the only acknowledgement.
- **Change:** `{:else if tWatched && !dl}<span class="tile__corner tick" in:scale={{ start: .5, duration: 280, easing: backOut }} out:fade={{ duration: 120 }}>`. Local transitions play only when the flag toggles, not when the grid mounts. Add `.tile__frame > .art { transition: opacity var(--dur-base) var(--ease-out); }` so the dim eases too.
- **Why:** The change happens where the eye is. iOS confirms state changes in place (Mail's flag, Photos' heart).
- **Constraints & risks:** Verify it doesn't play on first mount or on a revalidation that doesn't change `Played` (keyed each, same item). Skip the scale under reduced motion.
- **Verify:** In the dev frame, long-press a Library tile → Mark as watched, *with a stubbed `setPlayed`* (never a real mutation). Then undo it by hand.
- **Depends on / conflicts with:** Motion auditor (press states), LIB-02 (same Tile edits).

## Considered and rejected
- **A–Z section index scrubber:** the library is 12 movies and 7 shows. It only makes sense for Title sort, and with server-side paging it would need `NameLessThan` counts and loading pages up to the letter. Revisit above about 300 titles.
- **Pinch-to-zoom grid density (Photos-style):** SPEC §7 decided 3 columns (4 makes titles too small), landscape already uses 6, and a pinch on a scroller fights iOS's own gestures. `zoom.js` is the tile→page zoom, not a grid pinch.
- **Pull-to-refresh on Library:** decided against in CLAUDE.md. The app refreshes itself (`freshness.svelte.js`).
- **FLIP-animating result reordering while typing:** motion on every keystroke is exactly the "overloaded" feel to avoid.
- **Staggered tile entrance on Library pages:** 126 tiles per page, mounted off-screen in slices. It costs main-thread time and is invisible anyway.
- **iOS 26-style search field at the bottom of the tab bar:** the tab bar is a custom capsule owned by Navigation, and moving the field is a redesign, not polish.
- **Library/add status badges on search/chart tiles:** round 3 decided the "+" is the only mark. LIB-02's check is transient on purpose.
- **Animating the Sort sheet's "Show N" count:** the number changes rarely and the sheet is dismissing at that moment anyway.

## Cross-refs
- **Motion / micro-interactions:**
  - Poster images pop in when decoded, and there is no generic `img` fade in `Art.svelte`. A 160 ms opacity fade on `load`, for lazy posters only, would lift every grid.
  - `.skel` pulse runs while mounted; the long "br" lookup kept 6 skeletons pulsing for more than 2.5 s. That is fine, but make sure skeletons unmount promptly.
- **PWA shell / platform:** iOS 18 Safari fires a light haptic when a `<input type="checkbox" switch>` is toggled through its `<label>`. A shared `haptic()` helper (hidden switch plus label click) would serve LIB-02 (add done), long-press menus and the Up Next roll. It does nothing on iOS 17. `navigator.vibrate` doesn't exist on iOS.
- **Navigation:**
  - The landscape tab bar covers about 40 % of the 393 pt height over the Library grid (`land-movies.png`). Consider a slimmer landscape tab bar, or hiding it on scroll-down.
  - If push/pop ever moves to View Transitions, coordinate names with SRCH-01.
- **UX-AUDIT open item "Landscape Library/Search/Chart grids start at x = 134":** appears **fixed**. `library.css` no longer adds `--safe-*` padding and the grid starts at x ≈ 75 at 852×393. Mark it done in `UX-AUDIT.md`.
- **Detail (LookupDetail):** its *Add to library* button should share LIB-02's adding/done language (spinner → gold check), so the add moment reads the same everywhere.
- **Sheets:** in the Sort sheet, `setView` runs before `closeSheet()`, so the grid re-queries under the sliding sheet. That is fine with LIB-01's eased un-dim. There is no change needed in the sheet mechanics.
