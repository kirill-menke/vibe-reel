<script>
  import { decoded } from '../lib/decoded.js';
  import { onMount } from 'svelte';
  import TechGrid from '../components/TechGrid.svelte';
  import Tile from '../components/Tile.svelte';
  import Icon from '../components/Icon.svelte';
  import CollectionRail from '../components/CollectionRail.svelte';
  import { pickTrailer, openTrailer as playInApp } from '../lib/trailer.js';
  import { cfg } from '../lib/config.js';
  import { api, qs, errText, imgUrl, personImg, GRID_FIELDS } from '../lib/api.js';
  import { fmtDate, fmtRuntime, fmtTime, ticksToSec, yearOf } from '../lib/format.js';
  import { pickSource, describeTracks, heroBadges } from '../lib/tracks.js';
  import { openItem, openPerson, takeDetailFocus } from '../lib/nav.svelte.js';
  import { P, playItem } from '../lib/player.svelte.js';
  import { focusEl, focusKey, scrollElTo } from '../lib/focus.js';
  import { setPlayed } from '../lib/played.js';
  import { toast } from '../lib/toast.svelte.js';

  /** @type {{ item: Jf.BaseItemDto }} */
  let { item } = $props();

  let similar = $state(/** @type {Jf.BaseItemDto[]} */ ([]));
  /* An Episode DTO carries SeriesId/SeriesName but nothing that counts the
     series' seasons, so the "N seasons ›" button costs one extra request — and
     it asks the same endpoint SeriesDetail lists its pills from, so the number
     on the button can never disagree with the number of pills on the next
     screen. Until it lands (or if it fails) the button reads just "Seasons ›". */
  let seasonCount = $state(0);

  const src = $derived(pickSource(item));
  const bg = $derived(imgUrl(item, 'Backdrop', { w: 1920 }) || imgUrl(item, 'Primary', { h: 1080 }));
  /* The watched toggle's answer. Kept here rather than written into `item`,
   * which belongs to Detail.svelte. */
  let udNow = $state(/** @type {Jf.UserItemData | null} */ (null));
  const ud = $derived(udNow || item.UserData || {});
  const resumeSec = $derived(ticksToSec(ud.PlaybackPositionTicks));
  const canResume = $derived(resumeSec > 30);
  const pct = $derived(ud.PlayedPercentage ? Math.min(100, ud.PlayedPercentage) : 0);
  /* The file's headline badges (4K · Dolby Vision · DD+ Atmos) sit under the
     metarow like SeriesDetail's; the full per-track detail is in .body. */
  const badges = $derived(heroBadges(item));
  function toggleWatched() {
    const want = !ud.Played;
    setPlayed(item.Id, want)
      .then((r) => {
        udNow = r || { ...ud, Played: want, PlaybackPositionTicks: 0 };
        toast(want ? 'Marked watched' : 'Marked unwatched');
      })
      .catch((err) => toast('Couldn’t update: ' + errText(err)));
  }

  /* Trailer: TMDB's YouTube list from Jellyfin, opened in the YouTube app. */
  const trailer = $derived(pickTrailer(item));
  function openTrailer() {
    playInApp(trailer, { title: item.Name, art: bg });
  }
  /* The film's TMDB collection, if it has one (see CollectionRail). */
  const collId = $derived(item.Type === 'Movie' ? item.ProviderIds?.TmdbCollection || '' : '');
  /** @type {(value?: unknown) => void} the Promise's resolve */
  // svelte-ignore non_reactive_update — assigned synchronously by the Promise executor on the next line, before the template first reads it, and never again
  let collDone;
  const collP = new Promise((r) => (collDone = r));

  const tagline = $derived((item.Taglines && item.Taglines[0]) || '');
  const cast = $derived((item.People || []).filter((p) => p.Type === 'Actor').slice(0, 12));
  /* An actor can be listed twice (two roles), so the key needs the position. */
  /** @type {(p: Jf.BaseItemPerson, i: number) => string} */
  const castKey = (p, i) => 'cast-' + p.Id + '-' + i;
  const seasonLabel = $derived(seasonCount ? seasonCount + (seasonCount === 1 ? ' season' : ' seasons') : 'Seasons');

  const credits = $derived.by(() => {
    const people = item.People || [];
    const dir = people.filter((p) => p.Type === 'Director').map((p) => p.Name);
    const wri = people.filter((p) => p.Type === 'Writer').map((p) => p.Name);
    const parts = [];
    if (dir.length) parts.push('Directed by ' + dir.slice(0, 2).join(', '));
    if (wri.length) parts.push('Written by ' + wri.slice(0, 2).join(' & '));
    if (item.Studios && item.Studios.length) parts.push(item.Studios[0].Name);
    if (item.DateCreated) parts.push('Added ' + fmtDate(item.DateCreated));
    return parts.join(' · ');
  });

  const epLine = $derived.by(() => {
    if (item.Type !== 'Episode') return [];
    const eb = [];
    if (item.SeriesName) eb.push(item.SeriesName);
    if (item.ParentIndexNumber != null) eb.push('Season ' + item.ParentIndexNumber);
    if (item.IndexNumber != null) {
      eb.push(
        'Episode ' +
          item.IndexNumber +
          (item.IndexNumberEnd != null && item.IndexNumberEnd !== item.IndexNumber ? '–' + item.IndexNumberEnd : '')
      );
    }
    return eb;
  });

  /* ensureVisible() scrolls just far enough to reveal the target, so walking
     back up from the cast rail leaves the hero a few hundred pixels short of
     the top. The hero's only focusables are the action buttons — the top row —
     so landing there means "go all the way home". Deferred by a microtask —
     focusin fires synchronously inside el.focus(), before focusEl's own
     ensureVisible(), so a microtask runs after every competing retarget; the
     timeout is the backstop for webOS starving the compositor (a bare rAF can
     simply never run here). Re-checked because a held ▲/▼ can move focus off
     the hero again before the deferral lands. */
  /** @param {FocusEvent} e */
  function homeOnTopRow(e) {
    const t = /** @type {Element | null} */ (e.target);
    if (!t || !t.closest || !t.closest('.hero')) return;
    const page = t.closest('.page');
    if (!page) return;
    const snap = () => {
      const a = document.activeElement;
      if (a && a.closest && a.closest('.hero')) scrollElTo(page, 0);
    };
    queueMicrotask(snap);
    setTimeout(snap, 120);
  }

  /* D-pad routing between the action buttons, the TechGrid "+N" chips and the
     rails. Geometry alone would send ▼ from the buttons into the chips (or past
     them, depending on where the "+N" happens to end its row); the chips are a
     detour, so the vertical path is buttons ⇅ first rail (Cast, else the
     collection, else More Like This) and the chips hang off to the side: ▶ from the rightmost button
     enters them, ▲/◀ from a chip goes back to the button you came from, ▼ steps
     audio "+N" → subtitles "+N" → rail. Bubbles to here before Keys.svelte's
     window handler, which stopPropagation() keeps out of it. */
  /** @type {Element | null} */
  let lastBtn = null;
  /** @type {(els: Element[], from: Element) => Element | null} */
  const nearestX = (els, from) => {
    const fr = from.getBoundingClientRect();
    const cx = fr.left + fr.width / 2;
    let best = null;
    let bd = Infinity;
    for (const e of els) {
      const r = e.getBoundingClientRect();
      const d = Math.abs(r.left + r.width / 2 - cx);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  };
  const firstRail = () => {
    const rail = document.querySelector('.screen .page > .rail');
    return rail ? [...rail.querySelectorAll('.focus')].filter((e) => e.checkVisibility()) : [];
  };
  const chips = () => [...document.querySelectorAll('.screen .techgrid .tchip.more.focus')];
  const buttons = () => [...document.querySelectorAll('.screen .hero .actions .focus')];
  /** @param {KeyboardEvent} e @param {Element | null | undefined} el */
  function go(e, el) {
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    focusEl(el);
  }
  /** @param {KeyboardEvent} e */
  function pageKey(e) {
    const k = e.keyCode;
    if (k < 37 || k > 40) return;
    const a = document.activeElement;
    if (!a || !a.closest) return;
    if (a.closest('.hero .actions')) {
      lastBtn = a;
      if (k === 40) go(e, nearestX(firstRail(), a));
      else if (k === 39) {
        const bs = buttons();
        if (a === bs[bs.length - 1]) go(e, chips()[0]);
      }
      return;
    }
    if (a.matches('.techgrid .tchip.more')) {
      const cs = chips();
      const i = cs.indexOf(a);
      const back = lastBtn && lastBtn.isConnected ? lastBtn : buttons().pop();
      if (k === 37 || (k === 38 && i === 0)) go(e, back);
      else if (k === 38) go(e, cs[i - 1]);
      else if (k === 40) go(e, cs[i + 1] || nearestX(firstRail(), a));
      return;
    }
    // ▲ off the first rail skips the chips too, straight back to the buttons.
    if (k === 38 && a.closest('.page > .rail') && !/** @type {Element} */ (a.closest('.rail')).previousElementSibling?.matches('.rail')) {
      go(e, nearestX(buttons(), a));
    }
  }

  onMount(async () => {
    // Seed the track selection so the tech grid marks the right default audio
    // and the player menu opens on the right rows.
    P.detailItem = item;
    P.source = src;
    P.series = null;
    const t = describeTracks(src, item);
    P.audioIndex = t.defaultAudio;
    P.subIndex = t.defaultSub;

    /* Back along the detail trail (nav.svelte.js) lands on the element this
       page was left from — a cast member, a More Like This tile, "Seasons ›".
       The tiles only exist once /Similar has answered. */
    const back = takeDetailFocus();
    let similarDone;
    const similarP = new Promise((r) => (similarDone = r));
    /* Tiles on the async rails (More Like This, the collection) aren't there
       yet — those restores wait for their rail below. */
    /** @param {string | null} k */
    const lateTile = (k) => k && (k.startsWith('tile-') || k.startsWith('lk-'));
    if (!back || !(await focusKey(back))) {
      if (!lateTile(back)) await focusKey('play');
    }
    if (!collId) collDone();

    if (item.Type === 'Episode' && item.SeriesId) {
      /** @type {Promise<Jf.QueryResult>} */ (api('/Shows/' + item.SeriesId + '/Seasons' + qs({ UserId: cfg.userId })))
        .then((/** @type {Jf.QueryResult} */ r) => {
          seasonCount = (r.Items || []).filter((s) => s.Type === 'Season').length;
        })
        .catch(() => {});
    }

    /** @type {Promise<Jf.QueryResult>} */ (api('/Items/' + item.Id + '/Similar' + qs({ userId: cfg.userId, Limit: 12, Fields: GRID_FIELDS })))
      .then((r) => {
        similar = r.Items || [];
      })
      .catch(() => {})
      .finally(similarDone);

    if (back && back.startsWith('tile-')) {
      await similarP;
      if (!(await focusKey(back))) await focusKey('play');
    } else if (back && back.startsWith('lk-')) {
      await collP;
      if (!(await focusKey(back))) await focusKey('play');
    }
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="screen" onfocusin={homeOnTopRow} onkeydown={pageKey}>
  <div class="page">
    <div class="hero movie">
      <div class="backdrop">{#if bg}<img use:decoded={bg} alt="" />{/if}</div>
      <div class="scrim-l"></div>
      <div class="scrim-b"></div>
      <div class="info">
        {#if epLine.length}
          <div class="eyebrow ep">
            {#each epLine as part, i (part)}{#if i}<span class="dot"> · </span>{/if}{part}{/each}
          </div>
        {/if}
        <div class="title">{item.Name}</div>
        {#if tagline}<div class="tagline">{tagline}</div>{/if}
        <div class="metarow">
          <span>{yearOf(item)}</span>
          {#if fmtRuntime(item.RunTimeTicks)}<span class="dot">·</span><span>{fmtRuntime(item.RunTimeTicks)}</span>{/if}
          {#if item.OfficialRating}<span class="dot">·</span><span class="fsk">{item.OfficialRating}</span>{/if}
          {#if item.CommunityRating}
            <span class="star">★ {item.CommunityRating.toFixed(1)}</span>
            {#if item.VoteCount}<span class="votes">({item.VoteCount})</span>{/if}
          {/if}
          {#if item.Genres?.length}<span class="dot">·</span><span class="genres">{item.Genres.slice(0, 3).join(' · ')}</span>{/if}
          {#if badges.length}
            <div class="badgerow">{#each badges as b (b)}<span class="chip sm">{b}</span>{/each}</div>
          {/if}
        </div>
        {#if item.Overview}<div class="overview">{item.Overview}</div>{/if}
        <div class="actions">
          <button
            class="btn primary big focus"
            class:hasbar={canResume && pct}
            data-focus="play"
            onclick={() => playItem(item, canResume ? Math.floor(resumeSec) : 0)}
          >▶ {canResume ? 'Resume · ' + fmtTime(resumeSec) : 'Play'}{#if canResume && pct}<span class="rbar"><i style="width:{pct}%"></i></span>{/if}</button>
          {#if canResume}
            <button class="btn ghost big focus" data-focus="restart" onclick={() => playItem(item, 0)}
              ><Icon name="restart" inline />Start over</button
            >
          {/if}
          <button class="btn ghost big focus watchbtn" class:on={ud.Played} data-focus="watched" onclick={toggleWatched}
            ><Icon name="checkthin" inline />{ud.Played ? 'Watched' : 'Mark watched'}</button
          >
          {#if trailer}
            <button class="btn ghost big focus" data-focus="trailer" onclick={openTrailer}
              ><Icon name="trailer" inline />Trailer</button
            >
          {/if}
          {#if item.Type === 'Episode' && item.SeriesId}
            <!-- .chev is a CSS-drawn chevron, not a "›" glyph: it must not depend
                 on the webOS font and it is sized independently of the label. -->
            <button
              class="btn ghost big focus"
              data-focus="goseries"
              onclick={() => openItem(/** @type {string} */ (item.SeriesId), 'Series')}
              >{seasonLabel}<span class="chev" aria-hidden="true"></span></button
            >
          {/if}
        </div>
      </div>
    </div>

    <!-- Tech details under the button row, compact: the audio row capped and the
         subtitle languages collapsed behind a "+N" that expands in place. -->
    <div class="body">
      <TechGrid {item} {src} compact markSelected={false} fkey="tg" />
      {#if credits}<div class="credits">{credits}</div>{/if}
    </div>

    {#if cast.length}
      <div class="rail">
        <h2>Cast</h2>
        <div class="cast-strip">
          {#each cast as p, i (p.Id + '-' + i)}
            <button class="cast focus" data-focus={castKey(p, i)} onclick={() => openPerson(p.Id, p.Name)}>
              <div class="head">
                {#if personImg(p)}<img loading="lazy" src={personImg(p)} alt="" />{:else}photo{/if}
              </div>
              <div class="n">{p.Name}</div>
              <div class="r">{p.Role || ''}</div>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    {#if collId}
      <CollectionRail id={collId} self={item.ProviderIds?.Tmdb} owned onready={collDone} />
    {/if}

    {#if similar.length}
      <div class="rail">
        <h2>More Like This</h2>
        <div class="strip">
          {#each similar as it (it.Id)}
            <Tile item={it} kind="added" />
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>
