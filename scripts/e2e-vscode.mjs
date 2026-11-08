// Release gate in a real VS Code: installs the .vsix into an isolated profile, opens every sample with the preview
// command, checks the version label, operation counts and problems, drives the page with real mouse and key events
// (layout switch, filter paste, copy, problem click, live edit, save of a referenced file), checks the hostile files
// (no script runs, nothing read outside the workspace, no network request from the webview), times the large specs,
// and writes screenshots and a JSON report.
// usage: node scripts/e2e-vscode.mjs <work> <port> <vsix> <samplesDir> <shotDir> <outJson> <largeDir> [theme]
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [work0, port, vsix, samples0, shotDir, outJson, largeDir, theme] = process.argv.slice(2);
const work = path.resolve(work0);
const R = { theme: theme || 'Default Dark Modern', install: null, steps: [], console: [], network: [], blocked: [], files: {} };
const tag = R.theme.includes('Light') ? 'light' : 'dark';
const ws = path.join(work, 'ws');
fs.rmSync(ws, { recursive: true, force: true });
fs.cpSync(samples0, ws, { recursive: true });
// A secret outside the workspace, and a symlink inside it that points there.
const secret = path.join(work, 'outside-secret.yaml');
fs.writeFileSync(secret, 'type: object\ndescription: SECRET-OUTSIDE-WORKSPACE-7731\n');
fs.symlinkSync(secret, path.join(ws, 'link-out.yaml'));
fs.writeFileSync(path.join(ws, 'hostile-symlink-ref.yaml'), `openapi: 3.0.3\ninfo:\n  title: Symlink escape\n  version: 1.0.0\npaths:\n  /x:\n    get:\n      responses:\n        '200':\n          description: ok\n          content:\n            application/json:\n              schema:\n                $ref: link-out.yaml\n`);
// Real public specs (optional): GATE_CORPUS=<dir>. Top-level files and every openapi.yaml below are opened.
const corpus = [];
if (process.env.GATE_CORPUS) {
  fs.cpSync(process.env.GATE_CORPUS, path.join(ws, 'corpus'), { recursive: true });
  const walk = (d, top) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, false); else if ((top && /\.(ya?ml|json)$/.test(e.name)) || e.name === 'openapi.yaml') corpus.push(path.relative(ws, p)); } };
  walk(path.join(ws, 'corpus'), true);
}
const larges = largeDir ? fs.readdirSync(largeDir).filter(f => /\.(ya?ml|json)$/.test(f)) : [];
for (const f of larges) fs.symlinkSync(path.join(path.resolve(largeDir), f), path.join(ws, f));

fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
R.install = installVsix(work, vsix);
const vs = await launch(work, Number(port), ws, {
  'workbench.colorTheme': R.theme, 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false,
  'window.titleBarStyle': 'custom', 'workbench.editor.enablePreview': false, 'editor.minimap.enabled': false, 'redhat.telemetry.enabled': false,
  'workbench.activityBar.location': 'top', 'breadcrumbs.enabled': false, 'files.autoSave': 'off',
});
const netReq = new Map(); // remote requests not (yet) blocked by the CSP
const LOCAL = /^(vscode-webview|vscode-resource|data:|blob:|about:|https:\/\/[^/]*\.vscode-cdn\.net\/|https:\/\/[^/]*vscode-resource[^/]*\/)/;
vs.s.on(m => {
  if (m.method === 'Target.attachedToTarget') vs.s.send('Network.enable', {}, m.params.sessionId).catch(() => {});
  const info = vs.attached.get(m.sessionId);
  if (!info || info.type !== 'iframe') return;
  if (m.method === 'Network.requestWillBeSent') { const u = m.params.request.url; if (!LOCAL.test(u)) netReq.set(m.params.requestId, u.slice(0, 200)); }
  if (m.method === 'Network.loadingFailed' && m.params.blockedReason) { R.blocked.push(m.params.blockedReason + ' ' + (netReq.get(m.params.requestId) || '')); netReq.delete(m.params.requestId); }
});
const shots = [];
const shot = async name => { const f = path.join(shotDir, `${tag}-${String(shots.length + 1).padStart(2, '0')}-${name}.png`); await vs.shot(f); shots.push(f); return f; };
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const v = await fn(); R.steps.push({ name, ok: v !== false, value: v, ms: Date.now() - t0 }); console.log(v === false ? 'FAIL' : 'PASS', name, JSON.stringify(v).slice(0, 300)); }
  catch (e) { R.steps.push({ name, ok: false, error: String(e.message || e).slice(0, 1500), ms: Date.now() - t0 }); console.log('FAIL', name, String(e.message || e).slice(0, 600)); try { await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); } catch {} }
};
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
let wv;
const E = (expr, w = wv) => vs.wvEval(w, expr);
const probe = async (w = wv) => JSON.parse(await E(`JSON.stringify(window.openapiProbe ? window.openapiProbe() : null)`, w));
const getWv = async title => vs.waitFor(async () => (await vs.webviews()).find(w => w.title === title && w.w > 0), 30000);
const statusLine = () => vs.wbEval(`(() => { const e = [...document.querySelectorAll('.statusbar-item')].find(x => /Ln \\d+, Col \\d+/.test(x.textContent)); return e ? e.textContent.trim() : ''; })()`);
// The Command Palette sometimes does not open while a webview has focus: click the status bar, then try again.
const command = async label => {
  try { await vs.command(label); }
  catch (e) {
    await vs.key('Escape', 'Escape'); await vs.key('Escape', 'Escape');
    const b = JSON.parse(await vs.wbEval(`(() => { const s = document.querySelector('.part.statusbar'); const r = s.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
    await vs.click(b.x, b.y); await sleep(400);
    await vs.command(label);
  }
};
const closeAll = async () => {
  await command('View: Close All Editors'); await sleep(600);
  for (let i = 0; i < 5; i++) {
    const clicked = await vs.wbEval(`(() => { const b = [...document.querySelectorAll('.monaco-dialog-box .monaco-button')].find(x => /Don.t Save/.test(x.textContent)); if (b) { b.click(); return true; } return false; })()`);
    if (!clicked) break;
    await sleep(500);
  }
};
const openEditor = async rel => { vs.open(path.join(ws, rel)); await vs.waitFor(() => vs.wbEval(`(() => { const t = document.querySelector('.tabs-container .tab.active'); return !!t && t.textContent.includes(${JSON.stringify(path.basename(rel))}); })()`), 20000); await sleep(400); };
const wv0 = () => false;
const openPreview = async (rel, { wait = 90000 } = {}) => {
  wv = null;
  const t0 = Date.now();
  await openEditor(rel);
  for (let i = 0; i < 3 && !wv0(); i++) {
    // The editor title button first (what a user clicks), the Command Palette as a fallback.
    const clicked = await vs.wbEval(`(() => { const a = [...document.querySelectorAll('.editor-actions .action-label')].find(x => /Open Preview to the Side/.test(x.getAttribute('aria-label') || x.title || '')); if (a) { a.click(); return true; } return false; })()`);
    if (!clicked || i > 0) await vs.command('OpenAPI Viewer: Open Preview to the Side');
    wv = await vs.waitFor(async () => (await vs.webviews()).find(w => w.title === path.basename(rel) && w.w > 0), 12000);
    if (wv) break;
    await openEditor(rel);
  }
  if (!wv) throw new Error('no webview for ' + rel);
  const p = await vs.waitFor(async () => { const p = await probe(); return p && (p.ready || p.error) ? p : null; }, wait, 100);
  if (!p) throw new Error('not ready: ' + JSON.stringify(await probe()).slice(0, 300));
  return { ms: Date.now() - t0, p };
};
// A real click on the first line of the text editor (VS Code 1.142 uses a native edit context, not a textarea).
const focusEditor = async () => {
  const b = JSON.parse(await vs.wbEval(`(() => { const ed = [...document.querySelectorAll('.editor-group-container .monaco-editor')].find(e => e.getBoundingClientRect().width > 0); const l = ed && ed.querySelector('.view-line'); if (!l) return 'null'; const r = l.getBoundingClientRect(); return JSON.stringify({ x: r.x + 4, y: r.y + r.height / 2 }); })()`));
  if (!b) throw new Error('no text editor');
  await vs.click(b.x, b.y); await sleep(200);
};
const gotoLine = async n => {
  await focusEditor();
  await vs.key('ArrowUp', 'ArrowUp', 4); await sleep(150); // Cmd+Up: start of the file (macOS)
  for (let i = 1; i < n; i++) await vs.key('ArrowDown', 'ArrowDown');
  await vs.key('End', 'End'); await sleep(150);
};
const clip = { get: () => execFileSync('pbpaste', { encoding: 'utf8' }), set: t => execFileSync('pbcopy', { input: t }) };
let savedClip = '';
try { savedClip = clip.get(); } catch {}

await step('install', () => { must(R.install.code === 0, R.install.out); return R.install.out.trim().split('\n').pop(); });

// ---- every sample ----
const SAMPLES = [
  ['petstore-swagger-2.0.yaml', 'Swagger 2.0', 3], ['petstore-expanded-2.0.json', 'Swagger 2.0', 4], ['petstore-3.0.yaml', 'OpenAPI 3.0.0', 3],
  ['uspto-3.0.yaml', 'OpenAPI 3.0.1', 3], ['link-example-3.0.yaml', 'OpenAPI 3.0.0', 6], ['api-with-examples-3.0.yaml', 'OpenAPI 3.0.0', 2],
  ['callback-example-3.0.yaml', 'OpenAPI 3.0.0', 1], ['webhook-example-3.1.yaml', 'OpenAPI 3.1.0', 1], ['museum-3.1.yaml', 'OpenAPI 3.1.0', 4],
  ['split/openapi.yaml', 'OpenAPI 3.0.3', 4],
];
for (const [rel, label, ops] of SAMPLES) {
  await step('open ' + rel, async () => {
    await closeAll();
    const { ms, p } = await openPreview(rel);
    must(!p.error, 'error: ' + p.error);
    must(p.version === label, `version ${p.version} != ${label}`);
    must(p.layout === 'swagger', 'layout ' + p.layout);
    const n = await vs.waitFor(async () => { const q = await probe(); return q.ops >= ops ? q.ops : null; }, 15000, 200);
    must(n === ops, `operations on screen ${n || (await probe()).ops} != ${ops}`);
    const title = await E(`(document.querySelector('#swagger .info .title') || {}).textContent || ''`);
    must(title.length > 0, 'no title');
    await sleep(1200); // Swagger UI resolves $refs after the first paint; resolver errors show up late
    const errs = await E(`[...document.querySelectorAll('#swagger .errors-wrapper .error-wrapper')].map(e => e.textContent.slice(0, 160))`);
    must(errs.length === 0, 'Swagger UI errors: ' + JSON.stringify(errs));
    R.files[rel] = { ms, renderMs: p.lastMs, version: p.version, ops: n, issues: p.issues, title: title.slice(0, 80) };
    await shot(rel.replace(/\W+/g, '_'));
    return R.files[rel];
  });
}

await step('split spec: refs resolved, missing file listed by name', async () => {
  const txt = await E(`window.openapiSpecText()`);
  const spec = JSON.parse(txt);
  const names = Object.keys(spec.components.schemas);
  must(['Error', 'Pet', 'Category', 'Tag'].every(n => names.includes(n)), 'schemas ' + names);
  must(spec.components.schemas.Category.properties.parent.$ref === '#/components/schemas/Category', 'cycle not kept');
  const probs = await E(`window.openapiProblems()`);
  const miss = probs.find(x => x.includes('owner.yaml'));
  must(miss && /file not found: schemas\/owner\.yaml/.test(miss), 'missing-ref problem: ' + JSON.stringify(probs));
  return { schemas: names, problem: miss };
});

await step('problem click goes to the line', async () => {
  const opened = await E(`(() => { const b = document.getElementById('problems'); return !b.classList.contains('hidden'); })()`);
  if (!opened) await vs.wvClick(wv, `document.getElementById('problemsBtn')`);
  await sleep(300);
  await shot('problems-panel');
  await vs.wvClick(wv, `[...document.querySelectorAll('#problemList .pi')].find(li => li.textContent.includes('owner.yaml'))`);
  const s = await vs.waitFor(async () => { const t = await statusLine(); return /Ln 28,/.test(t) ? t : null; }, 8000);
  must(s, 'status line: ' + await statusLine());
  return s;
});

await step('save of a referenced file updates the preview (no reopen)', async () => {
  const tagFile = path.join(ws, 'split/schemas/tag.yaml');
  const before = fs.readFileSync(tagFile, 'utf8');
  const r0 = (await probe()).renders;
  await openEditor('split/schemas/tag.yaml');
  await focusEditor();
  await vs.key('ArrowDown', 'ArrowDown', 4); await sleep(200); // Cmd+Down: the empty last line (macOS)
  await vs.type('  color: { type: string }'); await sleep(300);
  must(await vs.wbEval(`[...document.querySelectorAll('.editor-group-container .view-line')].some(x => x.textContent.replace(/\\u00a0/g, ' ') === '  color: { type: string }')`), 'edit not as expected');
  const t0 = Date.now();
  await vs.key('s', 'KeyS', 4); // Cmd+S
  const ok = await vs.waitFor(async () => { const t = await E(`window.openapiSpecText()`); return t.includes('"color"') ? true : null; }, 15000, 100);
  const ms = Date.now() - t0;
  const saved = fs.readFileSync(tagFile, 'utf8');
  fs.writeFileSync(tagFile, before);
  must(ok, 'spec did not get the new property; file now: ' + saved.slice(0, 200));
  must((await probe()).renders > r0, 'no new render');
  return { msAfterSave: ms };
});

await step('several previews at once', async () => {
  await closeAll();
  await openPreview('petstore-3.0.yaml');
  await openPreview('museum-3.1.yaml');
  const list = (await vs.webviews()).map(w => w.title);
  must(list.includes('petstore-3.0.yaml') && list.includes('museum-3.1.yaml'), 'webviews: ' + list);
  return list;
});

await step('live update while typing (unsaved)', async () => {
  await closeAll();
  await openPreview('museum-3.1.yaml');
  const r0 = (await probe()).renders;
  await gotoLine(3);
  const t0 = Date.now();
  await vs.type(' Live');
  const ok = await vs.waitFor(async () => { const t = await E(`(document.querySelector('#swagger .info .title') || {}).textContent || ''`); return t.includes('Museum Tickets API Live') ? t : null; }, 10000, 50);
  const ms = Date.now() - t0;
  must(ok, 'title not updated');
  const p = await probe();
  await shot('live-edit');
  await command('File: Revert File'); await sleep(800);
  return { msToPreview: ms, renders: p.renders - r0, title: ok };
});

await step('README shot: museum, Swagger UI', async () => {
  await closeAll();
  await command('View: Close Primary Side Bar'); await sleep(300);
  await openPreview('museum-3.1.yaml');
  await vs.wvClick(wv, `[...document.querySelectorAll('#swagger .opblock-summary')].find(e => e.textContent.includes('/tickets') && e.closest('.opblock-post'))`);
  await sleep(800);
  return await shot('readme-swagger');
});

await step('select text and copy it (Cmd+C)', async () => {
  clip.set('before-copy');
  await vs.wvClick(wv, `document.querySelector('#swagger .info .title')`, { dx: 4 });
  await sleep(200);
  await E(`(() => { const t = document.querySelector('#swagger .info .title'); const r = document.createRange(); r.selectNodeContents(t.childNodes[0]); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString(); })()`);
  await vs.key('c', 'KeyC', 4);
  const got = await vs.waitFor(() => { const c = clip.get(); return c !== 'before-copy' ? c : null; }, 4000);
  must(got && got.includes('Museum Tickets API'), 'clipboard: ' + JSON.stringify(got));
  return got.trim();
});

await step('paste into the filter box (Cmd+V) filters operations', async () => {
  clip.set('ticket');
  await vs.wvClick(wv, `document.getElementById('filter')`);
  await vs.key('v', 'KeyV', 4);
  const v = await vs.waitFor(() => E(`document.getElementById('filter').value`), 3000);
  must(v === 'ticket', 'filter value ' + JSON.stringify(v));
  const n = await vs.waitFor(async () => { const q = await probe(); return q.ops > 0 && q.ops < 4 ? q.ops : null; }, 5000);
  must(n, 'ops after filter ' + (await probe()).ops);
  await shot('filter-pasted');
  await E(`(() => { const f = document.getElementById('filter'); f.value = ''; f.dispatchEvent(new Event('input')); return 1; })()`);
  await sleep(400);
  return { value: v, opsShown: n };
});

await step('reference layout: nav, operation page, schema link, filter', async () => {
  await vs.wvClick(wv, `document.getElementById('layReference')`);
  const p = await vs.waitFor(async () => { const q = await probe(); return q.layout === 'reference' && q.refItems ? q : null; }, 8000);
  must(p && p.refItems === 4, 'ref items ' + (p && p.refItems));
  await vs.wvClick(wv, `[...document.querySelectorAll('.rnav .nitem')].find(a => a.textContent.includes('/tickets') && a.textContent.includes('POST'))`);
  await sleep(300);
  const route = await E(`(document.querySelector('.rdoc .route') || {}).textContent`);
  must(route === '/tickets', 'route ' + route);
  const curl = await E(`(document.querySelector('.rside pre') || {}).textContent || ''`);
  must(curl.startsWith('curl -X POST'), 'curl ' + curl.slice(0, 80));
  await shot('readme-reference');
  await vs.wvClick(wv, `[...document.querySelectorAll('.rdoc .stype.reflink')].find(e => e.textContent === 'TicketRequest')`);
  await sleep(300);
  const cur = (await probe()).refCurrent;
  must(cur === 'schema:TicketRequest', 'current ' + cur);
  await vs.wvClick(wv, `document.getElementById('filter')`);
  await vs.type('event');
  await sleep(500);
  const vis = await E(`[...document.querySelectorAll('.rnav .nitem:not(.hidden):not(.over)')].map(a => a.textContent)`);
  must(vis.length >= 1 && vis.every(t => /event/i.test(t)), 'visible ' + JSON.stringify(vis));
  await E(`(() => { const f = document.getElementById('filter'); f.value = ''; f.dispatchEvent(new Event('input')); return 1; })()`);
  await vs.wvClick(wv, `document.getElementById('laySwagger')`);
  await vs.waitFor(async () => (await probe()).layout === 'swagger', 5000);
  return { route, curl: curl.split('\n')[0], visible: vis };
});

await step('support footer and links', async () => {
  await command('View: Toggle Primary Side Bar Visibility'); await sleep(300);
  const f = await E(`(() => { const z = document.querySelector('.zovo-support'); return z ? z.textContent.replace(/\\s+/g, ' ').trim() : ''; })()`);
  must(/Sponsor/.test(f) && /More free viewers/.test(f), 'footer ' + f);
  return f;
});

// ---- real public specs ----
for (const rel of corpus) {
  await step('real spec ' + rel, async () => {
    await closeAll();
    const { ms, p } = await openPreview(rel, { wait: 120000 });
    must(!p.error, 'error: ' + p.error);
    must(/^(OpenAPI|Swagger) \d/.test(p.version), 'version ' + p.version);
    const n = p.layout === 'swagger' ? await vs.waitFor(async () => { const q = await probe(); return q.ops > 0 ? q.ops : null; }, 20000, 200) : p.refItems;
    must(n > 0, 'no operations on screen');
    const errs = await E(`(document.querySelectorAll('#swagger .errors-wrapper .error-wrapper').length)`);
    const probs = await E(`window.openapiProblems()`);
    R.files[rel] = { ms, renderMs: p.lastMs, version: p.version, layout: p.layout, ops: n, swaggerUiErrors: errs, problems: probs.length, errorProblems: probs.filter(x => x.startsWith('error')).slice(0, 5) };
    must(errs === 0, 'Swagger UI shows resolver errors: ' + errs);
    await shot('real-' + rel.replace(/\W+/g, '_').slice(-40));
    return R.files[rel];
  });
}

// ---- hostile ----
await step('hostile: Markdown with script, onerror, javascript: links', async () => {
  await closeAll();
  const { p } = await openPreview('hostile-markdown-xss.yaml');
  must(!p.error, p.error);
  await sleep(2500);
  const check = async () => JSON.parse(await E(`JSON.stringify({ title: document.title, scripts: document.scripts.length, scriptList: [...document.scripts].map(s => (s.nonce ? 'nonce ' : 'NO-NONCE ') + (s.src ? s.src.split('/').pop() : s.textContent.slice(0, 80))), handlers: [...document.querySelectorAll('*')].filter(e => [...e.attributes].some(a => /^on/i.test(a.name))).length, jsLinks: [...document.querySelectorAll('a[href^="javascript"]')].length, iframes: document.querySelectorAll('iframe').length })`));
  const a = await check();
  must(!/PWNED/.test(a.title), 'title ' + a.title);
  // 3 scripts by nonce (ours) plus the acquireVsCodeApi bootstrap that VS Code itself puts into every webview.
  const foreign = l => l.scriptList.filter(x => !x.startsWith('nonce ') && !/^NO-NONCE\s+globalThis\.acquireVsCodeApi/.test(x));
  must(foreign(a).length === 0 && a.handlers === 0 && a.iframes === 0, JSON.stringify(a));
  await shot('hostile-xss-swagger');
  // open the operation so its Markdown renders too
  await vs.wvClick(wv, `document.querySelector('#swagger .opblock-summary')`).catch(() => {});
  await sleep(800);
  await vs.wvClick(wv, `document.getElementById('layReference')`);
  await sleep(500);
  await vs.wvClick(wv, `[...document.querySelectorAll('.rnav .nitem')].find(a => a.textContent.includes('/search'))`);
  await sleep(800);
  const b = await check();
  must(!/PWNED/.test(b.title) && b.handlers === 0 && foreign(b).length === 0 && b.iframes === 0, JSON.stringify(b));
  await shot('hostile-xss-reference');
  await vs.wvClick(wv, `document.getElementById('laySwagger')`);
  return { swagger: a, reference: b };
});

await step('hostile: refs out of the workspace, file:, metadata URL, cycles', async () => {
  await closeAll();
  const { p } = await openPreview('hostile-refs.yaml');
  must(!p.error, p.error);
  const probs = await E(`window.openapiProblems()`);
  const has = re => probs.some(x => re.test(x));
  must(has(/etc\/passwd.*outside the workspace/), 'passwd ' + JSON.stringify(probs));
  must(has(/file:\/\/\/etc\/hosts.*absolute file/), 'file url');
  must(has(/169\.254\.169\.254.*not loaded until you click/), 'metadata');
  must(has(/DoesNotExist.*points to nothing/), 'missing internal');
  must(has(/points to itself/), 'self ref');
  const spec = await E(`window.openapiSpecText()`);
  must(!/root:|nobody:|localhost/.test(spec), 'file content leaked');
  const btn = await E(`!document.getElementById('remoteBtn').classList.contains('hidden')`);
  must(btn, 'no Load remote refs button');
  await shot('hostile-refs');
  await vs.wvClick(wv, `document.getElementById('remoteBtn')`);
  const probs2 = await vs.waitFor(async () => { const q = await E(`window.openapiProblems()`); return q.some(x => /169\.254\.169\.254.*local or private/.test(x)) ? q : null; }, 20000, 200);
  must(probs2, 'after allow: ' + JSON.stringify(await E(`window.openapiProblems()`)));
  return { problems: probs.length, metadataAfterAllow: probs2.find(x => /169\.254/.test(x)), attacker: probs2.find(x => /attacker/.test(x)) };
});

await step('hostile: symlink out of the workspace', async () => {
  await closeAll();
  const { p } = await openPreview('hostile-symlink-ref.yaml');
  must(!p.error, p.error);
  const probs = await E(`window.openapiProblems()`);
  must(probs.some(x => /link-out\.yaml links outside the workspace/.test(x)), JSON.stringify(probs));
  must(!(await E(`window.openapiSpecText()`)).includes('SECRET-OUTSIDE'), 'secret leaked');
  return probs.find(x => /links outside/.test(x));
});

await step('hostile: YAML billion laughs stops with a message', async () => {
  await closeAll();
  const t0 = Date.now();
  const { p } = await openPreview('hostile-billion-laughs.yaml');
  must(p.error && /billion laughs/.test(p.error), 'error ' + p.error);
  const banner = await E(`document.getElementById('banner').textContent`);
  await shot('hostile-billion-laughs');
  return { ms: Date.now() - t0, banner: banner.slice(0, 160) };
});

await step('broken YAML: message with line, click goes there', async () => {
  await closeAll();
  const { p } = await openPreview('broken-syntax.yaml');
  must(p.error, 'no error');
  const banner = await E(`document.getElementById('banner').textContent`);
  must(/line 12/.test(banner), banner);
  await vs.wvClick(wv, `document.querySelector('#banner a')`);
  const s = await vs.waitFor(async () => { const t = await statusLine(); return /Ln 12,/.test(t) ? t : null; }, 8000);
  must(s, 'status ' + await statusLine());
  return { banner: banner.slice(0, 160), status: s };
});

// ---- large ----
for (const f of larges) {
  await step('large: ' + f, async () => {
    await closeAll();
    const size = fs.statSync(path.join(largeDir, f)).size;
    const { ms, p } = await openPreview(f, { wait: 120000 });
    must(!p.error, p.error);
    const out = { MB: +(size / 1048576).toFixed(1), openToRenderMs: ms, renderMs: p.lastMs, layout: p.layout, ops: p.layout === 'swagger' ? p.ops : p.refItems };
    await shot('large-' + f.replace(/\W+/g, '_'));
    // typing in the editor while the preview is open: at the end of the info title, so the YAML stays valid
    const lines = fs.readFileSync(path.join(largeDir, f), 'utf8').slice(0, 4000).split('\n');
    const titleLine = lines.findIndex(l => /^\s+title:/.test(l)) + 1;
    await gotoLine(titleLine);
    const r0 = (await probe()).renders;
    const lat = [];
    const text = ' typing test';
    const lineText = `[...document.querySelectorAll('.editor-group-container .view-line')].map(x => x.textContent.replace(/\\u00a0/g, ' ')).join('\\n')`;
    let typed = '';
    for (const ch of text) {
      typed += ch;
      const t0 = Date.now();
      await vs.s.send('Input.insertText', { text: ch }, vs.wb);
      await vs.waitFor(async () => (await vs.wbEval(lineText)).includes(typed), 3000, 5);
      lat.push(Date.now() - t0);
      await sleep(60);
    }
    await vs.key('Escape', 'Escape');
    const lineOk = await vs.waitFor(async () => (await vs.wbEval(lineText)).includes('typing test'), 3000);
    const rb = await vs.waitFor(async () => { const q = await probe(); return q.renders > r0 ? q : null; }, 30000, 200);
    out.titleLine = titleLine;
    out.keyLatencyMs = { max: Math.max(...lat), median: lat.slice().sort((a, b) => a - b)[lat.length >> 1] };
    out.typedTextVisible = !!lineOk;
    out.rebuilds = rb ? rb.renders - r0 : 0;
    out.rebuildMs = rb ? rb.lastMs : null;
    out.banner = await E(`document.getElementById('banner').classList.contains('hidden') ? '' : document.getElementById('banner').textContent.slice(0, 120)`);
    must(lineOk, 'typed text not visible');
    must(out.rebuilds >= 1 && out.rebuilds <= 2, 'rebuilds ' + out.rebuilds);
    if (p.layout === 'reference') {
      // the user can still ask for Swagger UI
      const t1 = Date.now();
      await vs.wvClick(wv, `document.querySelector('#banner a')`);
      const q = await vs.waitFor(async () => { const q = await probe(); return q.layout === 'swagger' && q.renders > out.rebuilds + r0 ? q : null; }, 120000, 250);
      out.swaggerUiAnywayMs = q ? Date.now() - t1 : null;
      if (q) await shot('large-swagger-' + f.replace(/\W+/g, '_'));
      await vs.wvClick(wv, `document.getElementById('layReference')`).catch(() => {});
    }
    await command('File: Revert File'); await sleep(1000);
    R.files[f] = out;
    return out;
  });
}

await step('no network requests from the webviews', async () => {
  await sleep(500);
  R.network = [...netReq.values()];
  must(R.network.length === 0, 'requests: ' + R.network.slice(0, 10).join(' '));
  must(R.blocked.length === 0, 'requests tried and blocked by the CSP: ' + R.blocked.slice(0, 5).join(' '));
  return { requests: 0, cspBlocked: 0 };
});

R.console = vs.console.filter(c => !/Extension Host|punycode|ResizeObserver|Accessing non-existent property/.test(c.text)).slice(0, 80);
R.shots = shots.map(s => path.basename(s));
R.pass = R.steps.filter(s => s.ok).length; R.total = R.steps.length;
try { clip.set(savedClip); } catch {}
fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
console.log(`RESULT ${R.pass}/${R.total}`);
await vs.close();
process.exit(R.pass === R.total ? 0 : 1);
