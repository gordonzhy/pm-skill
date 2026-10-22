import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FileStore, executeFiles, emptyRevision } from './core/file-store.mjs';
import { csvRead, csvBytes, rawHash } from './core/file-model.mjs';
import { validate, DEFINITIONS } from './core/contracts.mjs';
import { capabilities } from './core/registry.mjs';

const supported=process.platform==='darwin';
const moduleURL=new URL('./core/file-store.mjs',import.meta.url).href;
const driver=`const {executeFiles}=await import(${JSON.stringify(moduleURL)});const r=JSON.parse(process.argv[1]),options=JSON.parse(process.argv[2]);let i=0;options.fault=async name=>{process.stdout.write(JSON.stringify({checkpoint:++i,name})+'\\n');if(i===Number(process.argv[3]))process.kill(process.pid,'SIGKILL');};try{const result=await executeFiles(r,options);process.stdout.write(JSON.stringify({result})+'\\n');}catch(e){process.stdout.write(JSON.stringify({error:e.code??'NATIVE_ERROR',caseId:e.caseId})+'\\n');process.exitCode=1;}`;
const scope={goal:'Example deliverable',allowed_writes:['src'],exclusions:[],criteria:['criterion-1']};
let sequence=0;
const temporary=async prefix=>fs.mkdtemp(path.join(await fs.realpath(process.env.PM_TEST_ROOT??'/private/tmp'),prefix));
async function fixture({git=false}={}) {
  const base=await temporary('project-files-test-');const repo=base+'/repo',state=base+'/state';await fs.mkdir(repo);await fs.mkdir(state,{mode:0o700});
  if(git){gitRun(repo,['init','-b','main']);await fs.writeFile(repo+'/.gitignore','.pm-local/\n');}
  let revision=emptyRevision();
  const make=(command,input,extra={})=>({protocol:'project-files/1',command,repo,project_id:'ATLAS',actor_proof:'local-owner',idempotency_key:`request-${++sequence}`,expected_revision:revision,input,...extra});
  const query=(extra={})=>executeFiles({protocol:'project-files/1',query:'snapshot',repo,projection:'private-local',snapshot_token:null,input:{},...extra},{state});
  const run=async(command,input,extra)=>{const request=make(command,input,extra),out=await executeFiles(request,{state});if(out.source_revision)revision=out.source_revision;return {request,out};};
  const init=await run('project init',{root:repo,identity:'local-owner',policy:'policy-1'});assert.equal(init.out.exit,0);
  return {base,repo,state,make,query,run,init,create:()=>run('work create',{work:'ATLAS-01',scope,label:'Example',deps:[],impact:[]}),cleanup:()=>fs.rm(base,{recursive:true,force:true})};
}
function gitRun(repo,args,input) {
  const r=spawnSync('git',['-C',repo,...args],{input,encoding:'utf8',env:{PATH:process.env.PATH,HOME:'/private/tmp',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Example Author',GIT_AUTHOR_EMAIL:'author@example.invalid',GIT_COMMITTER_NAME:'Example Author',GIT_COMMITTER_EMAIL:'author@example.invalid'}});
  if(r.status!==0)throw new Error(`git test command failed: ${args[0]}`);return r.stdout.trim();
}
function child(request,state,kill=0) {
  const r=spawnSync(process.execPath,['--input-type=module','-e',driver,JSON.stringify(request),JSON.stringify({state}),String(kill)],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:state},maxBuffer:8*1024*1024});
  const lines=r.stdout.split('\n').filter(Boolean).flatMap(l=>{try{return [JSON.parse(l)];}catch{return [];}});return {...r,lines,last:lines.at(-1),checkpoints:lines.filter(l=>l.checkpoint)};
}
async function tree(root) {
  const out={};async function walk(p){for(const e of await fs.readdir(p,{withFileTypes:true})){const full=p+'/'+e.name,st=await fs.lstat(full);out[full.slice(root.length)]={mode:st.mode,mtime:st.mtimeMs,size:st.size,...(!e.isDirectory()?{hash:rawHash(await fs.readFile(full))}:{})};if(e.isDirectory())await walk(full);}}await walk(root);return out;
}
const code=(expected,fn)=>assert.rejects(fn,e=>e.code===expected);

test('local commands atomically associate CSV, detail, audit, commitment, obligation and durable replay',{skip:!supported},async()=>{
  const f=await fixture();try{
    const created=await f.create();assert.equal(created.out.exit,0);
    const q=await f.query();validate(q,DEFINITIONS.QueryResult);assert.equal(q.data.model.rows[0].title,'Example');assert.equal(q.data.model.tasks[0].audit.length,1);
    const grant={id:'grant-1',project_id:'ATLAS',work_ids:['ATLAS-01'],scope_revision:1,issuer:'local-owner',actions:['commit-start'],write_roots:['src'],protected_actions:[],evidence_ref:'evidence-1',issued_at:new Date().toISOString()};
    await f.run('grant record',{grant,evidence:['evidence-1']});await f.run('work commit-start',{work:'ATLAS-01',responsible:'local-owner',policy:'policy-1',reason:'Example authorization'});
    const s=await f.query();assert.equal(s.data.model.tasks[0].obligations[0].lifecycle,'active');assert.equal(s.data.model.tasks[0].commitments.length,1);
    const replay=await executeFiles(created.request,{state:f.state});assert.equal(replay.operation_receipt,created.out.operation_receipt);assert.equal((await f.query()).data.model.tasks[0].audit.length,2);
    await code('IDEMPOTENCY_CONFLICT',()=>executeFiles({...created.request,input:{...created.request.input,label:'Different'}},{state:f.state}));
    await code('VERSION_CONFLICT',()=>executeFiles(f.make('work create',{work:'ATLAS-02',scope,label:'Second',deps:[],impact:[]},{expected_revision:created.request.expected_revision}),{state:f.state}));
  }finally{await f.cleanup();}
});
test('queries are byte-for-byte read-only and summary never emits private labels',{skip:!supported},async()=>{
  const f=await fixture();try{await f.create();const before=await tree(f.base),q=await f.query();assert.equal(q.stale,false);assert.deepEqual(await tree(f.base),before);const summary=await f.query({projection:'summary'});assert(!JSON.stringify(summary).includes('ATLAS'));assert(!JSON.stringify(summary).includes('Example'));}finally{await f.cleanup();}
});
test('real SIGKILL at every instrumented create boundary automatically recovers and never serves mixed source',{skip:!supported,timeout:180000},async t=>{
  const baseline=await fixture();const req=baseline.make('work create',{work:'ATLAS-01',scope,label:'Example',deps:[],impact:[]});const trace=child(req,baseline.state);assert.equal(trace.last.result.exit,0);const count=trace.checkpoints.length;await baseline.cleanup();assert(count>50);
  for(let i=1;i<=count;i++){
    const f=await fixture();try{
      const r=f.make('work create',{work:'ATLAS-01',scope,label:'Example',deps:[],impact:[]});const killed=child(r,f.state,i);assert.equal(killed.signal,'SIGKILL',`checkpoint ${i}`);
      const before=await tree(f.base);const q=await f.query();assert.deepEqual(await tree(f.base),before,`query wrote at ${i}`);assert([0,1].includes(q.data.model.rows.length));if(q.data.model.rows.length)assert.equal(q.data.model.tasks.length,1);
      const out=await executeFiles(r,{state:f.state});assert.equal(out.exit,0,`recovery ${i}`);const final=await f.query();assert.equal(final.stale,false);assert.equal(final.data.model.rows.length,1);assert.equal(final.data.model.tasks[0].audit.length,1,`duplicate audit at ${i}`);
    }finally{await f.cleanup();}
  }
  t.diagnostic(JSON.stringify({kill_windows:count,boundaries:trace.checkpoints.map(x=>x.name)}));
});
test('decided IO failure retains recovery evidence; next command continues after environment recovers',{skip:!supported},async()=>{
  const f=await fixture();try{const r=f.make('work create',{work:'ATLAS-01',scope,label:'Example',deps:[],impact:[]});let decided=false;
    const out=await executeFiles(r,{state:f.state,fault:async name=>{if(name==='DECIDED')decided=true;if(decided&&name.startsWith('before-write:TASKS.csv')){const e=new Error('simulated disk full');e.code='ENOSPC';throw e;}}});assert.equal(out.code,'IO_PENDING');assert.equal((await f.query()).stale,true);assert.equal((await executeFiles(r,{state:f.state})).exit,0);
  }finally{await f.cleanup();}
});
test('third bytes remain untouched and a typed exact-case resolution preserves the original audit',{skip:!supported},async()=>{
  const f=await fixture();try{await f.create();const r=f.make('work amend',{work:'ATLAS-01',scope,label:'Intended',impact:[]});
    const trace=child(r,f.state);assert.equal(trace.last.result.exit,0);
    // A fresh operation is interrupted after its CSV target was replaced.
    const r2=f.make('work amend',{work:'ATLAS-01',scope,label:'Next',impact:[]},{expected_revision:trace.last.result.source_revision});
    let stopped=false;const out=await executeFiles(r2,{state:f.state,fault:async name=>{if(name==='applied:TASKS.csv'&&!stopped){stopped=true;throw new Error('IO interruption');}}});assert.equal(out.code,'IO_PENDING');
    const csv=csvRead(await fs.readFile(f.repo+'/TASKS.csv'));csv[0].title='Third';await fs.writeFile(f.repo+'/TASKS.csv',csvBytes(csv));
    let conflict;try{await executeFiles(r2,{state:f.state});}catch(e){conflict=e;}assert.equal(conflict.code,'RECOVERY_CONFLICT');assert.equal(csvRead(await fs.readFile(f.repo+'/TASKS.csv'))[0].title,'Third');
    const c=JSON.parse(await fs.readFile(f.repo+`/.pm-local/cases/${conflict.caseId}.json`,'utf8')).value;
    const resolve=f.make('project resolve',{case_id:c.id,expected_case_digest:c.case_digest,decision:'adopt-authorized-structured-change',authorization_refs:['local-owner'],semantic_input:{work_id:'ATLAS-01',title:'Chosen',superseded_intents:c.units.map(x=>x.txid),reason:'Example revised label'}});
    const resolved=await executeFiles(resolve,{state:f.state});assert.equal(resolved.exit,0);assert.equal((await f.query()).data.model.rows[0].title,'Chosen');assert.equal((await executeFiles(r2,{state:f.state})).operation_receipt,(await executeFiles(r2,{state:f.state})).operation_receipt);
  }finally{await f.cleanup();}
});
test('later durable protection is automatically joined before publishing interrupted work',{skip:!supported},async()=>{
  const f=await fixture();try{await f.create();const r=f.make('work amend',{work:'ATLAS-01',scope,label:'Updated',impact:[]});
    const out=await executeFiles(r,{state:f.state,fault:async name=>{if(name==='DECIDED')throw new Error('interruption');}});assert.equal(out.code,'IO_PENDING');
    const p=await f.run('work pause',{work:'ATLAS-01',resolver:'local-owner',next:'review',protection_refs:[],proof:'local-owner'});assert.equal(p.out.exit,0);
    const q=await f.query();assert.equal(q.data.model.rows[0].control,'paused');assert.equal(q.data.model.rows[0].title,'Updated');assert.equal(q.protection_seq,1);assert.equal(q.stale,false);const replay=await executeFiles(r,{state:f.state});const effective=replay.steps.find(s=>s.name==='effective-control');assert.equal(effective.facts.effective_control,'paused');assert.equal(effective.facts.protection_seq,1);
  }finally{await f.cleanup();}
});
test('independent CLI writers contend on the kernel lock then recheck CAS',{skip:!supported},async()=>{
  const f=await fixture();try{const a=f.make('work create',{work:'ATLAS-01',scope,label:'A',deps:[],impact:[]}),b=f.make('work create',{work:'ATLAS-02',scope,label:'B',deps:[],impact:[]});
    const run=r=>new Promise(resolve=>{const p=spawn(process.execPath,['--input-type=module','-e',driver,JSON.stringify(r),JSON.stringify({state:f.state}),'0'],{env:{PATH:process.env.PATH,HOME:f.state}});let output='';p.stdout.on('data',x=>output+=x);p.on('close',()=>resolve(output.trim().split('\n').map(JSON.parse).at(-1)));});
    const outputs=await Promise.all([run(a),run(b)]);assert.equal(outputs.filter(x=>x.result?.exit===0).length,1);assert.equal(outputs.filter(x=>x.error==='VERSION_CONFLICT').length,1);assert.equal((await f.query()).data.model.rows.length,1);
  }finally{await f.cleanup();}
});
test('deleted stable lock identity cannot be recreated to bypass the original holder',{skip:!supported},async()=>{
  const f=await fixture();try{const files=await fs.readdir(f.state);await fs.unlink(f.state+'/'+files.find(x=>x.endsWith('.lock')));await code('RECOVERY_REQUIRED',()=>f.query());await code('LOCK_UNAVAILABLE',()=>executeFiles(f.init.request,{state:f.state}));}finally{await f.cleanup();}
});
test('unknown input authority and symlinked managed paths reject without business writes',{skip:!supported},async()=>{
  const f=await fixture();try{const before=await tree(f.base);await code('AUTH_REQUIRED',()=>executeFiles(f.make('work create',{work:'ATLAS-01',scope,label:'Example',deps:[],impact:[]},{actor_proof:'forged'}),{state:f.state}));assert.deepEqual(await tree(f.base),before);await fs.mkdir(f.repo+'/work-items');await fs.symlink(f.base+'/other',f.repo+'/work-items/ATLAS-01.yaml');await code('PATH_UNSAFE',()=>f.create());}finally{await f.cleanup();}
});
test('lost publication and snapshot are rebuilt only by an explicit authorized write',{skip:!supported},async()=>{
  const f=await fixture();try{await f.create();const original=await f.query();await fs.unlink(f.repo+'/.pm-local/publication.json');await fs.rm(f.repo+'/.pm-local/snapshots',{recursive:true});await fs.mkdir(f.repo+'/.pm-local/snapshots');const before=await tree(f.base);await code('RECOVERY_REQUIRED',()=>f.query());assert.deepEqual(await tree(f.base),before);await f.run('project reconcile',{});const q=await f.query();assert.equal(q.source_revision,original.source_revision);assert.equal(q.generation,original.generation);assert.equal(q.data.model.rows.length,1);}finally{await f.cleanup();}
});
test('real target-directory permissions fail after DECIDED and recover without manual source edits',{skip:!supported},async()=>{
  const f=await fixture();try{await f.create();const request=f.make('work amend',{work:'ATLAS-01',scope,label:'Updated',impact:[]});let restricted=false;
    const out=await executeFiles(request,{state:f.state,fault:async name=>{if(name==='DECIDED'){await fs.chmod(f.repo+'/work-items',0o500);restricted=true;}}});assert(restricted);assert.equal(out.code,'IO_PENDING');assert.equal((await f.query()).stale,true);await fs.chmod(f.repo+'/work-items',0o700);assert.equal((await executeFiles(request,{state:f.state})).exit,0);assert.equal((await f.query()).data.model.rows[0].title,'Updated');
  }finally{await fs.chmod(f.repo+'/work-items',0o700).catch(()=>{});await f.cleanup();}
});
test('every protection-chain checkpoint SIGKILL resumes the unique final protected publication',{skip:!supported,timeout:240000},async t=>{
  const setup=async()=>{const f=await fixture();await f.create();const r=f.make('work amend',{work:'ATLAS-01',scope,label:'Updated',impact:[]});await executeFiles(r,{state:f.state,fault:async name=>{if(name==='DECIDED')throw new Error('interrupted predecessor');}});return {f,r,p:f.make('work pause',{work:'ATLAS-01',resolver:'local-owner',next:'review',protection_refs:[],proof:'local-owner'})};};
  const baseline=await setup(),trace=child(baseline.p,baseline.f.state);assert.equal(trace.last.result.exit,0);await baseline.f.cleanup();
  for(let i=1;i<=trace.checkpoints.length;i++){
    const {f,r,p}=await setup();try{assert.equal(child(p,f.state,i).signal,'SIGKILL');const q=await f.query();if(q.protection_seq>0&&q.data.model.rows[0].control==='enabled')assert(q.data.effective_protection_overlay.some(x=>x.deny));const out=await executeFiles(p,{state:f.state});assert.equal(out.exit,0,`protection recovery ${i}`);const final=await f.query();assert.equal(final.data.model.rows[0].control,'paused');assert.equal(final.data.model.rows[0].title,'Updated');assert.equal(final.protection_seq,1);assert.equal((await executeFiles(r,{state:f.state})).exit,0);}finally{await f.cleanup();}
  }
  t.diagnostic(JSON.stringify({protection_kill_windows:trace.checkpoints.length,boundaries:trace.checkpoints.map(x=>x.name)}));
});
test('a protection accepted after snapshot construction is merged before the publication gate',{skip:!supported},async()=>{
  const f=await fixture();try{await f.create();const p=f.make('work pause',{work:'ATLAS-01',resolver:'local-owner',next:'review',protection_refs:[],proof:'local-owner'});
    // Stop the separate protector immediately after its deny record becomes durable.
    let injected=false;
    const request=f.make('work amend',{work:'ATLAS-01',scope,label:'New label',impact:[]});
    const result=await executeFiles(request,{state:f.state,fault:async name=>{if(name==='SNAPSHOT_READY'&&!injected){injected=true;const store=new FileStore(f.repo,{state:f.state,fault:async n=>{if(n==='PROTECTION_DURABLE')throw new Error('stop after P');}});const x=await store.protect(p);assert.equal(x.code,'PROTECTION_PENDING');}}});
    assert.equal(result.exit,0);const q=await f.query();assert.equal(q.data.model.rows[0].control,'paused');assert.equal(q.protection_seq,1);
  }finally{await f.cleanup();}
});
test('ordinary Git anchor changes refresh automatically while business rollback stays frozen',{skip:!supported},async()=>{
  const f=await fixture({git:true});try{await f.create();gitRun(f.repo,['add','TASKS.csv','.pm/project.yaml','work-items/ATLAS-01.yaml','.gitignore']);gitRun(f.repo,['commit','-m','Example initial state']);const before=await f.query();assert.equal(before.stale,true);await f.run('project reconcile',{});assert.equal((await f.query()).stale,false);await f.run('work amend',{work:'ATLAS-01',scope,label:'Updated',impact:[]});gitRun(f.repo,['checkout','--','TASKS.csv']);await code('RECOVERY_CONFLICT',()=>f.run('project reconcile',{}));assert.equal(csvRead(await fs.readFile(f.repo+'/TASKS.csv'))[0].title,'Example');}finally{await f.cleanup();}
});
async function mergeFixture() {
  const f=await fixture({git:true});await f.create();gitRun(f.repo,['add','.']);gitRun(f.repo,['commit','-m','Example base']);
  gitRun(f.repo,['checkout','-b','other']);let rows=csvRead(await fs.readFile(f.repo+'/TASKS.csv'));rows[0].title='Other';await fs.writeFile(f.repo+'/TASKS.csv',csvBytes(rows));gitRun(f.repo,['add','TASKS.csv']);gitRun(f.repo,['commit','-m','Example other label']);
  gitRun(f.repo,['checkout','main']);rows=csvRead(await fs.readFile(f.repo+'/TASKS.csv'));rows[0].title='Main';await fs.writeFile(f.repo+'/TASKS.csv',csvBytes(rows));gitRun(f.repo,['add','TASKS.csv']);gitRun(f.repo,['commit','-m','Example main label']);
  const merge=spawnSync('git',['-C',f.repo,'merge','other'],{env:{PATH:process.env.PATH,HOME:f.state,GIT_AUTHOR_NAME:'Example Author',GIT_AUTHOR_EMAIL:'author@example.invalid',GIT_COMMITTER_NAME:'Example Author',GIT_COMMITTER_EMAIL:'author@example.invalid'},encoding:'utf8'});assert.equal(merge.status,1);
  let conflict;try{await f.run('project reconcile',{});}catch(e){conflict=e;}assert(['RECOVERY_CONFLICT','GIT_CONFLICT'].includes(conflict?.code));
  const c=JSON.parse(await fs.readFile(f.repo+`/.pm-local/cases/${conflict.caseId}.json`)).value;
  const hashes=[1,2,3].map(n=>rawHash(Buffer.from(gitRun(f.repo,['show',`:${n}:TASKS.csv`])+'\n')));
  const request=f.make('project resolve',{case_id:c.id,expected_case_digest:c.case_digest,decision:'adopt-authorized-structured-change',authorization_refs:['local-owner'],semantic_input:{work_id:'ATLAS-01',title:'Merged',superseded_intents:[],reason:'Example merge resolution',merge_resolution:{work_id:'ATLAS-01',field:'title',value:'Merged',stage_digests:hashes}}});
  return {...f,resolveRequest:request};
}
test('typed CSV merge resolution updates only its index path and preserves merge control state',{skip:!supported},async()=>{
  const f=await mergeFixture();try{const head=gitRun(f.repo,['rev-parse','HEAD']),mergeHead=await fs.readFile(f.repo+'/.git/MERGE_HEAD','utf8');const out=await executeFiles(f.resolveRequest,{state:f.state});assert.equal(out.exit,0);assert.equal((await f.query()).data.model.rows[0].title,'Merged');assert.equal(gitRun(f.repo,['ls-files','--unmerged']),'');assert.equal(gitRun(f.repo,['rev-parse','HEAD']),head);assert.equal(await fs.readFile(f.repo+'/.git/MERGE_HEAD','utf8'),mergeHead);}finally{await f.cleanup();}
});
test('foreign index.lock, including equal bytes on a different inode, is never removed',{skip:!supported},async()=>{
  const f=await mergeFixture();try{await fs.writeFile(f.repo+'/.git/index.lock',await fs.readFile(f.repo+'/.git/index'));const before=await fs.readFile(f.repo+'/.git/index.lock');await code('LOCK_UNAVAILABLE',()=>executeFiles(f.resolveRequest,{state:f.state}));assert.deepEqual(await fs.readFile(f.repo+'/.git/index.lock'),before);assert(gitRun(f.repo,['ls-files','--unmerged']).length);}finally{await f.cleanup();}
});
async function resolutionFixture(git=false) {
  if(git)return mergeFixture();
  const f=await fixture();await f.create();const request=f.make('work amend',{work:'ATLAS-01',scope,label:'Intended',impact:[]});
  await executeFiles(request,{state:f.state,fault:async name=>{if(name==='applied:TASKS.csv')throw new Error('interrupted');}});
  const rows=csvRead(await fs.readFile(f.repo+'/TASKS.csv'));rows[0].title='Third';await fs.writeFile(f.repo+'/TASKS.csv',csvBytes(rows));
  let conflict;try{await executeFiles(request,{state:f.state});}catch(e){conflict=e;}const c=JSON.parse(await fs.readFile(f.repo+`/.pm-local/cases/${conflict.caseId}.json`)).value;
  return {...f,resolveRequest:f.make('project resolve',{case_id:c.id,expected_case_digest:c.case_digest,decision:'adopt-authorized-structured-change',authorization_refs:['local-owner'],semantic_input:{work_id:'ATLAS-01',title:'Chosen',superseded_intents:c.units.map(x=>x.txid),reason:'Example revised label'}})};
}
for(const git of [false,true])test(`every ${git?'Git seed/link/index':'third-byte resolve'} checkpoint SIGKILL preserves evidence and resumes safely`,{skip:!supported,timeout:600000},async t=>{
  const baseline=await resolutionFixture(git),trace=child(baseline.resolveRequest,baseline.state);assert.equal(trace.last.result.exit,0);await baseline.cleanup();
  for(let i=1;i<=trace.checkpoints.length;i++){
    const f=await resolutionFixture(git);try{
      assert.equal(child(f.resolveRequest,f.state,i).signal,'SIGKILL',`kill ${i}`);
      const before=await tree(f.base);try{await f.query();}catch(e){assert(['LOCK_UNAVAILABLE','GIT_CONFLICT','RECOVERY_REQUIRED'].includes(e.code));}assert.deepEqual(await tree(f.base),before);
      // An undecided R is abandoned, retaining the old exact case; a decided R automatically continues.
      try{await f.run('project reconcile',{});}catch(e){assert(['RECOVERY_CONFLICT','GIT_CONFLICT','LOCK_UNAVAILABLE'].includes(e.code));}
      let q;try{q=await f.query();}catch{/* unresolved merge still has no current clean snapshot */}
      if(!q||q.stale){
        let request=f.resolveRequest;
        const active=await new FileStore(f.repo,{state:f.state}).begin().then(async s=>{try{return await s.pending();}finally{await s.end();}});
        if(!active.length){
          const cases=await fs.readdir(f.repo+'/.pm-local/cases');const matching=[];
          for(const file of cases){if(!file.endsWith('.json'))continue;const c=JSON.parse(await fs.readFile(f.repo+'/.pm-local/cases/'+file)).value;if(!c.units.length)matching.push(c);}
          if(git&&matching.length){const c=matching.at(-1);request={...request,input:{...request.input,case_id:c.id,expected_case_digest:c.case_digest}};}
        }
        const out=await executeFiles(request,{state:f.state});assert.equal(out.exit,0,`resolve retry ${i}`);
      }
      q=await f.query();assert.equal(q.stale,false,`stale ${i}`);assert.equal(q.data.model.rows[0].title,git?'Merged':'Chosen',`title ${i}`);if(git)assert.equal(gitRun(f.repo,['ls-files','--unmerged']),'');
    }finally{await f.cleanup();}
  }
  t.diagnostic(JSON.stringify({kind:git?'git-resolution':'resolution',kill_windows:trace.checkpoints.length,boundaries:trace.checkpoints.map(x=>x.name)}));
});
test('a same-hash foreign lock cannot impersonate the immutable seed inode',{skip:!supported},async()=>{
  const f=await mergeFixture();try{let injected=false,foreign;
    await code('LOCK_UNAVAILABLE',()=>executeFiles(f.resolveRequest,{state:f.state,fault:async name=>{if(name==='PREPARED'&&!injected){injected=true;for(const id of await fs.readdir(f.repo+'/.pm-local/transactions')){const p=f.repo+'/.pm-local/transactions/'+id+'/journal.json';try{const j=JSON.parse(await fs.readFile(p)).value;if(j.git_index){foreign=Buffer.from(j.git_index.after,'base64');await fs.writeFile(f.repo+'/.git/index.lock',foreign);}}catch(e){if(e.code!=='ENOENT')throw e;}}}}}));
    assert(injected);assert.deepEqual(await fs.readFile(f.repo+'/.git/index.lock'),foreign);
  }finally{await f.cleanup();}
});
test('a late third-byte edit before physical replacement is retained',{skip:!supported},async()=>{
  const f=await fixture();try{await f.create();let injected=false;
    const r=f.make('work amend',{work:'ATLAS-01',scope,label:'Intended',impact:[]});
    await code('RECOVERY_CONFLICT',()=>executeFiles(r,{state:f.state,fault:async name=>{if(name==='before-write:TASKS.csv'&&!injected){injected=true;const rows=csvRead(await fs.readFile(f.repo+'/TASKS.csv'));rows[0].title='Third';await fs.writeFile(f.repo+'/TASKS.csv',csvBytes(rows));}}}));
    assert.equal(csvRead(await fs.readFile(f.repo+'/TASKS.csv'))[0].title,'Third');
  }finally{await f.cleanup();}
});
test('replacing a parent directory cannot reuse matching bytes to bypass the journal identity',{skip:!supported},async()=>{
  const f=await fixture();try{await f.create();let injected=false;
    const r=f.make('work amend',{work:'ATLAS-01',scope,label:'Intended',impact:[]});
    await code('RECOVERY_CONFLICT',()=>executeFiles(r,{state:f.state,fault:async name=>{if(name==='before-write:work-items/ATLAS-01.yaml'&&!injected){injected=true;await fs.rename(f.repo+'/work-items',f.repo+'/original-items');await fs.mkdir(f.repo+'/work-items',{mode:0o700});await fs.copyFile(f.repo+'/original-items/ATLAS-01.yaml',f.repo+'/work-items/ATLAS-01.yaml');}}}));
    assert.equal((JSON.parse(await fs.readFile(f.repo+'/work-items/ATLAS-01.yaml'))).audit.length,1);
  }finally{await f.cleanup();}
});
test('a lost local protection copy cannot erase an accepted unpublished deny',{skip:!supported},async()=>{
  const f=await fixture();try{await f.create();const p=f.make('work pause',{work:'ATLAS-01',resolver:'local-owner',next:'review',protection_refs:[],proof:'local-owner'});
    const result=await executeFiles(p,{state:f.state,fault:async name=>{if(name==='PROTECTION_DURABLE')throw new Error('interrupt after durable P');}});assert.equal(result.code,'PROTECTION_PENDING');await fs.unlink(f.repo+'/.pm-local/protection/1.json');const q=await f.query();assert(q.stale);assert.equal(q.protection_seq,1);assert(q.data.effective_protection_overlay.some(x=>x.deny));await f.run('project reconcile',{});assert.equal((await f.query()).data.model.rows[0].control,'paused');
  }finally{await f.cleanup();}
});
test('local transaction evidence is ignored by Git without manual ignore-file edits',{skip:!supported},async()=>{
  const f=await fixture();try{gitRun(f.repo,['init','-b','main']);assert.equal(gitRun(f.repo,['check-ignore','.pm-local/identity.json']),'.pm-local/identity.json');}finally{await f.cleanup();}
});
test('query does not execute a configured fsmonitor program',{skip:!supported},async()=>{
  const f=await fixture({git:true});try{await f.create();await fs.writeFile(f.repo+'/probe-hook','#!/bin/sh\ntouch hook-was-run\nprintf "\\0"\n',{mode:0o700});gitRun(f.repo,['config','core.fsmonitor','./probe-hook']);await f.run('project reconcile',{});await fs.unlink(f.repo+'/hook-was-run').catch(()=>{});const before=await tree(f.base);await f.query();assert.deepEqual(await tree(f.base),before);await assert.rejects(fs.stat(f.repo+'/hook-was-run'),e=>e.code==='ENOENT');}finally{await f.cleanup();}
});
test('real stdin CLI initializes, writes, reads and replays without a workbench',{skip:!supported},async()=>{
  const base=await temporary('project-files-cli-');try{await fs.mkdir(base+'/repo');await fs.mkdir(base+'/home');const cli=fileURLToPath(new URL('./pm-cli.mjs',import.meta.url));const invoke=request=>{
    const r=spawnSync(process.execPath,[cli,...(request.command??request.query).split(' ')],{input:JSON.stringify(request),encoding:'utf8',env:{PATH:process.env.PATH,HOME:base+'/home'}});assert.equal(r.stderr,'');assert.equal(r.status,0,r.stdout);return JSON.parse(r.stdout);
  };
    const baseRequest={protocol:'project-files/1',repo:base+'/repo',project_id:'ATLAS',actor_proof:'local-owner',expected_revision:emptyRevision(),idempotency_key:'initialize',command:'project init',input:{root:base+'/repo',identity:'local-owner',policy:'policy-1'}};
    const initialized=invoke(baseRequest);const create={...baseRequest,expected_revision:initialized.source_revision,idempotency_key:'create',command:'work create',input:{work:'ATLAS-01',scope,label:'PRIVATE_SENTINEL_EXAMPLE',deps:[],impact:[]}};
    const created=invoke(create);validate(created,DEFINITIONS.Result);assert.equal(invoke(create).operation_receipt,created.operation_receipt);
    const summary=invoke({protocol:'project-files/1',query:'snapshot',repo:base+'/repo',projection:'summary',snapshot_token:null,input:{}});assert(!JSON.stringify(summary).includes('PRIVATE_SENTINEL_EXAMPLE'));assert(!JSON.stringify(created).includes('PRIVATE_SENTINEL_EXAMPLE'));
  }finally{await fs.rm(base,{recursive:true,force:true});}
});
test('capability discovery provides the exact empty-source CAS token',()=>assert.equal(capabilities().empty_project_revision,emptyRevision()));
test('every initial bootstrap and init transaction checkpoint SIGKILL is resumable',{skip:!supported,timeout:240000},async t=>{
  const setup=async()=>{const base=await temporary('project-files-init-');await fs.mkdir(base+'/repo');await fs.mkdir(base+'/state',{mode:0o700});const request={protocol:'project-files/1',command:'project init',repo:base+'/repo',project_id:'ATLAS',actor_proof:'local-owner',idempotency_key:'initialize',expected_revision:emptyRevision(),input:{root:base+'/repo',identity:'local-owner',policy:'policy-1'}};return {base,request,state:base+'/state'};};
  const baseline=await setup(),trace=child(baseline.request,baseline.state);assert.equal(trace.last.result.exit,0);await fs.rm(baseline.base,{recursive:true});
  for(let i=1;i<=trace.checkpoints.length;i++){const f=await setup();let failed=false;try{assert.equal(child(f.request,f.state,i).signal,'SIGKILL');const before=await tree(f.base);try{await executeFiles({protocol:'project-files/1',query:'snapshot',repo:f.request.repo,projection:'private-local',snapshot_token:null,input:{}},{state:f.state});}catch(e){assert(['RECOVERY_REQUIRED','LOCK_UNAVAILABLE'].includes(e.code));}assert.deepEqual(await tree(f.base),before);const result=await executeFiles(f.request,{state:f.state});assert.equal(result.exit,0,`bootstrap recovery ${i}`);const q=await executeFiles({protocol:'project-files/1',query:'snapshot',repo:f.request.repo,projection:'private-local',snapshot_token:null,input:{}},{state:f.state});assert.equal(q.data.model.project.project_audit.length,1);assert.equal(q.generation,1);}catch(e){failed=true;t.diagnostic(JSON.stringify({failed_window:i,boundary:trace.checkpoints[i-1].name,code:e.code}));await fs.writeFile(f.base+'/failure.json',JSON.stringify({window:i,boundary:trace.checkpoints[i-1].name,request:f.request,code:e.code}));if(process.env.PM_TEST_EVIDENCE_DIR){await fs.mkdir(process.env.PM_TEST_EVIDENCE_DIR,{recursive:true});await fs.cp(f.base,path.join(process.env.PM_TEST_EVIDENCE_DIR,`initialization-window-${i}`),{recursive:true});}throw e;}finally{if(!failed||process.env.PM_TEST_EVIDENCE_DIR)await fs.rm(f.base,{recursive:true,force:true});}}
  t.diagnostic(JSON.stringify({initialization_kill_windows:trace.checkpoints.length,boundaries:trace.checkpoints.map(x=>x.name)}));
});
test('a second protection joins an interrupted protective successor without reviving earlier control',{skip:!supported},async()=>{
  const f=await fixture();try{await f.create();const amendment=f.make('work amend',{work:'ATLAS-01',scope,label:'Updated',impact:[]});await executeFiles(amendment,{state:f.state,fault:async name=>{if(name==='DECIDED')throw new Error('interrupt A');}});
    const pause=f.make('work pause',{work:'ATLAS-01',resolver:'local-owner',next:'review',protection_refs:[],proof:'local-owner'});
    const p=await executeFiles(pause,{state:f.state,fault:async name=>{if(name==='DECIDED')throw new Error('interrupt B');}});assert.equal(p.code,'PROTECTION_PENDING');
    const cancel=f.make('work cancel',{work:'ATLAS-01',resolver:'local-owner',next:'review',protection_refs:[],proof:'local-owner'});
    const c=await executeFiles(cancel,{state:f.state,fault:async name=>{if(name==='PROTECTION_DURABLE')throw new Error('interrupt after P-C');}});assert.equal(c.code,'PROTECTION_PENDING');
    await f.run('project reconcile',{});const q=await f.query();assert.equal(q.protection_seq,2);assert.equal(q.data.model.rows[0].control,'revoked');assert.equal(q.data.model.rows[0].phase,'cancelled');assert.equal(q.data.model.rows[0].title,'Updated');
    await f.run('work pause',{...pause.input});assert.equal((await f.query()).data.model.rows[0].control,'revoked');
  }finally{await f.cleanup();}
});
for(const point of ['VERIFIED','SNAPSHOT_READY','PUBLICATION_RELEASED'])test(`protection at ${point} keeps publication and overlay ordering`,{skip:!supported},async()=>{
  const f=await fixture();try{await f.create();const p=f.make('work pause',{work:'ATLAS-01',resolver:'local-owner',next:'review',protection_refs:[],proof:'local-owner'});let fired=false;
    const out=await executeFiles(f.make('work amend',{work:'ATLAS-01',scope,label:'Updated',impact:[]}),{state:f.state,fault:async name=>{if(name===point&&!fired){fired=true;const pOut=await executeFiles(p,{state:f.state,fault:async n=>{if(n==='PROTECTION_DURABLE')throw new Error('stop protector after durable acceptance');}});assert.equal(pOut.code,'PROTECTION_PENDING');}}});assert.equal(out.exit,0);const q=await f.query();if(point==='PUBLICATION_RELEASED'){assert(q.stale);assert(q.data.effective_protection_overlay.some(x=>x.deny));await f.run('project reconcile',{});}assert.equal((await f.query()).data.model.rows[0].control,'paused');
  }finally{await f.cleanup();}
});
test('case and Git stage inputs are available through a read-only private CLI projection',{skip:!supported},async()=>{
  for(const git of [false,true]){const f=await resolutionFixture(git);try{const before=await tree(f.base);const q=await executeFiles({protocol:'project-files/1',query:'operation inspect',repo:f.repo,projection:'private-local',snapshot_token:null,input:{subject:f.resolveRequest.input.case_id}},{state:f.state});validate(q,DEFINITIONS.QueryResult);assert(q.data.case.current);assert.equal(q.data.case.work_id,'ATLAS-01');assert(q.data.case.allowed_decisions.includes('adopt-authorized-structured-change'));if(git)assert.equal(q.data.case.stage_digests.length,3);assert.deepEqual(await tree(f.base),before);}finally{await f.cleanup();}}
});
test('pending operation lookup reports a durable local decision without exposing a future success',{skip:!supported},async()=>{
  const f=await fixture();try{const request=f.make('work create',{work:'ATLAS-01',scope,label:'Example',deps:[],impact:[]});const r=await executeFiles(request,{state:f.state,fault:async n=>{if(n==='DECIDED')throw new Error('interrupt');}});assert.equal(r.code,'IO_PENDING');const before=await tree(f.base);const q=await executeFiles({protocol:'project-files/1',query:'operation inspect',repo:f.repo,projection:'private-local',snapshot_token:null,input:{subject:r.operation_receipt}},{state:f.state});validate(q,DEFINITIONS.QueryResult);assert.equal(q.data.pending_operation.code,'RECOVERY_PENDING');assert.equal(q.data.model.rows.length,0);assert.deepEqual(await tree(f.base),before);}finally{await f.cleanup();}
});
test('same key collisions between ordinary work and protective input are rejected before accepting P',{skip:!supported},async()=>{
  const f=await fixture();try{const created=await f.create();const request=f.make('work pause',{work:'ATLAS-01',resolver:'local-owner',next:'review',protection_refs:[],proof:'local-owner'},{idempotency_key:created.request.idempotency_key});await code('IDEMPOTENCY_CONFLICT',()=>executeFiles(request,{state:f.state}));assert.equal((await f.query()).protection_seq,0);}finally{await f.cleanup();}
});
test('a decided unit plus total derived-cache loss preserves generation and the original receipt',{skip:!supported},async()=>{
  const f=await fixture();try{await f.create();const prior=await f.query(),request=f.make('work amend',{work:'ATLAS-01',scope,label:'Updated',impact:[]});const out=await executeFiles(request,{state:f.state,fault:async n=>{if(n==='DECIDED')throw new Error('interrupt');}});assert.equal(out.code,'IO_PENDING');await fs.unlink(f.repo+'/.pm-local/publication.json');await fs.rm(f.repo+'/.pm-local/snapshots',{recursive:true});const before=await tree(f.base);await code('RECOVERY_REQUIRED',()=>f.query());assert.deepEqual(await tree(f.base),before);const recovered=await executeFiles(request,{state:f.state});assert.equal(recovered.exit,0);const q=await f.query();assert.equal(q.generation,prior.generation+1);assert.equal(q.data.model.rows[0].title,'Updated');}finally{await f.cleanup();}
});
test('an injected ENOSPC before the decision preserves all business bytes',{skip:!supported},async()=>{
  const f=await fixture();try{const prior=await fs.readFile(f.repo+'/TASKS.csv'),request=f.make('work create',{work:'ATLAS-01',scope,label:'Example',deps:[],impact:[]});await code('IO_PREPARE_FAILED',()=>executeFiles(request,{state:f.state,fault:async n=>{if(n==='PREPARED'){const e=new Error('injected ENOSPC');e.code='ENOSPC';throw e;}}}));assert.deepEqual(await fs.readFile(f.repo+'/TASKS.csv'),prior);assert.equal((await executeFiles(request,{state:f.state})).exit,0);}finally{await f.cleanup();}
});
test('a changed or missing decided journal is refused without cleaning the scene',{skip:!supported},async()=>{
  const f=await fixture();try{const request=f.make('work create',{work:'ATLAS-01',scope,label:'Example',deps:[],impact:[]});await executeFiles(request,{state:f.state,fault:async n=>{if(n==='DECIDED')throw new Error('interrupt');}});const ids=await fs.readdir(f.repo+'/.pm-local/transactions');let target;for(const id of ids){const p=f.repo+'/.pm-local/transactions/'+id+'/terminal.json';try{await fs.stat(p);}catch(e){if(e.code==='ENOENT')target=id;else throw e;}}await fs.unlink(f.repo+'/.pm-local/transactions/'+target+'/journal.json');const before=await tree(f.base);await code('JOURNAL_CORRUPT',()=>executeFiles(request,{state:f.state}));assert.deepEqual(await tree(f.base),before);}finally{await f.cleanup();}
});
test('case-insensitive target aliases are rejected before a decision',{skip:!supported},async()=>{
  const f=await fixture();try{await f.create();await code('PATH_UNSAFE',()=>f.run('work create',{work:'atlas-01',scope,label:'Other',deps:[],impact:[]}));assert.equal((await f.query()).data.model.rows.length,1);}finally{await f.cleanup();}
});
test('unsupported Git includes and alternate object roots are rejected before initialization',{skip:!supported},async()=>{
  for(const feature of ['include','alternates']){const base=await temporary('project-files-unsupported-');try{const repo=base+'/repo';await fs.mkdir(repo);gitRun(repo,['init','-b','main']);if(feature==='include')await fs.appendFile(repo+'/.git/config','\n[include]\n path = /example/missing-config\n');else await fs.writeFile(repo+'/.git/objects/info/alternates','/example/missing-objects\n');const request={protocol:'project-files/1',command:'project init',repo,project_id:'ATLAS',actor_proof:'local-owner',idempotency_key:'init',expected_revision:emptyRevision(),input:{root:repo,identity:'local-owner',policy:'policy-1'}};await code('PLATFORM_UNSUPPORTED',()=>executeFiles(request,{state:base+'/state'}));await assert.rejects(fs.stat(repo+'/.pm-local'),e=>e.code==='ENOENT');}finally{await fs.rm(base,{recursive:true,force:true});}}
});
test('an already accepted protection survives an authorized merge of older business text',{skip:!supported},async()=>{
  const f=await fixture({git:true});try{
    await f.create();gitRun(f.repo,['add','.']);gitRun(f.repo,['commit','-m','Example base']);const base=gitRun(f.repo,['rev-parse','HEAD']);await f.run('project reconcile',{});
    await f.run('work pause',{work:'ATLAS-01',resolver:'local-owner',next:'review',protection_refs:[],proof:'local-owner'});gitRun(f.repo,['add','.']);gitRun(f.repo,['commit','-m','Example paused state']);
    gitRun(f.repo,['checkout','-b','other',base]);let rows=csvRead(await fs.readFile(f.repo+'/TASKS.csv'));rows[0].title='Other';await fs.writeFile(f.repo+'/TASKS.csv',csvBytes(rows));gitRun(f.repo,['add','TASKS.csv']);gitRun(f.repo,['commit','-m','Example other label']);
    gitRun(f.repo,['checkout','-b','merge-main',base]);rows=csvRead(await fs.readFile(f.repo+'/TASKS.csv'));rows[0].title='Main';await fs.writeFile(f.repo+'/TASKS.csv',csvBytes(rows));gitRun(f.repo,['add','TASKS.csv']);gitRun(f.repo,['commit','-m','Example main label']);
    assert.equal(spawnSync('git',['-C',f.repo,'merge','other'],{env:{PATH:process.env.PATH,HOME:f.state,GIT_AUTHOR_NAME:'Example Author',GIT_AUTHOR_EMAIL:'author@example.invalid',GIT_COMMITTER_NAME:'Example Author',GIT_COMMITTER_EMAIL:'author@example.invalid'}}).status,1);
    let conflict;try{await f.run('project reconcile',{});}catch(e){conflict=e;}
    const q=await executeFiles({protocol:'project-files/1',query:'operation inspect',repo:f.repo,projection:'private-local',snapshot_token:null,input:{subject:conflict.caseId}},{state:f.state}),c=q.data.case;
    const request=f.make('project resolve',{case_id:c.id,expected_case_digest:c.case_digest,decision:'adopt-authorized-structured-change',authorization_refs:['local-owner'],semantic_input:{work_id:'ATLAS-01',title:'Merged',superseded_intents:c.transactions,reason:'Example merge',merge_resolution:{work_id:'ATLAS-01',field:'title',value:'Merged',stage_digests:c.stage_digests}}});
    assert.equal((await executeFiles(request,{state:f.state})).exit,0);const final=await f.query();assert.equal(final.data.model.rows[0].control,'paused');assert.equal(final.protection_seq,1);
  }catch(e){if(process.env.PM_TEST_EVIDENCE_DIR){await fs.mkdir(process.env.PM_TEST_EVIDENCE_DIR,{recursive:true});await fs.cp(f.base,path.join(process.env.PM_TEST_EVIDENCE_DIR,'protection-after-git-history'),{recursive:true});}throw e;}finally{await f.cleanup();}
});
test('one identical resolve command automatically continues its own interrupted decided recovery',{skip:!supported},async()=>{
  for(const git of [false,true]){const f=await resolutionFixture(git);try{const out=await executeFiles(f.resolveRequest,{state:f.state,fault:async n=>{if(n===(git?'GIT_INDEX_RENAME':'DECIDED'))throw new Error('injected recovery IO failure');}});assert.equal(out.code,'IO_PENDING');const recovered=await executeFiles(f.resolveRequest,{state:f.state});assert.equal(recovered.exit,0);assert.equal((await executeFiles(f.resolveRequest,{state:f.state})).operation_receipt,recovered.operation_receipt);const q=await f.query();assert.equal(q.data.model.project.project_audit.filter(x=>x.type==='resolution').length,1);}finally{await f.cleanup();}}
});
test('a missing immutable Git seed does not authorize removal of its surviving lock',{skip:!supported},async()=>{
  const f=await mergeFixture();try{await code('IO_PREPARE_FAILED',()=>executeFiles(f.resolveRequest,{state:f.state,fault:async n=>{if(n==='GIT_LINK')throw new Error('interrupt after acquiring own lock');}}));const names=await fs.readdir(f.repo+'/.git'),seed=names.find(n=>n.startsWith('project-files-seed-'));await fs.unlink(f.repo+'/.git/'+seed);const lockBefore=await fs.readFile(f.repo+'/.git/index.lock');await code('JOURNAL_CORRUPT',()=>f.run('project reconcile',{}));assert.deepEqual(await fs.readFile(f.repo+'/.git/index.lock'),lockBefore);}finally{await f.cleanup();}
});
test('an undecided protective successor of a decided resolution is automatically replaced',{skip:!supported},async()=>{
  const f=await resolutionFixture(false);try{const p=f.make('work pause',{work:'ATLAS-01',resolver:'local-owner',next:'review',protection_refs:[],proof:'local-owner'});let prepared=0,accepted=false;
    const out=await executeFiles(f.resolveRequest,{state:f.state,fault:async n=>{if(n==='PREPARED'&&++prepared===2)throw new Error('interrupt protective preparation');if(n==='VERIFIED'&&!accepted){accepted=true;await executeFiles(p,{state:f.state,fault:async x=>{if(x==='PROTECTION_DURABLE')throw new Error('interrupt protector');}});}}});assert.equal(out.code,'IO_PENDING');
    const recovered=await executeFiles(f.resolveRequest,{state:f.state});assert.equal(recovered.exit,0);const q=await f.query();assert.equal(q.data.model.rows[0].control,'paused');assert.equal(q.data.model.rows[0].title,'Chosen');
  }finally{await f.cleanup();}
});
test('loss of the kernel lock helper terminates the writer before source replacement',{skip:!supported},async()=>{
  const f=await fixture();try{const request=f.make('work create',{work:'ATLAS-01',scope,label:'Example',deps:[],impact:[]});const script=`const {FileStore}=await import(${JSON.stringify(moduleURL)});const s=new FileStore(process.argv[1],{state:process.argv[2],fault:async n=>{if(n==='PREPARED'){process.kill(s.lock.pid,'SIGKILL');await new Promise(r=>setTimeout(r,1000));}}});await s.command(JSON.parse(process.argv[3]));`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script,f.repo,f.state,JSON.stringify(request)],{env:{PATH:process.env.PATH,HOME:f.state},encoding:'utf8'});assert.equal(child.status,25);assert.equal(child.stderr,'');assert.equal((await f.query()).data.model.rows.length,0);assert.equal((await executeFiles(request,{state:f.state})).exit,0);
  }finally{await f.cleanup();}
});
test('the parent descriptor retains flock after the locking helper exits',{skip:!supported},async()=>{
  const base=await temporary('project-files-flock-');try{const filename=base+'/lock',owner=await fs.open(filename,'wx+',0o600);
    const lock=spawnSync('python3',['-c','import fcntl; fcntl.flock(3,fcntl.LOCK_EX)'],{stdio:['ignore','pipe','pipe',owner.fd]});assert.equal(lock.status,0);
    const probe='import fcntl,sys\nf=open(sys.argv[1],"r+")\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(9)\n';
    assert.equal(spawnSync('python3',['-c',probe,filename]).status,9);await owner.close();assert.equal(spawnSync('python3',['-c',probe,filename]).status,0);
  }finally{await fs.rm(base,{recursive:true,force:true});}
});
test('a nested standalone project never consumes or changes the parent Git repository',{skip:!supported},async()=>{
  const f=await fixture();try{gitRun(f.base,['init','-b','main']);const before=await tree(f.base+'/.git');const created=await f.create();assert.equal(created.out.exit,0);assert.deepEqual(await tree(f.base+'/.git'),before);assert.equal((await f.query()).stale,false);}finally{await f.cleanup();}
});
test('format-3 full indexes without extended flags are resolved and accepted by real Git',{skip:!supported},async()=>{
  const f=await mergeFixture();try{const index=await fs.readFile(f.repo+'/.git/index');index.writeUInt32BE(3,4);createHash('sha1').update(index.subarray(0,-20)).digest().copy(index,index.length-20);await fs.writeFile(f.repo+'/.git/index',index);assert(gitRun(f.repo,['ls-files','--unmerged']).length);let conflict;try{await f.run('project reconcile',{});}catch(e){conflict=e;}const q=await executeFiles({protocol:'project-files/1',query:'operation inspect',repo:f.repo,projection:'private-local',snapshot_token:null,input:{subject:conflict.caseId}},{state:f.state});const r={...f.resolveRequest,input:{...f.resolveRequest.input,case_id:q.data.case.id,expected_case_digest:q.data.case.case_digest}};assert.equal((await executeFiles(r,{state:f.state})).exit,0);assert.equal((await fs.readFile(f.repo+'/.git/index')).readUInt32BE(4),3);assert.equal(gitRun(f.repo,['ls-files','--unmerged']),'');}finally{await f.cleanup();}
});
test('a native format-4 Git index is rejected without changing business files',{skip:!supported},async()=>{
  const f=await fixture({git:true});try{await f.create();gitRun(f.repo,['add','.']);gitRun(f.repo,['update-index','--index-version=4']);assert.equal((await fs.readFile(f.repo+'/.git/index')).readUInt32BE(4),4);const before=await tree(f.base);await code('UNSUPPORTED_RESOLUTION_STATE',()=>f.run('project reconcile',{}));assert.deepEqual(await tree(f.base),before);}finally{await f.cleanup();}
});
test('a corrupted ordinary journal cannot block an independently durable protection',{skip:!supported},async()=>{
  const f=await fixture();try{await f.create();await executeFiles(f.make('work amend',{work:'ATLAS-01',scope,label:'Updated',impact:[]}),{state:f.state,fault:async n=>{if(n==='DECIDED')throw new Error('interrupt');}});let journal;for(const id of await fs.readdir(f.repo+'/.pm-local/transactions')){try{await fs.stat(f.repo+'/.pm-local/transactions/'+id+'/terminal.json');}catch(e){if(e.code==='ENOENT')journal=f.repo+'/.pm-local/transactions/'+id+'/journal.json';else throw e;}}await fs.writeFile(journal,'corrupted journal');const out=await f.run('work pause',{work:'ATLAS-01',resolver:'local-owner',next:'review',protection_refs:[],proof:'local-owner'});assert.equal(out.out.code,'PROTECTION_PENDING');assert(out.out.steps[0].facts.protection_accepted);assert.equal(await fs.readFile(journal,'utf8'),'corrupted journal');assert.equal((await fs.readdir(f.repo+'/.pm-local/protection')).filter(n=>/^\d+\.json$/.test(n)).length,1);await code('JOURNAL_CORRUPT',()=>f.query());}finally{await f.cleanup();}
});

test('native clone adoption preserves business identity and responsibility but fences inherited execution',{skip:!supported},async()=>{
  const original=await fixture();const base=await temporary('project-adopt-test-');const repo=base+'/clone',state=base+'/state';await fs.mkdir(repo);await fs.mkdir(state,{mode:0o700});
  try{
    await original.create();
    const grant={id:'grant-1',project_id:'ATLAS',work_ids:['ATLAS-01'],scope_revision:1,issuer:'local-owner',actions:['commit-start'],write_roots:['src'],protected_actions:[],evidence_ref:'evidence-1',issued_at:new Date().toISOString()};
    await original.run('grant record',{grant,evidence:['evidence-1']});await original.run('work commit-start',{work:'ATLAS-01',responsible:'local-owner',policy:'policy-1',reason:'Example authorization'});
    const before=await tree(original.base),old=(await original.query()).data.model;
    for(const name of ['TASKS.csv','.pm','work-items'])await fs.cp(original.repo+'/'+name,repo+'/'+name,{recursive:true});
    const query={protocol:'project-files/1',query:'project inspect',repo,projection:'private-local',snapshot_token:null,input:{}};
    const unbound=await tree(base),hint=await executeFiles(query,{state});validate(hint,DEFINITIONS.Result);assert.equal(hint.exit,24);assert.deepEqual(await tree(base),unbound);assert.equal(hint.steps[0].facts.project_id,'ATLAS');
    const req={...original.make('project adopt',{root:repo,identity:'local-owner',policy:'policy-1'}),repo,expected_revision:hint.source_revision};
    const result=await executeFiles(req,{state});assert.equal(result.exit,0);
    const q=await executeFiles({...query,query:'snapshot'},{state});validate(q,DEFINITIONS.QueryResult);assert.equal(q.data.runtime.checkout_origin,'adopted');assert.equal(q.data.runtime.execution_activation_required,true);assert.notEqual(q.data.model.project.manager_binding.epoch,old.project.manager_binding.epoch);assert(q.data.model.project.project_grants.every(g=>g.revoked_at));assert.deepEqual(q.data.model.tasks[0].obligations,old.tasks[0].obligations);
    const create={...original.make('work create',{work:'ATLAS-02',scope,label:'Clone plan',deps:[],impact:[]}),repo,expected_revision:q.source_revision};assert.equal((await executeFiles(create,{state})).exit,0);
    assert.equal((await executeFiles(req,{state})).operation_receipt,result.operation_receipt);assert.deepEqual(await tree(original.base),before);
    await fs.unlink(repo+'/.pm-local/safety-identity.json');await code('LOCK_UNAVAILABLE',()=>executeFiles({...req,idempotency_key:'different-adoption'},{state}));
  }finally{await original.cleanup();await fs.rm(base,{recursive:true,force:true});}
});

test('every native adoption checkpoint SIGKILL resumes without inherited execution ownership',{skip:!supported,timeout:240000},async t=>{
  const source=await fixture();await source.create();
  const setup=async()=>{const base=await temporary('project-adopt-kill-'),repo=base+'/clone',state=base+'/state';await fs.mkdir(repo);await fs.mkdir(state,{mode:0o700});for(const name of ['TASKS.csv','.pm','work-items'])await fs.cp(source.repo+'/'+name,repo+'/'+name,{recursive:true});const hint=await executeFiles({protocol:'project-files/1',query:'project inspect',repo,projection:'private-local',snapshot_token:null,input:{}},{state});return {base,repo,state,request:{...source.make('project adopt',{root:repo,identity:'local-owner',policy:'policy-1'}),repo,expected_revision:hint.source_revision}};};
  try{
    const baseline=await setup(),trace=child(baseline.request,baseline.state);assert.equal(trace.last.result.exit,0);await fs.rm(baseline.base,{recursive:true});
    for(let i=1;i<=trace.checkpoints.length;i++){const f=await setup();let failed=false;try{assert.equal(child(f.request,f.state,i).signal,'SIGKILL');const result=await executeFiles(f.request,{state:f.state});assert.equal(result.exit,0,`adoption recovery ${i}`);const q=await executeFiles({protocol:'project-files/1',query:'snapshot',repo:f.repo,projection:'private-local',snapshot_token:null,input:{}},{state:f.state});assert.equal(q.data.runtime.checkout_origin,'adopted');assert.equal(q.data.runtime.execution_activation_required,true);assert.equal(q.data.model.project.project_audit.filter(a=>a.type==='checkout-adopted').length,1);}catch(e){failed=true;t.diagnostic(JSON.stringify({failed_window:i,boundary:trace.checkpoints[i-1].name,code:e.code}));if(process.env.PM_TEST_EVIDENCE_DIR){await fs.mkdir(process.env.PM_TEST_EVIDENCE_DIR,{recursive:true});await fs.cp(f.base,path.join(process.env.PM_TEST_EVIDENCE_DIR,`adoption-window-${i}`),{recursive:true});}throw e;}finally{if(!failed||process.env.PM_TEST_EVIDENCE_DIR)await fs.rm(f.base,{recursive:true,force:true});}}
    t.diagnostic(JSON.stringify({adoption_kill_windows:trace.checkpoints.length,boundaries:trace.checkpoints.map(x=>x.name)}));
  }finally{await source.cleanup();}
});

test('unsupported Git operation markers reject before any local or index writes',{skip:!supported},async()=>{
  for(const marker of ['CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer']){
    const f=await mergeFixture();try{
      if(marker.includes('HEAD'))await fs.writeFile(f.repo+'/.git/'+marker,gitRun(f.repo,['rev-parse','HEAD'])+'\n');else await fs.mkdir(f.repo+'/.git/'+marker);
      const before=await tree(f.base);await code('UNSUPPORTED_RESOLUTION_STATE',()=>executeFiles(f.resolveRequest,{state:f.state}));assert.deepEqual(await tree(f.base),before);await code('UNSUPPORTED_RESOLUTION_STATE',()=>f.run('project reconcile',{}));assert.deepEqual(await tree(f.base),before);
    }finally{await f.cleanup();}
  }
});
test('a title-only unmerged index without ordinary merge control is refused',{skip:!supported},async()=>{
  const f=await mergeFixture();try{await fs.unlink(f.repo+'/.git/MERGE_HEAD');const before=await tree(f.base);await code('UNSUPPORTED_RESOLUTION_STATE',()=>executeFiles(f.resolveRequest,{state:f.state}));assert.deepEqual(await tree(f.base),before);}finally{await f.cleanup();}
});
test('a late unsupported Git operation before index rename refuses publication and preserves the index',{skip:!supported},async()=>{
  const f=await mergeFixture();try{const index=await fs.readFile(f.repo+'/.git/index'),publication=await fs.readFile(f.repo+'/.pm-local/publication.json');let injected=false;await code('UNSUPPORTED_RESOLUTION_STATE',()=>executeFiles(f.resolveRequest,{state:f.state,fault:async n=>{if(n==='before-GIT_INDEX_RENAME'){injected=true;await fs.writeFile(f.repo+'/.git/CHERRY_PICK_HEAD',gitRun(f.repo,['rev-parse','HEAD'])+'\n');}}}));assert(injected);assert.deepEqual(await fs.readFile(f.repo+'/.pm-local/publication.json'),publication);assert.deepEqual(await fs.readFile(f.repo+'/.git/index'),index);assert(gitRun(f.repo,['ls-files','--unmerged']).length);await code('UNSUPPORTED_RESOLUTION_STATE',()=>f.query());}finally{await f.cleanup();}
});

test('a pending receipt is a stable operation reference before and after recovery',{skip:!supported},async()=>{
  const f=await fixture();try{await f.create();const request=f.make('work amend',{work:'ATLAS-01',scope,label:'Updated',impact:[]});const pending=await executeFiles(request,{state:f.state,fault:async n=>{if(n==='DECIDED')throw new Error('interrupted decision');}});assert.equal(pending.code,'IO_PENDING');const inspect=subject=>executeFiles({protocol:'project-files/1',query:'operation inspect',repo:f.repo,projection:'private-local',snapshot_token:null,input:{subject}},{state:f.state});const before=await inspect(pending.operation_receipt);assert.equal(before.data.pending_operation.operation_receipt,pending.operation_receipt);const completed=await executeFiles(request,{state:f.state});assert.equal(completed.operation_receipt,pending.operation_receipt);const after=await inspect(pending.operation_receipt);assert.equal(after.data.operation.operation_id,pending.operation_receipt);assert.equal(after.stale,false);}finally{await f.cleanup();}
});
test('resolved original intent returns durable supersession and final control without another write',{skip:!supported},async()=>{
  const f=await resolutionFixture();try{const pending=await new FileStore(f.repo,{state:f.state}).begin().then(async s=>{try{return (await s.pending()).find(p=>p.decided).journal;}finally{await s.end();}});const original=parseRequest(pending);const resolved=await executeFiles(f.resolveRequest,{state:f.state});const before=await tree(f.base);const replay=await executeFiles(original,{state:f.state});validate(replay,DEFINITIONS.Result);assert.equal(replay.code,'NO_CHANGE');assert.equal(replay.operation_receipt,pending.operation_id);assert.equal(replay.steps[0].state,'superseded-by-resolution');assert.equal(replay.steps[0].facts.resolution_ref,resolved.operation_receipt);assert.equal(replay.steps[0].facts.local_intent_committed,false);assert.equal(replay.steps.at(-1).facts.effective_control,'enabled');const q=await executeFiles({protocol:'project-files/1',query:'operation inspect',repo:f.repo,projection:'private-local',snapshot_token:null,input:{subject:pending.operation_id}},{state:f.state});validate(q,DEFINITIONS.QueryResult);assert.equal(q.data.operation.resolutions[0].operation_id,resolved.operation_receipt);assert.equal(q.data.operation.recorded_result.code,'OK');assert.equal(q.data.operation.semantic_result.code,'NO_CHANGE');assert.deepEqual(await tree(f.base),before);assert.equal(q.data.model.rows[0].title,'Chosen');}finally{await f.cleanup();}
  function parseRequest(journal){const receipt=JSON.parse(Buffer.from(journal.after.find(f=>f.path==='work-items/ATLAS-01.yaml').bytes,'base64')).audit.at(-1).operation_receipt;return {protocol:'project-files/1',command:'work amend',repo:f.repo,project_id:'ATLAS',actor_proof:'local-owner',idempotency_key:receipt.idempotency_key,expected_revision:journal.before_revision,input:{work:'ATLAS-01',scope,label:'Intended',impact:[]}};}
});

test('recovery retains its stable operation reference when pending metadata becomes unreadable',{skip:!supported},async()=>{
  const f=await fixture();try{await f.create();const request=f.make('work amend',{work:'ATLAS-01',scope,label:'Updated',impact:[]});const first=await executeFiles(request,{state:f.state,fault:async n=>{if(n==='DECIDED')throw new Error('interrupt');}});let injected=false;const out=await executeFiles(request,{state:f.state,fault:async n=>{if(n==='before-write:TASKS.csv'){injected=true;await fs.chmod(f.repo+'/.pm-local/transactions',0);throw new Error('metadata temporarily unavailable');}}});assert(injected);assert.equal(out.code,'RECOVERY_CONFLICT');assert.equal(out.operation_receipt,first.operation_receipt);await fs.chmod(f.repo+'/.pm-local/transactions',0o700);assert.equal((await executeFiles(request,{state:f.state})).operation_receipt,first.operation_receipt);}finally{await fs.chmod(f.repo+'/.pm-local/transactions',0o700).catch(()=>{});await f.cleanup();}
});

test('a durable unpublished protection receipt remains queryable through its business publication',{skip:!supported},async()=>{
  for(const boundary of ['PROTECTION_DURABLE','DECIDED']){const f=await fixture();try{await f.create();const amend=f.make('work amend',{work:'ATLAS-01',scope,label:'Updated',impact:[]});await executeFiles(amend,{state:f.state,fault:async n=>{if(n==='DECIDED')throw new Error('interrupt ordinary');}});const pause=f.make('work pause',{work:'ATLAS-01',resolver:'local-owner',next:'review',protection_refs:[],proof:'local-owner'});const pending=await executeFiles(pause,{state:f.state,fault:async n=>{if(n===boundary)throw new Error('interrupt protection');}});assert.equal(pending.code,'PROTECTION_PENDING');const inspect=(subject=pending.operation_receipt)=>executeFiles({protocol:'project-files/1',query:'operation inspect',repo:f.repo,projection:'private-local',snapshot_token:null,input:{subject}},{state:f.state});const before=await tree(f.base),view=await inspect();validate(view,DEFINITIONS.QueryResult);assert.equal(view.data.pending_operation.operation_receipt,pending.operation_receipt);assert.equal(view.data.pending_operation.steps[0].facts.protection_accepted,true);assert.equal((await inspect(pause.idempotency_key)).data.pending_operation.operation_receipt,pending.operation_receipt);assert.deepEqual(await tree(f.base),before);const completed=await executeFiles(pause,{state:f.state});assert.equal(completed.operation_receipt,pending.operation_receipt);const after=await inspect();assert.equal(after.data.operation.operation_id,pending.operation_receipt);assert.equal(after.data.operation.semantic_result.steps.at(-1).facts.effective_control,'paused');}finally{await f.cleanup();}}
});

async function nestedResolutionFixture(boundary='VERIFIED') {
  const f=await resolutionFixture();const s=await new FileStore(f.repo,{state:f.state}).begin();let original;try{original=(await s.pending()).find(p=>p.decided).journal.operation_id;}finally{await s.end();}
  const r1=await executeFiles(f.resolveRequest,{state:f.state,fault:async n=>{if(n===boundary)throw new Error('interrupt first resolution');}});assert.equal(r1.code,'IO_PENDING');
  const rows=csvRead(await fs.readFile(f.repo+'/TASKS.csv'));rows[0].title='Other again';await fs.writeFile(f.repo+'/TASKS.csv',csvBytes(rows));let conflict;try{await executeFiles(f.resolveRequest,{state:f.state});}catch(e){conflict=e;}assert.equal(conflict?.code,'RECOVERY_CONFLICT');
  const q=await executeFiles({protocol:'project-files/1',query:'operation inspect',repo:f.repo,projection:'private-local',snapshot_token:null,input:{subject:conflict.caseId}},{state:f.state}),c=q.data.case;assert(c.allowed_decisions.includes('adopt-authorized-structured-change'));assert.equal(c.work_id,'ATLAS-01');
  return {...f,original,r1,r2:f.make('project resolve',{case_id:c.id,expected_case_digest:c.case_digest,decision:'adopt-authorized-structured-change',authorization_refs:['local-owner'],semantic_input:{work_id:'ATLAS-01',title:'Final choice',superseded_intents:c.transactions,reason:'Example second title decision'}})};
}
test('a second exact title resolution absorbs the decided recovery graph and preserves transitive receipts',{skip:!supported},async()=>{
  for(const boundary of ['DECIDED','applied:TASKS.csv','VERIFIED']){const f=await nestedResolutionFixture(boundary);try{const result=await executeFiles(f.r2,{state:f.state});assert.equal(result.exit,0);const q=await f.query();assert.equal(q.stale,false);assert.equal(q.data.model.rows[0].title,'Final choice');assert.equal(q.generation,3);const original=await executeFiles({protocol:'project-files/1',query:'operation inspect',repo:f.repo,projection:'private-local',snapshot_token:null,input:{subject:f.original}},{state:f.state});assert.deepEqual(original.data.operation.resolutions.map(r=>r.operation_id),[f.r1.operation_receipt,result.operation_receipt]);assert.equal(original.data.operation.semantic_result.code,'NO_CHANGE');const replay=await executeFiles(f.resolveRequest,{state:f.state});assert.equal(replay.code,'NO_CHANGE');assert.equal(replay.steps[0].facts.resolution_ref,result.operation_receipt);const before=await tree(f.base);assert.equal((await executeFiles(f.r2,{state:f.state})).operation_receipt,result.operation_receipt);assert.deepEqual(await tree(f.base),before);}finally{await f.cleanup();}}
});
test('a protection successor of nested title recovery publishes only the protected final unit',{skip:!supported},async()=>{
  const f=await nestedResolutionFixture();try{const p=f.make('work pause',{work:'ATLAS-01',resolver:'local-owner',next:'review',protection_refs:[],proof:'local-owner'});let accepted=false;const out=await executeFiles(f.r2,{state:f.state,fault:async n=>{if(n==='SNAPSHOT_READY'&&!accepted){accepted=true;await executeFiles(p,{state:f.state,fault:async x=>{if(x==='PROTECTION_DURABLE')throw new Error('interrupt protector');}});}}});assert.equal(out.exit,0);const q=await f.query();assert.equal(q.data.model.rows[0].title,'Final choice');assert.equal(q.data.model.rows[0].control,'paused');assert.equal(q.protection_seq,1);assert.equal(q.generation,3);}finally{await f.cleanup();}
});
test('every nested title recovery checkpoint SIGKILL resumes the latest absorbing unit',{skip:!supported,timeout:360000},async t=>{
  const baseline=await nestedResolutionFixture(),trace=child(baseline.r2,baseline.state);assert.equal(trace.last.result.exit,0);await baseline.cleanup();
  for(let i=1;i<=trace.checkpoints.length;i++){const f=await nestedResolutionFixture();let failed=false;try{assert.equal(child(f.r2,f.state,i).signal,'SIGKILL');assert.equal((await executeFiles(f.r2,{state:f.state})).exit,0,`nested recovery ${i}`);const q=await f.query();assert.equal(q.stale,false);assert.equal(q.data.model.rows[0].title,'Final choice');assert.equal(q.generation,3);assert.equal(q.data.model.project.project_audit.filter(a=>a.operation_receipt?.idempotency_key===f.r2.idempotency_key).length,1);}catch(e){failed=true;t.diagnostic(JSON.stringify({failed_window:i,boundary:trace.checkpoints[i-1].name,code:e.code}));if(process.env.PM_TEST_EVIDENCE_DIR){await fs.mkdir(process.env.PM_TEST_EVIDENCE_DIR,{recursive:true});await fs.cp(f.base,path.join(process.env.PM_TEST_EVIDENCE_DIR,`nested-recovery-${i}`),{recursive:true});}throw e;}finally{if(!failed||process.env.PM_TEST_EVIDENCE_DIR)await f.cleanup();}}
  t.diagnostic(JSON.stringify({kind:'nested-resolution',kill_windows:trace.checkpoints.length,boundaries:trace.checkpoints.map(x=>x.name)}));
});

test('a second title recovery after a resolved Git index updates the index and preserves merge control',{skip:!supported},async()=>{
  const f=await mergeFixture();try{const head=gitRun(f.repo,['rev-parse','HEAD']),merge=await fs.readFile(f.repo+'/.git/MERGE_HEAD');const r1=await executeFiles(f.resolveRequest,{state:f.state,fault:async n=>{if(n==='VERIFIED')throw new Error('interrupt after resolved index');}});assert.equal(r1.code,'IO_PENDING');const rows=csvRead(await fs.readFile(f.repo+'/TASKS.csv'));rows[0].title='Another title';await fs.writeFile(f.repo+'/TASKS.csv',csvBytes(rows));let conflict;try{await executeFiles(f.resolveRequest,{state:f.state});}catch(e){conflict=e;}assert.equal(conflict?.code,'RECOVERY_CONFLICT');const q=await executeFiles({protocol:'project-files/1',query:'operation inspect',repo:f.repo,projection:'private-local',snapshot_token:null,input:{subject:conflict.caseId}},{state:f.state}),c=q.data.case;assert(c.allowed_decisions.includes('adopt-authorized-structured-change'));const r2=f.make('project resolve',{case_id:c.id,expected_case_digest:c.case_digest,decision:'adopt-authorized-structured-change',authorization_refs:['local-owner'],semantic_input:{work_id:'ATLAS-01',title:'Final index title',superseded_intents:c.transactions,reason:'Example revised title decision'}});assert.equal((await executeFiles(r2,{state:f.state})).exit,0);assert.equal((await f.query()).data.model.rows[0].title,'Final index title');assert.equal(csvRead(Buffer.from(gitRun(f.repo,['show',':TASKS.csv'])+'\n'))[0].title,'Final index title');assert.equal(gitRun(f.repo,['ls-files','--unmerged']),'');assert.equal(gitRun(f.repo,['rev-parse','HEAD']),head);assert.deepEqual(await fs.readFile(f.repo+'/.git/MERGE_HEAD'),merge);}finally{await f.cleanup();}
});

test('an identical nested resolution retry finishes post-publication absorption cleanup',{skip:!supported},async()=>{
  const f=await nestedResolutionFixture();try{let published=false,interrupted=false;const first=await executeFiles(f.r2,{state:f.state,fault:async n=>{if(n==='PUBLICATION')published=true;if(published&&!interrupted&&n.startsWith('after-write:')&&n.endsWith('/terminal.json')){interrupted=true;throw new Error('interrupt after first terminal');}}});assert(interrupted);assert.equal(first.exit,0);assert.equal((await executeFiles(f.r2,{state:f.state})).operation_receipt,first.operation_receipt);assert.equal((await f.query()).stale,false);}finally{await f.cleanup();}
});

async function protectedGitResolutionFixture() {
  const f=await mergeFixture();
  const r1=await executeFiles(f.resolveRequest,{state:f.state,fault:async n=>{if(n==='VERIFIED')throw new Error('interrupt after resolved index');}});assert.equal(r1.code,'IO_PENDING');
  const pause=f.make('work pause',{work:'ATLAS-01',resolver:'local-owner',next:'review',protection_refs:[],proof:'local-owner'});
  assert.equal((await executeFiles(pause,{state:f.state,fault:async n=>{if(n==='PROTECTION_DURABLE')throw new Error('defer protection');}})).code,'PROTECTION_PENDING');
  let decided=false;await executeFiles(f.resolveRequest,{state:f.state,fault:async n=>{if(n==='DECIDED'){decided=true;throw new Error('interrupt protective successor');}}});assert(decided);
  const rows=csvRead(await fs.readFile(f.repo+'/TASKS.csv'));rows[0].title='Third protected title';await fs.writeFile(f.repo+'/TASKS.csv',csvBytes(rows));let conflict;try{await executeFiles(f.resolveRequest,{state:f.state});}catch(e){conflict=e;}assert.equal(conflict?.code,'RECOVERY_CONFLICT');
  const q=await executeFiles({protocol:'project-files/1',query:'operation inspect',repo:f.repo,projection:'private-local',snapshot_token:null,input:{subject:conflict.caseId}},{state:f.state}),c=q.data.case;assert(c.allowed_decisions.includes('adopt-authorized-structured-change'));
  return {...f,r2:f.make('project resolve',{case_id:c.id,expected_case_digest:c.case_digest,decision:'adopt-authorized-structured-change',authorization_refs:['local-owner'],semantic_input:{work_id:'ATLAS-01',title:'Final protected title',superseded_intents:c.transactions,reason:'Example protected title decision'}})};
}
test('a protective successor preserves its ancestor Git adaptation during a second title decision',{skip:!supported},async()=>{
  const f=await protectedGitResolutionFixture();try{const head=gitRun(f.repo,['rev-parse','HEAD']),merge=await fs.readFile(f.repo+'/.git/MERGE_HEAD');assert.equal((await executeFiles(f.r2,{state:f.state})).exit,0);const q=await f.query();assert.equal(q.stale,false);assert.equal(q.data.model.rows[0].title,'Final protected title');assert.equal(q.data.model.rows[0].control,'paused');assert.equal(q.protection_seq,1);assert.equal(gitRun(f.repo,['show',':TASKS.csv']),String(await fs.readFile(f.repo+'/TASKS.csv')).trimEnd());assert.equal(gitRun(f.repo,['rev-parse','HEAD']),head);assert.deepEqual(await fs.readFile(f.repo+'/.git/MERGE_HEAD'),merge);}finally{await f.cleanup();}
});
// Each interruption window rebuilds an isolated merge; allow for hosted runner overhead.
test('every protected Git second resolution checkpoint SIGKILL preserves source and index coupling',{skip:!supported,timeout:600000},async t=>{
  const baseline=await protectedGitResolutionFixture(),trace=child(baseline.r2,baseline.state);assert.equal(trace.last.result.exit,0);await baseline.cleanup();
  for(let i=1;i<=trace.checkpoints.length;i++){const f=await protectedGitResolutionFixture();let failed=false;try{const head=gitRun(f.repo,['rev-parse','HEAD']),merge=await fs.readFile(f.repo+'/.git/MERGE_HEAD');assert.equal(child(f.r2,f.state,i).signal,'SIGKILL');assert.equal((await executeFiles(f.r2,{state:f.state})).exit,0,`protected Git recovery ${i}`);const q=await f.query();assert.equal(q.stale,false);assert.equal(q.data.model.rows[0].title,'Final protected title');assert.equal(q.data.model.rows[0].control,'paused');assert.equal(q.generation,3);assert.equal(q.protection_seq,1);assert.equal(gitRun(f.repo,['show',':TASKS.csv']),String(await fs.readFile(f.repo+'/TASKS.csv')).trimEnd());assert.equal(gitRun(f.repo,['rev-parse','HEAD']),head);assert.deepEqual(await fs.readFile(f.repo+'/.git/MERGE_HEAD'),merge);}catch(e){failed=true;t.diagnostic(JSON.stringify({failed_window:i,boundary:trace.checkpoints[i-1].name,code:e.code}));if(process.env.PM_TEST_EVIDENCE_DIR){await fs.mkdir(process.env.PM_TEST_EVIDENCE_DIR,{recursive:true});await fs.cp(f.base,path.join(process.env.PM_TEST_EVIDENCE_DIR,`protected-git-recovery-${i}`),{recursive:true});}throw e;}finally{if(!failed||process.env.PM_TEST_EVIDENCE_DIR)await f.cleanup();}}
  t.diagnostic(JSON.stringify({kind:'protected-git-resolution',kill_windows:trace.checkpoints.length,boundaries:trace.checkpoints.map(x=>x.name)}));
});
