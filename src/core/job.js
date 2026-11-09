'use strict';
// One preview build: parse the root file, bundle its $refs, validate, and map each problem to a file and line.
// Runs in a worker thread (src/core/worker.js) so a 10 MB spec never blocks the extension host; the tests call it
// directly. File access goes through opts.read, which the extension host answers.
const { parseText, versionOf, ParseError, pathKey } = require('./spec');
const { bundle, originOf, baseName } = require('./bundle');
const { validate, stats, METHODS } = require('./validate');
const { lint } = require('./lint');

/**
 * opts: { rootUri, rootText, read: async uri -> { text }, maxNodes?, maxIssues?, lint? (default true), ruleset? (parseRuleset result) }
 * returns { ok: true, spec, version, issues: [{ severity, message, uri, line, col, rule, data? }], anchors: { ops, hooks, schemas }, files,
 *           unresolved, stats, ms } or { ok: false, error: { message, line, col }, ms }
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
  const ruleset = opts.ruleset || null;
  const lintOn = opts.lint !== false;
  const schemaSev = ruleset && ruleset.rules ? ruleset.rules['oas-schema'] : undefined;
  // validate issues: the unresolved-ref entries come last and have no path.
  const vraw = validate(b.spec, version.family, { unresolved: b.unresolved });
  const raw = [];
  vraw.forEach((iss, i) => {
    const unres = !iss.path;
    const u = unres ? (b.unresolved[i - vraw.length + b.unresolved.length] || {}) : null;
    const o = unres ? { uri: u.file || opts.rootUri, path: u.path || [] } : undefined;
    const rule = iss.rule || (unres ? 'invalid-ref' : 'oas-schema');
    if (iss.rule && lintOn) return; // the lint rule with the same id reports it
    if (rule === 'oas-schema' && schemaSev === 'off') return;
    if (rule !== 'oas-schema' && ruleset && ruleset.rules && ruleset.rules[rule] === 'off') return;
    let severity = iss.severity;
    if (rule === 'oas-schema' && schemaSev && schemaSev !== 'on') severity = schemaSev;
    raw.push({ severity, message: unres ? iss.message + ' (invalid-ref)' : iss.message, path: iss.path, rule, data: unres ? { ref: u.ref } : undefined, origin: o });
  });
  if (lintOn) {
    try { for (const iss of lint(b.spec, version.family, { ruleset, maxIssues: opts.maxIssues || 2000 })) raw.push(iss); }
    catch (e) { raw.push({ severity: 'info', message: 'Lint stopped: ' + String(e && e.message || e).slice(0, 200), path: [], rule: 'oas-schema' }); }
  }
  // Map to files and lines. One locate call per file, with all its paths (problems and anchors).
  const want = new Map(); // uri -> [path]
  const need = (o) => { if (!want.has(o.uri)) want.set(o.uri, []); want.get(o.uri).push(o.path); return o; };
  const placed = raw.map(iss => need(iss.origin || originOf(b.origins, opts.rootUri, iss.path || [])));
  const anchorList = []; // [group, key, origin]
  const MAX_ANCHORS = 20000;
  const methods = METHODS.concat(version.family === '3.2' ? ['query'] : []);
  const addAnchors = (container, base, group) => {
    if (!container || typeof container !== 'object' || Array.isArray(container)) return;
    for (const route of Object.keys(container)) {
      const item = container[route];
      if (!item || typeof item !== 'object') continue;
      for (const m of methods) {
        if (anchorList.length >= MAX_ANCHORS) return;
        if (item[m] && typeof item[m] === 'object') anchorList.push([group, m + ' ' + route, need(originOf(b.origins, opts.rootUri, [base, route, m]))]);
      }
    }
  };
  addAnchors(b.spec.paths, 'paths', 'ops');
  addAnchors(b.spec.webhooks, 'webhooks', 'hooks');
  const sp = version.family === '2.0' ? ['definitions'] : ['components', 'schemas'];
  const schemas = sp.reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), b.spec);
  if (schemas && typeof schemas === 'object' && !Array.isArray(schemas)) {
    for (const name of Object.keys(schemas)) {
      if (anchorList.length >= MAX_ANCHORS) break;
      anchorList.push(['schemas', name, need(originOf(b.origins, opts.rootUri, [...sp, name]))]);
    }
  }
  const lines = new Map();
  for (const [uri, paths] of want) {
    const p = parsed.get(uri);
    lines.set(uri, p ? p.locate(paths) : new Map());
  }
  const order = { error: 0, warning: 1, info: 2, hint: 3 };
  const issues = raw.map((iss, i) => {
    const o = placed[i];
    const pos = lines.get(o.uri).get(pathKey(o.path)) || { line: 0, col: 0 };
    const out = { severity: iss.severity, message: iss.message, uri: o.uri, line: pos.line, col: pos.col, rule: iss.rule || 'oas-schema' };
    if (iss.data) out.data = iss.data;
    return out;
  }).sort((a, z) => order[a.severity] - order[z.severity] || (a.uri === z.uri ? a.line - z.line : a.uri < z.uri ? -1 : 1));
  const anchors = { ops: {}, hooks: {}, schemas: {} };
  for (const [group, key, o] of anchorList) {
    const pos = lines.get(o.uri).get(pathKey(o.path));
    if (pos) anchors[group][key] = { uri: o.uri, line: pos.line };
  }
  return {
    ok: true, spec: b.spec, version, issues, anchors, files: b.files, unresolved: b.unresolved.map(u => ({ ref: u.ref, file: u.file, reason: u.reason, code: u.code })),
    stats: { ...stats(b.spec), nodes: b.nodes, bytes: opts.rootText.length }, ms: Date.now() - t0,
  };
}

module.exports = { runJob };
