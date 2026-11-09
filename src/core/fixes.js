'use strict';
// Quick fixes for lint issues, as plain text edits. Pure Node, no VS Code: src/lintfix.js turns them into
// WorkspaceEdits and the tests apply them to text. Every edit is computed from the current text of the file the issue
// is in (YAML: from the indentation; JSON: with a small scanner that skips strings), and a fix is offered only when
// the text at the issue's line looks as expected.
const YAML = require('../../vendor/yaml');
const { lineIndex } = require('./spec');

const METHOD_RE = /^(\s*)(?:"|')?(get|put|post|delete|options|head|patch|trace|query)(?:"|')?\s*:/;

function lines(text) { return text.split('\n'); }
const indentOf = s => /^[ \t]*/.exec(s)[0];
const blank = s => /^\s*(#.*)?$/.test(s);

/** YAML: first child line indent of the block key at `line`, or key indent + 2. Null when the value is inline (flow or scalar). */
function yamlChildIndent(ls, line) {
  const keyLine = ls[line];
  const keyIndent = indentOf(keyLine).length;
  const after = keyLine.replace(/^\s*(?:-\s+)?/, '').replace(/^("[^"]*"|'[^']*'|[^:#]+?)\s*:/, '');
  if (after.replace(/#.*$/, '').trim() !== '') return null; // inline value
  for (let i = line + 1; i < ls.length; i++) {
    if (blank(ls[i])) continue;
    const ind = indentOf(ls[i]);
    return ind.length > keyIndent ? ind : ' '.repeat(keyIndent + 2);
  }
  return ' '.repeat(keyIndent + 2);
}

function yamlScalar(v) {
  const s = String(v);
  if (s === '') return "''";
  if (/^[A-Za-z_][A-Za-z0-9_.\-]*$/.test(s) && !/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return s;
  return "'" + s.replace(/'/g, "''") + "'";
}

/** Offset just after the "{" that opens the JSON value whose key is on `line` (searching from col). -1 if not found. */
function jsonOpenBrace(text, starts, line, col) {
  let i = starts[line] + (col || 0);
  // skip the key string
  if (text[i] === '"') { i++; while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; } i++; }
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] === ':') { i++; while (i < text.length && /\s/.test(text[i])) i++; }
  return text[i] === '{' ? i + 1 : -1;
}

/** End offset (exclusive) of the JSON value starting at i. */
function jsonValueEnd(text, i) {
  const n = text.length;
  let depth = 0;
  for (; i < n; i++) {
    const c = text[i];
    if (c === '"') { i++; while (i < n && text[i] !== '"') { if (text[i] === '\\') i++; i++; } if (depth === 0) return i + 1; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return i + 1; if (depth < 0) return i; }
    else if (depth === 0 && (c === ',' || c === '\n')) return i;
  }
  return n;
}

function lineStarts(text) {
  const s = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) s.push(i + 1);
  return s;
}

/** An edit from offsets. */
function editAt(text, from, to, newText) {
  const pos = lineIndex(text);
  const a = pos(from), b = pos(to);
  return { startLine: a.line, startCol: a.col, endLine: b.line, endCol: b.col, newText };
}

/** Add `key: value` as the first child of the map whose key is at issue.line. */
function addKey(text, isJson, line, col, key, value) {
  if (isJson) {
    const starts = lineStarts(text);
    if (line >= starts.length) return null;
    const open = jsonOpenBrace(text, starts, line, col);
    if (open < 0) return null;
    let j = open;
    while (j < text.length && /\s/.test(text[j])) j++;
    const member = JSON.stringify(key) + ': ' + JSON.stringify(value);
    if (text[j] === '}') return editAt(text, open, open, member);
    const nl = text.lastIndexOf('\n', j);
    const ind = nl >= open ? text.slice(nl + 1, j) : ' ';
    return editAt(text, open, open, (nl >= open ? '\n' + ind : ' ') + member + ',');
  }
  const ls = lines(text);
  if (line >= ls.length) return null;
  const ind = yamlChildIndent(ls, line);
  if (ind === null) return null;
  return { startLine: line + 1, startCol: 0, endLine: line + 1, endCol: 0, newText: `${ind}${key}: ${yamlScalar(value)}\n` };
}

/** Remove the map member whose key is at `line` (a whole YAML block, or a JSON member with its comma). */
function removeMember(text, isJson, line, col, name) {
  if (isJson) {
    const starts = lineStarts(text);
    if (line >= starts.length) return null;
    const keyStart = text.indexOf(JSON.stringify(name), starts[line]);
    if (keyStart < 0 || keyStart > (starts[line + 1] || text.length)) return null;
    let i = keyStart + JSON.stringify(name).length;
    while (/\s/.test(text[i])) i++;
    if (text[i] !== ':') return null;
    i++;
    while (/\s/.test(text[i])) i++;
    const end = jsonValueEnd(text, i);
    let k = end;
    while (k < text.length && /\s/.test(text[k])) k++;
    if (text[k] === ',') {
      // member, then a comma: remove up to the next member, keep the line layout
      let m = k + 1;
      while (m < text.length && /[ \t]/.test(text[m])) m++;
      if (text[m] === '\r') m++;
      if (text[m] === '\n' && /^\s*$/.test(text.slice(starts[line], keyStart))) { m++; return editAt(text, starts[line], m, ''); }
      return editAt(text, keyStart, m, '');
    }
    // last member: remove the comma before it
    let p = keyStart - 1;
    while (p >= 0 && /\s/.test(text[p])) p--;
    if (text[p] === ',') return editAt(text, p, end, '');
    if (text[p] === '{') return editAt(text, p + 1, end, '');
    return null;
  }
  const ls = lines(text);
  if (line >= ls.length) return null;
  const keyIndent = indentOf(ls[line]).length;
  let end = line + 1;
  while (end < ls.length && (blank(ls[end]) || indentOf(ls[end]).length > keyIndent)) end++;
  // keep trailing blank lines and comments for the next block
  while (end > line + 1 && blank(ls[end - 1])) end--;
  const edits = [];
  // only child of its parent: leave an empty map, so the parent stays a map
  let prev = line - 1;
  while (prev >= 0 && blank(ls[prev])) prev--;
  const nextIsSibling = end < ls.length && !blank(ls[end]) && indentOf(ls[end]).length === keyIndent;
  const prevIsParent = prev >= 0 && indentOf(ls[prev]).length < keyIndent && /:\s*(#.*)?$/.test(ls[prev]);
  if (prevIsParent && !nextIsSibling) {
    const m = /^(.*?:)\s*(#.*)?$/.exec(ls[prev]);
    edits.push({ startLine: prev, startCol: 0, endLine: prev, endCol: ls[prev].length, newText: m[1] + ' {}' + (m[2] ? ' ' + m[2] : '') });
  }
  edits.push({ startLine: line, startCol: 0, endLine: end, endCol: 0, newText: '' });
  if (end >= ls.length) { // removing to the end of the file
    edits[edits.length - 1] = { startLine: line, startCol: 0, endLine: ls.length - 1, endCol: ls[ls.length - 1].length, newText: '' };
  }
  return edits;
}

/** Replace `from` with `to` on one of the lines line..line+2. */
function replaceOnLine(text, line, from, to) {
  const ls = lines(text);
  for (let l = line; l < Math.min(ls.length, line + 3); l++) {
    const c = ls[l].indexOf(from);
    if (c >= 0) return { startLine: l, startCol: c, endLine: l, endCol: c + from.length, newText: to };
  }
  return null;
}

/**
 * Quick fixes for one issue: [{ title, edits: [{ startLine, startCol, endLine, endCol, newText }] }].
 * issue: { rule, line, col, data } (line and col are 0-based and point at the key the issue is about).
 */
function fixEdits(text, isJson, issue) {
  const out = [];
  if (!issue || typeof text !== 'string') return out;
  const d = issue.data || {};
  const line = issue.line | 0, col = issue.col | 0;
  const ls = lines(text);
  switch (issue.rule) {
    case 'operation-operationId': {
      if (!d.suggestedId) break;
      if (!isJson && !METHOD_RE.test(ls[line] || '')) break;
      if (isJson && !/"(get|put|post|delete|options|head|patch|trace|query)"\s*:/.test(ls[line] || '')) break;
      const e = addKey(text, isJson, line, col, 'operationId', d.suggestedId);
      if (e) out.push({ title: `Add operationId: ${d.suggestedId}`, edits: [e] });
      break;
    }
    case 'operation-description':
    case 'operation-summary':
    case 'info-description': {
      if (d.present) break; // the key is there but empty: nothing to insert
      const key = d.key || (issue.rule === 'operation-summary' ? 'summary' : 'description');
      const e = addKey(text, isJson, line, col, key, '');
      if (e) out.push({ title: `Add an empty ${key} to fill in`, edits: [e] });
      break;
    }
    case 'oas3-unused-component':
    case 'oas2-unused-definition': {
      if (!d.name) break;
      const lt = ls[line] || '';
      if (isJson ? !lt.includes(JSON.stringify(d.name)) : !new RegExp('^\\s*["\']?' + d.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']?\\s*:').test(lt)) break;
      const e = removeMember(text, isJson, line, col, d.name);
      if (e) out.push({ title: `Remove unused ${d.kind === 'definitions' || !d.kind ? 'definition' : d.kind.replace(/s$/, '')} "${d.name}"`, edits: Array.isArray(e) ? e : [e] });
      break;
    }
    case 'invalid-ref': {
      if (!d.ref || !d.suggest) break;
      const e = replaceOnLine(text, line, d.ref, d.suggest);
      if (e) out.push({ title: `Change $ref to ${d.suggest}`, edits: [e] });
      break;
    }
  }
  return out;
}

/** New text of a ruleset file with `rule` turned off. existing: current text or null (new file). */
function rulesetWithRuleOff(existing, rule, fileName = '.spectral.yaml') {
  if (existing == null || !String(existing).trim()) return `extends: ["spectral:oas"]\nrules:\n  ${yamlKey(rule)}: off\n`;
  if (/\.json$/i.test(fileName)) {
    const data = JSON.parse(existing);
    if (!data.rules || typeof data.rules !== 'object') data.rules = {};
    data.rules[rule] = 'off';
    return JSON.stringify(data, null, 2) + '\n';
  }
  const doc = YAML.parseDocument(String(existing));
  if (doc.errors && doc.errors.length) throw new Error(`${fileName} has a YAML error, so it was not changed: ${String(doc.errors[0].message).split('\n')[0]}`);
  const rules = doc.get('rules');
  if (rules == null || !YAML.isMap(rules)) doc.set('rules', doc.createNode({}));
  doc.setIn(['rules', rule], 'off');
  return String(doc);
}
const yamlKey = k => /^[A-Za-z0-9_.\-]+$/.test(k) ? k : JSON.stringify(k);

/** Apply edits to text (for tests and previews). Edits must not overlap. */
function applyEdits(text, edits) {
  const starts = lineStarts(text);
  const off = (l, c) => (l < starts.length ? starts[l] : text.length) + c;
  const sorted = edits.map(e => ({ a: off(e.startLine, e.startCol), b: off(e.endLine, e.endCol), t: e.newText })).sort((x, y) => y.a - x.a);
  let s = text;
  for (const e of sorted) s = s.slice(0, e.a) + e.t + s.slice(e.b);
  return s;
}

module.exports = { fixEdits, rulesetWithRuleOff, applyEdits };
