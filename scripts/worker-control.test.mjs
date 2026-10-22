import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createWorkerFixture} from './test-support/worker-fixture.mjs';
for(const mode of ['native','legacy-compat'])test(`durable local handoff uses existing transaction and finite responsibility (${mode})`,async()=>{
 const f=await createWorkerFixture({mode});try{
  await f.register();await f.publish({kind:'final'});assert.equal((await fs.readdir(f.spool)).length,1);
  let d=await f.dispatch();assert.equal(d.events[0].seen_at,null);assert.equal(d.commitments[0].status,'open');
  await f.consume();await f.schedule();await f.schedule();await f.schedule();
  await assert.rejects(()=>f.schedule(),e=>e.code==='INVARIANT_VIOLATION');
  f.setClock(f.now+10001);await f.action('worker reconcile',{});d=await f.dispatch();assert.equal(d.commitments[0].owner_state,'issued');
  f.setClock(f.now+20001);await f.action('worker reconcile',{});assert.equal((await f.dispatch()).commitments[0].owner_state,'exhausted');
  assert.equal((await f.query()).data.model.rows[0].phase,'planned');
 }finally{await f.cleanup();}
});
test('collection time cannot renew an expired host observation',async()=>{
 const f=await createWorkerFixture();try{
  await f.register();const o={route:'route-a',turn:'turn-a',state:'active',source:'fixture',source_event_at:new Date(f.now).toISOString(),collected_at:new Date(f.now).toISOString(),ttl_seconds:60,assurance:'owner-attested'};
  await f.action('worker runtime observe',{observation:o});assert.equal((await f.query('worker claim inspect',{dispatch:'dispatch-a'})).data.worker_view.claim.running,true);
  f.setClock(f.now+60001);await f.action('worker runtime observe',{observation:{...o,collected_at:new Date(f.getClock()).toISOString()}});
  assert.equal((await f.query('worker claim inspect',{dispatch:'dispatch-a'})).data.worker_view.claim.running,false);
 }finally{await f.cleanup();}
});

test('a clock rollback cannot spend the owner escalation budget early',async()=>{
 const f=await createWorkerFixture();try{await f.register();f.setClock(f.now-1);await f.action('worker reconcile',{});const d=await f.dispatch();assert.equal(d.clock_uncertain,true);assert.equal(d.commitments[0].escalations,0);assert.equal(d.commitments[0].owner_state,'waiting');}finally{await f.cleanup();}
});

test('owner escalation does not inherit the manager envelope consumption',async()=>{
 const f=await createWorkerFixture();try{await f.register();await f.publish();await f.consume();f.setClock(f.now+10001);await f.action('worker reconcile',{});const view=(await f.query('worker claim inspect',{dispatch:'dispatch-a'})).data.worker_view.claim;const owner=view.attention.find(a=>a.role==='owner');assert.ok(owner);assert.equal(owner.consumed_at,undefined);assert.equal(owner.consumed_turn,undefined);}finally{await f.cleanup();}
});
