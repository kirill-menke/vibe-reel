import { mount } from 'svelte';
import { installAccessGuard } from './lib/access.js';
import '$p/styles/tokens.css';
import '$p/styles/components.css';
import '$p/styles/app.css';
import '$p/styles/home.css';
import '$p/styles/library.css';
import '$p/styles/detail.css';
import '$p/styles/player.css';
import '$p/styles/mylibrary.css';
import '$p/styles/zoom.css';
import './web.css';
// one stylesheet per owner, in cascade order (generic look first)
import './styles/look.css';
import './styles/shell.css';
import './styles/ctx.css';
import './styles/home.css';
import './styles/pages.css';
import './styles/browse.css';
import './styles/player.css';
import App from './App.svelte';
import { initLifecycle } from './lib/lifecycle.js';
import { initUrl } from './lib/urlsync.svelte.js';
import { initQualityDefault } from './lib/net.js';
import { initSearchUrl } from './lib/searchurl.js';
import { initHeroArrows } from './lib/heroarrows.js';
import { initTileTips } from './lib/tiletips.js';
import { initPagesA11y } from './lib/pagesa11y.js';

/* Cloudflare Access: an expired session turns API calls into network errors
 * — wrap fetch first, before anything can fetch (lib/access.js). */
installAccessGuard();

/* Dev only: /?devlogin signs in with the account the dev server serves from
 * the gitignored phone/.devcreds.json (web/dev/plugin.js) and reloads.
 * Tree-shaken from builds. */
if (import.meta.env.DEV && new URLSearchParams(location.search).has('devlogin')) {
  const { devLogin } = await import('$p/lib/devlogin.js');
  await devLogin();
}

initLifecycle();
initUrl(); // the stacks from the URL / history.state, before the first mount
initQualityDefault(); // 8 Mbit/s through the tunnel, Original at home (unless picked)
initSearchUrl(); // /search?q=…
initHeroArrows(); // ◀ ▶ and ←/→ for Home's hero carousel
initTileTips(); // the whole title of a cut-off tile caption on hover
initPagesA11y(); // title pages: download state as a progressbar, initials out of names

export default mount(App, { target: /** @type {HTMLElement} */ (document.getElementById('app')) });
