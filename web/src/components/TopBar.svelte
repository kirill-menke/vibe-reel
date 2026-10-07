<script>
  /* Web variant of phone/src/components/TopBar.svelte (swapped in by
   * web/vite.config.js; same props). On the desktop the bell and the avatar
   * live in the top navigation (WebNav), so a tab root's bar is only its large
   * title — and the Home overlay bar (no title) is nothing at all. */
  /** @type {{ title?: string, overlay?: boolean, solid?: boolean, class?: string, actions?: VR.Snip }} */
  let { title = '', overlay = false, class: cls = '', actions } = $props();
</script>

{#if title || actions}
  <header class="topbar wtopbar {title ? 'topbar--large' : ''} {overlay ? 'topbar--overlay' : ''} {cls}">
    {#if title}<h1 class="topbar__title">{title}</h1>{/if}
    {#if actions}<div class="topbar__actions">{@render actions()}</div>{/if}
  </header>
{/if}
