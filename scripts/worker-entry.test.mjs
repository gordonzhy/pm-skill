import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createWorkerFixture} from './test-support/worker-fixture.mjs';
import {cachedRuntimeClaim} from './core/worker-runtime.mjs';
import {readWorkerConfig} from './core/worker-client.mjs';
const entry=fileURLToPath(new URL('./pm-worker.mjs',import.meta.url));
const invoke=(args,input)=>spawnSync(process.execPath,[entry,...args],{encoding:'utf8',input:input===undefined?undefined:JSON.stringify(input),env:{PATH:process.env.PATH}});
test('coverage inspection does not install and never emits the selected path',async()=>{
 const base=await fs.mkdtemp('/private/tmp/worker-entry-test-');try{const target=path.join(base,'missing'),out=invoke(['coverage','--installed-root',target]);assert.equal(out.status,0);assert.equal(JSON.parse(out.stdout).mode,'legacy-manual');assert(!out.stdout.includes(base));assert.deepEqual(await fs.readdir(base),[]);}finally{await fs.rm(base,{recursive:true,force:true});}
});
test('worker missing runtime dependency has a stable boot DTO without stderr or path',async()=>{
 const base=await fs.mkdtemp('/private/tmp/worker-boot-test-');try{const file=path.join(base,'pm-worker.mjs');await fs.copyFile(entry,file);const out=spawnSync(process.execPath,[file,'help'],{encoding:'utf8'});assert.equal(out.status,70);assert.equal(JSON.parse(out.stdout).code,'INTERNAL_ERROR');assert.equal(out.stderr,'');assert(!out.stdout.includes(base));}finally{await fs.rm(base,{recursive:true,force:true});}
});
test('cached state claims bind turn and original event time, never collection or a task phase',()=>{
 const now=Date.now(),row={session_id:'route-a',current_turn_id:'turn-a',status:'running',status_at:new Date(now-60001).toISOString(),last_seen_at:new Date(now).toISOString()};
 assert.equal(cachedRuntimeClaim(row,{route:'route-a',turn:'turn-a',now}).runtime,'unknown');
 assert.equal(cachedRuntimeClaim({...row,status_at:new Date(now).toISOString()},{route:'route-a',turn:'old-turn',now}).running,false);
 assert.equal(cachedRuntimeClaim({...row,status_at:new Date(now+1).toISOString()},{route:'route-a',turn:'turn-a',now}).running,false);
});
test('normal finish exits only after durable publication and default output hides instance data',async()=>{
 const f=await createWorkerFixture();try{await f.register();const envelope=await f.publish({kind:'final'}),config=path.join(f.base,'owner.json');await fs.writeFile(config,JSON.stringify({version:1,control_epoch:'epoch-a',mode:'native',project_id:'ATLAS',control_repo:f.repo,state:f.state,legacy_root:null}),{mode:0o600});
 const out=invoke(['finish','--config',config],{command:'worker handoff publish',idempotency_key:'finish-a',input:{work:'ATLAS-001',dispatch:'dispatch-a',envelope}});assert.equal(out.status,0);assert.equal(JSON.parse(out.stdout).handoff_published,true);assert.equal(out.stderr,'');for(const marker of [f.base,'ATLAS','dispatch-a','route-a'])assert(!out.stdout.includes(marker));await f.refresh();assert.equal((await f.dispatch()).events.length,1);
 }finally{await f.cleanup();}
});
test('legacy sources may retain owner-controlled readable permissions without central edits',async()=>{
 const f=await createWorkerFixture({mode:'legacy-compat'});try{await fs.chmod(f.evidence,0o755);for(const name of ['TASKS.csv','ATLAS-001.md'])await fs.chmod(path.join(f.evidence,name),0o644);const before=await fs.readFile(path.join(f.evidence,'TASKS.csv'));const file=path.join(f.base,'legacy.json');await fs.writeFile(file,JSON.stringify({version:1,control_epoch:'epoch-a',mode:'legacy-compat',project_id:'ATLAS',control_repo:f.repo,state:f.state,legacy_root:f.evidence}),{mode:0o600});await readWorkerConfig(file);await f.register();await f.action('worker reconcile',{});assert.deepEqual(await fs.readFile(path.join(f.evidence,'TASKS.csv')),before);
 }finally{await f.cleanup();}
});
test('private config rejects unknown fields without echoing supplied content',async()=>{
 const f=await createWorkerFixture();try{const file=path.join(f.base,'invalid.json');await fs.writeFile(file,JSON.stringify({version:1,control_epoch:'epoch-a',mode:'native',project_id:'ATLAS',control_repo:f.repo,state:f.state,legacy_root:null,secret:'SYNTHETIC_PRIVATE_SENTINEL'}),{mode:0o600});const out=invoke(['request','--config',file],{});assert.notEqual(out.status,0);assert(!out.stdout.includes('SYNTHETIC_PRIVATE_SENTINEL'));assert(!out.stdout.includes(f.base));assert.equal(out.stderr,'');}finally{await f.cleanup();}
});
