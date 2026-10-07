#!/usr/bin/env node
/* types/check-reel-api.mjs — drift check between reel-api's JSON (backend/, read-only) and the
 * Reel.* interfaces in types/reel-api.d.ts. Type-only tooling: nothing here is imported by the
 * app or reaches a bundle.
 *
 *   node types/check-reel-api.mjs          exit 0 = every mapped payload has the same keys
 *   node types/check-reel-api.mjs --list   also print each payload's keys
 *
 * Backend side: the pydantic response models in backend/src/reel_api/models.py (FastAPI's
 * response_model serialises every declared field, defaults included, so the class body IS the
 * JSON's key set; base classes are followed), plus the dict literals of the routes that have no
 * model — streaming.py `_shape_probe()` (/api/downloads/{id}/probe) and trailers.py
 * `Job.status()` (/api/trailers/{key}).
 * Client side: the interfaces' member names, `extends` followed, read with the TypeScript
 * compiler API (no type-checking needed).
 *
 * Fails on a key the backend emits that the interface lacks, on an interface member the backend
 * never emits, on a mapped model / interface / dict literal that can't be found (a backend
 * refactor must update MAP, never silently pass), and on an ALLOW entry that no longer matches
 * a difference (stale allow-lists hide nothing). */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIST = process.argv.includes('--list');
const read = (rel) => readFileSync(path.join(repo, rel), 'utf8');

/* models.py class → Reel interface. */
const MODELS = {
  LookupResult: 'LookupResult',
  LookupResponse: 'LookupResponse',
  TrendingResult: 'TrendingItem',
  TrendingResponse: 'TrendingResponse',
  LibraryAddResult: 'LibraryAddResult',
  LibraryUndoResult: 'LibraryUndoResult',
  EpisodeMetadata: 'EpisodeMetadata',
  CollectionRef: 'CollectionRef',
  TitleMetadata: 'Metadata',
  CollectionMovie: 'CollectionMovie',
  Collection: 'CollectionResponse',
  NewsItem: 'NewsItem',
  NewsResponse: 'NewsResponse',
  SeasonSearchResult: 'SeasonSearchResult',
  SeasonSearchUndoResult: 'SeasonSearchUndoResult',
  CancelledEpisode: 'CancelledEpisode',
  CancelResult: 'CancelResponse',
  ActivityItem: 'ActivityItem',
  ActivityResponse: 'ActivityResponse',
  ApiError: 'ApiError',
  QuotaError: 'QuotaError',
  MeUser: 'MeUser',
  QuotaUse: 'QuotaUse',
  Quota: 'Quota',
  OwnedTitle: 'OwnedTitle',
  MeResponse: 'Me',
  ChartCategory: 'ChartCategory',
  ChartIndex: 'ChartIndex',
  ChartResult: 'ChartResult',
  ChartSection: 'ChartSection',
  Chart: 'Chart',
  CommunitySegment: 'CommunitySegment',
  CommunitySegments: 'SegmentsResponse'
};

/* Routes without a model: the dict literal that IS the payload — file, the function it is in,
 * and the text right before its opening brace (searched from the function's start). */
const LITERALS = [
  { iface: 'ProbeResponse', file: 'backend/src/reel_api/streaming.py', fn: 'def _shape_probe(', before: 'out = ' },
  { iface: 'ProbeVideo', file: 'backend/src/reel_api/streaming.py', fn: 'def _shape_probe(', before: 'out["video"] = ' },
  { iface: 'ProbeAudio', file: 'backend/src/reel_api/streaming.py', fn: 'def _shape_probe(', before: 'out["audio"].append(' },
  { iface: 'ProbeSubtitle', file: 'backend/src/reel_api/streaming.py', fn: 'def _shape_probe(', before: 'out["subtitles"].append(' },
  { iface: 'TrailerStatus', file: 'backend/src/reel_api/trailers.py', fn: 'def status(self)', before: 'return ' },
  { iface: 'LiveHlsStatus', file: 'backend/src/reel_api/livehls.py', fn: 'def status(self)', before: 'return ' }
];

/* Intentional differences, each with its reason: `Interface.key` and which side has it.
 * An entry that stops matching a real difference fails the check (remove it then). */
const ALLOW = [
  // (none yet — every mapped payload matches key for key)
];

let failed = false;
const fail = (m) => { failed = true; console.log('FAIL ' + m); };
const ok = (m) => console.log('ok   ' + m);

/* ---------- backend: pydantic models ---------- */
/** @param {string} src models.py's text */
function pyModels(src) {
  /** @type {Map<string, { bases: string[], fields: string[] }>} */
  const classes = new Map();
  let cur = null;
  for (const line of src.split('\n')) {
    const c = line.match(/^class (\w+)\(([^)]*)\):/);
    if (c) {
      cur = { bases: c[2].split(',').map((b) => b.trim()).filter(Boolean), fields: [] };
      classes.set(c[1], cur);
      continue;
    }
    if (/^\S/.test(line)) { cur = null; continue; }
    // a field: exactly one indent level, `name: annotation` (methods, docstrings, comments skipped)
    const f = cur && line.match(/^ {4}([a-z_][a-z0-9_]*)\s*:\s*[^=]/i);
    if (f && !/^ {4}(def|class|return|if|for)\b/.test(line)) cur.fields.push(f[1]);
  }
  /** @param {string} name @returns {string[] | null} */
  const fieldsOf = (name) => {
    const c = classes.get(name);
    if (!c) return null;
    const own = [...c.fields];
    for (const b of c.bases) {
      if (b === 'BaseModel' || b === 'str' || b === 'Enum') continue;
      const inh = fieldsOf(b);
      if (!inh) return null;
      own.unshift(...inh);
    }
    return [...new Set(own)];
  };
  return fieldsOf;
}

/* ---------- backend: dict literals ---------- */
/** The top-level `"key":` names of the dict literal that opens at text[start] === '{'. */
function dictKeys(text, start) {
  const keys = [];
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (ch === '"' || ch === "'") {
      const q = ch;
      let j = i + 1;
      while (j < text.length && text[j] !== q) j += text[j] === '\\' ? 2 : 1;
      if (depth === 1) {
        const rest = text.slice(j + 1).match(/^\s*:/);
        if (rest) keys.push(text.slice(i + 1, j));
      }
      i = j;
      continue;
    }
    if ('{[('.includes(ch)) depth++;
    else if ('}])'.includes(ch)) {
      depth--;
      if (depth === 0) return keys;
    }
  }
  return null;
}

/** @param {typeof LITERALS[number]} l @returns {string[] | null} */
function literalKeys(l) {
  const text = read(l.file);
  const fn = text.indexOf(l.fn);
  if (fn < 0) return null;
  const at = text.indexOf(l.before, fn);
  if (at < 0) return null;
  const brace = text.indexOf('{', at + l.before.length);
  // the brace must follow the anchor directly (whitespace only in between)
  if (brace < 0 || text.slice(at + l.before.length, brace).trim()) return null;
  return dictKeys(text, brace);
}

/* ---------- client: Reel interfaces ---------- */
/** @param {string} text reel-api.d.ts's text */
function reelInterfaces(text) {
  const sf = ts.createSourceFile('reel-api.d.ts', text, ts.ScriptTarget.Latest, true);
  /** @type {Map<string, { members: string[], ext: string[] }>} */
  const ifaces = new Map();
  const visit = (node, inReel) => {
    if (ts.isModuleDeclaration(node)) {
      const reel = inReel || node.name.text === 'Reel';
      if (node.body) ts.forEachChild(node.body, (n) => visit(n, reel));
      return;
    }
    if (inReel && ts.isInterfaceDeclaration(node)) {
      const members = node.members.map((m) => m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) ? m.name.text : null).filter(Boolean);
      const ext = (node.heritageClauses || []).flatMap((h) => h.types.map((t) => t.expression.getText(sf)));
      const prev = ifaces.get(node.name.text);
      // declaration merging: a second `interface X` block adds to the first
      if (prev) { prev.members.push(...members); prev.ext.push(...ext); }
      else ifaces.set(node.name.text, { members, ext });
    }
  };
  ts.forEachChild(sf, (n) => visit(n, false));
  /** @param {string} name @returns {string[] | null} */
  const membersOf = (name) => {
    const i = ifaces.get(name);
    if (!i) return null;
    const out = [...i.members];
    for (const e of i.ext) {
      const inh = membersOf(e);
      if (!inh) return null;
      out.push(...inh);
    }
    return [...new Set(out)];
  };
  return membersOf;
}

/* ---------- compare ---------- */
/** The problems with one payload (empty = the key sets match).
 * @param {string} label @param {string} iface @param {string[] | null} emitted @param {string[] | null} declared
 * @param {Set<object>} [usedAllow] @returns {string[]} */
function problems(label, iface, emitted, declared, usedAllow = new Set()) {
  if (!emitted) return [`${label}: not found in the backend — update MODELS/LITERALS in types/check-reel-api.mjs`];
  if (!emitted.length) return [`${label}: no keys extracted — the parser no longer understands it`];
  if (!declared) return [`Reel.${iface}: no such interface in types/reel-api.d.ts`];
  const allowed = (key, side) => {
    const a = ALLOW.find((x) => x.iface === iface && x.key === key && x.side === side);
    if (a) usedAllow.add(a);
    return !!a;
  };
  const missing = emitted.filter((k) => !declared.includes(k) && !allowed(k, 'backend'));
  const extra = declared.filter((k) => !emitted.includes(k) && !allowed(k, 'client'));
  const out = [];
  if (missing.length) out.push(`Reel.${iface} lacks ${missing.join(', ')} — emitted by ${label}`);
  if (extra.length) out.push(`Reel.${iface} declares ${extra.join(', ')} — never emitted by ${label}`);
  return out;
}

/* The checker checks itself first, on synthetic inputs whose answer is known: a parser that
 * stops seeing keys, or a compare that stops seeing differences, fails here instead of letting
 * every payload "match". */
function selfTest() {
  const py = [
    'class Base(BaseModel):', '    id: str', '    year: int | None = None  # note', '', '',
    'class Kid(Base):', '    """Doc text: not_a_field: x"""', '', '    name: str', '',
    '    def shape(self) -> dict:', '        inner: int = 1', '        return {}', ''
  ].join('\n');
  const dts = 'declare namespace Reel {\n  interface A { id: string; year?: number | null }\n  interface K extends A { name: string }\n}\n';
  const lit = '{\n  "a": 1,  # "no": 2\n  "b": {"inner": 1},\n  "c": f(x, {"z": 2}),\n}';
  /** @type {Array<[unknown, unknown, string]>} */
  const checks = [
    [JSON.stringify(pyModels(py)('Kid')), JSON.stringify(['id', 'year', 'name']), 'models.py parser (fields + base class)'],
    [JSON.stringify(reelInterfaces(dts)('K')), JSON.stringify(['name', 'id', 'year']), 'reel-api.d.ts parser (members + extends)'],
    [JSON.stringify(dictKeys(lit, 0)), JSON.stringify(['a', 'b', 'c']), 'dict literal parser (top level only)'],
    [problems('t', 'K', ['id', 'name', 'year'], ['id', 'name', 'year']).length, 0, 'equal key sets pass'],
    [problems('t', 'K', ['id', 'name', 'new'], ['id', 'name']).join(), 'Reel.K lacks new — emitted by t', 'a backend-only key fails'],
    [problems('t', 'K', ['id'], ['id', 'gone']).join(), 'Reel.K declares gone — never emitted by t', 'a client-only key fails'],
    [problems('t', 'K', null, ['id']).length, 1, 'a payload the backend lost fails'],
    [problems('t', 'K', [], ['id']).length, 1, 'a payload with no keys extracted fails'],
    [problems('t', 'K', ['id'], null).length, 1, 'a missing interface fails']
  ];
  let bad = 0;
  for (const [got, want, what] of checks) if (got !== want) (bad++, fail(`self-test: ${what} (got ${got}, want ${want})`));
  if (!bad) ok(`self-test: ${checks.length} checks`);
}

selfTest();
const fieldsOf = pyModels(read('backend/src/reel_api/models.py'));
const membersOf = reelInterfaces(read('types/reel-api.d.ts'));
const usedAllow = new Set();
/** @param {string} label @param {string} iface @param {string[] | null} emitted */
function compare(label, iface, emitted) {
  const p = problems(label, iface, emitted, membersOf(iface), usedAllow);
  p.forEach(fail);
  if (!p.length) ok(`Reel.${iface} = ${label} (${emitted.length} keys)`);
  if (LIST && emitted) console.log(`     ${emitted.join(', ')}`);
}
for (const [model, iface] of Object.entries(MODELS)) compare(`models.py ${model}`, iface, fieldsOf(model));
for (const l of LITERALS) compare(`${path.basename(l.file)} ${l.fn.replace(/^def |\($|\(self\)$/g, '')} ${l.before.trim()}`, l.iface, literalKeys(l));
for (const a of ALLOW) if (!usedAllow.has(a)) fail(`ALLOW ${a.iface}.${a.key} (${a.side}) matches no difference any more — remove it`);

console.log(failed ? 'REEL-API DRIFT FAIL' : `REEL-API DRIFT PASS (${Object.keys(MODELS).length + LITERALS.length} payloads)`);
process.exit(failed ? 1 : 0);
