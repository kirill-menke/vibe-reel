/* Oracle integrity: the suite may not quietly weaken itself. Scans every test
 * and helper file for the ways a test can be switched off or forced green.
 * If this fails, fix the test you were about to skip — don't edit this list.
 * (Product-code bugs that make a test impossible: mark the task blocked and
 * record it in run/findings.md, as the lane rules say.) */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SELF = path.resolve(import.meta.filename);

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(m?js|ts)$/.test(f)) out.push(p);
  }
  return out;
}

/* One exception (round 3 lane rules): a test that pins the *correct* behaviour
 * of a product bug found while writing it, marked expected-to-fail with the
 * finding's id as the first words of its name — `it.fails('R3-PO-1: …'` — and
 * recorded in run/findings.md. It turns red the day the bug is fixed, so it
 * can't hide anything; any other `.fails` is still forbidden. */
const FINDING_FAILS = /\bit\s*\.\s*fails\s*\(\s*'R\d+-[A-Z]+-\d+: /;
const FORBIDDEN = [
  [/\b(it|test|describe|suite|bench)\s*\.\s*(only|skip|todo|skipIf|runIf|concurrent\.only)\b/, 'focused/skipped/todo/fails test'],
  [/\b(test|describe|suite|bench)\s*\.\s*fails\b|\bit\s*\.\s*fails\b(?!\s*\(\s*'R\d+-[A-Z]+-\d+: )/, 'focused/skipped/todo/fails test'],
  [/\b(xit|xdescribe|xtest|fit|fdescribe)\s*\(/, 'jasmine-style skip/focus'],
  [/\bctx\.skip\s*\(|\bcontext\.skip\s*\(|\b(?:t|task)\.skip\s*\(/, 'runtime skip'],
  [/passWithNoTests/, '--passWithNoTests'],
  [/process\.env\.(VITEST|CI)\b[^\n]*\?/, 'behaviour switched on the test runner itself'],
  [/expect\.soft\s*\(/, 'soft assertions never fail the test']
];

describe('oracle integrity', () => {
  const files = walk(ROOT).filter((f) => f !== SELF);

  it('finds the test files', () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it('no test is focused, skipped, todo or soft', () => {
    const hits = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      src.split('\n').forEach((line, i) => {
        for (const [re, why] of FORBIDDEN) if (re.test(line)) hits.push(`${path.relative(ROOT, f)}:${i + 1} ${why}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('the finding exception is that narrow', () => {
    const hit = (line) => FORBIDDEN.some(([re]) => re.test(line));
    expect(hit("it.fails('R3-PO-1: a 404 is final', async () => {")).toBe(false);
    expect(FINDING_FAILS.test("it.fails('R3-PO-1: a 404 is final', async () => {")).toBe(true);
    for (const bad of ["it.fails('a 404 is final', () => {", 'it.fails(`R3-PO-1: x`, () => {', "it.fails('R3-PO-1 x', () => {", "test.fails('R3-PO-1: x', () => {", "describe.fails('R3-PO-1: x'", "it.only('R3-PO-1: x'", "it.skip('R3-PO-1: x'", 'it.fails.each([1])']) {
      expect(hit(bad), bad).toBe(true);
    }
  });

  it('every test file has at least one expect()', () => {
    const empty = files.filter((f) => /\.test\.m?js$/.test(f) && !/\bexpect\s*[.(]/.test(readFileSync(f, 'utf8')));
    expect(empty.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it('the config keeps both projects, the setup guard and the empty envDir', () => {
    const cfg = readFileSync(path.join(ROOT, '..', 'vitest.config.js'), 'utf8');
    expect(cfg).toMatch(/name: 'tv'/);
    expect(cfg).toMatch(/name: 'phone'/);
    expect(cfg).toMatch(/setupFiles: \[path\.join\(repo, 'test\/helpers\/setup\.js'\)\]/);
    expect(cfg).toMatch(/envDir: emptyEnv/);
    expect(cfg).toMatch(/allowOnly: false/);
    expect(cfg).not.toMatch(/passWithNoTests|bail:|exclude:/);
  });

  it('the setup still fails any test that reached the network guard, and only the harness opts out', () => {
    const setup = readFileSync(path.join(ROOT, 'helpers', 'setup.js'), 'utf8');
    expect(setup).toMatch(/guardHits\.push\(url\)/);
    expect(setup).toMatch(/if \(hits\.length && !guardAllowed\) throw/);
    const optOuts = files.filter((f) => f !== path.join(ROOT, 'helpers', 'setup.js') && /allowUnmockedNetwork\(\)/.test(readFileSync(f, 'utf8')));
    expect(optOuts.map((f) => path.relative(ROOT, f))).toEqual(['shared/harness.test.js']);
  });
});
