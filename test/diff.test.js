'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { breakingChanges, diffMarkdown } = require('../src/core/diff');
const { parseText } = require('../src/core/spec');
const { swagger2ToOas30 } = require('../src/core/convert');

const S = path.join(__dirname, '..', 'samples');
const load = f => parseText(fs.readFileSync(path.join(S, f), 'utf8'), { path: f }).data;
const copy = v => JSON.parse(JSON.stringify(v));
const kinds = list => list.map(i => i.kind);

test('the same spec has no changes', () => {
  for (const f of ['petstore-3.0.yaml', 'museum-3.1.yaml', 'uspto-3.0.yaml', 'petstore-expanded-2.0.json']) {
    const a = load(f);
    const r = breakingChanges(a, copy(a));
    assert.deepEqual(r.breaking, [], f);
    assert.deepEqual(r.changes, [], f);
  }
});

test('removed operations, paths and responses are breaking', () => {
  const a = load('petstore-3.0.yaml'), b = copy(a);
  delete b.paths['/pets'].post;
  delete b.paths['/pets/{petId}'];
  const r = breakingChanges(a, b);
  assert.ok(r.breaking.some(i => i.kind === 'operation-removed' && i.path === 'POST /pets'));
  assert.ok(r.breaking.some(i => i.path === 'GET /pets/{petId}' && /whole path/.test(i.message)));
  const c = copy(a);
  delete c.paths['/pets'].get.responses['200'];
  assert.ok(kinds(breakingChanges(a, c).breaking).includes('response-removed'));
});

test('a renamed path parameter is not a removed path', () => {
  const a = load('petstore-3.0.yaml'), b = copy(a);
  b.paths['/pets/{id}'] = b.paths['/pets/{petId}'];
  delete b.paths['/pets/{petId}'];
  b.paths['/pets/{id}'].get.parameters[0].name = 'id';
  assert.deepEqual(breakingChanges(a, b).breaking, []);
});

test('parameters: new required, made required, type change, location change, removed', () => {
  const base = { openapi: '3.0.3', info: { title: 'T', version: '1' }, paths: { '/a': { get: { parameters: [
    { name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'n', in: 'query', schema: { type: 'integer' } }, { name: 'h', in: 'header', schema: { type: 'string' } }, { name: 'gone', in: 'query', schema: { type: 'string' } },
  ], responses: { 200: { description: 'ok' } } } } } };
  const b = copy(base);
  const ps = b.paths['/a'].get.parameters;
  ps[0].required = true;
  ps[1].schema.type = 'string';
  ps[2].in = 'query';
  ps.splice(3, 1);
  ps.push({ name: 'must', in: 'query', required: true, schema: { type: 'string' } }, { name: 'opt', in: 'query', schema: { type: 'string' } });
  const r = breakingChanges(base, b);
  const k = kinds(r.breaking);
  assert.ok(k.includes('param-made-required'));
  assert.ok(k.includes('type-changed'));
  assert.ok(k.includes('param-location-changed'));
  assert.ok(k.includes('required-param-added'));
  assert.ok(kinds(r.changes).includes('param-removed'));
  assert.ok(kinds(r.changes).includes('param-added'));
});

test('integer to number is a safe widening for a request', () => {
  const a = { openapi: '3.0.3', info: { title: 'T', version: '1' }, paths: { '/a': { get: { parameters: [{ name: 'n', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'ok' } } } } } };
  const b = copy(a); b.paths['/a'].get.parameters[0].schema.type = 'number';
  assert.deepEqual(breakingChanges(a, b).breaking, []);
  assert.equal(breakingChanges(b, a).breaking.length, 1);
});

test('request body: made required, new required property, enum value removed', () => {
  const a = { openapi: '3.0.3', info: { title: 'T', version: '1' }, paths: { '/a': { post: {
    requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/In' } } } }, responses: { 200: { description: 'ok' } } } } },
    components: { schemas: { In: { type: 'object', required: ['a'], properties: { a: { type: 'string' }, kind: { type: 'string', enum: ['x', 'y'] }, b: { type: 'string' } } } } } };
  const b = copy(a);
  b.paths['/a'].post.requestBody.required = true;
  b.components.schemas.In.required.push('b');
  b.components.schemas.In.properties.kind.enum = ['x'];
  const k = kinds(breakingChanges(a, b).breaking);
  assert.ok(k.includes('body-required'));
  assert.ok(k.includes('required-property-added'));
  assert.ok(k.includes('enum-value-removed'));
});

test('responses: removed property, removed required, new enum value, type change, media type removed', () => {
  const a = { openapi: '3.1.0', info: { title: 'T', version: '1' }, paths: { '/a': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Out' } }, 'text/csv': { schema: { type: 'string' } } } } } } } },
    components: { schemas: { Out: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'integer' }, name: { type: 'string' }, state: { type: 'string', enum: ['on'] }, old: { type: 'string' }, list: { type: 'array', items: { $ref: '#/components/schemas/Out' } } } } } } };
  const b = copy(a);
  const o = b.components.schemas.Out;
  delete o.properties.old;
  o.required = ['id'];
  o.properties.state.enum.push('off');
  o.properties.id.type = 'string';
  delete b.paths['/a'].get.responses['200'].content['text/csv'];
  const r = breakingChanges(a, b);
  const k = kinds(r.breaking);
  assert.ok(k.includes('property-removed'));
  assert.ok(k.includes('required-property-removed'));
  assert.ok(k.includes('type-changed'));
  assert.ok(k.includes('response-media-removed'));
  assert.ok(r.changes.some(i => i.kind === 'enum-value-added' && i.level === 'warning'));
});

test('a recursive schema does not loop', () => {
  const a = { openapi: '3.0.3', info: { title: 'T', version: '1' }, paths: { '/a': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } } } } } },
    components: { schemas: { Node: { type: 'object', properties: { child: { $ref: '#/components/schemas/Node' }, kids: { type: 'array', items: { $ref: '#/components/schemas/Node' } } } } } } };
  const b = copy(a); b.components.schemas.Node.properties.x = { type: 'string' };
  const r = breakingChanges(a, b);
  assert.deepEqual(r.breaking, []);
  assert.ok(r.changes.length >= 1 && r.changes.length < 50);
});

test('servers, security and operationId', () => {
  const a = load('petstore-3.0.yaml'), b = copy(a);
  b.servers = [{ url: 'https://other.example/v9' }];
  b.components.securitySchemes = { key: { type: 'apiKey', name: 'K', in: 'header' } };
  b.security = [{ key: [] }];
  b.paths['/pets'].get.operationId = 'getPets';
  const r = breakingChanges(a, b);
  assert.ok(kinds(r.breaking).includes('server-changed'));
  assert.ok(kinds(r.breaking).includes('security-added'));
  assert.ok(r.changes.some(i => i.kind === 'operationId-changed' && i.level === 'warning'));
});

test('Swagger 2.0 against its 3.0 conversion has no breaking changes', () => {
  const a = load('petstore-expanded-2.0.json');
  const b = swagger2ToOas30(a).spec;
  assert.deepEqual(breakingChanges(a, b).breaking, []);
});

test('Markdown report', () => {
  const a = load('petstore-3.0.yaml'), b = copy(a);
  delete b.paths['/pets'].post;
  const md = diffMarkdown(breakingChanges(a, b), 'main', 'working tree');
  assert.match(md, /^# API changes from main to working tree/);
  assert.match(md, /## Breaking changes \(1\)/);
  assert.match(md, /### POST \/pets/);
  assert.match(md, /`operation-removed`/);
});
