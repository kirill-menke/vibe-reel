/* TV-app helpers on top of Page. The app's state (S in nav.svelte.js) is not
 * reachable from outside, so everything here reads the DOM — the same live
 * DOM the D-pad engine reads (focus.js). */
import { sleep } from './page.mjs';
export { checkFocusInvariants, scopeKeys } from './invariants.mjs';

/* A signed-out cold boot: S.base starts as 'home', so Home mounts behind the
 * splash and fires its rails + the avatar before App.svelte's onMount opens
 * Login — /UserItems/Resume and /Shows/NextUp go out without a token (401)
 * and the avatar asks /UserImage?userId= (empty). Recorded as finding F-001 in
 * run/findings.md; tests that boot signed out spread this into their options
 * so the known noise doesn't mask anything else. Remove once fixed. */
export const SIGNED_OUT_BOOT = {
  allowErrors: [/status of 401 .*\/(UserItems\/Resume|Shows\/NextUp)\?/, /status of 404 .*\/UserImage\?userId=&/],
  allowViolations: [/^GET \/UserImage: query userId="" is not a uuid$/]
};

/* Open the TV build. signedIn: a token issued by the fake is put into
 * localStorage (reel.*) on the TV origin before the app's first byte runs. */
export async function bootTv(t, { signedIn = true, user = 'alice', storage = {}, skipSplash = true } = {}) {
  const { srv, page } = t;
  const ls = { ...storage };
  if (signedIn) {
    const s = srv.issueToken(user, 'reel-e2e-' + user);
    Object.assign(ls, { 'reel.server': srv.urls.jf, 'reel.token': s.token, 'reel.userId': s.userId, 'reel.userName': s.userName, 'reel.deviceId': 'reel-e2e-' + user });
  }
  if (Object.keys(ls).length) {
    await page.goto(srv.urls.tv + '/__e2e_blank');
    await page.eval((ls) => {
      for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
      return true;
    }, ls);
  }
  await page.goto(srv.urls.tv + '/index.html');
  if (skipSplash) await waitSplashGone(page);
  return page;
}

/* The splash is gone 3.7 s after its mount when Home is ready, 10.85 s at the
 * very latest (its own hard deadline, Splash.svelte HOLD_MAX + fade). The
 * timeout counts from goto()'s return (the load event, ≤ 0.3 s after
 * navigation), so 12 s covers the deadline + 1.15 s. Measured (E2E-44,
 * 26-tv-splash, 20 boots each, 12 cores): idle, and under 36 busy loops each
 * in its own session (`setsid`, load 41 — a hog in the harness's own session
 * barely touches Chrome, which is spawned detached into its own scheduler
 * autogroup), the splash is gone 3.62–3.80 s after the load event, frame gaps
 * up to 183 ms — load doesn't stretch it, it is wall-clock timed. Only a Home that is not ready (S.ready) holds it toward 10.85 s, so
 * a timeout here means "Home never got ready" (or no animation frames), not
 * "slow machine"; the error carries the page's state to say which. */
export async function waitSplashGone(page, timeout = 12000) {
  try {
    await page.waitFor(() => !document.getElementById('splash'), { timeout, what: 'splash gone' });
  } catch (e) {
    const st = await page
      .eval(async () => {
        const sc = document.querySelector('#splash .splash-scene');
        const scr = document.querySelector('.screen');
        // the splash is driven by rAF: are frames being produced at all?
        let frames = 0;
        const t0 = performance.now();
        await new Promise((r) => {
          const f = () => (++frames, performance.now() - t0 < 500 ? requestAnimationFrame(f) : r());
          requestAnimationFrame(f);
          setTimeout(r, 1500);
        });
        return {
          framesIn500ms: frames,
          splashNow: !!document.getElementById('splash'),
          pageMs: Math.round(performance.now()),
          ready: document.readyState,
          visibility: document.visibilityState,
          sceneOpacity: sc ? sc.style.opacity : null,
          screen: scr ? scr.className : null,
          rails: document.querySelectorAll('.screen .rails .rail').length,
          spinner: !!document.querySelector('.screen .vload'),
          focus: document.activeElement?.dataset?.focus || document.activeElement?.tagName
        };
      })
      .catch((x) => ({ evalFailed: x.message }));
    e.message += ' — page state ' + JSON.stringify(st);
    throw e;
  }
}

/* What has focus: its data-focus key (or a description when there is none). */
export async function focused(page) {
  return page.eval(() => {
    const a = document.activeElement;
    if (!a || a === document.body || a === document.documentElement) return '<body>';
    return a.dataset.focus || `<${a.tagName.toLowerCase()}${a.className ? '.' + String(a.className).split(' ').join('.') : ''}>`;
  });
}

export async function waitFocus(page, key, timeout = 8000) {
  const re = key instanceof RegExp ? key.source : null;
  return page.waitFor((k, re) => {
    const f = document.activeElement?.dataset?.focus;
    return re ? f && new RegExp(re).test(f) && f : f === k && f;
  }, { timeout, what: 'focus on ' + key }, key instanceof RegExp ? null : key, re);
}

/* The mounted browse screen + overlays, as far as the DOM tells. */
export async function screen(page) {
  return page.eval(() => {
    const vis = (el) => el && !el.hidden && el.checkVisibility?.();
    const scr = document.querySelector('.screen');
    return {
      screen: scr ? [...scr.classList].filter((c) => c !== 'screen').join('.') || 'screen' : null,
      search: vis(document.getElementById('search')),
      player: vis(document.getElementById('video-layer')),
      splash: !!document.getElementById('splash'),
      menu: !!document.querySelector('.lvmenu'),
      title: document.querySelector('.screen .hero .title, .screen h1, .screen .title')?.textContent?.trim().slice(0, 80) || null
    };
  });
}

/* Press a sequence of keys: 'Down Down Right Enter' or an array. */
export async function press(page, keys, opts) {
  for (const k of Array.isArray(keys) ? keys : keys.split(/\s+/).filter(Boolean)) await page.key(k, opts);
}

export { sleep };
export { holds } from './page.mjs';

/* Walk the D-pad onto the element with data-focus=`key` by geometry: one
 * arrow at a time toward the target's centre (vertical first while the rows
 * differ). For grids and the Search keyboard, where the crawler's graph would
 * be overkill. Throws when it doesn't get there in `max` presses. */
export async function steer(page, key, { max = 30, settle = 80 } = {}) {
  for (let i = 0; i <= max; i++) {
    const d = await page.eval((key) => {
      // the target inside the active scope: Search's result keys (lk-<type>-<id>) also
      // exist on the screen behind the overlay (Home's Trending rails)
      const sr = document.getElementById('search');
      const root = sr?.classList.contains('on') ? sr : document;
      const a = document.activeElement, t = root.querySelector(`[data-focus="${CSS.escape(key)}"]`);
      if (!t) return { missing: true };
      if (a === t) return { done: true };
      if (!a || a === document.body) return { body: true };
      const ra = a.getBoundingClientRect(), rt = t.getBoundingClientRect();
      const dy = rt.top + rt.height / 2 - (ra.top + ra.height / 2), dx = rt.left + rt.width / 2 - (ra.left + ra.width / 2);
      const sameRow = Math.abs(dy) < Math.min(ra.height, rt.height) / 2;
      return { dir: !sameRow ? (dy > 0 ? 'Down' : 'Up') : dx > 0 ? 'Right' : 'Left' };
    }, key);
    if (d.done) return true;
    if (d.missing) throw new Error('steer: no element with data-focus=' + key);
    if (d.body) throw new Error('steer: focus on <body> on the way to ' + key);
    if (i === max) break;
    await page.key(d.dir, { settle });
  }
  throw new Error(`steer: didn't reach ${key} in ${max} presses (focus on ${await focused(page)})`);
}

/* Type on Search's own keyboard with the D-pad: steer to each key, OK. */
export async function kbType(page, text) {
  for (const c of text) {
    await steer(page, c === ' ' ? 'kb-space' : 'kb-' + c);
    await page.key('OK', { settle: 40 });
  }
}

/* Boot, open the `tab` tab (movies | shows), steer onto the grid tile `key`
 * (a PendingTile: 'pend-movie:<id>' / 'pend-tv:<id>') and OK into its
 * PendingDetail (waits for the greyed status badge). */
export async function openPendingTile(t, tab, key) {
  const { page } = t;
  await bootTv(t);
  await waitFocus(page, 'tab-home');
  for (let i = 0; i < 4 && (await focused(page)) !== 'tab-' + tab; i++) await page.key('Right', { settle: 120 });
  if ((await focused(page)) !== 'tab-' + tab) throw new Error(`openPendingTile: tab-${tab} not reached (focus on ${await focused(page)})`);
  await page.key('OK', { settle: 300 });
  await page.waitFor((k) => document.querySelector(`.screen .grid [data-focus="${k}"]`), { what: key + ' in the grid', timeout: 10000 }, key);
  await steer(page, key, { settle: 200 });
  await page.key('OK', { settle: 400 });
  await page.waitFor(() => document.querySelector('.screen .hero .btn.stat'), { what: 'PendingDetail', timeout: 10000 });
}
