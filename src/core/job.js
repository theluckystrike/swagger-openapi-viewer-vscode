'use strict';
// One preview build: parse the root file, bundle its $refs, validate, and map each problem to a file and line.
// Runs in a worker thread (src/core/worker.js) so a 10 MB spec never blocks the extension host; the tests call it
// directly. File access goes through opts.read, which the extension host answers.
const { parseText, versionOf, ParseError, pathKey } = require('./spec');
const { bundle, originOf, baseName } = require('./bundle');
const { validate, stats } = require('./validate');

/**
 * opts: { rootUri, rootText, read: async uri -> { text }, maxNodes?, maxIssues? }
 * returns { ok: true, spec, version, issues, files, unresolved, stats, ms } or { ok: false, error: { message, line, col }, ms }
 */
async function runJob(opts0) {
  const t0 = Date.now();
  // One spelling for every URI (URL rules), so the root file is recognised when another file refers back to it.
  let rootUri = opts0.rootUri;
  try { rootUri = new URL(opts0.rootUri).toString(); } catch { /* keep */ }
  const opts = { ...opts0, rootUri };
  const parsed = new Map();
  let root;
  try { root = parseText(opts.rootText, { path: opts.rootUri }); }
  catch (e) {
    if (e instanceof ParseError) return { ok: false, error: { message: e.message, line: e.line, col: e.col, uri: opts.rootUri }, ms: Date.now() - t0 };
    throw e;
  }
  parsed.set(opts.rootUri, root);
  const version = versionOf(root.data);
  if (!root.data || typeof root.data !== 'object' || Array.isArray(root.data)) {
    return { ok: false, error: { message: 'This file is not an OpenAPI or Swagger document (the top level is not a map).', line: 0, col: 0, uri: opts.rootUri }, ms: Date.now() - t0 };
  }
  const read = async uri => {
    const r = await opts.read(uri);
    // A ref to a Markdown or text file (used for long descriptions) becomes that text.
    if (/\.(md|markdown|txt)$/i.test(uri.split(/[?#]/)[0])) return { data: r.text };
    try {
      const p = parseText(r.text, { path: uri });
      parsed.set(uri, p);
      return { data: p.data };
    } catch (e) {
      if (e instanceof ParseError) throw Object.assign(new Error(`${baseName(uri)} line ${e.line + 1}: ${e.message}`), { code: 'parse' });
      throw e;
    }
  };
  let b;
  try { b = await bundle({ rootUri: opts.rootUri, data: root.data, family: version.family, read, maxNodes: opts.maxNodes }); }
  catch (e) {
    if (e && e.code === 'limit') return { ok: false, error: { message: String(e.message), line: 0, col: 0, uri: opts.rootUri }, ms: Date.now() - t0 };
    throw e;
  }
  const raw = validate(b.spec, version.family, { unresolved: b.unresolved });
  // Map to files and lines. One locate call per file, with all its paths.
  const want = new Map(); // uri -> [path]
  const placed = raw.map((iss, i) => {
    let o;
    if (iss.path) o = originOf(b.origins, opts.rootUri, iss.path);
    else { const u = b.unresolved[i - raw.length + b.unresolved.length] || {}; o = { uri: u.file || opts.rootUri, path: u.path || [] }; }
    if (!want.has(o.uri)) want.set(o.uri, []);
    want.get(o.uri).push(o.path);
    return o;
  });
  const lines = new Map();
  for (const [uri, paths] of want) {
    const p = parsed.get(uri);
    lines.set(uri, p ? p.locate(paths) : new Map());
  }
  const order = { error: 0, warning: 1, info: 2 };
  const issues = raw.map((iss, i) => {
    const o = placed[i];
    const pos = lines.get(o.uri).get(pathKey(o.path)) || { line: 0, col: 0 };
    return { severity: iss.severity, message: iss.message, uri: o.uri, line: pos.line, col: pos.col };
  }).sort((a, z) => order[a.severity] - order[z.severity] || (a.uri === z.uri ? a.line - z.line : a.uri < z.uri ? -1 : 1));
  return {
    ok: true, spec: b.spec, version, issues, files: b.files, unresolved: b.unresolved.map(u => ({ ref: u.ref, file: u.file, reason: u.reason, code: u.code })),
    stats: { ...stats(b.spec), nodes: b.nodes, bytes: opts.rootText.length }, ms: Date.now() - t0,
  };
}

module.exports = { runJob };
