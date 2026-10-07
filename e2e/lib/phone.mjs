/* Phone-app helpers. The PWA is served by the fake's phone origin with
 * /jf (Jellyfin) and /ml (reel-api) on the same origin, like production, so
 * cfg.server defaults to origin + '/jf' — nothing to configure. The page runs
 * with iPhone metrics, touch and an iOS Safari user agent (lib/page.mjs). */
export async function bootPhone(t, { signedIn = true, user = 'alice', storage = {} } = {}) {
  const { srv, page } = t;
  const ls = { ...storage };
  if (signedIn) {
    const s = srv.issueToken(user, 'reelphone-e2e-' + user);
    Object.assign(ls, { 'reel.token': s.token, 'reel.userId': s.userId, 'reel.userName': s.userName, 'reel.deviceId': 'reelphone-e2e-' + user });
  }
  if (Object.keys(ls).length) {
    await page.goto(srv.urls.phone + '/__e2e_blank');
    await page.eval((ls) => {
      for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
      return true;
    }, ls);
  }
  await page.goto(srv.urls.phone + '/');
  return page;
}

/* labels of the tab bar items, in order */
export async function tabs(page) {
  return page.eval(() => [...document.querySelectorAll('.tabbar .tabbar__item')].map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim()));
}

/* the top route of the active tab stack: its data-key */
export async function topRoute(page) {
  return page.eval(() => {
    const r = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility());
    return r.length ? r[r.length - 1].dataset.key : null;
  });
}

/* ---- shared by the phone scenarios ------------------------------------ */

/* The tab bar is there with its 4 items. (It used to also wait until the
 * document was ≥ 400 ms old: TabBar's click swallow started at 0 and ate every
 * tap in the page's first 400 ms — finding F-011, fixed; 50-phone-smoke taps
 * at mount to keep it that way.) */
export async function tabBarArmed(page) {
  await page.waitFor(() => document.querySelectorAll('.tabbar .tabbar__item').length === 4, { what: 'tab bar', timeout: 10000 });
}

/* tap a tab bar item by its label and wait until it is current */
export async function openTab(page, name) {
  await tabBarArmed(page);
  const i = await page.eval(() => [...document.querySelectorAll('.tabbar .tabbar__item')].map((b) => b.textContent.trim()));
  await page.tapSel(`.tabbar .tabbar__item:nth-child(${i.indexOf(name) + 2})`);
  await page.waitFor((name) => document.querySelector('.tabbar__item[aria-current="page"]')?.textContent.trim() === name, { what: name + ' tab current' }, name);
}

/* the top route once settled (no zoom overlay, no finite animation running in it)
 * and holding a match of css → its data-key */
export const topHas = (page, css, { timeout = 10000 } = {}) => page.waitFor((css) => {
  const r = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility());
  const top = r[r.length - 1];
  if (!top || document.querySelector('.zoom-art')) return null;
  if (top.getAnimations({ subtree: true }).some((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity)) return null;
  return top.querySelector(css) ? top.dataset.key : null;
}, { what: 'top route with ' + css, timeout }, css);

/* tap the first visible element matching css whose aria-label / text matches re,
 * inside the top route (scope 'route') or anywhere in the document (scope 'doc') */
export async function tapIn(page, css, re, { scope = 'route', timeout = 10000 } = {}) {
  const p = await page.waitFor((css, src, scope) => {
    let root = document;
    if (scope === 'route') {
      const r = [...document.querySelectorAll('.route')].filter((e) => e.checkVisibility());
      root = r[r.length - 1];
    }
    const el = root && [...root.querySelectorAll(css)].find((b) => b.checkVisibility() && new RegExp(src).test((b.getAttribute('aria-label') || b.textContent).trim()));
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const b = el.getBoundingClientRect();
    return b.width ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
  }, { what: `${css} ${re}`, timeout }, css, re.source, scope);
  await page.tap(p.x, p.y);
}

/* the open sheet (.sheethost .sheet) with this title, its present animation done */
export const sheetUp = (page, title) => page.waitFor((title) => {
  const s = document.querySelector('.sheethost .sheet');
  return s && s.querySelector('.sheet__title')?.textContent.trim() === title && s.getAnimations().every((a) => a.playState !== 'running');
}, { what: title + ' sheet settled' }, title);

/* Real page visibility: headless Chrome minimises the page's window
 * (Browser.setWindowBounds) → document.visibilityState 'hidden' and a genuine
 * visibilitychange, and 'normal' brings it back (measured, Chrome 154). */
export async function setHidden(page, hidden) {
  const { windowId } = await page.cdp.send('Browser.getWindowForTarget', { targetId: page.opts.targetId });
  await page.cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: hidden ? 'minimized' : 'normal' } });
  await page.waitFor((h) => document.visibilityState === (h ? 'hidden' : 'visible'), { what: 'visibilityState ' + (hidden ? 'hidden' : 'visible'), timeout: 5000 }, hidden);
}
