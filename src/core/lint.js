'use strict';
// Lint rules for OpenAPI 3.1, 3.0 and Swagger 2.0. Pure Node, no VS Code: the worker and the tests use it.
// Rule ids follow the names of the Spectral OAS ruleset where one exists, so a `.spectral.yaml` that turns a rule off
// or changes its severity works here too. Custom Spectral rules (given/then with functions) are not run.
// Each issue: { severity, message, path, rule, data }. `path` is a path in the bundled spec; the caller maps it to a
// file and line. `data` holds what a quick fix needs.
const YAML = require('../../vendor/yaml');
const { pointerToPath, pathToPointer, getPath } = require('./spec');
const { deref, METHODS } = require('./validate');

const ALL = ['2.0', '3.0', '3.1'];
const V3 = ['3.0', '3.1'];

const RULES = [
  { id: 'oas-schema', severity: 'error', families: ALL, title: 'The document follows the OpenAPI structure', why: 'Structural mistakes break the preview and code generators, so they are errors.' },
  { id: 'operation-operationId', severity: 'warning', families: ALL, title: 'Operation has an operationId', why: 'Code generators and SDKs name their methods after the operationId.' },
  { id: 'operation-operationId-unique', severity: 'error', families: ALL, title: 'Each operationId is used once', why: 'Two operations with the same operationId give two methods with the same name in generated code.' },
  { id: 'operation-operationId-valid-in-url', severity: 'warning', families: ALL, title: 'operationId has only URL-safe characters', why: 'Some tools put the operationId in a URL or a file name, where spaces and other characters break.' },
  { id: 'operation-description', severity: 'warning', families: ALL, title: 'Operation has a description', why: 'The description is what readers of the docs see under the operation.' },
  { id: 'operation-summary', severity: 'hint', recommended: false, families: ALL, title: 'Operation has a summary', why: 'The summary is the one-line title shown in lists of operations.' },
  { id: 'operation-tags', severity: 'warning', families: ALL, title: 'Operation has at least one tag', why: 'Tags group operations in the docs and in generated clients.' },
  { id: 'operation-tag-defined', severity: 'warning', families: ALL, title: 'Operation tags are in the global tags list', why: 'A tag missing from the top-level tags list has no description and no fixed order in the docs.' },
  { id: 'operation-success-response', severity: 'warning', families: ALL, title: 'Operation has a 2xx or 3xx response', why: 'Without a success response, clients do not know what a working call returns.' },
  { id: 'operation-parameters', severity: 'warning', families: ALL, title: 'Parameters are not listed twice', why: 'A parameter with the same name and location twice is ambiguous, and tools pick one at random.' },
  { id: 'path-params', severity: 'error', families: ALL, title: 'Path parameters match the path template', why: 'Every {name} in a path needs a parameter with in: path, and every path parameter needs its {name} in the path.' },
  { id: 'path-keys-no-trailing-slash', severity: 'warning', families: ALL, title: 'Paths do not end with a slash', why: 'Many servers treat /pets and /pets/ as different routes.' },
  { id: 'path-not-include-query', severity: 'warning', families: ALL, title: 'Paths do not include a query string', why: 'Query parameters belong in parameters with in: query, not in the path key.' },
  { id: 'no-$ref-siblings', severity: 'warning', families: ['2.0', '3.0'], title: 'No keys next to $ref', why: 'In Swagger 2.0 and OpenAPI 3.0, keys next to a $ref are ignored by tools.' },
  { id: 'info-contact', severity: 'warning', families: ALL, title: 'info has a contact', why: 'Readers of the docs need to know whom to ask about the API.' },
  { id: 'info-description', severity: 'warning', families: ALL, title: 'info has a description', why: 'The description is the first text readers see in the docs.' },
  { id: 'info-license', severity: 'hint', families: ALL, title: 'info has a license', why: 'A license tells users of a public API what they may do with it.' },
  { id: 'oas3-api-servers', severity: 'warning', families: V3, title: 'servers lists at least one server', why: 'Without servers, clients and Try it have no base URL to call.' },
  { id: 'oas2-api-host', severity: 'info', families: ['2.0'], title: 'host is set', why: 'Without host, clients call the host that serves the docs.' },
  { id: 'oas3-server-trailing-slash', severity: 'warning', families: V3, title: 'Server URLs do not end with a slash', why: 'Paths start with a slash, so a server URL ending in a slash gives a double slash.' },
  { id: 'oas3-unused-component', severity: 'warning', families: V3, title: 'Every component is used', why: 'A component that no $ref uses is often left over from an older version of the API.' },
  { id: 'oas2-unused-definition', severity: 'warning', families: ['2.0'], title: 'Every definition is used', why: 'A definition that no $ref uses is often left over from an older version of the API.' },
  { id: 'invalid-ref', severity: 'error', families: ALL, title: '$ref points to something that exists', why: 'A $ref to a missing target leaves a hole in the docs and in generated code.' },
  { id: 'typed-enum', severity: 'warning', families: ALL, title: 'enum values match the type', why: 'An enum value of another type can never be valid, so clients reject it.' },
  { id: 'duplicated-entry-in-enum', severity: 'warning', families: ALL, title: 'enum values are unique', why: 'A value listed twice in an enum is a typo or a leftover.' },
  { id: 'oas3-valid-schema-example', severity: 'warning', families: V3, title: 'Schema examples match the type', why: 'An example of the wrong type shows readers and mock servers data the API never sends.' },
  { id: 'oas2-valid-schema-example', severity: 'warning', families: ['2.0'], title: 'Schema examples match the type', why: 'An example of the wrong type shows readers data the API never sends.' },
  { id: 'tag-description', severity: 'hint', families: ALL, title: 'Tags have a description', why: 'The tag description is shown above its group of operations.' },
  { id: 'openapi-tags', severity: 'hint', families: ALL, title: 'The document has a global tags list', why: 'A top-level tags list sets the order and the descriptions of the groups in the docs.' },
  { id: 'no-eval-in-markdown', severity: 'warning', families: ALL, title: 'No eval( in descriptions', why: 'Descriptions are shown as Markdown, and code that calls eval( is a common injection pattern.' },
  { id: 'no-script-tags-in-markdown', severity: 'warning', families: ALL, title: 'No <script> tags in descriptions', why: 'Descriptions are shown as Markdown, and a script tag there runs in some doc viewers.' },
  { id: 'oas3_1-type-array-null', severity: 'warning', families: ['3.1'], title: 'Use type: [x, "null"] instead of nullable', why: 'OpenAPI 3.1 dropped nullable; tools that follow 3.1 ignore it.' },
  { id: 'oas3_1-webhooks-valid', severity: 'error', families: V3, title: 'webhooks are path items in an OpenAPI 3.1 file', why: 'webhooks exist only in OpenAPI 3.1, and each webhook is a path item with operations.' },
];
const BY_ID = new Map(RULES.map(r => [r.id, r]));
// Spectral names that mean one of ours.
const ALIASES = { 'oas3-schema': 'oas-schema', 'oas2-schema': 'oas-schema', 'oas3-unused-components': 'oas3-unused-component', 'oas3-valid-media-example': 'oas3-valid-schema-example', 'oas2-valid-media-example': 'oas2-valid-schema-example' };

const SEVERITIES = ['error', 'warning', 'info', 'hint'];

/** Spectral severity value -> 'error' | 'warning' | 'info' | 'hint' | 'off' | 'on' (default severity) | null (not understood). */
function normSeverity(v) {
  if (v === true) return 'on';
  if (v === false) return 'off';
  if (typeof v === 'number') return v === -1 ? 'off' : SEVERITIES[v] || null;
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 'warn' || s === 'warning') return 'warning';
  if (s === 'error' || s === 'info' || s === 'hint' || s === 'off') return s;
  if (s === 'information') return 'info';
  return null;
}

/**
 * Read a Spectral ruleset (.spectral.yaml / .yml / .json).
 * Returns { rules: { id: 'off'|'error'|'warning'|'info'|'hint' }, extendsOas, extendsMode: 'recommended'|'all'|'off'|'none', errors: [] }.
 */
function parseRuleset(text, fileName = '.spectral.yaml') {
  const out = { rules: {}, extendsOas: false, extendsMode: 'none', errors: [] };
  let data;
  try {
    if (/\.json$/i.test(fileName)) data = JSON.parse(text);
    else {
      const doc = YAML.parseDocument(String(text), { maxAliasCount: 50, prettyErrors: false });
      if (doc.errors && doc.errors.length) throw new Error(String(doc.errors[0].message).split('\n')[0]);
      data = doc.toJS({ maxAliasCount: 50 });
    }
  } catch (e) {
    out.errors.push(`${fileName} could not be read: ${String(e && e.message || e).slice(0, 200)}. The default rules are used.`);
    out.extendsOas = true; out.extendsMode = 'recommended';
    return out;
  }
  if (data == null) { out.extendsMode = 'none'; return out; }
  if (typeof data !== 'object' || Array.isArray(data)) { out.errors.push(`${fileName} is not a map of settings. The default rules are used.`); out.extendsOas = true; out.extendsMode = 'recommended'; return out; }
  const ext = data.extends === undefined ? [] : Array.isArray(data.extends) ? data.extends : [data.extends];
  for (const e of ext) {
    const name = Array.isArray(e) ? e[0] : e;
    const mode = Array.isArray(e) ? String(e[1] || 'recommended').toLowerCase() : 'recommended';
    if (name === 'spectral:oas') {
      out.extendsOas = true;
      out.extendsMode = mode === 'all' ? 'all' : mode === 'off' ? 'off' : 'recommended';
    } else out.errors.push(`extends "${String(name).slice(0, 120)}" is not supported here, so it is ignored. Only spectral:oas is built in.`);
  }
  for (const k of ['functions', 'functionsDir', 'overrides', 'aliases', 'parserOptions']) if (data[k] !== undefined) out.errors.push(`"${k}" in ${fileName} needs Spectral itself, so it is ignored.`);
  const rules = data.rules && typeof data.rules === 'object' && !Array.isArray(data.rules) ? data.rules : {};
  for (const raw of Object.keys(rules)) {
    const id = ALIASES[raw] || raw;
    const v = rules[raw];
    const isObj = v && typeof v === 'object' && !Array.isArray(v);
    const known = BY_ID.get(id);
    if (!known) {
      if (isObj && (v.given !== undefined || v.then !== undefined)) out.errors.push(`Custom rule "${raw}" needs Spectral functions, so it is skipped.`);
      else out.errors.push(`Rule "${raw}" is not one of the rules this extension runs, so it is skipped.`);
      continue;
    }
    let sev = isObj ? (v.severity !== undefined ? normSeverity(v.severity) : (v.recommended === false ? 'off' : 'on')) : normSeverity(v);
    if (sev === null) { out.errors.push(`Rule "${raw}" has a severity this extension does not understand (${JSON.stringify(isObj ? v.severity : v).slice(0, 60)}), so it keeps its default.`); continue; }
    if (sev === 'on') sev = known.severity;
    out.rules[id] = sev;
  }
  return out;
}

/** Map rule id -> severity for the rules that run with this ruleset and spec family. */
function effectiveRules(family, ruleset) {
  const out = new Map();
  const mode = !ruleset ? 'recommended' : (ruleset.extendsMode || (ruleset.extendsOas ? 'recommended' : 'none'));
  for (const r of RULES) {
    if (!r.families.includes(family)) continue;
    let s = null;
    if (mode === 'all') s = r.severity;
    else if (mode === 'recommended') s = r.recommended === false ? null : r.severity;
    if (ruleset && ruleset.rules && Object.prototype.hasOwnProperty.call(ruleset.rules, r.id)) {
      const o = ruleset.rules[r.id];
      s = o === 'off' ? null : o === 'on' ? r.severity : o;
    }
    if (s) out.set(r.id, s);
  }
  return out;
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const DATA_KEYS = new Set(['example', 'x-example', 'default', 'enum', 'const']);
const URL_SAFE = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]*$/;
const COMPONENT_KINDS = ['schemas', 'responses', 'parameters', 'examples', 'requestBodies', 'headers', 'links', 'callbacks', 'pathItems'];
const KIND_LABEL = { schemas: 'Schema', responses: 'Response', parameters: 'Parameter', examples: 'Example', requestBodies: 'Request body', headers: 'Header', links: 'Link', callbacks: 'Callback', pathItems: 'Path item', definitions: 'Definition' };
const WEBHOOK_KEYS = new Set(['$ref', 'summary', 'description', 'servers', 'parameters', ...METHODS]);

function typeOfValue(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v; // string, boolean, object
}
function matchesType(v, types, nullable) {
  const t = typeOfValue(v);
  if (t === 'null') return nullable || types.includes('null');
  if (types.includes(t)) return true;
  if (t === 'integer' && types.includes('number')) return true;
  return false;
}
function typesOf(s) {
  if (typeof s.type === 'string') return [s.type];
  if (Array.isArray(s.type) && s.type.every(x => typeof x === 'string')) return s.type;
  return null;
}
const show = v => { let s; try { s = JSON.stringify(v); } catch { s = String(v); } return s && s.length > 40 ? s.slice(0, 37) + '...' : s; };

function levenshtein(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function closest(name, names) {
  let best = null, bd = Infinity;
  const limit = Math.max(2, Math.floor(name.length / 3));
  for (const c of names) {
    if (Math.abs(c.length - name.length) > limit) continue;
    const d = levenshtein(name, c);
    if (d < bd) { bd = d; best = c; }
  }
  return bd <= limit ? best : null;
}

/** camelCase id from method and path: get /pets/{petId}/toys -> getPetsByPetIdToys */
function suggestOperationId(method, apiPath, taken) {
  const words = [String(method).toLowerCase()];
  for (const seg of String(apiPath).split('/')) {
    if (!seg) continue;
    const m = /^\{(.+)\}$/.exec(seg);
    const parts = (m ? m[1] : seg).split(/[^A-Za-z0-9]+/).filter(Boolean);
    if (!parts.length) continue;
    if (m) words.push('By');
    for (const p of parts) words.push(p[0].toUpperCase() + p.slice(1));
  }
  const base = words.join('') || 'operation';
  let id = base, n = 2;
  while (taken && taken.has(id)) id = base + n++;
  if (taken) taken.add(id);
  return id;
}

/**
 * lint(spec, family, { ruleset, maxIssues }) -> [{ severity, message, path, rule, data }]
 * family: '2.0' | '3.0' | '3.1' | '3.2' (3.2 is linted as 3.1). Unknown families get no lint issues.
 */
function lint(spec, family0, opts = {}) {
  const issues = [];
  if (!isObj(spec)) return issues;
  const family = family0 === '3.2' ? '3.1' : family0;
  if (!ALL.includes(family)) return issues;
  const maxIssues = opts.maxIssues || 2000;
  const on = effectiveRules(family, opts.ruleset || null);
  const add = (rule, message, path, data) => {
    if (!on.has(rule) || issues.length >= maxIssues) return;
    issues.push({ severity: on.get(rule), message: `${message} (${rule})`, path: path.slice(), rule, data: data || {} });
  };
  const v3 = family !== '2.0';

  // ---- info, servers, tags ----
  if (isObj(spec.info)) {
    if (!isObj(spec.info.contact)) add('info-contact', 'info has no contact.', ['info'], { kind: 'info', key: 'contact' });
    if (typeof spec.info.description !== 'string' || !spec.info.description.trim()) add('info-description', 'info has no description.', ['info'], { kind: 'info', key: 'description', present: has(spec.info, 'description') });
    if (!isObj(spec.info.license)) add('info-license', 'info has no license.', ['info'], { kind: 'info', key: 'license' });
  }
  if (v3) {
    if (!Array.isArray(spec.servers) || !spec.servers.length) add('oas3-api-servers', 'The document lists no servers.', spec.servers === undefined ? [] : ['servers'], {});
    else spec.servers.forEach((s, i) => {
      if (isObj(s) && typeof s.url === 'string' && s.url.length > 1 && s.url.endsWith('/')) add('oas3-server-trailing-slash', `Server URL "${s.url}" ends with a slash.`, ['servers', String(i), 'url'], { url: s.url });
    });
  } else if (typeof spec.host !== 'string' || !spec.host) add('oas2-api-host', 'host is not set.', [], {});
  const globalTags = Array.isArray(spec.tags) ? new Set(spec.tags.filter(isObj).map(t => t.name)) : null;
  if (!Array.isArray(spec.tags) || !spec.tags.length) add('openapi-tags', 'The document has no top-level tags list.', spec.tags === undefined ? [] : ['tags'], {});
  else spec.tags.forEach((t, i) => { if (isObj(t) && (typeof t.description !== 'string' || !t.description.trim())) add('tag-description', `Tag "${t.name}" has no description.`, ['tags', String(i)], { name: t.name }); });

  // ---- operations (paths and webhooks) ----
  const methods = family0 === '3.2' ? METHODS.concat(['query']) : METHODS;
  const ops = [];
  const collect = (container, base) => {
    if (!isObj(container)) return;
    for (const route of Object.keys(container)) {
      const item0 = container[route];
      const item = isObj(item0) && typeof item0.$ref === 'string' ? (deref(spec, item0.$ref) || item0) : item0;
      if (!isObj(item)) continue;
      for (const m of methods) if (isObj(item[m])) ops.push({ base, route, item, method: m, op: item[m] });
    }
  };
  collect(spec.paths, 'paths');
  if (family === '3.1') collect(spec.webhooks, 'webhooks');
  const taken = new Set();
  for (const o of ops) if (typeof o.op.operationId === 'string') taken.add(o.op.operationId);

  if (family === '3.0' && spec.webhooks !== undefined) add('oas3_1-webhooks-valid', 'webhooks is new in OpenAPI 3.1, so 3.0 tools ignore it. Use callbacks, or set openapi to 3.1.0.', ['webhooks'], {});
  if (family === '3.1' && spec.webhooks !== undefined) {
    if (!isObj(spec.webhooks)) add('oas3_1-webhooks-valid', 'webhooks must be a map of webhook names to path items.', ['webhooks'], {});
    else for (const name of Object.keys(spec.webhooks)) {
      const item = spec.webhooks[name];
      if (!isObj(item)) { add('oas3_1-webhooks-valid', `Webhook "${name}" must be a path item (a map with post, get and so on).`, ['webhooks', name], { name }); continue; }
      for (const k of Object.keys(item)) if (!WEBHOOK_KEYS.has(k) && !k.startsWith('x-')) add('oas3_1-webhooks-valid', `Webhook "${name}" has the key "${k}", which a path item does not have.`, ['webhooks', name, k], { name, key: k });
    }
  }

  const declared = (list) => {
    const out = [];
    if (!Array.isArray(list)) return out;
    list.forEach((p0, i) => {
      const p = isObj(p0) && typeof p0.$ref === 'string' ? deref(spec, p0.$ref) : p0;
      if (isObj(p) && !p['x-unresolved-ref']) out.push({ p, i });
    });
    return out;
  };
  const dupParams = (list, path) => {
    const seen = new Set();
    for (const { p, i } of declared(list)) {
      const k = p.in + ':' + p.name;
      if (seen.has(k)) add('operation-parameters', `Parameter "${p.name}" in ${p.in} is listed twice.`, [...path, String(i)], { name: p.name, in: p.in });
      seen.add(k);
    }
  };

  if (isObj(spec.paths)) {
    for (const route of Object.keys(spec.paths)) {
      if (route.startsWith('x-')) continue;
      if (route.length > 1 && route.endsWith('/')) add('path-keys-no-trailing-slash', `Path "${route}" ends with a slash.`, ['paths', route], { apiPath: route });
      if (route.includes('?')) add('path-not-include-query', `Path "${route}" includes a query string.`, ['paths', route], { apiPath: route });
      const item0 = spec.paths[route];
      const item = isObj(item0) && typeof item0.$ref === 'string' ? (deref(spec, item0.$ref) || item0) : item0;
      if (!isObj(item)) continue;
      dupParams(item.parameters, ['paths', route, 'parameters']);
      const names = [...route.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
      const dupNames = names.filter((n, i) => names.indexOf(n) !== i);
      for (const n of new Set(dupNames)) add('path-params', `Path "${route}" uses "{${n}}" more than once.`, ['paths', route], { name: n });
      const shared = declared(item.parameters).map(x => x.p);
      for (const m of methods) {
        const op = item[m];
        if (!isObj(op)) continue;
        const own = declared(op.parameters).map(x => x.p);
        const byName = new Map();
        for (const p of [...shared, ...own]) if (p.in === 'path') byName.set(p.name, p);
        const M = m.toUpperCase();
        for (const n of new Set(names)) if (!byName.has(n)) add('path-params', `${M} ${route}: path parameter "{${n}}" is not declared in parameters.`, ['paths', route, m], { method: m, apiPath: route, name: n, missing: true });
        for (const n of byName.keys()) if (!names.includes(n)) add('path-params', `${M} ${route}: parameter "${n}" is in: path but not in the path.`, ['paths', route, m], { method: m, apiPath: route, name: n, extra: true });
      }
    }
  }

  const seenIds = new Map();
  for (const { base, route, method, op } of ops) {
    const p = [base, route, method];
    const M = method.toUpperCase();
    const label = base === 'webhooks' ? `Webhook ${route} (${M})` : `${M} ${route}`;
    const id = op.operationId;
    if (id === undefined || id === '') {
      add('operation-operationId', `${label} has no operationId.`, p, { method, apiPath: route, where: base, suggestedId: suggestOperationId(method, base === 'webhooks' ? '/' + route : route, taken) });
    } else if (typeof id === 'string') {
      if (seenIds.has(id)) add('operation-operationId-unique', `operationId "${id}" is used twice (also ${seenIds.get(id)}).`, [...p, 'operationId'], { operationId: id, method, apiPath: route });
      else seenIds.set(id, label);
      if (!URL_SAFE.test(id)) add('operation-operationId-valid-in-url', `operationId "${id}" has characters that are not safe in a URL, such as spaces.`, [...p, 'operationId'], { operationId: id });
    }
    if (typeof op.description !== 'string' || !op.description.trim()) add('operation-description', `${label} has no description.`, p, { method, apiPath: route, kind: 'operation', key: 'description', present: has(op, 'description') });
    if (typeof op.summary !== 'string' || !op.summary.trim()) add('operation-summary', `${label} has no summary.`, p, { method, apiPath: route, kind: 'operation', key: 'summary', present: has(op, 'summary') });
    if (!Array.isArray(op.tags) || !op.tags.length) add('operation-tags', `${label} has no tags.`, p, { method, apiPath: route });
    else if (globalTags) op.tags.forEach((t, i) => { if (!globalTags.has(t)) add('operation-tag-defined', `${label}: tag "${t}" is not in the top-level tags list.`, [...p, 'tags', String(i)], { tag: t }); });
    if (isObj(op.responses)) {
      if (!Object.keys(op.responses).some(c => /^[23](\d\d|XX)$/i.test(c))) add('operation-success-response', `${label} has no 2xx or 3xx response.`, [...p, 'responses'], { method, apiPath: route });
    } else if (op.responses === undefined && family === '3.1') add('operation-success-response', `${label} has no responses.`, p, { method, apiPath: route });
    dupParams(op.parameters, [...p, 'parameters']);
    if (family === '2.0') {
      const all = declared(op.parameters).map(x => x.p);
      if (all.some(x => x.in === 'body') && all.some(x => x.in === 'formData')) add('operation-parameters', `${label} has both a body parameter and formData parameters. Use one or the other.`, [...p, 'parameters'], {});
    }
  }

  // ---- one walk over the whole tree: $refs, enums, examples, markdown, nullable ----
  const refs = [];
  const discNames = new Set();
  const path = [];
  const seen = new Set();
  const checkSchemaLike = (v) => {
    const types = typesOf(v);
    const nullable = v.nullable === true;
    if (Array.isArray(v.enum)) {
      const keys = new Set();
      let dupReported = false;
      v.enum.forEach((e, i) => {
        if (types && !matchesType(e, types, nullable)) add('typed-enum', `enum value ${show(e)} is not of type ${types.join(' or ')}.`, [...path, 'enum', String(i)], { value: e });
        if (!dupReported && (e === null || typeof e !== 'object')) {
          const k = typeof e + ':' + String(e);
          if (keys.has(k)) { dupReported = true; add('duplicated-entry-in-enum', `enum lists ${show(e)} more than once.`, [...path, 'enum', String(i)], { value: e }); }
          keys.add(k);
        }
      });
    }
    if (types) {
      const rule = family === '2.0' ? 'oas2-valid-schema-example' : 'oas3-valid-schema-example';
      if (v.example !== undefined && !matchesType(v.example, types, nullable)) add(rule, `example ${show(v.example)} is not of type ${types.join(' or ')}.`, [...path, 'example'], {});
      if (family === '3.1' && Array.isArray(v.examples)) v.examples.slice(0, 20).forEach((ex, i) => { if (!matchesType(ex, types, nullable)) add(rule, `examples item ${show(ex)} is not of type ${types.join(' or ')}.`, [...path, 'examples', String(i)], {}); });
    }
    if (family === '3.1' && typeof v.nullable === 'boolean') {
      const t = typeof v.type === 'string' ? v.type : null;
      add('oas3_1-type-array-null', t ? `nullable is not in OpenAPI 3.1. Use type: [${t}, "null"].` : 'nullable is not in OpenAPI 3.1. Add "null" to the type list.', [...path, 'nullable'], { type: t });
    }
    if (isObj(v.discriminator) && isObj(v.discriminator.mapping)) for (const x of Object.values(v.discriminator.mapping)) if (typeof x === 'string') { if (x.startsWith('#')) refs.push({ ref: x, path: null }); else discNames.add(x); }
  };
  const walk = (v, depth) => {
    if (depth > 300) return;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) { const c = v[i]; if (c !== null && typeof c === 'object') { path.push(String(i)); walk(c, depth + 1); path.pop(); } }
      return;
    }
    if (seen.has(v)) return;
    seen.add(v);
    const parent = path[path.length - 1];
    if (typeof v.$ref === 'string') {
      refs.push({ ref: v.$ref, path: [...path, '$ref'] });
      if (family !== '3.1' && !(path.length === 2 && path[0] === 'paths')) {
        const sib = Object.keys(v).filter(k => k !== '$ref');
        if (sib.length) add('no-$ref-siblings', `Keys next to $ref are ignored: ${sib.slice(0, 4).join(', ')}.`, [...path, sib[0]], { keys: sib });
      }
    }
    if (parent !== 'properties' && parent !== 'patternProperties' && parent !== 'examples') checkSchemaLike(v);
    for (const k of Object.keys(v)) {
      const c = v[k];
      if (typeof c === 'string') {
        if ((k === 'description' || k === 'title') && c.length > 4) {
          if (/<script/i.test(c)) add('no-script-tags-in-markdown', `${k} has a <script> tag.`, [...path, k], {});
          if (/\beval\s*\(/.test(c)) add('no-eval-in-markdown', `${k} has eval(.`, [...path, k], {});
        }
        continue;
      }
      if (c === null || typeof c !== 'object') continue;
      if (DATA_KEYS.has(k) && parent !== 'responses' && parent !== 'properties' && parent !== 'patternProperties') continue;
      if (k === 'examples' && Array.isArray(c)) continue;
      if (k === 'value' && path[path.length - 2] === 'examples') continue;
      path.push(k);
      walk(c, depth + 1);
      path.pop();
    }
  };
  walk(spec, 0);

  // ---- $ref targets ----
  const used = new Set();
  const missing = new Map();
  const markUsed = p => {
    if (p[0] === 'components' && p.length >= 3) used.add(p[1] + '/' + p[2]);
    else if ((p[0] === 'definitions' || p[0] === 'parameters' || p[0] === 'responses') && p.length >= 2 && family === '2.0') used.add(p[0] + '/' + p[1]);
  };
  const schemasPath = family === '2.0' ? ['definitions'] : ['components', 'schemas'];
  for (const { ref, path: rp } of refs) {
    if (!ref.startsWith('#')) continue;
    const p = pointerToPath(ref.slice(1));
    if (p) markUsed(p);
    if (!rp) continue;
    if (p === null || getPath(spec, p) === undefined) {
      const n = (missing.get(ref) || 0) + 1;
      missing.set(ref, n);
      if (n > 5) continue;
      let suggest = null;
      if (p && p.length) {
        const name = p[p.length - 1];
        const parentVal = getPath(spec, p.slice(0, -1));
        let host = isObj(parentVal) ? p.slice(0, -1) : schemasPath;
        let pool = isObj(parentVal) ? parentVal : getPath(spec, schemasPath);
        if (isObj(pool)) { const c = closest(name, Object.keys(pool)); if (c !== null) suggest = '#' + pathToPointer([...host, c]); }
      }
      add('invalid-ref', `$ref "${ref}" points to nothing.${suggest ? ` Did you mean "${suggest}"?` : ''}`, rp, { ref, suggest });
    }
  }
  for (const n of discNames) used.add('schemas/' + n), used.add('definitions/' + n);

  // ---- unused components (not for a file of components only) ----
  const hasOps = (isObj(spec.paths) && Object.keys(spec.paths).length > 0) || (isObj(spec.webhooks) && Object.keys(spec.webhooks).length > 0);
  if (hasOps) {
    if (v3 && isObj(spec.components)) {
      for (const kind of COMPONENT_KINDS) {
        const c = spec.components[kind];
        if (!isObj(c)) continue;
        for (const name of Object.keys(c)) if (!name.startsWith('x-') && !used.has(kind + '/' + name)) add('oas3-unused-component', `${KIND_LABEL[kind]} "${name}" is not used by any $ref.`, ['components', kind, name], { kind, name });
      }
    } else if (!v3) {
      for (const kind of ['definitions', 'parameters', 'responses']) {
        const c = spec[kind];
        if (!isObj(c)) continue;
        for (const name of Object.keys(c)) if (!name.startsWith('x-') && !used.has(kind + '/' + name)) add('oas2-unused-definition', `${kind === 'definitions' ? 'Definition' : KIND_LABEL[kind]} "${name}" is not used by any $ref.`, [kind, name], { kind, name });
      }
    }
  }
  return issues;
}

module.exports = { RULES, ALIASES, lint, parseRuleset, effectiveRules, normSeverity, suggestOperationId, levenshtein, closest };
