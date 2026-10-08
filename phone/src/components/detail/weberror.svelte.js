/* Web build only — called from `__PHONE__ && __WEB__` branches of the title
 * pages, so the phone bundle drops it (nothing here runs at import).
 *
 * pageError(screen, { title, error, retry }) puts the app's one "didn't load"
 * card (LoadError, full page) over a page whose shared phone markup has no
 * place for that failure: the page's own content is hidden while it shows
 * (`.wpage--error`, pages.css), and Retry runs `retry` — which must return its
 * promise and reject while the load still fails (LoadError's contract).
 * Returns { update(error), close() }; close() unmounts the card and shows the
 * page again.
 *
 * visibleScreen(sel) — the shown `.screen` that contains `sel`. The desktop
 * shell keeps every route of every tab mounted (hidden ones display: none), and
 * a shared screen has no handle on its own root element. */
import { mount, unmount } from 'svelte';
import LoadError from '../LoadError.svelte';

/** @param {string} sel @returns {HTMLElement | null} */
export function visibleScreen(sel) {
  for (const s of document.querySelectorAll('.screen')) {
    const el = /** @type {HTMLElement} */ (s);
    if (el.querySelector(sel) && el.getClientRects().length) return el;
  }
  return null;
}

/** @typedef {{ update: (error: unknown) => void, close: () => void }} PageError */

/** @param {HTMLElement} screen
 * @param {{ title: string, error: unknown, retry: () => Promise<unknown> }} o
 * @returns {Promise<PageError>} */
export async function pageError(screen, { title, error, retry }) {
  const host = document.createElement('div');
  host.className = 'wpage__err';
  screen.append(host);
  screen.classList.add('wpage--error');
  const props = $state({ title, error, retry });
  /** @type {Record<string, any> | null} */
  let comp = mount(LoadError, { target: host, props });
  return {
    update(e) {
      props.error = e;
    },
    close() {
      if (!comp) return;
      unmount(comp);
      comp = null;
      host.remove();
      screen.classList.remove('wpage--error');
    }
  };
}
