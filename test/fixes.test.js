'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const YAML = require('../vendor/yaml');
const { fixEdits, rulesetWithRuleOff, applyEdits } = require('../src/core/fixes');
const { parseRuleset } = require('../src/core/lint');
const { build } = require('./helpers');

// Build a spec file, take the issue for `rule`, apply its first fix, and return the new text.
async function fixFile(name, text, rule, pick = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oav-fix-'));
  try {
    const f = path.join(dir, name);
    fs.writeFileSync(f, text);
    const r = await build(f, dir);
    const issue = r.issues.find(i => i.rule === rule);
    assert.ok(issue, `${rule} in ${JSON.stringify(r.issues.map(i => i.rule))}`);
    const fixes = fixEdits(text, /\.json$/.test(name), issue);
    assert.ok(fixes.length > pick, `no fix for ${rule}`);
    return { text: applyEdits(text, fixes[pick].edits), title: fixes[pick].title, issue };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const yamlOk = t => { const d = YAML.parseDocument(t); assert.deepEqual(d.errors, []); return d.toJS(); };

const Y = `openapi: 3.0.3
info:
  title: T
  version: "1"
paths:
  /pets/{petId}:
    get:
      summary: Get
      parameters:
        - name: petId
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Pets'
components:
  schemas:
    Pet:
      type: object
    Old:
      type: string
      description: left over
    Error:
      type: string
`;

test('YAML: add operationId under the method, with the right indent', async () => {
  const r = await fixFile('a.yaml', Y, 'operation-operationId');
  assert.equal(r.title, 'Add operationId: getPetsByPetId');
  const d = yamlOk(r.text);
  assert.equal(d.paths['/pets/{petId}'].get.operationId, 'getPetsByPetId');
  assert.match(r.text, /\n    get:\n      operationId: getPetsByPetId\n      summary: Get/);
});

test('YAML: add description to an operation and to info', async () => {
  const r = await fixFile('a.yaml', Y, 'operation-description');
  assert.equal(yamlOk(r.text).paths['/pets/{petId}'].get.description, '');
  const i = await fixFile('a.yaml', Y, 'info-description');
  assert.equal(yamlOk(i.text).info.description, '');
});

test('YAML: remove an unused schema block, the next one stays', async () => {
  const r = await fixFile('a.yaml', Y, 'oas3-unused-component');
  const d = yamlOk(r.text);
  assert.ok(!(r.issue.data.name in d.components.schemas));
  assert.ok(r.text.includes('      type: string\n      description: left over\n') || r.issue.data.name === 'Old');
  assert.equal(Object.keys(d.components.schemas).length, 2);
  assert.match(r.title, /^Remove unused schema "/);
});

test('YAML: removing the only component leaves an empty map', async () => {
  const t = 'openapi: 3.0.3\ninfo:\n  title: T\n  version: "1"\npaths:\n  /a:\n    get:\n      responses:\n        "200":\n          description: ok\ncomponents:\n  schemas:\n    Only:\n      type: string\n';
  const r = await fixFile('a.yaml', t, 'oas3-unused-component');
  const d = yamlOk(r.text);
  assert.deepEqual(d.components.schemas, {});
});

test('YAML: replace a wrong $ref with the suggestion', async () => {
  const r = await fixFile('a.yaml', Y, 'invalid-ref');
  assert.equal(r.title, 'Change $ref to #/components/schemas/Pet');
  assert.equal(yamlOk(r.text).paths['/pets/{petId}'].get.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/Pet');
});

const J = JSON.stringify({
  openapi: '3.0.3', info: { title: 'T', version: '1' },
  paths: { '/pets': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pett' } } } } } }, post: {} } },
  components: { schemas: { Pet: { type: 'object' }, Old: { type: 'string', enum: ['a', 'b'] }, Last: { type: 'string' } } },
}, null, 2) + '\n';

test('JSON: add operationId, description, and an empty object gets a member', async () => {
  const r = await fixFile('a.json', J, 'operation-operationId');
  const d = JSON.parse(r.text);
  assert.equal(d.paths['/pets'].get.operationId, 'getPets');
  const post = await fixFile('a.json', J, 'operation-description');
  JSON.parse(post.text);
  const empty = '{\n  "openapi": "3.0.3",\n  "info": {"title": "T", "version": "1"},\n  "paths": {\n    "/x": {\n      "get": {}\n    }\n  }\n}\n';
  const e = await fixFile('a.json', empty, 'operation-operationId');
  assert.equal(JSON.parse(e.text).paths['/x'].get.operationId, 'getX');
});

test('JSON: remove an unused member in the middle and at the end, commas stay valid', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oav-fix-'));
  try {
    const f = path.join(dir, 'a.json');
    fs.writeFileSync(f, J);
    const r = await build(f, dir);
    const unused = r.issues.filter(i => i.rule === 'oas3-unused-component');
    assert.deepEqual(unused.map(i => i.data.name).sort(), ['Last', 'Old', 'Pet']);
    for (const name of ['Old', 'Last', 'Pet']) {
      const iss = unused.find(i => i.data.name === name);
      const t = applyEdits(J, fixEdits(J, true, iss)[0].edits);
      const d = JSON.parse(t);
      assert.ok(!(name in d.components.schemas), name);
      assert.equal(Object.keys(d.components.schemas).length, 2, name);
    }
    // one-line object
    const one = '{"openapi":"3.0.3","info":{"title":"T","version":"1"},"paths":{"/a":{"get":{"responses":{"200":{"description":"ok"}}}}},"components":{"schemas":{"A":{"type":"string"},"B":{"type":"string"}}}}';
    for (const name of ['A', 'B']) {
      const t = applyEdits(one, fixEdits(one, true, { rule: 'oas3-unused-component', line: 0, col: one.indexOf('"' + name + '"'), data: { kind: 'schemas', name } })[0].edits);
      assert.deepEqual(Object.keys(JSON.parse(t).components.schemas), [name === 'A' ? 'B' : 'A']);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('JSON: replace a wrong $ref', async () => {
  const r = await fixFile('a.json', J, 'invalid-ref');
  assert.equal(JSON.parse(r.text).paths['/pets'].get.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/Pet');
});

test('no fix when the text at the line is not what the issue says', () => {
  assert.deepEqual(fixEdits('a: 1\n', false, { rule: 'operation-operationId', line: 0, data: { suggestedId: 'x' } }), []);
  assert.deepEqual(fixEdits('a: 1\n', false, { rule: 'oas3-unused-component', line: 0, data: { name: 'B', kind: 'schemas' } }), []);
  assert.deepEqual(fixEdits('x: 1\n', false, { rule: 'invalid-ref', line: 0, data: { ref: '#/a', suggest: '#/b' } }), []);
  assert.deepEqual(fixEdits('get: {operationId: x}\n', false, { rule: 'operation-description', line: 0, data: { key: 'description' } }), [], 'flow maps are left alone');
  assert.deepEqual(fixEdits('info:\n  description: ""\n', false, { rule: 'info-description', line: 0, data: { key: 'description', present: true } }), []);
});

test('turn a rule off in .spectral.yaml: new file, existing YAML with comments, JSON', () => {
  const fresh = rulesetWithRuleOff(null, 'operation-tags');
  assert.equal(fresh, 'extends: ["spectral:oas"]\nrules:\n  operation-tags: off\n');
  assert.equal(parseRuleset(fresh).rules['operation-tags'], 'off');
  const existing = '# team rules\nextends: [spectral:oas]\nrules:\n  info-contact: error # we need it\n';
  const next = rulesetWithRuleOff(existing, 'operation-tags');
  assert.match(next, /# team rules/);
  assert.match(next, /# we need it/);
  const p = parseRuleset(next);
  assert.deepEqual(p.rules, { 'info-contact': 'error', 'operation-tags': 'off' });
  const noRules = rulesetWithRuleOff('extends: spectral:oas\n', 'info-contact');
  assert.equal(parseRuleset(noRules).rules['info-contact'], 'off');
  const json = rulesetWithRuleOff('{"extends":"spectral:oas"}', 'info-contact', '.spectral.json');
  assert.equal(JSON.parse(json).rules['info-contact'], 'off');
  assert.throws(() => rulesetWithRuleOff('rules: [', 'x'), /YAML error/);
});

test('lintfix registers a quick fix provider and the turn-off command', async () => {
  const registered = {};
  const writes = [];
  class Range { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); } }
  class CodeAction { constructor(title, kind) { this.title = title; this.kind = kind; } }
  class WorkspaceEdit { constructor() { this.list = []; } replace(u, r, t) { this.list.push([u, r, t]); } }
  const folder = { uri: { path: '/w', toString: () => 'file:///w' } };
  const vscode = {
    Range, CodeAction, WorkspaceEdit, CodeActionKind: { QuickFix: 'quickfix' },
    Uri: { parse: s => ({ path: s.replace('file://', ''), toString: () => s }), joinPath: (b, n) => ({ path: b.path + '/' + n, toString: () => 'file://' + b.path + '/' + n }) },
    languages: { registerCodeActionsProvider: (sel, p) => { registered.provider = p; return { dispose() {} }; } },
    commands: { registerCommand: (id, fn) => { registered[id] = fn; return { dispose() {} }; } },
    workspace: { getWorkspaceFolder: () => folder, fs: { stat: async () => { throw new Error('ENOENT'); }, readFile: async () => new Uint8Array(), writeFile: async (u, b) => writes.push([u.path, new TextDecoder().decode(b)]) } },
    window: { setStatusBarMessage() {}, showInformationMessage() {}, showWarningMessage() {} },
  };
  const { registerLintFixes, TURN_OFF_CMD } = require('../src/lintfix');
  const issue = { rule: 'operation-operationId', data: { suggestedId: 'getPetsByPetId' }, line: 6, col: 4 };
  registerLintFixes({ vscode, context: { subscriptions: [] }, lookupIssue: () => issue });
  const doc = { uri: vscode.Uri.parse('file:///w/a.yaml'), languageId: 'yaml', getText: () => Y };
  const diag = { range: { start: { line: 6, character: 4 } }, code: 'operation-operationId' };
  const actions = registered.provider.provideCodeActions(doc, null, { diagnostics: [diag] });
  assert.deepEqual(actions.map(a => a.title), ['Add operationId: getPetsByPetId', 'Turn off operation-operationId in .spectral.yaml']);
  assert.equal(actions[0].isPreferred, true);
  assert.equal(actions[1].command.command, TURN_OFF_CMD);
  await registered[TURN_OFF_CMD](...actions[1].command.arguments);
  assert.equal(writes[0][0], '/w/.spectral.yaml');
  assert.equal(parseRuleset(writes[0][1]).rules['operation-operationId'], 'off');
});
