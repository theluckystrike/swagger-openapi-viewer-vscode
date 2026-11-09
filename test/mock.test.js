'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { exampleFor, createMockServer } = require('../src/core/mock');
const { parseText } = require('../src/core/spec');

const S = path.join(__dirname, '..', 'samples');
const load = f => parseText(fs.readFileSync(path.join(S, f), 'utf8'), { path: f }).data;

test('exampleFor: examples, formats, combiners, type lists, cycles', () => {
  const spec = { components: { schemas: {
    Node: { type: 'object', properties: { name: { type: 'string' }, child: { $ref: '#/components/schemas/Node' } } },
    Base: { type: 'object', properties: { id: { type: 'integer', minimum: 5 } } },
  } } };
  assert.equal(exampleFor({ type: 'string', example: 'x' }, spec), 'x');
  assert.equal(exampleFor({ type: 'string', examples: ['y'] }, spec), 'y');
  assert.equal(exampleFor({ type: 'string', enum: [null, 'b'] }, spec), 'b');
  assert.equal(exampleFor({ type: 'string', format: 'date-time' }, spec), '2024-01-15T09:30:00Z');
  assert.equal(exampleFor({ type: 'string', format: 'email' }, spec), 'user@example.com');
  assert.equal(exampleFor({ type: ['null', 'integer'] }, spec), 0);
  assert.equal(exampleFor({ type: 'number', exclusiveMinimum: 2 }, spec), 3);
  assert.deepEqual(exampleFor({ allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', properties: { tag: { type: 'boolean' } } }] }, spec), { id: 5, tag: true });
  assert.equal(exampleFor({ oneOf: [{ type: 'null' }, { type: 'string', format: 'uuid' }] }, spec), '3fa85f64-5717-4562-b3fc-2c963f66afa6');
  const n = exampleFor({ $ref: '#/components/schemas/Node' }, spec);
  assert.equal(n.name, 'string');
  assert.equal(n.child, null);
  assert.deepEqual(exampleFor({ type: 'array', items: { type: 'integer' } }, spec), [0]);
  assert.deepEqual(exampleFor({ type: 'object', properties: { a: { type: 'string', readOnly: true }, b: { type: 'string', writeOnly: true } } }, spec, 0, { mode: 'request' }), { b: 'string' });
  assert.equal(exampleFor({ $ref: '#/nowhere' }, spec), null);
});

test('the mock server refuses any host but 127.0.0.1', () => {
  assert.throws(() => createMockServer(load('petstore-3.0.yaml'), '3.0', { host: '0.0.0.0' }), /127\.0\.0\.1 only/);
  assert.throws(() => createMockServer(load('petstore-3.0.yaml'), '3.0', { host: 'localhost' }), /127\.0\.0\.1 only/);
});

test('mock server for a Swagger 2.0 spec with basePath', async t => {
  const log = [];
  const m = createMockServer(load('petstore-swagger-2.0.yaml'), '2.0', { log: e => log.push(e) });
  t.after(() => m.stop());
  const { url, port } = await m.start();
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(port > 0);
  let r = await fetch(url + '/v1/pets');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/json/);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  const body = await r.json();
  assert.ok(Array.isArray(body));
  r = await fetch(url + '/v1/pets/42');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-mock-operation'), 'GET /pets/{petId}');
  await r.text();
  r = await fetch(url + '/pets');
  assert.equal(r.status, 200, 'works without the basePath too');
  await r.text();
  r = await fetch(url + '/v1/pets', { method: 'DELETE' });
  assert.equal(r.status, 405);
  assert.match(r.headers.get('allow'), /GET, POST/);
  await r.text();
  r = await fetch(url + '/v1/unknown');
  assert.equal(r.status, 404);
  await r.text();
  r = await fetch(url + '/v1/pets?__code=default');
  assert.equal(r.status, 500);
  assert.deepEqual(Object.keys(await r.json()).sort(), ['code', 'message']);
  r = await fetch(url + '/v1/pets', { method: 'POST' });
  assert.equal(r.status, 201);
  assert.equal(await r.text(), '');
  r = await fetch(url + '/v1/pets', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', Origin: 'http://x' } });
  assert.equal(r.status, 204);
  assert.ok(log.length >= 8);
});

test('mock server for OpenAPI 3.1: examples, Prefer header, server path prefix, body limit', async t => {
  const spec = load('museum-3.1.yaml');
  const m = createMockServer(spec, '3.1');
  t.after(() => m.stop());
  const { url } = await m.start();
  const prefix = m.prefixes[0] || '';
  const ops = m.routes;
  assert.ok(ops.length >= 3);
  let r = await fetch(url + prefix + '/events');
  assert.equal(r.status, 200);
  await r.text();
  r = await fetch(url + prefix + '/tickets/abc');
  assert.ok([200, 404].includes(r.status));
  await r.text();
  r = await fetch(url + prefix + '/tickets', { method: 'POST', headers: { Prefer: 'code=400' }, body: '{}' });
  const codes = Object.keys(spec.paths['/tickets'].post.responses);
  assert.equal(r.status, codes.includes('400') ? 400 : Number(codes.filter(c => /^2/.test(c)).sort()[0]));
  await r.text();
  r = await fetch(url + prefix + '/tickets', { method: 'POST', body: Buffer.alloc(1048576 + 10, 97) }).catch(e => e);
  if (!(r instanceof Error)) { assert.equal(r.status, 413); await r.text().catch(() => ''); }
});

test('the most specific route wins', async t => {
  const spec = { openapi: '3.0.3', info: { title: 'T', version: '1' }, paths: {
    '/users/{id}': { get: { responses: { 200: { description: 'one', content: { 'application/json': { example: { route: 'param' } } } } } } },
    '/users/me': { get: { responses: { 200: { description: 'me', content: { 'application/json': { example: { route: 'me' } } } } } } },
    '/files': { get: { responses: { 200: { description: 'csv', content: { 'text/csv': { example: 'a,b\n1,2' } } } } } },
  } };
  const m = createMockServer(spec, '3.0');
  t.after(() => m.stop());
  const { url } = await m.start();
  assert.deepEqual(await (await fetch(url + '/users/me')).json(), { route: 'me' });
  assert.deepEqual(await (await fetch(url + '/users/7')).json(), { route: 'param' });
  const f = await fetch(url + '/files');
  assert.match(f.headers.get('content-type'), /^text\/csv/);
  assert.equal(await f.text(), 'a,b\n1,2');
});
