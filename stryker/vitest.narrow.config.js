/* Stryker only (stryker.config.mjs picks this file when STRYKER_TESTS is set):
 * the repo's vitest.config.js — both projects, same plugins and defines — with
 * each project's test files narrowed to STRYKER_TESTS (comma-separated globs,
 * repo-relative). A glob only joins the project whose own include it falls
 * under (test/tv/… → tv, test/phone/… → phone, test/shared/… → both).
 *
 * Why: perTest coverage still re-runs every test that touched a mutant, and
 * focus.js / player.svelte.js are touched by ~400 player tests. Unnarrowed, a
 * focus.js mutant took ~15× longer than with its own two files. */
import base from '../vitest.config.js';

const want = process.env.STRYKER_TESTS ? process.env.STRYKER_TESTS.split(',').map((g) => g.trim()).filter(Boolean) : null;
const t = base.test;

export default {
  ...base,
  test: {
    ...t,
    projects: t.projects.map((p) => {
      if (!want) return p;
      const dirs = p.test.include.map((g) => g.replace(/\*\*.*$/, ''));   // 'test/tv/', 'test/shared/'
      const inc = want.filter((g) => dirs.some((d) => g.startsWith(d)));
      return { ...p, test: { ...p.test, include: inc.length ? inc : ['test/__none__/*.test.js'] } };
    })
  }
};
