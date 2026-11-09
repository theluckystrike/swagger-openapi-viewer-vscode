'use strict';
// Editor features for OpenAPI and Swagger files: outline, key and value completion, $ref completion, go to
// definition and hover on $ref, and rename of a component across files. Reads only workspace files, never the network.
// Big files: YAML over 1 MB is read with a one-pass key scan instead of a full parse, so no provider blocks the editor.
const fs = require('fs');
const path = require('path');
const { pathAt, yamlFind, parseLine, jsonSiblingKeys } = require('./core/cursor');
const { objectTypeAt, fieldsFor, fieldOf, STATUS_CODES, MEDIA_TYPES } = require('./core/schema-keys');
const { outline, refTargets, componentAt, splitRefValue, findRefs, yamlSkeleton } = require('./core/symbols');
const { parseText, versionOf, locateJson, pathToPointer, pathKey } = require('./core/spec');

const MB = 1048576;
const FULL_YAML_MAX = 1 * MB;   // above this, YAML uses the key scan (yamlSkeleton)
const MAX_SCAN_FILES = 2000;
const MAX_OTHER_FILE = 16 * MB; // other files read for $ref targets and rename
const NAME_RE = /^[A-Za-z0-9._-]+$/;
const SELECTOR = [{ language: 'yaml' }, { language: 'json' }, { language: 'jsonc' }];

const isJsonName = p => /\.json$/i.test(String(p || ''));
const docIsJson = doc => doc.languageId === 'json' || doc.languageId === 'jsonc' || isJsonName(doc.uri.path);
const esc = s => String(s).replace(/[\\$}]/g, '\\$&');

/** Family from the first part of the text, without parsing ('3.0' when unknown). */
function familyOf(text) {
  const head = text.length > 65536 ? text.slice(0, 65536) + text.slice(-4096) : text;
  const m = /["']?(openapi|swagger)["']?\s*:\s*["']?(\d+)\.(\d+)/.exec(head);
  if (!m) return '3.0';
  if (m[1] === 'swagger') return '2.0';
  return m[3] === '0' ? '3.0' : m[3] === '1' ? '3.1' : m[3] === '2' ? '3.2' : '3.0';
}

/** Parsed view of a text: { data, locate, family, exact }. data is null when the text cannot be read at all. */
function buildModel(text, isJson, fileName) {
  if (isJson) {
    try {
      const data = JSON.parse(text);
      return { data, locate: paths => locateJson(text, paths), family: versionOf(data).family === 'unknown' ? familyOf(text) : versionOf(data).family, exact: true };
    } catch { return { data: null, locate: () => new Map(), family: familyOf(text), exact: false }; }
  }
  if (text.length <= FULL_YAML_MAX) {
    try {
      const p = parseText(text, { path: fileName || 'x.yaml', json: false });
      if (p.data && typeof p.data === 'object') {
        const fam = versionOf(p.data).family;
        return { data: p.data, locate: p.locate, family: fam === 'unknown' ? familyOf(text) : fam, exact: true };
      }
    } catch { /* typing: fall back to the key scan */ }
  }
  const sk = yamlSkeleton(text, 4);
  return { data: sk.data, locate: sk.locate, family: familyOf(text), exact: false };
}

/** Position of `p` in a text: { line, col, exact }. */
function findIn(text, isJson, p) {
  if (!p.length) return { line: 0, col: 0, exact: true };
  if (isJson) {
    const m = locateJson(text, [p]);
    const hit = m.get(pathKey(p));
    if (!hit) return null;
    // locateJson falls back to a parent: check the exact key is there.
    const all = locateJson(text, [p.slice(0, -1)]).get(pathKey(p.slice(0, -1)));
    return { line: hit.line, col: hit.col, exact: !all || all.line !== hit.line || all.col !== hit.col };
  }
  return yamlFind(text, p);
}

function registerLanguage(opts) {
  const { vscode, context } = opts;
  const isSpecDoc = opts.isSpecDoc || (() => true);
  const maxBytes = opts.maxBytes || 64 * MB;
  const cache = new Map(); // uri -> { version, model }
  let fileList = { at: 0, folder: '', files: [] };

  function model(doc) {
    const k = doc.uri.toString();
    const hit = cache.get(k);
    if (hit && hit.version === doc.version) return hit.model;
    const m = buildModel(doc.getText(), docIsJson(doc), doc.uri.path);
    if (!m.data && hit) return hit.model; // keep the last good one while the user types
    cache.delete(k);
    cache.set(k, { version: doc.version, model: m });
    while (cache.size > 16) cache.delete(cache.keys().next().value);
    return m;
  }

  const small = doc => doc.getText().length <= maxBytes;
  const specOk = doc => small(doc) && isSpecDoc(doc);

  // ---- files ----------------------------------------------------------------------------------------------------
  const dirOf = uri => uri.with({ path: path.posix.dirname(uri.path) });
  function rootOf(uri) {
    const wf = vscode.workspace.getWorkspaceFolder(uri);
    return wf ? wf.uri : dirOf(uri);
  }
  function inside(child, parent) {
    if (child.scheme !== parent.scheme || child.authority !== parent.authority) return false;
    const a = path.posix.normalize(child.path), b = path.posix.normalize(parent.path).replace(/\/$/, '');
    return a === b || a.startsWith(b + '/');
  }
  /** The file a $ref file part points to, or null (remote, other scheme, or outside the workspace). */
  function resolveFile(fromUri, file) {
    if (!file) return fromUri;
    if (/^[a-z][a-z0-9+.-]*:/i.test(file) || file.startsWith('//')) return null; // http, https, urn, ...
    let f = file;
    try { f = decodeURIComponent(file); } catch { /* keep */ }
    const target = fromUri.with({ path: path.posix.normalize(path.posix.join(path.posix.dirname(fromUri.path), f)), query: '', fragment: '' });
    return inside(target, rootOf(fromUri)) ? target : null;
  }
  /** True when a file: URI inside the workspace is a symlink (or under one) that leads out of it. */
  function linksOutside(uri) {
    if (uri.scheme !== 'file') return false;
    try {
      const real = fs.realpathSync.native(uri.fsPath), realRoot = fs.realpathSync.native(rootOf(uri).fsPath);
      return real !== realRoot && !real.startsWith(realRoot + path.sep);
    } catch { return false; }
  }
  async function readText(uri) {
    if (linksOutside(uri)) return null;
    const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    if (open) return open.getText();
    const st = await vscode.workspace.fs.stat(uri);
    if (st.size > MAX_OTHER_FILE) return null;
    return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
  }
  async function specFiles(doc) {
    const root = rootOf(doc.uri);
    const now = Date.now();
    if (fileList.folder === root.toString() && now - fileList.at < 10000) return fileList.files;
    const wf = vscode.workspace.getWorkspaceFolder(doc.uri);
    const pattern = wf ? new vscode.RelativePattern(wf, '**/*.{yaml,yml,json}') : new vscode.RelativePattern(root, '*.{yaml,yml,json}');
    const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', MAX_SCAN_FILES);
    fileList = { at: now, folder: root.toString(), files };
    return files;
  }
  function relPath(fromUri, toUri) {
    let r = path.posix.relative(path.posix.dirname(fromUri.path), toUri.path);
    if (!r.startsWith('../')) r = './' + r;
    return r;
  }

  // ---- $ref under the cursor ------------------------------------------------------------------------------------
  function refAt(doc, pos) {
    const line = doc.lineAt(pos.line).text;
    if (line.indexOf('$ref') < 0) return null;
    for (const r of findRefs(line, docIsJson(doc))) {
      if (pos.character >= r.col && pos.character <= r.col + r.length) return { value: r.value, range: new vscode.Range(pos.line, r.col, pos.line, r.col + r.length), raw: line.slice(r.col, r.col + r.length) };
    }
    return null;
  }

  async function target(doc, value) {
    const { file, pointer } = splitRefValue(value);
    if (pointer === null) return null;
    const uri = resolveFile(doc.uri, file);
    if (!uri) return null;
    const text = uri.toString() === doc.uri.toString() ? doc.getText() : await readText(uri).catch(() => null);
    if (text == null) return null;
    const hit = findIn(text, isJsonName(uri.path), pointer) || { line: 0, col: 0, exact: false };
    return { uri, text, pointer, line: hit.line, col: hit.col, exact: !!hit.exact };
  }

  // ---- outline --------------------------------------------------------------------------------------------------
  const KIND = { module: 'Module', method: 'Method', class: 'Class', field: 'Field', event: 'Event' };
  const symbols = {
    provideDocumentSymbols(doc, token) {
      if (!specOk(doc)) return [];
      const m = model(doc);
      if (!m.data || (token && token.isCancellationRequested)) return [];
      const last = doc.lineCount - 1;
      const conv = n => {
        const line = Math.min(n.line, last);
        const end = Math.max(line, Math.min(n.endLine, last));
        const lt = doc.lineAt(line).text;
        const endLen = doc.lineAt(end).text.length;
        const sel = new vscode.Range(line, Math.min(n.col, lt.length), line, lt.length);
        const s = new vscode.DocumentSymbol(n.name || ' ', n.detail || '', vscode.SymbolKind[KIND[n.kind] || 'Field'], new vscode.Range(line, 0, end, endLen), sel);
        s.children = n.children.map(conv);
        return s;
      };
      return outline(m.data, m.family, m.locate).map(conv);
    },
  };

  // ---- completion -----------------------------------------------------------------------------------------------
  function item(label, kind, insert, doc0, range, sort) {
    const it = new vscode.CompletionItem(label, kind);
    if (insert instanceof vscode.SnippetString || typeof insert === 'string') it.insertText = insert;
    if (doc0) it.documentation = new vscode.MarkdownString(doc0);
    if (range) it.range = range;
    if (sort) it.sortText = sort;
    return it;
  }

  function keySnippet(field, isJson, ind) {
    const k = field.key;
    if (isJson) {
      const kq = '"' + esc(k) + '": ';
      if (field.enum) return new vscode.SnippetString(kq + '"${1|' + field.enum.map(v => esc(v).replace(/[,|]/g, '\\$&')).join(',') + '|}"');
      switch (field.type) {
        case 'object': case 'map': return new vscode.SnippetString(kq + '{$0}');
        case 'array': return new vscode.SnippetString(kq + '[$0]');
        case 'boolean': return new vscode.SnippetString(kq + '${1|true,false|}');
        case 'number': case 'integer': case 'any': return new vscode.SnippetString(kq + '$0');
        default: return new vscode.SnippetString(kq + '"$0"');
      }
    }
    const kq = (/^[A-Za-z_$][\w.$-]*$/.test(k) ? esc(k) : "'" + esc(k) + "'") + ':';
    if (field.enum) return new vscode.SnippetString(kq + ' ${1|' + field.enum.map(v => esc(v).replace(/[,|]/g, '\\$&')).join(',') + '|}');
    switch (field.type) {
      case 'object': case 'map': return new vscode.SnippetString(kq + '\n' + ind + '  $0');
      case 'array': return new vscode.SnippetString(kq + '\n' + ind + '  - $0');
      case 'boolean': return new vscode.SnippetString(kq + ' ${1|true,false|}');
      default: return new vscode.SnippetString(kq + ' $0');
    }
  }

  async function refItems(doc, typed, quoted, range, token) {
    const isJson = docIsJson(doc);
    const wrap = v => (quoted || isJson ? v : "'" + v.replace(/'/g, "''") + "'");
    const out = [];
    const h = typed.indexOf('#');
    if (h < 0 || h === 0) {
      const m = model(doc);
      for (const t of refTargets(m.data, m.family).slice(0, 5000)) {
        const it = item(t.ref, vscode.CompletionItemKind.Reference, wrap(t.ref), `${t.kind}: ${t.name}`, range, '0' + t.ref);
        it.filterText = quoted || isJson ? t.ref : "'" + t.ref;
        out.push(it);
      }
    }
    if (h < 0 && !typed.startsWith('#')) {
      const files = await specFiles(doc);
      for (const f of files) {
        if (token && token.isCancellationRequested) break;
        if (f.toString() === doc.uri.toString()) continue;
        const r = relPath(doc.uri, f);
        const it = item(r, vscode.CompletionItemKind.File, wrap(r), undefined, range, '1' + r);
        it.filterText = quoted || isJson ? r : "'" + r;
        out.push(it);
      }
    }
    if (h > 0) {
      const file = typed.slice(0, h);
      const uri = resolveFile(doc.uri, file);
      if (uri) {
        const text = await readText(uri).catch(() => null);
        if (text != null) {
          const m = buildModel(text, isJsonName(uri.path), uri.path);
          for (const t of refTargets(m.data, m.family).slice(0, 5000)) {
            const v = file + t.ref;
            const it = item(v, vscode.CompletionItemKind.Reference, wrap(v), `${t.kind}: ${t.name}`, range, '0' + v);
            it.filterText = quoted || isJson ? v : "'" + v;
            out.push(it);
          }
        }
      }
    }
    return out;
  }

  const completion = {
    async provideCompletionItems(doc, pos, token) {
      if (!small(doc)) return [];
      const lineText = doc.lineAt(pos.line).text;
      const before = lineText.slice(0, pos.character);
      const isJson = docIsJson(doc);
      // 1. a $ref value
      const rm = isJson ? /"\$ref"\s*:\s*(")([^"]*)$/.exec(before) : /^\s*(?:-\s+)*(["']?)\$ref\1\s*:\s*(["']?)([^"'#\s]*#?[^"']*)$/.exec(before);
      if (rm) {
        const quoted = isJson ? true : !!rm[2];
        const typed = isJson ? rm[2] : rm[3];
        const start = pos.character - typed.length;
        const range = new vscode.Range(pos.line, start, pos.line, pos.character);
        return refItems(doc, typed, quoted, range, token);
      }
      if (!specOk(doc)) return [];
      const text = doc.getText();
      const m = model(doc);
      const fam = m.family;
      // 2. a value after "key:"
      const vm = isJson ? /"([^"\\]+)"\s*:\s*"?([^",{}[\]]*)$/.exec(before) : /^(\s*(?:-\s+)*)(["']?)([^"'#:\s][^"'#:]*?)\2\s*:\s+(\S*)$/.exec(before);
      if (vm) {
        const key = isJson ? vm[1] : vm[3];
        const partial = isJson ? vm[2] : vm[4];
        const keyCol = isJson ? before.lastIndexOf('"' + key + '"') + 1 : vm[1].length + (vm[2] ? 1 : 0);
        const p = pathAt(text, doc.offsetAt(new vscode.Position(pos.line, keyCol)) + 1, isJson);
        const container = p.length && String(p[p.length - 1]) === key ? p.slice(0, -1) : p;
        const type = objectTypeAt(container, fam);
        const field = type && !type.includes(':') ? fieldOf(type, key, fam) : null;
        const values = field && field.enum ? field.enum : field && field.type === 'boolean' ? ['true', 'false'] : null;
        if (!values) return [];
        const range = new vscode.Range(pos.line, pos.character - partial.length, pos.line, pos.character);
        return values.map((v, i) => item(String(v), vscode.CompletionItemKind.EnumMember, isJson && field.type !== 'boolean' && !/"$/.test(before.slice(0, before.length - partial.length)) ? '"' + v + '"' : String(v), field.doc, range, String(i).padStart(3, '0')));
      }
      // 3. a key
      let km, startCol;
      if (isJson) {
        km = /(^|[{,\s])("?)([\w$./{}-]*)$/.exec(before);
        if (!km) return [];
        startCol = before.length - km[3].length - km[2].length;
        const prev = text.slice(Math.max(0, doc.offsetAt(new vscode.Position(pos.line, startCol)) - 2000), doc.offsetAt(new vscode.Position(pos.line, startCol))).replace(/\s+$/, '');
        const pc = prev[prev.length - 1];
        if (pc !== '{' && pc !== ',') return [];
      } else {
        km = /^(\s*(?:-\s+)*)(["']?)([^\s:#'"]*)$/.exec(before);
        if (!km) return [];
        startCol = km[1].length;
      }
      const startOff = doc.offsetAt(new vscode.Position(pos.line, startCol));
      let container = pathAt(text, startOff, isJson);
      if (!isJson) {
        const pl = parseLine(lineText);
        const ke = pl.entries.find(e => e.kind === 'key');
        if (ke && ke.col === startCol && container.length && String(container[container.length - 1]) === ke.key) container = container.slice(0, -1);
      }
      const type = objectTypeAt(container, fam);
      if (!type) return [];
      let end = pos.character;
      if (isJson && lineText[end] === '"' && km[2]) end++;
      const range = new vscode.Range(pos.line, startCol, pos.line, end);
      const ind = ' '.repeat(startCol);
      const out = [];
      if (type === 'responses' || type === 'map:response') {
        STATUS_CODES.forEach(([code, label], i) => {
          if (fam === '2.0' && /XX$/.test(code)) return;
          const snip = isJson ? new vscode.SnippetString(`"${code}": {\n${ind}  "description": "\${1:${label}}"\n${ind}}`) : new vscode.SnippetString(`${code === 'default' ? code : "'" + code + "'"}:\n${ind}  description: \${1:${label}}`);
          out.push(item(code, vscode.CompletionItemKind.Value, snip, label, range, String(i).padStart(3, '0')));
        });
        if (type === 'map:response') return out;
      }
      if (type === 'map:mediaType') {
        MEDIA_TYPES.forEach((mt, i) => {
          const snip = isJson ? new vscode.SnippetString(`"${mt}": {\n${ind}  "schema": {$0}\n${ind}}`) : new vscode.SnippetString(`${mt === '*/*' ? "'*/*'" : mt}:\n${ind}  schema:\n${ind}    $0`);
          out.push(item(mt, vscode.CompletionItemKind.Value, snip, 'Media type', range, String(i).padStart(3, '0')));
        });
        return out;
      }
      if (type.includes(':')) return out;
      let existing = null;
      try {
        let v = m.data;
        for (const s of container) v = v == null ? undefined : v[s];
        if (v && typeof v === 'object' && !Array.isArray(v)) existing = new Set(Object.keys(v));
      } catch { existing = null; }
      if (!existing && isJson) existing = jsonSiblingKeys(text, startOff);
      for (const fld of fieldsFor(type, fam)) {
        if (existing && existing.has(fld.key)) continue;
        const it = item(fld.key, vscode.CompletionItemKind.Property, keySnippet(fld, isJson, ind), fld.doc + (fld.enum ? '\n\nValues: ' + fld.enum.join(', ') : ''), range, (fld.key === '$ref' ? '9' : '1') + fld.key);
        it.detail = type;
        if (isJson) it.filterText = (km[2] || '') + fld.key;
        out.push(it);
      }
      return out;
    },
  };

  // ---- definition and hover -------------------------------------------------------------------------------------
  const definition = {
    async provideDefinition(doc, pos) {
      if (!small(doc)) return null;
      const r = refAt(doc, pos);
      if (!r) return null;
      const t = await target(doc, r.value);
      if (!t) return null;
      return new vscode.Location(t.uri, new vscode.Position(t.line, t.col));
    },
  };

  const hover = {
    async provideHover(doc, pos) {
      if (!small(doc)) return null;
      const r = refAt(doc, pos);
      if (!r) return null;
      const { file } = splitRefValue(r.value);
      if (file && (/^[a-z][a-z0-9+.-]*:/i.test(file) || file.startsWith('//'))) return new vscode.Hover(new vscode.MarkdownString('Remote reference. It is not read by the editor features.'), r.range);
      const t = await target(doc, r.value);
      if (!t) return new vscode.Hover(new vscode.MarkdownString('This reference points outside the workspace, so it is not read.'), r.range);
      if (!t.exact) return new vscode.Hover(new vscode.MarkdownString('Not found: ' + r.value.replace(/[\\`*_[\]<>]/g, '\\$&')), r.range);
      const lines = t.text.split('\n', t.line + 16).slice(t.line, t.line + 15);
      const md = new vscode.MarkdownString();
      md.appendMarkdown((t.uri.toString() === doc.uri.toString() ? 'This file' : relPath(doc.uri, t.uri).replace(/[\\`*_[\]<>]/g, '\\$&')) + ', line ' + (t.line + 1) + '\n');
      md.appendCodeblock(lines.join('\n').slice(0, 3000), isJsonName(t.uri.path) ? 'json' : 'yaml');
      return new vscode.Hover(md, r.range);
    },
  };

  // ---- rename ---------------------------------------------------------------------------------------------------
  const NOT_HERE = 'Put the cursor on a component name (for example a schema under components/schemas) or on a $ref to it.';
  function renameTarget(doc, pos) {
    const r = refAt(doc, pos);
    if (r) {
      const { pointer } = splitRefValue(r.value);
      const comp = pointer && (componentAt(pointer, '3.0') || componentAt(pointer, '2.0'));
      if (!comp) return null;
      const slash = r.raw.lastIndexOf('/');
      return { fromRef: r, comp, range: new vscode.Range(pos.line, r.range.start.character + slash + 1, pos.line, r.range.end.character) };
    }
    const lineText = doc.lineAt(pos.line).text;
    const isJson = docIsJson(doc);
    const text = doc.getText();
    const p = pathAt(text, doc.offsetAt(pos), isJson);
    const comp = componentAt(p, familyOf(text));
    if (!comp) return null;
    // The cursor must be on the key itself.
    let a, b;
    if (isJson) {
      const re = /"((?:[^"\\]|\\.)*)"\s*:/g;
      let mm;
      while ((mm = re.exec(lineText))) { if (pos.character >= mm.index && pos.character <= mm.index + mm[1].length + 2) { a = mm.index + 1; b = a + mm[1].length; break; } }
    } else {
      const pl = parseLine(lineText);
      const ke = pl.entries.find(e => e.kind === 'key');
      if (ke && pos.character >= ke.col && pos.character <= ke.end) {
        const raw = ke.raw;
        a = ke.col + (raw[0] === '"' || raw[0] === "'" ? 1 : 0);
        b = a + (raw[0] === '"' || raw[0] === "'" ? raw.length - 2 : raw.length);
      }
    }
    if (a === undefined || lineText.slice(a, b) !== comp.name) return null;
    return { comp, range: new vscode.Range(pos.line, a, pos.line, b) };
  }

  const rename = {
    prepareRename(doc, pos) {
      if (!small(doc)) throw new Error('This file is too large for rename.');
      const t = renameTarget(doc, pos);
      if (!t) throw new Error(NOT_HERE);
      return { range: t.range, placeholder: t.comp.name };
    },
    async provideRenameEdits(doc, pos, newName, token) {
      const t = renameTarget(doc, pos);
      if (!t) throw new Error(NOT_HERE);
      if (!NAME_RE.test(newName)) throw new Error('A component name may use only letters, digits, ".", "-" and "_".');
      const { comp } = t;
      if (newName === comp.name) return new vscode.WorkspaceEdit();
      let defUri = doc.uri;
      if (t.fromRef) {
        defUri = resolveFile(doc.uri, splitRefValue(t.fromRef.value).file);
        if (!defUri) throw new Error('The component is in a file outside the workspace, so it was not renamed.');
      }
      const defText = defUri.toString() === doc.uri.toString() ? doc.getText() : await readText(defUri).catch(() => null);
      if (defText == null) throw new Error('Could not read the file that defines ' + comp.name + '.');
      const defJson = isJsonName(defUri.path) || (defUri.toString() === doc.uri.toString() && docIsJson(doc));
      const oldPath = comp.kindPath.concat(comp.name);
      const newPath = comp.kindPath.concat(newName);
      const defHit = findIn(defText, defJson, oldPath);
      if (!defHit || !defHit.exact) throw new Error(`${comp.name} is not defined in ${path.posix.basename(defUri.path)}.`);
      const clash = findIn(defText, defJson, newPath);
      if (clash && clash.exact) throw new Error(`${newName} already exists in ${comp.kindPath.join('/')}.`);
      const edit = new vscode.WorkspaceEdit();
      const defLine = defText.split('\n', defHit.line + 1)[defHit.line] || '';
      const q = defLine[defHit.col] === '"' || defLine[defHit.col] === "'" ? 1 : 0;
      if (defLine.slice(defHit.col + q, defHit.col + q + comp.name.length) !== comp.name) throw new Error(`Could not find the key ${comp.name} in ${path.posix.basename(defUri.path)}.`);
      edit.replace(defUri, new vscode.Range(defHit.line, defHit.col + q, defHit.line, defHit.col + q + comp.name.length), newName);
      // Every $ref to it, in every YAML and JSON file of the workspace (or the file's folder).
      const files = await specFiles(doc);
      const seen = new Set();
      const list = [doc.uri, defUri, ...files];
      const wantKey = pathKey(oldPath);
      for (const f of list) {
        if (token && token.isCancellationRequested) return undefined;
        const k = f.toString();
        if (seen.has(k)) continue;
        seen.add(k);
        let text;
        try { text = k === doc.uri.toString() ? doc.getText() : await readText(f); } catch { continue; }
        if (text == null || text.indexOf('$ref') < 0 || text.indexOf(comp.name) < 0) continue;
        const matches = findRefs(text, isJsonName(f.path) || (k === doc.uri.toString() && docIsJson(doc)), v => {
          const s = splitRefValue(v);
          if (!s.pointer || pathKey(s.pointer) !== wantKey) return false;
          const to = resolveFile(f, s.file);
          return !!to && to.toString() === defUri.toString();
        });
        for (const r of matches) {
          const raw = text.slice(r.offset, r.offset + r.length);
          const slash = raw.lastIndexOf('/');
          edit.replace(f, new vscode.Range(r.line, r.col + slash + 1, r.line, r.col + r.length), newName);
        }
      }
      return edit;
    },
  };

  const subs = [
    vscode.languages.registerDocumentSymbolProvider(SELECTOR, symbols, { label: 'OpenAPI' }),
    vscode.languages.registerCompletionItemProvider(SELECTOR, completion, ':', ' ', '"', '#', '/', "'"),
    vscode.languages.registerDefinitionProvider(SELECTOR, definition),
    vscode.languages.registerHoverProvider(SELECTOR, hover),
    vscode.languages.registerRenameProvider(SELECTOR, rename),
    vscode.workspace.onDidCloseTextDocument(d => cache.delete(d.uri.toString())),
  ];
  if (context && context.subscriptions) context.subscriptions.push(...subs);
  return { dispose() { subs.forEach(s => s.dispose()); }, _providers: { symbols, completion, definition, hover, rename }, _model: model };
}

module.exports = { registerLanguage, buildModel, familyOf, findIn };
