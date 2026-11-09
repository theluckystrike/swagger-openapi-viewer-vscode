'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { swagger2ToOas30, oas30ToOas31, toText } = require('../src/core/convert');
const { validate } = require('../src/core/validate');
const { parseText, versionOf } = require('../src/core/spec');

const S = path.join(__dirname, '..', 'samples');
const load = f => parseText(fs.readFileSync(path.join(S, f), 'utf8'), { path: f }).data;
const errors = (spec, fam) => validate(spec, fam).filter(i => i.severity === 'error').map(i => i.message);

for (const f of ['petstore-swagger-2.0.yaml', 'petstore-expanded-2.0.json']) {
  test(`${f} converts to a valid OpenAPI 3.0 and then 3.1`, () => {
    const src = load(f);
    const before = JSON.stringify(src);
    const r = swagger2ToOas30(src);
    assert.equal(JSON.stringify(src), before, 'input not changed');
    assert.equal(r.spec.openapi, '3.0.3');
    assert.equal(versionOf(r.spec).family, '3.0');
    assert.deepEqual(errors(r.spec, '3.0'), []);
    assert.ok(!JSON.stringify(r.spec).includes('#/definitions/'));
    const r2 = oas30ToOas31(r.spec);
    assert.equal(r2.spec.openapi, '3.1.0');
    assert.deepEqual(errors(r2.spec, '3.1'), []);
  });
}

test('servers, request bodies, responses and refs from Swagger 2.0', () => {
  const r = swagger2ToOas30(load('petstore-expanded-2.0.json'));
  const s = r.spec;
  assert.equal(s.servers[0].url, 'http://petstore.swagger.io/api');
  const post = s.paths['/pets'].post;
  assert.ok(post.requestBody.content['application/json'].schema.$ref.startsWith('#/components/schemas/'));
  assert.equal(post.requestBody.required, true);
  assert.ok(s.components.schemas.Pet || s.components.schemas.NewPet);
  const ok = post.responses['200'];
  assert.ok(ok.content['application/json'].schema);
});

test('form, file, collectionFormat, security and refs to shared parameters', () => {
  const src = {
    swagger: '2.0', info: { title: 'T', version: '1' }, host: 'api.example.com', basePath: '/v2/', schemes: ['https', 'http'],
    consumes: ['application/json'], produces: ['application/json'],
    securityDefinitions: {
      basic: { type: 'basic' }, key: { type: 'apiKey', name: 'X-Key', in: 'header' },
      oauth: { type: 'oauth2', flow: 'accessCode', authorizationUrl: 'https://a/auth', tokenUrl: 'https://a/token', scopes: { read: 'Read' } },
      app: { type: 'oauth2', flow: 'application', tokenUrl: 'https://a/token', scopes: {} },
    },
    parameters: { Limit: { name: 'limit', in: 'query', type: 'integer' }, Body: { name: 'pet', in: 'body', required: true, schema: { $ref: '#/definitions/Pet' } } },
    responses: { NotFound: { description: 'nf', schema: { $ref: '#/definitions/Err' } } },
    definitions: { Pet: { type: 'object', discriminator: 'kind', properties: { kind: { type: 'string' }, tag: { type: 'string', 'x-nullable': true } } }, Err: { type: 'object' }, 'Bad Name«T»': { type: 'string' } },
    paths: {
      '/pets': {
        get: { parameters: [{ $ref: '#/parameters/Limit' }, { name: 'ids', in: 'query', type: 'array', items: { type: 'integer' }, collectionFormat: 'multi' }, { name: 'tags', in: 'query', type: 'array', items: { type: 'string' }, collectionFormat: 'pipes' }],
          responses: { 200: { description: 'ok', schema: { type: 'array', items: { $ref: '#/definitions/Bad Name«T»' } }, examples: { 'application/json': [1] } }, 404: { $ref: '#/responses/NotFound' } } },
        post: { parameters: [{ $ref: '#/parameters/Body' }], responses: { 201: { description: 'made' } }, security: [{ oauth: ['read'] }] },
      },
      '/upload': { post: { consumes: ['multipart/form-data'], parameters: [{ name: 'file', in: 'formData', type: 'file', required: true }, { name: 'note', in: 'formData', type: 'string' }], responses: { 200: { description: 'ok' } } } },
      '/login': { post: { consumes: ['application/x-www-form-urlencoded'], parameters: [{ name: 'user', in: 'formData', type: 'string', required: true }], responses: { 200: { description: 'ok' } } } },
    },
  };
  const { spec, notes } = swagger2ToOas30(src);
  assert.deepEqual(spec.servers.map(s => s.url), ['https://api.example.com/v2', 'http://api.example.com/v2']);
  assert.deepEqual(spec.components.securitySchemes.basic, { type: 'http', scheme: 'basic' });
  assert.deepEqual(spec.components.securitySchemes.oauth.flows.authorizationCode.tokenUrl, 'https://a/token');
  assert.ok(spec.components.securitySchemes.app.flows.clientCredentials);
  const get = spec.paths['/pets'].get;
  assert.deepEqual(get.parameters[0], { $ref: '#/components/parameters/Limit' });
  assert.equal(get.parameters[1].style, 'form'); assert.equal(get.parameters[1].explode, true);
  assert.equal(get.parameters[2].style, 'pipeDelimited');
  assert.equal(get.responses['404'].$ref, '#/components/responses/NotFound');
  assert.deepEqual(get.responses['200'].content['application/json'].example, [1]);
  assert.equal(get.responses['200'].content['application/json'].schema.items.$ref, '#/components/schemas/Bad_Name_T');
  assert.ok(notes.some(n => /renamed/.test(n)));
  assert.deepEqual(spec.paths['/pets'].post.requestBody, { $ref: '#/components/requestBodies/Body' });
  assert.ok(spec.components.requestBodies.Body.content['application/json']);
  const up = spec.paths['/upload'].post.requestBody.content['multipart/form-data'].schema;
  assert.deepEqual(up.properties.file, { type: 'string', format: 'binary' });
  assert.deepEqual(up.required, ['file']);
  assert.ok(spec.paths['/login'].post.requestBody.content['application/x-www-form-urlencoded']);
  assert.deepEqual(spec.components.schemas.Pet.discriminator, { propertyName: 'kind' });
  assert.equal(spec.components.schemas.Pet.properties.tag.nullable, true);
  assert.deepEqual(errors(spec, '3.0'), []);
});

test('external file refs stay and get a note', () => {
  const { spec, notes } = swagger2ToOas30({ swagger: '2.0', info: { title: 'T', version: '1' }, paths: { '/a': { get: { responses: { 200: { description: 'ok', schema: { $ref: 'models.yaml#/definitions/A' } } } } } } });
  assert.equal(spec.paths['/a'].get.responses['200'].content['application/json'].schema.$ref, 'models.yaml#/definitions/A');
  assert.ok(notes.some(n => n.startsWith('models.yaml')));
});

test('3.0 to 3.1: nullable, exclusive bounds, example, binary', () => {
  const src = {
    openapi: '3.0.3', info: { title: 'T', version: '1' },
    paths: { '/f': { put: { requestBody: { content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } }, 'multipart/form-data': { schema: { type: 'object', properties: { f: { type: 'string', format: 'binary' }, b: { type: 'string', format: 'base64' } } } } } }, responses: { 200: { description: 'ok' } } } } },
    components: { schemas: {
      A: { type: 'string', nullable: true, enum: ['a', 'b'], example: 'a' },
      N: { type: 'number', minimum: 1, exclusiveMinimum: true, maximum: 9, exclusiveMaximum: false },
      O: { oneOf: [{ type: 'string' }], nullable: true },
      D: { type: 'object', properties: { x: { type: 'integer', nullable: true } } },
    } },
  };
  const before = JSON.stringify(src);
  const { spec, notes } = oas30ToOas31(src);
  assert.equal(JSON.stringify(src), before);
  const s = spec.components.schemas;
  assert.deepEqual(s.A, { type: ['string', 'null'], enum: ['a', 'b', null], examples: ['a'] });
  assert.deepEqual(s.N, { type: 'number', exclusiveMinimum: 1, maximum: 9 });
  assert.deepEqual(s.O.oneOf, [{ type: 'string' }, { type: 'null' }]);
  assert.deepEqual(s.D.properties.x.type, ['integer', 'null']);
  const c = spec.paths['/f'].put.requestBody.content;
  assert.deepEqual(c['application/octet-stream'].schema, {});
  assert.equal(c['multipart/form-data'].schema.properties.f.contentMediaType, 'application/octet-stream');
  assert.equal(c['multipart/form-data'].schema.properties.b.contentEncoding, 'base64');
  assert.ok(notes.length >= 3);
  assert.deepEqual(errors(spec, '3.1'), []);
  assert.ok(!validate(spec, '3.1').some(i => /nullable/.test(i.message)));
});

for (const f of ['petstore-3.0.yaml', 'uspto-3.0.yaml', 'callback-example-3.0.yaml', 'link-example-3.0.yaml', 'api-with-examples-3.0.yaml']) {
  test(`${f} converts to 3.1 with no new errors`, () => {
    const { spec } = oas30ToOas31(load(f));
    assert.deepEqual(errors(spec, '3.1'), []);
  });
}

test('wrong input versions are refused', () => {
  assert.throws(() => swagger2ToOas30(load('petstore-3.0.yaml')), /not a Swagger 2.0/);
  assert.throws(() => oas30ToOas31(load('museum-3.1.yaml')), /not an OpenAPI 3.0/);
});

test('toText writes YAML or JSON that parses back the same', () => {
  const { spec } = swagger2ToOas30(load('petstore-swagger-2.0.yaml'));
  const y = toText(spec, false);
  assert.match(y, /^openapi: 3\.0\.3/);
  assert.match(y, /"200":/);
  assert.deepEqual(parseText(y, { path: 'a.yaml' }).data, spec);
  const j = toText(spec, true, '{\n    "swagger": "2.0"\n}');
  assert.match(j, /^\{\n {4}"openapi"/);
  assert.deepEqual(JSON.parse(j), spec);
});
