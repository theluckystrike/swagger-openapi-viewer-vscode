'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { bundle, resolveRef } = require('../src/core/bundle');
const { build, SAMPLES } = require('./helpers');

test('resolveRef: relative paths resolve, absolute paths and odd schemes are refused', () => {
  const base = 'file:///ws/api/openapi.yaml';
  assert.equal(resolveRef(base, 'schemas/pet.yaml').uri, 'file:///ws/api/schemas/pet.yaml');
  assert.equal(resolveRef(base, '../common.yaml').uri, 'file:///ws/common.yaml');
  assert.equal(resolveRef(base, '').uri, base);
  assert.ok(resolveRef(base, 'https://x.example/a.json').remote);
  for (const bad of ['/etc/passwd', 'file:///etc/hosts', 'C:\\Windows\\win.ini', 'javascript:alert(1)', 'data:application/json,{}', 'ftp://x/y']) assert.ok(resolveRef(base, bad).error, bad);
});

test('split spec: files inlined once, schemas get names, the cycle across files stays a cycle', async () => {
  const r = await build(path.join(SAMPLES, 'split/openapi.yaml'));
  assert.equal(r.ok, true);
  const s = r.spec.components.schemas;
  assert.deepEqual(Object.keys(s).sort(), ['Category', 'Error', 'Pet', 'Tag']);
  assert.equal(s.Category.properties.parent.$ref, '#/components/schemas/Category');
  assert.equal(s.Pet.properties.tags.items.$ref, '#/components/schemas/Tag');
  assert.equal(r.spec.paths['/pets'].get.responses.default.content['application/json'].schema.$ref, '#/components/schemas/Error');
  assert.equal(r.spec.paths['/pets/{petId}'].parameters[0].name, 'petId');
  assert.equal(r.unresolved.length, 1);
  assert.match(r.unresolved[0].reason, /file not found: split\/schemas\/owner\.yaml/);
  const owner = r.spec.paths['/owners/{ownerId}'].get.responses['200'].content['application/json'].schema;
  assert.equal(owner['x-unresolved-ref'], 'schemas/owner.yaml');
  const issue = r.issues.find(i => /owner\.yaml/.test(i.message));
  assert.equal(issue.line + 1, 28);
});

test('refs outside the workspace and remote refs are not read', async () => {
  const r = await build(path.join(SAMPLES, 'hostile-refs.yaml'));
  assert.equal(r.ok, true);
  const reasons = r.unresolved.map(u => u.ref + ' => ' + u.reason).join('\n');
  assert.match(reasons, /etc\/passwd => outside the workspace/);
  assert.match(reasons, /169\.254\.169\.254.* => remote refs are not loaded/);
  assert.match(reasons, /file:\/\/\/etc\/hosts => absolute file/);
  assert.ok(!JSON.stringify(r.spec).includes('root:'));
  assert.ok(r.issues.some(i => /points to itself/.test(i.message)));
  assert.ok(r.issues.some(i => /DoesNotExist.*points to nothing/.test(i.message)));
});

test('siblings next to $ref are kept, and example data is never treated as a ref', async () => {
  const files = {
    'file:///w/root.yaml': null,
    'file:///w/a.yaml': { type: 'object', description: 'from a' },
  };
  const data = { openapi: '3.1.0', info: { title: 't', version: '1' }, paths: {}, components: { schemas: { A: { $ref: 'a.yaml', description: 'override' }, B: { type: 'object', example: { $ref: 'not-a-ref.yaml' } } } } };
  const r = await bundle({ rootUri: 'file:///w/root.yaml', data, family: '3.1', read: async u => { if (!files[u]) throw new Error('missing'); return { data: files[u] }; } });
  assert.equal(r.unresolved.length, 0);
  assert.equal(r.spec.components.schemas.A.description, 'override');
  assert.equal(r.spec.components.schemas.A.type, 'object');
  assert.deepEqual(r.spec.components.schemas.B.example, { $ref: 'not-a-ref.yaml' });
});

test('a chain of files that loops back is reported, not followed forever', async () => {
  const files = { 'file:///w/a.yaml': { $ref: 'b.yaml' }, 'file:///w/b.yaml': { $ref: 'a.yaml' } };
  const data = { openapi: '3.0.0', info: { title: 't', version: '1' }, paths: { '/x': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: 'a.yaml' } } } } } } } } };
  const r = await bundle({ rootUri: 'file:///w/root.yaml', data, family: '3.0', read: async u => ({ data: structuredClone(files[u]) }) });
  assert.ok(r.unresolved.some(u => u.code === 'cycle'));
});

test('node budget stops a spec that grows too large', async () => {
  const big = { openapi: '3.0.0', info: { title: 't', version: '1' }, paths: {} };
  for (let i = 0; i < 2000; i++) big.paths['/p' + i] = { get: { responses: { 200: { description: 'ok' } } } };
  await assert.rejects(bundle({ rootUri: 'file:///w/r.yaml', data: big, family: '3.0', read: async () => ({ data: {} }), maxNodes: 1000 }), /more than 1,000 nodes/);
});
