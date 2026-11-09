'use strict';
// Outline, $ref targets and $ref search (src/core/symbols.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { outline, refTargets, componentAt, splitRefValue, findRefs, yamlSkeleton } = require('../src/core/symbols');
const { parseText, versionOf } = require('../src/core/spec');

const S = path.join(__dirname, '..', 'samples');
const read = f => fs.readFileSync(path.join(S, f), 'utf8');
const flat = list => list.map(n => `${n.name}@${n.line}` + (n.children.length ? `[${flat(n.children)}]` : '')).join(', ');

test('outline of Petstore 3.0: info, servers, paths with operations, components, with lines', () => {
  const t = read('petstore-3.0.yaml');
  const p = parseText(t, { path: 'x.yaml' });
  const o = outline(p.data, '3.0', p.locate);
  assert.deepEqual(o.map(n => n.name), ['Info', 'Servers', 'Paths', 'Components']);
  const paths = o.find(n => n.name === 'Paths');
  assert.deepEqual(paths.children.map(n => n.name), ['/pets', '/pets/{petId}']);
  assert.deepEqual(paths.children[0].children.map(n => `${n.name} ${n.detail}`), ['GET List all pets', 'POST Create a pet']);
  assert.equal(paths.children[0].children[0].kind, 'method');
  const lines = t.split('\n');
  assert.equal(lines[paths.children[0].children[1].line].trim(), 'post:');
  const schemas = o.find(n => n.name === 'Components').children[0];
  assert.deepEqual(schemas.children.map(n => n.name), ['Pet', 'Pets', 'Error']);
  assert.ok(schemas.children[0].endLine < schemas.children[1].line);
});

test('outline of Swagger 2.0 JSON has Host and Definitions; 3.1 has Webhooks', () => {
  const t = read('petstore-expanded-2.0.json');
  const p = parseText(t, { path: 'x.json' });
  const o = outline(p.data, '2.0', p.locate);
  assert.ok(o.some(n => n.name === 'Host'));
  assert.deepEqual(o.find(n => n.name === 'Definitions').children.map(n => n.name), ['Pet', 'NewPet', 'Error']);
  const w = parseText(read('webhook-example-3.1.yaml'), { path: 'w.yaml' });
  const ow = outline(w.data, '3.1', w.locate);
  const hooks = ow.find(n => n.name === 'Webhooks');
  assert.equal(hooks.children[0].name, 'newPet');
  assert.equal(hooks.children[0].kind, 'event');
  assert.equal(hooks.children[0].children[0].name, 'POST');
});

test('the YAML key scan gives the same outline as a full parse', () => {
  for (const f of ['petstore-3.0.yaml', 'museum-3.1.yaml', 'uspto-3.0.yaml', 'link-example-3.0.yaml', 'callback-example-3.0.yaml', 'webhook-example-3.1.yaml', 'petstore-swagger-2.0.yaml']) {
    const t = read(f);
    const p = parseText(t, { path: f });
    const fam = versionOf(p.data).family;
    const sk = yamlSkeleton(t);
    assert.equal(flat(outline(sk.data, fam, sk.locate)), flat(outline(p.data, fam, p.locate)), f);
  }
});

test('a key named __proto__ stays a key in the key scan', () => {
  const sk = yamlSkeleton('openapi: 3.0.0\ncomponents:\n  schemas:\n    __proto__:\n      type: object\n');
  assert.ok(Object.keys(sk.data.components.schemas).includes('__proto__'));
  assert.equal(({}).type, undefined);
});

test('refTargets lists components (3.x) and definitions, parameters, responses (2.0)', () => {
  const p = parseText(read('petstore-3.0.yaml'), { path: 'x.yaml' });
  assert.deepEqual(refTargets(p.data, '3.0').map(r => r.ref), ['#/components/schemas/Pet', '#/components/schemas/Pets', '#/components/schemas/Error']);
  const q = JSON.parse(read('petstore-expanded-2.0.json'));
  assert.deepEqual(refTargets(q, '2.0').map(r => r.ref), ['#/definitions/Pet', '#/definitions/NewPet', '#/definitions/Error']);
  assert.deepEqual(refTargets({ components: { schemas: { 'a/b': {} } } }, '3.1')[0].ref, '#/components/schemas/a~1b');
});

test('findRefs finds quoted and plain $ref values with exact columns', () => {
  const y = "a:\n  $ref: '#/components/schemas/Pet'\nb:\n  - $ref: schemas/pet.yaml # comment\nc: {$ref: \"x.yaml#/components/schemas/Pet\", d: 1}\n";
  const r = findRefs(y, false);
  assert.deepEqual(r.map(x => x.value), ['#/components/schemas/Pet', 'schemas/pet.yaml', 'x.yaml#/components/schemas/Pet']);
  for (const x of r) assert.equal(y.split('\n')[x.line].slice(x.col, x.col + x.length), x.value);
  assert.equal(findRefs(y, false, '#/components/schemas/Pet').length, 1);
  assert.equal(findRefs(y, false, v => v.endsWith('/Pet')).length, 2);
  const j = '{"$ref": "#/definitions/A\\u0042"}';
  assert.deepEqual(findRefs(j, true).map(x => x.value), ['#/definitions/AB']);
});

test('componentAt and splitRefValue', () => {
  assert.deepEqual(componentAt(['components', 'schemas', 'Pet'], '3.0'), { kindPath: ['components', 'schemas'], name: 'Pet' });
  assert.deepEqual(componentAt(['definitions', 'Pet'], '2.0'), { kindPath: ['definitions'], name: 'Pet' });
  assert.equal(componentAt(['components', 'schemas', 'Pet', 'properties'], '3.0'), null);
  assert.equal(componentAt(['definitions', 'Pet'], '3.0'), null);
  assert.deepEqual(splitRefValue('a.yaml#/components/schemas/P~1q'), { file: 'a.yaml', fragment: '/components/schemas/P~1q', pointer: ['components', 'schemas', 'P/q'] });
  assert.deepEqual(splitRefValue('a.yaml').pointer, []);
});
