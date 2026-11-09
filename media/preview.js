// Preview page: toolbar, Swagger UI or reference layout, problem list. Talks to the extension host only through
// postMessage. Swagger UI gets the bundled spec as an object; it has no URL to load and connect-src is 'none'.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const post = m => vscode.postMessage(m);
  let st = vscode.getState() || {};
  let layout = null; // 'swagger' | 'reference'
  let wanted = 'auto';
  let last = null; // last 'spec' message
  let ui = null; let uiSpecTitle = null;
  let ref = null;
  let tryItOut = false; let docExpansion = 'list';
  let filterText = st.filter || '';
  let expanded = false;
  let follow = st.follow !== false;
  let probe = { ready: false, renders: 0, lastMs: 0, layout: '', error: null, issues: 0, version: '' };
  window.openapiSpecText = () => (last ? JSON.stringify(last.spec) : '');
  window.openapiProblems = () => (last ? last.issues.map(i => i.severity + ' ' + i.file + ':' + (i.line + 1) + ' ' + i.message) : []);
  window.openapiProbe = () => Object.assign({}, probe, { layout, filter: filterText, ops: document.querySelectorAll('#swagger .opblock').length, refItems: ref ? ref.items() : 0, refCurrent: ref ? ref.current() : null });

  // ---- "Try it out" bridge: Swagger UI calls fetch(); the extension host sends the request after a confirm. ----
  const pendingHttp = new Map(); let httpSeq = 0;
  window.fetch = function (input, init) {
    init = init || {};
    const url = typeof input === 'string' ? input : input && input.url;
    if (/^https:\/\/localhost\/[^/]*$/.test(String(url)) && last && String(url).endsWith(encodeURIComponent(last.fileName || ''))) return Promise.reject(new TypeError('not loaded'));
    if (!tryItOut) return Promise.reject(new TypeError('OpenAPI Viewer does not use the network. Turn on openapiViewer.tryItOut to send requests.'));
    const headers = {};
    const h = init.headers;
    if (h && typeof h.forEach === 'function' && !(h instanceof Array)) h.forEach((v, k) => { headers[k] = String(v); });
    else if (h && typeof h === 'object') for (const k of Object.keys(h)) headers[k] = String(h[k]);
    let body = init.body;
    if (body instanceof URLSearchParams) body = body.toString();
    else if (body != null && typeof body !== 'string') return Promise.reject(new TypeError('This request body type (file upload or multipart) is not sent from the preview.'));
    const id = ++httpSeq;
    return new Promise((resolve, reject) => {
      pendingHttp.set(id, { resolve, reject });
      post({ type: 'http', id, url: String(url), method: init.method || 'GET', headers, body });
    });
  };
  function onHttp(m) {
    const p = pendingHttp.get(m.id);
    if (!p) return;
    pendingHttp.delete(m.id);
    if (m.error) { p.reject(new TypeError(m.error)); return; }
    const status = m.status >= 200 && m.status <= 599 ? m.status : 500;
    const res = new Response([101, 204, 205, 304].includes(status) ? null : m.body, { status, statusText: m.statusText || '', headers: m.headers || {} });
    try { Object.defineProperty(res, 'url', { value: m.url || '' }); } catch (e) { /* ignore */ }
    p.resolve(res);
  }

  // ---- helpers ----
  const status = t => { $('status').textContent = t; };
  function setBanner(html) {
    const b = $('banner');
    b.textContent = '';
    if (!html) { b.classList.add('hidden'); return; }
    b.append(html); b.classList.remove('hidden');
  }
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) { const v = attrs[k]; if (v == null) continue; if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  }
  const isDark = () => document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast') && !document.body.classList.contains('vscode-high-contrast-light');
  const saveState = () => { st = Object.assign({}, st, { filter: filterText, layout, selected: ref ? ref.current() : st.selected }); vscode.setState(st); };

  // ---- layout switch ----
  function pickLayout() { return wanted === 'swagger' || wanted === 'reference' ? wanted : (last && last.big ? 'reference' : 'swagger'); }
  function setLayout(l, user) {
    if (user) { wanted = l; post({ type: 'layout', layout: l }); }
    if (l === layout && (l === 'reference' ? ref : ui)) return;
    layout = l;
    $('laySwagger').setAttribute('aria-checked', String(l === 'swagger'));
    $('layReference').setAttribute('aria-checked', String(l === 'reference'));
    $('swagger').classList.toggle('hidden', l !== 'swagger');
    $('reference').classList.toggle('hidden', l !== 'reference');
    saveState();
    if (last) draw();
  }

  // ---- Swagger UI ----
  const matches = (q, ...parts) => parts.some(p => p != null && String(p).toLowerCase().includes(q));
  const FilterPlugin = function () {
    return { fn: { opsFilter: (taggedOps, phrase) => {
      const q = String(phrase || '').trim().toLowerCase();
      if (!q) return taggedOps;
      return taggedOps.map((tagObj, tag) => {
        if (matches(q, tag)) return tagObj;
        return tagObj.set('operations', tagObj.get('operations').filter(op => {
          const o = op.get('operation');
          return matches(q, op.get('path'), op.get('method'), o && o.get('summary'), o && o.get('operationId'), o && o.get('description'));
        }));
      }).filter(t => t.get('operations').size > 0);
    } } };
  };
  // Remote images in Markdown would be blocked by the CSP anyway; replace them with text so nothing even tries.
  const REMOTE_IMG_MD = /!\[([^\]]*)\]\(\s*<?(?:https?:)?\/\/[^)]*\)/gi;
  const REMOTE_IMG_HTML = /<img\b[^>]*\bsrc\s*=\s*["']?\s*(?:https?:)?\/\/[^>]*>/gi;
  const stripImages = src => typeof src === 'string' ? src.replace(REMOTE_IMG_MD, (m, alt) => '[image' + (alt ? ': ' + alt : '') + ']').replace(REMOTE_IMG_HTML, '[image]') : src;
  const NoRemoteImages = function () {
    const wrap = (Orig, system) => props => system.React.createElement(Orig, Object.assign({}, props, { source: stripImages(props.source) }));
    return { wrapComponents: { Markdown: wrap } };
  };
  function drawSwagger(spec) {
    const t0 = performance.now();
    const title = spec && spec.info && spec.info.title;
    const big = last.big;
    const SUI = window.SwaggerUIBundle;
    if (!SUI) { probe.error = 'Swagger UI did not load'; status('Swagger UI did not load'); return; }
    const methods = tryItOut ? ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] : [];
    if (!ui) {
      // No spec and no url here: Swagger UI would resolve $refs against document.baseURI, the long webview URL,
      // and OpenAPI 3.1 refs then fail ("Evaluation failed on URI"). The spec is set below, with a short base URL.
      ui = SUI({
        domNode: $('swagger'), deepLinking: false, layout: 'BaseLayout', presets: [SUI.presets.apis], plugins: [FilterPlugin, NoRemoteImages],
        docExpansion: big ? 'none' : docExpansion, defaultModelsExpandDepth: big ? -1 : 1, defaultModelExpandDepth: 1,
        filter: filterText || true, supportedSubmitMethods: methods, tryItOutEnabled: false, validatorUrl: null,
        displayOperationId: true, displayRequestDuration: true, showExtensions: true, showCommonExtensions: true, queryConfigEnabled: false,
        syntaxHighlight: big ? false : { activated: true, theme: isDark() ? 'monokai' : 'agate' },
        requestSnippetsEnabled: true, persistAuthorization: false, withCredentials: false,
      });
    }
    ui.specActions.updateUrl('https://localhost/' + encodeURIComponent(last.fileName || 'openapi.yaml'));
    ui.specActions.updateLoadingStatus('success');
    // Swagger UI 5 knows OpenAPI 3.0 and 3.1. A 3.2 file is shown as 3.1 there (the toolbar keeps the real version).
    const shown = last.version && last.version.family === '3.2' ? Object.assign({}, spec, { openapi: '3.1.1' }) : spec;
    if (shown !== spec) setBanner(el('span', { text: 'Swagger UI does not know OpenAPI 3.2 yet, so it shows this file as 3.1. New 3.2 fields may be missing there; the reference layout shows them.' }));
    ui.specActions.updateSpec(JSON.stringify(shown));
    uiSpecTitle = title;
    waitFor(() => { const t = document.querySelector('#swagger .information-container .title, #swagger .info .title'); return t && (!title || t.textContent.includes(String(title).slice(0, 40))) ? t : null; }, 60000).then(ok => {
      const ms = Math.round(performance.now() - t0);
      rendered(!!ok, ms);
    });
  }
  function waitFor(fn, ms) {
    return new Promise(resolve => {
      const t0 = Date.now();
      const tick = () => { let v = null; try { v = fn(); } catch (e) { /* keep */ } if (v) resolve(v); else if (Date.now() - t0 > ms) resolve(null); else setTimeout(tick, 40); };
      tick();
    });
  }
  function swaggerFilter(q) { if (ui && ui.layoutActions) ui.layoutActions.updateFilter(q || ''); }
  function swaggerExpand(v) {
    if (!ui) return;
    try {
      const tags = ui.specSelectors.taggedOperations().keySeq().toArray();
      for (const t of tags) ui.layoutActions.show(['operations-tag', t], v);
    } catch (e) { /* ignore */ }
  }

  // ---- reference layout ----
  const ctx = {
    openLink: url => post({ type: 'openLink', url: String(url) }),
    copy: text => post({ type: 'copyText', text: String(text) }),
    onSelect: (id, quiet) => { st.selected = id; saveState(); if (!quiet && follow) jumpTo(id); },
    snippet: (apiPath, method) => post({ type: 'snippet', apiPath, method }),
  };
  function drawReference(spec) {
    const t0 = performance.now();
    ctx.selected = ref ? ref.current() : st.selected;
    ref = window.OAVReference.render($('reference'), spec, ctx);
    if (filterText) ref.filter(filterText);
    rendered(true, Math.round(performance.now() - t0));
  }

  function rendered(ok, ms) {
    probe.ready = true; probe.renders++; probe.lastMs = ms; probe.layout = layout;
    $('empty').classList.add('hidden');
    const s = last.stats || {};
    status(`${s.operations || 0} operations · ${s.schemas || 0} schemas${last.files ? ` · ${last.files + 1} files` : ''} · ${ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s'}`);
    post({ type: 'rendered', ok, ms, layout });
  }

  function draw() {
    if (!last) return;
    const spec = last.spec;
    if (layout === 'swagger') drawSwagger(spec);
    else drawReference(spec);
  }

  // ---- editor sync: cursor -> preview ('follow' from the host), click -> cursor ('jump' to the host) ----
  function idOf(t) {
    if (!t) return null;
    if ((t.kind === 'operation' || t.kind === 'webhook') && !t.method) {
      // Cursor on the path line itself: the first operation of that path.
      const item = last && (t.kind === 'operation' ? last.spec.paths : last.spec.webhooks);
      const pi = item && item[t.kind === 'operation' ? t.apiPath : t.name];
      const m = pi && ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'].find(k => pi[k]);
      if (!m) return null;
      t = Object.assign({}, t, { method: m });
    }
    if (t.kind === 'operation') return 'path:' + t.method + ':' + t.apiPath;
    if (t.kind === 'webhook') return 'webhook:' + t.method + ':' + t.name;
    if (t.kind === 'schema') return 'schema:' + t.name;
    if (t.kind === 'info') return 'overview';
    return null;
  }
  function jumpTo(id) {
    const m = /^(path|webhook):([a-z]+):(.*)$/.exec(id);
    if (m) post({ type: 'jump', kind: m[1] === 'path' ? 'operation' : 'webhook', method: m[2], apiPath: m[3], name: m[3] });
    else if (id.startsWith('schema:')) post({ type: 'jump', kind: 'schema', name: id.slice(7) });
  }
  function flash(node) {
    if (!node) return;
    node.scrollIntoView({ block: 'start', behavior: 'auto' });
    node.classList.remove('follow-hit'); void node.offsetWidth; node.classList.add('follow-hit');
    setTimeout(() => node.classList.remove('follow-hit'), 1400);
  }
  function opNode(method, apiPath) {
    for (const n of document.querySelectorAll('#swagger .opblock' + (method ? '.opblock-' + method : '') + ' .opblock-summary-path')) {
      if (n.getAttribute('data-path') === apiPath) return n.closest('.opblock');
    }
    return null;
  }
  function followSwagger(t) {
    if (!ui || !last) return;
    if (t.kind === 'operation') {
      let node = opNode(t.method, t.apiPath);
      if (node) return flash(node);
      const item = last.spec.paths && last.spec.paths[t.apiPath];
      const op = item && (t.method ? item[t.method] : ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'].map(k => item[k]).find(Boolean));
      if (!op) return;
      const tag = Array.isArray(op.tags) && op.tags.length ? String(op.tags[0]) : 'default';
      try { ui.layoutActions.show(['operations-tag', tag], true); } catch (e) { /* ignore */ }
      waitFor(() => opNode(t.method, t.apiPath), 1500).then(flash);
    } else if (t.kind === 'schema') {
      const find = () => document.getElementById('model-' + t.name);
      if (find()) return flash(find());
      try { ui.layoutActions.show('models', true); } catch (e) { /* ignore */ }
      waitFor(find, 1500).then(flash);
    } else if (t.kind === 'info') {
      flash(document.querySelector('#swagger .information-container'));
    }
  }
  function onFollow(t) {
    probe.follow = t;
    if (!follow || !t || !last) return;
    if (layout === 'reference' && ref) { const id = idOf(t); if (id) ref.show(id); }
    else if (layout === 'swagger') followSwagger(t);
  }
  function setFollow(v, user) {
    follow = !!v; st.follow = follow; saveState();
    const b = $('followBtn');
    if (b) { b.setAttribute('aria-pressed', String(follow)); b.classList.toggle('on', follow); }
    if (user) post({ type: 'follow', on: follow });
  }
  // A click on an operation or a schema in Swagger UI moves the editor cursor to it (capture: runs before React).
  document.addEventListener('click', e => {
    if (!follow || !e.target.closest) return;
    const sum = e.target.closest('#swagger .opblock-summary');
    if (sum) {
      const pathEl = sum.querySelector('.opblock-summary-path');
      const blk = sum.closest('.opblock');
      const m = blk && /\bopblock-(get|put|post|delete|options|head|patch|trace)\b/.exec(blk.className);
      if (pathEl && m) post({ type: 'jump', kind: 'operation', method: m[1], apiPath: pathEl.getAttribute('data-path') || pathEl.textContent.trim() });
      return;
    }
    const model = e.target.closest('#swagger .model-container[id^="model-"]');
    if (model && e.target.closest('.model-box-control, .model-title, .model-toggle')) post({ type: 'jump', kind: 'schema', name: model.id.slice(6) });
  }, true);

  // ---- problems ----
  function drawProblems() {
    if (!last) return;
    const list = $('problemList');
    list.textContent = '';
    const showW = $('showWarnings').checked, showI = $('showInfo').checked;
    const counts = { error: 0, warning: 0, info: 0 };
    for (const i of last.issues) counts[i.severity] = (counts[i.severity] || 0) + 1;
    const shown = last.issues.filter(i => i.severity === 'error' || (i.severity === 'warning' && showW) || (i.severity === 'info' && showI));
    for (const i of shown.slice(0, 1000)) {
      const li = el('li', { class: 'pi ' + i.severity, tabindex: '0', title: 'Go to ' + i.file + ':' + (i.line + 1) },
        el('span', { class: 'sev', text: i.severity === 'error' ? 'E' : i.severity === 'warning' ? 'W' : 'i' }),
        el('span', { class: 'pmsg', text: i.message }),
        el('span', { class: 'ploc', text: i.file + ':' + (i.line + 1) }));
      const go = () => post({ type: 'reveal', uri: i.uri, line: i.line, col: i.col });
      li.addEventListener('click', go);
      li.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
      list.append(li);
    }
    if (!shown.length) list.append(el('li', { class: 'pi none', text: last.issues.length ? 'Only hidden kinds of problems.' : 'No problems found.' }));
    const more = (last.issueTotal || 0) - last.issues.length;
    if (more > 0) list.append(el('li', { class: 'pi none', text: `${more} more not shown.` }));
    $('problemsTitle').textContent = `Problems: ${counts.error} errors, ${counts.warning} warnings`;
    const btn = $('problemsBtn');
    btn.textContent = counts.error || counts.warning ? `Problems ${counts.error ? '✕ ' + counts.error : ''}${counts.error && counts.warning ? ' ' : ''}${counts.warning ? '⚠ ' + counts.warning : ''}` : 'Problems 0';
    btn.classList.toggle('has-errors', counts.error > 0);
    probe.issues = last.issues.length; probe.counts = counts;
  }
  function toggleProblems(v) {
    const p = $('problems');
    const show = v == null ? p.classList.contains('hidden') : v;
    p.classList.toggle('hidden', !show);
    $('problemsBtn').setAttribute('aria-pressed', String(show));
    st.problems = show; saveState();
  }

  // ---- messages ----
  window.addEventListener('message', ev => {
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'init':
        tryItOut = !!m.tryItOut; docExpansion = m.docExpansion || 'list'; wanted = m.layout || 'auto';
        st.uri = m.uri; vscode.setState(st);
        if (typeof m.follow === 'boolean' && st.follow == null) setFollow(m.follow, false); else setFollow(follow, false);
        if (st.problems) toggleProblems(true);
        break;
      case 'busy': status(m.bytes > 1048576 ? `Reading ${(m.bytes / 1048576).toFixed(1)} MB…` : 'Updating…'); break;
      case 'spec': {
        last = m;
        probe.version = m.version.label; probe.error = null;
        $('version').textContent = m.version.label;
        $('version').className = 'badge v' + String(m.version.family).replace('.', '');
        setBanner(null);
        drawProblems();
        if (m.issues.some(i => i.severity === 'error') && st.problems == null) toggleProblems(true);
        const rb = $('remoteBtn');
        rb.classList.toggle('hidden', !(m.remoteBlocked > 0 && !m.remoteAllowed && m.remoteRefs !== 'never'));
        rb.textContent = `Load remote refs (${m.remoteBlocked})`;
        $('expandBtn').classList.toggle('hidden', false);
        const l = pickLayout();
        if (l !== layout) setLayout(l, false); else draw();
        if (m.big && wanted === 'auto' && l === 'reference') {
          setBanner(el('span', null, `Large spec (${(m.stats.bytes / 1048576).toFixed(1)} MB, ${m.stats.operations} operations): the reference layout is used because it draws one operation at a time. `,
            el('a', { href: '#', onclick: e => { e.preventDefault(); setLayout('swagger', true); setBanner(null); }, text: 'Use Swagger UI anyway' })));
        }
        break;
      }
      case 'parseError': {
        probe.error = m.error.message; probe.ready = true;
        const go = el('a', { href: '#', onclick: e => { e.preventDefault(); post({ type: 'reveal', uri: m.error.uri, line: m.error.line, col: m.error.col }); }, text: `line ${m.error.line + 1}` });
        setBanner(el('span', null, m.hasLast ? 'Showing the last good version. ' : '', `${m.fileName} cannot be read: ${m.error.message} at `, go, '.'));
        if (!m.hasLast) { $('empty').classList.remove('hidden'); $('empty').textContent = 'Fix the error above to see the preview.'; $('version').textContent = 'Not readable'; }
        status('');
        break;
      }
      case 'notice': {
        probe.error = m.message; probe.ready = true;
        $('empty').classList.remove('hidden'); $('empty').textContent = '';
        $('empty').append(el('h3', { text: m.heading || 'Not shown' }), el('p', { text: m.message }), el('button', { onclick: () => post({ type: 'settings', query: 'openapiViewer.maxFileMB' }), text: 'Open Settings' }));
        break;
      }
      case 'fatal': probe.error = m.message; setBanner(el('span', { text: 'The preview could not be built: ' + m.message })); status(''); break;
      case 'httpResult': onHttp(m); break;
      case 'follow': onFollow(m.target); break;
      case 'followSetting': setFollow(!!m.on, false); break;
    }
  });

  // ---- toolbar ----
  $('laySwagger').addEventListener('click', () => setLayout('swagger', true));
  $('layReference').addEventListener('click', () => setLayout('reference', true));
  const filter = $('filter');
  filter.value = filterText;
  let ft = null;
  filter.addEventListener('input', () => {
    clearTimeout(ft);
    ft = setTimeout(() => { filterText = filter.value; saveState(); if (layout === 'swagger') swaggerFilter(filterText); else if (ref) ref.filter(filterText); }, 150);
  });
  $('problemsBtn').addEventListener('click', () => toggleProblems());
  $('followBtn').addEventListener('click', () => setFollow(!follow, true));
  $('showWarnings').addEventListener('change', drawProblems);
  $('showInfo').addEventListener('change', drawProblems);
  $('remoteBtn').addEventListener('click', () => { post({ type: 'allowRemote' }); $('remoteBtn').classList.add('hidden'); status('Loading remote refs…'); });
  $('expandBtn').addEventListener('click', () => {
    expanded = !expanded;
    $('expandBtn').textContent = expanded ? 'Collapse all' : 'Expand all';
    if (layout === 'swagger') swaggerExpand(expanded); else if (ref) ref.expandAll(expanded);
  });
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== filter && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName)) { e.preventDefault(); filter.focus(); filter.select(); }
  });
  // Swagger UI links (license, terms, external docs, Markdown) open through the host with a confirm.
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('#swagger a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#')) return;
    e.preventDefault();
    post({ type: 'openLink', url: href });
  }, true);
  // Copy from the page: plain text of the selection. Paste works natively in the filter box.
  document.addEventListener('copy', () => { setTimeout(() => post({ type: 'copied' }), 0); });

  post({ type: 'ready' });
})();
