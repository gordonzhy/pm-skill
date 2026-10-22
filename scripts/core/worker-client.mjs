// Explicit local coordination client. It never installs, sends messages or edits a legacy ledger.
import fs from 'node:fs/promises';
import path from 'node:path';
import {executeFiles,emptyRevision} from './file-store.mjs';
import {digest,parseJSON} from './engine.mjs';
import {privateRoot,sourceRoot} from './worker-io.mjs';
import {regular} from './file-platform.mjs';
import {fail} from './contracts.mjs';
import {newId} from './file-model.mjs';
export async function readWorkerConfig(filename){
 if(!path.isAbsolute(filename))fail('PATH_UNSAFE');const st=await regular(filename);
 if(st.uid!==process.getuid()||(st.mode&0o077)||st.size>16384)fail('AUTH_DENIED');await privateRoot(path.dirname(filename));
 const c=parseJSON(await fs.readFile(filename,'utf8'));
 if(Object.keys(c).sort().join(',')!=='control_epoch,control_repo,legacy_root,mode,project_id,state,version'||c.version!==1||typeof c.control_epoch!=='string'||!['native','legacy-compat'].includes(c.mode)||typeof c.project_id!=='string')fail('INVALID_INPUT');
 for(const name of ['control_repo','state'])await privateRoot(c[name]);
 if(c.mode==='legacy-compat'){await sourceRoot(c.legacy_root);for(const name of ['control_repo','state'])if(c[name]===c.legacy_root||c[name].startsWith(c.legacy_root+'/'))fail('PATH_UNSAFE');}
 else if(c.legacy_root!==null)fail('INVALID_INPUT');return c;
}
export async function installedWorkerCoverage(root){
 if(typeof root!=='string'||!path.isAbsolute(root))fail('PATH_UNSAFE');let installed=true;
 for(const name of ['scripts/pm-worker.mjs','scripts/core/worker-domain.mjs'])try{await regular(path.join(root,name));}catch{installed=false;}
 return {mode:installed?'installed-unverified':'legacy-manual',automatic_outbox:false,automatic_wake:false,installation_changed:false};
}
export async function workerRequest(config,request,{clock=()=>Date.now(),fault=async()=>{}}={}){
 const options={state:config.state,workerClock:clock,fault};
 if(request.command==='project init'){
  const r={protocol:'project-files/1',repo:config.control_repo,project_id:config.project_id,actor_proof:'local-owner',idempotency_key:request.idempotency_key,expected_revision:emptyRevision(),command:'project init',input:{root:config.control_repo,identity:'local-owner',policy:'worker-policy'}};
  return executeFiles(r,options);
 }
 const snapshot=await executeFiles({protocol:'project-files/1',query:'snapshot',repo:config.control_repo,projection:'private-local',snapshot_token:null,input:{}},options);
 if(snapshot.stale&&request.command!=='project reconcile')fail('RECOVERY_REQUIRED');
 if(request.command?.startsWith('worker ')&&request.command!=='worker dispatch register')request={...request,input:{...request.input,control_epoch:request.input.control_epoch??config.control_epoch}};
 const full={...request,protocol:'project-files/1',repo:config.control_repo,...(request.command?{project_id:config.project_id,actor_proof:'local-owner',expected_revision:request.expected_revision??snapshot.source_revision}:{projection:'private-local',snapshot_token:null})};
 if(request.command==='worker dispatch register'){
  if(request.input.mode!==config.mode||(config.mode==='legacy-compat'&&(request.input.evidence_root!==config.legacy_root||request.input.spool===config.legacy_root||request.input.spool.startsWith(config.legacy_root+'/'))))fail('AUTH_DENIED');
 }
 return executeFiles(full,options);
}
export async function reconcileWorkerClaim(config,work,dispatch,options={}){
 try{
  await workerRequest(config,{command:'project reconcile',idempotency_key:`recover-${newId()}`,input:{}},options);
  await workerRequest(config,{command:'worker reconcile',idempotency_key:`pull-${newId()}`,input:{work,dispatch}},options);
  return (await workerRequest(config,{query:'worker claim inspect',input:{dispatch}},options)).data.worker_view.claim;
 }catch{
  return {sampled_at:new Date((options.clock??Date.now)()).toISOString(),runtime:'unknown',running:false,reconcile_failed:true,coverage:config.mode,automatic_wake:false};
 }
}

const scanning=new Map();
export async function scanWorkerClaims(entries,{maxProjects=16,budgetMs=30000,...options}={}){
 if(!Number.isInteger(maxProjects)||maxProjects<1||maxProjects>64||entries.length>maxProjects||!Number.isInteger(budgetMs)||budgetMs<1||budgetMs>60000)fail('INVALID_INPUT');
 const deadline=performance.now()+budgetMs,results=[];let checked=0;
 for(const entry of entries){
  const key=entry.config.control_repo+':'+entry.dispatch,remaining=deadline-performance.now();
  if(remaining<=0||scanning.has(key)){results.push({runtime:'unknown',running:false,reconcile_failed:true,automatic_wake:false,reason:'scan-budget-or-inflight'});continue;}
  const work=reconcileWorkerClaim(entry.config,entry.work,entry.dispatch,options).catch(()=>({runtime:'unknown',running:false,reconcile_failed:true,automatic_wake:false}));
  scanning.set(key,work);work.finally(()=>{if(scanning.get(key)===work)scanning.delete(key);});let timer;
  try{const value=await Promise.race([work,new Promise(resolve=>{timer=setTimeout(()=>resolve({runtime:'unknown',running:false,reconcile_failed:true,automatic_wake:false,reason:'scan-budget'}),remaining);})]);results.push(value);if(!value.reason)checked++;}finally{clearTimeout(timer);}
 }
 return {checked,results,coverage_complete:checked===entries.length,healthy:checked===entries.length&&results.every(r=>!r.reconcile_failed),automatic_wake:false};
}
