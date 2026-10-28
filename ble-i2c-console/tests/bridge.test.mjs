import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHex, makeRequest, decodeResponse, SERVICE, RX, TX, UART_SERVICE, UART_RX, UART_TX, uartFrames, decodeUart } from '../protocol.mjs';
import { Bridge } from '../transport.mjs';

test('hex input accepts separated, compact and prefixed bytes', () => {
  for (const input of ['A0 01 FF', 'A001FF', '0xA0, 0x01, 0xFF']) assert.deepEqual([...parseHex(input)], [160,1,255]);
  for (const input of ['A', 'GG', '0x', 'AA-01', 'AA '.repeat(17)]) assert.throws(() => parseHex(input));
});
test('exact firmware frame with zero padding and combined read', () => {
  const request = makeRequest(257, '0x50', '10 A0', '18');
  assert.deepEqual([...request.frame], [1,80,2,18,16,160,...Array(14).fill(0)]);
  assert.equal(request.frame.length,20);
});
test('read-only/write-only and bounds', () => {
  assert.equal(makeRequest(1, '08', '', '1').data.length,0);
  assert.equal(makeRequest(1, '77', '00', '0').readLength,0);
  for (const args of [['07','AA','1'],['78','AA','1'],['50','','0'],['50','AA','19'],['50','AA','1.5'],['50','AA','-1']]) assert.throws(() => makeRequest(1,...args));
});
test('decode strips headers and padding, checks frame and status', () => {
  const req = makeRequest(5,'50','10','2');
  const bytes = Uint8Array.from([5,0,160,60,...Array(16).fill(0)]);
  assert.deepEqual([...decodeResponse(bytes, req).data], [160,60]);
  bytes[1]=2; assert.equal(decodeResponse(bytes, req).data.length,0);
  bytes[1]=99; assert.throws(() => decodeResponse(bytes, req));
  assert.throws(() => decodeResponse(new Uint8Array(19),req));
  bytes[0]=7; assert.throws(() => decodeResponse(bytes,req));
});
function setup(writeHandler, uart = null, emit) {
  const device = new EventTarget(); device.name='BLE-I2C';
  const tx = new EventTarget();
  tx.startNotifications = async () => tx;
  tx.notify = bytes => {
    // Exercise a DataView with a nonzero offset.
    const storage = new Uint8Array(bytes.length+4); storage.set(bytes,2);
    tx.value = new DataView(storage.buffer,2,bytes.length);
    tx.dispatchEvent(new Event('characteristicvaluechanged'));
  };
  const rx = {writeValueWithResponse: async frame => writeHandler(frame,tx,device)};
  const service = {getCharacteristic: async uuid => uuid===RX ? rx : uuid===TX ? tx : null};
  device.gatt = { connected:false, connect:async()=>{ device.gatt.connected=true; return {getPrimaryService:async uuid=>{if (uuid === UART_SERVICE) { if (uart) return uart; const e = new Error('Service absent'); e.name = 'NotFoundError'; throw e; } assert.equal(uuid,SERVICE);return service;}}; }, disconnect:()=>{device.gatt.connected=false;device.dispatchEvent(new Event('gattserverdisconnected'));} };
  const bluetooth = {requestDevice:async options=>{ assert.deepEqual(options.optionalServices,[SERVICE, UART_SERVICE]);return device; }};
  return {bridge:new Bridge(bluetooth, emit), device, tx};
}
test('subscribes and receives a notification before write acknowledgement',async()=>{
  const {bridge}=setup(async (frame,tx)=>tx.notify(Uint8Array.from([frame[0],0,0xA0,0x3C,...Array(16).fill(0)])));
  await bridge.connect();
  const result=await bridge.transact(makeRequest(1,'50','10','2'));
  assert.deepEqual([...result.data],[160,60]); assert.equal(bridge.pending,null); bridge.disconnect();
});
test('timeout does not retry writes and requires reconnect',async()=>{
  let writes=0;
  const {bridge}=setup(async()=>{writes++;}); await bridge.connect();
  const req=makeRequest(1,'50','10','2');
  await assert.rejects(bridge.transact(req,10),/No response/);
  assert.equal(writes,1); assert.equal(bridge.tainted,true);
  await assert.rejects(bridge.transact(req),/Reconnect/); bridge.disconnect();
});
test('disconnect rejects pending operation',async()=>{
  const {bridge}=setup(async (frame,tx,device)=>{device.gatt.disconnect();});
  await bridge.connect();
  await assert.rejects(bridge.transact(makeRequest(1,'50','10','2')),/disconnected/);
  assert.equal(bridge.connected,false); bridge.disconnect();
});
test('concurrent requests are rejected; stale response IDs are ignored',async()=>{
  const {bridge,tx}=setup(async()=>{}); await bridge.connect();
  const first=bridge.transact(makeRequest(1,'50','10','1'),500);
  await assert.rejects(bridge.transact(makeRequest(2,'50','10','1')),/Wait/);
  tx.notify(Uint8Array.from([99,0,200,...Array(17).fill(0)]));
  assert.notEqual(bridge.pending,null);
  tx.notify(Uint8Array.from([1,0,160,...Array(17).fill(0)]));
  assert.equal((await first).data[0],160); bridge.disconnect();
});

test('UART frames preserve arbitrary binary data across 19-byte boundaries', () => {
  const bytes = Uint8Array.from({length: 60}, (_, i) => i === 4 ? 0 : i);
  const frames = uartFrames(bytes);
  assert.deepEqual(frames.map(f => f[0]), [19, 19, 19, 3]);
  assert.deepEqual(frames.flatMap(f => [...f.slice(1, 1 + f[0])]), [...bytes]);
  assert.deepEqual([...frames[3].slice(4)], Array(16).fill(0));
  assert.deepEqual(uartFrames(new Uint8Array()), []);
  assert.equal(parseHex('AA '.repeat(30), 4096).length, 30);
});
test('UART notifications decode data and overflow, rejecting malformed frames', () => {
  const frame = new Uint8Array(20); frame.set([0, 3, 65, 0, 255]);
  assert.deepEqual([...decodeUart(frame).data], [65, 0, 255]);
  frame.set([1, 0]); assert.equal(decodeUart(frame).overflow, true);
  assert.throws(() => decodeUart(new Uint8Array(19)));
  frame[0] = 2; assert.throws(() => decodeUart(frame));
  frame.set([0, 19]); assert.throws(() => decodeUart(frame));
});
test('old firmware remains usable for I2C and reports UART unavailable', async () => {
  const {bridge} = setup(async () => {}); await bridge.connect();
  assert.equal(bridge.connected, true); assert.equal(bridge.uartRx, null);
  await assert.rejects(bridge.sendUart(Uint8Array.of(1)), /UART unavailable/);
  bridge.disconnect();
});
test('UART subscriptions, binary sends, independent RX and disconnect cleanup', async () => {
  const sent = [], events = [];
  const uartTx = new EventTarget(); let subscribed = false;
  uartTx.startNotifications = async () => { subscribed = true; };
  const uart = { getCharacteristic: async uuid => uuid === UART_RX ? {writeValueWithResponse: async frame => sent.push(frame)} : uuid === UART_TX ? uartTx : null };
  const {bridge} = setup(async () => {}, uart, (kind, value) => events.push([kind, value]));
  await bridge.connect(); assert.equal(subscribed, true);
  await bridge.sendUart(Uint8Array.from({length: 40}, (_, i) => i));
  assert.deepEqual(sent.map(f => f[0]), [19,19,2]);
  const storage = new Uint8Array(24); storage.set([0,2,65,0], 2);
  uartTx.value = new DataView(storage.buffer, 2, 20);
  uartTx.dispatchEvent(new Event('characteristicvaluechanged'));
  assert.deepEqual([...events.find(e => e[0] === 'uart-data')[1].data], [65,0]);
  bridge.disconnect();
  const count = events.length;
  uartTx.dispatchEvent(new Event('characteristicvaluechanged'));
  assert.equal(events.length, count); assert.equal(bridge.uartRx, null);
});
test('UART partial send failure stops subsequent chunks without retry', async () => {
  let writes = 0;
  const uartTx = new EventTarget(); uartTx.startNotifications = async () => {};
  const uart = {getCharacteristic: async uuid => uuid === UART_RX ? {writeValueWithResponse: async () => { if (++writes === 2) throw new Error('Link lost'); }} : uartTx};
  const {bridge} = setup(async () => {}, uart); await bridge.connect();
  await assert.rejects(bridge.sendUart(new Uint8Array(60)), /Link lost/);
  assert.equal(writes, 2); assert.equal(bridge.uartBusy, false); bridge.disconnect();
});
