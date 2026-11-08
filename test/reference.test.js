'use strict';
// The reference layout's example generator and ref lookup run without a DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'media', 'reference.js'), 'utf8'), ctx);
const R = ctx.window.OAVReference;

test('examples come from example, enum, format and type, and stop at cycles', () => {
  const spec = { components: { schemas: {
    Node: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, child: { $ref: '#/components/schemas/Node' }, kind: { enum: ['a', 'b'] }, n: { type: 'integer', minimum: 5 }, when: { type: ['string', 'null'], format: 'date-time' } } },
  } } };
  const v = R.sample(spec, { $ref: '#/components/schemas/Node' }, 0, new Set());
  assert.equal(v.id, '3fa85f64-5717-4562-b3fc-2c963f66afa6');
  assert.equal(v.kind, 'a');
  assert.equal(v.n, 5);
  assert.equal(v.when, '2026-01-01T12:00:00Z');
  assert.equal(JSON.stringify(v.child), '{}');
});

test('getPtr reads JSON pointers with escapes and refuses prototype keys', () => {
  const spec = { paths: { '/a/b': { get: 1 } } };
  assert.equal(R.getPtr(spec, '#/paths/~1a~1b/get'), 1);
  assert.equal(R.getPtr(spec, '#/__proto__'), undefined);
  assert.equal(R.getPtr(spec, 'other.yaml#/x'), undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(R.deref(spec, { $ref: '#/missing' }))), { __missing: '#/missing' });
});
