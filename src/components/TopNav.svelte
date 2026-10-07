<script module>
  /* Home renders TopNav in each of its loading/failed/hero branches, so the
   * avatar <img> is torn down and recreated when the rails land (~0.3 s into
   * a cold boot) — while UserImage (a server-side resize) is still in flight.
   * The dropped request was cancelled and fetched again. One session-long
   * Image holds the load, so every later <img> of that URL reuses it.
   * A user without a picture gets a 404, which the engine doesn't cache, so
   * noPic is module-level too and the held load's error fills it — else each
   * remounted <img> asked the server again. */
  const held = new Map(); // referenced, so the Image (and its load) isn't GC'd
  /* userIds whose profile picture 404'd — they wear their initial instead. */
  /** @type {Record<string, boolean>} */
  const noPic = $state({});
  /** @param {string} url @param {string} userId */
  function holdPic(url, userId) {
    if (held.has(url)) return;
    const im = new Image();
    im.onerror = () => (noPic[userId] = true);
    im.src = url;
    held.set(url, im);
  }
</script>

<script>
  import Icon from './Icon.svelte';
  import { openHome, openLibrary, openLogin, openItem } from '../lib/nav.svelte.js';
  import { HM, HM_BUTTON } from '../lib/header.svelte.js';
  import { news, unreadCount, markAllSeen, seasonActivity, getSeason, newsLine, searchState } from '../lib/news.svelte.js';
  import { landed, unseenLanded, markLandedSeen, landedLine, landedAgo } from '../lib/landed.svelte.js';
  import { accounts, isCurrent, avatarUrl, initial, switchTo, signOut } from '../lib/account.svelte.js';
  import { lookupOpener } from '../lib/lookup.svelte.js';
  import { posterThumb } from '../lib/medialib.js';
  import { STATUS_LABEL } from '../lib/activity.svelte.js';
  import { cfg } from '../lib/config.js';
  import { focusKey } from '../lib/focus.js';
  import { LV, closeMenu } from '../lib/libview.svelte.js';
  import { onDestroy } from 'svelte';
  import SettingsMenu from './SettingsMenu.svelte';
  import MyLibraryMenu from './MyLibraryMenu.svelte';
  import { ME, MY, refreshMe, quotaSummary } from '../lib/me.svelte.js';

  /* children: an optional cluster on the same row, between the tabs and the
   * bell — the Movies/Shows sort & filter bar (LibraryBar.svelte). */
  /** @type {{ active: string, children?: import('svelte').Snippet }} */
  let { active, children } = $props();

  /* A dropdown must not outlive its screen. The menus are pointer-transparent
   * (.menuscrim), so a Magic Remote click on a tab navigates with one still
   * down. LV/HM are global, so the next screen came up dimmed, or with the
   * menu open and the D-pad trapped in it. */
  onDestroy(() => {
    HM.open = null;
    MY.confirm = null;
    closeMenu();
  });

  /* [screen id, label, icon]. There is no Search tab: ▲ past this bar raises
   * the Search overlay in its place (Keys.svelte → openSearch()). Music is
   * not a tab any more: it is its own app, VibeSpin. */
  const TABS = [
    ['home', 'Home', 'home'],
    ['movies', 'Movies', 'film'],
    ['shows', 'Shows', 'tv']
  ];

  /** @param {string} id 'home' or a library tab */
  function go(id) {
    if (id === 'home') openHome();
    else openLibrary(id);
  }

  /* new seasons + unseen "Ready to watch" landings share the bell's coin */
  const unread = $derived(unreadCount() + unseenLanded());
  /* cfg is the current account; it only changes across a reload. */
  if (cfg.userId) holdPic(avatarUrl(cfg), cfg.userId);

  /* The bell and the avatar hang their menus the way the library bar does:
   * OK opens (landing on the first row), OK again or Back closes onto the
   * button. */
  /* the avatar's own pages (Settings, My library and its confirmation) */
  const AVATAR_PAGES = ['account', 'settings', 'mylib', 'mylib-del'];

  /** @param {'news' | 'account'} which */
  async function toggle(which) {
    // the avatar also closes its Settings / My library page
    if (HM.open === which || (which === 'account' && AVATAR_PAGES.includes(/** @type {string} */ (HM.open)))) {
      HM.open = null;
      MY.confirm = null;
      return;
    }
    /* My library's row (and its quota line) needs GET /api/me: ask now, not
     * at boot (each fetch() costs the TV 3–9 ms of main thread). The row pops
     * in when the first answer lands; focus is on the current account row, so
     * nothing under it jumps. */
    if (which === 'account') refreshMe({ maxAge: 30000 });
    if (which === 'news') {
      markAllSeen();
      markLandedSeen();
    }
    HM.open = which;
    // news: the newest landing, else the newest season; account: the current account's row
    const first =
      which === 'news'
        ? landed.items[0]
          ? 'ld-' + landed.items[0].id
          : news.items[0]
            ? 'nw-' + news.items[0].id
            : null
        : 'ac-' + cfg.userId;
    if (first) await focusKey(first);
  }

  function close() {
    const k = HM_BUTTON[/** @type {keyof typeof HM_BUTTON} */ (HM.open)];
    HM.open = null;
    if (k) focusKey(k);
  }

  /** @param {VR.LandedEntry} e */
  function openLanded(e) {
    HM.open = null;
    openItem(e.id, e.jfType);
  }

  /** @param {Reel.NewsItem} item */
  async function openShow(item) {
    HM.open = null;
    const open = await lookupOpener({ id: item.media_id, type: 'tv', title: item.title, year: item.year, poster: item.poster, added: true });
    open();
  }

  /* The account menu swaps itself for the Settings page in the same spot;
   * Back from there closes onto the avatar (HM_BUTTON.settings). */
  async function openSettings() {
    HM.open = 'settings';
    await focusKey('set-audioLang');
  }

  /* The account menu swaps itself for My library in the same spot; it opens
   * on the first title (else "find something in Search"). */
  async function openMyLib() {
    HM.open = 'mylib';
    const t = ME.me?.titles[0];
    if (!(t && (await focusKey('my-' + t.type + '-' + t.id)))) await focusKey('my-search');
  }

  function addAccount() {
    HM.open = null;
    openLogin(true);
  }

  /** @param {FocusEvent} e */
  function keepInView(e) {
    /** @type {Element | null} */ (e.target)?.scrollIntoView?.({ block: 'nearest' });
  }
</script>

<div class="top">
  {#if HM.open || LV.open}<div class="menuscrim"></div>{/if}
  <div class="tabs">
    {#each TABS as [id, label, icon] (id)}
      <button
        class="tab focus"
        class:active={id === active}
        data-focus="tab-{id}"
        onclick={() => go(id)}><Icon name={icon} /><span>{label}</span></button>
    {/each}
  </div>
  {#if children}<div class="top-extra">{@render children()}</div>{/if}

  <div class="hbar">
    <div class="lvwrap">
      <button
        class="hbtn focus"
        class:open={HM.open === 'news'}
        data-focus="nav-news"
        aria-label="Notifications"
        onclick={() => toggle('news')}
      >
        <Icon name="bell" />
        {#if unread}<b class="hcount">{unread > 9 ? '9+' : unread}</b>{/if}
      </button>
      {#if HM.open === 'news'}
        <div class="lvmenu hmenu news" role="list" aria-label="Notifications" onfocusin={keepInView}>
          {#if landed.items.length}
            <div class="lvcap">Ready to watch</div>
            {#each landed.items as e (e.key)}
              <div class="nwrow" class:fresh={landed.fresh.includes(e.key)}>
                <button class="opt focus nwmain" data-focus="ld-{e.id}" onclick={() => openLanded(e)}>
                  <span class="nwposter">{#if e.poster}<img src={e.poster} alt="" onerror={(ev) => ev.currentTarget.remove()} />{/if}</span>
                  <span class="nwtext">
                    <span class="nwtitle">{e.title}</span>
                    <span class="nwseason">{landedLine(e)}</span>
                    <span class="nwline">Added {landedAgo(e.at)}</span>
                  </span>
                </button>
              </div>
            {/each}
          {/if}
          <div class="lvcap">New seasons</div>
          {#each news.items as it (it.id)}
            {@const dl = seasonActivity(it)}
            {@const st = searchState(it)}
            <!-- once pressed, the button stays (as the status) so focus never falls off a vanished row -->
            {@const canGet = it.kind === 'aired' && (!dl || st)}
            <div class="nwrow" class:fresh={news.fresh.includes(it.id)}>
              <button class="opt focus nwmain" data-focus="nw-{it.id}" onclick={() => openShow(it)}>
                <span class="nwposter">{#if it.poster}<img src={posterThumb(it.poster)} alt="" onerror={(e) => e.currentTarget.remove()} />{/if}</span>
                <span class="nwtext">
                  <span class="nwtitle">{it.title}</span>
                  <span class="nwseason">Season {it.season}{#if it.kind === 'upcoming'}<i class="nwkind">Upcoming</i>{/if}</span>
                  <span class="nwline" class:found={st === 'found'} class:none={st === 'none'}>
                    {dl
                      ? (st ? 'Found — ' : '') +
                        (STATUS_LABEL[dl.status] || 'Downloading') +
                        (dl.status === 'downloading' ? ' · ' + Math.round(dl.progress * 100) + '%' : '')
                      : st === 'searching'
                        ? 'Searching the indexers…'
                        : st === 'none'
                          ? 'Nothing found yet — Retry searches again'
                          : st === 'found'
                            ? 'Found — on its way into your library'
                            : newsLine(it)}
                  </span>
                </span>
              </button>
              {#if canGet}
                <button
                  class="opt focus nwget"
                  class:done={st === 'searching' || st === 'found'}
                  data-focus="nw-get-{it.id}"
                  onclick={() => getSeason(it)}
                >
                  <Icon name={st === 'found' ? 'checkthin' : 'download'} /><span
                    >{st === 'searching' ? 'Searching…' : st === 'found' ? 'Found' : st === 'none' ? 'Retry' : 'Get'}</span
                  >
                </button>
              {/if}
            </div>
          {:else}
            <div class="nwempty">{news.loaded ? 'No new seasons right now.' : 'Checking for new seasons…'}</div>
          {/each}
        </div>
      {/if}
    </div>

    <div class="lvwrap">
      <button
        class="hbtn avatar focus"
        class:open={AVATAR_PAGES.includes(/** @type {string} */ (HM.open))}
        data-focus="nav-account"
        aria-label="Account"
        onclick={() => toggle('account')}
      >
        {#if !noPic[cfg.userId]}<img src={avatarUrl(cfg)} alt="" onerror={() => (noPic[cfg.userId] = true)} />{:else}<span>{initial(cfg)}</span>{/if}
      </button>
      {#if HM.open === 'account'}
        <div class="lvmenu hmenu account" role="list" aria-label="Account">
          <div class="lvcap">Accounts</div>
          {#each accounts.list as a (a.server + a.userId)}
            <button class="opt focus acrow" class:sel={isCurrent(a)} data-focus="ac-{a.userId}" onclick={() => (isCurrent(a) ? close() : switchTo(a))}>
              <span class="acpic">{#if !noPic[a.userId]}<img src={avatarUrl(a)} alt="" onerror={() => (noPic[a.userId] = true)} />{:else}{initial(a)}{/if}</span>
              <span class="acname">{a.userName}</span>
              {#if isCurrent(a)}<Icon name="checkthin" />{/if}
            </button>
          {/each}
          <div class="acsep"></div>
          <button class="opt focus acrow" data-focus="ac-add" onclick={addAccount}>
            <span class="acpic ic"><Icon name="plus" /></span><span class="acname">Add account</span>
          </button>
          {#if ME.me}
            <button class="opt focus acrow" data-focus="ac-mylib" onclick={openMyLib}>
              <span class="acpic ic"><Icon name="film" /></span>
              <span class="acname">My library<small class="acsub">{quotaSummary()}</small></span>
            </button>
          {/if}
          <button class="opt focus acrow" data-focus="ac-settings" onclick={openSettings}>
            <span class="acpic ic"><Icon name="gear" /></span><span class="acname">Settings</span>
          </button>
          <button class="opt focus acrow" data-focus="ac-out" onclick={signOut}>
            <span class="acpic ic"><Icon name="signout" /></span><span class="acname">Sign out {cfg.userName}</span>
          </button>
        </div>
      {:else if HM.open === 'settings'}
        <SettingsMenu />
      {:else if HM.open === 'mylib' || HM.open === 'mylib-del'}
        <MyLibraryMenu />
      {/if}
    </div>
  </div>
</div>
