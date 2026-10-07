<script>
  import { onMount } from 'svelte';
  import Keys from './components/Keys.svelte';
  import Splash from './components/Splash.svelte';
  import Toast from './components/Toast.svelte';
  import VideoLayer from './components/VideoLayer.svelte';
  import Search from './components/Search.svelte';
  import Login from './screens/Login.svelte';
  import Home from './screens/Home.svelte';
  import Library from './screens/Library.svelte';
  import Detail from './screens/Detail.svelte';
  import PendingDetail from './screens/PendingDetail.svelte';
  import LookupDetail from './screens/LookupDetail.svelte';
  import Person from './screens/Person.svelte';
  import { cfg } from './lib/config.js';
  import { api, onAuthLost } from './lib/api.js';
  import { S, openHome, openLogin, closeSearch } from './lib/nav.svelte.js';
  import { toast } from './lib/toast.svelte.js';
  import { startActivity, stopActivity } from './lib/activity.svelte.js';
  import { startNews, stopNews } from './lib/news.svelte.js';
  import { rememberCurrent } from './lib/account.svelte.js';

  /* Download activity feeds badges on the browse screens (Library grids,
   * SeriesDetail, PendingDetail) — poll only there, never during playback. */
  const ACTIVITY_SCREENS = new Set(['home', 'library', 'detail', 'pending', 'lookup']);
  /* …and only while the app is on screen. webOS parks a "closed" app's webview
   * rather than killing it, so a TV left on another input/app for days kept
   * polling reel-api every 4 s (and the news feed) for nobody. Back to visible,
   * both restart at once: activity polls immediately, news if its copy is old. */
  let visible = $state(document.visibilityState !== 'hidden');
  onMount(() => {
    const onVis = () => (visible = document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  });
  $effect(() => {
    if (visible && ACTIVITY_SCREENS.has(S.screen)) startActivity();
    else stopActivity();
  });

  /* The new-seasons bell sits in every tab row; its feed is slow-moving and
   * polled only while browsing (news.svelte.js). */
  const NEWS_SCREENS = new Set(['home', 'library', 'detail', 'pending', 'lookup']);
  $effect(() => {
    if (visible && NEWS_SCREENS.has(S.screen)) startNews();
    else stopNews();
  });

  /* The token was revoked mid-session (api.js reports every 401 on the current
   * token). Confirm with one cheap authenticated call — a single endpoint
   * refusing us is not proof — then go to Login instead of leaving an error
   * card on every screen. Never during playback (the video would be left
   * running under Login; the next browse request after it re-triggers this),
   * nor on Login/boot, which handle their own 401s. */
  let authCheck = false;
  onAuthLost(async () => {
    const busy = () => S.screen === 'login' || S.screen === 'boot' || S.screen === 'player';
    if (authCheck || busy()) return;
    authCheck = true;
    try {
      await api('/Users/' + cfg.userId);
    } catch (e) {
      if (/** @type {VR.ApiError} */ (e)?.status === 401 && !busy()) {
        if (S.search) closeSearch();
        toast('Jellyfin signed this TV out — sign in again');
        openLogin();
      }
    } finally {
      authCheck = false;
    }
  });

  onMount(() => {
    if (!cfg.token || !cfg.userId) {
      openLogin();
      return;
    }
    /* Boot must never be able to hang: fetch has no timeout of its own, and a TV
     * that has just woken up can leave the first request pending forever — which
     * used to leave the splash breathing over an app that never appeared. Time
     * it out, and treat only a real auth rejection as "log in again"; a network
     * blip must not throw away a working session. */
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    api('/Users/' + cfg.userId, { signal: ctl.signal })
      .then(() => {
        rememberCurrent(); // a session from before the account list existed
        /* S.base starts as 'home', so Home is already mounted and fetching
         * behind the splash. openHome() would bump S.epoch and remount it —
         * every boot request (Resume, NextUp, trending, the rails' images)
         * went out twice. Just leave the boot state. */
        if (S.screen === 'boot' && S.base === 'home') S.screen = 'home';
        else openHome();
      })
      .catch((e) => (e && (e.status === 401 || e.status === 403) ? openLogin() : openHome()))
      .finally(() => clearTimeout(t));
  });
</script>

<!-- The browse screen. Re-navigating to the same screen bumps S.epoch, which
     remounts it — the vanilla equivalent of re-running open*() and refetching. -->
{#key S.epoch}
  {#if S.base === 'login'}
    <Login />
  {:else if S.base === 'home'}
    <Home />
  {:else if S.base === 'library'}
    <Library />
  {:else if S.base === 'detail'}
    <Detail />
  {:else if S.base === 'pending'}
    <PendingDetail />
  {:else if S.base === 'lookup'}
    <LookupDetail />
  {:else if S.base === 'person'}
    <Person />
  {/if}
{/key}

<!-- Long-lived overlays: these stay mounted for the whole session and are
     toggled with [hidden], as the static siblings in index.html used to be.
     (Music — <audio>, Now Playing, the mini bar — moved out to VibeSpin.) -->
<Search />
<VideoLayer />

<Keys />
<Splash />
<Toast />
