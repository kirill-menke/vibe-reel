/* Screenshot baselines (optional per the lane spec, lib/visual.mjs): four key
 * TV screens — Login, Home, the Movies grid, MovieDetail — settled, downscaled
 * to 960×540 and compared with e2e/baselines/*.png within a tolerance. They
 * catch what the DOM assertions don't: a lost stylesheet rule, a collapsed
 * layout, a hero that never paints, tofu where an icon was.
 *
 * Volatile pixels are masked, not tolerated: the Quick Connect code (random)
 * and the server URL (the fake's port differs per worker). Everything else is
 * the fixed seed (seed.mjs) at a fixed focus.
 *
 * Re-baseline after an intended visual change:
 *   node e2e/run.mjs --update-baselines --grep 'tv visual'
 * and look at the four PNGs before committing them. */
import { test, assert } from '../lib/runner.mjs';
import { bootTv, waitFocus, steer, SIGNED_OUT_BOOT } from '../lib/tv.mjs';
import { matchBaseline, decodePng, encodePng, downscale, compare, fillRects, BASELINE_DIR, MAX_BASELINE_BYTES } from '../lib/visual.mjs';
import { png } from '../server/png.mjs';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

test('tv visual: PNG codec self-test (round trip, filters, downscale, compare, size limit of the committed baselines)', { app: 'none', fast: true, timeout: 20000 }, async () => {
  // the artwork generator's PNG (RGB, filter none) decodes; re-encoding with adaptive filters round-trips exactly
  const a = decodePng(png(321, 157, 'visual-self-test'));
  assert.equal(a.width, 321);
  const b = decodePng(encodePng(a));
  assert.equal(compare(a, b, { tol: 0 }).differing, 0, 'decode(encode(x)) == x');
  // a noisy image exercises every filter type
  const n = { width: 64, height: 48, data: new Uint8Array(64 * 48 * 3).map((_, i) => (i * 2654435761) >>> 24) };
  assert.equal(compare(n, decodePng(encodePng(n)), { tol: 0 }).differing, 0, 'noise round trip');
  const d = downscale({ width: 2, height: 2, data: new Uint8Array([0, 0, 0, 100, 100, 100, 200, 200, 200, 100, 100, 100]) });
  assert.deepEqual([...d.data], [100, 100, 100], '2×2 box average');
  const m = fillRects(decodePng(encodePng(a)), [{ x: 10, y: 10, width: 20, height: 5 }]);
  assert.equal(compare(m, a, { tol: 40 }).differing, 100, 'a masked 20×5 box differs in exactly 100 px');
  const files = readdirSync(BASELINE_DIR).filter((f) => f.endsWith('.png'));
  assert(files.length <= 4, 'at most 4 baselines: ' + files.join(', '));
  for (const f of files) {
    const size = statSync(path.join(BASELINE_DIR, f)).size;
    assert(size <= MAX_BASELINE_BYTES, `${f} is ${size} B (> ${MAX_BASELINE_BYTES})`);
    const img = decodePng(readFileSync(path.join(BASELINE_DIR, f)));
    assert.equal(`${img.width}×${img.height}`, '960×540', f + ' size');
  }
});

test('tv visual: Login', { fast: false, timeout: 60000, ...SIGNED_OUT_BOOT }, async (t) => {
  const { page } = t;
  await bootTv(t, { signedIn: false });
  await page.waitFor(() => /\d{6}/.test(document.querySelector('.qc-code')?.textContent || ''), { what: 'Quick Connect code' });
  await page.eval(() => document.querySelector('[data-focus="u"]').focus({ preventScroll: true }));
  await waitFocus(page, 'u');
  await matchBaseline(t, 'tv-login', { mask: ['.screen.login .sub', '.qc-code', '#srv'] });
});

test('tv visual: Home', { fast: false, timeout: 60000 }, async (t) => {
  const { page } = t;
  await bootTv(t);
  await waitFocus(page, 'tab-home');
  await page.waitFor(() => document.querySelectorAll('.screen.home .strip .tile').length >= 10 && document.querySelector('.hero.home .backdrop img'), { what: 'Home rails + hero backdrop', timeout: 10000 });
  await matchBaseline(t, 'tv-home');
});

test('tv visual: Movies grid', { fast: false, timeout: 60000 }, async (t) => {
  const { page } = t;
  await bootTv(t);
  await waitFocus(page, 'tab-home');
  await page.key('Right', { settle: 120 });
  await waitFocus(page, 'tab-movies');
  await page.key('OK', { settle: 250 });
  await page.waitFor(() => document.querySelectorAll('.screen .grid .tile').length >= 20, { what: 'Movies grid', timeout: 10000 });
  await waitFocus(page, 'tab-movies');
  await page.key('Down', { settle: 250 });
  // the seed's downloading movie leads the grid as a PendingTile (focus ring + ring breathing, then at rest)
  await page.waitFor(() => document.activeElement?.closest('.screen .grid'), { what: 'focus on the first grid tile' });
  await matchBaseline(t, 'tv-movies');
});

test('tv visual: MovieDetail', { fast: false, timeout: 60000 }, async (t) => {
  const { page, srv } = t;
  const m = srv.world.list('Movie')[0];
  // the seed's dates are relative to now; the detail prints "Added <date>" — pin it
  m.DateCreated = '2030-01-15T12:00:00.0000000Z'; // still the newest, so still in the grid's first row
  await bootTv(t);
  await waitFocus(page, 'tab-home');
  await page.key('Right', { settle: 120 });
  await waitFocus(page, 'tab-movies');
  await page.key('OK', { settle: 250 });
  await page.waitFor((k) => document.querySelector(`.screen .grid [data-focus="${k}"]`), { what: 'first movie tile', timeout: 10000 }, 'tile-' + m.Id);
  await waitFocus(page, 'tab-movies');
  await steer(page, 'tile-' + m.Id, { settle: 200 });
  await page.key('OK', { settle: 300 });
  await waitFocus(page, 'play', 10000);
  await page.waitFor(() => document.querySelector('.screen .hero .backdrop img')?.complete, { what: 'detail backdrop', timeout: 10000 });
  await matchBaseline(t, 'tv-movie-detail');
});
