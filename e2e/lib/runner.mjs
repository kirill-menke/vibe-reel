/* The test registry and runner. Scenario files (e2e/scenarios/*.test.mjs)
 * call test() at import time; run.mjs imports them and calls runAll().
 *
 *   test(name, opts, async (t) => { … })
 *     opts.app      'tv' | 'phone' | 'none' (default 'tv'): which page t.page is
 *     opts.fast     true → part of the smoke subset (run.mjs --fast)
 *     opts.browser  true → start the apps' builds + Chrome even for app 'none'
 *                   (runner self-tests that use t.browser / t.runInner)
 *     opts.seed     createWorld() options for this test's fresh world
 *     opts.timeout  ms (default 60000)
 *     opts.allowErrors  [RegExp]: page errors this test expects (e.g. a 404 it provokes)
 *     opts.allowViolations [RegExp]: server violations this test provokes on purpose
 *                   (the oracle self-tests), or a product bug recorded in
 *                   run/findings.md — exact patterns only, with the finding id
 *                   next to them, removed when the product is fixed
 *
 *   t.srv     the fake server (t.srv.world, t.srv.fault(), t.srv.requests() …)
 *   t.page    a fresh page in its own browser context (null for app 'none')
 *   t.log()   adds a line to the test's output
 *   t.step(name, fn)  named sub-step (shown on failure)
 *   t.skip(why)  marks the test SKIPPED (it still runs to the end; return
 *             after calling it): printed as `SKIP name — why`, counted in
 *             summary.json totals.skipped, never shown as PASS
 *
 * A test FAILS when its function throws, OR the fake server recorded a
 * violation during it (spec / unknown route / unimplemented route / crash),
 * OR the page logged a console error / exception / failed load (unless
 * allowed), OR the network guard blocked a request. */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const tests = [];

export function test(name, opts, fn) {
  if (typeof opts === 'function') (fn = opts), (opts = {});
  if (tests.some((t) => t.name === name)) throw new Error('duplicate test name: ' + name);
  tests.push({ name, opts: { app: 'tv', timeout: 60000, ...opts }, fn, file: currentFile });
}

/* an inner test for t.runInner(): same shape as test(), not registered */
export function innerTest(name, opts, fn) {
  if (typeof opts === 'function') (fn = opts), (opts = {});
  return { name, opts: { app: 'tv', timeout: 60000, ...opts }, fn, file: currentFile };
}

let currentFile = '';
export function setCurrentFile(f) {
  currentFile = f;
}

export class AssertionError extends Error {}
export function assert(cond, msg) {
  if (!cond) throw new AssertionError(msg || 'assertion failed');
}
assert.equal = (a, b, msg) => {
  if (a !== b) throw new AssertionError(`${msg || 'not equal'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
assert.deepEqual = (a, b, msg) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new AssertionError(`${msg || 'not deep-equal'}:\n  expected ${JSON.stringify(b)}\n  got      ${JSON.stringify(a)}`);
};
assert.match = (s, re, msg) => {
  if (!re.test(String(s))) throw new AssertionError(`${msg || 'no match'}: ${JSON.stringify(s)} !~ ${re}`);
};

function withTimeout(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms)))]).finally(() => clearTimeout(t));
}

/* The fake routes this test's requests reached, as 'jf GET /Items/{itemId}'
 * (route coverage in summary.json: which fake routes no scenario exercises).
 * Read from srv.log, so a test that resets the world itself reports only what
 * came after its last reset. */
export function routesHit(srv) {
  const hit = new Set();
  for (const e of srv.log) {
    const router = srv.routers?.[e.origin];
    const m = router?.match(e.method, e.path);
    if (m?.route) hit.add(`${e.origin} ${m.route.method} ${m.route.tpl}`);
  }
  return [...hit].sort();
}

/* Every route the fake implements ('jf GET /Items/{itemId}'), fixtures excluded. */
export function routeTemplates(srv) {
  return Object.entries(srv.routers || {}).flatMap(([o, r]) => r.templates().filter((t) => !t.includes('/__fixture')).map((t) => o + ' ' + t)).sort();
}

export async function runAll({ list, srv, browser, outDir, print = console.log }) {
  mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const tc of list) {
    const t0 = Date.now();
    const lines = [];
    const steps = [];
    let skipped = null;
    srv.reset(tc.opts.seed);
    const blockedBefore = browser ? browser.guard.blocked.length : 0;
    let page = null;
    const failures = [];
    const t = {
      srv,
      page: null,
      log: (...a) => lines.push(a.join(' ')),
      step: async (name, fn) => {
        steps.push(name);
        return fn();
      },
      name: tc.name,
      skip: (why) => {
        skipped = String(why || 'skipped');
        lines.push('SKIPPED: ' + skipped);
      },
      browser,
      /* runner self-tests only (app 'none'): run a private list of inner tests
       * — made with innerTest(), never registered — through this same runAll
       * (same server, same browser, fresh world + browser context each) and
       * return their results. Each inner run resets the world, so the outer
       * test must not depend on it afterwards. Requests the guard blocked
       * during the inner tests are judged there (they are inner failures)
       * and marked expected so the outer test isn't failed by them twice. */
      runInner: async (inner) => {
        const before = browser ? browser.guard.blocked.length : 0;
        const r = await runAll({ list: inner, srv, browser, outDir: path.join(outDir, 'inner'), print: () => {} });
        if (browser) for (const b of browser.guard.blocked.slice(before)) b.expected = true;
        return r;
      },
      /* guard self-tests only: mark blocked requests matching re as expected */
      expectBlocked: (re) => {
        const mine = browser.guard.blocked.slice(blockedBefore).filter((b) => re.test(b.url) && !b.expected);
        for (const b of mine) b.expected = true;
        return mine;
      }
    };
    try {
      if (tc.opts.app !== 'none') {
        page = await browser.newPage({ mobile: tc.opts.app === 'phone' });
        t.page = page;
      }
      await withTimeout(Promise.resolve().then(() => tc.fn(t)), tc.opts.timeout, 'test');
    } catch (e) {
      failures.push((steps.length ? `[step: ${steps.at(-1)}] ` : '') + (e instanceof AssertionError ? e.message : e.stack || String(e)));
    }
    // let in-flight requests land in the server log (bounded: a stream or a
    // hang fault may stay open while the page lives)
    await srv.quiet({ ms: 100, max: 1500 });
    const allowV = tc.opts.allowViolations || [];
    const judged = srv.violations.length;
    for (const v of srv.violations) {
      if (allowV.some((re) => re.test(v.msg))) continue;
      failures.push(`server violation [${v.origin}] ${v.msg}`);
    }
    if (page) {
      const allowE = tc.opts.allowErrors || [];
      for (const e of page.errors) {
        if (allowE.some((re) => re.test(e.text))) continue;
        failures.push(`page ${e.kind}: ${e.text}`);
      }
    }
    if (browser) for (const b of browser.guard.blocked.slice(blockedBefore).filter((b) => !b.expected)) failures.push(`NETWORK GUARD blocked ${b.method} ${b.url} (${b.type})`);
    const safe = tc.name.replace(/[^\w.-]+/g, '_') + (tc.rep ? '.run' + tc.rep : '');
    if (failures.length && page) {
      try {
        await page.screenshot(path.join(outDir, safe + '.png'));
      } catch {}
    }
    if (page) await page.close().catch(() => {});
    // what the page sent on its way out (a keepalive Stopped on pagehide, a
    // last poll) lands after close; the next test's srv.reset() would drop it
    if (page || srv.inflight) await srv.quiet({ ms: 150, max: 2000 });
    for (const v of srv.violations.slice(judged)) {
      if (allowV.some((re) => re.test(v.msg))) continue;
      failures.push(`server violation [${v.origin}] (after the test's end) ${v.msg}`);
    }
    if (failures.length && page) {
      writeFileSync(path.join(outDir, safe + '.log'), [
        '# ' + tc.name, ...failures, '', '## test log', ...lines, '', '## page console', ...page.console.map((c) => c.type + ': ' + c.text),
        '', '## server requests', ...srv.log.map((e) => `${e.status} ${e.origin} ${e.method} ${e.path}${e.search}${e.fault ? ' [fault]' : ''}${e.violations.length ? '  !! ' + e.violations.join(' ; ') : ''}`)
      ].join('\n'));
    }
    const ms = Date.now() - t0;
    const ok = failures.length === 0;
    results.push({ name: tc.name, ok, ms, failures, ...(skipped ? { skipped } : {}), notes: [...srv.notes], known: [...srv.known], routes: routesHit(srv) });
    print(`${ok ? (skipped ? 'SKIP' : 'PASS') : 'FAIL'} ${tc.name}${tc.rep ? ` [run ${tc.rep}/${tc.reps}]` : ''} (${ms} ms)${ok && skipped ? ' — ' + skipped : ''}`);
    if (!ok) for (const f of failures.slice(0, 12)) print('     ' + f.split('\n').slice(0, 6).join('\n       '));
    for (const l of lines) if (process.env.E2E_VERBOSE) print('     · ' + l);
  }
  return results;
}
