'use strict';
// Editor commands that write or compare: convert (Swagger 2.0 -> OpenAPI 3.0 -> 3.1), bundle a multi-file spec,
// breaking-change report, mock server and client code. Every write shows a diff first and waits for a click.
// Network: none. The mock server listens on 127.0.0.1 only and only after the user starts it.
const vscode = require('vscode');
const path = require('path');
const { execFile } = require('child_process');
const { parseText, versionOf } = require('./core/spec');
const { swagger2ToOas30, oas30ToOas31, toText } = require('./core/convert');
const { breakingChanges, diffMarkdown } = require('./core/diff');
const snippets = require('./core/snippets');
const { createMockServer } = require('./core/mock');
const { pathAt, previewTarget } = require('./core/cursor');

const OUT_SCHEME = 'openapi-editor-out';
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

class OutProvider {
  constructor() { this.docs = new Map(); this.seq = 0; this.emitter = new vscode.EventEmitter(); this.onDidChange = this.emitter.event; }
  add(name, text) {
    const id = String(++this.seq);
    this.docs.set(id, text);
    for (const k of [...this.docs.keys()].slice(0, Math.max(0, this.docs.size - 10))) this.docs.delete(k);
    return vscode.Uri.from({ scheme: OUT_SCHEME, path: '/' + name, query: id });
  }
  provideTextDocumentContent(uri) { return this.docs.get(uri.query) || ''; }
}

const isJsonDoc = (uri, text) => /\.json$/i.test(uri.path) || /^\s*\{/.test(text.slice(0, 200));
const stemOf = uri => path.posix.basename(uri.path).replace(/\.(ya?ml|json)$/i, '');
const extOf = uri => (/\.(ya?ml|json)$/i.exec(uri.path) || ['', 'yaml'])[1];

function createCommands({ context, manager, pro, output, targetUri }) {
  const outDocs = new OutProvider();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(OUT_SCHEME, outDocs));
  let mock = null; let mockItem = null;

  async function specDoc(arg) {
    const uri = targetUri(arg);
    if (!uri || !/\.(ya?ml|json)$/i.test(uri.path)) { vscode.window.showInformationMessage('Open an OpenAPI or Swagger file (YAML or JSON) first.'); return null; }
    return vscode.workspace.openTextDocument(uri);
  }

  /** Show the new text next to the old one, then write only when the user picks an action. */
  async function reviewAndWrite(doc, newText, title, saveName, notes, allowReplace) {
    const outUri = outDocs.add(saveName, newText);
    await vscode.commands.executeCommand('vscode.diff', doc.uri, outUri, title, { preview: false });
    if (notes && notes.length) { output.appendLine(`${title}:`); for (const n of notes) output.appendLine('  - ' + n); }
    const saveAs = `Save as ${saveName}`;
    const replace = `Replace ${path.posix.basename(doc.uri.path)}`;
    const buttons = allowReplace ? [saveAs, replace] : [saveAs];
    if (notes && notes.length) buttons.push('Show notes');
    const msg = `Review the changes on the right. Nothing is written until you choose.${notes && notes.length ? ` ${notes.length} note${notes.length > 1 ? 's' : ''} in the output panel.` : ''}`;
    let pick = await vscode.window.showInformationMessage(msg, ...buttons);
    while (pick === 'Show notes') { output.show(true); pick = await vscode.window.showInformationMessage(msg, ...buttons.filter(b => b !== 'Show notes')); }
    if (pick === saveAs) {
      const target = vscode.Uri.joinPath(doc.uri.with({ path: path.posix.dirname(doc.uri.path) }), saveName);
      let exists = false;
      try { await vscode.workspace.fs.stat(target); exists = true; } catch { /* new file */ }
      if (exists) {
        const ok = await vscode.window.showWarningMessage(`${saveName} exists. Replace it?`, { modal: true }, 'Replace');
        if (ok !== 'Replace') return false;
      }
      await vscode.workspace.fs.writeFile(target, Buffer.from(newText, 'utf8'));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target), { preview: false });
      return true;
    }
    if (pick === replace) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), newText);
      await vscode.workspace.applyEdit(edit);
      await vscode.window.showTextDocument(doc, { preview: false });
      vscode.window.setStatusBarMessage('OpenAPI: file replaced. Save it to keep the change, or Undo.', 6000);
      return true;
    }
    return false;
  }

  async function convert(arg, to) {
    const doc = await specDoc(arg);
    if (!doc) return;
    const text = doc.getText();
    let data;
    try { data = parseText(text, { path: doc.uri.toString() }).data; }
    catch (e) { vscode.window.showErrorMessage(`OpenAPI: ${path.posix.basename(doc.uri.path)} cannot be read: ${e.message}`); return; }
    const v = versionOf(data);
    let out, notes = [];
    if (to === '3.0') {
      if (v.family !== '2.0') { vscode.window.showInformationMessage(`This file is ${v.label}. Convert to OpenAPI 3.0 works on Swagger 2.0 files.`); return; }
      ({ spec: out, notes } = swagger2ToOas30(data));
    } else {
      if (v.family === '2.0') { const a = swagger2ToOas30(data); const b = oas30ToOas31(a.spec); out = b.spec; notes = [...a.notes, ...b.notes]; }
      else if (v.family === '3.0') ({ spec: out, notes } = oas30ToOas31(data));
      else { vscode.window.showInformationMessage(`This file is ${v.label}. Convert to OpenAPI 3.1 works on Swagger 2.0 and OpenAPI 3.0 files.`); return; }
    }
    const json = isJsonDoc(doc.uri, text);
    const newText = toText(out, json, text);
    await reviewAndWrite(doc, newText, `${path.posix.basename(doc.uri.path)} ↔ OpenAPI ${to} (not saved)`, `${stemOf(doc.uri)}.openapi-${to}.${extOf(doc.uri)}`, notes, true);
  }

  async function build(doc, text) {
    return manager.buildOnce(doc.uri, text != null ? text : doc.getText());
  }

  async function bundleCmd(arg) {
    const doc = await specDoc(arg);
    if (!doc) return;
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'OpenAPI: bundling $refs…' }, () => build(doc));
    if (!r.ok) { vscode.window.showErrorMessage(`OpenAPI: ${r.error.message}`); return; }
    if (r.unresolved.length) {
      const list = r.unresolved.slice(0, 5).map(u => `${u.ref} (${u.reason})`).join('; ');
      vscode.window.showWarningMessage(`OpenAPI: ${r.unresolved.length} $ref${r.unresolved.length > 1 ? 's' : ''} could not be loaded, so the bundle was not made: ${list}`);
      return;
    }
    if (r.files.length <= 1) { vscode.window.showInformationMessage('This spec is one file already. Nothing to bundle.'); return; }
    const newText = toText(r.spec, isJsonDoc(doc.uri, doc.getText()), doc.getText());
    await reviewAndWrite(doc, newText, `${path.posix.basename(doc.uri.path)} ↔ bundled from ${r.files.length} files (not saved)`, `${stemOf(doc.uri)}.bundled.${extOf(doc.uri)}`, [], false);
  }

  function git(args, cwd) {
    return new Promise((resolve, reject) => execFile('git', args, { cwd, maxBuffer: 256 * 1048576, timeout: 30000 }, (e, out, err) => e ? reject(new Error(String(err || e.message).trim().split('\n')[0])) : resolve(out)));
  }

  async function diffCmd(arg) {
    const doc = await specDoc(arg);
    if (!doc) return;
    if (!(await pro.allow('diff'))) return;
    const choice = await vscode.window.showQuickPick([
      { label: '$(git-commit) Compare with a git ref', detail: 'For example HEAD, main or v1.2.0. Reads the file with git show, offline.', id: 'git' },
      { label: '$(file) Compare with another file', detail: 'An older copy of this spec.', id: 'file' },
    ], { placeHolder: `Breaking-change report for ${path.posix.basename(doc.uri.path)}: the current text is the new version` });
    if (!choice) return;
    let oldText, oldLabel;
    if (choice.id === 'git') {
      if (doc.uri.scheme !== 'file') { vscode.window.showInformationMessage('Git refs work for files on disk only.'); return; }
      if (!vscode.workspace.isTrusted) { vscode.window.showInformationMessage('Git compare is off in Restricted Mode, because git reads the settings of the repository. Trust this workspace, or compare with another file.'); return; }
      const ref = await vscode.window.showInputBox({ prompt: 'Git ref of the old version', value: 'HEAD', validateInput: v => /^[\w./~^@{}-]+$/.test(v) && !v.startsWith('-') ? null : 'Use a branch, tag, commit or HEAD~1.' });
      if (!ref) return;
      const dir = path.dirname(doc.uri.fsPath);
      try {
        const top = (await git(['rev-parse', '--show-toplevel'], dir)).trim();
        const rel = path.relative(top, doc.uri.fsPath).split(path.sep).join('/');
        oldText = await git(['show', `${ref}:${rel}`], top);
        oldLabel = `${rel} at ${ref}`;
      } catch (e) { vscode.window.showErrorMessage(`OpenAPI: git could not read the old version: ${e.message}`); return; }
    } else {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'OpenAPI / Swagger': ['yaml', 'yml', 'json'] }, openLabel: 'Compare' });
      if (!picked || !picked.length) return;
      oldText = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(picked[0]));
      oldLabel = path.posix.basename(picked[0].path);
      const r0 = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'OpenAPI: comparing…' }, () => manager.buildOnce(picked[0], oldText));
      return report(doc, r0, oldLabel);
    }
    const r0 = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'OpenAPI: comparing…' }, () => manager.buildOnce(doc.uri, oldText));
    return report(doc, r0, oldLabel);
  }

  async function report(doc, r0, oldLabel) {
    if (!r0.ok) { vscode.window.showErrorMessage(`OpenAPI: the old version cannot be read: ${r0.error.message}`); return; }
    const r1 = await build(doc);
    if (!r1.ok) { vscode.window.showErrorMessage(`OpenAPI: the current file cannot be read: ${r1.error.message}`); return; }
    const res = breakingChanges(r0.spec, r1.spec, { family: r1.version.family });
    const md = diffMarkdown(res, oldLabel, path.posix.basename(doc.uri.path) + ' (current)');
    const out = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
    await vscode.window.showTextDocument(out, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    vscode.commands.executeCommand('markdown.showPreview', out.uri).then(undefined, () => {});
    vscode.window.setStatusBarMessage(`OpenAPI: ${res.breaking.length} breaking change${res.breaking.length === 1 ? '' : 's'}, ${res.changes.length} other`, 8000);
    return res;
  }

  async function startMock(arg) {
    if (mock) { const pick = await vscode.window.showInformationMessage(`The mock server runs at ${mock.url}.`, 'Stop', 'Restart'); if (pick === 'Stop') return stopMock(); if (pick !== 'Restart') return; await stopMock(); }
    const doc = await specDoc(arg);
    if (!doc) return;
    if (!vscode.workspace.isTrusted) { vscode.window.showInformationMessage('The mock server is off in Restricted Mode. Trust this workspace to start it.'); return; }
    if (!(await pro.allow('mock'))) return;
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'OpenAPI: starting the mock server…' }, () => build(doc));
    if (!r.ok) { vscode.window.showErrorMessage(`OpenAPI: ${r.error.message}`); return; }
    const port = Math.max(0, Math.min(65535, Number(vscode.workspace.getConfiguration('openapiViewer').get('mock.port', 4010)) || 0));
    const server = createMockServer(r.spec, r.version.family, { port, host: '127.0.0.1', log: line => output.appendLine('[mock] ' + line) });
    let started;
    try { started = await server.start(); }
    catch (e) { vscode.window.showErrorMessage(`OpenAPI: the mock server could not start on 127.0.0.1:${port}: ${e.message}. Change openapiViewer.mock.port.`); return; }
    mock = { server, url: started.url, file: path.posix.basename(doc.uri.path) };
    if (!mockItem) { mockItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50); context.subscriptions.push(mockItem); }
    mockItem.text = `$(server) Mock ${started.url.replace(/^http:\/\//, '')}`;
    mockItem.tooltip = `Mock server for ${mock.file}. Click to stop or restart. It listens on 127.0.0.1 only.`;
    mockItem.command = 'openapiViewer.mockServer';
    mockItem.show();
    output.appendLine(`[mock] ${mock.file} on ${started.url}`);
    const pick = await vscode.window.showInformationMessage(`Mock server for ${mock.file} runs at ${started.url} (this computer only).`, 'Copy URL', 'Show log');
    if (pick === 'Copy URL') await vscode.env.clipboard.writeText(started.url);
    if (pick === 'Show log') output.show(true);
    return started.url;
  }

  async function stopMock() {
    if (!mock) return;
    const m = mock; mock = null;
    try { await m.server.stop(); } catch { /* closed */ }
    if (mockItem) mockItem.hide();
    vscode.window.setStatusBarMessage('OpenAPI: mock server stopped', 4000);
  }

  /** The operation under the cursor, or one picked from a list. */
  async function pickOperation(doc, r, hint) {
    if (hint && hint.apiPath && hint.method) return hint;
    const ed = vscode.window.activeTextEditor;
    if (ed && ed.document.uri.toString() === doc.uri.toString()) {
      const p = pathAt(doc.getText(), doc.offsetAt(ed.selection.active), isJsonDoc(doc.uri, doc.getText()));
      const t = previewTarget(p, r.version.family);
      if (t && t.kind === 'operation') return t;
    }
    const items = [];
    for (const [apiPath, item] of Object.entries(r.spec.paths || {})) {
      if (!item || typeof item !== 'object') continue;
      for (const m of METHODS) if (item[m]) items.push({ label: `${m.toUpperCase()} ${apiPath}`, description: String(item[m].summary || item[m].operationId || ''), apiPath, method: m });
      if (items.length > 20000) break;
    }
    if (!items.length) { vscode.window.showInformationMessage('This spec has no operations.'); return null; }
    return vscode.window.showQuickPick(items, { placeHolder: 'Operation', matchOnDescription: true });
  }

  async function snippetCmd(arg, hint) {
    const doc = await specDoc(arg instanceof vscode.Uri ? arg : undefined);
    if (!doc) return;
    if (!(await pro.allow('snippets'))) return;
    const r = await build(doc);
    if (!r.ok) { vscode.window.showErrorMessage(`OpenAPI: ${r.error.message}`); return; }
    const op = await pickOperation(doc, r, hint);
    if (!op) return;
    const lastLang = context.globalState.get('openapiViewer.snippetLang');
    const langs = snippets.LANGUAGES.map(l => ({ label: l.label, id: l.id, picked: l.id === lastLang }));
    langs.sort((a, b) => (b.id === lastLang) - (a.id === lastLang));
    const lang = await vscode.window.showQuickPick(langs, { placeHolder: `Client code for ${op.method.toUpperCase()} ${op.apiPath}` });
    if (!lang) return;
    await context.globalState.update('openapiViewer.snippetLang', lang.id);
    const req = snippets.buildRequest(r.spec, r.version.family, op.apiPath, op.method, {});
    const code = snippets.snippet(lang.id, req);
    await vscode.env.clipboard.writeText(code);
    const info = snippets.LANGUAGES.find(l => l.id === lang.id) || {};
    const out = await vscode.workspace.openTextDocument({ language: info.languageId || 'plaintext', content: code });
    await vscode.window.showTextDocument(out, { viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: true });
    vscode.window.setStatusBarMessage(`OpenAPI: ${lang.label} code copied`, 4000);
    return code;
  }

  context.subscriptions.push(
    { dispose: () => { if (mock) mock.server.stop().catch(() => {}); } },
    vscode.commands.registerCommand('openapiViewer.convertTo30', arg => convert(arg, '3.0')),
    vscode.commands.registerCommand('openapiViewer.convertTo31', arg => convert(arg, '3.1')),
    vscode.commands.registerCommand('openapiViewer.bundle', bundleCmd),
    vscode.commands.registerCommand('openapiViewer.breakingChanges', diffCmd),
    vscode.commands.registerCommand('openapiViewer.mockServer', startMock),
    vscode.commands.registerCommand('openapiViewer.stopMockServer', stopMock),
    vscode.commands.registerCommand('openapiViewer.copyClientCode', snippetCmd),
  );
  return { convert, bundleCmd, diffCmd, startMock, stopMock, snippetCmd, mockUrl: () => mock && mock.url };
}

module.exports = { createCommands, OUT_SCHEME };
