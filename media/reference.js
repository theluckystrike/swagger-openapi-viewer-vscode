// Reference layout: a list of operations and schemas on the left, the selected item in the middle, request and
// response examples on the right. Only the selected item is drawn, so a spec with 1,000+ operations opens fast.
// Everything is built with DOM calls and textContent: text from the spec never becomes HTML.
(function () {
  'use strict';
  const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace', 'query'];

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const k of kids) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
    return e;
  }

  // ---- pointers and refs ---------------------------------------------------------------------------------------
  const own = Object.prototype.hasOwnProperty;
  function getPtr(spec, ref) {
    if (typeof ref !== 'string' || ref[0] !== '#') return undefined;
    const p = ref.slice(1);
    if (p === '') return spec;
    let v = spec;
    for (const raw of p.slice(1).split('/')) {
      let s = raw; try { s = decodeURIComponent(raw); } catch (e) { /* keep */ }
      s = s.replace(/~1/g, '/').replace(/~0/g, '~');
      if (v === null || typeof v !== 'object' || !own.call(v, s)) return undefined;
      v = v[s];
    }
    return v;
  }
  function deref(spec, v) {
    let n = 0;
    while (v && typeof v === 'object' && typeof v.$ref === 'string' && n++ < 30) {
      const t = getPtr(spec, v.$ref);
      if (t === undefined) return { __missing: v.$ref };
      const sib = Object.keys(v).filter(k => k !== '$ref');
      v = sib.length && t && typeof t === 'object' && !Array.isArray(t) ? Object.assign({}, t, Object.fromEntries(sib.map(k => [k, v[k]]))) : t;
    }
    return v;
  }
  const refName = ref => { const s = String(ref).split('/'); let n = s[s.length - 1] || ref; try { n = decodeURIComponent(n); } catch (e) { /* keep */ } return n.replace(/~1/g, '/').replace(/~0/g, '~'); };

  // ---- safe Markdown -----------------------------------------------------------------------------------------------
  function inline(text, host, ctx) {
    const re = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|!\[([^\]]*)\]\(([^)\s]*)[^)]*\)|\[([^\]]+)\]\(([^)\s]*)[^)]*\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
    let last = 0, m;
    const s = String(text);
    while ((m = re.exec(s))) {
      if (m.index > last) host.append(s.slice(last, m.index));
      if (m[1]) host.append(el('code', { text: m[2] }));
      else if (m[3] || m[4]) host.append(el('strong', { text: m[3] || m[4] }));
      else if (m[5]) host.append(el('em', { text: m[5] }));
      else if (m[6] !== undefined && m[0][0] === '!') host.append(el('span', { class: 'img-ph', title: 'Images are not loaded (no network)', text: '[image' + (m[6] ? ': ' + m[6] : '') + ']' }));
      else if (m[8]) host.append(link(m[8], m[9], ctx));
      else if (m[10]) host.append(link(m[10], m[10], ctx));
      last = re.lastIndex;
    }
    if (last < s.length) host.append(s.slice(last));
  }
  function link(text, href, ctx) {
    const a = el('a', { href: '#', class: 'ext', title: href, text });
    a.addEventListener('click', ev => { ev.preventDefault(); ctx.openLink(href); });
    return a;
  }
  function markdown(src, ctx) {
    const box = el('div', { class: 'md' });
    if (src == null || src === '') return box;
    const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*$/.test(l)) { i++; continue; }
      let m;
      if ((m = /^\s*(```|~~~)/.exec(l))) {
        const fence = m[1]; const buf = []; i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
        i++;
        box.append(el('pre', null, el('code', { text: buf.join('\n') })));
        continue;
      }
      if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) { const h = el('h' + Math.min(6, m[1].length + 2)); inline(m[2].replace(/\s#+\s*$/, ''), h, ctx); box.append(h); i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const row = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        const t = el('table', { class: 'mdtable' });
        const hr = el('tr'); for (const c of row(l)) { const th = el('th'); inline(c, th, ctx); hr.append(th); }
        t.append(el('thead', null, hr));
        const tb = el('tbody'); i += 2;
        while (i < lines.length && /^\s*\|/.test(lines[i])) { const tr = el('tr'); for (const c of row(lines[i])) { const td = el('td'); inline(c, td, ctx); tr.append(td); } tb.append(tr); i++; }
        t.append(tb); box.append(t); continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
        const ordered = /^\s*\d/.test(l);
        const list = el(ordered ? 'ol' : 'ul');
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          const li = el('li'); let t = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''); i++;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) t += ' ' + lines[i++].trim();
          inline(t, li, ctx); list.append(li);
        }
        box.append(list); continue;
      }
      if (/^\s*>/.test(l)) { const buf = []; while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, '')); const q = el('blockquote'); inline(buf.join(' '), q, ctx); box.append(q); continue; }
      if (/^ {4}/.test(l)) { const buf = []; while (i < lines.length && (/^ {4}/.test(lines[i]) || /^\s*$/.test(lines[i]))) buf.push(lines[i++].slice(4)); box.append(el('pre', null, el('code', { text: buf.join('\n').replace(/\n+$/, '') }))); continue; }
      const buf = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*(```|~~~|#{1,6}\s|>|([-*+]|\d+[.)])\s+)/.test(lines[i])) buf.push(lines[i++].trim());
      const p = el('p'); inline(buf.join(' '), p, ctx); box.append(p);
    }
    return box;
  }

  // ---- examples ------------------------------------------------------------------------------------------------
  function sample(spec, schema0, depth, seen) {
    const schema = deref(spec, schema0);
    if (!schema || typeof schema !== 'object' || depth > 8) return null;
    if (schema.__missing) return null;
    if (schema.example !== undefined) return schema.example;
    if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
    if (schema.const !== undefined) return schema.const;
    if (schema.default !== undefined) return schema.default;
    if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
    const key = schema0 && schema0.$ref;
    if (key) { if (seen.has(key)) return {}; seen = new Set(seen); seen.add(key); }
    if (Array.isArray(schema.allOf)) { const o = {}; for (const s of schema.allOf) { const v = sample(spec, s, depth + 1, seen); if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(o, v); } return o; }
    for (const k of ['oneOf', 'anyOf']) if (Array.isArray(schema[k]) && schema[k].length) return sample(spec, schema[k][0], depth + 1, seen);
    let t = schema.type;
    if (Array.isArray(t)) t = t.find(x => x !== 'null') || 'null';
    if (!t) t = schema.properties ? 'object' : schema.items ? 'array' : undefined;
    switch (t) {
      case 'object': {
        const o = {};
        const props = schema.properties || {};
        let n = 0;
        for (const k of Object.keys(props)) { if (n++ > 40) break; const p = deref(spec, props[k]); if (p && p.writeOnly && false) continue; o[k] = sample(spec, props[k], depth + 1, seen); }
        if (!n && schema.additionalProperties && typeof schema.additionalProperties === 'object') o.key = sample(spec, schema.additionalProperties, depth + 1, seen);
        return o;
      }
      case 'array': return schema.items ? [sample(spec, schema.items, depth + 1, seen)] : [];
      case 'integer': return schema.minimum !== undefined ? schema.minimum : 0;
      case 'number': return schema.minimum !== undefined ? schema.minimum : 0;
      case 'boolean': return true;
      case 'null': return null;
      case 'string': {
        const f = schema.format;
        return f === 'date-time' ? '2026-01-01T12:00:00Z' : f === 'date' ? '2026-01-01' : f === 'email' ? 'user@example.com' : f === 'uuid' ? '3fa85f64-5717-4562-b3fc-2c963f66afa6' : f === 'uri' || f === 'url' ? 'https://example.com' : f === 'byte' ? 'U3dhZ2dlcg==' : f === 'binary' ? '<binary>' : f === 'ipv4' ? '192.0.2.1' : 'string';
      }
      default: return null;
    }
  }
  function mediaExample(spec, media) {
    if (!media || typeof media !== 'object') return undefined;
    if (media.example !== undefined) return media.example;
    if (media.examples && typeof media.examples === 'object') {
      for (const k of Object.keys(media.examples)) { const ex = deref(spec, media.examples[k]); if (ex && ex.value !== undefined) return ex.value; if (ex && ex.externalValue) return '(external example: ' + ex.externalValue + ')'; }
    }
    if (media.schema) return sample(spec, media.schema, 0, new Set());
    return undefined;
  }
  const show = v => typeof v === 'string' ? v : JSON.stringify(v, null, 2);

  // ---- schema tree -----------------------------------------------------------------------------------------------
  function typeLabel(spec, s0) {
    if (s0 && s0.$ref) return refName(s0.$ref);
    const s = deref(spec, s0) || {};
    let t = Array.isArray(s.type) ? s.type.join(' | ') : s.type;
    if (!t) t = s.properties ? 'object' : s.items ? 'array' : s.allOf ? 'allOf' : s.oneOf ? 'oneOf' : s.anyOf ? 'anyOf' : s.enum ? 'enum' : s.const !== undefined ? 'const' : 'any';
    if (t === 'array' && s.items) t = 'array of ' + typeLabel(spec, s.items);
    if (s.format) t += ' (' + s.format + ')';
    if (s.nullable) t += ' | null';
    return t;
  }

  function schemaTree(spec, schema, ctx, opts) {
    const root = el('div', { class: 'schema' });
    const add = (host, name, s0, required, depth, chain) => {
      const s = deref(spec, s0) || {};
      const row = el('div', { class: 'srow' });
      const head = el('div', { class: 'shead' });
      const kids = childrenOf(s);
      const cyc = s0 && s0.$ref && chain.includes(s0.$ref);
      const tog = el('button', { class: 'tog' + (kids.length && !cyc ? '' : ' leaf'), 'aria-label': 'Expand', tabindex: kids.length && !cyc ? '0' : '-1' });
      head.append(tog);
      if (name != null) head.append(el('span', { class: 'sname', text: name }));
      const tl = el('span', { class: 'stype', text: typeLabel(spec, s0) });
      if (s0 && s0.$ref && ctx.goSchema && getPtr(spec, s0.$ref) !== undefined && /^#\/(components\/schemas|definitions)\//.test(s0.$ref)) {
        tl.classList.add('reflink'); tl.title = 'Open ' + refName(s0.$ref);
        tl.addEventListener('click', ev => { ev.stopPropagation(); ctx.goSchema(s0.$ref); });
      }
      head.append(tl);
      if (required) head.append(el('span', { class: 'req', text: 'required' }));
      if (s.deprecated) head.append(el('span', { class: 'flag', text: 'deprecated' }));
      if (s.readOnly) head.append(el('span', { class: 'flag', text: 'read-only' }));
      if (s.writeOnly) head.append(el('span', { class: 'flag', text: 'write-only' }));
      if (s.__missing) head.append(el('span', { class: 'flag bad', text: 'missing ' + s.__missing }));
      if (s['x-unresolved-ref']) head.append(el('span', { class: 'flag bad', text: 'unresolved' }));
      if (cyc) head.append(el('span', { class: 'flag', text: 'circular' }));
      row.append(head);
      const facts = [];
      if (Array.isArray(s.enum)) facts.push('one of: ' + s.enum.slice(0, 30).map(v => JSON.stringify(v)).join(', ') + (s.enum.length > 30 ? ' …' : ''));
      if (s.const !== undefined) facts.push('always ' + JSON.stringify(s.const));
      if (s.default !== undefined) facts.push('default ' + JSON.stringify(s.default));
      for (const [k, l] of [['minimum', '≥'], ['maximum', '≤'], ['exclusiveMinimum', '>'], ['exclusiveMaximum', '<'], ['minLength', 'min length'], ['maxLength', 'max length'], ['minItems', 'min items'], ['maxItems', 'max items'], ['pattern', 'pattern']]) if (s[k] !== undefined && typeof s[k] !== 'boolean') facts.push(l + ' ' + s[k]);
      if (s.description) row.append(markdown(s.description, ctx));
      if (facts.length) row.append(el('div', { class: 'facts', text: facts.join(' · ') }));
      const box = el('div', { class: 'skids hidden' });
      row.append(box);
      let built = false;
      const open = v => {
        if (!kids.length || cyc) return;
        if (v && !built) { built = true; for (const k of kids) add(box, k.name, k.schema, k.required, depth + 1, s0 && s0.$ref ? chain.concat(s0.$ref) : chain); }
        box.classList.toggle('hidden', !v); tog.classList.toggle('open', v); tog.setAttribute('aria-label', v ? 'Collapse' : 'Expand');
      };
      head.addEventListener('click', ev => { if (ev.target.closest('a')) return; if (window.getSelection && String(window.getSelection()).length) return; open(box.classList.contains('hidden')); });
      host.append(row);
      if (depth < (opts && opts.expand != null ? opts.expand : 1)) open(true);
    };
    add(root, opts && opts.name != null ? opts.name : null, schema, false, 0, []);
    return root;

    function childrenOf(s) {
      const out = [];
      if (!s || typeof s !== 'object') return out;
      const req = Array.isArray(s.required) ? s.required : [];
      if (s.properties && typeof s.properties === 'object') for (const k of Object.keys(s.properties)) out.push({ name: k, schema: s.properties[k], required: req.includes(k) });
      if (s.items && typeof s.items === 'object' && !Array.isArray(s.items)) out.push({ name: '[items]', schema: s.items });
      for (const k of ['allOf', 'oneOf', 'anyOf']) if (Array.isArray(s[k])) s[k].forEach((x, i) => out.push({ name: `${k} ${i + 1}`, schema: x }));
      if (s.additionalProperties && typeof s.additionalProperties === 'object') out.push({ name: '[any key]', schema: s.additionalProperties });
      if (s.not && typeof s.not === 'object') out.push({ name: 'not', schema: s.not });
      return out;
    }
  }

  // ---- the layout ------------------------------------------------------------------------------------------------
  function render(container, spec, ctx) {
    container.textContent = '';
    const v3 = typeof spec.openapi === 'string' || typeof spec.openapi === 'number';
    const nav = el('nav', { class: 'rnav', 'aria-label': 'Operations' });
    const doc = el('section', { class: 'rdoc', tabindex: '-1' });
    const side = el('section', { class: 'rside', 'aria-label': 'Examples' });
    container.append(el('div', { class: 'rgrid' }, nav, doc, side));
    const items = [];
    const groups = new Map();
    const tagInfo = new Map((Array.isArray(spec.tags) ? spec.tags : []).filter(t => t && t.name).map(t => [String(t.name), t]));
    for (const t of tagInfo.keys()) groups.set(t, []);
    const addOps = (paths, kind) => {
      if (!paths || typeof paths !== 'object') return;
      for (const route of Object.keys(paths)) {
        const item = deref(spec, paths[route]);
        if (!item || typeof item !== 'object') continue;
        for (const m of METHODS) {
          const op = item[m];
          if (!op || typeof op !== 'object') continue;
          const tags = kind === 'webhook' ? ['Webhooks'] : (Array.isArray(op.tags) && op.tags.length ? op.tags.map(String) : ['default']);
          const it = { kind, route, method: m, op, item, id: kind + ':' + m + ':' + route };
          it.text = (route + ' ' + m + ' ' + (op.summary || '') + ' ' + (op.operationId || '') + ' ' + tags.join(' ')).toLowerCase();
          items.push(it);
          for (const t of tags) { if (!groups.has(t)) groups.set(t, []); groups.get(t).push(it); }
        }
      }
    };
    addOps(spec.paths, 'path');
    addOps(spec.webhooks, 'webhook');
    const schemas = v3 ? (spec.components && spec.components.schemas) : spec.definitions;
    const schemaBase = v3 ? '#/components/schemas/' : '#/definitions/';
    const navEls = new Map();
    let current = null;

    const over = el('a', { href: '#', class: 'nitem over', text: 'Overview' });
    over.addEventListener('click', ev => { ev.preventDefault(); select('overview'); });
    nav.append(over);
    navEls.set('overview', over);
    const groupEls = [];
    for (const [tag, list] of groups) {
      if (!list.length) continue;
      const g = el('div', { class: 'ngroup' });
      const h = el('div', { class: 'nhead', text: tag, title: (tagInfo.get(tag) && tagInfo.get(tag).description) || '' });
      g.append(h);
      for (const it of list) {
        const a = el('a', { href: '#', class: 'nitem' + (it.op.deprecated ? ' dep' : ''), title: (it.op.summary || '') + '\n' + it.method.toUpperCase() + ' ' + it.route },
          el('span', { class: 'm m-' + it.method, text: it.method === 'delete' ? 'DEL' : it.method.toUpperCase() }), el('span', { class: 'p', text: it.route }));
        a.addEventListener('click', ev => { ev.preventDefault(); select(it.id); });
        g.append(a);
        if (!navEls.has(it.id)) navEls.set(it.id, a);
        a._item = it;
      }
      nav.append(g);
      groupEls.push({ g, tag });
    }
    const schemaItems = [];
    if (schemas && typeof schemas === 'object' && Object.keys(schemas).length) {
      const g = el('div', { class: 'ngroup' });
      g.append(el('div', { class: 'nhead', text: 'Schemas' }));
      for (const name of Object.keys(schemas)) {
        const id = 'schema:' + name;
        const a = el('a', { href: '#', class: 'nitem sch', text: name });
        a.addEventListener('click', ev => { ev.preventDefault(); select(id); });
        a._text = name.toLowerCase();
        g.append(a); navEls.set(id, a); schemaItems.push(a);
      }
      nav.append(g);
      groupEls.push({ g, tag: 'Schemas' });
    }
    const byId = new Map(items.map(i => [i.id, i]));

    const codeBlock = (title, text, lang) => {
      const pre = el('pre', { class: 'code' + (lang ? ' lang-' + lang : '') }, el('code', { text }));
      const copy = el('button', { class: 'copy', title: 'Copy', text: 'Copy' });
      copy.addEventListener('click', () => ctx.copy(text));
      return el('div', { class: 'cblock' }, el('div', { class: 'ctitle' }, el('span', { text: title }), copy), pre);
    };

    function select(id, quiet) {
      if (id === current && quiet) return;
      if (current && navEls.get(current)) navEls.get(current).classList.remove('sel');
      current = id;
      const a = navEls.get(id);
      if (a) { a.classList.add('sel'); a.scrollIntoView({ block: 'nearest' }); }
      doc.textContent = ''; side.textContent = '';
      doc.scrollTop = 0; side.scrollTop = 0;
      if (id === 'overview') overview();
      else if (id.startsWith('schema:')) schemaPage(id.slice(7));
      else if (byId.has(id)) operation(byId.get(id));
      ctx.onSelect && ctx.onSelect(id, !!quiet);
    }

    function overview() {
      const info = spec.info || {};
      doc.append(el('h1', { text: String(info.title || 'Untitled API') }), el('div', { class: 'sub' }, el('span', { class: 'pill', text: 'version ' + String(info.version != null ? info.version : '?') })));
      if (info.summary) doc.append(el('p', { class: 'lead', text: String(info.summary) }));
      if (info.description) doc.append(markdown(info.description, ctx));
      const facts = el('dl', { class: 'facts2' });
      const fact = (k, v) => { if (v) facts.append(el('dt', { text: k }), el('dd', null, v)); };
      if (info.contact) fact('Contact', el('span', null, String(info.contact.name || ''), info.contact.email ? ' ' + String(info.contact.email) : '', info.contact.url ? link(' ' + info.contact.url, String(info.contact.url), ctx) : ''));
      if (info.license) fact('License', info.license.url ? link(String(info.license.name || info.license.url), String(info.license.url), ctx) : String(info.license.name || info.license.identifier || ''));
      if (info.termsOfService) fact('Terms', link(String(info.termsOfService), String(info.termsOfService), ctx));
      if (spec.externalDocs && spec.externalDocs.url) fact('Docs', link(String(spec.externalDocs.description || spec.externalDocs.url), String(spec.externalDocs.url), ctx));
      const servers = v3 ? (Array.isArray(spec.servers) ? spec.servers : []) : (spec.host ? [{ url: ((spec.schemes && spec.schemes[0]) || 'https') + '://' + spec.host + (spec.basePath || '') }] : []);
      if (servers.length) fact('Servers', el('div', null, ...servers.map(s => el('div', null, el('code', { text: String(s.url) }), s.description ? ' ' + String(s.description) : ''))));
      doc.append(facts);
      const n = { ops: items.filter(i => i.kind === 'path').length, hooks: items.filter(i => i.kind === 'webhook').length, schemas: schemaItems.length };
      doc.append(el('p', { class: 'muted', text: `${n.ops} operations${n.hooks ? `, ${n.hooks} webhooks` : ''}, ${n.schemas} schemas. Pick one on the left.` }));
      const sec = v3 ? (spec.components && spec.components.securitySchemes) : spec.securityDefinitions;
      if (sec && typeof sec === 'object' && Object.keys(sec).length) {
        doc.append(el('h3', { text: 'Security schemes' }));
        const t = el('table', { class: 'ptable' }, el('thead', null, el('tr', null, el('th', { text: 'Name' }), el('th', { text: 'Type' }), el('th', { text: 'Details' }))));
        const tb = el('tbody');
        for (const k of Object.keys(sec)) { const s = deref(spec, sec[k]) || {}; tb.append(el('tr', null, el('td', null, el('code', { text: k })), el('td', { text: String(s.type || '') + (s.scheme ? ' ' + s.scheme : '') }), el('td', { text: [s.in && s.name ? `${s.name} in ${s.in}` : '', s.bearerFormat || '', s.flows ? Object.keys(s.flows).join(', ') : s.flow || '', s.openIdConnectUrl || ''].filter(Boolean).join(' · ') }))); }
        t.append(tb); doc.append(t);
      }
      if (tagInfo.size) {
        doc.append(el('h3', { text: 'Tags' }));
        for (const [name, t] of tagInfo) { doc.append(el('h4', { text: name })); if (t.description) doc.append(markdown(t.description, ctx)); }
      }
      if (servers.length) side.append(codeBlock('Base URL', servers.map(s => String(s.url)).join('\n')));
    }

    function paramRows(params, title) {
      if (!params.length) return;
      doc.append(el('h3', { text: title }));
      const t = el('table', { class: 'ptable' }, el('thead', null, el('tr', null, el('th', { text: 'Name' }), el('th', { text: 'In' }), el('th', { text: 'Type' }), el('th', { text: 'Description' }))));
      const tb = el('tbody');
      for (const p of params) {
        const sch = p.schema || (p.type ? p : null);
        const d = el('td');
        if (p.description) d.append(markdown(p.description, ctx));
        const extra = [];
        const s = sch ? deref(spec, sch) || {} : {};
        if (Array.isArray(s.enum)) extra.push('one of: ' + s.enum.slice(0, 20).map(v => JSON.stringify(v)).join(', '));
        if (s.default !== undefined) extra.push('default ' + JSON.stringify(s.default));
        if (p.example !== undefined) extra.push('example ' + JSON.stringify(p.example));
        if (extra.length) d.append(el('div', { class: 'facts', text: extra.join(' · ') }));
        tb.append(el('tr', { class: p.deprecated ? 'dep' : '' }, el('td', null, el('code', { text: String(p.name) }), p.required ? el('span', { class: 'req', text: 'required' }) : ''),
          el('td', { text: String(p.in || '') }), el('td', { text: sch ? typeLabel(spec, sch) : p.content ? Object.keys(p.content).join(', ') : '' }), d));
      }
      t.append(tb); doc.append(t);
    }

    function operation(it) {
      const op = it.op;
      doc.append(el('div', { class: 'ophead' }, el('span', { class: 'm big m-' + it.method, text: it.method.toUpperCase() }), el('code', { class: 'route', text: it.route }), op.deprecated ? el('span', { class: 'flag', text: 'deprecated' }) : ''));
      if (op.summary) doc.append(el('h2', { text: String(op.summary) }));
      const meta = [];
      if (op.operationId) meta.push('operationId ' + op.operationId);
      if (it.kind === 'webhook') meta.push('webhook');
      if (meta.length) doc.append(el('div', { class: 'muted', text: meta.join(' · ') }));
      if (ctx.snippet && it.kind === 'path') {
        const b = el('button', { class: 'ghost small codebtn', title: 'Client code for this operation in curl, JavaScript, Python, Go, Java, C# and more', text: 'Copy as code…' });
        b.addEventListener('click', () => ctx.snippet(it.route, it.method));
        doc.append(el('div', { class: 'opactions' }, b));
      }
      if (op.description) doc.append(markdown(op.description, ctx));
      const params0 = [].concat(Array.isArray(it.item.parameters) ? it.item.parameters : [], Array.isArray(op.parameters) ? op.parameters : []).map(p => deref(spec, p)).filter(p => p && typeof p === 'object' && !p.__missing);
      const params = [];
      const seenP = new Set();
      for (const p of params0.reverse()) { const k = p.in + ':' + p.name; if (!seenP.has(k)) { seenP.add(k); params.unshift(p); } }
      const body2 = params.find(p => p.in === 'body');
      paramRows(params.filter(p => p.in !== 'body' && p.in !== 'formData'), 'Parameters');
      paramRows(params.filter(p => p.in === 'formData'), 'Form fields');
      let reqExample;
      const rb = deref(spec, op.requestBody);
      if (rb && rb.content && typeof rb.content === 'object') {
        doc.append(el('h3', null, 'Request body', rb.required ? el('span', { class: 'req', text: 'required' }) : ''));
        if (rb.description) doc.append(markdown(rb.description, ctx));
        for (const ct of Object.keys(rb.content)) {
          doc.append(el('div', { class: 'ctype', text: ct }));
          const media = rb.content[ct] || {};
          if (media.schema) doc.append(schemaTree(spec, media.schema, ctx));
          if (reqExample === undefined) { const ex = mediaExample(spec, media); if (ex !== undefined) reqExample = { ct, text: show(ex) }; }
        }
      } else if (body2) {
        doc.append(el('h3', null, 'Request body', body2.required ? el('span', { class: 'req', text: 'required' }) : ''));
        if (body2.description) doc.append(markdown(body2.description, ctx));
        if (body2.schema) { doc.append(schemaTree(spec, body2.schema, ctx)); reqExample = { ct: (op.consumes || spec.consumes || ['application/json'])[0], text: show(sample(spec, body2.schema, 0, new Set())) }; }
      }
      const responses = op.responses && typeof op.responses === 'object' ? op.responses : {};
      const respExamples = [];
      if (Object.keys(responses).length) {
        doc.append(el('h3', { text: 'Responses' }));
        for (const code of Object.keys(responses)) {
          const r = deref(spec, responses[code]) || {};
          const cls = /^2/.test(code) ? 'ok' : /^3/.test(code) ? 'redir' : /^[45]/.test(code) ? 'bad' : 'other';
          const box = el('div', { class: 'resp' });
          box.append(el('div', { class: 'rhead' }, el('span', { class: 'code ' + cls, text: code }), r.description ? el('span', { class: 'rdesc' }) : ''));
          if (r.description) { const d = box.querySelector('.rdesc'); d.append(markdown(r.description, ctx)); }
          if (r.__missing) box.append(el('div', { class: 'flag bad', text: 'missing ' + r.__missing }));
          if (r.headers && typeof r.headers === 'object' && Object.keys(r.headers).length) {
            box.append(el('div', { class: 'facts', text: 'Headers: ' + Object.keys(r.headers).join(', ') }));
          }
          if (r.content && typeof r.content === 'object') {
            for (const ct of Object.keys(r.content)) {
              const media = r.content[ct] || {};
              box.append(el('div', { class: 'ctype', text: ct }));
              if (media.schema) box.append(schemaTree(spec, media.schema, ctx, { expand: 0 }));
              const ex = mediaExample(spec, media);
              if (ex !== undefined && respExamples.length < 12) respExamples.push({ code, ct, text: show(ex) });
            }
          } else if (r.schema) {
            box.append(schemaTree(spec, r.schema, ctx, { expand: 0 }));
            const ex = r.examples && typeof r.examples === 'object' && Object.keys(r.examples).length ? r.examples[Object.keys(r.examples)[0]] : sample(spec, r.schema, 0, new Set());
            if (respExamples.length < 12) respExamples.push({ code, ct: (op.produces || spec.produces || ['application/json'])[0], text: show(ex) });
          }
          doc.append(box);
        }
      }
      if (op.callbacks && typeof op.callbacks === 'object' && Object.keys(op.callbacks).length) {
        doc.append(el('h3', { text: 'Callbacks' }));
        for (const k of Object.keys(op.callbacks)) { const cb = deref(spec, op.callbacks[k]) || {}; doc.append(el('div', null, el('strong', { text: k }), ' ', ...Object.keys(cb).map(u => el('code', { text: u })))); }
      }
      const sec = op.security || spec.security;
      if (Array.isArray(sec) && sec.length) doc.append(el('h3', { text: 'Security' }), el('div', { text: sec.map(r => Object.keys(r || {}).map(k => k + ((r[k] || []).length ? ' (' + r[k].join(', ') + ')' : '')).join(' + ') || 'none').join('  or  ') }));
      // Right side: a curl line and the examples.
      const base = v3 ? (Array.isArray(spec.servers) && spec.servers[0] && spec.servers[0].url) || '' : spec.host ? (((op.schemes || spec.schemes || ['https'])[0]) + '://' + spec.host + (spec.basePath || '')) : (spec.basePath || '');
      if (it.kind === 'path') {
        let url = String(base).replace(/\/$/, '') + it.route.replace(/\{([^}]+)\}/g, (m0, n) => { const p = params.find(x => x.in === 'path' && x.name === n); const ex = p && (p.example !== undefined ? p.example : p.schema ? sample(spec, p.schema, 0, new Set()) : null); return ex != null && ex !== 'string' ? encodeURIComponent(String(ex)) : '{' + n + '}'; });
        const q = params.filter(p => p.in === 'query' && p.required).map(p => p.name + '=' + encodeURIComponent(String(p.example !== undefined ? p.example : p.schema ? sample(spec, p.schema, 0, new Set()) : '')));
        if (q.length) url += '?' + q.join('&');
        const lines = ['curl -X ' + it.method.toUpperCase() + " '" + url.replace(/'/g, "'\\''") + "'"];
        for (const p of params.filter(p => p.in === 'header' && p.required)) lines.push("  -H '" + p.name + ": " + String(p.example != null ? p.example : 'value').replace(/'/g, '') + "'");
        if (reqExample) { lines.push("  -H 'Content-Type: " + reqExample.ct + "'"); lines.push("  -d '" + (reqExample.text.length < 4000 ? reqExample.text.replace(/'/g, "'\\''") : '@body.json') + "'"); }
        side.append(codeBlock('Request', lines.join(' \\\n'), 'shell'));
      }
      if (reqExample) side.append(codeBlock('Request body · ' + reqExample.ct, reqExample.text, 'json'));
      for (const r of respExamples) side.append(codeBlock('Response ' + r.code + ' · ' + r.ct, r.text, 'json'));
      if (!side.childNodes.length) side.append(el('div', { class: 'muted', text: 'No examples for this operation.' }));
    }

    function schemaPage(name) {
      const ref = schemaBase + name.replace(/~/g, '~0').replace(/\//g, '~1');
      const s = schemas[name];
      doc.append(el('div', { class: 'ophead' }, el('span', { class: 'm big m-schema', text: 'SCHEMA' }), el('code', { class: 'route', text: name })));
      doc.append(schemaTree(spec, { $ref: ref }, ctx, { expand: 1, name }));
      const ex = sample(spec, s, 0, new Set([ref]));
      if (ex !== null && ex !== undefined) side.append(codeBlock('Example', show(ex), 'json'));
      const users = items.filter(i => JSON.stringify(i.op).includes('"' + ref + '"')).slice(0, 40);
      if (users.length) {
        doc.append(el('h3', { text: 'Used by' }));
        for (const u of users) { const a = el('a', { href: '#', class: 'uses' }, el('span', { class: 'm m-' + u.method, text: u.method.toUpperCase() }), ' ', u.route); a.addEventListener('click', ev => { ev.preventDefault(); select(u.id); }); doc.append(el('div', null, a)); }
      }
    }

    function filter(text) {
      const q = String(text || '').trim().toLowerCase();
      for (const { g } of groupEls) {
        let any = false;
        for (const a of g.querySelectorAll('.nitem')) {
          const t = a._item ? a._item.text : a._text || '';
          const hit = !q || t.includes(q);
          a.classList.toggle('hidden', !hit); if (hit) any = true;
        }
        const head = g.querySelector('.nhead');
        if (q && head && head.textContent.toLowerCase().includes(q)) { any = true; for (const a of g.querySelectorAll('.nitem')) a.classList.remove('hidden'); }
        g.classList.toggle('hidden', !any);
      }
    }

    ctx.goSchema = ref => { const id = 'schema:' + refName(ref); if (navEls.has(id)) select(id); };
    const start = ctx.selected && (ctx.selected === 'overview' || navEls.has(ctx.selected)) ? ctx.selected : 'overview';
    select(start, true);
    return {
      filter, select, items: () => items.length, current: () => current,
      /** Select an item from the editor cursor without sending a jump back. */
      show(id) { if (navEls.has(id) || id === 'overview') select(id, true); return navEls.has(id); },
      itemOf(id) { return byId.get(id) || null; },
      expandAll(v) { for (const t of doc.querySelectorAll('.tog:not(.leaf)')) if (t.classList.contains('open') !== v) t.click(); },
    };
  }

  window.OAVReference = { render, markdown, sample, deref, getPtr };
})();
