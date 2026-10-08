/* Desktop web client helpers (app 'web'). The web build (web/vite.config.js)
 * is served by the fake's web origin with /jf (Jellyfin) and /ml (reel-api)
 * on the same origin, an SPA fallback and the NAS's /net.json — the
 * production shape of vr.kirill.es — so cfg.server is origin + '/jf' and
 * nothing needs configuring. The page runs with desktop metrics (1440×900,
 * dpr 1, no touch, a hovering fine pointer, a desktop Chrome UA: lib/page.mjs
 * DESKTOP) and is driven with trusted mouse clicks and keys.
 *
 * The helpers read the app through what other work on the web UI keeps
 * stable: the URL, the active route's `data-route` / `data-key`
 * (App.svelte's one element per router route, only the active one shown),
 * landmarks and h1s, roles + aria-labels (dialogs, menus, the player's
 * `role="application"`), and real `<a href>` section links — never the
 * classes of things being restyled. */
import { sleep } from './page.mjs';

/* Signed-in (or signed-out) start: localStorage seeded on the web origin's
 * blank page (deviceId `reelweb-…`, as the web build mints them), then `path`
 * (a deep link: '/movie/<id>', '/search?q=x' …) loaded. */
export async function bootWeb(t, { signedIn = true, user = 'alice', storage = {}, path = '/' } = {}) {
  const { srv, page } = t;
  const ls = { ...storage };
  if (signedIn) {
    const deviceId = 'reelweb-e2e-' + user;
    const s = srv.issueToken(user, deviceId);
    Object.assign(ls, { 'reel.token': s.token, 'reel.userId': s.userId, 'reel.userName': s.userName, 'reel.deviceId': deviceId });
  }
  if (Object.keys(ls).length) {
    await page.goto(srv.urls.web + '/__e2e_blank');
    await page.eval((ls) => {
      for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
      return true;
    }, ls);
  }
  await page.goto(srv.urls.web + path);
  return page;
}

/* What the user sees right now: the address, the active route, its landmark
 * and h1(s), the tab title, and what sits over the page (Login, the player, a
 * dialog/popover or a menu — by role + aria-label). */
export function webState(page) {
  return page.eval(() => {
    const vis = (e) => !!e && e.checkVisibility();
    const route = [...document.querySelectorAll('[data-route][data-key]')].find(vis) || null;
    const h1s = route ? [...route.querySelectorAll('h1')].filter(vis).map((h) => h.textContent.replace(/\s+/g, ' ').trim()) : [];
    const player = document.querySelector('[role="application"][aria-label="Video player"]');
    const login = [...document.querySelectorAll('input[autocomplete="current-password"]')].some(vis);
    const dialog = [...document.querySelectorAll('[role="dialog"]')].filter(vis).map((d) => d.getAttribute('aria-label') || '').at(-1) ?? null;
    return {
      path: location.pathname,
      search: location.search,
      route: route?.dataset.route || null,
      key: route?.dataset.key || null,
      main: vis(route?.querySelector('main')),
      h1: h1s[0] || null,
      h1s,
      title: document.title,
      modal: vis(player) ? 'player' : login ? 'login' : null,
      dialog,
      menu: [...document.querySelectorAll('[role="menu"]')].some(vis)
    };
  });
}

const matches = (v, want) => want == null || (want instanceof RegExp ? want.test(v ?? '') : v === want);

/* Wait until the active route is `route` (a router route name: home movies
 * shows search chart detail person lookup pending settings mylibrary), its
 * <main> is up, it has a visible h1 (matching `h1` when given: string or
 * RegExp; Home's hero has one per slide, any of them counts; `h1: false` =
 * no h1 needed — a running search hides the page head) and the address
 * matches `path` (string or RegExp on pathname + search). → webState. */
export async function waitRoute(page, route, { h1, path, timeout = 10000 } = {}) {
  const t0 = Date.now();
  let st;
  for (;;) {
    st = await webState(page).catch(() => null);
    const okH1 = st && (h1 === false || (h1 == null ? st.h1s.length > 0 : st.h1s.some((x) => matches(x, h1))));
    if (st && st.route === route && st.main && okH1 && matches(st.path + st.search, path)) return st;
    if (Date.now() - t0 > timeout) throw new Error(`waitRoute ${route}${h1 ? ' h1 ' + h1 : ''}${path ? ' path ' + path : ''} timed out after ${timeout} ms (last: ${JSON.stringify(st)})`);
    await sleep(60);
  }
}

/* the site sections and where their links go (the header's real <a href>s) */
export const SECTIONS = { Home: '/', Movies: '/movies', Shows: '/shows', Search: '/search' };

/* Click a section link in the page header (by its href, whatever the header
 * looks like) and wait for that section's root. → webState */
export async function openSection(page, name) {
  const href = SECTIONS[name];
  if (!href) throw new Error('no section ' + name);
  await clickOn(page, `header a[href="${href}"]`, /./, { scope: 'doc', pick: (els) => els.find((a) => a.closest('nav')) || els.find((a) => a.textContent.trim()) || els[0] });
  return waitRoute(page, name === 'Home' ? 'home' : name.toLowerCase(), { path: href === '/' ? '/' : new RegExp('^' + href + '(\\?|$)') });
}

/* A trusted mouse click on the first visible element matching css whose
 * aria-label or text matches re — inside the active route (scope 'route'), an
 * open dialog (scope 'dialog') or anywhere (scope 'doc'). It is scrolled into
 * view and must hold still for two polls first. button 'right' opens a
 * context menu. → the element's { x, y, label } */
export async function clickOn(page, css, re = /./, { scope = 'route', button = 'left', count = 1, timeout = 10000, pick = null } = {}) {
  const at = await page.waitFor((css, src, scope, pickSrc) => {
    const vis = (e) => !!e && e.checkVisibility();
    let root = document;
    if (scope === 'route') root = [...document.querySelectorAll('[data-route][data-key]')].find(vis);
    if (scope === 'dialog') root = [...document.querySelectorAll('[role="dialog"]')].filter(vis).at(-1);
    if (!root) return null;
    const re = new RegExp(src);
    const label = (e) => (e.getAttribute('aria-label') || e.textContent || '').replace(/\s+/g, ' ').trim();
    const els = [...root.querySelectorAll(css)].filter((e) => vis(e) && re.test(label(e)));
    // eslint-disable-next-line no-new-func
    const el = pickSrc ? new Function('return ' + pickSrc)()(els) : els[0];
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height) return null;
    const pos = Math.round(b.left) + ',' + Math.round(b.top);
    const prev = window.__e2eClickAt;
    window.__e2eClickAt = pos;
    return pos === prev ? { x: b.left + b.width / 2, y: b.top + b.height / 2, label: label(el) } : null;
  }, { what: `clickable ${css} ${re} in ${scope}`, timeout, interval: 80 }, css, re.source, scope, pick ? String(pick) : null);
  await page.eval(() => delete window.__e2eClickAt);
  await page.click(at.x, at.y, { button, count });
  return at;
}

/* desktop keys: name → [key, code, keyCode, text] */
const DKEYS = {
  Escape: ['Escape', 'Escape', 27], Enter: ['Enter', 'Enter', 13, '\r'], Tab: ['Tab', 'Tab', 9], Space: [' ', 'Space', 32, ' '],
  ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37], ArrowUp: ['ArrowUp', 'ArrowUp', 38], ArrowRight: ['ArrowRight', 'ArrowRight', 39], ArrowDown: ['ArrowDown', 'ArrowDown', 40],
  Home: ['Home', 'Home', 36], End: ['End', 'End', 35], Backspace: ['Backspace', 'Backspace', 8], '/': ['/', 'Slash', 191, '/'], '?': ['?', 'Slash', 191, '?']
};

/* One trusted desktop key press: 'Escape' 'Enter' 'Tab' 'Space' 'ArrowLeft'
 * … 'Home' 'End' '/' '?' or a single letter/digit ('k', 'F'), with modifiers
 * { shift, ctrl, alt, meta }. Browser shortcuts (Alt+Left, F11) don't go
 * through CDP Input — use historyBack(). */
export async function webKey(page, name, { shift = false, ctrl = false, alt = false, meta = false, settle = 60 } = {}) {
  let k = DKEYS[name];
  if (!k && name.length === 1) {
    const up = name.toUpperCase();
    k = [name, /[A-Z]/.test(up) ? 'Key' + up : /\d/.test(name) ? 'Digit' + name : '', up.charCodeAt(0), name];
  }
  if (!k) throw new Error('unknown key ' + name);
  const [key, code, keyCode, text] = k;
  const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift || name === '?' ? 8 : 0);
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
  const typed = text && !ctrl && !alt && !meta;
  await page.s.send('Input.dispatchKeyEvent', { type: typed ? 'keyDown' : 'rawKeyDown', ...base, ...(typed ? { text, unmodifiedText: text } : {}) });
  await page.s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await page.frames(2);
  if (settle) await sleep(settle);
}

/* The browser's own Back / Forward (the toolbar button, Alt+←): a history
 * navigation through CDP, so popstate fires exactly as for a user. */
export async function historyGo(page, delta) {
  const { currentIndex, entries } = await page.s.send('Page.getNavigationHistory');
  const e = entries[currentIndex + delta];
  if (!e) throw new Error(`no history entry at ${delta} (index ${currentIndex} of ${entries.length})`);
  await page.s.send('Page.navigateToHistoryEntry', { entryId: e.id });
  await page.frames(2);
}
export const historyBack = (page) => historyGo(page, -1);

/* wait for an open dialog / popover (role="dialog") labelled `label` → its label */
export function dialogUp(page, label, { timeout = 8000 } = {}) {
  return page.waitFor((label) => {
    const d = [...document.querySelectorAll('[role="dialog"]')].find((x) => x.checkVisibility() && (x.getAttribute('aria-label') || '') === label);
    return d && d.getAnimations({ subtree: true }).every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity) && label;
  }, { what: 'dialog ' + label, timeout }, label);
}

/* wait until no dialog labelled `label` is visible */
export function dialogGone(page, label, { timeout = 8000 } = {}) {
  return page.waitFor((label) => ![...document.querySelectorAll('[role="dialog"]')].some((x) => x.checkVisibility() && (x.getAttribute('aria-label') || '') === label), { what: 'dialog ' + label + ' closed', timeout }, label);
}

/* the visible items of the open menu (role="menu" → role="menuitem" labels) */
export function menuItems(page) {
  return page.eval(() => {
    const m = [...document.querySelectorAll('[role="menu"]')].filter((x) => x.checkVisibility()).at(-1);
    return m ? [...m.querySelectorAll('[role="menuitem"]')].filter((x) => x.checkVisibility()).map((x) => (x.getAttribute('aria-label') || x.textContent).replace(/\s+/g, ' ').trim()) : null;
  });
}
