'use strict';
// Client code snippets for one operation, in 10 languages. Pure Node, nothing is sent anywhere.
const { exampleFor } = require('./mock');
const { resolve } = require('./diff');

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

const LANGUAGES = [
  { id: 'curl', label: 'curl', languageId: 'shellscript' },
  { id: 'js-fetch', label: 'JavaScript (fetch)', languageId: 'javascript' },
  { id: 'node-axios', label: 'Node.js (axios)', languageId: 'javascript' },
  { id: 'python-requests', label: 'Python (requests)', languageId: 'python' },
  { id: 'go', label: 'Go (net/http)', languageId: 'go' },
  { id: 'java', label: 'Java (HttpClient)', languageId: 'java' },
  { id: 'csharp', label: 'C# (HttpClient)', languageId: 'csharp' },
  { id: 'php', label: 'PHP (curl)', languageId: 'php' },
  { id: 'ruby', label: 'Ruby (Net::HTTP)', languageId: 'ruby' },
  { id: 'swift', label: 'Swift (URLSession)', languageId: 'swift' },
];

function familyOf(spec) {
  if (spec && spec.swagger !== undefined) return '2.0';
  return /^3\.0/.test(String(spec && spec.openapi || '')) ? '3.0' : '3.1';
}

function serverOf(spec, family) {
  if (family === '2.0') {
    const scheme = Array.isArray(spec.schemes) && spec.schemes.length ? (spec.schemes.includes('https') ? 'https' : spec.schemes[0]) : 'https';
    const base = typeof spec.basePath === 'string' ? spec.basePath.replace(/\/$/, '') : '';
    return spec.host ? `${scheme}://${spec.host}${base}` : `http://localhost${base}`;
  }
  const s = Array.isArray(spec.servers) ? spec.servers.find(x => isObj(x) && typeof x.url === 'string') : null;
  if (!s) return 'http://localhost';
  let url = s.url.replace(/\{([^}]+)\}/g, (m, n) => (isObj(s.variables) && isObj(s.variables[n]) && s.variables[n].default !== undefined ? String(s.variables[n].default) : m));
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'http://localhost' + (url.startsWith('/') ? '' : '/') + url;
  return url.replace(/\/$/, '');
}

/** Example for a parameter: example, examples, schema example, default, enum, else a placeholder. */
function paramValue(spec, p, placeholder) {
  if (p.example !== undefined) return p.example;
  if (p['x-example'] !== undefined) return p['x-example'];
  if (isObj(p.examples)) { const e = resolve(spec, Object.values(p.examples)[0]); if (isObj(e) && e.value !== undefined) return e.value; }
  const s = isObj(p.schema) ? resolve(spec, p.schema) : p;
  if (isObj(s)) {
    for (const k of ['example', 'default']) if (s[k] !== undefined) return s[k];
    if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
    if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  }
  if (placeholder) return placeholder;
  return exampleFor(isObj(p.schema) ? p.schema : p, spec);
}
const str = v => (v === null || v === undefined ? '' : Array.isArray(v) ? v.map(str).join(',') : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * The request a client would send for one operation:
 * { method, url, headers: [[name, value]], query: [[name, value]], body: string | null, contentType, form: [[name, value]] | null }
 */
function buildRequest(spec, family, apiPath, method, opts = {}) {
  const fam = family || familyOf(spec);
  const item = resolve(spec, spec.paths && spec.paths[apiPath]);
  const op = isObj(item) ? item[String(method).toLowerCase()] : null;
  if (!isObj(op)) throw new Error(`${String(method).toUpperCase()} ${apiPath} is not in the spec.`);
  const server = String(opts.server || serverOf(spec, fam)).replace(/\/$/, '');
  const params = new Map();
  for (const list of [item.parameters, op.parameters]) if (Array.isArray(list)) for (const p0 of list) { const p = resolve(spec, p0); if (isObj(p) && p.name) params.set(p.in + ':' + p.name, p); }
  let path = apiPath;
  const query = [], headers = [];
  let body = null, contentType = null, form = null;
  for (const p of params.values()) {
    if (p.in === 'path') {
      const v = paramValue(spec, p, null);
      const val = v === null || v === undefined || v === '' || v === 'string' ? `{${p.name}}` : encodeURIComponent(str(v));
      path = path.split(`{${p.name}}`).join(val);
    } else if (p.in === 'query' && p.required) query.push([p.name, str(paramValue(spec, p))]);
    else if (p.in === 'header' && p.required && !/^(accept|content-type|authorization)$/i.test(p.name)) headers.push([p.name, str(paramValue(spec, p))]);
    else if (p.in === 'cookie' && p.required) headers.push(['Cookie', `${p.name}=${str(paramValue(spec, p))}`]);
  }

  // Body
  if (fam === '2.0') {
    const consumes = Array.isArray(op.consumes) ? op.consumes : Array.isArray(spec.consumes) ? spec.consumes : ['application/json'];
    const b = [...params.values()].find(p => p.in === 'body');
    const fd = [...params.values()].filter(p => p.in === 'formData');
    if (b) {
      contentType = consumes.find(c => /json/i.test(c)) || consumes[0] || 'application/json';
      const v = b['x-examples'] && b['x-examples'][contentType] !== undefined ? b['x-examples'][contentType] : exampleFor(b.schema, spec, 0, { mode: 'request' });
      body = /json/i.test(contentType) ? JSON.stringify(v, null, 2) : str(v);
    } else if (fd.length) {
      const multipart = fd.some(p => p.type === 'file') || consumes.some(c => /multipart/i.test(c)) && !consumes.some(c => /urlencoded/i.test(c));
      contentType = multipart ? 'multipart/form-data' : 'application/x-www-form-urlencoded';
      form = fd.map(p => [p.name, p.type === 'file' ? '@file.bin' : str(paramValue(spec, p))]);
    }
  } else {
    const rb = resolve(spec, op.requestBody);
    if (isObj(rb) && isObj(rb.content) && Object.keys(rb.content).length) {
      const cts = Object.keys(rb.content);
      contentType = cts.find(c => /^application\/(.+\+)?json/i.test(c)) || cts[0];
      const m = isObj(rb.content[contentType]) ? rb.content[contentType] : {};
      let v;
      if (m.example !== undefined) v = m.example;
      else if (isObj(m.examples) && Object.keys(m.examples).length) { const e = resolve(spec, Object.values(m.examples)[0]); v = isObj(e) && e.value !== undefined ? e.value : exampleFor(m.schema, spec, 0, { mode: 'request' }); }
      else v = exampleFor(m.schema, spec, 0, { mode: 'request' });
      if (/^(multipart\/form-data|application\/x-www-form-urlencoded)/i.test(contentType)) {
        const s = resolve(spec, m.schema);
        const props = isObj(s) && isObj(s.properties) ? s.properties : {};
        form = Object.keys(isObj(v) ? v : {}).map(k => {
          const ps = resolve(spec, props[k]);
          const isFile = isObj(ps) && (ps.format === 'binary' || ps.contentMediaType !== undefined || ps.type === 'file');
          return [k, isFile ? '@file.bin' : str(v[k])];
        });
        contentType = /^multipart/i.test(contentType) ? 'multipart/form-data' : 'application/x-www-form-urlencoded';
      } else if (/json/i.test(contentType)) body = JSON.stringify(v, null, 2);
      else if (v !== undefined && v !== null) body = typeof v === 'string' ? v : JSON.stringify(v);
      else body = '';
    }
  }
  if (form && contentType === 'application/x-www-form-urlencoded' && !form.some(([, v]) => v.startsWith('@'))) {
    body = form.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
    form = null;
  }
  if (contentType && body !== null) headers.push(['Content-Type', contentType]);

  // Accept, from the first 2xx response
  const rs = isObj(op.responses) ? op.responses : {};
  const ok = Object.keys(rs).filter(c => /^2/.test(c)).sort()[0];
  if (ok) {
    const r = resolve(spec, rs[ok]);
    let acc = null;
    if (fam === '2.0') { const produces = Array.isArray(op.produces) ? op.produces : Array.isArray(spec.produces) ? spec.produces : []; if (isObj(r) && r.schema) acc = produces.find(c => /json/i.test(c)) || produces[0] || 'application/json'; }
    else if (isObj(r) && isObj(r.content)) { const cts = Object.keys(r.content); acc = cts.find(c => /json/i.test(c)) || cts[0] || null; }
    if (acc) headers.unshift(['Accept', acc]);
  }

  // Security: the first requirement, with placeholders
  const sec = Array.isArray(op.security) ? op.security : Array.isArray(spec.security) ? spec.security : [];
  const schemes = fam === '2.0' ? (isObj(spec.securityDefinitions) ? spec.securityDefinitions : {}) : (isObj(spec.components) && isObj(spec.components.securitySchemes) ? spec.components.securitySchemes : {});
  const req0 = sec.find(isObj);
  if (req0) for (const name of Object.keys(req0)) {
    const s = resolve(spec, schemes[name]);
    if (!isObj(s)) continue;
    if (s.type === 'apiKey') {
      if (s.in === 'query') query.push([s.name, '<API_KEY>']);
      else if (s.in === 'cookie') headers.push(['Cookie', `${s.name}=<API_KEY>`]);
      else headers.push([s.name, '<API_KEY>']);
    } else if (s.type === 'basic' || (s.type === 'http' && /^basic$/i.test(s.scheme || ''))) headers.push(['Authorization', 'Basic <BASE64_USER_PASSWORD>']);
    else if (s.type === 'http') headers.push(['Authorization', `${/^bearer$/i.test(s.scheme || '') ? 'Bearer' : s.scheme} <TOKEN>`]);
    else if (s.type === 'oauth2' || s.type === 'openIdConnect') headers.push(['Authorization', 'Bearer <ACCESS_TOKEN>']);
  }

  const qs = query.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v).replace(/%3C/g, '<').replace(/%3E/g, '>')).join('&');
  const url = server + path + (qs ? '?' + qs : '');
  return { method: String(method).toUpperCase(), url, headers, query, body, contentType, form };
}

// ---- string literals per language ---------------------------------------------------------------------------------
const sh = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
// JSON string syntax is valid in JS, Python, Go, Java and C#. U+0085, U+2028 and U+2029 are escaped too, because C#
// reads them as line breaks.
const dq = s => JSON.stringify(String(s)).replace(/[\u0085\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const ruby = s => dq(s).replace(/#(?=[{$@])/g, '\\#');
const php = s => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const swift = s => '"' + String(s).replace(/[\\"\u0000-\u001f\u2028\u2029]/g, c => {
  if (c === '\\') return '\\\\';
  if (c === '"') return '\\"';
  if (c === '\n') return '\\n';
  if (c === '\r') return '\\r';
  if (c === '\t') return '\\t';
  return `\\u{${c.charCodeAt(0).toString(16)}}`;
}) + '"';
// Java turns \uXXXX into the character before it reads the string, but JSON.stringify writes CR and LF as \r and \n,
// so every other control character it escapes stays legal inside a Java string.
const javaStr = dq;

function snippet(langId, req) {
  const m = req.method;
  const hasBody = req.body !== null && req.body !== undefined;
  const form = Array.isArray(req.form) && req.form.length ? req.form : null;
  const H = req.headers || [];
  switch (langId) {
    case 'curl': {
      const L = [`curl -X ${m} ${sh(req.url)}`];
      for (const [k, v] of H) L.push(`  -H ${sh(`${k}: ${v}`)}`);
      if (form) for (const [k, v] of form) L.push(`  -F ${sh(`${k}=${v}`)}`);
      else if (hasBody) L.push(`  --data-raw ${sh(req.body)}`);
      return L.join(' \\\n') + '\n';
    }
    case 'js-fetch': {
      const L = [];
      if (form) { L.push('const body = new FormData();'); for (const [k, v] of form) L.push(v.startsWith('@') ? `body.append(${dq(k)}, fileInput.files[0]); // ${v.slice(1)}` : `body.append(${dq(k)}, ${dq(v)});`); }
      L.push(`const response = await fetch(${dq(req.url)}, {`, `  method: ${dq(m)},`);
      L.push('  headers: {'); for (const [k, v] of H) L.push(`    ${dq(k)}: ${dq(v)},`); L.push('  },');
      if (form) L.push('  body,'); else if (hasBody) L.push(`  body: ${dq(req.body)},`);
      L.push('});', 'console.log(response.status, await response.text());');
      return L.join('\n') + '\n';
    }
    case 'node-axios': {
      const L = ["const axios = require('axios');"];
      if (form) { L.push("const fs = require('fs');", 'const data = new FormData();'); for (const [k, v] of form) L.push(v.startsWith('@') ? `data.append(${dq(k)}, new Blob([fs.readFileSync(${dq(v.slice(1))})]));` : `data.append(${dq(k)}, ${dq(v)});`); }
      L.push('', 'const response = await axios.request({', `  method: ${dq(m)},`, `  url: ${dq(req.url)},`);
      L.push('  headers: {'); for (const [k, v] of H) L.push(`    ${dq(k)}: ${dq(v)},`); L.push('  },');
      if (form) L.push('  data,'); else if (hasBody) L.push(`  data: ${dq(req.body)},`);
      L.push('  validateStatus: () => true,', '});', 'console.log(response.status, response.data);');
      return L.join('\n') + '\n';
    }
    case 'python-requests': {
      const L = ['import requests', '', `url = ${dq(req.url)}`, 'headers = {'];
      for (const [k, v] of H) L.push(`    ${dq(k)}: ${dq(v)},`);
      L.push('}');
      if (form) {
        L.push('data = {'); for (const [k, v] of form) if (!v.startsWith('@')) L.push(`    ${dq(k)}: ${dq(v)},`); L.push('}');
        L.push('files = {'); for (const [k, v] of form) if (v.startsWith('@')) L.push(`    ${dq(k)}: open(${dq(v.slice(1))}, "rb"),`); L.push('}');
        L.push(`response = requests.request(${dq(m)}, url, headers=headers, data=data, files=files)`);
      } else if (hasBody) { L.push(`payload = ${dq(req.body)}`, `response = requests.request(${dq(m)}, url, headers=headers, data=payload.encode("utf-8"))`); }
      else L.push(`response = requests.request(${dq(m)}, url, headers=headers)`);
      L.push('print(response.status_code, response.text)');
      return L.join('\n') + '\n';
    }
    case 'go': {
      const L = ['package main', '', 'import (', '\t"fmt"', '\t"io"', '\t"net/http"'];
      if (hasBody && !form) L.push('\t"strings"');
      L.push(')', '', 'func main() {');
      if (form) L.push('\t// This operation takes multipart/form-data. Build the body with mime/multipart:', ...form.map(([k, v]) => `\t//   field ${k}: ${v.replace(/\n/g, ' ')}`), `\treq, err := http.NewRequest(${dq(m)}, ${dq(req.url)}, nil)`);
      else if (hasBody) L.push(`\tbody := strings.NewReader(${dq(req.body)})`, `\treq, err := http.NewRequest(${dq(m)}, ${dq(req.url)}, body)`);
      else L.push(`\treq, err := http.NewRequest(${dq(m)}, ${dq(req.url)}, nil)`);
      L.push('\tif err != nil {', '\t\tpanic(err)', '\t}');
      for (const [k, v] of H) L.push(`\treq.Header.Set(${dq(k)}, ${dq(v)})`);
      L.push('\tres, err := http.DefaultClient.Do(req)', '\tif err != nil {', '\t\tpanic(err)', '\t}', '\tdefer res.Body.Close()', '\tdata, _ := io.ReadAll(res.Body)', '\tfmt.Println(res.StatusCode, string(data))', '}');
      return L.join('\n') + '\n';
    }
    case 'java': {
      const L = ['import java.net.URI;', 'import java.net.http.HttpClient;', 'import java.net.http.HttpRequest;', 'import java.net.http.HttpResponse;', '', 'public class Main {', '  public static void main(String[] args) throws Exception {'];
      if (form) L.push('    // This operation takes multipart/form-data. Build the body with a multipart library.', ...form.map(([k, v]) => `    //   field ${k}: ${v.replace(/\n/g, ' ')}`));
      L.push('    HttpRequest request = HttpRequest.newBuilder()', `        .uri(URI.create(${javaStr(req.url)}))`);
      for (const [k, v] of H) L.push(`        .header(${javaStr(k)}, ${javaStr(v)})`);
      L.push(`        .method(${javaStr(m)}, ${hasBody && !form ? `HttpRequest.BodyPublishers.ofString(${javaStr(req.body)})` : 'HttpRequest.BodyPublishers.noBody()'})`, '        .build();');
      L.push('    HttpResponse<String> response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());', '    System.out.println(response.statusCode() + " " + response.body());', '  }', '}');
      return L.join('\n') + '\n';
    }
    case 'csharp': {
      const L = ['using System.Net.Http;', 'using System.Text;', '', 'using var client = new HttpClient();', `using var request = new HttpRequestMessage(new HttpMethod(${dq(m)}), ${dq(req.url)});`];
      for (const [k, v] of H) if (k.toLowerCase() !== 'content-type') L.push(`request.Headers.TryAddWithoutValidation(${dq(k)}, ${dq(v)});`);
      if (form) {
        L.push('var form = new MultipartFormDataContent();');
        for (const [k, v] of form) L.push(v.startsWith('@') ? `form.Add(new ByteArrayContent(System.IO.File.ReadAllBytes(${dq(v.slice(1))})), ${dq(k)}, ${dq(v.slice(1))});` : `form.Add(new StringContent(${dq(v)}), ${dq(k)});`);
        L.push('request.Content = form;');
      } else if (hasBody) L.push(`request.Content = new StringContent(${dq(req.body)}, Encoding.UTF8, ${dq(req.contentType || 'text/plain')});`);
      L.push('using var response = await client.SendAsync(request);', 'Console.WriteLine($"{(int)response.StatusCode} {await response.Content.ReadAsStringAsync()}");');
      return L.join('\n') + '\n';
    }
    case 'php': {
      const L = ['<?php', '$ch = curl_init();', 'curl_setopt_array($ch, [', `    CURLOPT_URL => ${php(req.url)},`, `    CURLOPT_CUSTOMREQUEST => ${php(m)},`, '    CURLOPT_RETURNTRANSFER => true,', '    CURLOPT_HTTPHEADER => ['];
      for (const [k, v] of H) L.push(`        ${php(`${k}: ${v}`)},`);
      L.push('    ],');
      if (form) { L.push('    CURLOPT_POSTFIELDS => ['); for (const [k, v] of form) L.push(v.startsWith('@') ? `        ${php(k)} => new CURLFile(${php(v.slice(1))}),` : `        ${php(k)} => ${php(v)},`); L.push('    ],'); }
      else if (hasBody) L.push(`    CURLOPT_POSTFIELDS => ${php(req.body)},`);
      L.push(']);', '$body = curl_exec($ch);', 'echo curl_getinfo($ch, CURLINFO_HTTP_CODE) . " " . $body . "\\n";', 'curl_close($ch);');
      return L.join('\n') + '\n';
    }
    case 'ruby': {
      const cls = { GET: 'Get', POST: 'Post', PUT: 'Put', DELETE: 'Delete', PATCH: 'Patch', HEAD: 'Head', OPTIONS: 'Options', TRACE: 'Trace' }[m] || 'Get';
      const L = ["require 'net/http'", "require 'uri'", '', `uri = URI(${ruby(req.url)})`, `request = Net::HTTP::${cls}.new(uri)`];
      for (const [k, v] of H) L.push(`request[${ruby(k)}] = ${ruby(v)}`);
      if (form) { L.push('request.set_form(['); for (const [k, v] of form) L.push(v.startsWith('@') ? `  [${ruby(k)}, File.open(${ruby(v.slice(1))})],` : `  [${ruby(k)}, ${ruby(v)}],`); L.push("], 'multipart/form-data')"); }
      else if (hasBody) L.push(`request.body = ${ruby(req.body)}`);
      L.push("response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == 'https') { |http| http.request(request) }", 'puts "#{response.code} #{response.body}"');
      return L.join('\n') + '\n';
    }
    case 'swift': {
      const L = ['import Foundation', '', `var request = URLRequest(url: URL(string: ${swift(req.url)})!)`, `request.httpMethod = ${swift(m)}`];
      for (const [k, v] of H) L.push(`request.setValue(${swift(v)}, forHTTPHeaderField: ${swift(k)})`);
      if (form) L.push('// This operation takes multipart/form-data. Build httpBody with a multipart boundary:', ...form.map(([k, v]) => `//   field ${k}: ${v.replace(/\n/g, ' ')}`));
      else if (hasBody) L.push(`request.httpBody = ${swift(req.body)}.data(using: .utf8)`);
      L.push('let (data, response) = try await URLSession.shared.data(for: request)', 'print((response as? HTTPURLResponse)?.statusCode ?? 0, String(decoding: data, as: UTF8.self))');
      return L.join('\n') + '\n';
    }
    default: throw new Error(`Unknown language: ${langId}`);
  }
}

module.exports = { LANGUAGES, buildRequest, snippet, serverOf };
