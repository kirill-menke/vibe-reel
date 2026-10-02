<script>
  /* TabBar — the floating glass capsule: Home · Movies · Shows · Search.
   * Tap another tab = switch (its stack as left); the active tab = pop to root;
   * again at root = scroll to top (router.switchTab). Mounted by App.svelte,
   * which shows it only while the active tab is at its root (a pushed page
   * covers it).
   * One selection lens glides to the active item (NAV-05) with a slight
   * horizontal stretch on the way; the content switch itself stays instant,
   * as UITabBarController's.
   * Drag (NAV-17, the iOS 26 bar): a horizontal drag that starts anywhere on
   * the bar lifts the lens under the finger; it follows the finger, lights the
   * item it is over, and on release snaps there and switches to that tab.
   * Dropped back on the active tab it only settles (no pop to root). */
  import Icon from './Icon.svelte';
  import { R, switchTab } from '../lib/router.svelte.js';
  import { DUR, EASE, reducedMotion } from '../lib/safe.js';
  const ITEMS = [
    { tab: 'home', label: 'Home', icon: 'home' },
    { tab: 'movies', label: 'Movies', icon: 'movies' },
    { tab: 'shows', label: 'Shows', icon: 'shows' },
    { tab: 'search', label: 'Search', icon: 'search' }
  ];
  const idx = $derived(Math.max(0, ITEMS.findIndex((it) => it.tab === R.tab)));

  let nav = $state(null);
  let lens = $state(null);
  let over = $state(-1); // item under the dragged lens, -1 when not dragging
  let catching = $state(false); // the lens is gliding to the finger at drag start
  const lit = $derived(over >= 0 ? over : idx);

  let was = -1;
  let dropped = false; // the index change came from a drop: no stretch on top of the snap
  $effect(() => {
    const i = idx;
    // `scale` composes with the CSS transform's glide (no fight over transform)
    if (was >= 0 && i !== was && lens && !dropped && !reducedMotion())
      lens.animate([{ scale: '1 1' }, { scale: '1.12 1', offset: 0.4 }, { scale: '1 1' }], { duration: DUR.springQuick, easing: EASE.out });
    dropped = false;
    was = i;
  });

  /* ------------------------------------------------------------- drag ---- */
  const SLOP = 8; // px before a touch on the bar becomes a drag (press.js uses the same)
  const RUBBER = 0.25; // past either end the lens follows at a quarter, max 14 px
  let g = null; // { id, x, y, pad, w, step, max, left, drag }
  let swallow = 0; // timestamp: the click that follows a drop is not a tap

  function down(e) {
    if (g || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const items = nav.querySelectorAll('.tabbar__item');
    if (items.length < 2) return;
    const pad = items[0].offsetLeft;
    const step = items[1].offsetLeft - pad;
    g = { id: e.pointerId, x: e.clientX, y: e.clientY, pad, step, w: items[0].offsetWidth, max: step * (ITEMS.length - 1), left: nav.getBoundingClientRect().left, drag: false };
  }

  function lensX(clientX) {
    const x = clientX - g.left - g.pad - g.w / 2;
    if (x < 0) return Math.max(-14, x * RUBBER);
    if (x > g.max) return Math.min(g.max + 14, g.max + (x - g.max) * RUBBER);
    return x;
  }

  function move(e) {
    if (!g || e.pointerId !== g.id) return;
    if (!g.drag) {
      const dx = e.clientX - g.x;
      if (Math.abs(dx) < SLOP || Math.abs(dx) < Math.abs(e.clientY - g.y)) return;
      g.drag = true;
      try {
        nav.setPointerCapture(g.id);
      } catch {}
      // started away from the selection: the lens glides over instead of jumping
      const x0 = lensX(e.clientX);
      if (Math.abs(x0 - idx * g.step) > g.step / 2 && !reducedMotion()) {
        catching = true;
        setTimeout(() => (catching = false), DUR.fast);
      }
    }
    const x = lensX(e.clientX);
    lens.style.transform = `translateX(${x.toFixed(1)}px)`;
    over = Math.max(0, Math.min(ITEMS.length - 1, Math.round(x / g.step)));
  }

  function end(e, commit) {
    if (!g || e.pointerId !== g.id) return;
    const drag = g.drag;
    g = null;
    if (!drag) return;
    const to = over;
    over = -1;
    catching = false;
    swallow = performance.now();
    // the CSS glide takes the lens from the finger to its slot (--i)
    lens.style.transform = '';
    if (commit && to >= 0 && to !== idx) {
      dropped = true;
      switchTab(ITEMS[to].tab);
    }
  }

  function click(e) {
    if (performance.now() - swallow < 400) {
      e.stopPropagation();
      e.preventDefault();
    }
    swallow = 0;
  }
</script>

<div class="tabbar-fade"></div>
<nav
  class="tabbar {over >= 0 ? 'tabbar--drag' : ''} {catching ? 'tabbar--catch' : ''}"
  aria-label="Tabs"
  bind:this={nav}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={(e) => end(e, true)}
  onpointercancel={(e) => end(e, false)}
  onclickcapture={click}
>
  <span class="tabbar__lens" style="--i: {idx}" bind:this={lens} aria-hidden="true"></span>
  {#each ITEMS as it, i (it.tab)}
    <button
      type="button"
      class="tabbar__item {lit === i ? 'tabbar__item--active' : ''}"
      aria-current={R.tab === it.tab ? 'page' : undefined}
      onclick={() => switchTab(it.tab)}><Icon name={it.icon} /><span>{it.label}</span></button
    >
  {/each}
</nav>
