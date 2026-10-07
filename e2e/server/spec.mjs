/* Request validation against Jellyfin 12.1's public OpenAPI spec.
 *
 * Every request the apps send to the fake Jellyfin goes through validate().
 * A violation is a hard failure of the test that caused it (the runner checks
 * server.violations after every test). What it catches — the class of
 * breakage CLAUDE.md lists:
 *   - a route that is not in 12.1 (the removed /Users/{id}/Images/…,
 *     /Users/{uid}/PlayedItems/…, /Users/{uid}/Items…)          → unknown route
 *   - a method the route doesn't have                            → bad method
 *   - query parameter names the operation doesn't declare         → unknown param
 *     (case-insensitive, like ASP.NET's binder; ApiKey/api_key are the
 *     auth mechanism and are checked by the fake's auth layer instead)
 *   - enum values (SortBy, Fields, Filters, IncludeItemTypes, …)  → bad enum
 *   - uuid/int/bool formats (catches "/Items/undefined", userId=)  → bad format
 *   - required params / body, and JSON body property names        → bad body
 *
 * The spec lives in the git-ignored e2e/.cache/ (node e2e/scripts/fetch-spec.mjs);
 * without it loadSpec() returns null and the run reports the check as skipped. */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SPEC_FILE = path.join(here, '..', '.cache', 'jellyfin-openapi-12.1.json');
export const SPEC_URL = 'https://repo.jellyfin.org/files/openapi/stable/jellyfin-openapi-12.1.json';

/* Query names that are authentication, not operation parameters. The fake's
 * auth layer decides about them (api_key is refused on Trickplay, as 12.1 does). */
const AUTH_QUERY = new Set(['apikey', 'api_key']);

/* Routes real 12.1 serves that its published spec omits. Each needs a reason;
 * nothing may be added here to silence a client bug. The dynamic-HLS routes
 * are only ever reached through the server-issued PlaybackInfo TranscodingUrl. */
export const EXTRA_ROUTES = [
  { method: 'GET', tpl: '/Videos/{itemId}/master.m3u8', reason: 'DynamicHlsController: not in the published 12.1 spec; URL comes from PlaybackInfo TranscodingUrl' },
  { method: 'GET', tpl: '/Videos/{itemId}/main.m3u8', reason: 'DynamicHlsController variant playlist (phone loads it instead of master, CLAUDE.md)' },
  { method: 'GET', tpl: '/Videos/{itemId}/hls1/{playlistId}/{segmentId}.{segmentContainer}', reason: 'DynamicHlsController segments, named by the playlist' },
  { method: 'DELETE', tpl: '/Videos/ActiveEncodings', reason: 'HlsSegmentController (also omitted from the published spec); the phone stops its offline-download job with it' }
].map((r) => ({ ...r, re: new RegExp('^' + r.tpl.replace(/\{[^}]+\}/g, '[^/]+').replace(/\./g, '\\.') + '$', 'i') }));

/* Client deviations from the spec that are verified harmless on the real
 * server, each recorded in run/findings.md. validate() reports them through
 * its `known` callback instead of as violations, so they stay visible in the
 * run summary. Never widen a rule to get a failing test green without a
 * findings.md record of why.
 *
 *  fields-always-present: a `Fields` element that is not an ItemFields value
 *    but names a BaseItemDto property the server always returns (UserData,
 *    ProductionYear, PremiereDate, RunTimeTicks, SeriesName, …). Jellyfin's
 *    CommaDelimitedArrayModelBinder drops elements it can't parse, and the
 *    property comes back anyway, so the request means exactly what the client
 *    intends. A typo or a value removed from the enum is still a violation.
 *
 *  userimage-resize: the avatar URL (account.svelte.js avatarUrl) asks
 *    /UserImage for maxHeight + quality, which 12.1's /UserImage doesn't take
 *    (userId, tag, format only): the server ignores them and sends the stored
 *    image unscaled. Functionally the avatar still shows; recorded in
 *    run/findings.md as a product finding (no resize happens).
 *
 *  deviceprofile-responseprofiles: the phone's DeviceProfile (tracks.js
 *    phoneProfile) still carries `ResponseProfiles`, which 12.x's DeviceProfile
 *    no longer has (DLNA moved out in 10.9). System.Text.Json drops the unknown
 *    property, so the request means the same without it (run/findings.md F-005).
 *    Only that one property path, only on PlaybackInfo.
 *
 *  nextup-disablefirstepisode: the phone's nextUpPath() (api.js) still sends
 *    DisableFirstEpisode=false, a /Shows/NextUp parameter 12.x dropped; an
 *    unknown query parameter is ignored and false was its default, so the
 *    request means the same (run/findings.md F-010). Only that param, only there. */
export const KNOWN_DEVIATIONS = [
  { id: 'fields-always-present', kind: 'enum', param: 'fields', test: (spec, v) => !!spec.doc.components.schemas.BaseItemDto?.properties?.[v] },
  { id: 'userimage-resize', kind: 'param', tpl: '/UserImage', params: ['maxheight', 'quality'] },
  { id: 'nextup-disablefirstepisode', kind: 'param', tpl: '/Shows/NextUp', params: ['disablefirstepisode'] },
  { id: 'deviceprofile-responseprofiles', kind: 'body', where: /^POST \/Items\/[^/]+\/PlaybackInfo$/, path: 'body.deviceprofile.responseprofiles' }
];

const UUID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

let cached;
export function loadSpec(file = SPEC_FILE) {
  if (cached !== undefined && file === SPEC_FILE) return cached;
  const s = existsSync(file) ? new Spec(JSON.parse(readFileSync(file, 'utf8'))) : null;
  if (file === SPEC_FILE) cached = s;
  return s;
}

export class Spec {
  constructor(doc) {
    this.doc = doc;
    this.version = doc.info?.version;
    /* Templates sorted so literal segments win over {params}:
     * /Items/Latest before /Items/{itemId}. */
    this.routes = Object.entries(doc.paths).map(([tpl, ops]) => {
      const segs = tpl.split('/').slice(1);
      const names = [];
      const re = segs
        .map((s) =>
          s.replace(/\{([^}]+)\}|([^{]+)/g, (_, p, lit) => {
            if (p) {
              names.push(p);
              return '([^/]+)';
            }
            return lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          })
        )
        .join('/');
      const literal = segs.filter((s) => !s.includes('{')).length;
      const partial = segs.filter((s) => s.includes('{') && !/^\{[^}]+\}$/.test(s)).length;
      return { tpl, ops, names, re: new RegExp('^/' + re + '$', 'i'), literal, partial };
    });
    this.routes.sort((a, b) => b.literal - a.literal || b.partial - a.partial);
  }

  has(method, tpl) {
    return !!this.doc.paths[tpl]?.[method.toLowerCase()] || EXTRA_ROUTES.some((r) => r.tpl === tpl && r.method === method);
  }

  /* → { tpl, op, params } | null */
  match(method, pathname) {
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = {};
      r.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
      return { tpl: r.tpl, op: r.ops[method.toLowerCase()] || null, ops: r.ops, params };
    }
    return null;
  }

  resolve(schema, depth = 0) {
    if (!schema || depth > 8) return schema || {};
    if (schema.$ref) {
      const name = schema.$ref.split('/').pop();
      return this.resolve(this.doc.components.schemas[name], depth + 1);
    }
    if (schema.allOf && schema.allOf.length === 1) {
      const inner = this.resolve(schema.allOf[0], depth + 1);
      return { ...inner, nullable: schema.nullable ?? inner.nullable };
    }
    return schema;
  }

  /* req: { method, pathname, query: URLSearchParams, body (parsed JSON | undefined), rawBody } */
  validate(req, known = () => {}) {
    const out = [];
    const where = req.method + ' ' + req.pathname;
    if (EXTRA_ROUTES.some((r) => (r.method === req.method || (req.method === 'HEAD' && r.method === 'GET')) && r.re.test(req.pathname))) return out;
    const m = this.match(req.method, req.pathname);
    if (!m) return [`unknown route ${where} (not in Jellyfin ${this.version})`];
    if (!m.op) return [`method ${req.method} not allowed on ${m.tpl} (has ${Object.keys(m.ops).join(', ')})`];
    const params = m.op.parameters || [];

    for (const p of params.filter((p) => p.in === 'path')) {
      const v = m.params[p.name];
      const e = this.checkValue(p.schema, v);
      if (e) out.push(`${where}: path param ${p.name}=${JSON.stringify(v)} ${e}`);
    }

    const declared = new Map(params.filter((p) => p.in === 'query').map((p) => [p.name.toLowerCase(), p]));
    const seen = new Set();
    for (const [k, v] of req.query) {
      const lk = k.toLowerCase();
      if (AUTH_QUERY.has(lk)) continue;
      const p = declared.get(lk);
      const kp = !p && KNOWN_DEVIATIONS.find((d) => d.kind === 'param' && d.tpl === m.tpl && d.params.includes(lk));
      if (kp) {
        known(kp, k);
        continue;
      }
      if (!p) {
        out.push(`${where}: unknown query param '${k}' (${m.tpl} declares: ${[...declared.values()].map((p) => p.name).join(', ') || 'none'})`);
        continue;
      }
      if (seen.has(lk)) continue;
      seen.add(lk);
      const e = this.checkValue(p.schema, v, p.name, known);
      if (e) out.push(`${where}: query ${k}=${JSON.stringify(v)} ${e}`);
    }
    for (const p of declared.values()) {
      if (p.required && !seen.has(p.name.toLowerCase())) out.push(`${where}: required query param '${p.name}' missing`);
    }

    const rb = m.op.requestBody;
    if (rb) {
      const content = rb.content || {};
      const json = content['application/json'];
      if (req.body === undefined && !req.rawBody) {
        if (rb.required) out.push(`${where}: request body required`);
      } else if (json && req.body !== undefined) {
        const sch = this.resolve(json.schema);
        out.push(...this.checkBody(sch, req.body, where, known));
      }
    } else if (req.rawBody && req.rawBody.length && req.method !== 'GET') {
      out.push(`${where}: sends a body but ${m.tpl} takes none`);
    }
    return out;
  }

  get label() {
    return 'fake response';
  }

  /* A JSON answer the FAKE sends (status 2xx) against the operation's response
   * schema: the status must be one the route declares, and the body must fit
   * the schema exactly as the real server serialises it ('strict': exact JSON
   * types, enum names as written, no property the DTO lacks — recursively
   * through MediaSources/MediaStreams/UserData/People/Chapters/…). Errors
   * (4xx/5xx) and non-JSON answers (images, video, playlists) aren't checked.
   * Messages start with "fake response" / "fake reel-api response": they are
   * bugs in the fixture, not in the apps. */
  validateResponse(method, pathname, status, obj) {
    if (status >= 300) return [];
    if (EXTRA_ROUTES.some((r) => (r.method === method || (method === 'HEAD' && r.method === 'GET')) && r.re.test(pathname))) return [];
    const where = `${this.label} ${method} ${pathname} → ${status}`;
    const m = this.match(method, pathname);
    const op = m && (m.op || (method === 'HEAD' ? m.ops.get : null));
    if (!op) return []; // the request side already reported it
    const ok = Object.keys(op.responses || {}).filter((c) => /^2/.test(c));
    if (!ok.includes(String(status))) return [`${where}: status ${status} but ${m.tpl} declares ${ok.join('|') || 'no 2xx'}`];
    if (status === 204 || obj === undefined) return [];
    const content = op.responses[String(status)]?.content || {};
    const json = content['application/json'] || Object.entries(content).find(([k]) => k.startsWith('application/json'))?.[1];
    if (!json?.schema) {
      if (Object.keys(content).length) return [`${where}: sends JSON but ${m.tpl} answers ${Object.keys(content).join(', ')}`];
      return [];
    }
    const out = [];
    this.checkNode(json.schema, obj, 'body', (path, msg) => out.push(`${where}: ${path}${msg.startsWith('=') ? '' : ' '}${msg}`), 0, 'strict');
    return out;
  }

  /* A JSON request body against its schema, recursively (objects, arrays,
   * dictionaries, $ref/allOf/oneOf), modelled on how Jellyfin 12.1 reads a body
   * (Jellyfin.Extensions JsonDefaults on top of ASP.NET's web defaults):
   *   - property names match case-insensitively; a name the DTO doesn't have is
   *     a violation here (System.Text.Json would silently drop it — which is
   *     exactly how a renamed/removed field stops working unnoticed)
   *   - enums are read by JsonStringEnumConverter: names case-insensitive, an
   *     integer in range also binds
   *   - NumberHandling.AllowReadingFromString: "8" binds to an int property;
   *     JsonStringConverter: a number/bool token binds to a string property
   *   - everything else (a bool for an int, a string for a bool, an object for
   *     a string, an int32 out of range, a non-uuid Guid, a bad date) fails to
   *     bind — on the real server the whole body becomes null or a 400.
   * Returns violation strings "<where>: body.<path> …". */
  checkBody(sch, body, where, known = () => {}) {
    const out = [];
    this.checkNode(sch, body, 'body', (path, msg) => {
      const kd = KNOWN_DEVIATIONS.find((d) => d.kind === 'body' && d.where.test(where) && d.path === path.toLowerCase());
      if (kd) known(kd, path);
      else out.push(`${where}: ${path}${msg.startsWith('=') ? '' : ' '}${msg}`);
    });
    return out;
  }

  /* Flatten $ref / allOf into one schema (properties merged, enum/nullable kept). */
  flat(schema, depth = 0) {
    if (!schema || depth > 16) return schema || {};
    let s = schema;
    if (s.$ref) s = { ...this.flat(this.doc.components.schemas[s.$ref.split('/').pop()], depth + 1), ...(s.nullable ? { nullable: true } : {}) };
    if (s.allOf) {
      const parts = s.allOf.map((x) => this.flat(x, depth + 1));
      const merged = { ...s };
      delete merged.allOf;
      for (const part of parts) {
        for (const [k, v] of Object.entries(part)) {
          if (k === 'properties') merged.properties = { ...(merged.properties || {}), ...v };
          else if (k === 'required') merged.required = [...(merged.required || []), ...v];
          else if (merged[k] === undefined) merged[k] = v;
        }
      }
      s = merged;
    }
    return s;
  }

  /* mode — how the receiving side binds JSON:
   *   'stj'      Jellyfin's System.Text.Json (see checkBody): names and enum names
   *              case-insensitive, numbers from strings, any scalar into a string
   *   'pydantic' reel-api's request models (pydantic v2 lax mode): names exact,
   *              "8" → int and "true" → bool bind, but a number never binds to str
   *   'strict'   a response as the real server serialises it: exact JSON types
   * Handles OpenAPI 3.0 (nullable) and 3.1 (type: 'null' / type arrays, const). */
  checkNode(schema, v, path, report, depth = 0, mode = 'stj') {
    const s = this.flat(schema);
    if (depth > 24) return;
    const ci = mode === 'stj';
    const alts = s.oneOf || s.anyOf || (Array.isArray(s.type) ? s.type.map((type) => ({ ...s, type })) : null);
    if (alts) {
      const fits = alts.some((alt) => {
        let bad = false;
        this.checkNode(alt, v, path, () => (bad = true), depth + 1, mode);
        return !bad;
      });
      if (!fits) {
        // one non-null alternative: report its own error (Optional[X] reads better that way)
        const real = alts.filter((a) => this.flat(a).type !== 'null');
        if (real.length === 1 && v !== null) return this.checkNode(real[0], v, path, report, depth + 1, mode);
        report(path, `=${JSON.stringify(v)?.slice(0, 60)} matches none of ` + alts.map((a) => (a.$ref || a.type || '?').split('/').pop()).join('|'));
      }
      return;
    }
    if (s.type === 'null') {
      if (v !== null) report(path, `=${JSON.stringify(v)?.slice(0, 60)} should be null`);
      return;
    }
    if (v === null) {
      if (!(s.nullable || (!s.type && !s.enum && !s.properties && s.const === undefined))) report(path, 'is null but not nullable');
      return;
    }
    if (s.const !== undefined) {
      if (v !== s.const) report(path, `=${JSON.stringify(v)?.slice(0, 60)} should be ${JSON.stringify(s.const)}`);
      return;
    }
    if (s.enum) {
      const eq = (e) => (ci && typeof v === 'string' ? String(e).toLowerCase() === v.toLowerCase() : e === v);
      if (typeof v === 'string' || mode !== 'stj') {
        if (!s.enum.some(eq)) report(path, `=${JSON.stringify(v)} not one of ${s.enum.slice(0, 20).join('|')}`);
      } else if (!(Number.isInteger(v) && v >= 0 && v < s.enum.length)) report(path, `=${JSON.stringify(v)} is not an enum name`);
      return;
    }
    const type = s.type || (s.properties || s.additionalProperties ? 'object' : s.items ? 'array' : undefined);
    const show = () => JSON.stringify(v).slice(0, 60);
    switch (type) {
      case 'object': {
        if (typeof v !== 'object' || Array.isArray(v)) return report(path, `=${show()} should be an object`);
        if (!s.properties) {
          // a dictionary (additionalProperties schema) or a free-form object
          if (s.additionalProperties && typeof s.additionalProperties === 'object') for (const k of Object.keys(v)) this.checkNode(s.additionalProperties, v[k], path + '.' + k, report, depth + 1, mode);
          return;
        }
        const props = s.properties;
        const norm = (k) => (ci ? k.toLowerCase() : k);
        const names = new Map(Object.keys(props).map((k) => [norm(k), k]));
        for (const k of Object.keys(v)) {
          const name = names.get(norm(k));
          if (name) this.checkNode(props[name], v[k], path + '.' + k, report, depth + 1, mode);
          else if (s.additionalProperties && typeof s.additionalProperties === 'object') this.checkNode(s.additionalProperties, v[k], path + '.' + k, report, depth + 1, mode);
          else if (s.additionalProperties !== true) report(path + '.' + k, `not in schema (${Object.keys(props).slice(0, 12).join(', ')}${names.size > 12 ? '…' : ''})`);
        }
        for (const r of s.required || []) {
          if (!Object.keys(v).some((k) => norm(k) === norm(r))) report(path + '.' + r, 'required');
        }
        return;
      }
      case 'array':
        if (!Array.isArray(v)) return report(path, `=${show()} should be an array`);
        v.forEach((x, i) => this.checkNode(s.items || {}, x, `${path}[${i}]`, report, depth + 1, mode));
        return;
      case 'string':
        if (typeof v === 'number' || typeof v === 'boolean') {
          if (mode !== 'stj' || s.format === 'uuid' || s.format === 'date-time') report(path, `=${show()} should be a string${s.format ? ' (' + s.format + ')' : ''}`);
          return; // JsonStringConverter reads the raw token
        }
        if (typeof v !== 'string') return report(path, `=${show()} should be a string`);
        if (s.format === 'uuid' && !UUID.test(v)) report(path, `=${show()} is not a uuid`);
        if (s.format === 'date-time' && Number.isNaN(Date.parse(v))) report(path, `=${show()} is not a date-time`);
        if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) report(path, `=${show()} does not match ${s.pattern}`);
        return;
      case 'integer':
      case 'number': {
        let n = v;
        if (mode !== 'strict' && typeof v === 'string' && /^\s*-?\d+(\.\d+)?([eE][+-]?\d+)?\s*$/.test(v)) n = Number(v); // AllowReadingFromString / pydantic lax
        if (typeof n !== 'number' || !Number.isFinite(n)) return report(path, `=${show()} should be ${type === 'integer' ? 'an integer' : 'a number'}`);
        if (type === 'integer' && !Number.isInteger(n)) return report(path, `=${show()} should be an integer`);
        if (s.format === 'int32' && (n > 2147483647 || n < -2147483648)) report(path, `=${show()} overflows int32`);
        if (s.minimum !== undefined && n < s.minimum) report(path, `=${show()} is below ${s.minimum}`);
        if (s.maximum !== undefined && n > s.maximum) report(path, `=${show()} is above ${s.maximum}`);
        return;
      }
      case 'boolean':
        if (typeof v !== 'boolean' && !(mode === 'pydantic' && /^(true|false|0|1|yes|no|on|off)$/i.test(String(v)))) report(path, `=${show()} should be a boolean`);
        return;
    }
  }

  /* One query/path string value against its schema. */
  checkValue(schema, v, name = '', known = () => {}) {
    const s = this.resolve(schema);
    if (s.type === 'array') {
      const item = this.resolve(s.items);
      // Jellyfin's binders: comma-delimited, a few documented as pipe-delimited
      const parts = /genres|tags|studios|officialratings|artists|albums|person$/i.test(name) ? v.split('|') : v.split(',');
      for (const part of parts) {
        const e = this.checkScalar(item, part.trim());
        const kd = e && KNOWN_DEVIATIONS.find((d) => d.kind === 'enum' && d.param === name.toLowerCase() && d.test(this, part.trim()));
        if (kd) {
          known(kd, part.trim());
          continue;
        }
        if (e) return `(element ${JSON.stringify(part)}) ${e}`;
      }
      return null;
    }
    return this.checkScalar(s, v);
  }

  checkScalar(s, v) {
    if (s.anyOf || s.oneOf) {
      const alts = (s.anyOf || s.oneOf).map((a) => this.flat(a)).filter((a) => a.type !== 'null');
      const errs = alts.map((a) => this.checkScalar(a, v));
      return errs.some((e) => e === null) ? null : errs[0];
    }
    if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) return `does not match ${s.pattern}`;
    if ((s.type === 'integer' || s.type === 'number') && v !== '' && !Number.isNaN(Number(v))) {
      if (s.minimum !== undefined && Number(v) < s.minimum) return `is below ${s.minimum}`;
      if (s.maximum !== undefined && Number(v) > s.maximum) return `is above ${s.maximum}`;
    }
    if (s.enum) {
      return s.enum.some((e) => String(e).toLowerCase() === String(v).toLowerCase()) ? null : `not one of ${s.enum.slice(0, 20).join('|')}${s.enum.length > 20 ? '…' : ''}`;
    }
    switch (s.type) {
      case 'string':
        if (s.format === 'uuid' && !UUID.test(v)) return 'is not a uuid';
        return null;
      case 'integer':
        return /^-?\d+$/.test(v) ? null : 'is not an integer';
      case 'number':
        return v !== '' && !Number.isNaN(Number(v)) ? null : 'is not a number';
      case 'boolean':
        return /^(true|false)$/i.test(v) ? null : 'is not a boolean';
    }
    return null;
  }
}
