// User code runs in a terminable worker so loops cannot freeze the page.
const pending = new Map();
let nextCall = 1;
function rpc(address, write, readLength, action = 'transfer') {
  if (pending.size >= 64) throw new Error('Too many queued I²C calls. Await each transfer before sending another.');
  const id = nextCall++;
  return new Promise((resolve, reject) => {
    pending.set(id, {resolve, reject});
    postMessage({type: 'i2c', id, address, write, readLength, action});
  });
}
self.onmessage = async ({data}) => {
  if (data.type === 'reply') {
    const call = pending.get(data.id);
    if (!call) return;
    pending.delete(data.id);
    if (data.error) call.reject(new Error(data.error));
    else call.resolve(data.bytes);
    return;
  }
  if (data.type !== 'run') return;
  const i2c = Object.freeze({
    transfer: (address, bytes = [], readLength = 0) => rpc(address, bytes, readLength),
    write: async (address, bytes) => { await rpc(address, bytes, 0); },
    read: (address, length) => rpc(address, [], length),
    writeRead: (address, bytes, length) => rpc(address, bytes, length),
    stage: async bytes => { await rpc(0, bytes, 0, 'stage'); },
    writeStaged: async address => { await rpc(address, [], 0, 'staged'); },
  });
  const sleep = ms => {
    if (!Number.isFinite(ms) || ms < 0 || ms > 600000) throw new Error('Delay must be between 0 and 600000 ms.');
    return new Promise(resolve => setTimeout(resolve, ms));
  };
  let logCount = 0, lastProgress = -Infinity;
  const log = (...values) => { if (logCount++ < 1000) postMessage({type: 'log', message: values.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join(' ').slice(0, 64000)}); };
  const progress = (sent, total) => { const now = performance.now(); if (now - lastProgress >= 100 || sent >= total) { lastProgress = now; postMessage({type: 'progress', sent, total}); } };
  try {
    const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
    const run = new AsyncFunction('i2c', 'file', 'fileName', 'sleep', 'log', 'progress', 'ascii', 'text', 'hex', '"use strict";\n' + data.source);
    await run(i2c, data.file, data.fileName, sleep, log, progress,
      s => new TextEncoder().encode(s),
      b => new TextDecoder().decode(Uint8Array.from(b)),
      b => Array.from(b, n => n.toString(16).padStart(2, '0').toUpperCase()).join(' '));
    postMessage({type: 'done'});
  } catch (e) { postMessage({type: 'error', message: e.message || String(e)}); }
};
