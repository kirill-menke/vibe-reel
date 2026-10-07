/* Invariant crawls (lib/crawler.mjs) of Home and Login: every state the
 * D-pad can reach is visited by trusted keys, the focus invariants hold after
 * every press, and every press that leaves the screen comes back with Back. */
import { test, assert } from '../lib/runner.mjs';
import { bootTv, waitFocus, scopeKeys, SIGNED_OUT_BOOT } from '../lib/tv.mjs';
import { crawl, crawlSummary } from '../lib/crawler.mjs';

async function railKeys(page) {
  return page.eval(() => [...document.querySelectorAll('.screen.home .rails .rail .strip .focus')].map((e) => e.dataset.focus));
}

async function bootHome(t) {
  await bootTv(t);
  await waitFocus(t.page, 'tab-home');
  await t.page.waitFor(() => document.querySelectorAll('.screen.home .rails .rail').length >= 4 && document.querySelector('[data-focus="hero-resume"]'), { what: 'Home rails + hero', timeout: 10000 });
}

test('crawl: Home — tabs, bell, avatar, hero and every rail tile, invariants after each press', { fast: false, timeout: 120000 }, async (t) => {
  const { page, srv } = t;
  // longer Trending rails than the seed's 5/6, so the rails scroll sideways
  // (ensureVisible on .strip) and Home has > 25 focusables
  const ml = srv.world.ml;
  const cat = [...ml.catalog.values()];
  for (const e of cat.filter((e) => e.type === 'movie' && e.added).slice(10, 16)) ml.trending.movie.push(e);
  for (const e of cat.filter((e) => e.type === 'tv' && e.added).slice(1, 4)) ml.trending.tv.push(e);
  await bootHome(t);
  const tiles = await railKeys(page);
  const inScope = (await scopeKeys(page)).keys;
  const r = await crawl(page, {
    name: 'home', dupOk: ['tile-'], maxStates: 90, timeLimit: 90000,
    restore: async () => {
      await page.reload();
      await page.waitFor(() => !document.getElementById('splash'), { timeout: 12000, what: 'splash gone' });
      await waitFocus(page, 'tab-home');
      await page.waitFor(() => document.querySelector('[data-focus="hero-resume"]'), { what: 'hero', timeout: 10000 });
    },
    log: t.log
  });
  t.log(crawlSummary(r));
  t.log('keys: ' + r.keys.join(' '));
  t.log('leaves: ' + r.leaves.map((l) => `${l.from} ${l.key} → ${l.to}`).join(' ; '));
  if (r.varying.length) t.log('edges that landed differently: ' + r.varying.slice(0, 10).join(' ; '));
  assert.deepEqual(r.problems, [], 'Home crawl problems');
  assert(r.ms <= 95000, 'crawl within its time budget: ' + r.ms);
  assert(r.keys.length >= 25, `>= 25 distinct keys visited, got ${r.keys.length}`);
  for (const k of ['tab-home', 'tab-movies', 'tab-shows', 'nav-news', 'nav-account', 'hero-resume']) assert(r.keys.includes(k), 'visited ' + k + ': ' + r.keys.join(' '));
  const missing = [...new Set(tiles)].filter((k) => !r.keys.includes(k));
  assert.deepEqual(missing, [], 'every rail tile visited');
  assert.deepEqual([...new Set(inScope)].filter((k) => !r.keys.includes(k)), [], 'every focusable in Home\'s scope visited');
  // ▲ on the tab row raises Search; Back brought Home back (checked by the crawler)
  assert(r.leaves.some((l) => /^tab-/.test(l.from) && l.key === 'Up' && /^#search\|/.test(l.to)), 'Up on the tab row raised Search: ' + JSON.stringify(r.leaves));
  assert(r.complete, 'crawl explored everything it found: ' + crawlSummary(r));
});

async function loginCrawl(t, { qc = true, showServer = false } = {}) {
  const { page, srv } = t;
  srv.world.quickConnectEnabled = qc;
  await bootTv(t, { signedIn: false });
  const ready = async () => {
    await page.waitFor(() => document.querySelector('.screen.login [data-focus="u"]'), { what: 'login form' });
    await page.waitFor((qc) => (qc ? /\d{6}/.test(document.querySelector('.qc-code')?.textContent || '') : document.querySelector('[data-focus="qc-new"]')), { what: 'Quick Connect state', timeout: 10000 }, qc);
    await page.waitFor(() => document.activeElement && document.activeElement !== document.body, { what: 'initial focus' });
  };
  await ready();
  if (showServer) {
    // reach "Change server" by the D-pad from the initial focus, OK reveals the Server URL field
    for (let i = 0; i < 6 && (await page.eval(() => document.activeElement?.dataset.focus)) !== 'server'; i++) {
      const f = await page.eval(() => document.activeElement?.dataset.focus);
      await page.key(f === 'login' ? 'Right' : 'Down', { settle: 120 });
    }
    assert.equal(await page.eval(() => document.activeElement?.dataset.focus), 'server', 'reached Change server by D-pad');
    await page.key('OK', { settle: 200 });
    await waitFocus(page, 'srv');
  }
  const r = await crawl(page, {
    name: 'login' + (qc ? '' : ' (no Quick Connect)') + (showServer ? ' + server field' : ''), maxStates: 20, timeLimit: 60000, settle: 120,
    restore: showServer ? null : async () => {
      await page.reload();
      await ready();
    },
    log: t.log
  });
  t.log(crawlSummary(r));
  assert.deepEqual(r.problems, [], 'Login crawl problems');
  assert.deepEqual(r.leaves, [], 'arrows never leave Login');
  return r;
}

test('crawl: Login — Quick Connect code + password form', { fast: false, timeout: 90000, ...SIGNED_OUT_BOOT }, async (t) => {
  const r = await loginCrawl(t);
  for (const k of ['u', 'p', 'login', 'server']) assert(r.keys.includes(k), 'visited ' + k + ': ' + r.keys.join(' '));
  assert(r.complete, crawlSummary(r));
});

test('crawl: Login — Quick Connect unavailable (qc-new) and the Server URL field', { fast: false, timeout: 120000, ...SIGNED_OUT_BOOT, allowErrors: [...SIGNED_OUT_BOOT.allowErrors, /status of 401 .*\/QuickConnect\/Initiate/] }, async (t) => {
  const r = await loginCrawl(t, { qc: false });
  for (const k of ['qc-new', 'u', 'p', 'login', 'server']) assert(r.keys.includes(k), 'visited ' + k + ': ' + r.keys.join(' '));
  assert(r.complete, crawlSummary(r));
  const r2 = await loginCrawl(t, { qc: false, showServer: true });
  for (const k of ['srv', 'qc-new', 'u', 'p', 'login', 'server']) assert(r2.keys.includes(k), 'visited ' + k + ': ' + r2.keys.join(' '));
  assert(r2.complete, crawlSummary(r2));
});

/* The crawler itself bites: a synthetic screen on the blank fixture page with
 * its own key map, seeded with one of each defect the crawl must report. */
test('crawl: self-test — a synthetic screen with known defects is reported, a clean one is not', { fast: true, timeout: 30000 }, async (t) => {
  const { page, srv } = t;
  const mk = (defects) => page.eval((defects) => {
    document.body.innerHTML = `<div class="screen synth">
      <button class="focus" data-focus="a">a</button><button class="focus" data-focus="b">b</button>
      <button class="focus" data-focus="c">c</button>
      ${defects ? '<button class="focus" data-focus="b">dup</button><button class="plain">no class</button><span class="focus">no key</span>' : ''}
    </div><div id="search"><button class="focus" data-focus="q">q</button></div>`;
    const by = (k) => document.querySelector(`.screen [data-focus="${k}"]`);
    // a → b → c to the right; ▲ on a raises "search"; Back closes it (onto a, or — defect — onto nothing)
    const right = { a: 'b', b: 'c' };
    const left = { b: 'a', c: 'b' };
    window.onkeydown = (e) => {
      const f = document.activeElement?.dataset?.focus;
      const s = document.getElementById('search');
      if (e.keyCode === 461) {
        s.classList.remove('on');
        if (defects) document.activeElement.blur();
        else by('a').focus();
        return;
      }
      if (s.classList.contains('on')) return;
      if (e.keyCode === 39 && right[f]) by(right[f]).focus();
      if (e.keyCode === 37 && left[f]) by(left[f]).focus();
      if (e.keyCode === 40 && f === 'c' && defects) document.activeElement.blur(); // ▼ on c drops focus
      if (e.keyCode === 38 && f === 'a') {
        s.classList.add('on');
        s.querySelector('button').focus();
      }
    };
    by('a').focus();
    return true;
  }, defects);

  await page.goto(srv.urls.tv + '/__e2e_blank');
  await mk(false);
  const clean = await crawl(page, { name: 'synthetic clean', settle: 0, leaveSettle: 50 });
  t.log(crawlSummary(clean));
  assert.deepEqual(clean.problems, [], 'clean synthetic screen has no problems');
  assert.deepEqual(clean.keys.sort(), ['a', 'b', 'c'], 'all three visited');
  assert.equal(clean.leaves.length, 1, 'the ▲ leave was recorded');
  assert(clean.complete, crawlSummary(clean));

  await mk(true);
  const bad = await crawl(page, {
    name: 'synthetic defects', settle: 0, leaveSettle: 50,
    restore: async () => mk(true)
  });
  t.log(crawlSummary(bad));
  for (const p of bad.problems) t.log('  ' + p);
  const has = (re) => assert(bad.problems.some((p) => re.test(p)), `reported ${re}: ${JSON.stringify(bad.problems)}`);
  has(/duplicate data-focus="b" in \.screen/);
  has(/interactive <button class="plain">.* lacks class focus\|opt/);
  has(/<span class="focus">.* has no data-focus/);
  has(/^focus is on <body>.*\(c --Down-->\)/);
  has(/^Back from #search\|synth left focus on <body>/);
});
