// Synthetic observations/notification failures; real product file transactions and process kills.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync,spawn} from 'node:child_process';
import {attemptWorkerNotice} from '../core/worker-notice.mjs';
import {createHash} from 'node:crypto';
import {createWorkerFixture,legacyCSV,legacyLog} from './worker-fixture.mjs';
import {executeFiles} from '../core/file-store.mjs';
import {digest} from '../core/engine.mjs';
import {rawHash} from '../core/file-model.mjs';
import {installedWorkerCoverage,reconcileWorkerClaim,scanWorkerClaims} from '../core/worker-client.mjs';
const storeURL=new URL('../core/file-store.mjs',import.meta.url).href;
const driver=`const {executeFiles}=await import(${JSON.stringify(storeURL)});const [r,state,clock,point]=JSON.parse(process.argv[1]);try{await executeFiles(r,{state,workerClock:()=>clock,fault:async name=>{if(name===point)process.kill(process.pid,'SIGKILL');}});process.exitCode=9;}catch{process.exitCode=8;}`;
async function codeDigest(){const dir=fileURLToPath(new URL('../core/',import.meta.url));const h=createHash('sha256');for(const name of (await fs.readdir(dir)).sort()){if(name.endsWith('.mjs')){h.update(name);h.update(await fs.readFile(path.join(dir,name)));}}return `sha256:${h.digest('hex')}`;}
export async function createCase(spec,id,mode){
 if(id==='S14'&&mode==='native'){const {createNativeCandidateCase}=await import('./worker-candidate-case.mjs');return createNativeCandidateCase(codeDigest);}
 const f=await createWorkerFixture({mode:mode==='legacy-manual'?'native':mode});
 if(process.env.PM_WORKER_TEST_INDEX)await fs.appendFile(process.env.PM_WORKER_TEST_INDEX,JSON.stringify({id,mode,base:f.base})+'\n');
 const config={version:1,control_epoch:'epoch-a',control_repo:f.repo,state:f.state,project_id:'ATLAS',mode:f.mode,legacy_root:mode==='legacy-compat'?f.evidence:null};
 let lastEnvelope,oldRequest,claim,firstClaim=null,coverage,scan,other,pausedRequest,beforeDue,priorObservation,legacyActionCount=0;
 const trace=[],facts={},failures=[];
 const inventoryFile=path.join(f.base,'notice-inventory.jsonl'),installRoot=path.join(f.base,'uninstalled-skill');
 const installBefore=await fs.stat(installRoot).then(s=>s.ino).catch(()=>null);
 async function inventory(){return (await fs.readFile(inventoryFile,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));}
 async function notice(role,state='accepted',commitment=null){
  const result=await attemptWorkerNotice(config,{work:'ATLAS-001',dispatch:'dispatch-a',role,commitment,deliver:async message=>{
   const program=`const fs=require('node:fs');const [file,message,state]=JSON.parse(process.argv[1]);const fd=fs.openSync(file,'a',384);fs.writeSync(fd,JSON.stringify({...message,state,destination:'private-local-test-peer'})+'\\n');fs.fsyncSync(fd);fs.closeSync(fd);process.stdout.write(JSON.stringify({state}));`;
   const child=spawnSync(process.execPath,['-e',program,JSON.stringify([inventoryFile,message,state])],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:f.state}});
   if(child.status!==0)throw Error('Isolated notice peer failed');return JSON.parse(child.stdout);
  }},{clock:()=>f.getClock()});await f.refresh();return result;
 }
 async function stopActualScanner(){
  const moduleURL=new URL('../core/worker-client.mjs',import.meta.url).href;
  const program=`const {scanWorkerClaims}=await import(${JSON.stringify(moduleURL)});const [config,clock]=JSON.parse(process.argv[1]);for(let n=0;n<16;n++){const result=await scanWorkerClaims([{config,work:'ATLAS-001',dispatch:'dispatch-a'}],{clock:()=>clock});process.stdout.write(JSON.stringify(result)+'\\n');await new Promise(r=>setTimeout(r,1000));}`;
  const child=spawn(process.execPath,['--input-type=module','-e',program,JSON.stringify([config,f.getClock()])],{env:{PATH:process.env.PATH,HOME:f.state},stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('Scanner produced no sample'));},15000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});child.once('error',reject);child.once('exit',()=>{clearTimeout(timer);reject(Error('Scanner exited before sample'));});});
  const exit= new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));child.kill('SIGTERM');const stopped=await exit;
  trace.push({name:'actual-scanner-stopped',...stopped});if(stopped.signal!=='SIGTERM')throw Error('Scanner did not terminate');scan=null;await f.refresh();
 }

 async function record(name,fn){try{const output=await fn();trace.push({name,exit:output?.out?.exit??output?.exit??0});return output;}catch(e){trace.push({name,code:e.code??'NATIVE_ERROR'});throw e;}}
 async function rejected(key,fn){let error;try{await fn();}catch(e){error=e;}if(!error)throw Error('Expected actual product rejection');facts[key]=true;failures.push({key,code:error.code??'NATIVE_ERROR'});}
 async function model(){return (await f.query()).data.model;}
 async function d(){return f.dispatch();}
 async function latest(){return (await d()).events.at(-1);}
 async function dispose(kind='action',commitment='commitment-1',killPoint=null,legacyStatus='受阻'){
  const dd=await d(),e=dd.events.filter(x=>x.envelope.commitments.includes(commitment)).at(-1),name=`disposition-${trace.length}.txt`,hash=await f.write(name,'Example manager action evidence');
  const input={work:'ATLAS-001',dispatch:'dispatch-a',event:e.digest,commitment,kind,action:'Actual reviewed local action',responsible:'local-owner',evidence:[{path:name,digest:hash}],commands:[]};
  if(mode==='legacy-compat'){
   const before=await fs.readFile(path.join(f.evidence,'TASKS.csv')),after=Buffer.from(legacyCSV(legacyStatus));
   const key=`legacy-action-${trace.length}`,log=legacyLog(dd,key,{after:legacyStatus,decision:kind==='paused'?'pause':legacyStatus==='已完成'?'pass':'block',event:e});
   await f.action('worker legacy prepare',{event:e.digest,commitment,before:rawHash(before),after:rawHash(after),log_path:'ATLAS-001.md',log_digest:rawHash(Buffer.from(log))},{idempotency_key:key});
   await f.write('TASKS.csv',after);await f.write('ATLAS-001.md',log);legacyActionCount++;
   await f.action('worker reconcile',{});
  }else{
   const {out}=await f.run('work pause',{work:'ATLAS-001',resolver:'local-owner',next:'Review recorded partial result',protection_refs:[],proof:'local-owner'});input.commands=[out.operation_receipt];
  }
  if(killPoint)return kill('worker handoff dispose',input,killPoint);
  return f.action('worker handoff dispose',input);
 }
 async function kill(command,input,point,extra={}){
  const request=f.make(command,input,extra),child=spawnSync(process.execPath,['--input-type=module','-e',driver,JSON.stringify([request,f.state,f.getClock(),point])],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:f.state}});
  trace.push({name:'actual-SIGKILL',point,signal:child.signal,exit:child.status});if(child.signal!=='SIGKILL')throw Error('Fault point was not reached');
  await f.run('project reconcile',{});await f.refresh();return request;
 }
 async function legacyCrash(writeCentral){
  const e=await latest(),before=await fs.readFile(path.join(f.evidence,'TASKS.csv')),after=Buffer.from(legacyCSV('受阻')),key='legacy-crash-a';
  const log=legacyLog(await d(),key);
  const input={work:'ATLAS-001',dispatch:'dispatch-a',event:e.digest,commitment:'commitment-1',before:rawHash(before),after:rawHash(after),log_path:'ATLAS-001.md',log_digest:rawHash(Buffer.from(log))};
  if(!writeCentral){await kill('worker legacy prepare',input,'PUBLICATION',{idempotency_key:key});return;}
  await f.run('worker legacy prepare',input,{idempotency_key:key});
  const program=`const fs=require('node:fs');const [root,csv,log]=JSON.parse(process.argv[1]);for(const [name,bytes] of [['TASKS.csv',csv],['ATLAS-001.md',log]]){fs.writeFileSync(root+'/'+name,bytes,{mode:384});const fd=fs.openSync(root+'/'+name,'r');fs.fsyncSync(fd);fs.closeSync(fd);}process.kill(process.pid,'SIGKILL');`;
  const child=spawnSync(process.execPath,['-e',program,JSON.stringify([f.evidence,after.toString(),log])],{env:{PATH:process.env.PATH,HOME:f.state}});
  trace.push({name:'actual-legacy-manager-SIGKILL',signal:child.signal});if(child.signal!=='SIGKILL')throw Error('Expected actual kill');legacyActionCount++;
 }
 async function observe(state,{turn='turn-a',event=f.getClock(),collected=f.getClock()}={}){
  const observation={route:'route-a',turn,state,source:'synthetic-fixture',source_event_at:new Date(event).toISOString(),collected_at:new Date(collected).toISOString(),ttl_seconds:60,assurance:'owner-attested'};
  await f.action('worker runtime observe',{observation});priorObservation??=observation;return observation;
 }
 const steps={
  'environment.legacyNoInstall':async()=>{coverage=await installedWorkerCoverage(path.join(f.base,'uninstalled-skill'));},
  'environment.legacyCompat':async()=>{if(mode!=='legacy-compat')throw Error('Wrong mode');},
  'dispatch.open':async()=>{await f.register();beforeDue=(await d()).commitments[0].absolute_due;},
  'dispatch.openNoOwner':async()=>{await f.register({owner:null});beforeDue=(await d()).commitments[0].absolute_due;},
  'dispatch.openTwoCommitments':async()=>{await f.register({commitments:2});beforeDue=(await d()).commitments[0].absolute_due;},
  'handoff.publish.stage':async()=>{lastEnvelope=await f.publish();},
  'handoff.publish.final':async()=>{if(facts['fault.ioExpected'])await rejected('fault.ioRejected',()=>f.publish({kind:'final'}));else lastEnvelope=await f.publish({kind:'final'});},
  'handoff.publishForCommitmentA':async()=>{lastEnvelope=await f.publish({commitment:'commitment-1'});},
  'handoff.publishSupersedingCandidate':async()=>{lastEnvelope=await f.publish();},
  'handoff.replaySameBytes':async()=>{await f.action('worker handoff publish',{envelope:lastEnvelope});},
  'handoff.replayChangedBytes':async()=>rejected('faults.conflictRejected',()=>f.action('worker handoff publish',{envelope:{...lastEnvelope,next:'Changed intention'}})),
  'handoff.publishSymlink':async()=>{const file=path.join(f.spool,'event-2.json');await fs.symlink(path.join(f.spool,'event-1.json'),file);await rejected('faults.pathRejected',()=>f.action('worker handoff publish',{envelope:{...lastEnvelope,sequence:2,event_id:'event:dispatch-a:2',supersedes:digest(lastEnvelope)}}));await fs.unlink(file);},
  'handoff.publishWrongEpoch':async()=>rejected('faults.epochRejected',()=>f.action('worker handoff publish',{envelope:{...lastEnvelope,epoch:'stale-epoch',sequence:2,event_id:'event:dispatch-a:2',supersedes:digest(lastEnvelope)}})),
  'notify.approvalReject':async()=>{await notice('manager','rejected');},
  'notify.acceptThenDrop':async()=>{await notice('manager','accepted');},
  'worker.normalExit':async()=>{
   const file=path.join(f.base,'worker-config.json');await fs.writeFile(file,JSON.stringify(config),{mode:0o600});
   const child=spawnSync(process.execPath,[fileURLToPath(new URL('../pm-worker.mjs',import.meta.url)),'finish','--config',file],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:f.state},input:JSON.stringify({command:'worker handoff publish',idempotency_key:'finish-boundary',input:{work:'ATLAS-001',dispatch:'dispatch-a',envelope:lastEnvelope}})});
   const output=JSON.parse(child.stdout);trace.push({name:'actual-finish-process-exit',exit:child.status,handoff_published:output.handoff_published===true});facts['worker.claimedHandoff']=output.handoff_published===true;
   if(lastEnvelope&&child.status!==0)throw Error('Normal finish did not preserve publication');await f.refresh();
  },
  'worker.killBeforePublish':async()=>{const envelope={version:1,event_id:'event:dispatch-a:1',dispatch:'dispatch-a',epoch:'epoch-a',sequence:1,kind:'final',phase:'executing',commitments:['commitment-1'],candidate:digest('candidate-a'),evidence:[],next:'Inspect unfinished result',can_continue:false,published_at:new Date(f.getClock()).toISOString(),supersedes:null};await kill('worker handoff publish',{work:'ATLAS-001',dispatch:'dispatch-a',envelope},'worker-before-spool-publish');},
  'disk.failFlush':async()=>{facts['fault.ioExpected']=true;f.setFault(async name=>{if(name==='before-flush')throw Error('Synthetic disk failure');});},
  'handoff.killAfterRenameBeforeIndex':async()=>{const e={version:1,event_id:'event:dispatch-a:1',dispatch:'dispatch-a',epoch:'epoch-a',sequence:1,kind:'stage',phase:'executing',commitments:['commitment-1'],candidate:digest('candidate-a'),evidence:[],next:'Review result',can_continue:false,published_at:new Date(f.getClock()).toISOString(),supersedes:null};await kill('worker handoff publish',{work:'ATLAS-001',dispatch:'dispatch-a',envelope:e},'worker-spool-published');lastEnvelope=e;},
  'manager.restart':async()=>{f.setFault(async()=>{});await f.run('project reconcile',{});await f.refresh();},
  'manager.pull':async()=>{f.setFault(async()=>{});await f.action('worker reconcile',{});const dd=await d();for(const e of dd.events)await f.action('worker handoff consume',{event:e.digest});},
  'manager.reconcile':async()=>{if(facts['fault.orphanAck'])await rejected('recovery.required',()=>f.action('worker reconcile',{}));else await f.action('worker reconcile',{});},
  'manager.disposeAckOnly':async()=>{const e=await latest();await rejected('disposition.rejected',()=>f.action('worker handoff dispose',{event:e.digest,commitment:'commitment-1',kind:'action',action:'ACK',responsible:'local-owner',evidence:[],commands:[]}));},
  'manager.scheduleCheckpoint':async()=>{await f.schedule(f.now+3000);},
  'manager.scheduleCommitmentA':async()=>{await f.schedule(f.now+3000);},
  'manager.extendWithEvidence':async()=>{await f.schedule(f.now+5000+trace.length);},
  'manager.extendBeyondBudget':async()=>rejected('faults.extensionRejected',()=>f.schedule(f.now+9000)),
  'manager.disposeValidAction':async()=>dispose(),
  'manager.resolveCommitmentAByValidAction':async()=>dispose('action','commitment-1'),
  'manager.disposeValidPass':async()=>{if(mode==='legacy-compat')await dispose('action','commitment-1',null,'已完成');else throw Object.assign(Error('True business acceptance fixture is required'),{code:'CAPABILITY_UNAVAILABLE'});},
  'manager.disposeOldScope':async()=>{await f.run('work amend',{work:'ATLAS-001',scope:{goal:'New scope',allowed_writes:['src'],exclusions:[],criteria:['new-criterion']},impact:[]});await rejected('disposition.oldScopeRejected',()=>f.schedule());},
  'worker.forgeManagerDispose':async()=>{const request=f.make('worker handoff consume',{work:'ATLAS-001',dispatch:'dispatch-a',event:(await latest()).digest},{actor_proof:'forged-worker'});await rejected('faults.forgedManagerRejected',()=>executeFiles(request,f.options()));},
  'worker.forgeCommitmentReplacement':async()=>rejected('faults.commitmentReplacementRejected',()=>f.register()),
  'worker.forgeScopeDecision':async()=>{await rejected('faults.scopeDecisionRejected',()=>f.run('acceptance decide',{candidate:'fabricated-candidate',role:'local-manager',decision:'pass',reports:[],criteria:[]}));},
  'manager.transferEpochAuthorized':async()=>{if(mode==='native'){const {fixture}=await import('./host-profile-fixture.mjs');const host=await fixture();try{await host.call('project init',{root:host.repo,identity:'manager-a',policy:'policy-a'});await host.call('manager handover',{proof:'host-origin',route:{host:'codex',instance:'synthetic',opaque_id:'manager-route-b',kind:'independent-task-thread',provenance:'host-origin'},previous_epoch:'epoch-a'},'owner-route');}finally{host.bridge.close();}}const proofName='old-epoch-evidence.txt',proofDigest=await f.write(proofName,'Retained old coordinator intent');oldRequest=f.make('worker handoff dispose',{work:'ATLAS-001',dispatch:'dispatch-a',event:(await latest()).digest,commitment:'commitment-1',kind:'scheduled',action:'Retained checkpoint',responsible:'local-owner',evidence:[{path:proofName,digest:proofDigest}],commands:[],next_due:new Date(f.getClock()+1000).toISOString()});await f.action('worker manager transfer',{manager:'local-owner',epoch:'epoch-b',route:'route-b',turn:'turn-b',reason:'Explicit local coordinator epoch rollover'});f.setEpoch('epoch-b');config.control_epoch='epoch-b';await f.action('worker handoff consume',{event:(await latest()).digest});},
  'manager.oldEpochDispose':async()=>{oldRequest.expected_revision=(await f.query()).source_revision;await rejected('faults.oldEpochDisposeRejected',async()=>{try{return await executeFiles(oldRequest,f.options());}catch(error){if(error.code!=='ROLE_STALE')throw Error('Epoch rejection was masked');throw error;}});},
  'runtime.remove':async()=>{await f.action('worker runtime clear',{reason:'source-unavailable'});},
  'runtime.activeFresh':async()=>{await observe('active');},
  'runtime.idleFresh':async()=>{await observe('idle');},
  'runtime.currentTurnEnded':async()=>{await observe('ended');},
  'runtime.replayOlderTurnActive':async()=>rejected('runtime.oldTurnIgnored',()=>observe('active',{turn:'old-turn'})),
  'runtime.rereadOldActiveWithNewCollectedAt':async()=>{await observe('active',{event:f.now,collected:f.getClock()});},
  'clock.consumeDue':async()=>f.setClock(f.now+1001),
  'clock.firstCheckDue':async()=>f.setClock(f.now+1001),
  'clock.nextDue':async()=>f.setClock(Date.parse((await d()).commitments[0].next_due)+1),
  'clock.absoluteDue':async()=>f.setClock(f.now+10001),
  'clock.ownerDue':async()=>f.setClock(f.now+20001),
  'clock.runtimeTTL':async()=>f.setClock(f.now+60001),
  'clock.backward':async()=>f.setClock(f.now-1),
  'scan.tick':async()=>{f.setFault(async()=>{});if(other){scan=await scanWorkerClaims([{config,work:'ATLAS-001',dispatch:'dispatch-a'},{config:{...config,control_repo:other.repo,state:other.state,legacy_root:mode==='legacy-compat'?other.evidence:null},work:'ATLAS-001',dispatch:'dispatch-a'}],{clock:()=>f.getClock()});await f.refresh();}else await f.action('worker reconcile',{});for(const c of (await d()).commitments)if(c.owner&&c.owner_state==='issued')await notice('owner','accepted',c.id);},
  'scan.restart':async()=>{await f.run('project reconcile',{});await f.refresh();},
  'scan.stop':stopActualScanner,
  'claim.inspect':async()=>{if(coverage){claim={running:false,runtime:'unknown',reconcile_failed:false};}else if(facts['claim.failReconcile']){claim=await reconcileWorkerClaim(config,'ATLAS-001','dispatch-a',{clock:()=>f.getClock()});}else claim=(await f.query('worker claim inspect',{dispatch:'dispatch-a'})).data.worker_view.claim;firstClaim??=claim;},
  'fault.reconcileFailsWithOldRunningHint':async()=>{await fs.writeFile(path.join(f.spool,'event-1.json'),'broken',{mode:0o600});facts['claim.failReconcile']=true;},
  'fault.corruptCommitmentAEnvelope':async()=>{await fs.writeFile(path.join(f.spool,'event-1.json'),'broken');},
  'fault.loseAckAndCursor':async()=>{const publication=JSON.parse(await fs.readFile(path.join(f.repo,'.pm-local/publication.json'),'utf8')).value;await fs.unlink(path.join(f.repo,'.pm-local/snapshots',publication.snapshot+'.json'));await fs.unlink(path.join(f.repo,'.pm-local/publication.json'));facts['fault.actualProjectionLost']=true;},
  'fault.injectOrphanAck':async()=>{await fs.writeFile(path.join(f.spool,'orphan-ack.json'),JSON.stringify({disposed:true,event:(await latest()).digest}),{mode:0o600});facts['fault.orphanAck']=true;},
  'fault.addCorruptOtherProject':async()=>{other=await createWorkerFixture({mode:f.mode,now:f.now});await other.register();await fs.writeFile(path.join(other.spool,'invalid-file'),'broken',{mode:0o600});},
  'owner.pauseExplicit':async()=>{await f.publish();await f.consume();await dispose('paused');pausedRequest=true;},
  'manager.nativeDisposeKillAfterCommit':async()=>dispose('action','commitment-1','PUBLICATION'),
  'manager.legacyKillBeforeCentralWrite':async()=>legacyCrash(false),
  'manager.legacyKillAfterCentralWrite':async()=>legacyCrash(true),
 };
 return {
  async step(name){if(!steps[name])throw Error('Unknown step');await record(name,steps[name]);},
  async inspect(){
   f.setFault(async()=>{});const m=await model(),dd=m.project.worker_control?.dispatches[0],c=dd?.commitments[0],events=dd?.events??[];let liveClaim=claim;
   if(!liveClaim&&dd)liveClaim=(await f.query('worker claim inspect',{dispatch:'dispatch-a'})).data.worker_view.claim;
   const calls=await inventory(),managerCalls=calls.filter(x=>x.role==='manager'),ownerCalls=calls.filter(x=>x.role==='owner');
   const opAudits=[...m.project.project_audit,...m.tasks.flatMap(t=>t.audit)];const actions=mode==='legacy-compat'?legacyActionCount:opAudits.filter(a=>a.type==='protection-merged').length;
   const actual={metadata:{mode,candidate_digest:await codeDigest(),implementation_entry:fileURLToPath(new URL('../core/file-store.mjs',import.meta.url)),evidence_dir:f.base},
    'handoff.published':events.length>0,'handoff.seen':events.some(e=>e.seen_at),'handoff.disposed':events.some(e=>e.dispositions.some(x=>x.kind==='action')),'handoff.count':events.length,'handoff.consumeCount':events.filter(e=>e.seen_at).length,
    'business.closed':m.rows.some(r=>r.phase==='closed'),'business.open':m.rows.some(r=>r.phase!=='closed'),'business.reviewSatisfied':m.tasks.some(t=>t.obligations.some(o=>o.template==='review-response'&&o.lifecycle==='satisfied')),'business.currentCandidateAccepted':m.rows.some(r=>r.phase==='accepted'),'business.actionCount':actions,
    'responsibility.open':!!c&&c.status==='open','responsibility.due':!!c&&c.status==='open'&&(dd.clock_uncertain||Date.parse(c.next_due)<=f.getClock()),'responsibility.ownerSet':!!dd?.manager,'responsibility.absoluteDueUnchanged':c?.absolute_due===beforeDue,'responsibility.budgetInheritedAcrossManagerEpoch':c?.absolute_due===beforeDue&&c?.extension_count===2,'responsibility.extensionBudgetRemaining':c?c.extension_limit-c.extension_count:null,
    'transport.attempts':managerCalls.length,'transport.state':managerCalls.at(-1)?.state??'not-attempted','externalDestinationCount':new Set(calls.filter(x=>x.destination!=='private-local-test-peer').map(x=>x.destination)).size,'userRelayRequested':calls.some(x=>x.role==='user-relay'),
    'owner.escalationCount':ownerCalls.length,'owner.state':c?.owner_state,'dispatch.count':m.project.worker_control?.dispatches.length??0,
    'runtime.state':liveClaim?.runtime??'unknown','claim.firstRunning':firstClaim?.running??false,'claim.latestRunning':liveClaim?.running??false,'claim.hasSampleTime':!!liveClaim?.sampled_at,'claim.reconcileFailureVisible':!!liveClaim?.reconcile_failed,'runtime.sourceEventTimeUnchanged':dd?.observation?.source_event_at===priorObservation?.source_event_at,'runtime.collectedTimeAdvanced':!!dd?.observation&&Date.parse(dd.observation.collected_at)>Date.parse(priorObservation.collected_at),
    'disposition.accepted':events.some(e=>e.dispositions.length),'disposition.receiptRebuilt':events.some(e=>e.dispositions.some(x=>x.kind==='action'))||dd?.pending.some(x=>x.state==='finalized'),'disposition.needsReconciliation':dd?.pending.some(x=>x.state==='pending')??false,'recovery.required':false,
    'coverage.mode':coverage?.mode??mode,'coverage.automaticOutbox':false,'coverage.automaticWake':false,'installation.changed':(await fs.stat(installRoot).then(s=>s.ino).catch(()=>null))!==installBefore,'scan.claimedHealthy':!!scan?.healthy,'scan.currentProjectChecked':!!dd,'scan.otherProjectError':!!scan?.results[1]?.reconcile_failed,'clock.uncertain':dd?.clock_uncertain??false,
    'pause.preserved':!!dd?.paused,'resume.count':m.tasks.flatMap(t=>t.execution?.effects??[]).filter(e=>e.kind==='host.resume').length,'commitments.count':dd?.commitments.length??0,'commitments.bDue':!!dd?.commitments[1]&&Date.parse(dd.commitments[1].next_due)<=f.getClock(),'commitments.bSatisfied':dd?.commitments[1]?.status==='resolved','commitments.aDisposed':c?.status==='resolved','commitments.distinctRoots':!!dd&&new Set(dd.commitments.map(c=>c.id+':'+c.lineage)).size===dd.commitments.length,'scan.corruptAIsolated':!!dd?.scan_errors.length&&!!dd.commitments[1],
    'history.oldDecisionPreserved':events.some(e=>e.dispositions.length),'worker.claimedHandoff':facts['worker.claimedHandoff']??false,...facts};await fs.writeFile(path.join(f.base,'acceptance-oracle.json'),JSON.stringify(actual,null,2)+'\n');return actual;
  },
  async close(){await fs.writeFile(path.join(f.base,'acceptance-trace.json'),JSON.stringify({id,mode,trace,failures},null,2)+'\n');if(process.env.PM_WORKER_TEST_CLEANUP==='1')await f.cleanup();}
 };
}
