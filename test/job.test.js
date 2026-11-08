'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { build, SAMPLES } = require('./helpers');

const EXPECT = {
  'petstore-swagger-2.0.yaml': ['Swagger 2.0', 3], 'petstore-expanded-2.0.json': ['Swagger 2.0', 4], 'petstore-3.0.yaml': ['OpenAPI 3.0.0', 3],
  'uspto-3.0.yaml': ['OpenAPI 3.0.1', 3], 'link-example-3.0.yaml': ['OpenAPI 3.0.0', 6], 'api-with-examples-3.0.yaml': ['OpenAPI 3.0.0', 2],
  'callback-example-3.0.yaml': ['OpenAPI 3.0.0', 1], 'webhook-example-3.1.yaml': ['OpenAPI 3.1.0', 0], 'museum-3.1.yaml': ['OpenAPI 3.1.0', 3],
  'hostile-markdown-xss.yaml': ['OpenAPI 3.0.3', 1],
};

for (const [f, [label, ops]] of Object.entries(EXPECT)) {
  test('sample ' + f, async () => {
    const r = await build(path.join(SAMPLES, f));
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.version.label, label);
    assert.equal(r.stats.operations, ops);
    assert.equal(r.issues.filter(i => i.severity === 'error').length, 0, JSON.stringify(r.issues));
  });
}

test('broken YAML and the alias bomb fail with a line and a message', async () => {
  const a = await build(path.join(SAMPLES, 'broken-syntax.yaml'));
  assert.equal(a.ok, false);
  assert.equal(a.error.line + 1, 12);
  const b = await build(path.join(SAMPLES, 'hostile-billion-laughs.yaml'));
  assert.equal(b.ok, false);
  assert.match(b.error.message, /billion laughs/);
});

test('a problem inside a referenced file points to that file and line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oav-'));
  try {
    fs.writeFileSync(path.join(dir, 'root.yaml'), 'openapi: 3.0.3\ninfo:\n  title: T\n  version: "1"\npaths:\n  /a:\n    $ref: ops.yaml\n');
    fs.writeFileSync(path.join(dir, 'ops.yaml'), 'get:\n  parameters:\n    - name: q\n      in: somewhere\n      schema:\n        type: string\n  responses:\n    "200":\n      description: ok\n');
    const r = await build(path.join(dir, 'root.yaml'), dir);
    const i = r.issues.find(x => /in must be one of/.test(x.message));
    assert.ok(i, JSON.stringify(r.issues));
    assert.ok(i.uri.endsWith('/ops.yaml'));
    assert.equal(i.line + 1, 3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a symlink out of the workspace is not followed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oav-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'oav-out-'));
  try {
    fs.writeFileSync(path.join(out, 'secret.yaml'), 'description: SECRET-123\n');
    fs.symlinkSync(path.join(out, 'secret.yaml'), path.join(dir, 'link.yaml'));
    fs.writeFileSync(path.join(dir, 'root.yaml'), 'openapi: 3.0.3\ninfo: {title: T, version: "1"}\npaths: {}\ncomponents:\n  schemas:\n    S:\n      $ref: link.yaml\n');
    const r = await build(path.join(dir, 'root.yaml'), dir);
    assert.ok(!JSON.stringify(r.spec).includes('SECRET-123'));
    assert.ok(r.unresolved.some(u => /outside the workspace/.test(u.reason)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); }
});

test('a generated 20,000-line spec builds in a few seconds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oav-large-'));
  try {
    const f = path.join(dir, 'large.yaml');
    execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'make_large.js'), f]);
    const t0 = Date.now();
    const r = await build(f, dir);
    const ms = Date.now() - t0;
    assert.equal(r.ok, true);
    assert.equal(r.stats.operations, 600);
    assert.ok(ms < 8000, ms + ' ms');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
