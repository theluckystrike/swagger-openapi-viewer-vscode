'use strict';
// The fields of each OpenAPI object (Swagger 2.0, OpenAPI 3.0 and 3.1), written by hand from the specifications, for
// key completion and hovers. objectTypeAt() maps a JSON path to the object type found there.
//
// A field: { key, doc, type, enum?, only? } where type is one of 'string', 'boolean', 'number', 'integer', 'object',
// 'array', 'map', 'any' (it decides the inserted text), and `only` lists the families that have the field.

const S = 'string', B = 'boolean', N = 'number', I = 'integer', O = 'object', A = 'array', M = 'map', ANY = 'any';
const V2 = ['2.0'], V3 = ['3.0', '3.1', '3.2'], V31 = ['3.1', '3.2'], V30 = ['3.0'];
const f = (key, type, doc, extra) => Object.assign({ key, type, doc }, extra || {});

const TYPES_30 = ['string', 'number', 'integer', 'boolean', 'array', 'object'];
const TYPES_31 = TYPES_30.concat('null');
const FORMATS = ['int32', 'int64', 'float', 'double', 'byte', 'binary', 'date', 'date-time', 'password', 'email', 'uri', 'uuid', 'hostname', 'ipv4', 'ipv6'];
const IN_3 = ['query', 'header', 'path', 'cookie'];
const IN_2 = ['query', 'header', 'path', 'formData', 'body'];
const STYLES = ['matrix', 'label', 'form', 'simple', 'spaceDelimited', 'pipeDelimited', 'deepObject'];
const SCHEMES = ['http', 'https', 'ws', 'wss'];
const SEC_TYPES_3 = ['apiKey', 'http', 'oauth2', 'openIdConnect', 'mutualTLS'];
const SEC_TYPES_2 = ['basic', 'apiKey', 'oauth2'];
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const STATUS_CODES = [
  ['200', 'OK'], ['201', 'Created'], ['202', 'Accepted'], ['204', 'No Content'], ['301', 'Moved Permanently'], ['302', 'Found'],
  ['304', 'Not Modified'], ['400', 'Bad Request'], ['401', 'Unauthorized'], ['403', 'Forbidden'], ['404', 'Not Found'],
  ['405', 'Method Not Allowed'], ['409', 'Conflict'], ['410', 'Gone'], ['415', 'Unsupported Media Type'], ['422', 'Unprocessable Content'],
  ['429', 'Too Many Requests'], ['500', 'Internal Server Error'], ['502', 'Bad Gateway'], ['503', 'Service Unavailable'], ['default', 'Any other status code'],
  ['2XX', 'Any 2xx status (3.x)'], ['4XX', 'Any 4xx status (3.x)'], ['5XX', 'Any 5xx status (3.x)'],
];
const MEDIA_TYPES = ['application/json', 'application/xml', 'application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain', 'text/html', 'application/octet-stream', 'application/problem+json', '*/*'];

const REF = f('$ref', S, 'A reference to another object, for example #/components/schemas/Pet or ./schemas/pet.yaml.');
const DESC = f('description', S, 'A description. CommonMark (Markdown) is allowed.');
const SUMMARY = f('summary', S, 'A short summary.');
const EXT_DOCS = f('externalDocs', O, 'A link to more documentation.');

const FIELDS = {
  root: [
    f('openapi', S, 'The OpenAPI version of this document, for example 3.1.0.', { only: V3, enum: ['3.1.0', '3.0.3', '3.1.1'] }),
    f('swagger', S, 'The Swagger version. Must be "2.0".', { only: V2, enum: ['2.0'] }),
    f('info', O, 'Title, version and description of the API. Required.'),
    f('jsonSchemaDialect', S, 'The default $schema for Schema objects in this document.', { only: V31 }),
    f('servers', A, 'Base URLs of the API.', { only: V3 }),
    f('host', S, 'Host (name or IP) and optional port, for example api.example.com.', { only: V2 }),
    f('basePath', S, 'Path prefix of every operation, starting with /.', { only: V2 }),
    f('schemes', A, 'Transfer protocols: http, https, ws, wss.', { only: V2, enum: SCHEMES }),
    f('consumes', A, 'Media types the API accepts.', { only: V2 }),
    f('produces', A, 'Media types the API returns.', { only: V2 }),
    f('paths', O, 'The endpoints and their operations.'),
    f('webhooks', M, 'Requests the API sends to callers, keyed by a name.', { only: V31 }),
    f('components', O, 'Reusable schemas, parameters, responses and more.', { only: V3 }),
    f('definitions', M, 'Reusable schemas, keyed by name.', { only: V2 }),
    f('parameters', M, 'Reusable parameters, keyed by name.', { only: V2 }),
    f('responses', M, 'Reusable responses, keyed by name.', { only: V2 }),
    f('securityDefinitions', M, 'Security schemes, keyed by name.', { only: V2 }),
    f('security', A, 'Security requirements that apply to every operation.'),
    f('tags', A, 'Tags with descriptions, in display order.'),
    EXT_DOCS,
  ],
  info: [
    f('title', S, 'The API title. Required.'),
    f('summary', S, 'A short summary of the API.', { only: V31 }),
    DESC,
    f('termsOfService', S, 'URL of the terms of service.'),
    f('contact', O, 'Contact details for the API.'),
    f('license', O, 'License of the API.'),
    f('version', S, 'Version of this API document (not the OpenAPI version). Required.'),
  ],
  contact: [f('name', S, 'Name of the contact person or organisation.'), f('url', S, 'URL of the contact page.'), f('email', S, 'Email address.')],
  license: [f('name', S, 'License name, for example Apache 2.0. Required.'), f('identifier', S, 'SPDX license id, for example MIT.', { only: V31 }), f('url', S, 'URL of the license text.')],
  server: [f('url', S, 'Server URL. It may use {variables}. Required.'), DESC, f('variables', M, 'Values for the {variables} in the URL.')],
  serverVariable: [f('enum', A, 'Allowed values.'), f('default', S, 'Value used when none is given. Required.'), DESC],
  components: [
    f('schemas', M, 'Reusable schemas, keyed by name.'), f('responses', M, 'Reusable responses.'), f('parameters', M, 'Reusable parameters.'),
    f('examples', M, 'Reusable examples.'), f('requestBodies', M, 'Reusable request bodies.'), f('headers', M, 'Reusable headers.'),
    f('securitySchemes', M, 'Security schemes, keyed by name.'), f('links', M, 'Reusable links.'), f('callbacks', M, 'Reusable callbacks.'),
    f('pathItems', M, 'Reusable path items.', { only: V31 }),
  ],
  pathItem: [
    REF, SUMMARY, DESC,
    ...METHODS.map(m => f(m, O, `The ${m.toUpperCase()} operation on this path.`, m === 'trace' ? { only: V3 } : undefined)),
    f('servers', A, 'Servers for the operations of this path.', { only: V3 }),
    f('parameters', A, 'Parameters shared by every operation of this path.'),
  ],
  operation: [
    f('tags', A, 'Tags that group this operation.'), SUMMARY, DESC, EXT_DOCS,
    f('operationId', S, 'A unique id for the operation. Code generators use it as the function name.'),
    f('consumes', A, 'Media types this operation accepts.', { only: V2 }),
    f('produces', A, 'Media types this operation returns.', { only: V2 }),
    f('parameters', A, 'Path, query, header and cookie parameters.'),
    f('requestBody', O, 'The request body.', { only: V3 }),
    f('responses', O, 'Responses by status code. Required in 2.0 and 3.0.'),
    f('callbacks', M, 'Requests the API may send back, keyed by name.', { only: V3 }),
    f('schemes', A, 'Transfer protocols for this operation.', { only: V2, enum: SCHEMES }),
    f('deprecated', B, 'Marks the operation as deprecated.'),
    f('security', A, 'Security requirements for this operation. An empty list removes the global ones.'),
    f('servers', A, 'Servers for this operation.', { only: V3 }),
  ],
  externalDocs: [DESC, f('url', S, 'URL of the documentation. Required.')],
  parameter: [
    REF,
    f('name', S, 'Parameter name. For a path parameter it must match a {name} in the path. Required.'),
    f('in', S, 'Where the parameter goes. Required.', { enum: IN_3 }),
    DESC,
    f('required', B, 'True when the parameter must be sent. Path parameters must say true.'),
    f('deprecated', B, 'Marks the parameter as deprecated.'),
    f('allowEmptyValue', B, 'Allows an empty value (query parameters only).'),
    f('style', S, 'How the value is serialized.', { enum: STYLES }),
    f('explode', B, 'Arrays and objects become separate parameters.'),
    f('allowReserved', B, 'Allows reserved characters such as / and ? without percent-encoding.'),
    f('schema', O, 'The type of the parameter.'),
    f('example', ANY, 'An example value.'),
    f('examples', M, 'Named examples.'),
    f('content', M, 'A media type and schema for complex parameters (one entry).'),
  ],
  parameter2: [
    f('$ref', S, 'A reference, for example #/parameters/limit.'),
    f('name', S, 'Parameter name. Required.'),
    f('in', S, 'Where the parameter goes. Required.', { enum: IN_2 }),
    DESC,
    f('required', B, 'True when the parameter must be sent. Path parameters must say true.'),
    f('schema', O, 'The body schema (only when in is body).'),
    f('type', S, 'The type (when in is not body).', { enum: ['string', 'number', 'integer', 'boolean', 'array', 'file'] }),
    f('format', S, 'A format such as int64 or date-time.', { enum: FORMATS }),
    f('allowEmptyValue', B, 'Allows an empty value.'),
    f('items', O, 'The item type when type is array.'),
    f('collectionFormat', S, 'How an array is written.', { enum: ['csv', 'ssv', 'tsv', 'pipes', 'multi'] }),
    f('default', ANY, 'Value used when none is sent.'),
    f('maximum', N, 'Largest allowed value.'), f('exclusiveMaximum', B, 'The maximum itself is not allowed.'),
    f('minimum', N, 'Smallest allowed value.'), f('exclusiveMinimum', B, 'The minimum itself is not allowed.'),
    f('maxLength', I, 'Longest allowed string.'), f('minLength', I, 'Shortest allowed string.'),
    f('pattern', S, 'A regular expression the value must match.'),
    f('maxItems', I, 'Largest allowed array.'), f('minItems', I, 'Smallest allowed array.'), f('uniqueItems', B, 'Array items must differ.'),
    f('enum', A, 'Allowed values.'), f('multipleOf', N, 'The value must be a multiple of this.'),
  ],
  items2: [
    f('type', S, 'The item type. Required.', { enum: ['string', 'number', 'integer', 'boolean', 'array'] }),
    f('format', S, 'A format such as int64.', { enum: FORMATS }), f('items', O, 'Item type of a nested array.'),
    f('collectionFormat', S, 'How a nested array is written.', { enum: ['csv', 'ssv', 'tsv', 'pipes'] }),
    f('default', ANY, 'Default value.'), f('enum', A, 'Allowed values.'), f('pattern', S, 'A regular expression.'),
    f('maximum', N, 'Largest allowed value.'), f('minimum', N, 'Smallest allowed value.'),
    f('maxLength', I, 'Longest allowed string.'), f('minLength', I, 'Shortest allowed string.'),
  ],
  requestBody: [REF, DESC, f('content', M, 'The body for each media type. Required.'), f('required', B, 'True when a body must be sent.')],
  mediaType: [f('schema', O, 'The schema of the body.'), f('example', ANY, 'An example.'), f('examples', M, 'Named examples.'), f('encoding', M, 'How each property is encoded (form and multipart bodies).')],
  encoding: [
    f('contentType', S, 'Media type of this property.'), f('headers', M, 'Headers of this part (multipart only).'),
    f('style', S, 'How the value is serialized.', { enum: STYLES }), f('explode', B, 'Arrays and objects become separate values.'),
    f('allowReserved', B, 'Allows reserved characters without percent-encoding.'),
  ],
  responses: [f('default', O, 'The response for any status code not listed.')],
  response: [
    REF, f('description', S, 'A description of the response. Required.'),
    f('headers', M, 'Response headers, keyed by name.'),
    f('content', M, 'The body for each media type.', { only: V3 }),
    f('links', M, 'Operations that can follow this response.', { only: V3 }),
    f('schema', O, 'The body schema.', { only: V2 }),
    f('examples', M, 'Examples keyed by media type.', { only: V2 }),
  ],
  header: [
    REF, DESC, f('required', B, 'True when the header is always sent.'), f('deprecated', B, 'Marks the header as deprecated.'),
    f('style', S, 'Always simple for headers.', { enum: ['simple'] }), f('explode', B, 'Arrays and objects become separate values.'),
    f('schema', O, 'The type of the header.'), f('example', ANY, 'An example value.'), f('examples', M, 'Named examples.'), f('content', M, 'A media type and schema (one entry).'),
  ],
  header2: [
    DESC, f('type', S, 'The type. Required.', { enum: ['string', 'number', 'integer', 'boolean', 'array'] }),
    f('format', S, 'A format such as int64.', { enum: FORMATS }), f('items', O, 'Item type when type is array.'),
    f('collectionFormat', S, 'How an array is written.', { enum: ['csv', 'ssv', 'tsv', 'pipes'] }), f('default', ANY, 'Default value.'),
    f('enum', A, 'Allowed values.'), f('pattern', S, 'A regular expression.'),
  ],
  example: [REF, SUMMARY, DESC, f('value', ANY, 'The example value.'), f('externalValue', S, 'URL of the example when it cannot be written inline.')],
  link: [
    REF, f('operationRef', S, 'A reference to the target operation.'), f('operationId', S, 'The operationId of the target operation.'),
    f('parameters', M, 'Values for the target parameters, often runtime expressions.'), f('requestBody', ANY, 'The body for the target operation.'),
    DESC, f('server', O, 'A server for the target operation.'),
  ],
  tag: [f('name', S, 'Tag name. Required.'), DESC, EXT_DOCS],
  discriminator: [f('propertyName', S, 'The property that holds the type name. Required.'), f('mapping', M, 'Values of that property mapped to schema names or references.')],
  xml: [
    f('name', S, 'Element or attribute name.'), f('namespace', S, 'Namespace URI.'), f('prefix', S, 'Namespace prefix.'),
    f('attribute', B, 'Write the property as an attribute.'), f('wrapped', B, 'Wrap the array in an outer element.'),
  ],
  securityScheme: [
    REF, f('type', S, 'The kind of security. Required.', { enum: SEC_TYPES_3 }), DESC,
    f('name', S, 'Header, query or cookie name (apiKey).'), f('in', S, 'Where the key goes (apiKey).', { enum: ['query', 'header', 'cookie'] }),
    f('scheme', S, 'HTTP auth scheme, for example bearer or basic (http).', { enum: ['bearer', 'basic', 'digest'] }),
    f('bearerFormat', S, 'A hint about the token format, for example JWT.'),
    f('flows', O, 'OAuth2 flows (oauth2).'), f('openIdConnectUrl', S, 'OpenID Connect discovery URL (openIdConnect).'),
  ],
  securityScheme2: [
    f('type', S, 'The kind of security. Required.', { enum: SEC_TYPES_2 }), DESC,
    f('name', S, 'Header or query name (apiKey).'), f('in', S, 'Where the key goes (apiKey).', { enum: ['query', 'header'] }),
    f('flow', S, 'The OAuth2 flow.', { enum: ['implicit', 'password', 'application', 'accessCode'] }),
    f('authorizationUrl', S, 'Authorization URL (implicit, accessCode).'), f('tokenUrl', S, 'Token URL (password, application, accessCode).'),
    f('scopes', M, 'Scopes and their descriptions.'),
  ],
  oauthFlows: [
    f('implicit', O, 'The implicit flow.'), f('password', O, 'The resource owner password flow.'),
    f('clientCredentials', O, 'The client credentials flow.'), f('authorizationCode', O, 'The authorization code flow.'),
  ],
  oauthFlow: [
    f('authorizationUrl', S, 'Authorization URL (implicit, authorizationCode).'), f('tokenUrl', S, 'Token URL (password, clientCredentials, authorizationCode).'),
    f('refreshUrl', S, 'URL for refresh tokens.'), f('scopes', M, 'Scopes and their descriptions. Required, may be empty.'),
  ],
  schema: [
    REF,
    f('type', S, 'The data type. In 3.1 it can be a list, for example [string, "null"].', { enum: TYPES_30 }),
    f('format', S, 'A format hint such as int64, date-time or uuid.', { enum: FORMATS }),
    f('title', S, 'A short title.'), DESC,
    f('properties', M, 'The properties of an object, keyed by name.'),
    f('required', A, 'Names of the properties that must be present.'),
    f('additionalProperties', ANY, 'Schema for properties not listed, or false to forbid them.'),
    f('items', O, 'The schema of array items.'),
    f('enum', A, 'Allowed values.'),
    f('default', ANY, 'Default value.'),
    f('example', ANY, 'An example value. In 3.1, prefer examples.'),
    f('examples', A, 'Example values (a list).', { only: V31 }),
    f('const', ANY, 'The only allowed value.', { only: V31 }),
    f('allOf', A, 'The value must match every schema in the list.'),
    f('oneOf', A, 'The value must match exactly one schema in the list.', { only: V3 }),
    f('anyOf', A, 'The value must match at least one schema in the list.', { only: V3 }),
    f('not', O, 'The value must not match this schema.', { only: V3 }),
    f('nullable', B, 'Allows null (3.0). In 3.1 use type: [..., "null"].', { only: V30 }),
    f('discriminator', ANY, 'Tells which schema of oneOf or anyOf applies, by a property value. A property name in 2.0.'),
    f('readOnly', B, 'Sent in responses only.'), f('writeOnly', B, 'Sent in requests only.', { only: V3 }),
    f('deprecated', B, 'Marks the schema as deprecated.', { only: V3 }),
    f('xml', O, 'XML name and namespace.'), EXT_DOCS,
    f('multipleOf', N, 'The value must be a multiple of this.'),
    f('maximum', N, 'Largest allowed value.'),
    f('exclusiveMaximum', ANY, 'A number (3.1) or true to exclude maximum (2.0, 3.0).'),
    f('minimum', N, 'Smallest allowed value.'),
    f('exclusiveMinimum', ANY, 'A number (3.1) or true to exclude minimum (2.0, 3.0).'),
    f('maxLength', I, 'Longest allowed string.'), f('minLength', I, 'Shortest allowed string.'),
    f('pattern', S, 'A regular expression the string must match.'),
    f('maxItems', I, 'Largest allowed array.'), f('minItems', I, 'Smallest allowed array.'), f('uniqueItems', B, 'Array items must differ.'),
    f('maxProperties', I, 'Most properties allowed.'), f('minProperties', I, 'Fewest properties allowed.'),
    f('$schema', S, 'The JSON Schema dialect of this schema.', { only: V31 }),
    f('$id', S, 'A URI that identifies this schema.', { only: V31 }),
    f('$anchor', S, 'A name other schemas can refer to with #name.', { only: V31 }),
    f('$comment', S, 'A comment for maintainers. Not shown to users.', { only: V31 }),
    f('$defs', M, 'Schemas defined inside this schema.', { only: V31 }),
    f('prefixItems', A, 'Schemas for the first items of an array, in order.', { only: V31 }),
    f('contains', O, 'At least one item must match this schema.', { only: V31 }),
    f('minContains', I, 'At least this many items must match contains.', { only: V31 }),
    f('maxContains', I, 'At most this many items may match contains.', { only: V31 }),
    f('patternProperties', M, 'Schemas for properties whose names match a regular expression.', { only: V31 }),
    f('propertyNames', O, 'A schema every property name must match.', { only: V31 }),
    f('dependentRequired', M, 'Properties required when another property is present.', { only: V31 }),
    f('dependentSchemas', M, 'Schemas that apply when a property is present.', { only: V31 }),
    f('if', O, 'Condition schema for then and else.', { only: V31 }),
    f('then', O, 'Applies when if matches.', { only: V31 }),
    f('else', O, 'Applies when if does not match.', { only: V31 }),
    f('unevaluatedProperties', ANY, 'Schema for properties no other keyword checked, or false.', { only: V31 }),
    f('unevaluatedItems', ANY, 'Schema for items no other keyword checked, or false.', { only: V31 }),
    f('contentMediaType', S, 'Media type of a string value, for example image/png.', { only: V31 }),
    f('contentEncoding', S, 'Encoding of a string value, for example base64.', { only: V31 }),
    f('contentSchema', O, 'Schema of the decoded string content.', { only: V31 }),
  ],
};

// Where each field leads. 'X' = an object of type X, 'map:X' = a map of X, 'arr:X' = a list of X. Missing = a leaf.
const CHILD = {
  root: { info: 'info', servers: 'arr:server', paths: 'paths', webhooks: 'map:pathItem', components: 'components', security: 'arr:securityRequirement', tags: 'arr:tag', externalDocs: 'externalDocs' },
  root2: { info: 'info', paths: 'paths', definitions: 'map:schema', parameters: 'map:parameter2', responses: 'map:response', securityDefinitions: 'map:securityScheme2', security: 'arr:securityRequirement', tags: 'arr:tag', externalDocs: 'externalDocs' },
  info: { contact: 'contact', license: 'license' },
  server: { variables: 'map:serverVariable' },
  components: { schemas: 'map:schema', responses: 'map:response', parameters: 'map:parameter', examples: 'map:example', requestBodies: 'map:requestBody', headers: 'map:header', securitySchemes: 'map:securityScheme', links: 'map:link', callbacks: 'map:callback', pathItems: 'map:pathItem' },
  paths: { '*': 'pathItem' },
  callback: { '*': 'pathItem' },
  pathItem: Object.assign({ servers: 'arr:server', parameters: 'arr:parameter' }, Object.fromEntries(METHODS.map(m => [m, 'operation']))),
  operation: { externalDocs: 'externalDocs', parameters: 'arr:parameter', requestBody: 'requestBody', responses: 'responses', callbacks: 'map:callback', security: 'arr:securityRequirement', servers: 'arr:server' },
  parameter: { schema: 'schema', content: 'map:mediaType', examples: 'map:example' },
  parameter2: { schema: 'schema', items: 'items2' },
  items2: { items: 'items2' },
  requestBody: { content: 'map:mediaType' },
  mediaType: { schema: 'schema', examples: 'map:example', encoding: 'map:encoding' },
  encoding: { headers: 'map:header' },
  responses: { '*': 'response' },
  response: { headers: 'map:header', content: 'map:mediaType', links: 'map:link', schema: 'schema' },
  header: { schema: 'schema', content: 'map:mediaType', examples: 'map:example' },
  header2: { items: 'items2' },
  link: { server: 'server' },
  tag: { externalDocs: 'externalDocs' },
  securityScheme: { flows: 'oauthFlows' },
  oauthFlows: { implicit: 'oauthFlow', password: 'oauthFlow', clientCredentials: 'oauthFlow', authorizationCode: 'oauthFlow' },
  schema: {
    properties: 'map:schema', patternProperties: 'map:schema', $defs: 'map:schema', definitions: 'map:schema', dependentSchemas: 'map:schema',
    items: 'schema', additionalProperties: 'schema', not: 'schema', contains: 'schema', propertyNames: 'schema', if: 'schema', then: 'schema', else: 'schema',
    unevaluatedProperties: 'schema', unevaluatedItems: 'schema', contentSchema: 'schema',
    allOf: 'arr:schema', anyOf: 'arr:schema', oneOf: 'arr:schema', prefixItems: 'arr:schema',
    discriminator: 'discriminator', xml: 'xml', externalDocs: 'externalDocs',
  },
};

/** 2.0 uses its own objects in a few places. */
function v2(type, family) {
  if (family !== '2.0') return type;
  return { root: 'root2', parameter: 'parameter2', header: 'header2', securityScheme: 'securityScheme2' }[type] || type;
}

/** The object type found at a JSON path, or null for a leaf, an extension (x-...) or an unknown place. */
function objectTypeAt(path, family) {
  let t = v2('root', family);
  for (const seg0 of path || []) {
    const seg = String(seg0);
    if (t.startsWith('map:')) { if (seg.startsWith('x-')) return null; t = v2(t.slice(4), family); continue; }
    if (t.startsWith('arr:')) { if (!/^\d+$/.test(seg)) return null; t = v2(t.slice(4), family); continue; }
    if (seg.startsWith('x-')) return null;
    const ch = CHILD[t];
    if (!ch) return null;
    let next = ch[seg];
    if (next === undefined && ch['*'] && seg !== '$ref') {
      if (t === 'paths' && !seg.startsWith('/')) return null;
      next = ch['*'];
    }
    if (next === undefined) return null;
    // 2.0 response headers are Header objects of 2.0; the header map in a 2.0 response.
    t = v2(next, family);
    if (family === '2.0' && t === 'map:header') t = 'map:header2';
  }
  return t;
}

/** Fields of an object type for one family. Map and list types have no fields. */
function fieldsFor(type, family) {
  const list = FIELDS[type === 'root2' ? 'root' : type] || [];
  return list.filter(x => !x.only || x.only.includes(family)).map(x => {
    if (type === 'schema' && x.key === 'type') return { ...x, enum: family === '3.1' || family === '3.2' ? TYPES_31 : family === '2.0' ? TYPES_30.concat('file') : TYPES_30 };
    return x;
  });
}

/** One field of a type, or undefined. */
function fieldOf(type, key, family) { return fieldsFor(type, family).find(x => x.key === key); }

module.exports = { FIELDS, CHILD, objectTypeAt, fieldsFor, fieldOf, STATUS_CODES, MEDIA_TYPES, METHODS, TYPES_30, TYPES_31 };
