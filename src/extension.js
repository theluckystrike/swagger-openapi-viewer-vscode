'use strict';
// Swagger Editor & OpenAPI Editing: lint, IntelliSense and a live preview for OpenAPI 3.x and Swagger 2.0 files
// (YAML or JSON). The extension host reads files (workspace only), a worker thread parses, bundles $refs, validates and
// lints, and the webview draws the result with the bundled Swagger UI or the built-in reference layout. The preview
// follows the cursor, and a click in the preview moves the cursor. No network unless the user turns on remote refs
// for a file or sends a "Try it out" request; the optional mock server listens on 127.0.0.1 only.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const dns = require('dns');
const net = require('net');
const { Worker } = require('worker_threads');
const { buildHtml } = require('./html');
const { looksLikeSpec } = require('./core/spec');
const { parseRuleset } = require('./core/lint');
const { pathAt, previewTarget } = require('./core/cursor');
const { registerLintFixes } = require('./lintfix');
const { registerLanguage } = require('./language');
const { createCommands } = require('./commands');
const { createPro } = require('./pro');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

const SECTION = 'openapiViewer';
const VIEW_TYPE = 'openapiViewer.preview';
const EXT_ID = 'zovo.swagger-openapi-viewer';
const PREFS_KEY = 'openapiViewer.prefs';
const SWAGGER_UI_VERSION = require('../package.json').swaggerUiVersion;
let rating = { success() {}, failure() {} };

function settings() {
  const c = vscode.workspace.getConfiguration(SECTION);
  const num = (k, d, lo, hi) => { const n = Number(c.get(k, d)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  const layout = c.get('defaultLayout', 'auto');
  return {
    layout: ['auto', 'swagger', 'reference'].includes(layout) ? layout : 'auto',
    delay: num('updateDelayMs', 400, 0, 5000),
    maxFileMB: num('maxFileMB', 64, 1, 1024),
    largeSpecMB: num('largeSpecMB', 3, 0.1, 1024),
    tryItOut: c.get('tryItOut', false) === true,
    remoteRefs: c.get('remoteRefs', 'ask') === 'never' ? 'never' : 'ask',
    problems: c.get('showProblemsInEditor', true) !== false,
    docExpansion: ['list', 'full', 'none'].includes(c.get('swaggerUi.docExpansion', 'list')) ? c.get('swaggerUi.docExpansion', 'list') : 'list',
    lint: c.get('lint.enabled', true) !== false,
    lintWithoutPreview: c.get('lint.whenPreviewClosed', true) !== false,
    follow: c.get('preview.followCursor', true) !== false,
    allowedHosts: (Array.isArray(c.get('tryItOutAllowedHosts')) ? c.get('tryItOutAllowedHosts') : DEFAULT_HOSTS).map(h => String(h).trim().toLowerCase()).filter(Boolean),
  };
}

const MB = 1048576;
const DEFAULT_HOSTS = ['localhost', '127.0.0.1', '[::1]', '*.localhost', '*.local', '*.test', '*.example.com', 'petstore.swagger.io', 'petstore3.swagger.io'];

/** True when the host is on the Try it out allowlist. "*.example.com" matches sub.example.com, not example.com. */
function hostAllowed(host, list) {
  const h = String(host || '').toLowerCase();
  return list.some(p => p === h || (p.startsWith('*.') && h.endsWith(p.slice(1)) && h.length > p.length - 1));
}
const fmtMB = n => (n / MB).toFixed(n < 10 * MB ? 1 : 0) + ' MB';

/** Folder the root file may read from: its workspace folder, or its own folder when no workspace is open. */
function allowedRoot(rootUri) {
  const wf = vscode.workspace.getWorkspaceFolder(rootUri);
  if (wf) return wf.uri;
  return rootUri.with({ path: path.posix.dirname(rootUri.path) });
}

function inside(child, parent) {
  if (child.scheme !== parent.scheme || child.authority !== parent.authority) return false;
  const a = path.posix.normalize(child.path), b = path.posix.normalize(parent.path).replace(/\/$/, '');
  return a === b || a.startsWith(b + '/');
}

function relName(uri, base) {
  const b = path.posix.dirname(base.path);
  const r = path.posix.relative(b, uri.path);
  return r || path.posix.basename(uri.path);
}

// ---- remote access (only after the user allows it) -----------------------------------------------------------------
function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  const v4 = embeddedV4(v);
  if (v4) return privateAddress(v4);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
}

/** The IPv4 address inside an IPv4-mapped (::ffff:), NAT64 (64:ff9b::) or IPv4-compatible (::) IPv6 address, in either
 *  form: URL parsing turns [::ffff:127.0.0.1] into ::ffff:7f00:1, which must still count as 127.0.0.1. */
function embeddedV4(v) {
  const m = /^(?:::ffff:(?:0:)?|64:ff9b::|::)(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(v);
  if (!m) return null;
  if (m[1]) return m[1];
  const a = parseInt(m[2], 16), b = parseInt(m[3], 16);
  return [a >> 8, a & 255, b >> 8, b & 255].join('.');
}

async function fetchRemoteRef(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw Object.assign(new Error('only http and https refs can be loaded'), { code: 'refused' });
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.promises.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => privateAddress(a.address))) throw Object.assign(new Error(`${host} is a local or private address, so it is not loaded`), { code: 'refused' });
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'error', headers: { Accept: 'application/json, application/yaml, text/yaml, */*' } });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'read' });
    const len = Number(res.headers.get('content-length') || 0);
    if (len > 20 * MB) throw Object.assign(new Error('larger than 20 MB'), { code: 'limit' });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 20 * MB) throw Object.assign(new Error('larger than 20 MB'), { code: 'limit' });
    return buf.toString('utf8');
  } catch (e) {
    if (e && e.name === 'AbortError') throw Object.assign(new Error('timed out after 15 s'), { code: 'read' });
    throw e;
  } finally { clearTimeout(t); }
}

// ---- worker ---------------------------------------------------------------------------------------------------------
class Builder {
  constructor(context) { this.context = context; this.worker = null; this.jobs = new Map(); this.seq = 0; }
  ensure() {
    if (this.worker) return this.worker;
    const w = new Worker(path.join(this.context.extensionPath, 'src', 'core', 'worker.js'), { resourceLimits: { maxOldGenerationSizeMb: 3072 } });
    w.on('message', m => this.onMessage(m));
    w.on('error', e => this.crash(String(e && e.message || e)));
    w.on('exit', code => { if (this.worker === w) { this.worker = null; if (this.jobs.size) this.crash(`the parser stopped (exit code ${code})`); } });
    this.worker = w;
    return w;
  }
  crash(message) {
    for (const j of this.jobs.values()) { clearTimeout(j.timer); j.reject(new Error(message)); }
    this.jobs.clear();
    if (this.worker) { const w = this.worker; this.worker = null; w.terminate().catch(() => {}); }
  }
  run(rootUri, rootText, read, timeoutMs = 120000, extra = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.jobs.has(id)) this.crash(`building the preview took longer than ${Math.round(timeoutMs / 1000)} s`); }, timeoutMs);
      this.jobs.set(id, { resolve, reject, read, timer });
      this.ensure().postMessage({ type: 'job', id, rootUri, rootText, maxNodes: 6e6, lint: extra.lint !== false, ruleset: extra.ruleset || null });
    });
  }
  onMessage(m) {
    const j = m && this.jobs.get(m.id);
    if (!j) return;
    if (m.type === 'read') {
      j.read(m.uri).then(text => { if (this.worker) this.worker.postMessage({ type: 'readResult', req: m.req, text }); },
        e => { if (this.worker) this.worker.postMessage({ type: 'readResult', req: m.req, error: String(e && e.message || e), code: e && e.code || 'read' }); });
      return;
    }
    clearTimeout(j.timer);
    this.jobs.delete(m.id);
    if (m.type === 'result') j.resolve(m.result); else j.reject(new Error(m.message));
  }
  dispose() { this.crash('closed'); }
}

// ---- preview --------------------------------------------------------------------------------------------------------
class Preview {
  constructor(manager, uri, panel) {
    this.manager = manager; this.uri = uri; this.key = uri.toString(); this.panel = panel;
    this.fileName = path.posix.basename(uri.path);
    this.deps = new Set(); this.allowRemote = false; this.timer = null; this.busy = false; this.again = false;
    this.ready = false; this.disposed = false; this.counted = false; this.pending = false; this.lastOk = null; this.httpOrigins = new Set();
    this.subs = [
      panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(err => vscode.window.showErrorMessage('OpenAPI Viewer: ' + (err && err.message || err)))),
      panel.onDidDispose(() => this.dispose()),
      panel.onDidChangeViewState(e => { if (e.webviewPanel.visible && this.pending) { this.pending = false; this.schedule(0); } }),
    ];
    panel.iconPath = vscode.Uri.joinPath(manager.context.extensionUri, 'media', 'preview-icon.svg');
    this.load();
  }

  load() {
    const wv = this.panel.webview;
    const media = vscode.Uri.joinPath(this.manager.context.extensionUri, 'media');
    wv.options = { enableScripts: true, localResourceRoots: [media], enableCommandUris: commandUris(SECTION) };
    this.ready = false;
    const u = f => wv.asWebviewUri(vscode.Uri.joinPath(media, ...f.split('/'))).toString();
    wv.html = buildHtml({
      cspSource: wv.cspSource, title: this.fileName,
      swaggerJs: u('swagger-ui/swagger-ui-bundle.js'), swaggerCss: u('swagger-ui/swagger-ui.css'),
      styleUri: u('preview.css'), scriptUri: u('preview.js'), referenceUri: u('reference.js'),
      swaggerUiVersion: SWAGGER_UI_VERSION, showSupportLinks: showLinks(vscode, SECTION),
    });
  }

  /** A file that could not be shown records a failure for the rating rule (once per preview): no ask after it. */
  failed() { this.counted = true; if (!this.failRecorded) { this.failRecorded = true; rating.failure(); } }

  /** The layout picked in the toolbar is kept per file; other files start with the openapiViewer.defaultLayout setting. */
  prefs() { const p = this.manager.context.workspaceState.get(PREFS_KEY) || {}; const l = p.layouts && p.layouts[this.key]; return { layout: ['swagger', 'reference'].includes(l) ? l : '' }; }
  post(m) { if (!this.disposed) return this.panel.webview.postMessage(m).then(undefined, () => false); return Promise.resolve(false); }
  doc() { return vscode.workspace.textDocuments.find(d => d.uri.toString() === this.key); }

  schedule(delay) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.update().catch(err => { this.failed(); this.post({ type: 'fatal', message: String(err && err.message || err) }); }), delay);
  }

  /** Debounce grows with the file size, so typing in a 10 MB spec does not start a build on every key. */
  delayFor() {
    const s = settings();
    const d = this.doc();
    const n = this.lastBytes || (d ? d.getText().length : 0);
    return Math.max(s.delay, n > 4 * MB ? 1500 : n > MB ? 800 : 0);
  }

  async rootText() {
    const d = this.doc();
    if (d) return d.getText();
    const s = settings();
    const st = await vscode.workspace.fs.stat(this.uri);
    if (st.size > s.maxFileMB * MB) throw Object.assign(new Error('large'), { size: st.size });
    return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(this.uri));
  }

  async update() {
    if (this.disposed || !this.ready) return;
    if (!this.panel.visible) { this.pending = true; return; }
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      const s = settings();
      let text;
      try { text = await this.rootText(); }
      catch (e) {
        if (e && e.size) { this.failed(); this.post({ type: 'notice', heading: 'File too large', message: `${this.fileName} is ${fmtMB(e.size)}. OpenAPI Viewer opens files up to ${s.maxFileMB} MB (setting openapiViewer.maxFileMB), so it was not read.` }); return; }
        throw e;
      }
      if (text.length > s.maxFileMB * MB) { this.failed(); this.post({ type: 'notice', heading: 'File too large', message: `${this.fileName} is ${fmtMB(text.length)}. OpenAPI Viewer opens files up to ${s.maxFileMB} MB (setting openapiViewer.maxFileMB).` }); return; }
      this.lastBytes = text.length;
      this.post({ type: 'busy', bytes: text.length });
      const root = allowedRoot(this.uri);
      const read = uri => this.manager.readRef(this, uri, root);
      const r = await this.manager.builder.run(this.key, text, read, 120000, { lint: s.lint, ruleset: await this.manager.rulesetFor(this.uri) });
      if (this.disposed) return;
      this.anchors = r.anchors || null;
      if (r.version) this.lastFamily = r.version.family;
      if (!r.ok) {
        this.manager.setProblems(this.key, [{ severity: 'error', message: r.error.message, uri: this.key, line: r.error.line, col: r.error.col, rule: 'parse' }]);
        this.post({ type: 'parseError', error: r.error, fileName: this.fileName, hasLast: !!this.lastOk });
        if (!this.counted && !this.lastOk) { this.counted = true; rating.failure(); }
        return;
      }
      this.deps = new Set(r.files.map(f => { try { return vscode.Uri.parse(f).toString(); } catch { return f; } }));
      this.manager.setProblems(this.key, r.issues);
      const remoteBlocked = r.unresolved.filter(u => u.code === 'remote-blocked').length;
      const big = r.stats.bytes > s.largeSpecMB * MB || r.stats.operations > 600;
      const issues = r.issues.slice(0, 1000).map(i => ({ ...i, file: relName(vscode.Uri.parse(i.uri), this.uri), uri: i.uri }));
      this.lastOk = true;
      await this.post({ type: 'spec', spec: r.spec, version: r.version, issues, issueTotal: r.issues.length, unresolved: r.unresolved.length, remoteBlocked, remoteAllowed: this.allowRemote, remoteRefs: s.remoteRefs, stats: r.stats, ms: r.ms, big, files: r.files.length, fileName: this.fileName });
    } finally {
      this.busy = false;
      if (this.again) { this.again = false; this.schedule(this.delayFor()); }
    }
  }

  async onMessage(m) {
    if (!m || typeof m.type !== 'string') return;
    const s = settings();
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.post({ type: 'init', layout: this.prefs().layout || s.layout, tryItOut: s.tryItOut, docExpansion: s.docExpansion, fileName: this.fileName, uri: this.key, follow: s.follow });
        this.schedule(0);
        break;
      case 'rendered':
        if (!this.counted && m.ok) { this.counted = true; rating.success(this.uri); }
        else if (!m.ok) this.failed();
        this.lastRender = { ms: Number(m.ms) || 0, layout: String(m.layout || '') };
        break;
      case 'layout':
        if (m.layout === 'swagger' || m.layout === 'reference') {
          const p = this.manager.context.workspaceState.get(PREFS_KEY) || {};
          const layouts = Object.assign({}, p.layouts || {});
          delete layouts[this.key];
          layouts[this.key] = m.layout;
          const keys = Object.keys(layouts);
          for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete layouts[k];
          await this.manager.context.workspaceState.update(PREFS_KEY, { layouts });
        }
        break;
      case 'reveal': await this.reveal(String(m.uri || this.key), Number(m.line) || 0, Number(m.col) || 0); break;
      case 'jump': await this.jump(m); break;
      case 'follow': await vscode.workspace.getConfiguration(SECTION).update('preview.followCursor', !!m.on, vscode.ConfigurationTarget.Global); break;
      case 'snippet': vscode.commands.executeCommand('openapiViewer.copyClientCode', this.uri, { apiPath: String(m.apiPath || ''), method: String(m.method || '').toLowerCase() }); break;
      case 'allowRemote':
        if (s.remoteRefs === 'never') { vscode.window.showInformationMessage('Remote $refs are turned off in settings (openapiViewer.remoteRefs).'); break; }
        this.allowRemote = true; this.schedule(0); break;
      case 'refresh': this.schedule(0); break;
      case 'openLink': await this.openLink(String(m.url || '')); break;
      case 'http': await this.http(m); break;
      case 'copied': vscode.window.setStatusBarMessage('OpenAPI Viewer: copied', 3000); break;
      case 'copyText': if (typeof m.text === 'string') { await vscode.env.clipboard.writeText(m.text.slice(0, 50 * MB)); vscode.window.setStatusBarMessage('OpenAPI Viewer: copied', 3000); } break;
      case 'settings': vscode.commands.executeCommand('workbench.action.openSettings', String(m.query || SECTION)); break;
      case 'error': vscode.window.showErrorMessage('OpenAPI Viewer: ' + String(m.message || '').slice(0, 400)); break;
    }
  }

  /** A click on an operation or schema in the preview: put the cursor on its line in the spec, keep the preview focused. */
  async jump(m) {
    const a = this.anchors;
    if (!a) return;
    const kind = String(m.kind || '');
    const hit = kind === 'operation' ? a.ops && a.ops[String(m.method || '').toLowerCase() + ' ' + String(m.apiPath || '')]
      : kind === 'webhook' ? a.hooks && a.hooks[String(m.method || '').toLowerCase() + ' ' + String(m.name || '')]
        : kind === 'schema' ? a.schemas && a.schemas[String(m.name || '')] : null;
    if (!hit) return;
    this.manager.lastJump = { key: hit.uri, line: hit.line, at: Date.now() };
    await this.reveal(hit.uri, hit.line, hit.col || 0, true);
  }

  /** Cursor moved in the root file: show the operation or schema under it (reference layout selects it, Swagger UI scrolls). */
  follow(target) {
    const k = target ? JSON.stringify(target) : '';
    if (!target || k === this.lastFollow) return;
    this.lastFollow = k;
    this.post({ type: 'follow', target });
  }

  async reveal(uriStr, line, col, keepFocus) {
    let uri;
    try { uri = vscode.Uri.parse(uriStr); } catch { return; }
    if (uri.toString() !== this.key && !this.deps.has(uri.toString())) return; // only files of this spec
    const doc = await vscode.workspace.openTextDocument(uri);
    const l = Math.max(0, Math.min(line, doc.lineCount - 1));
    const pos = new vscode.Position(l, Math.max(0, col));
    const ed = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
    const col0 = ed ? ed.viewColumn : (this.panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One);
    const shown = await vscode.window.showTextDocument(doc, { viewColumn: col0, preserveFocus: !!keepFocus, preview: false, selection: new vscode.Range(pos, pos) });
    shown.revealRange(new vscode.Range(pos, pos), keepFocus ? vscode.TextEditorRevealType.AtTop : vscode.TextEditorRevealType.InCenter);
  }

  async openLink(url) {
    let u;
    try { u = vscode.Uri.parse(url, true); } catch { return; }
    if (!['http', 'https', 'mailto'].includes(u.scheme)) { vscode.window.showWarningMessage(`OpenAPI Viewer opens only http, https and mailto links. This link was not opened: ${url.slice(0, 200)}`); return; }
    const pick = await vscode.window.showInformationMessage(`Open this link in your browser?\n${url.slice(0, 500)}`, { modal: true }, 'Open');
    if (pick === 'Open') await vscode.env.openExternal(u);
  }

  /** "Try it out": the request is sent by the extension host, only when the setting is on, after a confirm per origin. */
  async http(m) {
    const reply = r => this.post({ type: 'httpResult', id: m.id, ...r });
    if (!settings().tryItOut) return reply({ error: 'Try it out is off. Turn on openapiViewer.tryItOut to send requests.' });
    let u;
    try { u = new URL(String(m.url)); } catch { return reply({ error: 'Not a valid URL: ' + String(m.url).slice(0, 200) }); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reply({ error: 'Only http and https requests are sent.' });
    const allow = settings().allowedHosts;
    if (!hostAllowed(u.hostname, allow)) {
      const add = `Allow ${u.hostname}`;
      const pick = await vscode.window.showWarningMessage(`${u.hostname} is not on the Try it out allowlist (openapiViewer.tryItOutAllowedHosts). It may be a production server. Nothing was sent.`, { modal: true }, add);
      if (pick !== add) return reply({ error: `Not sent: ${u.hostname} is not on the allowlist (openapiViewer.tryItOutAllowedHosts).` });
      await vscode.workspace.getConfiguration(SECTION).update('tryItOutAllowedHosts', [...allow, u.hostname.toLowerCase()], vscode.ConfigurationTarget.Workspace);
    }
    if (!this.httpOrigins.has(u.origin)) {
      const pick = await vscode.window.showWarningMessage(`Send a ${String(m.method || 'GET').toUpperCase()} request to ${u.origin}? "Try it out" sends real requests from VS Code.`, { modal: true }, 'Send');
      if (pick !== 'Send') return reply({ error: 'Request cancelled.' });
      this.httpOrigins.add(u.origin);
    }
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 60000);
    try {
      const headers = {};
      for (const [k, v] of Object.entries(m.headers || {})) if (typeof v === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)) headers[k] = v;
      const method = String(m.method || 'GET').toUpperCase();
      const res = await fetch(u.toString(), { method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : (typeof m.body === 'string' ? m.body : undefined), signal: ac.signal, redirect: 'follow' });
      const buf = Buffer.from(await res.arrayBuffer());
      const h = {};
      res.headers.forEach((v, k) => { h[k] = v; });
      reply({ status: res.status, statusText: res.statusText, headers: h, body: buf.subarray(0, 10 * MB).toString('utf8'), url: res.url });
    } catch (e) {
      reply({ error: e && e.name === 'AbortError' ? 'The request timed out after 60 s.' : String(e && e.message || e) });
    } finally { clearTimeout(t); }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; clearTimeout(this.timer);
    this.subs.forEach(s => s.dispose());
    this.manager.previews.delete(this.key);
    this.manager.clearProblems(this.key);
    this.manager.linter.refresh();
  }
}

class Manager {
  constructor(context) {
    this.context = context; this.previews = new Map(); this.builder = new Builder(context);
    this.diagnostics = vscode.languages.createDiagnosticCollection('openapi');
    this.problemFiles = new Map(); // owner key -> [uri strings]
    this.issueIndex = new Map(); // uri string -> Map("line|rule" -> [issue])
    this.rulesets = new Map(); // folder uri -> { mtime, ruleset }
    this.linter = new Linter(this);
  }

  async readRef(preview, uriStr, root) {
    let uri;
    try { uri = vscode.Uri.parse(uriStr, true); } catch { throw Object.assign(new Error('not a valid URI'), { code: 'refused' }); }
    if (uri.scheme === 'http' || uri.scheme === 'https') {
      const s = settings();
      if (s.remoteRefs === 'never') throw Object.assign(new Error('remote refs are turned off (openapiViewer.remoteRefs)'), { code: 'refused' });
      if (!preview || !preview.allowRemote) throw Object.assign(new Error('remote refs are not loaded until you click "Load remote refs"'), { code: 'remote-blocked' });
      return fetchRemoteRef(uriStr);
    }
    const rel = relName(uri, preview ? preview.uri : root);
    if (!inside(uri, root)) throw Object.assign(new Error(`${rel} is outside the workspace, so it is not read`), { code: 'outside' });
    if (uri.scheme === 'file') {
      // A symlink inside the workspace must not lead out of it.
      try {
        const real = fs.realpathSync.native(uri.fsPath), realRoot = fs.realpathSync.native(root.fsPath);
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw Object.assign(new Error(`${rel} links outside the workspace, so it is not read`), { code: 'outside' });
      } catch (e) {
        if (e.code === 'outside') throw e;
        if (e.code === 'ENOENT') throw Object.assign(new Error(`file not found: ${rel}`), { code: 'missing' });
      }
    }
    const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    if (open) return open.getText();
    let st;
    try { st = await vscode.workspace.fs.stat(uri); } catch { throw Object.assign(new Error(`file not found: ${rel}`), { code: 'missing' }); }
    if (st.type & vscode.FileType.Directory) throw Object.assign(new Error(`${rel} is a folder`), { code: 'refused' });
    const max = settings().maxFileMB * MB;
    if (st.size > max) throw Object.assign(new Error(`${rel} is ${fmtMB(st.size)}, over the ${settings().maxFileMB} MB limit`), { code: 'limit' });
    return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
  }

  /** The .spectral.yaml (or .yml, .json) of the file's workspace folder, parsed. Errors go to that file's Problems. */
  async rulesetFor(uri) {
    const folder = allowedRoot(uri);
    for (const name of ['.spectral.yaml', '.spectral.yml', '.spectral.json']) {
      const f = vscode.Uri.joinPath(folder, name);
      let st;
      try { st = await vscode.workspace.fs.stat(f); } catch { continue; }
      if (st.size > MB) return null;
      const key = f.toString();
      const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
      const stamp = open ? 'v' + open.version : 'm' + st.mtime;
      const c = this.rulesets.get(key);
      if (c && c.stamp === stamp) return c.ruleset;
      const text = open ? open.getText() : new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(f));
      let ruleset = null;
      try { ruleset = parseRuleset(text, name); } catch (e) { ruleset = { rules: {}, errors: [String(e && e.message || e)] }; }
      this.rulesets.set(key, { stamp, ruleset });
      this.diagnostics.set(f, (ruleset.errors || []).slice(0, 50).map(m => Object.assign(new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1000), String(m), vscode.DiagnosticSeverity.Information), { source: 'OpenAPI' })));
      return ruleset;
    }
    return null;
  }

  /** One build for a command (convert, bundle, compare, mock, code): no preview, no remote refs. */
  async buildOnce(uri, text) {
    const root = allowedRoot(uri);
    return this.builder.run(uri.toString(), text, u => this.readRef(null, u, root), 180000, { lint: false });
  }

  setProblems(key, issues) {
    this.clearProblems(key);
    if (!settings().problems) return;
    const by = new Map();
    for (const i of issues.slice(0, 2000)) {
      if (!by.has(i.uri)) by.set(i.uri, []);
      const sev = i.severity === 'error' ? vscode.DiagnosticSeverity.Error : i.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : i.severity === 'hint' ? vscode.DiagnosticSeverity.Hint : vscode.DiagnosticSeverity.Information;
      const d = new vscode.Diagnostic(new vscode.Range(i.line, i.col || 0, i.line, 10000), i.message, sev);
      d.source = 'OpenAPI';
      if (i.rule) d.code = i.rule;
      by.get(i.uri).push(d);
      if (!this.issueIndex.has(i.uri)) this.issueIndex.set(i.uri, new Map());
      const ix = this.issueIndex.get(i.uri), k = i.line + '|' + (i.rule || '');
      if (!ix.has(k)) ix.set(k, []);
      ix.get(k).push(i);
    }
    for (const [u, list] of by) this.diagnostics.set(vscode.Uri.parse(u), list);
    this.problemFiles.set(key, [...by.keys()]);
  }
  clearProblems(key) {
    for (const u of this.problemFiles.get(key) || []) { this.diagnostics.delete(vscode.Uri.parse(u)); this.issueIndex.delete(u); }
    this.problemFiles.delete(key);
  }
  /** For quick fixes: the lint issue behind a diagnostic. */
  lookupIssue(uriStr, d) {
    const ix = this.issueIndex.get(uriStr);
    if (!ix) return undefined;
    const list = ix.get(d.range.start.line + '|' + (typeof d.code === 'object' && d.code ? d.code.value : d.code || '')) || [];
    return list.find(i => i.message === d.message) || list[0];
  }

  panel(uri, column) {
    return vscode.window.createWebviewPanel(VIEW_TYPE, 'Preview ' + path.posix.basename(uri.path), { viewColumn: column, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true, enableCommandUris: commandUris(SECTION), localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] });
  }

  async open(uri, column) {
    const existing = this.previews.get(uri.toString());
    if (existing) { existing.panel.reveal(column, true); return existing; }
    this.linter.drop(uri.toString());
    const p = new Preview(this, uri, this.panel(uri, column));
    this.previews.set(p.key, p);
    return p;
  }

  revive(panel, uri) {
    if (this.previews.has(uri.toString())) { panel.dispose(); return; }
    this.linter.drop(uri.toString());
    const p = new Preview(this, uri, panel);
    this.previews.set(p.key, p);
  }

  /** A file changed (typed, saved, or changed on disk): rebuild every preview that uses it, and lint it. */
  touched(uriStr, now) {
    for (const p of this.previews.values()) if (p.key === uriStr || p.deps.has(uriStr)) p.schedule(now ? 0 : p.delayFor());
    this.linter.touched(uriStr, now);
  }

  dispose() { for (const p of [...this.previews.values()]) p.panel.dispose(); this.linter.dispose(); this.builder.dispose(); this.diagnostics.dispose(); }
}

/** Lint for spec files that are open in an editor but have no preview: same worker job, Problems panel only. */
class Linter {
  constructor(manager) { this.manager = manager; this.timers = new Map(); this.deps = new Map(); this.busy = new Set(); this.again = new Set(); }
  wanted(doc) {
    const s = settings();
    return s.lint && s.lintWithoutPreview && s.problems && doc && !doc.isClosed && specText(doc) && !this.manager.previews.has(doc.uri.toString()) && ['file', 'untitled', 'vscode-vfs', 'vscode-remote'].includes(doc.uri.scheme);
  }
  /** Lint every visible spec editor (start-up, settings change, a preview closed). */
  refresh() {
    for (const ed of vscode.window.visibleTextEditors) if (this.wanted(ed.document)) this.schedule(ed.document, 50);
    for (const key of [...this.manager.problemFiles.keys()]) if (key.startsWith('lint:')) { const u = key.slice(5); const d = vscode.workspace.textDocuments.find(x => x.uri.toString() === u); if (!d || !this.wanted(d)) this.drop(u); }
  }
  touched(uriStr, now) {
    const docs = vscode.workspace.textDocuments.filter(d => d.uri.toString() === uriStr || (this.deps.get(d.uri.toString()) || new Set()).has(uriStr));
    for (const d of docs) if (this.wanted(d)) this.schedule(d, now ? 0 : null);
  }
  schedule(doc, delay) {
    const k = doc.uri.toString();
    clearTimeout(this.timers.get(k));
    const n = doc.getText().length;
    const d = delay != null ? delay : Math.max(settings().delay, n > 4 * MB ? 1500 : n > MB ? 800 : 300);
    this.timers.set(k, setTimeout(() => this.run(doc).catch(() => {}), d));
  }
  async run(doc) {
    const k = doc.uri.toString();
    if (!this.wanted(doc)) return;
    if (this.busy.has(k)) { this.again.add(k); return; }
    this.busy.add(k);
    try {
      const text = doc.getText();
      if (text.length > settings().maxFileMB * MB) return;
      const root = allowedRoot(doc.uri);
      const r = await this.manager.builder.run(k, text, u => this.manager.readRef(null, u, root), 120000, { lint: true, ruleset: await this.manager.rulesetFor(doc.uri) });
      if (!this.wanted(doc)) return;
      if (!r.ok) { this.manager.setProblems('lint:' + k, [{ severity: 'error', message: r.error.message, uri: k, line: r.error.line, col: r.error.col, rule: 'parse' }]); return; }
      this.deps.set(k, new Set(r.files.map(f => { try { return vscode.Uri.parse(f).toString(); } catch { return f; } })));
      // Issues of other files of a split spec show too: they belong to this spec.
      this.manager.setProblems('lint:' + k, r.issues.filter(i => i.code !== 'remote-blocked'));
      this.lastMs = r.ms;
      if (!this.counted) this.counted = new Set();
      if (!this.counted.has(k) && !r.issues.some(i => i.severity === 'error')) { this.counted.add(k); rating.success(doc.uri); }
    } finally {
      this.busy.delete(k);
      if (this.again.delete(k)) this.schedule(doc, null);
    }
  }
  drop(uriStr) { clearTimeout(this.timers.get(uriStr)); this.timers.delete(uriStr); this.deps.delete(uriStr); this.manager.clearProblems('lint:' + uriStr); }
  dispose() { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); }
}

function specText(doc) {
  if (!doc) return false;
  if (!['yaml', 'json', 'jsonc'].includes(doc.languageId) && !/\.(ya?ml|json)$/i.test(doc.uri.path)) return false;
  return looksLikeSpec(doc.getText());
}

function targetUri(arg) {
  if (arg instanceof vscode.Uri) return arg;
  const ed = vscode.window.activeTextEditor;
  if (ed) return ed.document.uri;
  try {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const u = tab && tab.input && tab.input.uri;
    if (u instanceof vscode.Uri) return u;
  } catch {}
  return null;
}

function updateContext(editor) {
  vscode.commands.executeCommand('setContext', 'openapiViewer.isSpec', !!editor && specText(editor.document));
}

function activate(context) {
  const manager = new Manager(context);
  context.subscriptions.push({ dispose: () => manager.dispose() });
  registerSupport({ vscode, context, prefix: SECTION, selfId: EXT_ID });
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: SECTION, name: 'OpenAPI Editor' });
  const output = vscode.window.createOutputChannel('OpenAPI Editor');
  const pro = createPro({ vscode, context });
  const commands = createCommands({ context, manager, pro, output, targetUri });
  const specDoc = doc => !!doc && doc.uri.scheme !== 'openapi-editor-out' && specText(doc);
  registerLanguage({ vscode, context, isSpecDoc: specDoc });
  registerLintFixes({ vscode, context, lookupIssue: (u, d) => manager.lookupIssue(u, d), selector: [{ language: 'yaml' }, { language: 'json' }, { language: 'jsonc' }] });
  context.subscriptions.push(output);

  // Cursor in a spec -> the preview shows the operation or schema there (debounced; skipped for files over 32 MB).
  let followTimer = null;
  const onCursor = ed => {
    if (!ed || !settings().follow) return;
    const p = manager.previews.get(ed.document.uri.toString());
    if (!p || !p.panel.visible) return;
    const lj = manager.lastJump;
    if (lj && lj.key === p.key && Date.now() - lj.at < 600) return; // the cursor moved because of a click in the preview
    clearTimeout(followTimer);
    followTimer = setTimeout(() => {
      const doc = ed.document;
      if (doc.isClosed) return;
      const text = doc.getText();
      if (text.length > 32 * MB) return;
      const json = /\.json$/i.test(doc.uri.path) || /^\s*\{/.test(text.slice(0, 200));
      let target = null;
      try { target = previewTarget(pathAt(text, doc.offsetAt(ed.selection.active), json), p.lastFamily || '3.0'); } catch { target = null; }
      if (target) p.follow(target);
    }, text0(ed.document) > 4 * MB ? 350 : 150);
  };
  const text0 = d => (manager.previews.get(d.uri.toString()) || {}).lastBytes || 0;

  const openCmd = side => async arg => {
    const uri = targetUri(arg);
    if (!uri) { vscode.window.showInformationMessage('Open an OpenAPI or Swagger file (YAML or JSON) first.'); return; }
    if (!/\.(ya?ml|json)$/i.test(uri.path)) { vscode.window.showInformationMessage(`OpenAPI Viewer previews .yaml, .yml and .json files. ${path.posix.basename(uri.path)} is not one.`); return; }
    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    if (doc && !specText(doc)) {
      const pick = await vscode.window.showWarningMessage(`${path.posix.basename(uri.path)} has no openapi: or swagger: key at the top. Preview it anyway?`, 'Preview');
      if (!pick) return;
    }
    return manager.open(uri, side ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active);
  };
  let ctxTimer = null;
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{yaml,yml,json}');
  const onDisk = u => { const k = u.toString(); if (!vscode.workspace.textDocuments.some(d => d.uri.toString() === k && d.isDirty)) manager.touched(k, false); };
  context.subscriptions.push(
    watcher, watcher.onDidChange(onDisk), watcher.onDidCreate(onDisk), watcher.onDidDelete(onDisk),
    vscode.commands.registerCommand('openapiViewer.showPreviewToSide', openCmd(true)),
    vscode.commands.registerCommand('openapiViewer.showPreview', openCmd(false)),
    vscode.commands.registerCommand('openapiViewer.openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#openapiViewer.start`, false)),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel, state) {
        const u = state && typeof state.uri === 'string' ? state.uri : '';
        if (!u) { panel.dispose(); return; }
        manager.revive(panel, vscode.Uri.parse(u));
      },
    }),
    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.contentChanges.length) manager.touched(e.document.uri.toString(), false);
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.document === e.document && e.document.lineCount < 5000) { clearTimeout(ctxTimer); ctxTimer = setTimeout(() => updateContext(ed), 500); }
    }),
    vscode.workspace.onDidSaveTextDocument(doc => manager.touched(doc.uri.toString(), true)),
    vscode.window.onDidChangeActiveTextEditor(ed => { updateContext(ed); if (ed && manager.linter.wanted(ed.document)) manager.linter.schedule(ed.document, 50); }),
    vscode.window.onDidChangeTextEditorSelection(e => onCursor(e.textEditor)),
    vscode.workspace.onDidCloseTextDocument(doc => manager.linter.drop(doc.uri.toString())),
    vscode.workspace.onDidChangeTextDocument(e => { if (/\.spectral\.(ya?ml|json)$/i.test(e.document.uri.path)) { for (const p of manager.previews.values()) p.schedule(800); manager.linter.refresh(); } }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration(SECTION)) return;
      if (e.affectsConfiguration(SECTION + '.preview.followCursor') && !e.affectsConfiguration(SECTION + '.defaultLayout')) { for (const p of manager.previews.values()) p.post({ type: 'followSetting', on: settings().follow }); }
      else for (const p of manager.previews.values()) p.load();
      manager.linter.refresh();
    }),
  );
  updateContext(vscode.window.activeTextEditor);
  manager.linter.refresh();
  return { _manager: manager, _commands: commands, _pro: pro };
}

function deactivate() {}

module.exports = { activate, deactivate, _test: { privateAddress, inside, relName, hostAllowed } };
