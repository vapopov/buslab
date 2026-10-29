export class ScriptRunner {
  constructor(transfer, emit = () => {}, workerFactory = () => new Worker(new URL('./script-worker.mjs', import.meta.url), {type: 'module'})) {
    this.transfer = transfer; this.emit = emit; this.workerFactory = workerFactory; this.active = null;
  }
  run(source, file = new Uint8Array(), fileName = '') {
    if (this.active) throw new Error('A script is already running.');
    const worker = this.workerFactory();
    const state = {worker, stopped: false, queue: Promise.resolve()};
    this.active = state;
    return new Promise((resolve, reject) => {
      state.finish = error => {
        if (state.stopped) return;
        state.stopped = true;
        worker.terminate();
        // A dispatched I²C command must finish; stopping never cancels DMA or retries.
        const settle = queueError => {
          if (this.active === state) this.active = null;
          if (error || queueError) reject(error || queueError); else resolve();
        };
        state.queue.then(() => settle(), settle);
      };
      worker.onerror = event => { event.preventDefault?.(); state.finish(new Error(event.message || 'Script worker failed.')); };
      worker.onmessage = ({data}) => {
        if (state.stopped) return;
        if (data.type === 'i2c') {
          state.queue = state.queue.then(async () => {
            if (state.stopped) return;
            try {
              const bytes = await this.transfer(data.address, data.write, data.readLength, data.action || 'transfer');
              if (!state.stopped) worker.postMessage({type: 'reply', id: data.id, bytes});
            } catch (e) {
              if (!state.stopped) worker.postMessage({type: 'reply', id: data.id, error: e.message});
            }
          });
        } else if (data.type === 'log') this.emit('log', String(data.message).slice(0, 64000));
        else if (data.type === 'progress') {
          if (Number.isFinite(data.sent) && Number.isFinite(data.total) && data.total > 0) this.emit('progress', {sent: data.sent, total: data.total});
        } else if (data.type === 'done') state.finish();
        else if (data.type === 'error') state.finish(new Error(data.message));
      };
      worker.postMessage({type: 'run', source, file, fileName});
    });
  }
  stop() { this.active?.finish(new Error('Script stopped. An in-flight I²C transaction may already have executed.')); }
}
