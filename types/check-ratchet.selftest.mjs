#!/usr/bin/env node
/* types/check-ratchet.selftest.mjs — proves that every rule of types/check-ratchet.mjs fires.
 * Type-only tooling: nothing here is imported by the app or reaches a bundle.
 *
 *   node types/check-ratchet.selftest.mjs
 *
 * Each case builds a throwaway mini-repo under the OS temp dir — a verbatim copy of
 * check-ratchet.mjs (it derives `repo` from its own location, so the copy checks the fixture,
 * never src/ or phone/src), a symlink to this repo's node_modules (svelte-check, tsc, svelte),
 * two jsconfigs shaped like the real ones, a few clean source files and a ratchet.json with
 * every ceiling at 0 — applies one mutation, runs the copy and asserts its exit code and the
 * FAIL line it must print. The unmutated fixture must PASS, so a rule that fires on everything
 * is caught too. Exit 0 = every case behaved. */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* The suppression markers are spelt in two pieces here: check-ratchet.mjs scans types/ too,
 * and a literal one in this file would count against the real repo. */
const AT = '@' + 'ts-';
const SCRIPT = readFileSync(path.join(repo, 'types', 'check-ratchet.mjs'), 'utf8');

const OPTIONS = {
  target: 'es2022', module: 'esnext', moduleResolution: 'bundler', lib: ['es2022', 'dom', 'dom.iterable'],
  allowJs: true, checkJs: true, noEmit: true, strict: false, skipLibCheck: true, types: ['svelte']
};
const BASE = {
  'jsconfig.json': { compilerOptions: OPTIONS, include: ['src/**/*.js', 'src/**/*.svelte'], exclude: ['src/vendor/libpgs.js'] },
  'phone/jsconfig.json': { compilerOptions: OPTIONS, include: ['src/**/*.js', 'src/**/*.svelte'], exclude: ['dist'] },
  'types/ratchet.json': { max: { tv: 0, phone: 0, suppressions: 0 }, strict: {} },
  'src/lib/a.js': '/** @param {number} n @returns {number} */\nexport function twice(n) {\n  return n * 2;\n}\n',
  'src/App.svelte': '<script>\n  import { twice } from \'./lib/a.js\';\n  let n = $state(1);\n</script>\n\n<p>{twice(n)}</p>\n',
  'phone/src/p.js': 'export const p = 1;\n',
  'phone/src/P.svelte': '<script>\n  import { p } from \'./p.js\';\n</script>\n\n<p>{p}</p>\n'
};

/** @param {string} dir @param {string} rel @param {string | object} body */
function put(dir, rel, body) {
  const f = path.join(dir, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n');
}

/** @param {(dir: string, files: Record<string, any>) => void} [mutate] @returns {string} */
function fixture(mutate) {
  const dir = mkdtempSync(path.join(tmpdir(), 'vr-ratchet-selftest-'));
  const files = structuredClone(BASE);
  if (mutate) mutate(dir, files);
  for (const [rel, body] of Object.entries(files)) put(dir, rel, body);
  put(dir, 'types/check-ratchet.mjs', SCRIPT);
  symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

/** @param {string} dir @param {string[]} args @returns {Promise<{ code: number | null, out: string }>} */
function run(dir, args) {
  return new Promise((resolve) => {
    const ch = spawn(process.execPath, [path.join(dir, 'types', 'check-ratchet.mjs'), ...args], { cwd: dir });
    let out = '';
    ch.stdout.on('data', (b) => (out += b));
    ch.stderr.on('data', (b) => (out += b));
    ch.on('close', (code) => resolve({ code, out }));
  });
}

/** @typedef {{ name: string, args?: string[], mutate?: (dir: string, files: Record<string, any>) => void,
 *   code: number, expect: RegExp, after?: (dir: string) => string | null }} Case */
/** @type {Case[]} */
const CASES = [
  { name: 'clean fixture passes', code: 0, expect: /RATCHET PASS \(tv 0, phone 0, suppressions 0\)/ },
  {
    name: 'count above ceiling',
    args: ['--only', 'tv'],
    mutate: (d, f) => { f['src/lib/bad.js'] = 'export const n = 1;\nn.nope();\n'; },
    code: 1, expect: /FAIL tv: 1 diagnostics \(1 errors, 0 warnings\), ceiling 0/
  },
  {
    name: 'phone count above ceiling',
    mutate: (d, f) => { f['phone/src/bad.js'] = 'export const n = 1;\nn.nope();\n'; },
    code: 1, expect: /FAIL phone: 1 diagnostics/
  },
  {
    name: '--update never raises a ceiling',
    args: ['--only', 'tv', '--update'],
    mutate: (d, f) => { f['src/lib/bad.js'] = 'export const n = 1;\nn.nope();\n'; },
    code: 1, expect: /FAIL tv: 1 diagnostics/,
    after: (d) => (JSON.parse(readFileSync(path.join(d, 'types/ratchet.json'), 'utf8')).max.tv === 0 ? null : 'ceiling was raised')
  },
  {
    name: 'stale ceiling',
    args: ['--only', 'tv'],
    mutate: (d, f) => { f['types/ratchet.json'].max.tv = 3; },
    code: 1, expect: /FAIL tv: 0 diagnostics .*stale ceiling/
  },
  {
    name: '--update lowers a stale ceiling',
    args: ['--only', 'tv', '--update'],
    mutate: (d, f) => { f['types/ratchet.json'].max.tv = 3; },
    code: 0, expect: /updated types\/ratchet\.json/,
    after: (d) => (JSON.parse(readFileSync(path.join(d, 'types/ratchet.json'), 'utf8')).max.tv === 0 ? null : 'ceiling not lowered')
  },
  {
    name: 'strict-path diagnostic',
    args: ['--only', 'tv'],
    mutate: (d, f) => {
      f['src/lib/loose.js'] = 'export function id(a) {\n  return a;\n}\n';
      f['types/ratchet.json'].strict = { noImplicitAny: ['src/lib/'] };
    },
    code: 1, expect: /FAIL strict\.noImplicitAny \(tv\): 1 diagnostics in covered paths/
  },
  {
    name: 'strict list: a path outside it is not held to the flag',
    args: ['--only', 'tv'],
    mutate: (d, f) => {
      f['src/loose.js'] = 'export function id(a) {\n  return a;\n}\n';
      f['types/ratchet.json'].strict = { noImplicitAny: ['src/lib/'] };
    },
    code: 0, expect: /ok {3}strict\.noImplicitAny \(tv\): 1 paths clean/
  },
  {
    name: 'config floor: a listed flag switched off',
    args: ['--only', 'tv'],
    mutate: (d, f) => { f['types/ratchet.json'].config = { tv: ['strict'] }; },
    code: 1, expect: /FAIL jsconfig\.json: strict must stay true \(ratchet\.json config\.tv\)/
  },
  {
    name: 'config floor: strict with a member flag switched off',
    args: ['--only', 'tv'],
    mutate: (d, f) => {
      f['types/ratchet.json'].config = { tv: ['strict'] };
      f['jsconfig.json'].compilerOptions = { ...f['jsconfig.json'].compilerOptions, strict: true, strictNullChecks: false };
    },
    code: 1, expect: /FAIL jsconfig\.json: strictNullChecks: false would override strict: true/
  },
  {
    name: 'config floor met',
    args: ['--only', 'phone'],
    mutate: (d, f) => {
      f['types/ratchet.json'].config = { phone: ['noImplicitAny'] };
      f['phone/jsconfig.json'].compilerOptions = { ...f['phone/jsconfig.json'].compilerOptions, noImplicitAny: true };
    },
    code: 0, expect: /RATCHET PASS \(tv -, phone 0, suppressions 0\)/
  },
  {
    name: 'unknown strict flag',
    args: ['--only', 'tv'],
    mutate: (d, f) => { f['types/ratchet.json'].strict = { noUnusedLocals: ['src/'] }; },
    code: 1, expect: /FAIL ratchet\.json strict\.noUnusedLocals: unknown flag/
  },
  {
    name: 'suppression without a reason',
    args: ['--only', 'tv'],
    mutate: (d, f) => { f['src/lib/s.js'] = '// ' + AT + 'ignore\nexport const s = 1;\n'; },
    code: 1, expect: /FAIL src\/lib\/s\.js:1: @ts[-]ignore needs a reason/
  },
  {
    name: 'expect-error with a two-word reason',
    args: ['--only', 'tv'],
    mutate: (d, f) => { f['src/lib/s.js'] = 'export const n = 1;\n// ' + AT + 'expect-error not callable\nn();\n'; },
    code: 1, expect: /FAIL src\/lib\/s\.js:2: @ts[-]expect-error needs a reason/
  },
  {
    name: 'suppressions above their ceiling',
    args: ['--only', 'tv'],
    mutate: (d, f) => { f['src/lib/s.js'] = '// ' + AT + 'ignore the fixture needs one\nexport const s = 1;\n'; },
    code: 1, expect: /FAIL suppressions: 1 @ts[-]ignore\/@ts[-]expect-error in src\/ \+ phone\/src, ceiling 0/
  },
  {
    name: 'a reasoned expect-error in types/tests is not counted',
    args: ['--only', 'tv'],
    mutate: (d, f) => {
      f['jsconfig.json'].include.push('types/tests/tv/**/*.js');
      f['types/tests/tv/t.js'] = 'export const n = 1;\n// ' + AT + 'expect-error a number is not callable\nn();\n';
    },
    code: 0, expect: /ok {3}suppressions: 0 \(ceiling 0\)/
  },
  {
    name: 'nocheck',
    args: ['--only', 'tv'],
    mutate: (d, f) => { f['phone/src/n.js'] = '// ' + AT + 'nocheck\nexport const q = 1;\n'; },
    code: 1, expect: /FAIL phone\/src\/n\.js:1: @ts[-]nocheck is not allowed/
  },
  {
    name: 'lang="ts"',
    args: ['--only', 'tv'],
    mutate: (d, f) => { f['src/T.svelte'] = '<script lang="ts">\n  let a: number = 1;\n</script>\n\n<p>{a}</p>\n'; },
    code: 1, expect: /FAIL src\/T\.svelte: lang="ts" is not allowed/
  },
  {
    name: 'a .ts source file',
    args: ['--only', 'tv'],
    mutate: (d, f) => { f['src/lib/x.ts'] = 'export const x: number = 1;\n'; },
    code: 1, expect: /FAIL src\/lib\/x\.ts: no \.ts sources/
  },
  {
    name: 'config with checkJs off',
    args: ['--only', 'tv'],
    mutate: (d, f) => { f['jsconfig.json'].compilerOptions.checkJs = false; },
    code: 1, expect: /FAIL jsconfig\.json: checkJs and allowJs must be true/
  },
  {
    name: 'config with noCheck',
    args: ['--only', 'phone'],
    mutate: (d, f) => { f['phone/jsconfig.json'].compilerOptions.noCheck = true; },
    code: 1, expect: /FAIL phone\/jsconfig\.json: noCheck is not allowed/
  },
  {
    name: 'config with an extra exclude',
    args: ['--only', 'tv'],
    mutate: (d, f) => { f['jsconfig.json'].exclude.push('src/lib/**'); },
    code: 1, expect: /FAIL jsconfig\.json: exclude may only list src\/vendor\/libpgs\.js \(found src\/lib\/\*\*\)/
  },
  {
    name: 'config lost a required include',
    args: ['--only', 'phone'],
    mutate: (d, f) => { f['phone/jsconfig.json'].include = ['src/**/*.js']; },
    code: 1, expect: /FAIL phone\/jsconfig\.json: include must contain src\/\*\*\/\*\.svelte/
  },
  {
    name: 'a src .js missing from the program',
    args: ['--only', 'tv'],
    // the include globs stay as required, but tsc's wildcards skip dot-directories:
    // src/.cache/c.js is a source file the program never sees
    mutate: (d, f) => { f['src/.cache/c.js'] = 'export const c = 1;\n'; },
    code: 1, expect: /FAIL tv: \.js files not in the jsconfig\.json program: src\/\.cache\/c\.js/
  }
];

let bad = 0;
/** @param {Case} c */
async function one(c) {
  const dir = fixture(c.mutate);
  try {
    const r = await run(dir, c.args || []);
    const why = [];
    if (r.code !== c.code) why.push(`exit ${r.code}, expected ${c.code}`);
    if (!c.expect.test(r.out)) why.push(`output lacks ${c.expect}`);
    const extra = c.after?.(dir);
    if (extra) why.push(extra);
    if (why.length) {
      bad++;
      console.log(`FAIL ${c.name}: ${why.join('; ')}\n${r.out.split('\n').map((l) => '     | ' + l).join('\n')}`);
    } else console.log(`ok   ${c.name}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// a few at a time: each case is two svelte-check + tsc runs over a tiny fixture
const queue = [...CASES];
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let c; (c = queue.shift()); ) await one(c);
}));
console.log(bad ? `SELFTEST FAIL (${bad} of ${CASES.length})` : `SELFTEST PASS (${CASES.length} cases)`);
process.exit(bad ? 1 : 0);
