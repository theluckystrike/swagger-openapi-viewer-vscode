'use strict';
// Example values from schemas, and a local mock server that answers with them. Pure Node.
// The server listens on 127.0.0.1 only and never makes an outgoing request.
const http = require('http');
const { resolve } = require('./diff');

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const MAX_DEPTH = 8;
const MAX_BODY = 1048576;

const FORMATS = {
  'date-time': '2024-01-15T09:30:00Z', date: '2024-01-15', time: '09:30:00Z', email: 'user@example.com', 'idn-email': 'user@example.com',
  uuid: '3fa85f64-5717-4562-b3fc-2c963f66afa6', uri: 'https://example.com', url: 'https://example.com', 'uri-reference': '/path',
  hostname: 'example.com', ipv4: '192.0.2.1', ipv6: '2001:db8::1', byte: 'ZXhhbXBsZQ==', binary: '', password: '********',
  duration: 'P1D', regex: '^.*$', 'json-pointer': '/a/b',
};

/**
 * An example value for a schema. opts: { mode: 'request' | 'response' } skips readOnly properties in a request and
 * writeOnly properties in a response. Cycles and depths over 8 give null (or [] / {}).
 */
function exampleFor(schema, spec, depth = 0, opts = {}, seen = new Set()) {
  if (depth > MAX_DEPTH) return null;
  let s = schema;
  if (isObj(s) && typeof s.$ref === 'string') {
    if (seen.has(s.$ref)) return null;
    seen = new Set(seen); seen.add(s.$ref);
    s = resolve(spec, s);
    if (isObj(s) && typeof s.$ref === 'string') return null; // points to nothing or outside
  }
  if (s === true || s === undefined || s === null) return {};
  if (!isObj(s)) return null;
  if (s.example !== undefined) return s.example;
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (s['x-example'] !== undefined) return s['x-example'];
  if (s.const !== undefined) return s.const;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum.find(v => v !== null) !== undefined ? s.enum.find(v => v !== null) : s.enum[0];
  if (Array.isArray(s.allOf) && s.allOf.length) {
    let out;
    for (const part of s.allOf) {
      const v = exampleFor(part, spec, depth + 1, opts, seen);
      if (isObj(v)) out = Object.assign(isObj(out) ? out : {}, v);
      else if (out === undefined) out = v;
    }
    const own = { ...s }; delete own.allOf;
    if (isObj(own.properties)) { const v = exampleFor(own, spec, depth + 1, opts, seen); if (isObj(v)) out = Object.assign(isObj(out) ? out : {}, v); }
    return out === undefined ? {} : out;
  }
  for (const k of ['oneOf', 'anyOf']) {
    if (Array.isArray(s[k]) && s[k].length) {
      const pick = s[k].find(x => !(isObj(x) && x.type === 'null')) || s[k][0];
      const v = exampleFor(pick, spec, depth + 1, opts, seen);
      if (isObj(v) && isObj(s.properties)) return Object.assign(exampleFor({ ...s, [k]: undefined }, spec, depth + 1, opts, seen) || {}, v);
      return v;
    }
  }
  let type = s.type;
  if (Array.isArray(type)) type = type.find(t => t !== 'null') || 'null';
  if (!type) type = isObj(s.properties) || isObj(s.additionalProperties) ? 'object' : s.items ? 'array' : undefined;
  switch (type) {
    case 'object': {
      const out = {};
      const props = isObj(s.properties) ? s.properties : {};
      for (const k of Object.keys(props)) {
        const p = resolve(spec, props[k]);
        if (isObj(p) && ((opts.mode === 'request' && p.readOnly) || (opts.mode === 'response' && p.writeOnly))) continue;
        out[k] = exampleFor(props[k], spec, depth + 1, opts, seen);
      }
      if (!Object.keys(props).length && isObj(s.additionalProperties)) out.key = exampleFor(s.additionalProperties, spec, depth + 1, opts, seen);
      return out;
    }
    case 'array': {
      if (Array.isArray(s.prefixItems)) return s.prefixItems.map(x => exampleFor(x, spec, depth + 1, opts, seen));
      const n = Math.max(1, Math.min(Number(s.minItems) || 1, 3));
      const one = exampleFor(Array.isArray(s.items) ? s.items[0] : s.items, spec, depth + 1, opts, seen);
      return Array.from({ length: n }, () => one);
    }
    case 'string': {
      if (s.format && FORMATS[s.format] !== undefined) return FORMATS[s.format];
      let v = 'string';
      if (typeof s.minLength === 'number' && v.length < s.minLength) v = v.padEnd(Math.min(s.minLength, 1000), 'x');
      if (typeof s.maxLength === 'number' && v.length > s.maxLength) v = v.slice(0, Math.max(0, s.maxLength));
      return v;
    }
    case 'integer':
    case 'number': {
      let v = 0;
      if (typeof s.minimum === 'number') v = s.minimum;
      if (typeof s.exclusiveMinimum === 'number') v = s.exclusiveMinimum + 1;
      else if (s.exclusiveMinimum === true && typeof s.minimum === 'number') v = s.minimum + 1;
      if (typeof s.maximum === 'number' && v > s.maximum) v = s.maximum;
      return type === 'integer' ? Math.ceil(v) : v;
    }
    case 'boolean': return true;
    case 'null': return null;
    case 'file': return '';
    default: return isObj(s.properties) ? {} : null;
  }
}

function familyOf(spec) {
  if (spec && spec.swagger !== undefined) return '2.0';
  return /^3\.0/.test(String(spec && spec.openapi || '')) ? '3.0' : '3.1';
}

/** Path prefixes to strip: the 2.0 basePath, or the path part of each 3.x server URL (variables use their default). */
function prefixesOf(spec, family) {
  const out = new Set();
  if (family === '2.0') { if (typeof spec.basePath === 'string' && spec.basePath !== '/') out.add(spec.basePath.replace(/\/$/, '')); }
  else if (Array.isArray(spec.servers)) {
    for (const s of spec.servers) {
      if (!isObj(s) || typeof s.url !== 'string') continue;
      let url = s.url.replace(/\{([^}]+)\}/g, (m, n) => (isObj(s.variables) && isObj(s.variables[n]) && s.variables[n].default !== undefined ? String(s.variables[n].default) : ''));
      let p;
      try { p = new URL(url, 'http://localhost').pathname; } catch { continue; }
      p = p.replace(/\/$/, '');
      if (p) out.add(p);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

function compileRoutes(spec) {
  const routes = [];
  const paths = isObj(spec.paths) ? spec.paths : {};
  for (const p of Object.keys(paths)) {
    const item = resolve(spec, paths[p]);
    if (!isObj(item)) continue;
    const names = [];
    const re = '^' + p.split(/(\{[^}]+\})/).map(part => {
      const m = /^\{([^}]+)\}$/.exec(part);
      if (m) { names.push(m[1]); return '([^/]+)'; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('') + '/?$';
    const methods = METHODS.filter(m => isObj(item[m]));
    routes.push({ path: p, re: new RegExp(re), names, methods, item, literal: p.replace(/\{[^}]+\}/g, '').length });
  }
  // Most specific first: fewer parameters, then more literal text.
  routes.sort((a, b) => a.names.length - b.names.length || b.literal - a.literal);
  return routes;
}

function pickResponse(op, want) {
  const rs = isObj(op.responses) ? op.responses : {};
  const codes = Object.keys(rs).filter(c => !/^x-/.test(c));
  if (want && codes.includes(want)) return want;
  if (want && /^\d{3}$/.test(want)) { const range = want[0] + 'XX'; if (codes.includes(range)) return range; }
  const ok = codes.filter(c => /^2\d\d$/.test(c)).sort();
  if (ok.length) return ok[0];
  if (codes.includes('2XX')) return '2XX';
  if (codes.includes('default')) return 'default';
  return codes.sort()[0] || null;
}

/** { status, contentType, body (string or null) } for an operation. */
function mockResponse(spec, family, op, want) {
  const code = pickResponse(op, want);
  if (code === null) return { status: 200, contentType: null, body: null };
  const status = /^\d{3}$/.test(code) ? Number(code) : /^\dXX$/.test(code) ? Number(code[0] + '00') : want === 'default' ? 500 : 200;
  const r = resolve(spec, op.responses[code]);
  if (!isObj(r)) return { status, contentType: null, body: null };
  let ct = null, value;
  if (family === '2.0') {
    const produces = Array.isArray(op.produces) ? op.produces : Array.isArray(spec.produces) ? spec.produces : ['application/json'];
    const ex = isObj(r.examples) ? r.examples : {};
    ct = produces.find(c => /json/i.test(c)) || produces[0] || 'application/json';
    if (ex[ct] !== undefined) value = ex[ct];
    else if (Object.keys(ex).length) { ct = Object.keys(ex)[0]; value = ex[ct]; }
    else if (r.schema !== undefined) value = exampleFor(r.schema, spec, 0, { mode: 'response' });
    else return { status, contentType: null, body: null };
  } else {
    const content = isObj(r.content) ? r.content : {};
    const cts = Object.keys(content);
    if (!cts.length) return { status, contentType: null, body: null };
    ct = cts.find(c => /^application\/(.+\+)?json/i.test(c)) || cts.find(c => /json/i.test(c)) || cts[0];
    const m = isObj(content[ct]) ? content[ct] : {};
    if (m.example !== undefined) value = m.example;
    else if (isObj(m.examples) && Object.keys(m.examples).length) {
      const first = resolve(spec, m.examples[Object.keys(m.examples)[0]]);
      value = isObj(first) && 'value' in first ? first.value : exampleFor(m.schema, spec, 0, { mode: 'response' });
    } else value = exampleFor(m.schema, spec, 0, { mode: 'response' });
  }
  if (ct === '*/*') ct = 'application/json';
  const body = /json/i.test(ct) ? JSON.stringify(value, null, 2) : typeof value === 'string' ? value : JSON.stringify(value);
  return { status, contentType: ct, body };
}

/**
 * A mock server for the spec. Listens on 127.0.0.1 only (another host throws). start() resolves to
 * { url, port, prefixes }. Answers: the example of the lowest 2xx response, or the code from a "Prefer: code=404"
 * header or a ?__code=404 query. 404 for an unknown path, 405 for a known path with another method,
 * 413 for a request body over 1 MB. CORS is open so a local web page can call it.
 */
function createMockServer(spec, family, opts = {}) {
  const host = opts.host || '127.0.0.1';
  if (host !== '127.0.0.1') throw new Error('The mock server listens on 127.0.0.1 only.');
  const fam = family || familyOf(spec);
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const routes = compileRoutes(spec);
  const prefixes = prefixesOf(spec, fam);
  let server = null;

  const send = (res, status, ct, body, extra = {}) => {
    const headers = {
      'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS, HEAD, PATCH',
      'Access-Control-Allow-Headers': '*', 'Access-Control-Expose-Headers': '*', 'X-Mock-Server': 'zovo-openapi', ...extra,
    };
    if (ct) headers['Content-Type'] = /^text\/|json|xml|yaml/i.test(ct) && !/charset/i.test(ct) ? ct + '; charset=utf-8' : ct;
    res.writeHead(status, headers);
    res.end(body === null || body === undefined || status === 204 || status === 304 ? undefined : body);
  };

  const handle = (req, res, t0) => {
    let u;
    try { u = new URL(req.url, 'http://127.0.0.1'); } catch { send(res, 400, 'application/json', JSON.stringify({ error: 'bad request URL' })); return 400; }
    const method = String(req.method || 'GET').toLowerCase();
    if (method === 'options' && req.headers['access-control-request-method']) { send(res, 204, null, null); return 204; }
    let pathname;
    try { pathname = decodeURI(u.pathname); } catch { pathname = u.pathname; }
    const candidates = [pathname];
    for (const p of prefixes) if (pathname === p || pathname.startsWith(p + '/')) candidates.unshift(pathname.slice(p.length) || '/');
    let found = null, pathOnly = null;
    for (const c of candidates) {
      for (const r of routes) {
        const m = r.re.exec(c);
        if (!m) continue;
        if (r.methods.includes(method) || (method === 'head' && r.methods.includes('get'))) { found = { r, m }; break; }
        if (!pathOnly) pathOnly = r;
      }
      if (found) break;
    }
    if (!found) {
      if (pathOnly) {
        send(res, 405, 'application/json', JSON.stringify({ error: `${method.toUpperCase()} is not defined for ${pathOnly.path}`, allowed: pathOnly.methods.map(x => x.toUpperCase()) }), { Allow: pathOnly.methods.map(x => x.toUpperCase()).join(', ') });
        return 405;
      }
      send(res, 404, 'application/json', JSON.stringify({ error: `No operation in the spec matches ${pathname}` }));
      return 404;
    }
    const op = found.r.item[method === 'head' && !found.r.item.head ? 'get' : method];
    const prefer = /code=(\d{3}|default)/i.exec(String(req.headers.prefer || ''));
    const want = u.searchParams.get('__code') || (prefer && prefer[1]) || null;
    const r = mockResponse(spec, fam, op, want);
    send(res, r.status, r.contentType, method === 'head' ? null : r.body, { 'X-Mock-Operation': `${method.toUpperCase()} ${found.r.path}` });
    return r.status;
  };

  return {
    routes: routes.map(r => ({ path: r.path, methods: r.methods.map(m => m.toUpperCase()) })),
    prefixes,
    get url() { const a = server && server.address(); return a ? `http://127.0.0.1:${a.port}` : ''; },
    start() {
      if (server) return Promise.resolve({ url: this.url, port: server.address().port, prefixes });
      server = http.createServer((req, res) => {
        const t0 = Date.now();
        let size = 0, tooBig = false;
        req.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_BODY && !tooBig) {
            tooBig = true;
            send(res, 413, 'application/json', JSON.stringify({ error: 'The request body is larger than 1 MB.' }), { Connection: 'close' });
            log({ method: req.method, url: req.url, status: 413, ms: Date.now() - t0 });
            req.resume();
          }
        });
        req.on('end', () => {
          if (tooBig) return;
          let status = 500;
          try { status = handle(req, res, t0); }
          catch (e) { send(res, 500, 'application/json', JSON.stringify({ error: String(e && e.message || e) })); }
          log({ method: req.method, url: req.url, status, ms: Date.now() - t0 });
        });
        req.on('error', () => {});
      });
      const port = Number.isInteger(opts.port) ? opts.port : 0;
      return new Promise((res, rej) => {
        server.once('error', e => { server = null; rej(e); });
        server.listen(port, host, () => res({ url: this.url, port: server.address().port, prefixes }));
      });
    },
    stop() {
      if (!server) return Promise.resolve();
      const s = server; server = null;
      return new Promise(res => { s.close(() => res()); if (s.closeAllConnections) s.closeAllConnections(); });
    },
  };
}

module.exports = { exampleFor, createMockServer, mockResponse, compileRoutes, prefixesOf, FORMATS };
