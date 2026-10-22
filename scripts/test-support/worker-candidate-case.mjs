// One real C2 file/validator/acceptance journey driven by a synthetic protocol peer.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture,setup} from './host-profile-fixture.mjs';
import {digest} from '../core/engine.mjs';
import {rawHash} from '../core/file-model.mjs';
export async function createNativeCandidateCase(codeDigest){
 const f=await fixture(),spool=path.join(f.base,'worker-spool'),evidence=path.join(f.base,'worker-evidence');
 await fs.mkdir(spool,{mode:0o700});await fs.mkdir(evidence,{mode:0o700});let manifest,route,counter=0;
 const trace=[];
 const q=()=>f.snapshot(),dispatch=async()=> (await q()).data.model.project.worker_control.dispatches[0];
 async function publish(){const d=await dispatch(),envelope={version:1,event_id:`event:dispatch-a:${d.events.length+1}`,dispatch:'dispatch-a',epoch:'epoch-a',sequence:d.events.length+1,kind:'final',phase:'executing',commitments:['commitment-1'],candidate:digest(manifest),evidence:[],next:'Review exact candidate',can_continue:false,published_at:new Date().toISOString(),supersedes:d.events.at(-1)?.digest??null};return f.call('worker handoff publish',{work:'ATLAS-01',dispatch:'dispatch-a',envelope});}
 const steps={
  'dispatch.open':async()=>{
   const {selection,receipt}=await setup(f);await f.call('lane bind',{dispatch:'dispatch-a',selection,receipt:receipt.id});let s=await q();
   await f.call('dispatch start',{dispatch:'dispatch-a',scope:1,validation:s.data.model.tasks[0].execution.validations.at(-1).id});s=await q();await f.runEffect(s.data.model.tasks[0].execution.effects.find(e=>e.kind==='host.start').id);
   route=(await q()).data.model.tasks[0].execution.lanes[0].route.opaque_id;
   await fs.mkdir(path.join(f.repo,'out'));const bytes=Buffer.from('Example candidate\n');await fs.writeFile(path.join(f.repo,'out/result.txt'),bytes);manifest=[{path:'out/result.txt',digest:rawHash(bytes),size:bytes.length}];
   const now=Date.now();await f.call('worker dispatch register',{work:'ATLAS-01',dispatch:'dispatch-a',epoch:'epoch-a',manager:'manager-a',worker:route,route,turn:'controller-a',spool,evidence_root:evidence,mode:'native',commitments:[{id:'commitment-1',lineage:'lineage-1',revision:1,first_due:new Date(now+60000).toISOString(),next_due:new Date(now+60000).toISOString(),absolute_due:new Date(now+120000).toISOString(),extension_count:0,extension_limit:2,owner:'owner-a',owner_due:new Date(now+180000).toISOString(),owner_state:'waiting',escalations:0,status:'open',resolved_by:null,last_evidence:null}]});
  },
  'handoff.publish.final':publish,
  'manager.pull':async()=>{await f.call('worker reconcile',{work:'ATLAS-01',dispatch:'dispatch-a'});for(const e of (await dispatch()).events)await f.call('worker handoff consume',{work:'ATLAS-01',dispatch:'dispatch-a',event:e.digest});},
  'manager.disposeValidPass':async()=>{
   const candidate={id:'candidate-a',work_id:'ATLAS-01',manifest,digest:digest(manifest),source_revision:(await q()).source_revision,limitations:['Synthetic protocol peer']};
   await f.call('delivery submit',{work:'ATLAS-01',candidate,limitations:['Synthetic peer']},route);
   const report={id:'report-a',candidate_digest:candidate.digest,scope_revision:1,reviewer:'reviewer-a',history_inherited:false,access_mode:'prompt-only',actual_inputs:['candidate-a'],coverage:[{criterion:'criterion-a',layer:'synthetic',result:'pass',evidence:['evidence-a']}],open_issues:[]};
   await f.call('review submit',{work:'ATLAS-01',report,limitations:['Synthetic peer']},'reviewer-route');
   const decided=await f.call('acceptance decide',{candidate:'candidate-a',role:'local-manager',decision:'pass',reports:['report-a'],criteria:['criterion-a']});
   const bytes=Buffer.from('Exact candidate and report reviewed\n');await fs.writeFile(path.join(evidence,'decision.txt'),bytes,{mode:0o600});
   await f.call('worker handoff dispose',{work:'ATLAS-01',dispatch:'dispatch-a',event:(await dispatch()).events.at(-1).digest,commitment:'commitment-1',kind:'action',action:'Accept exact candidate after independent report',responsible:'manager-a',evidence:[{path:'decision.txt',digest:rawHash(bytes)}],commands:[decided.output.operation_receipt]});
  },
  'handoff.publishSupersedingCandidate':async()=>{const bytes=Buffer.from('New candidate requiring review\n');await fs.writeFile(path.join(f.repo,'out/result.txt'),bytes);manifest=[{path:'out/result.txt',digest:rawHash(bytes),size:bytes.length}];await publish();},
 };
 return {async step(name){if(!steps[name])throw Error('Unknown native candidate step');await steps[name]();trace.push({name,sequence:++counter});},async inspect(){const m=(await q()).data.model,d=m.project.worker_control.dispatches[0],t=m.tasks[0],c=t.candidates.find(c=>c.id===m.rows[0].candidate_id);return {metadata:{mode:'native',candidate_digest:await codeDigest(),implementation_entry:fileURLToPath(new URL('../core/host-store.mjs',import.meta.url)),evidence_dir:f.base},'responsibility.open':d.commitments[0].status==='open','business.currentCandidateAccepted':m.rows[0].phase==='accepted'&&c?.digest===d.events.at(-1).envelope.candidate,'history.oldDecisionPreserved':t.decisions.some(d=>d.result==='pass')};},async close(){f.bridge.close();await fs.writeFile(path.join(f.base,'worker-candidate-trace.json'),JSON.stringify(trace,null,2)+'\n');}};
}
