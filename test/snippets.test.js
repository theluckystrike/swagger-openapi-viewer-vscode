'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { LANGUAGES, buildRequest, snippet } = require('../src/core/snippets');
const { parseText } = require('../src/core/spec');

const S = path.join(__dirname, '..', 'samples');
const load = f => parseText(fs.readFileSync(path.join(S, f), 'utf8'), { path: f }).data;

test('10 languages with unique ids', () => {
  assert.equal(LANGUAGES.length, 10);
  assert.equal(new Set(LANGUAGES.map(l => l.id)).size, 10);
});

test('buildRequest fills the server, path parameters, Accept and a JSON body', () => {
  const spec = load('museum-3.1.yaml');
  const r = buildRequest(spec, '3.1', '/tickets', 'post');
  assert.equal(r.method, 'POST');
  assert.match(r.url, /^https?:\/\/[^/]+.*\/tickets$/);
  assert.ok(r.headers.some(([k, v]) => k === 'Content-Type' && v === 'application/json'));
  assert.equal(typeof JSON.parse(r.body), 'object');
  const s2 = load('petstore-swagger-2.0.yaml');
  const g = buildRequest(s2, '2.0', '/pets/{petId}', 'get');
  assert.match(g.url, /^http:\/\/petstore\.swagger\.io\/v1\/pets\/(\{petId\}|[^/{}]+)$/);
  assert.throws(() => buildRequest(s2, '2.0', '/nope', 'get'), /not in the spec/);
});

test('required query, header, security placeholders and an explicit server', () => {
  const spec = { openapi: '3.0.3', info: { title: 'T', version: '1' }, servers: [{ url: 'https://{env}.example.com/v1', variables: { env: { default: 'api' } } }],
    components: { securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-Api-Key' }, bearer: { type: 'http', scheme: 'bearer' } } },
    paths: { '/items/{id}': { get: { security: [{ key: [], bearer: [] }], parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'integer', example: 7 } },
      { name: 'q', in: 'query', required: true, schema: { type: 'string', enum: ['a b'] } },
      { name: 'skip', in: 'query', schema: { type: 'integer' } },
      { name: 'X-Trace', in: 'header', required: true, schema: { type: 'string', default: 't1' } },
    ], responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } } } } } } };
  const r = buildRequest(spec, '3.0', '/items/{id}', 'get');
  assert.equal(r.url, 'https://api.example.com/v1/items/7?q=a%20b');
  assert.deepEqual(r.headers, [['Accept', 'application/json'], ['X-Trace', 't1'], ['X-Api-Key', '<API_KEY>'], ['Authorization', 'Bearer <TOKEN>']]);
  assert.equal(buildRequest(spec, '3.0', '/items/{id}', 'get', { server: 'http://127.0.0.1:4010/' }).url, 'http://127.0.0.1:4010/items/7?q=a%20b');
});

test('form bodies: urlencoded becomes a string, multipart keeps fields', () => {
  const spec = { openapi: '3.0.3', info: { title: 'T', version: '1' }, servers: [{ url: 'https://x.example' }], paths: {
    '/login': { post: { requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { user: { type: 'string', example: 'a&b' } } } } } }, responses: { 204: { description: 'ok' } } } },
    '/upload': { post: { requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, note: { type: 'string' } } } } } }, responses: { 204: { description: 'ok' } } } },
  } };
  const l = buildRequest(spec, '3.0', '/login', 'post');
  assert.equal(l.body, 'user=a%26b');
  assert.equal(l.contentType, 'application/x-www-form-urlencoded');
  const u = buildRequest(spec, '3.0', '/upload', 'post');
  assert.deepEqual(u.form, [['file', '@file.bin'], ['note', 'string']]);
  assert.match(snippet('curl', u), /-F 'file=@file\.bin'/);
  assert.match(snippet('python-requests', u), /files = \{\n {4}"file": open\("file\.bin", "rb"\),/);
  for (const lang of LANGUAGES) assert.ok(snippet(lang.id, u).length > 50, lang.id);
});

test('hostile strings are escaped in every language', () => {
  const nasty = `it's "q" \\ $HOME #{x} \n\u2028 end`;
  const req = { method: 'POST', url: "https://x.example/a?b='c'", headers: [['X-Note', nasty]], body: nasty, contentType: 'text/plain', form: null };
  const out = Object.fromEntries(LANGUAGES.map(l => [l.id, snippet(l.id, req)]));
  // curl: the body is one single-quoted shell word.
  assert.ok(out.curl.includes(`'it'\\''s "q" \\ $HOME #{x} \n\u2028 end'`));
  // JS: the string literal evaluates back to the input.
  const m = /body: (".*"),\n/.exec(out['js-fetch']);
  assert.equal(JSON.parse(m[1]), nasty);
  assert.ok(!/\u2028/.test(out.csharp), 'C# reads U+2028 as a line break');
  assert.ok(out.ruby.includes('\\#{x}'), 'Ruby interpolation is escaped');
  assert.ok(out.php.includes("'it\\'s \"q\" \\\\ $HOME"), 'PHP single quotes');
  assert.ok(out.swift.includes('\\u{2028}') && !out.swift.includes('\\u2028'));
  assert.throws(() => snippet('cobol', req), /Unknown language/);
});

test('snippets for every operation of every sample build without errors', () => {
  for (const f of ['petstore-swagger-2.0.yaml', 'petstore-expanded-2.0.json', 'petstore-3.0.yaml', 'museum-3.1.yaml', 'uspto-3.0.yaml', 'api-with-examples-3.0.yaml']) {
    const spec = load(f);
    for (const p of Object.keys(spec.paths || {})) for (const m of ['get', 'put', 'post', 'delete', 'patch']) {
      if (!spec.paths[p][m]) continue;
      const req = buildRequest(spec, null, p, m);
      for (const l of LANGUAGES) { const out = snippet(l.id, req); assert.ok(out.length > 30 && (out.includes(req.method) || /Net::HTTP::/.test(out)), `${f} ${m} ${p} ${l.id}`); }
    }
  }
});
