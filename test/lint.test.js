'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { lint, parseRuleset, RULES, effectiveRules, suggestOperationId } = require('../src/core/lint');
const { build, SAMPLES } = require('./helpers');

const base = (extra = {}) => ({
  openapi: '3.0.3',
  info: { title: 'T', version: '1', description: 'An API.', contact: { name: 'x' }, license: { name: 'MIT' } },
  servers: [{ url: 'https://api.example.com' }],
  tags: [{ name: 'pets', description: 'Pets.' }],
  paths: {
    '/pets/{id}': {
      get: { operationId: 'getPet', summary: 'Get', description: 'Get a pet.', tags: ['pets'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } } },
    },
  },
  components: { schemas: { Pet: { type: 'object', properties: { name: { type: 'string', example: 'Rex' } } } } },
  ...extra,
});
const rules = (spec, fam = '3.0', opts) => lint(spec, fam, opts).map(i => i.rule);
const clone = o => JSON.parse(JSON.stringify(o));

test('a clean 3.0 spec has no lint issues', () => {
  assert.deepEqual(lint(base(), '3.0'), []);
});

test('every rule has an id, a severity, a title, a plain why and families', () => {
  const ids = new Set();
  for (const r of RULES) {
    assert.ok(!ids.has(r.id), r.id); ids.add(r.id);
    assert.ok(['error', 'warning', 'info', 'hint'].includes(r.severity), r.id);
    assert.ok(r.title && r.why && r.why.endsWith('.'), r.id);
    assert.ok(!/\u2014/.test(r.why + r.title), r.id);
    assert.ok(r.families.length, r.id);
  }
});

test('operation rules: operationId, description, summary, tags, success response', () => {
  const s = clone(base());
  const op = s.paths['/pets/{id}'].get;
  delete op.operationId; delete op.description; delete op.tags; op.responses = { 404: { description: 'no' } };
  const r = lint(s, '3.0');
  const ids = r.map(i => i.rule);
  for (const id of ['operation-operationId', 'operation-description', 'operation-tags', 'operation-success-response']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('operation-summary'), 'summary is off by default');
  const opId = r.find(i => i.rule === 'operation-operationId');
  assert.deepEqual(opId.path, ['paths', '/pets/{id}', 'get']);
  assert.equal(opId.data.suggestedId, 'getPetsById');
  assert.match(opId.message, /GET \/pets\/\{id\} has no operationId\. \(operation-operationId\)$/);
  op.tags = ['dogs'];
  assert.ok(rules(s).includes('operation-tag-defined'));
  delete s.tags;
  assert.ok(!rules(s).includes('operation-tag-defined'), 'no global list: no tag-defined noise');
  assert.ok(rules(s).includes('openapi-tags'), 'openapi-tags is a hint and runs');
});

test('openapi-tags and tag-description are hints', () => {
  const s = clone(base()); delete s.tags;
  const i = lint(s, '3.0').find(x => x.rule === 'openapi-tags');
  assert.equal(i.severity, 'hint');
  const t = clone(base()); t.tags = [{ name: 'pets' }];
  assert.equal(lint(t, '3.0').find(x => x.rule === 'tag-description').severity, 'hint');
});

test('operationId unique and valid in URL', () => {
  const s = clone(base());
  s.paths['/pets'] = { post: { ...clone(s.paths['/pets/{id}'].get), parameters: [] } };
  s.paths['/pets'].post.operationId = 'getPet';
  assert.ok(rules(s).includes('operation-operationId-unique'));
  s.paths['/pets'].post.operationId = 'add pet';
  assert.ok(rules(s).includes('operation-operationId-valid-in-url'));
});

test('suggested operationIds are unique', () => {
  const taken = new Set(['getPets']);
  assert.equal(suggestOperationId('get', '/pets', taken), 'getPets2');
  assert.equal(suggestOperationId('post', '/pets/{pet-id}/toys', taken), 'postPetsByPetIdToys');
});

test('path rules: params, trailing slash, query string, duplicate params', () => {
  const s = clone(base());
  s.paths['/pets/{id}'].get.parameters.push({ name: 'id', in: 'path', required: true, schema: { type: 'string' } });
  s.paths['/a/'] = { get: { operationId: 'a', description: 'd', tags: ['pets'], responses: { 200: { description: 'ok' } } } };
  s.paths['/b?x=1'] = { get: { operationId: 'b', description: 'd', tags: ['pets'], responses: { 200: { description: 'ok' } } } };
  s.paths['/c/{x}'] = { get: { operationId: 'c', description: 'd', tags: ['pets'], responses: { 200: { description: 'ok' } } } };
  const r = rules(s);
  for (const id of ['operation-parameters', 'path-keys-no-trailing-slash', 'path-not-include-query', 'path-params']) assert.ok(r.includes(id), id);
});

test('info, servers and host rules', () => {
  const s = clone(base()); delete s.info.contact; s.info.description = ' '; delete s.info.license; s.servers = [{ url: 'https://x.example.com/' }];
  const r = lint(s, '3.0');
  assert.ok(r.some(i => i.rule === 'info-contact'));
  assert.ok(r.some(i => i.rule === 'info-description' && i.data.present === true));
  assert.equal(r.find(i => i.rule === 'info-license').severity, 'hint');
  assert.ok(r.some(i => i.rule === 'oas3-server-trailing-slash'));
  delete s.servers;
  assert.ok(rules(s).includes('oas3-api-servers'));
  const two = { swagger: '2.0', info: base().info, paths: {} };
  assert.ok(rules(two, '2.0').includes('oas2-api-host'));
});

test('unused components and definitions, but not in a file of components only', () => {
  const s = clone(base()); s.components.schemas.Old = { type: 'string' }; s.components.responses = { NotFound: { description: 'x' } };
  const r = lint(s, '3.0').filter(i => i.rule === 'oas3-unused-component');
  assert.deepEqual(r.map(i => i.data.name).sort(), ['NotFound', 'Old']);
  assert.deepEqual(r.find(i => i.data.name === 'Old').path, ['components', 'schemas', 'Old']);
  const lib = { openapi: '3.1.0', info: base().info, components: { schemas: { A: { type: 'string' } } } };
  assert.ok(!rules(lib, '3.1').includes('oas3-unused-component'));
  // a discriminator mapping counts as a use
  const d = clone(base()); d.components.schemas.Cat = { type: 'object' };
  d.components.schemas.Pet.discriminator = { propertyName: 'kind', mapping: { cat: '#/components/schemas/Cat' } };
  assert.ok(!rules(d).includes('oas3-unused-component'));
  const two = { swagger: '2.0', host: 'x', info: base().info, paths: { '/a': { get: { operationId: 'a', description: 'd', tags: ['t'], responses: { 200: { description: 'ok', schema: { $ref: '#/definitions/A' } } } } } }, definitions: { A: { type: 'string' }, B: { type: 'string' } } };
  const u = lint(two, '2.0').filter(i => i.rule === 'oas2-unused-definition');
  assert.deepEqual(u.map(i => i.path), [['definitions', 'B']]);
});

test('invalid-ref suggests the closest name', () => {
  const s = clone(base());
  s.paths['/pets/{id}'].get.responses[200].content['application/json'].schema.$ref = '#/components/schemas/Pets';
  const i = lint(s, '3.0').find(x => x.rule === 'invalid-ref');
  assert.equal(i.data.suggest, '#/components/schemas/Pet');
  assert.match(i.message, /Did you mean "#\/components\/schemas\/Pet"\?/);
  s.paths['/pets/{id}'].get.responses[200].content['application/json'].schema.$ref = '#/components/schema/Pet';
  assert.equal(lint(s, '3.0').find(x => x.rule === 'invalid-ref').data.suggest, '#/components/schemas/Pet');
});

test('enum and example types', () => {
  const s = clone(base());
  s.components.schemas.Pet.properties.size = { type: 'integer', enum: [1, 'two', 1], example: 'big' };
  s.components.schemas.Pet.properties.n = { type: 'string', nullable: true, enum: ['a', null], example: null };
  const r = lint(s, '3.0');
  assert.equal(r.filter(i => i.rule === 'typed-enum').length, 1);
  assert.equal(r.filter(i => i.rule === 'duplicated-entry-in-enum').length, 1);
  assert.equal(r.filter(i => i.rule === 'oas3-valid-schema-example').length, 1);
  assert.deepEqual(r.find(i => i.rule === 'oas3-valid-schema-example').path, ['components', 'schemas', 'Pet', 'properties', 'size', 'example']);
});

test('markdown rules and $ref siblings', () => {
  const s = clone(base());
  s.info.description = 'Hello <script>alert(1)</script>';
  s.paths['/pets/{id}'].get.description = 'Run eval(x) here';
  s.paths['/pets/{id}'].get.responses[200].content['application/json'].schema.description = 'next to a ref';
  const r = rules(s);
  for (const id of ['no-script-tags-in-markdown', 'no-eval-in-markdown', 'no-$ref-siblings']) assert.ok(r.includes(id), id);
  const s31 = { ...clone(s), openapi: '3.1.0' };
  assert.ok(!rules(s31, '3.1').includes('no-$ref-siblings'), '3.1 allows keys next to $ref');
});

test('OpenAPI 3.1: type arrays, webhooks, jsonSchemaDialect and $defs give no false problems', () => {
  const s = {
    openapi: '3.1.0', jsonSchemaDialect: 'https://spec.openapis.org/oas/3.1/dialect/base',
    info: base().info, servers: base().servers, tags: base().tags,
    webhooks: { newPet: { post: { operationId: 'newPet', description: 'd', tags: ['pets'], requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } }, responses: { 200: { description: 'ok' } } } } },
    components: { schemas: { Pet: { type: ['object', 'null'], $defs: { Name: { type: ['string', 'null'], examples: ['Rex', null] } }, properties: { name: { $ref: '#/components/schemas/Pet/$defs/Name' }, size: { type: ['integer', 'null'], enum: [1, 2, null] } } } } },
  };
  assert.deepEqual(lint(s, '3.1'), []);
  s.components.schemas.Pet.properties.old = { type: 'string', nullable: true };
  const i = lint(s, '3.1').find(x => x.rule === 'oas3_1-type-array-null');
  assert.match(i.message, /type: \[string, "null"\]/);
  s.webhooks.bad = { post: { operationId: 'b', description: 'd', tags: ['pets'], responses: { 200: { description: 'ok' } } }, notAMethod: {} };
  assert.ok(rules(s, '3.1').includes('oas3_1-webhooks-valid'));
  delete s.webhooks.bad.post.operationId;
  assert.ok(lint(s, '3.1').some(x => x.rule === 'operation-operationId' && x.path[0] === 'webhooks'));
  const s30 = { ...base(), webhooks: {} };
  assert.ok(rules(s30, '3.0').includes('oas3_1-webhooks-valid'));
});

test('a cyclic object graph (YAML alias loop) does not hang', () => {
  const s = clone(base());
  const a = { type: 'object', properties: {} };
  a.properties.self = a;
  s.components.schemas.Loop = a;
  s.paths['/pets/{id}'].get.responses[201] = { description: 'x', content: { 'application/json': { schema: { $ref: '#/components/schemas/Loop' } } } };
  assert.doesNotThrow(() => lint(s, '3.0'));
});

test('ruleset: severities, aliases, extends modes, custom rules', () => {
  const r = parseRuleset([
    'extends: ["spectral:oas"]',
    'rules:',
    '  operation-description: off',
    '  info-contact: error',
    '  operation-tags: warn',
    '  info-license: 0',
    '  oas3-schema: hint',
    '  operation-summary: true',
    '  my-rule:',
    '    given: $.info',
    '    then: { field: x, function: truthy }',
    '  unknown-thing: warn',
    'functions: [a]',
  ].join('\n'), '.spectral.yaml');
  assert.equal(r.extendsOas, true);
  assert.equal(r.extendsMode, 'recommended');
  assert.deepEqual(r.rules, { 'operation-description': 'off', 'info-contact': 'error', 'operation-tags': 'warning', 'info-license': 'error', 'oas-schema': 'hint', 'operation-summary': 'hint' });
  assert.ok(r.errors.some(e => /Custom rule "my-rule" needs Spectral functions/.test(e)));
  assert.ok(r.errors.some(e => /"unknown-thing" is not one of the rules/.test(e)));
  assert.ok(r.errors.some(e => /"functions"/.test(e)));
  const s = clone(base()); delete s.info.contact; delete s.paths['/pets/{id}'].get.description;
  const out = lint(s, '3.0', { ruleset: r });
  assert.equal(out.find(i => i.rule === 'info-contact').severity, 'error');
  assert.ok(!out.some(i => i.rule === 'operation-description'));
  const all = parseRuleset('extends: [[spectral:oas, all]]');
  assert.equal(all.extendsMode, 'all');
  assert.ok(effectiveRules('3.0', all).has('operation-summary'));
  const none = parseRuleset('rules:\n  info-contact: warn\n');
  assert.deepEqual([...effectiveRules('3.0', none).keys()], ['info-contact']);
  const json = parseRuleset('{"extends":"spectral:oas","rules":{"operation-tags":"off"}}', '.spectral.json');
  assert.equal(json.rules['operation-tags'], 'off');
  const bad = parseRuleset('rules: [', '.spectral.yaml');
  assert.equal(bad.extendsMode, 'recommended');
  assert.ok(bad.errors.length === 1);
});

test('samples: lint gives no errors on valid specs, issues carry rule ids and lines', async () => {
  for (const f of ['petstore-3.0.yaml', 'museum-3.1.yaml', 'webhook-example-3.1.yaml', 'petstore-swagger-2.0.yaml', 'petstore-expanded-2.0.json', 'uspto-3.0.yaml']) {
    const r = await build(path.join(SAMPLES, f));
    assert.equal(r.ok, true, f);
    assert.deepEqual(r.issues.filter(i => i.severity === 'error'), [], f);
    assert.ok(r.issues.every(i => typeof i.rule === 'string' && Number.isInteger(i.line)), f);
    assert.ok(!r.issues.some(i => /oas3_1|webhooks-valid|no-\$ref-siblings|invalid-ref|path-params|typed-enum/.test(i.rule)), f + ' ' + JSON.stringify(r.issues.map(i => i.rule)));
  }
  const split = await build(path.join(SAMPLES, 'split', 'openapi.yaml'));
  assert.ok(split.ok);
  // problems in referenced files point to those files
  const inPets = split.issues.find(i => i.rule === 'operation-description' && i.uri.endsWith('/paths/pets.yaml'));
  assert.ok(inPets, JSON.stringify(split.issues));
  assert.ok(!split.issues.some(i => i.rule === 'oas3-unused-component'), 'hoisted schemas are used');
});

test('job: lint can be turned off, a ruleset turns rules off, overlap with the structure check is reported once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oav-lint-'));
  try {
    const f = path.join(dir, 'a.yaml');
    fs.writeFileSync(f, 'openapi: 3.0.3\ninfo: {title: T, version: "1"}\npaths:\n  /a/{id}:\n    get:\n      operationId: x\n      responses: {"200": {description: ok}}\n  /b:\n    get:\n      operationId: x\n      responses: {"200": {description: ok}}\n');
    const on = await build(f, dir);
    assert.equal(on.issues.filter(i => /used twice/.test(i.message)).length, 1);
    assert.equal(on.issues.filter(i => /"\{id\}" is not declared/.test(i.message)).length, 1);
    assert.ok(on.issues.some(i => i.rule === 'operation-description'));
    const { runJob } = require('../src/core/job');
    const { reader } = require('./helpers');
    const { pathToFileURL } = require('url');
    const text = fs.readFileSync(f, 'utf8');
    const off = await runJob({ rootUri: pathToFileURL(f).toString(), rootText: text, read: reader(dir), lint: false });
    assert.ok(!off.issues.some(i => i.rule === 'operation-description'));
    assert.equal(off.issues.filter(i => /used twice/.test(i.message)).length, 1, 'structure check still reports it');
    const rs = parseRuleset('extends: spectral:oas\nrules:\n  operation-description: off\n  operation-operationId-unique: off\n');
    const custom = await runJob({ rootUri: pathToFileURL(f).toString(), rootText: text, read: reader(dir), ruleset: rs });
    assert.ok(!custom.issues.some(i => i.rule === 'operation-description' || i.rule === 'operation-operationId-unique'));
    assert.ok(custom.issues.some(i => i.rule === 'path-params'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('job anchors: operations, webhooks and schemas with file and line', async () => {
  const r = await build(path.join(SAMPLES, 'museum-3.1.yaml'));
  const text = fs.readFileSync(path.join(SAMPLES, 'museum-3.1.yaml'), 'utf8').split('\n');
  const op = r.anchors.ops['post /tickets'];
  assert.ok(op && /^\s*post:/.test(text[op.line]), JSON.stringify(op));
  const hook = r.anchors.hooks['post newEvent'];
  assert.ok(hook && /^\s*post:/.test(text[hook.line]));
  const names = Object.keys(r.anchors.schemas);
  assert.ok(names.length >= 3);
  for (const n of names) assert.ok(text[r.anchors.schemas[n].line].trim().startsWith(n + ':'), n);
  const split = await build(path.join(SAMPLES, 'split', 'openapi.yaml'));
  const get = split.anchors.ops['get /pets'];
  assert.ok(get.uri.endsWith('/paths/pets.yaml'), get.uri);
  const pet = split.anchors.schemas.Pet || split.anchors.schemas[Object.keys(split.anchors.schemas).find(n => /^Pet/.test(n))];
  assert.ok(pet && pet.uri.endsWith('.yaml'));
  const json = await build(path.join(SAMPLES, 'petstore-expanded-2.0.json'));
  const jt = fs.readFileSync(path.join(SAMPLES, 'petstore-expanded-2.0.json'), 'utf8').split('\n');
  assert.match(jt[json.anchors.ops['delete /pets/{id}'].line], /"delete"/);
});

test('lint on a generated 2,000-operation spec takes well under 2 s', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oav-big-'));
  try {
    const f = path.join(dir, 'big.yaml');
    execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'make_large.js'), f, '1000']);
    const { parseText } = require('../src/core/spec');
    const data = parseText(fs.readFileSync(f, 'utf8'), { path: f }).data;
    const json = JSON.stringify(data);
    const big = JSON.parse(json);
    // 2,000 operations, each with a missing description to make the rule work hard
    const t0 = Date.now();
    const issues = lint(big, '3.0', { maxIssues: 100000 });
    const ms = Date.now() - t0;
    assert.ok(ms < 2000, ms + ' ms');
    assert.ok(issues.filter(i => i.rule === 'operation-description').length === 2000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
