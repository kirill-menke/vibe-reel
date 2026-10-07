/* The running server's OpenAPI against what the client uses. Three views:
 *
 *  1. routes — every Jellyfin request shape in src/ + phone/src (the e2e
 *     harness's static inventory, e2e/scripts/route-inventory.mjs) must exist
 *     in this server's spec (+ EXTRA_ROUTES: the dynamic-HLS routes real
 *     servers serve but don't publish). A removed route fails.
 *  2. traffic — every request the real apps and the probe actually sent this
 *     run, validated against this server's spec when it was made (proxy.mjs:
 *     unknown route/method, unknown or removed query param, enum value, body
 *     property, format). Any violation fails; KNOWN_DEVIATIONS are listed.
 *  3. params — for each operation the client uses (by inventory or traffic),
 *     query params and top-level body properties the BASELINE spec (the
 *     published 12.1 one the client was built against, e2e/.cache) has and
 *     this server's lacks. Removed and sent this run, or written as an object
 *     key in src/ / phone/src → fail; otherwise listed. Skipped (and said so)
 *     without a cached baseline.
 *
 *     A scenario's allowViolations (exact patterns, each a recorded finding)
 *     are listed, not failed.
 *
 * specDiff({ live, baseline, traffic, allowed }) → { checks: [{ id, title, status, detail, lines }], stats } */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { inventory, matchTemplates, REPO } from '../../e2e/scripts/route-inventory.mjs';
import { EXTRA_ROUTES, Spec } from '../../e2e/server/spec.mjs';

const METHODS = ['get', 'post', 'put', 'delete', 'head', 'patch'];
const templatesOf = (doc) => Object.entries(doc.paths).flatMap(([tpl, ops]) => METHODS.filter((m) => ops[m]).map((m) => ({ method: m.toUpperCase(), tpl })));

let srcText = null;
function sourceText() {
  if (srcText != null) return srcText;
  const parts = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) {
        if (f !== 'node_modules' && f !== 'vendor') walk(p);
      } else if (/\.(js|mjs|svelte)$/.test(f)) parts.push(readFileSync(p, 'utf8'));
    }
  };
  for (const r of ['src', 'phone/src']) walk(path.join(REPO, r));
  return (srcText = parts.join('\n'));
}
const inSource = (name) => new RegExp(`(^|[\\s{,'"])${name.replace(/[^\w]/g, '')}['"]?\\s*:`, 'im').test(sourceText());

function bodyProps(spec, op) {
  const sch = op?.requestBody?.content?.['application/json']?.schema;
  if (!sch) return new Map();
  const s = spec.flat(sch);
  return new Map(Object.keys(s.properties || {}).map((k) => [k.toLowerCase(), k]));
}

export function specDiff({ live, baseline, traffic, allowed = [] }) {
  const liveSpec = live instanceof Spec ? live : new Spec(live);
  const base = baseline ? (baseline instanceof Spec ? baseline : new Spec(baseline)) : null;
  const checks = [];
  const liveTpls = [...templatesOf(liveSpec.doc), ...EXTRA_ROUTES.map((r) => ({ method: r.method, tpl: r.tpl }))];

  // ---- 1. routes ----
  const inv = inventory().filter((r) => r.kind === 'jf');
  const missing = inv.filter((r) => !matchTemplates(r.shape, r.method, liveTpls, { ci: true }).length);
  checks.push({
    id: 'spec-routes',
    title: `every Jellyfin route in src/ + phone/src exists in this server's OpenAPI (${inv.length} request shapes)`,
    status: missing.length ? 'fail' : 'pass',
    detail: missing.length ? `${missing.length} route(s) gone` : `${inv.length}/${inv.length} present`,
    lines: missing.map((r) => `gone: ${r.method || '*'} ${r.shape}  (${r.sites.slice(0, 2).join(', ')})`)
  });

  // ---- 2. traffic ----
  const viol = new Map();
  const known = new Set();
  for (const e of traffic) {
    for (const v of e.violations) {
      if (/^real Jellyfin answered|^proxy:/.test(v)) continue; // status problems belong to the scenario/probe that saw them
      if (allowed.some((re) => re.test(v))) {
        known.add('allowed by a scenario (a recorded finding): ' + v);
        continue;
      }
      const k = v.replace(/[0-9a-f]{32}|[0-9a-f-]{36}/gi, '{id}');
      viol.set(k, (viol.get(k) || 0) + 1);
    }
    for (const k of e.known || []) known.add(k.split(': ')[0]);
  }
  checks.push({
    id: 'spec-traffic',
    title: `every request the apps + probe sent this run validates against this server's OpenAPI (${traffic.length} requests)`,
    status: viol.size ? 'fail' : 'pass',
    detail: viol.size ? `${viol.size} distinct violation(s)` : `${traffic.length} requests clean${known.size ? '; known deviations seen: ' + [...known].sort().join(', ') : ''}`,
    lines: [...viol].map(([k, n]) => `${n}× ${k}`)
  });

  // ---- 3. params removed since the baseline ----
  if (!base) {
    checks.push({ id: 'spec-params', title: 'params/body properties the client uses vs the baseline 12.1 spec', status: 'warn', detail: 'baseline spec not cached — run node e2e/scripts/fetch-spec.mjs once', lines: [] });
  } else {
    const used = new Map(); // "METHOD tpl" → { query: Set(lower), body: Set(lower) }
    const use = (method, tpl) => {
      const k = method + ' ' + tpl;
      if (!used.has(k)) used.set(k, { method, tpl, query: new Set(), body: new Set() });
      return used.get(k);
    };
    const baseTpls = templatesOf(base.doc);
    for (const r of inv) for (const t of matchTemplates(r.shape, r.method, baseTpls, { ci: true })) use(t.method, t.tpl);
    for (const e of traffic) {
      const m = base.match(e.method, e.path);
      if (!m || !m.op) continue;
      const u = use(e.method, m.tpl);
      for (const [k] of new URLSearchParams(e.search)) u.query.add(k.toLowerCase());
      if (e.body && typeof e.body === 'object' && !Array.isArray(e.body)) for (const k of Object.keys(e.body)) u.body.add(k.toLowerCase());
    }
    const fails = [], notes = [];
    for (const u of used.values()) {
      const bop = base.doc.paths[u.tpl]?.[u.method.toLowerCase()];
      const lm = liveSpec.match(u.method, u.tpl.replace(/\{[^}]+\}/g, 'x0e2e'));
      const lop = lm?.op;
      if (!bop || !lop) continue; // a gone route is check 1's
      const lq = new Set((lop.parameters || []).filter((p) => p.in === 'query').map((p) => p.name.toLowerCase()));
      for (const p of (bop.parameters || []).filter((p) => p.in === 'query')) {
        if (lq.has(p.name.toLowerCase())) continue;
        const where = `${u.method} ${u.tpl} ?${p.name}`;
        if (u.query.has(p.name.toLowerCase())) fails.push(`removed, and sent this run: ${where}`);
        else if (inSource(p.name)) fails.push(`removed, and named in the source: ${where}`);
        else notes.push(`removed (client doesn't use it): ${where}`);
      }
      for (const p of (lop.parameters || []).filter((p) => p.in === 'query' && p.required)) {
        if (!(bop.parameters || []).some((b) => b.in === 'query' && b.required && b.name.toLowerCase() === p.name.toLowerCase())) fails.push(`newly required: ${u.method} ${u.tpl} ?${p.name}`);
      }
      const bb = bodyProps(base, bop), lb = bodyProps(liveSpec, lop);
      for (const [lk, name] of bb) {
        if (lb.has(lk)) continue;
        const where = `${u.method} ${u.tpl} body.${name}`;
        if (u.body.has(lk)) fails.push(`removed, and sent this run: ${where}`);
        else notes.push(`removed (not sent this run): ${where}`);
      }
    }
    checks.push({
      id: 'spec-params',
      title: `query params / body properties of the ${used.size} operations the client uses, baseline ${base.version} → ${liveSpec.version}`,
      status: fails.length ? 'fail' : 'pass',
      detail: fails.length ? `${fails.length} removal(s) that matter` : base.version === liveSpec.version && !notes.length ? 'same version, nothing removed' : `nothing the client uses removed${notes.length ? `; ${notes.length} unused removal(s) listed` : ''}`,
      lines: [...fails, ...notes]
    });
  }
  return { checks, stats: { inventory: inv.length, traffic: traffic.length } };
}
