'use strict';
// $ref bundler. Turns a spec split over many files into one document that Swagger UI can show without loading
// anything itself:
// - refs inside the root file ("#/components/...") stay as they are;
// - a ref to another file (or to a part of it) is copied in at its first use, and later refs to the same target
//   point to that copy, so cycles stay cycles and nothing is copied twice;
// - schemas from other files go to components/schemas (definitions in Swagger 2.0), so they show in the model list;
// - a ref that cannot be loaded becomes a small placeholder object and an entry in `unresolved` with the reason.
// Reading files is not done here: opts.read(uri) does it, so the caller decides what may be read (workspace only,
// no remote unless allowed). Pure JS, no VS Code, no network.
const { pointerToPath, pathToPointer, getPath } = require('./spec');

const SCHEMA_PARENT = new Set(['schema', 'items', 'additionalProperties', 'not', 'contains', 'propertyNames', 'if', 'then', 'else', 'unevaluatedItems', 'unevaluatedProperties']);
const SCHEMA_GRANDPARENT = new Set(['properties', 'patternProperties', 'allOf', 'anyOf', 'oneOf', 'prefixItems', 'definitions', '$defs', 'dependentSchemas']);
// Keys whose values are data, not spec: never look for $ref inside them.
const DATA_KEYS = new Set(['example', 'x-example', 'default', 'enum', 'const']);

/** Resolve a ref path against the URI of the file it is in. Returns { uri } or { error }. */
function resolveRef(baseUri, refPath) {
  if (refPath === '') return { uri: baseUri };
  if (/^[a-z][a-z0-9+.-]*:/i.test(refPath) && !/^[a-z]:[\\/]/i.test(refPath)) {
    const scheme = refPath.slice(0, refPath.indexOf(':')).toLowerCase();
    if (scheme === 'http' || scheme === 'https') {
      try { return { uri: new URL(refPath).toString(), remote: true }; } catch { return { error: 'not a valid URL' }; }
    }
    if (scheme === 'file') return { error: 'absolute file: URLs are not followed; use a relative path' };
    return { error: `"${scheme}:" refs are not supported` };
  }
  if (/^([a-z]:)?[\\/]/i.test(refPath)) return { error: 'absolute paths are not followed; use a relative path' };
  try {
    const u = new URL(refPath.replace(/\\/g, '/'), baseUri);
    return { uri: u.toString(), remote: u.protocol === 'http:' || u.protocol === 'https:' };
  } catch { return { error: 'not a valid relative path' }; }
}

function splitRef(ref) {
  const i = ref.indexOf('#');
  return i === -1 ? [ref, ''] : [ref.slice(0, i), ref.slice(i + 1)];
}

const baseName = uri => { const p = decodeURIComponent(String(uri).split(/[?#]/)[0]); return p.slice(p.lastIndexOf('/') + 1); };

/**
 * opts: { rootUri, data (parsed root), family, read: async uri -> { data } | throws Error(reason, {code}),
 *         maxNodes (default 4e6), maxFiles (default 1000) }
 * returns { spec, unresolved: [{ ref, file, path, reason, code }], files: [uri...], origins: [{ out, uri, src }], nodes }
 */
async function bundle(opts) {
  const rootUri = opts.rootUri;
  const maxNodes = opts.maxNodes || 4e6;
  const maxFiles = opts.maxFiles || 1000;
  const schemasPath = opts.family === '2.0' ? ['definitions'] : ['components', 'schemas'];
  const files = new Map(); // uri -> Promise<{ data } | { error, code }>
  const placed = new Map(); // "uri#frag" -> out pointer
  const placedByUri = new Map(); // uri -> [[frag, outPtr]]
  const unresolved = [];
  const origins = [];
  const usedNames = new Set();
  let nodes = 0;
  const root = opts.data;

  const load = uri => {
    if (!files.has(uri)) {
      if (files.size >= maxFiles) return Promise.resolve({ error: `more than ${maxFiles} files are referenced`, code: 'limit' });
      files.set(uri, Promise.resolve().then(() => opts.read(uri)).then(r => ({ data: r.data }), e => ({ error: String(e && e.message || e), code: e && e.code || 'read' })));
    }
    return files.get(uri);
  };

  const place = (key, uri, frag, outPtr) => {
    placed.set(key, outPtr);
    if (!placedByUri.has(uri)) placedByUri.set(uri, []);
    placedByUri.get(uri).push([frag, outPtr]);
  };
  const findPlaced = (uri, frag) => {
    const k = uri + '#' + frag;
    if (placed.has(k)) return placed.get(k);
    for (const [f, out] of placedByUri.get(uri) || []) if (frag.startsWith(f + '/')) return out + frag.slice(f.length);
    return null;
  };

  const placeholder = (ref, reason, siblings) => ({ ...siblings, description: `Unresolved $ref: ${ref} (${reason})`, 'x-unresolved-ref': ref });

  const schemaName = (frag, uri) => {
    const segs = pointerToPath(frag) || [];
    let base = segs.length ? segs[segs.length - 1] : baseName(uri).replace(/\.(ya?ml|json)$/i, '').replace(/^./, c => c.toUpperCase());
    base = base || 'Schema';
    base = String(base).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'Schema';
    const existing = getPath(root, schemasPath);
    let name = base, n = 2;
    while (usedNames.has(name) || (existing && Object.prototype.hasOwnProperty.call(existing, name))) name = base + '_' + n++;
    usedNames.add(name);
    return name;
  };

  const isSchemaSpot = (outPath, frag) => {
    if (/^\/(components\/schemas|definitions)\/[^/]+$/.test(frag)) return true;
    const a = outPath[outPath.length - 1], b = outPath[outPath.length - 2];
    if (SCHEMA_PARENT.has(a)) return true;
    if (b !== undefined && SCHEMA_GRANDPARENT.has(b)) return true;
    return false;
  };

  async function resolveObj(obj, fileUri, outPath, srcPath) {
    const ref = obj.$ref;
    const siblings = {};
    for (const k of Object.keys(obj)) if (k !== '$ref') siblings[k] = obj[k];
    const [refPath, frag0] = splitRef(ref);
    const frag = frag0;
    const fragPath = pointerToPath(frag);
    if (fragPath === null) { unresolved.push({ ref, file: fileUri, path: srcPath, reason: 'the part after # must start with /', code: 'syntax' }); return placeholder(ref, 'bad pointer', siblings); }
    const r = resolveRef(fileUri, refPath);
    if (r.error) { unresolved.push({ ref, file: fileUri, path: srcPath, reason: r.error, code: 'refused' }); return placeholder(ref, r.error, siblings); }
    const target = r.uri;
    if (target === rootUri) return Object.keys(siblings).length ? { $ref: '#' + frag, ...siblings } : { $ref: '#' + frag };
    const key = target + '#' + frag;
    const done = findPlaced(target, frag);
    const fill = reserved.has(key) && done === pathToPointer(outPath);
    if (fill) reserved.delete(key);
    if (done !== null && !fill) {
      if (done === pathToPointer(outPath)) { unresolved.push({ ref, file: fileUri, path: srcPath, reason: 'the $ref points to itself', code: 'cycle' }); return placeholder(ref, 'points to itself', siblings); }
      return Object.keys(siblings).length ? { $ref: '#' + done, ...siblings } : { $ref: '#' + done };
    }
    const f = await load(target);
    if (f.error) { unresolved.push({ ref, file: fileUri, path: srcPath, reason: f.error, code: f.code }); return placeholder(ref, f.error, siblings); }
    const val = getPath(f.data, fragPath);
    if (val === undefined) { unresolved.push({ ref, file: fileUri, path: srcPath, reason: `#${frag} is not in ${baseName(target)}`, code: 'missing' }); return placeholder(ref, 'target not found', siblings); }
    if (isSchemaSpot(outPath, frag) && val && typeof val === 'object' && !Array.isArray(val)) {
      // Hoist: components/schemas/<name>, then point there.
      const name = schemaName(frag, target);
      const hp = [...schemasPath, name];
      place(target + '#' + frag, target, frag, pathToPointer(hp));
      let holder = root;
      for (const seg of schemasPath) { if (!holder[seg] || typeof holder[seg] !== 'object') holder[seg] = {}; holder = holder[seg]; }
      holder[name] = {}; // reserve before walking, so a cycle finds it
      origins.push({ out: pathToPointer(hp), uri: target, src: fragPath });
      holder[name] = await walk(structuredClone(val), target, hp, fragPath);
      const out = { $ref: '#' + pathToPointer(hp) };
      return Object.keys(siblings).length ? { ...out, ...siblings } : out;
    }
    if (!fill) place(key, target, frag, pathToPointer(outPath));
    origins.push({ out: pathToPointer(outPath), uri: target, src: fragPath });
    let copy = val && typeof val === 'object' ? structuredClone(val) : val;
    if (copy && typeof copy === 'object' && !Array.isArray(copy) && Object.keys(siblings).length) copy = { ...copy, ...siblings };
    return walk(copy, target, outPath, fragPath);
  }

  async function walk(v, fileUri, outPath, srcPath) {
    if (v === null || typeof v !== 'object') return v;
    if (++nodes > maxNodes) throw Object.assign(new Error(`the spec has more than ${maxNodes.toLocaleString('en-US')} nodes after $ref resolution`), { code: 'limit' });
    if (!Array.isArray(v) && typeof v.$ref === 'string') return resolveObj(v, fileUri, outPath, srcPath);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const c = v[i];
        if (c !== null && typeof c === 'object') v[i] = await walk(c, fileUri, [...outPath, String(i)], [...srcPath, String(i)]);
      }
      return v;
    }
    for (const k of Object.keys(v)) {
      const c = v[k];
      if (c === null || typeof c !== 'object') continue;
      const parent = outPath[outPath.length - 1];
      // "default" is a response code under responses and a property name under properties: walk those.
      if (DATA_KEYS.has(k) && parent !== 'responses' && parent !== 'properties' && parent !== 'patternProperties') continue;
      if (k === 'value' && outPath[outPath.length - 2] === 'examples') continue;
      v[k] = await walk(c, fileUri, [...outPath, k], [...srcPath, k]);
    }
    return v;
  }

  // A component that is only a $ref to another file ("Error: {$ref: schemas/error.yaml}") keeps its name: other
  // refs to that file point to it instead of making a second copy.
  const reserved = new Set();
  const comp = getPath(root, schemasPath);
  if (comp && typeof comp === 'object' && !Array.isArray(comp)) {
    for (const name of Object.keys(comp)) {
      const c = comp[name];
      if (!c || typeof c !== 'object' || typeof c.$ref !== 'string' || Object.keys(c).length !== 1) continue;
      const [rp, fr] = splitRef(c.$ref);
      const r = resolveRef(rootUri, rp);
      if (r.error || r.uri === rootUri || pointerToPath(fr) === null) continue;
      const key = r.uri + '#' + fr;
      if (placed.has(key)) continue;
      place(key, r.uri, fr, pathToPointer([...schemasPath, name]));
      reserved.add(key);
      usedNames.add(name);
    }
  }
  const spec = await walk(root, rootUri, [], []);
  const fileList = [...files.keys()];
  return { spec, unresolved, files: fileList, origins, nodes };
}

/** Map a path in the bundled spec back to the file and path it came from. */
function originOf(origins, rootUri, outPath) {
  const ptr = pathToPointer(outPath);
  let best = null;
  for (const o of origins) if ((ptr === o.out || ptr.startsWith(o.out + '/')) && (!best || o.out.length > best.out.length)) best = o;
  if (!best) return { uri: rootUri, path: outPath };
  const rest = pointerToPath(ptr.slice(best.out.length)) || [];
  return { uri: best.uri, path: [...best.src, ...rest] };
}

module.exports = { bundle, resolveRef, splitRef, originOf, baseName };
