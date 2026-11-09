'use strict';
// Version converters for the root document: Swagger 2.0 to OpenAPI 3.0, and OpenAPI 3.0 to 3.1.
// Pure Node. The input is never changed: each converter works on a deep copy. External file $refs stay as they are,
// and a note names each external file that may need the same conversion.
const YAML = require('../../vendor/yaml');
const { pointerToPath, pathToPointer } = require('./spec');

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isExt = k => /^x-/i.test(k);
const COMPONENT_NAME = /^[a-zA-Z0-9._-]+$/;

const SCHEMA_KEYS = ['format', 'items', 'collectionFormat', 'default', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum',
  'maxLength', 'minLength', 'pattern', 'maxItems', 'minItems', 'uniqueItems', 'enum', 'multipleOf'];

// ---- Swagger 2.0 -> OpenAPI 3.0 -------------------------------------------------------------------------------------

/** Converts a Swagger 2.0 document. Returns { spec, notes }. */
function swagger2ToOas30(data) {
  if (!isObj(data)) throw new Error('The document is not an object.');
  if (String(data.swagger || '') !== '2.0') throw new Error('This is not a Swagger 2.0 document (swagger: "2.0" is missing).');
  const src = clone(data);
  const notes = [];
  const noteOnce = new Set();
  const note = s => { if (!noteOnce.has(s)) { noteOnce.add(s); notes.push(s); } };
  const externals = new Set();

  // Component names must match ^[a-zA-Z0-9._-]+$ in 3.0. Names that do not are renamed, and every $ref follows.
  const rename = { definitions: new Map(), parameters: new Map(), responses: new Map() };
  const used = { definitions: new Set(), parameters: new Set(), responses: new Set() };
  for (const sec of ['definitions', 'parameters', 'responses']) {
    if (!isObj(src[sec])) continue;
    for (const k of Object.keys(src[sec])) used[sec].add(k);
    for (const k of Object.keys(src[sec])) {
      if (COMPONENT_NAME.test(k)) continue;
      let n = k.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'Component';
      let i = 2;
      while (used[sec].has(n)) n = n.replace(/_\d+$/, '') + '_' + i++;
      used[sec].add(n);
      rename[sec].set(k, n);
      note(`${sec}["${k}"] is renamed to "${n}", because OpenAPI 3 component names allow only letters, digits, ".", "-" and "_".`);
    }
  }
  const nameOf = (sec, k) => rename[sec].get(k) || k;

  const globalParams = isObj(src.parameters) ? src.parameters : {};
  const bodyParamNames = new Set(Object.keys(globalParams).filter(k => isObj(globalParams[k]) && globalParams[k].in === 'body'));
  const formParamNames = new Set(Object.keys(globalParams).filter(k => isObj(globalParams[k]) && globalParams[k].in === 'formData'));

  /** New $ref for an old one. Local refs to definitions, parameters and responses move into components. */
  const mapRef = ref => {
    if (typeof ref !== 'string') return ref;
    const hash = ref.indexOf('#');
    const file = hash === -1 ? ref : ref.slice(0, hash);
    if (file) { externals.add(file); return ref; }
    const p = pointerToPath(ref.slice(hash + 1));
    if (!p || p.length < 2) return ref;
    const [sec, name, ...rest] = p;
    if (sec === 'definitions') return '#' + pathToPointer(['components', 'schemas', nameOf('definitions', name), ...rest]);
    if (sec === 'parameters') {
      if (bodyParamNames.has(name)) return '#' + pathToPointer(['components', 'requestBodies', nameOf('parameters', name), ...rest]);
      return '#' + pathToPointer(['components', 'parameters', nameOf('parameters', name), ...rest]);
    }
    if (sec === 'responses') return '#' + pathToPointer(['components', 'responses', nameOf('responses', name), ...rest]);
    return ref;
  };

  const convertSchema = (s, depth = 0) => {
    if (!isObj(s) || depth > 400) return s;
    const out = {};
    for (const k of Object.keys(s)) {
      const v = s[k];
      if (k === '$ref') { out.$ref = mapRef(v); continue; }
      if (k === 'x-nullable') { if (v === true) out.nullable = true; continue; }
      if (k === 'discriminator' && typeof v === 'string') { out.discriminator = { propertyName: v }; continue; }
      if (k === 'type' && v === 'file') { out.type = 'string'; out.format = 'binary'; continue; }
      if (k === 'format' && s.type === 'file') continue;
      if (['properties', 'patternProperties', 'definitions'].includes(k) && isObj(v)) {
        out[k] = {};
        for (const pk of Object.keys(v)) out[k][pk] = convertSchema(v[pk], depth + 1);
        continue;
      }
      if (['allOf', 'anyOf', 'oneOf'].includes(k) && Array.isArray(v)) { out[k] = v.map(x => convertSchema(x, depth + 1)); continue; }
      if (k === 'items') { out.items = Array.isArray(v) ? convertSchema(v[0] || {}, depth + 1) : convertSchema(v, depth + 1); continue; }
      if (['additionalProperties', 'not'].includes(k) && isObj(v)) { out[k] = convertSchema(v, depth + 1); continue; }
      out[k] = v;
    }
    return out;
  };

  /** Schema of a non-body parameter, header or items object (the 2.0 "simple" types). */
  const simpleSchema = p => {
    const s = {};
    if (p.type !== undefined) s.type = p.type === 'file' ? 'string' : p.type;
    if (p.type === 'file') s.format = 'binary';
    for (const k of SCHEMA_KEYS) {
      if (p[k] === undefined || k === 'collectionFormat') continue;
      if (k === 'format' && p.type === 'file') continue;
      s[k] = k === 'items' && isObj(p.items) ? simpleSchema(p.items) : clone(p[k]);
    }
    if (p['x-nullable'] === true) s.nullable = true;
    if (isObj(p.items) && p.items.$ref) s.items = { $ref: mapRef(p.items.$ref) };
    return s;
  };

  const styleOf = (p, where) => {
    const cf = p.collectionFormat;
    if (p.type !== 'array' || !cf) return null;
    if (cf === 'multi') return where === 'query' ? { style: 'form', explode: true } : null;
    if (cf === 'csv') return where === 'query' || where === 'cookie' ? { style: 'form', explode: false } : { style: 'simple' };
    if (cf === 'ssv') return where === 'query' ? { style: 'spaceDelimited' } : null;
    if (cf === 'pipes') return where === 'query' ? { style: 'pipeDelimited' } : null;
    if (cf === 'tsv') { note('collectionFormat: tsv has no OpenAPI 3 style. Those parameters use the default style.'); return null; }
    return null;
  };

  const convertParam = p => {
    if (!isObj(p)) return p;
    if (typeof p.$ref === 'string') return { $ref: mapRef(p.$ref) };
    const out = { name: p.name, in: p.in };
    if (p.description !== undefined) out.description = p.description;
    if (p.in === 'path') out.required = true; else if (p.required !== undefined) out.required = p.required;
    if (p.allowEmptyValue !== undefined && p.in === 'query') out.allowEmptyValue = p.allowEmptyValue;
    const st = styleOf(p, p.in);
    if (st) Object.assign(out, st);
    out.schema = simpleSchema(p);
    if (p['x-example'] !== undefined) out.example = p['x-example'];
    for (const k of Object.keys(p)) if (isExt(k) && k !== 'x-example' && k !== 'x-nullable') out[k] = p[k];
    return out;
  };

  const convertHeader = h => {
    if (!isObj(h)) return h;
    const out = {};
    if (h.description !== undefined) out.description = h.description;
    const st = styleOf(h, 'header');
    if (st) Object.assign(out, st);
    out.schema = simpleSchema(h);
    for (const k of Object.keys(h)) if (isExt(k)) out[k] = h[k];
    return out;
  };

  const formTypes = cts => cts.filter(c => /^(multipart\/form-data|application\/x-www-form-urlencoded)\b/i.test(c));

  /** requestBody from a body parameter. */
  const bodyFrom = (p, consumes) => {
    const out = {};
    if (p.description !== undefined) out.description = p.description;
    out.content = {};
    const cts = consumes.filter(c => !formTypes([c]).length);
    const list = cts.length ? cts : ['application/json'];
    const schema = convertSchema(p.schema || {});
    const ex = isObj(p['x-examples']) ? p['x-examples'] : null;
    for (const c of list) {
      out.content[c] = { schema: clone(schema) };
      if (ex && ex[c] !== undefined) out.content[c].example = ex[c];
    }
    if (p.required === true) out.required = true;
    for (const k of Object.keys(p)) if (isExt(k) && k !== 'x-examples') out[k] = p[k];
    if (p.name && p.name !== 'body') out['x-codegen-request-body-name'] = p.name;
    return out;
  };

  /** requestBody from formData parameters. */
  const formFrom = (params, consumes) => {
    const anyFile = params.some(p => p.type === 'file');
    let cts = formTypes(consumes);
    if (!cts.length) cts = [anyFile ? 'multipart/form-data' : 'application/x-www-form-urlencoded'];
    if (anyFile && !cts.some(c => /^multipart/i.test(c))) { note('A form with a file field is sent as multipart/form-data.'); cts = ['multipart/form-data']; }
    const schema = { type: 'object', properties: {} };
    const required = [];
    for (const p of params) {
      const s = simpleSchema(p);
      if (p.description !== undefined) s.description = p.description;
      schema.properties[p.name] = s;
      if (p.required) required.push(p.name);
    }
    if (required.length) schema.required = required;
    const out = { content: {} };
    for (const c of cts) {
      out.content[c] = { schema: clone(schema) };
      if (/^multipart/i.test(c)) {
        const enc = {};
        for (const p of params) if (p.type === 'array' && p.collectionFormat && p.collectionFormat !== 'multi') enc[p.name] = { style: 'form', explode: false };
        if (Object.keys(enc).length) out.content[c].encoding = enc;
      }
    }
    if (required.length) out.required = true;
    return out;
  };

  const convertResponse = (r, produces) => {
    if (!isObj(r)) return r;
    if (typeof r.$ref === 'string') return { $ref: mapRef(r.$ref) };
    const out = { description: r.description !== undefined ? r.description : '' };
    if (isObj(r.headers)) { out.headers = {}; for (const k of Object.keys(r.headers)) out.headers[k] = convertHeader(r.headers[k]); }
    const ex = isObj(r.examples) ? r.examples : {};
    if (r.schema !== undefined || Object.keys(ex).length) {
      out.content = {};
      const list = produces.length ? produces.slice() : ['application/json'];
      for (const c of Object.keys(ex)) if (!list.includes(c)) list.push(c);
      for (const c of list) {
        const m = {};
        if (r.schema !== undefined) m.schema = convertSchema(r.schema);
        if (ex[c] !== undefined) m.example = ex[c];
        out.content[c] = m;
      }
    }
    for (const k of Object.keys(r)) if (isExt(k)) out[k] = r[k];
    return out;
  };

  const resolveParam = p => {
    if (isObj(p) && typeof p.$ref === 'string' && p.$ref.startsWith('#/parameters/')) {
      const name = pointerToPath(p.$ref.slice(1))[1];
      return { ref: p, name, def: globalParams[name] };
    }
    return { ref: null, def: p };
  };

  const gConsumes = Array.isArray(src.consumes) ? src.consumes : [];
  const gProduces = Array.isArray(src.produces) ? src.produces : [];

  const out = { openapi: '3.0.3' };
  for (const k of Object.keys(src)) if (isExt(k)) out[k] = src[k];
  if (src.info !== undefined) out.info = src.info;
  if (src.externalDocs !== undefined) out.externalDocs = src.externalDocs;

  // servers
  const schemes = Array.isArray(src.schemes) && src.schemes.length ? src.schemes : null;
  const basePath = typeof src.basePath === 'string' ? src.basePath.replace(/\/$/, '') : '';
  if (src.host) {
    out.servers = (schemes || ['https']).map(s => ({ url: `${s}://${src.host}${basePath}` }));
    if (!schemes) note('The spec has no schemes, so the server uses https.');
  } else if (basePath) out.servers = [{ url: basePath }];
  if (src.tags !== undefined) out.tags = src.tags;
  if (src.security !== undefined) out.security = src.security;

  // paths
  out.paths = {};
  const paths = isObj(src.paths) ? src.paths : {};
  for (const pk of Object.keys(paths)) {
    const item = paths[pk];
    if (!isObj(item)) { out.paths[pk] = item; continue; }
    if (typeof item.$ref === 'string') { out.paths[pk] = { $ref: mapRef(item.$ref) }; continue; }
    const newItem = {};
    const pathParams = Array.isArray(item.parameters) ? item.parameters : [];
    const pathLevelBodyish = [];
    const keptPathParams = [];
    for (const p of pathParams) {
      const { def } = resolveParam(p);
      if (isObj(def) && (def.in === 'body' || def.in === 'formData')) pathLevelBodyish.push(p);
      else keptPathParams.push(convertParam(p));
    }
    for (const k of Object.keys(item)) {
      if (k === 'parameters') { if (keptPathParams.length) newItem.parameters = keptPathParams; continue; }
      if (!METHODS.includes(k)) { newItem[k] = item[k]; continue; }
      const op = item[k];
      if (!isObj(op)) { newItem[k] = op; continue; }
      const consumes = Array.isArray(op.consumes) ? op.consumes : gConsumes;
      const produces = Array.isArray(op.produces) ? op.produces : gProduces;
      const nop = {};
      const opParams = Array.isArray(op.parameters) ? op.parameters : [];
      const opKeys = new Set(opParams.map(p => { const { def } = resolveParam(p); return isObj(def) ? def.in + ':' + def.name : ''; }));
      const all = [...pathLevelBodyish.filter(p => { const { def } = resolveParam(p); return !opKeys.has(def.in + ':' + def.name); }), ...opParams];
      const params = [];
      let body = null;
      const form = [];
      for (const p of all) {
        const { ref, name, def } = resolveParam(p);
        if (!isObj(def)) { params.push(convertParam(p)); continue; }
        if (def.in === 'body') {
          body = ref && bodyParamNames.has(name) ? { $ref: mapRef(ref.$ref) } : bodyFrom(def, consumes);
        } else if (def.in === 'formData') form.push(def);
        else params.push(convertParam(p));
      }
      for (const ok of Object.keys(op)) {
        const v = op[ok];
        if (['consumes', 'produces'].includes(ok)) continue;
        if (ok === 'parameters') { if (params.length) nop.parameters = params; continue; }
        if (ok === 'responses' && isObj(v)) {
          if (body && nop.requestBody === undefined) nop.requestBody = body;
          if (form.length && nop.requestBody === undefined) nop.requestBody = formFrom(form, consumes);
          nop.responses = {};
          for (const code of Object.keys(v)) nop.responses[code] = isExt(code) ? v[code] : convertResponse(v[code], produces);
          continue;
        }
        if (ok === 'schemes' && Array.isArray(v)) {
          if (src.host) nop.servers = v.map(s => ({ url: `${s}://${src.host}${basePath}` }));
          else note(`${k.toUpperCase()} ${pk} has schemes but the spec has no host, so they are dropped.`);
          continue;
        }
        nop[ok] = v;
      }
      if (body && nop.requestBody === undefined) nop.requestBody = body;
      if (form.length && nop.requestBody === undefined) nop.requestBody = formFrom(form, consumes);
      newItem[k] = nop;
    }
    out.paths[pk] = newItem;
  }

  // components
  const comp = {};
  if (isObj(src.definitions)) {
    comp.schemas = {};
    for (const k of Object.keys(src.definitions)) comp.schemas[nameOf('definitions', k)] = convertSchema(src.definitions[k]);
  }
  if (isObj(src.responses)) {
    comp.responses = {};
    for (const k of Object.keys(src.responses)) comp.responses[nameOf('responses', k)] = convertResponse(src.responses[k], gProduces);
  }
  if (Object.keys(globalParams).length) {
    for (const k of Object.keys(globalParams)) {
      const p = globalParams[k];
      const n = nameOf('parameters', k);
      if (isObj(p) && p.in === 'body') { (comp.requestBodies = comp.requestBodies || {})[n] = bodyFrom(p, gConsumes); continue; }
      if (isObj(p) && p.in === 'formData') { note(`Form parameter "${k}" is copied into each operation that uses it, because OpenAPI 3 has no form parameters.`); continue; }
      (comp.parameters = comp.parameters || {})[n] = convertParam(p);
    }
  }
  if (isObj(src.securityDefinitions)) {
    comp.securitySchemes = {};
    for (const k of Object.keys(src.securityDefinitions)) comp.securitySchemes[k] = convertSecurity(src.securityDefinitions[k], note);
  }
  if (Object.keys(comp).length) {
    // Fixed order: schemas, responses, parameters, requestBodies, securitySchemes.
    out.components = {};
    for (const k of ['schemas', 'responses', 'parameters', 'requestBodies', 'securitySchemes']) if (comp[k]) out.components[k] = comp[k];
  }
  if (formParamNames.size) {
    // $refs to form parameters were inlined above; any left (for example inside path items) point to nothing.
  }

  // Any $ref we did not visit (vendor extensions, examples are left alone on purpose).
  for (const f of externals) note(`${f} is a separate file and was not converted. Convert it too if it uses Swagger 2.0 parts (definitions, body parameters).`);
  return { spec: out, notes };
}

function convertSecurity(s, note) {
  if (!isObj(s)) return s;
  const out = {};
  if (s.type === 'basic') { out.type = 'http'; out.scheme = 'basic'; }
  else if (s.type === 'apiKey') { out.type = 'apiKey'; out.name = s.name; out.in = s.in; }
  else if (s.type === 'oauth2') {
    out.type = 'oauth2';
    const scopes = isObj(s.scopes) ? s.scopes : {};
    const flows = {};
    if (s.flow === 'implicit') flows.implicit = { authorizationUrl: s.authorizationUrl, scopes };
    else if (s.flow === 'password') flows.password = { tokenUrl: s.tokenUrl, scopes };
    else if (s.flow === 'application') flows.clientCredentials = { tokenUrl: s.tokenUrl, scopes };
    else if (s.flow === 'accessCode') flows.authorizationCode = { authorizationUrl: s.authorizationUrl, tokenUrl: s.tokenUrl, scopes };
    else note(`oauth2 flow "${s.flow}" is not a Swagger 2.0 flow, so it was not converted.`);
    out.flows = flows;
  } else return clone(s);
  if (s.description !== undefined) out.description = s.description;
  for (const k of Object.keys(s)) if (isExt(k)) out[k] = s[k];
  return out;
}

// ---- OpenAPI 3.0 -> 3.1 ---------------------------------------------------------------------------------------------

/** Converts an OpenAPI 3.0.x document to 3.1.0. Returns { spec, notes }. */
function oas30ToOas31(data) {
  if (!isObj(data)) throw new Error('The document is not an object.');
  if (!/^3\.0(\.|$)/.test(String(data.openapi || ''))) throw new Error('This is not an OpenAPI 3.0 document (openapi: 3.0.x is missing).');
  const spec = clone(data);
  const notes = [];
  const noteOnce = new Set();
  const note = s => { if (!noteOnce.has(s)) { noteOnce.add(s); notes.push(s); } };
  const externals = new Set();
  const counts = { nullable: 0, exclusive: 0, example: 0, binary: 0 };
  spec.openapi = '3.1.0';

  const schema = (s, depth = 0) => {
    if (!isObj(s) || depth > 400) return s;
    if (typeof s.$ref === 'string') { const f = s.$ref.split('#')[0]; if (f) externals.add(f); }
    if ('nullable' in s) {
      const nul = s.nullable === true;
      delete s.nullable;
      if (nul) {
        counts.nullable++;
        if (typeof s.type === 'string') s.type = [s.type, 'null'];
        else if (Array.isArray(s.type)) { if (!s.type.includes('null')) s.type.push('null'); }
        else if (Array.isArray(s.oneOf)) s.oneOf.push({ type: 'null' });
        else if (Array.isArray(s.anyOf)) s.anyOf.push({ type: 'null' });
        else if (s.$ref === undefined) note('A nullable schema without a type now allows any value, which includes null.');
        if (Array.isArray(s.enum) && !s.enum.includes(null)) s.enum.push(null);
      }
    }
    for (const [ex, lim] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']]) {
      if (typeof s[ex] === 'boolean') {
        counts.exclusive++;
        if (s[ex] && typeof s[lim] === 'number') { s[ex] = s[lim]; delete s[lim]; } else delete s[ex];
      }
    }
    if ('example' in s) {
      counts.example++;
      if (!Array.isArray(s.examples)) s.examples = [s.example];
      delete s.example;
    }
    if (s.type === 'string' || (Array.isArray(s.type) && s.type.includes('string'))) {
      if (s.format === 'binary') { counts.binary++; delete s.format; s.contentMediaType = 'application/octet-stream'; }
      else if (s.format === 'base64') { counts.binary++; delete s.format; s.contentEncoding = 'base64'; }
    }
    for (const k of ['properties', 'patternProperties', '$defs', 'definitions']) if (isObj(s[k])) for (const pk of Object.keys(s[k])) schema(s[k][pk], depth + 1);
    for (const k of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) if (Array.isArray(s[k])) s[k].forEach(x => schema(x, depth + 1));
    for (const k of ['items', 'additionalProperties', 'not', 'contains', 'propertyNames', 'if', 'then', 'else']) if (isObj(s[k])) schema(s[k], depth + 1);
    return s;
  };

  const media = (content) => {
    if (!isObj(content)) return;
    for (const ct of Object.keys(content)) {
      const m = content[ct];
      if (!isObj(m)) continue;
      const s = m.schema;
      // A whole binary body: 3.1 describes it by the media type alone.
      if (isObj(s) && s.type === 'string' && (s.format === 'binary' || s.format === 'base64') && !/^(multipart\/|application\/x-www-form-urlencoded|application\/json)/i.test(ct)) {
        const keep = {};
        for (const k of Object.keys(s)) if (!['type', 'format'].includes(k)) keep[k] = s[k];
        if (s.format === 'base64') { keep.type = 'string'; keep.contentEncoding = 'base64'; }
        m.schema = keep;
        counts.binary++;
        schema(m.schema);
      } else schema(s);
      if (isObj(m.encoding)) for (const e of Object.values(m.encoding)) if (isObj(e) && isObj(e.headers)) Object.values(e.headers).forEach(header);
    }
  };
  const parameter = p => { if (!isObj(p)) return; schema(p.schema); media(p.content); };
  const header = h => { if (!isObj(h)) return; schema(h.schema); media(h.content); };
  const response = r => { if (!isObj(r)) return; media(r.content); if (isObj(r.headers)) Object.values(r.headers).forEach(header); };
  const operation = op => {
    if (!isObj(op)) return;
    if (Array.isArray(op.parameters)) op.parameters.forEach(parameter);
    if (isObj(op.requestBody)) media(op.requestBody.content);
    if (isObj(op.responses)) Object.values(op.responses).forEach(response);
    if (isObj(op.callbacks)) for (const cb of Object.values(op.callbacks)) if (isObj(cb)) Object.values(cb).forEach(pathItem);
  };
  const pathItem = it => {
    if (!isObj(it)) return;
    if (typeof it.$ref === 'string') { const f = it.$ref.split('#')[0]; if (f) externals.add(f); }
    if (Array.isArray(it.parameters)) it.parameters.forEach(parameter);
    for (const m of METHODS) if (isObj(it[m])) operation(it[m]);
  };

  if (isObj(spec.paths)) Object.values(spec.paths).forEach(pathItem);
  const c = spec.components;
  if (isObj(c)) {
    if (isObj(c.schemas)) Object.values(c.schemas).forEach(s => schema(s));
    if (isObj(c.parameters)) Object.values(c.parameters).forEach(parameter);
    if (isObj(c.headers)) Object.values(c.headers).forEach(header);
    if (isObj(c.responses)) Object.values(c.responses).forEach(response);
    if (isObj(c.requestBodies)) Object.values(c.requestBodies).forEach(b => { if (isObj(b)) media(b.content); });
    if (isObj(c.callbacks)) for (const cb of Object.values(c.callbacks)) if (isObj(cb)) Object.values(cb).forEach(pathItem);
  }
  if (counts.nullable) notes.push(`${counts.nullable} nullable schema(s) now use a type list with "null".`);
  if (counts.exclusive) notes.push(`${counts.exclusive} exclusiveMinimum/exclusiveMaximum value(s) are now numbers.`);
  if (counts.example) notes.push(`${counts.example} schema example(s) moved to examples (a list).`);
  if (counts.binary) notes.push(`${counts.binary} binary or base64 string(s) now use contentMediaType or contentEncoding.`);
  for (const f of externals) note(`${f} is a separate file and was not converted. Convert it too if it uses nullable, example or boolean exclusiveMinimum.`);
  return { spec, notes };
}

// ---- text -----------------------------------------------------------------------------------------------------------

/** Text for a converted spec: JSON (with the original indent when given) or YAML. */
function toText(spec, asJson, originalText) {
  if (asJson) {
    let indent = 2;
    if (typeof originalText === 'string') {
      const m = /\n([ \t]+)"/.exec(originalText.slice(0, 4096));
      if (m) indent = m[1][0] === '\t' ? '\t' : m[1].length;
    }
    return JSON.stringify(spec, null, indent) + '\n';
  }
  return YAML.stringify(spec, { lineWidth: 0, aliasDuplicateObjects: false });
}

module.exports = { swagger2ToOas30, oas30ToOas31, toText };
