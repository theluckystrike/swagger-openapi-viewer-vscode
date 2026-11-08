'use strict';
// Structural checks for Swagger 2.0 and OpenAPI 3.0 / 3.1 / 3.2. Not a full JSON Schema validation: these are the
// mistakes that break a preview or a code generator. Each issue: { severity: 'error'|'warning'|'info', message, path }.
// `path` is a path in the bundled spec; the caller maps it to a file and line.
const { pointerToPath, getPath } = require('./spec');

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const PARAM_IN_3 = ['query', 'header', 'path', 'cookie'];
const PARAM_IN_2 = ['query', 'header', 'path', 'formData', 'body'];
const TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'];
const MAX_ISSUES = 2000;

function validate(spec, family, opts = {}) {
  const issues = [];
  const add = (severity, message, path) => { if (issues.length < MAX_ISSUES) issues.push({ severity, message, path }); };
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) { add('error', 'The document is not an object with openapi or swagger at the top.', []); return issues; }
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

  if (family === 'unknown') {
    if (spec.openapi !== undefined) add('error', `openapi: "${spec.openapi}" is not a version this viewer knows (2.0, 3.0.x, 3.1.x, 3.2.x).`, ['openapi']);
    else if (spec.swagger !== undefined) add('error', `swagger: "${spec.swagger}" must be "2.0".`, ['swagger']);
    else add('error', 'The document has no openapi or swagger field.', []);
  }
  if (spec.openapi !== undefined && typeof spec.openapi !== 'string') add('warning', 'openapi should be a string, for example "3.0.3" (in quotes). Some tools read 3.0 as a number.', ['openapi']);

  if (!isObj(spec.info)) add('error', 'info is required.', ['info']);
  else {
    if (typeof spec.info.title !== 'string' || !spec.info.title) add('error', 'info.title is required.', ['info']);
    if (spec.info.version === undefined || spec.info.version === '') add('error', 'info.version is required.', ['info']);
  }
  const v3 = family.startsWith('3');
  if (family === '3.0' && !isObj(spec.paths)) add('error', 'paths is required in OpenAPI 3.0.', ['paths']);
  if (family === '2.0' && !isObj(spec.paths)) add('error', 'paths is required in Swagger 2.0.', ['paths']);
  if ((family === '3.1' || family === '3.2') && !isObj(spec.paths) && !isObj(spec.webhooks) && !isObj(spec.components)) add('error', 'OpenAPI 3.1 needs at least one of paths, webhooks or components.', []);

  if (v3 && spec.servers !== undefined) {
    if (!Array.isArray(spec.servers)) add('error', 'servers must be a list.', ['servers']);
    else spec.servers.forEach((s, i) => { if (!isObj(s) || typeof s.url !== 'string') add('error', 'Each server needs a url.', ['servers', String(i)]); });
  }

  const securityDefs = family === '2.0' ? (isObj(spec.securityDefinitions) ? spec.securityDefinitions : {}) : (isObj(spec.components) && isObj(spec.components.securitySchemes) ? spec.components.securitySchemes : {});
  const checkSecurity = (sec, path) => {
    if (sec === undefined) return;
    if (!Array.isArray(sec)) { add('error', 'security must be a list of requirement objects.', path); return; }
    sec.forEach((req, i) => {
      if (!isObj(req)) return;
      for (const name of Object.keys(req)) if (!Object.prototype.hasOwnProperty.call(securityDefs, name)) add('error', `Security scheme "${name}" is not defined in ${family === '2.0' ? 'securityDefinitions' : 'components.securitySchemes'}.`, [...path, String(i), name]);
    });
  };
  checkSecurity(spec.security, ['security']);

  const opIds = new Map();
  const checkParams = (params, path, family) => {
    if (params === undefined) return [];
    if (!Array.isArray(params)) { add('error', 'parameters must be a list.', path); return []; }
    const seen = new Set();
    const out = [];
    params.forEach((p0, i) => {
      const pp = [...path, String(i)];
      const p = isObj(p0) && typeof p0.$ref === 'string' ? deref(spec, p0.$ref) : p0;
      if (!isObj(p)) return;
      if (p['x-unresolved-ref']) return;
      if (typeof p.name !== 'string' || !p.name) add('error', 'A parameter needs a name.', pp);
      const ins = family === '2.0' ? PARAM_IN_2 : PARAM_IN_3;
      if (!ins.includes(p.in)) add('error', `Parameter "${p.name}": in must be one of ${ins.join(', ')}${p.in ? ` (it is "${p.in}")` : ''}.`, pp);
      if (p.in === 'path' && p.required !== true) add('error', `Path parameter "${p.name}" must have required: true.`, pp);
      if (family !== '2.0' && p.schema === undefined && p.content === undefined) add('warning', `Parameter "${p.name}" has no schema or content.`, pp);
      if (family === '2.0' && p.in !== 'body' && p.type === undefined && p.in !== undefined) add('warning', `Parameter "${p.name}" has no type.`, pp);
      const k = p.in + ':' + p.name;
      if (seen.has(k)) add('error', `Parameter "${p.name}" in ${p.in} is listed twice.`, pp);
      seen.add(k);
      out.push(p);
    });
    return out;
  };

  const walkPaths = (paths, base) => {
    if (!isObj(paths)) return;
    const templates = new Map();
    for (const route of Object.keys(paths)) {
      const item0 = paths[route];
      const ip = [...base, route];
      if (base[0] === 'paths' && !route.startsWith('/')) add('error', `Path "${route}" must start with /.`, ip);
      if (base[0] === 'paths') {
        const norm = route.replace(/\{[^}]*\}/g, '{}');
        if (templates.has(norm) && templates.get(norm) !== route) add('warning', `Paths "${templates.get(norm)}" and "${route}" are the same apart from parameter names.`, ip);
        templates.set(norm, route);
      }
      const item = isObj(item0) && typeof item0.$ref === 'string' ? (deref(spec, item0.$ref) || item0) : item0;
      if (!isObj(item)) continue;
      const shared = checkParams(item.parameters, [...ip, 'parameters'], family);
      const names = [...route.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
      for (const m of METHODS.concat(family === '3.2' ? ['query'] : [])) {
        const op = item[m];
        if (op === undefined) continue;
        const op_ = [...ip, m];
        if (!isObj(op)) { add('error', `${m.toUpperCase()} ${route} must be an object.`, op_); continue; }
        const own = checkParams(op.parameters, [...op_, 'parameters'], family);
        if (op.operationId !== undefined) {
          if (opIds.has(op.operationId)) add('error', `operationId "${op.operationId}" is used twice (also ${opIds.get(op.operationId)}).`, [...op_, 'operationId']);
          else opIds.set(op.operationId, `${m.toUpperCase()} ${route}`);
        }
        if (op.responses === undefined) { if (family !== '3.1' && family !== '3.2') add('error', `${m.toUpperCase()} ${route} has no responses.`, op_); }
        else if (!isObj(op.responses)) add('error', 'responses must be an object.', [...op_, 'responses']);
        else {
          const codes = Object.keys(op.responses);
          if (!codes.length && family !== '3.1' && family !== '3.2') add('warning', `${m.toUpperCase()} ${route} has an empty responses object.`, [...op_, 'responses']);
          for (const c of codes) if (!/^([1-5](\d\d|XX)|default)$/.test(c) && !c.startsWith('x-')) add('error', `Response code "${c}" is not valid (use 200, 4XX or default).`, [...op_, 'responses', c]);
        }
        if (base[0] === 'paths') {
          const pathParams = new Set([...shared, ...own].filter(p => p.in === 'path').map(p => p.name));
          for (const n of names) if (!pathParams.has(n)) add('error', `${m.toUpperCase()} ${route}: path parameter "{${n}}" is not declared in parameters.`, op_);
          for (const n of pathParams) if (!names.includes(n)) add('error', `${m.toUpperCase()} ${route}: parameter "${n}" is in: path but not in the path.`, op_);
        }
        if (family === '2.0' && [...shared, ...own].filter(p => p.in === 'body').length > 1) add('error', `${m.toUpperCase()} ${route} has more than one body parameter.`, op_);
        if ((m === 'get' || m === 'head') && op.requestBody !== undefined) add('info', `${m.toUpperCase()} ${route} has a requestBody. Many servers and tools ignore a body on ${m.toUpperCase()}.`, [...op_, 'requestBody']);
        checkSecurity(op.security, [...op_, 'security']);
      }
    }
  };
  walkPaths(spec.paths, ['paths']);
  if (isObj(spec.webhooks)) walkPaths(spec.webhooks, ['webhooks']);

  // Schemas: type values and version-specific keywords.
  let schemaCount = 0;
  const seenSchemas = new Set();
  const checkSchema = (s, path, depth) => {
    if (!isObj(s) || depth > 60 || seenSchemas.has(s) || schemaCount > 200000) return;
    seenSchemas.add(s); schemaCount++;
    const t = s.type;
    if (typeof t === 'string' && !TYPES.includes(t)) add('error', `type "${t}" is not a JSON Schema type.`, [...path, 'type']);
    if (Array.isArray(t)) {
      if (family !== '3.1' && family !== '3.2') add('warning', `type as a list (${JSON.stringify(t)}) is OpenAPI 3.1. In ${family === '2.0' ? 'Swagger 2.0' : 'OpenAPI 3.0'} use one type${family === '3.0' ? ' and nullable: true' : ''}.`, [...path, 'type']);
      for (const x of t) if (!TYPES.includes(x)) add('error', `type "${x}" is not a JSON Schema type.`, [...path, 'type']);
    }
    if (t === 'null' && family !== '3.1' && family !== '3.2') add('warning', 'type: null is OpenAPI 3.1. In 3.0 use nullable: true.', [...path, 'type']);
    if (s.nullable !== undefined && (family === '3.1' || family === '3.2')) add('warning', 'nullable is not in OpenAPI 3.1. Use type: [<type>, "null"].', [...path, 'nullable']);
    if (s.nullable !== undefined && family === '2.0') add('info', 'nullable is not in Swagger 2.0 (x-nullable is the usual extension).', [...path, 'nullable']);
    if (t === 'array' && s.items === undefined && family !== '3.1' && family !== '3.2') add('error', 'A schema with type: array needs items.', path);
    if (s.required !== undefined && !Array.isArray(s.required) && typeof s.required !== 'boolean') add('error', 'required must be a list of property names.', [...path, 'required']);
    if (Array.isArray(s.required) && isObj(s.properties)) for (const r of s.required) if (typeof r === 'string' && !Object.prototype.hasOwnProperty.call(s.properties, r) && !s.allOf && !s.additionalProperties && !s.oneOf && !s.anyOf) add('warning', `required lists "${r}", which is not in properties.`, [...path, 'required']);
    if (isObj(s.properties)) for (const k of Object.keys(s.properties)) checkSchema(s.properties[k], [...path, 'properties', k], depth + 1);
    if (isObj(s.items)) checkSchema(s.items, [...path, 'items'], depth + 1);
    for (const k of ['allOf', 'anyOf', 'oneOf']) if (Array.isArray(s[k])) s[k].forEach((x, i) => checkSchema(x, [...path, k, String(i)], depth + 1));
    if (isObj(s.additionalProperties)) checkSchema(s.additionalProperties, [...path, 'additionalProperties'], depth + 1);
  };
  const schemas = family === '2.0' ? spec.definitions : (isObj(spec.components) ? spec.components.schemas : undefined);
  if (isObj(schemas)) for (const k of Object.keys(schemas)) checkSchema(schemas[k], [family === '2.0' ? 'definitions' : 'components', ...(family === '2.0' ? [] : ['schemas']), k], 0);

  // Every internal $ref must point to something.
  const refs = [];
  collectRefs(spec, [], refs, 0);
  const missing = new Map();
  for (const { ref, path } of refs) {
    if (!ref.startsWith('#')) continue;
    const p = pointerToPath(ref.slice(1));
    const own = path.slice(0, -1);
    if (p && p.length === own.length && p.every((x, i) => x === own[i])) { add('error', `$ref "${ref}" points to itself.`, path); continue; }
    if (p === null || getPath(spec, p) === undefined) {
      if (!missing.has(ref)) missing.set(ref, 0);
      const n = missing.get(ref) + 1; missing.set(ref, n);
      if (n <= 5) add('error', `$ref "${ref}" points to nothing.`, path);
    }
  }
  for (const u of opts.unresolved || []) add(u.code === 'remote-blocked' ? 'warning' : 'error', `$ref "${u.ref}" was not loaded: ${u.reason}.`, null);
  return issues;
}

function collectRefs(v, path, out, depth) {
  if (!v || typeof v !== 'object' || depth > 400 || out.length > 500000) return;
  if (Array.isArray(v)) { v.forEach((c, i) => { if (c && typeof c === 'object') collectRefs(c, [...path, String(i)], out, depth + 1); }); return; }
  if (typeof v.$ref === 'string') out.push({ ref: v.$ref, path: [...path, '$ref'] });
  for (const k of Object.keys(v)) {
    const parent = path[path.length - 1];
    if ((k === 'example' || k === 'default' || k === 'enum' || k === 'const') && parent !== 'responses' && parent !== 'properties' && parent !== 'patternProperties') continue;
    const c = v[k];
    if (c && typeof c === 'object') collectRefs(c, [...path, k], out, depth + 1);
  }
}

function deref(spec, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) return undefined;
  let v, seen = 0;
  let r = ref;
  while (typeof r === 'string' && r.startsWith('#') && seen++ < 20) {
    const p = pointerToPath(r.slice(1));
    v = p ? getPath(spec, p) : undefined;
    r = v && typeof v === 'object' ? v.$ref : undefined;
  }
  return v;
}

/** Counts for the status line. */
function stats(spec) {
  let ops = 0;
  const paths = spec && typeof spec.paths === 'object' && spec.paths ? spec.paths : {};
  for (const k of Object.keys(paths)) { const it = paths[k]; if (it && typeof it === 'object') for (const m of METHODS) if (it[m]) ops++; }
  const schemas = spec && (spec.definitions || (spec.components && spec.components.schemas)) || {};
  return { paths: Object.keys(paths).length, operations: ops, schemas: typeof schemas === 'object' ? Object.keys(schemas).length : 0, webhooks: spec && spec.webhooks && typeof spec.webhooks === 'object' ? Object.keys(spec.webhooks).length : 0 };
}

module.exports = { validate, stats, deref, METHODS };
