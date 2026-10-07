#!/usr/bin/env node
/* Mutation smoke for the oracle: each mutant reintroduces ONE regression that
 * CLAUDE.md documents, in a scratch copy of the tracked tree, and the scenarios
 * that guard against it must then FAIL. The worktree's product files are never
 * touched — copies live in the git-ignored e2e/.build/mutants/<name>/ (with
 * node_modules symlinked), the TV app is built from the copy by a child run
 * (`run.mjs --tv-src <copy>`, its own fake server, builds under
 * e2e/.build/mutants/build, artifacts under e2e/.build/mutants/out-<name>),
 * so run/gate.sh's byte-identical bundle check is unaffected.
 *
 *   node e2e/scripts/mutants.mjs            control + every mutant, a table
 *   node e2e/scripts/mutants.mjs auth-header control
 *
 * Used by scenarios/90-mutants.test.mjs. */
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MUT_DIR = path.join(REPO, 'e2e', '.build', 'mutants');

/* file: repo-relative; from → to must match exactly once.
 * grep: the scenarios that guard the invariant; expect: what the failing run must say. */
export const MUTANTS = [
  {
    name: 'auth-header',
    why: 'Jellyfin 12 no longer reads X-Emby-Authorization (400 request.App)',
    file: 'src/lib/api.js',
    from: 'const headers = { Authorization: authHeader() };',
    to: "const headers = { 'X-Emby-Authorization': authHeader() };",
    grep: 'tv login: password sign-in',
    expect: /X-Emby-Authorization/
  },
  {
    name: 'trickplay-api_key',
    why: '12.1 answers api_key= with 401 on Trickplay; ApiKey= is required',
    file: 'src/lib/player.svelte.js',
    // lane/types wrapped the read in a JSDoc cast; the mutant flips only the key
    from: '(t).sourceId, ApiKey: cfg.token })',
    to: '(t).sourceId, api_key: cfg.token })',
    grep: 'tv player Up Next: the Outro segment',
    expect: /api_key/
  },
  {
    name: 'played-route',
    why: 'the legacy /Users/{uid}/PlayedItems route is gone from 12.1',
    file: 'src/lib/played.js',
    from: "api('/UserPlayedItems/' + id + qs({ userId: cfg.userId })",
    to: "api('/Users/' + cfg.userId + '/PlayedItems/' + id + qs({})",
    grep: 'tv movie detail: Watched sends',
    expect: /PlayedItems/
  },
  {
    name: 'tile-no-data-focus',
    why: 'every focusable needs a unique data-focus key (the D-pad reads the DOM)',
    file: 'src/components/Tile.svelte',
    from: '  data-focus="tile-{item.Id}"\n',
    to: '\n',
    grep: 'tv home: rails reflect play state',
    // the test reads each rail's tile keys (data-focus) before its invariant pass: [null, …]
    expect: /data-focus|expected \["tile-[0-9a-f]{32}"[^\n]*\n\s+got\s+\[null/
  },
  {
    name: 'transcoding-profile',
    why: 'the no-transcode contract: empty TranscodingProfiles outside burn-in',
    file: 'src/lib/tracks.js',
    from: '    TranscodingProfiles: [],\n    ContainerProfiles: [],',
    to: "    TranscodingProfiles: [{ Type: 'Video', Container: 'ts', Protocol: 'hls', VideoCodec: 'h264', AudioCodec: 'aac', Context: 'Streaming' }],\n    ContainerProfiles: [],",
    grep: 'tv player: Play on MovieDetail',
    expect: /TranscodingProfiles|transcod/i
  },
  {
    name: 'ml-no-token',
    why: "reel-api's guard (security.py) answers 401 to a request without the signed-in user's Jellyfin token",
    file: 'src/lib/medialib.js',
    from: "opts.headers = mlHeaders(body !== undefined ? { 'Content-Type': 'application/json' } : null);",
    to: "opts.headers = body !== undefined ? { 'Content-Type': 'application/json' } : {};",
    grep: 'tv home: rails reflect play state',
    expect: /reel-api guard: no Jellyfin token on GET \/api\/(trending|activity|news)/
  },
  {
    name: 'stream-no-api_key',
    why: 'the <video> fetches the pending stream itself and cannot send a header: the token rides as api_key (mlUrl)',
    file: 'src/lib/medialib.js',
    from: "return mlUrl('/api/downloads/' + encodeURIComponent(id) + '/stream');",
    to: "return cfg.medialib + '/api/downloads/' + encodeURIComponent(id) + '/stream';",
    grep: 'tv pending play: Play on a downloading movie',
    expect: /reel-api guard: no Jellyfin token on (GET|HEAD) \/api\/downloads\/[0-9a-f]{40}\/stream/
  },
  {
    name: 'focus-body',
    why: 'focus must never end on <body> (focusFirst falls back to the first focusable)',
    file: 'src/lib/focus.js',
    from: '  if (el) focusEl(el);\n  else document.body.focus();',
    to: '  document.body.focus();',
    grep: 'tv login: password sign-in|tv home: rails reflect play state',
    expect: /focus is on <body>/
  }
];
export const CONTROL = { name: 'control', why: 'unmodified copy: every guarding scenario passes', grep: MUTANTS.map((m) => m.grep).join('|') };

/* the tracked tree (working-tree contents) copied to e2e/.build/mutants/<name>, one mutation applied */
export function prepare(m) {
  const dir = path.join(MUT_DIR, m.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files = execFileSync('git', ['-C', REPO, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const f of files) {
    if (f.startsWith('e2e/')) continue; // the harness itself runs from REPO
    const src = path.join(REPO, f);
    if (!existsSync(src) || lstatSync(src).isDirectory()) continue;
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    cpSync(src, path.join(dir, f));
  }
  symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  if (m.file) {
    const p = path.join(dir, m.file);
    const text = readFileSync(p, 'utf8');
    const n = text.split(m.from).length - 1;
    if (n !== 1) throw new Error(`mutant ${m.name}: expected exactly one match in ${m.file}, found ${n} — the product code moved, update the mutant`);
    writeFileSync(p, text.replace(m.from, m.to));
  }
  return dir;
}

/* one child run of the guarding scenarios against the copy's TV build → { code, out, ms } */
export function runAgainst(m, dir, { timeout = 240000 } = {}) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const args = [path.join(REPO, 'e2e', 'run.mjs'), '--tv-src', dir, '--build-dir', path.join(MUT_DIR, 'build'), '--out-dir', path.join(MUT_DIR, 'out-' + m.name), '--grep', m.grep];
    const p = spawn(process.execPath, args, { cwd: REPO, env: { ...process.env, E2E_JOBS: '1', E2E_VERBOSE: '' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const kill = setTimeout(() => {
      out += '\n[mutants] child run timed out after ' + timeout + ' ms';
      try {
        process.kill(-p.pid, 'SIGTERM');
      } catch {}
    }, timeout);
    p.on('exit', (code) => {
      clearTimeout(kill);
      resolve({ code, out, ms: Date.now() - t0 });
    });
  });
}

/* control first; then every mutant must fail for the expected reason */
export async function runMutants(names, log = console.log) {
  const pick = names?.length ? [CONTROL, ...MUTANTS].filter((m) => names.includes(m.name)) : [CONTROL, ...MUTANTS];
  const rows = [];
  for (const m of pick) {
    const dir = prepare(m);
    const r = await runAgainst(m, dir);
    const selected = (/^(\d+)\/(\d+) passed/m.exec(r.out) || [])[2];
    // a mutant must fail IN a scenario (its expected reason), not by breaking the build or the harness
    const broken = /no tests selected|build failed|e2e harness error|timed out after \d+ ms\n?$/.test(r.out);
    const ok = m === CONTROL ? r.code === 0 : r.code !== 0 && !broken && /^FAIL /m.test(r.out) && m.expect.test(r.out);
    rows.push({ name: m.name, ok, code: r.code, ms: r.ms, tests: selected, out: r.out });
    log(`${ok ? 'OK  ' : 'BAD '} ${m.name.padEnd(20)} exit ${r.code}  ${String(Math.round(r.ms / 1000)).padStart(3)} s  ${m === CONTROL ? 'must pass' : 'must fail: ' + m.expect}`);
    rmSync(dir, { recursive: true, force: true });
  }
  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const rows = await runMutants(process.argv.slice(2));
  const bad = rows.filter((r) => !r.ok);
  for (const r of bad) console.log(`\n--- ${r.name} (exit ${r.code}) ---\n` + r.out.split('\n').slice(-40).join('\n'));
  console.log(`\n${rows.length - bad.length}/${rows.length} as expected, ${Math.round(rows.reduce((s, r) => s + r.ms, 0) / 1000)} s`);
  process.exit(bad.length ? 1 : 0);
}
