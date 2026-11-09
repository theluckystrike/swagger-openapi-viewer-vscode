'use strict';
// Quick fixes for OpenAPI lint problems, and the workspace ruleset (.spectral.yaml / .yml / .json).
// The text edits come from src/core/fixes.js. "Turn off <rule> in .spectral.yaml" runs a command, so the ruleset file
// is read and written only when the user picks it.
const path = require('path');
const { fixEdits, rulesetWithRuleOff } = require('./core/fixes');
const { parseRuleset } = require('./core/lint');

const RULESET_NAMES = ['.spectral.yaml', '.spectral.yml', '.spectral.json'];
const TURN_OFF_CMD = 'openapiViewer.turnOffLintRule';

/** The ruleset file for a document: the first of RULESET_NAMES in its workspace folder. { uri, text } or null. */
async function findRuleset(vscode, docUri) {
  const wf = vscode.workspace.getWorkspaceFolder(docUri);
  if (!wf) return null;
  for (const n of RULESET_NAMES) {
    const uri = vscode.Uri.joinPath(wf.uri, n);
    try {
      const st = await vscode.workspace.fs.stat(uri);
      if (st.size > 1048576) return { uri, text: null, tooLarge: true };
      return { uri, text: new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri)) };
    } catch { /* next name */ }
  }
  return null;
}

/** Parsed ruleset for a document, or null when its folder has none. { ruleset, uri, errors }. */
async function loadRuleset(vscode, docUri) {
  const f = await findRuleset(vscode, docUri);
  if (!f) return null;
  if (f.tooLarge) return { ruleset: null, uri: f.uri, errors: [`${path.posix.basename(f.uri.path)} is larger than 1 MB, so it is not read. The default rules are used.`] };
  const r = parseRuleset(f.text, path.posix.basename(f.uri.path));
  return { ruleset: r, uri: f.uri, errors: r.errors };
}

function isJsonDoc(document) {
  return document.languageId === 'json' || document.languageId === 'jsonc' || /\.json$/i.test(document.uri.path);
}

/**
 * registerLintFixes({ vscode, context, lookupIssue, selector? })
 * lookupIssue(uriString, diagnostic) -> issue ({ rule, data, line, col, ... }) or undefined.
 */
function registerLintFixes({ vscode, context, lookupIssue, selector }) {
  const sel = selector || [{ language: 'yaml' }, { language: 'json' }, { language: 'jsonc' }];
  const provider = {
    provideCodeActions(document, _range, ctx) {
      const actions = [];
      const offered = new Set();
      for (const d of ctx.diagnostics || []) {
        const issue = lookupIssue(document.uri.toString(), d);
        if (!issue || !issue.rule) continue;
        let fixes = [];
        try { fixes = fixEdits(document.getText(), isJsonDoc(document), { ...issue, line: d.range.start.line, col: issue.col != null ? issue.col : d.range.start.character }); } catch { fixes = []; }
        fixes.forEach((f, i) => {
          const a = new vscode.CodeAction(f.title, vscode.CodeActionKind.QuickFix);
          a.diagnostics = [d];
          a.isPreferred = i === 0;
          const we = new vscode.WorkspaceEdit();
          for (const e of f.edits) we.replace(document.uri, new vscode.Range(e.startLine, e.startCol, e.endLine, e.endCol), e.newText);
          a.edit = we;
          actions.push(a);
        });
        if (!offered.has(issue.rule)) {
          offered.add(issue.rule);
          const a = new vscode.CodeAction(`Turn off ${issue.rule} in .spectral.yaml`, vscode.CodeActionKind.QuickFix);
          a.diagnostics = [d];
          a.command = { command: TURN_OFF_CMD, title: a.title, arguments: [document.uri.toString(), issue.rule] };
          actions.push(a);
        }
      }
      return actions;
    },
  };
  const turnOff = async (uriStr, rule) => {
    if (typeof uriStr !== 'string' || typeof rule !== 'string' || !/^[A-Za-z0-9_.$\-]+$/.test(rule)) return;
    const docUri = vscode.Uri.parse(uriStr);
    const wf = vscode.workspace.getWorkspaceFolder(docUri);
    if (!wf) { vscode.window.showInformationMessage('Open the folder of this spec as a workspace to keep lint settings in a .spectral.yaml file.'); return; }
    const found = await findRuleset(vscode, docUri);
    if (found && found.tooLarge) { vscode.window.showWarningMessage(`${path.posix.basename(found.uri.path)} is larger than 1 MB, so it was not changed.`); return; }
    const uri = found ? found.uri : vscode.Uri.joinPath(wf.uri, '.spectral.yaml');
    let next;
    try { next = rulesetWithRuleOff(found ? found.text : null, rule, path.posix.basename(uri.path)); }
    catch (e) { vscode.window.showWarningMessage(String(e && e.message || e)); return; }
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(next));
    vscode.window.setStatusBarMessage(`OpenAPI: ${rule} is off in ${path.posix.basename(uri.path)}`, 4000);
  };
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(sel, provider, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.commands.registerCommand(TURN_OFF_CMD, turnOff),
  );
  return { provider, turnOff };
}

module.exports = { registerLintFixes, loadRuleset, findRuleset, RULESET_NAMES, TURN_OFF_CMD };
