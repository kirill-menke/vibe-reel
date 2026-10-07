#!/usr/bin/env node
/* Offline self-test of the real-Jellyfin harness (no nix, no Jellyfin, no
 * Chrome; ~10 s). It proves the checks can fail — that a broken contract is
 * caught — which a green run against a good server can't show:
 *
 *  1. run.sh parses (bash -n) and --help works
 *  2. the recording proxy, against a tiny loopback upstream: flags the legacy
 *     X-Emby-Authorization header, api_key= on a Trickplay sheet, an
 *     identity-less Authorization header, a 4xx answer and a request off the
 *     spec; passes Range/206 through; records request and response JSON
 *  3. the spec diff, against Jellyfin 12.1's published OpenAPI (e2e/.cache;
 *     skipped with a note when not cached): clean on the real spec, and on a
 *     mutated copy it fails for a removed route the client uses, a removed
 *     query param the traffic sent, a removed body property, a newly required
 *     param — and only lists a removal the client doesn't use
 *  4. client.mjs loads the shipped src/lib modules: the TV deviceProfile()
 *     equals the e2e harness's copy (lib/bodies.mjs), the phone one is the iOS
 *     profile (no MKV DirectPlay, hls TranscodingProfile)
 *
 *   node integration/jellyfin/selftest.mjs      exit 0 = every self-check passed */
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecorder } from './proxy.mjs';
import { specDiff } from './specdiff.mjs';
import { loadClient } from './client.mjs';
import { Spec, SPEC_FILE } from '../../e2e/server/spec.mjs';
import { tvProfile } from '../../e2e/lib/bodies.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let failed = 0, passed = 0, skipped = 0;
const ok = (cond, what) => {
  if (cond) passed++;
  else {
    failed++;
    console.log('  FAIL ' + what);
  }
};
const section = (s) => console.log(s);

// ---- 1. run.sh ----
section('run.sh');
ok(spawnSync('bash', ['-n', path.join(here, 'run.sh')]).status === 0, 'run.sh: bash -n');
const help = spawnSync('bash', [path.join(here, 'run.sh'), '--help'], { encoding: 'utf8' });
ok(help.status === 0 && /--version/.test(help.stdout) && /--serve/.test(help.stdout), 'run.sh --help prints the usage');

// ---- 2. the recording proxy ----
section('recording proxy');
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (req.url.startsWith('/Items?')) return res.writeHead(200, { 'Content-Type': 'application/json' }), res.end(JSON.stringify({ Items: [{ Id: 'x' }], TotalRecordCount: 1 }));
    if (req.url.startsWith('/Videos/')) {
      const r = req.headers.range;
      res.writeHead(r ? 206 : 200, { 'Content-Type': 'video/x-matroska', 'Accept-Ranges': 'bytes', ...(r ? { 'Content-Range': 'bytes 0-3/100' } : {}) });
      return res.end('abcd');
    }
    if (req.url.startsWith('/Missing')) return res.writeHead(404), res.end();
    res.writeHead(204);
    res.end();
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const target = 'http://127.0.0.1:' + upstream.address().port;
const spec = existsSync(SPEC_FILE) ? new Spec(JSON.parse(readFileSync(SPEC_FILE, 'utf8'))) : null;
const log = [];
const rec = createRecorder({ target, spec, record: (e) => log.push(e) });
const front = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  rec(req, res, u.pathname, u.search);
});
await new Promise((r) => front.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + front.address().port;
const AUTH = 'MediaBrowser Client="Reel", Device="LG webOS TV", DeviceId="d1", Version="0.1.0", Token="t"';
const ID = '0123456789abcdef0123456789abcdef';
const go = async (p, init = {}) => {
  const n = log.length;
  const r = await fetch(base + p, init);
  await r.arrayBuffer();
  for (let i = 0; i < 100 && log.length === n; i++) await new Promise((x) => setTimeout(x, 10));
  return { r, e: log.at(-1) };
};
{
  const { r, e } = await go('/Items?userId=' + ID + '&Fields=UserData', { headers: { Authorization: AUTH } });
  ok(r.status === 200 && e.json?.TotalRecordCount === 1 && e.auth?.Client === 'Reel', 'records the JSON answer and the auth identity');
  ok(e.violations.length === 0, 'a clean request has no violations: ' + e.violations.join('; '));
  ok(r.headers.get('access-control-allow-origin') === '*', 'CORS header on the answer');
}
{
  const { e } = await go('/Users/AuthenticateByName', { method: 'POST', headers: { 'X-Emby-Authorization': AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ Username: 'a', Pw: 'b' }) });
  ok(e.violations.some((v) => /X-Emby-Authorization/.test(v)), 'flags X-Emby-Authorization');
  ok(e.body?.Username === 'a', 'records the request body');
}
{
  const { e } = await go(`/Videos/${ID}/Trickplay/320/0.jpg?api_key=t`);
  ok(e.violations.some((v) => /api_key= on a Trickplay/.test(v)), 'flags api_key= on Trickplay');
}
{
  const { e } = await go('/Items?userId=' + ID, { headers: { Authorization: 'MediaBrowser Token="t"' } });
  ok(e.violations.some((v) => /lacks Client, Device, DeviceId, Version/.test(v)), 'flags an identity-less Authorization header');
}
{
  const { r, e } = await go(`/Videos/${ID}/stream.mkv?static=true&api_key=t`, { headers: { Range: 'bytes=0-3' } });
  ok(r.status === 206 && e.contentRange === 'bytes 0-3/100', 'passes Range → 206 through and records Content-Range');
}
{
  const { e } = await go('/Missing');
  ok(e.violations.some((v) => /answered 404/.test(v)), 'a 4xx answer is a violation');
  if (spec) ok(e.violations.some((v) => /unknown route/.test(v)), 'a route off the spec is a violation');
}
if (spec) {
  const { e } = await go('/Items?userId=' + ID + '&Fields=NotAField', { headers: { Authorization: AUTH } });
  ok(e.violations.some((v) => /Fields=|not one of/.test(v)), 'a bad enum value in the query is a violation');
}
front.close();
upstream.close();

// ---- 3. the spec diff ----
section('spec diff');
if (!spec) {
  skipped++;
  console.log('  SKIP spec diff: Jellyfin 12.1 OpenAPI not cached (node e2e/scripts/fetch-spec.mjs)');
} else {
  const raw = readFileSync(SPEC_FILE, 'utf8');
  const traffic = [
    { method: 'GET', path: '/Items', search: `?userId=${ID}&Fields=UserData&StartIndex=0`, violations: [], known: [] },
    { method: 'POST', path: '/Sessions/Playing/Progress', search: '', body: { ItemId: ID, IsPaused: false, PositionTicks: 0 }, violations: [], known: [] }
  ];
  const clean = specDiff({ live: JSON.parse(raw), baseline: JSON.parse(raw), traffic });
  for (const c of clean.checks) ok(c.status === 'pass', `clean: ${c.id} passes (${c.status}: ${c.detail}; ${(c.lines || []).slice(0, 2).join(' | ')})`);
  const mut = JSON.parse(raw);
  delete mut.paths['/UserPlayedItems/{itemId}']; // a route the client uses
  const items = mut.paths['/Items'].get;
  items.parameters = items.parameters.filter((p) => p.name !== 'startIndex'); // a param the traffic sent
  items.parameters = items.parameters.filter((p) => p.name !== 'hasTrailer'); // one the client never uses
  const resume = mut.paths['/UserItems/Resume'].get;
  resume.parameters.push({ name: 'mustSend', in: 'query', required: true, schema: { type: 'string' } }); // newly required
  const ppi = mut.components.schemas.PlaybackProgressInfo;
  delete ppi.properties.IsPaused; // a body property the traffic sent
  const bad = specDiff({ live: mut, baseline: JSON.parse(raw), traffic });
  const byId = Object.fromEntries(bad.checks.map((c) => [c.id, c]));
  ok(byId['spec-routes'].status === 'fail' && byId['spec-routes'].lines.some((l) => /UserPlayedItems/.test(l)), 'a removed route the client uses fails spec-routes');
  const pl = byId['spec-params'].lines.join('\n');
  ok(byId['spec-params'].status === 'fail', 'spec-params fails on the mutated spec');
  ok(/removed, and sent this run: GET \/Items \?startIndex/.test(pl), 'a removed param the traffic sent fails');
  ok(/newly required: GET \/UserItems\/Resume \?mustSend/.test(pl), 'a newly required param fails');
  ok(/removed, and sent this run: POST \/Sessions\/Playing\/Progress body\.IsPaused/.test(pl), 'a removed body property the traffic sent fails');
  ok(/removed \(client doesn't use it\): GET \/Items \?hasTrailer/.test(pl), 'an unused removal is only listed');
  // traffic validated against the mutated spec flags what was sent
  const mspec = new Spec(mut);
  const v = mspec.validate({ method: 'GET', pathname: '/Items', query: new URLSearchParams(`userId=${ID}&StartIndex=0`), body: undefined, rawBody: Buffer.alloc(0) });
  ok(v.some((x) => /unknown query param 'StartIndex'/.test(x)), 'request validation flags the removed param');
}

// ---- 4. the shipped modules ----
section('client modules');
try {
  const tv = await loadClient('tv', { server: 'http://127.0.0.1:9', deviceId: 'reel-selftest' });
  ok(JSON.stringify(tv.deviceProfile(false)) === JSON.stringify(tvProfile(false)), "TV deviceProfile(false) equals e2e/lib/bodies.mjs's copy");
  ok(JSON.stringify(tv.deviceProfile(true)) === JSON.stringify(tvProfile(true)), "TV deviceProfile(true) equals e2e/lib/bodies.mjs's copy");
  ok(typeof tv.api.api === 'function' && /MediaSources/.test(tv.api.GRID_FIELDS), 'api.js loads (api, GRID_FIELDS)');
  await tv.close();
  const phone = await loadClient('phone', { server: 'http://127.0.0.1:9', deviceId: 'reelphone-selftest' });
  const pp = phone.deviceProfile(false, 200000000);
  ok(/iOS/.test(pp.Name) && !pp.DirectPlayProfiles.some((d) => /mkv/.test(d.Container || '')) && pp.TranscodingProfiles.some((t) => t.Protocol === 'hls'), 'phone deviceProfile() is the iOS one (no MKV DirectPlay, HLS transcoding)');
  ok(typeof globalThis.document === 'undefined', 'the canPlayType stub is removed again');
  await phone.close();
} catch (e) {
  ok(false, 'client.mjs: ' + (e.stack || e));
}

console.log(`${failed ? 'FAIL' : 'PASS'} jellyfin-it selftest: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed ? 1 : 0);
