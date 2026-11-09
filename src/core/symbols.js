'use strict';
// Outline, reference targets and $ref search for the editor features. Pure Node: the tests and src/language.js use it.
const { scanYaml } = require('./cursor');
const { pathKey, pathToPointer, pointerToPath, lineIndex } = require('./spec');

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const MAX_CHILDREN = 20000;
const own = Object.prototype.hasOwnProperty;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = v => (isObj(v) ? Object.keys(v) : []);

const COMPONENT_GROUPS = [
  ['schemas', 'Schemas', 'class'], ['parameters', 'Parameters', 'field'], ['responses', 'Responses', 'field'],
  ['requestBodies', 'Request bodies', 'field'], ['headers', 'Headers', 'field'], ['examples', 'Examples', 'field'],
  ['securitySchemes', 'Security schemes', 'field'], ['links', 'Links', 'field'], ['callbacks', 'Callbacks', 'event'],
  ['pathItems', 'Path items', 'class'],
];

function short(v, n = 80) {
  if (v == null || typeof v === 'object') return '';
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Outline tree. locate(paths[]) -> Map(pathKey -> { line, col }) gives positions (spec.js parseText().locate, or the
 * one from yamlSkeleton). Each node: { name, detail, kind, path, line, col, endLine, children }. endLine of the last
 * nodes is Infinity: clamp it to the document.
 */
function outline(data, family, locate) {
  if (!isObj(data)) return [];
  const top = [];
  const node = (name, kind, path, detail, children) => ({ name: String(name), detail: detail || '', kind, path, line: 0, col: 0, endLine: Infinity, children: children || [] });
  if (isObj(data.info)) top.push(node('Info', 'module', ['info'], [short(data.info.title, 60), data.info.version != null ? 'v' + short(data.info.version, 20) : ''].filter(Boolean).join(' ')));
  if (Array.isArray(data.servers) && data.servers.length) {
    top.push(node('Servers', 'module', ['servers'], String(data.servers.length), data.servers.slice(0, 200).map((s, i) => node(isObj(s) && s.url ? short(s.url, 100) : 'server ' + (i + 1), 'field', ['servers', i], isObj(s) ? short(s.description, 60) : ''))));
  }
  if (family === '2.0' && (data.host || data.basePath)) top.push(node('Host', 'module', [data.host ? 'host' : 'basePath'], short((data.host || '') + (data.basePath || ''), 100)));
  const ops = (item, base) => keys(item).filter(m => METHODS.includes(m.toLowerCase()) && isObj(item[m]))
    .map(m => node(m.toUpperCase(), 'method', base.concat(m), short(item[m].summary, 80) || short(item[m].operationId, 60)));
  if (isObj(data.paths)) {
    const ps = keys(data.paths).filter(p => !p.startsWith('x-'));
    let nOps = 0;
    const kids = ps.slice(0, MAX_CHILDREN).map(p => { const o = ops(data.paths[p], ['paths', p]); nOps += o.length; return node(p, 'class', ['paths', p], o.length ? '' : (isObj(data.paths[p]) && data.paths[p].$ref ? '$ref ' + short(data.paths[p].$ref, 60) : ''), o); });
    top.push(node('Paths', 'module', ['paths'], `${ps.length} paths, ${nOps} operations`, kids));
  }
  if (isObj(data.webhooks)) {
    const ws = keys(data.webhooks).filter(w => !w.startsWith('x-'));
    top.push(node('Webhooks', 'module', ['webhooks'], String(ws.length), ws.slice(0, MAX_CHILDREN).map(w => node(w, 'event', ['webhooks', w], '', ops(data.webhooks[w], ['webhooks', w])))));
  }
  const group = (obj, base, label, kind) => {
    const ns = keys(obj).filter(n => !n.startsWith('x-'));
    return node(label, 'module', base, String(ns.length), ns.slice(0, MAX_CHILDREN).map(n => node(n, kind, base.concat(n), isObj(obj[n]) ? (short(obj[n].type, 20) || (obj[n].$ref ? '$ref' : '')) : '')));
  };
  if (family === '2.0') {
    if (isObj(data.definitions)) top.push(group(data.definitions, ['definitions'], 'Definitions', 'class'));
    if (isObj(data.parameters)) top.push(group(data.parameters, ['parameters'], 'Parameters', 'field'));
    if (isObj(data.responses)) top.push(group(data.responses, ['responses'], 'Responses', 'field'));
    if (isObj(data.securityDefinitions)) top.push(group(data.securityDefinitions, ['securityDefinitions'], 'Security definitions', 'field'));
  } else if (isObj(data.components)) {
    const kids = [];
    for (const [k, label, kind] of COMPONENT_GROUPS) if (isObj(data.components[k])) kids.push(group(data.components[k], ['components', k], label, kind));
    top.push(node('Components', 'module', ['components'], '', kids));
  }
  if (Array.isArray(data.tags) && data.tags.length) {
    top.push(node('Tags', 'module', ['tags'], String(data.tags.length), data.tags.slice(0, 2000).map((t, i) => node(isObj(t) && t.name ? short(t.name, 80) : 'tag ' + (i + 1), 'field', ['tags', i], isObj(t) ? short(t.description, 60) : ''))));
  }
  // Positions, all in one locate call.
  const all = [];
  const walk = list => { for (const n of list) { all.push(n); walk(n.children); } };
  walk(top);
  const pos = locate ? locate(all.map(n => n.path)) : new Map();
  for (const n of all) { const p = pos.get(pathKey(n.path)); if (p) { n.line = p.line; n.col = p.col; } }
  const ends = (list, parentEnd) => {
    const sorted = list.slice().sort((a, b) => a.line - b.line);
    sorted.forEach((n, i) => {
      const next = sorted[i + 1];
      n.endLine = next ? Math.max(n.line, next.line - 1) : parentEnd;
      ends(n.children, n.endLine);
    });
    list.sort((a, b) => a.line - b.line);
  };
  ends(top, Infinity);
  return top;
}

/** Every component a $ref can point to: [{ ref: '#/components/schemas/Pet', name, kind, path }]. */
function refTargets(data, family) {
  const out = [];
  if (!isObj(data)) return out;
  const add = (base, kind) => {
    const obj = base.reduce((v, k) => (isObj(v) && own.call(v, k) ? v[k] : undefined), data);
    for (const n of keys(obj)) if (!n.startsWith('x-')) out.push({ ref: '#' + pathToPointer(base.concat(n)), name: n, kind, path: base.concat(n) });
  };
  if (family === '2.0') { add(['definitions'], 'schemas'); add(['parameters'], 'parameters'); add(['responses'], 'responses'); }
  else if (isObj(data.components)) for (const [k] of COMPONENT_GROUPS) add(['components', k], k);
  return out;
}

/** The component a key path names: { kindPath, name } for ['components', kind, name] or the 2.0 top-level maps. */
function componentAt(path, family) {
  if (!Array.isArray(path)) return null;
  const p = path.map(String);
  if (p.length === 3 && p[0] === 'components' && COMPONENT_GROUPS.some(g => g[0] === p[1])) return { kindPath: p.slice(0, 2), name: p[2] };
  if (p.length === 2 && family === '2.0' && ['definitions', 'parameters', 'responses'].includes(p[0])) return { kindPath: [p[0]], name: p[1] };
  return null;
}

/** Splits a $ref value into { file, pointer (path array or null), fragment }. */
function splitRefValue(value) {
  const s = String(value);
  const h = s.indexOf('#');
  const file = h < 0 ? s : s.slice(0, h);
  const fragment = h < 0 ? '' : s.slice(h + 1);
  return { file, fragment, pointer: h < 0 ? [] : pointerToPath(fragment) };
}

/**
 * $ref values in a text: [{ line, col, length, value, offset }] where col and length cover the value without quotes.
 * test: a string (exact value) or a function(value) -> bool; omit it for all refs.
 */
function findRefs(text, isJson, test) {
  const out = [];
  if (typeof text !== 'string' || text.indexOf('$ref') < 0) return out;
  const re = /(["']?)\$ref\1[ \t]*:[ \t]*/g;
  let pos = null;
  let m;
  while ((m = re.exec(text))) {
    let i = m.index + m[0].length;
    const q = text[i];
    let a, b;
    if (q === '"' || q === "'") {
      a = i + 1; b = a;
      while (b < text.length) {
        const c = text[b];
        if (c === '\n') break;
        if (q === '"' && c === '\\') { b += 2; continue; }
        if (c === q) { if (q === "'" && text[b + 1] === "'") { b += 2; continue; } break; }
        b++;
      }
    } else {
      if (isJson) continue;
      a = i; b = a;
      while (b < text.length && text[b] !== '\n' && text[b] !== '\r' && !(text[b] === '#' && b > a && /\s/.test(text[b - 1])) && text[b] !== ',' && text[b] !== '}') b++;
      while (b > a && /\s/.test(text[b - 1])) b--;
    }
    let value = text.slice(a, b);
    if (q === '"' && value.indexOf('\\') >= 0) { try { value = JSON.parse('"' + value + '"'); } catch { /* keep */ } }
    if (q === "'") value = value.replace(/''/g, "'");
    if (test !== undefined && (typeof test === 'function' ? !test(value) : value !== test)) continue;
    if (!pos) pos = lineIndex(text);
    const p = pos(a);
    out.push({ line: p.line, col: p.col, length: b - a, value, offset: a, quote: q === '"' || q === "'" ? q : '' });
    re.lastIndex = b;
  }
  return out;
}

function unquote(rest) {
  if (!rest) return rest;
  if (rest[0] === '"') { const e = rest.lastIndexOf('"'); try { return JSON.parse(rest.slice(0, e + 1)); } catch { return rest.slice(1, e > 0 ? e : undefined); } }
  if (rest[0] === "'") { const e = rest.lastIndexOf("'"); return rest.slice(1, e > 0 ? e : undefined).replace(/''/g, "'"); }
  return rest;
}

/**
 * A cheap stand-in for a parsed YAML document, from one forward scan: keys up to maxDepth with their inline scalar
 * values. Returns { data, locate }. Used for outlines and $ref lists of big files, where a full parse would block.
 */
function yamlSkeleton(text, maxDepth = 4) {
  const data = Object.create(null); // null prototype: a key named __proto__ stays a key
  const where = new Map();
  scanYaml(text, (path, line, col, rest) => {
    let v = data;
    for (let k = 0; k < path.length - 1; k++) {
      const seg = path[k];
      const nextIsIndex = typeof path[k + 1] === 'number';
      let child = v[seg];
      if (child === null || typeof child !== 'object' || (nextIsIndex && !Array.isArray(child))) { child = nextIsIndex ? [] : Object.create(null); v[seg] = child; }
      v = child;
      const pk = pathKey(path.slice(0, k + 1));
      if (!where.has(pk)) where.set(pk, { line, col });
    }
    const last = path[path.length - 1];
    if (!(isObj(v) || Array.isArray(v))) return;
    const r = rest || '';
    if (r === '' || /^[|>]/.test(r)) { if (!own.call(v, last)) v[last] = r ? '' : Object.create(null); }
    else if (r[0] === '{' || r[0] === '[') v[last] = r[0] === '{' ? Object.create(null) : [];
    else v[last] = unquote(r.replace(/^&\S+\s*/, ''));
    where.set(pathKey(path), { line, col });
  }, { maxDepth });
  const locate = paths => {
    const out = new Map();
    for (const p of paths) {
      for (let d = p.length; d >= 0; d--) { const hit = where.get(pathKey(p.slice(0, d))); if (hit) { out.set(pathKey(p), hit); break; } }
    }
    return out;
  };
  return { data, locate };
}

module.exports = { outline, refTargets, componentAt, splitRefValue, findRefs, yamlSkeleton, COMPONENT_GROUPS };
