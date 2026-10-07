#!/usr/bin/env node
/* Download Jellyfin 12.1's PUBLIC OpenAPI spec into the git-ignored cache
 * (e2e/.cache/). The spec is never committed; without it the run skips the
 * request-validation check (and says so).
 *
 *   node e2e/scripts/fetch-spec.mjs [--force]
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { SPEC_FILE, SPEC_URL } from '../server/spec.mjs';
import path from 'node:path';

const force = process.argv.includes('--force');
if (existsSync(SPEC_FILE) && !force) {
  console.log('spec already cached:', path.relative(process.cwd(), SPEC_FILE));
  process.exit(0);
}
const r = await fetch(SPEC_URL, { signal: AbortSignal.timeout(60000) });
if (!r.ok) {
  console.error('fetch failed: HTTP', r.status, SPEC_URL);
  process.exit(1);
}
const text = await r.text();
const spec = JSON.parse(text);
if (!String(spec.info?.version).startsWith('12.1')) {
  console.error('unexpected spec version', spec.info?.version);
  process.exit(1);
}
mkdirSync(path.dirname(SPEC_FILE), { recursive: true });
writeFileSync(SPEC_FILE, text);
console.log('cached', spec.info.version, Object.keys(spec.paths).length, 'paths →', path.relative(process.cwd(), SPEC_FILE));
