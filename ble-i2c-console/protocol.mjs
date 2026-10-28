export const SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
export const TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
export const hex = n => n.toString(16).toUpperCase().padStart(2, '0');
export function parseHex(text, maxBytes = 16) {
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
  if (!/^\d+$/.test(r) || Number(r) > 18) throw new Error('Read length must be a whole number from 0 to 18.');
  const readLength = Number(r);
  const data = parseHex(writeText);
  if (!data.length && !readLength) throw new Error('Enter write data or request at least one read byte.');
  const frame = new Uint8Array(20);
  frame.set([id & 255, address, data.length, readLength]);
  frame.set(data, 4);
  return { id: id & 255, address, data, readLength, frame };
}
export function decodeResponse(bytes, request) {
  if (bytes.length !== 20) throw new Error(`Invalid response length: ${bytes.length}; expected 20.`);
  if (bytes[0] !== request.id) throw new Error('Response ID does not match the request.');
  const status = bytes[1];
  const messages = { 0: 'Success', 1: 'Invalid command', 2: 'I²C error — check address, wiring, pull-ups and target power.', 3: 'Firmware reported an I²C timeout.' };
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
