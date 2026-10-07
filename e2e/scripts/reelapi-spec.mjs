#!/usr/bin/env node
/* reel-api's own OpenAPI, dumped from the FastAPI app without starting it,
 * into the git-ignored e2e/.cache/reel-api-openapi.json. The fake reel-api
 * validates requests and its own responses against it (server/reelspec.mjs),
 * so a fake that drifts from backend/src/reel_api/models.py fails the run.
 *
 *   node e2e/scripts/reelapi-spec.mjs [--force]
 *
 * How: `uv run --frozen --project backend` (the backend's own lock) in a venv
 * under e2e/.cache/, importing reel_api.app and calling app.openapi(). Importing
 * the app has no side effects (backends are built in its lifespan, which never
 * runs here). The child gets a scrubbed environment — PATH and HOME only, TMPDIR
 * inside e2e/.cache — so no backend env file or *_URL/*_API_KEY variable can
 * reach it. From run.mjs it is strictly --offline (the harness contacts no host
 * but localhost on its own): on a cold uv cache the run reports the check as
 * SKIPPED. Only this CLI (an explicit, opt-in fetch like fetch-spec.mjs) falls
 * back to an online `uv run`, which may download the backend's locked packages
 * from PyPI. Without uv or python the check is SKIPPED too.
 *
 * Routes without a response_model answer `{}` in the OpenAPI; their shapes are
 * hand-written in backend/tests/support/documented.py (import-free, checked
 * against the real answers by the backend's contract tests) and dumped into the
 * file as `x-documented` {"METHOD /route status": JSON Schema}, so the fake's
 * answers on those routes are checked too (server/reelspec.mjs).
 *
 * The file carries `x-e2e-source-hash` (backend/src/**.py, documented.py,
 * uv.lock): the run regenerates it when the backend changes. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..');
const CACHE = path.join(REPO, 'e2e', '.cache');
const BACKEND = path.join(REPO, 'backend');
export const REEL_SPEC_FILE = path.join(CACHE, 'reel-api-openapi.json');
const DOCUMENTED = path.join(BACKEND, 'tests', 'support', 'documented.py');
/* The one-line hint every "no reel-api spec" failure carries. */
export const WARM_HINT = 'warm it once with `node e2e/scripts/reelapi-spec.mjs` (fetches the backend\'s locked packages into the uv cache)';

function sourceHash() {
  const h = createHash('sha256');
  const walk = (d) => {
    for (const f of readdirSync(d).sort()) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) {
        if (f !== '__pycache__') walk(p);
      } else if (f.endsWith('.py')) h.update(path.relative(BACKEND, p) + '\0' + readFileSync(p) + '\0');
    }
  };
  walk(path.join(BACKEND, 'src'));
  if (existsSync(DOCUMENTED)) h.update('documented.py\0' + readFileSync(DOCUMENTED) + '\0');
  for (const f of ['uv.lock', 'pyproject.toml']) if (existsSync(path.join(BACKEND, f))) h.update(f + '\0' + readFileSync(path.join(BACKEND, f)));
  return h.digest('hex').slice(0, 16);
}

/* → { ok: true, file, fresh } | { ok: false, reason } */
export function ensureReelSpec({ force = false, online = false, log = () => {} } = {}) {
  if (!existsSync(path.join(BACKEND, 'src', 'reel_api', 'app.py'))) return { ok: false, reason: 'backend/src/reel_api/app.py not found' };
  const hash = sourceHash();
  if (!force && existsSync(REEL_SPEC_FILE)) {
    try {
      if (JSON.parse(readFileSync(REEL_SPEC_FILE, 'utf8'))['x-e2e-source-hash'] === hash) return { ok: true, file: REEL_SPEC_FILE, fresh: false };
    } catch {}
  }
  const uv = spawnSync('uv', ['--version'], { encoding: 'utf8' });
  if (uv.error || uv.status !== 0) return { ok: false, reason: 'uv not available (nix develop has it)' };
  const tmp = path.join(CACHE, 'reel-tmp');
  mkdirSync(tmp, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: tmp,
    PYTHONDONTWRITEBYTECODE: '1',
    UV_PROJECT_ENVIRONMENT: path.join(CACHE, 'reel-api-venv'),
    UV_NO_PROGRESS: '1'
  };
  const py = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(BACKEND)})`,
    'from reel_api.app import app',
    'from tests.support.documented import DOCUMENTED',
    'doc = app.openapi()',
    'doc["x-documented"] = {f"{m} {r} {s}": v for (m, r, s), v in DOCUMENTED.items()}',
    'sys.stdout.write(json.dumps(doc))'
  ].join('\n');
  let out = null;
  let err = '';
  for (const extra of online ? [['--offline'], []] : [['--offline']]) {
    log('reel-api spec: uv run ' + (extra.join(' ') || '(online)'));
    const r = spawnSync('uv', ['run', '--frozen', ...extra, '--project', BACKEND, '--no-dev', 'python', '-c', py], { env, encoding: 'utf8', timeout: 240000, maxBuffer: 64 << 20 });
    if (r.status === 0 && r.stdout.trim().startsWith('{')) {
      out = r.stdout;
      break;
    }
    err = (r.error ? String(r.error) : '') + (r.stderr || '').trim().split('\n').slice(-3).join(' | ');
  }
  if (!out) return { ok: false, reason: 'could not import reel_api.app' + (online ? '' : ' offline — ' + WARM_HINT) + ': ' + err.slice(0, 300) };
  const doc = JSON.parse(out);
  doc['x-e2e-source-hash'] = hash;
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(REEL_SPEC_FILE, JSON.stringify(doc));
  return { ok: true, file: REEL_SPEC_FILE, fresh: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = ensureReelSpec({ force: process.argv.includes('--force'), online: true, log: console.log });
  if (!r.ok) {
    console.error('reel-api spec: FAILED —', r.reason);
    process.exit(1);
  }
  const doc = JSON.parse(readFileSync(r.file, 'utf8'));
  console.log(`reel-api spec ${r.fresh ? 'written' : 'up to date'}: ${Object.keys(doc.paths).length} paths →`, path.relative(process.cwd(), r.file));
}
