import fs from 'node:fs/promises';
import path from 'node:path';
import {executeFiles,emptyRevision} from '../core/file-store.mjs';
import {LEGACY_COLUMNS} from '../core/worker-legacy.mjs';
import {rawHash} from '../core/file-model.mjs';
import {digest} from '../core/engine.mjs';
let counter=0;
export async function createWorkerFixture({mode='native',fault=async()=>{},now=Date.now()}={}){
 const base=await fs.mkdtemp('/private/tmp/worker-control-test-');await fs.chmod(base,0o700);
 for(const name of ['repo','state','spool','evidence'])await fs.mkdir(path.join(base,name),{mode:0o700});
 const repo=path.join(base,'repo'),state=path.join(base,'state'),spool=path.join(base,'spool'),evidence=path.join(base,'evidence');let revision=emptyRevision(),clock=now,currentFault=fault,controlEpoch='epoch-a';
 const options=()=>({state,fault:name=>currentFault(name),workerClock:()=>clock});
 const make=(command,input,extra={})=>({protocol:'project-files/1',command,repo,project_id:'ATLAS',actor_proof:'local-owner',idempotency_key:`worker-${++counter}`,expected_revision:revision,input:command.startsWith('worker ')&&command!=='worker dispatch register'?{...input,control_epoch:input.control_epoch??controlEpoch}:input,...extra});
 const run=async(command,input,extra={})=>{const request=make(command,input,extra),out=await executeFiles(request,options());if(out.source_revision)revision=out.source_revision;return {request,out};};
 const query=async(name='snapshot',input={})=>executeFiles({protocol:'project-files/1',query:name,repo,projection:'private-local',snapshot_token:null,input},options());
 await run('project init',{root:repo,identity:'local-owner',policy:'policy-a'});
 await run('work create',{work:'ATLAS-001',scope:{goal:'Example result',allowed_writes:['src'],exclusions:[],criteria:['criterion-a']},label:'Example',deps:[],impact:[]});
 const write=async(name,data)=>{await fs.writeFile(path.join(evidence,name),data,{mode:0o600});return rawHash(Buffer.from(data));};
 const register=async({owner='owner-a',commitments=1}={})=>run('worker dispatch register',{work:'ATLAS-001',dispatch:'dispatch-a',epoch:'epoch-a',manager:'local-owner',worker:'local-owner',route:'route-a',turn:'turn-a',spool,evidence_root:evidence,mode,commitments:Array.from({length:commitments},(_,n)=>({id:`commitment-${n+1}`,lineage:`lineage-${n+1}`,revision:1,first_due:new Date(now+1000).toISOString(),next_due:new Date(now+1000).toISOString(),absolute_due:new Date(now+10000).toISOString(),extension_count:0,extension_limit:2,owner,owner_due:new Date(now+20000).toISOString(),owner_state:'waiting',escalations:0,status:'open',resolved_by:null,last_evidence:null}))});
 const dispatch=async()=> (await query('worker handoff inspect',{dispatch:'dispatch-a'})).data.worker_view.dispatch;
 const action=(command,input,extra)=>run(command,{work:'ATLAS-001',dispatch:'dispatch-a',...input},extra);
 const publish=async({kind='stage',commitment='commitment-1'}={})=>{
  const d=await dispatch();const e={version:1,event_id:`event:dispatch-a:${d.events.length+1}`,dispatch:'dispatch-a',epoch:d.epoch,sequence:d.events.length+1,kind,phase:'executing',commitments:[commitment],candidate:digest('candidate-'+d.events.length),evidence:[],next:'Review local result',can_continue:false,published_at:new Date(clock).toISOString(),supersedes:d.events.at(-1)?.digest??null};
  await action('worker handoff publish',{envelope:e});return e;
 };
 const consume=async()=>action('worker handoff consume',{event:(await dispatch()).events.at(-1).digest});
 const schedule=async(next=clock+2000,commitment='commitment-1')=>{const name=`checkpoint-${++counter}.txt`,hash=await write(name,`Example progress ${counter}`);return action('worker handoff dispose',{event:(await dispatch()).events.filter(e=>e.envelope.commitments.includes(commitment)).at(-1).digest,commitment,kind:'scheduled',action:'Check exact local report',responsible:'local-owner',evidence:[{path:name,digest:hash}],commands:[],next_due:new Date(next).toISOString()});};
 if(mode==='legacy-compat'){await write('TASKS.csv',legacyCSV());await write('ATLAS-001.md','## 任务日志\n');}
 return {base,repo,state,spool,evidence,mode,make,run,action,query,register,dispatch,publish,consume,schedule,write,now,options,setEpoch:value=>{controlEpoch=value;},setFault:fn=>{currentFault=fn;},setClock:n=>{clock=n;},getClock:()=>clock,refresh:async()=>{const q=await query();revision=q.source_revision;return q;},cleanup:()=>fs.rm(base,{recursive:true,force:true})};
}

export function legacyCSV(status='进行中'){const row={id:'ATLAS-001',status,priority:'P1',boundary:'Example',title:'Example task',dependencies:'[]',executor:'Example worker',created_at:'2030-01-01T00:00:00Z',modified_at:'2030-01-01T00:00:00Z',detail_path:'ATLAS-001.md',dispatch_id:'dispatch-a',execution_thread_id:'route-a',execution_turn_id:'turn-a',manager_thread_id:'manager-route-a',manager_turn_id:'manager-turn-a',recovery_turn_id:'',recovery_state:'',recovery_state_at:''};return LEGACY_COLUMNS.join(',')+'\n'+LEGACY_COLUMNS.map(k=>`"${row[k].replaceAll('"','""')}"`).join(',')+'\n';}
export function legacyLog(d,key,{before='进行中',after='受阻',decision='block',event=d.events.at(-1)}={}){const entry={id:key,at:'2030-01-01T00:00:00Z',actor:d.manager,type:{block:'blocked',pause:'paused',wait:'decision_requested',pass:'accepted',cancel:'cancelled'}[decision],title:'Manager reviewed exact local deliverable',detail:'Reviewed the assigned candidate and recorded the concrete next disposition.',state_from:before,state_to:after,result:decision==='pass'?'passed':'partial',evidence:[{label:'Exact worker decision',ref:'worker-disposition:'+key,note:JSON.stringify({kind:'worker-manager-disposition',task:d.work,dispatch:d.id,event:event.digest,candidate:event.envelope.candidate,scope_revision:d.scope_revision,operation_id:key,decision})}]};return '## 任务日志\n\n```yaml\n'+JSON.stringify({version:1,events:[entry]},null,2)+'\n```\n';}
