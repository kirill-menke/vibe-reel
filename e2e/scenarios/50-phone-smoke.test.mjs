/* Phone PWA smoke: signed-in boot on the one-origin /jf + /ml setup, Home's
 * rails from the fake, a tab switch by touch. */
import { test, assert } from '../lib/runner.mjs';
import { bootPhone, tabs, tabBarArmed } from '../lib/phone.mjs';

async function phoneRails(page) {
  return page.eval(() =>
    [...document.querySelectorAll('.rail')].filter((r) => r.checkVisibility()).map((r) => ({
      title: r.querySelector('.rail__title')?.firstChild?.textContent?.trim() || r.getAttribute('aria-label'),
      n: r.querySelectorAll('.rail__track > *').length
    }))
  );
}

test('phone: signed-in boot shows Home rails through /jf and /ml; tabs switch by touch', { app: 'phone', fast: true }, async (t) => {
  const { page, srv } = t;
  await bootPhone(t);
  await page.waitFor(() => document.querySelectorAll('.tabbar .tabbar__item').length === 4, { what: 'tab bar', timeout: 10000 });
  assert.deepEqual(await tabs(page), ['Home', 'Movies', 'Shows', 'Search'], 'tab labels');
  await page.waitFor(() => [...document.querySelectorAll('.rail__title')].some((h) => /Continue Watching/.test(h.textContent)), { what: 'Continue Watching rail', timeout: 10000 });
  const R = await phoneRails(page);
  t.log(JSON.stringify(R));
  const cw = R.find((r) => r.title === 'Continue Watching');
  assert(cw && cw.n === 3, 'Continue Watching has the 3 resumable items: ' + JSON.stringify(R));

  // every Jellyfin call went through the phone origin's /jf prefix, reel-api through /ml
  const jf = srv.requests({ origin: 'jf' });
  assert(jf.some((e) => e.path === '/UserItems/Resume'), 'Resume fetched');
  assert(srv.requests({ origin: 'ml', path: '/api/trending' }).length >= 1, 'trending fetched via /ml');
  const auth = jf.find((e) => e.path === '/UserItems/Resume');
  assert(auth.status === 200, 'Resume answered 200 (token accepted)');

  // touch: the Movies tab opens the movie library
  await tabBarArmed(page);
  const items = await page.eval(() => [...document.querySelectorAll('.tabbar .tabbar__item')].map((b) => b.textContent.trim()));
  const i = items.indexOf('Movies');
  await page.tapSel(`.tabbar .tabbar__item:nth-child(${i + 2})`); // +1 for the lens span, +1 for nth-child base
  await page.waitFor(() => document.querySelector('.tabbar__item[aria-current="page"]')?.textContent.trim() === 'Movies', { what: 'Movies tab current' });
  const grid = await page.waitFor(() => {
    const g = [...document.querySelectorAll('.lib__grid')].find((x) => x.checkVisibility());
    const n = g ? g.querySelectorAll('.tile[role="button"]').length : 0;
    return n > 20 && n;
  }, { what: 'movie grid tiles', timeout: 10000 });
  assert(grid > 20, 'movie grid rendered');
  assert(srv.requests({ origin: 'jf', path: '/Items' }).some((e) => /IncludeItemTypes=Movie/.test(e.search)), 'Movies grid queried /Items');
});

/* F-011: TabBar's click swallow (meant for the click that follows a lens drop)
 * started at 0, so every tap in the first 400 ms of the page's life was eaten.
 * A probe installed before the app's first byte clicks the Movies item the
 * moment the bar mounts (MutationObserver, as the E2E-43 measurement did); the
 * tab must switch. The mount lands anywhere from ~230 ms (warm) to well past
 * 400 ms on a slow machine, so the probe does not rely on it (R-4): for the
 * one synchronous click() it shifts performance.now() so the page's clock reads
 * ~50 ms — inside the old swallow window on every run — and puts it back
 * right after. Reverting TabBar's `-Infinity` makes this test fail. */
const TAP_AT_MOUNT = `(() => {
  const go = () => {
    const items = document.querySelectorAll('.tabbar .tabbar__item');
    if (items.length !== 4 || window.__e2eTap) return false;
    const movies = [...items].find((b) => b.textContent.trim() === 'Movies');
    const real = performance.now.bind(performance);
    const mount = real();
    const shift = Math.max(0, mount - 50);
    window.__e2eTap = { mount, before: document.querySelector('.tabbar__item[aria-current="page"]')?.textContent.trim() };
    performance.now = () => real() - shift;
    try {
      window.__e2eTap.at = performance.now();
      movies.click();
    } finally {
      delete performance.now; // back to Performance.prototype.now
    }
    return true;
  };
  new MutationObserver((_, mo) => { if (go()) mo.disconnect(); }).observe(document, { childList: true, subtree: true });
})();`;

test('phone: a tab tap the moment the tab bar mounts switches the tab (F-011)', { app: 'phone', fast: true }, async (t) => {
  const { page } = t;
  await page.s.send('Page.addScriptToEvaluateOnNewDocument', { source: TAP_AT_MOUNT });
  await bootPhone(t);
  const tap = await page.waitFor(() => window.__e2eTap, { what: 'tab bar mounted and tapped', timeout: 10000 });
  t.log(`bar mounted at ${tap.mount.toFixed(0)} ms; the tap read the clock as ${tap.at.toFixed(0)} ms (current before: ${tap.before})`);
  assert(tap.at < 400, 'the tap went out inside the first 400 ms by the page clock: ' + tap.at);
  assert.equal(await page.eval(() => typeof Object.getOwnPropertyDescriptor(performance, 'now')), 'undefined', 'performance.now restored');
  assert.equal(tap.before, 'Home', 'Home was current when the tap went out');
  await page.waitFor(() => document.querySelector('.tabbar__item[aria-current="page"]')?.textContent.trim() === 'Movies', { what: 'Movies tab current after a tap at mount', timeout: 3000 });
});
