'use strict';
// Where is the cursor in the spec? Pure Node, no VS Code, no full parse: a 5 MB YAML or 6 MB JSON file answers in a
// few milliseconds. pathAt() gives the JSON path of the key or value under the cursor. scanYaml() walks YAML keys
// forward (outline, go to definition) without building the whole document.

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

// ---- YAML line model -------------------------------------------------------------------------------------------------
const RE_DQ_KEY = /^"((?:[^"\\]|\\.)*)"[ \t]*:(?=[ \t]|$)/;
const RE_SQ_KEY = /^'((?:[^']|'')*)'[ \t]*:(?=[ \t]|$)/;
const RE_PLAIN_KEY = /^([^\s#'"[\]{},&*!|>%@`?](?:[^#\n]*?[^\s])??)[ \t]*:(?=[ \t]|$)/;
const RE_BLOCK = /^[|>][-+0-9]*[ \t]*(?:#.*)?$/;

function unquoteDq(s) { try { return JSON.parse('"' + s + '"'); } catch { return s; } }

/**
 * One YAML line: { ind, entries: [{ col, kind: 'seq' } | { col, kind: 'key', key, rest, end }], textCol, empty }.
 * `rest` is the inline value after the colon, without a trailing comment. textCol is where non-key content starts.
 */
function parseLine(line) {
  let ind = 0;
  while (ind < line.length && line.charCodeAt(ind) === 32) ind++;
  const out = { ind, entries: [], textCol: -1, empty: false };
  if (ind >= line.length || line[ind] === '#' || line[ind] === '\r') { out.empty = true; return out; }
  let pos = ind;
  if ((line.startsWith('---', pos) || line.startsWith('...', pos)) && pos === 0 && (line.length === 3 || /\s/.test(line[3]))) { out.doc = true; return out; }
  while (line[pos] === '-' && (pos + 1 >= line.length || line[pos + 1] === ' ' || line[pos + 1] === '\r')) {
    out.entries.push({ col: pos, kind: 'seq' });
    pos++;
    while (line[pos] === ' ') pos++;
  }
  if (pos >= line.length || line[pos] === '\r' || line[pos] === '#') return out;
  const s = line.slice(pos);
  let m = RE_DQ_KEY.exec(s), key;
  if (m) key = unquoteDq(m[1]);
  else if ((m = RE_SQ_KEY.exec(s))) key = m[1].replace(/''/g, "'");
  else if ((m = RE_PLAIN_KEY.exec(s))) key = m[1];
  if (m) {
    let rest = s.slice(m[0].length).trim();
    if (rest[0] !== '"' && rest[0] !== "'") { const h = rest.search(/(^|\s)#/); if (h >= 0) rest = rest.slice(0, h).trim(); }
    out.entries.push({ col: pos, kind: 'key', key, rest, end: pos + m[0].length - 1, raw: m[0].slice(0, m[0].lastIndexOf(':')).trimEnd() });
  } else out.textCol = pos;
  return out;
}

/** Open minus closed brackets in a line of a flow collection, outside quotes. */
function bracketDelta(s) {
  let d = 0, q = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '\\' && q === '"') i++; else if (ch === q) q = ''; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if (ch === '{' || ch === '[') d++;
    else if (ch === '}' || ch === ']') d--;
    else if (ch === '#' && (i === 0 || s[i - 1] === ' ')) break;
  }
  return d;
}

const isBlock = rest => RE_BLOCK.test(rest || '');

// ---- YAML: backward scan from the cursor ---------------------------------------------------------------------------
function yamlPathAt(text, offset) {
  offset = Math.max(0, Math.min(offset, text.length));
  let ls = text.lastIndexOf('\n', offset - 1) + 1;
  let le = text.indexOf('\n', offset); if (le < 0) le = text.length;
  const col = offset - ls;
  const cur = parseLine(text.slice(ls, le));
  const rev = []; // path segments, innermost first
  // Pending: the node we need the parent of. { col, kind }
  let need;
  const keyE = cur.entries.find(e => e.kind === 'key');
  const seqs = cur.entries.filter(e => e.kind === 'seq' && e.col < col);
  if (keyE && col >= keyE.col) { rev.push(keyE.key); need = { col: keyE.col, kind: 'key' }; }
  else if (seqs.length) need = null;
  else need = { col: Math.min(col, cur.empty ? col : (cur.textCol >= 0 ? cur.textCol : cur.ind)), kind: 'key' };
  // Dashes on the cursor line, innermost first: inner ones are item 0 of a nested sequence.
  if (seqs.length) {
    for (let k = seqs.length - 1; k >= 1; k--) rev.push(0);
    need = { col: seqs[0].col, kind: 'seq', count: 0 };
  }
  let lineEnd = ls - 1; // the '\n' before the cursor line
  while (need && lineEnd >= 0) {
    if (need.kind === 'key' && need.col <= 0) break; // a top-level key: its parent is the root
    const s = text.lastIndexOf('\n', lineEnd - 1) + 1;
    const lineStop = lineEnd;
    lineEnd = s - 1;
    // Cheap indent check first: most lines above are deeper than what we look for.
    let ind = s;
    while (ind < lineStop && text.charCodeAt(ind) === 32) ind++;
    const ch = text.charCodeAt(ind);
    if (ind >= lineStop || ch === 35 || ch === 13) continue; // blank or comment
    const lim = need.kind === 'seq' ? need.col : need.col - 1;
    if (ind - s > lim) continue;
    const p = parseLine(text.slice(s, lineStop));
    if (p.doc) break;
    if (p.empty) continue;
    if (need.kind === 'seq') {
      const sc = need.col;
      if (p.ind > sc) continue;
      const first = p.entries[0];
      if (p.ind === sc && first && first.kind === 'seq') { need.count++; continue; }
      // The parent: a key at the same column (compact sequence) or the rightmost entry left of sc.
      rev.push(need.count);
      let parent = null;
      if (p.ind === sc && first && first.kind === 'key') parent = first;
      else { for (const e of p.entries) if (e.col < sc) parent = e; }
      if (!parent) { need = null; break; }
      need = takeParent(p, parent, rev);
      continue;
    }
    // need.kind === 'key'
    if (p.ind >= need.col) continue;
    let parent = null;
    for (const e of p.entries) if (e.col < need.col) parent = e;
    if (!parent) continue; // a continuation line of a plain scalar
    need = takeParent(p, parent, rev);
  }
  return rev.reverse();
}

/** Records parent entry `e` (on parsed line p) and returns what to look for next. */
function takeParent(p, e, rev) {
  if (e.kind === 'key') {
    if (isBlock(e.rest)) rev.length = 0; // the cursor was inside a block scalar: it is part of this value
    rev.push(e.key);
    const idx = p.entries.indexOf(e);
    const before = p.entries.slice(0, idx);
    if (before.length) {
      for (let k = before.length - 1; k >= 1; k--) rev.push(0);
      return { col: before[0].col, kind: 'seq', count: 0 };
    }
    return { col: e.col, kind: 'key' };
  }
  // a dash: the node is item N of the sequence that starts at e.col
  const idx = p.entries.indexOf(e);
  for (let k = idx; k >= 1; k--) rev.push(0);
  return { col: p.entries[0].col, kind: 'seq', count: 0 };
}

// ---- YAML: forward scan ---------------------------------------------------------------------------------------------
/**
 * Walks the keys of a YAML text in order. onKey(path, line, col, rest) is called for each key (path includes the key);
 * return false to stop. Sequence items get numeric segments. opts.maxDepth skips keys deeper than that (still walks).
 */
function scanYaml(text, onKey, opts = {}) {
  const maxDepth = opts.maxDepth || Infinity;
  const stack = []; // { col, kind, seg }
  let pos = 0, line = 0;
  let blockCol = -1; // inside a block scalar whose key is at this column
  let flow = 0; // open brackets of a flow collection ({ or [) that spans lines
  const n = text.length;
  while (pos <= n) {
    let e = text.indexOf('\n', pos); if (e < 0) e = n;
    const raw = text.slice(pos, e);
    const lineNo = line;
    pos = e + 1; line++;
    if (flow > 0) { flow += bracketDelta(raw); if (e >= n) break; continue; }
    if (blockCol >= 0) {
      let ind = 0; while (ind < raw.length && raw.charCodeAt(ind) === 32) ind++;
      if (ind >= raw.length || raw[ind] === '\r' || ind > blockCol) { if (e >= n) break; continue; }
      blockCol = -1;
    }
    const p = parseLine(raw);
    if (p.doc) { stack.length = 0; if (e >= n) break; continue; }
    if (!p.empty) {
      for (const en of p.entries) {
        if (en.kind === 'seq') {
          while (stack.length && stack[stack.length - 1].col > en.col) stack.pop();
          const top = stack[stack.length - 1];
          if (top && top.kind === 'seq' && top.col === en.col) top.seg++;
          else stack.push({ col: en.col, kind: 'seq', seg: 0 });
        } else {
          while (stack.length && stack[stack.length - 1].col >= en.col) stack.pop();
          stack.push({ col: en.col, kind: 'key', seg: en.key });
          if (stack.length <= maxDepth) {
            if (onKey(stack.map(x => x.seg), lineNo, en.col, en.rest, en) === false) return;
          }
          if (isBlock(en.rest)) blockCol = en.col;
          else if (en.rest && (en.rest[0] === '{' || en.rest[0] === '[')) flow = Math.max(0, bracketDelta(en.rest));
        }
      }
      if (p.textCol >= 0 && (raw[p.textCol] === '{' || raw[p.textCol] === '[')) flow = Math.max(0, bracketDelta(raw.slice(p.textCol)));
    }
    if (e >= n) break;
  }
}

/** { line, col, exact } of the key at `path` in YAML text (or of its nearest found parent: exact false), or null. */
function yamlFind(text, path) {
  const want = path.map(String);
  let best = null, bestLen = -1;
  scanYaml(text, (p, line, col) => {
    let k = 0;
    while (k < p.length && k < want.length && String(p[k]) === want[k]) k++;
    if (k === p.length && k > bestLen) { best = { line, col, exact: k === want.length }; bestLen = k; if (k === want.length) return false; }
    return undefined;
  }, { maxDepth: want.length });
  if (!want.length) return { line: 0, col: 0, exact: true };
  return best;
}

// ---- JSON: forward scan to the cursor -------------------------------------------------------------------------------
// The stack lives in typed arrays (no allocation per object). Checkpoints of the last text scanned let a cursor move
// in the same 6 MB file restart from the nearest one.
const CHECK_EVERY = 262144;
let jsonCache = { text: null, checks: [] };
let ARR = new Uint8Array(1024), IDX = new Int32Array(1024), KA = new Int32Array(1024), KB = new Int32Array(1024);

function grow() {
  const n = ARR.length * 2;
  const a = new Uint8Array(n); a.set(ARR); ARR = a;
  const b = new Int32Array(n); b.set(IDX); IDX = b;
  const c = new Int32Array(n); c.set(KA); KA = c;
  const d = new Int32Array(n); d.set(KB); KB = d;
}

function jsonPathAt(text, offset) {
  offset = Math.max(0, Math.min(offset, text.length));
  if (jsonCache.text !== text) jsonCache = { text, checks: [] };
  const checks = jsonCache.checks;
  let depth = 0, i = 0, expectKey = false;
  for (let k = checks.length - 1; k >= 0; k--) {
    const c = checks[k];
    if (c.i <= offset) {
      i = c.i; expectKey = c.expectKey; depth = c.depth;
      while (ARR.length < depth + 1) grow();
      ARR.set(c.arr); IDX.set(c.idx); KA.set(c.ka); KB.set(c.kb);
      break;
    }
  }
  let nextCheck = (Math.floor(i / CHECK_EVERY) + 1) * CHECK_EVERY;
  while (i < offset) {
    const c = text.charCodeAt(i);
    if (c <= 32) { i++; continue; }
    if (i >= nextCheck) {
      if (!checks.length || checks[checks.length - 1].i < i) {
        checks.push({ i, expectKey, depth, arr: ARR.slice(0, depth), idx: IDX.slice(0, depth), ka: KA.slice(0, depth), kb: KB.slice(0, depth) });
      }
      nextCheck = (Math.floor(i / CHECK_EVERY) + 1) * CHECK_EVERY;
    }
    if (c === 34) { // "
      let j = i + 1;
      for (;;) {
        j = text.indexOf('"', j);
        if (j < 0) { j = text.length; break; }
        if (text.charCodeAt(j - 1) !== 92) break;
        let b = 1; while (text.charCodeAt(j - 1 - b) === 92) b++;
        if (b % 2 === 0) break;
        j++;
      }
      const isKey = depth > 0 && ARR[depth - 1] === 0 && expectKey;
      if (isKey) { KA[depth - 1] = i; KB[depth - 1] = j; expectKey = false; }
      if (j >= offset) return framesPath(depth, text);
      i = j + 1;
      continue;
    }
    if (c === 123 || c === 91) {
      if (depth + 1 >= ARR.length) grow();
      ARR[depth] = c === 91 ? 1 : 0; IDX[depth] = 0; KA[depth] = -1; KB[depth] = -1; depth++;
      expectKey = c === 123; i++; continue;
    }
    if (c === 125 || c === 93) { if (depth > 0) depth--; expectKey = false; i++; continue; }
    if (c === 44) {
      if (depth > 0) { const t = depth - 1; if (ARR[t]) IDX[t]++; else { KA[t] = -1; expectKey = true; } }
      i++; continue;
    }
    i++;
  }
  return framesPath(depth, text);
}

function decodeJsonString(text, a, b) {
  const s = text.slice(a + 1, b);
  if (s.indexOf('\\') < 0) return s;
  try { return JSON.parse('"' + s + '"'); } catch { return s; }
}

function framesPath(depth, text) {
  const out = [];
  for (let f = 0; f < depth; f++) {
    if (ARR[f]) out.push(IDX[f]);
    else if (KA[f] >= 0) out.push(decodeJsonString(text, KA[f], KB[f]));
    else break;
  }
  return out;
}

/** Keys already in the JSON object around offset, from a local scan both ways (works while the text is not valid). */
function jsonSiblingKeys(text, offset, limit = 262144) {
  const keys = new Set();
  const escaped = q => { let b = 0; while (text.charCodeAt(q - 1 - b) === 92) b++; return b % 2 === 1; };
  const isKeyAt = end => { let k = end + 1; while (k < text.length && /\s/.test(text[k])) k++; return text[k] === ':'; };
  // Backward to the opening brace.
  let depth = 0;
  for (let i = offset - 1, stop = Math.max(0, offset - limit); i >= stop; i--) {
    const c = text[i];
    if (c === '"' && !escaped(i)) {
      let a = i - 1;
      while (a >= 0 && !(text[a] === '"' && !escaped(a))) a--;
      if (depth === 0 && isKeyAt(i)) keys.add(decodeJsonString(text, a, i));
      i = a;
      continue;
    }
    if (c === '}' || c === ']') depth++;
    else if (c === '{' || c === '[') { if (depth === 0) break; depth--; }
  }
  // Forward to the closing brace.
  depth = 0;
  for (let i = offset, stop = Math.min(text.length, offset + limit); i < stop; i++) {
    const c = text[i];
    if (c === '"') {
      let b = i + 1;
      while (b < text.length && !(text[b] === '"' && !escaped(b))) b++;
      if (depth === 0 && isKeyAt(b)) keys.add(decodeJsonString(text, i, b));
      i = b;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { if (depth === 0) break; depth--; }
  }
  return keys;
}

/** JSON path of the key or value under the cursor. */
function pathAt(text, offset, isJson) {
  if (typeof text !== 'string') return [];
  return isJson ? jsonPathAt(text, offset) : yamlPathAt(text, offset);
}

/** What the preview should show for a cursor path, or null. */
function previewTarget(path, family) {
  if (!Array.isArray(path) || !path.length) return null;
  const [a, b, c] = path.map(String);
  if (a === 'paths' && b && b.startsWith('/')) {
    if (c && METHODS.includes(c.toLowerCase())) return { kind: 'operation', apiPath: b, method: c.toLowerCase() };
    return { kind: 'operation', apiPath: b, method: null };
  }
  if (a === 'webhooks' && b && family !== '2.0') return { kind: 'webhook', name: b, method: c && METHODS.includes(c.toLowerCase()) ? c.toLowerCase() : null };
  if (a === 'components' && b === 'schemas' && c) return { kind: 'schema', name: c };
  if (a === 'definitions' && b && family !== '3.0' && family !== '3.1') return { kind: 'schema', name: b };
  if (a === 'info' || a === 'openapi' || a === 'swagger') return { kind: 'info' };
  return null;
}

module.exports = { pathAt, yamlPathAt, jsonPathAt, jsonSiblingKeys, previewTarget, scanYaml, yamlFind, parseLine, isBlock, METHODS };
