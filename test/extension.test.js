'use strict';
// Loads src/extension.js with a small stand-in for the vscode module, to test its pure parts.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const stubUri = (p, scheme = 'file') => ({ scheme, authority: '', path: p, fsPath: p, toString: () => `${scheme}://${p}`, with(o) { return stubUri(o.path || p, o.scheme || scheme); } });
const vscodeStub = { Uri: { parse: s => stubUri(s.replace(/^file:\/\//, '')), joinPath: (u, ...p) => stubUri([u.path, ...p].join('/')), file: p => stubUri(p) }, workspace: { getConfiguration: () => ({ get: (k, d) => d }) } };
const orig = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscodeStub : orig.call(this, req, ...rest); };
const ext = require('../src/extension');
Module._load = orig;
const { privateAddress, inside, relName } = ext._test;

test('private, loopback, link-local and metadata addresses are refused for remote refs', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '224.0.0.1']) assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111', '172.32.0.1']) assert.equal(privateAddress(ip), false, ip);
});

test('inside() checks folder boundaries, not string prefixes', () => {
  assert.equal(inside(stubUri('/ws/api/a.yaml'), stubUri('/ws')), true);
  assert.equal(inside(stubUri('/ws/../etc/passwd'), stubUri('/ws')), false);
  assert.equal(inside(stubUri('/ws-other/a.yaml'), stubUri('/ws')), false);
  assert.equal(inside(stubUri('/ws/a.yaml', 'vscode-vfs'), stubUri('/ws')), false);
});

test('relName shows a path relative to the root file', () => {
  assert.equal(relName(stubUri('/ws/api/schemas/pet.yaml'), stubUri('/ws/api/openapi.yaml')), 'schemas/pet.yaml');
  assert.equal(relName(stubUri('/etc/passwd'), stubUri('/ws/api/openapi.yaml')), '../../etc/passwd');
});

test('privateAddress: IPv4 inside IPv6 in the hex form that URL parsing makes (VER11)', () => {
  for (const u of ['http://[::ffff:127.0.0.1]:8080/a.yaml', 'http://[::ffff:169.254.169.254]/', 'http://[64:ff9b::127.0.0.1]/', 'http://[::ffff:10.0.0.1]/', 'http://[::127.0.0.1]/', 'http://[::ffff:0:127.0.0.1]/']) {
    const host = new URL(u).hostname.replace(/^\[|\]$/g, '');
    assert.equal(privateAddress(host), true, `${u} -> ${host}`);
  }
  for (const ip of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '::ffff:c0a8:101']) assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['::ffff:808:808', '64:ff9b::808:808', '2001:db8::7f00:1']) assert.equal(privateAddress(ip), false, ip);
});

test('rating: too large, fatal and failed draws record a failure (VER11)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'extension.js'), 'utf8');
  assert.equal((src.match(/heading: 'File too large'/g) || []).length, (src.match(/this\.failed\(\); this\.post\(\{ type: 'notice', heading: 'File too large'/g) || []).length);
  assert.match(src, /catch\(err => \{ this\.failed\(\); this\.post\(\{ type: 'fatal'/);
  assert.match(src, /else if \(!m\.ok\) this\.failed\(\);/);
});
