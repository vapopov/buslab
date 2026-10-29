import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { REFERENCE_SCRIPT } from '../script-examples.mjs';
import { ScriptRunner } from '../script-runner.mjs';
import { tpsModel } from './tps-model.mjs';

const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
async function reference(file, options = {}) {
  const model=tpsModel(file,options),delays=[],messages=[],progress=[];
  const i2c={
    write: (address,bytes)=>model.transfer(address,bytes,0),
    writeRead: (address,bytes,count)=>model.transfer(address,bytes,count),
    stage: bytes=>model.transfer(0,bytes,0,'stage'),
    writeStaged: address=>model.transfer(address,[],0,'staged'),
  };
  const fn=new AsyncFunction('i2c','file','fileName','sleep','progress','log','ascii','text','hex',REFERENCE_SCRIPT);
  await fn(i2c,file,'bundle.bin',async ms=>delays.push(ms),(sent,total)=>progress.push([sent,total]),m=>messages.push(m),s=>new TextEncoder().encode(s),b=>new TextDecoder().decode(b),b=>Array.from(b,n=>n.toString(16).padStart(2,'0')).join(' '));
  return {...model,delays,messages,progress};
}
test('TI loader stages exact binary before PBMs, supplies six parameters and streams raw to patch address',async()=>{
  const file=Uint8Array.from({length:11392},(_,i)=>(i*29)&255);
  const {calls,delays,messages,progress}=await reference(file);
  assert.equal(calls[0].action,'stage');assert.deepEqual(calls[0].bytes,[...file]);
  const writes=calls.filter(c=>c.action==='transfer'&&c.count===0);
  assert.deepEqual(writes.filter(c=>[8,9].includes(c.bytes[0])).map(c=>c.bytes),[[9,6,128,44,0,0,0x30,0x32],[8,4,80,66,77,115],[8,4,80,66,77,99]]);
  assert.equal(calls.filter(c=>c.action==='staged').length,1);
  const burstIndex=calls.findIndex(c=>c.action==='staged');
  assert.equal(calls[burstIndex].address,0x30);
  assert.equal(calls[burstIndex-1].bytes[0],9);assert.equal(calls[burstIndex-1].count,2); // PBMs status first
  assert(calls.some(c=>c.bytes[0]===9&&c.count===65)); // read full DATA1 plus length prefix
  assert.deepEqual(progress.at(-1),[11392,11392]);assert.deepEqual(delays,[1,1,20]);
  assert.match(messages.at(-1),/Post-Patch Mode: APP/);
});
test('TI loader refuses invalid file sizes and requires PTCH plus ReadyForPatch',async()=>{
  await assert.rejects(reference(new Uint8Array()),/1–32768/);
  await assert.rejects(reference(new Uint8Array(32769)),/1–32768/);
  await assert.rejects(reference(Uint8Array.of(1),{initialMode:'APP '}),/Expected PTCH/);
  await assert.rejects(reference(Uint8Array.of(1),{notReady:true}),/ReadyForPatch/);
});
test('TI loader rejects command errors, PBMs status, CRC/config errors and missing APP mode',async()=>{
  for(const [options,pattern] of [[{noPatchLoaded:true},/PatchLoaded/],[{commandNeverClear:true},/CMD1 did not clear/],[{rejectCommand:true},/!CMD/],[{startStatus:4},/PBMs failed/],[{completeStatus:[0,0,0x43,0]},/PBMc returned/],[{completeStatus:[0,0,0,0x80]},/PBMc returned/],[{finalMode:'PTCH'},/did not transition/],[{burstError:true},/Burst I2C failed/],[{failWrite:1},/I2C failed/]]) await assert.rejects(reference(Uint8Array.of(0,255),options),pattern);
});
function fakeWorker() {return {sent:[],terminated:false,postMessage(data){this.sent.push(data);},terminate(){this.terminated=true;},message(data){this.onmessage({data});}};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('script runner serializes I2C RPCs and returns bytes to worker',async()=>{
  const worker=fakeWorker(), calls=[];
  const runner=new ScriptRunner(async(address,bytes,count)=>{calls.push([address,bytes,count]);return Uint8Array.of(99);},()=>{},()=>worker);
  const done=runner.run('source',Uint8Array.of(0,255),'patch.bin');
  assert.deepEqual([...worker.sent[0].file],[0,255]);
  worker.message({type:'i2c',id:1,address:0x20,write:[9],readLength:1});
  worker.message({type:'i2c',id:2,address:0x20,write:[3],readLength:1});
  await tick(); assert.equal(calls.length,2); assert.deepEqual([...worker.sent[1].bytes],[99]);
  worker.message({type:'done'}); await done; assert.equal(worker.terminated,true); assert.equal(runner.active,null);
});
test('stopping waits for dispatched I2C and drops queued operations without retry',async()=>{
  const worker=fakeWorker();let release,writes=0;
  const runner=new ScriptRunner(()=>{writes++;return new Promise(resolve=>{release=resolve;});},()=>{},()=>worker);
  const done=runner.run('source'); const rejection=assert.rejects(done,/Script stopped/);
  worker.message({type:'i2c',id:1,address:0x20,write:[1],readLength:0});
  worker.message({type:'i2c',id:2,address:0x20,write:[2],readLength:0});
  await tick();runner.stop();assert.equal(worker.terminated,true);assert.notEqual(runner.active,null);
  release(new Uint8Array());await rejection;assert.equal(writes,1);assert.equal(runner.active,null);
});
test('actual worker exposes file and helpers and passes RPC errors back into script',async()=>{
  const source=await readFile(new URL('../script-worker.mjs',import.meta.url),'utf8');
  const messages=[], context=vm.createContext({TextEncoder,TextDecoder,Uint8Array,Map,Promise,setTimeout,performance,postMessage:m=>messages.push(m),self:{}});
  vm.runInContext(source,context);
  const running=context.self.onmessage({data:{type:'run',source:'log(fileName, hex(file)); const bytes = await i2c.writeRead(0x20,[3],40); log(bytes.length);',file:Uint8Array.of(0,255),fileName:'patch.bin'}});
  await tick();assert.equal(messages[0].message,'patch.bin 00 FF');assert.equal(messages[1].type,'i2c');
  await context.self.onmessage({data:{type:'reply',id:messages[1].id,error:'Device NACK'}});await running;
  assert.equal(messages.at(-1).type,'error');assert.match(messages.at(-1).message,/Device NACK/);
});
