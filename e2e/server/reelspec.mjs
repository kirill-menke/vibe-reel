/* The reel-api contract, from the backend's own FastAPI OpenAPI
 * (e2e/scripts/reelapi-spec.mjs writes it into the git-ignored e2e/.cache/).
 *
 * Two directions:
 *   validate(req)          a request the apps send: route + method in the spec,
 *                          path params (types, patterns, ranges), query names and
 *                          values, JSON body (pydantic lax binding)
 *   validateResponse(...)  every JSON answer the FAKE sends with a 2xx status:
 *                          the status the route declares, property names (none
 *                          the model lacks), required fields, exact JSON types,
 *                          nullability — so the fake can't drift from models.py.
 *
 * Responses FastAPI declares as `{}` (untyped dicts: probe, hls, trailers,
 * push, health) are checked against the hand-written shapes the backend's own
 * contract tests hold real answers to (backend/tests/support/documented.py,
 * dumped into the spec as `x-documented`); an untyped JSON answer with no
 * documented shape is a violation. Error answers (4xx/5xx) use reel-api's own
 * {error, detail} shape, which the spec doesn't describe, and are not checked.
 * Without the cached spec loadReelSpec() returns null; run.mjs then fails the
 * run (WARM_HINT says how to fix it). */
import { existsSync, readFileSync } from 'node:fs';
import { Spec } from './spec.mjs';
import { REEL_SPEC_FILE } from '../scripts/reelapi-spec.mjs';

/* Fake-only routes: fixture artwork the fake reel-api hands out as image URLs
 * (the real one returns Sonarr/Radarr/TMDB image URLs instead). */
const FIXTURE = /^\/__fixture\//;

export function loadReelSpec(file = REEL_SPEC_FILE) {
  return existsSync(file) ? new ReelSpec(JSON.parse(readFileSync(file, 'utf8'))) : null;
}

export class ReelSpec extends Spec {
  constructor(doc) {
    super(doc);
    // FastAPI routes are case-sensitive
    for (const r of this.routes) r.re = new RegExp(r.re.source);
  }

  /* template with param names erased, for comparing the fake's routes */
  static shape(tpl) {
    return tpl.replace(/\{[^}]+\}/g, '{}');
  }

  has(method, tpl) {
    const want = ReelSpec.shape(tpl);
    return this.routes.some((r) => ReelSpec.shape(r.tpl) === want && r.ops[method.toLowerCase()]);
  }

  validate(req) {
    if (FIXTURE.test(req.pathname)) return [];
    const out = [];
    const where = 'reel-api ' + req.method + ' ' + req.pathname;
    const m = this.match(req.method, req.pathname);
    if (!m) return [`${where}: route not in reel-api's OpenAPI`];
    const op = m.op || (req.method === 'HEAD' ? m.ops.get : null);
    if (!op) return [`${where}: method ${req.method} not allowed on ${m.tpl} (has ${Object.keys(m.ops).join(', ')})`];
    const params = op.parameters || [];
    for (const p of params.filter((p) => p.in === 'path')) {
      const e = this.checkScalar(this.flat(p.schema), m.params[p.name]);
      if (e) out.push(`${where}: path param ${p.name}=${JSON.stringify(m.params[p.name])} ${e}`);
    }
    const declared = new Map(params.filter((p) => p.in === 'query').map((p) => [p.name, p]));
    for (const [k, v] of req.query) {
      // the request guard's token transport (security.py), on every route; never declared per route
      if (k.toLowerCase() === 'api_key') continue;
      const p = declared.get(k);
      if (!p) {
        out.push(`${where}: unknown query param '${k}' (${m.tpl} declares: ${[...declared.keys()].join(', ') || 'none'})`);
        continue;
      }
      const e = this.checkScalar(this.flat(p.schema), v);
      if (e) out.push(`${where}: query ${k}=${JSON.stringify(v)} ${e}`);
    }
    for (const p of declared.values()) if (p.required && !req.query.has(p.name)) out.push(`${where}: required query param '${p.name}' missing`);
    const rb = op.requestBody;
    if (rb) {
      const json = rb.content?.['application/json'];
      if (req.body === undefined) {
        if (rb.required) out.push(`${where}: JSON body required`);
      } else if (json) this.checkNode(json.schema, req.body, 'body', (path, msg) => out.push(`${where}: ${path}${msg.startsWith('=') ? '' : ' '}${msg}`), 0, 'pydantic');
    }
    // no requestBody declared: either none is read (FastAPI ignores one) or the
    // handler reads the raw Request (push.py) — the spec can't tell, so no check
    return out;
  }

  get label() {
    return 'fake reel-api response';
  }

  validateResponse(method, pathname, status, obj) {
    if (FIXTURE.test(pathname)) return [];
    const out = super.validateResponse(method, pathname, status, obj);
    if (status >= 300 || obj === undefined) return out;
    const m = this.match(method, pathname);
    const op = m && (m.op || (method === 'HEAD' ? m.ops.get : null));
    const json = op?.responses?.[String(status)]?.content?.['application/json'];
    if (!json || (json.schema && Object.keys(json.schema).length)) return out; // typed: checked above
    const key = `${method === 'HEAD' ? 'GET' : method} ${m.tpl} ${status}`;
    const where = `${this.label} ${method} ${pathname} → ${status}`;
    const shape = this.doc['x-documented']?.[key];
    if (!shape) return [...out, `${where}: ${m.tpl} declares no response model and has no documented shape (backend/tests/support/documented.py)`];
    this.checkNode(shape, obj, 'body', (path, msg) => out.push(`${where}: ${path}${msg.startsWith('=') ? '' : ' '}${msg}`), 0, 'strict');
    return out;
  }

  /* the documented shape of an untyped route, or undefined */
  documented(method, tpl, status = 200) {
    return this.doc['x-documented']?.[`${method} ${tpl} ${status}`];
  }
}
