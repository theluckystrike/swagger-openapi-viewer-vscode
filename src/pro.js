'use strict';
// Zovo Pro switch for this extension. PRO_ENABLED is false: every feature is free and no Pro prompt is ever shown.
// When the owner turns it on, these features need Zovo Pro (one price, every Zovo extension):
//   - diff:     the breaking-change report between two versions of a spec (another file or a git ref)
//   - mock:     the local mock server built from the spec
//   - snippets: client code for an operation in 10 languages
// Opening, viewing, editing, lint, quick fixes, IntelliSense, preview, Try it, convert and bundle stay free for good.
// Unlock is offline (a signed key) or one GitHub call after the user clicks "Unlock with GitHub Sponsors"
// (factory/sprint/license, unchanged copies in src/license).
const { createLicense } = require('./license');

const PRO_ENABLED = false;
const SKU = 'openapi-editor-pro';

const FEATURES = {
  diff: ['Breaking-change report', 'Compare two versions of a spec, or the spec at two git refs, and list every change that can break a client.'],
  mock: ['Mock server', 'Serve the example responses of the spec on 127.0.0.1 so a front end can call it before the API exists.'],
  snippets: ['Client code', 'Copy a ready request for an operation in curl, JavaScript, Python, Go, Java, C# and 4 more languages.'],
};

function createPro({ vscode, context, enabled = PRO_ENABLED }) {
  // The unlock commands exist only while the switch is on, so with Pro off nothing can ever call GitHub.
  const license = createLicense({ vscode, context, sku: SKU, name: 'OpenAPI Editor', commandPrefix: enabled ? 'openapiViewer' : undefined });
  try { vscode.commands.executeCommand('setContext', 'openapiViewer.proEnabled', !!enabled); } catch (e) { /* ignore */ }
  /** True when the feature may run. Shows the one Pro explanation only when the switch is on and Pro is missing. */
  async function allow(feature) {
    if (!enabled) return true;
    await license.ready;
    if (license.isPro(SKU)) { license.refresh(); return true; }
    const [name, detail] = FEATURES[feature] || [feature, ''];
    return !!(await license.requirePro(name, detail));
  }
  return { license, allow, enabled: !!enabled, SKU };
}

module.exports = { createPro, PRO_ENABLED, SKU, FEATURES };
