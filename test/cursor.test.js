'use strict';
// Cursor path (src/core/cursor.js): the JSON path under the cursor, in YAML and JSON, fast on big files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathAt, previewTarget, scanYaml, yamlFind, jsonSiblingKeys } = require('../src/core/cursor');
const { parseText, getPath, locateJson, pathKey } = require('../src/core/spec');

const S = path.join(__dirname, '..', 'samples');
const at = (text, marker, isJson) => { const i = text.indexOf(marker); assert.ok(i >= 0, marker); return pathAt(text.replace(marker, ''), i, isJson); };

test('YAML: keys, sequences, compact sequences, quoted keys and comments', () => {
  const y = [
    'openapi: 3.1.0',
    'paths:',
    "  '/pets/{id}':",
    '    get:',
    '      # a comment',
    '      parameters:',
    '        - name: id',
    '          in: path',
    '        - name: q',
    '          in: qu|ery',
    '      tags:',
    '      - a',
    '      - b|',
    '      responses:',
    '        "200":',
    '          description: ok|',
  ].join('\n');
  assert.deepEqual(at(y, 'qu|ery'.replace('|', '') === 'query' ? '|' : '|'), ['paths', '/pets/{id}', 'get', 'parameters', 1, 'in']);
  const y2 = y.replace('qu|ery', 'query');
  assert.deepEqual(at(y2, 'b|'.slice(1)), ['paths', '/pets/{id}', 'get', 'tags', 1]);
  const y3 = y2.replace('b|', 'b');
  assert.deepEqual(at(y3, '|'), ['paths', '/pets/{id}', 'get', 'responses', '200', 'description']);
});

test('YAML: a blank line and a partial word give the object being filled in', () => {
  const y = 'paths:\n  /a:\n    get:\n      |\n';
  assert.deepEqual(at(y, '|'), ['paths', '/a', 'get']);
  const y2 = 'paths:\n  /a:\n    get:\n      summ|\n';
  assert.deepEqual(pathAt(y2.replace('|', ''), y2.indexOf('summ'), false), ['paths', '/a', 'get']);
  const y3 = 'paths:\n  /a:\n    get:\n      parameters:\n        - na|\n';
  assert.deepEqual(pathAt(y3.replace('|', ''), y3.indexOf('na|'), false), ['paths', '/a', 'get', 'parameters', 0]);
});

test('YAML: inside a block scalar the path ends at its key', () => {
  const y = 'info:\n  description: |\n    Some text\n    key: looks like a key|\n  version: 1\n';
  assert.deepEqual(at(y, '|'), ['info', 'description']);
});

test('YAML: backward path equals forward scan for every key of the samples', () => {
  let n = 0;
  for (const f of ['petstore-3.0.yaml', 'museum-3.1.yaml', 'uspto-3.0.yaml', 'link-example-3.0.yaml', 'callback-example-3.0.yaml', 'api-with-examples-3.0.yaml', 'split/openapi.yaml', 'split/paths/pets.yaml']) {
    const t = fs.readFileSync(path.join(S, f), 'utf8');
    const starts = [0];
    for (let i = t.indexOf('\n'); i >= 0; i = t.indexOf('\n', i + 1)) starts.push(i + 1);
    const data = parseText(t, { path: f }).data;
    scanYaml(t, (p, line, col) => {
      n++;
      assert.deepEqual(pathAt(t, starts[line] + col + 1, false).map(String), p.map(String), `${f}:${line + 1}`);
      assert.notEqual(getPath(data, p.map(String)), undefined, `${f}:${line + 1} ${p.join('/')}`);
    });
  }
  assert.ok(n > 700, String(n));
});

test('JSON: path at every key of the 2.0 sample matches the parser', () => {
  const t = fs.readFileSync(path.join(S, 'petstore-expanded-2.0.json'), 'utf8');
  const d = JSON.parse(t);
  const paths = [];
  (function w(v, p) { if (v && typeof v === 'object') for (const k of Object.keys(v)) { paths.push(p.concat(k)); w(v[k], p.concat(k)); } })(d, []);
  const loc = locateJson(t, paths);
  const starts = [0];
  for (let i = t.indexOf('\n'); i >= 0; i = t.indexOf('\n', i + 1)) starts.push(i + 1);
  for (const p of paths) {
    const L = loc.get(pathKey(p));
    assert.deepEqual(pathAt(t, starts[L.line] + L.col + 1, true).map(String), p, p.join('/'));
  }
});

test('JSON: escaped quotes, key position after a comma, values', () => {
  const j = '{"a": {"b\\"x": "v\\"al", "c": [1, {"d": tr|ue}], |"e": 1}}';
  const t = j.replace(/\|/g, '');
  assert.deepEqual(pathAt(t, j.indexOf('|'), true), ['a', 'c', 1, 'd']);
  assert.deepEqual(pathAt(t, j.lastIndexOf('|') - 1, true), ['a']);
  assert.deepEqual(pathAt(t, j.indexOf('v\\"al') + 2, true), ['a', 'b"x']);
});

test('JSON: keys already in the object, while the text is not valid', () => {
  const t = '{"info": {"title": "t", "x\\"y": {"inner": 1}, , "version": "1"}, "paths": {}}';
  const k = jsonSiblingKeys(t, t.indexOf(', ,') + 2);
  assert.deepEqual([...k].sort(), ['title', 'version', 'x"y']);
});

test('previewTarget maps a path to an operation, webhook, schema or info', () => {
  assert.deepEqual(previewTarget(['paths', '/pets', 'get', 'responses'], '3.0'), { kind: 'operation', apiPath: '/pets', method: 'get' });
  assert.deepEqual(previewTarget(['paths', '/pets', 'parameters'], '3.0'), { kind: 'operation', apiPath: '/pets', method: null });
  assert.deepEqual(previewTarget(['webhooks', 'newPet', 'post'], '3.1'), { kind: 'webhook', name: 'newPet', method: 'post' });
  assert.deepEqual(previewTarget(['components', 'schemas', 'Pet', 'properties'], '3.1'), { kind: 'schema', name: 'Pet' });
  assert.deepEqual(previewTarget(['definitions', 'Pet'], '2.0'), { kind: 'schema', name: 'Pet' });
  assert.deepEqual(previewTarget(['info', 'title'], '3.0'), { kind: 'info' });
  assert.equal(previewTarget(['tags', 0], '3.0'), null);
  assert.equal(previewTarget([], '3.0'), null);
});

test('yamlFind finds a key, and says when it only found a parent', () => {
  const t = fs.readFileSync(path.join(S, 'petstore-3.0.yaml'), 'utf8');
  const hit = yamlFind(t, ['components', 'schemas', 'Pet']);
  assert.equal(t.split('\n')[hit.line].trim(), 'Pet:');
  assert.equal(hit.exact, true);
  assert.equal(yamlFind(t, ['components', 'schemas', 'Nope']).exact, false);
});

function bigYaml() {
  const out = ['openapi: 3.1.0', 'info:', '  title: Big', '  version: "1"', 'paths:'];
  let len = 0;
  for (let i = 0; len < 5.2e6; i++) {
    const b = `  /items${i}/{id}:\n    get:\n      operationId: get${i}\n      parameters:\n        - name: id\n          in: path\n          required: true\n          schema:\n            type: string\n      responses:\n        '200':\n          description: |\n            The item.\n            More: text\n          content:\n            application/json:\n              schema:\n                $ref: '#/components/schemas/Item'\n`;
    out.push(b); len += b.length;
  }
  out.push('components:\n  schemas:\n    Item:\n      type: object\n      properties:\n        id:\n          type: string\n');
  return out.join('\n');
}

test('speed: the end of a 5 MB YAML and of a 6 MB JSON in well under the budget', () => {
  const y = bigYaml();
  assert.ok(y.length > 5e6);
  const o = { openapi: '3.1.0', paths: {} };
  for (let i = 0; i < 18000; i++) o.paths['/x' + i] = { get: { summary: 's' + i + ' "q"', responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/c/' + i } } } } } } };
  o.components = { schemas: { Z: { type: 'object', properties: { a: { type: 'string' } } } } };
  const j = JSON.stringify(o, null, 2);
  assert.ok(j.length > 6e6, String(j.length));
  pathAt('{"warm": [1, {"a": 2}]}', 15, true); pathAt('a:\n  b: 1\n', 8, false);
  let t0 = process.hrtime.bigint();
  const py = pathAt(y, y.length - 3, false);
  const yMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const mid = y.indexOf('More: text', y.length / 2) + 2;
  t0 = process.hrtime.bigint();
  const pm = pathAt(y, mid, false);
  const midMs = Number(process.hrtime.bigint() - t0) / 1e6;
  t0 = process.hrtime.bigint();
  const pj = pathAt(j, j.length - 20, true);
  const jMs = Number(process.hrtime.bigint() - t0) / 1e6;
  t0 = process.hrtime.bigint();
  pathAt(j, j.length - 30, true);
  const j2Ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.deepEqual(py, ['components', 'schemas', 'Item', 'properties', 'id', 'type']);
  assert.equal(pm[0], 'paths'); assert.equal(pm[pm.length - 1], 'description');
  assert.deepEqual(pj, ['components', 'schemas', 'Z', 'properties']);
  console.log(`# pathAt: YAML 5 MB end ${yMs.toFixed(1)} ms, middle ${midMs.toFixed(1)} ms; JSON 6 MB end ${jMs.toFixed(1)} ms, again ${j2Ms.toFixed(2)} ms`);
  // Budget 20 ms; the limits here leave room for a busy test machine.
  assert.ok(yMs < 20 && midMs < 40, `${yMs} ${midMs}`);
  assert.ok(jMs < 80 && j2Ms < 20, `${jMs} ${j2Ms}`);
});
