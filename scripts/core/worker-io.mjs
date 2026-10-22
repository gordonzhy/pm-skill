import {legacyBefore,legacyDisposition} from './worker-legacy.mjs';
// Private dispatch spool I/O. No discovery, outbound transport or business execution.
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {digest,parseJSON} from './engine.mjs';
import {rawHash,newId} from './file-model.mjs';
import {regular,directory} from './file-platform.mjs';
import {fail,validate,DEFINITIONS} from './contracts.mjs';
import {workerDispatch} from './worker-domain.mjs';
export async function privateRoot(root){
 if(typeof root!=='string'||!path.isAbsolute(root)||await fs.realpath(root)!==root)fail('PATH_UNSAFE');
 const st=await directory(root);if(st.uid!==process.getuid()||(st.mode&0o077))fail('AUTH_DENIED');return root;
}
export async function sourceRoot(root){if(typeof root!=='string'||!path.isAbsolute(root)||await fs.realpath(root)!==root)fail('PATH_UNSAFE');const st=await directory(root);if(st.uid!==process.getuid()||(st.mode&0o022))fail('AUTH_DENIED');return root;}
async function bytes(filename,limit=65536,privateOnly=true){
 const st=await regular(filename);if(st.uid!==process.getuid()||(st.mode&(privateOnly?0o077:0o022))||st.size>limit)fail('AUTH_DENIED');
 const file=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const current=await file.stat();if(current.ino!==st.ino||current.dev!==st.dev||current.nlink!==1)fail('FENCE_INVALID');return await file.readFile();}finally{await file.close();}
}
async function relative(root,name){
 if(typeof name!=='string'||path.isAbsolute(name)||name.split('/').some(x=>!x||x==='.'||x==='..'))fail('PATH_UNSAFE');
 const target=path.join(root,name);if(await fs.realpath(path.dirname(target))!==path.dirname(target))fail('PATH_UNSAFE');return target;
}
async function verifyEnvelope(d,e){
 validate(e,DEFINITIONS.WorkerEnvelope);
 if(Buffer.byteLength(JSON.stringify(e))>65536)fail('INVALID_INPUT');
 await sourceRoot(d.evidence_root);
 for(const item of e.evidence){const data=await bytes(await relative(d.evidence_root,item.path),1048576,false);if(rawHash(data)!==item.digest)fail('FENCE_INVALID');}
 return {envelope:e,digest:digest(e)};
}
async function discover(d,{tolerant=false}={}){
 await privateRoot(d.spool);const allNames=await fs.readdir(d.spool);if(allNames.length>256)fail('RECOVERY_REQUIRED');const names=allNames.filter(n=>!n.startsWith('.pending-'));
 if(names.length>128||names.some(n=>!/^event-[1-9][0-9]*\.json$/.test(n)))fail('RECOVERY_REQUIRED');
 const found=[];let total=0;const errors=[];
 for(const name of names.sort((a,b)=>Number(a.slice(6,-5))-Number(b.slice(6,-5)))){
  try{const data=await bytes(path.join(d.spool,name));total+=data.length;if(total>4*1024*1024)fail('RECOVERY_REQUIRED');
  const e=parseJSON(data.toString('utf8'),{maxBytes:65536});if(name!==`event-${e.sequence}.json`)fail('FENCE_INVALID');
  found.push(await verifyEnvelope(d,e));}catch(error){if(!tolerant)throw error;errors.push(`invalid-${name.replace('.json','')}`);}
 }
 for(const e of d.events)if(!found.some(x=>x.digest===e.digest)){if(!tolerant)fail('RECOVERY_REQUIRED');errors.push(`missing-${e.envelope.sequence}`);}
 return {found,errors:[...new Set(errors)]};
}
export async function workerIO(store,model,request){
 const i=request.input;if(request.command==='worker dispatch register'){
  for(const root of [i.spool,i.evidence_root]){await (root===i.spool?privateRoot:sourceRoot)(root);if(root===store.root||root.startsWith(`${store.root}/`))fail('PATH_UNSAFE');}
  if((await fs.readdir(i.spool)).length)fail('RECOVERY_REQUIRED');return {};
 }
 const d=workerDispatch(model,i.dispatch);await privateRoot(d.spool);
 if(request.command==='worker handoff publish'){
  // Validate the complete source chain and business binding before any output.
  const {found}=await discover(d),verified=await verifyEnvelope(d,i.envelope);
  const known=found.find(x=>x.envelope.event_id===i.envelope.event_id);
  if(known){if(known.digest!==verified.digest)fail('IDEMPOTENCY_CONFLICT');return {envelope_digest:verified.digest};}
  if(found.reduce((n,x)=>n+Buffer.byteLength(JSON.stringify(x.envelope))+1,0)+Buffer.byteLength(JSON.stringify(i.envelope))+1>4*1024*1024)fail('RECOVERY_REQUIRED');
  if(found.length>=128||i.envelope.sequence!==found.length+1||i.envelope.dispatch!==d.id||i.envelope.epoch!==d.epoch||i.envelope.event_id!==`event:${d.id}:${i.envelope.sequence}`||i.envelope.supersedes!==(found.at(-1)?.digest??null)||i.envelope.commitments.some(id=>!d.commitments.some(c=>c.id===id)))fail('FENCE_INVALID');
  const temporary=path.join(d.spool,`.pending-${newId()}`),target=path.join(d.spool,`event-${i.envelope.sequence}.json`);
  const fd=await fs.open(temporary,'wx',0o600);try{await fd.writeFile(JSON.stringify(i.envelope)+'\n');}finally{await fd.close();}
  await store.flush(temporary);await store.checkpoint('worker-before-spool-publish');await store.lock.renameExclusive(temporary,target);await store.lock.flush(d.spool);await store.checkpoint('worker-spool-published');
  return {envelope_digest:verified.digest};
 }
 const result={};
 if(['worker handoff consume','worker handoff dispose'].includes(request.command)){const {found}=await discover(d,{tolerant:true});if(!found.some(e=>e.digest===i.event))fail('RECOVERY_REQUIRED');}
 if(request.command==='worker handoff dispose'){for(const e of i.evidence){if(rawHash(await bytes(await relative(d.evidence_root,e.path),1048576,false))!==e.digest)fail('FENCE_INVALID');}}
 if(request.command==='worker reconcile'){const {found,errors}=await discover(d,{tolerant:true});result.envelopes=found;result.scan_errors=errors;}
 if(d.mode==='legacy-compat'){
  const central=await bytes(await relative(d.evidence_root,'TASKS.csv'),1048576,false),current=rawHash(central);
  if(request.command==='worker legacy prepare'){result.legacy_before_valid=current===i.before&&i.before!==i.after;if(result.legacy_before_valid)result.legacy_context=legacyBefore(central,d,i);}
  const finalized=[];
  for(const item of d.pending){
   if(current!==item.after){if(item.state==='finalized')continue;if(current!==item.before)fail('RECOVERY_REQUIRED');continue;}
   const log=await bytes(await relative(d.evidence_root,item.log_path),1048576,false);
   if(rawHash(log)!==item.log_digest)fail('RECOVERY_REQUIRED');
   finalized.push(legacyDisposition(central,log.toString('utf8'),d,item));
  }
  result.legacy_finalized=finalized;
 }
 return result;
}
