'use strict';
// Spec detection, parsing and line lookup. Pure Node, no VS Code: the worker and the tests use it.
// YAML goes through the `yaml` package (ISC) with a small alias budget, so a "billion laughs" file stops with a
// message instead of eating memory. JSON goes through JSON.parse (fast on 10+ MB files), and a one-pass scanner
// finds the line of a JSON pointer only when a problem needs it.
const YAML = require('../../vendor/yaml');

const MAX_ALIASES = 200;

/** True when the text looks like an OpenAPI or Swagger document: a top-level `openapi:` / `swagger:` key. */
function looksLikeSpec(text) {
  if (typeof text !== 'string') return false;
  const t = text.replace(/^\uFEFF/, '');
  // YAML: a top-level key at column 0, anywhere in the file (some specs put info or components first).
  if (/^["']?(?:openapi|swagger)["']?[ \t]*:/m.test(t.length > 64 * 1048576 ? t.slice(0, 1048576) : t)) return true;
  // JSON: the key can be anywhere, for example last when the keys are sorted (the Kubernetes spec).
  if (/^\s*\{/.test(t)) return /"(?:openapi"\s*:\s*"3\.|swagger"\s*:\s*"2\.0")/.test(t.length > 64 * 1048576 ? t.slice(0, 1048576) + t.slice(-65536) : t);
  return false;
}

function isJsonPath(p) { return /\.json$/i.test(String(p || '')); }

/** { family: '2.0' | '3.0' | '3.1' | '3.2' | 'unknown', label: 'OpenAPI 3.1.0', raw } */
function versionOf(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { family: 'unknown', label: 'Not an OpenAPI document', raw: '' };
  if (data.swagger !== undefined) {
    const raw = String(data.swagger);
    return { family: raw.startsWith('2') ? '2.0' : 'unknown', label: 'Swagger ' + raw, raw };
  }
  if (data.openapi !== undefined) {
    const raw = String(data.openapi);
    const m = /^3\.(\d+)/.exec(raw);
    const fam = m ? (m[1] === '0' ? '3.0' : m[1] === '1' ? '3.1' : m[1] === '2' ? '3.2' : 'unknown') : 'unknown';
    return { family: fam, label: 'OpenAPI ' + raw, raw };
  }
  return { family: 'unknown', label: 'No openapi or swagger field', raw: '' };
}

class ParseError extends Error {
  constructor(message, line, col) { super(message); this.line = line; this.col = col; }
}

/** Line (0-based) and column of a character offset. */
function lineIndex(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return off => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
    return { line: lo, col: off - starts[lo] };
  };
}

/**
 * Parse spec text. Returns { data, locate(paths[]) -> Map(key -> {line, col}) }.
 * Throws ParseError with a 0-based line when the text is not valid YAML/JSON or is an alias bomb.
 */
function parseText(text, opts = {}) {
  const json = opts.json === true || (opts.json !== false && /^\s*[{[]/.test(text.slice(0, 2000)) && isJsonPath(opts.path));
  if (json) {
    let data;
    try { data = JSON.parse(text); }
    catch (e) {
      const msg = String(e.message || e);
      let line = 0, col = 0;
      const lm = /line (\d+) column (\d+)/.exec(msg);
      const pm = /position (\d+)/.exec(msg);
      if (lm) { line = Number(lm[1]) - 1; col = Number(lm[2]) - 1; }
      else if (pm) { const p = lineIndex(text)(Number(pm[1])); line = p.line; col = p.col; }
      else { const off = jsonErrorOffset(text); if (off >= 0) { const p = lineIndex(text)(off); line = p.line; col = p.col; } }
      const short = msg.replace(/^JSON\.parse: /, '').replace(/, "[\s\S]*" is not valid JSON$/, ' (not valid JSON)').slice(0, 300);
      throw new ParseError('JSON: ' + short, line, col);
    }
    return { data, json: true, locate: paths => locateJson(text, paths) };
  }
  const lc = new YAML.LineCounter();
  let doc;
  try {
    doc = YAML.parseDocument(text, { lineCounter: lc, merge: true, uniqueKeys: false, maxAliasCount: MAX_ALIASES, prettyErrors: false, strict: false });
  } catch (e) { throw new ParseError('YAML: ' + String(e.message || e), 0, 0); }
  if (doc.errors && doc.errors.length) {
    const e = doc.errors[0];
    const p = e.pos ? lc.linePos(e.pos[0]) : { line: 1, col: 1 };
    throw new ParseError('YAML: ' + String(e.message).split('\n')[0], p.line - 1, p.col - 1);
  }
  let data;
  try { data = doc.toJS({ maxAliasCount: MAX_ALIASES }); }
  catch (e) {
    const m = String(e.message || e);
    if (/alias/i.test(m)) throw new ParseError('YAML: this file uses too many aliases (*name). It looks like a "billion laughs" file, so it was not expanded.', 0, 0);
    throw new ParseError('YAML: ' + m, 0, 0);
  }
  const locate = paths => {
    const out = new Map();
    for (const p of paths) {
      const r = yamlRange(doc, p);
      if (r != null) { const lp = lc.linePos(r); out.set(pathKey(p), { line: lp.line - 1, col: lp.col - 1 }); }
    }
    return out;
  };
  return { data, json: false, locate };
}

/** Offset of the first JSON syntax error (Node does not always give one), or -1. Iterative, so deep nesting is fine. */
function jsonErrorOffset(t) {
  let i = 0;
  const n = t.length;
  const ws = () => { while (i < n && (t[i] === ' ' || t[i] === '\n' || t[i] === '\r' || t[i] === '\t')) i++; };
  const str = () => { i++; while (i < n) { const c = t[i]; if (c === '\\') i += 2; else if (c === '"') { i++; return true; } else if (c === '\n') return false; else i++; } return false; };
  const lit = () => { const m = /^(-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(t.slice(i, i + 400)); if (!m) return false; i += m[0].length; return true; };
  const stack = [];
  let want = 'value';
  for (;;) {
    ws();
    if (want === 'value') {
      if (i >= n) return i;
      const c = t[i];
      if (c === '{') { i++; ws(); if (t[i] === '}') { i++; want = 'after'; continue; } stack.push('{'); want = 'key'; continue; }
      if (c === '[') { i++; ws(); if (t[i] === ']') { i++; want = 'after'; continue; } stack.push('['); want = 'value'; continue; }
      if (c === '"') { if (!str()) return i; want = 'after'; continue; }
      if (!lit()) return i;
      want = 'after'; continue;
    }
    if (want === 'key') { if (t[i] !== '"' || !str()) return i; ws(); if (t[i] !== ':') return i; i++; want = 'value'; continue; }
    // after a value
    if (!stack.length) { ws(); return i < n ? i : -1; }
    const top = stack[stack.length - 1];
    if (t[i] === ',') { i++; want = top === '{' ? 'key' : 'value'; ws(); continue; }
    if ((top === '{' && t[i] === '}') || (top === '[' && t[i] === ']')) { i++; stack.pop(); continue; }
    return i;
  }
}

const pathKey = p => p.map(String).join('\u0000');

/** Start offset of the key for path p (or of the nearest parent that exists). */
function yamlRange(doc, p) {
  let node = doc.contents;
  let best = node && node.range ? node.range[0] : 0;
  for (const seg of p) {
    if (!node) break;
    if (YAML.isMap(node)) {
      const pair = node.items.find(it => (YAML.isScalar(it.key) ? String(it.key.value) : String(it.key)) === String(seg));
      if (!pair) break;
      if (pair.key && pair.key.range) best = pair.key.range[0];
      node = pair.value;
    } else if (YAML.isSeq(node)) {
      const it = node.items[Number(seg)];
      if (!it) break;
      if (it.range) best = it.range[0];
      node = it;
    } else if (YAML.isAlias(node)) break;
    else break;
  }
  return best;
}

/**
 * One pass over JSON text: the line of the key (or array item) for each wanted path. Paths that do not exist get
 * the line of their nearest existing parent.
 */
function locateJson(text, paths) {
  const want = new Map();
  const depths = new Set();
  for (const p of paths) {
    for (let d = 0; d <= p.length; d++) { want.set(pathKey(p.slice(0, d)), null); depths.add(d); }
  }
  const found = new Map();
  const stack = []; // { arr: bool, key: string|null, index }
  const cur = [];
  let line = 0, lineStart = 0;
  let i = 0;
  const n = text.length;
  const mark = (pos) => {
    if (!depths.has(cur.length)) return;
    const k = pathKey(cur);
    if (want.has(k) && !found.has(k)) found.set(k, { line, col: pos - lineStart });
  };
  mark(0);
  let expectKey = false;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 10) { line++; i++; lineStart = i; continue; }
    if (c === 32 || c === 9 || c === 13) { i++; continue; }
    if (c === 34) { // string
      const start = i;
      i++;
      let s = '';
      let simple = true;
      const from = i;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 92) { simple = false; i += 2; continue; }
        if (d === 34) break;
        i++;
      }
      s = simple ? text.slice(from, i) : (() => { try { return JSON.parse(text.slice(start, i + 1)); } catch { return text.slice(from, i); } })();
      i++;
      const top = stack[stack.length - 1];
      if (top && !top.arr && expectKey) {
        cur.push(s); mark(start); top.key = s; top.hasKey = true; expectKey = false;
      } else if (top && top.arr) { /* value in array */ }
      continue;
    }
    if (c === 58) { i++; continue; } // ':'
    if (c === 123 || c === 91) { // { [
      const top = stack[stack.length - 1];
      const idx = !!(top && top.arr);
      if (idx) { cur.push(String(top.index)); mark(i); }
      stack.push({ arr: c === 91, key: null, index: 0, hasKey: false, idx });
      expectKey = c === 123;
      if (c === 91) { cur.push('0'); mark(i + 1); cur.pop(); }
      i++;
      continue;
    }
    if (c === 125 || c === 93) { // } ]
      const fr = stack.pop();
      if (fr && !fr.arr && fr.hasKey) cur.pop();
      if (fr && fr.idx) cur.pop();
      expectKey = false;
      i++;
      continue;
    }
    if (c === 44) { // ,
      const top = stack[stack.length - 1];
      if (top && top.arr) { top.index++; cur.push(String(top.index)); mark(i + 1); cur.pop(); }
      else if (top && top.hasKey) { cur.pop(); top.hasKey = false; expectKey = true; }
      else if (top) expectKey = true;
      i++;
      continue;
    }
    // literal (number, true, false, null)
    while (i < n) { const d = text.charCodeAt(i); if (d === 44 || d === 125 || d === 93 || d === 10 || d === 32 || d === 9 || d === 13) break; i++; }
  }
  const out = new Map();
  for (const p of paths) {
    let hit = null;
    for (let d = p.length; d >= 0 && !hit; d--) hit = found.get(pathKey(p.slice(0, d)));
    if (hit) out.set(pathKey(p), hit);
  }
  return out;
}

/** JSON pointer fragment ("/a/b~1c") to path segments. */
function pointerToPath(frag) {
  if (!frag || frag === '/') return frag === '/' ? [''] : [];
  if (frag[0] !== '/') return null;
  return frag.slice(1).split('/').map(s => {
    let t = s;
    try { t = decodeURIComponent(s); } catch {}
    return t.replace(/~1/g, '/').replace(/~0/g, '~');
  });
}

function pathToPointer(p) { return p.length ? '/' + p.map(s => String(s).replace(/~/g, '~0').replace(/\//g, '~1')).join('/') : ''; }

const own = Object.prototype.hasOwnProperty;
/** Value at path, or undefined. Own properties only. */
function getPath(data, p) {
  let v = data;
  for (const seg of p) {
    if (v === null || typeof v !== 'object') return undefined;
    if (Array.isArray(v)) { if (!/^\d+$/.test(seg)) return undefined; v = v[Number(seg)]; }
    else { if (!own.call(v, seg)) return undefined; v = v[seg]; }
  }
  return v;
}

module.exports = { looksLikeSpec, isJsonPath, versionOf, parseText, ParseError, locateJson, pointerToPath, pathToPointer, getPath, pathKey, lineIndex, jsonErrorOffset, MAX_ALIASES };
