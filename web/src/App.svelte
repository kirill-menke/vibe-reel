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
  import { R, S, TABS, top, closeSheet, switchTab, markBooted, takeFocus, pruneFocus } from '$p/lib/router.svelte.js';
  import { CONFIRM } from '$p/lib/confirm.svelte.js';
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
  import { toast } from '$lib/toast.svelte.js';
  import { onReconnect } from '$lib/reconnect.js';
  import { startActivity, stopActivity } from '$lib/activity.svelte.js';
  import { startNews, stopNews } from '$lib/news.svelte.js';
  import '$lib/landed.svelte.js'; // registers its activity-feed listener (the bell's "Ready to watch")
  import { rememberCurrent } from '$lib/account.svelte.js';
  import { meAtBoot } from '$p/lib/mylib.js';

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
  let solid = $state(false);
  /** @param {Event} e */
  function onScroll(e) {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const r = /** @type {HTMLElement | null} */ (t.closest('.route'));
    if (!r || r.hidden) return;
    if (t.classList.contains('screen')) solid = t.scrollTop > 24;
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
  /** @type {{ tab: VR.TabName, key: string } | null} */
  let landed = null;
  $effect(() => {
    void R.tab, R.stacks, R.modal;
    const t = top();
    const tab = R.tab;
    const was = landed;
    landed = { tab, key: t.key };
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
        const sc = /** @type {HTMLElement | null} */ (r.querySelector('.screen'));
        solid = !!sc && sc.scrollTop > 24;
      }
      for (const k of offsets.keys()) if (!live.has(k)) offsets.delete(k);
      pruneFocus(live);
      // keyboard: back on a page, focus returns to what opened the next one
      if (was && was.tab === tab && was.key !== t.key && !R.modal && !R.sheet && !R.stacks[tab].some((x) => x.key === was.key)) {
        const f = takeFocus(t.key);
        const r = el(t.key);
        if (f?.isConnected && r?.contains(f)) f.focus({ preventScroll: true });
      }
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
    }
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
    if (!shell || R.modal || R.sheet || CONFIRM.req) return;
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

<svelte:window onkeydowncapture={onKey} onkeydown={onSlash} />

<!-- a sheet (popover or dialog) is modal: its scrim already takes every click
     outside it, and `inert` keeps Tab / the screen reader in it too -->
<div class="wapp" class:wapp--player={R.modal === 'player'} inert={(!!R.sheet && !!SheetComp) || undefined}>
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
            {#if Screen}<Screen params={route.params} active={active && !R.modal} />{/if}
          </section>
        {/each}
      {/each}
    {/if}
  </div>

  <OfflineBanner raised={false} />
</div>

{#if R.sheet && SheetComp}
  <div class="wscrim wscrim--{sheetKind}" onclick={closeSheet} role="presentation"></div>
  <div class="wsheethost wsheethost--{sheetKind} wsheethost--{R.sheet.name}">
    {#key R.sheet.key}<SheetComp params={R.sheet.params} />{/key}
  </div>
{/if}

<WebPlayer open={R.modal === 'player'} />

{#if R.modal === 'login'}
  <div class="loginhost wloginhost"><Login /></div>
{/if}

<Toast noTabbar aboveBanner={conn.offline && !R.modal && shell} />

<ActionSheet />
