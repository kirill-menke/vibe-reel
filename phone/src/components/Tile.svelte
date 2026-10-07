<script>
  /* Tile — `.tile`: art frame + title + sub. Give it a Jellyfin `item`, or the
   * explicit fields (they win over what the item implies), or both.
   *
   *   item        Jellyfin item → title, sub (year / "S2 · E4 · Name"), img,
   *               progress (UserData.PlayedPercentage), watched (Played, no
   *               unplayed episodes)
   *   variant     'poster' (2:3, rail width) | 'landscape' (16:9, 252 wide)
   *   fluid       width 100 % (grids size tiles themselves; use in a preview)
   *   title, sub, subGold   caption lines (sub '' hides it)
   *   img         image URL (else derived from item: Primary poster, or for
   *               landscape Thumb/Backdrop/Primary)
   *   eager       don't lazy-load the image
   *   progress    0–1 resume bar (0/null = none)
   *   inline      title and sub on one line: the title ellipsizes, the sub
   *               (right-aligned) stays whole — Continue Watching / Next Up
   *   badge       string | { text, kind: ''|'gold'|'outline', icon, bottom }
   *   watched     tick in the corner + quieter art
   *   count       gold corner badge with a download icon ("2 episodes downloading")
   *   rank        chart rank badge (gold for 1–3)
   *   onadd       shows the quick-add "+" button; called with (event) — the
   *               tap does NOT also open the tile
   *   addState    lookup.svelte.js's add state ('idle'|'adding'|'done'|'added'|
   *               'error'): the "+" answers where the finger is — a spinner
   *               while 'adding', then a gold ✓ that pops in, holds 1.2 s and
   *               fades away (only when this tile saw the add happen; a tile
   *               mounted already 'done' shows nothing). Pass onadd only for
   *               idle/error (polish LIB-02)
   *   tint        the image's average colour ('rgb(…)', blurhash avgColor())
   *               → the loading placeholder takes a dark version of it
   *   download    { status: 'downloading' | 'queued', p: 0–1, sub? } →
   *               dimmed art + ring with % (downloading) or clock + "Queued";
   *               `sub` replaces the caption's sub (gold while downloading)
   *   skeleton    render the loading placeholder instead (variant decides shape)
   *   onclick     tap;   onlongpress(detail)  hold 500 ms (context menu)
   *   label       aria-label (defaults to the title)
   *   class       extra classes on .tile;  children  extra overlays in the frame */
  import Art from './Art.svelte';
  import Icon from './Icon.svelte';
  import Badge from './Badge.svelte';
  import ProgressBar from './ProgressBar.svelte';
  import ProgressRing from './ProgressRing.svelte';
  import Skeleton from './Skeleton.svelte';
  import { imgUrl } from '$lib/api.js';
  import { yearOf } from '$lib/format.js';
  import { longpress } from '../lib/gestures.js';
  import { scale } from 'svelte/transition';
  import { rm, rmOut, DUR, springEase, easeIn } from '../lib/safe.js';

  /** @type {{ item?: Jf.BaseItemDto | null, variant?: 'poster' | 'landscape', fluid?: boolean, title?: string, sub?: string, subGold?: boolean, img?: string | null, eager?: boolean, progress?: number | null, inline?: boolean, badge?: VR.TileBadge | null, watched?: boolean, count?: number, rank?: number | null, onadd?: ((e: Event) => unknown) | null, addState?: VR.AddState | null, tint?: string | null, download?: VR.TileDownload | null, skeleton?: boolean, onclick?: ((e: MouseEvent | KeyboardEvent) => unknown) | null, onlongpress?: ((d: VR.LongPressDetail) => unknown) | null, label?: string, class?: string, children?: VR.Snip }} */
  let {
    item = null,
    variant = 'poster',
    fluid = false,
    title = undefined,
    sub = undefined,
    subGold = false,
    img = undefined,
    eager = false,
    progress = undefined,
    inline = false,
    badge = null,
    watched = undefined,
    count = 0,
    rank = null,
    onadd = null,
    addState = null,
    tint = null,
    download = null,
    skeleton = false,
    onclick = null,
    onlongpress = null,
    label = '',
    class: cls = '',
    children
  } = $props();

  const land = $derived(variant === 'landscape');
  const ud = $derived(item?.UserData || {});
  const isEp = $derived(item?.Type === 'Episode');

  /** @param {Jf.BaseItemDto} it */
  function epLine(it) {
    const s = it.ParentIndexNumber;
    const e = it.IndexNumber;
    const se = s != null || e != null ? `S${s ?? 0} · E${e ?? 0}` : '';
    return [se, it.Name].filter(Boolean).join(' · ');
  }

  const tTitle = $derived(title !== undefined ? title : item ? (isEp ? item.SeriesName || item.Name : item.Name) : '');
  const tSub = $derived(sub !== undefined ? sub : item ? (isEp ? epLine(item) : yearOf(item) || '') : '');
  const tImg = $derived(
    img !== undefined
      ? img
      : item
        ? land
          ? imgUrl(item, 'Thumb', { w: 760 }) || imgUrl(item, 'Backdrop', { w: 760 }) || imgUrl(item, 'Primary', { w: 760 })
          : imgUrl(item, 'Primary', { h: 540 })
        : null
  );
  const unplayed = $derived(item?.Type === 'Series' ? ud.UnplayedItemCount || 0 : 0);
  const tWatched = $derived(watched !== undefined ? watched : !!ud.Played && !unplayed);
  const tProgress = $derived(
    progress !== undefined ? progress : ud.PlayedPercentage && !ud.Played ? Math.min(100, ud.PlayedPercentage) / 100 : 0
  );
  const b = $derived(badge ? (typeof badge === 'string' ? { text: badge } : badge) : null);
  const dl = $derived(download && (download.status === 'downloading' || download.status === 'queued') ? download : null);
  const subText = $derived(dl && dl.sub !== undefined ? dl.sub : tSub);

  /** @param {MouseEvent | KeyboardEvent} e */
  function tap(e) {
    onclick?.(e);
  }
  /** @param {Event} e */
  function add(e) {
    e.stopPropagation();
    e.preventDefault();
    if (addState === 'adding') return;
    onadd?.(e);
  }

  /* quick-add: 'plus' | 'busy' | 'done' (the ✓, 1.2 s) | null (gone). The ✓
   * is driven here, not by a CSS animation: routes toggle [hidden], which
   * restarts CSS animations. */
  let sawAdding = false;
  let doneUntil = $state(0);
  $effect(() => {
    const st = addState;
    if (st === 'adding') sawAdding = true;
    else if (st === 'done' && sawAdding) {
      sawAdding = false;
      doneUntil = Date.now() + 1200;
      const t = setTimeout(() => (doneUntil = 0), 1200);
      return () => clearTimeout(t);
    } else if (st !== 'done') {
      sawAdding = false;
      doneUntil = 0;
    }
  });
  const addPhase = $derived(
    dl ? null : addState === 'adding' ? 'busy' : addState === 'done' && doneUntil ? 'done' : onadd ? 'plus' : null
  );
</script>

{#if skeleton}
  <div class="tile {land ? 'tile--landscape' : 'tile--poster'} {fluid ? 'tile--fluid' : ''} {cls}" aria-hidden="true">
    <Skeleton kind={land ? 'thumb' : 'poster'} />
    <Skeleton kind="line" w="80%" />
  </div>
{:else}
  <!-- a div with role=button, not a <button>: the quick-add button nests inside -->
  <div
    class="tile {land ? 'tile--landscape' : 'tile--poster'} {fluid ? 'tile--fluid' : ''} {tWatched && !dl ? 'tile--watched' : ''} {dl
      ? 'tile--' + dl.status
      : ''} {cls}"
    role="button"
    tabindex="0"
    aria-label={label || tTitle}
    onclick={tap}
    onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && tap(e)}
    use:longpress={{ onlongpress, disabled: !onlongpress }}
  >
    <div class="tile__frame">
      <Art src={tImg} {eager} label={tTitle} class={tint ? 'art--tint' : ''} style={tint ? '--tint: ' + tint : ''} />
      {#if rank != null}<Badge {rank} class="tile__rank" />{/if}
      {#if b}<Badge kind={b.kind || ''} icon={b.icon || ''} text={b.text} class="tile__badge {b.bottom ? 'tile__badge--bottom' : ''}" />{/if}
      {#if count}
        <Badge kind="gold" icon="download" text={String(count)} class="tile__corner" label="{count} downloading" />
      {:else if tWatched && !dl}
        <span class="tile__corner tick" aria-label="Watched"><Icon name="check" /></span>
      {/if}
      {#if dl}
        <div class="tile__overlay">
          {#if dl.status === 'downloading'}
            <ProgressRing p={dl.p || 0} glass />
          {:else}
            <span class="tile__queued"><Icon name="clock" size="sm" />Queued</span>
          {/if}
        </div>
      {/if}
      {#if (/** @type {number} */ (tProgress)) > 0 && !dl}<ProgressBar p={tProgress} class="tile__progress" />{/if}
      {#if addPhase}
        <button
          class="tile__add {addPhase === 'done' ? 'tile__add--done' : ''} {addPhase === 'busy' ? 'tile__add--busy' : ''}"
          type="button"
          aria-label={addPhase === 'busy' ? 'Adding ' + tTitle : addPhase === 'done' ? 'Added ' + tTitle : 'Add ' + tTitle + ' to library'}
          aria-disabled={addPhase !== 'plus' || undefined}
          onclick={add}
          out:scale={{ start: 0.8, duration: rmOut(DUR.fast), easing: easeIn }}
        >
          {#if addPhase === 'busy'}
            <span class="spinner tile__spin" aria-hidden="true"></span>
          {:else if addPhase === 'done'}
            <span class="tile__check" in:scale={{ start: 0.6, duration: rm(DUR.springQuick), easing: springEase.bouncy }}><Icon name="check" /></span>
          {:else}
            <Icon name="plus" />
          {/if}
        </button>
      {/if}
      {@render children?.()}
    </div>
    {#if inline}
      <p class="tile__cap">
        {#if tTitle}<span class="tile__title">{tTitle}</span>{/if}
        {#if subText}<span class="tile__sub {subGold || dl?.status === 'downloading' ? 'tile__sub--gold' : ''}">{subText}</span>{/if}
      </p>
    {:else}
      {#if tTitle}<p class="tile__title">{tTitle}</p>{/if}
      {#if subText}<p class="tile__sub {subGold || dl?.status === 'downloading' ? 'tile__sub--gold' : ''}">{subText}</p>{/if}
    {/if}
  </div>
{/if}
