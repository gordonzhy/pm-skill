import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createCase} from './test-support/worker-acceptance-adapter.mjs';
const specification=JSON.parse(await fs.readFile(new URL('./test-support/worker-scenarios.json',import.meta.url),'utf8'));
const pairs=specification.cases.flatMap(scenario=>scenario.modes.map(mode=>({scenario,mode})));
assert.equal(specification.cases.length,33);assert.equal(pairs.length,62);
const deferred=pairs.filter(({scenario,mode})=>scenario.id==='S28'&&mode==='native');
assert.equal(deferred.length,1);
const supported=pairs.filter(pair=>!deferred.includes(pair));assert.equal(supported.length,61);
for(const {scenario,mode} of supported)test(`supported-regression worker ${scenario.id} ${mode}: ${scenario.title}`,{timeout:120000},async()=>{
 const fixture=await createCase(specification.fixture,scenario.id,mode);
 try{
  for(const step of scenario.steps)await fixture.step(step);
  const actual=await fixture.inspect();assert.equal(actual.metadata.mode,mode);
  for(const key of specification.executionMatrix.requiredMetadata)assert.equal(typeof actual.metadata[key],'string',`metadata ${key}`);
  for(const [key,value] of Object.entries(scenario.expect))assert.equal(JSON.stringify(actual[key]),JSON.stringify(value),key);
 }finally{await fixture.close();}
});

// This negative contract test does not satisfy the full D3 handover requirement.
test('unsupported strong-host manager handover rejects without domain or external mutation',async()=>{
 const {fixture}=await import('./test-support/host-profile-fixture.mjs');const f=await fixture();
 try{
  await f.call('project init',{root:f.repo,identity:'manager-a',policy:'policy-a'});
  async function inventory(dir=f.state+'/execution',relative=''){let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return {};throw error;}const out={};for(const entry of entries){const name=relative+entry.name;if(entry.isDirectory())Object.assign(out,await inventory(dir+'/'+entry.name,name+'/'));else out[name]=(await fs.readFile(dir+'/'+entry.name)).toString('base64');}return out;}
  const inventoryBefore=await inventory();
  const before=await f.snapshot(),peerBefore=JSON.parse(await fs.readFile(f.base+'/host.json','utf8'));
  await assert.rejects(()=>f.call('manager handover',{proof:'host-origin',route:{host:'codex',instance:'synthetic',opaque_id:'manager-route-b',kind:'independent-task-thread',provenance:'host-origin'},previous_epoch:'epoch-a'},'owner-route'),error=>error.code==='CAPABILITY_UNAVAILABLE');
  const after=await f.snapshot(),peerAfter=JSON.parse(await fs.readFile(f.base+'/host.json','utf8'));
  assert.equal(after.source_revision,before.source_revision);assert.deepEqual(after.data.model,before.data.model);
  assert.deepEqual(peerAfter.mutations,peerBefore.mutations);assert.deepEqual(Object.keys(peerAfter.threads),Object.keys(peerBefore.threads));
  assert.deepEqual(await inventory(),inventoryBefore);
 }finally{f.bridge.close();}
});
