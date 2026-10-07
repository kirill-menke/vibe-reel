/* Cloudflare Access guard. Away from home the site sits behind Cloudflare
 * Access; when its session cookie expires, every same-origin API request is
 * answered with a redirect to the Access login on another origin. fetch() then
 * fails at the network level (the cross-origin hop has no CORS) — the app
 * would just show "can't reach the server" forever, because the page itself is
 * still loaded.
 *
 * So: when a /jf or /ml fetch fails at the network level while the browser
 * thinks it is online, ask /net.json with `redirect: 'manual'`. An opaque
 * redirect (or an HTML login page instead of the JSON) means Access wants a
 * fresh login: reload the top-level page, which Access can redirect through
 * its login and back. At most one such reload a minute (sessionStorage), so a
 * misconfigured proxy can't put the tab in a reload loop. A plain 404 (a dev
 * server, or no /net.json) or a real network error changes nothing. */

const API = /^\/(jf|ml)(\/|$)/;
const RELOAD_KEY = 'reel.web.accessReload';
const RELOAD_GAP = 60000;

/** @param {RequestInfo | URL} input @returns {boolean} */
function isApi(input) {
  try {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    return u.origin === location.origin && API.test(u.pathname);
  } catch {
    return false;
  }
}

/** @param {typeof fetch} raw @returns {Promise<boolean>} Access wants a login */
async function accessExpired(raw) {
  try {
    const r = await raw('/net.json', { redirect: 'manual', cache: 'no-store', credentials: 'same-origin' });
    if (r.type === 'opaqueredirect' || r.status === 0) return true;
    return r.ok && /text\/html/i.test(r.headers.get('content-type') || '');
  } catch {
    return false; // the network itself is down: nothing a reload fixes
  }
}

function reloadOnce() {
  let last = 0;
  try {
    last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0;
  } catch {}
  if (Date.now() - last < RELOAD_GAP) return;
  try {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {}
  location.reload();
}

let probing = false;
/** @param {typeof fetch} raw */
async function probe(raw) {
  if (probing) return;
  probing = true;
  try {
    if (await accessExpired(raw)) reloadOnce();
  } finally {
    probing = false;
  }
}

/* Wrap window.fetch once, before anything fetches (main.js). Requests and
 * answers pass through unchanged; only a network-level failure or an opaque
 * redirect of a same-origin API call starts the probe. */
export function installAccessGuard() {
  const raw = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    try {
      const r = await raw(input, init);
      if (r.type === 'opaqueredirect' && isApi(input)) probe(raw);
      return r;
    } catch (e) {
      const aborted = /** @type {Error} */ (e)?.name === 'AbortError' || init?.signal?.aborted;
      if (!aborted && navigator.onLine && isApi(input)) probe(raw);
      throw e;
    }
  };
}
