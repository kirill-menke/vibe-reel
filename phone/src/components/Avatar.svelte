<script module>
  /* URLs that 404'd this session (no profile picture): every tab root's TopBar
   * has an avatar, and each used to ask again. */
  const dead = $state({});
</script>

<script>
  /* Avatar — `.avatar` circle: the Jellyfin profile picture, else the initial
   * on a per-account colour.
   *   account  { server, userId, userName } (a remembered account or cfg)
   *   size     '' (36) | 'sm' (32) | 'lg' (64)
   *   photo    false → initial only */
  import { avatarUrl, initial } from '$lib/account.svelte.js';
  let { account, size = '', photo = true, class: cls = '' } = $props();

  const COLORS = ['#e6b450', '#8fb8c9', '#b8b0a0', '#c9a08f', '#a3c98f', '#b59fd0'];
  function colorOf(id) {
    let h = 0;
    for (const c of String(id || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return COLORS[h % COLORS.length];
  }
  const url = $derived(photo && account?.userId ? avatarUrl(account, size === 'lg' ? 192 : 108) : '');
</script>

<span class="avatar {size ? 'avatar--' + size : ''} {cls}" style="--av: {colorOf(account?.userId)}; overflow: hidden; position: relative">
  {initial(account || {})}
  {#if url && !dead[url]}
    <img src={url} alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" onerror={() => (dead[url] = true)} />
  {/if}
</span>
