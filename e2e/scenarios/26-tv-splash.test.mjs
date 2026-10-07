/* TV splash timing (Splash.svelte, CLAUDE.md "App lifecycle": "Splash.svelte
 * fades out on a hard deadline even if S.ready never arrives").
 *
 * The splash fades once the wordmark has landed (FADE_EARLIEST = 3.05 s after
 * its onMount) AND S.ready, or at HOLD_MAX = 10.2 s whatever happens; the fade
 * itself is 0.65 s. So from its mount it is gone after 3.70 s at the earliest
 * and 10.85 s at the latest — on any machine, because the timeline is wall
 * time (performance.now() in rAF), not frame counts.
 *
 * A probe installed before the app's first byte (addScriptToEvaluateOnNewDocument)
 * records, on the page's clock (0 = navigation start): when #splash is
 * inserted (≈ its onMount), when the scene's opacity first drops below 1 (the
 * fade began), when #splash is removed, the load event, and the longest gap
 * between animation frames while the splash was up.
 *
 *   E2E_SPLASH_BOOTS=20 node e2e/run.mjs --grep 'tv splash: timing' --jobs 1
 *
 * measures 20 boots and prints the distribution (the E2E-44 numbers in
 * run/progress.md were taken that way, idle and under a CPU hog). The default
 * is 3 boots, enough for the bounds below. */
import { test, assert } from '../lib/runner.mjs';
import { bootTv, waitFocus, waitSplashGone } from '../lib/tv.mjs';

const FADE_EARLIEST = 3.05; // Splash.svelte CUE.Word + 0.85
const HOLD_MAX = 4.9 - 0.7 + 6; // fadeStart + 6
const FADE = 0.65; // fadeEnd - fadeStart
/* The rAF that sees the fade complete can come one frame late, and the
 * removal is a Svelte flush after it; under a saturated host frames stretch
 * to ~100 ms+ (measured, progress.md E2E-44), so allow 1 s for that. */
const SLACK = 1.0;

const PROBE = `(() => {
  const P = (window.__e2eSplash = { ins: null, fade: null, gone: null, maxGap: 0 });
  let last = null;
  const tick = (now) => {
    if (last != null) P.maxGap = Math.max(P.maxGap, now - last);
    last = now;
    if (P.gone == null) requestAnimationFrame(tick);
  };
  const mo = new MutationObserver(() => {
    const el = document.getElementById('splash');
    const now = performance.now();
    if (el && P.ins == null) { P.ins = now; requestAnimationFrame(tick); }
    if (el && P.fade == null) {
      const sc = el.querySelector('.splash-scene');
      if (sc && sc.style.opacity !== '' && Number(sc.style.opacity) < 1) P.fade = now;
    }
    if (!el && P.ins != null && P.gone == null) { P.gone = now; mo.disconnect(); }
  });
  mo.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
})();`;

async function bootMeasured(t, opts = {}) {
  const { page } = t;
  const id = await page.s.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
  const w0 = Date.now();
  await bootTv(t, { skipSplash: false, ...opts });
  const wLoad = Date.now() - w0;
  // the harness's own wait: what waitSplashGone sees, from goto()'s return
  const r = await page.waitFor(() => window.__e2eSplash?.gone != null && window.__e2eSplash, { what: 'splash gone (probe)', timeout: 20000 });
  const wGone = Date.now() - w0;
  const load = await page.eval(() => performance.getEntriesByType('navigation')[0]?.loadEventStart || 0);
  await page.s.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id.identifier });
  const s = (ms) => +(ms / 1000).toFixed(2);
  return {
    ins: s(r.ins), // navigation → splash mounted
    fade: r.fade == null ? null : s(r.fade - r.ins), // mount → fade began
    life: s(r.gone - r.ins), // mount → removed
    load: s(load), // navigation → load event
    afterLoad: s(r.gone - load), // what waitSplashGone's timeout covers (it starts at goto()'s return)
    maxGap: Math.round(r.maxGap),
    harnessMs: wGone - wLoad // goto() return → the harness saw it gone (incl. polling)
  };
}

const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];

test('tv splash: timing — mounts early, fades after the wordmark (≥ 3.05 s) once Home is ready, gone within its own 10.85 s deadline', { fast: false, timeout: 600000 }, async (t) => {
  const n = Math.max(1, Number(process.env.E2E_SPLASH_BOOTS) || 3);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const r = await bootMeasured(t);
    rows.push(r);
    t.log(`boot ${i + 1}: ` + JSON.stringify(r));
    assert(r.fade != null, 'the fade was observed');
    assert(r.fade >= FADE_EARLIEST - 0.05, `fade not before the wordmark has landed (${r.fade} s)`);
    assert(r.life >= FADE_EARLIEST + FADE - 0.05, `splash up at least ${FADE_EARLIEST + FADE} s (${r.life} s)`);
    assert(r.life <= HOLD_MAX + FADE + SLACK, `splash gone within its hard deadline + ${SLACK} s (${r.life} s)`);
  }
  const keys = ['ins', 'fade', 'life', 'afterLoad', 'maxGap', 'harnessMs'];
  t.log('n=' + n + ' ' + keys.map((k) => `${k} p50 ${pct(rows.map((r) => r[k]), 50)} p95 ${pct(rows.map((r) => r[k]), 95)} max ${Math.max(...rows.map((r) => r[k]))}`).join(' · '));
  await waitFocus(t.page, 'tab-home');
});

test('tv splash: Home that never gets its data (hung rails) still loses the splash on the hard deadline, no later than 10.85 s after mount', { fast: false, timeout: 60000 }, async (t) => {
  const { srv } = t;
  for (const path of ['/UserItems/Resume', '/Shows/NextUp']) srv.fault({ origin: 'jf', method: 'GET', path }, { hang: true });
  const r = await bootMeasured(t);
  t.log(JSON.stringify(r));
  // Home's grabs give up at 10 s (S.ready then), HOLD_MAX is 10.2 s: whichever
  // comes first, the splash holds on the lockup until about then …
  assert(r.fade >= 9.5, `held on the lockup while Home had no data (fade at ${r.fade} s)`);
  // … and is out of the way by the hard deadline
  assert(r.life <= HOLD_MAX + FADE + SLACK, `gone within the hard deadline + ${SLACK} s (${r.life} s)`);
});

test('tv splash: a waitSplashGone timeout says why — page state (frames, scene opacity, screen, rails) in the error', { fast: false, timeout: 30000 }, async (t) => {
  await bootTv(t, { skipSplash: false });
  let err = null;
  try {
    await waitSplashGone(t.page, 300); // the splash is up for 3.7 s: this times out
  } catch (e) {
    err = e;
  }
  assert(err, 'timed out');
  t.log(err.message);
  assert.match(err.message, /waitFor timed out after 300 ms: splash gone .* — page state \{"framesIn500ms":\d+,"splashNow":(true|false),"pageMs":\d+,.*"sceneOpacity":.*"rails":\d+/, 'diagnostics');
  assert(+/"framesIn500ms":(\d+)/.exec(err.message)[1] > 5, 'frames are being produced');
  await waitSplashGone(t.page);
});
