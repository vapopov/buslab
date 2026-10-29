export const SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
export const TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
export const MAX_READ = 2047;
export const MAX_WRITE = 32768;
export const hex = n => n.toString(16).toUpperCase().padStart(2, '0');
export function parseHex(text, maxBytes = MAX_WRITE) {
  const clean = text.trim();
  if (!clean) return new Uint8Array();
  const parts = clean.split(/[\s,]+/).filter(Boolean);
  const bytes = [];
  for (const part of parts) {
    const token = part.replace(/^0x/i, '');
    if (!/^[0-9a-f]+$/i.test(token) || token.length % 2) throw new Error('Use complete hex bytes, for example A0 01 FF or A001FF.');
    for (let i = 0; i < token.length; i += 2) bytes.push(parseInt(token.slice(i, i + 2), 16));
  }
  if (bytes.length > maxBytes) throw new Error(`Maximum ${maxBytes} bytes per send.`);
  return Uint8Array.from(bytes);
}
export function makeRequest(id, addressText, writeText, readText) {
  const a = addressText.trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]{1,2}$/i.test(a)) throw new Error('Enter a 7-bit I²C address in hex, such as 50.');
  const address = parseInt(a, 16);
  if (address < 8 || address > 0x77) throw new Error('Use an unshifted I²C address from 08 to 77.');
  const r = String(readText).trim();
  if (!/^\d+$/.test(r) || Number(r) > MAX_READ) throw new Error('Read length must be a whole number from 0 to 2047.');
  const readLength = Number(r);
  const data = parseHex(writeText);
  if (!data.length && !readLength) throw new Error('Enter write data or request at least one read byte.');
  return makeBinaryRequest(id, address, data, readLength);
}
export function makeBinaryRequest(id, address, bytes, readLength = 0) {
  if (!Number.isInteger(address) || address < 8 || address > 0x77) throw new Error('Use a 7-bit I²C address from 0x08 to 0x77.');
  if (!Number.isInteger(readLength) || readLength < 0 || readLength > MAX_READ) throw new Error('Read length must be a whole number from 0 to 2047.');
  if (!(bytes instanceof Uint8Array) && !Array.isArray(bytes)) throw new Error('Write data must be a Uint8Array or byte array.');
  if (bytes.length > MAX_WRITE || [...bytes].some(b => !Number.isInteger(b) || b < 0 || b > 255)) throw new Error('Write up to 32768 complete bytes per I²C transaction.');
  const data = Uint8Array.from(bytes);
  if (!data.length && !readLength) throw new Error('Enter write data or request at least one read byte.');
  const extended = readLength > 18;
  if (data.length > 16) return uploadRequest(id, address, data, readLength, false);
  const frame = new Uint8Array(20);
  frame.set([id & 255, address | (extended ? 0x80 : 0), data.length | (extended ? (readLength >> 8) << 5 : 0), readLength & 255]);
  frame.set(data, 4);
  return { id: id & 255, address, data, readLength, extended, frame };
}

export function decodeResponse(bytes, request) {
  if (bytes.length !== 20) throw new Error(`Invalid response length: ${bytes.length}; expected 20.`);
  if (bytes[0] !== request.id) throw new Error('Response ID does not match the request.');
  const status = bytes[1];
  const messages = { 0: 'Success', 1: 'Invalid command', 2: 'I²C error — check address, wiring, pull-ups and target power.', 3: 'I²C timed out. Check wiring and pull-ups. The write may already have executed; UART remains available.', 4: 'I²C is still busy after a timeout. Release the bus or reset the board. UART remains available.' };
  if (!(status in messages)) throw new Error(`Unknown firmware status 0x${hex(status)}.`);
  return { status, message: messages[status], data: status === 0 ? bytes.slice(2, 2 + request.readLength) : new Uint8Array(), frame: bytes.slice() };
}

export const UART_SERVICE = '93b10001-e8a8-4f6c-a592-31a52c5db031';
export const UART_RX = '93b10002-e8a8-4f6c-a592-31a52c5db031';
export const UART_TX = '93b10003-e8a8-4f6c-a592-31a52c5db031';
export function uartFrames(bytes) {
  const frames = [];
  for (let offset = 0; offset < bytes.length; offset += 19) {
    const part = bytes.slice(offset, offset + 19), frame = new Uint8Array(20);
    frame[0] = part.length; frame.set(part, 1); frames.push(frame);
  }
  return frames;
}
export function decodeUart(bytes) {
  if (bytes.length !== 20 || bytes[0] > 1 || bytes[1] > 18 || (bytes[0] === 1 && bytes[1] !== 0)) throw new Error('Invalid UART notification.');
  return { overflow: bytes[0] === 1, data: bytes.slice(2, 2 + bytes[1]) };
}

export function makeScanRequest(id) {
  const frame = new Uint8Array(20);
  frame.set([id & 255, 0, 0xFF, 0]);
  return {id: id & 255, type: 'scan', readLength: 14, frame};
}
export function scanAddresses(result) {
  if (result.status !== 0) throw new Error(result.status === 1 ? 'Scanning requires the latest firmware. Flash the updated firmware and reconnect.' : result.message);
  if (result.data.length !== 14) throw new Error('Invalid scan result: expected a 14-byte address bitmap.');
  const addresses = [];
  for (let bit = 0; bit < 112; bit++) if (result.data[bit >> 3] & (1 << (bit & 7))) addresses.push(0x08 + bit);
  return addresses;
}

export class ResponseAssembler {
  constructor(request) { this.request = request; this.buffer = null; this.offset = 0; this.finished = false; }
  push(bytes) {
    const request = this.request;
    if (this.finished) throw new Error('Received data after transaction completion.');
    if (bytes.length !== 20 || bytes[0] !== request.id) throw new Error('Invalid response frame or request ID.');
    if (!request.extended) { this.finished = true; const result = decodeResponse(bytes, request); if (result.status === 1 && (request.upload || request.type === 'staged')) result.message = 'Buffered writes require the updated firmware.'; return result; }
    const kind = bytes[1], value = bytes[2] | (bytes[3] << 8);
    if (kind < 0x80) {
      if (kind === 0) throw new Error('Expected a fragmented read response. Update the firmware.');
      this.finished = true;
      const result = decodeResponse(bytes, request);
      if (kind === 1) result.message = 'Large reads require the updated firmware.';
      return result;
    }
    if (kind === 0x80) {
      if (this.buffer || value !== request.readLength) throw new Error('Invalid or duplicate read header.');
      this.buffer = new Uint8Array(value);
    } else if (kind === 0x81) {
      if (!this.buffer || value !== this.offset || this.offset >= this.buffer.length) throw new Error('Missing, duplicate or out-of-order read packet.');
      const length = Math.min(16, this.buffer.length - this.offset);
      this.buffer.set(bytes.slice(4, 4 + length), this.offset); this.offset += length;
    } else if (kind === 0x82) {
      if (!this.buffer || value !== request.readLength || this.offset !== value) throw new Error('Incomplete read response.');
      this.finished = true;
      return {status: 0, message: 'Success', data: this.buffer, packetCount: Math.ceil(value / 16) + 2};
    } else throw new Error('Unknown fragmented response packet.');
    return null;
  }
}

function uploadRequest(id, address, data, readLength, staging) {
  const frames = [], begin = new Uint8Array(20);
  begin.set([id & 255, 1, 0, address, data.length & 255, data.length >> 8, readLength & 255, readLength >> 8, staging ? 1 : 0]);
  frames.push(begin);
  for (let offset = 0; offset < data.length; offset += 15) {
    const frame = new Uint8Array(20); frame.set([id & 255, 1, 1, offset & 255, offset >> 8]);
    frame.set(data.slice(offset, offset + 15), 5); frames.push(frame);
  }
  const frame = new Uint8Array(20); frame.set([id & 255, 1, 2]); frames.push(frame);
  return {id: id & 255, address, data, readLength, extended: readLength > 18, upload: true, type: staging ? 'stage' : 'transfer', frames, frame};
}
export function makeStageRequest(id, bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_WRITE) throw new Error('Stage a non-empty binary of up to 32768 bytes.');
  return uploadRequest(id, 0, bytes.slice(), 0, true);
}
export function makeStagedWriteRequest(id, address) {
  if (!Number.isInteger(address) || address < 8 || address > 0x77) throw new Error('Use a 7-bit I²C address from 0x08 to 0x77.');
  const frame = new Uint8Array(20); frame.set([id & 255, 1, 3, address]);
  return {id: id & 255, address, data: new Uint8Array(), readLength: 0, type: 'staged', frame};
}
