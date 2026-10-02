<script>
  /* Route `downloads`: titles saved on this iPhone (lib/offline.svelte.js).
   * Reached from Settings and from the offline banner — it works with the
   * server unreachable. Tap a finished one to play it from the phone; tap a
   * running one to pause it, a paused one to resume; long-press for Delete
   * (confirmed in an action sheet: a copy can take an evening to fetch).
   * The trailing control carries the state (DL-01): a ring with a stop
   * square while downloading, a dashed ring while waiting, the ring at its %
   * with the arrow while paused, the play disc when done — and a finished
   * download completes its ring and pops into the play disc while you look.
   * The storage line is navigator.storage.estimate(). */
  import { onDestroy } from 'svelte';
  import NavBar from '../components/NavBar.svelte';
  import List from '../components/List.svelte';
  import Row from '../components/Row.svelte';
  import Icon from '../components/Icon.svelte';
  import Art from '../components/Art.svelte';
  import ProgressRing from '../components/ProgressRing.svelte';
  import StateMessage from '../components/StateMessage.svelte';
  import ContextMenu from '../components/ContextMenu.svelte';
  import { scrollPast, longpress } from '../lib/gestures.js';
  import { OFF, refreshStorage, freeBytes, playOffline, pauseDownload, resumeDownload, deleteDownload, artUrl, offlineSupported } from '../lib/offline.svelte.js';
  import { humanBytes } from '$lib/activity.svelte.js';
  import { cfg } from '$lib/config.js';
  import { conn } from '../lib/conn.svelte.js';
  import { confirm } from '../lib/confirm.svelte.js';
  import { reducedMotion, DUR, SPRING } from '../lib/safe.js';

  let { params = {}, active = false } = $props();
  let solid = $state(false);

  $effect(() => {
    if (active) refreshStorage();
  });

  const mine = $derived(OFF.list.filter((e) => e.user === cfg.userId).slice().sort((a, b) => b.added - a.added));
  const others = $derived(OFF.list.length - mine.length);
  const used = $derived(mine.reduce((a, e) => a + (e.bytes || 0), 0));
  const free = $derived(freeBytes());

  /* Covers from the offline cache (object URLs), for every state: offline.svelte.js
   * caches the artwork when a download starts. Re-read when an entry's `pics`
   * says more landed; until then (queued) the Jellyfin URL, if online; else
   * the title lettered on the placeholder. */
  const COVER = ['poster', 'still', 'art'];
  let arts = $state({}); // id → { v, url }
  let dead = false;
  $effect(() => {
    const ids = new Set();
    for (const e of mine) {
      ids.add(e.id);
      const v = e.pics || 0;
      const have = arts[e.id];
      if (have && have.v === v) continue;
      arts[e.id] = { v, url: have?.url || null };
      artUrl(e.id, COVER).then((u) => {
        const cur = arts[e.id];
        if (dead || !u || !cur || cur.v !== v) {
          if (u) URL.revokeObjectURL(u);
          return;
        }
        if (cur.url) URL.revokeObjectURL(cur.url);
        arts[e.id] = { v, url: u };
      });
    }
    for (const id of Object.keys(arts)) {
      if (ids.has(id)) continue;
      if (arts[id].url) URL.revokeObjectURL(arts[id].url);
      delete arts[id];
    }
  });
  onDestroy(() => {
    dead = true;
    for (const a of Object.values(arts)) if (a.url) URL.revokeObjectURL(a.url);
  });
  const cover = (e) => arts[e.id]?.url || (!conn.offline && (e.img?.poster || e.img?.still)) || null;
  // the lettering: an episode's show (older entries only have it in `line`)
  const lettering = (e) => (e.type === 'Episode' ? e.series || (e.line || '').split(' · ')[0] : e.title) || e.title || '';

  function status(e) {
    const pct = e.total ? Math.floor((e.done / e.total) * 100) : 0;
    if (e.state === 'done') return humanBytes(e.bytes) + (e.pos > 60 ? ' · watched to ' + Math.floor(e.pos / 60) + ' min' : '');
    if (e.state === 'downloading') return (e.total ? pct + '% · ' : 'Starting · ') + humanBytes(e.bytes) + (e.est ? ' of ~' + humanBytes(e.est) : '');
    if (e.state === 'queued') return 'Waiting' + (e.total ? ' · ' + pct + '%' : '');
    if (e.state === 'paused') return (e.error || 'Paused') + (e.total ? ' · ' + pct + '%' : '');
    return e.error || 'Failed';
  }

  /* Finish moment: an entry that goes downloading → done while this page is
   * on screen keeps its ring one beat at 100 %, then pops into the play
   * disc. Only then — not on mount, not while the page is hidden. */
  const seen = new Map(); // id → last state
  let finishing = $state({}); // id → true while the ring completes
  let popping = $state({}); // id → true: the play disc pops in once
  $effect(() => {
    for (const e of mine) {
      const was = seen.get(e.id);
      seen.set(e.id, e.state);
      if (active && was === 'downloading' && e.state === 'done' && !reducedMotion()) {
        finishing[e.id] = true;
        setTimeout(() => {
          delete finishing[e.id];
          popping[e.id] = true; // read once, by the disc's mount
          setTimeout(() => delete popping[e.id], DUR.springQuick);
        }, DUR.base + 80);
      }
    }
  });
  function pop(node, on) {
    if (on) node.animate([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'scale(1)' }], { duration: DUR.springQuick, easing: SPRING.bouncy });
  }
  const pct = (e) => (e.total ? e.done / e.total : 0);

  async function askDelete(e) {
    const ok = await confirm({
      message:
        e.state === 'done'
          ? '“' + (e.title || 'This download') + '” is removed from this iPhone. Watching it again needs the server.'
          : 'The download stops and what has arrived so far is removed from this iPhone.',
      action: e.state === 'done' ? 'Delete Download' : 'Cancel and Delete',
      cancel: e.state === 'done' ? 'Cancel' : 'Keep Downloading'
    });
    if (ok) deleteDownload(e.id);
  }

  function tap(e) {
    if (e.state === 'done') playOffline(e.id);
    else if (e.state === 'downloading' || e.state === 'queued') pauseDownload(e.id);
    else resumeDownload(e.id);
  }

  let menu = $state({ open: false, rect: null, items: [], label: '' });
  function openMenu(e, d) {
    menu = {
      open: true,
      rect: d.rect,
      label: e.title,
      items: [
        e.state === 'done' && { label: 'Play', icon: 'play', action: () => playOffline(e.id) },
        (e.state === 'downloading' || e.state === 'queued') && { label: 'Pause', icon: 'pause', action: () => pauseDownload(e.id) },
        (e.state === 'paused' || e.state === 'error') && { label: 'Resume download', icon: 'download', action: () => resumeDownload(e.id) },
        { sep: true },
        { label: e.state === 'done' ? 'Delete download' : 'Cancel and delete', icon: 'trash', danger: true, action: () => askDelete(e) }
      ].filter(Boolean)
    };
  }
</script>

<main class="screen downloads" use:scrollPast={{ y: 24, onchange: (s) => (solid = s) }}>
  <div class="spacer-navbar"></div>
  <header class="pagehead">
    <h1 class="pagehead__title">Downloads</h1>
    <p class="pagehead__sub">
      {mine.length ? humanBytes(used) + ' on this iPhone' : 'On this iPhone'}{free != null ? ' · ' + humanBytes(free) + ' free' : ''}
    </p>
  </header>

  {#if !offlineSupported()}
    <StateMessage icon="download" title="Downloads need iOS 17.1 or later" text="This browser can’t play saved videos." />
  {:else if !mine.length}
    <StateMessage
      icon="download"
      title="Nothing downloaded"
      text="Tap Download on a movie or episode to watch it without your server. Downloads only run while VibeReel is open."
    />
  {:else}
    <List label="Saved on this iPhone" foot="Tap to play. While downloading, tap to pause. Press and hold to delete. Where you stop is sent to Jellyfin the next time it can be reached.">
      {#each mine as e (e.id)}
        <!-- the wrapper holds the long-press; .dl__item + .dl__item draws the hairline the wrapper hid from .row + .row -->
        <div class="dl__item" use:longpress={(d) => openMenu(e, d.detail || d)}>
          <Row title={e.title || 'Untitled'} sub={e.line} onclick={() => tap(e)}>
            {#snippet lead()}
              <Art class="dl__art" src={cover(e)} label={lettering(e)} labelSm eager />
            {/snippet}
            {#snippet trail()}
              {#if finishing[e.id]}
                <ProgressRing p={1} label="" class="dl__ring" />
              {:else if e.state === 'done'}
                <span class="dl__state" use:pop={popping[e.id]}><Icon name="play" /></span>
              {:else if e.state === 'error'}
                <span class="dl__state dl__state--err"><Icon name="alert" /></span>
              {:else if e.state === 'downloading'}
                <ProgressRing p={pct(e)} label="" class="dl__ring">
                  <span class="dl__stop" aria-hidden="true"></span>
                </ProgressRing>
              {:else if e.state === 'queued'}
                <ProgressRing p={0} label="" class="dl__ring dl__ring--queued" />
              {:else}
                <ProgressRing p={pct(e)} label="" class="dl__ring"><Icon name="download" size="xs" /></ProgressRing>
              {/if}
            {/snippet}
            <span class="dl__status {e.state === 'error' ? 'dl__status--err' : ''}">{status(e)}</span>
          </Row>
        </div>
      {/each}
    </List>
    {#if others}<p class="dl__others">{others} more saved by another account on this iPhone.</p>{/if}
  {/if}
</main>

<NavBar title="Downloads" {solid} />

<ContextMenu open={menu.open} rect={menu.rect} items={menu.items} label={menu.label} onclose={() => (menu = { ...menu, open: false })} />
