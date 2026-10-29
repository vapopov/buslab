import { SERVICE, RX, TX, ResponseAssembler, UART_SERVICE, UART_RX, UART_TX, uartFrames, decodeUart } from './protocol.mjs';
export class Bridge {
  constructor(bluetooth, emit = () => {}) {
    this.bluetooth = bluetooth; this.emit = emit; this.device = null; this.rx = null; this.tx = null; this.pending = null; this.tainted = false;
    this.uartRx = null; this.uartTx = null; this.uartBusy = false; this.uartUnavailableReason = null;
    this.onUartNotification = event => {
      const view = event.target.value;
      try { this.emit('uart-data', decodeUart(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))); }
      catch (e) { this.emit('uart-error', e.message); }
    };
    this.onNotification = this.onNotification.bind(this);
    this.onDisconnect = this.onDisconnect.bind(this);
  }
  get connected() { return Boolean(this.device?.gatt?.connected && this.rx && this.tx); }
  async connect() {
    this.emit('connecting');
    try {
      const device = await this.bluetooth.requestDevice({ filters: [{ namePrefix: 'BLE-I2C' }], optionalServices: [SERVICE, UART_SERVICE] });
      this.device = device;
      device.addEventListener('gattserverdisconnected', this.onDisconnect);
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE);
      this.rx = await service.getCharacteristic(RX);
      this.tx = await service.getCharacteristic(TX);
      this.tx.addEventListener('characteristicvaluechanged', this.onNotification);
      await this.tx.startNotifications();
      this.uartUnavailableReason = null;
      let uart;
      try {
        uart = await server.getPrimaryService(UART_SERVICE);
      } catch (e) {
        if (e.name !== 'NotFoundError') throw e;
        this.uartUnavailableReason = 'UART service was not found. Select BLE-I2C-UART-v2 after flashing the latest firmware. If already selected, forget the saved device in Bluetooth settings and reconnect to refresh its services.';
      }
      if (uart) {
        try {
          this.uartRx = await uart.getCharacteristic(UART_RX);
          this.uartTx = await uart.getCharacteristic(UART_TX);
          this.uartTx.addEventListener('characteristicvaluechanged', this.onUartNotification);
          await this.uartTx.startNotifications();
        } catch (e) {
          if (this.uartTx) this.uartTx.removeEventListener('characteristicvaluechanged', this.onUartNotification);
          this.uartRx = null; this.uartTx = null;
          this.uartUnavailableReason = `UART service found, but setup failed (${e.name}: ${e.message}). Disconnect and reconnect; if this persists, forget the saved device to refresh its services.`;
        }
      }
      this.tainted = false;
      this.emit('connected', device.name || 'BLE-I2C');
    } catch (e) {
      this.disconnect(); throw e;
    }
  }
  onNotification(event) {
    const view = event.target.value;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
    if (!this.pending || bytes[0] !== this.pending.request.id) { this.emit('unexpected', bytes); return; }
    if (this.pending.completed) { this.emit('unexpected', bytes); return; }
    try {
      if (this.pending.aborting) {
        if (bytes.length !== 20 || bytes[1] !== 0) throw new Error('Upload abort was not acknowledged. Reconnect before continuing.');
        this.pending.completed = true; this.pending.resolve({status:0,data:new Uint8Array()}); return;
      }
      const result = this.pending.assembler.push(bytes);
      this.emit('i2c-packet', {received: this.pending.assembler.offset, total: this.pending.request.readLength});
      if (result) { this.pending.completed = true; this.pending.resolve(result); }
    } catch (e) { this.pending.completed = true; this.pending.reject(e); }
  }
  async transact(request, timeoutMs = request.extended || request.upload || request.type === 'staged' ? 15000 : 5000) {
    if (!this.connected) throw new Error('Connect to BLE-I2C first.');
    if (this.pending || this.uartBusy) throw new Error('Wait for the current transaction to finish.');
    if (this.tainted) throw new Error('Reconnect before sending another command. The previous transaction did not complete.');
    let timer, pending;
    const start = performance.now();
    const armTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        pending.completed = true;
        pending.reject(new Error(`No response after ${timeoutMs / 1000} seconds. The write may already have executed. Reconnect before continuing.`));
      }, timeoutMs);
    };
    const response = new Promise((resolve, reject) => {
      pending = {request, resolve, reject, assembler: new ResponseAssembler(request), completed: false, cancelUpload: false};
      this.pending = pending; armTimer();
    });
    const rx = this.rx;
    const send = async () => {
      const frames = request.frames || [request.frame];
      for (let index = 0; index < frames.length; index++) {
        if (pending.completed) break;
        if (pending.cancelUpload && request.upload) {
          pending.aborting = true;
          const abort = new Uint8Array(20); abort.set([request.id, 1, 4]);
          await rx.writeValueWithResponse(abort);
          const error = new Error('Upload stopped before I²C execution.'); error.uploadAborted = true; throw error;
        }
        await rx.writeValueWithResponse(frames[index]);
        if (!pending.completed) armTimer();
        if (request.upload) this.emit('upload-progress', {sent: Math.min(request.data.length, index * 15), total: request.data.length});
      }
    };
    try {
      const [, result] = await Promise.all([send(), response]);
      return {...result, elapsed: performance.now() - start};
    } catch (e) { pending.completed = true; if (!e.uploadAborted) this.tainted = true; throw e; }
    finally { clearTimeout(timer); this.pending = null; }
  }
  cancelPendingUpload() { if (this.pending?.request.upload) this.pending.cancelUpload = true; }

  async sendUart(bytes) {
    if (!this.connected || !this.uartRx) throw new Error('UART unavailable. Flash the updated firmware and reconnect.');
    if (this.uartBusy || this.pending) throw new Error('Wait for the current send to finish.');
    this.uartBusy = true;
    const rx = this.uartRx;
    try {
      for (const frame of uartFrames(bytes)) await rx.writeValueWithResponse(frame);
    } finally { this.uartBusy = false; }
  }
  onDisconnect() {
    if (this.uartTx) this.uartTx.removeEventListener('characteristicvaluechanged', this.onUartNotification);
    this.uartRx = null; this.uartTx = null;
    if (this.pending) { this.pending.completed = true; this.pending.reject(new Error('Device disconnected. The write may already have executed.')); }
    this.rx = null;
    if (this.tx) this.tx.removeEventListener('characteristicvaluechanged', this.onNotification);
    this.tx = null;
    this.emit('disconnected');
  }
  disconnect() {
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
      if (this.device.gatt?.connected) this.device.gatt.disconnect();
    }
    this.onDisconnect(); this.device = null;
  }
}
