#!/usr/bin/env node
/* VibeReel end-to-end run: fake Jellyfin 12.1 + reel-api, both apps built
 * against it, headless Chrome over raw CDP, every scenario in e2e/scenarios/.
 *
 *   node e2e/run.mjs                 everything (LANE_TEST)
 *   node e2e/run.mjs --fast          the smoke subset (tests with fast: true)
 *   node e2e/run.mjs --grep login    tests whose name matches /login/i
 *   node e2e/run.mjs --list          list tests, run nothing
 *   node e2e/run.mjs --jobs N        N parallel workers (default E2E_JOBS, else
 *                                    min(3, cores/4)); --jobs 1 = in-process
 *   E2E_VERBOSE=1                    print each test's t.log() lines
 *   --tv-src DIR                     build the TV app from another source tree
 *                                    (a mutant copy, scripts/mutants.mjs); implies
 *                                    --jobs 1 and no timings update
 *   --build-dir DIR / --out-dir DIR  where builds + ports / failure artifacts go
 *   --update-baselines               rewrite e2e/baselines/*.png from this run
 *                                    (lib/visual.mjs; never done implicitly)
 *   --repeat N                       flake check: run every selected test N times
 *                                    (each run a fresh world + page) and report
 *                                    per-test pass counts; exit 0 only if all N/N
 *
 * Parallel workers: each is a child process of this script (--worker k) with
 * its own fake server on its own ports, its own builds in e2e/.build/w<k>/
 * (the ports are baked into the bundles; cached by content hash + ports, which
 * a worker remembers in its ports.json) and its own Chrome. The parent hands
 * out tests one at a time, longest first (durations of the last run, in
 * e2e/.build/timings.json), and prints each test's buffered output in the
 * registry order, so the report reads the same whatever the interleaving.
 *
 * Exit 0 only if every selected test passed, the network guard saw nothing,
 * and at least one test ran. Artifacts of failures: e2e/.out/; the run's
 * record (per test ok/ms/failures, totals, spec, deviations): e2e/.out/summary.json. */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fork } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFakeServer } from './server/index.mjs';
import { loadSpec, SPEC_FILE } from './server/spec.mjs';
import { ensureMedia } from './server/media.mjs';
import { ensureReelSpec, WARM_HINT } from './scripts/reelapi-spec.mjs';
import { buildApps, BUILD_DIR, REPO } from './lib/build.mjs';
import { launchChrome } from './lib/chrome.mjs';
import { tests, runAll, setCurrentFile, routeTemplates } from './lib/runner.mjs';

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
const fast = flag('--fast');
const grep = opt('--grep');
const workerId = opt('--worker'); // internal: this process is parallel worker k
const tvSrc = opt('--tv-src') ? path.resolve(opt('--tv-src')) : null;
const buildDirOpt = opt('--build-dir') ? path.resolve(opt('--build-dir')) : null;
if (flag('--update-baselines')) process.env.E2E_UPDATE_BASELINES = '1'; // workers inherit it
const repeat = Math.max(1, Number(opt('--repeat') || 1) || 1);
const t0 = Date.now();

const scenDir = path.join(REPO, 'e2e', 'scenarios');
for (const f of readdirSync(scenDir).filter((f) => f.endsWith('.test.mjs')).sort()) {
  setCurrentFile(f);
  await import(pathToFileURL(path.join(scenDir, f)).href);
}

const outDir = opt('--out-dir') ? path.resolve(opt('--out-dir')) : path.join(REPO, 'e2e', '.out');
const runDir = existsSync(path.join(REPO, 'run')) ? path.join(REPO, 'run', '.e2e') : path.join(outDir, 'chrome');
const TIMINGS = path.join(BUILD_DIR, 'timings.json');

/* ------------------------------------------------------------------ */

/* fake server + builds + Chrome, for the in-process run or one worker */
async function setup({ buildDir, needBrowser, log }) {
  mkdirSync(runDir, { recursive: true });
  mkdirSync(buildDir, { recursive: true });
  const portsFile = path.join(buildDir, 'ports.json');
  let ports = {};
  try {
    ports = JSON.parse(readFileSync(portsFile, 'utf8'));
  } catch {}
  const env = { srv: null, browser: null };
  env.srv = await startFakeServer({ ports, tvDir: path.join(buildDir, 'tv'), phoneDir: path.join(buildDir, 'phone') });
  writeFileSync(portsFile, JSON.stringify(env.srv.ports));
  log('fake server: ' + Object.entries(env.srv.urls).map(([k, v]) => k + '=' + v.replace('http://127.0.0.1', '')).join(' '));
  if (!env.srv.media.webm) log('note: no fixture video — ' + env.srv.media.error);
  if (needBrowser) {
    await buildApps({ jf: env.srv.urls.jf, ml: env.srv.urls.ml, log, dir: buildDir, ...(tvSrc ? { tvRoot: tvSrc } : {}) });
    env.browser = await launchChrome({ runDir, allowPorts: Object.values(env.srv.ports), picUrl: env.srv.urls.pic, headless: !flag('--headed') });
  }
  return env;
}

function selectTests() {
  return tests.filter((t) => (!fast || t.opts.fast) && (!grep || new RegExp(grep, 'i').test(t.name)));
}

/* --repeat N: each test N times in a row (copies carry rep = 1..N; the
 * runner prints the run number, the summary counts passes per test) */
function expand(list) {
  if (repeat === 1) return list;
  return list.flatMap((t) => Array.from({ length: repeat }, (_, k) => ({ ...t, rep: k + 1, reps: repeat })));
}

const needsBrowser = (list) => list.some((t) => t.opts.app !== 'none' || t.opts.browser);

function defaultJobs() {
  if (process.env.E2E_JOBS) return Number(process.env.E2E_JOBS);
  const cores = os.availableParallelism?.() || os.cpus().length;
  return Math.max(1, Math.min(3, Math.floor(cores / 4)));
}

async function main() {
  const list = selectTests();
  if (flag('--list')) {
    for (const t of list) console.log(`${t.opts.fast ? '*' : ' '} [${t.opts.app}] ${t.name}  (${t.file})`);
    process.exit(0);
  }
  if (!list.length) {
    console.error('no tests selected');
    process.exit(1);
  }
  const runs = expand(list);
  const jobs = tvSrc ? 1 : Math.max(1, Math.min(Number(opt('--jobs') || defaultJobs()) || 1, runs.length));

  const spec = loadSpec();
  console.log(spec ? `spec: Jellyfin ${spec.version} OpenAPI — every Jellyfin request is validated` : `spec: ABSENT (${path.relative(REPO, SPEC_FILE)}) — request validation SKIPPED; run node e2e/scripts/fetch-spec.mjs`);
  const reel = ensureReelSpec({ log: (m) => console.log(m) });
  if (reel.ok) console.log("reel-api spec: the backend's own OpenAPI (+ documented shapes) — every reel-api request and every fake reel-api response is validated");
  else if (process.env.E2E_ALLOW_NO_REEL_SPEC === '1') console.log(`reel-api spec: SKIPPED by E2E_ALLOW_NO_REEL_SPEC=1 (${reel.reason}) — reel-api contract check NOT run`);
  else {
    // A run without the contract would pass while the fake reel-api drifts from models.py.
    console.error(`reel-api spec: FAIL — ${reel.reason}\n  ${WARM_HINT}, or set E2E_ALLOW_NO_REEL_SPEC=1 to run without the contract check`);
    process.exit(1);
  }
  mkdirSync(BUILD_DIR, { recursive: true });

  let code = 1;
  let cleanup = async () => {};
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, async () => {
      console.error('\n' + sig + ': cleaning up');
      await cleanup();
      process.exit(130);
    });
  }
  const hard = setTimeout(async () => {
    console.error('e2e run exceeded its hard timeout');
    await cleanup();
    process.exit(124);
  }, Number(process.env.E2E_TIMEOUT || 20 * 60 * 1000));
  hard.unref();

  try {
    const r = jobs === 1 ? await runInProcess(runs, (c) => (cleanup = c)) : await runParallel(runs, jobs, (c) => (cleanup = c));
    if (!tvSrc && repeat === 1) saveTimings(r.results);
    code = summary(r, spec, reel);
  } catch (e) {
    console.error('e2e harness error:', e.stack || e);
    code = 1;
  } finally {
    await cleanup();
  }
  process.exit(code);
}

async function runInProcess(list, setCleanup) {
  let env = { srv: null, browser: null };
  let cleaning = null;
  setCleanup(() => {
    if (cleaning) return cleaning;
    cleaning = (async () => {
      if (env.browser) await env.browser.close().catch(() => {});
      if (env.srv) await env.srv.close().catch(() => {});
    })();
    return cleaning;
  });
  env = await setup({ buildDir: buildDirOpt || BUILD_DIR, needBrowser: needsBrowser(list), log: (m) => console.log(m) });
  const results = await runAll({ list, srv: env.srv, browser: env.browser, outDir });
  const g = env.browser?.guard;
  return { results, guard: { proxyHits: g ? g.proxyHits.slice() : [], browserNoise: g ? g.browserNoise.length : 0 }, jobs: 1, allRoutes: routeTemplates(env.srv) };
}

/* longest first (last run's durations), unknown ones first of all */
function scheduleOrder(list) {
  let tm = {};
  try {
    tm = JSON.parse(readFileSync(TIMINGS, 'utf8'));
  } catch {}
  return list.map((t, i) => ({ t, i, ms: tm[t.name] ?? Infinity })).sort((a, b) => b.ms - a.ms || a.i - b.i);
}

function saveTimings(results) {
  let tm = {};
  try {
    tm = JSON.parse(readFileSync(TIMINGS, 'utf8'));
  } catch {}
  for (const r of results) tm[r.name] = r.ms;
  try {
    writeFileSync(TIMINGS, JSON.stringify(tm, null, 1));
  } catch {}
}

async function runParallel(list, jobs, setCleanup) {
  // shared, generated-once inputs before the workers race for them
  ensureMedia();
  const queue = scheduleOrder(list);
  const results = new Array(list.length);
  const printed = { next: 0 };
  const outputs = new Array(list.length);
  const guard = { proxyHits: [], browserNoise: 0 };
  let allRoutes = [];
  const workers = [];

  const flush = () => {
    while (printed.next < list.length && outputs[printed.next]) {
      for (const l of outputs[printed.next]) console.log(l);
      printed.next++;
    }
  };
  const record = (i, result, lines) => {
    if (results[i]) return;
    results[i] = result;
    outputs[i] = lines;
    flush();
  };

  setCleanup(async () => {
    for (const w of workers) if (w.proc.exitCode === null) w.proc.kill('SIGTERM');
    await Promise.all(workers.map((w) => w.exited));
  });

  const passArgs = flag('--headed') ? ['--headed'] : [];
  await new Promise((resolveAll) => {
    let alive = jobs;
    const idle = []; // workers waiting while only reps of running tests are left
    /* never two runs of one test at once (--repeat): a test may own shared
     * paths (90-mutants' scratch copies), and the gate runs it alone too */
    const running = () => new Set(workers.filter((x) => x.current != null).map((x) => list[x.current].name));
    const dispatch = (w) => {
      const busy = running();
      const at = queue.findIndex((q) => !busy.has(q.t.name));
      if (at < 0) {
        if (!queue.length) w.proc.send({ type: 'exit' });
        else idle.push(w);
        return;
      }
      const [next] = queue.splice(at, 1);
      w.current = next.i;
      w.proc.send({ type: 'run', name: next.t.name, rep: next.t.rep, reps: next.t.reps });
    };
    for (let k = 1; k <= jobs; k++) {
      const proc = fork(process.argv[1], ['--worker', String(k), ...passArgs], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, E2E_NEED_BROWSER: needsBrowser(list) ? '1' : '' } });
      const w = { k, proc, current: null, setupLog: [], stderr: '' };
      w.exited = new Promise((r) => proc.on('exit', r));
      proc.stdout.on('data', (d) => w.setupLog.push(String(d)));
      proc.stderr.on('data', (d) => (w.stderr = (w.stderr + d).slice(-4000)));
      proc.on('message', (m) => {
        if (m.type === 'ready') {
          w.readySeen = true;
          console.log(`worker ${k}: ${m.lines.join(' | ')}`);
          dispatch(w);
        } else if (m.type === 'done') {
          const i = w.current;
          w.current = null;
          record(i, m.result, m.lines);
          dispatch(w);
          for (const x of idle.splice(0)) dispatch(x); // a rep they waited for may be free now
        } else if (m.type === 'guard') {
          guard.proxyHits.push(...m.proxyHits);
          guard.browserNoise += m.browserNoise;
          if (m.allRoutes) allRoutes = m.allRoutes;
        }
      });
      proc.on('exit', (code, sig) => {
        if (w.current != null) {
          const tc = list[w.current];
          const msg = `worker ${k} died (${sig || 'exit ' + code}) while running this test: ${w.stderr.slice(-1500)}`;
          record(w.current, { name: tc.name, ok: false, ms: 0, failures: [msg], notes: [], known: [] }, [`FAIL ${tc.name} (worker died)`, '     ' + msg.split('\n').slice(0, 8).join('\n       ')]);
          w.current = null;
          for (const x of idle.splice(0)) if (x !== w && x.proc.exitCode === null) dispatch(x);
        }
        if (--alive === 0) {
          // anything never handed out (every worker died before it): failed
          for (const q of queue.splice(0)) record(q.i, { name: q.t.name, ok: false, ms: 0, failures: ['not run: no worker left'], notes: [], known: [] }, [`FAIL ${q.t.name} (not run: no worker left)`]);
          if (!w.readySeen && w.stderr) console.error(`worker ${k} stderr:\n${w.stderr}`);
          resolveAll();
        }
      });
      workers.push(w);
    }
  });
  flush();
  return { results: results.filter(Boolean), guard, jobs, allRoutes };
}

/* one parallel worker: set up, then run the tests the parent sends */
async function worker(k) {
  const lines = [];
  let env = { srv: null, browser: null };
  const cleanup = async () => {
    if (env.browser) await env.browser.close().catch(() => {});
    if (env.srv) await env.srv.close().catch(() => {});
  };
  let quitting = null;
  const quit = (code) =>
    (quitting ||= (async () => {
      await cleanup();
      process.exit(code);
    })());
  process.on('disconnect', () => quit(1)); // the parent is gone
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => quit(130));
  try {
    env = await setup({ buildDir: path.join(BUILD_DIR, 'w' + k), needBrowser: process.env.E2E_NEED_BROWSER === '1', log: (m) => lines.push(m) });
  } catch (e) {
    console.error('worker setup failed:', e.stack || e);
    return quit(1);
  }
  process.send({ type: 'ready', lines: lines.filter((l) => !l.startsWith('fake server')) });
  const byName = new Map(tests.map((t) => [t.name, t]));
  process.on('message', async (m) => {
    if (m.type === 'run') {
      const out = [];
      const tc = m.rep ? { ...byName.get(m.name), rep: m.rep, reps: m.reps } : byName.get(m.name);
      let res;
      try {
        [res] = await runAll({ list: [tc], srv: env.srv, browser: env.browser, outDir, print: (l) => out.push(l) });
      } catch (e) {
        res = { name: m.name, ok: false, ms: 0, failures: ['runner error: ' + (e.stack || e)], notes: [], known: [] };
        out.push(`FAIL ${m.name} (runner error)`);
      }
      process.send({ type: 'done', result: res, lines: out });
    } else if (m.type === 'exit') {
      const g = env.browser?.guard;
      process.send({ type: 'guard', proxyHits: g ? g.proxyHits : [], browserNoise: g ? g.browserNoise.length : 0, allRoutes: routeTemplates(env.srv) }, () => quit(0));
    }
  });
}

/* Group "id: value" strings by id → ["id: v1, v2, …"] (one line per id). */
function grouped(list) {
  const by = new Map();
  for (const x of list) {
    const i = x.indexOf(': ');
    const [k, v] = i < 0 ? [x, null] : [x.slice(0, i), x.slice(i + 2)];
    if (!by.has(k)) by.set(k, []);
    if (v != null) by.get(k).push(v);
  }
  return [...by].map(([k, vs]) => (vs.length ? `${k}: ${vs.join(', ')}` : k));
}

/* The end-of-run block. It stays short (≤ ~25 lines for a green run: lists
 * are grouped and capped); the full record goes to e2e/.out/summary.json for
 * later agents and tools:
 *   { at, argv, mode, jobs, wallMs, testMs,
 *     spec: { jellyfin: '12.1.0' | 'skipped', reelApi: 'validated' | 'skipped: <why>' },
 *     totals: { tests, passed, skipped, failed, guardHits, browserNoise },
 *     tests: [{ name, file, ok, ms, failures, skipped?, rep? }],   (registry order)
 *     known: [...KNOWN_DEVIATIONS seen], notes: [...fake-server notes],
 *     flake: [{ name, pass, runs, ms: [...] }] (only with --repeat) } */
function summary({ results, guard, jobs, allRoutes = [] }, spec, reel) {
  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.ok && r.skipped);
  const notes = [...new Set(results.flatMap((r) => r.notes))].sort();
  const known = [...new Set(results.flatMap((r) => r.known))].sort();
  const testMs = results.reduce((a, r) => a + r.ms, 0);
  const wallMs = Date.now() - t0;
  const fileOf = new Map(tests.map((t) => [t.name, t.file]));
  const hitRoutes = new Set(results.flatMap((r) => r.routes || []));
  // a HEAD the fake registers next to its GET ('GET,HEAD') is the same handler: it only counts when a client sent HEAD
  allRoutes = allRoutes.filter((x) => !(/^\w+ HEAD /.test(x) && allRoutes.includes(x.replace(' HEAD ', ' GET ')) && !hitRoutes.has(x)));
  const unhit = allRoutes.filter((x) => !hitRoutes.has(x));
  const per = new Map();
  for (const r of results) {
    const e = per.get(r.name) || { name: r.name, pass: 0, runs: 0, ms: [] };
    e.runs++;
    if (r.ok) e.pass++;
    e.ms.push(r.ms);
    per.set(r.name, e);
  }
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
      at: new Date().toISOString(), argv, mode: fast ? 'fast' : grep ? 'grep' : 'full', jobs, wallMs, testMs,
      spec: { jellyfin: spec ? spec.version : 'skipped', reelApi: reel?.ok ? 'validated' : 'skipped: ' + (reel?.reason || 'unknown') },
      totals: { tests: results.length, passed: results.length - failed.length - skipped.length, skipped: skipped.length, failed: failed.length, guardHits: guard.proxyHits.length, browserNoise: guard.browserNoise },
      tests: results.map((r) => ({ name: r.name, file: fileOf.get(r.name) || null, ok: r.ok, ms: r.ms, failures: r.failures, ...(r.skipped ? { skipped: r.skipped } : {}), ...(r.rep ? { rep: r.rep } : {}) })),
      known, notes,
      routes: { implemented: allRoutes.length, hit: allRoutes.length - unhit.length, unhit },
      ...(repeat > 1 ? { flake: [...per.values()] } : {})
    }, null, 1));
  } catch {}

  const CAP = 8;
  const block = (title, lines) => {
    if (!lines.length) return;
    console.log(title + '\n  ' + lines.slice(0, CAP).join('\n  ') + (lines.length > CAP ? `\n  … ${lines.length - CAP} more in e2e/.out/summary.json` : ''));
  };
  console.log('');
  block('known deviations seen (see run/findings.md):', grouped(known));
  block('fake-server notes (behaviour the fake does not model):', notes);
  if (!fast && !grep && allRoutes.length) block(`fake routes exercised: ${allRoutes.length - unhit.length}/${allRoutes.length}${unhit.length ? '; never reached by any scenario:' : ''}`, unhit);
  if (guard.proxyHits.length) block('NETWORK GUARD proxy sink was hit (requests that escaped Fetch interception):', guard.proxyHits);
  if (guard.browserNoise) console.log(`(Chrome's own background requests blocked at the proxy sink: ${guard.browserNoise})`);
  const guardBad = guard.proxyHits.length;
  if (repeat > 1) {
    console.log(`\nflake check (--repeat ${repeat}): passes per test, durations in s`);
    for (const e of per.values()) console.log(`  ${e.pass === e.runs ? '   ' : '!! '}${e.pass}/${e.runs}  ${e.ms.map((x) => (x / 1000).toFixed(1)).join(' ')}  ${e.name}`);
    const flaky = [...per.values()].filter((e) => e.pass !== e.runs).length;
    console.log(`${per.size - flaky}/${per.size} tests passed ${repeat}/${repeat}`);
  }
  block('SKIPPED (did not check anything):', skipped.map((r) => `${r.name} — ${r.skipped}`));
  console.log(`\n${results.length - failed.length - skipped.length}/${results.length} passed${skipped.length ? `, ${skipped.length} skipped` : ''}${failed.length ? ', FAILED: ' + [...new Set(failed.map((r) => r.name))].join(', ') : ''}${guardBad ? ', network guard hits: ' + guardBad : ''} (${(wallMs / 1000).toFixed(1)} s${jobs > 1 ? `, ${jobs} workers, ${(testMs / 1000).toFixed(0)} s of tests` : ''}${spec ? '' : ', spec validation skipped'})`);
  return failed.length || guardBad ? 1 : 0;
}

/* after every declaration above (const functions + TDZ) */
if (workerId != null) await worker(workerId);
else await main();
