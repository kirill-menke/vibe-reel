/* Self-test of the network guard: a page request to anything but the fake's
 * loopback ports is blocked before it leaves the browser, and the TV's
 * hard-coded picture service (127.0.0.1:8791) lands on the fake one.
 * Only TEST-NET / .invalid addresses are used, which route nowhere. */
import { test, assert } from '../lib/runner.mjs';

test('guard: non-fixture hosts are blocked, the picture service is redirected', { fast: true, allowErrors: [/ERR_BLOCKED_BY_CLIENT|Failed to load resource/] }, async (t) => {
  const { page, srv } = t;
  await page.goto(srv.urls.tv + '/__e2e_blank');
  const r = await page.eval(async () => {
    const out = {};
    for (const u of ['http://192.0.2.1/x', 'https://example.invalid/y', 'http://127.0.0.1:9/z']) {
      try {
        await fetch(u, { mode: 'no-cors' });
        out[u] = 'loaded';
      } catch (e) {
        out[u] = 'blocked:' + e.name;
      }
    }
    out.pic = await fetch('http://127.0.0.1:8791/modes').then((r) => r.json()).catch((e) => 'error:' + e);
    return out;
  });
  for (const u of ['http://192.0.2.1/x', 'https://example.invalid/y', 'http://127.0.0.1:9/z']) assert.match(r[u], /^blocked:/, u);
  const blocked = t.expectBlocked(/192\.0\.2\.1|example\.invalid|127\.0\.0\.1:9\//);
  assert.equal(blocked.length, 3, 'guard recorded the three blocked requests');
  assert.equal(r.pic.current, 'filmMaker', 'picture service answered by the fake: ' + JSON.stringify(r.pic));
  assert(srv.requests({ origin: 'pic', path: '/modes' }).length === 1, 'fake picture service saw /modes');
});

/* Self-test of the runner: each way a page can go wrong fails a test on its
 * own. Four synthetic inner tests (plus a clean control) run through the real
 * runAll via t.runInner(); each must come back FAIL for exactly its reason.
 *
 * Worker coverage (measured): a dedicated Worker's requests go through its
 * owning frame, so the PAGE session's Fetch interception blocks them; the
 * phone's service worker is its own auto-attached target with its own Fetch
 * interception (chrome.mjs), which blocks its requests (recorded with target
 * type 'service_worker'). Neither reaches the proxy sink (asserted below);
 * the sink stays the second layer for anything that attaches too late. */
import { innerTest } from '../lib/runner.mjs';

const FOREIGN = 'http://192.0.2.1/'; // TEST-NET-1: routes nowhere
const BLOCK_NOISE = [/ERR_BLOCKED_BY_CLIENT|Failed to load resource/];

/* Six inner tests, each with its own context (one boots the phone app and waits for its
 * service worker): ~10 s alone, but in the full run it starts while the other workers boot
 * Chrome and once ran past the old 30 s budget (2026-10-03, 90 tests) — the runner's
 * default 60 s budget applies. Only the time budget changed; every assertion stands. */
test('runner: a page exception, an unhandled rejection, console.error and worker/SW requests to a foreign host each fail a test', { app: 'none', browser: true, fast: true, timeout: 60000 }, async (t) => {
  const { srv, browser } = t;
  assert(browser, 'browser is up');
  const sinkBefore = browser.guard.proxyHits.length;
  const blank = () => srv.urls.tv + '/__e2e_blank';
  const settle = (page) => page.eval(() => new Promise((r) => setTimeout(() => r(true), 300)));

  const inner = [
    innerTest('inner: clean page (control)', {}, async ({ page }) => {
      await page.goto(blank());
      await settle(page);
    }),
    innerTest('inner: uncaught exception', {}, async ({ page }) => {
      await page.goto(blank());
      await page.eval(() => (setTimeout(() => { throw new Error('e2e-boom-exception'); }, 0), true));
      await settle(page);
    }),
    innerTest('inner: unhandled rejection', {}, async ({ page }) => {
      await page.goto(blank());
      await page.eval(() => (setTimeout(() => { Promise.reject(new Error('e2e-boom-rejection')); }, 0), true));
      await settle(page);
    }),
    innerTest('inner: console.error', {}, async ({ page }) => {
      await page.goto(blank());
      await page.eval(() => (console.error('e2e-boom-console'), true));
      await settle(page);
    }),
    innerTest('inner: dedicated worker throws', {}, async ({ page }) => {
      await page.goto(blank());
      const r = await page.eval(() => new Promise((res) => {
        const src = `postMessage('up'); setTimeout(() => { console.error('e2e-boom-worker-console'); throw new Error('e2e-boom-worker'); }, 50)`;
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        w.onerror = () => res('thrown');
        setTimeout(() => res('timeout'), 5000);
      }));
      assert.equal(r, 'thrown', 'the worker threw');
      await settle(page);
    }),
    innerTest('inner: dedicated worker fetches a foreign host', { allowErrors: BLOCK_NOISE }, async ({ page }) => {
      await page.goto(blank());
      const r = await page.eval((u) => new Promise((res) => {
        const src = `fetch(${JSON.stringify(u + 'worker')}, { mode: 'no-cors' }).then(() => postMessage('loaded'), (e) => postMessage('blocked:' + e.name))`;
        const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        w.onmessage = (e) => res(e.data);
        setTimeout(() => res('timeout'), 5000);
      }), FOREIGN);
      assert.match(r, /^blocked:/, 'worker fetch did not get through');
    }),
    innerTest('inner: phone service worker fetches a foreign host', { app: 'phone', allowErrors: BLOCK_NOISE }, async ({ page, srv }) => {
      await page.goto(srv.urls.phone + '/');
      await page.waitFor(() => navigator.serviceWorker?.controller || navigator.serviceWorker?.ready.then((r) => !!r.active), { what: 'phone service worker active', timeout: 10000 });
      const phone = new URL(srv.urls.phone).origin;
      const sw = await page.waitFor(() => true, {}).then(async () => {
        for (let i = 0; i < 100; i++) {
          // the newest one: an earlier test's worker on the same origin may still be listed
          const hit = [...browser.targets.entries()].reverse().find(([, v]) => v.type === 'service_worker' && v.url.startsWith(phone));
          if (hit) return hit[0];
          await new Promise((r) => setTimeout(r, 50));
        }
        return null;
      });
      assert(sw, 'the phone service worker is an attached target: ' + JSON.stringify([...browser.targets.values()].map((v) => v.type + ' ' + v.url)));
      const r = await browser.cdp.send('Runtime.evaluate', {
        expression: `fetch(${JSON.stringify(FOREIGN + 'sw')}, { mode: 'no-cors' }).then(() => 'loaded', (e) => 'blocked:' + e.name)`,
        awaitPromise: true, returnByValue: true
      }, sw);
      assert.match(r.result?.value, /^blocked:/, 'service worker fetch did not get through');
    })
  ];

  const res = await t.runInner(inner);
  const by = Object.fromEntries(res.map((r) => [r.name.replace(/^inner: /, ''), r]));
  for (const r of res) t.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}: ${r.failures.join(' / ').slice(0, 300)}`);
  const only = (name, re) => {
    const r = by[name];
    assert(r, 'inner result for ' + name);
    assert(!r.ok, `${name}: expected FAIL, got PASS`);
    assert(r.failures.every((f) => re.test(f)), `${name}: every failure is the expected reason ${re}: ${JSON.stringify(r.failures)}`);
  };
  assert(by['clean page (control)']?.ok, 'control passes: ' + JSON.stringify(by['clean page (control)']?.failures));
  only('uncaught exception', /^page exception: .*e2e-boom-exception/);
  only('unhandled rejection', /^page exception: .*(Uncaught \(in promise\)|e2e-boom-rejection)/);
  assert(by['unhandled rejection'].failures.some((f) => /e2e-boom-rejection/.test(f)), 'rejection reason named');
  only('console.error', /^page console\.error: e2e-boom-console$/);
  // errors inside a worker are the page's errors too (chrome.mjs watchErrors)
  only('dedicated worker throws', /^page (exception|console\.error in worker|log\.worker)\b.*e2e-boom-worker/);
  for (const re of [/^page exception in worker .*e2e-boom-worker/, /^page console\.error in worker .*e2e-boom-worker-console/])
    assert(by['dedicated worker throws'].failures.some((f) => re.test(f)), `worker failure ${re}: ${JSON.stringify(by['dedicated worker throws'].failures)}`);
  only('dedicated worker fetches a foreign host', /^NETWORK GUARD blocked GET http:\/\/192\.0\.2\.1\/worker /);
  only('phone service worker fetches a foreign host', /^NETWORK GUARD blocked GET http:\/\/192\.0\.2\.1\/sw /);

  // which layer caught them: Fetch interception on the worker targets themselves
  const blocked = browser.guard.blocked.filter((b) => b.url.startsWith(FOREIGN));
  const kind = (p) => blocked.find((b) => b.url === FOREIGN + p)?.target;
  // Chrome routes a dedicated worker's network through its owning frame, so
  // the page session's Fetch sees it (measured: 'page'); either is a guard
  assert(['page', 'worker'].includes(kind('worker')), 'worker request blocked by the page/worker Fetch layer: ' + kind('worker'));
  t.log('dedicated worker request intercepted in target: ' + kind('worker'));
  assert.equal(kind('sw'), 'service_worker', 'SW request blocked in the service_worker target');
  const sinkHits = browser.guard.proxyHits.slice(sinkBefore).filter((h) => /192\.0\.2\.1/.test(h));
  assert.equal(sinkHits.length, 0, 'nothing reached the proxy sink: ' + JSON.stringify(sinkHits));
});
