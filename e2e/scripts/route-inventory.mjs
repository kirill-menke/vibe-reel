#!/usr/bin/env node
/* Static inventory of every server route the apps can request: the Jellyfin
 * and reel-api path literals in src/**.{js,svelte} and phone/src/**, read as
 * TEXT (no product module is imported). Each request path is reconstructed
 * from its `+` chain or template literal — `'/Items/' + id + '/PlaybackInfo'`,
 * `` `${cfg.server}/MediaSegments/${id}` ``, `base + '/subs.vtt'` with `base`
 * a path assigned earlier in the same file — into a shape like
 * `/Items/{}/PlaybackInfo` (the query string is dropped: `qs(…)`, `'?…'`).
 * When the chain is the first argument of api()/mlFetch()/fetch() with an
 * inline `method: '…'`, the method is recorded too.
 *
 *   node e2e/scripts/route-inventory.mjs          print the inventory
 *   inventory() → [{ kind: 'jf'|'ml', shape, method|null, sites: ['file:line', …] }]
 *
 * Comments are stripped by a small lexer (strings, templates, regex literals);
 * in .svelte files only <script> blocks and markup {expressions} are read. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '..', '..');
const ROOTS = ['src', 'phone/src'];

/* a Jellyfin path starts with /PascalCase; a reel-api path with /api/ */
const JF = /^\/[A-Z][A-Za-z]+(?:[/?.]|$)/;
const ML = /^\/api(?:\/|$)/;

function files() {
  const out = [];
  const walk = (d) => {
    for (const f of readdirSync(d).sort()) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) {
        if (f !== 'node_modules' && f !== 'vendor') walk(p);
      } else if (/\.(js|mjs|svelte)$/.test(f)) out.push(p);
    }
  };
  for (const r of ROOTS) walk(path.join(REPO, r));
  return out;
}

/* ---- lexer: tokens { t: 'str'|'tpl'|'id'|'p', v, line } (comments dropped) ---- */
const PUNCT_BEFORE_REGEX = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '=>', '&&', '||', '??', '==', '===', '!=', '!==']);
const KW_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'await', 'yield']);

export function lex(src, line0 = 1) {
  const toks = [];
  let i = 0;
  let line = line0;
  const n = src.length;
  const prevAllowsRegex = () => {
    const p = toks[toks.length - 1];
    if (!p) return true;
    if (p.t === 'p') return PUNCT_BEFORE_REGEX.has(p.v);
    if (p.t === 'id') return KW_BEFORE_REGEX.has(p.v);
    return false;
  };
  while (i < n) {
    const c = src[i];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      line += (src.slice(i, end).match(/\n/g) || []).length;
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let v = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') {
          v += src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === '\n') break;
        v += src[j++];
      }
      toks.push({ t: 'str', v, line });
      i = j + 1;
      continue;
    }
    if (c === '`') {
      // template: static parts + nested expressions (lexed recursively)
      const parts = [];
      const exprs = [];
      let cur = '';
      let j = i + 1;
      const startLine = line;
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') {
          cur += src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === '$' && src[j + 1] === '{') {
          parts.push(cur);
          cur = '';
          let depth = 1;
          let k = j + 2;
          while (k < n && depth) {
            if (src[k] === '{') depth++;
            else if (src[k] === '}') depth--;
            else if (src[k] === '`' || src[k] === "'" || src[k] === '"') {
              // skip nested strings crudely
              const q = src[k];
              k++;
              while (k < n && src[k] !== q) k += src[k] === '\\' ? 2 : 1;
            }
            if (depth) k++;
          }
          exprs.push(lex(src.slice(j + 2, k), line));
          line += (src.slice(j, k).match(/\n/g) || []).length;
          j = k + 1;
          continue;
        }
        if (src[j] === '\n') line++;
        cur += src[j++];
      }
      parts.push(cur);
      toks.push({ t: 'tpl', parts, exprs, line: startLine });
      i = j + 1;
      continue;
    }
    if (c === '/' && prevAllowsRegex()) {
      let j = i + 1;
      let cls = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '[') cls = true;
        else if (src[j] === ']') cls = false;
        else if (src[j] === '/' && !cls) break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/i.test(src[j])) j++;
      toks.push({ t: 'p', v: 'regex', line });
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[\w.]/.test(src[j])) j++;
      toks.push({ t: 'num', v: src.slice(i, j), line });
      i = j;
      continue;
    }
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    const op = ['===', '!==', '...', '?.('].includes(three) ? three : ['=>', '&&', '||', '??', '==', '!=', '?.', '+=', '<=', '>='].includes(two) ? two : c;
    toks.push({ t: 'p', v: op, line });
    i += op.length;
  }
  return toks;
}

/* ---- chains ---- */
const OPEN = { '(': ')', '[': ']', '{': '}' };

/* index just past the balanced group starting at toks[i] (an opener) */
function skipGroup(toks, i) {
  const close = OPEN[toks[i].v];
  let depth = 0;
  for (let k = i; k < toks.length; k++) {
    if (toks[k].t !== 'p') continue;
    if (toks[k].v === toks[i].v) depth++;
    else if (toks[k].v === close && --depth === 0) return k + 1;
  }
  return toks.length;
}

/* operand at i → { end, piece } where piece is { lit } | { tpl } | { name, call } | { dyn } */
function operand(toks, i) {
  const t = toks[i];
  if (!t) return null;
  if (t.t === 'str') return { end: i + 1, piece: { lit: t.v } };
  if (t.t === 'tpl') return { end: i + 1, piece: { tpl: t } };
  if (t.t === 'num') return { end: i + 1, piece: { dyn: true } };
  if (t.t === 'p' && t.v === '(') {
    // a parenthesised operand, incl. a JSDoc cast `/** @type {T} */ (t).id` (the
    // comment is already dropped): its member accesses / calls belong to it too
    let j = skipGroup(toks, i);
    for (;;) {
      const x = toks[j];
      if (x && x.t === 'p' && (x.v === '.' || x.v === '?.') && toks[j + 1]?.t === 'id') j += 2;
      else if (x && x.t === 'p' && (x.v === '(' || x.v === '?.(' || x.v === '[')) j = skipGroup(toks, j);
      else break;
    }
    return { end: j, piece: { dyn: true } };
  }
  if (t.t !== 'id') return null;
  let j = i + 1;
  let name = t.v;
  let call = false;
  for (;;) {
    const x = toks[j];
    if (x && x.t === 'p' && (x.v === '.' || x.v === '?.') && toks[j + 1]?.t === 'id') {
      name += '.' + toks[j + 1].v;
      j += 2;
    } else if (x && x.t === 'p' && (x.v === '(' || x.v === '?.(')) {
      call = true;
      j = skipGroup(toks, x.v === '?.(' ? j : j);
    } else if (x && x.t === 'p' && x.v === '[') {
      j = skipGroup(toks, j);
    } else break;
  }
  return { end: j, piece: { name, call } };
}

function chainAt(toks, i) {
  const pieces = [];
  let o = operand(toks, i);
  if (!o) return null;
  pieces.push(o.piece);
  let end = o.end;
  while (toks[end] && toks[end].t === 'p' && toks[end].v === '+') {
    const nx = operand(toks, end + 1);
    if (!nx) break;
    pieces.push(nx.piece);
    end = nx.end;
  }
  return { pieces, end };
}

/* pieces → shape string (or null when no path piece is in it) */
function shapeOf(pieces, vars) {
  let s = null;
  let kind = null;
  const startWith = (p) => {
    if (JF.test(p)) return 'jf';
    if (ML.test(p)) return 'ml';
    return null;
  };
  for (const p of pieces) {
    if (s === null) {
      // find where the path starts: a literal / template part / known variable
      let lit = null;
      if (p.lit !== undefined) lit = p.lit;
      else if (p.tpl) lit = tplShape(p.tpl);
      else if (p.name && vars.has(p.name)) {
        const v = vars.get(p.name);
        s = v.shape;
        kind = v.kind;
        continue;
      }
      if (lit !== null) {
        const st = lit.replace(/^\{\}/, '');
        const k = startWith(st);
        if (k) {
          s = st;
          kind = k;
        }
      }
      continue;
    }
    if (/[?&]/.test(s)) break; // already in the query
    if (p.lit !== undefined) {
      if (/^[?&#]/.test(p.lit)) break;
      s += p.lit;
    } else if (p.tpl) s += tplShape(p.tpl);
    else if (p.name === 'qs' || /(^|\.)(qs|query|params|search)$/i.test(p.name || '')) break;
    else s += '{}';
  }
  if (s === null) return null;
  s = s.replace(/[?#].*$/, '');
  return { kind, shape: s };
}

function tplShape(t) {
  let s = '';
  t.parts.forEach((p, k) => {
    s += p;
    if (k < t.exprs.length) s += '{}';
  });
  return s;
}

/* the method from a call's options object: api(path, { method: 'POST' }) */
function methodAfter(toks, end) {
  if (!(toks[end]?.t === 'p' && toks[end].v === ',')) return null;
  if (!(toks[end + 1]?.t === 'p' && toks[end + 1].v === '{')) return null;
  const close = skipGroup(toks, end + 1);
  for (let k = end + 2; k < close - 2; k++) {
    if (toks[k].t === 'id' && toks[k].v === 'method' && toks[k + 1].v === ':' && toks[k + 2].t === 'str') return toks[k + 2].v.toUpperCase();
  }
  return null;
}

/* the variable a chain at i is assigned to: `x = <chain>`, `const x = cond ? <chain> : …`,
 * `const x = () => <chain>` */
function declBefore(toks, i) {
  for (let k = i - 1, n = 0; k >= 1 && n < 8; k--, n++) {
    const t = toks[k];
    if (t.t === 'p' && t.v === '=' && toks[k - 1]?.t === 'id') return toks[k - 1].v;
    if (t.t === 'p' && t.v === '=>') {
      // () => chain
      if (toks[k - 1]?.v === ')' && toks[k - 2]?.v === '(' && toks[k - 3]?.v === '=' && toks[k - 4]?.t === 'id') return toks[k - 4].v;
      return null;
    }
    if (t.t === 'p' && !['?', '.', '!', '?.'].includes(t.v)) return null;
  }
  return null;
}

function scan(toks, rel, out, vars, record) {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === 'tpl') for (const e of t.exprs) scan(e, rel, out, vars, record);
    if (!['str', 'tpl', 'id'].includes(t.t)) continue;
    const ch = chainAt(toks, i);
    if (!ch) continue;
    // a path variable on its own (`base` as an assignment target, `fetch(url)`)
    // adds nothing its own assignment didn't record; only `base + '/x'` extends it
    const varLed = ch.pieces[0].name && vars.has(ch.pieces[0].name);
    if (varLed && ch.pieces.length < 2) continue;
    if (varLed && !record) vars.extended.add(ch.pieces[0].name);
    const sh = shapeOf(ch.pieces, vars);
    if (!sh) continue;
    const declName = declBefore(toks, i);
    if (declName && !record) vars.set(declName, sh);
    const callee = toks[i - 2]?.t === 'id' && toks[i - 1]?.v === '(' ? toks[i - 2].v : null;
    const method = callee && /^(api|mlFetch|fetch|req)$/.test(callee) ? methodAfter(toks, ch.end) : null;
    if (record) {
      // a base that is only ever extended (`base() + path`) is a prefix: `/api/push{}`
      let shape = declName && vars.extended.has(declName) ? sh.shape + '{}' : sh.shape;
      if (shape.endsWith('/')) shape += '{}';
      out.push({ kind: sh.kind, shape, method, site: rel + ':' + t.line });
    }
    i = ch.end - 1;
  }
}

function svelteParts(src) {
  src = src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  const parts = [];
  // <script> blocks
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  let markup = src;
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length;
    parts.push({ code: m[1], line });
    markup = markup.slice(0, m.index) + m[0].replace(/[^\n]/g, ' ') + markup.slice(m.index + m[0].length);
  }
  // markup {expressions}
  markup = markup.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, (x) => x.replace(/[^\n]/g, ' '));
  for (let i = 0; i < markup.length; i++) {
    if (markup[i] !== '{') continue;
    let depth = 0;
    let k = i;
    for (; k < markup.length; k++) {
      if (markup[k] === '{') depth++;
      else if (markup[k] === '}' && --depth === 0) break;
    }
    parts.push({ code: markup.slice(i + 1, k), line: markup.slice(0, i).split('\n').length });
    i = k;
  }
  return parts;
}

export function inventory() {
  const raw = [];
  for (const f of files()) {
    const rel = path.relative(REPO, f);
    const src = readFileSync(f, 'utf8');
    const vars = Object.assign(new Map(), { extended: new Set() });
    const parts = f.endsWith('.svelte') ? svelteParts(src) : [{ code: src, line: 1 }];
    const lexed = parts.map((p) => lex(p.code, p.line));
    for (let pass = 0; pass < 2; pass++) for (const toks of lexed) scan(toks, rel, raw, vars, false); // path variables (twice: uses may precede the declaration)
    for (const toks of lexed) scan(toks, rel, raw, vars, true);
  }
  const by = new Map();
  for (const r of raw) {
    const key = r.kind + ' ' + (r.method || '*') + ' ' + r.shape;
    if (!by.has(key)) by.set(key, { kind: r.kind, method: r.method, shape: r.shape, sites: [] });
    by.get(key).sites.push(r.site);
  }
  return [...by.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.shape.localeCompare(b.shape) || String(a.method).localeCompare(String(b.method)));
}

/* Does a shape name one of these route templates ([{ method, tpl }])? A `{}`
 * stands for one path segment (or the rest of one: `stream.{}`); a `{}` glued
 * to a literal (`base() + path`) may be anything, slashes included. Matched both
 * ways (the shape's regex against the template, the template's regex against a
 * sample of the shape). method null = any; HEAD is served by GET. */
export function matchTemplates(shape, method, templates, { ci = false } = {}) {
  const esc = (x) => x.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  let shapeRe = '';
  let k = 0;
  for (const part of shape.split('{}')) {
    if (k++ > 0) shapeRe += /[/.]$|^$/.test(shapeRe.slice(-2).replace(/\\/g, '')) || shapeRe.endsWith('/') ? '[^/]+' : '.*';
    shapeRe += esc(part);
  }
  const sre = new RegExp('^' + shapeRe + '$', ci ? 'i' : '');
  const sampleOf = (x) => x.replace(/\{[^}]*\}/g, 'x0e2e');
  const hits = [];
  for (const t of templates) {
    if (method && !(t.method === method || (method === 'HEAD' && t.method === 'GET'))) continue;
    const tre = new RegExp('^' + t.tpl.split(/\{[^}]+\}/).map(esc).join('[^/]+') + '$', ci ? 'i' : '');
    if (sre.test(sampleOf(t.tpl)) || tre.test(sampleOf(shape))) hits.push(t);
  }
  return hits;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inv = inventory();
  for (const r of inv) console.log(`${r.kind}  ${(r.method || '*').padEnd(6)} ${r.shape.padEnd(64)} ${r.sites.slice(0, 3).join(', ')}${r.sites.length > 3 ? ` +${r.sites.length - 3}` : ''}`);
  console.log(`${inv.filter((r) => r.kind === 'jf').length} Jellyfin + ${inv.filter((r) => r.kind === 'ml').length} reel-api request shapes`);
}
