// Worker delivery control lives in the project's existing transactional source.
// Envelopes are self-reports, never grants, host identities or business decisions.
import {digest,validateDomain} from './engine.mjs';
import {fail,validate,DEFINITIONS} from './contracts.mjs';
import {evaluateObligations} from './obligation-monitor.mjs';
import {newId,receiptFor} from './file-model.mjs';
const time=value=>{const n=Date.parse(value);if(!Number.isFinite(n))fail('INVALID_INPUT');return n;};
export const isWorker=name=>name?.startsWith('worker ');
export function workerDispatch(model,id){const d=model.project.worker_control?.dispatches.find(d=>d.id===id);if(!d)fail('INVALID_INPUT');return d;}
function manager(d,authority){if(authority.actor!==d.manager||authority.role!=='manager')fail('AUTH_DENIED');}
export function workerClaim(model,id,{now=Date.now(),failed=false}={}){
 const d=workerDispatch(model,id),o=d.observation;
 const fresh=!failed&&!d.scan_errors.length&&!d.clock_uncertain&&o&&o.route===d.route&&o.turn===d.turn&&time(o.source_event_at)<=now&&now-time(o.source_event_at)<o.ttl_seconds*1000;
 return {sampled_at:new Date(now).toISOString(),business_phase:model.rows.find(r=>r.id===d.work)?.phase??'unknown',runtime: fresh?o.state:'unknown',running:!!fresh&&o.state==='active',source:fresh?o.source:null,source_event_at:o?.source_event_at??null,collected_at:o?.collected_at??null,route:d.route,turn:d.turn,assurance:o?.assurance??'unknown',unread:d.events.filter(e=>!e.seen_at).length,coverage:d.mode,automatic_wake:false,responsibilities:d.commitments.map(c=>({id:c.id,status:c.status,due:c.status==='open'&&!d.paused&&(time(c.next_due)<=Math.max(now,time(d.clock_at))),next_due:c.next_due,absolute_due:c.absolute_due,extension_count:c.extension_count,owner_state:c.owner_state,escalations:c.escalations})),reconcile_failed:failed||!!d.scan_errors.length,attention:workerAttention(model,d,now)};
}
// Reuse the existing obligation evaluator and Attention contract as a read-only
// projection. Dispatch budgets remain in one transactional source; no second alert ledger.
export function workerAttention(model,d,now){
 if(d.clock_uncertain||time(d.registered_at)>now)return [];
 const copy=structuredClone(model),byObligation=new Map();
 for(const c of d.commitments){
  const id=`worker-${digest({project:model.project.project_id,dispatch:d.id,commitment:c.id,lineage:c.lineage}).slice(7)}`;
  byObligation.set(id,c);
  copy.project.project_obligations.push({id,template:'condition-followup',template_version:'1',derivation_key:id,work_or_handoff_ref:d.work,scope_revision:d.scope_revision,responsible:d.manager,activation_predicate:'registered-worker-responsibility',satisfaction_predicate:'relevant-manager-disposition',activated_at:d.registered_at,due_at:c.next_due,policy_ref:model.project.policy.id,obligation_revision:1,lifecycle:d.paused||c.status==='paused'?'waiting':c.status==='resolved'?'satisfied':'active',basis_refs:[d.id],next:'manager-local-pull'});
 }
 const view=evaluateObligations(copy,{snapshot:'worker-projection',generation:0,now}),records=[];
 for(const root of view.roots){
  const c=byObligation.get(root.obligation_id);if(!c)continue;
  const event=d.events.filter(e=>e.envelope.commitments.includes(c.id)).at(-1),key=root.alert_key;
  const manager={id:`attention-${digest({key,role:'manager'}).slice(7)}`,alert_key:key,obligation_id:root.obligation_id,obligation_revision:1,manager_epoch:d.epoch,target:d.manager,created_at:d.registered_at,payload_digest:digest(key),state:d.notifications.length?'unknown':'ready',role:'manager',tier:c.escalations?c.owner_state==='exhausted'?2:1:0,deliver_due:c.first_due,consume_due:c.first_due,response_due:c.absolute_due,escalation_state:c.owner_state,...(event?.seen_at?{consumed_at:event.seen_at,consumed_turn:'owner-attested-read'}:{})};records.push(manager);
  if(c.escalations&&c.owner)records.push({...manager,id:`attention-${digest({key,role:'owner'}).slice(7)}`,target:c.owner,role:'owner',deliver_due:c.absolute_due,consume_due:c.owner_due,consumed_at:undefined,consumed_turn:undefined});
 }
 for(const record of records){for(const key of Object.keys(record))if(record[key]===undefined)delete record[key];validate(record,DEFINITIONS.Attention);}return records;
}
export function reduceWorker(original,request,operationId,{now=Date.now(),identity=null,io={}}={}){
 const model=structuredClone(original),p=model.project,{input:i,command}=request;
 const authority=identity?{actor:identity.actor,role:identity.role}:{actor:'local-owner',role:'manager'};
 p.worker_control??={version:1,dispatches:[]};
 const row=model.rows.find(r=>r.id===i.work);if(!row)fail('INVALID_INPUT');
 let d=p.worker_control.dispatches.find(d=>d.id===i.dispatch);
 if(command==='worker dispatch register'){
  if(authority.role!=='manager'||authority.actor!==i.manager||i.manager!==p.manager_binding.principal)fail('AUTH_DENIED');
  if(identity){const t=model.tasks.find(t=>t.work_id===i.work),lane=t?.execution?.lanes.find(l=>l.route?.opaque_id===i.route);if(i.epoch!==identity.manager_epoch||i.worker!==row.write_owner||!lane)fail('AUTH_DENIED');}
  if(d)fail('IDEMPOTENCY_CONFLICT');if(!i.commitments.length||new Set(i.commitments.map(c=>c.id)).size!==i.commitments.length)fail('INVARIANT_VIOLATION');
  for(const c of i.commitments){if(c.status!=='open'||c.extension_count||c.escalations||c.resolved_by||c.last_evidence||c.owner_state!=='waiting'||time(c.first_due)<now||time(c.next_due)!==time(c.first_due)||time(c.absolute_due)<time(c.first_due)||time(c.owner_due)<time(c.absolute_due))fail('INVALID_INPUT');}
  if(p.worker_control.dispatches.some(x=>x.work===i.work||x.spool===i.spool))fail('INVARIANT_VIOLATION');
  d={id:i.dispatch,work:i.work,scope_revision:row.scope_revision,epoch:i.epoch,manager:i.manager,worker:i.worker,route:i.route,turn:i.turn,spool:i.spool,evidence_root:i.evidence_root,commitments:structuredClone(i.commitments),events:[],notifications:[],observation:null,registered_at:new Date(now).toISOString(),clock_at:new Date(now).toISOString(),clock_uncertain:false,scan_errors:[],paused:false,mode:i.mode,pending:[]};p.worker_control.dispatches.push(d);
 }else{
  if(!d||d.work!==i.work)fail('INVALID_INPUT');
  if(i.control_epoch!==d.epoch)fail('ROLE_STALE');
  if(identity&&identity.manager_epoch!==d.epoch)fail('ROLE_STALE');
  if(command==='worker handoff publish'){
   if(authority.role==='executor'?authority.actor!==d.worker:authority.role!=='manager'||authority.actor!==d.manager)fail('AUTH_DENIED');
   ingest(d,i.envelope,io.envelope_digest);
  }else{
   if(command==='worker reconcile'&&authority.role==='monitor'){}else manager(d,authority);
   if(now<time(d.clock_at))d.clock_uncertain=true;else d.clock_at=new Date(now).toISOString();
   if(command==='worker handoff consume'){
    const e=d.events.find(e=>e.digest===i.event);if(!e)fail('INVALID_INPUT');if(e.seen_epoch!==d.epoch){e.seen_at=new Date(now).toISOString();e.seen_epoch=d.epoch;e.prior_receipts=[...p.project_audit,...model.tasks.flatMap(t=>t.audit)].flatMap(a=>a.operation_receipt?[a.operation_receipt.operation_id]:[]);}
   }else if(command==='worker handoff dispose'){
    const e=d.events.find(e=>e.digest===i.event),c=d.commitments.find(c=>c.id===i.commitment);
    if(!e||!c||!e.envelope.commitments.includes(c.id)||!e.seen_at||e.seen_epoch!==d.epoch||d.events.filter(x=>x.envelope.commitments.includes(c.id)).at(-1)!==e)fail('FENCE_INVALID');
    if(d.scope_revision!==row.scope_revision||d.clock_uncertain||!i.action.trim()||!i.evidence.length||i.responsible!==d.manager)fail('VALIDATION_REQUIRED');
    if(c.status!=='open')fail('INVARIANT_VIOLATION');
    if(i.kind==='scheduled'){
     if(!i.next_due||time(i.next_due)<=now||time(i.next_due)>time(c.absolute_due)||now>=time(c.absolute_due)||c.extension_count>=c.extension_limit)fail('INVARIANT_VIOLATION');
     // The first schedule is not an extension. Subsequent schedules consume the fixed budget.
     const prior=d.events.some(x=>x.dispositions.some(x=>x.commitment===c.id&&x.kind==='scheduled'));
     if(prior){if(c.last_evidence===digest(i.evidence))fail('VALIDATION_REQUIRED');c.extension_count++;}c.last_evidence=digest(i.evidence);
     c.next_due=i.next_due;
    }else{
     const audits=[...p.project_audit,...model.tasks.flatMap(t=>t.audit)];
     const known=i.commands.length&&i.commands.every(id=>audits.some(a=>a.operation_receipt?.operation_id===id&&a.subject===d.work&&a.actor===d.manager&&!e.prior_receipts.includes(id)&&['acceptance-decide','flow-accept','work-close','work-block','work-wait','protection-merged'].includes(a.type)));
     if(known&&i.commands.some(id=>audits.some(a=>a.operation_receipt?.operation_id===id&&['acceptance-decide','flow-accept'].includes(a.type)))){const t=model.tasks.find(t=>t.work_id===row.id),candidate=t.candidates.find(x=>x.id===row.candidate_id);if(candidate?.digest!==e.envelope.candidate)fail('FENCE_INVALID');}
     const legacy=io.legacy_finalized?.some(x=>x.event===i.event&&x.commitment===c.id);
     if(!known&&!legacy)fail('VALIDATION_REQUIRED');
     const legacyReceipt=io.legacy_finalized?.find(x=>x.event===i.event&&x.commitment===c.id);if(legacyReceipt&&((i.kind==='paused')!==(legacyReceipt.decision==='pause')))fail('VALIDATION_REQUIRED');
     if(i.kind==='paused'){d.paused=true;c.status='paused';}else{c.status='resolved';c.resolved_by=operationId;}
    }
    e.dispositions.push({commitment:c.id,operation:operationId,kind:i.kind,at:new Date(now).toISOString()});
   }else if(['worker notification claim','worker notification record'].includes(command)){
    const c=i.commitment?d.commitments.find(c=>c.id===i.commitment):null;
    const key=i.role==='manager'?`manager:${d.id}`:`owner:${digest({dispatch:d.id,commitment:c?.id,lineage:c?.lineage}).slice(7)}`;
    if(i.key!==key||(i.role==='manager'&&i.commitment!==null)||(i.role==='owner'&&(!c?.owner||c.owner_state!=='issued'||c.escalations!==1)))fail('AUTH_DENIED');
    const existing=d.notifications.find(n=>n.key===key);
    if(command==='worker notification claim'){
     if(existing)fail('IDEMPOTENCY_CONFLICT');
     d.notifications.push({key,role:i.role,commitment:i.commitment,state:'claimed',at:new Date(now).toISOString()});
    }else{
     if(!existing||existing.state!=='claimed'||!['accepted','rejected','unknown'].includes(i.state))fail('AUTH_DENIED');existing.state=i.state;
    }
   }else if(command==='worker runtime clear'){
    d.observation=null;
   }else if(command==='worker runtime observe'){
    const o=i.observation;
    if(o.assurance==='host-origin'&&identity?.role!=='host-bridge')fail('AUTH_DENIED');
    if(o.route!==d.route||o.turn!==d.turn||time(o.source_event_at)>now||time(o.collected_at)>now)fail('FENCE_INVALID');
    if(d.observation&&time(o.source_event_at)<time(d.observation.source_event_at))fail('FENCE_INVALID');
    if(d.observation&&time(o.source_event_at)===time(d.observation.source_event_at)&&o.state!==d.observation.state)fail('FENCE_INVALID');
    d.observation=structuredClone(o);
   }else if(command==='worker manager transfer'){
    if(identity)fail('CAPABILITY_UNAVAILABLE'); // Full host manager handover is a separate protocol.
    if(i.manager!=='local-owner'||i.epoch===d.epoch||!i.reason.trim())fail('AUTH_DENIED');
    d.epoch=i.epoch;d.manager=i.manager;d.route=i.route;d.turn=i.turn;d.observation=null;
    for(const e of d.events)e.seen_epoch=null;
   }else if(command==='worker legacy prepare'){
    if(d.mode!=='legacy-compat'||!d.events.some(e=>e.digest===i.event&&e.seen_at)||!d.commitments.some(c=>c.id===i.commitment)||!io.legacy_before_valid)fail('VALIDATION_REQUIRED');
    if(d.pending.some(x=>x.event===i.event&&x.commitment===i.commitment))fail('IDEMPOTENCY_CONFLICT');
    d.pending.push({id:request.idempotency_key,event:i.event,commitment:i.commitment,before:i.before,after:i.after,log_path:i.log_path,log_digest:i.log_digest,...io.legacy_context,operation:null,state:'pending'});
   }else if(command==='worker reconcile'){
    d.scan_errors=io.scan_errors??[];
    for(const e of io.envelopes??[])ingest(d,e.envelope,e.digest);
    for(const item of io.legacy_finalized??[]){const pending=d.pending.find(x=>x.id===item.id);if(pending){pending.state='finalized';pending.operation=operationId;}}
    if(!d.paused)for(const c of d.commitments){
     if(c.status!=='open')continue;
     if((!d.clock_uncertain&&now>=time(c.absolute_due))&&c.owner_state==='waiting'){
      if(c.owner){c.owner_state='issued';c.escalations=1;}else c.owner_state='unavailable';
     }
     if(['issued','unavailable'].includes(c.owner_state)&&(!d.clock_uncertain&&now>=time(c.owner_due)))c.owner_state='exhausted';
    }
   }else fail('CAPABILITY_UNAVAILABLE');
  }
 }
 if(command==='worker reconcile'&&digest(p.worker_control)===digest(original.project.worker_control))return original;
 p.project_audit.push({event_id:newId(),at:new Date(now).toISOString(),actor:authority.actor,type:command.replaceAll(' ','-'),subject:row.id,payload:[],evidence:[],operation_receipt:receiptFor(request,operationId)});
 validateDomain(model);return model;
}
function ingest(d,envelope,hash){
 validate(envelope,DEFINITIONS.WorkerEnvelope);
 const known=d.events.find(e=>e.envelope.event_id===envelope.event_id);if(known){if(known.digest!==hash||hash!==digest(envelope))fail('IDEMPOTENCY_CONFLICT');return;}
 if(!hash||hash!==digest(envelope)||envelope.dispatch!==d.id||envelope.epoch!==d.epoch||envelope.event_id!==`event:${d.id}:${envelope.sequence}`||!envelope.commitments.length||envelope.commitments.some(id=>!d.commitments.some(c=>c.id===id)))fail('FENCE_INVALID');
 const prior=d.events.find(e=>e.envelope.event_id===envelope.event_id);if(prior){if(prior.digest!==hash)fail('IDEMPOTENCY_CONFLICT');return;}
 if(envelope.sequence!==d.events.length+1||(d.events.length?envelope.supersedes!==d.events.at(-1).digest:envelope.supersedes!==null))fail('FENCE_INVALID');
 d.events.push({digest:hash,envelope:structuredClone(envelope),seen_at:null,seen_epoch:null,prior_receipts:null,dispositions:[]});
 for(const id of envelope.commitments){const c=d.commitments.find(c=>c.id===id);if(c.status==='resolved'){c.status='open';c.resolved_by=null;}c.revision++;}
}
