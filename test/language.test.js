'use strict';
// Editor features (src/language.js) against a small stand-in for the vscode module.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const posix = path.posix;

// ---- a minimal vscode -------------------------------------------------------------------------------------------
class Position { constructor(l, c) { this.line = l; this.character = c; } }
class Range { constructor(a, b, c, d) { if (a instanceof Position) { this.start = a; this.end = b; } else { this.start = new Position(a, b); this.end = new Position(c, d); } } }
class Location { constructor(uri, p) { this.uri = uri; this.range = p instanceof Range ? p : new Range(p, p); } }
class SnippetString { constructor(v) { this.value = v; } }
class MarkdownString { constructor(v = '') { this.value = v; } appendMarkdown(s) { this.value += s; return this; } appendCodeblock(c, l) { this.value += '\n```' + l + '\n' + c + '\n```\n'; return this; } }
class CompletionItem { constructor(label, kind) { this.label = label; this.kind = kind; } }
class DocumentSymbol { constructor(name, detail, kind, range, sel) { Object.assign(this, { name, detail, kind, range, selectionRange: sel, children: [] }); } }
class Hover { constructor(c, r) { this.contents = [c]; this.range = r; } }
class WorkspaceEdit { constructor() { this.edits = []; } replace(uri, range, text) { this.edits.push({ uri: uri.toString(), range, text }); } }
class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } }
const mkUri = (p, scheme = 'file') => ({ scheme, authority: '', path: p, fsPath: p, query: '', fragment: '', toString() { return `${scheme}://${p}`; }, with(o) { return mkUri(o.path !== undefined ? o.path : p, o.scheme || scheme); } });

function makeVscode(root) {
  const providers = {};
  const reg = name => (sel, prov) => { providers[name] = prov; return { dispose() {} }; };
  const docs = [];
  const vscode = {
    Position, Range, Location, SnippetString, MarkdownString, CompletionItem, DocumentSymbol, Hover, WorkspaceEdit, RelativePattern,
    SymbolKind: { Module: 1, Class: 4, Method: 5, Field: 7, Event: 23 },
    CompletionItemKind: { Value: 11, Property: 9, File: 16, Reference: 17, EnumMember: 19 },
    Uri: { file: p => mkUri(p) },
    languages: { registerDocumentSymbolProvider: reg('symbols'), registerCompletionItemProvider: reg('completion'), registerDefinitionProvider: reg('definition'), registerHoverProvider: reg('hover'), registerRenameProvider: reg('rename') },
    workspace: {
      textDocuments: docs,
      onDidCloseTextDocument: () => ({ dispose() {} }),
      getWorkspaceFolder: u => (u.path.startsWith(root + '/') ? { uri: mkUri(root) } : undefined),
      fs: {
        stat: async u => ({ size: fs.statSync(u.path).size }),
        readFile: async u => new Uint8Array(fs.readFileSync(u.path)),
      },
      findFiles: async (pattern, exclude, max) => {
        const out = [];
        (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f); } else if (/\.(ya?ml|json)$/i.test(e.name)) out.push(mkUri(f)); } })((pattern.base.uri || pattern.base).path);
        return out.slice(0, max);
      },
    },
  };
  return { vscode, providers, docs };
}

let docVersion = 0; // each stand-in document is a new version, as VS Code would give
function makeDoc(file, text) {
  const t = text != null ? text : fs.readFileSync(file, 'utf8');
  const starts = [0];
  for (let i = t.indexOf('\n'); i >= 0; i = t.indexOf('\n', i + 1)) starts.push(i + 1);
  const lines = t.split('\n');
  return {
    uri: mkUri(file), version: ++docVersion, languageId: /\.json$/i.test(file) ? 'json' : 'yaml', lineCount: lines.length,
    getText: () => t, lineAt: n => ({ text: lines[n] }),
    offsetAt: p => Math.min(t.length, starts[p.line] + p.character),
    positionAt: o => { let l = 0; while (l + 1 < starts.length && starts[l + 1] <= o) l++; return new Position(l, o - starts[l]); },
  };
}

/** A document from text with one "|" marking the cursor: { doc, pos }. */
function withCursor(file, marked) {
  const i = marked.indexOf('|');
  const text = marked.slice(0, i) + marked.slice(i + 1);
  const doc = makeDoc(file, text);
  return { doc, pos: doc.positionAt(i) };
}

const { registerLanguage } = require('../src/language');
const { looksLikeSpec } = require('../src/core/spec');
const SAMPLES = fs.realpathSync(path.join(__dirname, '..', 'samples'));

function setup(root = SAMPLES) {
  const env = makeVscode(root);
  registerLanguage({ vscode: env.vscode, context: { subscriptions: [] }, isSpecDoc: d => looksLikeSpec(d.getText()) });
  return env;
}
const labels = items => items.map(i => i.label);

test('outline: Petstore 3.0 shows paths, operations and schemas with their lines', () => {
  const { providers } = setup();
  const doc = makeDoc(path.join(SAMPLES, 'petstore-3.0.yaml'));
  const syms = providers.symbols.provideDocumentSymbols(doc);
  assert.deepEqual(syms.map(s => s.name), ['Info', 'Servers', 'Paths', 'Components']);
  const get = syms[2].children[0].children[0];
  assert.equal(get.name, 'GET');
  assert.equal(get.detail, 'List all pets');
  assert.equal(get.kind, 5);
  assert.equal(doc.lineAt(get.selectionRange.start.line).text.trim(), 'get:');
  assert.ok(get.range.end.line >= get.range.start.line);
  // A file that is not a spec gets no outline from us.
  assert.deepEqual(providers.symbols.provideDocumentSymbols(makeDoc(path.join(SAMPLES, 'split/schemas/pet.yaml'))), []);
});

test('outline of a 5 MB YAML spec comes from the key scan, fast', () => {
  const { providers } = setup();
  const parts = ['openapi: 3.0.3', 'info:', '  title: Big', "  version: '1'", 'paths:'];
  for (let i = 0; i < 18000; i++) parts.push(`  /things${i}:\n    get:\n      summary: Thing ${i}\n      responses:\n        '200':\n          description: |\n            One thing.\n            key: not a key\n          content:\n            application/json:\n              schema:\n                $ref: '#/components/schemas/Thing'`);
  parts.push('components:\n  schemas:\n    Thing:\n      type: object');
  const text = parts.join('\n');
  assert.ok(text.length > 4.5e6, String(text.length));
  const doc = makeDoc('/ws/big.yaml', text);
  const t0 = Date.now();
  const syms = providers.symbols.provideDocumentSymbols(doc);
  const ms = Date.now() - t0;
  const p = syms.find(s => s.name === 'Paths');
  assert.equal(p.children.length, 18000);
  assert.equal(p.children[17999].children[0].detail, 'Thing 17999');
  assert.equal(syms.find(s => s.name === 'Components').children[0].children[0].name, 'Thing');
  console.log(`# outline of ${(text.length / 1048576).toFixed(1)} MB YAML: ${ms} ms`);
  assert.ok(ms < 3000, String(ms));
});

test('completion: keys of an operation, without the ones already there', async () => {
  const { providers } = setup();
  const { doc, pos } = withCursor('/ws/a.yaml', "openapi: 3.1.0\ninfo:\n  title: t\n  version: '1'\npaths:\n  /a:\n    get:\n      summary: x\n      |\n");
  const items = await providers.completion.provideCompletionItems(doc, pos);
  const l = labels(items);
  for (const k of ['operationId', 'responses', 'parameters', 'requestBody', 'tags', 'deprecated']) assert.ok(l.includes(k), k);
  assert.ok(!l.includes('summary') && !l.includes('title'));
  const resp = items.find(i => i.label === 'responses');
  assert.equal(resp.insertText.value, 'responses:\n        $0');
  assert.match(resp.documentation.value, /status code/);
});

test('completion: enum values for parameter "in", schema type in 3.1 and status codes', async () => {
  const { providers } = setup();
  let c = withCursor('/ws/a.yaml', "openapi: 3.1.0\npaths:\n  /a:\n    get:\n      parameters:\n        - name: q\n          in: |\n");
  assert.deepEqual(labels(await providers.completion.provideCompletionItems(c.doc, c.pos)), ['query', 'header', 'path', 'cookie']);
  c = withCursor('/ws/a.yaml', 'openapi: 3.1.0\ncomponents:\n  schemas:\n    A:\n      type: |\n');
  assert.ok(labels(await providers.completion.provideCompletionItems(c.doc, c.pos)).includes('null'));
  c = withCursor('/ws/a.yaml', "openapi: 3.0.3\npaths:\n  /a:\n    get:\n      responses:\n        |\n");
  const codes = await providers.completion.provideCompletionItems(c.doc, c.pos);
  assert.ok(labels(codes).includes('404') && labels(codes).includes('default'));
  assert.match(codes.find(i => i.label === '404').insertText.value, /^'404':\n {10}description: \$\{1:Not Found\}/);
  c = withCursor('/ws/a.yaml', "swagger: '2.0'\npaths:\n  /a:\n    get:\n      parameters:\n        - |\n");
  const p2 = labels(await providers.completion.provideCompletionItems(c.doc, c.pos));
  assert.ok(p2.includes('collectionFormat') && p2.includes('in'), p2.join(' '));
});

test('completion in JSON: keys inside an object and quoted enum values', async () => {
  const { providers } = setup();
  let c = withCursor('/ws/a.json', '{"openapi": "3.0.3", "info": {"title": "t", |}}');
  const l = labels(await providers.completion.provideCompletionItems(c.doc, c.pos));
  assert.ok(l.includes('version') && l.includes('contact') && !l.includes('title'), l.join(' '));
  c = withCursor('/ws/a.json', '{"openapi": "3.0.3", "paths": {"/a": {"get": {"parameters": [{"in": |}]}}}}');
  const items = await providers.completion.provideCompletionItems(c.doc, c.pos);
  assert.equal(items[0].insertText, '"query"');
});

test('completion: $ref targets in the file, files of the workspace and components of another file', async () => {
  const { providers } = setup();
  const file = path.join(SAMPLES, 'split', 'x.yaml');
  let c = withCursor(file, "openapi: 3.0.3\ncomponents:\n  schemas:\n    A:\n      type: object\n    B:\n      $ref: '#/|'\n");
  let items = await providers.completion.provideCompletionItems(c.doc, c.pos);
  assert.deepEqual(labels(items), ['#/components/schemas/A', '#/components/schemas/B']);
  assert.equal(items[0].insertText, '#/components/schemas/A');
  c = withCursor(file, 'openapi: 3.0.3\npaths:\n  /a:\n    $ref: |\n');
  items = await providers.completion.provideCompletionItems(c.doc, c.pos);
  const l = labels(items);
  assert.ok(l.includes('./paths/pets.yaml') && l.includes('./schemas/pet.yaml') && l.includes('../petstore-3.0.yaml'), l.join(' '));
  assert.equal(items.find(i => i.label === './paths/pets.yaml').insertText, "'./paths/pets.yaml'");
  c = withCursor(file, "openapi: 3.0.3\npaths:\n  /a:\n    $ref: '../petstore-3.0.yaml#|'\n");
  items = await providers.completion.provideCompletionItems(c.doc, c.pos);
  assert.ok(labels(items).includes('../petstore-3.0.yaml#/components/schemas/Pet'));
});

test('go to definition: local pointer, relative file, and nothing for remote or outside refs', async () => {
  const { providers } = setup();
  const doc = makeDoc(path.join(SAMPLES, 'petstore-3.0.yaml'));
  const line = doc.getText().split('\n').findIndex(l => l.includes("'#/components/schemas/Pets'"));
  const loc = await providers.definition.provideDefinition(doc, new Position(line, doc.lineAt(line).text.indexOf('Pets')));
  assert.equal(doc.lineAt(loc.range.start.line).text.trim(), 'Pets:');
  const split = makeDoc(path.join(SAMPLES, 'split', 'openapi.yaml'));
  const l2 = split.getText().split('\n').findIndex(l => l.includes('$ref: paths/pets.yaml'));
  const loc2 = await providers.definition.provideDefinition(split, new Position(l2, split.lineAt(l2).text.indexOf('pets.yaml')));
  assert.equal(loc2.uri.path, path.join(SAMPLES, 'split', 'paths', 'pets.yaml'));
  for (const v of ['https://example.com/a.yaml#/x', '../../../../etc/hosts', '//evil/x.yaml']) {
    const c = withCursor(path.join(SAMPLES, 'q.yaml'), `openapi: 3.0.3\nx:\n  $ref: '${v}|'\n`);
    assert.equal(await providers.definition.provideDefinition(c.doc, new Position(c.pos.line, c.pos.character - 2)), null, v);
  }
});

test('hover on a $ref shows the start of the target', async () => {
  const { providers } = setup();
  const doc = makeDoc(path.join(SAMPLES, 'petstore-3.0.yaml'));
  const line = doc.getText().split('\n').findIndex(l => l.includes("'#/components/schemas/Error'"));
  const h = await providers.hover.provideHover(doc, new Position(line, doc.lineAt(line).text.indexOf('Error')));
  assert.match(h.contents[0].value, /This file, line \d+/);
  assert.match(h.contents[0].value, /Error:\n\s+type: object/);
  const c = withCursor(path.join(SAMPLES, 'q.yaml'), "openapi: 3.0.3\nx:\n  $ref: 'https://example.com/a.yaml|'\n");
  const h2 = await providers.hover.provideHover(c.doc, new Position(c.pos.line, c.pos.character - 2));
  assert.match(h2.contents[0].value, /Remote reference/);
});

test('rename a schema: the key and every $ref in the workspace, other names untouched', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nb6-lang-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'api.yaml'), "openapi: 3.0.3\npaths:\n  /a:\n    get:\n      responses:\n        '200':\n          description: ok\n          content:\n            application/json:\n              schema:\n                $ref: '#/components/schemas/Pet'\ncomponents:\n  schemas:\n    Pet:\n      type: object\n    Pets:\n      type: array\n      items:\n        $ref: \"#/components/schemas/Pet\"\n");
  fs.writeFileSync(path.join(root, 'sub', 'other.yaml'), "a:\n  $ref: ../api.yaml#/components/schemas/Pet\nb:\n  $ref: '../api.yaml#/components/schemas/Pets'\n");
  fs.writeFileSync(path.join(root, 'sub', 'c.json'), '{"x": {"$ref": "../api.yaml#/components/schemas/Pet"}, "y": {"$ref": "#/components/schemas/Pet"}}');
  const { providers } = setup(root);
  const doc = makeDoc(path.join(root, 'api.yaml'));
  const keyLine = doc.getText().split('\n').indexOf('    Pet:');
  const prep = providers.rename.prepareRename(doc, new Position(keyLine, 6));
  assert.equal(prep.placeholder, 'Pet');
  assert.deepEqual([prep.range.start.character, prep.range.end.character], [4, 7]);
  const edit = await providers.rename.provideRenameEdits(doc, new Position(keyLine, 6), 'Animal');
  const by = {};
  for (const e of edit.edits) (by[posix.basename(e.uri)] = by[posix.basename(e.uri)] || []).push(e);
  assert.equal(by['api.yaml'].length, 3);
  assert.equal(by['other.yaml'].length, 1);
  assert.equal(by['c.json'].length, 1); // "#/components/schemas/Pet" in c.json points into c.json itself
  assert.ok(edit.edits.every(e => e.text === 'Animal'));
  const other = fs.readFileSync(path.join(root, 'sub', 'other.yaml'), 'utf8').split('\n');
  const oe = by['other.yaml'][0];
  assert.equal(other[oe.range.start.line].slice(oe.range.start.character, oe.range.end.character), 'Pet');
  assert.equal(oe.range.start.line, 1);
  // Starting from a $ref in another file gives the same edits.
  const od = makeDoc(path.join(root, 'sub', 'other.yaml'));
  const e2 = await providers.rename.provideRenameEdits(od, new Position(1, 30), 'Animal');
  assert.equal(e2.edits.length, edit.edits.length);
  await assert.rejects(providers.rename.provideRenameEdits(doc, new Position(keyLine, 6), 'Pets'), /already exists/);
  await assert.rejects(providers.rename.provideRenameEdits(doc, new Position(keyLine, 6), 'bad name'), /only letters/);
  assert.throws(() => providers.rename.prepareRename(doc, new Position(1, 2)), /component name/);
});

test('rename in Swagger 2.0 JSON renames a definition', async () => {
  const { providers } = setup();
  const doc = makeDoc(path.join(SAMPLES, 'petstore-expanded-2.0.json'));
  const lines = doc.getText().split('\n');
  const keyLine = lines.findIndex(l => /^\s*"NewPet": \{/.test(l));
  const edit = await providers.rename.provideRenameEdits(doc, new Position(keyLine, lines[keyLine].indexOf('NewPet') + 1), 'PetInput');
  const mine = edit.edits.filter(e => e.uri.endsWith('petstore-expanded-2.0.json'));
  assert.equal(mine.length, 3); // the key and 2 refs
  for (const e of mine) assert.equal(lines[e.range.start.line].slice(e.range.start.character, e.range.end.character), 'NewPet');
});
