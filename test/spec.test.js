'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/core/spec');

test('looksLikeSpec finds openapi/swagger at the top of YAML and JSON', () => {
  assert.equal(S.looksLikeSpec('# comment\nopenapi: 3.1.0\ninfo: {}'), true);
  assert.equal(S.looksLikeSpec('\uFEFFswagger: "2.0"'), true);
  assert.equal(S.looksLikeSpec('{\n  "openapi": "3.0.0"\n}'), true);
  assert.equal(S.looksLikeSpec('name: app\nservices:\n  openapi: 1'), false);
  assert.equal(S.looksLikeSpec('{"name": "x"}'), false);
  assert.equal(S.looksLikeSpec(null), false);
});

test('versionOf labels the three families', () => {
  assert.deepEqual(S.versionOf({ swagger: '2.0' }), { family: '2.0', label: 'Swagger 2.0', raw: '2.0' });
  assert.equal(S.versionOf({ openapi: '3.0.3' }).family, '3.0');
  assert.equal(S.versionOf({ openapi: '3.1.0' }).label, 'OpenAPI 3.1.0');
  assert.equal(S.versionOf({ openapi: 3.1 }).family, '3.1');
  assert.equal(S.versionOf({ openapi: '4.0' }).family, 'unknown');
  assert.equal(S.versionOf([]).family, 'unknown');
});

test('YAML errors carry a 0-based line; JSON errors too', () => {
  assert.throws(() => S.parseText('a: 1\nb:\n  - x\n c: 2\n', { path: 'x.yaml' }), e => e instanceof S.ParseError && e.line >= 2);
  assert.throws(() => S.parseText('{\n "a": 1,\n "b": ,\n}', { path: 'x.json' }), e => e instanceof S.ParseError && e.line === 2 && /^JSON/.test(e.message));
});

test('a billion laughs YAML stops with a clear message', () => {
  let doc = 'a: &a [x,x,x,x,x,x,x,x,x]\n';
  let prev = 'a';
  for (const n of 'bcdefghi') { doc += `${n}: &${n} [${Array(9).fill('*' + prev).join(',')}]\n`; prev = n; }
  const t0 = Date.now();
  assert.throws(() => S.parseText(doc, { path: 'bomb.yaml' }), /billion laughs/);
  assert.ok(Date.now() - t0 < 2000);
});

test('YAML merge keys and duplicate keys do not stop parsing', () => {
  const r = S.parseText('base: &b {type: string}\nx:\n  <<: *b\n  format: date\ny: 1\ny: 2\n', { path: 'm.yaml' });
  assert.deepEqual(r.data.x, { type: 'string', format: 'date' });
});

test('locate finds lines in YAML and JSON, falling back to the nearest parent', () => {
  const y = S.parseText('openapi: 3.0.0\ninfo:\n  title: T\npaths:\n  /a:\n    get:\n      responses: {}\n', { path: 'a.yaml' });
  const m = y.locate([['paths', '/a', 'get'], ['paths', '/zzz']]);
  assert.equal(m.get(S.pathKey(['paths', '/a', 'get'])).line, 5);
  assert.equal(m.get(S.pathKey(['paths', '/zzz'])).line, 3);
  const text = '{\n "a": {\n  "b": [\n   {"c": 1},\n   {"c": 2, "d": {"e": "x\\"y"}}\n  ]\n },\n "f": true\n}';
  const j = S.parseText(text, { path: 'a.json' });
  const k = j.locate([['a', 'b', '1', 'd', 'e'], ['f'], ['a', 'b', '0', 'c'], ['a', 'nope']]);
  assert.equal(k.get(S.pathKey(['a', 'b', '1', 'd', 'e'])).line, 4);
  assert.equal(k.get(S.pathKey(['f'])).line, 7);
  assert.equal(k.get(S.pathKey(['a', 'b', '0', 'c'])).line, 3);
  assert.equal(k.get(S.pathKey(['a', 'nope'])).line, 1);
});

test('JSON pointers round-trip, and getPath reads own properties only', () => {
  assert.deepEqual(S.pointerToPath('/paths/~1pets~1{id}/get'), ['paths', '/pets/{id}', 'get']);
  assert.equal(S.pathToPointer(['paths', '/a/b', 'x~y']), '/paths/~1a~1b/x~0y');
  assert.equal(S.pointerToPath('bad'), null);
  assert.equal(S.getPath({ a: [1, { b: 2 }] }, ['a', '1', 'b']), 2);
  assert.equal(S.getPath({}, ['constructor']), undefined);
  assert.equal(S.getPath({}, ['__proto__']), undefined);
});
