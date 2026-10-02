<script>
  /* SeasonPills — `.pills` season picker. Sticky under the nav bar; it wears
   * the glass `.pills--sticky` look only while it is actually pinned.
   *   pills   [{ key, label, active, watched, dim, pct }]
   *   onpick(key)   onlong(key, detail)   (long-press: mark season)
   *   onpress(key)  touch-down on a pill that isn't selected (prefetch its list)
   *
   * Markup: the sticky bar (`.detail__pills`, the glass on its ::before) wraps
   * the horizontal scroller (`.pills`) — on the scroller itself the glass
   * layer would scroll sideways with the pills. */
  import { untrack } from 'svelte';
  import Icon from '../Icon.svelte';
  import { longpress } from '../../lib/gestures.js';
  import { reducedMotion } from '../../lib/safe.js';

  let { pills = [], onpick, onlong = null, onpress = null } = $props();
  let el = $state(null);
  let bar = $state(null);
  let mark = $state(null);
  let stuck = $state(false);

  /* Pinned = a 1-px mark just above the bar has gone up past the bar's
   * sticky line. An IntersectionObserver reports that off the scroll path;
   * the scroll handler it replaces read the computed `top` and two rects on
   * every scroll event, right after the hero's parallax write (a forced
   * layout per frame). The sticky `top` (safe area + nav bar) is read once
   * per observer — again on a resize (rotation changes the safe area). */
  $effect(() => {
    if (!mark || !bar) return;
    const sc = bar.closest('.screen');
    if (!sc) return;
    let io = null;
    const observe = () => {
      io?.disconnect();
      const top = parseFloat(getComputedStyle(bar).top) || 0;
      io = new IntersectionObserver(
        ([e]) => {
          /* a hidden route (display: none) reports an empty rect: keep the state */
          if (!e || !e.rootBounds || !e.boundingClientRect.width) return;
          stuck = !e.isIntersecting && e.boundingClientRect.top < e.rootBounds.top;
        },
        { root: sc, rootMargin: `-${Math.round(top)}px 0px 0px 0px` }
      );
      io.observe(mark);
    };
    observe();
    addEventListener('resize', observe);
    return () => {
      removeEventListener('resize', observe);
      io?.disconnect();
    };
  });

  /* Keep the selected pill in view (DET-05) — only when the *selection*
   * changes, not whenever the list is rebuilt (the activity poll makes a new
   * array every 4 s while a download of this show runs, which used to pull a
   * strip the user had scrolled back every poll), and only when the pill is
   * clipped, as UIKit does. The first placement is instant: a page opening on
   * Season 5 is already positioned, no slide after landing. */
  const activeKey = $derived(pills.find((p) => p.active)?.key ?? null);
  let placed = false;
  $effect(() => {
    const k = activeKey;
    untrack(() => {
      if (k == null || !el) return;
      const b = el.querySelector('.pill--active');
      if (!b) return;
      const first = !placed;
      placed = true;
      const l = b.offsetLeft;
      const r = l + b.offsetWidth;
      if (l >= el.scrollLeft && r <= el.scrollLeft + el.clientWidth) return;
      const to = Math.max(0, l - el.clientWidth / 2 + b.offsetWidth / 2);
      el.scrollTo({ left: to, behavior: first || reducedMotion() ? 'auto' : 'smooth' });
    });
  });
</script>

{#if pills.length}
  <div class="pills__mark" aria-hidden="true" bind:this={mark}></div>
  <div class="detail__pills {stuck ? 'pills--sticky' : ''}" bind:this={bar}>
    <div class="pills" role="tablist" aria-label="Seasons" bind:this={el}>
      {#each pills as p (p.key)}
        <button
          type="button"
          class="pill {p.active ? 'pill--active' : ''} {p.dim ? 'pill--dim' : ''}"
          role="tab"
          aria-selected={!!p.active}
          onclick={() => onpick?.(p.key)}
          onpointerdown={() => !p.active && onpress?.(p.key)}
          use:longpress={{ onlongpress: (d) => onlong?.(p.key, d), disabled: !onlong || p.dim }}
        >
          {#if p.watched}<span class="tick"><Icon name="check" /></span>{/if}{p.label}{#if p.pct != null}<span class="pill__pct">{p.pct}%</span>{/if}
        </button>
      {/each}
    </div>
  </div>
{/if}
