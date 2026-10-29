import { hex, parseHex, makeRequest, makeScanRequest, scanAddresses, makeBinaryRequest, makeStageRequest, makeStagedWriteRequest } from './protocol.mjs';
import { Bridge } from './transport.mjs';
import { ScriptRunner } from './script-runner.mjs';
import { attachScriptHighlight } from './script-highlight.mjs';
import { REFERENCE_SCRIPT, LARGE_READ_SCRIPT } from './script-examples.mjs';
const $ = id => document.getElementById(id);
let busy = false, connecting = false, nextId = 1, selected = 0, current = null, history = [];
let toastTimer;
let uartSending = false, scanning = false;
let activeTab = 'i2c';
let scriptRunning = false, fileLoading = false, selectedFile = new Uint8Array(), selectedFileName = '';
let runner;
const uartDecoder = new TextDecoder();
function uartLog(text) {
  const log = $('uart-log');
  log.textContent = (log.textContent + text + '\n').slice(-64000);
  log.scrollTop = log.scrollHeight;
}
function node(tag, className, text) { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; }
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
const bridge = new Bridge(navigator.bluetooth, (kind, detail) => {
  if (kind === 'connecting') connecting = true;
  if (kind === 'connected') { connecting = false; $('connection-description').textContent = `${detail} · notifications enabled · ready for I²C`; }
  if (kind === 'disconnected') { connecting = false; $('connection-description').textContent = 'Connect to your BLE-I2C bridge to get started.'; }
  if (kind === 'uart-data') {
    if (detail.overflow) { uartDecoder.decode(); uartLog('⚠ UART overflow: some received bytes were lost.'); }
    else uartLog(`RX  ${Array.from(detail.data, hex).join(' ')}  | ${JSON.stringify(uartDecoder.decode(detail.data, { stream: true }))}`);
  }
  if (kind === 'upload-progress' && scriptRunning) { $('script-progress').hidden = false; $('script-progress').value = detail.sent / detail.total; $('script-status').textContent = `Buffering ${detail.sent} / ${detail.total} bytes on bridge…`; }
  if (kind === 'uart-error') uartLog(`ERROR  ${detail}`);
  if (kind === 'disconnected') { bridge.cancelPendingUpload(); runner?.stop(); $('scan-results').replaceChildren(); $('scan-status').textContent = 'Connect and scan to discover devices.'; uartDecoder.decode(); uartLog('Disconnected'); }
  if (kind === 'unexpected') toast('Ignored an unsolicited or late response.');
  updateControls();
});
function validate() {
  let valid = true;
  try { const bytes = parseHex($('write-data').value); $('write-count').textContent = `${bytes.length} / 32768 BYTES`; }
  catch { $('write-count').textContent = 'INVALID HEX'; }
  try {
    const r = makeRequest(nextId, $('address').value, $('write-data').value, $('read-length').value);
    $('operation').replaceChildren();
    if (r.data.length && r.readLength) {
      $('operation').append('WRITE ', node('b', '', '→'), ' REPEATED START ', node('b', '', '→'), ' READ');
    } else $('operation').textContent = r.data.length ? 'WRITE ONLY' : 'READ ONLY';
    $('validation').textContent = '';
  } catch (e) { valid = false; $('validation').textContent = e.message; }
  return valid;
}
function updateControls() {
  const connected = bridge.connected;
  $('connection-status').className = `status ${connected ? 'connected' : connecting ? 'connecting' : ''}`;
  $('connection-status').replaceChildren(node('i'), document.createTextNode(connected ? 'Connected' : connecting ? 'Connecting…' : 'Disconnected'));
  $('connect').hidden = connected;
  $('connect').disabled = connecting || !navigator.bluetooth || !window.isSecureContext;
  $('connect').textContent = connecting ? 'Connecting…' : 'Connect device ＋';
  $('disconnect').hidden = !connected;
  $('uart-send').disabled = !connected || !bridge.uartRx || uartSending || busy || scanning || scriptRunning;
  $('scan').disabled = !connected || busy || uartSending || scanning || scriptRunning || bridge.tainted;
  $('scan').textContent = scanning ? 'Scanning…' : 'Scan I²C bus';
  $('sample').hidden = activeTab !== 'i2c';
  $('uart-status').textContent = connected ? (bridge.uartRx ? 'UART ready · receiving live data' : bridge.uartUnavailableReason || 'UART unavailable. Reconnect to refresh device services.') : 'Connect to check UART availability.';
  $('script-run').disabled = !connected || busy || scanning || uartSending || scriptRunning || fileLoading || bridge.tainted;
  $('script-stop').disabled = !scriptRunning;
  ['script-source', 'script-file', 'script-example', 'script-reset'].forEach(id => $(id).disabled = scriptRunning);
  const valid = validate();
  $('send').disabled = !connected || uartSending || busy || scanning || scriptRunning || !valid || bridge.tainted;
  $('send').textContent = busy ? 'Waiting for response…' : bridge.tainted ? 'Reconnect to continue' : 'Send transaction ↗';
  ['address', 'write-data', 'read-length'].forEach(id => $(id).disabled = busy || scanning || scriptRunning);
}
$('connect').addEventListener('click', async () => {
  if (!navigator.bluetooth) return;
  try { await bridge.connect(); }
  catch (e) {
    const message = e.name === 'NotFoundError' ? 'No device selected. Make sure BLE-I2C is on and disconnected from your phone.' : e.name === 'SecurityError' ? 'Bluetooth access was blocked. Open this page directly in Chrome or Edge and allow Bluetooth access.' : `Connection failed: ${e.message}`;
    $('connection-description').textContent = message;
  }
  updateControls();
});
$('disconnect').addEventListener('click', () => bridge.disconnect());
['address', 'write-data', 'read-length'].forEach(id => $(id).addEventListener('input', updateControls));
$('command-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || uartSending || scanning || scriptRunning || !validate() || !bridge.connected || bridge.tainted) return;
  const request = makeRequest(nextId++, $('address').value, $('write-data').value, $('read-length').value);
  busy = true; updateControls();
  $('response-badge').className = 'subtle pending-animation'; $('response-badge').textContent = 'In progress…';
  const time = new Date();
  try {
    const result = await bridge.transact(request);
    current = { request, result, time, sample: false }; selected = 0;
    history.unshift(current); renderResponse(); renderHistory();
  } catch (e) {
    current = { request, result: { status: -1, message: e.message, data: new Uint8Array() }, time, sample: false };
    selected = 0; history.unshift(current); renderResponse(); renderHistory();
  } finally { busy = false; updateControls(); }
});
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && activeTab === 'i2c' && !$('send').disabled) { event.preventDefault(); $('command-form').requestSubmit(); }
});
function renderResponse() {
  const { request, result, sample } = current;
  const ok = result.status === 0;
  $('response-badge').className = sample ? 'demo-badge' : ok ? 'success-badge' : 'error-badge';
  $('response-badge').textContent = sample ? 'SAMPLE · NOT LIVE' : ok ? 'SUCCESS' : 'ERROR';
  const container = $('response-content'); container.replaceChildren();
  const meta = node('div', 'response-meta');
  meta.append(node('span', '', `0x${hex(request.address)} · ${result.data.length} ${result.data.length === 1 ? 'byte' : 'bytes'}`), node('span', '', sample ? 'Preview data' : result.elapsed !== undefined ? `${Math.round(result.elapsed)} ms · ID ${hex(request.id)}` : `ID ${hex(request.id)}`));
  container.append(meta);
  if (!ok) container.append(node('div', 'response-error', result.message));
  else if (!result.data.length) container.append(node('div', 'response-error', 'Write completed. No read bytes requested.'));
  else {
    const list = node('div', 'byte-list');
    result.data.forEach((value, index) => {
      const wrap = node('div', 'byte-wrap');
      const button = node('button', `byte ${index === selected ? 'selected' : ''}`, hex(value));
      button.setAttribute('aria-label', `Inspect byte ${index}: hexadecimal ${hex(value)}`);
      button.setAttribute('aria-pressed', String(index === selected));
      button.addEventListener('click', () => { selected = index; renderResponse(); });
      wrap.append(button, node('span', 'byte-index', `[${String(index).padStart(2, '0')}]`)); list.append(wrap);
    });
    container.append(list);
    const help = node('div', 'response-help'); const copy = node('button', 'text-button', 'Copy hex ⧉');
    copy.addEventListener('click', () => copyText(Array.from(result.data, hex).join(' ')));
    help.append(node('span', '', 'Click a byte to inspect its binary value.'), copy); container.append(help);
  }
  renderInspector();
}
function renderInspector() {
  const inspector = $('inspector'); inspector.replaceChildren();
  if (!current?.result.data.length) { inspector.className = 'inspector-empty'; inspector.append(node('span', 'inspector-placeholder', 'No response byte selected'), node('p', '', 'Run a read transaction to inspect its bits.')); return; }
  inspector.className = 'inspector-body';
  const value = current.result.data[selected], binary = value.toString(2).padStart(8, '0');
  const summary = node('div', 'value-summary'); summary.append(node('span', 'hex-big', `0x${hex(value)}`), node('span', 'value-equivalent', `${value} DEC`), node('span', 'value-equivalent', `${binary} BIN`)); inspector.append(summary);
  const bits = node('div', 'bits');
  for (let bit = 7; bit >= 0; bit--) { const on = (value >> bit) & 1; const column = node('div', 'bit-column'); column.append(node('div', 'bit-label', `b${bit}`), node('div', `bit-value ${on ? 'on' : ''}`, String(on)), node('div', 'bit-weight', String(2 ** bit))); bits.append(column); }
  inspector.append(bits);
  const weights = Array.from({length:8}, (_, i) => 7-i).filter(bit => (value >> bit) & 1).map(bit => 2 ** bit);
  const explanation = node('div', 'bit-explanation'); explanation.append(`BYTE [${String(selected).padStart(2, '0')}] · `, node('strong', '', `${weights.length ? weights.join(' + ') : '0'} = ${value}`)); inspector.append(explanation);
}
function renderHistory() {
  history = history.slice(0, 100); $('history-count').textContent = history.length;
  const container = $('history'); container.replaceChildren();
  if (!history.length) { container.append(node('div', 'history-empty', 'Your session’s transactions will appear here.')); return; }
  history.forEach(entry => {
    const { request, result, time, sample } = entry;
    const row = node('div', 'history-row');
    row.append(node('span', 'history-time', time.toLocaleTimeString([], { hour12:false })), node('span', 'history-address', `0x${hex(request.address)}`));
    const data = node('div', 'history-data');
    data.append(node('span', '', 'TX'), Array.from(request.data, hex).join(' ') || '—', `  →  READ ${request.readLength}`, node('br'), node('span', '', 'RX'), result.status === 0 ? (Array.from(result.data, hex).join(' ') || '—') : result.message);
    row.append(data, node('span', `history-result ${sample ? 'demo' : result.status === 0 ? '' : 'error'}`, sample ? 'SAMPLE' : result.status === 0 ? 'OK' : 'ERROR'));
    container.append(row);
  });
}
async function copyText(text) { try { await navigator.clipboard.writeText(text); toast('Hex bytes copied.'); } catch { toast('Clipboard is unavailable. Select the hex bytes to copy them.'); } }
$('clear').addEventListener('click', () => { history = []; renderHistory(); });
$('sample').addEventListener('click', () => {
  if (busy || scanning || scriptRunning) return;
  const request = makeRequest(0, '50', '10', '4');
  current = { request, time:new Date(), sample:true, result:{ status:0, data:Uint8Array.from([0xA0,0x3C,0x81,0]), message:'Sample' } };
  selected = 0; history.unshift(current); renderResponse(); renderHistory();
});
if (!navigator.bluetooth || !window.isSecureContext) {
  $('compatibility').hidden = false;
  $('compatibility').textContent = !window.isSecureContext ? 'Bluetooth requires HTTPS or localhost. Open the hosted app directly in Chrome or Edge.' : 'This browser does not expose Web Bluetooth. Open this page directly in desktop Chrome or Edge. You can still explore the sample byte inspector.';
}
updateControls();

$('uart-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('uart-send').disabled) return;
  try {
    const ending = { '': '', lf: '\n', crlf: '\r\n' }[$('uart-ending').value];
    const bytes = $('uart-mode').value === 'hex' ? parseHex($('uart-input').value, 4096) : new TextEncoder().encode($('uart-input').value + ending);
    if (!bytes.length) throw new Error('Enter UART data to send.');
    uartSending = true; updateControls();
    await bridge.sendUart(bytes);
    uartLog(`TX queued  ${Array.from(bytes, hex).join(' ')}`);
  } catch (e) { uartLog(`ERROR  ${e.message} Sending may have partially completed; no automatic retry.`); }
  finally { uartSending = false; updateControls(); }
});
$('uart-clear').addEventListener('click', () => { $('uart-log').textContent = ''; });

function selectTab(name, focus = false) {
  activeTab = name;
  for (const bus of ['i2c', 'uart']) {
    const selected = name === bus;
    $(`tab-${bus}`).setAttribute('aria-selected', String(selected));
    $(`tab-${bus}`).tabIndex = selected ? 0 : -1;
    $(`panel-${bus}`).hidden = !selected;
  }
  if (focus) $(`tab-${name}`).focus();
  updateControls();
}
for (const bus of ['i2c', 'uart']) {
  $(`tab-${bus}`).addEventListener('click', () => selectTab(bus));
  $(`tab-${bus}`).addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      selectTab(event.key === 'Home' ? 'i2c' : event.key === 'End' ? 'uart' : bus === 'i2c' ? 'uart' : 'i2c', true);
    }
  });
}
$('scan').addEventListener('click', async () => {
  if ($('scan').disabled) return;
  scanning = true;
  $('scan-results').replaceChildren();
  $('scan-status').textContent = 'Scanning 0x08–0x77…';
  updateControls();
  try {
    const result = await bridge.transact(makeScanRequest(nextId++));
    const addresses = scanAddresses(result);
    $('scan-status').textContent = addresses.length ? `${addresses.length} responding ${addresses.length === 1 ? 'address' : 'addresses'} · select one to use below.` : 'Scan complete. No addresses responded. Check target power, wiring and pull-ups.';
    for (const address of addresses) {
      const button = node('button', 'button secondary mono', `0x${hex(address)}`);
      button.type = 'button';
      button.addEventListener('click', () => {
        if (busy || scanning || scriptRunning) return;
        $('address').value = hex(address); updateControls();
        $('scan-status').textContent = `Selected 0x${hex(address)} for the next transaction.`;
        $('address').focus();
      });
      $('scan-results').append(button);
    }
  } catch (e) { $('scan-status').textContent = `Scan failed: ${e.message}`; }
  finally { scanning = false; updateControls(); }
});

function scriptLog(message) {
  const output = $('script-log'); output.textContent = (output.textContent + message + '\n').slice(-64000); output.scrollTop = output.scrollHeight;
}
runner = new ScriptRunner(async (address, write, readLength, action) => {
  if (!['transfer','stage','staged'].includes(action)) throw new Error('Unknown I²C operation.');
  const id = nextId++;
  const request = action === 'stage' ? makeStageRequest(id, write) : action === 'staged' ? makeStagedWriteRequest(id, address) : makeBinaryRequest(id, address, write, readLength);
  const result = await bridge.transact(request);
  if (result.status !== 0) throw new Error(result.message);
  if (action === 'stage') $('script-status').textContent = 'Binary buffered; running script…';
  return result.data;
}, (kind, detail) => {
  if (kind === 'log') scriptLog(detail);
  if (kind === 'progress') {
    $('script-progress').hidden = false;
    $('script-progress').value = Math.max(0, Math.min(1, detail.sent / detail.total));
    $('script-status').textContent = `${detail.sent} / ${detail.total} bytes · ${Math.round(100 * detail.sent / detail.total)}%`;
  }
});
try { $('script-source').value = localStorage.getItem('buslab-script') ?? REFERENCE_SCRIPT; }
catch { $('script-source').value = REFERENCE_SCRIPT; }
attachScriptHighlight($('script-source'), $('script-highlight'), $('script-highlight-code'));
$('script-source').addEventListener('input', () => { try { localStorage.setItem('buslab-script', $('script-source').value); } catch {} });
$('script-source').addEventListener('keydown', event => {
  if (event.key === 'Tab') {
    event.preventDefault(); const editor = event.target;
    editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end'); editor.dispatchEvent(new Event('input'));
  }
});
$('script-reset').addEventListener('click', () => {
  $('script-source').value = $('script-example').value === 'read' ? LARGE_READ_SCRIPT : REFERENCE_SCRIPT;
  $('script-source').dispatchEvent(new Event('input'));
});
$('script-file').addEventListener('change', async event => {
  const file = event.target.files[0]; selectedFile = new Uint8Array(); selectedFileName = ''; fileLoading = true; updateControls();
  try {
    if (!file) { $('script-file-info').textContent = 'No file selected.'; return; }
    if (file.size > 16 * 1024 * 1024) throw new Error('Select a file no larger than 16 MiB.');
    selectedFile = new Uint8Array(await file.arrayBuffer()); selectedFileName = file.name;
    $('script-file-info').textContent = `${file.name} · ${selectedFile.length} bytes · available as file`;
  } catch (e) { $('script-file-info').textContent = e.message; }
  finally { fileLoading = false; updateControls(); }
});
$('script-run').addEventListener('click', async () => {
  if ($('script-run').disabled) return;
  scriptRunning = true; $('script-log').textContent = ''; $('script-progress').hidden = true; $('script-progress').value = 0;
  $('script-status').textContent = 'Running…'; updateControls();
  try {
    await runner.run($('script-source').value, selectedFile, selectedFileName);
    $('script-status').textContent = 'Script completed.';
  } catch (e) { scriptLog(`ERROR  ${e.message}`); $('script-status').textContent = 'Script stopped or failed. Review the log before running again.'; }
  finally { scriptRunning = false; updateControls(); }
});
$('script-stop').addEventListener('click', () => { $('script-status').textContent = 'Stopping after the in-flight transaction…'; bridge.cancelPendingUpload(); runner.stop(); });
$('script-clear').addEventListener('click', () => { $('script-log').textContent = ''; });
