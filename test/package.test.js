'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const { buildHtml, csp } = require('../src/html');

test('engines floor and types match OVX1 (^1.90.0, ~1.90.0)', () => {
  assert.equal(pkg.engines.vscode, '^1.90.0');
  assert.equal(pkg.devDependencies['@types/vscode'], '~1.90.0');
});

test('every word of each target phrase is in the display name', () => {
  const name = pkg.displayName.toLowerCase();
  for (const phrase of ['swagger editor', 'openapi editor', 'openapi preview', 'swagger preview', 'swagger', 'openapi 3.1', 'openapi lint']) {
    for (const w of phrase.split(' ')) assert.ok(name.includes(w), `${w} (${phrase})`);
  }
});

test('commands in package.json are the ones the extension registers', () => {
  const src = ['src/extension.js', 'src/support.js', 'src/commands.js', 'src/license/index.js'].map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
  for (const c of pkg.contributes.commands) {
    const id = c.command;
    const short = id.split('.')[1];
    assert.ok(src.includes(`'${id}'`) || src.includes(short), id);
  }
  assert.ok(pkg.activationEvents.includes('onWebviewPanel:openapiViewer.preview'));
});

test('the bundled Swagger UI is the version package.json names, with its licence', () => {
  const js = fs.readFileSync(path.join(root, 'media/swagger-ui/swagger-ui-bundle.js'), 'utf8');
  assert.ok(js.length > 1e6);
  assert.ok(fs.readFileSync(path.join(root, 'media/swagger-ui/LICENSE'), 'utf8').includes('Apache License'));
  assert.ok(fs.existsSync(path.join(root, 'vendor/yaml/LICENSE')));
  assert.match(pkg.swaggerUiVersion, /^5\.\d+\.\d+$/);
  const notices = fs.readFileSync(path.join(root, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  assert.ok(notices.includes('swagger-ui-dist ' + pkg.swaggerUiVersion));
  assert.ok(notices.includes('yaml ' + require('../vendor/yaml/package.json').version));
});

test('CSP: nothing remote, scripts only by nonce, no connect, no frames', () => {
  const c = csp('vscode-resource:', 'abc');
  assert.match(c, /default-src 'none'/);
  assert.match(c, /script-src 'nonce-abc'/);
  assert.match(c, /connect-src 'none'/);
  assert.match(c, /frame-src 'none'/);
  assert.ok(!/https?:|\*/.test(c.replace('vscode-resource:', '')));
  const html = buildHtml({ cspSource: 'vscode-resource:', title: '<x>', swaggerJs: 'a.js', swaggerCss: 'a.css', styleUri: 'b.css', scriptUri: 'c.js', referenceUri: 'd.js', nonce: 'n1' });
  assert.ok(!html.includes('<x>'));
  const scripts = html.match(/<script[^>]*>/g);
  assert.equal(scripts.length, 3);
  assert.ok(scripts.every(s => s.includes('nonce="n1"')));
  assert.ok(!/https?:\/\//.test(html.replace(/https:\/\/(github\.com|marketplace\.visualstudio\.com|www\.paypal\.com\/paypalme)[^"' )]*/g, '')));
});

test('webview scripts have no eval and no remote URL', () => {
  for (const f of ['media/preview.js', 'media/reference.js']) {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!/\beval\(|new Function|innerHTML\s*=/.test(s), f);
  }
});

test('vsix stays small: media and vendor under 4 MB', () => {
  let total = 0;
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else total += fs.statSync(p).size; } };
  walk(path.join(root, 'media')); walk(path.join(root, 'vendor')); walk(path.join(root, 'src'));
  assert.ok(total < 4 * 1048576, String(total));
});

test('Marketplace tags: no keyword starts with a special character (vsce refused "$ref" for 0.1.0)', () => {
  for (const k of pkg.keywords) assert.match(k, /^[A-Za-z0-9]/, k);
  assert.ok(pkg.keywords.length <= 30);
});

test('README: no "#123" text, because vsce links it to this repo\'s issue 123 (VER15 finding)', () => {
  const md = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.equal((md.match(/(^|[\s(\[])#\d+\b/gm) || []).length, 0);
  assert.ok(!/USD 15/.test(md + JSON.stringify(pkg)), 'Zovo Pro is USD 19 (FIXSPON)');
});

test('Restricted Mode: what the capabilities text promises is gated on workspace trust (VER15)', () => {
  const cap = pkg.capabilities.untrustedWorkspaces;
  assert.match(cap.description, /remote \$refs/);
  const ext = fs.readFileSync(path.join(root, 'src/extension.js'), 'utf8');
  const allow = ext.slice(ext.indexOf("case 'allowRemote':"), ext.indexOf("case 'refresh':"));
  assert.match(allow, /!vscode\.workspace\.isTrusted/, 'the Load remote refs click is not gated');
  const read = ext.slice(ext.indexOf('async readRef('), ext.indexOf('async readRef(') + 900);
  assert.match(read, /!vscode\.workspace\.isTrusted/, 'readRef does not refuse http refs in Restricted Mode');
  assert.match(ext, /remoteRefs: vscode\.workspace\.isTrusted \? s\.remoteRefs : 'never'/, 'the button is not hidden in Restricted Mode');
  const cmd = fs.readFileSync(path.join(root, 'src/commands.js'), 'utf8');
  assert.match(cmd, /mock server is off in Restricted Mode/);
  for (const k of ['openapiViewer.tryItOut', 'openapiViewer.tryItOutAllowedHosts', 'openapiViewer.mock.port']) assert.ok(cap.restrictedConfigurations.includes(k), k);
});
