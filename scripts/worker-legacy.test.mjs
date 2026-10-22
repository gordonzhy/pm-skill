import test from 'node:test';
import assert from 'node:assert/strict';
import {legacyBefore,legacyDisposition} from './core/worker-legacy.mjs';
import {legacyCSV,legacyLog,createWorkerFixture} from './test-support/worker-fixture.mjs';
const d={id:'dispatch-a',work:'ATLAS-001',route:'route-a',manager:'local-owner',scope_revision:1,events:[{digest:'event-hash',envelope:{candidate:'candidate-hash'}}]};
const before=Buffer.from(legacyCSV()),after=Buffer.from(legacyCSV('受阻'));
const pending={id:'operation-a',event:'event-hash',commitment:'commitment-1',log_path:'ATLAS-001.md',...legacyBefore(before,d,{log_path:'ATLAS-001.md'})};
const log=legacyLog(d,pending.id);
test('legacy disposition requires standard columns and the exact structured manager decision',()=>{
 assert.equal(legacyDisposition(after,log,d,pending).decision,'block');
 for(const [csv,text] of [[Buffer.from('id,status\nATLAS-001,受阻\n'),log],[after,'unrelated operation-a'],[after,log.replace('candidate-hash','other-candidate')],[after,log.replace('event-hash','other-event')],[after,log.replace('scope_revision\\":1','scope_revision\\":2')],[after,log.replace('local-owner','different-manager')],[Buffer.from(after.toString().replace('dispatch-a','different-dispatch')),log],[Buffer.from(after.toString().replace('Example task','Changed scope')),log]])assert.throws(()=>legacyDisposition(csv,text,d,pending));
});
test('old coordinator intention is rejected even with a refreshed source revision',async()=>{
 const f=await createWorkerFixture();try{await f.register();await f.publish();await f.consume();const old=f.make('worker reconcile',{work:'ATLAS-001',dispatch:'dispatch-a'});await f.action('worker manager transfer',{manager:'local-owner',epoch:'epoch-b',route:'route-b',turn:'turn-b',reason:'Explicit coordinator change'});old.expected_revision=(await f.query()).source_revision;const {executeFiles}=await import('./core/file-store.mjs');await assert.rejects(()=>executeFiles(old,f.options()),e=>e.code==='ROLE_STALE');}finally{await f.cleanup();}
});
test('missing owner reaches final exhaustion without a send or restored budget',async()=>{
 const f=await createWorkerFixture();try{await f.register({owner:null});f.setClock(f.now+10001);await f.action('worker reconcile',{});assert.equal((await f.dispatch()).commitments[0].owner_state,'unavailable');f.setClock(f.now+20001);await f.action('worker reconcile',{});const d=await f.dispatch();assert.equal(d.commitments[0].owner_state,'exhausted');assert.equal(d.commitments[0].escalations,0);assert.equal(d.notifications.length,0);}finally{await f.cleanup();}
});
