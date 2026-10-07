<script>
  /* Notifications — the bell's large sheet (design screens/10-notifications*.html),
   * the TV's TopNav bell menu on the phone:
   *   Ready to watch  landed.svelte.js entries (imports Jellyfin confirmed)
   *   New seasons     news.svelte.js: aired → Get (mlSeasonSearch via getSeason,
   *                   which also handles 409 not_aired; its toast has Undo →
   *                   undoGetSeason), upcoming → premiere date,
   *                   downloading → live ring
   * Opening marks everything seen (as the TV's menu); rows that were unseen at
   * that moment keep their gold dot while the sheet is up. A row tap closes the
   * sheet, then opens the title on the current tab. */
  import { onMount } from 'svelte';
  import Sheet from '../components/Sheet.svelte';
  import Art from '../components/Art.svelte';
  import Icon from '../components/Icon.svelte';
  import Button from '../components/Button.svelte';
  import ProgressRing from '../components/ProgressRing.svelte';
  import StateMessage from '../components/StateMessage.svelte';
  import { closeSheet } from '../lib/router.svelte.js';
  import { news, markAllSeen, seasonActivity, getSeason, newsLine, searchState } from '$lib/news.svelte.js';
  import { landed, markLandedSeen, landedLine, landedAgo } from '$lib/landed.svelte.js';
  import { lookupOpener } from '$lib/lookup.svelte.js';
  import { posterThumb } from '$lib/medialib.js';
  import { STATUS_LABEL } from '$lib/activity.svelte.js';
  import { openItem } from '$lib/nav.svelte.js';
  import { MON } from '$lib/format.js';

  let { params = {} } = $props();

  onMount(() => {
    markAllSeen();
    markLandedSeen();
  });

  const empty = $derived(!landed.items.length && !news.items.length && news.loaded);

  /** @param {VR.LandedEntry} e */
  function openLanded(e) {
    closeSheet();
    openItem(e.id, e.jfType);
  }

  let opening = false;
  /** @param {Reel.NewsItem} it */
  async function openShow(it) {
    if (opening) return;
    opening = true;
    closeSheet();
    try {
      const open = await lookupOpener({ id: it.media_id, type: 'tv', title: it.title, year: it.year, poster: it.poster, added: true });
      open();
    } finally {
      opening = false;
    }
  }

  /* landedLine() says "S1E8"; the sheet has room to spell it out */
  /** @param {VR.LandedEntry} e */
  function landedSub(e) {
    if (e.type !== 'tv') return 'Movie · now in your library';
    if (e.eps.length === 1) {
      const [s, ep] = e.eps[0].split('x');
      return 'Season ' + s + ' · Episode ' + ep;
    }
    return landedLine(e);
  }

  /** @param {string} iso */
  function premiere(iso) {
    const d = new Date(iso);
    const s = d.getDate() + ' ' + MON[d.getMonth()];
    return d.getFullYear() === new Date().getFullYear() ? s : s + ' ' + d.getFullYear();
  }

  /* second line of a season row: what it is */
  /** @param {Reel.NewsItem} it @param {VR.SeasonActivity | null} dl */
  function seasonSub(it, dl) {
    if (dl) return 'Season ' + it.season + ' · ' + (STATUS_LABEL[dl.status] || 'Downloading').toLowerCase();
    return 'Season ' + it.season + ' · ' + (it.kind === 'upcoming' ? 'coming' : 'aired');
  }

  /* third line: the TV's newsLine / live search state */
  /** @param {Reel.NewsItem} it @param {VR.SeasonActivity | null} dl @param {VR.SeasonSearchState} st */
  function seasonTime(it, dl, st) {
    if (dl) return (st ? 'Found — ' : '') + (dl.status === 'downloading' ? Math.round(dl.progress * 100) + '% downloaded' : STATUS_LABEL[dl.status] || '');
    if (st === 'searching') return 'Searching the indexers…';
    if (st === 'none') return 'Nothing found yet — Retry searches again';
    if (st === 'found') return 'Found — on its way into your library';
    if (it.kind === 'upcoming') return it.premiere ? 'Downloads when it airs' : 'Announced · no date yet';
    return newsLine(it);
  }
</script>

<Sheet title="Notifications" large>
  {#if empty}
    <div class="notifs__empty">
      <StateMessage
        icon="bell"
        title="You’re all caught up"
        text="New episodes, finished downloads and new seasons of your shows show up here."
      />
    </div>
  {:else}
    {#if landed.items.length}
      <p class="group__label notifs__label">Ready to watch</p>
      {#each landed.items as e (e.key)}
        <button type="button" class="notif {landed.fresh.includes(e.key) ? 'notif--unseen' : ''}" onclick={() => openLanded(e)}>
          <div class="notif__art"><Art src={e.poster} /></div>
          <div class="notif__main">
            <p class="notif__title">{e.title}</p>
            <p class="notif__sub">{landedSub(e)}</p>
            <p class="notif__time">{landedAgo(e.at)}</p>
          </div>
          <div class="notif__trail"><Icon name="chevron-right" size="sm" /></div>
        </button>
      {/each}
    {/if}

    <div class={landed.items.length ? 'group' : ''}>
      <p class="group__label notifs__label">New seasons</p>
      {#if !news.loaded && !news.items.length}
        <p class="notifs__loading"><span class="spinner"></span>Checking for new seasons…</p>
      {:else if !news.items.length}
        <p class="notifs__loading">No new seasons right now.</p>
      {/if}
      {#each news.items as it (it.id)}
        {@const dl = seasonActivity(it)}
        {@const st = searchState(it)}
        {@const canGet = it.kind === 'aired' && (!dl || st)}
        <!-- a div, not a button: the Get button nests inside -->
        <div
          class="notif {news.fresh.includes(it.id) ? 'notif--unseen' : ''}"
          role="button"
          tabindex="0"
          onclick={() => openShow(it)}
          onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && openShow(it)}
        >
          <div class="notif__art"><Art src={posterThumb(it.poster) || null} /></div>
          <div class="notif__main">
            <p class="notif__title">{it.title}</p>
            <p class="notif__sub">{seasonSub(it, dl)}</p>
            <p class="notif__time {st === 'found' ? 'notif__time--gold' : ''}">{seasonTime(it, dl, st)}</p>
          </div>
          <div class="notif__trail">
            {#if dl && dl.status === 'downloading' && !canGet}
              <ProgressRing p={dl.progress || 0} />
            {:else if canGet}
              <Button
                variant={st === 'searching' || st === 'found' ? 'surface' : 'primary'}
                sm
                busy={st === 'searching'}
                disabled={st === 'found'}
                onclick={(e) => {
                  e.stopPropagation();
                  getSeason(it);
                }}>{st === 'searching' ? 'Searching' : st === 'found' ? 'Found' : st === 'none' ? 'Retry' : 'Get'}</Button
              >
            {:else if it.kind === 'upcoming' && it.premiere}
              <span class="notif__date">Premieres<strong>{premiere(it.premiere)}</strong></span>
            {:else}
              <Icon name="chevron-right" size="sm" />
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</Sheet>
