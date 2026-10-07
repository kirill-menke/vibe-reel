#!/usr/bin/env node
/* types/check-ratchet.mjs — the type-check lane's gate. Type-only tooling: nothing
 * here is imported by the app or reaches a bundle.
 *
 *   node types/check-ratchet.mjs              both projects (TV + phone)
 *   node types/check-ratchet.mjs --only tv    one project (tv | phone)
 *   node types/check-ratchet.mjs --list       also print every diagnostic
 *   node types/check-ratchet.mjs --update     lower the ceilings in ratchet.json to the
 *                                             current counts (never raises them)
 *
 * Projects (svelte-check, checkJs, errors AND warnings count the same — this is
 * `--fail-on-warnings` with a ceiling instead of zero):
 *   tv     jsconfig.json         src/ (+ types/tests/tv)
 *   phone  phone/jsconfig.json   phone/src (+ types/tests/phone), with the phone build's
 *                                module redirects mapped as `paths`. TypeScript cannot
 *                                redirect *relative* imports, so src/lib's own
 *                                `./nav.svelte.js` etc. are typed against the TV modules
 *                                in both projects; types/tests/phone/module-redirects.js
 *                                guards the shims' export lists instead.
 *   A diagnostic the phone run reports outside phone/ (in src/lib, reached through $lib)
 *   is the TV project's — unless the TV run does not have it, then it counts for phone.
 *
 * Fails when:
 *   - a project's diagnostic count is above its ceiling (types/ratchet.json `max`), or
 *     BELOW it (a stale ceiling: run --update and commit, so the gain is locked in);
 *   - a path listed under `strict.<flag>` has any diagnostic with that compiler flag on
 *     (the per-directory strictness ratchet; lists may only grow);
 *   - suppressions: any `@ts-nocheck` in src/, phone/src or types/; any `@ts-ignore` /
 *     `@ts-expect-error` without a reason (>= 3 words after it); more of them in
 *     src/ + phone/src than `max.suppressions` (types/tests use @ts-expect-error as
 *     negative assertions — reason required, not counted);
 *   - `lang="ts"` in any .svelte, or a .ts (non-.d.ts) file under src/ or phone/src;
 *   - a config lost a compiler flag its strictness floor lists (types/ratchet.json `config.<project>`,
 *     e.g. `strict` for tv; lists may only grow), or switches a member of `strict` off explicitly;
 *   - a config lost checkJs/allowJs, or excludes more than its allowed list, or a
 *     src/ / phone/src .js file is not part of its project (tsc --listFilesOnly).
 *
 * The final goal of the lane is all ceilings at 0, i.e. plain
 * `svelte-check --fail-on-warnings` passing for both configs. */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = (n) => path.join(repo, 'node_modules', '.bin', n);
const RATCHET = path.join(repo, 'types', 'ratchet.json');
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const LIST = args.includes('--list');
const UPDATE = args.includes('--update');

const PROJECTS = {
  tv: { config: 'jsconfig.json', owns: (f) => !f.startsWith('phone/') && !f.startsWith('types/tests/phone/'),
        exclude: ['src/vendor/libpgs.js'], mustInclude: ['src/**/*.js', 'src/**/*.svelte'], jsRoot: 'src' },
  phone: { config: 'phone/jsconfig.json', owns: (f) => f.startsWith('phone/') || f.startsWith('types/tests/phone/'),
        exclude: ['dist', 'dev', 'public', 'scripts'], mustInclude: ['src/**/*.js', 'src/**/*.svelte'], jsRoot: 'phone/src' }
};
const STRICT_FLAGS = ['noImplicitAny', 'strictNullChecks', 'strict'];
const STRICT_MEMBERS = ['noImplicitAny', 'noImplicitThis', 'alwaysStrict', 'strictNullChecks', 'strictFunctionTypes',
  'strictBindCallApply', 'strictPropertyInitialization', 'useUnknownInCatchVariables', 'strictBuiltinIteratorReturn'];
let ratchetFloor = null;

let failed = false;
const fail = (msg) => { failed = true; console.log('FAIL ' + msg); };
const ok = (msg) => console.log('ok   ' + msg);

/* ---------- svelte-check ---------- */
function svelteCheck(config) {
  const r = spawnSync(bin('svelte-check'), ['--workspace', repo, '--tsconfig', config, '--output', 'machine'],
    { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20 });
  const out = (r.stdout || '') + (r.stderr || '');
  const diags = [];
  let completed = false;
  for (const line of out.split('\n')) {
    const m = line.match(/^\d+ (ERROR|WARNING) "([^"]+)" (\d+):(\d+) (".*")$/);
    if (m) {
      let msg = m[5];
      try { msg = JSON.parse(m[5]); } catch {}
      const file = path.relative(repo, path.resolve(repo, m[2])).split(path.sep).join('/');
      diags.push({ level: m[1], file, line: +m[3], col: +m[4], msg, key: `${file}:${m[3]}:${m[4]}:${msg}` });
    } else if (/^\d+ COMPLETED /.test(line)) completed = true;
  }
  if (!completed) {
    console.log(out.slice(-3000));
    throw new Error(`svelte-check did not complete for ${config}`);
  }
  return diags;
}

const fmt = (d) => `  ${d.file}:${d.line}:${d.col} ${d.level} ${String(d.msg).split('\n')[0]}`;

/* ---------- configs ---------- */
function readJson(p) {
  return JSON.parse(readFileSync(path.join(repo, p), 'utf8'));
}

function checkConfig(name, p) {
  const c = readJson(p.config);
  const o = c.compilerOptions || {};
  if (o.checkJs !== true || o.allowJs !== true) fail(`${p.config}: checkJs and allowJs must be true`);
  if (o.noCheck) fail(`${p.config}: noCheck is not allowed`);
  for (const g of p.mustInclude) if (!(c.include || []).includes(g)) fail(`${p.config}: include must contain ${g}`);
  const extra = (c.exclude || []).filter((e) => !p.exclude.includes(e));
  if (extra.length) fail(`${p.config}: exclude may only list ${p.exclude.join(', ')} (found ${extra.join(', ')})`);
  // the config's strictness floor (ratchet.json `config.<project>`): every listed flag stays true. A floor of
  // `strict` also forbids switching one of its member flags off explicitly (that would override it).
  const floor = (ratchetFloor || {})[name] || [];
  for (const flag of floor) {
    if (o[flag] !== true) fail(`${p.config}: ${flag} must stay true (ratchet.json config.${name})`);
    if (flag === 'strict') for (const m of STRICT_MEMBERS) if (o[m] === false) fail(`${p.config}: ${m}: false would override strict: true`);
  }
  // every .js under the project's root is in the program
  const r = spawnSync(bin('tsc'), ['-p', p.config, '--listFilesOnly'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20 });
  const listed = new Set((r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean)
    .map((f) => path.relative(repo, path.resolve(repo, f)).split(path.sep).join('/')));
  const missing = walk(path.join(repo, p.jsRoot)).filter((f) => f.endsWith('.js') && f !== 'src/vendor/libpgs.js' && !listed.has(f));
  if (missing.length) fail(`${name}: .js files not in the ${p.config} program: ${missing.slice(0, 5).join(', ')}`);
  return o;
}

function walk(dir) {
  const res = [];
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== 'node_modules' && f !== 'dist') res.push(...walk(p)); }
    else res.push(path.relative(repo, p).split(path.sep).join('/'));
  }
  return res;
}

/* ---------- source rules ---------- */
function sourceRules(ratchet) {
  let counted = 0;
  const files = [...walk(path.join(repo, 'src')), ...walk(path.join(repo, 'phone/src')), ...walk(path.join(repo, 'types'))]
    .filter((f) => /\.(js|mjs|svelte|ts)$/.test(f) && f !== 'src/vendor/libpgs.js' && f !== 'types/check-ratchet.mjs');
  for (const f of files) {
    if (/\.ts$/.test(f) && !/\.d\.ts$/.test(f) && !f.startsWith('types/')) fail(`${f}: no .ts sources — JSDoc in .js only`);
    const text = readFileSync(path.join(repo, f), 'utf8');
    if (f.endsWith('.svelte') && /<script\b[^>]*\blang\s*=\s*["']?ts/.test(text)) fail(`${f}: lang="ts" is not allowed`);
    text.split('\n').forEach((line, i) => {
      if (/@ts-nocheck/.test(line)) fail(`${f}:${i + 1}: @ts-nocheck is not allowed`);
      const m = line.match(/@ts-(ignore|expect-error)\b(.*)$/);
      if (!m) return;
      const reason = m[2].replace(/\*\/.*$|-->.*$/, '').replace(/^[\s:—–-]+/, '').trim();
      if (reason.split(/\s+/).filter(Boolean).length < 3) fail(`${f}:${i + 1}: @ts-${m[1]} needs a reason (>= 3 words)`);
      if (!f.startsWith('types/tests/')) counted++;
    });
  }
  const max = ratchet.max.suppressions;
  if (counted > max) fail(`suppressions: ${counted} @ts-ignore/@ts-expect-error in src/ + phone/src, ceiling ${max}`);
  else if (counted < max && !UPDATE) fail(`suppressions: ${counted} < ceiling ${max} — run --update and commit the lower ceiling`);
  else ok(`suppressions: ${counted} (ceiling ${max})`);
  return counted;
}

/* ---------- strict ratchet ---------- */
function strictPasses(ratchet) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'vr-strict-'));
  try {
    for (const [flag, paths] of Object.entries(ratchet.strict || {})) {
      if (!STRICT_FLAGS.includes(flag)) { fail(`ratchet.json strict.${flag}: unknown flag`); continue; }
      if (!paths.length) continue;
      for (const [name, p] of Object.entries(PROJECTS)) {
        if (only && only !== name) continue;
        const mine = paths.filter((q) => p.owns(q));
        if (!mine.length) continue;
        const cfg = path.join(tmp, `${name}.${flag}.json`);
        writeFileSync(cfg, JSON.stringify({ extends: path.join(repo, p.config), compilerOptions: { [flag]: true } }));
        const covered = (f) => mine.some((q) => (q.endsWith('/') ? f.startsWith(q) : f === q));
        const bad = svelteCheck(cfg).filter((d) => covered(d.file));
        if (bad.length) { fail(`strict.${flag} (${name}): ${bad.length} diagnostics in covered paths`); bad.slice(0, 30).forEach((d) => console.log(fmt(d))); }
        else ok(`strict.${flag} (${name}): ${mine.length} paths clean`);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* ---------- main ---------- */
const ratchet = JSON.parse(readFileSync(RATCHET, 'utf8'));
ratchetFloor = ratchet.config || null;
for (const [name, flags] of Object.entries(ratchetFloor || {}))
  for (const f of flags) if (!PROJECTS[name] || !STRICT_MEMBERS.concat('strict').includes(f)) fail(`ratchet.json config.${name}: unknown project or flag ${f}`);
for (const [name, p] of Object.entries(PROJECTS)) if (!only || only === name) checkConfig(name, p);
if (only && !PROJECTS[only]) throw new Error('--only tv|phone');

const runs = {};
for (const name of Object.keys(PROJECTS)) if (!only || only === name) runs[name] = svelteCheck(PROJECTS[name].config);

const counts = {};
const tvKeys = runs.tv ? new Set(runs.tv.map((d) => d.key)) : null;
for (const [name, diags] of Object.entries(runs)) {
  let mine = diags.filter((d) => PROJECTS[name].owns(d.file));
  if (name === 'phone') {
    // src/lib diagnostics reached from phone code: the TV project's, unless only the phone run has them
    const foreign = diags.filter((d) => !PROJECTS.phone.owns(d.file));
    const extra = tvKeys ? foreign.filter((d) => !tvKeys.has(d.key)) : [];
    if (extra.length) console.log(`note phone: ${extra.length} diagnostics outside phone/ that the TV run lacks (counted for phone)`);
    mine = mine.concat(extra);
  }
  const uniq = [...new Map(mine.map((d) => [d.key, d])).values()];
  counts[name] = uniq.length;
  const e = uniq.filter((d) => d.level === 'ERROR').length;
  const max = ratchet.max[name];
  const label = `${name}: ${uniq.length} diagnostics (${e} errors, ${uniq.length - e} warnings), ceiling ${max}`;
  if (uniq.length > max) { fail(label); uniq.slice(0, LIST ? Infinity : 40).forEach((d) => console.log(fmt(d))); }
  else if (uniq.length < max && !UPDATE) fail(label + ' — stale ceiling: run --update and commit it');
  else ok(label);
  if (LIST && uniq.length <= max) uniq.forEach((d) => console.log(fmt(d)));
}

const supp = sourceRules(ratchet);
strictPasses(ratchet);

if (UPDATE) {
  let changed = false;
  for (const [name, n] of Object.entries(counts)) if (n < ratchet.max[name]) { ratchet.max[name] = n; changed = true; }
  if (!only && supp < ratchet.max.suppressions) { ratchet.max.suppressions = supp; changed = true; }
  if (changed) { writeFileSync(RATCHET, JSON.stringify(ratchet, null, 2) + '\n'); console.log('updated types/ratchet.json (ceilings lowered) — commit it'); }
}

console.log(failed ? 'RATCHET FAIL' : `RATCHET PASS (tv ${counts.tv ?? '-'}, phone ${counts.phone ?? '-'}, suppressions ${supp})`);
process.exit(failed ? 1 : 0);
