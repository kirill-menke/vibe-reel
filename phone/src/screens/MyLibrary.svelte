<script>
  /* Route `mylibrary` (run/design.md §7.2): what the signed-in user added and
   * how much room is left — reel-api GET /api/me via the shared me.svelte.js.
   * Pushed from the Accounts sheet's and Settings' "My library" rows, and from
   * LookupDetail's "Quota full" button.
   *
   * A normal user sees a bar per kind ("3 of 10"; a full one says so), an
   * admin "Admin · No limit". Below, the titles this user added (an admin: the
   * ones they added — older titles belong to nobody): poster, title, status —
   * live from the activity feed while a download runs (the page can stay up
   * for minutes; /api/me is a snapshot), else the server's word. Tap opens the
   * title (lookupOpener: Jellyfin detail / pending / lookup page); the trash
   * button asks in an action sheet, then deletes the title *with its files*
   * from the server (askDelete → deleteTitle). Its slot is free at once.
   *
   * Asked again whenever the page comes to the top (maxAge 10 s), and when a
   * title's download leaves the feed while the page is up (it landed, or
   * failed: the snapshot's status is stale then). An old reel-api (404) has no
   * My library: the rows that lead here aren't shown, and a restored route
   * says so instead of spinning. */
  import NavBar from '../components/NavBar.svelte';
  import List from '../components/List.svelte';
  import Row from '../components/Row.svelte';
  import Icon from '../components/Icon.svelte';
  import Art from '../components/Art.svelte';
  import Button from '../components/Button.svelte';
  import ProgressBar from '../components/ProgressBar.svelte';
  import Skeleton from '../components/Skeleton.svelte';
  import StateMessage from '../components/StateMessage.svelte';
  import { scrollPast } from '../lib/gestures.js';
  import { askDelete } from '../lib/mylib.js';
  import { S, openSearch } from '$lib/nav.svelte.js';
  import { ME, refreshMe, deleting, titleKey, titleStatus } from '$lib/me.svelte.js';
  import { lookupOpener, lookupGroup } from '$lib/lookup.svelte.js';
  import { posterThumb } from '$lib/medialib.js';
  import { cfg } from '$lib/config.js';

  let { params = {}, active = false } = $props();
  let solid = $state(false);

  $effect(() => {
    if (active) refreshMe({ maxAge: 10000 });
  });

  const me = $derived(ME.me);
  const titles = $derived(me ? me.titles : []);
  /* each title's activity group (downloads in flight), by title key */
  const live = $derived(new Map(titles.map((t) => [titleKey(t), lookupGroup(t)])));

  /* a download that left the feed while the page is up: ask again */
  /** @type {Set<string>} */
  let flying = new Set();
  $effect(() => {
    const now = new Set([...live].filter(([, g]) => g).map(([k]) => k));
    const left = [...flying].some((k) => !now.has(k) && live.has(k));
    flying = now;
    if (left && active) refreshMe();
  });

  /** @type {[Reel.MediaType, string][]} */
  const KINDS = [
    ['movie', 'Movies'],
    ['tv', 'Shows']
  ];
  /** @param {Reel.QuotaUse} q */
  const isFull = (q) => q.limit != null && q.used >= q.limit;
  /** @param {Reel.QuotaUse} q @returns {number} 0..1 */
  const frac = (q) => (q.limit ? Math.min(1, q.used / q.limit) : 1);

  /** @param {Reel.OwnedTitle} t */
  const kindLine = (t) => (t.type === 'tv' ? 'Show' : 'Movie') + (t.year ? ' · ' + t.year : '');

  /* Open the richest page for it; navigating away meanwhile (S.epoch) cancels. */
  let opening = false;
  /** @param {Reel.OwnedTitle} t */
  async function open(t) {
    if (opening || deleting[titleKey(t)]) return;
    opening = true;
    const ep = S.epoch;
    try {
      const go = await lookupOpener({ id: t.id, type: t.type, title: t.title, year: t.year ?? undefined, poster: t.poster, added: true });
      if (S.epoch === ep) go();
    } finally {
      opening = false;
    }
  }
</script>

<main class="screen mylib" use:scrollPast={{ y: 24, onchange: (s) => (solid = s) }}>
  <div class="spacer-navbar"></div>
  <header class="pagehead">
    <h1 class="pagehead__title">My library</h1>
    <p class="pagehead__sub">{me?.user.name || cfg.userName || 'You'} · this server</p>
  </header>

  {#if me}
    <List label="Your quota" foot={me.admin ? 'Admins can add as many titles as they like.' : 'Deleting a title frees its slot.'}>
      {#if me.admin}
        <Row icon="star" title="Admin" value="No limit" />
      {:else}
        {#each KINDS as [k, label] (k)}
          {@const q = me.quota[k]}
          <Row class="mylib__q {isFull(q) ? 'is-full' : ''}" icon={k === 'tv' ? 'shows' : 'movies'} title={label} value={q.used + ' of ' + q.limit + (isFull(q) ? ' · full' : '')} data-kind={k}>
            <ProgressBar class="mylib__bar" p={frac(q)} label={label + ': ' + q.used + ' of ' + q.limit + ' used'} />
          </Row>
        {/each}
      {/if}
    </List>

    {#if titles.length}
      <List group label={me.admin ? 'Titles you added' : 'Your titles'} foot="Tap a title to open it. Deleting removes it and its files from the server, for everyone.">
        {#each titles as t (titleKey(t))}
          {@const busy = !!deleting[titleKey(t)]}
          <div class="mylib__item {busy ? 'is-deleting' : ''}" data-key={titleKey(t)}>
            <Row title={t.title} sub={kindLine(t)} onclick={() => open(t)}>
              {#snippet lead()}<Art class="dl__art" src={posterThumb(t.poster)} label={t.title} labelSm />{/snippet}
              <span class="row__sub mylib__status {t.status === 'in_library' && !live.get(titleKey(t)) ? 'is-in' : ''}">{titleStatus(t, live.get(titleKey(t)))}</span>
            </Row>
            <button type="button" class="iconbtn iconbtn--plain mylib__del" aria-label={'Delete ' + t.title} disabled={busy} onclick={() => askDelete(t)}>
              <Icon name="trash" />
            </button>
          </div>
        {/each}
      </List>
    {:else}
      <StateMessage icon="plus" title="Nothing added yet" text="Titles you add from Search show up here.">
        {#snippet actions()}<Button variant="surface" icon="search" onclick={openSearch}>Search</Button>{/snippet}
      </StateMessage>
    {/if}
  {:else if ME.state === 'unsupported'}
    <StateMessage icon="server" title="Not available" text="Your server doesn’t keep track of who added what yet." />
  {:else if ME.state === 'error'}
    <StateMessage icon="cloud-off" error title="Couldn’t load your library" text="The server didn’t answer.">
      {#snippet actions()}<Button variant="surface" icon="refresh" onclick={() => refreshMe()}>Try again</Button>{/snippet}
    </StateMessage>
  {:else}
    <div class="mylib__skel" aria-busy="true">
      <Skeleton kind="line-lg" w="40%" />
      <Skeleton h="88px" />
    </div>
  {/if}
</main>

<NavBar title="My library" {solid} />
