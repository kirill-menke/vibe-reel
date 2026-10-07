<script>
  import { S, onBack, openSearch, closeSearch, closeSearchChart } from '../lib/nav.svelte.js';
  import { LV, closeMenu } from '../lib/libview.svelte.js';
  import { HM, HM_BUTTON } from '../lib/header.svelte.js';
  import { MY } from '../lib/me.svelte.js';
  import { backToList } from './MyLibraryMenu.svelte';
  import {
    spatialMove, focusNow, focusKey, playerButtons, focusEl, ensureVisible,
    marqueeFocus, clearMarquee, byKey, hasKey, scrollElTo
  } from '../lib/focus.js';
  import {
    P, seekBy, togglePause, showOsd, hideOsd, exitPlayer, closePanel, videoEl,
    skipVisible, skipSegment, upNextVisible, playNext, dismissUpNext, scrubBy, commitScrub, cancelScrub,
    SEEK_BACK, SEEK_FWD
  } from '../lib/player.svelte.js';
  import { takeUndo } from '../lib/toast.svelte.js';

  /* webOS remote keycodes: 461 Back, 415 Play, 19 Pause, 413 Stop, 412 Rewind,
   * 417 FastForward, 13 OK, 37–40 arrows. */
  /* Generic hold for any element carrying `data-hold`: tap = its click, hold =
   * an `okhold` DOM event on it (the watched toggle on episode rows and season
   * pills). The element handles the event itself — Keys only times the press. */
  /** @type {{ down: boolean, fired: boolean, timer: ReturnType<typeof setTimeout> | null, el: HTMLElement | null }} */
  const hOk = { down: false, fired: false, timer: null, el: null };

  /** @param {number} k keyCode @param {KeyboardEvent} e @returns {boolean} true = handled */
  function playerKey(k, e) {
    const video = videoEl();
    /* The playback error card is modal: Back leaves the player, the D-pad moves
     * between Retry and Back, OK presses. Nothing else means anything. */
    if (P.error) {
      e.preventDefault();
      if (k === 461 || k === 27 || k === 413) exitPlayer();
      else if (k >= 37 && k <= 40) spatialMove(k);
      else if (k === 13 && !e.repeat) {
        const a = /** @type {HTMLElement | null} */ (document.activeElement);
        if (a && a !== document.body && a.closest('#play-error')) a.click();
        else focusKey('err-retry');
      }
      return true;
    }
    /* Until the first frame is up the backdrop card covers the player: only
     * Back/Stop (give up) mean anything — the OSD would open behind the card. */
    if (P.loading && !P.panel) {
      e.preventDefault();
      if (k === 461 || k === 27 || k === 413) exitPlayer();
      return true;
    }
    if (k === 415) {
      e.preventDefault();
      video?.play()?.catch(() => {});
      showOsd();
      return true;
    }
    if (k === 19) {
      e.preventDefault();
      video?.pause();
      showOsd();
      return true;
    }
    if (k === 413) {
      e.preventDefault();
      exitPlayer();
      return true;
    }
    // Same steps as the OSD's ⏪/⏩ buttons (SEEK_BACK / SEEK_FWD).
    if (k === 417) {
      e.preventDefault();
      seekBy(SEEK_FWD);
      return true;
    }
    if (k === 412) {
      e.preventDefault();
      seekBy(-SEEK_BACK);
      return true;
    }

    const menuOpen = !!P.panel;
    /* The Up Next card works like the Skip Intro chip below: with the OSD down
     * it is the only thing on screen, so OK plays the next episode and Back
     * dismisses the card (keep watching the credits) instead of leaving the
     * player; with the OSD up, focus decides. */
    const onNext = upNextVisible() && (!P.osdShown || /** @type {HTMLElement | null} */ (document.activeElement)?.dataset?.focus === 'c-next');
    if (onNext && (k === 461 || k === 27)) {
      e.preventDefault();
      dismissUpNext();
      return true;
    }
    if (onNext && k === 13) {
      e.preventDefault();
      playNext();
      return true;
    }
    if (k === 461 || k === 27) {
      e.preventDefault();
      // Back mid-scrub abandons the previewed position and stays put.
      if (cancelScrub()) return true;
      if (menuOpen) closePanel();
      else if (P.osdShown) hideOsd();
      else exitPlayer();
      return true;
    }
    /* The Skip Intro chip lives outside the OSD and grabs focus when it appears,
     * so OK on it has to be answered before the wake-the-OSD catch-all below —
     * one press skipping the intro is the entire point of the chip. */
    if (
      k === 13 &&
      skipVisible() &&
      // With the OSD down the chip is the only thing on screen, so OK is its
      // press wherever focus happens to sit; with the OSD up, focus decides.
      (!P.osdShown || /** @type {HTMLElement | null} */ (document.activeElement)?.dataset?.focus === 'c-skip')
    ) {
      e.preventDefault();
      skipSegment();
      return true;
    }
    /* ◀▶ with the OSD down seek straight away (the same steps as ⏪/⏩) and
     * bring the OSD up on the scrubber, so the next presses keep scrubbing —
     * with trickplay previews where the item has them (scrubBy below). */
    if (!P.osdShown && !menuOpen && (k === 37 || k === 39)) {
      e.preventDefault();
      seekBy(k === 39 ? SEEK_FWD : -SEEK_BACK);   // seekTo() raises the OSD
      focusNow('c-scrub');
      return true;
    }
    if (!P.osdShown && !menuOpen) {
      e.preventDefault();
      showOsd();
      focusKey('c-play');
      return true;   // any key wakes the OSD
    }

    if (k >= 37 && k <= 40) {
      e.preventDefault();
      if (menuOpen) {
        spatialMove(k);   // panel list: geometric up/down
        return true;
      }
      // OSD transport: ◀▶ cycle the button row and never touch the scrubber;
      // the scrubber is reached only with ▲ (and ▼ returns to the buttons). On
      // the scrubber, ◀▶ seek.
      const af = /** @type {HTMLElement | null} */ (document.activeElement);
      const onScrub = af?.dataset?.focus === 'c-scrub';
      if (k === 37 || k === 39) {
        if (onScrub) {
          scrubBy(k === 39 ? 1 : -1, e.repeat);
          showOsd();
          return true;
        }
        const btns = playerButtons();
        const i = btns.indexOf(/** @type {HTMLElement} */ (af));
        if (i < 0) focusEl(btns[0]);
        else focusEl(btns[Math.max(0, Math.min(btns.length - 1, i + (k === 39 ? 1 : -1)))]);
        showOsd();
        return true;
      }
      if (k === 38) {
        focusNow('c-scrub');
        showOsd();
        return true;
      }
      if (k === 40) {
        if (onScrub) {
          commitScrub();   // leaving the scrubber lands the previewed position
          const pb = playerButtons();
          focusEl(pb[1] || pb[0]);
        }
        showOsd();
        return true;
      }
      return true;
    }

    if (k === 13) {
      e.preventDefault();
      const a = /** @type {HTMLElement | null} */ (document.activeElement);
      // OK on the scrubber lands a previewed position, else it is play/pause (not a 0-seek)
      if (a?.dataset?.focus === 'c-scrub') commitScrub() || togglePause();
      else if (a && (a.classList.contains('focus') || a.classList.contains('opt'))) a.click();
      else togglePause();
      showOsd();
      return true;
    }
    return false;
  }

  /** @param {KeyboardEvent} e */
  function onKeyDown(e) {
    const k = e.keyCode;
    if (S.screen === 'player' && playerKey(k, e)) return;

    // Play while an undoable toast is up (Home's "Removed from …"): undo it.
    if (k === 415 && S.screen !== 'player' && takeUndo()) {
      e.preventDefault();
      return;
    }

    if (k === 461 || k === 27) {
      e.preventDefault();
      // An open library-bar dropdown closes first, back onto its pill.
      if (LV.open) {
        const pill = 'lv-' + LV.open;
        closeMenu();
        focusKey(pill);
      } else if (HM.open === 'mylib-del' && MY.confirm) {
        // My library's delete confirmation: back to the list, on that row's Delete
        backToList();
      } else if (HM.open) {
        const btn = HM_BUTTON[HM.open];
        HM.open = null;
        focusKey(btn);
      } else if (S.search && S.searchKb) {
        // Search's keyboard closes first, back onto the bar
        S.searchKb = false;
        focusKey('q2');
      } else if (S.search && S.searchChart) focusKey(closeSearchChart());
      else if (S.search) hideSearch();
      else if (!backToTabs()) onBack();
      return;
    }

    const el = /** @type {HTMLElement | null} */ (document.activeElement);
    const isText = el && el.tagName === 'INPUT';

    if (k === 13) {
      if (isText && el.dataset.focus === 'p') {
        /** @type {HTMLElement | null} */ (document.querySelector('[data-focus="login"]'))?.click();
        return;
      }
      if (isText) return;
      /* An OK still held from a hold gesture keeps auto-repeating until keyup.
       * Once the hold has acted and moved focus (a removed Home tile hands it
       * to a neighbour — possibly a Trending tile, whose detail page focuses
       * "Add to library"), those repeats must not press whatever focus landed
       * on. A fresh (non-repeat) press means the keyup was lost: start over. */
      if (hOk.down && !e.repeat) {
        clearTimeout(hOk.timer);
        hOk.down = false;
        hOk.el = null;
      }
      if (hOk.down) {
        e.preventDefault();
        return;
      }
      if (el?.dataset?.hold != null) {
        e.preventDefault();
        if (!hOk.down) {
          hOk.down = true;
          hOk.fired = false;
          hOk.el = el;
          hOk.timer = setTimeout(() => {
            hOk.fired = true;
            el.dispatchEvent(new CustomEvent('okhold'));
          }, 500);
        }
        return;
      }
      if (el && (el.classList.contains('focus') || el.classList.contains('opt'))) {
        e.preventDefault();
        el.click();
      }
      return;
    }

    if (k >= 37 && k <= 40) {
      if (isText && (k === 37 || k === 39)) return;
      e.preventDefault();
      /* ▼ off the tab bar into a library grid always lands on the grid's FIRST
       * tile. Pure geometry picked whichever column happened to sit under the
       * pill — the Shows pill is ~470px in, i.e. column 2 — which made the entry
       * point depend on the tab's label width, and skipped the pending tiles
       * that lead the grid. The grid is one sorted list; its head is the only
       * meaningful way in, whatever that tile's download state is. The sort /
       * filter pills share the tab row (LibraryBar.svelte), so they get the
       * same ▼ — and with no grid (a filter matched nothing) it falls through
       * to geometry, which finds the empty state's Clear filters button. */
      /* ▲ past the top of the tab bar raises Search in its place. The tab bar
       * is the topmost row of every screen that has one, so this ▲ had nowhere
       * to go before. */
      if (k === 38 && !S.search && el?.classList?.contains('tab')) {
        showSearch();
        return;
      }
      if (k === 40 && S.screen === 'library' && !LV.open && !HM.open && ['tab', 'lvbtn', 'hbtn'].some((c) => el?.classList?.contains(c))) {
        const first = document.querySelector('.grid > .focus');
        if (first) {
          focusEl(first);
          return;
        }
      }
      spatialMove(k);
    }
  }

  /* Back from deep in a Home rail or a library grid first returns to the top
   * — the page glides up and focus lands on the current tab — and only a Back
   * from the tab row leaves (library → Home). Before, Back from row 20 of the
   * grid jumped straight to Home, and on Home it did nothing at all, so the
   * only way back up a long page was holding ▲. */
  function backToTabs() {
    if (S.screen !== 'home' && S.screen !== 'library') return false;
    const a = document.activeElement;
    if (!a || a === document.body || a.closest('.top')) return false;
    const tab = byKey('tab-' + S.tab);
    if (!tab) return false;
    // Focus first: on Home the tab row is sticky while a rail has focus, so the
    // tab's own ensureVisible() would retarget the glide to ~106 px up from
    // where it is. The absolute target has to be the last one set.
    focusEl(tab);
    scrollElTo(tab.closest('.page'), 0);
    return true;
  }

  // Search.svelte puts focus in its bar once it is up.
  function showSearch() {
    openSearch();
  }

  function hideSearch() {
    const back = closeSearch();
    // in the browse scope now (closeSearch() lowered S.search), not in #search (R-2)
    focusKey(back && hasKey(back) ? back : 'tab-' + S.tab);
  }

  /* The Magic Remote's wheel reaches Search the same way: scrolling up while
   * the page is already at its top. Only a *fresh* gesture counts — the tail of
   * a flick that has just carried a long grid up to the top must not overshoot
   * into Search. */
  let lastWheel = 0;
  /** @param {WheelEvent} e */
  function onWheel(e) {
    const now = e.timeStamp;
    const fresh = now - lastWheel > 300;
    lastWheel = now;
    if (!fresh || e.deltaY >= 0 || S.search) return;
    // An open dropdown (bell, account/settings, sort/genre) scrolls on its own;
    // wheeling it back up must not raise Search over it with the page at 0.
    if (LV.open || HM.open) return;
    if (!['home', 'library'].includes(S.screen)) return;
    const page = document.querySelector('.screen > .page');
    if (page && page.scrollTop <= 0 && page.querySelector('.tabs')) showSearch();
  }

  /** @param {KeyboardEvent} e */
  function onKeyUp(e) {
    if (e.keyCode !== 13) return;
    if (hOk.down) {
      hOk.down = false;
      clearTimeout(hOk.timer);
      // released before the hold fired: an ordinary press, on the element it began on
      if (!hOk.fired && document.activeElement === hOk.el) /** @type {HTMLElement} */ (hOk.el).click();
      hOk.el = null;
    }
  }

  /* focus bookkeeping the vanilla app did in a document focusin listener */
  /** @param {FocusEvent} e */
  function onFocusIn(e) {
    const t = /** @type {HTMLElement | null} */ (e.target);
    if (t?.dataset?.focus) {
      S.focusKey = t.dataset.focus;
      ensureVisible(t);
      marqueeFocus(t);
    }
  }

  /* pointer hover marquees a long tile title (the Magic Remote hovers) */
  /** @param {MouseEvent} e */
  function onOver(e) {
    const tile = /** @type {Element} */ (e.target).closest?.('.tile, .plcard');
    if (tile) marqueeFocus(tile);
  }

  /** @param {MouseEvent} e */
  function onOut(e) {
    const tile = /** @type {Element} */ (e.target).closest?.('.tile, .plcard');
    if (tile && (!e.relatedTarget || !tile.contains(/** @type {Node} */ (e.relatedTarget)))) {
      if (document.activeElement !== tile) clearMarquee();
    }
  }
</script>

<svelte:window onwheel={onWheel} onkeydown={onKeyDown} onkeyup={onKeyUp} onfocusin={onFocusIn} onmouseover={onOver} onmouseout={onOut} />
