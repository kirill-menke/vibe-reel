<script>
  /* CastRail — "Cast & Crew": round photos, name, role → Person page.
   *   people  Jellyfin People (actors first; directors/writers after) */
  import Rail from '../Rail.svelte';
  import Art from '../Art.svelte';
  import { personImg } from '$lib/api.js';
  import { openPerson } from '$lib/nav.svelte.js';
  import { initials } from './detail.js';
  let { people = [], title = 'Cast & Crew' } = $props();
</script>

{#if people.length}
  <Rail {title} class="rail--cast">
    {#each people as p, i (p.Id + '-' + i)}
      <button type="button" class="cast" onclick={() => openPerson(p.Id, p.Name)}>
        <span class="cast__photo"><span class="cast__initials">{initials(p.Name)}</span><Art src={personImg(p)} /></span>
        <span class="cast__name">{p.Name}</span>
        <span class="cast__role">{p.Role || (p.Type !== 'Actor' ? p.Type : '')}</span>
      </button>
    {/each}
  </Rail>
{/if}
