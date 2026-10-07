#!/usr/bin/env node
/* Orchestrator of the real-Jellyfin run; run.sh starts the server and calls it.
 *
 *   node run.mjs --jf http://127.0.0.1:<port> --media <dir> [--serve] [--no-browser] [--grep re] [--headed]
 *
 * 1. setup.mjs     wizard, user, fixture libraries, scan, trickplay, watch state
 * 2. contract.mjs  direct calls built from src/lib's own modules, through the proxy
 * 3. scenarios.mjs the real TV + phone bundles in headless Chrome, through the proxy
 * 4. specdiff.mjs  this server's OpenAPI vs the routes/params the client uses
 * 5. report        console + integration/jellyfin/.out/report.json; exit 0 only if nothing failed */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, USER, call } from './setup.mjs';
import { runContract } from './contract.mjs';
import { specDiff } from './specdiff.mjs';
import { startRealEnv } from './proxy.mjs';
import { Spec, SPEC_FILE } from '../../e2e/server/spec.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '.out');
const BUILD = path.join(here, '.build');
const argv = process.argv.slice(2);
const opt = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
const flag = (f) => argv.includes(f);
const jf = opt('--jf');
const media = opt('--media');
const t0 = Number(opt('--t0') || 0) * 1000 || Date.now();
const stamp = () => `[jellyfin-it ${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s]`;
const say = (m) => console.log(`${stamp()} ${m}`);
if (!jf || !media) {
  console.error('usage: node run.mjs --jf <url> --media <dir> (run.sh does this)');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const report = { at: new Date().toISOString(), ref: process.env.JF_IT_REF || null, server: null, timings: {}, checks: [], scenarios: [], ok: false };
const phase = async (name, fn) => {
  const t = Date.now();
  try {
    return await fn();
  } finally {
    report.timings[name] = Date.now() - t;
  }
};

let env = null, browser = null;
const cleanup = async () => {
  if (browser) await browser.close().catch(() => {});
  if (env) await env.close().catch(() => {});
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, async () => (await cleanup(), process.exit(130)));

async function main() {
  // ---- 1. setup ----
  const s = await phase('setup', () => setup({ jf, media, log: (m) => say(m) }));
  report.server = { product: s.server.ProductName, version: s.server.Version, id: s.server.Id };
  say(`setup: ${Object.entries(s.timings).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)} s`).join(', ')}; trickplay ${s.trickplay ? 'generated' : 'MISSING'}`);
  if (flag('--serve')) {
    console.log(`\n  ${jf}  —  ${USER.name} / ${USER.password}  (Jellyfin ${s.server.Version}; admin token ${s.admin.token})\n  Ctrl-C stops the server and removes its state.\n`);
    await new Promise((r) => {
      setInterval(() => {}, 60000);
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, r);
    });
    return 0;
  }

  // ---- the live spec ----
  const docRes = await call(jf, 'GET', '/api-docs/openapi.json', { timeout: 60000 });
  if (docRes.status !== 200 || !docRes.json?.paths) throw new Error('GET /api-docs/openapi.json → ' + docRes.status);
  const live = new Spec(docRes.json);
  writeFileSync(path.join(OUT, `openapi-${live.version}.json`), docRes.text);
  const baseline = existsSync(SPEC_FILE) ? new Spec(JSON.parse(readFileSync(SPEC_FILE, 'utf8'))) : null;
  say(`OpenAPI ${live.version}: ${Object.keys(live.doc.paths).length} paths (baseline ${baseline ? baseline.version : 'not cached'})`);

  // ---- the proxy + the fake reel-api/static origins ----
  mkdirSync(BUILD, { recursive: true });
  const portsFile = path.join(BUILD, 'ports.json');
  let ports = {};
  try {
    ports = JSON.parse(readFileSync(portsFile, 'utf8'));
  } catch {}
  env = await startRealEnv({ jfTarget: jf, spec: live, tvDir: path.join(BUILD, 'tv'), phoneDir: path.join(BUILD, 'phone'), ports });
  writeFileSync(portsFile, JSON.stringify(env.ports));
  // the tokens bootTv/bootPhone put in localStorage: issued by the real server to the apps' own identities
  const tokens = {};
  for (const [dev, device] of [['reel-e2e-alice', 'LG webOS TV'], ['reelphone-e2e-alice', 'iPhone']]) {
    const r = await fetch(jf + '/Users/AuthenticateByName', { method: 'POST', headers: { Authorization: `MediaBrowser Client="Reel", Device="${device}", DeviceId="${dev}", Version="0.1.0"`, 'Content-Type': 'application/json' }, body: JSON.stringify({ Username: USER.name, Pw: USER.password }) });
    const j = await r.json();
    tokens[dev] = { token: j.AccessToken, userId: j.User.Id, userName: j.User.Name };
  }
  env.issueToken = (user, deviceId) => tokens[deviceId] || (() => { throw new Error('no real token for device ' + deviceId); })();
  env.real = { jf, items: s.items, admin: s.admin, user: USER };

  // ---- 2. contract probe ----
  const checks = await phase('contract', () => runContract({ jf, proxy: env.urls.jf, setupInfo: s, log: say }));
  const probeTraffic = env.jfLog.splice(0);
  for (const e of probeTraffic) e.from = 'probe';
  report.checks.push(...checks);
  printChecks('contract probe (src/lib modules → real server)', checks);

  // ---- 3. browser scenarios ----
  let scen = [];
  let allowed = [];
  if (!flag('--no-browser')) {
    scen = await phase('browser', async () => {
      const { buildApps } = await import('../../e2e/lib/build.mjs');
      const { launchChrome } = await import('../../e2e/lib/chrome.mjs');
      const { tests, runAll, setCurrentFile } = await import('../../e2e/lib/runner.mjs');
      setCurrentFile('integration/jellyfin/scenarios.mjs');
      await import('./scenarios.mjs');
      const grep = opt('--grep');
      const list = tests.filter((x) => !grep || new RegExp(grep, 'i').test(x.name));
      allowed = list.flatMap((x) => x.opts.allowViolations || []);
      await buildApps({ jf: env.urls.jf, ml: env.urls.ml, dir: BUILD, log: (m) => say(m) });
      browser = await launchChrome({ runDir: path.join(BUILD, 'chrome'), allowPorts: Object.values(env.ports), picUrl: env.urls.pic, headless: !flag('--headed') });
      console.log('\nbrowser scenarios (real TV + phone bundles → real server):');
      return runAll({ list, srv: env, browser, outDir: OUT, print: (l) => console.log('  ' + l) });
    });
    report.scenarios = scen.map((r) => ({ name: r.name, ok: r.ok, ms: r.ms, failures: r.failures }));
  }
  const traffic = [...probeTraffic, ...(env.allJf || []), ...env.jfLog];

  // ---- 4. spec diff ----
  const diff = specDiff({ live, baseline, traffic, allowed });
  report.checks.push(...diff.checks);
  printChecks(`spec diff (Jellyfin ${live.version} OpenAPI vs the client)`, diff.checks);

  // ---- 5. verdict ----
  const failed = report.checks.filter((c) => c.status === 'fail').length + report.scenarios.filter((x) => !x.ok).length;
  const warned = report.checks.filter((c) => c.status === 'warn').length;
  report.ok = failed === 0;
  report.traffic = { requests: traffic.length, routes: [...new Set(traffic.map((e) => `${e.method} ${(live.match(e.method, e.path)?.tpl) || e.path}`))].sort() };
  writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  const n = report.checks.length + report.scenarios.length;
  console.log(`\n${report.ok ? 'PASS' : 'FAIL'} — Jellyfin ${report.server.version} (${report.ref || 'given package'}): ${n - failed}/${n} passed${warned ? `, ${warned} warning(s)` : ''}${failed ? `, ${failed} FAILED` : ''}; ${traffic.length} requests recorded; report integration/jellyfin/.out/report.json`);
  console.log(`timings: ${Object.entries(report.timings).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)} s`).join(', ')}`);
  return report.ok ? 0 : 1;
}

function printChecks(title, list) {
  console.log(`\n${title}:`);
  for (const c of list) {
    console.log(`  ${c.status.toUpperCase().padEnd(4)} ${c.id} — ${c.title}${c.detail ? `\n         ${c.detail}` : ''}`);
    for (const l of (c.lines || []).slice(0, 12)) console.log('           · ' + l);
    if ((c.lines || []).length > 12) console.log(`           … ${c.lines.length - 12} more in report.json`);
  }
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error('harness error:', e.stack || e);
  report.error = String(e.stack || e);
  try {
    writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  } catch {}
  code = 1;
} finally {
  await cleanup();
}
process.exit(code);
