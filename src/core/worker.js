'use strict';
// Worker thread: runs preview builds off the extension host thread. Messages:
//   in  { type: 'job', id, rootUri, rootText, maxNodes }      out { type: 'result', id, result } | { type: 'fail', id, message }
//   out { type: 'read', id, req, uri }                       in  { type: 'readResult', req, text } | { type: 'readResult', req, error, code }
const { parentPort } = require('worker_threads');
const { runJob } = require('./job');

let reqSeq = 0;
const waiting = new Map();

parentPort.on('message', m => {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'readResult') {
    const w = waiting.get(m.req);
    if (!w) return;
    waiting.delete(m.req);
    if (typeof m.text === 'string') w.resolve({ text: m.text });
    else w.reject(Object.assign(new Error(String(m.error || 'could not read the file')), { code: m.code || 'read' }));
    return;
  }
  if (m.type === 'job') {
    const read = uri => new Promise((resolve, reject) => {
      const req = ++reqSeq;
      waiting.set(req, { resolve, reject });
      parentPort.postMessage({ type: 'read', id: m.id, req, uri });
    });
    runJob({ rootUri: m.rootUri, rootText: m.rootText, read, maxNodes: m.maxNodes })
      .then(result => parentPort.postMessage({ type: 'result', id: m.id, result }))
      .catch(e => parentPort.postMessage({ type: 'fail', id: m.id, message: String(e && e.stack || e) }));
  }
});
