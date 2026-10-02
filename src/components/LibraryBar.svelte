<script>
  import Icon from './Icon.svelte';
  import { LV, SORTS, viewOf, sortOf, setView, openMenu, closeMenu } from '../lib/libview.svelte.js';
  import { focusKey } from '../lib/focus.js';

  /* The Movies / Shows bar: a second glass capsule on the tab row, holding
   * Sort ▾, Genre ▾ and the Unwatched toggle. It sits on the same row as the
   * tabs on purpose — ◀▶ walks straight from "Movies" onto "Sort", and ▼ from
   * any of them drops into the grid (Keys.svelte), so the grid never gets an
   * extra row of chrome to walk through.
   *
   * A dropdown is a panel hung under its pill. While it is down, focusables()
   * scopes the D-pad to its rows (focus.js) and Back closes it (Keys.svelte);
   * OK on a row applies it and hands focus back to the pill, so a second ▼
   * goes straight into the re-sorted grid.
   *
   * `onchange` is Library.svelte's re-query; every change goes through it. */
  let { tab, genres = [], onchange } = $props();

  const v = $derived(viewOf(tab));
  const sort = $derived(sortOf(tab));
  const sorts = $derived(SORTS[tab] || SORTS.movies);

  async function toggle(which) {
    if (LV.open === which) {
      closeMenu();
      return;
    }
    openMenu(which);
    // land on the current choice, not the top of the list
    const i = which === 'genre' ? genres.indexOf(v.genre) : -2;
    await focusKey(which === 'sort' ? 'lv-s-' + v.sort : i >= 0 ? 'lv-g-' + i : 'lv-g-all');
  }

  async function pick(patch, pill) {
    closeMenu();
    setView(tab, patch);
    onchange?.();
    await focusKey(pill);
  }

  function toggleUnwatched() {
    setView(tab, { unwatched: !v.unwatched });
    onchange?.();
  }

  /* The genre list can outgrow the panel; keep the focused row in view. Plain
   * nearest-scroll is fine inside a small panel (focus.js's animator only knows
   * the page scrollers). */
  function keepInView(e) {
    e.target?.scrollIntoView?.({ block: 'nearest' });
  }
</script>

<div class="lvbar">
  <div class="lvwrap">
    <button class="lvbtn focus" class:open={LV.open === 'sort'} data-focus="lv-sort" onclick={() => toggle('sort')}>
      <Icon name="sort" /><span>{sort.label}</span><i class="chev"><Icon name="chev" /></i>
    </button>
    {#if LV.open === 'sort'}
      <div class="lvmenu" role="listbox" aria-label="Sort by">
        <div class="lvcap">Sort by</div>
        {#each sorts as s (s.id)}
          <button
            class="opt focus"
            class:sel={s.id === v.sort}
            data-focus="lv-s-{s.id}"
            onclick={() => pick({ sort: s.id }, 'lv-sort')}
          ><span>{s.label}</span>{#if s.id === v.sort}<Icon name="checkthin" />{/if}</button>
        {/each}
      </div>
    {/if}
  </div>

  <div class="lvwrap">
    <button
      class="lvbtn focus"
      class:on={!!v.genre}
      class:open={LV.open === 'genre'}
      data-focus="lv-genre"
      onclick={() => toggle('genre')}
    >
      <Icon name="genre" /><span>{v.genre || 'All genres'}</span><i class="chev"><Icon name="chev" /></i>
    </button>
    {#if LV.open === 'genre'}
      <div class="lvmenu" role="listbox" aria-label="Genre" onfocusin={keepInView}>
        <div class="lvcap">Genre</div>
        <button class="opt focus" class:sel={!v.genre} data-focus="lv-g-all" onclick={() => pick({ genre: '' }, 'lv-genre')}
          ><span>All genres</span>{#if !v.genre}<Icon name="checkthin" />{/if}</button
        >
        {#each genres as g, i (g)}
          <button class="opt focus" class:sel={g === v.genre} data-focus="lv-g-{i}" onclick={() => pick({ genre: g }, 'lv-genre')}
            ><span>{g}</span>{#if g === v.genre}<Icon name="checkthin" />{/if}</button
          >
        {/each}
      </div>
    {/if}
  </div>

  <!-- A toggle, not a menu: one press flips it. The little switch is the state;
       the whole pill also warms gold while it's on, like an active genre. -->
  <button class="lvbtn focus" class:on={v.unwatched} data-focus="lv-unseen" aria-pressed={v.unwatched} onclick={toggleUnwatched}>
    <Icon name="unseen" /><span>Unwatched</span><i class="sw"><b></b></i>
  </button>
</div>
