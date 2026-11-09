'use strict';
// The preview page. Strict CSP: nothing remote of any kind, scripts only by nonce, connect-src 'none' (Swagger UI
// gets the spec as an object and cannot fetch; "Try it out" goes through the extension host), no frames, no workers.
// style-src allows inline styles because Swagger UI (React) writes style attributes; with img-src, font-src and
// connect-src closed to remote hosts, a style cannot load or send anything.
const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function csp(cspSource, nonce) {
  return [
    "default-src 'none'",
    `img-src ${cspSource} blob: data:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/** o: { cspSource, title, swaggerJs, swaggerCss, styleUri, scriptUri, referenceUri, swaggerUiVersion, showSupportLinks, nonce? } */
function buildHtml(o) {
  const nonce = o.nonce || crypto.randomBytes(16).toString('base64');
  const footer = footerHtml('openapiViewer', o.showSupportLinks !== false, '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${esc(csp(o.cspSource, nonce))}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${esc(o.swaggerCss)}">
<link rel="stylesheet" href="${esc(o.styleUri)}">
${footer ? `<style nonce="${esc(nonce)}">${FOOTER_CSS}\n.zovo-support{flex:0 0 auto;text-align:right;border-top:1px solid var(--vscode-panel-border,rgba(128,128,128,.35))}</style>` : ''}
<title>${esc(o.title || 'OpenAPI Viewer')}</title>
</head>
<body>
<div id="app" data-swagger-ui="${esc(o.swaggerUiVersion || '')}">
  <div id="toolbar" role="toolbar" aria-label="OpenAPI preview">
    <span id="version" class="badge" title="Version from the openapi or swagger field">…</span>
    <span class="seg" role="radiogroup" aria-label="Layout">
      <button id="laySwagger" role="radio" aria-checked="false" title="Swagger UI layout">Swagger UI</button>
      <button id="layReference" role="radio" aria-checked="false" title="Reference layout: list, details and examples side by side">Reference</button>
    </span>
    <input id="filter" type="search" placeholder="Filter by path, tag, summary or operationId" aria-label="Filter operations" spellcheck="false">
    <button id="problemsBtn" class="ghost" aria-pressed="false" title="Show or hide the problem list">Problems</button>
    <button id="remoteBtn" class="ghost hidden" title="Load $refs from http(s) URLs for this file. Nothing is loaded until you click.">Load remote refs</button>
    <button id="expandBtn" class="ghost" title="Expand or collapse all operations">Expand all</button>
    <button id="followBtn" class="ghost" aria-pressed="true" title="Show the operation or schema under the cursor of the spec editor. A click on an operation or schema here moves the cursor to its line.">Follow cursor</button>
    <span id="status" aria-live="polite"></span>
  </div>
  <div id="banner" class="hidden" role="alert"></div>
  <div id="main">
    <div id="content" tabindex="-1">
      <div id="swagger" class="hidden"></div>
      <div id="reference" class="hidden"></div>
      <div id="empty">Reading the spec…</div>
    </div>
    <aside id="problems" class="hidden" aria-label="Problems">
      <div class="phead"><span id="problemsTitle">Problems</span>
        <span class="pfilters"><label><input type="checkbox" id="showWarnings" checked> warnings</label><label><input type="checkbox" id="showInfo"> info</label></span></div>
      <ol id="problemList"></ol>
    </aside>
  </div>
  ${footer}
</div>
<script nonce="${nonce}" src="${esc(o.swaggerJs)}"></script>
<script nonce="${nonce}" src="${esc(o.referenceUri)}"></script>
<script nonce="${nonce}" src="${esc(o.scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { buildHtml, csp, esc };
