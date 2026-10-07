<script>
  /* "Download to this iPhone" — quality choice with the size each one takes
   * and the room left (navigator.storage.estimate()). params: { item } (a
   * Jellyfin movie or episode with MediaSources). Starts the download through
   * lib/offline.svelte.js. Qualities are the Settings streaming caps: Original
   * copies the file as it streams; 8 / 4 Mbit/s are re-encoded by the server
   * (H.264; 4 Mbit/s also stereo AAC) and much smaller. */
  import { onMount, untrack } from 'svelte';
  import Sheet from '../components/Sheet.svelte';
  import List from '../components/List.svelte';
  import Row from '../components/Row.svelte';
  import { closeSheet } from '../lib/router.svelte.js';
  import { OFF, OFFLINE_QUALITIES, estimateBytes, freeBytes, refreshStorage, queueDownload } from '../lib/offline.svelte.js';
  import { getQualityCap } from '$lib/player.svelte.js';
  import { humanBytes } from '$lib/activity.svelte.js';
  import { api, itemPath } from '$lib/api.js';

  let { params = {} } = $props();
  let item = $state(untrack(() => params.item));

  let quality = $state(getQualityCap());
  onMount(() => {
    refreshStorage();
    // an episode row's item has no MediaSources (the size estimate needs them)
    if (item && !item.MediaSources) {
      api(itemPath(item.Id))
        .then((x) => (item = x))
        .catch(() => {});
    }
  });

  const free = $derived(freeBytes());
  const opts = $derived(
    OFFLINE_QUALITIES.map((q) => {
      const b = estimateBytes(item, q);
      return {
        q,
        label: q === 'original' ? 'Original' : Math.round(q / 1e6) + ' Mbit/s',
        sub: q === 'original' ? 'As it streams — best picture and sound' : q === 8000000 ? 'Up to 1080p, re-encoded on the server' : 'Up to 720p, stereo — smallest',
        bytes: b,
        tooBig: free != null && b > free * 0.9
      };
    })
  );
  const sel = $derived(opts.find((o) => o.q === quality) || opts[0]);
  const title = $derived(item ? (item.Type === 'Episode' ? (item.SeriesName ? item.SeriesName + ' · ' : '') + 'S' + item.ParentIndexNumber + 'E' + item.IndexNumber : item.Name) : '');
  const footText = $derived(
    (free != null ? humanBytes(free) + ' free for downloads on this iPhone. ' : '') +
      'Keep VibeReel open while it downloads — iOS pauses it in the background, and it picks up where it left off.' +
      (OFF.persisted === false ? ' iOS may clear downloads when the iPhone runs low on space.' : '')
  );

  function go() {
    if (!sel || sel.tooBig) return;
    queueDownload(item, sel.q);
    closeSheet();
  }
</script>

<Sheet title="Download">
  <p class="offsheet__title">{title}</p>
  <List label="Quality" foot={footText}>
    {#each opts as o (o.q)}
      <Row
        title={o.label}
        sub={o.sub}
        value={o.bytes ? '~' + humanBytes(o.bytes) : ''}
        check={o.q === quality}
        selected={o.q === quality}
        danger={o.tooBig}
        onclick={() => (quality = o.q)}
      />
    {/each}
  </List>
  {#snippet foot()}
    <button class="btn btn--primary btn--block" type="button" disabled={!sel || sel.tooBig || undefined} onclick={go}>
      <span>{sel && sel.tooBig ? 'Not enough space' : 'Download' + (sel && sel.bytes ? ' · ' + humanBytes(sel.bytes) : '')}</span>
    </button>
  {/snippet}
</Sheet>
