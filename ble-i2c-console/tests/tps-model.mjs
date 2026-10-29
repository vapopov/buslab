// Deterministic model of the TI register/burst wire framing, not hardware validation.
export function tpsModel(expectedFile, options = {}) {
  const calls = []; let staged = null, parameters = null, lastCommand = '', sent = false, complete = false, writes = 0, patchLoadedEnabled = false;
  const ascii = s => [...new TextEncoder().encode(s)];
  const transfer = async (address, write, count, action = 'transfer') => {
    const bytes = [...write]; calls.push({address, bytes, count, action});
    if (action === 'stage') { staged = bytes; return new Uint8Array(); }
    if (action === 'staged') {
      if (address !== 0x30 || lastCommand !== 'PBMs' || !parameters || !staged) throw new Error('Invalid staged burst order/address');
      if (staged.join(',') !== [...expectedFile].join(',')) throw new Error('Binary changed in transit');
      if (options.burstError) throw new Error('Burst I2C failed');
      sent = true; staged = null; return new Uint8Array();
    }
    if (address !== 0x20) throw new Error('Register access used wrong fundamental address');
    if (!count) {
      if (++writes === options.failWrite) throw new Error('I2C failed');
      if (bytes.length !== bytes[1] + 2 || bytes[1] > 64) throw new Error('Invalid register/byte-count framing');
      if (bytes[0] === 9) {
        if (bytes[1] !== 6) throw new Error('PBMs requires six parameter bytes');
        parameters = bytes.slice(2);
        const size = parameters[0] + parameters[1] * 256 + parameters[2] * 65536 + parameters[3] * 16777216;
        if (size !== expectedFile.length || parameters[4] !== 0x30 || parameters[5] !== 0x32) throw new Error('Invalid PBMs parameters');
      } else if (bytes[0] === 8) {
        lastCommand = new TextDecoder().decode(Uint8Array.from(bytes.slice(2)));
        if (lastCommand === 'PBMs' && (!parameters || !staged)) throw new Error('PBMs before buffering/parameters');
        if (lastCommand === 'PBMc') { if (!sent) throw new Error('PBMc before complete raw burst'); complete = true; }
      } else if (bytes[0] === 0x16) { patchLoadedEnabled = !!(bytes[12] & 1); }
      else if (bytes[0] !== 0x18) throw new Error('Unexpected register write');
      return new Uint8Array();
    }
    if (bytes.length !== 1) throw new Error('Read must write exactly one register byte');
    let payload, capacity;
    if (bytes[0] === 3) { payload = ascii(complete ? (options.finalMode || 'APP ') : (options.initialMode || 'PTCH')); capacity = 4; }
    else if (bytes[0] === 8) {payload = lastCommand && options.rejectCommand ? ascii('!CMD') : lastCommand && options.commandNeverClear ? ascii('PBMs') : [0,0,0,0]; capacity = 4;}
    else if (bytes[0] === 0x14) {payload = Array(11).fill(0); payload[10] = (options.notReady ? 0 : 2) | (complete && patchLoadedEnabled && !options.noPatchLoaded ? 1 : 0); capacity = 11;}
    else if (bytes[0] === 0x16) {payload=Array(11).fill(0);payload[10]=2;capacity=11;}
    else if (bytes[0] === 9) {payload = Array(64).fill(0); if (lastCommand === 'PBMs') payload[0] = options.startStatus || 0; else if (complete) payload.splice(0,4,...(options.completeStatus || [0,0,0,0])); capacity = 64;}
    else throw new Error('Unexpected register read');
    return Uint8Array.from([capacity, ...payload.slice(0,count-1)]);
  };
  return {transfer,calls};
}
