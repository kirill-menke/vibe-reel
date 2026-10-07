<script>
  /* OfflineBanner — glass card above the tab bar while the server can't be
   * reached (conn.offline). Retry re-checks. Mounted once by App.svelte. */
  import Icon from './Icon.svelte';
  import { conn, checkServer } from '../lib/conn.svelte.js';
  import { OFF } from '../lib/offline.svelte.js';
  import { R, push, top } from '../lib/router.svelte.js';
  import { cfg } from '$lib/config.js';
  import { homeSnap } from '../lib/homesnap.svelte.js';
  // downloads play without the server: offer them right here (this account's — the list shows only those)
  const saved = $derived(OFF.list.some((e) => e.state === 'done' && e.user === cfg.userId));
  /** @type {{ raised?: boolean }} */
  let { raised = true } = $props();
</script>

{#if conn.offline}
  <div class="banner {raised ? '' : 'banner--low'}" role="status">
    <span class="banner__icon"><Icon name="cloud-off" /></span>
    <span class="banner__text"><span class="banner__title">Not connected to your server</span>Is Tailscale on?{homeSnap.shown ? ' Showing what was loaded last.' : saved ? ' Your downloads still play.' : ''}</span>
    {#if saved && top()?.name !== 'downloads'}<button class="btn btn--text dl__go" type="button" onclick={() => push('downloads')}><span>Downloads</span></button>{/if}
    <button class="btn btn--text" type="button" disabled={conn.checking || undefined} onclick={() => checkServer()}><span>{conn.checking ? 'Checking…' : 'Retry'}</span></button>
  </div>
{/if}
