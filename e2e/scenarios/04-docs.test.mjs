/* Harness docs stay in step with the code: every name exported from
 * e2e/lib/*.mjs appears in e2e/README.md's helper reference (as `name`), and
 * every KNOWN_DEVIATIONS id is listed under the policy section. A helper added
 * without a line in the README fails here. */
import { test, assert } from '../lib/runner.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KNOWN_DEVIATIONS } from '../server/spec.mjs';

const E2E = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('docs: every lib/*.mjs export and every KNOWN_DEVIATIONS id is documented in e2e/README.md', { app: 'none', fast: true, timeout: 10000 }, async () => {
  const readme = readFileSync(path.join(E2E, 'README.md'), 'utf8');
  const ref = readme.slice(readme.indexOf('## Helper reference'));
  assert(ref.length > 100, 'README has a "## Helper reference" section');
  const missing = [];
  let n = 0;
  for (const f of readdirSync(path.join(E2E, 'lib')).filter((f) => f.endsWith('.mjs')).sort()) {
    const src = readFileSync(path.join(E2E, 'lib', f), 'utf8');
    const names = new Set();
    for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|class|const|let)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
    for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name);
    }
    for (const name of names) {
      n++;
      // `name`, `name(…)` or `name.member` inside backticks
      if (!new RegExp('`' + name.replace(/\$/g, '\\$') + '(?:[(.`\\s,])').test(ref)) missing.push(`${f}: ${name}`);
    }
  }
  assert(n > 60, `found the exports (${n})`);
  assert.deepEqual(missing, [], 'exports without a line in the README helper reference');
  const undocumented = KNOWN_DEVIATIONS.map((d) => d.id).filter((id) => !readme.includes('`' + id + '`'));
  assert.deepEqual(undocumented, [], 'KNOWN_DEVIATIONS ids missing from the README policy section');
});
