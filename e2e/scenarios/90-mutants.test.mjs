/* Mutation smoke (scripts/mutants.mjs): the documented regressions, each
 * reintroduced in a scratch copy of the tracked tree, must each make their
 * guarding scenarios FAIL for the expected reason; the unmodified copy (control)
 * must pass. Product files in the worktree are never touched. Serial child runs
 * (~3 min). The 12 min budget (4× the measured time, under run.mjs's 20 min
 * hard timeout) only stops the test from overrunning the suite: a mutant left
 * unrun for lack of time FAILS the test — an oracle that checked nothing must
 * not read as a pass. */
import { test, assert } from '../lib/runner.mjs';
import { CONTROL, MUTANTS, prepare, runAgainst } from '../scripts/mutants.mjs';
import { rmSync } from 'node:fs';

const BUDGET = 12 * 60 * 1000;

test('oracle mutants: X-Emby-Authorization, Trickplay api_key, /Users/{uid}/PlayedItems, a Tile without data-focus, a transcoding profile, reel-api requests without the token, a stream URL without api_key, focus on <body> — each fails its scenarios; the control passes', { app: 'none', fast: false, timeout: BUDGET + 90000 }, async (t) => {
  const t0 = Date.now();
  let slowest = 0;
  const skipped = [];
  const bad = [];
  for (const m of [CONTROL, ...MUTANTS]) {
    if (Date.now() - t0 + Math.max(slowest, 30000) > BUDGET) {
      skipped.push(m.name);
      continue;
    }
    const dir = prepare(m);
    const r = await runAgainst(m, dir, { timeout: Math.min(240000, BUDGET - (Date.now() - t0)) });
    rmSync(dir, { recursive: true, force: true });
    slowest = Math.max(slowest, r.ms);
    const fails = r.out.split('\n').filter((l) => /^FAIL /.test(l)).map((l) => l.replace(/ \(\d+ ms\)$/, ''));
    const broken = /no tests selected|build failed|e2e harness error|child run timed out/.test(r.out);
    const ok = m === CONTROL ? r.code === 0 : r.code !== 0 && !broken && fails.length > 0 && m.expect.test(r.out);
    t.log(`${ok ? (m === CONTROL ? 'clean' : 'caught') : 'NOT AS EXPECTED'} ${m.name} — exit ${r.code}, ${Math.round(r.ms / 1000)} s${fails.length ? ', ' + fails.join('; ') : ''}`);
    if (!ok) bad.push(m.name + ': ' + (m === CONTROL ? 'the unmodified copy failed' : 'not caught by ' + m.grep + ' (want ' + m.expect + ')') + '\n' + r.out.split('\n').slice(-25).join('\n'));
  }
  t.log(`total ${Math.round((Date.now() - t0) / 1000)} s${skipped.length ? ', SKIPPED (budget): ' + skipped.join(', ') : ''}`);
  if (skipped.length) console.log('    mutants NOT RUN (over the 12 min budget): ' + skipped.join(', '));
  assert.deepEqual(bad, [], 'every mutant caught, control clean');
  assert.deepEqual(skipped, [], 'every mutant and the control ran within the budget (a skipped mutant means the mutation oracle is incomplete)');
});
