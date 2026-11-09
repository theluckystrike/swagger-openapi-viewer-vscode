'use strict';
// Field tables for completion (src/core/schema-keys.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { objectTypeAt, fieldsFor, fieldOf, FIELDS, CHILD } = require('../src/core/schema-keys');

test('objectTypeAt maps paths to object types in 2.0, 3.0 and 3.1', () => {
  const cases = [
    [[], '3.0', 'root'], [[], '2.0', 'root2'], [['paths'], '3.0', 'paths'],
    [['paths', '/a', 'get'], '3.0', 'operation'], [['paths', '/a', 'get', 'responses', '200'], '3.0', 'response'],
    [['paths', '/a', 'get', 'responses', '200', 'content', 'application/json', 'schema', 'properties', 'x', 'items'], '3.1', 'schema'],
    [['components', 'schemas', 'Pet', 'allOf', 0], '3.1', 'schema'], [['paths', '/a', 'get', 'parameters', 0], '2.0', 'parameter2'],
    [['paths', '/a', 'get', 'parameters', 0], '3.0', 'parameter'], [['definitions', 'Pet', 'properties', 'id'], '2.0', 'schema'],
    [['webhooks', 'newPet', 'post'], '3.1', 'operation'], [['components', 'securitySchemes', 'o', 'flows', 'implicit'], '3.0', 'oauthFlow'],
    [['responses', 'NotFound', 'headers', 'X'], '2.0', 'header2'], [['paths', '/a', 'get', 'responses'], '3.0', 'responses'],
    [['paths', '/a', 'get', 'requestBody', 'content'], '3.0', 'map:mediaType'], [['info', 'contact'], '3.1', 'contact'],
    [['servers', 0, 'variables', 'v'], '3.0', 'serverVariable'], [['components', 'callbacks', 'cb', '{$request.body#/url}', 'post'], '3.0', 'operation'],
  ];
  for (const [p, fam, want] of cases) assert.equal(objectTypeAt(p, fam), want, `${fam} ${p.join('/')}`);
  for (const [p, fam] of [[['paths', '/a', 'get', 'summary'], '3.0'], [['x-foo'], '3.0'], [['paths', 'x-ext'], '3.0'], [['paths', '/a', 'get', 'x-y', 'z'], '3.1'], [['servers', 'a'], '3.0']]) {
    assert.equal(objectTypeAt(p, fam), null, p.join('/'));
  }
});

test('fields follow the version: nullable only in 3.0, 3.1 JSON Schema keywords, 2.0 root fields', () => {
  const k = (t, f) => fieldsFor(t, f).map(x => x.key);
  assert.ok(k('schema', '3.0').includes('nullable'));
  assert.ok(!k('schema', '3.1').includes('nullable'));
  for (const kw of ['const', 'prefixItems', '$defs', 'if', 'then', 'else', 'unevaluatedProperties', 'contentMediaType', 'examples']) assert.ok(k('schema', '3.1').includes(kw), kw);
  for (const kw of ['oneOf', 'anyOf', 'not', 'writeOnly']) assert.ok(!k('schema', '2.0').includes(kw), kw);
  assert.ok(k('root2', '2.0').includes('swagger') && k('root2', '2.0').includes('definitions') && !k('root2', '2.0').includes('components'));
  assert.ok(k('root', '3.1').includes('webhooks') && k('root', '3.1').includes('jsonSchemaDialect') && !k('root', '3.0').includes('webhooks'));
  assert.deepEqual(fieldOf('schema', 'type', '3.1').enum.includes('null'), true);
  assert.deepEqual(fieldOf('schema', 'type', '3.0').enum.includes('null'), false);
  assert.deepEqual(fieldOf('parameter', 'in', '3.0').enum, ['query', 'header', 'path', 'cookie']);
  assert.ok(fieldOf('parameter2', 'in', '2.0').enum.includes('formData'));
});

test('every field has a short one-sentence doc and a known type, and every CHILD target exists', () => {
  const types = new Set(['string', 'boolean', 'number', 'integer', 'object', 'array', 'map', 'any']);
  for (const [t, list] of Object.entries(FIELDS)) {
    for (const x of list) {
      assert.ok(types.has(x.type), `${t}.${x.key}`);
      assert.ok(x.doc && x.doc.length < 160 && /\.$/.test(x.doc), `${t}.${x.key}`);
      assert.ok(!/\u2014/.test(x.doc), `${t}.${x.key} has an em dash`);
    }
  }
  const known = new Set(Object.keys(FIELDS).concat(['root2', 'paths', 'callback', 'securityRequirement']));
  for (const map of Object.values(CHILD)) for (const v of Object.values(map)) assert.ok(known.has(v.replace(/^(map|arr):/, '')), v);
});
