'use strict';
// Breaking-change report between two versions of one API. Works on bundled specs (local $refs are resolved here,
// with a cycle guard). Pure Node.
// Each item: { kind, path, message, level } with level 'breaking', 'warning' or 'info'.
//   breaking: an existing client can fail (removed operation, new required input, changed type, ...)
//   warning:  a client may need a look (new enum value in a response, changed operationId, changed security)
//   info:     additions and other safe changes
const { pointerToPath, getPath } = require('./spec');

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const MAX_ITEMS = 5000;
const MAX_DEPTH = 40;

function familyOf(spec) {
  if (!isObj(spec)) return 'unknown';
  if (spec.swagger !== undefined) return '2.0';
  const m = /^3\.(\d+)/.exec(String(spec.openapi || ''));
  return m ? (m[1] === '0' ? '3.0' : '3.1') : 'unknown';
}

/** Follows local $refs (up to 20 hops). Returns the target, or the node itself when it is not a $ref. */
function resolve(spec, node) {
  let v = node, hops = 0;
  while (isObj(v) && typeof v.$ref === 'string' && v.$ref.startsWith('#') && hops++ < 20) {
    const p = pointerToPath(v.$ref.slice(1));
    const t = p ? getPath(spec, p) : undefined;
    if (t === undefined) return v;
    v = t;
  }
  return v;
}

const typeList = s => {
  if (!isObj(s)) return [];
  if (Array.isArray(s.type)) return s.type.filter(t => t !== 'null').slice().sort();
  if (typeof s.type === 'string') return [s.type];
  return [];
};
const nullable = s => isObj(s) && (s.nullable === true || (Array.isArray(s.type) && s.type.includes('null')) || s['x-nullable'] === true);

/** allOf members merged into one view: properties, required, type. */
function flatten(spec, s0, depth = 0) {
  const s = resolve(spec, s0);
  if (!isObj(s)) return {};
  if (!Array.isArray(s.allOf) || depth > 10) return s;
  const out = { ...s, properties: { ...(isObj(s.properties) ? s.properties : {}) }, required: [...(Array.isArray(s.required) ? s.required : [])] };
  delete out.allOf;
  for (const part of s.allOf) {
    const f = flatten(spec, part, depth + 1);
    if (isObj(f.properties)) Object.assign(out.properties, f.properties);
    if (Array.isArray(f.required)) out.required.push(...f.required);
    if (out.type === undefined && f.type !== undefined) out.type = f.type;
  }
  if (!Object.keys(out.properties).length) delete out.properties;
  if (!out.required.length) delete out.required;
  if (out.type === undefined && out.properties) out.type = 'object';
  return out;
}

/** How an array or object parameter goes on the wire, the same string for 2.0 collectionFormat and 3.x style. */
function wireFormat(p, schema) {
  const t = typeList(schema);
  if (!t.includes('array') && !t.includes('object')) return 'plain';
  if (p.in === 'body') return 'body';
  if (p.collectionFormat !== undefined || (p.type !== undefined && p.schema === undefined && p.content === undefined)) {
    const cf = p.collectionFormat || 'csv';
    if (cf === 'multi') return 'form-explode';
    if (cf === 'csv') return p.in === 'query' || p.in === 'formData' ? 'form' : 'simple';
    return cf === 'ssv' ? 'spaceDelimited' : cf === 'pipes' ? 'pipeDelimited' : cf;
  }
  const style = p.style || (p.in === 'query' || p.in === 'cookie' ? 'form' : 'simple');
  const explode = p.explode !== undefined ? p.explode === true : style === 'form';
  if (style === 'form') return explode ? 'form-explode' : 'form';
  return style + (explode ? '-explode' : '');
}

const normPath = p => p.replace(/\{[^}]*\}/g, '{}');

function breakingChanges(oldSpec, newSpec, opts = {}) {
  const famOld = familyOf(oldSpec), famNew = opts.family || familyOf(newSpec);
  const items = [];
  const add = (level, kind, path, message) => { if (items.length < MAX_ITEMS) items.push({ level, kind, path, message }); };

  // ---- servers
  const serverUrls = (spec, fam) => {
    if (fam === '2.0') return spec.host || spec.basePath ? [`${spec.host || ''}${(spec.basePath || '').replace(/\/$/, '')}`] : [];
    return Array.isArray(spec.servers) ? spec.servers.filter(isObj).map(s => String(s.url || '').replace(/\/$/, '')) : [];
  };
  const so = serverUrls(oldSpec, famOld), sn = serverUrls(newSpec, famNew);
  const strip = u => u.replace(/^[a-z]+:\/\//i, '');
  if (so.length && sn.length) {
    const removed = so.filter(u => !sn.map(strip).includes(strip(u)));
    if (removed.length === so.length) add('breaking', 'server-changed', 'servers', `The server changed from ${so[0] || '(none)'} to ${sn[0] || '(none)'}. Clients that use the old base URL fail.`);
    else for (const u of removed) add('warning', 'server-removed', 'servers', `Server ${u} was removed.`);
    for (const u of sn) if (!so.map(strip).includes(strip(u))) add('info', 'server-added', 'servers', `Server ${u} was added.`);
  }

  // ---- operations
  const ops = (spec) => {
    const out = new Map();
    const paths = isObj(spec.paths) ? spec.paths : {};
    for (const p of Object.keys(paths)) {
      const item = resolve(spec, paths[p]);
      if (!isObj(item)) continue;
      for (const m of METHODS) if (isObj(item[m])) out.set(m.toUpperCase() + ' ' + normPath(p), { path: p, method: m, item, op: item[m] });
    }
    return out;
  };
  const oOps = ops(oldSpec), nOps = ops(newSpec);
  const oldPathsN = new Set([...oOps.values()].map(o => normPath(o.path)));
  const newPathsN = new Set([...nOps.values()].map(o => normPath(o.path)));
  for (const [k, o] of oOps) {
    const label = o.method.toUpperCase() + ' ' + o.path;
    const n = nOps.get(k);
    if (!n) {
      if (!newPathsN.has(normPath(o.path))) add('breaking', 'operation-removed', label, `${label} was removed (the whole path is gone).`);
      else add('breaking', 'operation-removed', label, `${label} was removed.`);
      continue;
    }
    compareOperation(o, n, label);
  }
  for (const [k, n] of nOps) if (!oOps.has(k)) {
    const label = n.method.toUpperCase() + ' ' + n.path;
    add('info', 'operation-added', label, `${label} was added${oldPathsN.has(normPath(n.path)) ? '' : ' (new path)'}.`);
  }

  function effectiveParams(spec, item, op) {
    const map = new Map();
    for (const list of [item.parameters, op.parameters]) {
      if (!Array.isArray(list)) continue;
      for (const p0 of list) {
        const p = resolve(spec, p0);
        if (!isObj(p) || typeof p.name !== 'string') continue;
        map.set(p.in + ':' + p.name, p);
      }
    }
    return map;
  }
  function paramSchema(spec, p) {
    if (isObj(p.schema)) return flatten(spec, p.schema);
    if (isObj(p.content)) { const m = Object.values(p.content)[0]; return isObj(m) ? flatten(spec, m.schema) : {}; }
    return p; // 2.0 simple parameter: type, format, enum, items sit on the parameter
  }

  /** Request body as { required, content: { mediaType: schema } }, for both families. */
  function requestBody(spec, fam, item, op, params) {
    if (fam === '2.0') {
      const consumes = Array.isArray(op.consumes) ? op.consumes : Array.isArray(spec.consumes) ? spec.consumes : ['application/json'];
      const body = [...params.values()].find(p => p.in === 'body');
      if (body) {
        const c = {};
        for (const ct of consumes.length ? consumes : ['application/json']) c[ct] = body.schema;
        return { required: body.required === true, content: c };
      }
      const form = [...params.values()].filter(p => p.in === 'formData');
      if (form.length) {
        const schema = { type: 'object', properties: {}, required: form.filter(p => p.required).map(p => p.name) };
        for (const p of form) schema.properties[p.name] = p;
        const ct = consumes.find(c => /form/.test(c)) || 'application/x-www-form-urlencoded';
        return { required: schema.required.length > 0, content: { [ct]: schema } };
      }
      return null;
    }
    const rb = resolve(spec, op.requestBody);
    if (!isObj(rb)) return null;
    const c = {};
    if (isObj(rb.content)) for (const ct of Object.keys(rb.content)) c[ct] = isObj(rb.content[ct]) ? rb.content[ct].schema : undefined;
    return { required: rb.required === true, content: c };
  }

  function responses(spec, fam, op) {
    const out = new Map();
    const rs = isObj(op.responses) ? op.responses : {};
    const produces = Array.isArray(op.produces) ? op.produces : Array.isArray(spec.produces) ? spec.produces : ['application/json'];
    for (const code of Object.keys(rs)) {
      if (/^x-/.test(code)) continue;
      const r = resolve(spec, rs[code]);
      if (!isObj(r)) continue;
      const content = {};
      if (fam === '2.0') { if (r.schema !== undefined) for (const ct of produces.length ? produces : ['application/json']) content[ct] = r.schema; }
      else if (isObj(r.content)) for (const ct of Object.keys(r.content)) content[ct] = isObj(r.content[ct]) ? r.content[ct].schema : undefined;
      out.set(String(code), { content, headers: isObj(r.headers) ? r.headers : {} });
    }
    return out;
  }

  function compareOperation(o, n, label) {
    const oop = o.op, nop = n.op;
    if (oop.operationId && nop.operationId && oop.operationId !== nop.operationId) add('warning', 'operationId-changed', label, `operationId changed from "${oop.operationId}" to "${nop.operationId}". Generated clients rename this method.`);
    if (nop.deprecated === true && oop.deprecated !== true) add('info', 'deprecated', label, `${label} is now deprecated.`);

    // parameters
    const op_ = effectiveParams(oldSpec, o.item, oop), np = effectiveParams(newSpec, n.item, nop);
    for (const [k, p] of np) {
      if (p.in === 'body' || p.in === 'formData') continue;
      const q = op_.get(k);
      const where = `${p.in} parameter "${p.name}"`;
      if (!q) {
        if (p.in === 'path') continue; // a renamed path parameter is the same parameter
        if (p.required === true) add('breaking', 'required-param-added', label, `New required ${where}. Old clients do not send it.`);
        else add('info', 'param-added', label, `New optional ${where}.`);
        continue;
      }
      if (p.required === true && q.required !== true) add('breaking', 'param-made-required', label, `The ${where} is now required.`);
      const so = paramSchema(oldSpec, q), sn = paramSchema(newSpec, p);
      compareSchema(so, sn, 'request', label, where, 0, new Set());
      const wo = wireFormat(q, so), wn = wireFormat(p, sn);
      if (wo !== wn) add('breaking', 'param-style-changed', label, `The ${where} is sent in a different format (${wo} before, ${wn} now).`);
    }
    const newByName = new Map([...np.values()].map(p => [p.name, p]));
    for (const [k, q] of op_) {
      if (q.in === 'body' || q.in === 'formData' || np.has(k)) continue;
      const moved = newByName.get(q.name);
      if (moved && moved.in !== 'body' && moved.in !== 'formData') add('breaking', 'param-location-changed', label, `Parameter "${q.name}" moved from ${q.in} to ${moved.in}.`);
      else if (q.in !== 'path') add('warning', 'param-removed', label, `The ${q.in} parameter "${q.name}" was removed. Clients that send it are ignored or rejected.`);
    }

    // request body
    const ob = requestBody(oldSpec, famOld, o.item, oop, op_), nb = requestBody(newSpec, famNew, n.item, nop, np);
    if (nb && nb.required && (!ob || !ob.required)) add('breaking', 'body-required', label, ob ? 'The request body is now required.' : 'A required request body was added.');
    if (ob && nb) {
      for (const ct of Object.keys(ob.content)) {
        if (!(ct in nb.content)) { add('breaking', 'request-media-removed', label, `The request body no longer accepts ${ct}.`); continue; }
        compareSchema(flatten(oldSpec, ob.content[ct]), flatten(newSpec, nb.content[ct]), 'request', label, 'request body', 0, new Set());
      }
    } else if (ob && !nb) add('warning', 'body-removed', label, 'The request body was removed.');

    // responses
    const or = responses(oldSpec, famOld, oop), nr = responses(newSpec, famNew, nop);
    for (const [code, r] of or) {
      const s = nr.get(code);
      if (!s) {
        if (/^[23]/.test(code)) add('breaking', 'response-removed', label, `Response ${code} was removed.`);
        else add('info', 'response-removed', label, `Response ${code} was removed.`);
        continue;
      }
      for (const ct of Object.keys(r.content)) {
        if (!(ct in s.content)) {
          if (/^[23]/.test(code)) add('breaking', 'response-media-removed', label, `Response ${code} no longer returns ${ct}.`);
          continue;
        }
        if (/^[23]/.test(code) || code === 'default') compareSchema(flatten(oldSpec, r.content[ct]), flatten(newSpec, s.content[ct]), 'response', label, `response ${code}`, 0, new Set());
      }
      for (const h of Object.keys(r.headers)) if (!(h in s.headers) && /^[23]/.test(code)) add('warning', 'response-header-removed', label, `Response ${code} no longer sends header ${h}.`);
    }
    for (const code of nr.keys()) if (!or.has(code)) add('info', 'response-added', label, `Response ${code} was added.`);

    // security
    const sec = (spec, op) => Array.isArray(op.security) ? op.security : Array.isArray(spec.security) ? spec.security : [];
    const so = sec(oldSpec, oop), sn = sec(newSpec, nop);
    const open = l => !l.length || l.some(r => isObj(r) && !Object.keys(r).length);
    if (open(so) && !open(sn)) add('breaking', 'security-added', label, `${label} now needs authentication (${sn.map(r => Object.keys(r).join(' + ')).join(' or ')}).`);
    else if (!open(sn) && JSON.stringify(so) !== JSON.stringify(sn)) add('warning', 'security-changed', label, 'The security requirements changed.');
  }

  function compareSchema(a0, b0, dir, label, where, depth, seen) {
    if (depth > MAX_DEPTH || items.length >= MAX_ITEMS) return;
    const a = flatten(oldSpec, a0), b = flatten(newSpec, b0);
    if (!isObj(a) || !isObj(b)) return;
    const key = (isObj(a0) && a0.$ref || '') + '|' + (isObj(b0) && b0.$ref || '') + '|' + dir;
    if (key !== '||' + dir) { if (seen.has(key)) return; seen = new Set(seen); seen.add(key); }
    const ta = typeList(a), tb = typeList(b);
    if (ta.length && tb.length) {
      const widened = ta.every(t => tb.includes(t) || (t === 'integer' && tb.includes('number')));
      const narrowed = tb.every(t => ta.includes(t) || (t === 'integer' && ta.includes('number')));
      if (dir === 'request' ? !widened : !narrowed) { add('breaking', 'type-changed', label, `The type of ${where} changed from ${ta.join('|')} to ${tb.join('|')}.`); return; }
    }
    if (dir === 'request' && nullable(a) && !nullable(b)) add('breaking', 'nullable-removed', label, `${where} no longer accepts null.`);
    if (dir === 'response' && !nullable(a) && nullable(b)) add('warning', 'nullable-added', label, `${where} can now be null.`);
    if (Array.isArray(a.enum) && Array.isArray(b.enum)) {
      const sa = a.enum.map(v => JSON.stringify(v)), sb = b.enum.map(v => JSON.stringify(v));
      const removed = sa.filter(v => !sb.includes(v)), added = sb.filter(v => !sa.includes(v));
      if (dir === 'request' && removed.length) add('breaking', 'enum-value-removed', label, `${where} no longer accepts ${removed.join(', ')}.`);
      if (dir === 'response' && added.length) add('warning', 'enum-value-added', label, `${where} can now return ${added.join(', ')}. Clients that check every value may need an update.`);
      if (dir === 'request' && added.length) add('info', 'enum-value-added', label, `${where} now also accepts ${added.join(', ')}.`);
      if (dir === 'response' && removed.length) add('info', 'enum-value-removed', label, `${where} no longer returns ${removed.join(', ')}.`);
    } else if (dir === 'request' && !Array.isArray(a.enum) && Array.isArray(b.enum)) add('breaking', 'enum-added', label, `${where} now accepts only ${b.enum.map(v => JSON.stringify(v)).join(', ')}.`);
    if (dir === 'request') {
      for (const k of ['maxLength', 'maximum', 'maxItems']) if (typeof b[k] === 'number' && (typeof a[k] !== 'number' || b[k] < a[k])) add('breaking', 'limit-tightened', label, `${where}: ${k} is now ${b[k]}${typeof a[k] === 'number' ? ` (was ${a[k]})` : ''}.`);
      for (const k of ['minLength', 'minimum', 'minItems']) if (typeof b[k] === 'number' && (typeof a[k] !== 'number' || b[k] > a[k]) && b[k] > 0) add('breaking', 'limit-tightened', label, `${where}: ${k} is now ${b[k]}${typeof a[k] === 'number' ? ` (was ${a[k]})` : ''}.`);
    }

    const pa = isObj(a.properties) ? a.properties : {}, pb = isObj(b.properties) ? b.properties : {};
    const ra = new Set(Array.isArray(a.required) ? a.required : []), rb = new Set(Array.isArray(b.required) ? b.required : []);
    if (dir === 'request') {
      for (const k of rb) if (!ra.has(k)) add('breaking', 'required-property-added', label, `${where}: property "${k}" is now required.`);
      for (const k of Object.keys(pa)) if (!(k in pb) && (b.additionalProperties === false || b.unevaluatedProperties === false)) add('breaking', 'property-removed', label, `${where}: property "${k}" was removed and extra properties are not allowed.`);
      else if (!(k in pb) && Object.keys(pb).length) add('warning', 'property-removed', label, `${where}: property "${k}" was removed.`);
    } else {
      for (const k of Object.keys(pa)) if (!(k in pb) && (isObj(b.properties) || typeList(b).includes('object'))) add('breaking', 'property-removed', label, `${where}: property "${k}" was removed.`);
      for (const k of ra) if (!rb.has(k) && k in pb) add('breaking', 'required-property-removed', label, `${where}: property "${k}" is no longer always present.`);
      for (const k of Object.keys(pb)) if (!(k in pa) && Object.keys(pa).length) add('info', 'property-added', label, `${where}: property "${k}" was added.`);
    }
    for (const k of Object.keys(pa)) if (k in pb) compareSchema(pa[k], pb[k], dir, label, `${where}.${k}`, depth + 1, seen);
    if (isObj(a.items) && isObj(b.items)) compareSchema(a.items, b.items, dir, label, `${where}[]`, depth + 1, seen);
  }

  const breaking = items.filter(i => i.level === 'breaking');
  const changes = items.filter(i => i.level !== 'breaking');
  return { breaking, changes, truncated: items.length >= MAX_ITEMS };
}

/** A readable Markdown report. */
function diffMarkdown(result, oldLabel, newLabel) {
  const L = [];
  L.push(`# API changes from ${oldLabel} to ${newLabel}`, '');
  const w = result.changes.filter(c => c.level === 'warning'), info = result.changes.filter(c => c.level !== 'warning');
  L.push(`${result.breaking.length} breaking, ${w.length} to check, ${info.length} other.`, '');
  const section = (title, list) => {
    L.push(`## ${title} (${list.length})`, '');
    if (!list.length) { L.push('None.', ''); return; }
    const by = new Map();
    for (const i of list) { if (!by.has(i.path)) by.set(i.path, []); by.get(i.path).push(i); }
    for (const [p, l] of by) {
      L.push(`### ${p.replace(/[<>]/g, '')}`, '');
      for (const i of l) L.push(`- ${i.message} \`${i.kind}\``);
      L.push('');
    }
  };
  section('Breaking changes', result.breaking);
  section('Check these', w);
  section('Other changes', info);
  if (result.truncated) L.push('The list stops at 5,000 items.', '');
  return L.join('\n');
}

module.exports = { breakingChanges, diffMarkdown, resolve, flatten, familyOf };
