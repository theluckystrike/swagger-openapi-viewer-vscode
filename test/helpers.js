'use strict';
// Test helpers: run a preview build over files on disk, with the same workspace rule as the extension host.
const fs = require('fs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const { runJob } = require('../src/core/job');

const SAMPLES = path.join(__dirname, '..', 'samples');

function reader(root) {
  const lexical = path.resolve(root);
  const base = fs.realpathSync(root);
  return async uri => {
    if (/^https?:/.test(uri)) throw Object.assign(new Error('remote refs are not loaded until you click "Load remote refs"'), { code: 'remote-blocked' });
    const p = fileURLToPath(uri);
    if (!p.startsWith(lexical + '/')) throw Object.assign(new Error('outside the workspace'), { code: 'outside' });
    if (!fs.existsSync(p)) throw Object.assign(new Error('file not found: ' + path.relative(lexical, p)), { code: 'missing' });
    const real = fs.realpathSync(p);
    if (!real.startsWith(base + path.sep)) throw Object.assign(new Error('links outside the workspace'), { code: 'outside' });
    return { text: fs.readFileSync(p, 'utf8') };
  };
}

async function build(file, root = SAMPLES, text) {
  const abs = path.resolve(file);
  return runJob({ rootUri: pathToFileURL(abs).toString(), rootText: text != null ? text : fs.readFileSync(abs, 'utf8'), read: reader(root) });
}

module.exports = { SAMPLES, reader, build };
