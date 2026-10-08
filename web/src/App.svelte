<script>
  /* The desktop shell: the top navigation (WebNav) instead of the tab bar,
   * every route of every tab stack (only the active top shown — scroll and
   * loaded data survive Back for free, as on the phone), sheets as popovers /
   * dialogs, the player (WebPlayer, always mounted), Login, toast, confirm
   * dialog and offline banner. Navigation state is the phone router's
   * (phone/src/lib/router.svelte.js); the address bar follows it
   * (lib/urlsync.svelte.js). No page transitions beyond a short fade — a
   * desktop page swap should feel instant. */
  import { onMount, tick } from 'svelte';
  import { R, S, TABS, top, closeSheet, switchTab, markBooted, takeFocus, pruneFocus, closeLoginModal } from '$p/lib/router.svelte.js';
  import { CONFIRM, answer } from '$p/lib/confirm.svelte.js';
  import { keepOrigins } from '$p/lib/zoom.js';
  import { openLogin } from '$lib/nav.svelte.js';
  import { screens } from './screens.js';
  import { sheets } from './sheets.js';
  import Login from '$p/screens/Login.svelte';
  import Toast from '$p/components/Toast.svelte';
  import OfflineBanner from '$p/components/OfflineBanner.svelte';
  import ActionSheet from '$p/components/ActionSheet.svelte';
  import WebNav from './components/WebNav.svelte';
  import WebPlayer from './player/WebPlayer.svelte';
  import { conn, checkServer } from '$p/lib/conn.svelte.js';
  import { cfg } from '$lib/config.js';
  import { api, onAuthLost } from '$lib/api.js';
  import { toast, toastState, takeUndo, pauseToast, resumeToast } from '$lib/toast.svelte.js';
  import { onReconnect } from '$lib/reconnect.js';
  import { startActivity, stopActivity } from '$lib/activity.svelte.js';
  import { startNews, stopNews } from '$lib/news.svelte.js';
  import '$lib/landed.svelte.js'; // registers its activity-feed listener (the bell's "Ready to watch")
  import { rememberCurrent } from '$lib/account.svelte.js';
  import { meAtBoot } from '$p/lib/mylib.js';
  import { MODAL, holdInert, releaseInert } from './lib/modal.svelte.js';
  import { isTyping, isUndoKey, isMac, navInset } from './lib/shellkeys.js';

  /* ------------------------------------------------------------ polling ---- */
  /* activity (download badges) and the bell's feed: only while the tab is
   * visible and browsing — never under the player or Login (as on the TV) */
  let visible = $state(document.visibilityState !== 'hidden');
  onMount(() => {
    const onVis = () => (visible = document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  });
  const browsing = $derived(visible && R.booted && !R.modal);
  $effect(() => {
    if (R.booted) meAtBoot();
  });
  $effect(() => {
    if (browsing) {
      startActivity();
      startNews();
    } else {
      stopActivity();
      stopNews();
    }
  });

  /* ------------------------------------------------------- auth / boot ---- */
  let authCheck = false;
  onAuthLost(async () => {
    const busy = () => S.screen === 'login' || S.screen === 'boot' || S.screen === 'player';
    if (authCheck || busy()) return;
    authCheck = true;
    try {
      await api('/Users/' + cfg.userId);
    } catch (e) {
      if (/** @type {VR.ApiError} */ (e)?.status === 401 && !busy()) {
        closeSheet();
        toast('Jellyfin signed this browser out — sign in again');
        openLogin();
      }
    } finally {
      authCheck = false;
    }
  });

  /* With a stored session the shell paints at once and fills in while the
   * session check runs; R.booted gates the polls. A 401/403 → Login (the
   * stacks — the URL the user came in on — stay, for after the sign-in). */
  const shell = $derived(R.booted || (!!cfg.token && !!cfg.userId && R.modal !== 'login'));

  onMount(() => {
    S.ready = true;
    if (!cfg.token || !cfg.userId) {
      openLogin();
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    api('/Users/' + cfg.userId, { signal: ctl.signal })
      .then(() => {
        rememberCurrent();
        markBooted();
      })
      .catch((e) => {
        if (e && (e.status === 401 || e.status === 403)) openLogin();
        else {
          markBooted();
          conn.offline = true;
          checkServer();
        }
      })
      .finally(() => clearTimeout(t));
  });

  onMount(() => onReconnect(() => conn.offline && checkServer(), { every: 20000 }));

  /* ------------------------------------------------------------ routes ---- */
  let stage = $state(/** @type {HTMLDivElement | null} */ (null));
  const el = (/** @type {string | null | undefined} */ key) => /** @type {HTMLElement | null | undefined} */ (stage?.querySelector(`.route[data-key="${key}"]`));

  /* The router describes a push/pop for the phone's slide animations; here a
   * page simply shows (with a CSS fade), so the description is cleared. */
  $effect(() => {
    const a = R.anim;
    if (!a) return;
    tick().then(() => {
      if (R.anim === a) R.anim = null;
    });
  });

  /* Chrome and Firefox drop a scroller's offset when it goes display:none and
   * back: remember every scroller's offsets per route (read once scrolling
   * rests, and before a navigation hides the route) and put them back when
   * the route shows again — the phone App's scheme. */
  const offsets = new Map(); // routeKey → Map(element → [top, left])
  const moved = new Map(); // element → routeKey, scrolled since the last read
  let readTimer = 0;
  let lastScroll = 0;
  const REST = 150;
  /** @param {Event} e */
  function onScroll(e) {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const r = /** @type {HTMLElement | null} */ (t.closest('.route'));
    if (!r || r.hidden) return;
    moved.set(t, r.dataset.key);
    lastScroll = performance.now();
    if (!readTimer) readTimer = setTimeout(readMoved, REST);
  }
  function readMoved() {
    readTimer = 0;
    const wait = REST - (performance.now() - lastScroll);
    if (wait > 0) readTimer = setTimeout(readMoved, wait);
    else flushOffsets();
  }
  function flushOffsets() {
    clearTimeout(readTimer);
    readTimer = 0;
    for (const [t, key] of moved) {
      if (!t.isConnected || t.closest('.route')?.hidden) continue;
      let m = offsets.get(key);
      if (!m) offsets.set(key, (m = new Map()));
      m.set(t, [t.scrollTop, t.scrollLeft]);
    }
    moved.clear();
  }
  $effect.pre(() => {
    void R.tab, R.stacks, R.modal;
    if (moved.size) flushOffsets();
  });

  /* The bar turns to glass once the page on screen has scrolled 24 px. An
   * IntersectionObserver on a 24 px mark at the top of the page's scroller
   * says so off the scroll path — reading scrollTop in every scroll event
   * forced the layout a grid's per-frame slice had just dirtied (E-07). */
  let solid = $state(false);
  /** @type {IntersectionObserver | null} */
  let solidIo = null;
  /** @type {Element | null} */
  let solidOf = null;
  /** @param {HTMLElement | null} sc */
  function watchSolid(sc) {
    if (sc === solidOf) return;
    solidIo?.disconnect();
    solidOf = sc;
    if (!sc) {
      solid = false;
      return;
    }
    let mark = sc.querySelector(':scope > .wtopmark');
    if (!mark) {
      mark = document.createElement('div');
      mark.className = 'wtopmark';
      mark.setAttribute('aria-hidden', 'true');
      sc.append(mark);
    }
    solidIo = new IntersectionObserver((es) => (solid = !es[es.length - 1].isIntersecting), { root: sc });
    solidIo.observe(mark);
  }

  /* The fixed bar stays off the page's scrollbar (and its end lines up with
   * the content's): --wnav-right is the scrollbar's width, measured, or for
   * an overlay scrollbar that takes no room a strip the thumb can use. */
  let insetW = -1;
  /** @param {HTMLElement | null} sc */
  function measureScrollbar(sc) {
    if (!sc || !sc.isConnected || sc.closest('[hidden]')) return;
    const w = sc.offsetWidth - sc.clientWidth;
    if (w === insetW) return;
    insetW = w;
    const { right, pad } = navInset(w);
    const st = document.documentElement.style;
    st.setProperty('--wnav-right', right + 'px');
    st.setProperty('--wnav-right-pad', pad + 'px');
  }
  onMount(() => {
    const again = () => {
      insetW = -1;
      measureScrollbar(solidOf instanceof HTMLElement ? solidOf : null);
    };
    addEventListener('resize', again);
    return () => removeEventListener('resize', again);
  });

  /* Routes mount the first time they show (a deep link to /movie/… must not
   * mount — and load — the hidden Home or Movies grid under it); once shown,
   * they stay mounted, so their scroll and data survive Back. */
  let seen = $state(/** @type {Record<string, true>} */ ({}));
  $effect.pre(() => {
    if (!shell) return;
    const k = top().key;
    if (!seen[k]) seen[k] = true;
  });

  /* Focus on a forward navigation (a tile, a crumb, a section, a deep link):
   * the new page's scroller, so PageDown / Space / End scroll it and a screen
   * reader lands on the page — unless something on that page already took
   * focus (Search's field after `/`). A modal opening or closing never moves
   * it (the player hands focus back itself). */
  /** @param {HTMLElement | null | undefined} r */
  function focusPage(r) {
    const sc = /** @type {HTMLElement | null | undefined} */ (r?.querySelector('.screen'));
    if (!sc) return;
    const a = document.activeElement;
    if (a && a !== document.body && r?.contains(a)) return;
    if (a && a !== document.body && !a.closest('.wnav') && !a.closest('.route[hidden]') && a.isConnected) return;
    sc.focus({ preventScroll: true });
  }
  /* A page can swap its scroller after it loads (Detail's loading <main>
   * gives way to MovieDetail's): follow the active route's children, so the
   * glass, the scrollbar inset and a focus that sat on the old one move over. */
  /** @type {MutationObserver | null} */
  let swapMo = null;
  /** @param {HTMLElement} r */
  function followRoute(r) {
    swapMo?.disconnect();
    swapMo = new MutationObserver(() => {
      const sc = /** @type {HTMLElement | null} */ (r.querySelector(':scope > .screen'));
      if (!sc || sc === solidOf || r.hidden) return;
      const hadFocus = !!solidOf && document.activeElement === document.body;
      tameScreens(r);
      watchSolid(sc);
      measureScrollbar(sc);
      if (hadFocus && !R.modal && !R.sheet) sc.focus({ preventScroll: true });
    });
    swapMo.observe(r, { childList: true });
  }
  /** @param {HTMLElement} r  pages' scrollers are focus targets, never Tab stops (Firefox makes every scroller one) */
  function tameScreens(r) {
    for (const sc of /** @type {NodeListOf<HTMLElement>} */ (r.querySelectorAll('.screen'))) if (!sc.hasAttribute('tabindex')) sc.tabIndex = -1;
  }
  /** @type {{ tab: VR.TabName, key: string, modal: VR.Modal | null } | null} */
  let landed = null;
  $effect(() => {
    void R.tab, R.stacks, R.modal;
    const t = top();
    const tab = R.tab;
    const modal = R.modal;
    const was = landed;
    landed = { tab, key: t.key, modal };
    const went = !was || was.key !== t.key || was.tab !== tab;
    // a confirm belongs to the page it was asked on (Delete “…”?): leaving it answers No
    if (was && went && CONFIRM.req) answer(false);
    tick().then(() => {
      if (!stage) return;
      if (moved.size) flushOffsets();
      const live = new Set();
      for (const r of /** @type {NodeListOf<HTMLElement>} */ (stage.querySelectorAll('.route'))) {
        live.add(r.dataset.key);
        if (r.hidden) continue;
        const m = offsets.get(r.dataset.key);
        if (m)
          for (const [node, [st, sl]] of m) {
            if (!node.isConnected) {
              m.delete(node);
              continue;
            }
            if (node.scrollTop !== st) node.scrollTop = st;
            if (node.scrollLeft !== sl) node.scrollLeft = sl;
          }
        tameScreens(r);
        const sc = /** @type {HTMLElement | null} */ (r.querySelector(':scope > .screen') || r.querySelector('.screen'));
        watchSolid(sc);
        measureScrollbar(sc);
        followRoute(r);
      }
      for (const k of offsets.keys()) if (!live.has(k)) offsets.delete(k);
      for (const k of Object.keys(seen)) if (!live.has(k)) delete seen[k];
      pruneFocus(live);
      keepOrigins(live); // a popped page's tile origin held the whole detached page (E-03)
      if (!went || R.modal || R.sheet || (was && was.modal !== modal)) return;
      const r = el(t.key);
      // keyboard: back on a page, focus returns to what opened the next one
      if (was && was.tab === tab && !R.stacks[tab].some((x) => x.key === was.key)) {
        const f = takeFocus(t.key);
        if (f?.isConnected && r?.contains(f)) return f.focus({ preventScroll: true });
      }
      focusPage(r);
    });
  });

  /* The active tab's nav link clicked again at its root: scroll to the top. */
  let lastToTop = 0;
  $effect(() => {
    const n = R.toTop;
    if (n === lastToTop) return;
    lastToTop = n;
    const r = el(top().key);
    if (!r) return;
    for (const s of /** @type {NodeListOf<HTMLElement>} */ (r.querySelectorAll('.screen, [data-scroll-top]'))) s.scrollTo({ top: 0, behavior: 'smooth' });
    offsets.delete(top().key);
  });

  /* ------------------------------------------------------------- sheets ---- */
  const SheetComp = $derived(R.sheet ? sheets[R.sheet.name] : null);
  /* popovers hang under their nav button; everything else is a dialog */
  const POPOVER = new Set(['accounts', 'notifications']);
  const sheetKind = $derived(R.sheet && POPOVER.has(R.sheet.name) ? 'popover' : 'dialog');

  /* Escape closes the sheet — unless a confirm (Sign out?) or a context menu
   * sits above it: their own Escape answers first, and this capture handler
   * used to swallow the key, closing the popover under a confirm left open. */
  /** @param {KeyboardEvent} e */
  function onKey(e) {
    if (e.key === 'Escape' && R.sheet && !e.defaultPrevented && !CONFIRM.req && !document.querySelector('.ctx')) {
      e.preventDefault();
      e.stopPropagation();
      closeSheet();
    } else if (e.key === 'Escape' && R.modal === 'login' && S.addingAccount && !e.defaultPrevented && !CONFIRM.req) {
      // Esc cancels adding an account, as its Cancel does — back to the avatar
      e.preventDefault();
      e.stopPropagation();
      closeLoginModal();
      tick().then(() => /** @type {HTMLElement | null} */ (document.querySelector('.wnav .avatarbtn'))?.focus());
    }
  }

  /* ------------------------------------------------------------ modality ---- */
  /* A confirm (Delete “…”?, Sign out?) and the add-account Login are modal:
   * the shell under them is inert (lib/modal.svelte.js) — Tab, the pointer and
   * screen readers stay in the dialog. Released in the same update that
   * closes them, before anything hands focus back into the shell. */
  $effect.pre(() => {
    if (CONFIRM.req) holdInert('confirm');
    else releaseInert('confirm');
  });
  $effect.pre(() => {
    if (R.modal === 'login' && shell) holdInert('login');
    else releaseInert('login');
  });
  /* Login: the first empty field takes focus (the server address on a first
   * start, else the user name), so typing can start at once. */
  $effect(() => {
    if (R.modal !== 'login') return;
    tick().then(() =>
      requestAnimationFrame(() => {
        const host = document.querySelector('.wloginhost');
        if (!host || host.contains(document.activeElement)) return;
        const fields = /** @type {HTMLInputElement[]} */ ([...host.querySelectorAll('input.field__input')]);
        (fields.find((f) => !f.value) || fields[0])?.focus();
      })
    );
  });

  /* ---------------------------------------------------------------- undo ---- */
  /* Ctrl+Z (⌘Z on a Mac) runs the Undo a toast offers ("Added — … · Undo"),
   * as the TV's Play key does — not while typing (the field's own undo), nor
   * under Login or a confirm. The toast says so on its button, and stays up
   * while focus is in it (Tab to it takes a while). */
  const MAC = isMac();
  document.documentElement.style.setProperty('--wundo-key', MAC ? '" · ⌘Z"' : '" · Ctrl+Z"');
  /** @param {KeyboardEvent} e */
  function onUndo(e) {
    if (!toastState.undo || e.defaultPrevented || !isUndoKey(e, MAC) || isTyping(e.target)) return;
    if (R.modal === 'login' || CONFIRM.req) return;
    e.preventDefault();
    takeUndo();
  }
  /** @param {FocusEvent} e */
  function onFocusIn(e) {
    if (/** @type {Element | null} */ (e.target)?.closest?.('.toast')) pauseToast();
    else clearOfBars(e.target);
  }

  /* Keyboard focus never ends under the fixed bar or a page's sticky one
   * (the series' season bar, Search's field), nor cut off at the bottom: the
   * scrollers' scroll-padding (shell.css) covers the browser's own focus
   * scrolling, and this corrects what it can't know — a season bar that
   * wrapped to two rows, Shift+Tab up a page. */
  const STICKY = '.detail__pills.pills--sticky, .srch--on .search';
  /** @param {EventTarget | null} t */
  function clearOfBars(t) {
    if (!(t instanceof HTMLElement) || !t.matches(':focus-visible')) return;
    const sc = /** @type {HTMLElement | null} */ (t.closest('.route:not([hidden]) .screen'));
    if (!sc || t === sc || t.closest(STICKY)) return;
    const r = t.getBoundingClientRect();
    const view = sc.getBoundingClientRect();
    let top = Math.max(view.top, document.querySelector('.wnav')?.getBoundingClientRect().bottom ?? 0);
    for (const b of sc.querySelectorAll(STICKY)) top = Math.max(top, b.getBoundingClientRect().bottom);
    const bottom = view.bottom;
    let dy = 0;
    if (r.top < top + 4) dy = r.top - top - 12;
    else if (r.bottom > bottom - 4 && r.height < bottom - top - 24) dy = r.bottom - bottom + 16;
    if (dy) sc.scrollBy({ top: dy, behavior: 'instant' });
  }
  /** @param {FocusEvent} e */
  function onFocusOut(e) {
    const from = /** @type {Element | null} */ (e.target)?.closest?.('.toast');
    const to = /** @type {Element | null} */ (e.relatedTarget)?.closest?.('.toast');
    if (from && !to) resumeToast();
  }

  /* `/` jumps to the Search field from anywhere in the browse UI (as on most
   * sites with a search box) — not while typing, under the player, Login or
   * an open sheet. The Search root mounts on its first visit, so the field
   * is looked for over a few frames. */
  /** @param {KeyboardEvent} e */
  function onSlash(e) {
    if (e.key !== '/' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = /** @type {HTMLElement | null} */ (e.target instanceof HTMLElement ? e.target : null);
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (!shell || R.modal || R.sheet || CONFIRM.req || document.querySelector('.ctx, .actsheet:not([inert])')) return;
    e.preventDefault();
    if (R.tab !== 'search' || R.stacks.search.length > 1) switchTab('search');
    let tries = 30;
    const find = () => {
      const f = /** @type {HTMLInputElement | null} */ (document.querySelector('.route[data-route="search"]:not([hidden]) .search__input'));
      if (f) {
        f.focus();
        f.select();
      } else if (--tries > 0) requestAnimationFrame(find);
    };
    tick().then(find);
  }
</script>

<svelte:window onkeydowncapture={onKey} onkeydown={(e) => (onSlash(e), onUndo(e))} />
<svelte:document onfocusin={onFocusIn} onfocusout={onFocusOut} />

<!-- a sheet (popover or dialog) is modal: its scrim already takes every click
     outside it, and `inert` keeps Tab / the screen reader in it too — as for
     every other modal that holds a key in MODAL (lib/modal.svelte.js) -->
<div class="wapp" class:wapp--player={R.modal === 'player'} inert={(!!R.sheet && !!SheetComp) || MODAL.holds.length > 0 || undefined}>
  {#if shell}<WebNav {solid} />{/if}

  <div class="stage wstage" bind:this={stage} onscrollcapture={onScroll}>
    {#if shell}
      {#each TABS.filter((t) => R.visited[t]) as tab (tab)}
        {#each R.stacks[tab] as route, i (route.key)}
          {@const Screen = screens[route.name]}
          {@const isTop = i === R.stacks[tab].length - 1}
          {@const active = tab === R.tab && isTop}
          <section
            class="route {i ? 'route--deep' : ''}"
            data-key={route.key}
            data-route={route.name}
            hidden={!active}
            inert={!active || !!R.modal || undefined}
          >
            {#if Screen && (active || seen[route.key])}<Screen params={route.params} active={active && !R.modal} />{/if}
          </section>
        {/each}
      {/each}
    {/if}
  </div>

  <OfflineBanner raised={false} />
</div>

{#if R.sheet && SheetComp}
  <div class="wscrim wscrim--{sheetKind}" onclick={closeSheet} role="presentation"></div>
  <!-- a confirm asked from a popover (Sign out?) sits over it: inert under it too -->
  <div class="wsheethost wsheethost--{sheetKind} wsheethost--{R.sheet.name}" inert={!!CONFIRM.req || undefined}>
    {#key R.sheet.key}<SheetComp params={R.sheet.params} />{/key}
  </div>
{/if}

<WebPlayer open={R.modal === 'player'} />

{#if R.modal === 'login'}
  <div class="loginhost wloginhost"><Login /></div>
{/if}

<Toast noTabbar aboveBanner={conn.offline && !R.modal && shell} />

<ActionSheet />
