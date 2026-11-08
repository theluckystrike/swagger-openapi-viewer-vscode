'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validate, stats } = require('../src/core/validate');

const base = extra => Object.assign({ openapi: '3.0.3', info: { title: 'T', version: '1' }, paths: {} }, extra);
const msgs = (spec, fam = '3.0') => validate(spec, fam).map(i => i.severity + ': ' + i.message);

test('a clean spec has no problems', () => {
  assert.deepEqual(msgs(base({ paths: { '/a/{id}': { get: { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'ok' } } } } } })), []);
});

test('path parameters must match the template and be required', () => {
  const m = msgs(base({ paths: { '/a/{id}': { get: { parameters: [{ name: 'other', in: 'path', schema: { type: 'string' } }], responses: { 200: { description: 'ok' } } } } } }));
  assert.ok(m.some(x => /"\{id\}" is not declared/.test(x)));
  assert.ok(m.some(x => /"other" is in: path but not in the path/.test(x)));
  assert.ok(m.some(x => /must have required: true/.test(x)));
});

test('duplicate operationId, bad response code, unknown security scheme', () => {
  const m = msgs(base({ security: [{ apiKey: [] }], paths: { '/a': { get: { operationId: 'x', responses: { 200: { description: 'ok' } } }, post: { operationId: 'x', responses: { 2000: { description: 'bad' } } } } } }));
  assert.ok(m.some(x => /operationId "x" is used twice/.test(x)));
  assert.ok(m.some(x => /Response code "2000"/.test(x)));
  assert.ok(m.some(x => /Security scheme "apiKey" is not defined/.test(x)));
});

test('responses are required in 3.0 but not in 3.1', () => {
  const spec = base({ paths: { '/a': { get: {} } } });
  assert.ok(msgs(spec).some(x => /has no responses/.test(x)));
  assert.ok(!msgs({ ...spec, openapi: '3.1.0' }, '3.1').some(x => /has no responses/.test(x)));
});

test('version-specific schema keywords get warnings', () => {
  const s30 = base({ components: { schemas: { A: { type: ['string', 'null'] } } } });
  assert.ok(msgs(s30).some(x => /type as a list/.test(x)));
  const s31 = { ...base({ components: { schemas: { A: { type: 'string', nullable: true } } } }), openapi: '3.1.0' };
  assert.ok(msgs(s31, '3.1').some(x => /nullable is not in OpenAPI 3.1/.test(x)));
  assert.ok(msgs(base({ components: { schemas: { A: { type: 'strin' } } } })).some(x => /type "strin"/.test(x)));
});

test('missing info and unknown version', () => {
  const m = msgs({ openapi: '9.9', paths: {} }, 'unknown');
  assert.ok(m.some(x => /9\.9.*not a version/.test(x)));
  assert.ok(m.some(x => /info is required/.test(x)));
});

test('Swagger 2.0: one body parameter, formData and securityDefinitions', () => {
  const s = { swagger: '2.0', info: { title: 'T', version: '1' }, securityDefinitions: { key: { type: 'apiKey', in: 'header', name: 'X' } }, security: [{ key: [] }],
    paths: { '/a': { post: { parameters: [{ name: 'a', in: 'body', schema: {} }, { name: 'b', in: 'body', schema: {} }], responses: { 200: { description: 'ok' } } } } } };
  const m = msgs(s, '2.0');
  assert.ok(m.some(x => /more than one body parameter/.test(x)));
  assert.ok(!m.some(x => /Security scheme/.test(x)));
});

test('stats counts operations, schemas and webhooks', () => {
  assert.deepEqual(stats({ paths: { '/a': { get: {}, post: {} }, '/b': { delete: {} } }, components: { schemas: { A: {} } }, webhooks: { w: {} } }), { paths: 2, operations: 3, schemas: 1, webhooks: 1 });
});
